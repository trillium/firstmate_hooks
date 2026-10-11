import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeOnce, writeOnceRaw } from './atomic.ts';
import { excludeFromGit } from './exclude.ts';
import { namespaceKey, queueRoot, safeCwd, stateRoot } from './paths.ts';

// Before this fix the queue default was the relative path '.fm-hooks/queue', resolved
// against process.cwd(). Directories created that way during previous runs still exist
// inside product repositories. They must be neither silently abandoned (queued jobs and
// recorded events would be lost) nor silently kept (that is the defect being fixed).
//
// On the first run against the default queue root, a legacy cwd-relative queue is
// copied -- never moved, never deleted -- into fm-hooks' own state:
//   <root>/migrated/<repo-key>/events.jsonl   archived observation log
//   <root>/migrated/<repo-key>/events/*.json  archived durable events
//   <root>/migrated/<repo-key>/done|failed/   archived worker outcome records
//   <root>/jobs/*.json                        re-queued so a worker still executes them
//   <root>/migrated/<repo-key>/MIGRATED.json  marker naming the legacy path
// A one-time notice is written to stderr naming both locations. The legacy directory is
// left exactly as found for the operator to delete; fm-hooks never removes files from a
// product tree, and creating a marker there would itself dirty the tree.
//
// Every step is idempotent: copied files and the marker use exclusive creation, so a
// repeat run or a concurrent first run cannot duplicate or clobber state.

const adopted = new Set();
const excluded = new Set();

// The state root is absolute, so the queue normally lands outside every repository. It
// does not have to: an explicit FM_HOOK_STATE_DIR or FM_HOOK_QUEUE can point into a
// checkout, and a home directory can itself be a repository. There the queue would read
// as uncommitted work and stop every clean-tree guard, so fm-hooks adds the path to
// the owning repository's local exclude file rather than to a .gitignore it would have
// to commit to someone else's project.
//
// Detection starts from the path itself, not from the working directory, because the
// only question that matters is which working tree owns the directory. Memoized per
// process like adoption: a long-lived harness must not shell out to git per call, and
// the memo also covers the common case where there is nothing to exclude.
async function excludeObservedState(root) {
  const key = resolve(root);
  if (excluded.has(key)) return;
  excluded.add(key);
  try { await excludeFromGit([stateRoot(), root]); }
  catch (error) { /* A refusal is silent: the observation still stands on its own. */ }
}

export async function ensureQueue(root, options: Record<string, any> = {}) {
  const cwd = options.cwd ?? safeCwd();
  // Adoption happens only for the default state-resident queue. An explicit
  // FM_HOOK_QUEUE, or any caller-supplied root, means the operator owns the layout.
  const migrate = options.migrate ?? (resolve(root) === resolve(queueRoot()) && !process.env.FM_HOOK_QUEUE);
  const key = `${root}\0${cwd ?? ''}`;
  // Memoized per process: a long-lived harness such as the Pi extension must not
  // re-check the legacy path on every observed call.
  if (migrate && !adopted.has(key)) {
    adopted.add(key);
    try { await migrateLegacyQueue({ root, cwd }); }
    catch (error) { console.error(`fm-hooks legacy migration error: ${error.message}`); }
  }
  await mkdir(root, { recursive: true });
  await excludeObservedState(root);
  return root;
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function copyExclusive(source, target) {
  let bytes;
  try { bytes = await readFile(source); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  return (await writeOnceRaw(target, bytes)) ? 1 : 0;
}

async function copyDirectory(source, target) {
  let names;
  try { names = await readdir(source); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  if (!names.length) return 0;
  await mkdir(target, { recursive: true });
  let copied = 0;
  for (const name of names.sort()) copied += await copyExclusive(join(source, name), join(target, name));
  return copied;
}

export async function migrateLegacyQueue({ root, cwd = safeCwd() }) {
  if (!cwd) return { migrated: false, reason: 'no-cwd' };
  const legacy = join(cwd, '.fm-hooks', 'queue');
  if (resolve(legacy) === resolve(root)) return { migrated: false, reason: 'is-queue' };
  let info;
  try { info = await stat(legacy); }
  catch (error) { if (error.code === 'ENOENT') return { migrated: false, reason: 'absent' }; throw error; }
  if (!info.isDirectory()) return { migrated: false, reason: 'not-a-directory' };

  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  const archive = join(root, 'migrated', namespaceKey(realCwd));
  const marker = join(archive, 'MIGRATED.json');
  if (await exists(marker)) return { migrated: false, reason: 'already-migrated', archive };

  const copied = {
    events: await copyDirectory(join(legacy, 'events'), join(archive, 'events')),
    logLines: await copyExclusive(join(legacy, 'events.jsonl'), join(archive, 'events.jsonl')),
    jobs: await copyDirectory(join(legacy, 'jobs'), join(root, 'jobs')),
    done: await copyDirectory(join(legacy, 'done'), join(archive, 'done')),
    failed: await copyDirectory(join(legacy, 'failed'), join(archive, 'failed')),
  };

  const first = await writeOnce(marker, {
    legacy, queue: root, archive, realCwd,
    migratedAt: new Date().toISOString(), copied,
  });
  if (!first) return { migrated: false, reason: 'raced', archive };

  console.error(
    `fm-hooks: adopted legacy queue ${legacy} into ${archive}` +
    (copied.jobs ? ` and re-queued ${copied.jobs} job(s) into ${join(root, 'jobs')}` : '') +
    '; the legacy directory is left in place and can be deleted.'
  );
  return { migrated: true, archive, copied };
}
