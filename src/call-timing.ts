import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeOnce } from './atomic.ts';
import { ensureQueue } from './migrate.ts';
import { queueRoot } from './paths.ts';

// Claude's Bash payloads carry no start time, so the only way to know how long a call took
// is to be told when it began. The PreToolUse hook leaves a timestamp keyed by the tool-use
// id; the post hook for that id reads it, derives startedAt and durationMs, and removes it.
//
// The record holds a time and an id and nothing else, never the command. It is written only
// for calls the observer will record, and a record whose post event never came (the session
// was killed mid-call) is swept once it is old. The duration is the time between the two
// hooks, so it includes the hooks' own start-up.

const STALE_MS = 6 * 60 * 60 * 1000;
const safe = (value: unknown) => String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
const directory = (root: string) => join(root, 'pre');

export async function recordCallStart(callId: string | null | undefined, root: string = queueRoot(), now = new Date()) {
  if (!callId) return;
  await ensureQueue(root);
  await mkdir(directory(root), { recursive: true });
  await writeOnce(join(directory(root), `${safe(callId)}.json`), { callId, startedAt: now.toISOString() });
  await sweepCallStarts(root, now.getTime());
}

export async function takeCallStart(callId: string | null | undefined, root: string = queueRoot()) {
  if (!callId) return null;
  const path = join(directory(root), `${safe(callId)}.json`);
  let start;
  try { start = JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  await rm(path, { force: true });
  const startedMs = Date.parse(start?.startedAt);
  return Number.isFinite(startedMs) ? { startedAt: start.startedAt as string, startedMs } : null;
}

export async function sweepCallStarts(root: string = queueRoot(), now = Date.now()) {
  let names: string[];
  try { names = await readdir(directory(root)); } catch { return; }
  for (const name of names) {
    const path = join(directory(root), name);
    const age = await stat(path).then(entry => now - entry.mtimeMs, () => 0);
    if (age > STALE_MS) await rm(path, { force: true });
  }
}

// The two numbers a post event gains from a stored start.
export function timingFrom(start: { startedAt: string; startedMs: number } | null, finishedAt: string) {
  if (!start) return { startedAt: null, durationMs: null };
  return { startedAt: start.startedAt, durationMs: Math.max(0, Date.parse(finishedAt) - start.startedMs) };
}
