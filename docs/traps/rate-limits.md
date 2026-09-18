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
across windows, the **higher** percentage wins within one window (usage only climbs until
a reset mints a new one), and a window the incoming payload simply doesn't mention is left
alone — the only thing that ever removes a window is its own `resetsAt` actually passing.
Wholesale latest-wins is the trap; per-field, per-window is the only shape that survives an
idle sender.

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
windows and nothing else: no cost, no session id, no model. Ruling of 2026-09-04, and it is
enforced by what the store's `ingest` reads out of the body, not by a filter on the route —
the endpoint hands the whole payload through unfiltered on purpose, for issue #52.
