import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/* The rules, driven for real — the reason they live in a pure module rather than inside
   `web/m/app.js`, which reaches for `document` at module scope and cannot be imported here. */
import {
  liveRouteFor,
  sleeperFor,
  sleeperNamed,
  sleepersIn,
  sleepingLeadFor,
  standaloneSleepers,
  waitingWord,
  wokenRow,
} from '../web/m/asleep.js';

/*
 * Hibernation item 5: the phone. The maintainer's rulings of 2026-10-29 — a sleeping session
 * is drawn **greyed in its usual list**, a tap opens its **read-only conversation** with
 * **Wake** (the desktop's own route), and there is **no keep-awake toggle and no forget** on
 * the phone.
 *
 * What is pinned is what would break silently:
 *
 *  - the frame is read **by presence**, so an empty `asleep` is a real answer;
 *  - a sleeper never becomes a row of `state.sessions`, so no reader of that list — the tab
 *    marks, the route claims — is handed something that cannot be typed into;
 *  - the read-only view **builds** no composer, card, interrupt or tasks tab, rather than
 *    hiding them;
 *  - the phone's only write about a sleeper is Wake;
 *  - every new class is named in exactly one of the five phone sheets.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/m/app.js');
const lead = text('web/m/lead.js');

/** One top-level function's source, by name — up to the next top-level declaration. */
const fn = (src, name) => {
  const start = src.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} exists`);
  const rest = src.slice(start + 1);
  const end = rest.search(/^(export )?(async )?function |^const |^let |^\/\* -{5}/m);
  return src.slice(start, end < 0 ? undefined : start + 1 + end);
};

/* ───────────────────────────────────────────────────────────── the rules ─── */

const rec = (over = {}) => ({
  name: 'fm-alpha-1',
  folder: '/sandbox/alpha',
  lead: false,
  sessionId: '11111111-1111-4111-8111-111111111111',
  project: 'alpha',
  label: null,
  title: 'alpha',
  lastActivity: 1000,
  sleptAt: 2000,
  waiting: 0,
  ...over,
});

test('a record whose name is live is not asleep — the live row wins', () => {
  const asleep = [rec(), rec({ name: 'fm-beta-1', folder: '/sandbox/beta' })];
  const sessions = [{ id: 'x', tmuxSession: 'fm-alpha-1' }];
  assert.deepEqual(sleepersIn(asleep, sessions).map((r) => r.name), ['fm-beta-1']);
  // Null before the first frame is "not told yet", never a list to iterate.
  assert.deepEqual(sleepersIn(null, sessions), []);
  // A record with no name is not something Wake could be posted to.
  assert.deepEqual(sleepersIn([{ name: '' }, null], []), []);
});

test('Standalones takes the non-leads; a team takes its own lead by launch folder', () => {
  const asleep = [
    rec(),
    rec({ name: 'fm-gamma-lead', folder: '/sandbox/gamma', lead: true }),
    rec({ name: 'fm-gamma-1', folder: '/sandbox/gamma', lead: false }),
  ];
  assert.deepEqual(standaloneSleepers(asleep, []).map((r) => r.name), ['fm-alpha-1', 'fm-gamma-1']);
  assert.equal(sleepingLeadFor(asleep, [], '/sandbox/gamma')?.name, 'fm-gamma-lead');
  // An ordinary session in a team's folder is not that team's lead.
  assert.equal(sleepingLeadFor(asleep, [], '/sandbox/alpha'), null);
  assert.equal(sleepingLeadFor(asleep, [], null), null);
});

test('lookups by name and by session id', () => {
  const asleep = [rec()];
  assert.equal(sleeperNamed(asleep, [], 'fm-alpha-1')?.sessionId, rec().sessionId);
  assert.equal(sleeperNamed(asleep, [], 'nope'), null);
  assert.equal(sleeperFor(asleep, [], rec().sessionId)?.name, 'fm-alpha-1');
  assert.equal(sleeperFor(asleep, [], null), null);
});

test('a woken sleeper is found by name first, its session id second', () => {
  const sessions = [
    { id: 'by-id', tmuxSession: 'other' },
    { id: 'by-name', tmuxSession: 'fm-alpha-1', isLead: false },
  ];
  assert.equal(wokenRow(sessions, { name: 'fm-alpha-1', sessionId: 'by-id' })?.id, 'by-name');
  assert.equal(wokenRow(sessions, { name: 'gone', sessionId: 'by-id' })?.id, 'by-id');
  assert.equal(wokenRow(sessions, { name: 'gone', sessionId: 'gone' }), null);
});

test('a woken row opens on its own route, asked of the live row', () => {
  assert.equal(liveRouteFor({ id: 'a b', isLead: false }), '#/session/a%20b');
  assert.equal(liveRouteFor({ id: 'L', isLead: true }), '#/lead/L');
  assert.equal(liveRouteFor(null), null);
});

test('`waiting N` drops entirely at zero', () => {
  assert.equal(waitingWord(rec({ waiting: 2 })), 'waiting 2');
  assert.equal(waitingWord(rec({ waiting: 0 })), '');
  assert.equal(waitingWord(null), '');
});

/* ───────────────────────────────────────────────────────────── the shell ─── */

test('the frame is read by presence, and a sleeper never joins `sessions`', () => {
  assert.match(app, /if \('asleep' in msg\) state\.asleep = msg\.asleep \|\| \[\];/);
  assert.ok(!/state\.sessions\s*=[^;]*asleep/.test(app), 'sleepers are never folded into the roster');
  assert.ok(!/state\.sessions\.(push|concat)\(/.test(app));
});

test('sleepers light no tab mark', () => {
  assert.ok(!/asleep/i.test(fn(app, 'tabMarks')), 'tabMarks reads live rows only');
});

test('a sleeping row opens the read-only route, by name', () => {
  assert.match(fn(app, 'sleeperRow'), /href: `#\/asleep\/\$\{encodeURIComponent\(r\.name\)\}`/);
  assert.match(fn(app, 'sleepingTeamNode'), /location\.hash = `#\/asleep\/\$\{encodeURIComponent\(rec\.name\)\}`;/);
  // Greyed, never lit: both gutter slots are drawn and both are off.
  assert.match(
    fn(app, 'sleepingTeamNode'),
    /slotDot\('m-dot-wait', false, ''\), slotDot\('m-dot-work', false, ''\)/,
  );
  assert.match(fn(app, 'sleeperRow'), /dot: false,\s*working: false,/);
});

test('a session that falls asleep on screen turns into its read-only view', () => {
  assert.match(
    fn(app, 'onRoster'),
    /const sleeper = sleeperFor\(state\.asleep, state\.sessions, route\.sessionId\);\s*if \(sleeper\) \{\s*location\.replace\(`#\/asleep\/\$\{encodeURIComponent\(sleeper\.name\)\}`\);/,
  );
  // …and a woken one leaves for its live route, replacing the read-only one in history.
  assert.match(fn(app, 'onAsleepRoster'), /location\.replace\(hash\);/);
});

test('the read-only view subscribes by the record’s session id and gives it back on leave', () => {
  assert.match(
    fn(app, 'onAsleepRoster'),
    /route\.sessionId = record\.sessionId;\s*send\(\{ type: 'subscribe', sessionId: route\.sessionId, slot: SLOT \}\);/,
  );
  assert.match(app, /if \(isConversation\(route\.kind\) \|\| route\.kind === 'asleep'\) \{\s*send\(\{ type: 'unsubscribe', slot: SLOT \}\);/);
  // The socket coming back re-subscribes it, the project's most expensive lesson.
  assert.match(
    app,
    /if \(\(isConversation\(route\.kind\) \|\| route\.kind === 'asleep'\) && route\.sessionId\) \{\s*send\(\{ type: 'subscribe'/,
  );
});

test('the phone’s only write about a sleeper is Wake', () => {
  assert.match(
    fn(app, 'wakeSleeper'),
    /fetch\(`\/api\/asleep\/\$\{encodeURIComponent\(name\)\}\/wake`, \{ method: 'POST' \}\)/,
  );
  for (const [name, src] of Object.entries({ app, lead })) {
    const urls = src.match(/\/api\/asleep[^`'"]*/g) || [];
    assert.ok(urls.every((u) => u.endsWith('/wake')), `${name}: no forget, no keep-awake — ${urls}`);
    assert.ok(!/keep-?awake/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${name}: no keep-awake`);
  }
  // In flight in module scope, so a repaint cannot re-enable a button mid-wake.
  assert.match(fn(app, 'wakeSleeper'), /if \(!name \|\| waking\.has\(name\)\) return;\s*waking\.add\(name\);/);
});

/* ──────────────────────────────────────────────────────────── the screen ─── */

test('the read-only view builds no composer, card, interrupt or tasks tab', () => {
  assert.match(lead, /function build\(host\) \{\s*if \(view\.kind === 'asleep'\) return buildAsleep\(host\);/);
  const built = fn(lead, 'buildAsleep');
  for (const absent of ['textarea', 'm-input', 'm-send', 'm-lead-stop', 'm-card-slot', 'm-mq', 'm-tabs', 'm-lead-tasks', 'interrupt', 'buildCard']) {
    assert.ok(!built.includes(absent), `buildAsleep must not build ${absent}`);
  }
  assert.match(built, /el\.wake\.addEventListener\('click', \(\) => view\.ctx\?\.wake\?\.\(\)\);/);
  // And the per-frame repaint branches before any composer code is reached.
  assert.match(lead, /if \(view\.kind === 'asleep'\) \{\s*paintAsleep\(\);\s*return;\s*\}/);
  // Nothing is marked read, and no merge queue is polled, for a session with no pane.
  assert.match(fn(lead, 'markReadIfCaughtUp'), /if \(view\.kind === 'asleep'\) return;/);
  assert.match(lead, /if \(view\.kind !== 'asleep'\) watchMergeQueue\(\);/);
});

test('the shell never hands the read-only view a live row', () => {
  assert.match(app, /session: \(\) => \(route\.kind === 'asleep' \? null : sessionOf\(route\.sessionId\)\),/);
});

/* ──────────────────────────────────────────────────────── five stylesheets ─── */

test('every new class has a rule, in exactly one of the five phone sheets', () => {
  // rail-and-groups#the-phones-five-stylesheets: the build split guarantees files, not names.
  const sheets = ['web/tokens.css', 'web/m/m.css', 'web/m/lead.css', 'web/m/cards.css', 'web/m/tasks.css', 'web/m/rooms.css'];
  const home = {
    'is-asleep': 'web/m/m.css',
    'm-asleep-waiting': 'web/m/m.css',
    'm-wake': 'web/m/lead.css',
    'm-wake-note': 'web/m/lead.css',
    'm-wake-btn': 'web/m/lead.css',
    'm-wake-error': 'web/m/lead.css',
  };
  for (const [cls, owner] of Object.entries(home)) {
    const re = new RegExp(`\\.${cls}(?![\\w-])`);
    const where = sheets.filter((p) => re.test(text(p)));
    assert.deepEqual(where, [owner], `.${cls} is named in ${where.join(', ') || 'no sheet'}`);
  }
  // `[hidden]` against a class that sets `display` would lose: the error line is listed.
  assert.match(text('web/m/lead.css'), /\.m-wake-error\[hidden\],/);
});
