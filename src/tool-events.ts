import { correlationId } from './normalize.ts';
import { persistEvent } from './queue.ts';
import { scrubText } from './scrub.ts';

// State-changing tools that are not Firstmate calls but are still actions a firstmate takes:
// a file written or edited, a sub-agent started, a message sent. They are recorded as the
// same `event` shape as an `fm-*` call, with the operation `tool:<Name>`, and never with
// what they wrote, edited, asked or said: only which file, which agent, which recipient.
//
// They are persisted and logged but not evaluated against the rules. A rule with
// `operation: "*"` means any recognized Firstmate call, and a file edit is not one, so
// routing these through the rules engine would start ledgering every edit.

export const TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit', 'Agent', 'SendMessage']);
const TEXT_CAP = 400;

// One line saying what the call did, from fields that name a target and never its content.
export function describeTool(tool: string, input: Record<string, any> | null | undefined): string {
  const field = (name: string) => (typeof input?.[name] === 'string' ? input[name].trim() : '');
  let detail = '';
  if (tool === 'Write' || tool === 'Edit') detail = field('file_path');
  else if (tool === 'NotebookEdit') detail = field('notebook_path');
  else if (tool === 'SendMessage') detail = field('to');
  else if (tool === 'Agent') {
    const kind = field('subagent_type'), what = field('description');
    detail = [kind, what].filter(Boolean).join(': ');
  }
  return scrubText(detail ? `${tool} ${detail}` : tool, TEXT_CAP);
}

export async function observeToolCall({ tool, input, outcome, sessionId, callId, cwd, startedAt = null, durationMs = null,
  finishedAt = new Date().toISOString(), eventName }: Record<string, any>, root?: string) {
  const rawCommand = describeTool(tool, input);
  const event = {
    operation: `tool:${tool}`,
    args: [],
    rawCommand,
    cwd: cwd ?? null,
    project: null,
    harness: 'claude-code',
    sessionId: sessionId ?? null,
    callId: callId ?? null,
    correlationId: correlationId({ harness: 'claude-code', sessionId, callId, rawCommand }),
    outcome,
    exitCode: null,
    startedAt,
    finishedAt,
    durationMs,
    resultMetadata: null,
    source: { eventName, tool },
  };
  await persistEvent(event, root);
  return event;
}
