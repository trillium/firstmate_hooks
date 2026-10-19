import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBeadAction, storeRunner } from '../src/bead-actions.ts';
import { forgetEnsuredStores } from '../src/fleet-beads.ts';
import { captainCalls, scoutBeadId, scoutDone } from '../src/scout-capture.ts';
import { tailStatusOnce } from '../src/status-tail.ts';
import { withStubs } from '../testlib/stub-env.ts';

const STORES = ['projects', 'review', 'lifespan', 'task', 'brain', 'fleet'];
const REPORT = `# Demo scout (task-d1)

Findings.

## Captain calls
1. Drop the old databases (destructive).
2. Fold \`errors\` into \`robots\`.

## Other
Captain call: pick the retention window
`;

// The done line scout talon-phone-grammar-scout-q2 appended on 2026-10-19 (robots-fkb70), and the Bash
// command the hook observed for it: the `[at=]` stamp is a shell variable the hook saw unexpanded.
const TALON_TASK = 'talon-phone-grammar-scout-q2';
const TALON_ID = 'brain-fmhscout-talon-phone-grammar-scout-q2';
const TALON_LINE = 'report written at data/talon-phone-grammar-scout-q2/report.md; Talon AM+decoder+lexicon shown portable on Mac with real blobs (CoreML 10 ms/utterance, w2ldecode built for iOS arm64, DFA grammar decode verified); iPhone spike and grammar compiler are the remaining work';
const TALON_REPORT = '# Porting Talon\'s speech engine to the iPhone: the how\n\nTask `talon-phone-grammar-scout-q2`, scout report, 2026-10-19.\n\n## Verdict\n\nThe Talon recognizer is portable.\n';
const talonCommand = (home: string, stamp = '$E') => `ls ${home}/state/${TALON_TASK}.inbox/*.msg 2>/dev/null; E=$(date +%s); echo "done [at=${stamp}]: ${TALON_LINE}" >> '${home}/state/${TALON_TASK}.status' && { [ ! -e '${home}/config/fleet-ledger' ] || '${home}/bin/fm-fleet-ledger.sh' appended '${home}/config' '${home}/state/${TALON_TASK}.status' >/dev/null 2>&1 || true; }; tail -1 '${home}/state/${TALON_TASK}.status'`;

async function scoutEvent(env: any, { task = 'demo-scout', line = 'report written at /h/data/demo-scout/report.md; found two things', report = REPORT, correlationId = 'a'.repeat(64), rawCommand = null }: any = {}) {
  const status = join(env.FM_HOME, 'state', `${task}.status`);
  rawCommand ??= `echo "done [at=1791700000]: ${line}" >> '${status}' && { [ ! -e '${env.FM_HOME}/config/fleet-ledger' ] || '${env.FM_HOME}/bin/fm-fleet-ledger.sh' appended '${env.FM_HOME}/config' '${status}' >/dev/null 2>&1 || true; }`;
  const event = { operation: 'fm-fleet-ledger.sh', args: ['appended', `${env.FM_HOME}/config`, status], rawCommand, cwd: '/tmp',
    harness: 'claude', sessionId: 's1', outcome: 'success', finishedAt: '2026-10-11T10:00:01.000Z', correlationId };
  await mkdir(join(env.FM_HOOK_QUEUE, 'events'), { recursive: true });
  await writeFile(join(env.FM_HOOK_QUEUE, 'events', `${correlationId}-${event.operation}.json`), JSON.stringify(event));
  if (report !== null) {
    await mkdir(join(env.FM_HOME, 'data', task), { recursive: true });
    await writeFile(join(env.FM_HOME, 'data', task, 'report.md'), report);
  }
  return event;
}
const act = (event: any, env: any) => runBeadAction({ kind: 'scout-report', operation: event.operation, correlationId: event.correlationId, env, root: env.FM_HOOK_QUEUE });
const seed = (env: any, db: any) => writeFile(env.STUB_DB, JSON.stringify(db));
const bead = (id: string, extra = {}) => ({ id, title: id, labels: [], status: 'open', comments: [], ...extra });
const tail = (env: any) => tailStatusOnce({ root: env.FM_HOOK_QUEUE, env, run: storeRunner(env) });
const statusFile = (env: any, task: string) => join(env.FM_HOME, 'state', `${task}.status`);
async function report(env: any, task: string, text: string) {
  await mkdir(join(env.FM_HOME, 'data', task), { recursive: true });
  await writeFile(join(env.FM_HOME, 'data', task, 'report.md'), text);
}
async function stateDir(env: any) { await mkdir(join(env.FM_HOME, 'state'), { recursive: true }); forgetEnsuredStores(); }

test('scoutDone reads the done line and task from the ledger append, and ignores other status lines', () => {
  const ok = scoutDone({ operation: 'fm-fleet-ledger.sh', args: ['appended', '/c', '/h/state/t-1.status'],
    rawCommand: `echo "done [at=5]: all good; PR https://x/1" >> '/h/state/t-1.status' && true` });
  assert.deepEqual(ok, { task: 't-1', line: 'all good; PR https://x/1', statusPath: '/h/state/t-1.status' });
  assert.equal(scoutDone({ operation: 'fm-fleet-ledger.sh', args: ['appended', '/c', '/h/state/t-1.status'],
    rawCommand: `echo "working [at=5]: x" >> '/h/state/t-1.status'` }), null);
  assert.equal(scoutDone({ operation: 'fm-fleet-ledger.sh', args: ['capture'], rawCommand: 'fm-fleet-ledger.sh capture' }), null);
});

test('captainCalls takes section items and single-line calls, once each', () => {
  assert.deepEqual(captainCalls(REPORT), ['Drop the old databases (destructive).', 'Fold `errors` into `robots`.', 'pick the retention window']);
  assert.deepEqual(captainCalls('# R\n\nNo decision is needed.\n'), []);
  assert.deepEqual(captainCalls('# R\n**Needs captain input:** which effect did they mean?\n'), ['which effect did they mean?']);
});

test('scout done creates one brain bead, links fleet and backlog beads, files captain calls; a repeat writes nothing', async () => withStubs(async ({ env, db, writes }) => {
  await mkdir(join(env.FM_HOME, 'data'), { recursive: true });
  await writeFile(join(env.FM_HOME, 'data', 'backlog.md'), '# Backlog\n\n- [ ] demo-scout - Demo (task-d1) (repo: x) (kind: scout)\n- [ ] other - Other (task-zz) (kind: scout)\n');
  await seed(env, { fleet: { beads: { 'fleet-demo-scout': bead('fleet-demo-scout') } }, task: { beads: { 'task-d1': bead('task-d1') } } });
  const event = await scoutEvent(env);
  const first = await act(event, env);
  assert.equal(first.target, 'brain-fmhscout-demo-scout');
  assert.equal(first.wrote, true);
  assert.deepEqual(first.links, { fleet: 'linked', backlog: 'linked' });
  assert.equal(first.reviews.length, 3);
  let state = await db();
  const created = state.brain.beads['brain-fmhscout-demo-scout'];
  assert.match(created.description, /found two things/);
  assert.match(created.description, /report: .*data\/demo-scout\/report\.md/);
  assert.match(created.description, /task: demo-scout/);
  assert.ok(created.labels.includes('fm-task:demo-scout'));
  assert.equal(state.fleet.beads['fleet-demo-scout'].comments.length, 1);
  assert.equal(state.task.beads['task-d1'].comments.length, 1);
  const reviews = Object.values(state.review.beads) as any[];
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every(r => r.labels.includes('human') && r.labels.includes('fm-task:demo-scout')));

  const before = (await writes()).length;
  const again = await act(event, env);
  assert.equal(again.wrote, false);
  assert.deepEqual(again.links, { fleet: 'already', backlog: 'already' });
  assert.ok(again.reviews.every(r => r.wrote === false));
  assert.equal((await writes()).length, before, 're-delivery must not write');
}, { stores: STORES }));

test('a done line with no report is not a scout: visible skip, no writes', async () => withStubs(async ({ env, writes }) => {
  const event = await scoutEvent(env, { task: 'ship-task', report: null });
  assert.match((await act(event, env)).skipped, /not a scout/);
  assert.deepEqual(await writes(), []);
}, { stores: STORES }));

test('a missing fleet bead is reported, not invented; a report with no calls files no review', async () => withStubs(async ({ env, db }) => {
  const event = await scoutEvent(env, { report: '# R\n\nNothing for the captain.\n' });
  const result = await act(event, env);
  assert.equal(result.links.fleet, 'missing');
  assert.deepEqual(result.reviews, []);
  const state = await db();
  assert.deepEqual(Object.keys(state.brain.beads), ['brain-fmhscout-demo-scout']);
  assert.equal(state.review, undefined);
}, { stores: STORES }));

test('a brain store failure propagates so the job lands in failed/', async () => withStubs(async ({ env }) => {
  const event = await scoutEvent(env);
  await assert.rejects(act(event, { ...env, STUB_FAIL: 'brain:create' }));
}, { stores: STORES }));

test('scoutDone reads the talon-phone-grammar-scout-q2 done line, whose [at=] stamp is a shell variable the hook saw unexpanded (robots-fkb70)', () => {
  const home = '/Users/x/fm_home/firstmate';
  const event = (stamp: string) => ({ operation: 'fm-fleet-ledger.sh', args: ['appended', `${home}/config`, `${home}/state/${TALON_TASK}.status`, '>/dev/null', '2>&1'], rawCommand: talonCommand(home, stamp) });
  for (const stamp of ['$E', '$(date +%s)', '1792432383']) {
    assert.deepEqual(scoutDone(event(stamp)), { task: TALON_TASK, line: TALON_LINE, statusPath: `${home}/state/${TALON_TASK}.status` }, `stamp ${stamp}`);
  }
  assert.equal(scoutDone({ ...event('$E'), rawCommand: talonCommand(home).replace('"done [at=$E]:', '"working [at=$E]:') }), null);
});

test('the hook path captures the talon scout from its real command: one brain bead whose summary is the verdict', async () => withStubs(async ({ env, db }) => {
  const event = await scoutEvent(env, { task: TALON_TASK, report: TALON_REPORT, rawCommand: talonCommand(env.FM_HOME) });
  const result = await act(event, env);
  assert.equal(result.target, TALON_ID);
  assert.equal(scoutBeadId(TALON_TASK), TALON_ID);
  assert.equal(result.wrote, true);
  const created = (await db()).brain.beads[TALON_ID];
  assert.match(created.description, /^Talon AM\+decoder\+lexicon shown portable on Mac/);
  assert.match(created.description, new RegExp(`task: ${TALON_TASK}`));
  assert.match(created.title, /Porting Talon's speech engine to the iPhone/);
  assert.ok(created.labels.includes(`fm-task:${TALON_TASK}`));
}, { stores: STORES }));

test('the status tail captures a scout when it records the done line; the hook delivering the same line afterwards writes nothing', async () => withStubs(async ({ env, db, writes }) => {
  await stateDir(env);
  await writeFile(statusFile(env, TALON_TASK), 'working [at=1792428879]: reading prior scout report\n');
  await tail(env);
  await report(env, TALON_TASK, TALON_REPORT);
  await appendFile(statusFile(env, TALON_TASK), `done [at=1792432383]: ${TALON_LINE}\n`);
  const tailed = await tail(env);
  assert.deepEqual(tailed.recorded.map(r => [r.task, r.state, r.scout.target, r.scout.wrote, r.scout.links]),
    [[TALON_TASK, 'done', TALON_ID, true, { fleet: 'linked' }]]);
  let state = await db();
  assert.match(state.brain.beads[TALON_ID].description, /^Talon AM\+decoder\+lexicon shown portable/);
  const fleet = state.fleet.beads[`fleet-${TALON_TASK}`];
  assert.ok(fleet.labels.includes('fm-state:done'));
  assert.equal(fleet.comments.length, 2, 'the status comment and the capture link');
  assert.match(fleet.comments[1].text, new RegExp(`findings captured in ${TALON_ID}`));

  const before = (await writes()).length;
  assert.deepEqual((await tail(env)).recorded, []);
  const hook = await act(await scoutEvent(env, { task: TALON_TASK, report: TALON_REPORT, rawCommand: talonCommand(env.FM_HOME) }), env);
  assert.equal(hook.target, TALON_ID);
  assert.equal(hook.wrote, false);
  assert.deepEqual(hook.links, { fleet: 'already' });
  assert.equal((await writes()).length, before, 'the second path must not write');
  state = await db();
  assert.deepEqual(Object.keys(state.brain.beads), [TALON_ID]);
  assert.equal(state.fleet.beads[`fleet-${TALON_TASK}`].comments.length, 2);
}, { stores: STORES }));

test('the hook capturing first leaves the status tail nothing to write for the same done line', async () => withStubs(async ({ env, db, writes }) => {
  await stateDir(env);
  await writeFile(statusFile(env, TALON_TASK), '');
  await tail(env);
  const hook = await act(await scoutEvent(env, { task: TALON_TASK, report: TALON_REPORT, rawCommand: talonCommand(env.FM_HOME) }), env);
  assert.equal(hook.wrote, true);
  assert.equal(hook.links.fleet, 'missing', 'the fleet bead does not exist yet');
  await appendFile(statusFile(env, TALON_TASK), `done [at=1792432383]: ${TALON_LINE}\n`);
  const tailed = await tail(env);
  assert.equal(tailed.recorded[0].scout.wrote, false);
  assert.equal(tailed.recorded[0].scout.links.fleet, 'linked', 'the fleet bead now exists, so the one link comment lands here');
  const state = await db();
  assert.deepEqual(Object.keys(state.brain.beads), [TALON_ID]);
  assert.equal((await writes()).filter(w => w.store === 'brain' && w.argv[0] === 'create').length, 1);
}, { stores: STORES }));

test('a tailed done line for a task with no report is a visible skip, not a capture', async () => withStubs(async ({ env, db }) => {
  await stateDir(env);
  await writeFile(statusFile(env, 'ship-task'), '');
  await tail(env);
  await appendFile(statusFile(env, 'ship-task'), 'done [at=1792432383]: PR https://x/1\n');
  const tailed = await tail(env);
  assert.equal(tailed.recorded[0].state, 'done');
  assert.match(tailed.recorded[0].scout.skipped, /not a scout/);
  assert.equal((await db()).brain, undefined);
}, { stores: STORES }));
