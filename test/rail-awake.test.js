import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { asleepItems, mergeByActivity, placePinned, sleeperAnchors } from '../web/asleep.js';
import { awakeShown, awakeToggleFace, funnelHolds, hiddenSleepers, railShown } from '../web/rail-awake.js';
import { inFilter, keptLeads, mergeFilteredOrder, resolveFilter } from '../web/rail-filter.js';

/*
 * The rail head's awake-only toggle: sleepers hidden from every list the rail draws, on top
 * of — and independent of — the group/room funnel.
 *
 * Two halves, `rail-filter.test.js`'s shape. The first runs the pure modules together the way
 * `renderRail` does: which rows survive, that a folder of sleepers has nothing left to head,
 * that the funnel does not let go because this toggle emptied it, and — the one that would
 * render perfectly while being wrong — that a pinned sleeper survives a reorder made while it
 * is hidden. The second is a source scan over what is structural: one predicate in
 * `renderRail` and the grip, the button's place in the head, its pref, and that nothing it
 * does is a write.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = text('web/app.js');
const styles = text('web/styles.css');
const html = text('web/index.html');
const prefs = text('web/prefs.js');

const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = app.indexOf('{', app.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
};

/* The bench's own shape: alpha has two live rows and a sleeper, beta one live row and a
   pinned sleeper, gamma only a sleeper. Group g1 files alpha, g2 files gamma. */
const live = [
  { id: 'pane-0', paneId: '%0', tmuxSession: 'foreman-alpha', project: 'alpha', pinned: true, lastActivity: 50 },
  { id: 'pane-1', paneId: '%1', tmuxSession: 'foreman-alpha-2', project: 'alpha', lastActivity: 40 },
  { id: 'pane-2', paneId: '%2', tmuxSession: 'foreman-beta', project: 'beta', pinned: true, lastActivity: 30 },
];
const sleepers = asleepItems([
  { name: 'foreman-beta-2', folder: '/x/beta', pinned: true, pinAfter: 'foreman-alpha', sleptAt: 1, lastActivity: 20 },
  { name: 'foreman-gamma', folder: '/x/gamma', lastActivity: 10 },
  { name: 'foreman-alpha-3', folder: '/x/alpha', lastActivity: 5 },
]);
const groups = [
  { id: 'g1', name: 'Bench', folders: ['alpha'] },
  { id: 'g2', name: 'Sleepy', folders: ['gamma'] },
];

/** `renderRail`'s funnel predicate for one stored value. */
const funnel = (value) => {
  const filter = resolveFilter(value, { groups, sessions: live, asleep: [] });
  const leads = keptLeads(live, filter);
  return (s) => inFilter(s, filter, leads);
};

/** The folder map `renderRail` builds from its unpinned rows. */
const folderMap = (shown) => {
  const rest = mergeByActivity(
    live.filter((s) => !s.pinned && shown(s)),
    sleepers.filter((s) => !s.pinned && shown(s)),
  );
  const out = new Map();
  for (const s of rest) out.set(s.project, [...(out.get(s.project) || []), s.name || s.tmuxSession]);
  return out;
};

const pinKey = (s) => (s.asleep ? `asleep:${s.name}` : s.paneId);

/* ------------------------------------------------------------------- the module --- */

test('off keeps everything; on keeps only the awake', () => {
  assert.equal(awakeShown({ asleep: true }, false), true);
  assert.equal(awakeShown({ id: 'x' }, false), true);
  assert.equal(awakeShown({ asleep: true }, true), false);
  assert.equal(awakeShown({ id: 'x' }, true), true);
});

test('the predicate is the funnel and the toggle both, and either alone without the other', () => {
  const g1 = funnel('g1');
  const both = railShown(g1, true);
  assert.equal(both(live[1]), true, 'a live alpha row is in the group and awake');
  assert.equal(both(sleepers[2]), false, 'an alpha sleeper is in the group but asleep');
  assert.equal(both(live[2]), false, 'a beta row is awake but outside the group');
  assert.equal(railShown(null, true)(live[2]), true, 'no funnel: only the toggle asks');
  assert.equal(railShown(null, true)(sleepers[0]), false);
  assert.equal(railShown(g1, false)(sleepers[2]), true, 'toggle off: only the funnel asks');
  assert.equal(railShown(null, false)(sleepers[1]), true, 'neither: everything, exactly as before');
});

test('a folder holding only sleepers has no rows left, so it has no heading to draw', () => {
  const off = folderMap(railShown(null, false));
  assert.deepEqual([...off.keys()].sort(), ['alpha', 'gamma'], 'off: gamma is a folder of one sleeper, as today');
  const on = folderMap(railShown(null, true));
  assert.deepEqual([...on.keys()], ['alpha'], 'on: gamma is gone, and with it group g2');
  assert.deepEqual(on.get('alpha'), ['foreman-alpha-2'], 'alpha keeps its awake row only');
});

test('the pinned group loses its sleepers while hidden, and keeps them when shown', () => {
  const pinned = placePinned(live.filter((s) => s.pinned), sleepers.filter((s) => s.pinned));
  assert.deepEqual(pinned.map(pinKey), ['%0', 'asleep:foreman-beta-2', '%2']);
  assert.deepEqual(pinned.filter(railShown(null, true)).map(pinKey), ['%0', '%2']);
  assert.deepEqual(pinned.filter(railShown(null, false)).map(pinKey), ['%0', 'asleep:foreman-beta-2', '%2']);
});

test('a pinned sleeper survives a reorder made while it is hidden, in the slot it held', () => {
  const full = placePinned(live.filter((s) => s.pinned), sleepers.filter((s) => s.pinned));
  const keys = full.map(pinKey);
  // What the drag sees: the drawn pins alone. The maintainer moves beta above alpha.
  const drawn = full.filter(railShown(null, true)).map(pinKey);
  assert.deepEqual(drawn, ['%0', '%2']);
  const written = mergeFilteredOrder(keys, ['%2', '%0']);
  // The whole order, every pin named once — what `POST /api/pins/order` requires — with the
  // hidden sleeper exactly where it was.
  assert.deepEqual(written, ['%2', 'asleep:foreman-beta-2', '%0']);
  assert.equal(written.indexOf('asleep:foreman-beta-2'), keys.indexOf('asleep:foreman-beta-2'));
  assert.equal(new Set(written).size, keys.length);
  // And the record the panel writes for it still pins it, anchored to the row now above it,
  // so turning the toggle off draws it back in that same slot.
  const byKey = new Map(full.map((s) => [pinKey(s), s]));
  const anchors = sleeperAnchors(
    written.map((k) => byKey.get(k).tmuxSession),
    ['foreman-beta-2'],
  );
  assert.equal(anchors.get('foreman-beta-2'), 'foreman-beta');
  const redrawn = placePinned(
    [byKey.get('%2'), byKey.get('%0')],
    [{ ...byKey.get('asleep:foreman-beta-2'), pinAfter: anchors.get('foreman-beta-2') }],
  );
  assert.deepEqual(redrawn.map(pinKey), written);
});

test('the funnel does not let go because this toggle emptied it', () => {
  const g2 = funnel('g2');
  assert.equal(funnelHolds(live, sleepers, g2), true, 'g2 holds a sleeper, hidden or not');
  // …and still lets go when its group really is empty.
  const gone = funnel('g1');
  assert.equal(funnelHolds([], [], gone), false);
});

test('the title counts what the toggle is hiding, inside the funnel', () => {
  assert.equal(hiddenSleepers(sleepers, null, false), 0, 'off hides nothing');
  assert.equal(hiddenSleepers(sleepers, null, true), 3);
  assert.equal(hiddenSleepers(sleepers, funnel('g1'), true), 1, 'only alpha-3 is in g1');
  assert.deepEqual(awakeToggleFace(false, 3), {
    pressed: false,
    title: 'Hide sleeping sessions',
    label: 'Hide sleeping sessions',
  });
  assert.equal(awakeToggleFace(true, 1).title, 'Show the 1 sleeping session');
  assert.equal(awakeToggleFace(true, 3).title, 'Show the 3 sleeping sessions');
  assert.equal(awakeToggleFace(true, 0).title, 'Show sleeping sessions');
  assert.equal(awakeToggleFace(true, 0).pressed, true);
});

/* ------------------------------------------------------------------- the source --- */

test('renderRail cuts every list with one predicate, built before the folder map', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const shown = railShown\(inFunnel, awakeOnly\.on\);/);
  const at = rail.indexOf('const shown = railShown(');
  for (const use of [
    'const pinned = pinnedRows(sleepers).filter(shown);',
    "sleepers.filter((s) => !s.pinned && shown(s))",
    'const folders = new Map();',
  ]) {
    assert.ok(rail.indexOf(use) > at, `${use} comes after the predicate`);
  }
  // The funnel's self-clear asks the funnel alone, never what is drawn.
  assert.match(rail, /!funnelHolds\(state\.sessions, sleepers, inFunnel\)\) return void setRailFilter\(''\);/);
  assert.doesNotMatch(rail, /!pinned\.length && !rest\.length/);
});

test('the grip’s arrows step over exactly what the rail hides', () => {
  assert.match(fn('pinGrip'), /pinnedRows\(\)\.filter\(railRowShown\(\)\)/);
  assert.match(fn('railRowShown'), /railShown\(\(s\) => inFilter\(s, filter, leads\), awakeOnly\.on\)/);
  // A drop goes through the same whole-order merge.
  assert.match(fn('fullPinOrder'), /mergeFilteredOrder\(pinnedRows\(\)\.map\(pinKey\), visibleNext\)/);
});

test('it is a per-browser flag in prefs.js, never a value of the funnel', () => {
  assert.match(prefs, /export const AWAKE_ONLY_KEY = 'foreman\.awakeOnly';/);
  assert.match(prefs, /export const awakeOnly = flag\(AWAKE_ONLY_KEY\);/);
  assert.ok(!/localStorage[^\n]*awakeOnly/.test(app), 'no ad-hoc storage key in app.js');
});

test('a press writes nothing but the preference', () => {
  const from = app.indexOf('el.awakeOnly.onclick = () => {');
  assert.ok(from > 0);
  const handler = app.slice(from, app.indexOf('};', from));
  assert.match(handler, /awakeOnly\.set\(!awakeOnly\.on\);/);
  assert.match(handler, /renderRail\(\);/);
  assert.doesNotMatch(handler, /fetch|savePinOrder|setRailFilter|collapsed/);
});

test('the button sits between recent and settings, icon-only and pressable', () => {
  const head = html.slice(html.indexOf('<div class="rail-actions">'), html.indexOf('</div>', html.indexOf('<div class="rail-actions">')));
  const ids = [...head.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.slice(-3), ['flatRail', 'awakeOnly', 'settings']);
  const tag = head.slice(head.lastIndexOf('<button', head.indexOf('id="awakeOnly"')), head.indexOf('>', head.indexOf('id="awakeOnly"')));
  assert.match(tag, /class="new-session rail-toggle icon-only"/);
  assert.match(tag, /aria-pressed="false"/);
  assert.match(tag, /title="Hide sleeping sessions"/);
  // Two `.rail-toggle`s in a row: only the first takes the push to the right end.
  assert.match(styles, /\.rail-toggle \+ \.rail-toggle \{ margin-left: 0; \}/);
});

test('the head’s width budget is the measured one', () => {
  // Seven controls on one line at the default rail width: 277.7px of 284, measured on the
  // bench (rail-and-groups#a-fifth-button-in-the-rail-head). Either number widening puts
  // `settings` back on a second line.
  const actions = styles.slice(styles.indexOf('.rail-actions {'), styles.indexOf('}', styles.indexOf('.rail-actions {')));
  assert.match(actions, /^\s*gap: 0\.2rem;/m);
  const base = styles.slice(styles.indexOf('.new-session {'), styles.indexOf('}', styles.indexOf('.new-session {')));
  assert.match(base, /^\s*padding: 0\.15rem 0\.25rem;/m);
  // …and the icon buttons kept their own size.
  assert.match(styles, /\.new-session\.icon-only \{[^}]*padding: 0\.15rem 0\.35rem;/);
});
