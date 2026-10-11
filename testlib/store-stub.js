#!/usr/bin/env node
// A fake bead-store wrapper for tests. State lives in a JSON file named by STUB_DB and
// every invocation is appended to STUB_CALLS, so a test can prove which writes happened.
// It implements only the verbs fm-hooks uses: show, create, comments, list, close.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [store, ...argv] = process.argv.slice(2);
appendFileSync(process.env.STUB_CALLS, `${JSON.stringify({ store, argv })}\n`);
const db = existsSync(process.env.STUB_DB) ? JSON.parse(readFileSync(process.env.STUB_DB, 'utf8')) : {};
db[store] ??= { beads: {} };
const beads = db[store].beads;
const save = () => writeFileSync(process.env.STUB_DB, JSON.stringify(db));
const take = (flag, short) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag || argv[i] === short) out.push(argv[i + 1]);
  return out;
};
const [verb, sub] = argv;
if (process.env.STUB_FAIL === `${store}:${verb}`) { console.error('stub failure'); process.exit(1); }

if (verb === 'show') {
  if (!beads[argv[1]]) { console.error('not found'); process.exit(1); }
  console.log(JSON.stringify(beads[argv[1]]));
} else if (verb === 'create') {
  const id = take('--id')[0];
  if (beads[id]) { console.error('exists'); process.exit(1); }
  beads[id] = { id, title: take('--title')[0], labels: (take('-l', '--labels')[0] ?? '').split(',').filter(Boolean),
    description: take('-d')[0], status: 'open', comments: [], closed_at: null, updated_at: new Date().toISOString() };
  save(); console.log(id);
} else if (verb === 'comments' && sub === 'add') {
  beads[argv[2]].comments.push({ author: 'stub', text: argv[3] }); save();
} else if (verb === 'comments') {
  console.log(JSON.stringify(beads[argv[1]]?.comments ?? []));
} else if (verb === 'list') {
  const labels = take('-l', '--label');
  const status = take('--status', '-s')[0];
  const after = take('--closed-after')[0];
  const rows = Object.values(beads).filter(b => labels.every(l => b.labels.includes(l))
    && (!status || b.status === status) && (!after || (b.closed_at && b.closed_at > after)));
  console.log(JSON.stringify(rows.map(({ comments, ...rest }) => ({ ...rest, comment_count: comments.length }))));
} else if (verb === 'close') {
  beads[argv[1]].status = 'closed'; beads[argv[1]].closed_at = take('--at')[0] ?? new Date().toISOString();
  beads[argv[1]].close_reason = take('-r', '--reason')[0] ?? null; save();
} else { console.error(`stub: unsupported ${argv.join(' ')}`); process.exit(2); }
