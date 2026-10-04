#!/usr/bin/env node
import { parseSemanticCommand } from './normalize.js';
import { observe } from './observer.js';
import { appendEventLog } from './queue.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const event = JSON.parse(raw);
  const eventName = process.env.CLAUDE_HOOK_EVENT_NAME || event.hook_event_name || '';
  const tool = event.tool_name || event.toolName;
  if (tool !== 'Bash' || !['PostToolUse', 'PostToolUseFailure'].includes(eventName)) process.exit(0);
  const command = event.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);
  if (!parseSemanticCommand(command).length) {
    await appendEventLog({ type: 'seen', matched: false, harness: 'claude-code', tool, rawCommand: command,
      sessionId: event.session_id ?? null, callId: event.tool_use_id ?? null });
    process.exit(0);
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
    source: { eventName, tool } });
} catch (error) {
  // Hooks are observers; malformed input or an unavailable queue must not change the tool call.
  console.error(`fm-hooks observer error: ${error.message}`);
  process.exitCode = 0;
}
