import { hostname } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { replaceRaw } from './atomic.ts';
import { resolveFmHome } from './fm-home.ts';
import { withLock } from './lock.ts';
import { scrubPath } from './scrub.ts';

// Every record fm-hooks writes says where it came from and where it falls in the queue:
//   seq            a per-queue counter that only goes up, so order does not depend on
//                  millisecond timestamps that two hook processes can share
//   fmHome         the Firstmate home the call belongs to (home directory written as ~)
//   machine        the host that observed it
//   schemaVersion  2 for records stamped this way; a record without the field is version 1
// All four are additive: nothing a consumer read before has moved or changed meaning.

export const SCHEMA_VERSION = 2;

const DEFAULT_LOCK_TIMEOUT_MS = 2000;

// FM_HOOK_MACHINE names the machine for the consumer (`mini0`, `macbook`); without it the
// short, lower-case host name stands in.
export function machineName(env: Record<string, any> = process.env): string {
  const named = typeof env.FM_HOOK_MACHINE === 'string' ? env.FM_HOOK_MACHINE.trim() : '';
  const name = named || hostname().split('.')[0].toLowerCase();
  return name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
}

const counterPath = (root: string) => join(root, 'seq', 'counter');

// The next number of the queue's counter, allocated under a lock so concurrent hook
// processes each get a different one. A counter that cannot be read as a number restarts
// from the clock in milliseconds, which is above any count a queue can have reached, so a
// damaged counter never repeats a seq. Resolves null (never throws) when the lock cannot be
// taken in time: the caller still writes its record, unordered, rather than losing it or
// holding the tool call behind a stuck owner.
export async function nextSeq(root: string, env: Record<string, any> = process.env): Promise<number | null> {
  const timeoutMs = Number.isInteger(Number(env.FM_HOOK_SEQ_LOCK_TIMEOUT_MS)) && Number(env.FM_HOOK_SEQ_LOCK_TIMEOUT_MS) > 0
    ? Number(env.FM_HOOK_SEQ_LOCK_TIMEOUT_MS) : DEFAULT_LOCK_TIMEOUT_MS;
  try {
    await mkdir(join(root, 'seq'), { recursive: true });
    const result = await withLock(`${counterPath(root)}.lock`, async () => {
      let current: number;
      try {
        const text = (await readFile(counterPath(root), 'utf8')).trim();
        current = /^\d+$/.test(text) ? Number(text) : Date.now();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        current = 0;
      }
      const next = current + 1;
      await replaceRaw(counterPath(root), `${next}\n`);
      return next;
    }, { timeoutMs });
    return result.held ? result.value : null;
  } catch { return null; }
}

// Adds what a record lacks. A seq the caller already holds (a record about to be written to
// both its own file and the log) is kept and consumes nothing.
export async function stampRecord(record: Record<string, any>, root: string, hint: Record<string, any> = {}) {
  const env = hint.env ?? process.env;
  const home = record.fmHome !== undefined ? undefined
    : resolveFmHome(env, hint.cwd ?? record.cwd ?? null, hint.rawCommand ?? record.rawCommand);
  return {
    ...record,
    schemaVersion: record.schemaVersion ?? SCHEMA_VERSION,
    seq: record.seq !== undefined ? record.seq : await nextSeq(root, env),
    fmHome: record.fmHome !== undefined ? record.fmHome : scrubPath(home),
    machine: record.machine ?? machineName(env),
  };
}
