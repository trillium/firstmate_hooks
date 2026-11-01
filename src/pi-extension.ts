import { parseSemanticCommand } from './normalize.ts';
import { observe } from './observer.ts';
import { appendEventLog } from './queue.ts';
import { createTurnTracker, recordTurnEnd } from './turn-end.ts';
import { scoutHook } from './scout-hook.ts';

// Observe only completed Pi bash calls. Keep just enough start data to pair the
// completion event; the adapter never patches or replaces Pi tool data.
export default function fmHooksPiExtension(pi) {
  const starts = new Map();
  const turns = createTurnTracker('pi');

  // A report written with Pi's file tools, remembered until the call ends.
  const writes = new Map();

  pi.on('tool_execution_start', (event, ctx) => {
    if (/^(write|edit)$/i.test(event.toolName ?? '')) {
      const filePath = event.args?.path ?? event.args?.file_path ?? event.args?.filePath;
      if (typeof filePath === 'string') writes.set(event.toolCallId, { filePath, cwd: ctx.cwd });
    }
    // Count every tool of the turn for the turn-end record; the call itself is never touched.
    try {
      turns.toolCall(ctx.sessionManager.getSessionId(), event.toolCallId, event.toolName === 'bash' ? event.args?.command : undefined);
    } catch { /* counting is best effort */ }
    if (event.toolName !== 'bash' || typeof event.args?.command !== 'string') return;

    starts.set(event.toolCallId, {
      rawCommand: event.args.command,
      startedAt: new Date().toISOString(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId()
    });
  });

  pi.on('tool_execution_end', async event => {
    const written = writes.get(event.toolCallId);
    if (written) {
      writes.delete(event.toolCallId);
      scoutHook({ filePath: written.filePath, cwd: written.cwd, ok: event.isError !== true });
    }
    if (event.toolName !== 'bash') return;
    const start = starts.get(event.toolCallId);
    if (!start) return;
    starts.delete(event.toolCallId);
    // A delivered scout report is captured from the hook itself (scout-hook.ts).
    scoutHook({ command: start.rawCommand, cwd: start.cwd, ok: event.isError !== true });

    if (!parseSemanticCommand(start.rawCommand).length) {
      try {
        await appendEventLog({
          type: 'seen',
          matched: false,
          harness: 'pi',
          tool: event.toolName,
          callId: event.toolCallId,
          rawCommand: start.rawCommand
        }, undefined, { cwd: start.cwd });
      } catch (error) {
        console.error(`fm-hooks observer error: ${error.message}`);
      }
      return;
    }

    const finishedAt = new Date().toISOString();
    const outcome = event.isError === true ? 'failure' :
      event.isError === false ? 'success' : 'unknown';
    try {
      await observe({
        harness: 'pi',
        sessionId: start.sessionId,
        callId: event.toolCallId,
        rawCommand: start.rawCommand,
        cwd: start.cwd,
        project: null,
        outcome,
        exitCode: null,
        startedAt: start.startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(start.startedAt),
        // Pi's declared completion event has no stable exit-code contract. Do not
        // persist its arbitrary result payload; the explicit error flag is enough.
        resultMetadata: { isError: typeof event.isError === 'boolean' ? event.isError : null },
        source: { eventName: 'tool_execution_end', tool: event.toolName }
      });
    } catch (error) {
      // Observation failures must never affect Pi's completed tool call.
      console.error(`fm-hooks observer error: ${error.message}`);
    }
  });

  // Pi's turn boundary: the agent has settled and has nothing left to do.
  pi.on('agent_settled', async (_event, ctx) => {
    try {
      const record = turns.settle(ctx?.sessionManager?.getSessionId());
      if (record) await recordTurnEnd(record, undefined, { cwd: ctx?.cwd });
    } catch (error) {
      console.error(`fm-hooks observer error: ${error.message}`);
    }
  });
}
