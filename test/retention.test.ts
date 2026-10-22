import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeHook } from '../src/claude-events.ts';
import { observe } from '../src/observer.ts';

// The README names the write-once files as the system of record and events.jsonl as the
// bounded feed. This pins the claim: rotation drops old log lines and nothing else.
test('rotating events.jsonl never removes the write-once records behind it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-hooks-retention-'));
  const old = { max: process.env.FM_HOOK_EVENT_LOG_MAX_BYTES, keep: process.env.FM_HOOK_EVENT_LOG_KEEP };
  process.env.FM_HOOK_EVENT_LOG_MAX_BYTES = '1500';
  process.env.FM_HOOK_EVENT_LOG_KEEP = '1';
  try {
    const queue = join(dir, 'queue');
    for (let index = 0; index < 12; index++) {
      await observe({ harness: 'claude-code', sessionId: 's', callId: `c${index}`, rawCommand: `fm-wake-drain.sh`, cwd: dir, outcome: 'success' }, { root: queue, rules: [], env: {} });
      await handleClaudeHook({ hook_event_name: 'Stop', session_id: `s${index}` }, { root: queue, eventName: 'Stop' });
    }
    const names = await readdir(queue);
    assert.ok(names.includes('events.jsonl.1'), 'the log rolled');
    const retained = new Set<number>();
    for (const file of ['events.jsonl', 'events.jsonl.1']) {
      for (const line of (await readFile(join(queue, file), 'utf8')).trim().split('\n')) retained.add(JSON.parse(line).seq);
    }
    assert.ok(retained.size < 36 && !retained.has(1), 'the oldest log lines are gone');
    assert.equal((await readdir(join(queue, 'events'))).length, 12);
    assert.equal((await readdir(join(queue, 'wake-drain'))).length, 12);
    assert.equal((await readdir(join(queue, 'turn-end'))).length, 12);
    const firstEvent = JSON.parse(await readFile(join(queue, 'events', (await readdir(join(queue, 'events'))).sort()[0]), 'utf8'));
    assert.ok(Number.isInteger(firstEvent.seq), 'each file carries its seq, so a backfill can order without the log');
  } finally {
    for (const [key, value] of [['FM_HOOK_EVENT_LOG_MAX_BYTES', old.max], ['FM_HOOK_EVENT_LOG_KEEP', old.keep]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
