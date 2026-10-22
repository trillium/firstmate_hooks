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
  return typeof command === 'string' ? homeNamedIn(command.slice(0, SCAN_LIMIT)) : null;
}

const SCAN_LIMIT = 20000;
const TOKEN_LIMIT = 4096;
const BOUNDARY = /[\s"'=:($;|&)]/;
const NAME = /^[A-Za-z0-9._-]+/;

// The first absolute (or `~/`) path in a command that runs through `/fm_home/<name>`. A scan
// by position rather than a backtracking pattern: it runs on every Bash call, and a long
// token must cost no more than its length.
function homeNamedIn(command: string): string | null {
  let from = 0;
  for (let found = 0; found < 20; found++) {
    const at = command.indexOf('/fm_home/', from);
    if (at < 0) return null;
    from = at + 1;
    let start = at;
    while (start > 0 && at - start < TOKEN_LIMIT && !BOUNDARY.test(command[start - 1])) start--;
    const prefix = command.slice(start, at);
    const name = NAME.exec(command.slice(at + '/fm_home/'.length))?.[0];
    if (!name) continue;
    if (prefix === '' || prefix.startsWith('/')) return `${prefix}/fm_home/${name}`;
    if (prefix === '~' || prefix.startsWith('~/')) return join(process.env.HOME || homedir(), prefix.slice(2), 'fm_home', name);
  }
  return null;
}

export const stateDirOf = (fmHome: string) => join(fmHome, 'state');
