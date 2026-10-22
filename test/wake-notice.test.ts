import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeHook } from '../src/claude-events.ts';
import { isWakePrompt } from '../src/wake-notice.ts';
import { scrubText } from '../src/scrub.ts';

const SECRET = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789';
const WAKE = (reason = 'check: captain inbox note pending: inbox:1792477442-FS8ddB') => `<task-notification>
<summary>Stop hook feedback</summary>
</task-notification>
<system-reminder>
Stop hook blocking error from command "Stop": firstmate watcher wake - one supervision event needs a handling turn now.
${reason}
Run bin/fm-wake-drain.sh first, handle the wake, then run its exact WAKE_ACK_REQUIRED --ack-through command.
</system-reminder>`;

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-notice-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try { await fn({ dir, queue: join(dir, 'queue'), transcript: join(dir, 'proj', 's-1.jsonl') }); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}
const prompt = (text, uuid, timestamp) => ({ type: 'user', uuid, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
const reply = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const writeTranscript = async (path, entries) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
};
const stop = (transcript, queue) => handleClaudeHook({ hook_event_name: 'Stop', session_id: 's-1', transcript_path: transcript, cwd: '/x' }, { root: queue, eventName: 'Stop' });
const notices = async queue => Promise.all((await readdir(join(queue, 'wake-notice')).catch(() => [])).sort()
  .map(name => readFile(join(queue, 'wake-notice', name), 'utf8').then(JSON.parse)));

test('the Stop that ends a wake-opened turn records the wake text the harness delivered', async () => fixture(async ({ dir, queue, transcript }) => {
  await writeTranscript(transcript, [
    prompt('an ordinary prompt', 'u0', '2026-10-22T09:00:00.000Z'), reply('ok'),
    prompt(WAKE(`check: ${dir}/state/x.sh: ${SECRET} is down`), 'u1', '2026-10-22T10:00:00.123Z'), reply('handled'),
  ]);
  await stop(transcript, queue);
  const [notice] = await notices(queue);
  const [turn] = await Promise.all((await readdir(join(queue, 'turn-end'))).map(name => readFile(join(queue, 'turn-end', name), 'utf8').then(JSON.parse)));
  assert.equal(notice.type, 'wake-notice');
  assert.equal(notice.harness, 'claude-code');
  assert.equal(notice.sessionId, 's-1');
  assert.equal(notice.finishedAt, '2026-10-22T10:00:00.123Z', 'when the wake was delivered, not when the turn ended');
  assert.equal(notice.turnId, turn.turnId, 'it opened the turn this Stop closed');
  assert.equal(notice.source, 'transcript');
  assert.match(notice.noticeId, /^[0-9a-f]{64}$/);
  assert.ok(notice.body.includes('firstmate watcher wake - one supervision event needs a handling turn now.'));
  assert.ok(notice.body.includes('check: ~/state/x.sh: [redacted] is down'), notice.body);
  assert.ok(notice.body.includes('\n'), 'the reason line stays on its own line');
  assert.ok(!/<\/?(?:task-notification|system-reminder|summary)>/.test(notice.body), 'markup tags are stripped');
  assert.ok(!notice.body.includes(SECRET) && !notice.body.includes(dir));
  const log = (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => entry.type).sort(), ['turn-end', 'wake-notice']);
}));

test('a turn opened by anything else records no notice', async () => fixture(async ({ queue, transcript }) => {
  for (const text of ['please look at the PR', 'FIRSTMATE_OP: v1 launch-brief: x', '<task-notification>\n<summary>Background task done</summary>\n</task-notification>']) {
    await writeTranscript(transcript, [prompt(text, 'u1', '2026-10-22T10:00:00.000Z'), reply('ok')]);
    await stop(transcript, queue);
  }
  assert.deepEqual(await notices(queue), []);
  assert.ok(isWakePrompt(WAKE()));
  assert.ok(!isWakePrompt('Stop hook blocking error: firstmate watcher wake'), 'must be a delivered task notification');
}));

test('only the wake that opened the final turn is recorded, and a continuation Stop does not repeat it', async () => fixture(async ({ queue, transcript }) => {
  await writeTranscript(transcript, [prompt(WAKE('check: first'), 'u1', '2026-10-22T10:00:00.000Z'), reply('first handled'),
    prompt('thanks', 'u2', '2026-10-22T10:05:00.000Z'), reply('welcome')]);
  await stop(transcript, queue);
  assert.deepEqual(await notices(queue), [], 'the final turn was opened by "thanks"');
  await writeTranscript(transcript, [prompt(WAKE('check: second'), 'u3', '2026-10-22T11:00:00.000Z'), reply('working')]);
  await stop(transcript, queue);
  await writeTranscript(transcript, [prompt(WAKE('check: second'), 'u3', '2026-10-22T11:00:00.000Z'), reply('working'), reply('more')]);
  await stop(transcript, queue);
  assert.equal((await notices(queue)).length, 1);
  const log = (await readFile(join(queue, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.filter(entry => entry.type === 'wake-notice').length, 1);
}));

test('two wakes with identical text are two notices', async () => fixture(async ({ queue, transcript }) => {
  await writeTranscript(transcript, [prompt(WAKE(), 'u1', '2026-10-22T10:00:00.000Z'), reply('a')]);
  await stop(transcript, queue);
  await writeTranscript(transcript, [prompt(WAKE(), 'u1', '2026-10-22T10:00:00.000Z'), reply('a'), prompt(WAKE(), 'u2', '2026-10-22T10:00:07.000Z'), reply('b')]);
  await stop(transcript, queue);
  assert.deepEqual((await notices(queue)).map(notice => notice.finishedAt).sort(), ['2026-10-22T10:00:00.000Z', '2026-10-22T10:00:07.000Z']);
}));

test('the body is capped at 1000 characters', async () => fixture(async ({ queue, transcript }) => {
  await writeTranscript(transcript, [prompt(WAKE('check: ' + 'long '.repeat(500)), 'u1', '2026-10-22T10:00:00.000Z'), reply('ok')]);
  await stop(transcript, queue);
  assert.equal((await notices(queue))[0].body.length, 1000);
}));

test('scrubText can keep line breaks', () => {
  assert.equal(scrubText('a\r\nb\t\tc\n\n\n\nd\u0000e', 400, { keepNewlines: true }), 'a\nb c\n\nde');
  assert.equal(scrubText('a\nb', 400), 'a b');
});
