import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeOnce } from './atomic.js';
import { ensureQueue } from './migrate.js';
import { defaultRulesPaths, eventLogPolicy, queueRoot } from './paths.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const safe = value => String(value).replace(/[^A-Za-z0-9_.-]/g, '_');

// events.jsonl is bounded. Once it reaches the cap it rolls to events.jsonl.1, older
// rolls shift down, and the roll past FM_HOOK_EVENT_LOG_KEEP is dropped. Rotation is
// guarded by an exclusive lock so overlapping harness processes cannot interleave
// renames; a process that loses the lock simply appends to the freshly rolled log.
async function rotateEventLog(path, { maxBytes, keep }) {
  if (!maxBytes || keep < 1) return null;
  const lockPath = `${path}.rotate.lock`;
  const lock = await claimLock(lockPath);
  if (!lock) return null;
  try {
    const size = await stat(path).then(entry => entry.size, error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    if (size < maxBytes) return null;
    for (let index = keep; index >= 1; index--) {
      const target = `${path}.${index}`;
      const source = index === 1 ? path : `${path}.${index - 1}`;
      if (index === keep) await rm(target, { force: true });
      await rename(source, target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return path;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function appendEventLog(record, root = queueRoot()) {
  await ensureQueue(root);
  const path = join(root, 'events.jsonl');
  await rotateEventLog(path, eventLogPolicy());
  const file = await open(path, 'a', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ ...record, loggedAt: new Date().toISOString() })}\n`);
    await file.sync();
  } finally { await file.close(); }
  return path;
}

export async function persistEvent(event, root = queueRoot()) {
  await ensureQueue(root);
  const events = join(root, 'events');
  await mkdir(events, { recursive: true });
  const path = join(events, `${event.correlationId}-${safe(event.operation)}.json`);
  // Same call ID may be observed repeatedly. Preserve the original durable record.
  await writeOnce(path, event);
  // The JSONL log appends every observation, including repeats, so a tail proves the hook is live.
  await appendEventLog({ type: 'event', ...event }, root);
  return path;
}

export async function enqueueAction(event, rule, action, root = queueRoot()) {
  await ensureQueue(root);
  const jobs = join(root, 'jobs');
  await mkdir(jobs, { recursive: true });
  const id = hash(`${event.correlationId}\0${rule.id}`);
  const payload = { id, correlationId: event.correlationId, ruleId: rule.id, operation: event.operation,
    createdAt: new Date().toISOString(), action };
  const path = join(jobs, `${id}.json`);
  const enqueued = await writeOnce(path, payload);
  return { enqueued, path };
}

export async function evaluateAndEnqueue(event, rules, root) {
  const results = [];
  for (const rule of rules) {
    const matchesOperation = rule.operation === '*' || rule.operation === event.operation;
    if (!matchesOperation || !Array.isArray(rule.outcomes) || !rule.outcomes.includes(event.outcome)) continue;
    results.push(await enqueueAction(event, rule, rule.action, root));
  }
  return results;
}

// Rule sets are read from an ordered list of absolute candidates. FM_HOOK_RULES is an
// explicit override; otherwise a project-local fm-hooks.rules.json is used when it
// exists, falling back to the state-resident default. A malformed file still throws
// rather than silently falling through to a different rule set.
export async function loadRules(paths = defaultRulesPaths()) {
  const candidates = Array.isArray(paths) ? paths : [paths];
  for (const path of candidates) {
    let contents;
    try { contents = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed.rules)) throw new Error('rules file must contain a rules array');
    return parsed.rules;
  }
  return [];
}

// Standalone worker: queued actions execute outside the latency-sensitive hook.
// A crash around an external side effect is at-least-once; actions must be idempotent.
async function claimLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(path, 'wx', 0o600);
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number((await readFile(path, 'utf8')).trim()); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return null; }
        catch (killError) { if (killError.code !== 'ESRCH') return null; }
      }
      // Reclaim a dead worker's lock via atomic rename so concurrent workers cannot
      // remove a newly acquired lock at the original path.
      const stale = `${path}.${randomUUID()}.stale`;
      try { await rename(path, stale); await rm(stale, { force: true }); }
      catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; }
    }
  }
  return null;
}

export async function runQueue({ root = queueRoot(), execute }) {
  await ensureQueue(root);
  const jobs = join(root, 'jobs'), done = join(root, 'done'), failed = join(root, 'failed');
  await Promise.all([mkdir(jobs, { recursive: true }), mkdir(done, { recursive: true }), mkdir(failed, { recursive: true })]);
  const names = (await readdir(jobs)).filter(name => name.endsWith('.json')).sort();
  const results = [];
  for (const name of names) {
    const source = join(jobs, name), target = join(done, name);
    const claimed = await claimLock(`${source}.lock`);
    if (!claimed) continue;
    try {
      const job = JSON.parse(await readFile(source, 'utf8'));
      try {
        await execute(job);
        await rename(source, target);
        results.push({ id: job.id, outcome: 'done' });
      } catch (error) {
        await rename(source, join(failed, name));
        const errorFile = await open(join(failed, `${name}.error`), 'w', 0o600);
        try { await errorFile.writeFile(String(error)); } finally { await errorFile.close(); }
        results.push({ id: job.id, outcome: 'failed', error: String(error) });
      }
    } finally {
      await claimed.close();
      await rm(`${source}.lock`, { force: true });
    }
  }
  return results;
}
