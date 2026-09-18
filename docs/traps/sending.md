# Sending and claiming

The evidence behind the **Sending and claiming** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — nothing types into a pane without claiming it first, what an interrupt
leaves behind, and the two windows in which the pane's own answer and the roster's
disagree. Each section below is one trap, opening with the bold sentence its index line
quotes.

## Claiming the pane

**Nothing may be typed without claiming the pane first.** The roster is a poll behind, so
five messages fired in one second all saw `idle` and all landed on the same prompt line.
The lock lives in `claim.js` — `PaneLock` takes it *before* re-reading the pane and holds it
for a beat after delivery. Both the send endpoint and the queue flusher go through it;
neither types directly.

## An interrupt fires no hook

**An interrupt fires no hook, and the receipt it leaves behind lasts ten minutes —
VERIFIED.** `Escape` is not a natural stop, so Claude Code's `Stop` hook never runs and the
status engine's last word on that session stays `working` for the whole `STATUS_STALE_MS`.
Nothing else was ever going to correct it: the hook is the only thing that writes `states`,
and the one that would have has already declined to fire. Measured on a scratch panel with
the fix disabled — ninety seconds after an interrupt the roster still said `working`, the
composer button still read `queue`, and a message sent into a session plainly sitting at its
composer went to the queue instead of the pane. It was hit live, and the tell is that the
tmux window was the faster route.

So the **interrupt endpoint** drops that session's receipt (`StatusEngine#interrupted`),
because the panel is the only party that knows. Three things about it. It **drops** rather
than writing `idle` — `stateOf` answers `unknown` for a session it has never heard of, and
`unknown` is the one word `sessions.js`'s precedence hands straight back to the pane
scrape; writing `idle` would assert an outcome nobody observed, and the Escape may have
landed on a box. The precedence at `sessions.js:398` is **not** the bug and must not be
inverted — the hook still beats the scrape for everything that is not a prompt, plan or
dialog, for the three separate reasons above. And the **join is the part that silently does
nothing**: `states` is keyed by the hook's `session_id` while the caller holds a pane id and
the registry's id, which agree except for the beat after a `/clear`, so both spellings are
cleared. With it, the button flips in **0.77s** — the next roster refresh, which the
`changed` event triggers.

**…and the pane does not stop being `working` when the endpoint answers — 57–76ms, and it
is the whole reason `worker_interrupt` has a beat in it.** Escape is delivered before
`POST /key` returns, but the TUI has not redrawn, so `parsePane` goes on saying `working`
while the composer is drawn. Measured on a scratch panel against a working session in the
sandbox's `alpha`, polled through the real `parsePane`: **57–76ms** from the endpoint's
answer to the first `idle` read, nine runs, at 220 columns and again at **70** — width made
no difference here, which is worth knowing because it is the one parser input that usually
does. So a follow-up message fired the instant the interrupt returns is read by
`PaneLock#claim` as landing on a busy pane and **queues** — benched, every time, with the
queue flusher then delivering it at the next roster tick and the worker answering it
normally. Safe, and still wrong to ship: `queued` is the lead's only signal for "typed or
waiting", and a flag that says *waiting* in the ordinary case has stopped saying anything.
`SETTLE_MS` in `mcp/foreman.js` is that window with room over it, and it is a best effort
rather than a guarantee — a slower redraw queues, which is the same safe path. Note it is
**not** the ~1.8s spinner window one paragraph down: that one is `idle` read while working,
this one is `working` read while idle, and they are opposite errors on the same scrape.
Roster-side, the same runs put the flip off `working` at **482ms–1.6s** — the receipt drop
plus the next refresh, which is the 0.77s above measured a second way.

**…and the live pane read now decides a claim, which is looser in exactly one measured
window.** `PaneLock#claim` asks the lock, then reads the pane, and the pane's answer is
final. The version before it asked the *roster* first (`session.status !== 'idle'`) and only
then read the pane, so the live read could veto a send and never rescue one — which defeats
the reason it is there. What that ordering was quietly covering, and now isn't: **the first
spinner frame of a turn does not match `WORKING_RE`.** Claude Code draws `✢ Burrowing…`
with no parenthesised suffix, and the pattern is `/⎿\s+Running…|\S+…\s*\(/` — it wants the
`(`. Sampled at 120ms against a real session: **~1.8 seconds** at the top of every turn
where `parsePane` says `idle` and the session is working. Once the `(3s · ↓ 12 tokens)` tail
appears it is `working` for the rest of the run — 280 of 280 samples through a two-minute
tool call. So a message flushed inside that window is typed into a session that has just
started; Claude Code absorbs it as a follow-up rather than losing it, and `COOLOFF_MS`
(1500ms) covers most of the window when the panel is what submitted the prompt. It is not
covered when a human typed in the terminal. Widening `WORKING_RE` is the real fix and was
left alone deliberately — it changes the roster status of every session in the panel and
wants its own fixture. Weigh that 1.8s against the ten minutes it bought.
