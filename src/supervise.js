import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueRoot } from './paths.js';
import { writeHeartbeat } from './heartbeat.js';

export const WORKER_ENTRY = fileURLToPath(new URL('./worker.js', import.meta.url));

// The supervisor exists because "run the worker" is not the same as "keep the worker
// running". A worker that exits on a transient queue error, or that is OOM-killed
// between polls, takes the whole rule-evaluation half of fm-hooks down with it, and
// the queue fills silently. This parent re-spawns it and, crucially, records every
// restart in its own heartbeat -- so a worker that is crash-looping looks like a
// crash-looping worker rather than a healthy one with a low job count.

export const DEFAULT_BACKOFF_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export function spawnWorker({ entry = WORKER_ENTRY, root, intervalMs, env = process.env } = {}) {
  const args = ['--watch'];
  if (root) args.push('--queue', root);
  if (Number.isFinite(intervalMs)) args.push('--interval', String(intervalMs));
  return spawn(process.execPath, [entry, ...args], {
    stdio: 'inherit', env,
  });
}

export async function supervise({
  root = queueRoot(),
  intervalMs,
  env = process.env,
  spawnChild = spawnWorker,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  maxRestarts = Infinity,
  onEvent = () => {},
} = {}) {
  const controller = new AbortController();
  // launchd passes the interval through the agent's environment rather than argv,
  // because a plist that hard-codes a flag cannot be re-timed without a reinstall.
  const interval = Number.isFinite(intervalMs) ? intervalMs : Number(env.FM_HOOK_WORKER_INTERVAL_MS) || undefined;
  const state = { startedAt: new Date().toISOString(), intervalMs: interval ?? null,
    restarts: 0, childPid: null, lastExit: null, lastError: null };
  let child = null;

  const stop = () => {
    controller.abort();
    // SIGTERM, not SIGKILL: the worker handles it, writes its final beat, and exits
    // cleanly, so the record shows a stopped worker rather than a corpse.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, stop);

  const waitForExit = target => new Promise(resolve => {
    if (target.exitCode !== null || target.signalCode !== null) { resolve({ code: target.exitCode, signal: target.signalCode }); return; }
    target.once('exit', (code, signal) => resolve({ code, signal }));
    target.once('error', error => { state.lastError = String(error); resolve({ code: null, signal: null, error: String(error) }); });
  });

  try {
    while (!controller.signal.aborted && state.restarts <= maxRestarts) {
      child = spawnChild({ root, intervalMs: interval, env });
      state.childPid = child.pid ?? null;
      state.lastError = null;
      onEvent({ phase: 'spawn', pid: child.pid ?? null, restarts: state.restarts });
      await writeHeartbeat(root, { ...state }, 'supervisor').catch(() => {});

      const exit = await waitForExit(child);
      state.lastExit = { ...exit, at: new Date().toISOString() };
      onEvent({ phase: 'exit', ...state.lastExit, restarts: state.restarts });
      if (controller.signal.aborted) break;
      if (state.restarts >= maxRestarts) {
        onEvent({ phase: 'exhausted', restarts: state.restarts });
        break;
      }
      state.restarts += 1;
      // Capped exponential backoff: a worker that cannot start at all must not become
      // a hot loop burning CPU while looking alive.
      const delay = Math.min(backoffMs * 2 ** (state.restarts - 1), maxBackoffMs);
      onEvent({ phase: 'backoff', ms: delay, restarts: state.restarts });
      await sleep(delay);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    child = null;
  }
  await writeHeartbeat(root, { ...state, stoppedAt: new Date().toISOString() }, 'supervisor').catch(() => {});
  return state;
}
