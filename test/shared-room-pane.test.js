import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The shared room's pane, and the contracts under it.
 *
 * Nothing here is a rendered check — whether the seven pill hues are told apart across a
 * room, or whether ten lines is the right fold, is a pair of eyes on a screen and the
 * report carries those measurements. What a test can hold is the set of contracts that
 * would break **silently**, leaving a panel that looks entirely fine, and every one pinned
 * here is of that kind:
 *
 *  - The order. `seq` is write order and `ts` is event order, and one sweep pass can write
 *    a reply before the message it answers (`server/observe.js` says so and stamps the
 *    record's own time for it). A view that sorted on `seq` would put an answer above its
 *    question, occasionally, with nothing on screen to say why.
 *  - `'sharedRoom' in msg`, never a truth test. `{unseen: 0, lastAt: null}` is the ordinary
 *    answer for a room nothing has been said in, and a truth test reads that as "the frame
 *    didn't mention it" — `rateLimits` learned this one first and carries the comment.
 *  - The colour on the pill and not on the bubble. The maintainer's own recorded
 *    correction, and a stylesheet is where it would quietly come undone.
 *  - The clamp's number and the standard `line-clamp` staying out — the room aside learned
 *    that one the hard way and both later clamps inherit it.
 *  - `scrollTop` read *before* the swap, which is the difference between holding a reader's
 *    place and putting them at the top of the room on every arriving line.
 *  - The shared room staying out of `composerSig`, which tears the composer down.
 *  - `ws.onopen` re-subscribing it, because a subscription dies with the socket while the
 *    roster keeps arriving — a rail that looks alive over a room that stopped.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const html = text('web/index.html');

/* ------------------------------------------------------------ the order --- */

test('the room is ordered on `ts`, with `seq` only as the tie-break', () => {
  const fn = app.match(/function sharedOrdered\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(fn, '`sharedOrdered` must exist');
  // ts first, seq second — and nothing else deciding the order.
  assert.match(fn, /\(a\.ts \|\| 0\) - \(b\.ts \|\| 0\) \|\| \(a\.seq \|\| 0\) - \(b\.seq \|\| 0\)/);
  // And the paint uses it rather than the raw array, or the sort is decoration.
  const paint = app.match(/function renderShared\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(paint, /const entries = sharedOrdered\(\);/);
  assert.ok(!/for \(const e of view\.shared\)/.test(paint), 'the paint must not walk the unsorted array');
});

/* --------------------------------------------------------- the summary --- */

test('the roster’s shared-room summary is read by presence, never by truth', () => {
  assert.match(app, /if \('sharedRoom' in msg\) state\.sharedRoom = msg\.sharedRoom/);
  // The precedent one line up, so the two cannot drift apart into two spellings.
  assert.match(app, /if \('rateLimits' in msg\) state\.rateLimits = msg\.rateLimits;/);
});

test('the shared room never joins `composerSig`', () => {
  /*
   * That signature is what decides whether the whole composer is torn down and rebuilt, so
   * a message arriving in the room would take the textarea out from under whoever is
   * typing. The merge block and the connections band are both deliberately outside it and
   * this is the third.
   */
  const sig = app.match(/const composerSig = [\s\S]*?\n  let lastComposerSig/)[0];
  assert.ok(!/shared/i.test(sig), '`composerSig` must know nothing about the shared room');
});

/* ---------------------------------------------------------- the colour --- */

test('the pill is colour-keyed on the name and the bubble body is not', () => {
  const node = app.match(/function sharedEntryNode\([\s\S]*?\n  \}/)[0];
  // The hue goes on the pill, off the ring, keyed on the speaker's name.
  assert.match(node, /who\.style\.color = `var\(--peer-\$\{colourFor\(name\)\}\)`/);
  // …and nowhere else. One hue read in the whole function is the whole rule.
  assert.equal(node.match(/var\(--peer-/g).length, 1);
  assert.ok(!/bubble\.style/.test(node), 'nothing may set a style on the bubble body');
  const bubble = styles.match(/\.shared-bubble \{[\s\S]*?\}/)[0];
  assert.ok(!/--peer-/.test(bubble), 'the bubble body must not reach for a peer hue');
  assert.match(bubble, /background: var\(--surface\);/);
});

test('a worker sender is labelled from `fromRole`, never guessed from the name', () => {
  const node = app.match(/function sharedEntryNode\([\s\S]*?\n  \}/)[0];
  assert.match(node, /e\.fromRole === 'worker'/);
  assert.match(node, /tag\.textContent = 'worker';/);
  // A guessed identity is *visible* rather than only true on the record — T-8's rule.
  assert.match(node, /e\.fromSource === 'name'/);
});

/* ----------------------------------------------------------- the clamp --- */

test('a message folds at ten lines, and the standard `line-clamp` stays out', () => {
  const clamp = styles.match(/\.shared-clamp \{[\s\S]*?\}/)?.[0];
  assert.ok(clamp, '`.shared-clamp` must exist');
  assert.match(clamp, /-webkit-line-clamp: 10;/);
  assert.match(clamp, /display: -webkit-box;/);
  assert.match(clamp, /-webkit-box-orient: vertical;/);
  assert.match(clamp, /overflow: hidden;/);
  /*
   * Chrome answers `CSS.supports('line-clamp', '10')` with false today, so it would be
   * inert — and the shape it will ship is `continue: discard`, which *removes* the clamped
   * lines rather than hiding them. The overflow test is `scrollHeight > clientHeight`;
   * discard the lines and those two are equal, every message reads as fitting, and the
   * control stops appearing on exactly the ones that need it.
   */
  assert.ok(!/^\s*line-clamp:/m.test(clamp), 'the standard property must not be set yet');
});

test('the control is built only where it is needed, and only after one read pass', () => {
  const paint = app.match(/function renderShared\(\) \{[\s\S]*?\n  \}/)[0];
  // Two passes over the batch: every candidate measured, then every candidate settled.
  const read = paint.indexOf('c.overflows = c.el.scrollHeight');
  const write = paint.indexOf('applySharedClamp(c)');
  assert.ok(read > 0 && write > read, 'the read pass must come before the write pass');
  // The button is built inside the settle, under the `overflows` test — never for all and
  // removed from most, which was 66px of silent creep per incoming line in the room aside.
  const settle = app.match(/function applySharedClamp\(c\) \{[\s\S]*?\n  \}/)[0];
  const bail = settle.indexOf('if (!c.overflows)');
  const build = settle.indexOf("createElement('button')");
  assert.ok(bail >= 0 && build > bail, 'a message that fits must grow no control');
});

/* ---------------------------------------------------------- the scroll --- */

test('the reader’s place is read before the swap, never after', () => {
  const paint = app.match(/function renderShared\(\) \{[\s\S]*?\n  \}/)[0];
  const held = paint.indexOf('const held = el.wrap.scrollTop');
  const swap = paint.indexOf('el.inner.replaceChildren()');
  assert.ok(held > 0, 'the offset must be held across the paint');
  assert.ok(held < swap, 'reading it after the swap is a forced layout that answers 0');
  assert.match(paint, /el\.wrap\.scrollTop = held;/);
});

test('following is an intention, and a resize’s own scroll event is swallowed', () => {
  const pane = app.match(/function renderSharedPane\(\) \{[\s\S]*?\n  \}/)[0];
  // The height guard, first, so a split-grip drag cannot read as the reader scrolling away.
  assert.match(pane, /if \(wrap\.clientHeight !== view\.sharedFollowH\)/);
  assert.match(pane, /view\.sharedFollow = wrap\.scrollHeight - wrap\.scrollTop - wrap\.clientHeight < 40;/);
  // Never yank: the pill is what says the room moved.
  assert.match(app, /hint\.className = 'shared-hint';/);
  assert.match(app, /new below ↓/);
});

test('the pill is anchored to a frame that is neither the scroller nor the pane', () => {
  /*
   * Absolute inside the scrolling box anchors to the *content* and scrolls the pill away
   * with the words it is about; `.pane` is shared with every session pane and giving it a
   * position would re-anchor anything else ever placed absolutely in one. Measured on the
   * bench: without this frame the pill drew half off the left edge of the pane, having
   * anchored to the window.
   */
  assert.match(app, /body\.className = 'shared-body';/);
  assert.match(app, /body\.append\(wrap, hint\);/);
  const frame = styles.match(/\.shared-body \{[\s\S]*?\}/)[0];
  assert.match(frame, /position: relative;/);
  const room = styles.match(/\n\.shared-room \{[\s\S]*?\}/)[0];
  assert.ok(!/position: relative/.test(room), 'the scroller must not be the anchor');
});

/* ------------------------------------------------------ the subscription --- */

test('a reconnect re-subscribes the room, like every other open subscription', () => {
  const re = app.match(/function resubscribe\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(re, /if \(view\.kind === 'shared'\) return void send\(\{ type: 'subscribe-shared', slot \}\);/);
  // `ws.onopen` is what calls it, for every pane.
  assert.match(app, /for \(const pane of panes\) pane\.resubscribe\(\);/);
});

test('every way out of the room gives the subscription back', () => {
  /*
   * `closeShared` and `close` are the obvious two. The other two are the ones that look
   * fine when they are wrong: a pane can stop holding the room by being *given* a session
   * or a thread, and the frames then go on arriving into a slot that drops them — a
   * server-side listener pushing into a socket for a pane drawing a transcript.
   */
  for (const fn of ['function open(id) {', 'function openLink(id) {']) {
    const body = app.slice(app.indexOf(fn), app.indexOf(fn) + 900);
    assert.match(body, /leaveShared\(\)/, `${fn} must hand the room's subscription back`);
  }
  const leave = app.match(/function leaveShared\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(leave, /if \(view\.kind !== 'shared'\) return;/);
  assert.match(leave, /send\(\{ type: 'unsubscribe-shared', slot \}\);/);
  const closeFn = app.match(/function closeShared\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(closeFn, /send\(\{ type: 'unsubscribe-shared', slot \}\);/);
});

test('both frames are checked against this pane actually holding the room', () => {
  const recv = app.match(/function receive\(msg\) \{[\s\S]*?\n  \}/)[0];
  assert.match(recv, /if \(msg\.type === 'shared'\) \{\s*\n\s*if \(view\.kind !== 'shared'\) return;/);
  assert.match(recv, /if \(msg\.type === 'shared-append'\) \{\s*\n\s*if \(view\.kind !== 'shared' \|\| !msg\.entry\) return;/);
  // …and both are ahead of the guard that turns everything else away, or they never run.
  const sharedAt = recv.indexOf("msg.type === 'shared'");
  const guardAt = recv.indexOf("if (view.kind !== 'session') return;");
  assert.ok(sharedAt > 0 && guardAt > sharedAt, 'the shared frames must be handled first');
});

/* ---------------------------------------------------------- the routing --- */

test('a pane that can hold a session is asked by kind, not by `linkId`', () => {
  /*
   * The two callers that used to ask `linkId()` were really asking "can this pane hold a
   * session", and a shared pane answers `null` to `linkId()` while emphatically not being
   * one. That mismatch is the shape of the navigation regression #36 — a rail click
   * resolving onto a pane showing something else and taking it away.
   */
  const fn = app.match(/function sessionPane\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /here\.kind\(\) === 'session'/);
  assert.match(fn, /panes\.find\(\(p\) => p\.kind\(\) === 'session'\)/);
  assert.ok(!/linkId\(\)/.test(fn), '`linkId` cannot answer this question any more');
  // Opening a link or the room replaces a pane holding either, never a session pane.
  assert.equal(app.match(/panes\.find\(\(p\) => p\.kind\(\) !== 'session'\)/g).length, 2);
});

test('the room is remembered as its own shape, and restored on a reload', () => {
  assert.match(app, /function rememberOpenShared\(slot, on, autoSplit = false\)/);
  assert.match(app, /state\.opened\[slot\] = \{ kind: 'shared', autoSplit: Boolean\(autoSplit\) \}/);
  const adopt = app.match(/function adopt\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(adopt, /if \(last\?\.kind === 'shared'\) \{/);
  assert.match(adopt, /return openShared\(\);/);
  // A pane holding anything that is not a session must not be adopted onto one — the
  // sharpest trap in the joint thread, and it applies verbatim here.
  assert.match(adopt, /if \(view\.kind !== 'session'\) return;/);
});

/* ------------------------------------------------------------ the entry --- */

test('the rail’s row is markup and is persistent, unlike the connections band', () => {
  assert.match(html, /id="railShared"/);
  assert.match(html, /id="railSharedUnseen"/);
  // The band hides itself with `.app.has-links`; this row has no such gate, because a room
  // with nothing in it yet still has something to say and a control that appears only once
  // traffic exists is a control nobody discovers.
  const row = styles.match(/\.rail-shared \{[\s\S]*?\}/)[0];
  assert.ok(!/display: none/.test(row), 'the row must not hide itself');
  assert.match(app, /el\.railShared\.onclick = openSharedRoom;/);
});

test('the empty room says what it is waiting for', () => {
  assert.match(
    app,
    /'Nothing yet\. When one session on this Mac messages another, it lands here\.'/,
  );
});

test('the count is a quiet number, and zero draws nothing', () => {
  const row = app.match(/function renderSharedRow\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(row, /badge\.hidden = n === 0;/);
  // A room on screen has nothing unseen in it, whatever the summary last said.
  assert.match(row, /const n = open \? 0 : unseen;/);
  // No accent on it: the room is a log, not an inbox, and every message in it was answered
  // by the session it was sent to before the panel saw it.
  const css = styles.match(/\.rail-shared-unseen \{[\s\S]*?\}/)[0];
  assert.ok(!/--accent|--decision|--working/.test(css), 'the count must not read as an alert');
});
