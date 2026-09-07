import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The worker one-liners under a lead card on the phone.
 *
 * A lead card used to say `· 2 workers` and nothing else, so a team on the phone was a
 * number. It now lists them: one muted, indented, **non-interactive** line per live worker,
 * naming its branch and what it is doing.
 *
 * `web/m/app.js` cannot be imported here — it reaches for `document.getElementById` at
 * module scope and there is no browser in `node --test` — so these are held against the
 * source, exactly the way `test/m-start-sheet.test.js` holds the home list's own contracts
 * one file over. Nothing here is a rendered check; what the lines look like on a phone is a
 * pair of eyes and the bench, and the report carries that.
 *
 * Only the things that would break **silently** are pinned, and every one of them has a
 * failure that looks like working software:
 *
 *  - **The order is `orderWorkers`, imported.** Every other order in this panel is recency;
 *    under a lead recency is wrong and it is a ruling (2026-09-07). A list that quietly
 *    re-sorted when a worker spoke would look alive and be unreadable — you would lose the
 *    row you were looking at, and nothing on screen would say why.
 *  - **The list includes `review` workers and the counts still do not.** The two are
 *    deliberately different sets: `· N workers` and `· N in review` must stay disjoint
 *    because a reader adds them, and the *list* must never hide the one worker that has
 *    finished and is waiting on the maintainer. Both halves, or the discrepancy the
 *    maintainer accepted turns into a missing row.
 *  - **The lines are siblings of `.m-team-body` and carry no listener.** The body is a
 *    `<button>`; a `<button>` inside a `<button>` is invalid markup whose disabled form
 *    swallows the child's clicks, and this card has paid for that once already.
 *  - **They are in the home signature, as rendered strings.** `renderHome` returns early on
 *    an unchanged signature, so a line left out of it never repaints — and a raw timestamp
 *    put into it would differ on almost every frame and retire the guard for everything
 *    else on the screen. Both failures are silent.
 *  - **One rule decides the word and the dot.** The word is derived once and the mark is
 *    derived from the word, so a line's colour cannot describe a different state from its
 *    text.
 *  - **`hasBox` and `isWorking` are reused, never re-derived.** They are the card's own two
 *    and a second spelling is this project's oldest lesson.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/m/app.js');
const css = text('web/m/m.css');

/** The body of one top-level function in `web/m/app.js`, by brace balance. */
function fn(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let seen = false;
  for (let i = app.indexOf('{', start); i < app.length; i += 1) {
    if (app[i] === '{') {
      depth += 1;
      seen = true;
    } else if (app[i] === '}') {
      depth -= 1;
      if (seen && depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/* ──────────────────────────────────────────────────────────────── the order ─── */

test('the order is orderWorkers, imported, and there is no second one', () => {
  assert.match(app, /import \{ orderWorkers \} from '\.\.\/worker-order\.js';/);
  assert.match(fn('workerLines'), /orderWorkers\(allTeamWorkers\(repo\)\)/);

  // One caller, and no sort of its own anywhere in the file. `m-start-sheet.test.js` pins
  // that the file's single `.sort(` is `loadTeams`' by-name sort; this is the other half of
  // the same fact from this feature's side — a comparator written here would be a second
  // order for one list, and the wrong one, since `since` is not on a roster row's surface
  // in any form a local sort would find by accident.
  assert.equal(app.match(/orderWorkers/g).length, 2, 'the import and its one call');
  // And no comparator of its own. The file's one `.sort(` is `loadTeams`' by-name sort —
  // `m-start-sheet.test.js` pins that count from the other side — so this checks the four
  // functions this feature owns rather than the file, which would fail on somebody else's
  // legitimate sort and teach the next reader to loosen it.
  for (const f of ['workerLines', 'workerList', 'workerLine', 'allTeamWorkers']) {
    assert.ok(!fn(f).includes('.sort('), `${f} does not sort for itself`);
  }
});

test('the sort key is never recomputed here, and never comes off activity', () => {
  // `orderWorkers` reads `team.since` — the dispatch stamp, written once and never again.
  // Nothing in this file may read it, because a second reading is how "static, by dispatch"
  // quietly becomes "static until something moves".
  assert.ok(!app.includes('team.since'), 'the stamp is the ordering module’s business');
  assert.ok(!app.includes('team?.since'), 'in either spelling');

  // `lastActivity` is in this file — it is what the lead card's idle age is bucketed from —
  // and it must stay out of everything this feature touches. Ordering a team by it is the
  // one behaviour `orderWorkers` exists to prevent, and putting it in a line would put a
  // raw millisecond stamp into the home signature through the back door.
  for (const f of ['workerLines', 'workerName', 'workerWord', 'workerLine', 'workerList']) {
    assert.ok(!fn(f).includes('lastActivity'), `${f} does not read activity`);
  }
});

/* ─────────────────────────────────────────────────── which workers are listed ─── */

test('one spelling of whose worker this is, and the counts are it narrowed', () => {
  // `teamWorkers` is now `allTeamWorkers` filtered, so the `review` exclusion is visibly a
  // narrowing rather than a second, independently-written join that could disagree.
  assert.match(
    fn('allTeamWorkers'),
    /return \(state\.sessions \|\| \[\]\)\.filter\(\(s\) => s\.workerOf === repo\);/,
  );
  assert.match(
    fn('teamWorkers'),
    /return allTeamWorkers\(repo\)\.filter\(\(s\) => s\.team\?\.state !== 'review'\);/,
  );
  assert.equal(
    app.match(/s\.workerOf === repo/g).length,
    1,
    'the join is written exactly once',
  );
});

test('the list includes review workers; the meta line’s two counts still do not', () => {
  // The list is the unfiltered set — the maintainer's ruling of 2026-09-07, taken with the
  // alternative in front of them: the list may read one longer than `· N workers`, and the
  // extra line says `review` on itself.
  assert.match(fn('workerLines'), /allTeamWorkers\(repo\)/);
  assert.ok(!/workerLines[\s\S]{0,300}?'review'/.test(fn('workerLines')), 'and filters none out');

  // And the counts are untouched. `liveWorkers` is still the review-excluding one, and both
  // clauses are still on the meta line in their own words.
  assert.match(fn('liveWorkers'), /return teamWorkers\(repo\)\.length;/);
  const meta = fn('metaParts');
  assert.match(meta, /\$\{row\.workers\} \$\{row\.workers === 1 \? 'worker' : 'workers'\}/);
  assert.match(meta, /\$\{row\.review\} in review/);
});

/* ───────────────────────────────────────────────────── the word and the mark ─── */

test('review outranks a box, which outranks working, and the rest is the raw status', () => {
  assert.match(
    fn('workerWord'),
    /if \(s\.team\?\.state === 'review'\) return 'review';\s*if \(hasBox\(s\)\) return 'waiting';\s*if \(isWorking\(s\)\) return 'working';\s*return s\.status \|\| 'unknown';/,
  );
});

test('the card’s own two tests are reused, not re-derived', () => {
  // `hasBox` and `isWorking` each keep exactly the callers they had plus this one. A local
  // `s.prompt || s.plan` or a `status === 'working'` written out here would be a second
  // answer to a question the card already answers.
  assert.match(fn('workerWord'), /hasBox\(s\)/);
  assert.match(fn('workerWord'), /isWorking\(s\)/);
  assert.equal(app.match(/s\.prompt/g).length, 1, 'the box test is spelled once, in hasBox');
  assert.match(fn('hasBox'), /s\.prompt/);
  assert.equal(
    app.match(/s\.status === 'working'/g).length,
    1,
    'and the running test once, in isWorking',
  );
  assert.match(fn('isWorking'), /s\.status === 'working'/);

  // And `needsKind` is deliberately *not* it: that carries the rail's worker quieting,
  // which is an attention policy, not an answer to what a session is doing. It stays on the
  // tab marks and the lead's own dot.
  assert.ok(!/needsKind\(/.test(fn('workerWord')));
  assert.ok(!/needsKind\(/.test(fn('workerLines')));
});

test('the mark is derived from the word, so the two can never disagree', () => {
  const line = fn('workerLine');
  assert.match(line, /const waiting = w\.word === 'waiting' \|\| w\.word === 'review';/);
  assert.match(line, /const working = w\.word === 'working';/);
  assert.match(line, /slotDot\(kind, waiting \|\| working, workerDotTitle\(w\.word\)\)/);

  // The card's own vocabulary and no third dot. `slotDot` is the one builder, so an unlit
  // slot is painted transparent rather than left out and the names stay in one column.
  assert.match(line, /working \? 'm-dot-work' : 'm-dot-wait'/);
  assert.ok(!/m-dot-[a-z]+/.test(line.replace(/m-dot-work|m-dot-wait/g, '')), 'no new dot kind');
  assert.equal(app.match(/function slotDot\(/g).length, 1);
});

test('a worker holding a box is not sent to the maintainer to answer', () => {
  // The rail quiets a worker's prompt because it is its lead's to answer. The line says the
  // fact and the title says whose it is; `review` is the other half of the wait dot and is
  // a genuinely different fact, which is why they do not share a sentence.
  const title = fn('workerDotTitle');
  assert.match(title, /if \(word === 'review'\) return 'has reported — waiting on your merge word';/);
  assert.match(title, /if \(word === 'waiting'\) return 'holding a box — its lead answers it';/);
});

/* ─────────────────────────────────────────────────────── not a tap target ─── */

test('the lines are siblings of the card body, never inside it, and carry no listener', () => {
  const node = fn('teamNode');
  // Appended to the wrap after the body, not to the body. A `<button>` inside a `<button>`
  // is invalid markup whose disabled form swallows the child's clicks.
  assert.match(node, /wrap\.appendChild\(body\);[\s\S]{0,1400}?wrap\.appendChild\(workerList\(row\)\);/);
  assert.ok(!/body\.appendChild\(workerList/.test(node));

  // Nothing pressable in either builder: no listener, no button, no href.
  for (const builder of ['workerList', 'workerLine']) {
    const src = fn(builder);
    assert.ok(!src.includes('addEventListener'), `${builder} adds no listener`);
    assert.ok(!src.includes("createElement('button')"), `${builder} builds no button`);
    assert.ok(!src.includes("createElement('a')"), `${builder} builds no link`);
    assert.ok(!src.includes('tabIndex') && !src.includes('tabindex'), `${builder} is not focusable`);
  }

  // And the block only exists when there is something in it — no container, no empty gap.
  assert.match(node, /if \(row\.workerList\.length\) wrap\.appendChild\(workerList\(row\)\);/);
});

test('the stylesheet does not dress them as targets either', () => {
  const block = css.slice(css.indexOf('.m-team-workers'), css.indexOf('.m-dots'));
  assert.ok(block.length > 200, 'the worker-line rules sit above the card gutter’s');
  for (const dressing of ['min-height: 44px', ':active', 'cursor:']) {
    assert.ok(!block.includes(dressing), `${dressing} promises a tap this line does not take`);
  }
});

/* ───────────────────────────────────────────────────────────── the repaint ─── */

test('the lines are in the home signature, as the strings that are drawn', () => {
  // Computed on the row, so the signature and the card read one field. `renderHome` returns
  // early on an unchanged signature, so a list left out of it never repaints at all.
  assert.match(fn('homeRow'), /workerList: workerLines\(team\.repo\),/);
  assert.match(app, /r\.workers,\s*r\.review,\s*(?:\/\/[^\n]*\n\s*)*r\.workerList,/);

  // Two rendered strings and nothing else on each entry — no id, no stamp, no session
  // object. A raw `since` or `lastActivity` in here differs on almost every roster frame
  // and would retire the guard for the whole screen.
  assert.match(
    fn('workerLines'),
    /\.map\(\(s\) => \(\{\s*name: workerName\(s\),\s*word: workerWord\(s\),\s*\}\)\);/,
  );

  // The lead-less shape stays total, or `teamNode`'s `.length` throws on a row the start
  // sheet builds from.
  assert.match(fn('homeRow'), /workers: 0,\s*workerList: \[\],/);
});

/* ─────────────────────────────────────────────────────────────── the naming ─── */

test('a worker is named by its branch, not by the roster label that repeats the folder', () => {
  // `sessions.js` slices only the session prefix, so a worker's `label` arrives as
  // `<folder>-<task>` — under a card already titled with that team it would repeat it and
  // then ellipsise away the half that identifies the worker. The chain is the desktop
  // rail's own (`team.branch || team.task`), with the label kept as a last resort so a row
  // the task join missed is still named something.
  assert.match(
    fn('workerName'),
    /return s\.team\?\.branch \|\| s\.team\?\.task \|\| s\.label \|\| 'worker';/,
  );
});

test('a long branch ellipsises rather than widening the page', () => {
  const block = css.slice(css.indexOf('.m-team-worker {'), css.indexOf('.m-dots'));
  // `minmax(0, 1fr)` and not a plain `1fr`: a plain one floors at the content's own width,
  // and a long `agent/<task>` would then push the line wider than a 320px screen and put
  // the whole page into a horizontal scroll.
  assert.match(block, /grid-template-columns: 0\.9rem minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.m-team-worker-name \{\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;\s*\}/);
  // The state word is the fixed half of the line and must never be the one that wraps.
  assert.match(css, /\.m-team-worker-state \{\s*white-space: nowrap;\s*\}/);
});

test('the two words that mean waiting wear the colours the card already gives those facts', () => {
  // One fact, one colour, between a card and the lines under it: amber for a task in
  // `review` (`.m-team-review`'s token) and the decision red for a session holding a box
  // (`.m-team-state.is-blocked`).
  assert.match(css, /\.m-team-worker-state\.is-review \{ color: var\(--working\); \}/);
  assert.match(css, /\.m-team-worker-state\.is-waiting \{ color: var\(--decision\); \}/);
  assert.match(css, /\.m-team-review \{[^}]*color: var\(--working\);/s);
  assert.match(css, /\.m-team-state\.is-blocked \{ color: var\(--decision\); \}/);
});
