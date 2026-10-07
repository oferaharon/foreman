import assert from 'node:assert/strict';
import test from 'node:test';

import { driftRows } from '../web/snapshot-drift.js';

/*
 * The snapshot box's drift lists, run in plain Node. The shapes are the ones the box really
 * has in hand: `drift` is `snapshot.drift()`'s `{missing, extra}` (tmux names), `saved` is
 * `GET /api/snapshot`'s `sessions` (`benchEntries` rows) and `live` is the roster.
 *
 * Only sandbox project names appear here (`alpha`, `beta`, `gamma`).
 */

const saved = [
  { folder: '/work/alpha', slug: 'main', tmuxSession: 'cc-alpha-main' },
  { folder: '/work/beta', slug: 'main', tmuxSession: 'cc-beta-main' },
];
const live = [
  { id: 's1', tmuxSession: 'cc-alpha-main', paneCwd: '/work/alpha', cwd: '/work/alpha' },
  { id: 's2', tmuxSession: 'cc-gamma-master', paneCwd: '/work/gamma', cwd: '/work/gamma/src' },
];

test('each side is named, with the folder from the right source', () => {
  const rows = driftRows({ missing: ['cc-beta-main'], extra: ['cc-gamma-master'] }, { saved, live });
  assert.deepEqual(rows, {
    extra: [{ name: 'cc-gamma-master', folder: '/work/gamma' }],
    missing: [{ name: 'cc-beta-main', folder: '/work/beta' }],
  });
});

test('a running row is placed by paneCwd, the field a save records, before the transcript cwd', () => {
  const rows = driftRows({ extra: ['cc-gamma-master'] }, { live });
  assert.equal(rows.extra[0].folder, '/work/gamma');
  const noPane = driftRows({ extra: ['x'] }, { live: [{ tmuxSession: 'x', cwd: '/work/beta' }] });
  assert.equal(noPane.extra[0].folder, '/work/beta');
});

test('a name found in neither source keeps its row, with no folder', () => {
  // Dropping it would make the list disagree with the count drawn above it.
  const rows = driftRows({ missing: ['cc-gone'], extra: ['cc-new'] }, { saved, live });
  assert.deepEqual(rows.missing, [{ name: 'cc-gone', folder: null }]);
  assert.deepEqual(rows.extra, [{ name: 'cc-new', folder: null }]);
});

test('a saved name is not looked up in the roster, nor a running one in the saved list', () => {
  // `cc-alpha-main` is in both sources; only its own side's folder may be used.
  const rows = driftRows(
    { missing: ['cc-alpha-main'], extra: ['cc-alpha-main'] },
    {
      saved: [{ tmuxSession: 'cc-alpha-main', folder: '/saved/alpha' }],
      live: [{ tmuxSession: 'cc-alpha-main', paneCwd: '/live/alpha' }],
    },
  );
  assert.equal(rows.missing[0].folder, '/saved/alpha');
  assert.equal(rows.extra[0].folder, '/live/alpha');
});

test('order is the server’s, and junk is ignored rather than drawn', () => {
  const rows = driftRows({ missing: ['b', '', null, 'a'], extra: 'nope' }, { saved: [null, {}], live: undefined });
  assert.deepEqual(rows.missing.map((r) => r.name), ['b', 'a']);
  assert.deepEqual(rows.extra, []);
});

test('no drift, or no drift object at all, is two empty lists', () => {
  assert.deepEqual(driftRows({ missing: [], extra: [] }), { extra: [], missing: [] });
  assert.deepEqual(driftRows(undefined), { extra: [], missing: [] });
});
