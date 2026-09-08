import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The phone's home list, and the `+` that holds what it no longer shows.
 *
 * Home used to list every team a directory exists for, running or not, with a `start lead`
 * button on the rows that had none — two questions in one list. It now answers only *what
 * is happening right now*; *what I could start* moved behind a `+` in the shell header,
 * which opens a sheet of exactly the teams home is hiding.
 *
 * `web/m/app.js` cannot be imported here — it reaches for `document.getElementById` at
 * module scope and there is no browser in `node --test` — so these are held against the
 * source, the way `test/lead-aside.test.js` and `test/rooms-band.test.js` hold their own
 * `web/app.js` contracts. Nothing here is a rendered check; what the sheet looks like on a
 * phone is a pair of eyes and the bench, and the report carries that.
 *
 * Only the things that would break **silently** are pinned:
 *
 *  - **One test for "is this team running".** `homeRow`'s `lead` field, filled by `leadFor`
 *    off `paneCwd`, and no second spelling anywhere. A sheet that asked its own way could
 *    offer to start a lead that is already up, or hide the team home is also hiding — and
 *    both look like an empty list rather than a bug.
 *  - **One launch path.** `startLead` with its `launching` set and `launchErrors` map, one
 *    `POST /api/launch`. A second would come with a second, subtly different busy state.
 *  - **The `+` disappears at zero, and `hidden` is not enough on its own.** `.m-icon-btn`
 *    sets `display: flex`, which is a class rule and beats the UA stylesheet's `[hidden]` —
 *    a button left in the header opening onto an empty sheet.
 *  - **The sheet repaints behind its own signature.** It is rendered from `renderHome`, on
 *    every roster frame; a list rebuilt under a thumb is a list that eats taps, and nothing
 *    on screen says which tap was eaten.
 *  - **The empty state is untouched and there is exactly one of them.** The maintainer was
 *    asked and is happy with the wording; a home list with every lead stopped draws no rows
 *    and no note, and the `+` is what it has to say.
 *
 * **Home became three tabs** (Leads | Standalones | Rooms) on the maintainer's ruling of
 * 2026-09-07, and four of these pins moved with it rather than being retired. Every fact
 * below is the one it always was; what changed is where the shape lives:
 *
 *  - `partitionTeams()` is called **once per paint** in `renderHome` and handed to the Leads
 *    body, so the marks and the list map the teams once between them.
 *  - The list's nodes come back from the active tab's body as a **thunk**, so nothing is
 *    built for a paint the signature guard turns away.
 *  - The `+` is a **Leads-tab control**: it is still in the shell header (which is what
 *    hides it on a session screen for free), and its count now rides in on the body's own
 *    `startable`, which the other two tabs answer `0` to.
 *  - The header holds **two rows** — `.m-head-row` and the tab bar — so the `+` is appended
 *    to the row rather than straight to the header. It is still inside `.m-head`.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/m/app.js');
const css = text('web/m/m.css');

/* ─────────────────────────────────────────── home lists only running leads ─── */

test('the partition is one pass over homeRow, and homeRow’s own `lead` is the whole test', () => {
  assert.match(
    app,
    /function partitionTeams\(\) \{\s*const rows = \(state\.teams \|\| \[\]\)\.map\(homeRow\);\s*return \{\s*live: rows\.filter\(\(r\) => r\.lead\),\s*startable: rows\.filter\(\(r\) => !r\.lead\),\s*\};\s*\}/,
  );

  // `leadFor` is what fills that field, and it stays a function with exactly one caller —
  // `homeRow`. A second caller is how a second spelling of "is this team running" gets in.
  assert.equal(app.match(/leadFor\(/g).length, 2, 'the definition and its one caller');
  assert.match(app, /const lead = leadFor\(team\.repo\);/);
});

test('the home list is built from the live half and nothing else', () => {
  // One pass over the teams per paint, handed to whoever needs it: the tab marks read the
  // lead rows and so does the Leads body, and two `partitionTeams()` calls would be two
  // places to change the day `homeRow` grows a field.
  assert.match(app, /const teams = partitionTeams\(\);/);
  assert.equal(
    app.match(/partitionTeams\(\)/g).length,
    3,
    'the definition, the home paint, and the sheet',
  );
  assert.match(app, /const \{ live, startable \} = teams;/);

  // The nodes are a thunk so nothing is built for a paint the guard turns away, and what
  // the Leads tab builds is still `live` and nothing else.
  assert.match(app, /nodes: \(\) => live\.map\(teamNode\)/);
  assert.match(app, /homeList\.replaceChildren\(\.\.\.view\.nodes\(\)\);/);
  assert.ok(
    !/homeList\.replaceChildren\(\.\.\.rows\.map/.test(app),
    'the old whole-list paint is gone',
  );
});

test('a team with no live lead has no shape on the home list at all', () => {
  // `teamNode` reads `row.lead.id` unguarded and builds a plain `<button>` body. That is
  // the structural half of the rule: were the filter ever to regress, the row would throw
  // rather than draw a half-row with `no lead running` and no way to act on it.
  assert.match(app, /const body = document\.createElement\('button'\);\s*body\.className = 'm-team-body';/);
  assert.match(app, /location\.hash = `#\/lead\/\$\{encodeURIComponent\(row\.lead\.id\)\}`;/);

  // The row's launch button, its `is-static` body and its error line went with the branch.
  for (const gone of ['m-team-launch', 'm-team-error', 'is-static']) {
    assert.ok(!css.includes(gone), `${gone} is dead CSS once the branch goes`);
  }
  assert.ok(!app.includes("'m-team-launch'"), 'no launch control on a home row');
});

/* ─────────────────────────────────────────────────────── the header’s `+` ─── */

test('the `+` is in the shell header, so the lead screen hides it for free', () => {
  // Two rows inside one `<header>` since the tab bar landed: the `+` goes on the first, and
  // the header is what `enterConversation` hides. A control appended anywhere but `.m-head`
  // would sit over the lead screen's own header — a bug this screen has already had once.
  assert.match(app, /el\.headRow\.append\(el\.brand, el\.quota, el\.conn, el\.start, menuWrap\);/);
  assert.match(app, /el\.head\.append\(el\.headRow, el\.tabs\);/);
  assert.match(app, /el\.start\.addEventListener\('click', openStartSheet\);/);
  // A verb, not "add a team" — the panel cannot create one from a phone.
  assert.match(app, /el\.start\.setAttribute\('aria-label', 'Start a lead'\);/);
});

test('the `+` is drawn only when there is something behind it, and `hidden` alone would not do it', () => {
  assert.match(app, /function renderStartButton\(n\) \{\s*el\.start\.hidden = n === 0;\s*\}/);

  // Nothing else touches its visibility, so there is one rule about when it is there.
  assert.equal(app.match(/el\.start\.hidden/g).length, 2, 'the initial value and the one painter');

  // `.m-icon-btn { display: flex }` is a class rule and beats `[hidden]`. Without this the
  // button sits in the header opening onto a sheet that closes itself immediately.
  assert.match(css, /\.m-icon-btn\[hidden\] \{ display: none; \}/);
});

test('the count of startable teams is in the home signature, because the button is painted inside its guard', () => {
  // The count rides in on the active tab's own signature, which is folded into the home
  // signature below — so the `+` cannot survive the last lead-less team gaining a lead.
  assert.match(app, /const sig = \[\s*quota,\s*route\.tab,[\s\S]{0,200}?view\.sig,\s*\]\.join\('::'\);/);
  assert.match(app, /`\$\{startable\.length\}::` \+/);
  assert.match(app, /return \{ sig, startable: startable\.length, nodes: \(\) => live\.map\(teamNode\) \};/);

  // One painter, reading the body's answer. The other two tabs answer `0` — "start a lead
  // in a team that has none" is not an offer a list of ordinary sessions or rooms can make.
  assert.equal(app.match(/renderStartButton\(/g).length, 2, 'the definition and its one caller');
  assert.match(app, /renderStartButton\(view\.startable\);/);

  // Both of the Leads tab's early branches answer 0 too, or a `+` survives the teams list
  // emptying while a `Loading teams…` note is on screen.
  assert.match(app, /sig: 'loading', startable: 0, nodes: \(\) => \[note\('Loading teams…'\)\]/);
  assert.match(app, /sig: 'empty',\s*startable: 0,/);
});

/* ────────────────────────────────────────────────────────────── the sheet ─── */

test('the sheet repaints behind its own signature, never unconditionally', () => {
  // Rendered from `renderHome` — every roster frame — so the guard is the only thing
  // between it and a rebuild under a thumb.
  assert.match(app, /renderStartSheet\(\);[\s\S]{0,600}?const now = Date\.now\(\);/);
  assert.match(app, /if \(sig === sheet\.sig\) return;\s*sheet\.sig = sig;\s*sheet\.list\.replaceChildren/);

  // What can move: a team appearing or going, and that team's launch state. Nothing else
  // on a roster frame touches this box.
  assert.match(
    app,
    /startable\.map\(\(r\) => \[\s*r\.team\.repo,\s*launching\.has\(r\.team\.repo\),\s*launchErrors\.get\(r\.team\.repo\) \|\| '',\s*\]\)/,
  );
});

test('the sheet keeps the home list’s order and does not sort for itself', () => {
  /*
   * Two sorts in the file and they belong to two different lists: `loadTeams` orders the
   * teams by name — which is the order the Leads tab and this sheet both read — and
   * `standaloneSorted` orders the ordinary sessions by folder then name. Neither list
   * re-sorts for itself, which is what this test is about: the roster's own order is
   * urgency-first and would move a row under a thumb the moment something else blocked.
   */
  assert.equal(app.match(/\.sort\(/g).length, 2, 'loadTeams, and the standalone order');
  assert.match(app, /state\.teams = \(data\.teams \|\| \[\]\)\s*\.slice\(\)\s*\.sort\(/);
  assert.match(app, /function standaloneSorted\(\) \{\s*return standaloneRows\(\)\s*\.slice\(\)\s*\.sort\(/);
});

test('the sheet closes itself rather than growing an empty state of its own', () => {
  assert.match(app, /if \(!startable\.length\) \{\s*closeStartSheet\(\);\s*return;\s*\}/);
});

test('the sheet cannot outlive the screen it belongs to', () => {
  // It hangs off `document.body`, so `el.screen.replaceChildren()` does not reach it and a
  // launch that navigates into its new lead would leave it over the transcript.
  assert.match(app, /document\.body\.appendChild\(back\);/);
  assert.match(app, /homeTick = null;\s*\/\/[\s\S]*?closeStartSheet\(\);\s*\}\s*el\.screen\.replaceChildren\(\);/);

  // Three ways out, the same three the tasks tab's brief modal offers.
  assert.match(app, /x\.addEventListener\('click', closeStartSheet\);/);
  assert.match(app, /back\.addEventListener\('mousedown', \(e\) => \{\s*if \(e\.target === back\) closeStartSheet\(\);/);
  assert.match(app, /if \(e\.key === 'Escape'\) closeStartSheet\(\);/);
  // And the listener is taken off with the node, or Escape keeps firing at a dead sheet.
  assert.match(app, /document\.removeEventListener\('keydown', onSheetKey, true\);/);
});

/* ────────────────────────────────────────────────────────── one launch path ─── */

test('there is exactly one way to start a lead, and the sheet is its only caller', () => {
  assert.equal(app.match(/fetch\('\/api\/launch'/g).length, 1, 'one POST /api/launch');
  assert.equal(app.match(/async function startLead\(/g).length, 1);
  assert.equal(app.match(/startLead\(row\.team\)/g).length, 1, 'the sheet row, and nothing else');
  // Its busy and error state is still module-scope, because both lists are rebuilt from
  // scratch and a `disabled` set on a node is wiped long before the launch returns.
  assert.match(app, /const launching = new Set\(\);\s*const launchErrors = new Map\(\);/);
});

test('a successful launch closes the sheet before it navigates', () => {
  // `location.hash` fires `hashchange` as a task, so the `finally` repaint lands first and
  // would flick the row back to `start` for a frame on a launch that worked.
  assert.match(app, /closeStartSheet\(\);[\s\S]{0,400}?location\.hash = `#\/lead\/\$\{encodeURIComponent\(data\.sessionId\)\}`;/);
});

/* ────────────────────────────────────────────────────────── the empty state ─── */

test('the one empty state is unchanged, and no second one was added', () => {
  assert.ok(
    app.includes(
      'No teams yet. A team directory is created the first time a lead is launched in a folder — do that once at the Mac and the folder appears here.',
    ),
    'the maintainer was asked and is happy with this wording',
  );

  /*
   * Two notes on the **Leads** tab and only two: loading, and no teams at all. A home list
   * with every lead stopped draws neither — the `+` is what it has to say.
   *
   * Counted inside `leadsView` rather than across the file, because the other two tabs draw
   * notes of their own now (their lists are later items) and a whole-file count would rise
   * every time one of them gained a state. The `.m-note` class itself is written once, in
   * the `note()` helper, which is what stops a third wording appearing on this tab by
   * anything other than a third call here.
   */
  const leads = app.slice(app.indexOf('function leadsView('), app.indexOf('function standalonesView('));
  assert.ok(leads.length > 200, 'leadsView must still exist, above standalonesView');
  assert.equal(leads.match(/note\(/g).length, 2, 'loading, and no teams at all');
  assert.equal(app.match(/el\.className = 'm-note';/g).length, 1, 'one place spells the class');
});
