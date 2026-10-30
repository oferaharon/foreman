import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLEAR_COMMAND,
  CLEAR_WORDS,
  clearView,
  DEFAULT_CLEAR_PREP,
  repliedTo,
  settled,
  startClear,
  stepClear,
} from '../web/clear-phase.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, '..', p), 'utf8');

/*
 * The composer's two-step Clear button. `web/clear-phase.js` is the rule; these are the
 * transitions that would cost something if they drifted — above all an early `clear now`,
 * which would offer `/clear` before the session had read the prep message.
 */

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const PREP = DEFAULT_CLEAR_PREP;

const row = (over = {}) => ({
  id: 'sess-1',
  paneId: '%3',
  interactive: true,
  status: 'idle',
  prompt: null,
  question: null,
  plan: null,
  queued: [],
  ...over,
});

const phase = (rec, s) => clearView(rec, s).phase;

test('the words and the commands are the ones the maintainer asked for', () => {
  assert.equal(DEFAULT_CLEAR_PREP, 'prepare to clear the session');
  assert.equal(CLEAR_COMMAND, '/clear');
  assert.deepEqual(CLEAR_WORDS, { idle: 'clear', preparing: 'preparing…', ready: 'clear now' });
});

test('no record is `clear`, pressable on an interactive session and not on a read-only one', () => {
  const v = clearView(null, row());
  assert.equal(v.phase, 'idle');
  assert.equal(v.word, 'clear');
  assert.equal(v.disabled, false);
  assert.equal(clearView(null, row({ interactive: false })).disabled, true);
  assert.equal(clearView(null, null).disabled, true);
});

test('right after the press the roster still says idle — that is `preparing…`, never `clear now`', () => {
  const rec = stepClear(startClear(row(), PREP, T0), row(), []);
  const v = clearView(rec, row());
  assert.equal(v.phase, 'preparing');
  assert.equal(v.word, 'preparing…');
  assert.equal(v.disabled, true);
});

test('the full cycle: working, then idle with a reply in the transcript, is `clear now`', () => {
  let rec = startClear(row(), PREP, T0);
  rec = stepClear(rec, row({ status: 'working' }), []);
  assert.equal(phase(rec, row({ status: 'working' })), 'preparing');

  const msgs = [
    { kind: 'user', text: PREP, ts: iso(T0 + 300) },
    { kind: 'assistant', text: 'Ready — summary written.', ts: iso(T0 + 4000) },
  ];
  rec = stepClear(rec, row(), msgs);
  const v = clearView(rec, row());
  assert.equal(v.phase, 'ready');
  assert.equal(v.word, 'clear now');
  assert.equal(v.disabled, false);
});

test('either witness is enough: a reply alone, or having been seen working alone', () => {
  const msgs = [
    { kind: 'user', text: PREP, ts: iso(T0 + 300) },
    { kind: 'assistant', text: 'ok', ts: iso(T0 + 900) },
  ];
  // A turn so quick no poll saw it working.
  assert.equal(phase(stepClear(startClear(row(), PREP, T0), row(), msgs), row()), 'ready');
  // A transcript that never showed the message the way it was sent.
  let rec = stepClear(startClear(row(), PREP, T0), row({ status: 'working' }), []);
  rec = stepClear(rec, row(), []);
  assert.equal(phase(rec, row()), 'ready');
});

test('the prep message without a reply yet is not a witness', () => {
  const msgs = [{ kind: 'user', text: PREP, ts: iso(T0 + 300) }];
  assert.equal(repliedTo(msgs, PREP, T0), false);
  assert.equal(phase(stepClear(startClear(row(), PREP, T0), row(), msgs), row()), 'preparing');
});

test('an older copy of the same words, answered long ago, is not this press', () => {
  const msgs = [
    { kind: 'user', text: PREP, ts: iso(T0 - 3_600_000) },
    { kind: 'assistant', text: 'ok', ts: iso(T0 - 3_590_000) },
  ];
  assert.equal(repliedTo(msgs, PREP, T0), false);
});

test('whitespace differences in the transcript still match', () => {
  const msgs = [
    { kind: 'user', text: `  prepare to clear\nthe session `, ts: iso(T0 + 10) },
    { kind: 'assistant', text: 'ok', ts: iso(T0 + 20) },
  ];
  assert.equal(repliedTo(msgs, PREP, T0), true);
});

test('a queued prep message: working on something else is not the witness', () => {
  const s = row({ status: 'working', queued: [{ id: 'q1', text: PREP }] });
  let rec = stepClear(startClear(row(), PREP, T0), s, []);
  assert.equal(rec.sawBusy, false);
  // The earlier turn ends; the prep is still queued.
  rec = stepClear(rec, row({ queued: [{ id: 'q1', text: PREP }] }), []);
  assert.equal(phase(rec, row({ queued: [{ id: 'q1', text: PREP }] })), 'preparing');
  // Delivered and running.
  rec = stepClear(rec, row({ status: 'working' }), []);
  assert.equal(rec.sawBusy, true);
  assert.equal(phase(rec, row()), 'ready');
});

test('a question mid-prep keeps it waiting until it is answered and the session settles', () => {
  let rec = stepClear(startClear(row(), PREP, T0), row({ status: 'working' }), []);
  const asking = row({ status: 'dialog', question: { kind: 'single', question: 'Which?', options: [] } });
  rec = stepClear(rec, asking, []);
  assert.equal(phase(rec, asking), 'preparing');
  const permission = row({ status: 'needs-decision', prompt: { options: [] } });
  assert.equal(phase(rec, permission), 'preparing');
  const plan = row({ status: 'needs-decision', plan: { header: 'p', options: [] } });
  assert.equal(phase(rec, plan), 'preparing');
  // Answered; back to work.
  rec = stepClear(rec, row({ status: 'working' }), []);
  assert.equal(phase(rec, row({ status: 'working' })), 'preparing');
  assert.equal(phase(rec, row()), 'ready');
});

test('anything queued holds `clear now` back — /clear behind a message clears the wrong thing', () => {
  const rec = { ...startClear(row(), PREP, T0), sawBusy: true };
  assert.equal(phase(rec, row({ queued: [{ id: 'x' }] })), 'preparing');
  assert.equal(phase(rec, row()), 'ready');
});

test('`clear now` goes back to `preparing…` while the session works again, and returns', () => {
  const rec = { ...startClear(row(), PREP, T0), replied: true };
  assert.equal(phase(rec, row()), 'ready');
  assert.equal(phase(stepClear(rec, row({ status: 'working' }), []), row({ status: 'working' })), 'preparing');
  assert.equal(phase(rec, row()), 'ready');
});

test('a new session id in the pane ends it: /clear, from here or typed in the terminal', () => {
  const rec = { ...startClear(row(), PREP, T0), sawBusy: true };
  assert.equal(stepClear(rec, row({ id: 'sess-2' }), []), null);
  assert.equal(phase(null, row({ id: 'sess-2' })), 'idle');
  assert.equal(stepClear(rec, null, []), null);
});

test('stepClear never mutates the record it was handed', () => {
  const rec = Object.freeze(startClear(row(), PREP, T0));
  const next = stepClear(rec, row({ status: 'working' }), []);
  assert.notEqual(next, rec);
  assert.equal(rec.sawBusy, false);
  assert.equal(next.sawBusy, true);
});

test('settled is idle with nothing holding it, and only that', () => {
  assert.equal(settled(row()), true);
  for (const status of ['working', 'dialog', 'needs-decision', 'unknown']) assert.equal(settled(row({ status })), false);
  assert.equal(settled(row({ interactive: false })), false);
  assert.equal(settled(null), false);
});

test('nothing in the module sends: no timer, no fetch, no DOM', () => {
  const src = read('web/clear-phase.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const word of ['setTimeout', 'setInterval', 'fetch(', 'document', 'window', 'localStorage']) {
    assert.ok(!src.includes(word), `clear-phase.js mentions ${word}`);
  }
});

test('the composer wires Clear left of interrupt and the terminal right of it, outside composerSig', () => {
  const app = read('web/app.js');
  const build = app.slice(app.indexOf('  function buildComposer(s) {'), app.indexOf('  function mountComposerGrips('));
  const clearAt = build.indexOf('above.append(clearBtn)');
  const stopAt = build.indexOf('above.append(stop)');
  const termAt = build.indexOf('above.append(termBtn)');
  assert.ok(clearAt > 0 && stopAt > clearAt && termAt > stopAt, 'order is clear · interrupt · terminal');

  const sig = app.slice(app.indexOf('  const composerSig = (s) =>'), app.indexOf('  let lastComposerSig = null;'));
  assert.ok(!/clear/i.test(sig), 'the Clear phase must never join composerSig');
  assert.ok(!/composerH|composer-h|ta-h/i.test(sig), 'nor the sizes');

  // The only place `/clear` is sent is the ready branch of the human's press.
  const sends = app.match(/deliver\([^)]*CLEAR_COMMAND\)/g) || [];
  assert.equal(sends.length, 1);
});

test('the Clear button holds its widest word in the box, the way interrupt does', () => {
  const css = read('web/styles.css');
  assert.match(css, /\.composer-above > \.ghost-btn\.clear-btn::before \{ content: 'preparing…'; \}/);
  // Interrupt's own rule is untouched.
  assert.match(css, /\.composer-above > \.ghost-btn::before \{\n  content: 'interrupt';/);
});
