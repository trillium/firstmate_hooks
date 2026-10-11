import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

// The state root is absolute now, so fm-hooks normally writes nothing into the
// repository an agent runs in. But the artifact still lands inside a working tree in
// cases the default cannot prevent: an explicit FM_HOOK_STATE_DIR or FM_HOOK_QUEUE
// pointing into a checkout, or a home directory that is itself a repository. An
// untracked observer directory is indistinguishable from uncommitted work, so every
// clean-tree guard refuses to start -- the landed-work guard once parked three workers
// over exactly this directory, and eight stale copies had to be cleared by hand.
//
// The fix is the repository's own local exclude file: .git/info/exclude. It is honored
// by git but never committed, so fm-hooks keeps its promise not to modify the projects
// it observes. A committed .gitignore entry would be a change to someone else's repo.
//
// Every step here is best effort and silent. Failing to exclude must never fail the
// observation path: an observer that cannot record itself has still recorded the call,
// and a repo that refuses an exclude write is not a reason to break the tool call.

// Bound every git query. An observer must never hang a harness on a stuck git.
const GIT_TIMEOUT_MS = 5_000;

function runGit(cwd, args) {
  try {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error) return { status: null };
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null };
  }
}

// Which working tree contains this directory, and which exclude file does git actually
// read for it. `git rev-parse` answers for every shape: a plain checkout, a linked
// worktree whose .git is a file, and a submodule whose git dir lives inside the
// superproject. Assuming a .git directory at the current level gets two of the three
// wrong. --show-toplevel also fails outright for a bare repository and outside any
// repository, which is exactly the "do not write" case.
function workingTree(directory) {
  const { status, stdout } = runGit(directory, ['rev-parse', '--show-toplevel',
    '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--is-bare-repository']);
  if (status !== 0) return null;
  const [top, , common, bare] = stdout.split('\n');
  if (!top || !common || bare?.trim() !== 'false') return null;
  return { top: resolve(top.trim()), common: resolve(common.trim()) };
}

// A linked worktree reads excludes from the COMMON git dir, not its own. Writing to
// .git/worktrees/<name>/info/exclude silently does nothing: git ignores that file
// entirely. Verified against git 2.53 for both shapes.
function excludeFile(tree) {
  return resolve(tree.common, 'info', 'exclude');
}

// The working tree itself is never excluded, and neither is anything above it.
function classify(tree, target) {
  const inside = relative(tree.top, target);
  if (!inside) return { reason: 'is-working-tree' };
  if (inside === '..' || inside.startsWith(`..${sep}`)) return { reason: 'outside-working-tree' };
  const segments = inside.split(sep).map(segment =>
    // A path is data, not a glob: escape the characters gitignore would otherwise
    // read as wildcards. The leading "/" already defuses "#" and "!".
    segment.replace(/[*?\[\]]/g, character => `\\${character}`));
  return { pattern: `/${segments.join('/')}/` };
}

// 'ignored' | 'not-ignored' | 'unknown'. check-ignore is the only honest test: it sees
// .gitignore, .git/info/exclude, core.excludesFile and the negation rules, so an entry
// that already covers the path counts as excluded and is left alone. 'unknown' (an
// unexpected failure, or no git) is treated as do-not-write rather than guess twice.
function ignoreStatus(tree, target) {
  const { status } = runGit(tree.top, ['check-ignore', '-q', '--', relative(tree.top, target)]);
  if (status === 0) return 'ignored';
  if (status === 1) return 'not-ignored';
  return 'unknown';
}

// Append is the only edit made anywhere, it is a single short line, and it is keyed to a
// path git has just told us is not excluded. Re-reading first keeps a concurrent hook
// process from writing the same line twice.
async function appendPattern(file, pattern) {
  const existing = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (existing.split('\n').some(line => line.trim() === pattern)) return 'already-listed';
  // Never splice onto a file that does not end in a newline.
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(file, `${prefix}${pattern}\n`);
  return 'added';
}

const canonical = async path => realpath(path).catch(() => resolve(path));

// Exclude each path that lands inside a working tree. A path outside one is left alone --
// that is the common case now that the state root is absolute, and there is no repository
// whose opinion about the path could be consulted anyway.
export async function excludeFromGit(targets) {
  const result = { excluded: [], skipped: [] };
  const seen = [];
  for (const raw of targets) {
    if (!raw) continue;
    const target = await canonical(raw);
    // A directory already covered by a broader excluded path needs no second pattern.
    if (seen.some(parent => target === parent || target.startsWith(`${parent}${sep}`))) continue;
    const tree = workingTree(target);
    const { pattern, reason } = tree ? classify(tree, target) : { reason: 'no-working-tree' };
    if (!pattern) {
      result.skipped.push({ path: raw, reason });
      continue;
    }
    if (ignoreStatus(tree, target) !== 'not-ignored') {
      result.skipped.push({ path: raw, reason: 'already-excluded' });
      continue;
    }
    try {
      const file = excludeFile(tree);
      await mkdir(dirname(file), { recursive: true });
      await appendPattern(file, pattern);
      seen.push(target);
      result.excluded.push({ path: raw, pattern, file });
    } catch (error) {
      result.skipped.push({ path: raw, reason: `unwritable: ${error.code ?? error.message}` });
    }
  }
  return result;
}