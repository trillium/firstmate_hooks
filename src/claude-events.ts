import { parseSemanticCommand } from './normalize.ts';
import { observe } from './observer.ts';
import { appendEventLog } from './queue.ts';
import { turnEndFromClaudeStop } from './turn-end.ts';

// One Claude Code hook delivery. The hook process reads the payload from stdin and hands it
// here; every path is observation only and returns normally, whatever it finds.
export async function handleClaudeHook(event, { eventName = event?.hook_event_name || '', root }: Record<string, any> = {}) {
  if (eventName === 'Stop') { await turnEndFromClaudeStop(event, root); return; }

  const tool = event.tool_name || event.toolName;
  if (tool !== 'Bash' || !['PostToolUse', 'PostToolUseFailure'].includes(eventName)) return;
  const command = event.tool_input?.command;
  if (typeof command !== 'string') return;
  if (!parseSemanticCommand(command).length) {
    await appendEventLog({ type: 'seen', matched: false, harness: 'claude-code', tool, rawCommand: command,
      sessionId: event.session_id ?? null, callId: event.tool_use_id ?? null }, root, { cwd: event.cwd, rawCommand: command });
    return;
  }
  const finishedAt = new Date().toISOString();
  const response = event.tool_response ?? event.error ?? null;
  const outcome = eventName === 'PostToolUseFailure' ? 'failure' : 'success';
  const exitCode = Number.isInteger(response?.exit_code) ? response.exit_code :
    Number.isInteger(response?.exitCode) ? response.exitCode : null;
  const resultMetadata = response && typeof response === 'object' ? response : { response };
  await observe({ harness: 'claude-code', sessionId: event.session_id, callId: event.tool_use_id,
    rawCommand: command, cwd: event.cwd ?? process.cwd(), outcome, exitCode,
    startedAt: event.started_at ?? null, finishedAt, resultMetadata,
    source: { eventName, tool } }, { root });
}
