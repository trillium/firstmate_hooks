// Shadow destination pack for one inbox bead.
// Layers 0-2 decide in code and the only output is an audit line.
// Contract: src/jev/README.md section "Inbox route".

import { readFile } from 'node:fs/promises';
import type { Answer, Question } from './ask.ts';
import { appendEvalLines, evalLogPath } from './eval-log.ts';
import { stripIds, UNDECIDED, type Pack, type Verdict } from './questions/v1.ts';

export const INBOX_ROUTE_MIN_CONFIDENCE = 0.6;
export const INBOX_ROUTE_MAX_CHARS = 600;
export const DEFAULT_SECOND_MATES = '/Users/trilliumsmith/fm_home/firstmate/data/secondmates.md';

// Standing names that are not mate ids in the registry file.
const ALIASES: Record<string, string> = {
  fixer: 'macbook-ops',
  zephyr: 'mini0-ops',
  mayor: 'primary',
};

const MATE_LOOKALIKE = /^[a-z][a-z0-9]*-ops$/;
const FIXED_CHOICES = ['primary', 'captain-review', 'other'] as const;

export type Mate = { id: string; projects: string[] };

export type InboxBead = {
  id: string;
  title?: string | null;
  labels?: string[] | null;
  description?: string | null;
};

export type InboxDecision = {
  inbox_id: string;
  owner: string;
  layer: 0 | 1 | 2 | 'fallback';
  confidence: number;
  rule_id: string;
  rationale: string;
  delegate: 'none';
  hits?: string[];
  rejected?: string[];
};

type Phrase = { id: string; owner: string; pattern: RegExp };

// Standing sentences that are not in a mate's `projects:` field.
// A phrase whose owner is absent from the registry is dropped from matching and reported as drift.
export const PHRASE_TABLE: readonly Phrase[] = [
  { id: 'portage-forward-frontend', owner: 'mini0-ops', pattern: /\bportage-forward-frontend\b|\bportage forward frontend\b/i },
  { id: 'fleet-status-ops-demo', owner: 'mini0-ops', pattern: /\bfleet-status\b|\bops demo\b/i },
  { id: 'sidecar', owner: 'macbook-ops', pattern: /\bsidecar\b/i },
  { id: 'talon-config', owner: 'macbook-ops', pattern: /\btalon config\b|\bthis mac(?:'s|s)? talon\b/i },
  { id: 'brain-calendar-service', owner: 'brain-calendar', pattern: /\bbrain-calendar-service\b/i },
];

type L1Rule = { id: string; test: (text: string) => boolean };

// Narrow on purpose. The word "review" alone is not a captain-review decision.
const LAYER1: readonly L1Rule[] = [
  { id: 'l1-captain-words', test: text => /\bstate the claim you want\b/i.test(text) || /\bcaptain's own words\b/i.test(text) || /\byour own words\b/i.test(text) },
  { id: 'l1-unresolved', test: text => /\bconfirm the target\b/i.test(text) || /\bmust not guess\b/i.test(text) || /\bunresolved a\/b\b/i.test(text) || /\bbefore changing anything, identify the exact\b/i.test(text) },
  { id: 'l1-hands-on', test: text => /\baccept(?:ing)? (?:an |the )?invite\b/i.test(text) || /\btype a claim\b/i.test(text) || /\bunlock (?:the |your )?(?:machine|mac|session|keychain)\b/i.test(text) || /\bsign (?:the |this )?(?:release|build|binary|app)\b/i.test(text) },
  { id: 'l1-security-gate', test: text => /\bfor security before integration\b/i.test(text) || /\bdo not integrate before\b/i.test(text) || /\bonly after the security review is complete\b/i.test(text) },
];

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

export function parseSecondmates(markdown: string): Mate[] {
  const mates: Mate[] = [];
  for (const line of markdown.split('\n')) {
    const id = /^- ([a-z0-9-]+) -/i.exec(line);
    if (!id) continue;
    const fields = [...line.matchAll(/projects:\s*([^;)]*)/gi)];
    const raw = fields.length ? fields[fields.length - 1][1] : '';
    const projects = raw.split(',').map(part => part.trim()).filter(Boolean);
    mates.push({ id: id[1], projects });
  }
  return mates;
}

export function inboxRouteChoices(mates: readonly Mate[]): string[] {
  return ['primary', ...mates.map(mate => mate.id), 'captain-review', 'other'];
}

const allowedChoices = (mates: readonly Mate[]) => new Set<string>([...FIXED_CHOICES, ...mates.map(mate => mate.id)]);

// Choice ids that are not primary, captain-review, other, or a mate id in this registry text.
export function choicesMissingFromRegistry(choices: readonly string[], registryText: string): string[] {
  const allowed = allowedChoices(parseSecondmates(registryText));
  return choices.filter(choice => !allowed.has(choice));
}

// Phrase owners that the registry no longer lists. Those phrases must not route.
export function stalePhraseOwners(registryText: string): string[] {
  const ids = new Set(parseSecondmates(registryText).map(mate => mate.id));
  return [...new Set(PHRASE_TABLE.filter(phrase => !ids.has(phrase.owner)).map(phrase => phrase.owner))];
}

function labelList(labels: InboxBead['labels']): string[] {
  return Array.isArray(labels) ? labels.map(label => String(label)) : [];
}

function corpus(bead: InboxBead): string {
  return [bead.title ?? '', ...labelList(bead.labels), bead.description ?? ''].filter(Boolean).join('\n');
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
}

function resolveExplicit(text: string, mateIds: ReadonlySet<string>): { owners: string[]; rejected: string[] } {
  const owners = new Set<string>();
  const rejected: string[] = [];
  for (const token of words(text)) {
    if (mateIds.has(token) || token === 'primary') owners.add(token);
    else if (ALIASES[token]) owners.add(ALIASES[token]);
    else if (MATE_LOOKALIKE.test(token)) rejected.push(token);
  }
  return { owners: [...owners], rejected };
}

// The destination is the first sentence of a leading ROUTE TO line.
// A later "filed by <mate>" on that same line is who wrote the bead, not the owner.
function destinationClause(route: string): string {
  const sentence = route.split(/(?<=\.)\s/)[0] ?? route;
  return sentence.replace(/\bfiled by\b[\s\S]*$/i, '');
}

function leadingRouteTo(bead: InboxBead): string | null {
  for (const source of [bead.description ?? '', bead.title ?? '']) {
    const line = source.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
    const match = /^ROUTE TO:\s*(.*)$/i.exec(line);
    if (match) return destinationClause(match[1]);
  }
  return null;
}

function toLabelValues(labels: string[]): string[] {
  const values: string[] = [];
  for (const label of labels) {
    const match = /^to:(.+)$/i.exec(label.trim());
    if (match) values.push(match[1].trim());
  }
  return values;
}

function base(bead: InboxBead, owner: string, layer: InboxDecision['layer'], confidence: number, ruleId: string, rationale: string, extra: Pick<InboxDecision, 'hits' | 'rejected'> = {}): InboxDecision {
  return {
    inbox_id: bead.id,
    owner,
    layer,
    confidence,
    rule_id: ruleId,
    rationale,
    delegate: 'none',
    ...extra,
  };
}

function layer0(bead: InboxBead, mateIds: ReadonlySet<string>): InboxDecision | null {
  const labels = toLabelValues(labelList(bead.labels));
  const route = leadingRouteTo(bead);
  if (!labels.length && route === null) return null;
  const owners = new Set<string>();
  const rejected: string[] = [];
  for (const value of labels) {
    const resolved = resolveExplicit(value, mateIds);
    for (const owner of resolved.owners) owners.add(owner);
    rejected.push(...resolved.rejected);
  }
  if (route !== null) {
    const resolved = resolveExplicit(route, mateIds);
    for (const owner of resolved.owners) owners.add(owner);
    rejected.push(...resolved.rejected);
    if (!resolved.owners.length && !resolved.rejected.length) rejected.push(route.trim() || '(empty)');
  }
  if (rejected.length) {
    return base(bead, 'captain-review', 0, 1, 'l0-unregistered', 'Explicit destination is not a registered mate, so it is not an executor. Destination is captain-review.', { rejected: [...new Set(rejected)] });
  }
  if (owners.size !== 1) {
    return base(bead, 'captain-review', 0, 1, 'l0-conflict', 'Explicit destinations disagree, so neither is the executor. Destination is captain-review.', { hits: [...owners] });
  }
  const owner = [...owners][0];
  const rule = labels.length ? 'l0-to-label' : 'l0-route-to';
  const how = labels.length ? `to:${labels.join(', to:')}` : 'ROUTE TO';
  return base(bead, owner, 0, 1, rule, `Explicit ${how} names ${owner}.`);
}

function layer1(bead: InboxBead): InboxDecision | null {
  const text = `${bead.title ?? ''}\n${bead.description ?? ''}`;
  const rule = LAYER1.find(candidate => candidate.test(text));
  if (!rule) return null;
  return base(bead, 'captain-review', 1, 0.9, rule.id, `Captain-review pattern ${rule.id}. Destination is captain-review.`);
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:[^a-z0-9-]|$)`, 'i').test(text);
}

type Hit = { owner: string; detail: string };

function layer2(bead: InboxBead, mates: readonly Mate[]): InboxDecision | null {
  const text = corpus(bead);
  const mateIds = new Set(mates.map(mate => mate.id));
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const add = (owner: string, detail: string) => {
    if (!mateIds.has(owner) || seen.has(owner)) return;
    seen.add(owner);
    hits.push({ owner, detail });
  };
  for (const mate of mates) {
    for (const project of mate.projects) {
      if (containsTerm(text, project)) add(mate.id, `project ${project}`);
    }
  }
  for (const phrase of PHRASE_TABLE) {
    if (phrase.pattern.test(text)) add(phrase.owner, `phrase ${phrase.id}`);
  }
  if (!hits.length) return null;
  if (hits.length > 1) {
    const listed = hits.map(hit => `${hit.owner} (${hit.detail})`).join(', ');
    return base(bead, 'primary', 2, 0.8, 'l2-ambiguous', `${listed} both match. Destination is primary.`, { hits: hits.map(hit => hit.owner) });
  }
  const hit = hits[0];
  return base(bead, hit.owner, 2, 0.8, hit.detail.startsWith('project') ? 'l2-project' : 'l2-phrase', `${hit.detail} belongs to ${hit.owner}.`, { hits: [hit.owner] });
}

function fallback(bead: InboxBead): InboxDecision {
  return base(bead, 'primary', 'fallback', 0, 'low-confidence', 'low-confidence');
}

// Pure. No network, no handoff, no registry read. `mates` is the registry for this call.
export function classifyInbox(bead: InboxBead, mates: readonly Mate[]): InboxDecision {
  const mateIds = new Set(mates.map(mate => mate.id));
  return layer0(bead, mateIds) ?? layer1(bead) ?? layer2(bead, mates) ?? fallback(bead);
}

export function prefilterInboxRoute(raw: unknown): string {
  const record = raw && typeof raw === 'object' ? raw as { title?: unknown; labels?: unknown; description?: unknown; body?: unknown } : null;
  const labels = record && Array.isArray(record.labels) ? record.labels : [];
  const text = record ? [record.title, ...labels, record.description ?? record.body].filter(Boolean).join('\n') : String(raw ?? '');
  const clean = squash(stripIds(text));
  return clean.length <= INBOX_ROUTE_MAX_CHARS ? clean : `${clean.slice(0, INBOX_ROUTE_MAX_CHARS - 1).trimEnd()}…`;
}

function decodeOwner(answer: Answer | undefined, known: readonly string[]): Verdict<string> {
  if (!answer) return { verdict: UNDECIDED, reason: 'unknown-choice', confidence: 0, choice: '' };
  const choice = String(answer.value);
  const confidence = answer.confidence;
  if (choice === 'other') return { verdict: UNDECIDED, reason: 'exit', confidence, choice };
  if (!known.includes(choice)) return { verdict: UNDECIDED, reason: 'unknown-choice', confidence, choice };
  if (confidence < INBOX_ROUTE_MIN_CONFIDENCE) return { verdict: UNDECIDED, reason: 'low-confidence', confidence, choice };
  return { verdict: choice, reason: null, confidence, choice };
}

const OPTION_TEXT: Record<string, string> = {
  primary: 'The primary First Mate. Use this when no registered mate is clearly the owner.',
  'captain-review': 'The captain has to decide. Do not send the work to a mate.',
  other: 'None of these destinations fits. Never a route by itself.',
};

// Layer-3 question shape. Shadow classification does not ask it.
// Choices are rebuilt from the mate list on every call.
export function buildInboxRoutePack(mates: readonly Mate[]): Pack<string> {
  const choices = inboxRouteChoices(mates);
  const known = choices.filter(choice => choice !== 'other');
  const options: Record<string, string> = {};
  for (const id of choices) options[id] = OPTION_TEXT[id] ?? `Registered second mate ${id}.`;
  const question: Question = {
    id: 'inbox-route/owner',
    kind: 'choice',
    instructions: 'This is an inbox bead: title, labels, then description. Which owner should receive it? If none of the registered mates is clearly the owner, choose primary. other is not a route.',
    options,
    threshold: INBOX_ROUTE_MIN_CONFIDENCE,
  };
  return {
    id: 'inbox-route',
    prefilter: prefilterInboxRoute,
    questions: [question],
    decode: ([answer]) => decodeOwner(answer, known),
  };
}

// A model `other` or a confidence under the floor becomes primary. The choice `other` is never the owner.
// Shadow classification does not call this. It is the floor rule for a later model answer.
export function ownerFromPackVerdict(bead: InboxBead, verdict: Verdict<string>): InboxDecision {
  if (verdict.verdict === UNDECIDED) {
    const why = verdict.reason === 'low-confidence' ? 'low-confidence' : `low-confidence: ${verdict.reason ?? 'undecided'} is not a route`;
    return base(bead, 'primary', 'fallback', verdict.confidence, 'low-confidence', why);
  }
  return base(bead, verdict.verdict, 'fallback', verdict.confidence, 'pack', `Pack choice ${verdict.verdict}.`);
}

export type ShadowOptions = {
  registry?: readonly Mate[];
  registryText?: string;
  registryPath?: string;
  logPath?: string;
  now?: Date;
};

async function registryFrom(options: ShadowOptions): Promise<Mate[]> {
  if (options.registry) return [...options.registry];
  if (options.registryText !== undefined) return parseSecondmates(options.registryText);
  return parseSecondmates(await readFile(options.registryPath ?? DEFAULT_SECOND_MATES, 'utf8'));
}

// Classify and append one audit line. Does not hand off, even when INBOX_ROUTE_ACT is set.
export async function shadowInboxRoute(bead: InboxBead, options: ShadowOptions = {}): Promise<InboxDecision> {
  const decision = classifyInbox(bead, await registryFrom(options));
  const line: Record<string, unknown> = {
    kind: 'inbox-route',
    timestamp: (options.now ?? new Date()).toISOString(),
    inbox_id: decision.inbox_id,
    owner: decision.owner,
    layer: decision.layer,
    confidence: decision.confidence,
    rule_id: decision.rule_id,
    rationale: decision.rationale,
    delegate: decision.delegate,
  };
  if (decision.hits) line.hits = decision.hits;
  if (decision.rejected) line.rejected = decision.rejected;
  await appendEvalLines([line], options.logPath ?? evalLogPath());
  return decision;
}
