import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The merge block stays inside the strip it is a row of.
 *
 * Nothing here renders anything — whether a block overflows is a browser, and the
 * measurements are in the commit that added this file. What a test can hold is the pair of
 * declarations those measurements rest on, which is exactly the pair that was one line
 * apart from being right for two days and looked correct in the diff the whole time.
 *
 * The defect, because a reader who only sees `min-width: 0` will read it as noise and
 * delete it: `.composer-above` became a **wrapping row** when the suggestion moved onto the
 * interrupt button's row, and the merge block was given `flex: 0 0 100%` to keep its own
 * line. In a row container an item's `min-width: auto` is a *content-based* minimum, and it
 * beats the basis — so the block is floored at its own min-content width, which is large
 * because `.merge-title` is `white-space: nowrap` and its min-content is therefore the whole
 * one-line brief. (`min-width: 0` on the title lets it shrink while it is being flexed and
 * says nothing about what it contributes when an ancestor is asked for an intrinsic size.)
 * `justify-content: flex-end` then decides which way the overflow goes: the block's right
 * edge stays on the composer's and the rest runs out to the left, over the transcript and
 * the rail. Measured on a scratch panel at a 1901px viewport, one review row: the strip
 * 832px at x=530, the block **1292px at x=70** — 260px of it under a 330px rail.
 *
 * Before that change the strip was a *column*, the block's main axis was vertical,
 * `min-width: auto` computed to 0 and there was nothing to floor it. So the two facts have
 * to be pinned together: the row-ness is what makes the floor apply, and the `min-width: 0`
 * is what removes it. Either one changing alone puts the block back over the rail.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const styles = fs.readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');

/** One rule's declaration block, by its exact selector. */
function ruleFor(selector) {
  const at = styles.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `\`styles.css\` must still carry a rule for \`${selector}\``);
  const open = styles.indexOf('{', at);
  const close = styles.indexOf('}', open);
  return styles.slice(open + 1, close);
}

test('the strip is a wrapping row that ends flush right — which is what sends an overflow left', () => {
  const strip = ruleFor('.composer-above');
  assert.match(strip, /flex-wrap:\s*wrap/, 'a column would put the suggestion back on a line of its own');
  assert.match(strip, /justify-content:\s*flex-end/);
  // The collapse the whole append-and-remove dance exists for. Nothing here may make the
  // block a permanent child, and nothing may give this selector a second home.
  assert.match(styles, /\.composer-above:empty\s*\{\s*display:\s*none;\s*\}/);
});

test('the full-width block declares `min-width: 0`, or `flex: 0 0 100%` is a promise it cannot keep', () => {
  const block = ruleFor('.composer-above.has-merge > .merge-queue');
  assert.match(block, /flex:\s*0\s+0\s+100%/);
  assert.match(block, /min-width:\s*0/);
});

test('the title is still the part that gives way, and is still what makes min-content large', () => {
  const title = ruleFor('.merge-title');
  assert.match(title, /white-space:\s*nowrap/);
  assert.match(title, /text-overflow:\s*ellipsis/);
  assert.match(title, /min-width:\s*0/);
});
