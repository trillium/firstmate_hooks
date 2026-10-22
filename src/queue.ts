import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeOnce } from './atomic.ts';
import { ensureQueue } from './migrate.ts';
import { defaultRulesPaths, eventLogPolicy, queueRoot, retryPolicy } from './paths.ts';

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

// A record that is not a recognized Firstmate call (a wake-drain, a turn-end, ...) is kept
// write-once under its own directory, never in events/, so a consumer that reads every
// events/*.json for normalized calls sees exactly the files it always did. The log line is
// appended on every delivery, like an event's, and carries the record's own `type`.
export async function persistRecord(kind, id, record, root = queueRoot()) {
  await ensureQueue(root);
  const directory = join(root, kind);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${safe(id)}.json`);
  await writeOnce(path, record);
  await appendEventLog(record, root);
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

// A failed action is retried, not dropped: the failures seen in production were store
// outages that clear on their own, and a job moved to failed/ on the first one was lost
// for good. The job stays in jobs/ with an `attempts` count and a `notBefore` time, and
// only lands in failed/ once it has used every attempt.
export function backoffDelayMs(attempts, { backoffMs, maxBackoffMs }) {
  return Math.min(maxBackoffMs, backoffMs * 2 ** Math.max(0, attempts - 1));
}

// Replace a job file in place. Rename is atomic, so a reader sees the old or the new job.
async function rewriteJob(path, job) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(job)}\n`); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function runQueue({ root = queueRoot(), execute, env = process.env, now = Date.now(),
  ...overrides }: Record<string, any> = {}) {
  const policy = { ...retryPolicy(env), ...overrides };
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
      if (Date.parse(job.notBefore) > now) continue;
      try {
        await execute(job);
        await rename(source, target);
        results.push({ id: job.id, outcome: 'done' });
      } catch (error) {
        const attempts = (Number.isInteger(job.attempts) ? job.attempts : 0) + 1;
        if (attempts < policy.maxAttempts) {
          const notBefore = new Date(now + backoffDelayMs(attempts, policy)).toISOString();
          await rewriteJob(source, { ...job, attempts, notBefore, lastError: String(error) });
          results.push({ id: job.id, outcome: 'retry', attempts, notBefore, error: String(error) });
          continue;
        }
        await rewriteJob(source, { ...job, attempts, lastError: String(error) });
        await rename(source, join(failed, name));
        const errorFile = await open(join(failed, `${name}.error`), 'w', 0o600);
        try { await errorFile.writeFile(String(error)); } finally { await errorFile.close(); }
        results.push({ id: job.id, outcome: 'failed', attempts, error: String(error) });
      }
    } finally {
      await claimed.close();
      await rm(`${source}.lock`, { force: true });
    }
  }
  return results;
}

// Put every job in failed/ back in the queue with a fresh attempt budget. Used after the
// outage that failed them is fixed. A job whose id is already queued is left in failed/.
export async function retryFailed({ root = queueRoot() }: Record<string, any> = {}) {
  await ensureQueue(root);
  const jobs = join(root, 'jobs'), failed = join(root, 'failed');
  await mkdir(jobs, { recursive: true });
  const requeued = [], skipped = [];
  for (const name of (await readdir(failed).catch(() => [])).filter(file => file.endsWith('.json')).sort()) {
    const target = join(jobs, name);
    if (await stat(target).then(() => true, () => false)) { skipped.push(name); continue; }
    let job;
    try { job = JSON.parse(await readFile(join(failed, name), 'utf8')); } catch { skipped.push(name); continue; }
    delete job.attempts; delete job.notBefore; delete job.lastError;
    if (!await writeOnce(target, job)) { skipped.push(name); continue; }
    await rm(join(failed, name), { force: true });
    await rm(join(failed, `${name}.error`), { force: true });
    requeued.push(name);
  }
  return { requeued, skipped };
}
