import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// The Firstmate home a call belongs to: FM_HOME when the harness passes it through,
// otherwise the `.../fm_home/<name>` directory a call's working directory sits in, otherwise
// one the command itself names. Anything else belongs to no resolvable home, and null says so
// rather than guess.
// Only ever read from: fm-hooks observes a Firstmate home and never writes inside one.
export function resolveFmHome(env: Record<string, any> = process.env, cwd: string | null = null, command?: string): string | null {
  if (env.FM_HOME) return isAbsolute(env.FM_HOME) ? resolve(env.FM_HOME) : resolve(homedir(), env.FM_HOME);
  const fromCwd = typeof cwd === 'string' ? /^(.*\/fm_home\/[^/]+)(?:\/|$)/.exec(cwd) : null;
  if (fromCwd) return fromCwd[1];
  // A call made from another directory usually still names its home: `H=/…/fm_home/x; $H/bin/…`.
  const fromCommand = typeof command === 'string' ? /(?:^|[\s=:"'(])((?:\/|~\/)(?:[^\s"'$;|&()]*\/)?fm_home\/[A-Za-z0-9._-]+)/.exec(command) : null;
  if (!fromCommand) return null;
  return fromCommand[1].startsWith('~/') ? join(process.env.HOME || homedir(), fromCommand[1].slice(2)) : fromCommand[1];
}

export const stateDirOf = (fmHome: string) => join(fmHome, 'state');
