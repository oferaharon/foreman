# Foreman

**Foreman** is one local web panel for every Claude Code session running on your Mac. It discovers the sessions you already have open, and can start new sessions or whole teams from the browser.

Every session is in front of you at once: see which are working, which are idle and which are waiting on you, type back into any of them, or queue a message for one that is busy.  
When a session stops on a permission prompt, a question or a plan approval, you answer it from the panel, without hunting for the right terminal window.

![The panel in dark theme, open on a team lead. On the left, a rail: the lead pinned at the
top, with two workers nested underneath on their own agent branches, and below the rail a
peer-messages row and a rooms band. In the middle, the lead's transcript, tool calls folded
into one-line chips, and the composer beneath it. On the right, the team panel: a task list
mixing review, working, pending and done rows, two of them marked deployed, and under it the
team room, read only, showing worker reports as bubbles with the panel's own dispatch and
merge lines running between them.](docs/images/panel.png)

- **Run a team.** Start a session as a **team lead** and it becomes the one you talk to: it dispatches other sessions as **workers**, each on its own branch in its own git worktree, and brings you only the decisions that need you.
  - **The lead picks the worker.** For each task it decides what kind of worker to send, a **planner** that reads the repo and writes a plan for approval, or a **builder** that writes the code, and **which model it should run on**, judged on the size of the job. A model choice off the team default is posted with its reason so you can see when the lead called it wrong.
  - **Team room** — the lead and its workers coordinate on their own: workers report back, escalate when stuck, and the panel logs every dispatch, conflict and merge between them. You read it beside the lead's conversation; nothing in it waits for you unless it says so.
  - **Team tasks** — every piece of work is a task with a state (pending, working, review, done), its brief, its PR and whether the merged change is actually running here. A pending task starts only on your say-so; a finished one merges on your press, or on the lead's own judgment if you have allowed that.
  - **Team settings** — how much rope the team gets: worker cap and default model, whether the lead may open PRs, answer its workers' prompts, or merge without asking, which paths always wait for your review, and how long a worker may sit silent before it is flagged.

- **Rooms.** Put a few sessions from different projects or repos in a room and they can work on a problem together: share what they know, report progress and drive a shared goal. When one posts, the message lands in every other member's terminal.

  You can post and take part too, and `@`-mention one or several members. Your messages arrive marked as yours: a post from another session is only a request, while yours carries your authority, exactly as if you had typed it into that session.
  - **You decide who is in it.** Only you can create a room, add a session or remove one. Sessions cannot join or invite on their own, because being in a room means being able to type into another session's terminal.
  - **Everyone sees everything.** Every post is kept in the room's log and reaches every member, even one addressed by name, so there are no side conversations to catch up on.

**Use it**

```
brew install oferaharon/tap/foreman-panel
foreman-panel setup
```

`setup` checks for Claude Code and tmux, registers the status hook, wraps the status line so the rail can show your rate-limit gauges, starts the panel and opens it at http://127.0.0.1:48770. Safe to run again; already-done steps are skipped.

To run it from a checkout instead, see [Running it](docs/running.md).

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

<img src="docs/images/rail-inbox.png" alt="The whole rail top to bottom: the Foreman header with its two rate-limit gauges, the buttons row, and the live/busy/waiting/unread counts; a pinned team lead with two workers nested under it, each carrying an unread badge; two collapsed groups; then the footer with the peer-messages row, the ROOMS band showing one open room and an archived fold, and the GitHub/version line." width="100%" />

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

<img src="docs/images/terminal.png" alt="A macOS Terminal window attached to a team lead's tmux session: the lead's last reply, the composer with a word typed into it, the Claude Code footer showing model, context and auto mode, and the tmux status bar naming the session." width="100%" />

</td>
<td width="50%" valign="middle">

**Your terminal is still there.** Every session in the panel is a real Claude Code process in tmux, running whether or not a browser is open. One click on the pane header's attach button opens a Terminal window on that exact session, with the conversation as Claude Code itself draws it and every bit of its history waiting for you. Closing the window ends nothing. The panel is another way in, not a replacement for the terminal.

</td>
</tr>
<tr>
<td width="50%" valign="middle">

### The phone view

`/m/` is a phone-sized view of everything the panel shows — leads, ordinary sessions and
rooms, across three tabs — with a mark on whatever's waiting for you. [Docs →](docs/panel.md#the-phone-view)

</td>
<td width="50%">

<img src="docs/images/phone.png" alt="A phone-sized screen: the project name with a chat and tasks tab pair under it, then a lead's conversation — a message sent to it, two tool calls folded into one-line chips, and its answer — with a reply box at the bottom." width="100%" />

</td>
</tr>
<tr>
<td width="50%">

<img src="docs/images/rooms.png" alt="A room named Introduction to Rooms with two members, showing two speech-bubble replies between them, each folded behind a view more and marked handed to the other member." width="100%" />

</td>
<td width="50%" valign="middle">

### Rooms, for sessions that have to agree

Make a room, drop a few sessions in it, and any one of them says a thing once — the panel
writes it down and types a copy into every other member's terminal. Only you make a room and
choose who is in it; a session gets three tools and none of them is *join*.
[Docs →](docs/panel.md#rooms)

</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Split view

Two sessions side by side, each with its own header, transcript, composer, queue and
prompt buttons — `split` in a pane header, or `⌘\`. A reload puts both back where they
were. [Docs →](docs/panel.md#split-view)

</td>
<td width="50%">

<img src="docs/images/split-view.png" alt="Two sessions side by side in split view, each with its own header, transcript and composer — one running a Bash tool call, the other showing its finished answer." width="100%" />

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

**macOS** and **Claude Code** on the `PATH` of a login shell. Homebrew brings tmux, git and Node; Claude Code is never a Homebrew dependency, and `setup` stops if it can't find it.

For a team on a GitHub-hosted repository you also need `gh` logged in **and** `gh auth setup-git` run once. Both, not either: `gh`'s login is not git's. `setup` warns if `gh` isn't logged in; everything but teams works without it.

The full list, including what the panel reads and writes outside its own state directory, is in [Prerequisites](docs/running.md#prerequisites).

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
