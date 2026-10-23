import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TAG_MEANINGS, WHAT_TAGS, tagVar } from '../web/task-tags.js';
import { UNTAGGED_TEXT, tagChip, tagMenu } from '../web/task-tag-chip.js';

/*
 * The tag on a task row: what the pill draws, what the menu offers, and the handful of
 * wiring facts in the two lists that would each break silently.
 *
 * `web/app.js` and `web/m/tasks.js` cannot be loaded here — the first reaches for the DOM at
 * module scope and both import `/vendor/marked.js` — so the pure halves were lifted into
 * `web/task-tag-chip.js` and are driven, and the wiring is held against the source the way
 * `test/m-worker-lines.test.js` holds the phone's. What the pill looks like is a pair of
 * eyes on a scratch panel, and the report carries that.
 *
 * What is pinned, and why each one fails quietly:
 *
 *  - **The colour is a variable, never a class.** A pill drawn through `is-<tag>` beside the
 *    state chips is one renamed selector from being painted by a `.team-chip.is-*` rule.
 *  - **The tag is in both repaint signatures.** A retag deliberately leaves `updatedAt`
 *    alone so the row does not jump; a signature without the tag never draws the change.
 *  - **The control stops its own click and its own Enter/Space.** The row opens the brief on
 *    both, and its `keydown` would `preventDefault` the button's own activation.
 *  - **The phone draws no control.** Its tasks tab has none, by design.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** One function's body out of a file, by brace balance from `function <name>(`. */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
}

/** One CSS rule's declarations, by its exact selector. */
function cssRule(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} must exist`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

/* ------------------------------------------------------------- the pill --- */

test('a tagged row draws the word, its meaning, and its colour token', () => {
  for (const tag of WHAT_TAGS) {
    assert.deepEqual(tagChip([tag]), {
      tag,
      text: tag,
      title: `${tag}: ${TAG_MEANINGS[tag]}`,
      colour: tagVar(tag),
    });
  }
});

test('an untagged row draws the faint offer and no colour', () => {
  // A record from before tags, an empty list, and whatever junk the store kept: all three
  // read as untagged, because the reader is `whatTag` and never `task.tags`.
  for (const stored of [undefined, [], ['nonsense'], 'bug', null]) {
    const pill = tagChip(stored);
    assert.equal(pill.tag, null, JSON.stringify(stored));
    assert.equal(pill.text, UNTAGGED_TEXT);
    assert.equal(pill.colour, null, 'nothing sets --tag, so the rule’s own fallback applies');
  }
  assert.equal(UNTAGGED_TEXT, '+ tag');
});

test('a word from a later build is ignored and the what-tag still draws', () => {
  assert.equal(tagChip(['blocked', 'chore']).tag, WHAT_TAGS[3]);
});

/* ------------------------------------------------------------- the menu --- */

test('the menu offers all four, in the leaf’s order, each with its meaning', () => {
  const items = tagMenu([]);
  assert.deepEqual(items.map((i) => i.tag), [...WHAT_TAGS]);
  assert.deepEqual(items.map((i) => i.label), [...WHAT_TAGS]);
  for (const item of items) assert.equal(item.hint, TAG_MEANINGS[item.tag]);
  assert.equal(items.filter((i) => i.checked).length, 0, 'an untagged task has nothing ticked');
});

test('the menu ticks the tag the task carries now, and only that one', () => {
  for (const tag of WHAT_TAGS) {
    const ticked = tagMenu([tag]).filter((i) => i.checked).map((i) => i.tag);
    assert.deepEqual(ticked, [tag]);
  }
  assert.equal(tagMenu(['nonsense']).some((i) => i.checked), false);
});

/* --------------------------------------------------- the desktop wiring --- */

const app = text('web/app.js');

test('the desktop row puts the tag directly after the id, on the chips’ line', () => {
  const render = fnBody(app, 'renderTasks');
  assert.match(render, /line\.append\(chip, id\);\n\s*line\.append\(taskTagControl\(t\)\);/);
});

test('the tag control stops its click and its Enter/Space before the row sees them', () => {
  const control = fnBody(app, 'taskTagControl');
  assert.match(control, /btn\.onclick = \(e\) => \{\n\s*e\.stopPropagation\(\);/);
  assert.match(control, /btn\.onkeydown = \(e\) => \{\n\s*if \(e\.key === 'Enter' \|\| e\.key === ' '\) e\.stopPropagation\(\);/);
  // The colour comes in as a custom property off `tagChip`, never as a class per tag.
  assert.match(control, /style\.setProperty\('--tag', pill\.colour\)/);
  assert.doesNotMatch(control, /is-\$\{/, 'no is-<tag> class');
  // The pick goes to the tag route with the pane's own repo, then repaints.
  assert.match(control, /\/api\/team\/tasks\/\$\{encodeURIComponent\(t\.id\)\}\/tags/);
  assert.match(control, /folder: roomView\.repo/);
  assert.match(control, /refreshTasks\(true\)/);
});

test('the desktop repaint signature carries the tag', () => {
  const refresh = fnBody(app, 'refreshTasks');
  assert.match(refresh, /t\.updatedAt, whatTag\(t\.tags\)\]\.join\(':'\)/);
});

test('the brief modal shows the tag as a read-only fact', () => {
  assert.match(fnBody(app, 'openTaskBrief'), /fact\('tag', whatTag\(t\.tags\)\);/);
});

test('.team-task-tag is a rule of its own, reading --tag', () => {
  const css = text('web/styles.css');
  const rule = cssRule(css, '.team-task-tag');
  assert.match(rule, /background: var\(--tag,/);
  assert.match(rule, /color: var\(--surface\);/);
  // Never a chip, never the room's own tag, never a class per tag: read off the selectors
  // alone, one line each, so a comment naming `.team-chip` cannot trip it.
  const selectors = [...css.matchAll(/^([^\n{}/*][^\n{}]*)\{/gm)].map((m) => m[1]);
  const mine = selectors.filter((sel) => sel.includes('.team-task-tag'));
  assert.ok(mine.length >= 2, `found ${mine.length} .team-task-tag rules`);
  for (const sel of mine) {
    assert.doesNotMatch(sel, /team-chip|room-tag|\.is-/, sel);
  }
});

/* ----------------------------------------------------- the phone wiring --- */

const phone = text('web/m/tasks.js');

test('the phone draws a read-only pill after the id, and nothing on an untagged row', () => {
  const row = fnBody(phone, 'taskRow');
  const id = row.indexOf('line.appendChild(id);');
  const pill = row.indexOf("tag.className = 'm-tk-tag';");
  const plan = row.indexOf("kind.textContent = 'plan';");
  assert.ok(id >= 0 && pill > id && plan > pill, 'id, then the tag, then the plan chip');
  assert.match(row, /if \(pill\.tag\) \{/, 'an untagged row draws nothing');
  assert.match(row, /tag\.style\.setProperty\('--tag', pill\.colour\)/);
  // Read-only: a span, no handler.
  assert.doesNotMatch(row, /tag\.on(click|keydown)/);
  assert.doesNotMatch(row, /createElement\('button'\)/);
});

test('the phone repaint signature and brief carry the tag', () => {
  assert.match(phone, /t\.updatedAt, whatTag\(t\.tags\)\]\.join\(':'\)/);
  assert.match(fnBody(phone, 'openBrief'), /fact\('tag', whatTag\(t\.tags\)\);/);
});

test('.m-tk-tag is a rule of its own in tasks.css, and no other phone sheet uses the name', () => {
  // `web/m/index.html` loads five `m/` sheets into one head (`rail-and-groups#the-phones-five-stylesheets`).
  const rule = cssRule(text('web/m/tasks.css'), '.m-tk-tag');
  assert.match(rule, /background: var\(--tag,/);
  for (const sheet of ['m.css', 'lead.css', 'cards.css', 'rooms.css']) {
    assert.doesNotMatch(text(`web/m/${sheet}`), /m-tk-tag/, sheet);
  }
});
