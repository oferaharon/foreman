import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ageText, groupSummary, summaryClauses, summaryText } from '../web/group-summary.js';

/*
 * What a folded group is hiding — item 5 of the rail redesign.
 *
 * Two halves, the same shape `test/rail-fold.test.js` uses one item over. The first runs
 * the module in node: plain roster rows in, numbers and clauses out. What it pins is the
 * three ways this arithmetic comes apart **while still drawing a heading that looks
 * designed** — a count taken over the top-level set draws a calm line over three running
 * workers, exactly the measured hole this item exists to close; a zero printed rather than
 * omitted reads `0 tasks` under a group with no team in it; and a task count re-derived
 * client-side answers a different question from the one the lead's own row answers.
 *
 * The second half is a source scan, over the things that are structural rather than
 * computed: that the line is drawn only under `collapsed`, that it is *inside* the header
 * element rather than a fourth sibling in a flat list that tiles its tint from siblings,
 * that the header carries no vertical margin, that the dot reads the summary and not the
 * old top-level `busy`, and that `count`'s own arithmetic line is untouched.
 *
 * What it looks like is a pair of eyes and two measurements off the DOM; both are in the
 * report.
 */

/* ------------------------------------------------------------ fixtures --- */

const NOW = 1_800_000_000_000;
const ago = (mins) => NOW - mins * 60_000;

/** A roster row, shaped as `server/sessions.js` builds one. Sandbox projects only. */
const row = (over = {}) => ({
  id: 'sess-1',
  title: 'alpha-main',
  project: 'alpha',
  paneId: '%1',
  paneCwd: '/sandbox/alpha',
  status: 'idle',
  lastActivity: ago(60),
  team: null,
  ...over,
});

const lead = (over = {}) =>
  row({ id: 'lead-1', isLead: true, team: { role: 'lead', tasks: 3, review: 1 }, ...over });

const worker = (over = {}) =>
  row({
    id: 'w-1',
    title: 'alpha-task',
    workerOf: '/sandbox/alpha',
    team: { role: 'worker', task: 't1', branch: 'agent/t1', state: 'working', stuck: false },
    ...over,
  });

/* --------------------------------------------------------- the counting --- */

test('a worker nested under a lead is counted in working, newest and tasks', () => {
  /*
   * The item's whole reason. `renderRail` lifts nested workers out of `rest` before the
   * folder map is built, so the group's `count` and the dot's old `busy` both covered
   * top-level rows only: a lead sitting idle over three running workers drew a calm
   * heading, and the rail said nothing at all until `stuck` fired twenty minutes later.
   *
   * The caller expands; this function only counts what it is handed — which is why the
   * expansion is one spelling in `renderRail` and the source scan below checks it is used
   * here too.
   */
  const rows = [
    lead({ status: 'idle', lastActivity: ago(90) }),
    worker({ id: 'w-1', status: 'working', lastActivity: ago(4) }),
    worker({ id: 'w-2', status: 'working', lastActivity: ago(11) }),
  ];
  const s = groupSummary(rows, NOW);
  assert.equal(s.working, 2);
  assert.equal(s.newestMs, ago(4));
  assert.equal(s.tasks, 3);
  assert.equal(summaryText(s, NOW), '2 working · newest 4m · 3 tasks');
});

test('the top-level set alone would have said nothing — the regression this closes', () => {
  // Same group, counted the old way: the lead is idle, so `working` is 0 and no dot lights.
  const lonelyLead = lead({ status: 'idle', lastActivity: ago(90) });
  assert.equal(groupSummary([lonelyLead], NOW).working, 0);
  // With its two busy workers back in, the heading has something to say.
  assert.equal(
    groupSummary([lonelyLead, worker({ status: 'working' }), worker({ id: 'w-2', status: 'working' })], NOW)
      .working,
    2,
  );
});

test('tasks are summed across every lead in the group, off the roster field', () => {
  const rows = [
    lead({ id: 'lead-a', team: { role: 'lead', tasks: 2 } }),
    lead({ id: 'lead-b', team: { role: 'lead', tasks: 5 } }),
    worker({ team: { role: 'worker', task: 't9' } }),
  ];
  // A worker's `team` has no `tasks` at all and must contribute nothing — it is one task's
  // worker, not a board.
  assert.equal(groupSummary(rows, NOW).tasks, 7);
});

test('a group with no lead omits the task clause entirely', () => {
  const s = groupSummary([row(), row({ id: 'sess-2' })], NOW);
  assert.equal(s.tasks, null);
  assert.ok(!summaryText(s, NOW).includes('task'));
});

test('a lead with an empty board is not the same fact as no lead — both draw nothing', () => {
  // `0` says "this team has nothing open"; `null` says "there is no team here". They render
  // identically today and only one of them could ever grow a clause.
  assert.equal(groupSummary([lead({ team: { role: 'lead', tasks: 0 } })], NOW).tasks, 0);
  assert.equal(groupSummary([row()], NOW).tasks, null);
  assert.ok(!summaryText({ tasks: 0, newestMs: null }, NOW).includes('task'));
});

test('newest is the most recent lastActivity, and a missing one is skipped not read as zero', () => {
  const rows = [
    row({ id: 'a', lastActivity: ago(180) }),
    row({ id: 'b', lastActivity: null }),
    row({ id: 'c', lastActivity: ago(7) }),
    row({ id: 'd', lastActivity: undefined }),
  ];
  assert.equal(groupSummary(rows, NOW).newestMs, ago(7));
});

test('a group where nothing has a timestamp has no newest clause', () => {
  const s = groupSummary([row({ lastActivity: null })], NOW);
  assert.equal(s.newestMs, null);
  assert.deepEqual(s.clauses, []);
});

/* ----------------------------------------------------------- the wording --- */

test('the exact line the mock-up draws', () => {
  assert.equal(
    summaryText({ working: 2, newestMs: ago(4), tasks: 3 }, NOW),
    '2 working · newest 4m · 3 tasks',
  );
});

test('one task is singular, more than one is plural', () => {
  assert.equal(summaryText({ working: 0, newestMs: null, tasks: 1 }, NOW), '1 task');
  assert.equal(summaryText({ working: 0, newestMs: null, tasks: 2 }, NOW), '2 tasks');
});

test('`1 working` keeps the word — it is not a noun to pluralise', () => {
  assert.equal(summaryText({ working: 1, newestMs: null, tasks: null }, NOW), '1 working');
});

test('a zero clause is omitted, never printed as a zero', () => {
  // `0 tasks` under a group with no team is furniture in the exact sense the rail already
  // refuses it — `folderHeading`'s `if (count > 0)` and `teamLine`'s `· N in review` both.
  assert.deepEqual(summaryClauses({ working: 0, newestMs: ago(120), tasks: 0 }, NOW), ['newest 2h']);
  assert.equal(summaryText({ working: 0, newestMs: ago(120), tasks: 0 }, NOW), 'newest 2h');
});

test('a group with nothing running at all still says how old it is', () => {
  // The second bench screenshot: no dot, `newest Nh` and nothing else.
  assert.equal(summaryText({ working: 0, newestMs: ago(200), tasks: null }, NOW), 'newest 3h');
});

test('everything empty is an empty line, and the caller draws none', () => {
  assert.deepEqual(summaryClauses({ working: 0, newestMs: null, tasks: null }, NOW), []);
  assert.equal(summaryText({}, NOW), '');
});

/* --------------------------------------------------------------- the age --- */

test('the age buckets are the rail rows own, to the character', () => {
  assert.equal(ageText(null, NOW), '');
  assert.equal(ageText(NOW - 59_000, NOW), 'now');
  assert.equal(ageText(ago(4), NOW), '4m');
  assert.equal(ageText(ago(59), NOW), '59m');
  assert.equal(ageText(ago(60), NOW), '1h');
  assert.equal(ageText(ago(60 * 25), NOW), '1d');
  // A clock that has gone backwards reads `now` rather than a negative age.
  assert.equal(ageText(NOW + 60_000, NOW), 'now');
});

/* ------------------------------------------------------- the source scan --- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');

/** Source with its comments taken out — what the browser is told, rather than what a reader
 *  is told. Both scans below ask about a word (`busy`, `margin`) that the *comment* beside
 *  the change names on purpose, explaining why it is gone; a scan over the raw text trips on
 *  the note rather than on the code. `test/rail-fold.test.js` learned this one item over. */
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

test('the arithmetic is imported, never re-derived in the rail', () => {
  assert.match(app, /^import \{[^}]*\bgroupSummary\b[^}]*\} from '\.\/group-summary\.js';$/m);
  const header = fn('groupHeader');
  assert.ok(
    !/status === 'working'/.test(header),
    'the heading draws the summary, it does not compute one',
  );
  assert.ok(!/team\.tasks/.test(header), 'the task count comes off the summary, not off a row');
});

test('the summary is taken over the worker-inclusive set', () => {
  const rail = fn('renderRail');
  // One spelling of the expansion, used by the fold rule and by the summary — the answer
  // must not depend on which caller asked.
  assert.match(rail, /const expand = \(list\) =>\s*list\.flatMap\(\(s\) => \[s, \.\.\.\(nestedWorkers\.get\(s\.id\) \|\| \[\]\)\]\);/);
  assert.match(rail, /groupSummary\(expand\(mine\.flatMap\(\(f\) => folders\.get\(f\)\)\), Date\.now\(\)\)/);
});

test("the header's own `· N` arithmetic is untouched — top-level rows only", () => {
  const rail = fn('renderRail');
  // The line as it has always been. The summary disagrees with it on purpose; that is a
  // ruling, and this is the half of it nobody may quietly "fix".
  assert.match(rail, /const count = mine\.reduce\(\(n, f\) => n \+ folders\.get\(f\)\.length, 0\);/);
  assert.match(rail, /if \(!count\) continue;/);
});

test('the summary is computed only for a collapsed group, and drawn only there', () => {
  const rail = fn('renderRail');
  assert.match(rail, /const summary = g\.collapsed\s*\?\s*groupSummary\(/);
  const header = fn('groupHeader');
  assert.match(header, /const clauses = \(g\.collapsed && summary\?\.clauses\) \|\| \[\];/);
  assert.match(header, /if \(clauses\.length\) \{/);
});

test('the dot reads the summary, not the old top-level `busy`', () => {
  /*
   * The dot's input is the measured hole: computed off `rest`, it missed nested workers
   * entirely. `busy` is gone from the group loop rather than left beside the new number,
   * because two counts of "what is running in here" one line apart is how the wrong one
   * gets read back in.
   */
  const header = fn('groupHeader');
  assert.match(header, /function groupHeader\(g, count, summary = null\)/);
  assert.match(header, /if \(summary\.working\) \{/);
  assert.match(header, /dot\.className = 'dot working shelf-dot';/);
  assert.ok(
    !/\bbusy\b/.test(strip(header)),
    'nothing in the heading reads a `busy` argument any more',
  );
  const rail = fn('renderRail');
  assert.ok(
    !/const busy = mine\.reduce/.test(rail),
    'the group loop no longer computes a top-level busy count',
  );
});

test('the line lives inside the header element — no fourth sibling in a flat list', () => {
  /*
   * The rail is a flat list of siblings and an open group's tint *and* spine are tiled from
   * adjacent full-width ones. A new sibling between a header and its rows cuts both, which
   * is §4.4 of the plan and the trap CLAUDE.md already carries for the tint alone.
   */
  const header = fn('groupHeader');
  assert.match(header, /line\.className = 'shelf-summary';/);
  assert.match(header, /row\.append\(line\);/);
  const rail = fn('renderRail');
  assert.ok(
    !/shelf-summary/.test(rail),
    'the rail appends the header and nothing beside it — the line is the header’s own child',
  );
});

test('nothing in the folded heading carries a vertical margin', () => {
  const declared = strip(styles);
  const block = declared.slice(declared.indexOf('.shelf-summary {'));
  const decls = block.slice(0, block.indexOf('}'));
  assert.match(decls, /padding-top:/);
  assert.ok(!/margin/.test(decls), 'padding, never margin — a margin here cuts the tint and the spine');
  // The wrap is scoped to the collapsed heading, which is what leaves the open one's
  // geometry provably where item 4 measured it (48px first / 49px otherwise).
  // Wrapping is on, and the row gap it silently inherits from the heading's own `gap` is
  // off — or the step between the two lines is two numbers deep with one of them unwritten
  // (measured: 28px of step where 22 was asked for).
  assert.match(styles, /\.shelf-label\.collapsed \{ flex-wrap: wrap; row-gap: 0; \}/);
});

test('the summary line is full width inside the wrapped header', () => {
  const declared = strip(styles);
  const block = declared.slice(declared.indexOf('.shelf-summary {'));
  assert.match(block.slice(0, block.indexOf('}')), /flex: 0 0 100%;/);
});
