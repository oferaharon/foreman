import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { foldsInto, splitTitle } from '../web/rail-fold.js';

/*
 * The single-session fold — item 3 of the rail redesign.
 *
 * Two halves. The first runs the module in node the way `trust-gate.js` and `panel-fold.js`
 * are run: plain objects in, plain answers out. What it pins is the four ways the rule
 * comes apart **while still rendering a rail that looks designed** — a fold counted over
 * sessions instead of rows hides a folder heading over a lead and its three workers; a fold
 * that ignores the team line puts a path on the front of a row whose third line already
 * carries a role and a branch; and a title split on its own punctuation invents a path that
 * is not the folder, on exactly the rows CLAUDE.md's very first trap is about.
 *
 * The second half is a source scan, in `test/rail-spine.test.js`'s style one item over,
 * over the things that are structural rather than computed: the row's element type, the
 * keyboard handler a `div role="button"` cannot do without, the propagation the folded `▾`
 * has to stop, the heading's count, and the absence of any `button.session` selector.
 *
 * What the fold *looks* like is a pair of eyes and a measurement off the DOM; both are in
 * the report.
 */

/* ------------------------------------------------------------ fixtures --- */

/** A roster row, shaped as `server/sessions.js` builds one. Sandbox projects only. */
const row = (over = {}) => ({
  id: 'sess-1',
  label: 'alpha-main',
  title: 'alpha-main',
  project: 'alpha',
  paneId: '%1',
  paneCwd: '/sandbox/alpha',
  tmuxSession: 'foreman-alpha-main',
  status: 'idle',
  interactive: true,
  team: null,
  ...over,
});

/* --------------------------------------------------------- the rule --- */

test('a folder of one plain row folds', () => {
  assert.equal(foldsInto([row()]), true);
});

test('a lead with workers does not fold — one folder entry, four rows', () => {
  /*
   * The count is the half that catches this, and it only catches it if the caller hands in
   * the *expanded* list. `rowsFor` turns a lead into itself plus its nested workers, so the
   * folder map's entry says one and the screen says four. A fold here would hide a heading
   * over a whole team block.
   */
  const lead = row({ id: 'lead-1', isLead: true, team: { role: 'lead', tasks: 3 } });
  const workers = [1, 2, 3].map((n) =>
    row({ id: `w-${n}`, title: `alpha-task-${n}`, workerOf: '/sandbox/alpha', team: { role: 'worker' } }),
  );
  assert.equal(foldsInto([lead, ...workers]), false);
});

test('a lead alone does not fold, and neither does a worker alone', () => {
  // Both are one row, so only the team-line half refuses them — which is why it is not
  // redundant beside the count. A lead or worker row keeps its full title however alone it
  // is: its third line already carries a role and a fact, and a path on the front of that
  // is three things competing for one line.
  assert.equal(foldsInto([row({ isLead: true, team: { role: 'lead', tasks: 0 } })]), false);
  assert.equal(foldsInto([row({ team: { role: 'worker' } })]), false);
});

test('the team-line test is `s.team`, the same one `sessionRow` draws the line on', () => {
  // Not `role === 'lead' || role === 'worker'`. A planner already has `role: 'worker'` and
  // kinds have grown once here; a fold decided by one rule and a row drawn by another comes
  // apart silently the day a third kind appears. A team object with no role still refuses,
  // which is the safe direction — the fold is the addition.
  assert.equal(foldsInto([row({ team: {} })]), false);
  assert.equal(foldsInto([row({ team: { role: 'planner' } })]), false);
  assert.equal(foldsInto([row({ team: null })]), true);
});

test('two plain rows do not fold', () => {
  assert.equal(foldsInto([row(), row({ id: 'sess-2', title: 'alpha-dev' })]), false);
});

test('nothing to draw is not a fold, and neither is a malformed list', () => {
  assert.equal(foldsInto([]), false);
  assert.equal(foldsInto(undefined), false);
  assert.equal(foldsInto(null), false);
  assert.equal(foldsInto('alpha'), false);
});

/* ------------------------------------------------------------ the split --- */

test('the split spells the folder as the path and the rest as the leaf', () => {
  assert.deepEqual(splitTitle(row()), { path: 'alpha', leaf: 'main' });
  assert.deepEqual(splitTitle(row({ title: 'gamma-issue-12-fix', project: 'gamma' })), {
    path: 'gamma',
    leaf: 'issue-12-fix',
  });
});

test('a title that does not begin with the folder name does not split — so it does not fold', () => {
  /*
   * The sharp one, and the reason this is bound to `s.project` rather than to a dash.
   * `title` is `label || meta.title || project`, and `label` exists only for sessions
   * minted under the configured `sessionPrefix`. For anything else the title is Claude
   * Code's `customTitle`, which several launchers derive as `<repo>-<branch>` — so a row
   * living in folder `alpha` can carry the title `beta-main`, and "everything before the
   * last dash" would print `beta` as the path of a row in `alpha`.
   */
  assert.equal(splitTitle(row({ title: 'beta-main', project: 'alpha' })), null);
  // Not a prefix on a segment boundary either: `alphabet-main` in folder `alpha` is a
  // different folder's name that happens to start the same way.
  assert.equal(splitTitle(row({ title: 'alphabet-main', project: 'alpha' })), null);
});

test('a title with nothing after the folder name does not split', () => {
  // `alpha` is what a session with no label and no customTitle gets, and `alpha-` leaves an
  // empty leaf. Either would draw `alpha ▾ /` trailing off into nothing.
  assert.equal(splitTitle(row({ title: 'alpha' })), null);
  assert.equal(splitTitle(row({ title: 'alpha-' })), null);
});

test('a row missing either field answers null rather than inventing half a name', () => {
  assert.equal(splitTitle(row({ title: '' })), null);
  assert.equal(splitTitle(row({ project: '' })), null);
  assert.equal(splitTitle(row({ title: null })), null);
  assert.equal(splitTitle(row({ project: undefined })), null);
  assert.equal(splitTitle(undefined), null);
  assert.equal(splitTitle({}), null);
});

test('the path is the folder itself, not a slice of the title', () => {
  // Identical strings by construction — the point is that the `▾` the fold puts on this
  // path files *that* folder, so the two may never be two spellings.
  const s = row({ title: 'beta-work', project: 'beta' });
  assert.equal(splitTitle(s).path, s.project);
});

/* ------------------------------------------------------- the source scan --- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
/** The stylesheet with its comments taken out — for the two scans below that ask what the
 *  browser is told, rather than what a reader is told. Both `button.session` and the
 *  `aria-selected` this item removed are *named* in comments on purpose, so a scan over the
 *  raw text would trip on the very note explaining why they are gone. */
const declared = styles.replace(/\/\*[\s\S]*?\*\//g, '');

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

test('the rule is imported, never re-derived in the rail', () => {
  assert.match(app, /^import \{[^}]*\bfoldsInto\b[^}]*\} from '\.\/rail-fold\.js';$/m);
  assert.match(app, /^import \{[^}]*\bsplitTitle\b[^}]*\} from '\.\/rail-fold\.js';$/m);
  const rail = fn('renderRail');
  // No second spelling of either half anywhere in the rail's own body.
  assert.ok(!/\.length === 1/.test(rail), 'the row count is `foldsInto`, not an inline test');
  assert.ok(!/startsWith\(/.test(rail), 'the title split is `splitTitle`, not an inline test');
});

test('the fold rule and the heading count are the same number, taken once', () => {
  const rail = fn('renderRail');
  // One helper, and both the group loop and the ungrouped loop go through it — or the count
  // a heading prints and the count the fold was decided on could come to disagree.
  assert.match(rail, /const foldOf = \(f, list\) =>/);
  assert.match(rail, /if \(!fold\) frag\.append\(wear\(folderHeading\(f, true, rows\)\)\);/);
  assert.match(rail, /if \(!fold\) frag\.append\(folderHeading\(folder, false, rows\)\);/);
  // Expanded over `rowsFor`'s own expansion, which is the whole of `foldsInto`'s first half.
  assert.match(rail, /list\.flatMap\(\(s\) => \[s, \.\.\.\(nestedWorkers\.get\(s\.id\) \|\| \[\]\)\]\)/);
});

test('the folder heading carries its count', () => {
  const heading = fn('folderHeading');
  assert.match(heading, /function folderHeading\(folder, inGroup, count = 0\)/);
  assert.match(heading, /folder-count/);
  assert.match(heading, /`· \$\{count\}`/);
  // A `· 0` beside a name is furniture, and a folder of one folded instead of drawing one.
  assert.match(heading, /if \(count > 0\)/);
  assert.match(styles, /\.folder-count \{/);
});

test('`.session` is a div with role=button and tabindex 0, uniformly', () => {
  /*
   * The item's sharpest change. A `<button>` cannot contain interactive content, and a
   * folded folder's `▾` lives inside the title line — so the row's clickable box stops
   * being a button. Uniformly, not only on folded rows: two element types for one row,
   * differing by whether a folder happened to hold one session, is two focus behaviours.
   */
  const build = fn('sessionRow');
  assert.match(build, /const btn = document\.createElement\('div'\);/);
  assert.match(build, /btn\.setAttribute\('role', 'button'\);/);
  assert.match(build, /btn\.tabIndex = 0;/);
  assert.ok(
    !/createElement\('button'\)/.test(build.slice(0, build.indexOf('row-actions'))),
    'nothing above `.row-actions` mints a button any more',
  );
});

test('the div answers Enter and Space, and Space does not scroll the rail', () => {
  // A real button does both for free and a div does neither.
  const build = fn('sessionRow');
  assert.match(build, /btn\.onkeydown = \(e\) => \{/);
  assert.match(build, /e\.key !== 'Enter' && e\.key !== ' '/);
  assert.match(build, /e\.preventDefault\(\);/);
  assert.match(build, /openSession\(s\.id\)/);
});

test('`aria-selected` is gone, and `aria-current` says which row is open', () => {
  // `aria-selected` was invalid on the `<button>` it sat on and is invalid on
  // `role="button"` too — it belongs to `option`, `tab` and friends.
  assert.ok(
    !/setAttribute\('aria-selected'/.test(app),
    'web/app.js must not set `aria-selected` on a rail row',
  );
  assert.match(fn('sessionRow'), /btn\.setAttribute\('aria-current', 'true'\)/);
});

test('the folded `▾` stops propagation on click and on keydown', () => {
  // Click bubbles to the row and so does keydown, so without both the menu would open the
  // session underneath it as well — on the mouse and on the keyboard.
  const folded = fn('foldedTitle');
  assert.match(folded, /menu\.onclick = \(e\) => \{\s*e\.stopPropagation\(\);/);
  assert.match(folded, /menu\.onkeydown = \(e\) => \{\s*if \(e\.key === 'Enter' \|\| e\.key === ' '\) e\.stopPropagation\(\);/);
  // Same menu, same three parts — the heading's own, anchored on the path.
  assert.match(folded, /openFolderMenu\(menu, fold\.folder\)/);
  // And it is a real `<button>`, which is legal only because the row around it is not.
  assert.match(folded, /const menu = document\.createElement\('button'\);/);
});

test('the folded title is path, menu, separator, leaf — in that order', () => {
  const folded = fn('foldedTitle');
  const order = ['title-path', 'fold-menu', 'title-sep', 'title-leaf'].map((c) =>
    folded.indexOf(c),
  );
  for (const i of order) assert.ok(i >= 0, 'every part must be built');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'and in the drawn order');
  // The row keeps the whole title on hover, folded or not, so nothing is lost to a clip.
  assert.match(folded, /title\.title = s\.title;/);
});

test('nothing in the stylesheet selects `button.session`', () => {
  // The one thing that would have made the element-type change a silent restyle.
  assert.ok(
    !/button\.session/.test(declared),
    'web/styles.css must not select `button.session`',
  );
  // Nor may anything reach for one from JavaScript. (The string is *named* in a comment in
  // `sessionRow`, which is why this asks about a query rather than about the text.)
  assert.ok(
    !/(?:querySelector|querySelectorAll|matches|closest)\(['"`]button\.session/.test(app),
    'nor may web/app.js query for one',
  );
});

test('the div carries `cursor: pointer`, the one thing the button reset gave it', () => {
  const i = styles.indexOf('.session {');
  assert.ok(i >= 0, '`.session {` must exist');
  const block = styles.slice(i, styles.indexOf('}', i) + 1);
  assert.match(block, /cursor: pointer;/);
  // `font` and `color` inherit on a div and `background`/`border` are already none, so
  // nothing else from `button {}` needed carrying — but the reset must still be there for
  // every other button in the panel.
  assert.match(styles, /^button \{$/m);
});

test('nothing in a folded name is dimmed — the path is separated by weight', () => {
  // The maintainer's ruling. The only muted thing on the line is the `/`, which is
  // punctuation rather than name.
  const path500 = styles.slice(styles.indexOf('.title-path {'));
  assert.match(path500.slice(0, 80), /font-weight: 500;/);
  assert.ok(!/\.title-path \{[^}]*color:/.test(styles), 'the path takes no colour of its own');
  assert.ok(!/\.title-leaf \{[^}]*color:/.test(styles), 'and neither does the leaf');
  assert.match(styles, /\.title-sep \{[^}]*color: var\(--ink-faint\)/);
  assert.match(styles, /\.title-leaf \{[^}]*font-weight: 700;/s);
});

test('the leaf is the half that gives way, not the path', () => {
  // `text-overflow: ellipsis` cannot reach into a flex child, so the leaf carries its own.
  const leaf = styles.slice(styles.indexOf('.title-leaf {'));
  const block = leaf.slice(0, leaf.indexOf('}') + 1);
  assert.match(block, /text-overflow: ellipsis;/);
  assert.match(block, /min-width: 0;/);
  assert.match(styles, /\.title-path \{ flex: none;/);
  assert.match(styles, /\.title-sep \{ flex: none;/);
});

test('the row-mounted `▾` is revealed by the row, since the heading rules cannot reach it', () => {
  // `.label-menu` carries the look and the `opacity: 0`; the reveal rules above it key on
  // `.group-label:hover`, which a session row is not.
  assert.match(styles, /\.session-row:hover \.fold-menu \{ opacity: 1; \}/);
  assert.match(styles, /\.label-menu:focus-visible \{ opacity: 1; \}/);
  assert.match(fn('foldedTitle'), /menu\.className = 'label-menu fold-menu';/);
});

test('`.row-actions` is untouched — the pin, the duplicate and the bin still stack', () => {
  const build = fn('sessionRow');
  assert.match(build, /actions\.className = 'row-actions';/);
  assert.match(build, /pin\.className = 'pin-btn';/);
  assert.match(build, /if \(s\.paneCwd\) actions\.append\(dupBtn\(s\)\);/);
  assert.match(build, /if \(s\.interactive\) actions\.append\(closeBtn\(s\)\);/);
  // And the duplicate guard still lives in module scope, because the rows are transient.
  assert.match(app, /^const duplicating = new Set\(\);$/m);
});
