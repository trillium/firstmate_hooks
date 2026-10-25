import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASCADE_FLOOR, decide, DESTRUCTIVE_THRESHOLD } from '../src/jev/cascade.ts';
import { buildBigPrompt, createBigModel, parseBigReply } from '../src/jev/big-model.ts';
import { humanDescription, humanTitle } from '../src/jev/human-queue.ts';
import { answerLine, recordOutcome } from '../src/jev/eval-log.ts';
import { UNDECIDED, workerStatusPack } from '../src/jev/questions/v1.ts';

const RAW = 'working [at=1792000000]: starting\ndone [at=1792000100]: PR https://github.com/o/r/pull/1';
const jevResult = (verdict: string, confidence: number, choice = verdict, reason: string | null = null) => ({ requestId: 'req-1', state: 'STATE', verdict, reason, confidence, choice });
const fakes = (jev: any, big?: any) => {
  const calls = { jev: 0, big: [] as any[], human: [] as any[] };
  return {
    calls,
    opts: {
      askPack: async () => { calls.jev++; return jev; },
      bigModel: async (input: any) => { calls.big.push(input); return big ?? { verdict: UNDECIDED, reason: 'exit', confidence: 0.9, choice: 'other' }; },
      humanQueue: async (item: any) => { calls.human.push(item); return { id: 'review-abc' }; },
      evalLogPath: null,
    },
  };
};
const bigVerdict = (verdict: string, confidence: number) => ({ verdict, reason: null, confidence, choice: verdict });

test('constants', () => {
  assert.equal(CASCADE_FLOOR, 0.5);
  assert.equal(DESTRUCTIVE_THRESHOLD, 0.9);
});

test('jev confident decides at the jev layer and nothing else is called', async () => {
  const f = fakes(jevResult('done', 0.8));
  const d = await decide(workerStatusPack, RAW, f.opts);
  assert.equal(d.layer, 'jev'); assert.equal(d.verdict, 'done'); assert.equal(d.confidence, 0.8);
  assert.equal(f.calls.big.length, 0); assert.equal(f.calls.human.length, 0);
});

test('jev exit escalates to the big model, which sees the jev guess and the prefiltered state', async () => {
  const f = fakes(jevResult(UNDECIDED, 0.95, 'other', 'exit'), bigVerdict('stuck', 0.8));
  const d = await decide(workerStatusPack, RAW, f.opts);
  assert.equal(d.layer, 'big'); assert.equal(d.verdict, 'stuck');
  assert.equal(f.calls.big.length, 1);
  const input = f.calls.big[0];
  assert.deepEqual(input.jevGuess, { verdict: UNDECIDED, reason: 'exit', confidence: 0.95, choice: 'other' });
  assert.equal(input.state, 'STATE');
  assert.equal(input.pack, workerStatusPack);
  assert.equal(JSON.stringify(input).includes('github.com'), false);
});

test('jev low confidence, big confident -> big layer', async () => {
  const f = fakes(jevResult(UNDECIDED, 0.3, 'done', 'low-confidence'), bigVerdict('done', 0.7));
  const d = await decide(workerStatusPack, RAW, f.opts);
  assert.equal(d.layer, 'big'); assert.equal(d.confidence, 0.7);
  assert.equal(f.calls.big[0].jevGuess.choice, 'done');
});

test('big undecided -> human queue -> human layer', async () => {
  const f = fakes(jevResult(UNDECIDED, 0.3, 'done', 'low-confidence'));
  const d = await decide(workerStatusPack, RAW, f.opts);
  assert.equal(d.layer, 'human'); assert.equal(d.verdict, UNDECIDED); assert.equal(d.humanId, 'review-abc');
  assert.equal(f.calls.human.length, 1);
  assert.equal(f.calls.human[0].state, 'STATE');
  assert.equal(f.calls.human[0].jev.choice, 'done');
  assert.equal(f.calls.human[0].big.choice, 'other');
});

test('big below the floor goes to the human queue', async () => {
  const f = fakes(jevResult(UNDECIDED, 0.3, 'done', 'low-confidence'), bigVerdict('done', 0.4));
  assert.equal((await decide(workerStatusPack, RAW, f.opts)).layer, 'human');
});

test('irreversible calls no model and queues the item', async () => {
  const f = fakes(jevResult('done', 0.99));
  const d = await decide(workerStatusPack, RAW, { ...f.opts, irreversible: true });
  assert.equal(d.layer, 'human'); assert.equal(d.reason, 'irreversible'); assert.equal(d.humanId, 'review-abc');
  assert.equal(f.calls.jev, 0); assert.equal(f.calls.big.length, 0); assert.equal(f.calls.human.length, 1);
});

test('destructive at 0.85 jev confidence escalates; the big model also needs 0.9', async () => {
  const f = fakes(jevResult('done', 0.85), bigVerdict('done', 0.85));
  const d = await decide(workerStatusPack, RAW, { ...f.opts, destructive: true });
  assert.equal(f.calls.big.length, 1);
  assert.equal(d.layer, 'human');
  const g = fakes(jevResult('done', 0.85), bigVerdict('done', 0.92));
  assert.equal((await decide(workerStatusPack, RAW, { ...g.opts, destructive: true })).layer, 'big');
});

test('destructive at 0.95 decides at the jev layer', async () => {
  const f = fakes(jevResult('done', 0.95));
  const d = await decide(workerStatusPack, RAW, { ...f.opts, destructive: true });
  assert.equal(d.layer, 'jev'); assert.equal(f.calls.big.length, 0);
});

test('big model unavailable (undecided or throwing) -> human', async () => {
  const f = fakes(jevResult(UNDECIDED, 0.2, 'done', 'low-confidence'), { verdict: UNDECIDED, reason: 'unavailable', confidence: 0, choice: '' });
  assert.equal((await decide(workerStatusPack, RAW, f.opts)).layer, 'human');
  const g = fakes(jevResult(UNDECIDED, 0.2, 'done', 'low-confidence'));
  const d = await decide(workerStatusPack, RAW, { ...g.opts, bigModel: async () => { throw new Error('boom'); } });
  assert.equal(d.layer, 'human'); assert.equal(g.calls.human.length, 1);
});

test('jev throwing escalates; failing human queue still returns layer human', async () => {
  const f = fakes(jevResult('done', 0.9), bigVerdict('done', 0.7));
  const d = await decide(workerStatusPack, RAW, { ...f.opts, askPack: async () => { throw new Error('network'); } });
  assert.equal(d.layer, 'big');
  const h = await decide(workerStatusPack, RAW, { ...fakes(jevResult(UNDECIDED, 0, 'other', 'exit')).opts, humanQueue: async () => null });
  assert.equal(h.layer, 'human'); assert.equal(h.humanId, null);
});

test('writes one cascade eval-log line per decide', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-cascade-'));
  try {
    const path = join(dir, 'eval.jsonl');
    const f = fakes(jevResult(UNDECIDED, 0.3, 'done', 'low-confidence'));
    await decide(workerStatusPack, RAW, { ...f.opts, evalLogPath: path, destructive: true });
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0], timestamp: undefined }, {
      kind: 'cascade', timestamp: undefined, request_id: 'req-1', pack: 'worker-status', layer: 'human',
      jev_confidence: 0.3, big_confidence: 0.9, irreversible: false, destructive: true, human_id: 'review-abc',
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('answerLine and recordOutcome take an optional layer, default jev', async () => {
  const answer = { id: 'q', kind: 'choice', value: 'a', distribution: {}, confidence: 1 };
  assert.equal(answerLine({ requestId: 'r', answer, model: 'm', latencyMs: 1 }).layer, 'jev');
  assert.equal(answerLine({ requestId: 'r', answer, model: 'm', latencyMs: 1, layer: 'big' }).layer, 'big');
  const dir = await mkdtemp(join(tmpdir(), 'jev-cascade-'));
  try {
    const path = join(dir, 'e.jsonl');
    await recordOutcome('r', 'q', true, path);
    await recordOutcome('r', 'q', false, path, new Date(), 'big');
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => l.layer), ['jev', 'big']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- default adapters, with fakes (the real CLI is never run) ----

const envelope = (result: string, extra = {}) => JSON.stringify({ type: 'result', is_error: false, result, ...extra });
const bigInput = { pack: workerStatusPack, state: 'done: shipped', questions: workerStatusPack.questions, jevGuess: { verdict: UNDECIDED, reason: 'exit', confidence: 0.6, choice: 'other' } as any };

test('big prompt lists the fixed choices, the state and the jev guess', () => {
  const prompt = buildBigPrompt(bigInput);
  for (const c of ['done', 'stuck', 'in-progress', 'other']) assert.ok(prompt.includes(`- ${c}:`));
  assert.ok(prompt.includes('done: shipped')); assert.ok(prompt.includes('"other"')); assert.ok(prompt.includes('0.6'));
});

test('default big model decodes with the pack rule and never throws', async () => {
  const seen: any[] = [];
  const mk = (run: any) => createBigModel({ run, env: {} });
  const ok = await mk(async (p: string, m: string, t: number) => { seen.push([m, t]); return envelope('```json\n{"choice":"done","confidence":0.8}\n```'); })(bigInput);
  assert.equal(ok.verdict, 'done'); assert.deepEqual(seen[0], ['claude-sonnet-5-5', 60_000]);
  assert.equal((await mk(async () => envelope('{"choice":"other","confidence":0.9}'))(bigInput)).reason, 'exit');
  assert.equal((await mk(async () => envelope('{"choice":"done","confidence":0.1}'))(bigInput)).reason, 'low-confidence');
  for (const bad of [async () => { throw new Error('timeout'); }, async () => 'not json', async () => envelope('no json here'), async () => envelope('{"choice":"done"}'), async () => envelope('x', { is_error: true })]) {
    const v = await mk(bad)(bigInput);
    assert.equal(v.verdict, UNDECIDED); assert.equal(v.reason, 'unavailable');
  }
  assert.equal(parseBigReply('{"choice":"a","confidence":2}'), null);
});

test('JEV_BIG_MODEL picks the model', async () => {
  let model = '';
  await createBigModel({ run: async (_p, m) => { model = m; return envelope('{}'); }, env: { JEV_BIG_MODEL: 'claude-opus-5-5' } })(bigInput);
  assert.equal(model, 'claude-opus-5-5');
});

test('human bead carries only the prefiltered state', () => {
  const item = { pack: workerStatusPack, state: 'done: shipped', jev: { verdict: UNDECIDED, reason: 'exit', confidence: 0.6, choice: 'other' }, reason: 'big-unavailable' };
  assert.equal(humanTitle(item), 'worker-status needs a call: done: shipped');
  const body = humanDescription(item);
  assert.ok(body.includes('jev: other @ 0.60')); assert.ok(body.includes('big: not asked')); assert.ok(body.includes('big-unavailable'));
});
