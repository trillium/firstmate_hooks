import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clip } from './bead-actions.ts';
import { fleetRecord, TASK_OK } from './fleet-beads.ts';

// Crew status transitions -> fleet bead. A crew appends `state [at=<epoch>]: text` lines to
// `$FM_HOME/state/<task>.status`; several writers feed that file (the crew itself, Firstmate,
// relayed lines), so it is tailed rather than recognized in a hook. Each line becomes one
// comment on `fleet-<task>`, and a transition into a known state moves the `fm-state:` label.
//
// Never backfills: the first run records where every file ends and reads nothing, exactly like
// the closure poller, or months of history would land in one cycle. A file that appears after
// that starts at its beginning. The comment's correlation id is a hash of (task, byte offset,
// line), stable across restarts, so a crash between the write and the cursor repeats nothing.

export const STATE_FROM_LINE = {
  working: 'working', 'needs-decision': 'needs-decision', blocked: 'blocked', paused: 'paused', done: 'done', failed: 'failed',
};
const LINE = /^(working|needs-decision|blocked|paused|done|failed|resolved)\s*(?:\[at=(\d+)\])?\s*(?:\[key=([^\]]+)\])?\s*:\s*(.*)$/;

export const statusTailDir = root => join(root, 'status-tail');
const cursorPath = root => join(statusTailDir(root), 'cursor.json');

export function parseStatusLine(text) {
  const match = LINE.exec(text.trim());
  if (!match) return null;
  return { state: match[1], at: match[2] ? Number(match[2]) : null, key: match[3] ?? null, text: match[4] };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

export async function readStatusCursor(root) {
  try { return JSON.parse(await readFile(cursorPath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Complete lines at or after `offset`; a trailing partial line is left for the next read.
async function readLines(path, offset) {
  const buffer = await readFile(path);
  const end = buffer.lastIndexOf(0x0a) + 1;
  const lines = [];
  let at = offset;
  while (at < end) {
    const next = buffer.indexOf(0x0a, at);
    lines.push({ text: buffer.subarray(at, next).toString('utf8'), offset: at });
    at = next + 1;
  }
  return { lines, offset: Math.max(offset, end) };
}

export async function tailStatusOnce({ root, env = process.env, run, now = Date.now() }) {
  const home = env.FM_HOME;
  if (!home) return { skipped: 'FM_HOME is not set', recorded: [] };
  const stateDir = join(home, 'state');
  let names;
  try { names = (await readdir(stateDir)).filter(n => n.endsWith('.status')); } catch { return { skipped: 'no state directory', recorded: [] }; }
  const previous = await readStatusCursor(root);
  const initial = previous === null;
  const cursor = {};
  const recorded = [], failed = [];
  for (const name of names) {
    const task = name.slice(0, -'.status'.length);
    if (!TASK_OK.test(task)) continue;
    const path = join(stateDir, name);
    let info;
    try { info = await stat(path); } catch { continue; }
    const seen = previous?.[task];
    // First sight of a file: at its end on the very first run (no backfill), at its start otherwise.
    let offset = seen ? seen.offset : initial ? info.size : 0;
    // A shorter file, or a different inode, is a truncation or replacement: start over.
    if (seen && (info.size < seen.offset || info.ino !== seen.inode)) offset = 0;
    cursor[task] = { offset, inode: info.ino };
    if (info.size <= offset) continue;
    const { lines, offset: next } = await readLines(path, offset);
    for (const line of lines) {
      const parsed = parseStatusLine(line.text);
      if (!parsed) { cursor[task].offset = line.offset + Buffer.byteLength(line.text) + 1; continue; }
      const correlationId = createHash('sha256').update(`${task}\0${line.offset}\0${line.text}`).digest('hex');
      const finishedAt = new Date(parsed.at ? parsed.at * 1000 : now).toISOString();
      try {
        const result = await fleetRecord(run, env, { correlationId, finishedAt, harness: 'status', sessionId: task },
          { task, state: STATE_FROM_LINE[parsed.state],
            line: `status ${parsed.state}${parsed.key ? ` [key=${parsed.key}]` : ''}: ${clip(parsed.text, 300)}` });
        recorded.push({ task, state: parsed.state, wrote: result.wrote });
        cursor[task].offset = line.offset + Buffer.byteLength(line.text) + 1;
      } catch (error) {
        // Stop at the failed line so the next cycle retries it (and everything after it).
        failed.push({ task, error: clip(error.stderr?.toString() || error.message, 200) });
        break;
      }
    }
    if (!failed.some(f => f.task === task)) cursor[task].offset = next;
  }
  await writeJson(cursorPath(root), cursor);
  return { initialized: initial, recorded, failed };
}
