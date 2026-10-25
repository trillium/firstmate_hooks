import { answerLine, appendEvalLines, evalLogPath, newRequestId } from './eval-log.ts';
import { readApiKey } from './keychain.ts';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const MAX_REQUEST_TOKENS = 64_000;

export class JevRequestTooLarge extends Error {
  estimatedTokens: number;
  constructor(estimatedTokens, limit = MAX_REQUEST_TOKENS) {
    super(`jev request too large: ~${estimatedTokens} tokens estimated, limit ${limit}`);
    this.name = 'JevRequestTooLarge';
    this.estimatedTokens = estimatedTokens;
  }
}

export class JevHttpError extends Error {
  status: number;
  body: string;
  constructor(status, body) {
    super(`jev request failed: HTTP ${status}${body ? ` ${body.slice(0, 300)}` : ''}`);
    this.name = 'JevHttpError';
    this.status = status;
    this.body = body;
  }
}

export class JevNetworkError extends Error {
  constructor(cause) {
    super(`jev request failed: network error (${cause?.name ?? 'Error'})`);
    this.name = 'JevNetworkError';
  }
}

export class JevResponseError extends Error {
  constructor(message) {
    super(`jev response invalid: ${message}`);
    this.name = 'JevResponseError';
  }
}

export type Question =
  | { id: string; kind: 'choice'; instructions: any; options: Record<string, string>; threshold?: number | null }
  | { id: string; kind: 'score'; instructions: any; levels: string[]; threshold?: number | null }
  | { id: string; kind: 'yesno'; instructions: any; criteria?: { true?: string; false?: string }; threshold?: number | null };

export type Answer = {
  id: string;
  kind: 'choice' | 'score' | 'yesno';
  value: string | number | boolean;
  distribution: Record<string, number>;
  confidence: number;
};

// Question ids are caller-side only. The API keys questions by a name we choose, so the
// wire name is positional (q0, q1, ...) and the meaning lives in `instructions`.
const wireName = index => `q${index}`;

function wireQuestion(q: Question) {
  if (q.kind === 'choice') return { type: 'choice', instructions: q.instructions, criteria: q.options };
  if (q.kind === 'score') return { type: 'score', instructions: q.instructions, criteria: q.levels };
  if (q.kind === 'yesno') return { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  throw new TypeError(`unknown question kind: ${(q as any).kind}`);
}

export function buildRequest(state, questions: Question[]) {
  return {
    model: JEV_MODEL,
    state,
    questions: Object.fromEntries(questions.map((q, i) => [wireName(i), wireQuestion(q)])),
  };
}

export const estimateTokens = body => Math.ceil(JSON.stringify(body).length / 4);

function mapAnswer(q: Question, raw): Answer {
  if (!raw || typeof raw !== 'object') throw new JevResponseError(`missing answer for question ${q.id}`);
  const wantType = q.kind === 'yesno' ? 'noul' : q.kind;
  if (raw.type !== wantType) throw new JevResponseError(`answer type ${raw.type} for ${q.kind} question ${q.id}`);
  if (q.kind === 'yesno') {
    const p = raw.noul;
    if (typeof p !== 'number') throw new JevResponseError(`no probability for question ${q.id}`);
    return { id: q.id, kind: q.kind, value: p >= 0.5, distribution: { true: p, false: 1 - p }, confidence: Math.max(p, 1 - p) };
  }
  if (typeof raw.probabilities !== 'object' || raw.probabilities === null) throw new JevResponseError(`no distribution for question ${q.id}`);
  const distribution = { ...raw.probabilities };
  const top = Math.max(...Object.values<number>(distribution));
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : top;
  if (q.kind === 'choice') return { id: q.id, kind: q.kind, value: String(raw.choice), distribution, confidence };
  return { id: q.id, kind: q.kind, value: Number(raw.score), distribution, confidence };
}

export type AskOptions = {
  fetch?: (url: string, init: any) => Promise<Response>;
  apiKey?: string;
  evalLogPath?: string | null; // null disables logging
  now?: () => number;
};

// ONE request carries the whole state and every question; questions cannot see each
// other's answers. Returns one answer per question, in order, plus the request id that
// keys the eval log.
export async function ask(state, questions: Question[], options: AskOptions = {}) {
  if (!questions.length) throw new TypeError('ask needs at least one question');
  const body = buildRequest(state, questions);
  const estimated = estimateTokens(body);
  if (estimated > MAX_REQUEST_TOKENS) throw new JevRequestTooLarge(estimated);

  const apiKey = options.apiKey ?? readApiKey();
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const started = now();
  let response;
  try {
    response = await doFetch(JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (error) { throw new JevNetworkError(error); }
  const text = await response.text();
  const latencyMs = now() - started;
  if (!response.ok) throw new JevHttpError(response.status, text.split(apiKey).join('[redacted]'));
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new JevResponseError('body is not JSON'); }
  const model = typeof parsed.model === 'string' ? parsed.model : JEV_MODEL;
  const answers = questions.map((q, i) => mapAnswer(q, parsed.answers?.[wireName(i)]));

  const requestId = newRequestId();
  if (options.evalLogPath !== null) {
    await appendEvalLines(
      answers.map((answer, i) => answerLine({ requestId, answer, model, threshold: questions[i].threshold, latencyMs })),
      options.evalLogPath ?? evalLogPath(),
    );
  }
  return { requestId, model, latencyMs, answers, usage: parsed.usage ?? null };
}
