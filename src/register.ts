import { copyFile, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { replaceRaw } from './atomic.ts';

// Registering fm-hooks with the agent harnesses, as data a machine can be provisioned from.
// Hand-edited ~/.claude/settings.json files were the reason scout capture only ever fired on
// the MacBook: mini0's hook pointed at a stale clone, mini1 had no hook at all, and the Pi
// extension on both minis was a compiled copy from before the TypeScript conversion. This
// writes the one canonical registration, idempotently, so a fleet provisioning step
// (dotfiles' home-manager activation) and a person at a prompt produce the same result.
//
// Every command goes through a stable link (default ~/.local/share/fm-hooks) that points at the
// machine's fm-hooks checkout, so the registered text is the same on every machine and moving
// to a newer checkout changes the link, not the settings.

export const DEFAULT_LINK = (env: Record<string, any> = process.env) => join(env.HOME || homedir(), '.local', 'share', 'fm-hooks');
export const POST_MATCHER = 'Bash|Write|Edit|MultiEdit';
export const FAILURE_MATCHER = 'Bash';
export const BACKUP_SUFFIX = '.pre-fm-hooks-register';

// A command is ours when it runs this repository's Claude hook entry point.
export const isOurs = (command: unknown) => typeof command === 'string' && /claude-hook\.ts(?:\s|$)/.test(command) && /fm[-_]hooks|firstmate_hooks/.test(command);

export const hookCommand = ({ bun, link, env = '' }: { bun: string, link: string, env?: string }) => [env.trim(), bun, `${link}/src/claude-hook.ts`].filter(Boolean).join(' ');

type Group = { matcher?: string, hooks: { type: string, command: string, [key: string]: any }[], [key: string]: any };

// The settings object with fm-hooks registered for PostToolUse and PostToolUseFailure, every
// other hook untouched. An existing fm-hooks entry (whatever checkout it names) is rewritten
// in place; none is added when the right one is already there.
export function withRegistration(settings: Record<string, any>, command: string) {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  next.hooks ??= {};
  const wanted: Record<string, string> = { PostToolUse: POST_MATCHER, PostToolUseFailure: FAILURE_MATCHER };
  const changes: string[] = [];
  for (const [event, matcher] of Object.entries(wanted)) {
    const groups: Group[] = next.hooks[event] ?? [];
    // Take every fm-hooks entry out. The new group goes where the first one that sat alone in
    // its group was (order is kept), else at the end; a group shared with other hooks keeps them.
    let at = -1, removed = 0;
    const kept: Group[] = [];
    for (const group of groups) {
      const others = (group.hooks ?? []).filter(hook => !isOurs(hook.command));
      removed += (group.hooks ?? []).length - others.length;
      if (others.length) kept.push({ ...group, hooks: others });
      else if (at < 0 && (group.hooks ?? []).length) at = kept.length;
    }
    kept.splice(at < 0 ? kept.length : at, 0, { matcher, hooks: [{ type: 'command', command }] });
    const same = JSON.stringify(kept) === JSON.stringify(groups);
    if (!same) changes.push(`${event}: ${removed ? 'rewritten' : 'added'}`);
    next.hooks[event] = kept;
  }
  return { settings: next, changes };
}

export const withoutRegistration = (settings: Record<string, any>) => {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  for (const event of Object.keys(next.hooks ?? {})) {
    next.hooks[event] = (next.hooks[event] as Group[]).map(group => ({ ...group, hooks: (group.hooks ?? []).filter(hook => !isOurs(hook.command)) })).filter(group => group.hooks.length);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  return next;
};

async function readSettings(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${path} is not valid JSON, so it was not touched: ${error.message}`);
  }
}

// The first rewrite of a file keeps the original beside it; a later one never overwrites that.
async function backupOnce(path: string) {
  const backup = `${path}${BACKUP_SUFFIX}`;
  try { await stat(backup); } catch { await copyFile(path, backup); return backup; }
  return null;
}

export async function registerClaude({ settingsPath = join(homedir(), '.claude', 'settings.json'), bun = process.execPath, link = DEFAULT_LINK(), env = '', dryRun = false, remove = false }:
  { settingsPath?: string, bun?: string, link?: string, env?: string, dryRun?: boolean, remove?: boolean } = {}) {
  const current = await readSettings(settingsPath);
  const target = await realpath(settingsPath).catch(() => settingsPath);
  const before = JSON.stringify(current ?? {});
  const { settings, changes } = remove ? { settings: withoutRegistration(current ?? {}), changes: ['removed'] } : withRegistration(current ?? {}, hookCommand({ bun, link, env }));
  const changed = JSON.stringify(settings) !== before;
  let backup: string | null = null;
  if (changed && !dryRun) {
    await mkdir(dirname(target), { recursive: true });
    if (current) backup = await backupOnce(target);
    const mode = await stat(target).then(entry => entry.mode & 0o777, () => 0o600);
    await replaceRaw(target, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  }
  return { settingsPath: target, changed, changes: changed ? changes : [], backup, command: remove ? null : hookCommand({ bun, link, env }) };
}

export const piExtensionSource = (link: string) => `export { default } from '${link}/src/pi-extension.ts';\n`;

export async function registerPi({ extensionsDir = join(homedir(), '.pi', 'agent', 'extensions'), link = DEFAULT_LINK(), dryRun = false }: { extensionsDir?: string, link?: string, dryRun?: boolean } = {}) {
  const path = join(extensionsDir, 'fm-hooks.js');
  const wanted = piExtensionSource(link);
  const current = await readFile(path, 'utf8').catch(() => null);
  const staleCopy = await stat(join(extensionsDir, 'fm-hooks-src')).then(() => join(extensionsDir, 'fm-hooks-src'), () => null);
  const changed = current !== wanted;
  let backup: string | null = null;
  if (changed && !dryRun) {
    await mkdir(extensionsDir, { recursive: true });
    if (current !== null) backup = await backupOnce(path);
    await replaceRaw(path, wanted, { mode: 0o644 });
    // The compiled copy the old extension imported is no longer read; set it aside, never delete it.
    if (staleCopy) await rename(staleCopy, `${staleCopy}${BACKUP_SUFFIX}`).catch(() => {});
  }
  return { path, changed, backup, setAside: changed && !dryRun && staleCopy ? `${staleCopy}${BACKUP_SUFFIX}` : null };
}
