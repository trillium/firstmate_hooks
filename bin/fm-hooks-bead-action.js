#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runBeadAction } from '../src/bead-actions.js';

// Rule action: fm-hooks-bead-action <kind> <operation> <correlationId> [ruleId]
// The worker invokes it as a fixed executable with FM_HOOK_QUEUE in the environment.
// Exit 0 means the bead write happened or had already happened; anything else lands the
// job in failed/ for an operator.

export async function main(argv, { log = console.log, error = console.error, env = process.env } = {}) {
  const [kind, operation, correlationId] = argv;
  if (!kind || !operation || !correlationId) {
    error('usage: fm-hooks-bead-action <ledger|project-comment|captain-hold|fleet|scout-report> <operation> <correlationId> [ruleId]');
    return 2;
  }
  try {
    log(JSON.stringify({ kind, operation, ...await runBeadAction({ kind, operation, correlationId, env,
      root: env.FM_HOOK_QUEUE }) }));
    return 0;
  } catch (failure) {
    error(`fm-hooks-bead-action: ${failure.stderr?.toString().trim() || failure.message}`);
    return 1;
  }
}

// Resolved through realpath: the deployed action is a symlink on PATH, and import.meta.url is
// the target, so comparing the unresolved argv would silently never run main.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
