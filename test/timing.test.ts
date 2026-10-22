import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleClaudeHook } from '../src/claude-events.ts';

const HOOK = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-timing-'));
  try { await fn({ dir, queue: join(dir, 'queue') }); } finally { await rm(dir, { recursive: true, force: true }); }
}
const bash = (command, extra = {}) => ({ session_id: 's-1', tool_use_id: 'toolu_1', tool_name: 'Bash', tool_input: { command }, cwd: '/work', ...extra });
const pre = (payload, queue) => handleClaudeHook({ hook_event_name: 'PreToolUse', ...payload }, { root: queue, eventName: 'PreToolUse' });
const post = (payload, queue, eventName = 'PostToolUse') => handleClaudeHook({ hook_event_name: eventName, tool_response: { stdout: 'ok' }, ...payload }, { root: queue, eventName });
const eventsOf = async queue => Promise.all((await readdir(join(queue, 'events'))).sort().map(name => readFile(join(queue, 'events', name), 'utf8').then(JSON.parse)));

test('a PreToolUse timestamp gives the post event its startedAt and durationMs, then is removed', async () => fixture(async ({ queue }) => {
  await pre(bash('fm-send.sh task hi'), queue);
  const files = await readdir(join(queue, 'pre'));
  assert.deepEqual(files, ['toolu_1.json']);
  const stored = JSON.parse(await readFile(join(queue, 'pre', files[0]), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['callId', 'startedAt'], 'a timestamp and an id: no command, no payload');
  await wait(40);
  await post(bash('fm-send.sh task hi'), queue);
  const [event] = await eventsOf(queue);
  assert.equal(event.startedAt, stored.startedAt);
  assert.ok(event.durationMs >= 30 && event.durationMs < 5000, `durationMs ${event.durationMs}`);
  assert.equal(Date.parse(event.finishedAt) - Date.parse(event.startedAt), event.durationMs);
  assert.deepEqual(await readdir(join(queue, 'pre')), []);
}));

test('only calls that will be recorded get a timestamp', async () => fixture(async ({ queue }) => {
  await pre(bash('ls -la', { tool_use_id: 'plain' }), queue);
  await pre(bash('echo fm-send.sh', { tool_use_id: 'echoed' }), queue);
  await pre({ session_id: 's', tool_use_id: 'w', tool_name: 'Write', tool_input: { file_path: '/tmp/a' } }, queue);
  await pre({ session_id: 's', tool_use_id: 'r', tool_name: 'Read', tool_input: { file_path: '/tmp/a' } }, queue);
  await pre(bash('fm-wake-drain.sh', { tool_use_id: 'd' }), queue);
  assert.deepEqual((await readdir(join(queue, 'pre'))).sort(), ['d.json', 'w.json']);
}));

test('tool events get their timing too', async () => fixture(async ({ queue }) => {
  const call = { session_id: 's', tool_use_id: 'w1', tool_name: 'Edit', tool_input: { file_path: '/tmp/a', old_string: 'a', new_string: 'b' } };
  await pre(call, queue);
  await wait(20);
  await post(call, queue);
  const [event] = await eventsOf(queue);
  assert.equal(event.operation, 'tool:Edit');
  assert.ok(event.durationMs >= 10);
  assert.ok(event.startedAt);
}));

test('without a PreToolUse record the event is exactly what it was', async () => fixture(async ({ queue }) => {
  await post(bash('fm-send.sh task hi'), queue);
  const [event] = await eventsOf(queue);
  assert.equal(event.startedAt, null);
  assert.equal(event.durationMs, null);
  assert.equal(event.exitCode, null);
}));

test('a payload\'s own started_at wins over the stored one', async () => fixture(async ({ queue }) => {
  await pre(bash('fm-send.sh task hi'), queue);
  await post(bash('fm-send.sh task hi', { started_at: '2026-01-01T00:00:00.000Z' }), queue);
  assert.equal((await eventsOf(queue))[0].startedAt, '2026-01-01T00:00:00.000Z');
}));

test('a failed Bash call reports the exit code the harness printed; a success reports none', async () => fixture(async ({ queue }) => {
  await post(bash('fm-send.sh a b', { tool_use_id: 'f1', tool_response: undefined, error: 'Exit code 7\nnope: not found' }), queue, 'PostToolUseFailure');
  await post(bash('fm-send.sh a c', { tool_use_id: 'f2', tool_response: undefined, error: 'Command was interrupted' }), queue, 'PostToolUseFailure');
  await post(bash('fm-send.sh a d', { tool_use_id: 's1' }), queue);
  await post(bash('fm-send.sh a e', { tool_use_id: 's2', tool_response: { exit_code: 3, stdout: '' } }), queue);
  const byArg = Object.fromEntries((await eventsOf(queue)).map(event => [event.args[1], event]));
  assert.equal(byArg.b.exitCode, 7);
  assert.equal(byArg.b.outcome, 'failure');
  assert.deepEqual(byArg.b.resultMetadata, { response: 'Exit code 7\nnope: not found' }, 'the stored response is unchanged');
  assert.equal(byArg.c.exitCode, null);
  assert.equal(byArg.d.exitCode, null, 'a success is not assumed to be exit 0: the harness also treats some non-zero codes as success');
  assert.equal(byArg.e.exitCode, 3, 'an explicit code in the payload still wins');
}));

test('timestamps older than six hours are swept by the next PreToolUse', async () => fixture(async ({ queue }) => {
  await pre(bash('fm-send.sh a', { tool_use_id: 'old' }), queue);
  const old = new Date(Date.now() - 7 * 3600 * 1000);
  await utimes(join(queue, 'pre', 'old.json'), old, old);
  await pre(bash('fm-send.sh b', { tool_use_id: 'new' }), queue);
  assert.deepEqual(await readdir(join(queue, 'pre')), ['new.json']);
}));

test('the PreToolUse hook process prints nothing and exits 0, even when the queue is unusable', async () => fixture(async ({ dir, queue }) => {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', ...bash('fm-send.sh a b') });
  const run = env => spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8', env: { ...process.env, ...env } });
  const ok = run({ FM_HOOK_QUEUE: queue });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  assert.deepEqual(await readdir(join(queue, 'pre')), ['toolu_1.json']);
  await writeFile(join(dir, 'a-file'), 'x');
  const broken = run({ FM_HOOK_QUEUE: join(dir, 'a-file', 'queue') });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
}));
