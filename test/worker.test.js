import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe } from '../src/observer.js';
import { watchQueue } from '../src/worker.js';
import { supervise } from '../src/supervise.js';
import { workerStatus } from '../src/worker-status.js';
import { heartbeatPath, pidAlive, readHeartbeat, writeHeartbeat } from '../src/heartbeat.js';
import { renderPlist, waitForUnload } from '../src/launchd.js';
import { main as workerCli } from '../bin/fm-hooks-worker.js';

const WORKER = fileURLToPath(new URL('../src/worker.js', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/fm-hooks-worker.js', import.meta.url));
const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

const fixture = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'fm-hooks-worker-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('watch mode drains a queued rule action and the action effect is observable', async () => fixture(async root => {
  const queue = join(root, 'queue');
  const marker = join(root, 'action-ran.txt');
  // A rule that fires on a successful Firstmate call, whose action is a fixed
  // executable with a fixed argv. `touch` is chosen because its effect is a file whose
  // existence and mtime cannot be faked by the worker itself.
  const rules = [{ id: 'proof', operation: 'fm_dispatch', outcomes: ['success'],
    action: { command: 'touch', args: [marker] } }];

  const [result] = await observe({ harness: 'pi', sessionId: 's', callId: 'c1',
    rawCommand: "fm_dispatch 'proof task'", cwd: root, outcome: 'success' }, { root: queue, rules });
  assert.equal(result.actions[0].enqueued, true, 'rule must enqueue before any worker exists');
  assert.equal((await readdir(join(queue, 'jobs'))).length, 1);

  const state = await watchQueue({ root: queue, intervalMs: 10, beatMs: 0, maxCycles: 3 });
  assert.equal(state.processed, 1, 'the resident worker must claim the queued job');
  assert.equal(state.done, 1);
  assert.equal(state.failed, 0);

  // The action's effect, not the worker's opinion of it.
  assert.ok((await stat(marker)).isFile(), 'the action must have produced its side effect');
  assert.equal((await readdir(join(queue, 'jobs'))).length, 0);
  assert.equal((await readdir(join(queue, 'done'))).length, 1);
  assert.equal((await readdir(join(queue, 'failed'))).length, 0);

  const beat = await readHeartbeat(queue);
  assert.equal(beat.pid, process.pid);
  assert.equal(beat.cycles, 3);
  assert.ok(beat.updatedAt, 'every cycle writes a beat, so idle health is distinguishable from a hang');

  const log = (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const workerRecords = log.filter(record => record.type === 'worker').map(record => record.phase);
  assert.deepEqual(workerRecords, ['start', 'cycle', 'beat', 'beat', 'stop']);
  assert.equal(log.find(record => record.type === 'event').operation, 'fm_dispatch');
}));

test('a rule whose outcome does not match enqueues nothing, and the worker idles honestly', async () => fixture(async root => {
  const queue = join(root, 'queue');
  const marker = join(root, 'must-not-exist.txt');
  const rules = [{ id: 'proof', operation: 'fm_dispatch', outcomes: ['success'],
    action: { command: 'touch', args: [marker] } }];
  await observe({ harness: 'pi', callId: 'c1', rawCommand: 'fm_dispatch x', cwd: root, outcome: 'failure' }, { root: queue, rules });
  const state = await watchQueue({ root: queue, intervalMs: 10, beatMs: 0, maxCycles: 2 });
  assert.equal(state.processed, 0);
  assert.equal(state.done, 0);
  assert.equal((await readdir(join(queue, 'jobs'))).length, 0);
  await assert.rejects(stat(marker), 'a non-matching outcome must not run the action');
}));

test('status calls a never-run queue dead and a fresh beat alive', async () => fixture(async root => {
  const never = await workerStatus({ root });
  assert.equal(never.present, false);
  assert.equal(never.ruleEvaluationLive, false);
  assert.match(never.reason, /never run/);

  await writeHeartbeat(root, { cycles: 7, processed: 2, done: 2, failed: 0, intervalMs: 10 });
  const live = await workerStatus({ root });
  assert.equal(live.present, true);
  assert.equal(live.running, true);
  assert.equal(live.heartbeatFresh, true);
  assert.equal(live.ruleEvaluationLive, true, 'a running worker beating on schedule is live');
  assert.equal(live.cycles, 7);
  assert.equal(live.processed, 2);
}));

// The lesson of the day: a process present in the table is not a process working.
// A watcher child wrote one beat and died; reporting it as alive is the trap.
test('status calls a running-but-silent worker dead', async () => fixture(async root => {
  await writeHeartbeat(root, { cycles: 1, processed: 0, done: 0, failed: 0, intervalMs: 10 });
  const written = JSON.parse(await readFile(heartbeatPath(root), 'utf8'));
  // Same live pid, but the beat is from an hour ago: the process is wedged, not healthy.
  const stale = { ...written, updatedAt: new Date(Date.now() - 3600000).toISOString() };
  await writeFile(heartbeatPath(root), JSON.stringify(stale));
  const status = await workerStatus({ root });
  assert.equal(status.running, true, 'the pid really is running');
  assert.equal(status.heartbeatFresh, false);
  assert.equal(status.alive, false, 'present but not progressing is not alive');
  assert.equal(status.ruleEvaluationLive, false, 'present but not progressing is not live');
  assert.match(status.reason, /not progressing/);
}));

test('supervisor restarts a worker that exits and records the restarts', async () => {
  const spawned = [];
  const child = () => {
    const emitter = new EventEmitter();
    emitter.pid = 40000 + spawned.length;
    emitter.exitCode = null; emitter.signalCode = null;
    emitter.kill = () => { emitter.exitCode = 0; setImmediate(() => emitter.emit('exit', 0, null)); };
    spawned.push(emitter);
    // A worker that dies on its own is the case the supervisor exists for.
    setTimeout(() => { emitter.exitCode = 1; emitter.emit('exit', 1, null); }, 5);
    return emitter;
  };
  const queue = await mkdtemp(join(tmpdir(), 'fm-hooks-supervise-'));
  try {
    const events = [];
    const run = supervise({ root: queue, spawnChild: child, backoffMs: 1, maxBackoffMs: 2, maxRestarts: 2,
      onEvent: event => events.push(event.phase) });
    await run;
    assert.equal(spawned.length, 3, 'two restarts means three spawns');
    assert.deepEqual(events.filter(phase => phase === 'spawn').length, 3);
    assert.ok(events.includes('backoff'));
    assert.ok(events.includes('exhausted'), 'the supervisor must stop instead of restarting forever');

    const beat = await readHeartbeat(queue, 'supervisor');
    assert.equal(beat.restarts, 2);
    assert.equal(beat.pid, process.pid);
    assert.ok(beat.stoppedAt, 'a stopped supervisor says so rather than leaving a stale beat');
  } finally { await rm(queue, { recursive: true, force: true }); }
});

test('a live supervisor over a dead worker is not reported as live', async () => fixture(async root => {
  await writeHeartbeat(root, { cycles: 3, processed: 1, done: 1, failed: 0, intervalMs: 10 });
  await writeHeartbeat(root, { restarts: 4, childPid: 999999 }, 'supervisor');
  const status = await workerStatus({ root });
  assert.equal(status.supervisor.alive, true, 'the supervisor itself is healthy');
  assert.equal(status.ruleEvaluationLive, true);
  await writeFile(heartbeatPath(root), JSON.stringify(
    { ...JSON.parse(await readFile(heartbeatPath(root), 'utf8')), pid: 999999 }));
  const dead = await workerStatus({ root });
  assert.equal(dead.supervisor.alive, true);
  assert.equal(dead.ruleEvaluationLive, false, 'the parent running does not make the worker live');
  assert.equal(dead.supervisor.restarts, 4);
}));

test('supervised worker: a real resident process drains a real queue end to end', async () => fixture(async root => {
  const queue = join(root, 'queue');
  const marker = join(root, 'supervised-ran.txt');
  const rulesPath = join(root, 'rules.json');
  await writeFile(rulesPath, JSON.stringify({ rules: [{ id: 'supervised-proof', operation: 'fm_scout',
    outcomes: ['success'], action: { command: 'touch', args: [marker] } }] }));

  const env = { ...process.env, FM_HOOK_QUEUE: queue, FM_HOOK_RULES: rulesPath };
  const child = spawn(process.execPath, [CLI, 'supervise', '--queue', queue, '--interval', '100'], { env, stdio: 'ignore' });
  try {
    // Wait for the supervisor and the worker it spawned to both be beating. Reaching
    // this point is itself the liveness claim: it is asserted from the queue, not from
    // the fact that spawn() returned.
    let status = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await workerStatus({ root: queue });
      if (status.ruleEvaluationLive) break;
      await wait(50);
    }
    assert.equal(status.ruleEvaluationLive, true, `worker never came live: ${JSON.stringify(status)}`);
    assert.equal(status.supervisor.alive, true, 'the supervisor is the process launchd would keep');
    assert.ok(status.pid && pidAlive(status.pid), 'the reported pid is a real running process');

    // Now do the thing the whole layer exists for: observe a Firstmate call, and watch
    // the supervised worker -- not this test -- pick it up and run the action.
    await observe({ harness: 'pi', sessionId: 's', callId: 'scout-1', rawCommand: 'fm_scout project',
      cwd: root, outcome: 'success' }, { root: queue, rules: JSON.parse(await readFile(rulesPath, 'utf8')).rules });

    for (let attempt = 0; attempt < 100; attempt++) {
      const seen = await workerStatus({ root: queue });
      if (seen.processed >= 1 && (await readdir(join(queue, 'done'))).length === 1) break;
      await wait(50);
    }
    assert.ok((await stat(marker)).isFile(), 'the supervised worker must have executed the queued action');
    assert.equal((await readdir(join(queue, 'jobs'))).length, 0);
    assert.equal((await readdir(join(queue, 'failed'))).length, 0);
    assert.equal((await readdir(join(queue, 'done'))).length, 1);

    const after = await workerStatus({ root: queue });
    assert.equal(after.ruleEvaluationLive, true);
    assert.ok(after.processed >= 1, `worker processed count did not advance: ${JSON.stringify(after)}`);
    assert.equal(after.done, 1);
    assert.equal(after.failed, 0);
    assert.ok(after.lastResultAt, 'the worker records when it last did real work');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
  }
}));

test('cli status is machine-readable and exits non-zero when rule evaluation is not live', async () => fixture(async root => {
  const lines = [];
  const code = await workerCli(['status', '--queue', root], { log: line => lines.push(line), error: () => {} });
  assert.equal(code, 1, 'a queue with no worker is not live');
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.queue, root);
  assert.equal(report.ruleEvaluationLive, false);

  await writeHeartbeat(root, { cycles: 2, processed: 1, done: 1, failed: 0 });
  const ok = await workerCli(['status', '--queue', root], { log: () => {}, error: () => {} });
  assert.equal(ok, 0, 'a beating worker is live, so status is usable as a health check');

  assert.equal(await workerCli(['no-such-command'], { log: () => {}, error: () => {} }), 2,
    'an unknown command reaches the worker entry, which exits 2 on its own usage');
}));

test('the launchd plist supervises the supervisor against the resolved queue root', () => {
  const plist = renderPlist({ root: '/tmp/fm-hooks-proof/queue', intervalMs: 500,
    env: { HOME: '/Users/example' }, entry: '/opt/fm-hooks/src/worker.js' });
  assert.match(plist, /<string>com\.fm-hooks\.worker<\/string>/);
  assert.match(plist, /<string>--supervise<\/string>/);
  assert.match(plist, /<string>--queue<\/string>\s*<string>\/tmp\/fm-hooks-proof\/queue<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/, 'launchd must restart the supervisor');
  assert.match(plist, /<key>FM_HOOK_WORKER_INTERVAL_MS<\/key>\s*<string>500<\/string>/);
  assert.match(plist, /StandardOutPath<\/key>\s*<string>\/tmp\/fm-hooks-proof\/queue\/worker\/launchd\.out\.log/);
});

// A plist is a file on disk. Carrying the whole caller environment into it wrote 16 KB
// including every secret variable into ~/Library/LaunchAgents; only the variables
// fm-hooks actually resolves against belong there.
test('the plist carries only the environment fm-hooks resolves against', () => {
  const plist = renderPlist({ root: '/tmp/q', intervalMs: 100, entry: '/opt/worker.js', env: {
    HOME: '/Users/example', PATH: '/usr/bin', FM_HOME: '/srv/firstmate', FM_HOOK_QUEUE: '/somewhere/else',
    FM_HOOK_RULES: '/rules.json', AWS_SECRET_ACCESS_KEY: 'do-not-write-me', OPENAI_API_KEY: 'nor-me',
  } });
  for (const key of ['FM_HOOK_QUEUE', 'FM_HOME', 'FM_HOOK_RULES', 'PATH', 'HOME', 'FM_HOOK_WORKER_INTERVAL_MS']) {
    assert.match(plist, new RegExp(`<key>${key}</key>`), `${key} must reach the supervised worker`);
  }
  assert.match(plist, /<key>FM_HOOK_QUEUE<\/key>\s*<string>\/tmp\/q<\/string>/,
    'the resolved queue root wins over an inherited FM_HOOK_QUEUE');
  assert.doesNotMatch(plist, /AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|do-not-write-me|nor-me/);
  assert.ok(plist.length < 3000, `plist should stay small, got ${plist.length} bytes`);
});

test('unload is awaited rather than assumed, which is what made install fail twice', async () => {
  // launchctl bootout returns before launchd unloads, so a naive install reboots into a
  // "Bootstrap failed: 5" error. waitForUnload must poll until print stops succeeding.
  const original = process.env.HOME;
  process.env.HOME = '/tmp/fm-hooks-plist-home';
  try {
    assert.equal(await waitForUnload('com.fm-hooks.definitely-not-loaded', { timeoutMs: 500, pollMs: 10 }), true,
      'an already-absent label unloads immediately');
  } finally {
    if (original === undefined) delete process.env.HOME; else process.env.HOME = original;
  }
});

// An interval passed only through the agent environment has to reach the worker it
// spawns. Caught by observing a real install that ignored its own --interval.
test('the supervisor passes the launchd environment interval to the worker it spawns', async () => {
  const spawned = [];
  const child = () => {
    const emitter = new EventEmitter();
    emitter.pid = 51000 + spawned.length;
    emitter.exitCode = null; emitter.signalCode = null;
    emitter.kill = () => { emitter.exitCode = 0; setImmediate(() => emitter.emit('exit', 0, null)); };
    spawned.push({ pid: emitter.pid, options: current });
    current = null;
    setTimeout(() => { emitter.exitCode = 0; emitter.emit('exit', 0, null); }, 2);
    return emitter;
  };
  let current = null;
  const queue = await mkdtemp(join(tmpdir(), 'fm-hooks-interval-'));
  try {
    await supervise({ root: queue, spawnChild: (options) => { current = options; return child(); },
      env: { FM_HOOK_WORKER_INTERVAL_MS: '750' }, backoffMs: 1, maxRestarts: 0 });
    assert.equal(spawned[0].options.intervalMs, 750, 'the env interval must reach the child');
    assert.equal((await readHeartbeat(queue, 'supervisor')).intervalMs, 750, 'and be visible in the record');
  } finally { await rm(queue, { recursive: true, force: true }); }
});

test('the existing one-shot worker still drains once and exits', async () => fixture(async root => {
  const queue = join(root, 'queue');
  const marker = join(root, 'once.txt');
  const rules = [{ id: 'once', operation: 'fm_send', outcomes: ['success'], action: { command: 'touch', args: [marker] } }];
  await observe({ harness: 'claude-code', callId: 'c', rawCommand: 'fm_send task-1', cwd: root, outcome: 'success' }, { root: queue, rules });
  const child = spawnSync(process.execPath, [WORKER, '--once', '--queue', queue], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).outcome, 'done');
  assert.ok((await stat(marker)).isFile());
  assert.equal((await readdir(join(queue, 'done'))).length, 1);
}));

test('a rules file without a rules array is rejected rather than silently ignored', async () => {
  const { loadRules } = await import('../src/queue.js');
  const root = await mkdtemp(join(tmpdir(), 'fm-hooks-badrules-'));
  try {
    const path = join(root, 'fm-hooks.rules.json');
    await writeFile(path, JSON.stringify({ notRules: [] }));
    await assert.rejects(() => loadRules([path]), /rules array/);
    assert.deepEqual(await loadRules([join(root, 'absent.json')]), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
