import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeRunner } from '../src/bead-actions.ts';
import { forgetEnsuredStores } from '../src/fleet-beads.ts';
import { renderPollerPlist } from '../src/poller-launchd.ts';
import { tailStatusOnce } from '../src/status-tail.ts';
import { JEV_MODEL } from '../src/jev/ask.ts';
import { workerStatusPack } from '../src/jev/questions/v1.ts';
import { buildReport, formatReport, main as reportMain, parseLog } from '../src/jev/shadow-report.ts';
import { EXISTING_FROM_STATE, shadowGuarded, shadowLabel, shadowSettings } from '../src/jev/shadow.ts';
import { withStubs } from '../testlib/stub-env.ts';

const readLog = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const okAsk = (verdict = 'done', confidence = 0.95) => async () => ({ requestId: 'req-1', state: 'done: x', verdict, reason: null, confidence, choice: verdict, latencyMs: 123 });
const tmp = () => mkdtemp(join(tmpdir(), 'fm-shadow-'));

test('EXISTING_FROM_STATE maps every regex state', () => {
  assert.deepEqual(EXISTING_FROM_STATE, { done: 'done', failed: 'done', blocked: 'stuck', working: 'in-progress', paused: 'in-progress', resolved: 'in-progress', 'needs-decision': 'other' });
});

test('shadowLabel logs an outcome on the answer request id; undecided never agrees', async () => {
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  await shadowLabel({ pack: workerStatusPack, raw: 'done: x', existing: 'done', ask: okAsk(), evalLogPath: log });
  await shadowLabel({ pack: workerStatusPack, raw: 'done: x', existing: 'other', ask: okAsk('undecided', 0.4), evalLogPath: log });
  const [a, b] = await readLog(log);
  assert.equal(a.kind, 'outcome'); assert.equal(a.request_id, 'req-1'); assert.equal(a.question_id, 'worker-status/state');
  assert.deepEqual({ ...a.outcome }, { source: 'shadow', existing: 'done', agree: true, jevVerdict: 'done', jevConfidence: 0.95, latencyMs: 123, estimatedTokens: a.outcome.estimatedTokens, model: JEV_MODEL, floor: 0.6 });
  assert.ok(a.outcome.estimatedTokens > 0);
  assert.equal(b.outcome.agree, false);
  await rm(dir, { recursive: true });
});

test('shadowLabel never throws: errors become a shadow-error line with the class name only', async () => {
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  class JevHttpError extends Error { constructor() { super('HTTP 500 secret-body-text'); this.name = 'JevHttpError'; } }
  await shadowLabel({ pack: workerStatusPack, raw: 'x', existing: 'done', ask: async () => { throw new JevHttpError(); }, evalLogPath: log, requestId: 'r9' });
  const text = await readFile(log, 'utf8');
  assert.ok(!text.includes('secret-body-text'));
  const [line] = await readLog(log);
  assert.equal(line.kind, 'shadow-error'); assert.equal(line.error, 'JevHttpError'); assert.equal(line.request_id, 'r9'); assert.equal(line.pack, 'worker-status');
  await rm(dir, { recursive: true });
});

test('an unkeyed real ask records JevKeyUnavailable', async () => {
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  const { JevKeyUnavailable } = await import('../src/jev/keychain.ts');
  try {
    await shadowLabel({ pack: workerStatusPack, raw: 'x', existing: 'done', ask: async () => { throw new JevKeyUnavailable('no entry'); }, evalLogPath: log });
  } finally { if (saved) process.env.TYPESAFE_API_KEY = saved; }
  assert.equal((await readLog(log))[0].error, 'JevKeyUnavailable');
  await rm(dir, { recursive: true });
});

test('shadowGuarded times out a slow call and logs JevShadowTimeout', async () => {
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  const started = Date.now();
  await shadowGuarded({ pack: workerStatusPack, raw: 'x', existing: 'done', ask: () => new Promise(() => {}), evalLogPath: log, timeoutMs: 30 });
  assert.ok(Date.now() - started < 1000);
  assert.equal((await readLog(log))[0].error, 'JevShadowTimeout');
  await rm(dir, { recursive: true });
});

test('shadowSettings defaults and overrides', () => {
  assert.deepEqual(shadowSettings({}), { enabled: false, timeoutMs: 8000, maxPerCycle: 20 });
  assert.deepEqual(shadowSettings({ JEV_SHADOW: '1', JEV_SHADOW_TIMEOUT_MS: '50', JEV_SHADOW_MAX_PER_CYCLE: '2' }), { enabled: true, timeoutMs: 50, maxPerCycle: 2 });
  assert.equal(shadowSettings({ JEV_SHADOW: 'yes', JEV_SHADOW_TIMEOUT_MS: 'x' }).enabled, false);
});

// ---- the tail ----------------------------------------------------------------------------

const scenario = async (extraEnv, shadowAsk) => {
  let out;
  await withStubs(async ({ dir, env, db, writes }) => {
    forgetEnsuredStores();
    await mkdir(join(env.FM_HOME, 'state'), { recursive: true });
    const file = join(env.FM_HOME, 'state', 'task-a.status');
    await writeFile(file, 'working [at=1791600000]: old\n');
    const run = storeRunner(env);
    const e = { ...env, ...extraEnv };
    const now = Date.parse('2026-10-11T12:00:00Z');
    await tailStatusOnce({ root: env.FM_HOOK_QUEUE, env: e, run, now });
    await appendFile(file, 'blocked [at=1791626400]: need a key\nworking [at=1791626500]: unblocked\ndone [at=1791626600]: finished\n');
    const result = await tailStatusOnce({ root: env.FM_HOOK_QUEUE, env: e, run, now, shadowAsk });
    const norm = text => text.split(dir).join('<dir>').replace(/"updated_at":"[^"]+"/g, '"updated_at":"t"');
    out = { result: JSON.parse(norm(JSON.stringify(result))), fleet: norm(JSON.stringify((await db()).fleet)), cursor: (await readFile(join(env.FM_HOOK_QUEUE, 'status-tail', 'cursor.json'), 'utf8')).replace(/"inode":\d+/g, '"inode":0'),
      writes: norm(JSON.stringify((await writes()).map(w => w.argv))) };
  });
  return out;
};

test('with JEV_SHADOW unset the tail never asks Jev', async () => {
  let calls = 0;
  await scenario({}, async () => { calls++; throw new Error('should not be called'); });
  assert.equal(calls, 0);
});

test('a failing or slow Jev changes nothing the tail writes, and the cap bounds the calls', async () => {
  const dir = await tmp();
  const base = await scenario({}, undefined);
  const stripCid = s => s.replace(/"[0-9a-f]{64}"/g, '"cid"');
  let calls = 0; const raws = [];
  const failing = await scenario({ JEV_SHADOW: '1', JEV_EVAL_LOG: join(dir, 'f.jsonl') }, async (pack, raw) => { calls++; raws.push(raw); throw new Error('boom'); });
  const slow = await scenario({ JEV_SHADOW: '1', JEV_SHADOW_TIMEOUT_MS: '20', JEV_SHADOW_MAX_PER_CYCLE: '2', JEV_EVAL_LOG: join(dir, 's.jsonl') }, () => new Promise(() => {}));
  for (const run of [failing, slow]) {
    assert.deepEqual(run.result.recorded, base.result.recorded);
    assert.equal(run.cursor, base.cursor);
    assert.equal(run.fleet, base.fleet);
    assert.equal(run.writes, base.writes);
  }
  assert.equal(calls, 3);
  assert.match(raws[2], /^working \[at=1791600000\]: old\nblocked.*\nworking.*\ndone \[at=1791626600\]: finished$/);
  assert.deepEqual((await readLog(join(dir, 'f.jsonl'))).map(l => l.error), ['Error', 'Error', 'Error']);
  assert.deepEqual((await readLog(join(dir, 's.jsonl'))).map(l => l.error), ['JevShadowTimeout', 'JevShadowTimeout'], 'cap of 2: third line skipped');
  await rm(dir, { recursive: true });
});

test('a healthy fake Jev gets one outcome per recorded line', async () => {
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  await scenario({ JEV_SHADOW: '1', JEV_EVAL_LOG: log }, okAsk('done', 0.9));
  const lines = await readLog(log);
  assert.deepEqual(lines.map(l => l.outcome.existing), ['stuck', 'in-progress', 'done']);
  await rm(dir, { recursive: true });
});

test('the poller plist carries the JEV_SHADOW* and JEV_EVAL_LOG variables when set, and not others', () => {
  const plist = renderPollerPlist({ env: { HOME: '/h', JEV_SHADOW: '1', JEV_SHADOW_TIMEOUT_MS: '5000', JEV_SHADOW_MAX_PER_CYCLE: '10', JEV_EVAL_LOG: '/x/e.jsonl', TYPESAFE_API_KEY: 'sekret', JEV_OTHER: 'z' }, root: '/q' });
  for (const [k, v] of [['JEV_SHADOW', '1'], ['JEV_SHADOW_TIMEOUT_MS', '5000'], ['JEV_SHADOW_MAX_PER_CYCLE', '10'], ['JEV_EVAL_LOG', '/x/e.jsonl']]) {
    assert.match(plist, new RegExp(`<key>${k}</key>\\s*<string>${v.replace(/[/.]/g, '\\$&')}</string>`));
  }
  assert.ok(!plist.includes('sekret') && !plist.includes('JEV_OTHER'));
  assert.ok(!renderPollerPlist({ env: { HOME: '/h' }, root: '/q' }).includes('JEV_'));
});

// ---- the report --------------------------------------------------------------------------

const answer = (id, confidence) => ({ kind: 'answer', timestamp: '2026-10-25T10:00:00.000Z', request_id: id, question_id: 'worker-status/state', confidence });
const outcome = (id, jevVerdict, existing, latencyMs, estimatedTokens = 100) => ({ kind: 'outcome', timestamp: '2026-10-25T10:00:01.000Z', request_id: id, question_id: 'worker-status/state',
  outcome: { source: 'shadow', existing, agree: jevVerdict === existing, jevVerdict, jevConfidence: 0, latencyMs, estimatedTokens } });
const FIXTURE = [
  answer('a', 0.95), outcome('a', 'done', 'done', 100), answer('b', 0.92), outcome('b', 'stuck', 'done', 300),
  answer('c', 0.7), outcome('c', 'done', 'done', 200, 200), answer('d', 0.55), outcome('d', 'undecided', 'done', 400),
  answer('e', 0.3), outcome('e', 'undecided', 'other', 500),
  { kind: 'shadow-error', timestamp: '2026-10-25T10:00:02.000Z', request_id: 'f', pack: 'worker-status', error: 'JevKeyUnavailable' },
  { kind: 'shadow-error', timestamp: '2026-10-25T10:00:02.000Z', request_id: 'g', pack: 'worker-status', error: 'JevKeyUnavailable' },
  { kind: 'outcome', timestamp: '2026-10-25T10:00:03.000Z', request_id: 'z', question_id: 'ci-rollup/result', outcome: { source: 'cascade' } },
];

test('the report bands by the answer line confidence and joins by request id', () => {
  const [pack] = buildReport(FIXTURE);
  assert.equal(pack.pack, 'worker-status');
  const by = Object.fromEntries(pack.bands.map(b => [b.band, b]));
  assert.deepEqual([by['>=0.9'].n, by['>=0.9'].agree, by['>=0.9'].disagree, by['>=0.9'].agreementPct, by['>=0.9'].p50LatencyMs, by['>=0.9'].p95LatencyMs], [2, 1, 1, 50, 100, 300]);
  assert.deepEqual([by['0.6-0.9'].n, by['0.6-0.9'].totalTokens, by['0.6-0.9'].meanTokens], [1, 200, 200]);
  assert.deepEqual([by['0.5-0.6'].undecided, by['0.5-0.6'].agree], [1, 0]);
  assert.equal(by['<0.5'].n, 1);
  assert.deepEqual(pack.errors, { JevKeyUnavailable: 2 });
});

test('the report filters by --pack and --since, and prints text and json', async () => {
  assert.deepEqual(buildReport(FIXTURE, { pack: 'ci-rollup' }), [], 'cascade outcomes are not shadow lines');
  assert.deepEqual(buildReport(FIXTURE, { since: '2026-10-26T00:00:00Z' }), []);
  assert.match(formatReport(buildReport(FIXTURE)), /pack worker-status\n.*band.*agree%[\s\S]*>=0\.9 +2 +1 +1 +0 +50%[\s\S]*shadow errors: JevKeyUnavailable=2/);
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  await writeFile(log, `${FIXTURE.map(l => JSON.stringify(l)).join('\n')}\nnot json\n`);
  assert.equal(parseLog(await readFile(log, 'utf8')).length, FIXTURE.length);
  const out = [];
  assert.equal(await reportMain(['--log', log, '--json', '--pack', 'worker-status'], { log: l => out.push(l) }), 0);
  assert.equal(JSON.parse(out[0])[0].pack, 'worker-status');
  await rm(dir, { recursive: true });
});

// ---- promotion ---------------------------------------------------------------------------

const promoteRun = async (extraEnv, lineText, shadowAsk, { withReport = false } = {}) => {
  const dir = await tmp(); const log = join(dir, 'e.jsonl');
  let out;
  await withStubs(async ({ env, db }) => {
    forgetEnsuredStores();
    await mkdir(join(env.FM_HOME, 'state'), { recursive: true });
    const file = join(env.FM_HOME, 'state', 'task-a.status');
    await writeFile(file, 'working [at=1791600000]: old\n');
    const run = storeRunner(env);
    const e = { ...env, JEV_EVAL_LOG: log, ...extraEnv };
    const now = Date.parse('2026-10-11T12:00:00Z');
    await tailStatusOnce({ root: env.FM_HOOK_QUEUE, env: e, run, now });
    await appendFile(file, lineText);
    const result = await tailStatusOnce({ root: env.FM_HOOK_QUEUE, env: e, run, now, shadowAsk });
    const bead = (await db()).fleet.beads['fleet-task-a'];
    out = { result, labels: bead.labels.filter(l => l.startsWith('fm-state:')), comments: bead.comments.map(c => c.text), fleet: JSON.stringify((await db()).fleet).replace(/"updated_at":"[^"]+"/g, '') };
  });
  out.log = await readLog(log);
  await rm(dir, { recursive: true });
  return out;
};
const ON = { JEV_PROMOTE: 'worker-status:stuck' };
const WORKING = 'working [at=1791626500]: still going\n';

test('promoteSettings accepts only worker-status:stuck; PROMOTE_MIN_CONFIDENCE is 0.9', async () => {
  const { promoteSettings, PROMOTE_MIN_CONFIDENCE } = await import('../src/jev/promote.ts');
  assert.equal(PROMOTE_MIN_CONFIDENCE, 0.9);
  assert.equal(promoteSettings({ JEV_PROMOTE: 'worker-status:stuck' }).enabled, true);
  for (const v of [undefined, '', 'nonsense', '1', 'worker-status', 'worker-status:done']) assert.equal(promoteSettings({ JEV_PROMOTE: v }).enabled, false);
});

test('promotion: stuck 0.95 over a working line records blocked with the suffix and an applied line', async () => {
  const r = await promoteRun(ON, WORKING, okAsk('stuck', 0.95));
  assert.deepEqual(r.labels, ['fm-state:blocked']);
  assert.match(r.comments.at(-1), / status working: still going \[jev: stuck 0\.95, promoted over working\] \(status\//);
  const [p] = r.log.filter(l => l.kind === 'promote');
  assert.deepEqual({ ...p, timestamp: 't' }, { kind: 'promote', timestamp: 't', request_id: 'req-1', pack: 'worker-status', layer: 'jev', existing: 'working', jev_verdict: 'stuck', jev_confidence: 0.95, applied: true, reason: 'applied' });
});

test('promotion: stuck 0.85 is below the band; unchanged', async () => {
  const base = await promoteRun({}, WORKING, undefined);
  const r = await promoteRun(ON, WORKING, okAsk('stuck', 0.85));
  assert.equal(r.fleet, base.fleet);
  assert.deepEqual(r.log.filter(l => l.kind === 'promote').map(l => [l.applied, l.reason]), [[false, 'below-band']]);
});

test('promotion: done 0.99 over a working line is not-stuck; unchanged', async () => {
  const base = await promoteRun({}, WORKING, undefined);
  const r = await promoteRun(ON, WORKING, okAsk('done', 0.99));
  assert.equal(r.fleet, base.fleet);
  assert.deepEqual(r.log.filter(l => l.kind === 'promote').map(l => [l.applied, l.reason]), [[false, 'not-stuck']]);
});

test('promotion: stuck 0.95 over a done line is state-not-promotable and scout capture still runs', async () => {
  const doneLine = 'done [at=1791626600]: finished\n';
  const base = await promoteRun({}, doneLine, undefined);
  const r = await promoteRun(ON, doneLine, okAsk('stuck', 0.95));
  assert.equal(r.fleet, base.fleet);
  const noDir = x => JSON.stringify(x).replace(/fm-hooks-bead-\w+/g, 'D');
  assert.equal(noDir(r.result.recorded[0].scout), noDir(base.result.recorded[0].scout));
  assert.ok('scout' in r.result.recorded[0]);
  assert.deepEqual(r.log.filter(l => l.kind === 'promote').map(l => [l.applied, l.reason]), [[false, 'state-not-promotable']]);
});

test('promotion: a throwing or slow Jev is unavailable; unchanged', async () => {
  const base = await promoteRun({}, WORKING, undefined);
  for (const [extra, ask] of [[{}, async () => { throw new Error('boom'); }], [{ JEV_SHADOW_TIMEOUT_MS: '20' }, () => new Promise(() => {})]]) {
    const r = await promoteRun({ ...ON, ...extra }, WORKING, ask);
    assert.equal(r.fleet, base.fleet);
    assert.deepEqual(r.log.filter(l => l.kind === 'promote').map(l => [l.applied, l.reason, l.jev_verdict]), [[false, 'unavailable', null]]);
  }
});

test('JEV_PROMOTE unset or nonsense: byte-identical results and no Jev call', async () => {
  let calls = 0;
  const base = await promoteRun({}, WORKING, undefined);
  for (const extra of [{}, { JEV_PROMOTE: '' }, { JEV_PROMOTE: 'nonsense' }]) {
    const r = await promoteRun(extra, WORKING, async () => { calls++; throw new Error('no'); });
    assert.equal(r.fleet, base.fleet);
    assert.deepEqual(r.log, []);
  }
  assert.equal(calls, 0);
});

test('JEV_SHADOW=1 with promotion on: one Jev call per line, shadow outcome and promote line both logged', async () => {
  let calls = 0;
  const ask = async () => { calls++; return { requestId: 'req-1', state: 's', verdict: 'stuck', reason: null, confidence: 0.95, choice: 'stuck', latencyMs: 5 }; };
  const r = await promoteRun({ ...ON, JEV_SHADOW: '1' }, WORKING, ask);
  assert.equal(calls, 1);
  assert.deepEqual(r.log.map(l => l.kind).sort(), ['outcome', 'promote']);
  assert.equal(r.log.find(l => l.kind === 'outcome').outcome.jevVerdict, 'stuck');
  assert.equal(r.log.find(l => l.kind === 'promote').applied, true);
  assert.deepEqual(r.labels, ['fm-state:blocked']);
});

test('the poller plist passes JEV_PROMOTE through when set', () => {
  assert.match(renderPollerPlist({ env: { HOME: '/h', JEV_PROMOTE: 'worker-status:stuck' }, root: '/q' }), /<key>JEV_PROMOTE<\/key>\s*<string>worker-status:stuck<\/string>/);
  assert.ok(!renderPollerPlist({ env: { HOME: '/h' }, root: '/q' }).includes('JEV_PROMOTE'));
});

test('the report prints a promote block when promote lines exist', async () => {
  const { buildPromoteBlock, formatPromoteBlock } = await import('../src/jev/shadow-report.ts');
  const p = (applied, reason) => ({ kind: 'promote', timestamp: '2026-10-25T10:00:00.000Z', pack: 'worker-status', applied, reason });
  assert.equal(buildPromoteBlock([]), null);
  const block = buildPromoteBlock([p(true, 'applied'), p(false, 'below-band'), p(false, 'below-band')]);
  assert.deepEqual(block, { candidates: 3, applied: 1, reasons: { applied: 1, 'below-band': 2 } });
  assert.match(formatPromoteBlock(block), /candidates: 3  applied: 1/);
});
