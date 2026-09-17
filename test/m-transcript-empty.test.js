import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The phone's transcript does not claim a session is empty until it has been told.
 *
 * `mountLead` builds the screen and paints it *before* the `transcript` frame arrives —
 * deliberately, because everything under it measures itself and a paint that runs before
 * its container is in the document draws nothing. With `messages: []` at that moment,
 * `renderStream` used to read the empty list as the empty *state* and write
 * "Nothing said yet." over a session with thousands of records, then replace it wholesale
 * when the frame landed one socket round trip later.
 *
 * Measured on a scratch panel over loopback, four opens of two different sessions: the
 * mount paint and the frame paint are **13–39ms** apart, `.m-lead-inner` going `+1/-0`
 * and then `+21/-1` … `+32/-1`. Over loopback that is a flicker; the phone reaches the
 * panel over the LAN and the frame carries a backfilled window of the file, so the same
 * two paints are far enough apart there to read as the screen drawing itself twice. Not a
 * regression — it has been this way since the first commit — but it is the one navigation
 * on this screen that genuinely paints twice with *different* content, which is the thing
 * that gets noticed.
 *
 * `web/m/lead.js` cannot be imported here: it reaches for the document at module scope and
 * there is no browser in `node --test`. So this is held against the source, the way
 * `test/m-standalones.test.js` and `test/m-start-sheet.test.js` hold theirs — and what is
 * pinned is only what would break **silently**, which is the three-state rule itself. A
 * `loaded` flag that stopped being set, or an empty state that stopped asking for it,
 * would put the wrong sentence back on screen with every test still green.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lead = fs.readFileSync(path.join(ROOT, 'web/m/lead.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'web/m/app.js'), 'utf8');
const rooms = fs.readFileSync(path.join(ROOT, 'web/m/rooms.js'), 'utf8');

test('the mount starts not-loaded, beside the empty message list it is about', () => {
  assert.match(lead, /messages: \[\],[\s\S]{0,1400}?\n    loaded: false,/);
});

test('the empty state is gated on the frame having landed, not on the count alone', () => {
  assert.match(lead, /if \(view\.loaded && !view\.messages\.length && !view\.error\) \{/);
  // …and the sentence it guards is still the one this is about, so a reworded empty state
  // cannot quietly become an ungated one.
  assert.match(lead, /m-lead-empty/);
  assert.match(lead, /Nothing said yet\./);
});

test('only the transcript frame sets it — one writer, never a second opinion', () => {
  const writes = lead.match(/view\.loaded = /g) || [];
  assert.equal(writes.length, 1, 'view.loaded is written in exactly one place');
  // And that place is the `transcript` handler: `messages` and `earlier` each carry a part
  // of the history and neither can say the list is complete.
  const handler = /ctx\.on\('transcript', \(msg\) => \{[\s\S]*?\n  \}\);/.exec(lead);
  assert.ok(handler, "the 'transcript' handler is still shaped the way this reads it");
  assert.match(handler[0], /view\.loaded = true;/);
});

test('nothing is drawn while it is false — no second sentence to flash instead', () => {
  // The guarded block is the only thing `renderStream` appends for an empty list. If a
  // "loading…" note is ever added here it has to be a decision, not a side effect: it
  // would trade one flash of text for another, which is the trap this fix exists to close.
  const fn = /function renderStream\(\{ pin = false \} = \{\}\) \{[\s\S]*?\n\}/.exec(lead);
  assert.ok(fn, 'renderStream is still shaped the way this reads it');
  assert.equal((fn[0].match(/m-lead-empty/g) || []).length, 1);
  // Comments stripped first: this paragraph's own prose says the word it is refusing, and
  // a test that read its own reasoning as the thing it forbids would never pass.
  const code = fn[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /loading/i);
});

test('the three home tabs keep the same rule, so the screens cannot drift apart', () => {
  // The precedent this follows, pinned so it stays a rule rather than a coincidence:
  // `null` is "not told yet" and gets a note of its own; `[]` is a fact and gets the
  // empty state. The transcript is now the fourth list that reads this way.
  assert.match(app, /if \(!state\.sessions\) \{\s*return \{ sig: 'sa:loading'/);
  assert.match(app, /if \(!state\.teams \|\| !state\.sessions\) \{\s*return \{ sig: 'loading'/);
});

/* ─────────────────────────────────────────────── the room screen, same rule ─── */

/*
 * The room log had the identical defect one file over and it is fixed the same way, which
 * is why it is pinned in the same file rather than beside the room's own tests: these two
 * are one rule and the way a rule like this dies is one screen keeping it while the other
 * quietly stops. Measured on a scratch panel over loopback against a room with twelve
 * entries: "Nothing said in here yet" went up at **14.9ms** and the entries replaced it at
 * **19.8ms**.
 *
 * `answered` already existed and only decided the *"no room with that id"* sentence; it
 * decides the whole answer now. Two rules about one flag is how one of them stops being
 * applied.
 */

test('an empty room log says nothing until the group-room frame has landed', () => {
  assert.match(rooms, /export function quietText\(room, \{ answered = true \} = \{\}\) \{/);
  // The early return is first, so every sentence below it is unreachable until we know.
  const fn = /export function quietText\([\s\S]*?\n\}/.exec(rooms);
  assert.ok(fn, 'quietText is still shaped the way this reads it');
  const code = fn[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const returns = [...code.matchAll(/return ([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(returns[0], 'null', 'the first thing quietText can answer is null');
  assert.ok(returns.length >= 4, 'the three sentences are still below it');
});

test('a null answer draws no box at all, rather than an empty one', () => {
  assert.match(rooms, /function quiet\(\) \{[\s\S]*?if \(text === null\) return null;/);
  assert.match(rooms, /const box = quiet\(\);\s*\n\s*el\.inner\.replaceChildren\(\.\.\.\(box \? \[box\] : \[\]\)\);/);
});

test('mountRoom still starts unanswered, and only the frame answers', () => {
  assert.match(rooms, /answered: false,/);
  const writes = rooms.match(/view\.answered = /g) || [];
  assert.equal(writes.length, 1, 'view.answered is written in exactly one place');
  const handler = /ctx\.on\('group-room', \(msg\) => \{[\s\S]*?\n  \}\);/.exec(rooms);
  assert.ok(handler, "the 'group-room' handler is still shaped the way this reads it");
  assert.match(handler[0], /view\.answered = true;/);
});
