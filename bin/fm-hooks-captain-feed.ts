#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { audit, cliRunner, sync, withHome } from '../src/captain-feed.ts';

// fm-hooks-captain-feed sync  [--dry-run] [--max-writes N]   upsert the status feed from every captain-needed source
// fm-hooks-captain-feed audit [--json]                       list drift; exit 1 when any source lacks a feed bead
//                                                            or any feed bead's source has closed
const USAGE = 'usage: fm-hooks-captain-feed sync [--dry-run] [--max-writes N] | audit [--json]';

const line = (item: { key: string; title: string; priority?: number }) => `  ${item.key}  ${item.title}`;

export async function main(argv: string[], { log = console.log, error = console.error, env = withHome(process.env), run = cliRunner(env) }: Record<string, any> = {}) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const maxIndex = rest.indexOf('--max-writes');
  const maxWrites = maxIndex >= 0 ? Number(rest[maxIndex + 1]) : Infinity;
  if (!['sync', 'audit'].includes(command) || !(maxWrites > 0)) { error(USAGE); return 2; }
  if (!env.FM_HOME) { error('fm-hooks-captain-feed: FM_HOME is not set'); return 2; }
  try {
    if (command === 'sync') {
      const result = await sync({ run, env, maxWrites, dryRun: flags.has('--dry-run') });
      log(JSON.stringify(result));
      return result.failed.length ? 1 : 0;
    }
    const result = await audit({ run, env });
    if (flags.has('--json')) log(JSON.stringify(result, null, 2));
    else {
      log(`sources ${result.sources}; drift ${result.drift}`);
      if (result.failed.length) log(`unreadable sources (cannot audit): ${result.failed.join(', ')}`);
      if (result.missing.length) log(`source items with no open feed bead (${result.missing.length}):\n${result.missing.map(line).join('\n')}`);
      if (result.stale.length) log(`feed beads whose source has closed (${result.stale.length}):\n${result.stale.map(f => `  ${f.key}  ${f.id}`).join('\n')}`);
      if (result.outdated.length) log(`feed beads out of date (${result.outdated.length}):\n${result.outdated.map(line).join('\n')}`);
      if (result.duplicates.length) log(`duplicate feed beads (${result.duplicates.length}):\n${result.duplicates.map(f => `  ${f.key}  ${f.id}`).join('\n')}`);
    }
    return result.drift ? 1 : 0;
  } catch (failure) {
    error(`fm-hooks-captain-feed: ${String(failure instanceof Error ? failure.message : failure).slice(0, 200)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
