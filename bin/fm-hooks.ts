#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';

const USAGE = `usage: fm-hooks <command> [options]

  deploy                 install the shipped rules file and actions into the live
                         locations (config/README.md "Deploying"), printing the diff of
                         every rules file it replaces

options (deploy):
  --dry-run              print the diff and write nothing
  --services             also (re)install the worker and bead poller launchd agents
  --deploy-dir DIR       override the deploy directory (default: the fm-hooks state root)
  --home-rules FILE      override the second rules-file location
  --no-fetch             do not contact the remote to check whether the clone is behind
`;

export function parseArgv(argv) {
  const options: Record<string, any> = { command: argv[0] };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--services') options.services = true;
    else if (arg === '--deploy-dir') options.deployDir = value();
    else if (arg === '--home-rules') options.homeRules = value();
    else if (arg === '--no-fetch') options.fetch = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv, { log = console.log, error = console.error, env = process.env }: Record<string, any> = {}): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { log(USAGE); return 0; }
  const { command, ...options } = parseArgv(argv);
  if (command !== 'deploy') { error(`fm-hooks: unknown command "${command}"\n\n${USAGE}`); return 2; }
  const { deploy } = await import('../src/deploy.ts');
  try { await deploy({ ...options, env, log }); return 0; }
  catch (failure) { error(`fm-hooks deploy: ${failure.message}`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
