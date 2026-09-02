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

There is nothing to install from a package registry. Clone the repository, then:

```
npm install
npm run install-hook     # once — registers the status hook, backs up settings.json
npm run install-agent    # once — runs the panel as a LaunchAgent → http://127.0.0.1:48770
npm test                 # parsers, stores, binding, launch naming, and the team modules
```

Then open **http://127.0.0.1:48770**. `npm start` still works, but it is the scratch-server
command now, not how the real panel runs — see
[Running it under launchd](#running-it-under-launchd).

Read [SECURITY.md](SECURITY.md) before you make the panel reachable from anything but this
machine. It has no login, deliberately, and says so plainly.

## Prerequisites

- **macOS.** This is not portable and does not pretend to be. The launcher opens Terminal
  windows through `/usr/bin/osascript` and `/usr/bin/open -a Terminal`
  (`server/launch.js:264`, `server/launch.js:313`), the panel installs itself into
  `~/Library/LaunchAgents` (`server/install-agent.js:48`), and its logs are trimmed in
  `~/Library/Logs` (`server/logs.js:45`).
- **tmux, installed.** It is the session roster and the channel every keystroke goes
  through. It is resolved by absolute path — `/opt/homebrew/bin/tmux`,
  `/usr/local/bin/tmux`, `/usr/bin/tmux` (`server/tmux.js:51`) — because launchd hands a
  job a `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin` and tmux is in none of those.
- **Node ≥ 20** (`package.json`, `engines`). No build step and three runtime dependencies.
- **Claude Code**, on the `PATH` of a login shell. Sessions are started as
  `/bin/zsh -ilc claude` so your shell profile is sourced and any `claude()` wrapper you
  have keeps working (`server/launch.js:144`).
- **For a team on a GitHub-hosted repository: `gh`, logged in, plus `gh auth setup-git`
  once.** Both, not either — `gh`'s login is not git's, and without the second one a
  worker's plain `git push` fails. A team on any other host needs none of this; see
  [The forge](#the-forge) for what you get instead.

**What it touches outside its own state directory.** Everything the panel itself owns lives
in one folder (see [Where the state lives](#where-the-state-lives)), and nothing is ever
written into your repositories. Beyond that:

- It **reads** `~/.claude/projects/**` — the transcripts Claude Code already writes
  (`server/config.js:9`). Nothing here ever writes to that folder.
- It **reads** `~/.claude.json` for the MCP servers you have registered, which is how a
  team's forge is worked out (`server/config.js:20`, `server/forge.js:254`). Read only, and
  no credential is ever copied out of it.
- It **writes** `~/.claude/settings.json` once, at `npm run install-hook`, to register the
  status hook. The file is copied to a timestamped backup beside itself first, and
  registration only ever *appends* to the arrays already there, so other hooks are
  untouched (`server/install-hook.js:42`). `npm run uninstall-hook` removes it again.
- `npm run install-agent` **writes** `~/Library/LaunchAgents/<label>.plist` and bootstraps
  it. launchd then appends to two files in `~/Library/Logs`, which the panel trims itself at
  boot — see [Running it under launchd](#running-it-under-launchd). It also **removes** a
  plist in that directory that starts a copy of this same panel under a label it no longer
  uses, after backing it up into the state dir; a plist that starts anything else is never
  touched.

---

## How it works

Three sources, each doing what it's good at:

| Source | Gives us |
| --- | --- |
| `tmux list-panes -a` | the session roster, and the channel to type into |
| `~/.claude/projects/**/*.jsonl` | the message history, already structured |
| Claude Code hooks | live status, and which transcript a pane is writing |

The transcripts are the important part: Claude Code writes typed JSON, so the panel
renders real messages with tool calls folded into one-line chips — no terminal
scraping, no PTY emulation.

![The same panel on an ordinary session: a rail with a Needs you group holding one session
stopped on a permission prompt, then two project headings — one session working, one idle —
and the idle one's conversation open beside it, three questions and their answers with Bash
calls folded into one-line chips.](docs/images/sessions.png)

### Status

Four states. Three come from hook events: **working** (`UserPromptSubmit`,
`PreToolUse`), **idle** (`Stop`), **needs-decision** (`PermissionRequest`, permission
`Notification`). The fourth, **dialog**, can only be read off the pane — see below.

Only sessions with a live tmux pane appear at all. A transcript whose terminal has closed
is history, and the panel is not a history browser: those used to sit in the inbox with an
unread badge nobody could clear. Read one back with `claude --resume`.

The word Claude Code is currently showing for itself — *Schlepping*, *Orchestrating* — sits
next to the mode picker under the composer, with three dots that actually tick. It used to
live in the header, a whole screen from the box you type into, and the one thing it tells
you is whether typing now means waiting.

The `/hook` endpoint parses the body whatever content-type it arrives under. Claude Code's
hook is a `curl --data-binary @-` with none set, which curl labels form-urlencoded — and a
strict JSON parser drops it, `session_id` and all. That is worth knowing because it is what
happened here for months: hooks fired correctly, the panel discarded every one of them, and
it kept working anyway on pane scraping, so nothing ever looked broken except a binding
that was never as certain as it could have been.

A session that has not called the hook yet — one that has said nothing since it was
registered — is read off the pane instead: the panel scrapes `capture-pane` for the same
cues a person would, the spinner line with its live timer, the permission box, and the
footer's model and context percentage. No restart is needed to graduate. Claude Code
re-reads its hook config while running, so a session picks the hook up the next time you
speak to it, whenever it was started.

### Unread and the needs-you queue

Each session carries a read watermark — an ISO timestamp, stored server-side in
`~/.foreman/read.json` so closing the tab doesn't resurrect a hundred unread
messages and two windows agree.

Unread counts **assistant replies only**, not tool calls. In a session with 1,700 Bash
calls and a dozen replies, "12 unread" is the useful number.

A **Needs you** group sits at the top of the rail, under any pinned sessions: blocked on a permission
prompt or one of Claude's own questions first, then ones that replied while you weren't
looking. Sessions move *into*
the group rather than appearing twice, so it empties as you deal with it. A session
that's still `working` is held back — it hasn't finished talking yet. `⇧⇥` cycles the
queue.

![The top of the rail: a pinned team lead with its worker nested under it, then a Needs
you group holding one session stopped on a permission prompt and one carrying two unread
replies, then a project heading with the open session under
it.](docs/images/rail-inbox.png)

The badge clears only when the newest message is genuinely on screen; scrolling back
through history is reading the past, not catching up.

> Replies are accumulated across polls rather than recounted from each probe. `probe`
> only samples a file's head and tail, so a long burst of tool calls pushes earlier
> replies out of the window — recomputing from it alone would silently reset unread to
> zero. Caveat: a server restart clears the accumulator, so replies that landed while
> it was down may undercount until the session speaks again.

### Pinned sessions

The rail sorts itself, which is right for triage and wrong for the session you are
actually working in — it slides down the moment two others so much as blink. The star at
the right of a rail row (or `pin` in a pane header) nails it to a **Pinned** group above
everything else, the inbox included.

Pinned rows keep the order you pinned them in, so adding a second never moves the first.
They still carry their own badges — unread counts, `asking`, queued messages — so a
pinned session that wants you says so where you already are, rather than jumping to a
different part of the rail to say it.

Pins are stored server-side in `~/.foreman/pins.json`, keyed by **pane** rather than
session id: `/clear` mints a new session id, and a pin that quietly fell off when you
cleared a conversation would be worse than no pin at all. A pane that closes takes its pin
with it, and — as with the queue — a pane id handed out again by a new tmux server does
not inherit the old one.

### Starting a session

`+ new` in the rail head opens a small dialog with four things: an optional **label**, a
never-sticky **skip all permission prompts** opt-in, **open a Terminal window** (ticked by
default), and **team lead**, which starts a coordinator rather than an ordinary session
(see [The team](#the-team)). Then it hands off to the real macOS folder chooser, whose own
button commits.

Unticking **open a Terminal window** starts the session detached: it runs in tmux, the panel talks to
it exactly as it does to any other, and there is nothing on the desktop to look at. The
window can be opened later from the session header — see below.

`server/launch.js` is a port of another launcher's session creation, not a second opinion
about how sessions should be made: same `<prefix><folder>-<label>` naming (blank label
auto-numbers; a taken one takes `-2`), same
`tmux new-session -d … /bin/zsh -ilc "claude"` — the `-ilc` and the bare word `claude` are
what source `~/.zshrc` and let its `claude()` wrapper add `--name` — same
`remain-on-exit` guard while it boots, same `mouse on` and prefix-guarded pbcopy
binding, and the same Terminal window attached at the end.

If claude dies on startup the pane is captured, quoted back to you, and killed, rather
than leaving a Terminal window attached to a corpse. A brand-new folder will open on
Claude Code's own "do you trust this folder?" gate — answer it in the Terminal window
that just opened.

**Duplicating one.** Hover a rail row and there's a `⧉` under its pin: another session in
the same folder, no dialog and no chooser, opened as soon as it's up. Everything `+ new`
would ask you for is already on the row you pressed.

It's named after the one you duplicated — `alpha-main` gives `alpha-main-2`, then `-3` —
rather than auto-numbered, which would produce an unrelated `alpha-1`. The folder is the
pane's launch directory, so a copy lands under the same rail heading, and in the same
group, as its original even if that session has since changed directory.

A duplicate of a **bypass** session also bypasses. A copy that quietly asked for
permission where its original didn't would be worse than no button, so it inherits — and
the `⧉` turns the same red as the badge, saying so before you press it.

**Closing one.** The bin under the duplicate sends `/exit` — Claude Code ends, the shell
it was launched under goes with it, tmux drops the session, and the row leaves the rail.
The transcript stays on disk; `claude --resume` reads one back.

It is the only control in the rail that can't be undone, so it is the only one behind a
confirmation — and that dialog names the session, its folder, its tmux name, and says
outright when the session is mid-task, because a working row and an idle one look the same
in a list of fourteen. Cancel holds the focus, not the button that ends things.

It refuses while anything owns the pane: a permission box, a question, a plan approval, a
picker, or the startup trust gate would take `/exit` as six characters typed *into
themselves*. `interrupt` — the button above the composer's box — is the way out of those
first.

### Groups

The rail's folder headings are derived — one per `basename(cwd)`, and it has no idea
which four of them are one product and which three you last touched in March. Groups are
where you say so.

Hover a folder heading and click its `▾`: pick an existing group, type a name to make a
new one, or `Ungroup`. The heading moves under that group, indented, and the group header
folds the whole block away when you click it. A group's `⋯` renames it or deletes it —
deleting a group never deletes anything filed under it; those folders go back to standing
on their own.

A group holds **folders**, not sessions, because sessions rotate with every `/clear` and
folders don't. A folder lives in exactly one group, so nothing is ever drawn twice.

Collapsing can't hide anything you need: a session blocked on you is in **Needs you**
above, and a pinned one is above that. What's left inside a group is quiet by definition —
with one exception, which is why a folded group grows the same pulsing dot its rows carry
when something inside it is **working**. Blocked and unread get hoisted out; running
doesn't, so that dot is the only thing standing in for it.

Group headings are the one label in the rail you *wrote* — the folder headings under them
are derived — and they're the only thing that folds a block of sessions out of sight, so
they carry more weight than everything under them: larger, brighter, and fenced off above.
A rail of nine folders should read as five things.

**`recent`**, off at the right of the rail head, drops all of it — groups and folder
headings both — for one list ordered by what moved last. For the morning where you know
which session you want but not which of nine folders it lives in, the filing is three
extra reads.

**Pinned** and **Needs you** survive the switch, because neither is a group you made: one
is a promise about where a row will be, the other is the queue of things that stopped for
you. A rule separates them from the list. The setting lives in the browser rather than on
the server — unlike a group's collapse state, which is a fact about your filing and should
follow you between windows, this is a fact about the window you're in, and a phone and a
desktop want different answers.

An **open** group is tinted end to end — heading, folder headings and rows together — so
the block reads as one thing rather than a heading followed by some rows that happen to
be indented. Collapsed groups stay flat, which makes the tint itself say "this one is
open". Rows inside still darken under the cursor: the tint is a mix off the ink colour
rather than the sunk grey hover already uses, so both work in either theme.

Groups live in `~/.foreman/groups.json`, collapse state included, so two windows
agree and a reload doesn't reopen everything you just tidied away. A group whose folders
have nothing running is still drawn — dimmed, `· 0` — rather than vanishing into
something you can't rename or delete.

### Snapshot and restore

A dozen sessions across nine folders is twenty minutes of `+ new` to rebuild after a
reboot. `snapshot` in the rail head saves the set you have open, and puts it back.

The dialog shows when the snapshot was taken, how many sessions are in it, and how far the
bench has drifted from it — *2 running now aren't saved · 1 saved isn't running*. The
button itself wears a dot whenever that line would say anything, because a snapshot you
saved once and forgot is worth noticing the day before the reboot rather than the morning
after. `save now` replaces it; there is one slot.

`restore…` shows exactly what it is about to start before it starts anything, with
anything already running greyed out and marked, and each row ticks over — *started*,
*failed*, *already running* — as the sessions come up one at a time. A folder renamed
since the save fails on its own line and doesn't take the others with it. Untick **open a
Terminal window for each** and they run in tmux only.

A snapshot holds each session's launch folder, its label, and whether it was started with
permissions skipped. What it deliberately doesn't hold:

- **Groups**, because `groups.json` is keyed by folder and never pruned. The shelves are
  still there after a reboot, waiting for sessions to reappear in those folders — a copy
  in the snapshot would be a second source of truth for the one part of this that already
  survives on its own.
- **The queue**, because its entries are messages written for a conversation that no
  longer exists. Sessions come back **fresh** — same folders, same names, no history.
  Reading a conversation back is `claude --resume`'s job.

Pins do come back: they're pane-keyed with a tmux-birthday guard, so every one of them
dies at reboot by design, and re-pinning is what makes the restored rail look like the one
you saved.

It lives in `~/.foreman/snapshot.json`. Restoring twice is harmless — a name that is
already up is skipped rather than started, so nothing acquires a `-2`.

### Relaunch all

Update Claude Code, or change a global setting that only takes effect at launch, and every
session already running is on the old one. `relaunch all…`, in the same Snapshot box,
closes each of them with `/exit` and starts it again — same folders, same names, same
groups, same pins.

It asks which kind, and neither is a default:

- **relaunch, keep history** — each session comes back with its own conversation, via
  `claude --resume`. It continues the *same* transcript file, so the rail row, its history
  and its place don't move; a lead comes back as a lead, with today's brief and tools, and
  yesterday's context. A pane the panel never bound to a transcript has no history to come
  back with, and the list says *no history* against it beforehand rather than surprising
  you afterwards.
- **relaunch fresh** — new conversations, the same thing `restore…` does.

It is deliberately fussy about what it will touch:

- **Not while a worker is running.** It refuses and names them. A worker can't be put back
  — it would get no brief, no `foreman` tools, and half the time its worktree has been swept —
  so the honest answer is to close the tasks first.
- **A session holding something is left alone.** A permission prompt, a plan box, a
  question, a picker, the startup trust gate: the pane is re-read at the moment of the
  press, and anything holding one keeps running and is marked *left alone* with the reason
  on hover. Half-relaunching the machine quietly would be worse than not starting.
- **Everything is reported.** How many came back, how many with their history, what was
  skipped and why, what failed and why.

Sessions are closed first and then started one at a time, so there is a stretch in the
middle where the bench is down; the box stays open and each row shows where it has got to.
The saved snapshot is not touched — this reads the roster as it is right now, so pressing
it never spends the bench you saved.

### Tool chips

Tool calls stay one quiet line between messages, but each carries what you'd otherwise
have to open the terminal to learn.

- **Edits** show `+12 −4` on the chip and expand into a real diff. Claude Code already
  computes it and stores it as `structuredPatch` — standard unified-diff hunks — so the
  panel renders that rather than implementing a diff of its own.
- **Bash** shows how long it took, once past 1.5s. There's no per-tool duration in the
  transcript; it's the gap between the call and its result.
- **Subagents** show their model and duration, and expand into what the agent was told,
  what it did, and what it handed back. A subagent keeps its own transcript in the same
  format, so its steps render through the same code — nested tool chips, diffs and all.
  Loaded on first open, since those files run to hundreds of kilobytes.
- **Failures** open by default with a red rail. A failed command is the one thing you
  shouldn't have to click to discover. An interrupted one is marked separately.

Diffs are capped at 400 lines so a large refactor doesn't ship thousands of rows to the
browser. Subagent transcripts are served only for file paths the panel has actually seen
referenced by a transcript, so `/api/agent-run` can't be turned into a read-any-file
endpoint.

### Slash commands and `@` mentions

Typing `/` at the start of a message offers the session's real commands with their
descriptions and argument hints; `@` after whitespace offers files from its working
directory. `Tab` or `Enter` accepts, arrows move, `Escape` dismisses — and the list is
advisory, so anything not on it still sends.

Both triggers are deliberately narrow: `/` only counts at the very start of the message,
and `@` only after whitespace, so `a/b/c` and `alex@example.com` never open a menu.

**Where the command list comes from.** There is no single place that lists them, so:
built-ins are read out of the installed CLI itself (so the list tracks the version on
this machine instead of rotting in a hardcoded array), plus `~/.claude/plugins/**`,
any `SKILL.md`, `~/.claude/commands`, and `<cwd>/.claude/commands`. Currently 128 on
this machine. Scraping the TUI popup would have been the other option, but typing `/`
into a live pane would clobber whatever was half-typed there.

**Where the file list comes from.** `git ls-files -co --exclude-standard` when the
directory is a repo — fast, already honours `.gitignore`, includes files you just
created — with a bounded walk as the fallback. Matching is subsequence-based, so `svtmx`
finds `server/tmux.js`, and scoring favours the basename over deep paths that merely
contain the letters.

### Images

Paste or drop an image onto the composer. The panel saves it to
`~/.foreman/images/` and drops the **path** into your message — which is exactly
what happens when you drop a file onto the terminal today: the path arrives as text,
Claude Code calls `Read`, and the tool result carries the image.

The composer shows a chip — thumbnail, your original filename, and an `x` to remove —
rather than a long path, so the box keeps holding your words. The path is substituted in
at send time, ahead of your text, the way a dropped file leads in the terminal. Pending
images are per session and survive switching away and reloading; a failed send puts them
back.

The copy is unavoidable, not a preference: a browser hands JavaScript the *bytes* and
the *filename* of a dropped file, never its location. Measured on this machine — a
Finder drag into Chrome offers only the `Files` flavour, with no `text/uri-list`, no
`file://` URL, and `File.path === null`. Terminal.app can type your real path because
it is a native app; a web page cannot see it. Your original filename is preserved in
the saved copy, behind a timestamp prefix. Uploads are validated by magic bytes (PNG/JPEG/GIF/WebP, not
the client's content-type), filenames are reduced to a safe basename, 25MB cap, and
anything older than a week is pruned on startup.

> Sessions in **manual** permission mode will ask before reading from that folder, since
> it sits outside the project. The panel's permission card handles it — option 2 is
> usually "allow reading from images/ for this session". Sessions in auto mode don't ask.

### Images a session captured

The other direction: images that come *back*. A screenshot a tool took, or one you pasted
into the terminal, is in the transcript as base64 — and until now the panel threw both
away, rendering a captured screenshot as the literal text `[image]` and dropping a
pasted-only message entirely.

They show up in two places.

**A strip across the turn.** Thumbnails sit at the point in the timeline where the images
landed — under the tool chip, not inside its collapsed body, and under your own bubble for
one you pasted. Click one for the full-size view: click anywhere or `Esc` to close, `←`/`→`
to step through that turn's set. The strip scrolls sideways inside itself, so a turn that
captured eight screenshots never makes the conversation scroll.

**A gallery.** `images` in the pane header opens every image the session has produced, in
order, each captioned with when it arrived and marked `pasted` or `subagent` where that is
what it was. Clicking a thumbnail opens the same full-size view.

The gallery is the whole file, and that is the point. Everything else in the panel reads a
*window* of a transcript — the tailer backfills from the end, `probe` samples head and tail
— so a gallery built from what is on screen would be a subset and would look complete. It
makes its own streaming pass instead: ~10ms on a 2.9MB transcript, ~55ms on the largest one
on this machine at 26MB, cheap enough to redo on every open rather than cache.

Bytes never travel over the websocket. A transcript frame names an image —
`{uuid, index, media}`, the ordinal it was walked out under — and the browser fetches it
from `/api/sessions/:id/image/:uuid/:index`, which is immutable and says so, so each
thumbnail is fetched once however often the strip repaints. One screenshot is ~60KB and
nine of them were 19% of one transcript; inlining that would have made the socket carry it
again on every subscribe.

No filename is shown, because there isn't one: on these records `toolUseResult` is an array
that duplicates the content blocks and carries no path. The caption under a gallery
thumbnail is the text that came with the image in its own record — `Successfully captured
screenshot (1274x952, jpeg)`, or your own words beside a pasted one.

### Drafts

Whatever you've typed but not sent is kept per session, so switching away to check
something else doesn't lose it. Drafts persist across reloads (`localStorage`), move
with a session when it earns its real id, and are restored to full height rather than
crammed into a two-row box. A send that fails puts the text back rather than swallowing
it.

### Suggested prompts

An idle session offers a guess at your next prompt as dim ghost text inside its own
composer, which Tab accepts in the terminal. The panel shows it as one muted line above
the box, on the desktop and on the phone, with a button that takes it up.

It is an **offer, not history** — it never goes into the transcript, and it disappears the
moment the session starts working, is blocked on anything, or you type something of your
own. That last one is what makes the button safe to press without thinking: it only ever
appears over an empty box, so there is nothing of yours for it to replace.

By default the button reads **use** and puts the text in the box, to edit or send. A
setting — *Suggested prompts* in the panel's settings, and at the bottom of the phone's
home screen — makes it read **send** and go on one press instead. It is off by default,
stored per browser (your phone and your Mac answer separately), and applies the moment
you tick it.

The text goes through the panel's normal send path, the same as anything else you type
here. The terminal's own Tab is never driven.

Two honest limits. It is a poll behind, like everything else the panel scrapes off a
pane. And a suggestion the terminal had to truncate to fit its own width — which it does
with an ellipsis, at around 34 columns and below — is not offered at all, because the
panel cannot spell it in full and would otherwise prefill your box with a literal `…`.

### Effort

The selected session shows its effort level in the header, beside the model. Not in the
rail cards — there it was a fourth near-identical value on every row, crowding the
things that actually differ between sessions.

It comes from the **transcript**, not the pane: every assistant turn records `effort`.
The footer does show it, but only intermittently — that right-hand slot rotates through
hints (`/rc`, "new task? /clear to save…"), so scraping it would report `unknown` most
of the time. It's shown as a quiet scale rather than in green/amber/red, since it is a
setting and not a warning.

### Context pressure

The context percentage is coloured on one shared rule, used by both the rail and the
header so they can never disagree: **under 50%** green, **50-70%** amber, **above 70%**
red.

### Permission mode

A picker beside Send shows the session's current mode, each in its own colour so it
registers without being read: **auto** amber, **manual** grey, **accept edits** teal,
**plan** indigo.

It reads as direct selection, but the TUI only offers a *cycle* — shift+tab steps to the
next mode. So the server presses `BTab` and re-reads the footer after each step until the
mode matches, rather than counting presses blind. The order, observed rather than assumed:

```
auto -> manual -> accept edits -> plan -> auto
```

It refuses to switch while a permission prompt is open (shift+tab means something else
there), and if the mode won't settle it says so and leaves the picker showing what the
session is actually in.

A session started with `--dangerously-skip-permissions` is marked wherever you'd meet it:
a filled red **bypass** badge on its rail row, and **bypass permissions** leading its
header. That session never stops to ask, which changes what everything else on the row
means, so it goes first on both lines.

It's read off the pane, in Claude Code's own words — such a session draws
`⏵⏵ bypass permissions on` where the rest draw `auto mode on` — rather than out of the
process table, so it reflects the session's live state instead of how it was launched. It
is deliberately absent from the mode picker: that list is the shift+tab cycle, and putting
bypass in it would hand the panel a way to switch a session into running without asking.
While a box or a picker owns the footer there's no mode line to read, and the last answer
stands — a session doesn't stop looking dangerous for as long as it spends asking you
something.

### Permission prompts

Permission boxes never reach the transcript, so the pane is the only source. The panel
parses the real box — tool, subject, any diff, and the actual numbered options — and
renders each option as its own button.

![A permission prompt as the panel draws it: the tool and the file at the top, the diff it
wants to apply, the question, and the box's three real options as separate buttons. The
second — a yes that also switches the session into accepting edits — is outlined rather
than plain, and the composer below reads "answer the prompt above" with its send button
showing queue.](docs/images/permission-card.png)

Answers are sent as the option's **digit**, which Claude Code accepts directly. That
needs no assumption about where the cursor sits, and the server refuses to send at all
if the named option isn't on screen or its label has changed since you saw it.

> This replaced a v1 defect. v1's Deny sent `Down, Enter`, which lands on option 2 —
> and option 2 is reliably a *broader* yes ("Yes, and don't ask again", "Yes, allow all
> edits this session"). Deny didn't just approve, it granted a standing rule. `No` is
> option 3 in every prompt shape observed. `test/permission.test.js` guards this.

If the box can't be parsed confidently, the panel says so and offers no buttons rather
than guessing.

### Session names

Every tmux session the panel mints is named `<prefix><folder>-<label>` — by default
`foreman-alpha-main` — where the label is what you called the session (or a serial number
if you didn't). That label is the best name available, so the rail uses it, and drops the
redundant project prefix under a project heading, so `ALPHA` lists `main` and `quesitons`
rather than the same word twice.

The prefix is `sessionPrefix` in `<STATE_DIR>/config.json`, and **you almost certainly
never need to touch it**. It exists for one situation: a machine already running some
*other* launcher that mints tmux sessions under a prefix of its own, where that prefix is
load-bearing for that tool — a restore-by-name, a `tmux` key binding guarded on the
session name, a shell wrapper that only titles sessions matching it. Setting
`sessionPrefix` to that tool's prefix makes this panel mint and read the same names, so
the two coexist and every session shows up in the rail.

That is a trade, and it is one way round only: the panel recognises **exactly one**
prefix, the configured one. There is no compatibility mode that mints under one name and
also answers to another, because a panel that claimed sessions it could not name back is a
panel that binds a transcript to the wrong pane.

**What "not recognised" actually costs, measured rather than assumed:** a session whose
name does not carry the configured prefix is still in the roster and still readable — the
panel lists every Claude Code pane on the machine and always has. What it loses is its
*name*. `label` comes back `null`, so the rail falls back to the transcript's own title,
which is `<repo>-<branch>` and reads identically for two sessions on one branch;
`slugFor` yields nothing, so duplicating such a row auto-numbers instead of taking its
label, and a snapshot cannot put it back under the name it had; `isLeadName` never matches,
so a lead among them is not badged as one; and the pbcopy binding, which is server-global,
is rewritten to the configured prefix at the panel's next launch, so drag-to-copy stops
firing for them. Changing the prefix on a running machine does all of that to every session
minted under the old one — see the note at the top of `server/snapshot.js` for exactly what
a saved bench does across that change.

The transcript's own title comes from the `claude()` wrapper in `~/.zshrc`, which passes
`--name "<repo>-<branch>"`. Two sessions in one repo on one branch therefore get
*identical* titles — every one of the 5,902 title records in one folder on this Mac says
the same `<repo>-main`. A wrapper that prefers the session's own label when it is running
inside a matching tmux session makes new sessions stamp a unique name into their transcript,
which is what makes binding exact rather than a guess — see below.

### Pane ↔ session binding

Deciding which transcript belongs to which pane is the part of the panel most able to
lie to you: bind wrongly and you read one session's conversation while typing into
another's terminal. Three rules, descending confidence — and it would rather show
nothing than guess. `server/binding.js`, covered by `test/binding.test.js`.

| Rule | Basis |
| --- | --- |
| `hook` | a hook told us outright. Authoritative. |
| `label` | the transcript's own name matches the pane's launcher-minted label. Exact. |
| `inferred` | newest transcript in the folder — only where the folder runs a single pane, so there is nothing to confuse it with. |

A rail row shows which of the three it got only when that is worth knowing — as a small
open padlock under the status dot, because everything else on that row is only as true as
this. Grey: matched by name. Amber: worked out from the folder. A `hook` row draws
**nothing**, and on a healthy Mac that is nearly every row: the hook is authoritative, so
the mark would be twenty identical reassurances, and a mark on every row is not a mark —
the one row that differed had to be hunted for among them. `label` keeps its padlock even
though it is exact, because it is still the panel reasoning and a title can be shared by
every session in a repo. The rule for anything added later is the same: if the panel
wasn't *told*, it draws.

The cell stays empty rather than closing up. The row's first grid column is a fixed
0.85rem and the meta line beside it is taller than the mark, so a title sits at the same x
and the same y whether or not a padlock is under it — measured across a full rail, two
title positions (in a group and out of one) and two row heights (two-line and the team
three-line), with marked and unmarked rows sharing both. A rail whose titles jogged as
bindings resolved would be a worse trade than the padlocks were.

Drawn as inline SVG rather than set as a character, which is not fussiness — it's two
bugs. The padlock emoji carries so much detail that at eleven pixels every state is the
same grey blob, and a glyph rides the text baseline, so it never quite shares an axis with
the dot above it. The body is solid for the same reason: an outlined one at that size is
four hairlines and a hole, and reads as damage rather than as a lock. What separates the
two drawn states is the colour, which survives being 13 pixels tall.

All three ask "could this pane have started this transcript", and answer it from the
folder Claude Code filed the transcript under (`~/.claude/projects/<cwd with each slash as
a dash>`) rather than from the `cwd` on its records. The recorded one moves: a session
that changes directory mid-conversation rewrites it on every record from then on, and a
perfectly identifiable session went unbound because of it. The folder name is stamped at
launch and never rewritten.

A pane that matches nothing shows as **pane-only**: present and typeable, with an empty
transcript and a note saying whether it simply hasn't spoken yet (`new`) or its history
can't be told apart from a sibling's (`ambiguous`). It never borrows someone else's
history to look populated.

Two guards do the real work, both learned from bugs this found:

- **Freshness** — a transcript last written *before* a pane existed cannot belong to it.
  Without this a brand-new session adopts whatever ran in that folder yesterday, and a
  restarted session adopts its own previous run.
- **Ownership** — a file naming a different live pane is never taken, so an exited
  session's leftover transcript can't be inherited by a sibling.

One more wrinkle, learned the hard way: a session labelled `main` in a repo on branch
`main` produces the title `Alpha-main` — indistinguishable from the old
`<repo>-<branch>` default. The panel resolves it by asking whether any *sibling* could
still be writing that default: a pane launched after the shell config was last changed
always stamps its own label, so it can never be the impostor. If no sibling is suspect,
a matching title is simply this pane's.

Ambiguity comes from *siblings*, not from names. One pane in a folder means one live
conversation, so a name mismatch there is harmless — sessions predating the `--name`
change are titled `<repo>-<branch>`, e.g. label `gamma-main` against title
`Gamma`. Several panes in a folder means only an exact label match is safe.

### Sending

Two paths, because neither alone is right. A **single line** is typed literally
(`send-keys -l`), which is what makes slash commands work — Claude Code executes a
complete command line even with its autocomplete popup open. **Multiple lines** go in as
a bracketed paste (`set-buffer` + `paste-buffer -p`), because `-l` would send each
newline as its own Enter and submit a three-line message three times.

Before anything is sent, two guards borrowed from the other launcher's hard-won experience:
`C-u` clears whatever was half-typed in the pane, and the pane is re-checked to confirm
it is still running Claude. That second one matters — the roster is up to a poll stale,
so a session that exited would leave a plain shell at the same pane id, and your next
message plus Enter would be *executed* rather than read. Every tmux call also forces a
UTF-8 locale, without which `send-keys -l` mangles accents, smart quotes and emoji.

### The queue

Type into a session that can't hear you and the message waits rather than landing in the
wrong place. It waits **on the server**, not in the tab: close the browser, open it
somewhere else, and the list is the same one.

The panel doesn't decide — it posts the message and the server either types it or queues
it. Three things have to agree that a session is free: the roster (which carries the
hook's word, the only reliable read on "working" — the pane doesn't always show a spinner
while a reply streams), a fresh `capture-pane` (which catches anything opened since the
last poll), and a per-pane lock held for a beat after each delivery. Without that last
one a burst of messages all see `idle` and all get typed onto the same prompt line.

Queued messages go one at a time, oldest first, each waiting for the last to finish. They
show above the composer with the next one marked, and any of them can be dropped. A
delivery that fails keeps the message and backs off rather than losing it.

The queue is keyed by **pane**, not session id — session ids rotate on `/clear`, and a
pane you haven't spoken to yet has none at all. Each item remembers when its tmux session
was created, so a `%19` that comes back belonging to a new tmux server is pruned rather
than delivered to a stranger.

### Dialogs

`/model`, `/effort`, `/config`, `/resume` and the startup trust box take over the pane.
Nothing is running and no permission box is open, so v1 read these as plain `idle` — and a
message sent then was typed into the picker, where the characters select options.

The panel shows these as **dialog**, names them by their heading or their question, and
holds anything you send until they close. Detection is simply the composer's footer being
absent: if Claude Code will accept typing, it draws the box to type into.

The permission box is held to that same test, and for a reason found the hard way: a
session working in *this* repo scrolls "Do you want to proceed?", a numbered run of
options and "Esc to cancel" through its pane every time it shows a diff of the permission
fixtures. Read as a live box, that froze a busy session behind "the prompt could not be
read". Text above a drawn composer is transcript, whatever it looks like.

### Claude's own questions

When Claude asks *you* something (`AskUserQuestion`), the panel renders the options and
answers for you — the same card as a permission prompt, and the session sorts to the top
of **needs you** with an `asking` chip.

Single-select rows send on click, because one keypress is exactly what the terminal does.
Multi-select rows tick, and **submit** walks the terminal's own path: toggle each row, press
`Tab` for the review screen, then confirm. The keys are a *diff* against what is already
ticked — the box remembers, so re-sending a ticked option would turn it off.

Nothing is submitted unverified. The server re-reads the review screen and only presses
submit if every option you chose is listed there; otherwise it stops with the ticks made
and says so, which is a state you can finish in the terminal.

**When the answer isn't on the list.** Below the numbered options the box draws two more
rows, separated by a rule, and the card offers both. *Chat about this* declines the
questions and hands the composer back, so you can reply in prose — the one thing you
otherwise cannot do, because a box holding the pane turns **send** into **queue**. The text
field beside it answers in your own words: it opens the box's own free-text row, types what
you wrote, and presses Enter, checking after each step that the terminal is still where it
should be. It appears on single-select boxes only — on a multi-select that row's digit just
ticks it, with nothing listening for the text.

Both were missing until they were asked for, and the reason is the rule above them: it ends
the numbered run, which is exactly what stops `permission.js` from claiming these boxes.

They're recognised by two things together, since neither is specific alone: a line of key
hints (`Esc to cancel`) in the last few lines, and the composer's own footer being *gone*
— the `project | model | ctx:` line and the mode line below it. The `❯` glyph is no help,
because the dialogs mark their selected row with the same one. A dialog outranks the
hook for the same reason a permission box does: the hook happily reports `idle` while one
is open.

That missing footer costs something, though: the model and context percentage are read
from it, so a session blocked on a box reports neither for as long as it is blocked. The
roster keeps the last footer each pane actually drew — the same memory it keeps of the mode
line for `bypass` — which is why a session that is asking you something still shows its
model rather than going blank while you decide.

### Approving a plan

Leaving plan mode puts up a box the panel used to shrug at — *"blocked, but the prompt
could not be read"* — which is a poor place to be stopped: it is the end of a long read,
and the session waits until you walk back to the Mac. The panel now offers it as a card,
with the plan file itself folded into the top. Open that and you get the plan rendered
where you are, which is the difference between approving something you've read and
something you haven't.

This box is **not** a permission box, in the one way that matters. Its options are built
fresh at every render — two to five of them — and *option 1 is the broad yes*, the exact
inverse of the rule the permission parser was written for. The first row can be
`Yes, clear context (91% used) and bypass permissions`: one press that throws the
conversation away and stops the session ever asking again.

So the card reorders. The narrow yes — **manually approve edits** — is the top button
whatever number it carries, because the top button is the one that gets pressed unread.
The ones that cost you the session are last and red, and the Ultraplan row is marked
because it sends your plan off the machine. Every button shows and sends the option's
**own digit**; nothing here is answered by position.

`Tell Claude what to change` is a text field rather than a button. It sends the row's
digit, your note, then `Enter` — never `shift+tab`, which on that row means *approve the
plan and pass the note along*, the opposite answer. And the mode picker refuses outright
while the box is up, since `shift+tab` there approves rather than cycles.

Recognition is the header, one of three known strings, and nothing else — a numbered list
under an unfamiliar heading gets no approval buttons. The server re-reads the box before
sending, and refuses if the label behind the number has moved since the page drew it.

---

### Choosing a model

The model name under the composer is a button. Press it and the panel opens the real
`/model` dialog in that session and draws what it actually says — the five rows with their
own blurbs, the current one ticked. Pick one and it applies to **that session only**.

The dialog staying open in the terminal while the menu is open in the browser is the point:
the panel is a remote control for that box, not a copy of it. Dismissing the menu Escapes
it rather than leaving one holding the session.

Setting a *global* default is deliberately not offered here. In that dialog a digit selects
**and** writes `model` in `~/.claude/settings.json` for every session you start afterwards,
and `Enter` does the same — so the panel sends neither. It steps the cursor with arrow keys,
re-reading the pane after each press until the highlight is on the row you clicked, then
presses `s`. Changing what every future session starts as is a decision worth making in the
terminal, where you can see it.

`s` is not always the last key. Once a conversation has run under its current model, Claude
Code holds the switch behind one more box — `Switch model?`, warning that the whole history
gets re-read on the next message — and until that is answered nothing has changed. The
panel answers it, because the click already said switch, and it says so afterwards: the note
under the composer reads *history re-read on the next message*. It checks first that the box
names the model you clicked; anything else and it Escapes back out and changes nothing.

### Choosing an effort level

The effort level sits beside the model, and looks almost the same — but it is the opposite
kind of control, and the panel says so rather than hiding it. Claude Code has **no
per-session effort**: `/effort` offers only `Enter to confirm`, and what that writes is
`effortLevel` for every session you start afterwards. The row inside `/model` is no
different — pressing `s`, the "this session only" key, still writes it globally. Both were
measured, and both had to be put back from a backup.

So the button carries a dotted underline instead of the model's plain one, its tooltip says
what it changes, and the menu opens with a line saying it before you pick anything. Picking
a level walks the marker along the track one press at a time — arrow keys write nothing, so
nothing is committed until the `Enter` at the end.

### Opening a Terminal on a session

Beside the folder icon, a small window glyph appears in a pane header **only while nothing
is attached** — a session started with the Terminal box unticked, or one whose window you
closed an hour ago. Pressing it runs the same `attach` the launcher does, so the button is
also the answer to "where did that window go".

It is drawn from `#{session_attached}`, read off tmux on every poll rather than remembered
from the launch, which is why it comes back on its own when you close a window and goes
away on its own a second after you press it.

One consequence worth knowing, since nothing on screen would tell you: **attaching resizes
the pane to the window**. A session launched at 220×50 and attached from a default Terminal
becomes 80×23 — measured, not estimated — and every parser in `server/` reads a pane by its
wrapped lines. Nothing breaks; the fixtures cover narrow captures. But the panel is looking
at a different shape of screen afterwards, and the button's tooltip says so.

### Opening the folder

The folder icon at the right of a pane header opens that session's directory in Finder,
on the Mac the server is running on. It's drawn rather than labelled because the four
controls beside it are verbs about the session and this one is about somewhere else — and
it opens the pane's *launch* directory, the one its rail heading is named after, not
wherever the conversation has since changed to.

### Split view

The `split` button in a pane header — or `⌘\` — opens a second column with its own
header, transcript and composer. Both are fully live: separate queues, question cards,
permission buttons and mode pickers.

The rail always opens into the **focused** pane, which is whichever you last clicked; a
thin accent line on its header says where the next click will land. With one pane open
nothing is marked, because there is nothing to distinguish it from.

A reload puts both panes back where they were. Each slot remembers what it was showing —
by session id, and by pane as a fallback, since `/clear` mints a new id for the same
terminal — and the first roster frame restores it instead of dropping you on whatever
sorts first. Closing a pane on purpose is remembered too, so it doesn't reappear.

Under the hood a subscription is keyed by client *and slot*, and every transcript message
comes back stamped with the slot it belongs to. In the browser this meant lifting the
per-session state — selection, messages, the composer — out of module scope and into a
`createPane` factory; two of everything, sharing one roster.

### Installing it as an app

The panel ships a web-app manifest, so it can leave the browser and become a window of its
own: **Safari → File → Add to Dock**, or **Chrome → the address bar's install icon → Install
app**. You get a Dock icon, no tabs and no address bar. The phone view at `/m/` installs the
same way from iOS Safari — **Share → Add to Home Screen** — as a full-screen web app.

They are deliberately **two apps, not one**. Each manifest carries its own `id` (`/` and
`/m/`) and its own icon: the panel's mark is a rail of rows with the top one in the colour of
a session that needs you, the phone's is a lead with two workers indented under it. Two
manifests on one origin that share an `id` are one app as far as a browser is concerned, and
installing the second would quietly replace the first.

The mark is generated, not drawn by hand: `npm run icons` runs `scripts/make-icons.mjs`,
which is the only description of it — the SVG and every PNG size come out of one set of
coordinates, so the vector and the bitmaps cannot drift apart. It needs nothing but node.

### Notifications

Off by default, and opt in from the settings box: **Notifications on this Mac → Tell me when
a session needs a human**. With it on, the panel raises a macOS notification the moment a
session walks into something it cannot get past — a permission prompt, a question Claude is
asking, a plan waiting for approval, the folder-trust gate — and when a worker's task reaches
`review`. Clicking one focuses the window and opens that session.

What it deliberately is not: a reminder, a digest, or a badge count. One notification when a
thing happens, replaced rather than repeated if that session then needs something else, and
nothing at all while it sits there waiting. Opening the panel announces no backlog — the
first roster frame after a page load is a baseline, because half the sessions here are at a
prompt at any given moment.

Two quiet rules it inherits rather than invents. A **worker's** own prompts stay silent until
its stuck timer fires, because a worker's prompt is its lead's to answer — the same rule that
keeps it out of the inbox. And "it replied and you haven't read it" is not a notification; it
is an unread badge, which is where it stays.

**It only works where the browser will allow it, which means on this Mac.** Notifications need
a secure context: `http://127.0.0.1` counts as one, a LAN address over plain `http://` does
not. Opened from the phone or another machine the control is disabled with the reason printed
under it rather than silently doing nothing. That follows from the exposure decision in
[SECURITY.md](SECURITY.md) rather than being a gap in it, and the phone's half of this is the
Home Screen icon.

The preference is remembered in the browser that answered — it is not a panel setting, it
applies the moment you tick it, and `save` does not touch it. Every browser and every device
answers for itself. There is a `test` button beside it, because "did I actually grant this?"
deserves an answer that is not "wait for a session to block".

## The team

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
its answer — with a reply box at the bottom.](docs/images/phone.png)

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
folded; and a last grey card for the PR it opened.](docs/images/team-room.png)

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
underneath.](docs/images/team-tasks.png)

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

**What has actually been run, since the README should claim only that.** The **Gitea** path
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

## Layout

```
server/
  index.js        HTTP + WebSocket, hook receiver, send/answer endpoints
  sessions.js     the roster: merge panes + transcripts, bind, diff
  binding.js      which pane is writing which transcript, and when to admit it can't tell
  tmux.js         pane roster, injection, TUI state scraping
  permission.js   parses the permission box off the pane; answers by option digit
  question.js     parses AskUserQuestion; plans the keys that answer it
  plan.js         parses the plan-approval box; answers by the option's own digit
  model.js        parses /model and the Switch model? box behind it; steps, never a digit
  effort.js       parses the /effort track; nudges the marker, then confirms
  queue.js        messages waiting for a pane to be ready, persisted
  claim.js        the lock between a message and a pane — nothing types without it
  pins.js         panes held at the top of the rail, persisted
  snapshot.js     the saved set of sessions, and putting it back
  groups.js       folders filed under names you chose, and whether each is folded
  launch.js       starting a session, ported from the other launcher on this Mac
  read-state.js   per-session read watermarks, persisted
  transcript.js   cheap metadata probe, and the offset-based tailer
  normalize.js    JSONL records -> view messages
  status.js       hook events -> state + pane bindings
  commands.js     the session's real slash commands, for completion
  files.js        file listing under a session's cwd, for `@` mentions
  uploads.js      pasted and dropped images, saved and pruned
  images.js       every image in a transcript, for the per-session gallery
  git.js          what the shell wrapper would have named a session by default
  wrapper.js      when ~/.zshrc last changed, which dates the naming scheme
  config.js       ports, paths, windows, thresholds — and the resolved bind
                  host and session prefix
  settings-file.js  <STATE_DIR>/config.json — the bind host, the session prefix,
                    and the settings modal's validator, writer and loopback guard
                  and extra origins, read once at boot and seeded on the first one
  origin.js       which browser origins may write — a browser guard, not auth
  trigger.js      the trigger endpoint's allow-list, and the lead it resolves to
  install-hook.js one-shot settings.json registration
  install-agent.js the LaunchAgent installer — writes and bootstraps the plist
  logs.js         where launchd's log files are, and the boot-time trim that bounds them

  --- the team ---
  team.js         a team's folder on disk: config, toggles, decisions
  tasks.js        the task records and their states, persisted
  worktree.js     one checkout per task, branched from the base; setup, removal, prune
  setup-detect.js the worktree-prepare command, read off the repo's own files
  forge.js        GitHub / Gitea / push only / no remote, derived per repo
  base-branch.js  what this repo calls its default branch — detected, never typed
  dispatch.js     a worker's settings file, the git deny floor, the one trust gate
  room.js         the append-only per-team log, addressed and broadcast
  watch.js        worker transitions, stuck and looping detection, the lead's nudge
  conflicts.js    two workers touching one path — committed and uncommitted alike
  gc.js           boot housekeeping: prune worktrees, sweep cold failures
  deployed.js     merged, pulled, and actually running here — three different facts
  merge-queue.js  the PRs waiting on you, and the one sentence its button types
  lead-brief.js   what a lead is told it is, assembled at launch
  worker-brief.js the same for a worker, plus its task
mcp/
  foreman.js      the tool surface, over this panel's own API — one server, two roles:
                  a lead gets dispatch, read, send, room and the gated answering tools;
                  a worker gets exactly two, and can never touch another session
web/
  index.html  styles.css  app.js   (app.js: shared shell + rail, then a createPane factory)
  trust-gate.js   the one screen nothing may answer — the only web/ file server/ imports
  notify.js       what is worth interrupting somebody for, and when it became true
  manifest.webmanifest  m/manifest.webmanifest   two installable apps, two ids
  icons/          the mark, generated — never hand-edited
scripts/
  make-icons.mjs  the only description of the mark: one geometry, the SVG and every PNG
  backup-state.sh a copy of the state dir and the plist, before anything risky
```

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `FOREMAN_PORT` | `48770` | HTTP/WS port (48765 is the other launcher's — stay clear) |
| `FOREMAN_HOST` | `127.0.0.1` | bind address, and the top rung of the precedence below: `$FOREMAN_HOST` → `config.json`'s `bindHost` → `127.0.0.1`. Loopback by default everywhere, including under the LaunchAgent — the installer writes the resolved value into the job and **omits the key entirely when it is loopback**, so the panel is on the local network only if something said so. Read [SECURITY.md](SECURITY.md) before widening it |
| `<FOREMAN_STATE_DIR>/config.json` | *(seeded)* | the panel's own settings file, holding `bindHost`, `sessionPrefix` and `allowedOrigins`. **Written by the panel at first boot** — never by hand, never rewritten — recording the host that boot was actually using, so a value that reached the panel through the environment survives the environment going away. Read **once at boot**: edit it and restart, and the `Config:` boot line says which file and which host. Absent or unparseable falls back to loopback, loudly |
| `FOREMAN_WINDOW_HOURS` | `48` | how far back a transcript counts as recent |
| `FOREMAN_STATE_DIR` | `~/.foreman` | queue, pins, groups, snapshot, read marks, and the team's state — teams, tasks, worktrees. Resolved `$FOREMAN_STATE_DIR` → `~/.foreman` if it is there → the directory an older build of this tool used if *that* is there → `~/.foreman`, and the `State:` boot line says which rung answered. Nothing is ever moved or copied between them. Point a test server elsewhere, and mean it: a second server on the real state dir runs its own worktree housekeeping against your real tasks |
| `config.json`'s `sessionPrefix` | `foreman-` | the prefix on every tmux session the panel mints, and the only prefix it recognises — `<prefix><folder>-<label>`. Read **once at boot** and printed on the `Config:` line. Must be lowercase `[a-z0-9-]`, start with a letter or digit and end with `-`; anything else is a boot warning and the default, never a panel that refuses to start. There is no environment override and no two-prefix mode — see "Session names" below for the one situation where you would change it |
| `FOREMAN_ALLOWED_ORIGIN` | *(none)* | extra browser origins the panel accepts writes from, comma- or space-separated (`http://host:port`). Added to whatever `config.json`'s `allowedOrigins` holds rather than replacing it. Loopback, this machine's own private-LAN addresses and its `.local` name are already allowed and need no entry — see "Which browsers may write to it" below |
| `FOREMAN_TRIGGER_TOKEN` | *(none)* | the shared secret `POST /api/trigger` checks. Checked first, then `<FOREMAN_STATE_DIR>/trigger-token` (one line, `chmod 600`, trailing newline trimmed) — the file is what lets the value survive a restart, since it's read fresh at every boot by every way of starting the panel. Neither one present means the endpoint answers **503 to everything**, not 401: the feature is off, not broken |

### The settings modal

`settings`, in the rail head beside `+ new`, is the panel's own view of that
`config.json`. It shows three things and writes two: the **bind host** — *this machine
only* (`127.0.0.1`), *every interface* (`0.0.0.0`, with what that costs stated beside it),
or a specific address you type — and the **extra browser origins** below it. The
**session prefix** is shown read-only, because changing it would unname every session
already running: they stay in the rail with no label, no duplicate button and no snapshot
entry.

Both writable settings are read **once at boot**, so the box says *takes effect at the
next restart (`npm run restart-panel`)* the moment you change one, and stays quiet when you
have not. On a machine where `$FOREMAN_HOST` is set — under launchd, that means the plist
carries the key — the environment beats the file, and the box says so in place rather than
letting you edit a value the running panel is ignoring: the file's value takes effect at
the next `npm run install-agent`, because `kickstart -k` does not re-read the job.

**Exposure is only changeable from the machine the panel runs on.** A `PATCH` touching the
bind host or the allowlist must arrive on a **loopback socket address** — checked on
`req.socket.remoteAddress`, never on the `Origin` header, and never on `X-Forwarded-For`.
The Origin check below allows a request with *no* `Origin` at all, by construction, so a
LAN peer holding `curl` passes it trivially; that is correct for everything else this panel
does and wrong for the two keys that decide who can reach it. Opened from a phone or
another machine, the modal draws those controls disabled with the reason, and a save
attempted anyway comes back `403` naming the address it saw. This is not authentication and
is not a step toward it — every other capability stays open to a LAN peer, deliberately;
what it may not do is widen its own reach.

**There is no credentials field and there never will be.** The forge is detected from the
repo's own `origin` and from what is registered in `~/.claude.json`, never typed in here: a
token sitting in a world-readable JSON behind a panel with no authentication is a worse
liability than any convenience it buys.

## Running it under launchd

`npm start` is the scratch-server command only — `FOREMAN_PORT=… FOREMAN_STATE_DIR=… npm start`,
unchanged on purpose, because pointing a second server at the real state dir sweeps real
worktrees and flushes the same `queue.json` a running panel already owns. The panel meant
to stay up runs as a LaunchAgent instead:

```
npm run install-agent                # once — writes the plist, bootstraps it
npm run install-agent -- --takeover  # the same, but stops a panel already on the port first
npm run restart-panel                # after any server/ change
npm run stop-panel                   # bootout — leaves the plist on disk
npm run uninstall-agent              # bootout, then backs up and removes the plist
```

The `--` before `--takeover` matters — without it, npm swallows the flag instead of
passing it through to the script.

**Installing displaces an older job of this panel's own, and says which.** A plist's
`ProgramArguments` is a *path*, not a name, so one written under a label this panel no
longer uses goes on starting `server/index.js` at every login — which after a rename is the
current code under a name nothing else knows about. Two jobs then race for one port, macOS
lets both binds succeed with no error from either, they split traffic by interface, and
`restart-panel` kickstarts whichever one is not holding it. So before it bootstraps
anything, `install-agent` looks through `~/Library/LaunchAgents` for plists that start a
`…/server/index.js` which either **no longer exists** (the checkout moved out from under it)
or **is this very file** by `realpath` — boots each one out, backs its plist up into the
state dir, removes it, and names it in the summary.

A plist whose program exists and is a *different* file is left strictly alone. That is what
makes it safe to run this installer from a git worktree, where `server/index.js` is a copy:
it stops there rather than booting out the job pointing at the real checkout.

**`restart-panel` and `install-agent` are not interchangeable.** `restart-panel` is
`launchctl kickstart -k`, which restarts the process but does **not** re-read the
plist — measured: a job's `EnvironmentVariables` was edited on disk, `kickstart -k`'d,
and the *old* value came back; only `bootout` + `bootstrap` (what `install-agent` does on
every reinstall) picks it up. So: changed something under `server/`? `restart-panel` —
the process re-imports its own files fresh, nothing about the job changed. Changed the
job itself — the host, the port, the injected `PATH`? `install-agent` again, never just a
restart. `web/` is read off disk on every request either way and needs neither command.

**Logs** land at `~/Library/Logs/foreman.log` and `…-error.log`. launchd appends to
both across every restart — it never truncates — so **the panel trims them itself, at
boot**: a log over its threshold is copied to `<name>.1` and truncated back to zero, and
the boot says so beside the `Triggers:` line. One previous copy is kept and overwritten
each time; there is no `.2` and no archive. The thresholds are 1 MB for stdout (a boot
writes 172 bytes, so a megabyte is thousands of them — over that, something is logging
that isn't the boot block) and 5 MB for stderr, which is about twelve hours of a measured
crash loop or two days of a once-per-poll error. That is a floor of 12 MB, flat.

It has to be a **truncate**, never a `mv`: launchd holds the log file open, so a renamed
log keeps receiving every line under its new name while the path you are tailing never
comes back. `test/logs.test.js` reproduces that failure before proving the fix.

Nothing runs on a timer — rotation happens once per boot, after the port probe (a panel
standing down must not touch the running one's logs) and before the panel prints anything
of its own. Started by hand with `npm start` there are no launchd logs at all, and it is a
no-op.

**Two panels can no longer share a port.** Two node servers — one bound to `0.0.0.0`, one
to `127.0.0.1` — used to both take port 48770 with no error and silently split traffic by
interface: your phone and your browser reaching two different panels, each running its
own worktree GC against your real tasks. The panel now probes `127.0.0.1:<port>` before
it starts listening and refuses to boot (exit 0, so launchd doesn't crash-loop it) if
anything already answers there — `npm start` while the LaunchAgent is up prints what it
found and exits cleanly instead of starting a second panel.

## Which browsers may write to it

**A browser guard, not authentication.** The panel has no login and is not getting one: on
a machine that binds wide, anyone who can reach the port can still `curl` it, launch
sessions, type into any session and read every transcript. What this check buys is the
*browser* case — **a web page on some foreign site must not be able to make your own
browser act as a LAN peer.** Without it, any page you happened to be visiting could open a
WebSocket to the panel (a handshake is exempt from CORS and triggers no preflight), be
handed the roster of every session on the machine, and stream any conversation on it.

Every non-`GET` request and every WebSocket handshake is checked, in this order:

1. **No `Origin` header → allowed.** That is every non-browser caller — `curl`, the status
   hook, `mcp/foreman.js`, a webhook — and it is unaffected *by construction*, not by a list.
   Browsers set the header themselves and a page cannot remove or forge it.
2. **Loopback on any port → allowed** (`http://localhost:*`, `127.0.0.1:*`, `[::1]:*`).
3. **This machine's own private-LAN addresses at the panel's own port, plus
   `http://<LocalHostName>.local:<port>` → allowed.** Derived from the network interfaces
   at run time, so a new DHCP lease fixes itself and your phone keeps working with no list
   to maintain. RFC-1918 IPv4 and unique-local IPv6 only: link-local (`fe80::/10`,
   which includes AirDrop's `awdl0`/`llw0`) and `utun*` tunnels — where a VPN lands — are
   deliberately excluded.
4. **Anything else → `403`**, with a body naming the origin it refused.

`GET` is deliberately *not* checked: a cross-origin page can send one but cannot read the
response, because the panel never sends an `Access-Control-Allow-Origin` header.

The panel prints the origins it resolved at boot, one line each with the interface and the
reason, next to the `Triggers:` line. To add one — a reverse proxy, a tunnel you have
decided on — set `FOREMAN_ALLOWED_ORIGIN` to a full `http://host:port` (comma- or
space-separated for more than one) and restart.

## Backing up state

Everything the panel depends on that isn't in git — the state dir, the hook
registration, the LaunchAgent plist, `~/.claude.json`, and the repo's own uncommitted
work — in one archive, before a risky change or a switchover:

```
npm run backup-state
npm run backup-state -- --force          # even with the panel running
npm run backup-state -- --desktop-copy   # also drop a copy on ~/Desktop
npm run backup-state -- --verify <archive>
```

It **refuses while the panel is up** (an HTTP probe of `127.0.0.1:$FOREMAN_PORT`, the same
check the boot guard uses) — every store in `server/` is a Map behind a debounced flush,
so a live backup can capture a state dir mid-write. `npm run stop-panel`, run it, then
`npm run install-agent` (or `restart-panel`) to bring it back. `--force` overrides the
refusal and records in the manifest that it did.

The archive lands at `~/foreman-backups/foreman-backup-<timestamp>.tar.gz`, mode `600`
in a `700` directory, **never** under this repo or inside a cloud-sync folder — it contains
`~/.claude.json`, which holds MCP credentials, so a synced path would push those off the
machine. It carries a `MANIFEST.txt` naming every source and whether it was captured or
missing (an absent `snapshot.json` is normal; an absent `tasks.json` is not), which
`--verify` reads back without extracting anything. The script never deletes or rotates
anything itself — if the folder grows, that's a call for whoever's backing things up, not
this script's.

Git already has the repo; what it doesn't have is what's sitting in the working tree.
`git diff HEAD` only covers tracked files, so a brand-new file nobody has `git add`ed yet
is copied in verbatim rather than diffed — otherwise it would silently never make it into
the archive at all.

## Removing the hook

```
npm run uninstall-hook
```

Registration only ever *appends* to the arrays in `~/.claude/settings.json`, and
backs the file up first, so existing consumers are untouched.

`npm run uninstall-agent` is the equivalent for the LaunchAgent — `launchctl bootout`,
then the plist is backed up (to `FOREMAN_STATE_DIR`, not beside itself) and removed.

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
