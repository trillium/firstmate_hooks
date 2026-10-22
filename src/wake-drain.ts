import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveFmHome, stateDirOf } from './fm-home.ts';
import { scrubText } from './scrub.ts';

// The structured record behind a `fm-wake-drain.sh` call. The drain's own stdout is what
// the firstmate reads, but the harness pipes most drains through head/grep before the hook
// sees them, so the observer cannot rebuild the wake from `tool_response`. It rebuilds it
// from the wake queue store the drain read instead, and writes it next to the drain event
// under the same correlation id.
//
// Read-only by construction: every access here is a bounded read of a file in the home's
// state directory. Nothing is acknowledged, drained, claimed, locked, created or rewritten,
// so observing a drain can never change what the next drain presents.

export const WAKE_TEXT_CAP = 400;
const ROW_LIMIT = 100;
const OUTCOME_LIMIT = 20;
const DECISION_LIMIT = 20;
const STATUS_TAIL_BYTES = 8 * 1024;
const OUTCOME_TAIL_BYTES = 256 * 1024;
const QUEUE_BYTES = 1024 * 1024;

const ACK_LINE = /--ack-through\s+(\d+)\s+--recovery-generation\s+([A-Za-z0-9._-]+)/;
const DECISION_LINE = /^([A-Za-z0-9._-]+)(?: \[key=[^\]]+\])? (?:needs-decision|blocked): .+$/;

// What the drain's printed output proves, whichever of stdout and stderr carried it. The
// cutoff and generation are on the WAKE_ACK_REQUIRED line, which a pipe often cuts off.
export function parseDrainOutput(text: string) {
  const ack = ACK_LINE.exec(text);
  const openDecisions: string[] = [];
  let inSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('OPEN DECISIONS (')) { inSection = true; continue; }
    if (!inSection) continue;
    if (line.startsWith('OPEN DECISIONS:')) { if (line.includes('close one')) inSection = false; continue; }
    if (DECISION_LINE.test(line) && openDecisions.length < DECISION_LIMIT) openDecisions.push(line);
  }
  return { ackThrough: ack ? Number(ack[1]) : null, recoveryGeneration: ack ? ack[2] : null, openDecisions };
}

async function readTail(path: string, bytes: number): Promise<string | null> {
  let handle;
  try {
    // O_NOFOLLOW, like the drain's own reads: a symlink planted in the state directory is not followed.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail that starts mid-file starts mid-line: drop the partial first line.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

const lines = (text: string | null) => (text ?? '').split('\n').filter(line => line.trim());

// fm_wake_print_deduped: rows keep the order of their first appearance, a repeat of the
// same (kind, key) replaces the earlier row's content, and every heartbeat is one.
function dedupe(rows) {
  const order: string[] = [], latest = new Map();
  for (const row of rows) {
    const id = row.kind === 'heartbeat' ? 'heartbeat' : `${row.kind}\0${row.name}`;
    if (!latest.has(id)) order.push(id);
    latest.set(id, row);
  }
  return order.map(id => latest.get(id));
}

function parseQueue(text: string | null) {
  const rows: { epoch: number; seq: number; kind: string; name: string; payload: string }[] = [];
  for (const line of lines(text)) {
    const fields = line.split('\t');
    if (fields.length < 5 || !/^\d+$/.test(fields[1])) continue;
    rows.push({ epoch: Number(fields[0]) || 0, seq: Number(fields[1]), kind: fields[2], name: fields[3], payload: fields.slice(4).join('\t') });
  }
  return rows;
}

// `needs-decision [at=1792659853] [key=nm-x]: text` (the bracketed fields in either order).
function parseStatusLine(line: string) {
  const match = /^\s*([A-Za-z][A-Za-z-]*)((?:\s*\[(?:at|key)=[^\]]*\])*)\s*:\s*(.*)$/.exec(line);
  if (!match) return null;
  const at = /\[at=(\d+)\]/.exec(match[2]), key = /\[key=([^\]]*)\]/.exec(match[2]);
  return { state: match[1], at: at ? Number(at[1]) : null, key: key ? key[1] : null, text: match[3] };
}

async function annotationFor(state: string, rows) {
  for (const row of [...rows].reverse()) {
    if (row.kind !== 'signal' || !/^[A-Za-z0-9._-]+\.status$/.test(row.name)) continue;
    const last = lines(await readTail(join(state, row.name), STATUS_TAIL_BYTES)).at(-1);
    const parsed = last ? parseStatusLine(last) : null;
    if (!parsed) continue;
    return { task: row.name.slice(0, -'.status'.length), state: parsed.state, at: parsed.at, key: parsed.key,
      text: scrubText(parsed.text, WAKE_TEXT_CAP) };
  }
  return null;
}

// The captain outcomes a drain presents on every drain until they are marked processed:
// verdict `captain`, not silent, after the processed mark, and up to the read cursor the
// presentation advanced. A routine row is presented once and is not part of this set.
async function branchOutcomesFor(state: string, now: number) {
  const number = async name => {
    const value = Number(lines(await readTail(join(state, name), 64))[0]);
    return Number.isInteger(value) ? value : null;
  };
  const [processed, cursor] = [await number('.branch-outcomes-processed'), await number('.branch-outcomes-cursor')];
  if (processed === null || cursor === null) return [];
  const outcomes: { seq: number; recordedMinutesAgo: number; task: string; text: string }[] = [];
  for (const line of lines(await readTail(join(state, 'branch-outcomes.jsonl'), OUTCOME_TAIL_BYTES))) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.verdict !== 'captain' || row.silent === true || !Number.isInteger(row.seq)) continue;
    if (row.seq <= processed || row.seq > cursor) continue;
    outcomes.push({ seq: row.seq, recordedMinutesAgo: Math.max(0, Math.floor((now - Number(row.epoch || now)) / 60)),
      task: scrubText(row.task, 120), text: scrubText(row.summary, WAKE_TEXT_CAP) });
  }
  return outcomes.slice(-OUTCOME_LIMIT);
}

function outputOf(event): string {
  const meta = event.resultMetadata ?? {};
  return [meta.stdout, meta.stderr, meta.output, event.source?.output]
    .filter(part => typeof part === 'string' && part).join('\n');
}

// A presenting drain: a successful fm-wake-drain.sh call that is not an acknowledgement.
export function isPresentingDrain(event): boolean {
  return event?.operation === 'fm-wake-drain.sh' && event.outcome === 'success'
    && !(event.args ?? []).includes('--ack-through');
}

export async function buildWakeDrain(event, { env = process.env, now = Math.floor(Date.now() / 1000) }: Record<string, any> = {}) {
  const output = parseDrainOutput(outputOf(event));
  const fmHome = resolveFmHome(env, event.cwd, event.rawCommand);
  const state = fmHome ? stateDirOf(fmHome) : null;

  let rows: any[] = [], rowsSource = 'unavailable', claimed: number | null = null, generation: string | null = null;
  if (state) {
    const queueText = await readTail(join(state, '.wake-queue'), QUEUE_BYTES);
    const queue = parseQueue(queueText);
    const claim = new Set(lines(await readTail(join(state, '.main-eligible-rows'), QUEUE_BYTES)).filter(l => /^\d+$/.test(l)).map(Number));
    // A queue that cannot be read at all is unavailable; one that reads empty has no rows.
    if (queueText !== null) {
      const mine = claim.size ? queue.filter(row => claim.has(row.seq)) : queue;
      rowsSource = claim.size ? 'claim' : 'queue';
      const cutoff = output.ackThrough;
      rows = dedupe(mine.filter(row => cutoff === null || row.seq <= cutoff));
      claimed = rows.length ? Math.max(...rows.map(row => row.seq)) : null;
    }
    const marker = lines(await readTail(join(state, '.watcher-down'), 256))[0]?.trim();
    generation = marker && /^[a-z]+:[a-z]+:[A-Za-z0-9._-]+$/.test(marker) ? marker.split(':')[2] : null;
  }

  const shown = rows.slice(-ROW_LIMIT).map(row => ({ epoch: row.epoch, seq: row.seq, kind: row.kind,
    name: scrubText(row.name, 160), text: scrubText(row.payload, WAKE_TEXT_CAP) }));
  return {
    type: 'wake-drain',
    operation: 'fm-wake-drain.sh',
    correlationId: event.correlationId,
    harness: event.harness ?? null,
    sessionId: event.sessionId ?? null,
    callId: event.callId ?? null,
    ackThrough: output.ackThrough ?? claimed,
    recoveryGeneration: output.recoveryGeneration ?? generation,
    rows: shown,
    rowsSource,
    annotation: state && rows.length ? await annotationFor(state, rows) : null,
    branchOutcomes: state ? await branchOutcomesFor(state, now) : [],
    openDecisions: output.openDecisions.map(line => scrubText(line, WAKE_TEXT_CAP)),
    openDecisionsSource: output.openDecisions.length ? 'output' : 'unavailable',
    finishedAt: event.finishedAt,
  };
}
