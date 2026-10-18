import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueAction, runQueue, retryFailed } from '../src/queue.ts';
import { execute } from '../src/worker.ts';
import { healthStatus } from '../src/health.ts';
import { deploy } from '../src/deploy.ts';
import { writeHeartbeat } from '../src/heartbeat.ts';
import { main as workerCli } from '../bin/fm-hooks-worker.ts';
import { main as hooksCli } from '../bin/fm-hooks.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const fixture = async fn => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-retry-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

const event = { correlationId: 'c1', operation: 'fm-spawn.sh' };
const rule = { id: 'r1' };
const action = { command: 'true', args: [] };
const only = async (root, dir) => {
  const names = (await readdir(join(root, dir))).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1, `${dir} holds one job`);
  return JSON.parse(await readFile(join(root, dir, names[0]), 'utf8'));
};
const failing = async () => { throw new Error('store down'); };

// --- retry ---------------------------------------------------------------------

test('a failed action stays in jobs/ with an attempts counter and a notBefore backoff', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  const now = Date.parse('2026-10-18T10:00:00Z');
  const first = await runQueue({ root, execute: failing, now, maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 60000 });
  assert.equal(first[0].outcome, 'retry');
  const job = await only(root, 'jobs');
  assert.equal(job.attempts, 1);
  assert.equal(job.notBefore, new Date(now + 1000).toISOString());
  assert.match(job.lastError, /store down/);
  assert.equal((await readdir(join(root, 'failed'))).length, 0);
}));

test('a job is not run again before its notBefore, then runs and is done once the store recovers', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  const now = Date.parse('2026-10-18T10:00:00Z');
  const policy = { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 60000 };
  await runQueue({ root, execute: failing, now, ...policy });
  let runs = 0;
  const execute = async () => { runs++; };
  assert.deepEqual(await runQueue({ root, execute, now: now + 500, ...policy }), []);
  assert.equal(runs, 0, 'still backing off');
  const later = await runQueue({ root, execute, now: now + 1000, ...policy });
  assert.deepEqual(later.map(r => r.outcome), ['done']);
  assert.equal(runs, 1);
  assert.equal((await readdir(join(root, 'jobs'))).filter(n => n.endsWith('.json')).length, 0);
}));

test('backoff doubles per attempt up to the cap', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  const policy = { maxAttempts: 9, backoffMs: 1000, maxBackoffMs: 3000 };
  let now = Date.parse('2026-10-18T10:00:00Z');
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const [result] = await runQueue({ root, execute: failing, now, ...policy });
    const delay = Date.parse(result.notBefore) - now;
    delays.push(delay);
    now += delay;
  }
  assert.deepEqual(delays, [1000, 2000, 3000, 3000]);
}));

test('after maxAttempts the job moves to failed/ with its error and attempt count', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  const policy = { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 };
  const now = Date.now();
  assert.equal((await runQueue({ root, execute: failing, now, ...policy }))[0].outcome, 'retry');
  const last = await runQueue({ root, execute: failing, now: now + 1, ...policy });
  assert.equal(last[0].outcome, 'failed');
  assert.equal(last[0].attempts, 2);
  assert.equal((await readdir(join(root, 'jobs'))).filter(n => n.endsWith('.json')).length, 0);
  assert.equal((await only(root, 'failed')).attempts, 2);
  const errors = (await readdir(join(root, 'failed'))).filter(n => n.endsWith('.error'));
  assert.match(await readFile(join(root, 'failed', errors[0]), 'utf8'), /store down/);
}));

test('FM_HOOK_MAX_ATTEMPTS=1 restores fail-on-first-error', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  const [result] = await runQueue({ root, execute: failing, env: { FM_HOOK_MAX_ATTEMPTS: '1' } });
  assert.equal(result.outcome, 'failed');
}));

// --- action timeout --------------------------------------------------------------

test('execute kills an action that outlives the timeout and rejects so the job is retried', async () => {
  const job = { id: 'j', correlationId: 'c', ruleId: 'r', operation: 'o', action: { command: 'sleep', args: ['30'] } };
  const started = Date.now();
  await assert.rejects(execute(job, { timeoutMs: 100 }), /timed out after 100ms/);
  assert.ok(Date.now() - started < 5000, 'killed, not waited out');
});

test('execute with a zero timeout does not limit the action', async () => {
  const job = { id: 'j', correlationId: 'c', ruleId: 'r', operation: 'o', action: { command: 'true', args: [] } };
  await execute(job, { timeoutMs: 0 });
});

// --- retry-failed ----------------------------------------------------------------

test('retry-failed re-queues failed jobs with a fresh budget and clears their error files', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  await runQueue({ root, execute: failing, maxAttempts: 1 });
  assert.equal((await only(root, 'failed')).attempts, 1);
  const logs = [];
  const code = await workerCli(['retry-failed', '--queue', root], { log: line => logs.push(line), error() {} });
  assert.equal(code, 0);
  assert.equal(JSON.parse(logs[0]).requeued.length, 1);
  const job = await only(root, 'jobs');
  assert.equal(job.attempts, undefined);
  assert.equal(job.notBefore, undefined);
  assert.deepEqual(await readdir(join(root, 'failed')), []);
  let runs = 0;
  await runQueue({ root, execute: async () => { runs++; } });
  assert.equal(runs, 1);
}));

test('retry-failed leaves a failed job in place when the same job is already queued', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  await runQueue({ root, execute: failing, maxAttempts: 1 });
  await enqueueAction(event, rule, action, root);
  const result = await retryFailed({ root });
  assert.equal(result.requeued.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal((await readdir(join(root, 'failed'))).filter(n => n.endsWith('.json')).length, 1);
}));

// --- health: backoff is not a wedge ----------------------------------------------

test('health counts a job waiting out its backoff as retrying, not as a stuck queue', async () => fixture(async dir => {
  const root = join(dir, 'q');
  await enqueueAction(event, rule, action, root);
  await runQueue({ root, execute: failing, maxAttempts: 5, backoffMs: 3600000, maxBackoffMs: 3600000 });
  await writeHeartbeat(root, { intervalMs: 1000, cycles: 1 }, 'worker');
  const rules = join(dir, 'rules.json');
  await writeFile(rules, JSON.stringify({ rules: [{ id: 'r', operation: '*', outcomes: ['success'], action: { command: 'sh', args: [] } }] }));
  const health = await healthStatus({ root, rulesPaths: [rules], shippedRules: null, checkout: dir,
    now: Date.now() + 10 * 60 * 1000, staleAfterMs: 3600000, env: { PATH: process.env.PATH } });
  assert.equal(health.jobs.retrying, 1);
  assert.equal(health.jobs.draining, true);
  assert.deepEqual(health.problems, []);
}));

// --- drift -----------------------------------------------------------------------

const git = (cwd, ...args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};

const healthWith = async (dir, extra) => {
  const root = join(dir, 'q');
  await mkdir(root, { recursive: true });
  await writeHeartbeat(root, { intervalMs: 1000, cycles: 1 }, 'worker');
  return healthStatus({ root, env: { PATH: process.env.PATH }, ...extra });
};

const writeRules = (path, ids) => writeFile(path,
  JSON.stringify({ rules: ids.map(id => ({ id, operation: '*', outcomes: ['success'], action: { command: 'sh', args: [] } })) }));

test('health reports live rules that differ from the shipped rules, naming the missing rule', async () => fixture(async dir => {
  const live = join(dir, 'live.json'), shipped = join(dir, 'shipped.json');
  await writeRules(live, ['a']);
  await writeRules(shipped, ['a', 'b']);
  const health = await healthWith(dir, { rulesPaths: [live], shippedRules: shipped, checkout: dir });
  assert.equal(health.healthy, false);
  assert.match(health.problems.join('\n'), /live rules .*live\.json differ.*missing b.*fm-hooks deploy/);
  assert.ok(health.drift.rules);
}));

test('health is quiet when the live rules equal the shipped rules, whatever the whitespace', async () => fixture(async dir => {
  const live = join(dir, 'live.json'), shipped = join(dir, 'shipped.json');
  await writeRules(shipped, ['a', 'b']);
  await writeFile(live, JSON.stringify(JSON.parse(await readFile(shipped, 'utf8')), null, 4));
  const health = await healthWith(dir, { rulesPaths: [live], shippedRules: shipped, checkout: dir });
  assert.deepEqual(health.problems, []);
  assert.equal(health.drift.rules, null);
}));

test('health reports a deploy clone that is behind its remote, and is quiet once it catches up', async () => fixture(async dir => {
  const origin = join(dir, 'origin.git'), clone = join(dir, 'clone'), other = join(dir, 'other');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 't@example.com'); git(clone, 'config', 'user.name', 't');
  await writeFile(join(clone, 'a'), '1');
  git(clone, 'add', 'a'); git(clone, 'commit', '-m', 'one'); git(clone, 'push', '-u', 'origin', 'main');
  git(dir, 'clone', origin, other);
  git(other, 'config', 'user.email', 't@example.com'); git(other, 'config', 'user.name', 't');
  await writeFile(join(other, 'b'), '2');
  git(other, 'add', 'b'); git(other, 'commit', '-m', 'two'); git(other, 'push');

  const rules = join(dir, 'rules.json');
  await writeRules(rules, ['a']);
  const options = { rulesPaths: [rules], shippedRules: rules, checkout: clone };
  // not fetched: the clone does not know the remote moved yet
  assert.deepEqual((await healthWith(dir, options)).problems, []);
  const behind = await healthWith(dir, { ...options, fetchRemote: true });
  assert.match(behind.problems.join('\n'), /is 1 commit\(s\) behind origin\/main/);
  git(clone, 'pull', '--ff-only');
  assert.deepEqual((await healthWith(dir, { ...options, fetchRemote: true })).problems, []);
}));

test('a checkout with no upstream (detached or unpublished) is not reported as behind', async () => fixture(async dir => {
  git(dir, 'init', '-b', 'main', dir);
  const rules = join(dir, 'rules.json');
  await writeRules(rules, ['a']);
  const health = await healthWith(dir, { rulesPaths: [rules], shippedRules: rules, checkout: dir, fetchRemote: true });
  assert.equal(health.drift.clone, null);
}));

// --- deploy ----------------------------------------------------------------------

const deployFixture = async (dir, overrides = {}) => {
  const deployDir = join(dir, 'state'), homeRules = join(dir, 'home', 'fm-hooks.rules.json');
  const lines = [];
  return { deployDir, homeRules, lines,
    run: (extra = {}) => deploy({ checkout: REPO, deployDir, homeRules, fetch: false, log: line => lines.push(line), ...overrides, ...extra }) };
};

test('deploy installs rules to both locations, the task-card, and the bead-action symlink', async () => fixture(async dir => {
  const { deployDir, homeRules, run } = await deployFixture(dir);
  const result = await run();
  const shipped = await readFile(join(REPO, 'config', 'fm-hooks.rules.json'), 'utf8');
  assert.equal(await readFile(join(deployDir, 'fm-hooks.rules.json'), 'utf8'), shipped);
  assert.equal(await readFile(homeRules, 'utf8'), shipped);
  assert.equal((await stat(join(deployDir, 'fm-hooks.rules.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(deployDir, 'fm-hooks-task-card.sh'))).mode & 0o777, 0o700);
  assert.ok((await lstat(join(deployDir, 'fm-hooks-bead-action'))).isSymbolicLink());
  assert.equal(await readlink(join(deployDir, 'fm-hooks-bead-action')), join(REPO, 'bin', 'fm-hooks-bead-action.ts'));
  assert.equal(result.changed.length, 2);
}));

test('deploy prints the diff against the live rules before replacing them, and is a no-op the second time', async () => fixture(async dir => {
  const { deployDir, lines, run } = await deployFixture(dir);
  await mkdir(deployDir, { recursive: true });
  await writeRules(join(deployDir, 'fm-hooks.rules.json'), ['old-rule']);
  await run();
  const output = lines.join('\n');
  assert.match(output, /changed: .*state\/fm-hooks\.rules\.json/);
  assert.match(output, /-.*"old-rule"/);
  assert.match(output, /\+.*"fm-spawn-failure"/);
  lines.length = 0;
  const again = await run();
  assert.equal(again.changed.length, 0);
  assert.match(lines.join('\n'), /unchanged: .*state\/fm-hooks\.rules\.json/);
}));

test('deploy --dry-run shows the diff and writes nothing', async () => fixture(async dir => {
  const { deployDir, lines, run } = await deployFixture(dir);
  await mkdir(deployDir, { recursive: true });
  const live = join(deployDir, 'fm-hooks.rules.json');
  await writeRules(live, ['old-rule']);
  const before = await readFile(live, 'utf8');
  await run({ dryRun: true });
  assert.equal(await readFile(live, 'utf8'), before);
  assert.match(lines.join('\n'), /"fm-spawn-failure"/);
  assert.match(lines.join('\n'), /dry run: nothing written/);
  await assert.rejects(stat(join(deployDir, 'fm-hooks-task-card.sh')));
}));

test('deploy warns when the clone it deploys from is behind its remote', async () => fixture(async dir => {
  const origin = join(dir, 'origin.git'), clone = join(dir, 'clone');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 't@example.com'); git(clone, 'config', 'user.name', 't');
  await mkdir(join(clone, 'config'), { recursive: true }); await mkdir(join(clone, 'bin'));
  await writeRules(join(clone, 'config', 'fm-hooks.rules.json'), ['a']);
  await writeFile(join(clone, 'bin', 'fm-hooks-task-card.sh'), '#!/bin/sh\n');
  git(clone, 'add', 'config', 'bin'); git(clone, 'commit', '-m', 'one'); git(clone, 'push', '-u', 'origin', 'main');
  git(clone, 'commit', '--allow-empty', '-m', 'two'); git(clone, 'push');
  git(clone, 'reset', '--hard', 'HEAD~1');
  const { run } = await deployFixture(dir);
  const result = await run({ checkout: clone, fetch: true, dryRun: true });
  assert.match(result.warnings.join('\n'), /1 commit\(s\) behind origin\/main/);
}));

test('the fm-hooks cli runs deploy and rejects unknown commands', async () => fixture(async dir => {
  const lines = [], errors = [];
  const code = await hooksCli(['deploy', '--dry-run', '--no-fetch', '--deploy-dir', join(dir, 's'), '--home-rules', join(dir, 'h.json')],
    { log: line => lines.push(line), error: line => errors.push(line) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /dry run: nothing written/);
  assert.equal(await hooksCli(['bogus'], { log() {}, error: line => errors.push(line) }), 2);
}));
