#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appendEventLog, runQueue } from './queue.ts';
import { actionTimeoutMs, queueRoot } from './paths.ts';
import { writeHeartbeat } from './heartbeat.ts';

export const DEFAULT_INTERVAL_MS = 1000;
// The observation log already proves the hooks are loaded. This beat proves the other
// half of the pipeline -- that something is actually draining the queue -- without
// writing a line every poll and drowning the observations it shares a file with.
export const DEFAULT_BEAT_MS = 60000;

// Not unref'd on purpose: in watch mode the pending interval is the only thing keeping
// the process resident, which is the entire point of the supervised mode.
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export function interpolate(value, job) {
  return value.replaceAll('{operation}', job.operation)
    .replaceAll('{correlationId}', job.correlationId)
    .replaceAll('{ruleId}', job.ruleId);
}

// A hung action (a store call that never returns) must not stall the queue: it is
// terminated after the timeout and fails like any other action, so it is retried.
const KILL_GRACE_MS = 2000;

export function execute(job, { timeoutMs = actionTimeoutMs() }: Record<string, any> = {}) {
  const action = job.action;
  if (!action || typeof action.command !== 'string' || !Array.isArray(action.args) || !action.args.every(x => typeof x === 'string')) {
    throw new Error('action must have a command and string args array');
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(action.command, action.args.map(arg => interpolate(arg, job)), {
      cwd: action.cwd || process.cwd(), shell: false, stdio: 'inherit',
      env: { ...process.env, FM_HOOK_CORRELATION_ID: job.correlationId,
        FM_HOOK_IDEMPOTENCY_KEY: job.id }
    });
    let timedOut = false;
    let killTimer;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs) : null;
    const settle = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.once('error', error => { settle(); reject(error); });
    child.once('exit', code => {
      settle();
      if (timedOut) reject(new Error(`action timed out after ${timeoutMs}ms`));
      else if (code === 0) resolve();
      else reject(new Error(`action exited ${code}`));
    });
  });
}

// Drain the queue repeatedly instead of exiting after one pass.
//
// `worker.ts` used to be a single drain-and-exit script, which is not a thing a
// supervisor can supervise: there is nothing to keep alive, so nothing kept it alive,
// and rule evaluation was inert in practice however correct the code read. This loop
// is the supervised unit. It beats every cycle whether or not there was work, so an
// idle-but-healthy worker is distinguishable from a wedged one.
export async function watchQueue({
  root = queueRoot(),
  execute: run = execute,
  intervalMs,
  beatMs = DEFAULT_BEAT_MS,
  maxCycles = Infinity,
  signal,
  env = process.env,
  onResult = result => console.log(JSON.stringify(result)),
}: Record<string, any> = {}) {
  // An explicit flag wins; otherwise a supervised launch re-times the worker through
  // the environment, which is the only channel a plist has.
  const pollMs = Number.isFinite(intervalMs) ? intervalMs
    : Number(env.FM_HOOK_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const startedAt = new Date().toISOString();
  const state = { startedAt, cycles: 0, processed: 0, done: 0, failed: 0, retried: 0, lastResultAt: null, lastError: null };
  let lastBeat = 0;
  // Logged through the observer's own writer so a single `tail -f events.jsonl` shows
  // both halves of the pipeline: what was observed, and who is draining it.
  const note = record => appendEventLog({ type: 'worker', root, ...record }, root).catch(() => {});

  await note({ phase: 'start', pid: process.pid, intervalMs: pollMs });
  for (;;) {
    if (signal?.aborted) break;
    let results = [];
    try {
      results = await runQueue({ root, execute: run, env });
      state.lastError = null;
    } catch (error) {
      // A queue-level failure must not end the loop; a worker that dies on one bad
      // directory is the "appeared alive, then silently gone" shape again.
      state.lastError = String(error);
      await note({ phase: 'cycle-error', pid: process.pid, error: String(error) });
    }
    state.cycles += 1;
    state.processed += results.length;
    state.done += results.filter(result => result.outcome === 'done').length;
    state.failed += results.filter(result => result.outcome === 'failed').length;
    state.retried += results.filter(result => result.outcome === 'retry').length;
    for (const result of results) onResult(result);

    if (results.length) {
      state.lastResultAt = new Date().toISOString();
      await note({ phase: 'cycle', pid: process.pid, cycles: state.cycles,
        results: results.map(({ id, outcome }) => ({ id, outcome })) });
    }
    // The beat is written before the log note and outside the same failure path: if the
    // queue directory is unreadable the supervisor must still see the worker is alive
    // and reporting an error, not conclude it died.
    await writeHeartbeat(root, { ...state, intervalMs: pollMs, beatMs }, 'worker').catch(error => {
      state.lastError = `heartbeat: ${error}`;
    });

    if (!results.length && Date.now() - lastBeat >= beatMs) {
      lastBeat = Date.now();
      await note({ phase: 'beat', pid: process.pid, cycles: state.cycles });
    }
    if (state.cycles >= maxCycles || signal?.aborted) break;
    await sleep(pollMs);
  }
  await note({ phase: 'stop', pid: process.pid, cycles: state.cycles, processed: state.processed });
  return state;
}

export function parseArgv(argv) {
  const options: Record<string, any> = { mode: 'once', intervalMs: DEFAULT_INTERVAL_MS, beatMs: DEFAULT_BEAT_MS };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--watch') options.mode = 'watch';
    else if (arg === '--supervise') options.mode = 'supervise';
    else if (arg === '--once') options.mode = 'once';
    else if (arg === '--interval') { options.intervalMs = Number(value()); options.intervalSet = true; }
    else if (arg === '--beat') options.beatMs = Number(value());
    else if (arg === '--max-cycles') options.maxCycles = Number(value());
    else if (arg === '--queue') options.root = value();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = `usage: worker.ts [--once | --watch | --supervise] [--queue DIR] [--interval MS] [--beat MS] [--max-cycles N]

  --once          drain the queue once and exit (default)
  --watch         stay resident, draining on every interval; this is the supervised mode
  --supervise     run the resident worker as a child and restart it whenever it exits;
                  this is what launchd keeps alive, so a crash is not the end of the queue
  --queue DIR     override the queue root (otherwise the fm-hooks state root)
  --interval MS   poll interval in watch/supervise mode (default ${DEFAULT_INTERVAL_MS})
  --beat MS       idle beat cadence written to events.jsonl (default ${DEFAULT_BEAT_MS})
  --max-cycles N  stop watch mode after N cycles; used by the test suite
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgv(process.argv.slice(2));
  if (options.help) { console.log(USAGE); process.exit(0); }
  if (!(options.intervalMs >= 0) || !(options.beatMs >= 0)) {
    console.error('fm-hooks worker: --interval and --beat must be non-negative numbers');
    process.exit(2);
  }
  const root = options.root ?? queueRoot();
  // Only an explicit --interval is passed down. Handing the parsed default to the
  // child would make the environment override unreachable, because a default is
  // indistinguishable from a chosen value once it is just a number.
  const intervalMs = options.intervalSet ? options.intervalMs : undefined;
  if (options.mode === 'supervise') {
    const { supervise } = await import('./supervise.ts');
    const state = await supervise({ root, intervalMs,
      onEvent: event => console.log(JSON.stringify({ type: 'supervisor', ...event })) });
    process.exitCode = state.lastError ? 1 : 0;
  } else if (options.mode === 'watch') {
    // A supervised process gets a termination signal, not an abrupt death: leave the
    // final beat in place so `status` shows where it stopped rather than a stale gap.
    const controller = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort());
    const state = await watchQueue({ ...options, root, intervalMs, signal: controller.signal });
    process.exitCode = state.lastError ? 1 : 0;
  } else {
    const results = await runQueue({ root, execute });
    for (const result of results) console.log(JSON.stringify(result));
  }
}
