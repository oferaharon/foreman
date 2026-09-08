import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { slateActive, slateButton, visibleEntries } from '../web/room-slate.js';

/*
 * What the team room draws when a slate is up.
 *
 * The module is pure on purpose — no DOM, no fetch, no storage — so the rule can be pinned
 * here rather than only in a browser, the way `web/notify.js` and `web/trust-gate.js` are.
 * The wiring in `web/app.js` decides *when* to repaint; everything below decides what a
 * paint contains, and those are the two halves that must not be confused: a bug in the
 * wiring is a room that repaints late, a bug here is a room that shows the wrong lines and
 * looks entirely fine doing it.
 *
 * The one thing worth restating, because it is the whole design: **nothing is deleted**.
 * The slate is a `seq` in `team.json` and `room.jsonl` is append-only; `show all` is the
 * same list with the pointer taken off. Every case below is about what is on screen, never
 * about what is on disk.
 */

/** A room, at the seqs a real one would have. */
const entries = [
  { seq: 1, kind: 'system', event: 'started', text: 'one' },
  { seq: 2, kind: 'status', from: 'worker-a', text: 'two' },
  { seq: 3, kind: 'system', event: 'clear', text: 'Room cleared' },
  { seq: 4, kind: 'status', from: 'worker-a', text: 'four' },
  { seq: 5, kind: 'system', event: 'clear', text: 'Room cleared' },
  { seq: 6, kind: 'status', from: 'worker-b', text: 'six' },
];

/* ------------------------------------------------------------ the flag --- */

test('a slate is a positive integer and nothing else', () => {
  assert.equal(slateActive(3), true);
  assert.equal(slateActive(1), true);
  // Each of these would be silent: `0` and `null` read as "show all" and are meant to, and
  // a string would compare against a seq without throwing and hide a room at random.
  for (const junk of [0, -1, 1.5, '3', null, undefined, NaN, {}, []]) {
    assert.equal(slateActive(junk), false, `${String(junk)} is not a slate`);
  }
});

/* --------------------------------------------------------- the filter --- */

test('no slate draws the whole log, and the same array', () => {
  assert.equal(visibleEntries(entries, null), entries, 'the no-slate path costs nothing');
  assert.equal(visibleEntries(entries, 0), entries);
  assert.equal(visibleEntries(entries, undefined), entries);
});

test('a slate starts the room at its own divider, which is drawn first', () => {
  const shown = visibleEntries(entries, 3);
  assert.deepEqual(shown.map((e) => e.seq), [3, 4, 5, 6]);
  // `>=`, never `>`. The first thing in a cleared room is the line saying it was cleared,
  // or the room starts mid-conversation with nothing explaining the gap.
  assert.equal(shown[0].event, 'clear', 'the divider is the first thing on screen');
});

test('a second clear needs no special case — the pointer moves and the first is history', () => {
  const shown = visibleEntries(entries, 5);
  assert.deepEqual(shown.map((e) => e.seq), [5, 6]);
  // …and `show all` puts both dividers back, in their places, with everything between them.
  assert.deepEqual(visibleEntries(entries, null).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
});

test('a slate past the end of the log draws nothing rather than everything', () => {
  // The beat between the divider being written and the append frame arriving. Empty is the
  // honest answer; falling back to the whole log would flash the history the press just
  // put away.
  assert.deepEqual(visibleEntries(entries, 99), []);
});

test('order is the log’s own — the filter never reorders and never moves the divider', () => {
  const shown = visibleEntries(entries, 3);
  assert.deepEqual(shown, entries.slice(2), 'a tail, byte for byte');
});

test('an entry with no usable seq is kept, not hidden', () => {
  // A shape this panel has not met. Hiding what you cannot classify is how a room quietly
  // stops showing something, and nothing on screen would say so.
  const odd = [{ text: 'no seq' }, { seq: '4', text: 'string seq' }, { seq: 4, text: 'four' }];
  assert.deepEqual(visibleEntries(odd, 4), odd);
});

test('a non-array is an empty room, not a throw', () => {
  assert.deepEqual(visibleEntries(undefined, 3), []);
  assert.deepEqual(visibleEntries(null, null), []);
});

/* --------------------------------------------------------- the button --- */

test('one button at a time, and its word is the state the room is in', () => {
  assert.equal(slateButton(null).label, 'clear');
  assert.equal(slateButton(null).action, 'clear');
  assert.equal(slateButton(12).label, 'show all');
  assert.equal(slateButton(12).action, 'show-all');
  // The action is the endpoint's own last segment, so the two cannot drift into a fetch
  // against a route that does not exist.
  for (const slate of [null, 12]) {
    assert.match(slateButton(slate).action, /^(clear|show-all)$/);
  }
});

test('both titles say the history is still there', () => {
  // The control must never read as a delete. `room.jsonl` is append-only and neither press
  // removes a line from it; the copy is the only thing that says so on screen.
  for (const slate of [null, 7]) {
    assert.match(slateButton(slate).title, /deleted|come back|Nothing was ever/i);
  }
});

/* ----------------------------------------------------------- the wiring --- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

test('the frame is named in the team room’s own family, and the client switches on it', () => {
  // A frame the client does not switch on is swallowed in silence — the `room_*` / `group_*`
  // naming trap. `room-slate` sits beside `room` and `room-append`; a `rooms-` or `slate-`
  // sibling would be one letter from the group rooms' frames.
  assert.match(app, /case 'room-slate':/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'), /send\(ws, 'room-slate',/);
});

test('the room draws the filtered list, never `roomView.entries` directly', () => {
  // `unseen` and `painted` count what is on screen. Counting the unfiltered log instead
  // would put "3 new below ↓" over lines the slate is holding back — a hint that cannot be
  // reached by scrolling.
  const body = app.match(/function renderRoom\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(body, /const shown = visibleEntries\(roomView\.entries, roomView\.slate\)/);
  assert.match(body, /for \(const e of shown\)/);
  assert.match(body, /roomView\.painted = shown\.length/);
  assert.doesNotMatch(body, /for \(const e of roomView\.entries\)/, 'the paint is the filtered list');
});

test('nothing about the slate joins `composerSig`', () => {
  // A message landing in a room must never take the textarea out from under whoever is
  // typing — and neither may a button in the room's own heading.
  const sig = app.match(/const composerSig = \(s\) =>[\s\S]*?\.join\('\|'\);/)[0];
  for (const word of ['slate', 'roomView']) {
    assert.ok(!sig.includes(word), `composerSig must not read ${word}`);
  }
});
