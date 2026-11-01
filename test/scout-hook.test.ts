import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleClaudeHook } from '../src/claude-events.ts';
import fmHooksPiExtension from '../src/pi-extension.ts';
import fmHooksPlugin from '../src/opencode-plugin.ts';
import { deliverable, entryPoint, fileWrite, launchCapture, recordPending, reportWrites, retryPending, scoutHook, statusAppends } from '../src/scout-hook.ts';
import { withStubs } from '../testlib/stub-env.ts';

const STORES = ['review', 'brain', 'fleet'];
const HOME = '/Users/x/fm_home/mini0-ops';
const LINE = 'report written at data/t1/report.md; found: two things; PR https://x/1';
// The command a scout runs to deliver, as the brief templates it, with and without the ledger call.
const withLedger = (state = 'done', stamp = '$E') => `E=$(date +%s); echo "${state} [at=${stamp}]: ${LINE}" >> '${HOME}/state/t1.status' && { [ ! -e '${HOME}/config/fleet-ledger' ] || '${HOME}/bin/fm-fleet-ledger.sh' appended '${HOME}/config' '${HOME}/state/t1.status' >/dev/null 2>&1 || true; }; tail -1 '${HOME}/state/t1.status'`;
const bare = (state = 'done') => `echo "${state} [at=$(date +%s)]: ${LINE}" >> ${HOME}/state/t1.status`;

const recorder = () => {
  const calls: any[] = [];
  const spawn: any = (command: string, args: string[], options: any) => { calls.push({ command, args, options }); return { unref() {}, on() {} }; };
  return { calls, spawn };
};

test('a done line is found in the status command with or without the ledger call, in every shape the crews write it', () => {
  const want = [{ home: HOME, task: 't1', why: 'status' }];
  assert.deepEqual(statusAppends(withLedger()), want);
  assert.deepEqual(statusAppends(withLedger('done', '1792432383')), want);
  assert.deepEqual(statusAppends(withLedger('needs-decision')), want);
  assert.deepEqual(statusAppends(bare()), want);
  assert.deepEqual(statusAppends(`printf 'done [at=%s]: x; y\\n' "$(date +%s)" >> "${HOME}/state/t1.status"`), want);
  assert.deepEqual(statusAppends(`echo "done [at=1]: x" | tee -a ${HOME}/state/t1.status`), want);
  assert.deepEqual(statusAppends(`echo "done [at=1]: x" >> state/t1.status`, HOME), want);
  assert.deepEqual(statusAppends('echo "done [at=1]: x" >> ~/fm_home/mini0-ops/state/t1.status', null, { HOME: '/Users/x' }), want);
  assert.deepEqual(statusAppends('echo "done [at=1]: x" >> $FM_HOME/state/t1.status', null, { FM_HOME: HOME }), want);
});

test('a status append that is not a delivery is not one', () => {
  assert.deepEqual(statusAppends(bare('working')), []);
  assert.deepEqual(statusAppends(bare('blocked')), []);
  assert.deepEqual(statusAppends(`grep "done [at=" ${HOME}/state/t1.status`), [], 'reading a done line is not writing one');
  assert.deepEqual(statusAppends(`echo "done [at=1]: x" >> ${HOME}/notes/t1.status`), [], 'not under state/');
  assert.deepEqual(statusAppends('echo "done [at=1]: x" >> $UNSET/state/t1.status'), [], 'a path the hook cannot resolve');
  assert.deepEqual(statusAppends('echo "done [at=1]: x" >> state/t1.status'), [], 'a relative path with no cwd');
  assert.deepEqual(statusAppends('ls'), []);
});

test('a report written by a Bash redirect, cp or mv, or by a file tool, is a write; a read is not', () => {
  const want = [{ home: HOME, task: 't1', why: 'report-write' }];
  assert.deepEqual(reportWrites(`cat > ${HOME}/data/t1/report.md <<'EOF'\n# R\nEOF`), want);
  assert.deepEqual(reportWrites(`cp /tmp/r.md ${HOME}/data/t1/report.md`), want);
  assert.deepEqual(reportWrites(`mv /tmp/r.md "${HOME}/data/t1/design.md"`), want);
  assert.deepEqual(reportWrites(`cat ${HOME}/data/t1/report.md`), []);
  assert.deepEqual(reportWrites(`wc -l ${HOME}/data/t1/report.md`), []);
  assert.deepEqual(fileWrite(`${HOME}/data/t1/report.md`), want[0]);
  assert.equal(fileWrite(`${HOME}/data/t1/notes.txt`), null);
  assert.equal(fileWrite(undefined), null);
});

test('a report rewrite counts only after delivery: not while the task is working', async () => withStubs(async ({ env }) => {
  const home = join(env.FM_HOME, '..', 'mini0-ops');
  const put = async (status: string | null) => {
    await mkdir(join(home, 'data', 't1'), { recursive: true });
    await mkdir(join(home, 'state'), { recursive: true });
    await writeFile(join(home, 'data', 't1', 'report.md'), '# R\n');
    await writeFile(join(home, 'state', 't1.status'), status ?? '');
    if (status === null) await rm(join(home, 'state', 't1.status'));
  };
  await put('working [at=1]: x\n');
  assert.equal(deliverable(home, 't1'), false);
  await put('working [at=1]: x\ndone [at=2]: y\n');
  assert.equal(deliverable(home, 't1'), true);
  await put('needs-decision [at=2]: y\n');
  assert.equal(deliverable(home, 't1'), true);
  await put(null);
  assert.equal(deliverable(home, 't1'), true);
  assert.equal(deliverable(join(home, 'nope'), 't1'), false);
  const { calls, spawn } = recorder();
  await put('working [at=1]: x\n');
  assert.deepEqual(scoutHook({ filePath: join(home, 'data', 't1', 'report.md'), env, spawn }), []);
  await put('done [at=3]: z\n');
  assert.equal(scoutHook({ filePath: join(home, 'data', 't1', 'report.md'), env, spawn }).length, 1);
  assert.equal(calls.length, 1);
}, { stores: STORES }));

test('the hook starts one detached capture for the delivery, and none for a failed call or an unrelated one', () => {
  const { calls, spawn } = recorder();
  const env = { HOME: '/Users/x', PATH: '/usr/bin', FM_HOOK_QUEUE: '/nonexistent/queue' };
  assert.equal(scoutHook({ command: withLedger(), cwd: '/tmp', env, spawn }).length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [entryPoint, 'capture', '--home', HOME, '--task', 't1', '--quiet']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.match(calls[0].options.env.PATH, /\/Users\/x\/\.local\/bin/, 'brain is found from a thin PATH');
  assert.equal(scoutHook({ command: withLedger(), env, spawn, ok: false }).length, 0);
  assert.equal(scoutHook({ command: 'ls -la', env, spawn }).length, 0);
  assert.equal(scoutHook({ command: bare('working'), env, spawn }).length, 0);
  assert.equal(scoutHook({ command: withLedger(), env: { ...env, FM_HOOK_SCOUT_CAPTURE: '0' }, spawn }).length, 0);
  assert.equal(calls.length, 1);
  assert.equal(scoutHook({ command: `${bare()} && ${bare()}`, env, spawn }).length, 1, 'one capture per task per call');
  assert.equal(launchCapture({ home: HOME, task: 't1' }, { env, spawn: () => { throw new Error('no spawn'); } }), false, 'a failed start never throws into the call');
});

test('a capture that failed is parked and started again by a later hook delivery, with backoff and a cap', async () => withStubs(async ({ env }) => {
  const root = env.FM_HOOK_QUEUE;
  const { calls, spawn } = recorder();
  const t0 = 1_000_000;
  await recordPending(root, { home: HOME, task: 't1' }, 'dolt unreachable', t0);
  assert.deepEqual(retryPending({ env, spawn, root, now: t0 + 30_000 }), [], 'too soon');
  assert.equal(retryPending({ env, spawn, root, now: t0 + 61_000 }).length, 1);
  assert.deepEqual(retryPending({ env, spawn, root, now: t0 + 62_000 }), [], 'claimed: a second hook does not start another');
  assert.equal(calls.length, 1);
  await recordPending(root, { home: HOME, task: 't1' }, 'again', t0 + 63_000);
  assert.deepEqual(retryPending({ env, spawn, root, now: t0 + 63_000 + 61_000 }), [], 'the second failure waits twice as long');
  assert.equal(retryPending({ env, spawn, root, now: t0 + 63_000 + 121_000 }).length, 1);
  for (let i = 0; i < 8; i++) await recordPending(root, { home: HOME, task: 't1' }, 'x', t0);
  assert.deepEqual(retryPending({ env, spawn, root, now: t0 + 10 ** 9 }), [], 'given up after the cap; the backfill still catches it');
  const recorded = JSON.parse(await readFile(join(root, 'scout-capture', 'pending', `${HOME.replace(/[^A-Za-z0-9._-]+/g, '_')}__t1.json`), 'utf8'));
  assert.ok(recorded.attempts >= 8);
}, { stores: STORES }));

// The real thing: the adapter's hook runs, starts the real capture entry point as a detached
// bun process, and the report shows up in the (stub) store.
async function untilRecord(env: any, id: string, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const db = JSON.parse(await readFile(env.STUB_DB, 'utf8').catch(() => '{}'));
    const bead = db.brain?.beads?.[id];
    if (bead?.labels?.some((l: string) => l.startsWith('fm-report-sha:'))) return bead;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}
async function withProcessEnv<T>(env: any, fn: () => Promise<T>) {
  const keys = Object.keys(env).filter(k => /^(STUB_|FM_HOOK_|FM_HOME)/.test(k));
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, Object.fromEntries(keys.map(k => [k, env[k]])));
  try { return await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
async function deliver(env: any) {
  const home = join(env.FM_HOME, '..', 'mini0-ops');
  await mkdir(join(home, 'data', 't1'), { recursive: true });
  await mkdir(join(home, 'state'), { recursive: true });
  await writeFile(join(home, 'data', 't1', 'report.md'), '# End to end\n\nThe finding.\n');
  await writeFile(join(home, 'state', 't1.status'), `working [at=1]: x\ndone [at=2]: ${LINE}\n`);
  return home;
}
const SCOUT_ID = 'brain-fmhscout-mini0-ops-t1';

test('Claude Code: a Bash call that delivers a scout puts the report in brain, with no worker, rules file or FM_HOME', async () => withStubs(async ({ env }) => {
  const home = await deliver(env);
  const command = `echo "done [at=2]: ${LINE}" >> '${home}/state/t1.status'`;
  await withProcessEnv({ ...env, FM_HOME: undefined }, () => handleClaudeHook({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp', session_id: 's', tool_use_id: 'c1' }, { eventName: 'PostToolUse', root: env.FM_HOOK_QUEUE }));
  const bead = await untilRecord(env, SCOUT_ID);
  assert.ok(bead, 'the report arrived');
  assert.equal(bead.comments.length, 1);
  assert.match(bead.comments[0].text, /The finding\./);
  assert.ok(bead.labels.includes('fm-home:mini0-ops'));
}, { stores: STORES }));

test('Claude Code: rewriting a delivered report with the Write tool updates the same record; a failed call does not capture', async () => withStubs(async ({ env }) => {
  const home = await deliver(env);
  const run = (event: any, name = 'PostToolUse') => withProcessEnv({ ...env, FM_HOME: undefined }, () => handleClaudeHook({ cwd: '/tmp', session_id: 's', ...event }, { eventName: name, root: env.FM_HOOK_QUEUE }));
  await run({ tool_name: 'Bash', tool_input: { command: bare().replace(HOME, home) }, tool_use_id: 'fail' }, 'PostToolUseFailure');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await untilRecord(env, SCOUT_ID, 500), null, 'a failed call captures nothing');
  await run({ tool_name: 'Bash', tool_input: { command: bare().replace(HOME, home) }, tool_use_id: 'c1' });
  const first = await untilRecord(env, SCOUT_ID);
  assert.ok(first);
  await writeFile(join(home, 'data', 't1', 'report.md'), '# End to end\n\nThe finding.\n\n## Revised\n\nMore.\n');
  await run({ tool_name: 'Write', tool_input: { file_path: join(home, 'data', 't1', 'report.md'), content: 'x' }, tool_use_id: 'w1' });
  const started = Date.now();
  let bead = first;
  while (Date.now() - started < 20000) {
    bead = JSON.parse(await readFile(env.STUB_DB, 'utf8')).brain.beads[SCOUT_ID];
    if (bead.comments.length === 2 && bead.labels.some((l: string) => l.startsWith('fm-report-sha:') && !first.labels.includes(l))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(Object.keys(JSON.parse(await readFile(env.STUB_DB, 'utf8')).brain.beads).length, 1);
  assert.equal(bead.comments.length, 2);
  assert.match(bead.comments[1].text, /## Revised/);
}, { stores: STORES }));

test('Pi: a bash call that delivers a scout puts the report in brain', async () => withStubs(async ({ env }) => {
  const home = await deliver(env);
  const handlers: Record<string, any> = {};
  fmHooksPiExtension({ on: (name: string, fn: any) => { handlers[name] = fn; } });
  const ctx = { cwd: '/tmp', sessionManager: { getSessionId: () => 's' } };
  await withProcessEnv({ ...env, FM_HOME: undefined }, async () => {
    handlers.tool_execution_start({ toolName: 'bash', toolCallId: 'p1', args: { command: bare().replace(HOME, home) } }, ctx);
    await handlers.tool_execution_end({ toolName: 'bash', toolCallId: 'p1', isError: false });
  });
  assert.ok(await untilRecord(env, SCOUT_ID));
}, { stores: STORES }));

test('OpenCode: a bash call that delivers a scout puts the report in brain', async () => withStubs(async ({ env }) => {
  const home = await deliver(env);
  const plugin: any = await fmHooksPlugin({ directory: '/tmp' });
  await withProcessEnv({ ...env, FM_HOME: undefined }, async () => {
    const command = bare().replace(HOME, home);
    await plugin['tool.execute.before']({ tool: 'bash', callID: 'o1' }, { args: { command } });
    await plugin['tool.execute.after']({ tool: 'bash', callID: 'o1', sessionID: 's', args: { command } }, { metadata: { exitCode: 0 }, output: '' });
  });
  assert.ok(await untilRecord(env, SCOUT_ID));
}, { stores: STORES }));

test('an opted-out report delivered through the hook is not captured, and the failed-capture marker is not left behind', async () => withStubs(async ({ env }) => {
  const home = await deliver(env);
  await writeFile(join(home, 'data', 't1', 'report.md'), '<!-- no-brain -->\n# Private\n');
  await withProcessEnv({ ...env, FM_HOME: undefined }, () => handleClaudeHook({ tool_name: 'Bash', tool_input: { command: bare().replace(HOME, home) }, cwd: '/tmp', session_id: 's', tool_use_id: 'c1' }, { eventName: 'PostToolUse', root: env.FM_HOOK_QUEUE }));
  assert.equal(await untilRecord(env, SCOUT_ID, 4000), null);
  assert.deepEqual(await readFile(join(env.FM_HOOK_QUEUE, 'scout-capture', 'pending'), 'utf8').catch(() => 'none'), 'none');
}, { stores: STORES }));
