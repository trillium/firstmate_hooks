import { normalizeEvent } from './normalize.ts';
import { evaluateAndEnqueue, loadRules, persistEvent, persistRecord } from './queue.ts';
import { buildWakeDrain, isPresentingDrain } from './wake-drain.ts';

export async function observe(input, options: Record<string, any> = {}) {
  const events = normalizeEvent(input);
  if (!events.length) return [];
  const root = options.root;
  const rules = options.rules ?? await loadRules(options.rulesPath);
  const results = [];
  for (const event of events) {
    await persistEvent(event, root);
    const actions = await evaluateAndEnqueue(event, rules, root);
    results.push({ event, actions });
    if (isPresentingDrain(event)) await recordWakeDrain(event, root, options);
  }
  return results;
}

// The structured record next to a successful drain event. Best effort: it is derived data,
// so failing to build or write it must never fail the observation of the call itself.
async function recordWakeDrain(event, root, options) {
  try {
    const record = await buildWakeDrain(event, { env: options.env ?? process.env, now: options.now });
    await persistRecord('wake-drain', event.correlationId, record, root);
  } catch (error) {
    console.error(`fm-hooks observer error: wake-drain: ${error.message}`);
  }
}
