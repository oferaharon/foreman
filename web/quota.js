/*
 * The two subscription gauges — five-hour and seven-day — read from one shared record.
 *
 * Pure functions over a `rateLimits` record, no DOM, no storage, no `Notification` — the
 * fourth file in `web/` both clients import, after `trust-gate.js`, `notify.js` and
 * `prefs.js`, and for the same reason each of those gives in its own header: two spellings
 * of a threshold is the `isLeadName` lesson in another costume. 75/90 and the percent→tone
 * map live here and nowhere else, so a desktop drawing amber at one number and a phone
 * drawing it at another can't happen.
 *
 * The record shape is `server/rate-limits.js`'s, not Claude Code's own payload — the server
 * already normalized `used_percentage`/`resets_at` into `usedPercentage`/`resetsAt` before
 * this module ever sees it:
 *
 *   { windows: { five_hour: { usedPercentage, resetsAt }, seven_day: { ... } }, at }
 *
 * Two units traps live in that shape and both were measured, not assumed. `resetsAt` is
 * Unix **seconds** — `new Date(1788571200)` is January 1970, a wrong answer that renders
 * without complaint rather than throwing one — so every comparison here multiplies by 1000
 * first. `at` is already milliseconds. And the percentage's type is not promised: Claude
 * Code returned integers on every capture taken for this feature, but its own docs show a
 * fractional one, so it is coerced with `Number` and clamped rather than trusted.
 *
 * `spend_limit` is a third window key that exists in the binary's own string table but has
 * never been observed on a real account. It is carried through unknown rather than thrown
 * on, so the day it appears the panel is wrong by omission — nothing drawn for it — rather
 * than broken outright.
 */

/** The one pair of thresholds, for both windows. Ofer's to adjust; nothing else may define its own. */
export const THRESHOLDS = { warn: 75, hot: 90 };

const STALE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `five_hour` and `seven_day`, in the order the rail draws them. Anything else in a
 *  record's `windows` object is carried through after these two, labelled by its own key. */
const KNOWN_WINDOWS = [
  { key: 'five_hour', label: '5h' },
  { key: 'seven_day', label: '7d' },
];

/** A percentage that draws rather than throws: coerced, clamped, never `NaN`. */
function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** '' | 'warn' | 'hot', for a percentage that has already been through `clampPct` — but
 *  usable directly too, since a caller handed a raw value is exactly the case this guards. */
export function toneFor(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '';
  if (n >= THRESHOLDS.hot) return 'hot';
  if (n >= THRESHOLDS.warn) return 'warn';
  return '';
}

/** One window, or `null` if there is nothing safe to draw. `resetsAt` unreadable and
 *  `resetsAt` already passed are the same outcome here — both mean "don't show this
 *  window" — rather than a bar with no reset time next to it. */
function buildWindow(key, label, raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const resetsAt = Number(raw.resetsAt);
  if (!Number.isFinite(resetsAt)) return null;

  const resetsIn = resetsAt * 1000 - now;
  if (resetsIn <= 0) return null; // Claude Code has already dropped this window itself.

  const pct = clampPct(raw.usedPercentage);
  return { key, label, pct, tone: toneFor(pct), resetsAt, resetsIn, expired: false };
}

/**
 * The windows worth drawing, in order: `five_hour`, then `seven_day`, then anything else
 * the record happens to carry (`spend_limit`, the day it exists). A window whose reset has
 * already passed is dropped rather than returned with `expired: true` — Claude Code itself
 * only ever reports one that hasn't, so a survivor past that point is stale data, not a
 * fact worth drawing.
 *
 * An absent or malformed record answers `[]`, never a throw and never a placeholder — this
 * panel's standing rule is to show nothing over showing something wrong, and a missing
 * `rate_limits` object is one of the ordinary reasons a record can be quiet (a session
 * before its first reply, an API-key account).
 */
export function windowsOf(record, now = Date.now()) {
  const windows = record?.windows;
  if (!windows || typeof windows !== 'object') return [];

  const out = [];
  const known = new Set();
  for (const { key, label } of KNOWN_WINDOWS) {
    known.add(key);
    const win = buildWindow(key, label, windows[key], now);
    if (win) out.push(win);
  }
  for (const key of Object.keys(windows)) {
    if (known.has(key)) continue;
    const win = buildWindow(key, key, windows[key], now);
    if (win) out.push(win);
  }
  return out;
}

/** How long ago the record arrived, in ms. `Infinity` for no record at all, which reads as
 *  "as dim as it gets" to `staleness` rather than needing its own null case there. */
export function ageOf(record, now = Date.now()) {
  if (!record || !Number.isFinite(record.at)) return Infinity;
  return now - record.at;
}

/** 'live' | 'dim' at fifteen minutes (Q3) — past that, the record is old enough that its
 *  age belongs in the visible line rather than only the tooltip. */
export function staleness(record, now = Date.now()) {
  return ageOf(record, now) > STALE_MS ? 'dim' : 'live';
}

/** `2h10m` within a day, a weekday name (`Mon`) beyond it. `resetsAt` is Unix seconds, per
 *  the record shape above; a reset already in the past reads as `0m` rather than a negative
 *  number, since nothing upstream is expected to hand this an expired window on purpose. */
export function formatReset(resetsAt, now = Date.now()) {
  const resetMs = Number(resetsAt) * 1000;
  if (!Number.isFinite(resetMs)) return '';

  const diff = resetMs - now;
  if (diff < DAY_MS) {
    const totalMinutes = Math.max(0, Math.round(diff / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
  }
  return WEEKDAYS[new Date(resetMs).getDay()];
}
