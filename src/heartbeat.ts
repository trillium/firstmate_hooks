import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { queueRoot } from './paths.ts';

// A process being present is not a process working. Today's fleet contained three
// components that looked alive and were not: a build at 17 minutes elapsed with
// 0.01s of CPU, a watcher child that wrote one beat and then died, and a verify run
// that produced no output for an hour. A durable, self-describing beat is therefore
// part of the worker, not an optional nicety: the supervisor and the operator read
// this file to tell "running" from "running and still making progress".

export const DEFAULT_STALE_MS = 15000;

// One beat per role per queue. The worker and its supervisor are separate processes
// with separate failure modes; a restart overwrites that role's beat, so each file
// always names the process that most recently proved *it* was alive. Keeping them in
// separate files also stops the supervisor's liveness from being reported as the
// worker's -- a live parent over a dead child is precisely the failure to detect.
export function heartbeatPath(root = queueRoot(), role = 'worker') {
  return join(root, 'worker', `${role}.json`);
}

// A pid is only evidence of liveness to the extent the kernel can confirm it. EPERM
// means the process exists but belongs to another user, which still counts as alive.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// A beat's temporary file is named after the process writing it, so a sweep can tell a
// write in flight (the pid is alive) from litter (the pid is gone).
const TEMPORARY = /^.+\.json\.(\d+)\.[^.]+\.tmp$/;

export async function writeHeartbeat(root, beat, role = 'worker') {
  const path = heartbeatPath(root, role);
  await mkdir(dirname(path), { recursive: true });
  const record = { role, ...beat, pid: process.pid, updatedAt: new Date().toISOString() };
  // Written through a temporary file and renamed, so a reader never sees a half-written
  // beat -- which would read as a dead worker rather than a busy one. The temporary is
  // removed on every way out of the write, so a failed write or rename leaves nothing
  // behind; after a successful rename there is nothing to remove.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  await sweepHeartbeatTemporaries(root);
  return { path, record };
}

// A process killed between opening its temporary and renaming it -- launchd's SIGKILL,
// a crash -- never reaches the removal above, and nothing else owned the file, so one
// hard kill per restart grew the beat directory without bound. Every beat therefore
// also sweeps that directory for temporaries whose writing process is gone. A temporary
// whose pid is alive is a write in flight, this process's or another role's, and is left
// alone; so is anything not of that shape, since the launchd logs share the directory.
export async function sweepHeartbeatTemporaries(root = queueRoot()) {
  const directory = dirname(heartbeatPath(root));
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const name of names) {
    const match = TEMPORARY.exec(name);
    if (!match || pidAlive(Number(match[1]))) continue;
    // Another role's beat may be sweeping the same file; losing that race is fine.
    await rm(join(directory, name), { force: true });
    removed.push(join(directory, name));
  }
  return removed;
}

export async function readHeartbeat(root = queueRoot(), role = 'worker') {
  try { return JSON.parse(await readFile(heartbeatPath(root, role), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
