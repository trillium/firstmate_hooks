import { createHash } from 'node:crypto';
import { persistRecord } from './queue.ts';
import { scrubText } from './scrub.ts';

// The wake text the Stop hook printed. A drain's rows only echo the reason for a wake; the
// reason line itself, in the words the firstmate was shown, is in the prompt the harness
// delivered to open the handling turn. The Stop hook that closes that turn can read it
// from the transcript, so it is recorded then, with the time the harness delivered it.
//
// A wake arrives as a queued task notification, not a typed prompt, so UserPromptSubmit is
// not relied upon: the transcript is where the delivered text is known to be.

export const WAKE_BODY_CAP = 1000;

// `<task-notification>` wrapping a Stop-hook blocking error from the firstmate watcher.
export function isWakePrompt(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith('<task-notification>')
    && /Stop hook/.test(text) && /watcher wake/i.test(text);
}

const stripTags = (text: string) => text.replace(/<\/?(?:task-notification|system-reminder|summary)>/g, '').replace(/^\s+|\s+$/g, '');

export function buildWakeNotice({ harness, sessionId, turnId, opening }: Record<string, any>) {
  const delivered = Date.parse(opening.timestamp);
  const stamp = Number.isFinite(delivered) ? new Date(delivered).toISOString() : new Date().toISOString();
  // One notice per delivered prompt: the transcript entry's own id when it has one, so two
  // wakes with identical text are two notices and one wake seen by two Stops is one.
  const identity = opening.uuid || opening.timestamp || opening.text;
  return {
    type: 'wake-notice',
    harness,
    sessionId,
    noticeId: createHash('sha256').update(['wake-notice', sessionId, identity].join('\0')).digest('hex'),
    turnId,
    finishedAt: stamp,
    body: scrubText(stripTags(opening.text), WAKE_BODY_CAP, { keepNewlines: true }),
    source: 'transcript',
  };
}

export const recordWakeNotice = (record, root?: string, hint: Record<string, any> = {}) =>
  persistRecord('wake-notice', record.noticeId, record, root, hint, { logRepeats: false });
