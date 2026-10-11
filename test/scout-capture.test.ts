import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBeadAction } from '../src/bead-actions.ts';
import { captainCalls, scoutDone } from '../src/scout-capture.ts';
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

async function scoutEvent(env: any, { task = 'demo-scout', line = 'report written at /h/data/demo-scout/report.md; found two things', report = REPORT, correlationId = 'a'.repeat(64) }: any = {}) {
  const status = join(env.FM_HOME, 'state', `${task}.status`);
  const rawCommand = `echo "done [at=1791700000]: ${line}" >> '${status}' && { [ ! -e '${env.FM_HOME}/config/fleet-ledger' ] || '${env.FM_HOME}/bin/fm-fleet-ledger.sh' appended '${env.FM_HOME}/config' '${status}' >/dev/null 2>&1 || true; }`;
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
