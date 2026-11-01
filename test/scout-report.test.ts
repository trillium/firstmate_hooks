import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main as scoutCapture } from '../bin/fm-hooks-scout-capture.ts';
import { storeRunner } from '../src/bead-actions.ts';
import { captureScout } from '../src/scout-capture.ts';
import { PART_CAP, optedOut, probe, reportBeadId, splitParts, terminalStatus, writeReport } from '../src/scout-report.ts';
import { redactSecrets } from '../src/scrub.ts';
import { withStubs } from '../testlib/stub-env.ts';

const STORES = ['review', 'brain', 'fleet'];
const REPORT = '# Demo scout\n\nFindings first.\n\n## Detail\n\nThe detail paragraph.\n';
const write = (run: any, over: Record<string, any> = {}) => writeReport({ run, home: '/h/fm_home/mini0-ops', machine: 'mini0', task: 'demo', text: REPORT, reportPath: '/h/fm_home/mini0-ops/data/demo/report.md', ...over });
const record = async (db: any, id: string) => (await db()).brain.beads[id];
async function putReport(home: string, task: string, text: string, status?: string) {
  await mkdir(join(home, 'data', task), { recursive: true });
  await writeFile(join(home, 'data', task, 'report.md'), text);
  if (status !== undefined) { await mkdir(join(home, 'state'), { recursive: true }); await writeFile(join(home, 'state', `${task}.status`), status); }
}

test('the record id carries the home, except for the original home whose 67 records keep theirs', () => {
  assert.equal(reportBeadId('/Users/a/fm_home/firstmate', 'pf-scope-map'), 'brain-fmhscout-pf-scope-map');
  assert.equal(reportBeadId('/Users/a/fm_home/mini0-ops', 'pf-scope-map'), 'brain-fmhscout-mini0-ops-pf-scope-map');
  assert.equal(reportBeadId('/Users/a/fm_home/mini1-ops/', 'pf-scope-map'), 'brain-fmhscout-mini1-ops-pf-scope-map');
  assert.notEqual(reportBeadId('/x/fm_home/mini0-ops', 'iphone-projects-status'), reportBeadId('/x/fm_home/macbook-ops', 'iphone-projects-status'));
  assert.equal(reportBeadId('/x/fm_home/mini0-ops', 'Weird Task!'), 'brain-fmhscout-mini0-ops-weird-task');
});

test('splitParts keeps every character, in order, within the cap, cutting at paragraph breaks', () => {
  const text = Array.from({ length: 40 }, (_, i) => `P${i} ${'é'.repeat(3000)}`).join('\n\n');
  const parts = splitParts(text, 10000);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => part.length <= 10000));
  assert.ok(parts.slice(0, -1).every(part => part.endsWith('\n\n')));
  assert.deepEqual(splitParts('short'), ['short']);
  assert.equal(splitParts('x'.repeat(25), 10).join(''), 'x'.repeat(25));
  const emoji = splitParts('😀'.repeat(11), 10);
  assert.equal(emoji.join(''), '😀'.repeat(11));
  assert.ok(emoji.every(part => !/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part)));
  assert.equal(PART_CAP, 50000);
});

test('a first write creates one knowledge record with the digest, the labels and the full text; the label that marks it complete is last', async () => withStubs(async ({ env, db, calls }) => {
  const run = storeRunner(env);
  const result = write(run, { line: 'report written at data/demo/report.md; found the thing', project: 'brain' });
  assert.equal(result.action, 'created');
  const bead = await record(db, 'brain-fmhscout-mini0-ops-demo');
  assert.equal(bead.issue_type, 'knowledge');
  assert.equal(bead.title, 'Scout report: demo - Demo scout');
  assert.match(bead.description, /^found the thing\n/);
  assert.match(bead.description, /home: mini0-ops \(mini0\)\ntask: demo\nproject: brain\nreport: \/h\/fm_home\/mini0-ops\/data\/demo\/report\.md/);
  for (const label of ['fm-hooks', 'fm-scout-report', 'fm-task:demo', 'fm-home:mini0-ops', 'fm-machine:mini0', 'project:brain', `fm-report-sha:${result.rev}`]) assert.ok(bead.labels.includes(label), label);
  assert.equal(bead.comments.length, 1);
  assert.ok(bead.comments[0].text.endsWith(REPORT));
  const verbs = (await calls()).map(c => c.argv.slice(0, 2).join(' '));
  assert.ok(verbs.lastIndexOf('update brain-fmhscout-mini0-ops-demo') > verbs.lastIndexOf('comments add'), 'the sha label is written after the text');
}, { stores: STORES }));

test('the same text writes nothing; changed text updates the same record with a new revision and swaps the label', async () => withStubs(async ({ env, db, writes }) => {
  const run = storeRunner(env);
  const first = write(run);
  const before = (await writes()).length;
  assert.equal(write(run).action, 'unchanged');
  assert.equal((await writes()).length, before);

  const edited = write(run, { text: `${REPORT}\n## Added later\n\nA new finding.\n`, line: 'revised' });
  assert.equal(edited.action, 'updated');
  assert.notEqual(edited.rev, first.rev);
  const state = await db();
  assert.deepEqual(Object.keys(state.brain.beads), ['brain-fmhscout-mini0-ops-demo'], 'never a second record');
  const bead = state.brain.beads['brain-fmhscout-mini0-ops-demo'];
  assert.ok(bead.labels.includes(`fm-report-sha:${edited.rev}`));
  assert.ok(!bead.labels.includes(`fm-report-sha:${first.rev}`));
  assert.match(bead.description, new RegExp(`fm-report-rev: ${edited.rev}`));
  assert.match(bead.description, /^revised\n/);
  assert.equal(bead.comments.length, 2);
  assert.match(bead.comments[0].text, new RegExp(`rev=${first.rev}`));
  assert.match(bead.comments[1].text, new RegExp(`rev=${edited.rev}`));
  assert.ok(bead.comments[1].text.includes('A new finding.'));
}, { stores: STORES }));

test('a write that died after the text and before the label is finished by the next one, with no part repeated', async () => withStubs(async ({ env, db }) => {
  const run = storeRunner(env);
  const long = `# Long\n\n${Array.from({ length: 20 }, (_, i) => `Para ${i} ${'y'.repeat(9000)}`).join('\n\n')}\n`;
  assert.throws(() => write(storeRunner({ ...env, STUB_FAIL: 'brain:update' }), { text: long }));
  let bead = await record(db, 'brain-fmhscout-mini0-ops-demo');
  const parts = bead.comments.length;
  assert.ok(parts > 1 && !bead.labels.some((l: string) => l.startsWith('fm-report-sha:')));
  const result = write(run, { text: long });
  assert.equal(result.action, 'completed');
  bead = await record(db, 'brain-fmhscout-mini0-ops-demo');
  assert.equal(bead.comments.length, parts, 'the parts already there were not written again');
  assert.ok(bead.labels.includes(`fm-report-sha:${result.rev}`));
  assert.equal(write(run, { text: long }).action, 'unchanged');
}, { stores: STORES }));

test('credentials are redacted before anything is written, and ordinary prose is left alone', async () => withStubs(async ({ env, db }) => {
  const ghp = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789';
  const text = `# Audit\n\nThe token ${ghp} was found. Authorization: Bearer abcdef0123456789xyz\nAPI_KEY=abc123def456ghi and clone https://user:hunter22@example.com/x.git\n`
    + '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'
    + 'Plain: token budget is 20, password policy: rotate, see /Users/a/fm_home/firstmate/data/x/report.md and commit 588fecd1a2b3c4d5e6f7.\n';
  write(storeRunner(env), { text, line: `summary with ${ghp}` });
  const bead = await record(db, 'brain-fmhscout-mini0-ops-demo');
  const stored = `${bead.description}\n${bead.comments.map((c: any) => c.text).join('\n')}`;
  for (const secret of [ghp, 'abcdef0123456789xyz', 'abc123def456ghi', 'hunter22', 'MIIEvQIBAD']) assert.ok(!stored.includes(secret), secret);
  assert.match(stored, /\[redacted\]/);
  assert.match(stored, /token budget is 20, password policy: rotate, see \/Users\/a\/fm_home\/firstmate\/data\/x\/report\.md and commit 588fecd1a2b3c4d5e6f7/);
  assert.equal(redactSecrets('sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'), '[redacted]');
}, { stores: STORES }));

test('the revision is of the redacted text, so a rotated secret alone does not write a new revision', async () => withStubs(async ({ env }) => {
  const run = storeRunner(env);
  const key = (value: string) => `# R\n\nKey: gh${'p_'}${value}\n`;
  write(run, { text: key('a'.repeat(30)) });
  assert.equal(write(run, { text: key('b'.repeat(30)) }).action, 'unchanged');
}, { stores: STORES }));

test('a report whose first line is the opt-out marker is never captured, whatever triggers it', async () => withStubs(async ({ env, db, writes }) => {
  assert.ok(optedOut('<!-- no-brain -->\n# R'));
  assert.ok(optedOut('<!--no-brain-->'));
  assert.ok(!optedOut('# R\n<!-- no-brain -->\n'));
  assert.ok(!optedOut('\n\n<!-- no-brain -->'));
  await putReport(env.FM_HOME, 'private', '<!-- no-brain -->\n# Private\n\nsecret plans\n', 'done [at=1]: x\n');
  const result: any = await captureScout({ run: storeRunner(env), env, home: env.FM_HOME, task: 'private' });
  assert.match(result.skipped, /opted out/);
  assert.deepEqual(await writes(), []);
  assert.equal((await db()).brain, undefined);
}, { stores: STORES }));

test('a delivered report is captured only once its status is done or needs-decision (or absent)', async () => withStubs(async ({ env, db }) => {
  const gate = (task: string) => captureScout({ run: storeRunner(env), env, home: env.FM_HOME, task, requireTerminal: true }) as Promise<any>;
  await putReport(env.FM_HOME, 'running', REPORT, 'working [at=1]: reading\n');
  assert.match((await gate('running')).skipped, /not delivered yet: status is working/);
  await putReport(env.FM_HOME, 'blocked', REPORT, 'blocked [at=1]: stuck\n');
  assert.match((await gate('blocked')).skipped, /status is blocked/);
  await putReport(env.FM_HOME, 'finished', REPORT, 'working [at=1]: x\ndone [at=2]: report written at data/finished/report.md; all good\n');
  assert.equal((await gate('finished')).action, 'created');
  await putReport(env.FM_HOME, 'asking', REPORT, 'needs-decision [at=2]: which option?\n');
  assert.equal((await gate('asking')).action, 'created');
  await putReport(env.FM_HOME, 'nostatus', REPORT);
  assert.equal((await gate('nostatus')).action, 'created');
  assert.deepEqual(await terminalStatus(env.FM_HOME, 'finished'), { exists: true, terminal: true, state: 'done', line: 'report written at data/finished/report.md; all good' });
  assert.match((await db()).brain.beads['brain-fmhscout-finished'].description, /^all good\n/);
}, { stores: STORES }));

test('records from before revisions are adopted, not duplicated: matching text only gains the label; a cut or changed copy gets a new revision', async () => withStubs(async ({ env, db }) => {
  const run = storeRunner(env);
  const home = '/h/fm_home/firstmate';
  const legacy = (id: string, extra: any = {}) => ({ id, title: id, status: 'open', labels: ['fm-hooks', 'fm-scout-report', `fm-task:${id}`], comments: [], description: 'summary\n\nreport: /x', ...extra });
  const long = `# Report\n\n${Array.from({ length: 12 }, (_, i) => `Paragraph ${i} with its own distinct words ${i * 7919}.`).join('\n\n')}\n`;
  await writeFile(env.STUB_DB, JSON.stringify({ brain: { beads: {
    'brain-fmhscout-same': legacy('same', { comments: [{ text: `Scout report (same) - full text [scout-report:same]\n\n${long}` }] }),
    'brain-fmhscout-cut': legacy('cut', { comments: [{ text: `Scout report (cut) - full text [scout-report:cut]\n\n${long.slice(0, 200)}\n[truncated: 200 of ${long.length} characters; full report: /x]` }] }),
    'brain-fmhscout-hand': legacy('hand', { comments: [{ text: `attached by hand\n\n${long}` }] }),
    'brain-fmhscout-indesc': legacy('indesc', { description: long }),
    'brain-fmhscout-bare': legacy('bare'),
  } } }));
  const go = (task: string) => writeReport({ run, home, machine: 'macbookpro', task, text: long, reportPath: `/h/data/${task}/report.md` });
  assert.equal(go('same').action, 'adopted');
  assert.equal(go('hand').action, 'adopted');
  assert.equal(go('indesc').action, 'adopted');
  assert.equal(go('cut').action, 'completed');
  assert.equal(go('bare').action, 'completed');
  const state = (await db()).brain.beads;
  assert.equal(state['brain-fmhscout-same'].comments.length, 1, 'adoption writes no text');
  assert.equal(state['brain-fmhscout-hand'].comments.length, 1);
  assert.equal(state['brain-fmhscout-indesc'].comments.length, 0);
  assert.equal(state['brain-fmhscout-same'].description, 'summary\n\nreport: /x', 'an adopted record keeps its description');
  assert.equal(state['brain-fmhscout-cut'].comments.length, 2);
  assert.equal(state['brain-fmhscout-bare'].comments.length, 1);
  for (const id of Object.keys(state)) assert.ok(state[id].labels.some((l: string) => l.startsWith('fm-report-sha:')), id);
  assert.equal(go('same').action, 'unchanged');
  assert.ok(probe(long)!.length === 120 && probe('too short') === null);
}, { stores: STORES }));

test('the same task name in two homes is two records', async () => withStubs(async ({ env, db }) => {
  const run = storeRunner(env);
  write(run, { home: '/h/fm_home/mini0-ops' });
  write(run, { home: '/h/fm_home/macbook-ops', text: `${REPORT}\nA different report.\n` });
  assert.deepEqual(Object.keys((await db()).brain.beads).sort(), ['brain-fmhscout-macbook-ops-demo', 'brain-fmhscout-mini0-ops-demo']);
}, { stores: STORES }));

test('a deliverable the report names is part of the record; one it does not name is not', async () => withStubs(async ({ env, db }) => {
  const home = join(env.FM_HOME, '..', 'mini0-ops');
  await putReport(home, 'design', '# Design\n\nThe design itself is in `design.md`.\n', 'done [at=1]: x\n');
  await writeFile(join(home, 'data', 'design', 'design.md'), '# The design\n\nSection one.\n');
  await writeFile(join(home, 'data', 'design', 'scratch.md'), 'not named\n');
  await writeFile(join(home, 'data', 'design', 'secret.md'), '<!-- no-brain -->\nnever\n');
  const result: any = await captureScout({ run: storeRunner(env), env, home, task: 'design' });
  const bead = await record(db, result.target);
  const text = bead.comments.map((c: any) => c.text).join('\n');
  assert.ok(text.includes('# Deliverable: design.md') && text.includes('Section one.'));
  assert.ok(!text.includes('not named') && !text.includes('never'));
  assert.match(bead.description, /deliverables: design\.md/);
}, { stores: STORES }));

test('backfill captures every report of every home once, files no review beads, and a rerun writes nothing', async () => withStubs(async ({ env, db, writes }) => {
  const root = join(env.FM_HOME, '..', 'homes');
  const body = (n: string) => `# ${n}\n\nFindings.\n\n## Captain calls\n\n1. Decide ${n}.\n`;
  await putReport(join(root, 'mini0-ops'), 'a', body('A'), 'done [at=1]: a\n');
  await putReport(join(root, 'mini0-ops'), 'dup', body('Dup0'));
  await putReport(join(root, 'macbook-ops'), 'dup', body('Dup1'));
  await putReport(join(root, 'macbook-ops'), 'private', `<!-- no-brain -->\n${body('P')}`);
  await putReport(join(root, 'macbook-ops'), 'fresh', body('Fresh'));
  await utimes(join(root, 'macbook-ops', 'data', 'fresh', 'report.md'), new Date(), new Date());
  await mkdir(join(root, 'mini0-ops', 'data', 'empty-task'), { recursive: true });
  for (const name of ['a', 'dup']) await utimes(join(root, 'mini0-ops', 'data', name, 'report.md'), new Date(0), new Date(0));
  await utimes(join(root, 'macbook-ops', 'data', 'dup', 'report.md'), new Date(0), new Date(0));
  await utimes(join(root, 'macbook-ops', 'data', 'private', 'report.md'), new Date(0), new Date(0));
  const out: string[] = [];
  const go = (...args: string[]) => scoutCapture(['backfill', '--root', root, ...args], { log: (l: string) => out.push(l), error: () => {}, env });

  assert.equal(await go('--dry-run'), 0);
  assert.deepEqual(await writes(), [], 'a dry run writes nothing');
  assert.match(out.at(-1)!, /"created":3/);

  assert.equal(await go(), 0);
  assert.deepEqual(Object.keys((await db()).brain.beads).sort(), ['brain-fmhscout-macbook-ops-dup', 'brain-fmhscout-mini0-ops-a', 'brain-fmhscout-mini0-ops-dup']);
  assert.equal((await db()).review, undefined, 'a backfill files no review beads');
  const summary = JSON.parse(out.at(-1)!);
  assert.equal(summary.created, 3);
  assert.equal(summary['opted-out'], 1);
  assert.equal(summary['too-new'], 1);

  const before = (await writes()).length;
  assert.equal(await go(), 0);
  assert.equal((await writes()).length, before, 'a rerun is idempotent');
  assert.equal(JSON.parse(out.at(-1)!).unchanged, 3);

  await scoutCapture(['audit', '--root', root], { log: (l: string) => out.push(l), error: () => {}, env });
  const audit = JSON.parse(out.at(-1)!);
  assert.equal(audit.captured, 3);
  assert.equal(audit.missing, 1, 'the report too new for a backfill is still not in brain, and the audit says so');

  assert.equal(await go('--max-writes', '1', '--task', 'nothing-matches'), 0);
}, { stores: STORES }));
