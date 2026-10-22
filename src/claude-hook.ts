#!/usr/bin/env bun
import { handleClaudeHook } from './claude-events.ts';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const event = JSON.parse(raw);
  await handleClaudeHook(event, { eventName: process.env.CLAUDE_HOOK_EVENT_NAME || event.hook_event_name || '' });
} catch (error) {
  // Hooks are observers; malformed input or an unavailable queue must not change the tool call.
  console.error(`fm-hooks observer error: ${error.message}`);
  process.exitCode = 0;
}
