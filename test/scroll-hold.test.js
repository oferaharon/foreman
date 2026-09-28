import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { holdFromBottom } from '../web/scroll-hold.js';

/*
 * `load earlier` keeps the reader where they were.
 *
 * Two halves, in `test/rail-fold.test.js`'s shape. The first runs the helper in plain Node
 * against a fake box that behaves the way a scrolling element does where it matters: an
 * emptied box clamps `scrollTop` to 0, which is exactly the read-after-swap mistake
 * `docs/traps/rooms.md#a-repaint-that-measures-anything` records. The second is a source
 * scan over `web/app.js`: the `earlier` frame repaints the stream alone and never the whole
 * pane, and `transcript` still does — opening a session lands at the bottom.
 */

/** A scrolling box whose content height `paint` changes, and which clamps like a real one. */
function fakeBox({ scrollHeight, scrollTop, clientHeight = 600 }) {
  let height = scrollHeight;
  let top = scrollTop;
  return {
    clientHeight,
    get scrollHeight() {
      return height;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(v) {
      top = Math.max(0, Math.min(v, Math.max(0, height - clientHeight)));
    },
    /** Swap the content: momentarily empty (the clamp fires), then `next` tall. */
    replace(next) {
      height = 0;
      this.scrollTop = top;
      height = next;
    },
  };
}

test('older messages land above the reader, who stays on the same message', () => {
  // At the very top — where the `load earlier` button is.
  const box = fakeBox({ scrollHeight: 5000, scrollTop: 0 });
  holdFromBottom(box, () => box.replace(8000));
  // 3000px of older messages above; the reader is exactly that far down, looking at what
  // they were looking at, with the new ones reachable by scrolling up.
  assert.equal(box.scrollTop, 3000);
  assert.equal(box.scrollHeight - box.scrollTop, 5000);
});

test('a reader part-way down is held at the same distance from the bottom', () => {
  const box = fakeBox({ scrollHeight: 5000, scrollTop: 1200 });
  holdFromBottom(box, () => box.replace(6500));
  assert.equal(box.scrollTop, 2700);
});

test('the read happens before the paint, not after the swap', () => {
  // The room panel's first draft read `scrollTop` after `replaceChildren` and got 0 every
  // time. Read on the wrong side of the paint here, the box above would answer 0 → the
  // reader lands at 8000 - 8000 = 0 (top of the older messages) instead of 3500.
  const box = fakeBox({ scrollHeight: 5000, scrollTop: 500 });
  holdFromBottom(box, () => box.replace(8000));
  assert.equal(box.scrollTop, 3500);
});

/* ----------------------------------------------------------- source scan --- */

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '..', 'web', 'app.js'), 'utf8');

/** The body of one `case '<name>':` in the socket switch, up to its `return;`. */
function caseBody(name) {
  const at = app.indexOf(`case '${name}':`);
  assert.notEqual(at, -1, `no case '${name}' in web/app.js`);
  const end = app.indexOf('return;\n', app.indexOf('\n', at) + 1);
  // The first `return;` is the session-id guard's; the case ends at the next one.
  const close = app.indexOf('return;\n', end + 1);
  return app.slice(at, close);
}

test("`earlier` repaints the stream alone, held from the bottom — never renderMain", () => {
  const body = caseBody('earlier');
  assert.match(body, /holdFromBottom\(streamEl\.stream, renderStream\)/);
  // renderMain rebuilds the head and the composer and ends with scrollToBottom — the bug,
  // and the textarea torn out from under a draft.
  assert.doesNotMatch(body, /renderMain\(\)/);
  assert.doesNotMatch(body, /scrollToBottom\(\)/);
});

test('`transcript` still goes through renderMain, so opening a session lands at the bottom', () => {
  assert.match(caseBody('transcript'), /renderMain\(\)/);
  const main = app.slice(app.indexOf('function renderMain()'), app.indexOf('function emptyState('));
  assert.match(main, /scrollToBottom\(\);/);
});

test('app.js imports the helper rather than spelling it twice', () => {
  assert.match(app, /import \{ holdFromBottom \} from '\.\/scroll-hold\.js';/);
});
