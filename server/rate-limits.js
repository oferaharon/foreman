import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';

const FILE = path.join(STATE_DIR, 'rate-limits.json');

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
 *   else's memory of it. And **within one window the higher percentage wins**, because a
 *   long window (the weekly one) is still current in a sleeping session's copy, so its
 *   reset matches and only the number tells the two readings apart — see `fresher`.
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
 * meaningless here, so it is never extracted, never stored and never sent.
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
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    /** @type {{windows: Record<string, {usedPercentage: number|null, resetsAt: number|null}>, at: number}|null} */
    this.record = null;
    this.dirty = false;
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

    const windows = mergeWindows(this.record?.windows, windowsFrom(raw, payloadWindow), now);
    const changed = signature(windows) !== signature(this.record?.windows);
    this.record = { windows, at: now };
    this.dirty = true;
    return changed;
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
 * `resetsAt` than the one that session remembers. That is the only ordering the payload
 * actually carries.
 */
function mergeWindows(stored, incoming, now) {
  const out = {};
  for (const key of new Set([...Object.keys(stored ?? {}), ...Object.keys(incoming)])) {
    const win = fresher(stored?.[key], incoming[key]);
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
 * **Across windows, the reset.** A later `resetsAt` is a later window, so it wins; an
 * *earlier* one is a session re-posting what it last saw and is dropped.
 *
 * **Within one window, the percentage.** Equal resets are the same window read twice, and
 * usage inside a window only ever climbs — quota is spent, never returned, until the reset
 * that ends the window and gives it a new `resetsAt`. So the **higher** reading is the
 * later one and a lower one is the sleeper's older copy. Taking the incoming value as-is
 * was the first version of this rule, and it left the weekly bar flapping 9% → 5% → 9% on
 * the same idle re-post the five-hour half was already protected from: the weekly window is
 * long enough that a session asleep for hours still holds the *current* one, so its reset
 * matches exactly and the comparison above cannot separate them. It is the same bug one
 * field across.
 *
 * The honest limit, since it is a real one: a genuine downward correction inside a window
 * is now ignored. It is bounded rather than permanent — the next reset mints a new
 * `resetsAt`, which the comparison above accepts unconditionally, so a wrong high reading
 * cannot outlive its own window (five hours at the worst, a week for the weekly one).
 * Weighed against a bar that visibly walks backwards every minute on a quiet machine.
 *
 * An unreadable `resetsAt` on either side puts the two beyond comparison, and there the
 * incoming wins — the pre-merge behaviour. It is the honest answer to "I cannot tell which
 * is newer", and it cannot strand a bad record: the next post replaces it.
 */
function fresher(stored, incoming) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  if (stored.resetsAt === null || incoming.resetsAt === null) return incoming;
  if (incoming.resetsAt !== stored.resetsAt) return incoming.resetsAt < stored.resetsAt ? stored : incoming;
  return higher(stored, incoming);
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
