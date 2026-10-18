import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deploy drift: the running install silently falling behind the repository. The live
// rules file and the live code were both found a week stale once, and nothing noticed,
// because every other check asks whether the pipeline is running, not whether it is
// running the current version of itself.

export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHIPPED_RULES = join(CHECKOUT, 'config', 'fm-hooks.rules.json');

const canonical = text => JSON.stringify(JSON.parse(text));

// First existing candidate wins, as the observer reads them.
async function firstExisting(paths) {
  for (const path of paths) {
    try { return { path, text: await readFile(path, 'utf8') }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

// null when the live rules match the shipped rules (or there is nothing to compare);
// otherwise a one-line description. Only the parsed content is compared, so whitespace
// alone is not drift.
export async function rulesDrift({ rulesPaths, shippedPath = SHIPPED_RULES }: Record<string, any>) {
  if (!shippedPath) return null;
  const shipped = await firstExisting([shippedPath]);
  const live = await firstExisting(rulesPaths);
  if (!shipped || !live) return null;
  try {
    if (canonical(shipped.text) === canonical(live.text)) return null;
  } catch { /* unparsable: report as differing below */ }
  const ids = text => { try { return new Set(JSON.parse(text).rules.map(rule => rule.id)); } catch { return new Set(); } };
  const liveIds = ids(live.text), shippedIds = ids(shipped.text);
  const missing = [...shippedIds].filter(id => !liveIds.has(id));
  const extra = [...liveIds].filter(id => !shippedIds.has(id));
  const detail = [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '']
    .filter(Boolean).join('; ') || 'same rule ids, different content';
  return `live rules ${live.path} differ from ${shippedPath} (${detail}): run \`fm-hooks deploy\``;
}

function git(repo, args, timeoutMs = 15000) {
  const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: timeoutMs });
  return run.status === 0 ? run.stdout.trim() : null;
}

// How many commits the deploy clone's HEAD is behind its upstream. null when it cannot
// be known: not a git checkout, no upstream (a detached HEAD), or no remote ref. With
// `fetch` the remote is asked first; a failed fetch (offline) falls back to the last
// fetched upstream rather than hiding the answer.
export function commitsBehind({ repo = CHECKOUT, fetch = false }: Record<string, any> = {}) {
  if (git(repo, ['rev-parse', '--git-dir']) === null) return null;
  if (fetch) git(repo, ['fetch', '--quiet'], 20000);
  const upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream) return null;
  const count = git(repo, ['rev-list', '--count', `HEAD..${upstream}`]);
  return count === null ? null : { upstream, behind: Number(count) };
}

export function cloneDrift({ repo = CHECKOUT, fetch = false }: Record<string, any> = {}) {
  const state = commitsBehind({ repo, fetch });
  if (!state || !state.behind) return null;
  return `deploy clone ${repo} is ${state.behind} commit(s) behind ${state.upstream}: git pull --ff-only, then \`fm-hooks deploy\``;
}
