import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleClaudeHook } from '../src/claude-events.ts';
import { analyzeTranscript } from '../src/turn-end.ts';
import fmHooksPlugin from '../src/opencode-plugin.ts';
import fmHooksPiExtension from '../src/pi-extension.ts';

const HOOK = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
const SECRET = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-turn-end-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try { await fn({ dir, queue: join(dir, 'queue'), transcript: join(dir, '.claude', 'projects', 'p', 's-1.jsonl') }); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const toolResult = id => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);
const assistant = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const text = value => ({ type: 'text', text: value });
const bash = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const tool = (id, name) => ({ type: 'tool_use', id, name, input: {} });
const write = async (path, entries) => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, entries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n');
};
const readRecord = async (queue, kind) => {
  const names = await readdir(join(queue, kind));
  assert.equal(names.length, 1, `one ${kind} record`);
  return JSON.parse(await readFile(join(queue, kind, names[0]), 'utf8'));
};

const TURN = [
  user('an earlier prompt'),
  assistant(bash('toolu_old', 'bin/fm-wake-drain.sh'), text('earlier turn')),
  toolResult('toolu_old'),
  assistant(text('earlier reply')),
  // the wake that starts the handling turn: a Stop-hook feedback prompt
  user('Stop hook feedback:\nfirstmate watcher: signal gnhf-a11y-2.status'),
  user('<system-reminder>meta</system-reminder>', { isMeta: true }),
  assistant(bash('toolu_drain', 'H=/x; $H/bin/fm-wake-drain.sh 2>&1 | head -40'), tool('toolu_read', 'Read')),
  toolResult('toolu_drain'),
  assistant(bash('toolu_side', 'echo hi'), { type: 'tool_use', id: 'toolu_nested', name: 'Task', input: {} }),
  { ...assistant(tool('toolu_sub', 'Grep')), isSidechain: true },
  assistant(bash('toolu_send', "bin/fm-send.sh task 'go'")),
  assistant(bash('toolu_ack', 'bin/fm-wake-drain.sh --ack-through 4238 --recovery-generation 1.2.3')),
  assistant(text(`Handled: sent the answer. token ${SECRET} see /Users/someone/x ${'z'.repeat(600)}`)),
];

test('analyzeTranscript counts the tool calls of the final turn and finds its drain calls', async () => fixture(async ({ transcript }) => {
  await write(transcript, TURN);
  const turn = await analyzeTranscript(transcript);
  assert.deepEqual(turn.drainCallIds, ['toolu_drain', 'toolu_ack']);
  assert.equal(turn.toolCallCount, 6, 'drain, Read, echo, Task, send, ack counted; the sidechain Grep and the earlier turn are not');
  assert.match(turn.lastAssistantText, /^Handled: sent the answer/);
  assert.equal(turn.size, (await stat(transcript)).size);
}));

test('analyzeTranscript tolerates junk lines, a missing file and a transcript that is only a tail', async () => fixture(async ({ transcript, dir }) => {
  await write(transcript, ['not json', '{"type":"user"', ...TURN.slice(4), '{truncated']);
  assert.deepEqual((await analyzeTranscript(transcript)).drainCallIds, ['toolu_drain', 'toolu_ack']);
  const missing = await analyzeTranscript(join(dir, 'nope.jsonl'));
  assert.deepEqual([missing.drainCallIds, missing.toolCallCount, missing.lastAssistantText, missing.size], [[], null, null, null]);
  // A 4 MiB tool_result in front of a short final turn: the tail read never needs it.
  await write(transcript, [user('a'), assistant(bash('toolu_huge', 'fm-wake-drain.sh')), { pad: 'x'.repeat(4 * 1024 * 1024) }, ...TURN.slice(4)]);
  const huge = await analyzeTranscript(transcript);
  assert.deepEqual(huge.drainCallIds, ['toolu_drain', 'toolu_ack']);
}));

test('the Claude Stop hook records a turn-end with the turn\'s boundary, tool calls and scrubbed reply', async () => fixture(async ({ transcript, queue }) => {
  await write(transcript, TURN);
  const size = (await stat(transcript)).size;
  await handleClaudeHook({ hook_event_name: 'Stop', session_id: 's-1', transcript_path: transcript, cwd: '/x', stop_hook_active: false },
    { root: queue, eventName: 'Stop' });
  const record = await readRecord(queue, 'turn-end');
  assert.equal(record.type, 'turn-end');
  assert.equal(record.harness, 'claude-code');
  assert.equal(record.sessionId, 's-1');
  assert.equal(record.turnId, createHash('sha256').update(`s-1\0${size}`).digest('hex'));
  assert.match(record.finishedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(record.drainCallIds, ['toolu_drain', 'toolu_ack']);
  assert.equal(record.toolCallCount, 6);
  assert.equal(record.lastAssistantMessage.length, 400);
  assert.match(record.lastAssistantMessage, /^Handled: sent the answer\. token \[redacted\] see ~\/x z+…$/);
  assert.equal(record.transcriptPath, '~/.claude/projects/p/s-1.jsonl');
  assert.equal(record.stopHookActive, false);
  const log = (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => entry.type), ['turn-end']);
}));

test('the payload\'s last_assistant_message wins over the transcript, and a Stop without a transcript still records', async () => fixture(async ({ queue, dir }) => {
  await handleClaudeHook({ hook_event_name: 'Stop', session_id: 's-2', transcript_path: join(dir, 'gone.jsonl'),
    last_assistant_message: `all done ${SECRET}`, stop_hook_active: true }, { root: queue, eventName: 'Stop' });
  const record = await readRecord(queue, 'turn-end');
  assert.equal(record.lastAssistantMessage, 'all done [redacted]');
  assert.equal(record.toolCallCount, null);
  assert.deepEqual(record.drainCallIds, []);
  assert.equal(record.stopHookActive, true);
  assert.match(record.turnId, /^[0-9a-f]{64}$/);
}));

test('a Stop with no session id records nothing', async () => fixture(async ({ queue }) => {
  await handleClaudeHook({ hook_event_name: 'Stop' }, { root: queue, eventName: 'Stop' });
  assert.deepEqual(await readdir(queue).catch(() => []), []);
}));

test('the Stop hook process prints nothing, exits 0 and cannot block the stop', async () => fixture(async ({ transcript, queue }) => {
  await write(transcript, TURN);
  const run = input => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, HOME: process.env.HOME, FM_HOOK_QUEUE: queue } });
  const ok = run(JSON.stringify({ hook_event_name: 'Stop', session_id: 's-1', transcript_path: transcript }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '', 'a Stop hook that prints JSON or exits 2 would block or continue the turn');
  assert.deepEqual(await readdir(join(queue, 'turn-end')).then(names => names.length), 1);
  const bad = run('{"hook_event_name":"Stop"');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  const ignored = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'hello' }));
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout, '');
}));

test('the same Stop delivered twice keeps one turn-end file and logs twice', async () => fixture(async ({ transcript, queue }) => {
  await write(transcript, TURN);
  const payload = { hook_event_name: 'Stop', session_id: 's-1', transcript_path: transcript };
  await handleClaudeHook(payload, { root: queue, eventName: 'Stop' });
  await handleClaudeHook(payload, { root: queue, eventName: 'Stop' });
  assert.equal((await readdir(join(queue, 'turn-end'))).length, 1);
  assert.equal((await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').length, 2);
}));

test('OpenCode: session.idle closes the turn the plugin watched', async () => fixture(async ({ queue }) => {
  const old = process.env.FM_HOOK_QUEUE; process.env.FM_HOOK_QUEUE = queue;
  try {
    const plugin = await fmHooksPlugin({ directory: '/fixture' });
    const call = async (tool, callID, command?) => {
      const input = { tool, sessionID: 'oc-s', callID, args: command ? { command } : {} };
      if (command) await plugin['tool.execute.before'](input, { args: input.args });
      await plugin['tool.execute.after'](input, { metadata: { exitCode: 0 }, output: 'ok', args: input.args });
    };
    await call('bash', 'oc-1', 'bin/fm-wake-drain.sh');
    await call('read', 'oc-2');
    await call('bash', 'oc-3', 'ls');
    await call('bash', 'oc-4', 'bin/fm-wake-drain.sh --ack-through 5 --recovery-generation a.b');
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'oc-s', status: { type: 'busy' } } } });
    assert.equal(await readdir(queue).then(names => names.includes('turn-end')), false);
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'oc-s' } } });
    const record = await readRecord(queue, 'turn-end');
    assert.equal(record.harness, 'opencode');
    assert.equal(record.sessionId, 'oc-s');
    assert.deepEqual(record.drainCallIds, ['oc-1', 'oc-4']);
    assert.equal(record.toolCallCount, 4);
    assert.equal(record.lastAssistantMessage, null);
    assert.equal(record.transcriptPath, null);
    // The next turn starts counting from zero and gets its own id.
    await call('read', 'oc-5');
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'oc-s' } } });
    const names = await readdir(join(queue, 'turn-end'));
    assert.equal(names.length, 2);
    const second = (await Promise.all(names.map(name => readFile(join(queue, 'turn-end', name), 'utf8').then(JSON.parse)))).find(r => r.toolCallCount === 1);
    assert.deepEqual(second.drainCallIds, []);
    assert.notEqual(second.turnId, record.turnId);
  } finally { if (old === undefined) delete process.env.FM_HOOK_QUEUE; else process.env.FM_HOOK_QUEUE = old; }
}));

test('Pi: agent_settled closes the turn the extension watched', async () => fixture(async ({ queue }) => {
  const old = process.env.FM_HOOK_QUEUE; process.env.FM_HOOK_QUEUE = queue;
  try {
    const handlers = new Map();
    fmHooksPiExtension({ on: (name, handler) => handlers.set(name, handler) });
    assert.ok(handlers.has('agent_settled'));
    const ctx = { cwd: '/fixture', sessionManager: { getSessionId: () => 'pi-s' } };
    const start = (id, toolName, command?) => handlers.get('tool_execution_start')({ toolCallId: id, toolName, args: command ? { command } : {} }, ctx);
    await start('pi-1', 'bash', 'bin/fm-wake-drain.sh');
    await start('pi-2', 'read');
    await start('pi-3', 'bash', 'echo hi');
    await handlers.get('agent_settled')({}, ctx);
    const record = await readRecord(queue, 'turn-end');
    assert.equal(record.harness, 'pi');
    assert.equal(record.sessionId, 'pi-s');
    assert.deepEqual(record.drainCallIds, ['pi-1']);
    assert.equal(record.toolCallCount, 3);
  } finally { if (old === undefined) delete process.env.FM_HOOK_QUEUE; else process.env.FM_HOOK_QUEUE = old; }
}));
