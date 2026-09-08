/*
 * The mobile shell.
 *
 * A second, much smaller front door at `/m`. It began as **team leads only** — the lead is
 * already the thing that decides what is worth the maintainer's attention, so leads-only
 * made that architecture literal instead of building a second triage layer with less
 * information than the first. It has since opened up, on the maintainer's ruling of
 * 2026-09-07: home is now **three tabs** — Leads, Standalones, Rooms — and the hash carries
 * which one you are on.
 *
 * What did **not** open up, and is a rule rather than an omission: **workers are never
 * opened from the phone.** A worker's question is its lead's to answer. The Standalones list
 * is an allow-list (`roomParticipants` minus the leads), never "not a worker" — kinds have
 * grown once here already.
 *
 * This file owns five things and nothing else: the websocket, the roster, a hash router,
 * the tab bar, and the home list with its launch button. The conversation screen, the room
 * screen, the answer cards and the tasks tab are separate modules behind a fixed contract —
 * see `mountLead` / `mountRoom` / `buildCard` / `mountTasks`.
 *
 * **Two routes mount the conversation screen.** `#/lead/<id>` and `#/session/<id>` are the
 * same module on the same contract; what differs is the claim each hash makes about the id
 * — and each claim is re-checked against the roster on **every frame**, not once at mount.
 * That is a security control rather than tidiness; `roleRefusal` carries the measurement.
 * Two hashes rather than one with a flag, so the claim is in the URL a reload comes back to.
 * `#/room/<roomId>` is the third, and it is a screen of its own with its own module.
 *
 * The **socket** is the one thing a screen module never touches directly. `subscribe` and
 * `unsubscribe`, for a transcript and for a room alike, are sent from `enterConversation` /
 * `enterRoom`, taken back in `leaveRoute`, and re-sent in `ws.onopen` — three places that
 * have to agree, kept in one file for the reason the `onopen` block spells out at length.
 *
 * It shares the panel's websocket, its API and its five answering endpoints, and shares no
 * render code at all with `web/app.js`. That is deliberate: `app.js` is a shared shell plus
 * a per-pane factory built around split view, and a responsive squeeze of it would make
 * every future desktop change a phone change too. What it *does* share is the handful of
 * pure modules under `web/` that hold a **rule** rather than a rendering — `prefs.js`,
 * `notify.js`'s `needsKind`, `rooms-create.js`'s `roomParticipants` — because a rule spelled
 * twice is a rule that will one day be two rules.
 */

/*
 * `needsKind` is the panel's one answer to "is this session stuck on something a human has
 * to do", and it is imported rather than re-spelled. The phone used to carry a second copy
 * of that rule, which was equivalent for a lead and **did not ask the trust gate first** —
 * so a session parked on the folder-trust screen read as an ordinary permission prompt here
 * and as the gate on the desktop. One function, and the distinction comes free. It is pure (no
 * DOM, no storage) and imports only `trust-gate.js`; none of the notification machinery
 * beside it reaches this view, and none of it can.
 */
import { forgeMarkupFor } from '../forge-mark.js';
import { needsKind } from '../notify.js';
import { ghostSend, PHONE_TABS, phoneTab } from '../prefs.js';
import { formatReset, formatResetClock24, staleness, windowsOf } from '../quota.js';
/* The one spelling of who may be shown as an ordinary session, shared with the desktop's
   room picker — and the one spelling of what a row is called, which is the name the
   Standalones list draws, the name its screen's header carries, and the name every room
   chip and delivery header already gives that same session. See `standaloneRows`. */
import { roomParticipants, rowName } from '../rooms-create.js';
/* The one order a lead's workers are ever drawn in, shared with the desktop rail. Imported
   rather than re-spelled for the reason its own header gives at length: every other order
   in this panel is recency, and under a lead recency is wrong — a team is read as a block
   and a worker is found where it was last time. See `workerLines`. */
import { orderWorkers } from '../worker-order.js';
import { mountLead, updateLead } from './lead.js';
/* The Rooms tab's list and the room screen. Its own module with its own state — a phone
   shows one thing at a time, and that stays true only if the second screen is a second
   module rather than a `kind` field bolted onto the first one's `view`. */
import { mountRoom, renderCreateSheet, roomsListView, updateRoom } from './rooms.js';

/* ------------------------------------------------------------- state --- */

/*
 * One slot. The socket's frames all carry a `slot` because the desktop can hold two panes
 * open at once; a phone shows one thing at a time, so everything here is slot `a` — the
 * value the server defaults to, and the way the panel behaved before there were two.
 */
const SLOT = 'a';

const state = {
  /** `[{repo, name}]` from `GET /api/teams`, or null before the first answer. */
  teams: null,
  /** The roster, or null until the first frame — an empty array is a real answer and
      would otherwise be indistinguishable from "we have not asked yet". */
  sessions: null,
  /**
   * The account's two rate-limit gauges, or null until a record exists — a sibling of
   * `sessions` on the roster frame, never a field on a session row, because it is one
   * account-wide number rather than anything a row owns.
   *
   * Null is the ordinary state and not an error: the feed only ticks when a session's
   * status line redraws, so a phone opened before anything on the Mac has spoken has no
   * record at all. Nothing is drawn then — not a zero, not a grey placeholder.
   */
  rateLimits: null,
  /**
   * Every room, open and archived, as `list()` hands them over — or null until the first
   * frame that carries the key.
   *
   * Null is not "there are no rooms". Most people are in none, so an empty array is the
   * ordinary answer, and a client that could not tell the two apart would draw "no rooms"
   * over a socket that has not spoken yet. `handle` therefore tests `'rooms' in msg` and
   * never the value's truth — the server's own comment on `rosterFrame` says why, and
   * `rateLimits` two fields up learned it the expensive way.
   *
   * It arrives on the socket only: `GET /api/sessions`, which paints the first frame before
   * the socket lands, carries sessions and groups and not this.
   */
  rooms: null,
  connected: false,
};

/*
 * In-flight launches and their errors live in module scope, not on the button. The home
 * list is rebuilt from scratch on every roster frame, so a `disabled` set on a node is
 * wiped long before the launch returns — the desktop's duplicate button learned this the
 * hard way. Three fast taps must start one lead, not three.
 */
const launching = new Set();
const launchErrors = new Map();

/* -------------------------------------------------------------- bus --- */

/** type -> Set(handler). Screens subscribe through their ctx and never touch this. */
const bus = new Map();

function busOn(type, fn) {
  if (!bus.has(type)) bus.set(type, new Set());
  bus.get(type).add(fn);
}

function busOff(type, fn) {
  bus.get(type)?.delete(fn);
}

function emit(type, msg) {
  for (const fn of [...(bus.get(type) || [])]) {
    try {
      fn(msg);
    } catch (err) {
      console.error('[m]', type, err);
    }
  }
}

/* --------------------------------------------------------- websocket --- */

let ws = null;
let retry = 0;

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
    state.connected = true;
    paintConn();

    /*
     * Re-subscribe whatever is open. A subscription is *server* state — a tailer holding a
     * byte offset in a transcript — so a dropped socket or a panel restart takes it with
     * it, while the roster keeps arriving because that is broadcast to every client. The
     * result is a screen that looks perfectly alive above a transcript that silently
     * stopped minutes ago, and nothing on it says so. This is the single most expensive
     * bug in this project's history; it has been re-introduced once already, by a refactor
     * that re-subscribed a variable that no longer existed.
     */
    if (isConversation(route.kind) && route.sessionId) {
      send({ type: 'subscribe', sessionId: route.sessionId, slot: SLOT });
    }
    /*
     * …and the open room, for exactly the same reason. `groupRoomSubs` is one per socket,
     * so re-subscribing is safe (a second supersedes the first rather than stacking a
     * listener) and *not* re-subscribing is the silent failure: a room screen that looks
     * perfectly alive over a log that stopped when the socket dropped. The server's own
     * block says so too — "`ws.onopen` must re-subscribe this".
     */
    if (route.kind === 'room' && route.roomId) {
      send({ type: 'subscribe-group-room', roomId: route.roomId, slot: SLOT });
    }

    // The team list changes when a lead is launched in a folder that never had one, which
    // can happen at the Mac while the phone is asleep. Cheap enough to re-ask on every
    // open; it is four rows of two strings.
    loadTeams();
  };

  ws.onclose = () => {
    state.connected = false;
    paintConn();
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 400 * 2 ** retry);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  if (msg.type === 'sessions') {
    state.sessions = msg.sessions || [];
    // `?? null` rather than `||`: the server sends the key on every roster frame and its
    // absence means an older panel, which reads the same as "no record yet" here.
    state.rateLimits = msg.rateLimits ?? null;
    // `'rooms' in msg`, never `msg.rooms &&`: an empty array is a real answer and the most
    // common one. See the field's own note in `state`.
    if ('rooms' in msg) state.rooms = msg.rooms || [];
    onRoster();
  } else if (msg.type === 'rebound') {
    onRebound(msg);
  }
  // Everything reaches the open screen either way — the roster included, since item 6's
  // header reads model and `ctx:` off it.
  emit(msg.type, msg);
}

/* ------------------------------------------------------------ router --- */

/*
 * Four kinds of screen — home, `#/lead/<sessionId>`, `#/session/<sessionId>` and
 * `#/room/<roomId>` — and home
 * carries which of its three tabs is on: `#/leads`, `#/standalones`, `#/rooms`. The hash is
 * the whole route, so the phone's back gesture works without any history bookkeeping of
 * ours, and a reload comes back to the tab it was on rather than to the top of the pile.
 *
 * The two conversation kinds are one screen and two claims. Everything the shell does for
 * them — subscribe, rebound, the gone timer, the teardown — is identical and asks
 * `isConversation`; the one thing that is not is `roleRefusal`, which is why the kind is in
 * the hash and not a flag beside a shared word. A room is not one of them: it is a screen
 * of its own, with its own module and its own subscription, exactly as Trap 13 asked.
 *
 * `tab` is **sticky across a conversation or a room screen**. A hash naming a session or a
 * room says nothing about which list you came from, so `parseHash` answers `null` there and
 * `navigate` leaves the field alone; the back control then returns you to the tab you left,
 * not to Leads. It is also what `homeHash` reads.
 */
const route = { kind: 'home', tab: 'leads', sessionId: null, roomId: null };

/** The three tabs, in the order they are drawn. The keys are `web/prefs.js`'s — that file
 *  has to check a stored value against them, so it owns the vocabulary and this owns only
 *  the words on screen. */
const TAB_LABELS = { leads: 'Leads', standalones: 'Standalones', rooms: 'Rooms' };
const TABS = PHONE_TABS.map((key) => ({ key, label: TAB_LABELS[key] }));

/** Where "back" goes from a conversation screen: the tab you were on, never a bare `#/`. */
function homeHash() {
  return `#/${route.tab}`;
}

/** The two route kinds that mount a conversation. Asked rather than spelled out at each
 *  site, because every one of those sites has to grow the day another kind lands — and one
 *  already has: a room is a different screen and is deliberately not in here. */
function isConversation(kind) {
  return kind === 'lead' || kind === 'session';
}

/** The mounted screen's teardown, or null on the home screen. One of these two at most:
 *  a phone shows one thing at a time and the router is what enforces it. */
let leadCtx = null;
let roomCtx = null;
let leadEverSeen = false;
let goneTimer = null;

/**
 * The hash, read.
 *
 * `tab: null` on a lead route means *unchanged*, not *leads* — see the note over `route`.
 * On a home route an unrecognised or absent segment is `leads`, which is what makes a bare
 * `#/`, a typo and a link from an older build all land somewhere that exists. The remembered
 * tab is deliberately **not** consulted here: it is applied once at boot, and only when
 * there is no hash at all (see the boot block), so a route somebody actually asked for is
 * never overridden by one they asked for yesterday.
 */
function parseHash() {
  const hash = location.hash || '#/';
  // The kind is the first segment, so the hash carries the claim the route re-checks rather
  // than a flag beside one shared word.
  const conv = /^#\/(lead|session)\/(.+)$/.exec(hash);
  if (conv) {
    return { kind: conv[1], sessionId: decodeURIComponent(conv[2]), roomId: null, tab: null };
  }
  // A room id is opaque and is minted by the store, so it is matched the same greedy way a
  // session id is and decoded rather than validated here — an id that names nothing is
  // answered by the server's own `group-room` frame with `room: null`, which the screen
  // draws as "there is no room with that id" instead of an empty log.
  const room = /^#\/room\/(.+)$/.exec(hash);
  if (room) return { kind: 'room', sessionId: null, roomId: decodeURIComponent(room[1]), tab: null };
  const seg = /^#\/([a-z]+)\/?$/.exec(hash);
  const tab = seg && TAB_LABELS[seg[1]] ? seg[1] : 'leads';
  return { kind: 'home', sessionId: null, roomId: null, tab };
}

function navigate() {
  const next = parseHash();
  if (
    next.kind === route.kind &&
    next.sessionId === route.sessionId &&
    next.roomId === route.roomId &&
    (next.tab === null || next.tab === route.tab)
  ) {
    return;
  }

  leaveRoute();
  route.kind = next.kind;
  route.sessionId = next.sessionId;
  route.roomId = next.roomId;
  if (next.tab) {
    route.tab = next.tab;
    // Remembered here rather than in the tab's click handler, so a tab reached by a typed
    // hash, a bookmark or the back gesture is remembered exactly as one reached by a tap.
    phoneTab.set(next.tab);
  }

  if (isConversation(route.kind)) enterConversation();
  else if (route.kind === 'room') enterRoom();
  else enterHome();
}

function leaveRoute() {
  // Part of the shell header, which every route below `home` hides outright — but hiding the
  // header does not reset a popover left open inside it, and a route reached while the menu
  // was up (Escape never pressed, no outside tap) would otherwise come back to `home` still
  // open. Unconditional and cheap: `closeHeadMenu` is a no-op when there is nothing open.
  closeHeadMenu();
  if (isConversation(route.kind)) {
    send({ type: 'unsubscribe', slot: SLOT });
    leadCtx?._dispose();
    leadCtx = null;
    leadEverSeen = false;
    clearTimeout(goneTimer);
    goneTimer = null;
  }
  if (route.kind === 'room') {
    /*
     * The other half of the `ws.onopen` block above, and it is the same rule from the other
     * end: a group-room subscription is *server* state, one per socket, so a screen that
     * left without giving it back leaves a listener on the store sending frames at a slot
     * this client no longer draws. `unsubscribe-group-room` takes no room id — the server
     * holds exactly one per socket and drops whichever it has.
     */
    send({ type: 'unsubscribe-group-room', slot: SLOT });
    roomCtx?._dispose();
    roomCtx = null;
  }
  if (route.kind === 'home') {
    clearInterval(homeTick);
    homeTick = null;
    // The sheet hangs off `document.body`, not off the screen, so the `replaceChildren`
    // below does not reach it — and a launch that navigates straight into its new lead
    // would otherwise leave it sitting over the transcript.
    closeStartSheet();
  }
  el.screen.replaceChildren();
}

/* --------------------------------------------------------------- dom --- */

const app = document.getElementById('app');

const el = {
  head: document.createElement('header'),
  /*
   * The header's first row. It exists so the tab bar can be the second one *inside* the same
   * `<header>`: `enterConversation` hides the shell header with `el.head.hidden` and the
   * conversation screen draws its own, so a bar appended as a sibling of the header would
   * sit over it — a bug already caught on this screen once and recorded in `m.css`.
   *
   * `web/m/lead.js`'s `watchConnection` reaches across the module boundary with the literal
   * selector `.m-app > .m-head .m-conn` to mirror the socket dot, deliberately, so there is
   * never a second socket disagreeing with the first. That is a **descendant** combinator on
   * the right, so wrapping the row's children like this keeps it matching. Break it and the
   * session screen's dot reads `?` for ever, quietly. If `.m-head` ever stops being a direct
   * child of `.m-app`, or `.m-conn` moves out of it, both files change in one commit.
   */
  headRow: document.createElement('div'),
  tabs: document.createElement('nav'),
  brand: document.createElement('div'),
  logo: document.createElement('img'),
  title: document.createElement('div'),
  quota: document.createElement('button'),
  conn: document.createElement('span'),
  start: document.createElement('button'),
  menuBtn: document.createElement('button'),
  menu: document.createElement('div'),
  menuToggleBox: document.createElement('input'),
  screen: document.createElement('div'),
};

el.head.className = 'm-head';
el.headRow.className = 'm-head-row';
// The mark and the wordmark, grouped so the gap between them can be tighter than the row's
// own — `.m-head-row`'s `gap` is shared by every child (quota, conn, `+`, `⋯`), and pairing
// a mark with its word wants less air than that. `el.brand` is the `flex: 1` node now, in
// `.m-title`'s old place in the row; `.m-title` keeps its own `flex: 1; min-width: 0` inside
// it so it still ellipsises rather than the mark.
el.brand.className = 'm-head-brand';
// Not a second accessible name for the app — the word beside it is what a screen reader
// announces.
el.logo.className = 'm-head-logo';
el.logo.src = '/icons/mark.svg';
el.logo.alt = '';
el.logo.setAttribute('aria-hidden', 'true');
el.title.className = 'm-title';
// The app's name, not the tab's — the tabs below say which list you are on. It was `Leads`
// until this view stopped being about leads (the maintainer's ruling of 2026-09-07, which
// also renamed the installed app); a title that named one of three tabs would now be wrong
// two thirds of the time.
el.title.textContent = 'Foreman';
/*
 * The account's two rate-limit gauges live in the shell header, which means **home screen
 * only** — and that is a placement decision, not an accident of where the node was
 * appended. The lead screen hides this header outright (`.m-app.no-head`, `.m-head[hidden]`)
 * and draws its own, whose height is budgeted to the pixel by its own comment; putting a
 * second pair of bars there would spend that budget on a number that is the same on every
 * screen. A phone that wants the reading goes back one tap.
 *
 * It is a `<button>` because a `title` is not reachable by a thumb. Tapping opens the reset
 * times and the "as of" age underneath the bars; the `title` carries the same sentence for
 * a pointer, so neither kind of reader is left with two bare percentages.
 */
el.quota.className = 'm-quota';
el.quota.type = 'button';
el.quota.hidden = true;
el.quota.addEventListener('click', () => {
  quotaOpen = !quotaOpen;
  // Through `renderHome` rather than straight to `renderQuota`: the open state is part of
  // the home signature, so repainting past it would leave the guard holding a signature
  // that no longer describes the screen, and the next tick would repaint for nothing.
  renderHome();
});

el.conn.className = 'm-conn';
el.conn.textContent = '●';

/*
 * The `+`, and it opens a list rather than a form: the panel cannot create a team from a
 * phone — a team directory is written the first time a lead is launched in a folder, which
 * is a thing you do once at the Mac — so this is *start something*, never *add a team*.
 * The sheet it opens is exactly the teams the home list is hiding, and its heading and hint
 * say so in words for the same reason.
 *
 * Drawn only when there is at least one of them (`renderStartButton`), the way every count
 * on this screen drops entirely at zero. It sits between the connection dot and `⋯` so the
 * menu stays in the corner a thumb has already learned; the shell header hides itself on
 * the lead screen, so this inherits the right visibility with no branch of its own.
 */
el.start.className = 'm-icon-btn m-start-btn';
el.start.type = 'button';
el.start.textContent = '+';
el.start.hidden = true;
el.start.setAttribute('aria-label', 'Start a lead');
el.start.title = 'Start a lead in a team that has none running';
el.start.addEventListener('click', openStartSheet);

/*
 * The `⋯`: one button in `⟳`'s old corner, opening a small popover anchored under it that
 * holds two things that used to live apart — the refresh action and the one preference this
 * device has, which used to sit as its own section under the home list (see the git history
 * for `buildPrefs`, retired the same day this landed). A phone's header has room for exactly
 * one more icon before `+` and the socket dot start fighting it for space, so this is one
 * button standing in for two controls rather than a second one crowding the row.
 *
 * The popover is built once, here, and only ever shown or hidden — never rebuilt — for the
 * same reason the three tabs are permanent nodes: a control replaced under a thumb on its
 * way down is a control that eats the tap. `openHeadMenu`/`closeHeadMenu` own the visibility
 * and the outside-tap/Escape/route-change wiring; nothing here repaints on the roster beat.
 */
el.menuBtn.className = 'm-icon-btn';
el.menuBtn.type = 'button';
el.menuBtn.textContent = '⋯';
el.menuBtn.setAttribute('aria-label', 'Menu');
el.menuBtn.setAttribute('aria-haspopup', 'true');
el.menuBtn.setAttribute('aria-expanded', 'false');
el.menuBtn.addEventListener('click', toggleHeadMenu);

el.menu.className = 'm-head-menu';
el.menu.hidden = true;

const menuRefreshRow = document.createElement('button');
menuRefreshRow.type = 'button';
menuRefreshRow.className = 'm-head-menu-row';
menuRefreshRow.textContent = 'Refresh';
// Closes the instant it is tapped, before `loadTeams` has even resolved — `refresh()` puts
// the busy mark on `el.menuBtn` itself, which is the one part of this still on screen once
// the popover is gone.
menuRefreshRow.addEventListener('click', () => {
  closeHeadMenu();
  refresh();
});

// The toggle row: same words, same stored flag, same "applies the moment it's tapped" as the
// section this replaces. A `<label>`, not a row plus a separate click handler, so the tap
// target is the whole sentence and Space/click both reach the input for free — and so tapping
// it never has to be told "don't close the menu": nothing here calls `closeHeadMenu` at all.
const menuToggleRow = document.createElement('label');
menuToggleRow.className = 'm-head-menu-row m-head-menu-toggle';

el.menuToggleBox.type = 'checkbox';
el.menuToggleBox.className = 'm-head-menu-switch';
el.menuToggleBox.checked = ghostSend.on;
el.menuToggleBox.addEventListener('change', () => {
  ghostSend.set(el.menuToggleBox.checked);
});

const menuToggleLabel = document.createElement('span');
menuToggleLabel.className = 'm-head-menu-title';
menuToggleLabel.textContent = 'Send suggestions on one tap';

menuToggleRow.append(el.menuToggleBox, menuToggleLabel);
el.menu.append(menuRefreshRow, menuToggleRow);

// The one positioned ancestor the popover needs. `el.menuBtn` itself cannot be it: a `<div>`
// inside a `<button>` still bubbles its clicks to that button, which would fire
// `toggleHeadMenu` a second time on every tap inside the popover, including the checkbox.
const menuWrap = document.createElement('div');
menuWrap.className = 'm-head-menu-wrap';
menuWrap.append(el.menuBtn, el.menu);

el.brand.append(el.logo, el.title);
el.headRow.append(el.brand, el.quota, el.conn, el.start, menuWrap);

let headMenuOpen = false;

function toggleHeadMenu() {
  if (headMenuOpen) closeHeadMenu();
  else openHeadMenu();
}

function openHeadMenu() {
  if (headMenuOpen) return;
  headMenuOpen = true;
  el.menu.hidden = false;
  el.menuBtn.setAttribute('aria-expanded', 'true');
  // Re-read rather than trusted stale: the desktop's settings modal writes the same key, and
  // `/` and `/m/` are one origin — a tab that changed it since this popover last opened
  // should not show the old answer.
  el.menuToggleBox.checked = ghostSend.on;
  // Capturing, the same as the start sheet's Escape handler, and for the same reason: a tap
  // that lands on something inside the popover must never reach this listener as "outside".
  document.addEventListener('pointerdown', onHeadMenuOutside, true);
  document.addEventListener('keydown', onHeadMenuKey, true);
}

function closeHeadMenu() {
  if (!headMenuOpen) return;
  headMenuOpen = false;
  el.menu.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onHeadMenuOutside, true);
  document.removeEventListener('keydown', onHeadMenuKey, true);
}

function onHeadMenuOutside(e) {
  if (el.menu.contains(e.target) || el.menuBtn.contains(e.target)) return;
  closeHeadMenu();
}

function onHeadMenuKey(e) {
  if (e.key === 'Escape') closeHeadMenu();
}

/* ------------------------------------------------------------- tabs --- */

/*
 * The three tabs, built once and then only ever repainted — never rebuilt.
 *
 * The rest of this screen is rebuilt from scratch on every roster frame behind a signature
 * guard, which is right for a list whose rows come and go. These three never come or go, and
 * a control that was replaced under a thumb on its way down is a control that eats the tap.
 * So the nodes are permanent and `renderTabs` toggles two classes on each.
 */
const tabNodes = new Map();

for (const { key, label } of TABS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'm-nav-tab';
  btn.dataset.tab = key;
  btn.setAttribute('role', 'tab');

  const text = document.createElement('span');
  text.className = 'm-nav-label';
  text.textContent = label;

  /*
   * The mark, and it is deliberately the gutter's own `.m-dot-wait` rather than a second
   * vocabulary: on a team card that dot means *something in here wants you*, and on the tab
   * it means the same thing about the whole list behind it. A tab that invented its own
   * shape would be a second thing to learn for one fact.
   *
   * Always in the DOM, painted only when lit — the same rule as the card's gutter, and for
   * the same reason: a mark that appears and disappears moves the label beside it, and a
   * label that shifts when a session blocks is a label you have to re-find.
   */
  const dot = document.createElement('span');
  dot.className = 'm-dot m-dot-wait m-nav-dot';

  btn.append(text, dot);
  btn.addEventListener('click', () => {
    location.hash = `#/${key}`;
  });

  tabNodes.set(key, { btn, dot });
  el.tabs.appendChild(btn);
}

el.tabs.className = 'm-nav';
el.tabs.setAttribute('role', 'tablist');

el.head.append(el.headRow, el.tabs);

el.screen.className = 'm-screen';

app.append(el.head, el.screen);

/**
 * Which tab is on, and which of the three is holding something.
 *
 * Called from inside `renderHome`'s signature guard, so it runs exactly when something a
 * reader could see has moved — the marks and the active tab are both in that signature.
 */
function renderTabs(marks) {
  for (const { key, label } of TABS) {
    const { btn, dot } = tabNodes.get(key);
    const on = key === route.tab;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    dot.classList.toggle('is-on', Boolean(marks[key]));
    btn.title = marks[key] ? `${label} — something here is waiting on you` : label;
  }
}

function paintConn() {
  el.conn.classList.toggle('is-down', !state.connected);
  el.conn.title = state.connected ? 'connected' : 'reconnecting…';
}

/* --------------------------------------------------------------- home --- */

let homeList = null;
let homeSignature = null;
let homeTick = null;

/*
 * How often the home screen repaints itself with nothing incoming.
 *
 * The roster is only broadcast when something *changed* (`sessions.js`'s `changed()` diff),
 * and a lead sitting genuinely idle is by definition changing nothing — so without this the
 * age is frozen at whatever it was when the last frame happened to arrive, and a card reads
 * `2m` an hour later. That is worse than showing no age at all: a stale number looks live.
 *
 * 30s, which is half the finest bucket that can move. `relativeTime`'s smallest step is a
 * minute (`now` → `1m` → `2m`), so the age on screen is never more than half a bucket
 * behind. Ticking faster buys nothing — the string cannot change more often than once a
 * minute. Ticking at 60s would let a boundary sit visibly wrong for most of a minute, on a
 * screen you pick up and glance at.
 *
 * `setInterval` rather than `requestAnimationFrame`, and not only because this is not an
 * animation: an automated Chrome window reports `document.visibilityState: 'hidden'` and
 * Chrome suspends rAF there, so a bench would show a tick that never fires and a bug that
 * is not in this file. `setInterval` survives it — measured rather than assumed, with a
 * control interval of this same period inside the bench page firing at 30.025s and 60.026s
 * while `visibilityState` read `hidden` throughout.
 *
 * And what the signature guard buys is visible in the same run: over 66s the tick fired
 * twice and the list repainted **once**, at the moment an age string actually changed
 * (`49m`→`50m`, `3m`→`4m`) — with one websocket frame received in the whole run, the
 * initial roster. A tick that repainted unconditionally would have rebuilt the list under
 * a thumb for nothing, twice a minute, for ever.
 */
const HOME_TICK_MS = 30_000;

function enterHome() {
  el.head.hidden = false;
  app.classList.remove('no-head');

  const scroll = document.createElement('div');
  scroll.className = 'm-scroll';
  homeList = document.createElement('div');
  homeList.className = 'm-teams';
  scroll.appendChild(homeList);
  el.screen.appendChild(scroll);

  // Mounted first, painted second. Anything that measures itself before its container is
  // in the document silently draws nothing — a busy screen then self-heals on the next
  // frame while a quiet one stays blank for hours, which is exactly how the desktop's room
  // panel shipped once.
  homeSignature = null;
  renderHome();

  // Torn down in `leaveRoute`, not left running behind the lead screen. `renderHome` would
  // bail on `homeList.isConnected` anyway once the screen is swapped, so a leak here is
  // silent rather than visible — which is exactly why it gets an explicit stop.
  clearInterval(homeTick);
  homeTick = setInterval(renderHome, HOME_TICK_MS);
}

/**
 * The lead for a team, or null.
 *
 * Matched on `paneCwd` — the pane's *launch* folder — because that is the identical value
 * `SessionRegistry#team` passes to `isLeadName` when it decides `isLead` in the first
 * place. `cwd` is the transcript's and moves when a session changes directory
 * mid-conversation, which is how the desktop once lost a session's binding entirely.
 */
function leadFor(repo) {
  return (state.sessions || []).find((s) => s.isLead && s.paneCwd === repo) || null;
}

/**
 * Is there a box on this session's screen right now?
 *
 * The **working** dot's negative half, and nothing else reads it. It is not `needsKind` and
 * must not become it: `needsKind` carries the *attention* policy, including the rail's
 * worker quieting — a worker holding a prompt its lead is meant to answer is deliberately
 * not "needs you" — and whether a session is running is not an attention question. Applying
 * the quieting here would let a blocked worker read as `working` on the card's second dot.
 *
 * `needs-decision` is not tested because it cannot be: this is only ever asked of a row that
 * has already said `status === 'working'`, and the three box fields are what the hook can be
 * a poll behind. That lag is the whole reason this exists — `sessions.js` already lets a box
 * outrank the hook, but a box that has just appeared is on screen before the roster says so.
 */
function hasBox(s) {
  return Boolean(s.prompt) || Boolean(s.plan) || Boolean(s.question);
}

/**
 * Workers actually running for this team.
 *
 * Live panes, not task records. The store is deliberately never pruned when a pane dies,
 * so a crashed or hand-`/exit`ed worker leaves `working` on disk for ever and the desktop's
 * `N tasks` goes on advertising a worker that does not exist. The roster holds only
 * sessions with a live pane, so this number cannot be inflated that way.
 *
 * `review` is excluded so the row's two numbers are disjoint: a worker in `review` has
 * stopped and is waiting on the maintainer, and `N in review` is already its name. A reader
 * adds two numbers on one line, so they must never describe the same worker twice.
 *
 * And it is counted off `workerOf` and `team.state`, which `sessions.js` writes out of one
 * `#team()` call — the existing guard against a row being told it is a worker in one field
 * and something else in another. Counting off the task store, off `ACTIVE`, or off a fresh
 * `/api/team/tasks` fetch re-introduces exactly the divergence that guard exists to stop.
 *
 * Consequence, accepted rather than a bug: the phone and the Mac deliberately show
 * different numbers for the same team. The desktop can afford the looser count because the
 * worker rows are nested three lines under it; the phone has nothing else.
 */
function teamWorkers(repo) {
  return allTeamWorkers(repo).filter((s) => s.team?.state !== 'review');
}

/**
 * Every worker of this team with a live pane, `review` included.
 *
 * The one spelling of *whose worker is this*, and `teamWorkers` above is now this filtered
 * — so the `review` exclusion the counts need is visibly a narrowing of this rather than a
 * second, independently-written filter that could one day disagree about the join.
 *
 * Its own caller is the list of worker lines under a lead card, which shows the review
 * workers the counts leave out. That is the maintainer's ruling of 2026-09-07, taken with
 * the alternative in front of them: the list is allowed to read one longer than
 * `· N workers` and the extra line says `review` on itself, because the other way round —
 * a list matching the count exactly — hides the one worker that has finished and is waiting
 * on them.
 */
function allTeamWorkers(repo) {
  return (state.sessions || []).filter((s) => s.workerOf === repo);
}

function liveWorkers(repo) {
  return teamWorkers(repo).length;
}

/**
 * What a worker line calls the worker.
 *
 * The branch first, and **not** the roster's `label`, which is the tempting field and is
 * the wrong one here: `sessions.js` slices only the session prefix, so a worker's label
 * arrives as `<folder>-<task>` — the folder included — and every line under a card already
 * titled with that team would repeat it and then ellipsise away the half that identifies
 * the worker. The branch is `agent/<task>`, it is what you would type into git, and it is
 * the same chain the desktop rail's own worker line reads (`team.branch || team.task`).
 * The label is kept as the last resort rather than dropped, because a row that arrived
 * without a task join should still be named something rather than blank.
 */
function workerName(s) {
  return s.team?.branch || s.team?.task || s.label || 'worker';
}

/**
 * One word for what a worker is doing, and the only thing that decides its dot.
 *
 * `review` outranks everything because it is the fact this list exists to explain — a
 * worker that has reported is waiting on the maintainer, it is deliberately not in
 * `· N workers`, and without the word the list simply reads one line longer than the count
 * for no visible reason.
 *
 * Under it, `hasBox` and `isWorking` — the card's own two, reused rather than re-derived,
 * so a worker's line and the team's working dot can never disagree about the same session.
 * Note this asks `hasBox` and **not** `needsKind`: `needsKind` carries the rail's worker
 * quieting, which says a worker's prompt is its lead's business, and that is an attention
 * policy rather than an answer to *what is this session doing*. The line states the fact;
 * the quieting still holds everywhere it is about attention, including this tab's mark.
 *
 * Anything else falls through to the roster's own status word — `idle`, and the box shapes
 * the panel will not answer — exactly as `stateWord` does for a lead. Showing the raw word
 * beats inventing a friendlier one that could be wrong.
 */
function workerWord(s) {
  if (s.team?.state === 'review') return 'review';
  if (hasBox(s)) return 'waiting';
  if (isWorking(s)) return 'working';
  return s.status || 'unknown';
}

/**
 * The lines under a lead card: `{name, word}` per live worker, in dispatch order.
 *
 * Two rendered strings and nothing else, because this rides in the home signature and the
 * file's rule is that a signature carries what is on screen — never a raw stamp, which
 * would differ on almost every roster frame and retire the guard. The dot is derived from
 * `word` at paint time rather than being a third field, so there is no way for a line's
 * colour and its word to describe different things.
 */
function workerLines(repo) {
  return orderWorkers(allTeamWorkers(repo)).map((s) => ({
    name: workerName(s),
    word: workerWord(s),
  }));
}

/**
 * Is this session *running*, as opposed to waiting on somebody?
 *
 * The second dot's whole rule, and it is deliberately the negative of "a box is up" rather
 * than a list of the states that count. `status` is already the panel's own answer —
 * `sessions.js` lets a prompt, a plan or a picker outrank the hook precisely so that a
 * session holding a box never reads `working` — but the hook can still be a poll behind a
 * box that has just appeared, and `hasBox` reads the box itself. Waiting is not working; the
 * top dot has it, and a row must never claim both about the same fact.
 */
function isWorking(s) {
  return Boolean(s) && s.status === 'working' && !hasBox(s);
}

/**
 * Workers of this team that are actually running right now.
 *
 * Built on `teamWorkers` rather than on its own filter so the `review` exclusion above
 * cannot drift: a worker in `review` has stopped and is waiting on the maintainer, which is
 * the top dot's business and not this one's — and the reason it is counted off the roster
 * rather than the task store is written out there in full.
 */
function workingWorkers(repo) {
  return teamWorkers(repo).filter(isWorking).length;
}

/**
 * How long ago, coarsely — `now`, `12m`, `3h`, `2d`.
 *
 * A local copy of `relativeTime` in `web/app.js` (~line 212), which is what the desktop
 * rail's duration column already reads. It mirrors that function deliberately and must go
 * on mirroring it: the same lead is on both screens, and one fact bucketed by two
 * vocabularies reads `59m` on the Mac and `1h` on the phone for the same instant. There is
 * no module boundary between `web/app.js` and this file to hang a shared helper on — they
 * do not import from each other — so this is a copy with a pointer, not an abstraction.
 * Change one, change the other.
 */
function relativeTime(ms) {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** One row's worth of facts, so a repaint can be skipped when nothing on screen moved. */
function homeRow(team) {
  const lead = leadFor(team.repo);
  if (!lead) {
    return {
      team,
      lead: null,
      dot: false,
      working: false,
      unread: 0,
      workers: 0,
      workerList: [],
      review: 0,
      blocked: false,
      need: null,
      ctx: null,
      age: '',
    };
  }
  const review = lead.team?.review || 0;
  /*
   * `needsKind`, imported, and never `needsYou`. That field folds in `unread > 0`, which is
   * the *panel viewer's* read state — a server-side watermark cleared by `markRead` the
   * moment anyone scrolls a transcript to the bottom on any device — so a team indicator
   * keyed on it says "handled" because somebody looked. On 2026-08-27 that hid a finished
   * worker and a PR waiting on the maintainer's merge word.
   *
   * The kind is kept rather than reduced to a boolean here so the gutter and the state word
   * can each ask what it is without asking twice.
   */
  const need = needsKind(lead);
  const blocked = need != null;
  // The second dot, and a separate rule on purpose — the two are never folded into one
  // condition. The top slot always means *this wants you*; the bottom always means *this
  // is running*. A team can be both at once (a blocked lead over a working worker) and
  // most often is neither.
  //
  // Hoisted out of the object literal only so `age` below can read it. Nothing else moved.
  const working = isWorking(lead) || workingWorkers(team.repo) > 0;
  return {
    team,
    lead,
    blocked,
    need,
    // The whole rule, and only this rule.
    dot: blocked || review > 0,
    working,
    unread: lead.unread || 0,
    workers: liveWorkers(team.repo),

    /*
     * The team's workers as the card will draw them — `{name, word}` each, newest dispatch
     * first — computed here for the reason `age` two fields down is computed here: the
     * signature and the card have to agree about the *rendered* strings, or a worker
     * appearing, changing state or going away moves nothing the guard can see and the list
     * under the card silently stops repainting. One field, both readers.
     *
     * It is deliberately not the same set as `workers` above, which excludes `review` so
     * the meta line's two numbers stay disjoint. This one includes them — see
     * `allTeamWorkers` — so the list never hides a worker that is waiting on the
     * maintainer, and a `review` line says so on itself.
     */
    workerList: workerLines(team.repo),
    review,
    /*
     * How full this lead's context is — the number that says which one is heading for a
     * `/clear`, on the only screen that shows every team at once.
     *
     * `null` is a normal reading and not an error. `contextPct` is scraped off the composer
     * footer, which any box covers completely, so it is absent for exactly as long as a
     * lead is blocked — the same trap as `model` and `activity`, and they move together
     * because they are one line. The maintainer's call, taken when it was put to them: it
     * simply disappears then. The row is not silent while it does, because a blocked lead
     * is what lights the top dot.
     */
    ctx: Number.isFinite(lead.contextPct) ? Math.round(lead.contextPct) : null,

    /*
     * How long this lead has been sitting there — and the empty string is a state, not a
     * failure.
     *
     * Idle only, and idle here is spelled out as *not blocked and not working* rather than
     * `status === 'idle'`, so it cannot disagree with the two dots the row already draws. A
     * blocked lead is waiting on the maintainer and the word beside this one already says
     * `blocked`; an age there would be a second, quieter way of saying the same thing.
     *
     * `working` is the **team's** — `isWorking(lead) || workingWorkers(repo) > 0` — and
     * that is a ruling, not the nearest field to hand. The maintainer, 2026-08-30, asked
     * outright: *"While a worker is working from my perspective the lead is still working.
     * I am only interested to see idle time (while nothing is working — not the lead and
     * not its workers)."* So the number answers **is this whole team asleep**, not *is this
     * lead's own turn over* — an idle lead with a worker still grinding is a team that is
     * moving, and it shows no age. Do not narrow this to `!isWorking(lead)` to match the
     * desktop rail: the rail is a list of sessions and answers the per-session question,
     * this is a list of *teams* and deliberately does not. The same ruling is why the
     * desktop was left alone entirely — it was raised and declined in the same breath.
     *
     * Computed here rather than in `metaParts` on purpose. `renderHome`'s signature and the
     * card have to agree about what the age *string* is, or the tick fires against a
     * signature that never moves and the number on screen freezes — the whole failure this
     * feature exists to avoid. One field, both readers.
     *
     * And it is the bucketed string in the signature, never `lastActivity` itself: the raw
     * millisecond stamp differs on almost every roster frame, which would make the
     * signature differ on almost every roster frame and retire it as a repaint guard.
     */
    age: !blocked && !working ? relativeTime(lead.lastActivity) : '',
  };
}

/*
 * Note the first line is now a guard rather than something on screen. `homeRow` still
 * answers for a team with no lead — the start sheet is built out of exactly those rows —
 * but the home list no longer draws one, so the sentence is what this returns for a row
 * nothing renders. Left total rather than trimmed to the cases home has: a partial function
 * over `homeRow`'s own output would throw the day something asks it the other question.
 */
function stateWord(row) {
  if (!row.lead) return 'no lead running';
  return liveStateWord(row.lead, row.blocked);
}

/**
 * The state word for a session that is actually running — one spelling, two lists.
 *
 * `blocked` is passed in rather than re-derived: both callers already hold `needsKind`'s
 * answer, and a word that asked the question its own way could read `idle` beside a lit
 * dot. `dialog` is a box the panel will not answer — `/model`, `/effort`, the trust gate's
 * cousins — and saying `idle` there would be a lie, as well as disagreeing with the dot.
 */
function liveStateWord(s, blocked) {
  if (blocked) return 'blocked';
  return s.status || 'unknown';
}

/**
 * The home list and the start sheet, out of one pass over the teams.
 *
 * The test for "is this team running" is `homeRow`'s own `lead` field and there is
 * deliberately no second one. `leadFor` is what fills it, matched on `paneCwd` for the
 * reasons written over it, and a sheet that asked the same question its own way could offer
 * to start a lead that is already up — or hide the one row the home list is also hiding.
 * Two spellings of one rule is this project's oldest lesson in a smaller costume.
 *
 * Both halves come out in `state.teams`' order, which `loadTeams` sorts by name and
 * deliberately not by urgency: the order is a promise about where a row will be, and a list
 * that reorders under a thumb is how you tap the wrong one. `map` and `filter` preserve it,
 * so neither list re-sorts and the sheet is ordered the way home is.
 */
function partitionTeams() {
  const rows = (state.teams || []).map(homeRow);
  return {
    live: rows.filter((r) => r.lead),
    startable: rows.filter((r) => !r.lead),
  };
}

/**
 * Every ordinary session — the Standalones tab's list, and the source of its mark.
 *
 * `roomParticipants` is the allow-list, imported rather than restated: `interactive` and
 * `team?.role` either absent or `lead`. Subtracting the leads then leaves exactly the
 * sessions that belong to nobody's team. **Never written as "not a worker"** — kinds have
 * grown here once already (`planner`), and a negative test would have silently started
 * offering the next one. The desktop's room picker asks the same function, so the phone
 * cannot end up showing a session the Mac would refuse to put in a room.
 *
 * `isLead` is the roster's own `team?.role === 'lead'`, written out once in `sessions.js` —
 * one field, not a second opinion.
 *
 * Pane-only rows are **in**: a session opened and not yet spoken to carries a synthetic
 * `pane-19` id and no transcript, and it is exactly the session you are about to type into.
 * The maintainer's call, and the shell already follows the id when it first speaks
 * (`onRebound`).
 */
function standaloneRows() {
  return roomParticipants(state.sessions || []).filter((s) => !s.isLead);
}

/**
 * The same rows, in the order the tab draws them.
 *
 * Membership and order are kept apart on purpose: `roleRefusal` asks the *membership*
 * function, so nothing about a sort can widen or narrow who may be opened.
 *
 * Sorted by facts that do not move — the launch folder, then the name, then the id. The
 * roster's own order is urgency-first (blocked, then replied-and-unread, then recency),
 * which is right for the desktop rail and wrong under a thumb: the row you are reaching for
 * jumps to the top the instant something else blocks. The Leads tab sorts by name for the
 * same reason (`loadTeams`) — an order is a promise about where a row will be. The id
 * breaks the last tie so two sessions sharing a name in one folder cannot swap places
 * between frames.
 */
function standaloneSorted() {
  return standaloneRows()
    .slice()
    .sort(
      (a, b) =>
        String(a.project || '').localeCompare(String(b.project || ''), 'en') ||
        rowName(a).localeCompare(rowName(b), 'en') ||
        String(a.id).localeCompare(String(b.id), 'en'),
    );
}

/**
 * One ordinary session's worth of facts.
 *
 * Rendered strings and booleans only — this goes into the home signature, and a raw
 * `lastActivity` in there would differ on almost every roster frame and retire the guard
 * that stops the list being rebuilt under a thumb.
 */
function sessionRow(s) {
  const need = needsKind(s);
  return {
    id: s.id,
    name: rowName(s),
    // The launch folder's basename, and only when it is not already the name: `rowName`
    // falls back to `project` itself, and a row reading `alpha · alpha` says one thing
    // twice. `project` rather than the whole path — a path is most of a 320px screen.
    folder: s.project && s.project !== rowName(s) ? s.project : '',
    need,
    dot: need != null,
    working: isWorking(s),
    word: liveStateWord(s, need != null),
  };
}

/**
 * Which of the three tabs is holding something that wants a human.
 *
 * One rule per tab, and each is the same rule the tab's own rows draw — a tab that lit on a
 * different question from its list would be a mark you cannot find by opening it:
 *
 * - **Leads**: the card's own top dot, which is `needsKind(lead) != null || review > 0`.
 *   `review` is in it because a worker that has reported is waiting on the maintainer's
 *   merge word and the lead row is the only thing on this screen that says so.
 * - **Standalones**: `needsKind` alone. There is no team behind an ordinary session, so
 *   there is no second half.
 * - **Rooms**: `unseen`, which the store increments only for a *session's* post
 *   (`by !== null`) — the maintainer's own posts never badge a room, which is why a bench
 *   that only posts from the phone will watch this stay dark and conclude it is broken.
 *
 * `live` is passed in rather than recomputed so one paint maps the teams once.
 */
function tabMarks(live) {
  return {
    leads: live.some((r) => r.dot),
    standalones: standaloneRows().some((s) => needsKind(s) != null),
    rooms: (state.rooms || []).some((r) => (r.unseen || 0) > 0),
  };
}

function renderHome() {
  if (!homeList?.isConnected) return;

  /*
   * Ahead of the signature guard below, because the sheet carries its own. A launch
   * starting or failing changes what the sheet draws and nothing at all on the home list —
   * its rows are the teams with a lead, which is the one thing a launch in flight has not
   * got yet — so a repaint gated on the home signature would leave `start` on a row that is
   * already going. This is the one function every path that could move either list already
   * goes through.
   */
  /*
   * The create-room sheet, ahead of the guard for the reason the start sheet is: what it
   * draws is the **roster**, while the signature below is about rooms — so a session
   * appearing or exiting moves the picker and nothing at all on the list behind it, and a
   * repaint gated on that signature would never come. It carries its own.
   */
  renderCreateSheet();

  renderStartSheet();

  /*
   * One clock for the whole paint. The gauges' signature and the nodes it guards both ask
   * what time it is, and a paint that read the clock twice could bucket a reset string one
   * minute either side of the signature that was supposed to describe it — a gauge frozen
   * at the wrong number until something unrelated moved.
   */
  const now = Date.now();
  const quota = quotaSignature(now);

  // One pass over the teams for the whole paint: the marks need the lead rows and so does
  // the Leads tab's own body. Two passes could not disagree today, but they are two places
  // to change the day `homeRow` grows a field.
  const teams = partitionTeams();
  const marks = tabMarks(teams.live);
  const view = tabView(teams);

  /*
   * Repaint only when something a reader could see has changed. The roster is broadcast on
   * every real change and a list rebuilt under a thumb is a list that eats taps.
   *
   * Everything drawn is in here, the tab bar included: the active tab and all three marks,
   * because those are painted from inside this guard and a mark left out of a signature is a
   * mark that never lights. And every field is a **rendered string or a boolean**, never a
   * raw timestamp — a `lastActivity` in here would differ on almost every frame and retire
   * the guard entirely.
   *
   * Joined with real punctuation. `mergeSig` on the desktop once joined with what read in
   * every editor as an empty string and was three literal control bytes, so two different
   * lists could spell one signature.
   */
  const sig = [
    quota,
    route.tab,
    marks.leads ? 1 : 0,
    marks.standalones ? 1 : 0,
    marks.rooms ? 1 : 0,
    view.sig,
  ].join('::');
  if (sig === homeSignature) return;
  homeSignature = sig;

  renderQuota(now);
  renderTabs(marks);
  renderStartButton(view.startable);
  // A thunk, not a list: nothing is built for a paint the guard above turned away.
  homeList.replaceChildren(...view.nodes());
}

/**
 * What the tab you are on puts in the list, and what a repaint turns on.
 *
 * Three fields and they travel together on purpose: `sig` is what the guard compares and
 * `nodes` is what draws, so a body that changes what it renders cannot forget to say so.
 * `startable` is the header's `+` — a Leads-tab control, hidden everywhere else, since
 * "start a lead in a team that has none" is not an offer the other two lists can make.
 *
 * **Standalones and Rooms draw a placeholder for now** and that is deliberate rather than
 * unfinished-looking: the lists themselves are later items, and this one's job is the frame
 * they mount into. The counts are real — they come off the same rows the tab marks are
 * computed from — so the plumbing is visible rather than asserted.
 */
function tabView(teams) {
  if (route.tab === 'standalones') return standalonesView();
  if (route.tab === 'rooms') return roomsView();
  return leadsView(teams);
}

/** Today's home list, unchanged: the teams whose lead is running. */
function leadsView(teams) {
  if (!state.teams || !state.sessions) {
    return { sig: 'loading', startable: 0, nodes: () => [note('Loading teams…')] };
  }

  if (!state.teams.length) {
    return {
      sig: 'empty',
      startable: 0,
      nodes: () => [
        note(
          'No teams yet. A team directory is created the first time a lead is launched in a folder — do that once at the Mac and the folder appears here.',
        ),
      ],
    };
  }

  /*
   * Only the teams whose lead is running. A team with no live lead is not on this screen at
   * all — it is behind the header's `+`, which is the whole of that change: home answers
   * *what is happening right now*, and *what I could start* is a different question that was
   * being answered in the same list.
   *
   * The empty state one branch up is untouched and there is deliberately no second one. It
   * belongs to "no team directories exist", which is a different fact and still the one it
   * describes; a home list with every lead stopped draws no rows and no note, and the `+`
   * in the header is what it has to say.
   */
  const { live, startable } = teams;

  // `startable.length` rides in the signature because the header's `+` is painted from
  // inside the guard and appears and vanishes with that number — without it the button would
  // still be there after the last lead-less team gained a lead, opening onto nothing. The
  // launching and error state of those teams deliberately is *not* in here: home no longer
  // draws either, and the sheet keeps its own signature for exactly that.
  const sig =
    `${startable.length}::` +
    JSON.stringify(
      live.map((r) => [
        r.team.repo,
        r.lead.id,
        stateWord(r),
        // The rendered string, not `lastActivity` — see the field's own note in `homeRow`.
        r.age,
        r.dot,
        // What the dot *says* when it is touched, which the trust gate changes on its own.
        r.need,
        r.working,
        r.ctx,
        r.unread,
        r.workers,
        r.review,
        // The worker lines exactly as they are drawn — names and state words, in order.
        // Without them a worker appearing, changing state or going away leaves this string
        // untouched and the list under the card never repaints; a silent failure, which is
        // why it is the list itself in here and not its length.
        r.workerList,
        // The forge link, exactly as `leadForgeLink` reads it. Only `loadTeams` (page load
        // or a manual refresh) ever changes this, but without it here a repo whose remote
        // changed would keep the stale link — or none — until something else in the row
        // moved too.
        r.team.forge?.webUrl || '',
        r.team.forge?.reading || '',
      ]),
    );

  return { sig, startable: startable.length, nodes: () => live.map(teamNode) };
}

/**
 * The Standalones tab: every session that belongs to nobody's team.
 *
 * `standaloneRows` is the membership rule and `standaloneSorted` the order; both are above,
 * and the tab's mark asks the first of them, so the list and the mark can never be about
 * different rows. `startable: 0` because "start a lead in a team that has none" is not an
 * offer a list of ordinary sessions can make.
 *
 * Pane-only rows are **in** — a session opened and not yet spoken to, carrying a synthetic
 * `pane-19` id and no transcript. It is exactly the session you are about to type into, the
 * maintainer's own call, and the screen already follows the id the moment it first speaks
 * (`onRebound`). Its transcript opens on `Nothing said yet.`, which is the truth.
 */
function standalonesView() {
  if (!state.sessions) {
    return { sig: 'sa:loading', startable: 0, nodes: () => [note('Loading sessions…')] };
  }

  const rows = standaloneSorted().map(sessionRow);
  if (!rows.length) {
    return {
      sig: 'sa:empty',
      startable: 0,
      nodes: () => [
        note('No ordinary sessions running. Anything you start outside a team appears here.'),
      ],
    };
  }

  // Everything a reader could see, as rendered strings and booleans. `need` is in it beside
  // `dot` because the two say different things: the dot is whether it is lit, `need` is what
  // it says when it is touched, and the trust gate changes only the second.
  const sig =
    'sa::' +
    JSON.stringify(rows.map((r) => [r.id, r.name, r.folder, r.word, r.dot, r.need, r.working]));
  return { sig, startable: 0, nodes: () => rows.map(sessionNode) };
}

/**
 * The Rooms tab.
 *
 * The body is `web/m/rooms.js`'s, in this same `{sig, startable, nodes}` contract — the
 * list, the archived fold and the row that opens a room all live there with the room
 * screen they belong to, rather than in a shell that owns the socket and the router.
 *
 * `state.rooms === null` is a third answer, not a missing one: rooms ride on the roster
 * frame only, so a phone that has painted from `GET /api/sessions` has sessions and no
 * rooms yet, and `roomsListView` says "loading" rather than "no rooms" for it.
 *
 * `onChange` is `renderHome` because the fold's state lives in that module and this
 * screen's repaint guard lives here: a tap on `archived (N)` changes what the list draws
 * and nothing else on the phone, so it repaints through the one function every other path
 * already goes through.
 */
function roomsView() {
  return roomsListView(state.rooms, {
    onOpen: (id) => {
      location.hash = `#/room/${encodeURIComponent(id)}`;
    },
    onChange: renderHome,
    /* A thunk, not a list. The create sheet outlives any one paint and is repainted from
       `renderHome` above, so it has to read the roster again each time — a list captured
       when it opened would go on offering a session that has since exited. */
    sessions: () => state.sessions || [],
  });
}

/** The screen's one sentence, in the one shape it has. */
function note(text) {
  const el = document.createElement('div');
  el.className = 'm-note';
  el.textContent = text;
  return el;
}

/* --------------------------------------------------------------- quota --- */

/*
 * The two windows this header draws, and the only two. `windowsOf` deliberately carries an
 * unknown key through — `spend_limit` exists in Claude Code's own string table but has never
 * been observed on a real account — so the filter lives here rather than there: the day a
 * third window arrives the phone is wrong by omission, which is a missing bar, rather than
 * broken, which is a header that reflows on a shape nobody has ever seen.
 */
const QUOTA_WINDOWS = new Map([
  ['five_hour', 'Five-hour'],
  ['seven_day', 'Seven-day'],
]);

/** Tapped open, showing each window's reset time and how old the reading is. */
let quotaOpen = false;

function quotaWindows(now) {
  return windowsOf(state.rateLimits, now).filter((w) => QUOTA_WINDOWS.has(w.key));
}

/** The reset label for one window: a 24-hour clock time for `five_hour` (the maintainer's
 *  call — a countdown that never reaches zero on a phone glanced at once an hour is less
 *  useful than the time it actually resets), the ordinary countdown/weekday label from
 *  `formatReset` for everything else, `seven_day` included. */
function resetLabel(win, now) {
  return win.key === 'five_hour' ? formatResetClock24(win.resetsAt) : formatReset(win.resetsAt, now);
}

/**
 * Everything about the gauges a reader could see, as one string, folded into
 * `homeSignature` by all three of its branches.
 *
 * The rule is the same one `homeRow`'s `age` field already follows and for the same reason:
 * it is the **rendered** strings in here, never `record.at` or a raw percentage. The record
 * arrives every time any session on the Mac redraws its status line, which is several times
 * a turn, and a signature carrying the arrival stamp would differ on every one of them —
 * retiring the guard that stops the team list being rebuilt under a thumb. The rounded
 * percentage and the minute-bucketed reset string move only when the screen does, which on
 * a quiet phone is about once a minute.
 */
function quotaSignature(now) {
  const wins = quotaWindows(now);
  if (!wins.length) return '-';
  const dim = staleness(state.rateLimits, now) === 'dim';
  return [
    quotaOpen ? 'open' : 'shut',
    dim ? `dim:${relativeTime(state.rateLimits.at)}` : 'live',
    ...wins.map((w) => `${w.key}:${Math.round(w.pct)}:${w.tone}:${resetLabel(w, now)}`),
  ].join('|');
}

/**
 * Draw the pair, or draw nothing at all.
 *
 * Nothing is the common case and it is a real answer, not a failure — no record yet, or one
 * whose windows have both reset. A zero, or a grey placeholder, would be the panel showing
 * something wrong in the one slot on this screen a reader would trust without checking.
 */
function renderQuota(now) {
  const record = state.rateLimits;
  const wins = quotaWindows(now);
  if (!wins.length) {
    el.quota.replaceChildren();
    el.quota.hidden = true;
    return;
  }

  const dim = staleness(record, now) === 'dim';
  const age = relativeTime(record.at) || 'now';

  const row = document.createElement('span');
  row.className = 'm-quota-row';
  row.append(...wins.map((w) => quotaGauge(w, now, age)));

  /*
   * A dim record's age goes into the visible line rather than staying in the tooltip. The
   * feed is event-driven — a bench measured two status-line renders in five and a half
   * minutes with nothing else happening — so a bar that has been sitting still for hours
   * looks exactly like a live one, and that is the whole reason the record carries `at`.
   * Fifteen minutes is `staleness`'s call, not this file's.
   */
  if (dim && !quotaOpen) {
    const stale = document.createElement('span');
    stale.className = 'm-quota-age';
    stale.textContent = age;
    row.appendChild(stale);
  }

  const kids = [row];
  if (quotaOpen) {
    const asOf = document.createElement('span');
    asOf.className = 'm-quota-as-of';
    asOf.textContent = `as of ${age}`;
    kids.push(asOf);
  }

  el.quota.replaceChildren(...kids);
  el.quota.hidden = false;
  el.quota.classList.toggle('is-dim', dim);
  el.quota.classList.toggle('is-open', quotaOpen);
  el.quota.setAttribute('aria-expanded', quotaOpen ? 'true' : 'false');
  el.quota.setAttribute(
    'aria-label',
    `Rate limits, ${wins.map((w) => `${QUOTA_WINDOWS.get(w.key)} ${Math.round(w.pct)}% used`).join(', ')}`,
  );
}

function quotaGauge(win, now, age) {
  const pct = Math.round(win.pct);
  const reset = resetLabel(win, now);

  const gauge = document.createElement('span');
  // `win.tone` is `toneFor`'s answer, computed inside `windowsOf`. 50 and 75 are spelled in
  // `web/quota.js` and nowhere else — a phone drawing amber at one number and a desktop at
  // another is the `isLeadName` lesson in a smaller costume.
  gauge.className = `m-quota-gauge${win.tone ? ` is-${win.tone}` : ''}`;
  gauge.title = `${QUOTA_WINDOWS.get(win.key)} limit ${pct}% used · resets ${reset} · as of ${age}`;

  const label = document.createElement('span');
  label.className = 'm-quota-label';
  label.textContent = `${win.label} ${pct}%`;

  const bar = document.createElement('span');
  bar.className = 'm-quota-bar';
  const fill = document.createElement('span');
  fill.className = 'm-quota-fill';
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);

  gauge.append(label, bar);

  // Opened, the reset time sits under its own bar rather than in a sentence beside the
  // pair: the strings are the same handful of characters wide as the labels above them, so
  // the block grows downward by one line and never sideways. A header that got wider on a
  // tap is a header that can push the page into a horizontal scroll on a narrow phone.
  if (quotaOpen) {
    const resetEl = document.createElement('span');
    resetEl.className = 'm-quota-reset';
    resetEl.textContent = reset;
    gauge.appendChild(resetEl);
  }

  return gauge;
}

/**
 * The forge's mark beside a lead card's name — the desktop's own link
 * (`syncForgeLink`/`forgeLink` in `web/app.js`) drawn here from the same
 * `web/forge-mark.js` glyphs, opening the repository's own web page in the phone's
 * default browser rather than the installed PWA (`target="_blank"` plus `rel="noopener"`
 * is what gets an installed app to hand a link to the system browser on iOS and Android).
 *
 * `webUrl` is the whole test, same as the desktop: the server has already refused it for
 * `push only` and `no remote`, so there is nothing left to re-decide here.
 *
 * A child of `.m-team-body`, which is a `<button>` — the card's tap target already covers
 * this whole row, so the mark's own `click` calls `stopPropagation` to keep opening the
 * repo from also routing to the lead underneath it. Padding rather than a bigger glyph
 * gets the tap target to 44px; the matching negative margin keeps the row's own height and
 * the name's baseline exactly where they were without it.
 */
function leadForgeLink(forge) {
  const a = document.createElement('a');
  a.className = 'm-lead-forge';
  a.href = forge.webUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  // `owner/repo` off the link's own path rather than a second field from the server: one
  // source for the address means the label can never name a different repository from the
  // one the tap opens.
  let where = forge.webUrl;
  try {
    where = new URL(forge.webUrl).pathname.replace(/^\/+/, '') || forge.webUrl;
  } catch {
    /* the server built this string; if it is unparseable the whole URL is the honest label */
  }
  a.title = `${where} on ${forge.reading}`;
  a.setAttribute('aria-label', `Open ${where} on ${forge.reading}`);
  a.insertAdjacentHTML('beforeend', forgeMarkupFor(forge.reading));
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function teamNode(row) {
  const wrap = document.createElement('div');
  wrap.className = 'm-team';

  /*
   * One grid, three columns: the dot's gutter, the text, and a trailing control column
   * that the badge takes on line 1 and the context percentage on line 2.
   *
   * The whole body is the tap target, and unconditionally a `<button>` — `renderHome` hands
   * this only teams whose lead is live, so there is no lead-less shape to branch for any
   * more. It used to be a plain `div` in that case, because the launch button lived inside
   * it and a `<button>` inside a `<button>` is invalid markup whose disabled form swallows
   * the child's clicks; that control is now the header's `+` and its sheet, so the branch,
   * its `is-static` class and the row's error line all went with it.
   */
  const body = document.createElement('button');
  body.className = 'm-team-body';
  body.type = 'button';
  body.addEventListener('click', () => {
    location.hash = `#/lead/${encodeURIComponent(row.lead.id)}`;
  });

  /*
   * The gutter is two reserved slots, not one dot that moves.
   *
   * The maintainer's call, taken when it was put to them: the top slot always means *this
   * wants you* and the bottom always means *this is running*, whether or not the other is
   * drawn. A lone dot that slid into the middle would be a dot you have to read the row to
   * interpret, which is the one thing a dot is for. So both slots are always in the DOM and
   * an unlit one is simply not painted — the geometry cannot drift, because there is no
   * branch that changes it.
   */
  const gutter = document.createElement('span');
  gutter.className = 'm-dots';
  gutter.append(
    slotDot('m-dot-wait', row.dot, waitTitle(row)),
    slotDot('m-dot-work', row.working, 'this team is working'),
  );
  body.appendChild(gutter);

  const title = document.createElement('span');
  title.className = 'm-team-title';
  const name = document.createElement('span');
  name.className = 'm-team-name';
  name.textContent = row.team.name;
  title.appendChild(name);
  if (row.team.forge?.webUrl) title.appendChild(leadForgeLink(row.team.forge));
  body.appendChild(title);

  // A muted numeric badge, deliberately not the dot and deliberately not amber: it answers
  // a different question — the lead has said something since I last looked. Every count on
  // this row drops entirely at zero, this one included.
  if (row.unread > 0) {
    body.classList.add('has-badge');
    const badge = document.createElement('span');
    badge.className = 'm-badge';
    badge.textContent = row.unread > 99 ? '99+' : String(row.unread);
    badge.title = `${row.unread} unread ${row.unread === 1 ? 'reply' : 'replies'}`;
    body.appendChild(badge);
  }

  const meta = document.createElement('span');
  meta.className = 'm-team-meta';
  meta.append(...metaParts(row));
  body.appendChild(meta);

  /*
   * The context percentage, at the right-hand end of the same line.
   *
   * It rides in the trailing column rather than inside the meta text, which keeps the
   * meta's own `overflow: hidden` ellipsis doing what it already does — a `2 workers · 3 in
   * review` that has to give way gives way on its own, and the percentage never ellipsises
   * into `3` + `4`. Grid also means it cannot make the row taller: it lands in a cell that
   * already exists, beside a meta line it is smaller than.
   *
   * It used to share that cell with the launch button, which is now in the start sheet, so
   * it is the only thing in it. Nothing was layered then and nothing is now.
   */
  if (row.ctx != null) {
    const ctx = document.createElement('span');
    ctx.className = 'm-team-ctx';
    ctx.textContent = `${row.ctx}%`;
    ctx.title = `${row.ctx}% of this lead's context used`;
    body.appendChild(ctx);
  }

  wrap.appendChild(body);

  /*
   * The team's workers, one line each, **outside the body and never inside it**.
   *
   * `.m-team-body` is a `<button>`, and this card has already paid for that once: a
   * `<button>` inside a `<button>` is invalid markup whose disabled form swallows the
   * child's clicks, which is why the old launch control had to leave the row. These lines
   * are asked to be non-interactive, so it costs nothing to get right — they are siblings,
   * they carry no listener, and they are not tap targets. If they ever become tappable the
   * body has to stop being a button first.
   *
   * Nothing at all is appended for a lead with no workers: no container, no empty block,
   * and therefore no gap under the card. Every count on this row already drops entirely at
   * zero and this is the same rule with more of it.
   */
  if (row.workerList.length) wrap.appendChild(workerList(row));

  return wrap;
}

/** The block of worker lines under one card. Built only when there is at least one. */
function workerList(row) {
  const list = document.createElement('div');
  list.className = 'm-team-workers';
  for (const w of row.workerList) list.appendChild(workerLine(w));
  return list;
}

/**
 * One worker: a mark, its branch, and what it is doing.
 *
 * **One dot slot, not the card's two**, and that is not a departure from the gutter's rule.
 * The card reserves two rows because a lone dot that *slid between them* would be a dot you
 * have to read the row to interpret. Here the dot never moves — it is one fixed cell in a
 * one-line grid — and the word beside it names the state in full, so there is nothing left
 * to interpret. The vocabulary is the card's own: `m-dot-wait` for anything waiting on the
 * maintainer, `m-dot-work` for anything running, and an unlit `.m-dot` for the rest, which
 * is painted transparent rather than left out so the names stay in one column.
 */
function workerLine(w) {
  const line = document.createElement('div');
  line.className = 'm-team-worker';

  const waiting = w.word === 'waiting' || w.word === 'review';
  const working = w.word === 'working';
  const kind = working ? 'm-dot-work' : 'm-dot-wait';
  line.appendChild(slotDot(kind, waiting || working, workerDotTitle(w.word)));

  const name = document.createElement('span');
  name.className = 'm-team-worker-name';
  name.textContent = w.name;
  // The branch is the one thing on this line that can be too long for 320px, so the whole
  // of it is on the node the ellipsis is applied to.
  name.title = w.name;
  line.appendChild(name);

  const word = document.createElement('span');
  // `review` and `waiting` take the colours the card already uses for those two facts —
  // amber for a task in review, the decision red for a session holding a box — because one
  // fact must not read as two colours between a card and the lines under it. Everything
  // else stays the muted ink the whole block is drawn in.
  const tone = w.word === 'review' ? ' is-review' : w.word === 'waiting' ? ' is-waiting' : '';
  word.className = `m-team-worker-state${tone}`;
  word.textContent = w.word;
  line.appendChild(word);

  return line;
}

/**
 * What a worker's mark is about, in words — the sibling of `waitTitle` one card up.
 *
 * `review` and `waiting` are both the wait dot and they are not the same fact: one has
 * finished and is waiting on a merge word, the other is holding a box that is its **lead's**
 * to answer, and a phone that told the maintainer to go and answer it would be handing them
 * the worker the rail deliberately quiets. `slotDot` only sets a title on a lit dot, so the
 * idle case is never asked for.
 */
function workerDotTitle(word) {
  if (word === 'review') return 'has reported — waiting on your merge word';
  if (word === 'waiting') return 'holding a box — its lead answers it';
  return 'this worker is working';
}

/**
 * One ordinary session, on the Standalones tab.
 *
 * Two lines and one tap target, the shape a team card already has: the name on the first
 * line, the state word and the folder on the second. There is no badge and no context
 * percentage here — unread is a *team's* count of what its lead said while you were away,
 * and an ordinary session is one you are in front of.
 *
 * The gutter is the team card's own `.m-dots`, reused rather than restated. Two reserved
 * slots, the top meaning *this wants you* and the bottom *this is running*, so a dot is in
 * the same place whichever tab you are on; an unlit slot is unpainted, never absent, which
 * is what stops the geometry drifting as a session blocks and clears.
 */
function sessionNode(row) {
  const wrap = document.createElement('div');
  wrap.className = 'm-sess';

  const body = document.createElement('button');
  body.className = 'm-sess-body';
  body.type = 'button';
  body.addEventListener('click', () => {
    location.hash = `#/session/${encodeURIComponent(row.id)}`;
  });

  const gutter = document.createElement('span');
  gutter.className = 'm-dots';
  gutter.append(
    slotDot('m-dot-wait', row.dot, waitTitleFor(row.need)),
    slotDot('m-dot-work', row.working, 'this session is working'),
  );
  body.appendChild(gutter);

  const name = document.createElement('span');
  name.className = 'm-sess-name';
  name.textContent = row.name;
  body.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'm-sess-meta';
  const word = document.createElement('span');
  word.className = `m-sess-state${row.dot ? ' is-blocked' : ''}`;
  word.textContent = row.word;
  meta.append(word);
  if (row.folder) {
    const where = document.createElement('span');
    where.textContent = ` · ${row.folder}`;
    meta.append(where);
  }
  body.appendChild(meta);

  wrap.appendChild(body);
  return wrap;
}

/**
 * What the top dot is about, in words.
 *
 * The trust gate gets its own sentence and that is the only reason `need` carries a *kind*
 * rather than a boolean. That screen parses as a full, perfectly-readable permission box, so
 * a dot that said "holding a box" would send a reader to a card the panel deliberately draws
 * no button on — `web/notify.js`'s `trust` body says the same thing for the same reason.
 * Every other kind is a box this view can actually answer.
 *
 * `null` means the dot is lit for the other half of a team row's rule — a task in review —
 * which is why the sentence for it is about a task and not about a box.
 */
function waitTitleFor(need) {
  if (need === 'trust') return 'on the folder-trust gate — answer it on the Mac';
  return need ? 'holding a box' : 'a task is waiting on you';
}

/** A team row's version: the lead's own kind when it is blocked, and otherwise the review
 *  half of `row.dot`, which is not a box at all. */
function waitTitle(row) {
  return waitTitleFor(row.blocked ? row.need : null);
}

/** One slot of the gutter. Off means unpainted, never absent — see `teamNode`. */
function slotDot(kind, on, title) {
  const dot = document.createElement('span');
  dot.className = `m-dot ${kind}${on ? ' is-on' : ''}`;
  if (on) dot.title = title;
  return dot;
}

/** The second line: state, then the counts, each dropping entirely at zero. */
function metaParts(row) {
  const parts = [];
  const word = document.createElement('span');
  word.className = `m-team-state${row.blocked ? ' is-blocked' : ''}`;
  word.textContent = stateWord(row);
  parts.push(word);

  // Straight after the state word, so it reads as one clause — `idle · 2h`. Its own class,
  // never a borrowed one: the boxed `.m-team-review` sits in this same line and takes a
  // third row of its own (the maintainer's call, 2026-08-30), and an age sharing that name
  // would inherit the box.
  if (row.age) {
    const a = document.createElement('span');
    a.className = 'm-team-age';
    a.textContent = ` · ${row.age}`;
    a.title = 'idle for this long';
    parts.push(a);
  }

  if (row.workers > 0) {
    const w = document.createElement('span');
    // `workers`, not `running`: the same line already carries the lead's own state, and
    // `idle · 2 running` invites a half-second of "idle, or running?" every read.
    w.textContent = ` · ${row.workers} ${row.workers === 1 ? 'worker' : 'workers'}`;
    parts.push(w);
  }

  if (row.review > 0) {
    const r = document.createElement('span');
    r.className = 'm-team-review';
    r.textContent = ` · ${row.review} in review`;
    parts.push(r);
  }

  return parts;
}

async function startLead(team) {
  if (launching.has(team.repo)) return;
  launching.add(team.repo);
  launchErrors.delete(team.repo);
  renderHome();

  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `terminal: true` on purpose. A Terminal window is the only place the folder-trust
      // gate can be answered if this folder's record was lost, and there is no terminal on
      // a phone. It costs a window on a Mac nobody is sitting at.
      body: JSON.stringify({ lead: true, folder: team.repo, terminal: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Launch failed (${res.status}).`);

    if (data.sessionId) {
      // Closed here rather than left to `leaveRoute`, which does close it a moment later:
      // assigning `location.hash` fires `hashchange` as a task, so the `finally` below runs
      // first and would repaint this row back to `start` for a frame on a launch that
      // worked. The route change is still the backstop, and is what covers every other way
      // off this screen.
      closeStartSheet();

      // Straight into it — and note what that lands on: a session that has not yet written
      // a transcript carries a synthetic `pane-19` id, `subscribe` answers with an empty
      // transcript, and the registry issues a `rebound` the moment it first speaks. See
      // `onRebound`.
      location.hash = `#/lead/${encodeURIComponent(data.sessionId)}`;
    }
  } catch (err) {
    launchErrors.set(team.repo, err.message || String(err));
  } finally {
    launching.delete(team.repo);
    renderHome();
  }
}

/* --------------------------------------------------------- start sheet --- */

/*
 * The teams the home list is now hiding — the ones with no lead running — and the one thing
 * that can be done with them. Opened by the `+` in the shell header, which is drawn only
 * when there is at least one.
 *
 * The overlay idiom is the tasks tab's brief modal (`tasks.css`): a fixed backdrop over the
 * whole page, one scroller with `overscroll-behavior: contain`, and three ways out — the
 * ✕, the backdrop, and Escape. One thing differs and it is deliberate: this box is anchored
 * to the **bottom** of the screen rather than centred, because every row in it is something
 * to press and a centred box puts its own controls out of a thumb's reach on a big phone.
 *
 * It repaints behind its own signature for the reason `renderHome` has one. This box is
 * rendered from `renderHome`, which runs on every roster frame, and a list rebuilt under a
 * thumb is a list that eats taps — the signature moves only when a row appears, goes, or
 * changes what it says.
 *
 * There is no launch path of its own here: `startLead` is the one, unchanged, with its
 * `launching` set and its `launchErrors` map, and this is now its only caller.
 */
let sheet = null;

function openStartSheet() {
  if (sheet) return;

  const back = document.createElement('div');
  back.className = 'm-sheet-back';

  const box = document.createElement('div');
  box.className = 'm-sheet';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Start a lead');

  const head = document.createElement('div');
  head.className = 'm-sheet-head';
  const h = document.createElement('h2');
  h.textContent = 'Start a lead';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'm-sheet-x';
  x.textContent = '✕';
  x.setAttribute('aria-label', 'Close');
  head.append(h, x);

  // What the list is, in one line, because the `+` is a verb and this is what it acts on.
  // The panel cannot create a team from a phone — a team directory is written the first
  // time a lead is launched in a folder, and that is a thing done once at the Mac.
  const hint = document.createElement('p');
  hint.className = 'm-sheet-hint';
  hint.textContent = 'Teams with no lead running.';

  const list = document.createElement('div');
  list.className = 'm-sheet-list';

  box.append(head, hint, list);
  back.appendChild(box);
  document.body.appendChild(back);

  sheet = { back, list, sig: null };

  x.addEventListener('click', closeStartSheet);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) closeStartSheet();
  });
  document.addEventListener('keydown', onSheetKey, true);

  renderStartSheet();
  x.focus();
}

function onSheetKey(e) {
  if (e.key === 'Escape') closeStartSheet();
}

function closeStartSheet() {
  if (!sheet) return;
  sheet.back.remove();
  sheet = null;
  document.removeEventListener('keydown', onSheetKey, true);
}

function renderStartSheet() {
  if (!sheet) return;

  const { startable } = partitionTeams();

  /*
   * The last one gained a lead — started at the Mac, or by the tap that is still in flight.
   * The header's `+` goes in the same paint, so an empty box left up would be a second
   * thing on screen saying nothing. It closes instead: there is no note here, and the one
   * on the home list belongs to a different fact and is not being reworded to cover this.
   */
  if (!startable.length) {
    closeStartSheet();
    return;
  }

  const sig = JSON.stringify(
    startable.map((r) => [
      r.team.repo,
      launching.has(r.team.repo),
      launchErrors.get(r.team.repo) || '',
    ]),
  );
  if (sig === sheet.sig) return;
  sheet.sig = sig;

  sheet.list.replaceChildren(...startable.map(sheetRow));
}

/** One team, and the one thing that can be done with it. */
function sheetRow(row) {
  const item = document.createElement('div');
  item.className = 'm-sheet-item';

  const busy = launching.has(row.team.repo);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `m-sheet-row${busy ? ' is-busy' : ''}`;
  btn.disabled = busy;
  btn.addEventListener('click', () => startLead(row.team));

  const name = document.createElement('span');
  name.className = 'm-sheet-name';
  name.textContent = row.team.name;

  const go = document.createElement('span');
  go.className = 'm-sheet-go';
  go.textContent = busy ? 'starting…' : 'start';

  btn.append(name, go);
  item.appendChild(btn);

  const err = launchErrors.get(row.team.repo);
  if (err) {
    const line = document.createElement('div');
    line.className = 'm-sheet-error';
    // The server's own sentence, verbatim. "Not a git repository — a team lead needs one"
    // and "This project already has a team lead" are both real answers and both tell you
    // what to do next; a rewrite here would lose that.
    line.textContent = err;
    item.appendChild(line);
  }

  return item;
}

/**
 * The header's `+`: drawn only when there is something behind it.
 *
 * `[hidden]` alone would not do it — `.m-icon-btn` sets `display: flex`, which is a class
 * rule and beats the UA stylesheet. `m.css` carries the matching `[hidden]` rule, which is
 * the third time that trap has been paid for on this screen.
 */
function renderStartButton(n) {
  el.start.hidden = n === 0;
}

/* ------------------------------------------------------- conversation --- */

/**
 * Whether this route may show this row, and what to say when it may not.
 *
 * **A security control, and it is asked again on every roster frame rather than once at
 * mount.** Measured on the bench: a lead was launched from the phone, opened, and then
 * `/exit`ed — and the registry re-bound that *same session id* to the only other unbound
 * pane in the folder, an ordinary non-lead session. The screen went on updating, under the
 * same URL, showing a conversation this view had not been asked to show. The Standalones
 * route needs the mirror, or item 3 re-opens the hole item 3 exists to stay out of: an id
 * that comes back a **worker** — or a lead — stops the screen.
 *
 * The standalone half asks the **list**, never a second filter written out here. The list
 * is `roomParticipants` minus the leads: an allow-list on role, never "not a worker", since
 * kinds have grown here once already and a negative test silently admits the next one. A
 * membership test spelled a second time would drift in exactly that direction.
 *
 * A row that is not on the roster at all is **not** a refusal — that is a beat during a
 * rebound or a rotation, and `onRoster`'s gone timer is what covers a session that never
 * arrives.
 */
function roleRefusal(s) {
  if (!s) return null;
  if (route.kind === 'lead') return s.isLead ? null : 'not-lead';
  return standaloneRows().some((r) => r.id === s.id) ? null : 'not-standalone';
}

function enterConversation() {
  // The screen draws its own header (back, who, model, `ctx:`, interrupt), so the shell's
  // stands down and the frame takes over the status-bar inset.
  el.head.hidden = true;
  app.classList.add('no-head');

  // A hash typed, bookmarked or reloaded can name anything, and each list only ever links
  // its own. This is the one door another kind of session could come through.
  const refusal = roleRefusal(sessionOf(route.sessionId));
  if (refusal) return showGone(refusal);

  const host = document.createElement('div');
  host.className = 'm-host';
  el.screen.appendChild(host);

  leadCtx = makeCtx();
  leadEverSeen = Boolean(sessionOf(route.sessionId));

  // Mounted before anything paints, for the reason in `enterHome`.
  mountLead(host, leadCtx);

  send({ type: 'subscribe', sessionId: route.sessionId, slot: SLOT });
}

/**
 * The screen's window onto the shell. These names are the contract the conversation screen
 * is written against; nothing else here is public. Three of them landed with the Standalones
 * tab — `kind`, `homeHash` and `homeLabel` — because one screen module now serves two routes
 * and has to know which, and because "back" is the tab you left rather than a bare `#/`.
 */
function makeCtx() {
  const mine = [];
  return {
    /*
     * A live getter, not a snapshot. A freshly launched lead's id changes under it (see
     * `onRebound`) and a screen holding the old string would go on filtering every frame
     * against an id the server has stopped using — a permanently blank transcript on the
     * one session the maintainer just started.
     */
    get sessionId() {
      return route.sessionId;
    },
    session: () => sessionOf(route.sessionId),
    /*
     * Which of the two conversation routes mounted this screen.
     *
     * The screen module is one file for both — the transcript, the answer cards, the
     * composer, the suggestion line and the interrupt are the same on either — and this is
     * what it branches on for the parts a team has and an ordinary session does not.
     */
    get kind() {
      return route.kind;
    },
    /** Where "back" goes and what to call it: the tab you left, never a bare `#/`. */
    homeHash: () => homeHash(),
    homeLabel: () => TAB_LABELS[route.tab],
    /*
     * How many workers this lead has running, for the mark on its `tasks` tab.
     *
     * Answered here rather than handed the roster, so `liveWorkers` stays the one place
     * that decides what a running worker is. Two spellings of that rule could disagree —
     * the home list saying `2 workers` over a tab reading `3` is the `isLeadName` lesson
     * in a smaller costume — and the phone's whole claim over the desktop's count is that
     * it is the honest one.
     *
     * `paneCwd` is the pane's *launch* folder, which is the identical value
     * `SessionRegistry#team` hands `isLeadName`, and the same key `leadFor` matches on.
     * `cwd` is the transcript's and moves when a session changes directory.
     *
     * It is a **lead's** own team and never the folder's, which is the same trap the tasks
     * tab has: an ordinary session launched inside a team's folder carries that team's
     * `paneCwd`, so a count taken off the folder alone would put somebody else's workers on
     * its screen. The session route builds no tasks tab at all — this is the belt to that
     * brace.
     */
    workers: () => {
      const s = sessionOf(route.sessionId);
      if (!s?.isLead || !s.paneCwd) return 0;
      return liveWorkers(s.paneCwd);
    },
    send: (msg) => send({ slot: SLOT, ...msg }),
    on: (type, fn) => {
      mine.push([type, fn]);
      busOn(type, fn);
    },
    off: (type, fn) => {
      busOff(type, fn);
    },
    /* Shell-internal: every handler a screen registered goes when the screen does, so a
       route change cannot leave a dead screen listening to the socket. */
    _dispose() {
      for (const [type, fn] of mine) busOff(type, fn);
      mine.length = 0;
    },
  };
}

function sessionOf(id) {
  return (state.sessions || []).find((s) => s.id === id) || null;
}

/* --------------------------------------------------------------- room --- */

/** One room off the roster, or null. `state.rooms` is null until the first frame carrying
 *  the key, which is not the same answer as "there is no such room" — the screen tells the
 *  two apart off the server's own `group-room` frame, never off this. */
function roomOf(id) {
  return (state.rooms || []).find((r) => r.id === id) || null;
}

/**
 * `#/room/<id>`: the log, and a box that posts as the maintainer.
 *
 * The subscribe lives here rather than inside `mountRoom` so that it sits beside the
 * `unsubscribe-group-room` in `leaveRoute` and the re-subscribe in `ws.onopen` — three
 * lines that have to agree, in one file, which is the whole lesson of the transcript
 * tailer. The screen module never touches the socket except through `ctx.send`.
 */
function enterRoom() {
  // The room screen draws its own header (back, name, socket), so the shell's stands down
  // and the frame takes over the status-bar inset — `enterLead`'s own two lines.
  el.head.hidden = true;
  app.classList.add('no-head');

  const host = document.createElement('div');
  host.className = 'm-host';
  el.screen.appendChild(host);

  roomCtx = makeRoomCtx();

  // Mounted before anything paints, for the reason in `enterHome`.
  mountRoom(host, roomCtx);

  send({ type: 'subscribe-group-room', roomId: route.roomId, slot: SLOT });
}

/**
 * The room screen's window onto the shell. These six names are its whole contract; nothing
 * else in this file is public to it.
 */
function makeRoomCtx() {
  const mine = [];
  return {
    /* A live getter for the same reason the lead screen's is one: the route is the truth
       about which room is open, and a screen holding a copy would filter every frame
       against an id the router has moved on from. */
    get roomId() {
      return route.roomId;
    },
    room: () => roomOf(route.roomId),
    /* The live roster, for the membership sheet's two pickers — who may be put in a room,
       and which row a stored member is right now. A thunk for `room()`'s reason: the sheet
       is repainted on the roster beat and a captured list would go stale under it. */
    sessions: () => state.sessions || [],
    /* The socket's own state, asked rather than mirrored off the shell's DOM. `lead.js`
       reads the header's dot with a literal selector and says why at length — a second
       WebSocket would be worse than no indicator at all — and this is the same fact one
       layer earlier, where a header refactor cannot reach it. */
    connected: () => state.connected,
    homeHash,
    send: (msg) => send({ slot: SLOT, ...msg }),
    on: (type, fn) => {
      mine.push([type, fn]);
      busOn(type, fn);
    },
    off: (type, fn) => {
      busOff(type, fn);
    },
    /* Shell-internal: every handler the screen registered goes when the screen does, so a
       route change cannot leave a dead screen listening to the socket. */
    _dispose() {
      for (const [type, fn] of mine) busOff(type, fn);
      mine.length = 0;
    },
  };
}

/**
 * The registry moved a session from its synthetic id to a real one.
 *
 * Until a session has written a transcript it appears as `pane-19`; the moment it first
 * speaks the registry issues this frame and — importantly — **re-subscribes the slot
 * itself**, immediately after sending it. So the client follows the id and must not
 * subscribe again; the desktop does exactly the same.
 *
 * A phone that just tapped `start lead` and was dropped into the new lead is in precisely
 * this state, which is what makes this the shell's problem rather than the lead screen's.
 * `replaceState` rather than assigning `location.hash`, because that would fire a
 * `hashchange`, re-route, and tear down the screen that is mid-subscribe.
 */
function onRebound(msg) {
  if (!isConversation(route.kind) || msg.from !== route.sessionId) return;
  route.sessionId = msg.to;
  leadEverSeen = false;
  clearTimeout(goneTimer);
  goneTimer = null;
  // The kind the route was opened on, kept: a rebound moves the id and changes nothing
  // about what the hash claims, and rewriting it as the other kind would answer
  // `roleRefusal` with a question nobody asked.
  history.replaceState(null, '', `#/${route.kind}/${encodeURIComponent(msg.to)}`);
  updateLead(sessionOf(msg.to));
}

function onRoster() {
  if (route.kind === 'home') {
    renderHome();
    return;
  }

  /*
   * A room's own record — its name, its membership and whether it is archived — reaches the
   * screen through the roster rather than through the `group-room` frame, which is only
   * sent at subscribe. A `PATCH` at the Mac broadcasts a roster frame, so a rename or an
   * archive lands here a beat later. `updateRoom` ignores a null: a room is never deleted,
   * so a missing record means the roster has not carried one yet.
   */
  if (route.kind === 'room') {
    updateRoom(roomOf(route.roomId));
    return;
  }

  const session = sessionOf(route.sessionId);
  if (session) {
    /*
     * The id survived, but it may not be what the hash claims any more — and that is not
     * hypothetical. The measurement, and why both routes ask, is over `roleRefusal`.
     *
     * No grace period on either side: `isLead` is read off the session's tmux name and
     * cannot flicker for a lead that is still a lead, and the standalone allow-list is read
     * off `team.role`, which `sessions.js` writes out of one `#team()` call.
     */
    const refusal = roleRefusal(session);
    if (refusal) return showGone(refusal);
    leadEverSeen = true;
    clearTimeout(goneTimer);
    goneTimer = null;
    updateLead(session);
    return;
  }

  updateLead(null);

  /*
   * Missing from the roster. That is normal for a beat — a rotation or a rebound removes
   * the old id in the same frame that carries the new one — so it is only a gone session
   * if it stays missing. Armed only for a session we have actually seen: you cannot say
   * one went away if it was never there, and a launch navigates a step ahead of the
   * broadcast that would prove it.
   */
  if (!leadEverSeen || goneTimer) return;
  goneTimer = setTimeout(() => {
    goneTimer = null;
    if (!isConversation(route.kind) || sessionOf(route.sessionId)) return;
    showGone();
  }, 4000);
}

function showGone(reason = 'exited') {
  // Stop reading a transcript this screen has no business holding open.
  send({ type: 'unsubscribe', slot: SLOT });
  leadCtx?._dispose();
  leadCtx = null;
  clearTimeout(goneTimer);
  goneTimer = null;
  el.screen.replaceChildren();

  const box = document.createElement('div');
  box.className = 'm-gone';
  const text = document.createElement('div');
  text.className = 'm-gone-text';
  /*
   * Four sentences, because there are two ways to be refused and two things to have gone.
   * A worker reaches both refusals — a `#/lead/` hash naming one, and a `#/session/` hash
   * naming one — and neither sentence offers to open it anywhere, because nothing on this
   * device does: a worker's question is its lead's to answer.
   */
  text.textContent =
    reason === 'not-lead'
      ? 'That session is not a team lead. Leads are opened from the Leads tab.'
      : reason === 'not-standalone'
        ? 'That session is not an ordinary one. A team lead opens from the Leads tab, and a worker is its lead’s to answer — it is never opened here.'
        : route.kind === 'lead'
          ? 'This lead is no longer running. It was closed or it exited.'
          : 'This session is no longer running. It was closed or it exited.';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'm-back';
  // The tab you left, named and returned to — not a bare `#/`, which would land on Leads
  // however you got here.
  back.textContent = `‹ ${TAB_LABELS[route.tab].toLowerCase()}`;
  back.addEventListener('click', () => {
    location.hash = homeHash();
  });
  box.append(text, back);
  el.screen.appendChild(box);
}

/* --------------------------------------------------------------- api --- */

async function loadTeams() {
  try {
    const res = await fetch('/api/teams');
    const data = await res.json();
    // Sorted here as well as on the server: the order is a promise about where a row will
    // be, and it should not depend on which end sorted it. The desktop rail reorders by
    // urgency; a list that reorders under a thumb is how you tap the wrong row.
    state.teams = (data.teams || [])
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'));
  } catch {
    state.teams = state.teams || [];
  }
  if (route.kind === 'home') renderHome();
}

async function loadRoster() {
  // First paint, before the socket lands. Never overwrites a socket frame — that one is
  // newer by construction.
  if (state.sessions) return;
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!state.sessions) {
      state.sessions = data.sessions || [];
      onRoster();
    }
  } catch {
    /* the socket is the real source; it will be along */
  }
}

function refresh() {
  el.menuBtn.classList.add('is-busy');
  loadTeams().finally(() => el.menuBtn.classList.remove('is-busy'));
  if (ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) {
    retry = 0;
    connect();
  }
}

/* --------------------------------------------------------------- boot --- */

window.addEventListener('hashchange', navigate);

paintConn();

/*
 * The remembered tab, and the **only** place it is consulted.
 *
 * `location.hash` is empty exactly when the page was opened with no route — the Home Screen
 * app's `start_url` is `/m/`, and so is a typed address. That is the moment the memory is
 * for. An explicit `#/rooms`, a bookmark, a reload and the back gesture all carry a hash and
 * are obeyed as written, so a route somebody asked for is never overridden by one they asked
 * for yesterday; a bare `#/` is Leads, by `parseHash`, and stays so.
 *
 * `replaceState` rather than assigning `location.hash`: this runs before the first
 * `navigate`, and a `hashchange` fired here would route twice on every cold open.
 */
if (!location.hash) history.replaceState(null, '', `#/${phoneTab.value}`);

// No route yet, so `navigate` always mounts one — including a reload that landed straight
// on `#/lead/<id>`, which has to come back to that lead rather than to the list.
route.kind = null;
navigate();

loadTeams();
loadRoster();
connect();
