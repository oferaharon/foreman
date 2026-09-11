import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GROUP_COLOUR_COUNT } from '../web/group-hue.js';
import { eligibleFolders, knownFolders, matchesFilter } from '../web/group-folders.js';

/*
 * The group header's `+` and `⋯` — item 4 of the rail redesign.
 *
 * Two halves, the same shape `test/rail-fold.test.js` one item over uses. The first runs
 * `web/group-folders.js` in node: plain objects in, plain strings out, no DOM. What it pins
 * is the two ways the eligibility rule comes apart **while still rendering a menu that looks
 * designed** — a list built from the live sessions alone quietly loses every folder that is
 * filed but idle, and a list that forgets to subtract the group's own folders offers picks
 * that do nothing, which reads as a click that missed.
 *
 * The second half is a source scan over what is structural rather than computed: that the
 * two new kinds live *inside* `openMenu` (its placement, its dismiss-on-pointerdown, its
 * Escape and its detached-anchor guard are already right, and a second popover would have to
 * re-earn all four), that the swatch count is the ring's own number rather than a literal,
 * that a swatch is a named button rather than a coloured `div`, that the destructive item
 * keeps the bottom of the `⋯` menu, and that the header's pair is visible at rest.
 *
 * What the menus *look* like is a pair of eyes and a measurement off the DOM; both are in
 * the report, in dark only per the standing ruling.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');

/** One CSS rule by its exact selector, braces and all. */
const rule = (selector) => {
  const i = styles.indexOf(`${selector} {`);
  assert.ok(i >= 0, `\`${selector} {\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/**
 * One function body out of `web/app.js`, by balancing braces from its declaration.
 *
 * The parameter list is walked first, by parens, and only then is the body's opening brace
 * taken — `openMenu(anchor, items, { onDismiss } = {})` destructures in its signature, so
 * "the first `{` after the name" is a brace that closes two characters later and hands back
 * a fragment that matches nothing. It fails as an empty string rather than as an error,
 * which is how a source scan comes to assert nothing at all while staying green.
 */
const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `\`${name}\` must exist in web/app.js`);
  let j = app.indexOf('(', start);
  let parens = 0;
  for (; j < app.length; j += 1) {
    if (app[j] === '(') parens += 1;
    else if (app[j] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  const i = app.indexOf('{', j);
  let depth = 0;
  for (let k = i; k < app.length; k += 1) {
    if (app[k] === '{') depth += 1;
    else if (app[k] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, k + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/* ------------------------------------------------------------ fixtures --- */

/** A roster row, shaped as `server/sessions.js` builds one. Sandbox projects only. */
const row = (project) => ({ id: `sess-${project}`, title: `${project}-main`, project });

const group = (id, name, folders) => ({ id, name, folders, colour: 1, collapsed: false });

/* ------------------------------------------------- the eligibility rule --- */

test('the list is the union of what is running and what is filed', () => {
  /*
   * Neither source alone is enough, and each misses a different everyday folder. The
   * sessions miss `beta`, which somebody filed this morning and which has nothing running in
   * it now; the groups miss `gamma`, which is running and ungrouped — the common case, since
   * an ungrouped folder is exactly what the `+` is reached for.
   */
  const sessions = [row('alpha'), row('gamma')];
  const groups = [group('g1', 'Platform', ['alpha', 'beta'])];
  assert.deepEqual(knownFolders(sessions, groups).sort(), ['alpha', 'beta', 'gamma']);
});

test("a group's own folders are excluded — a pick that does nothing reads as a missed click", () => {
  const sessions = [row('alpha'), row('beta'), row('gamma')];
  const groups = [group('g1', 'Platform', ['alpha'])];
  assert.deepEqual(eligibleFolders(sessions, groups, 'g1'), ['beta', 'gamma']);
});

test('a folder filed in another group stays on offer, because assign moves it', () => {
  // A folder is in exactly one group (`server/groups.js`'s `assign` enforces it), so picking
  // one from elsewhere is a move rather than a copy. Hiding it would make the `+` unable to
  // do the one thing the folder `▾` can already do from the other end.
  const groups = [group('g1', 'Platform', ['alpha']), group('g2', 'Archive', ['beta'])];
  assert.deepEqual(eligibleFolders([], groups, 'g1'), ['beta']);
});

test('the order is alphabetical, case-insensitively, and does not depend on Set insertion', () => {
  const sessions = [row('gamma'), row('Alpha'), row('beta')];
  assert.deepEqual(eligibleFolders(sessions, [], null), ['Alpha', 'beta', 'gamma']);
});

test('an unknown group excludes nothing, which is the safe direction', () => {
  // A group deleted under an open menu, say. An over-full list costs one no-op pick; a list
  // that silently emptied itself would read as "there is nothing to add".
  const sessions = [row('alpha')];
  assert.deepEqual(eligibleFolders(sessions, [group('g1', 'Platform', ['alpha'])], 'gone'), [
    'alpha',
  ]);
});

test('junk in a roster frame is dropped rather than drawn', () => {
  const sessions = [row('alpha'), { project: '  ' }, { project: null }, {}];
  const groups = [{ id: 'g1', name: 'Platform', folders: ['  beta  ', '', null] }];
  assert.deepEqual(eligibleFolders(sessions, groups, null), ['alpha', 'beta']);
});

test('nothing eligible answers an empty list, which is the menu’s note', () => {
  const groups = [group('g1', 'Platform', ['alpha'])];
  assert.deepEqual(eligibleFolders([row('alpha')], groups, 'g1'), []);
});

/* -------------------------------------------------------- the filter --- */

test('the filter is a case-insensitive substring, and an empty box hides nothing', () => {
  assert.equal(matchesFilter('alpha', 'LP'), true);
  assert.equal(matchesFilter('Alpha', 'alp'), true);
  assert.equal(matchesFilter('alpha', ''), true);
  assert.equal(matchesFilter('alpha', '   '), true);
  assert.equal(matchesFilter('alpha', 'beta'), false);
});

/* ------------------------------------------------------------------ JS --- */

test('both new kinds live inside `openMenu`, not in a second popover', () => {
  // Placement off the anchor's rect, dismiss on pointerdown, Escape, and the detached-anchor
  // guard are all already here and all already right. A second popover would have to earn
  // every one of them again, and the one it forgot would be the one that mattered.
  const menu = fn('openMenu');
  assert.match(menu, /if \(item\.filter\)/, 'the filter box');
  assert.match(menu, /if \(item\.swatches\)/, 'the swatch row');
  assert.ok(
    !/function openGroupAddPopover|document\.body\.append\(pop/.test(app),
    'no hand-rolled second popover',
  );
});

test('the filter hides rather than removes, and nothing about it submits', () => {
  const menu = fn('openMenu');
  assert.match(menu, /node\.hidden = !matchesFilter\(label, q\)/, 'hidden, so clearing brings it back');
  assert.match(app, /^import \{[^}]*\bmatchesFilter\b[^}]*\} from '\.\/group-folders\.js';$/m);
  // Not a form: Enter in a filter box must not pick whatever happens to be first.
  const i = menu.indexOf('if (item.filter)');
  const branch = menu.slice(i, menu.indexOf('if (item.swatches)'));
  assert.ok(!/createElement\('form'\)|onsubmit/.test(branch), 'the filter is not a form');
  assert.match(branch, /className = 'menu-filter'/);
});

test('the labels the filter decides over are the caller’s, not the built node’s text', () => {
  // A built item's `textContent` carries the tick column and any `hint` welded onto it, so a
  // filter read back off the DOM would match on a word nobody typed.
  const menu = fn('openMenu');
  assert.match(menu, /filterable\.push\(\{ node: btn, label: item\.label \}\)/);
});

test('the swatch row is `GROUP_COLOUR_COUNT` wide, never a literal', () => {
  const menu = fn('openMenu');
  assert.match(menu, /n <= GROUP_COLOUR_COUNT/, 'the ring bounds its own row');
  assert.match(app, /^import \{[^}]*\bGROUP_COLOUR_COUNT\b[^}]*\} from '\.\/group-hue\.js';$/m);
  const i = menu.indexOf('if (item.swatches)');
  const branch = menu.slice(i, menu.indexOf('el.append(rowEl);'));
  assert.ok(
    !new RegExp(`\\b${GROUP_COLOUR_COUNT}\\b`).test(branch),
    'the count must not also be spelled as a number here',
  );
  // …and the hue still goes through `hueVar`, so no `--group-N` is spelled in web/app.js.
  assert.match(branch, /setProperty\('--h', hueVar\(n\)\)/);
  assert.ok(!/['"`]--group-\d/.test(app), 'the ring is spelled in web/group-hue.js and nowhere else');
});

test('a swatch is a named button, reachable by keyboard', () => {
  // Ten `div`s would be ten controls a keyboard cannot reach and a screen reader cannot name
  // — and a circle has no text of its own to fall back on.
  const menu = fn('openMenu');
  const i = menu.indexOf('if (item.swatches)');
  const branch = menu.slice(i, menu.indexOf('el.append(rowEl);'));
  assert.match(branch, /createElement\('button'\)/);
  assert.match(branch, /setAttribute\('aria-label', `colour \$\{n\}`\)/);
  assert.match(branch, /item\.onPick\(n\)/);
});

test('the `+` offers what the browser knows, less what the group already holds', () => {
  const add = fn('openGroupAddMenu');
  assert.match(add, /eligibleFolders\(state\.sessions, state\.groups, g\.id\)/);
  assert.match(app, /^import \{[^}]*\beligibleFolders\b[^}]*\} from '\.\/group-folders\.js';$/m);
  // One `assign` per pick — the same endpoint and the same semantics as the folder's own `▾`.
  assert.match(add, /assignFolder\(folder, g\.id\)/);
  // The empty state is a note, not an endpoint that walks the disk.
  assert.match(add, /if \(!folders\.length\)/);
  assert.match(add, /note: `Nothing left to add/);
  assert.ok(
    !/\/api\/folders|readdir|listFolders/.test(app),
    'no endpoint was added to enumerate folders on disk',
  );
  // And a filter box, or a long list is a scroll.
  assert.match(add, /\{ filter: \{ placeholder: 'Search folders…' \} \}/);
});

test('a folder being moved out of another group says so', () => {
  // `assign` moves rather than copies, so a pick can empty another group's block. The hint is
  // what stops that being something the panel did and the reader did not read.
  const add = fn('openGroupAddMenu');
  assert.match(add, /hint: from \? `from \$\{from\.name\}` : ''/);
});

test('the `⋯` menu’s swatch row sits above the delete, behind the rule', () => {
  const menu = fn('openGroupMenu');
  const input = menu.indexOf('input:');
  const swatches = menu.indexOf('swatches:');
  const separator = menu.indexOf('separator:');
  const del = menu.indexOf("label: 'Delete group'");
  assert.ok(input >= 0 && swatches > input, 'the rename keeps the top');
  assert.ok(separator > swatches, 'the rule comes after the swatches');
  assert.ok(del > separator, 'and the one destructive item keeps the bottom, behind it');
  assert.match(menu, /confirm: 'Really delete\?'/, 'still confirming');
  assert.match(menu, /value: g\.colour/, 'the current slot is the one that is ringed');
});

test('a swatch pick is one PATCH and paints nothing locally first', () => {
  // `groupApi` adopts the groups the response carries and repaints from those. Painting the
  // new hue ahead of the answer would leave a colour on screen that is not on disk, since
  // `setColour` is the only validator and a bad slot is a 400.
  const set = app.slice(app.indexOf('const setGroupColour'), app.indexOf('function openGroupMenu'));
  assert.match(set, /method: 'PATCH', body: JSON\.stringify\(\{ colour \}\)/);
  assert.ok(
    !/g\.colour = colour/.test(app),
    'nothing assigns the colour to the record before the server answers',
  );
});

test('the header draws both controls, and neither folds the group it sits on', () => {
  const header = fn('groupHeader');
  assert.match(header, /add\.textContent = '\+'/);
  assert.match(header, /menu\.textContent = '⋯'/);
  assert.match(header, /openGroupAddMenu\(add, g\)/);
  assert.match(header, /openGroupMenu\(menu, g\)/);
  // Both are inside the heading, which is itself the collapse toggle's row.
  const stops = (header.match(/e\.stopPropagation\(\)/g) || []).length;
  assert.equal(stops, 2, 'both controls stop propagation, or a click folds the group');
  // Named for a screen reader: `+` and `⋯` are not words.
  assert.match(header, /add\.setAttribute\('aria-label', `Add a folder to \$\{g\.name\}`\)/);
  assert.match(header, /menu\.setAttribute\('aria-label', `Rename, recolour or delete \$\{g\.name\}`\)/);
});

/* ----------------------------------------------------------------- CSS --- */

test('the header’s pair is visible at rest, and full on hover or focus-within', () => {
  assert.match(rule('.shelf-label .label-menu'), /opacity: 0\.4;/);
  // Both controls carry one class, so 40% covers the pair rather than one of them.
  const i = styles.indexOf('.group-label:hover .label-menu,');
  assert.ok(i >= 0, 'the hover rule must exist');
  const full = styles.slice(i, styles.indexOf('}', i) + 1);
  assert.match(full, /\.shelf-label:focus-within \.label-menu/, 'tabbing to either brings up both');
  assert.match(full, /opacity: 1;/);
  // The 40% declaration comes first, so the `opacity: 1` rules of equal weight win.
  assert.ok(styles.indexOf('.shelf-label .label-menu {') < i, 'the 40% rule is declared above');
  // The folder heading's own `▾` is untouched: it files the folder you are already pointing at.
  assert.match(rule('.label-menu'), /opacity: 0;/);
});

test('the reserved column is unchanged, so the second control costs width and not height', () => {
  // `.folder-label.in-group`'s sticky `top` is hand-measured against `.shelf-label`'s height.
  assert.match(rule('.label-menu'), /width: 1\.1rem;/);
  assert.match(rule('.folder-label.in-group'), /top: 2\.5rem;/);
});

test('the new CSS is tokens only — no hex anywhere in it', () => {
  for (const selector of ['.menu-filter', '.menu-swatches', '.menu-swatch', '.shelf-label .label-menu']) {
    assert.ok(!/#[0-9a-fA-F]{3}/.test(rule(selector)), `${selector} must use tokens only`);
  }
  // The swatch takes its colour from `--h`, set inline from `hueVar` — never a token name here.
  assert.match(rule('.menu-swatch'), /background: var\(--h\);/);
  assert.ok(!/--group-\d/.test(styles), 'the ring lives in web/tokens.css, not the stylesheet');
});

test('a filtered-out item is actually off the screen, not merely marked hidden', () => {
  /*
   * `.menu-item` carries an unconditional `display: flex`, and an author rule beats the
   * `[hidden]` UA default at any specificity — so without this the filter marks items hidden
   * and every one of them stays exactly where it was. PR #138's bug one popover over
   * (`.files-grid`/`.files-list`), and it was caught here the same way: by reading a hidden
   * item's `offsetHeight` back off the bench — 45px — rather than by eye.
   *
   * Scoped to `.menu-item` rather than a blanket `[hidden] { display: none }`, which is
   * #138's own reasoning: a blanket override would have to be proven safe against every
   * other `hidden` toggle in this stylesheet.
   */
  assert.match(rule('.menu-item'), /display: flex;/, 'the author rule that makes this necessary');
  assert.match(rule('.menu-item[hidden]'), /display: none;/);
  const flex = styles.indexOf('.menu-item {');
  assert.ok(styles.indexOf('.menu-item[hidden] {') > flex, 'and it is declared after it');
  assert.ok(
    !/^\[hidden\]\s*\{/m.test(styles),
    'never a blanket override — #138 scoped its fix to the two containers that needed it',
  );
});

test('a swatch is a circle, and the current one is ringed rather than ticked', () => {
  // A tick drawn over a colour hides the colour it is about.
  assert.match(rule('.menu-swatch'), /border-radius: 50%;/);
  const i = styles.indexOf('.menu-swatch.is-current,');
  assert.ok(i >= 0, 'the current-slot ring must exist');
  assert.match(styles.slice(i, styles.indexOf('}', i) + 1), /box-shadow: 0 0 0 2px var\(--surface\)/);
});
