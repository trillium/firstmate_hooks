import { open, readFile, rm, stat } from 'node:fs/promises';

// An exclusive lock file holding its owner's pid. A lock whose owner is gone is reclaimed
// under a guard lock that re-checks the owner, so concurrent claimants cannot remove a lock
// another just acquired.
// Returns the open lock file, or null while someone else legitimately holds it.
export async function claimLock(path: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(path, 'wx', 0o600);
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number((await readFile(path, 'utf8')).trim()); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return null; }
        catch (killError) { if (killError.code !== 'ESRCH') return null; }
      } else {
        // A lock with no pid yet is its owner between creating the file and writing to it,
        // not a dead one: reclaim it only once it has been that way for a while.
        const age = await stat(path).then(entry => Date.now() - entry.mtimeMs, () => Infinity);
        if (age < 2000) return null;
      }
      // Reclaim a dead owner's lock. Two claimants can both see the same dead pid, and the
      // loser of that race must not rename away the lock the winner has just created, so the
      // reclaim itself is serialized by a second lock and the owner is checked again inside it.
      if (!await reclaimDeadLock(path)) return null;
    }
  }
  return null;
}

async function reclaimDeadLock(path: string): Promise<boolean> {
  const guardPath = `${path}.reclaim`;
  let guard;
  try { guard = await open(guardPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A reclaimer that died holding the guard must not wedge the lock for good.
    const age = await stat(guardPath).then(entry => Date.now() - entry.mtimeMs, () => 0);
    if (age > 5000) await rm(guardPath, { force: true });
    return false;
  }
  try {
    let pid;
    try { pid = Number((await readFile(path, 'utf8')).trim()); }
    catch (readError) { if (readError.code === 'ENOENT') return true; throw readError; }
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }
      catch (killError) { if (killError.code !== 'ESRCH') return false; }
    }
    await rm(path, { force: true });
    return true;
  } finally { await guard.close(); await rm(guardPath, { force: true }); }
}

const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

// Runs `work` while holding the lock, waiting up to `timeoutMs` for it. Resolves
// `{ held: false }` without running `work` when the wait runs out, so a caller that must
// not block (a hook) decides what to do instead of hanging behind a stuck owner.
export async function withLock<T>(path: string, work: () => Promise<T>, { timeoutMs = 2000 }: { timeoutMs?: number } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let wait = 2; ; wait = Math.min(wait * 2, 40)) {
    const lock = await claimLock(path);
    if (lock) {
      try { return { held: true as const, value: await work() }; }
      finally { await lock.close(); await rm(path, { force: true }); }
    }
    if (Date.now() >= deadline) return { held: false as const };
    await sleep(wait + Math.floor(Math.random() * wait));
  }
}
