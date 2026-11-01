import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { filterFolders, hiddenWanting, inFilter, mergeFilteredOrder } from '../web/rail-filter.js';

/*
 * The rail narrowed to one group.
 *
 * Two halves, `test/group-summary.test.js`'s shape. The first runs the module: which rows
 * survive, what the clear toggle counts, and the pinned order a drag writes while some pins
 * are hidden — each of which is wrong in a way that renders perfectly. The second is a
 * source scan over what is structural in `renderRail` and the stylesheet: that pinned and
 * the inbox are cut too, that the stored collapse is never written, that the toggle's
 * `[hidden]` actually hides it, and that the group header's own pair is left as it was.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = text('web/app.js');
const styles = text('web/styles.css');
const html = text('web/index.html');

const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = app.indexOf('{', app.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
};

const groups = [
  { id: 'g1', name: 'Tools', folders: ['alpha', 'beta'] },
  { id: 'g2', name: 'Other', folders: ['gamma'] },
];
const row = (id, project, extra = {}) => ({ id, project, ...extra });
const wants = (s) => Boolean(s.needsYou) && !(s.team?.role === 'worker' && !s.team.stuck);

/* -------------------------------------------------------------- filterFolders --- */

test('no filter set is no filter', () => {
  assert.equal(filterFolders(groups, ''), null);
  assert.equal(filterFolders(groups, null), null);
  assert.equal(filterFolders(groups, undefined), null);
});

test("a filter answers the group's own folders", () => {
  assert.deepEqual([...filterFolders(groups, 'g1')].sort(), ['alpha', 'beta']);
  assert.deepEqual([...filterFolders(groups, 'g2')], ['gamma']);
});

test('a group that is gone answers null, which is the cue to clear it', () => {
  assert.equal(filterFolders(groups, 'g9'), null);
  assert.equal(filterFolders([], 'g1'), null);
  assert.equal(filterFolders(undefined, 'g1'), null);
});

test('a group with no folders filters to nothing rather than to everything', () => {
  const f = filterFolders([{ id: 'e', folders: [] }], 'e');
  assert.ok(f instanceof Set);
  assert.equal(f.size, 0);
  assert.equal(inFilter(row('a', 'alpha'), f), false);
});

/* ------------------------------------------------------------------ inFilter --- */

test('a row survives by its folder, sleepers included', () => {
  const f = filterFolders(groups, 'g1');
  assert.equal(inFilter(row('a', 'alpha'), f), true);
  assert.equal(inFilter(row('c', 'gamma'), f), false);
  assert.equal(inFilter(row('u', 'ungrouped'), f), false);
  assert.equal(inFilter({ asleep: true, name: 'x', project: 'beta' }, f), true);
  assert.equal(inFilter(null, f), false);
});

test('with no filter every row survives', () => {
  assert.equal(inFilter(row('c', 'gamma'), null), true);
  assert.equal(inFilter(row('u', 'ungrouped'), null), true);
});

/* -------------------------------------------------------------- hiddenWanting --- */

test('the count is the hidden sessions that want you, pinned ones included', () => {
  const f = filterFolders(groups, 'g1');
  const sessions = [
    row('a', 'alpha', { needsYou: true }), // in the group: on screen, not counted
    row('c', 'gamma', { needsYou: true }), // other group
    row('u', 'ungrouped', { needsYou: true, pinned: true }), // pinned elsewhere
    row('q', 'gamma'), // hidden but quiet
  ];
  assert.equal(hiddenWanting(sessions, f, wants), 2);
});

test('a quiet worker is not counted — the inbox would not have hoisted it either', () => {
  const f = filterFolders(groups, 'g1');
  const sessions = [
    row('w', 'gamma', { needsYou: true, team: { role: 'worker', stuck: false } }),
    row('s', 'gamma', { needsYou: true, team: { role: 'worker', stuck: true } }),
  ];
  assert.equal(hiddenWanting(sessions, f, wants), 1);
});

test('no filter hides nothing, so counts nothing', () => {
  assert.equal(hiddenWanting([row('c', 'gamma', { needsYou: true })], null, wants), 0);
  assert.equal(hiddenWanting(null, filterFolders(groups, 'g1'), wants), 0);
});

/* --------------------------------------------------------- mergeFilteredOrder --- */

test('unfiltered, the drawn order is the whole order', () => {
  assert.deepEqual(mergeFilteredOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('the drawn pins swap within their own slots and the hidden ones stay put', () => {
  // x and y are hidden; a and b are drawn and swapped.
  assert.deepEqual(mergeFilteredOrder(['x', 'a', 'y', 'b'], ['b', 'a']), ['x', 'b', 'y', 'a']);
  // Sleepers ride in the same key space.
  assert.deepEqual(
    mergeFilteredOrder(['asleep:n', '%1', '%2', 'asleep:m'], ['asleep:m', '%1']),
    ['asleep:n', 'asleep:m', '%2', '%1'],
  );
});

test('the answer always names every pin exactly once', () => {
  const full = ['x', 'a', 'y', 'b', 'z', 'c'];
  const out = mergeFilteredOrder(full, ['c', 'b', 'a']);
  assert.deepEqual([...out].sort(), [...full].sort());
  assert.equal(out.length, full.length);
});

test('a drawn list that does not agree with the pins writes nothing', () => {
  assert.equal(mergeFilteredOrder(['a', 'b'], ['a', 'q']), null, 'a key that is not pinned');
  assert.equal(mergeFilteredOrder(['a', 'b'], ['a', 'a']), null, 'a key twice');
  assert.equal(mergeFilteredOrder(['a', 'b'], null), null);
  assert.equal(mergeFilteredOrder(null, ['a']), null);
});

/* ---------------------------------------------------------------- source scan --- */

test('pinned, the inbox and the rest are all cut by the filter', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const pinned = pinnedRows\(sleepers\)\.filter\(shown\);/);
  assert.match(rail, /const inbox = state\.sessions\.filter\([^\n]*&& shown\(s\)\);/);
  assert.match(rail, /let rest = state\.sessions\.filter\([^\n]*&& shown\(s\)\);/);
  assert.match(rail, /sleepers\.filter\(\(s\) => !s\.pinned && shown\(s\)\)/);
  // A lead in another group must not collect workers it will never draw.
  assert.match(rail, /s\.isLead && !inInbox\.has\(s\.id\) && shown\(s\)/);
});

test('the count is taken with the inbox’s own rule, not a second spelling', () => {
  const rail = fn('renderRail');
  assert.match(rail, /hiddenWanting\(state\.sessions, filter, \(s\) => s\.needsYou && !quietWorker\(s\)\)/);
});

test('a stale filter clears only once a roster frame has arrived', () => {
  const rail = fn('renderRail');
  assert.match(rail, /if \(railFilter\.value && !filter && rosterSeen\) return void setRailFilter\(''\);/);
  assert.match(fn('handle'), /rosterSeen = true;/);
});

test('the filtered group draws open without writing its collapse', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const folded = g\.collapsed && !filtered;/);
  assert.match(rail, /if \(folded\) continue;/);
  assert.ok(!/setGroupCollapsed/.test(rail), 'the rail never writes a collapse');
  assert.ok(!/setGroupCollapsed|flatRail/.test(fn('setRailFilter')), 'letting go touches nothing else');
  const header = fn('groupHeader');
  assert.match(header, /if \(filtered\) \{\s*toggle\.setAttribute\('aria-disabled', 'true'\);/);
});

test('a drag or an arrow while filtered writes the whole order', () => {
  assert.match(fn('endPinDrag'), /const full = fullPinOrder\(next\);\s*if \(full\) return void savePinOrder\(full\);/);
  assert.match(fn('pinGrip'), /fullPinOrder\(movedPinOrder\(/);
  assert.match(fn('fullPinOrder'), /mergeFilteredOrder\(pinnedRows\(\)\.map\(pinKey\), visibleNext\)/);
});

test('the clear toggle is in the head beside `recent`, hidden by default, and its [hidden] hides', () => {
  const i = html.indexOf('id="railFilter"');
  const j = html.indexOf('id="flatRail"');
  assert.ok(i > 0 && j > i, 'drawn immediately before `recent`');
  assert.ok(!/<button[^>]*id="[a-zA-Z]+"[^>]*>/.test(html.slice(html.indexOf('</button>', i), j).replace(/<!--[\s\S]*?-->/g, '')), 'nothing between them');
  assert.match(html.slice(html.lastIndexOf('<button', i), i + 200), /\bhidden\b/);
  assert.match(styles, /\.rail-filter\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.rail-filter:not\(\[hidden\]\) \+ \.rail-toggle \{ margin-left: 0; \}/);
});

test('the header filter is its own function, so the `+`/`⋯` pair is untouched', () => {
  const header = fn('groupHeader');
  assert.match(header, /row\.append\(groupFilterButton\(g, filtered\)\);/);
  assert.equal((header.match(/e\.stopPropagation\(\)/g) || []).length, 2);
  const btn = fn('groupFilterButton');
  assert.match(btn, /className = `label-menu shelf-filter/);
  assert.match(btn, /e\.stopPropagation\(\)/);
  assert.match(btn, /setRailFilter\(on \? '' : g\.id\)/);
});
