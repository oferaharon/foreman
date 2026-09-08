import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ghostAction,
  ghostSig,
  INTERRUPT_TITLE,
  SEND_TITLE,
  USE_TITLE,
} from '../web/ghost-action.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, '..', p), 'utf8');

/*
 * The suggested-prompt line shares the interrupt button's row, and the button carries
 * whichever of the two meanings is live. `web/ghost-action.js` is the rule; the tests below
 * are the things that would actually cost something if it drifted.
 */

test('no suggestion - the button is interrupt', () => {
  for (const nothing of [null, undefined, '']) {
    const a = ghostAction(nothing, false);
    assert.deepEqual(a, { act: 'interrupt', title: INTERRUPT_TITLE, suggests: false });
    // The preference cannot conjure a suggestion out of nothing.
    assert.deepEqual(ghostAction(nothing, true), a);
  }
});

test('a suggestion with the auto-send flag off reads `use`', () => {
  assert.deepEqual(ghostAction('fix slugify and add a test for it', false), {
    act: 'use',
    title: USE_TITLE,
    suggests: true,
  });
});

test('and with it on it reads `send`, because that is what pressing it does', () => {
  // The label is the behaviour, not a description of it: one press into a live session.
  assert.deepEqual(ghostAction('fix slugify and add a test for it', true), {
    act: 'send',
    title: SEND_TITLE,
    suggests: true,
  });
});

test('the two meanings are mutually exclusive - the one that would cost something', () => {
  // A press that fires Escape into a session while the word in front of it read `send` is
  // the whole reason the rule is a function rather than three lines at the call site.
  for (const sendOn of [true, false]) {
    for (const text of [null, '', 'a suggestion']) {
      const { act, suggests } = ghostAction(text, sendOn);
      assert.equal(suggests, act !== 'interrupt');
      assert.equal(suggests, Boolean(text));
      if (text) assert.notEqual(act, 'interrupt', 'never interrupt beside a live offer');
      else assert.equal(act, 'interrupt', 'never send with nothing to send');
    }
  }
});

test('the repaint key changes with the word as well as with the text', () => {
  const text = 'fix slugify';
  // The flag is half the key, not decoration - a key holding only the text would leave a
  // button reading `use` behind a setting that now sends.
  assert.notEqual(ghostSig(text, true), ghostSig(text, false));
  assert.notEqual(ghostSig(text, true), ghostSig('fix slug', true));
  assert.equal(ghostSig(text, true), ghostSig(text, true));
  // Nothing on offer is one key whichever way the flag is set: the row is in one state.
  assert.equal(ghostSig(null, true), ghostSig('', false));
});

test('the key is joined with something an editor can see', () => {
  // `mergeSig` shipped with three control bytes inside a pair of quotes, which reads as an
  // empty-string join in every editor there is - and an empty join lets two different
  // states spell one key.
  assert.equal(ghostSig('a|b', false), 'use|a|b');
  for (const ch of ghostSig('a|b', false)) {
    assert.ok(ch.codePointAt(0) >= 32, 'no invisible character in the join');
  }
});

/* ---- and the properties that live in the wiring rather than in the rule ---- */

test('the button is one node whose word and handler are swapped in place', () => {
  const app = read('web/app.js');
  const fn = app.slice(app.indexOf('function paintGhostButton('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  // Bound per state, never per node identity: the handler and the visible word are set in
  // the same synchronous pass, so a click landing across a swap runs what the word said.
  assert.match(
    body,
    /stop\.onclick = suggests \? \(\) => useGhost\(text\) : \(\) => sendKey\('interrupt'\)/,
  );
  // and the handler is reassigned every paint rather than guarded, because it closes over
  // this suggestion. Only the visible parts sit behind the guard.
  assert.ok(
    body.indexOf('stop.onclick') < body.indexOf('if (stop.dataset.act === act) return;'),
    'the handler is rebound before the guard can return',
  );
  assert.doesNotMatch(body, /replaceChildren|createElement|remove\(\)/, 'the node is never rebuilt');
});

test('the interrupt button never moves: the widest word is always in the box', () => {
  const css = read('web/styles.css');
  // `interrupt` is nine characters and `use` is three; on a right-aligned row the left edge
  // would walk sideways at the end of every turn. The hidden pseudo holds the width.
  assert.match(css, /\.composer-above > \.ghost-btn \{[^}]*display: grid;/);
  assert.match(css, /\.composer-above > \.ghost-btn::before \{[^}]*content: 'interrupt';/);
  assert.match(css, /\.composer-above > \.ghost-btn::before \{[^}]*visibility: hidden;/);
  // Both in the one cell, or the live word auto-places onto a second row and the button
  // becomes twice as tall.
  assert.match(css, /\.composer-above > \.ghost-btn::before \{[^}]*grid-area: 1 \/ 1;/);
  assert.match(css, /\.composer-above > \.ghost-btn > \.ghost-btn-label \{ grid-area: 1 \/ 1; \}/);
});

test('the strip still collapses to nothing when there is nothing above the composer', () => {
  const css = read('web/styles.css');
  const app = read('web/app.js');
  // `.composer-above:empty` is load-bearing, which is why both blocks are appended and
  // removed rather than hidden. A permanent child would stop the selector matching.
  assert.match(css, /\.composer-above:empty \{ display: none; \}/);
  const fn = app.slice(app.indexOf('function renderGhostLine('));
  assert.match(fn.slice(0, 1200), /ghost\.remove\(\);/);
});

test('the suggestion shares the row and only the merge block takes one of its own', () => {
  const css = read('web/styles.css');
  assert.match(css, /\.composer-above \{[^}]*flex-wrap: wrap;/);
  // Measured: `align-items: center` on the row left every rect identical and still moved
  // four antialiased pixels on the button's corner radius. The line centres itself instead.
  assert.doesNotMatch(css, /\.composer-above \{[^}]*align-items:/);
  assert.ok(css.includes('.ghost-line {'), 'the line rule is still there to carry it');
  // …and it carries `min-width: 0` beside the basis. Making this strip a row is what gave
  // the block a content-based automatic minimum, which beat `100%` and sent it out over the
  // rail; `test/merge-block-width.test.js` is where that measurement lives.
  assert.match(css, /\.composer-above\.has-merge > \.merge-queue \{ flex: 0 0 100%; min-width: 0; \}/);
  // The old column rules put the line above the button; nothing may put it back.
  assert.doesNotMatch(css, /\.composer-above\.has-ghost/);
  assert.doesNotMatch(css, /\.composer-above\.has-merge \{[^}]*flex-direction: column;/);
  // And the line itself flows into what is left of the row rather than filling it. The
  // basis is the load-bearing half: a wrapping flex container breaks its lines on each
  // item's hypothetical size, so `auto` there asks for the whole suggestion's max-content
  // width and puts the button on a row of its own - measured, at 197 characters.
  // Bounded to the one rule block on purpose: an unbounded `[\s\S]*?` here reaches the next
  // `flex:` anywhere in a 200KB stylesheet and proves nothing about this selector.
  const line = css.slice(css.indexOf('.ghost-line {'));
  const block = line.slice(0, line.indexOf('}'));
  assert.match(block, /flex: 1 1 0;/);
  assert.match(block, /min-width: 0;/);
  assert.match(block, /align-self: center;/);
  assert.doesNotMatch(block, /flex: 1 1 auto;/);
});

test('the line carries no button of its own any more', () => {
  const css = read('web/styles.css');
  const app = read('web/app.js');
  assert.doesNotMatch(css, /\.ghost-line-use/);
  assert.doesNotMatch(app, /ghost-line-use/);
  // The phone has its own suggestion row (`m-ghost*`, `web/m/lead.css`) and is untouched by
  // any of this - it imports `prefs.js` and nothing else that moved.
  assert.match(read('web/m/lead.css'), /\.m-ghost-use/);
});
