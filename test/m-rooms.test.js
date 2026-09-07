import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  archivedIsOpen,
  composerRefusal,
  memberNames,
  memberStrip,
  quietText,
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
