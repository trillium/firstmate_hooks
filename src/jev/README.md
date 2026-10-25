# jev harness contract

`ask(state, questions[])` sends one `POST https://api.typesafe.ai/v1/systemone` carrying the whole state and every question, and returns one typed answer per question.

Schema implemented against: https://docs.typesafe.ai/api, read 2026-10-25.

- Request: `{ model, state, questions: { <name>: { type: noul|choice|score, instructions, criteria? } } }`, `Authorization: Bearer <key>`. `choice.criteria` is `{name: description}`, `score.criteria` is an ordered array of level descriptions, `noul` (yes/no) takes optional `criteria: {true, false}`.
- Response: `{ model, answers: { <name>: ... }, usage }`. `noul` -> `{noul: p}`; `choice` -> `{choice, confidence, probabilities}`; `score` -> `{score, confidence, legend, probabilities}`. Non-200 is documented only for 422.
- Question ids are caller-side; the wire names are positional (`q0`, `q1`, ...).

Pieces: `ask.ts` (`JEV_MODEL = 'jev-1.13.0'`, typed errors `JevRequestTooLarge`, `JevHttpError`, `JevNetworkError`; the 64K-token bound is estimated as chars/4 and never truncates), `keychain.ts` (service `typesafe-jev`; `TYPESAFE_API_KEY` overrides), `eval-log.ts` (JSONL at `<stateRoot>/jev/eval.jsonl`, override `JEV_EVAL_LOG`; `recordOutcome` appends a separate `kind: "outcome"` line).

Test: `bun test test/jev.test.ts`; live smoke with `JEV_LIVE=1`.
