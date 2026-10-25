import { ask, type Answer, type AskOptions, type Question } from '../ask.ts';

// Question pack v1. A pack is one fixed judgment: `prefilter` squeezes the raw record
// down to a compact state string in code, `questions` is a fixed answer set that always
// has an explicit `other`/`none` exit, and `decode` turns the answers into a typed verdict
// that is `undecided` instead of a guess. Question ids are `<pack>/<question>`; they ride
// through the existing eval-log `question_id` field so a later outcome can be joined.

export const UNDECIDED = 'undecided';

export type Verdict<T extends string> = {
  verdict: T | typeof UNDECIDED;
  // Why the pack declined to decide; null when it decided.
  reason: 'exit' | 'low-confidence' | 'unknown-choice' | null;
  confidence: number;
  // What the model picked before decode applied the exit and the confidence floor.
  choice: string;
};

export type Pack<T extends string> = {
  id: string;
  prefilter: (raw: unknown) => string;
  questions: Question[];
  decode: (answers: Answer[]) => Verdict<T>;
};

// ---- stripping shared by every prefilter -------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s)\]>"']+/g;
// Absolute paths: /Users/x/y, ~/x, ./x is left alone (relative).
const PATH_RE = /(?:~|(?<![\w.:/-]))\/(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-]/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/gi;
const ULID_RE = /\b(?=[0-9A-Z]*\d)[0-9A-Z]{26}\b/g;
// Bead / task / run ids: a lowercase prefix, a dash, a short suffix with a digit (task-q1k8, robots-59gm1).
const BEAD_RE = /\b[a-z][a-z_]*-(?=[a-z0-9]*\d)[a-z0-9]{3,}\b/g;
const ISSUE_RE = /(?<![\w/])#\d+\b/g;
const KV_ID_RE = /\b(?:corr|key|id|run|job)=\S+/gi;

export function stripIds(text: string): string {
  return text
    .replace(URL_RE, '<url>')
    .replace(UUID_RE, '<id>')
    .replace(PATH_RE, '<path>')
    .replace(KV_ID_RE, '')
    .replace(ULID_RE, '<id>')
    .replace(HEX_RE, '<id>')
    .replace(BEAD_RE, '<id>')
    .replace(ISSUE_RE, '<id>');
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const asText = (raw: unknown) => (typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''));

// Cap by UTF-8 bytes, cutting on a character boundary.
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = text.slice(0, max);
  while (Buffer.byteLength(out) > max) out = out.slice(0, -1);
  return out;
}

// ---- decode shared by every choice pack --------------------------------------------------

function decodeChoice<T extends string>(answer: Answer | undefined, known: readonly T[], exits: readonly string[], minConfidence: number): Verdict<T> {
  if (!answer) return { verdict: UNDECIDED, reason: 'unknown-choice', confidence: 0, choice: '' };
  const choice = String(answer.value);
  const confidence = answer.confidence;
  if (exits.includes(choice)) return { verdict: UNDECIDED, reason: 'exit', confidence, choice };
  if (!(known as readonly string[]).includes(choice)) return { verdict: UNDECIDED, reason: 'unknown-choice', confidence, choice };
  if (confidence < minConfidence) return { verdict: UNDECIDED, reason: 'low-confidence', confidence, choice };
  return { verdict: choice as T, reason: null, confidence, choice };
}

// ---- 1. worker-status --------------------------------------------------------------------

export const WORKER_STATUS_MIN_CONFIDENCE = 0.6;
export const WORKER_STATUS_STATES = ['done', 'failed', 'blocked', 'needs-decision', 'paused', 'working', 'resolved'] as const;
export const WORKER_STATUS_MAX_LINES = 6;
export const WORKER_STATUS_LINE_CHARS = 240;
export const WORKER_STATUS_MAX_BYTES = 1500;
export type WorkerStatus = 'done' | 'stuck' | 'in-progress';

// A status line is `state [key=..] [at=<epoch>]: text`. Keep the newest few lines whose state
// word is a known one (`resolved` is kept because it is what closes a blocked/needs-decision
// line), drop the epochs, keys and ids, and render `state: text`, oldest first.
export function prefilterWorkerStatus(raw: unknown): string {
  const lines: string[] = [];
  for (const line of asText(raw).split('\n')) {
    const match = /^\s*([a-z-]+)\b[^:]*?:\s*(.*)$/.exec(line);
    if (!match || !(WORKER_STATUS_STATES as readonly string[]).includes(match[1])) continue;
    const text = squash(stripIds(match[2])).slice(0, WORKER_STATUS_LINE_CHARS);
    lines.push(`${match[1]}: ${text}`);
  }
  let kept = lines.slice(-WORKER_STATUS_MAX_LINES);
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n')) > WORKER_STATUS_MAX_BYTES) kept = kept.slice(1);
  return capBytes(kept.join('\n'), WORKER_STATUS_MAX_BYTES) || '(no status lines)';
}

export const workerStatusPack: Pack<WorkerStatus> = {
  id: 'worker-status',
  prefilter: prefilterWorkerStatus,
  questions: [{
    id: 'worker-status/state',
    kind: 'choice',
    instructions: 'These are the most recent status lines a worker agent reported, oldest first, the last line being the newest. What is the worker\'s current state?',
    options: {
      done: 'The newest line says the work is finished and delivered (a done line with nothing after it that reopens the work or reports a problem).',
      stuck: 'The worker cannot proceed without outside help: a blocked, failed or needs-decision line that has not been resolved by a later line.',
      'in-progress': 'The worker is still going or deliberately waiting on something that will clear on its own (working, or paused for a build, test run or CI).',
      other: 'None of these fit, or the lines do not say.',
    },
    threshold: WORKER_STATUS_MIN_CONFIDENCE,
  }],
  decode: ([answer]) => decodeChoice<WorkerStatus>(answer, ['done', 'stuck', 'in-progress'], ['other'], WORKER_STATUS_MIN_CONFIDENCE),
};

// ---- 2. ci-rollup ------------------------------------------------------------------------

export const CI_ROLLUP_MIN_CONFIDENCE = 0.6;
export const CI_ROLLUP_MAX_CHECKS = 40;
export const CI_ROLLUP_MAX_BYTES = 2000;
export type CiResult = 'pass' | 'fail' | 'pending';

const CONCLUSION_ALIASES: Record<string, string> = {
  success: 'pass', successful: 'pass', passed: 'pass', pass: 'pass', completed: 'pass', neutral: 'neutral',
  failure: 'fail', failed: 'fail', fail: 'fail', error: 'fail', timed_out: 'fail', startup_failure: 'fail', action_required: 'fail',
  cancelled: 'cancelled', canceled: 'cancelled', skipped: 'skipped', skipping: 'skipped', stale: 'skipped',
  pending: 'pending', queued: 'pending', waiting: 'pending', requested: 'pending', in_progress: 'pending', 'in progress': 'pending', expected: 'pending',
};
const normalizeConclusion = (value: unknown) => {
  const key = String(value ?? '').trim().toLowerCase();
  return CONCLUSION_ALIASES[key] ?? (key || 'unknown');
};
const SYMBOL_CONCLUSION: Record<string, string> = { '✓': 'pass', '✔': 'pass', X: 'fail', '✗': 'fail', '✖': 'fail', '*': 'pending', '-': 'skipped', '/': 'cancelled' };
const RANK: Record<string, number> = { fail: 0, cancelled: 1, pending: 2, unknown: 3, neutral: 4, skipped: 5, pass: 6 };

function jsonChecks(data: any): Array<[string, string]> | null {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data?.statusCheckRollup) ? data.statusCheckRollup : null;
  if (!rows) return null;
  return rows.filter(row => row && typeof row === 'object').map(row => [
    String(row.name ?? row.context ?? row.workflowName ?? 'check'),
    // gh pr checks --json: bucket/state; gh run view --json jobs and statusCheckRollup: conclusion, falling back to status while running.
    normalizeConclusion(row.bucket || row.conclusion || row.state || row.status),
  ]);
}

function textChecks(text: string): Array<[string, string]> {
  const checks: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes('\t')) {
      // gh pr checks (non-tty): name \t state \t elapsed \t url \t description
      const [name, state] = line.split('\t');
      if (name && state) checks.push([name.trim(), normalizeConclusion(state)]);
      continue;
    }
    // gh run view jobs: `✓ name in 5s (ID 123)` / `X name in 2s` / `* name`
    const symbol = /^\s*(\S)\s+(.+)$/.exec(line);
    if (symbol && symbol[1] in SYMBOL_CONCLUSION) {
      const name = symbol[2].replace(/\s*\(ID \d+\)\s*$/, '').replace(/\s+in \d+(?:[smh]\d*[sm]?)*\s*$/, '').trim();
      if (name) checks.push([name, SYMBOL_CONCLUSION[symbol[1]]]);
    }
  }
  return checks;
}

// One `name: conclusion` line per check (a repeated name keeps its last conclusion), failures
// first so the cap drops passes before it drops anything that matters.
export function prefilterCiRollup(raw: unknown): string {
  let checks: Array<[string, string]> = [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { checks = jsonChecks(JSON.parse(trimmed)) ?? []; } catch { checks = textChecks(raw); }
    } else checks = textChecks(raw);
  } else checks = jsonChecks(raw) ?? [];
  const byName = new Map<string, string>();
  for (const [name, conclusion] of checks) byName.set(squash(stripIds(name)), conclusion);
  const sorted = [...byName].sort((a, b) => (RANK[a[1]] ?? 3) - (RANK[b[1]] ?? 3));
  const lines = sorted.slice(0, CI_ROLLUP_MAX_CHECKS).map(([name, conclusion]) => `${name}: ${conclusion}`);
  if (sorted.length > CI_ROLLUP_MAX_CHECKS) lines.push(`(${sorted.length - CI_ROLLUP_MAX_CHECKS} more checks not shown)`);
  return capBytes(lines.join('\n'), CI_ROLLUP_MAX_BYTES) || '(no checks listed)';
}

export const ciRollupPack: Pack<CiResult> = {
  id: 'ci-rollup',
  prefilter: prefilterCiRollup,
  questions: [{
    id: 'ci-rollup/result',
    kind: 'choice',
    instructions: 'Each line is one CI check as `name: conclusion`, failures first. What is the overall CI result?',
    options: {
      pass: 'Every check that matters has passed; any others are skipped or neutral.',
      fail: 'At least one check failed, errored or timed out.',
      pending: 'No check has failed, but at least one is still queued or running.',
      other: 'No checks are listed, or the list does not say.',
    },
    threshold: CI_ROLLUP_MIN_CONFIDENCE,
  }],
  decode: ([answer]) => decodeChoice<CiResult>(answer, ['pass', 'fail', 'pending'], ['other'], CI_ROLLUP_MIN_CONFIDENCE),
};

// ---- 3. store-route ----------------------------------------------------------------------

export const STORE_ROUTE_MIN_CONFIDENCE = 0.5;
export const STORE_ROUTE_MAX_CHARS = 600;
export const STORE_ROUTE_STORES = ['task', 'brain', 'decisions', 'ideas', 'questions', 'robots', 'friction', 'review', 'inbox', 'status', 'runbooks', 'errors', 'none'] as const;
export type StoreRoute = Exclude<(typeof STORE_ROUTE_STORES)[number], 'none'>;

export const STORE_ROUTE_DESCRIPTIONS: Record<(typeof STORE_ROUTE_STORES)[number], string> = {
  task: 'Actionable work item: a concrete, owned, short-horizon "do this".',
  brain: 'Knowledge: how something works, a pattern, a note, an analysis. Something to know, not to do.',
  decisions: 'The rationale for a choice that has already been made.',
  ideas: 'An enhancement or possibility that is not yet committed work.',
  questions: 'An open question waiting for an answer.',
  robots: 'A defect in agent tooling: a hook misfire, broken verb, misrouted work or false positive.',
  friction: 'Something the user (a person) finds challenging or annoying and wants named and worked through.',
  review: 'A finished artifact that needs the captain\'s judgment: a PR ready to merge, a design to approve, an escalation.',
  inbox: 'Raw capture that is too unformed to classify; triage later.',
  status: 'A dated snapshot of a workstream or system state, worth keeping as a report.',
  runbooks: 'A fixed, repeatable procedure with ordered steps and checkpoints.',
  errors: 'A concrete observed incorrect behavior in tooling or an agent/tool interaction, with diagnosis.',
  none: 'None of these stores fits.',
};

export function prefilterStoreRoute(raw: unknown): string {
  const record = raw && typeof raw === 'object' ? raw as { title?: unknown; body?: unknown } : null;
  const text = record ? [record.title, record.body].filter(Boolean).join('\n') : asText(raw);
  const clean = squash(stripIds(text));
  return clean.length <= STORE_ROUTE_MAX_CHARS ? clean : `${clean.slice(0, STORE_ROUTE_MAX_CHARS - 1).trimEnd()}…`;
}

export const storeRoutePack: Pack<StoreRoute> = {
  id: 'store-route',
  prefilter: prefilterStoreRoute,
  questions: [{
    id: 'store-route/store',
    kind: 'choice',
    instructions: 'This is a captured item: its title, then its body. Which federated store does it belong in? Route by what kind of thing it is, not by convenience.',
    options: { ...STORE_ROUTE_DESCRIPTIONS },
    threshold: STORE_ROUTE_MIN_CONFIDENCE,
  }],
  decode: ([answer]) => decodeChoice<StoreRoute>(answer, STORE_ROUTE_STORES.filter((s): s is StoreRoute => s !== 'none'), ['none'], STORE_ROUTE_MIN_CONFIDENCE),
};

// ---- running a pack ----------------------------------------------------------------------

export const PACKS = { 'worker-status': workerStatusPack, 'ci-rollup': ciRollupPack, 'store-route': storeRoutePack } as const;

// Prefilter in code, ask once, decode. The eval log gets one line per question with the
// `<pack>/<question>` id, and `requestId` is returned so the caller can record the outcome.
export async function askPack<T extends string>(pack: Pack<T>, raw: unknown, options: AskOptions = {}) {
  const state = pack.prefilter(raw);
  const result = await ask(state, pack.questions, options);
  return { ...result, state, ...pack.decode(result.answers) };
}
