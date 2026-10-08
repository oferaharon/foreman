import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PinStore, carryPinOrder, pinOrderProblem } from '../server/pins.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pins-'));
  return path.join(dir, 'pins.json');
}

test('a pin sticks, and unpinning releases it', () => {
  const p = new PinStore(tmpStore());
  assert.equal(p.set('%1', true), true);
  assert.equal(p.has('%1'), true);
  assert.equal(p.set('%1', false), true);
  assert.equal(p.has('%1'), false);
  p.stop();
});

test('setting a pin that is already set changes nothing', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { now: 100 });
  p.set('%2', true, { now: 200 });
  assert.equal(p.set('%1', true, { now: 900 }), false, 'no change to report');
  assert.deepEqual(p.order(), ['%1', '%2'], 'and it keeps its place');
  assert.equal(p.set('%3', false), false, 'unpinning something unpinned is not an error');
  p.stop();
});

/* ----------------------------------------------------------------- order --- */

/*
 * The pinned group is the maintainer's arrangement: a new pin goes to the bottom, so pinning
 * a second session never reshuffles the first.
 */
test('a new pin goes to the bottom of the group', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { now: 300 });
  p.set('%2', true, { now: 200 }); // a clock that went backwards must not reorder anything
  p.set('%3', true, { now: 100 });
  assert.deepEqual(p.order(), ['%1', '%2', '%3']);
  assert.equal(p.rank('%1'), 0);
  assert.equal(p.rank('%3'), 2);
  assert.equal(p.rank('%9'), null, 'not pinned has no place');
  p.stop();
});

test('reorder rearranges the group, and says when it changed nothing', () => {
  const p = new PinStore(tmpStore());
  for (const id of ['%1', '%2', '%3']) p.set(id, true);
  assert.deepEqual(p.reorder(['%3', '%1', '%2']), { changed: true });
  assert.deepEqual(p.order(), ['%3', '%1', '%2']);
  assert.deepEqual(p.reorder(['%3', '%1', '%2']), { changed: false });
  p.set('%4', true);
  assert.deepEqual(p.order(), ['%3', '%1', '%2', '%4'], 'still to the bottom after a reorder');
  p.stop();
});

test('unpinning takes a pin out of the order, and pinning again puts it at the bottom', () => {
  const p = new PinStore(tmpStore());
  for (const id of ['%1', '%2', '%3']) p.set(id, true);
  p.reorder(['%2', '%3', '%1']);
  p.set('%3', false);
  assert.deepEqual(p.order(), ['%2', '%1']);
  assert.equal(p.rank('%3'), null);
  p.set('%3', true);
  assert.deepEqual(p.order(), ['%2', '%1', '%3'], 'its old place is not remembered');
  p.stop();
});

/*
 * The endpoint hands the body straight to `reorder`, so the store is the wall: an order may
 * only rearrange what is pinned. A drag read off a roster frame a beat old must not pin or
 * unpin anything by accident, and nothing else must get in at all.
 */
test('a bad order is refused and changes nothing', () => {
  const p = new PinStore(tmpStore());
  for (const id of ['%1', '%2', '%3']) p.set(id, true);
  const cases = [
    [undefined, 'malformed'],
    ['%1,%2,%3', 'malformed'],
    [{ 0: '%1' }, 'malformed'],
    [['%1', 2, '%3'], 'malformed'],
    [['%1', '', '%3'], 'malformed'],
    [['%1', '%1', '%2', '%3'], 'malformed'],
    [['%1', '%2'], 'stale'], // leaves one out — would read as an unpin
    [['%1', '%2', '%3', '%4'], 'stale'], // names an unpinned pane — would read as a pin
    [['%1', '%2', '%4'], 'stale'],
    [[], 'stale'],
  ];
  for (const [body, refused] of cases) {
    const r = p.reorder(body);
    assert.equal(r.refused, refused, JSON.stringify(body));
    assert.equal(typeof r.error, 'string');
    assert.deepEqual(p.order(), ['%1', '%2', '%3'], `untouched by ${JSON.stringify(body)}`);
  }
  assert.equal(pinOrderProblem([], []), null, 'an empty group in an empty order is fine');
  p.stop();
});

/* ---------------------------------------------------------------- pruning --- */

test('a pane that closed takes its pin with it', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { paneCreatedMs: 500 });
  p.set('%2', true, { paneCreatedMs: 500 });
  p.prune(new Map([['%2', 500]]));
  assert.equal(p.has('%1'), false);
  assert.equal(p.has('%2'), true);
  p.stop();
});

/*
 * Same guard as the queue's, for the same reason: tmux hands out %0, %1, … afresh with
 * every new server, so an inherited pin would sit a stranger at the top of the rail.
 */
test('a pane id reused by a new tmux server does not inherit the pin', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { paneCreatedMs: 500 });
  p.prune(new Map([['%1', 9000]]));
  assert.equal(p.has('%1'), false);
  p.stop();
});

/*
 * The other half of that guard, at `set`: a relaunch that takes the whole tmux server down
 * gets `%0` back inside one roster poll, before `prune` has seen the old one go. Measured on
 * a scratch bench — the restarted session came back unpinned, because the dead pane's pin
 * made the re-pin a no-op and `prune` then dropped it for its birthday.
 */
test('re-pinning a reused pane id replaces the dead pane’s pin rather than deferring to it', () => {
  const p = new PinStore(tmpStore());
  p.set('%0', true, { paneCreatedMs: 500, now: 100 });
  assert.equal(p.set('%0', true, { paneCreatedMs: 9000, now: 900 }), true);
  p.prune(new Map([['%0', 9000]]));
  assert.equal(p.has('%0'), true, 'it survives the next prune');
  p.stop();
});

/*
 * And it goes to the bottom like any new pin, rather than inheriting the dead pane's place
 * by accident of the id: a Map keeps an existing key where it was. Where it really belongs
 * is the re-pin path's call, by name — `carryPinOrder` below.
 */
test('a pin replacing a dead pane’s goes to the bottom, not into the dead one’s place', () => {
  const p = new PinStore(tmpStore());
  p.set('%0', true, { paneCreatedMs: 500 });
  p.set('%1', true, { paneCreatedMs: 500 });
  p.set('%0', true, { paneCreatedMs: 9000 });
  assert.deepEqual(p.order(), ['%1', '%0']);
  p.stop();
});

test('re-pinning the same live pane still changes nothing', () => {
  const p = new PinStore(tmpStore());
  p.set('%0', true, { paneCreatedMs: 500, now: 100 });
  p.set('%1', true, { paneCreatedMs: 500 });
  assert.equal(p.set('%0', true, { paneCreatedMs: 500, now: 900 }), false);
  assert.deepEqual(p.order(), ['%0', '%1'], 'nor its place');
  p.stop();
});

test('the same pane, still alive, keeps its pin', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { paneCreatedMs: 500 });
  p.prune(new Map([['%1', 500]]));
  p.prune(new Map([['%1', 500]]));
  assert.equal(p.has('%1'), true);
  p.stop();
});

/* ------------------------------------------------------------- persistence --- */

test('pins survive the process that made them', () => {
  const file = tmpStore();
  const p = new PinStore(file);
  p.set('%1', true, { now: 100, paneCreatedMs: 500 });
  p.flush();
  p.stop();

  const reopened = new PinStore(file);
  assert.equal(reopened.has('%1'), true);
  reopened.stop();
});

test('the order survives a restart of the panel', () => {
  const file = tmpStore();
  const p = new PinStore(file);
  for (const id of ['%1', '%2', '%3']) p.set(id, true, { paneCreatedMs: 500 });
  p.reorder(['%3', '%1', '%2']);
  p.stop();

  const reopened = new PinStore(file);
  assert.deepEqual(reopened.order(), ['%3', '%1', '%2']);
  reopened.stop();
});

/*
 * Rollback, both directions. A build from before the order existed requires a numeric `at`
 * and sorts by it, so `at` is still written; and a file it wrote has no `order` at all, which
 * this build reads in pin-time order — the order the rail used to draw.
 */
test('the file stays readable by a build without the order, and is read from one', () => {
  const file = tmpStore();
  const p = new PinStore(file);
  p.set('%1', true, { now: 100 });
  p.set('%2', true, { now: 200 });
  p.reorder(['%2', '%1']);
  p.stop();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof raw['%1'].at, 'number');
  assert.equal(typeof raw['%2'].at, 'number');
  assert.deepEqual([raw['%2'].order, raw['%1'].order], [0, 1]);

  const old = tmpStore();
  fs.writeFileSync(
    old,
    JSON.stringify({ '%5': { at: 300, paneCreatedMs: 1 }, '%4': { at: 100, paneCreatedMs: 1 } }),
  );
  const fromOld = new PinStore(old);
  assert.deepEqual(fromOld.order(), ['%4', '%5'], 'pin time, oldest on top');
  fromOld.stop();
});

/* ------------------------------------------------------------ carry-over --- */

/*
 * A relaunch exits every session and starts it again on a new pane — numbered from `%0`
 * when the tmux server went down with the bench — and each re-pin lands at the bottom, the
 * lead first because `launchLead` pins it mid-loop. Session names survive; pane ids don't.
 */
test('a relaunch puts every pin back where its name was', () => {
  const wanted = ['p-beta', 'p-alpha-lead', 'p-gamma', 'p-alpha'];
  // Relaunch order, which is roster order, with the lead pinned from birth first.
  const current = [
    { paneId: '%0', name: 'p-alpha-lead' },
    { paneId: '%1', name: 'p-beta' },
    { paneId: '%2', name: 'p-gamma' },
    { paneId: '%3', name: 'p-alpha' },
  ];
  const moved = new Set(['%0', '%1', '%2', '%3']);
  assert.deepEqual(carryPinOrder(wanted, current, moved), ['%1', '%0', '%2', '%3']);
});

test('a pin the run did not make is an anchor, and the moved ones settle round it', () => {
  // Restart-one: only beta came back; everything else kept its pane and its place.
  const wanted = ['p-alpha', 'p-beta', 'p-gamma'];
  const current = [
    { paneId: '%4', name: 'p-alpha' },
    { paneId: '%6', name: 'p-gamma' },
    { paneId: '%9', name: 'p-beta' },
  ];
  assert.deepEqual(carryPinOrder(wanted, current, new Set(['%9'])), ['%4', '%9', '%6']);

  // Moved to the top: nothing came before it, so it goes above the first that came after.
  assert.deepEqual(
    carryPinOrder(['p-beta', 'p-alpha', 'p-gamma'], current, new Set(['%9'])),
    ['%9', '%4', '%6'],
  );
});

test('a restore never moves a live pin the maintainer has rearranged since the save', () => {
  // Saved as alpha, beta, gamma, delta; since rearranged to delta, alpha, beta; gamma restored.
  const wanted = ['p-alpha', 'p-beta', 'p-gamma', 'p-delta'];
  const current = [
    { paneId: '%3', name: 'p-delta' },
    { paneId: '%1', name: 'p-alpha' },
    { paneId: '%2', name: 'p-beta' },
    { paneId: '%7', name: 'p-gamma' },
  ];
  assert.deepEqual(carryPinOrder(wanted, current, new Set(['%7'])), ['%3', '%1', '%2', '%7']);
  assert.deepEqual(carryPinOrder(wanted, current, new Set()), ['%3', '%1', '%2', '%7'], 'nothing made, nothing moved');
});

test('a re-pin whose name was never in the group stays at the bottom, and nothing is lost', () => {
  const wanted = ['p-alpha', null, 'p-beta'];
  const current = [
    { paneId: '%0', name: 'p-lead' }, // pinned from birth, had been unpinned
    { paneId: '%1', name: 'p-beta' },
    { paneId: '%2', name: null },
    { paneId: '%3', name: 'p-alpha' },
  ];
  const out = carryPinOrder(wanted, current, new Set(['%0', '%1', '%2', '%3']));
  assert.deepEqual(out, ['%3', '%1', '%0', '%2']);
  assert.equal(new Set(out).size, current.length);
});

/*
 * End to end through the store, the way `relaunchBench` drives it: the order read by name
 * before the exits, the dead pins pruned, the new ones set in launch order, then carried.
 */
test('carry-over by name through the store: the group comes back as it was', () => {
  const p = new PinStore(tmpStore());
  const names = { '%3': 'p-alpha', '%5': 'p-beta', '%8': 'p-lead' };
  for (const id of ['%3', '%5', '%8']) p.set(id, true, { paneCreatedMs: 500 });
  p.reorder(['%8', '%5', '%3']);
  const wanted = p.order().map((id) => names[id]);

  p.prune(new Map()); // the server went down with the bench… (an empty map: every pane gone)
  p.set('%0', true, { paneCreatedMs: 900 }); // lead, from birth
  p.set('%1', true, { paneCreatedMs: 900 });
  p.set('%2', true, { paneCreatedMs: 900 });
  const startedAs = new Map([['%0', 'p-lead'], ['%1', 'p-alpha'], ['%2', 'p-beta']]);
  const current = p.order().map((paneId) => ({ paneId, name: startedAs.get(paneId) }));
  assert.deepEqual(p.reorder(carryPinOrder(wanted, current, new Set(startedAs.keys()))), { changed: true });
  assert.deepEqual(p.order(), ['%0', '%2', '%1']);
  p.stop();
});

test('a hand-mangled store starts clean instead of throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, '{ not json at all');
  const p = new PinStore(file);
  assert.equal(p.has('%1'), false);
  p.stop();
});
