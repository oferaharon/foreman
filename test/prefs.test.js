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
