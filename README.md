# Captain's Deck

**See the whole crew. Unblock what matters. Let the first mate ship the rest.**

Captain's Deck is a kanban board inside bb for work a first mate runs: charted
tasks, what is underway, the captain's calls waiting on you, merges awaiting
review, and landings. The board is read-only except for a Captain's Call —
click the card, pick an option, add a note, and the answer is delivered to the
first mate's thread.

The board is a projection. The first mate owns the state through the
`bb deck` CLI; the board never invents work.

## Install

```sh
bb plugin install git:https://github.com/deimantasnork/bb-plugin-captains-deck.git@semver:^0.2.0
```

Requires bb 0.44 or newer.

## The board

| Column | Meaning |
| --- | --- |
| **Charted Next** | Briefed, not started |
| **Underway** | Agents are on it (a failed task stays here with a failed badge) |
| **Captain's Call** | Deck decisions answered in place, plus threads blocked on you |
| **Awaiting Merge** | A PR is ready and waiting on review or merge |
| **Landed** | Recently finished work |

- **Crew tabs** filter the whole board by worker bot.
- Cards show the task, its worker bot, live thread state (working, queued,
  needs input, failed), the provider, the PR link, and how long ago it moved.
- A Captain's Call opens the options the first mate attached, marks the
  recommended one, takes a note, and shows earlier calls on the task.
- A deck-linked thread that hits a native bb prompt appears under **Waiting in
  threads** in the same column; open it to answer.

## Driving it

```sh
bb deck chart --title "Dark mode" --brief "Settings toggle + tokens" --bot Designer
bb deck start a1b2c3d4 --thread thr_abc123
bb deck note  a1b2c3d4 --text "First pass done, contrast check running"
bb deck ask   a1b2c3d4 --question "Ship behind a flag?" \
  --option "Behind a flag" --option "Straight to users" --recommend 1
bb deck merge a1b2c3d4 --pr https://github.com/acme/app/pull/42
bb deck land  a1b2c3d4
bb deck bearings
```

Every command accepts `--json`. `bb deck list` shows all cards with ids.
`bb deck bearings` prints the fleet digest: Charted Next, Underway, Captain's
Call, Awaiting Merge, and Recently Landed.
Agents learn the workflow from the bundled `captains-deck` skill.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| First mate thread | empty | Answers to board decisions are sent to this thread as an agent-only note. The thread id looks like `thr_xxxx`; leave empty to only record answers on the board. |

Set it with `bb plugin config captains-deck set firstMateThreadId thr_xxxx`, or
from Settings → Installed plugins → Captain's Deck.

## Development

```sh
npm install
bb plugin dev        # rebuild + reload on save
```

## License

MIT
