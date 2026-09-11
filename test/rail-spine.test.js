import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GROUP_COLOUR_COUNT } from '../web/group-hue.js';

/*
 * The rail's coloured spine — item 2 of the rail redesign.
 *
 * Nothing here renders anything, and what it pins is the handful of facts about a spine
 * that come apart **silently**. A hue set on two of the three sibling kinds instead of
 * three leaves a spine with a gap in it that still looks like a design. A selected row
 * whose marker goes back to `var(--accent)` still draws a marker — the wrong one, inside a
 * group, which is exactly the two-signals-instead-of-three state `--row-open` was measured
 * to get out of. A second `--spine` declaration, or a figure changed in one of them, leaves
 * a rail that renders perfectly and no longer means what its comment says. And a
 * `padding-left` that stops giving back the 3px its border takes moves every heading in a
 * group sideways by three pixels, which nobody reads as a bug.
 *
 * What a spine *looks* like is a pair of eyes and a measurement off the DOM; both are in
 * the report.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const tokens = text('web/tokens.css');

/** One CSS rule by its exact selector, braces and all. */
const rule = (selector) => {
  const i = styles.indexOf(`${selector} {`);
  assert.ok(i >= 0, `\`${selector} {\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/** One function body out of `web/app.js`, by balancing braces from its declaration. */
const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `\`${name}\` must exist in web/app.js`);
  const i = app.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < app.length; j += 1) {
    if (app[j] === '{') depth += 1;
    else if (app[j] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/* ------------------------------------------------------------------ JS --- */

test('the hue is spelled by `hueVar`, never as a `--group-N` string in the rail', () => {
  assert.match(app, /^import \{[^}]*\bhueVar\b[^}]*\} from '\.\/group-hue\.js';$/m);
  assert.ok(
    !/['"`]--group-\d/.test(app),
    'web/app.js must not spell a group token itself — the ring is `web/group-hue.js`',
  );
});

test('every sibling kind a group owns wears `--h`, because the rail has no container', () => {
  const rail = fn('renderRail');
  const sets = rail.match(/setProperty\('--h'/g) || [];
  assert.equal(sets.length, 1, 'one place sets it; a helper the three call sites share');

  // The header, the folder headings and the rows — all three, and all three inside the
  // group loop. A spine missing any one of them has a gap in it and still looks designed.
  const loop = rail.indexOf('for (const g of state.groups)');
  assert.ok(loop >= 0, 'the group loop must exist');
  const ungrouped = rail.indexOf('for (const [folder, list] of folders)');
  assert.ok(ungrouped > loop, 'the ungrouped-folder loop follows the group loop');
  const body = rail.slice(loop, ungrouped);
  assert.match(body, /wear\(groupHeader\(/, 'the group header');
  assert.match(body, /wear\(folderHeading\(/, 'its folder headings');
  assert.match(body, /wear\(row\)/, 'its rows, nested workers included');
  assert.match(body, /setProperty\('--h'/, 'and the setter itself lives in here');
});

test('pinned rows, the inbox and ungrouped folders are given no hue at all', () => {
  // Not an assertion about a branch — there is deliberately no branch. They never pass
  // through the group loop, so `var(--h, var(--accent))` keeps their marker on the accent.
  const rail = fn('renderRail');
  const loop = rail.indexOf('for (const g of state.groups)');
  assert.ok(!/setProperty\('--h'/.test(rail.slice(0, loop)), 'nothing above the group loop sets it');
  const ungrouped = rail.indexOf('for (const [folder, list] of folders)');
  assert.ok(!/setProperty\('--h'/.test(rail.slice(ungrouped)), 'and nothing below it does');
});

test('a record whose colour is not a slot is not painted `var(--group-undefined)`', () => {
  const rail = fn('renderRail');
  assert.match(rail, /isGroupColour\(g\.colour\)\s*\?\s*hueVar\(g\.colour\)\s*:\s*null/);
  assert.match(app, /^import \{[^}]*\bisGroupColour\b[^}]*\} from '\.\/group-hue\.js';$/m);
});

/* ----------------------------------------------------------------- CSS --- */

test('the reduced mix is declared once, for all three sibling kinds', () => {
  const spine = (styles.match(/--spine:/g) || []).length;
  assert.equal(spine, 1, 'one declaration — two would be one figure that can drift');

  // One rule listing all three, so the mix cannot be set on two of them and missed on the
  // third — which would leave a spine with a gap in it that still looks like a design.
  const i = styles.indexOf('.shelf-label,\n.folder-label.in-group,\n.session-row.in-group {');
  assert.ok(i >= 0, 'the three sibling kinds must share one declaration block');
  assert.match(
    styles.slice(i, styles.indexOf('}', i) + 1),
    /--spine: color-mix\(in srgb, var\(--h, var\(--accent\)\) 50%, transparent\);/,
  );
});

test('the figure is documented beside itself, the way --row-open and --band-head are', () => {
  const i = styles.indexOf('--spine:');
  const comment = styles.slice(Math.max(0, i - 2600), i);
  assert.match(comment, /50%/, 'the mix says what it is');
  assert.match(comment, /49\.5%/, 'and where the balance point it sits on was measured');
  for (const ground of ['--surface', '--shelf', '--surface-sunk']) {
    assert.ok(comment.includes(ground), `the numbers cover ${ground}`);
  }
  assert.match(comment, /marker vs spine/, 'and the step the marker keeps over it');
  // Both themes, or half the measurement is missing.
  assert.match(comment, /Light theme/);
  assert.match(comment, /Dark theme/);
  // The tokens the figures are computed from still exist to be mixed.
  assert.match(tokens, /--row-open: color-mix\(in srgb, var\(--accent\) 22%/);
  assert.match(tokens, /--shelf: color-mix\(in srgb, var\(--ink\) 4%/);
});

test('the selected row takes the hue at full strength, and falls back to the accent', () => {
  assert.match(rule('.session-row.is-open'), /border-left-color: var\(--h, var\(--accent\)\);/);
  // …and it still wins over the reduced spine, which is a matter of source order here:
  // both selectors weigh the same, so the later one is the one that draws.
  const inGroup = styles.indexOf('.session-row.in-group {');
  const isOpen = styles.indexOf('.session-row.is-open {');
  assert.ok(inGroup >= 0 && isOpen > inGroup, 'the marker rule must come after the spine rule');
  assert.match(rule('.session-row.in-group'), /border-left-color: var\(--spine\);/);
});

test('the spine is a colour, never a width — the rail must not step sideways', () => {
  assert.match(rule('.session-row'), /border-left: 3px solid transparent;/);
  for (const selector of ['.shelf-label', '.folder-label.in-group']) {
    assert.match(rule(selector), /border-left: 3px solid var\(--spine\);/, selector);
  }
  // Nothing anywhere grows it on a state.
  const open = rule('.session-row.is-open');
  assert.ok(!/border-left-width|border-left: /.test(open), 'the selected row changes colour only');
});

test('the headings give back exactly the 3px their border takes', () => {
  // Their left borders then land on the same x as the rows', which is what makes the spine
  // continuous, and nothing they contain moves.
  assert.match(rule('.shelf-label'), /padding-left: calc\(1\.1rem - 3px\);/);
  assert.match(rule('.folder-label.in-group'), /padding-left: calc\(1\.9rem - 3px\);/);
  // 1.1rem is the shorthand the group heading inherits from `.group-label`, so the calc
  // above gives back exactly what the border took — change one and this says so.
  assert.match(rule('.group-label'), /padding: 1\.1rem 1\.1rem 0\.4rem;/);
});

test('a collapsed group keeps its spine, so a folded block still has a boundary', () => {
  // `.shelf-label` and not `.shelf-label:not(.collapsed)` — the tint drops when a group
  // folds, and without this the folded header would read as part of whatever is under it.
  assert.match(rule('.shelf-label'), /border-left: 3px solid var\(--spine\);/);
  assert.ok(
    !/\.shelf-label:not\(\.collapsed\)[^{]*\{[^}]*border-left/.test(styles),
    'the spine must not be gated on the group being open',
  );
});

test('the worker nesting hairline stays on the accent', () => {
  // It says "belongs to that lead", which is a different fact from "is in that group";
  // hueing it would make one signal say two things.
  assert.match(
    rule('.session-row.worker-row::before'),
    /background: color-mix\(in srgb, var\(--accent\) 35%, transparent\);/,
  );
});

test('the ring the spine draws from is still the ten the tokens hold', () => {
  for (let n = 1; n <= GROUP_COLOUR_COUNT; n += 1) {
    assert.ok(tokens.includes(`--group-${n}:`), `--group-${n} must exist`);
  }
});
