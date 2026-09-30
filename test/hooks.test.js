import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSemanticCommand, normalizeEvent, explicitOpenCodeOutcome } from '../src/normalize.js';
import { observe } from '../src/observer.js';
import { runQueue } from '../src/queue.js';
import fmHooksPlugin from '../src/opencode-plugin.js';

const fixture = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'fm-hooks-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('matches direct semantic commands, quotes and command lists without matching echoed text', () => {
  assert.deepEqual(parseSemanticCommand("fm_dispatch 'ticket with spaces' --mode=fast && fm_scout \"repo\"" ).map(x => [x.operation, x.args]), [
    ['fm_dispatch', ['ticket with spaces', '--mode=fast']], ['fm_scout', ['repo']]
  ]);
  for (const command of ['echo fm_dispatch x', 'printf "fm_scout x"', '# fm_dispatch x', 'notfm_dispatch x', 'echo x # fm_scout']) {
    assert.deepEqual(parseSemanticCommand(command), [], command);
  }
  assert.deepEqual(parseSemanticCommand('A=1 fm_dispatch x')[0].args, ['x']);
});

test('normalizes Claude/OpenCode-shaped fixtures to the same semantic context', () => {
  const common = { sessionId: 's1', callId: 'c1', rawCommand: "fm_dispatch 'task-1'", cwd: '/project', outcome: 'success' };
  const claude = normalizeEvent({ ...common, harness: 'claude-code', source: { eventName: 'PostToolUse' } })[0];
  const openCode = normalizeEvent({ ...common, harness: 'opencode', source: { eventName: 'tool.execute.after' } })[0];
  assert.deepEqual({ operation: claude.operation, args: claude.args, rawCommand: claude.rawCommand, cwd: claude.cwd, outcome: claude.outcome },
    { operation: openCode.operation, args: openCode.args, rawCommand: openCode.rawCommand, cwd: openCode.cwd, outcome: openCode.outcome });
  assert.equal(claude.correlationId, normalizeEvent({ ...common, harness: 'claude-code' })[0].correlationId);
});

test('OpenCode result inference retains unknown and does not infer from empty output', () => {
  assert.deepEqual(explicitOpenCodeOutcome({ output: '' }), { outcome: 'unknown', exitCode: null });
  assert.deepEqual(explicitOpenCodeOutcome({ metadata: { exitCode: 7 } }), { outcome: 'failure', exitCode: 7 });
  assert.deepEqual(explicitOpenCodeOutcome({ metadata: { success: true } }), { outcome: 'success', exitCode: null });
});

test('success-only rules durably enqueue once; failure and unknown do not fire', async () => fixture(async root => {
  const rules = [{ id: 'verify-dispatch', operation: 'fm_dispatch', outcomes: ['success'], action: { command: 'fixture', args: [] } }];
  const base = { harness: 'claude-code', sessionId: 's', callId: 'call-1', rawCommand: 'fm_dispatch task-1', cwd: '/tmp' };
  await observe({ ...base, outcome: 'failure' }, { root, rules });
  await observe({ ...base, outcome: 'unknown' }, { root, rules });
  const first = await observe({ ...base, outcome: 'success' }, { root, rules });
  const replay = await observe({ ...base, outcome: 'success' }, { root, rules });
  assert.equal(first[0].actions[0].enqueued, true);
  assert.equal(replay[0].actions[0].enqueued, false);
  assert.equal((await readdir(join(root, 'jobs'))).length, 1);
  assert.equal((await readdir(join(root, 'events'))).length, 1);
  let executions = 0;
  await runQueue({ root, execute: async () => { executions++; } });
  assert.equal(executions, 1);
  assert.equal((await readdir(join(root, 'done'))).length, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'done', (await readdir(join(root, 'done')))[0]), 'utf8')).operation, 'fm_dispatch');
}));

test('Claude CLI and OpenCode plugin observe harmless fixture calls through the shared queue', async () => fixture(async root => {
  const rulesPath = join(root, 'rules.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(rulesPath, JSON.stringify({ rules: [{ id: 'verify', operation: 'fm_dispatch', outcomes: ['success'], action: { command: 'fixture', args: [] } }] }));
  const sourceRoot = fileURLToPath(new URL('../src/claude-hook.js', import.meta.url));
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'claude-s', tool_use_id: 'claude-c',
    tool_name: 'Bash', tool_input: { command: "fm_dispatch 'fixture task'" }, cwd: '/fixture', tool_response: { exit_code: 0 } });
  const cli = spawnSync(process.execPath, [sourceRoot], { input: payload, encoding: 'utf8', env: { ...process.env, FM_HOOK_QUEUE: root, FM_HOOK_RULES: rulesPath } });
  assert.equal(cli.status, 0, cli.stderr);
  const oldQueue = process.env.FM_HOOK_QUEUE, oldRules = process.env.FM_HOOK_RULES;
  process.env.FM_HOOK_QUEUE = root; process.env.FM_HOOK_RULES = rulesPath;
  try {
    const plugin = await fmHooksPlugin({ directory: '/fixture' });
    const before = { tool: 'bash', sessionID: 'oc-s', callID: 'oc-c' };
    await plugin['tool.execute.before'](before, { args: { command: "fm_dispatch 'fixture task'" } });
    await plugin['tool.execute.after']({ ...before, args: { command: "fm_dispatch 'fixture task'" } },
      { metadata: { exitCode: 0 }, output: 'fixture marker' });
  } finally {
    if (oldQueue === undefined) delete process.env.FM_HOOK_QUEUE; else process.env.FM_HOOK_QUEUE = oldQueue;
    if (oldRules === undefined) delete process.env.FM_HOOK_RULES; else process.env.FM_HOOK_RULES = oldRules;
  }
  const jobs = await readdir(join(root, 'jobs'));
  assert.equal(jobs.length, 2);
  const records = await Promise.all((await readdir(join(root, 'events'))).map(name => readFile(join(root, 'events', name), 'utf8').then(JSON.parse)));
  assert.deepEqual(records.map(event => event.harness).sort(), ['claude-code', 'opencode']);
  assert.ok(records.every(event => event.outcome === 'success' && event.cwd === '/fixture'));
}));

test('completed scout rule schedules report review only after success', async () => fixture(async root => {
  const rule = [{ id: 'review-scout', operation: 'fm_scout', outcomes: ['success'], action: { command: 'fixture', args: ['review'] } }];
  const [event] = await observe({ harness: 'opencode', callId: 'scout-1', sessionId: 's', rawCommand: 'fm_scout project', outcome: 'success' }, { root, rules: rule });
  assert.equal(event.actions[0].enqueued, true);
}));
