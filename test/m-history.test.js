import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PHONE_TABS } from '../web/prefs.js';
import { backAction, bootTab, homeTabOf, pushRoute, ROOT_STATE, stampFor, tabForKind } from '../web/m/history.js';

/*
 * The phone's history, as the installed Home Screen app measured it (iOS 27 Simulator, an
 * injected beacon on every load and history event): `‹` used to push the list's hash, so
 * the back gesture landed on the session it had just left; and a document load on a
 * conversation route forgot which list it came from, so a standalone session's `‹` went to
 * Leads. `web/m/history.js` is the rules; this drives them over a model of the stack.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

/** A history stack, with the shell's two hooks wired the way `app.js` wires them. */
function phone(start = '#/standalones') {
  const entries = [{ hash: start, state: ROOT_STATE }];
  let at = 0;
  let lastHash = null;
  const h = {
    get hash() {
      return entries[at].hash;
    },
    get state() {
      return entries[at].state;
    },
    get length() {
      return entries.length;
    },
    /** `navigate`'s stamp, run on every landing. */
    land() {
      const stamp = stampFor(entries[at].state, lastHash, entries[at].hash);
      if (stamp) entries[at].state = stamp;
      lastHash = entries[at].hash;
    },
    /** `pushRoute`: a push, which drops any forward entries. */
    push(hash) {
      entries.splice(at + 1);
      entries.push({ hash, state: null });
      at += 1;
      h.land();
    },
    /** `replaceRoute`: in place, state kept. */
    replace(hash) {
      entries[at].hash = hash;
      h.land();
    },
    /** The back gesture, and `history.back()`. */
    back() {
      if (at === 0) return false;
      at -= 1;
      h.land();
      return true;
    },
    forward() {
      if (at === entries.length - 1) return false;
      at += 1;
      h.land();
      return true;
    },
    /** `‹`: `goHome`. */
    chevron(home) {
      const act = backAction(entries[at].state, home);
      if (act.op === 'back') h.back();
      else h.replace(act.hash);
    },
  };
  h.land();
  return h;
}

test('after ‹, the back gesture does not land on the session that was just left', () => {
  const h = phone('#/standalones');
  h.push('#/session/pane-0');
  h.chevron('#/standalones');
  assert.equal(h.hash, '#/standalones');
  assert.equal(h.length, 2, 'the chevron stepped back; it did not push a third entry');
  // What the gesture does from the list: nothing behind the root, so it stays put — never
  // the session again.
  assert.equal(h.back(), false);
  assert.equal(h.hash, '#/standalones');
});

test('the old behaviour, pinned so the difference is visible: pushing the list hash bounced', () => {
  const h = phone('#/standalones');
  h.push('#/session/pane-0');
  h.push('#/standalones'); // what `location.hash = homeHash()` did
  h.back();
  assert.equal(h.hash, '#/session/pane-0');
});

test('the gesture and the chevron land on the same entry', () => {
  const a = phone('#/leads');
  a.push('#/lead/abc');
  a.back();
  const b = phone('#/leads');
  b.push('#/lead/abc');
  b.chevron('#/leads');
  assert.equal(a.hash, b.hash);
});

test('a round trip repeated stays two entries deep', () => {
  const h = phone('#/standalones');
  for (let i = 0; i < 5; i++) {
    h.push(`#/session/pane-${i}`);
    h.chevron('#/standalones');
  }
  assert.equal(h.hash, '#/standalones');
  // Forward from the list reaches only the last one opened, as in any browser.
  assert.equal(h.length, 2);
});

test('a conversation opened cold replaces itself with its list rather than leaving itself behind', () => {
  const h = phone('#/session/pane-0');
  h.chevron('#/standalones');
  assert.equal(h.hash, '#/standalones');
  assert.equal(h.length, 1);
  assert.equal(h.back(), false);
});

test('a sleeper that wakes under the reader keeps where it was opened from', () => {
  const h = phone('#/leads');
  h.push('#/asleep/voice-gamma-lead');
  h.replace('#/lead/abc'); // `onAsleepRoster` → `replaceRoute(liveRouteFor(row))`
  assert.deepEqual(h.state, { from: '#/leads' });
  h.chevron('#/leads');
  assert.equal(h.hash, '#/leads');
  assert.equal(h.length, 2);
});

test('only a fresh push is stamped', () => {
  assert.deepEqual(stampFor(null, '#/standalones', '#/session/x'), { from: '#/standalones' });
  // An entry that already carries state — the root, a replace, one reached by the gesture.
  assert.equal(stampFor(ROOT_STATE, '#/session/x', '#/standalones'), null);
  assert.equal(stampFor({ from: '#/leads' }, '#/rooms', '#/lead/x'), null);
  // The first landing of a document, and a landing on the hash it was already on.
  assert.equal(stampFor(null, null, '#/leads'), null);
  assert.equal(stampFor(null, '#/leads', '#/leads'), null);
});

test('backAction steps back only from an entry pushed inside the app', () => {
  assert.deepEqual(backAction({ from: '#/standalones' }, '#/standalones'), { op: 'back' });
  assert.deepEqual(backAction(ROOT_STATE, '#/standalones'), { op: 'replace', hash: '#/standalones' });
  assert.deepEqual(backAction(null, '#/rooms'), { op: 'replace', hash: '#/rooms' });
  assert.deepEqual(backAction({ from: 7 }, '#/leads'), { op: 'replace', hash: '#/leads' });
});

test('every kind drawn on one list names it; a sleeper does not', () => {
  assert.equal(tabForKind('session'), 'standalones');
  assert.equal(tabForKind('lead'), 'leads');
  assert.equal(tabForKind('worker'), 'leads');
  assert.equal(tabForKind('room'), 'rooms');
  assert.equal(tabForKind('asleep'), null);
  assert.equal(tabForKind('home'), null);
  for (const kind of ['session', 'lead', 'worker', 'room']) assert.ok(PHONE_TABS.includes(tabForKind(kind)));
});

test('a document load on a standalone session comes back to Standalones, not Leads', () => {
  // The measured case: storage said `standalones`, the hash said `#/session/…`, and the
  // shell started on `leads`.
  assert.equal(bootTab('session', ROOT_STATE, 'leads', PHONE_TABS), 'standalones');
  assert.equal(bootTab('session', null, 'standalones', PHONE_TABS), 'standalones');
});

test('a sleeper reloaded knows its list from its entry, else from the remembered tab', () => {
  assert.equal(bootTab('asleep', { from: '#/standalones' }, 'leads', PHONE_TABS), 'standalones');
  assert.equal(bootTab('asleep', ROOT_STATE, 'standalones', PHONE_TABS), 'standalones');
  assert.equal(bootTab('asleep', null, 'nonsense', PHONE_TABS), 'leads');
  assert.equal(bootTab('home', null, 'rooms', PHONE_TABS), 'rooms');
});

test('homeTabOf reads only a tab hash', () => {
  assert.equal(homeTabOf('#/rooms', PHONE_TABS), 'rooms');
  assert.equal(homeTabOf('#/standalones/', PHONE_TABS), 'standalones');
  assert.equal(homeTabOf('#/session/x', PHONE_TABS), null);
  assert.equal(homeTabOf('#/nope', PHONE_TABS), null);
  assert.equal(homeTabOf(undefined, PHONE_TABS), null);
});

test('no back control on the phone pushes a hash any more, and nothing routes by location.replace', () => {
  for (const rel of ['web/m/app.js', 'web/m/lead.js', 'web/m/rooms.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /location\.hash\s*=\s*[^;]*homeHash/, `${rel} pushes homeHash`);
    // `location.replace` drops the entry's state, and with it where the reader came from.
    assert.doesNotMatch(src, /location\.replace\(/, `${rel} routes by location.replace`);
  }
  const app = read('web/m/app.js');
  assert.match(app, /goHome,/);
  assert.match(read('web/m/lead.js'), /view\.ctx\.goHome\(\)/);
  assert.match(read('web/m/rooms.js'), /view\.ctx\.goHome\(\)/);
});

/** Just enough of `window` for `pushRoute`: a location, `pushState`, timers and events. */
function fakeWindow(hash = '#/standalones') {
  const base = 'http://phone.test/m/';
  const w = {
    location: { hash, get href() { return base + w.location.hash; } },
    pushed: [],
    timers: [],
    events: [],
    history: {
      pushState(state, _title, url) {
        w.pushed.push({ state, url });
        w.location.hash = url;
      },
    },
    setTimeout(fn) { w.timers.push(fn); },
    dispatchEvent(e) { w.events.push(e); },
    HashChangeEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
  };
  return w;
}

test('pushRoute pushes a stamped entry instead of navigating', () => {
  const w = fakeWindow('#/standalones');
  assert.equal(pushRoute('#/session/pane-0', w), true);
  assert.deepEqual(w.pushed, [{ state: { from: '#/standalones' }, url: '#/session/pane-0' }]);
  assert.equal(w.location.hash, '#/session/pane-0');
  // `navigate` would not re-stamp it, and `‹` steps back from it.
  assert.equal(stampFor(w.pushed[0].state, '#/standalones', '#/session/pane-0'), null);
  assert.deepEqual(backAction(w.pushed[0].state, '#/standalones'), { op: 'back' });
});

test('pushRoute delivers its hashchange as a task, not inline', () => {
  const w = fakeWindow('#/leads');
  pushRoute('#/lead/abc', w);
  assert.equal(w.events.length, 0, 'nothing routed before the caller returned');
  w.timers.forEach((fn) => fn());
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].type, 'hashchange');
  assert.equal(w.events[0].oldURL, 'http://phone.test/m/#/leads');
  assert.equal(w.events[0].newURL, 'http://phone.test/m/#/lead/abc');
});

test('pushRoute onto the hash already showing adds no entry', () => {
  const w = fakeWindow('#/rooms');
  assert.equal(pushRoute('#/rooms', w), false);
  assert.equal(pushRoute('', w), false);
  assert.equal(w.pushed.length, 0);
  assert.equal(w.timers.length, 0);
});

test('nothing on the phone assigns location.hash: on a real iPhone that reloads the page', () => {
  // Measured on iOS 27: an assigned hash is a navigation, and the UI process answers it with a
  // process swap and a whole document load. See the note at the top of `web/m/history.js`.
  for (const rel of ['web/m/app.js', 'web/m/lead.js', 'web/m/rooms.js', 'web/m/cards.js', 'web/m/tasks.js', 'web/m/asleep.js', 'web/m/recent.js', 'web/m/roles.js']) {
    const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /location\.hash\s*=(?!=)/, `${rel} assigns location.hash`);
    assert.doesNotMatch(code, /location\.(assign|reload)\(|location\.href\s*=(?!=)/, `${rel} navigates the document`);
  }
});
