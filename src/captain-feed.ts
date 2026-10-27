import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Captain-action feed: every item that needs the captain's attention, decision, approval,
// review, input or hands becomes one bead in the `status` store, so nothing captain-required
// lives only in a report, a comment, or a review bead.
//
// Sources (all read-only):
//   a) open beads in the `review` store
//   b) open beads labelled `human` in any federated store
//   c) Firstmate captain holds and PRs awaiting the captain's merge, read through
//      `fm-tasks-axi.sh` / `fm-bearings-snapshot.sh --json` (never Firstmate's files)
// Sink: one `status` bead per source item, labelled `captain-action` + `source:<key>`,
// upserted by that key. When the source closes or stops needing the captain, the feed bead
// is closed with a reason. `list` prints the feed through `byRecency`. `audit` reports drift
// in either direction without writing.

export const FEED_LABEL = 'captain-action';
export const SOURCE_PREFIX = 'source:';
export const GROUP_PREFIX = 'src-store:';
export const FEED_STORE = (env: Record<string, any>) => env.FM_HOOK_CAPTAIN_FEED_STORE || 'status';
export const DEFAULT_MAX_WRITES = 25;
const READ_CONCURRENCY = 8;

export type Item = {
  key: string; group: string; title: string; why: string; ask: string; priority: number;
  source: string; evidence: string[]; state: string; holdTask?: string;
};
export type Run = (bin: string, args: string[], extra?: Record<string, string>) => Promise<string> | string;

const exec = promisify(execFile);

// Store CLIs over ssh print mux_client/ControlSocket noise on stderr; only stdout is read and
// stderr is dropped, so the noise never reaches a parser or a log line.
export function cliRunner(env: Record<string, any> = process.env): Run {
  return async (bin, args, extra = {}) => (await exec(bin, args, { env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120000 })).stdout;
}

const clip = (value: unknown, max: number) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const bin = (env: Record<string, any>, name: string) => env[`FM_HOOK_${name.toUpperCase()}_BIN`] || name;
const parseJson = (out: string, what: string) => {
  try { return JSON.parse(out); } catch { throw new Error(`${what}: output was not JSON`); }
};
const asList = (value: any): any[] => (Array.isArray(value) ? value : value ? [value] : []);

export function priorityOf(value: unknown, fallback = 2): number {
  const match = /^P?([0-4])$/i.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : fallback;
}

// URLs and report paths worth linking from the feed bead.
export function evidenceIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) found.add(match[0].replace(/[.,;:]+$/, ''));
  for (const match of text.matchAll(/(?:^|[\s(`"'])((?:\/Users\/[^\s)`"']+|data\/[^\s)`"']+)\.(?:md|html|pdf|png))/g)) found.add(match[1]);
  return [...found].slice(0, 8);
}

const lead = (text: string) => String(text ?? '').split(/\n\s*\n/)[0].trim();

// ---- sources -------------------------------------------------------------------------------

function beadItem(store: string, bead: any): Item {
  const description = String(bead.description ?? '');
  const isReview = store === 'review';
  const ask = lead(description) || String(bead.title ?? bead.id);
  return {
    key: String(bead.id), group: store,
    title: clip(bead.title ?? bead.id, 140),
    why: isReview
      ? `Filed in the review store, the requires-human-eyes queue (${(bead.labels ?? []).includes('human') ? 'labelled human' : 'open'}); it is gated on your judgment.`
      : `Labelled human in the ${store} store: an agent flagged it for your review.`,
    ask: `${clip(ask, 700)}\nRespond: ${store} human respond ${bead.id} "your decision"  (or: ${store} human dismiss ${bead.id})`,
    priority: priorityOf(bead.priority),
    source: `${store}/${bead.id}`,
    evidence: evidenceIn(description),
    state: `open in ${store}${bead.updated_at ? `, updated ${bead.updated_at}` : ''}`,
    holdTask: isReview ? (bead.labels ?? []).find((l: string) => l.startsWith('fm-hold-task:'))?.slice('fm-hold-task:'.length) : undefined,
  };
}

export async function readStores(run: Run, env: Record<string, any>): Promise<string[]> {
  const out = String(await run(bin(env, 'brain'), ['stores', 'list']));
  return [...new Set(out.split('\n').map(line => /^\s*([A-Za-z0-9_-]+)\s+\S/.exec(line)?.[1]).filter(Boolean) as string[])];
}

export async function readBeadSources(run: Run, env: Record<string, any>, failed: Set<string>): Promise<Item[]> {
  const feedStore = FEED_STORE(env);
  const skip = new Set([feedStore, ...(env.FM_HOOK_CAPTAIN_FEED_SKIP || '').split(',').filter(Boolean)]);
  const items = new Map<string, Item>();
  const read = async (store: string, args: string[]) => {
    try {
      for (const bead of asList(parseJson(String(await run(bin(env, store), [...args, '--json']) || '[]'), `${store} list`))) {
        if (bead.status && bead.status !== 'open' && bead.status !== 'in_progress' && bead.status !== 'blocked') continue;
        if (!items.has(String(bead.id))) items.set(String(bead.id), beadItem(store, bead));
      }
    } catch { failed.add(store); }
  };
  await read('review', ['list', '--status', 'open', '--limit', '0']);
  let stores: string[] = [];
  try { stores = await readStores(run, env); } catch { failed.add('brain'); }
  // Each store is its own ssh round trip; read them a few at a time.
  const queue = stores.filter(store => !skip.has(store) && store !== 'review');
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
    for (let store = queue.shift(); store; store = queue.shift()) await read(store, ['list', '--label', 'human', '--status', 'open', '--limit', '0']);
  }));
  return [...items.values()];
}

// Minimal reader for tasks-axi's TOON table: `name[N]{a,b,c}:` then indented CSV rows with
// double-quoted cells (escapes \" \\ \n).
export function parseTable(text: string): Array<Record<string, string>> {
  const lines = text.split('\n');
  const head = lines.findIndex(line => /^\w+\[\d+\]\{[^}]*\}:\s*$/.test(line));
  if (head < 0) return [];
  const columns = /\{([^}]*)\}/.exec(lines[head])![1].split(',');
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(head + 1)) {
    if (!/^ {2}\S/.test(line)) break;
    const cells: string[] = [];
    let cell = ''; let quoted = false;
    const body = line.slice(2);
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quoted) {
        if (c === '\\' && i + 1 < body.length) { const n = body[++i]; cell += n === 'n' ? '\n' : n; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cell); cell = ''; }
      else cell += c;
    }
    cells.push(cell);
    rows.push(Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? ''])));
  }
  return rows;
}

const stripTruncation = (title: string) => title.replace(/\n\.\.\. \(truncated.*$/s, '…');

export async function readFirstmate(run: Run, env: Record<string, any>, reviewHolds: Set<string>): Promise<Item[]> {
  const home = env.FM_HOME;
  if (!home) throw new Error('FM_HOME is not set');
  const binDir = env.FM_HOOK_FM_BIN_DIR || join(home, 'bin');
  const extra = { FM_HOME: home };
  const items: Item[] = [];
  const held = new Set<string>();
  const rows = parseTable(String(await run(join(binDir, 'fm-tasks-axi.sh'), ['list', '--state', 'held', '--limit', '500',
    '--fields', 'hold_kind,hold_reason,priority,links,held'], extra)));
  for (const row of rows) {
    if (row.hold_kind !== 'captain') continue;
    held.add(row.id);
    if (reviewHolds.has(row.id)) continue; // already carried by its review bead (source a)
    const reason = row.hold_reason || row.title;
    items.push({
      key: `fm-hold:${row.id}`, group: 'firstmate', title: clip(`Captain hold: ${row.id} - ${stripTruncation(row.title)}`, 140),
      why: `Firstmate task ${row.id} (${row.repo || 'no repo'}) is held for the captain; it cannot proceed without your word.`,
      ask: clip(reason, 1200),
      priority: priorityOf(row.priority),
      source: `firstmate/${row.id}`,
      evidence: [...evidenceIn(reason), ...evidenceIn(row.links || '').filter(e => !reason.includes(e)), ...(/^(?:pr|report):/.test(row.links) ? [row.links.replace(/^\w+:/, '')] : [])].slice(0, 8),
      state: `${row.state} (held for captain)`,
    });
  }
  const snapshot = parseJson(String(await run(join(binDir, 'fm-bearings-snapshot.sh'), ['--json'], extra)), 'bearings snapshot');
  for (const pr of asList(snapshot?.contributions?.captain)) {
    if (pr.kind !== 'pr' || !pr.url) continue;
    if (held.has(pr.task) || held.has(pr.hold)) continue; // its hold item already carries the PR link
    items.push({
      key: `fm-pr:${pr.task}`, group: 'firstmate', title: clip(`PR awaiting your merge: ${pr.task}`, 140),
      why: 'A Firstmate-owned pull request is ready and the merge call is yours.',
      ask: clip(pr.reason || `Merge or decline ${pr.url}`, 1200),
      priority: 2, source: `firstmate/${pr.task}`, evidence: [pr.url], state: `open PR, checked ${pr.checked_at ?? 'unknown'}`,
    });
  }
  return items;
}

export async function collect(run: Run, env: Record<string, any>) {
  const failed = new Set<string>();
  const beads = await readBeadSources(run, env, failed);
  // A review bead labelled fm-hold-task:<id> already carries that task's hold.
  const holdTasks = new Set(beads.flatMap(item => (item.holdTask ? [item.holdTask] : [])));
  let firstmate: Item[] = [];
  try { firstmate = await readFirstmate(run, env, holdTasks); } catch { failed.add('firstmate'); }
  return { items: [...beads, ...firstmate], failed };
}

// ---- sink ----------------------------------------------------------------------------------

export function renderBody(item: Item): string {
  return [
    `Why you: ${item.why}`,
    `Ask: ${item.ask}`,
    `Priority: P${item.priority}`,
    `Source: ${item.source} (key ${item.key})`,
    `Evidence: ${item.evidence.length ? item.evidence.join(' ; ') : 'none linked in the source'}`,
    `State: ${item.state}`,
    '',
    `Managed by fm-hooks captain-feed. Edits are overwritten; the bead closes itself when ${item.source} closes.`,
  ].join('\n');
}

export type Feed = {
  id: string; status: string; key: string; title: string; body: string; priority: number; group: string;
  updated_at?: string; created_at?: string;
};

const stampOf = (value: unknown) => (value == null ? '' : String(value).trim());

// Store order. plan() keeps the first open bead per key, so this read must stay unsorted.
export async function readFeed(run: Run, env: Record<string, any>): Promise<Feed[]> {
  const out = parseJson(String(await run(bin(env, FEED_STORE(env)), ['list', '--label', FEED_LABEL, '--all', '--limit', '0', '--json']) || '[]'), 'feed list');
  return asList(out).flatMap(bead => {
    const labels: string[] = bead.labels ?? [];
    const key = labels.find(l => l.startsWith(SOURCE_PREFIX))?.slice(SOURCE_PREFIX.length);
    if (!key) return [];
    return [{ id: String(bead.id), status: String(bead.status ?? 'open'), key, title: String(bead.title ?? ''), body: String(bead.description ?? ''),
      priority: priorityOf(bead.priority), group: labels.find(l => l.startsWith(GROUP_PREFIX))?.slice(GROUP_PREFIX.length) ?? '',
      updated_at: stampOf(bead.updated_at), created_at: stampOf(bead.created_at) }];
  });
}

const isOpen = (feed: Feed) => feed.status !== 'closed';

// Activity time for reading: updated_at, else created_at. Blank counts as missing.
export function activityStamp(item: { updated_at?: string | null; created_at?: string | null } | null | undefined): string {
  return stampOf(item?.updated_at) || stampOf(item?.created_at);
}

// Newest activity first. Equal times break by priority ascending, then id.
export function byRecency<T extends { id: string; priority?: number | null; updated_at?: string | null; created_at?: string | null }>(items: readonly T[]): T[] {
  const time = (item: T) => {
    const stamp = activityStamp(item);
    const parsed = Date.parse(stamp);
    return stamp && !Number.isNaN(parsed) ? parsed : null;
  };
  return [...items].sort((a, b) => {
    const left = time(a);
    const right = time(b);
    if (left !== null || right !== null) {
      if (left === null) return 1;
      if (right === null) return -1;
      if (left !== right) return right - left;
    } else {
      const sa = activityStamp(a);
      const sb = activityStamp(b);
      if (sa !== sb) return sa > sb ? -1 : 1;
    }
    const pa = Number(a.priority);
    const pb = Number(b.priority);
    const priority = (Number.isFinite(pa) ? pa : 0) - (Number.isFinite(pb) ? pb : 0);
    if (priority) return priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function listFeed({ run = cliRunner(), env = process.env, all = false }: Record<string, any> = {}): Promise<Feed[]> {
  const feeds = await readFeed(run, env);
  return byRecency(all ? feeds : feeds.filter(isOpen));
}

export const CLOSE_REASON = 'source closed or no longer needs the captain';

export type Plan = { create: Item[]; update: Array<{ feed: Feed; item: Item }>; reopen: Array<{ feed: Feed; item: Item }>; close: Feed[]; dupes: Feed[]; unchanged: number };

export function plan(items: Item[], feeds: Feed[], failed: Set<string>): Plan {
  const byKey = new Map<string, Feed[]>();
  for (const feed of feeds) byKey.set(feed.key, [...(byKey.get(feed.key) ?? []), feed]);
  const result: Plan = { create: [], update: [], reopen: [], close: [], dupes: [], unchanged: 0 };
  const wanted = new Set(items.map(item => item.key));
  for (const item of items) {
    const all = byKey.get(item.key) ?? [];
    const open = all.filter(isOpen);
    const keep = open[0] ?? all[0];
    result.dupes.push(...open.slice(1));
    if (!keep) { result.create.push(item); continue; }
    if (!isOpen(keep)) { result.reopen.push({ feed: keep, item }); continue; }
    if (keep.body !== renderBody(item) || keep.title !== `Captain: ${item.title}` || keep.priority !== item.priority) result.update.push({ feed: keep, item });
    else result.unchanged += 1;
  }
  for (const feed of feeds) {
    // A source group that could not be read says nothing about its items: never close on an outage.
    if (isOpen(feed) && !wanted.has(feed.key) && !failed.has(feed.group)) result.close.push(feed);
  }
  return result;
}

export async function sync({ run = cliRunner(), env = process.env, maxWrites = Infinity, dryRun = false }: Record<string, any> = {}) {
  const store = bin(env, FEED_STORE(env));
  const { items, failed } = await collect(run, env);
  const feeds = await readFeed(run, env);
  const changes = plan(items, feeds, failed);
  const labels = (item: Item) => [FEED_LABEL, `${SOURCE_PREFIX}${item.key}`, `${GROUP_PREFIX}${item.group}`].join(',');
  const done = { created: 0, updated: 0, reopened: 0, closed: 0, deferred: 0 };
  let budget = maxWrites;
  const spend = () => (budget > 0 ? (budget--, true) : (done.deferred++, false));
  const mutate = async (args: string[]) => { if (!dryRun) await run(store, args); };

  for (const { feed } of changes.dupes.map(feed => ({ feed }))) {
    if (spend()) { await mutate(['close', feed.id, '-r', 'duplicate of another open feed bead for the same source']); done.closed++; }
  }
  for (const feed of changes.close) {
    if (spend()) { await mutate(['close', feed.id, '-r', CLOSE_REASON]); done.closed++; }
  }
  for (const { feed, item } of changes.reopen) {
    if (spend()) {
      await mutate(['reopen', feed.id]);
      await mutate(['update', feed.id, '--title', `Captain: ${item.title}`, '-d', renderBody(item), '-p', String(item.priority)]);
      done.reopened++;
    }
  }
  for (const { feed, item } of changes.update) {
    if (spend()) { await mutate(['update', feed.id, '--title', `Captain: ${item.title}`, '-d', renderBody(item), '-p', String(item.priority)]); done.updated++; }
  }
  for (const item of changes.create) {
    if (spend()) { await mutate(['create', `Captain: ${item.title}`, '-d', renderBody(item), '-p', String(item.priority), '-l', labels(item), '--silent']); done.created++; }
  }
  return { sources: items.length, failed: [...failed], unchanged: changes.unchanged, ...done };
}

// ---- audit ---------------------------------------------------------------------------------

export async function audit({ run = cliRunner(), env = process.env }: Record<string, any> = {}) {
  const { items, failed } = await collect(run, env);
  const feeds = await readFeed(run, env);
  const changes = plan(items, feeds, failed);
  const missing = [...changes.create, ...changes.reopen.map(r => r.item)];
  const stale = changes.close;
  const out = changes.update.map(u => u.item);
  return { sources: items.length, failed: [...failed], missing, stale, outdated: out, duplicates: changes.dupes,
    drift: missing.length + stale.length + changes.dupes.length + out.length + failed.size };
}

// Throttled hook for the worker cycle: at most one sync per interval, a bounded number of
// writes each time (a first backfill finishes over several cycles), and never a thrown error.
// The poller's default: a launchd job has no firstmate shell, so FM_HOME falls back to the usual home.
export const withHome = (env: Record<string, any>) => ({ ...env, FM_HOME: env.FM_HOME || join(homedir(), 'fm_home', 'firstmate') });

// Resident-worker hook. Needs an explicit FM_HOME in the worker's environment (the launchd job
// carries it from install time); FM_HOOK_CAPTAIN_FEED=0 turns it off.
export function createFeedSyncer({ env = process.env, run = cliRunner(env), now = () => Date.now(), log = (message: string) => console.error(message) }: Record<string, any> = {}) {
  const everyMs = Number(env.FM_HOOK_CAPTAIN_FEED_MS) || 300000;
  const maxWrites = Number(env.FM_HOOK_CAPTAIN_FEED_MAX_WRITES) || DEFAULT_MAX_WRITES;
  let last = 0;
  return async () => {
    if (env.FM_HOOK_CAPTAIN_FEED === '0' || !env.FM_HOME || now() - last < everyMs) return null;
    last = now();
    try {
      const result = await sync({ run, env, maxWrites });
      // Anything deferred is picked up on the next cycle rather than waiting a full interval.
      if (result.deferred) last = now() - everyMs + 30000;
      return result;
    } catch (error) { log(`captain-feed sync failed: ${String(error).slice(0, 200)}`); return null; }
  };
}
