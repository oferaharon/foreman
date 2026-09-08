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
 *   **The two sheets** (`openCreateSheet` / `openMembersSheet`) are item 5: making a room,
 *   and editing who is in one. Bottom-anchored overlays on `document.body` in the start
 *   sheet's idiom (`openStartSheet` in `web/m/app.js`) — the shell's `.m-sheet` chrome,
 *   this file's own contents, three ways out, and each behind its own repaint signature.
 *
 * Eight rules it carries, each already paid for somewhere in this repo:
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
 * **Membership is who may type into whose terminal**, which is why the picker is an
 * allow-list on role and never "not a worker": `roomParticipants` is asked rather than
 * re-spelled, and `POST /api/rooms` refuses a worker with a 409 as the second lock. A
 * session with no live pane is out for the other half of the same reason — there is
 * nothing to type into.
 *
 * **The checkboxes are drawn here, not by the browser.** A stock checkbox is painted from
 * the *browser's* colour scheme rather than the page's `data-theme`, so an unticked box
 * under a light page in a dark browser comes back a solid dark square — which in a
 * multi-select list is exactly what "chosen" looks like. Measured on the desktop's own
 * create-room bench and recorded in CLAUDE.md. `.m-head-menu-switch` in `m.css` is the
 * phone's precedent and `.m-room-tick` follows it: a real `input[type=checkbox]` with
 * `appearance: none`, so checked, focused, Space and the accessibility tree all still come
 * for free and there is no second node that can disagree with the input's state.
 *
 * **Taking something away asks first; giving something does not.** Removing a member and
 * archiving a room both arm a question in place — `armAsk`, the merge block's own idiom
 * one screen over — and adding is one tap, which is the desktop's split and the
 * maintainer's ruling on destructive controls. The question replaces the control inside
 * its own row, so nothing above it reflows.
 *
 * It is import-safe in node: nothing here touches `document`, `window` or `localStorage`
 * at module scope, so `test/m-rooms.test.js` drives the pure half for real rather than
 * reading it out of the source.
 */

import { bandEntries, memberLabel, unseenText } from '../rooms-band.js';
import {
  MAX_MEMBERS,
  MAX_ROOM_NAME,
  canCreate,
  capRefusal,
  countLine,
  createReason,
  orderForHere,
  roomParticipants,
  rowName,
} from '../rooms-create.js';
import {
  addReason,
  addableSessions,
  addressedText,
  handedText,
  handedWaiting,
  insertMention,
  memberKey,
  memberName,
  memberRow,
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
 * `startable` is `0` and stays `0`: it is the *shell header's* `+`, and that control starts
 * a lead. `+ room` is a different verb on a different list and lives on this list's own
 * head, which is why the two never share a count.
 *
 * `state.rooms === null` is a third answer and not a missing one: rooms ride on the roster
 * frame only, so a phone that has painted from `GET /api/sessions` has sessions and no
 * rooms yet. Saying "no rooms" there would be the panel showing something wrong.
 *
 * `sessions` is a **thunk**, not a list, and that is the whole of how the create sheet stays
 * live: the sheet outlives any one paint, and a list captured when it opened would go on
 * offering a session that has since exited. It is read again on every repaint.
 */
export function roomsListView(rooms, { onOpen, onChange, sessions = () => [] } = {}) {
  if (rooms === null || rooms === undefined) {
    // No head while the first roster frame is still out: `+ room` needs a roster to pick
    // from, and a picker offering nothing is a control that cannot be answered.
    return { sig: 'rm:loading', startable: 0, nodes: () => [note('Loading rooms…')] };
  }

  const list = Array.isArray(rooms) ? rooms : [];
  if (!list.length) {
    return {
      sig: 'rm:empty',
      startable: 0,
      nodes: () => [
        listHead(sessions),
        // The sentence stays under the control rather than being replaced by it: an empty
        // list is the one place a reader learns what a room *is* before making one. It
        // deliberately does not say "make one at the Mac" — the maintainer's ruling of
        // 2026-09-07 (open question A) put creation on the phone.
        note('No rooms yet. A room is a named place a few sessions coordinate in — every post is typed into every other member’s terminal.'),
      ],
    };
  }

  return {
    sig: `rm:${roomsSig(list, { archivedOpen })}`,
    startable: 0,
    nodes: () => [
      listHead(sessions),
      ...bandEntries(list, { archivedCollapsed: !archivedOpen }).map((entry) =>
        entry.kind === 'fold'
          ? foldRow(entry, onChange)
          : roomRow(entry.room, { archived: Boolean(entry.archived), onOpen }),
      ),
    ],
  };
}

/**
 * The list's own head: one control, and nothing else on it.
 *
 * No caption beside it — the tab bar two rows up already says `Rooms`, and a second word
 * saying it again is one more thing to read for no fact. The button is not in the list's
 * signature because it never changes: `homeList` is rebuilt whole whenever that signature
 * moves, which is the same trade every other row on this screen already makes.
 */
function listHead(sessions) {
  const head = document.createElement('div');
  head.className = 'm-room-list-head';

  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'm-room-make';
  make.textContent = '+ room';
  make.title =
    'Make a room and choose who is in it. Every post is typed into every other member’s terminal.';
  make.addEventListener('click', () => openCreateSheet(sessions));

  head.append(make);
  return head;
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
  // A question armed against the room being left, and a refusal about it, are both about a
  // record this screen is done with.
  disarmAsk();
  membersError = null;

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
  // The members sheet is drawn from the same record, so a member added or removed from the
  // Mac — or from another phone — reaches an open sheet on the same beat as the head.
  renderMembersSheet();
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

  /*
   * Row 2: who is in here, whether it still takes posts, and the two controls that change
   * either — the membership `+` and `archive`.
   *
   * The nodes are built **once** and only ever patched, because both of them can be
   * carrying an armed question and this row repaints on every roster beat. A rebuild would
   * take a confirmation away from under the thumb about to answer it — the same reason the
   * desktop's member strip has a signature and the merge block has `disarmMerge`.
   *
   * `archive` is the exception and is replaced only when the *word* on it changes, which is
   * exactly when the state it asks about has moved and the question is moot anyway.
   */
  el.sub = document.createElement('div');
  el.sub.className = 'm-room-sub';

  el.subWho = document.createElement('span');
  el.subWho.className = 'm-room-sub-who';

  el.members = document.createElement('button');
  el.members.type = 'button';
  el.members.className = 'm-room-members';
  el.members.textContent = '+';
  el.members.setAttribute('aria-label', 'Who is in this room');
  el.members.title = 'Who is in this room — put another session in, or take one out.';
  el.members.addEventListener('click', openMembersSheet);

  el.sub.append(el.subWho, el.members);

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
  el.subWho.textContent = parts.join(' · ');
  // The whole row goes when there is no room, controls and all: a `+` over an id that names
  // nothing is a control whose press can only ever be a 404.
  el.sub.hidden = !room;
  el.sub.classList.toggle('is-archived', Boolean(room?.archivedAt));

  // An archived room takes no members, so the `+` is not drawn rather than drawn dead — the
  // ruling of 2026-08-26, the same one that takes the composer away one block down.
  el.members.hidden = !room || Boolean(room.archivedAt);

  if (!room) {
    el.archive?.remove();
    el.archive = null;
    return;
  }

  const want = archiveWord(room);
  if (el.archive?.dataset.word !== want) {
    // The word changed, so whatever was armed was a question about a state the room has
    // already left. Disarmed first, which also puts the old node back in the document so
    // there is something for `replaceWith` to act on.
    disarmAsk(el.sub);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm-room-arch';
    btn.dataset.word = want;
    btn.textContent = want;
    if (el.archive) el.archive.replaceWith(btn);
    else el.sub.append(btn);
    el.archive = btn;
  }

  /*
   * The handler is re-bound on every call even when the node is not replaced, and that is
   * `patchBand`'s recorded reason on the desktop rather than laziness: a handler closing
   * over a stale record is how a room renamed while the screen was open went on asking
   * *"archive “the old name”?"* — a confirmation naming something that is not there.
   */
  const btn = el.archive;
  if (room.archivedAt) {
    btn.title = 'Put this room back in the open list, so it can be posted to again.';
    // Unarchiving takes nothing away, so it asks nothing. The ruling names destructive
    // controls, not every control.
    btn.onclick = () => patchRoom({ archived: false }, btn);
  } else {
    btn.title = 'Stop anything more being posted to this room. Everything in it stays readable.';
    btn.onclick = () => armAsk(btn, archiveQuestion(room), () => patchRoom({ archived: true }, btn));
  }
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

/**
 * The sentence an empty log stands under, and there are three of them because there are
 * three ways to be empty.
 *
 * The archived one is not decoration: the ordinary sentence ends *"or anything you type
 * below"*, and an archived room has no box below — caught on the bench, drawing an offer
 * over a composer that had correctly refused to exist.
 */
export function quietText(room, { answered = true } = {}) {
  if (answered && !room) return 'There is no room with that id. It may have been opened from a stale link.';
  if (room?.archivedAt) return 'Nothing was said in here before it was archived, and nothing more can be.';
  return 'Nothing said in here yet. Anything a member posts — or anything you type below — is typed into every other member’s terminal.';
}

function quiet() {
  const box = document.createElement('div');
  box.className = 'm-room-quiet';
  box.textContent = quietText(view.room, { answered: view.answered });
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

/* =============================================================== the sheets === */

/*
 * Item 5: making a room, and changing who is in one, from the phone.
 *
 * The maintainer's ruling of 2026-09-07 (open question A) put all four of it here —
 * create, add, remove, archive — over a `decisions.md` line that had said membership stays
 * on the Mac. Both halves of that are worth knowing: the endpoints were always reachable
 * (`isLoopbackRemote` guards `/api/config` and nothing else), so what changed was a policy
 * and not a limit; and the reason the policy existed at all is the thing this code has to
 * keep honest. **Membership is who may type into whose terminal.** Every post in a room is
 * typed into every other member's pane, so a tick in the picker is a channel into somebody's
 * live session — and a phone is the press most likely to be made in a hurry, on a small
 * target, with a thumb. Hence: names that cannot be mistaken for one another, a box that
 * cannot be mistaken for ticked, 44px of row under every one of them, and a question in
 * front of anything that takes something away.
 *
 * Three shapes here rather than one, and they are deliberately not symmetrical:
 *
 *   **The overlay** (`mountSheet`) is the shell's `.m-sheet` chrome and nothing else — the
 *   backdrop, the box, the head and the ✕, with three ways out. Borrowed rather than drawn
 *   again, because a second overlay implementation on one phone is two things to keep
 *   agreeing about safe areas, scroll containment and the height of a thumb.
 *
 *   **The create sheet** is a name and a multi-select, and it **repaints**. The desktop's
 *   modal deliberately does not — it builds its list once and lets a stale row cost one
 *   404 — and this one takes the other side of that trade because a phone is a screen you
 *   put down: a session that has exited is unticked and the tally says so, rather than
 *   being pressed minutes later into a refusal. What that costs is a rebuild, and the
 *   signature is what keeps it from landing under a thumb.
 *
 *   **The members sheet** is the room's own membership, and it is the *only* place remove
 *   and add live. They are not on the header row beside the names, which at 320px is
 *   already a strip that clips: eight names and eight ✕s on one line is a control you press
 *   by accident.
 *
 * And what is **not** here, on purpose: renaming. `PATCH /api/rooms/:id` takes a `name` and
 * the desktop offers it; the brief scoped this item to creation, membership and archiving,
 * and a rename is a text field that wants a keyboard over a sheet that is mostly a list.
 * It is a gap rather than a refusal, and it is one line of body away.
 */

/* ------------------------------------------------------------- the cap --- */

/**
 * The member cap, from the server that enforces it.
 *
 * `MAX_MEMBERS` is the **fallback**, never a second authority: it is what the first frame
 * draws with and what a failed call keeps, and `server/rooms.js` refuses anything past its
 * own cap with a sentence that is shown verbatim. Two rungs, and this is the cheap one — a
 * refusal a person sees before they press is worth more than one they see after, and
 * neither is allowed to be the only one.
 */
let maxMembers = MAX_MEMBERS;

/** Asked when a sheet opens rather than at import: the list is never held behind a round
 *  trip, and a cap that comes back different repaints whatever is on screen. */
function askCap(after) {
  fetch('/api/rooms')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const cap = Number(data?.maxMembers);
      if (!cap || cap === maxMembers) return;
      maxMembers = cap;
      after?.();
    })
    .catch(() => {
      /* the fallback stands, and the server refuses past its own cap anyway */
    });
}

/* ---------------------------------------------------------- the overlay --- */

/**
 * The chrome every sheet here shares: a backdrop, a bottom-anchored box, a head and a ✕.
 *
 * `.m-sheet*` is `m.css`'s, from the start sheet — the same classes, not a copy of them.
 * The one-sheet-per-item split in this app guarantees *files*, not names, so a second
 * `.m-room-sheet-back` drawing the same thing would be two descriptions of one overlay that
 * are free to disagree about the safe-area inset. Everything *inside* the box is this
 * file's and is `.m-room-*`, which is what keeps the two from reaching into each other.
 *
 * Three ways out, in the tasks modal's own idiom: the ✕, the backdrop, and Escape. A fourth
 * closes it too and is not a way out anybody presses — a `hashchange`, which is every tab
 * switch and every navigation into a room. Without it a sheet opened on the Rooms tab would
 * still be on screen over the Leads list, repainting against a list that is no longer drawn.
 */
function mountSheet({ label, title, hint, onClose }) {
  const back = document.createElement('div');
  back.className = 'm-sheet-back';

  const box = document.createElement('div');
  box.className = 'm-sheet m-room-sheet';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', label);

  const head = document.createElement('div');
  head.className = 'm-sheet-head';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'm-sheet-x';
  x.textContent = '✕';
  x.setAttribute('aria-label', 'Close');
  head.append(h2, x);
  box.append(head);

  if (hint) {
    const p = document.createElement('p');
    p.className = 'm-sheet-hint';
    p.textContent = hint;
    box.append(p);
  }

  back.append(box);
  document.body.append(back);

  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const onHash = () => close();
  function close() {
    if (closed) return;
    closed = true;
    // Any question armed inside this box goes with it, or the timer would put a control
    // back into a document the box has already left.
    disarmAsk(box);
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', onHash);
    onClose?.();
  }

  x.addEventListener('click', close);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', onHash);

  return { back, box, close };
}

/** One sentence inside a sheet — a refusal, or a list that has nothing in it. */
function sheetNote(text) {
  const p = document.createElement('p');
  p.className = 'm-room-sheet-note';
  p.textContent = text;
  return p;
}

/** A caption over a list inside a sheet. */
function sheetCap(text) {
  const cap = document.createElement('div');
  cap.className = 'm-room-cap';
  cap.textContent = text;
  return cap;
}

/**
 * The live dot beside a name, patched rather than rebuilt.
 *
 * The colour is chosen in CSS off `data-status` rather than by a class per state, because
 * every class in this sheet has to be `.m-room*` (the one-sheet-per-item rule) and
 * `.m-room-live-needs-decision` is a name nobody would write twice the same way. `gone` is
 * this file's own word for a member `memberRow` could not resolve — it is not a roster
 * status and never arrives as one.
 */
function liveDot(status) {
  const dot = document.createElement('span');
  dot.className = 'm-room-live';
  dot.dataset.status = status || '';
  return dot;
}

/** Patch the dots on a list of rows already drawn, without touching their structure. A
 *  status moves every couple of seconds and a rebuild on that beat is how a question — or a
 *  half-made tick — gets taken away from under a thumb. */
function paintLive(box, rows) {
  if (!box) return;
  for (const row of rows) {
    const node = [...box.children].find((c) => c.dataset?.id === row?.id);
    const dot = node?.querySelector('.m-room-live');
    if (dot) dot.dataset.status = row?.status || '';
  }
}

/* -------------------------------------------------------- asking first --- */

/**
 * How long a question waits before it lets go, in ms.
 *
 * `web/m/lead.js`'s merge block, to the value, and the shape is that file's too: **one
 * question on screen at a time** (arming a second disarms the first, or a stack of asking
 * rows is a screen where a thumb cannot tell which tap is the one that acts), **a rebuild
 * disarms** (the node is about to be replaced and a question carried across a repaint is a
 * question about a row that may not be the same row), and **four seconds, then it lets go**
 * — the fallback for nobody answering.
 *
 * Not the same code as either of the other two clients, deliberately: `armConfirm` in
 * `web/app.js` and `armMerge` in `web/m/lead.js` are the same idiom in three places and
 * none of them shares a module with another. What is shared is the shape.
 */
const ASK_MS = 4000;

/** `{btn, group, timer}` — the one question on screen, or null. */
let asked = null;

/**
 * Put the control back.
 *
 * `within` scopes it, so a repaint of one list cannot answer for a question armed in
 * another — the desktop's own reason for the same argument.
 */
function disarmAsk(within = null) {
  if (!asked) return;
  const { btn, group, timer } = asked;
  if (within && !within.contains(group)) return;
  clearTimeout(timer);
  asked = null;
  // A rebuild can get here first, in which case the group is already detached and the fresh
  // row has drawn its own control; putting this one back would be a second copy.
  if (!group.isConnected) return;
  const host = group.parentElement;
  host?.classList.remove('m-room-asking');
  group.replaceWith(btn);
}

/**
 * Swap `btn` for the question, and run `fire` only if the answer is yes.
 *
 * `question` names the action **and its target** and is the entire point of the change: it
 * is what `sure?` could not say. The row it sits in gets `m-room-asking`, which folds
 * everything else in that row away for as long as the question is up — a phone row is 320px
 * and a question sharing it with a name and a dot would ellipsise to `remove alpha…`.
 *
 * `yes` inherits the control's own tooltip: that sentence already says exactly what the
 * press does, and a second wording of it is how two accounts of one fact start.
 */
function armAsk(btn, question, fire) {
  disarmAsk();

  const group = document.createElement('span');
  group.className = 'm-room-ask';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', question);

  const q = document.createElement('span');
  q.className = 'm-room-ask-q';
  q.textContent = question;
  q.title = question;

  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'm-room-ask-yes';
  yes.textContent = 'yes';
  yes.title = btn.title;

  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'm-room-ask-no';
  no.textContent = 'no';
  no.title = 'Leave it alone.';

  group.append(q, yes, no);
  no.addEventListener('click', () => disarmAsk());
  yes.addEventListener('click', () => {
    // Put the control back before firing: `patchRoom` is handed it and disables it, so it
    // has to be in the document before it runs.
    disarmAsk();
    fire();
  });

  const host = btn.parentElement;
  btn.replaceWith(group);
  host?.classList.add('m-room-asking');
  asked = { btn, group, timer: setTimeout(() => disarmAsk(), ASK_MS) };
}

/* ------------------------------------------------------ the pure half --- */

/**
 * The ids still on offer, in the order they were ticked.
 *
 * A phone is a screen you put down, so the roster under an open picker moves: a session
 * that has exited is no longer a row and must not still be counted against the cap or sent
 * in the members list. The order is the tick order and survives the pruning, because that
 * is the order `POST /api/rooms` receives them in and therefore the order the room lists
 * its members in.
 */
export function keepPicked(picked = [], rows = []) {
  const live = new Set((Array.isArray(rows) ? rows : []).map((s) => s?.id).filter(Boolean));
  return (Array.isArray(picked) ? picked : []).filter((id) => live.has(id));
}

/**
 * Everything the create picker draws, as one string.
 *
 * **Structure only, and no status.** A status moves every couple of seconds and is patched
 * onto the dot in place; in here it would rebuild the list — and therefore every checkbox
 * in it — twice a minute under a thumb that is halfway through choosing. Whether a row is
 * *ticked* is out for the same reason and a sharper one: the browser has already drawn the
 * tick by the time this would run, so a rebuild on it is a box that flickers off and back
 * on under the finger that pressed it.
 */
export function createSig(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((s) => [s?.id ?? '', rowName(s), s?.project ?? '', s?.isLead ? 1 : 0].join('|'))
    .join('~');
}

/**
 * Everything the members sheet draws, as one string.
 *
 * Both lists are in it, because adding somebody moves both at once — out of the offer and
 * into the room — and a signature carrying only one half would leave the other showing a
 * session in two places. `memberKey` is the id that travels and `memberName` is what is
 * read, so the two together are the whole of what a member row draws.
 */
export function membersSig(room, addable = []) {
  const members = Array.isArray(room?.members) ? room.members : [];
  return [
    room?.id ?? '',
    room?.archivedAt ? 1 : 0,
    members.map((m) => [memberKey(m), memberName(m)].join('|')).join('~'),
    (Array.isArray(addable) ? addable : []).map((s) => [s?.id ?? '', rowName(s)].join('|')).join('~'),
  ].join('#');
}

/** Which way the archive control goes. One function, so the word on the button, the word in
 *  the question and the word a test reads can never come apart. */
export const archiveWord = (room) => (room?.archivedAt ? 'unarchive' : 'archive');

/** The question archiving asks. It names the room, because a confirmation that does not name
 *  its target is `sure?` with more words. */
export const archiveQuestion = (room) => `archive “${room?.name || 'this room'}”?`;

/** The question removing asks. `memberName` and not `memberLabel`: this is a chip's name and
 *  a member holding no id at all still has to be called something in a question. */
export const removeQuestion = (member) => `remove ${memberName(member)}?`;

/* ----------------------------------------------------- the create sheet --- */

/**
 * The sheet, or null. Module scope for `view`'s own reason: a phone shows one at a time.
 *
 * `sessions` is the thunk `roomsListView` was handed, not a list — see there for why.
 */
let createSheet = null;

/** Open it, once. A second press while it is up is the same press. */
export function openCreateSheet(sessions = () => []) {
  if (createSheet || typeof document === 'undefined') return;

  const sheet = mountSheet({
    label: 'Make a room',
    title: 'New room',
    hint: 'A room is a named place a few sessions coordinate in. Every post is typed into every other member’s terminal.',
    onClose: () => {
      createSheet = null;
    },
  });

  const field = document.createElement('label');
  field.className = 'm-room-field';
  const fieldCap = document.createElement('span');
  fieldCap.className = 'm-room-cap';
  fieldCap.textContent = 'Name';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'm-room-name-input';
  name.placeholder = 'e.g. the checkout flow';
  // A courtesy, not the authority: `server/rooms.js` refuses an over-long name rather than
  // shortening it, and that refusal is what gets shown if one arrives by paste.
  name.maxLength = MAX_ROOM_NAME;
  name.autocapitalize = 'none';
  name.autocomplete = 'off';
  field.append(fieldCap, name);

  const pickCap = document.createElement('div');
  pickCap.className = 'm-room-cap';
  const pickWord = document.createElement('span');
  pickWord.textContent = 'Who is in it';
  const tally = document.createElement('span');
  tally.className = 'm-room-tally';
  pickCap.append(pickWord, tally);

  const list = document.createElement('div');
  list.className = 'm-room-pick-list';

  const note = document.createElement('p');
  note.className = 'm-room-sheet-note';
  note.hidden = true;

  const row = document.createElement('div');
  row.className = 'm-room-sheet-row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'm-room-btn';
  cancel.textContent = 'cancel';
  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'm-room-btn m-room-btn-go';
  make.textContent = 'Make the room';
  row.append(cancel, make);

  sheet.box.append(field, pickCap, list, note, row);

  createSheet = { ...sheet, sessions, name, list, tally, note, make, picked: [], sig: null, busy: false };

  cancel.addEventListener('click', sheet.close);
  make.addEventListener('click', submitCreate);
  name.addEventListener('input', () => {
    // Whatever the last refusal was about is answered or moot the moment the card moves.
    say('');
    syncCreate();
  });

  /*
   * The name field is deliberately **not** focused, which is where this parts company with
   * the desktop modal it is otherwise built from. Focusing it opens the software keyboard,
   * and the keyboard covers the bottom half of a bottom-anchored sheet — which here is the
   * picker and both buttons, i.e. everything the sheet is for. The field is the first thing
   * under a thumb anyway.
   */
  renderCreateSheet();
  askCap(renderCreateSheet);
}

/**
 * Repaint it.
 *
 * Called from `renderHome` **ahead of its signature guard**, which is `renderStartSheet`'s
 * own placement and for the same reason: what this sheet draws is the roster, and the home
 * list's signature is about rooms — a session appearing or exiting moves this and nothing at
 * all on the list behind it, so a repaint gated on that signature would never come.
 */
export function renderCreateSheet() {
  const s = createSheet;
  if (!s || !s.back.isConnected) return;

  /*
   * `roomParticipants` is the allow-list — an ordinary session or a lead, and nothing else —
   * asked rather than re-spelled, because a second spelling is free to disagree in the
   * direction of offering a worker. `POST /api/rooms` refuses one with a 409 as the second
   * lock, and neither is allowed to be the only one.
   *
   * `orderForHere` is asked with `null` and that is the honest answer rather than a stub: it
   * puts the folder you are looking at first, and a phone on the Rooms tab is not looking at
   * a session at all. With no "here" the roster's own order stands, which is a stable
   * partition of nothing and exactly what a list with no context should be.
   */
  const rows = orderForHere(roomParticipants(s.sessions()), null);
  s.picked = keepPicked(s.picked, rows);

  const sig = createSig(rows);
  if (sig !== s.sig) {
    s.sig = sig;
    s.list.replaceChildren(
      ...(rows.length
        ? rows.map(pickRow)
        : [
            sheetNote(
              'No session on this Mac can be put in a room. Workers are not members — a worker’s ' +
                'channel is its lead — and a session with no live pane has nothing to type into.',
            ),
          ]),
    );
  }
  paintLive(s.list, rows);
  syncCreate();
}

/** One session, and the box that says whether it is in. */
function pickRow(row) {
  const item = document.createElement('label');
  item.className = 'm-room-pick';
  // The id travels on the node the way it travels in the request — never the row's index. A
  // roster frame between the paint and the tap would otherwise choose whoever moved into
  // that slot.
  item.dataset.id = row.id;

  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.className = 'm-room-tick';
  tick.checked = createSheet?.picked.includes(row.id) || false;

  const name = document.createElement('span');
  name.className = 'm-room-pick-name';
  name.textContent = rowName(row);

  item.append(tick, liveDot(row.status), name);

  if (row.isLead) {
    const role = document.createElement('span');
    role.className = 'm-room-role';
    role.textContent = 'lead';
    item.append(role);
  }

  const where = document.createElement('span');
  where.className = 'm-room-where';
  where.textContent = row.project || '';
  item.append(where);

  tick.addEventListener('change', () => {
    const s = createSheet;
    if (!s) return;
    if (tick.checked) {
      // Refused before the server has to refuse it — and the tick goes back **off** rather
      // than being left on over a sentence saying it did not count. A control that lies
      // about its own state is worse than one that says no.
      if (s.picked.length >= maxMembers) {
        tick.checked = false;
        say(capRefusal(maxMembers), true);
        return;
      }
      // Guarded against a second push of one id. A tap cannot do it — `change` fires only
      // when the state actually moves — but a duplicate would reach `POST /api/rooms` and
      // come back as a 400 about duplicate members, which is a refusal nobody could explain
      // from what is on screen.
      if (!s.picked.includes(row.id)) s.picked = [...s.picked, row.id];
    } else {
      s.picked = s.picked.filter((id) => id !== row.id);
    }
    say('');
    syncCreate();
  });

  return item;
}

/** The sheet's one line: a refusal, or what is in flight. */
function say(text, bad = false) {
  const s = createSheet;
  if (!s) return;
  s.note.className = `m-room-sheet-note${bad ? ' m-room-bad' : ''}`;
  s.note.textContent = text || '';
  s.note.hidden = !text;
}

/** The tally and the button, from one place — so a keypress and a press can never disagree
 *  about whether the room may be made. */
function syncCreate() {
  const s = createSheet;
  if (!s) return;
  s.tally.textContent = countLine(s.picked.length, maxMembers);
  s.tally.classList.toggle('m-room-full', s.picked.length >= maxMembers);
  s.make.disabled = s.busy || !canCreate(s.name.value, s.picked.length);
}

/**
 * Make it.
 *
 * **The server's own sentence is what a refusal says**, verbatim. Every one of them names
 * the thing that is wrong — the session that has exited, the worker that cannot be a
 * member, the character in the name — and a paraphrase here would be the panel's guess at a
 * refusal it did not make. The one sentence this function wrote itself is the fallback for
 * a response that carried no body at all.
 */
async function submitCreate() {
  const s = createSheet;
  if (!s || s.busy) return;
  if (!canCreate(s.name.value, s.picked.length)) {
    say(createReason(s.name.value, s.picked.length), true);
    return;
  }

  s.busy = true;
  syncCreate();
  say('Making the room…');
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.name.value.trim(), members: [...s.picked] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The room was not made (${res.status}).`);

    s.busy = false;
    // Closed here rather than left to the `hashchange` below, which does close it a moment
    // later: assigning `location.hash` fires that as a task, and the sheet would repaint
    // once against a roster that has not heard of the new room yet.
    s.close();
    // Straight into it. The room exists on disk and in the next roster frame either way;
    // opening it is what makes the press feel finished.
    if (data.room?.id) location.hash = `#/room/${encodeURIComponent(data.room.id)}`;
  } catch (err) {
    // The sheet may have been closed while this was out.
    if (createSheet !== s) return;
    s.busy = false;
    say(err.message, true);
    syncCreate();
  }
}

/* ---------------------------------------------------- the members sheet --- */

/** The sheet, or null. */
let membersSheet = null;

/** The last refusal from a `PATCH`, held in module state and **never on the node that was
 *  pressed** — that node is replaced by the next repaint, and a sentence painted onto it is
 *  a sentence nobody sees. The desktop's `groupHeadError` made the same call. */
let membersError = null;

/** One change at a time. Two presses racing would be two `PATCH`es against one record with
 *  no way to say which answer is the later one. */
let membersBusy = false;

/** Open it, once. */
export function openMembersSheet() {
  if (membersSheet || typeof document === 'undefined') return;

  const sheet = mountSheet({
    label: 'Who is in this room',
    title: 'Members',
    hint: 'Every post here is typed into every member’s terminal — putting a session in is opening a channel into it.',
    onClose: () => {
      membersSheet = null;
    },
  });

  const err = document.createElement('p');
  err.className = 'm-room-sheet-note m-room-bad';
  err.hidden = true;

  const inCap = sheetCap('In this room');
  const inList = document.createElement('div');
  inList.className = 'm-room-mlist';

  const addCap = sheetCap('Put another one in');
  const addList = document.createElement('div');
  addList.className = 'm-room-alist';

  sheet.box.append(err, inCap, inList, addCap, addList);

  membersSheet = { ...sheet, err, inCap, inList, addCap, addList, sig: null };

  renderMembersSheet();
  askCap(renderMembersSheet);
}

/**
 * Repaint it.
 *
 * Behind a signature for the reason every list on this phone is: this runs on the roster
 * beat, and both lists in here can be carrying an armed question. A rebuild every two
 * seconds would take a confirmation away from under the thumb about to answer it. The dots
 * are patched outside the guard, because a status moves on exactly that beat and is the one
 * thing here that is *supposed* to.
 */
function renderMembersSheet() {
  const s = membersSheet;
  if (!s || !s.back.isConnected) return;

  const room = view.room;
  const rows = view.ctx?.sessions?.() || [];
  const archived = Boolean(room?.archivedAt);
  const members = Array.isArray(room?.members) ? room.members : [];
  /*
   * `addableSessions` is the allow-list minus who is already here, and already-here is
   * decided by `memberRow` rather than by comparing names: a member whose label has since
   * been taken by a different session must not hide that session from the list. `here` is
   * `null` for the create sheet's reason — a phone is not looking at a folder.
   */
  const addable = archived ? [] : addableSessions(rows, room, null);

  const sig = membersSig(room, addable);
  if (sig !== s.sig) {
    s.sig = sig;
    disarmAsk(s.box);

    s.inList.replaceChildren(
      ...(members.length
        ? members.map((m) => memberNode(m, archived))
        : [sheetNote('Nobody is in this room. Anything posted here is recorded and handed to nobody.')]),
    );

    // An archived room takes no more members, so the offer is not drawn at all rather than
    // drawn dead — the ruling of 2026-08-26, the same one that takes the composer away.
    s.addCap.hidden = archived;
    s.addList.hidden = archived;
    if (!archived) {
      const why = addReason(room, rows, maxMembers);
      s.addList.replaceChildren(...(why ? [sheetNote(why)] : addable.map(addNode)));
    }
  }

  /*
   * The dots, every beat, patched onto the rows already there. A member that resolves to no
   * roster row is drawn `gone` and says so — never dropped, because a row that vanished
   * would leave a membership the phone and the server disagree about, silently.
   */
  for (const m of members) {
    const key = memberKey(m);
    const node = [...s.inList.children].find((c) => c.dataset?.member === key);
    const dot = node?.querySelector('.m-room-live');
    if (!dot) continue;
    const row = memberRow(m, rows);
    dot.dataset.status = row ? row.status || '' : 'gone';
    node.title = row
      ? `${memberName(m)}${row.project ? ` · ${row.project}` : ''} — ${row.status}`
      : `${memberName(m)} — not in the panel right now. Anything said here is recorded as not ` +
        'reached until it is back.';
  }
  paintLive(s.addList, addable);

  s.err.textContent = membersError || '';
  s.err.hidden = !membersError;
}

/** One member, and the one thing that can be done with it. */
function memberNode(member, archived) {
  const item = document.createElement('div');
  item.className = 'm-room-mrow';
  // The **strongest** id this member holds, which is what `PATCH` is given: a tmux session
  // name survives a `/clear` and a relaunch where the other two do not, and a label collides
  // by design. `memberKey` is the one place that order lives.
  item.dataset.member = memberKey(member);

  const name = document.createElement('span');
  name.className = 'm-room-mname';
  name.textContent = memberName(member);

  item.append(liveDot(''), name);

  if (!archived) {
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'm-room-mx';
    drop.textContent = 'remove';
    drop.title = `Take ${memberName(member)} out of this room. It stops receiving what is said here.`;
    // Behind a question, because it takes something away. Nothing about it deletes anything
    // the room has already recorded: the log keeps every line this member was handed.
    drop.addEventListener('click', () =>
      armAsk(drop, removeQuestion(member), () => patchRoom({ remove: memberKey(member) }, drop)),
    );
    item.append(drop);
  }

  return item;
}

/** One session that could be put in. One tap — adding gives rather than takes, and the
 *  ruling that puts a question in front of a control names the destructive ones. */
function addNode(row) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'm-room-arow';
  item.dataset.id = row.id;

  const name = document.createElement('span');
  name.className = 'm-room-mname';
  name.textContent = rowName(row);

  item.append(liveDot(row.status), name);

  if (row.isLead) {
    const role = document.createElement('span');
    role.className = 'm-room-role';
    role.textContent = 'lead';
    item.append(role);
  }

  const where = document.createElement('span');
  where.className = 'm-room-where';
  where.textContent = row.project || '';
  item.append(where);

  item.title = `Put ${rowName(row)} in this room. It starts receiving everything said here.`;
  // The **id**, which is what `PATCH /api/rooms/:id` looks up — never the row's position.
  item.addEventListener('click', () => patchRoom({ add: row.id }, item));
  return item;
}

/**
 * Add, remove, archive, unarchive — one press, one `PATCH`.
 *
 * **Nothing is drawn from the answer.** The endpoint broadcasts a roster frame, the frame
 * carries every room, and the head and the sheet repaint off it — so what is on screen is
 * the record the store holds rather than the one this browser hoped for. The record is only
 * taken from the response so the head is not stale for the beat before that frame lands.
 *
 * **The server's own sentence is what a refusal says**, verbatim: *"alpha-main is a worker,
 * so it cannot be in a room"*, *"there is no room r9"*, *"x is not in that room"*. Each names
 * the thing that is wrong and each is a different fact from "that didn't work".
 */
async function patchRoom(body, btn) {
  const id = view.ctx?.roomId;
  if (!id || membersBusy) return;

  membersBusy = true;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That change was not made (${res.status}).`);
    membersError = null;
    if (data.room && view.ctx?.roomId === id) view.room = data.room;
  } catch (err) {
    membersError = err.message;
  } finally {
    membersBusy = false;
    // `btn` may have been replaced by a repaint while this was in flight — the rail's
    // `duplicating` guard in miniature, and re-enabling a detached node costs nothing.
    if (btn) btn.disabled = false;
    renderHead();
    // The whole log, not just the composer: archiving changes the sentence an empty room
    // stands under as well as taking the box away, and `renderLog` is what draws both.
    renderLog();
    renderMembersSheet();
  }
}
