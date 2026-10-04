import { parseSemanticCommand, explicitOpenCodeOutcome } from './normalize.js';
import { observe } from './observer.js';
import { appendEventLog } from './queue.js';

// OpenCode plugin contract: tool.execute.before / tool.execute.after.
// Never mutate input or output; unsupported/ambiguous result metadata stays unknown.
export default async function fmHooksPlugin({ directory, worktree }) {
  const starts = new Map();
  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash' && input.tool !== 'shell') return;
      const command = output.args?.command;
      if (typeof command !== 'string') return;
      starts.set(input.callID, { startedAt: new Date().toISOString(), command });
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'bash' && input.tool !== 'shell') return;
      const command = input.args?.command ?? output.args?.command;
      if (typeof command !== 'string') return;
      if (!parseSemanticCommand(command).length) {
        try {
          await appendEventLog({ type: 'seen', matched: false, harness: 'opencode', tool: input.tool,
            callId: input.callID, rawCommand: command });
        } catch (error) {
          console.error(`fm-hooks observer error: ${error.message}`);
        }
        return;
      }
      const start = starts.get(input.callID);
      starts.delete(input.callID);
      const finishedAt = new Date().toISOString();
      const result = explicitOpenCodeOutcome(output);
      try {
        await observe({ harness: 'opencode', sessionId: input.sessionID, callId: input.callID,
          rawCommand: command, cwd: directory ?? worktree ?? process.cwd(), project: directory ?? null,
          outcome: result.outcome, exitCode: result.exitCode, startedAt: start?.startedAt ?? null,
          finishedAt, durationMs: start ? Date.parse(finishedAt) - Date.parse(start.startedAt) : null,
          resultMetadata: output.metadata ?? null,
          source: { eventName: 'tool.execute.after', tool: input.tool, title: output.title ?? null,
            output: output.output ?? null } });
      } catch (error) {
        // Observation failures must not throw into the tool lifecycle.
        console.error(`fm-hooks observer error: ${error.message}`);
      }
    }
  };
}
