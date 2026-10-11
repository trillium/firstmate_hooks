import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendEventLog } from '../src/queue.ts';

// Regression coverage for the filed defect: fm-hooks resolves its state absolutely, but
// an explicit FM_HOOK_STATE_DIR -- or a home directory that is itself a repository --
// still lands the queue inside a working tree, where an untracked observer directory is
// indistinguishable from uncommitted work. The landed-work guard refused to clean up
// finished tasks over exactly that, parking three workers.
//
// The acceptance criterion is always the same one the queue-path fix used: run the tool
// inside a scratch repository and `git status --porcelain` is empty afterwards. These
// tests pin that, plus the cases where exclusion must NOT happen.

const sourcePath = name => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

const fixture = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'fm-hooks-exclude-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

const childEnv = extras => {
  const env = { ...process.env };
  delete env.FM_HOOK_QUEUE;
  delete env.FM_HOOK_RULES;
  return Object.assign(env, extras);
};

const git = (cwd, args) => {
  const result = spawnSync('git', ['-c', 'user.email=fm-hooks@example.invalid', '-c', 'user.name=fm-hooks', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const mustGit = (cwd, args) => {
  const result = git(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

// git porcelain output is newline-terminated; compare the trimmed form.
const dirty = (cwd, args = ['status', '--porcelain']) => mustGit(cwd, args).trim();

const scratchRepo = async dir => {
  await mkdir(dir, { recursive: true });
  mustGit(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), 'scratch\n');
  mustGit(dir, ['add', '-A']);
  mustGit(dir, ['commit', '-qm', 'init']);
  return dir;
};

// The real adapter, run the way a harness runs it: from inside the repository, reading
// one PostToolUse payload on stdin.
const runHook = (cwd, env, tag = 'exclude-proof') => {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'exclude', tool_use_id: `${tag}-1`,
    tool_name: 'Bash', tool_input: { command: "fm_dispatch 'exclude proof task'" },
    cwd, tool_response: { exit_code: 0 },
  });
  return spawnSync(process.execPath, [sourcePath('claude-hook.ts')], { cwd, input: payload, encoding: 'utf8', env });
};

// git ships a comment header in a fresh .git/info/exclude, so compare the patterns,
// not the file. Comments and blanks are not patterns.
const excludeText = async repo => readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});

const patterns = async repo => (await excludeText(repo))
  .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

test('a state root inside a working tree is excluded locally and leaves the tree clean', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const stateDir = join(repo, '.fm-hooks');
  const before = await readdir(repo);
  assert.equal(mustGit(repo, ['status', '--porcelain']), '');

  const run = runHook(repo, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'inside');
  assert.equal(run.status, 0, run.stderr);

  // The acceptance criterion: the queue exists and the repository shows no dirt.
  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')));
  assert.equal(mustGit(repo, ['status', '--porcelain']), '');
  const added = (await readdir(repo)).filter(name => !before.includes(name));
  assert.deepEqual(added, ['.fm-hooks'], 'the state directory exists on disk; git simply must not see it');

  // Local, never committed: the exclude file is git-internal and untracked.
  assert.deepEqual(await patterns(repo), ['/.fm-hooks/']);
  assert.equal(dirty(repo, ['status', '--porcelain', '--ignored']), '!! .fm-hooks/');
  // No tracked file changed, and no .gitignore was created or edited.
  assert.equal(existsSync(join(repo, '.gitignore')), false);
  assert.equal(mustGit(repo, ['diff', '--name-only']), '');
  assert.equal(git(repo, ['ls-files', '--error-unmatch', '.gitignore']).status, 1,
    'no .gitignore was ever committed here');

  // A repeat run is a no-op: the pattern is listed once, not duplicated.
  const again = runHook(repo, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'inside-2');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(await patterns(repo), ['/.fm-hooks/']);
}));

test('a nested state root is anchored to the working tree, not to the process directory', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const deep = join(repo, 'tools', 'nested');
  await mkdir(deep, { recursive: true });
  const stateDir = join(deep, 'observer');

  const run = runHook(deep, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'nested');
  assert.equal(run.status, 0, run.stderr);

  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')));
  assert.equal(mustGit(repo, ['status', '--porcelain']), '');
  // Anchored and rooted: the pattern matches this repository's path and nothing else.
  assert.deepEqual(await patterns(repo), ['/tools/nested/observer/']);
}));

test('a path an existing rule already excludes is not listed twice', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  await writeFile(join(repo, '.gitignore'), '.fm-hooks/\n');
  mustGit(repo, ['add', '-A']);
  mustGit(repo, ['commit', '-qm', 'ignore']);
  const before = await excludeText(repo);

  const run = runHook(repo, childEnv({ FM_HOOK_STATE_DIR: join(repo, '.fm-hooks') }), 'already');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(dirty(repo), '');

  // The committed rule already covers it, so the local exclude file is not written at all.
  assert.deepEqual(await patterns(repo), []);
  assert.equal(await excludeText(repo), before);
  assert.equal(await readFile(join(repo, '.gitignore'), 'utf8'), '.fm-hooks/\n');
  assert.equal(dirty(repo), '');
}));

test('a linked worktree is excluded through the common git dir, which is the only file git reads', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const worktree = join(root, 'worktree');
  mustGit(repo, ['worktree', 'add', '-q', worktree, '-b', 'scratch']);

  const stateDir = join(worktree, '.fm-hooks');
  const run = runHook(worktree, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'worktree');
  assert.equal(run.status, 0, run.stderr);

  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')));
  assert.equal(mustGit(worktree, ['status', '--porcelain']), '',
    'the work tree must be clean; a pattern in the wrong file reads as clean but does not work');

  // The pattern lives in the shared .git/info/exclude. A linked worktree's own git dir
  // (.git/worktrees/<name>) has no info/exclude and git ignores one if it is created.
  const common = mustGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  assert.deepEqual((await readFile(join(common, 'info', 'exclude'), 'utf8'))
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')), ['/.fm-hooks/']);
  const own = mustGit(worktree, ['rev-parse', '--absolute-git-dir']).trim();
  assert.equal(existsSync(join(own, 'info', 'exclude')), false);
}));

test('a submodule excludes against its own working tree', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const library = await scratchRepo(join(root, 'library'));
  mustGit(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib']);
  mustGit(repo, ['commit', '-qm', 'submodule']);

  const sub = join(repo, 'lib');
  const stateDir = join(sub, '.fm-hooks');
  const run = runHook(sub, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'submodule');
  assert.equal(run.status, 0, run.stderr);

  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')));
  assert.equal(mustGit(sub, ['status', '--porcelain']), '');
  // The submodule reads its own git dir, not the superproject's.
  const subGitDir = mustGit(sub, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  assert.notEqual(subGitDir, mustGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  assert.deepEqual((await readFile(join(subGitDir, 'info', 'exclude'), 'utf8'))
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')), ['/.fm-hooks/']);
  // And the superproject is untouched by it.
  assert.equal(mustGit(repo, ['status', '--porcelain']), '');
}));

test('a bare repository is never written to and never breaks the observation', async () => fixture(async root => {
  const bare = join(root, 'bare.git');
  await mkdir(bare, { recursive: true });
  mustGit(bare, ['init', '-q', '--bare', '-b', 'main']);
  const stateDir = join(root, 'state');

  const run = runHook(bare, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'bare');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')), 'the observation is recorded regardless');
  // A bare repository has no working tree, so nothing is excluded anywhere near it.
  assert.deepEqual(await patterns(bare), []);
  assert.equal(mustGit(bare, ['rev-parse', '--is-bare-repository']).trim(), 'true');
}));

test('an unwritable exclude file is refused silently and the observation still lands', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const info = join(repo, '.git', 'info');
  const file = join(info, 'exclude');
  await mkdir(info, { recursive: true });
  await writeFile(file, '# pre-existing\n');
  // Read-only the file itself: the file already exists, so the directory's mode never
  // comes into play and only the file's own mode can refuse the append.
  await chmod(file, 0o444);
  const stateDir = join(repo, '.fm-hooks');

  const run = runHook(repo, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'readonly');
  await chmod(file, 0o644);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '', 'a refusal says nothing; it is not the observer\'s business to explain');
  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')));
  assert.equal(await readFile(file, 'utf8'), '# pre-existing\n');
  // Nothing is hidden: the dirt is simply still there for the operator to see.
  assert.equal(dirty(repo), '?? .fm-hooks/');
}));

test('state outside every working tree writes no exclude file anywhere', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  const stateDir = join(root, 'state');

  const run = runHook(elsewhere, childEnv({ FM_HOOK_STATE_DIR: stateDir }), 'outside');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(stateDir, 'queue', 'events.jsonl')));

  // The common case: nothing to exclude, so nothing is created -- not here, not in the
  // unrelated repository that happens to sit nearby on the same filesystem.
  assert.equal(existsSync(join(stateDir, '.git')), false);
  assert.deepEqual(await patterns(repo), []);
  assert.equal(existsSync(join(elsewhere, '.git')), false);
  assert.equal(mustGit(repo, ['status', '--porcelain']), '');
}));

test('the working tree itself is never excluded', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  // FM_HOOK_STATE_DIR pointing at the checkout root. Excluding the root would hide the
  // operator's own uncommitted work, which is exactly the confusion this prevents.
  const script = target => `import { excludeFromGit } from ${JSON.stringify(new URL('../src/exclude.ts', import.meta.url).href)};
    process.stdout.write(JSON.stringify(await excludeFromGit([${target}])));`;
  const direct = spawnSync(process.execPath, ['-e', script(JSON.stringify(repo))],
    { cwd: repo, encoding: 'utf8', env: childEnv({}) });
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), {
    excluded: [],
    skipped: [{ path: repo, reason: 'is-working-tree' }],
  });
  assert.deepEqual(await patterns(repo), []);

  // The queue created under it is ordinary observer state and is excluded, so a run
  // against this layout still leaves the tree clean.
  const run = runHook(repo, childEnv({ FM_HOOK_STATE_DIR: repo }), 'root');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(repo, 'queue', 'events.jsonl')));
  assert.deepEqual(await patterns(repo), ['/queue/']);
  assert.equal(dirty(repo), '');
  // Tracked work is never hidden by an exclude file, only untracked files are.
  assert.equal(dirty(repo, ['status', '--porcelain', '--ignored']), '!! queue/');
}));

test('a directory whose name reads as a glob is excluded literally', async () => fixture(async root => {
  const repo = await scratchRepo(join(root, 'repo'));
  // Brackets and stars are gitignore wildcards. A path is data, so an operator-chosen
  // directory name must not widen the exclusion to its neighbours.
  const stateDir = join(repo, 'state[1]*');
  await mkdir(stateDir, { recursive: true });
  const run = spawnSync(process.execPath, ['-e',
    `import { excludeFromGit } from ${JSON.stringify(new URL('../src/exclude.ts', import.meta.url).href)};
     process.stdout.write(JSON.stringify(await excludeFromGit([process.argv[1]])));`, stateDir],
  { cwd: repo, encoding: 'utf8', env: childEnv({}) });
  assert.equal(run.status, 0, run.stderr);
  const outcome = JSON.parse(run.stdout);
  assert.deepEqual(outcome.excluded.map(entry => entry.pattern), ['/state\\[1\\]\\*/']);

  await mkdir(join(stateDir, 'queue'), { recursive: true });
  await writeFile(join(stateDir, 'queue', 'events.jsonl'), '{"seen":1}\n');
  await mkdir(join(repo, 'state1x'), { recursive: true });
  await writeFile(join(repo, 'state1x', 'keep.txt'), 'real work\n');
  assert.equal(mustGit(repo, ['status', '--porcelain']).trim(), '?? state1x/',
    'only the named directory is excluded; an unescaped pattern would swallow its neighbour too');
}));

test('the queue write path alone is enough to trigger exclusion', async () => fixture(async root => {
  // No hook, no adapter: the seam is the queue, so anything that writes state excludes it.
  const repo = await scratchRepo(join(root, 'repo'));
  const stateDir = join(repo, 'state');
  const script = `import { appendEventLog } from ${JSON.stringify(new URL('../src/queue.ts', import.meta.url).href)};
    await appendEventLog({ type: 'seen', matched: false, harness: 'pi' });`;
  const run = spawnSync(process.execPath, ['-e', script],
    { cwd: repo, encoding: 'utf8', env: childEnv({ FM_HOOK_STATE_DIR: stateDir }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(mustGit(repo, ['status', '--porcelain']), '');
  assert.deepEqual(await patterns(repo), ['/state/']);
}));