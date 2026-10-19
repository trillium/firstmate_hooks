# fm-hooks

External, post-call observation of semantic `fm_*` commands for Claude Code, OpenCode, and Pi. This repository does not change Firstmate, intercept PATH, or rewrite/block a command. Harness adapters feed the same normalizer, durable local outbox, and outcome-gated rule evaluator.

## Requirements

TypeScript run directly by bun (`/Users/trilliumsmith/.bun/bin/bun`); no build step and no JavaScript, enforced by `.githooks/pre-commit`. Dev dependencies are only `typescript` and `/bun`. Keep this repository and its configuration outside Firstmate itself.

## Install

`FM_HOOK_QUEUE` and `FM_HOOK_RULES` are optional. With neither set, fm-hooks resolves an absolute state root from its own identity, never from the working directory: the queue defaults to `$FM_HOOK_STATE_DIR/queue` when `FM_HOOK_STATE_DIR` is set, otherwise `$FM_HOME/state/fm-hooks/queue`, otherwise `$XDG_STATE_HOME/fm-hooks/queue`, and finally `~/.local/state/fm-hooks/queue`. `FM_HOOK_QUEUE` remains an explicit override, and a relative override is anchored to the home directory rather than to `process.cwd()`. Hooks do not launch follow-on actions; the worker consumes queued actions without shell evaluation, and it must be supervised — see [Supervising the worker](#supervising-the-worker), which is the only part of this repository that has to be running for rules to fire at all.

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

Only explicitly configured rules fire. The scheduler writes a unique job keyed by correlation ID + rule ID using exclusive file creation; repeated hook deliveries cannot enqueue that rule twice. Queue files are local JSON under `queue/events`, `queue/jobs`, `queue/done`, and `queue/failed`. Every observation is also appended as one JSON object per line to `events.jsonl` in the queue directory. A non-matching bash call is appended as `{"type":"seen","matched":false,...}` so a tail proves the hook is loaded before the first Firstmate call. Tail it with `tail -f "${FM_HOOK_QUEUE:-$HOME/.local/state/fm-hooks/queue}/events.jsonl"` (substitute your resolved queue root; see below). Keep the queue on durable storage and restrict access (files are created mode 0600). Do not place secrets in event metadata.

### State location, migration, and log rotation

Observer state never lands in the directory an agent happens to run in. Queue files are local JSON under `<queue>/events`, `<queue>/jobs`, `<queue>/done`, and `<queue>/failed`, and `FM_HOOK_QUEUE` overrides the default queue root.

An earlier version defaulted to the relative path `.fm-hooks/queue`, so repositories an agent ran in may still contain one. On the first run against the default queue, fm-hooks adopts such a legacy directory: it copies the events, the JSONL log, and the worker outcome records into `<queue>/migrated/<repo-key>/`, re-queues any pending jobs into `<queue>/jobs`, writes a `MIGRATED.json` marker, and prints a one-time notice on stderr naming both locations. It never moves, deletes, or creates anything inside the repository, and the legacy directory is left in place for the operator to delete. Adoption is per legacy directory and is idempotent, and an explicit `FM_HOOK_QUEUE` adopts nothing because the operator then owns the layout.

### Supervising the worker

Rules do not fire because a hook ran; they fire because something drains the queue. Observation and execution are deliberately separate processes — the hook must stay inside the tool's latency budget, and a queued action must not be able to fail a completed Firstmate call — which means **the entire rule-evaluation half of fm-hooks is inert unless a worker is running.** This is not a theoretical risk: the repository shipped a worker that drained the queue once and exited, there was nothing to supervise, nothing supervised it, and no `jobs/`, `done/`, or `failed/` directory was ever created on a live queue. A correct-looking worker and a working observation log are not evidence that rules fire.

`bin/fm-hooks-worker.ts` is the operator surface. Use `status` first — it answers the only question that matters, and it answers it as data:

    /Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-worker.ts status            # JSON liveness report; exit 1 when rules are not live
    /Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-worker.ts status --stale-after 30000

`status` reports presence and progress separately and only calls a worker **alive** when its pid exists *and* its heartbeat is advancing. That distinction is the whole point: a pid in the process table proves a process started, not that it is working, and a worker whose pid is present but whose beat has stopped is wedged. `ruleEvaluationLive` is the field to act on. A live supervisor over a dead worker reports `false`, because the parent running does not make the child work.

Three processes, three roles:

- **worker** (`src/worker.ts --watch`) stays resident and drains the queue every `--interval` ms. It beats to `<queue>/worker/worker.json` on *every* cycle, including idle ones, so an idle-but-healthy worker is distinguishable from a hung one. It also appends `{"type":"worker","phase":"start"|"cycle"|"beat"|"stop",...}` to `events.jsonl`, so a single `tail -f events.jsonl` shows both halves of the pipeline: what was observed, and who is draining it.
- **supervisor** (`src/worker.ts --supervise`) runs the worker as a child and restarts it whenever it exits, with capped exponential backoff. Every restart is counted in `<queue>/worker/supervisor.json`, so a crash-looping worker looks like a crash-looping worker rather than a healthy one with a low job count. The supervisor also re-writes its own beat every 5 seconds while the child is up, so `status` reports a healthy supervisor as alive rather than aging out after its start-time beat.
- **launchd** (`fm-hooks-worker install`) keeps the supervisor alive across crashes and reboot, under the per-user label `com.fm-hooks.worker`. It writes only `~/Library/LaunchAgents/com.fm-hooks.worker.plist`, carrying only the environment fm-hooks actually resolves against (`FM_HOOK_QUEUE`, `FM_HOOK_*`, `FM_HOME`, `XDG_STATE_HOME`, `HOME`, `PATH`) — never the caller's whole environment. `install` is idempotent, `uninstall` boots out and removes exactly what `install` wrote, and `plist` prints the file without touching launchd.

    /Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-worker.ts install --interval 1000   # launchd supervises the supervisor
    /Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-worker.ts uninstall
    npm run worker:status

Both processes handle `SIGINT`/`SIGTERM` and leave a final beat, so a stopped worker reads as stopped rather than as a stale gap. `--interval` set on a supervised launch is passed through `FM_HOOK_WORKER_INTERVAL_MS`, the only channel a plist has.

Rules are still only as good as the rule file. With no rules file, or a rule set that matches nothing, a perfectly healthy worker drains an empty queue forever and reports `processed: 0` — alive and correct, doing nothing. Check `processed` and `lastResultAt`, not just `ruleEvaluationLive`.

### Heartbeat files

`<queue>/worker/worker.json` and `<queue>/worker/supervisor.json` hold one record per role, written through a temporary file and renamed so a reader never sees a partial beat and mistakes a busy worker for a dead one. Each records `pid`, `startedAt`, `updatedAt`, and the worker's `cycles`, `processed`, `done`, `failed`, `retried`, `intervalMs`, `lastResultAt`, and `lastError`; the supervisor's adds `restarts` and `lastExit`. Files are mode 0600 and hold no command output or action payloads. A beat's temporary file is removed when its write or rename fails, and every beat also sweeps `<queue>/worker/` for `<role>.json.<pid>.<uuid>.tmp` files whose pid is no longer running, so a process killed between writing and renaming (launchd's SIGKILL, a crash) leaves no litter that accumulates across restarts; a temporary whose pid is alive is a write in flight and is left alone. A worker that dies mid-cycle leaves its last count intact rather than resetting it, so an unexplained drop in `processed` is visible after a restart.

`events.jsonl` is bounded. Once it reaches `FM_HOOK_EVENT_LOG_MAX_BYTES` (default 5 MiB) it rolls to `events.jsonl.1`: the oldest retained roll is dropped, older rolls shift down, and the live log restarts. `FM_HOOK_EVENT_LOG_KEEP` (default 3) sets how many rolls are kept, bounding the log at roughly `FM_HOOK_EVENT_LOG_MAX_BYTES x (FM_HOOK_EVENT_LOG_KEEP + 1)`. Setting `FM_HOOK_EVENT_LOG_MAX_BYTES=0` disables rotation explicitly.

`fm-hooks.rules.json` is legitimately per-project, so a project-local file is still discovered by convention. That candidate is read-only -- fm-hooks never creates a rules file -- and the fallback is state-resident, so a missing rules file can never cause a write inside a product tree. Precedence is `FM_HOOK_RULES`, then `<project>/fm-hooks.rules.json`, then `<state root>/fm-hooks.rules.json`. A malformed file is an error rather than a silent fall-through to another rule set.

State that does land inside a working tree stays out of that tree's view. An explicit `FM_HOOK_STATE_DIR` or `FM_HOOK_QUEUE` can point into a checkout, and a home directory can itself be a repository; there an untracked observer directory is indistinguishable from uncommitted work, which is what stopped the landed-work guard from cleaning up finished tasks. So whenever fm-hooks creates its state directory inside a working tree it appends the path to that repository's local exclude file, `.git/info/exclude`, and `git status` stays clean. Local rather than `.gitignore`, because a committed ignore rule would be a change to a repository fm-hooks only observes.

Exclusion is exact about which repository it writes to. `git rev-parse` identifies the working tree from the state directory itself, so a plain checkout, a linked worktree, and a submodule each get the right answer, and a bare repository or a directory outside any repository gets none. For a linked worktree the pattern goes to the *common* git dir (`<git-common-dir>/info/exclude`): git ignores an `info/exclude` written under `.git/worktrees/<name>`, so the obvious path is silently ineffective. A path already covered by any ignore source -- `.gitignore`, `core.excludesFile`, an existing exclude entry -- is left alone, and the working tree root is never excluded. Writing is one appended line, bounded by a five-second timeout on every git query, and memoized per process.

Refusal is silent and never fails observation. If the exclude file cannot be written, if there is no git, or if the state directory lies outside every working tree, fm-hooks records the call anyway and says nothing: an observer that cannot hide itself has still observed the tool call. This covers only state fm-hooks creates. A legacy `.fm-hooks/` directory from an earlier version is still left exactly as found for the operator to delete.

The worker passes `FM_HOOK_CORRELATION_ID` and `FM_HOOK_IDEMPOTENCY_KEY` to the action and invokes a fixed executable + argv (`shell:false`). Design actions to be idempotent using that key: a crash after an external action succeeds but before the job is marked done can cause at-least-once execution. A failed action is retried, not dropped: it stays in `jobs/` with an `attempts` count and a `notBefore` exponential backoff (`FM_HOOK_RETRY_BACKOFF_MS`, default 5s, doubling, capped by `FM_HOOK_RETRY_MAX_BACKOFF_MS`, default 10 min) and moves to `failed/` only after `FM_HOOK_MAX_ATTEMPTS` (default 5; `1` fails on the first error). `status` and the heartbeat count those retries as `retried`, so a worker waiting out a store outage reads as retrying rather than idle. An action running longer than `FM_HOOK_ACTION_TIMEOUT_MS` (default 60s, `0` disables) is killed and counts as a failure. After fixing the cause, `fm-hooks-worker.ts retry-failed` moves everything in `failed/` back to `jobs/` with a fresh attempt budget. Hooks catch observer errors and return normally so instrumentation cannot fail the observed call. Local persistence is the only synchronous side effect in the post-hook.

### Claude Code

Add these hooks to the applicable Claude settings file; merge with existing hooks rather than replacing them. Register only post events—no `PreToolUse` behavior is needed:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "FM_HOOK_QUEUE=/absolute/path/queue FM_HOOK_RULES=/absolute/path/fm-hooks.rules.json /Users/trilliumsmith/.bun/bin/bun /absolute/path/fm-hooks/src/claude-hook.ts" }]
    }],
    "PostToolUseFailure": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "FM_HOOK_QUEUE=/absolute/path/queue FM_HOOK_RULES=/absolute/path/fm-hooks.rules.json /Users/trilliumsmith/.bun/bin/bun /absolute/path/fm-hooks/src/claude-hook.ts" }]
    }]
  }
}
```

The adapter observes only Bash and only post-success/post-failure. Claude's Bash input is a shell command string, not argv; args in normalized events are a conservative tokenization and `rawCommand` is authoritative. If the lifecycle event does not supply a call ID, the deterministic fallback key collapses identical commands in the same session.

### OpenCode

Install `src/opencode-plugin.ts` as a plugin at the OpenCode-supported project/global plugin location (for example, a project `.opencode/plugins/fm-hooks.ts` wrapper exporting this module). Configure `FM_HOOK_QUEUE` and `FM_HOOK_RULES` in the OpenCode process environment. The plugin observes `tool.execute.before` only to retain an in-memory start time, then observes Bash/shell `tool.execute.after`; it does not mutate hook inputs or outputs.

The installed compatibility evidence was OpenCode CLI 1.18.30 with `@opencode-ai/plugin` types 1.15.3. Verify the API against your actual versions. Types do not guarantee an exit-code field or an explicit failure callback. The adapter accepts explicit `metadata.exitCode`, `metadata.exit_code`, `metadata.code`, corresponding top-level codes, or explicit `success` booleans. It never infers success from empty output: absent a recognized signal, outcome is `unknown`, and success-only rules do not fire. Project directory/worktree is a baseline cwd, not proof of the spawned shell's cwd. Runtime plugin context and metadata are version-sensitive.

### Pi

`src/pi-extension.ts` observes the declared `tool_execution_start` and `tool_execution_end` lifecycle events. It retains only a recognized Bash command and start metadata by Pi call ID, then normalizes it through the same observer after the matching completion. It never subscribes to input/result-transforming hooks, changes tool data, or stores the arbitrary result payload. Pi's completion event provides an `isError` flag but no stable exit-code contract: `true` maps to failure, `false` to success, and missing or non-boolean values to unknown. Calls without a matching start are ignored. Observer errors are caught so they cannot affect the completed tool call.

Load it for one Pi process, with a fresh disposable queue and the fixture-only rules:

```sh
FM_HOOK_QUEUE="$(mktemp -d "${TMPDIR:-/tmp}/fm-hooks-pi-demo.XXXXXX")" \
FM_HOOK_RULES="$PWD/test/fixtures/pi-demo-rules.json" \
pi --extension "$PWD/src/pi-extension.ts"
```

This does not register a global extension or start a worker. The rules enqueue only `printf` fixture actions, and no worker is started. The test suite demonstrates the adapter by supplying harmless `fm_dispatch` / `fm_scout` fixture event data directly; those command strings are never executed.

## Beads: both directions

Rule actions write what happened into beads (fm -> bead); a separate poller carries the captain's answers back (bead -> fm). All store access goes through the wrapper CLIs (`projects`, `review`, `lifespan`), never bare `bd`; override one with `FM_HOOK_<STORE>_BIN`.

| Rule | Fires on | Effect |
|---|---|---|
| `fm-ledger-timeline` | every recognized `fm-*` call, any outcome | one comment per call on the day's `lifespan-fmhYYYYMMDD` container bead |
| `fm-spawn-project-comment` | `fm-spawn.sh <task> <project>` success | comment on the project's bead |
| `fm-pr-merge-project-comment`, `fm-merge-local-project-comment` | success | comment on the project's bead (project read from `state/<task>.meta`) |
| `fm-branch-outcome-project-comment` | `fm-branch-outcome.sh append` success | comment; a `--verdict captain` outcome also files a `review` item |
| `fm-brief-project-comment` | `fm-brief.sh <task> <repo>` success | comment on the repo's project bead (a `--secondmate` charter names no repo and is ledger-only) |
| `fm-fleet-sync-project-comment` | `fm-fleet-sync.sh [<project>]` success | comment on that project's bead; with no argument, on the fleet project (`FM_HOOK_FLEET_PROJECT`, default `firstmate`) |
| `fm-brief-failure`, `fm-fleet-sync-failure`, `fm-send-failure` | failure | one deduplicated `task` card per rule per UTC day (`fm-hooks-task-card.sh`) |
| `fm-scout-report-capture` | `fm-fleet-ledger.sh appended` success whose status command wrote a `done` line (any `[at=...]` stamp: digits, or an unexpanded shell expression such as `$E` or `$(date +%s)`), for a task with `data/<task>/report.md` | one `brain` bead `brain-fmhscout-<task>` (summary from the done line, report path, task id); a once-only comment on `fleet-<task>` (store `fleet`) and on the backlog line's bead; one `human` `review` bead per captain call in the report (items under a "Captain calls/decisions/input" heading, or a `Captain call:` / `Needs captain input:` line). No report means not a scout: skipped. The poller's status tail (below) runs the same capture when it records a `done` line, so the report is captured whichever signal arrives first; the deterministic id makes the second a no-op. |
| `fm-captain-hold-review` | `fm-captain-hold.sh hold` success | a `human`-labelled `review` bead carrying `fm-task:<task>` and `fm-key:captain-hold-<task>-<n>` |
| `fm-captain-hold-review` | `fm-captain-hold.sh answer <task> --decision-file <f>` success | the task's open hold beads get the decision as a comment, the label `fm-closed-by:fm-hooks`, and are closed; the poller skips closures carrying that label because the answer already reached Firstmate |
| `fm-brief-fleet`, `fm-spawn-fleet`, `fm-control-fleet`, `fm-promote-fleet`, `fm-pr-merge-fleet`, `fm-merge-local-fleet`, `fm-teardown-fleet`, `fm-send-fleet`, `fm-captain-hold-fleet` | success | one comment on the task's `fleet` bead, see [Fleet beads](#fleet-beads-one-bead-per-task) |

`fm-tasks-axi.sh`, `fm-inbox.sh`, `fm-wake-drain.sh`, `fm-crew-state.sh` and `fm-send.sh` success are covered by `fm-ledger-timeline` alone; `fm-wake-drain.sh` and `fm-crew-state.sh` are deliberately ledger-only on failure too (noise).

Help output and read-only subcommands (`lookup`, `open`, `--help`) succeed too and write nothing. The project bead is resolved before anything is minted: first the override map in `config/fm-hooks.projects.json` (`{"overrides": {"<project name>": "<bead id>"}}`, empty by default; `FM_HOOK_PROJECT_CONFIG` points elsewhere), then a bead labelled `project:<name>` (case-insensitive; the registry name from `$FM_HOME/data/projects.md`, or `FM_HOOK_PROJECT_REGISTRY`, is tried too, matched by project name or clone directory), then a bead whose title is exactly that name. A curated bead beats a minted one, and an exact title beats an open-or-closed tie. Only when none exists is `project-fmh-<name>` minted once and reused. A call whose project cannot be resolved is a visible skip (the ledger still has its line).

### Fleet beads: one bead per task

The `fleet` store holds one bead per Firstmate task, id `fleet-<task>`, carrying the task's whole lifecycle as comments. Labels hold the current facts: `fm-task:`, `project:`, `fm-kind:` (`ship`, `scout`, `secondmate`), `fm-mode:`, `fm-harness:`, `fm-model:`, `fm-home:` and one `fm-state:` (`briefed`, `dispatched`, `working`, `needs-decision`, `blocked`, `paused`, `done`, `failed`, `stopped`, `merged`, `cleaned-up`). Open beads are the live fleet; `fm-teardown.sh` success closes the bead, and a later brief of the same task reopens it. `fleet list` is what the fleet is running, `fleet list --status closed` its history, `fleet show fleet-<task>` everything that happened to one task. Day-level history stays in `lifespan`, holds in `review`, project comments in `projects`.

**The store must exist once.** fm-hooks detects it (`fleet list`) before its first write and, if it is missing, runs `brain stores create fleet` and mints the `fleet-charter` bead. To do it by hand instead, or when creation is turned off with `FM_HOOK_FLEET_AUTOCREATE=0` (the action then fails with this command in the error):

    brain stores create fleet

`FM_HOOK_FLEET_BIN` overrides the wrapper like any other store and `FM_HOOK_FLEET_STORE` renames it.

**Which task?** Resolved in order: a literal argument (not a `$variable`), then the call's own success line on stdout (`spawned <task> harness=`, `scaffolded: .../data/<task>/brief.md`, `merged fm/<task> into local main`), then, for `fm-spawn.sh`/`fm-brief.sh` only, the one `state/*.meta` or `data/*/brief.md` written inside the call window. Two candidates in the window, or none, is `{"skipped":"unresolved"}`, never a guess; the ledger still has the call.

**Status tail.** The poller also tails `$FM_HOME/state/*.status` every cycle (`FM_HOOK_STATUS_TAIL=0` turns it off; `fm-hooks-bead-poller status-tail --once` runs one pass). A `working|needs-decision|blocked|paused|done|failed [at=<epoch>]: text` line becomes a comment on `fleet-<task>` and moves `fm-state:`; `resolved` lines comment without changing the state; anything else is skipped. The first pass never backfills: it records where each file ends and reads nothing. A file that appears later is read from its start, a truncated or replaced file restarts at zero, a partial last line waits for its newline, and a store failure holds the cursor at the failed line. A `done` line also runs the scout-report capture for that task (the `fm-scout-report-capture` row above: `brain-fmhscout-<task>` when `data/<task>/report.md` exists, otherwise a visible skip in the pass result), and a capture failure holds the cursor the same way. Cursor: `<queue>/status-tail/cursor.json`, written like the heartbeat files: through a `cursor.json.<pid>.<uuid>.tmp` temporary that is removed on a failed write, with every write sweeping the directory for temporaries whose writer is no longer running. Comment ids hash (task, byte offset, line), so a replay writes nothing. `needs-decision` and `blocked` do not open `review` beads; only `fm-captain-hold.sh hold` does.

**Retiring old duplicates.** Before resolution existed, calls could mint a `project-fmh-<name>` bead next to a curated one. `/Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-project-merge.ts` is a one-time clean-up: it prints, for each such bead that now resolves to a real project bead, the comments it would move and the close it would make. Nothing is written unless `--apply` is passed; with it, comments the real bead lacks (matched by `[cid:...]` marker, else exact text) are copied across and the duplicate is closed with a pointer to the real bead. A minted bead with no real counterpart is left alone, and a repeat run writes nothing.

**Idempotence.** Queue delivery is at-least-once, and a re-observed call re-runs its job once the first has moved to `done/`. So idempotence lives in the store, never in local state: created beads have ids derived from the correlation id, and every comment carries a `[cid:<correlation prefix>]` marker that is checked before writing. A re-delivery performs no write. A store failure exits non-zero, so the job lands in `failed/` instead of vanishing.

**Poller (bead -> fm).** `bin/fm-hooks-bead-poller.ts` finds `review` beads (and `human`-labelled beads in the other stores in `FM_HOOK_POLL_STORES`, default `review,task`) closed since its cursor and relays each once: a hold bead via `fm-send.sh <task> --resolve-key <key> <answer>`, any other via `fm-inbox.sh note --request-id <id>`. `brain human respond` adds a comment and closes, so a response is a closure. The first run starts at "now" and never backfills (`--since ISO` overrides it once). Cursor and relayed set live in `<queue>/poller/cursor.json`, written and swept the same way as the status-tail cursor; the cursor never advances past a bead whose relay failed, a bead is marked relayed only after its relay succeeded, and a repeated note is a no-op through `--request-id`. A failed `--resolve-key` send falls back to a note so the answer still arrives. Relays go through `$FM_HOME/bin/fm-send.sh` and `fm-inbox.sh` (`FM_HOME` defaults to `~/fm_home/firstmate`; `FM_HOOK_FM_BIN_DIR` overrides the directory).

```sh
/Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-bead-poller.ts once|watch|status|plist|install|uninstall [--queue DIR] [--interval MS] [--since ISO]
```

`install` writes `~/Library/LaunchAgents/com.fm-hooks.bead-poller.plist` (`KeepAlive`, a PATH with bun and `~/.local/bin`) and loads it beside the worker's agent.

**Health.** `/Users/trilliumsmith/.bun/bin/bun bin/fm-hooks-worker.ts health [--require-poller]` goes beyond `status`: it fails (exit 1, one `fm-hooks health:` line per cause on stderr, full JSON on stdout) when the worker is not beating, no rules are loaded, a rule's action is not on `PATH`, a pending job is older than the drain limit, jobs sit in `failed/`, the live rules file differs from the shipped `config/fm-hooks.rules.json`, the deploy clone is behind its upstream (`health` runs `git fetch` to know), or (with `--require-poller`) the poller is not polling.

**Live deployment record (2026-10-11).** Shared clone at `dd6a8da`, `com.fm-hooks.worker` and `com.fm-hooks.bead-poller` loaded. `health --require-poller`, run with the worker's `PATH`, exited 0: `healthy: true`, worker alive, 13 rules live, 0 pending / 0 failed jobs, poller alive. A real `fm-captain-hold.sh --help` call produced a timeline comment on `lifespan-fmh20261011`; a closed `human` review test bead was relayed once through `fm-inbox.sh note`. `health` resolves actions on the *caller's* `PATH`, so run it with the plist's `PATH` (deploy dir first), not a bare shell's.

Deploy and undo steps are in `config/README.md`. A failed Bash call reports one exit code, so a `*-failure` rule fires only when the `fm-*` invocation decided it. An invocation piped into another stage, guarded by `||`, backgrounded, or followed by another command after `;` or a newline records outcome `unknown` instead of `failure`; an invocation followed by `&&` still counts, because the chain stops at it.

## Inbox-connect compatibility

The canonical workflow is maintained outside this repository in the Parlay project: `/Users/trilliumsmith/code/parlay/examples/fleet/skills/inbox-handler/SKILL.md` documents the inbox-handler skill; `/Users/trilliumsmith/code/parlay/examples/fleet/pi-inbox-bridge/src/bridge.ts`, `helpers.ts`, `config.ts`, `listener.ts`, `tailer.ts`, and `worker-prompt.md` implement Pi's `/inbox-connect [store]` command. The skill is installed for Claude Code as `~/.claude/skills/inbox-handler` (a symlink to the Parlay source). It describes enrollment and the serial inbox worker procedure; it does not itself implement `/inbox-connect`.

The canonical Pi command defaults to `inbox` (channel `pi-inbox`, assignee `pi-inbox`), accepts one store token and optional `server=http(s)://...`, and persists an enabled marker in the current Pi session. That marker gates two supervised children: `parlay listen` for channel messages and the store-specific tail watcher. Store pokes trigger one serial follow-up worker turn; duplicate pokes coalesce, an idle reconnect checks the store immediately, and `/inbox-disconnect` disables and stops the children. The worker reads the store as source of truth, claims eligible unzoned/`zone:pi`/`zone:default` items, appends dated source-linked knowledge, and closes with a receipt only after that record exists. Specialized zones are left alone. Required local dependencies are the `parlay` CLI, the Parlay relay (normally `http://localhost:31337`), the store wrapper (`inbox`, `task`, etc.), and for the Pi implementation its inbox bridge extension. Enrollment must precede dispatch because unregistered channels reject sends. A second listener is a takeover, not an additive subscription.

In Claude Code, `/inbox-handler` discovers the installed skill and provides the runbook; it does not provide Pi's per-session listener, slash command, or automatic poke-to-turn bridge. The `/inbox-connect` command itself is provided by the Parlay Pi extension, not a Claude Code command.

This repository adds `.opencode/command/inbox-connect.md`, an OpenCode slash-command wrapper that points to the canonical skill and specifies argument validation, store/channel selection, enrollment command, worker procedure, and failure-reporting rules without copying or forking the skill. Discover/invoke it as `/inbox-connect [store]` in OpenCode (or `opencode run --command inbox-connect ...`). It requires the same Parlay endpoint and store wrappers. The wrapper does not install or emulate the Pi extension: OpenCode does not gain Pi's persisted session marker, supervised listener/tailer lifecycle, automatic poke-triggered worker turn, or automatic reconnect. The OpenCode `fm-hooks` plugin remains a separate passive observer of semantic `fm_*` tool calls; its normalized events do not implement inbox delivery. Consequently OpenCode execution is an instructed/manual enrollment and worker workflow, not feature-equivalent automatic wake handling. Do not leave a listener detached or claim automatic wake support. No Claude configuration or canonical skill source is changed.

Compatibility verification covers OpenCode command discovery (`opencode debug config` resolves `inbox-connect` from `.opencode/command/inbox-connect.md`), its required workflow/error instructions, and the shared Claude/OpenCode semantic-hook fixture. The test suite checks the command contract and both adapters with harmless fixtures. An attempted CLI invocation (`opencode run --command inbox-connect 'BAD!'`) failed before the command could execute with `Upstream request failed: Insufficient account funds` (exit 1), so runtime argument/error behavior and actual inbox operations could not be verified through an OpenCode model run. No real persistent Parlay listener was started and no live inbox dispatch/reconnect test was performed; those operations affect shared services. Files changed are `README.md`, `.opencode/command/inbox-connect.md`, and `test/hooks.test.js`.

## Event contract

Each recognized event contains `operation`, tokenized `args`, exact `rawCommand`, `cwd`, optional `project`, `harness`, `sessionId`, `callId`, deterministic `correlationId`, `outcome` (`success`, `failure`, or `unknown`), optional `exitCode`, start/finish timestamps, duration when available, result metadata, and adapter source. Unknown is distinct and cannot satisfy success-only rules. Claude success/failure lifecycle event names provide the outcome class; a numeric exit code is retained only if present. OpenCode reports success/failure only for explicit metadata as above.

A call is a Firstmate call when its command basename matches `/^fm[-_][A-Za-z0-9_.-]+$/`. That covers `fm-spawn.sh`, `bin/fm-send.sh`, and `fm_dispatch` alike. It is not a list of approved names. The command word must be the call itself, optionally after a path, preceding environment assignments, or a compound-command lead (`do`, `then`, `if`, `while`, `{`), at a shell command-list segment start. A script passed to `bash -c` (or `sh`/`dash`/`ksh`/`zsh -c`, including flag clusters such as `-lc`) is parsed by the same rules one quoting level down, so `bash -c 'for t in a b; do fm-spawn.sh "$t"; done'` is a call to `fm-spawn.sh`; a spawn loop that prints several `spawned <task>` lines records every task. Echoed text, comments, substrings, and names that merely contain `fm` do not match. This is not a shell parser; heredocs, command substitution, functions, aliases, interactive shells, scripts running outside harness tool events, and non-Bash tools are unsupported. Aliases and shell-resolved names are not recognized. A rule with `"operation": "*"` runs after any recognized Firstmate call whose outcome matches. A named operation still matches only that call.

## Validation

```sh
npm test
```

Tests use harmless command strings and temporary directories only; they never invoke Firstmate or a configured action. The suite covers quoted args, command lists, false positives, equivalent Claude/OpenCode event normalization, unknown/failure outcome handling, the `fm_dispatch -> verification` and `fm_scout -> report review` rules, duplicate event delivery, durable job consumption, and action queue idempotency. A dedicated suite covers state-path resolution: that the default queue root is absolute and independent of the working directory, the override precedence chain, legacy-queue adoption and its idempotence, event-log rotation bounds, and an end-to-end run of the real adapters inside a scratch `git` repository asserting `git status --porcelain` is unchanged. A third suite covers the supervised worker: watch mode draining a queued rule action and asserting the action's own side effect on disk rather than the worker's opinion of it, a non-matching outcome enqueuing nothing, a never-run queue reporting dead, a running-but-silent worker reporting dead, supervisor restart counting, a live supervisor over a dead worker reporting not-live, a real resident `supervise` process draining a real queue end to end, CLI status exit codes, and the launchd plist's contents. For a live harness smoke test, use harmless fixture commands such as `printf marker`, `sh -c 'exit 7'`, and deliberately non-side-effecting `fm_dispatch`-shaped fixture text in a disposable configuration. Never run real task actions during adapter tests.

## Compatibility gaps

- OpenCode's after callback is the closest available post-call surface, but its type contract does not promise a reliable exit status; unknown is the safe default.
- OpenCode has no typed failure-specific tool callback in the inspected API. An absent after event yields no normalized completion; this layer does not infer one.
- Claude provides command text rather than a true argv vector; normalized args are best-effort.
- Start times are process-local to OpenCode and unavailable after plugin restart; call ID and raw command remain the deduplication basis.
- This covers harness-observed tool calls, not arbitrary scripts, interactive shell commands, or every possible fm_* invocation.
- Queue delivery is durable and enqueue is idempotent; external action execution is at-least-once across a crash window, so configured actions must honor the supplied idempotency key.

## Development

Everything is TypeScript run by bun: `bun test`, `bun run typecheck` (`bunx tsc --noEmit`), and `bun run <script>` from `package.json`. Entry points carry `#!/usr/bin/env bun`. The launchd plists run `/Users/trilliumsmith/.bun/bin/bun <entry>.ts`.

`bun install` runs `scripts/install-githooks.ts`, which sets `core.hooksPath=.githooks`: `pre-commit` rejects staging any added or modified `.js`/`.mjs`/`.cjs`/`.jsx` file, and `pre-push` runs `bun test` and `bun tsc --noEmit`. To reuse it in another project, copy `scripts/install-githooks.ts` and `.githooks/` there, or run `bun scripts/install-githooks.ts /path/to/repo` (it copies the hooks into a repo that has none).

## License

MIT licensed; see [LICENSE](LICENSE).
