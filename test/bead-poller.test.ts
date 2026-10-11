import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pollOnce, pollerStatus, watchPoller, readCursor, firstmateRelay } from '../src/bead-poller.ts';
import { withStubs } from '../testlib/stub-env.ts';

const seed = (env, store, bead) => (async () => {
  let db = {};
  try { db = JSON.parse(await readFile(env.STUB_DB, 'utf8')); } catch { /* new */ }
  db[store] ??= { beads: {} };
  db[store].beads[bead.id] = { labels: [], comments: [], status: 'open', closed_at: null, ...bead };
  await writeFile(env.STUB_DB, JSON.stringify(db));
})();
const recorder = () => { const sent = []; return { sent, relay: async c => { sent.push(c); return { via: c.key ? 'send' : 'note' }; } }; };
const root = env => env.FM_HOOK_QUEUE;
const T0 = Date.parse('2026-10-10T12:00:00Z');

test('first poll initializes the cursor and relays nothing, even with old closures present', async () => withStubs(async ({ env }) => {
  await seed(env, 'review', { id: 'review-old', title: 'old', status: 'closed', closed_at: '2026-01-01T00:00:00Z' });
  const { sent, relay } = recorder();
  const result = await pollOnce({ root: root(env), env, relay, now: T0 });
  assert.equal(result.initialized, true);
  assert.deepEqual(sent, []);
  assert.equal((await readCursor(root(env))).since, '2026-10-10T12:00:00.000Z');
}));

test('a bead closed minutes before the poller first started is not backfilled', async () => withStubs(async ({ env }) => {
  const { sent, relay } = recorder();
  await seed(env, 'review', { id: 'review-recent', title: 'recent', status: 'closed', closed_at: '2026-10-10T11:58:00Z' });
  await pollOnce({ root: root(env), env, relay, now: T0 });
  const second = await pollOnce({ root: root(env), env, relay, now: T0 + 30000 });
  assert.equal(second.relayed.length, 0);
  assert.deepEqual(sent, []);
}));

test('a closed review bead is relayed once as a note, however many polls see it', async () => withStubs(async ({ env }) => {
  const { sent, relay } = recorder();
  await pollOnce({ root: root(env), env, relay, now: T0 });
  await seed(env, 'review', { id: 'review-a', title: 'Ship it?', status: 'closed', closed_at: '2026-10-10T12:01:00Z',
    comments: [{ text: 'yes, ship' }] });
  const first = await pollOnce({ root: root(env), env, relay, now: T0 + 120000 });
  const second = await pollOnce({ root: root(env), env, relay, now: T0 + 180000 });
  assert.equal(first.relayed.length, 1);
  assert.equal(second.relayed.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Captain closed review bead review-a \(Ship it\?\): yes, ship/);
  assert.equal(sent[0].task, null);
  assert.match(sent[0].requestId, /^bead-review-a-[0-9a-f]{10}$/);
}));

test('a captain-hold answer carries the task and key so it can be sent with --resolve-key', async () => withStubs(async ({ env }) => {
  const { sent, relay } = recorder();
  await pollOnce({ root: root(env), env, relay, now: T0 });
  await seed(env, 'review', { id: 'review-h', title: 'Captain hold: t - db', status: 'closed', closed_at: '2026-10-10T12:02:00Z',
    labels: ['human', 'fm-task:t', 'fm-key:captain-hold-t-1'], close_reason: 'use sqlite' });
  await pollOnce({ root: root(env), env, relay, now: T0 + 180000 });
  assert.equal(sent[0].task, 't');
  assert.equal(sent[0].key, 'captain-hold-t-1');
  assert.match(sent[0].text, /use sqlite/);
}));

test('non-review stores relay only human-labelled closures', async () => withStubs(async ({ env }) => {
  const { sent, relay } = recorder();
  await pollOnce({ root: root(env), env, relay, now: T0 });
  await seed(env, 'task', { id: 'task-x', title: 'plain', status: 'closed', closed_at: '2026-10-10T12:01:00Z' });
  await seed(env, 'task', { id: 'task-y', title: 'asked', status: 'closed', closed_at: '2026-10-10T12:01:00Z', labels: ['human'] });
  await pollOnce({ root: root(env), env, relay, now: T0 + 120000 });
  assert.deepEqual(sent.map(s => s.text.match(/task-[xy]/)[0]), ['task-y']);
}));

test('at-least-once: a failed relay is retried next poll and the cursor does not pass it', async () => withStubs(async ({ env }) => {
  await pollOnce({ root: root(env), env, relay: recorder().relay, now: T0 });
  await seed(env, 'review', { id: 'review-f', title: 'x', status: 'closed', closed_at: '2026-10-10T12:01:00Z' });
  let attempts = 0;
  const flaky = async () => { attempts += 1; if (attempts === 1) throw new Error('fm down'); return { via: 'note' }; };
  const bad = await pollOnce({ root: root(env), env, relay: flaky, now: T0 + 120000 });
  assert.equal(bad.failed.length, 1);
  assert.ok(Date.parse((await readCursor(root(env))).since) <= Date.parse('2026-10-10T12:01:00Z'), 'cursor held at the failed bead');
  const good = await pollOnce({ root: root(env), env, relay: flaky, now: T0 + 180000 });
  assert.equal(good.relayed.length, 1);
  assert.equal(attempts, 2);
  const after = await pollOnce({ root: root(env), env, relay: flaky, now: T0 + 240000 });
  assert.equal(after.relayed.length, 0);
  assert.equal(attempts, 2, 'a relayed bead is never sent again');
}));

test('one failing bead does not block its siblings, and is retried alone', async () => withStubs(async ({ env }) => {
  await pollOnce({ root: root(env), env, relay: recorder().relay, now: T0 });
  await seed(env, 'review', { id: 'review-1', title: 'a', status: 'closed', closed_at: '2026-10-10T12:01:00Z' });
  await seed(env, 'review', { id: 'review-2', title: 'b', status: 'closed', closed_at: '2026-10-10T12:02:00Z' });
  const seen = [];
  const relay = async c => { seen.push(c.text.match(/review-\d/)[0]); if (c.text.includes('review-1') && seen.length === 1) throw new Error('boom'); return { via: 'note' }; };
  await pollOnce({ root: root(env), env, relay, now: T0 + 120000 });
  await pollOnce({ root: root(env), env, relay, now: T0 + 180000 });
  assert.deepEqual(seen, ['review-1', 'review-2', 'review-1']);
}));

test('the real relay calls fm-send --resolve-key for holds, fm-inbox note otherwise, and falls back to a note', async () => withStubs(async ({ dir, env }) => {
  const bin = join(dir, 'fmbin');
  await mkdir(bin, { recursive: true });
  const log = join(dir, 'fm.log');
  for (const name of ['fm-send.sh', 'fm-inbox.sh']) {
    await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s ' "${name}" "$@" >> "${log}"; echo >> "${log}"\n[ "${name}" = fm-send.sh ] && [ -n "$FAIL_SEND" ] && exit 1\nexit 0\n`, { mode: 0o755 });
  }
  const relay = firstmateRelay({ ...env });
  assert.deepEqual(await relay({ task: 't', key: 'k-1', requestId: 'r1', text: 'go' }), { via: 'send' });
  assert.deepEqual(await relay({ task: null, key: null, requestId: 'r2', text: 'fyi' }), { via: 'note' });
  const failing = firstmateRelay({ ...env, FAIL_SEND: '1' });
  assert.deepEqual(await failing({ task: 't', key: 'k-2', requestId: 'r3', text: 'again' }), { via: 'note-fallback' });
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  assert.match(lines[0], /^fm-send\.sh t --resolve-key k-1 go/);
  assert.match(lines[1], /^fm-inbox\.sh note --request-id r2 -- fyi/);
  assert.match(lines[3], /^fm-inbox\.sh note --request-id r3 -- again/);
}));

test('watch writes a heartbeat that status reads as alive, then stale', async () => withStubs(async ({ env }) => {
  assert.equal((await pollerStatus({ root: root(env) })).present, false);
  const { relay } = recorder();
  const state = await watchPoller({ root: root(env), env, relay, intervalMs: 5, maxCycles: 2, onResult() {} });
  assert.equal(state.cycles, 2);
  const status = await pollerStatus({ root: root(env) });
  assert.equal(status.alive, true);
  const stale = await pollerStatus({ root: root(env), now: Date.now() + 10 * 60 * 1000 });
  assert.equal(stale.alive, false);
  assert.match(stale.reason, /stale/);
}));

test('a bead fm-hooks closed itself after a hold answer is neither relayed nor failed; without the label it still is', async () => withStubs(async ({ env }) => {
  const { sent, relay } = recorder();
  await pollOnce({ root: root(env), env, relay, now: T0 });
  await seed(env, 'review', { id: 'review-guarded', title: 'hold', status: 'closed', closed_at: '2026-10-10T12:01:00Z',
    labels: ['fm-task:t', 'fm-key:k', 'fm-closed-by:fm-hooks'] });
  await seed(env, 'review', { id: 'review-human', title: 'hold', status: 'closed', closed_at: '2026-10-10T12:01:30Z',
    labels: ['fm-task:t', 'fm-key:k2'] });
  const result = await pollOnce({ root: root(env), env, relay, now: T0 + 120000 });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(sent.map(s => s.key), ['k2']);
}));
