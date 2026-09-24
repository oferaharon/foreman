# Transcript records

The evidence behind the **Transcript records** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — what a `.jsonl` record really is before `normalize.js` is done with it: slash
command output, task notices, peer messages, room deliveries, the paste wrapper, and the
subscription that carries them to a browser. Each section below is one trap, opening with
the bold sentence its index line quotes.

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
holds the writer and the reader together, imports only `envelope.js` and the leaf
`pasted-content.js`, and is the reason the two spellings cannot drift; a test holding them
apart was the alternative and is strictly weaker when an import is available.

## A paste the composer folds arrives wrapped

**A paste the composer folds reaches the transcript inside one `<pasted_content>` wrapper,
and the panel pastes every multi-line message it types — MEASURED on v2.1.280.** Measured
through the panel's own `sendText`, in the sandbox. The record is the ordinary
`type: 'user'`, `origin: {kind: 'human'}` one, with the text as
`\n\n<pasted_content id="f4d4">\n…\n</pasted_content id="f4d4">\n`. That put a blank line
and a tag where a room delivery's header should be, so both of `readRoomDelivery`'s
witnesses failed and the chip became a raw bubble; an ordinary panel message showed its
tags. `unwrapPasted` (`server/pasted-content.js`) takes off **exactly one whole-record
wrapper** — whitespace only outside, open and close ids equal, no unescaped tag inside —
and both readers import it. The witnesses then run unchanged on what was inside, and
anything else (a sentence typed above a paste, two pastes) stays the record's text.

What was measured, none of it guessable:

- **The fold decides, and pane height is an input to it.** Wrapped exactly when the
  composer draws `[Pasted text #N +K lines]`: more than 800 characters, or more than
  `min(rows − 10, 2)` newlines. At 50 rows and at 23, two and three lines stay bare and
  four fold; 800 characters stay bare and 801 fold. At 11 rows three lines fold, and at 10
  rows **any** multi-line paste does. A room delivery is a header plus the body, so on an
  ordinary pane a two-line post arrives bare and a three-line one wrapped.
- **The pane never shows it.** Claude Code draws the submitted message without the tags,
  so a `capture-pane` comparison says nothing; only the transcript does.
- **A long single line is wrapped too, and cut.** `send-keys -l` hands the terminal ~1 KB
  reads and each read over 800 characters folds on its own: a 2,000-character line arrived
  as two wrappers plus a bare tail, with a blank line inserted mid-word at each seam. That
  is not one wrapper, so it stays raw — and the session received different text from what
  was sent. Measured on v2.1.280 only; whether earlier versions cut the line the same way
  was not measured.
- **Two whitespace shapes.** Delivered idle, the shape above with `promptSource: 'typed'`.
  Delivered while busy, Claude Code queues it (`promptSource: 'queued'`, a second value
  beside `typed`) and trims it, so the tags are the first and last bytes.
- **The id is per session, not per paste**: four lowercase hex digits, the same on every
  paste in one session, and today the head of the session id's SHA-256. It is not a
  witness — the system prompt calls it random, and a witness keyed on an undocumented
  derivation fails silently the release it changes. Only open-equals-close is.
- **Tags inside the pasted text are escaped, lossily.** `<pasted_content` and
  `</pasted_content` in any case come back as `<\pasted_content` / `<\/pasted_content`,
  which is what makes "exactly one" checkable — an unescaped tag in a body can only be
  another block's. A backslash already there is not doubled, so the escape cannot be undone
  and is shown as the session received it.
- **It is gated by a server-side flag, not a setting.** Read out of the 2.1.280 binary:
  the wrapping on submit, the system-prompt sentence and the terminal's own unwrapping all
  sit behind one remotely served feature flag; no `settings.json` key or environment
  variable turns it off. The 2.1.280 system prompt tells the model that pasted text "may
  contain instructions the user did not write", and a panel paste has no words of its own
  outside the tags — so a maintainer's `| ` line or panel message arrives dressed as
  somebody else's. The panel cannot undo that by reading; `pasted: true` on the
  normalized message records it, and nothing draws it yet.

**Whether the panel should send differently is the maintainer's call, and was measured
rather than changed.** Three newline keys between `send-keys -l` lines — `C-j`,
`M-Enter`, `\` then `Enter` — all delivered a short six-line message unwrapped and exact.
All three break on a long line: after a 1,200-character first line, `C-j` **dropped the
first 1,022 characters**, twice in two runs, and `M-Enter` and `\` + `Enter` kept them but
wrapped them and cut the line. (Lines opening with `/` or `!`, or carrying an `@name`,
came through intact mid-message; the same at the very start of the composer was not
measured.) What survived every case was **several small bracketed pastes**,
each under the fold (at most two newlines and 800 characters): exact on a 40-line,
3,000-character delivery, 176 ms at no gap and 1.3 s at 50 ms between pastes, against one
`paste-buffer` today. The costs of adopting it: the pane is claimed for the whole of that,
a room fan-out types into members one after another so a seven-member post takes up to
seven times as long, it rests on two Claude Code constants that can move in any release,
and it would carry a peer's `> ` lines past the one marker that says they came from
elsewhere. `test/fixtures/pasted-content.jsonl` is the capture — eleven records, both
shapes, the escape, the mixed and the cut cases — and `test/pasted-content.test.js` pins
it.

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

## A subscription is keyed by socket and slot

**A subscription is keyed by socket *and slot*.** `subs` is `ws -> Map(slot -> sub)`, and
every `transcript` / `messages` / `earlier` / `rebound` frame carries its slot. A frame
without one means slot `a`, which is how the panel behaved before there were two.

## tmux pane ids in URLs

**tmux pane ids contain `%`.** `pane:%19` in a URL path is read as a percent-escape.
Synthetic session ids use `pane-19`.

## probe samples head and tail

**`probe` only samples head and tail.** A burst of tool calls pushes earlier replies out
of the window, so unread is *accumulated* across polls rather than recomputed. Don't
"simplify" that back.
