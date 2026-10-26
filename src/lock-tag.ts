import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { resolveFmHome, stateDirOf } from './fm-home.ts';

// Marks the pane that holds the Firstmate session lock (`$FM_HOME/state/.lock`) with the
// herdr token `hs_lock`, so a herdr style rule can make it visually distinct. There is one
// lock, so the tag has one owner: a new acquisition clears the token everywhere and sets it
// on the new holder. Nothing is written while the lock content is unchanged.
export const LOCK_SOURCE = 'fm-lock';
export const LOCK_TOKEN = 'hs_lock';

// The pid in a lock file, or null for anything that is not a lone positive integer.
export function parseLock(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

// The pane whose foreground process group is the lock pid; direct match only.
export function matchPane(pid: number | null, panes: Array<{ id: string; fgPgid: number | null }>): string | null {
  if (pid === null) return null;
  return panes.find(pane => pane.fgPgid === pid)?.id ?? null;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}

export const herdrRunner = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('herdr', args, { timeout: 10000, maxBuffer: 8 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

async function listPanes(run) {
  const listed = JSON.parse(await run(['pane', 'list']));
  const ids: string[] = (listed?.result?.panes ?? []).map(pane => pane.pane_id).filter(Boolean);
  return Promise.all(ids.map(async id => {
    try {
      const info = JSON.parse(await run(['pane', 'process-info', '--pane', id]));
      const group = info?.result?.process_info?.foreground_process_group_id;
      return { id, fgPgid: Number.isInteger(group) ? group : null };
    } catch { return { id, fgPgid: null }; }
  }));
}

const clearArgs = id => ['pane', 'report-metadata', '--source', LOCK_SOURCE, id, '--clear-token', LOCK_TOKEN];
const setArgs = id => ['pane', 'report-metadata', '--source', LOCK_SOURCE, id, '--token', `${LOCK_TOKEN}=LOCK`];

// A stateful applier: `apply()` reads the lock and acts only when its content changed since
// the last apply. herdr failures are logged once and never thrown.
export function createLockTagger({
  env = process.env, run = herdrRunner, isAlive = pidAlive,
  readLock = (path: string) => readFile(path, 'utf8'),
  log = (message: string) => console.error(message),
}: Record<string, any> = {}) {
  let last: string | null | undefined; // undefined = never applied
  let warned = false;
  const warn = error => { if (!warned) { warned = true; log(`fm-hooks lock-tag: herdr unavailable: ${error?.message ?? error}`); } };

  return async function apply(): Promise<{ changed: boolean; holder?: string | null }> {
    const home = resolveFmHome(env);
    if (!home) return { changed: false };
    let content: string | null;
    try { content = await readLock(join(stateDirOf(home), '.lock')); } catch { content = null; }
    if (content === last) return { changed: false };
    last = content;
    const pid = parseLock(content);
    const live = pid !== null && isAlive(pid) ? pid : null;
    try {
      const panes = await listPanes(run);
      for (const pane of panes) await run(clearArgs(pane.id));
      const holder = matchPane(live, panes);
      if (holder) await run(setArgs(holder));
      warned = false;
      return { changed: true, holder };
    } catch (error) {
      warn(error);
      return { changed: true, holder: null };
    }
  };
}
