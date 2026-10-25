import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { stateRoot } from '../paths.ts';

export const LAYER = 'jev';

// Append-only JSONL. Env JEV_EVAL_LOG overrides the path; the default sits under the
// fm-hooks state root. Lines are only ever appended: an outcome is its own line.
export function evalLogPath(env = process.env) {
  if (env.JEV_EVAL_LOG) return isAbsolute(env.JEV_EVAL_LOG) ? resolve(env.JEV_EVAL_LOG) : resolve(homedir(), env.JEV_EVAL_LOG);
  return join(stateRoot(env), 'jev', 'eval.jsonl');
}

export const newRequestId = () => randomUUID();

export async function appendEvalLines(lines, path = evalLogPath()) {
  if (!lines.length) return path;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, 'a', 0o600);
  try {
    await file.writeFile(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    await file.sync();
  } finally { await file.close(); }
  return path;
}

// One line per answered question. `outcome` is null here and is recorded later.
export const answerLine = ({ requestId, answer, model, threshold, latencyMs, at = new Date() }) => ({
  kind: 'answer',
  timestamp: at.toISOString(),
  request_id: requestId,
  question_id: answer.id,
  question_kind: answer.kind,
  model,
  distribution: answer.distribution,
  chosen: answer.value,
  confidence: answer.confidence,
  threshold: threshold ?? null,
  layer: LAYER,
  latency_ms: latencyMs,
  outcome: null,
});

// A separate appended line keyed by (request_id, question_id); earlier lines are never rewritten.
export function recordOutcome(requestId, questionId, outcome, path = evalLogPath(), at = new Date()) {
  return appendEvalLines([{
    kind: 'outcome', timestamp: at.toISOString(), request_id: requestId, question_id: questionId, layer: LAYER, outcome,
  }], path);
}
