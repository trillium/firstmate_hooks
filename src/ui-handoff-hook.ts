#!/usr/bin/env bun
import { analyzeTranscript } from './turn-end.ts';
import { evaluateUiHandoff } from './ui-handoff.ts';

// Claude Code Stop hook. Unlike claude-hook.ts (observe-only), this one may block the stop,
// once: when stop_hook_active is set the previous block already happened, so it lets the stop
// through. Any error fails open. FM_UI_HANDOFF_HOOK=off disables it without editing settings.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  if (/^(?:off|0|false|disabled?)$/i.test(process.env.FM_UI_HANDOFF_HOOK ?? '')) process.exit(0);
  const event = JSON.parse(raw);
  const name = process.env.CLAUDE_HOOK_EVENT_NAME || event.hook_event_name || '';
  if (name && name !== 'Stop') process.exit(0);
  if (event.stop_hook_active === true) process.exit(0);
  const message = typeof event.last_assistant_message === 'string' && event.last_assistant_message
    ? event.last_assistant_message
    : (await analyzeTranscript(event.transcript_path)).lastAssistantText;
  const verdict = evaluateUiHandoff(message);
  if (verdict.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }) + '\n');
} catch (error) {
  console.error(`ui-handoff hook error: ${error.message}`);
}
process.exit(0);
