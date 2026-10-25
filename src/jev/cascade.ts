import { appendEvalLines, cascadeLine, evalLogPath, newRequestId } from './eval-log.ts';
import { defaultBigModel, type BigModel } from './big-model.ts';
import { defaultHumanQueue, type HumanItem } from './human-queue.ts';
import { askPack, UNDECIDED, type Pack, type Verdict } from './questions/v1.ts';

// Cascade: Jev first, the big model when Jev is undecided / below the floor / on the exit,
// the human queue when the big model cannot settle it. Irreversible steps never reach a model.
export const CASCADE_FLOOR = 0.5;
export const DESTRUCTIVE_THRESHOLD = 0.9;

export type Layer = 'jev' | 'big' | 'human';
export type Decision = {
  verdict: string;
  layer: Layer;
  confidence: number;
  jev?: Verdict<any>;
  big?: Verdict<any>;
  requestId: string;
  reason: string;
  humanId?: string | null;
};
export type DecideOptions = {
  irreversible?: boolean;
  destructive?: boolean;
  bigModel?: BigModel;
  humanQueue?: (item: HumanItem) => Promise<{ id: string } | null>;
  askPack?: (pack: Pack<any>, raw: unknown, options?: any) => Promise<any>;
  askOptions?: any;
  evalLogPath?: string | null; // null disables logging
};

const unavailable = (): Verdict<any> => ({ verdict: UNDECIDED, reason: 'unavailable' as any, confidence: 0, choice: '' });
const clears = (v: Verdict<any> | undefined, required: number) => !!v && v.verdict !== UNDECIDED && v.confidence >= required;

export async function decide(pack: Pack<any>, raw: unknown, opts: DecideOptions = {}): Promise<Decision> {
  const required = opts.destructive ? DESTRUCTIVE_THRESHOLD : CASCADE_FLOOR;
  const irreversible = !!opts.irreversible;
  const destructive = !!opts.destructive;
  let requestId = newRequestId();
  let state = pack.prefilter(raw);
  let jev: Verdict<any> | undefined;
  let big: Verdict<any> | undefined;
  let decision: Omit<Decision, 'requestId'> | undefined;

  if (irreversible) {
    decision = { verdict: UNDECIDED, layer: 'human', confidence: 0, reason: 'irreversible' };
  } else {
    try {
      const result = await (opts.askPack ?? askPack)(pack, raw, opts.askOptions);
      requestId = result.requestId ?? requestId;
      state = result.state ?? state;
      jev = { verdict: result.verdict, reason: result.reason, confidence: result.confidence, choice: result.choice };
    } catch { jev = unavailable(); }
    if (clears(jev, required)) {
      decision = { verdict: jev.verdict, layer: 'jev', confidence: jev.confidence, jev, reason: 'jev-confident' };
    } else {
      const why = jev.verdict !== UNDECIDED ? 'below-required' : jev.reason ?? 'undecided';
      try { big = await (opts.bigModel ?? defaultBigModel)({ pack, state, questions: pack.questions, jevGuess: jev }); } catch { big = unavailable(); }
      if (clears(big, required)) decision = { verdict: big.verdict, layer: 'big', confidence: big.confidence, jev, big, reason: `jev-${why}` };
      else decision = { verdict: UNDECIDED, layer: 'human', confidence: big.confidence, jev, big, reason: big.verdict !== UNDECIDED ? 'big-below-required' : `big-${big.reason ?? 'undecided'}` };
    }
  }

  let humanId: string | null = null;
  if (decision.layer === 'human') {
    try { humanId = (await (opts.humanQueue ?? defaultHumanQueue)({ pack, state, jev, big, reason: decision.reason }))?.id ?? null; } catch { humanId = null; }
  }
  if (opts.evalLogPath !== null) {
    try {
      await appendEvalLines([cascadeLine({ requestId, packId: pack.id, layer: decision.layer, jevConfidence: jev?.confidence ?? null, bigConfidence: big?.confidence ?? null, irreversible, destructive, humanId })], opts.evalLogPath ?? evalLogPath());
    } catch { /* logging never changes the decision */ }
  }
  return { ...decision, requestId, humanId };
}
