import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSemanticCommand, normalizeEvent, explicitOpenCodeOutcome } from '../src/normalize.ts';
import { observe } from '../src/observer.ts';
import { runQueue } from '../src/queue.ts';
import fmHooksPlugin from '../src/opencode-plugin.ts';
import fmHooksPiExtension from '../src/pi-extension.ts';

const fixture = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'fm-hooks-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('OpenCode inbox-connect command documents the portable wrapper contract', async () => {
  const command = await readFile(new URL('../.opencode/command/inbox-connect.md', import.meta.url), 'utf8');
  assert.match(command, /^---\ndescription: Connect to the Parlay serial inbox workflow/m);
  assert.match(command, /canonical inbox-handler skill/);
  assert.match(command, /Usage: \/inbox-connect \[store\]/);
  assert.match(command, /do not report connected unless enrollment succeeds/);
  assert.match(command, /does not install or emulate Pi's `parlay-pi-inbox` extension/);
});

test('matches direct semantic commands, quotes and command lists without matching echoed text', () => {
  assert.deepEqual(parseSemanticCommand("fm_dispatch 'ticket with spaces' --mode=fast && fm_scout \"repo\"" ).map(x => [x.operation, x.args]), [
    ['fm_dispatch', ['ticket with spaces', '--mode=fast']], ['fm_scout', ['repo']]
  ]);
  for (const command of ['echo fm_dispatch x', 'printf "fm_scout x"', '# fm_dispatch x', 'notfm_dispatch x', 'echo x # fm_scout']) {
    assert.deepEqual(parseSemanticCommand(command), [], command);
  }
  assert.deepEqual(parseSemanticCommand('A=1 fm_dispatch x')[0].args, ['x']);
  assert.deepEqual(parseSemanticCommand('fm_send task-1 "done" && bin/fm-spawn.sh task-1').map(x => x.operation), ['fm_send', 'fm-spawn.sh']);
  assert.deepEqual(parseSemanticCommand('echo fm-teardown.sh x'), []);
  assert.deepEqual(parseSemanticCommand('notfm-send.sh x'), []);
});

// robots-znjpz: ships spawned through a `bash -c` wrapper produced no event at all, because
// the command word was `bash`; the fm-spawn.sh call lived inside the quoted script.
const WRAPPED_SPAWN_LOOP = "cd /Users/trilliumsmith/fm_home/firstmate && bash -c 'for t in parlay-launch-bead-q2 forefront-green-q2 forefront-config-auth-q2; do bin/fm-spawn.sh \"$t\" $FM_HOME/projects/forefront --harness claude --model claude-opus-5-5; done' 2>&1 | tail -3";

test('a Firstmate call inside a bash -c script, including a loop body, is the harness call', () => {
  const ops = command => parseSemanticCommand(command).map(x => [x.operation, x.args]);
  assert.deepEqual(ops("bash -c 'bin/fm-spawn.sh task-1 /h/projects/demo'"), [['fm-spawn.sh', ['task-1', '/h/projects/demo']]]);
  assert.deepEqual(ops(WRAPPED_SPAWN_LOOP), [['fm-spawn.sh', ['$t', '$FM_HOME/projects/forefront', '--harness', 'claude', '--model', 'claude-opus-5-5']]]);
  assert.deepEqual(ops('sh -lc "fm-send.sh task-1 \'go now\'"'), [['fm-send.sh', ['task-1', 'go now']]]);
  assert.deepEqual(ops("/bin/bash -o pipefail -c 'x | fm-spawn.sh t'"), [['fm-spawn.sh', ['t']]]);
  assert.deepEqual(ops("bash -c \"bash -c 'fm-spawn.sh t'\""), [['fm-spawn.sh', ['t']]]);
  assert.deepEqual(ops('if fm-spawn.sh t; then echo ok; fi'), [['fm-spawn.sh', ['t']]]);
  assert.deepEqual(ops("bash -c 'echo fm-spawn.sh t'"), [], 'echoed text inside the script still does not match');
  assert.deepEqual(ops("bash script.sh fm-spawn.sh t"), [], 'a script file argument is not a -c script');
  assert.deepEqual(ops("bash -c"), []);
  const events = normalizeEvent({ harness: 'claude-code', sessionId: 's', callId: 'c', rawCommand: WRAPPED_SPAWN_LOOP, outcome: 'success' });
  assert.equal(events.length, 1);
  assert.equal(events[0].rawCommand, WRAPPED_SPAWN_LOOP, 'the queued raw command stays the harness call');
  // The wrapper exits with the script's status, so a failure inside is decided like a direct call.
  assert.deepEqual(failureOutcomes("bash -c 'fm-spawn.sh t'"), [['fm-spawn.sh', 'failure']]);
  assert.deepEqual(failureOutcomes("bash -c 'fm-spawn.sh t; ls nope'"), [['fm-spawn.sh', 'unknown']]);
  assert.deepEqual(failureOutcomes("bash -c 'fm-spawn.sh t' | tail -1"), [['fm-spawn.sh', 'unknown']]);
});

test('normalizes Claude/OpenCode-shaped fixtures to the same semantic context', () => {
  const common = { sessionId: 's1', callId: 'c1', rawCommand: "fm_dispatch 'task-1'", cwd: '/project', outcome: 'success' };
  const claude = normalizeEvent({ ...common, harness: 'claude-code', source: { eventName: 'PostToolUse' } })[0];
  const openCode = normalizeEvent({ ...common, harness: 'opencode', source: { eventName: 'tool.execute.after' } })[0];
  assert.deepEqual({ operation: claude.operation, args: claude.args, rawCommand: claude.rawCommand, cwd: claude.cwd, outcome: claude.outcome },
    { operation: openCode.operation, args: openCode.args, rawCommand: openCode.rawCommand, cwd: openCode.cwd, outcome: openCode.outcome });
  assert.equal(claude.correlationId, normalizeEvent({ ...common, harness: 'claude-code' })[0].correlationId);
});

const SPAWN_PIPELINE = "export FM_HOME=/Users/trilliumsmith/fm_home/macbook-ops; B=$FM_HOME/bin; D=/Users/trilliumsmith/fm_home/firstmate/state/macbook-ops.inbox\n$B/fm-spawn.sh coder-playground-review $FM_HOME/projects/brain-playground --scout --harness claude --model claude-sonnet-5-5 --effort medium 2>&1|grep -v '^\u25cf'|tail -1\n$B/fm-secondmate-report.sh working 104ada1ce158ca8a \"Coder playground review (runbooks-opn steps 2, 4, 6) dispatched to scout coder-playground-review; per-step pass/fail with evidence paths to follow.\" 2>&1|tail -1\nmv $D/194.msg $D/handled/";
const LEDGER_GUARDED = "S=/Users/trilliumsmith/fm_home/macbook-ops/state/egress-allowlist.status; echo \"paused [at=$(date +%s)]: verify-requirements --only T,R3 rerun on fresh workspace (run4) in progress; resumes when it finishes\" >> $S && { [ ! -e '/Users/trilliumsmith/fm_home/macbook-ops/config/fleet-ledger' ] || '/Users/trilliumsmith/fm_home/macbook-ops/bin/fm-fleet-ledger.sh' appended '/Users/trilliumsmith/fm_home/macbook-ops/config' $S >/dev/null 2>&1 || true; }; ls /Users/trilliumsmith/fm_home/macbook-ops/state/egress-allowlist.inbox/*.msg 2>/dev/null";
const LEDGER_CHAIN_REFUSED = "cd /repo && git add -A && git commit -q -m 'feat: x' && git status --short && echo \"working [at=$(date +%s)]: done\" >> $S && { [ ! -e '/fh/config/fleet-ledger' ] || '/fh/bin/fm-fleet-ledger.sh' appended '/fh/config' $S >/dev/null 2>&1 || true; }";
const STATUS = '/fh/state/x.status';
const failureOutcomes = (rawCommand, outcome = 'failure') =>
  normalizeEvent({ harness: 'claude-code', sessionId: 's', callId: 'c', rawCommand, outcome }).map(e => [e.operation, e.outcome]);

test('a failed call is not a failure of an fm-* invocation whose status was masked', () => {
  // Event 149ba583…: fm-spawn.sh succeeded; the later `mv` failed.
  assert.deepEqual(failureOutcomes(SPAWN_PIPELINE), [['fm-spawn.sh', 'unknown'], ['fm-secondmate-report.sh', 'unknown']]);
  // Event 2ed55754…: fm-fleet-ledger.sh is `|| true` guarded; the trailing `ls` glob failed.
  assert.deepEqual(failureOutcomes(LEDGER_GUARDED), [['fm-fleet-ledger.sh', 'unknown']]);
  for (const command of ['fm-send.sh a b | tail -1', 'fm-send.sh a b 2>&1|tail -1', 'fm-send.sh a b || true',
    'fm-send.sh a b &', 'fm-send.sh a b; ls nope', 'fm-send.sh a b\nls nope', 'fm-send.sh a && x | y; ls nope']) {
    assert.deepEqual(failureOutcomes(command), [['fm-send.sh', 'unknown']], command);
  }
});

test('a failed call is still a failure when the fm-* invocation decided its exit status', () => {
  for (const command of ['fm-spawn.sh task-1', 'bin/fm-spawn.sh task-1 2>&1', 'echo go; fm-spawn.sh task-1',
    'cd repo && fm-spawn.sh task-1', 'ls x | fm-spawn.sh task-1', 'fm-spawn.sh task-1 && ls nope',
    'fm-spawn.sh task-1 >/dev/null 2>&1', 'fm-spawn.sh task-1;\n', 'echo a | tee out && fm-spawn.sh b']) {
    assert.equal(failureOutcomes(command)[0][1], 'failure', command);
  }
  assert.deepEqual(failureOutcomes('fm-send.sh a | tail -1; fm-spawn.sh task-1'), [['fm-send.sh', 'unknown'], ['fm-spawn.sh', 'failure']]);
});

test('masking only reclassifies failures and strips pipeline tails from args', () => {
  assert.deepEqual(failureOutcomes(SPAWN_PIPELINE, 'success').map(x => x[1]), ['success', 'success']);
  assert.deepEqual(failureOutcomes('fm-send.sh a | tail -1', 'unknown'), [['fm-send.sh', 'unknown']]);
  assert.deepEqual(parseSemanticCommand('fm-send.sh a "b | c" 2>&1|tail -1')[0].args, ['a', 'b | c', '2>&1']);
});

test('the fm-spawn and fm-fleet-ledger failure rules fire only on a decisive failure', async () => {
  const rules = JSON.parse(await readFile(new URL('../config/fm-hooks.rules.json', import.meta.url), 'utf8')).rules;
  const fired = (rawCommand) => normalizeEvent({ harness: 'claude-code', rawCommand, outcome: 'failure' })
    .flatMap(e => rules.filter(r => (r.operation === '*' || r.operation === e.operation) && r.outcomes.includes(e.outcome)).map(r => r.id))
    .filter(id => id.endsWith('-failure'));
  assert.deepEqual(fired(SPAWN_PIPELINE), []);
  assert.deepEqual(fired(LEDGER_GUARDED), []);
  // Event a934f44e…: a `git add -A` refused by a guard failed the chain before the `||`-guarded
  // ledger call ran; the ledger rule must not blame an invocation that never executed.
  assert.deepEqual(fired(LEDGER_CHAIN_REFUSED), []);
  // The same refusal with the ledger call unguarded and behind `&&`: it never ran, so it is not blamed.
  assert.deepEqual(fired(`cd /repo && git add -A && echo "working [at=1]: done" >> ${STATUS} && fm-fleet-ledger.sh appended /fh/config ${STATUS}`), []);
  assert.deepEqual(fired('fm-spawn.sh task-1 --scout'), ['fm-spawn-failure']);
  assert.deepEqual(fired('fm-fleet-ledger.sh appended /cfg /status'), ['fm-fleet-ledger-failure']);
  // The ledger ran after a `;` or as the `||` fallback, so its own status is the call's status.
  assert.deepEqual(fired('make x; fm-fleet-ledger.sh appended /cfg /status'), ['fm-fleet-ledger-failure']);
  assert.deepEqual(fired('git add -A || fm-fleet-ledger.sh appended /cfg /status'), ['fm-fleet-ledger-failure']);
});

test('OpenCode result inference retains unknown and does not infer from empty output', () => {
  assert.deepEqual(explicitOpenCodeOutcome({ output: '' }), { outcome: 'unknown', exitCode: null });
  assert.deepEqual(explicitOpenCodeOutcome({ metadata: { exitCode: 7 } }), { outcome: 'failure', exitCode: 7 });
  assert.deepEqual(explicitOpenCodeOutcome({ metadata: { success: true } }), { outcome: 'success', exitCode: null });
});

test('Pi completion adapter persists shared semantic events without touching tool data', async () => fixture(async root => {
  const rulesPath = join(root, 'rules.json');
  await writeFile(rulesPath, await readFile(new URL('./fixtures/pi-demo-rules.json', import.meta.url), 'utf8'));
  const oldQueue = process.env.FM_HOOK_QUEUE, oldRules = process.env.FM_HOOK_RULES;
  process.env.FM_HOOK_QUEUE = root;
  process.env.FM_HOOK_RULES = rulesPath;
  try {
    const handlers = new Map();
    fmHooksPiExtension({ on: (name, handler) => handlers.set(name, handler) });
    assert.deepEqual([...handlers.keys()], ['tool_execution_start', 'tool_execution_end']);
    const command = "fm_dispatch 'fixture task' && fm_scout fixture-project";
    const args = Object.freeze({ command });
    const start = Object.freeze({ toolCallId: 'pi-c1', toolName: 'bash', args });
    const result = Object.freeze({ content: Object.freeze([{ type: 'text', text: 'private fixture output' }]) });
    const end = Object.freeze({ toolCallId: 'pi-c1', toolName: 'bash', isError: false, result });
    const ctx = { cwd: '/fixture', sessionManager: { getSessionId: () => 'pi-s1' } };
    await handlers.get('tool_execution_start')(start, ctx);
    await handlers.get('tool_execution_end')(end, ctx);
    assert.deepEqual(start.args, { command });
    assert.deepEqual(end.result, { content: [{ type: 'text', text: 'private fixture output' }] });

    const records = await Promise.all((await readdir(join(root, 'events')))
      .map(name => readFile(join(root, 'events', name), 'utf8').then(JSON.parse)));
    const semantic = events => events.map(({ operation, args, rawCommand, cwd, outcome }) =>
      ({ operation, args, rawCommand, cwd, outcome })).sort((a, b) => a.operation.localeCompare(b.operation));
    const common = { sessionId: 'same-session', callId: 'same-call', rawCommand: command, cwd: '/fixture', outcome: 'success' };
    assert.deepEqual(semantic(records), semantic(normalizeEvent({ ...common, harness: 'claude-code' })));
    assert.deepEqual(semantic(records), semantic(normalizeEvent({ ...common, harness: 'opencode' })));
    assert.ok(records.every(event => event.harness === 'pi' && event.exitCode === null));
    assert.ok(!JSON.stringify(records).includes('private fixture output'));
    assert.equal((await readdir(join(root, 'jobs'))).length, 2);
    assert.equal((await readdir(root)).includes('done'), false, 'demo queues fixture jobs but never runs a worker');
  } finally {
    if (oldQueue === undefined) delete process.env.FM_HOOK_QUEUE; else process.env.FM_HOOK_QUEUE = oldQueue;
    if (oldRules === undefined) delete process.env.FM_HOOK_RULES; else process.env.FM_HOOK_RULES = oldRules;
  }
}));

test('Pi missing or ambiguous completion outcomes stay unknown and cannot fire success rules', async () => fixture(async root => {
  const rulesPath = join(root, 'rules.json');
  await writeFile(rulesPath, await readFile(new URL('./fixtures/pi-demo-rules.json', import.meta.url), 'utf8'));
  const oldQueue = process.env.FM_HOOK_QUEUE, oldRules = process.env.FM_HOOK_RULES;
  process.env.FM_HOOK_QUEUE = root;
  process.env.FM_HOOK_RULES = rulesPath;
  try {
    const handlers = new Map();
    fmHooksPiExtension({ on: (name, handler) => handlers.set(name, handler) });
    const startCall = async callId => handlers.get('tool_execution_start')(
      { toolCallId: callId, toolName: 'bash', args: { command: `fm_dispatch ${callId}` } },
      { cwd: '/fixture', sessionManager: { getSessionId: () => 'pi-outcomes' } });
    const endCall = async event => handlers.get('tool_execution_end')(event);
    await startCall('success');
    await endCall({ toolCallId: 'success', toolName: 'bash', isError: false, result: {} });
    await startCall('failure');
    await endCall({ toolCallId: 'failure', toolName: 'bash', isError: true, result: {} });
    await startCall('missing');
    await endCall({ toolCallId: 'missing', toolName: 'bash', result: {} });
    await startCall('ambiguous');
    await endCall({ toolCallId: 'ambiguous', toolName: 'bash', isError: 'false', result: {} });
    await endCall({ toolCallId: 'no-start', toolName: 'bash', isError: false, result: {} });
    await handlers.get('tool_execution_start')(
      { toolCallId: 'not-bash', toolName: 'custom', args: { command: 'fm_dispatch ignored' } },
      { cwd: '/fixture', sessionManager: { getSessionId: () => 'pi-outcomes' } });

    const records = await Promise.all((await readdir(join(root, 'events')))
      .map(name => readFile(join(root, 'events', name), 'utf8').then(JSON.parse)));
    assert.deepEqual(records.map(event => [event.callId, event.outcome]).sort(), [
      ['ambiguous', 'unknown'], ['failure', 'failure'], ['missing', 'unknown'], ['success', 'success']
    ]);
    assert.equal((await readdir(join(root, 'jobs'))).length, 1);
  } finally {
    if (oldQueue === undefined) delete process.env.FM_HOOK_QUEUE; else process.env.FM_HOOK_QUEUE = oldQueue;
    if (oldRules === undefined) delete process.env.FM_HOOK_RULES; else process.env.FM_HOOK_RULES = oldRules;
  }
}));

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
  const log = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 4);
  assert.equal(JSON.parse(log.at(-1)).type, 'event');
  assert.equal(JSON.parse(log.at(-1)).operation, 'fm_dispatch');
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
  const sourceRoot = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
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
