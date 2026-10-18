import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// fm-hooks is a stateful observer. Every location it writes is resolved here, once,
// as an absolute path rooted in fm-hooks' own state area -- never from process.cwd().
//
// The original default was the relative path '.fm-hooks/queue', which every adapter
// resolved against process.cwd(). Running an agent inside a product repository
// therefore created an untracked .fm-hooks/ state directory inside that repository:
// telemetry landed in product diffs, the log grew unbounded inside a source tree, and
// any tool requiring a clean tree (git status --porcelain) refused to start there.
// A correct default must not depend on the directory a process happens to start in.

export const STATE_DIR_NAME = 'fm-hooks';

// Rotation policy for events.jsonl. The observed unbounded case was ~20 KB in one
// session, so the default cap is deliberately far above a normal session while still
// bounding a hostile or looping one.
export const DEFAULT_EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_KEEP = 3;

// An override may be absolute, or relative -- in which case it is anchored to the
// user's home directory, never to the current working directory. That keeps the
// resolved path identical no matter where a harness starts.
function anchored(value) {
  return isAbsolute(value) ? resolve(value) : resolve(homedir(), value);
}

export function safeCwd() {
  try { return process.cwd(); } catch { return null; }
}

// The single base directory for fm-hooks' own state. Precedence:
//   1. FM_HOOK_STATE_DIR   explicit state root
//   2. $FM_HOME/state/fm-hooks   Firstmate home convention
//   3. $XDG_STATE_HOME/fm-hooks
//   4. ~/.local/state/fm-hooks   final default
export function stateRoot(env = process.env) {
  if (env.FM_HOOK_STATE_DIR) return anchored(env.FM_HOOK_STATE_DIR);
  if (env.FM_HOME) return join(anchored(env.FM_HOME), 'state', STATE_DIR_NAME);
  if (env.XDG_STATE_HOME) return join(anchored(env.XDG_STATE_HOME), STATE_DIR_NAME);
  return join(homedir(), '.local', 'state', STATE_DIR_NAME);
}

// The queue root every adapter and the worker share. FM_HOOK_QUEUE is kept as an
// explicit override; it is the only way to place the queue outside fm-hooks' state.
export function queueRoot(env = process.env) {
  return env.FM_HOOK_QUEUE ? anchored(env.FM_HOOK_QUEUE) : join(stateRoot(env), 'queue');
}

// Rule sets are legitimately per-project, but the *default* is still absolute so that
// a missing rules file can never cause a write, or a surprise read, inside a product
// tree. Precedence: explicit FM_HOOK_RULES, then a project-local read-only override,
// then the state-resident default. fm-hooks only ever reads these paths.
export function defaultRulesPaths(env = process.env, cwd = safeCwd()) {
  if (env.FM_HOOK_RULES) return [anchored(env.FM_HOOK_RULES)];
  const paths = [];
  if (cwd) paths.push(join(cwd, 'fm-hooks.rules.json'));
  paths.push(join(stateRoot(env), 'fm-hooks.rules.json'));
  return paths;
}

function wholeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// FM_HOOK_EVENT_LOG_MAX_BYTES=0 disables rotation explicitly; the log is otherwise
// always bounded.
export function eventLogPolicy(env = process.env) {
  return {
    maxBytes: wholeNumber(env.FM_HOOK_EVENT_LOG_MAX_BYTES, DEFAULT_EVENT_LOG_MAX_BYTES),
    keep: wholeNumber(env.FM_HOOK_EVENT_LOG_KEEP, DEFAULT_EVENT_LOG_KEEP),
  };
}

// Retry policy for queued actions. A failed action stays queued with exponential
// backoff (backoffMs, doubling, capped at maxBackoffMs) until maxAttempts have failed,
// then moves to failed/. FM_HOOK_MAX_ATTEMPTS=1 restores fail-on-first-error.
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BACKOFF_MS = 5000;
export const DEFAULT_RETRY_MAX_BACKOFF_MS = 10 * 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function retryPolicy(env = process.env) {
  return {
    maxAttempts: positiveInteger(env.FM_HOOK_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    backoffMs: wholeNumber(env.FM_HOOK_RETRY_BACKOFF_MS, DEFAULT_RETRY_BACKOFF_MS),
    maxBackoffMs: wholeNumber(env.FM_HOOK_RETRY_MAX_BACKOFF_MS, DEFAULT_RETRY_MAX_BACKOFF_MS),
  };
}

// Longest an action may run before the worker kills it, so a hung store call cannot
// stall the queue. FM_HOOK_ACTION_TIMEOUT_MS=0 disables the limit.
export const DEFAULT_ACTION_TIMEOUT_MS = 60000;
export function actionTimeoutMs(env = process.env) {
  return wholeNumber(env.FM_HOOK_ACTION_TIMEOUT_MS, DEFAULT_ACTION_TIMEOUT_MS);
}

// Stable, explicit identity for a migrated legacy queue. Keyed off the resolved real
// path, so two checkouts of the same repository cannot collide and a nested subagent
// cannot silently re-parent an existing archive.
export function namespaceKey(realPath) {
  const digest = createHash('sha256').update(String(realPath)).digest('hex').slice(0, 12);
  const leaf = String(realPath).split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
  return `${leaf.replace(/[^A-Za-z0-9_.-]/g, '_')}-${digest}`;
}
