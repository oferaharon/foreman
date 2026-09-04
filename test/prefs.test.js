import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * `web/prefs.js` runs in a browser, so this stands a `localStorage` up in front of it the
 * way `test/notify.test.js` runs the notification rule in node. The three states worth
 * pinning are the three the desktop's notification control learned to draw: never set,
 * set, and a store that throws rather than answering — which is what `localStorage`
 * actually does where a browser blocks site data, and is the shape that once took the whole
 * panel down at module scope before a row had been drawn.
 *
 * The module reads at import, so each state needs its own import — hence the cache-busting
 * query on the specifier.
 */

const MODULE = new URL('../web/prefs.js', import.meta.url).href;

async function withStorage(impl, run) {
  const had = 'localStorage' in globalThis;
  const prev = globalThis.localStorage;
  globalThis.localStorage = impl;
  try {
    const mod = await import(`${MODULE}?t=${Math.random()}`);
    return await run(mod);
  } finally {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  }
}

/** A store that behaves. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
}

/** A browser with site data blocked: both halves throw, they do not answer null. */
const deniedStore = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('denied', 'SecurityError');
  },
};

test('off with nothing stored', async () => {
  await withStorage(fakeStore(), ({ ghostSend }) => {
    assert.equal(ghostSend.on, false);
  });
});

test('on when the browser has been told so', async () => {
  await withStorage(fakeStore({ 'foreman.ghostSend': '1' }), ({ ghostSend }) => {
    assert.equal(ghostSend.on, true);
  });
});

test('anything other than the stored "1" is off', async () => {
  await withStorage(fakeStore({ 'foreman.ghostSend': 'true' }), ({ ghostSend }) => {
    assert.equal(ghostSend.on, false, 'a truthy-looking string is not the stored answer');
  });
});

test('setting it writes the one key, under the one name', async () => {
  const store = fakeStore();
  await withStorage(store, ({ ghostSend, GHOST_SEND_KEY }) => {
    assert.equal(ghostSend.set(true), true);
    assert.equal(store.map.get(GHOST_SEND_KEY), '1');
    assert.equal(ghostSend.on, true);
    ghostSend.set(false);
    assert.equal(store.map.get(GHOST_SEND_KEY), '0');
    assert.equal(ghostSend.on, false);
  });
});

test('a store that throws is off, and stays usable for the visit', async () => {
  await withStorage(deniedStore, ({ ghostSend }) => {
    // The read is the one that used to take a page down. It must answer, not throw.
    assert.equal(ghostSend.on, false);
    // And a write that cannot be persisted still applies to this window.
    assert.equal(ghostSend.set(true), true);
    assert.equal(ghostSend.on, true);
  });
});

test('no localStorage at all is off, not a crash', async () => {
  await withStorage(undefined, ({ ghostSend }) => {
    assert.equal(ghostSend.on, false);
    assert.doesNotThrow(() => ghostSend.set(true));
  });
});

/*
 * The TASKS filter — the flag, and the set that is its whole meaning.
 *
 * The set is pure data and a pure function, so it is tested the way `web/notify.js`'s
 * rule is: imported into node and asked. What is worth pinning is not that three strings
 * are in a Set, but the four answers a future reader is most likely to get wrong — the
 * three closed states are in, `review` is not, the two *derived* chip states are not, and
 * a state nobody has added yet is shown rather than hidden.
 */

test('the filter is off with nothing stored, and remembers its own key', async () => {
  const store = fakeStore();
  await withStorage(store, ({ hideFinished, HIDE_FINISHED_KEY }) => {
    assert.equal(HIDE_FINISHED_KEY, 'foreman.hideFinished');
    assert.equal(hideFinished.on, false, 'a list that starts short has to explain itself');
    assert.equal(hideFinished.set(true), true);
    assert.equal(store.map.get('foreman.hideFinished'), '1');
  });
});

test('the two flags are two keys, and neither reads the other', async () => {
  await withStorage(fakeStore({ 'foreman.hideFinished': '1' }), ({ ghostSend, hideFinished }) => {
    assert.equal(hideFinished.on, true);
    assert.equal(ghostSend.on, false, 'one stored key must not answer for the other');
  });
});

test('a store that throws leaves the filter off and the page standing', async () => {
  await withStorage(deniedStore, ({ hideFinished }) => {
    assert.equal(hideFinished.on, false);
    assert.equal(hideFinished.set(true), true, 'this visit still behaves');
  });
});

test('the filter hides exactly the three closed states of TASK_STATES', async () => {
  await withStorage(fakeStore(), ({ isFinishedState, CLOSED_TASK_STATES }) => {
    assert.deepEqual([...CLOSED_TASK_STATES].sort(), ['abandoned', 'done', 'failed']);
    for (const s of ['done', 'failed', 'abandoned']) {
      assert.equal(isFinishedState(s), true, `${s} is hidden`);
    }
  });
});

test('review is never hidden, whatever the button is called', async () => {
  await withStorage(fakeStore(), ({ isFinishedState }) => {
    // The sharp one. In plain English a task in `review` IS finished — the worker has
    // stopped and the PR is open — but it is finished only in the sense that it is now
    // waiting on a human, and it is the one row that most needs to be seen.
    assert.equal(isFinishedState('review'), false);
    for (const s of ['pending', 'queued', 'dispatched', 'working']) {
      assert.equal(isFinishedState(s), false, `${s} is open`);
    }
  });
});

test('the derived chip states are shown, not hidden', async () => {
  await withStorage(fakeStore(), ({ isFinishedState }) => {
    // `stuck` and `blocked` are not in `TASK_STATES` at all — `taskChipState` derives them
    // from the live pane and they outrank the record. A row whose chip reads one of them
    // has something holding a pane *now*, and hiding a row that visibly does not say
    // "done" under a control that says "hide finished" would be the control lying.
    assert.equal(isFinishedState('stuck'), false);
    assert.equal(isFinishedState('blocked'), false);
  });
});

test('a state the filter has never heard of is shown', async () => {
  await withStorage(fakeStore(), ({ isFinishedState }) => {
    // The direction that fails visibly. A new state landing silently on the hidden side is
    // the failure nobody would notice; landing on the visible side is the one that gets
    // reported the same afternoon.
    assert.equal(isFinishedState('superseded'), false);
    assert.equal(isFinishedState(undefined), false);
  });
});

test('the three names are the server\'s own, and review is open on both sides', async () => {
  // The one cross-file pin. `web/` cannot import `server/` — these files are served to a
  // browser — so the set is spelled twice on this machine and only a test holds the two
  // spellings together. Same mechanism as `test/logs.test.js` and the launchd label.
  const { TASK_STATES, OPEN_STATES } = await import('../server/tasks.js');
  await withStorage(fakeStore(), ({ CLOSED_TASK_STATES }) => {
    for (const s of CLOSED_TASK_STATES) {
      assert.ok(TASK_STATES.includes(s), `${s} must be a real stored state`);
      assert.equal(OPEN_STATES.has(s), false, `${s} must not be an open one`);
    }
    assert.ok(OPEN_STATES.has('review'));
    assert.equal(CLOSED_TASK_STATES.has('review'), false, 'the filter must never take review');
  });
});
