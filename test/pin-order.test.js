import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { byPinOrder, movedPinOrder, pinDropIndex } from '../web/pin-order.js';

/* --------------------------------------------------------- movedPinOrder --- */

test('a block moved down lands in front of the block the line was above', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(movedPinOrder(order, 0, 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(movedPinOrder(order, 0, 3), ['b', 'c', 'a', 'd']);
  assert.deepEqual(movedPinOrder(order, 1, 4), ['a', 'c', 'd', 'b'], 'the count is the end');
});

test('a block moved up lands in front of the block the line was above', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(movedPinOrder(order, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(movedPinOrder(order, 2, 1), ['a', 'c', 'b', 'd']);
});

/* A drop on a row's own place — the line just above it or just below it — is not a write. */
test('a drop where the block already is changes nothing', () => {
  const order = ['a', 'b', 'c'];
  for (let from = 0; from < order.length; from++) {
    assert.equal(movedPinOrder(order, from, from), null);
    assert.equal(movedPinOrder(order, from, from + 1), null);
  }
  assert.equal(movedPinOrder(['a'], 0, 0), null);
  assert.equal(movedPinOrder(['a'], 0, 1), null, 'a group of one has nowhere to go');
});

test('an index out of range is no move, never a thrown error or a lost pin', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(movedPinOrder(order, -1, 0), null);
  assert.equal(movedPinOrder(order, 3, 0), null);
  assert.equal(movedPinOrder(order, 0, -1), null, '↑ on the top row');
  assert.equal(movedPinOrder(order, 2, 4), null, '↓ on the bottom row');
  assert.equal(movedPinOrder(order, 0, 1.5), null);
  assert.equal(movedPinOrder(null, 0, 1), null);
  assert.deepEqual(order, ['a', 'b', 'c'], 'and the input is never touched');
});

test('every move keeps every pin, once', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  for (let from = 0; from < order.length; from++) {
    for (let t = 0; t <= order.length; t++) {
      const next = movedPinOrder(order, from, t);
      if (!next) continue;
      assert.deepEqual([...next].sort(), order);
    }
  }
});

/* ----------------------------------------------------------- pinDropIndex --- */

test('the drop point is in front of the first block whose middle is below the pointer', () => {
  // Two plain rows and a lead with two workers: the lead's block is measured whole.
  const blocks = [
    { top: 100, bottom: 140 },
    { top: 140, bottom: 180 },
    { top: 180, bottom: 300 },
  ];
  assert.equal(pinDropIndex(blocks, 90), 0);
  assert.equal(pinDropIndex(blocks, 119), 0);
  assert.equal(pinDropIndex(blocks, 121), 1);
  assert.equal(pinDropIndex(blocks, 200), 2, 'over the lead row itself');
  assert.equal(pinDropIndex(blocks, 280), 3, 'over its last worker: below the whole team, never inside it');
  assert.equal(pinDropIndex([], 50), 0);
});

/* ------------------------------------------------------------- byPinOrder --- */

test('the pinned group sorts by the server’s position, and a row without one sorts last', () => {
  const rows = [{ id: 'x', pinOrder: 2 }, { id: 'y' }, { id: 'z', pinOrder: 0 }, { id: 'w', pinOrder: 1 }];
  assert.deepEqual(rows.slice().sort(byPinOrder).map((r) => r.id), ['z', 'w', 'x', 'y']);
});

/* --------------------------------------------------- web/app.js, scanned --- */

/*
 * Source facts, pinned because each is a rule rather than a detail and the cheapest way to
 * undo any of them is a one-line edit that looks tidy. `web/app.js` reaches for `document`
 * at import time, so these are scans, the shape `test/files-new.test.js` uses.
 */
const appSrc = () => readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const fnBody = (src, head, next) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is still there`);
  return src.slice(at, src.indexOf(next, at + head.length));
};

test('the rail does not repaint under a drag, and the drop paints what it held back', () => {
  const src = appSrc();
  const rail = fnBody(src, 'function renderRail() {', 'const live = state.sessions.length;');
  assert.match(rail, /if \(pinDrag\) \{\s*pinDrag\.deferred = true;\s*return;/);
  const end = fnBody(src, 'function endPinDrag(e, drop) {', '\n}\n');
  assert.ok(end.includes('pinDrag = null;'), 'the drag is over before anything paints');
  assert.ok(end.includes('if (d.deferred) renderRail();'), 'a cancel catches up on what it held');
  // The in-flight state is module scope, for `duplicating`'s reason: rows are rebuilt.
  assert.match(src, /^let pinDrag = null;$/m);
});

test('the grip is the row’s sibling, never inside the row’s own button', () => {
  const src = appSrc();
  const rail = fnBody(src, 'function renderRail() {', '\nfunction ');
  // `rows[0]` is the `.session-row` wrapper `sessionRow` returns; its `.session` child is
  // the `div role="button"` that opens the session on click.
  assert.ok(rail.includes('rows[0].prepend(pinGrip(s));'));
  const grip = fnBody(src, 'function pinGrip(s) {', '\n}\n');
  assert.ok(grip.includes("document.createElement('button')"));
  assert.ok(!grip.includes('openSession'), 'a press on the grip opens nothing');
});

test('only a drop inside the group, to a new place, writes', () => {
  const src = appSrc();
  const end = fnBody(src, 'function endPinDrag(e, drop) {', '\n}\n');
  assert.match(end, /drop && d\.active && d\.target != null \? movedPinOrder\(/);
  // pointercancel and a lost capture are cancels, and so is Escape.
  const grip = fnBody(src, 'function pinGrip(s) {', '\n}\n');
  assert.ok(grip.includes("'pointercancel', (e) => endPinDrag(e, false)"));
  assert.ok(grip.includes("'lostpointercapture', (e) => endPinDrag(e, false)"));
  const esc = fnBody(src, 'function pinDragKey(e) {', '\n}\n');
  assert.ok(esc.includes('endPinDrag(null, false);'));
});
