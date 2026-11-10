import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  filterFolders,
  filterLabel,
  filterTarget,
  hiddenWanting,
  inFilter,
  keptLeads,
  mergeFilteredOrder,
  resolveFilter,
  roomFilter,
  roomFilterValue,
} from '../web/rail-filter.js';

/*
 * The rail narrowed to one group or one room.
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
/** A group filter, resolved the way the rail resolves one. */
const byGroup = (id) => resolveFilter(id, { groups });
/** A group filter over a bare set of folders, for the cases no fixture group spells. */
const overFolders = (list) => ({ kind: 'group', id: 'x', name: 'x', folders: new Set(list) });
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
  assert.equal(inFilter(row('a', 'alpha'), resolveFilter('e', { groups: [{ id: 'e', folders: [] }] })), false);
});

/* ------------------------------------------------------------------ inFilter --- */

test('a row survives by its folder, sleepers included', () => {
  const f = byGroup('g1');
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
  const f = byGroup('g1');
  const sessions = [
    row('a', 'alpha', { needsYou: true }), // in the group: on screen, not counted
    row('c', 'gamma', { needsYou: true }), // other group
    row('u', 'ungrouped', { needsYou: true, pinned: true }), // pinned elsewhere
    row('q', 'gamma'), // hidden but quiet
  ];
  assert.equal(hiddenWanting(sessions, f, wants), 2);
});

test('a quiet worker is not counted — the inbox would not have hoisted it either', () => {
  const f = byGroup('g1');
  const sessions = [
    row('w', 'gamma', { needsYou: true, team: { role: 'worker', stuck: false } }),
    row('s', 'gamma', { needsYou: true, team: { role: 'worker', stuck: true } }),
  ];
  assert.equal(hiddenWanting(sessions, f, wants), 1);
});

test('no filter hides nothing, so counts nothing', () => {
  assert.equal(hiddenWanting([row('c', 'gamma', { needsYou: true })], null, wants), 0);
  assert.equal(hiddenWanting(null, byGroup('g1'), wants), 0);
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

test('pinned and the rest are both cut by the filter — there is no inbox left to cut', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const pinned = pinnedRows\(sleepers\)\.filter\(shown\);/);
  assert.ok(!/const inbox\b/.test(rail), 'no needs-you section any more (the 2026-11-09 ruling)');
  assert.match(rail, /let rest = byRecency\(state\.sessions\.filter\([^\n]*&& shown\(s\)\)\);/);
  assert.match(rail, /sleepers\.filter\(\(s\) => !s\.pinned && shown\(s\)\)/);
  // A lead in another group must not collect workers it will never draw.
  assert.match(rail, /s\.isLead && shown\(s\)\) leadRows\.set/);
});

test('the count is taken with the stripe’s own rule, not a second spelling', () => {
  const rail = fn('renderRail');
  assert.match(rail, /hiddenWanting\(state\.sessions, filter, wantsYou\)/);
  assert.match(app, /^import \{[^}]*\bwantsYou\b[^}]*\} from '\.\/needs-you\.js';$/m);
});

test('a stale filter clears only once a roster frame has arrived', () => {
  const rail = fn('renderRail');
  assert.match(rail, /if \(railFilter\.value && !filter && rosterSeen\) return void setRailFilter\(''\);/);
  assert.match(fn('handle'), /rosterSeen = true;/);
});

test('the filtered group draws open without writing its collapse', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const folded = g\.collapsed && !filtered;/);
  // Folded, nothing is drawn — the jump's walk notes the rows behind it, and writes nothing.
  assert.match(rail, /if \(folded\) \{\s*for \(const s of expand\(awake\([^\n]*\) note\(s, g\.id\);\s*continue;\s*\}/);
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
  assert.match(header, /row\.append\(groupFilterButton\(g, lit\)\);/);
  assert.equal((header.match(/e\.stopPropagation\(\)/g) || []).length, 2);
  const btn = fn('groupFilterButton');
  assert.match(btn, /className = `label-menu shelf-filter/);
  assert.match(btn, /e\.stopPropagation\(\)/);
  assert.match(btn, /setRailFilter\(on \? '' : g\.id\)/);
});

test('a worker is kept with its lead, hidden without it, and counted by the lead it has', () => {
  const lead = { id: 'l', isLead: true, project: 'alpha', paneCwd: '/sb/alpha' };
  const w = { id: 'w', workerOf: '/sb/alpha', project: 'alpha-agent-x', needsYou: true };
  const stray = { id: 's', workerOf: '/sb/beta', project: 'beta-agent-y', needsYou: true };
  const all = [lead, w, stray];
  const wants = (s) => s.needsYou;

  const inGroup = overFolders(['alpha']);
  const leads = keptLeads(all, inGroup);
  assert.deepEqual([...leads], ['/sb/alpha']);
  assert.equal(inFilter(w, inGroup, leads), true, 'kept with its lead');
  assert.equal(inFilter(stray, inGroup, leads), false, 'its lead is not drawn');
  assert.equal(hiddenWanting(all, inGroup, wants), 1, 'only the worker with a hidden lead counts');

  const elsewhere = overFolders(['gamma']);
  const none = keptLeads(all, elsewhere);
  assert.equal(inFilter(w, elsewhere, none), false, 'hidden without its lead');
  assert.equal(hiddenWanting(all, elsewhere, wants), 2);

  assert.equal(keptLeads(all, null), null);
  assert.equal(inFilter(w, null, null), true);
  assert.equal(inFilter(w, inGroup), false, 'no leads passed, no free pass');
});

/* ===================================================================== rooms === */

/*
 * The same filter, narrowed to a room's members. What is pinned here is the three ways it
 * could come apart while drawing a rail that looks deliberate: a member resolved by a stored
 * pane id that now belongs to somebody else lets a stranger in (rooms#a-room-member-is-
 * resolved-tmuxsession-first); a sleeping member left out drops a row the room still has;
 * and two stored values — one per kind — would let a group and a room filter hold at once.
 */

const sbRoom = (over = {}) => ({
  id: 'room-4',
  name: 'alpha ↔ beta',
  members: [
    { tmuxSession: 'foreman-alpha-main', name: 'alpha-main', paneId: '%1' },
    { tmuxSession: 'foreman-beta-main', name: 'beta-main', paneId: '%2' },
    { tmuxSession: 'foreman-gamma-master', name: 'gamma-master', paneId: '%3' },
  ],
  archivedAt: null,
  ...over,
});
const live = (id, tmuxSession, paneId, project, extra = {}) => ({ id, tmuxSession, paneId, project, label: '', ...extra });

test('one stored value for both kinds, so one filter at a time is a fact, not a rule', () => {
  assert.equal(filterTarget(''), null);
  assert.equal(filterTarget(null), null);
  assert.deepEqual(filterTarget('g3'), { kind: 'group', id: 'g3' });
  assert.equal(roomFilterValue('room-4'), 'room:room-4');
  assert.deepEqual(filterTarget(roomFilterValue('room-4')), { kind: 'room', id: 'room-4' });
  assert.equal(filterTarget('room:'), null, 'a prefix with no id names nothing');
  // The store mints `g<N>` and `room-<N>`: a group id is never read as a room.
  assert.equal(filterTarget('g12').kind, 'group');
});

test('a room keeps its members, resolved `tmuxSession` first — a reused pane id lets nobody in', () => {
  const sessions = [
    live('a', 'foreman-alpha-main', '%9', 'alpha'), // relaunched: new pane, same name
    live('b', 'foreman-beta-main', '%2', 'beta'),
    // A stranger now holding a member's stored pane id, under another name.
    live('x', 'foreman-gamma-other', '%3', 'gamma'),
    live('u', 'foreman-alpha-side', '%5', 'alpha'), // same folder as a member, not a member
  ];
  const f = resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom()], sessions });
  assert.equal(f.kind, 'room');
  assert.equal(f.name, 'alpha ↔ beta');
  assert.deepEqual([...f.sessions].sort(), ['a', 'b']);
  assert.equal(inFilter(sessions[0], f), true);
  assert.equal(inFilter(sessions[2], f), false, 'the stored pane id alone keeps nobody');
  assert.equal(inFilter(sessions[3], f), false, 'membership is the session, never its folder');
});

test('an asleep member stays on the rail, and a sleeper outside the room does not', () => {
  const sessions = [live('a', 'foreman-alpha-main', '%1', 'alpha')];
  const asleep = [{ name: 'foreman-gamma-master' }, { name: 'foreman-beta-side' }];
  const f = resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom()], sessions, asleep });
  assert.deepEqual([...f.sleepers], ['foreman-gamma-master']);
  assert.equal(inFilter({ asleep: true, name: 'foreman-gamma-master', project: 'gamma' }, f), true);
  assert.equal(inFilter({ asleep: true, name: 'foreman-beta-side', project: 'beta' }, f), false);
  // A sleeper is kept by name, never by its folder.
  assert.equal(inFilter({ asleep: true, name: 'foreman-alpha-other', project: 'alpha' }, f), false);
});

test('an archived or deleted room is no filter, which is the cue to let go', () => {
  assert.equal(resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom({ archivedAt: 5 })] }), null);
  assert.equal(resolveFilter(roomFilterValue('room-9'), { rooms: [sbRoom()] }), null);
  assert.equal(resolveFilter(roomFilterValue('room-4'), {}), null);
  assert.equal(roomFilter(undefined, 'room-4'), null);
});

test('a room with nobody left in it filters to nothing rather than to everything', () => {
  const f = resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom({ members: [] })], sessions: [live('a', 'foreman-alpha-main', '%1', 'alpha')] });
  assert.equal(f.sessions.size, 0);
  assert.equal(inFilter(live('a', 'foreman-alpha-main', '%1', 'alpha'), f), false);
});

test('a member lead keeps its workers, as under a group filter — the same code path', () => {
  const lead = live('l', 'foreman-alpha-main', '%1', 'alpha', { isLead: true, paneCwd: '/sb/alpha' });
  const w = { id: 'w', workerOf: '/sb/alpha', project: 'alpha-agent-x', needsYou: true, team: { role: 'worker', stuck: true } };
  const stray = { id: 's', workerOf: '/sb/beta', project: 'beta-agent-y', needsYou: true, team: { role: 'worker', stuck: true } };
  const all = [lead, w, stray];
  const f = resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom()], sessions: all });
  const leads = keptLeads(all, f);
  assert.deepEqual([...leads], ['/sb/alpha']);
  assert.equal(inFilter(w, f, leads), true, 'nested under the member it works for');
  assert.equal(inFilter(stray, f, leads), false);
  assert.equal(hiddenWanting(all, f, wants), 1, 'only the worker whose lead is hidden is counted');
});

test('the count under a room filter is everybody outside it who wants you, pinned included', () => {
  const sessions = [
    live('a', 'foreman-alpha-main', '%1', 'alpha', { needsYou: true }), // member: on screen
    live('u', 'foreman-alpha-side', '%5', 'alpha', { needsYou: true }), // same folder, not a member
    live('p', 'foreman-gamma-other', '%7', 'gamma', { needsYou: true, pinned: true }),
    live('q', 'foreman-beta-other', '%8', 'beta'), // hidden, quiet
  ];
  const f = resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom()], sessions });
  assert.equal(hiddenWanting(sessions, f, wants), 2);
});

test('the clear toggle names the kind and the name', () => {
  assert.equal(filterLabel(byGroup('g1')), 'the group Tools');
  const f = resolveFilter(roomFilterValue('room-4'), { rooms: [sbRoom()] });
  assert.equal(filterLabel(f), 'the room alpha ↔ beta');
  assert.equal(filterLabel(null), '');
});

/* ------------------------------------------------------------ rooms, source --- */

test('the rail and the grip read one resolution, rooms and sleepers included', () => {
  const now = fn('railFilterNow');
  assert.match(now, /resolveFilter\(railFilter\.value \|\| null, \{/);
  for (const k of ['groups: state.groups', 'rooms: state.rooms', 'sessions: state.sessions', 'asleep: state.asleep']) {
    assert.ok(now.includes(k), `railFilterNow hands over ${k}`);
  }
  assert.match(fn('renderRail'), /const filter = railFilterNow\(\);/);
  assert.match(fn('pinGrip'), /const filter = railFilterNow\(\);/);
  assert.ok(!/filterFolders\(/.test(app), 'no reader resolves a group on its own any more');
});

test('a room filter draws every group that holds a member, open, and lights no group funnel', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const filtered = Boolean\(filter\) && \(filter\.kind === 'room' \|\| g\.id === filter\.id\);/);
  const header = fn('groupHeader');
  assert.match(header, /const lit = filtered && filterTarget\(railFilter\.value\)\?\.kind === 'group';/);
});

test('the band’s funnel sets the one stored value, and the band is never itself filtered', () => {
  const from = app.indexOf('\nfunction renderRoomsBand(');
  const render = app.slice(from, app.indexOf('\n}\n', from));
  assert.match(render, /onFilter: \(id\) => setRailFilter\(id \? roomFilterValue\(id\) : ''\)/);
  assert.match(render, /const rooms = newestCreatedFirst\(state\.rooms\);/, 'every room, filtered or not');
  assert.ok(!/inFilter|resolveFilter/.test(render));
});

test('the clear toggle is painted from the resolved filter, never a group lookup', () => {
  const paint = fn('paintRailFilter');
  assert.match(paint, /const name = filterLabel\(filter\);/);
  assert.ok(!/state\.groups/.test(paint));
});
