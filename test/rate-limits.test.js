import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RateLimitStore } from '../server/rate-limits.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rate-limits-'));
  return path.join(dir, 'rate-limits.json');
}

/** The two windows as they actually arrived, second render of a scratch session in alpha. */
const REAL = {
  five_hour: { used_percentage: 43, resets_at: 1788571200 },
  seven_day: { used_percentage: 4, resets_at: 1789084800 },
};

/*
 * Wall clocks, in **milliseconds**, positioned against REAL's two resets — because every
 * window now lives or dies by its own reset against the `now` it is ingested at, and a
 * fixture that reset in 1970 would expire the moment it arrived.
 *
 *   NOW          both windows still open
 *   PAST_5H      the five-hour window has reset; the weekly one has not
 */
const NOW = 1788_500_000_000;
const PAST_5H = 1788_600_000_000;

/* ---------------------------------------------------------------- ingest --- */

test('a payload with rate_limits becomes the record', () => {
  const s = new RateLimitStore(tmpStore());
  assert.equal(s.ingest({ rate_limits: REAL }, 1000), true);
  assert.deepEqual(s.get(), {
    windows: {
      five_hour: { usedPercentage: 43, resetsAt: 1788571200 },
      seven_day: { usedPercentage: 4, resetsAt: 1789084800 },
    },
    at: 1000,
  });
  s.stop();
});

/*
 * The payload carries `cost.total_cost_usd` — 0.3027715 on one measured turn — and this is
 * a subscription. The ruling is no USD anywhere, so the store must not so much as keep it.
 */
test('nothing but the windows is kept — no cost, no USD, no session id', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({
    session_id: 'abc', model: { id: 'claude-fable-5-1' },
    cost: { total_cost_usd: 0.3027715, total_duration_ms: 37615 },
    context_window: { used_percentage: 4 },
    rate_limits: REAL,
  }, 1000);
  const json = JSON.stringify(s.get());
  assert.ok(!/usd|cost|session|model|context/i.test(json), json);
  assert.deepEqual(Object.keys(s.get()), ['windows', 'at']);
  s.stop();
});

test('a later payload updates the window it names and leaves the others alone', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  assert.equal(
    s.ingest({ rate_limits: { five_hour: { used_percentage: 44, resets_at: 1788571200 } } }, NOW + 1000),
    true,
  );
  assert.deepEqual(Object.keys(s.get().windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(s.get().windows.five_hour.usedPercentage, 44, 'the same window, read again');
  assert.deepEqual(
    s.get().windows.seven_day,
    { usedPercentage: 4, resetsAt: 1789084800 },
    'not mentioned is not evidence — it is untouched',
  );
  s.stop();
});

/* ------------------------------------------------------- stale re-posts --- */

/*
 * The bug this merge exists for, in the shape it was confirmed in on a real panel.
 *
 * `statusLine.refreshInterval` is 60, so a session idle for hours re-renders every minute
 * and re-posts the payload it is *holding* — hours-old percentages, and no `five_hour` at
 * all, because that window's reset passed long ago and Claude Code dropped it from that
 * session's copy. Wholesale replacement let the sleeper blank the live five-hour bar once a
 * minute; the file alternated between the two readings.
 */
test('a seven_day-only re-post from an idle session does not clear a live five_hour', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  assert.equal(
    s.ingest({ rate_limits: { seven_day: { used_percentage: 4, resets_at: 1789084800 } } }, NOW + 60_000),
    false,
    'nothing a reader sees moved, so nothing is broadcast',
  );
  assert.deepEqual(
    s.get().windows.five_hour,
    { usedPercentage: 43, resetsAt: 1788571200 },
    'the bar the sleeper had forgotten about is still there',
  );
  assert.equal(s.get().at, NOW + 60_000, 'the arrival is still the newest one');
  s.stop();
});

/* An older `resetsAt` is the previous five-hour window — a memory, not a reading. */
test('a five_hour whose reset is older than the stored one is ignored', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  const stale = { five_hour: { used_percentage: 99, resets_at: 1788571200 - 5 * 3600 } };
  assert.equal(s.ingest({ rate_limits: stale }, NOW + 60_000), false);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 43, resetsAt: 1788571200 });
  s.stop();
});

/* …and a *later* one is the next window, which is exactly what must get through. */
test('a five_hour whose reset is later than the stored one replaces it', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  const next = { five_hour: { used_percentage: 2, resets_at: 1788571200 + 5 * 3600 } };
  assert.equal(s.ingest({ rate_limits: next }, NOW + 1000), true);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 2, resetsAt: 1788571200 + 5 * 3600 });
  s.stop();
});

/*
 * Equal resets are one window read twice, and the incoming reading is taken as-is —
 * downwards included. Within a window a percentage only climbs, but that is an assumption
 * about a number this panel does not own, and a store that argued with its own source of
 * truth could not be corrected by it.
 */
test('the same window read again takes the incoming percentage, even downwards', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  assert.equal(
    s.ingest({ rate_limits: { five_hour: { used_percentage: 11, resets_at: 1788571200 } } }, NOW + 1000),
    true,
  );
  assert.equal(s.get().windows.five_hour.usedPercentage, 11);
  s.stop();
});

/* Beyond comparison is not the same as stale: the incoming wins, as it did before. */
test('an unreadable resets_at on either side falls back to latest-wins', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  s.ingest({ rate_limits: { five_hour: { used_percentage: 7, resets_at: null } } }, NOW + 1000);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 7, resetsAt: null });

  s.ingest({ rate_limits: { five_hour: { used_percentage: 8, resets_at: 1788571200 } } }, NOW + 2000);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 8, resetsAt: 1788571200 });
  s.stop();
});

/* ------------------------------------------------------------- expiry --- */

/*
 * The one and only thing that removes a window — measured against this machine's clock,
 * never inferred from a payload that simply did not mention it.
 */
test('a stored window is dropped once its own reset has passed', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  assert.equal(s.ingest({ rate_limits: { seven_day: REAL.seven_day } }, PAST_5H), true);
  assert.equal(s.get().windows.five_hour, undefined, 'its reset is behind us now');
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 4, resetsAt: 1789084800 }, 'the weekly one is not');
  s.stop();
});

test('a window that arrives already expired is not stored', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { used_percentage: 43, resets_at: 1788571200 } } }, PAST_5H);
  assert.deepEqual(s.get().windows, {});
  s.stop();
});

test('a window with no readable reset never expires, and is left to the view to refuse', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { used_percentage: 43, resets_at: null } } }, NOW);
  assert.equal(s.ingest({ rate_limits: { seven_day: REAL.seven_day } }, PAST_5H), true);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 43, resetsAt: null });
  s.stop();
});

test('a present but empty rate_limits clears nothing that is still valid', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  assert.equal(s.ingest({ rate_limits: {} }, NOW + 1000), false);
  assert.deepEqual(Object.keys(s.get().windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(s.get().at, NOW + 1000);

  // …and still expires what has genuinely run out, on the same empty payload.
  assert.equal(s.ingest({ rate_limits: {} }, PAST_5H), true);
  assert.deepEqual(Object.keys(s.get().windows), ['seven_day']);
  s.stop();
});

/*
 * The other half of T10. `rate_limits` was absent from the very first render of a measured
 * session and present on every one after it — and an API-key session never carries it at
 * all. One such session posting every few seconds must not wipe the gauges.
 */
test('a payload with no rate_limits key at all is ignored entirely', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, 1000);
  assert.equal(s.ingest({ session_id: 'abc', model: { id: 'x' } }, 2000), false);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 43, resetsAt: 1788571200 });
  assert.equal(s.get().at, 1000, 'and the age is not touched either');
  s.stop();
});

test('nonsense in place of rate_limits is ignored, not read', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, 1000);
  for (const junk of [null, 'five_hour', 42, [], undefined]) {
    assert.equal(s.ingest({ rate_limits: junk }, 2000), false, JSON.stringify(junk));
  }
  assert.equal(s.ingest(null, 2000), false);
  assert.equal(s.ingest('nope', 2000), false);
  assert.equal(s.get().at, 1000);
  s.stop();
});

test('nothing has arrived yet reads as null, not as an empty record', () => {
  const s = new RateLimitStore(tmpStore());
  assert.equal(s.get(), null);
  s.stop();
});

/* ----------------------------------------------------------- what changed --- */

/*
 * The age is computed in the browser from `at`. A server that reported a change every time
 * `at` moved would rebuild the rail on every render of every status line on the machine.
 */
test('an identical re-post reports no change, even though `at` moved', () => {
  const s = new RateLimitStore(tmpStore());
  assert.equal(s.ingest({ rate_limits: REAL }, 1000), true);
  assert.equal(s.ingest({ rate_limits: REAL }, 9000), false);
  assert.equal(s.get().at, 9000, 'the record still moved — only the broadcast did not');
  s.stop();
});

test('key order in the payload is not a change', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, 1000);
  assert.equal(
    s.ingest({ rate_limits: { seven_day: REAL.seven_day, five_hour: REAL.five_hour } }, 2000),
    false,
  );
  s.stop();
});

test('a moved percentage and a moved reset are both changes', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, 1000);
  assert.equal(s.ingest({ rate_limits: { ...REAL, five_hour: { used_percentage: 44, resets_at: 1788571200 } } }, 2000), true);
  assert.equal(s.ingest({ rate_limits: { ...REAL, five_hour: { used_percentage: 44, resets_at: 1788589200 } } }, 3000), true);
  s.stop();
});

/*
 * The point of the whole thing, from the broadcast's side. A machine full of idle sessions
 * posts once a minute each and moves nothing; every one of those must be silent, or the
 * rail rebuilds on a timer for a record that has not changed since breakfast.
 */
test('a stale re-post that the merge refuses reports no change at all', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  for (let i = 1; i <= 5; i++) {
    const stale = { seven_day: { used_percentage: 4, resets_at: 1789084800 } };
    assert.equal(s.ingest({ rate_limits: stale }, NOW + i * 60_000), false, `minute ${i}`);
  }
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 43, resetsAt: 1788571200 });
  s.stop();
});

/* A window leaving the set is as much a change as a number moving inside it. */
test('an expiry is a change, and so is a window appearing', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { seven_day: REAL.seven_day } }, NOW);
  assert.equal(s.ingest({ rate_limits: REAL }, NOW + 1000), true, 'five_hour appeared');
  assert.equal(s.ingest({ rate_limits: { seven_day: REAL.seven_day } }, PAST_5H), true, 'and then expired');
  assert.equal(s.ingest({ rate_limits: { seven_day: REAL.seven_day } }, PAST_5H + 1000), false, 'and stays gone quietly');
  s.stop();
});

/* -------------------------------------------------------------- the keys --- */

/*
 * T1. The capture says `used_percentage`, but the binary's string table puts `utilization`
 * between `five_hour` and `resets_at` and every internal telemetry name is
 * `priorFiveHourUtilization`. One `??` against a rename the string table says is plausible.
 */
test('`utilization` is read when `used_percentage` is absent', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { utilization: 61, resets_at: 1788571200 } } }, 1000);
  assert.equal(s.get().windows.five_hour.usedPercentage, 61);
  s.stop();
});

test('`used_percentage` wins when both are present', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { used_percentage: 43, utilization: 61, resets_at: 1788571200 } } }, 1000);
  assert.equal(s.get().windows.five_hour.usedPercentage, 43);
  s.stop();
});

/*
 * `spend_limit` sits next to the other two in the binary and is not exercisable on this
 * account. A store that only knew two names would silently swallow it the day it appears.
 */
test('an unknown third window is carried through, not dropped', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { ...REAL, spend_limit: { used_percentage: 12, resets_at: 1789084800 } } }, 1000);
  assert.deepEqual(s.get().windows.spend_limit, { usedPercentage: 12, resetsAt: 1789084800 });
  s.stop();
});

/* ------------------------------------------------------------ the numbers --- */

/*
 * T18: the type is not promised. The capture had integers where the documentation shows
 * 23.5. Coerce, clamp, and never let a NaN reach a bar's width.
 */
test('percentages are coerced, clamped, and never NaN', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({
    rate_limits: {
      a: { used_percentage: '43.5', resets_at: '1788571200' },
      b: { used_percentage: 'plenty', resets_at: 1788571200 },
      c: { used_percentage: 140, resets_at: 1788571200 },
      d: { used_percentage: -3, resets_at: 1788571200 },
      e: { used_percentage: null, resets_at: null },
      f: { used_percentage: 23.5, resets_at: 1788571200 },
      g: { used_percentage: '', resets_at: [] },
      h: { used_percentage: false, resets_at: {} },
    },
  }, 1000);
  const w = s.get().windows;
  assert.deepEqual(w.a, { usedPercentage: 43.5, resetsAt: 1788571200 }, 'strings are numbers');
  assert.equal(w.b.usedPercentage, null, 'not drawable, and not NaN');
  assert.equal(w.c.usedPercentage, 100, 'clamped');
  assert.equal(w.d.usedPercentage, 0, 'clamped');
  assert.equal(w.f.usedPercentage, 23.5, 'the documented fractional shape');
  assert.ok(!JSON.stringify(s.get()).includes('NaN'));

  // `Number(null)` is 0, and so are `Number('')`, `Number(false)` and `Number([])`. Every
  // one of them would turn a field that says nothing into a 0% bar resetting in 1970.
  for (const key of ['e', 'g', 'h']) {
    assert.deepEqual(w[key], { usedPercentage: null, resetsAt: null }, key);
  }
  s.stop();
});

test('a null `used_percentage` falls through to `utilization`, the way ?? should', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { used_percentage: null, utilization: 61, resets_at: 1788571200 } } }, 1000);
  assert.equal(s.get().windows.five_hour.usedPercentage, 61);
  s.stop();
});

/* T17: seconds, stored as seconds. new Date(1788571200) is January 1970. */
test('resets_at is kept in seconds, exactly as it arrives', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, 1000);
  assert.equal(s.get().windows.five_hour.resetsAt, 1788571200);
  assert.equal(new Date(s.get().windows.five_hour.resetsAt * 1000).getUTCFullYear(), 2026);
  s.stop();
});

test('a window that is not an object is skipped, and the rest survive', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: 43, seven_day: REAL.seven_day } }, 1000);
  assert.deepEqual(Object.keys(s.get().windows), ['seven_day']);
  s.stop();
});

/* ------------------------------------------------------------- on disk --- */

/*
 * The feed is event-driven — 2 renders in 5m43s, 0 across 90 seconds idle — so a panel
 * restart must not blank a gauge that was right a second ago.
 */
test('the record comes back from disk in a new store on the same file', () => {
  const file = tmpStore();
  const a = new RateLimitStore(file);
  a.ingest({ rate_limits: REAL }, 1000);
  a.stop(); // flushes

  const b = new RateLimitStore(file);
  assert.deepEqual(b.get(), {
    windows: {
      five_hour: { usedPercentage: 43, resetsAt: 1788571200 },
      seven_day: { usedPercentage: 4, resetsAt: 1789084800 },
    },
    at: 1000,
  });
  b.stop();
});

test('an arrival that changed nothing is still persisted, so the age survives a restart', () => {
  const file = tmpStore();
  const a = new RateLimitStore(file);
  a.ingest({ rate_limits: REAL }, 1000);
  assert.equal(a.ingest({ rate_limits: REAL }, 9000), false);
  a.stop();

  assert.equal(new RateLimitStore(file).get().at, 9000);
});

test('a corrupt file starts clean rather than throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, 'not json at all {{{');
  const s = new RateLimitStore(file);
  assert.equal(s.get(), null);
  assert.equal(s.ingest({ rate_limits: REAL }, 1000), true, 'and still works afterwards');
  s.stop();
});

test('a file hand-edited into the wrong shape starts clean', () => {
  const file = tmpStore();
  for (const junk of ['[]', '"nope"', 'null', '{"windows":{}}', '{"at":"soon"}']) {
    fs.writeFileSync(file, junk);
    const s = new RateLimitStore(file);
    assert.equal(s.get(), null, junk);
    s.stop();
  }
});

/* A hand-edit is a hand-edit; a NaN% on the rail is worse than no rail. */
test('a file carrying a nonsense percentage is re-coerced on the way in', () => {
  const file = tmpStore();
  fs.writeFileSync(file, JSON.stringify({
    windows: { five_hour: { usedPercentage: 'lots', resetsAt: 1788571200 }, seven_day: 7 },
    at: 1000,
  }));
  const s = new RateLimitStore(file);
  assert.deepEqual(s.get(), {
    windows: { five_hour: { usedPercentage: null, resetsAt: 1788571200 } },
    at: 1000,
  });
  s.stop();
});

test('a store with nothing in it writes nothing', () => {
  const file = tmpStore();
  const s = new RateLimitStore(file);
  s.stop();
  assert.equal(fs.existsSync(file), false);
});
