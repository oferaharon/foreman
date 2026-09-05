# The panel

Every session feature, in reference detail: where the roster comes from, what the rail
does, and how each of Claude Code's own screens is read and answered from a browser.

[README](../README.md) · **The panel** · [The team](team.md) · [Running it](running.md)

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
calls folded into one-line chips.](images/sessions.png)

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

### Rate-limit gauges

Two thin bars for a subscription account's own usage: a five-hour window that refills
through the day, and a seven-day one behind it. Neither exists until `npm run
install-statusline` has run once (see [Running it](running.md#the-status-line-wrapper)),
and neither exists at all for an API-key account — Claude Code never hands that kind of
session a `rate_limits` block to show.

**Colour is the number and nothing else:** green under 50% used, amber from 50% to 74%,
red from 75% up. A bar and its percentage share one `currentColor`, so a row can't read
amber in its text and neutral in its fill.

A reset reads as a countdown inside a day — `2h 53m`, or `45m` under an hour with nothing
to separate — and as a weekday plus the hour beyond it, `Mon 5PM`. The phone's five-hour
bar is the one exception: it shows the clock time it actually resets at, `23:10`, because a
countdown glanced at once an hour never reads as anything but "still running out."

A reading older than fifteen minutes draws dim, its own age printed underneath — `as of
12m ago` — because the feed only moves when some session on the machine takes a turn: a
quiet bench can sit on a real number for hours with nothing wrong. No record at all draws
nothing at all, never a zero and never a placeholder — a bar at 0% would be a claim about a
quota nobody has actually measured yet.

Placement differs by client. On the desktop the bars sit in the rail head, visible
whenever there's a record to show. On the phone they live in the shell header **on the
home (leads) screen only** — tapping them opens the reset times and the reading's age
underneath; the lead screen draws its own header with no room budgeted for a number that
reads the same everywhere, so a phone that wants it is one tap back.

**Two gaps, both accepted rather than chased.** Right after a five-hour window's own reset
passes, the old reading disappears — correctly, the same instant client-side as it would
server-side — and the bar stays empty until the next status-line render actually carries a
fresh one, which can be up to a minute away if every session on the machine is idle. And
right after a panel restart the persisted record comes back immediately, so an ordinary
restart never blanks a live gauge — but the store only flushes to disk every two seconds,
so a hard kill inside that window can lose the very latest reading, and a genuinely fresh
install with no file yet shows nothing until the first payload arrives.

**There is deliberately no notification for a gauge crossing into red.**
[Notifications](#notifications) covers a session waiting on you — a prompt, a question, a
plan, the trust gate — and stops there on purpose. A rate limit is an account-wide fact,
not a session blocked on a human, and nothing here would tell you which session to go
answer anyway. If red is worth chasing, that's what the bar is for.

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
it.](images/rail-inbox.png)

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
(see [The team](team.md#the-team)). Then it hands off to the real macOS folder chooser, whose own
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

### Notices

Not everything in a transcript was said by somebody. When a subagent, a background command
or a monitor finishes, Claude Code hands the result back to the session as a **synthetic
user turn** — a `<task-notification>` envelope wrapping the whole report — and the terminal
shows only a single line for it. The panel drew it as a user bubble, so a subagent's report
could run two screens tall in the middle of a conversation, in your voice, saying something
you never typed.

It is a chip now: `notice · Agent "…" finished`, opening onto the report rendered as
markdown. The summary line is Claude Code's own and says which kind of thing finished, so
the chip's label only says what kind of *line* this is. Roughly two in three carry no
report at all — a status and a pointer to an output file — and those chips simply don't
open. What makes this safe is that the panel decides on the record's own fields rather than
on the text: a message of yours that quotes one of these envelopes is still a message of
yours.

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

### Images and text files

Paste or drop an image — or a `.txt` or `.md` file — onto the composer. The panel saves it
to `~/.foreman/images/` and drops the **path** into your message — which is exactly
what happens when you drop a file onto the terminal today: the path arrives as text,
Claude Code calls `Read`, and the tool result carries the image or the file's text.

The composer shows a chip — a thumbnail for an image, a document glyph and the size for a
text file, then your original filename and an `x` to remove — rather than a long path, so
the box keeps holding your words. The path is substituted in at send time, ahead of your
text, the way a dropped file leads in the terminal. Pending attachments are per session and
survive switching away and reloading; a failed send puts them back.

Pasting *text* is untouched: a paste carries no file, so it lands in the textarea as it
always has. Only a real dropped or pasted file is uploaded.

The copy is unavoidable, not a preference: a browser hands JavaScript the *bytes* and
the *filename* of a dropped file, never its location. Measured on this machine — a
Finder drag into Chrome offers only the `Files` flavour, with no `text/uri-list`, no
`file://` URL, and `File.path === null`. Terminal.app can type your real path because
it is a native app; a web page cannot see it. Your original filename is preserved in
the saved copy, behind a timestamp prefix, and so is its extension — `Read` needs it.
Filenames are reduced to a safe basename, and anything older than a week is pruned on
startup.

**What gets in.** Images are validated by magic bytes (PNG/JPEG/GIF/WebP, never the
client's content-type), 25MB cap. Text is validated by extension — `.txt` or `.md` — plus
a strict UTF-8 read and a refusal of any NUL byte, capped at **1MB**, because a text file
is read straight into a context window and a giant one spends it. Where the two disagree,
the **bytes win**: a real PNG named `notes.txt` is saved as a `.png`. Anything else is
refused with a message saying what is accepted.

> Text files land in the *same* folder as images on purpose. Sessions in **manual**
> permission mode will ask before reading from that folder, since it sits outside the
> project. The panel's permission card handles it — option 2 is usually "allow reading
> from images/ for this session". A second folder would mean a second prompt for the same
> gesture. Sessions in auto mode don't ask.

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
showing queue.](images/permission-card.png)

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

**On a short pane the dialog is not five rows.** Below about 25 lines Claude Code draws it
as a three-row scrolling window instead — `↑`/`↓` markers where the highlight goes and a
`… +2 models` row counting what is off screen. That is not an exotic size: the pane header's
*attach a Terminal* button opens a default macOS Terminal window, which is 80×23, so the
picker collapses the moment you attach one. It is **height, not width** — the same box at
220 columns and 23 rows collapses identically, and at 220×50 it does not.

The menu still offers every model. Opening it walks the highlight round the list with arrow
keys, reading the pane after each press, and puts it back where it found it — arrows are the
two keys in that dialog that cannot commit anything, and the list wraps, so one direction
reaches every row. Picking a row that is off screen steps toward it the same way.

And the panel can always close the box, even one it cannot read. Whether it may *drive* the
picker and whether there is a picker to get **out of** are different questions: the second is
answered by the heading and the footer alone, so a layout the parser has never met is
Escaped rather than abandoned. It used to be abandoned, and the session then sat behind its
own picker with the composer refusing to send until somebody pressed Esc in the terminal.

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

A third thing this deliberately does not cover: the [rate-limit gauges](#rate-limit-gauges).
A subscription running low is an account fact, not a session waiting on you, and nothing here
raises a notification for it, on purpose — read the bar.

**It only works where the browser will allow it, which means on this Mac.** Notifications need
a secure context: `http://127.0.0.1` counts as one, a LAN address over plain `http://` does
not. Opened from the phone or another machine the control is disabled with the reason printed
under it rather than silently doing nothing. That follows from the exposure decision in
[SECURITY.md](../SECURITY.md) rather than being a gap in it, and the phone's half of this is the
Home Screen icon.

The preference is remembered in the browser that answered — it is not a panel setting, it
applies the moment you tick it, and `save` does not touch it. Every browser and every device
answers for itself. There is a `test` button beside it, because "did I actually grant this?"
deserves an answer that is not "wait for a session to block".
