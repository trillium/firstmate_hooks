import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { queueRoot } from './paths.ts';
import { resolveFmHome } from './fm-home.ts';
import { fleetAction } from './fleet-beads.ts';
import { MINTED_PREFIX, resolveProjectBead } from './project-beads.ts';
import { scoutReport } from './scout-capture.ts';

// Rule actions that write the outcome of a Firstmate call into beads.
//
// Every action is safe to run twice for one (correlationId, rule): delivery from the
// queue is at-least-once across a crash window. Idempotence comes from two things,
// never from remembered local state -- a deterministic bead id for anything that is
// created, and a `[cid:<correlation prefix>]` marker for anything that is commented.
// Both are checked in the store itself before a write.
//
// Stores are reached only through their wrapper CLIs (`projects`, `review`, `lifespan`),
// never bare `bd`, as an argv with no shell. FM_HOOK_<STORE>_BIN overrides a wrapper.

export const KINDS = ['ledger', 'project-comment', 'captain-hold', 'fleet', 'scout-report'];

const hex = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length);
export const clip = (value, max) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const marker = correlationId => `[cid:${correlationId.slice(0, 16)}]`;

export function storeRunner(env = process.env) {
  return (store, args) => {
    const bin = env[`FM_HOOK_${store.toUpperCase()}_BIN`] || store;
    return execFileSync(bin, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  };
}

export const exists = (run, store, id) => {
  try { run(store, ['show', id]); return true; } catch { return false; }
};

export function commentTexts(run, store, id) {
  const out = run(store, ['comments', id, '--json']);
  const parsed = out.trim() ? JSON.parse(out) : [];
  return parsed.map(comment => String(comment.text ?? comment.body ?? ''));
}

// Add a comment once. The marker is part of the text, so a re-delivered job finds its
// own earlier comment and stops.
export function commentOnce(run, store, id, correlationId, text) {
  const tag = marker(correlationId);
  if (commentTexts(run, store, id).some(existing => existing.includes(tag))) return false;
  run(store, ['comments', 'add', id, `${text} ${tag}`]);
  return true;
}

export function createOnce(run, store, id, fields) {
  if (exists(run, store, id)) return false;
  const args = ['create', '--id', id, '--silent', '--title', fields.title, '-t', fields.type ?? 'task',
    '-p', String(fields.priority ?? 2), '-l', fields.labels.join(','), '-d', fields.body];
  try { run(store, args); } catch (error) {
    // A concurrent or crashed earlier delivery may have created it between the check
    // and the create; that is success for an idempotent action.
    if (exists(run, store, id)) return false;
    throw error;
  }
  return true;
}

export async function loadEvent(operation, correlationId, root = queueRoot()) {
  const safe = String(operation).replace(/[^A-Za-z0-9_.-]/g, '_');
  return JSON.parse(await readFile(join(root, 'events', `${correlationId}-${safe}.json`), 'utf8'));
}

// The first positional after the script name is the subcommand or task id; flags and
// shell pipeline residue (`2>&1 | tail`) are not part of the call's own arguments.
export function callArgs(event) {
  const args = [];
  for (const arg of event.args ?? []) {
    if (/^\d*>&?\d*$/.test(arg) || arg === '|' || arg === '||' || arg === '&&' || arg === ';') break;
    args.push(arg);
  }
  return args;
}

export function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

export async function readMeta(taskId, env, event) {
  const home = env.FM_HOME || event.cwd;
  if (!home || !taskId) return {};
  try {
    const text = await readFile(join(home, 'state', `${taskId}.meta`), 'utf8');
    return Object.fromEntries(text.split('\n').filter(line => line.includes('=')).map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
  } catch { return {}; }
}

// Which call is this, and what bead-worthy thing did it do? Read-only subcommands and
// help output succeed too and must not write beads.
export async function describeCall(event, env = process.env) {
  const args = callArgs(event);
  const op = event.operation;
  const first = args[0];
  const taskLike = first && !first.startsWith('-');
  if (op === 'fm-spawn.sh' && taskLike) {
    const project = args[1] ? basename(args[1].replace(/\/+$/, '')) : null;
    return { verb: 'dispatched', task: first, project, line: `dispatched ${first}${project ? ` on ${project}` : ''}` };
  }
  if (op === 'fm-brief.sh' && taskLike) {
    // `fm-brief.sh <task> <repo> ...`; a secondmate charter has a flag in the repo slot and no single project
    const project = args[1] && !args[1].startsWith('-') ? basename(args[1].replace(/\/+$/, '')) : null;
    return { verb: 'briefed', task: first, project, line: `wrote brief for ${first}${project ? ` on ${project}` : ''}` };
  }
  if (op === 'fm-fleet-sync.sh') {
    // `fm-fleet-sync.sh [<project-dir-or-name>]`; with no argument the whole fleet synced, which
    // belongs to no single project, so it is noted on the fleet's own project bead.
    const named = first && !first.startsWith('-') ? basename(first.replace(/\/+$/, '')) : null;
    const project = named ?? env.FM_HOOK_FLEET_PROJECT ?? 'firstmate';
    return { verb: 'synced', project, line: named ? `synced project clone ${named}` : 'synced all project clones' };
  }
  if (op === 'fm-pr-merge.sh' && taskLike) {
    const meta = await readMeta(first, env, event);
    return { verb: 'merged', task: first, project: meta.project ? basename(meta.project) : null,
      line: `merged PR for ${first}: ${args[1] ?? meta.pr ?? 'url unknown'}` };
  }
  if (op === 'fm-merge-local.sh' && taskLike) {
    const meta = await readMeta(first, env, event);
    return { verb: 'landed', task: first, project: meta.project ? basename(meta.project) : null,
      line: `landed ${first} on local main` };
  }
  if (op === 'fm-branch-outcome.sh' && first === 'append') {
    const task = flagValue(args, '--task');
    const verdict = flagValue(args, '--verdict');
    const meta = await readMeta(task, env, event);
    return { verb: 'outcome', task, verdict, project: meta.project ? basename(meta.project) : null,
      line: `branch outcome for ${task ?? '?'} (${verdict ?? '?'}): ${clip(flagValue(args, '--summary') ?? '', 200)}` };
  }
  if (op === 'fm-captain-hold.sh' && first === 'answer' && args[1] && !args[1].startsWith('-')) {
    return { verb: 'answer', task: args[1], decisionFile: flagValue(args, '--decision-file') };
  }
  if (op === 'fm-captain-hold.sh' && first === 'hold' && args[1] && !args[1].startsWith('-')) {
    return { verb: 'hold', task: args[1], reason: flagValue(args, '--reason') ?? '',
      title: flagValue(args, '--title') };
  }
  return null;
}

async function ensureProjectBead(run, name, correlationId, env) {
  const found = await resolveProjectBead(run, name, { env });
  if (found) return found;
  // No bead names this project yet: mint one deterministically so the next call (and a
  // re-delivery of this one) finds it instead of making a second.
  const id = `${MINTED_PREFIX}${slug(name)}`;
  createOnce(run, 'projects', id, { title: name, type: 'task', priority: 3,
    labels: ['fm-hooks', `project:${name}`],
    body: `Project bead minted by fm-hooks so Firstmate calls on "${name}" have a timeline. Triggering call ${marker(correlationId)}.` });
  return id;
}

export function ledgerId(event) {
  const day = String(event.finishedAt ?? event.startedAt ?? new Date().toISOString()).slice(0, 10).replaceAll('-', '');
  return { id: `lifespan-fmh${day}`, day };
}

function ledger(run, event) {
  const { id, day } = ledgerId(event);
  createOnce(run, 'lifespan', id, { title: `fm-hooks timeline ${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`,
    type: 'task', priority: 4, labels: ['fm-hooks', 'ledger'],
    body: 'One comment per observed fm-*.sh call, appended by the fm-hooks catch-all rule. Idempotent per correlation id.' });
  const when = String(event.finishedAt ?? event.startedAt ?? '').slice(11, 19);
  const line = `${when}Z ${event.operation} ${event.outcome} ${event.harness ?? '?'}/${String(event.sessionId ?? '?').slice(0, 8)}`
    + ` ${clip(callArgs(event).join(' '), 120)}`;
  return { target: id, wrote: commentOnce(run, 'lifespan', id, event.correlationId, line) };
}

async function projectComment(run, event, call, env) {
  if (!call) return { skipped: 'not a state-changing call' };
  if (!call.project) return { skipped: `no project resolvable for ${call.task ?? 'call'}` };
  const id = await ensureProjectBead(run, call.project, event.correlationId, env);
  const text = `fm-hooks: ${call.line} (${event.harness ?? '?'}, ${String(event.finishedAt ?? '').slice(0, 19)}Z)`;
  const result: Record<string, any> = { target: id, wrote: commentOnce(run, 'projects', id, event.correlationId, text) };
  if (call.verb === 'outcome' && call.verdict === 'captain') {
    result.review = createOnce(run, 'review', `review-fmh${hex(event.correlationId, 8)}`, {
      title: `fm-hooks: ${clip(call.line, 120)}`, priority: 2, labels: ['fm-hooks', 'fm-outcome', `fm-task:${call.task}`],
      body: `${call.line}\n\nA branch outcome with verdict "captain" needs the captain's eyes. Closing this item relays the answer to Firstmate.\n\nproject bead: ${id}\ncorrelationId: ${event.correlationId}` });
  }
  return result;
}

export const CLOSED_BY = 'fm-closed-by:fm-hooks';

// `fm-captain-hold.sh answer` already delivered the captain's decision to Firstmate, so the
// open review bead for that hold is closed here -- and marked, so the poller does not relay
// the same answer a second time as a bead closure.
async function answerHold(run, event, call) {
  const open = JSON.parse(run('review', ['list', '--status', 'open', '-l', `fm-hold-task:${call.task}`, '--json', '-n', '0']) || '[]');
  if (!open.length) return { skipped: `no open hold for ${call.task}` };
  let decision = `decision file ${call.decisionFile ?? '(none given)'} not readable at action time`;
  if (call.decisionFile) { try { decision = (await readFile(call.decisionFile, 'utf8')).trim() || decision; } catch { /* keep the note */ } }
  const closed = [];
  for (const bead of open) {
    commentOnce(run, 'review', bead.id, event.correlationId, `fm-hooks: captain answered via fm-captain-hold.sh: ${clip(decision, 1500)}`);
    // Label first, close second: a closure the poller can see always already carries the label.
    run('review', ['label', 'add', bead.id, CLOSED_BY]);
    run('review', ['close', bead.id, '-r', 'answered via fm-captain-hold.sh answer']);
    closed.push(bead.id);
  }
  return { closed };
}

// A reason that reached the hook as raw argv still holds the shell's text: `$reason`,
// `${R}`, `$(cmd)` or a backtick. It must never become a bead title.
export const unexpanded = (text: string) => !String(text ?? '').trim() || /\$[A-Za-z_{(]|`/.test(String(text));

// The hold reason Firstmate recorded on the task itself: `fm-tasks-axi.sh show <task> --full`
// prints it as a `hold_reason:` field (quoted JSON when it has special characters).
export function recordedHoldReason(task: string, env: Record<string, any>, event: Record<string, any>, exec = execFileSync): string | null {
  const home = resolveFmHome(env, event.cwd ?? null);
  const binDir = env.FM_HOOK_FM_BIN_DIR || (home ? join(home, 'bin') : null);
  if (!binDir) return null;
  try {
    const out = String(exec(join(binDir, 'fm-tasks-axi.sh'), ['show', task, '--full'],
      { encoding: 'utf8', env: { ...env, ...(home ? { FM_HOME: home } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
    const raw = /^\s*hold_reason:\s*(.*)$/m.exec(out)?.[1]?.trim();
    if (!raw || raw === '-') return null;
    let reason = raw;
    if (raw.startsWith('"')) { try { reason = JSON.parse(raw); } catch { return null; } }
    return reason.trim() && !unexpanded(reason) ? reason : null;
  } catch { return null; }
}

const parseList = out => JSON.parse(out || '[]');

// Beads (open or closed) the task's earlier holds were filed as.
export const holdBeads = (run, task) => parseList(run('review', ['list', '--all', '-l', `fm-hold-task:${task}`, '--json', '-n', '0']));

function captainHold(run, event, call, env) {
  if (!call) return { skipped: 'not a hold' };
  if (call.verb === 'answer') return answerHold(run, event, call);
  const id = `review-fmh${hex(event.correlationId, 8)}`;
  if (exists(run, 'review', id)) return { target: id, wrote: false };
  // Firstmate keys a hold `captain-hold-<task>-<n>`; n is one past the holds this task
  // already has. Holds are minted under a per-task label, so the count is a store read.
  const prior = holdBeads(run, call.task);
  // One open review bead per held task: a re-hold annotates it instead of minting a twin.
  const open = prior.filter(bead => bead.status !== 'closed').sort((x, y) => String(x.created_at ?? '').localeCompare(String(y.created_at ?? '')))[0];
  const keyPrefix = `fm-key:captain-hold-${call.task}-`;
  let key = `captain-hold-${call.task}-${prior.length + 1}`;
  if (open) {
    // A re-hold has no bead of its own, so its occurrence number is one past the highest key
    // this task already carries (labels), and a redelivery reuses the key its comment recorded.
    const tag = marker(event.correlationId);
    const earlier = commentTexts(run, 'review', open.id).find(text => text.includes(tag));
    const recorded = earlier && /\(fm-key:(\S+?)\)/.exec(earlier)?.[1];
    if (recorded) return { target: open.id, wrote: false, reheld: true, key: recorded };
    const seen = prior.flatMap(bead => bead.labels ?? []).filter(l => l.startsWith(keyPrefix)).map(l => Number(l.slice(keyPrefix.length)) || 0);
    key = `captain-hold-${call.task}-${Math.max(prior.length, ...seen) + 1}`;
  }
  let reason = call.reason;
  if (unexpanded(reason)) {
    reason = recordedHoldReason(call.task, env, event);
    if (!reason) return { skipped: 'unresolved reason', raw: call.reason };
  }
  if (open) {
    commentOnce(run, 'review', open.id, event.correlationId, `fm-hooks: task re-held: ${clip(reason, 1500)} (fm-key:${key})`);
    run('review', ['label', 'add', open.id, `fm-key:${key}`]);
    return { target: open.id, wrote: false, reheld: true, key };
  }
  const wrote = createOnce(run, 'review', id, {
    title: `Captain hold: ${call.task} - ${clip(reason, 100)}`, priority: 1,
    labels: ['human', 'fm-hooks', 'fm-hold', `fm-hold-task:${call.task}`, `fm-task:${call.task}`, `fm-key:${key}`],
    body: `${reason}\n\nFirstmate held task ${call.task} for the captain.\nAnswer with: review human respond ${id} "your decision"\nThe answer is relayed to Firstmate (--resolve-key ${key}).\n\ncorrelationId: ${event.correlationId}` });
  return { target: id, wrote, key };
}

export async function runBeadAction({ kind, operation, correlationId, env = process.env, run = storeRunner(env), root }): Promise<any> {
  if (!KINDS.includes(kind)) throw new Error(`unknown bead action "${kind}" (expected ${KINDS.join(', ')})`);
  const event = await loadEvent(operation, correlationId, root);
  if (kind === 'ledger') return ledger(run, event);
  if (kind === 'fleet') return fleetAction(run, event, env);
  if (kind === 'scout-report') return scoutReport({ run, event, env });
  const call = await describeCall(event, env);
  return kind === 'captain-hold' ? captainHold(run, event, call, env) : projectComment(run, event, call, env);
}
