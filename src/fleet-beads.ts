import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { callArgs, clip, commentOnce, createOnce, flagValue, readMeta } from './bead-actions.ts';

// One bead per Firstmate task in the `fleet` store, carrying the task's whole lifecycle:
// a comment per observed action (brief, dispatch, control, promote, steer, status
// transition, hold, merge, teardown) and a single-valued `fm-state:<x>` label holding the
// last transition. Open beads are the live fleet; closed beads are its history.
//
// Same idempotence contract as the other bead actions: the bead id is deterministic
// (`fleet-<task>`) and every comment carries a `[cid:...]` marker checked in the store.

export const FLEET_STORE = env => env.FM_HOOK_FLEET_STORE || 'fleet';
export const fleetId = task => `fleet-${task}`;
export const STATE_LABEL = 'fm-state:';
export const TASK_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CREATE_COMMAND = 'brain stores create fleet';

const CHARTER_BODY = 'One bead per Firstmate task (id fleet-<task-id>): lifecycle comments (brief, dispatch, status transitions, '
  + 'steer, hold, merge, teardown) written only by fm-hooks. Labels: fm-task:, project:, fm-kind:, fm-mode:, fm-state:, fm-home:. '
  + 'Open = live, closed = torn down.';

const hhmmss = iso => String(iso ?? '').slice(11, 19);
const showOne = (run, store, id) => {
  const parsed = JSON.parse(run(store, ['show', id, '--json']) || 'null');
  return Array.isArray(parsed) ? parsed[0] : parsed;
};

// Detect the store, and create it when it is missing. Detection is a cheap list; a missing
// wrapper (ENOENT) or a store the wrapper cannot open both count as absent. Creation is
// `brain stores create fleet`, which is itself idempotent, followed by the charter bead.
// FM_HOOK_FLEET_AUTOCREATE=0 turns creation off, leaving a clear error that names the command.
const ensured = new Set();
export function ensureFleetStore(run, env = process.env) {
  const store = FLEET_STORE(env);
  const key = `${env[`FM_HOOK_${store.toUpperCase()}_BIN`] || store}`;
  if (ensured.has(key)) return false;
  let created = false;
  try { run(store, ['list', '-n', '1', '--json']); } catch (probe) {
    if (env.FM_HOOK_FLEET_AUTOCREATE === '0') {
      throw new Error(`store "${store}" is not available (${clip(probe.stderr || probe.message, 120).trim()}); create it once with: ${CREATE_COMMAND}`);
    }
    try { run('brain', ['stores', 'create', store]); created = true; } catch (failure) {
      throw new Error(`store "${store}" is not available and creating it failed (${clip(failure.stderr || failure.message, 160).trim()}); create it once with: ${CREATE_COMMAND}`);
    }
  }
  createOnce(run, store, 'fleet-charter', { title: 'fleet store charter', type: 'task', priority: 2, labels: ['charter'], body: CHARTER_BODY });
  ensured.add(key);
  return created;
}
export const forgetEnsuredStores = () => ensured.clear();

export async function metaFields(task, env, event) {
  const meta = await readMeta(task, env, event);
  const home = env.FM_HOOK_FLEET_HOME || basename((env.FM_HOME || '').replace(/\/+$/, '')) || 'firstmate';
  return { project: meta.project ? basename(meta.project.replace(/\/+$/, '')) : undefined, kind: meta.kind, mode: meta.mode,
    harness: meta.harness, model: meta.model, backend: meta.backend, home };
}

// Ensure the per-task bead exists. Idempotent. Labels given here are only the ones known
// at creation; later facts arrive through swapLabel.
export function ensureFleetBead(run, env, { task, project, kind, mode, harness, model, home, title }) {
  ensureFleetStore(run, env);
  const id = fleetId(task);
  const labels = ['fm-hooks', `fm-task:${task}`, project && `project:${project}`, kind && `fm-kind:${kind}`,
    mode && `fm-mode:${mode}`, harness && `fm-harness:${harness}`, model && `fm-model:${model}`,
    `fm-home:${home || 'firstmate'}`].filter(Boolean);
  createOnce(run, FLEET_STORE(env), id, { title: title ?? `${task} (${kind || 'task'}${project ? `, ${project}` : ''})`,
    type: 'task', priority: 2, labels, body: `Firstmate task ${task}. One comment per observed action; labels carry the current state.` });
  return id;
}

// Move a single-valued label family (`fm-state:`, `fm-kind:`) to one value. A no-op when
// the bead already carries exactly that value, so a replayed action writes nothing.
export function swapLabel(run, env, id, prefix, value) {
  const bead = showOne(run, FLEET_STORE(env), id);
  const have = (bead?.labels ?? []).filter(l => l.startsWith(prefix));
  const want = `${prefix}${value}`;
  const stale = have.filter(l => l !== want);
  if (!stale.length && have.length) return false;
  const args = ['update', id];
  for (const label of stale) args.push('--remove-label', label);
  if (!have.includes(want)) args.push('--add-label', want);
  run(FLEET_STORE(env), args);
  return true;
}

// Comment once per correlation id; move the state label; add extra labels.
export async function fleetRecord(run, env, event, { task, line, state, kind, mode, extra = {}, meta }: Record<string, any>) {
  const fields = meta ?? await metaFields(task, env, event);
  const id = ensureFleetBead(run, env, { task, ...fields, ...(kind && { kind }), ...(mode && { mode }), ...extra });
  const store = FLEET_STORE(env);
  const stamp = `${hhmmss(event.finishedAt)}Z`;
  const who = `${event.harness ?? '?'}/${String(event.sessionId ?? '?').slice(0, 8)}`;
  const wrote = commentOnce(run, store, id, event.correlationId, `${stamp} ${line} (${who})`);
  if (state) swapLabel(run, env, id, STATE_LABEL, state);
  if (kind) swapLabel(run, env, id, 'fm-kind:', kind);
  if (mode) {
    const bead = showOne(run, store, id);
    if (!(bead?.labels ?? []).includes(`fm-mode:${mode}`)) swapLabel(run, env, id, 'fm-mode:', mode);
  }
  return { target: id, wrote, state: state ?? null };
}

// --- task resolution -------------------------------------------------------------------

const STDOUT = {
  'fm-spawn.sh': /^spawned (\S+) harness=/m,
  'fm-brief.sh': /^scaffolded: .*\/data\/([^/]+)\/brief\.md/m,
  'fm-merge-local.sh': /^merged fm\/(\S+) into local main/m,
};
const SLACK_MS = 2000;

// Files under `dir` (one level, optionally one level of subdirectories) whose mtime lies in
// the call's window. The record a call writes is evidence of which task it was about.
async function filesInWindow(dir, pick, event) {
  const from = Date.parse(event.startedAt ?? event.finishedAt) - SLACK_MS;
  const to = Date.parse(event.finishedAt ?? event.startedAt) + SLACK_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const hits = [];
  let names;
  try { names = await readdir(dir); } catch { return []; }
  for (const name of names) {
    const found = pick(name);
    if (!found) continue;
    try {
      const info = await stat(join(dir, name));
      if (info.mtimeMs >= from && info.mtimeMs <= to) hits.push(found);
    } catch { /* raced away */ }
  }
  return hits;
}

// Order: argv literal, stdout success lines, record written in the call window. Two records in the
// window is ambiguous and resolves to nothing, never to a guess. A spawn whose argv is a shell
// variable may be a loop body (`for t in a b; do fm-spawn.sh "$t"; done`) that spawned several
// tasks in one call: every `spawned <task>` line in stdout is one of them, in order.
export async function resolveTasks(event, env, args = callArgs(event)) {
  const argv = args.find(a => !a.startsWith('-'));
  if (argv && !argv.startsWith('$') && TASK_OK.test(argv)) return { tasks: [argv], source: 'argv' };
  const out = String(event.resultMetadata?.stdout ?? '');
  const pattern = STDOUT[event.operation];
  if (pattern) {
    const lines = event.operation === 'fm-spawn.sh' ? [...out.matchAll(new RegExp(pattern.source, 'gm'))] : [pattern.exec(out)].filter(Boolean);
    const tasks = [...new Set(lines.map(m => m[1]).filter(t => TASK_OK.test(t)))];
    if (tasks.length) return { tasks, source: 'stdout' };
  }
  const home = env.FM_HOME;
  if (home && event.operation === 'fm-spawn.sh') {
    const hits = await filesInWindow(join(home, 'state'), n => n.endsWith('.meta') && n.slice(0, -5), event);
    if (hits.length === 1 && TASK_OK.test(hits[0])) return { tasks: hits, source: 'record' };
  }
  if (home && event.operation === 'fm-brief.sh') {
    const hits = await filesInWindow(join(home, 'data'), n => n, event);
    const briefed = [];
    for (const name of hits) { try { await stat(join(home, 'data', name, 'brief.md')); briefed.push(name); } catch { /* none */ } }
    if (briefed.length === 1 && TASK_OK.test(briefed[0])) return { tasks: briefed, source: 'record' };
  }
  return { tasks: [], source: 'unresolved' };
}

export async function resolveTask(event, env, args = callArgs(event)) {
  const { tasks, source } = await resolveTasks(event, env, args);
  return { task: tasks[0] ?? null, source };
}

async function briefIntent(task, env) {
  if (!env.FM_HOME) return null;
  let text;
  try { text = await readFile(join(env.FM_HOME, 'data', task, 'brief.md'), 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const at = lines.findIndex(l => /^#+\s*Captain['’]s intent/i.test(l));
  if (at < 0) return null;
  const first = lines.slice(at + 1).map(l => l.trim()).find(Boolean);
  // A scaffold whose placeholder was never filled in must not become the title.
  if (!first || /\{[A-Z_]+\}/.test(first) || first.startsWith('#')) return null;
  return clip(first, 100);
}

// The newest inbox record is the delivery of a steer, so its body is the text when argv only
// held a shell variable. Exactly one record in the window, or nothing.
async function steerRecord(target, event, env) {
  const home = env.FM_HOME;
  if (!home) return null;
  const state = join(home, 'state');
  let dirs;
  try { dirs = (await readdir(state)).filter(n => n.endsWith('.inbox') && (!target || n === `${target}.inbox`)); } catch { return null; }
  const hits = [];
  for (const dir of dirs) {
    for (const name of await filesInWindow(join(state, dir), n => n.endsWith('.msg') && n, event)) hits.push({ task: dir.slice(0, -6), file: join(state, dir, name) });
  }
  if (hits.length !== 1) return null;
  const body = (await readFile(hits[0].file, 'utf8').catch(() => '')).split('\n').filter(l => !/^[a-z_-]+=\S*$/.test(l) && !l.startsWith('FIRSTMATE_OP')).join(' ').trim();
  return { task: hits[0].task, text: body };
}

// --- call description ------------------------------------------------------------------

const MODE_FLAG = args => flagValue(args, '--mode');

export async function describeFleetCall(event, env = process.env): Promise<Record<string, any> | null> {
  const args = callArgs(event);
  const op = event.operation;
  const first = args[0];
  if (!first || first === '--help' || first === '-h') return null;

  if (op === 'fm-brief.sh') {
    const { task, source } = await resolveTask(event, env, args);
    const repo = args[1] && !args[1].startsWith('-') ? basename(args[1].replace(/\/+$/, '')) : null;
    const kind = args.includes('--scout') ? 'scout' : args.some(a => a === '--secondmate' || a === '--charter') || !repo ? 'secondmate' : 'ship';
    const mode = MODE_FLAG(args);
    return { task, source, state: 'briefed', kind, mode, project: repo,
      line: `briefed ${task} for ${repo ?? 'a charter'} (${kind}${mode ? `, mode ${mode}` : ''})` };
  }
  if (op === 'fm-spawn.sh') {
    // One call may have dispatched several tasks (a loop under `bash -c`); each gets its own
    // description, and `more` carries the rest so fleetAction records every one of them.
    const { tasks, source } = await resolveTasks(event, env, args);
    const describe = async task => {
      const meta = task ? await readMeta(task, env, event) : {};
      // `$FM_HOME/projects/demo` still names demo; a bare `$p` names nothing and defers to meta.
      const literal = args[1] && !args[1].startsWith('-') ? basename(args[1].replace(/\/+$/, '')) : null;
      const project = literal && !literal.startsWith('$') ? literal : (meta.project ? basename(meta.project) : null);
      const parts = [meta.harness && `harness=${meta.harness}`, meta.model && `model=${meta.model}`, meta.backend && `backend=${meta.backend}`].filter(Boolean);
      return { task, source, state: 'dispatched', project, retitle: true,
        line: `dispatched ${task}${project ? ` on ${project}` : ''}${parts.length ? ` ${parts.join(' ')}` : ''}` };
    };
    const first = await describe(tasks[0] ?? null);
    const more = [];
    for (const task of tasks.slice(1)) more.push(await describe(task));
    return more.length ? { ...first, more } : first;
  }
  if (op === 'fm-control.sh') {
    const action = args.find((a, i) => i > 0 && !a.startsWith('-'));
    const { task, source } = await resolveTask(event, env, args);
    const proof = /^.*cancel=.*$/m.exec(String(event.resultMetadata?.stdout ?? ''))?.[0];
    if (action === 'relaunch') return { task, source, state: 'dispatched', line: `relaunched${proof ? ` (${clip(proof.trim(), 120)})` : ''}` };
    if (action === 'interrupt') return { task, source, line: `interrupted${proof ? ` (${clip(proof.trim(), 120)})` : ''}` };
    if (action === 'exit') return { task, source, state: 'stopped', line: `exited${proof ? ` (${clip(proof.trim(), 120)})` : ''}` };
    return null;
  }
  if (op === 'fm-promote.sh') {
    const { task, source } = await resolveTask(event, env, args);
    const mode = MODE_FLAG(args), yolo = flagValue(args, '--yolo');
    return { task, source, kind: 'ship', mode, line: `promoted scout→ship${mode ? ` mode=${mode}` : ''}${yolo ? ` yolo=${yolo}` : ''}` };
  }
  if (op === 'fm-pr-merge.sh' || op === 'fm-merge-local.sh') {
    const { task, source } = await resolveTask(event, env, args);
    const meta = task ? await readMeta(task, env, event) : {};
    return { task, source, state: 'merged',
      line: op === 'fm-merge-local.sh' ? `landed ${task} on local main` : `merged PR for ${task}: ${args[1] ?? meta.pr ?? 'url unknown'}` };
  }
  if (op === 'fm-teardown.sh') {
    const { task, source } = await resolveTask(event, env, args);
    return { task, source, state: 'cleaned-up', close: true, line: 'cleaned up' };
  }
  if (op === 'fm-send.sh') {
    let target = first.startsWith('-') ? null : first;
    const rest = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--resolve-key') { i += 1; continue; }
      if (!args[i].startsWith('--')) rest.push(args[i]);
    }
    let text = rest.join(' ');
    const keys = args.flatMap((a, i) => (a === '--resolve-key' && args[i + 1] ? [args[i + 1]] : []));
    if (!target || target.startsWith('$') || !text || text.startsWith('$') || /^\$/.test(rest[0] ?? '')) {
      const record = await steerRecord(target && !target.startsWith('$') ? target : null, event, env);
      if (record) { target = record.task; if (!text || text.startsWith('$')) text = record.text; }
    }
    if (!target || target.startsWith('$') || !TASK_OK.test(target)) return { task: null, source: 'unresolved' };
    const secondmate = /-ops$/.test(target);
    return { task: target, source: 'argv', kind: secondmate ? 'secondmate' : undefined,
      line: `steer → ${target}: ${clip(text || '(text not captured)', 300)}${keys.length ? ` resolves ${keys.map(k => `[key=${k}]`).join(' ')}` : ''}` };
  }
  if (op === 'fm-captain-hold.sh' && first === 'complete' && args[1] && !args[1].startsWith('-')) {
    const ids = args.slice(2).filter(a => !a.startsWith('--') || a === '--none');
    return { task: args[1], source: 'argv', line: `captain-call inventory complete (${ids.join(' ') || 'none'})` };
  }
  if (op === 'fm-captain-hold.sh' && first === 'answer' && args[1] && !args[1].startsWith('-')) {
    return { task: args[1], source: 'argv', line: 'captain answered hold' };
  }
  return null;
}

export async function fleetAction(run, event, env = process.env) {
  const call = await describeFleetCall(event, env);
  if (!call) return { skipped: 'not a fleet lifecycle call' };
  if (!call.task) return { skipped: 'unresolved' };
  const { more = [], ...first } = call;
  const result = await recordFleetCall(run, event, env, first);
  if (!more.length) return result;
  // Several tasks from one call: every one is recorded; the result names them all.
  const rest = [];
  for (const other of more) rest.push(await recordFleetCall(run, event, env, other));
  return { ...result, targets: [result.target, ...rest.map(r => r.target)], wrote: [result, ...rest].some(r => r.wrote) };
}

async function recordFleetCall(run, event, env, call): Promise<Record<string, any>> {
  const meta = await metaFields(call.task, env, event);
  if (call.project) meta.project = call.project;
  const store = FLEET_STORE(env);
  const id = fleetId(call.task);
  const result: Record<string, any> = await fleetRecord(run, env, event, { task: call.task, line: call.line, state: call.state,
    kind: call.kind, mode: call.mode, meta });
  if (call.state && call.state !== 'cleaned-up') {
    const bead = showOne(run, store, id);
    if (bead?.status === 'closed' && (call.state === 'briefed' || call.state === 'dispatched')) run(store, ['reopen', id]);
  }
  if (call.retitle) {
    const intent = await briefIntent(call.task, env);
    if (intent) {
      const title = `${call.task}: ${intent}`;
      const bead = showOne(run, store, id);
      if (bead && bead.title !== title) { run(store, ['update', id, '--title', title]); result.retitled = true; }
    }
  }
  if (call.close) {
    const bead = showOne(run, store, id);
    if (bead && bead.status !== 'closed') { run(store, ['close', id, '-r', 'torn down by fm-teardown.sh']); result.closed = true; }
  }
  return { ...result, source: call.source };
}
