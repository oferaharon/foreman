import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { backgroundWords } from '../web/background.js';
import { needsKind } from '../web/notify.js';

/*
 * Background activity — the rail's second dot and the line above the composer.
 *
 * The parse is pinned against real captures in `test/pane.test.js`. What is pinned here is
 * everything after it that comes apart **silently**: a count remembered across a box (a row
 * that pulses forever behind a permission prompt), a field missing from `#diff` or from one
 * of the two roster builders (a dot that appears only when something unrelated moves), the
 * line joining `composerSig` (a textarea torn down under a reader every few seconds), and a
 * notification nobody meant to add.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const sessions = text('server/sessions.js');

/** One function body by balancing braces from its declaration. */
const fn = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `\`${name}\` must exist`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/** One CSS rule by its exact selector, braces and all. */
const rule = (selector) => {
  const i = styles.indexOf(`${selector} {`);
  assert.ok(i >= 0, `\`${selector} {\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/* ------------------------------------------------------------- words --- */

test('the words are the terminal’s, agents first, zeros left out', () => {
  assert.equal(backgroundWords({ agents: 5, shells: 5, monitors: 2 }), '5 agents, 5 shells, 2 monitors');
  assert.equal(backgroundWords({ agents: 0, shells: 0, monitors: 1 }), '1 monitor');
  assert.equal(backgroundWords({ agents: 1, shells: 1, monitors: 0 }), '1 agent, 1 shell');
  assert.equal(backgroundWords({ agents: 7, shells: 0, monitors: 0 }), '7 agents');
});

test('nothing running, and nothing readable, both say nothing', () => {
  assert.equal(backgroundWords({ agents: 0, shells: 0, monitors: 0 }), '');
  // `null` is a box hiding the mode line — not "none", but not something to draw either.
  assert.equal(backgroundWords(null), '');
  assert.equal(backgroundWords(undefined), '');
});

/* ------------------------------------------------------------ roster --- */

test('both roster builders carry it, straight from the scrape', () => {
  // The bound loop and the pane-only loop. Missing the second is how a field silently never
  // appears for a pane that has no transcript yet.
  assert.match(sessions, /background: scrape\?\.background \?\? null,/);
  assert.match(sessions, /background: scrape\.background \?\? null,/);
});

test('it is dropped behind a box, never remembered the way `bypass` is', () => {
  // No per-pane memory for it at all: background work can end while a box is up, and a
  // remembered count is a row that pulses forever behind a permission prompt.
  assert.doesNotMatch(sessions, /this\.background\w*\s*=\s*new Map/);
  assert.doesNotMatch(sessions, /remember\w*\([^)]*background/i);
});

test('a count that moves on its own reaches a browser', () => {
  const start = sessions.indexOf('#diff(next) {');
  assert.ok(start >= 0, '`#diff` must exist');
  const diff = sessions.slice(start, sessions.indexOf('return false;', start));
  assert.match(diff, /JSON\.stringify\(prev\.background\) !== JSON\.stringify\(s\.background\)/);
});

/* -------------------------------------------------------------- rail --- */

test('the rail draws the dot or the padlock, never both, and the dot wins', () => {
  const row = fn(app, 'sessionRow');
  const dot = row.indexOf('backgroundDot(s)');
  const mark = row.indexOf('bindingMark(s)');
  assert.ok(dot > 0 && mark > dot, 'the background dot is asked first');
  assert.match(row, /if \(bg\) btn\.append\(bg\);\s*else \{\s*const mark = bindingMark\(s\);/);
});

test('the dot sits in the reserved row-2 cell and adds no margin', () => {
  const css = rule('.session .dot.bg-dot');
  assert.match(css, /grid-column: 1;/);
  assert.match(css, /grid-row: 2;/);
  assert.match(css, /margin-top: 0;/, '`.session .dot` gives every dot 0.5rem otherwise');
  assert.doesNotMatch(css, /margin-(bottom|left|right)|margin:/);
  assert.match(css, /background: var\(--working\);/);
  assert.match(css, /animation: pulse /);
});

test('reduced motion stills it, beside the working dot', () => {
  assert.match(styles, /\.dot\.working,\s*\.session \.dot\.bg-dot \{ animation: none; \}/);
});

/* ---------------------------------------------------------- composer --- */

test('the composer line is not in `composerSig`', () => {
  const start = app.indexOf('const composerSig = (s) =>');
  assert.ok(start >= 0);
  const sig = app.slice(start, app.indexOf("].join('|');", start));
  assert.doesNotMatch(sig, /background/);
});

test('it rides the roster beat and every composer build', () => {
  const head = fn(app, 'renderHead');
  assert.match(head, /renderQueue\(\);\s*renderBackgroundLine\(\);\s*renderGhostLine\(\);/);
  assert.match(fn(app, 'buildComposer'), /renderBackgroundLine\(\);\s*renderMergeQueue\(\);/);
});

test('it is appended and removed, never hidden, so `.composer-above:empty` still fires', () => {
  const line = fn(app, 'renderBackgroundLine');
  assert.match(line, /bgLine\.remove\(\);/);
  assert.match(line, /above\.prepend\(bgLine\);/);
  assert.doesNotMatch(line, /\.hidden\s*=/);
  assert.match(styles, /\.composer-above:empty \{ display: none; \}/);
});

test('the merge block goes under the background line whichever painted last', () => {
  assert.match(fn(app, 'renderMergeQueue'), /if \(bgLine\?\.parentNode === above\) bgLine\.after\(merge\);\s*else above\.prepend\(merge\);/);
});

/* ------------------------------------------------------ notification --- */

test('background work never raises a notification', () => {
  const busy = { status: 'idle', background: { agents: 5, shells: 5, monitors: 2 } };
  assert.equal(needsKind(busy), null);
  assert.equal(needsKind({ ...busy, status: 'working' }), null);
});
