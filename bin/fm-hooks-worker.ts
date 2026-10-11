#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';
import { queueRoot } from '../src/paths.ts';
import { workerStatus } from '../src/worker-status.ts';

// The operator surface for the queue worker. One command answers the question that
// was previously unanswerable -- "is the worker actually running?" -- and the rest
// make it supervised in the first place. `status` is deliberately read-only and
// cheap: it inspects the queue, never a Firstmate process, and never mutates state.

const USAGE = `usage: fm-hooks-worker <command> [options]

  status                 report worker liveness as JSON and exit
  health                 check rules are loaded, actions resolve, and jobs drain; exit 1 if not
  drain                  drain the queue once and exit
  watch                  stay resident, draining on every interval
  supervise              run the resident worker as a child and restart it if it exits
  install                write and load the launchd agent that keeps the supervisor alive
  uninstall              boot out and remove the launchd agent
  plist                  print the launchd plist that install would write

options:
  --queue DIR            queue root (default: the fm-hooks state root)
  --interval MS          poll interval for watch/supervise (default 1000)
  --stale-after MS       age at which a heartbeat counts as stale (default 15000)
  --require-poller       health also fails when the bead poller is not live
  --json                 force JSON output (status and health are always JSON)
`;

export function parseArgv(argv) {
  const options: Record<string, any> = { command: argv[0] ?? 'status' };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--queue') options.root = value();
    else if (arg === '--interval') { options.intervalMs = Number(value()); options.intervalSet = true; }
    else if (arg === '--stale-after') options.staleAfterMs = Number(value());
    else if (arg === '--json') options.json = true;
    else if (arg === '--require-poller') options.requirePoller = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv, { log = console.log, error = console.error }: Record<string, any> = {}): Promise<any> {
  const options = parseArgv(argv);
  if (options.help || !argv.length) { log(USAGE); return 0; }
  const root = options.root ?? queueRoot();

  if (options.command === 'status') {
    const status = await workerStatus({ root, staleAfterMs: options.staleAfterMs });
    log(JSON.stringify(status, null, 2));
    // Non-zero when rule evaluation is not live, so this is usable as a health check
    // and not only as something a human reads.
    return status.ruleEvaluationLive ? 0 : 1;
  }

  if (options.command === 'health') {
    const { healthStatus } = await import('../src/health.ts');
    const health = await healthStatus({ root, staleAfterMs: options.staleAfterMs, requirePoller: options.requirePoller });
    log(JSON.stringify(health, null, 2));
    for (const problem of health.problems) error(`fm-hooks health: ${problem}`);
    return health.healthy ? 0 : 1;
  }

  if (options.command === 'plist') {
    const { renderPlist } = await import('../src/launchd.ts');
    log(renderPlist({ root, intervalMs: options.intervalMs }));
    return 0;
  }

  if (options.command === 'install' || options.command === 'uninstall') {
    const launchd = await import('../src/launchd.ts');
    const result = options.command === 'install'
      ? await launchd.install({ root, intervalMs: options.intervalMs })
      : await launchd.uninstall();
    log(JSON.stringify({ type: options.command, ...result }, null, 2));
    return 0;
  }

  // drain / watch / supervise delegate to the worker entry point so there is exactly
  // one implementation of the loop and one set of flags.
  const { spawn } = await import('node:child_process');
  const { WORKER_ENTRY } = await import('../src/supervise.ts');
  const flag = { drain: '--once', watch: '--watch', supervise: '--supervise' }[options.command];
  if (!flag) { error(`fm-hooks-worker: unknown command "${options.command}"\n\n${USAGE}`); return 2; }
  const args = [WORKER_ENTRY, flag, '--queue', root];
  // As in worker.ts: an absent --interval must stay absent, or it becomes a default
  // that silently outranks FM_HOOK_WORKER_INTERVAL_MS in a launchd-supervised run.
  if (Number.isFinite(options.intervalSet ? options.intervalMs : undefined)) args.push('--interval', String(options.intervalMs));
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => child.kill(name as NodeJS.Signals));
  return new Promise(resolve => child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
