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
  const file = tmpStore();
  const s = new RateLimitStore(file);
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

  // The session id is read — it is the key to that session's own last reading — but only in
  // memory. The file is exactly what it was before there was a witness, which is also what
  // lets an older build read it back unchanged.
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!/usd|cost|session|model|context|abc|0\.3027715|37615/i.test(disk), disk);
  assert.deepEqual(Object.keys(JSON.parse(disk)), ['windows', 'at']);
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
 * Equal resets are one window read twice, and inside a window usage only climbs — quota is
 * spent, never returned, until the reset that ends the window and mints a new `resetsAt`.
 * So the higher reading is the later one.
 */
test('the same window read again keeps the higher percentage', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: REAL }, NOW);
  assert.equal(
    s.ingest({ rate_limits: { five_hour: { used_percentage: 51, resets_at: 1788571200 } } }, NOW + 1000),
    true,
    'a climb is the newer reading and gets through',
  );
  assert.equal(s.get().windows.five_hour.usedPercentage, 51);
  s.stop();
});

/*
 * The weekly flap, which the reset comparison alone could not catch. A session asleep for
 * hours still holds the *current* seven-day window — same `resetsAt`, hours-old percentage
 * — so only the number separates the two readings, and the bar walked 9 → 5 → 9 once a
 * minute until it did. Same bug as the five-hour one, one field across.
 */
test('a lower percentage on the same window is the stale copy and is ignored', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { ...REAL, seven_day: { used_percentage: 9, resets_at: 1789084800 } } }, NOW);

  const idle = { seven_day: { used_percentage: 5, resets_at: 1789084800 } };
  assert.equal(s.ingest({ rate_limits: idle }, NOW + 60_000), false, 'and it is not a broadcast either');
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 9, resetsAt: 1789084800 });

  // …and it stays refused, minute after minute, for as long as that session sleeps.
  for (let i = 2; i <= 5; i++) assert.equal(s.ingest({ rate_limits: idle }, NOW + i * 60_000), false, `minute ${i}`);
  assert.equal(s.get().windows.seven_day.usedPercentage, 9);
  s.stop();
});

/*
 * The reset comparison still outranks the percentage one, and must: the *next* window opens
 * at 0% and would lose every time if a bigger number simply won.
 */
test('a later reset beats a higher percentage — a new window starts low', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { used_percentage: 97, resets_at: 1788571200 } } }, NOW);
  const next = { five_hour: { used_percentage: 0, resets_at: 1788571200 + 5 * 3600 } };
  assert.equal(s.ingest({ rate_limits: next }, NOW + 1000), true);
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 0, resetsAt: 1788571200 + 5 * 3600 });
  s.stop();
});

/* `null` is "nothing drawable", not zero, so it loses to a real number from either side. */
test('an unreadable percentage never wins against a real one, in either direction', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { five_hour: { used_percentage: 43, resets_at: 1788571200 } } }, NOW);
  s.ingest({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1788571200 } } }, NOW + 1000);
  assert.equal(s.get().windows.five_hour.usedPercentage, 43, 'a real reading is not replaced by nothing');

  const t = new RateLimitStore(tmpStore());
  t.ingest({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1788571200 } } }, NOW);
  t.ingest({ rate_limits: { five_hour: { used_percentage: 43, resets_at: 1788571200 } } }, NOW + 1000);
  assert.equal(t.get().windows.five_hour.usedPercentage, 43, 'and nothing is replaced by a real reading');
  s.stop();
  t.stop();
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

/* ----------------------------------------------------------- the witness --- */

/*
 * Everything above posts without a `session_id` and so runs on the old rule — the higher
 * reading wins inside a window. Claude Code always sends one, and what it makes possible is
 * below: a session whose own reading moved since its last post is carrying a new API
 * response, and that is the only thing allowed to move a bar inside one window.
 *
 * The shape is the real one: `rate_limits` is built from one process-wide reading that each
 * response replaces wholesale, so an idle render repeats it byte for byte (measured on
 * v2.1.280 in the sandbox's alpha, 5-second refresh, before, across and after a turn).
 */
const R5 = 1788571200; //                the current five-hour window's reset
const R7 = 1789084800; //                the current weekly window's reset
const post = (id, five, seven, r5 = R5) => ({
  session_id: id,
  rate_limits: {
    ...(five !== undefined && { five_hour: { used_percentage: five, resets_at: r5 } }),
    ...(seven !== undefined && { seven_day: { used_percentage: seven, resets_at: R7 } }),
  },
});

/*
 * The bug, in the shape it arrived in: the maintainer used the one-time usage reset, which
 * zeroed both windows. The five-hour one came back with a new `resetsAt` and corrected
 * itself; the weekly one kept its `resetsAt` and stayed at 95%, because "the higher
 * percentage wins" read every fresh low reading as a sleeper's copy.
 */
test('a manual usage reset: a fresh lower reading on the same weekly window wins', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest(post('active', 40, 94), NOW);
  s.ingest(post('active', 41, 95), NOW + 60_000);
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 95, resetsAt: R7 });

  // The reset: a new five-hour window, and the same weekly one at nearly nothing.
  assert.equal(s.ingest(post('active', 0, 1, R5 + 3600), NOW + 120_000), true, 'and it is broadcast');
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 1, resetsAt: R7 }, 'same resetsAt, lower, accepted');
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 0, resetsAt: R5 + 3600 });
  s.stop();
});

/*
 * The regression this must not bring back, now with session ids on it: one sleeping
 * session re-posting its last-known weekly reading every minute. Refused as a first
 * sighting and refused as a repeat, and no broadcast for any of it.
 */
test('the idle re-post flap stays refused: a sleeper moves nothing, first post or fiftieth', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest(post('active', 43, 8), NOW);
  s.ingest(post('active', 44, 9), NOW + 1000);
  assert.equal(s.get().windows.seven_day.usedPercentage, 9);

  const sleeper = post('sleeper', undefined, 5);
  for (let i = 1; i <= 5; i++) {
    assert.equal(s.ingest(sleeper, NOW + i * 60_000), false, `minute ${i}`);
    assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 9, resetsAt: R7 }, `minute ${i}`);
  }
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 44, resetsAt: R5 }, 'and the five-hour bar it forgot is kept');
  s.stop();
});

/*
 * The other direction, which "higher wins" got wrong by construction. After a reset, every
 * session that has not spoken since is holding a pre-reset copy that is *higher* than the
 * truth — and `/clear` re-posts that copy under a brand-new id (captured: old id and new id,
 * identical windows, the same second).
 */
test('after a drop, a sleeper holding the pre-reset copy cannot put it back — nor can its /clear', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest(post('sleeper', 41, 95), NOW);
  s.ingest(post('active', 41, 95), NOW + 1000);
  s.ingest(post('active', 0, 1, R5 + 3600), NOW + 2000);
  assert.equal(s.get().windows.seven_day.usedPercentage, 1);

  for (let i = 1; i <= 3; i++) {
    assert.equal(s.ingest(post('sleeper', 41, 95), NOW + i * 60_000), false, `repeat, minute ${i}`);
  }
  assert.equal(s.ingest(post('sleeper-after-clear', 41, 95), NOW + 4 * 60_000), false, 'a new id with the held copy');
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 1, resetsAt: R7 });
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 0, resetsAt: R5 + 3600 }, 'older reset, refused as before');
  s.stop();
});

/*
 * The real machine on the day this shipped: a stored 95% on disk, a restart that forgot
 * every baseline, sleepers holding pre-reset copies and active sessions holding the truth.
 * Nobody's first post moves anything; the first *moved* post of a known session does — and
 * a weekly percentage can sit still for hours, so a five-hour tick in the same post has to
 * be enough to vouch for it (one response carries both windows).
 */
test('after a restart, the first post of a session whose numbers moved corrects the weekly bar', () => {
  const file = tmpStore();
  const before = new RateLimitStore(file);
  before.ingest({ rate_limits: { five_hour: { used_percentage: 7, resets_at: R5 }, seven_day: { used_percentage: 95, resets_at: R7 } } }, NOW);
  before.stop();

  const s = new RateLimitStore(file);
  assert.equal(s.ingest(post('sleeper', 5, 95), NOW + 1000), false);
  assert.equal(s.ingest(post('active', 7, 1), NOW + 2000), false, 'a first sighting is a baseline, not a witness');
  assert.equal(s.ingest(post('active', 7, 1), NOW + 62_000), false, 'nor is a repeat of it');
  assert.equal(s.get().windows.seven_day.usedPercentage, 95);

  assert.equal(s.ingest(post('active', 8, 1), NOW + 90_000), true, 'the five-hour ticked: a new response');
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 1, resetsAt: R7 });
  assert.equal(s.ingest(post('sleeper', 5, 95), NOW + 120_000), false, 'and the sleeper still moves nothing');
  assert.equal(s.get().windows.seven_day.usedPercentage, 1);
  s.stop();
});

/*
 * Claude Code drops a window from the payload once its reset passes on *its* clock, with no
 * response at all — so a sleeper's post changes shape every five hours. That is not a
 * witness, or the sleeper's weekly copy would get through once each time.
 */
test('a window disappearing from a sleeper\'s payload is not a witness', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest(post('active', 43, 8), NOW);
  s.ingest(post('active', 44, 9), NOW + 1000);
  s.ingest(post('sleeper', 30, 5), NOW + 2000);
  assert.equal(s.ingest(post('sleeper', undefined, 5), NOW + 62_000), false);
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 9, resetsAt: R7 });
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 44, resetsAt: R5 });
  s.stop();
});

/* The reset comparison outranks the witness: a later window wins whoever carries it. */
test('a later reset still wins from a first sighting and from a repeat', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest(post('active', 97, 50), NOW);
  assert.equal(s.ingest(post('newcomer', 0, 50, R5 + 5 * 3600), NOW + 1000), true, 'first sighting, next window');
  assert.deepEqual(s.get().windows.five_hour, { usedPercentage: 0, resetsAt: R5 + 5 * 3600 });

  const t = new RateLimitStore(tmpStore());
  t.ingest(post('a', 97, 50), NOW);
  t.ingest(post('b', 3, 50, R5 + 5 * 3600), NOW + 1000);
  t.ingest(post('a', 97, 50), NOW + 2000); // an older window again: refused, as before
  assert.equal(t.get().windows.five_hour.resetsAt, R5 + 5 * 3600);
  s.stop();
  t.stop();
});

/* `null` is nothing drawable; a fresh post carrying one does not blank a real reading. */
test('a fresh post never replaces a real percentage with an unreadable one', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest(post('active', 43, 8), NOW);
  s.ingest(post('active', 44, null), NOW + 1000);
  assert.deepEqual(s.get().windows.seven_day, { usedPercentage: 8, resetsAt: R7 });
  assert.equal(s.get().windows.five_hour.usedPercentage, 44);
  s.stop();
});

/*
 * The memory is bounded, and what falls out of it comes back as a first sighting — the kind
 * that moves nothing — rather than as a stranger's witness.
 */
test('the per-session memory is bounded, and an evicted session is a first sighting again', () => {
  const s = new RateLimitStore(tmpStore());
  s.ingest({ rate_limits: { seven_day: { used_percentage: 50, resets_at: R7 } } }, NOW);
  s.ingest(post('kept', undefined, 40), NOW + 1);
  s.ingest(post('evicted', undefined, 40), NOW + 2);
  for (let i = 0; i < 250; i++) s.ingest(post(`other-${i}`, undefined, 50), NOW + 10 + i);
  s.ingest(post('kept', undefined, 40), NOW + 500); // a live session re-posts, and stays near the end

  // 252 remembered; ten more push the four oldest out, `evicted` first among them.
  for (let i = 250; i < 260; i++) s.ingest(post(`other-${i}`, undefined, 50), NOW + 600 + i);
  assert.equal(s.ingest(post('evicted', undefined, 41), NOW + 2000), false, 'forgotten, so not a witness');
  assert.equal(s.get().windows.seven_day.usedPercentage, 50);
  assert.equal(s.ingest(post('kept', undefined, 41), NOW + 3000), true, 'remembered, so it is');
  assert.equal(s.get().windows.seven_day.usedPercentage, 41);
  s.stop();
});

/* Only a string is a session id; anything else is a post with no witness, on the old rule. */
test('a session_id that is not a usable string is anonymous, and the higher reading wins', () => {
  for (const id of [42, '', null, { id: 'x' }, 'x'.repeat(201)]) {
    const s = new RateLimitStore(tmpStore());
    s.ingest({ session_id: id, rate_limits: { seven_day: { used_percentage: 9, resets_at: R7 } } }, NOW);
    s.ingest({ session_id: id, rate_limits: { seven_day: { used_percentage: 5, resets_at: R7 } } }, NOW + 1000);
    assert.equal(s.get().windows.seven_day.usedPercentage, 9, JSON.stringify(id)?.slice(0, 20));
    s.ingest({ session_id: id, rate_limits: { seven_day: { used_percentage: 12, resets_at: R7 } } }, NOW + 2000);
    assert.equal(s.get().windows.seven_day.usedPercentage, 12, JSON.stringify(id)?.slice(0, 20));
    s.stop();
  }
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
