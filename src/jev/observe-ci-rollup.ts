import { ciRollupPack } from './questions/v1.ts';
import { tokenize } from './observe-store-route.ts';

// CI-rollup observation point (shadow only). A worker reads PR checks through `gh-axi pr view`
// or `gh-axi pr checks`; the Claude hook has the Bash command and `tool_response` (an object
// carrying `stdout`, or the text itself). When the response carries a checks summary or
// per-check lines, the text is queued for Jev (pending.ts, drained by the poller; see the
// store-route module header for why the hook never waits). `existing` is derived here, in code,
// from the summary: fail if any failed, else pending if any pending/queued, else pass. Jev's
// answer lands in the eval log and nothing reads it. There is no CI polling path of our own.

export { ciRollupPack };

export const responseText = (response: unknown): string => {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    return [r.stdout, r.output, r.content].filter(v => typeof v === 'string').join('\n');
  }
  return '';
};

const SUMMARY = /\bchecks:\s*"?\s*([^\n"]*\d+\s+(?:passed|failed|pending|queued|total)[^\n"]*)"?/i;
const COUNT = /(\d+)\s+(passed|failed|pending|queued|in[ _]progress|total)/gi;
const LINE = /^\s*(?:[-*]\s*)?(?:[✓✔✗✖X*]\s+)?([^\n:]*?)\s*[:\t]\s*(success|successful|passed|pass|failure|failed|fail|error|timed_out|pending|queued|in_progress|in progress|waiting)\s*$/i;

// Pure. `{ existing, text }` for a `gh-axi pr view|checks` command whose response carries a
// checks summary or per-check lines, else null (a view with no checks line, another command).
export function ciRollupOf(command: unknown, response: unknown): { existing: 'pass' | 'fail' | 'pending'; text: string } | null {
  if (typeof command !== 'string') return null;
  const tokens = tokenize(command.trim());
  if (tokens[0] !== 'gh-axi' || tokens[1] !== 'pr' || !['view', 'checks'].includes(tokens[2])) return null;
  const text = responseText(response);
  if (!text.trim()) return null;
  let failed = 0, pending = 0, seen = false;
  const summary = SUMMARY.exec(text);
  if (summary) {
    seen = true;
    for (const [, n, word] of summary[1].matchAll(COUNT)) {
      const w = word.toLowerCase();
      if (w === 'failed') failed += Number(n);
      else if (w === 'pending' || w === 'queued' || w.startsWith('in')) pending += Number(n);
    }
  } else {
    for (const line of text.split('\n')) {
      const m = LINE.exec(line);
      if (!m) continue;
      seen = true;
      const v = m[2].toLowerCase();
      if (/^(failure|failed|fail|error|timed_out)$/.test(v)) failed++;
      else if (/^(pending|queued|in_progress|in progress|waiting)$/.test(v)) pending++;
    }
  }
  if (!seen) return null;
  return { existing: failed ? 'fail' : pending ? 'pending' : 'pass', text };
}

export function ciRollupObservation(command: unknown, response: unknown) {
  const rollup = ciRollupOf(command, response);
  return rollup ? { pack: ciRollupPack.id, existing: rollup.existing, raw: rollup.text } : null;
}
