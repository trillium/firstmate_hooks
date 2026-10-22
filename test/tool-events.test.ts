import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleClaudeHook } from '../src/claude-events.ts';
import { correlationId } from '../src/normalize.ts';

const HOOK = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
const SECRET = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789';
const CONTENT = 'THE-FILE-CONTENT-MUST-NOT-BE-RECORDED';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-tools-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try { await fn({ dir, queue: join(dir, 'queue') }); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}
const post = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: 's-1', tool_use_id: `toolu_${tool_name}`,
  tool_name, tool_input, tool_response: { filePath: 'x', content: CONTENT }, cwd: '/work', ...extra });
const events = async queue => Promise.all((await readdir(join(queue, 'events'))).sort()
  .map(name => readFile(join(queue, 'events', name), 'utf8').then(JSON.parse)));

test('Write, Edit, NotebookEdit, Agent and SendMessage become events without their content', async () => fixture(async ({ dir, queue }) => {
  const cases: [string, any, string][] = [
    ['Write', { file_path: `${dir}/code/a.ts`, content: CONTENT }, 'Write ~/code/a.ts'],
    ['Edit', { file_path: `${dir}/code/b.ts`, old_string: CONTENT, new_string: `${CONTENT}2` }, 'Edit ~/code/b.ts'],
    ['NotebookEdit', { notebook_path: `${dir}/n.ipynb`, new_source: CONTENT, cell_id: 'c1' }, 'NotebookEdit ~/n.ipynb'],
    ['Agent', { subagent_type: 'Explore', description: 'Find the hooks', prompt: CONTENT }, 'Agent Explore: Find the hooks'],
    ['SendMessage', { to: 'researcher', message: CONTENT, summary: CONTENT }, 'SendMessage researcher'],
  ];
  for (const [tool, input] of cases) await handleClaudeHook(post(tool, input), { root: queue, eventName: 'PostToolUse' });
  const recorded = await events(queue);
  assert.deepEqual(recorded.map(event => [event.operation, event.rawCommand]).sort(), cases.map(([tool, , raw]) => [`tool:${tool}`, raw]).sort());
  for (const event of recorded) {
    assert.equal(event.outcome, 'success');
    assert.equal(event.harness, 'claude-code');
    assert.equal(event.sessionId, 's-1');
    assert.equal(event.cwd, '/work');
    assert.deepEqual(event.args, []);
    assert.equal(event.resultMetadata, null);
    assert.equal(event.exitCode, null);
    assert.equal(event.correlationId, correlationId({ harness: 'claude-code', sessionId: 's-1', callId: event.callId }));
    assert.deepEqual(event.source, { eventName: 'PostToolUse', tool: event.operation.slice('tool:'.length) });
  }
  const log = (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => entry.type), Array(5).fill('event'));
  for (const file of [join(queue, 'events.jsonl'), ...(await readdir(join(queue, 'events'))).map(name => join(queue, 'events', name))]) {
    assert.ok(!(await readFile(file, 'utf8')).includes(CONTENT), `${file} holds no content`);
  }
}));

test('a failed tool call is a failure event', async () => fixture(async ({ queue }) => {
  await handleClaudeHook({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_use_id: 't1', tool_name: 'Edit',
    tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }, error: 'String to replace not found' }, { root: queue, eventName: 'PostToolUseFailure' });
  const [event] = await events(queue);
  assert.equal(event.operation, 'tool:Edit');
  assert.equal(event.outcome, 'failure');
  assert.equal(event.resultMetadata, null, 'the error text is not recorded either');
}));

test('the text of a tool event is scrubbed and capped', async () => fixture(async ({ queue }) => {
  await handleClaudeHook(post('Write', { file_path: `/Users/someone/${SECRET}/${'d/'.repeat(400)}f.ts` }), { root: queue, eventName: 'PostToolUse' });
  await handleClaudeHook(post('SendMessage', { to: `x ${SECRET}` }, { tool_use_id: 't2' }), { root: queue, eventName: 'PostToolUse' });
  for (const event of await events(queue)) {
    assert.ok(event.rawCommand.length <= 400);
    assert.ok(!event.rawCommand.includes(SECRET));
    assert.ok(!event.rawCommand.includes('/Users/someone'));
  }
}));

test('tool events never reach the rules engine, so a wildcard rule does not fire on them', async () => fixture(async ({ dir, queue }) => {
  const rules = join(dir, 'rules.json');
  await writeFile(rules, JSON.stringify({ rules: [{ id: 'all', operation: '*', outcomes: ['success', 'failure', 'unknown'], action: { command: 'true', args: [] } }] }));
  const old = process.env.FM_HOOK_RULES; process.env.FM_HOOK_RULES = rules;
  try {
    await handleClaudeHook(post('Write', { file_path: '/tmp/a' }), { root: queue, eventName: 'PostToolUse' });
    await handleClaudeHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'b1', tool_name: 'Bash', tool_input: { command: 'fm-send.sh a b' }, tool_response: {} },
      { root: queue, eventName: 'PostToolUse' });
  } finally { if (old === undefined) delete process.env.FM_HOOK_RULES; else process.env.FM_HOOK_RULES = old; }
  assert.equal((await readdir(join(queue, 'events'))).length, 2);
  assert.equal((await readdir(join(queue, 'jobs'))).length, 1, 'only the fm-send.sh call enqueued its rule');
}));

test('other tools are not observed, and Bash is unchanged', async () => fixture(async ({ queue }) => {
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'mcp__x__write']) {
    await handleClaudeHook(post(tool, { file_path: '/tmp/a' }), { root: queue, eventName: 'PostToolUse' });
  }
  assert.deepEqual(await readdir(queue).catch(() => []), []);
  await handleClaudeHook(post('Write', { file_path: '/tmp/a' }), { root: queue, eventName: 'PreToolUse' });
  assert.deepEqual(await readdir(join(queue, 'events')).catch(() => []), [], 'only the post events are recorded');
}));

test('the hook process records a Write event, prints nothing and exits 0', async () => fixture(async ({ queue }) => {
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(post('Write', { file_path: '/tmp/a', content: CONTENT })),
    encoding: 'utf8', env: { ...process.env, FM_HOOK_QUEUE: queue } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal((await events(queue))[0].operation, 'tool:Write');
}));
