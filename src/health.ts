import { access, constants, readdir, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { defaultRulesPaths, queueRoot } from './paths.ts';
import { loadRules } from './queue.ts';
import { workerStatus } from './worker-status.ts';
import { pollerStatus } from './bead-poller.ts';

// `status` answers "is the worker process beating". That is necessary and not enough:
// a beating worker with no rules loaded, a rule whose action cannot be found, or a
// queue that fills faster than it drains all look healthy to a heartbeat. `health`
// answers the question the captain actually has -- "will the next fm-* call end up in
// a bead?" -- and returns the specific reason when the answer is no.

async function executable(command, env) {
  const dirs = isAbsolute(command) ? [''] : (env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try { await access(isAbsolute(command) ? command : join(dir, command), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

async function jobs(root, now) {
  const count = async name => (await readdir(join(root, name)).catch(() => [])).filter(file => file.endsWith('.json'));
  const pending = await count('jobs');
  let oldestAgeMs = 0;
  for (const name of pending) {
    const info = await stat(join(root, 'jobs', name)).catch(() => null);
    if (info) oldestAgeMs = Math.max(oldestAgeMs, now - info.mtimeMs);
  }
  return { pending: pending.length, oldestAgeMs: Math.round(oldestAgeMs), failed: (await count('failed')).length };
}

export async function healthStatus({ root = queueRoot(), env = process.env, now = Date.now(), staleAfterMs,
  requirePoller = false, rulesPaths = defaultRulesPaths(env) }: Record<string, any> = {}) {
  const worker = await workerStatus({ root, staleAfterMs, now });
  const problems = [];
  if (!worker.ruleEvaluationLive) problems.push(`worker not live: ${worker.reason}`);

  // Rules are read the way the observer reads them: first existing candidate wins.
  let rules = [], rulesError = null;
  try { rules = await loadRules(rulesPaths); } catch (error) { rulesError = String(error); }
  const missing = [];
  for (const command of new Set(rules.map(rule => rule.action?.command).filter(Boolean))) {
    if (!(await executable(command, env))) missing.push(command);
  }
  const rulesLive = !rulesError && rules.length > 0 && missing.length === 0;
  if (rulesError) problems.push(`rules unreadable: ${rulesError}`);
  else if (!rules.length) problems.push(`no rules loaded from ${rulesPaths.join(' or ')}: nothing will ever fire`);
  if (missing.length) problems.push(`rule action not found on PATH: ${missing.join(', ')}`);

  const queue = await jobs(root, now);
  // A job should leave the queue within a few poll intervals. Older than that, with a
  // "live" worker, is the wedged-drain shape.
  const limitMs = Math.max(30000, 20 * (worker.intervalMs || 1000));
  const draining = queue.pending === 0 || queue.oldestAgeMs <= limitMs;
  if (!draining) problems.push(`jobs not draining: ${queue.pending} pending, oldest ${queue.oldestAgeMs}ms (limit ${limitMs}ms)`);
  if (queue.failed) problems.push(`${queue.failed} job(s) in failed/ need inspection`);

  const poller = await pollerStatus({ root, now });
  if (requirePoller && !poller.alive) problems.push(`bead poller not live: ${poller.reason}`);

  return { queue: root, healthy: problems.length === 0, problems, worker: { alive: worker.alive, reason: worker.reason,
    cycles: worker.cycles, done: worker.done, failed: worker.failed },
  rules: { paths: rulesPaths, count: rules.length, live: rulesLive, missingCommands: missing, error: rulesError },
  jobs: { ...queue, limitMs, draining }, poller };
}
