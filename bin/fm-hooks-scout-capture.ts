#!/usr/bin/env bun
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storeRunner } from '../src/bead-actions.ts';
import { queueRoot } from '../src/paths.ts';
import { withLock } from '../src/lock.ts';
import { captureScout, reviewHome } from '../src/scout-capture.ts';
import { homeName, readBundle, reportBeadId, dryRunner } from '../src/scout-report.ts';
import { clearPending, recordPending } from '../src/scout-hook.ts';
import { mkdir } from 'node:fs/promises';

const USAGE = `usage: fm-hooks-scout-capture <command> [options]

  capture --home DIR --task NAME   capture one delivered report now (what the harness hook starts)
  backfill                         capture every report under the firstmate homes once; safe to rerun
  audit                            compare the reports on disk with brain; writes nothing

options:
  --home DIR      a firstmate home (capture: required; backfill/audit: only this home, repeatable)
  --task NAME     a task directory under DIR/data
  --root DIR      where the homes live (backfill/audit; default ~/fm_home)
  --dry-run       show what would be written, write nothing
  --force         capture even when the task's status is not done / needs-decision
  --calls         also file a review bead per captain call (a backfill never does by default)
  --max-writes N  stop a backfill after N reports were written (default: no limit)
  --min-age S     backfill: skip a report touched in the last S seconds (default 120)
  --quiet         print nothing on success
`;

export function parseArgv(argv: string[]) {
  const options: Record<string, any> = { command: argv[0] ?? '', homes: [] };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--home') options.homes.push(value());
    else if (arg === '--task') options.task = value();
    else if (arg === '--root') options.root = value();
    else if (arg === '--max-writes') options.maxWrites = Number(value());
    else if (arg === '--min-age') options.minAge = Number(value());
    else if (['--dry-run', '--force', '--calls', '--quiet', '--help', '-h'].includes(arg)) options[arg.replace(/^-+/, '').replace(/-(\w)/g, (_m, c) => c.toUpperCase())] = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// Every home under the root that has a data/ directory, with the tasks that have a report.
export function discover(root: string, only: string[] = []) {
  const found: { home: string, task: string }[] = [];
  const homes = only.length ? only : readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => join(root, e.name));
  for (const home of homes) {
    let tasks: string[] = [];
    try { tasks = readdirSync(join(home, 'data'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const task of tasks.sort()) {
      try { readFileSync(join(home, 'data', task, 'report.md'), { flag: 'r' }); found.push({ home, task }); } catch { /* no report */ }
    }
  }
  return found;
}

export async function main(argv: string[], { log = console.log, error = console.error, env = process.env }: Record<string, any> = {}) {
  const options = parseArgv(argv);
  if (options.help || !options.command) { log(USAGE); return 0; }
  const root = queueRoot(env);
  const planned: { store: string, args: string[] }[] = [];
  const base = storeRunner(env);
  const run = options.dryRun ? dryRunner(base, planned) : base;
  const say = (value: unknown) => { if (!options.quiet) log(typeof value === 'string' ? value : JSON.stringify(value)); };

  if (options.command === 'capture') {
    const [home] = options.homes;
    if (!home || !options.task) { error('capture needs --home and --task'); return 2; }
    const target = { home, task: options.task };
    await mkdir(join(root, 'scout-capture', 'locks'), { recursive: true });
    const lock = join(root, 'scout-capture', 'locks', `${reportBeadId(home, options.task)}.lock`);
    try {
      // One capture per record at a time: two writers could each add the same part.
      const held = await withLock(lock, () => captureScout({ run, env, home, task: options.task, reviews: options.calls || reviewHome(home, env), requireTerminal: !options.force }),
        { timeoutMs: 120000 });
      if (!held.held) throw new Error('another capture of this report is still running');
      const result = held.value;
      if (!options.dryRun) await clearPending(root, target);
      say({ ...target, ...result, planned: options.dryRun ? planned.length : undefined });
      return 0;
    } catch (failure) {
      const message = String(failure?.stderr?.toString?.() || failure?.message || failure);
      if (!options.dryRun) await recordPending(root, target, message).catch(() => {});
      error(`fm-hooks-scout-capture: ${home} ${options.task}: ${message.slice(0, 300)}`);
      return 1;
    }
  }

  if (options.command === 'backfill' || options.command === 'audit') {
    const rootDir = options.root ?? join(env.HOME || homedir(), 'fm_home');
    const items = discover(rootDir, options.homes).filter(item => !options.task || item.task === options.task);
    const totals: Record<string, number> = {};
    let written = 0, failed = 0;
    for (const item of items) {
      const id = reportBeadId(item.home, item.task);
      try {
        const bundle = await readBundle(item.home, item.task);
        const age = bundle ? (Date.now() - statSync(bundle.reportPath).mtimeMs) / 1000 : 0;
        if (options.command === 'audit' || !bundle || bundle.optedOut || age < (options.minAge ?? 120)) {
          const state = !bundle ? 'no-report' : bundle.optedOut ? 'opted-out' : options.command === 'backfill' ? 'too-new' : 'unchecked';
          if (options.command === 'audit' && bundle && !bundle.optedOut) {
            const result = await captureScout({ run: dryRunner(base), env, home: item.home, task: item.task, reviews: false });
            const action = (result as any).action;
            const word = action === 'unchanged' ? 'captured' : action === 'created' ? 'missing' : 'stale';
            totals[word] = (totals[word] ?? 0) + 1;
            if (word !== 'captured') say({ home: homeName(item.home), task: item.task, id, state: word });
          } else totals[state] = (totals[state] ?? 0) + 1;
          continue;
        }
        const result: any = await captureScout({ run, env, home: item.home, task: item.task, reviews: !!options.calls });
        const action = result.skipped ? 'skipped' : result.action;
        totals[action] = (totals[action] ?? 0) + 1;
        if (action !== 'unchanged') say({ home: homeName(item.home), task: item.task, id, action, parts: result.parts });
        if (action === 'created' || action === 'updated' || action === 'completed') written++;
        if (options.maxWrites && written >= options.maxWrites) { totals.stoppedAtMaxWrites = 1; break; }
      } catch (failure) {
        failed++;
        error(`fm-hooks-scout-capture: ${item.home} ${item.task}: ${String(failure?.stderr?.toString?.() || failure?.message).slice(0, 200)}`);
      }
    }
    log(JSON.stringify({ command: options.command, dryRun: !!options.dryRun, reports: items.length, ...totals, failed }));
    return failed ? 1 : 0;
  }

  error(`fm-hooks-scout-capture: unknown command "${options.command}"\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
