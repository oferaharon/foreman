import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THRESHOLDS,
  toneFor,
  windowsOf,
  ageOf,
  staleness,
  formatReset,
  formatResetClock24,
} from '../web/quota.js';

/*
 * The two subscription gauges are drawn from one record, and this pins the arithmetic
 * behind them so the desktop and the phone can't drift apart on it — the same reason
 * `notify.js` is tested in isolation from `web/app.js`.
 *
 * `now` is fixed and passed explicitly throughout rather than read from `Date.now()`, the
 * same reason every other pure module here takes it as a parameter: a test that let the
 * clock move under it would be pinning nothing.
 */

const NOW = Date.parse('2026-09-04T12:00:00Z');
const record = (windows, at = NOW) => ({ windows, at });
const win = (usedPercentage, resetsInMs) => ({
  usedPercentage,
  resetsAt: Math.round((NOW + resetsInMs) / 1000),
});

/* ───────────────────────────────────────────────────────────────── tone ─── */

test('tone boundaries sit exactly at 50 and 75, not near them', () => {
  assert.equal(toneFor(49), 'ok');
  assert.equal(toneFor(50), 'warn');
  assert.equal(toneFor(74), 'warn');
  assert.equal(toneFor(75), 'hot');
});

test('the green band is a real tone, not the absence of one', () => {
  assert.equal(toneFor(0), 'ok');
  assert.equal(toneFor(49), 'ok');
});

test('THRESHOLDS is what toneFor actually reads, not a separate copy', () => {
  assert.equal(toneFor(THRESHOLDS.warn), 'warn');
  assert.equal(toneFor(THRESHOLDS.warn - 1), 'ok');
  assert.equal(toneFor(THRESHOLDS.hot), 'hot');
});

test('a non-numeric tone input draws blank rather than throwing', () => {
  assert.equal(toneFor(undefined), '');
  assert.equal(toneFor('ninety'), '');
});

test('null coerces to zero, which is a real percentage — the green band, not blank', () => {
  assert.equal(toneFor(null), 'ok');
});

/* ──────────────────────────────────────────────────────────── windowsOf ─── */

test('an absent or null record answers an empty list', () => {
  assert.deepEqual(windowsOf(null, NOW), []);
  assert.deepEqual(windowsOf(undefined, NOW), []);
  assert.deepEqual(windowsOf({}, NOW), []);
  assert.deepEqual(windowsOf(record(null), NOW), []);
});

test('five_hour then seven_day, in that order, regardless of key order on the record', () => {
  const r = record({
    seven_day: win(4, 5 * 24 * 3600 * 1000),
    five_hour: win(43, 2 * 3600 * 1000 + 10 * 60 * 1000),
  });
  const out = windowsOf(r, NOW);
  assert.deepEqual(out.map((w) => w.key), ['five_hour', 'seven_day']);
  assert.deepEqual(out.map((w) => w.label), ['5h', '7d']);
});

test('resetsAt is seconds, and the crossing into ms happens once, correctly', () => {
  const resetsAtSec = Math.round((NOW + 90 * 60 * 1000) / 1000); // 90 minutes out
  const [w] = windowsOf(record({ five_hour: { usedPercentage: 50, resetsAt: resetsAtSec } }), NOW);
  assert.equal(w.resetsAt, resetsAtSec);
  assert.equal(w.resetsIn, resetsAtSec * 1000 - NOW);
  assert.ok(w.resetsIn > 89 * 60 * 1000 && w.resetsIn < 91 * 60 * 1000);
});

test('a window whose reset has already passed is dropped, not marked expired', () => {
  const r = record({
    five_hour: win(60, -1000), // one second in the past
    seven_day: win(10, 3 * 24 * 3600 * 1000),
  });
  const out = windowsOf(r, NOW);
  assert.deepEqual(out.map((w) => w.key), ['seven_day']);
});

test('percentage and tone travel together per window', () => {
  const r = record({
    five_hour: win(92, 3600 * 1000),
    seven_day: win(10, 24 * 3600 * 1000),
  });
  const [fiveHour, sevenDay] = windowsOf(r, NOW);
  assert.equal(fiveHour.pct, 92);
  assert.equal(fiveHour.tone, 'hot');
  assert.equal(sevenDay.pct, 10);
  assert.equal(sevenDay.tone, 'ok');
});

test('a malformed record — string percentages, a missing resetsAt — answers something drawable, never throws', () => {
  const r = record({
    five_hour: { usedPercentage: '43', resetsAt: Math.round((NOW + 3600 * 1000) / 1000) },
    seven_day: { usedPercentage: 4 }, // no resetsAt at all
  });
  let out;
  assert.doesNotThrow(() => {
    out = windowsOf(r, NOW);
  });
  assert.deepEqual(out.map((w) => w.key), ['five_hour'], 'the unreadable window is dropped, the readable one survives');
  assert.equal(out[0].pct, 43, 'a string percentage is coerced');
});

test('an out-of-range or non-numeric percentage clamps instead of producing NaN', () => {
  const r = record({
    five_hour: win(150, 3600 * 1000),
    seven_day: { usedPercentage: 'not-a-number', resetsAt: Math.round((NOW + 3600 * 1000) / 1000) },
  });
  const [fiveHour, sevenDay] = windowsOf(r, NOW);
  assert.equal(fiveHour.pct, 100);
  assert.equal(sevenDay.pct, 0);
  assert.ok(!Number.isNaN(fiveHour.pct) && !Number.isNaN(sevenDay.pct));
});

test('spend_limit is carried through after the two known windows, unknown key and all', () => {
  const r = record({
    five_hour: win(50, 3600 * 1000),
    seven_day: win(10, 24 * 3600 * 1000),
    spend_limit: win(20, 12 * 3600 * 1000),
  });
  const out = windowsOf(r, NOW);
  assert.deepEqual(out.map((w) => w.key), ['five_hour', 'seven_day', 'spend_limit']);
  assert.equal(out[2].label, 'spend_limit');
  assert.equal(out[2].pct, 20);
});

/* ──────────────────────────────────────────────────────── age / staleness ─── */

test('ageOf is the plain difference, in ms, and Infinity for no record', () => {
  assert.equal(ageOf(record({}, NOW - 5000), NOW), 5000);
  assert.equal(ageOf(null, NOW), Infinity);
  assert.equal(ageOf({ windows: {} }, NOW), Infinity, 'no `at` at all');
});

test('staleness flips from live to dim exactly at fifteen minutes', () => {
  const fourteen = record({}, NOW - (STALE_MINUTES(14)));
  const fifteen = record({}, NOW - STALE_MINUTES(15));
  const sixteen = record({}, NOW - STALE_MINUTES(16));
  assert.equal(staleness(fourteen, NOW), 'live');
  assert.equal(staleness(fifteen, NOW), 'live');
  assert.equal(staleness(sixteen, NOW), 'dim');
});

test('no record at all reads as dim, the most stale thing there is', () => {
  assert.equal(staleness(null, NOW), 'dim');
});

function STALE_MINUTES(n) {
  return n * 60 * 1000;
}

/* ───────────────────────────────────────────────────────────── formatReset ─── */

test('formatReset within a day reads as hours and minutes', () => {
  const resetsAt = Math.round((NOW + 2 * 3600 * 1000 + 10 * 60 * 1000) / 1000);
  assert.equal(formatReset(resetsAt, NOW), '2h10m');
});

test('formatReset under an hour drops the hours entirely', () => {
  const resetsAt = Math.round((NOW + 45 * 60 * 1000) / 1000);
  assert.equal(formatReset(resetsAt, NOW), '45m');
});

test('formatReset a day or more out reads as a weekday name plus the hour', () => {
  // 2026-09-04T12:00:00Z is a Friday; two days out lands on Sunday, on the hour.
  const resetsAt = Math.round((NOW + 2 * DAY_MS()) / 1000);
  assert.equal(formatReset(resetsAt, NOW), `${WEEKDAY(resetsAt)} ${HOUR12(resetsAt)}`);
});

test('formatReset beyond a day, on the hour, has no minutes in the label', () => {
  const resetsAt = Math.round((NOW + 2 * DAY_MS()) / 1000);
  assert.equal(formatReset(resetsAt, NOW), `${WEEKDAY(resetsAt)} ${HOUR12(resetsAt)}`);
  assert.doesNotMatch(formatReset(resetsAt, NOW), /:/);
});

test('formatReset beyond a day, half past the hour, keeps the minutes', () => {
  const resetsAt = Math.round((NOW + 2 * DAY_MS() + 30 * 60 * 1000) / 1000);
  assert.equal(formatReset(resetsAt, NOW), `${WEEKDAY(resetsAt)} ${HOUR12(resetsAt)}`);
  assert.match(formatReset(resetsAt, NOW), /:30(AM|PM)$/);
});

test('formatReset on a record already past reads as 0m rather than a negative number', () => {
  const resetsAt = Math.round((NOW - 3600 * 1000) / 1000);
  assert.equal(formatReset(resetsAt, NOW), '0m');
});

test('formatReset on an unreadable resetsAt answers an empty string, not a throw', () => {
  assert.doesNotThrow(() => formatReset(undefined, NOW));
  assert.equal(formatReset(undefined, NOW), '');
  assert.equal(formatReset('not-a-number', NOW), '');
});

/* ────────────────────────────────────────────────── formatResetClock24 ─── */

// Built from local wall-clock components, not an offset from NOW — the point of this
// function is a fixed clock time, so the fixture has to name one rather than derive it.
function localResetsAt(hour, minute) {
  return Math.round(new Date(2026, 8, 4, hour, minute, 0).getTime() / 1000);
}

test('formatResetClock24 on the hour reads HH:00', () => {
  const resetsAt = localResetsAt(23, 0);
  assert.equal(formatResetClock24(resetsAt), '23:00');
  assert.equal(formatResetClock24(resetsAt), HOUR24(resetsAt));
});

test('formatResetClock24 with minutes keeps them', () => {
  const resetsAt = localResetsAt(23, 10);
  assert.equal(formatResetClock24(resetsAt), '23:10');
  assert.equal(formatResetClock24(resetsAt), HOUR24(resetsAt));
});

test('formatResetClock24 zero-pads a single-digit hour', () => {
  const resetsAt = localResetsAt(9, 5);
  assert.equal(formatResetClock24(resetsAt), '09:05');
  assert.equal(formatResetClock24(resetsAt), HOUR24(resetsAt));
});

test('formatResetClock24 at midnight reads 00:00, not 24:00', () => {
  const resetsAt = localResetsAt(0, 0);
  assert.equal(formatResetClock24(resetsAt), '00:00');
  assert.equal(formatResetClock24(resetsAt), HOUR24(resetsAt));
});

test('formatResetClock24 on an unreadable resetsAt answers an empty string, not a throw', () => {
  assert.doesNotThrow(() => formatResetClock24(undefined));
  assert.equal(formatResetClock24(undefined), '');
  assert.equal(formatResetClock24('not-a-number'), '');
});

function DAY_MS() {
  return 24 * 3600 * 1000;
}

function WEEKDAY(resetsAtSec) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names[new Date(resetsAtSec * 1000).getDay()];
}

// Independent of `formatHour12` in the source — built off `Intl.DateTimeFormat` rather than
// mirroring the same `getHours()`/`getMinutes()` arithmetic, so a bug shared by both would
// still be caught. `2-digit` minutes so "00" is comparable by string equality.
function HOUR12(resetsAtSec) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(resetsAtSec * 1000));
  const hour = parts.find((p) => p.type === 'hour').value;
  const minute = parts.find((p) => p.type === 'minute').value;
  const period = parts.find((p) => p.type === 'dayPeriod').value.toUpperCase();
  return minute === '00' ? `${hour}${period}` : `${hour}:${minute}${period}`;
}

// Independent of `formatResetClock24` in the source for the same reason `HOUR12` is
// independent of `formatHour12` above it. `hourCycle: 'h23'` rather than `hour12: false` —
// the latter is free to pick `h24` under some locales/engines, which spells midnight
// `24:00` instead of `00:00` and would make this helper wrong on exactly the case it exists
// to check.
function HOUR24(resetsAtSec) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(resetsAtSec * 1000));
  const hour = parts.find((p) => p.type === 'hour').value;
  const minute = parts.find((p) => p.type === 'minute').value;
  return `${hour}:${minute}`;
}
