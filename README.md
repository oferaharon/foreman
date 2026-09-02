# Foreman

One local web panel for every Claude Code session running on this Mac: read the
conversations, see which one is working and which is waiting on you, type back, and answer
the permission prompts and questions they stop on — without hunting for the right terminal
window. Tick one box when you start a session and it comes up as a **team lead** instead: a
session you talk to that dispatches other sessions as workers, each in its own git
worktree, and brings you only the decisions that need you.

![The panel in dark theme, open on a team lead. On the left, a rail: the lead pinned at the
top, reading "1 task · 1 in review", with its worker nested underneath on branch
agent/readme-screenshots. In the middle, the lead's transcript, tool calls folded into
one-line chips, and above the composer a merge-queue row naming the one branch waiting on
a decision with a MERGE button beside it. On the right, the team panel: a task list with
one task blocked, two pending and two done — one of them marked deployed — and under it the
room, the team's log of dispatches, reports and PRs.](docs/images/panel.png)

The panel is the whole product on its own; the team is the second chapter and every part of
it is optional. Sessions can be started anywhere — a terminal, another tool — and, on
request, from here: `+ new`, a row's `⧉`, a restored snapshot, or a lead dispatching a
worker. The panel starts nothing on its own initiative; everything else it does is observe
and inject.

**Use it:**

```
brew install oferaharon/tap/foreman-panel
foreman-panel install-hook
brew services start foreman-panel
```

Then open **http://127.0.0.1:48770**.

**Work on it** — the contributor path, unchanged:

```
git clone https://github.com/oferaharon/foreman.git
cd foreman
npm install
npm run install-hook     # once — registers the status hook, backs up settings.json
npm run install-agent    # once — runs the panel as a LaunchAgent → http://127.0.0.1:48770
npm test                 # parsers, stores, binding, launch naming, and the team modules
```

`npm start` still works, but it is the scratch-server command, not how the real panel
runs — see [Running it under launchd](docs/running.md#running-it-under-launchd).

There is no signed installer package and no bundled Node runtime, and that's deliberate:
Homebrew owns the runtime and the dependency graph for the first path, and the second
needs the same Node and tmux it always has. Revisit a `.pkg` only if non-Homebrew users
turn up.

---

## What it does

Eight things, one line each. The full reference lives in [`docs/`](docs/) — [the
panel](docs/panel.md), [the team](docs/team.md), [running it](docs/running.md).

### The rail, and the sessions that need you

![The top of the rail: a pinned team lead with its worker nested under it, then a Needs you
group holding one session stopped on a permission prompt and one carrying two unread
replies, then a project heading with the open session under it.](docs/images/rail-inbox.png)

Every live session on the Mac, grouped by folder, with a **Needs you** group at the top
holding whatever is blocked or has replied while you weren't looking — sessions move into
it rather than appearing twice, so it empties as you deal with it.
[Docs →](docs/panel.md#unread-and-the-needs-you-queue)

### Answering prompts, questions and plan boxes

![A permission prompt as the panel draws it: the tool and the file at the top, the diff it
wants to apply, the question, and the box's three real options as separate buttons. The
second — a yes that also switches the session into accepting edits — is outlined rather
than plain, and the composer below reads "answer the prompt above" with its send button
showing queue.](docs/images/permission-card.png)

Permission prompts, Claude's own `AskUserQuestion` boxes and the plan-approval screen are
parsed off the pane and offered as real buttons — answered by the option's own digit,
never positionally, and never sent if the label has changed since you saw it.
[Docs →](docs/panel.md#permission-prompts)

### The phone view

![A phone-sized screen: the project name with a chat and tasks tab pair under it, then a
lead's conversation — a message sent to it, two tool calls folded into one-line chips, and
its answer — with a reply box at the bottom.](docs/images/phone.png)

`/m/` is a phone-sized view of your leads and nothing else: read the conversation, see the
tasks, answer what is blocking. [Docs →](docs/team.md)

### The team: a lead, its workers, and the room

![The room, read top to bottom: a worker's report as a bubble, folded to five lines behind a
quiet view more and tagged ready for review with its branch; four grey system cards — a PR
opened, a task recorded pending, a merge, a task closed; the green line where the next
worker was dispatched; that worker's own two bubbles, each named and timestamped and each
folded; and a last grey card for the PR it opened.](docs/images/team-room.png)

A lead scopes the work, dispatches workers into their own git worktrees, and reports back
through a room you can read — and nothing merges, and nothing is killed, without your
word. [Docs →](docs/team.md)

### Split view

Two sessions side by side, each with its own header, transcript, composer, queue and
prompt buttons — `split` in a pane header, or `⌘\`. A reload puts both back where they
were. [Docs →](docs/panel.md#split-view)

### Install it as an app, and be told when a session stops

The panel and the phone view each ship their own web-app manifest, so either can leave the
browser and become a window of its own; opt in to notifications and the Mac tells you the
moment a session walks into something it cannot get past.
[Docs →](docs/panel.md#installing-it-as-an-app)

### Snapshot, restore, relaunch all

`snapshot` saves the set of sessions you have open and puts it back after a reboot;
`relaunch all…` closes each one and starts it again — same folders, names, groups and
pins — for the day you update Claude Code. [Docs →](docs/panel.md#snapshot-and-restore)

### It stays up on its own

The panel meant to stay running is a LaunchAgent, installed by `npm run install-agent` or
by `brew services` — surviving a crash, a reboot and the routine restart, and trimming its
own logs at boot. [Docs →](docs/running.md#running-it-under-launchd)

---

## Prerequisites

**macOS**, **tmux**, **git**, **Node ≥ 20**, and **Claude Code** on the `PATH` of a login
shell. Under Homebrew the first four arrive as formula dependencies; from a checkout they
are yours to provide. Claude Code is never a Homebrew dependency — it isn't packaged
there, and the panel is useless without it, so it stays a prerequisite you install
yourself.

For a team on a GitHub-hosted repository you also need **`gh`, logged in, plus `gh auth
setup-git` once** — both, not either, because `gh`'s login is not git's. A team on any
other host needs none of this.

The full list, including exactly what the panel reads and writes outside its own state
directory, is in [Prerequisites](docs/running.md#prerequisites).

## Security

The panel has **no login**, deliberately. On loopback that is fine; the moment you widen
`FOREMAN_HOST` past `127.0.0.1`, everything that can reach the port can read every
transcript on this Mac, type into any session, and dispatch workers.

Read [SECURITY.md](SECURITY.md) before you make it reachable from anything but this
machine. It says so plainly, and says what the browser guard does and does not buy you.

## Working in the open

Issues, pull requests and the agents' own `agent/<label>` branches all live on this
project's GitHub repository. Where to report a bug and where the work happens are one
place on purpose: a stranger's bug report or fix lands where the code and the branches
already are, rather than somewhere the workflow isn't.

[CONTRIBUTING.md](CONTRIBUTING.md) is the short version of what to run before you send one.
[CLAUDE.md](CLAUDE.md) is the long version of why: the rules this project learned the
expensive way, kept where the next person to touch the code will read them.

## Licence

MIT — see [LICENSE](LICENSE) for the full text. No CLA, and no additional clause.
