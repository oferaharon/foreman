# Transcript records

The evidence behind the **Transcript records** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — what a `.jsonl` record really is before `normalize.js` is done with it: slash
command output, task notices, peer messages, room deliveries, and the subscription that
carries them to a browser. Each section below is one trap, opening with the bold sentence
its index line quotes.

## A slash command's output is a transcript record

**A slash command's output is a transcript record, it carries ANSI, and it comes in two
shapes.** `/model` writes `<local-command-stdout>Set model to \x1b[1mFable 5\x1b[22m for this
session only</local-command-stdout>` — bold codes and all, invisible in a terminal and raw
bytes in a browser. `parseCommandOutput` in `normalize.js` strips them, and its regex is
written as an explicit `\u001b` rather than the literal ESC byte it started as: an invisible
control character in source lasts until the next careless edit, after which the pattern
quietly starts eating ordinary text shaped like `[1m`. The match is anchored `^…$` for a
reason that is already live — a message *mentioning* the tag (this trap's own bug report did)
must stay the user's words. Two shapes: 112 `user` records, which is what you see, and 222
`system`/`local_command` records, which `DROP_TYPES` discards and always has; 190 of those
are empty. Only the first was ever visible, so only the first was changed. And note
`<command-name>` already carries the slash — the chip adds its own, which is why every
command in the panel read `//model` until it was stripped in `parseCommand`.

## A `type: 'user'` record is not proof a human typed anything

**A `type: 'user'` record is not proof a human typed anything.** When a subagent, a
background command or a monitor finishes, Claude Code injects the result back as a
**synthetic user turn** — a whole `<task-notification>` envelope — and the terminal draws
one line for it. `normalize.js` drops only by `DROP_TYPES` and `isMeta`, so the panel drew
every one as a full user bubble: a subagent's entire report, in the user's own voice,
saying something they never typed, two screens tall. Measured across this Mac: 472 of them,
median 425 bytes, p90 8.5 KB, largest 48 KB. `parseTaskNotice` reads them as a `notice`
chip.

Three measurements decided its shape and none of them is guessable. **`<summary>` is on all
472 and is self-describing**, so it *is* the chip's line — and it is why the label says
`notice` rather than the obvious `agent finished`: only 92 are agents, 263 are background
commands and 94 are monitors, so that wording would be wrong on four rows in five.
**`<result>` is on only 92 and `<event>` on 94**; the other ~290 are a status and a pointer
to an output file, and their chip is deliberately unopenable rather than opening on nothing.
And **detection is two witnesses that must both hold** — a record field (`origin.kind`, or
`promptSource` for a record carrying no `origin`) *and* an anchored `^<task-notification>`
envelope — never the sentence inside, which is Claude Code's wording and will be reworded.
The conjunction is also the scope: a typed message quoting an envelope stays a bubble, and
whatever else `promptSource: 'system'`
grows to carry falls through unchanged, which is the right default for a shape nobody has
read. Unread never counted these — it counts `assistant` records with text — so nothing
about the inbox moved.

## One peer message, two records

**One peer message, two records, and which one Claude Code writes depends on whether the
recipient was busy — MEASURED on v2.1.257, both shapes captured minutes apart in one
sandbox session.** A native `SendMessage` delivered to an **idle** session lands as
`type: 'user'` with `origin.kind: 'peer'` at the top level. Delivered to one **mid tool
call** it is queued and then absorbed into the turn already running, and lands as
`type: 'attachment'` / `attachment.type: 'queued_command'` — the `queue-operation` beside
it says `reason: 'absorbed_mid_turn'` — carrying the **identical `origin` object one level
deeper**, at `rec.attachment.origin`. It has no top-level `message`, no top-level `origin`
and no top-level `isMeta` (that rides inside `attachment` too), so every test the first
shape passes, the second fails. `peerOrigin` in `normalize.js` is the one place either is
recognised; everything downstream is written once.

Three things about it. **The busy shape is the common case, not an edge** — a worker
telling its lead "done" is by definition talking to a session that is working, and it is a
worker→lead completion message that first proved this traffic exists. **It fires no
`UserPromptSubmit` hook at all**, measured against a scratch hook that caught the idle
delivery from the same sender in the same session seconds earlier and never saw the busy
one, so a collector watching the hook sees nothing and the transcript is the only path to
these. And **`attachment` stays in `DROP_TYPES`**: the carve-out asks the parser rather
than the type (`if (DROP_TYPES.has(type) && !peer)`), so exactly one shape comes back out
and `total_tokens_reminder`, `output_style` and the rest are dropped on the next line as
before. Note the shape is not what you get by messaging a session that merely *looks*
occupied — a probe fired at one busy generating prose arrived as the ordinary `user`
record, because the turn ended first. It takes a tool call in flight.
`test/fixtures/peer-message-busy.jsonl` is the capture and `test/normalize.test.js` pins
both spellings against it.

## A room delivery leaves the same record a typed message leaves

**A room delivery leaves the same record a typed message leaves, so the only witnesses are
in the text — MEASURED on v2.1.257, on a real delivery in the sandbox.** Every other message
the panel types into a pane can be recognised off the record: a nudge carries a mark (and so
did a link message, before links were retired — `LINK_MARK` in `normalize.js` outlived the
feature so those records still read), a task notification carries `origin.kind`, a peer message
carries `origin.kind: 'peer'`. A room copy carries **`type: 'user'`, `origin: {kind: 'human'}`,
`promptSource: 'typed'`, `entrypoint: 'cli'`** — byte-for-byte what the maintainer typing at
the keyboard leaves behind, because that is exactly what it is: text typed into a composer.
So `readRoomDelivery` (`server/room-header.js`) is **two witnesses that both come out of the
text**, and one of them being the sentence is unavoidable here in a way it never was for the
notice: the first line must match the anchored header shape — a `room-<n>` id the store could
have minted, ending in one of two *frozen* note clauses — **and** every remaining line must
carry that speaker's prefix, with at least one line. Somebody quoting a delivery inside a
message of their own breaks the second (their words are a line at column 0) or the first (the
header is no longer first), and stays a bubble; `test/fixtures/room-delivery.jsonl` is a real
capture of exactly that pair, side by side, which is why it is a capture and not a
reconstruction. A verbatim paste of a whole delivery and nothing else does read as one, and
that is accepted rather than defended against — it is indistinguishable by construction.

**…and the module is a leaf because the obvious import is a cycle.** `normalize.js` has to
read what `rooms-line.js` writes, and `rooms-line.js` → `observe.js` → `normalize.js` closes
the loop. ESM would resolve it today — neither module touches the other's bindings at
evaluation time — and that is the "it'll be fine" this file is a list of. `room-header.js`
holds the writer and the reader together, imports only `envelope.js`, and is the reason the
two spellings cannot drift; a test holding them apart was the alternative and is strictly
weaker when an import is available.

## A subscription dies with the socket

**A subscription dies with the socket, and nothing on screen says so.** The tailer holding
a file offset is server state, so a dropped connection or a server restart ends it — while
the roster keeps arriving, because that is broadcast to every client. The result is a rail
that looks perfectly alive above a transcript that silently stopped minutes ago — found
because the terminal had twenty minutes the panel didn't. `ws.onopen` re-subscribes
**every open pane**; the version before split view re-subscribed `state.selected`, a variable
the `createPane` refactor had already deleted, so it re-subscribed nothing at all.

**…and a subscription that outlives its slot doubles every message.** `subscribe` used to
claim the slot *after* `await tailer.start()`, leaving the slot empty for the length of a
file read. A second subscribe landing in that window found nothing to stop, so the first
tailer was never recorded anywhere and never stopped: it went on watching the same file and
sending into the same slot for the life of the socket, and `appendMessages` in `web/app.js`
appends without dedupe. Every record after that point drew twice. It hides well — the next
full `transcript` frame replaces the list wholesale, so the screen "snaps into place" while
the orphan keeps running, and the file was never wrong. `/clear` is what makes the race
routine: a rotation fires **two** subscribes for one slot, the server's own rebound and the
client's `adopt` → `open` off the same roster frame. The slot is now claimed before the read
and the tailer checks it still owns it afterwards; the second subscribe is harmless, it just
supersedes. Proving it took a websocket that double-subscribes one slot and single-subscribes
another as a control, against a live session — the panel cannot show you this from inside.
