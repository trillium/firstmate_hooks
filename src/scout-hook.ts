import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandUnits } from './normalize.ts';
import { queueRoot } from './paths.ts';

// The harness-side trigger for scout capture. A hook adapter (Claude Code, Pi, OpenCode) hands
// every completed Bash call, and every file write, to `scoutHook`. It reads the delivery out of
// the call itself and starts a one-shot capture, so nothing has to be running beside the
// session: no worker, no poller, no rules file, no FM_HOME.
//
// A delivery is one of:
//   - the scout's status command appending a terminal line (`done` or `needs-decision`) to
//     <home>/state/<task>.status, found in the command text whether or not it also calls the
//     fleet ledger (which only some homes configure);
//   - a write to <home>/data/<task>/*.md (the Write/Edit tool, or a Bash redirect, cp or mv)
//     while the task's status is terminal or absent: a report rewritten after delivery.
// The hook only parses text and starts a detached process; it never waits on the store, never
// throws, and a failed capture is parked in <queue>/scout-capture/pending and retried by a
// later hook delivery with backoff.

const TERMINAL_APPEND = /(?:^|["'\s])(done|needs-decision)\s*\[at=/;
const STATUS_TARGET = /(?:>>|\btee\s+(?:-[a-z]+\s+)*)\s*["']?([^"'\s;&|)]+\.status)\b/;
const DATA_MD = /(?:^|["'\s=])((?:~|\/|\$[A-Za-z_{}]+|\.{1,2})?[^\s"'<>|;&]*\/data\/([A-Za-z0-9][A-Za-z0-9._-]*)\/[A-Za-z0-9._-]+\.md)\b/;
const WRITES = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\binstall\b|\bsed\s+-i|\bperl\s+-[a-z]*i)/;
const MAX_ATTEMPTS = 8;

export interface Trigger { home: string, task: string, why: string }

const expand = (path: string, cwd: string | null | undefined, env: Record<string, any>) => {
  let value = path.replace(/^~(?=\/|$)/, env.HOME || homedir()).replace(/\$\{?HOME\}?/g, env.HOME || homedir());
  if (env.FM_HOME) value = value.replace(/\$\{?FM_HOME\}?/g, env.FM_HOME);
  if (value.includes('$')) return null;
  if (isAbsolute(value)) return resolve(value);
  return cwd ? resolve(cwd, value) : null;
};

// Terminal status appends in a Bash command. Units are split outside quotes, so a `;` inside
// the done line's own text does not cut it in two.
export function statusAppends(command: string, cwd: string | null = null, env: Record<string, any> = process.env): Trigger[] {
  const found: Trigger[] = [];
  const units = commandUnits(command);
  for (const [index, unit] of units.entries()) {
    // `echo "done ..." | tee -a state/x.status` is two units: the text, then the writer.
    const piped = units[index - 1]?.op === '|' && /^\s*tee\b/.test(unit.text) ? units[index - 1].text : '';
    if (!TERMINAL_APPEND.test(unit.text) && !TERMINAL_APPEND.test(piped)) continue;
    const target = STATUS_TARGET.exec(unit.text)?.[1];
    const path = target && expand(target, cwd, env);
    if (!path || basename(dirname(path)) !== 'state') continue;
    found.push({ home: dirname(dirname(path)), task: basename(path, '.status'), why: 'status' });
  }
  return found;
}

// A report or deliverable written under <home>/data/<task>/.
export function reportWrites(command: string, cwd: string | null = null, env: Record<string, any> = process.env): Trigger[] {
  const found: Trigger[] = [];
  for (const unit of commandUnits(command)) {
    if (!WRITES.test(unit.text)) continue;
    const match = DATA_MD.exec(unit.text);
    const path = match && expand(match[1], cwd, env);
    if (!path || !match) continue;
    found.push({ home: dirname(dirname(dirname(path))), task: match[2], why: 'report-write' });
  }
  return found;
}

export function fileWrite(filePath: unknown, cwd: string | null = null, env: Record<string, any> = process.env): Trigger | null {
  if (typeof filePath !== 'string') return null;
  const match = /\/data\/([A-Za-z0-9][A-Za-z0-9._-]*)\/[A-Za-z0-9._-]+\.md$/.exec(filePath);
  const path = match && expand(filePath, cwd, env);
  return path && match ? { home: dirname(dirname(dirname(path))), task: match[1], why: 'report-write' } : null;
}

// Is the task's status terminal (or absent), with a report on disk? A report written while
// the task is still working is not delivered; the done line will trigger the capture.
export function deliverable(home: string, task: string): boolean {
  try {
    const status = join(home, 'state', `${task}.status`);
    if (!existsSync(join(home, 'state')) || !existsSync(join(home, 'data', task, 'report.md'))) return false;
    if (!existsSync(status)) return true;
    const last = readFileSync(status, 'utf8').split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
    return /^(done|needs-decision)\b/.test(last);
  } catch { return false; }
}

export const entryPoint = fileURLToPath(new URL('../bin/fm-hooks-scout-capture.ts', import.meta.url));

// Agent sessions and launchd carry a thin PATH; the capture needs `brain` (~/.local/bin).
const withPath = (env: Record<string, any>) => {
  const home = env.HOME || homedir();
  const extra = [dirname(process.execPath), join(home, '.local', 'bin'), join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return { ...env, PATH: [...String(env.PATH ?? '').split(delimiter).filter(Boolean), ...extra].filter((p, i, all) => all.indexOf(p) === i).join(delimiter) };
};

type Spawn = typeof nodeSpawn;

// Starts the capture detached from the hook process and does not wait for it.
export function launchCapture(trigger: Pick<Trigger, 'home' | 'task'>, { env = process.env, spawn = nodeSpawn }: { env?: Record<string, any>, spawn?: Spawn } = {}) {
  if (env.FM_HOOK_SCOUT_CAPTURE === '0') return false;
  try {
    const child = spawn(process.execPath, [entryPoint, 'capture', '--home', trigger.home, '--task', trigger.task, '--quiet'],
      { detached: true, stdio: 'ignore', env: withPath(env) });
    child.on?.('error', () => { /* a failed start is the pending record's job */ });
    child.unref();
    return true;
  } catch { return false; }
}

const pendingDir = (root: string) => join(root, 'scout-capture', 'pending');
const pendingKey = (home: string, task: string) => `${home.replace(/[^A-Za-z0-9._-]+/g, '_')}__${task}.json`;

export async function recordPending(root: string, { home, task }: { home: string, task: string }, error: string, now = Date.now()) {
  await mkdir(pendingDir(root), { recursive: true });
  const path = join(pendingDir(root), pendingKey(home, task));
  let attempts = 0;
  try { attempts = JSON.parse(await readFile(path, 'utf8')).attempts ?? 0; } catch { /* first failure */ }
  await writeFile(path, JSON.stringify({ home, task, attempts: attempts + 1, lastAttemptAt: now, error: String(error).slice(0, 300) }), { mode: 0o600 });
}

export const clearPending = (root: string, { home, task }: { home: string, task: string }) => rm(join(pendingDir(root), pendingKey(home, task)), { force: true });

// Parked captures whose backoff has passed (1 min, doubling, 8 attempts), started again by
// whichever hook delivery comes next. Synchronous and tiny: it runs on every Bash call.
export function retryPending({ env = process.env, spawn = nodeSpawn, now = Date.now(), root = queueRoot(env) }: { env?: Record<string, any>, spawn?: Spawn, now?: number, root?: string } = {}) {
  const started: string[] = [];
  let names: string[];
  try { names = readdirSync(pendingDir(root)); } catch { return started; }
  for (const name of names) {
    const path = join(pendingDir(root), name);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record.attempts >= MAX_ATTEMPTS) continue;
      if (now - record.lastAttemptAt < 60000 * 2 ** (record.attempts - 1)) continue;
      // Claim the retry before starting it, so concurrent hooks start one capture, not several.
      writeFileSync(path, JSON.stringify({ ...record, lastAttemptAt: now }), { mode: 0o600 });
      if (launchCapture(record, { env, spawn })) started.push(`${record.home}:${record.task}`);
    } catch { try { rmSync(path, { force: true }); } catch { /* unreadable record */ } }
  }
  return started;
}

// The adapter entry point: one completed Bash call or one file write. Never throws.
export function scoutHook({ command, filePath, cwd = null, ok = true, env = process.env, spawn = nodeSpawn, root }:
  { command?: string, filePath?: string, cwd?: string | null, ok?: boolean, env?: Record<string, any>, spawn?: Spawn, root?: string }): Trigger[] {
  const started: Trigger[] = [];
  try {
    if (env.FM_HOOK_SCOUT_CAPTURE === '0') return started;
    retryPending({ env, spawn, root });
    if (!ok) return started;
    const seen = new Map<string, Trigger>();
    const add = (trigger: Trigger | null, needsTerminal: boolean) => {
      if (!trigger) return;
      if (needsTerminal && !deliverable(trigger.home, trigger.task)) return;
      seen.set(`${trigger.home}\0${trigger.task}`, trigger);
    };
    if (typeof command === 'string' && command.length < 200000) {
      for (const trigger of statusAppends(command, cwd, env)) add(trigger, false);
      for (const trigger of reportWrites(command, cwd, env)) add(trigger, true);
    }
    add(fileWrite(filePath, cwd, env), true);
    for (const trigger of seen.values()) if (launchCapture(trigger, { env, spawn })) started.push(trigger);
  } catch { /* observation never fails the call */ }
  return started;
}
