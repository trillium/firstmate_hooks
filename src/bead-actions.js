import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { queueRoot } from './paths.js';

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

export const KINDS = ['ledger', 'project-comment', 'captain-hold'];

const hex = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length);
const clip = (value, max) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const marker = correlationId => `[cid:${correlationId.slice(0, 16)}]`;

export function storeRunner(env = process.env) {
  return (store, args) => {
    const bin = env[`FM_HOOK_${store.toUpperCase()}_BIN`] || store;
    return execFileSync(bin, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  };
}

const exists = (run, store, id) => {
  try { run(store, ['show', id]); return true; } catch { return false; }
};

function commentTexts(run, store, id) {
  const out = run(store, ['comments', id, '--json']);
  const parsed = out.trim() ? JSON.parse(out) : [];
  return parsed.map(comment => String(comment.text ?? comment.body ?? ''));
}

// Add a comment once. The marker is part of the text, so a re-delivered job finds its
// own earlier comment and stops.
function commentOnce(run, store, id, correlationId, text) {
  const tag = marker(correlationId);
  if (commentTexts(run, store, id).some(existing => existing.includes(tag))) return false;
  run(store, ['comments', 'add', id, `${text} ${tag}`]);
  return true;
}

function createOnce(run, store, id, fields) {
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

async function readMeta(taskId, env, event) {
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
  if (op === 'fm-captain-hold.sh' && first === 'hold' && args[1] && !args[1].startsWith('-')) {
    return { verb: 'hold', task: args[1], reason: flagValue(args, '--reason') ?? 'no reason given',
      title: flagValue(args, '--title') };
  }
  return null;
}

function ensureProjectBead(run, name, correlationId) {
  const listed = JSON.parse(run('projects', ['list', '--all', '-l', `project:${name}`, '--json', '-n', '50']) || '[]');
  const pick = listed.find(bead => bead.title === name) ?? listed[0];
  if (pick) return pick.id;
  // No curated bead names this project yet: mint one deterministically so the next
  // call (and a re-delivery of this one) finds it instead of making a second.
  const id = `project-fmh-${slug(name)}`;
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

function projectComment(run, event, call) {
  if (!call) return { skipped: 'not a state-changing call' };
  if (!call.project) return { skipped: `no project resolvable for ${call.task ?? 'call'}` };
  const id = ensureProjectBead(run, call.project, event.correlationId);
  const text = `fm-hooks: ${call.line} (${event.harness ?? '?'}, ${String(event.finishedAt ?? '').slice(0, 19)}Z)`;
  const result = { target: id, wrote: commentOnce(run, 'projects', id, event.correlationId, text) };
  if (call.verb === 'outcome' && call.verdict === 'captain') {
    result.review = createOnce(run, 'review', `review-fmh${hex(event.correlationId, 8)}`, {
      title: `fm-hooks: ${clip(call.line, 120)}`, priority: 2, labels: ['fm-hooks', 'fm-outcome', `fm-task:${call.task}`],
      body: `${call.line}\n\nA branch outcome with verdict "captain" needs the captain's eyes. Closing this item relays the answer to Firstmate.\n\nproject bead: ${id}\ncorrelationId: ${event.correlationId}` });
  }
  return result;
}

function captainHold(run, event, call) {
  if (!call) return { skipped: 'not a hold' };
  const id = `review-fmh${hex(event.correlationId, 8)}`;
  if (exists(run, 'review', id)) return { target: id, wrote: false };
  // Firstmate keys a hold `captain-hold-<task>-<n>`; n is one past the holds this task
  // already has. Holds are minted under a per-task label, so the count is a store read.
  const prior = JSON.parse(run('review', ['list', '--all', '-l', `fm-hold-task:${call.task}`, '--json', '-n', '0']) || '[]');
  const key = `captain-hold-${call.task}-${prior.length + 1}`;
  const wrote = createOnce(run, 'review', id, {
    title: `Captain hold: ${call.task} - ${clip(call.reason, 100)}`, priority: 1,
    labels: ['human', 'fm-hooks', 'fm-hold', `fm-hold-task:${call.task}`, `fm-task:${call.task}`, `fm-key:${key}`],
    body: `${call.reason}\n\nFirstmate held task ${call.task} for the captain.\nAnswer with: review human respond ${id} "<decision>"\nThe answer is relayed to Firstmate (--resolve-key ${key}).\n\ncorrelationId: ${event.correlationId}` });
  return { target: id, wrote, key };
}

export async function runBeadAction({ kind, operation, correlationId, env = process.env, run = storeRunner(env), root }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown bead action "${kind}" (expected ${KINDS.join(', ')})`);
  const event = await loadEvent(operation, correlationId, root);
  if (kind === 'ledger') return ledger(run, event);
  const call = await describeCall(event, env);
  return kind === 'captain-hold' ? captainHold(run, event, call) : projectComment(run, event, call);
}
