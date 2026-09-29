# Rate limits and the status line

The evidence behind the **Rate limits and the status line** block of
[`CLAUDE.md`](../../CLAUDE.md)'s Traps index — what the status line does on a quiet bench,
what an idle sender re-posts, what the payload's own fields mean, and what is deliberately
never kept out of it. Each section below is one trap, opening with the bold sentence its
index line quotes.

## The status line is event-driven

**The status line is event-driven, and the wrapper's whole reason to touch
`refreshInterval` is that this makes the gauges go stale for hours on a quiet bench.**
Measured: 2 renders in 5m43s, zero across 90 seconds of idle. `npm run install-statusline`
sets `statusLine.refreshInterval` to 60 **only when the key is absent** — a value already
there is somebody's own decision and is never overwritten, and `uninstall-statusline`
restores the whole `statusLine` object from the sidecar exactly as it was found, which
puts the key back either way. 60 rather than something snappier because the thing being
re-run every tick is the *user's own script*, whatever it is; once a minute per session is
negligible, once every few seconds plainly isn't.

**…and that same interval is what broke a naive "latest payload wins" merge, live, on one
account.** Once `refreshInterval` is set, a session idle for hours re-posts its
*last-known* payload every minute — stale percentages, and no `five_hour` key at all once
that window's own reset had passed, because Claude Code had already dropped it from the
payload that sleeping session was holding. Replacing the whole stored record with whatever
arrived last let one idle re-post blank a live five-hour bar every sixty seconds. The
weekly window took longer to notice because it is long enough that a sleeping session's
copy still matches its `resetsAt` exactly — only the percentage tells the two readings
apart — and it flapped 9% → 5% → 9% on the same idle re-post the five-hour fix had already
solved for. `server/rate-limits.js` now merges **per window**: the later `resetsAt` wins
across windows, only a *witnessed* reading moves the bar within one window (next section —
it used to be "the higher percentage wins", and that was wrong), and a window the incoming
payload simply doesn't mention is left alone — the only thing that ever removes a window is
its own `resetsAt` actually passing. Wholesale latest-wins is the trap; per-field,
per-window is the only shape that survives an idle sender.

## A manual usage reset lowers a window without a new resetsAt

**"Usage only climbs inside a window" is false: Anthropic's manual usage reset zeroes a
window and keeps its `resetsAt`, and "the higher percentage wins" then held the weekly bar
at a pre-reset 95% for the rest of the week.** The five-hour bar corrected itself — that
reset minted a new window, which the reset comparison accepts unconditionally — while the
weekly window kept `resets_at` 1790899200 and every fresh low reading was read as a
sleeper's copy. The fix could not simply let the incoming win, because that is the 9% → 5%
→ 9% flap again, and after a manual reset the flap runs the *other* way too: every session
that has not spoken since holds a copy that is higher than the truth.

So within one window the witness is the sender's own history. MEASURED on v2.1.280 in the
sandbox's `alpha`, with a 5-second `refreshInterval`: every render repeats `rate_limits`
byte for byte — before, across and after a turn — because Claude Code builds it from one
process-wide reading that each API response's `anthropic-ratelimit-unified-*` headers
replace wholesale (`applyWindowReadings` in the binary). A session whose own reading
*moved* since its last post is therefore carrying a new response, and an idle re-post
cannot forge that. Four kinds of post, in `#witness`: `fresh` wins in either direction;
`repeat` and `first` move nothing in either direction; a post with no `session_id` keeps
the old higher-wins rule, having no witness to read.

Three measured details decide the edges, and each is pinned by a test:

- **`/clear` posts a sleeper's copy under a brand-new `session_id`** — captured: the old id
  and the new one posting identical windows in the same second, since the process's reading
  outlives the session. That is why a first sighting is a baseline and never a witness.
- **The percentages are integers, and a turn need not move them** — a turn in the capture
  moved `total_api_duration_ms` and left both windows alone. One window moving vouches for
  the whole post, because one response carries every window; without that, the weekly bar
  could wait hours for its own integer to tick.
- **A window disappearing is not movement.** Claude Code drops a window from the payload
  once its `resets_at` passes on *its* clock, with no response at all; only windows present
  in both posts are compared.

The memory is id → last readings, **in memory only**, bounded by count. A restart forgets
every baseline and costs one post per session, which is the safe direction — nobody's first
post moves a bar — and the file stays `{windows, at}`, so a rollback reads it unchanged.
The honest limit: two sessions answered a moment apart can post out of order and leave the
bar a point low until either posts again. It cannot flap, and refusing a fresh drop to rule
it out is exactly the rule that stranded the 95%.

## Unix seconds, not milliseconds

**`resets_at` is Unix seconds, not milliseconds, and `used_percentage` isn't the payload's
only name for itself.** `new Date(1788571200)` is January 1970 — a wrong answer that
renders without complaint rather than throwing — so every reader multiplies by 1000 before
comparing against `Date.now()`. And every window is read as `used_percentage ?? utilization`:
the capture used the first, but the binary's own string table sits `utilization` right next
to `five_hour`, which makes the fallback cheap insurance against a rename rather than dead
code.

## The dollar figure is never kept

**The payload carries a dollar figure, and none of it is ever kept.** `cost.total_cost_usd`
rides in the same JSON as `rate_limits` — measured `0.3027715` on one real turn — and it is
meaningless against a subscription, so `server/rate-limits.js` extracts only the two
windows and nothing else: no cost, no model. Ruling of 2026-09-04, and it is enforced by
what the store's `ingest` reads out of the body, not by a filter on the route — the
endpoint hands the whole payload through unfiltered on purpose, for issue #52. The one
other field read is `session_id`, as the key to that session's own last window readings
(the witness above), held in memory only: it never reaches the file or the record the
roster carries, and `test/rate-limits.test.js` reads the file back to say so.
