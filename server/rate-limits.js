import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';

const FILE = path.join(STATE_DIR, 'rate-limits.json');

/** Sessions whose last reading is remembered; far above how many are ever open at once. */
const MAX_SESSIONS = 256;
/** A `session_id` is a uuid; anything this long is not one and is not kept. */
const MAX_ID = 200;

/**
 * How much of the account's quota is gone, and when we last heard.
 *
 * A Claude subscription has two windows — a five-hour one that refills through the day and
 * a weekly one — and when either runs out every session on the machine stops. Claude Code
 * already knows both numbers: it hands them to the status-line command in the JSON it
 * feeds it on stdin, several times a session. The wrapper posts a copy of that JSON to
 * `POST /status`; this is where the copy lands.
 *
 * **The whole payload arrives and this module extracts.** The endpoint does not filter,
 * deliberately: issue #52 wants the per-session fields out of the same body, and drawing
 * the line here means it adds a second store rather than a second install step.
 *
 * Four rules the shape depends on, each measured rather than assumed:
 *
 * - **A payload is not evidence about the windows it does not mention.** A payload with no
 *   `rate_limits` key at all is ignored entirely — it is the launch render (measured:
 *   missing from the very first render of a session, present on every one after it), an
 *   API-key session, or a session before its first reply; one such session posting every
 *   few seconds must not wipe the gauges. And a payload *with* the key no longer replaces
 *   the stored windows wholesale either. See the merge rule below: that was the first
 *   reading of "Claude Code drops a window once its reset has passed", and it was wrong
 *   about *whose* clock the drop happened on.
 * - **The arrival is not the reading.** A status line re-renders on a timer
 *   (`statusLine.refreshInterval`, 60s here), so a session that has been idle for hours
 *   re-posts its **last-known** payload every minute: hours-old percentages, and no
 *   `five_hour` at all, because that window's reset passed long ago and Claude Code dropped
 *   it from the payload *that session was holding*. Latest-arrival-wins therefore let a
 *   sleeping session blank a live five-hour bar every minute, which is exactly what it did
 *   — the two readings alternated in `rate-limits.json` on one account. So the merge is
 *   **per window**: the later `resetsAt` wins, an incoming window with an older one is a
 *   stale re-post and is ignored, and a window the payload simply did not mention is left
 *   alone. The one and only thing that removes a window is its own `resetsAt` passing —
 *   real expiry, measured against this machine's clock rather than inferred from somebody
 *   else's memory of it. And **within one window only a witnessed reading moves the
 *   bar**, because a long window (the weekly one) is still current in a sleeping session's
 *   copy, so its reset matches and the reset cannot tell the two readings apart. The
 *   witness is the sending session's own reading changing since its last post — an idle
 *   re-post repeats itself byte for byte and cannot forge one. That replaced "the higher
 *   percentage wins", which assumed usage only climbs inside a window and was wrong: a
 *   manual usage reset lowers it without minting a new `resetsAt`. See `fresher` and
 *   `#witness`.
 * - **`used_percentage`, falling back to `utilization`.** The capture says
 *   `used_percentage`. The binary's string table puts `utilization` next to `five_hour`
 *   and every internal telemetry name is `priorFiveHourUtilization`, so one `??` is cheap
 *   insurance against a rename that the string table says is plausible.
 * - **`resets_at` is Unix *seconds*** and is stored as given, seconds and all. Multiply by
 *   1000 before `new Date` — `new Date(1788571200)` is January 1970 and renders a
 *   plausible-looking wrong answer rather than throwing.
 *
 * And one rule that is not about the data: **no USD, ever** (ruling of 2026-09-04). The
 * payload carries `cost.total_cost_usd`; this is a subscription and the number is
 * meaningless here, so it is never extracted, never stored and never sent. The one thing
 * besides the windows this module reads out of a payload is `session_id`, and only as the
 * key to that session's own last window readings, **in memory** — never in the file, never
 * in the record the roster carries. See `#witness` for why memory is enough.
 *
 * `ingest` answers whether anything a *reader* would see changed, so the caller can decide
 * whether to broadcast. A re-post of the same numbers answers false even though `at` has
 * moved: the age is computed in the browser from `at`, and a server that re-broadcast to
 * keep it fresh would rebuild the rail on every render of every status line. The record is
 * still rewritten and still persisted, so the age on disk is the truth if the panel
 * restarts. Note what that costs now the merge is per window: a stale re-post that changed
 * nothing still advances `at`, so "as of a minute ago" can be true of the arrival while the
 * numbers under it are older. That is the right trade — `at` is what tells a reader the
 * feed is alive at all, and the alternative is a store that looks dead every time the
 * machine is quiet — but it is why `changed` is computed from the windows and never from
 * `at`.
 *
 * On disk, in the shape of `pins.js` and `read-state.js`, so a panel restart doesn't blank
 * a gauge that was right a second ago — the feed is event-driven and can be quiet for
 * hours.
 */
export class RateLimitStore {
  #seen;

  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    /** @type {{windows: Record<string, {usedPercentage: number|null, resetsAt: number|null}>, at: number}|null} */
    this.record = null;
    this.dirty = false;
    /**
     * Each session's own last reading, keyed by `session_id`, oldest first — a `Map` keeps
     * insertion order, and `#witness` re-inserts on every post, so the first key is the one
     * to evict. Readings only (`windowsFrom` builds them), never the payload.
     * @type {Map<string, Record<string, {usedPercentage: number|null, resetsAt: number|null}>>}
     */
    this.#seen = new Map();
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isPlainObject(raw) || !Number.isFinite(raw.at)) return;
      // Re-coerced rather than trusted: this file is ours, but a hand-edit is a hand-edit
      // and a `NaN%` on the rail is worse than no rail.
      this.record = { windows: windowsFrom(raw.windows, storedWindow), at: raw.at };
    } catch {
      /* first run, or hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.record, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  /** The whole record, or null if nothing has ever arrived. Rides the roster frame. */
  get() {
    return this.record;
  }

  /**
   * Take a status-line payload.
   *
   * @param {any} payload the whole JSON body, unfiltered
   * @param {number} [now] server clock, in **milliseconds** — both the record's `at` and the
   *   expiry every window is measured against. Two sessions posting in the same second need
   *   no reconciling: it is one account-wide number and they agree, and where they disagree
   *   it is because one of them is asleep, which is what `mergeWindows` is for.
   * @returns {boolean} whether anything a reader would see changed
   */
  ingest(payload, now = Date.now()) {
    const raw = isPlainObject(payload) ? payload.rate_limits : null;
    if (!isPlainObject(raw)) return false; // a payload without the key says nothing — see the header

    const incoming = windowsFrom(raw, payloadWindow);
    const source = this.#witness(payload.session_id, incoming);
    const windows = mergeWindows(this.record?.windows, incoming, now, source);
    const changed = signature(windows) !== signature(this.record?.windows);
    this.record = { windows, at: now };
    this.dirty = true;
    return changed;
  }

  /**
   * What kind of evidence this post is, judged against the same session's previous post,
   * and then remembered as that session's latest.
   *
   * - `fresh` — a window this session reported last time reads differently now. That is a
   *   new API response and nothing else: Claude Code builds `rate_limits` from one
   *   process-wide reading that each response's `anthropic-ratelimit-unified-*` headers
   *   **replace wholesale** (`applyWindowReadings` in the binary, v2.1.280), so between two
   *   responses every render repeats it exactly. Measured on v2.1.280 in the sandbox's
   *   `alpha`: a 5-second `refreshInterval` rendered the same two windows byte for byte
   *   before, across and after a turn. And because one response carries every window, one
   *   window moving vouches for the rest of the same post — which matters, because the
   *   percentages are integers and the weekly one can sit still for hours while the
   *   five-hour one ticks.
   * - `repeat` — known, and nothing it reported last time has moved. An idle re-post.
   * - `first` — an id this store has not seen. **Not evidence either way**, and the reason
   *   is measured rather than cautious: `/clear` mints a new `session_id` inside the same
   *   process and its very first render carries that process's held reading — a sleeper's
   *   copy under a brand-new name (captured: the old id and the new one posting identical
   *   windows in the same second). A new session's first post is usually fresh too; there
   *   is no telling which, so it becomes a baseline and moves nothing until it moves.
   * - `anonymous` — no usable `session_id` at all. Nothing Claude Code sends, but nothing
   *   stops a script posting here, and there is no witness to read, so it gets the rule
   *   this store had before there was one.
   *
   * A window that *disappears* is deliberately not a witness. Claude Code filters every
   * window whose `resets_at` has passed on its own clock, so a sleeping session's five-hour
   * window vanishes from its payload with no response at all; counting that as movement
   * would let the sleeper's weekly copy through once, every five hours. Only a window
   * present in both posts is compared.
   *
   * **In memory, on purpose.** A restart loses every baseline, and all that costs is one
   * post per session: each becomes `first` again, which moves nothing, so a panel restarted
   * among sleepers holding a pre-reset copy keeps what it had on disk rather than taking
   * theirs — the case a persisted map would exist for is already the safe one. Keeping the
   * file to `{windows, at}` also means a rollback reads it unchanged; `TaskStore`'s erasure
   * is what happens to a field an older reader has never heard of.
   *
   * Bounded by count, oldest out: an open session re-posts every minute and so stays near
   * the end, and one evicted by a flood simply comes back as `first` — the safe kind.
   */
  #witness(sessionId, incoming) {
    const id = typeof sessionId === 'string' && sessionId !== '' && sessionId.length <= MAX_ID ? sessionId : null;
    if (id === null) return 'anonymous';

    const before = this.#seen.get(id);
    this.#seen.delete(id);
    this.#seen.set(id, incoming);
    if (this.#seen.size > MAX_SESSIONS) this.#seen.delete(this.#seen.keys().next().value);

    if (!before) return 'first';
    return Object.keys(incoming).some((k) => before[k] && !sameReading(before[k], incoming[k])) ? 'fresh' : 'repeat';
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A number, or null — and `Number()` on its own is not that function.
 *
 * The type is not promised: the capture had integers (43, 4) where the documentation shows
 * `23.5`, so a string has to work. But `Number(null)` is **0**, and so are `Number('')`,
 * `Number(false)` and `Number([])` — every one of which would turn "the field is there and
 * says nothing" into a `0%` bar resetting in January 1970. A plausible-looking wrong answer
 * is the one thing this panel prefers to show nothing over. So: a real number, or a string
 * that is one, and nothing else coerces.
 */
function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A percentage, clamped, or null when there is nothing drawable — never a `NaN` width. */
function percent(value) {
  const n = numeric(value);
  return n === null ? null : Math.min(100, Math.max(0, n));
}

/** Unix **seconds**, kept as seconds. */
function resetSeconds(value) {
  return numeric(value);
}

/** As it arrives from Claude Code. */
function payloadWindow(w) {
  return { usedPercentage: percent(w.used_percentage ?? w.utilization), resetsAt: resetSeconds(w.resets_at) };
}

/** As it comes back off our own file. */
function storedWindow(w) {
  return { usedPercentage: percent(w.usedPercentage), resetsAt: resetSeconds(w.resetsAt) };
}

/**
 * Every window that arrived, whatever it is called.
 *
 * `five_hour` and `seven_day` are the two seen on this account; `spend_limit` sits beside
 * them in the binary and is not exercisable here. An unknown key is carried through rather
 * than dropped — the view decides what it can draw, and a store that only knows two names
 * would silently swallow the third the day it appears.
 */
function windowsFrom(raw, read) {
  const windows = {};
  if (!isPlainObject(raw)) return windows;
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    windows[key] = read(value);
  }
  return windows;
}

/**
 * What is stored, updated by what just arrived, one window at a time.
 *
 * The union of both key sets, so a window only one side knows about survives either way,
 * and every survivor is then held to its own reset. Two things it is deliberately not.
 *
 * It is not a *merge of fields*: a window is kept or replaced whole, because
 * `usedPercentage` and `resetsAt` are one reading of one window and splicing a fresh
 * percentage onto an old reset would invent a number nothing ever measured.
 *
 * And it is not a clock. Nothing here compares arrival times — two posts a minute apart can
 * carry readings hours apart, which is the whole bug — so freshness is read off the data:
 * a five-hour window that reset since the sleeping session last looked has a *later*
 * `resetsAt` than the one that session remembers. That, and the sender's own history
 * (`#witness`) inside one window, are the only orderings the payload actually carries.
 */
function mergeWindows(stored, incoming, now, source) {
  const out = {};
  for (const key of new Set([...Object.keys(stored ?? {}), ...Object.keys(incoming)])) {
    const win = fresher(stored?.[key], incoming[key], source);
    if (win && !expired(win, now)) out[key] = win;
  }
  return out;
}

/**
 * Of two readings of one window, the one that is not a memory of the other.
 *
 * Two comparisons, because the payload carries two independent orderings and neither one
 * alone is enough.
 *
 * **Across windows, the reset.** A later `resetsAt` is a later window, so it wins, whoever
 * sent it; an *earlier* one is a session re-posting what it last saw and is dropped.
 *
 * **Within one window, the witness.** Equal resets are the same window read twice, and the
 * data cannot say which read is newer: the weekly window is long enough that a session
 * asleep for hours still holds the *current* one, so its reset matches exactly. Only the
 * sender can say, and `#witness` asks it — did your own reading move since your last post?
 *
 * - `fresh` wins, **in either direction**. A new API response is the newest thing there is,
 *   and a lower number from one is a real drop. This is the manual usage reset: it zeroed
 *   the weekly window and kept its `resetsAt`, so the five-hour bar (new window, new reset)
 *   corrected itself and the weekly one sat at 95% while the account said 0.
 * - `repeat` and `first` move nothing, **in either direction**. A sleeper's copy is lower
 *   than the truth on an ordinary day — the 9% → 5% → 9% weekly flap this rule was first
 *   built against — and *higher* than it after a manual reset, where the rule this replaced
 *   would have let every sleeper holding a pre-reset copy put the 95% straight back.
 * - `anonymous` keeps the old rule, the **higher** reading, because with no session there
 *   is no witness and "usage climbs inside a window" is the only ordering left. It is wrong
 *   exactly once per manual reset, and no Claude Code payload takes this path.
 *
 * The honest limit, since it is a real one: two sessions answered within a moment of each
 * other can post out of order, and the older fresh reading then wins — a bar a point low.
 * It cannot flap: it needs a percentage to tick between two responses that close together,
 * it happens at most once per tick, a sleeper can never cause it, and the next fresh post
 * from either session puts it right. Refusing a fresh drop to rule it out is exactly the
 * rule that left the weekly bar at 95% for a week.
 *
 * `null` is "there is nothing drawable here", not zero, so it never replaces a real number
 * — not even from a fresh post.
 *
 * An unreadable `resetsAt` on either side puts the two beyond comparison, and there the
 * incoming wins — the pre-merge behaviour. It is the honest answer to "I cannot tell which
 * is newer", and it cannot strand a bad record: the next post replaces it. Claude Code never
 * sends one (it drops a window whose reset is not a number in the future), so this is about
 * a hand-edited file and a script, not about sleepers.
 */
function fresher(stored, incoming, source) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  if (stored.resetsAt === null || incoming.resetsAt === null) return incoming;
  if (incoming.resetsAt !== stored.resetsAt) return incoming.resetsAt < stored.resetsAt ? stored : incoming;
  if (source === 'fresh') return incoming.usedPercentage === null && stored.usedPercentage !== null ? stored : incoming;
  if (source === 'anonymous') return higher(stored, incoming);
  return stored;
}

/** One window, read the same way twice. */
function sameReading(a, b) {
  return a.usedPercentage === b.usedPercentage && a.resetsAt === b.resetsAt;
}

/**
 * The larger of two percentages for one window, keeping the whole reading rather than the
 * number — the two fields are one measurement and splicing them is how a store invents a
 * value nobody took.
 *
 * `null` is "there is nothing drawable here", not zero, so it loses to any real number from
 * either side; the comparison is spelled out rather than run through `??` and a sentinel,
 * because a sentinel that ever entered the clamped 0–100 range would silently start winning.
 */
function higher(stored, incoming) {
  if (incoming.usedPercentage === null) return stored.usedPercentage === null ? incoming : stored;
  if (stored.usedPercentage === null) return incoming;
  return incoming.usedPercentage < stored.usedPercentage ? stored : incoming;
}

/**
 * Its own reset has passed — the one thing that removes a window.
 *
 * Belt to `windowsOf`'s brace in `web/quota.js`, which drops an expired window at render
 * time and must keep doing so: nothing arrives while the machine is quiet, so a window that
 * expires at 4am is still in the file at 9am and only the client is in a position to notice.
 * What this adds is a file that does not accumulate windows nobody will ever draw, and a
 * `changed` that fires on the expiry when a post does eventually land.
 *
 * `resetsAt` is Unix **seconds** and `now` is milliseconds; the `* 1000` is the whole of
 * T17, and without it every window ever stored is expired (1788571200 < Date.now()).
 * An unreadable `resetsAt` never expires — there is no instant to compare against, and
 * `windowsOf` declines to draw it anyway.
 */
function expired(win, now) {
  return win.resetsAt !== null && win.resetsAt * 1000 <= now;
}

/**
 * Order-independent, and covers exactly what a reader sees — never `at`.
 *
 * The no-record sentinel is a plain visible word, and that is not fussiness. Every real
 * entry contains an `=`, so a bare `none` cannot collide with one, and the obvious
 * alternative — a control byte nothing renders — is the trap this repo has already been
 * bitten by twice: `mergeSig` joined its fields with three literal control characters that
 * looked like an empty string in every editor, and `normalize.js` spells its ESC as
 * `\u001b` because an invisible character in source lasts until the next careless edit.
 * A NUL here has a third cost on top of those: git reads the whole file as binary, so it
 * gets no diff, no blame and no review on the forge.
 */
function signature(windows) {
  if (!windows) return 'none';
  return Object.keys(windows)
    .sort()
    .map((k) => `${k}=${windows[k].usedPercentage}@${windows[k].resetsAt}`)
    .join('|');
}
