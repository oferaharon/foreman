import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  asleepItem,
  asleepItems,
  folderName,
  followIntoSleep,
  mergeByActivity,
  placePinned,
  sleepTooltip,
  waitingText,
  wokenSession,
} from '../web/asleep.js';
import { foldsInto } from '../web/rail-fold.js';

/*
 * Hibernation item 4, the desktop half: where a sleeper's greyed row goes on the rail, and
 * what a pane showing a session does when it goes to sleep and comes back.
 *
 * The first half runs `web/asleep.js` in node — plain records in, plain answers out. The
 * second is a source scan over `web/app.js` for the structural rules the plan names and a
 * pure function cannot hold: frame intake by presence, sleepers kept out of the inbox and
 * the collapsed group's dot, no `composerSig` reader for the asleep pane, `holdsMain`
 * admitting it, and no manual sleep control anywhere.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, '../web/app.js'), 'utf8');

const rec = (name, extra = {}) => ({
  name,
  folder: `/sandbox/${extra.project || 'alpha'}`,
  slug: name,
  lead: false,
  sessionId: `${name}-id`,
  transcriptPath: `/t/${name}.jsonl`,
  title: name,
  project: 'alpha',
  pinned: false,
  pinAfter: null,
  sleptAt: 1000,
  lastActivity: 500,
  waiting: 0,
  ...extra,
});

const live = (title, extra = {}) => ({ id: `${title}-live`, tmuxSession: title, title, project: 'alpha', lastActivity: 0, ...extra });

/* --------------------------------------------------------------- items --- */

test('a record becomes an item; a nameless record is dropped, a duplicate name drawn once', () => {
  const items = asleepItems([rec('alpha-a', { waiting: 2 }), { title: 'no name' }, rec('alpha-a'), null]);
  assert.equal(items.length, 1);
  assert.equal(items[0].asleep, true);
  assert.equal(items[0].tmuxSession, 'alpha-a');
  assert.equal(items[0].waiting, 2);
  assert.deepEqual(asleepItems('not an array'), []);
});

test('project falls back to the folder’s basename, the server’s own spelling for a live row', () => {
  const item = asleepItem({ name: 'x', folder: '/sandbox/beta/', title: 'x' });
  assert.equal(item.project, 'beta');
  assert.equal(folderName('/a/b/gamma'), 'gamma');
});

test('a sleeping lead keeps its team line, so a folder of one does not fold it into a different shape', () => {
  const lead = asleepItem(rec('alpha-lead', { lead: true }));
  assert.equal(lead.team.role, 'lead');
  assert.equal(foldsInto([lead]), false);
  assert.equal(foldsInto([asleepItem(rec('alpha-a'))]), true);
});

test('waiting reads `waiting N`, and nothing at zero', () => {
  assert.equal(waitingText(3), 'waiting 3');
  assert.equal(waitingText(0), '');
  assert.equal(waitingText(undefined), '');
});

/* -------------------------------------------------------------- pinned --- */

test('a pinned sleeper goes back under the row it sat beneath', () => {
  const order = placePinned([live('x'), live('y')], [asleepItem(rec('s', { pinned: true, pinAfter: 'x' }))]);
  assert.deepEqual(order.map((r) => r.tmuxSession), ['x', 's', 'y']);
});

test('nothing above it puts it at the top; an anchor no longer pinned puts it at the bottom', () => {
  const top = asleepItem(rec('top', { pinned: true, pinAfter: null }));
  const lost = asleepItem(rec('lost', { pinned: true, pinAfter: 'gone' }));
  const order = placePinned([live('x'), live('y')], [lost, top]);
  assert.deepEqual(order.map((r) => r.tmuxSession), ['top', 'x', 'y', 'lost']);
});

test('a sleeper anchored to another sleeper follows it, wherever that one lands', () => {
  // x, a, b pinned; b slept first (under a), then a (under x).
  const a = asleepItem(rec('a', { pinned: true, pinAfter: 'x', sleptAt: 2000 }));
  const b = asleepItem(rec('b', { pinned: true, pinAfter: 'a', sleptAt: 1000 }));
  const order = placePinned([live('x'), live('y')], [b, a]);
  assert.deepEqual(order.map((r) => r.tmuxSession), ['x', 'a', 'b', 'y']);
});

test('two sleepers under one anchor go in the order they slept', () => {
  // x, a, b pinned; a slept first (under x); then b, whose nearest pin above was x.
  const a = asleepItem(rec('a', { pinned: true, pinAfter: 'x', sleptAt: 1000 }));
  const b = asleepItem(rec('b', { pinned: true, pinAfter: 'x', sleptAt: 2000 }));
  const order = placePinned([live('x')], [b, a]);
  assert.deepEqual(order.map((r) => r.tmuxSession), ['x', 'a', 'b']);
});

/* ------------------------------------------------------------- folders --- */

test('a sleeper is merged among live rows by its last activity; live order is untouched', () => {
  const rows = [live('n', { lastActivity: 900 }), live('m', { lastActivity: 700 }), live('o', { lastActivity: 100 })];
  const merged = mergeByActivity(rows, [asleepItem(rec('s', { lastActivity: 500 }))]);
  assert.deepEqual(merged.map((r) => r.tmuxSession), ['n', 'm', 's', 'o']);
});

test('a sleeper older than everything goes last; one with no time goes after it', () => {
  const merged = mergeByActivity(
    [live('n', { lastActivity: 900 })],
    [asleepItem(rec('t', { lastActivity: null })), asleepItem(rec('s', { lastActivity: 5 }))],
  );
  assert.deepEqual(merged.map((r) => r.tmuxSession), ['n', 's', 't']);
});

/* ---------------------------------------------------------------- pane --- */

test('a session that left the roster under a sleeper’s id is followed into sleep', () => {
  const asleep = [rec('alpha-a', { sessionId: 'id-1' })];
  assert.deepEqual(followIntoSleep('id-1', [], asleep), { asleep: 'alpha-a' });
  // Still live: nothing to follow.
  assert.equal(followIntoSleep('id-1', [{ id: 'id-1' }], asleep), null);
  // Gone and asleep under nobody: adopt's own rules.
  assert.equal(followIntoSleep('id-2', [], asleep), null);
  assert.equal(followIntoSleep(null, [], asleep), null);
});

test('woken: the same conversation id comes back first', () => {
  const back = { id: 'id-1', tmuxSession: 'alpha-a' };
  assert.equal(wokenSession({ name: 'alpha-a', sessionId: 'id-1' }, [back], [rec('alpha-a')]), back);
});

test('woken: by name only once the record is gone — a live row under a sleeper’s name is a stranger', () => {
  const stranger = { id: 'pane-7', tmuxSession: 'alpha-a' };
  assert.equal(wokenSession({ name: 'alpha-a', sessionId: 'id-1' }, [stranger], [rec('alpha-a')]), null);
  assert.equal(wokenSession({ name: 'alpha-a', sessionId: 'id-1' }, [stranger], []), stranger);
  assert.equal(wokenSession({ name: 'alpha-a', sessionId: 'id-1' }, [], []), null);
});

test('the keep-awake tooltip says why, and that a browser holding it keeps it up', () => {
  assert.match(sleepTooltip({ ok: false, rule: 'background', why: 'a background shell is running', watched: true }), /Won’t sleep yet: a background shell is running\. It also stays awake while a browser/);
  assert.match(sleepTooltip({ ok: false, rule: 'off', why: 'hibernation is off' }), /Hibernation is off/);
  assert.match(sleepTooltip({ keepAwake: true }), /^Kept awake/);
  assert.match(sleepTooltip({ ok: true, watched: false }), /^Would sleep/);
  assert.match(sleepTooltip(null), /Keep awake/);
});

/* --------------------------------------------------------- source scan --- */

test('the frame is taken by presence, never by truth, and before adopt', () => {
  const at = APP.indexOf("if ('asleep' in msg)");
  assert.ok(at > 0, "`'asleep' in msg` is the intake");
  assert.ok(APP.indexOf("if ('hibernation' in msg)") > 0, "`'hibernation' in msg` is the intake");
  assert.ok(at < APP.indexOf('for (const pane of panes) pane.adopt();'), 'set before adopt');
});

test('holdsMain admits the asleep pane, as an allow-list', () => {
  assert.match(APP, /return kind === 'session' \|\| kind === 'bot' \|\| kind === 'asleep';/);
});

test('the asleep pane never builds a composer, and composerSig learns nothing about sleepers', () => {
  const body = APP.slice(APP.indexOf('function renderAsleepPane()'), APP.indexOf('function renderAsleepPane()') + 6000);
  assert.ok(body.length > 100, 'renderAsleepPane exists');
  const end = body.indexOf('\n  }\n');
  assert.ok(!body.slice(0, end).includes('buildComposer'), 'no composer in the asleep pane');
  const sig = APP.slice(APP.indexOf('function composerSig('), APP.indexOf('function composerSig(') + 3000);
  assert.ok(!/asleep|hibernat/.test(sig.slice(0, sig.indexOf('\n  }\n'))), 'composerSig is untouched');
});

test('sleepers never reach the inbox, unread or the collapsed group’s dot', () => {
  // The inbox and the unread stat are computed off `state.sessions`, which never holds one.
  assert.match(APP, /const inbox = state\.sessions\.filter\(/);
  assert.match(APP, /const unread = state\.sessions\.filter\(\(s\) => s\.unread > 0\)\.length;/);
  // The dot's summary is taken over awake rows only.
  assert.match(APP, /groupSummary\(expand\(awake\(/);
});

test('there is no manual sleep control: nothing on the desktop posts to a sleep route', () => {
  assert.ok(!/\/api\/(asleep|sessions\/[^'`]*)\/sleep'?\s*,\s*\{\s*method:\s*'POST'/.test(APP));
  assert.ok(!/postJSON\([^)]*\/sleep[`'"]/.test(APP), 'no POST to …/sleep');
});
