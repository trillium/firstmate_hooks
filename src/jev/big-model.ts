import { spawn } from 'node:child_process';
import { UNDECIDED, type Pack, type Verdict } from './questions/v1.ts';

// Default big-model adapter: the `claude` CLI in print mode. Any CLI error, timeout or
// unparsable reply is `undecided` with reason 'unavailable', never a throw.
export const DEFAULT_BIG_MODEL = 'claude-sonnet-5-5';
export const BIG_MODEL_TIMEOUT_MS = 60_000;

export type BigInput = { pack: Pack<any>; state: string; questions: any[]; jevGuess: Verdict<any> };
export type BigModel = (input: BigInput) => Promise<Verdict<any>>;
export type ClaudeRunner = (prompt: string, model: string, timeoutMs: number) => Promise<string>;

export const unavailable = (): Verdict<any> => ({ verdict: UNDECIDED, reason: 'unavailable' as any, confidence: 0, choice: '' });

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

export function buildBigPrompt({ state, questions, jevGuess }: BigInput) {
  const q = questions.find(x => x.kind === 'choice') ?? questions[0];
  const options = Object.entries(q.options ?? {}).map(([name, desc]) => `- ${name}: ${desc}`).join('\n');
  return [
    'You are the second-opinion layer of a decision cascade. A small fast model made a first guess; decide the question yourself.',
    '', 'Question:', text(q.instructions),
    '', 'Choose exactly one of these:', options,
    '', 'State:', state,
    '', `The small model guessed "${jevGuess.choice}" with confidence ${jevGuess.confidence} (verdict: ${jevGuess.verdict}). It may be wrong.`,
    '', 'Reply with only JSON: {"choice": "<one of the choices above>", "confidence": <number from 0 to 1>}',
  ].join('\n');
}

// Find the first JSON object in the reply, tolerating code fences and surrounding prose.
export function parseBigReply(reply: string): { choice: string; confidence: number } | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1));
    const confidence = Number(parsed.confidence);
    if (typeof parsed.choice !== 'string' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return { choice: parsed.choice, confidence };
  } catch { return null; }
}

export const runClaude: ClaudeRunner = (prompt, model, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn('claude', ['-p', '--output-format', 'json', '--model', model], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
});

export function createBigModel(options: { run?: ClaudeRunner; model?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): BigModel {
  const env = options.env ?? process.env;
  const run = options.run ?? runClaude;
  return async input => {
    try {
      const model = options.model ?? env.JEV_BIG_MODEL ?? DEFAULT_BIG_MODEL;
      const raw = await run(buildBigPrompt(input), model, options.timeoutMs ?? BIG_MODEL_TIMEOUT_MS);
      const envelope = JSON.parse(raw);
      if (envelope?.is_error || typeof envelope?.result !== 'string') return unavailable();
      const reply = parseBigReply(envelope.result);
      if (!reply) return unavailable();
      const q = input.questions.find(x => x.kind === 'choice') ?? input.questions[0];
      // Same undecided rule as the pack: decode a synthetic answer.
      return input.pack.decode([{ id: q.id, kind: 'choice', value: reply.choice, distribution: { [reply.choice]: reply.confidence }, confidence: reply.confidence }]);
    } catch { return unavailable(); }
  };
}

export const defaultBigModel = createBigModel();
