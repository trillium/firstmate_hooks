import { appendEvalLines, evalLogPath as defaultEvalLogPath, LAYER, newRequestId } from './eval-log.ts';
import { SHADOW_DEFAULT_TIMEOUT_MS, JevShadowTimeout } from './shadow.ts';
import { askPack, type Pack } from './questions/v1.ts';

// Promotion: the first place a Jev verdict changes what the status tail writes. One decision
// type only -- `worker-status` answering `stuck` at confidence >= 0.9 over a regex state in
// the in-progress class -- behind env JEV_PROMOTE=worker-status:stuck. Anything else (unset,
// empty, another value) is promotion off. `askGuarded` never throws; every failure is
// "unavailable" and the existing path runs untouched. Revert switch: remove JEV_PROMOTE.

export const PROMOTE_FLAG_VALUE = 'worker-status:stuck';
export const PROMOTE_MIN_CONFIDENCE = 0.9;
export const PROMOTABLE_STATES = ['working', 'paused', 'resolved'] as const;

export type PromoteReason = 'applied' | 'not-stuck' | 'below-band' | 'state-not-promotable' | 'unavailable' | 'off';

export const promoteSettings = (env: Record<string, any> = process.env) => ({ enabled: env.JEV_PROMOTE === PROMOTE_FLAG_VALUE });

export type Asked = { ok: true; result: any } | { ok: false; error: unknown };

// One bounded Jev call. The outcome (answer or error) is returned so the shadow path can
// reuse it instead of calling Jev a second time for the same line.
export async function askGuarded({ pack, raw, ask, evalLogPath, timeoutMs = SHADOW_DEFAULT_TIMEOUT_MS }: {
  pack: Pack<any>; raw: unknown; ask?: (pack: Pack<any>, raw: unknown, options?: any) => Promise<any>; evalLogPath?: string; timeoutMs?: number;
}): Promise<Asked> {
  let timer;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JevShadowTimeout(timeoutMs)), timeoutMs); });
    const call = (ask ?? askPack)(pack, raw, { evalLogPath: evalLogPath ?? defaultEvalLogPath() });
    call.catch(() => {}); // an abandoned call that rejects late must not surface
    return { ok: true, result: await Promise.race([call, timeout]) };
  } catch (error) { return { ok: false, error }; }
  finally { clearTimeout(timer); }
}

// Pure: should this answer move the fleet state?
export function promoteDecision(asked: Asked, regexState: string): { apply: boolean; reason: PromoteReason; verdict: string | null; confidence: number | null } {
  if (!asked.ok) return { apply: false, reason: 'unavailable', verdict: null, confidence: null };
  const verdict = typeof asked.result?.verdict === 'string' ? asked.result.verdict : null;
  const confidence = typeof asked.result?.confidence === 'number' ? asked.result.confidence : null;
  const base = { verdict, confidence };
  if (verdict !== 'stuck') return { apply: false, reason: 'not-stuck', ...base };
  if (confidence === null || confidence < PROMOTE_MIN_CONFIDENCE) return { apply: false, reason: 'below-band', ...base };
  if (!(PROMOTABLE_STATES as readonly string[]).includes(regexState)) return { apply: false, reason: 'state-not-promotable', ...base };
  return { apply: true, reason: 'applied', ...base };
}

export const promoteLine = ({ requestId, packId, existing, verdict, confidence, applied, reason, at = new Date() }: any) => ({
  kind: 'promote', timestamp: at.toISOString(), request_id: requestId, pack: packId, layer: LAYER,
  existing, jev_verdict: verdict, jev_confidence: confidence, applied, reason,
});

export async function logPromote(line: any, path = defaultEvalLogPath()) {
  try { await appendEvalLines([line], path); } catch { /* the log never changes what the tail writes */ }
}

export const requestIdOf = (asked: Asked) => (asked.ok && asked.result?.requestId) || newRequestId();
