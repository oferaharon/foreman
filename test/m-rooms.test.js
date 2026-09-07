import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  archiveQuestion,
  archiveWord,
  archivedIsOpen,
  composerRefusal,
  createSig,
  keepPicked,
  memberNames,
  memberStrip,
  membersSig,
  quietText,
  removeQuestion,
  roomsListView,
  roomsSig,
} from '../web/m/rooms.js';

/*
 * The phone's Rooms tab and the room screen behind it.
 *
 * Two halves, because the feature is two halves. `web/m/rooms.js` is written to be
 * **import-safe in node** — nothing in it touches `document`, `window` or `localStorage` at
 * module scope — so its pure half is driven for real here rather than read out of the
 * source. The rest of it builds DOM, and `web/m/app.js` cannot be imported at all (it
 * reaches for `document.getElementById` at module scope), so the contracts on that side are
 * held against the source the way `test/m-start-sheet.test.js` and `test/rooms-band.test.js`
 * hold their own.
 *
 * Nothing here is a rendered check. What a room looks like on a phone is a pair of eyes and
 * the bench, and the report carries that. Only the things that would break **silently** are
 * pinned:
 *
 *  - **The subscription is given back and taken again.** `groupRoomSubs` is one per socket
 *    and dies with it, so `leaveRoute` must `unsubscribe-group-room` and `ws.onopen` must
 *    re-subscribe the open room. Forgetting the second is a screen that looks perfectly
 *    alive over a log that stopped minutes ago — this project's signature failure, already
 *    shipped once in the transcript pane and invisible from inside the panel.
 *  - **A post carries `{text}` and no speaker.** Omitting `paneId` is the *whole* of who is
 *    speaking: the endpoint reads a pane id as a session and nothing as the panel, and the
 *    panel is the maintainer. A `paneId` added here would silently demote the maintainer's
 *    `| ` line to a session's `> ` one, which authorizes nothing — and nothing on screen
 *    would say so.
 *  - **The word is `handed`, never *delivered*.** A queued copy may sit for hours and
 *    `queue.prune` may drop it silently; the log records a handoff and no more.
 *  - **The list's signature carries rendered strings only.** `renderHome`'s guard is what
 *    stops the list being rebuilt under a thumb; a raw `lastAt` in it retires the guard, and
 *    a field the row draws but the signature misses is a row that never repaints. Both
 *    failures are silent.
 *  - **Every class is `.m-room-*`.** The one-sheet-per-item split guarantees *files*, not
 *    names — `lead.css` already owned `.m-tab` when the shell's tab bar wanted it, and
 *    neither screen looked broken because only one is ever on screen at a time.
 *  - **16px on the input.** Safari zooms the page in below it and does not zoom back out.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/m/app.js');
const rooms = text('web/m/rooms.js');
const css = text('web/m/rooms.css');
const html = text('web/m/index.html');

/**
 * The source with its prose taken out.
 *
 * Several checks below are *negative* — "no `paneId` is ever sent", "the word `delivered`
 * appears nowhere" — and the phrases they forbid belong in the comments that record the
 * rule. A negative assertion over the raw file therefore fails on the very sentences that
 * explain it, which is the wrong way round.
 */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const appCode = strip(app);
const roomsCode = strip(rooms);

/** One function's body, brace-matched from its own `function` keyword — a non-greedy regex
 *  to the first `\n}` stops inside the first nested function, and several of these have
 *  nested arrows. */
function fn(name, src) {
  const at = src.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `\`${name}\` must exist`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`\`${name}\` has no closing brace`);
}

/** A function whose parameters are destructured defeats `fn`: its brace walk starts at the
 *  first `{` after the name, which is the parameter object rather than the body. Those two
 *  are sliced by hand between their own landmarks instead. */
function between(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `\`${from}\` … \`${to}\` must both be there, in that order`);
  return src.slice(a, b);
}

/* ------------------------------------------------------------- fixtures --- */

const member = (name, extra = {}) => ({ name, tmuxSession: `foreman-${name}`, paneId: null, ...extra });

const room = (over = {}) => ({
  id: 'r1',
  name: 'the room',
  members: [member('alpha-main'), member('beta-main')],
  memberCount: 2,
  createdAt: 1,
  archivedAt: null,
  lastAt: 1_700_000_000_000,
  lastFrom: 'alpha-main',
  unseen: 0,
  seq: 3,
  ...over,
});

/* ═══════════════════════════════════════════════ the member strip (real) ═══ */

test('the strip names members and caps the tail', () => {
  assert.deepEqual(memberNames(room()), { names: ['alpha-main', 'beta-main'], more: 0 });
  assert.equal(memberStrip(room()), 'alpha-main, beta-main');

  const big = room({
    members: ['alpha-main', 'beta-main', 'gamma-master', 'alpha-dev', 'beta-dev'].map((n) => member(n)),
  });
  assert.deepEqual(memberNames(big), {
    names: ['alpha-main', 'beta-main', 'gamma-master'],
    more: 2,
  });
  assert.equal(memberStrip(big), 'alpha-main, beta-main, gamma-master +2');
});

test('a member with no label at all is dropped rather than drawn as a gap', () => {
  // `memberLabel` answers `''` for a record with none of the three ids. `memberName` one
  // module over would answer `a session`, which is a chip label and reads as somebody's
  // name in a comma-joined strip — this is why the strip asks the first and not the second.
  const r = room({ members: [member('alpha-main'), { name: '', tmuxSession: '', paneId: '' }] });
  assert.deepEqual(memberNames(r).names, ['alpha-main']);
  assert.equal(memberStrip(r), 'alpha-main');
});

test('a room with nobody in it says so rather than drawing an empty strip', () => {
  assert.equal(memberStrip(room({ members: [], memberCount: 0 })), 'no members');
  assert.equal(memberStrip(null), 'no members');
});

/* ═══════════════════════════════════════════════════ the signature (real) ═══ */

test('the signature moves on every fact the row draws', () => {
  const base = roomsSig([room()]);
  assert.notEqual(base, roomsSig([room({ name: 'renamed' })]), 'the name');
  assert.notEqual(base, roomsSig([room({ unseen: 2 })]), 'the unseen count');
  assert.notEqual(base, roomsSig([room({ members: [member('alpha-main')] })]), 'the membership');
  assert.notEqual(base, roomsSig([room({ archivedAt: 9 })]), 'archived');
  assert.notEqual(base, roomsSig([room(), room({ id: 'r2', name: 'other' })]), 'a second room');
});

test('the signature carries no raw timestamp', () => {
  /*
   * The rule `renderHome` is built on: **rendered strings and booleans, never a raw stamp.**
   * `lastAt` moves on every post and `seq` on every entry, and either in here would make the
   * signature differ on frames where nothing on screen moved — retiring the guard that stops
   * the list being rebuilt under a thumb. `bandSig` one module up *does* carry `lastAt`,
   * which is why this list does not reuse it.
   */
  const sig = roomsSig([room()]);
  assert.doesNotMatch(sig, /1700000000000/, 'lastAt must not be in the signature');
  assert.doesNotMatch(sig, /\b\d{13}\b/, 'no millisecond stamp of any kind');
  assert.equal(roomsSig([room()]), roomsSig([room({ lastAt: 2, seq: 99, seenAt: 5 })]));
});

test('the signature is joined with real punctuation', () => {
  // `mergeSig` on the desktop once joined with what read in every editor as an empty string
  // and was three literal control bytes, so two different lists could spell one signature.
  const sig = roomsSig([room(), room({ id: 'r2', name: 'other' })]);
  assert.match(sig, /~/, 'rows are separated');
  assert.match(sig, /\|/, 'fields within a row are separated');
  assert.doesNotMatch(sig, /[ --]/, 'no control bytes');
});

test('the archived fold is in the signature, and so are the rows it opens', () => {
  const list = [room(), room({ id: 'r2', name: 'old', archivedAt: 5 })];
  const shut = roomsSig(list, { archivedOpen: false });
  const open = roomsSig(list, { archivedOpen: true });
  assert.notEqual(shut, open, 'the caret and the rows both turn on it');
  assert.match(shut, /fold\|1\|1/, 'one archived room, folded away');
  assert.doesNotMatch(shut, /\|old\|/, 'a folded row is not drawn');
  assert.match(open, /\|old\|/, 'an unfolded one is');
});

test('the fold starts shut', () => {
  // Not a stored preference: it is a fold on one list on one screen, and `web/prefs.js` is
  // for settings that mean the same thing on both front doors.
  assert.equal(archivedIsOpen(), false);
});

/* ══════════════════════════════════════════════════════ the tab body (real) ═══ */

test('null rooms is "loading", an empty list is "no rooms", and they are different', () => {
  /*
   * Rooms ride on the roster frame only, so a phone that has painted from
   * `GET /api/sessions` has sessions and no rooms yet. Saying "no rooms" there would be the
   * panel showing something wrong in the one slot a reader would trust without checking.
   */
  assert.equal(roomsListView(null).sig, 'rm:loading');
  assert.equal(roomsListView(undefined).sig, 'rm:loading');
  assert.equal(roomsListView([]).sig, 'rm:empty');
  assert.notEqual(roomsListView(null).sig, roomsListView([]).sig);
});

test('the body answers the tab contract, and its nodes are a thunk', () => {
  const view = roomsListView([room()]);
  assert.equal(typeof view.sig, 'string');
  assert.equal(typeof view.nodes, 'function', 'nothing is built for a paint the guard turns away');
  // The `+` in the shell header starts a *lead*; the Rooms tab never offers it.
  assert.equal(view.startable, 0);
  assert.equal(roomsListView(null).startable, 0);
  assert.equal(roomsListView([]).startable, 0);
});

test('the body signature is the list signature, one spelling', () => {
  // Two functions answering "has this list changed" is how a row stops repainting on a real
  // change; `roomsListView` asks `roomsSig` rather than assembling its own.
  assert.equal(roomsListView([room()]).sig, `rm:${roomsSig([room()], { archivedOpen: false })}`);
});

/* ═══════════════════════════════════════════════════ the composer (real) ═══ */

test('an archived room gets no composer, and the sentence says why', () => {
  assert.equal(composerRefusal(room()), null, 'an open room takes posts');
  const refusal = composerRefusal(room({ archivedAt: 5 }));
  assert.match(refusal, /archived/);
  assert.match(refusal, /still readable/);
  assert.match(refusal, /the room/, 'the room is named');
});

test('an empty archived room does not offer the box it has not got', () => {
  /*
   * Found on the bench. The ordinary empty-log sentence ends *"or anything you type below"*
   * — and an archived room has no box below, because `composerRefusal` has correctly taken
   * it away. Two functions describing one screen, disagreeing about whether it can be typed
   * into.
   */
  assert.match(quietText(room()), /anything you type below/);
  assert.doesNotMatch(quietText(room({ archivedAt: 5 })), /type below/);
  assert.match(quietText(room({ archivedAt: 5 })), /nothing more can be/);
  assert.match(quietText(null, { answered: true }), /no room with that id/);
  // Before the server has answered, nothing is claimed either way.
  assert.match(quietText(null, { answered: false }), /Nothing said in here yet/);
});

test('an id that names nothing is a third answer, not an empty room', () => {
  assert.equal(composerRefusal(null, { answered: false }), null, 'nothing is claimed before the server answers');
  assert.match(composerRefusal(null, { answered: true }), /no room with that id/);
});

/* ══════════════════════════════════════════ the subscription (source) ═══ */

test('the room screen unsubscribes when the route leaves', () => {
  const leave = fn('leaveRoute', appCode);
  assert.match(leave, /route\.kind === 'room'/);
  assert.match(leave, /type: 'unsubscribe-group-room'/);
  assert.match(leave, /roomCtx\?\._dispose\(\)/, 'and the screen stops listening to the socket');
});

test('ws.onopen re-subscribes the open room beside the open pane', () => {
  /*
   * The single most expensive bug in this project's history, in its room-shaped form. A
   * subscription is *server* state — one listener per socket — so a dropped connection or a
   * panel restart takes it with it while the roster keeps arriving, and the screen looks
   * perfectly alive over a log that stopped. It has been re-introduced once already, by a
   * refactor that re-subscribed a variable that no longer existed.
   */
  const open = appCode.slice(appCode.indexOf('ws.onopen'), appCode.indexOf('ws.onclose'));
  assert.match(open, /type: 'subscribe'/, 'the open pane, as before');
  assert.match(open, /type: 'subscribe-group-room'/, 'and the open room');
  assert.match(open, /route\.kind === 'room' && route\.roomId/);
});

test('entering the room route subscribes exactly once', () => {
  const enter = fn('enterRoom', appCode);
  assert.match(enter, /type: 'subscribe-group-room', roomId: route\.roomId/);
  assert.match(enter, /mountRoom\(host, roomCtx\)/);
  // The screen module never touches the socket except through `ctx.send` — the three lines
  // that have to agree (subscribe, unsubscribe, re-subscribe) all live in the shell.
  assert.doesNotMatch(roomsCode, /subscribe-group-room/, 'rooms.js does not subscribe for itself');
});

test('the router tells one room from another', () => {
  // Without `roomId` in the comparison, tapping a second room from a deep link would be read
  // as "the same route" and the screen would go on drawing the first one's log.
  const nav = fn('navigate', appCode);
  assert.match(nav, /next\.roomId === route\.roomId/);
  assert.match(nav, /route\.kind === 'room'\) enterRoom\(\)/);

  const parse = fn('parseHash', appCode);
  assert.match(parse, /#\\\/room\\\//, 'the hash carries the room');
  assert.match(parse, /decodeURIComponent/);
});

test('the room screen is told about a rename or an archive through the roster', () => {
  const roster = fn('onRoster', appCode);
  assert.match(roster, /route\.kind === 'room'/);
  assert.match(roster, /updateRoom\(roomOf\(route\.roomId\)\)/);
});

/* ══════════════════════════════════════════════ what a post carries (source) ═══ */

test('a post is {text} and nothing else — there is no speaker field', () => {
  /*
   * Omitting `paneId` is the whole of who is speaking. The endpoint reads a pane id as a
   * session posting through its own tool and nothing as the panel, and the panel is the
   * maintainer — which is what selects `roomHumanLine` and the `| ` prefix no session's body
   * can forge. `envelope.js` has two functions for exactly this reason, so which envelope is
   * composed is decided by which branch called it and there is no argument to plumb.
   */
  const submit = fn('submit', roomsCode);
  assert.match(submit, /JSON\.stringify\(\{ text \}\)/);
  assert.doesNotMatch(roomsCode, /paneId/, 'no pane id reaches the post body');
  assert.doesNotMatch(roomsCode, /speaker/, 'and there is no speaker field');
  assert.match(submit, /\/api\/rooms\/\$\{encodeURIComponent\(id\)\}\/post/);
});

test('a refusal is the server’s own sentence', () => {
  const submit = fn('submit', roomsCode);
  assert.match(submit, /data\.error \|\|/, 'the fallback is only for a response with no body');
  assert.match(submit, /view\.error = err\.message/, 'held, not appended to a node a repaint replaces');
  // Nothing trims, escapes or normalises the body on the way out: a character that could
  // make a quoted line draw as an unquoted one is refused *with the character named*, and
  // silently rewriting somebody's input hands them a way to have it rewritten again.
  assert.doesNotMatch(submit, /\.trim\(\)[,;)]?\s*\n?\s*(?:body|text:)/);
});

test('nothing is drawn locally on a successful post', () => {
  // The endpoint appends the entry and the store emits it, so `group-room-append` brings it
  // back to this very screen. Appending here too would draw the maintainer's own message
  // twice, and the second copy would look exactly as real as the first.
  const submit = fn('submit', roomsCode);
  assert.doesNotMatch(submit, /entries\.push/);
});

test('the count is spent only when the reader is actually at the newest line', () => {
  assert.match(roomsCode, /type: 'markGroupRoomRead'/);
  const mount = fn('mountRoom', roomsCode);
  assert.match(mount, /if \(view\.follow\) markSeen\(\)/, 'an arrival while scrolled up does not');
});

/* ══════════════════════════════════════════════════════ the words (source) ═══ */

test('the word is handed, never delivered', () => {
  // `sendOrQueue` types or queues; a queued copy waits for a pane to go idle, which may be
  // hours and may be never, and nothing writes back to an append-only log.
  assert.match(roomsCode, /handedText/);
  assert.doesNotMatch(roomsCode, /deliver/i);
  assert.doesNotMatch(strip(css), /deliver/i);
});

test('the entry’s own `to` is read, never the text re-scanned for @', () => {
  /*
   * `mentionsIn` in `server/rooms-line.js` is the single parse, run once on the server, so
   * the maintainer typing `@beta-main` and a session posting the same words through
   * `group_post` get identical treatment. And note the field is **taken** one pane over: a
   * peer-message entry's `to` is an object `{name, cwd}`, not an array of names —
   * `addressedNames`' `Array.isArray` guard is what keeps the two apart.
   */
  assert.match(roomsCode, /addressedText\(e\)/);
  const node = fn('entryNode', roomsCode);
  // No scan of `e.text` for anything: the only `@` left in here is inside the tooltip that
  // explains what a mention did, which is prose rather than a parse.
  assert.doesNotMatch(node, /\.match\(|RegExp|mentionQuery|mentionsIn|split\('@'\)|indexOf\('@'\)/);
});

test('the two speakers are drawn as two lanes', () => {
  // `| ` is the maintainer's word and authorizes; `> ` is another session and does not. On a
  // phone a pill alone is easy to skim past, so the lane carries it too.
  const node = fn('entryNode', roomsCode);
  assert.match(node, /e\.kind === 'human'/);
  assert.match(node, /is-mine/);
  assert.match(node, /is-peer/);
  assert.match(css, /\.m-room-msg\.is-mine\s*\{[^}]*align-self:\s*flex-end/);
  assert.match(css, /\.m-room-msg\.is-peer\s*\{[^}]*align-self:\s*flex-start/);
});

/* ═══════════════════════════════════════════════════════ the sheet (source) ═══ */

test('rooms.css is linked, once, below the four that were there', () => {
  assert.match(html, /<link rel="stylesheet" href="\/m\/rooms\.css" \/>/);
  assert.equal(html.match(/\/m\/rooms\.css/g).length, 1);
  const at = (f) => html.indexOf(`/m/${f}.css`);
  for (const f of ['m', 'lead', 'cards', 'tasks']) {
    assert.ok(at(f) < at('rooms'), `rooms.css comes after ${f}.css`);
  }
});

/**
 * Every class token this sheet mentions, by selector.
 *
 * Written as a scan over selectors rather than a list of names, because a list is exactly
 * what stops covering the next class somebody adds.
 */
function selectors(sheet) {
  return strip(sheet)
    .split('}')
    .map((block) => block.slice(block.lastIndexOf('}') + 1).split('{')[0].trim())
    .filter((s) => s && !s.startsWith('@') && s.includes('.'))
    .flatMap((s) => s.split(',').map((one) => one.trim()))
    .filter(Boolean);
}

test('every selector here is anchored on an .m-room class', () => {
  /*
   * The one-sheet-per-item split guarantees **files, not names**. `lead.css` owned `.m-tab`
   * before the shell's tab bar wanted it, so the shell's tabs came up wearing the lead
   * screen's colours and its 34px height while leaking their own back — and neither screen
   * looked broken, because only one of them is ever on screen at a time.
   *
   * The three modifiers allowed alongside are shared vocabulary this sheet only ever *reads*
   * in a compound selector, never defines on its own: an unanchored `.is-on { }` here would
   * repaint half of `cards.css`.
   */
  const shared = new Set(['has-badge', 'is-down', 'is-archived', 'is-mine', 'is-peer', 'is-on', 'is-waiting', 'is-refusal']);
  for (const sel of selectors(css)) {
    const classes = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
    assert.ok(classes.some((c) => c.startsWith('m-room')), `\`${sel}\` must name an .m-room class`);
    for (const c of classes) {
      assert.ok(c.startsWith('m-room') || shared.has(c), `\`${sel}\` reaches for \`.${c}\``);
    }
  }
});

test('no other phone sheet knows the m-room prefix', () => {
  for (const sheet of ['m', 'lead', 'cards', 'tasks']) {
    assert.doesNotMatch(text(`web/m/${sheet}.css`), /\.m-room/, `${sheet}.css must not draw a room`);
  }
});

test('every box that is ever hidden says so in CSS as well', () => {
  /*
   * `hidden` is a UA-stylesheet `display: none` and any class rule carrying a `display`
   * beats it. `m.css` has paid for this three times on one screen — the header, the quota
   * block and the `+` — and each time the box simply stayed.
   */
  const hiddenGroup = css.slice(css.indexOf('.m-room-sub[hidden]'), css.indexOf('/* ---- the header'));
  for (const cls of ['m-room-sub', 'm-room-new', 'm-room-err', 'm-room-mention', 'm-room-input', 'm-room-send', 'm-room-say']) {
    assert.match(hiddenGroup, new RegExp(`\\.${cls}\\[hidden\\]`), `${cls} needs its own [hidden] rule`);
    assert.match(roomsCode, new RegExp(`${cls.replace('m-room-', '')}\\.hidden|hidden = `), 'and is actually hidden somewhere');
  }
  assert.match(hiddenGroup, /display:\s*none/);
});

test('the composer input is 16px', () => {
  // Safari zooms the whole page in when a focused input's font-size is under 16px and does
  // not zoom back out — the page stays wider than the screen for the rest of the session.
  assert.match(css, /\.m-room-input\s*\{[^}]*font-size:\s*16px/);
});

test('a long unbroken token cannot push the page sideways', () => {
  // A path, a URL or a sha in a room message, at 320px. A horizontal scroll on a phone is
  // the one layout bug you cannot get back out of by scrolling.
  assert.match(css, /\.m-room-text\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.m-room-handed\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

/* ═══════════════════════════════════════════════════ the keyboard (source) ═══ */

test('Enter is a newline, not a send', () => {
  /*
   * The desktop's room composer does send on Enter and this deliberately does not follow it,
   * for the reason `web/m/lead.js`'s own composer already records against the same keyboard:
   * on a phone the return key is a newline and nothing else, and a send bound to it fires a
   * half-written message every time. Two composers on one device disagreeing about the
   * return key would be worse than either rule on its own.
   *
   * The one Enter that is bound takes a highlighted `@name` — which is not a send either,
   * and is what stops a half-typed `@alp` going to everybody.
   */
  const key = fn('onKey', roomsCode);
  assert.match(key, /if \(!mention\) return;/, 'nothing at all happens with no menu up');
  assert.match(key, /chooseMention\(mention\.names\[mention\.index\]\)/);
  assert.doesNotMatch(key, /submit\(\)/);
});

/* ═════════════════════════════════════ item 5: making and editing a room ═══ */

/*
 * Creating a room, adding a member, removing one and archiving — all four from the phone,
 * on the maintainer's ruling of 2026-09-07 (open question A), over a `decisions.md` line
 * that had said membership stays on the Mac.
 *
 * What is pinned here is what would break **silently**, which for this half is narrower and
 * sharper than for the log:
 *
 *  - **The allow-list is asked, never re-spelled.** A worker in the picker is a channel into
 *    a session whose questions are its lead's business. `POST /api/rooms` refuses one with a
 *    409, and a second spelling on this side is free to disagree in the direction of showing
 *    it.
 *  - **The strongest id is what travels as `remove`.** A label collides by design and a pane
 *    id does not survive a relaunch, so a `remove` keyed on either can take out somebody
 *    else — `memberKey` is the one place that order lives.
 *  - **The cap is the server's.** `MAX_MEMBERS` is a fallback and a second authority is how
 *    a client starts refusing what the server allows, or allowing what it refuses.
 *  - **Signatures carry structure, never status.** A status moves every couple of seconds
 *    and would rebuild a list of checkboxes under the thumb halfway through choosing.
 *  - **The boxes are drawn, not native.** A stock checkbox is painted from the browser's
 *    colour scheme rather than the page's, so an unticked box can come back solid and read
 *    as ticked. No test can see that; what a test *can* hold is that the box is ours.
 *  - **Taking something away asks first.** Remove and archive arm a question; adding and
 *    unarchiving do not, because they take nothing away.
 */

const sess = (id, over = {}) => ({
  id,
  label: id,
  status: 'idle',
  interactive: true,
  project: 'alpha',
  paneCwd: '/sandbox/alpha',
  ...over,
});

/* ─────────────────────────────────────────────── the picker's arithmetic ─── */

test('a picked session that has gone away is dropped, and the order survives', () => {
  /*
   * A phone is a screen you put down, so the roster under an open picker moves. A session
   * that has exited must not still count against the cap or be sent in `members` — and the
   * ids that remain keep their tick order, because that is the order `POST /api/rooms`
   * receives them in and therefore the order the room lists its members in.
   */
  const rows = [sess('b'), sess('a')];
  assert.deepEqual(keepPicked(['a', 'b'], rows), ['a', 'b'], 'the tick order, not the roster order');
  assert.deepEqual(keepPicked(['a', 'gone', 'b'], rows), ['a', 'b']);
  assert.deepEqual(keepPicked(['gone'], rows), []);
  assert.deepEqual(keepPicked([], rows), []);
  assert.deepEqual(keepPicked(['a'], []), [], 'an empty roster offers nobody');
});

test('the create picker’s signature is structure, never status and never the tick', () => {
  /*
   * Both exclusions are load-bearing and neither is obvious. **Status** moves every couple
   * of seconds, so in here it would rebuild every checkbox in the list twice a minute under
   * a thumb. **Ticked** is worse: the browser has already drawn the tick by the time a
   * repaint would run, so a rebuild on it is a box that flickers off and back on under the
   * finger that pressed it. The dot is patched in place instead.
   */
  const rows = [sess('a'), sess('b')];
  const base = createSig(rows);
  assert.equal(base, createSig([sess('a', { status: 'working' }), sess('b', { status: 'needs-decision' })]));
  assert.notEqual(base, createSig([sess('a'), sess('c')]), 'a session appearing');
  assert.notEqual(base, createSig([sess('a')]), 'a session going away');
  assert.notEqual(base, createSig([sess('a', { label: 'renamed' }), sess('b')]), 'the name it draws');
  assert.notEqual(base, createSig([sess('a', { project: 'gamma' }), sess('b')]), 'the folder it draws');
  assert.notEqual(base, createSig([sess('a', { isLead: true }), sess('b')]), 'the lead chip it draws');
  assert.doesNotMatch(base, /\b\d{13}\b/, 'no millisecond stamp of any kind');
});

test('the members sheet’s signature carries both lists, because one press moves both', () => {
  // Adding somebody takes them out of the offer and puts them in the room in one press. A
  // signature carrying only one half would leave the other showing a session in two places.
  const r = room();
  const addable = [sess('c')];
  const base = membersSig(r, addable);
  assert.notEqual(base, membersSig(room({ members: [member('alpha-main')] }), addable), 'a member removed');
  assert.notEqual(base, membersSig(r, []), 'the offer emptying');
  assert.notEqual(base, membersSig(r, [sess('d')]), 'a different session on offer');
  assert.notEqual(base, membersSig(room({ archivedAt: 5 }), addable), 'archived, which takes both controls away');
  assert.equal(base, membersSig(r, [sess('c', { status: 'working' })]), 'a status is patched, not rebuilt');
});

/* ─────────────────────────────────────────────────── what a question says ─── */

test('a confirmation names its target, and the word matches the button', () => {
  // `sure?` overwrote the one word naming the action. One function answers both the word on
  // the control and the word in the question, so the two can never come apart.
  assert.equal(archiveWord(room()), 'archive');
  assert.equal(archiveWord(room({ archivedAt: 5 })), 'unarchive');
  assert.match(archiveQuestion(room()), /archive/);
  assert.match(archiveQuestion(room()), /the room/, 'the room is named');
  assert.match(archiveQuestion(null), /this room/, 'and something is said when it is not');
  assert.match(removeQuestion(member('alpha-main')), /^remove alpha-main\?$/);
});

test('a member with no name at all is still called something in a question', () => {
  // `memberName` and not `memberLabel`: that one answers `''` for a record holding none of
  // the three ids, and `remove ?` is a question about nobody.
  assert.equal(removeQuestion({ name: '', tmuxSession: '', paneId: '' }), 'remove a session?');
});

/* ──────────────────────────────────────────────── the list head (source) ─── */

test('the Rooms list has its own head, and it is not the shell’s `+`', () => {
  /*
   * The shell header's `+` starts a *lead*; `+ room` is a different verb on a different
   * list. `startable` staying `0` is what keeps the two from ever sharing a count.
   */
  const head = fn('listHead', roomsCode);
  assert.match(head, /openCreateSheet\(sessions\)/);
  assert.equal(roomsListView([room()]).startable, 0);
  assert.equal(roomsListView([]).startable, 0);

  const view = roomsListView(null);
  assert.equal(view.sig, 'rm:loading');
  const body = between(roomsCode, 'export function roomsListView', 'function listHead');
  assert.doesNotMatch(body.slice(0, body.indexOf('const list =')), /listHead/,
    'no head before the first roster frame — a picker with no roster cannot be answered');
});

test('the empty state keeps its sentence as well as gaining the control', () => {
  // An empty list is the one place a reader learns what a room *is* before making one, and
  // the sentence deliberately does not send anybody to the Mac.
  const body = between(roomsCode, 'export function roomsListView', 'function listHead');
  assert.match(body, /listHead\(sessions\)/);
  assert.match(body, /No rooms yet\./);
  assert.doesNotMatch(body, /at the Mac/);
});

test('the roster reaches both pickers as a thunk, never as a captured list', () => {
  // A sheet outlives any one paint. A list captured when it opened would go on offering a
  // session that has since exited — which is the whole reason this one repaints where the
  // desktop's modal deliberately does not.
  assert.match(appCode, /sessions: \(\) => state\.sessions \|\| \[\]/);
  assert.equal(appCode.match(/sessions: \(\) => state\.sessions \|\| \[\]/g).length, 2,
    'once for the create sheet, once for the room screen’s membership');
  assert.match(fn('renderCreateSheet', roomsCode), /s\.sessions\(\)/);
  assert.match(fn('renderMembersSheet', roomsCode), /view\.ctx\?\.sessions\?\.\(\)/);
});

test('the create sheet repaints ahead of the home screen’s signature guard', () => {
  /*
   * What it draws is the **roster**, and the guard below it is about rooms — so a session
   * appearing or exiting moves the picker and nothing at all on the list behind it. Gated on
   * that signature the repaint would simply never come. `renderStartSheet` sits there for
   * the same reason and is the precedent.
   */
  const home = fn('renderHome', appCode);
  const at = (needle) => home.indexOf(needle);
  assert.ok(at('renderCreateSheet()') > 0, 'it is called at all');
  assert.ok(at('renderCreateSheet()') < at('if (sig === homeSignature) return;'), 'ahead of the guard');
});

/* ───────────────────────────────────────────── who may be in a room ─────── */

test('the allow-list is asked, never re-spelled', () => {
  /*
   * A worker's channel is its lead — the maintainer's ruling — and the filter is an
   * allow-list on role because kinds have grown here once already. A second spelling on this
   * side would be free to disagree in the direction of offering one.
   */
  assert.match(roomsCode, /roomParticipants\(s\.sessions\(\)\)/, 'the create picker');
  assert.match(roomsCode, /addableSessions\(rows, room, null\)/, 'and the add picker');
  assert.doesNotMatch(roomsCode, /team\?\.role/, 'the role test is nowhere in this file');
  assert.doesNotMatch(roomsCode, /'worker'/, 'and neither is the word it would be written with');
});

test('the pickers are ordered by the shared sort, with no "here" to sort around', () => {
  // `orderForHere` puts the folder you are looking at first. A phone on the Rooms tab is not
  // looking at a session at all, so `null` is the honest answer rather than a stub — and with
  // no "here" the roster's own order stands.
  assert.match(fn('renderCreateSheet', roomsCode), /orderForHere\(roomParticipants\(s\.sessions\(\)\), null\)/);
});

/* ─────────────────────────────────────────── what a press sends ──────────── */

test('creating sends {name, members} of session ids and nothing else', () => {
  const submit = fn('submitCreate', roomsCode);
  assert.match(submit, /method: 'POST'/);
  assert.match(submit, /'\/api\/rooms'/);
  assert.match(submit, /JSON\.stringify\(\{ name: s\.name\.value\.trim\(\), members: \[\.\.\.s\.picked\] \}\)/);
  assert.match(submit, /location\.hash = `#\/room\/\$\{encodeURIComponent\(data\.room\.id\)\}`/,
    'and it opens the room it just made');
});

test('every membership change is one PATCH, and remove sends the strongest id', () => {
  /*
   * `memberKey` is `tmuxSession` → `paneId` → `name`, and which one is *sent* is this side's
   * decision: a tmux session name survives a `/clear` and a relaunch, a pane id survives
   * neither, and a label collides by design (`<repo>-<branch>`). The store's `removeMember`
   * takes the **first** member that answers to the key, so a weaker id can take out somebody
   * else.
   */
  const patch = fn('patchRoom', roomsCode);
  assert.match(patch, /method: 'PATCH'/);
  assert.match(patch, /\/api\/rooms\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(roomsCode, /patchRoom\(\{ remove: memberKey\(member\) \}, drop\)/);
  assert.match(roomsCode, /patchRoom\(\{ add: row\.id \}, item\)/, 'add is a session id — the picker’s own');
  assert.match(roomsCode, /patchRoom\(\{ archived: true \}, btn\)/);
  assert.match(roomsCode, /patchRoom\(\{ archived: false \}, btn\)/);
});

test('a refusal is the server’s own sentence, on both routes', () => {
  // Every one of them names the thing that is wrong — the session that has exited, the worker
  // that cannot be a member, the member that is not in the room — and a paraphrase here would
  // be the panel's guess at a refusal it did not make.
  for (const name of ['submitCreate', 'patchRoom']) {
    const body = fn(name, roomsCode);
    assert.match(body, /data\.error \|\|/, `${name}: the fallback is only for a response with no body`);
  }
  assert.match(fn('patchRoom', roomsCode), /membersError = err\.message/,
    'held in module state, never painted onto the node that was pressed');
});

test('nothing is drawn from a PATCH’s answer beyond the beat before the frame', () => {
  // The endpoint broadcasts a roster frame and the head and the sheet repaint off it, so what
  // is on screen is the record the store holds rather than the one this browser hoped for.
  const patch = fn('patchRoom', roomsCode);
  assert.match(patch, /renderHead\(\)/);
  assert.match(patch, /renderMembersSheet\(\)/);
  assert.match(patch, /renderLog\(\)/, 'archiving changes the empty-room sentence as well as the box');
});

/* ──────────────────────────────────────────────── the cap ───────────────── */

test('the cap is the server’s, and MAX_MEMBERS is only the fallback', () => {
  // `GET /api/rooms` answers `maxMembers` and that answer wins the moment it lands. A second
  // authority is how a client starts refusing what the server allows.
  assert.match(roomsCode, /let maxMembers = MAX_MEMBERS;/);
  const ask = fn('askCap', roomsCode);
  assert.match(ask, /fetch\('\/api\/rooms'\)/);
  assert.match(ask, /data\?\.maxMembers/);
  assert.match(roomsCode, /askCap\(renderCreateSheet\)/);
  assert.match(roomsCode, /askCap\(renderMembersSheet\)/);
  assert.match(roomsCode, /capRefusal\(maxMembers\)/, 'and the refusal names the cap in force');
  assert.match(roomsCode, /addReason\(room, rows, maxMembers\)/);
});

test('the ninth tick goes back off rather than being left on over a refusal', () => {
  // A control that lies about its own state is worse than one that says no.
  const pick = fn('pickRow', roomsCode);
  assert.match(pick, /tick\.checked = false;\s*\n\s*say\(capRefusal\(maxMembers\), true\);/);
});

test('the button and the tally are one function, so a press cannot beat the rule', () => {
  const sync = fn('syncCreate', roomsCode);
  assert.match(sync, /countLine\(s\.picked\.length, maxMembers\)/);
  assert.match(sync, /canCreate\(s\.name\.value, s\.picked\.length\)/);
  assert.match(fn('submitCreate', roomsCode), /createReason\(s\.name\.value, s\.picked\.length\)/,
    'and the refusal is said before the press is thrown away');
});

/* ───────────────────────────────────── asking before taking away ────────── */

test('remove and archive ask; add and unarchive do not', () => {
  /*
   * The ruling names *destructive* controls, not every control. Unarchiving puts a room back
   * in the open list and adding opens a channel — neither takes anything away, and a question
   * in front of every press is a question nobody reads.
   */
  assert.match(roomsCode, /armAsk\(drop, removeQuestion\(member\)/);
  assert.match(roomsCode, /armAsk\(btn, archiveQuestion\(room\)/);
  assert.doesNotMatch(fn('addNode', roomsCode), /armAsk/);
  const head = fn('renderHead', roomsCode);
  const unarch = head.slice(head.indexOf('if (room.archivedAt) {'), head.indexOf('} else {'));
  assert.doesNotMatch(unarch, /armAsk/, 'unarchiving takes nothing away, so it asks nothing');
});

test('one question at a time, a rebuild disarms it, and it lets go by itself', () => {
  /*
   * `web/m/lead.js`'s merge block, to the value. **One at a time** or a stack of asking rows
   * is a screen where a thumb cannot tell which tap is the one that acts; **a rebuild
   * disarms**, because a question carried across a repaint is a question about a row that may
   * not be the same row; **four seconds**, the fallback for nobody answering.
   */
  assert.match(roomsCode, /const ASK_MS = 4000;/);
  const arm = fn('armAsk', roomsCode);
  assert.match(arm, /^\s*disarmAsk\(\);/m, 'arming a second disarms the first');
  assert.match(arm, /setTimeout\(\(\) => disarmAsk\(\), ASK_MS\)/);
  const disarm = fn('disarmAsk', roomsCode);
  assert.match(disarm, /if \(within && !within\.contains\(group\)\) return;/, 'and it is scoped');
  assert.match(fn('renderMembersSheet', roomsCode), /disarmAsk\(s\.box\)/);
  assert.match(fn('renderHead', roomsCode), /disarmAsk\(el\.sub\)/);
});

test('the question folds its own row rather than sharing it', () => {
  // A phone row is 320px, and a question sharing it with a name and a dot ellipsises to
  // `remove alpha…` — a confirmation that has lost its target. Written as "everything in this
  // row that is not the question", so the next control put behind the idiom inherits it.
  assert.match(css, /\.m-room-asking > :not\(\.m-room-ask\)\s*\{[^}]*display:\s*none/);
});

/* ──────────────────────────────────── the box that must not read as ticked ─── */

test('the checkbox is drawn by the panel, not by the browser', () => {
  /*
   * Measured on the desktop's create-room bench and recorded in CLAUDE.md: page in light,
   * browser in dark, and an **unticked** native box came back a solid dark square — which in
   * a multi-select list is exactly what "chosen" looks like. `data-theme` is not a signal the
   * UA reads and no assertion can see the rendering. What can be held is that the box is
   * ours: `appearance: none`, our own frame, and a tick that is transparent until checked.
   */
  assert.match(css, /\.m-room-tick\s*\{[^}]*appearance:\s*none/);
  assert.match(css, /\.m-room-tick\s*\{[^}]*border:\s*1px solid var\(--rule-strong\)/);
  assert.match(css, /\.m-room-tick::before\s*\{[^}]*border:\s*solid transparent/, 'empty until ticked');
  assert.match(css, /\.m-room-tick::before\s*\{[^}]*rotate\(45deg\)/, 'a rotated rectangle, the shared shape');
  assert.match(css, /\.m-room-tick:checked\s*\{[^}]*background:\s*var\(--accent\)/);
  assert.match(css, /\.m-room-tick:checked::before\s*\{[^}]*border-color:\s*var\(--surface\)/);
  // Still a real checkbox — checked, focus, Space and the accessibility tree all come free,
  // and there is no second node that can disagree with the input's own state.
  assert.match(fn('pickRow', roomsCode), /tick\.type = 'checkbox'/);
});

test('every colour in the sheets is a token', () => {
  // The same reason the box is drawn at all: a literal here is a colour that does not move
  // with the theme, and the one thing this feature cannot afford is a control whose state is
  // read off a colour that is wrong in one of the two.
  const sheets = css.slice(css.indexOf('/* ============================================================== the list head'));
  assert.doesNotMatch(sheets, /:\s*#[0-9a-f]{3,8}\b/i, 'no hex');
  assert.doesNotMatch(sheets, /\brgba?\(/i, 'no rgb');
});

/* ───────────────────────────────────────── the size of a thumb ──────────── */

test('every row and control in the sheets clears the thumb floor', () => {
  // 44px is Apple's minimum target, and this is a list of things that open channels into live
  // terminals — a floor rather than a nicety.
  for (const sel of ['.m-room-pick,\\s*\\n\\.m-room-mrow,\\s*\\n\\.m-room-arow', '\\.m-room-make', '\\.m-room-btn', '\\.m-room-name-input']) {
    assert.match(css, new RegExp(`${sel}\\s*\\{[^}]*min-height:\\s*44px`), sel);
  }
});

test('the name field is 16px, like every other input on this phone', () => {
  // Safari zooms the page in below it and does not zoom back out.
  assert.match(css, /\.m-room-name-input\s*\{[^}]*font-size:\s*16px/);
});

test('nothing in the sheets can push the page sideways at 320', () => {
  // A horizontal scroll on a phone is the one layout bug you cannot get back out of by
  // scrolling. Every name, folder and question ellipsises inside its own row.
  for (const sel of ['\\.m-room-pick-name,\\s*\\n\\.m-room-mname', '\\.m-room-where', '\\.m-room-ask-q', '\\.m-room-sub-who']) {
    assert.match(css, new RegExp(`${sel}\\s*\\{[^}]*text-overflow:\\s*ellipsis`), sel);
  }
  assert.match(css, /\.m-room-sheet-note\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('the sheet pays the home-indicator inset at its bottom', () => {
  // The shell's `.m-sheet` already pays it; this one adds room under the last control, which
  // on the create sheet is a button and on the members sheet is a list.
  assert.match(css, /\.m-room-sheet\s*\{[^}]*env\(safe-area-inset-bottom\)/);
});

/* ─────────────────────────────────────────── three ways out, and a fourth ─── */

test('a sheet closes on the ✕, the backdrop, Escape — and a route change', () => {
  /*
   * The fourth is not a way out anybody presses. Every tab switch and every navigation into a
   * room is a `hashchange`, and without it a sheet opened on the Rooms tab would still be on
   * screen over the Leads list, repainting against a list that is no longer drawn.
   */
  const mount = between(roomsCode, 'function mountSheet', 'function sheetNote');
  assert.match(mount, /x\.addEventListener\('click', close\)/);
  assert.match(mount, /if \(e\.target === back\) close\(\)/);
  assert.match(mount, /e\.key === 'Escape'/);
  assert.match(mount, /window\.addEventListener\('hashchange', onHash\)/);
  assert.match(mount, /window\.removeEventListener\('hashchange', onHash\)/, 'and it is given back');
  assert.match(mount, /document\.removeEventListener\('keydown', onKey, true\)/);
  assert.match(mount, /disarmAsk\(box\)/, 'a question inside it goes with it');
});

test('a sheet opens once, and the overlay is the shell’s rather than a second one', () => {
  assert.match(fn('openCreateSheet', roomsCode), /if \(createSheet \|\| typeof document === 'undefined'\) return;/);
  assert.match(fn('openMembersSheet', roomsCode), /if \(membersSheet \|\| typeof document === 'undefined'\) return;/);
  // `.m-sheet*` is `m.css`'s, from the start sheet. A second description of one overlay is
  // two things free to disagree about a safe area.
  const mount = between(roomsCode, 'function mountSheet', 'function sheetNote');
  assert.match(mount, /'m-sheet m-room-sheet'/);
  assert.match(mount, /document\.body\.append\(back\)/);
  assert.doesNotMatch(strip(css), /\.m-room-sheet-back/, 'and rooms.css does not draw one of its own');
});

test('the name field is not focused on open', () => {
  /*
   * Where this parts company with the desktop modal it is otherwise built from. Focusing it
   * opens the software keyboard, and the keyboard covers the bottom half of a
   * bottom-anchored sheet — which here is the picker and both buttons, i.e. everything the
   * sheet is for.
   */
  assert.doesNotMatch(fn('openCreateSheet', roomsCode), /\.focus\(\)/);
});

/* ─────────────────────────────────────── the archived room takes nothing ─── */

test('an archived room offers neither control, on the header or in the sheet', () => {
  // The ruling of 2026-08-26: a control that cannot be answered correctly should not be a
  // control. The server refuses it too — this is the polite half of a rule enforced elsewhere.
  assert.match(fn('renderHead', roomsCode), /el\.members\.hidden = !room \|\| Boolean\(room\.archivedAt\)/);
  const sheet = fn('renderMembersSheet', roomsCode);
  assert.match(sheet, /s\.addCap\.hidden = archived/);
  assert.match(sheet, /s\.addList\.hidden = archived/);
  assert.match(sheet, /const addable = archived \? \[\] : addableSessions/);
  assert.match(fn('memberNode', roomsCode), /if \(!archived\) \{/, 'and no remove either');
});

test('a member the panel cannot find is drawn gone, never dropped', () => {
  // A row that vanished would leave a membership the phone and the server disagree about,
  // silently. `memberRow` mirrors the server's own rung order and decides only the dot.
  const sheet = fn('renderMembersSheet', roomsCode);
  assert.match(sheet, /memberRow\(m, rows\)/);
  assert.match(sheet, /dot\.dataset\.status = row \? row\.status \|\| '' : 'gone'/);
  assert.match(css, /\.m-room-live\[data-status='gone'\]/);
});
