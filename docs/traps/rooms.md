# Rooms

The evidence behind the **Rooms** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps index —
the room panel's scroll and repaint rules, what a line's colour is keyed on, the five-line
clamp, how a member is resolved, and what `@name` does and does not change. Each section
below is one trap, opening with the bold sentence its index line quotes.

## The room's box moves under its own scroll

**The room's box moves under its own scroll, and nothing says so.** `renderRoom` pinned
to the bottom on every paint, which was both too much and not enough. Too much: a full
repaint fires on every incoming post, so a worker's report — now a bubble you can spend a
minute reading — yanked you to the newest line mid-read. Not enough: the tasks list and
the settings block above it arrive over HTTP a beat after the aside mounts, and each one
*shrinks* the room, so a scrollTop set while the box was 947px tall is 454px short of the
bottom once it is 493 — silently, with no scroll event, on every single open since the
aside existed. Following is now an intention flipped only by a real scroll, and the two
things that resize that box call `pinRoom` when they repaint. A `ResizeObserver` is the
general answer and was tried; it never fired, and neither did `requestAnimationFrame`,
because **an automated Chrome window reports `visibilityState: 'hidden'`** and Chrome
suspends both there. Worth knowing before you spend an hour blaming your own code:
`document.visibilityState` is the first thing to check when a callback that should be
free never arrives on a bench.

**…and a room that doesn't yank you needs to say what you're missing.** The other half of
the same rule: leaving the scroll alone means arrivals land off-screen with nothing to mark
them. A muted `N new below ↓` pill hangs off the room's bottom edge (absolutely positioned
against `.room-panel`, so it never reflows the list under the reader), exists only while
`follow` is false, and clicking it rejoins. The condition on it was "keep it quiet" —
muted ink, no accent, no motion. The counter is floored at zero on purpose: a full `room`
frame can *shrink* the list, and a negative count would hide a hint that was due.

## A room line's colour

**A room line's colour is keyed on what the poster said it is, never on how it reads.**
A dispatch line was asked for in green, the way a conflict is amber — and there was nothing
on the entry to tell one system line from another. `about` looks like the key
and is not: it is the *task id*, carried by every task-scoped system line, so a dispatch and
the `→ working` transition a minute later are identical by it. Every `kind: 'system'` post
in the repo (gc.js, watch.js's `postSystem`, and index.js's dispatch, model, PR and close
lines) carries exactly `{from, to, kind, about, text}` plus `alert`. So the dispatch post
gained `event: 'dispatch'` — riding the same `...rest` that `conflict`, `report` and `alert`
already use, `room.js` untouched — and `roomEntryNode` matches it exactly, so adding `event:
'pr'` later colours nothing by accident. **Do not match the sentence.** The text is a
message to a human and will be reworded; the day it is, a string-matched colour turns off
silently and the room looks fine. Two consequences worth knowing: this half is a `server/`
change, so it needs a panel restart, and `room.jsonl` is append-only history — lines already
written carry no `event` and stay grey, so the colour starts at the next dispatch rather
than filling in behind itself.

## A repaint that measures anything

**A repaint that measures anything stops holding the reader's place.** The room got the
scroll rules above without ever preserving `scrollTop` across a paint, and it didn't need
to: `replaceChildren` followed by a run of appends never forces a layout, so the old offset
survived the swap untouched. Then the five-line clamp added a measurement — every candidate
is marked clamped, appended, and only *then* read — and that read is a layout, after which
every height settled above the reader slides the list under them. Measured at **66px per
incoming line**, which is exactly the four `view more` buttons that sat above the fold
during the measured layout and were taken away after it; with no scroll event to notice it
by, this box's signature failure. Two halves to the fix and both are load-bearing: nothing
is drawn until it is known to be needed (the button is built in the write pass, for the
three entries in twenty that overflow, instead of built for all twenty and removed from
seventeen), and `renderRoom` holds `scrollTop` across the whole paint. Note **where** that
read has to happen — `list.scrollTop` *after* `replaceChildren` is a forced layout on an
emptied box, which clamps the answer to 0 before you have read it, and the first draft put
the reader at the top of the room on every arriving line. Read it before the swap.

## A clamp that can't be measured

**A clamp that can't be measured can't be trusted.** `-webkit-line-clamp` is what the room
uses, and the standard `line-clamp` is deliberately *not* set beside it: Chrome 151 answers
`CSS.supports('line-clamp','5')` with false, so it is inert today — and the shape it will
ship is `continue: discard`, which removes the clamped lines from the box rather than
hiding them. The overflow test is `scrollHeight > clientHeight`; discard the lines and
those two are equal, every entry reads as fitting, and the control silently stops
appearing on exactly the entries that need it. Add the property the day it can be measured,
not the day it parses.

## A list painted at build time

**A list painted at build time paints nothing, and a quiet feature hides it.** Everything
in `web/app.js` that renders through an `isConnected` guard — `renderRoom`, `renderTasks`
— must be called *after* its container is in the document, not inside the builder that
creates it. `renderMain` mounts the lead's aside and then paints. Get it backwards and
the guard silently skips, and the next repaint only arrives with the next incoming
message: a busy room self-heals in seconds and looks perfect, while a quiet one stays
blank for hours. That is exactly how it shipped and how it was caught — seven entries in
`room.jsonl`, none on screen. The general lesson is about benches, not guards: a feature
proven against a *busy* fixture is not proven against a quiet one.

## A room member is resolved `tmuxSession` first

**A room member is resolved `tmuxSession` first, and the recorded decision said the
opposite.** The ruling said "by pane + name", and pane id is the *weakest* of the three ids
here: a session id rotates on `/clear` (so the store keeps none), a **pane id survives
`/clear` and not a relaunch** — relaunch-all can take the tmux server down and pane ids then
restart at `%0`, which `queue.js` already prunes on `paneCreatedMs` for — and a tmux session
name survives all of it, being minted before the pane exists and put back under the same
name by relaunch-all. So a stored `%12` can be **live and belong to somebody else**, which
is a post typed into a stranger.

`resolveMember` (`server/rooms-line.js`) is therefore `tmuxSession` → `paneId` **and** `name`
together → nothing, and two edges are pinned by name. One tmux session can hold more than one
Claude pane (a user split), and then `tmuxSession` names two rows — settled only by an exact
`paneId`, because `label` is *derived from the tmux session name* and both rows carry the
same label, title and project by construction, so no name witness can ever break that tie; a
set it cannot settle falls through and resolves to nothing. And the fallback needs **both**
witnesses, never one, because a session relaunched under a name a different session has since
taken is exactly what one witness would match. `participant()` is applied **after** the
resolution and never as a filter in front of it: filtering first would let a member whose row
has become a worker fall through and match some *other* row. `web/rooms-pane.js`'s `memberRow`
mirrors the same order for its status dot and cannot import the real one (that pulls in
`server/observe.js`), so `test/rooms-pane.test.js` drives both against one set of fixtures and
asserts they agree — held together by a test rather than by a comment.

## `handed` is not `delivered`

**`handed` is not `delivered`, and the window between checking and writing it down had to be
closed by hand.** `sendOrQueue` types or queues; a queued copy waits for a pane to go idle,
which may be hours and may be never, and `queue.prune` silently drops everything for a pane
that has gone away or come back with a different birthday. Nothing writes back to an
append-only log, so **an entry that says `queued` says it forever** — that is the state, not a
bug, and the retired `/api/shared-room/message` made the call first, in a comment that went
with it. Every surface says
`handed`: the log entry's key, the room pane's line under a bubble, the tool description, and
`test/rooms-pane.test.js` greps for the word. Making a dropped copy visible (a `dropped` event
out of `queue.prune`, a `system` line in the room) was costed and deliberately left unbuilt,
so that it stays a decision rather than a side effect.

The machinery beside it is the part the plan did not ask for. The refusals must gate the
typing — `rateFault` is public for exactly that — but the handoff marks ride on the entry, so
the order is forced: **check → fan out → append**. That leaves a window where two posts to one
room both pass `rateFault`, both type into every pane, and the second is then refused by
`post()` with the copies already delivered and nothing written down. For a single poster the
limiter only ever gets more forgiving as time passes, so the window needs a *second* poster —
which is precisely what a room is for. `roomTurn` in `server/index.js` is a promise chain per
room, the way `PaneLock` serialises per pane.

## `to` means two different things one pane apart

**`to` means two different things one pane apart, and both are built by near-identical
functions in one file.** A group-room entry carries `to` as an **array of member names** — who
an `@name` post addressed — while a shared-room entry carries `to` as an **object**,
`{name, cwd}`, naming the one session a native message went to. `groupEntryNode` and
`sharedEntryNode` are three hundred lines apart in `web/app.js` and read the same: a `.*-meta`
row, a name pill, an optional tag, a timestamp appended, then `wrap.append(meta)`. So the
obvious anchor for "put the new span after the timestamp" matches the **wrong one first**, and
it did — the mentions label was built into the shared room, where `e.to` is an object, and
drew nothing while looking entirely correct in the diff. What made it harmless rather than a
wrong label is `addressedNames`' `Array.isArray` guard, which is therefore load-bearing and
not defensive noise: it is the only thing standing between these two fields. When adding
anything to either node, anchor on that node's **own** class prefix (`group-time`,
`shared-time`) rather than on the shape they share, and read back which one you edited.

## `@name` in a room is a signal

**`@name` in a room is a signal, and the ruling that makes it one is easy to optimise away.**
Every member still receives a copy of every post; a mention changes only *what each recipient
is told* — the addressee is told to answer in the room, everybody else is told it is theirs to
know rather than to answer. Typing only into the named sessions was asked for and **refused**:
the room is the shared record, and a question two members cannot see is a side conversation
nobody can catch up on. So the fan-out in `POST /api/rooms/:id/post` has no branch on `to` at
all, and the composer's `@` menu is not the retired peer-message picker in disguise — that one
*chose a destination* and lifted the token back out of the text, this one types a name **into**
the body and the send still carries `{text}` and nothing else. Two details behind it: the parse
matches the **stored** member label (`memberLabel`), never the live row's name, because the
endpoint's per-copy "is this recipient an addressee" test asks the same function and two
spellings would address a post to a member no copy is ever told about; and it is
**longest-name-first**, or a room holding both `alpha` and `alpha-main` reads `@alpha-main` as
`@alpha`. A name nobody in the room answers to is plain text, never an error.
