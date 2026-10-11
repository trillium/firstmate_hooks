import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, rename, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storeRunner } from '../src/bead-actions.ts';
import { forgetEnsuredStores } from '../src/fleet-beads.ts';
import { parseStatusLine, readStatusCursor, tailStatusOnce } from '../src/status-tail.ts';
import { main as pollerCli } from '../bin/fm-hooks-bead-poller.ts';
import { watchPoller } from '../src/bead-poller.ts';
import { withStubs } from '../testlib/stub-env.ts';

const setup = async env => { await mkdir(join(env.FM_HOME, 'state'), { recursive: true }); forgetEnsuredStores(); };
const statusFile = (env, task) => join(env.FM_HOME, 'state', `${task}.status`);
const tail = env => tailStatusOnce({ root: env.FM_HOOK_QUEUE, env, run: storeRunner(env), now: Date.parse('2026-10-11T12:00:00Z') });
const stateLabels = (db, task) => db.fleet.beads[`fleet-${task}`].labels.filter(l => l.startsWith('fm-state:'));

test('parseStatusLine reads state, timestamp and key; malformed and unknown lines are null', () => {
  assert.deepEqual(parseStatusLine('needs-decision [at=1791626400] [key=pick-db]: which db?'),
    { state: 'needs-decision', at: 1791626400, key: 'pick-db', text: 'which db?' });
  assert.equal(parseStatusLine('working: no stamp').at, null);
  assert.equal(parseStatusLine('just some prose'), null);
  assert.equal(parseStatusLine('exploded [at=1]: x'), null);
});

test('the first run never backfills; lines appended afterwards land once each', async () => withStubs(async ({ env, db, writes }) => {
  await setup(env);
  await writeFile(statusFile(env, 'task-a'), 'working [at=1791600000]: old history\ndone [at=1791600100]: older\n');
  const first = await tail(env);
  assert.equal(first.initialized, true);
  assert.deepEqual(await writes(), [], 'history is not written');
  await appendFile(statusFile(env, 'task-a'), 'blocked [at=1791626400]: need a key\nworking [at=1791626500]: unblocked\n');
  const second = await tail(env);
  assert.equal(second.recorded.length, 2);
  const bead = (await db()).fleet.beads['fleet-task-a'];
  assert.equal(bead.comments.length, 2);
  assert.match(bead.comments[0].text, /status blocked: need a key/);
  assert.deepEqual(stateLabels(await db(), 'task-a'), ['fm-state:working']);
  const third = await tail(env);
  assert.deepEqual(third.recorded, []);
}));

test('a restart with the same cursor appends nothing, and a lost cursor does not duplicate comments', async () => withStubs(async ({ env, db }) => {
  await setup(env);
  await writeFile(statusFile(env, 't'), '');
  await tail(env);
  await appendFile(statusFile(env, 't'), 'working [at=1791626400]: go\n');
  await tail(env);
  await rename(join(env.FM_HOOK_QUEUE, 'status-tail', 'cursor.json'), join(env.FM_HOOK_QUEUE, 'status-tail', 'cursor.bak'));
  // no cursor: counts as a first run again, so nothing is re-read -- and even a forced re-read is deduplicated by cid
  await tail(env);
  assert.equal((await db()).fleet.beads['fleet-t'].comments.length, 1);
}));

test('a new status file appearing after the first run is read from its start', async () => withStubs(async ({ env, db }) => {
  await setup(env);
  await tail(env);
  await writeFile(statusFile(env, 'fresh'), 'working [at=1791626400]: setup\n');
  await tail(env);
  assert.equal((await db()).fleet.beads['fleet-fresh'].comments.length, 1);
}));

test('a shorter file restarts at zero; a partial trailing line waits for its newline', async () => withStubs(async ({ env, db }) => {
  await setup(env);
  await writeFile(statusFile(env, 't'), 'working [at=1791626400]: a long first line to shrink away from\n');
  await tail(env);
  await truncate(statusFile(env, 't'), 0);
  await appendFile(statusFile(env, 't'), 'working [at=1791626500]: b\ndone [at=1791626600]: par');
  await tail(env);
  let bead = (await db()).fleet.beads['fleet-t'];
  assert.equal(bead.comments.length, 1, 'the partial line is not read yet');
  await appendFile(statusFile(env, 't'), 'tial\n');
  await tail(env);
  bead = (await db()).fleet.beads['fleet-t'];
  assert.equal(bead.comments.length, 2);
  assert.match(bead.comments[1].text, /status done: partial/);
  assert.deepEqual(stateLabels(await db(), 't'), ['fm-state:done']);
}));

test('malformed lines are skipped; resolved comments but leaves the state alone', async () => withStubs(async ({ env, db }) => {
  await setup(env);
  await writeFile(statusFile(env, 't'), '');
  await tail(env);
  await appendFile(statusFile(env, 't'), 'garbage line\nblocked [at=1791626400] [key=k]: stuck\nresolved [at=1791626500] [key=k]: cleared\n');
  await tail(env);
  const bead = (await db()).fleet.beads['fleet-t'];
  assert.equal(bead.comments.length, 2);
  assert.match(bead.comments[1].text, /status resolved \[key=k\]: cleared/);
  assert.deepEqual(stateLabels(await db(), 't'), ['fm-state:blocked']);
}));

test('a store failure holds the cursor at the failed line so the next cycle retries it', async () => withStubs(async ({ env, db }) => {
  await setup(env);
  await writeFile(statusFile(env, 't'), '');
  await tail(env);
  await appendFile(statusFile(env, 't'), 'working [at=1791626400]: one\n');
  const broken = await tailStatusOnce({ root: env.FM_HOOK_QUEUE, env: { ...env, STUB_FAIL: 'fleet:create' }, run: storeRunner({ ...env, STUB_FAIL: 'fleet:create' }) });
  assert.equal(broken.failed.length, 1);
  assert.equal((await readStatusCursor(env.FM_HOOK_QUEUE)).t.offset, 0);
  forgetEnsuredStores();
  await tail(env);
  assert.equal((await db()).fleet.beads['fleet-t'].comments.length, 1);
}));

test('the CLI status-tail --once runs one pass; the watch loop tails each cycle unless disabled', async () => withStubs(async ({ env, db }) => {
  await setup(env);
  await writeFile(statusFile(env, 't'), '');
  const out = [];
  assert.equal(await pollerCli(['status-tail', '--once', '--queue', env.FM_HOOK_QUEUE], { env, log: l => out.push(l), error() {} }), 0);
  assert.equal(await pollerCli(['status-tail', '--queue', env.FM_HOOK_QUEUE], { env, log() {}, error() {} }), 2);
  await appendFile(statusFile(env, 't'), 'working [at=1791626400]: via loop\n');
  const state = await watchPoller({ root: env.FM_HOOK_QUEUE, env, relay: async () => ({ via: 'note' }), intervalMs: 5, maxCycles: 1, onResult() {} });
  assert.equal(state.statusLines, 1);
  assert.equal((await db()).fleet.beads['fleet-t'].comments.length, 1);
  await appendFile(statusFile(env, 't'), 'done [at=1791626500]: x\n');
  await watchPoller({ root: env.FM_HOOK_QUEUE, env: { ...env, FM_HOOK_STATUS_TAIL: '0' }, relay: async () => ({ via: 'note' }), intervalMs: 5, maxCycles: 1, onResult() {} });
  assert.equal((await db()).fleet.beads['fleet-t'].comments.length, 1, 'disabled tail writes nothing');
}));
