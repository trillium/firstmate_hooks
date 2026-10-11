import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBeadAction, callArgs, describeCall } from '../src/bead-actions.ts';
import { main as actionCli } from '../bin/fm-hooks-bead-action.ts';
import { withStubs } from '../testlib/stub-env.ts';

async function recordEvent(env, partial) {
  const event = { operation: 'fm-spawn.sh', args: [], rawCommand: 'x', cwd: '/tmp', harness: 'claude', sessionId: 'abcdef123456',
    outcome: 'success', startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:01.000Z',
    correlationId: 'c0ffee'.repeat(10) + 'abcd', ...partial };
  await mkdir(join(env.FM_HOOK_QUEUE, 'events'), { recursive: true });
  await writeFile(join(env.FM_HOOK_QUEUE, 'events', `${event.correlationId}-${event.operation}.json`), JSON.stringify(event));
  return event;
}
const act = (event, kind, env) => runBeadAction({ kind, operation: event.operation, correlationId: event.correlationId, env, root: env.FM_HOOK_QUEUE });

test('callArgs stops at shell pipeline residue', () => {
  assert.deepEqual(callArgs({ args: ['t', 'p', '--mode', 'x', '2>&1', '|', 'tail', '-4'] }), ['t', 'p', '--mode', 'x']);
});

test('describeCall ignores help and read-only subcommands', async () => {
  assert.equal(await describeCall({ operation: 'fm-spawn.sh', args: ['--help'] }), null);
  assert.equal(await describeCall({ operation: 'fm-branch-outcome.sh', args: ['lookup', '--seqs', '3'] }), null);
  assert.equal(await describeCall({ operation: 'fm-captain-hold.sh', args: ['open', 't'] }), null);
});

test('ledger appends one timeline line per correlation id, however often it is delivered', async () => withStubs(async ({ env, writes, db }) => {
  const event = await recordEvent(env, { args: ['task-a', '/x/projects/demo'] });
  const first = await act(event, 'ledger', env);
  const second = await act(event, 'ledger', env);
  assert.equal(first.wrote, true);
  assert.equal(second.wrote, false, 're-delivery must not append a second line');
  assert.equal(first.target, 'lifespan-fmh20261010');
  const bead = (await db()).lifespan.beads['lifespan-fmh20261010'];
  assert.equal(bead.comments.length, 1);
  assert.match(bead.comments[0].text, /fm-spawn\.sh success claude\/abcdef12 task-a/);
  assert.equal((await writes()).filter(c => c.argv[0] === 'create').length, 1, 'container created once');
  // a different call lands on the same day container as a second line
  const other = await recordEvent(env, { correlationId: 'f'.repeat(64), args: ['task-b', '/x/projects/demo'] });
  await act(other, 'ledger', env);
  assert.equal((await db()).lifespan.beads['lifespan-fmh20261010'].comments.length, 2);
}));

test('spawn success comments on an existing project bead exactly once', async () => withStubs(async ({ env, db }) => {
  const event = await recordEvent(env, { args: ['task-a', '/home/x/projects/demo', '--mode', 'direct-PR', '2>&1', '|', 'tail'] });
  // a curated project bead already exists
  await (await import('node:fs/promises')).writeFile(env.STUB_DB, JSON.stringify({ projects: { beads: {
    'project-9': { id: 'project-9', title: 'demo', labels: ['project:demo'], status: 'open', comments: [] } } } }));
  const first = await act(event, 'project-comment', env);
  const again = await act(event, 'project-comment', env);
  assert.equal(first.target, 'project-9');
  assert.equal(first.wrote, true);
  assert.equal(again.wrote, false);
  const comments = (await db()).projects.beads['project-9'].comments;
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /dispatched task-a on demo/);
}));

test('a project with no bead gets one minted deterministically, then reused', async () => withStubs(async ({ env, db }) => {
  const one = await recordEvent(env, { args: ['task-a', '/home/x/projects/newproj'] });
  const two = await recordEvent(env, { correlationId: 'a'.repeat(64), args: ['task-b', '/home/x/projects/newproj'] });
  await act(one, 'project-comment', env);
  await act(one, 'project-comment', env);
  await act(two, 'project-comment', env);
  const beads = (await db()).projects.beads;
  assert.deepEqual(Object.keys(beads), ['project-fmh-newproj']);
  assert.equal(beads['project-fmh-newproj'].comments.length, 2);
  assert.ok(beads['project-fmh-newproj'].labels.includes('project:newproj'));
}));

test('merge success resolves the project through the task meta file', async () => withStubs(async ({ env, db }) => {
  await mkdir(join(env.FM_HOME, 'state'), { recursive: true });
  await writeFile(join(env.FM_HOME, 'state', 'task-m.meta'), 'project=/h/projects/massage\npr=https://example.test/pull/1\n');
  const event = await recordEvent(env, { operation: 'fm-pr-merge.sh', args: ['task-m', 'https://example.test/pull/1'] });
  const result = await act(event, 'project-comment', env);
  assert.equal(result.target, 'project-fmh-massage');
  assert.match((await db()).projects.beads['project-fmh-massage'].comments[0].text, /merged PR for task-m: https:\/\/example\.test\/pull\/1/);
  const local = await recordEvent(env, { operation: 'fm-merge-local.sh', correlationId: 'b'.repeat(64), args: ['task-m'] });
  await act(local, 'project-comment', env);
  assert.match((await db()).projects.beads['project-fmh-massage'].comments[1].text, /landed task-m on local main/);
}));

test('an unresolvable project is a visible skip, not a write or a failure', async () => withStubs(async ({ env, writes }) => {
  const event = await recordEvent(env, { operation: 'fm-merge-local.sh', args: ['ghost-task'] });
  assert.match((await act(event, 'project-comment', env)).skipped, /no project resolvable/);
  assert.deepEqual(await writes(), []);
}));

test('branch outcome with verdict captain also files one review item; routine does not', async () => withStubs(async ({ env, db }) => {
  await mkdir(join(env.FM_HOME, 'state'), { recursive: true });
  await writeFile(join(env.FM_HOME, 'state', 't1.meta'), 'project=/h/projects/demo\n');
  const captain = await recordEvent(env, { operation: 'fm-branch-outcome.sh',
    args: ['append', '--task', 't1', '--verdict', 'captain', '--summary', 'needs a look'] });
  await act(captain, 'project-comment', env);
  await act(captain, 'project-comment', env);
  const routine = await recordEvent(env, { operation: 'fm-branch-outcome.sh', correlationId: 'd'.repeat(64),
    args: ['append', '--task', 't1', '--verdict', 'routine', '--summary', 'ok'] });
  await act(routine, 'project-comment', env);
  const state = await db();
  const reviews = (Object.values(state.review.beads) as any[]);
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].labels.includes('fm-task:t1'));
  assert.equal(state.projects.beads['project-fmh-demo'].comments.length, 2);
}));

test('captain hold files one human-labelled review bead carrying the resolve key', async () => withStubs(async ({ env, db }) => {
  const event = await recordEvent(env, { operation: 'fm-captain-hold.sh',
    args: ['hold', 'task-h', '--reason', 'pick a db', '--title', 'T'] });
  const first = await act(event, 'captain-hold', env);
  const again = await act(event, 'captain-hold', env);
  assert.equal(first.wrote, true);
  assert.equal(again.wrote, false);
  assert.equal(first.key, 'captain-hold-task-h-1');
  const beads = (Object.values((await db()).review.beads) as any[]);
  assert.equal(beads.length, 1);
  assert.ok(beads[0].labels.includes('human'));
  assert.ok(beads[0].labels.includes('fm-key:captain-hold-task-h-1'));
  assert.ok(beads[0].labels.includes('fm-task:task-h'));
  // a second hold on the same task is a new bead with the next occurrence key
  const rehold = await recordEvent(env, { operation: 'fm-captain-hold.sh', correlationId: 'e'.repeat(64),
    args: ['hold', 'task-h', '--reason', 'again'] });
  assert.equal((await act(rehold, 'captain-hold', env)).key, 'captain-hold-task-h-2');
}));

test('a hold subcommand other than hold writes nothing', async () => withStubs(async ({ env, writes }) => {
  const event = await recordEvent(env, { operation: 'fm-captain-hold.sh', args: ['answer', 'task-h', '--decision-file', 'f'] });
  assert.ok((await act(event, 'captain-hold', env)).skipped);
  assert.deepEqual(await writes(), []);
}));

test('a store failure propagates so the job lands in failed/ instead of vanishing', async () => withStubs(async ({ env }) => {
  const event = await recordEvent(env, { args: ['task-a', '/x/projects/demo'] });
  await assert.rejects(act(event, 'ledger', { ...env, STUB_FAIL: 'lifespan:create' }));
  const errors = [];
  const code = await actionCli(['ledger', event.operation, event.correlationId], { env: { ...env, STUB_FAIL: 'lifespan:create' },
    log() {}, error: line => errors.push(line) });
  assert.equal(code, 1);
  assert.match(errors[0], /fm-hooks-bead-action/);
  assert.equal(await actionCli(['bogus'], { env, log() {}, error() {} }), 2);
}));

test('the store runner survives output larger than the default 1MB buffer', async () => {
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { storeRunner } = await import('../src/bead-actions.ts');
  const dir = await mkdtemp(join(tmpdir(), 'big-store-'));
  const bin = join(dir, 'big');
  await writeFile(bin, '#!/bin/sh\nhead -c 3000000 /dev/zero | tr "\\0" x\n');
  await chmod(bin, 0o755);
  const out = storeRunner({ ...process.env, FM_HOOK_BIG_BIN: bin })('big', []);
  assert.equal(out.length, 3000000);
});
