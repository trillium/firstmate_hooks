import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { main } from '../bin/fm-hooks-captain-feed.ts';
import { createFeedSyncer, parseTable, plan, renderBody, sync, audit } from '../src/captain-feed.ts';

// An in-memory fake of every store CLI plus the two Firstmate read scripts. Nothing real is touched.
function world(init: Record<string, any> = {}) {
  const state = {
    review: [{ id: 'review-a1', title: 'Pick the license', description: 'Choose A or B.\n\nSee https://example.com/doc and data/x/report.md', status: 'open', priority: 1, labels: ['human'] },
             { id: 'review-hold', title: 'Captain hold: t1 - thing', description: 'held', status: 'open', priority: 1, labels: ['human', 'fm-hold', 'fm-hold-task:t1'] }],
    task: [{ id: 'task-h1', title: 'Needs eyes', description: 'look', status: 'open', priority: 2, labels: ['human'] }],
    brain: [], status: [] as any[], stores: 'review /d/review\ntask /d/task\nbrain /d/brain\nstatus /d/status\n',
    held: [
      { id: 't1', repo: 'r', title: 'thing', hold_reason: 'covered by review-hold', priority: '-', links: '-', state: 'in_flight' },
      { id: 't2', repo: 'tldraw-deck', title: 'tldraw deck review', hold_reason: 'Review slide order; accept the license watermark. https://github.com/o/r/pull/9', priority: '1', links: 'report:data/deck/report.md', state: 'queued' },
    ],
    prs: [{ task: 'p1', kind: 'pr', url: 'https://github.com/o/r/pull/3', reason: 'PR ready for the captain', hold: 'p1', checked_at: 'now' },
          { task: 't2', kind: 'pr', url: 'https://github.com/o/r/pull/9', hold: 't2' }],
    fail: new Set<string>(), writes: [] as string[][], seq: 0, ...init,
  };
  const table = () => `count: ${state.held.length}\ntasks[${state.held.length}]{id,state,kind,repo,title,hold_kind,hold_reason,priority,links,held}:\n`
    + state.held.map(h => `  ${h.id},${h.state},ship,${h.repo},"${h.title}",captain,"${h.hold_reason.replace(/"/g, '\\"')}",${h.priority},"${h.links}",yes`).join('\n') + '\n';
  const run = (bin: string, args: string[]) => {
    const name = bin.split('/').pop()!;
    if (state.fail.has(name)) throw new Error(`${name} down`);
    if (name === 'brain' && args[0] === 'stores') return state.stores;
    if (name === 'fm-tasks-axi.sh') return table();
    if (name === 'fm-bearings-snapshot.sh') return JSON.stringify({ contributions: { captain: state.prs } });
    const rows = state[name];
    const flag = (f: string) => args[args.indexOf(f) + 1];
    if (args[0] === 'list') {
      const want = args.includes('--label') ? flag('--label') : null;
      const all = args.includes('--all');
      return JSON.stringify(rows.filter(b => (all || b.status === 'open') && (!want || b.labels.includes(want))));
    }
    state.writes.push([name, ...args]);
    if (args[0] === 'create') {
      const id = `status-${++state.seq}`;
      rows.push({ id, title: args[1], description: flag('-d'), status: 'open', priority: Number(flag('-p')), labels: flag('-l').split(',') });
      return id;
    }
    const bead = rows.find(b => b.id === args[1]);
    if (args[0] === 'close') { bead.status = 'closed'; bead.close_reason = flag('-r'); }
    else if (args[0] === 'reopen') bead.status = 'open';
    else if (args[0] === 'update') { bead.title = flag('--title'); bead.description = flag('-d'); bead.priority = Number(flag('-p')); }
    return '';
  };
  return { state, run };
}
const env = { FM_HOME: '/fm', FM_HOOK_FM_BIN_DIR: '/fmbin' };
const feedKeys = (state: any) => state.status.filter(b => b.status === 'open').flatMap(b => b.labels.filter(l => l.startsWith('source:')));

test('parseTable reads quoted cells with escapes and stops at the first non-row', () => {
  const rows = parseTable('count: 1\ntasks[1]{a,b,c}:\n  x,"he said \\"hi\\"\\nok, fine",3\nhelp[1]:\n  - nope\n');
  assert.deepEqual(rows, [{ a: 'x', b: 'he said "hi"\nok, fine', c: '3' }]);
});

test('sync creates one feed bead per source item with the schema labels and a full body', async () => {
  const { state, run } = world();
  const result = await sync({ run, env });
  assert.deepEqual(feedKeys(state).sort(), ['source:fm-hold:t2', 'source:fm-pr:p1', 'source:review-a1', 'source:review-hold', 'source:task-h1']);
  assert.equal(result.created, 5);
  const bead = state.status.find(b => b.labels.includes('source:review-a1'));
  assert.deepEqual(bead.labels, ['captain-action', 'source:review-a1', 'src-store:review']);
  assert.equal(bead.priority, 1);
  for (const part of ['Why you:', 'Ask: Choose A or B.', 'review human respond review-a1', 'Priority: P1', 'Source: review/review-a1', 'https://example.com/doc', 'data/x/report.md', 'State: open in review']) assert.ok(bead.description.includes(part), part);
  const hold = state.status.find(b => b.labels.includes('source:fm-hold:t2'));
  assert.ok(hold.description.includes('accept the license watermark') && hold.description.includes('data/deck/report.md'));
});

test('a hold already carried by its review bead, and a PR already named by its hold, are not duplicated', async () => {
  const { state, run } = world();
  await sync({ run, env });
  assert.ok(!feedKeys(state).includes('source:fm-hold:t1'));
  assert.ok(!feedKeys(state).includes('source:fm-pr:t2'));
});

test('a second sync writes nothing; a changed source updates the same bead', async () => {
  const { state, run } = world();
  await sync({ run, env });
  state.writes.length = 0;
  assert.equal((await sync({ run, env })).unchanged, 5);
  assert.deepEqual(state.writes, []);
  state.review[0].priority = 0;
  const result = await sync({ run, env });
  assert.equal(result.updated, 1);
  assert.equal(state.status.length, 5);
  assert.equal(state.status.find(b => b.labels.includes('source:review-a1')).priority, 0);
});

test('closing a source closes its feed bead with a reason, and a reopened source reopens it', async () => {
  const { state, run } = world();
  await sync({ run, env });
  state.review[0].status = 'closed';
  assert.equal((await sync({ run, env })).closed, 1);
  const bead = state.status.find(b => b.labels.includes('source:review-a1'));
  assert.equal(bead.status, 'closed');
  assert.match(bead.close_reason, /no longer needs the captain/);
  state.review[0].status = 'open';
  assert.equal((await sync({ run, env })).reopened, 1);
  assert.equal(bead.status, 'open');
  assert.equal(state.status.length, 5);
});

test('an unreadable source never closes its feed beads', async () => {
  const { state, run } = world();
  await sync({ run, env });
  state.fail.add('task');
  const result = await sync({ run, env });
  assert.deepEqual(result.failed, ['task']);
  assert.equal(result.closed, 0);
  assert.ok(feedKeys(state).includes('source:task-h1'));
  state.fail.clear(); state.fail.add('fm-tasks-axi.sh');
  assert.equal((await sync({ run, env })).closed, 0);
  assert.ok(feedKeys(state).includes('source:fm-hold:t2'));
});

test('duplicate open feed beads for one source collapse to one', async () => {
  const { state, run } = world();
  await sync({ run, env });
  const twin = { ...state.status[0], id: 'status-dup', status: 'open' };
  state.status.push(twin);
  await sync({ run, env });
  assert.equal(state.status.filter(b => b.labels.includes(twin.labels[1]) && b.status === 'open').length, 1);
});

test('maxWrites bounds one run and the remainder finishes on the next', async () => {
  const { state, run } = world();
  const first = await sync({ run, env, maxWrites: 2 });
  assert.equal(first.created, 2); assert.equal(first.deferred, 3);
  await sync({ run, env, maxWrites: 10 });
  assert.equal(feedKeys(state).length, 5);
});

test('dry run reports but writes nothing', async () => {
  const { state, run } = world();
  const result = await sync({ run, env, dryRun: true });
  assert.equal(result.created, 5);
  assert.deepEqual(state.writes, []);
});

test('audit lists missing and stale items, exits 1 on drift and 0 when in sync', async () => {
  const { state, run } = world();
  const lines: string[] = [];
  const io = { env, run, log: (m: string) => lines.push(m), error: () => {} };
  assert.equal(await main(['audit'], io), 1);
  assert.match(lines.join('\n'), /no open feed bead \(5\)[^]*review-a1/);
  await sync({ run, env });
  lines.length = 0;
  assert.equal(await main(['audit'], io), 0);
  state.review[0].status = 'closed';
  lines.length = 0;
  assert.equal(await main(['audit'], io), 1);
  assert.match(lines.join('\n'), /source has closed[^]*review-a1/);
  const result = await audit({ run, env });
  assert.equal(result.stale.length, 1);
  assert.equal(result.missing.length, 0);
});

test('audit fails when a source cannot be read, because it cannot prove the feed complete', async () => {
  const { state, run } = world();
  await sync({ run, env });
  state.fail.add('review');
  assert.equal(await main(['audit'], { env, run, log: () => {}, error: () => {} }), 1);
});

test('the CLI rejects bad usage and a missing FM_HOME', async () => {
  const errors: string[] = [];
  assert.equal(await main(['nope'], { env, error: (m: string) => errors.push(m) }), 2);
  assert.equal(await main(['sync', '--max-writes', '0'], { env, error: (m: string) => errors.push(m) }), 2);
  assert.equal(await main(['audit'], { env: {}, error: (m: string) => errors.push(m) }), 2);
});

test('the worker syncer throttles, bounds writes, and swallows failures', async () => {
  const { state, run } = world();
  let clock = 1_000_000;
  const logs: string[] = [];
  const syncer = createFeedSyncer({ env: { ...env, FM_HOOK_CAPTAIN_FEED_MAX_WRITES: '2' }, run, now: () => clock, log: (m: string) => logs.push(m) });
  assert.equal((await syncer())!.created, 2);
  assert.equal(await syncer(), null, 'throttled inside the interval');
  clock += 31_000;
  assert.equal((await syncer())!.created, 2, 'deferred work resumes after 30s');
  state.fail.add('status');
  clock += 400_000;
  assert.equal(await syncer(), null);
  assert.match(logs.join(''), /captain-feed sync failed/);
  const off = createFeedSyncer({ env: { ...env, FM_HOOK_CAPTAIN_FEED: '0' }, run });
  assert.equal(await off(), null);
});

test('renderBody and plan agree, so an unchanged item is never rewritten', () => {
  const item = { key: 'k', group: 'review', title: 't', why: 'w', ask: 'a', priority: 2, source: 'review/k', evidence: [], state: 's' };
  const feed = { id: 'f', status: 'open', key: 'k', title: 'Captain: t', body: renderBody(item), priority: 2, group: 'review' };
  assert.equal(plan([item], [feed], new Set()).unchanged, 1);
});
