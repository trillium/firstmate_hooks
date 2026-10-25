import { STORE_ROUTE_STORES, storeRoutePack } from './questions/v1.ts';

// Store-route observation point (shadow only). The Claude hook sees every Bash command; one
// that captures into a federated store (`brain create "..."`, `task q "..."`, `ideas remember
// "..."`) is recognized here and, when JEV_SHADOW is on, queued for Jev to label. `existing`
// is the store the agent actually chose; Jev's answer lands in the eval log and nothing reads it.
//
// The hook path never waits on Jev: it writes the raw capture to a pending record (pending.ts)
// and the poller drains it on its next cycle through shadowGuarded. That was chosen over an
// in-hook shadowGuarded call because that call can take up to the shadow timeout (8s) and a
// hook runs inline with the agent's tool call.

export { storeRoutePack };
export const STORE_CAPTURE_VERBS = ['create', 'q', 'remember'] as const;
const STORES: readonly string[] = STORE_ROUTE_STORES.filter(s => s !== 'none');
const VERBS: readonly string[] = STORE_CAPTURE_VERBS;

// Shell-ish tokenizer: single/double quotes group, backslash escapes inside double quotes and
// bare words. Stops at the first unquoted control operator (; & | newline) so only the first
// command of a pipeline or chain is read.
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '', has = false, quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (/\s/.test(c) && c !== '\n') { if (has) tokens.push(cur); cur = ''; has = false; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|') break;
    cur += c; has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

const DESCRIPTION_FLAGS = ['--description', '-d', '--body', '--notes'];

// Pure. `{ store, title, body }` for a federated-store capture command, else null. `fm-*`
// commands and anything whose first word is not a real store (or whose verb is not a capture
// verb) are not captures.
export function storeCaptureOf(command: unknown): { store: string; title: string; body: string } | null {
  if (typeof command !== 'string') return null;
  const tokens = tokenize(command.trim());
  const [store, verb] = tokens;
  if (!store || store.startsWith('fm-') || !STORES.includes(store) || !VERBS.includes(verb)) return null;
  let title = '';
  const body: string[] = [];
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    const flag = DESCRIPTION_FLAGS.find(f => t === f || t.startsWith(`${f}=`));
    if (flag) {
      if (t === flag) { if (tokens[i + 1] !== undefined) body.push(tokens[++i]); } else body.push(t.slice(flag.length + 1));
    } else if (!t.startsWith('-') && !title) title = t; // other flags are not capture text
  }
  if (!title) return null;
  return { store, title, body: body.join('\n') };
}

// The pending-record payload for a command, or null. `raw` is the {title, body} record
// prefilterStoreRoute caps.
export function storeRouteObservation(command: unknown) {
  const capture = storeCaptureOf(command);
  return capture ? { pack: storeRoutePack.id, existing: capture.store, raw: { title: capture.title, body: capture.body } } : null;
}
