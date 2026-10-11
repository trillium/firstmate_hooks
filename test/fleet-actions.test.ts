import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBeadAction } from '../src/bead-actions.ts';
import { ensureFleetStore, forgetEnsuredStores, resolveTask } from '../src/fleet-beads.ts';
import { withStubs } from '../testlib/stub-env.ts';

let counter = 0;
async function recordEvent(env, partial) {
  const event = { operation: 'fm-spawn.sh', args: [], rawCommand: 'x', cwd: '/tmp', harness: 'claude', sessionId: 'abcdef123456',
    outcome: 'success', startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:01.000Z',
    correlationId: String(++counter).padStart(8, '0').repeat(8), ...partial };
  await mkdir(join(env.FM_HOOK_QUEUE, 'events'), { recursive: true });
  await writeFile(join(env.FM_HOOK_QUEUE, 'events', `${event.correlationId}-${event.operation}.json`), JSON.stringify(event));
  return event;
}
const act = (event, kind, env) => runBeadAction({ kind, operation: event.operation, correlationId: event.correlationId, env, root: env.FM_HOOK_QUEUE });
const fleet = async db => (await db()).fleet.beads;
const meta = (env, task, text) => mkdir(join(env.FM_HOME, 'state'), { recursive: true }).then(() => writeFile(join(env.FM_HOME, 'state', `${task}.meta`), text));

test('brief creates the fleet bead with its labels and a briefed state', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  const event = await recordEvent(env, { operation: 'fm-brief.sh', args: ['task-a', '/h/projects/demo', '--scout'] });
  const result = await act(event, 'fleet', env);
  assert.equal(result.target, 'fleet-task-a');
  const bead = (await fleet(db))['fleet-task-a'];
  for (const label of ['fm-hooks', 'fm-task:task-a', 'project:demo', 'fm-kind:scout', 'fm-state:briefed']) assert.ok(bead.labels.includes(label), label);
  assert.equal(bead.title, 'task-a (scout, demo)');
  assert.ok((await fleet(db))['fleet-charter'], 'the charter bead exists');
}));

test('spawn adds a comment and swaps the state; a repeated job writes one comment', async () => withStubs(async ({ env, db, writes }) => {
  forgetEnsuredStores();
  await meta(env, 'task-a', 'project=/h/projects/demo\nharness=claude\nmodel=opus\nbackend=herdr\n');
  await act(await recordEvent(env, { operation: 'fm-brief.sh', args: ['task-a', '/h/projects/demo'] }), 'fleet', env);
  const spawn = await recordEvent(env, { args: ['task-a', '/h/projects/demo', '--mode', 'local-only'] });
  const first = await act(spawn, 'fleet', env);
  const again = await act(spawn, 'fleet', env);
  assert.equal(first.wrote, true);
  assert.equal(again.wrote, false);
  const bead = (await fleet(db))['fleet-task-a'];
  assert.equal(bead.comments.length, 2);
  assert.match(bead.comments[1].text, /dispatched task-a on demo harness=claude model=opus backend=herdr/);
  assert.deepEqual(bead.labels.filter(l => l.startsWith('fm-state:')), ['fm-state:dispatched']);
  const before = (await writes()).length;
  await act(spawn, 'fleet', env);
  assert.equal((await writes()).length, before, 'a third delivery writes nothing at all');
}));

test('spawn retitles from the filled-in brief, never from an unfilled placeholder', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  await mkdir(join(env.FM_HOME, 'data', 'task-a'), { recursive: true });
  const brief = join(env.FM_HOME, 'data', 'task-a', 'brief.md');
  await writeFile(brief, "# Brief\n## Captain's intent\n{TASK}\n");
  const spawn = await recordEvent(env, { args: ['task-a', '/h/projects/demo'] });
  await act(spawn, 'fleet', env);
  assert.equal((await fleet(db))['fleet-task-a'].title, 'task-a (task, demo)');
  await writeFile(brief, "# Brief\n## Captain's intent\nAdd the fleet store\n");
  await act(spawn, 'fleet', env);
  assert.equal((await fleet(db))['fleet-task-a'].title, 'task-a: Add the fleet store');
}));

test('a spawn whose task is a shell variable resolves from stdout, then from a meta record in the call window', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  const fromStdout = await recordEvent(env, { args: ['$id', '/h/projects/demo'], resultMetadata: { stdout: 'noise\nspawned task-s harness=pi model=x\n' } });
  assert.equal((await act(fromStdout, 'fleet', env)).target, 'fleet-task-s');
  await meta(env, 'task-p', 'project=/h/projects/demo\n');
  await meta(env, 'task-old', 'project=/h/projects/demo\n');
  await utimes(join(env.FM_HOME, 'state', 'task-old.meta'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  const now = new Date('2026-10-10T10:00:00.500Z');
  await utimes(join(env.FM_HOME, 'state', 'task-p.meta'), now, now);
  const pi = await recordEvent(env, { harness: 'pi', args: ['$id', '/h/projects/demo'] });
  const resolved = await resolveTask(pi, env);
  assert.deepEqual(resolved, { task: 'task-p', source: 'record' });
  await utimes(join(env.FM_HOME, 'state', 'task-old.meta'), now, now);
  assert.equal((await resolveTask(pi, env)).source, 'unresolved', 'two records in the window is ambiguous and never guessed');
  const skipped = await act(pi, 'fleet', env);
  assert.equal(skipped.skipped, 'unresolved');
  assert.ok(!(await fleet(db))['fleet-task-old']);
}));

test('promote flips fm-kind, control exit stops, merge marks merged', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  await act(await recordEvent(env, { operation: 'fm-brief.sh', args: ['t', '/h/projects/demo', '--scout'] }), 'fleet', env);
  await act(await recordEvent(env, { operation: 'fm-promote.sh', args: ['t', '--mode', 'local-only', '--yolo', 'on'] }), 'fleet', env);
  let bead = (await fleet(db))['fleet-t'];
  assert.ok(bead.labels.includes('fm-kind:ship') && !bead.labels.includes('fm-kind:scout'));
  assert.ok(bead.labels.includes('fm-mode:local-only'));
  assert.match(bead.comments.at(-1).text, /promoted scout→ship mode=local-only yolo=on/);
  await act(await recordEvent(env, { operation: 'fm-control.sh', args: ['t', 'exit'] }), 'fleet', env);
  assert.ok((await fleet(db))['fleet-t'].labels.includes('fm-state:stopped'));
  await act(await recordEvent(env, { operation: 'fm-merge-local.sh', args: ['t'] }), 'fleet', env);
  bead = (await fleet(db))['fleet-t'];
  assert.ok(bead.labels.includes('fm-state:merged'));
  assert.match(bead.comments.at(-1).text, /landed t on local main/);
}));

test('teardown closes the bead and tolerates a missing meta file', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  await act(await recordEvent(env, { operation: 'fm-brief.sh', args: ['t', '/h/projects/demo'] }), 'fleet', env);
  const down = await recordEvent(env, { operation: 'fm-teardown.sh', args: ['t'] });
  const first = await act(down, 'fleet', env);
  const again = await act(down, 'fleet', env);
  assert.equal(first.closed, true);
  assert.equal(again.closed, undefined);
  const bead = (await fleet(db))['fleet-t'];
  assert.equal(bead.status, 'closed');
  assert.ok(bead.labels.includes('fm-state:cleaned-up'));
  assert.ok(bead.labels.includes('project:demo'), 'project survives from the bead, not the gone meta');
  // a teardown for a task never seen still leaves a closed record
  await act(await recordEvent(env, { operation: 'fm-teardown.sh', args: ['ghost'] }), 'fleet', env);
  assert.equal((await fleet(db))['fleet-ghost'].status, 'closed');
}));

test('a re-briefed task reopens its closed bead', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  await act(await recordEvent(env, { operation: 'fm-brief.sh', args: ['t', '/h/projects/demo'] }), 'fleet', env);
  await act(await recordEvent(env, { operation: 'fm-teardown.sh', args: ['t'] }), 'fleet', env);
  await act(await recordEvent(env, { operation: 'fm-brief.sh', args: ['t', '/h/projects/demo'] }), 'fleet', env);
  assert.equal((await fleet(db))['fleet-t'].status, 'open');
}));

test('steer lines land on the target bead with the resolved keys; a shell-variable text reads the inbox record', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  const send = await recordEvent(env, { operation: 'fm-send.sh', args: ['t', '--resolve-key', 'k1', 'use postgres'] });
  await act(send, 'fleet', env);
  assert.match((await fleet(db))['fleet-t'].comments[0].text, /steer → t: use postgres resolves \[key=k1\]/);
  const inbox = join(env.FM_HOME, 'state', 'u.inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, '001.msg'), 'at=1791626400\nship it now\n');
  const when = new Date('2026-10-10T10:00:00.200Z');
  await utimes(join(inbox, '001.msg'), when, when);
  await act(await recordEvent(env, { operation: 'fm-send.sh', args: ['u', '$MSG'] }), 'fleet', env);
  assert.match((await fleet(db))['fleet-u'].comments[0].text, /steer → u: ship it now/);
}));

test('captain-hold complete is recorded on the origin task; verify and open are not fleet calls', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  await act(await recordEvent(env, { operation: 'fm-captain-hold.sh', args: ['complete', 'o', '--none'] }), 'fleet', env);
  assert.match((await fleet(db))['fleet-o'].comments[0].text, /captain-call inventory complete \(--none\)|captain-call inventory complete \(none\)/);
  const skip = await act(await recordEvent(env, { operation: 'fm-captain-hold.sh', args: ['verify', 'o'] }), 'fleet', env);
  assert.ok(skip.skipped);
}));

test('hold answer closes the open review bead, marks it fm-hooks-closed, and records it on the fleet bead', async () => withStubs(async ({ env, db }) => {
  forgetEnsuredStores();
  await act(await recordEvent(env, { operation: 'fm-captain-hold.sh', args: ['hold', 'h', '--reason', 'pick'] }), 'captain-hold', env);
  await mkdir(env.FM_HOME, { recursive: true });
  const decision = join(env.FM_HOME, 'decision.md');
  await writeFile(decision, 'go with sqlite\n');
  const answer = await recordEvent(env, { operation: 'fm-captain-hold.sh', args: ['answer', 'h', '--decision-file', decision] });
  const result = await act(answer, 'captain-hold', env);
  const again = await act(answer, 'captain-hold', env);
  assert.equal(result.closed.length, 1);
  assert.ok(again.skipped, 'no open hold left on replay');
  const review = (Object.values((await db()).review.beads) as any[])[0];
  assert.equal(review.status, 'closed');
  assert.ok(review.labels.includes('fm-closed-by:fm-hooks'));
  assert.match(review.comments[0].text, /go with sqlite/);
  await act(answer, 'fleet', env);
  assert.match((await fleet(db))['fleet-h'].comments[0].text, /captain answered hold/);
}));

test('the store is detected, created when missing, and creation is skipped when disabled', () => {
  forgetEnsuredStores();
  const calls = [];
  let exists = false;
  const run = (store, args) => {
    calls.push([store, ...args]);
    if (store === 'fleet' && args[0] === 'list' && !exists) throw new Error('no such store');
    if (store === 'brain') { exists = true; return ''; }
    if (args[0] === 'show') throw new Error('not found');
    return '';
  };
  assert.equal(ensureFleetStore(run, { FM_HOOK_FLEET_BIN: 'a' }), true);
  assert.deepEqual(calls.find(c => c[0] === 'brain'), ['brain', 'stores', 'create', 'fleet']);
  assert.ok(calls.some(c => c.includes('fleet-charter') && c.includes('create')));
  const second = calls.length;
  assert.equal(ensureFleetStore(run, { FM_HOOK_FLEET_BIN: 'a' }), false);
  assert.equal(calls.length, second, 'memoized once ensured');
  forgetEnsuredStores();
  assert.throws(() => ensureFleetStore(() => { throw new Error('ENOENT'); }, { FM_HOOK_FLEET_AUTOCREATE: '0' }), /brain stores create fleet/);
  forgetEnsuredStores();
  assert.equal(ensureFleetStore((s, a) => { if (s === 'fleet' && a[0] === 'list') return '[]'; if (a[0] === 'show') throw new Error('nf'); return ''; }, {}), false);
});

test('a fleet store failure propagates so the job lands in failed/', async () => withStubs(async ({ env }) => {
  forgetEnsuredStores();
  const event = await recordEvent(env, { operation: 'fm-brief.sh', args: ['t', '/h/projects/demo'] });
  await assert.rejects(act(event, 'fleet', { ...env, STUB_FAIL: 'fleet:create', FM_HOOK_FLEET_AUTOCREATE: '0' }));
}));
