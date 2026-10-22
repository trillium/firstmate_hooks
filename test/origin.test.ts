import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleClaudeHook } from '../src/claude-events.ts';
import { machineName, nextSeq, SCHEMA_VERSION, stampRecord } from '../src/origin.ts';
import { resolveFmHome } from '../src/fm-home.ts';
import { observe } from '../src/observer.ts';
import { appendEventLog } from '../src/queue.ts';
import { watchQueue } from '../src/worker.ts';

const HOOK = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-origin-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try { await fn({ dir, queue: join(dir, 'queue') }); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}
const logOf = async queue => (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) if (value === undefined) delete process.env[key]; else process.env[key] = value as string;
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value as string;
  }
};

test('every record in the log carries seq, fmHome, machine and the schema version', async () => fixture(async ({ dir, queue }) => {
  const home = join(dir, 'fm_home', 'mini0-ops');
  await withEnv({ FM_HOME: home, FM_HOOK_MACHINE: 'mini0' }, async () => {
    await observe({ harness: 'claude-code', sessionId: 's', callId: 'c1', rawCommand: 'fm-send.sh task hi', cwd: '/elsewhere', outcome: 'success' }, { root: queue, rules: [] });
    await handleClaudeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's', tool_use_id: 'c2', tool_input: { command: 'ls' } }, { root: queue, eventName: 'PostToolUse' });
    await handleClaudeHook({ hook_event_name: 'Stop', session_id: 's' }, { root: queue, eventName: 'Stop' });
    await watchQueue({ root: queue, intervalMs: 5, beatMs: 0, maxCycles: 1 });
  });
  const log = await logOf(queue);
  assert.deepEqual([...new Set(log.map(entry => entry.type))].sort(), ['event', 'seen', 'turn-end', 'worker']);
  for (const entry of log) {
    assert.equal(entry.schemaVersion, SCHEMA_VERSION, entry.type);
    assert.equal(entry.machine, 'mini0', entry.type);
    assert.equal(entry.fmHome, '~/fm_home/mini0-ops', `${entry.type}: the home, with the user's home directory written as ~`);
    assert.ok(Number.isInteger(entry.seq) && entry.seq >= 1, entry.type);
  }
  const seqs = log.map(entry => entry.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'the log is in seq order when records are written one after another');
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1), 'no gaps');
}));

test('seq is per queue: a second queue starts at 1 and the first is unaffected', async () => fixture(async ({ dir }) => {
  const [a, b] = [join(dir, 'a'), join(dir, 'b')];
  for (const root of [a, a, b, a, b]) await appendEventLog({ type: 'seen' }, root);
  assert.deepEqual((await logOf(a)).map(entry => entry.seq), [1, 2, 3]);
  assert.deepEqual((await logOf(b)).map(entry => entry.seq), [1, 2]);
}));

test('the event file and its first log line share a seq; a repeated delivery logs a new one', async () => fixture(async ({ queue }) => {
  const input = { harness: 'claude-code', sessionId: 's', callId: 'c1', rawCommand: 'fm-send.sh task hi', cwd: '/x', outcome: 'success' };
  const [{ event }] = await observe(input, { root: queue, rules: [] });
  await observe(input, { root: queue, rules: [] });
  const file = JSON.parse(await readFile(join(queue, 'events', `${event.correlationId}-fm-send.sh.json`), 'utf8'));
  const log = await logOf(queue);
  assert.equal(file.seq, log[0].seq);
  assert.equal(log[1].seq, log[0].seq + 1);
  assert.equal(file.schemaVersion, SCHEMA_VERSION);
  assert.equal(typeof file.machine, 'string');
}));

test('the derived records are stamped too, and their file and log line agree', async () => fixture(async ({ dir, queue }) => {
  const home = join(dir, 'fm_home', 'mini0-ops');
  await mkdir(join(home, 'state'), { recursive: true });
  await writeFile(join(home, 'state', '.wake-queue'), '1\t5\tsignal\tx.status\tsignal: x\n');
  const [{ event }] = await observe({ harness: 'claude-code', sessionId: 's', callId: 'c1', rawCommand: 'bin/fm-wake-drain.sh', cwd: home, outcome: 'success' },
    { root: queue, rules: [], env: {} });
  const record = JSON.parse(await readFile(join(queue, 'wake-drain', `${event.correlationId}.json`), 'utf8'));
  const logged = (await logOf(queue)).find(entry => entry.type === 'wake-drain');
  assert.equal(record.seq, logged.seq);
  assert.equal(record.fmHome, '~/fm_home/mini0-ops');
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
}));

test('concurrent hook processes never share a seq', async () => fixture(async ({ queue }) => {
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's', tool_use_id: 'c', tool_input: { command: 'ls' } });
  const runs = Array.from({ length: 16 }, () => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, FM_HOOK_QUEUE: queue }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('close', resolve);
    child.stdin.end(payload);
  }));
  assert.deepEqual(await Promise.all(runs), Array(16).fill(0));
  const seqs = (await logOf(queue)).map(entry => entry.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 16 }, (_, index) => index + 1));
}), 30000);

test('a lock left by a dead process is reclaimed and the counter continues', async () => fixture(async ({ queue }) => {
  assert.equal(await nextSeq(queue), 1);
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise(resolve => dead.on('close', resolve));
  await writeFile(join(queue, 'seq', 'counter.lock'), `${dead.pid}\n`);
  assert.equal(await nextSeq(queue), 2);
  assert.equal(await nextSeq(queue), 3);
  assert.deepEqual((await readdir(join(queue, 'seq'))).sort(), ['counter']);
}));

test('a lock held by a live process delays the record but never loses it or blocks the hook for long', async () => fixture(async ({ queue }) => {
  await nextSeq(queue);
  await writeFile(join(queue, 'seq', 'counter.lock'), `${process.pid}\n`);
  const started = Date.now();
  await withEnv({ FM_HOOK_SEQ_LOCK_TIMEOUT_MS: '60' }, () => appendEventLog({ type: 'seen' }, queue));
  assert.ok(Date.now() - started < 1500);
  const [entry] = await logOf(queue);
  assert.equal(entry.type, 'seen');
  assert.equal(entry.seq, null, 'unordered rather than missing');
  assert.equal(entry.machine, machineName());
}));

test('a corrupt counter restarts above any earlier seq instead of repeating one', async () => fixture(async ({ queue }) => {
  await nextSeq(queue);
  await writeFile(join(queue, 'seq', 'counter'), 'garbage');
  const next = await nextSeq(queue);
  assert.ok(next > 1_000_000_000_000, 'seeded from the clock');
  assert.equal(await nextSeq(queue), next + 1);
}));

test('machine: FM_HOOK_MACHINE wins, else the short lower-case host name', () => {
  assert.equal(machineName({ FM_HOOK_MACHINE: 'macbook' }), 'macbook');
  assert.equal(machineName({ FM_HOOK_MACHINE: 'weird name/../x' }), 'weird-name-..-x');
  assert.equal(machineName({}), hostname().split('.')[0].toLowerCase());
});

test('fmHome resolves from FM_HOME, then the working directory, then an fm_home path in the command', () => {
  assert.equal(resolveFmHome({ FM_HOME: '/h/fm_home/a' }, '/h/fm_home/b'), '/h/fm_home/a');
  assert.equal(resolveFmHome({}, '/Users/u/fm_home/mini0-ops/state'), '/Users/u/fm_home/mini0-ops');
  assert.equal(resolveFmHome({}, '/Users/u/fm_home/mini0-ops'), '/Users/u/fm_home/mini0-ops');
  assert.equal(resolveFmHome({}, '/Users/u/.treehouse/x', 'H=/Users/u/fm_home/mini0-ops; $H/bin/fm-wake-drain.sh'), '/Users/u/fm_home/mini0-ops');
  assert.equal(resolveFmHome({}, '/tmp', 'cd "/Users/u/fm_home/macbook-ops/state" && ls'), '/Users/u/fm_home/macbook-ops');
  assert.equal(resolveFmHome({}, '/tmp', 'ls /tmp/not_fm_home/x'), null);
  assert.equal(resolveFmHome({}, null, undefined), null);
});

test('stampRecord leaves a caller\'s own seq and fields alone and adds only what is missing', async () => fixture(async ({ queue }) => {
  const stamped = await stampRecord({ type: 'x', seq: 41, machine: 'm', extra: 1 }, queue, { env: { FM_HOME: '/Users/u/fm_home/h' } });
  assert.deepEqual(stamped, { type: 'x', seq: 41, machine: 'm', extra: 1, schemaVersion: SCHEMA_VERSION, fmHome: '/Users/u/fm_home/h'.replace('/Users/u', '~') });
  const none = await stampRecord({ type: 'y' }, queue, { env: {} });
  assert.equal(none.fmHome, null);
  assert.equal(none.seq, 1, 'a stamped record that already had a seq did not consume one');
}));
