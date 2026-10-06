# fm-hooks configuration

This directory holds the rule set deployed on the firstmate agent, and the instructions
to deploy it. The rules are data; the action they run is the small shell script at
`bin/fm-hooks-task-card.sh`.

## Rule set

Every rule turns one post-call observation into at most one task-store card. Six rules
fire on a *failure* of an operation whose failure is never routine:

| Rule | Fires on | Why it exists |
|---|---|---|
| `fm-spawn-failure` | `fm-spawn.sh` failure | A failed spawn means a dispatched crew did not come up; the dispatch may be lost. |
| `fm-teardown-failure` | `fm-teardown.sh` failure | A failed teardown leaves a worktree, status line, or inbox inconsistent, which blocks later cleanup. |
| `fm-merge-local-failure` | `fm-merge-local.sh` failure | A failed local merge means an approved branch did not reach local `main`. |
| `fm-pr-merge-failure` | `fm-pr-merge.sh` failure | A failed PR merge leaves an approved branch unmerged on the forge. |
| `fm-fleet-ledger-failure` | `fm-fleet-ledger.sh` failure | A status line reached disk but not the shared ledger, so the supervisor's view of a lane can drift. |
| `fm-lint-workflows-failure` | `fm-lint-workflows.sh` failure | Workflow lint is the gate that catches a malformed workflow before merge; a failure means the gate is not running as intended. |

One rule fires on a *success*, because the call is destructive and its aftermath is worth
confirming:

| Rule | Fires on | Why it exists |
|---|---|---|
| `fm-kill-task-verify` | `fm-kill-task.sh` success | Killing a crew is the most destructive routine call; confirm the killed task's worktree, status line, and inbox were released. |

## Idempotency and rate

Queue delivery is at-least-once across a crash window, so the action is written to be
re-run safely: it files at most one card per (rule, UTC day), keyed by a card id derived
from the rule and the day rather than from the correlation id. Repeated firings of one
rule inside a day collapse into the first card, which carries the triggering correlation
id and a pointer to the durable event record; every occurrence is still appended to
`events.jsonl`. A burst of one failing operation therefore produces one card, not one per
call.

## Deploying

The observer resolves a rules file in this order, and uses the first that exists:
`$FM_HOOK_RULES`, then `<agent-cwd>/fm-hooks.rules.json`, then
`<state root>/fm-hooks.rules.json`. The agent's own process resolves that chain with its
own environment, which the worker's plist does not control, so the deployed rule set is
written to both a cwd-relative and a state-relative candidate:

```sh
HERE=<this checkout>/config
DEPLOY=$HOME/.local/state/fm-hooks
mkdir -p "$DEPLOY"
install -m 600 "$HERE/fm-hooks.rules.json" "$DEPLOY/fm-hooks.rules.json"
install -m 600 "$HERE/fm-hooks.rules.json" "$HOME/fm_home/firstmate/fm-hooks.rules.json"
install -m 700 <this checkout>/bin/fm-hooks-task-card.sh "$DEPLOY/fm-hooks-task-card.sh"
node <this checkout>/bin/fm-hooks-worker.js install --interval 1000 \
  FM_HOOK_QUEUE=... FM_HOOK_RULES="$DEPLOY/fm-hooks.rules.json"
```

Two details matter when the plist is written:

* `FM_HOOK_QUEUE` must name the live queue in the invoking shell, because the plist carries
  that override and nothing else decides which queue the worker drains.
* The plist carries `PATH`, and the rule actions resolve `fm-hooks-task-card.sh` from it.
  The deploy directory must therefore be on the `PATH` used at install time.

## Undo

```sh
node <this checkout>/bin/fm-hooks-worker.js uninstall
rm -f "$HOME/.local/state/fm-hooks/fm-hooks.rules.json" \
      "$HOME/.local/state/fm-hooks/fm-hooks-task-card.sh" \
      "$HOME/fm_home/firstmate/fm-hooks.rules.json"
```

That removes exactly what the deploy added: the launchd label and plist, both rules-file
candidates, and the action script. The queue itself (`jobs/`, `done/`, `failed/`,
`worker/`, `events/`) is observer state and is left alone.
