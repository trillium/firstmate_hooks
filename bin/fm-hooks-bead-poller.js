#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { queueRoot } from '../src/paths.js';
import { tailStatusOnce } from '../src/status-tail.js';
import { storeRunner } from '../src/bead-actions.js';
import { pollOnce, pollerStatus, watchPoller } from '../src/bead-poller.js';

const USAGE = `usage: fm-hooks-bead-poller <command> [options]

  once                   poll once, relay each newly closed human/review bead, exit
  watch                  stay resident, polling on every interval (also tails crew status files)
  status-tail --once     record new crew status lines on their fleet beads once, exit
  status                 report poller liveness as JSON; exit 1 if it is not polling
  install                write and load the launchd agent that keeps the poller alive
  uninstall              boot out and remove the launchd agent
  plist                  print the launchd plist that install would write

options:
  --queue DIR            queue root (default: the fm-hooks state root); cursor lives under DIR/poller
  --interval MS          poll interval (default 30000)
  --since ISO            on the first run only, relay closures after this time instead of starting at now
`;

export function parseArgv(argv) {
  const options = { command: argv[0] ?? 'status' };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--queue') options.root = value();
    else if (arg === '--interval') options.intervalMs = Number(value());
    else if (arg === '--since') options.since = value();
    else if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv, { log = console.log, error = console.error, env = process.env } = {}) {
  const options = parseArgv(argv);
  if (options.help || !argv.length) { log(USAGE); return 0; }
  const root = options.root ?? queueRoot(env);
  if (options.command === 'once') {
    const result = await pollOnce({ root, env, since: options.since });
    log(JSON.stringify(result, null, 2));
    return result.failed.length ? 1 : 0;
  }
  if (options.command === 'status-tail') {
    if (!options.once) { error('fm-hooks-bead-poller: status-tail runs inside `watch`; pass --once to run a single pass'); return 2; }
    const result = await tailStatusOnce({ root, env, run: storeRunner(env) });
    log(JSON.stringify(result, null, 2));
    return result.failed?.length ? 1 : 0;
  }
  if (options.command === 'status') {
    const status = await pollerStatus({ root });
    log(JSON.stringify(status, null, 2));
    return status.alive ? 0 : 1;
  }
  if (options.command === 'watch') {
    const controller = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort());
    const state = await watchPoller({ root, env, intervalMs: options.intervalMs, signal: controller.signal });
    return state.lastError ? 1 : 0;
  }
  if (['plist', 'install', 'uninstall'].includes(options.command)) {
    const launchd = await import('../src/poller-launchd.js');
    if (options.command === 'plist') { log(launchd.renderPollerPlist({ root, env, intervalMs: options.intervalMs })); return 0; }
    const result = options.command === 'install'
      ? await launchd.installPoller({ root, env, intervalMs: options.intervalMs })
      : await launchd.uninstallPoller(env);
    log(JSON.stringify({ type: options.command, ...result }, null, 2));
    return 0;
  }
  error(`fm-hooks-bead-poller: unknown command "${options.command}"\n\n${USAGE}`);
  return 2;
}

// Resolved through realpath: the deployed action is a symlink on PATH, and import.meta.url is
// the target, so comparing the unresolved argv would silently never run main.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
