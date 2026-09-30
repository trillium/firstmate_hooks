import { link, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const safe = value => String(value).replace(/[^A-Za-z0-9_.-]/g, '_');

async function writeOnce(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally { await rm(temporary, { force: true }); }
}

export async function persistEvent(event, root = process.env.FM_HOOK_QUEUE || '.fm-hooks/queue') {
  const events = join(root, 'events');
  await mkdir(events, { recursive: true });
  const path = join(events, `${event.correlationId}-${safe(event.operation)}.json`);
  // Same call ID may be observed repeatedly. Preserve the original durable record.
  await writeOnce(path, event);
  return path;
}

export async function enqueueAction(event, rule, action, root = process.env.FM_HOOK_QUEUE || '.fm-hooks/queue') {
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
    if (rule.operation !== event.operation || !Array.isArray(rule.outcomes) || !rule.outcomes.includes(event.outcome)) continue;
    results.push(await enqueueAction(event, rule, rule.action, root));
  }
  return results;
}

export async function loadRules(path = process.env.FM_HOOK_RULES || 'fm-hooks.rules.json') {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(parsed.rules)) throw new Error('rules file must contain a rules array');
    return parsed.rules;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
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

export async function runQueue({ root = process.env.FM_HOOK_QUEUE || '.fm-hooks/queue', execute }) {
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
