import { createHash } from 'node:crypto';

const OPERATIONS = new Set(['fm_dispatch', 'fm_scout']);

// Split only shell command-list operators outside quotes. This is intentionally not
// a shell interpreter: semantic matches must be the command word, never text in args.
export function commandSegments(command) {
  const segments = [];
  let start = 0, quote = null, escaped = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === ';' || c === '\n' || (c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      segments.push(command.slice(start, i));
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
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

export function parseSemanticCommand(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return [];
  const found = [];
  for (const segment of commandSegments(rawCommand)) {
    const words = shellWords(segment.trim());
    if (!words.length || words[0].startsWith('#')) continue;
    // Permit ordinary variable assignments before a command; do not expand them.
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
    const command = words[index];
    if (!command) continue;
    const operation = command.split('/').at(-1);
    if (!/^fm_[A-Za-z0-9_]+$/.test(operation) || !OPERATIONS.has(operation)) continue;
    found.push({ operation, args: words.slice(index + 1), rawCommand });
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
  return semantic.map(({ operation, args, rawCommand }) => ({
    operation,
    args,
    rawCommand,
    cwd: input.cwd ?? null,
    project: input.project ?? null,
    harness: input.harness,
    sessionId: input.sessionId ?? null,
    callId: input.callId ?? null,
    correlationId: correlationId({ ...input, rawCommand }),
    outcome: input.outcome ?? 'unknown',
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
