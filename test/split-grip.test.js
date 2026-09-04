import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The split's boundary, and the one number four files have to agree about.
 *
 * Nothing here is a rendered check — whether the grip lands on the line the two panes meet
 * at is a browser, and the report has the measurements. What a test can hold is the
 * contract those measurements rest on, which is spread across four files that cannot
 * import each other: `tokens.css` spells the default, `styles.css` reads it twice (the
 * grid's first track and the grip's own `left`), `index.html` carries the handle, and
 * `app.js` writes the number.
 *
 * The one that would break silently is the **default**. `--pane-a` is a *percentage* on
 * purpose: `50%` of the frame with the second pane taking `1fr` of the remainder is exactly
 * the `1fr 1fr` the split shipped with, so a reader who never drags sees what they saw
 * before this existed. Respell it as a length — 30rem, say — and the split quietly stops
 * being half and half for everyone who never touched it, on every window of a different
 * size, with nothing on screen to say so. Same family as `test/logs.test.js`: three
 * spellings of one fact in three languages, and only a test between them.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const tokens = text('web/tokens.css');
const styles = text('web/styles.css');
const html = text('web/index.html');
const app = text('web/app.js');

test('the split default is a percentage, so half and half costs nothing', () => {
  const match = tokens.match(/--pane-a:\s*([^;]+);/);
  assert.ok(match, '`tokens.css` must spell the default — a reset removes the property and this answers');
  assert.equal(match[1].trim(), '50%');
});

test('the grid track and the grip read the same variable, with no second default', () => {
  assert.match(styles, /\.app\.split \.main \{ grid-template-columns: var\(--pane-a\) 1fr; \}/);
  assert.match(styles, /left: calc\(var\(--pane-a\) - 3px\);/);
  // A `var(--pane-a, …)` fallback anywhere would be a second spelling of the default, and
  // the two readers could then disagree about where the boundary is.
  assert.doesNotMatch(styles, /var\(--pane-a,/);
});

test('the grip is the shared divider, inside the frame, and only in split view', () => {
  assert.match(html, /<main class="main" id="main">/);
  assert.match(html, /class="pane-grip grip-col split-grip"[\s\S]*?id="splitGrip"/);
  assert.match(html, /id="splitGrip"[\s\S]*?role="separator"/);
  assert.match(html, /id="splitGrip"[\s\S]*?aria-orientation="vertical"/);
  // Hidden by default, shown by `.app.split`, and hidden again where the boundary cannot
  // move — see `splitFits` in app.js.
  assert.match(styles, /\.app\.split \.split-grip \{ display: flex; \}/);
  assert.match(styles, /:root\.split-fixed \.app\.split \.split-grip \{ display: none; \}/);
});

test('the split rides the shared resizer, keyed to its own preference', () => {
  assert.match(app, /handle: el\.splitGrip/);
  assert.match(app, /storageKey: 'foreman\.paneWidth'/);
  assert.match(app, /setRootVar\('--pane-a'/);
  // The floor is one number in one place: nothing in the stylesheet may mirror it, or the
  // two can drift the way `--tasks-h` and `--room-h` once did.
  assert.match(app, /const PANE_MIN = (\d+);/);
  const floor = Number(app.match(/const PANE_MIN = (\d+);/)[1]);
  assert.ok(floor > 0);
  assert.doesNotMatch(styles, new RegExp(`\\.split-grip[^}]*${floor}rem`));
});

test('the rail re-clamps what it narrows', () => {
  // Dragging the rail changes the frame the two panes divide, and the split's ceiling is
  // measured against that frame. Measured before this line existed: a 680/470 split with
  // the rail taken to 40rem left the second pane at 150px.
  const rail = app.slice(app.indexOf("storageKey: 'foreman.railWidth'"));
  const body = rail.slice(0, rail.indexOf('});'));
  assert.match(body, /onMove: applyResizers/);
});
