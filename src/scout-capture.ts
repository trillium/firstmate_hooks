import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createOnce, exists } from './bead-actions.ts';
import { FLEET_STORE, fleetId } from './fleet-beads.ts';
import { machineName } from './origin.ts';
import { homeName, readBundle, reportBeadId, terminalStatus, writeReport } from './scout-report.ts';

// A scout's findings live only in data/<task>/report.md. Two signals say the scout is done,
// and both run the same capture, keyed on the same deterministic bead id, so whichever
// arrives first writes and the other finds the bead already there:
//   - the hook: when the scout appends its `done` status line, the worker's status command is
//     followed by `fm-fleet-ledger.sh appended <config> <state>/<task>.status` (the ledger is
//     opt-in, but the call is in every status command), so that call's raw command carries
//     the status line and the status path;
//   - the status tail (status-tail.ts): the poller reads the `done` line from the status file
//     itself, which is the moment the fleet bead reaches state done. This path does not depend
//     on the hook having observed the command, or on the rule being deployed.
// The report's existence is what separates a scout from a ship task, whose `done` line is
// not captured.
//
// A third trigger, scout-hook.ts, needs neither the ledger call nor a worker: the harness hook
// reads the done line out of the Bash command itself and starts a one-shot capture.
//
// Writes, each safe to repeat (store state is the only memory, see bead-actions.ts):
//   - the report itself, in full, as one `brain` record per home and task (scout-report.ts:
//     digest, ordered uncapped parts, a revision label, an update when the report changes);
//   - a cross-reference comment, once, on `fleet-<task>` and on the backlog task bead;
//   - one `review` bead per captain call the report lists.

type Run = (store: string, args: string[]) => string;
const hex = (value: string, length: number) => createHash('sha256').update(value).digest('hex').slice(0, length);
const clip = (value: string, max: number) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));

// The `[at=...]` stamp is whatever the crew's shell wrote there, not only digits: a crew that
// runs `E=$(date +%s); echo "done [at=$E]: ..."` or inlines `[at=$(date +%s)]` has still
// appended a done line, and the hook sees the command before the shell expanded it
// (robots-fkb70: the talon-phone-grammar-scout-q2 done line was `[at=$E]`).
const DONE_LINE = /echo\s+(["'])done \[at=[^\]]*\]:\s*([\s\S]*?)\1\s*>>\s*(["']?)([^"'\s]+\.status)\3/;
// A heading naming the captain's calls, or a single line that states one.
const CALL_HEADING = /^#{1,6}\s+.*\bcaptain\b.*\b(calls?|decisions?|input|asks?|questions?)\b/i;
const CALL_LINE = /^\W*(captain calls?|needs captain input|captain decides?|captain decision)\W*:?\s*(.+)$/i;

// "None.", "No captain calls", "N/A", "Nothing needed": an answer that there is no call, not one.
const NEGATION = /^(?:none|nothing)\b|^no(?:\s|[.,;:!]|$)|^n\/a\b|^not applicable\b/i;
const isNegation = (text: string) => NEGATION.test(text.replace(/[*_`]/g, '').replace(/^[^\p{L}\p{N}]+/u, ''));

// The id of a task's record in the original home; other homes carry the home in the id (reportBeadId).
export const scoutBeadId = (task: string, home = 'firstmate') => reportBeadId(home, task);

export function scoutDone(event: any) {
  if (event.operation !== 'fm-fleet-ledger.sh' || event.args?.[0] !== 'appended') return null;
  const match = DONE_LINE.exec(event.rawCommand ?? '');
  const path = match?.[4] ?? event.args[2];
  if (!match || !path?.endsWith('.status')) return null;
  return { task: basename(path, '.status'), line: match[2].trim(), statusPath: path };
}

// Items under a "captain calls" heading (one per bullet or numbered item, else the
// paragraph), plus any single-line "Captain call: ..." statement.
export function captainCalls(report: string): string[] {
  const calls: string[] = [];
  let inSection = false, level = 0, paragraph: string[] = [];
  const flush = () => { if (paragraph.length && !isNegation(paragraph[0])) calls.push(paragraph.join(' ')); paragraph = []; };
  for (const raw of report.split('\n')) {
    const heading = /^(#{1,6})\s/.exec(raw);
    if (heading) {
      flush();
      if (CALL_HEADING.test(raw)) { inSection = true; level = heading[1].length; continue; }
      if (inSection && heading[1].length <= level) inSection = false;
    }
    if (inSection) {
      const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(raw);
      if (item) { flush(); paragraph = [item[1].trim()]; } else if (raw.trim() && paragraph.length) { if (!isNegation(raw)) paragraph.push(raw.trim()); }
      else if (raw.trim()) paragraph = [raw.trim()];
      else flush();
      continue;
    }
    const line = CALL_LINE.exec(raw.replace(/\*\*/g, '').trim());
    if (line && line[2] && !isNegation(line[2])) calls.push(line[2].trim());
  }
  flush();
  return [...new Set(calls.map(call => call.replace(/\*\*/g, '').trim()).filter(Boolean))];
}

// `- [ ] <task> - title (inbox-yas4) ...`: the bead the backlog line names, if any.
async function backlogBead(home: string, task: string) {
  try {
    const text = await readFile(join(home, 'data', 'backlog.md'), 'utf8');
    const line = text.split('\n').find(l => l.startsWith('- [') && new RegExp(`^- \\[.\\]\\s+${task.replace(/[^\w-]/g, '\\$&')}\\s`).test(l));
    const id = line && /\(((?:task|inbox|brain|idea|ideas)-[a-z0-9]+)\)/.exec(line)?.[1];
    const repo = line && /\(repo:\s*([A-Za-z0-9._-]+)\)/.exec(line)?.[1];
    return id ? { id, store: id.split('-')[0] === 'idea' ? 'ideas' : id.split('-')[0], repo: repo || null } : null;
  } catch { return null; }
}

// The project a task worked on: the backlog line's `(repo: x)`, else the project directory
// the task's meta file names.
async function projectOf(home: string, task: string, backlog: { repo: string | null } | null) {
  if (backlog?.repo) return backlog.repo;
  try {
    const meta = await readFile(join(home, 'state', `${task}.meta`), 'utf8');
    const path = /^project=(.+)$/m.exec(meta)?.[1];
    return path ? basename(path.trim().replace(/\/+$/, '')) || null : null;
  } catch { return null; }
}

// The capture itself, for a delivered task. `home` is the Firstmate home whose
// data/<task>/report.md is the scout's report. Every write is checked in the store first, so
// the hook, the status tail, the rule action and the backfill can all run it for one task.
//   line            the done line's text (the status file's last line when not given)
//   reviews         file a `review` bead per captain call (a backfill must not)
//   requireTerminal skip unless the task's status is done / needs-decision (or has no status
//                   file): a report being written is not yet delivered
export async function captureScout({ run, env, home, task, line, reviews = true, requireTerminal = false }:
  { run: Run, env: Record<string, string | undefined>, home: string, task: string, line?: string, reviews?: boolean, requireTerminal?: boolean }) {
  const reportPath = join(home, 'data', task, 'report.md');
  const bundle = await readBundle(home, task);
  if (!bundle) return { skipped: `no report at ${reportPath} (not a scout)` };
  if (bundle.optedOut) return { skipped: 'opted out (first line <!-- no-brain -->)' };
  const status = await terminalStatus(home, task);
  if (requireTerminal && !status.terminal) return { skipped: `not delivered yet: status is ${status.state}` };

  const fleet = fleetId(task);
  const fleetStore = FLEET_STORE(env);
  const backlog = await backlogBead(home, task);
  const calls = captainCalls(bundle.text);
  const written = writeReport({ run, home, machine: machineName(env), task, text: bundle.text, reportPath, deliverables: bundle.deliverables,
    line: line ?? status.line, calls: calls.length, project: await projectOf(home, task, backlog) });
  const id = written.id;
  const wrote = written.action === 'created';

  // Cross-references are comments, written once each, found by a per-task marker.
  const tag = `[scout:${task}]`;
  const links: Record<string, string> = {};
  const link = (store: string, target: string) => {
    if (!exists(run, store, target)) return false;
    const seen = JSON.parse(run(store, ['comments', target, '--json']) || '[]')
      .some(c => String(c.text ?? c.body ?? '').includes(tag));
    if (!seen) run(store, ['comments', 'add', target, `fm-hooks: scout ${task} finished; findings captured in ${id} (report: ${reportPath}) ${tag}`]);
    return !seen;
  };
  links.fleet = link(fleetStore, fleet) ? 'linked' : exists(run, fleetStore, fleet) ? 'already' : 'missing';
  if (backlog) links.backlog = link(backlog.store, backlog.id) ? 'linked' : exists(run, backlog.store, backlog.id) ? 'already' : 'missing';

  const filed = (reviews ? calls : []).map(call => {
    const reviewId = `review-fmhscout-${hex(`${task}\0${call}`, 8)}`;
    const created = createOnce(run, 'review', reviewId, {
      title: `Captain call (${task}): ${clip(call, 100)}`, priority: 2,
      labels: ['human', 'fm-hooks', 'fm-scout-call', `fm-task:${task}`],
      body: `${call}\n\nFrom scout ${task}'s report: ${reportPath}\nsummary bead: ${id}` });
    return { id: reviewId, wrote: created };
  });
  return { target: id, wrote, action: written.action, rev: written.rev, parts: written.parts, links, reviews: filed };
}

// The hook path: the rule action for an observed `fm-fleet-ledger.sh appended` call.
export async function scoutReport({ run, event, env }: { run: Run, event: any, env: Record<string, string | undefined> }) {
  const done = scoutDone(event);
  if (!done) return { skipped: 'not a status append' };
  // The status file sits in <home>/state; FM_HOME wins, the status path's own home otherwise.
  const home = env.FM_HOME || dirname(dirname(done.statusPath));
  return captureScout({ run, env, home, task: done.task, line: done.line, reviews: reviewHome(home, env) });
}

// Captain-call review beads are filed for the home the captain reads (the original home) and,
// when FM_HOOK_SCOUT_CALL_HOMES names others (comma-separated, `*` for all), those too. A
// secondmate home's calls go to its own firstmate, so they are not the captain's by default.
export function reviewHome(home: string, env: Record<string, string | undefined> = process.env) {
  const named = String(env.FM_HOOK_SCOUT_CALL_HOMES ?? '').split(',').map(name => name.trim()).filter(Boolean);
  return homeName(home) === 'firstmate' || named.includes('*') || named.includes(homeName(home));
}
