import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeHook } from '../src/claude-events.ts';
import { storeCaptureOf } from '../src/jev/observe-store-route.ts';
import { ciRollupOf } from '../src/jev/observe-ci-rollup.ts';
import { drainShadowPending, pendingDir, queueShadowObservations } from '../src/jev/pending.ts';
import { buildReport } from '../src/jev/shadow-report.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'fm-observe-'));
const readLog = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const okAsk = (verdict) => async () => ({ requestId: 'req-1', state: 's', verdict, reason: null, confidence: 0.9, choice: verdict, latencyMs: 5 });

test('storeCaptureOf recognizes store capture commands', () => {
  assert.deepEqual(storeCaptureOf('brain create "Hook misfires" -d "it fires twice"'), { store: 'brain', title: 'Hook misfires', body: 'it fires twice' });
  assert.deepEqual(storeCaptureOf("robots create 'broken verb' --description='details here' -p 1"), { store: 'robots', title: 'broken verb', body: 'details here' });
  assert.equal(storeCaptureOf('task q "quick capture"').store, 'task');
  assert.equal(storeCaptureOf('ideas remember "a thing"').store, 'ideas');
});

test('storeCaptureOf ignores non-captures', () => {
  assert.equal(storeCaptureOf('ls -la'), null);
  assert.equal(storeCaptureOf('brain list'), null);
  assert.equal(storeCaptureOf('none create "x"'), null);
  assert.equal(storeCaptureOf('fm-send.sh task create "x"'), null);
  assert.equal(storeCaptureOf('fm-task create "x"'), null);
  assert.equal(storeCaptureOf('brain create'), null);
  assert.equal(storeCaptureOf(undefined), null);
});

test('ciRollupOf derives existing from the summary', () => {
  const view = s => `pr: x\nchecks: "${s}"\n`;
  assert.equal(ciRollupOf('gh-axi pr view 12', view('3 passed, 0 failed, 3 total')).existing, 'pass');
  assert.equal(ciRollupOf('gh-axi pr checks 12', view('2 passed, 1 failed, 3 total')).existing, 'fail');
  assert.equal(ciRollupOf('gh-axi pr view 12', view('2 passed, 1 pending, 3 total')).existing, 'pending');
  assert.equal(ciRollupOf('gh-axi pr view 12', { stdout: view('1 passed, 1 queued, 2 total') }).existing, 'pending');
});

test('ciRollupOf reads per-check lines', () => {
  assert.equal(ciRollupOf('gh-axi pr checks 1', 'build: success\ntest: failure\n').existing, 'fail');
  assert.equal(ciRollupOf('gh-axi pr checks 1', 'build\tpass\ntest\tpending\n').existing, 'pending');
});

test('ciRollupOf ignores other commands and views without checks', () => {
  assert.equal(ciRollupOf('gh-axi pr view 12', 'title: x\nstate: open\n'), null);
  assert.equal(ciRollupOf('gh-axi issue view 12', 'checks: "1 passed, 1 total"'), null);
  assert.equal(ciRollupOf('ls', 'checks: "1 passed, 1 total"'), null);
  assert.equal(ciRollupOf('gh-axi pr view 12', undefined), null);
});

test('hook queues nothing when JEV_SHADOW is off, a record per seam when on', async () => {
  const root = await tmp();
  const off = await queueShadowObservations({ command: 'brain create "x"', response: null, root, env: {} });
  assert.deepEqual(off, []);
  assert.deepEqual(await readdir(pendingDir(root)).catch(() => []), []);
  const on = await queueShadowObservations({ command: 'brain create "x"', response: null, root, env: { JEV_SHADOW: '1' } });
  assert.equal(on.length, 1);
  await queueShadowObservations({ command: 'gh-axi pr view 3', response: { stdout: 'checks: "1 failed, 1 total"' }, root, env: { JEV_SHADOW: '1' } });
  assert.equal((await readdir(pendingDir(root))).length, 2);
});

test('the claude hook queues on a store capture without logging failure', async () => {
  const root = await tmp();
  const saved = process.env.JEV_SHADOW; process.env.JEV_SHADOW = '1';
  try {
    await handleClaudeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'robots create "hook bug"' }, tool_response: { stdout: 'ok' }, session_id: 's' }, { root, eventName: 'PostToolUse' });
  } finally { if (saved === undefined) delete process.env.JEV_SHADOW; else process.env.JEV_SHADOW = saved; }
  assert.equal((await readdir(pendingDir(root))).length, 1);
});

test('drain is skipped when off and logs both packs via a fake ask when on', async () => {
  const root = await tmp(); const dir = await tmp(); const log = join(dir, 'e.jsonl');
  const on = { JEV_SHADOW: '1', JEV_EVAL_LOG: log };
  await queueShadowObservations({ command: 'brain create "how hooks work"', response: null, root, env: on });
  await queueShadowObservations({ command: 'gh-axi pr checks 3', response: { stdout: 'checks: "2 passed, 1 failed, 3 total"' }, root, env: on });
  assert.deepEqual(await drainShadowPending({ root, env: { JEV_EVAL_LOG: log }, ask: okAsk('brain') }), { drained: 0 });
  assert.equal((await readdir(pendingDir(root))).length, 2);
  assert.deepEqual(await readLog(log), []);
  let calls = 0;
  const ask = async (pack) => { calls++; return okAsk(pack.id === 'ci-rollup' ? 'fail' : 'brain')(); };
  assert.deepEqual(await drainShadowPending({ root, env: on, ask }), { drained: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(pendingDir(root)), []);
  const outcomes = (await readLog(log)).filter(l => l.kind === 'outcome');
  assert.deepEqual(outcomes.map(o => [o.question_id, o.outcome.existing, o.outcome.agree]).sort(), [['ci-rollup/result', 'fail', true], ['store-route/store', 'brain', true]]);
  assert.deepEqual(buildReport(await readLog(log)).map(r => r.pack).sort(), ['ci-rollup', 'store-route']);
});
