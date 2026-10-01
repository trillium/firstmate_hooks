# fm-hooks

External, post-call observation of semantic `fm_*` commands for Claude Code, OpenCode, and Pi. This repository does not change Firstmate, intercept PATH, or rewrite/block a command. Harness adapters feed the same normalizer, durable local outbox, and outcome-gated rule evaluator.

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

### Pi

`src/pi-extension.js` observes the declared `tool_execution_start` and `tool_execution_end` lifecycle events. It retains only a recognized Bash command and start metadata by Pi call ID, then normalizes it through the same observer after the matching completion. It never subscribes to input/result-transforming hooks, changes tool data, or stores the arbitrary result payload. Pi's completion event provides an `isError` flag but no stable exit-code contract: `true` maps to failure, `false` to success, and missing or non-boolean values to unknown. Calls without a matching start are ignored. Observer errors are caught so they cannot affect the completed tool call.

Load it for one Pi process, with a fresh disposable queue and the fixture-only rules:

```sh
FM_HOOK_QUEUE="$(mktemp -d "${TMPDIR:-/tmp}/fm-hooks-pi-demo.XXXXXX")" \
FM_HOOK_RULES="$PWD/test/fixtures/pi-demo-rules.json" \
pi --extension "$PWD/src/pi-extension.js"
```

This does not register a global extension or start a worker. The rules enqueue only `printf` fixture actions, and no worker is started. The test suite demonstrates the adapter by supplying harmless `fm_dispatch` / `fm_scout` fixture event data directly; those command strings are never executed.

## Inbox-connect compatibility

The canonical workflow is maintained outside this repository in the Parlay project: `/Users/trilliumsmith/code/parlay/examples/fleet/skills/inbox-handler/SKILL.md` documents the inbox-handler skill; `/Users/trilliumsmith/code/parlay/examples/fleet/pi-inbox-bridge/src/bridge.ts`, `helpers.ts`, `config.ts`, `listener.ts`, `tailer.ts`, and `worker-prompt.md` implement Pi's `/inbox-connect [store]` command. The skill is installed for Claude Code as `~/.claude/skills/inbox-handler` (a symlink to the Parlay source). It describes enrollment and the serial inbox worker procedure; it does not itself implement `/inbox-connect`.

The canonical Pi command defaults to `inbox` (channel `pi-inbox`, assignee `pi-inbox`), accepts one store token and optional `server=http(s)://...`, and persists an enabled marker in the current Pi session. That marker gates two supervised children: `parlay listen` for channel messages and the store-specific tail watcher. Store pokes trigger one serial follow-up worker turn; duplicate pokes coalesce, an idle reconnect checks the store immediately, and `/inbox-disconnect` disables and stops the children. The worker reads the store as source of truth, claims eligible unzoned/`zone:pi`/`zone:default` items, appends dated source-linked knowledge, and closes with a receipt only after that record exists. Specialized zones are left alone. Required local dependencies are the `parlay` CLI, the Parlay relay (normally `http://localhost:31337`), the store wrapper (`inbox`, `task`, etc.), and for the Pi implementation its inbox bridge extension. Enrollment must precede dispatch because unregistered channels reject sends. A second listener is a takeover, not an additive subscription.

In Claude Code, `/inbox-handler` discovers the installed skill and provides the runbook; it does not provide Pi's per-session listener, slash command, or automatic poke-to-turn bridge. The `/inbox-connect` command itself is provided by the Parlay Pi extension, not a Claude Code command.

This repository adds `.opencode/command/inbox-connect.md`, an OpenCode slash-command wrapper that points to the canonical skill and specifies argument validation, store/channel selection, enrollment command, worker procedure, and failure-reporting rules without copying or forking the skill. Discover/invoke it as `/inbox-connect [store]` in OpenCode (or `opencode run --command inbox-connect ...`). It requires the same Parlay endpoint and store wrappers. The wrapper does not install or emulate the Pi extension: OpenCode does not gain Pi's persisted session marker, supervised listener/tailer lifecycle, automatic poke-triggered worker turn, or automatic reconnect. The OpenCode `fm-hooks` plugin remains a separate passive observer of semantic `fm_*` tool calls; its normalized events do not implement inbox delivery. Consequently OpenCode execution is an instructed/manual enrollment and worker workflow, not feature-equivalent automatic wake handling. Do not leave a listener detached or claim automatic wake support. No Claude configuration or canonical skill source is changed.

Compatibility verification covers OpenCode command discovery (`opencode debug config` resolves `inbox-connect` from `.opencode/command/inbox-connect.md`), its required workflow/error instructions, and the shared Claude/OpenCode semantic-hook fixture. The test suite checks the command contract and both adapters with harmless fixtures. An attempted CLI invocation (`opencode run --command inbox-connect 'BAD!'`) failed before the command could execute with `Upstream request failed: Insufficient account funds` (exit 1), so runtime argument/error behavior and actual inbox operations could not be verified through an OpenCode model run. No real persistent Parlay listener was started and no live inbox dispatch/reconnect test was performed; those operations affect shared services. Files changed are `README.md`, `.opencode/command/inbox-connect.md`, and `test/hooks.test.js`.

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
