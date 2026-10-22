import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// The Firstmate home a call belongs to: FM_HOME when the harness passes it through,
// otherwise the `.../fm_home/<name>` directory a call's working directory sits in. A call
// made from anywhere else belongs to no resolvable home, and null says so rather than guess.
// Only ever read from: fm-hooks observes a Firstmate home and never writes inside one.
export function resolveFmHome(env: Record<string, any> = process.env, cwd: string | null = null): string | null {
  if (env.FM_HOME) return isAbsolute(env.FM_HOME) ? resolve(env.FM_HOME) : resolve(homedir(), env.FM_HOME);
  const match = typeof cwd === 'string' ? /^(.*\/fm_home\/[^/]+)(?:\/|$)/.exec(cwd) : null;
  return match ? match[1] : null;
}

export const stateDirOf = (fmHome: string) => join(fmHome, 'state');
