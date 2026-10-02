---
name: captains-deck
description: Drive the Captain's Deck kanban board with the `bb deck` CLI. Use when charting new work, starting or finishing a task, raising a decision for the captain, or when asked what is underway, waiting on the captain, awaiting merge, or landed.
---

# Captain's Deck

The Captain's Deck is the captain's board for work the first mate runs. The
board only projects state; the first mate owns it through `bb deck`. The
captain answers open decisions on the board and the answer arrives in the
first mate's thread as an agent-only note.

One card is one unit of work. Keep cards current — a stale board is worse than
no board.

## Lifecycle

| Moment | Command |
| --- | --- |
| Work is agreed or charted, no worker started | `bb deck chart --title "<title>" [--brief "<one line>"] [--kind ship\|scout] [--project <id>] [--bot <name>]` |
| A worker thread actually starts | `bb deck start <task-id> --thread <thread-id>` |
| A real captain decision is needed | `bb deck ask <task-id> --question "<question>" --option "<label>" --option "<label>" [--recommend <number\|label>] [--context "<why now>"]` |
| PR is ready and needs review/merge | `bb deck merge <task-id> --pr <url>` |
| Work landed | `bb deck land <task-id>` |
| Work failed | `bb deck fail <task-id> --reason "<what failed>"` |
| Task no longer relevant | `bb deck remove <task-id>` |

`bb deck list` shows every card with its id; add `--json` when the output
drives code. `bb deck show <task-id>` prints the brief, note, and open decision.

## Rules

1. Run `bb deck list` before changing anything; never guess a task id.
2. Chart work when it is accepted, and start the card in the same dispatch
   when a worker exists — do not leave running work in Charted Next.
3. Only open a Captain's Call when the captain genuinely has to choose: scope
   or direction changes, money, external/public actions, brand decisions, or
   two defensible paths. Routine progress stays out of the Captain's Call.
4. Give every call a recommended option when one is defensible; the board
   marks it.
5. Move cards promptly: `merge` when the PR is up, `land` when it is merged,
   `fail` with a reason when it cannot proceed.
6. Everything else — progress, retries, investigation — is reported to the
   captain in chat, not on the board.
7. The captain's answer arrives as an agent-only note naming the task and the
   chosen option. Continue that task without asking again.
