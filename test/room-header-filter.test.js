/*
 * The funnel in an open group room's header: the room band row's toggle, drawn a second time.
 *
 * Two things are pinned and nothing else. `paintFilter` — the one function that draws the
 * funnel's face, shared by the band row and the header — takes the base class as a parameter
 * and keeps every state's attributes either way; and the header's wiring is the band's own
 * (`setRailFilter`, `filterState`) rather than a second piece of state, and never joins
 * `composerSig`. No DOM: a button here is an object with the five members `paintFilter` uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paintFilter } from '../web/rooms-band.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

const button = () => {
  const attrs = new Map();
  return {
    className: '',
    tabIndex: 0,
    title: '',
    attrs,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
  };
};
const room = { id: 'room-1', name: 'alpha-beta' };

test('the band row keeps its own class by default', () => {
  const b = button();
  paintFilter(b, room, 'on', () => {});
  assert.equal(b.className, 'room-filter is-on');
});

test('the header passes its own base class, and the state words ride on it', () => {
  const base = 'ghost-btn room-head-filter';
  const cases = { on: ' is-on', off: '', empty: '', none: ' is-none' };
  for (const [state, extra] of Object.entries(cases)) {
    const b = button();
    paintFilter(b, room, state, () => {}, base);
    assert.equal(b.className, `${base}${extra}`, state);
  }
});

test('on is pressed, empty is aria-disabled, and a press on either dead state does nothing', () => {
  const calls = [];
  const on = button();
  paintFilter(on, room, 'on', (id) => calls.push(id), 'x');
  assert.equal(on.attrs.get('aria-pressed'), 'true');
  on.onclick();
  assert.deepEqual(calls, [null], 'a lit funnel lets go');

  const off = button();
  paintFilter(off, room, 'off', (id) => calls.push(id), 'x');
  off.onclick();
  assert.deepEqual(calls, [null, 'room-1'], 'an unlit one narrows to its room');

  for (const dead of ['empty', 'none']) {
    const b = button();
    paintFilter(b, room, dead, (id) => calls.push(id), 'x');
    b.onclick();
  }
  assert.equal(calls.length, 2, 'empty and archived presses reach no filter');
  const empty = button();
  paintFilter(empty, room, 'empty', () => {}, 'x');
  assert.equal(empty.attrs.get('aria-disabled'), 'true');
});

test('the header funnel is the band funnel: one stored value, painted from it', () => {
  const head = app.slice(app.indexOf('function paintGroupFilter('));
  const body = head.slice(0, head.indexOf('\n  }\n'));
  assert.match(body, /filterTarget\(railFilter\.value\)/);
  assert.match(body, /filterState\(/);
  assert.match(body, /setRailFilter\(id \? roomFilterValue\(id\) : ''\)/);
  assert.match(body, /btn\.hidden = st === 'none'/, 'an archived room draws none');
  // setRailFilter repaints every open header, so a press in the band reaches it at once.
  const set = app.slice(app.indexOf('function setRailFilter('));
  assert.match(set.slice(0, set.indexOf('\n}\n')), /p\.paintGroupFilter\(\)/);
});

test('nothing about the funnel joins composerSig', () => {
  const i = app.indexOf('composerSig');
  assert.ok(i >= 0);
  for (const m of app.matchAll(/(?:const|let|function)\s+composerSig[\s\S]*?\n  }\n|composerSig = [\s\S]*?;\n/g)) {
    assert.doesNotMatch(m[0], /railFilter|paintGroupFilter|filterState/);
  }
});
