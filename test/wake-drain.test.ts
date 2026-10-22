import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEvent } from '../src/normalize.ts';
import { observe } from '../src/observer.ts';
import { parseDrainOutput } from '../src/wake-drain.ts';

// A fake Firstmate home with the wake queue store the drain reads. The observer must only
// ever read it, so every test that observes a drain compares a full snapshot afterwards.
const HOME_SECRET = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789';
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-wake-drain-'));
  // The fixture home sits under a fake user home, so the home-path scrub is observable.
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  const home = join(dir, 'fm_home', 'mini0-ops'), state = join(home, 'state'), queue = join(dir, 'queue');
  await mkdir(state, { recursive: true });
  const rows = [
    [1792019075, 3414, 'check', 'startup-network', `check: ${state}/startup-network.sh: network is down ${HOME_SECRET}`],
    [1792659850, 4234, 'signal', 'gnhf-a11y-2.status', `signal: ${state}/gnhf-a11y-2.status`],
    [1792659851, 4235, 'signal', 'brain-registry.status', `signal: ${state}/brain-registry.status`],
    [1792659852, 4236, 'stale', 'default:w6:p2V', 'stale: default:w6:p2V'],
    [1792659853, 4237, 'heartbeat', 'beat-1', 'heartbeat: alive'],
    [1792659854, 4238, 'heartbeat', 'beat-2', 'heartbeat: still alive'],
    [1792659855, 4239, 'signal', 'reserved.status', `signal: ${state}/reserved.status`],
  ];
  await writeFile(join(state, '.wake-queue'), rows.map(row => row.join('\t')).join('\n') + '\n');
  await writeFile(join(state, '.main-eligible-rows'), '3414\n4234\n4235\n4236\n4237\n4238\n');
  await writeFile(join(state, '.watcher-down'), 'announced:handling:7056.1792655096.m0nGWX\n');
  await writeFile(join(state, 'brain-registry.status'),
    'working [at=1792659000]: earlier\nneeds-decision [at=1792659853] [key=nm-converge-stores]: need the store location, see /Users/someone/data/x\n');
  await writeFile(join(state, 'gnhf-a11y-2.status'), 'working [at=1792659100]: setup done\n');
  const now = 1792659900;
  await writeFile(join(state, 'branch-outcomes.jsonl'), [
    { seq: 1178, epoch: now - 7200, task: 'old', wake: 'w', verdict: 'captain', summary: 'processed already', silent: false },
    { seq: 1179, epoch: now - 600, task: 'vrms', wake: 'w', verdict: 'routine', summary: 'routine note', silent: false },
    { seq: 1180, epoch: now - 120, task: 'vrms-2166', wake: 'w', verdict: 'captain', summary: `PR is mergeable ${HOME_SECRET}`, silent: false },
    { seq: 1181, epoch: now - 60, task: 'quiet', wake: 'w', verdict: 'captain', summary: 'silent one', silent: true },
    { seq: 1182, epoch: now, task: 'later', wake: 'w', verdict: 'captain', summary: 'newer than the cursor', silent: false },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(state, '.branch-outcomes-processed'), '1178\n');
  await writeFile(join(state, '.branch-outcomes-cursor'), '1181\n');
  const snapshot = async () => {
    const out = {};
    const walk = async directory => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), info = await stat(path);
        out[path.slice(home.length)] = info.isDirectory() ? 'dir' : [info.size, info.mtimeMs, await readFile(path, 'utf8')];
        if (info.isDirectory()) await walk(path);
      }
    };
    await walk(home);
    return out;
  };
  try { await fn({ dir, home, state, queue, now, snapshot, env: { FM_HOME: home } }); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}

const DRAIN = home => `H=${home}; $H/bin/fm-wake-drain.sh 2>&1 | head -40`;
const call = (home, extra: Record<string, any> = {}) => ({ harness: 'claude-code', sessionId: 's-1', callId: 'toolu_drain', rawCommand: DRAIN(home),
  cwd: home, outcome: 'success', finishedAt: '2026-10-22T10:00:00.000Z',
  resultMetadata: { stdout: '1792019075\t3414\tcheck\tstartup-network\tcheck: truncated by head', stderr: '' }, ...extra });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const logOf = async queue => (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('a successful drain writes a wake-drain record with the drain call\'s correlation id', async () => fixture(async ({ home, queue, env }) => {
  const [result] = await observe(call(home), { root: queue, rules: [], env, now: 1792659900 });
  const drain = result.event;
  const files = await readdir(join(queue, 'wake-drain'));
  assert.deepEqual(files, [`${drain.correlationId}.json`]);
  const record = await readJson(join(queue, 'wake-drain', files[0]));
  assert.equal(record.type, 'wake-drain');
  assert.equal(record.operation, 'fm-wake-drain.sh');
  assert.equal(record.correlationId, drain.correlationId);
  assert.equal(record.sessionId, 's-1');
  assert.equal(record.callId, 'toolu_drain');
  assert.equal(record.harness, 'claude-code');
  assert.equal(record.finishedAt, '2026-10-22T10:00:00.000Z');
  // The drain event itself is exactly what it was: a second record next to it, not a rewrite.
  assert.ok((await readdir(join(queue, 'events'))).includes(`${drain.correlationId}-fm-wake-drain.sh.json`));
  assert.equal((await readdir(join(queue, 'events'))).length, 1);
  const log = await logOf(queue);
  assert.deepEqual(log.map(entry => entry.type), ['event', 'wake-drain']);
  assert.equal(log[1].correlationId, drain.correlationId);
}));

test('rows come from the wake queue store, deduped like the drain, limited to the claimed rows, with the ack cutoff and generation', async () => fixture(async ({ home, queue, env, state }) => {
  const [{ event }] = await observe(call(home), { root: queue, rules: [], env, now: 1792659900 });
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.equal(record.ackThrough, 4238, 'the highest presented row, though head cut the WAKE_ACK_REQUIRED line off');
  assert.equal(record.recoveryGeneration, '7056.1792655096.m0nGWX');
  assert.equal(record.rowsSource, 'claim');
  assert.deepEqual(record.rows.map(row => [row.seq, row.kind, row.name]), [
    [3414, 'check', 'startup-network'], [4234, 'signal', 'gnhf-a11y-2.status'], [4235, 'signal', 'brain-registry.status'],
    [4236, 'stale', 'default:w6:p2V'], [4238, 'heartbeat', 'beat-2'],
  ], 'heartbeats collapse to the newest, and row 4239 (not claimed) is absent');
  assert.equal(record.rows[0].epoch, 1792019075);
  assert.match(record.rows[0].text, /^check: ~\/fm_home\/mini0-ops\/state\/startup-network\.sh: network is down \[redacted\]$/);
  assert.ok(!JSON.stringify(record).includes(HOME_SECRET));
  assert.ok(!JSON.stringify(record).includes(state), 'no absolute home path');
}));

test('the full output is preferred for the ack cutoff and generation, and open decisions are read from it', async () => fixture(async ({ home, queue, env }) => {
  const stdout = [
    '1792659854\t4238\theartbeat\tbeat-2\theartbeat: still alive',
    'WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 4238 --recovery-generation 99.1.abcDEF',
    'OPEN DECISIONS (still open, folded from the durable status logs - not just the latest line):',
    'brain-registry [key=nm-converge-stores] needs-decision: need the store location, gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789 at /Users/someone/x',
    'gnhf-a11y-2 blocked: waiting on review',
    "OPEN DECISIONS: close one by answering it: bin/fm-send.sh <task> --resolve-key <key> '<answer>'",
  ].join('\n');
  const [{ event }] = await observe(call(home, { rawCommand: `${home}/bin/fm-wake-drain.sh`, resultMetadata: { stdout, stderr: '' } }),
    { root: queue, rules: [], env, now: 1792659900 });
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.equal(record.ackThrough, 4238);
  assert.equal(record.recoveryGeneration, '99.1.abcDEF');
  assert.equal(record.openDecisionsSource, 'output');
  assert.deepEqual(record.openDecisions, [
    'brain-registry [key=nm-converge-stores] needs-decision: need the store location, [redacted] at ~/x',
    'gnhf-a11y-2 blocked: waiting on review',
  ]);
}));

test('the annotation is the newest status line of the newest signalling task, and branch outcomes are the unprocessed captain rows', async () => fixture(async ({ home, queue, env }) => {
  const [{ event }] = await observe(call(home), { root: queue, rules: [], env, now: 1792659900 });
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.deepEqual(record.annotation, { task: 'brain-registry', state: 'needs-decision', at: 1792659853, key: 'nm-converge-stores',
    text: 'need the store location, see ~/data/x' });
  assert.deepEqual(record.branchOutcomes, [{ seq: 1180, recordedMinutesAgo: 2, task: 'vrms-2166', text: 'PR is mergeable [redacted]' }],
    'processed (1178), routine (1179), silent (1181) and not-yet-presented (1182) rows are excluded');
  assert.deepEqual(record.openDecisions, []);
  assert.equal(record.openDecisionsSource, 'unavailable');
}));

test('building the record reads the Firstmate home and changes nothing in it', async () => fixture(async ({ home, queue, env, snapshot }) => {
  const before = await snapshot();
  await observe(call(home), { root: queue, rules: [], env, now: 1792659900 });
  await observe(call(home), { root: queue, rules: [], env, now: 1792659901 });
  assert.deepEqual(await snapshot(), before, 'no write, no ack, no drain, no new file inside the home');
  assert.ok((await readFile(join(home, 'state', '.wake-queue'), 'utf8')).includes('\t4239\t'));
}));

test('a repeated delivery keeps the first record and still appends to the log', async () => fixture(async ({ home, queue, env }) => {
  const [{ event }] = await observe(call(home), { root: queue, rules: [], env, now: 1792659900 });
  await writeFile(join(home, 'state', '.wake-queue'), '');
  await observe(call(home), { root: queue, rules: [], env, now: 1792660000 });
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.equal(record.rows.length, 5);
  assert.equal((await logOf(queue)).filter(entry => entry.type === 'wake-drain').length, 2);
}));

test('no wake-drain record for an acknowledgement, a failed or unknown drain, or any other call', async () => fixture(async ({ home, queue, env }) => {
  const ack = call(home, { callId: 'ack', rawCommand: `${home}/bin/fm-wake-drain.sh --ack-through 4238 --recovery-generation 7056.1792655096.m0nGWX` });
  await observe(ack, { root: queue, rules: [], env });
  await observe(call(home, { callId: 'failed', outcome: 'failure' }), { root: queue, rules: [], env });
  await observe(call(home, { callId: 'unknown', outcome: 'unknown' }), { root: queue, rules: [], env });
  await observe(call(home, { callId: 'send', rawCommand: `${home}/bin/fm-send.sh task hi` }), { root: queue, rules: [], env });
  assert.deepEqual(await readdir(queue).then(names => names.filter(name => name === 'wake-drain')), []);
  assert.deepEqual((await logOf(queue)).filter(entry => entry.type === 'wake-drain'), []);
  assert.equal((await readdir(join(queue, 'events'))).length, 4, 'every call still has its ordinary event');
}));

test('a drain made from another directory still finds its home from the command', async () => fixture(async ({ home, queue, dir }) => {
  const [{ event }] = await observe(call(home, { cwd: join(dir, 'elsewhere') }), { root: queue, rules: [], env: {}, now: 1792659900 });
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.equal(record.rowsSource, 'claim');
  assert.equal(record.rows.length, 5);
}));

test('without a resolvable Firstmate home the record carries what the output proves and says the rows are missing', async () => fixture(async ({ queue, dir }) => {
  const stdout = 'WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 77 --recovery-generation 5.6.xyz';
  const [{ event }] = await observe(call(dir, { cwd: dir, rawCommand: 'fm-wake-drain.sh', resultMetadata: { stdout, stderr: '' } }),
    { root: queue, rules: [], env: {} });
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.equal(record.ackThrough, 77);
  assert.equal(record.recoveryGeneration, '5.6.xyz');
  assert.deepEqual(record.rows, []);
  assert.equal(record.rowsSource, 'unavailable');
  assert.equal(record.annotation, null);
  assert.deepEqual(record.branchOutcomes, []);
}));

test('an unreadable store never fails the observation of the drain', async () => fixture(async ({ home, queue, env, state }) => {
  await rm(join(state, '.wake-queue'));
  await mkdir(join(state, '.wake-queue'));
  const [{ event }] = await observe(call(home), { root: queue, rules: [], env });
  assert.equal(event.operation, 'fm-wake-drain.sh');
  const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
  assert.equal(record.rowsSource, 'unavailable');
}));

test('stderr and OpenCode output are searched for the cutoff too', async () => fixture(async ({ home, queue, env }) => {
  const line = 'WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 4238 --recovery-generation 12.34.zz';
  const a = await observe(call(home, { callId: 'a', resultMetadata: { stdout: '', stderr: line } }), { root: queue, rules: [], env });
  const b = await observe(call(home, { callId: 'b', harness: 'opencode', resultMetadata: null, source: { eventName: 'tool.execute.after', output: line } }),
    { root: queue, rules: [], env });
  for (const [{ event }] of [a, b]) {
    const record = await readJson(join(queue, 'wake-drain', `${event.correlationId}.json`));
    assert.equal(record.ackThrough, 4238);
    assert.equal(record.recoveryGeneration, '12.34.zz');
  }
}));

test('parseDrainOutput finds the cutoff, generation and open decisions and ignores everything else', () => {
  assert.deepEqual(parseDrainOutput('nothing here'), { ackThrough: null, recoveryGeneration: null, openDecisions: [] });
  const parsed = parseDrainOutput('x\nWAKE_ACK_REQUIRED: run bin/fm-wake-drain.sh --ack-through 0 --recovery-generation 1.2.3\n');
  assert.equal(parsed.ackThrough, 0);
  assert.equal(parsed.recoveryGeneration, '1.2.3');
  // A text that merely mentions the flag in prose is not a cutoff without the generation.
  assert.equal(parseDrainOutput('use --ack-through 5 later').ackThrough, null);
});

test('normalizeEvent output for a drain call is unchanged by the wake-drain addition', () => {
  const [event] = normalizeEvent({ harness: 'claude-code', sessionId: 's', callId: 'c', rawCommand: 'fm-wake-drain.sh', outcome: 'success' });
  assert.deepEqual(Object.keys(event).sort(), ['args', 'callId', 'correlationId', 'cwd', 'durationMs', 'exitCode', 'finishedAt',
    'harness', 'operation', 'outcome', 'project', 'rawCommand', 'resultMetadata', 'sessionId', 'source', 'startedAt']);
});
