import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBeadAction } from '../src/bead-actions.js';
import { main as mergeCli } from '../bin/fm-hooks-project-merge.js';
import { withStubs } from '../testlib/stub-env.js';

const bead = (id, title, labels, extra = {}) => ({ id, title, labels, status: 'open', comments: [], ...extra });
const seed = (env, beads) => writeFile(env.STUB_DB, JSON.stringify({ projects: { beads: Object.fromEntries(beads.map(b => [b.id, b])) } }));

async function recordEvent(env, partial) {
  const event = { operation: 'fm-spawn.sh', args: [], rawCommand: 'x', cwd: '/tmp', harness: 'claude', sessionId: 'abcdef123456',
    outcome: 'success', startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:01.000Z',
    correlationId: 'c0ffee'.repeat(10) + 'abcd', ...partial };
  await mkdir(join(env.FM_HOOK_QUEUE, 'events'), { recursive: true });
  await writeFile(join(env.FM_HOOK_QUEUE, 'events', `${event.correlationId}-${event.operation}.json`), JSON.stringify(event));
  return event;
}
const act = (event, env) => runBeadAction({ kind: 'project-comment', operation: event.operation, correlationId: event.correlationId, env, root: env.FM_HOOK_QUEUE });

test('a label differing only in case resolves to the real bead instead of minting', async () => withStubs(async ({ env, db }) => {
  await seed(env, [bead('project-28n', 'VRMS', ['project:vrms'])]);
  const event = await recordEvent(env, { args: ['task-a', '/home/x/projects/VRMS'] });
  const first = await act(event, env);
  const again = await act(event, env);
  assert.equal(first.target, 'project-28n');
  assert.equal(first.wrote, true);
  assert.equal(again.wrote, false, 're-delivery stays idempotent');
  const beads = (await db()).projects.beads;
  assert.deepEqual(Object.keys(beads), ['project-28n']);
  assert.equal(beads['project-28n'].comments.length, 1);
}));

test('the registry name is tried when the call names a clone directory', async () => withStubs(async ({ env, db }) => {
  await mkdir(join(env.FM_HOME, 'data'), { recursive: true });
  await writeFile(join(env.FM_HOME, 'data', 'projects.md'), '- Handy [direct-PR] - speech app; clone at projects/handy-clone (added 2026-08-11)\n');
  await seed(env, [bead('project-h1', 'Handy', ['project:Handy'])]);
  const event = await recordEvent(env, { args: ['task-a', '/home/x/projects/handy-clone'] });
  assert.equal((await act(event, env)).target, 'project-h1');
  assert.equal(Object.keys((await db()).projects.beads).length, 1);
}));

test('an exact title match resolves a bead that carries no project label', async () => withStubs(async ({ env }) => {
  await seed(env, [bead('project-t1', 'demo', [])]);
  const event = await recordEvent(env, { args: ['task-a', '/home/x/projects/demo'] });
  assert.equal((await act(event, env)).target, 'project-t1');
}));

test('a curated bead beats a previously minted duplicate', async () => withStubs(async ({ env }) => {
  await seed(env, [bead('project-fmh-vrms', 'vrms', ['fm-hooks', 'project:vrms']), bead('project-28n', 'VRMS', ['project:vrms'])]);
  const event = await recordEvent(env, { args: ['task-a', '/home/x/projects/vrms'] });
  assert.equal((await act(event, env)).target, 'project-28n');
}));

test('the override map wins, and a missing override target falls through', async () => withStubs(async ({ env, dir, db }) => {
  const config = join(dir, 'projects.json');
  env.FM_HOOK_PROJECT_CONFIG = config;
  await writeFile(config, JSON.stringify({ overrides: { 'FM-Hooks': 'project-8tn3', ghost: 'project-nope' } }));
  await seed(env, [bead('project-8tn3', 'Fleet hooks', ['project:other']), bead('project-x', 'fm-hooks', ['project:fm-hooks'])]);
  const hooks = await recordEvent(env, { args: ['task-a', '/home/x/projects/fm-hooks'] });
  assert.equal((await act(hooks, env)).target, 'project-8tn3');
  const ghost = await recordEvent(env, { correlationId: 'a'.repeat(64), args: ['task-b', '/home/x/projects/ghost'] });
  assert.equal((await act(ghost, env)).target, 'project-fmh-ghost', 'nothing else names it, so it is minted');
  assert.ok((await db()).projects.beads['project-fmh-ghost']);
}));

test('the shipped config has no overrides', async () => withStubs(async ({ env }) => {
  const shipped = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/fm-hooks.projects.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.overrides, {});
}));

const dupState = env => seed(env, [
  bead('project-28n', 'VRMS', ['project:vrms'], { comments: [{ text: 'old curated note' }, { text: 'fm-hooks: dispatched a [cid:aaaaaaaaaaaaaaaa]' }] }),
  bead('project-fmh-vrms', 'VRMS', ['fm-hooks', 'project:VRMS'], { comments: [
    { text: 'fm-hooks: dispatched a [cid:aaaaaaaaaaaaaaaa]' }, { text: 'fm-hooks: landed b [cid:bbbbbbbbbbbbbbbb]' }] }),
  bead('project-fmh-orphan', 'orphan', ['fm-hooks', 'project:orphan'], { comments: [{ text: 'fm-hooks: x [cid:cccccccccccccccc]' }] }),
]);

test('migration is a dry run by default and writes nothing', async () => withStubs(async ({ env, writes }) => {
  await dupState(env);
  const lines = [];
  const code = await mergeCli([], { env, log: line => lines.push(JSON.parse(line)), error() {} });
  assert.equal(code, 0);
  assert.deepEqual(await writes(), []);
  const vrms = lines.find(l => l.duplicate === 'project-fmh-vrms');
  assert.deepEqual([vrms.target, vrms.comments, vrms.action, vrms.apply], ['project-28n', 1, 'would-merge', false]);
  assert.equal(lines.find(l => l.duplicate === 'project-fmh-orphan').action, 'none');
}));

test('migration --apply moves only missing comments, closes the duplicate with a pointer, and is repeatable', async () => withStubs(async ({ env, db }) => {
  await dupState(env);
  assert.equal(await mergeCli(['--apply'], { env, log() {}, error() {} }), 0);
  const state = (await db()).projects.beads;
  assert.deepEqual(state['project-28n'].comments.map(c => c.text.match(/\[cid:(\w)/)?.[1] ?? 'plain'), ['plain', 'a', 'b']);
  assert.equal(state['project-fmh-vrms'].status, 'closed');
  assert.match(state['project-fmh-vrms'].close_reason, /Duplicate of project-28n/);
  assert.equal(state['project-fmh-orphan'].status, 'open', 'no real bead, so left alone');
  const lines = [];
  await mergeCli(['--apply'], { env, log: line => lines.push(JSON.parse(line)), error() {} });
  assert.equal((await db()).projects.beads['project-28n'].comments.length, 3, 'no duplicate comments on a second run');
  assert.equal(lines.find(l => l.duplicate === 'project-fmh-vrms').action, 'done');
}));

test('migration rejects unknown flags', async () => withStubs(async ({ env }) => {
  const errors = [];
  assert.equal(await mergeCli(['--wat'], { env, log() {}, error: line => errors.push(line) }), 2);
  assert.match(errors[0], /usage/);
}));

test('the project sweep asks the store for all candidate labels in one --label-any call', async () => withStubs(async ({ env }) => {
  await seed(env, [bead('project-a', 'Alpha', ['project:Alpha']), bead('project-b', 'Beta', ['project:Beta'])]);
  const event = await recordEvent(env, { args: ['task-a', '/home/x/projects/Alpha'] });
  assert.equal((await act(event, env)).target, 'project-a');
}));
