import { parseSemanticCommand } from './normalize.js';
import { observe } from './observer.js';
import { appendEventLog } from './queue.js';

// Observe only completed Pi bash calls. Keep just enough start data to pair the
// completion event; the adapter never patches or replaces Pi tool data.
export default function fmHooksPiExtension(pi) {
  const starts = new Map();

  pi.on('tool_execution_start', (event, ctx) => {
    if (event.toolName !== 'bash' || typeof event.args?.command !== 'string') return;

    starts.set(event.toolCallId, {
      rawCommand: event.args.command,
      startedAt: new Date().toISOString(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId()
    });
  });

  pi.on('tool_execution_end', async event => {
    if (event.toolName !== 'bash') return;
    const start = starts.get(event.toolCallId);
    if (!start) return;
    starts.delete(event.toolCallId);

    if (!parseSemanticCommand(start.rawCommand).length) {
      try {
        await appendEventLog({
          type: 'seen',
          matched: false,
          harness: 'pi',
          tool: event.toolName,
          callId: event.toolCallId,
          rawCommand: start.rawCommand
        });
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
}
