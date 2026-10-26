import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { replaceJson } from './atomic.ts';
import { DEFAULT_STALE_MS, pidAlive, readHeartbeat, writeHeartbeat } from './heartbeat.ts';
import { CLOSED_BY, storeRunner } from './bead-actions.ts';
import { queueRoot } from './paths.ts';
import { tailStatusOnce } from './status-tail.ts';
import { drainShadowPending } from './jev/pending.ts';

// bead -> Firstmate. The rule actions write beads; this closes the other direction.
//
// Each poll finds `review` beads (and `human`-labelled beads in the other watched
// stores) that were closed since the last poll and relays each one to Firstmate once:
//   - a captain answer (fm-task: and fm-key:, and not a merge close, and no other open
//     review bead still carrying that fm-hold-task:) is delivered as
//     `fm-send.sh <task> --resolve-key <key> <text>`;
//   - a merge close, or a hold whose task still has another open review bead, becomes
//     `fm-inbox.sh note` headed "closed by firstmate (not a captain answer)";
//   - every other closed bead becomes `fm-inbox.sh note`, the sanctioned wake append.
//   - a bead labelled fm-closed-by:fm-hooks was closed by fm-hooks itself and is skipped.
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

// The cursor is replaced atomically, its temporary removed on a failed write and the
// directory swept of dead writers' temporaries (atomic.ts), so a poller killed between
// writing and renaming leaves nothing beside it.
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await replaceJson(path, value);
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

// The text a closure would be relayed as: the last comment fm-hooks did not write, else the close reason.
export function closureAnswer(bead, comments) {
  return [...comments].reverse().map(c => String(c.text ?? '').trim()).find(t => t && !t.startsWith('fm-hooks:'))
    ?? (bead.close_reason ? String(bead.close_reason).trim() : '');
}

// A duplicate or merge close is firstmate (or fm-hooks) retiring a bead, not the captain deciding.
export function isMergeMarker(beadId, answer) {
  const text = String(answer ?? '').trim();
  if (text.startsWith('duplicate of ') || text.startsWith('fm-hooks:')) return true;
  return [...text.matchAll(/review-fmh[A-Za-z0-9]+/g)].some(match => match[0] !== beadId);
}

// `captain: false` means another open review bead still carries this bead's fm-hold-task.
export function describeClosure(store, bead, comments, { captain = true } = {}) {
  const answer = closureAnswer(bead, comments);
  const task = label(bead.labels, 'fm-task:');
  const key = label(bead.labels, 'fm-key:');
  const merge = isMergeMarker(bead.id, answer);
  const resolve = captain && Boolean(task) && Boolean(key) && !merge;
  const firstmateClose = !resolve && ((Boolean(task) && Boolean(key) && merge) || !captain);
  const hash = createHash('sha256').update(`${store}\0${bead.id}\0${bead.closed_at}`).digest('hex').slice(0, 10);
  const head = resolve
    ? `Captain answered hold ${bead.id}`
    : firstmateClose
      ? `Hold bead ${bead.id} closed by firstmate (not a captain answer)`
      : key
        ? `Captain answered hold ${bead.id}`
        : `${store} bead ${bead.id} closed (closer unknown: captain or an agent)`;
  return { task: firstmateClose ? null : task, key: firstmateClose ? null : key,
    requestId: `bead-${bead.id}-${hash}`.replace(/[^A-Za-z0-9_.-]/g, '_'),
    text: `${head} (${clip(bead.title ?? '', 120)}): ${answer ? clip(answer, 1500) : 'closed without a comment'}` };
}

export async function pollOnce({ root = queueRoot(), env = process.env, stores = watchedStores(env), cli = storeCli(env),
  relay = firstmateRelay(env), now = Date.now(), since }: Record<string, any> = {}) {
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
      // fm-hooks closed this one itself after `fm-captain-hold.sh answer` already delivered the
      // answer to Firstmate; relaying the closure would deliver it twice.
      if ((bead.labels ?? []).includes(CLOSED_BY)) continue;
      try {
        const comments = JSON.parse((await cli(store, ['comments', bead.id, '--json'])) || '[]');
        const holdTask = label(bead.labels, 'fm-hold-task:');
        let captain = true;
        if (holdTask) {
          try {
            const rows = JSON.parse((await cli('review', ['list', '--all', '-l', `fm-hold-task:${holdTask}`, '--json', '-n', '0'])) || '[]');
            if (rows.some(row => row.id !== bead.id && row.status !== 'closed')) captain = false;
          } catch (error) {
            // A failed lookup must not become a captain answer. A merge marker is already not one.
            if (!isMergeMarker(bead.id, closureAnswer(bead, comments))) {
              failed.push({ store, id: bead.id, error: `hold-task: ${clip(error.stderr || error.message, 200)}`, closedAt: bead.closed_at });
              continue;
            }
          }
        }
        const closure = describeClosure(store, bead, comments, { captain });
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
  for (const [key, at] of Object.entries(cursor.relayed)) if (now - Date.parse(at as string) > KEEP_RELAYED_MS) delete cursor.relayed[key];
  await writeJson(cursorPath(root), cursor);
  return { initialized: false, since: cursor.since, relayed, failed };
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export async function watchPoller({ root = queueRoot(), env = process.env, intervalMs, signal, maxCycles = Infinity,
  onResult = r => console.log(JSON.stringify(r)), ...options }: Record<string, any> = {}) {
  const pollMs = Number.isFinite(intervalMs) ? intervalMs : Number(env.FM_HOOK_POLL_INTERVAL_MS) || DEFAULT_POLL_MS;
  const startedAt = new Date().toISOString();
  const state = { startedAt, cycles: 0, relayed: 0, failed: 0, statusLines: 0, lastPollAt: null, lastError: null };
  const tailing = env.FM_HOOK_STATUS_TAIL !== '0';
  while (!signal?.aborted) {
    try {
      const result = await pollOnce({ root, env, ...options });
      state.relayed += result.relayed.length; state.failed += result.failed.length;
      state.lastError = result.failed.length ? `${result.failed[0].store}: ${result.failed[0].error}` : null;
      if (result.relayed.length || result.failed.length) onResult({ type: 'poll', ...result });
    } catch (error) { state.lastError = String(error); }
    if (tailing) {
      try {
        const tail = await tailStatusOnce({ root, env, run: storeRunner(env) });
        state.statusLines += tail.recorded?.filter(r => r.wrote).length ?? 0;
        if (tail.failed?.length) state.lastError = `status-tail ${tail.failed[0].task}: ${tail.failed[0].error}`;
      } catch (error) { state.lastError = `status-tail: ${String(error)}`; }
    }
    // Shadow observations the hook queued (JEV_SHADOW only): labelled here, logged only.
    await drainShadowPending({ root, env, ask: options.shadowAsk }).catch(() => {});
    state.cycles += 1; state.lastPollAt = new Date().toISOString();
    await writeHeartbeat(root, { ...state, intervalMs: pollMs }, 'poller').catch(() => {});
    if (state.cycles >= maxCycles || signal?.aborted) break;
    await sleep(pollMs);
  }
  return state;
}

export async function pollerStatus({ root = queueRoot(), now = Date.now(), staleAfterMs }: Record<string, any> = {}) {
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
