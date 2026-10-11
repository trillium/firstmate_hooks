import { normalizeEvent } from './normalize.ts';
import { evaluateAndEnqueue, loadRules, persistEvent } from './queue.ts';

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
  }
  return results;
}
