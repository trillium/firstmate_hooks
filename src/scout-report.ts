import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { redactSecrets } from './scrub.ts';

// The one writer of a delivered report into brain. Every trigger (the harness hook, the
// status tail, the queued rule action, the one-time backfill) ends here, so a report has one
// record whichever of them sees it first and a later change updates that record.
//
// Shape of a record, `brain-fmhscout-<home>-<task>`:
//   - the description is a digest (title, summary, where the report lives, which revision is
//     current), small enough that `bead_show` and a search hit stay readable;
//   - the FULL report, uncapped, is in ordered comments `[scout-report rev=<sha> part i/n]`,
//     each at most PART_CAP characters, cut at a paragraph break;
//   - the label `fm-report-sha:<sha>` says which revision is complete. It is written last, so a
//     capture that died part-way is finished by the next one rather than mistaken for done.
// A changed report adds a new revision's parts and swaps the label and digest. The store has
// no comment delete, so the older revision's comments stay, each tagged with its own rev.

type Run = (store: string, args: string[]) => string;

export const PART_CAP = 50000;
export const DIGEST_CAP = 4000;
export const EXCERPT_CAP = 2200;
export const OPT_OUT = '<!-- no-brain -->';
// The home whose records predate the home in the id; renaming them would orphan 67 records.
export const LEGACY_HOME = 'firstmate';
export const SHA_LABEL = 'fm-report-sha:';
const OPT_OUT_LINE = /^\s*<!--\s*no-brain\s*-->/i;
const TERMINAL = /^(done|needs-decision)\b/;

const hex = (value: string, length: number) => createHash('sha256').update(value).digest('hex').slice(0, length);
const clip = (value: string, max: number) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));
export const slug = (value: string) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const homeName = (home: string) => basename(String(home).replace(/\/+$/, ''));

// Stable per home and task. Two homes can each have a task of the same name (3 of 577 do), so
// the home is part of the id; the original home keeps the id its records already have.
export function reportBeadId(home: string, task: string) {
  const owner = slug(homeName(home));
  return !owner || owner === LEGACY_HOME ? `brain-fmhscout-${slug(task)}` : `brain-fmhscout-${owner}-${slug(task)}`;
}

export const optedOut = (text: string) => OPT_OUT_LINE.test(text.split('\n', 1)[0] ?? '');
export const reportTitle = (report: string) => /^#\s+(.+)$/m.exec(report)?.[1].trim() ?? null;

// Pieces whose concatenation is the text, each at most `cap` characters, cut after a blank
// line when one is near, else after a line, else mid-line. Never inside a surrogate pair.
export function splitParts(text: string, cap = PART_CAP): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    let cut = rest.lastIndexOf('\n\n', cap - 2) + 2;
    if (cut < cap / 2) cut = rest.lastIndexOf('\n', cap - 1) + 1;
    if (cut < cap / 2) cut = cap;
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

// Other markdown deliverables the report names, in the report's own directory (a design
// document written beside report.md): they are part of what the scout delivered.
export function namedDeliverables(report: string, files: string[]) {
  const have = new Set(files);
  const names: string[] = [];
  for (const match of report.matchAll(/(?:^|[\s`(\[*"'/])([A-Za-z0-9][A-Za-z0-9._-]*\.md)\b/g)) {
    const name = match[1];
    if (name !== 'report.md' && have.has(name) && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 8);
}

export interface Bundle { reportPath: string, text: string, deliverables: string[], optedOut?: boolean }

// data/<task>/report.md plus the deliverables it names. null when there is no report.
export async function readBundle(home: string, task: string): Promise<Bundle | null> {
  const dir = join(home, 'data', task);
  const reportPath = join(dir, 'report.md');
  let report: string;
  try { report = await readFile(reportPath, 'utf8'); } catch { return null; }
  if (optedOut(report)) return { reportPath, text: '', deliverables: [], optedOut: true };
  const files = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.md'));
  const deliverables: string[] = [];
  let text = report;
  for (const name of namedDeliverables(report, files)) {
    try {
      const path = join(dir, name);
      if ((await stat(path)).size > 4 * 1024 * 1024) continue;
      const body = await readFile(path, 'utf8');
      if (optedOut(body)) continue;
      text += `\n\n---\n\n# Deliverable: ${name}\n\n${body}`;
      deliverables.push(name);
    } catch { /* a named file that cannot be read is simply not part of the bundle */ }
  }
  return { reportPath, text, deliverables };
}

// The last line of state/<task>.status: terminal when it is `done` or `needs-decision`.
// `exists: false` is a task with no status file (nothing contradicts the report being final).
export async function terminalStatus(home: string, task: string) {
  let text: string;
  try { text = await readFile(join(home, 'state', `${task}.status`), 'utf8'); } catch { return { exists: false, terminal: true, state: null as string | null, line: '' }; }
  const last = text.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
  const state = /^([a-z-]+)\b/.exec(last)?.[1] ?? null;
  const line = last.replace(/^[a-z-]+\s*(?:\[[^\]]*\])*\s*:?\s*/, '');
  return { exists: true, terminal: TERMINAL.test(last), state, line };
}

const normalize = (text: string) => text.replace(/\s+/g, ' ');
// 120 characters from the middle of the text: enough to say a copy of it is already in a record.
export function probe(text: string) {
  const flat = normalize(text).trim();
  if (flat.length < 200) return null;
  const middle = Math.floor(flat.length / 2);
  return flat.slice(middle - 60, middle + 60);
}

export function digest({ title, summary, home, machine, task, path, sha, parts, chars, calls, project, deliverables, text }: Record<string, any>) {
  const head = [
    summary ? clip(summary, 1200) : title ? clip(title, 200) : `Scout report: ${task}`,
    `\nhome: ${homeName(home)} (${machine})`,
    `task: ${task}`,
    project ? `project: ${project}` : '',
    `report: ${path}`,
    deliverables?.length ? `deliverables: ${deliverables.join(', ')}` : '',
    `captain calls: ${calls}`,
    `fm-report-rev: ${sha} (${parts} part${parts === 1 ? '' : 's'}, ${chars} characters)`,
    `\nThe full report is in the comments tagged [scout-report rev=${sha} part i/${parts}], in order. Read every part.`,
  ].filter(Boolean).join('\n');
  const excerpt = clip(String(text).replace(/^#\s+.*\n+/, '').trim(), Math.max(0, Math.min(EXCERPT_CAP, DIGEST_CAP - head.length - 40)));
  return `${head}\n\n---\n${excerpt}`;
}

const rowOf = (out: string) => {
  const parsed = out.trim() ? JSON.parse(out) : null;
  return Array.isArray(parsed) ? parsed[0] ?? null : parsed;
};
function showRow(run: Run, id: string) {
  try { return rowOf(run('brain', ['show', id, '--json'])); } catch { return null; }
}
const commentTexts = (run: Run, id: string): string[] => {
  const out = run('brain', ['comments', id, '--json']);
  return (out.trim() ? JSON.parse(out) : []).map((comment: any) => String(comment.text ?? comment.body ?? ''));
};

export interface WriteResult { id: string, action: 'created' | 'updated' | 'unchanged' | 'adopted' | 'completed', rev: string, parts: number, wrote: boolean }

// Write or bring up to date the record for one delivered report. `text` is the raw bundle;
// it is redacted here, so no caller can forget to. Every store write is preceded by a read of
// the record, which is the only memory: a repeat with the same text writes nothing, a crash
// between steps is finished by the next call.
export function writeReport({ run, home, machine, task, text, reportPath, deliverables = [], line = '', calls = 0, project = null }:
  { run: Run, home: string, machine: string, task: string, text: string, reportPath: string, deliverables?: string[], line?: string, calls?: number, project?: string | null }): WriteResult {
  const clean = redactSecrets(text);
  const rev = hex(clean, 12);
  const id = reportBeadId(home, task);
  const pieces = splitParts(clean);
  const title = reportTitle(clean);
  const beadTitle = `Scout report: ${task}${title ? ` - ${clip(title.replace(/\s*\(.*$/, ''), 80)}` : ''}`;
  const summary = line.replace(/^report written at \S+;?\s*/, '') || line;
  const description = digest({ title, summary: redactSecrets(summary), home, machine, task, path: reportPath, sha: rev, parts: pieces.length,
    chars: clean.length, calls, project, deliverables, text: clean });
  const wanted = ['fm-hooks', 'fm-scout-report', `fm-task:${task}`, `fm-home:${homeName(home)}`, `fm-machine:${machine}`, ...(project ? [`project:${project}`] : [])];

  let row = showRow(run, id);
  let created = false;
  if (!row) {
    try {
      run('brain', ['create', '--id', id, '--silent', '--title', beadTitle, '-t', 'knowledge', '-p', '3', '-l', wanted.join(','), '-d', description]);
      created = true;
    } catch (error) {
      // A concurrent capture can have created it between the read and the create.
      row = showRow(run, id);
      if (!row) throw error;
    }
  }
  const labels: string[] = row?.labels ?? wanted;
  const current = labels.find(label => label.startsWith(SHA_LABEL))?.slice(SHA_LABEL.length) ?? null;
  if (current === rev) return { id, action: 'unchanged', rev, parts: pieces.length, wrote: created };

  const texts = created ? [] : commentTexts(run, id);
  const tag = (index: number) => `[scout-report rev=${rev} part ${index + 1}/${pieces.length}]`;
  const header = (index: number) => `Scout report (${task}, ${homeName(home)}) - full text ${tag(index)}`;
  const missing = wanted.filter(l => !labels.includes(l));
  const finish = (action: WriteResult['action'], rewrite: boolean) => {
    const args = ['update', id];
    if (rewrite) args.push('--title', beadTitle, '-d', description);
    for (const add of [...missing, `${SHA_LABEL}${rev}`]) args.push('--add-label', add);
    if (current) args.push('--remove-label', `${SHA_LABEL}${current}`);
    run('brain', args);
    return { id, action, rev, parts: pieces.length, wrote: true } as WriteResult;
  };

  // A record from before revisions existed (no sha label, no digest of ours): adopt it if its
  // text is already there, so the 67 existing records are labelled, not duplicated.
  if (!created && !current && !String(row?.description ?? '').includes('fm-report-rev:')) {
    const tagged = texts.find(t => t.includes(`[scout-report:${task}]`));
    const legacy = tagged?.slice(tagged.indexOf(']') + 1).replace(/^\s+/, '') ?? null;
    const same = (candidate: string | null) => candidate !== null && (normalize(candidate) === normalize(clean) || normalize(candidate) === normalize(text));
    const copy = probe(clean);
    const present = tagged ? same(legacy)
      : !!copy && [row?.description ?? '', ...texts].some(t => normalize(t).includes(copy));
    if (present) return finish('adopted', false);
  }

  for (let index = 0; index < pieces.length; index++) {
    if (texts.some(t => t.includes(tag(index)))) continue;
    run('brain', ['comments', 'add', id, `${header(index)}\n\n${pieces[index]}`]);
  }
  return finish(created ? 'created' : current ? 'updated' : 'completed', !created);
}

// A runner that reads through and records what a write would have been, for --dry-run.
export function dryRunner(run: Run, planned: { store: string, args: string[] }[] = []): Run {
  return (store, args) => {
    const verb = args[0];
    const write = ['create', 'update', 'close', 'reopen', 'delete'].includes(verb) || (verb === 'comments' && args[1] === 'add') || (verb === 'label' && args[1] === 'add');
    if (!write) return run(store, args);
    planned.push({ store, args });
    return '';
  };
}
