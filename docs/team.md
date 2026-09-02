# The team

[README](../README.md) · [The panel](panel.md) · **The team** · [Running it](running.md)

A **team lead** is a Claude Code session you talk to, which dispatches **workers** —
other Claude Code sessions, each in its own git worktree — and brings you only the
decisions that actually need you. You describe what you want in the composer; the lead
scopes it, asks before it starts anything, and reports back. **Non-goals** at the end of
this section says what was considered and deliberately left out.

Nothing about the panel's normal behaviour changes. A lead is a session in the rail, a
worker is a session in the rail, and you can select either one, read its transcript,
attach a Terminal, and type into it directly if you want to go over the lead's head.
Nothing here is headless or hidden.

![A phone-sized screen: the project name with a chat and tasks tab pair under it, then a
lead's conversation — a message sent to it, two tool calls folded into one-line chips, and
its answer — with a reply box at the bottom.](images/phone.png)

`/m/` is a phone-sized view of your leads and nothing else.

### Starting a lead

Tick **team lead** in `+ new`. That turns the launch into something different: it seeds
the team's state on disk, attaches a session-scoped tool surface, hands the session its
brief, pins the row, and forces the label to `lead` — so it becomes
`<prefix><repo>-lead`.

The forced label is enforcement, not tidiness. **One lead per project is permanent**: two
leads on one repo means two things writing one task list with no answer to "which lead
owns this worker?", so a second attempt collides on the name and is refused outright with
a 409. The tick also refuses a folder that isn't a git repository, since every dispatch
from such a lead would fail — it says so in the dialog rather than starting something
doomed.

A session's role comes from **launch flags, not files in the folder**: the brief rides
`--append-system-prompt-file`, the tools ride `--mcp-config` with `--strict-mcp-config`,
and the permission stance rides `--settings`. No repository gets a new file and no
`CLAUDE.md` is edited for any of this to work. That matters for a reason worth stating:
config placed in the folder would hand the lead's powers to *every* ordinary session
opened there.

A worker inherits the repo's own `CLAUDE.md` for free, because a worktree is a full
checkout — it follows exactly the house rules you do, with nobody wiring it up.

### What a worker is

A tmux session in a fresh worktree under `~/.foreman/worktrees/`, branched from a
freshly fetched `origin/main`, on a branch named after the task. The label the lead mints
names all four things at once:

| | |
| --- | --- |
| label | `add-a-search-index`, or `issue-14` when it came from an issue on the forge |
| branch | `agent/add-a-search-index` |
| worktree | `~/.foreman/worktrees/alpha-add-a-search-index/` |
| tmux | `foreman-alpha-add-a-search-index` |

So a worker reads like any other session in that repo, because it is named like one.
Workers nest under their lead in the rail, indented with a thin connecting rule, so a
team reads as one unit — but a worker that is blocked or unread is still hoisted into the
inbox, because the one thing the rail must never do is hide something you need to see.

Which is why a team session gets a **third line**, and nothing else does: hoisted into the
inbox or pinned to the top, a worker has left its lead behind and the indent no longer says
anything. The line is a role and the one fact worth the width — `worker · agent/add-a-search-index`
under a worker, `lead · 4 tasks` (open ones) under a lead. The `lead` badge moved down onto
it rather than being repeated there; the meta line above is for *state* (bypassing, asking,
queued) and a role is not state. Every row that is not on a team stays two lines exactly as
it was, which is the whole reason this shape was chosen over a coloured stripe or a fifth
badge. A worker whose task is done, failed or abandoned loses the line entirely — the branch
it named has been merged or swept, and a row still pointing at it would be pointing at
nothing.

Worktrees live flat, outside your Code folder and outside Drive sync: a worktree inside
the repo can be committed by accident, one beside the repo pollutes the folder the rail
groups by, and a synced one means Drive uploading `node_modules` every time a worker
installs. A setup command runs once in a new worktree before the session starts, so a
worker's first act isn't discovering it can't run the tests — and the panel works that
command out from the project's own files (`package-lock.json` → `npm ci`, `Package.swift`
→ `swift build`, and so on; `server/setup-detect.js`) rather than asking anyone to type
it. When it genuinely can't tell, it says so and the worker starts without one.

Workers run in **auto mode**, like your own sessions, plus that project's own build and
test commands. Never with bypass, and destructive git — force-push, branch deletion, `gc`
— is denied regardless of mode, because a worktree isolates files but shares the real
repository's history. The consequence is the design: a prompt a worker actually hits is
not friction to engineer around, it is the signal. Routine work never asks; if a worker
stops, something is genuinely a judgement call.

A worker outlives its PR. When it finishes it stays idle in the rail until the PR is
merged or closed, because the first thing that happens to a PR is somebody wanting a
change, and the worker that wrote it still holds every bit of context about why.

### Three boundaries worth knowing

Everything the team adds applies to **workers**, and nothing on screen says where that line
falls. Three consequences, none of which is a gap to be fixed:

- **The conflict scan only sees workers.** `server/conflicts.js` compares the task records
  against each other, and a session you drive by hand has no task record — so your own
  session and a worker can be editing the same file, in the same repository, and nothing
  will say so. Two workers doing it gets posted to the room; you and a worker does not.
- **The force-push denial lives in each worker's settings file.** `GIT_DENY`
  (`server/dispatch.js:79`) is written into the `--settings` a worker is launched with, at
  dispatch. It does not cover your own sessions, and it never did: a worktree isolates
  *files* while history stays shared, so the rule has to ride on the session rather than on
  the checkout.
- **Ordinary sessions get no worktree, no branch and no permission stance.** That is the
  design rather than an omission. The panel observes and injects, most sessions never came
  from it in the first place, and a tool that imposed a workflow on every session you
  started would be a different tool.

### Planners

Some work needs a plan before it needs code, and working that plan out in conversation
with the lead is the worst place to do it: it holds the lead up for as long as it takes,
and it fills the one context that has to last the whole project. So the lead can dispatch
a **planner** instead — a worker that reads the repo, writes one plan document, and stops.

It is a worker in every mechanical way: its own worktree, its own branch, the same room,
the same slot against the cap. Two things are different. Its brief tells it what a plan
contains — why, scope as a numbered list of dispatchable items, the rules that don't bend,
what done looks like, the traps it found in the code, and the questions it couldn't
settle. And it **cannot write code**: its permission settings deny edits to its worktree,
to every other worker's worktree, to the real checkout, and deny `git commit` and
`git push`. Its branch ends empty, which is the correct outcome. The row in the team panel
carries a quiet `plan` chip so it doesn't read as a build worker that achieved nothing.

The plan lands in your team folder, at `~/.foreman/teams/<repo>/plans/<task>.md` — a
plan is not a source file, and the point of it is that it exists before any code does. The
lead reads it as a document, never through the room, and brings it to **you**. The lead
does not approve plans; that is your call, the same way merging is. Once you have said
yes, the plan's scope items are the lead's dispatch list and its traps go into the briefs
of the workers that build it. Closing the plan task removes its worktree and branch and
leaves the plan where it is.

One honest limit: those are file-permission rules, and a shell redirect is a Bash call no
path rule sees. A planner that decided to implement anyway would have to deliberately
route around the panel to do it. It is a wall, not a sandbox.

### The room

A team's coordination log — one append-only file per team, shown in the right-hand panel
of the lead's pane, **view only**. You talk to the lead; the lead talks to the room. If
you want to reach a worker directly, select its row and use its own composer.

Messages are addressed. A worker only ever receives what was sent to it, so the worker
fixing the admin page cannot act on an instruction meant for the core feature — that
isolation is structural, not a matter of workers behaving well. Everything is rendered in
one stream so there is one place to watch, with system lines (dispatched, blocked, went
idle, PR opened) styled apart from workers' own words.

Two of those machinery lines are coloured, both in tokens the panel already uses
elsewhere: **a dispatch is green** — a worker starting is the one piece of machinery that
is good news — and **two workers on one file stays amber**. Everything else is the plain
grey card. The colour comes from what the poster said the line *is* (`event: 'dispatch'`
on the entry), never from reading its sentence, so rewording the message cannot silently
turn the colour off.

![The room, read top to bottom: a worker's report as a bubble, folded to five lines behind a
quiet view more and tagged ready for review with its branch; four grey system cards — a PR
opened, a task recorded pending, a merge, a task closed; the green line where the next
worker was dispatched; that worker's own two bubbles, each named and timestamped and each
folded; and a last grey card for the PR it opened.](images/team-room.png)

**A long entry folds to five lines.** A worker's DONE report runs to several paragraphs
and this panel is 340px read beside the conversation with the lead — one report used to be
the whole room. Bubbles and system cards clamp, with a quiet `view more` inside the entry;
what fits keeps its own height and grows no control at all, because whether an entry
overflows is measured rather than guessed at from its length. **Escalations and alerts
never fold** — they are the two things here that need you, and hiding four fifths of a
decision behind a control is the failure the loud card exists to prevent. Opening one
leaves the reader exactly where they were and does not count as scrolling away; what is
open is remembered by the entry, so the next arriving line does not fold it back under
whoever is reading it.

The room is a log, not a transport: workers write to it and never read it, because
lead→worker already has a better channel — a message dripped into the worker's actual
composer, one per idle window, behind the same lock everything else types through. Those
are mirrored into the room so you can see them.

**The lead gets nudged.** A Claude Code session only acts when something gives it input,
so a worker finishing or blocking would otherwise reach a lead that had ended its turn.
When something in the room deserves attention the panel queues a short `[room]` message
to the lead, which reads and decides. A burst coalesces into one nudge, with a floor of a
minute per team and never more than one waiting at a time — otherwise a busy team spends
its day telling the lead it is busy.

### The team panel

The right side of a lead's pane, stacked in three:

**Tasks** — every task the team holds, with its state as a chip. The chip is derived, not
just stored: a worker whose pane is holding a question reads `blocked`, and one that has
been blocked or silent past the team's timer reads `stuck` and pulses. Rows carry the
branch, a link to the PR once there is one, and a `✕` that abandons the task behind a
two-click confirmation — which refuses, with the reason on screen, while that worker has
anything open in its terminal.

![The task list: one task blocked with a link to its PR, two pending, one done and carrying
a deployed pill, one done plan task — each with its state as a chip and its branch
underneath.](images/team-tasks.png)

**Settings** — the autonomy toggles plus the team's knobs: how many workers may run at
once and how long a worker may sit stuck before the room is told, both editable while
the team is running. Three detected values sit beside them read-only, each with the reason
it was chosen: the **setup** command, read off the project's files; the **forge**, read off
the repo's own `origin` (see [The forge](#the-forge)); and the **base branch**. None of the
three is a box, deliberately — a wrong value there is a bug in detection, not something for
you to correct.

**Room** — the log, below.

Split view is disabled for a lead, so the panel owns that half unconditionally. It is
unchanged for every other session.

### Stuck, silent, looping

The panel watches worker transitions off the same roster the rail draws, and posts the
interesting ones to the room. Three of them are failures rather than events:

- **Blocked too long** — past the team's stuck timer, the lead is told to surface it to
  you *even if it thinks it could answer*. A worker stuck that long is exactly what you
  want to see.
- **Idle and silent** — no room post, task not in review, past the same timer. The lead
  pokes it once; if it stays silent, it surfaces. (A post from the worker restarts the
  clock, so a talkative worker is never called silent.)
- **Looping** — the same message posted over and over. Surfaced, never acted on.

Each fires once per episode and re-arms when the worker's state changes. **Nothing kills
a worker automatically**, ever; ending a session is your call, or an explicit
instruction.

### Conflicts

Two workers editing the same paths is the one thing they genuinely need to know about
each other, and the only broadcast the room carries. A scan compares what each worker has
committed on its branch *and* what is merely dirty in its worktree — the second matters
more, since a worker mid-task hasn't committed most of its work yet. An overlap is posted
once; the same pair with the same files never repeats, but a *new* shared file is news
again. The lead decides the ordering.

### Housekeeping

At boot the panel prunes stale worktree bookkeeping, and sweeps the worktrees of tasks
that failed more than fourteen days ago — the branch and the worker's leftover config
files go with it. It posts to the room *before* removing anything, never after. A failed
worker's worktree is evidence, which is why nothing touches it until it's two weeks cold.

### What the lead may do on its own

Every autonomous power is a per-team toggle, and they start **off**:

| Toggle | Default | What unlocking it means |
| --- | --- | --- |
| Answer design questions | off | the lead may answer a worker's `AskUserQuestion` box |
| Answer permission prompts | off | a machine pressing yes on permission boxes |
| Approve plans | off | plan boxes, which can clear context and bypass permissions |
| Flag worker conflicts | on | post to the room when two workers touch the same files |
| Lead merges without a prompt | off | its merge call stops at no prompt; what that grants differs by forge |
| Lead decides merges | off | the lead decides a merge per PR, within the conditions in [Merging](#merging) |

Behind every one of them sits a rule that is not a toggle: **the lead may answer only
when it can cite the grounds** — a line in the repo's own `CLAUDE.md`, a ruling you gave
it earlier, or something you said in the conversation it is still holding. "It seemed
reasonable" is not grounds; without them it escalates to you. Every autonomous answer is
posted to the room with its citation, so you can audit what was decided on your behalf
without reading a single worker transcript.

When the lead does answer a question box, it goes through the panel's own guarded
endpoint — the one that already knows about multi-select diffs, review screens and
preview panels — and never by typing keys at a terminal.

The lead also **never writes code**. Not a one-line fix, not "just this once": its
permission settings deny the checkout and allow only its own team folder. Reading is
unrestricted, including worker diffs, because reviewing the work is part of the job.

### The forge

**The forge is worked out per repo, from that repo's own `origin`.** There is no setting,
and no token is ever stored. One project can be on GitHub while every other is on a
self-hosted Gitea — each lead is given only the tools its own repo needs, and the panel
shows what it found on the team panel's `forge` line, read-only.

Detection asks two independent questions, and the answer is a pair: what does `origin`
point at, and is tooling for it installed here?

| Reading | What it means | What the lead does |
| --- | --- | --- |
| **GitHub** | `origin` is on github.com, and `gh` (preferred) or a `github` MCP server is installed | opens and merges PRs |
| **Gitea** | `origin` is elsewhere, and a `gitea` MCP server is registered | opens and merges PRs |
| **push only** | a remote is configured, no tools for it are installed | work stops at the pushed branch |
| **no remote** | no `origin` at all | work stops at the branch, here on this machine |

**Gitea means any Gitea instance** — self-hosted, or the hosted service at `gitea.com`.
There is no list of blessed hosts: detection reads your `origin` and the MCP servers you
have registered, never a particular address.

**What has actually been run, since these docs should claim only that.** The **Gitea** path
is the one this project was built against and is exercised daily, on a self-hosted
instance. The **GitHub** path was exercised end to end against a throwaway private
repository: a worker dispatched, committed and pushed, a PR opened with `gh pr create`,
merged with `gh pr merge`, and the task closed and swept.

**Any other remote reads as `push only` — branches are pushed and PRs are opened by hand.
Open an issue if you want another forge added.** That is GitLab, Bitbucket, SourceForge and
sourcehut today, and the invitation is meant literally: this list only ever grows because
somebody asked.

**Forgejo is untested.** It is the Gitea fork and its API is close enough that it may well
work — which is exactly why it is said outright rather than left to be assumed. Nobody has
run this code against it, so it reads `push only` like anything else until somebody does.

Two limits worth knowing before they surprise you. A **self-hosted GitHub Enterprise** or a
**self-hosted GitLab** cannot be told apart from a self-hosted Gitea by hostname alone, so
either reads `Gitea` if you have the gitea MCP server registered; the lead's first tool
call then fails, loudly, rather than doing something wrong quietly. And detection asks
whether the tooling is *installed*, never whether it is *logged in* — checking that would
put a network round trip on every repaint.

**Prerequisites for the GitHub path**, both of them ordinary and neither obvious:

- **`gh` on your PATH**, logged in (`gh auth login`). It is preferred over the GitHub MCP
  server on purpose: `gh` keeps its credential in the system keychain, while the standard
  MCP server carries a personal access token in its `env` — and a lead's `mcp.json` is
  written world-readable. The panel refuses to copy any MCP entry carrying something that
  looks like a credential, and says so in the launch result.
- **`gh auth setup-git`**, once. `gh`'s login is not git's: without this a worker's plain
  `git push` fails with *"could not read Username for 'https://github.com'"*, and the
  worker reports its branch as unpushed. Measured on a bench repo, not guessed.

### The base branch

Also detected, also per repo, also shown read-only: `origin/HEAD` if the remote names a
default branch, otherwise whatever branch the checkout is on. Workers branch from it and
`done` is checked against it — so a repo on `master` or `trunk` works, which it did not
when `main` was hardcoded.

### Merging

Where the repo has a forge, work lands as a pull request. The lead opens it, tells you what
changed, and gives you the link. Where it has none, work lands as a branch: the lead tells
you what changed and the branch name, and you merge it locally.

**Closing a task as `done` is checked before anything is deleted.** Closing removes the
worker's worktree and force-deletes its branch, so the panel first requires that branch to
be an ancestor of the base — looking at `origin/<base>` and at local `<base>`, fetching
first, and refusing if it cannot tell. The refusal names what to do. Discarding work
deliberately is the *abandon* outcome, which is what that word is for.

**Unless you say otherwise, the decision to merge is yours, and it is never inferred.**
Not from green checks, not from a timer, not from silence, not from the lead's own
confidence in the diff. On your explicit word, per PR, in conversation — "merge it",
"merge #49" — the lead performs the merge, verifies it landed, then closes the task, which
ends the worker's session and removes its worktree. The click is delegated; the decision
is not. There is a `mergePRs` toggle and it exists so the answer to "can it merge on a
trigger?" is visibly *no* rather than unspecified — it is refused everywhere, and cannot
be turned on from the panel.

**You can hand the routine ones over — per team, per PR, and only if you say so.** Turn on
**Lead decides merges** (`leadDecidesMerges`, off on every team until you turn it on) and
the lead may merge a worker's PR on its own judgment instead of waiting for your word. It
is not auto-merge and cannot become it: there is no trigger, no timer and no deferred
merge, and the lead has to ask the panel first, one PR at a time, through a check that
either allows that exact commit or refuses it.

What the panel enforces itself, computed from your own checkout, where nothing the lead
says can change the answer:

- the toggle being off — that is the whole answer, and the PR waits;
- the task's shape: this repo, in review, not a plan, with a PR recorded;
- **the head sha**: the lead passes the commit it read on the forge, and the verdict is
  bound to it. A branch that moved afterwards needs a new check;
- a branch whose changed files could not be read — an unreadable branch refuses;
- **the review paths**, below.

**The folders you always want to look at yourself.** `humanReviewPaths` is a short list of
paths — a file, or a folder and everything under it — that the lead may never merge on its
own. A PR touching any of them is refused, with the file named, and comes to you like
every other PR. `server` reserves `server/index.js` and does not reserve `serverless.js`;
these are path prefixes, not patterns, so the question stays "which folders do I want to
see?" rather than "which glob do I mean?". An entry it cannot read refuses the whole list
rather than dropping the bad line, because a shorter safety list fails in the direction of
merging something you wanted to see.

And what it cannot enforce, said plainly because it matters more than the rest: **the
panel never talks to your forge.** It holds no credential and makes no network call, so
"is this PR mergeable, are its checks green" arrives *from the lead*, in its own words,
and is recorded in the room where you read it back. That half is discipline, not a wall —
the lead's brief tells it exactly how to read a forge honestly, and every check it runs is
posted to the room, refusals included. A merge decided this way is named in the task's
close line; a task closed with no decision recorded says that instead, so a lead that
merged without asking leaves a visible gap rather than a silence.

The two toggles are independent on purpose. With **Lead decides merges** on and **Lead
merges without a prompt** off, the lead may decide and then still stop at a permission
prompt you answer — safe, and quietly back where you started, which is worth knowing
before you wonder why it stopped.

### The merge queue

A fixed list of the PRs waiting on you: on the desktop, in the control strip above the
composer beside the interrupt button; on the phone, in the same slot above the composer
that the answer cards use. One row per task in review — a link, what it touched, and a
`merge` button.

Pressing it doesn't merge anything. It types the merge sentence into your lead's own
conversation, exactly as if you had typed it yourself — the lead then does what it
already does: merges, pulls, restarts the panel if `server/` changed, verifies, closes
the task. When two or more waiting PRs touch the same file, `merge all` is replaced by a
sentence saying which ones and why, so you merge them one at a time instead; a single
PR's own button is never withheld, only labelled with what it shares.

### Where the state lives

Everything outlives the browser tab, and none of it is inside your repositories:

```
~/.foreman/
  teams/<repo>/
    team.json       config and the autonomy toggles
    room.jsonl      the room, append-only
    decisions.md    what you have ruled on, in your words — survives the lead's /clear
    plans/          one file per planner task; outlives the task that wrote it
  tasks.json        every task, its state, branch, worktree and PR
  worktrees/        one checkout per task
  worker-settings/  the per-worker permission file passed at launch
  worker-logs/      setup command output
```

`decisions.md` is the load-bearing one, and the least obvious — it has its own section
below.

**Which directory that is, is resolved rather than fixed.** `$FOREMAN_STATE_DIR` first, then
`~/.foreman` if it is already there, then the directory an older build of this tool used if
*that* is there, then `~/.foreman`. A fresh install only ever meets the first and last, and
the `State:` line at boot names the directory and which rung answered. Nothing is ever moved
or copied between them: the third rung exists so an existing install keeps reading what it
already has, and a first-run automatic migration is exactly the thing it is not.

### The rulings file

One per team, at `~/.foreman/teams/<repo>/decisions.md`. It lives **outside the
checkout**, like everything else here, so nothing is written into your repository. A new
team's file starts as a short explanation of itself with **no rulings in it**, because
every line it ever holds is meant to be one you decided.

It fills up by talking to your lead. When you settle something — how branches get named,
which directory is off limits, what must always be asked about first — the lead appends it
there, dated, with the task it came out of. You never edit a file to make that happen,
which is the point: the alternative is a config file nobody remembers to update.

**It survives the lead's `/clear`, and that is the whole reason it exists.** A lead's
context does not last forever, and when it goes, anything you decided that lived only in
that conversation goes with it — next week you are asked the same question again. Every
lead's brief tells it to read this file before its first reply, so a cleared lead comes back
knowing what you have already ruled on.

**A worker is held to it too.** Its brief points it at the same file at dispatch, and any
ruling that bears on its task is binding — including one its own task description says
nothing about. Where a ruling and a task genuinely contradict each other, it stops and asks
rather than picking one.

An empty file on a new team means nothing has been decided yet. It is not a sign that
something is missing.

### Where your name comes from

A lead's brief and a worker's brief are prose, and they refer to you in it — *"The human
(jdoe) talks to you"*. That name is **read from `git config user.name`** at the moment the
brief is generated. There is no setting for it, nothing stores a copy, and nothing tries to
turn a handle into a real name: if git says `jdoe`, the brief says `jdoe`. Where git has no
name configured, the briefs say *"the human"* instead, which reads correctly everywhere it
appears.

It is read per repository, so it follows git's own rules. To change it:

```
git config --global user.name "Your Name"    # everywhere
git config user.name "Your Name"             # this repository only
```

A brief is generated at launch, so a change reaches the next lead or worker rather than one
already running.

### Non-goals

Things the team was designed *not* to do, listed so nobody has to re-argue them:

- **No auto-merge**, on any trigger — see [Merging](#merging). Nothing merges on a timer,
  on a webhook, or because checks went green with nobody looking. The `mergePRs` toggle
  means exactly that and is refused at every endpoint, so the answer is visibly *no*
  rather than unspecified. What *can* be turned on is a different thing: behind an
  off-by-default per-team toggle, the **lead** may decide a merge per PR, having read the
  diff and the forge, within conditions the panel enforces. A decision taken by something
  that looked, one PR at a time, is not a trigger firing.
- **Nothing kills a worker automatically.** Stuck, silent, looping — all of it surfaces and
  none of it ends a session. That is your call, every time.
- **No worker-to-worker messaging.** The room is the only coordination surface: one place
  to look, not N. Workers write to it and never read it, so cross-talk is impossible by
  construction rather than by convention.
- **No cross-repo leads.** One lead, one project, permanently — two leads on one repo would
  mean two things writing one task list.
- **No unattended intake.** The lead does not watch an issue tracker and start work while
  you sleep. It works on what you point it at, and asks first.
- **No new chat UI.** A lead is an ordinary session in the rail; the composer already
  exists. Likewise no dashboard — the rail is the dashboard.
- **No file dropped into your repo.** A role is launch flags, never files in the folder: no
  repo gets a new file and no `CLAUDE.md` gets edited for a session to take part, because a
  role declared in the folder is a role handed to every *ordinary* session opened there.
