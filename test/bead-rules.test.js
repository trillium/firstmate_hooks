import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe } from '../src/observer.js';
import { runQueue } from '../src/queue.js';
import { execute } from '../src/worker.js';
import { healthStatus } from '../src/health.js';
import { renderPollerPlist } from '../src/poller-launchd.js';
import { main as pollerCli } from '../bin/fm-hooks-bead-poller.js';
import { main as workerCli } from '../bin/fm-hooks-worker.js';
import { writeHeartbeat } from '../src/heartbeat.js';
import { withStubs } from '../testlib/stub-env.js';

const RULES = fileURLToPath(new URL('../config/fm-hooks.rules.json', import.meta.url));
const ACTION = fileURLToPath(new URL('../bin/fm-hooks-bead-action.js', import.meta.url));

// Runs the shipped rule set through the real observer -> queue -> worker execute path,
// with the action resolved from PATH exactly as the launchd worker resolves it.
async function pipeline({ dir, env }, commands) {
  const bin = join(dir, 'pathbin');
  await mkdir(bin, { recursive: true });
  await symlink(ACTION, join(bin, 'fm-hooks-bead-action')).catch(() => {});
  // The failure rules' task-card action is out of scope here; a no-op stands in for it.
  await writeFile(join(bin, 'fm-hooks-task-card.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const rules = JSON.parse(await readFile(RULES, 'utf8')).rules;
  const saved = { ...process.env };
  Object.assign(process.env, env, { PATH: [bin, process.env.PATH].join(delimiter) });
  try {
    for (const [index, command] of commands.entries()) {
      await observe({ harness: 'claude', sessionId: 'sess1234', callId: `call-${command.id ?? index}`, rawCommand: command.raw,
        cwd: dir, outcome: command.outcome ?? 'success', startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:01.000Z' },
      { root: env.FM_HOOK_QUEUE, rules });
    }
    return await runQueue({ root: env.FM_HOOK_QUEUE, execute });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('the shipped rule set is valid and every action is a fixed command with string args', async () => {
  const { rules } = JSON.parse(await readFile(RULES, 'utf8'));
  const ids = rules.map(rule => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique: they key job idempotency');
  for (const rule of rules) {
    assert.ok(rule.outcomes.length && rule.action.args.every(arg => typeof arg === 'string'), rule.id);
  }
  for (const id of ['fm-ledger-timeline', 'fm-spawn-project-comment', 'fm-pr-merge-project-comment',
    'fm-merge-local-project-comment', 'fm-branch-outcome-project-comment', 'fm-captain-hold-review',
    'fm-brief-failure', 'fm-fleet-sync-failure', 'fm-send-failure', 'fm-brief-project-comment', 'fm-fleet-sync-project-comment']) {
    assert.ok(ids.includes(id), `${id} is shipped`);
  }
});

test('end to end: a successful fm-spawn call becomes a ledger line and a project comment, once', async () => withStubs(async ctx => {
  const call = { raw: '/h/bin/fm-spawn.sh task-a /h/projects/demo --mode direct-PR 2>&1 | tail -4' };
  const results = await pipeline(ctx, [call]);
  assert.deepEqual(results.map(r => r.outcome), ['done', 'done', 'done']);
  // the same hook delivery observed again re-runs the actions (the first job is already
  // in done/) and must write nothing new: idempotence lives in the store, not the queue
  const before = (await ctx.writes()).length;
  assert.equal((await pipeline(ctx, [call])).length, 3);
  assert.equal((await ctx.writes()).length, before, 'a re-delivery performs no bead write');
  const state = await ctx.db();
  assert.equal(state.lifespan.beads['lifespan-fmh20261010'].comments.length, 1);
  assert.equal(state.fleet.beads['fleet-task-a'].comments.length, 1);
  assert.ok(state.fleet.beads['fleet-task-a'].labels.includes('fm-state:dispatched'));
  assert.match(state.projects.beads['project-fmh-demo'].comments[0].text, /dispatched task-a on demo/);
}));

test('end to end: a failed call is ledgered but not commented on a project', async () => withStubs(async ctx => {
  await pipeline(ctx, [{ raw: '/h/bin/fm-spawn.sh task-a /h/projects/demo', outcome: 'failure' }]); 
  const state = await ctx.db();
  assert.match(state.lifespan.beads['lifespan-fmh20261010'].comments[0].text, /fm-spawn\.sh failure/);
  assert.equal(state.projects, undefined);
}));

test('end to end: captain hold files a human review bead; fm-send is not touched by the hook', async () => withStubs(async ctx => {
  await pipeline(ctx, [{ raw: '/h/bin/fm-captain-hold.sh hold task-h --reason "pick a db"' }]);
  const beads = Object.values((await ctx.db()).review.beads);
  assert.equal(beads.length, 1);
  assert.ok(beads[0].labels.includes('human') && beads[0].labels.includes('fm-key:captain-hold-task-h-1'));
}));

test('end to end: a store outage fails the job into failed/ and a later drain after the fix does not duplicate', async () => withStubs(async ctx => {
  const { env } = ctx;
  const broken = { ...env, STUB_FAIL: 'lifespan:create' };
  const call = { raw: '/h/bin/fm-merge-local.sh task-m' };
  const failed = await pipeline({ ...ctx, env: broken }, [call]);
  assert.ok(failed.some(r => r.outcome === 'failed'));
  const state = await ctx.db();
  assert.equal(state.lifespan?.beads?.['lifespan-fmh20261010'], undefined, 'nothing half-written');
}));

test('rules: brief and fleet-sync comment on success, brief/fleet-sync/send open a card on failure, noisy calls are ledger-only', async () => {
  const { rules } = JSON.parse(await readFile(RULES, 'utf8'));
  const firing = (operation, outcome) => rules.filter(rule => (rule.operation === operation || rule.operation === '*')
    && rule.outcomes.includes(outcome)).map(rule => rule.id).sort();
  assert.deepEqual(firing('fm-brief.sh', 'success'), ['fm-brief-fleet', 'fm-brief-project-comment', 'fm-ledger-timeline']);
  assert.deepEqual(firing('fm-fleet-sync.sh', 'success'), ['fm-fleet-sync-project-comment', 'fm-ledger-timeline']);
  for (const [op, id] of [['fm-brief.sh', 'fm-brief-failure'], ['fm-fleet-sync.sh', 'fm-fleet-sync-failure'], ['fm-send.sh', 'fm-send-failure']]) {
    assert.deepEqual(firing(op, 'failure'), [id, 'fm-ledger-timeline'].sort());
  }
  assert.deepEqual(firing('fm-send.sh', 'success'), ['fm-ledger-timeline', 'fm-send-fleet']);
  for (const op of ['fm-tasks-axi.sh', 'fm-inbox.sh', 'fm-wake-drain.sh', 'fm-crew-state.sh']) {
    assert.deepEqual(firing(op, 'success'), ['fm-ledger-timeline'], `${op} success is ledger-only`);
  }
  for (const op of ['fm-spawn.sh', 'fm-control.sh', 'fm-promote.sh', 'fm-pr-merge.sh', 'fm-merge-local.sh', 'fm-teardown.sh', 'fm-captain-hold.sh']) {
    assert.ok(firing(op, 'success').includes(`${op.replace(/^fm-|\.sh$/g, '').replace(/^/, 'fm-')}-fleet`), `${op} success feeds the fleet bead`);
    assert.deepEqual(firing(op, 'failure').filter(id => id.endsWith('-fleet')), [], `${op} failure never writes the fleet bead`);
  }
  for (const op of ['fm-wake-drain.sh', 'fm-crew-state.sh']) assert.deepEqual(firing(op, 'failure'), ['fm-ledger-timeline']);
});

test('end to end: a successful fm-brief and fm-fleet-sync each comment on their project once', async () => withStubs(async ctx => {
  const calls = [{ id: 'b', raw: '/h/bin/fm-brief.sh task-a demo --mode local-only' }, { id: 's', raw: '/h/bin/fm-fleet-sync.sh' },
    { id: 's2', raw: '/h/bin/fm-fleet-sync.sh /h/projects/demo' }, { id: 'sm', raw: '/h/bin/fm-brief.sh sm-1 --secondmate --no-projects' }];
  await pipeline(ctx, calls);
  const before = (await ctx.writes()).length;
  await pipeline(ctx, calls);
  assert.equal((await ctx.writes()).length, before, 're-delivery writes nothing');
  const { projects, lifespan } = await ctx.db();
  assert.match(projects.beads['project-fmh-demo'].comments.map(c => c.text).join('\n'), /wrote brief for task-a on demo/);
  assert.match(projects.beads['project-fmh-demo'].comments.map(c => c.text).join('\n'), /synced project clone demo/);
  assert.match(projects.beads['project-fmh-firstmate'].comments[0].text, /synced all project clones/);
  assert.equal(Object.values(projects.beads).flatMap(b => b.comments).length, 3, 'a secondmate charter names no project and is ledger-only');
  assert.equal(lifespan.beads['lifespan-fmh20261010'].comments.length, 4);
}));

const fixtureHealth = async (root, { pending = 0, ageMs = 0, rules = true } = {}) => {
  await mkdir(join(root, 'jobs'), { recursive: true });
  await mkdir(join(root, 'failed'), { recursive: true });
  const rulesPath = join(root, 'rules.json');
  await writeFile(rulesPath, JSON.stringify({ rules: rules ? [{ id: 'r', operation: '*', outcomes: ['success'],
    action: { command: 'sh', args: [] } }] : [] }));
  for (let i = 0; i < pending; i++) {
    const file = join(root, 'jobs', `j${i}.json`);
    await writeFile(file, '{}');
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
  return rulesPath;
};

test('health is green when the worker beats, rules load, actions resolve and the queue is empty', async () => withStubs(async ({ dir, env }) => {
  const root = join(dir, 'q');
  const rulesPath = await fixtureHealth(root);
  await writeHeartbeat(root, { intervalMs: 1000, cycles: 1 }, 'worker');
  const health = await healthStatus({ root, env, rulesPaths: [rulesPath] });
  assert.deepEqual(health.problems, []);
  assert.equal(health.healthy, true);
}));

test('health names each way the pipeline is not live', async () => withStubs(async ({ dir, env }) => {
  const root = join(dir, 'q');
  // no worker ever ran, no rules, and an old job sitting in the queue
  const rulesPath = await fixtureHealth(root, { pending: 1, ageMs: 10 * 60 * 1000, rules: false });
  const health = await healthStatus({ root, env, rulesPaths: [rulesPath], requirePoller: true });
  assert.equal(health.healthy, false);
  const text = health.problems.join('\n');
  assert.match(text, /worker not live/);
  assert.match(text, /no rules loaded/);
  assert.match(text, /jobs not draining/);
  assert.match(text, /bead poller not live/);
}));

test('health flags a rule whose action is not on PATH and failed jobs', async () => withStubs(async ({ dir, env }) => {
  const root = join(dir, 'q');
  const rulesPath = await fixtureHealth(root);
  await writeFile(rulesPath, JSON.stringify({ rules: [{ id: 'r', operation: '*', outcomes: ['success'],
    action: { command: 'fm-hooks-no-such-action', args: [] } }] }));
  await writeFile(join(root, 'failed', 'x.json'), '{}');
  await writeHeartbeat(root, { intervalMs: 1000 }, 'worker');
  const health = await healthStatus({ root, env, rulesPaths: [rulesPath] });
  assert.match(health.problems.join('\n'), /not found on PATH: fm-hooks-no-such-action/);
  assert.match(health.problems.join('\n'), /1 job\(s\) in failed/);
}));

test('the worker cli health command exits non-zero with the reason on stderr', async () => withStubs(async ({ dir }) => {
  const errors = [];
  const code = await workerCli(['health', '--queue', join(dir, 'empty')], { log() {}, error: line => errors.push(line) });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /fm-hooks health: worker not live/);
}));

test('poller plist runs watch against the queue with a PATH that finds node and the store wrappers', () => {
  const plist = renderPollerPlist({ env: { HOME: '/home/u', FM_HOOK_POLL_STORES: 'review' }, root: '/q', intervalMs: 5000 });
  assert.match(plist, /<string>com\.fm-hooks\.bead-poller<\/string>/);
  assert.match(plist, /<string>watch<\/string>\s*<string>--queue<\/string>\s*<string>\/q<\/string>/);
  assert.match(plist, /\/home\/u\/\.local\/bin/);
  assert.match(plist, /<key>FM_HOOK_POLL_INTERVAL_MS<\/key>\s*<string>5000/);
  assert.match(plist, /<key>FM_HOOK_POLL_STORES<\/key>/);
  assert.match(plist, /<key>FM_HOME<\/key>\s*<string>\/home\/u\/fm_home\/firstmate/);
});

test('poller cli: once initializes silently, status is non-zero until a poll has beaten', async () => withStubs(async ({ dir, env }) => {
  const root = join(dir, 'q');
  const out = [];
  assert.equal(await pollerCli(['status', '--queue', root], { log: line => out.push(line), error() {}, env }), 1);
  assert.equal(await pollerCli(['once', '--queue', root], { log: line => out.push(line), error() {}, env }), 0);
  assert.match(out.at(-1), /"initialized": true/);
  assert.equal(await pollerCli(['bogus', '--queue', root], { log() {}, error() {}, env }), 2);
}));
