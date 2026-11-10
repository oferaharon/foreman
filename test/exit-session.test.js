import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_GONE_TIMEOUT_MS, STILL_UP, exitAndWait, waitNamesGone } from '../server/exit-session.js';
import { parsePane } from '../server/tmux.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * The close's half of ending a session, against a fake pane that draws the committed
 * captures and moves its `❯` the way the real box was measured to: arrows move it and wrap,
 * Enter commits the row under it, a digit **commits** that row (measured: `3` went straight
 * back to the composer), Escape puts the composer back. The clock is injected, so the
 * twenty-second timeout costs nothing.
 *
 * What a fake cannot prove — what Claude Code does with the keys — was measured on the
 * bench and is in `server/exit-box.js`'s header. This proves the panel's half: which keys it
 * sends, in what order, and what it reports.
 */

const ROW_RE = /^\s*(❯\s*)?(\d)\.\s+(.*)$/;

/**
 * A pane. `onExit` is what `/exit` does: `'exit'` (no background work), `'box'` (raise the
 * box from `boxFixture`), or `'ignore'` (a session that never goes).
 */
function fakePane({ onExit = 'box', boxFixture = 'dialog-exit-background.txt', boxText = null, exitAfterPolls = 2, enterExits = true } = {}) {
  const box = (boxText ?? fixture(boxFixture)).split('\n');
  const rows = box.map((l, i) => (ROW_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const labels = rows.map((i) => ROW_RE.exec(box[i])[3]);
  const state = {
    screen: 'composer',
    cursor: rows.findIndex((i) => box[i].includes('❯')),
    live: true,
    leaving: null, // polls until the name frees
    keys: [],
    typed: [],
    committed: null,
  };
  const draw = () => {
    if (state.screen === 'composer') return fixture('pane-idle.txt');
    const out = box.slice();
    rows.forEach((at, n) => {
      out[at] = `${n === state.cursor ? '  ❯ ' : '    '}${n + 1}. ${labels[n]}`;
    });
    return out.join('\n');
  };
  const commit = (n) => {
    state.committed = labels[n];
    if (labels[n] === 'Exit and stop tasks' && enterExits) state.leaving = exitAfterPolls;
    else if (labels[n] === 'Move to background and exit') state.leaving = exitAfterPolls;
    else state.screen = 'composer';
  };
  let t = 0;
  const deps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    sendText: async (_pane, text) => {
      if (!state.live) throw new Error('That pane no longer exists.');
      const held = parsePane(draw());
      if (held.state === 'dialog' || held.state === 'needs-decision') throw new Error('A dialog is open in the terminal');
      state.typed.push(text);
      if (text !== '/exit') return;
      if (onExit === 'exit') state.leaving = exitAfterPolls;
      else if (onExit === 'box') state.screen = 'box';
    },
    sendKeys: async (_pane, ...keys) => {
      for (const k of keys) {
        state.keys.push(k);
        if (state.screen !== 'box') continue;
        if (k === 'Down') state.cursor = (state.cursor + 1) % rows.length;
        else if (k === 'Up') state.cursor = (state.cursor - 1 + rows.length) % rows.length;
        else if (k === 'Enter') commit(state.cursor);
        else if (/^\d$/.test(k)) commit(Number(k) - 1);
        else if (k === 'Escape') state.screen = 'composer';
      }
    },
    capturePane: async () => {
      if (!state.live) throw new Error('no such pane');
      return draw();
    },
    readPaneState: async () => parsePane(draw()),
    liveSessionNames: async () => {
      if (state.leaving !== null) {
        state.leaving -= 1;
        if (state.leaving < 0) state.live = false;
      }
      return state.live ? ['foreman-alpha-close-me'] : ['foreman-alpha-main'];
    },
  };
  return { state, deps };
}

const target = { paneId: '%7', name: 'foreman-alpha-close-me' };

test('no background work: /exit, the name goes, nothing is answered', async () => {
  const { state, deps } = fakePane({ onExit: 'exit' });
  const out = await exitAndWait(target, deps);
  assert.deepEqual(out, { gone: true, stopped: [] });
  assert.deepEqual(state.typed, ['/exit']);
  assert.deepEqual(state.keys, [], 'no key but the /exit itself');
});

test('the box is answered with Exit and stop tasks, by label, and what it stopped is reported', async () => {
  const { state, deps } = fakePane({ boxFixture: 'dialog-exit-background.txt' });
  const out = await exitAndWait(target, deps);
  assert.equal(out.gone, true);
  assert.deepEqual(out.stopped, ['shell · sleep 600', 'monitor · wait for the marker file']);
  assert.equal(state.committed, 'Exit and stop tasks');
  assert.deepEqual(state.keys, ['Enter'], 'the cursor was already on it: one Enter and nothing else');
});

test('the cursor is read, not assumed — a box opened on row 2 is walked back to row 1', async () => {
  const { state, deps } = fakePane({ boxFixture: 'dialog-exit-background-cursor2.txt' });
  const out = await exitAndWait(target, deps);
  assert.equal(out.gone, true);
  assert.equal(state.committed, 'Exit and stop tasks');
  assert.deepEqual(state.keys, ['Up', 'Enter']);
});

test('a digit is never sent to the box, at either width', async () => {
  for (const boxFixture of ['dialog-exit-background.txt', 'dialog-exit-background-narrow.txt', 'dialog-exit-background-cursor2.txt']) {
    const { state, deps } = fakePane({ boxFixture });
    await exitAndWait(target, deps);
    assert.equal(state.keys.some((k) => /^\d$/.test(k)), false, boxFixture);
    assert.equal(state.keys.filter((k) => k === 'Enter').length, 1, boxFixture);
  }
});

test('a box with no Exit and stop tasks row is Escaped, never answered, and the close is refused', async () => {
  const boxText = fixture('dialog-exit-background.txt').replace('Exit and stop tasks', 'Exit and stop all tasks');
  const { state, deps } = fakePane({ boxText });
  const out = await exitAndWait(target, deps);
  assert.equal(out.gone, false);
  assert.match(out.why, /offers no “Exit and stop tasks” row; pressed Escape, so it is still running/);
  assert.deepEqual(state.keys, ['Escape']);
  assert.equal(state.screen, 'composer', 'the box the close raised is not left up behind the refusal');
});

test('a session that never goes is refused after the timeout, by name, with nothing pressed', async () => {
  const { state, deps } = fakePane({ onExit: 'ignore' });
  const out = await exitAndWait(target, deps);
  assert.equal(out.gone, false);
  assert.equal(out.why, STILL_UP);
  assert.deepEqual(state.keys, []);
  assert.ok(deps.now() >= EXIT_GONE_TIMEOUT_MS, 'it waited the whole window');
});

test('answered but still up at the deadline: the box is Escaped and the refusal says what it was told to stop', async () => {
  const { state, deps } = fakePane({ enterExits: false });
  // Enter lands but the session stays on the box, as a session that never honoured it would.
  deps.sendKeys = (orig => async (pane, ...keys) => {
    if (keys[0] === 'Enter') {
      state.keys.push('Enter');
      return;
    }
    return orig(pane, ...keys);
  })(deps.sendKeys);
  const out = await exitAndWait(target, deps);
  assert.equal(out.gone, false);
  assert.match(out.why, new RegExp(`^${STILL_UP}`));
  assert.match(out.why, /it was told to stop shell · sleep 600; monitor · wait for the marker file/);
  assert.deepEqual(state.keys, ['Enter', 'Escape'], 'answered once, then put back — never answered twice');
});

test('/exit refused because the pane already went counts as gone; refused with it still up throws', async () => {
  const gone = fakePane({ onExit: 'exit' });
  gone.state.live = false;
  assert.deepEqual(await exitAndWait(target, gone.deps), { gone: true, stopped: [] });

  const held = fakePane({ boxFixture: 'dialog-exit-background.txt' });
  held.state.screen = 'box'; // somebody else's box, up before the close
  await assert.rejects(exitAndWait(target, held.deps), /dialog is open/);
  assert.deepEqual(held.state.keys, [], 'and nothing was pressed on it');
});

test('waitNamesGone: an unreadable name list never reads as gone', async () => {
  let t = 0;
  const left = await waitNamesGone(['a', 'b'], {
    liveSessionNames: async () => {
      throw new Error('no server');
    },
    timeoutMs: 1000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.deepEqual(left, ['a', 'b']);
  assert.deepEqual(await waitNamesGone([null, undefined], { liveSessionNames: async () => assert.fail('not asked') }), []);
});
