import assert from 'node:assert/strict';
import test from 'node:test';

import { FILES_MAX_VH, filesModalHeight } from '../web/files-height.js';

/*
 * The files modal's height rule in plain Node — `web/files-height.js` is DOM-free for the
 * same reason `files-kinds.js` and `trust-gate.js` are.
 *
 * The numbers below are the shape `openFiles` really hands it: `content` is the content
 * region's `scrollHeight` (a grid of 7rem cells, so ~112px per row plus gaps), `head` is
 * the card minus that region (title, subtitle, filter bar, note, close row, padding and
 * borders — roughly 180px in the panel's own type) and `viewport` is `window.innerHeight`.
 */

const HEAD = 180;

test('a short list settles at exactly what it needs', () => {
  assert.equal(filesModalHeight(240, HEAD, 1000), 420);
});

test('a long list is capped at 80% of the viewport, head included', () => {
  // The cap is applied to the total, not to the content: the reader's 80% is 80% of the
  // box they can see.
  assert.equal(filesModalHeight(4000, HEAD, 1000), 800);
  assert.equal(filesModalHeight(4000, HEAD, 900), 720);
});

test('the cap is the boundary, and the smaller of the two always wins', () => {
  assert.equal(filesModalHeight(620, HEAD, 1000), 800);
  assert.equal(filesModalHeight(619, HEAD, 1000), 799);
  assert.equal(filesModalHeight(621, HEAD, 1000), 800);
});

test('FILES_MAX_VH is the share, and an explicit cap overrides it', () => {
  assert.equal(FILES_MAX_VH, 0.8);
  assert.equal(filesModalHeight(4000, HEAD, 1000, 0.5), 500);
});

test('fractions round up, so a settled card is never one pixel short of its own list', () => {
  // A layout height rounded *down* is a scrollbar on a list that fits.
  assert.equal(filesModalHeight(240.4, 180.3, 1000), 421);
  assert.equal(filesModalHeight(4000, HEAD, 1000.2), 801);
});

test('a resize re-clamp is the same call with the stored measurements', () => {
  // What `onResize` does: the content was measured once, only the viewport moved.
  const content = 4000;
  assert.equal(filesModalHeight(content, HEAD, 1000), 800);
  assert.equal(filesModalHeight(content, HEAD, 500), 400);
  // …and a window grown back does not exceed what the list originally wanted.
  assert.equal(filesModalHeight(300, HEAD, 4000), 480);
});

test('a measurement that has not happened is refused, never turned into a height', () => {
  // An inline `height: 0` on a modal is a modal nobody can close, so `null` means
  // "leave the card as CSS has it".
  assert.equal(filesModalHeight(0, 0, 1000), null);
  assert.equal(filesModalHeight(240, HEAD, 0), null);
  assert.equal(filesModalHeight(NaN, HEAD, 1000), null);
  assert.equal(filesModalHeight(240, NaN, 1000), null);
  assert.equal(filesModalHeight(240, HEAD, Infinity), null);
  assert.equal(filesModalHeight(undefined, HEAD, 1000), null);
  assert.equal(filesModalHeight('240', HEAD, 1000), null);
  assert.equal(filesModalHeight(240, HEAD, 1000, 0), null);
});

test('a negative measurement counts as nothing rather than shrinking the total', () => {
  // `head` is `card - region`; a sub-pixel layout could in principle answer -0.2, and a
  // head subtracted from the content would be a card shorter than its own chrome.
  assert.equal(filesModalHeight(240, -20, 1000), 240);
  assert.equal(filesModalHeight(-240, HEAD, 1000), 180);
});
