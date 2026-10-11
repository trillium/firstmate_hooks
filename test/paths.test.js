import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendEventLog, loadRules } from '../src/queue.js';
import { migrateLegacyQueue } from '../src/migrate.js';
import { defaultRulesPaths, namespaceKey, queueRoot, stateRoot } from '../src/paths.js';

// Regression coverage for the filed defect: fm-hooks used the relative default
// '.fm-hooks/queue' resolved against process.cwd(), so running an agent inside a
// product repository created observer state inside that repository.

const sourcePath = name => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

const fixture = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'fm-hooks-paths-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

// The default overrides are proven absent, so a child process exercises the real defaults.
const childEnv = extras => {
  const env = { ...process.env };
  delete env.FM_HOOK_QUEUE;
  delete env.FM_HOOK_RULES;
  return Object.assign(env, extras);
};

const withEnv = async (overrides, fn) => {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await fn(); }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const git = (cwd, args) => {
  const result = spawnSync('git', ['-c', 'user.email=fm-hooks@example.invalid', '-c', 'user.name=fm-hooks', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const scratchRepo = async dir => {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), 'scratch\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
};

const repositoryFiles = async dir => {
  const found = [];
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full); else found.push(relative(dir, full));
    }
  };
  await walk(dir);
  return found.sort();
};

const readLog = async path =>
  (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('the default queue root is absolute, state-resident, and never the working directory', async () => fixture(async root => {
  const expected = join(homedir(), '.local', 'state', 'fm-hooks', 'queue');
  assert.equal(queueRoot({}), expected);
  assert.ok(isAbsolute(expected));
  assert.equal(queueRoot({ FM_HOOK_QUEUE: undefined, FM_HOOK_STATE_DIR: undefined }), expected);

  // Observed, not asserted: two processes in different directories resolve one path.
  const a = join(root, 'a'), b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  const script = `import { queueRoot } from ${JSON.stringify(pathToFileURL(sourcePath('paths.js')).href)};` +
    `process.stdout.write(queueRoot({ FM_HOOK_STATE_DIR: '/tmp/fm-hooks-resolution-proof' }));`;
  const from = cwd => spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' });
  const first = from(a), second = from(b);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, join('/tmp/fm-hooks-resolution-proof', 'queue'));
  assert.equal(second.stdout, first.stdout);
}));

test('state and queue roots follow the documented override chain', () => {
  assert.equal(queueRoot({ FM_HOOK_QUEUE: '/tmp/explicit-queue' }), '/tmp/explicit-queue');
  // A relative override is anchored to the home directory, never to process.cwd().
  assert.equal(queueRoot({ FM_HOOK_QUEUE: 'relative/queue' }), resolve(homedir(), 'relative/queue'));

  assert.equal(stateRoot({ FM_HOOK_STATE_DIR: '/tmp/state' }), '/tmp/state');
  assert.equal(stateRoot({ FM_HOME: '/tmp/fmhome' }), join('/tmp/fmhome', 'state', 'fm-hooks'));
  assert.equal(stateRoot({ XDG_STATE_HOME: '/tmp/xdg' }), join('/tmp/xdg', 'fm-hooks'));
  assert.equal(stateRoot({}), join(homedir(), '.local', 'state', 'fm-hooks'));

  assert.equal(queueRoot({ FM_HOOK_STATE_DIR: '/tmp/state' }), join('/tmp/state', 'queue'));
  assert.equal(queueRoot({ FM_HOME: '/tmp/fmhome' }), join('/tmp/fmhome', 'state', 'fm-hooks', 'queue'));
  // The explicit queue override outranks the state root.
  assert.equal(queueRoot({ FM_HOOK_QUEUE: '/tmp/q', FM_HOOK_STATE_DIR: '/tmp/state' }), '/tmp/q');
});

test('an agent run inside a scratch git repository leaves the tree clean and writes state elsewhere', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const stateDir = join(root, 'state');
  const before = await repositoryFiles(repo);
  assert.equal(git(repo, ['status', '--porcelain']), '');
  const env = childEnv({ FM_HOOK_STATE_DIR: stateDir });

  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'claude-proof', tool_use_id: 'claude-proof-1',
    tool_name: 'Bash', tool_input: { command: "fm_dispatch 'claude proof task'" },
    cwd: repo, tool_response: { exit_code: 0 },
  });
  const claude = spawnSync(process.execPath, [sourcePath('claude-hook.js')], { cwd: repo, input: payload, encoding: 'utf8', env });
  assert.equal(claude.status, 0, claude.stderr);

  const piHarness = `import fmHooksPiExtension from ${JSON.stringify(pathToFileURL(sourcePath('pi-extension.js')).href)};
const handlers = new Map();
fmHooksPiExtension({ on: (name, handler) => handlers.set(name, handler) });
const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'pi-proof' } };
await handlers.get('tool_execution_start')({ toolCallId: 'pi-proof-1', toolName: 'bash', args: { command: "fm_dispatch 'pi proof task'" } }, ctx);
await handlers.get('tool_execution_end')({ toolCallId: 'pi-proof-1', toolName: 'bash', isError: false });
`;
  const pi = spawnSync(process.execPath, ['--input-type=module', '-e', piHarness], { cwd: repo, encoding: 'utf8', env });
  assert.equal(pi.status, 0, pi.stderr);

  // The headline acceptance criterion: the product tree is byte-identical to before.
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.deepEqual(await repositoryFiles(repo), before);
  assert.equal(existsSync(join(repo, '.fm-hooks')), false);

  // And the queue visibly went to fm-hooks' own absolute state instead.
  const log = join(stateDir, 'queue', 'events.jsonl');
  assert.ok(isAbsolute(log) && !log.startsWith(repo));
  assert.ok(existsSync(log), `expected the queue at ${log}`);
  const records = await readLog(log);
  assert.deepEqual(records.map(record => record.harness), ['claude-code', 'pi']);
  assert.deepEqual(records.map(record => record.operation), ['fm_dispatch', 'fm_dispatch']);
  // Both harnesses recorded the real repository path (macOS /var is a symlink).
  const realRepo = await realpath(repo);
  assert.deepEqual(await Promise.all(records.map(record => realpath(record.cwd))), [realRepo, realRepo]);
  assert.equal((await readdir(join(stateDir, 'queue', 'events'))).length, 2);
}));

test('one shared queue serves every working directory', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  const stateDir = join(root, 'state');
  const env = childEnv({ FM_HOOK_STATE_DIR: stateDir });

  for (const [index, cwd] of [repo, elsewhere].entries()) {
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 'cwd-proof', tool_use_id: `cwd-proof-${index}`,
      tool_name: 'Bash', tool_input: { command: "fm_dispatch 'cwd proof task'" },
      cwd, tool_response: { exit_code: 0 },
    });
    const run = spawnSync(process.execPath, [sourcePath('claude-hook.js')], { cwd, input: payload, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
  }

  assert.equal(existsSync(join(repo, '.fm-hooks')), false);
  assert.equal(existsSync(join(elsewhere, '.fm-hooks')), false);
  const records = await readLog(join(stateDir, 'queue', 'events.jsonl'));
  assert.deepEqual(await Promise.all(records.map(record => realpath(record.cwd))),
    await Promise.all([realpath(repo), realpath(elsewhere)]));
}));

test('a legacy cwd-relative queue is adopted into state exactly once and left in place', async () => fixture(async root => {
  const repo = join(root, 'repo'), queue = join(root, 'state', 'queue');
  const legacy = join(repo, '.fm-hooks', 'queue');
  for (const dir of ['events', 'jobs', 'done']) await mkdir(join(legacy, dir), { recursive: true });
  await writeFile(join(legacy, 'events.jsonl'), '{"legacy":1}\n{"legacy":2}\n');
  await writeFile(join(legacy, 'events', 'evt.json'), '{"legacy":true}\n');
  await writeFile(join(legacy, 'jobs', 'job.json'), '{"id":"legacy-job"}\n');
  await writeFile(join(legacy, 'done', 'old.json'), '{"id":"old-job"}\n');
  const before = await repositoryFiles(repo);

  const first = await migrateLegacyQueue({ root: queue, cwd: repo });
  assert.equal(first.migrated, true);
  const archives = await readdir(join(queue, 'migrated'));
  assert.equal(archives.length, 1);
  assert.equal(archives[0], namespaceKey(await realpath(repo)));
  const archive = join(queue, 'migrated', archives[0]);

  // Contents are copied -- never moved -- into fm-hooks' own state.
  assert.equal(await readFile(join(archive, 'events.jsonl'), 'utf8'), '{"legacy":1}\n{"legacy":2}\n');
  assert.equal(await readFile(join(archive, 'events', 'evt.json'), 'utf8'), '{"legacy":true}\n');
  assert.equal(await readFile(join(archive, 'done', 'old.json'), 'utf8'), '{"id":"old-job"}\n');
  assert.equal(await readFile(join(queue, 'jobs', 'job.json'), 'utf8'), '{"id":"legacy-job"}\n');
  const marker = JSON.parse(await readFile(join(archive, 'MIGRATED.json'), 'utf8'));
  assert.equal(marker.legacy, legacy);
  assert.equal(marker.queue, queue);
  assert.deepEqual(marker.copied, { events: 1, logLines: 1, jobs: 1, done: 1, failed: 0 });

  // Nothing was moved, deleted, or created inside the repository.
  assert.deepEqual(await repositoryFiles(repo), before);
  assert.equal(await readFile(join(legacy, 'events.jsonl'), 'utf8'), '{"legacy":1}\n{"legacy":2}\n');

  // A repeat run is a no-op: no duplicate archive, no duplicated lines.
  const second = await migrateLegacyQueue({ root: queue, cwd: repo });
  assert.deepEqual({ migrated: second.migrated, reason: second.reason }, { migrated: false, reason: 'already-migrated' });
  assert.equal((await readdir(join(queue, 'migrated'))).length, 1);
  assert.equal((await readdir(join(archive, 'events'))).length, 1);
  assert.equal(await readFile(join(archive, 'events.jsonl'), 'utf8'), '{"legacy":1}\n{"legacy":2}\n');
}));

test('an explicit FM_HOOK_QUEUE keeps the operator layout and adopts nothing', async () => fixture(async root => {
  const repo = join(root, 'repo'), explicit = join(root, 'explicit');
  await mkdir(join(repo, '.fm-hooks', 'queue'), { recursive: true });
  await writeFile(join(repo, '.fm-hooks', 'queue', 'events.jsonl'), '{"legacy":1}\n');

  await withEnv({ FM_HOOK_QUEUE: explicit }, async () => {
    await appendEventLog({ type: 'seen', matched: false, harness: 'pi' });
  });

  assert.ok(existsSync(join(explicit, 'events.jsonl')));
  assert.equal(existsSync(join(explicit, 'migrated')), false);
}));

test('rules resolution is absolute and read-only, preferring explicit then project-local', async () => fixture(async root => {
  const project = join(root, 'project'), stateDir = join(root, 'state');
  await mkdir(project, { recursive: true });
  const env = { FM_HOOK_STATE_DIR: stateDir };
  const rule = id => ({ id, operation: 'fm_dispatch', outcomes: ['success'], action: { command: 'fixture', args: [] } });

  assert.deepEqual(defaultRulesPaths(env, project), [
    join(project, 'fm-hooks.rules.json'),
    join(stateDir, 'fm-hooks.rules.json'),
  ]);
  assert.deepEqual(defaultRulesPaths({ ...env, FM_HOOK_RULES: 'custom.json' }, project), [resolve(homedir(), 'custom.json')]);
  assert.deepEqual(defaultRulesPaths({ ...env, FM_HOOK_RULES: '/tmp/abs-rules.json' }, project), ['/tmp/abs-rules.json']);
  assert.deepEqual(await loadRules(defaultRulesPaths(env, project)), []);

  const stateRules = join(stateDir, 'fm-hooks.rules.json');
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateRules, JSON.stringify({ rules: [rule('state')] }));
  assert.deepEqual((await loadRules(defaultRulesPaths(env, project))).map(entry => entry.id), ['state']);

  // A project-local file is a read-only per-project override.
  await writeFile(join(project, 'fm-hooks.rules.json'), JSON.stringify({ rules: [rule('project')] }));
  assert.deepEqual((await loadRules(defaultRulesPaths(env, project))).map(entry => entry.id), ['project']);
  assert.deepEqual((await loadRules(defaultRulesPaths({ ...env, FM_HOOK_RULES: stateRules }, project))).map(entry => entry.id), ['state']);

  // A malformed project file is an error, not a silent fall-through to another rule set.
  await writeFile(join(project, 'fm-hooks.rules.json'), '{ not json');
  await assert.rejects(() => loadRules(defaultRulesPaths(env, project)), SyntaxError);

  // Reading rules never creates anything in the project.
  assert.deepEqual(await readdir(project), ['fm-hooks.rules.json']);
}));

test('events.jsonl rotation bounds the log and keeps only the configured rolls', async () => fixture(async root => {
  const record = index => ({ type: 'seen', matched: false, harness: 'pi', index, filler: 'x'.repeat(200) });
  await withEnv({ FM_HOOK_EVENT_LOG_MAX_BYTES: '512', FM_HOOK_EVENT_LOG_KEEP: '2', FM_HOOK_QUEUE: root }, async () => {
    for (let index = 0; index < 12; index++) await appendEventLog(record(index), root);
  });

  const rolls = (await readdir(root)).filter(name => name.startsWith('events.jsonl')).sort();
  assert.deepEqual(rolls, ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2']);
  const live = (await stat(join(root, 'events.jsonl'))).size;
  assert.ok(live < 1024, `the live log must stay near the cap, saw ${live} bytes`);
  assert.ok((await stat(join(root, 'events.jsonl.1'))).size >= 512);
  assert.ok((await stat(join(root, 'events.jsonl.2'))).size >= 512);

  // Bounded, and it drops the oldest rather than the newest: the most recent
  // observation is always present and the log never exceeds cap x (keep + 1).
  const kept = (await Promise.all(rolls.map(name => readLog(join(root, name))))).flat();
  const indexes = kept.map(entry => entry.index);
  assert.equal(Math.max(...indexes), 11);
  assert.ok(Math.min(...indexes) > 0, 'older rolls must be dropped');
  assert.ok(kept.length >= 4 && kept.length <= 6, `kept ${kept.length} records`);
}));

test('a repository that already holds a legacy queue is adopted without touching the repository', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const stateDir = join(root, 'state');
  const legacy = join(repo, '.fm-hooks', 'queue');
  await mkdir(join(legacy, 'events'), { recursive: true });
  await writeFile(join(legacy, 'events.jsonl'), '{"legacy":1}\n{"legacy":2}\n');
  await writeFile(join(legacy, 'events', 'evt.json'), '{"legacy":true}\n');
  const before = await repositoryFiles(repo);
  const statusBefore = git(repo, ['status', '--porcelain']);
  assert.equal(statusBefore, '?? .fm-hooks/\n');

  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'legacy-proof', tool_use_id: 'legacy-proof-1',
    tool_name: 'Bash', tool_input: { command: "fm_dispatch 'legacy proof task'" },
    cwd: repo, tool_response: { exit_code: 0 },
  });
  const run = spawnSync(process.execPath, [sourcePath('claude-hook.js')],
    { cwd: repo, input: payload, encoding: 'utf8', env: childEnv({ FM_HOOK_STATE_DIR: stateDir }) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /adopted legacy queue/);

  // The repository is byte-identical to before: the legacy directory is neither
  // extended nor removed, and no marker is written into the product tree.
  assert.equal(git(repo, ['status', '--porcelain']), statusBefore);
  assert.deepEqual(await repositoryFiles(repo), before);
  assert.equal(await readFile(join(legacy, 'events.jsonl'), 'utf8'), '{"legacy":1}\n{"legacy":2}\n');

  // The legacy contents now live in fm-hooks' own state, so nothing is abandoned.
  const archives = await readdir(join(stateDir, 'queue', 'migrated'));
  assert.equal(archives.length, 1);
  const archive = join(stateDir, 'queue', 'migrated', archives[0]);
  assert.equal(await readFile(join(archive, 'events.jsonl'), 'utf8'), '{"legacy":1}\n{"legacy":2}\n');
  assert.equal(await readFile(join(archive, 'events', 'evt.json'), 'utf8'), '{"legacy":true}\n');
  assert.ok(existsSync(join(archive, 'MIGRATED.json')));
  assert.deepEqual((await readLog(join(stateDir, 'queue', 'events.jsonl'))).map(record => record.operation), ['fm_dispatch']);
}));

test('a zero size cap disables rotation explicitly', async () => fixture(async root => {
  await withEnv({ FM_HOOK_EVENT_LOG_MAX_BYTES: '0', FM_HOOK_EVENT_LOG_KEEP: '2', FM_HOOK_QUEUE: root }, async () => {
    for (let index = 0; index < 12; index++) await appendEventLog({ type: 'seen', index, filler: 'x'.repeat(200) }, root);
  });
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('events.jsonl')), ['events.jsonl']);
  assert.ok((await stat(join(root, 'events.jsonl'))).size > 512);
}));
