# Captain's Deck

A kanban board for work a first mate runs in bb. The first mate charts and
moves tasks with the `bb deck` CLI; the board shows what is charted, underway,
waiting on the captain, awaiting merge, and landed. The only board write is a
captain's answer to an open decision, which is delivered to the first mate's
thread.

## Surfaces

- **Board** — a left-sidebar nav panel with five fixed columns and live thread
  state on every card.
- **CLI** — `bb deck chart|start|ask|merge|land|fail|move|list|show|remove`.
- **Skill** — `skills/captains-deck` teaches agents the lifecycle and rules.

## Settings

- **First mate thread** — where answered decisions are sent as an agent-only
  note. Empty records answers on the board only.

## Requirements

bb 0.44+ with Plugin SDK 0.5.29+.
