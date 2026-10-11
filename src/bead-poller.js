import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_STALE_MS, pidAlive, readHeartbeat, writeHeartbeat } from './heartbeat.js';
import { queueRoot } from './paths.js';

// bead -> Firstmate. The rule actions write beads; this closes the other direction.
//
// Each poll finds `review` beads (and `human`-labelled beads in the other watched
// stores) that were closed since the last poll and relays each one to Firstmate once:
//   - a bead minted from a captain hold carries fm-task:<task> and fm-key:<key>, so its
//     answer is delivered as `fm-send.sh <task> --resolve-key <key> <text>`;
//   - every other closed bead becomes `fm-inbox.sh note`, the sanctioned wake append.
//
// Safety is at-least-once with idempotent delivery. A bead is recorded as relayed only
// after its relay succeeded, and the cursor never advances past a bead whose relay
// failed, so a crash or a failure re-presents the bead on the next poll. A crash
// between the relay and the record repeats the relay; `fm-inbox.sh note --request-id`
// makes that repeat a no-op on Firstmate's side.

export const DEFAULT_POLL_MS = 30000;
// Closures are matched on the store's own timestamps, so allow for clock skew and a
// bead committed just behind the cursor. The relayed set absorbs the overlap.
const MARGIN_MS = 5 * 60 * 1000;
const KEEP_RELAYED_MS = 7 * 24 * 3600 * 1000;
const clip = (value, max) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));

export const pollerDir = root => join(root, 'poller');
const cursorPath = root => join(pollerDir(root), 'cursor.json');

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

export async function readCursor(root) {
  try { return JSON.parse(await readFile(cursorPath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export const watchedStores = (env = process.env) =>
  (env.FM_HOOK_POLL_STORES || 'review,task').split(',').map(s => s.trim()).filter(Boolean);

const run = promisify(execFile);

function storeCli(env) {
  return async (store, args) => {
    const bin = env[`FM_HOOK_${store.toUpperCase()}_BIN`] || store;
    return (await run(bin, args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout;
  };
}

function fmHome(env) { return env.FM_HOME || join(homedir(), 'fm_home', 'firstmate'); }
function fmBin(env, name) { return join(env.FM_HOOK_FM_BIN_DIR || join(fmHome(env), 'bin'), name); }

// Delivery into Firstmate. Both paths go through Firstmate's own scripts, never its
// files. FM_HOME is required by fm-send and is set explicitly so a launchd job, which
// has no firstmate shell, still addresses the right home.
export function firstmateRelay(env = process.env) {
  const childEnv = { ...env, FM_HOME: fmHome(env) };
  const note = (requestId, text) =>
    run(fmBin(env, 'fm-inbox.sh'), ['note', '--request-id', requestId, '--', text], { env: childEnv, encoding: 'utf8' });
  return async ({ task, key, requestId, text }) => {
    if (task && key) {
      try {
        await run(fmBin(env, 'fm-send.sh'), [task, '--resolve-key', key, text], { env: childEnv, encoding: 'utf8' });
        return { via: 'send' };
      } catch (error) {
        // The task may be gone or the key already resolved (a repeated relay after a
        // crash). The answer must still reach Firstmate, so fall back to a note.
        await note(requestId, `${text}\n\n(fm-send --resolve-key ${key} to ${task} failed: ${clip(error.stderr || error.message, 200).trim()})`);
        return { via: 'note-fallback' };
      }
    }
    await note(requestId, text);
    return { via: 'note' };
  };
}

const label = (labels, prefix) => (labels ?? []).find(l => l.startsWith(prefix))?.slice(prefix.length) ?? null;

export function describeClosure(store, bead, comments) {
  const answer = [...comments].reverse().map(c => String(c.text ?? '').trim()).find(t => t && !t.startsWith('fm-hooks:'))
    ?? (bead.close_reason ? String(bead.close_reason).trim() : '');
  const task = label(bead.labels, 'fm-task:');
  const key = label(bead.labels, 'fm-key:');
  const hash = createHash('sha256').update(`${store}\0${bead.id}\0${bead.closed_at}`).digest('hex').slice(0, 10);
  const head = key ? `Captain answered hold ${bead.id}` : `Captain closed ${store} bead ${bead.id}`;
  return { task, key, requestId: `bead-${bead.id}-${hash}`.replace(/[^A-Za-z0-9_.-]/g, '_'),
    text: `${head} (${clip(bead.title ?? '', 120)}): ${answer ? clip(answer, 1500) : 'closed without a comment'}` };
}

export async function pollOnce({ root = queueRoot(), env = process.env, stores = watchedStores(env), cli = storeCli(env),
  relay = firstmateRelay(env), now = Date.now(), since } = {}) {
  const startedAt = new Date(now).toISOString();
  let cursor = await readCursor(root);
  if (!cursor) {
    // First run: never backfill history. Every old closed review bead would otherwise
    // wake Firstmate at once.
    cursor = { since: since ?? startedAt, relayed: {}, ...(since ? {} : { initial: true }) };
    await writeJson(cursorPath(root), cursor);
    if (!since) return { initialized: true, since: cursor.since, relayed: [], failed: [] };
  }
  // The first poll after initialization looks back no further than the initialization
  // itself; the margin would otherwise backfill closures from just before it started.
  const floor = new Date(Date.parse(cursor.since) - (cursor.initial ? 0 : MARGIN_MS)).toISOString();
  const relayed = [], failed = [];
  for (const store of stores) {
    const args = ['list', '--all', '--status', 'closed', '--closed-after', floor, '--json', '-n', '0'];
    // Every review bead is for the captain; elsewhere only the `human` label is.
    if (store !== 'review') args.push('-l', 'human');
    let beads;
    try { beads = JSON.parse((await cli(store, args)) || '[]'); }
    catch (error) { failed.push({ store, error: `list: ${clip(error.stderr || error.message, 200)}`, closedAt: cursor.since }); continue; }
    for (const bead of beads.sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))) {
      const ledgerKey = `${store}:${bead.id}:${bead.closed_at}`;
      if (!bead.closed_at || cursor.relayed[ledgerKey]) continue;
      try {
        const comments = JSON.parse((await cli(store, ['comments', bead.id, '--json'])) || '[]');
        const closure = describeClosure(store, bead, comments);
        const result = await relay(closure);
        cursor.relayed[ledgerKey] = new Date().toISOString();
        // Persist after every relay, so a crash on the next bead cannot re-send this one.
        await writeJson(cursorPath(root), cursor);
        relayed.push({ store, id: bead.id, via: result.via, requestId: closure.requestId });
      } catch (error) {
        failed.push({ store, id: bead.id, error: clip(error.stderr || error.message, 200), closedAt: bead.closed_at });
      }
    }
  }
  const oldestFailure = failed.map(f => Date.parse(f.closedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  delete cursor.initial;
  cursor.since = oldestFailure !== undefined ? new Date(Math.min(oldestFailure, now)).toISOString() : startedAt;
  for (const [key, at] of Object.entries(cursor.relayed)) if (now - Date.parse(at) > KEEP_RELAYED_MS) delete cursor.relayed[key];
  await writeJson(cursorPath(root), cursor);
  return { initialized: false, since: cursor.since, relayed, failed };
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export async function watchPoller({ root = queueRoot(), env = process.env, intervalMs, signal, maxCycles = Infinity,
  onResult = r => console.log(JSON.stringify(r)), ...options } = {}) {
  const pollMs = Number.isFinite(intervalMs) ? intervalMs : Number(env.FM_HOOK_POLL_INTERVAL_MS) || DEFAULT_POLL_MS;
  const startedAt = new Date().toISOString();
  const state = { startedAt, cycles: 0, relayed: 0, failed: 0, lastPollAt: null, lastError: null };
  while (!signal?.aborted) {
    try {
      const result = await pollOnce({ root, env, ...options });
      state.relayed += result.relayed.length; state.failed += result.failed.length;
      state.lastError = result.failed.length ? `${result.failed[0].store}: ${result.failed[0].error}` : null;
      if (result.relayed.length || result.failed.length) onResult({ type: 'poll', ...result });
    } catch (error) { state.lastError = String(error); }
    state.cycles += 1; state.lastPollAt = new Date().toISOString();
    await writeHeartbeat(root, { ...state, intervalMs: pollMs }, 'poller').catch(() => {});
    if (state.cycles >= maxCycles || signal?.aborted) break;
    await sleep(pollMs);
  }
  return state;
}

export async function pollerStatus({ root = queueRoot(), now = Date.now(), staleAfterMs } = {}) {
  const beat = await readHeartbeat(root, 'poller');
  if (!beat) return { present: false, alive: false, reason: 'the poller has never run against this queue' };
  const age = now - Date.parse(beat.updatedAt);
  const limit = staleAfterMs ?? Math.max(DEFAULT_STALE_MS, 3 * (beat.intervalMs || DEFAULT_POLL_MS));
  const running = pidAlive(beat.pid), fresh = age >= 0 && age <= limit;
  const cursor = await readCursor(root).catch(() => null);
  return { present: true, pid: beat.pid, running, heartbeatFresh: fresh, alive: running && fresh, ageMs: age,
    cycles: beat.cycles, relayed: beat.relayed, failed: beat.failed, lastError: beat.lastError ?? null,
    lastPollAt: beat.lastPollAt, since: cursor?.since ?? null,
    reason: running && fresh ? 'running and polling' : !running ? `pid ${beat.pid} is not running`
      : `heartbeat is ${age}ms old, stale after ${limit}ms` };
}
