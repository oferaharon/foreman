/*
 * rooms.js — item 4. The Rooms tab's list, and the room screen behind it.
 *
 * A room is a named place a handful of sessions coordinate in: a member posts once, the
 * panel appends one entry and types a copy into every *other* member's terminal. The Mac
 * has had this since rooms shipped; the phone had a placeholder with a real count in it.
 * This is the list and the screen.
 *
 * **Its own module with its own state, and that is the point** rather than tidiness.
 * `web/m/lead.js` keeps one module-scoped `view` object, justified in its own comment by
 * "a phone shows one thing at a time" — which survives tabs only if a second screen gets
 * its own module rather than a `kind` field bolted onto that one, which half its functions
 * would then have to remember to check. The desktop's `createPane` factory exists because
 * that shortcut was taken once already.
 *
 * Two halves live here and they are deliberately not symmetrical:
 *
 *   **The list** (`roomsListView`) is a body for the home screen's tab, in the same
 *   `{sig, nodes}` contract the other two tabs answer — the signature is what
 *   `renderHome`'s repaint guard compares and the nodes are a thunk, so nothing is built
 *   for a paint that is turned away.
 *
 *   **The screen** (`mountRoom` / `updateRoom`) is a whole route, in `mountLead`'s shape:
 *   the shell hides its header, this draws its own, and everything it holds is torn down
 *   when the route leaves.
 *
 * What it does **not** hold, and where the next item mounts: creating a room and editing
 * its membership. Item 5 owns that, and the two places for it are marked `ITEM 5` below —
 * a `+` on the list's own head, and a sheet on `document.body` in the start sheet's idiom
 * (`openStartSheet` in `web/m/app.js`). Nothing here needs to change shape for it.
 *
 * Five rules it carries, each already paid for somewhere in this repo:
 *
 * **A post carries `{text}` and nothing else.** Omitting `paneId` is the *whole* of who is
 * speaking: the endpoint reads a pane id as a session posting through its own tool and
 * nothing as the panel, and the panel is the maintainer — which is what selects
 * `roomHumanLine` and the `| ` prefix no session's body can forge. There is no `speaker`
 * field and there must never be one.
 *
 * **The word is `handed`, never *delivered*.** `handedText` is asked rather than
 * re-spelled: a queued copy waits for a pane to go idle, which may be hours and may be
 * never, and nothing writes back to an append-only log.
 *
 * **The subscription dies with the socket.** `leaveRoute` unsubscribes and `ws.onopen`
 * re-subscribes, both in `web/m/app.js`, for the reason its own comment gives — a screen
 * that looks perfectly alive over a log that stopped minutes ago is this project's
 * signature failure.
 *
 * **Nothing about a room joins a card, composer or ghost signature.** Those tear a
 * textarea down when they change, and this screen is not on the same route as any of them
 * anyway; the rule is written down so it stays true when somebody merges the two.
 *
 * **Only rendered strings in a signature.** No raw `lastAt`, no `Date.now()` — the home
 * screen's guard is what stops the list being rebuilt under a thumb twice a second, and a
 * timestamp in it retires the guard entirely.
 *
 * It is import-safe in node: nothing here touches `document`, `window` or `localStorage`
 * at module scope, so `test/m-rooms.test.js` drives the pure half for real rather than
 * reading it out of the source.
 */

import { bandEntries, memberLabel, unseenText } from '../rooms-band.js';
import {
  addressedText,
  handedText,
  handedWaiting,
  insertMention,
  mentionMatches,
  mentionQuery,
  roomOrdered,
} from '../rooms-pane.js';
import { colourFor } from '../session-colour.js';

/** Close enough to the bottom to count as caught up, in px. `lead.js`'s own figure — one
 *  device, one idea of "at the bottom". */
const NEAR_BOTTOM = 120;

/** Room composer drafts, this view's own key. `/` and `/m/` are one origin, so a key the
 *  desktop also writes would be two features sharing one string. */
const DRAFTS_KEY = 'foreman.m.roomdrafts';

/** How many member names a row shows before it says "+N". Eight is the cap on a room, and
 *  eight names do not fit on a 320px row at any size worth reading. */
const STRIP_NAMES = 3;

/* ============================================================== the list === */

/**
 * Whether the archived fold is open, for as long as this page is loaded.
 *
 * Module scope rather than a stored preference: it is a fold on one list on one screen,
 * and `web/prefs.js` is for settings that mean the same thing on both front doors. The
 * desktop's band keeps its own for the same reason.
 */
let archivedOpen = false;

/** The fold's state, for a test that would otherwise have to press a button to read it. */
export const archivedIsOpen = () => archivedOpen;

/**
 * The names on a row, and what is left over.
 *
 * `memberLabel` and not `memberName` (`rooms-pane.js`): this is a *label*, and that one
 * falls back to the words `a session` for a member holding no id at all — fine on a chip,
 * wrong in a comma-joined strip where it reads as somebody's name. A member with no label
 * at all is dropped rather than drawn as an empty gap.
 */
export function memberNames(room, limit = STRIP_NAMES) {
  const all = (Array.isArray(room?.members) ? room.members : []).map(memberLabel).filter(Boolean);
  if (all.length <= limit) return { names: all, more: 0 };
  return { names: all.slice(0, limit), more: all.length - limit };
}

/** The strip as one string — what the row actually draws, and therefore what its signature
 *  carries. One function, both readers. */
export function memberStrip(room, limit = STRIP_NAMES) {
  const { names, more } = memberNames(room, limit);
  if (!names.length) return 'no members';
  return more ? `${names.join(', ')} +${more}` : names.join(', ');
}

/**
 * Everything the list draws, as one string.
 *
 * `bandSig` one module up answers the same question for the rail and is deliberately not
 * reused: it carries `lastAt` (a raw millisecond stamp, which this screen does not draw)
 * and `openIds` (a desktop pane's open room, which a phone has no concept of), and it does
 * not carry the member strip, which this screen does draw. A signature that names fields
 * the face does not draw is only wasteful; one that misses a field the face *does* draw is
 * a row that never repaints. So this one is its own, and every field in it is a **rendered
 * string or a boolean**.
 *
 * Joined with real punctuation — `|` within a row, `~` between them. `mergeSig` on the
 * desktop once joined with what read in every editor as an empty string and was three
 * literal control bytes, so two different lists could spell one signature.
 */
export function roomsSig(rooms = [], { archivedOpen: open = false } = {}) {
  return bandEntries(rooms, { archivedCollapsed: !open })
    .map((e) =>
      e.kind === 'fold'
        ? ['fold', e.count, e.collapsed ? 1 : 0].join('|')
        : [
            'room',
            e.room.id,
            e.room.name,
            memberStrip(e.room),
            unseenText(e.room.unseen),
            e.archived ? 1 : 0,
          ].join('|'),
    )
    .join('~');
}

/**
 * The Rooms tab's body, in the same `{sig, startable, nodes}` contract the other two answer.
 *
 * `startable` is `0` and stays `0`: it is the header `+`'s count, and that control starts a
 * *lead*. ITEM 5's `+ room` is a different control and belongs on this list's own head —
 * see the head builder below.
 *
 * `state.rooms === null` is a third answer and not a missing one: rooms ride on the roster
 * frame only, so a phone that has painted from `GET /api/sessions` has sessions and no
 * rooms yet. Saying "no rooms" there would be the panel showing something wrong.
 */
export function roomsListView(rooms, { onOpen, onChange } = {}) {
  if (rooms === null || rooms === undefined) {
    return { sig: 'rm:loading', startable: 0, nodes: () => [note('Loading rooms…')] };
  }

  const list = Array.isArray(rooms) ? rooms : [];
  if (!list.length) {
    return {
      sig: 'rm:empty',
      startable: 0,
      nodes: () => [
        // ITEM 5: when a room can be made from here, this sentence is what the `+ room`
        // control replaces. It deliberately does not say "make one at the Mac" — the
        // maintainer's ruling of 2026-09-07 (open question A) put creation on the phone, so
        // a sentence sending them to the Mac would be wrong within one item.
        note('No rooms yet. A room is a named place a few sessions coordinate in — every post is typed into every other member’s terminal.'),
      ],
    };
  }

  return {
    sig: `rm:${roomsSig(list, { archivedOpen })}`,
    startable: 0,
    nodes: () =>
      bandEntries(list, { archivedCollapsed: !archivedOpen }).map((entry) =>
        entry.kind === 'fold'
          ? foldRow(entry, onChange)
          : roomRow(entry.room, { archived: Boolean(entry.archived), onOpen }),
      ),
  };
}

/**
 * One room.
 *
 * A three-column grid in `.m-team-body`'s own shape — the waiting gutter, the text, and a
 * trailing count — so a room row and a team row line their marks up down the screen. The
 * mark is `.m-dot-wait`, the same one the team card and the tab bar use, because it is the
 * same fact at three depths: **something in here wants you**.
 *
 * `unseen` is what lights it, and note whose posts it counts: the store increments it only
 * for a *session's* post (`by !== null`), so the maintainer's own posts never badge a room.
 * A bench that only posts from the phone will watch this stay dark and conclude the feature
 * is broken.
 */
function roomRow(room, { archived = false, onOpen } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `m-room-item${archived ? ' is-archived' : ''}`;

  const body = document.createElement('button');
  body.className = 'm-room-body';
  body.type = 'button';
  body.addEventListener('click', () => onOpen?.(room.id));

  const unseen = unseenText(room.unseen);

  /*
   * One slot, not the team card's two. `.m-dots` is that card's *pair* of reserved rows —
   * "wants you" over "is running" — and a room has no second fact to put in the lower one,
   * so borrowing the gutter would draw a dot two pixels high of centre for ever. The dot
   * itself is `.m-dot-wait`, shared on purpose: it is the same mark on the row, on the tab
   * and on a team card, because it is the same fact at three depths.
   */
  const dot = document.createElement('span');
  dot.className = `m-dot m-dot-wait m-room-dot${unseen ? ' is-on' : ''}`;
  if (unseen) dot.title = `${room.unseen} said in here since you last looked`;
  body.append(dot);

  const name = document.createElement('span');
  name.className = 'm-room-name';
  name.textContent = room.name;
  body.append(name);

  if (unseen) {
    body.classList.add('has-badge');
    const badge = document.createElement('span');
    badge.className = 'm-room-unseen';
    badge.textContent = unseen;
    badge.title = `${room.unseen} since you last opened this room`;
    body.append(badge);
  }

  // The membership, names only and read-only — who is in a room is what a room *is*, and
  // it is the one fact a row can carry that a count cannot. Editing it is ITEM 5's, and on
  // the room screen rather than here.
  const meta = document.createElement('span');
  meta.className = 'm-room-meta';
  if (archived) {
    const tag = document.createElement('span');
    tag.className = 'm-room-tag';
    tag.textContent = 'archived';
    tag.title = 'Read it, but nothing more is typed into anyone.';
    meta.append(tag);
  }
  const who = document.createElement('span');
  who.className = 'm-room-who';
  who.textContent = memberStrip(room);
  meta.append(who);
  body.append(meta);

  wrap.append(body);
  return wrap;
}

/** The archived fold: the rail band's own row, at a thumb's size. */
function foldRow(entry, onChange) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'm-room-fold';
  row.setAttribute('aria-expanded', String(!entry.collapsed));

  const caret = document.createElement('span');
  caret.className = 'm-room-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = entry.collapsed ? '▸' : '▾';

  const label = document.createElement('span');
  label.className = 'm-room-fold-name';
  label.textContent = `archived (${entry.count})`;

  row.append(caret, label);
  row.addEventListener('click', () => {
    archivedOpen = !archivedOpen;
    onChange?.();
  });
  return row;
}

/** The screen's one sentence, in the shell's own shape. `m.css` owns `.m-note`. */
function note(text) {
  const el = document.createElement('div');
  el.className = 'm-note';
  el.textContent = text;
  return el;
}

/* ============================================================ the screen === */

/*
 * Keep the composer above the software keyboard.
 *
 * `100dvh` is the honest viewport height and the shell is laid out on it — but on iOS
 * Safari the keyboard does not change it: the layout viewport stays the full height and the
 * keyboard is drawn over the bottom of it, so a bottom-anchored composer ends up
 * underneath. `visualViewport` is the only thing that reports the covered strip, and the
 * inset is applied as padding on the frame — `.m-room` is a border-box flex column, so
 * padding at the bottom lifts the composer by exactly that much. `web/m/lead.js` does the
 * same for its own screen and the two do not collide: each reads its own `view.host`, and a
 * phone shows one of them at a time.
 *
 * The `typeof window` guard is not defensive noise: this module is imported by
 * `test/m-rooms.test.js` in node, and a bare `window` here would throw at import.
 */
if (typeof window !== 'undefined' && window.visualViewport) {
  const applyInset = () => {
    const host = view.host;
    if (!host?.isConnected) return;
    const vv = window.visualViewport;
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // Under about 80px it is the address bar shrinking, not a keyboard, and paying it as
    // padding would leave a permanent gap under the composer on every scroll.
    host.style.setProperty('--m-kb', covered > 80 ? `${Math.round(covered)}px` : '0px');
  };
  window.visualViewport.addEventListener('resize', applyInset);
  window.visualViewport.addEventListener('scroll', applyInset);
}

/**
 * Everything the room screen holds.
 *
 * Module scope for `lead.js`'s reason and no other: the contract is two free functions and
 * there is exactly one room screen at a time. It is reset wholesale by `mountRoom`, so a
 * field left behind by the last room cannot leak into the next one.
 */
const view = {
  host: null,
  ctx: null,
  /** The room record, from the `group-room` frame first and the roster after. */
  room: null,
  /** `true` once the server has answered for this id, so "loading" and "no such room" stay
   *  different answers — the same distinction `state.rooms === null` makes one screen up. */
  answered: false,
  entries: [],
  /** Follow the newest line only while the reader is at the bottom of it. */
  follow: true,
  /** Arrivals since the reader stopped following, for the quiet pill. */
  unseen: 0,
  /** How many entries the last paint drew, so the pill counts arrivals and not the tail. */
  painted: 0,
  sending: false,
  /** The server's own refusal from the last send, held rather than appended to a node a
   *  repaint has already replaced. */
  error: null,
  el: null,
  timers: [],
};

/* -------------------------------------------------------------- drafts --- */

function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function draftFor(id) {
  return (id && readDrafts()[id]) || '';
}

function setDraft(id, text) {
  if (!id) return;
  try {
    const drafts = readDrafts();
    if (text) drafts[id] = text;
    else delete drafts[id];
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* a full or disabled store must not stop anyone typing */
  }
}

/* --------------------------------------------------------------- mount --- */

/**
 * Build the screen.
 *
 * `ctx` is the shell's window onto itself and this uses six of it: `roomId`, `room()`,
 * `rooms()`, `homeHash()`, `connected()`, `send` and `on`. Nothing else here reaches into
 * `web/m/app.js`.
 *
 * The subscription is **the shell's**, not this module's — `enterRoom` sends it and
 * `leaveRoute` takes it back, and `ws.onopen` re-sends it after a reconnect. Kept there
 * because that is the one place that knows the socket came back, and the failure of
 * forgetting is invisible from here.
 */
export function mountRoom(host, ctx) {
  for (const t of view.timers) clearInterval(t);

  Object.assign(view, {
    host,
    ctx,
    room: ctx.room(),
    answered: false,
    entries: [],
    follow: true,
    unseen: 0,
    painted: 0,
    sending: false,
    error: null,
    el: null,
    timers: [],
  });

  host.classList.add('m-room');
  host.replaceChildren();
  view.el = build(host);

  ctx.on('group-room', (msg) => {
    if (msg.roomId !== ctx.roomId) return;
    view.answered = true;
    // A room the server says is not there. `msg.room` is null then, and the head has to say
    // so rather than draw an empty log that reads as a room with nothing in it.
    if (msg.room) view.room = msg.room;
    view.entries = msg.entries || [];
    // A frame is either the first paint or a re-subscribe after the socket came back. Both
    // want the newest line, so both pin to the bottom.
    view.follow = true;
    view.unseen = 0;
    renderHead();
    renderLog();
    // Opening a room spends its count — the reader is looking at it. Account-wide by
    // design: the badge clears on the Mac too, which is the desktop's existing behaviour
    // and not this screen's to change.
    markSeen();
  });

  ctx.on('group-room-append', (msg) => {
    if (msg.roomId !== ctx.roomId || !msg.entry) return;
    view.entries.push(msg.entry);
    renderLog();
    // At the newest line the count is spent the moment this lands; scrolled up it is not,
    // and the pill over the log is what says so.
    if (view.follow) markSeen();
  });

  watchConnection();

  // Painted only now that `host` is in the document. Everything below measures something
  // (`scrollHeight`, `clientHeight`), and a paint that runs before its container is mounted
  // draws nothing and says nothing about it — a busy screen self-heals on the next frame
  // while a quiet one stays blank for hours, which is exactly how the desktop's room panel
  // shipped once.
  renderHead();
  renderLog();
}

/**
 * A roster frame arrived, or the route is checking on us.
 *
 * The roster is the fresher of the two sources — a `PATCH` broadcasts one and the
 * `group-room` frame is only sent at subscribe — so a rename or an archive reaches the head
 * through here. A `null` is ignored rather than blanking the head: a room is never deleted,
 * so a missing record means the roster has not been asked yet.
 */
export function updateRoom(room) {
  if (!view.el || !view.host?.isConnected) return;
  if (!room) return;
  view.room = room;
  renderHead();
  renderComposer();
}

/* ------------------------------------------------------------ the frame --- */

function build(host) {
  const el = {};

  /* --- header: out, which room, and the socket --- */

  const head = document.createElement('header');
  head.className = 'm-room-head';

  const top = document.createElement('div');
  top.className = 'm-room-top';

  el.back = document.createElement('button');
  el.back.type = 'button';
  el.back.className = 'm-room-back';
  el.back.textContent = '‹';
  el.back.setAttribute('aria-label', 'Back to rooms');
  el.back.addEventListener('click', () => {
    // The tab you left, which on this route is always Rooms — asked of the shell rather
    // than spelled `#/rooms` here, so there is one answer to "where does back go".
    location.hash = view.ctx?.homeHash() || '#/rooms';
  });

  el.title = document.createElement('div');
  el.title.className = 'm-room-title';

  /*
   * The socket, read from the shell rather than from a second WebSocket of our own.
   *
   * `lead.js`'s `watchConnection` makes the same call and says why at length: a second
   * socket can be up while the shell's is down, and would then draw a live indicator over a
   * log that has genuinely stopped. It reaches for the shell's DOM with a literal selector;
   * this one asks `ctx.connected()`, which is the same fact one layer earlier and cannot be
   * broken by a header refactor.
   */
  el.conn = document.createElement('span');
  el.conn.className = 'm-room-conn';
  el.conn.textContent = '●';

  top.append(el.back, el.title, el.conn);

  // Row 2: who is in here, and whether it still takes posts. Read-only — ITEM 5 is what
  // makes this editable, and a `+` belongs on this row beside the names.
  el.sub = document.createElement('div');
  el.sub.className = 'm-room-sub';

  head.append(top, el.sub);

  /* --- the log --- */

  const body = document.createElement('div');
  body.className = 'm-room-body-wrap';

  el.stream = document.createElement('div');
  el.stream.className = 'm-room-stream';
  el.stream.addEventListener('scroll', onScroll, { passive: true });

  el.inner = document.createElement('div');
  el.inner.className = 'm-room-inner';
  el.stream.append(el.inner);

  /*
   * `N new below ↓`, and it exists only while the reader is not following.
   *
   * The other half of "do not yank the reader": leaving the scroll alone means an arrival
   * lands off screen with nothing to mark it. Absolutely positioned against the wrapper, so
   * it never reflows the log under whoever is reading it; muted, no accent, no motion.
   */
  el.new = document.createElement('button');
  el.new.type = 'button';
  el.new.className = 'm-room-new';
  el.new.hidden = true;
  el.new.addEventListener('click', () => {
    view.follow = true;
    view.unseen = 0;
    pin();
    paintNew();
    markSeen();
  });

  body.append(el.stream, el.new);

  /* --- the composer --- */

  el.composer = document.createElement('div');
  el.composer.className = 'm-room-composer';

  el.err = document.createElement('div');
  el.err.className = 'm-room-err';
  el.err.hidden = true;

  /*
   * The `@name` menu, built once and shown or hidden.
   *
   * It changes nothing about who gets a copy — every member still hears everything, which
   * is the maintainer's own ruling — and the parse is server-side either way (`mentionsIn`
   * in `server/rooms-line.js`, the single implementation). This is an aid to spelling a
   * name correctly with a thumb, which is exactly the device where that is worth having.
   *
   * Absolutely placed above the row, so it opens *over* the log rather than pushing the
   * textarea down under whoever is typing into it.
   */
  el.menu = document.createElement('div');
  el.menu.className = 'm-room-mention';
  el.menu.hidden = true;

  const row = document.createElement('div');
  row.className = 'm-room-row';

  el.ta = document.createElement('textarea');
  el.ta.className = 'm-room-input';
  el.ta.rows = 1;
  el.ta.placeholder = 'say it once, to everyone…';
  el.ta.value = draftFor(view.ctx?.roomId);
  el.ta.addEventListener('input', () => {
    setDraft(view.ctx?.roomId, el.ta.value);
    autoGrow();
    syncSend();
    syncMention();
  });
  // A click or an arrow key moves the caret without changing the text, so the menu is
  // re-asked there too — otherwise it stays open over a token the caret has left.
  el.ta.addEventListener('click', syncMention);
  el.ta.addEventListener('blur', () => closeMention());
  el.ta.addEventListener('keydown', onKey);

  el.send = document.createElement('button');
  el.send.type = 'button';
  el.send.className = 'm-room-send';
  el.send.textContent = '→';
  el.send.setAttribute('aria-label', 'Send to everyone in this room');
  el.send.addEventListener('click', submit);

  row.append(el.ta, el.send);

  /*
   * What a line typed here *is*, said every time rather than in a tooltip nobody opens —
   * the desktop's composer makes the same claim in the same words, because the envelope
   * makes exactly this claim on the way out. Both halves matter: it carries the
   * maintainer's own authority (the `| ` prefix, which no session's body can reach), and it
   * reaches everybody (a room fans out to every other member, so it is never a quiet word
   * to one of them).
   */
  el.say = document.createElement('div');
  el.say.className = 'm-room-say';
  el.say.textContent = 'your own words, to every member';
  el.say.title =
    'This goes out as your own line, prefixed so no session can forge it, and a copy is ' +
    'typed into every member’s terminal.';

  el.composer.append(el.err, el.menu, row, el.say);

  host.append(head, body, el.composer);
  return el;
}

/* ------------------------------------------------------------ the head --- */

function renderHead() {
  const el = view.el;
  if (!el) return;
  const room = view.room;

  el.title.textContent = room?.name || (view.answered ? 'no such room' : 'room');
  el.title.title = room?.name || '';

  const parts = [];
  if (room?.archivedAt) parts.push('archived');
  if (room) {
    const n = room.memberCount ?? (room.members?.length || 0);
    parts.push(`${n} ${n === 1 ? 'member' : 'members'}`);
    const strip = memberStrip(room, 8);
    if (strip && strip !== 'no members') parts.push(strip);
  }
  el.sub.textContent = parts.join(' · ');
  el.sub.hidden = parts.length === 0;
  el.sub.classList.toggle('is-archived', Boolean(room?.archivedAt));
}

/**
 * The socket's state, polled off the shell.
 *
 * A plain interval, not a `MutationObserver` and not `requestAnimationFrame`: an automated
 * Chrome window reports `visibilityState: 'hidden'` and Chrome suspends the frame-driven
 * callbacks there, which has cost this project two separate hours. Timers are not affected.
 */
function watchConnection() {
  const tick = () => {
    if (stopIfDetached()) return;
    const el = view.el;
    const down = view.ctx?.connected() === false;
    el.conn.className = `m-room-conn${down ? ' is-down' : ''}`;
    el.conn.textContent = down ? 'offline' : '●';
    el.conn.title = down ? 'The socket is down — this room is not updating.' : 'connected';
  };
  tick();
  view.timers.push(setInterval(tick, 1000));
}

/** The contract has no unmount, so anything left ticking stops itself. */
function stopIfDetached() {
  if (view.host?.isConnected) return false;
  for (const t of view.timers) clearInterval(t);
  view.timers = [];
  return true;
}

/* ------------------------------------------------------------- the log --- */

/**
 * Paint the room.
 *
 * `scrollTop` is read **before** the swap. Reading it after `replaceChildren` is a forced
 * layout on an emptied box, which clamps the answer to zero before you have read it — the
 * desktop aside's own bug, which put the reader at the top of the list on every arriving
 * line.
 */
function renderLog() {
  const el = view.el;
  if (!el || !el.inner.isConnected) return;
  const held = el.stream.scrollTop;
  // **Sorted on `ts`, never on `seq`** — see `roomOrdered`'s own note in
  // `web/rooms-pane.js` for why the two come apart, and why `seq` is still the tie-break.
  const entries = roomOrdered(view.entries);

  if (!entries.length) {
    el.inner.replaceChildren(quiet());
    view.painted = 0;
    view.unseen = 0;
    paintNew();
    renderComposer();
    return;
  }

  const before = view.painted;
  el.inner.replaceChildren(...entries.map(entryNode));
  view.painted = entries.length;

  if (view.follow) {
    pin();
    view.unseen = 0;
  } else {
    // Put the reader back exactly where they were. The entries above them are the same
    // entries at the same heights they had last paint, so the old offset is still right —
    // it is only wrong to keep if you are following the bottom.
    el.stream.scrollTop = held;
    // Floored rather than trusted: a full `group-room` frame can be *shorter* than what is
    // on screen (the tail is capped), and a negative count would hide a hint that is due.
    view.unseen += Math.max(0, entries.length - before);
  }
  paintNew();
  renderComposer();
}

function quiet() {
  const box = document.createElement('div');
  box.className = 'm-room-quiet';
  box.textContent = view.answered && !view.room
    ? 'There is no room with that id. It may have been opened from a stale link.'
    : 'Nothing said in here yet. Anything a member posts — or anything you type below — is typed into every other member’s terminal.';
  return box;
}

/**
 * One post.
 *
 * The two speakers are drawn **as two lanes**, which is the phone's answer to "draw them
 * distinguishably": the maintainer's own line sits right with an accent tint, a session's
 * sits left with its own colour off `colourFor`. That is the same distinction the terminal
 * sees as `| ` against `> ` — the first is the maintainer's word and authorizes, the second
 * is another session and does not — and a phone is the one screen where a pill alone is
 * easy to skim past.
 *
 * `to` here is an **array of member names**. One pane over on the desktop, a peer-message
 * entry carries a `to` that is an object `{name, cwd}`, and the two nodes that draw them
 * read almost identically — `addressedNames`' `Array.isArray` guard is what keeps them
 * apart and is load-bearing rather than defensive noise. This side never re-reads the text
 * for `@` tokens: the parse is `mentionsIn`'s, once, on the server.
 */
function entryNode(e) {
  const human = e.kind === 'human';
  const name = e.from || 'unknown';

  const wrap = document.createElement('div');
  wrap.className = `m-room-msg ${human ? 'is-mine' : 'is-peer'}`;

  const meta = document.createElement('div');
  meta.className = 'm-room-msg-meta';

  const who = document.createElement('span');
  who.className = `m-room-pill${human ? ' is-mine' : ''}`;
  who.textContent = human ? 'you' : name;
  if (human) {
    who.title = 'You, from this room — every member gets a copy carrying your authority.';
  } else {
    // The hue is set inline off the ring rather than by a class per slot: `--peer-N` is
    // seven tokens and a class each would be seven near-identical rules that a later change
    // to `PEER_COLOUR_COUNT` would silently leave short.
    who.style.color = `var(--peer-${colourFor(name)})`;
    who.style.borderColor = 'currentColor';
    who.title = name;
  }
  meta.append(who);

  if (e.ts) {
    const t = document.createElement('span');
    t.className = 'm-room-time';
    const d = new Date(e.ts);
    t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    t.title = d.toLocaleString();
    meta.append(t);
  }

  const addressed = addressedText(e);
  if (addressed) {
    const to = document.createElement('span');
    to.className = 'm-room-to';
    to.textContent = addressed;
    to.title =
      'Addressed with @name. Every member still got a copy — a mention changes what each ' +
      'one was told, not who was told.';
    meta.append(to);
  }

  const bubble = document.createElement('div');
  bubble.className = 'm-room-bubble';

  const text = document.createElement('div');
  text.className = 'm-room-text';
  // The body as it was posted and nothing else. The line each member's terminal received
  // carries the same words wrapped in the envelope's peer-safety boilerplate, and a bubble
  // built from that would be the boilerplate.
  text.textContent = e.text || '';
  bubble.append(text);

  // What became of this post, on **every** entry rather than only the maintainer's: a room
  // fans out from whoever spoke. The word is **handed**, never *delivered*.
  const line = document.createElement('div');
  line.className = `m-room-handed${handedWaiting(e) ? ' is-waiting' : ''}`;
  line.textContent = handedText(e);
  line.title =
    'Handed means typed into a terminal or put in that pane’s queue. Nothing here says ' +
    'anybody read it.';
  bubble.append(line);

  wrap.append(meta, bubble);
  return wrap;
}

/** Put the log back on its newest line — but only while you are following it. */
function pin() {
  const el = view.el;
  if (!el || !el.stream.isConnected) return;
  el.stream.scrollTop = el.stream.scrollHeight;
}

function onScroll() {
  const el = view.el;
  if (!el) return;
  const gap = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight;
  const following = gap <= NEAR_BOTTOM;
  if (following === view.follow) return;
  view.follow = following;
  if (following) {
    view.unseen = 0;
    markSeen();
  }
  paintNew();
}

function paintNew() {
  const el = view.el;
  if (!el) return;
  const n = view.follow ? 0 : view.unseen;
  el.new.hidden = n === 0;
  if (n === 0) return;
  el.new.textContent = n === 1 ? '1 new below ↓' : `${n} new below ↓`;
  el.new.title = 'Jump to the newest message and follow the room again.';
}

/**
 * Tell the server this room's count is spent.
 *
 * Account-wide by construction — `rooms.seen()` zeroes one number for the machine — so
 * opening a room here clears the badge on the Mac and vice versa. That is the desktop's
 * existing behaviour and not a phone bug.
 */
function markSeen() {
  const id = view.ctx?.roomId;
  if (!id) return;
  view.ctx.send({ type: 'markGroupRoomRead', roomId: id });
}

/* -------------------------------------------------------- the composer --- */

/**
 * The box, or the sentence that stands where it would be.
 *
 * An archived room is readable and takes nothing more, so the composer goes rather than
 * being left disabled with nothing saying why: a control the maintainer cannot use should
 * not be a control (the ruling of 2026-08-26). The server refuses it too — a 409 with its
 * own sentence — so this is the polite half of a rule that is enforced elsewhere.
 */
export function composerRefusal(room, { answered = true } = {}) {
  if (!answered) return null;
  if (!room) return 'There is no room with that id, so there is nothing to post to.';
  if (room.archivedAt) return `“${room.name}” is archived. It is still readable; nothing more can be posted to it.`;
  return null;
}

function renderComposer() {
  const el = view.el;
  if (!el) return;
  const refusal = composerRefusal(view.room, { answered: view.answered });

  if (refusal) {
    el.err.textContent = refusal;
    el.err.hidden = false;
    el.err.classList.add('is-refusal');
    el.ta.hidden = true;
    el.send.hidden = true;
    el.say.hidden = true;
    closeMention();
    return;
  }

  el.err.classList.remove('is-refusal');
  el.err.textContent = view.error || '';
  el.err.hidden = !view.error;
  el.ta.hidden = false;
  el.send.hidden = false;
  el.say.hidden = false;
  syncSend();
}

function autoGrow() {
  const ta = view.el?.ta;
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

function syncSend() {
  const el = view.el;
  if (!el) return;
  el.send.disabled = view.sending || !el.ta.value.trim();
}

/* ---- `@name` ---- */

/*
 * The menu's state is a plain pair of module fields rather than anything on `view`, and it
 * is reset by `mountRoom` through `view.el` going with the screen: there is nothing for a
 * half-typed `@alp` to survive, because the box it belongs to is torn down with the route.
 *
 * `mutedAt` is what makes dismissal stick: without it the very next keystroke re-detects
 * the same `@` and reopens the menu the reader just closed.
 */
let mention = null; // {start, names, index} while the menu is up
let mentionMuted = -1;

function closeMention({ muted = false } = {}) {
  if (muted && mention) mentionMuted = mention.start;
  mention = null;
  const el = view.el;
  if (!el) return;
  el.menu.hidden = true;
  el.menu.replaceChildren();
}

function paintMention() {
  const el = view.el;
  if (!el) return;
  el.menu.replaceChildren();
  if (!mention) {
    el.menu.hidden = true;
    return;
  }
  el.menu.hidden = false;
  mention.names.forEach((name, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `m-room-mention-row${i === mention.index ? ' is-on' : ''}`;
    row.textContent = name;
    // The name travels on the node, never the index: a room's membership can change between
    // this paint and the tap, and a position would then choose whoever moved into that slot.
    row.dataset.name = name;
    // `mousedown`/`touchstart` prevented so focus never leaves the textarea — a blur here
    // would close the menu before the click landed.
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => chooseMention(name));
    el.menu.append(row);
  });
}

function chooseMention(name) {
  const el = view.el;
  if (!el) return;
  const q = mentionQuery(el.ta.value, el.ta.selectionStart ?? 0);
  if (!q) return void closeMention();
  const next = insertMention(el.ta.value, q.start, el.ta.selectionStart ?? 0, name);
  el.ta.value = next.value;
  el.ta.selectionStart = next.caret;
  el.ta.selectionEnd = next.caret;
  closeMention();
  autoGrow();
  syncSend();
  setDraft(view.ctx?.roomId, el.ta.value);
  el.ta.focus();
}

function syncMention() {
  const el = view.el;
  if (!el || el.ta.hidden) return;
  const q = mentionQuery(el.ta.value, el.ta.selectionStart ?? 0);
  if (!q || q.start === mentionMuted) return void closeMention();
  const names = mentionMatches(q.query, view.room);
  // Nothing matches: no menu rather than an empty box saying so. A room's membership is
  // eight names at most, and a mention naming nobody is plain text rather than an error.
  if (!names.length) return void closeMention();
  const moved = !mention || mention.start !== q.start;
  mention = { start: q.start, names, index: moved ? 0 : Math.min(mention.index, names.length - 1) };
  paintMention();
}

/**
 * The keyboard, and note what is **not** bound.
 *
 * **Enter is a newline, not a send.** The desktop's room composer does send on Enter and
 * this deliberately does not follow it, for the reason `lead.js`'s own composer already
 * records against the same keyboard: on a phone the return key is a newline and nothing
 * else, and a send bound to it fires a half-written message every time. Two composers on
 * one device that disagreed about the return key would be worse than either rule.
 *
 * The one exception is a menu that is up, where Enter takes the highlighted name — that is
 * not a send either, and it is what stops a half-typed `@alp` going to everybody.
 */
function onKey(e) {
  if (!mention) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    return void closeMention({ muted: true });
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    mention.index = (mention.index + step + mention.names.length) % mention.names.length;
    return void paintMention();
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    return void chooseMention(mention.names[mention.index]);
  }
  // Left/Right, Home, End — the caret has moved by the time the browser has handled the
  // key, so the menu is re-asked *after* it rather than before, or it stays open over a
  // token the caret has left. Up/Down already returned above; they move the menu, not the
  // caret.
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
    setTimeout(syncMention, 0);
  }
}

/**
 * Post what is in the box to everybody in the room.
 *
 * **No `paneId` in the body**, and that is the whole of who is speaking — see the header.
 * The body is `{text}` and nothing else.
 *
 * **The server's own sentence is what a refusal says**, never a paraphrase. Its refusals
 * are things only it can know — the room is archived, a limit was hit and when it lifts —
 * or they name the exact character in the body that made it unsendable. Such a character is
 * refused *with the character named*, never stripped: silently rewriting somebody's input
 * hands them a way to have it rewritten into something else. Nothing here trims, escapes or
 * normalises the value on the way out.
 *
 * **Nothing is drawn locally on success.** The endpoint appends the entry and the store
 * emits it, so the socket's `group-room-append` brings it back to this very screen —
 * appending it here as well would draw the maintainer's own message twice, and the second
 * copy would look exactly as real as the first.
 */
async function submit() {
  const el = view.el;
  if (!el || view.sending) return;
  const id = view.ctx?.roomId;
  if (!id) return;
  const text = el.ta.value;
  if (!text.trim()) return;

  view.sending = true;
  el.send.disabled = true;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(id)}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    // `data.error` is the server's own words. The fallback exists only for a response that
    // carried no body at all — a proxy, a dropped socket — and is deliberately the only
    // sentence in this function the panel wrote itself.
    if (!res.ok) throw new Error(data.error || `That message was not sent (${res.status}).`);
    view.error = null;
    // The route may have left while this was out.
    if (view.el === el && view.ctx?.roomId === id) {
      el.ta.value = '';
      setDraft(id, '');
      autoGrow();
      // The box is empty, so any `@name` menu still up is over a token that no longer
      // exists.
      closeMention();
      // A post of yours is a line you want to see land, so rejoin the bottom.
      view.follow = true;
      pin();
    }
  } catch (err) {
    // Held, not appended: this screen repaints whenever a message arrives in the room, and
    // a sentence painted onto a node a repaint has already replaced is a sentence nobody
    // sees. The box keeps its text — a refused message is one the reader may want to re-time
    // rather than retype.
    view.error = err.message;
  } finally {
    view.sending = false;
    if (view.el === el) renderComposer();
  }
}
