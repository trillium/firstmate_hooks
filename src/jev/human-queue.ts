import { execFile } from 'node:child_process';

// Default human queue: one `review` bead per escalated decision. Only the prefiltered state
// goes in the bead, never the raw record. A CLI failure is `null`, not a throw.
export type HumanItem = { pack: { id: string }; state: string; jev?: any; big?: any; reason: string };

const guess = (name: string, v: any) => (v ? `${name}: ${v.choice || '(none)'} @ ${Number(v.confidence).toFixed(2)} -> ${v.verdict}${v.reason ? ` (${v.reason})` : ''}` : `${name}: not asked`);

export function humanTitle(item: HumanItem) {
  const line = item.state.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${item.pack.id} needs a call: ${line}`;
}

export function humanDescription(item: HumanItem) {
  return [`reason: ${item.reason}`, guess('jev', item.jev), guess('big', item.big), '', 'state:', item.state].join('\n');
}

export function createHumanQueue(options: { command?: string; timeoutMs?: number } = {}) {
  const command = options.command ?? 'review';
  return (item: HumanItem): Promise<{ id: string } | null> => new Promise(resolve => {
    try {
      execFile(command, ['create', humanTitle(item), '--description', humanDescription(item), '--silent'], { timeout: options.timeoutMs ?? 30_000 }, (error, stdout) => {
        const id = String(stdout ?? '').trim().split('\n').pop()?.trim();
        resolve(error || !id ? null : { id });
      });
    } catch { resolve(null); }
  });
}

export const defaultHumanQueue = createHumanQueue();
