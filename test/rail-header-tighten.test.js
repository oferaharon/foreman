import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The group header's own vertical padding, and the one number downstream of it.
 *
 * The header's `padding-top` predates the spine and the tint: it was blank rail above a
 * heading, and it read as the gap *between* two groups. Since both now start at the
 * header's top edge, the same padding sits inside the card and reads as a gap above the
 * name — which is what this tightens.
 *
 * What is worth a test is not the two figures, which are a judgement and are on screen for
 * anybody to disagree with. It is that **`.folder-label.in-group`'s sticky `top` is
 * downstream of them and breaks silently**: it is hand-measured against the header's
 * height, so a later change to either padding leaves a folder heading that pins with a band
 * of the scrolling list showing above it, or one that pins *inside* the header and eats its
 * name — and both of those render perfectly, on a screen nobody is scrolling at the time.
 * The arithmetic below fails the moment either padding moves without the offset following.
 *
 * `SHELF_NAME_LINE_PX` is the one figure here that cannot come out of the stylesheet: it is
 * the header's own line box, which falls out of `font-size`, the font and the rail's
 * `line-height`. Measured on the bench, dark, at 320px of rail — 19.95px, and the offset is
 * rounded up from the 33.55 that gives. A font change moves it, which is exactly the case
 * this should be re-measured for rather than quietly re-derived.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const styles = fs.readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');

/** One CSS rule by its exact selector, braces and all. */
const rule = (selector) => {
  const i = styles.indexOf(`${selector} {`);
  assert.ok(i >= 0, `\`${selector} {\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/** A `<length>` declaration in px. `rem` is 16px here, as it is in the browser. */
const px = (block, prop) => {
  const m = block.match(new RegExp(`^\\s*${prop}: ([0-9.]+)(rem|px);`, 'm'));
  assert.ok(m, `${prop} must be a plain length declaration`);
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
};

/** The header's name line, measured on the bench. Not derivable from the stylesheet. */
const SHELF_NAME_LINE_PX = 19.95;

test('the group header is tightened top and bottom', () => {
  const shelf = rule('.shelf-label');
  const top = px(shelf, 'padding-top');
  const bottom = px(shelf, 'padding-bottom');
  // The pre-existing 20px/8px read as a gap inside the card once the tint and the spine
  // started at the header's top edge. Both are smaller; the top is the one that was asked
  // about, and a card inset is nothing like 20px.
  assert.ok(top <= 10, `padding-top is a card inset, got ${top}px`);
  assert.ok(bottom < 8, `padding-bottom is tighter than it was, got ${bottom}px`);
  // The bottom matches the `.group-label` base the folder heading under it inherits, so the
  // two names keep one rhythm rather than two. `.folder-label.in-group` overrides only the
  // top, which is why this reads the shorthand rather than that rule.
  const base = rule('.group-label').match(/^\s*padding: [^;]*\s([0-9.]+rem);$/m);
  assert.ok(base, '`.group-label` must set its padding as a shorthand ending in the bottom');
  assert.equal(bottom, Number(base[1].replace('rem', '')) * 16);
});

test('the gap *between* groups is untouched — it is not the gap this is about', () => {
  const shelf = rule('.shelf-label');
  // Outside the tint and the spine, and the one vertical margin in this list that is
  // allowed to exist. See the tiling note above `.shelf-label:not(.collapsed)`.
  assert.match(shelf, /margin-top: 0\.5rem;/);
  assert.match(shelf, /border-top: 1px solid var\(--rule\);/);
  assert.match(
    styles,
    /\.rail-list > \.shelf-label:first-child \{ border-top: none; margin-top: 0; \}/,
  );
});

test('the sticky offset is the header’s measured height, and follows it', () => {
  const shelf = rule('.shelf-label');
  const height = px(shelf, 'padding-top') + SHELF_NAME_LINE_PX + px(shelf, 'padding-bottom');
  const top = px(rule('.folder-label.in-group'), 'top');
  // Within a pixel, and on the *inside*: an offset past the header's height leaves a band
  // of the scrolling list showing between the two pinned headings, while one inside it
  // lands on the header's blank `padding-bottom`, which this heading repaints in the same
  // tint with its own spine at the same x. A later header carries a 1px `border-top` the
  // first does not, so one `top` is never exactly both.
  assert.ok(
    top >= height - 1 && top <= height + 0.5,
    `sticky top ${top}px must match the header's ${height.toFixed(2)}px — re-measure it`,
  );
});

test('no vertical margin is added to anything the tint and the spine are tiled from', () => {
  // `.shelf-label`'s own `margin-top` is the one exception, asserted above; everything else
  // in the block must pay for its height in padding or the spine breaks where nobody looks.
  for (const selector of ['.folder-label.in-group', '.session-row.in-group', '.shelf-summary']) {
    assert.ok(!/margin(-top|-bottom)?: /.test(rule(selector)), `${selector} must carry no margin`);
  }
});
