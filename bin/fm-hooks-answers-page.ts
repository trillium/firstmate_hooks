#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// One static "Answers" page: what the captain asked, what he got back, newest first.
//   fm-hooks-answers-page --out <file> [--home <FM_HOME>] [--index <index.html>]
// Reads three sources through their CLIs only (never Dolt or sqlite): the `review` store,
// the `status-kvo` comments, and `fm-inbox.sh receipts`. Writes nothing but --out and, once, --index.

export const CAP = 200;
const CLIP = 1500;
const INDEX_CARD = (mmdd: string) => `<a class="p" href="answers.html"><i>${mmdd}</i><b>Answers</b><span>What you asked, what I answered.</span></a>`;

class Failure extends Error {}

// run(bin, args, env) -> stdout. Injectable so tests never touch a live store.
export function cliRunner(env = process.env) {
  return (bin: string, args: string[], extra: Record<string, string> = {}) => {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    } catch (failure) {
      // Never surface stderr or output: it can carry bead bodies.
      const name = bin.split('/').pop();
      throw new Failure(failure.code === 'ENOENT' ? `${name}: command not found` : `${name} ${args[0]} failed (exit ${failure.status ?? 'unknown'})`);
    }
  };
}

const json = (out: string, what: string) => {
  try { return JSON.parse(out); } catch { throw new Failure(`${what}: output was not JSON`); }
};
const one = (value: any) => (Array.isArray(value) ? value[0] : value) ?? {};
const clip = (value: any, max = CLIP) => (String(value ?? '').length > max ? `${String(value).slice(0, max - 1)}…` : String(value ?? ''));
const commentText = (c: any) => String(c?.text ?? c?.body ?? '');

// `show --json` carries comments on some bd versions and not on others; fall back to `comments`.
function bead(run, bin: string, id: string) {
  const shown = one(json(run(bin, ['show', id, '--json']), `${bin} show`));
  let comments = shown.comments;
  if (!Array.isArray(comments)) comments = Number(shown.comment_count ?? 1) === 0 ? [] : json(run(bin, ['comments', id, '--json']), `${bin} comments`);
  return { shown, comments: comments as any[] };
}

export type Entry = { source: 'review' | 'status-kvo' | 'inbox'; id: string; at: string; title: string; request: string; answer: string; state: 'open' | 'answered'; detail: string };

function reviewEntries(run, env): Entry[] {
  const bin = env.FM_HOOK_REVIEW_BIN || 'review';
  const list = json(run(bin, ['list', '--json', '--all', '--limit', '0', '--label', 'human']), 'review list');
  return list.filter(item => (item.labels ?? ['human']).includes('human')).map(item => {
    const { shown, comments } = bead(run, bin, item.id);
    const open = (shown.status ?? item.status) !== 'closed';
    const latest = comments.length ? commentText(comments[comments.length - 1]) : '';
    const closeReason = shown.close_reason ?? item.close_reason ?? '';
    return {
      source: 'review', id: item.id, at: String(item.created_at ?? shown.created_at ?? ''),
      title: String(item.title ?? shown.title ?? item.id),
      request: clip(shown.description ?? item.description ?? ''),
      answer: open ? '' : clip(latest || closeReason),
      state: open ? 'open' : 'answered',
      detail: open ? 'Open' : 'Closed',
    } as Entry;
  });
}

function statusEntries(run, env): Entry[] {
  const bin = env.FM_HOOK_STATUS_BIN || 'status';
  const { comments } = bead(run, bin, 'status-kvo');
  return comments.map((c, i) => {
    const text = commentText(c).trim();
    const cut = text.search(/(?<=[.?!])\s/);
    const head = cut > 0 && cut < 240 ? text.slice(0, cut) : text.slice(0, 200);
    const rest = text.slice(head.length).trim();
    return { source: 'status-kvo', id: String(c.id ?? `status-kvo#${i}`), at: String(c.created_at ?? ''), title: clip(head, 90),
      request: clip(head), answer: clip(rest || text), state: 'answered', detail: 'Logged' } as Entry;
  });
}

function inboxEntries(run, home: string): Entry[] {
  const script = join(home, 'bin', 'fm-inbox.sh');
  const out = json(run(script, ['receipts', '--all-handled', '--all-replies'], { FM_HOME: home }), 'fm-inbox receipts');
  if (out.schema !== 'fm-inbox-receipts.v1') throw new Failure('fm-inbox receipts: unexpected schema');
  return (out.handled ?? []).map(note => {
    const reply = note.reply ? commentText(note.reply) || String(note.reply) : '';
    return { source: 'inbox', id: String(note.id), at: String(note.at ?? ''), title: clip(String(note.body ?? '').split('\n')[0], 90),
      request: clip(note.body), answer: clip(reply), state: reply ? 'answered' : 'open', detail: reply ? 'Replied' : 'No reply recorded' } as Entry;
  });
}

// Newest day first; inside one day open review items lead, then newest time first.
export function order(entries: Entry[]): Entry[] {
  const day = (e: Entry) => e.at.slice(0, 10);
  const lead = (e: Entry) => (e.source === 'review' && e.state === 'open' ? 0 : 1);
  return [...entries].sort((a, b) => day(b).localeCompare(day(a)) || lead(a) - lead(b) || b.at.localeCompare(a.at));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function render(all: Entry[], cap = CAP): string {
  const sorted = order(all);
  const shown = sorted.slice(0, cap);
  const note = sorted.length > cap ? `<p class="note">Showing the newest ${cap} of ${sorted.length} entries.</p>` : '';
  const cards = shown.map(e => {
    const label = e.state === 'open' ? 'Open' : 'Answered';
    return `<div class="c" data-src="${e.source}" data-state="${e.state}"><i>${esc(e.at.slice(0, 10))}</i><em>${e.source}</em> <strong class="${e.state}">${esc(e.detail === label ? label : `${label} · ${e.detail}`)}</strong>`
      + `<b>${esc(e.title)}</b><p>${esc(e.request).replace(/\n/g, '<br>')}</p>`
      + (e.answer ? `<p class="a">${esc(e.answer).replace(/\n/g, '<br>')}</p>` : '')
      + `<small>${esc(e.id)}</small></div>`;
  }).join('\n');
  const filters = ['all', 'open', 'answered', 'review', 'status-kvo', 'inbox'].map(f => `<button data-f="${f}"${f === 'all' ? ' class="on"' : ''}>${f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}</button>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Answers</title>
<style>:root{--bg:#f6f7f9;--fg:#1b1f27;--card:#fff;--line:#dde1e8;--mute:#5d6572}@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e8ebf0;--card:#1b2029;--line:#2d3440;--mute:#9aa4b2}}
body{background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,sans-serif;margin:0 auto;max-width:640px;padding:20px 16px}h1{font-size:1.5rem}
.c{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px;position:relative;overflow-wrap:anywhere}.c b{display:block;font-size:1.1rem}.c p{margin:.4rem 0}.c .a{border-left:3px solid var(--line);padding-left:10px}.c small,.c em,.note{color:var(--mute);font-size:.8rem}.c i{position:absolute;top:16px;right:16px;color:var(--mute);font-size:.8rem;font-style:normal}.c em{font-style:normal;border:1px solid var(--line);border-radius:6px;padding:0 6px}.c strong{font-size:.8rem}.open{color:#b45309}#f button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin:0 6px 8px 0;font:inherit;font-size:.9rem}#f button.on{border-color:var(--fg)}</style>
<h1>Answers</h1>
<div id="f">${filters}</div>
${note}
${cards}
<script>var f='all';function go(){document.querySelectorAll('.c').forEach(function(c){c.hidden=!(f=='all'||c.dataset.src==f||c.dataset.state==f)});document.querySelectorAll('#f button').forEach(function(b){b.className=b.dataset.f==f?'on':''})}document.getElementById('f').onclick=function(e){if(e.target.dataset.f){f=e.target.dataset.f;go()}}</script>
`;
}

// Idempotent: a card linking answers.html anywhere means leave the index alone.
export function insertCard(html: string, mmdd: string): string | null {
  if (/href=["']answers\.html["']/.test(html)) return null;
  const match = /<\/h1>/i.exec(html);
  if (!match) throw new Failure('index has no <h1> to insert after');
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}\n${INDEX_CARD(mmdd)}${html.slice(at)}`;
}

async function writeAtomic(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function main(argv: string[], { log = console.log, error = console.error, env = process.env, run = cliRunner(env), now = () => new Date() }: Record<string, any> = {}) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--out', '--home', '--index'].includes(key) || argv[i + 1] === undefined) { error('usage: fm-hooks-answers-page --out <file> [--home <FM_HOME>] [--index <index.html>]'); return 2; }
    opts[key.slice(2)] = argv[i + 1];
  }
  if (!opts.out) { error('usage: fm-hooks-answers-page --out <file> [--home <FM_HOME>] [--index <index.html>]'); return 2; }
  const home = opts.home || env.FM_HOME;
  if (!home) { error('fm-hooks-answers-page: no home: pass --home or set FM_HOME'); return 2; }
  try {
    const entries = [...reviewEntries(run, env), ...statusEntries(run, env), ...inboxEntries(run, resolve(home))];
    await writeAtomic(resolve(opts.out), render(entries));
    log(`wrote ${opts.out} (${Math.min(entries.length, CAP)} of ${entries.length} entries)`);
    if (opts.index) {
      const current = await readFile(resolve(opts.index), 'utf8');
      const date = now().toISOString();
      const next = insertCard(current, date.slice(5, 10));
      if (next !== null) { await writeAtomic(resolve(opts.index), next); log(`added Answers card to ${opts.index}`); }
    }
    return 0;
  } catch (failure) {
    error(`fm-hooks-answers-page: ${failure instanceof Failure ? failure.message : failure.code === 'ENOENT' ? 'file not found' : 'failed'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
