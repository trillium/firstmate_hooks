import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createLockTagger, matchPane, parseLock } from '../src/lock-tag.ts';

test('parseLock accepts a lone positive integer only', () => {
  assert.equal(parseLock('26864\n'), 26864);
  for (const bad of ['', 'abc', '0', '-5', '12 34', '1.5', null, undefined]) assert.equal(parseLock(bad), null);
});

test('matchPane matches the foreground group directly', () => {
  const panes = [{ id: 'a', fgPgid: 1 }, { id: 'b', fgPgid: 26864 }, { id: 'c', fgPgid: null }];
  assert.equal(matchPane(26864, panes), 'b');
  assert.equal(matchPane(5, panes), null);
  assert.equal(matchPane(null, panes), null);
});

const fakeHerdr = groups => {
  const calls: string[][] = [];
  const run = async args => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify({ result: { panes: Object.keys(groups).map(pane_id => ({ pane_id })) } });
    if (args[1] === 'process-info') return JSON.stringify({ result: { process_info: { foreground_process_group_id: groups[args[3]] } } });
    return '{}';
  };
  return { run, writes: () => calls.filter(c => c[1] === 'report-metadata') };
};

test('tag and clear happen only when the lock content changes', async () => {
  const herdr = fakeHerdr({ p1: 100, p2: 200 });
  let content: string | null = '100\n';
  const apply = createLockTagger({ env: { FM_HOME: '/nowhere/fm_home/x' }, run: herdr.run, isAlive: () => true,
    readLock: async () => { if (content === null) throw new Error('ENOENT'); return content; }, log: () => {} });
  assert.deepEqual(await apply(), { changed: true, holder: 'p1' });
  const first = herdr.writes().length;
  assert.deepEqual(herdr.writes().at(-1), ['pane', 'report-metadata', '--source', 'fm-lock', 'p1', '--token', 'hs_lock=LOCK']);
  assert.equal((await apply()).changed, false);
  assert.equal(herdr.writes().length, first, 'steady lock issues no writes');
  content = '200\n';
  assert.equal((await apply()).holder, 'p2');
  assert.ok(herdr.writes().some(c => c[4] === 'p1' && c[5] === '--clear-token'));
  content = null;
  const before = herdr.writes().length;
  assert.deepEqual(await apply(), { changed: true, holder: null });
  assert.equal(herdr.writes().slice(before).every(c => c[5] === '--clear-token'), true);
});

test('a dead pid means no holder', async () => {
  const herdr = fakeHerdr({ p1: 100 });
  const apply = createLockTagger({ env: { FM_HOME: '/nowhere/fm_home/x' }, run: herdr.run, isAlive: () => false,
    readLock: async () => '100', log: () => {} });
  assert.equal((await apply()).holder, null);
  assert.equal(herdr.writes().some(c => c.includes('--token')), false);
});

test('herdr failure is logged once and never thrown', async () => {
  const logs: string[] = [];
  const apply = createLockTagger({ env: { FM_HOME: '/nowhere/fm_home/x' }, run: async () => { throw new Error('no herdr'); },
    isAlive: () => true, readLock: async () => '1', log: m => logs.push(m) });
  await apply();
  assert.equal(logs.length, 1);
});

test('a failed herdr apply is retried next cycle with the same lock content', async () => {
  const herdr = fakeHerdr({ p1: 100 });
  let fail = true;
  const run = async args => { if (fail) throw new Error('down'); return herdr.run(args); };
  const apply = createLockTagger({ env: { FM_HOME: '/nowhere/fm_home/x' }, run, isAlive: () => true,
    readLock: async () => '100', log: () => {} });
  await apply();
  fail = false;
  assert.deepEqual(await apply(), { changed: true, holder: 'p1' });
  assert.equal((await apply()).changed, false);
});

test('an unresolved FM_HOME logs once', async () => {
  const logs: string[] = [];
  const apply = createLockTagger({ env: {}, log: m => logs.push(m) });
  await apply(); await apply();
  assert.deepEqual(logs, ['fm-hooks lock-tag inactive: no FM_HOME']);
});
