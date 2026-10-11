#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { storeRunner } from '../src/bead-actions.ts';
import { mergeDuplicateProjects } from '../src/project-beads.ts';

// One-time migration: fold `project-fmh-*` duplicates into the real project bead.
//   fm-hooks-project-merge            dry run, prints the plan
//   fm-hooks-project-merge --apply    writes (copies comments, closes the duplicate)

export async function main(argv, { log = console.log, error = console.error, env = process.env, run = storeRunner(env) }: Record<string, any> = {}) {
  const unknown = argv.filter(arg => arg !== '--apply');
  if (unknown.length) { error('usage: fm-hooks-project-merge [--apply]'); return 2; }
  try {
    const apply = argv.includes('--apply');
    for (const line of await mergeDuplicateProjects(run, { apply, env })) log(JSON.stringify({ apply, ...line }));
    return 0;
  } catch (failure) {
    error(`fm-hooks-project-merge: ${failure.stderr?.toString().trim() || failure.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
