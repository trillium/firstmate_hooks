import { randomUUID } from 'node:crypto';
import { link, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pidAlive } from './heartbeat.ts';

// A temporary is written beside its target and named after the process writing it, so a
// sweep can tell a write in flight (the pid is alive) from litter (the pid is gone).
const temporaryFor = path => `${path}.${process.pid}.${randomUUID()}.tmp`;

// Durable, exclusive, atomic file creation: write a private temporary file, fsync it,
// then hard-link it into place. A second writer of the same path gets EEXIST and loses
// rather than clobbering, so repeated hook deliveries cannot duplicate durable state.
export async function writeOnceRaw(path, bytes) {
  const temporary = temporaryFor(path);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally { await rm(temporary, { force: true }); }
}

export const writeOnce = (path, value) => writeOnceRaw(path, `${JSON.stringify(value)}\n`);

// Durable, atomic replacement: write a private temporary file, fsync it, then rename it
// over the target, so a reader sees the old file or the new one and never half of one.
// The temporary is removed on every way out of the write (a no-op after a successful
// rename), so a failed write or rename leaves nothing behind. A process killed between
// the two never reaches that removal, so every write also sweeps the target's directory
// for temporaries whose writer is gone -- the shape heartbeat.ts uses for its beats.
export async function replaceRaw(path, bytes, { mode = 0o600 } = {}) {
  const temporary = temporaryFor(path);
  try {
    const file = await open(temporary, 'wx', mode);
    // The mode is also set explicitly, so the result does not depend on the umask.
    try { await file.chmod(mode); await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  await sweepTemporaries(path);
}

export const replaceJson = (path, value) => replaceRaw(path, `${JSON.stringify(value)}\n`);

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes the `<name>.<pid>.<uuid>.tmp` files beside `path` whose writing process is
// gone. A temporary whose pid is alive is a write in flight and is left alone; so is
// every other file in the directory, since a deploy target shares its directory with
// unrelated state and another file's temporaries are that file's writer's to sweep.
export async function sweepTemporaries(path) {
  const directory = dirname(path);
  const pattern = new RegExp(`^${escapeRegExp(basename(path))}\\.(\\d+)\\.[^.]+\\.tmp$`);
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match || pidAlive(Number(match[1]))) continue;
    // Another writer of the same file may be sweeping it too; losing that race is fine.
    await rm(join(directory, name), { force: true });
    removed.push(join(directory, name));
  }
  return removed;
}
