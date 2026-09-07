# Foreman

One local web panel for every Claude Code session running on this Mac: read the
conversations, see which one is working and which is waiting on you, type back, and answer
the permission prompts and questions they stop on — without hunting for the right terminal
window. Tick one box when you start a session and it comes up as a **team lead** instead: a
session you talk to that dispatches other sessions as workers, each in its own git
worktree, and brings you only the decisions that need you.

![The panel in dark theme, open on a team lead. On the left, a rail: the lead pinned at the
top, with two workers nested underneath on their own agent branches, and below the rail a
peer-messages row and a rooms band. In the middle, the lead's transcript, tool calls folded
into one-line chips, and the composer beneath it. On the right, the team panel: a task list
mixing review, working, pending and done rows, two of them marked deployed, and under it the
team room, read only, showing worker reports as bubbles with the panel's own dispatch and
merge lines running between them.](docs/images/panel.png)

The panel is the whole product on its own; the team is the second chapter and every part of
it is optional. Sessions can be started anywhere — a terminal, another tool — and, on
request, from here: `+ new`, a row's `⧉`, a restored snapshot, or a lead dispatching a
worker. The panel starts nothing on its own initiative; everything else it does is observe
and inject.

**Use it:**

```
brew install oferaharon/tap/foreman-panel
foreman-panel install-hook
foreman-panel install-statusline  # optional — rate-limit gauges in the rail
brew services start foreman-panel
```

Then open **http://127.0.0.1:48770**.

**Work on it** — the contributor path, unchanged:

```
git clone https://github.com/oferaharon/foreman.git
cd foreman
npm install
npm run install-hook        # once — registers the status hook, backs up settings.json
npm run install-statusline  # optional, once — rate-limit gauges in the rail
npm run install-agent       # once — runs the panel as a LaunchAgent → http://127.0.0.1:48770
npm test                    # parsers, stores, binding, launch naming, and the team modules
```

`npm start` still works, but it is the scratch-server command, not how the real panel
runs — see [Running it under launchd](docs/running.md#running-it-under-launchd).

`install-statusline` is separate from the hook and reversible on its own
(`npm run uninstall-statusline`): it wraps whatever `statusLine` command is already
configured so a copy of Claude Code's own usage JSON reaches the panel, and it changes
nothing about what shows up in your terminal. The gauges it turns on only ever appear for
a subscription account — an API-key account has no usage percentage to show.
[Docs →](docs/panel.md#rate-limit-gauges)

There is no signed installer package and no bundled Node runtime, and that's deliberate:
Homebrew owns the runtime and the dependency graph for the first path, and the second
needs the same Node and tmux it always has. Revisit a `.pkg` only if non-Homebrew users
turn up.

---

## What it does

The full reference lives in [`docs/`](docs/) — [the panel](docs/panel.md), [the
team](docs/team.md), [running it](docs/running.md).

<table>
<tr>
<td width="50%" valign="middle">

### The rail, and the sessions that need you

Every live session on the Mac, grouped by folder, with a **Needs you** group at the top
holding whatever is blocked or has replied while you weren't looking — sessions move into
it rather than appearing twice, so it empties as you deal with it.
[Docs →](docs/panel.md#unread-and-the-needs-you-queue)

</td>
<td width="50%">

<img src="docs/images/rail-inbox.png" alt="The whole rail top to bottom: the Foreman header with its two rate-limit gauges, the buttons row, and the live/busy/waiting/unread counts; a pinned team lead with one worker nested under it; two collapsed groups; then the footer with the peer-messages row, the ROOMS band showing one open room and an archived fold, and the GitHub/version line." width="100%" />

</td>
</tr>
<tr>
<td width="50%">

<img src="docs/images/permission-card.png" alt="A permission prompt as the panel draws it: the tool and the file at the top, the diff it wants to apply, the question, and the box's three real options as separate buttons. The second — a yes that also switches the session into accepting edits — is outlined rather than plain, and the composer below reads &quot;answer the prompt above&quot; with its send button showing queue." width="100%" />

</td>
<td width="50%" valign="middle">

### Answering prompts, questions and plan boxes

Permission prompts, Claude's own `AskUserQuestion` boxes and the plan-approval screen are
parsed off the pane and offered as real buttons — answered by the option's own digit,
never positionally, and never sent if the label has changed since you saw it.
[Docs →](docs/panel.md#permission-prompts)

</td>
</tr>
<tr>
<td width="50%" valign="middle">

### The team: a lead, its workers, and the room

A lead scopes the work, dispatches workers into their own git worktrees, and reports back
through a room you can read — and nothing merges, and nothing is killed, without your
word. [Docs →](docs/team.md)

</td>
<td width="50%">

<img src="docs/images/team-aside.png" alt="The team panel: a task list mixing dispatched and pending rows, and beneath it the read-only team room showing a task-closed system card, a dispatch line, a conflict warning, a worker's folded report card marked ready for review, and a PR-opened card." width="100%" />

</td>
</tr>
<tr>
<td width="50%">

<img src="docs/images/phone.png" alt="A phone-sized screen: the project name with a chat and tasks tab pair under it, then a lead's conversation — a message sent to it, two tool calls folded into one-line chips, and its answer — with a reply box at the bottom." width="100%" />

</td>
<td width="50%" valign="middle">

### The phone view

`/m/` is a phone-sized view of your leads and nothing else: read the conversation, see the
tasks, answer what is blocking. [Docs →](docs/team.md)

</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Rooms, for sessions that have to agree

Make a room, drop a few sessions in it, and any one of them says a thing once — the panel
writes it down and types a copy into every other member's terminal. Only you make a room and
choose who is in it; a session gets three tools and none of them is *join*.
[Docs →](docs/panel.md#rooms)

</td>
<td width="50%">

<img src="docs/images/rooms.png" alt="A room named Introduction to Rooms with two members, showing two speech-bubble replies between them, each folded behind a view more and marked handed to the other member." width="100%" />

</td>
</tr>
<tr>
<td width="50%">

<img src="docs/images/split-view.png" alt="Two sessions side by side in split view, each with its own header, transcript and composer — one running a Bash tool call, the other showing its finished answer." width="100%" />

</td>
<td width="50%" valign="middle">

### Split view

Two sessions side by side, each with its own header, transcript, composer, queue and
prompt buttons — `split` in a pane header, or `⌘\`. A reload puts both back where they
were. [Docs →](docs/panel.md#split-view)

</td>
</tr>
</table>

**Also in the box:**

- **Install it as an app, and be told when a session stops** — the panel and the phone
  view each ship their own web-app manifest, and notifications tell the Mac the moment a
  session walks into something it cannot get past.
  [Docs →](docs/panel.md#installing-it-as-an-app)
- **Snapshot, restore, relaunch all** — save the set of sessions you have open and put it
  back after a reboot, or close every one and start it again for the day you update Claude
  Code. [Docs →](docs/panel.md#snapshot-and-restore)
- **It stays up on its own** — the panel runs as a LaunchAgent, surviving a crash, a
  reboot and the routine restart. [Docs →](docs/running.md#running-it-under-launchd)

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
