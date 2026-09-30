# fm-hooks

External, post-call observation of semantic `fm_*` commands for Claude Code and OpenCode. This repository does not change Firstmate, intercept PATH, or rewrite/block a command. Both harness adapters feed the same normalizer, durable local outbox, and outcome-gated rule evaluator.

## Requirements

Node.js 20+. No runtime dependencies. Keep this repository and its configuration outside Firstmate itself.

## Install

Set `FM_HOOK_QUEUE` to a durable local directory shared by the hook process and worker. Set `FM_HOOK_RULES` to a rules JSON file. Hooks do not launch follow-on actions; run `node /path/to/fm-hooks/src/worker.js` as a separately supervised process or scheduled job. The worker consumes queued actions without shell evaluation.

Example `fm-hooks.rules.json` (replace executable paths and arguments to match your task-store CLI):

```json
{
  "rules": [
    {
      "id": "verify-successful-dispatch",
      "operation": "fm_dispatch",
      "outcomes": ["success"],
      "action": { "command": "/absolute/path/to/task", "args": ["q", "Verify dispatch {correlationId}"] }
    },
    {
      "id": "review-completed-scout",
      "operation": "fm_scout",
      "outcomes": ["success"],
      "action": { "command": "/absolute/path/to/task", "args": ["q", "Review scout report {correlationId}"] }
    }
  ]
}
```

Only explicitly configured rules fire. The scheduler writes a unique job keyed by correlation ID + rule ID using exclusive file creation; repeated hook deliveries cannot enqueue that rule twice. Queue files are local JSON under `queue/events`, `queue/jobs`, `queue/done`, and `queue/failed`. Keep the queue on durable storage and restrict access (files are created mode 0600). Do not place secrets in event metadata.

The worker passes `FM_HOOK_CORRELATION_ID` and `FM_HOOK_IDEMPOTENCY_KEY` to the action and invokes a fixed executable + argv (`shell:false`). Design actions to be idempotent using that key: a crash after an external action succeeds but before the job is marked done can cause at-least-once execution. Failed actions move to `failed/` for operator inspection; they are not silently retried. Hooks catch observer errors and return normally so instrumentation cannot fail the observed call. Local persistence is the only synchronous side effect in the post-hook.

### Claude Code

Add these hooks to the applicable Claude settings file; merge with existing hooks rather than replacing them. Register only post events—no `PreToolUse` behavior is needed:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "FM_HOOK_QUEUE=/absolute/path/queue FM_HOOK_RULES=/absolute/path/fm-hooks.rules.json node /absolute/path/fm-hooks/src/claude-hook.js" }]
    }],
    "PostToolUseFailure": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "FM_HOOK_QUEUE=/absolute/path/queue FM_HOOK_RULES=/absolute/path/fm-hooks.rules.json node /absolute/path/fm-hooks/src/claude-hook.js" }]
    }]
  }
}
```

The adapter observes only Bash and only post-success/post-failure. Claude's Bash input is a shell command string, not argv; args in normalized events are a conservative tokenization and `rawCommand` is authoritative. If the lifecycle event does not supply a call ID, the deterministic fallback key collapses identical commands in the same session.

### OpenCode

Install `src/opencode-plugin.js` as a plugin at the OpenCode-supported project/global plugin location (for example, a project `.opencode/plugins/fm-hooks.js` wrapper exporting this module). Configure `FM_HOOK_QUEUE` and `FM_HOOK_RULES` in the OpenCode process environment. The plugin observes `tool.execute.before` only to retain an in-memory start time, then observes Bash/shell `tool.execute.after`; it does not mutate hook inputs or outputs.

The installed compatibility evidence was OpenCode CLI 1.18.30 with `@opencode-ai/plugin` types 1.15.3. Verify the API against your actual versions. Types do not guarantee an exit-code field or an explicit failure callback. The adapter accepts explicit `metadata.exitCode`, `metadata.exit_code`, `metadata.code`, corresponding top-level codes, or explicit `success` booleans. It never infers success from empty output: absent a recognized signal, outcome is `unknown`, and success-only rules do not fire. Project directory/worktree is a baseline cwd, not proof of the spawned shell's cwd. Runtime plugin context and metadata are version-sensitive.

## Event contract

Each recognized event contains `operation`, tokenized `args`, exact `rawCommand`, `cwd`, optional `project`, `harness`, `sessionId`, `callId`, deterministic `correlationId`, `outcome` (`success`, `failure`, or `unknown`), optional `exitCode`, start/finish timestamps, duration when available, result metadata, and adapter source. Unknown is distinct and cannot satisfy success-only rules. Claude success/failure lifecycle event names provide the outcome class; a numeric exit code is retained only if present. OpenCode reports success/failure only for explicit metadata as above.

Recognition is intentionally narrow: direct `fm_dispatch` and `fm_scout` command words (optionally with a path or preceding environment assignments) at shell command-list segment starts. It does not match echoed text, comments, substrings, or arbitrary `fm_*` names. This is not a shell parser; complex constructs, pipelines, functions, aliases, interactive shells, scripts running outside harness tool events, and non-Bash tools are unsupported. A directly invoked executable whose basename is `fm_dispatch` or `fm_scout` is recognized, including an explicit path; aliases and shell-resolved names are not. Expand the allowlist/parser only with fixture coverage.

## Validation

```sh
npm test
```

Tests use harmless command strings and temporary directories only; they never invoke Firstmate or a configured action. The suite covers quoted args, command lists, false positives, equivalent Claude/OpenCode event normalization, unknown/failure outcome handling, the `fm_dispatch -> verification` and `fm_scout -> report review` rules, duplicate event delivery, durable job consumption, and action queue idempotency. For a live harness smoke test, use harmless fixture commands such as `printf marker`, `sh -c 'exit 7'`, and deliberately non-side-effecting `fm_dispatch`-shaped fixture text in a disposable configuration. Never run real task actions during adapter tests.

## Compatibility gaps

- OpenCode's after callback is the closest available post-call surface, but its type contract does not promise a reliable exit status; unknown is the safe default.
- OpenCode has no typed failure-specific tool callback in the inspected API. An absent after event yields no normalized completion; this layer does not infer one.
- Claude provides command text rather than a true argv vector; normalized args are best-effort.
- Start times are process-local to OpenCode and unavailable after plugin restart; call ID and raw command remain the deduplication basis.
- This covers harness-observed tool calls, not arbitrary scripts, interactive shell commands, or every possible fm_* invocation.
- Queue delivery is durable and enqueue is idempotent; external action execution is at-least-once across a crash window, so configured actions must honor the supplied idempotency key.
