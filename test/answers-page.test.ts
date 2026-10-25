import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAP, main } from '../bin/fm-hooks-answers-page.ts';

const reviews = [
  { id: 'review-old', title: 'Old call', created_at: '2026-10-01T10:00:00Z', status: 'closed', labels: ['human'], description: 'Pick A or B?', comment_count: 2 },
  { id: 'review-open', title: 'Open call', created_at: '2026-10-20T09:00:00Z', status: 'open', labels: ['human'], description: 'Merge it?', comment_count: 0 },
  { id: 'review-skip', title: 'Not a captain call', created_at: '2026-10-20T08:00:00Z', status: 'open', labels: ['other'], description: 'x', comment_count: 0 },
];
const reviewComments = { 'review-old': [{ text: 'A please', author: 'captain' }, { text: 'Done, went with A', author: 'fm' }] };
const kvo = [{ id: 'c1', text: 'Captain asked about X. Answer: do Y.', created_at: '2026-10-20T12:00:00Z' }];
const receipts = (n: number) => ({ schema: 'fm-inbox-receipts.v1', handled: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T0${i % 10}:00:00Z`, body: `note ${i} <b>`, reply: i === 0 ? { body: 'replied' } : null })) });

const runner = (calls: string[][], inbox = receipts(2)) => (bin: string, args: string[]) => {
  calls.push([bin, ...args]);
  const name = bin.split('/').pop();
  if (name === 'review') return JSON.stringify(args[0] === 'list' ? reviews : args[0] === 'show' ? [reviews.find(r => r.id === args[1])] : reviewComments[args[1]] ?? []);
  if (name === 'status') return JSON.stringify(args[0] === 'show' ? [{ id: 'status-kvo', comment_count: 1 }] : kvo);
  if (name === 'fm-inbox.sh') return JSON.stringify(inbox);
  throw new Error(`unexpected ${bin}`);
};
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-answers-'));
  const index = join(dir, 'index.html');
  await writeFile(index, '<!doctype html><title>Captain\'s pages</title>\n<h1>Captain\'s pages</h1>\n<a class="p" href="x.html"><b>X</b></a>\n');
  return { dir, index, out: join(dir, 'answers.html') };
};
const quiet = { log: () => {}, error: () => {} };

test('renders all three sources, open review items as Open, and orders newest first', async () => {
  const { dir, out } = await setup();
  const calls: string[][] = [];
  assert.equal(await main(['--out', out, '--home', dir], { ...quiet, env: {}, run: runner(calls) }), 0);
  const html = await readFile(out, 'utf8');
  assert.match(html, /<title>Answers<\/title>/);
  assert.match(html, /data-src="review" data-state="open"[^]*Open call/);
  assert.ok(!html.includes('Not a captain call'));
  assert.match(html, /Done, went with A/);
  assert.match(html, /No reply recorded/);
  assert.match(html, /note 1 &lt;b&gt;/);
  assert.ok(html.indexOf('review-open') < html.indexOf('c1') && html.indexOf('c1') < html.indexOf('review-old'), 'newest day first');
  assert.ok(calls.some(c => c.join(' ').endsWith('receipts --all-handled --all-replies')));
});

test('an open review item leads the other entries of its day', async () => {
  const { dir, out } = await setup();
  await main(['--out', out, '--home', dir], { ...quiet, env: {}, run: runner([]) });
  const html = await readFile(out, 'utf8');
  assert.ok(html.indexOf('review-open') < html.indexOf('<small>c1<'), 'open review leads its day despite being older');
});

test('caps at the newest entries and says so', async () => {
  const { dir, out } = await setup();
  assert.equal(await main(['--out', out, '--home', dir], { ...quiet, env: {}, run: runner([], receipts(300)) }), 0);
  const html = await readFile(out, 'utf8');
  assert.equal((html.match(/class="c"/g) ?? []).length, CAP);
  assert.match(html, new RegExp(`newest ${CAP} of 303`));
  assert.ok(html.length < 1_000_000);
});

test('the index card is inserted once, as the first card, and never again', async () => {
  const { dir, out, index } = await setup();
  const opts = { ...quiet, env: {}, run: runner([]), now: () => new Date('2026-10-25T12:00:00Z') };
  await main(['--out', out, '--home', dir, '--index', index], opts);
  const first = await readFile(index, 'utf8');
  assert.match(first, /<\/h1>\n<a class="p" href="answers.html"><i>10-25<\/i><b>Answers<\/b><span>What you asked, what I answered.<\/span><\/a>\n<a class="p" href="x.html">/);
  await main(['--out', out, '--home', dir, '--index', index], opts);
  assert.equal(await readFile(index, 'utf8'), first);
  assert.equal(first.match(/answers\.html/g)?.length, 1);
});

test('refuses without a home, and fails plainly when a CLI fails without echoing its output', async () => {
  const { dir, out } = await setup();
  const errors: string[] = [];
  assert.equal(await main(['--out', out], { log: () => {}, error: (m: string) => errors.push(m), env: {}, run: runner([]) }), 2);
  const bad = () => { const e: any = new Error('SECRET BODY'); e.stderr = 'SECRET BODY'; throw e; };
  assert.equal(await main(['--out', out, '--home', dir], { log: () => {}, error: (m: string) => errors.push(m), env: {}, run: bad }), 1);
  assert.ok(!errors.join('\n').includes('SECRET'));
});

test('a missing store CLI exits non-zero with a plain message', async () => {
  const { dir, out } = await setup();
  const errors: string[] = [];
  const code = await main(['--out', out, '--home', dir], { log: () => {}, error: (m: string) => errors.push(m), env: { FM_HOOK_REVIEW_BIN: join(dir, 'nope') } });
  assert.equal(code, 1);
  assert.match(errors.join(''), /command not found/);
});
