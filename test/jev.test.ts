import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, JEV_MODEL, JevHttpError, JevNetworkError, JevRequestTooLarge } from '../src/jev/ask.ts';
import { recordOutcome } from '../src/jev/eval-log.ts';
import { readApiKey } from '../src/jev/keychain.ts';

const KEY = 'sk-secret-key-123';
const fixture = async fn => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-jev-'));
  try { await fn(join(dir, 'eval.jsonl')); } finally { await rm(dir, { recursive: true, force: true }); }
};
const questions: any[] = [
  { id: 'mood', kind: 'choice', instructions: 'Mood?', options: { angry: 'a', calm: 'c' }, threshold: 0.7 },
  { id: 'urgency', kind: 'score', instructions: 'How urgent?', levels: ['can wait', 'now'] },
  { id: 'billing', kind: 'yesno', instructions: 'Billing?' },
];
const reply = {
  model: 'jev-1.13.0-r2',
  answers: {
    q0: { type: 'choice', choice: 'calm', confidence: 0.8, probabilities: { angry: 0.2, calm: 0.8 } },
    q1: { type: 'score', score: 0.75, confidence: 0.75, legend: { 0: 'can wait', 1: 'now' }, probabilities: { 0: 0.25, 1: 0.75 } },
    q2: { type: 'noul', noul: 0.98 },
  },
  usage: { input_tokens: 10, output_tokens: 3 },
};
const fakeFetch = (calls, status = 200, payload: any = reply) => async (url, init) => {
  calls.push({ url, init });
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
};

test('one call carries every question, pins the model, and never sends ids', async () => fixture(async log => {
  const calls: any[] = [];
  const result = await ask({ text: 'hi' }, questions, { fetch: fakeFetch(calls), apiKey: KEY, evalLogPath: log });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, JEV_MODEL);
  assert.equal(JEV_MODEL, 'jev-1.13.0');
  assert.equal(Object.keys(sent.questions).length, 3);
  assert.equal(sent.questions.q2.type, 'noul');
  assert.deepEqual(sent.questions.q1.criteria, ['can wait', 'now']);
  assert.ok(!calls[0].init.body.includes('mood'), 'ids stay caller-side');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  const [mood, urgency, billing] = result.answers;
  assert.deepEqual(mood, { id: 'mood', kind: 'choice', value: 'calm', distribution: { angry: 0.2, calm: 0.8 }, confidence: 0.8 });
  assert.equal(urgency.value, 0.75);
  assert.deepEqual(urgency.distribution, { 0: 0.25, 1: 0.75 });
  assert.equal(billing.value, true);
  assert.equal(billing.confidence, 0.98);
  assert.ok(Math.abs(billing.distribution.false - 0.02) < 1e-9);
}));

test('too-large state throws JevRequestTooLarge before any request', async () => {
  const calls: any[] = [];
  await assert.rejects(ask('x'.repeat(300_000), questions, { fetch: fakeFetch(calls), apiKey: KEY, evalLogPath: null }), JevRequestTooLarge);
  assert.equal(calls.length, 0);
});

test('non-2xx throws a typed error with the status and never the key', async () => {
  const calls: any[] = [];
  const error: any = await ask('s', questions, { fetch: fakeFetch(calls, 401, `bad key ${KEY}`), apiKey: KEY, evalLogPath: null }).catch(e => e);
  assert.ok(error instanceof JevHttpError);
  assert.equal(error.status, 401);
  assert.match(error.message, /401/);
  assert.ok(!error.message.includes(KEY) && !error.body.includes(KEY));
  const net: any = await ask('s', questions, { fetch: async () => { throw new Error(`boom ${KEY}`); }, apiKey: KEY, evalLogPath: null }).catch(e => e);
  assert.ok(net instanceof JevNetworkError);
  assert.ok(!net.message.includes(KEY));
});

test('eval log: one line per question with every field; recordOutcome appends without rewriting', async () => fixture(async log => {
  const t = [1000, 1120];
  const result = await ask('s', questions, { fetch: fakeFetch([]), apiKey: KEY, evalLogPath: log, now: () => t.shift() });
  const before = await readFile(log, 'utf8');
  const lines = before.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const l of lines) {
    for (const f of ['timestamp', 'request_id', 'question_id', 'question_kind', 'model', 'distribution', 'chosen', 'confidence', 'threshold', 'layer', 'latency_ms', 'outcome']) assert.ok(f in l, f);
    assert.equal(l.request_id, result.requestId);
    assert.equal(l.layer, 'jev');
    assert.equal(l.model, 'jev-1.13.0-r2');
    assert.equal(l.latency_ms, 120);
    assert.equal(l.outcome, null);
  }
  assert.equal(lines[0].threshold, 0.7);
  assert.equal(lines[1].threshold, null);
  assert.ok(!before.includes(KEY));
  await recordOutcome(result.requestId, 'mood', 'accepted', log);
  const after = await readFile(log, 'utf8');
  assert.ok(after.startsWith(before), 'earlier lines untouched');
  const last = JSON.parse(after.trim().split('\n').pop());
  assert.deepEqual([last.kind, last.request_id, last.question_id, last.outcome], ['outcome', result.requestId, 'mood', 'accepted']);
}));

test('readApiKey prefers the env override, else reads the Keychain without leaking stderr', () => {
  assert.equal(readApiKey({ TYPESAFE_API_KEY: ' k ' } as any), 'k');
  let args;
  const run: any = (cmd, a) => { args = [cmd, ...a]; return { status: 0, stdout: 'kc-key\n' }; };
  assert.equal(readApiKey({} as any, run), 'kc-key');
  assert.deepEqual(args, ['security', 'find-generic-password', '-s', 'typesafe-jev', '-w']);
  assert.throws(() => readApiKey({} as any, (() => ({ status: 44, stdout: '' })) as any), /typesafe-jev/);
});

test.skipIf(process.env.JEV_LIVE !== '1')('live smoke: three trivial questions in one call', async () => {
  const result = await ask('The package arrived two days late and the box was crushed.', [
    { id: 'late', kind: 'yesno', instructions: 'Was something late?' },
    { id: 'tone', kind: 'choice', instructions: 'Overall tone?', options: { negative: 'unhappy', neutral: 'neutral', positive: 'happy' } },
    { id: 'sev', kind: 'score', instructions: 'How severe is the problem?', levels: ['trivial', 'moderate', 'severe'] },
  ], { evalLogPath: null });
  console.log(JSON.stringify({ model: result.model, latencyMs: result.latencyMs, answers: result.answers }));
  assert.equal(result.answers.length, 3);
});
