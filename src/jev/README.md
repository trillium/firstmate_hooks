# jev harness contract

`ask(state, questions[])` sends one `POST https://api.typesafe.ai/v1/systemone` carrying the whole state and every question, and returns one typed answer per question.

Schema implemented against: https://docs.typesafe.ai/api, read 2026-10-25.

- Request: `{ model, state, questions: { <name>: { type: noul|choice|score, instructions, criteria? } } }`, `Authorization: Bearer <key>`. `choice.criteria` is `{name: description}`, `score.criteria` is an ordered array of level descriptions, `noul` (yes/no) takes optional `criteria: {true, false}`.
- Response: `{ model, answers: { <name>: ... }, usage }`. `noul` -> `{noul: p}`; `choice` -> `{choice, confidence, probabilities}`; `score` -> `{score, confidence, legend, probabilities}`. Non-200 is documented only for 422.
- Question ids are caller-side; the wire names are positional (`q0`, `q1`, ...).

Pieces: `ask.ts` (`JEV_MODEL = 'jev-1.13.0'`, typed errors `JevRequestTooLarge`, `JevHttpError`, `JevNetworkError`; the 64K-token bound is estimated as chars/4 and never truncates), `keychain.ts` (service `typesafe-jev`; `TYPESAFE_API_KEY` overrides), `eval-log.ts` (JSONL at `<stateRoot>/jev/eval.jsonl`, override `JEV_EVAL_LOG`; `recordOutcome` appends a separate `kind: "outcome"` line).

Test: `bun test test/jev.test.ts`; live smoke with `JEV_LIVE=1`.

## Question packs

`src/jev/questions/v1.ts` exports three packs, one judgment each. A pack is `{ id, prefilter(raw), questions, decode(answers) }`: the prefilter squeezes the raw record to a compact state string in code (epochs, absolute paths, ids and urls stripped, size capped), the one choice question has a fixed answer set that always includes an `other`/`none` exit, and `decode` returns `{ verdict, reason, confidence, choice }` where `verdict` is `undecided` for the exit or a confidence below the pack's floor (`reason`: `exit` | `low-confidence` | `unknown-choice`). `askPack(pack, raw, options)` runs prefilter, one `ask`, and decode.

| Pack | Raw input | Question id | Choices | Floor |
| --- | --- | --- | --- | --- |
| `worker-status` | tail of a `state/<id>.status` file | `worker-status/state` | `done`, `stuck`, `in-progress`, `other` | 0.6 |
| `ci-rollup` | `gh pr checks` / `gh run view` text or JSON | `ci-rollup/result` | `pass`, `fail`, `pending`, `other` | 0.6 |
| `store-route` | item title + body (string or `{title, body}`) | `store-route/store` | `STORE_ROUTE_STORES` (`task` ... `none`) | 0.5 |

The question id is the eval-log `question_id`, so `recordOutcome(requestId, 'worker-status/state', ...)` joins the later outcome. Fixtures with hand labels live in `test/fixtures/jev/v1/<pack>/`; `JEV_LIVE=1 bun test test/jev-questions.test.ts -t "live smoke"` prints correct/total per pack.

## Cascade

`src/jev/cascade.ts` exports `decide(pack, raw, opts)`, which sits on `askPack` and returns `{ verdict, layer: 'jev' | 'big' | 'human', confidence, jev?, big?, requestId, reason, humanId }`.

1. **jev**: decides when its verdict is not `undecided` and its confidence is at least the required confidence.
2. **big**: asked when Jev is `undecided` (exit, low confidence, unknown choice, or the call failed), or below the required confidence. The `other`/`none` exit never routes alone, it always escalates. The big model receives the same prefiltered state string and the Jev guess (verdict, confidence, choice), never the raw record.
3. **human**: when the big model is also undecided, below the required confidence, or unavailable, `decide` queues a `review` bead and returns `layer: 'human'`, `verdict: 'undecided'`. A failed queue write returns `humanId: null`; the layer is still `human`.

Required confidence: `CASCADE_FLOOR = 0.5`; with `opts.destructive: true`, `DESTRUCTIVE_THRESHOLD = 0.9` at both the jev and big layers. `opts.irreversible: true` skips both models and queues the item.

Adapters (all injectable through `opts`):

| Option | Default | Notes |
| --- | --- | --- |
| `bigModel({ pack, state, questions, jevGuess })` | `big-model.ts`: `claude -p --output-format json --model <JEV_BIG_MODEL>` | Prompt lists the pack's fixed choices and asks for `{"choice", "confidence"}`; decoded with the pack's own `decode`. CLI error, timeout (60 s) or unparsable reply is `undecided` with `reason: 'unavailable'`, never a throw. |
| `humanQueue({ pack, state, jev, big, reason })` | `human-queue.ts`: `review create "<pack> needs a call: <state>" --description ... --silent` | Returns `{ id }` or `null`. Prefiltered state only, no raw record. |
| `askPack`, `askOptions` | `askPack` from `questions/v1.ts` | For tests and fake fetch. |
| `evalLogPath` | the eval log | `null` disables. |

Env: `JEV_BIG_MODEL` (default `claude-sonnet-5-5`), plus the existing `JEV_EVAL_LOG`, `TYPESAFE_API_KEY`.

Eval log: each `decide` appends one `kind: "cascade"` line (`request_id`, `pack`, `layer`, `jev_confidence`, `big_confidence`, `irreversible`, `destructive`, `human_id`). `answerLine` and `recordOutcome` take an optional `layer` (default `jev`).

Not wired into any firstmate hook yet.
