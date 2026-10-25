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


## Shadow mode

The status tail (`src/status-tail.ts`) can ask the `worker-status` pack about every status line it records while the existing regex keeps deciding. Jev's answer is logged and used for nothing: the fleet comment, `fm-state:` label, cursor and scout capture are identical with it on, off, slow, down or unkeyed.

What runs, when `JEV_SHADOW=1` (default off): after `tailStatusOnce` records a line, `shadowLabel` (`shadow.ts`) calls `askPack(workerStatusPack, raw)` with `raw` = the status file's last up to 20 lines ending at that line. It appends `recordOutcome(requestId, 'worker-status/state', { source: 'shadow', existing, agree, jevVerdict, jevConfidence, latencyMs, estimatedTokens, model, floor })` on the same request id as the answer line. Any failure (no key, HTTP, network, too large, timeout) becomes one `kind: "shadow-error"` line with the error class name only (e.g. `JevKeyUnavailable`, `JevShadowTimeout`) and never reaches the tail.

`existing` is the regex state mapped to the pack's answers (`EXISTING_FROM_STATE` in `shadow.ts`); `agree` is `jevVerdict === existing`, and `undecided` never agrees:

| regex state | `existing` |
| --- | --- |
| `done`, `failed` | `done` |
| `blocked` | `stuck` |
| `working`, `paused`, `resolved` | `in-progress` |
| `needs-decision` | `other` |

Env: `JEV_SHADOW` (`1` turns it on), `JEV_SHADOW_TIMEOUT_MS` (per line, default 8000), `JEV_SHADOW_MAX_PER_CYCLE` (default 20; lines beyond the cap are skipped, not queued), `JEV_EVAL_LOG`. The poller plist passes these through when set. The key is read only through `keychain.ts`; if the launchd poller cannot reach the Keychain the log records `JevKeyUnavailable`. Calls are awaited one line at a time, so a slow Jev delays a poll cycle by at most `timeout x cap`.

Reading the report: `bun src/jev/shadow-report.ts [--log <path>] [--since <ISO>] [--pack <id>] [--json]` joins answer lines to shadow outcomes by request id and prints, per pack and per Jev confidence band (`<0.5`, `0.5-0.6`, `0.6-0.9`, `>=0.9`): n, agree, disagree, undecided, agreement % (agree / n), p50/p95 latency, total and mean estimated tokens, then the shadow-error count by class. A high-agreement `>=0.9` band is the candidate for going automatic first (a separate step).

Enabling `JEV_SHADOW=1` in the deployed poller is firstmate's step, not part of this change. `bun src/jev/shadow-sample.ts --home <FM_HOME> --last <N>` is a read-only live sample: it labels the last N parsed lines across `state/*.status` and writes only the eval log.

## Promotion

The first decision that goes automatic, behind one flag: `stuck` from the `worker-status` pack. Everything else in the status tail is unchanged.

Flag: env `JEV_PROMOTE=worker-status:stuck` (`promoteSettings` in `promote.ts`). Unset, empty or any other value is promotion off: the tail behaves exactly as without it, with no Jev call, no throw and no log line. The band is `PROMOTE_MIN_CONFIDENCE = 0.9` and is not configurable.

Behavior, per parsed status line when on: the pack is asked once, before the fleet bead is written, with the same 20-line context, the same timeout (`JEV_SHADOW_TIMEOUT_MS`, default 8000) and the same never-throws guard as shadow mode. With `JEV_SHADOW=1` as well, that one answer is replayed for the shadow outcome line; Jev is never called twice for a line. The promotion applies only when all hold: Jev's verdict is `stuck`, its confidence is >= 0.9, and the regex state is `working`, `paused` or `resolved`. Then the fleet bead is recorded with state `blocked` (the `fm-state:` label moves to blocked) and the comment gains ` [jev: stuck <confidence>, promoted over <regex state>]`. In every other case (any other verdict, confidence below 0.9, regex state `done`/`failed`/`blocked`/`needs-decision`, undecided, timeout, no key, any error) the existing path runs untouched. Scout capture, the cursor and dedup do not change.

Eval log: each call appends one `kind: "promote"` line on the answer's request id: `pack`, `existing` (the regex state), `jev_verdict`, `jev_confidence`, `applied`, and `reason` in `applied`, `not-stuck`, `below-band`, `state-not-promotable`, `unavailable`. The line is written after the line is recorded. `shadow-report.ts` prints a "promote" block (candidates, applied, reason counts) when such lines exist.

The poller plist passes `JEV_PROMOTE` through when set. Deploying it is firstmate's step.

Revert switch: remove the single `JEV_PROMOTE` line from the poller's environment and reload it. No code change.
