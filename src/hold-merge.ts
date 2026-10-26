import { commentTexts, recordedHoldReason, unexpanded, clip } from './bead-actions.ts';

// One-time clean-up of `review` hold beads minted before captainHold deduplicated them.
// Dry-run unless `apply` is true.
//   duplicates: a task with more than one open hold bead keeps the oldest; comments the
//     others hold that it lacks (matched by `[cid:...]` marker, else exact text) are copied
//     across, then each newer bead gets a pointer comment and is closed "duplicate of <id>".
//   titles: an open hold bead whose title still carries an unexpanded shell expression gets
//     the reason recorded on the task (fm-tasks-axi show --full) as its title.

const HOLD_TASK = 'fm-hold-task:';
const cidOf = text => /\[cid:[0-9a-f]+\]/.exec(text)?.[0] ?? null;
const openHolds = run => JSON.parse(run('review', ['list', '--all', '-l', 'fm-hold', '--json', '-n', '0']) || '[]')
  .filter(bead => bead.status !== 'closed');
const taskOf = bead => (bead.labels ?? []).find(l => l.startsWith(HOLD_TASK))?.slice(HOLD_TASK.length) ?? null;
const byAge = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id));

export async function mergeDuplicateHolds(run, { apply = false, env = process.env, reasonOf = recordedHoldReason }: Record<string, any> = {}) {
  const report = [];
  const holds = openHolds(run);
  const tasks = new Map();
  for (const bead of holds) {
    const task = taskOf(bead);
    if (task) tasks.set(task, [...(tasks.get(task) ?? []), bead]);
  }
  const closed = new Set();
  for (const [task, beads] of tasks) {
    if (beads.length < 2) continue;
    const [keep, ...rest] = beads.sort(byAge);
    const have = commentTexts(run, 'review', keep.id);
    const seen = new Set(have);
    const tags = new Set(have.map(cidOf).filter(Boolean));
    for (const dup of rest) {
      const missing = commentTexts(run, 'review', dup.id).filter(text => !seen.has(text) && !(cidOf(text) && tags.has(cidOf(text))));
      report.push({ kind: 'duplicate', task, keep: keep.id, duplicate: dup.id, comments: missing.length, action: apply ? 'merged' : 'would-merge' });
      if (apply) {
        for (const text of missing) {
          run('review', ['comments', 'add', keep.id, text]);
          seen.add(text); if (cidOf(text)) tags.add(cidOf(text));
        }
        run('review', ['comments', 'add', keep.id, `fm-hooks: duplicate hold ${dup.id} merged here`]);
        run('review', ['comments', 'add', dup.id, `fm-hooks: duplicate of ${keep.id}; its comments were copied there`]);
        run('review', ['close', dup.id, '-r', `duplicate of ${keep.id}`]);
      }
      closed.add(dup.id);
    }
  }
  for (const bead of holds) {
    if (closed.has(bead.id) || !/\$[A-Za-z_{(]|`/.test(String(bead.title ?? ''))) continue;
    const task = taskOf(bead);
    const reason = task ? reasonOf(task, env, {}) : null;
    if (!reason) { report.push({ kind: 'title', bead: bead.id, task, title: bead.title, action: 'unresolved' }); continue; }
    const title = `Captain hold: ${task} - ${clip(reason, 100)}`;
    report.push({ kind: 'title', bead: bead.id, task, title: bead.title, fix: title, action: apply ? 'retitled' : 'would-retitle' });
    if (apply) run('review', ['update', bead.id, '--title', title]);
  }
  return report;
}
