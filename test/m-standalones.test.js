import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/* The phone's one comparator, driven for real. `web/m/app.js` cannot be imported here, which
   is exactly why the sort does not live inside it any more: a tie-break that can only be read
   out of the source is a tie-break nothing ever runs. */
import { byRecent, recentStamp } from '../web/m/recent.js';
/* The route claims, driven for real — the reason they left `web/m/app.js` for a pure module.
   A security check that can only be read out of the source is one nothing ever runs. */
import { routeRefusal, standalonesIn } from '../web/m/roles.js';

/*
 * The phone's Standalones tab, and the session screen behind it.
 *
 * The phone opened up beyond leads on the maintainer's ruling of 2026-09-07: `#/session/<id>`
 * mounts the same screen module `#/lead/<id>` does, for a session that belongs to nobody's
 * team. Neither `web/m/app.js` nor `web/m/lead.js` can be imported here — both reach for the
 * document at module scope and there is no browser in `node --test` — so these are held
 * against the source, the way `test/m-start-sheet.test.js` and `test/rooms-band.test.js` hold
 * their own contracts. What the list looks like on a phone is a pair of eyes and the bench.
 *
 * Only the things that would break **silently** are pinned, and there are five of them:
 *
 *  - **The list is an allow-list, never "not a worker".** Kinds have grown here once already
 *    (`planner`), and a negative test would quietly start offering the next one. Workers do
 *    open from the phone since the maintainer's ruling of 2026-10-08 — but from under their
 *    lead's card, on `#/worker/<id>`, and never from this list, which did not widen.
 *  - **The role re-check is asked on every roster frame, not once at mount.** It is a
 *    security control: a lead was measured `/exit`ing and the registry re-binding that same
 *    session id to a different pane in the same folder, with the screen still updating under
 *    the same URL. Every route asks, and they ask the same function — `routeRefusal` in
 *    `web/m/roles.js`, which is pure and is driven below with real rows.
 *  - **There is no tasks tab on a session screen — built, not hidden.** `mountTasksOnce` keys
 *    on `paneCwd`, and an ordinary session launched inside a team's folder carries that
 *    team's; a tab merely left un-tapped would be somebody else's tasks one tap away.
 *  - **The merge block keeps its one guard and grows no second.** `repoOf` answers `null` for
 *    any row that is not a lead, which is what makes the block inert here.
 *  - **The cards are `buildCard`'s, unchanged.** That is the whole of why the folder-trust
 *    refusal applies on the new screen: one witness, `web/trust-gate.js`, read by `cards.js`
 *    and by nothing this feature added.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/m/app.js');
const lead = text('web/m/lead.js');
const roles = text('web/m/roles.js');
const css = text('web/m/m.css');

/** The source with its prose taken out — `test/rooms-band.test.js`'s helper, for its reason.
 *  Several checks below are *negative* ("no raw timestamp in the signature") and the phrase
 *  they forbid is exactly the word the comment recording the rule has to use. */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

/* Roster rows in the shapes `server/sessions.js` writes — `isLead` and `workerOf` read back
   off one `team` answer, which is the consistency `isTeamWorker` checks. */
const standaloneRow = (id) => ({ id, interactive: true, isLead: false, workerOf: null, team: null });
const leadRow = (id) => ({
  id,
  interactive: true,
  isLead: true,
  workerOf: null,
  team: { role: 'lead', tasks: 1, review: 0 },
});
const workerRow = (id, extra = {}) => ({
  id,
  interactive: true,
  isLead: false,
  workerOf: '/repos/alpha',
  team: { role: 'worker', repo: '/repos/alpha', task: id, branch: `agent/${id}`, state: 'working', ...extra },
});

/* ──────────────────────────────────────────────────── the list is a allow-list ─── */

test('the Standalones list is roomParticipants minus the leads, and nothing else', () => {
  // The rule lives in the pure module, and the shell's list is that rule over its roster.
  assert.match(roles, /import \{ roomParticipants \} from '\.\.\/rooms-create\.js';/);
  assert.match(
    roles,
    /export function standalonesIn\(sessions\) \{\s*return roomParticipants\(sessions \|\| \[\]\)\.filter\(\(s\) => !s\.isLead\);\s*\}/,
  );
  assert.match(
    app,
    /function standaloneRows\(\) \{\s*return standalonesIn\(state\.sessions \|\| \[\]\);\s*\}/,
  );

  // The one place the membership rule is spelled. Everything else — the tab mark, the order,
  // the route's own refusal — asks this function. The shell no longer calls
  // `roomParticipants` at all, so it cannot grow a second filter beside the first.
  assert.equal(roles.match(/roomParticipants\(/g).length, 1, 'one call, in the one filter');
  assert.ok(!/roomParticipants\(/.test(strip(app)), 'and none in the shell');

  // A negative test is what silently admits the next kind. There must be none, in either file.
  for (const [name, src] of [['app.js', app], ['roles.js', roles]]) {
    assert.ok(!/role\s*!==\s*'worker'/.test(src), `no “not a worker” filter in ${name}`);
    assert.ok(!/workerOf\s*==\s*null/.test(src), `and no spelling of it off workerOf in ${name}`);
  }
});

test('the list is driven: an ordinary session is in, a lead and every kind of worker are out', () => {
  const rows = [
    standaloneRow('s1'),
    leadRow('l1'),
    workerRow('w1'),
    workerRow('w2', { state: 'review' }),
    // A planner is a worker with `kind: 'plan'` on its task; on the roster it is the same
    // `role: 'worker'` row, and the same answer.
    workerRow('p1', { task: 'plan-alpha' }),
    // A row on the roster that is not an interactive Claude pane is no one's to open.
    { ...standaloneRow('x1'), interactive: false },
  ];
  assert.deepEqual(
    standalonesIn(rows).map((r) => r.id),
    ['s1'],
    'workers did not join the Standalones list when they became openable',
  );
  assert.deepEqual(standalonesIn(null), []);
});

test('the order is recency, and it still cannot change who is in it', () => {
  /*
   * Newest first since the maintainer's ruling of **2026-09-16**: *"On mobile only I'd like
   * the standalone and rooms lists to be sorted by recent at the top."* This list was ordered
   * by folder, then name, then id, and the docstring argued for that at length — the roster's
   * own order is urgency-first, so recency means the row you are reaching for can slide away
   * the instant another session speaks. Overruled, deliberately, and the cost accepted.
   *
   * What has *not* changed is the split: this is the order, `standaloneRows` is the
   * membership, and `roleRefusal` asks the second of them. A sort can never widen who may be
   * opened.
   */
  assert.match(
    app,
    /function standaloneSorted\(\) \{\s*return standaloneRows\(\)\.slice\(\)\.sort\(byRecent\('lastActivity'\)\);\s*\}/,
  );
  assert.match(app, /import \{ byRecent \} from '\.\/recent\.js';/);
  // `.slice()` first, so the roster array the shell holds is never sorted in place.
  assert.ok(!/standaloneRows\(\)\.sort\(/.test(app), 'the roster is copied before it is sorted');
  // And the old order is gone rather than left behind as a second opinion.
  assert.ok(!/String\(a\.project \|\| ''\)\.localeCompare/.test(app), 'the folder sort is gone');
});

test('newest first, ties broken by id, and a missing stamp at the bottom', () => {
  const row = (id, lastActivity) => ({ id, lastActivity });
  const order = (rows) => rows.slice().sort(byRecent('lastActivity')).map((r) => r.id);

  // Newest first, whatever order the roster handed them over in.
  assert.deepEqual(order([row('a', 10), row('b', 30), row('c', 20)]), ['b', 'c', 'a']);
  assert.deepEqual(order([row('b', 30), row('c', 20), row('a', 10)]), ['b', 'c', 'a']);

  // A genuine tie is broken by the id, so two rows cannot swap places between frames. Both
  // input orders answer the same thing — which is the whole of what "deterministic" means
  // here, and what a comparator returning 0 would fail.
  assert.deepEqual(order([row('beta', 7), row('alpha', 7)]), ['alpha', 'beta']);
  assert.deepEqual(order([row('alpha', 7), row('beta', 7)]), ['alpha', 'beta']);

  // A missing, zero or unparseable stamp sorts to the **bottom**, not anywhere random — and
  // those rows are then ordered among themselves by id.
  assert.deepEqual(
    order([row('gone'), row('live', 5), row('zero', 0), row('junk', 'soon'), row('null', null)]),
    ['live', 'gone', 'junk', 'null', 'zero'],
  );
  assert.equal(recentStamp(undefined), 0);
  assert.equal(recentStamp(null), 0);
  assert.equal(recentStamp(0), 0);
  assert.equal(recentStamp(-1), 0, 'a negative stamp is nonsense and lands with the missing');
  assert.equal(recentStamp(NaN), 0);
  assert.equal(recentStamp('1700000000000'), 1700000000000, 'a numeric string still counts');
  assert.equal(recentStamp(1700000000000), 1700000000000);
});

test('one comparator, so the two phone lists cannot disagree about recency', () => {
  // The Rooms tab takes the same function on its own field. Two spellings of a tie-break is
  // two tie-breaks, which is the lesson `isLeadName` keeps paying for.
  assert.match(text('web/m/rooms.js'), /import \{ byRecent \} from '\.\/recent\.js';/);
  assert.match(text('web/m/rooms.js'), /\.sort\(byRecent\('lastAt'\)\)/);
  const recent = text('web/m/recent.js');
  assert.equal(recent.match(/export function/g).length, 2, 'the stamp and the comparator');
  // Pure: it is imported in node above, so anything reaching for a browser would have thrown
  // on import — this pins that it stays that way.
  assert.ok(
    !/document|window|localStorage/.test(strip(recent)),
    'the comparator module touches no browser API',
  );
});

test('the tab mark and the row ask the same question, and it is needsKind', () => {
  assert.match(app, /import \{ needsKind \} from '\.\.\/notify\.js';/);
  assert.match(app, /standalones: standaloneRows\(\)\.some\(\(s\) => needsKind\(s\) != null\)/);
  assert.match(app, /function sessionRow\(s\) \{\s*const need = needsKind\(s\);/);
  // One state word for both lists, handed the answer rather than asking again — a word that
  // re-derived it could read `idle` beside a lit dot.
  assert.match(app, /function liveStateWord\(s, blocked\) \{\s*if \(blocked\) return 'blocked';/);
  assert.match(app, /word: liveStateWord\(s, need != null\)/);
  assert.match(app, /return liveStateWord\(row\.lead, row\.blocked\);/);
});

/* ─────────────────────────────────────────────────────────── the role re-check ─── */

test('one refusal function, asked at mount and on every roster frame', () => {
  // The shell's wrapper hands the pure rule the route and the roster, and does nothing else.
  assert.match(
    app,
    /function roleRefusal\(s\) \{\s*return routeRefusal\(route\.kind, s, state\.sessions \|\| \[\]\);\s*\}/,
  );
  assert.match(app, /import \{ routeRefusal, standalonesIn, workerName \} from '\.\/roles\.js';/);

  // A row not yet on the roster is not a refusal — that is a beat during a rebound, and the
  // gone timer is what covers a session that never arrives.
  assert.match(roles, /export function routeRefusal\(kind, s, sessions\) \{\s*if \(!s\) return null;/);
  assert.match(roles, /if \(kind === 'lead'\) return s\.isLead \? null : 'not-lead';/);

  // The standalone half asks the **list**, so there is exactly one spelling of who may be
  // opened. A second membership test here is how a worker gets in.
  assert.match(
    roles,
    /return standalonesIn\(sessions\)\.some\(\(r\) => r\.id === s\.id\) \? null : 'not-standalone';/,
  );
  // And a kind the file has never heard of is refused, never sent down the last branch.
  assert.match(roles, /return 'unknown-route';\s*\}\s*$/);

  // Two callers and no more: the mount, and the roster frame.
  assert.equal(app.match(/roleRefusal\(/g).length, 3, 'the definition and its two callers');
  assert.match(app, /const refusal = roleRefusal\(sessionOf\(route\.sessionId\)\);\s*if \(refusal\) return showGone\(refusal\);/);
  assert.match(app, /const refusal = roleRefusal\(session\);\s*if \(refusal\) return showGone\(refusal\);/);

  // And nothing bypasses it with the old mount-only shape.
  assert.ok(!/if \(known && !known\.isLead\)/.test(app), 'the mount-only check is gone');
});

test('the three hashes are three claims, and a rebound keeps the one it was opened on', () => {
  assert.match(app, /const conv = \/\^#\\\/\(lead\|session\|worker\)\\\/\(\.\+\)\$\/\.exec\(hash\);/);
  assert.match(
    app,
    /function isConversation\(kind\) \{\s*return kind === 'lead' \|\| kind === 'session' \|\| kind === 'worker';\s*\}/,
  );
  // A rebound moves the id and changes nothing about what the hash claims.
  assert.match(app, /history\.replaceState\(null, '', `#\/\$\{route\.kind\}\/\$\{encodeURIComponent\(msg\.to\)\}`\);/);
  // Each list links its own kind, and only its own: the card its lead, the Standalones row
  // its session, and a worker line its worker.
  assert.match(app, /location\.hash = `#\/lead\/\$\{encodeURIComponent\(row\.lead\.id\)\}`;/);
  assert.match(app, /location\.hash = `#\/session\/\$\{encodeURIComponent\(row\.id\)\}`;/);
  assert.match(app, /location\.hash = `#\/worker\/\$\{encodeURIComponent\(w\.id\)\}`;/);
  assert.equal(app.match(/location\.hash = `#\/worker\//g).length, 1, 'one link to a worker, on its line');
  // Subscribe, teardown and the gone timer are all kind-agnostic — one screen, three routes.
  assert.equal(app.match(/isConversation\(/g).length, 6, 'the definition and its five sites');
});

test('each route admits its own kind and refuses the other two, driven', () => {
  const roster = [standaloneRow('s1'), leadRow('l1'), workerRow('w1'), workerRow('w2', { state: 'review' })];
  const row = (id) => roster.find((r) => r.id === id);
  const ask = (kind, id) => routeRefusal(kind, row(id), roster);

  // Each kind on its own route.
  assert.equal(ask('lead', 'l1'), null);
  assert.equal(ask('session', 's1'), null);
  assert.equal(ask('worker', 'w1'), null);
  assert.equal(ask('worker', 'w2'), null, 'a worker in review is drawn, so it opens');

  // A worker id on either of the older routes is still refused — the reversal opened a third
  // door, it did not widen the first two.
  assert.equal(ask('session', 'w1'), 'not-standalone');
  assert.equal(ask('lead', 'w1'), 'not-lead');
  assert.equal(ask('session', 'w2'), 'not-standalone');

  // A lead or a standalone on the worker route is refused.
  assert.equal(ask('worker', 'l1'), 'not-worker');
  assert.equal(ask('worker', 's1'), 'not-worker');

  // The other cross-refusals are unchanged.
  assert.equal(ask('lead', 's1'), 'not-lead');
  assert.equal(ask('session', 'l1'), 'not-standalone');

  // A route nobody wrote a claim for refuses everything rather than falling through.
  for (const id of ['l1', 's1', 'w1']) assert.equal(ask('room', id), 'unknown-route');
  assert.equal(ask(undefined, 'w1'), 'unknown-route');

  // And a row that is not on the roster is a beat, not a refusal, on every route.
  for (const kind of ['lead', 'session', 'worker']) assert.equal(routeRefusal(kind, null, roster), null);
});

test('a refused route says which refusal it was, and points where that kind does open', () => {
  assert.match(app, /if \(reason === 'not-standalone'\) \{/);
  assert.match(app, /if \(reason === 'not-worker'\) \{/);
  assert.match(app, /if \(reason === 'unknown-route'\)/);
  assert.ok(
    app.includes('Team leads and their workers open from the Leads tab.'),
    'a worker refused on the session route is pointed at Leads, where it now opens',
  );
  assert.ok(
    !app.includes('it is never opened here'),
    'the old rule’s sentence is gone — reversed by the maintainer’s ruling of 2026-10-08',
  );
});

/* ───────────────────────────────────────────── the session screen is less, not hidden ─── */

test('the tasks tab and its pane are built for a lead and do not exist otherwise', () => {
  // The branch, once, in `build` — and both halves of it. A `hidden` tab would still be a
  // tab, and `mountTasksOnce` keys on `paneCwd`, which for an ordinary session in a team's
  // folder is that team's.
  assert.match(lead, /if \(view\.kind === 'lead'\) \{\s*el\.tabs = document\.createElement\('div'\);/);
  assert.match(lead, /if \(view\.kind === 'lead'\) \{\s*el\.tasks = document\.createElement\('div'\);/);
  assert.match(lead, /if \(el\.tabs\) bar\.append\(el\.tabs\);/);

  // One mount path for the tasks module, still reached only through the tab.
  assert.equal(lead.match(/mountTasks\(/g).length, 2, 'the import and its one call');
  assert.match(lead, /if \(tab === 'tasks'\) mountTasksOnce\(\);/);
  assert.equal(lead.match(/mountTasksOnce\(\)/g).length, 2, 'the definition and its one caller');

  // The count is a node test, not a second opinion about the kind.
  assert.match(lead, /if \(!view\.el\?\.tabCount\) return;/);
});

test('the kind is read where it branches and nowhere else', () => {
  // `build` twice (the tabs and their pane), `screenName` twice (a lead's name, a worker's).
  // Anything more and this file is one screen with checks sprinkled through it, which is
  // how the desktop ended up needing a per-pane factory.
  assert.equal(lead.match(/view\.kind === '(lead|session|worker)'/g).length, 4);
  // `lead` only on the word `lead`: a kind this file has not heard of falls to the lesser
  // screen, never to the one with a tasks tab. It used to be the other way round.
  assert.match(
    lead,
    /kind: ctx\.kind === 'lead' \? 'lead' : ctx\.kind === 'worker' \? 'worker' : 'session',/,
  );
  // The noun for the three sentences that need one, spelled once — and it is the kind.
  assert.match(lead, /function kindWord\(\) \{\s*return view\.kind;\s*\}/);
});

test('the merge block keeps its one guard and gains no second', () => {
  assert.match(lead, /function repoOf\(\) \{[\s\S]{0,600}?if \(!s\?\.isLead\) return null;/);
  assert.equal(
    lead.match(/repoOf\(\)/g).length,
    3,
    'the definition, the poll, and the press that re-asks before it posts',
  );
  // The poll is what stops: no fetch at all for a screen with no repo.
  assert.match(lead, /const repo = repoOf\(\);\s*if \(!repo\) return;/);
  assert.equal(lead.match(/fetch\(`\/api\/team\/merge/g).length, 1);
});

test('the cards are buildCard’s, so the trust-gate refusal applies for free', () => {
  assert.match(lead, /import \{ buildCard \} from '\.\/cards\.js';/);
  assert.match(lead, /const card = session \? buildCard\(session\) : null;/);
  // One construction site, and nothing about the route's kind anywhere near it: a card is
  // the same card on both screens, which is what makes the refusal apply on the new one.
  assert.ok(
    !/kind[\s\S]{0,80}buildCard\(/.test(lead),
    'the card is never gated on the route kind',
  );
  /*
   * Nothing from the card module is re-spelled here. `web/trust-gate.js` is one witness with
   * three readers — the desktop composer, `web/m/cards.js` and `POST /answer` — and this
   * screen is not a fourth: it inherits the refusal by calling `buildCard`, which is the
   * whole reason the plan says to copy none of `cards.js`.
   */
  for (const copied of ['m-gate-opt', 'isTrustGate', "from './trust-gate"]) {
    assert.ok(!lead.includes(copied), `${copied} belongs to cards.js, not here`);
  }
});

test('back goes to the tab you left, never a bare hash', () => {
  assert.match(lead, /location\.hash = view\.ctx\?\.homeHash\?\.\(\) \|\| '#\/';/);
  assert.match(lead, /`Back to \$\{view\.ctx\?\.homeLabel\?\.\(\) \|\| 'home'\}`/);
  assert.match(app, /homeHash: \(\) => homeHash\(\),/);
  assert.match(app, /homeLabel: \(\) => TAB_LABELS\[route\.tab\],/);
  // The shell's own gone screen already went through `homeHash`; it still does.
  assert.match(app, /back\.addEventListener\('click', \(\) => \{\s*location\.hash = homeHash\(\);/);
});

test('the worker count is a lead’s own team, never the folder’s', () => {
  // An ordinary session launched inside a team's folder shares its `paneCwd`. The session
  // screen draws no tasks tab at all, and this is the belt to that brace.
  assert.match(app, /if \(!s\?\.isLead \|\| !s\.paneCwd\) return 0;\s*return liveWorkers\(s\.paneCwd\);/);
});

/* ───────────────────────────────────────────────────────────── the row draws ─── */

test('the row joins the home signature as rendered strings', () => {
  assert.match(
    app,
    /JSON\.stringify\(rows\.map\(\(r\) => \[r\.id, r\.name, r\.folder, r\.word, r\.dot, r\.need, r\.working\]\)\)/,
  );
  // A raw stamp in there would differ on almost every roster frame and retire the guard.
  const view = app.slice(app.indexOf('function standalonesView('), app.indexOf('function roomsView('));
  assert.ok(view.length > 200, 'standalonesView must still exist, above roomsView');
  assert.ok(
    !/lastActivity/.test(strip(view)),
    'no raw timestamp in the standalone signature',
  );
  /*
   * …and what makes the *reorder* repaint, now that the order moves: the signature is an
   * array of arrays in list order, each beginning with the row's id, so two rows swapping
   * places spell a different string. A stamp advancing without moving a row spells the same
   * one, which is correct — nothing a reader could see has changed.
   */
  assert.match(view, /JSON\.stringify\(rows\.map\(\(r\) => \[r\.id,/);
  // The nodes are a thunk, so nothing is built for a paint the guard turns away.
  assert.match(view, /nodes: \(\) => rows\.map\(sessionNode\)/);
});

test('every class the row writes has a rule, and the gutter is the shared one', () => {
  for (const cls of ['m-sess', 'm-sess-body', 'm-sess-name', 'm-sess-meta', 'm-sess-state']) {
    assert.ok(css.includes(`.${cls}`), `${cls} has no rule — an unstyled row draws as plain text`);
  }
  // The dot vocabulary is not restated: a dot's position is learned once and must be found
  // in the same place on every tab.
  assert.match(app, /gutter\.className = 'm-dots';/);
  assert.equal(app.match(/gutter\.className = 'm-dots';/g).length, 2, 'the team row and this one');
  assert.match(app, /slotDot\('m-dot-wait', row\.dot, waitTitleFor\(row\.need\)\)/);
  assert.equal(app.match(/waitTitleFor\(/g).length, 3, 'the definition and its two callers');
});
