import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { parseSemanticCommand } from './normalize.ts';
import { persistRecord } from './queue.ts';
import { scrubPath, scrubText } from './scrub.ts';
import { buildWakeNotice, isWakePrompt, recordWakeNotice } from './wake-notice.ts';

// The turn-end record: where one handling turn stopped. A drain says a wake arrived and
// the calls after it say what was done; this is the boundary that closes the turn, so the
// reply-based rules can run from the queue alone instead of being inferred from a
// transcript afterwards. Recorded by the Claude Stop hook, OpenCode's session.idle event
// and Pi's agent_settled event. Pure observation: the Stop hook prints nothing and exits 0,
// so it can neither block the stop nor continue the turn.

export const REPLY_CAP = 400;
// A turn is nearly always well inside this; a longer one reports a count for its tail.
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

const sha256 = (...parts: unknown[]) => createHash('sha256').update(parts.map(String).join('\0')).digest('hex');

export const isDrainCommand = (command: unknown) =>
  typeof command === 'string' && parseSemanticCommand(command).some(call => call.operation === 'fm-wake-drain.sh');

async function readTailLines(path: string) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail that starts mid-file starts mid-line.
    return { size, lines: (size > length ? text.slice(text.indexOf('\n') + 1) : text).split('\n') };
  } catch { return { size: null, lines: [] }; }
  finally { await handle?.close().catch(() => {}); }
}

const blocksOf = entry => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

// A prompt starts a turn: a user entry that carries text (or an image) rather than only
// tool results, that is not harness-injected meta text, and is not a sub-agent's own.
function startsTurn(entry) {
  if (entry?.type !== 'user' || entry.isSidechain === true || entry.isMeta === true) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return blocksOf(entry).some(block => block?.type === 'text' || block?.type === 'image');
}

const promptText = entry => {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return blocksOf(entry).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
};

// Reads the final turn of a Claude transcript (JSONL): everything after the last prompt.
// Only the tail of the file is read, and entries that do not parse are skipped, because a
// hook runs while the harness is still writing the file.
export async function analyzeTranscript(path: unknown) {
  const empty = { size: null as number | null, drainCallIds: [] as string[], toolCallCount: null as number | null, lastAssistantText: null as string | null,
    opening: null as { text: string; uuid: string | null; timestamp: string | null } | null };
  if (typeof path !== 'string' || !path) return empty;
  const { size, lines } = await readTailLines(path);
  if (size === null) return empty;
  const drainCallIds: string[] = [];
  let toolCallCount = 0, lastAssistantText: string | null = null, opening: typeof empty.opening = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (startsTurn(entry)) {
      opening = { text: promptText(entry), uuid: typeof entry.uuid === 'string' ? entry.uuid : null, timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null };
      break;
    }
    if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
    const blocks = blocksOf(entry);
    for (const block of [...blocks].reverse()) {
      if (block?.type === 'tool_use') {
        toolCallCount++;
        if (block.name === 'Bash' && isDrainCommand(block.input?.command) && typeof block.id === 'string') drainCallIds.unshift(block.id);
      }
    }
    if (lastAssistantText === null) {
      const written = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
      if (written) lastAssistantText = written;
    }
  }
  return { size, drainCallIds, toolCallCount, lastAssistantText, opening };
}

export function buildTurnEnd({ harness, sessionId, turnId, finishedAt = new Date().toISOString(), drainCallIds = [], toolCallCount = null,
  lastAssistantMessage = null, transcriptPath = null, stopHookActive = null }: Record<string, any>) {
  return {
    type: 'turn-end',
    harness,
    sessionId,
    turnId,
    finishedAt,
    drainCallIds,
    toolCallCount,
    lastAssistantMessage: typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim()
      ? scrubText(lastAssistantMessage, REPLY_CAP) : null,
    transcriptPath: scrubPath(transcriptPath),
    stopHookActive,
  };
}

export const recordTurnEnd = (record, root?: string, hint: Record<string, any> = {}) => persistRecord('turn-end', record.turnId, record, root, hint);

// Claude: the turn's position is the transcript's size when the Stop hook runs.
export async function turnEndFromClaudeStop(payload, root?: string) {
  if (typeof payload?.session_id !== 'string' || !payload.session_id) return null;
  const turn = await analyzeTranscript(payload.transcript_path);
  const record = buildTurnEnd({ harness: 'claude-code', sessionId: payload.session_id,
    // An unreadable transcript has no position: the clock stands in, so turns do not collapse into one id.
    turnId: sha256(payload.session_id, turn.size ?? `t${Date.now()}`),
    drainCallIds: turn.drainCallIds, toolCallCount: turn.toolCallCount,
    lastAssistantMessage: typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : turn.lastAssistantText,
    transcriptPath: payload.transcript_path, stopHookActive: typeof payload.stop_hook_active === 'boolean' ? payload.stop_hook_active : null });
  await recordTurnEnd(record, root, { cwd: payload.cwd });
  // A turn the watcher's wake opened also records the wake text it was opened with.
  if (turn.opening && isWakePrompt(turn.opening.text)) {
    await recordWakeNotice(buildWakeNotice({ harness: 'claude-code', sessionId: payload.session_id, turnId: record.turnId, opening: turn.opening }),
      root, { cwd: payload.cwd });
  }
  return record;
}

// OpenCode and Pi have no transcript file the observer may read, so the adapter watches
// the turn's tool calls as they happen and closes the turn on the harness's idle event.
// A turn's id is its session, the adapter's start time and its ordinal, so a restarted
// process cannot reuse the id of a turn an earlier process already recorded.
export function createTurnTracker(harness: string) {
  const startedAt = Date.now();
  const sessions = new Map<string, { turn: number; toolCallCount: number; drainCallIds: string[] }>();
  const sessionOf = (id: string) => {
    let session = sessions.get(id);
    if (!session) { session = { turn: 0, toolCallCount: 0, drainCallIds: [] }; sessions.set(id, session); }
    return session;
  };
  return {
    toolCall(sessionId: string | null | undefined, callId: string | null | undefined, command?: unknown) {
      if (!sessionId) return;
      const session = sessionOf(sessionId);
      session.toolCallCount++;
      if (callId && isDrainCommand(command)) session.drainCallIds.push(callId);
    },
    settle(sessionId: string | null | undefined) {
      if (!sessionId) return null;
      const session = sessionOf(sessionId);
      const record = buildTurnEnd({ harness, sessionId, turnId: sha256(sessionId, harness, startedAt, session.turn),
        drainCallIds: session.drainCallIds, toolCallCount: session.toolCallCount });
      session.turn++; session.toolCallCount = 0; session.drainCallIds = [];
      return record;
    },
  };
}
