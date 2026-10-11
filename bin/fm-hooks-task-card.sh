#!/bin/sh
# fm-hooks-task-card.sh - one generic, idempotent rule action.
#
# The worker invokes a rule action as a fixed executable plus argv (shell:false), with
# FM_HOOK_CORRELATION_ID and FM_HOOK_IDEMPOTENCY_KEY in the child environment. Delivery
# is at-least-once across a crash window, so an action must be safe to re-run. This one
# files at most one task-store card per (rule, UTC day) and exits 0 when that card
# already exists.
#
# Usage: fm-hooks-task-card.sh <operation> <correlationId> <ruleId>
#
# The card is deliberately thin: the action is handed the operation, the correlation id
# and its own rule id, and nothing else, so it must never invent findings. It names what
# fired and points at the durable event record the observer wrote for that call, which
# carries the raw command, cwd, session and outcome.
#
# Environment:
#   FM_HOOK_QUEUE      queue root, used to point the card at the event record
#   FM_HOOK_TASK_BIN   task-store CLI (default: "task" from PATH)
set -eu

operation=${1:?operation required}
correlation_id=${2:?correlationId required}
rule_id=${3:?ruleId required}
task_bin=${FM_HOOK_TASK_BIN:-task}
queue_root=${FM_HOOK_QUEUE:-$HOME/.local/state/fm-hooks/queue}
day=$(date -u +%Y%m%d)
observed=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Each rule states, in one line, the operational consequence a reader should act on.
case "$rule_id" in
  fm-spawn-failure)
    title="fm-hooks: fm-spawn.sh failed - a crew may never have started ($day)"
    type=bug; priority=1
    why="A failed spawn means a dispatched crew did not come up. Confirm the dispatch was not lost, and re-dispatch if it was."
    ;;
  fm-teardown-failure)
    title="fm-hooks: fm-teardown.sh failed - a task may be half torn down ($day)"
    type=bug; priority=1
    why="A failed teardown can leave a worktree, status line, or inbox in an inconsistent state that blocks later cleanup."
    ;;
  fm-merge-local-failure)
    title="fm-hooks: fm-merge-local.sh failed - landed work is in doubt ($day)"
    type=bug; priority=1
    why="A failed local merge means the approved branch did not reach local main. Re-run the guarded fast-forward and confirm the head."
    ;;
  fm-pr-merge-failure)
    title="fm-hooks: fm-pr-merge.sh failed - a PR merge did not land ($day)"
    type=bug; priority=1
    why="A failed PR merge leaves an approved branch unmerged on the forge. Check the PR state before re-running the merge."
    ;;
  fm-fleet-ledger-failure)
    title="fm-hooks: fm-fleet-ledger.sh failed - a status line is not in the shared ledger ($day)"
    type=bug; priority=1
    why="The lane wrote its status to disk but the shared fleet ledger did not record it, so the supervisor's view of that lane can drift."
    ;;
  fm-lint-workflows-failure)
    title="fm-hooks: fm-lint-workflows.sh failed - the workflow lint lane is broken ($day)"
    type=bug; priority=1
    why="Workflow lint is the check that catches a malformed workflow before merge. A failure here means that gate is not running as intended."
    ;;
  fm-brief-failure)
    title="fm-hooks: fm-brief.sh failed - a crew brief was not written ($day)"
    type=bug; priority=1
    why="A failed brief means the task has no brief.md to dispatch from. Re-run the scaffold and confirm data/<task>/brief.md exists before spawning."
    ;;
  fm-fleet-sync-failure)
    title="fm-hooks: fm-fleet-sync.sh failed - project clones may have drifted ($day)"
    type=bug; priority=1
    why="A failed fleet sync leaves project clones behind origin, so new worktrees start from a stale default branch. Re-run it and read the STUCK lines."
    ;;
  fm-send-failure)
    title="fm-hooks: fm-send.sh failed - a message to a crew was not delivered ($day)"
    type=bug; priority=1
    why="A failed send means a crew never received a steering message or a captain answer. Check its inbox and re-send."
    ;;
  fm-kill-task-verify)
    title="fm-hooks: verify state released after fm-kill-task.sh ($day)"
    type=task; priority=2
    why="Killing a crew is the most destructive routine call. Confirm the killed task's worktree, status line, and inbox were actually released."
    ;;
  *)
    title="fm-hooks: rule $rule_id fired ($day)"
    type=task; priority=2
    why="Unmapped rule id; the rule file names its own intent."
    ;;
esac

# The id is derived from the rule and the UTC day, never from the correlation id, so
# repeated firings of one rule collapse into a single card instead of one per call.
# cksum is POSIX and needs no hashing tool on PATH.
suffix=$(printf '%s' "$rule_id-$day" | cksum | awk '{printf "%08x", $1}')
card="task-$suffix"

# The card may already exist because this rule fired earlier today, or because a
# previous delivery of this same job crashed after creating it. Either way, done.
if "$task_bin" show "$card" >/dev/null 2>&1; then
  printf '%s\n' "$card"
  exit 0
fi

body=$(cat <<EOF
$why

rule: $rule_id
operation: $operation
correlationId: $correlation_id
observed (UTC): $observed
event record: $queue_root/events/$correlation_id-$operation.json
worker idempotency key: ${FM_HOOK_IDEMPOTENCY_KEY:-<unset>}

At most one card per rule per UTC day: repeat firings that day are folded into this
card, and every occurrence remains in $queue_root/events.jsonl.
EOF
)

"$task_bin" create --id "$card" --silent \
  --title "$title" -t "$type" -p "$priority" -l fm-hooks,rules -d "$body"
