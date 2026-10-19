import { createHash } from 'node:crypto';

// Split only shell command-list operators outside quotes. This is intentionally not
// a shell interpreter: semantic matches must be the command word, never text in args.
// Each unit records the operator that follows it (`;` `\n` `&&` `||` `|` `&`, or null at
// the end), which is what decides whether its exit status can be the call's exit status.
export function commandUnits(command) {
  const units = [];
  let start = 0, quote = null, escaped = false;
  const cut = (i, op, width) => { units.push({ text: command.slice(start, i), op }); start = i + width; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i], next = command[i + 1], prev = command[i - 1];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === ';' || c === '\n') cut(i, c, 1);
    else if ((c === '&' || c === '|') && next === c) { cut(i, c + c, 2); i++; }
    // `>|` clobbers; `|&` pipes stderr too; `>&`, `<&`, `&>` and `2>&1` are redirections.
    else if (c === '|' && prev !== '>') { cut(i, '|', next === '&' ? 2 : 1); if (next === '&') i++; }
    else if (c === '&' && prev !== '>' && prev !== '<' && next !== '>') cut(i, '&', 1);
  }
  units.push({ text: command.slice(start), op: null });
  return units;
}

export function commandSegments(command) {
  return commandUnits(command).map(unit => unit.text);
}

const isBlank = text => /^[\s{}()]*$/.test(text);

// A failed Bash call carries one exit code: the last command's. An fm-* invocation can have
// caused it only when nothing downstream replaces that status: it is not piped into another
// stage, not guarded by `||` or `&`, and no later command follows a `;` or newline. A later
// `&&` is not a mask: the chain stops at a failing fm-* and exits with its status.
function decidesExit(units, index) {
  for (let j = index; j < units.length; j++) {
    const { op } = units[j];
    if (op === null) return true;
    if (op === '&&') continue;
    if (op === '|' && j > index) continue;
    if (op === ';' || op === '\n') return units.slice(j + 1).every(unit => isBlank(unit.text));
    return false;
  }
  return true;
}

function shellWords(text) {
  const words = [];
  let word = '', quote = null, escaped = false, started = false;
  for (const c of text) {
    if (escaped) { word += c; escaped = false; started = true; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (c === quote) quote = null; else word += c; started = true; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) words.push(word); word = ''; started = false; continue; }
    word += c; started = true;
  }
  if (escaped) word += '\\';
  if (started) words.push(word);
  return words;
}

// A Firstmate call is identified by its command basename, not by a name list.
export const FIRSTMATE_CALL = /^fm[-_][A-Za-z0-9_.-]+$/;

// Words that may precede a command inside a compound: the body of a `for`/`while` loop or an
// `if` branch is still a command at a segment start (`do bin/fm-spawn.sh "$t"`), and a
// brace group opens with `{`. `!` is left out: it inverts the status the exit rule reads.
const COMPOUND_LEAD = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL = /^(?:ba|da|k|z)?sh$/;

// `bash -c '<script>'` (also sh, dash, ksh, zsh; `-c` may sit in a flag cluster such as
// `-lc` or `-ec`) runs the script, so the script's Firstmate calls are this call's. The
// script is the first operand after `-c`, which shellWords has already unquoted one level.
function wrappedScript(words) {
  if (!SHELL.test(words[0].split('/').at(-1))) return null;
  let seen = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--') continue;
    if (word === '-o' || word === '+o') { i++; continue; }
    if (/^[-+][A-Za-z]+$/.test(word)) { if (word.startsWith('-') && word.includes('c')) seen = true; continue; }
    return seen ? word : null;
  }
  return null;
}

export function parseSemanticCommand(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return [];
  const found = [];
  const units = commandUnits(rawCommand);
  for (const [unitIndex, unit] of units.entries()) {
    const words = shellWords(unit.text.trim());
    if (!words.length || words[0].startsWith('#')) continue;
    // Permit compound-command leads and ordinary variable assignments before a command;
    // do not expand the assignments.
    let index = 0;
    while (index < words.length && (COMPOUND_LEAD.has(words[index]) || ASSIGNMENT.test(words[index]))) index++;
    const command = words[index];
    if (!command) continue;
    const script = wrappedScript(words.slice(index));
    if (script !== null) {
      // The wrapper exits with the script's last status, so a nested call decided the
      // harness call's status only when it decided the script's and the wrapper decided
      // the call's. The raw command stays the harness call, which is what the queue keys on.
      const decided = decidesExit(units, unitIndex);
      for (const inner of parseSemanticCommand(script)) found.push({ ...inner, rawCommand, decidesExit: inner.decidesExit && decided });
      continue;
    }
    const operation = command.split('/').at(-1);
    if (!FIRSTMATE_CALL.test(operation)) continue;
    found.push({ operation, args: words.slice(index + 1), rawCommand, decidesExit: decidesExit(units, unitIndex) });
  }
  return found;
}

export function correlationId({ harness, sessionId, callId, rawCommand, timestamp }) {
  // Prefer harness call IDs. Content fallback is deterministic for replay; repeated
  // identical calls without IDs in one session intentionally collapse to one key.
  const stable = callId
    ? [harness || 'unknown', sessionId || '', callId].join('\0')
    : [harness || 'unknown', sessionId || '', rawCommand || ''].join('\0');
  return createHash('sha256').update(stable).digest('hex');
}

export function normalizeEvent(input) {
  const semantic = parseSemanticCommand(input.rawCommand);
  if (!semantic.length) return [];
  return semantic.map(({ operation, args, rawCommand, decidesExit }) => ({
    operation,
    args,
    rawCommand,
    cwd: input.cwd ?? null,
    project: input.project ?? null,
    harness: input.harness,
    sessionId: input.sessionId ?? null,
    callId: input.callId ?? null,
    correlationId: correlationId({ ...input, rawCommand }),
    // A failed call is only a failure of this invocation when its status was the call's status.
    outcome: input.outcome === 'failure' && !decidesExit ? 'unknown' : input.outcome ?? 'unknown',
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
    resultMetadata: input.resultMetadata ?? null,
    source: input.source ?? null
  }));
}

export function explicitOpenCodeOutcome(output) {
  const candidates = [output?.metadata?.exitCode, output?.metadata?.exit_code, output?.metadata?.code,
    output?.exitCode, output?.exit_code, output?.code];
  const code = candidates.find(Number.isInteger);
  if (code !== undefined) return { outcome: code === 0 ? 'success' : 'failure', exitCode: code };
  if (output?.metadata?.success === true || output?.success === true) return { outcome: 'success', exitCode: null };
  if (output?.metadata?.success === false || output?.success === false || output?.error) return { outcome: 'failure', exitCode: null };
  return { outcome: 'unknown', exitCode: null };
}
