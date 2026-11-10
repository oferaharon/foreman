import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { byRecency, needTally, needText, nextNeeding, stripeKind, wantsYou } from '../web/needs-you.js';
import { needsKind, quietWorker } from '../web/notify.js';

/*
 * The rail stops hoisting — the maintainer's ruling of 2026-11-09, "I don't like when
 * sessions move all the time." A row that wants him stays in its folder, its group, its pin
 * or its place in `recent`, and wears a stripe on its left edge: red when blocked, the
 * accent when it only holds an unread reply. A folded group counts them
 * (`test/group-summary.test.js`), and a count in the rail head walks them.
 *
 * Two halves, the shape the rail's other pure modules use. The first runs the module in node:
 * the stripe's kind, the tally, the recency order and the jump's next row — each a place
 * where the wrong answer still renders as a perfectly ordinary rail. The second is a source
 * scan over what is structural: that nothing hoists, that the rules are imported rather than
 * re-spelled, that the jump writes no collapse, and that the stripe is out of flow.
 */

/* ------------------------------------------------------------ fixtures --- */

/** A roster row, shaped as `server/sessions.js` builds one. Sandbox projects only. */
const row = (over = {}) => ({
  id: 's1',
  title: 'alpha-main',
  project: 'alpha',
  status: 'idle',
  unread: 0,
  needsYou: false,
  lastActivity: 1_800_000_000_000,
  team: null,
  ...over,
});
const unread = (over = {}) => row({ needsYou: true, unread: 2, ...over });
const worker = (over = {}) =>
  row({ workerOf: '/sandbox/alpha', team: { role: 'worker', task: 't1', stuck: false }, ...over });
const trustPrompt = {
  question: 'Do you trust the files in this folder?',
  options: [
    { n: 1, label: 'Yes, I trust this folder' },
    { n: 2, label: 'No, exit' },
  ],
};

/* ------------------------------------------------------------ the stripe --- */

test('every box a session can be sitting on is a red stripe', () => {
  // The five `needsKind` names, each a reason the old inbox hoisted the row.
  for (const blocked of [
    row({ needsYou: true, status: 'needs-decision', prompt: { question: 'Run npm test?', options: [] } }),
    row({ needsYou: true, status: 'needs-decision', prompt: trustPrompt }),
    row({ needsYou: true, status: 'needs-decision', plan: { title: 'Plan' } }),
    row({ needsYou: true, status: 'dialog', question: { question: 'Which one?' } }),
    // `needs-decision` with nothing readable behind it — the `Switch model?` box.
    row({ needsYou: true, status: 'needs-decision' }),
  ]) {
    assert.ok(needsKind(blocked), 'needsKind names it');
    assert.equal(stripeKind(blocked), 'blocked');
  }
});

test('a reply you have not read, and nothing else, is an accent stripe', () => {
  assert.equal(stripeKind(unread()), 'unread');
});

test('blocked wins over unread', () => {
  assert.equal(stripeKind(unread({ status: 'needs-decision', prompt: { question: 'Edit?', options: [] } })), 'blocked');
  assert.equal(stripeKind(unread({ question: { question: 'Which?' } })), 'blocked');
});

test('nothing wanting is no stripe — and the roster’s needsYou is the gate, not unread alone', () => {
  assert.equal(stripeKind(row()), null);
  // `needsYou` is false while a session is still working, even with replies landing: the
  // roster's own call (`unread > 0 && status !== 'working'`), taken as given.
  assert.equal(stripeKind(row({ status: 'working', unread: 3, needsYou: false })), null);
  assert.equal(stripeKind(null), null);
  assert.equal(stripeKind(undefined), null);
});

test('a worker its lead is handling wears nothing until stuck fires', () => {
  // The 2026-08-27 trade, carried over unchanged from the inbox it used to govern.
  const blocked = { needsYou: true, status: 'needs-decision', prompt: { question: 'Run it?', options: [] } };
  assert.equal(stripeKind(worker(blocked)), null);
  assert.equal(stripeKind(worker({ needsYou: true, unread: 1 })), null);
  const stuck = { team: { role: 'worker', task: 't1', stuck: true } };
  assert.equal(stripeKind(worker({ ...blocked, ...stuck })), 'blocked');
  assert.equal(stripeKind(worker({ needsYou: true, unread: 1, ...stuck })), 'unread');
});

test('a lead asking something is striped like anyone — leads were never quieted', () => {
  const lead = row({ isLead: true, team: { role: 'lead', tasks: 2 }, needsYou: true, status: 'needs-decision' });
  assert.equal(stripeKind(lead), 'blocked');
});

test('a sleeper never wears a stripe, whatever it carries', () => {
  assert.equal(stripeKind({ asleep: true, name: 'foreman-alpha-main', needsYou: true, unread: 4 }), null);
  assert.equal(wantsYou({ asleep: true, needsYou: true }), false);
});

test('wantsYou is the old inbox’s test to the letter: needsYou less a quiet worker', () => {
  const old = (s) => Boolean(s.needsYou) && !(s.team?.role === 'worker' && !s.team.stuck);
  const cases = [
    row(),
    unread(),
    row({ needsYou: true, status: 'needs-decision' }),
    worker({ needsYou: true }),
    worker({ needsYou: true, team: { role: 'worker', stuck: true } }),
    worker({ needsYou: false, team: { role: 'worker', stuck: true } }),
  ];
  for (const s of cases) assert.equal(wantsYou(s), old(s));
});

test('quietWorker is one spelling, exported from notify.js', () => {
  assert.equal(quietWorker(worker()), true);
  assert.equal(quietWorker(worker({ team: { role: 'worker', stuck: true } })), false);
  assert.equal(quietWorker(row()), false);
  assert.equal(quietWorker(null), false);
});

/* ------------------------------------------------------------- the tally --- */

test('the tally counts wanting rows and blocked ones among them', () => {
  const rows = [
    unread({ id: 'a' }),
    row({ id: 'b', needsYou: true, status: 'needs-decision' }),
    worker({ id: 'c', needsYou: true, status: 'needs-decision' }), // quiet: not counted
    row({ id: 'd' }),
  ];
  assert.deepEqual(needTally(rows), { need: 2, blocked: 1 });
  assert.deepEqual(needTally([]), { need: 0, blocked: 0 });
  assert.deepEqual(needTally(null), { need: 0, blocked: 0 });
});

test('the count reads as English and draws nothing at zero', () => {
  assert.equal(needText(1), '1 needs you');
  assert.equal(needText(3), '3 need you');
  assert.equal(needText(0), '');
  assert.equal(needText(undefined), '');
});

/* ------------------------------------------------------------- the order --- */

test('the roster’s blocked-first ranking comes out in recency — the hoist in miniature, undone', () => {
  // As `server/sessions.js` ranks them: blocked first, then unread, then recency.
  const roster = [
    row({ id: 'blocked-old', needsYou: true, status: 'needs-decision', lastActivity: 100 }),
    row({ id: 'unread-mid', needsYou: true, unread: 1, lastActivity: 300 }),
    row({ id: 'quiet-new', lastActivity: 500 }),
    row({ id: 'quiet-old', lastActivity: 200 }),
  ];
  assert.deepEqual(
    byRecency(roster).map((s) => s.id),
    ['quiet-new', 'unread-mid', 'quiet-old', 'blocked-old'],
  );
});

test('a row with no stamp goes to the bottom, ties keep their order, nothing is mutated', () => {
  const roster = [
    row({ id: 'none', lastActivity: null }),
    row({ id: 'tie-a', lastActivity: 50 }),
    row({ id: 'zero', lastActivity: 0 }),
    row({ id: 'tie-b', lastActivity: 50 }),
    row({ id: 'new', lastActivity: 90 }),
  ];
  const before = roster.map((s) => s.id);
  assert.deepEqual(byRecency(roster).map((s) => s.id), ['new', 'tie-a', 'tie-b', 'none', 'zero']);
  assert.deepEqual(roster.map((s) => s.id), before, 'the argument is left alone');
  assert.deepEqual(byRecency(null), []);
});

/* -------------------------------------------------------------- the jump --- */

const walk = [
  { id: 'p1', kind: null, group: null },
  { id: 'p2', kind: 'unread', group: null },
  { id: 'g1', kind: null, group: null },
  { id: 'g2', kind: 'blocked', group: 'g3' }, // behind a folded group
  { id: 'u1', kind: null, group: null },
  { id: 'u2', kind: 'blocked', group: null },
];

test('the jump opens the next wanting row after the open one, in rail order', () => {
  assert.equal(nextNeeding(walk, 'p2').id, 'g2');
  assert.equal(nextNeeding(walk, 'g2').id, 'u2');
});

test('it wraps round to the top', () => {
  assert.equal(nextNeeding(walk, 'u2').id, 'p2');
});

test('“after” is about where the open row sits, even when it wants nothing', () => {
  // The press before opened an unread row and so read it: it is still in the walk, as a
  // row that wants nothing, and the next press goes on from there rather than to the top.
  assert.equal(nextNeeding(walk, 'g1').id, 'g2');
  assert.equal(nextNeeding(walk, 'u1').id, 'u2');
});

test('nothing open — or a room or a bot holding the pane — starts from the top', () => {
  assert.equal(nextNeeding(walk, null).id, 'p2');
  assert.equal(nextNeeding(walk, 'not-on-the-rail').id, 'p2');
});

test('a row behind a fold carries its group, for the header to scroll into view', () => {
  assert.equal(nextNeeding(walk, 'p2').group, 'g3');
});

test('the only wanting row answers itself, and none answers null', () => {
  const one = [{ id: 'a', kind: null }, { id: 'b', kind: 'unread' }];
  assert.equal(nextNeeding(one, 'b').id, 'b');
  assert.equal(nextNeeding([{ id: 'a', kind: null }], 'a'), null);
  assert.equal(nextNeeding([], null), null);
  assert.equal(nextNeeding(null, null), null);
});

/* ------------------------------------------------------- the source scan --- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = text('web/app.js');
const html = text('web/index.html');
const styles = text('web/styles.css');
const notify = text('web/notify.js');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

test('nothing hoists: no needs-you section, no inbox list, and the rest are re-sorted by recency', () => {
  const rail = strip(fn('renderRail'));
  assert.ok(!/needs you ·/.test(rail), 'no `needs you · N` label');
  assert.ok(!/\binbox\b/.test(rail), 'no inbox list');
  assert.ok(!/inbox-label/.test(app + styles), 'and nothing left that styles one');
  assert.match(rail, /let rest = byRecency\(state\.sessions\.filter\(\(s\) => !s\.pinned && shown\(s\)\)\);/);
});

test('the rules are imported, never re-spelled in the rail', () => {
  assert.match(app, /^import \{[^}]*\bstripeKind\b[^}]*\} from '\.\/needs-you\.js';$/m);
  assert.ok(!/const quietWorker\b/.test(strip(app)), 'app.js no longer carries its own quietWorker');
  assert.match(notify, /^export const quietWorker = /m);
  assert.equal((notify.match(/const quietWorker\b/g) || []).length, 1, 'one definition');
});

test('the row wears the stripe from stripeKind, out of flow, as a node of its own', () => {
  const row = fn('sessionRow');
  assert.match(row, /const need = stripeKind\(s\);/);
  assert.match(row, /row\.classList\.add\('needs-you', `needs-\$\{need\}`\);/);
  assert.match(row, /stripe\.className = 'need-stripe';/);
  assert.match(row, /row\.dataset\.session = s\.id;/);
  assert.match(styles, /\.session-row\.needs-you \{ position: relative; \}/);
  const block = styles.slice(styles.indexOf('.need-stripe {'));
  const decls = block.slice(0, block.indexOf('}'));
  assert.match(decls, /position: absolute;/);
  assert.match(decls, /left: -3px;/, 'laid over the 3px border the spine and the marker use');
  assert.ok(!/margin/.test(decls), 'nothing that could cut the tiled tint');
  assert.match(styles, /\.session-row\.needs-blocked \.need-stripe \{ background: var\(--decision\); \}/);
  assert.match(styles, /\.session-row\.needs-unread \.need-stripe \{ background: var\(--accent\); \}/);
});

test('the jump walks every drawn row and every folded one, and both exits paint it', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const rows = \[sessionRow\(s, fold\)\];\s*note\(s\);/);
  assert.match(rail, /rows\.push\(row\);\s*note\(w\);/);
  assert.match(rail, /for \(const s of expand\(awake\(mine\.flatMap\(\(f\) => folders\.get\(f\)\)\)\)\) note\(s, g\.id\);/);
  assert.equal((rail.match(/paintJump\(order, filter, hidden\);/g) || []).length, 2, 'flat view and grouped view');
});

test('the jump never writes a collapse and never unfolds a group on screen', () => {
  for (const name of ['jumpToNeeding', 'revealRailRow', 'paintJump']) {
    assert.ok(!/setGroupCollapsed|collapsed\s*=/.test(strip(fn(name))), `${name} writes nothing`);
  }
  assert.match(fn('revealRailRow'), /\.shelf-label\[data-group=/, 'behind a fold, the header is what scrolls');
  assert.match(fn('groupHeader'), /row\.dataset\.group = g\.id;/);
});

test('⇧⇥ is the same walk as the button — one “next”, not two', () => {
  const start = app.indexOf("if (e.key !== 'Tab' || !e.shiftKey) return;");
  const body = app.slice(start, app.indexOf('});', start));
  assert.match(body, /jumpToNeeding\(\);/);
  assert.ok(!/state\.sessions\.filter/.test(body), 'no second queue built off the roster');
});

test('the jump count sits on the brand line, not in the full rail-actions row', () => {
  const brand = html.slice(html.indexOf('<div class="brand">'), html.indexOf('</div>', html.indexOf('<div class="brand">')));
  assert.match(brand, /<button class="rail-jump" id="railJump" type="button" hidden><\/button>/);
  const actions = html.slice(html.indexOf('<div class="rail-actions">'), html.indexOf('<div class="rail-stat"'));
  assert.ok(!/railJump/.test(actions), 'a seventh control in that row is a second line');
  assert.match(styles, /\.rail-jump\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.rail-jump\.is-blocked \{ background: var\(--decision\); \}/);
});
