import { normalizeEvent } from './normalize.js';
import { evaluateAndEnqueue, loadRules, persistEvent } from './queue.js';

export async function observe(input, options = {}) {
  const events = normalizeEvent(input);
  if (!events.length) return [];
  const root = options.root;
  const rules = options.rules ?? await loadRules(options.rulesPath);
  const results = [];
  for (const event of events) {
    await persistEvent(event, root);
    const actions = await evaluateAndEnqueue(event, rules, root);
    results.push({ event, actions });
  }
  return results;
}
