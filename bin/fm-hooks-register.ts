#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LINK, registerClaude, registerPi } from '../src/register.ts';

const USAGE = `usage: fm-hooks-register <claude|pi|all|remove-claude> [options]

  claude          register the Claude Code hooks in ~/.claude/settings.json
  pi              point the Pi extension at the checkout
  all             both
  remove-claude   take the fm-hooks hooks out of the Claude settings

Idempotent: a second run changes nothing. Every other hook in the settings is left alone; the
first rewrite of a file keeps the original as <file>.pre-fm-hooks-register.

options:
  --link PATH       stable path to the fm-hooks checkout (default ~/.local/share/fm-hooks)
  --bun PATH        bun that runs the hook (default: the bun running this command)
  --env "K=V ..."   environment prefix for the hook command (e.g. JEV_SHADOW=1)
  --settings FILE   Claude settings file (default ~/.claude/settings.json)
  --extensions DIR  Pi extensions directory (default ~/.pi/agent/extensions)
  --dry-run         report what would change, write nothing
`;

export function parseArgv(argv: string[]) {
  const options: Record<string, any> = { command: argv[0] ?? '' };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--link') options.link = value();
    else if (arg === '--bun') options.bun = value();
    else if (arg === '--env') options.env = value();
    else if (arg === '--settings') options.settingsPath = value();
    else if (arg === '--extensions') options.extensionsDir = value();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv: string[], { log = console.log, error = console.error, env = process.env }: Record<string, any> = {}) {
  const options = parseArgv(argv);
  if (options.help || !options.command) { log(USAGE); return 0; }
  const link = options.link ?? DEFAULT_LINK(env);
  const home = env.HOME || homedir();
  const results: Record<string, any> = {};
  try {
    if (['claude', 'all'].includes(options.command)) results.claude = await registerClaude({ settingsPath: options.settingsPath ?? join(home, '.claude', 'settings.json'), bun: options.bun, link, env: options.env, dryRun: options.dryRun });
    if (options.command === 'remove-claude') results.claude = await registerClaude({ settingsPath: options.settingsPath ?? join(home, '.claude', 'settings.json'), remove: true, dryRun: options.dryRun });
    if (['pi', 'all'].includes(options.command)) results.pi = await registerPi({ extensionsDir: options.extensionsDir ?? join(home, '.pi', 'agent', 'extensions'), link, dryRun: options.dryRun });
  } catch (failure) { error(`fm-hooks-register: ${failure.message}`); return 1; }
  if (!Object.keys(results).length) { error(`fm-hooks-register: unknown command "${options.command}"\n\n${USAGE}`); return 2; }
  log(JSON.stringify({ dryRun: !!options.dryRun, link, ...results }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
