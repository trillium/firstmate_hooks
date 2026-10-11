import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which `projects` bead is the timeline of a project a Firstmate call names?
//
// The curated bead (labelled `project:<name>`, titled for the project) always wins; a
// `project-fmh-<slug>` bead is only ever minted when nothing else names the project, so
// every project keeps its history in one place. Resolution order:
//   1. the override map (config project name -> bead id), for names that match nothing
//   2. a bead labelled `project:<candidate>`, case-insensitively
//   3. a bead whose title is exactly a candidate
// Candidates are the name the call used plus the name the registry (data/projects.md)
// knows it by -- the call usually names a clone directory, the registry names the project.

export const MINTED_PREFIX = 'project-fmh-';
export const isMinted = bead => String(bead.id).startsWith(MINTED_PREFIX);

const DEFAULT_CONFIG = fileURLToPath(new URL('../config/fm-hooks.projects.json', import.meta.url));
const lower = value => String(value).toLowerCase();

// `{ "overrides": { "<project name>": "<bead id>" } }`. Absent file means no overrides; a
// malformed one is an error rather than a silent fall-through to minting.
export async function loadOverrides(env = process.env) {
  const path = env.FM_HOOK_PROJECT_CONFIG || DEFAULT_CONFIG;
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const overrides = JSON.parse(text).overrides ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error(`${path}: "overrides" must map project name to bead id`);
  return Object.fromEntries(Object.entries(overrides).map(([name, id]) => [lower(name), String(id)]));
}

// Registry lines look like `- <name> [<flags>] - <description> ... clone at <path> ...`.
export async function loadRegistry(env = process.env) {
  const path = env.FM_HOOK_PROJECT_REGISTRY || join(env.FM_HOME || join(homedir(), 'fm_home', 'firstmate'), 'data', 'projects.md');
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of text.split('\n')) {
    const found = /^- (\S+)/.exec(line);
    if (!found) continue;
    const clones = [...line.matchAll(/clone at (\S+)/g)].map(m => lower(basename(m[1].replace(/[;,.)]+$/, '').replace(/\/+$/, ''))));
    entries.push({ name: found[1], clones });
  }
  return entries;
}

export function candidateNames(name, registry) {
  const key = lower(name);
  const entry = registry.find(e => lower(e.name) === key) ?? registry.find(e => e.clones.includes(key));
  return [...new Set([name, entry?.name].filter(Boolean))];
}

const listJson = (run, args) => JSON.parse(run('projects', ['list', '--all', '--json', ...args]) || '[]');

// Order: curated before minted, then an exact title, then an open bead, then bd's order.
function best(beads, names) {
  const rank = bead => (isMinted(bead) ? 4 : 0) + (names.includes(bead.title) ? 0 : 2) + (bead.status === 'closed' ? 1 : 0);
  return [...beads].sort((a, b) => rank(a) - rank(b))[0];
}

// Returns the bead id, or null when no bead names the project. `exclude` removes ids
// from consideration (the migration helper excludes the duplicate it is retiring).
export async function resolveProjectBead(run, name, { env = process.env, exclude = [], overrides, registry }: Record<string, any> = {}) {
  const names = candidateNames(name, registry ?? await loadRegistry(env));
  const map = overrides ?? await loadOverrides(env);
  for (const candidate of names) {
    const id = map[lower(candidate)];
    if (id && !exclude.includes(id) && exists(run, id)) return id;
  }
  const found = new Map();
  const wanted = new Set(names.flatMap(n => [`project:${n}`, `project:${lower(n)}`]));
  for (const bead of listJson(run, ['--label-any', [...wanted].join(','), '-n', '0'])) found.set(bead.id, bead);
  // The store matches labels exactly; sweep the rest for a label differing only in case.
  const labelled = bead => (bead.labels ?? []).some(l => names.some(n => lower(l) === `project:${lower(n)}`));
  const all = listJson(run, ['-n', '0']);
  for (const bead of all) if (labelled(bead)) found.set(bead.id, bead);
  const pool = [...found.values()].filter(bead => !exclude.includes(bead.id));
  const labelHit = best(pool, names);
  if (labelHit) return labelHit.id;
  const titled = all.filter(bead => names.includes(bead.title) && !exclude.includes(bead.id));
  return best(titled, names)?.id ?? null;
}

const exists = (run, id) => {
  try { run('projects', ['show', id]); return true; } catch { return false; }
};

const commentText = comment => String(comment.text ?? comment.body ?? '');
const commentsOf = (run, id) => {
  const out = run('projects', ['comments', id, '--json']);
  return (out.trim() ? JSON.parse(out) : []).map(commentText);
};
const cidOf = text => /\[cid:[0-9a-f]+\]/.exec(text)?.[0] ?? null;

// One-time clean-up of `project-fmh-*` beads minted before resolution existed. Dry-run
// unless `apply` is true. For each minted bead that now resolves to a real one, copy the
// comments the real bead lacks (matched by cid marker, else exact text) and close the
// duplicate with a pointer. Safe to repeat: copied comments are found again, and a
// duplicate already closed with its comments present is reported as done.
export async function mergeDuplicateProjects(run, { apply = false, env = process.env }: Record<string, any> = {}) {
  const overrides = await loadOverrides(env);
  const registry = await loadRegistry(env);
  const minted = listJson(run, ['-n', '0']).filter(isMinted);
  const report = [];
  for (const dup of minted) {
    const label = (dup.labels ?? []).find(l => l.startsWith('project:'));
    const name = label ? label.slice('project:'.length) : dup.title;
    const target = await resolveProjectBead(run, name, { env, overrides, registry, exclude: [dup.id] });
    if (!target || target === dup.id || target.startsWith(MINTED_PREFIX)) {
      report.push({ duplicate: dup.id, project: name, action: 'none', reason: 'no real project bead resolves' });
      continue;
    }
    const have = commentsOf(run, target);
    const seen = new Set(have);
    const tags = new Set(have.map(cidOf).filter(Boolean));
    const missing = commentsOf(run, dup.id).filter(text => !seen.has(text) && !(cidOf(text) && tags.has(cidOf(text))));
    const closed = dup.status === 'closed';
    const entry = { duplicate: dup.id, project: name, target, comments: missing.length, close: !closed,
      action: closed && !missing.length ? 'done' : apply ? 'merged' : 'would-merge' };
    if (apply) {
      for (const text of missing) run('projects', ['comments', 'add', target, text]);
      if (!closed) run('projects', ['close', dup.id, '-r', `Duplicate of ${target}; fm-hooks timeline merged there.`]);
    }
    report.push(entry);
  }
  return report;
}
