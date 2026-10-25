import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askPack, ciRollupPack, CI_ROLLUP_MAX_BYTES, CI_ROLLUP_MIN_CONFIDENCE, PACKS, prefilterCiRollup, prefilterStoreRoute,
  prefilterWorkerStatus, STORE_ROUTE_MAX_CHARS, STORE_ROUTE_MIN_CONFIDENCE, STORE_ROUTE_STORES, storeRoutePack, UNDECIDED,
  WORKER_STATUS_MAX_BYTES, WORKER_STATUS_MIN_CONFIDENCE, workerStatusPack,
} from '../src/jev/questions/v1.ts';

const KEY = 'sk-secret-key-123';
const fixtures = join(import.meta.dir, 'fixtures/jev/v1');

const choiceReply = (choice: string, confidence: number, probabilities: Record<string, number>) => ({
  model: 'jev-1.13.0',
  answers: { q0: { type: 'choice', choice, confidence, probabilities } },
  usage: { input_tokens: 1, output_tokens: 1 },
});
const fakeFetch = (calls: any[], payload: any) => async (url, init) => {
  calls.push({ url, init });
  return new Response(JSON.stringify(payload), { status: 200 });
};
const answer = (pack, value: string, confidence: number) => [{ id: pack.questions[0].id, kind: 'choice' as const, value, distribution: { [value]: confidence }, confidence }];

// ---- worker-status ----

test('worker-status prefilter keeps the newest known-state lines and strips epochs, keys, paths and ids', () => {
  const raw = [
    'working [at=1792000000]: starting',
    'not a status line',
    'needs-decision [at=1792000100] [key=nm-01M5C8XT6J6K0QX5T9T9A7DN4M-review]: findings in /Users/trilliumsmith/fm_home/x/y.txt',
    'resolved [key=nm-01M5C8XT6J6K0QX5T9T9A7DN4M-review] [at=1792000200]: firstmate decided; see task-q1k8 and commit 940ac2b4',
    'done [at=1792000300] [corr=649945980454d1d5]: PR https://github.com/o/r/pull/9 ready',
  ].join('\n');
  const out = prefilterWorkerStatus(raw);
  assert.equal(out, [
    'working: starting',
    'needs-decision: findings in <path>',
    'resolved: firstmate decided; see <id> and commit <id>',
    'done: PR <url> ready',
  ].join('\n'));
  assert.ok(!/\d{10}|\/Users|nm-01|task-q1k8|940ac2b4/.test(out));
});

test('worker-status prefilter keeps only the last lines, caps bytes, and never returns empty', () => {
  const many = Array.from({ length: 50 }, (_, i) => `working [at=${1792000000 + i}]: step ${i}`).join('\n');
  assert.deepEqual(prefilterWorkerStatus(many).split('\n'), Array.from({ length: 6 }, (_, i) => `working: step ${44 + i}`));
  const long = Array.from({ length: 6 }, () => `done [at=1792000000]: ${'word '.repeat(80)}`).join('\n');
  const capped = prefilterWorkerStatus(long);
  assert.ok(Buffer.byteLength(capped) <= WORKER_STATUS_MAX_BYTES);
  assert.equal(prefilterWorkerStatus('nothing useful here'), '(no status lines)');
});

test('worker-status decode: choices, other exit, low confidence', () => {
  const d = (value, confidence) => workerStatusPack.decode(answer(workerStatusPack, value, confidence));
  assert.deepEqual(d('done', 0.9), { verdict: 'done', reason: null, confidence: 0.9, choice: 'done' });
  assert.equal(d('stuck', WORKER_STATUS_MIN_CONFIDENCE).verdict, 'stuck');
  assert.equal(d('in-progress', 0.7).verdict, 'in-progress');
  assert.deepEqual(d('other', 0.99), { verdict: UNDECIDED, reason: 'exit', confidence: 0.99, choice: 'other' });
  assert.deepEqual(d('done', WORKER_STATUS_MIN_CONFIDENCE - 0.01).reason, 'low-confidence');
  assert.equal(d('done', 0.3).verdict, UNDECIDED);
  assert.equal(d('weird', 0.99).reason, 'unknown-choice');
  assert.equal(workerStatusPack.decode([]).verdict, UNDECIDED);
});

// ---- ci-rollup ----

test('ci-rollup prefilter collapses gh pr checks text to name: conclusion, failures first', () => {
  const raw = 'lint\tpass\t12s\thttps://x/1\t\nunit (bun)\tfail\t41s\thttps://x/2\t\ne2e\tpending\t0\t\t\ndocs\tskipping\t0\t\t\nlint\tpass\t13s\thttps://x/3\t\n';
  assert.equal(prefilterCiRollup(raw), 'unit (bun): fail\ne2e: pending\ndocs: skipped\nlint: pass');
});

test('ci-rollup prefilter reads gh --json shapes and gh run view text', () => {
  const pr = JSON.stringify([{ name: 'a', bucket: 'pass', state: 'SUCCESS' }, { name: 'b', bucket: 'fail', state: 'FAILURE' }]);
  assert.equal(prefilterCiRollup(pr), 'b: fail\na: pass');
  const run = JSON.stringify({ jobs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: '' }, { name: 'lint', conclusion: 'cancelled' }] });
  assert.equal(prefilterCiRollup(run), 'lint: cancelled\ntest: pending\nbuild: pass');
  const view = '✓ build in 5s (ID 123)\nX test in 2m10s (ID 124)\n* deploy (ID 125)\n- docs in 0s (ID 126)\n';
  assert.equal(prefilterCiRollup(view), 'test: fail\ndeploy: pending\ndocs: skipped\nbuild: pass');
  assert.equal(prefilterCiRollup('no checks reported on the branch'), '(no checks listed)');
});

test('ci-rollup prefilter caps check count and bytes', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ name: `check-${i}`, bucket: i === 99 ? 'fail' : 'pass' }));
  const out = prefilterCiRollup(JSON.stringify(rows));
  const lines = out.split('\n');
  assert.equal(lines[0], 'check-99: fail', 'the failure survives the cap');
  assert.equal(lines.length, 41);
  assert.equal(lines.at(-1), '(60 more checks not shown)');
  const wide = prefilterCiRollup(JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ name: `${'n'.repeat(100)}${i}`, bucket: 'pass' }))));
  assert.ok(Buffer.byteLength(wide) <= CI_ROLLUP_MAX_BYTES);
});

test('ci-rollup decode', () => {
  const d = (value, confidence) => ciRollupPack.decode(answer(ciRollupPack, value, confidence));
  for (const v of ['pass', 'fail', 'pending']) assert.equal(d(v, 0.9).verdict, v);
  assert.equal(d('other', 0.9).verdict, UNDECIDED);
  assert.equal(d('fail', CI_ROLLUP_MIN_CONFIDENCE - 0.1).reason, 'low-confidence');
});

// ---- store-route ----

test('store-route prefilter joins title and body, strips ids, and trims to about 600 chars', () => {
  const out = prefilterStoreRoute({ title: 'Fix task-q1k8 poller', body: 'See https://github.com/o/r/pull/9 and #12, commit 940ac2b4, file /Users/x/y.ts.\n\nThanks.' });
  assert.equal(out, 'Fix <id> poller See <url> and <id>, commit <id>, file <path>. Thanks.');
  const long = prefilterStoreRoute('T\n' + 'lorem ipsum '.repeat(200));
  assert.ok(long.length <= STORE_ROUTE_MAX_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(prefilterStoreRoute('plain string'), 'plain string');
});

test('store-route options are the single exported list, ending in none', () => {
  assert.deepEqual([...STORE_ROUTE_STORES], ['task', 'brain', 'decisions', 'ideas', 'questions', 'robots', 'friction', 'review', 'inbox', 'status', 'runbooks', 'errors', 'none']);
  assert.deepEqual(Object.keys((storeRoutePack.questions[0] as any).options), [...STORE_ROUTE_STORES]);
});

test('store-route decode: every store, none exit, low confidence', () => {
  const d = (value, confidence) => storeRoutePack.decode(answer(storeRoutePack, value, confidence));
  for (const s of STORE_ROUTE_STORES.filter(s => s !== 'none')) assert.equal(d(s, 0.8).verdict, s);
  assert.deepEqual(d('none', 0.95), { verdict: UNDECIDED, reason: 'exit', confidence: 0.95, choice: 'none' });
  assert.equal(d('task', STORE_ROUTE_MIN_CONFIDENCE - 0.01).reason, 'low-confidence');
});

// ---- every pack ----

test('every pack: one choice question with an exit, id <pack>/<question>, threshold set', () => {
  for (const [name, pack] of Object.entries(PACKS)) {
    assert.equal(pack.id, name);
    assert.equal(pack.questions.length, 1, 'one judgment per question');
    const q: any = pack.questions[0];
    assert.match(q.id, new RegExp(`^${name}/[a-z-]+$`));
    assert.equal(q.kind, 'choice');
    assert.ok('other' in q.options || 'none' in q.options);
    assert.equal(typeof q.threshold, 'number');
  }
});

test('askPack prefilters in code, sends one request, logs <pack>/<question> and decodes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-jev-q-'));
  try {
    const log = join(dir, 'eval.jsonl');
    const calls: any[] = [];
    const reply = choiceReply('done', 0.92, { done: 0.92, stuck: 0.03, 'in-progress': 0.03, other: 0.02 });
    const result = await askPack(workerStatusPack, 'done [at=1792647669]: finished /Users/x/report.md', { fetch: fakeFetch(calls, reply), apiKey: KEY, evalLogPath: log });
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.state, 'done: finished <path>');
    assert.equal(Object.keys(sent.questions).length, 1);
    assert.equal(result.verdict, 'done');
    assert.equal(result.state, 'done: finished <path>');
    const text = await readFile(log, 'utf8');
    const lines = text.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].question_id, 'worker-status/state');
    assert.equal(lines[0].request_id, result.requestId);
    assert.equal(lines[0].threshold, WORKER_STATUS_MIN_CONFIDENCE);
    assert.ok(!text.includes(KEY));

    const unsure = await askPack(storeRoutePack, { title: 'x', body: 'y' }, { fetch: fakeFetch([], choiceReply('task', 0.2, { task: 0.2, brain: 0.19 })), apiKey: KEY, evalLogPath: null });
    assert.equal(unsure.verdict, UNDECIDED);
    assert.equal(unsure.reason, 'low-confidence');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- fixtures: committed, redacted, labeled ----

test('fixtures are labeled, redacted, and prefilter to non-empty state', async () => {
  for (const name of Object.keys(PACKS)) {
    const dir = join(fixtures, name);
    const labels = JSON.parse(await readFile(join(dir, 'labels.json'), 'utf8'));
    const files = (await readdir(dir)).filter(f => f !== 'labels.json').sort();
    assert.deepEqual(files, Object.keys(labels).sort(), `${name}: every fixture has a label`);
    assert.ok(files.length >= 3 && files.length <= 6);
    for (const f of files) {
      const raw = await readFile(join(dir, f), 'utf8');
      assert.ok(!/\/Users\/|\/home\/|sk-[A-Za-z0-9]{8}|nm-01M/.test(raw), `${name}/${f} is redacted`);
      assert.ok(PACKS[name].prefilter(raw).length > 0);
    }
  }
});

// ---- live smoke (JEV_LIVE=1): accuracy per pack over the labeled fixtures ----

for (const [name, pack] of Object.entries(PACKS)) {
  test.skipIf(process.env.JEV_LIVE !== '1')(`live smoke: ${name}`, async () => {
    const dir = join(fixtures, name);
    const labels = JSON.parse(await readFile(join(dir, 'labels.json'), 'utf8'));
    const rows: any[] = [];
    for (const [file, expected] of Object.entries<string>(labels)) {
      const raw = await readFile(join(dir, file), 'utf8');
      const result = await askPack(pack as any, raw, { evalLogPath: null });
      rows.push({ file, expected, verdict: result.verdict, choice: result.choice, confidence: Number(result.confidence.toFixed(3)), latencyMs: result.latencyMs, model: result.model });
    }
    // A label of other/none means "the pack should decline": it decodes to undecided.
    const correct = rows.filter(r => r.verdict === (r.expected === 'other' || r.expected === 'none' ? UNDECIDED : r.expected)).length;
    console.log(JSON.stringify({ pack: name, correct, total: rows.length, rows }));
    assert.equal(rows.length, Object.keys(labels).length);
  });
}
