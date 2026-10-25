import { appendEvalLines, evalLogPath as defaultEvalLogPath, LAYER, newRequestId, recordOutcome } from './eval-log.ts';
import { buildRequest, estimateTokens, JEV_MODEL } from './ask.ts';
import { askPack, PACKS, type Pack } from './questions/v1.ts';

// Shadow mode: Jev labels what the existing path already decided, and the pair lands in the
// eval log. Nothing here feeds back into a decision. `shadowLabel` and `shadowGuarded` never
// throw and never reject; every failure becomes one `shadow-error` line carrying the error
// class name only (messages can quote a response body, so they are never logged).

// The status tail's regex state -> the worker-status pack's answer, i.e. what the existing
// path "said". `failed` is `done` because the pack counts a finished-but-failed run as the
// worker being done; `resolved` only closes an earlier blocker, so the worker is moving again.
export const EXISTING_FROM_STATE: Record<string, string> = {
  done: 'done', failed: 'done', blocked: 'stuck', working: 'in-progress', paused: 'in-progress', resolved: 'in-progress', 'needs-decision': 'other',
};

export class JevShadowTimeout extends Error {
  constructor(ms) { super(`jev shadow call exceeded ${ms}ms`); this.name = 'JevShadowTimeout'; }
}

export const SHADOW_CONTEXT_LINES = 20;
export const SHADOW_DEFAULT_TIMEOUT_MS = 8000;
export const SHADOW_DEFAULT_MAX_PER_CYCLE = 20;

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const shadowSettings = (env = process.env) => ({
  enabled: env.JEV_SHADOW === '1',
  timeoutMs: positiveInt(env.JEV_SHADOW_TIMEOUT_MS, SHADOW_DEFAULT_TIMEOUT_MS),
  maxPerCycle: positiveInt(env.JEV_SHADOW_MAX_PER_CYCLE, SHADOW_DEFAULT_MAX_PER_CYCLE),
});

export type ShadowArgs = {
  pack: Pack<any> | string;
  raw: unknown;
  existing: string;
  requestId?: string;
  ask?: (pack: Pack<any>, raw: unknown, options?: any) => Promise<any>; // stands in for askPack (tests)
  evalLogPath?: string;
  now?: () => number;
};

const errorClass = error => (typeof error?.name === 'string' && /^[A-Za-z][\w]{0,60}$/.test(error.name) ? error.name : 'Error');

export const shadowErrorLine = ({ requestId, packId, error, at = new Date() }: any) => ({
  kind: 'shadow-error', timestamp: at.toISOString(), request_id: requestId, pack: packId, layer: LAYER, error: errorClass(error),
});

async function logError(args: ShadowArgs, packId, requestId, error) {
  try { await appendEvalLines([shadowErrorLine({ requestId, packId, error })], args.evalLogPath ?? defaultEvalLogPath()); } catch { /* nothing left to do */ }
}

export async function shadowLabel(args: ShadowArgs): Promise<void> {
  const requestId = args.requestId ?? newRequestId();
  let packId = typeof args.pack === 'string' ? args.pack : args.pack?.id;
  try {
    const pack: Pack<any> = typeof args.pack === 'string' ? PACKS[args.pack] : args.pack;
    if (!pack) throw new TypeError('unknown pack');
    packId = pack.id;
    const run = args.ask ?? askPack;
    const result: any = await run(pack, args.raw, { evalLogPath: args.evalLogPath ?? defaultEvalLogPath(), ...(args.now ? { now: args.now } : {}) });
    const question = pack.questions[0];
    const agree = result.verdict === args.existing;
    await recordOutcome(result.requestId ?? requestId, question.id, {
      source: 'shadow',
      existing: args.existing,
      agree,
      jevVerdict: result.verdict,
      jevConfidence: result.confidence,
      latencyMs: result.latencyMs,
      estimatedTokens: estimateTokens(buildRequest(result.state, pack.questions)),
      model: JEV_MODEL,
      floor: question.threshold ?? null,
    }, args.evalLogPath ?? defaultEvalLogPath());
  } catch (error) { await logError(args, packId, requestId, error); }
}

// The only way the tail awaits a shadow call: bounded by a timeout, never rejecting. A call
// that outlives its timeout is abandoned (its late result may still be logged, harmlessly).
export async function shadowGuarded(args: ShadowArgs & { timeoutMs?: number }): Promise<void> {
  const timeoutMs = args.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS;
  const requestId = args.requestId ?? newRequestId();
  let timer;
  try {
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const outcome = await Promise.race([shadowLabel({ ...args, requestId }).then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      await logError(args, typeof args.pack === 'string' ? args.pack : args.pack?.id, requestId, new JevShadowTimeout(timeoutMs));
    }
  } catch { /* shadowLabel does not reject; this is belt and braces */ }
  finally { clearTimeout(timer); }
}
