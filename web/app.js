import { marked } from '/vendor/marked.js';
import { withBlankTargets } from './anchor-target.js';
import { isTrustGate, buildTrustNotice } from './trust-gate.js';
import { step, alertText } from './notify.js';
import { forgeMarkupFor } from './forge-mark.js';
// The files modal's two halves that can be tested without a browser: which pill an entry
// belongs under and how the endpoint's two arrays become one newest-first list
// (`files-kinds.js`), and the glyph a link row wears (`link-mark.js`, markup strings for
// `forge-mark.js`'s reason — and no favicons, ever, which would phone out to every host
// the transcript names the moment the modal opens).
import { FILE_KINDS, filesCounts, filesFor, filesItems, kindLabel } from './files-kinds.js';
import { linkMarkupFor } from './link-mark.js';
// …and the preview overlay's third pure half: which renderer an entry gets, what it can be
// asked to do, and the line along the bottom. Separate from `files-kinds.js` because the
// pill an entry lives under and the way it is painted are answered from different fields —
// an `.svg` is `kind: 'image'` in the grid and text in the overlay, and only `source` tells
// those apart.
import {
  previewable,
  previewActions,
  previewFoot,
  previewKindFor,
  previewLost,
} from './files-preview.js';
// …and whether an arriving message just put something in that modal, for the dot on the
// `files` button. The predicate is DOM-free so a node test can hold its six witnesses, and
// the extension list it asks about is the one `server/outputs.js` filters a `Write` with —
// imported from `web/output-exts.js` by both, rather than spelled twice.
import { anyNewOutput } from './files-new.js';
// …and the height that modal settles at when it opens. Pure so `test/files-height.test.js`
// can hold the clamp and its refusals in plain Node; the measuring is the browser's half
// and stays in `openFiles`.
import { filesModalHeight } from './files-height.js';
// …and the path detector the conversation's own prose is walked with. Shape only: it
// answers which runs of text *look* like a path, and `linkablePaths` then keeps the ones
// that name this session's own outputs or a folder holding one. Pure for the usual reason
// — `test/path-links.test.js` holds the six measured false-positive classes in plain Node,
// where a browser would only get in the way.
import { pathLinksIn, resolvePath } from './path-links.js';
// The ghost-text auto-send flag, the TASKS filter, and the one definition of what that
// filter hides. In `web/prefs.js` rather than here because the phone's lead screen reads
// the same keys, and two spellings of one setting is a setting that appears to work — see
// that file's header.
import { asideFolded, ghostSend, hideFinished, isFinishedState } from './prefs.js';
// …and the room slot's own fold flag, on a line of its own rather than folded into the one
// above. `test/aside-fold.test.js` pins that import verbatim, and this item may not edit the
// aside's test — two lines from one module is the cheap half of that trade, and collapsing
// them is a one-line change for whoever touches these imports next.
import { roomFolded } from './prefs.js';
// …and the `files` modal's remembered grid/list choice, on its own line for the same reason.
import { filesView } from './prefs.js';
// What a closed side panel has room to say. The ninth pure module under `web/`, shipped by
// item 1 of this feature with nothing wired to it; the lead's aside is the first half to
// wear it. `asideStripFacts` reads the same `s.team` object `teamLine` reads, which is what
// stops the strip and the rail row disagreeing about a team a reader can see twice at once.
// `roomStripFacts` is the same trade one panel over, and `foldTracks` is the split fold's
// own arithmetic — the px pair a room slot animates between, kept out of here so a node
// test can hold it.
import { asideStripFacts } from './panel-fold.js';
// The room slot's two, on their own line for the reason the line above `roomFolded` gives.
// `roomStripFacts` is `asideStripFacts`' opposite number one panel over, and `foldTracks` is
// the split fold's arithmetic — the px pair a room slot animates between, kept out of here
// so a node test can hold it.
import { foldTracks, roomStripFacts } from './panel-fold.js';
// Which of its two meanings the button above the composer is carrying, and the one repaint
// key both halves of that row are guarded on. The tenth pure module under `web/`: a
// suggestion exists only while the pane is idle and an idle session's `interrupt` has
// nothing to stop, so one control does both jobs and the rule for which is which is a thing
// a node test can hold.
import { ghostAction, ghostSig, INTERRUPT_TITLE } from './ghost-action.js';
// The order a lead's nested workers are drawn in — by dispatch time, newest on top, and
// never re-sorted after that. The one place in the rail that is not recency, which is why
// it is a module and not a comparator inlined into `renderRail`: the rule that a team block
// holds still is exactly the kind of thing that gets optimised back into `lastActivity` by
// somebody tidying, and a node test is what stops that.
import { GROUP_COLOUR_COUNT, hueVar, isGroupColour } from './group-hue.js';
// ^ the group ring's spelling and its bounds. `renderRail` sets `--h` inline on every
// sibling a group owns, because the rail is a flat list with no container to hang it on,
// and the `⋯` menu's swatch row offers all `GROUP_COLOUR_COUNT` of them — a slot the ring
// has but the menu hides is a colour you cannot choose.
import { eligibleFolders, matchesFilter } from './group-folders.js';
// ^ which folders a group's `+` may offer, and the one spelling of "the filter box matched
// this". Both are rules that render perfectly when re-derived wrongly — a menu that forgets
// to exclude the group's own folders offers a pick that does nothing.
import { foldsInto, splitTitle } from './rail-fold.js';
// ^ when a folder heading is furniture, and how the row's title splits into the path it
// sits on and the leaf that names it. The eleventh pure module under `web/`, and both
// rules are in it rather than inline because the wrong re-derivation of either renders
// perfectly: a fold one row too eager hides a heading over two sessions, and a title split
// on its own punctuation invents a path that is not the folder.
import { orderWorkers } from './worker-order.js';
// What the team room draws, given the slate the server holds — the `clear` / `show all`
// pointer. Its own module for the reason every other pure one under `web/` is: the filter
// is a rule ("from the divider on, divider included") that a node test can hold, and the
// day it is wrong the room simply shows the wrong lines and looks fine doing it.
import { slateActive, slateButton, visibleEntries } from './room-slate.js';
// The two subscription gauges' arithmetic: 50/75 and the percent→tone map, which windows
// are worth drawing, how old the record is, and how a reset time reads. The fourth shared
// pure module in `web/`, for the reason each of the three above gives — the phone draws
// the same two bars off the same record, and a desktop going amber at one number while a
// phone goes amber at another is the `isLeadName` lesson in another costume. Nothing here
// may define a threshold, a format or a staleness rule of its own.
import { windowsOf, staleness, formatReset } from './quota.js';
// One colour per speaker in the shared room, keyed on the session's name. The fifth shared
// pure module in `web/`, node-tested like the four above it — and the reason it is a module
// rather than four lines here is the same one every time: the name→hue map has to be
// stable across restarts and provable in a test, and a hash inlined into a render function
// is neither.
import { colourFor } from './session-colour.js';
// The rail's rooms band: which rooms it draws, in what order, what its signature is made of
// and how a row is patched rather than rebuilt. The sixth shared pure module in `web/`, for
// the reason each of the five above it gives — the shape of the list and the punctuation of
// the signature are things a node test can hold, and a render function inlined here is
// neither. `patchBand` reaches for `document` the way `buildTrustNotice` does, and is
// driven by the same kind of stub in its own test.
import { patchBand, bandSig } from './rooms-band.js';
// The create modal's arithmetic: who may be in a room, in what order they are offered, and
// what stops the button being pressable. The seventh, for the band's own reason one line up
// — and `roomParticipants` here is now the *only* spelling of the allow-list on this side of
// the wire; peer messages had a second caller until its `@` composer was retired.
import {
  canCreate,
  capRefusal,
  countLine,
  createReason,
  MAX_MEMBERS,
  MAX_ROOM_NAME,
  orderForHere,
  roomParticipants,
  rowFolder,
  rowName,
} from './rooms-create.js';
// The room pane's own arithmetic: the order entries are drawn in, which roster row a stored
// member is *right now* (for a dot, and only for a dot), what became of one post, and who is
// left to add. The eighth, for the reason each of the seven above it gives — and its header
// records why `memberRow` mirrors `server/rooms-line.js` rather than importing it, and what
// stops the two drifting into a disagreement that matters.
import {
  addableSessions,
  addReason,
  addressedText,
  entryKey,
  handedText,
  handedWaiting,
  insertMention,
  memberKey,
  memberName,
  memberRow,
  mentionMatches,
  mentionQuery,
  roomOrdered,
} from './rooms-pane.js';

marked.setOptions({ gfm: true, breaks: true });

/* ------------------------------------------------------------- state --- */

const state = {
  sessions: [],
  // Folder groups you made by hand. They ride along with the roster because the rail
  // draws both from one frame, and half a frame draws a rail with folders in two places.
  groups: [],
  // The saved bench, summarised: when it was taken, how many, and how far the live roster
  // has wandered from it. Rides the same frame as the roster for the same reason the
  // groups do — the drift dot is drawn from it, and a dot that lagged the rail by a poll
  // would be pointing at a state nobody is in any more.
  snapshot: { savedAt: null, count: 0, drift: { missing: [], extra: [] } },
  // The account's rate limits, exactly as `server/rate-limits.js` holds them, or `null`
  // until some session's status line has posted one. A sibling of `sessions` on the roster
  // frame like the groups, and for a sharper version of the same reason: it
  // is one account-wide number, so a copy of it on every session row would make the
  // server's own `#diff` broadcast the whole roster every time it moved.
  //
  // `null` is an ordinary answer and not an error — a machine whose status line has not
  // been wrapped, an API-key account, or simply a panel that has been up for less time
  // than any session has taken a turn. It draws nothing.
  rateLimits: null,
  // The shared room, **as a summary and nothing else**: `{unseen, lastAt}`, or nulls until
  // a frame has carried one. A sibling of `sessions` like the groups and the rate limits,
  // and for the sharpest version of that reason — this one summarises a
  // machine-wide log with a 4 MB ceiling, so the entries deliberately never ride the roster
  // frame at all. They arrive once on `subscribe-shared` and one at a time after that.
  //
  // It is not an inbox and `unseen` is not a badge that asks for anything: every message in
  // this log was answered by the session it was sent to before the panel ever saw it. The
  // count says the room moved, which is all it may say.
  sharedRoom: { unseen: 0, lastAt: null },
  // Every group room on this machine — open and archived both — exactly as
  // `GroupRoomStore#list` hands them over: `{id, name, members, memberCount, unseen, lastAt,
  // lastFrom, archivedAt}` and nothing else. A sibling of `sessions` on the roster frame like
  // the groups, the rate limits and the shared room, and computed from memory at
  // the other end for the sharpest version of that reason: a file read in `rosterFrame` is a
  // file read every two seconds, forever.
  //
  // Archived ones ride along because the band folds them into `archived (N)` and needs the
  // count. The entries never do — those arrive on `subscribe-group-room` and one at a time
  // after that, the way the shared room's do.
  //
  // An empty array is the ordinary answer: most of the time there are no rooms. That is what
  // makes `'rooms' in msg` the test and a truth test the bug — see the roster handler.
  rooms: [],
  // Whether the band's `archived (N)` fold is shut. This browser's, not the server's, and
  // deliberately: a group's collapse is a fact about your filing and should follow you
  // between windows, while this is a fact about the window you are looking at — the same
  // call `foreman.flatRail` makes one field down. Shut to begin with, because an archived
  // room is by definition the one you stopped needing.
  roomsArchivedShut: !loadFlag('foreman.roomsArchivedOpen'),
  // Shelving off: one recency-ordered list instead of groups and folder headings. Kept in
  // this browser rather than on the server, unlike a group's collapse state — that is a
  // fact about your filing and should follow you between windows, while this is a fact
  // about the window you're looking at. A phone and a desktop want different answers.
  flatRail: loadFlag('foreman.flatRail'),
  showThinking: false,
  // Half-written messages, per session. Switching sessions to go check something is
  // normal; losing what you'd typed because of it is not.
  drafts: loadStore('foreman.drafts'),
  // Images waiting to go with the next message, per session. Kept out of the textarea
  // so the box holds your words; the paths are substituted in at send time.
  attachments: loadStore('foreman.attachments'),
  // What each pane was showing when you last looked, so a refresh puts you back rather
  // than at the top of the rail. Per slot: `{ id, paneId }` — see `rememberOpen`.
  opened: loadStore('foreman.opened'),
};

function loadStore(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * A stored on/off flag, and the reason it is a function rather than the one-liner it
 * replaced.
 *
 * `localStorage` is a *getter* that throws where a browser blocks site data — not a store
 * that answers `null` — so the bare `localStorage.getItem(...)` this used to be threw at
 * module scope, before a single line of the panel had run. Measured with storage denied:
 * one exception at `app.js:22`, the module dead, the rail drawing zero rows, and the whole
 * page a header over nothing. It is the only read here that was ever outside a guard;
 * `loadStore` above and the resizers' `readPref` below both already had one.
 *
 * Not `readPref`, deliberately: that one parses a size in rem and caches it in the map the
 * dividers persist from, and a boolean has no business in either.
 *
 * Off is the correct answer with nothing stored — the rail's groups and folder headings
 * are what a browser that has never been told otherwise should draw.
 */
function loadFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    /* private mode, or storage denied — off is a perfectly good answer */
    return false;
  }
}

function persistDrafts() {
  try {
    localStorage.setItem('foreman.drafts', JSON.stringify(state.drafts));
    localStorage.setItem('foreman.attachments', JSON.stringify(state.attachments));
  } catch {
    /* quota or private mode — both still live in memory for this session */
  }
}

/**
 * Remember what a pane is showing, by session *and* by pane.
 *
 * The session id is the precise answer and the perishable one: `/clear` mints a new id
 * for the same terminal, so a reload an hour later would find nothing under it. The tmux
 * pane outlives that, and "the conversation running where I left it" is what you actually
 * meant — so both are kept, and the id is only tried first.
 */
function rememberOpen(slot, sessionId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (sessionId) state.opened[slot] = { id: sessionId, paneId: s?.paneId ?? null };
  else delete state.opened[slot];
  persistOpen();
}

/**
 * The fourth shape a slot can be remembered in: the shared room.
 *
 * It carries no id, because there is one room on the machine — which is exactly why it
 * needs its own `kind` rather than a session entry with a reserved id. `adopt` reads `kind`
 * to tell the shapes apart, and a slot remembering something it cannot name would fall
 * through both session keys and be replaced by whatever session sorts first.
 *
 * `autoSplit` means the same thing it means for a thread — whether this pane exists
 * *because* the room was opened, and so whether closing it should take the panel back to
 * one pane. See `threadSplit`.
 */
function rememberOpenShared(slot, on, autoSplit = false) {
  if (on) state.opened[slot] = { kind: 'shared', autoSplit: Boolean(autoSplit) };
  else delete state.opened[slot];
  persistOpen();
}

/**
 * The fifth shape a slot can be remembered in: one group room, by id.
 *
 * By id where the shared room needs none, because there are many of them — and with its own
 * `kind` rather than the shared room's shape carrying a room id, for its reason:
 * `adopt` reads `kind` to tell the shapes apart, and a slot remembering something under
 * somebody else's word would be restored as the wrong thing rather than as nothing.
 *
 * `autoSplit` means what it means for the other two — whether this pane exists *because* the
 * room was opened, and so whether closing it should take the panel back to one pane. See
 * `threadSplit`.
 */
function rememberOpenGroup(slot, roomId, autoSplit = false) {
  if (roomId) state.opened[slot] = { kind: 'group-room', room: roomId, autoSplit: Boolean(autoSplit) };
  else delete state.opened[slot];
  persistOpen();
}

function persistOpen() {
  try {
    localStorage.setItem('foreman.opened', JSON.stringify(state.opened));
  } catch {
    /* quota or private mode — this session still behaves, it just won't survive a reload */
  }
}

const attachmentsFor = (id) => state.attachments[id] || [];

function clearDraft(sessionId) {
  delete state.drafts[sessionId];
  persistDrafts();
}

const el = {
  app: document.getElementById('app'),
  conn: document.getElementById('conn'),
  railStat: document.getElementById('railStat'),
  newSession: document.getElementById('newSession'),
  settings: document.getElementById('settings'),
  snapshot: document.getElementById('snapshot'),
  flatRail: document.getElementById('flatRail'),
  railQuota: document.getElementById('railQuota'),
  railList: document.getElementById('railList'),
  railFoot: document.querySelector('.rail-foot'),
  railRepo: document.getElementById('railRepo'),
  railVersion: document.getElementById('railVersion'),
  railGrip: document.getElementById('railGrip'),
  railShared: document.getElementById('railShared'),
  railSharedUnseen: document.getElementById('railSharedUnseen'),
  railRooms: document.getElementById('railRooms'),
  roomsAdd: document.getElementById('roomsAdd'),
  roomsList: document.getElementById('roomsList'),
  main: document.getElementById('main'),
  splitGrip: document.getElementById('splitGrip'),
};

/* ----------------------------------------------------------- resizers --- */

/**
 * One draggable divider, four of them on screen.
 *
 * The rail's right edge shipped first (#4) and this is that code generalised, not a
 * second copy of it: the rail, the connections band, the lead's aside, the Tasks/Room
 * split inside it and the boundary between two panes all want the same five things — a floor, a live ceiling, a preference remembered in this
 * browser, a double-click that forgets it, and a grip you can see. What differs is only
 * *which* number the pointer is asking for and where that number lands, so those two are
 * functions and everything else is shared.
 *
 * Four rules carried over from the rail, each of which was learned there:
 *
 * - **The preference and the applied size are two numbers.** The ceiling depends on the
 *   window — and, for the aside, on the pane it is in — so narrowing the window has to
 *   narrow the divider. It must not *overwrite* what you chose, or resizing a window for
 *   five seconds costs you the width you set on the big monitor. `applyNow` clamps; only
 *   a drag or a reset writes.
 * - **Nothing stored means the stylesheet answers.** A reset *removes* the custom
 *   property rather than writing the default back into it: two spellings of one default
 *   is how they drift.
 * - **Sizes are stored in rem**, so a browser text-size change carries them, and every
 *   read is wrapped. A browser with site data blocked has to render the panel, not throw
 *   at module scope and leave a blank page.
 * - **Nothing a drag moves may have a transition.** A width that eased into place lags
 *   the cursor, which reads as the drag having been dropped. The grip's own hover colour
 *   is the only thing here that animates, and reduced motion turns that off.
 *
 * A preference is keyed by its storage key rather than held on the instance, because
 * split view can mount two lead asides at once and two copies of one number is two
 * answers to "how wide did I make it".
 */

/** The root font size in px, read rather than assumed: preferences are stored in rem so
 *  they survive a browser text-size change, and this is what converts them. */
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/** Every mounted resizer. The rail's lives as long as the page; the aside's two are
 *  rebuilt whenever `renderMain` rebuilds the aside, so `applyResizers` prunes the ones
 *  whose handle has left the document rather than holding detached nodes for ever. */
const resizers = new Set();

/** storageKey → rem, or `null` for "never dragged". Read through once and then held, so
 *  a drag is not a `localStorage` round trip per pointermove. */
const prefs = new Map();

function readPref(key, min, max) {
  if (prefs.has(key)) return prefs.get(key);
  let value = null;
  try {
    const raw = Number(localStorage.getItem(key));
    // Anything unparseable, zero, negative or absurd falls back to the stylesheet's own
    // value rather than to a clamp of nonsense — a stored number nobody wrote is not a
    // preference. `localStorage.getItem` itself throws where site data is blocked, which
    // is why even this read is inside the try.
    if (Number.isFinite(raw) && raw >= min && raw <= max) value = raw;
  } catch {
    /* private mode, or storage denied — the default is a perfectly good answer */
  }
  prefs.set(key, value);
  return value;
}

function persistPref(key) {
  try {
    const value = prefs.get(key);
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(value * 100) / 100));
  } catch {
    /* quota or private mode — this window still behaves, it just won't survive a reload */
  }
}

/** Put a size on the page, or take the custom property off so `tokens.css` answers. */
function setRootVar(name, rem) {
  if (rem == null) document.documentElement.style.removeProperty(name);
  else document.documentElement.style.setProperty(name, `${rem}rem`);
}

/**
 * Make one divider draggable.
 *
 * `min`/`max` bound the *preference* — they are what a stored value has to look like to
 * be believed. `ceiling()` is the live bound this layout can actually afford right now,
 * re-asked on every move and every window resize, and never written down.
 */
function resizer({ handle, axis, storageKey, min, max, ceiling, measure, apply, onMove }) {
  if (!handle) return null;

  const bound = () => Math.max(min, Math.min(max, ceiling()));
  const clamped = () => {
    const pref = readPref(storageKey, min, max);
    return pref == null ? null : Math.min(Math.max(pref, min), bound());
  };

  const entry = {
    handle,
    applyNow() {
      if (!handle.isConnected) return false;
      apply(clamped());
      return true;
    },
  };

  let dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    // Left button only. A right-click here is the context menu and a middle-click is a
    // paste on some setups — neither should start a drag that only ends on pointerup.
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    // Capture, so the drag survives the pointer leaving the 7px strip — which it does
    // immediately, and which is the whole reason this is pointer events and not
    // mousemove on the document.
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add(axis === 'x' ? 'col-dragging' : 'row-dragging');
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    prefs.set(storageKey, Math.min(Math.max(measure(e) / remPx(), min), bound()));
    apply(clamped());
    onMove?.();
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* already released — the capture is gone either way */
    }
    handle.classList.remove('is-dragging');
    document.body.classList.remove('col-dragging', 'row-dragging');
    persistPref(storageKey);
    onMove?.();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  // Back to the size in the stylesheet, and forget the preference entirely — the way
  // every other reset-to-default in a browser behaves.
  handle.addEventListener('dblclick', () => {
    prefs.set(storageKey, null);
    persistPref(storageKey);
    apply(null);
    onMove?.();
  });

  resizers.add(entry);
  entry.applyNow();
  return entry;
}

/** A size stored on a wider screen has to shrink to fit this one; the preference itself
 *  is left alone, so it comes back when the window does. */
function applyResizers() {
  for (const entry of resizers) if (!entry.applyNow()) resizers.delete(entry);
}
window.addEventListener('resize', applyResizers);

/**
 * Build a grip: the strip you drag, and the mark that says you can.
 *
 * `role="separator"` with an `aria-orientation` is what a resizable divider is; the
 * class is a separate hook rather than an attribute selector, so restyling one never
 * depends on getting the ARIA right (and vice versa).
 */
function paneGrip(axis, label, title) {
  const grip = document.createElement('div');
  grip.className = `pane-grip ${axis === 'x' ? 'grip-col' : 'grip-row'}`;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  grip.setAttribute('aria-label', label);
  grip.title = title;
  return grip;
}

/* ------------------------------------------------------------ the rail --- */

/*
 * The rail's width, dragged from its right edge and remembered in this browser.
 *
 * One value drives everything: `--rail` is the first column of the `.app` grid, so the
 * main area — and both panes of a split, which share `1fr 1fr` of whatever is left —
 * follow from it with nothing else to keep in step. The default lives in `tokens.css`
 * and is the value used when nothing is stored.
 *
 * `localStorage` rather than the server, and for the same reason `foreman.flatRail` is:
 * this is a fact about the window you are looking at, not about your filing, and a phone
 * and a 34-inch monitor want different answers. A group's collapse state is on the server
 * because it is the other kind.
 */

/** rem. `RAIL_MAX` also bounds what a stored value may say; the live ceiling is below. */
const RAIL_MIN = 14;
const RAIL_MAX = 40;

resizer({
  handle: el.railGrip,
  axis: 'x',
  storageKey: 'foreman.railWidth',
  min: RAIL_MIN,
  max: RAIL_MAX,
  // Never more than half the viewport, so the rail can't swallow the conversation on a
  // laptop even when the stored width came from a wider screen.
  ceiling: () => window.innerWidth / remPx() / 2,
  // The rail starts at the viewport's left edge, so the pointer's x *is* the width it is
  // asking for.
  measure: (e) => e.clientX,
  apply: (rem) => setRootVar('--rail', rem),
  /*
   * The rail is the *other* thing that changes how wide the main area is, and until the
   * split had a divider of its own nothing downstream had a ceiling that depended on it.
   * Now one does: dragging the rail out narrows the frame the two panes divide, and the
   * split's stored width is a number that was clamped against the frame it was dragged in.
   *
   * Measured before this line existed, on a scratch panel at a 1470px window: a split of
   * 680/470 with the rail taken from 20rem to 40rem left the first pane holding its 680
   * and **the second at 150px** — 9.4rem, well under its own floor, because its ceiling
   * was never re-asked. A window resize has always gone through `applyResizers`; this is
   * the same event by another route, so it takes the same door.
   */
  onMove: applyResizers,
});

/* ------------------------------------------------ the split's boundary --- */

/**
 * How split view divides, dragged from the line the two panes meet at.
 *
 * The fourth divider, and the first with no edge of its own to hang off: the rail and the
 * aside each overhang a border something else already draws, while these two panes simply
 * abut at a line the grid computes. So the grip is *placed*
 * from the same `--pane-a` that sizes the first track — one number, two readers, no way
 * for the handle and the boundary to disagree. Everything else is the shared `resizer`:
 * rem in `localStorage`, a floor, a live ceiling, double-click to forget.
 *
 * **Only the first pane's width is stored.** The second takes `1fr` of what is left, which
 * is what makes the default cost nothing — `--pane-a` is `50%` in `tokens.css`, so a
 * reader who never drags gets the `1fr 1fr` the split has had since it shipped. It also
 * means a window that grows hands the new width to the second pane rather than splitting
 * it, which is the same answer `--rail` and `--aside` give: a dragged size is a size, not
 * a ratio.
 *
 * It applies to **every** split — two sessions side by side is the older and commoner case
 * — because nothing here knows or asks what a pane is holding.
 */

/**
 * rem. The floor either pane keeps, and the bound a stored value has to clear.
 *
 * Chosen from the case with the least room to give, which is a **team lead**: its pane
 * carries the room aside inside it, `.room-panel` holds a 15rem floor of its own, and the
 * conversation is whatever is left after that. Measured on a scratch panel in the dark
 * theme, a 1470px window, a lead beside an ordinary session — the aside is pinned to its
 * own floor at 240px from a 32rem pane downwards, so the conversation is simply the pane
 * less 240: **175px at a 26rem floor**, 207 at 28, 239 at 30, against 320px at plain half
 * and half on that window.
 *
 * The number is a trade against travel, not only against legibility, and that is what
 * settles it. It is symmetric, so twice it is what a frame must afford before the boundary
 * can move at all: 26rem a side is 52rem, which a 1280px window with the default rail
 * clears with 8rem of travel either way. The 30rem a lead would actually like leaves that
 * same window **exactly none**, and it would also cap what this feature exists to give —
 * on a 71.9rem frame it holds the first pane 96px short of where 26 lets it go.
 *
 * The thing it is deliberately *not* chosen from is the pane header, which stops fitting
 * far higher — 30rem for an ordinary pane, 34rem for a lead's, measured the same way — and
 * cannot be bought at any affordable floor. It overflows at plain half and half on any
 * window under about 1400px today, with nothing dragged, so it is not this divider's to
 * answer; see the report.
 *
 * What it deliberately does not do is vary by what the pane holds. A floor that jumped when
 * a pane changed session would be a control that moves under the hand, and the recovery
 * from a squeezed lead is already one double-click.
 */
const PANE_MIN = 26;
/** rem. Only a bound on what a stored number may say — an ultrawide can afford a first
 *  pane far wider than any other divider here, and the live ceiling is what actually
 *  stops the drag. */
const PANE_MAX = 160;

/** The frame the two panes divide, in rem. Zero before the panel has been laid out, which
 *  every caller here reads as "no answer yet" rather than as a width. */
function mainRem() {
  const width = el.main?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width / remPx() : 0;
}

/**
 * Whether this frame has room for the boundary to move at all.
 *
 * **Strictly** more than both floors, because two floors that exactly fill the frame leave
 * zero travel, and a divider that cannot move is the thing this predicate exists to catch.
 *
 * Two consequences, and they are the same fact from either end. The *preference is not
 * applied*: the custom property comes off, `tokens.css` answers `50%`, and the number the
 * reader chose is untouched and comes back when the window does — which is better than what
 * the shared `bound()` would otherwise produce here, a first pane at its floor beside a
 * second crushed under one, since a floor wins over a ceiling there. And the *grip is not
 * drawn*: a handle on a boundary that will not move reads as broken, and this panel's
 * standing preference is to show nothing rather than something wrong.
 *
 * That second half is why there is no narrow-viewport rule for this grip beside the rail's
 * and the band's. At phone width the rail is hidden and the frame *is* the viewport, so a
 * frame over 52rem is unreachable there and this predicate already covers it — while a
 * media query would miss the case it does not know about, a fat rail on a wide window.
 * One spelling, and the more accurate one.
 *
 * A frame of zero is a panel that has not been laid out yet, not a narrow one: the stored
 * width stands until something measurable happens. Same fallback the connections band's
 * ceiling makes for the same reason.
 */
const splitFits = () => {
  const frame = mainRem();
  return frame === 0 || frame > 2 * PANE_MIN;
};

resizer({
  handle: el.splitGrip,
  axis: 'x',
  storageKey: 'foreman.paneWidth',
  min: PANE_MIN,
  max: PANE_MAX,
  // Everything the frame has, less the floor the second pane keeps. Before the panel is
  // laid out there is no frame to measure and the preference's own `max` is a better
  // answer than a negative one.
  ceiling: () => (mainRem() > 0 ? mainRem() - PANE_MIN : PANE_MAX),
  // The first pane starts at the frame's left edge, so the pointer's distance from that
  // edge *is* the width it is asking for. The frame's own left, not the window's: the rail
  // is to the left of it and is itself draggable.
  measure: (e) => e.clientX - (el.main?.getBoundingClientRect().left ?? 0),
  apply: (rem) => {
    const fits = splitFits();
    // CSS cannot ask whether a frame is wide enough to bother with, and a second variable
    // saying so would be a second source of truth about one fact — `.room-sized` on the
    // root, one divider over, for exactly the same reason.
    document.documentElement.classList.toggle('split-fixed', !fits);
    setRootVar('--pane-a', fits ? rem : null);
  },
  // Both panes change width here, so anything inside one that was measured at the old
  // width is now stale: the Tasks block's five-row cap is a height in pixels taken from
  // rows that wrap differently in a narrower aside, and a room pinned to its newest line
  // drifts off the bottom as its own text rewraps. Not in `apply`, which also runs at
  // module load before there is a pane to ask — and a window resize has never re-taken
  // either of these, which is unchanged by this divider existing.
  onMove: () => {
    recapTaskLists();
    pinRooms();
  },
});

/* ------------------------------------------------- the lead's two edges --- */

/** rem. The aside's floor and the ceiling on a stored value; the live ceiling is the
 *  pane's own width less `LEAD_LEFT_MIN`, so the transcript never collapses. Mirrored in
 *  `.room-panel`'s `min-width`/`max-width`, which is the per-pane guarantee — see there. */
const ASIDE_MIN = 15;
const ASIDE_MAX = 40;
const LEAD_LEFT_MIN = 20;

/**
 * rem. Either side of the one internal split in the aside — see `the room's own height`
 * below for which block now holds the dragged number and why. `ROOM_MAX` bounds a stored
 * value; what the panel can actually afford is measured off it at drag time.
 */
const TASKS_MIN = 3;
const ROOM_MIN = 8;
const ROOM_MAX = 60;

/** How many task rows the block shows before it stops growing and scrolls. */
const TASKS_VISIBLE = 5;

/**
 * Stop the block growing at five rows. The maintainer ran seven tasks in one evening and
 * the list pushed the room off the bottom of the panel; a long-lived team has dozens.
 *
 * Measured rather than declared, because a task row is one line or two — the branch
 * line only exists once a worktree does — so "five rows" has no fixed height. The cut
 * is taken from the sixth row's own top: five rows, four gaps, the list's padding,
 * and nothing of the sixth. Reading a rect forces layout, which is the point — this
 * runs synchronously inside the paint that appended the rows, never behind a
 * `requestAnimationFrame`, which an automated Chrome window never fires because it
 * reports `visibilityState: 'hidden'` (see CLAUDE.md).
 *
 * Under six rows nothing is set at all: an empty scroll gutter on a three-task team
 * is worse than the problem this solves.
 */
function capTaskList(list, nodes) {
  list.style.maxHeight = '';
  // A dragged divider is an explicit answer to the question this cap is guessing at, so it
  // wins outright: the room holds the height it was given, the Tasks block takes what is
  // left, and the five-row cut is not taken at all. Leaving the cut on as well would pin
  // the block at five rows and leave dead space between it and a room somebody had just
  // deliberately made shorter. The key is the *room's* now — the number moved blocks when
  // the divider became the room's grip, and this is the one other place that reads it.
  if (readPref('foreman.roomHeight', ROOM_MIN, ROOM_MAX) != null) {
    list.classList.remove('is-capped');
    return;
  }
  list.classList.toggle('is-capped', nodes.length > TASKS_VISIBLE);
  if (nodes.length <= TASKS_VISIBLE) return;
  const cs = getComputedStyle(list);
  const gap = parseFloat(cs.rowGap) || 0;
  const pad = parseFloat(cs.paddingBottom) || 0;
  const top = list.getBoundingClientRect().top;
  const cut = nodes[TASKS_VISIBLE].getBoundingClientRect().top;
  const height = cut - top - gap + pad;
  // A zero here means the block was not laid out (hidden pane, display:none); leave
  // the class's own fallback height in charge rather than writing a nonsense cap.
  if (height > 0) list.style.maxHeight = `${Math.ceil(height)}px`;
}

/**
 * Re-take the cap on every Tasks block on the page.
 *
 * The dragged height and the five-row cut are two answers to one question, so whichever
 * is in force the other must not be left on the element — and the cut can only be
 * *re-taken* from the rows, which is why this reads them back off the DOM rather than
 * asking each pane to repaint. Split view can hold two lead asides and a reset in one of
 * them is a reset in both, `--room-h` being one number for the browser.
 */
function recapTaskLists() {
  for (const box of document.querySelectorAll('.team-tasks')) {
    capTaskList(box, [...box.querySelectorAll(':scope > .team-task')]);
  }
}

/**
 * Re-pin every room on the page, for a height change that was not a drag.
 *
 * `pinRoom` is per pane because `follow` is per pane — it is an *intention*, flipped only
 * by a real scroll, and it is not readable off the DOM. So this asks each pane rather than
 * walking `.room-list` nodes and guessing, which would scroll a room the reader had
 * deliberately scrolled up in.
 *
 * Split view can hold two lead asides and one number sizes both, which is the same reason
 * `recapTaskLists` above exists and reads the page rather than one pane.
 */
function pinRooms() {
  for (const pane of panes) pane.pinRoom?.();
}

/**
 * Repaint every lead aside's TASKS block, for a change that is not about one pane's data.
 *
 * There is exactly one such change: the `hide finished` filter, which lives in this
 * browser rather than in a pane. Split view can hold two lead asides — two different
 * repos, even — and the filter is one answer for the browser, so pressing it in one aside
 * has to reach the other or the two disagree about a fact neither of them owns.
 *
 * Same shape as `recapTaskLists` and `pinRooms` above, and asking each pane rather than
 * walking `.team-tasks` nodes for the same reason `pinRooms` does: the rows have to be
 * rebuilt from the pane's own task list, and the repaint has to go through `renderTasks`
 * so the scroll hold, the confirm disarm, the cap and the re-pin all still happen.
 */
function renderTaskLists() {
  for (const pane of panes) pane.renderTasks?.();
}

/**
 * How long the aside's fold takes, in milliseconds.
 *
 * Spelled here and in `.room-panel.is-folding`'s transition. It is out here rather than
 * inside the factory with the panel it times because **two** backstops read it: the one that
 * takes `is-folding` off and runs the remeasure, inside `createPane`, and the auto-collapse's
 * own, which is what starts a room sliding in when `transitionend` never arrives. A second
 * spelling of a duration is what this file keeps refusing.
 *
 * 200 is not a fresh choice. It is the number this panel already animates a layout at — the
 * settings fold before it, the room slot's `ROOM_FOLD_MS` after it — and a second duration
 * beside them would read as a second mechanism.
 */
const ASIDE_FOLD_MS = 200;

/**
 * Fold — or unfold — every lead aside on the page.
 *
 * `asideFolded` is one answer for the browser, `hideFinished`'s shape and `--aside`'s, so a
 * chevron pressed in one aside has to reach the other or two panes disagree about a fact
 * neither of them owns. This is `renderTaskLists`' shape one preference over, and it asks
 * each pane rather than walking `.room-panel` nodes for the same reason: the fold has to run
 * through the pane's own animation, which measures, freezes a body, clears a counter and
 * remeasures at the end — none of which is readable off a class name.
 *
 * Module scope holds the *preference* and this fan-out. The applied class lives on each
 * pane's own node, which is the rule about per-pane state in module scope, one level up.
 */
function foldAsides() {
  for (const pane of panes) pane.foldAside?.();
}

/* --------------------------------------------------------- rail footer --- */

/**
 * Fill the rail's footer from the server's own answer.
 *
 * `GET /api/config` is where the version and the repository live, derived from
 * `package.json` by `server/config.js` — nothing under `web/` spells either, so a fork or
 * a version bump reaches the footer without anybody remembering this file exists.
 *
 * It fails silently and on purpose. The footer is chrome; a panel whose boot fetch failed
 * still has a rail full of sessions, and an error banner over a missing version number
 * would be the loudest thing on the screen for the least reason. What is left is the mark
 * with no link, which `styles.css` already draws as a wordmark rather than as a dead one.
 */
async function fillRailFooter() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.repoUrl) {
      el.railRepo.href = cfg.repoUrl;
      el.railRepo.title = `Foreman on ${new URL(cfg.repoUrl).host}`;
    }
    if (cfg.version) {
      el.railVersion.textContent = `v${cfg.version}`;
      el.railVersion.title = `This panel is running Foreman ${cfg.version}`;
    }
  } catch {
    /* offline, or the panel went away mid-boot — the rail is the part that matters */
  }
}

/* ------------------------------------------------------- notifications --- */

/**
 * A system notification when something needs a human, opt-in and off by default.
 *
 * The decision — what counts, and when it became true — is `web/notify.js`, which is pure
 * and tested in node. This is the wiring: the browser's permission, the remembered opt-in,
 * and the one place a `Notification` is actually constructed.
 *
 * **Three gates, and all three have to be open before anything fires.** The API has to
 * exist; the page has to be a secure context; and the browser has to have granted
 * permission. They are separate because they fail for different reasons and a reader
 * deserves to be told which — `notifyReason` below is what the settings box prints, and
 * the issue asked for exactly that rather than a control that silently does nothing.
 *
 * The secure-context one is the interesting gate. `http://127.0.0.1` counts as secure by
 * specification and `http://<a LAN address>` does not, so this works in the panel opened on
 * the Mac it runs on and cannot work from the phone or another machine — which follows
 * from the 2026-08-27 ruling rather than being a gap in it: the panel is plain `http://`
 * on the LAN deliberately, and nothing here should be an argument for changing that.
 */
const notifier = {
  /** `null` until the first roster frame — see `step`, which treats that frame as a baseline. */
  marks: null,
  enabled: loadFlag('foreman.notify'),
};

const notifySupported = () => typeof Notification !== 'undefined' && window.isSecureContext;

/** `granted` is the only word that arms anything; the other two are shown, not assumed. */
const notifyPermission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

const notifyArmed = () => notifier.enabled && notifySupported() && notifyPermission() === 'granted';

/**
 * Why this browser cannot do it, in words a reader can act on — or `null` when it can.
 *
 * The address is read off `location` rather than asserted, because "open it at 127.0.0.1"
 * is only useful advice next to where they actually are.
 */
function notifyReason() {
  if (typeof Notification === 'undefined') {
    return 'This browser has no notifications API. Safari and Chrome on the Mac do; Safari on iOS does not.';
  }
  if (!window.isSecureContext) {
    return (
      `Notifications need a secure context and this page is at ${location.origin}. ` +
      `Open the panel at http://127.0.0.1:${location.port || '48770'} on the Mac it runs on — ` +
      `loopback counts as secure, a LAN address over plain http does not.`
    );
  }
  if (Notification.permission === 'denied') {
    return 'This browser is blocking notifications for this page. Turn them back on in its site settings — asking again from here will not prompt.';
  }
  return null;
}

/**
 * Turn it on, from a click and only from a click.
 *
 * `Notification.requestPermission()` is only allowed to prompt from a user gesture, so this
 * is called straight out of the checkbox's own handler and never from a roster frame, a
 * timer, or the boot. Returns what happened so the box can say it.
 */
async function notifyEnable() {
  if (!notifySupported()) return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return 'unsupported'; // an older callback-only implementation, or a browser refusing outright
    }
  }
  if (permission !== 'granted') return permission; // 'denied', and the browser will not ask again
  notifier.enabled = true;
  notifyPersist();
  return 'granted';
}

function notifyDisable() {
  notifier.enabled = false;
  notifyPersist();
}

function notifyPersist() {
  try {
    localStorage.setItem('foreman.notify', notifier.enabled ? '1' : '0');
  } catch {
    /* storage blocked — this window still behaves, the answer just won't survive a reload */
  }
}

/**
 * Show one, and make clicking it worth something.
 *
 * A notification you can only dismiss is an interruption with no exit; this one focuses
 * the window and opens the session it is about, which is the whole action you were going
 * to take anyway. Wrapped because constructing a `Notification` throws in more situations
 * than the three gates cover — a browser with the API present and the feature disabled by
 * policy among them — and a throw here is inside the socket's message handler, where it
 * would take the roster render down with it.
 */
function notifyShow(alert) {
  const { title, body, tag } = alertText(alert);
  try {
    const n = new Notification(title, {
      body,
      tag,
      // Without this a replacement on the same tag arrives silently, which for a genuinely
      // new transition on a session you already had a notification for is the same as not
      // arriving at all.
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-32.png',
    });
    n.onclick = () => {
      window.focus();
      if (state.sessions.some((s) => s.id === alert.id)) openSession(alert.id);
      n.close();
    };
  } catch {
    /* the browser declined to construct it — nothing to recover, and nothing to break */
  }
}

/**
 * Every roster frame, armed or not.
 *
 * The marks are kept up to date even with the opt-in off, which is the point: turning it
 * on should not then announce everything that was already sitting there, and a baseline
 * taken at the moment of the click would still miss nothing. `step` is what decides; this
 * only decides whether to show.
 */
function notifyRoster(sessions) {
  const { marks, alerts } = step(notifier.marks, sessions);
  notifier.marks = marks;
  if (!notifyArmed()) return;
  for (const alert of alerts) notifyShow(alert);
}

/* ---------------------------------------------------------- websocket --- */

let ws = null;
let retry = 0;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
    el.conn.style.color = 'var(--idle)';
    // Every open pane asks for its transcript again. A subscription is server state — the
    // tailer holding a file offset — so a dropped socket, or a server restart, takes it
    // with it. The roster keeps arriving either way (it's broadcast to every client), so
    // the rail stays alive and honest while the transcript quietly stops at the moment
    // the socket died. This read as "the panel disagrees with the terminal", and it is
    // the one failure mode the panel cannot see from the inside.
    for (const pane of panes) pane.resubscribe();
  };

  ws.onclose = () => {
    el.conn.style.color = 'var(--decision)';
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 400 * 2 ** retry);
  };

  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  // Everything except the roster belongs to one pane. The slot says which; a message
  // without one is for the pane that asked, which is how a single-pane panel behaved
  // before there were two.
  if (msg.type === 'sessions') {
    state.sessions = msg.sessions;
    if (msg.groups) state.groups = msg.groups;
    if (msg.snapshot) state.snapshot = msg.snapshot;
    // `in`, not a truth test, and for a reason of its own:
    // `null` is what the frame carries until a status line has posted anything, so a truth
    // test would pin the last record on screen for ever once one had arrived. Keyed on the
    // field being present at all so a frame from a panel that predates it leaves whatever
    // we have alone rather than blanking it.
    if ('rateLimits' in msg) state.rateLimits = msg.rateLimits;
    // `in`, not a truth test, for `rateLimits`' reason one line up: a summary of
    // `{unseen: 0, lastAt: null}` is the ordinary answer for a room nothing has been said
    // in yet, and a truth test would read that as "the frame didn't mention it" and pin
    // whatever was on screen last. Keyed on presence so a frame from a panel that predates
    // the field leaves what we have alone rather than blanking it.
    if ('sharedRoom' in msg) state.sharedRoom = msg.sharedRoom || { unseen: 0, lastAt: null };
    // `in`, not a truth test, for `sharedRoom`'s reason one line up and then the sharpest
    // version of it: **an empty array is the ordinary answer here**, because most of the
    // time there are no rooms at all, and a truth test would read that as "the frame did not
    // mention it" and pin whatever the band last drew — including rows for rooms that have
    // since been deleted. `rateLimits` learned this the expensive way. `Array.isArray` inside
    // the guard so a malformed frame draws an empty band rather than throwing in `renderRail`.
    if ('rooms' in msg) state.rooms = Array.isArray(msg.rooms) ? msg.rooms : [];
    // Before the render, so a notification is never held up behind a rail repaint — and
    // before `adopt`, which can change what is on screen but never what happened.
    notifyRoster(msg.sessions);
    for (const pane of panes) pane.adopt();
    renderRail();
    renderQuota();
    for (const pane of panes) pane.renderHead();
    return;
  }

  // A restore reports each session as it comes up — it takes a minute and there is a
  // dialog watching. Belongs to no pane, so it has to be caught before the slot routing.
  if (msg.type === 'restore') {
    onRestoreStep?.(msg);
    return;
  }

  // A relaunch reports twice per session — once when it closes, once when it comes back —
  // so the dialog can show the middle of the operation rather than a spinner over a bench
  // that is, right then, actually down.
  if (msg.type === 'relaunch') {
    onRelaunchStep?.(msg);
    return;
  }

  const pane = panes.find((p) => p.slot === msg.slot) || panes[0];
  if (!pane) return;
  pane.receive(msg);
}

/* -------------------------------------------------------------- rail --- */

/*
 * Rows show the full session label — the same name the session was launched with.
 * An earlier version trimmed the project prefix under its heading, on the theory that
 * `ALPHA / alpha-main` was redundant. It isn't: nearly every project has a session
 * called `main`, so the rail became a column of identical rows and nothing was
 * scannable. The whole name is the name.
 */

/**
 * Context pressure, one rule shared by the rail and the header so they can't drift:
 * under 50% is fine, 50–70% is worth noticing, above that it's getting tight.
 */
function ctxTone(pct) {
  if (pct == null) return '';
  if (pct < 50) return 'ctx-ok';
  if (pct <= 70) return 'ctx-warn';
  return 'ctx-hot';
}

function ctxEl(pct) {
  const el = document.createElement('span');
  el.className = `ctx ${ctxTone(pct)}`;
  el.textContent = `${pct}%`;
  el.title = `${pct}% of the context window used`;
  return el;
}

/**
 * Effort, read off the footer. Colour tracks the scale rather than danger — it is a
 * setting, not a warning: quieter as it drops, brighter as it climbs.
 */
function effortEl(level) {
  const el = document.createElement('span');
  el.className = `effort effort-${level}`;
  el.textContent = level;
  el.title = `Effort: ${level}`;
  return el;
}

/**
 * "Opus 5 (1M context)" -> "Opus 5" — the rail has no room for the parenthetical.
 *
 * A roster row can arrive with no model at all: it is scraped off the composer footer, and
 * a session holding a question box has no footer to scrape. Both composer callers already
 * wrote `shortModel(s.model) || 'model'`, expecting a blank — and got a `TypeError` that
 * unwound `buildComposer` from inside, taking the question card and the textarea with it.
 * A session asking you something was the one session you could not answer.
 */
function shortModel(model) {
  if (!model) return '';
  return model.replace(/\s*\(.*\)\s*$/, '').trim();
}

function relativeTime(ms) {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/**
 * How long a session has been working, compact enough for the rail's duration column —
 * not `relativeTime`: that answers "when did this last move" and buckets anything under a
 * minute as `now`, which is exactly the range a working row spends most of its life in.
 * `18s`, `47s`, `2m`, `47m`, `1h20m` — never more than five characters at any plausible
 * duration, matching the column `now`/`47m` already fits in.
 */
function formatWorkingDuration(totalSeconds) {
  const s = Math.floor(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 10) return `${h}h${m % 60}m`;
  return `${h}h`;
}

/** `Deciphering… 16m 10s` — the composer keeps full precision; the rail rounds instead. */
function formatElapsedFull(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

/**
 * Pin a session to the top of the rail, or release it.
 *
 * Flipped locally before the request goes, because the roster is up to a poll behind and a
 * star that waits two seconds to fill in reads as a click that missed.
 *
 * **The answer is read, and that is new.** This used to end `.catch(() => {})`, on the
 * reasoning that the next broadcast overwrites the local flip either way — true, and
 * exactly the problem now that there is something to refuse: a rejected un-pin flipped the
 * star and then flipped it back a second later with nothing on screen saying why. "Just
 * not working" is precisely what a refusal must not look like. The 409 carries the state
 * the server is holding, so the star goes back to that rather than to the one we
 * optimistically wrote, and the server's own sentence says why.
 *
 * Nothing in the panel draws a pin refused in advance today — the one thing that ever did
 * was a link holding a lead's star, retired on 2026-09-05, and the server-side refusal is
 * item 4's to remove. The reading stays either way: a refusal this client cannot anticipate
 * is exactly the case it has to be able to show.
 */
async function togglePin(s) {
  const was = Boolean(s.pinned);
  s.pinned = !was;
  renderRail();

  let res;
  let data = {};
  try {
    res = await fetch(`/api/sessions/${s.id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: s.pinned }),
    });
    data = await res.json().catch(() => ({}));
  } catch {
    // The panel is unreachable, so the roster has stopped too and nothing is coming to
    // correct the star. Put it back and say nothing: the connection dot already has.
    s.pinned = was;
    renderRail();
    return;
  }
  if (res.ok) return;

  s.pinned = data.pinned === undefined ? was : Boolean(data.pinned);
  renderRail();
  for (const pane of panes) pane.renderHead(); // the header carries the same star
  toast(data.error || 'That pin could not be changed.');
}

/* -------------------------------------------------------------- toast --- */

/** The one transient notice on screen, or null. */
let toastState = null;

/** How long a notice sits there — long enough to read a sentence twice. */
const TOAST_MS = 9000;

/**
 * A sentence the panel owes you, with nowhere else to put it.
 *
 * Everything else in here that reports a refusal is anchored to the control that was
 * pressed: the composer's note, the merge block's held error, a modal's error line. The
 * rail's star has no such surface — it is one glyph in a list that repaints on every roster
 * beat, and a sentence painted onto that row would be detached and gone before it was read.
 * That is `mergeErrors`' own lesson (a 409 rendered into a tree a concurrent repaint had
 * already replaced, seen by nobody), so this lives outside the rail entirely, holds itself,
 * and dismisses on a click or on its own.
 *
 * One at a time, deliberately: a stack of these would be a second inbox, and the panel
 * already has one.
 */
function toast(text) {
  if (toastState) {
    clearTimeout(toastState.timer);
    toastState.node.remove();
    toastState = null;
  }
  const node = document.createElement('div');
  node.className = 'panel-toast';
  node.setAttribute('role', 'status');
  const body = document.createElement('span');
  body.className = 'panel-toast-text';
  body.textContent = text;
  const close = document.createElement('button');
  close.className = 'panel-toast-close';
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Dismiss';
  const dismiss = () => {
    if (toastState?.node !== node) return;
    clearTimeout(toastState.timer);
    toastState = null;
    node.remove();
  };
  close.onclick = dismiss;
  node.append(body, close);
  document.body.append(node);
  toastState = { node, timer: setTimeout(dismiss, TOAST_MS) };
}

/**
 * `/abs/path/to/alpha` → `alpha`. Every face shows this; every record stores the path.
 *
 * Its one live caller is `roomLinkPill`, which names the project a historical
 * `kind: 'link'` room entry came from — see its own comment for why those entries are
 * still drawn long after the feature that wrote them was retired.
 */
const projectName = (p) => String(p || '').split('/').filter(Boolean).at(-1) || String(p || '');

/* ------------------------------------------------------- new session --- */

/**
 * Start a session the way the other launcher on this Mac starts one.
 *
 * The fields are its accessory view — a label, and the never-sticky skip-permissions
 * opt-in — and `Choose folder & start` hands off to the real Finder chooser on the Mac,
 * whose own button is what commits. Same gesture, same order, same consequences.
 *
 * The third field is the panel's own: that launcher always opens a Terminal window, and a
 * session you only ever talk to from here doesn't need one cluttering the desktop. It
 * stays ticked by default because a window is what every launch has done until now, and a
 * headless session with no way back to a terminal would be a worse default than noise.
 */
function openNewSession() {
  const back = document.createElement('div');
  back.className = 'modal-back';

  const box = document.createElement('div');
  box.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = 'New session';
  box.append(h);

  const labelCap = document.createElement('label');
  labelCap.className = 'field-cap';
  labelCap.textContent = 'Label (optional)';
  const label = document.createElement('input');
  label.type = 'text';
  label.placeholder = 'e.g. frontend';
  label.maxLength = 40;
  labelCap.append(label);
  box.append(labelCap);

  const hint = document.createElement('p');
  hint.className = 'field-hint';
  hint.textContent =
    'Distinguishes several sessions in one folder, and names the session. Blank auto-numbers.';
  box.append(hint);

  // A lead is not a variant of a session — it is a different thing wearing the same
  // launcher. Ticking this hands the folder a team: the label is forced to `lead` (one
  // per project, refused server-side), bypass is off the table, and the session arrives
  // with its brief, its tools and a read-only view of the code.
  const leadCap = document.createElement('label');
  leadCap.className = 'field-check';
  const lead = document.createElement('input');
  lead.type = 'checkbox';
  leadCap.append(lead, document.createTextNode('Team lead'));
  box.append(leadCap);

  const leadHint = document.createElement('p');
  leadHint.className = 'field-hint';
  leadHint.textContent =
    'Coordinates workers on this project instead of writing code itself. One per project; ' +
    'named “lead”, pinned, and unable to edit files or commit.';
  box.append(leadHint);

  const termCap = document.createElement('label');
  termCap.className = 'field-check';
  const term = document.createElement('input');
  term.type = 'checkbox'; // off by default now — see decisions.md, not a bug to "restore"
  termCap.append(term, document.createTextNode('Open a Terminal window'));
  box.append(termCap);

  const termHint = document.createElement('p');
  termHint.className = 'field-hint';
  termHint.textContent =
    'Unticked, it runs in tmux only — nothing on the desktop to look at. The session header ' +
    'grows a button to open one later.';
  box.append(termHint);

  const skipCap = document.createElement('label');
  skipCap.className = 'field-check';
  const skip = document.createElement('input');
  skip.type = 'checkbox'; // off every time: this is opt-in per session, never remembered
  skipCap.append(skip, document.createTextNode('Skip all permission prompts (dangerous)'));
  box.append(skipCap);

  const danger = document.createElement('p');
  danger.className = 'field-hint';
  danger.textContent = "Claude won't ask before running commands or editing files.";
  box.append(danger);

  let savedLabel = '';
  lead.onchange = () => {
    if (lead.checked) {
      savedLabel = label.value;
      label.value = 'lead';
      label.disabled = true;
      skip.checked = false;
      skip.disabled = true; // a bypass lead is not a thing
    } else {
      label.value = savedLabel;
      label.disabled = false;
      skip.disabled = false;
    }
  };

  const note = document.createElement('p');
  note.className = 'modal-note';
  box.append(note);

  const row = document.createElement('div');
  row.className = 'modal-row';
  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = 'cancel';
  const start = document.createElement('button');
  start.className = 'ghost-btn primary';
  start.textContent = 'Choose folder & start…';
  row.append(cancel, start);
  box.append(row);

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  cancel.onclick = close;
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };
  document.addEventListener('keydown', onKey, true);

  const say = (text, cls = '') => {
    note.className = `modal-note ${cls}`;
    note.textContent = text;
  };

  start.onclick = async () => {
    start.disabled = true;
    say('Waiting for the folder chooser on the Mac…');
    try {
      const chosen = await postJSON('/api/launch/folder', {});
      if (chosen.cancelled) {
        say('');
        start.disabled = false;
        return;
      }
      say(`Starting claude in ${chosen.path}…`);
      const made = await postJSON('/api/launch', {
        folder: chosen.path,
        label: label.value.trim() || null,
        skipPermissions: skip.checked,
        terminal: term.checked,
        lead: lead.checked,
      });
      close();
      // Show it straight away. A brand-new pane has no transcript yet, so it arrives as a
      // pane-only session and earns its real id the moment it first speaks.
      if (made.sessionId) openSession(made.sessionId);
    } catch (err) {
      say(err.message, 'err');
      start.disabled = false;
    }
  };

  back.append(box);
  document.body.append(back);
  label.focus();
}

async function postJSON(url, body) {
  return postJSONMethod('POST', url, body);
}

async function postJSONMethod(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `That didn't take (${res.status}).`);
  return data;
}

/* ---------------------------------------------------------- settings --- */

/**
 * `<STATE_DIR>/config.json`, in a box.
 *
 * Three things, and only three: **who can reach the panel** (`bindHost`), **which extra
 * browser origins may write to it** (`allowedOrigins`), and the **session prefix**, which
 * is shown and cannot be changed here. Everything else that lives in that file, and every
 * per-repo team toggle, has its own surface already — the lead's aside — and duplicating a
 * control is how two surfaces start disagreeing about what is true.
 *
 * **No credentials field, and there will never be one.** The forge is detected from the
 * repo's own origin and from what is registered in `~/.claude.json`, never typed in here:
 * a token in a world-readable JSON behind a panel with no authentication is a worse
 * liability than any convenience it buys. If you are here to add "just an API key box",
 * that is the ruling you are arguing with.
 *
 * **This is a modal on its own beat, and that is deliberate** (`CLAUDE.md`'s
 * `composerSig` trap). Nothing about it is joined to the composer's signature or repainted
 * on the roster beat — a settings box torn down and rebuilt under somebody's cursor every
 * two seconds would be unusable, and the values behind it change only when this box writes
 * them.
 *
 * Desktop only. The phone (`web/m/`) is the lead's view by ruling and gets none of this —
 * which is also the case that matters most here, because a phone is exactly the client
 * that cannot change the exposure keys anyway.
 */
async function openSettings() {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal is-settings';

  const h = document.createElement('h2');
  h.textContent = 'Panel settings';
  const body = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'modal-note';
  const row = document.createElement('div');
  row.className = 'modal-row';
  box.append(h, body, note, row);

  let saving = false;
  const close = () => {
    if (saving) return;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey, true);
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };

  const say = (text, cls = '') => {
    note.className = `modal-note ${cls}`;
    note.textContent = text;
  };

  back.append(box);
  document.body.append(back);

  let cfg;
  try {
    const res = await fetch('/api/config');
    cfg = await res.json();
    if (!res.ok) throw new Error(cfg.error || `Could not read the settings (${res.status}).`);
  } catch (err) {
    say(err.message, 'err');
    const only = document.createElement('button');
    only.className = 'ghost-btn';
    only.textContent = 'close';
    only.onclick = close;
    row.append(only);
    return;
  }

  // The server's answer, not the browser's guess. A page loaded over `http://127.0.0.1`
  // and one loaded over a LAN address are the same file; only the socket the request
  // arrived on tells them apart, and only the server can see that.
  const canEdit = Boolean(cfg.canEditExposure);
  const fileHost = cfg.bindHost || '';
  const envWins = cfg.live?.hostSource === '$FOREMAN_HOST';

  /* ── the refusal, first, because it explains every disabled control below it ── */

  if (!canEdit) {
    const locked = document.createElement('div');
    locked.className = 'settings-locked';
    const lh = document.createElement('p');
    lh.className = 'settings-locked-head';
    lh.textContent = 'Read-only from here';
    const lp = document.createElement('p');
    lp.textContent =
      `The two settings that decide who can reach this panel can only be changed from the ` +
      `machine it runs on. This browser reached it from ${cfg.remoteAddress || 'an address the panel could not read'}. ` +
      `Open the panel at http://127.0.0.1:… on that Mac to change them. ` +
      `Everything else the panel does is open to you — this is the one setting that decides who else it is open to.`;
    locked.append(lh, lp);
    body.append(locked);
  }

  /* ────────────────────────────────────────────── who can reach the panel ── */

  const bindSec = document.createElement('section');
  bindSec.className = 'settings-sec';
  const bindCap = document.createElement('h3');
  bindCap.textContent = 'Who can reach this panel';
  bindSec.append(bindCap);

  const NAME = 'foreman-bind-host';
  const choices = [];

  /** One radio row: a label, its own hint under it, and nothing clever. */
  const choice = (value, title, hint) => {
    const wrap = document.createElement('label');
    wrap.className = 'settings-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = NAME;
    input.value = value;
    input.disabled = !canEdit;
    const text = document.createElement('span');
    const strong = document.createElement('span');
    strong.className = 'settings-choice-title';
    strong.textContent = title;
    text.append(strong);
    if (hint) {
      const p = document.createElement('span');
      p.className = 'settings-choice-hint';
      p.textContent = hint;
      text.append(p);
    }
    wrap.append(input, text);
    bindSec.append(wrap);
    choices.push({ value, input, wrap });
    return input;
  };

  const loopback = choice(
    '127.0.0.1',
    'This machine only — 127.0.0.1',
    'The panel answers nothing but this Mac. Nothing on the network can reach it, including your phone.',
  );
  const wide = choice(
    '0.0.0.0',
    'Every interface — 0.0.0.0',
    'Hands everything the panel can do — typing into any session, launching and closing them, ' +
      'answering permission prompts, reading every transcript — to every peer that can reach that ' +
      'interface. 0.0.0.0 is every network this Mac ever joins, not just home wifi. There is no ' +
      'password in front of it. See SECURITY.md.',
  );
  wide.closest('.settings-choice').classList.add('is-wide-bind');
  const other = choice('other', 'A specific address', 'One address this Mac holds — an IPv4 or IPv6 literal, never a host name.');

  const otherWrap = document.createElement('div');
  otherWrap.className = 'settings-other';
  const otherIn = document.createElement('input');
  otherIn.type = 'text';
  otherIn.placeholder = '10.0.0.4';
  otherIn.spellcheck = false;
  otherIn.autocapitalize = 'off';
  otherIn.disabled = !canEdit;
  otherWrap.append(otherIn);
  bindSec.append(otherWrap);

  const preset = ['127.0.0.1', '0.0.0.0'];
  if (fileHost && preset.includes(fileHost)) {
    choices.find((c) => c.value === fileHost).input.checked = true;
  } else if (fileHost) {
    other.checked = true;
    otherIn.value = fileHost;
  } else {
    // No key in the file at all. Show the default selected rather than nothing — but the
    // line under the section says it is the default and not a recorded answer.
    choices.find((c) => c.value === (cfg.defaults?.bindHost || '127.0.0.1')).input.checked = true;
  }

  const syncOther = () => {
    otherWrap.classList.toggle('is-on', other.checked);
    otherIn.disabled = !canEdit || !other.checked;
  };
  syncOther();

  const chosenHost = () => (other.checked ? otherIn.value.trim() : choices.find((c) => c.input.checked)?.value || '');

  /* The two lines under the section that stop this control lying about itself. */

  const envLine = document.createElement('p');
  envLine.className = 'settings-flag';
  if (envWins) {
    envLine.textContent =
      `Right now the environment sets this: $FOREMAN_HOST is ${cfg.live.host}, and it beats the file. ` +
      `Saving here records your answer but changes nothing until the LaunchAgent is reinstalled ` +
      `(npm run install-agent) — a plain restart re-reads the file, not the job.`;
    bindSec.append(envLine);
  } else if (!fileHost) {
    envLine.textContent =
      `The file records no bind host, so the panel is using the default (${cfg.defaults?.bindHost}). ` +
      `Saving writes it down.`;
    bindSec.append(envLine);
  }

  const restartLine = document.createElement('p');
  restartLine.className = 'settings-flag is-restart';
  bindSec.append(restartLine);

  const syncRestart = () => {
    const next = chosenHost();
    // Only a value that actually moved. Re-selecting what is already recorded must not
    // tell somebody to restart for nothing — same rule the endpoint applies to `changed`.
    restartLine.textContent =
      next && next !== fileHost
        ? 'Takes effect at the next restart (npm run restart-panel) — the bind host is read when the panel starts.'
        : '';
  };
  syncRestart();

  for (const c of choices) {
    c.input.onchange = () => {
      syncOther();
      syncRestart();
      if (c.value === 'other') otherIn.focus();
    };
  }
  otherIn.oninput = syncRestart;

  body.append(bindSec);

  /* ──────────────────────────────────────────────── extra browser origins ── */

  const origSec = document.createElement('section');
  origSec.className = 'settings-sec';
  const origCap = document.createElement('h3');
  origCap.textContent = 'Extra browser origins';
  const origHint = document.createElement('p');
  origHint.className = 'settings-flag';
  origHint.textContent =
    'Pages at these origins may send writes. Loopback on any port, this Mac’s own private-LAN ' +
    'addresses and its .local name are already allowed and need no entry. This is a browser guard, ' +
    'not a password — it does nothing about a peer holding curl.';
  origSec.append(origCap, origHint);

  const list = document.createElement('div');
  list.className = 'settings-list';
  origSec.append(list);

  const origins = [...(cfg.allowedOrigins || [])];

  const renderOrigins = () => {
    list.replaceChildren();
    if (!origins.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-empty';
      empty.textContent = 'None. Nothing beyond the addresses above may write from a browser.';
      list.append(empty);
      return;
    }
    for (const [i, origin] of origins.entries()) {
      const r = document.createElement('div');
      r.className = 'settings-row';
      const code = document.createElement('code');
      code.textContent = origin;
      const del = document.createElement('button');
      del.className = 'settings-x';
      del.type = 'button';
      del.textContent = '×';
      del.title = `Remove ${origin}`;
      del.disabled = !canEdit;
      del.onclick = () => {
        origins.splice(i, 1);
        renderOrigins();
        say('');
      };
      r.append(code, del);
      list.append(r);
    }
  };
  renderOrigins();

  const addRow = document.createElement('div');
  addRow.className = 'settings-add';
  const addIn = document.createElement('input');
  addIn.type = 'text';
  addIn.placeholder = 'http://192.0.2.10:48770';
  addIn.spellcheck = false;
  addIn.autocapitalize = 'off';
  addIn.disabled = !canEdit;
  const addBtn = document.createElement('button');
  addBtn.className = 'ghost-btn';
  addBtn.type = 'button';
  addBtn.textContent = 'add';
  addBtn.disabled = !canEdit;
  const addOrigin = () => {
    const value = addIn.value.trim();
    if (!value) return;
    // Not validated here on purpose: the server owns the rule (`normalizeOrigin`), and a
    // second copy of it in the browser is a second answer to drift from. A bad entry comes
    // back from the save as a named refusal.
    if (!origins.includes(value)) origins.push(value);
    addIn.value = '';
    renderOrigins();
    say('');
  };
  addBtn.onclick = addOrigin;
  addIn.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addOrigin();
    }
  };
  addRow.append(addIn, addBtn);
  origSec.append(addRow);
  body.append(origSec);

  /* ───────────────────────────────────────────────────────── session names ── */

  const prefSec = document.createElement('section');
  prefSec.className = 'settings-sec';
  const prefCap = document.createElement('h3');
  prefCap.textContent = 'Session names';
  const prefRow = document.createElement('div');
  prefRow.className = 'settings-readonly';
  prefRow.title =
    'Read-only here. The prefix is resolved once when the panel starts and is the only one it ' +
    'recognises, so changing it unnames every session already running — they stay in the rail ' +
    'with no label, no duplicate button and no snapshot entry. Edit config.json by hand and ' +
    'restart if you really mean to.';
  const prefVal = document.createElement('code');
  prefVal.textContent = `${cfg.live?.sessionPrefix || ''}<folder>-<label>`;
  const prefTag = document.createElement('span');
  prefTag.className = 'settings-tag';
  prefTag.textContent = cfg.sessionPrefix ? 'read-only' : 'read-only · default';
  prefRow.append(prefVal, prefTag);
  const prefHint = document.createElement('p');
  prefHint.className = 'settings-flag';
  prefHint.textContent =
    'Every tmux session the panel starts is named this way, and it recognises no other prefix. ' +
    'It is not editable here: changing it would unname every session already running.';
  prefSec.append(prefCap, prefRow, prefHint);
  body.append(prefSec);

  /* ────────────────────────────────────────────────────────────── notifications ── */

  /*
   * The odd one out in this box, and it says so.
   *
   * Everything above is panel state on disk, written by `save` and gated on the request
   * having arrived over loopback. This is a preference belonging to *this browser* — the
   * permission it holds is the browser's, not the panel's, and no other client can be
   * given it from here — so it lives in `localStorage`, applies on the click, and is
   * deliberately not wired to `save`. It is also the one control on the page a LAN visitor
   * may still use, for the same reason: it changes nothing about the panel.
   *
   * Nothing is enabled that cannot work. Where a gate is shut the checkbox is disabled and
   * `notifyReason` prints which one and what to do about it — the maintainer's standing
   * rule that a control somebody cannot answer correctly should not be a control, applied
   * to a case where "answering it" would mean clicking a box that then silently does
   * nothing.
   */
  const noteSec = document.createElement('section');
  noteSec.className = 'settings-sec';
  const noteCap = document.createElement('h3');
  noteCap.textContent = 'Notifications on this Mac';
  noteSec.append(noteCap);

  const noteWrap = document.createElement('label');
  noteWrap.className = 'settings-choice';
  const noteBox = document.createElement('input');
  noteBox.type = 'checkbox';
  noteBox.checked = notifyArmed();
  noteBox.disabled = !notifySupported() || notifyPermission() === 'denied';
  const noteText = document.createElement('span');
  const noteTitle = document.createElement('span');
  noteTitle.className = 'settings-choice-title';
  noteTitle.textContent = 'Tell me when a session needs a human';
  const noteHint = document.createElement('span');
  noteHint.className = 'settings-choice-hint';
  noteHint.textContent =
    'A permission prompt, a question Claude is asking, a plan waiting for approval, the ' +
    'folder-trust gate, or a worker reporting for review. One notification per thing, when ' +
    'it happens — not a reminder. Clicking it opens that session. A worker’s own prompts ' +
    'stay quiet until it goes stuck, the same rule the rail follows.';
  noteText.append(noteTitle, noteHint);
  noteWrap.append(noteBox, noteText);
  noteSec.append(noteWrap);

  const noteState = document.createElement('div');
  noteState.className = 'settings-notify-state';
  const noteFlag = document.createElement('p');
  noteFlag.className = 'settings-flag';
  const noteTest = document.createElement('button');
  noteTest.className = 'ghost-btn';
  noteTest.type = 'button';
  noteTest.textContent = 'test';
  noteTest.title = 'Show one now, so you can see where it lands and what it looks like';
  noteState.append(noteFlag, noteTest);
  noteSec.append(noteState);

  const paintNotify = (extra) => {
    const reason = notifyReason();
    noteBox.checked = notifyArmed();
    // `denied` disables it too: the browser will not prompt again, so a box that could be
    // ticked and would then do nothing is worse than one that is plainly unavailable with
    // the reason under it. `default` is the one un-granted state that stays clickable —
    // that click is what asks.
    noteBox.disabled = !notifySupported() || notifyPermission() === 'denied';
    noteTest.disabled = !notifyArmed();
    // The line has to answer for the *checkbox*, not for the stored flag, and those two
    // come apart in one real state: the opt-in is remembered here while the browser's own
    // permission has gone back to `default` — a new profile, cleared site data, a
    // permission reset. Reading the flag alone printed "On" over an empty box, which is
    // the shape of every "is this broken?" report there has ever been.
    noteFlag.textContent =
      extra ||
      reason ||
      (notifyArmed()
        ? 'On, in this browser. Remembered here only — every browser and every device answers for itself.'
        : notifier.enabled
          ? 'You asked for these here, but this browser has not granted permission — tick the box to ask it again.'
          : 'Off. This is a browser preference, not a panel setting: it applies the moment you tick it and Save does not touch it.');
    noteFlag.classList.toggle('is-restart', Boolean(extra));
  };
  paintNotify();

  noteBox.onchange = async () => {
    // The gesture the permission prompt has to be asked from is this one. Anything that
    // deferred the request — a save button, a promise chain off a roster frame — would be
    // refused by the browser, silently, and read as "it just doesn't work here".
    if (noteBox.checked) {
      const outcome = await notifyEnable();
      if (outcome === 'granted') paintNotify('On. Try the test button.');
      else paintNotify();
    } else {
      notifyDisable();
      paintNotify();
    }
  };

  noteTest.onclick = () => {
    notifyShow({ id: 'test', kind: 'test', title: 'Foreman', branch: null, task: null });
    paintNotify('Sent one. If nothing appeared, macOS is holding it — check Notifications in System Settings.');
  };

  body.append(noteSec);

  /* ───────────────────────────────────────────────────────── ghost-text send ── */

  /*
   * The second browser-local preference in this box, and it sits beside the first for the
   * same reason: it decides what a click in *this* window does, and the phone and the
   * desktop are allowed to answer differently. Save does not touch it — it applies on the
   * click, like the notifications one above.
   *
   * Off by default and deliberately so: with it on, one press on a muted line sends a
   * message the model wrote into a live session. That is a real thing to hand a control,
   * and it is worth having to ask for.
   */
  const gsSec = document.createElement('section');
  gsSec.className = 'settings-sec';
  const gsCap = document.createElement('h3');
  gsCap.textContent = 'Suggested prompts';
  gsSec.append(gsCap);

  const gsWrap = document.createElement('label');
  gsWrap.className = 'settings-choice';
  const gsBox = document.createElement('input');
  gsBox.type = 'checkbox';
  gsBox.checked = ghostSend.on;
  const gsText = document.createElement('span');
  const gsTitle = document.createElement('span');
  gsTitle.className = 'settings-choice-title';
  gsTitle.textContent = 'Send a suggestion straight away';
  const gsHint = document.createElement('span');
  gsHint.className = 'settings-choice-hint';
  gsHint.textContent =
    'An idle session offers a guess at your next prompt, and the panel shows it as a muted ' +
    'line above the box. Off, the button reads “use” and puts it in the box to edit. On, it ' +
    'reads “send” and goes to the session on one press.';
  gsText.append(gsTitle, gsHint);
  gsWrap.append(gsBox, gsText);
  gsSec.append(gsWrap);

  const gsFlag = document.createElement('p');
  gsFlag.className = 'settings-flag';
  const paintGhostSend = () => {
    gsBox.checked = ghostSend.on;
    gsFlag.textContent = ghostSend.on
      ? 'On, in this browser. One press sends — remembered here only, every device answers for itself.'
      : 'Off. The button fills the box and waits for you.';
  };
  paintGhostSend();
  gsSec.append(gsFlag);

  gsBox.onchange = () => {
    ghostSend.set(gsBox.checked);
    paintGhostSend();
    // The line itself repaints on the next roster frame — its signature carries the flag,
    // so the button relabels itself without anything here reaching across into a pane.
  };

  body.append(gsSec);

  /* ───────────────────────────────────────────────────────────── the buttons ── */

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = 'cancel';
  cancel.onclick = close;
  const save = document.createElement('button');
  save.className = 'ghost-btn primary';
  save.textContent = 'save';
  save.disabled = !canEdit;
  row.append(cancel, save);

  save.onclick = async () => {
    const host = chosenHost();
    if (!host) {
      say('Pick a bind host, or type an address.', 'err');
      return;
    }
    saving = true;
    save.disabled = true;
    say('Saving…');
    try {
      const out = await postJSONMethod('PATCH', '/api/config', {
        bindHost: host,
        allowedOrigins: origins,
      });
      // Re-seat from the server's answer: it normalises origins, so what comes back is
      // what is on disk, and showing anything else would be showing the request.
      origins.length = 0;
      origins.push(...(out.allowedOrigins || []));
      renderOrigins();
      saving = false;
      save.disabled = !canEdit;
      say(
        out.restartRequired
          ? `Saved. Takes effect at the next restart (npm run restart-panel) — ${out.restartReason}.`
          : 'Saved. Nothing changed.',
      );
    } catch (err) {
      saving = false;
      save.disabled = !canEdit;
      say(err.message, 'err');
    }
  };
}

/* ---------------------------------------------------------- snapshot --- */

/** Set while the restore dialog is up, so progress frames have somewhere to land. */
let onRestoreStep = null;

/** The same, for a relaunch — which also blocks Escape, because it is ending sessions. */
let onRelaunchStep = null;

/** The tail of a path, which is the part that tells two checkouts apart. Full one in a title. */
function shortPath(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length <= 3 ? p : `…/${parts.slice(-2).join('/')}`;
}

function agoText(ms) {
  if (!ms) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Save the bench, or put it back.
 *
 * Two views in one box. The first is what's saved and how far it has drifted; the second
 * is the list of sessions restore is about to start, which exists because a dozen new
 * Terminal windows is not something to spring on someone from a single click. It is the
 * same principle as the review screen a multi-select ends on: the consequential press
 * re-reads its target first.
 */
async function openSnapshot() {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = 'Snapshot';
  const body = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'modal-note';
  const row = document.createElement('div');
  row.className = 'modal-row snap-actions';
  box.append(h, body, note, row);

  // Busy in either direction. A relaunch counts double: between the exits and the
  // restarts the bench is genuinely down, and a box you could dismiss there would hide the
  // only place saying so.
  const busy = () => Boolean(onRestoreStep || onRelaunchStep);

  const close = () => {
    onRestoreStep = null;
    onRelaunchStep = null;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    // Escape stays out of it once sessions are actually starting: the request runs on the
    // server either way, and a box that vanished mid-restore would just hide it.
    if (e.key === 'Escape' && !busy()) close();
  }
  document.addEventListener('keydown', onKey, true);
  back.onmousedown = (e) => {
    if (e.target === back && !busy()) close();
  };

  const say = (text, cls = '') => {
    note.className = `modal-note ${cls}`;
    note.textContent = text;
  };

  const button = (text, primary = false) => {
    const b = document.createElement('button');
    b.className = `ghost-btn${primary ? ' primary' : ''}`;
    b.textContent = text;
    return b;
  };

  back.append(box);
  document.body.append(back);

  let snap;
  try {
    const res = await fetch('/api/snapshot');
    snap = await res.json();
  } catch (err) {
    say(err.message, 'err');
    return;
  }

  /* ---- view one: what's saved, and what has moved since ---- */

  function summary() {
    onRestoreStep = null;
    onRelaunchStep = null;
    body.replaceChildren();
    row.replaceChildren();
    say('');

    const when = document.createElement('p');
    when.className = 'field-hint';
    when.textContent = snap.savedAt
      ? `Saved ${agoText(snap.savedAt)} · ${snap.sessions.length} session${snap.sessions.length === 1 ? '' : 's'}`
      : 'Nothing saved yet. Save the sessions you have open and restore them after a reboot.';
    body.append(when);

    const { missing = [], extra = [] } = snap.drift || {};
    if (snap.savedAt) {
      const drift = document.createElement('p');
      drift.className = 'field-hint';
      const bits = [];
      if (extra.length) bits.push(`${extra.length} running now ${extra.length === 1 ? "isn't" : "aren't"} saved`);
      if (missing.length) bits.push(`${missing.length} saved ${missing.length === 1 ? "isn't" : "aren't"} running`);
      drift.textContent = bits.length ? bits.join(' · ') : 'Matches what’s running.';
      if (bits.length) drift.classList.add('warn');
      body.append(drift);
    }

    const hint = document.createElement('p');
    hint.className = 'field-hint';
    hint.textContent =
      'Sessions come back fresh — same folders, same names, same groups, no history. ' +
      'Anything already running is left alone.';
    body.append(hint);

    const save = button('save now');
    save.onclick = async () => {
      save.disabled = true;
      say('Reading the roster…');
      try {
        const saved = await postJSON('/api/snapshot', {});
        snap = { ...snap, savedAt: saved.savedAt, sessions: saved.sessions, drift: { missing: [], extra: [] } };
        summary();
        say(`Saved ${saved.sessions.length} sessions.`);
      } catch (err) {
        say(err.message, 'err');
        save.disabled = false;
      }
    };

    const cancel = button('cancel');
    cancel.onclick = close;

    const restore = button('restore…', true);
    restore.disabled = !snap.sessions.length;
    restore.onclick = confirm;

    const relaunchBtn = button('relaunch all…');
    relaunchBtn.title =
      'Close every session on the bench and start it again — after a Claude Code update, ' +
      'or a change to a global setting.';
    relaunchBtn.onclick = relaunchConfirm;

    const spacer = document.createElement('span');
    spacer.style.marginRight = 'auto';
    row.append(save, relaunchBtn, spacer, cancel, restore);
  }

  /* ---- view three: relaunch all — the only view here that ends sessions ---- */

  /**
   * Close every session on the bench and start it again.
   *
   * The fresh/resume choice is two buttons rather than a checkbox with a default, because
   * the difference between them is whether seventeen conversations survive and there is no
   * answer that is right often enough to be pre-selected. Both are spelled out in the list
   * above them — a row that cannot be resumed says so before you press resume, rather than
   * quietly coming back empty afterwards.
   *
   * The worker refusal is drawn from the server's own answer, not re-derived here. If it
   * says there are workers, both buttons are off and the names are on screen: the point of
   * asking before offering is that the refusal arrives before the press, not after it.
   */
  async function relaunchConfirm() {
    body.replaceChildren();
    row.replaceChildren();
    say('Reading the roster…');

    let plan;
    try {
      const res = await fetch('/api/relaunch');
      plan = await res.json();
      if (!res.ok) throw new Error(plan?.error || 'Could not read the roster.');
    } catch (err) {
      say(err.message, 'err');
      const backBtn = button('back');
      backBtn.onclick = summary;
      row.append(backBtn);
      return;
    }
    say('');

    const lead = document.createElement('p');
    lead.className = 'field-hint';
    lead.textContent =
      'Every session below is closed with /exit and started again — for a new Claude Code ' +
      'build, or a global setting that only takes effect at launch. Same folders, same ' +
      'names, same groups and pins.';
    body.append(lead);

    const rows = new Map();
    const list = document.createElement('div');
    list.className = 'snap-list';
    for (const entry of plan.sessions || []) {
      const r = document.createElement('div');
      r.className = 'snap-row';

      const name = document.createElement('span');
      name.className = 'snap-name';
      name.textContent = entry.tmuxSession || entry.slug || '(unnamed)';

      const where = document.createElement('span');
      where.className = 'snap-where';
      where.textContent = shortPath(entry.folder);
      where.title = entry.folder;

      const st = document.createElement('span');
      st.className = 'snap-state';
      // Said now, not discovered later: a pane the panel never bound to a history has
      // nothing to resume, and comes back empty whichever button you press.
      st.textContent = entry.resumable ? '' : 'no history';
      if (!entry.resumable) st.title = 'No transcript bound to this pane — it comes back fresh either way.';

      r.append(name, where, st);
      list.append(r);
      rows.set(entry.tmuxSession, { row: r, state: st });
    }
    body.append(list);

    const blocked = (plan.workers || []).length > 0;
    if (blocked) {
      const warn = document.createElement('p');
      warn.className = 'field-hint';
      warn.style.color = 'var(--decision)';
      warn.textContent =
        `${plan.workers.length} worker${plan.workers.length === 1 ? '' : 's'} still running: ` +
        `${plan.workers.join(', ')}. A worker can’t be put back — close its task first.`;
      body.append(warn);
    }

    const termCap = document.createElement('label');
    termCap.className = 'field-check';
    const term = document.createElement('input');
    term.type = 'checkbox';
    term.checked = true;
    termCap.append(term, document.createTextNode('Open a Terminal window for each'));
    body.append(termCap);

    const hint = document.createElement('p');
    hint.className = 'field-hint';
    hint.textContent =
      'Anything holding a prompt, a plan box or a question is left running and untouched — ' +
      'it is named in the result rather than forced.';
    body.append(hint);

    const backBtn = button('back');
    backBtn.onclick = summary;

    const go = (label, mode, primary) => {
      const b = button(label, primary);
      b.disabled = blocked || !(plan.sessions || []).length;
      b.onclick = () => run(mode, b);
      return b;
    };

    async function run(mode, pressed) {
      for (const b of row.querySelectorAll('button')) b.disabled = true;
      term.disabled = true;
      pressed.textContent = mode === 'resume' ? 'resuming…' : 'relaunching…';
      say('Closing them, then starting them one at a time. The bench is down until it finishes.');

      onRelaunchStep = (step) => {
        const hit = rows.get(step.name);
        if (!hit) return;
        if (step.phase === 'exit') {
          hit.row.className = `snap-row is-${step.state === 'exited' ? 'exited' : 'skipped'}`;
          hit.state.textContent = step.state === 'exited' ? 'closed' : 'left alone';
        } else {
          hit.row.className = `snap-row is-${step.state}`;
          hit.state.textContent =
            step.state === 'started'
              ? step.resumed
                ? 'resumed'
                : 'started'
              : step.state === 'skipped'
                ? 'left alone'
                : 'failed';
        }
        if (step.reason || step.error) hit.state.title = step.reason || step.error;
      };

      try {
        const out = await postJSON('/api/relaunch', { mode, terminal: term.checked });
        onRelaunchStep = null;
        const bits = [
          out.mode === 'resume'
            ? `${out.resumed} back with their history` + (out.started - out.resumed ? `, ${out.started - out.resumed} fresh` : '')
            : `${out.started} started fresh`,
        ];
        if (out.skipped) bits.push(`${out.skipped} left alone`);
        if (out.failed) bits.push(`${out.failed} failed`);
        say(`${bits.join(' · ')}. Hover a row for why.`, out.failed ? 'err' : '');
        backBtn.disabled = false;
        backBtn.textContent = 'done';
        backBtn.onclick = close;
      } catch (err) {
        onRelaunchStep = null;
        say(err.message, 'err');
        backBtn.disabled = false;
      }
    }

    const spacer = document.createElement('span');
    spacer.style.marginRight = 'auto';
    row.append(backBtn, spacer, go('relaunch fresh', 'fresh'), go('relaunch, keep history', 'resume', true));
  }

  /* ---- view two: exactly what is about to be started ---- */

  function confirm() {
    body.replaceChildren();
    row.replaceChildren();
    say('');

    const live = new Set(snap.live || []);
    const rows = new Map();

    const list = document.createElement('div');
    list.className = 'snap-list';
    for (const entry of snap.sessions) {
      const r = document.createElement('div');
      const already = entry.tmuxSession && live.has(entry.tmuxSession);
      r.className = `snap-row${already ? ' is-skipped' : ''}`;

      const name = document.createElement('span');
      name.className = 'snap-name';
      name.textContent = entry.tmuxSession || entry.slug || '(unnamed)';

      const where = document.createElement('span');
      where.className = 'snap-where';
      where.textContent = shortPath(entry.folder);
      where.title = entry.folder;

      const st = document.createElement('span');
      st.className = 'snap-state';
      st.textContent = already ? 'already running' : '';

      r.append(name, where, st);
      list.append(r);
      rows.set(entry.folder + ' ' + (entry.slug ?? ''), { row: r, state: st });
    }
    body.append(list);

    const toStart = snap.sessions.filter((e) => !(e.tmuxSession && live.has(e.tmuxSession)));

    const termCap = document.createElement('label');
    termCap.className = 'field-check';
    const term = document.createElement('input');
    term.type = 'checkbox';
    term.checked = true;
    termCap.append(term, document.createTextNode('Open a Terminal window for each'));
    body.append(termCap);

    const termHint = document.createElement('p');
    termHint.className = 'field-hint';
    termHint.textContent =
      `${toStart.length} window${toStart.length === 1 ? '' : 's'}. Unticked, they run in tmux only — ` +
      'nothing to attach to if one comes up in a state the panel can’t read.';
    body.append(termHint);

    const backBtn = button('back');
    backBtn.onclick = summary;

    const go = button(`start ${toStart.length} session${toStart.length === 1 ? '' : 's'}`, true);
    go.disabled = !toStart.length;
    go.onclick = async () => {
      go.disabled = true;
      backBtn.disabled = true;
      term.disabled = true;
      say('Starting them one at a time — each waits for claude to come up.');

      // Each session reports itself as it lands, so a minute-long request looks like work.
      onRestoreStep = (step) => {
        const hit = rows.get(step.folder + ' ' + (step.slug ?? ''));
        if (!hit) return;
        hit.row.className = `snap-row is-${step.state}`;
        hit.state.textContent =
          step.state === 'started' ? 'started' : step.state === 'skipped' ? 'already running' : 'failed';
        if (step.error) hit.state.title = step.error;
      };

      try {
        const out = await postJSON('/api/snapshot/restore', { terminal: term.checked });
        const started = out.results.filter((r) => r.state === 'started').length;
        const failed = out.results.filter((r) => r.state === 'failed');
        onRestoreStep = null;
        say(
          failed.length
            ? `Started ${started}. ${failed.length} didn’t: ${failed.map((f) => `${f.slug || f.folder} — ${f.error}`).join('; ')}`
            : `Started ${started}. Give them a moment to appear in the rail.`,
          failed.length ? 'err' : '',
        );
        backBtn.disabled = false;
        backBtn.textContent = 'done';
        backBtn.onclick = close;
      } catch (err) {
        onRestoreStep = null;
        say(err.message, 'err');
        backBtn.disabled = false;
      }
    };

    row.append(backBtn, go);
  }

  summary();
}

/* ------------------------------------------------------------- menus --- */

/**
 * One popup at a time, anchored under the button that opened it and living in `body` —
 * not in the rail, which is redrawn under it every couple of seconds.
 *
 * Items are `{ label, checked, danger, confirm, onPick }`, `{ separator: true }`, or
 * `{ input: { value, placeholder, onSubmit } }`. A failing `onSubmit` keeps the menu
 * open and says why, because the thing it most often fails on — a name already taken —
 * is one you fix by typing a different one.
 */
let menuState = null;

/**
 * @param {'picked'|'dismissed'} [how] a menu can leave something open behind it — the
 *   model picker holds the terminal's own dialog while it is up — so walking away has to
 *   be told apart from choosing. Only `dismissed` runs the cleanup.
 */
function closeMenu(how = 'dismissed') {
  if (!menuState) return;
  const { onDismiss } = menuState;
  menuState.el.remove();
  menuState = null;
  document.removeEventListener('pointerdown', onMenuPointerDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
  if (how === 'dismissed') onDismiss?.();
}

function onMenuPointerDown(e) {
  if (menuState && !menuState.el.contains(e.target)) closeMenu();
}

function onMenuKey(e) {
  if (e.key !== 'Escape' || !menuState) return;
  e.stopPropagation();
  closeMenu();
}

function openMenu(anchor, items, { onDismiss } = {}) {
  // Clicking the same ▾ again shuts it, which is what everyone expects of a caret.
  const sameAnchor = menuState?.anchor === anchor;
  closeMenu();
  if (sameAnchor) return;

  // A menu is placed off its anchor's rect, and a node that has left the document measures
  // as all zeros — so a detached anchor puts the menu in the top-left corner of the page
  // instead of on the control that was clicked. That is not hypothetical: anything that
  // awaits the server before opening can have its whole composer rebuilt underneath it
  // (see `buildModelPicker`), and those callers now resolve the anchor after the await.
  // This is the floor under them. `onDismiss` still runs, because it is the caller's "the
  // menu is gone" hook and the model picker uses it to close the box it opened in the
  // terminal — refusing must not leave one holding the session.
  if (!anchor?.isConnected) {
    onDismiss?.();
    return;
  }

  const el = document.createElement('div');
  el.className = 'menu';

  const err = document.createElement('div');
  err.className = 'menu-err';

  const fail = (message) => {
    err.textContent = message;
    if (!err.isConnected) el.append(err);
  };

  // What the filter box hides, and the labels it decides over. Collected as the items are
  // built rather than read back off the DOM: `item.label` is the string the caller meant,
  // while a built node's `textContent` has a tick column and any `hint` welded onto it — so
  // a filter read off the node would match a group name nobody typed.
  const filterable = [];

  for (const item of items) {
    if (item.separator) {
      const rule = document.createElement('div');
      rule.className = 'menu-rule';
      el.append(rule);
      continue;
    }

    // A line that says something rather than doing something — what a menu needs when the
    // consequence of picking is wider than the thing you clicked from.
    if (item.note) {
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = item.note;
      el.append(note);
      continue;
    }

    // A box that narrows the list below it as you type, for a menu that can be long — the
    // group `+` offers every folder this client has heard of. It is deliberately **not** a
    // form and nothing about it submits: Enter in here must not pick whatever happens to be
    // first, because the one thing worse than scrolling a menu is filing a folder under a
    // group you did not read. A filtered-out item is hidden, not removed, so clearing the
    // box brings it back without rebuilding anything.
    if (item.filter) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'menu-filter';
      input.maxLength = 60;
      input.placeholder = item.filter.placeholder || 'Filter…';
      input.setAttribute('aria-label', input.placeholder);
      input.oninput = () => {
        const q = input.value;
        for (const { node, label } of filterable) node.hidden = !matchesFilter(label, q);
      };
      el.append(input);
      continue;
    }

    // The group ring, as one row of circles. Every slot is offered — a colour the rail can
    // wear but the menu will not show is a colour you cannot choose (the maintainer's own
    // ruling) — and the count comes from `GROUP_COLOUR_COUNT` rather than a literal, so the
    // day the ring grows this row grows with it.
    //
    // Real buttons, each with an `aria-label`, because a circle has no text to read: a
    // swatch row built out of `div`s is ten controls a keyboard cannot reach and a screen
    // reader cannot name. The hue itself goes on as `--h` through `hueVar`, so the token is
    // spelled in exactly one place in this repo.
    if (item.swatches) {
      const rowEl = document.createElement('div');
      rowEl.className = 'menu-swatches';
      for (let n = 1; n <= GROUP_COLOUR_COUNT; n += 1) {
        const sw = document.createElement('button');
        sw.className = `menu-swatch${n === item.value ? ' is-current' : ''}`;
        sw.style.setProperty('--h', hueVar(n));
        sw.setAttribute('aria-label', `colour ${n}`);
        sw.title = `colour ${n}`;
        if (n === item.value) sw.setAttribute('aria-current', 'true');
        sw.onclick = async () => {
          try {
            await item.onPick(n);
            closeMenu('picked');
          } catch (error) {
            fail(error.message);
          }
        };
        rowEl.append(sw);
      }
      el.append(rowEl);
      continue;
    }

    if (item.input) {
      const form = document.createElement('form');
      form.className = 'menu-form';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 40;
      input.placeholder = item.input.placeholder || '';
      input.value = item.input.value || '';
      form.append(input);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        try {
          await item.input.onSubmit(value);
          closeMenu();
        } catch (error) {
          fail(error.message);
          input.select();
        }
      };
      el.append(form);
      continue;
    }

    const btn = document.createElement('button');
    btn.className = `menu-item${item.danger ? ' danger' : ''}`;

    const mark = document.createElement('span');
    mark.className = 'menu-mark';
    mark.textContent = item.checked ? '✓' : '';
    btn.append(mark);

    const label = document.createElement('span');
    label.textContent = item.label;
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'menu-hint';
      hint.textContent = item.hint;
      label.append(hint);
    }
    btn.append(label);
    filterable.push({ node: btn, label: item.label });

    let armed = !item.confirm;
    btn.onclick = async () => {
      // Destructive things ask once, in place, rather than in a dialog that blocks the tab.
      if (!armed) {
        armed = true;
        label.textContent = item.confirm;
        btn.classList.add('armed');
        return;
      }
      try {
        await item.onPick();
        closeMenu('picked');
      } catch (error) {
        fail(error.message);
      }
    };
    el.append(btn);
  }

  document.body.append(el);

  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.min(r.left, window.innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;

  menuState = { el, anchor, onDismiss };
  document.addEventListener('pointerdown', onMenuPointerDown, true);
  document.addEventListener('keydown', onMenuKey, true);
  el.querySelector('input')?.focus();
}

/* ------------------------------------------------------------ groups --- */

const groupOfFolder = (folder) =>
  state.groups.find((g) => g.folders.includes(folder))?.id ?? null;

async function groupApi(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `That didn't take (${res.status}).`);
  // The server answers with the whole shelf and broadcasts it too; taking it from the
  // response as well means the rail moves on the click rather than on the next frame.
  if (body.groups) {
    state.groups = body.groups;
    renderRail();
  }
  return body;
}

const assignFolder = (folder, groupId) =>
  groupApi('/api/groups/assign', { method: 'POST', body: JSON.stringify({ folder, groupId }) });

/** Make the group and put the folder in it — one gesture, two calls. */
async function createGroupWith(folder, name) {
  const { group } = await groupApi('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
  await assignFolder(folder, group.id);
}

const renameGroup = (g, name) =>
  groupApi(`/api/groups/${g.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });

const deleteGroup = (g) => groupApi(`/api/groups/${g.id}`, { method: 'DELETE' });

/**
 * The `⋯` menu's swatch row: one `PATCH {colour}`, and **nothing painted locally first**.
 *
 * `setGroupCollapsed` below flips its field before the call and is right to — a caret that
 * waited on a round trip reads as a dead control, and a refused collapse costs nothing. A
 * colour is the opposite trade: the store is the only validator (`setColour` refuses a slot
 * outside the ring, which is the route's 400), so painting the new hue ahead of the answer
 * would leave a spine on screen in a colour that is not on disk, and the next roster frame
 * would silently take it back. `groupApi` adopts the groups the response carries and
 * repaints from those, so the rail moves on the answer rather than on the click.
 */
const setGroupColour = (g, colour) =>
  groupApi(`/api/groups/${g.id}`, { method: 'PATCH', body: JSON.stringify({ colour }) });

function setGroupCollapsed(g, collapsed) {
  g.collapsed = collapsed; // flip now; the broadcast confirms it a beat later
  renderRail();
  groupApi(`/api/groups/${g.id}`, { method: 'PATCH', body: JSON.stringify({ collapsed }) }).catch(
    () => {},
  );
}

function openFolderMenu(anchor, folder) {
  const current = groupOfFolder(folder);
  const items = state.groups.map((g) => ({
    label: g.name,
    checked: g.id === current,
    // Picking the one it's already in takes it out again — the tick is a toggle.
    onPick: () => assignFolder(folder, g.id === current ? null : g.id),
  }));
  if (items.length) items.push({ separator: true });
  items.push({ input: { placeholder: 'New group…', onSubmit: (name) => createGroupWith(folder, name) } });
  if (current) items.push({ label: 'Ungroup', onPick: () => assignFolder(folder, null) });
  openMenu(anchor, items);
}

/**
 * `⋯` — rename, recolour, delete.
 *
 * The swatch row sits **above the rule that fences the delete off**, which is the whole of
 * why the order here is not arbitrary: the one destructive thing in this menu keeps the
 * bottom slot it has always had, behind its own confirm, with nothing new landing between
 * a reader's eye and it. Picking a colour is the cheapest thing in the panel — one key on
 * one record, undone by picking another — so it belongs with the rename, on the safe side.
 */
function openGroupMenu(anchor, g) {
  openMenu(anchor, [
    { input: { value: g.name, placeholder: 'Rename…', onSubmit: (name) => renameGroup(g, name) } },
    { swatches: true, value: g.colour, onPick: (n) => setGroupColour(g, n) },
    { separator: true },
    {
      label: 'Delete group',
      danger: true,
      confirm: 'Really delete?',
      // Its folders aren't going anywhere — they just go back to standing on their own.
      onPick: () => deleteGroup(g),
    },
  ]);
}

/**
 * `+` — file a folder under this group, the reverse of the folder's own `▾`.
 *
 * Same endpoint and the same `assign` semantics as that menu; only the direction is new.
 * A folder already filed somewhere else stays in the list and carries the group it is
 * leaving as a hint, because `assign` *moves* it — a folder is in exactly one group — and a
 * pick that quietly emptied another group's block would be the panel doing something the
 * reader did not read.
 *
 * **What it can offer is what the browser knows**: `eligibleFolders` unions the folders with
 * a live session and the folders filed in any group, less whatever is already in here. A
 * folder that is neither is invisible to this client, and the empty state says so in words
 * rather than the panel growing an endpoint that walks the disk.
 */
function openGroupAddMenu(anchor, g) {
  const folders = eligibleFolders(state.sessions, state.groups, g.id);
  if (!folders.length) {
    openMenu(anchor, [
      {
        note: `Nothing left to add. ${g.name} already holds every folder the panel can see — a folder with no live session and no group of its own isn't known to this browser.`,
      },
    ]);
    return;
  }
  const items = [{ filter: { placeholder: 'Search folders…' } }];
  for (const folder of folders) {
    const from = state.groups.find((other) => other.id !== g.id && other.folders.includes(folder));
    items.push({
      label: folder,
      hint: from ? `from ${from.name}` : '',
      onPick: () => assignFolder(folder, g.id),
    });
  }
  openMenu(anchor, items);
}

/** The header's pin, which is a label rather than a glyph — there's room for words there. */
function paintPinBtn(btn, s) {
  if (!btn) return;
  btn.textContent = s.pinned ? '★ pinned' : 'pin';
  btn.setAttribute('aria-pressed', String(Boolean(s.pinned)));
  btn.title = s.pinned ? 'Unpin — let this session sort with the rest' : 'Keep this session at the top of the rail';
}

/**
 * How sure the panel is that this row's conversation belongs to this row's terminal —
 * drawn only where that is worth knowing.
 *
 * It sits under the status dot because it qualifies the dot: everything else on the row —
 * the status, the unread count, what it's doing — is only as true as this. But the hook
 * lands on very nearly every session, so the rail carried nineteen shut padlocks all
 * saying the same untroubling thing, and the one row that differed had to be *found*
 * among them. A mark on every row is not a mark. So certainty draws nothing now, and the
 * open padlock is left to mean the only thing a mark should mean: there is something here
 * to know.
 *
 * Which makes the table below an exceptions list, and a state earns its place by being
 * less than sure. `hook` is gone from it because it is the one state the panel was *told*
 * rather than worked out; `pane-only` was never in it, because a row with no conversation
 * behind it yet has nothing to be unsure about — and it already says so in words, in the
 * transcript pane. Note `label` stays in, and deliberately: an exact name match is still
 * the panel reasoning, a title can be shared by every session in a repo (see the
 * branch-derived guard in `binding.js`), and the failure mode of hiding one of these is
 * far worse than the failure mode of drawing one too many. Anything added here later that
 * isn't outright authoritative belongs in the table, not out of it.
 *
 * A padlock in a Claude Code interface has an obvious wrong reading — permissions — so
 * the colours stay off the danger palette and the tooltip says what it means in words.
 */
const BINDING_MARK = {
  label: {
    cls: 'bind-label',
    title:
      "Matched by name: this terminal's label and the conversation's name are the same. Exact, but the panel worked that out rather than being told — and a name can be shared, so it is good evidence and not proof.",
  },
  inferred: {
    cls: 'bind-inferred',
    title:
      'Worked out: the only live conversation in this folder. Nothing else it could be, but nothing confirmed it either.',
  },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Whether an attachment is a text file, asked of the name the server saved it under.
 *
 * **Derived, never stored.** The saved name carries the extension because `Read` needs it
 * to, so the fact is already on disk and on every attachment record — including the ones
 * `localStorage` was holding before text uploads existed, which is why nothing had to be
 * migrated. A `kind` field beside the name would be a second spelling of one fact, and the
 * day the two disagreed the chip would draw a thumbnail of a text file.
 */
const TEXT_UPLOAD_RE = /\.(txt|md)$/i;
const isTextName = (name) => TEXT_UPLOAD_RE.test(String(name || ''));

/** Sizes for a chip: short enough to sit beside a filename in 15rem. */
function shortBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The fold glyph, in the one place it is spelled — a panel with its right region shut, and
 * a chevron saying which way it is about to go.
 *
 * **One function, two directions, three call sites and counting.** The team aside's band
 * draws `collapse`, the aside's folded strip draws `expand`, and a group room pane's strip
 * draws `expand` too. Three copies of an eight-coordinate drawing is the `isLeadName`
 * lesson in its smallest costume: nothing would break, the three would simply drift, and a
 * reader would find two panels in one window whose collapse controls do not match. So the
 * geometry is here and the callers pass a word.
 *
 * `dir` is `'collapse'` (chevron pointing right — "shut the right-hand panel") or
 * `'expand'` (pointing left — "open it again"). It is the same drawing mirrored about the
 * chevron alone: the frame and its divider do not move, because the *panel* is what the
 * icon is about and only the direction of travel changes.
 *
 * `currentColor` and no size attributes, deliberately. The stylesheet owns both — the band
 * paints `--ink-muted` and takes `--accent` under the cursor, and the strip does the same
 * one column over — so a caller that wants a different ink or a different size sets it in
 * CSS rather than being handed a second argument here.
 */
function foldIcon(dir) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  // The panel: a rounded frame with a divider three-quarters across, which is the shape of
  // this layout — a wide reading column and a narrow one beside it. A `rect` rather than a
  // path of its own, so the four numbers on it are the four numbers the design names.
  const frame = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of [['x', '3'], ['y', '4.5'], ['width', '18'], ['height', '15'], ['rx', '2.5']]) {
    frame.setAttribute(k, v);
  }
  svg.append(frame);

  const divider = document.createElementNS(SVG_NS, 'path');
  divider.setAttribute('d', 'M15 4.5V19.5');
  svg.append(divider);

  // The chevron, inside the *left* region — the wide one — because that is the space the
  // right-hand panel is about to give back or take away.
  const chev = document.createElementNS(SVG_NS, 'path');
  chev.setAttribute('d', dir === 'expand' ? 'M11 9.5 L8.5 12 L11 14.5' : 'M8 9.5 L10.5 12 L8 14.5');
  svg.append(chev);

  return svg;
}

/**
 * A page with a folded corner, in `--ink-faint`, where an image chip has its thumbnail.
 *
 * Drawn rather than fetched: asking `/api/image/<name>` for a `.md` as an `<img>` would
 * get the bytes, fail to decode them, and leave a broken-image mark — a wrong picture in
 * the one slot on the chip that is supposed to say what kind of thing this is.
 */
function docGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'attach-doc');
  svg.setAttribute('aria-hidden', 'true');

  const page = document.createElementNS(SVG_NS, 'path');
  page.setAttribute('d', 'M3.5 1.5h6L13 5v9.5H3.5z');
  page.setAttribute('fill', 'none');
  page.setAttribute('stroke', 'currentColor');
  page.setAttribute('stroke-width', '1.2');
  page.setAttribute('stroke-linejoin', 'round');
  svg.append(page);

  const fold = document.createElementNS(SVG_NS, 'path');
  fold.setAttribute('d', 'M9.5 1.5V5H13');
  fold.setAttribute('fill', 'none');
  fold.setAttribute('stroke', 'currentColor');
  fold.setAttribute('stroke-width', '1.2');
  fold.setAttribute('stroke-linejoin', 'round');
  svg.append(fold);

  for (const y of [8, 10.5]) {
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', `M5.5 ${y}h5`);
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.2');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
  }

  return svg;
}

/**
 * Drawn rather than typed.
 *
 * The first version used the padlock emoji and failed for a reason worth keeping: at
 * eleven pixels every padlock is the same silhouette — all that detail becomes one grey
 * blob — and a font glyph sits on a baseline, so it never lines up under the dot without
 * hand-tuned nudging. A deliberate shape at a fixed viewBox does both jobs: the shackle
 * is lifted clear of the body by a readable gap, and the drawing is centred in its own
 * box by construction.
 */
function bindingMark(s) {
  const spec = BINDING_MARK[s.binding];
  // The quiet cases, and there is nothing to draw for either: `hook`, where the panel was
  // told outright, and `pane-only`, where there is no conversation to be sure about yet.
  //
  // The cell they leave behind stays empty rather than closing up. The row's first grid
  // column is a fixed `0.85rem` — see `.session` — so the title sits at the same x whether
  // or not anything is drawn here, and since the meta line on row 2 is taller than this
  // mark, the row's height doesn't move either. That is the trade: an empty column on
  // almost every row, in exchange for a rail whose titles never jog sideways or up and
  // down as bindings resolve. Nineteen padlocks were the cost of the same alignment.
  if (!spec) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  // 13px, not 11: the open state has to show daylight between the shackle and the body,
  // and two pixels of gap is the least that survives. The rail's icon column is 13.6px,
  // so this is as large as it goes without moving anything else.
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('class', `bind-mark ${spec.cls}`);

  const label = document.createElementNS(SVG_NS, 'title');
  label.textContent = spec.title;
  svg.append(label);

  // Lifted, with the right leg stopping two pixels clear of the body. The shut variant
  // that used to sit beside this (`M4.2 6.8 V5.2 a1.8 1.8 0 0 1 3.6 0 V6.8`, both legs
  // landing in the body) is gone with the state it drew — every mark the rail draws now
  // is an open one. Kept symmetric about the viewBox centre: the mark shares a column
  // with the status dot, and a drawing whose weight leans right reads as misaligned even
  // when its box is centred.
  const shackle = document.createElementNS(SVG_NS, 'path');
  shackle.setAttribute('d', 'M4.2 6.8 V3.9 a1.8 1.8 0 0 1 3.6 0 V4.9');
  shackle.setAttribute('fill', 'none');
  shackle.setAttribute('stroke', 'currentColor');
  shackle.setAttribute('stroke-width', '1.3');
  shackle.setAttribute('stroke-linecap', 'round');
  svg.append(shackle);

  // Always solid. An outlined body at eleven pixels is four grey hairlines and a hole —
  // the first attempt drew it that way and it read as damage, not as a padlock. What
  // separates `label` from `inferred` is the colour alone, which survives the size.
  const body = document.createElementNS(SVG_NS, 'rect');
  body.setAttribute('x', '1.7');
  body.setAttribute('y', '6.7');
  body.setAttribute('width', '8.6');
  body.setAttribute('height', '4.7');
  body.setAttribute('rx', '1.2');
  body.setAttribute('fill', 'currentColor');
  svg.append(body);

  return svg;
}

/**
 * The rail's shared-room row: one persistent line, and the count of what has arrived since
 * anybody last looked.
 *
 * **Patched in place, never rebuilt.** The row is one node with three spans and it is
 * repainted on the roster beat — rebuilding it would take the button out from under a
 * cursor that is on its way to press it, which is the same correctness argument `roomsSig`
 * makes for the band below and `renderMergeQueue` makes one pane over. There is nothing
 * here worth a signature: three `textContent` writes cost less than the comparison would.
 *
 * It is deliberately **not** on `composerSig`, and nothing about the shared room may ever
 * join it. That signature tears the whole composer down when it changes, and a message
 * landing in the room would take the textarea out from under whoever is typing.
 *
 * The count is not a badge that asks for anything — see `state.sharedRoom`. Zero draws
 * nothing at all, for the reason a `· 0` on a group heading draws nothing: furniture.
 */
function renderSharedRow() {
  const row = el.railShared;
  if (!row) return;
  const { unseen = 0, lastAt = null } = state.sharedRoom || {};
  const open = panes.some((p) => p.sharedOpen());
  row.classList.toggle('is-open', open);
  row.title = lastAt
    ? `Everything the sessions on this Mac say to each other · last ${new Date(lastAt).toLocaleString()}`
    : 'Everything the sessions on this Mac say to each other';

  const badge = el.railSharedUnseen;
  if (!badge) return;
  // A room you are looking at has nothing unseen in it, whatever the summary last said:
  // `markSharedRead` is a round trip and the next roster frame is the one that clears the
  // count, so without this the number sits on the row for a beat after it stopped being
  // true. Drawn from what is on screen rather than waiting to be told.
  const n = open ? 0 : unseen;
  badge.hidden = n === 0;
  if (n === 0) return;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.title = `${n} message${n === 1 ? '' : 's'} since you last opened peer messages`;
}

/**
 * What the rooms band last drew, so a roster beat that changed nothing repaints nothing.
 *
 * `renderSharedRow`'s reason one row up, and joined with real punctuation: `|` inside a row
 * and `~` between rows, never
 * punctuation rather than what reads in an editor as an empty string. The string itself is
 * built in `web/rooms-band.js` so a test can hold what is in it — a field the face reads and
 * the signature does not is a band that stops repainting on a real change.
 */
let roomsSig = '';

/**
 * The rail's rooms band: one row per open room, the archived ones folded away, and the
 * control that makes a new one.
 *
 * Called from the end of `renderRail`, which is every place the panel already redraws for —
 * the roster beat, a pane opening, a group folding — exactly as `renderSharedRow` is one
 * band up.
 *
 * It is deliberately **not** on `composerSig` and nothing about rooms may ever join it: that
 * signature tears the whole composer down when it changes, and a message landing in a room
 * would take the textarea out from under whoever is typing. `renderSharedRow` says it for
 * the band above, the merge block says it one pane over, and it is pinned by a test.
 *
 * **Patched, never rebuilt.** `patchBand` reuses every row node it already has, so the row a
 * cursor is on its way to press is the same node it was two frames ago. The signature above
 * is the cheaper half of the same guard, not a substitute for it.
 */
function renderRoomsBand() {
  const rooms = state.rooms;

  // The **rows** exist only while there is something in them — `.app.has-rooms` gates
  // `.rooms-list` and nothing else, so the head and its `+ room` are always in the rail.
  // The band never hides whole: `+ room` is the only way into the create modal, and a
  // control that appears only once traffic exists is a control nobody discovers — the shared
  // row above says it in its own markup. The class is on `.app` rather than on the rail
  // because it is one fact about the whole window.
  el.app.classList.toggle('has-rooms', rooms.length > 0);
  if (!el.roomsList) return;

  // Which rooms are on screen right now — asked of the panes rather than held in module
  // scope, for the reason everything per-pane is inside the factory: split view means two of
  // them, and only a pane knows what it is holding. At most one answers, because a room
  // replaces whatever non-session pane is open (`openGroupRoom`).
  const openIds = panes.map((p) => p.groupRoomId()).filter(Boolean);

  const archivedCollapsed = state.roomsArchivedShut;
  const sig = bandSig(rooms, { openIds, archivedCollapsed });
  if (sig === roomsSig) return;
  roomsSig = sig;

  patchBand(el.roomsList, rooms, {
    openIds,
    archivedCollapsed,
    onOpen: openGroupRoom,
    onToggleArchived: toggleArchivedRooms,
  });
}

/** The archived fold, opened or shut. Kept in this browser — see `state.roomsArchivedShut`. */
function toggleArchivedRooms() {
  state.roomsArchivedShut = !state.roomsArchivedShut;
  try {
    localStorage.setItem('foreman.roomsArchivedOpen', state.roomsArchivedShut ? '0' : '1');
  } catch {
    /* quota or private mode — this window still behaves, it just won't survive a reload */
  }
  renderRoomsBand();
}

/**
 * Put one group room on screen — `openSharedRoom`'s shape, and deliberately so.
 *
 * Where it lands, and why it is never the pane you are in: **one pane open** → split, and
 * the room takes the new slot, so the conversation you were reading stays where it is.
 * **Two open** → it replaces the pane you are *not* focused in, for the same reason. A room
 * is a thing you consult beside what you were doing; taking that away to show it would
 * defeat the point of putting it in a slot at all.
 *
 * **One non-session pane at a time** — the maintainer's own answer to the plan's Q6. A pane
 * already holding a thread, the shared room *or another group room* is what this replaces,
 * ahead of any session: two non-session panes and no conversation is not a state worth being
 * able to reach, and it is also what guarantees `sessionPane` always has somewhere to send a
 * rail click.
 *
 * It never leaves **focus** on the room, for the reason `sessionPane` records: focus means
 * "the pane the rail and the keyboard drive", and a pane you consult is never that — handing
 * it focus is precisely how a rail click came to eat a thread (#36).
 */
function openGroupRoom(id) {
  if (!id) return;
  // Already on screen. `revealOpenRoom` is the whole answer and it is usually nothing at
  // all — see there for the one case where it is not.
  if (panes.some((p) => p.groupRoomId() === id)) return revealOpenRoom();

  /*
   * A room **slides in open, every time**, which is the maintainer's ruling and is why the
   * remembered fold has exactly one job left: a reload, where `adopt` puts the pane back
   * from `state.opened` and it comes back the way it was. Clearing the flag here is what
   * makes those two statements consistent — without it, a room opened fresh would come back
   * folded after the next reload, which is the memory answering a question nobody asked.
   *
   * `slideRoomIn` is what makes "open" an animation rather than a state: it mounts the pane
   * with the fold class on, forces a reflow and takes it off, so the room slides out of the
   * strip using item 3's own mechanism rather than a second one.
   */
  roomFolded.set(false);

  /*
   * The auto-collapse, and the whole of it is which pane the room is about to take.
   *
   * `roomTarget` is asked here for **one** reason: an aside inside the pane that is about to
   * be replaced is not in the way, it is going away with its pane, and folding it would be
   * 200ms of animation on a panel nobody will see again. That is the branch a reader assumes
   * away — two panes, the lead in the one you are *not* focused in — so it is named rather
   * than left to fall out of the arithmetic.
   *
   * Everything else about the routing is re-derived on the other side of the fold, because a
   * fold is 200ms and the frame can change inside it.
   */
  const inTheWay = asideInTheWay(roomTarget());
  if (inTheWay) foldAsideThen(inTheWay, () => mountGroupRoom(id));
  else mountGroupRoom(id);
}

/**
 * Which pane a room is about to be put in — or `null` when there is not one yet, meaning a
 * split is about to be made and the room goes in the new slot.
 *
 * One spelling of the routing rule, because two callers now ask it a beat apart:
 * `openGroupRoom` asks *before* the aside's fold, only to know whether the aside in front of
 * it is about to be replaced anyway, and `mountGroupRoom` asks again *after* it, which is
 * what makes the answer honest across the 200ms in between.
 */
function roomTarget() {
  const holder = panes.find((p) => p.kind() !== 'session');
  if (holder) return holder;
  if (panes.length > 1) return panes.find((p) => p.slot !== focusedSlot) || panes[0];
  return null;
}

/**
 * Put the room in its slot, and slide it in.
 *
 * The second half of `openGroupRoom`, split off because the auto-collapse runs it either
 * straight away or 200ms later on the far side of an aside's fold — and because everything
 * in it has to be re-derived at the moment it runs rather than at the moment it was decided.
 *
 * `slideRoomIn` goes **last**, after `setFocus` and the repaints: `paintFocus` calls
 * `paintFolds`, which re-derives the fold from `roomFolded` — false, because a room slides
 * in open — and would take the seeded strip straight back off. Nothing paints in between, so
 * the order costs nothing and getting it wrong costs the animation.
 */
function mountGroupRoom(id) {
  const existing = roomTarget();
  const target = existing || openSplit({ adopt: false, focus: false });
  if (!target) return;
  if (!existing) threadSplit = true;
  target.openGroup(id);
  // Put focus where a click will land, which after this is never the room.
  const keep = sessionPane();
  if (keep) setFocus(keep.slot);
  for (const p of panes) p.renderHead();
  renderRail();
  slideRoomIn(target);
}

/**
 * Make a room — **item 8**: a name, and a tick against every session that is to be in it.
 *
 * A modal on its own beat, in module scope, for `openNewSession`'s own two reasons: a room
 * is not a fact about any one pane (`createPane`'s factory holds everything that is), and
 * nothing here is joined to `composerSig` or repainted on the roster beat. **Nothing about
 * rooms may ever join that signature** — it tears the whole composer down when it changes,
 * and a message landing in a room would take the textarea out from under whoever is typing.
 * `renderRoomsBand` says it for the band, `renderSharedRow` for the row above it.
 *
 * The list is **built once, from the roster as it stands when the box opens**, and is not
 * repainted afterwards. That is deliberate and it is the same call the settings modal makes:
 * the roster broadcasts every couple of seconds, and a list that re-sorted itself under a
 * cursor — or worse, removed the row about to be ticked because a session went quiet — would
 * lose a choice that had already been made. What a stale row costs is one 404 with the
 * server's own sentence on it, which is exactly the trade `POST /api/rooms` is written for:
 * *"it may have exited"*.
 *
 * **Genuinely new UI, and it replaced the peer-message `@` picker rather than borrowing
 * it.** That was a single-target popover over a textarea; this is a multi-select, over the
 * same source and asking `roomParticipants` — one allow-list, one caller now — and the
 * widget is new because the question is.
 *
 * **Here first, then everywhere else, and it is a sort.** The sessions in the folder you are
 * looking at come first, because that is what a room usually is; a session in another project
 * is one scroll down rather than unreachable. Filtering would make a cross-project room
 * impossible to build from the panel at all, which is half of what rooms are for.
 *
 * **The cap is the server's.** `GET /api/rooms` answers `maxMembers` and that answer wins the
 * moment it lands; `MAX_MEMBERS` is only what the first frame draws with. The client refuses
 * the tick past it with its own sentence *and* shows the server's 400 verbatim if one gets
 * through — two rungs, because a refusal a person can see before they press is worth more
 * than one they see after, and neither is allowed to be the only one.
 */
function openCreateRoom() {
  const back = document.createElement('div');
  back.className = 'modal-back';

  const box = document.createElement('div');
  box.className = 'modal is-room';

  const h = document.createElement('h2');
  h.textContent = 'New room';
  box.append(h);

  const nameCap = document.createElement('label');
  nameCap.className = 'field-cap';
  nameCap.textContent = 'Name';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'e.g. the checkout flow';
  // A courtesy, not the authority: `server/rooms.js` refuses an over-long name rather than
  // shortening it, and that refusal is what gets shown if one arrives by paste or by a
  // browser that ignores this.
  name.maxLength = MAX_ROOM_NAME;
  nameCap.append(name);
  box.append(nameCap);

  const hint = document.createElement('p');
  hint.className = 'field-hint';
  hint.textContent =
    'What the room is called, in the rail and in the line every member’s terminal receives.';
  box.append(hint);

  /* ------------------------------------------------------------ the list --- */

  const listCap = document.createElement('div');
  listCap.className = 'room-pick-cap';
  const listTitle = document.createElement('span');
  listTitle.className = 'room-pick-title';
  listTitle.textContent = 'Who is in it';
  const tally = document.createElement('span');
  tally.className = 'room-pick-tally';
  listCap.append(listTitle, tally);
  box.append(listCap);

  const list = document.createElement('div');
  list.className = 'room-pick-list';
  box.append(list);

  const note = document.createElement('p');
  note.className = 'modal-note';
  box.append(note);

  const row = document.createElement('div');
  row.className = 'modal-row';
  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = 'cancel';
  const create = document.createElement('button');
  create.className = 'ghost-btn primary';
  create.textContent = 'Make the room';
  row.append(cancel, create);
  box.append(row);

  /* ------------------------------------------------------------- state --- */

  // The chosen sessions, **by id and in the order they were ticked**, which is the order
  // `POST /api/rooms` will receive them in and therefore the order the room lists its
  // members in. A `Set` keeps both facts in one place; the ids are what travel, never a
  // row's position — a roster frame between the paint and the press would otherwise choose
  // whoever moved into that slot. (The retired peer-message picker carried the same rule.)
  const picked = new Set();
  let maxMembers = MAX_MEMBERS;

  // The folder in front of you: whichever session is open in a pane. Read once, with the
  // list, for the reason the list is read once. Nothing open is `null`, and then there is no
  // "here" and the roster's own order stands.
  const openId = panes.map((p) => p.selected()).find(Boolean) || null;
  const here = rowFolder(state.sessions.find((s) => s.id === openId));

  const rows = orderForHere(roomParticipants(state.sessions), here);

  const say = (text, cls = '') => {
    note.className = `modal-note ${cls}`;
    note.textContent = text;
  };

  /** The tally, the button and the standing line, from one place — so the Enter key and the
   *  button can never disagree about whether the press is allowed. */
  const sync = () => {
    tally.textContent = countLine(picked.size, maxMembers);
    tally.classList.toggle('is-full', picked.size >= maxMembers);
    create.disabled = !canCreate(name.value, picked.size);
  };

  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'room-pick-none';
    none.textContent =
      'No session on this Mac can be put in a room. Workers are not members — a worker’s ' +
      'channel is its lead — and a session with no live pane has nothing to type into.';
    list.append(none);
  }

  for (const s of rows) {
    const item = document.createElement('label');
    item.className = 'room-pick-row';

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    // The id travels on the node the way it travels in the request — never the row's index.
    tick.dataset.id = s.id;
    item.append(tick);

    const dot = document.createElement('span');
    dot.className = `dot ${s.status}`;
    item.append(dot);

    const label = document.createElement('span');
    label.className = 'room-pick-name';
    label.textContent = rowName(s);
    item.append(label);

    if (s.isLead) {
      const role = document.createElement('span');
      role.className = 'room-pick-role';
      role.textContent = 'lead';
      item.append(role);
    }

    const where = document.createElement('span');
    where.className = 'room-pick-where';
    where.textContent = s.project || '';
    where.title = s.paneCwd || s.cwd || '';
    item.append(where);

    tick.onchange = () => {
      if (tick.checked) {
        // Refused before the server has to refuse it. The tick goes back off rather than
        // being left on over a sentence that says it did not count — a control that lies
        // about its own state is worse than one that says no.
        if (picked.size >= maxMembers) {
          tick.checked = false;
          say(capRefusal(maxMembers), 'err');
          return;
        }
        picked.add(s.id);
      } else {
        picked.delete(s.id);
      }
      // Whatever the last refusal was about is answered or moot the moment the list moves.
      if (note.textContent) say('');
      sync();
    };

    list.append(item);
  }

  name.oninput = () => {
    if (note.textContent) say('');
    sync();
  };

  sync();

  /* ------------------------------------------------------------- close --- */

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  cancel.onclick = close;
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };
  document.addEventListener('keydown', onKey, true);

  // Enter in the name field is a shortcut for the button and is held to the button's own
  // rule — `canCreate`, the same function — so it cannot make a room the press would have
  // refused. With nothing ticked it says why instead of submitting, which is the one
  // keystroke a person is most likely to try on a card whose second half they have not
  // noticed yet.
  name.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (canCreate(name.value, picked.size)) return void submit();
    say(createReason(name.value, picked.size), 'err');
  };

  /* ------------------------------------------------------------ the press --- */

  async function submit() {
    create.disabled = true;
    say('Making the room…');
    try {
      const made = await postJSON('/api/rooms', {
        name: name.value.trim(),
        members: [...picked],
      });
      close();
      // Items 9/10's hook. The room exists on disk and in the next roster frame either way;
      // opening it is what makes the press feel finished.
      if (made.room?.id) openGroupRoom(made.room.id);
    } catch (err) {
      // The server's own sentence, **verbatim**. Every one of them names the thing that is
      // wrong — the character, the count, the session that has exited — and a paraphrase
      // here would be the panel's guess at a refusal it did not make.
      say(err.message, 'err');
      sync();
    }
  }
  create.onclick = submit;

  back.append(box);
  document.body.append(back);
  name.focus();

  // The cap, from the server that enforces it. Asked after the box is on screen rather than
  // before, so the list is never held behind a round trip; the constant above is what the
  // first frame draws with and what a failed call keeps. A cap that came back *lower* than
  // what has already been ticked is not unpicked — nothing is taken away from a reader
  // mid-choice — and the press is then refused by the 400, verbatim, which is the rung that
  // exists for exactly this.
  fetch('/api/rooms')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const cap = Number(data?.maxMembers);
      if (!cap || cap === maxMembers || !back.isConnected) return;
      maxMembers = cap;
      sync();
    })
    .catch(() => {
      /* the fallback stands, and the server refuses anything past its own cap anyway */
    });
}

function renderRail() {

  const live = state.sessions.length;
  const busy = state.sessions.filter((s) => s.status === 'working').length;
  // Both kinds of "stopped, wants a word from you": a permission box, and a question.
  const waiting = state.sessions.filter((s) => s.status === 'needs-decision' || s.question).length;
  const unread = state.sessions.filter((s) => s.unread > 0).length;

  // A snapshot saved once goes stale silently, so the button wears a dot the moment the
  // bench stops matching it. The count is in the dialog; the dot is the reminder to look.
  const drift = state.snapshot?.drift || { missing: [], extra: [] };
  el.snapshot.classList.toggle(
    'drifted',
    Boolean(state.snapshot?.savedAt) && Boolean(drift.missing.length || drift.extra.length),
  );

  el.railStat.textContent = '';
  for (const [label, n, cls] of [
    ['live', live, ''],
    ['busy', busy, busy ? 'stat-busy' : ''],
    ['waiting', waiting, waiting ? 'stat-waiting' : ''],
    ['unread', unread, unread ? 'stat-unread' : ''],
  ]) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = `${label} ${n}`;
    el.railStat.append(span);
  }

  // Pinned rows come out of everything else, inbox included — a pin is a promise about
  // where a session will be, and one that moved to the inbox the moment it asked you
  // something would break that promise exactly when you were looking for it. The badges
  // travel with the row, so nothing about why it wants you is lost.
  //
  // The inbox comes out of the project groups on the same principle: a session appears
  // once, and leaves the queue once you've dealt with it.
  const pinned = state.sessions
    .filter((s) => s.pinned)
    .sort((a, b) => (a.pinnedAt ?? Infinity) - (b.pinnedAt ?? Infinity));
  // A worker row comes out of the *inbox* on a related principle: a worker's permission
  // prompt is its *lead's* to answer and its finished report is its lead's to read — that
  // is what `worker_read` and the guarded answer endpoint exist for. So the lead gets first
  // refusal, and the maintainer sees the row only once `stuck` says it has actually been
  // abandoned there (`stuckAfterMinutes`, default 20).
  //
  // Note where this lives. `needsYou` itself is untouched, because `/api/team/tasks` puts
  // it on a task's `live` object and that is how `team_status` tells the *lead* one of its
  // workers is waiting. Quieting it at source would hush the maintainer's inbox by blinding
  // the one party now solely responsible for noticing. Change who gets hoisted, never the
  // flag.
  //
  // Leads are deliberately not covered: a lead asking the maintainer something is exactly
  // what should reach them. And it self-limits — `team` is gated on OPEN_STATES, so a closed
  // task takes the whole object with it and the row is an ordinary session again.
  const quietWorker = (s) => s.team?.role === 'worker' && !s.team.stuck;
  const inbox = state.sessions.filter((s) => !s.pinned && s.needsYou && !quietWorker(s));
  let rest = state.sessions.filter((s) => !s.pinned && (!s.needsYou || quietWorker(s)));

  // A team reads as one thing: a worker files under its lead's row, not under a folder
  // heading — the mapping comes from the task store (`workerOf`), never from paths. What
  // reaches here is every worker that isn't pinned and isn't stuck, which since the
  // quieting is most of them. A pinned worker sits where the pin promised.
  //
  // **Only leads that are actually drawn *here* collect workers, and `inInbox` is the whole
  // reason.** A lead in the inbox is drawn by `sessionRow` on its own, not by `rowsFor` —
  // so filing a worker under it hands that row to something which never renders it and the
  // session disappears from the rail outright: no folder heading, no group, nowhere. Same
  // class of failure as a blanked transcript, and the panel's worst.
  //
  // It was latent for as long as it existed, and only because of a rule that is now gone:
  // a worker that wanted anything hoisted itself into the inbox, so the ones left to nest
  // were quiet ones, and a lead being in the inbox at the same moment was rare enough that
  // nobody hit it. The quieting removed that accident — a blocked worker now *stays* here
  // to be nested — so this guard is load-bearing rather than tidy. Do not simplify it back
  // to `if (s.isLead)`; the depended-on rule is not coming back.
  //
  // Unnested, a worker falls back to its own folder heading, which is what the quieting
  // promised: out of the inbox, never off the screen.
  const inInbox = new Set(inbox.map((s) => s.id));
  const leadRows = new Map(); // repo -> lead session
  for (const s of state.sessions) if (s.isLead && !inInbox.has(s.id)) leadRows.set(s.paneCwd, s);
  const nestedWorkers = new Map(); // lead session id -> [workers]
  rest = rest.filter((s) => {
    if (!s.workerOf || !leadRows.has(s.workerOf)) return true;
    const lead = leadRows.get(s.workerOf);
    if (!nestedWorkers.has(lead.id)) nestedWorkers.set(lead.id, []);
    nestedWorkers.get(lead.id).push(s);
    return false;
  });

  // They arrive in the roster's order, which is recency — right for every other list in
  // this file and wrong here. A team is read as a block and a worker is found where it was
  // the last time you looked, so the nested rows are ordered once by dispatch time, newest
  // on top, and then hold still for as long as they run. `orderWorkers` is the whole rule;
  // it never throws and never drops a row. Sorted here, once, rather than inside `rowsFor`:
  // the answer must not depend on how many times a lead's row happens to be built.
  for (const [leadId, workers] of nestedWorkers) nestedWorkers.set(leadId, orderWorkers(workers));

  /** A row plus, when it is a lead, its nested workers — always used in its place. `fold`
   *  rides through to the top-level row only, and is `null` everywhere a folder kept its
   *  heading; a lead never folds, so a row that has workers never carries one. */
  const rowsFor = (s, fold = null) => {
    const rows = [sessionRow(s, fold)];
    for (const w of nestedWorkers.get(s.id) || []) {
      const row = sessionRow(w);
      row.classList.add('worker-row');
      rows.push(row);
    }
    return rows;
  };

  // Folders, in the order the roster hands them over — which is recency, so the folder
  // you were last in stays near the top of whatever holds it.
  const folders = new Map();
  for (const s of rest) {
    if (!folders.has(s.project)) folders.set(s.project, []);
    folders.get(s.project).push(s);
  }

  /**
   * What a folder draws: how many rows, and — when it holds exactly one — the split that
   * folds its heading into that row's own name.
   *
   * The count is taken over the **expanded** list, not over the folder map's entry, which
   * is the whole of `foldsInto`'s first half: `rowsFor` turns a lead into itself plus its
   * nested workers, so one entry can be four rows. It is also the number the heading
   * prints as `· N`, so the fold rule and the count can never disagree about what the
   * heading is about.
   *
   * `folder` rides on the answer because the `▾` the fold puts on the row's path files
   * *that* folder — the same `openFolderMenu` the heading carried, anchored one line down.
   */
  const foldOf = (f, list) => {
    const drawn = list.flatMap((s) => [s, ...(nestedWorkers.get(s.id) || [])]);
    if (!foldsInto(drawn)) return { rows: drawn.length, fold: null };
    const split = splitTitle(drawn[0]);
    return { rows: drawn.length, fold: split && { ...split, folder: f } };
  };

  const frag = document.createDocumentFragment();

  if (pinned.length) {
    frag.append(plainLabel(`pinned · ${pinned.length}`, 'pinned-label'));
    for (const s of pinned) frag.append(...rowsFor(s));
  }
  if (inbox.length) {
    frag.append(plainLabel(`needs you · ${inbox.length}`, 'inbox-label'));
    for (const s of inbox) frag.append(sessionRow(s));
  }

  // Flat: no shelving, no folder headings, just what moved last.
  //
  // Pinned and the inbox stay, because neither is a group you made — one is a promise
  // about where a row will be and the other is the queue of things that stopped for you.
  // What goes is the filing: on a morning where you know the session you want but not
  // which of nine folders it lives in, headings are three extra reads.
  // `rest` is already in recency order — the roster sorts by `lastActivity` once pinned
  // and blocked rows are out of it — so there is nothing to re-sort here.
  if (state.flatRail) {
    if (rest.length && (pinned.length || inbox.length)) {
      const rule = document.createElement('div');
      rule.className = 'rail-rule';
      frag.append(rule);
    }
    for (const s of rest) frag.append(...rowsFor(s));
    el.railList.replaceChildren(frag);
    renderSharedRow();
    renderRoomsBand();
    return;
  }

  // Groups you made, in the order you made them, above the folders that answer to nobody.
  const filed = new Set();
  for (const g of state.groups) {
    for (const f of g.folders) filed.add(f);
    const mine = g.folders.filter((f) => folders.has(f));
    const count = mine.reduce((n, f) => n + folders.get(f).length, 0);
    const busy = mine.reduce(
      (n, f) => n + folders.get(f).filter((s) => s.status === 'working').length,
      0,
    );

    // A heading over nothing is furniture. Empty is measured *after* hoisting, against the
    // rows this loop is about to draw — so a group whose only session is up in the inbox
    // reads as empty here and is right to: the row is on screen, two headings higher, and
    // the shelf it normally sits on has nothing on it. It comes back when the session does.
    if (!count) continue;

    // The group's colour, on every sibling the group owns.
    //
    // The rail is a flat list, so there is no container to set this on once — the spine is
    // tiled from the header, the folder headings and the rows the same way the tint is, and
    // each of them has to carry the hue itself. Everything that never comes through this
    // loop (a pinned row, an inbox row, an ungrouped folder) gets no `--h` at all, which is
    // what keeps its selected marker on the accent with no branch here or in the stylesheet.
    //
    // Re-set on every build, which is correct: `renderRail` rebuilds the rail from scratch
    // on every roster tick, so there is nothing here that has to survive a repaint.
    //
    // A record whose `colour` is not a slot gets nothing rather than `var(--group-undefined)`,
    // and the stylesheet's own `var(--h, var(--accent))` fallback draws it in the accent.
    // The store backfills on load, so this is a guard rather than a path.
    const hue = isGroupColour(g.colour) ? hueVar(g.colour) : null;
    const wear = (node) => {
      if (hue) node.style.setProperty('--h', hue);
      return node;
    };

    frag.append(wear(groupHeader(g, count, busy)));
    // Collapsing can't hide anything you need: a session that wants you is in the inbox
    // above, and a pinned one is above that. What's left in here is quiet by definition.
    if (g.collapsed) continue;
    let tail = null;
    for (const f of mine) {
      // A folder of one prints no heading — its name is the row's path, `▾` and all. The
      // row still wears the hue, so the spine runs through the gap the heading left.
      const { rows, fold } = foldOf(f, folders.get(f));
      if (!fold) frag.append(wear(folderHeading(f, true, rows)));
      for (const s of folders.get(f)) {
        for (const row of rowsFor(s, fold)) {
          row.classList.add('in-group');
          frag.append(wear(row));
          tail = row;
        }
      }
    }
    // The tinted block is tiled from siblings, so nothing in it knows where it ends. This
    // is what closes it off from whatever heading comes next.
    tail?.classList.add('in-group-last');
  }

  for (const [folder, list] of folders) {
    if (filed.has(folder)) continue;
    // Same fold at the foot of the rail as inside a group — the rule is about the folder,
    // not about what it is filed under. No hue out here, so nothing to wear.
    const { rows, fold } = foldOf(folder, list);
    if (!fold) frag.append(folderHeading(folder, false, rows));
    for (const s of list) frag.append(...rowsFor(s, fold));
  }

  el.railList.replaceChildren(frag);
  renderSharedRow();
  // A sibling band drawn from the same frame on the same beat, for the reason the line
  // below gives about the connections: every place that already redraws the rail is a place
  // this could otherwise go stale. It holds its own signature, so a beat that changed
  // nothing costs nothing.
  renderRoomsBand();
}

/* ------------------------------------------------------------- quota --- */

/**
 * The account's two subscription gauges, in the rail's head.
 *
 * A Claude subscription has a five-hour window and a weekly one, and when either runs out
 * every session on this machine stops. Claude Code already knows both numbers and hands
 * them to whatever draws the status line; a wrapper posts a copy to `POST /status`, the
 * server keeps the latest, and it rides the roster frame as `rateLimits`. This is the
 * whole of what the desktop does with it.
 *
 * **Every number-to-text and number-to-tone decision is `web/quota.js`'s**, not this
 * function's: which windows are worth drawing at all, 50 and 75, `2h10m` versus `Mon 5PM`, and
 * where fifteen minutes makes a record old. The phone draws the same pair from the same
 * module, and the failure mode of a second spelling is that both halves look right in
 * isolation and disagree on screen.
 *
 * Two things this file does decide, and both are omissions. Only `five_hour` and
 * `seven_day` are drawn — `windowsOf` carries an unrecognised third key through rather
 * than throwing on it, so the day `spend_limit` turns up on somebody's account the panel
 * is wrong by leaving it out rather than broken. And **no record draws nothing at all**:
 * not a zero, not a grey placeholder. `null` here is ordinary — a status line that was
 * never wrapped, an API-key account, a panel younger than the machine's last turn — and a
 * bar at 0% is a claim about a quota nobody has measured.
 */

/**
 * Half the finest bucket that can move, for `renderRoom`'s neighbour's reason on the
 * phone: `agoText`'s smallest step is a minute, so the age on screen is never more than
 * half a bucket behind, and ticking faster cannot change the string more often.
 *
 * `setInterval` rather than `requestAnimationFrame` — not merely because this is not an
 * animation, but because an automated Chrome window reports `document.visibilityState:
 * 'hidden'` and Chrome suspends rAF there, which makes a bench show a tick that never
 * fires and a bug that is not in this file.
 *
 * Its own timer beside the rail's rather than a second line inside that one, because the
 * two guard differently: `renderRail` repaints on every tick by design, and this must not
 * — nothing about the roster has moved, and on most ticks nothing here has either.
 */
const QUOTA_TICK_MS = 30_000;

let quotaSig = null;

function renderQuota(now = Date.now()) {
  const record = state.rateLimits;
  const windows = windowsOf(record, now).filter((w) => DRAWN_WINDOWS.has(w.key));
  const dim = staleness(record, now) === 'dim';
  // The one string the tick exists for. In the signature whether it is on screen or in the
  // tooltip, because a tooltip nobody repainted is a stale answer waiting under a cursor —
  // which is the whole of what an "as of" line is for.
  const age = agoText(record?.at);

  // Ordinary punctuation for the join, and every field the face reads is in it: `mergeSig`
  // once joined its rows with three literal control bytes that every editor drew as an
  // empty string, and a field drawn but not signed is a block that stops repainting on a
  // real change.
  const sig = windows.length
    ? [dim ? 'dim' : 'live', age, ...windows.map((w) => [w.key, w.pct, w.tone, formatReset(w.resetsAt, now)].join('|'))].join('~')
    : 'none';
  if (sig === quotaSig) return;
  quotaSig = sig;

  el.railQuota.classList.toggle('is-dim', dim && windows.length > 0);

  if (!windows.length) {
    // `:empty` is what hides the band, so emptying it is the whole of drawing nothing.
    el.railQuota.replaceChildren();
    el.railQuota.removeAttribute('title');
    return;
  }

  // Live, the age is the tooltip's whole job. Dim, it is already on screen a line below,
  // so the tooltip says the thing that is not visible instead: why a number can sit still
  // for an hour without anything being wrong.
  el.railQuota.title = dim
    ? `The account's limits, as of ${age} — the numbers only arrive while a session is taking a turn.`
    : `The account's limits, as of ${age}`;

  const frag = document.createDocumentFragment();
  for (const win of windows) frag.append(quotaRow(win, now));
  if (dim) {
    const line = document.createElement('div');
    line.className = 'quota-age';
    line.textContent = `as of ${age}`;
    frag.append(line);
  }
  el.railQuota.replaceChildren(frag);
}

/** The two windows this panel has anything to draw for. See `renderQuota`'s header for
 *  why an unrecognised third one is left out rather than guessed at. */
const DRAWN_WINDOWS = new Set(['five_hour', 'seven_day']);

/** `5h 42% · resets 2h10m`, over a hairline bar. The tone is set once on the row and read
 *  as `currentColor` by both the percentage and the fill, so a row can never be amber in
 *  its text and neutral in its bar. */
function quotaRow(win, now) {
  const row = document.createElement('div');
  row.className = `quota-row${win.tone ? ` ${win.tone}` : ''}`;

  const line = document.createElement('div');
  line.className = 'quota-line';

  const name = document.createElement('span');
  name.className = 'quota-win';
  name.textContent = win.label;

  const pct = document.createElement('span');
  pct.className = 'quota-pct';
  // Rounded on the face and exact in the bar: the type is not promised — the captures were
  // integers and the documentation shows `23.5` — and `42.7%` in a 0.62rem mono line is
  // three characters of precision nobody can act on.
  pct.textContent = `${Math.round(win.pct)}%`;

  const reset = document.createElement('span');
  reset.className = 'quota-reset';
  reset.textContent = `· resets ${formatReset(win.resetsAt, now)}`;

  line.append(name, pct, reset);

  const bar = document.createElement('div');
  bar.className = 'quota-bar';
  const fill = document.createElement('div');
  fill.className = 'quota-fill';
  fill.style.width = `${win.pct}%`;
  bar.append(fill);

  row.append(line, bar);
  return row;
}

function plainLabel(text, cls) {
  const label = document.createElement('div');
  label.className = `group-label ${cls}`;
  label.textContent = text;
  return label;
}

/**
 * A folder heading, and the menu that files it.
 *
 * The heading is derived — it's `basename(cwd)` and always has been — so the menu is the
 * only thing here you chose. It stays out of sight until the row is hovered, like the pin.
 *
 * **Drawn only for a folder that did not fold**, so every heading on screen is about two
 * rows or more, and `· N` is the same number the fold rule was decided on — `foldOf` takes
 * it once and hands it to both. It counts the rows beneath it and not the sessions, which
 * is why a lead with three workers reads `· 4`; the *group* header's own `· N` deliberately
 * disagrees, counting top-level rows only, and that is today's arithmetic left alone.
 */
function folderHeading(folder, inGroup, count = 0) {
  const row = document.createElement('div');
  row.className = `group-label folder-label${inGroup ? ' in-group' : ''}`;

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder;
  name.title = folder;
  row.append(name);

  // Never zero in practice — `renderRail` only builds a heading for a folder with rows
  // under it, and a folder of exactly one folded instead. Guarded rather than asserted
  // because a `· 0` beside a name is furniture, the same call `.room-unseen` and the
  // group heading's own count already make.
  if (count > 0) {
    const n = document.createElement('span');
    n.className = 'folder-count';
    n.textContent = `· ${count}`;
    n.title = `${count} session${count === 1 ? '' : 's'} in ${folder}`;
    row.append(n);
  }

  const menu = document.createElement('button');
  menu.className = 'label-menu';
  menu.textContent = '▾';
  menu.title = `File ${folder} under a group`;
  menu.onclick = (e) => {
    e.stopPropagation();
    openFolderMenu(menu, folder);
  };
  row.append(menu);
  return row;
}

/** A group you made: click the header to fold it away, `⋯` to rename or drop it. */
function groupHeader(g, count, busy = 0) {
  const row = document.createElement('div');
  row.className = `group-label shelf-label${g.collapsed ? ' collapsed' : ''}`;

  const toggle = document.createElement('button');
  toggle.className = 'shelf-toggle';
  toggle.setAttribute('aria-expanded', String(!g.collapsed));
  toggle.title = g.collapsed ? `Open ${g.name}` : `Collapse ${g.name}`;
  toggle.onclick = () => setGroupCollapsed(g, !g.collapsed);

  const caret = document.createElement('span');
  caret.className = 'shelf-caret';
  caret.textContent = g.collapsed ? '▸' : '▾';
  toggle.append(caret);

  const name = document.createElement('span');
  name.className = 'shelf-name';
  name.textContent = g.name;
  toggle.append(name);

  const n = document.createElement('span');
  n.className = 'shelf-count';
  // Never zero: `renderRail` doesn't call this for a group with nothing to draw. The
  // trade is deliberate and worth knowing — a group with no live sessions anywhere in it
  // has no heading to rename or delete from until one of its folders wakes up. Its
  // folders can still be re-filed from the folder menu, which lists every group.
  n.textContent = `· ${count}`;
  toggle.append(n);

  // Folded away, and something inside it is running.
  //
  // Collapsing is only safe because the inbox hoists anything blocked or unread out of its
  // folder first — but *working* is neither, so a busy session is the one thing a closed
  // group can genuinely hide. The same pulsing dot the rows use, on the heading standing in
  // for them. Not drawn when open, where every row shows its own.
  if (g.collapsed && busy) {
    const dot = document.createElement('span');
    dot.className = 'dot working shelf-dot';
    dot.title = `${busy} session${busy === 1 ? '' : 's'} working in here`;
    toggle.append(dot);
  }

  row.append(toggle);

  // The header's two controls, in the order they are drawn: add, then the rest.
  //
  // Both are **permanently visible at 40%** rather than appearing on hover the way the
  // folder heading's `▾` does, and the difference is what each one is for. A folder is filed
  // from its own heading, which you are already pointing at; a group's `+` is reached
  // *because* you know the group and not the folder, and a control you have to discover by
  // hovering the thing you were not looking for is a control that does not exist. 40% is the
  // same trade the row's pin makes in reverse — present enough to find, quiet enough that a
  // rail of nine groups is not eighteen glyphs shouting.
  //
  // No layout change buys it: `.label-menu` already reserves its 1.1rem while invisible, so
  // a second one adds width and not height, and the sticky offset the folder headings hang
  // off `.shelf-label` is measured against a height that does not move.
  const add = document.createElement('button');
  add.className = 'label-menu';
  add.textContent = '+';
  add.title = `Add a folder to ${g.name}`;
  add.setAttribute('aria-label', `Add a folder to ${g.name}`);
  add.onclick = (e) => {
    // The header itself is the collapse toggle, and this button is inside it in reading
    // order but not in the DOM — stopping propagation anyway, because the `⋯` beside it has
    // always had to and one of the two behaving differently is the sort of thing nobody
    // notices until a click folds the group it was trying to add to.
    e.stopPropagation();
    openGroupAddMenu(add, g);
  };
  row.append(add);

  const menu = document.createElement('button');
  menu.className = 'label-menu';
  menu.textContent = '⋯';
  menu.title = `Rename, recolour or delete ${g.name}`;
  menu.setAttribute('aria-label', `Rename, recolour or delete ${g.name}`);
  menu.onclick = (e) => {
    e.stopPropagation();
    openGroupMenu(menu, g);
  };
  row.append(menu);
  return row;
}

/** The row's name as it has always read: the whole title, ellipsised. */
function plainTitle(s) {
  const title = document.createElement('span');
  title.className = 'session-title';
  title.textContent = s.title;
  title.title = s.title;
  return title;
}

/**
 * The row's name when its folder folded into it: `alpha ▾ / main`.
 *
 * Three parts and a control. The **path** is the folder — at weight 500, and at full ink:
 * nothing in a session name is dimmed (the maintainer's own ruling), so the path and the
 * leaf are told apart by weight alone and never by fading one of them. The **leaf** is
 * bold and is the only part that gives way, because it is the half that can be long. The
 * `/` between them is punctuation rather than name, and takes the muted tone the heading's
 * own `· N` wears.
 *
 * The **`▾`** is the folder heading's menu, one line down: same `openFolderMenu`, same
 * three parts, anchored on the path it now belongs to. It is a real `<button>`, which is
 * legal here for exactly one reason — the row around it stopped being one (see
 * `sessionRow`) — and it **stops propagation on both click and keydown**, or pressing the
 * menu would open the session underneath it as well.
 */
function foldedTitle(s, fold) {
  const title = document.createElement('span');
  title.className = 'session-title is-folded';
  title.title = s.title;

  const path = document.createElement('span');
  path.className = 'title-path';
  path.textContent = fold.path;
  title.append(path);

  const menu = document.createElement('button');
  menu.className = 'label-menu fold-menu';
  menu.textContent = '▾';
  menu.title = `File ${fold.folder} under a group`;
  menu.onclick = (e) => {
    e.stopPropagation();
    openFolderMenu(menu, fold.folder);
  };
  // The row answers Enter and Space itself now, and keydown bubbles — so without this,
  // Enter on the `▾` would open the menu *and* the session behind it.
  menu.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  };
  title.append(menu);

  const sep = document.createElement('span');
  sep.className = 'title-sep';
  sep.textContent = '/';
  sep.setAttribute('aria-hidden', 'true');
  title.append(sep);

  const leaf = document.createElement('span');
  leaf.className = 'title-leaf';
  leaf.textContent = fold.leaf;
  title.append(leaf);

  return title;
}

/** One rail row: status dot, name, badges, and the pin that hangs off the end. */
/** Sessions with a duplicate in flight. Module scope because the rows are transient. */
const duplicating = new Set();

function sessionRow(s, fold = null) {
  // The pin is a button and a button cannot live inside another one — hence the wrapper,
  // which also carries the hover and selected states so they cover the pin as well.
  const row = document.createElement('div');
  row.className = `session-row${s.pinned ? ' is-pinned' : ''}${s.isLead ? ' is-lead' : ''}`;

  /*
   * **`.session` is a `div role="button"`, not a `<button>`, and uniformly so.**
   *
   * The reason is one line down: when a folder folds, its `▾` rides the row's own title,
   * and interactive content cannot nest — a `<button>` inside a `<button>` is invalid, and
   * so is a `<span role="button" tabindex="0">` inside one, because the restriction is on
   * interactive content and not on the tag. Every row is built this way and not only the
   * folded ones: two element types for one row, differing by whether a folder happened to
   * hold one session, is two focus behaviours and two sets of CSS to keep honest.
   *
   * What had to be carried over from the `button {}` reset at the top of `styles.css` is
   * `cursor: pointer`, and only that — `font` and `color` already inherit on a div, and
   * `background: none` / `border: none` are a div's own defaults. Nothing in the stylesheet
   * selects `button.session`; every rule is a class, and `test/rail-fold.test.js` pins it.
   *
   * `aria-current` rather than the `aria-selected` this node used to carry: that attribute
   * is invalid on a `<button>` and invalid on `role="button"` alike — it belongs to
   * `option`, `tab` and friends — and "the row whose session is open" is exactly what
   * `aria-current` is for. Set only when true, since `aria-current="false"` on every other
   * row is noise a screen reader has to walk past.
   */
  const btn = document.createElement('div');
  btn.className = `session${s.unread > 0 ? ' has-unread' : ''}`;
  btn.setAttribute('role', 'button');
  btn.tabIndex = 0;
  const isOpen = panes.some((p) => p.selected() === s.id);
  if (isOpen) {
    btn.setAttribute('aria-current', 'true');
    row.classList.add('is-open');
  }
  btn.onclick = () => openSession(s.id);
  // The keyboard half of `role="button"`: a real button answers Enter and Space and a div
  // answers neither, so both are wired by hand. `preventDefault` is for Space, which
  // otherwise scrolls the rail out from under the row it just opened.
  btn.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openSession(s.id);
  };

  const dot = document.createElement('span');
  dot.className = `dot ${s.status}`;
  btn.append(dot);

  const mark = bindingMark(s);
  if (mark) btn.append(mark);

  btn.append(fold ? foldedTitle(s, fold) : plainTitle(s));

  if (s.unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = s.unread > 99 ? '99+' : s.unread;
    badge.title = `${s.unread} unread ${s.unread === 1 ? 'reply' : 'replies'}`;
    btn.append(badge);
  }

  const meta = document.createElement('span');
  meta.className = 'session-meta';

  // The `lead` badge used to sit here. It moved to the third line below — see `teamLine`
  // — rather than being duplicated there: the meta line is for *state* (bypassing, asking,
  // queued), and a role is not state. It went down unchanged, same chip, same accent, so
  // nothing got quieter; it just stopped competing with the four things beside it.

  // Permission prompts are off in this one. First on the line, and in Claude Code's own
  // word for it, because it changes what every other thing on the row means — a session
  // that will never stop to ask is not the same kind of thing as one that will.
  if (s.bypass) {
    const bypass = document.createElement('span');
    bypass.className = 'bypass-badge';
    bypass.textContent = 'bypass';
    bypass.title = 'Permission prompts are off — this session edits and runs without asking';
    meta.append(bypass);
  }

  // The row's own reason for being at the top of the rail. Without it a question
  // sits in the inbox with nothing saying why.
  if (s.question) {
    const asks = document.createElement('span');
    asks.className = 'asks-badge';
    asks.textContent = s.question.kind === 'review' ? 'confirm' : 'asking';
    asks.title = s.question.question;
    meta.append(asks);
  }

  // Only ever shown when something is waiting, so it costs a row nothing the rest
  // of the time — and when it does show, it's the reason you'd come back.
  if (s.queued?.length) {
    const q = document.createElement('span');
    q.className = 'queued-badge';
    q.textContent = `⧗ ${s.queued.length}`;
    q.title = `${s.queued.length} message${s.queued.length === 1 ? '' : 's'} waiting to send`;
    meta.append(q);
  }

  const when = document.createElement('span');
  // Duration first, word second — this slot is a duration column in every state, on an
  // idle row as well as a working one, and the word is the amber note attached to it.
  if (s.activity) {
    if (s.activitySeconds != null) {
      const dur = document.createElement('span');
      dur.textContent = `${formatWorkingDuration(s.activitySeconds)} `;
      when.append(dur);
    }
    const word = document.createElement('span');
    word.className = 'activity-word';
    word.textContent = `${s.activity}…`;
    when.append(word);
  } else {
    when.textContent = relativeTime(s.lastActivity);
  }
  meta.append(when);

  if (s.model) {
    const model = document.createElement('span');
    model.textContent = shortModel(s.model);
    model.title = s.model;
    meta.append(model);
  }
  // Beside the model, because the two are read as one answer to "what is this session
  // running as". It reads off the transcript rather than the footer, so unlike the model
  // it survives a session sitting on a question box — expect rows showing effort and no
  // model, which is the honest picture and not a bug.
  if (s.effort) meta.append(effortEl(s.effort));
  if (s.contextPct != null) meta.append(ctxEl(s.contextPct));
  // How the pane and the transcript were paired is the padlock under the dot now — the
  // word here said the same thing twice, and only for one of the three cases.

  btn.append(meta);

  // The third line, on team sessions only. Every other row in the rail stays two lines —
  // that is the whole reason this shape was chosen over a stripe or another badge, so
  // don't generalise it to rows that have nothing to say here.
  if (s.team) btn.append(teamLine(s.team, s));

  row.append(btn);

  // One reserved column, two buttons stacked in it — so adding the second costs the title
  // no width. Reserved whether or not they show, per `.pin-btn`: a row must not reflow
  // under the cursor that is about to click something on it.
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const pin = document.createElement('button');
  pin.className = 'pin-btn';
  pin.textContent = s.pinned ? '★' : '☆';
  pin.setAttribute('aria-pressed', String(Boolean(s.pinned)));
  pin.title = s.pinned ? 'Unpin — let this session sort with the rest' : 'Pin to the top of the rail';
  pin.onclick = (e) => {
    e.stopPropagation(); // the wrapper is not clickable, but the row beside it is
    togglePin(s);
  };
  actions.append(pin);

  // Another session in the same folder, named after this one. Nothing to duplicate into
  // if the pane never reported a directory.
  if (s.paneCwd) actions.append(dupBtn(s));
  if (s.interactive) actions.append(closeBtn(s));

  row.append(actions);

  return row;
}

/**
 * The role line: what part this row plays on a team, and the one fact worth the width.
 *
 * Only team sessions get it. A lead is one per project and a worker belongs to an *open*
 * task — the server closes that door (`openTaskFor`), so a session whose task merged or
 * failed comes back here as `null` and the row is two lines again rather than advertising
 * a branch that has been swept.
 *
 * The chip is the `lead` badge that used to live on the meta line, moved down whole. The
 * fact beside it is the half that can be long — a branch name is not short and the rail is
 * not wide — so it, and only it, ellipsises; the chip and the row's own controls never get
 * squeezed by it.
 */
function teamLine(team, s) {
  const line = document.createElement('span');
  line.className = 'session-team';

  const chip = document.createElement('span');
  chip.className = `role-chip is-${team.role}`;
  chip.textContent = team.role;
  line.append(chip);

  const fact = document.createElement('span');
  fact.className = 'team-fact';
  // Anything that trails the fact. Held rather than appended where it is decided, because
  // the fact is appended last (below) and reads first — the line is chip, fact, then this.
  let after = null;

  if (team.role === 'lead') {
    // Open tasks, not every task ever — `done` and `failed` pile up for the life of the
    // team, and a lead reading `lead · 47 tasks` would be telling you nothing about today.
    const n = team.tasks || 0;
    fact.textContent = n ? `${n} task${n === 1 ? '' : 's'}` : 'no tasks';
    line.title = 'Team lead — coordinates workers on this project; cannot edit files or commit';

    // A task in `review` is business for the maintainer — either the lead still has to open
    // the PR, or it has and the PR is waiting on their merge word — and that is a fact about
    // the *task*, not about whether the maintainer happens to have clicked into a
    // transcript. `needsYou` used to sit here and was the wrong fact for it: one of its
    // four conditions is `unread > 0`, the panel viewer's own read state, so the count
    // dropped to zero the moment the maintainer looked at a worker even though nothing had
    // been handled.
    //
    // Zero draws nothing. A `· 0` is furniture, the same reason an empty group draws no
    // heading. And it goes on the line that already exists — a team row is three lines
    // tall and a fourth would undo the trade that bought the third.
    const review = team.review || 0;
    if (review) {
      after = document.createElement('span');
      after.className = 'team-review';
      after.textContent = `· ${review} in review`;
      line.title = `Team lead — ${review} task${review === 1 ? '' : 's'} in review, waiting on you`;
    }
  } else {
    // The branch is what you would type into git, and it names the task either way
    // (`agent/<id>`). A task dispatched without one falls back to the id, which is the
    // thing that is never missing.
    fact.textContent = team.branch || team.task;
    fact.title = team.branch || team.task;
    line.title = `Worker on task ${team.task} — ${team.state}${team.branch ? ` · ${team.branch}` : ''}`;
  }

  line.append(fact);
  if (after) line.append(after);
  return line;
}

/**
 * Start another session where this one is running.
 *
 * A duplicate of a session with permission prompts off is also one, so the button wears
 * the same colour as the `bypass` badge above it and says as much before you press it.
 * That is the whole warning: a modal would defeat the point of a one-click shortcut, and
 * the consequence is a session you can close, not a keystroke you can't take back.
 */
function dupBtn(s) {
  const dup = document.createElement('button');
  dup.className = `dup-btn${s.bypass ? ' is-bypass' : ''}`;
  dup.textContent = '⧉';
  const folder = s.paneCwd.split('/').filter(Boolean).at(-1) || s.paneCwd;
  dup.title = s.bypass
    ? `Start another session in ${folder} — with permission prompts off, like this one`
    : `Start another session in ${folder}`;

  // The row is rebuilt from scratch on every roster broadcast, so `disabled` on this node
  // is wiped long before the launch returns. The flag has to outlive the button.
  if (duplicating.has(s.id)) {
    dup.disabled = true;
    dup.classList.add('is-busy');
  }

  dup.onclick = async (e) => {
    e.stopPropagation();
    if (duplicating.has(s.id)) return;
    duplicating.add(s.id);
    dup.disabled = true;
    dup.classList.add('is-busy');
    try {
      const made = await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/duplicate`, {});
      if (made.sessionId) openSession(made.sessionId);
    } catch (err) {
      dup.title = err.message;
      dup.classList.add('is-error');
    } finally {
      duplicating.delete(s.id);
    }
  };
  return dup;
}

/**
 * Close the session — `/exit`, typed for you.
 *
 * Drawn rather than typed, for the reason the padlock is: a font glyph at eleven pixels
 * sits on a baseline and never lines up in a column of icons, and the emoji bin is a
 * coloured blob at this size. Three shapes at a fixed viewBox read as a bin and stay put.
 *
 * Always behind a confirmation, because this is the one control in the rail you cannot
 * undo. Everything else here is a toggle.
 */
function closeBtn(s) {
  const btn = document.createElement('button');
  btn.className = 'close-btn';
  btn.title = `Close ${s.title} — ends the session`;
  btn.setAttribute('aria-label', `Close ${s.title}`);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');

  // The lid, drawn as one stroke across with the handle sitting on top of it.
  const lid = document.createElementNS(SVG_NS, 'path');
  lid.setAttribute('d', 'M1.9 3.1 H10.1 M4.6 3.1 V2.2 a0.7 0.7 0 0 1 0.7-0.7 h1.4 a0.7 0.7 0 0 1 0.7 0.7 V3.1');
  lid.setAttribute('fill', 'none');
  lid.setAttribute('stroke', 'currentColor');
  lid.setAttribute('stroke-width', '1.1');
  lid.setAttribute('stroke-linecap', 'round');
  svg.append(lid);

  // The body tapers, which is what stops it reading as a plain rectangle at this size.
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M3 4.3 L3.5 10.1 a0.6 0.6 0 0 0 0.6 0.55 h3.8 a0.6 0.6 0 0 0 0.6-0.55 L9 4.3 Z');
  body.setAttribute('fill', 'none');
  body.setAttribute('stroke', 'currentColor');
  body.setAttribute('stroke-width', '1.1');
  body.setAttribute('stroke-linejoin', 'round');
  svg.append(body);

  btn.append(svg);
  btn.onclick = (e) => {
    e.stopPropagation();
    confirmClose(s);
  };
  return btn;
}

/**
 * The one modal in the panel that guards something irreversible.
 *
 * It names the session, its folder, and what is going on in it right now — a session
 * that is mid-task looks exactly like an idle one in a list of fourteen rows, and "are
 * you sure?" over a bare name is not enough to tell them apart.
 */
function confirmClose(s) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal';

  const h = document.createElement('h2');
  h.textContent = 'Close this session?';
  box.append(h);

  const what = document.createElement('p');
  what.className = 'field-hint';
  what.style.fontSize = '0.8rem';
  what.style.color = 'var(--ink)';
  what.textContent = s.title;
  box.append(what);

  const where = document.createElement('p');
  where.className = 'field-hint';
  const bits = [s.paneCwd || s.cwd || '', s.tmuxSession || ''].filter(Boolean);
  where.textContent = bits.join('  ·  ');
  box.append(where);

  const state = document.createElement('p');
  state.className = 'field-hint';
  state.textContent =
    s.status === 'working'
      ? `It is working right now${s.activity ? ` (${s.activity}…)` : ''} — that will be cut off.`
      : 'Sends /exit. The terminal closes with it; the transcript stays on disk.';
  if (s.status === 'working') state.style.color = 'var(--decision)';
  box.append(state);

  const note = document.createElement('p');
  note.className = 'modal-note';
  box.append(note);

  const row = document.createElement('div');
  row.className = 'modal-row';
  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = 'cancel';
  const go = document.createElement('button');
  go.className = 'ghost-btn danger';
  go.textContent = 'close it';
  row.append(cancel, go);
  box.append(row);

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey, true);
  cancel.onclick = close;
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };

  go.onclick = async () => {
    go.disabled = true;
    cancel.disabled = true;
    note.className = 'modal-note';
    note.textContent = 'Sending /exit…';
    try {
      await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/exit`, {});
      close();
    } catch (err) {
      note.className = 'modal-note err';
      note.textContent = err.message;
      go.disabled = false;
      cancel.disabled = false;
    }
  };

  back.append(box);
  document.body.append(back);
  // Cancel takes the focus, not the button that ends a session.
  cancel.focus();
}

/**
 * A task's brief, opened by clicking its row. Read-only, and that is the design.
 *
 * "What did we actually ask this thing to do?" is a question you have as often about a
 * worker that has gone sideways as about an idea nobody has started, so it is on every
 * row whatever its state — not just the pending ones.
 *
 * No start, no drop, no edit field. Two rules point the same way: destructive things ask
 * once in place rather than in a dialog that blocks the tab (see `confirmClose`), and a
 * panel control that started a worker would bypass the lead, which is where a brief gets
 * written in the first place. If editing a brief turns out to be wanted, that is its own
 * decision and not a button that appears while this one is open.
 *
 * It is also why this is a modal rather than the brief rendered inline in the row: inline
 * means clamping, clamping means testing `scrollHeight > clientHeight`, and CLAUDE.md
 * carries three separate traps about that measurement from the room's five-line clamp.
 * A modal shows the whole thing and measures nothing.
 *
 * The task object is snapshotted at open and never live-updates — right for a brief that
 * barely changes, and it keeps this out of `renderTasks` entirely. Which is the other
 * half: that function rebuilds every row node on the three-second poll, so this mounts on
 * `document.body`. A dialog parented to a row would vanish out from under its reader.
 *
 * @param {object} t the task record
 * @param {string} chipState the *derived* state (`taskChipState`), so a worker sitting on
 *   a question box reads `blocked` here exactly as it does on the row it was opened from
 */
function openTaskBrief(t, chipState) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal is-wide';

  const h = document.createElement('h2');
  h.textContent = t.id; // the name every other part of the system uses
  box.append(h);

  // One short line per fact, and nothing for a fact that isn't there — an empty `model`
  // row would read as a claim about the model rather than an absence of one.
  const meta = document.createElement('dl');
  meta.className = 'task-meta';
  const fact = (label, value) => {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  };
  fact('state', chipState);
  fact('kind', t.kind);
  fact('model', t.model);
  // The lead's justification for departing from the team default, on its own line. This is
  // the line the maintainer wants visible: it is the only place a model choice can be
  // judged after the sentence that argued for it has scrolled out of the room.
  fact('why', t.modelReason);
  fact('source', t.source);
  fact('branch', t.branch);
  if (t.kind === 'plan') fact('plan', t.planFile);
  fact('created', agoText(t.createdAt));
  fact('updated', agoText(t.updatedAt));
  if (meta.childElementCount) box.append(meta);

  const body = document.createElement('div');
  // `plan-md` gives the brief the same rendered-markdown typography and box treatment as
  // the plan reader below it — one set of heading/list/code rules, not two drifting ones.
  body.className = 'task-brief-body plan-md';
  if (t.body) {
    body.innerHTML = withBlankTargets(marked.parse(t.body));
  } else {
    // A markdown parse of the empty string must not turn this into a blank box.
    body.textContent = 'No brief was recorded.';
    body.style.color = 'var(--ink-faint)';
  }
  box.append(body);

  // A planner's deliverable is a document, so the one place you look at the task shows it
  // — collapsed, below the brief. Every other kind of row is unchanged.
  if (t.kind === 'plan') box.append(taskPlanReader(t));

  const row = document.createElement('div');
  row.className = 'modal-row';
  const done = document.createElement('button');
  done.className = 'ghost-btn';
  done.textContent = 'close';
  row.append(done);
  box.append(row);

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey, true);
  done.onclick = close;
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };

  back.append(box);
  document.body.append(back);
  done.focus();
}

/**
 * The plan file for a `kind: 'plan'` task, inside the brief modal. `planReader`'s shape
 * with two things changed — the endpoint and the response field.
 *
 * Collapsed, always. A brief is a few hundred words; a plan runs to thousands, and a
 * modal that opened into a wall of markdown with the brief pushed off the top is the
 * failure this whole feature is avoiding. One click, and the brief is still above it.
 *
 * Fetched on first expand, once — never on render. A fetch wired into the row builder
 * would hit this endpoint once per row every three seconds.
 *
 * Deliberately **not** gated on `OPEN_STATES`, on a live session, or on the task not
 * being `done`: closing a plan task removes its worktree and branch and leaves the plan
 * in the team folder, `gc.js` excludes it from the artefact sweep, and the endpoint has
 * no state check. So this keeps working after close — and that is the case that makes it
 * worth having, because it is then the only way to reread a plan whose planner is gone.
 */
function taskPlanReader(t) {
  const box = document.createElement('details');
  box.className = 'plan-file';

  const summary = document.createElement('summary');
  const file = t.planFile || '';
  // A pending planner has no `planFile` yet — it is stamped at dispatch — so there is no
  // filename to name and the word does the job. The 404 below supplies the path.
  summary.textContent = file.split('/').filter(Boolean).at(-1) || 'plan';
  if (file) summary.title = file;
  box.append(summary);

  const md = document.createElement('div');
  md.className = 'plan-md';
  md.textContent = 'reading…';
  box.append(md);

  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    try {
      const res = await fetch(`/api/team/plans/${encodeURIComponent(t.id)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.text === 'string') {
        md.innerHTML = withBlankTargets(marked.parse(data.text));
        return;
      }
      loaded = false; // let the next open retry
      // `data.error` verbatim, never a message of our own. That endpoint answers four
      // ways and one of them is unreachable from here by construction; a sentence we
      // wrote would make the case nobody predicted say something untrue.
      md.textContent = data.error || `Could not read it (${res.status}).`;
      // The "not written yet" 404 also carries where it will land, which is half the
      // answer — a pending planner reads "no plan yet", and then the file to watch.
      if (data.path) {
        const where = document.createElement('div');
        where.className = 'plan-md-path';
        where.textContent = data.path;
        md.append(where);
      }
    } catch (e) {
      loaded = false;
      md.textContent = e.message;
    }
  });
  return box;
}

/* =============================================================== images === */

/**
 * Where an image's bytes come from.
 *
 * The transcript frame carries the *name* of an image — `{uuid, index, media}`, the
 * ordinal `normalize.js` walked it out under — and never the base64. One screenshot is
 * ~60KB and nine of them were 19% of a 2.9MB transcript; inlining them would make the
 * socket resend them on every subscribe and give the browser nothing to cache. This URL
 * is immutable (a record is written once, its bytes never change) and the server says so,
 * so each thumbnail is fetched exactly once however often the strip repaints.
 */
function imageSrc(sessionId, ref) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/image/${encodeURIComponent(ref.uuid)}/${ref.index}`;
}
/**
 * One thing from this session, big, over everything.
 *
 * This started as the image lightbox and is still that on an image — same class, same
 * keys, same click-anywhere-to-close — widened so a *document* from the files modal opens
 * in it too. One overlay rather than two, because everything that made the image one worth
 * keeping is the part a document needs as well: it is the thing on top, it owns Escape,
 * and the list that opened it is already in hand so the arrow keys cost two lines and no
 * chrome.
 *
 * Four things about it, each of which is a rule rather than a preference:
 *
 *   **The renderer is `web/files-preview.js`'s answer, never a switch written here.** That
 *   module is DOM-free and tested in plain Node, and the one decision it exists for is the
 *   one that must never quietly relax: an `.html` or `.svg` **document** is shown as text.
 *   No `innerHTML`, no `iframe`, and no `<img>` either — an `<img>` of an SVG document is
 *   §7 rule 4 broken one element over. An SVG that arrived as an image *block* keeps its
 *   `<img>`, and only `source` tells those two apart.
 *
 *   **Markdown goes through `withBlankTargets`, like every other `marked.parse` here.** A
 *   link inside a document the session wrote would otherwise navigate the panel itself
 *   away and drop every subscription in both panes.
 *
 *   **The arrow keys walk the list the reader can currently see, and skip a link.** The
 *   modal hands over its *filtered* list, so stepping never leaves the set the pills say is
 *   on screen; a link is an anchor in the grid and never opens this, so it is filtered out
 *   of the walk rather than skipped mid-step — which is also what keeps `N / M` honest.
 *
 *   **An action is drawn only when the entry can answer it.** A pasted screenshot has no
 *   path and gets the picture and nothing else — the trust gate's discipline, which draws
 *   no button rather than a dead one, and three images in four on this Mac are pastes or
 *   automation screenshots.
 *
 * `src` is a parameter because the two callers address bytes in different spaces: the
 * per-turn strip's refs are image blocks (`/image/:uuid/:index`) while the files modal's
 * entries are outputs (`/output/:uuid/:index`, which also serves a `Write`'s and a
 * `SendUserFile`'s bytes). One function, two address spaces, and the caller that knows
 * which one it is in says so.
 */
/**
 * Where one output's bytes live — a record and an ordinal, never a path.
 *
 * Module scope because there are two callers now and they are nowhere near each other: the
 * files modal's grid and list, and a path link in the conversation. One spelling of an
 * address the server re-derives is the point of the address space — `server/index.js`'s
 * byte route says the long version.
 */
const outputSrcFor = (sessionId, item) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/output/${encodeURIComponent(item.uuid)}/${item.index}`;

function openLightbox(sessionId, items, start = 0, { src = imageSrc } = {}) {
  // A link never opens this (§7 rule 3), so it is out of the walk entirely rather than
  // skipped on the way past — which is what makes the position counter mean something.
  const steps = (items || []).filter(previewable);
  if (!steps.length) return;
  const clicked = (items || [])[start];
  let at = Math.max(0, steps.indexOf(clicked));

  // Bumped on every paint, so a fetch that comes back after the reader has already
  // arrowed on paints nothing. The byte route is `immutable` for a record, so stepping
  // back is a browser-cache hit and there is nothing here to cache a second time.
  let seq = 0;

  const back = document.createElement('div');
  back.className = 'modal-back lightbox';

  const fig = document.createElement('figure');
  fig.className = 'lightbox-fig';

  // The action row. Hidden rather than empty when there is nothing to draw, so a pathless
  // image is byte-identical to the overlay before this existed.
  const head = document.createElement('div');
  head.className = 'lightbox-head';

  const img = document.createElement('img');
  img.className = 'lightbox-img';

  // The document panel: a surface the text is legible on, over a scrim built for a photo.
  const doc = document.createElement('div');
  doc.className = 'lightbox-doc';
  const page = document.createElement('div');
  page.className = 'lightbox-page';
  doc.append(page);

  const cap = document.createElement('figcaption');
  cap.className = 'lightbox-cap';
  fig.append(head, img, doc, cap);
  back.append(fig);

  /** `copy path`, and the flash that says it happened. */
  function copyButton(path) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lightbox-act';
    btn.textContent = 'copy path';
    btn.title = path;
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(path);
        btn.textContent = 'copied';
      } catch {
        // No clipboard permission, or an insecure context: say so rather than flashing a
        // success the reader would then paste nothing from.
        btn.textContent = 'could not copy';
      }
      btn.classList.add('is-flash');
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = 'copy path';
        btn.classList.remove('is-flash');
      }, 1400);
    };
    return btn;
  }

  /**
   * `reveal in Finder` — the one action in this overlay that reaches off the browser.
   *
   * It posts the same `{uuid, index}` the list handed over and **never the path**, even
   * though the path is right there on the entry beside it. That is the whole bound the
   * feature rests on (§7 rule 1): the server re-reads this session's own transcript,
   * finds that record with the enumerator the list was minted from, and takes the path
   * from what Claude wrote. Sending `entry.path` would work today and would turn the
   * endpoint into one that accepts a path tomorrow, which is precisely the prior art the
   * plan was measured against and refused.
   *
   * The server reveals rather than opens — `open -R`, which selects the file in Finder and
   * launches nothing — and there is no open button here at all, by ruling.
   *
   * A refusal flashes the server's own sentence rather than a generic one: the file has
   * usually just been deleted under a modal that was opened minutes ago, and "no longer on
   * disk" is the answer the reader wants instead of "that didn't take".
   */
  function revealButton(entry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lightbox-act';
    btn.textContent = 'reveal in Finder';
    btn.title = `Show ${entry.path} in Finder`;
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await postJSON(`/api/sessions/${encodeURIComponent(sessionId)}/output/reveal`, {
          uuid: entry.uuid,
          index: entry.index,
        });
        btn.textContent = 'revealed';
      } catch (err) {
        btn.textContent = err.message;
      }
      btn.disabled = false;
      btn.classList.add('is-flash');
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = 'reveal in Finder';
        btn.classList.remove('is-flash');
      }, 1400);
    };
    return btn;
  }

  function paintHead(entry) {
    const acts = previewActions(entry);
    head.replaceChildren();
    // The name is the row's own label and is only worth the line when there is a button
    // beside it — the caption underneath already says what this is.
    if (acts.length && (entry.name || entry.path)) {
      const name = document.createElement('span');
      name.className = 'lightbox-head-name';
      name.textContent = entry.path ? shortPath(entry.path) : entry.name;
      name.title = entry.path || entry.name;
      head.append(name);
    }
    for (const act of acts) {
      if (act === 'copy-path') head.append(copyButton(entry.path));
      else if (act === 'reveal') head.append(revealButton(entry));
    }
    head.hidden = head.childElementCount === 0;
  }

  /** The `plain-other` branch, and the gone-attachment branch, share this shape. */
  function noPreview(entry, why) {
    const box = document.createElement('div');
    box.className = 'lightbox-none';
    const name = document.createElement('div');
    name.className = 'lightbox-none-name';
    name.textContent = entry.name || entry.path || 'file';
    const facts = document.createElement('div');
    facts.className = 'lightbox-none-facts';
    facts.textContent = [entry.kind || 'file', shortBytes(entry.bytes)].filter(Boolean).join(' · ');
    const p = document.createElement('p');
    p.textContent = why;
    box.append(name, facts, p);
    return box;
  }

  async function paintText(entry, mine, asMarkdown) {
    page.replaceChildren();
    page.className = `lightbox-page ${asMarkdown ? 'plan-md lightbox-md' : 'lightbox-pre-wrap'}`;
    const waiting = document.createElement('div');
    waiting.className = 'lightbox-waiting';
    waiting.textContent = 'reading…';
    page.append(waiting);
    let text;
    try {
      const res = await fetch(src(sessionId, entry));
      if (!res.ok) throw new Error(`could not read it (${res.status})`);
      text = await res.text();
    } catch (err) {
      if (mine !== seq || !page.isConnected) return;
      page.replaceChildren(noPreview(entry, err.message));
      return;
    }
    if (mine !== seq || !page.isConnected) return;
    if (asMarkdown) {
      // The same accepted trust level `.plan-md` already runs at, on text this transcript
      // already holds — and `withBlankTargets` so a link in it opens a tab instead of
      // taking the panel with it.
      page.innerHTML = withBlankTargets(marked.parse(text));
    } else {
      const pre = document.createElement('pre');
      pre.className = 'lightbox-pre';
      pre.textContent = text;
      page.replaceChildren(pre);
    }
  }

  function paint() {
    const entry = steps[at];
    const mine = ++seq;
    const kind = previewKindFor(entry);
    const lost = previewLost(entry);

    paintHead(entry);
    fig.classList.toggle('is-doc', kind !== 'image' || lost);

    if (kind === 'image' && !lost) {
      doc.hidden = true;
      // Emptied rather than merely hidden: the last document's text would otherwise sit in
      // the tree behind a picture, which costs nothing on screen and is a lie to anything
      // reading the DOM — a bench, a find-in-page, a screen reader.
      page.replaceChildren();
      img.hidden = false;
      img.src = src(sessionId, entry);
      img.alt = entry.note || 'Image from this session';
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      doc.hidden = false;
      if (lost) {
        // A `SendUserFile` attachment's bytes were only ever on disk. A `Write`'s are in
        // the record, which is why a gone one falls through to the fetch below and still
        // previews as written.
        page.className = 'lightbox-page';
        page.replaceChildren(noPreview(entry, 'no longer on disk, nothing to preview'));
      } else if (kind === 'markdown' || kind === 'text') {
        paintText(entry, mine, kind === 'markdown');
      } else {
        page.className = 'lightbox-page';
        page.replaceChildren(noPreview(entry, 'no preview — reveal in Finder to open it'));
      }
    }

    // `note` is the text that came with the image in its own record and is only on refs
    // that came from the gallery's scan; a strip's ref carries the ordinal and nothing
    // else, and the message it belongs to is right there on screen behind this.
    const bits = [];
    if (steps.length > 1) bits.push(`${at + 1} / ${steps.length}`);
    if (entry.note) bits.push(entry.note);
    const foot = previewFoot(entry, {
      at: entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      size: shortBytes(entry.bytes),
    });
    if (foot) bits.push(foot);
    cap.textContent = bits.join('  ·  ');
    cap.hidden = bits.length === 0;
  }

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      // The modal this may have opened from is listening for Escape too, and it
      // registered first, so it would close underneath. Stopping the event here is what
      // makes Escape mean "the thing on top" — and it is what returns the reader to that
      // modal with the filter and the scroll it had, since nothing there is touched.
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'ArrowRight' && steps.length > 1) {
      at = (at + 1) % steps.length;
      paint();
    } else if (e.key === 'ArrowLeft' && steps.length > 1) {
      at = (at - 1 + steps.length) % steps.length;
      paint();
    }
  }
  document.addEventListener('keydown', onKey, true);
  back.onmousedown = (e) => {
    // An image closes on a click anywhere, exactly as it always has. A document must not:
    // the panel is text to select, an action row to press and links to follow, and a
    // reader who closed it by starting a selection would have to find the cell again.
    if (e.target?.closest?.('.lightbox-doc, .lightbox-head')) return;
    close();
  };

  paint();
  document.body.append(back);
}

/**
 * How much of a document a grid cell shows.
 *
 * The byte route serves a whole file — there is no range endpoint and there should not be
 * one, since the address is a record rather than a path — so the cap is applied here,
 * after the read. Both halves are needed: the line cap is what makes every cell the same
 * shape, and the character cap is what stops one 68KB paragraph with no newline in it from
 * being handed to the layout whole.
 */
const PREVIEW_LINES = 14;
const PREVIEW_CHARS = 900;

/** The first few lines of a document, capped both ways. */
function previewText(raw) {
  const out = String(raw ?? '').split('\n').slice(0, PREVIEW_LINES).join('\n');
  return out.length > PREVIEW_CHARS ? out.slice(0, PREVIEW_CHARS) : out;
}

/** `example.com/owner/repo` — the address without the scheme, for a link with no title. */
function hostAndPath(url) {
  try {
    const u = new URL(String(url));
    const p = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.host}${p}${u.search}`;
  } catch {
    return String(url || '');
  }
}

/** Just the host, which is the name a link row is filed under. */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url || '');
  }
}

/**
 * Everything one session has produced, in one grid — and the promise that it is
 * *everything*.
 *
 * This is the old image gallery widened. That promise is why it fetches instead of reading
 * `view.messages`: the panel only ever holds a window of a transcript (the tailer backfills
 * a byte range, `probe` samples head and tail), so a grid built from what is on screen
 * would be a subset and would look complete. `/api/sessions/:id/outputs` makes its own pass
 * over the whole file — 66ms on a 25MB transcript — which is cheap enough to redo on every
 * open, so nothing here is cached and there is nothing to go stale as the session keeps
 * talking.
 *
 * Three things about the shape, each of which has a rule behind it:
 *
 *   **The two arrays are merged here and nowhere else.** The endpoint answers `{outputs,
 *   links}` and deliberately never merges them (`server/outputs.js`'s header: a file is
 *   addressed into the transcript, a link is a string). The modal needs one list, so
 *   `web/files-kinds.js` does that merge as a pure function — which is what makes the six
 *   counts and each pill's membership testable in plain Node.
 *
 *   **A link is an anchor, never an overlay.** `target="_blank"` with
 *   `rel="noopener noreferrer"` — `noreferrer` beyond the panel's usual `noopener` habit
 *   because these are addresses from arbitrary third-party pages and there is no reason to
 *   tell them where the click came from. The panel never fetches one, server-side or in the
 *   browser, which is also why there are no favicons: one would phone out to every host the
 *   transcript mentions the moment this opens.
 *
 *   **Nothing in here measures anything during a paint.** That is the one thing that would
 *   make it need the room's `scrollTop`-across-the-repaint dance. A filter click replaces
 *   the grid's children and lets the scroll go back to the top, which is what a reader
 *   asking for a different set wants.
 *
 *   **The grid and the list are both always built, and the hidden one costs nothing.**
 *   `paint()` fills both containers on every filter change; only the CSS `hidden` attribute
 *   decides which one is on screen. That is what keeps a view toggle a one-line repaint
 *   instead of a second fetch or a cached-but-stale copy — and it is safe for exactly one
 *   reason: the list never calls `lazily()`. A row shows a kind, a name and a time, none of
 *   which needs a document's bytes, so there is no second `fetch` racing the grid's. The
 *   thumbnails are the only thing that could double-fetch, and `loading="lazy"` on an
 *   element with no layout box (a `hidden` ancestor) never asks for its bytes at all — so a
 *   grid image and its list twin cost one request between them, not two.
 */
function openFiles(sessionId, sessionTitle) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal is-wide files';

  /*
   * The card is a column: this head does not scroll, the content region below it does, and
   * the close row is pinned under both. The maintainer's complaint was that "when it's at max
   * height the entire modal scrolls" — `.is-wide`'s own `overflow-y: auto` is what did
   * that, taking the title and the filter pills off screen with the cells, so `.modal.files`
   * turns it off and the scrolling moves one level in. A wrapper rather than six
   * `flex: 0 0 auto` children: the existing margins between the title, the subtitle, the bar
   * and the note are block margins and stay block margins inside it.
   */
  const headRegion = document.createElement('div');
  headRegion.className = 'files-head';
  box.append(headRegion);

  const h = document.createElement('h2');
  h.textContent = 'files';
  headRegion.append(h);

  const sub = document.createElement('div');
  sub.className = 'files-sub';
  sub.textContent = sessionTitle || '';
  headRegion.append(sub);

  // Hidden until there is something to filter: a row of six zeroes over an empty grid says
  // nothing the empty state does not say better. The view toggle rides in the same bar and
  // is hidden with it — there is nothing to switch the view of yet.
  const bar = document.createElement('div');
  bar.className = 'files-bar';
  bar.hidden = true;
  const filters = document.createElement('div');
  filters.className = 'files-filters';
  bar.append(filters);

  // Two plain buttons, not a native control — `.files-pill`'s own reason (CLAUDE.md's
  // `.field-check` trap: a stock checkbox is painted by the *browser's* colour scheme, not
  // the page's `data-theme`). `view` starts from the remembered choice; every session opens
  // the modal on whatever it was last left on, in this browser.
  let view = filesView.value === 'list' ? 'list' : 'grid';
  const viewToggle = document.createElement('div');
  viewToggle.className = 'files-view';
  const gridBtn = document.createElement('button');
  gridBtn.type = 'button';
  gridBtn.className = 'files-view-btn';
  gridBtn.textContent = 'grid';
  const listBtn = document.createElement('button');
  listBtn.type = 'button';
  listBtn.className = 'files-view-btn';
  listBtn.textContent = 'list';
  viewToggle.append(gridBtn, listBtn);
  bar.append(viewToggle);
  headRegion.append(bar);

  const note = document.createElement('div');
  note.className = 'files-note';
  note.textContent = 'reading the transcript…';
  headRegion.append(note);

  // The one thing that scrolls. Both containers and the empty state live in it, so the
  // empty message sits *inside* the settled box rather than collapsing it — same element,
  // same wording as before.
  const bodyRegion = document.createElement('div');
  bodyRegion.className = 'files-body';
  const grid = document.createElement('div');
  grid.className = 'files-grid';
  const list = document.createElement('div');
  list.className = 'files-list';
  bodyRegion.append(grid, list);
  box.append(bodyRegion);

  /** The toggle's own two-button state, and which of the two containers is on screen. The
   *  filter selection lives in `selected` below and neither button here touches it — that
   *  is the whole of "switching view keeps the current filter". */
  function paintView() {
    gridBtn.classList.toggle('is-on', view === 'grid');
    gridBtn.setAttribute('aria-pressed', String(view === 'grid'));
    listBtn.classList.toggle('is-on', view === 'list');
    listBtn.setAttribute('aria-pressed', String(view === 'list'));
    grid.hidden = view !== 'grid';
    list.hidden = view !== 'list';
  }
  paintView();
  // Both toggles send the content region back to the top, and that is a decision rather
  // than a default: an offset into a grid of 10rem cells is not the same offset into a
  // list of one-line rows, so carrying it over would land the reader somewhere arbitrary
  // in a list they have not seen. Nothing is measured to do it — there is no `scrollTop`
  // read here and so nothing for the room's forced-layout trap to bite.
  gridBtn.onclick = () => {
    if (view === 'grid') return;
    view = 'grid';
    filesView.set(view);
    paintView();
    bodyRegion.scrollTop = 0;
  };
  listBtn.onclick = () => {
    if (view === 'list') return;
    view = 'list';
    filesView.set(view);
    paintView();
    bodyRegion.scrollTop = 0;
  };

  const row = document.createElement('div');
  row.className = 'modal-row';
  const done = document.createElement('button');
  done.className = 'ghost-btn';
  done.textContent = 'close';
  row.append(done);
  box.append(row);

  /*
   * A document's bytes are fetched when its cell comes into view, which is the same trade
   * `loading="lazy"` makes for a thumbnail one cell over — a session can hold ninety of
   * these and the mean document here is 6.5KB. `IntersectionObserver` rather than the
   * attribute because there is no attribute for a `fetch`; the `null` root is the viewport,
   * which is correct even though the scroller is `.modal.is-wide`, and it is one less
   * assumption about which ancestor scrolls. Where the API is missing the previews simply
   * all load, which is the right failure: a slower open beats an empty grid.
   */
  const pending = new Map();
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const load = pending.get(e.target);
              pending.delete(e.target);
              io.unobserve(e.target);
              if (load) load();
            }
          },
          { rootMargin: '300px' },
        )
      : null;

  function lazily(el, load) {
    if (!io) {
      load();
      return;
    }
    pending.set(el, load);
    io.observe(el);
  }

  /*
   * The card's height, settled once and then left alone.
   *
   * Measured after the first paint of `all` — the widest view the modal has — and written
   * as an **inline height** rather than a custom property: it is one number, read back by
   * nothing else and never composed with anything in CSS, so a property would only be an
   * indirection between the measurement and the box it is about. The clamp itself is
   * `filesModalHeight`, where a Node test can hold it.
   *
   * `head` is `card - region`, not a sum of the head's own parts: that subtraction stays
   * right when CSS has already clamped the card at its `max-height` backstop (the region
   * has shrunk, the head has not), and it needs no list of which children count as chrome.
   * `region.scrollHeight` is the content's natural height whether or not it currently fits.
   *
   * What it deliberately does *not* do is re-measure. A filter change or a view toggle
   * repaints the region and the box does not move, which is the whole ruling.
   */
  let settledContent = null;
  let settledHead = null;

  function settleHeight() {
    if (!box.isConnected) return;
    const cardH = box.getBoundingClientRect().height;
    const regionH = bodyRegion.getBoundingClientRect().height;
    const content = bodyRegion.scrollHeight;
    const head = cardH - regionH;
    const px = filesModalHeight(content, head, window.innerHeight);
    if (px == null) return; // nothing measurable yet — leave the card as CSS has it
    settledContent = content;
    settledHead = head;
    box.style.height = `${px}px`;
  }

  /*
   * A resize re-clamps to the *new* 80% and nothing more: the content's natural height was
   * measured once and is not measured again, so the box can only shrink to fit a shorter
   * window or grow back to what it originally wanted. A `resize` listener rather than a
   * `ResizeObserver` because an automated Chrome window reports `visibilityState: 'hidden'`
   * and Chrome suspends those callbacks there — the room panel's hour, already paid for.
   */
  function onResize() {
    if (settledContent == null) return;
    const px = filesModalHeight(settledContent, settledHead, window.innerHeight);
    if (px != null) box.style.height = `${px}px`;
  }
  window.addEventListener('resize', onResize);

  const close = () => {
    io?.disconnect();
    pending.clear();
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  };
  function onKey(e) {
    // A lightbox opened from a cell is on top and owns Escape; it stops the event before
    // this ever sees it, so this check is only for the case where it doesn't.
    if (e.key === 'Escape' && !document.querySelector('.lightbox')) close();
  }
  document.addEventListener('keydown', onKey, true);
  done.onclick = close;
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };

  back.append(box);
  document.body.append(back);
  done.focus();

  /** Where one output's bytes live — a record and an ordinal, never a path. */
  const outputSrc = (item) => outputSrcFor(sessionId, item);

  /** The line under every cell: what it is called, and when it happened. */
  function captionFor(nameText, item, gone) {
    const cap = document.createElement('span');
    cap.className = 'files-cap';
    const name = document.createElement('span');
    name.className = 'files-name';
    name.textContent = nameText;
    const when = document.createElement('span');
    when.className = 'files-when';
    if (gone) {
      // The mock-up gives the right-hand slot to `gone` rather than drawing both: at a
      // 10rem column there is room for one, and which of the two a reader needs is not a
      // close call. The time is still on the cell's own tooltip.
      when.classList.add('files-gone-tag');
      when.textContent = 'gone';
    } else {
      when.textContent = item.ts ? agoText(Date.parse(item.ts)) : '';
    }
    cap.append(name, when);
    return cap;
  }

  /** The facts a hover should give back, including the ones the caption had no room for. */
  function titleFor(item, gone) {
    const bits = [];
    if (item.path) bits.push(item.path);
    if (item.note) bits.push(item.note);
    if (item.sidechain) bits.push('subagent');
    if (gone) bits.push('no longer on disk');
    if (item.ts) bits.push(agoText(Date.parse(item.ts)));
    return bits.join(' · ');
  }

  /**
   * The modal's voice for "there is nothing here", in one place because there are now two
   * kinds of nothing and they must not drift apart.
   *
   * **A session that produced nothing** keeps `nothing produced yet` and its sentence,
   * unchanged. **A filter with nothing under it** is the second kind — it had no rendering
   * at all before this, because a card that collapsed to its head said it by being empty,
   * and a card whose height is now settled cannot say it that way: the reader gets a blank
   * region inside a box that did not move. Same element, same register, different title, so
   * the two cannot be confused for each other by a reader or by a test.
   *
   * One instance per call: the grid and the list are both painted on every paint and a node
   * cannot be in two parents at once.
   */
  function emptyBlock(titleText, bodyText) {
    const empty = document.createElement('div');
    empty.className = 'files-empty';
    const title = document.createElement('div');
    title.className = 'empty-title';
    title.textContent = titleText;
    const p = document.createElement('p');
    p.textContent = bodyText;
    empty.append(title, p);
    return empty;
  }

  /**
   * The one way anything in this modal opens the preview overlay.
   *
   * Four callers — an image cell, a document cell, an image row, a document row — and one
   * handler, because the grid and the list are two drawings of the same list and a second
   * path is a second place for the address or the walk to be got wrong. The list view's
   * rows were built inert against exactly this slot.
   *
   * Two things it carries that a caller should not have to know. The whole **filtered**
   * list goes over, not just the images in it: the overlay's arrow keys walk what the
   * reader can currently see, files and links alike, and it drops the links out of the
   * walk itself. And `outputSrc` rather than the overlay's default — these are *outputs*,
   * and a `SendUserFile` screenshot is not an image *block*, so it has no address in
   * `/image/:uuid/:index` at all.
   */
  function openPreview(shown, at) {
    openLightbox(sessionId, shown, at, { src: (id, item) => outputSrc(item) });
  }

  function imageCell(item, shown, at) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'files-cell files-image';
    const gone = item.onDisk === false;
    if (gone) cell.classList.add('is-gone');
    const title = titleFor(item, gone);
    if (title) cell.title = title;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = outputSrc(item);
    img.alt = item.note || '';
    cell.append(img);

    cell.append(captionFor(item.name || item.note || 'image', item, gone));
    cell.onclick = () => openPreview(shown, at);
    return cell;
  }

  function docCell(item, shown, at) {
    // The same overlay an image opens, which is the whole of item 4b: a document is
    // rendered markdown, a `<pre>` or a name and a sentence, decided by
    // `web/files-preview.js` and never by a switch out here.
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'files-cell';
    const gone = item.onDisk === false;
    if (gone) cell.classList.add('is-gone');
    const title = titleFor(item, gone);
    if (title) cell.title = title;

    const body = document.createElement('div');
    body.className = 'files-doc';
    cell.append(body);
    cell.append(captionFor(item.name || 'file', item, gone));
    cell.onclick = () => openPreview(shown, at);

    const readable = item.kind === 'markdown' || item.kind === 'text';
    // A `Write`'s bytes are in the transcript, so a document previews as written even
    // after the file is deleted — `readOutput` never reads the disk for one. A
    // `SendUserFile` attachment's bytes were only ever on disk, so a gone one has nothing
    // left to show and says so instead of fetching a 404.
    const lost = item.source === 'sendfile' && gone;

    if (!readable) {
      const name = document.createElement('b');
      name.textContent = item.name || 'file';
      body.append(name, document.createTextNode('\n\nno preview'));
      return cell;
    }
    if (lost) {
      const name = document.createElement('b');
      name.textContent = item.name || 'file';
      body.append(name, document.createTextNode('\n\nno longer on disk'));
      return cell;
    }

    body.classList.add('is-waiting');
    body.textContent = 'reading…';
    lazily(cell, async () => {
      try {
        const res = await fetch(outputSrc(item));
        if (!res.ok) throw new Error(`could not read it (${res.status})`);
        const text = await res.text();
        if (!body.isConnected) return;
        body.classList.remove('is-waiting');
        body.textContent = previewText(text);
      } catch (err) {
        if (!body.isConnected) return;
        body.textContent = err.message;
      }
    });
    return cell;
  }

  function linkCell(item) {
    const cell = document.createElement('a');
    cell.className = 'files-cell files-link';
    cell.href = item.url;
    cell.target = '_blank';
    cell.rel = 'noopener noreferrer';
    cell.title = item.url;

    const body = document.createElement('div');
    body.className = 'files-doc files-link-body';
    const mark = document.createElement('span');
    mark.className = 'files-link-mark';
    // Our own constant markup, from `web/link-mark.js` — never anything off the wire.
    mark.insertAdjacentHTML('beforeend', linkMarkupFor(item));
    const title = document.createElement('span');
    title.className = 'files-link-title';
    title.textContent = item.title || hostAndPath(item.url);
    body.append(mark, title);
    if (item.short) {
      const short = document.createElement('span');
      short.className = 'files-link-short';
      short.textContent = item.short;
      body.append(short);
    }
    cell.append(body, captionFor(hostOf(item.url), item, false));
    return cell;
  }

  /** The kind column every list row starts with — `web/files-kinds.js`'s own word, mono
   *  and faint, never the pill an item lives under (`pdf`, not `other`). */
  function kindSpan(item) {
    const k = document.createElement('span');
    k.className = 'files-row-kind';
    k.textContent = kindLabel(item);
    return k;
  }

  /**
   * The list view's three row builders — one per cell kind, same order and same set as the
   * grid's `imageCell`/`docCell`/`linkCell`, reusing `captionFor` for the name-and-time half
   * so a `gone` row is struck through and tagged the same way in both views without a
   * second rule for it.
   *
   * A row is a `<button>` (or, for a link, an `<a>`) rather than a table row: the modal has
   * no header to anchor a `<table>` to and every other clickable thing in this modal is
   * already a button, `imageCell` included.
   */
  function imageRow(item, shown, at) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'files-row files-row-image';
    const gone = item.onDisk === false;
    if (gone) row.classList.add('is-gone');
    const title = titleFor(item, gone);
    if (title) row.title = title;
    row.append(kindSpan(item), captionFor(item.name || item.note || 'image', item, gone));
    row.onclick = () => openPreview(shown, at);
    return row;
  }

  function docRow(item, shown, at) {
    // `openPreview`, the same function the grid's cell calls — this row was built inert
    // against that slot and now fills it. Not a second path: a row and a cell are two
    // drawings of one item, and the walk they open must be the one list.
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'files-row files-row-doc';
    const gone = item.onDisk === false;
    if (gone) row.classList.add('is-gone');
    const title = titleFor(item, gone);
    if (title) row.title = title;
    row.append(kindSpan(item), captionFor(item.name || 'file', item, gone));
    row.onclick = () => openPreview(shown, at);
    return row;
  }

  function linkRow(item) {
    const row = document.createElement('a');
    row.className = 'files-row files-row-link';
    row.href = item.url;
    row.target = '_blank';
    row.rel = 'noopener noreferrer';
    row.title = item.url;
    row.append(kindSpan(item), captionFor(item.title || hostAndPath(item.url), item, false));
    return row;
  }

  // Mounted first, filled second — a grid painted before it is in the document is the
  // room's oldest bug, and a lazily-loaded `<img>` in a detached node never asks for its
  // bytes at all.
  (async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/outputs`);
      const data = await res.json().catch(() => ({}));
      if (!back.isConnected) return; // closed while we were reading
      if (!res.ok) {
        note.textContent = data.error || `Could not read the transcript (${res.status}).`;
        return;
      }

      const items = filesItems(data);
      const counts = filesCounts(items);
      sub.textContent = [sessionTitle || '', String(counts.all)].filter(Boolean).join(' · ');

      if (!items.length) {
        note.remove();
        const empty = emptyBlock(
          'nothing produced yet',
          data.note ||
            'No files and no links in this conversation — nothing written, nothing captured, nothing cited.',
        );
        // The bar (filters and the view toggle) stays hidden — there is nothing to switch
        // the view of — so the empty message always shows in `grid`, whatever this browser
        // last remembered, or a `list`-remembered browser would hide it behind nothing.
        list.hidden = true;
        grid.hidden = false;
        grid.append(empty);
        settleHeight();
        return;
      }

      note.textContent = 'what this session produced, newest first — the whole transcript';

      let selected = 'all';
      const pills = new Map();

      function paint() {
        io?.disconnect();
        pending.clear();
        const shown = filesFor(items, selected);
        // Every cell and every row is handed the whole filtered list and its own place in
        // it: the preview overlay steps through what the reader can currently see rather
        // than through one kind, which is the same "the list is already in hand" the strip
        // uses. It drops the links out of the walk itself.
        //
        // Both containers are filled on every paint — the toggle only flips `hidden` —
        // which is safe because the list never calls `lazily()`; see that function's own
        // header for why that is free rather than a second fetch.
        const gridFrag = document.createDocumentFragment();
        const listFrag = document.createDocumentFragment();
        shown.forEach((item, at) => {
          if (item.kind === 'link') {
            gridFrag.append(linkCell(item));
            listFrag.append(linkRow(item));
          } else if (item.kind === 'image') {
            gridFrag.append(imageCell(item, shown, at));
            listFrag.append(imageRow(item, shown, at));
          } else {
            gridFrag.append(docCell(item, shown, at));
            listFrag.append(docRow(item, shown, at));
          }
        });
        if (!shown.length) {
          // A pill with a zero on it, pressed. It used to say this by collapsing the card
          // to its head; a card whose height is settled has to say it in words, or the
          // reader gets a blank region inside a box that did not move. The sentence names
          // the filter rather than the count — the pill beside it is already the count, and
          // `all` cannot reach this branch (there are items, or the branch above ran).
          // Short on purpose, and both halves of that were measured. `No ${selected} in this
          // conversation` is ungrammatical on two of the six pills ("No other in this
          // conversation"), so the pill is named in quotes instead. And the sentence carries
          // no advice — the card is settled to what `all` needs, which for a session of four
          // entries is shorter than this block, so a second line is a line the scroller
          // clips; the pills it would have pointed at are two rows above it anyway.
          const line = `No entries under “${selected}”.`;
          // `is-filter` is padding alone — see the rule in `web/styles.css` for why this one
          // cannot carry the whole-session state's 2rem.
          for (const frag of [gridFrag, listFrag]) {
            const block = emptyBlock('nothing of this kind', line);
            block.classList.add('is-filter');
            frag.append(block);
          }
        }
        grid.replaceChildren(gridFrag);
        list.replaceChildren(listFrag);
      }

      for (const kind of FILE_KINDS) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'files-pill';
        pill.setAttribute('aria-pressed', String(kind === selected));
        if (kind === selected) pill.classList.add('is-on');
        const label = document.createElement('span');
        label.textContent = kind;
        const n = document.createElement('span');
        n.className = 'files-pill-n';
        n.textContent = String(counts[kind] ?? 0);
        pill.append(label, n);
        // A pill with nothing under it stays, greyed: the six are the vocabulary of what
        // this modal can hold, and a row whose membership changed per session would make
        // "there are no links" indistinguishable from "links are not a thing here".
        if (!counts[kind]) pill.classList.add('is-empty');
        pill.onclick = () => {
          if (selected === kind) return;
          selected = kind;
          for (const [k, p] of pills) {
            p.classList.toggle('is-on', k === kind);
            p.setAttribute('aria-pressed', String(k === kind));
          }
          paint();
          // A new list starts at its top. The box itself does not move — that is what
          // `settleHeight` bought — so this is the content region's own offset and nothing
          // else, and it is set rather than read.
          bodyRegion.scrollTop = 0;
        };
        pills.set(kind, pill);
        filters.append(pill);
      }
      bar.hidden = false;
      paint();
      // The one measurement, on the `all` view, with the bar already on screen: from here
      // the card's height is a fact and every later repaint happens inside it.
      settleHeight();
    } catch (err) {
      if (back.isConnected) note.textContent = err.message;
    }
  })();
}

/* ========================================================= confirmation === */

/**
 * The one way this panel asks "are you sure" about a destructive control.
 *
 * It replaces an idiom that was hand-rolled in three places and said nothing: the first
 * click turned the label into `sure?`, a second click within four seconds performed the
 * action, and the only way to say no was to wait. Fast, and mute about what the second
 * click did — the label it overwrote was the only thing naming the target, so a row asking
 * `sure?` had stopped saying what it was about, and a stack of them said it three times.
 * The maintainer's issue #11 is the whole argument.
 *
 * What replaces it: the control's node is swapped **in place** for a short question naming
 * the action and its target — `merge #12?`, `abandon issue-8?` — with a **yes** in the
 * decision colour and a plain **no**. In place, and never a dialog: the merge block sits
 * above the composer, and a modal over it would move the one row this panel promises never
 * moves.
 *
 * Everything else about the old idiom is kept, because every part of it was load-bearing:
 *
 *   **One armed control at a time** — arming any control disarms whatever else was asking.
 *   Module scope rather than per block, which is wider than the thing it replaces and
 *   deliberately so: two questions on screen at once is a screen where a press cannot be
 *   attributed, and split view can put them in two different panes.
 *
 *   **A repaint disarms**, scoped to the block being repainted (`within`). The node is
 *   about to be replaced, and a question carried across a repaint is a question about a
 *   row that may not be the same row any more. Scoped, because with one registry for the
 *   whole window an unscoped disarm would let a repaint in one pane answer for a question
 *   in the other.
 *
 *   **Four seconds, then it lets go by itself.** The fallback for nobody answering; what
 *   changed is that there is now something to answer.
 *
 * Keyboard: `yes` takes focus on arm, so Enter confirms; Escape inside the group is `no`;
 * both are ordinary buttons, so Tab reaches them and Shift+Tab goes back. Focus returns to
 * the restored control only when it was inside the group — a four-second timeout that
 * yanked the caret out of the composer would be its own small bug.
 *
 * The phone's merge block has the same idiom in `web/m/lead.js` and not this code: those
 * two blocks share no code by ruling, and every sentence they both show is composed
 * server-side. What is shared here is the shape, not a module.
 */
const CONFIRM_MS = 4000;

/** `{btn, group, timer}` — the one question on screen, or null. */
let confirmArmed = null;

/**
 * Put the control back.
 *
 * `within` scopes it: given an element, this disarms only a question inside it, which is
 * what lets one pane repaint its own block without answering for the other's.
 */
function disarmConfirm(within = null) {
  if (!confirmArmed) return;
  const { btn, group, timer } = confirmArmed;
  if (within && !within.contains(group)) return;
  clearTimeout(timer);
  confirmArmed = null;
  // A repaint can get here first, in which case the group is already detached and the
  // fresh row has drawn its own button; putting this one back would be a second copy.
  if (!group.isConnected) return;
  const hadFocus = group.contains(document.activeElement);
  group.replaceWith(btn);
  if (hadFocus) btn.focus({ preventScroll: true });
}

/**
 * Swap `btn` for the question, and run `onYes` only if the answer is yes.
 *
 * `question` names the action and its target and is the entire point of the change — it is
 * what `sure?` could not say. It ellipsises rather than wrapping, because the merge block
 * must not grow a line, and carries its full text as a `title`. `yes` inherits the
 * control's own tooltip: that sentence already says exactly what the press does, and a
 * second wording of it is how two accounts of one fact start.
 */
function armConfirm(btn, question, onYes) {
  disarmConfirm();

  const group = document.createElement('span');
  group.className = 'confirm';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', question);

  const q = document.createElement('span');
  q.className = 'confirm-q';
  q.textContent = question;
  q.title = question;

  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'confirm-yes';
  yes.textContent = 'yes';
  yes.title = btn.title;

  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'confirm-no';
  no.textContent = 'no';
  no.title = 'Leave it alone.';

  group.append(q, yes, no);

  // On the group rather than on the document: Escape means "no" for as long as the
  // question holds focus, which it does from the moment it is armed, and a document-level
  // capture would also swallow the Escape that closes whatever is opened next.
  group.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      disarmConfirm();
      return;
    }
    // The keyboard twin of the `stopPropagation` below, and it is not decoration: a task
    // row is itself `role="button"` and opens its brief on Enter *or* Space, and its
    // handler calls `preventDefault()`. Left to bubble, Enter on `yes` would open a dialog
    // over the row and cancel the button's own activation on the way — the press that says
    // yes would do everything except that. Stop the bubble, never the default: the default
    // is the press.
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  };
  // The same reason every control in these two blocks stops the bubble: a merge row is a
  // live strip, and a task row opens its brief on a click anywhere in it.
  group.onclick = (e) => e.stopPropagation();

  no.onclick = () => disarmConfirm();
  yes.onclick = () => {
    // Restore first, then act: `onYes` is handed the original button and disables it, so
    // it has to be back in the document before it runs.
    disarmConfirm();
    onYes();
  };

  btn.replaceWith(group);
  confirmArmed = { btn, group, timer: setTimeout(() => disarmConfirm(), CONFIRM_MS) };
  // The control was just pressed, so it is on screen and nothing needs scrolling to reach
  // it — and the merge block's rows and the transcript below both have scroll positions
  // this must not disturb.
  yes.focus({ preventScroll: true });
}

/* ============================================================== a pane === */

/**
 * Sessions with a Terminal window on the way. Module scope for the same reason
 * `duplicating` is: the header is rebuilt on every roster broadcast, so `disabled` on the
 * button is wiped seconds before `open -a Terminal` returns, and three quick clicks would
 * otherwise open three windows onto one session.
 */
const attaching = new Set();

/**
 * One session's worth of panel: header, transcript, composer, and everything that
 * hangs off them.
 *
 * This used to be the whole file's module scope — one selected session, one `streamEl`,
 * one `composerEl`. Split view means two of everything at once, so the per-session state
 * moved in here and the shared state (the roster, drafts, the thinking toggle) stayed
 * out there. Nothing inside changed shape; it just stopped being global.
 *
 * `slot` is how the server tells the two apart: every subscribe carries it, and every
 * transcript message comes back stamped with it.
 */
function createPane(slot, host) {
  const view = {
    // What this pane is holding. A pane is a session's worth of panel and always was —
    // this is the field that stops it being *only* that, and it is checked before every
    // piece of machinery that assumes there is a session behind `selected`.
    //
    // Anything that is not `'session'` — peer messages, one group room — has no transcript,
    // no composer, no model and no pane to type into. Every piece of machinery that used to
    // assume otherwise has its own guard, and each guard is there for its own reason rather
    // than as a copy of the one above.
    kind: 'session',
    selected: null,
    messages: [],
    hasEarlier: false,
    error: null,
    lastMarked: null, // newest timestamp we have reported as read

    /*
     * Has anything landed in this session's files set since this pane last opened the
     * modal? The `files` button's dot, and the unread badge's model rather than a server
     * fact: per browser, in memory, nothing persisted, cleared by looking.
     *
     * **In the factory** for the reason everything per-session in here is — split view
     * means two panes at once, and module scope is where the second one gets caught. The
     * two panes count independently even when they hold the same session, because the
     * question is about a reader's attention and there are two readers' worth of screen.
     *
     * A boolean and not a count, for `web/files-new.js`'s reason: the dot is the whole of
     * what is drawn, and a number could not be made to agree with what the modal's own
     * whole-file scan lists.
     *
     * It starts false and is only ever set by `appendMessages` — a live arrival. A
     * `transcript` frame replaces `messages` wholesale and counts nothing, which is what
     * makes a pane's first load zero: history is not new.
     */
    filesNew: false,

    /*
     * This session's own output set, as `GET /api/sessions/:id/outputs` last answered —
     * and the whole of what bounds a path link in the conversation.
     *
     * A path in prose becomes a link only when it names one of these, or the folder one of
     * these sits in (the 2026-09-11 ruling). So the browser holds the list rather than
     * asking per path: the detector is a text scan and the scope check is a `Map` lookup,
     * and the expensive half — a streaming pass over the whole transcript — has already
     * been paid for by the files modal's own endpoint.
     *
     * **Fetched once per pane open, and again only when something lands.** `web/files-new.js`
     * already tells this pane that an arriving message put something in the files set — the
     * dot's own signal — so that is what is reused; nothing polls. A pane that never sees a
     * `Write` fetches exactly once.
     *
     * In the factory for the reason everything per-session in here is: split view means two
     * panes, and two sessions' output sets in module scope is one pane drawing the other's
     * links.
     */
    outputs: [],
    // A late answer must not paint over a pane that has changed hands. Bumped by `open`,
    // checked by the fetch — the `seq` trick the lightbox's own paints use.
    outputsSeq: 0,
    // One request at a time, with a trailing re-run for anything that landed while it was
    // in flight: a turn that writes three files is one extra scan, not three.
    outputsBusy: false,
    outputsAgain: false,

    /* ------------------------------------------------- the shared room --- */

    /*
     * `kind === 'shared'` is the third thing a pane can hold: `peer messages`, the
     * machine-wide log of what the sessions on this Mac say to each other. **Read-only** —
     * its `@` composer was retired on 2026-09-05 and a one-member room is what replaced it,
     * so every field below is about reading a list. Everything about it lives
     * **inside this factory** for the reason everything per-session already does — split
     * view means two panes at once, and module-scope state is where a second pane gets
     * caught. There is exactly one shared room on the machine and it can still only be
     * open in one pane at a time (`openSharedRoom` enforces that), but its scroll
     * position, its follow intention, its unseen count and its unfolded entries are facts
     * about *this* pane's box and belong to it.
     */
    shared: [],
    sharedCursor: 0,
    // Is the room pinned to its newest line? An *intention*, flipped only by a real
    // scroll — the room aside's rule and its reason: this box repaints in full when a
    // message arrives, and being yanked to the bottom mid-read is worse than scrolling
    // down for the new line yourself.
    sharedFollow: true,
    // What arrived while the reader was up in the history, for the `N new below` pill.
    sharedUnseen: 0,
    // How many entries the last paint drew, so the arithmetic above has something to
    // subtract from. Floored at zero where it is used: a fresh `shared` frame can be
    // *shorter* than the list it replaces (the tail is capped), and a negative count would
    // hide a hint that is due.
    sharedPainted: 0,
    sharedEl: null,
    sharedHintEl: null,
    sharedHeadEl: null,
    /* The scroll box's height when the pin was last taken, so the scroll handler can tell
     * a resize's own event from a reader's — Chrome emits one when a resize clamps
     * `scrollTop` and it is indistinguishable from a real scroll by anything else. `null`
     * until the box has been laid out, which never equals a real `clientHeight`. */
    sharedFollowH: null,
    // Which entries the reader has opened out of their ten-line clamp. Keyed by the
    // entry's own `seq`, which is unique in this log by construction — one file, one
    // counter, monotonic across a rotation. Keyed on the *record* rather than the node,
    // because every child is replaced on every paint.
    sharedOpenKeys: new Set(),

    /* --------------------------------------------- one group room --- */

    /*
     * `kind === 'group-room'` is the fourth thing a pane can hold: one named room, its
     * members, and everything they have said to each other through the panel.
     *
     * Not `'room'`, which is the *team* room's word one aside over, and not `'rooms'`: the
     * socket frames are `group-room` / `group-room-append` for exactly that reason
     * (`server/index.js`'s own block says so), and a pane kind spelled one word away from a
     * feature it is not would be the same trap in the client's clothes.
     *
     * Everything about it lives **inside this factory** for the reason everything per-session
     * already does — split view means two panes at once, and module scope is where a second
     * pane gets caught. Only one room is open at a time (`openGroupRoom` enforces it, and
     * the server holds one subscription per socket), but its scroll position, its follow
     * intention, its unfolded entries and its half-written message are facts about *this*
     * pane's box and belong to it.
     */
    // The room record, as the frame or the roster last described it. It moves under the pane
    // — a rename, a member added, an archive, from here or from another browser — so the head
    // repaints from it on the roster beat rather than from what was true when it opened.
    groupRoom: null,
    groupEntries: [],
    groupCursor: 0,
    // Is the room pinned to its newest line? An *intention*, flipped only by a real scroll —
    // the shared room's rule and its reason: this box repaints in full when a message
    // arrives, and being yanked to the bottom mid-read is worse than scrolling down.
    groupFollow: true,
    // What arrived while the reader was up in the history, for the `N new below` pill.
    groupUnseen: 0,
    // How many entries the last paint drew, so that arithmetic has something to subtract
    // from. Floored at zero where it is used: a fresh `group-room` frame can be *shorter*
    // than the list it replaces (the tail is capped), and a negative count would hide a hint
    // that is due.
    groupPainted: 0,
    groupEl: null,
    groupHintEl: null,
    groupHeadEl: null,
    groupStripEl: null,
    groupErrEl: null,
    /* ---- the fold. Per pane, because a room can be in either slot and the *preference*
     * (`roomFolded`) is the only part of it that is one answer for the browser. ---- */
    // The wrapper holding everything that is in the flow — the head, the list and the
    // composer — so the fold can pin it to a measured width and clip it rather than let it
    // re-wrap through forty intermediate ones. Held rather than looked up, because
    // `renderGroupPane` rebuilds the whole pane and a selector run later could be answering
    // about a node that has left the document.
    groupBodyEl: null,
    // The strip's own nodes. Patched on the roster beat rather than rebuilt, which is what
    // lets the badge's pulse survive a repaint that has nothing to do with it — a replaced
    // node loses a running animation mid-beat.
    groupFoldEls: null,
    // The unseen count the strip last drew, so the pulse can be armed by the number going
    // *up* rather than by a paint. It is the **server's** number (`room.unseen` off the
    // roster) and never `groupUnseen` above: that one counts only while the reader is
    // scrolled up, and a folded pane is still following its room, so behind a shut door it
    // stays at zero forever.
    groupFoldSeen: 0,
    // The `+` popover's own node, held so the roster beat can repaint what is in it without
    // rebuilding the strip around it.
    groupAddPopEl: null,
    /* The scroll box's height when the pin was last taken, so the scroll handler can tell a
     * resize's own event from a reader's — Chrome emits one when a resize clamps `scrollTop`
     * and it is indistinguishable from a real scroll by anything else. `null` until the box
     * has been laid out, which never equals a real `clientHeight`. */
    groupFollowH: null,
    // Which entries the reader has opened out of their clamp. Keyed by `seq`, which is unique
    // in this log by construction — one room, one file, one counter — and on the *record*
    // rather than the node, because every child is replaced on every paint.
    groupOpenKeys: new Set(),
    // Is the name being edited in place? One boolean, because the input replaces the heading
    // and a repaint mid-edit must not put the heading back under the caret.
    groupRenaming: false,
    // Is the `+` popover open? Built from the roster when it opens and repainted on the beat,
    // because whether a session is still addressable moves without anybody touching it.
    groupAddOpen: false,
    /*
     * The header's own refusal — the server's sentence for a rename, an add, a remove or an
     * archive — held **in view state and never on the node that was pressed**. `mergeErrors`'
     * reason, and it is sharper here: the strip repaints on the roster beat, so a 409 painted
     * onto a chip's ✕ would be in a detached tree within two seconds and nobody would ever
     * see why their press did nothing.
     */
    groupHeadError: null,
    // The composer's standing refusal, for the same reason again and kept apart from the
    // header's: one is about the message, the other about the room, and one line saying both
    // would be a line that contradicts itself.
    groupError: null,
    // A send in flight, and a header press in flight. Module scope is where a second pane
    // gets caught, and `disabled` on a button is gone by the next arriving line.
    groupBusy: false,
    groupHeadBusy: false,
    // Whether the pane was *drawn* for an archived room. An archive can land while the pane
    // is open — from this pane's own control or from another browser — and it changes the
    // pane's shape rather than its contents (the composer goes), which is the one thing a
    // repaint of the head cannot do on its own. `null` means nothing has been drawn yet.
    groupArchivedDrawn: null,
  };

  const chipNodes = new Map(); // toolUseId -> DOM node, so late results find their chip
  const current = () => state.sessions.find((s) => s.id === view.selected) || null;

  let streamEl = null;
  let composerEl = null;
  // …and a group room's. A second variable for the reason the one above it has: everything
  // that reads `composerEl` assumes a session behind it. (There were two more — the joint
  // thread's and `sharedComposerEl` — until links and the peer-message composer were
  // retired.)
  let groupComposerEl = null;

  // The team room — and, since Wave E, the whole team panel: tasks and settings ride the
  // same aside. Lives in the factory because two leads can be open in two slots and must
  // not share a panel — the same rule as everything else per-session in here.
  const roomView = {
    repo: null,
    entries: [],
    cursor: 0,
    listEl: null,
    /* The room list's height when `pinRoom` last ran. The scroll handler compares against
     * it to tell a resize's own scroll event from a reader's — see there. `null` until the
     * box has been laid out, which never equals a real `clientHeight`, so the very first
     * event after mount is treated as the layout's. That is the correct reading: the first
     * thing that happens to this box is the tasks block and the settings fold sizing
     * themselves after their own fetches. */
    followH: null,
    tasksEl: null,
    tasks: [],
    tasksSig: '',
    tasksAt: 0,
    tasksBusy: false,
    // The TASKS heading's two controls, and what the second of them has to say. The count
    // is written by `renderTasks` — the only place that knows it, because it is the number
    // of rows that paint decided not to draw — and read by `renderTasksHead`.
    tasksToggleEl: null,
    tasksNoteEl: null,
    tasksHidden: 0,
    config: null,
    // Is the aside's SETTINGS block open? `null` means "the config hasn't said yet" and
    // draws closed — closed is the default, so there is no flash of a block that folds
    // itself away a beat later. Once you press the gear this holds a boolean, which is
    // what stops the in-flight config fetch clobbering the press that beat it home.
    settingsOpen: null,
    settingsEl: null,
    // The wrapper that actually animates. The block itself keeps its own padding and
    // border; the fold around it is the grid whose single row goes 0fr ↔ 1fr.
    settingsFoldEl: null,
    settingsGearEl: null,
    // Backstop for the re-pin at the end of the fold. `transitionend` is the real signal
    // and normally arrives first; this covers the case where there is no transition to end
    // — `prefers-reduced-motion`, where the duration is 0 and the event never fires at all.
    // pinRoom is idempotent, so both firing costs nothing.
    settingsPinTimer: null,
    /* ---- the fold. Everything below is per pane, because two leads can be open at once
     * and only the *preference* is one answer for the browser (`asideFolded`). ---- */
    // The panel itself, and the wrapper the freeze acts on. Held rather than looked up:
    // `renderMain` rebuilds this whole aside on every `transcript` frame, so a query
    // selector run later could be answering about a node that is no longer in the document.
    panelEl: null,
    bodyEl: null,
    // The strip's own nodes. Patched on the roster beat rather than rebuilt, which is what
    // lets the pulse below survive a repaint that has nothing to do with it — a replaced
    // node loses a running animation mid-beat.
    stripEl: null,
    stripRoleEl: null,
    stripTasksEl: null,
    stripReviewEl: null,
    stripRoomEl: null,
    // What arrived in the team room while this aside was shut.
    //
    // `unseen` two fields down cannot answer for it: it counts only while `follow` is
    // false — "arrived while you were scrolled up" — and a folded aside is still following
    // its room, so behind a shut door that counter stays at zero forever. There is no
    // server-side unread for the team room either (`server/room.js` keeps none), so this
    // is the only count a folded strip has.
    foldedUnseen: 0,
    // Has it gone *up* since the strip was last painted? The badge pulses twice and stops,
    // so the pulse has to be re-armed by an arrival rather than by a paint — the strip
    // repaints on the roster beat, and a badge that restarted its animation every two
    // seconds would be a panel you fold once.
    foldedPulse: false,
    // Backstop for the end of the fold, where `transitionend` never arrives: reduced
    // motion, where the duration is 0 and no event is emitted at all. It is what takes
    // `is-folding` back off and what runs the remeasure, so it is not optional.
    foldTimer: null,
    // Where the room starts, straight off the server: the `seq` of the last `clear`
    // divider, or `null` for the whole log. Never read from or written to `localStorage` —
    // the panel is an installed app on more than one device and this is one answer for all
    // of them (the maintainer's ruling, 2026-09-08). Arrives on the `room` frame and moves
    // on `room-slate`.
    slate: null,
    // The room head's one button, held so `renderRoomHead` can repaint it without walking
    // the aside for a node the next `renderMain` will have replaced anyway.
    slateBtnEl: null,
    slateBusy: false,
    follow: true, // is the room list pinned to its newest line? see renderRoom
    unseen: 0, // entries that arrived while you were reading further up
    painted: 0, // how many were on screen last paint — the diff is what `unseen` counts
    // Which long entries the reader has opened, keyed by the server's `seq`. It has to be
    // the seq: renderRoom replaces every child on every paint, so a node's own identity
    // is gone by the next arriving line and anything keyed to it would silently re-clamp
    // under whoever was reading. Deliberately not persisted — an open entry is a thing
    // you are doing now, not a preference.
    expanded: new Set(),
    // The merge queue — `GET /api/team/merge`'s last answer, and the floor that keeps the
    // roster beat from turning into a fetch loop. Same shape as the task list beside it,
    // and in `roomView` for the same reason: two leads can be open in two slots, and the
    // block belongs to the repo the pane is a lead of.
    merge: null,
    mergeSig: '',
    mergeAt: 0,
    mergeBusy: false,
    // Pressed here, before the server's own `sent` has come back. The server's window is
    // ten minutes and its `state: 'sent'` takes over within one beat; this only has to
    // bridge the fetch, so it expires on its own rather than outliving the row.
    mergeSent: new Map(), // task id -> {text, at}
    // A refusal, held here rather than appended to the row that was pressed.
    //
    // Measured on the bench: a 409 painted straight onto the node came back on a row a
    // concurrent repaint had *already replaced* — `isConnected: false`, the sentence
    // rendered into a detached tree, nobody ever saw the reason their press did nothing.
    // The room learned the same lesson with `expanded`: state that has to survive a paint
    // cannot live on a node the paint throws away. Keyed by task id, `'*'` for the batch.
    mergeErrors: new Map(), // id | '*' -> {text, at}

  };

  /** How long a locally-pressed row stays locked before the server's answer is the only one. */
  const MERGE_LOCK_MS = 30_000;
  /** How long a refusal stays on screen — the panel is permanent; errors that never leave stack up. */
  const MERGE_ERR_MS = 8000;

  /** Follow the selected session's team: subscribe to its room, or let go of one. */
  function syncRoom(s) {
    const repo = s?.isLead ? s.paneCwd : null;
    if (roomView.repo === repo) return;
    if (roomView.repo) send({ type: 'unsubscribe-room', repo: roomView.repo });
    roomView.repo = repo;
    roomView.entries = [];
    roomView.cursor = 0;
    roomView.tasks = [];
    roomView.tasksSig = '';
    roomView.tasksAt = 0;
    roomView.config = null;
    roomView.settingsOpen = null; // another team, another answer — ask its config again
    // Another team's slate says nothing about this one's. Cleared here and re-answered by
    // the `room` frame the subscribe below brings back, the same as `entries` and `cursor`.
    roomView.slate = null;
    roomView.follow = true; // a room you have just opened is one you are following
    roomView.unseen = 0;
    roomView.painted = 0;
    // Another team's lines are not lines you missed in this one. Reset beside `unseen` and
    // for the same reason, or a folded strip carries a number about a room it is no longer
    // standing in front of.
    roomView.foldedUnseen = 0;
    roomView.foldedPulse = false;
    roomView.expanded.clear(); // another team's seqs mean nothing here
    roomView.merge = null;
    roomView.mergeSig = '';
    roomView.mergeAt = 0;
    roomView.mergeSent.clear(); // another team's task ids mean nothing here either
    roomView.mergeErrors.clear();
    disarmMerge();
    if (repo) send({ type: 'subscribe-room', repo, slot });
  }

  /** Capture whatever is in the composer against the session it belongs to. */
  function saveDraft(sessionId = view.selected) {
    if (!sessionId || !composerEl) return;
    const text = composerEl.ta.value;
    if (text.trim()) state.drafts[sessionId] = text;
    else delete state.drafts[sessionId];
    persistDrafts();
  }


  function open(id) {
    if (view.kind === 'session' && view.selected === id) return;
    saveDraft(); // hold on to what was being typed in the session we're leaving
    leaveShared(); // …and the room's subscription, if that is what this pane was holding
    leaveGroup(); // …or a group room's, which is the server's to stop for the same reason
    // Coming back from a room: the pane stops being one before anything else, or the guards
    // below would keep refusing on its behalf.
    view.kind = 'session';
    view.selected = id;
    rememberOpen(slot, id);
    view.messages = [];
    view.hasEarlier = false;
    view.error = null;
    view.lastMarked = null;
    // A different session's outputs are a different question, and what is about to arrive
    // over the wire is that session's *history* — not new. One reset here covers every way
    // a pane changes hands: the other three (`openShared`, `openGroupRoom`, `close`) stop
    // the pane being a session at all, and it only ever becomes one again through here.
    view.filesNew = false;
    // …and the output set with it, which is the same fact one layer down: a path link is
    // bounded to *this* session's outputs, so a pane that has changed hands must draw none
    // until the new session's list has arrived. The seq bump is what discards an answer
    // still in flight for the session being left.
    view.outputs = [];
    view.outputsSeq += 1;
    view.outputsAgain = false;
    chipNodes.clear();
    send({ type: 'subscribe', sessionId: id, slot });
    refreshOutputs();
    renderRail();
    renderMain();
    // This slot has stopped holding a room, so it has stopped being foldable. Derived
    // rather than remembered — `paintFolds` re-asks every pane what it holds, which is
    // what takes the class off a slot that would otherwise stay 2.5rem wide with a
    // session in it. The worst thing this feature can produce, so it fails open.
    paintFolds();
  }

  /* ------------------------------------------------------------ shared --- */

  /**
   * Put the machine-wide room in this pane.
   *
   * The transcript subscription goes first, and the team room's with it — both are *server*
   * state, and a pane that stopped drawing a session while the server went on tailing its
   * file is the "subscription that outlives its slot" trap from the other end. The room's
   * own subscription then replaces them: `subscribe-shared` answers with the tail and every
   * entry after it, which is why nothing here fetches over HTTP.
   *
   * Opening zeroes the rail row's count, which is the only thing that ever does.
   */
  function openShared() {
    if (view.kind === 'shared') return;
    saveDraft();
    leaveGroup(); // …or a group room, whose subscription is the server's to stop
    send({ type: 'unsubscribe', slot });
    syncRoom(null);
    view.kind = 'shared';
    view.selected = null;
    view.messages = [];
    view.hasEarlier = false;
    view.error = null;
    view.lastMarked = null;
    chipNodes.clear();
    clearShared();
    // `threadSplit` is already settled by the caller — `openSharedRoom` sets it before it
    // gets here, and `adopt` restores it off the stored entry before it calls this.
    rememberOpenShared(slot, true, threadSplit);
    send({ type: 'subscribe-shared', slot });
    // Nothing in the room is new any more. Server-side and account-wide, the same shape
    // `markRead` has for a transcript: the count is one number for the machine, not one
    // per browser.
    send({ type: 'markSharedRead' });
    renderRail();
    renderMain();
    // This slot has stopped holding a room, so it has stopped being foldable. Derived
    // rather than remembered — `paintFolds` re-asks every pane what it holds, which is
    // what takes the class off a slot that would otherwise stay 2.5rem wide with a
    // session in it. The worst thing this feature can produce, so it fails open.
    paintFolds();
  }

  /**
   * Give the room's subscription back, on the way to holding something else.
   *
   * Every other way out of the room already does this — `closeShared` and `close` both say
   * so in their own words — but a pane can also stop holding it by being *given* a session
   * or a thread, and those two paths are easy to miss because nothing looks wrong when they
   * are: the frames go on arriving and `receive` quietly drops them. What is left behind is
   * a server-side listener pushing every entry into a socket for a slot that is drawing a
   * transcript, which is the "subscription that outlives its slot" trap in its cheapest
   * form. A no-op for a pane that was not holding the room, which is what lets both callers
   * say it unconditionally.
   */
  function leaveShared() {
    if (view.kind !== 'shared') return;
    send({ type: 'unsubscribe-shared', slot });
    clearShared();
  }

  /**
   * Everything the room leaves behind, dropped in one place so nothing half-clears — the
   * one function every way out of it goes through (`leaveShared` for a pane being given a
   * session or a thread, `closeShared` for the way out, `close` for a slot going away).
   *
   * It used to save a draft first, being the only place all four paths met. Peer messages
   * has nothing to draft since its composer was retired, so there is nothing to capture and
   * the whole of this is nulling what the pane drew.
   */
  function clearShared() {
    view.shared = [];
    view.sharedCursor = 0;
    view.sharedFollow = true;
    view.sharedUnseen = 0;
    view.sharedPainted = 0;
    view.sharedEl = null;
    view.sharedHintEl = null;
    view.sharedHeadEl = null;
    view.sharedFollowH = null;
    view.sharedOpenKeys.clear();
  }

  /**
   * Leave the room, and put the panel back where it came from.
   *
   * "Back" is two different places: a reader who was in
   * one pane and pressed the rail row gets one pane back, a reader who was already in split
   * keeps both and this slot goes back to a session. `threadSplit` is the only thing that
   * can tell those apart — a pane looking at itself sees the same thing either way.
   */
  function closeShared() {
    if (panes.length > 1 && threadSplit) {
      closePane(slot); // clears `threadSplit` itself — one pane left, no split to own
      return;
    }
    send({ type: 'unsubscribe-shared', slot });
    rememberOpenShared(slot, false);
    view.kind = 'session';
    clearShared();
    adopt();
    // `adopt` repaints by opening something. With nothing to open — no sessions at all —
    // it returns silently and the pane would still be showing the room it was just told to
    // close. Repaint into the empty state instead.
    if (!view.selected) renderMain();
    renderRail();
  }

  /**
   * The shared room, in a pane: every message one session on this Mac sent another, in the
   * order the messages actually happened.
   *
   * It reuses **split view** rather than taking a column of its own — the joint thread's
   * locked ruling, on the same grounds — and it borrows the pane's own furniture (a
   * `.main-head` above, a scrolling middle) so a slot holding the room reads as the same
   * kind of object as a slot holding a conversation.
   *
   * **Nothing is typed here.** The pane had the maintainer's own `@` composer until
   * 2026-09-05; a group room with one member is the same thing with a shared record, so the
   * box went and the log stayed. What is left is a head, a scroller and the `N new below`
   * pill — and `buildComposer` is still never called, which now costs nothing at all.
   */
  function renderSharedPane() {
    host.replaceChildren();
    host.append(buildSharedHead());

    const wrap = document.createElement('div');
    wrap.className = 'shared-room';
    const inner = document.createElement('div');
    inner.className = 'shared-room-inner';
    wrap.append(inner);

    /*
     * Following is an intention, flipped only by a real scroll — never a geometry test at
     * paint time. And a scroll event that arrives because the *box* changed height is the
     * layout moving rather than the reader: Chrome emits one when a resize clamps
     * `scrollTop`, and it is indistinguishable from a real scroll by anything except the
     * height. So a height change swallows the one event it caused, and following survives
     * the split grip being dragged. Both halves are the room aside's, and both were
     * learned there rather than here.
     */
    wrap.addEventListener('scroll', () => {
      if (wrap.clientHeight !== view.sharedFollowH) {
        view.sharedFollowH = wrap.clientHeight;
        return;
      }
      view.sharedFollow = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
      if (view.sharedFollow) {
        view.sharedUnseen = 0; // scrolled back down: you have seen them
        markSharedSeen();
      }
      updateSharedHint();
    });

    // The quiet half of "don't yank the reader": if the room moves on while you are
    // reading back through it, something has to say so — softly. A muted pill over the
    // bottom edge, counting what arrived, clicking it is how you rejoin, and it exists only
    // while you are *not* following. Absolutely positioned against the box, so it never
    // reflows the list under whoever is reading.
    const hint = document.createElement('button');
    hint.className = 'shared-hint';
    hint.type = 'button';
    hint.hidden = true;
    hint.onclick = () => {
      view.sharedFollow = true;
      view.sharedUnseen = 0;
      pinShared();
      markSharedSeen();
      updateSharedHint();
    };
    view.sharedHintEl = hint;

    /*
     * The pill hangs off the scroll box's bottom edge, so it needs a positioned ancestor
     * that is **not** the scrolling box itself — absolute inside a scroller anchors to the
     * content, which scrolls the pill away with the words it is about. `.pane` is not that
     * ancestor either: it is shared with every session pane and giving it a position would
     * re-anchor anything else that is ever absolutely placed in one. So the box and the
     * pill share a frame of their own. Found on the bench, where the pill drew half off the
     * left edge of the pane — it had been anchoring to the window.
     */
    const body = document.createElement('div');
    body.className = 'shared-body';
    body.append(wrap, hint);

    view.sharedEl = { wrap, inner };
    // `.shared-body` stays a frame of its own rather than collapsing into the scroller, and
    // it keeps its `flex: 1`. It exists to be the *positioned* ancestor the `N new below`
    // pill hangs off — `bottom: 1rem` against it — and with the composer gone it simply
    // takes the whole pane under the head.
    host.append(body);
    renderShared();
  }

  /** The room's own header: what it is, how much is in it, and the way out of the pane. */
  function buildSharedHead() {
    const head = document.createElement('div');
    head.className = 'main-head is-shared';

    const mark = document.createElement('span');
    mark.className = 'shared-mark';
    mark.textContent = '⁂';
    mark.title = 'Peer messages — what the sessions on this Mac say to each other';
    head.append(mark);

    const h1 = document.createElement('h1');
    h1.textContent = 'peer messages';
    h1.title = 'Every message one Claude Code session on this machine sent another.';
    head.append(h1);

    const meta = document.createElement('div');
    meta.className = 'head-meta';
    const stat = document.createElement('span');
    stat.className = 'head-status shared-status';
    view.sharedHeadEl = stat;
    meta.append(stat);

    // The room never offers to split — it is already the second thing on screen, and a
    // panel showing the room twice is not a state worth being able to reach. What `close`
    // *does* is decided when it is pressed and never here: this head is drawn once, and the
    // other pane can be opened or closed under it afterwards.
    const close = document.createElement('button');
    close.className = 'ghost-btn';
    close.textContent = 'close';
    close.title = 'Close peer messages';
    close.onclick = closeShared;
    meta.append(close);
    head.append(meta);
    return head;
  }

  /** How much is in the room, and from how many sessions. Repainted with the list, not on
   *  the roster beat — nothing on this line is a fact about the roster. */
  function renderSharedHead(entries) {
    const stat = view.sharedHeadEl;
    if (!stat) return;
    if (!entries.length) {
      stat.textContent = '';
      return;
    }
    // Sessions, so the maintainer's own lines are not counted as one: `from.name` on a
    // `human` entry is a person resolved for the folder that will read it, not a session on
    // this Mac, and a room he has typed twice into would otherwise claim a session that
    // does not exist.
    const names = new Set(entries.filter((e) => e.kind !== 'human').map((e) => e.from?.name).filter(Boolean));
    const m = entries.length;
    stat.textContent = `${m} message${m === 1 ? '' : 's'} · ${names.size} session${names.size === 1 ? '' : 's'}`;
  }

  /**
   * **Sorted on `ts`, never on `seq`.**
   *
   * `seq` is the order the log was *written* and `ts` is the order the messages actually
   * happened, and they come apart for a measured reason rather than a theoretical one: one
   * sweep pass reads several transcripts, so it can meet a reply before it meets the
   * message being replied to and write them in that order (`server/observe.js` stamps each
   * entry with the record's own time for exactly this). A view that trusted `seq` would put
   * an answer above its question, occasionally, with nothing on screen to say why.
   *
   * `seq` is still the tie-break: two messages inside one millisecond have to land in a
   * stable order or they swap places between paints.
   */
  function sharedOrdered() {
    return [...view.shared].sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a.seq || 0) - (b.seq || 0));
  }

  /**
   * Paint the room. Held scroll, one batched measurement — the room aside's two rules, and
   * they are copied for their reasons rather than for their code.
   *
   * `scrollTop` is read **before** the swap. Reading it after `replaceChildren` is a forced
   * layout on an emptied box, which clamps the answer to zero before you have read it — the
   * room's own bug, which put the reader at the top of the list on every arriving line.
   *
   * And every clamp candidate is measured before anything is written to any of them.
   * Interleaving a layout read with a class write per entry is a reflow per entry on a box
   * that repaints whenever a message arrives; two passes is one layout. The controls are
   * built only where they are needed, never built-for-all-and-removed-from-most — that was
   * 66px of silent creep per incoming line, with no scroll event to notice it by.
   */
  function renderShared() {
    const el = view.sharedEl;
    if (!el || !el.inner.isConnected) return;
    const held = el.wrap.scrollTop;
    const follow = view.sharedFollow !== false;
    const entries = sharedOrdered();
    renderSharedHead(entries);

    el.inner.replaceChildren();
    if (!entries.length) {
      const quiet = document.createElement('div');
      quiet.className = 'shared-quiet';
      quiet.textContent =
        'Nothing yet. When one session on this Mac messages another, it lands here.';
      el.inner.append(quiet);
      view.sharedPainted = 0;
      view.sharedUnseen = 0;
      updateSharedHint();
      return;
    }

    const before = view.sharedPainted ?? 0;
    const clamps = [];
    for (const e of entries) el.inner.append(sharedEntryNode(e, clamps));
    for (const c of clamps) c.overflows = c.el.scrollHeight > c.el.clientHeight + 1;
    for (const c of clamps) applySharedClamp(c);
    view.sharedPainted = entries.length;

    if (follow) {
      pinShared();
      view.sharedUnseen = 0;
    } else {
      // Put the reader back exactly where they were. The entries above them are the same
      // entries at the same heights they had last paint — an expanded one re-renders
      // clamped and is un-clamped again before this line — so the old offset is still the
      // right one, and it is only wrong to keep if you are following the bottom.
      el.wrap.scrollTop = held;
      // Floored rather than trusted: a full `shared` frame can *shrink* the list (the tail
      // is capped), and a negative count would hide a hint that is due.
      view.sharedUnseen += Math.max(0, entries.length - before);
    }
    updateSharedHint();
  }

  /** Put the room back on its newest line — but only while you are following it. */
  function pinShared() {
    const el = view.sharedEl;
    if (!el || !el.wrap.isConnected) return;
    // The height this pin was taken at, so the scroll handler can tell a resize's own event
    // from a reader's. Recorded even when we are not following: the box still changed size,
    // and the next event is still the layout's rather than theirs.
    view.sharedFollowH = el.wrap.clientHeight;
    if (view.sharedFollow === false) return;
    el.wrap.scrollTop = el.wrap.scrollHeight;
  }

  /** Draw (or drop) the "new below" pill. Quiet by design — muted ink, no accent, no
   *  motion, and it exists only while the reader is not following. */
  function updateSharedHint() {
    const hint = view.sharedHintEl;
    if (!hint) return;
    const n = view.sharedFollow === false ? view.sharedUnseen || 0 : 0;
    hint.hidden = n === 0;
    if (n === 0) return;
    hint.textContent = n === 1 ? '1 new below ↓' : `${n} new below ↓`;
    hint.title = 'Jump to the newest message and follow the room again.';
  }

  /** Tell the server the count is spent. Only ever from this pane, and only while it is
   *  actually the room on screen — the count is one number for the machine. */
  function markSharedSeen() {
    if (view.kind !== 'shared') return;
    send({ type: 'markSharedRead' });
  }

  /**
   * Clamp one long message to ten lines behind a quiet "view more" — the joint thread's
   * number rather than the aside's five, and for its reason: these are whole messages
   * between two sessions, and folding one at five hides the message instead of trimming it.
   *
   * Nothing is decided here and nothing is drawn here. The element goes out clamped and
   * registered; `renderShared` measures the whole batch at once and `applySharedClamp` is
   * what puts a control on screen, because a message that fits must not grow a "view more"
   * that does nothing when clicked.
   */
  function sharedClampable(node, e, pending) {
    node.classList.add('shared-clamp');
    pending.push({ key: sharedKey(e), el: node, btn: null, overflows: false });
  }

  /** One entry's identity across paints. `seq` alone is enough here and is not in the joint
   *  thread: that view merges two rooms whose per-repo seqs collide, this is one file with
   *  one counter, monotonic across a rotation. */
  const sharedKey = (e) => String(e.seq ?? '');

  /** Settle one measured candidate: no overflow, no control; otherwise draw its state. */
  function applySharedClamp(c) {
    if (!c.overflows) {
      c.el.classList.remove('shared-clamp');
      return;
    }
    const open = view.sharedOpenKeys.has(c.key);
    c.el.classList.toggle('shared-clamp', !open);
    if (!c.btn) {
      c.btn = document.createElement('button');
      c.btn.className = 'shared-more';
      c.btn.type = 'button';
      c.btn.onclick = () => toggleSharedEntry(c);
      c.el.after(c.btn); // directly under the words it cut off, inside the bubble
    }
    c.btn.textContent = open ? 'view less' : 'view more';
    c.btn.title = open ? 'Fold this message back to ten lines.' : 'Show the whole message.';
  }

  /**
   * Open or fold one message, keeping it where the reader is looking.
   *
   * `sharedFollow` is deliberately untouched and nothing is pinned: expanding changes the
   * box's height and that must never read as the reader having scrolled away, and a message
   * you have just opened is one you are about to read, so snapping to the newest line is
   * exactly the yank the rule exists to stop. Growing a node never moves its own top, so
   * the anchor holds for free on the way open; folding is the case that needs the
   * arithmetic, because the browser clamps `scrollTop` to the new maximum.
   */
  function toggleSharedEntry(c) {
    if (view.sharedOpenKeys.has(c.key)) view.sharedOpenKeys.delete(c.key);
    else view.sharedOpenKeys.add(c.key);
    const wrap = view.sharedEl?.wrap;
    const node = c.el.closest('.shared-msg');
    if (!wrap || !node || !node.isConnected) {
      applySharedClamp(c);
      return;
    }
    const was = node.getBoundingClientRect().top;
    applySharedClamp(c);
    const now = node.getBoundingClientRect().top;
    if (now !== was) wrap.scrollTop += now - was;
  }

  /**
   * One entry in the peer-message log.
   *
   * **One lane, all left-aligned.** This log has N sessions and there is no second side to
   * lane against. The name pill carries the identity instead.
   *
   * **`from-human` is a live path over dead-ended data, and it stays.** Nothing writes a
   * `kind: 'human'` entry any more — the `@` composer that did was retired on 2026-09-05 —
   * but three of the seven entries in `~/.foreman/shared-room.jsonl` are that composer's
   * history, and deleting this branch would blank them. They keep the full-width accent-edge
   * shape the joint thread uses, because that shape means *this one could authorize*.
   *
   * **Colour goes on the pill, never on the bubble body.** The maintainer's own recorded
   * correction: two tinted bodies in one column are two competing page backgrounds rather
   * than two labels. So the pill takes a `--peer-N` hue keyed on the speaker's name and the
   * bubble is byte-identical whoever spoke.
   *
   * **Keyed on `from.name`**, which is what `colourFor` wants and why: a pid dies with the
   * sender and a pane id can be reissued as `%0` by a fresh tmux server, while the name is
   * the one thing an entry still carries when it is read back tomorrow. Two sessions that
   * share a name share a colour, which is fine for a colour and would be fatal for an
   * identity — and is exactly why the identity is stored resolved on the entry and only the
   * hue is derived.
   */
  function sharedEntryNode(e, pending = []) {
    const human = e.kind === 'human';
    const name = e.from?.name || 'unknown';

    const wrap = document.createElement('div');
    wrap.className = `shared-msg ${human ? 'from-human' : 'from-peer'}`;

    const meta = document.createElement('div');
    meta.className = 'shared-meta';

    const who = document.createElement('span');
    who.className = `shared-pill${human ? ' is-human' : ''}`;
    who.textContent = human ? 'you' : name;
    if (!human) {
      // The hue is set inline off the ring rather than by a class per slot: `--peer-N` is
      // seven tokens and a class each would be seven near-identical rules that a later
      // change to `PEER_COLOUR_COUNT` would silently leave short. `currentColor` on the
      // border is what keeps the ring one value per speaker rather than two.
      who.style.color = `var(--peer-${colourFor(name)})`;
      who.style.borderColor = 'currentColor';
      who.title = e.from?.cwd ? `${name}\n${e.from.cwd}` : name;
    } else {
      // Historical only: these are the entries the retired `@` composer left behind.
      who.title = 'You — typed into that session from this panel';
    }
    meta.append(who);

    /*
     * A worker's line says so. The maintainer's ruling of 2026-09-04 split the two
     * directions: a worker cannot be `@`-addressed, but a worker's message *to its lead* is
     * shown — the one real non-scratch peer message on this machine is exactly that, a
     * worker reporting a release done. The tag is what stops it reading as a peer session
     * talking to another, and it is read off `fromRole` on the entry rather than guessed at
     * from the name, because the role was resolved when the message was collected and the
     * roster row behind it may be long gone.
     */
    if (!human && e.fromRole === 'worker') {
      const tag = document.createElement('span');
      tag.className = 'shared-tag';
      tag.textContent = 'worker';
      tag.title = 'A worker reporting to its lead — workers are shown here but cannot be addressed.';
      meta.append(tag);
    }

    /*
     * How well the sender was identified, when the answer is "not very". `fromSource` is
     * `registry` when the pid still resolved to a live roster row, and `name` when it did
     * not and the row was matched on the session's name instead — a *guess*, because the
     * registry file is deleted within seconds of a session exiting. It has to be visible
     * rather than merely true on the record: a wrong guess believed is worse than a right
     * one labelled. `panel` is this panel's own line and needs no marker.
     */
    if (!human && e.fromSource === 'name') {
      const tag = document.createElement('span');
      tag.className = 'shared-tag is-guess';
      tag.textContent = 'by name';
      tag.title =
        'The sender had already exited, so this was matched on its session name rather than ' +
        'resolved from the sender itself. Two sessions that share a name are indistinguishable here.';
      meta.append(tag);
    }

    // Who it was sent to. A machine-wide log has no "other end" the way a two-ended thread
    // does, so the recipient is the only thing that makes a line a message rather than an
    // utterance — quiet, and after the sender, because the sender is the identity.
    if (e.to?.name) {
      const to = document.createElement('span');
      to.className = 'shared-to';
      to.textContent = `→ ${e.to.name}`;
      to.title = e.to.cwd ? `to ${e.to.name}\n${e.to.cwd}` : `to ${e.to.name}`;
      meta.append(to);
    }

    if (e.ts) {
      const t = document.createElement('span');
      t.className = 'shared-time';
      const d = new Date(e.ts);
      t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      t.title = d.toLocaleString();
      meta.append(t);
    }
    wrap.append(meta);

    const bubble = document.createElement('div');
    bubble.className = 'shared-bubble';
    const text = document.createElement('div');
    text.className = 'shared-text';
    // `text` is `origin.body` and nothing else — the observer's own rule, upheld here by
    // rendering the field and never reaching for anything beside it. The record the message
    // arrived in carries the same words wrapped in ~600 characters of peer-safety
    // boilerplate, and a bubble built from that would be the boilerplate.
    text.textContent = e.text || '';
    bubble.append(text);
    // The control lands under the words it cut off and above the delivery line below —
    // that is short machinery, and a clamp must never swallow it.
    sharedClampable(text, e, pending);

    // The maintainer's own line, and what became of it. `queued` means handed off, not
    // read: the queue may hold it for hours, and the vaguer verb is the trigger's own
    // hard-won honesty. Quiet register either way — this is a fact to read, not an error.
    if (human) {
      const line = document.createElement('div');
      line.className = 'shared-delivery';
      const to = e.to?.name || 'that session';
      if (e.queued) {
        line.classList.add('is-waiting');
        line.textContent = `queued for ${to} — waiting for its pane to be free`;
      } else {
        line.textContent = `delivered to ${to}`;
      }
      bubble.append(line);
    }

    wrap.append(bubble);
    return wrap;
  }

  /* --------------------------------------------------------- group room --- */

  /*
   * One named room, in a pane: its members along the top, everything said in it below, and
   * a box to say something into.
   *
   * It is the shared room's shape and almost none of its code, and the split is deliberate.
   * What is **copied** is the reasoning, every piece of which was paid for somewhere else in
   * this repo and is re-recorded at the line it governs: the order (`ts`, `seq` only as the
   * tie-break), the scroll held across a paint, the clamp measured in one batch and its
   * control built only where it is needed, the quiet `N new below` pill, the colour on the
   * pill and never on the bubble, and a composer that does not go through `buildComposer`.
   * What is **not** shared is the CSS or the functions: `.shared-*` belongs to a feature
   * whose future is explicitly deferred (the plan's Q5), and a view quietly depending on its
   * rules would come apart on the day that is answered, in a stylesheet nobody was looking
   * at. That is the same trade `.shared-*` itself made against the retired `.link-*`, and
   * it is worth
   * paying a second time.
   *
   * Two things here have no analogue one pane over. A room has a **header that acts** —
   * rename, add, remove, archive — where the shared room's is a label; every destructive one
   * of those goes through `armConfirm`, which is the maintainer's own ruling on destructive
   * controls (#11). And a room has **one destination**, so the composer has no `@` target
   * and no chip: a line typed here goes to everybody in the room, which is what the standing
   * sentence under the box says.
   */

  /** One room's half-written message. Keyed by room, because there are many of them and a
   *  draft written for one must never be restored into another. */
  const groupDraftKey = (id) => `group:${id}`;

  /** Hold on to what was being typed. No target rides along — the shared room's draft carries
   *  one because it has to pick a session; a room *is* the destination. */
  function saveGroupDraft() {
    const id = view.groupRoom?.id;
    if (!groupComposerEl || !id) return;
    const text = groupComposerEl.ta.value;
    if (text.trim()) state.drafts[groupDraftKey(id)] = text;
    else delete state.drafts[groupDraftKey(id)];
    persistDrafts();
  }

  /** …and drop it once it has actually been sent. */
  function clearGroupDraft() {
    const id = view.groupRoom?.id;
    if (!id) return;
    delete state.drafts[groupDraftKey(id)];
    persistDrafts();
  }

  /**
   * The room record as the **roster** last described it, or the one this pane is holding.
   *
   * The roster carries every room, open and archived, and it is the live answer: a rename or
   * a member added from another browser arrives on the next beat with nobody touching this
   * pane. The held record is the fallback for the beat between a press and the frame that
   * confirms it, and for a room the roster has somehow stopped carrying — the pane keeps
   * what it had rather than blanking.
   */
  function groupLive() {
    const id = view.groupRoom?.id;
    if (!id) return null;
    return state.rooms.find((r) => r?.id === id) || view.groupRoom;
  }

  /**
   * Put one group room in this pane.
   *
   * The transcript subscription goes first, and the team room's with it — both are *server*
   * state, and a pane that stopped drawing a session while the server went on tailing its
   * file is the "subscription that outlives its slot" trap from the other end. The room's own
   * subscription then replaces them: `subscribe-group-room` answers with the tail and every
   * entry after it, which is why nothing here fetches over HTTP.
   *
   * Opening zeroes the band row's count, which is the only thing that ever does.
   */
  function openGroup(id) {
    if (!id) return;
    if (view.kind === 'group-room' && view.groupRoom?.id === id) return;
    saveDraft();
    leaveShared(); // …or the shared room, whose subscription is the server's to stop
    leaveGroup(); // …or another room, whose subscription is one per socket and supersedes
    send({ type: 'unsubscribe', slot });
    syncRoom(null);
    view.kind = 'group-room';
    view.selected = null;
    view.messages = [];
    view.hasEarlier = false;
    view.error = null;
    view.lastMarked = null;
    chipNodes.clear();
    clearGroup();
    // The record we have now, so the head has a name to draw before the first frame lands.
    // The frame carries the authoritative one a moment later.
    view.groupRoom = state.rooms.find((r) => r?.id === id) || { id, name: 'room', members: [] };
    // `threadSplit` is already settled by the caller — `openGroupRoom` sets it before it gets
    // here, and `adopt` restores it off the stored entry before it calls this.
    rememberOpenGroup(slot, id, threadSplit);
    send({ type: 'subscribe-group-room', roomId: id, slot });
    renderRail();
    renderMain();
    /*
     * The fold's bookkeeping, and it runs **before** the mark below rather than after it.
     *
     * A room opened from the band always arrives open (`openGroupRoom` says so by clearing
     * the preference first), but a *reload* comes back through `adopt` straight into here,
     * and it comes back folded if it was folded. Whether this room's count is spent depends
     * on whether the reader can actually see it — so the classes have to be on the panes
     * before `markGroupSeen` is asked, or a reload behind a shut door would zero the very
     * number the strip exists to carry.
     */
    paintFolds();
    // Nothing in it is new any more — unless it is folded, in which case nothing has been
    // read and `markGroupSeen` refuses on its own. Server-side either way, the same shape
    // `markSharedRead` has: the count is one number for the machine, not one per browser.
    markGroupSeen();
  }

  /**
   * Give a room's subscription back, on the way to holding something else.
   *
   * `leaveShared`'s reason verbatim: a pane can stop holding a room by being *given* a
   * session, a thread or another room, and nothing looks wrong when it does — the frames go
   * on arriving and `receive` quietly drops them, while a server-side listener pushes every
   * entry into a socket for a slot that is drawing a transcript. A no-op for a pane that was
   * not holding one, which is what lets every caller say it unconditionally.
   */
  function leaveGroup() {
    if (view.kind !== 'group-room') return;
    send({ type: 'unsubscribe-group-room', slot });
    clearGroup();
  }

  /**
   * Everything a room leaves behind, dropped in one place so nothing half-clears.
   *
   * The draft is captured **first**, before anything below it is nulled — this is the one
   * function every way out goes through (`leaveGroup` for a pane being given something else,
   * `closeGroup` for the way out, `close` for a slot going away), so putting the save
   * anywhere else would mean finding all three and keeping them in step. It is a no-op when
   * there is no composer, which is what lets `openGroup` call it on the way *in* without
   * writing anything.
   */
  function clearGroup() {
    saveGroupDraft();
    view.groupRoom = null;
    view.groupEntries = [];
    view.groupCursor = 0;
    view.groupFollow = true;
    view.groupUnseen = 0;
    view.groupPainted = 0;
    view.groupEl = null;
    view.groupHintEl = null;
    view.groupHeadEl = null;
    view.groupStripEl = null;
    view.groupErrEl = null;
    // The fold's own nodes and its counter. The counter goes with them: another room's
    // lines are not lines you missed in this one, and a strip carrying a number about a
    // room it is no longer standing in front of would be the panel lying quietly.
    view.groupBodyEl = null;
    view.groupFoldEls = null;
    view.groupFoldSeen = 0;
    view.groupAddPopEl = null;
    view.groupFollowH = null;
    view.groupOpenKeys.clear();
    view.groupRenaming = false;
    view.groupAddOpen = false;
    view.groupArchivedDrawn = null;
    // A held refusal belongs to the press that raised it and a press in flight belongs to the
    // pane that started it — `roomView.mergeErrors`' lesson, for its reasons.
    view.groupHeadError = null;
    view.groupError = null;
    view.groupBusy = false;
    view.groupHeadBusy = false;
    groupComposerEl = null;
    groupStripSig = '';
  }

  /**
   * Leave the room, and put the panel back where it came from.
   *
   * `closeShared`'s reasoning verbatim, and it is the same two places: a reader who was in
   * one pane and pressed a band row gets one pane back, a reader who was already in split
   * keeps both and this slot goes back to a session. `threadSplit` is the only thing that can
   * tell those apart — a pane looking at itself sees the same thing either way.
   */
  function closeGroup() {
    if (panes.length > 1 && threadSplit) {
      closePane(slot); // clears `threadSplit` itself — one pane left, no split to own
      return;
    }
    send({ type: 'unsubscribe-group-room', slot });
    rememberOpenGroup(slot, null);
    view.kind = 'session';
    clearGroup();
    adopt();
    // `adopt` repaints by opening something. With nothing to open — no sessions at all — it
    // returns silently and the pane would still be showing the room it was just told to
    // close. Repaint into the empty state instead.
    if (!view.selected) renderMain();
    renderRail();
    // This slot has stopped holding a room, so it has stopped being foldable. Derived
    // rather than remembered — `paintFolds` re-asks every pane what it holds, which is
    // what takes the class off a slot that would otherwise stay 2.5rem wide with a
    // session in it. The worst thing this feature can produce, so it fails open.
    paintFolds();
  }

  /**
   * The room, in a pane.
   *
   * `buildComposer` is never called, for the reason the retired joint thread and the retired
   * peer-message composer both recorded: it reads `s.prompt`, `s.plan`, `s.question`,
   * `s.mode` and `s.model`, all null at once with no session behind the pane, and
   * `shortModel(null)` throwing *inside* it once took a pane down after it had decided to
   * draw a question card and left it unable to heal on any later frame.
   * `buildGroupComposer` is its own small composer instead — the same trade, made three
   * times now for one reason.
   *
   * **An archived room draws no composer at all**, and that is the shape of the pane rather
   * than a disabled button: the endpoint refuses a post to it with a 409, and a box that
   * takes typing it cannot send is a control that lies about itself. The log stays readable,
   * which is what archiving means — nothing here deletes a room or a line of one.
   */
  function renderGroupPane() {
    const room = groupLive();
    const archived = Boolean(room?.archivedAt);
    view.groupArchivedDrawn = archived;

    host.replaceChildren();
    /*
     * One wrapper around everything that is *in the flow* — the head, the list and the
     * composer — and it exists for the fold.
     *
     * While the pane is narrowing to a strip its content must keep the width it was
     * measured at and be clipped, rather than re-wrapping through forty intermediate ones.
     * That is not tidiness: `renderGroup`'s clamp pass caches `scrollHeight >
     * clientHeight` per entry, and it goes on running while the pane is folded because
     * `isConnected` is still true — a measurement taken at 2.5rem is wrong and it is
     * *cached onto the DOM*. So the fold pins this box to the pane's measured expanded
     * width (`--room-frozen`) and the pane clips it; the remeasure on expand is the
     * backstop behind that.
     *
     * The strip is the wrapper's sibling rather than its child, because the two of them
     * cross-fade: the wrapper's opacity is what goes to zero, and a strip inside it would
     * go with it.
     */
    const flow = document.createElement('div');
    flow.className = 'group-pane-body';
    view.groupBodyEl = flow;
    flow.append(buildGroupHead());

    const wrap = document.createElement('div');
    wrap.className = 'group-room';
    const inner = document.createElement('div');
    inner.className = 'group-room-inner';
    wrap.append(inner);

    /*
     * Following is an intention, flipped only by a real scroll — never a geometry test at
     * paint time. And a scroll event that arrives because the *box* changed height is the
     * layout moving rather than the reader: Chrome emits one when a resize clamps
     * `scrollTop`, and it is indistinguishable from a real scroll by anything except the
     * height. So a height change swallows the one event it caused, and following survives the
     * split grip being dragged. Both halves are the room aside's, learned there rather than
     * here and copied through the shared room.
     */
    wrap.addEventListener('scroll', () => {
      if (wrap.clientHeight !== view.groupFollowH) {
        view.groupFollowH = wrap.clientHeight;
        return;
      }
      view.groupFollow = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
      if (view.groupFollow) {
        view.groupUnseen = 0; // scrolled back down: you have seen them
        markGroupSeen();
      }
      updateGroupHint();
    });

    // The quiet half of "don't yank the reader": if the room moves on while you are reading
    // back through it, something has to say so — softly. A muted pill over the bottom edge,
    // counting what arrived, clicking it is how you rejoin, and it exists only while you are
    // *not* following. Absolutely positioned against the box, so it never reflows the list
    // under whoever is reading.
    const hint = document.createElement('button');
    hint.className = 'group-hint';
    hint.type = 'button';
    hint.hidden = true;
    hint.onclick = () => {
      view.groupFollow = true;
      view.groupUnseen = 0;
      pinGroup();
      markGroupSeen();
      updateGroupHint();
    };
    view.groupHintEl = hint;

    /*
     * The pill hangs off the scroll box's bottom edge, so it needs a positioned ancestor that
     * is **not** the scrolling box itself — absolute inside a scroller anchors to the
     * content, which scrolls the pill away with the words it is about. `.pane` is not that
     * ancestor either: it is shared with every session pane and giving it a position would
     * re-anchor anything else that is ever absolutely placed in one. So the box and the pill
     * share a frame of their own. Measured on the shared room's bench, where the pill drew
     * half off the left edge of the pane — it had been anchoring to the window.
     */
    const body = document.createElement('div');
    body.className = 'group-body';
    body.append(wrap, hint);

    view.groupEl = { wrap, inner };
    flow.append(body);

    if (archived) {
      // Said where the composer would have been, because that is where a reader looks for
      // the box. Not an error: archiving is a state somebody chose, and the room is still
      // exactly as readable as it was.
      const shut = document.createElement('div');
      shut.className = 'group-shut';
      shut.textContent =
        'This room is archived. Everything in it is still here to read; nothing more is typed into anyone.';
      flow.append(shut);
    } else {
      /*
       * The composer goes **beside** `.group-body`, not inside it, and that is a placement
       * with a reason rather than a preference. `.group-body` exists to be the positioned
       * frame the `N new below` pill hangs off — `bottom: 1rem` against it — so a composer
       * added as a third child of that frame would put the pill 1rem above the *composer's*
       * bottom edge, floating over the textarea instead of over the words it is about.
       */
      flow.append(buildGroupComposer());
    }

    /*
     * The fold is applied **at build time**, from what is already on the host, on children
     * that are not in the document yet — which is what stops a rebuild re-running the
     * animation. `renderGroupPane` runs again whenever the room is archived from another
     * browser, and every transition in this fold is gated on `is-folding`, which only
     * `applyRoomFold` adds; a pane rebuilt folded has never had another width and there is
     * nothing for a transition to run between.
     */
    host.append(flow, buildGroupFoldStrip());
    // Tab must not walk into a column that is 2.5rem wide and clipped. `inert` is what the
    // aside's own fold uses one panel over, for its reason: a block hidden by `overflow` is
    // invisible and still focusable, and still read out.
    flow.inert = host.classList.contains('is-strip');

    renderGroup();
    // Sizing needs the textarea in the document — `scrollHeight` is 0 before that, so a
    // restored multi-line draft would sit crammed into a two-row box. The session composer's
    // own ordering, and its reason.
    groupComposerEl?.autoGrow();
  }

  /* ------------------------------------------------------- the header --- */

  /** The room's own header: what it is called, how much is in it, the members, and the two
   *  controls that change the room itself. Built once per pane; everything on it that can
   *  move is repainted by `renderGroupHead` and `renderGroupStrip`. */
  function buildGroupHead() {
    const box = document.createElement('div');
    box.className = 'group-head';

    const head = document.createElement('div');
    head.className = 'main-head is-group';

    const mark = document.createElement('span');
    mark.className = 'group-mark';
    mark.textContent = '◎';
    mark.title = 'A group room — a handful of sessions coordinating on one thing';
    head.append(mark);

    /*
     * The name, and it renames **in place**. A button rather than an `h1` with a click
     * handler, because a thing that acts when it is pressed has to be reachable from the
     * keyboard and announce itself as pressable; the heading role rides on it so the pane
     * still has one. Escape cancels, Enter commits, and a blur cancels rather than committing
     * — a rename you walked away from is one you did not finish.
     */
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'group-name';
    name.setAttribute('role', 'heading');
    name.setAttribute('aria-level', '1');
    name.title = 'Rename this room';
    name.onclick = () => startGroupRename(name);
    head.append(name);

    /*
     * The tally goes on a **second line**, under the name, rather than beside it in
     * `.head-meta` where every other pane's status sits. Two reasons, and neither is taste.
     * A room's name is the one thing on this header a reader is looking for and it is
     * user-typed, so it is the part that ellipsises — sharing the line with a tally that
     * never shrinks meant a name losing characters to `12 messages · 4 members`. And the
     * controls are the other fixed thing on that line: pushed right by `.head-meta`'s
     * `margin-left: auto`, they moved leftwards as the tally grew, so a button was at a
     * different place on a busy room than on a quiet one.
     *
     * It is a grid rather than a wrapped flex line because the buttons must stay on the
     * *name's* row while the tally sits under it — a wrap would take them down with it. The
     * rail's three-line team row is the same shape and the same `grid-column: 2 / -1` for
     * the extra line; see the trap it is recorded under.
     */
    const meta = document.createElement('div');
    meta.className = 'head-meta';

    const stat = document.createElement('div');
    stat.className = 'head-status group-status group-tally';
    view.groupHeadEl = { name, stat, meta };
    head.append(stat);

    /*
     * The control that folds this whole slot away, first in the cluster.
     *
     * Here rather than anywhere else because this header has the room — it carries `close`
     * and `archive` and nothing else, unlike a session pane's, which CLAUDE.md records
     * overflowing at plain half and half on any window under about 1400px.
     *
     * `foldIcon('collapse')` rather than a word or a bare chevron, and rather than a
     * drawing of its own: it is the mark the lead's team aside wears on its own band, and
     * the strip below draws its `'expand'` twin, so a reader learns one control and finds it
     * in both panels. The word is the *action* rather than a direction on screen, which is
     * what lets one drawing serve a room in either slot — and `test/aside-fold.test.js` pins
     * that `foldIcon` has exactly one definition, so a local copy here is not an option.
     *
     * `renderGroupHead` hides it while there is only one pane. A room alone in the frame has
     * nothing to fold beside it, and a frame that was nothing but a strip would be a panel
     * with no content and no obvious way back — `roomFoldSlot` refuses that case too, which
     * is the same refusal said twice on purpose: once where a reader can see it, once where
     * the geometry is decided.
     */
    const fold = document.createElement('button');
    fold.className = 'ghost-btn room-fold-btn';
    fold.append(foldIcon('collapse'));
    fold.title = 'Fold this room down to a strip. It still counts what arrives in it.';
    fold.setAttribute('aria-label', 'Fold this room away');
    fold.onclick = () => {
      roomFolded.set(true);
      applyRoomFold(true);
    };
    view.groupHeadEl.fold = fold;

    // The room never offers to split — it is already the second thing on screen, and a panel
    // showing one room twice is not a state worth being able to reach. What `close` *does* is
    // decided when it is pressed and never here: this head is drawn once, and the other pane
    // can be opened or closed under it afterwards.
    const close = document.createElement('button');
    close.className = 'ghost-btn';
    close.textContent = 'close';
    close.title = 'Close this room';
    close.onclick = closeGroup;
    meta.append(fold, close);
    head.append(meta);
    box.append(head);

    const strip = document.createElement('div');
    strip.className = 'group-strip';
    view.groupStripEl = strip;
    box.append(strip);

    // The header's own refusals, painted from view state and never onto the node that was
    // pressed — the strip repaints on the roster beat, so a sentence written onto a chip's ✕
    // would be in a detached tree within two seconds.
    const err = document.createElement('div');
    err.className = 'group-head-err';
    err.hidden = true;
    view.groupErrEl = err;
    box.append(err);

    renderGroupHead();
    renderGroupStrip();
    return box;
  }

  /**
   * The name, the tally and the archive control — repainted on the roster beat, because every
   * one of them is a fact about the record and the record moves under this pane.
   *
   * The one thing it will not touch is a name being edited: a repaint that put the heading
   * back would take the input out from under a caret mid-word, on a beat nobody asked for.
   */
  function renderGroupHead() {
    const els = view.groupHeadEl;
    if (!els) return;
    const room = groupLive();
    if (!room) return;

    // An archive changes the pane's *shape* rather than its contents — the composer goes —
    // and it can land from another browser. Redraw the whole pane when it does, which is rare
    // enough to cost nothing and is the only thing a head repaint cannot do on its own.
    if (view.groupArchivedDrawn !== null && Boolean(room.archivedAt) !== view.groupArchivedDrawn) {
      renderGroupPane();
      return;
    }

    if (!view.groupRenaming) {
      els.name.textContent = room.name || 'room';
      els.name.title = `Rename “${room.name || 'room'}”`;
    }

    const n = view.groupEntries.length;
    const members = room.members?.length || 0;
    els.stat.textContent = `${n} message${n === 1 ? '' : 's'} · ${members} member${members === 1 ? '' : 's'}`;

    // A room alone in the frame has nothing to fold beside it, so the control is not drawn
    // — a control nobody can press should not be drawn is this panel's own rule, and it is
    // why the disabled `split` button came off a lead's header. Re-asked on the roster beat
    // because the second pane can be opened and closed under this head.
    if (els.fold) els.fold.hidden = panes.length < 2;

    /*
     * The archive control, beside `close`.
     *
     * The **node** is replaced only when the word on it changes, so an armed confirmation is
     * never taken away by an unrelated roster beat — `roomsSig`'s rule, and the strip one line
     * down follows it too. The **handler** is re-bound on every call regardless, which is
     * `patchBand`'s own recorded reason one column over: a handler closing over a stale room
     * record is exactly the class of bug the reuse is otherwise inviting. Found on the bench —
     * a room renamed while the pane was open still asked *"archive “the old name”?"*, which is
     * a confirmation naming something that is not there any more.
     */
    const want = room.archivedAt ? 'unarchive' : 'archive';
    if (els.archive?.dataset.word !== want) {
      const btn = document.createElement('button');
      btn.className = 'ghost-btn';
      btn.dataset.word = want;
      btn.textContent = want;
      if (els.archive) els.archive.replaceWith(btn);
      else els.meta.insertBefore(btn, els.meta.lastChild);
      els.archive = btn;
    }
    const btn = els.archive;
    if (room.archivedAt) {
      btn.title = 'Put this room back in the open list, so it can be posted to again.';
      // Unarchiving takes nothing away, so it asks nothing. `armConfirm` is for the
      // destructive half — the maintainer's ruling names destructive controls, not every
      // control.
      btn.onclick = () => patchGroup({ archived: false }, btn);
    } else {
      btn.title = 'Stop anything more being posted to this room. Everything in it stays readable.';
      btn.onclick = () =>
        armConfirm(btn, `archive “${room.name || 'this room'}”?`, () => patchGroup({ archived: true }, btn));
    }
  }

  /** Swap the heading for an input, and put it back whatever happens next. */
  function startGroupRename(btn) {
    const room = groupLive();
    if (!room || view.groupRenaming) return;
    view.groupRenaming = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-name-edit';
    // A courtesy, not the authority: `server/rooms.js` refuses an over-long name rather than
    // shortening it, and that refusal is what gets shown if one arrives by paste.
    input.maxLength = MAX_ROOM_NAME;
    input.value = room.name || '';

    const done = (commit) => {
      if (!view.groupRenaming) return;
      view.groupRenaming = false;
      const next = input.value.trim();
      if (input.isConnected) input.replaceWith(btn);
      renderGroupHead();
      if (commit && next && next !== room.name) patchGroup({ name: next }, btn);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    };
    // A rename you walked away from is one you did not finish. Cancelling on blur is the
    // conservative half: the worst it costs is retyping, where committing would rename a room
    // because somebody clicked elsewhere.
    input.onblur = () => done(false);

    btn.replaceWith(input);
    input.focus();
    input.select();
  }

  /** What the strip last drew, so a roster beat that changed nothing rebuilds nothing.
   *  `roomsSig`'s reason, and the sharper one here: these chips carry `armConfirm` questions
   *  that live four seconds, and a rebuild would take one away from under the cursor about to
   *  answer it. Status is deliberately *out* of it — a dot is patched in place below. */
  let groupStripSig = '';

  /**
   * The members strip: a chip per member with a live status dot, an ✕ to remove it, and the
   * `+` that adds another.
   *
   * **Rebuilt only when the membership changes; the dots are patched.** A status moves every
   * couple of seconds and a rebuild on that beat would be the "question taken away from under
   * the cursor" bug the whole signature idiom exists to stop — and here it would be taking
   * away a *confirmation to remove somebody*. So the structure has a signature and the dots
   * do not.
   *
   * The dot is resolved through `memberRow`, which mirrors the server's own rung order, and
   * its answer decides **only the dot**: the fan-out re-resolves against a fresh roster read
   * at post time. A member that resolves to nothing is drawn plainly and said to be gone,
   * rather than dropped — a chip that vanished would leave a room whose membership the panel
   * disagrees with the server about, silently.
   */
  function renderGroupStrip() {
    const strip = view.groupStripEl;
    if (!strip) return;
    const room = groupLive();
    if (!room) return;
    const members = Array.isArray(room.members) ? room.members : [];
    const archived = Boolean(room.archivedAt);

    const sig = [
      room.id,
      archived ? 1 : 0,
      view.groupAddOpen ? 1 : 0,
      members.map((m) => [memberKey(m), memberName(m)].join('|')).join('~'),
    ].join('#');

    if (sig !== groupStripSig) {
      groupStripSig = sig;
      // A question armed on a chip this rebuild is about to replace. Scoped, so one pane
      // never answers for the other's.
      disarmConfirm(strip);
      strip.replaceChildren();

      for (const m of members) {
        const chip = document.createElement('span');
        chip.className = 'group-chip';
        chip.dataset.member = memberKey(m);

        const dot = document.createElement('span');
        dot.className = 'dot';
        chip.append(dot);

        const who = document.createElement('span');
        who.className = 'group-chip-name';
        who.textContent = memberName(m);
        chip.append(who);

        if (!archived) {
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'group-chip-x';
          x.textContent = '×';
          x.title = `Take ${memberName(m)} out of this room. It stops receiving what is said here.`;
          // Behind a question, because it takes something away — the maintainer's ruling on
          // destructive controls (#11). Nothing about it deletes anything the room has
          // already recorded; the log keeps every line the member was handed.
          x.onclick = () =>
            armConfirm(x, `remove ${memberName(m)}?`, () => patchGroup({ remove: memberKey(m) }, x));
          chip.append(x);
        }
        strip.append(chip);
      }

      if (!archived) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'group-add';
        add.textContent = '+';
        add.title = 'Put another session in this room';
        add.onclick = () => {
          view.groupAddOpen = !view.groupAddOpen;
          renderGroupStrip();
        };
        strip.append(add);

        // The popover, a child of the strip so it is positioned against it — and rebuilt with
        // the strip rather than kept, because what is in it is a live list of who can be
        // added and a row that has left the roster must not still be clickable.
        const pop = document.createElement('div');
        pop.className = 'group-add-pop';
        pop.hidden = !view.groupAddOpen;
        strip.append(pop);
        view.groupAddPopEl = pop;
      } else {
        view.groupAddPopEl = null;
      }
    }

    // The dots, every beat, patched onto the chips that are already there. A member that
    // resolves to no row gets the `gone` shape and says so on hover.
    for (const m of members) {
      const chip = [...strip.children].find((c) => c.dataset?.member === memberKey(m));
      if (!chip) continue;
      const row = memberRow(m, state.sessions);
      const dot = chip.firstChild;
      if (dot) dot.className = `dot ${row ? row.status : 'gone'}`;
      chip.title = row
        ? `${memberName(m)}${row.project ? ` · ${row.project}` : ''}\n${row.status}`
        : `${memberName(m)} — not in the panel right now. Anything said here is recorded as ` +
          'not reached until it is back.';
      chip.classList.toggle('is-gone', !row);
    }

    if (view.groupAddOpen) renderGroupAdd();
    renderGroupHeadError();
  }

  /**
   * Who is left to add, in the create modal's own order and off the same allow-list.
   *
   * Repainted whenever the strip is, and on the roster beat while it is open, for the shared
   * picker's reason: it is a live list of who can be addressed, so a session appearing or
   * going away has to move it — a row that has left the roster must not still be clickable.
   */
  function renderGroupAdd() {
    const pop = view.groupAddPopEl;
    if (!pop) return;
    const room = groupLive();
    pop.hidden = !view.groupAddOpen;
    if (!view.groupAddOpen || !room) return;
    pop.replaceChildren();

    // The folder in front of you: whichever session is open in a pane. `orderForHere` puts
    // those first — a room is usually the sessions you are looking at — and it is a sort
    // rather than a filter, because filtering would make a cross-project room unbuildable.
    const openId = panes.map((p) => p.selected()).find(Boolean) || null;
    const here = rowFolder(state.sessions.find((s) => s.id === openId));
    const rows = addableSessions(state.sessions, room, here);

    // `MAX_MEMBERS` is the client's **fallback**, never a second authority — the create
    // modal's own rule, and `server/rooms.js` refuses anything past its own cap with a
    // sentence that is shown verbatim. Two rungs, and this is the cheap one.
    const why = addReason(room, state.sessions, MAX_MEMBERS);
    if (why) {
      const none = document.createElement('p');
      none.className = 'group-add-none';
      none.textContent = why;
      pop.append(none);
      return;
    }

    for (const s of rows) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'group-add-row';

      const dot = document.createElement('span');
      dot.className = `dot ${s.status}`;
      item.append(dot);

      const label = document.createElement('span');
      label.className = 'group-add-name';
      label.textContent = rowName(s);
      item.append(label);

      if (s.isLead) {
        const role = document.createElement('span');
        role.className = 'group-add-role';
        role.textContent = 'lead';
        item.append(role);
      }

      const where = document.createElement('span');
      where.className = 'group-add-where';
      where.textContent = s.project || '';
      where.title = s.paneCwd || s.cwd || '';
      item.append(where);

      // The **id**, which is what `PATCH /api/rooms/:id` looks up — never the row's position,
      // because a roster frame between the paint and the press would choose whoever moved
      // into that slot. The retired peer-message picker recorded the same reasoning.
      item.onclick = () => {
        view.groupAddOpen = false;
        patchGroup({ add: s.id }, item);
      };
      pop.append(item);
    }
  }

  /** The header's standing refusal, drawn from view state and never from a pressed node. */
  function renderGroupHeadError() {
    const err = view.groupErrEl;
    if (!err) return;
    err.textContent = view.groupHeadError || '';
    err.hidden = !view.groupHeadError;
  }

  /**
   * Rename, add, remove, archive — one press, one PATCH.
   *
   * **The server's own sentence is what a refusal says**, verbatim: every one of them names
   * the thing that is wrong (the character in the name, the count against the cap, the
   * session that has exited, the member that is not in the room), and a paraphrase here would
   * be the panel's guess at a refusal it did not make. The create modal makes the same call
   * one band up and for the same reason.
   *
   * Nothing is drawn from the answer. `PATCH` broadcasts a roster frame, the frame carries
   * every room, and the head and the strip repaint off it — so the record on screen is always
   * the one the store holds rather than the one this browser hoped for.
   */
  async function patchGroup(body, btn) {
    const id = view.groupRoom?.id;
    if (!id || view.groupHeadBusy) return;
    view.groupHeadBusy = true;
    if (btn) btn.disabled = true;
    try {
      const data = await postJSONMethod('PATCH', `/api/rooms/${encodeURIComponent(id)}`, body);
      view.groupHeadError = null;
      // The frame is authoritative and is a beat away; this is only so the head is not stale
      // for that beat. The pane may have been given something else while this was out.
      if (view.kind === 'group-room' && view.groupRoom?.id === id && data.room) view.groupRoom = data.room;
    } catch (err) {
      view.groupHeadError = err.message;
    } finally {
      view.groupHeadBusy = false;
      // `btn` may have been replaced by a repaint while this was in flight — the rail's
      // `duplicating` guard in miniature, and re-enabling a detached node costs nothing.
      if (btn) btn.disabled = false;
      if (view.kind === 'group-room') {
        renderGroupHead();
        renderGroupStrip();
      }
    }
  }

  /* --------------------------------------------------------- the list --- */

  /**
   * **Sorted on `ts`, never on `seq`.** See `roomOrdered`'s own note in `web/rooms-pane.js`
   * for why the two come apart here, and why `seq` is still the tie-break.
   */
  const groupOrdered = () => roomOrdered(view.groupEntries);

  /**
   * Paint the room. Held scroll, one batched measurement — the room aside's two rules, copied
   * for their reasons rather than for their code.
   *
   * `scrollTop` is read **before** the swap. Reading it after `replaceChildren` is a forced
   * layout on an emptied box, which clamps the answer to zero before you have read it — the
   * aside's own bug, which put the reader at the top of the list on every arriving line.
   *
   * And every clamp candidate is measured before anything is written to any of them.
   * Interleaving a layout read with a class write per entry is a reflow per entry on a box
   * that repaints whenever a message arrives; two passes is one layout. The controls are
   * built only where they are needed, never built-for-all-and-removed-from-most — that was
   * 66px of silent creep per incoming line, with no scroll event to notice it by.
   */
  function renderGroup() {
    const el = view.groupEl;
    if (!el || !el.inner.isConnected) return;
    const held = el.wrap.scrollTop;
    const follow = view.groupFollow !== false;
    const entries = groupOrdered();
    renderGroupHead();

    el.inner.replaceChildren();
    if (!entries.length) {
      const quiet = document.createElement('div');
      quiet.className = 'group-quiet';
      quiet.textContent =
        'Nothing said in here yet. Anything a member posts — or anything you type below — is ' +
        'typed into every other member’s terminal.';
      el.inner.append(quiet);
      view.groupPainted = 0;
      view.groupUnseen = 0;
      updateGroupHint();
      return;
    }

    const before = view.groupPainted ?? 0;
    const clamps = [];
    for (const e of entries) el.inner.append(groupEntryNode(e, clamps));
    for (const c of clamps) c.overflows = c.el.scrollHeight > c.el.clientHeight + 1;
    for (const c of clamps) applyGroupClamp(c);
    view.groupPainted = entries.length;

    if (follow) {
      pinGroup();
      view.groupUnseen = 0;
    } else {
      // Put the reader back exactly where they were. The entries above them are the same
      // entries at the same heights they had last paint, so the old offset is still the right
      // one, and it is only wrong to keep if you are following the bottom.
      el.wrap.scrollTop = held;
      // Floored rather than trusted: a full `group-room` frame can *shrink* the list (the
      // tail is capped), and a negative count would hide a hint that is due.
      view.groupUnseen += Math.max(0, entries.length - before);
    }
    updateGroupHint();
  }

  /** Put the room back on its newest line — but only while you are following it. */
  function pinGroup() {
    const el = view.groupEl;
    if (!el || !el.wrap.isConnected) return;
    // The height this pin was taken at, so the scroll handler can tell a resize's own event
    // from a reader's. Recorded even when we are not following: the box still changed size,
    // and the next event is still the layout's rather than theirs.
    view.groupFollowH = el.wrap.clientHeight;
    if (view.groupFollow === false) return;
    el.wrap.scrollTop = el.wrap.scrollHeight;
  }

  /** Draw (or drop) the "new below" pill. Quiet by design — muted ink, no accent, no motion,
   *  and it exists only while the reader is not following. */
  function updateGroupHint() {
    const hint = view.groupHintEl;
    if (!hint) return;
    const n = view.groupFollow === false ? view.groupUnseen || 0 : 0;
    hint.hidden = n === 0;
    if (n === 0) return;
    hint.textContent = n === 1 ? '1 new below ↓' : `${n} new below ↓`;
    hint.title = 'Jump to the newest message and follow the room again.';
  }

  /**
   * Tell the server this room's count is spent. Only from this pane, only while it is
   * actually the room on screen — the count is one number for the machine — and **never
   * while the pane is folded**.
   *
   * That last clause is the one that is easy to leave out and it mutes the room in two
   * places at once. The rail band deliberately draws no count for a room a pane is holding
   * (`patchBand`, on the rule that two counters saying different things about one box is
   * worse than one saying it in the right place), so behind a shut door the strip's badge is
   * the *only* thing counting — and marking read here would zero the server's number the
   * badge is drawn from. A folded room would then be a room the panel had quietly silenced,
   * which is exactly what this feature is not allowed to do.
   *
   * Asked of the pane's own class rather than of `roomFolded`, because the class is what is
   * true on screen: mid-fold, and for a pane the preference has not reached yet, the two
   * disagree and the pane is right.
   */
  function markGroupSeen() {
    if (view.kind !== 'group-room' || !view.groupRoom?.id) return;
    if (host.classList.contains('is-strip')) return;
    send({ type: 'markGroupRoomRead', roomId: view.groupRoom.id, slot });
  }

  /* --------------------------------------------------------- the fold --- */

  /**
   * The strip: what this room says with its door shut.
   *
   * Built with the pane and **patched** from then on, never rebuilt on the roster beat.
   * Two reasons and the second is the sharp one: the member dots carry `.dot.working`'s
   * pulse and the badge carries its own, so replacing the nodes every couple of seconds
   * would take a running animation away half a beat after it started — and the badge's
   * pulse is the whole of how a folded panel says something arrived.
   *
   * A strip is a door, not a window: a name, a dot per member, and a count. No message
   * text, ever, which is `roomStripFacts`' own rule one module over and CLAUDE.md's
   * "prefer showing nothing over showing something wrong" underneath it.
   *
   * It is a `<button>` because it is one — the whole column is the control that reopens the
   * room, and the chevron at the top is the affordance that says so. Being a button also
   * settles the focus ring for free: Chrome draws `:focus-visible` for a keyboard and
   * nothing for a mouse press, and `addPane`'s own `mousedown` handler is taught to leave a
   * press on a strip alone.
   */
  function buildGroupFoldStrip() {
    const strip = document.createElement('button');
    strip.className = 'fold-strip';
    strip.type = 'button';
    strip.title = 'Open this room';
    strip.setAttribute('aria-label', 'Open this room');
    strip.onclick = () => {
      roomFolded.set(false);
      applyRoomFold(false);
    };

    // Pinned at the top, where the control that shut the panel was, so the eye goes back to
    // the same corner to reopen it — and it is the header control's own mark with the
    // chevron the other way round, which is the pair the lead's aside already draws. The box
    // and the ink are `.fold-strip-chev`'s, shared with that aside, so nothing about the size
    // or the colour is spelled twice.
    const chev = document.createElement('span');
    chev.className = 'fold-strip-chev';
    chev.append(foldIcon('expand'));

    const label = document.createElement('span');
    label.className = 'fold-strip-label';

    const dots = document.createElement('span');
    dots.className = 'fold-strip-dots';

    const badge = document.createElement('span');
    badge.className = 'fold-strip-badge';
    badge.hidden = true;

    view.groupFoldEls = { strip, label, dots, badge };
    strip.append(chev, label, dots, badge);
    renderGroupFoldStrip();
    return strip;
  }

  /**
   * Repaint the strip's name, its dots and its badge.
   *
   * Off `roomStripFacts`, which resolves each member through `memberRow` — the same rung
   * order `server/rooms-line.js` uses, imported rather than re-spelled, so a live dot never
   * appears beside a member the fan-out will record as unreachable.
   *
   * **The number is the server's**, off `room.unseen` on the roster, and deliberately not
   * `view.groupUnseen`: that one is incremented only while the reader is scrolled up, and a
   * folded pane is still following its room, so it stays at zero behind a shut door and a
   * badge built on it would never appear at all.
   *
   * Called from `renderHead` on the roster beat and **never from `composerSig`** — a count
   * changing must not tear a textarea down under whoever is typing.
   */
  function renderGroupFoldStrip() {
    const els = view.groupFoldEls;
    if (!els) return;
    const room = groupLive();
    const facts = roomStripFacts(room, state.sessions);

    els.label.textContent = facts.name;
    els.label.title = facts.name;

    // The dots are reused rather than replaced, and only added or removed when the
    // membership itself changes: `.dot.working` carries an animation, and a rebuild every
    // couple of seconds would restart it on every beat.
    const want = facts.dots.length;
    while (els.dots.childElementCount > want) els.dots.lastElementChild.remove();
    while (els.dots.childElementCount < want) els.dots.append(document.createElement('span'));
    facts.dots.forEach((status, i) => {
      els.dots.children[i].className = `dot ${status}`;
    });

    els.badge.hidden = facts.unseen === '';
    els.badge.textContent = facts.unseen;
    els.badge.title = facts.unseen ? 'New in this room since you folded it away' : '';

    // The pulse, armed by the number going *up* and never by a paint. Removing the class,
    // forcing a synchronous reflow and putting it back is what actually restarts a CSS
    // animation — re-assigning the same class name does nothing, and `requestAnimationFrame`
    // never fires in an automated Chrome window, which is where this has to be provable.
    const now = Math.max(0, Number(room?.unseen) || 0);
    if (now > (view.groupFoldSeen || 0)) {
      els.badge.classList.remove('is-new');
      void els.badge.offsetWidth;
      els.badge.classList.add('is-new');
    } else if (!now) {
      // A spent badge drops the pulse with the number, so a class meaning "this just
      // arrived" never rides along on a node about to be shown for a different arrival.
      els.badge.classList.remove('is-new');
    }
    view.groupFoldSeen = now;
  }

  /** How wide `--strip` actually is, in px, measured off the node wearing it rather than
   *  converted from a token — `tokens.css`' own note says this is how `foldTracks`' `stripW`
   *  is meant to be resolved, so the stylesheet and the animation's arithmetic cannot come
   *  to disagree about how wide a closed panel is. */
  function stripWidth() {
    return view.groupFoldEls?.strip.getBoundingClientRect().width || 0;
  }

  /** Pin the flow content to the width it was measured at, for the length of the fold.
   *  The measurement is the caller's, taken while the expanded geometry was still in force
   *  — a rect read a line later would be read against tracks that have already moved. */
  function freezeGroupBody(w) {
    if (w > 0) host.style.setProperty('--room-frozen', `${w}px`);
  }

  /** Arm (or disarm) this pane's half of the cross-fade. Class-gated for the reason the
   *  grid's own transition is: a pane that carried one at rest would fade its content every
   *  time the split grip moved. */
  function setGroupFolding(on) {
    host.classList.toggle('is-folding', Boolean(on));
  }

  /**
   * Put this pane where the fold says, with no animation of its own.
   *
   * Unconditional cleanup in the `false` direction, and that is deliberate: a pane that has
   * just been given a session must lose the class and the frozen width whether or not it
   * ever held a room, or a slot that was a strip a moment ago stays 2.5rem wide with a
   * transcript in it. That is the worst thing this feature can produce, so every uncertainty
   * lands here.
   */
  function setGroupFolded(want) {
    const on = Boolean(want) && view.kind === 'group-room';
    if (host.classList.contains('is-strip') === on) return;
    /*
     * The freeze, for the path that does not animate.
     *
     * `applyRoomFold` measures the width itself and hands it to `freezeGroupBody` while the
     * open geometry is still in force, so on that path this finds one already set and leaves
     * it — reading a rect *here* would force layout after the tracks have moved and pin the
     * content at 2.5rem, which is the one number the freeze exists to keep it away from. But
     * a fold applied by `paintFolds` — a reload's `adopt`, a slot changing hands — never went
     * through that function at all, and it runs before the first paint, so the pane is still
     * at its open width and this is the honest moment to read it.
     */
    if (on && !host.style.getPropertyValue('--room-frozen')) {
      freezeGroupBody(host.getBoundingClientRect().width);
    }
    host.classList.toggle('is-strip', on);
    if (view.groupBodyEl) view.groupBodyEl.inert = on;
    if (!on) {
      // The door is open, so the count is spent — fired at the *start* of the expand so the
      // round trip overlaps the animation rather than following it, and the badge is fading
      // out through the whole 200ms either way. `markGroupSeen` reads the class this line
      // has just changed, which is why the order matters.
      markGroupSeen();
      // The pin stays for the length of an animated expand — the content has to keep the
      // width it will land at while the pane grows into it, or it re-wraps through every
      // intermediate one and `endGroupFold`'s remeasure is remeasuring nothing. `endGroupFold`
      // is what drops it there. With no animation in flight this *is* the end.
      if (!host.classList.contains('is-folding')) host.style.removeProperty('--room-frozen');
    }
  }

  /**
   * The end of a fold, from either the event or the backstop, and safe to run twice.
   *
   * The remeasure is the part that is not optional. `renderGroup`'s clamp pass caches
   * `scrollHeight > clientHeight` per entry and kept running while the pane was folded — the
   * freeze stops it measuring a 2.5rem column, and this is what puts the honest answers back
   * once the pane has stopped moving. `pinGroup` follows it for the room aside's own reason:
   * the box changed height, so a room that was on its newest line is no longer on it.
   */
  function endGroupFold() {
    setGroupFolding(false);
    if (host.classList.contains('is-strip')) return;
    host.style.removeProperty('--room-frozen');
    if (view.kind !== 'group-room') return;
    renderGroup();
    pinGroup();
  }

  /**
   * Clamp one long message behind a quiet "view more" — ten lines, the shared room's number
   * rather than the aside's five, and for its reason: these are whole messages between
   * sessions, and folding one at five hides the message instead of trimming it.
   *
   * Nothing is decided here and nothing is drawn here. The element goes out clamped and
   * registered; `renderGroup` measures the whole batch at once and `applyGroupClamp` is what
   * puts a control on screen, because a message that fits must not grow a "view more" that
   * does nothing when clicked.
   */
  function groupClampable(node, e, pending) {
    node.classList.add('group-clamp');
    pending.push({ key: entryKey(e), el: node, btn: null, overflows: false });
  }

  /** Settle one measured candidate: no overflow, no control; otherwise draw its state. */
  function applyGroupClamp(c) {
    if (!c.overflows) {
      c.el.classList.remove('group-clamp');
      return;
    }
    const open = view.groupOpenKeys.has(c.key);
    c.el.classList.toggle('group-clamp', !open);
    if (!c.btn) {
      c.btn = document.createElement('button');
      c.btn.className = 'group-more';
      c.btn.type = 'button';
      c.btn.onclick = () => toggleGroupEntry(c);
      c.el.after(c.btn); // directly under the words it cut off, inside the bubble
    }
    c.btn.textContent = open ? 'view less' : 'view more';
    c.btn.title = open ? 'Fold this message back to ten lines.' : 'Show the whole message.';
  }

  /**
   * Open or fold one message, keeping it where the reader is looking.
   *
   * `groupFollow` is deliberately untouched and nothing is pinned: expanding changes the box's
   * height and that must never read as the reader having scrolled away, and a message you have
   * just opened is one you are about to read, so snapping to the newest line is exactly the
   * yank the rule exists to stop. Growing a node never moves its own top, so the anchor holds
   * for free on the way open; folding is the case that needs the arithmetic, because the
   * browser clamps `scrollTop` to the new maximum.
   */
  function toggleGroupEntry(c) {
    if (view.groupOpenKeys.has(c.key)) view.groupOpenKeys.delete(c.key);
    else view.groupOpenKeys.add(c.key);
    const wrap = view.groupEl?.wrap;
    const node = c.el.closest('.group-msg');
    if (!wrap || !node || !node.isConnected) {
      applyGroupClamp(c);
      return;
    }
    const was = node.getBoundingClientRect().top;
    applyGroupClamp(c);
    const now = node.getBoundingClientRect().top;
    if (now !== was) wrap.scrollTop += now - was;
  }

  /**
   * One message in the room.
   *
   * **One lane, all left-aligned.** A room has up to eight speakers and there is no second
   * side to lane against. The name pill
   * carries the identity instead, and the maintainer's own lines take the `from-human` shape —
   * full width with an accent left edge — because that shape already means *this one can
   * authorize*, and it is the one thing in here that has to be structurally distinguishable
   * rather than merely a different colour. It is also literally true of the wire: those are
   * the `| ` lines every member's terminal receives, and every other line is `> `.
   *
   * **Colour goes on the pill, never on the bubble body.** The maintainer's own recorded
   * correction: two tinted bodies in one column are two competing page backgrounds rather than
   * two labels. So the pill takes a `--peer-N` hue keyed on the speaker's name and the bubble
   * is byte-identical whoever spoke.
   *
   * **Keyed on the entry's own `from`**, which is a name and is what `colourFor` wants: a pane
   * id can be reissued as `%0` by a fresh tmux server, while the name is the one thing an
   * entry still carries when it is read back tomorrow. Two sessions that share a name share a
   * colour, which is fine for a colour and would be fatal for an identity.
   */
  function groupEntryNode(e, pending = []) {
    const human = e.kind === 'human';
    const name = e.from || 'unknown';

    const wrap = document.createElement('div');
    wrap.className = `group-msg ${human ? 'from-human' : 'from-peer'}`;

    const meta = document.createElement('div');
    meta.className = 'group-meta';

    const who = document.createElement('span');
    who.className = `group-pill${human ? ' is-human' : ''}`;
    who.textContent = human ? 'you' : name;
    if (!human) {
      // The hue is set inline off the ring rather than by a class per slot: `--peer-N` is
      // seven tokens and a class each would be seven near-identical rules that a later change
      // to `PEER_COLOUR_COUNT` would silently leave short. `currentColor` on the border is
      // what keeps the ring one value per speaker rather than two.
      who.style.color = `var(--peer-${colourFor(name)})`;
      who.style.borderColor = 'currentColor';
      who.title = name;
    } else {
      who.title = 'You, from this room in the panel — every member gets a copy carrying your authority.';
    }
    meta.append(who);

    if (e.ts) {
      const t = document.createElement('span');
      t.className = 'group-time';
      const d = new Date(e.ts);
      t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      t.title = d.toLocaleString();
      meta.append(t);
    }

    /*
     * Who this post named, when it named anybody — muted, beside the timestamp, no accent
     * and no motion, because it is a fact to read rather than something to act on.
     *
     * Read off the entry's own `to`, never by re-scanning `e.text` for `@` tokens: the parse
     * lives in `server/rooms-line.js` and running a second one here is the one thing
     * `web/rooms-pane.js`'s header refuses. An entry written before mentions existed carries
     * no `to`, draws no line, and is right not to — the log is append-only and nothing goes
     * back to fill it in.
     *
     * Note the field name is **taken** one pane over: an entry in the machine-wide room
     * carries its own `to`, an object `{name, cwd}` naming the one session a native message
     * went to. `addressedNames` answers `[]` for anything that is not an array, which is what
     * keeps these two nodes — near-identical to read, and both in this file — from drawing
     * each other's field.
     */
    const addressed = addressedText(e);
    if (addressed) {
      const el = document.createElement('span');
      el.className = 'group-to';
      el.textContent = addressed;
      el.title =
        'Addressed with @name. Every member still got a copy — a mention changes what each ' +
        'one was told, not who was told.';
      meta.append(el);
    }
    wrap.append(meta);

    const bubble = document.createElement('div');
    bubble.className = 'group-bubble';
    const text = document.createElement('div');
    text.className = 'group-text';
    // `text` is the body as it was posted and nothing else. The line each member's terminal
    // received carries the same words wrapped in the envelope's peer-safety boilerplate, and a
    // bubble built from that would be the boilerplate.
    text.textContent = e.text || '';
    bubble.append(text);
    // The control lands under the words it cut off and above the handed line below — that is
    // short machinery, and a clamp must never swallow it.
    groupClampable(text, e, pending);

    /*
     * What became of this post, on **every** entry rather than only the maintainer's: a room
     * fans out from whoever spoke, so a session's post has exactly the same question hanging
     * off it as one of his. The word is **handed**, never *delivered* — a queued copy waits
     * for a pane to go idle, which may be hours and may be never, and nothing writes back to
     * an append-only log. Quiet register either way: this is a fact to read, not an error.
     */
    const line = document.createElement('div');
    line.className = 'group-handed';
    if (handedWaiting(e)) line.classList.add('is-waiting');
    line.textContent = handedText(e);
    line.title =
      'Handed means typed into a terminal or put in that pane’s queue. Nothing here says ' +
      'anybody read it.';
    bubble.append(line);

    wrap.append(bubble);
    return wrap;
  }

  /* ----------------------------------------------------- the composer --- */

  /**
   * The maintainer's own box — and it is **simpler than the peer-message composer that used
   * to sit one pane over**, because a room has one destination. No target, no chip, no
   * picker: a line typed here goes to every member, which is exactly what the standing
   * sentence under it says.
   *
   * `@name` does not change that and is not a picker in disguise. That retired `@`
   * *chose who a message was sent to* and lifted the token out of the text; this one types
   * a name **into** the body and nothing else — the send still carries `{text}` and nothing
   * more, the endpoint still fans out to every member, and the menu below is an aid to
   * spelling a name correctly. A mention changes what each recipient is told, never who is
   * told: the maintainer's own ruling, and `server/rooms-line.js`'s header carries it.
   *
   * `buildComposer` is still never called, for the reason `renderGroupPane` records: that
   * function reads five session fields that are all null here and one of them
   * (`shortModel(null)`) has already thrown inside it and taken a pane down. So this is a
   * textarea, a send button and two lines of chrome — no attachments, no queue chip, no
   * interrupt row, no ghost text, no permission bar, no mode control, and **no signature**:
   * this composer is torn down only when the pane stops holding this room.
   */
  function buildGroupComposer() {
    const wrap = document.createElement('div');
    wrap.className = 'group-composer';
    const inner = document.createElement('div');
    inner.className = 'group-composer-inner';
    wrap.append(inner);

    // The standing refusal, painted from `view.groupError` and never appended to whatever node
    // was pressed — see the field's own note.
    const err = document.createElement('div');
    err.className = 'group-composer-err';
    err.hidden = true;

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Say it once — Enter to send, Shift+Enter for a new line, @ to name someone';

    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 224)}px`;
    };

    /*
     * The `@name` menu, built once and shown or hidden. Absolutely placed against
     * `.group-composer`, so it opens *over* the room rather than pushing the textarea down
     * under whoever is typing into it — the shared room's popover, and its reason.
     *
     * Its state is a closure and not a `view.` field on purpose: this composer is torn down
     * only when the pane stops holding this room (it is deliberately outside `composerSig`
     * and outside every repaint the socket causes), so there is nothing for a half-typed
     * `@alp` to survive. A `view.` field would be state that outlives the box it belongs to.
     */
    const menu = document.createElement('div');
    menu.className = 'group-mention';
    menu.hidden = true;
    // `mutedAt` is what makes Escape stick: without it the very next keystroke re-detects
    // the same `@` and reopens the menu the reader just dismissed — the scar the retired
    // peer-message picker left behind.
    let open = null; // {start, names, index} while the menu is up
    let mutedAt = -1;

    const closeMention = ({ muted = false } = {}) => {
      if (muted && open) mutedAt = open.start;
      open = null;
      menu.hidden = true;
      menu.replaceChildren();
    };

    /** Take one name: the half-typed token is replaced and the caret lands after it. */
    const chooseMention = (name) => {
      const q = mentionQuery(ta.value, ta.selectionStart ?? 0);
      if (!q) return void closeMention();
      const next = insertMention(ta.value, q.start, ta.selectionStart ?? 0, name);
      ta.value = next.value;
      ta.selectionStart = next.caret;
      ta.selectionEnd = next.caret;
      closeMention();
      autoGrow();
      saveGroupDraft();
      ta.focus();
    };

    const paintMention = () => {
      menu.replaceChildren();
      if (!open) return void (menu.hidden = true);
      menu.hidden = false;
      open.names.forEach((name, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `group-mention-row${i === open.index ? ' is-on' : ''}`;
        row.textContent = name;
        // The name travels on the node, never the index: the room's membership can change
        // between this paint and the click, and a position would then choose whoever moved
        // into that slot. `mousedown` is prevented so focus never leaves the textarea.
        row.dataset.name = name;
        row.onmousedown = (e) => e.preventDefault();
        row.onclick = () => chooseMention(name);
        menu.append(row);
      });
    };

    /** Open, refresh or close the menu for whatever the caret is sitting in now. */
    const syncMention = () => {
      const q = mentionQuery(ta.value, ta.selectionStart ?? 0);
      if (!q || q.start === mutedAt) return void closeMention();
      const names = mentionMatches(q.query, view.groupRoom);
      // Nothing matches: no menu rather than an empty box saying so. A room's membership is
      // eight names at most, and a mention naming nobody is plain text rather than an error.
      if (!names.length) return void closeMention();
      const moved = !open || open.start !== q.start;
      open = { start: q.start, names, index: moved ? 0 : Math.min(open.index, names.length - 1) };
      paintMention();
    };

    ta.value = state.drafts[groupDraftKey(view.groupRoom?.id)] || '';
    ta.oninput = () => {
      autoGrow();
      saveGroupDraft();
      syncMention();
    };
    // A click or an arrow key moves the caret without changing the text, so the menu has to
    // be re-asked there too — otherwise it stays open over a token the caret has left.
    ta.onclick = syncMention;
    ta.onblur = () => closeMention();
    ta.onkeydown = (e) => {
      if (open) {
        if (e.key === 'Escape') {
          e.preventDefault();
          return void closeMention({ muted: true });
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          open.index = (open.index + step + open.names.length) % open.names.length;
          return void paintMention();
        }
        // Enter and Tab both take the highlighted name. Enter is stolen from the send on
        // purpose: a menu is up because a name is half-typed, and sending `@alp` to everybody
        // is never what that keystroke meant.
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return void chooseMention(open.names[open.index]);
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendGroupMessage();
      }
      // The caret has moved by the time the browser has handled the key, so the menu is
      // re-asked after it rather than before.
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
        setTimeout(syncMention, 0);
      }
    };

    const row = document.createElement('div');
    row.className = 'group-composer-row';

    /*
     * What a line typed here *is*, in the panel's own voice — said every time rather than in a
     * tooltip nobody opens, because the envelope makes exactly this claim on the way out. It
     * says **both** halves and neither is decoration: it carries the maintainer's authority
     * (the `| ` prefix, which no session's body can reach), and it reaches everybody (a room
     * fans out to every other member, so this is never a quiet word to one of them).
     */
    const hint = document.createElement('span');
    hint.className = 'group-composer-hint';
    hint.textContent = 'your own words, to every member — they may act on them';
    hint.title =
      'This goes out as your own line, prefixed so no session can forge it, and a copy is ' +
      'typed into every member’s terminal.';

    const btn = document.createElement('button');
    btn.className = 'send-btn';
    btn.textContent = 'send';
    btn.onclick = sendGroupMessage;

    row.append(hint, btn);
    inner.append(err, ta, row);
    // Beside the inner column rather than in it, so the menu is placed against the composer
    // and does not sit in the flex flow that lays the textarea out.
    wrap.append(menu);

    groupComposerEl = { wrap, ta, btn, err, menu, autoGrow, closeMention };
    renderGroupError();
    return wrap;
  }

  /** The composer's standing refusal, drawn from view state and never from a pressed node. */
  function renderGroupError() {
    const el = groupComposerEl;
    if (!el) return;
    el.err.textContent = view.groupError || '';
    el.err.hidden = !view.groupError;
  }

  /**
   * Send what is in the box to everybody in the room.
   *
   * **No `paneId` in the body**, and that is the whole of who is speaking: the endpoint
   * decides the speaker by what the request carries — a pane id means a session posting
   * through its own tool, nothing means the panel, and the panel is the maintainer. There is
   * no `speaker` field to set and there must never be one.
   *
   * **The server's own sentence is what a refusal says**, never a paraphrase and never a
   * generic "that didn't work". The refusals it can answer with are things only it can know —
   * the room is archived, a limit was hit and when it lifts — or they name the exact character
   * in the body that made it unsendable. Such a character is *refused with the character
   * named*, never stripped: a body that could make a quoted line draw as an unquoted one is a
   * working forgery, and silently rewriting somebody's input hands them a way to have it
   * rewritten into something else. Nothing here trims, escapes or normalises the value on the
   * way out.
   *
   * **Nothing is drawn locally on success.** The endpoint appends the entry and the store
   * emits it, so the socket's `group-room-append` brings it back to this very pane — appending
   * it here as well would draw the maintainer's own message twice, with its handed line, and
   * the second copy would look exactly as real as the first.
   */
  async function sendGroupMessage() {
    const el = groupComposerEl;
    if (!el || view.groupBusy) return;
    const id = view.groupRoom?.id;
    if (!id) return;
    const text = el.ta.value;
    if (!text.trim()) return;

    view.groupBusy = true;
    el.btn.disabled = true;
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
      view.groupError = null;
      // The pane may have been given a session, or another room, while this was out.
      if (view.kind === 'group-room' && view.groupRoom?.id === id && groupComposerEl === el) {
        el.ta.value = '';
        el.autoGrow();
        // The box is empty, so any `@name` menu still up is over a token that no longer
        // exists. Enter-to-send keeps the focus, so a blur will not do this for us.
        el.closeMention();
        clearGroupDraft();
      }
    } catch (err) {
      // Held, not appended: this pane repaints whenever a message arrives in the room, and a
      // sentence painted onto a node a repaint has already replaced is a sentence nobody sees.
      // The box keeps its text — a refused message is one the reader may want to re-time
      // rather than retype.
      view.groupError = err.message;
    } finally {
      view.groupBusy = false;
      if (groupComposerEl === el) el.btn.disabled = false;
      renderGroupError();
    }
  }

  /* -------------------------------------------------------------- main --- */

  function renderMain() {
    // The machine-wide room has no session and nothing below this line applies to it: no
    // head to patch, no room to follow, no stream, and — the one that has already cost this
    // repo a pane that never healed — no composer. `buildComposer` reads `s.prompt`,
    // `s.plan`, `s.question`, `s.mode` and `s.model`, all of which are null at once here,
    // and `shortModel(null)` threw inside it once already and unwound the whole build. So it
    // gets its own small pane rather than teaching that one to cope with having no session.
    if (view.kind === 'shared') return renderSharedPane();
    // …and one group room, for every word of the same reason. Two panes now that have no
    // session behind them, and neither has been allowed to teach `buildComposer` to cope
    // with that — see `renderGroupPane`.
    if (view.kind === 'group-room') return renderGroupPane();

    const s = current();
    host.replaceChildren();

    if (!s) {
      host.append(
        emptyState('No sessions found', 'Open one with `+ new`, or start Claude Code anywhere on this machine.'),
      );
      return;
    }

    host.append(buildHead(s));

    // A lead's pane is two frames: your conversation with the lead on the left, the room
    // on the right and view-only. You talk to the lead and the lead talks to the room — a
    // human posting into it would make it ambiguous who is actually directing a worker,
    // which is the one thing this whole system exists to keep clear. Everything else lands
    // in `mount` so the normal path is untouched.
    syncRoom(s);
    let mount = host;
    if (s.isLead) {
      const cols = document.createElement('div');
      cols.className = 'lead-cols';
      const left = document.createElement('div');
      left.className = 'lead-left';
      cols.append(left, buildRoomPanel());
      host.append(cols);
      mount = left;
      // The aside's two dividers were built inside `buildRoomPanel`, before it was in the
      // document — and both of their ceilings are read off rects, which are all zero until
      // then. So the stored sizes are put on the page here, after the mount and before the
      // two paints below, or the Tasks block would take its five-row cut against a height
      // it is about to stop having. This also prunes the previous aside's pair.
      applyResizers();
      // …and the fold's own measurement, which needs a rect for the same reason the two
      // ceilings above do. The class is already on (`buildRoomPanel` applies it before the
      // mount, so the rebuild never animates); this is what pins the frozen body width to
      // a real number rather than the stylesheet's fallback. No paint has happened yet.
      syncAsideFold();
      // Paint the panel's lists NOW, after the aside is in the document — inside
      // buildRoomPanel the isConnected guards skip them, and a quiet room has no
      // incoming post to repaint it after a rebuild. Found on the harness lead: seven
      // entries in room.jsonl, none on screen, hours since the last post.
      renderRoom();
      renderTasks();
    }

    const stream = document.createElement('div');
    stream.className = 'stream';
    const inner = document.createElement('div');
    inner.className = 'stream-inner';
    stream.append(inner);

    let scrollTimer = null;
    stream.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(markReadIfCaughtUp, 250);
    });

    streamEl = { stream, inner };
    mount.append(stream);

    renderStream();
    mount.append(buildComposer(s));
    // Sizing needs the textarea in the document — scrollHeight is 0 before that, so a
    // restored multi-line draft would sit crammed in a two-row box.
    composerEl.autoGrow();
    scrollToBottom();
    // The initial paint lands after a frame; catch up once it has.
    requestAnimationFrame(() => setTimeout(markReadIfCaughtUp, 60));
  }

  function emptyState(title, body) {
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    const t = document.createElement('div');
    t.className = 'empty-title';
    t.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    wrap.append(t, p);
    return wrap;
  }

  /* ---------------------------------------------------------- team panel --- */

  /**
   * The autonomy dials, per team. What each unlock means is written on it — these are
   * the keystroke-granting toggles, so the wording errs on the side of scary.
   */
  const TOGGLE_ROWS = [
    ['answerDesignQuestions', 'Answer design questions', 'Only with grounds it can cite; every answer is audited in the room.'],
    ['answerPermissionPrompts', 'Answer permission prompts', 'A machine pressing yes on permission boxes. Off is the norm.'],
    ['approvePlans', 'Approve plans', 'Plan boxes can clear context and bypass permissions. Off is the norm.'],
    ['flagConflicts', 'Flag worker conflicts', 'Post to the room when two workers touch the same files.'],
    // The fourth element is a note drawn under the row, always visible — this one
    // carries a trust consequence and a takes-effect-later gotcha, and neither may
    // hide in a tooltip.
    // `leadMerges`'s copy is a *function of the detected forge*, because what the toggle
    // actually does differs by forge and the old wording asserted Gitea's version of it as
    // if it were general. On Gitea one tool both opens and merges, so a rule cannot tell
    // them apart — that is a Gitea fact. Under `gh` the rule is `Bash(gh pr merge:*)`,
    // which genuinely cannot open a PR. Under a GitHub MCP server the panel adds nothing
    // at all, and saying so is the whole point: a toggle that reads as on and does nothing
    // is worse than one that is honestly inert.
    ['leadMerges', 'Lead merges without a prompt', leadMergesHint, leadMergesNote],
    // The fifth element is new here: whether the row is answerable on this repo at all.
    // `leadMerges` stays pressable on a repo with no forge and says so in its copy, which
    // is right for it — pressing it there is harmless, it just grants nothing. This row is
    // not the same shape: it hands over the per-PR word, and on a repo with no PR there is
    // nothing to hand over, so the switch is disabled and the note says why rather than
    // storing a `true` that would read as a decision the maintainer took.
    ['leadDecidesMerges', 'Lead merges without your word', leadDecidesHint, leadDecidesNote, forgeHasPRs],
  ];

  /** What `leadMerges` grants on this repo's forge, in the hover. */
  function leadMergesHint(forge) {
    if (forge?.forge === 'gitea') {
      return 'Lets the lead use Gitea’s pull-request tool without stopping at a permission prompt you resolve. That one tool both opens PRs and merges them, and a permission rule cannot tell those apart — so turning this on trusts the lead not to merge unasked. Merges still happen only on your explicit word, per PR; with this on, that rule is the lead’s discipline rather than a prompt.';
    }
    if (forge?.forge === 'github' && forge?.via === 'gh') {
      return 'Lets the lead run `gh pr merge` without stopping at a permission prompt you resolve. Narrower than it sounds: that command can only merge, never open, so the rule cannot be used to open PRs behind your back. Merges still happen only on your explicit word, per PR.';
    }
    if (forge?.forge === 'github') {
      return 'This repo reaches GitHub through an MCP server, and the panel adds no rule for it — nobody has verified that server’s merge tool name, and an unverified name in a permission rule is a rule that silently does nothing. The lead will stop at a prompt you answer. Install `gh` and log in for the rule to apply.';
    }
    return 'Nothing to merge on this repo: no forge tools are installed, so work stops at the branch and this toggle grants nothing.';
  }

  /** The always-visible note under the row — the trust consequence and the gotcha. */
  function leadMergesNote(forge) {
    const later = 'Applies from the next lead launch; a running lead keeps what it started with.';
    if (forge?.forge === 'gitea') {
      return `Trusts the lead not to merge unasked — a rule can’t tell “merge” from “open a PR”. ${later}`;
    }
    if (forge?.forge === 'github' && forge?.via === 'gh') {
      return `Allows \`gh pr merge\` only, which cannot open a PR. ${later}`;
    }
    if (forge?.forge === 'github') return `Adds no rule on this repo — the lead still stops at a prompt. ${later}`;
    return 'No forge on this repo, so this grants nothing.';
  }

  /**
   * Is there a PR on this repo to decide about at all? `push only` and `no remote` both
   * mean no — a branch is pushed (or not) and merging is something that happens elsewhere,
   * by hand. Same test `mergeVerdict`'s refusal 3 uses server-side, so a row the panel
   * lets you press is a row the endpoint would not refuse out of hand.
   */
  function forgeHasPRs(forge) {
    return Boolean(forge?.forge);
  }

  /**
   * `leadDecidesMerges` — the decision, not the prompt. Its copy is a function of the
   * forge for the same reason `leadMerges`'s is, and for one more: under GitHub through an
   * MCP server the panel adds no permission rule at all, so the lead may decide and then
   * still stop at a prompt (§6 Q4 of the plan). That is confusing but safe, and the honest
   * fix is a sentence here rather than refusing the feature to a working setup.
   */
  function leadDecidesHint(forge) {
    // What the panel itself still refuses, whatever this switch says — the half of the
    // conditions that is a wall rather than the lead's discipline. Worth the hover's
    // length: this is the toggle where "what does it actually let it do" is the question.
    const bounded =
      'Bounded by checks the panel makes on its own: the task has to be in review with a PR, the commit it names has to be the tip of that branch here, and nothing it changes may be under “always review myself” below. Every check is posted to the room, refusals included, and a task’s close line says whether a decision was recorded for the commit that merged.';
    const perPR =
      'Lets the lead decide, per PR, that a worker’s work is ready and merge it without waiting for your word. Nothing fires on a timer, a webhook, or on checks going green with nobody looking — the lead asks the panel each time, and the forge facts it reports are its own word, in the room, where you read them back.';
    if (forge?.forge === 'gitea' || (forge?.forge === 'github' && forge?.via === 'gh')) {
      return `${perPR} ${bounded}`;
    }
    if (forge?.forge === 'github') {
      return `${perPR} ${bounded} This repo reaches GitHub through an MCP server, and the panel adds no permission rule for its merge tool — so the lead may decide, and will then still stop at a prompt you answer.`;
    }
    return 'Nothing to decide about on this repo: no forge tools are installed, so a worker’s work stops at a branch and there is no PR to merge.';
  }

  /** The always-visible note — what it hands over, and the two gotchas that must not hide. */
  function leadDecidesNote(forge) {
    const later = 'Applies from the next lead launch; a running lead keeps what it started with.';
    /*
     * §6 Q5, verbatim and unconditional. The two toggles are deliberately independent — a
     * switch that silently turns another one on is worse than a combination that needs a
     * sentence — and this is the sentence. It is phrased as a standing conditional rather
     * than reacting to `leadMerges`' current value on purpose: `buildSettings` runs once
     * per team and is not rebuilt when a toggle flips, so a note that read the other
     * switch would go stale the moment you used it.
     */
    const q5 = 'With “Lead merges without a prompt” off, you will still be asked at the prompt.';
    if (!forgeHasPRs(forge)) return 'No PR to merge on this repo, so there is nothing here to hand over.';
    if (forge.forge === 'github' && forge.via === 'mcp') {
      // Q5's sentence would be actively misleading here — it implies the other switch
      // could remove the prompt, and under an MCP server nothing does. The stronger
      // wording carries the same fact and is true.
      return `Hands over the per-PR word, bounded by the list below. You will still be asked at the prompt whatever “Lead merges without a prompt” says, because the panel adds no rule for this repo’s merge tool. ${later}`;
    }
    return `Hands over the per-PR word, bounded by the list below and by the panel’s own refusals. ${q5} ${later}`;
  }

  function errLine(el, message) {
    const line = document.createElement('div');
    line.className = 'team-err';
    line.textContent = message;
    // One of the three callers appends into a task row, which opens the brief on click:
    // reading a close failure and getting an unrelated dialog is exactly the small
    // wrongness this panel avoids. The other two land in the settings block, which has no
    // click handler, so this costs them nothing.
    line.onclick = (e) => e.stopPropagation();
    el.append(line);
    // The panel is permanent, unlike the popover this grew from — errors that never
    // leave would stack up under every hiccup.
    setTimeout(() => line.remove(), 6000);
  }

  async function patchTeam(body) {
    const next = await postJSONMethod('PATCH', '/api/team/config', { folder: roomView.repo, ...body });
    roomView.config = next;
    return next;
  }

  /**
   * `humanReviewPaths` — the folders the maintainer always wants to look at themselves,
   * and the bound on the toggle above this box. A PR touching anything under one of them
   * is refused a self-merge, with the offending files named in the room.
   *
   * **This one is a control, and the setup row four blocks down is the reason to say so.**
   * The maintainer's ruling (2026-08-26) is that a control they cannot answer correctly
   * should not be a control — which is exactly why `setup` is detected and shown read-only,
   * with a wrong value a bug in detection rather than a box to correct. "Which folders do I
   * always want to look at myself?" is the opposite kind of question: nobody but them can
   * answer it, and no amount of reading the repo would produce it. So it gets a box.
   *
   * Committed on blur the way the number knobs are, plus ⌘/Ctrl+Enter, because a
   * textarea's plain Enter is a newline and one-per-line is the whole point of the shape.
   *
   * Two things it borrows from the knobs and one it does not. Borrowed: the refusal shows
   * the **server's own message** — `normalizeReviewPaths` names the entry that was wrong,
   * and a panel-written "invalid" would send the reader back to guess which line — and the
   * box reverts to the last list the server accepted, because a textarea still holding
   * refused text reads as saved. Not borrowed: what is drawn back is the *normalised* list
   * the server answered with (`./server/` → `server`, de-duplicated, sorted), not what was
   * typed, so what you see is what `mergeVerdict` matches against.
   *
   * The list is data compared against git's own output, never a permission rule — it must
   * never go near `pathRule`, whose double-slash is a fact about a different system.
   */
  function reviewPathsEditor(team, elm) {
    const block = document.createElement('label');
    block.className = 'team-paths';
    const cap = document.createElement('span');
    cap.className = 'team-paths-cap';
    cap.textContent = 'always review myself';
    cap.title =
      'Folders whose changes you always want to look at yourself. A PR touching one of them is refused a self-merge and waits for your word, however good it looks. One folder per line, no wildcards — name the folder itself. Empty means nothing is reserved.';
    const box = document.createElement('textarea');
    box.className = 'team-paths-input';
    box.rows = 3;
    box.spellcheck = false;
    box.placeholder = 'folders you always want to look at yourself,\none per line — e.g. server';
    // The last list the server accepted. Every revert goes back to this, and it is
    // replaced only by an answer that came back 200.
    let accepted = Array.isArray(team.humanReviewPaths) ? [...team.humanReviewPaths] : [];
    box.value = accepted.join('\n');

    const commit = async () => {
      const lines = box.value.split('\n').map((s) => s.trim()).filter(Boolean);
      // A blur is a cheap and frequent event; this is a disk write with a room-visible
      // consequence. Unchanged text tidies its own whitespace and goes no further.
      if (lines.length === accepted.length && lines.every((v, i) => v === accepted[i])) {
        box.value = accepted.join('\n');
        return;
      }
      box.disabled = true;
      try {
        const next = await patchTeam({ humanReviewPaths: lines });
        accepted = Array.isArray(next.humanReviewPaths) ? [...next.humanReviewPaths] : [];
      } catch (err) {
        errLine(elm, err.message);
      }
      box.value = accepted.join('\n');
      box.disabled = false;
    };
    box.onchange = commit;
    box.onkeydown = (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        commit();
      }
    };
    block.append(cap, box);
    return block;
  }

  /**
   * How long the SETTINGS fold takes, in milliseconds. It is spelled here *and* in
   * `.team-settings-fold`'s transition, and the two have to agree — this copy exists only
   * to time the backstop re-pin, so drifting apart costs a room that re-pins early rather
   * than anything visible. Long enough to read as motion, short enough that a control
   * panel does not make you wait for it.
   */
  const SETTINGS_FOLD_MS = 200;

  /**
   * The gear, drawn rather than typed — the same reasoning `bindingMark` carries.
   *
   * `⚙` was a font glyph: it sits on a baseline rather than in its own box, so it never
   * centred in the hit area without hand-nudging, and every platform draws a different
   * gear (Apple's is a flat outline, some fonts hand you a colour emoji). A path at a
   * fixed viewBox is the same shape everywhere and scales with `font-size` alone.
   *
   * Eight teeth, because the button rotates 60° when the block opens and eight teeth put
   * a 45° pitch under that — the resting state lands a third of a tooth off where it was,
   * which reads as *moved* rather than as a redraw. Six teeth would map 60° exactly onto
   * itself and the open state would be indistinguishable from the closed one.
   */
  function gearMark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');

    // Eight radial strokes from r=4.9 to r=6.5 about (8,8), every 45°. Round caps, so a
    // tooth is a lozenge rather than a spike — at sixteen pixels a square cap reads as
    // aliasing. Written out rather than looped: the coordinates are the drawing.
    const teeth = document.createElementNS(SVG_NS, 'path');
    teeth.setAttribute(
      'd',
      'M12.9 8 L14.5 8 M11.47 11.47 L12.6 12.6 M8 12.9 L8 14.5 M4.53 11.47 L3.4 12.6 '
        + 'M3.1 8 L1.5 8 M4.53 4.53 L3.4 3.4 M8 3.1 L8 1.5 M11.47 4.53 L12.6 3.4',
    );
    teeth.setAttribute('fill', 'none');
    teeth.setAttribute('stroke', 'currentColor');
    teeth.setAttribute('stroke-width', '1.7');
    teeth.setAttribute('stroke-linecap', 'round');
    svg.append(teeth);

    // The rim, sitting *under* the teeth's inner ends so the two merge into one body
    // rather than showing eight joins.
    const rim = document.createElementNS(SVG_NS, 'circle');
    rim.setAttribute('cx', '8');
    rim.setAttribute('cy', '8');
    rim.setAttribute('r', '4.6');
    rim.setAttribute('fill', 'none');
    rim.setAttribute('stroke', 'currentColor');
    rim.setAttribute('stroke-width', '1.5');
    svg.append(rim);

    // The axle, filled. An outlined hub at this size is two hairlines a pixel apart and
    // reads as a smudge; a solid dot with clear daylight around it reads as a gear.
    const hub = document.createElementNS(SVG_NS, 'circle');
    hub.setAttribute('cx', '8');
    hub.setAttribute('cy', '8');
    hub.setAttribute('r', '1.55');
    hub.setAttribute('fill', 'currentColor');
    svg.append(hub);

    return svg;
  }

  /**
   * The SETTINGS header: the label, and the gear that folds the block away.
   *
   * Folded is the default, and the reason is arithmetic. The dials below are set once
   * and then left alone for weeks; the tasks above them and the room below them are read
   * every minute. A control panel you open once a week should not spend every other
   * minute taking rows off the room.
   *
   * Nothing hides here that you need: unlike a collapsed rail group — which can swallow
   * a *working* session and therefore has to grow a pulsing dot — these are inert
   * stored values. Folding them away loses no state you could have missed.
   */
  function buildSettingsHead() {
    const head = document.createElement('div');
    head.className = 'room-head is-foldable';
    head.title = 'The autonomy dials and the team knobs. Every change lands in team.json.';

    const label = document.createElement('span');
    label.className = 'room-head-label';
    label.textContent = 'team settings';

    /*
     * Nothing else on this line. The control that folds the whole aside away was here for
     * one review — a small `›` left of the gear — and it read as a third knob in a
     * settings header rather than as the panel's own edge. It is the band down the aside's
     * left edge now (`buildAsideBand`), which is where the eye already goes for a boundary
     * and where the width grip had been living all along.
     */

    // The gear is what the maintainer was promised, so it is a real button with its own hit
    // area and its own title. The header line toggling too is a courtesy, not the control.
    const gear = document.createElement('button');
    gear.className = 'room-head-gear';
    gear.setAttribute('aria-label', 'Team settings');
    gear.append(gearMark());
    gear.onclick = (e) => {
      e.stopPropagation(); // or the header behind it toggles straight back
      toggleSettings();
    };
    roomView.settingsGearEl = gear;

    head.append(label, gear);
    head.onclick = () => toggleSettings();
    return head;
  }

  /**
   * Draw the fold, over ~200ms rather than in one frame.
   *
   * It used to be `hidden`, on the reasoning that the room takes what this block leaves
   * (`flex: 1` against `flex: none`) so the space comes back for free. It does — it just
   * came back in a single frame, and a panel-sized block appearing and vanishing under a
   * click is the thing the maintainer asked to stop.
   *
   * The animated property is `grid-template-rows` on the wrapper, `0fr` ↔ `1fr`, not a
   * height. A height animation needs a number, and this block's height is whatever its
   * content is — measuring it means reading layout on every toggle, and a stale
   * `max-height` clips the block the day someone adds a row. `1fr` in an auto-height grid
   * resolves to the row's own content height, so nothing here knows how tall the settings
   * are and nothing has to be updated when they change.
   *
   * `inert` is doing what `hidden` used to. A block folded to zero height with
   * `overflow: hidden` is invisible but still *focusable* — Tab would walk into
   * checkboxes nobody can see — and still read out by a screen reader. `hidden` covered
   * both for free; losing it means saying so.
   *
   * And it re-pins the room twice, which is the trap this feature has to walk past a
   * second time. The room follows its newest line *by intention* and every other thing
   * that changes this aside's height re-pins for it (see pinRoom's own comment for the
   * 454px it cost to learn) — but a transition means the height keeps changing for 200ms
   * after the click, so one pin at the start would leave the room a block short of its
   * newest line for as long as the block is open. Pin at the start, so nothing jumps, and
   * again at the end, where the geometry has settled. A reader up in the history is still
   * not yanked either time: pinRoom refuses while `follow` is false.
   */
  function applySettingsOpen() {
    const open = roomView.settingsOpen === true;
    const fold = roomView.settingsFoldEl;
    if (fold) {
      fold.classList.toggle('is-open', open);
      fold.inert = !open;
    }
    const gear = roomView.settingsGearEl;
    if (gear) {
      gear.setAttribute('aria-expanded', String(open));
      gear.title = open ? 'Fold the team settings away' : 'Open the team settings';
      gear.classList.toggle('is-open', open);
    }
    pinRoom(); // the box is about to change height; hold the bottom before it starts
    // …and again once it has stopped. `transitionend` on the wrapper is the accurate
    // signal and is wired once in buildRoomPanel; this timer is the backstop for where it
    // never arrives, which is reduced motion — a 0s transition ends no event. Restarted
    // per toggle so a fast open/close doesn't leave one armed over the next state.
    clearTimeout(roomView.settingsPinTimer);
    roomView.settingsPinTimer = setTimeout(pinRoom, SETTINGS_FOLD_MS + 60);
  }

  /**
   * Flip the fold, and remember it for this team.
   *
   * It lives in `team.json` rather than localStorage for the same reason a group's
   * collapse lives in `groups.json`: two windows should agree, and a reload shouldn't
   * reopen what you just tidied away. It is filed under `ui`, well away from `toggles` —
   * those are the autonomy dials the lead reads, and a piece of browser furniture in
   * that list would read as a permission.
   */
  async function toggleSettings() {
    const next = !(roomView.settingsOpen === true);
    roomView.settingsOpen = next; // flip now; the write confirms it a beat later
    applySettingsOpen();
    try {
      await patchTeam({ ui: { settingsOpen: next } });
    } catch {
      // Chrome, not policy — no error line for this. But the panel must not claim a
      // state that isn't stored, so it goes back to what disk still says.
      roomView.settingsOpen = !next;
      applySettingsOpen();
    }
  }

  /** The settings section — the popover's rows, permanent, plus the team's knobs. */
  async function buildSettings(elm) {
    if (!roomView.config) {
      elm.textContent = 'Loading…';
      try {
        const res = await fetch(`/api/team/config?folder=${encodeURIComponent(roomView.repo)}`);
        const team = await res.json();
        if (!res.ok) throw new Error(team.error || 'No team config.');
        roomView.config = team;
        // This is the one request that ever learns the forge, and the header was built
        // before it went out — so the answer has to be carried back up there rather than
        // waited for. Deliberately not a second fetch from `buildHead`: one request per
        // folder is already in flight for exactly this.
        paintForge();
      } catch (err) {
        elm.textContent = err.message;
        // A block folded shut over an error is an error nobody reads. There is nothing
        // to fold away here anyway — no config loaded, no dials — so show the reason.
        if (roomView.settingsOpen === null) {
          roomView.settingsOpen = true;
          applySettingsOpen();
        }
        return;
      }
    }
    // First sight of this team's config: take the fold it remembers. A press that landed
    // while the fetch was in flight has already made this a boolean, and wins.
    if (roomView.settingsOpen === null) {
      roomView.settingsOpen = Boolean(roomView.config.ui?.settingsOpen);
      applySettingsOpen();
    }
    // No isConnected guard: elm is always the node this build is about to append, so
    // painting it while detached is the normal case — a torn-down elm just gets GC'd.
    const team = roomView.config;
    elm.replaceChildren();
    for (const [key, label, hintFor, noteFor, availableFor] of TOGGLE_ROWS) {
      // Copy that depends on the detected forge arrives as a function; everything else is
      // a plain string and stays one.
      const forge = team.forgeResolved || null;
      const hint = typeof hintFor === 'function' ? hintFor(forge) : hintFor;
      const note = typeof noteFor === 'function' ? noteFor(forge) : noteFor;
      // A row with no fifth element is always answerable, which is every row but one.
      const available = typeof availableFor === 'function' ? availableFor(forge) : true;
      const row = document.createElement('label');
      row.className = available ? 'team-toggle-row' : 'team-toggle-row is-unavailable';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(team.toggles?.[key]);
      // A stored `true` on a repo that has since lost its forge still shows as on — the
      // switch reports what is in `team.json`, and drawing it off would be the panel
      // telling you something the file does not say. It just cannot be changed here.
      box.disabled = !available;
      box.onchange = async () => {
        box.disabled = true;
        try {
          await patchTeam({ toggles: { [key]: box.checked } });
        } catch (err) {
          box.checked = !box.checked; // it didn't take — show the truth
          errLine(elm, err.message);
        }
        box.disabled = false;
      };
      const text = document.createElement('span');
      text.textContent = label;
      text.title = hint;
      row.append(box, text);
      elm.append(row);
      if (note) {
        const line = document.createElement('div');
        line.className = 'team-toggle-note';
        line.textContent = note;
        elm.append(line);
      }
      // The path list is the bound on the row above it, so it is drawn from inside the
      // loop rather than after it: appended after the loop it would merely *happen* to
      // land under `leadDecidesMerges` because that row is last today, and would drift
      // away from it the day another toggle is added.
      if (key === 'leadDecidesMerges') elm.append(reviewPathsEditor(team, elm));
    }
    // The knobs. Committed on change, reverted on refusal, same shape as the toggles.
    const knob = (label, value, hint, apply) => {
      const row = document.createElement('label');
      row.className = 'team-knob-row';
      const text = document.createElement('span');
      text.textContent = label;
      text.title = hint;
      const input = document.createElement('input');
      input.value = value ?? '';
      input.onchange = async () => {
        input.disabled = true;
        try {
          await apply(input.value);
        } catch (err) {
          input.value = value ?? '';
          errLine(elm, err.message);
        }
        input.disabled = false;
      };
      row.append(text, input);
      elm.append(row);
      return input;
    };
    const workers = knob('max workers', team.maxWorkers, 'How many workers may run at once.', (v) =>
      patchTeam({ maxWorkers: Number(v) }));
    workers.type = 'number';
    workers.min = '1';
    workers.max = '8';
    const stuck = knob(
      'stuck after (min)',
      team.toggles?.stuckAfterMinutes,
      'Minutes a worker may sit blocked or silent before the room is told.',
      (v) => patchTeam({ toggles: { stuckAfterMinutes: Number(v) } }),
    );
    stuck.type = 'number';
    stuck.min = '1';
    // The default worker model — a picker, not a text box, offering exactly the list
    // dispatch will accept (served with the config, defined once server-side). This is
    // what workers *launch* with when the lead names none; the rail's model chip stays
    // the live truth. When the lead departs from this, the room says which and why.
    const modelRow = document.createElement('label');
    modelRow.className = 'team-knob-row';
    const modelText = document.createElement('span');
    modelText.textContent = 'worker model';
    modelText.title =
      'What workers launch with when the lead names none. The lead may pick a different model per task — when it does, the room says which and why.';
    const modelPick = document.createElement('select');
    const modelIds = Array.isArray(team.models) && team.models.length ? [...team.models] : [];
    // A stored default the list doesn't carry (a [1m] variant, or a hand-edited
    // team.json) still has to be showable, or the picker would lie about what runs.
    if (team.defaultModel && !modelIds.includes(team.defaultModel)) modelIds.push(team.defaultModel);
    for (const id of modelIds) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      modelPick.append(opt);
    }
    modelPick.value = team.defaultModel || '';
    modelPick.onchange = async () => {
      modelPick.disabled = true;
      try {
        await patchTeam({ defaultModel: modelPick.value });
      } catch (err) {
        modelPick.value = team.defaultModel || '';
        errLine(elm, err.message);
      }
      modelPick.disabled = false;
    };
    // The picker is de-nativised (`appearance: none`, so the OS chevron goes with it) and
    // the caret is drawn back on this wrapper's `::after`. It has to be a wrapper: the
    // caret is a pseudo-element, and a `select` cannot carry one.
    const modelWrap = document.createElement('span');
    modelWrap.className = 'team-select';
    modelWrap.append(modelPick);
    modelRow.append(modelText, modelWrap);
    elm.append(modelRow);
    // Setup is shown, never typed — the maintainer's ruling (2026-08-26): a control the user
    // cannot answer correctly should not be a control. The server detects it from the
    // project's files; a wrong command here is a bug in setup-detect.js, not a box to
    // correct. `setupResolved` may be missing from a pre-detection cached config, in
    // which case the legacy stored value is all there is to show.
    const resolved =
      team.setupResolved || (team.setup ? { command: team.setup, reason: 'stored in team.json' } : null);
    const setupRow = document.createElement('div');
    setupRow.className = 'team-setup-row';
    const setupLabel = document.createElement('span');
    setupLabel.textContent = 'setup';
    setupLabel.title = 'Run once in every fresh worktree, before the worker starts. Worked out from the project’s own files.';
    const setupValue = document.createElement('span');
    setupValue.className = 'team-setup-value';
    if (resolved?.command) {
      setupValue.textContent = resolved.command;
    } else {
      setupValue.classList.add('is-unknown');
      setupValue.textContent = 'couldn’t work out how to prepare this project; workers will start without it';
    }
    setupRow.append(setupLabel, setupValue);
    elm.append(setupRow);
    if (resolved?.reason) {
      const setupReason = document.createElement('div');
      setupReason.className = 'team-setup-reason';
      setupReason.textContent = resolved.reason;
      elm.append(setupReason);
    }

    /*
     * The forge, and the repo's default branch. Both **detected**, both read-only, both for
     * the same reason the setup command is: a control the user cannot answer correctly
     * should not be a control (the maintainer's ruling, 2026-08-26), and a wrong value here
     * is a bug in detection rather than a box to hand-fix.
     *
     * It is on screen at all because it changes what the lead can do. No forge means no
     * PRs and no merge block, and `done` means "you merged it locally" — hide that and
     * the missing merge button reads as a bug rather than as the state of the repo.
     *
     * Nothing in this surface is clickable, deliberately: no picker, no override.
     */
    const forge = team.forgeResolved || null;
    if (forge) {
      const forgeRow = document.createElement('div');
      forgeRow.className = 'team-setup-row';
      const forgeLabel = document.createElement('span');
      forgeLabel.textContent = 'forge';
      forgeLabel.title = 'Worked out from this repo’s own origin and the tools installed here. Not a setting.';
      const forgeValue = document.createElement('span');
      forgeValue.className = 'team-setup-value';
      forgeValue.textContent = forge.reading || 'unknown';
      /*
       * Both sentences on the hover, the maintainer's call over the recommendation that the
       * panel should only state facts: the invitation is the one thing a GitLab user can
       * act on, and the hover is where they look.
       *
       * `no remote` is the one reading that does **not** carry it, and gets its own
       * sentence rather than sharing `push only`'s. Two reasons, both found by reading the
       * hover on a real repo: "a remote is configured" is simply false there, and adding
       * support for another forge would not help a repo that has no remote at all — the
       * invitation would be a non sequitur exactly where the panel should be plainest.
       */
      const INVITATION =
        'Only GitHub and Gitea have PR support today — open an issue on the Foreman repo if you want another added.';
      if (forge.reading === 'no remote') {
        forgeValue.classList.add('is-unknown');
        forgeValue.title =
          'This repo has no origin, so a worker’s branch stays on this Mac and there is nothing to open a PR against.';
      } else if (forge.reading === 'push only') {
        forgeValue.classList.add('is-unknown');
        forgeValue.title =
          `A remote is configured, but no tools for it are installed — branches are pushed, PRs are opened by hand. ${INVITATION}`;
      } else {
        forgeValue.title = `PRs are opened and merged through this forge’s tools. ${INVITATION}`;
      }
      forgeRow.append(forgeLabel, forgeValue);
      elm.append(forgeRow);
      if (forge.reason) {
        const forgeReason = document.createElement('div');
        forgeReason.className = 'team-setup-reason';
        forgeReason.textContent = forge.reason;
        elm.append(forgeReason);
      }
    }

    // The base branch, on the same terms. `main` was hardcoded in four places and a repo
    // on `master` simply could not be dispatched into; showing what was detected is how
    // anybody would notice it going wrong again.
    if (team.baseResolved?.branch) {
      const baseRow = document.createElement('div');
      baseRow.className = 'team-setup-row';
      const baseLabel = document.createElement('span');
      baseLabel.textContent = 'base branch';
      baseLabel.title = 'What workers branch from, and what “done” has to be merged into. Detected, not set.';
      const baseValue = document.createElement('span');
      baseValue.className = 'team-setup-value';
      baseValue.textContent = team.baseResolved.branch;
      baseValue.title = team.baseResolved.reason || '';
      baseRow.append(baseLabel, baseValue);
      elm.append(baseRow);
    }

    pinRoom(); // this box just changed height; the room below it moved with it
  }

  /** Stored state joined with the live pane — stuck and blocked outrank the record. */
  function taskChipState(t) {
    if (t.live?.stuck) return 'stuck';
    if (t.live && (t.live.status === 'needs-decision' || t.live.needsYou)) return 'blocked';
    return t.state;
  }

  /**
   * The rail's inbox rule, applied to the task list: what needs you comes first, and
   * only then recency. It matters more here than it used to, because the block now
   * stops at five rows (see `capTaskList`) and everything past them is a scroll away.
   *
   * `review` is its own tier, above the in-flight work. A worker in `review` has finished,
   * opened a PR and is waiting on the maintainer's word to merge — nothing moves until they
   * looks — so it must not be the row that a busy team's five `working` tasks push out of
   * sight. That is a departure from strict recency, deliberately: a team running five fresh
   * tasks would otherwise hide the one finished task waiting on them. Stuck/blocked stay
   * above it; those are stalled *now*.
   */
  const TASK_RANK = {
    stuck: 0, blocked: 0, // a pane holding a question — nothing moves until it is answered
    review: 1, // done, PR open, waiting on the maintainer
    dispatched: 2, working: 2, queued: 2, // in flight, not waiting on anyone
    // Recorded, never started. Below anything in flight and above anything closed — and
    // the second half of that is what moving `CLOSED_RANK` to 4 buys. Leave it at 3 and
    // pending ties with `done`/`failed`, so recency interleaves an idea nobody has begun
    // with work that finished a week ago.
    pending: 3,
    // everything else (done / failed / abandoned) falls through to 4
  };
  const CLOSED_RANK = 4;

  /**
   * The TASKS heading, and the one control on it.
   *
   * It used to be a bare text line from `buildRoomPanel`'s `section()` helper, with
   * nothing on it at all. `buildSettingsHead` two functions up is the worked example of a
   * heading that holds a control and the shape is copied from it — label on the left, the
   * control at the right edge, negative margins so the button does not make this heading
   * taller than `room` two blocks below it.
   *
   * **A pill button, not a switch, and that was decided rather than picked.** In this
   * panel a sliding switch means a stored *team* setting that changes what the panel does
   * — the autonomy dials in `team-toggle-row`, written to `team.json`. This changes only
   * what you are looking at, in this browser. The rail header's `recent` is already the
   * control that means "filter this list", so this is that control: the same
   * `aria-pressed` button, plain outline off, accent outline and `--accent-soft` on.
   *
   * **The label says `finished`, never `done`.** It hides three states and two of them are
   * not `done` — a failed task swept away by a control saying "done" would be the control
   * lying about itself, which is the same rule as preferring to show nothing over showing
   * something wrong. No state named `finished` exists; see `CLOSED_TASK_STATES`.
   */
  function buildTasksHead() {
    const head = document.createElement('div');
    head.className = 'room-head has-controls';
    head.title = 'Every task this team holds — stored state joined with what the pane shows now.';

    const label = document.createElement('span');
    label.className = 'room-head-label';
    label.textContent = 'team tasks';

    // What the filter is holding back, in the heading rather than down in the list: the
    // list cannot say it, because with the filter on the rows it would say it about are
    // the rows that are not there. Empty while the filter is off, and empty while it is on
    // and hiding nothing — a `0 hidden` is noise about a non-event.
    const note = document.createElement('span');
    note.className = 'room-head-note';
    roomView.tasksNoteEl = note;

    const btn = document.createElement('button');
    btn.className = 'room-head-toggle';
    btn.textContent = 'hide finished';
    btn.onclick = (e) => {
      // `buildSettingsHead`'s line, for its reason: this heading carries no click handler
      // today, and this is what keeps that a free choice rather than something the button
      // silently depends on.
      e.stopPropagation();
      hideFinished.set(!hideFinished.on);
      // Every aside, not this one: the filter is one answer for the browser and split view
      // can have two Tasks blocks on screen. See `renderTaskLists`.
      renderTaskLists();
    };
    roomView.tasksToggleEl = btn;

    // No `onclick` on the heading itself. SETTINGS has one because that whole line stands
    // for the block it folds; this line stands for the task list, and a press anywhere on
    // the word `tasks` quietly hiding rows would be a surprise nobody asked for.
    head.append(label, note, btn);
    return head;
  }

  /** Paint the heading's control off the filter, and its note off the last paint's count. */
  function renderTasksHead() {
    const btn = roomView.tasksToggleEl;
    if (!btn) return;
    const on = hideFinished.on;
    btn.setAttribute('aria-pressed', String(on));
    // Both halves name the three states, because that is the fact the two-word label
    // cannot carry — and both say `review` stays, which is the one reading of "finished"
    // that would be wrong.
    btn.title = on
      ? 'Showing open tasks only. Press to bring back done, failed and abandoned.'
      : 'Hide the tasks nobody is waiting on — done, failed and abandoned. Anything in review stays.';
    const note = roomView.tasksNoteEl;
    if (!note) return;
    const n = roomView.tasksHidden;
    note.textContent = on && n > 0 ? `${n} hidden` : '';
  }

  function renderTasks() {
    const list = roomView.tasksEl;
    if (!list || !list.isConnected) return;
    const keepScroll = list.scrollTop; // a repaint must not lose the reader's place
    // The merge block's rule, and for the same reason: every row here is about to be
    // replaced, so a question left standing would be a question about a row that may not
    // be the same row any more — or about a task that has just closed. Scoped to this
    // list, so a repaint here never answers for the other pane.
    disarmConfirm(list);
    list.replaceChildren();
    if (!roomView.tasks.length) {
      // A team with no tasks at all. Note this branch is reached whether the filter is on
      // or off, and says the same thing either way, which is correct: there is nothing
      // being held back, so `tasksHidden` is zeroed and the heading's note goes quiet.
      roomView.tasksHidden = 0;
      renderTasksHead();
      const quiet = document.createElement('div');
      quiet.className = 'room-quiet';
      quiet.textContent = 'No tasks yet. The lead dispatches them.';
      list.append(quiet);
      capTaskList(list, []);
      pinRoom(); // this box just changed height; the room below it moved with it
      return;
    }
    const rows = [...roomView.tasks].sort((a, b) => {
      const ra = TASK_RANK[taskChipState(a)] ?? CLOSED_RANK;
      const rb = TASK_RANK[taskChipState(b)] ?? CLOSED_RANK;
      // Most recent first inside a tier. `updatedAt` is stamped on create and on every
      // patch (server/tasks.js), so it is always there — the `|| 0` is belt and braces
      // for a record written before it was, not a real ordering.
      return ra - rb || (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    /*
     * The filter, and note *what* it reads: `taskChipState`, the same derived word the
     * chip on the row draws and `TASK_RANK` sorts on — never the stored `t.state`. The
     * rule is then sayable in one line, which is the point: a row is hidden exactly when
     * the word on its own chip is `done`, `failed` or `abandoned`. `isFinishedState` in
     * `web/prefs.js` is that set and carries the reasoning, including what happens to the
     * two derived states (`stuck`, `blocked`) and to a state nobody has added yet.
     */
    const shown = hideFinished.on ? rows.filter((t) => !isFinishedState(taskChipState(t))) : rows;
    roomView.tasksHidden = rows.length - shown.length;
    renderTasksHead();
    if (!shown.length) {
      /*
       * Emptied by the filter, which with all three closed states hidden is the *common*
       * case rather than an edge one: a long-running team whose work is finished lands
       * here every time. It must not read like the branch above — a team that has never
       * dispatched anything and a team whose every task is closed are different facts, and
       * a list that showed the same sentence for both would look broken exactly when it is
       * working.
       */
      const n = roomView.tasksHidden;
      const quiet = document.createElement('div');
      quiet.className = 'room-quiet';
      quiet.textContent =
        `Nothing open. ${n} finished ${n === 1 ? 'task is' : 'tasks are'} hidden — ` +
        'turn “hide finished” off to see them.';
      list.append(quiet);
      capTaskList(list, []);
      pinRoom(); // this box just changed height; the room below it moved with it
      return;
    }
    const nodes = [];
    for (const t of shown) {
      const chipState = taskChipState(t);
      const row = document.createElement('div');
      row.className = 'team-task';
      const line = document.createElement('div');
      line.className = 'team-task-line';
      const chip = document.createElement('span');
      chip.className = `team-chip is-${chipState}`;
      chip.textContent = chipState;
      const id = document.createElement('span');
      id.className = 'team-task-id';
      id.textContent = t.id;
      line.append(chip, id);
      // A planner reads and writes a document; it never opens a PR and its branch stays
      // empty, so a row that looked like every other one would read as a build worker
      // that achieved nothing. Bare `.team-chip` on purpose — muted, because this is a
      // fact about the task, not a state competing with the one beside it.
      if (t.kind === 'plan') {
        const kind = document.createElement('span');
        kind.className = 'team-chip';
        kind.textContent = 'plan';
        kind.title = t.planFile ? `Plan → ${t.planFile}` : 'A planner: writes a plan, cannot write code.';
        line.append(kind);
      }
      // `done` means the PR merged on the Gitea box. This says whether that code reached
      // the checkout, and the running panel, in front of you — the gap that had the
      // maintainer watching an unchanged screen for twenty minutes. `unknown` draws
      // nothing: a task whose branch tip was never recorded has no honest answer, and no
      // answer beats a wrong one. See server/deployed.js.
      if (t.deploy?.label) {
        const dep = document.createElement('span');
        dep.className = `team-chip is-${t.deploy.state}`;
        dep.textContent = t.deploy.label;
        dep.title = t.deploy.why;
        line.append(dep);
      }
      if (t.pr) {
        const pr = document.createElement('a');
        pr.className = 'team-task-pr';
        pr.href = t.pr;
        pr.target = '_blank';
        pr.rel = 'noopener';
        pr.textContent = 'PR';
        // The row opens the brief, so every control on it has to say so explicitly rather
        // than rely on the luck of layout. Without this you get the PR in a new tab *and*
        // a dialog on the tab you just left.
        pr.onclick = (e) => e.stopPropagation();
        line.append(pr);
      }
      // A third state list, deliberately separate from `ACTIVE` and `OPEN_STATES`: this
      // one is "has something that can still be called off". A pending task qualifies and
      // costs the least to drop — there is no session to end and no worktree to remove.
      if (['pending', 'queued', 'dispatched', 'working', 'review'].includes(t.state)) {
        const close = document.createElement('button');
        close.className = 'team-task-close';
        close.textContent = '✕';
        close.title =
          t.state === 'pending'
            ? `Drop ${t.id}: nothing is running, no worktree to remove.`
            : `Abandon ${t.id}: end its session, remove its worktree`;
        // The panel's confirmation idiom: destructive things ask, in place, and can be
        // told no. The two words are the two facts the `title` already distinguishes —
        // dropping a pending task ends nothing, abandoning a live one ends a session and
        // removes a worktree — and a glyph cannot say which of those a press is about.
        const drop = async () => {
          close.disabled = true;
          try {
            await postJSON(`/api/team/tasks/${encodeURIComponent(t.id)}/close`, {});
            refreshTasks(true);
          } catch (err) {
            close.disabled = false;
            errLine(row, err.message); // the 409's human message must surface
          }
        };
        close.onclick = (e) => {
          // Explicitly, on the button — not left to the luck of layout. Without it the
          // first click both arms the delete *and* opens the brief modal on top of it.
          // With it the two can never be up at once, so the modal needs no disarming.
          e.stopPropagation();
          armConfirm(close, `${t.state === 'pending' ? 'drop' : 'abandon'} ${t.id}?`, drop);
        };
        line.append(close);
      }
      row.append(line);
      if (t.branch) {
        const branch = document.createElement('div');
        branch.className = 'team-task-branch';
        branch.textContent = t.branch;
        row.append(branch);
      }
      // The whole row is the target — the maintainer's call: a press anywhere on it is
      // easier than aiming at a tiny icon, and the `title` tooltip that half-showed the
      // brief is gone with it, because two ways to read the same thing is one too many.
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Brief for ${t.id}`);
      const openBrief = () => openTaskBrief(t, chipState);
      row.onclick = () => {
        // A drag-select that starts and ends inside a row still fires `click`, and these
        // rows carry the branch names and task ids people copy. Without this, selecting
        // one always ends in a dialog.
        if (window.getSelection()?.toString()) return;
        openBrief();
      };
      row.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); // or Space scrolls the list out from under the row
        openBrief();
      };
      list.append(row);
      nodes.push(row);
    }
    capTaskList(list, nodes);
    list.scrollTop = keepScroll;
    pinRoom(); // this box just changed height; the room below it moved with it
  }

  /**
   * Tasks refresh over HTTP on the roster beat (renderHead), not a new ws frame — the
   * endpoint exists, the join is roster-derived anyway, and the floor keeps a 2s roster
   * from turning into a 2s fetch loop.
   */
  async function refreshTasks(force = false) {
    if (!roomView.repo || roomView.tasksBusy) return;
    if (!force && Date.now() - roomView.tasksAt < 3000) return;
    roomView.tasksBusy = true;
    roomView.tasksAt = Date.now();
    try {
      const res = await fetch('/api/team/tasks');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No task list.');
      const mine = (data.tasks || []).filter((t) => t.repo === roomView.repo);
      const sig = mine
        // `updatedAt` is in here for the brief: edit one from another window and none of
        // the other five fields move, so the list would keep showing the old text until
        // some unrelated task changed state. It only moves on a real `tasks.update`, so
        // it costs no extra paints.
        .map((t) => [t.id, t.state, t.live?.status, t.live?.stuck, t.pr, t.updatedAt].join(':'))
        .join('~');
      if (sig !== roomView.tasksSig) {
        roomView.tasksSig = sig;
        roomView.tasks = mine;
        renderTasks();
      }
    } catch {
      /* a missed refresh is the next roster frame's problem, not an error state */
    }
    roomView.tasksBusy = false;
  }

  /**
   * The team panel — settings, tasks, and the room, stacked in the lead pane's right
   * aside. The room stays view-only by design: you talk to the lead, the lead talks
   * there. Tasks and settings are yours.
   *
   * SETTINGS is first, and folded, which only works because those two facts arrived
   * together (the maintainer, 2026-08-26). Folded it is one header line, and a header line
   * at the top costs nothing; open it would have put a wall of dials above everything. What
   * it buys is that the control panel stops sitting *between* the two things read every
   * minute — the task list and the room, now adjacent.
   *
   * The order here is DOM order only. Nothing paints from this function: `renderTasks`
   * and `renderRoom` both bail on `!isConnected`, and the aside is not in the document
   * yet, so renderMain mounts and *then* paints. Moving a paint call up into here would
   * fail silently, and a quiet panel would stay blank for hours while a busy one healed
   * itself in seconds — which is exactly how it shipped once.
   */
  function buildRoomPanel() {
    const panel = document.createElement('aside');
    panel.className = 'room-panel';
    /*
     * The accurate end of a fold. Wired once here rather than per toggle, the settings
     * fold's own shape a few lines down — a listener added on each press would stack.
     *
     * Both halves of the guard are load-bearing and both are that fold's lessons. `target`,
     * because everything inside this panel is free to transition and a control finishing
     * its own would otherwise remeasure the whole aside; `propertyName`, because this fold
     * moves four properties at once — `width`, `min-width`, `max-width` and the
     * cross-fade's `opacity` — and `transitionend` fires once per property, so an unguarded
     * listener would run the end of the fold four times. `width` is the one that decides.
     *
     * And it is not the only path out: under reduced motion the duration is zero and this
     * never fires at all, which is what the timer in `applyAsideFold` is for.
     */
    panel.addEventListener('transitionend', (e) => {
      if (e.target === panel && e.propertyName === 'width') endAsideFold();
    });
    /*
     * There is no plain heading left in this column: `settings`, `tasks` and the room all
     * carry a control now, and all three are built by hand. The room's own `section()`
     * helper went with the `clear` / `show all` button — `buildRoomHead` is what replaced
     * it, and it keeps `is-band` for the reason that helper's comment gave: everything in
     * this aside sits on `--shelf`, and a head with a rule under it and nothing above read
     * as one more line of the tasks list rather than as the start of the room. The band is
     * a paint and nothing else — see the stylesheet for why a border here would move
     * `.tasks-grip` off what it was measured against.
     */

    // No renderTasks/renderRoom here: the aside is not in the document yet, so their
    // isConnected guards would skip — renderMain paints both right after mounting.
    const settings = document.createElement('div');
    settings.className = 'team-settings';
    roomView.settingsEl = settings;
    // Three elements, and the middle one is not decoration. The *fold* is the grid whose
    // one row runs 0fr ↔ 1fr. The *clip* is the grid item, and it carries nothing — no
    // padding, no border — because a grid item can never be shorter than its own padding
    // and border, and `.team-settings` has 0.5rem of the first and a rule along the
    // bottom. Measured with the block as the item directly: shut, it stayed **17px**
    // tall, which is exactly 8 + 8 + 1, and read as an empty band under the heading.
    const settingsFold = document.createElement('div');
    settingsFold.className = 'team-settings-fold';
    const settingsClip = document.createElement('div');
    settingsClip.className = 'team-settings-clip';
    settingsClip.append(settings);
    settingsFold.append(settingsClip);
    roomView.settingsFoldEl = settingsFold;
    // Wired once, here, rather than per toggle: `applySettingsOpen` runs on every flip and
    // on the first config answer, and a listener added there would stack. The property
    // guard matters — a control inside the block finishing its own transition bubbles up
    // here, and re-pinning the room off a checkbox is exactly the yank pinRoom avoids.
    settingsFold.addEventListener('transitionend', (e) => {
      if (e.target === settingsFold && e.propertyName === 'grid-template-rows') pinRoom();
    });
    // Head first, and the fold applied, *before* the config fetch starts: the gear has to
    // exist for the response to draw itself onto, and the block has to start closed so a
    // team that keeps it closed never flashes it open.
    const settingsHead = buildSettingsHead();
    applySettingsOpen();
    buildSettings(settings);

    // The TASKS heading is no longer a `section()` line: it carries the `hide finished`
    // filter. Built here, painted from renderMain like everything else in this aside —
    // `renderTasks` sets the button's own state on every paint, and the first of those
    // arrives right after the mount.
    const tasksHead = buildTasksHead();

    const tasksList = document.createElement('div');
    tasksList.className = 'team-tasks';
    roomView.tasksEl = tasksList;
    refreshTasks(true);

    const list = document.createElement('div');
    list.className = 'room-list';
    roomView.listEl = list;
    // Following the room is an *intention*, not a geometry test at paint time: the tasks
    // and settings sections above size themselves after their own fetch, which changes
    // this list's height under a scroll already set, and a paint-time check reads that
    // as "the user scrolled up" and stops following forever. The scroll handler is the
    // only thing that flips it.
    list.addEventListener('scroll', () => {
      /*
       * A scroll event that arrives because the *box* changed height is the layout moving,
       * not the reader — Chrome emits one when a resize clamps `scrollTop`, and it is
       * indistinguishable from a real scroll by anything except the height. So a height
       * change swallows the one event it caused, and following survives it.
       *
       * The comment above says only a real scroll may flip this. That was already the
       * intent and this is what makes it true: the room now has a grip of its own, and
       * without this, dragging it *smaller* left the room silently not following — the
       * shrink pushes the reader away from the bottom, the event fires, and `pinRoom`
       * afterwards returns early because `follow` had just been set false. Measured: the
       * grow drag ended pinned, the shrink drag did not.
       */
      if (list.clientHeight !== roomView.followH) {
        roomView.followH = list.clientHeight;
        return;
      }
      roomView.follow = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      if (roomView.follow) roomView.unseen = 0; // scrolled back down: you have seen them
      updateRoomHint();
    });

    // The quiet half of "don't yank the reader": if the room moves on while you are
    // reading history, something has to say so — but softly. A muted pill over the
    // bottom edge, counting what arrived, and clicking it is how you rejoin. It exists
    // only while you are *not* following; the moment you are, there is nothing to say.
    const hint = document.createElement('button');
    hint.className = 'room-hint';
    hint.hidden = true;
    hint.onclick = () => {
      roomView.follow = true;
      roomView.unseen = 0;
      pinRoom();
      updateRoomHint();
    };
    roomView.hintEl = hint;

    // The two dividers this aside owns (#13). Both are built here and dragged through the
    // shared `resizer`; both re-pin the room while they move, because both change the
    // shape of the box the reader is scrolled inside — the settings fold's own lesson,
    // one and two elements over.
    const asideBand = buildAsideBand();
    const roomHead = buildRoomHead();
    // The room's own edge. It is still the Tasks/Room divider — one boundary, one control
    // — but it sizes the *room* now, so it says so: the reader drags the thing they want
    // bigger, not the thing above it.
    const tasksGrip = paneGrip('y', 'Room height', "Drag to set the room's height · double-click to reset");
    tasksGrip.classList.add('tasks-grip');

    resizer({
      handle: asideBand,
      axis: 'x',
      storageKey: 'foreman.asideWidth',
      min: ASIDE_MIN,
      max: ASIDE_MAX,
      // The ceiling is the *pane's*, not the window's: split view puts two of these side
      // by side, and the one being dragged is the only one the pointer is inside. The
      // stylesheet enforces the same floor and ceiling per aside — see `.room-panel` —
      // because `--aside` is one number for the whole browser and the other pane may be
      // narrower than this one.
      ceiling: () => (asideBand.closest('.lead-cols')?.clientWidth ?? window.innerWidth) / remPx() - LEAD_LEFT_MIN,
      // The aside is flush with the pane's right edge, so what the pointer is asking for
      // is the distance from that edge back to the cursor.
      measure: (e) => (asideBand.closest('.lead-cols')?.getBoundingClientRect().right ?? window.innerWidth) - e.clientX,
      apply: (rem) => setRootVar('--aside', rem),
      onMove: pinRoom,
    });

    /*
     * The room's own height — the third thing this task was asked for, and it is this
     * divider rather than a new one.
     *
     * **Which grip owns which edge.** `asideBand` owns the aside's left edge and answers
     * for its width. This one owns the aside's *only* internal horizontal boundary. The
     * room's other edge is the panel's own bottom, with nothing under it to trade against,
     * so there is no second edge for a third grip to sit on — two controls on one line is
     * exactly the fight this must not pick. What changed is not where it is but **which
     * block holds the number**: it used to size the Tasks block and let the room be
     * whatever was left over, which is why the room had no size of its own.
     *
     * That mattered for a reason worse than tidiness, measured on a scratch panel at an
     * 879px viewport with both folds open: `.room-list` is the one block in the aside with
     * no floor, so it was squeezed to **16px and pushed 178px below the panel's own bottom
     * edge** — fifteen entries in it, none of them on screen, and this divider could not
     * get them back because the space had gone to the folds, not to Tasks. The floor in
     * `.room-list` and the panel's own scroll are the other half of this fix.
     *
     * **Two modes, which is how it composes with the five-row Tasks cap.** Nothing dragged:
     * Tasks is content-height under its cap and the room takes the remainder — byte for
     * byte the layout that shipped. Dragged: the room holds the height you gave it, Tasks
     * becomes the block that absorbs a fold opening or a window resize, and its cap stands
     * down. That is the rule `capTaskList` already applied, keyed on the room's preference
     * now that the room is what the divider sizes.
     *
     * `--tasks-h` is gone rather than left unread: two spellings of one split is how they
     * drift. A browser holding the old `foreman.tasksHeight` is simply not consulted for
     * it any more, so that aside opens on the default split once — a preference re-dragged
     * in a second, and the honest alternative to reinterpreting a number that used to mean
     * something else.
     */
    resizer({
      handle: tasksGrip,
      axis: 'y',
      storageKey: 'foreman.roomHeight',
      min: ROOM_MIN,
      max: ROOM_MAX,
      // What the room can have once the Tasks block keeps its own floor. Measured off the
      // panel rather than declared: the folds above can be open or shut, and every heading
      // is one line of whatever the type scale says today.
      ceiling: () => {
        const bottom = panel.getBoundingClientRect().bottom;
        const top = tasksList.getBoundingClientRect().top;
        const head = roomHead.getBoundingClientRect().height;
        // Before the aside is laid out every rect is zero; the preference's own `max`
        // is a better answer than a negative one.
        if (bottom <= top) return ROOM_MAX;
        return (bottom - top - head) / remPx() - TASKS_MIN;
      },
      // The room's bottom is the panel's bottom, so it grows upward and the pointer's
      // distance back from that edge *is* the height being asked for — the connections
      // band's measure, one column over.
      measure: (e) => panel.getBoundingClientRect().bottom - e.clientY,
      apply: (rem) => {
        // The class is what switches the two modes above; CSS cannot ask whether a custom
        // property is set, and a second variable saying so would be a second source of
        // truth about one fact.
        document.documentElement.classList.toggle('room-sized', rem != null);
        setRootVar('--room-h', rem);
        recapTaskLists();
        // Every path into here is a height change on the box the reader is scrolled inside
        // — a drag, a window resize through `applyResizers`, a double-click reset — and the
        // room's `follow` is an intention with no scroll event behind it. Pinning only in
        // `onMove` would cover the drag and leave the other two hundreds of pixels short of
        // the newest line. This is the trap that box is named for.
        pinRooms();
      },
      onMove: pinRoom,
    });

    // Settings on top (folded, so it is one line), then the two things actually read. This
    // aside's own rule is that the control panel does not sit *between* the task list and
    // the room, and a folded header line at the top costs nothing. Anything added up there
    // must stay out of the span between the tasks grip and the room heading — that grip's
    // ceiling is measured from the tasks list down to the panel's bottom, and a block
    // growing inside it would let a drag squeeze the room below its own floor.
    // The block above the room still calls `pinRoom` when its own fetch lands, so the room
    // still opens on its newest line rather than 454px short of it.
    /*
     * One wrapper around everything that is *in the flow*, and it exists for the fold.
     *
     * While the panel is narrowing to a strip its content must keep the width it was
     * measured at and be clipped, rather than re-wrapping through forty intermediate
     * widths. That is not tidiness: `capTaskList` writes a px `max-height` read off row
     * rects and the room's clamp caches `scrollHeight > clientHeight` per entry, and both
     * go on running while the panel is folded because `isConnected` is still true. A
     * measurement taken at 2.5rem is wrong and it is *cached onto the DOM*. So the fold
     * pins this box to the panel's measured expanded width (`--aside-frozen`) and the
     * panel clips it; the remeasure on expand is the backstop behind that.
     *
     * The two absolute children stay on the panel and out of the wrapper, because the
     * panel is the box they were positioned against: the "new below" pill hangs off the
     * room's bottom edge, and `.aside-band` sits on the panel's left edge. `.tasks-grip`
     * is in the flow and goes inside, and its ceiling still reads
     * `panel.getBoundingClientRect().bottom`, which the wrapper does not move.
     */
    const body = document.createElement('div');
    body.className = 'room-panel-body';
    body.append(settingsHead, settingsFold, tasksHead, tasksList, tasksGrip, roomHead, list);
    roomView.bodyEl = body;
    roomView.panelEl = panel;

    // The band goes last so it paints over everything it overlaps.
    panel.append(body, buildAsideStrip(), hint, asideBand);

    /*
     * The fold is applied **at build time**, from the preference, on a node that is not in
     * the document yet — and that is what stops the animation running on a rebuild.
     * `renderMain` rebuilds this whole aside on every `transcript` frame (a subscribe, a
     * `/clear` rotation, an `earlier` fetch, an error), and a transition fires on a value
     * change to an element that is already laid out. A panel that is *born* folded has
     * never had another width, so there is nothing for the transition to run between.
     */
    panel.classList.toggle('is-strip', asideFolded.on);
    body.inert = asideFolded.on;
    renderAsideStrip();
    return panel;
  }

  /**
   * The band: the aside's left edge, doing both of the jobs that edge has.
   *
   * **One control, two verbs, and that is the design rather than an economy.** This edge
   * has always been draggable — it was `.aside-grip`, a 7px invisible strip straddling the
   * panel's border with a faint bar in the middle of it — and item 2 then put the *fold* in
   * the SETTINGS heading, which is a different corner of the panel for a thing about the
   * panel's edge. The maintainer looked at that and said no. So both live here: the band
   * **is** the grip, dragging anywhere on it sets the width exactly as before, and the
   * icon pinned at its top folds. Nothing about `resizer` changed — same storage key, same
   * floor, same live ceiling, same double-click reset.
   *
   * **The icon has to stop the drag from starting under it.** `resizer` listens on the
   * handle, and a `pointerdown` on a button inside the handle bubbles to it — so pressing
   * the fold would begin a width drag, and the pointer capture that follows means the
   * `click` never lands. Three events are stopped rather than one: `pointerdown` (the
   * drag), and `dblclick` (the handle's reset-to-default, which two quick presses on the
   * fold would otherwise fire). `click` is left to bubble to nothing — the band has no
   * click handler — which keeps the button's own `onclick` the only thing that folds.
   *
   * **`paneGrip` builds it**, so the `role="separator"` / `aria-orientation` /
   * `aria-label` spelling stays in the one place all four dividers read it from; the band's
   * own class is what changes the shape and the paint. The title says both jobs, because a
   * control that does two things and admits to one is worse than either.
   */
  function buildAsideBand() {
    const band = paneGrip('x', 'Panel width', "Collapse the team panel · drag to resize");
    band.classList.add('aside-band');

    const fold = document.createElement('button');
    fold.className = 'aside-band-fold';
    fold.type = 'button';
    fold.setAttribute('aria-label', 'Collapse the team panel');
    fold.title = 'Collapse the team panel · drag to resize';
    fold.append(foldIcon('collapse'));
    fold.addEventListener('pointerdown', (e) => e.stopPropagation());
    fold.addEventListener('dblclick', (e) => e.stopPropagation());
    fold.onclick = () => {
      asideFolded.set(true);
      foldAsides();
    };

    band.append(fold);
    return band;
  }

  /**
   * The strip: what this aside says with its door shut.
   *
   * Built once with the panel and **patched** from then on, never rebuilt. Two reasons and
   * the second is the sharp one: the badges repaint on the roster beat, so replacing the
   * nodes would take a running pulse away half a beat after it started, and the pulse is
   * the whole of how a folded panel says something arrived.
   *
   * A strip is a door, not a window — a role, three numbers, and no message text ever. It
   * is a `<button>` because it is one: the whole column is the control that reopens the
   * panel, and the chevron at the top is the affordance that says so. Being a button also
   * settles the focus ring for free — Chrome draws `:focus-visible` for a keyboard, and
   * nothing for the mouse press that the pane's own `mousedown` focus handler is about to
   * see anyway.
   */
  function buildAsideStrip() {
    const strip = document.createElement('button');
    strip.className = 'fold-strip';
    strip.type = 'button';
    strip.title = 'Open the team panel';
    strip.setAttribute('aria-label', 'Open the team panel');
    strip.onclick = () => {
      asideFolded.set(false);
      foldAsides();
    };

    // The band's own glyph, mirrored — the chevron points *left*, back at the transcript
    // this panel is about to take room from. Same drawing, from `foldIcon`, so the control
    // that shut this panel and the control that reopens it cannot come to disagree about
    // what a fold looks like. It sits at the top of the strip, where the band's icon was,
    // so the eye goes back to the same corner.
    const chev = document.createElement('span');
    chev.className = 'fold-strip-chev';
    chev.append(foldIcon('expand'));

    // The rail's own chip stood on end. Both class pairs, deliberately: `.fold-strip-label
    // .is-role` is the vertical box, `.role-chip.is-<role>` is the rail's spelling of what
    // the word means — and only a lead has an aside today, so `is-role`'s own fill is the
    // lead's fill. The role is carried through from `asideStripFacts` rather than written
    // as `lead` here, so the chip on the strip and the chip on the rail row cannot come to
    // disagree about what this session is.
    const role = document.createElement('span');
    role.className = 'fold-strip-label is-role';

    const badge = (cls, title) => {
      const b = document.createElement('span');
      b.className = cls;
      b.title = title;
      b.hidden = true;
      return b;
    };
    const tasks = badge('fold-strip-badge', 'Open tasks on this team');
    const review = badge('fold-strip-badge is-review', 'Tasks in review — waiting on you');
    // The room's own count sits at the *bottom* of the strip, where the room sits in the
    // open panel — settings and tasks above, room below. Two of these three badges are the
    // same accent (the tasks count, and this one, which is the rail's own unread colour),
    // so position is what tells them apart at a glance: the pair at the top is the tasks
    // block, the one at the foot is the room. `is-room` is scoped to this host rather than
    // added to item 1's shared chrome — a room pane's strip is one column of one thing and
    // has no such split to express.
    const room = badge('fold-strip-badge is-room', 'New lines in the team room since you folded this away');

    roomView.stripEl = strip;
    roomView.stripRoleEl = role;
    roomView.stripTasksEl = tasks;
    roomView.stripReviewEl = review;
    roomView.stripRoomEl = room;

    strip.append(chev, role, tasks, review, room);
    return strip;
  }

  /**
   * Repaint the strip's counts.
   *
   * Off `asideStripFacts`, which is the same `s.team` object the rail row reads — so a
   * folded aside and the rail row standing for the same session cannot come back with two
   * different numbers. Zero draws nothing, which is that module's rule and the rail's: a
   * `· 0` is furniture.
   *
   * Called from `renderHead` on the roster beat, and **never from `composerSig`** — the
   * merge block's rule two functions down, for its reason. A count changing must not tear
   * the textarea down under whoever is typing.
   */
  function renderAsideStrip() {
    const strip = roomView.stripEl;
    if (!strip) return;
    const facts = asideStripFacts(current()?.team);

    const role = roomView.stripRoleEl;
    if (role) {
      role.hidden = !facts;
      // The rail's own class for this role, kept in step with the word: a role this panel
      // has never met draws the generic chip rather than a lead's filled one.
      role.className = `fold-strip-label is-role role-chip is-${facts?.role || 'lead'}`;
      role.textContent = facts?.role || '';
      role.title = facts?.role === 'lead' ? 'Team lead' : facts?.role || '';
    }

    const set = (el, n) => {
      if (!el) return;
      el.hidden = !n;
      if (n) el.textContent = String(n);
      // A spent badge drops the pulse with the number. It is hidden either way, so this
      // changes nothing on screen — it stops a class that means "this just arrived" riding
      // along on a node that is about to be shown again for a different arrival.
      else el.classList.remove('is-new');
    };
    set(roomView.stripTasksEl, facts?.tasks || 0);
    set(roomView.stripReviewEl, facts?.review || 0);
    set(roomView.stripRoomEl, roomView.foldedUnseen || 0);

    // The pulse, re-armed by an arrival and never by a paint. Removing the class, forcing
    // a synchronous reflow and putting it back is what actually restarts a CSS animation
    // — assigning the same class name again does nothing, and `requestAnimationFrame`
    // never fires in an automated Chrome window, which is where this has to be provable.
    if (roomView.foldedPulse && roomView.stripRoomEl) {
      roomView.foldedPulse = false;
      roomView.stripRoomEl.classList.remove('is-new');
      void roomView.stripRoomEl.offsetWidth;
      roomView.stripRoomEl.classList.add('is-new');
    }
  }

  /**
   * Put this aside where the preference says, animating if it has to move.
   *
   * The whole of the fold, in one function, because every step of it depends on the one
   * before and splitting them would be four places that have to agree about the order.
   *
   * **Measure, freeze, force a reflow, then change the value.** The freeze is
   * `--aside-frozen`, the panel's own measured expanded width, and the reflow is
   * `void panel.offsetWidth` — never `requestAnimationFrame`, which an automated Chrome
   * window reports `visibilityState: 'hidden'` for and never fires; this repo has already
   * lost an hour to that once.
   *
   * Expanding, the width to animate *to* is the stylesheet's answer and not something this
   * function may compute — `--aside` clamped by a floor and a ceiling that depend on the
   * pane's own width. So it is measured the only honest way: take `is-strip` off, read the
   * rect, put it straight back, all inside one synchronous block, so no frame ever paints
   * the expanded panel without its transition armed.
   *
   * `--aside` is never written here, in either direction. That is what makes the dragged
   * width come back on expand rather than being restored from something this feature
   * remembered — and it is why `foreman.asideWidth` is untouched by a fold.
   */
  function applyAsideFold() {
    const panel = roomView.panelEl;
    const body = roomView.bodyEl;
    if (!panel || !panel.isConnected || !body) return;
    const want = asideFolded.on;
    if (panel.classList.contains('is-strip') === want) return;

    if (want) {
      panel.style.setProperty('--aside-frozen', `${panel.getBoundingClientRect().width}px`);
    } else {
      // Off, read, on — one synchronous block, so this never reaches a paint.
      panel.classList.remove('is-strip');
      const w = panel.getBoundingClientRect().width;
      panel.classList.add('is-strip');
      void panel.offsetWidth;
      panel.style.setProperty('--aside-frozen', `${w}px`);
      // Expanding gives the reader the panel back, so the counter is spent and the pulse
      // disarmed *before* the animation, not after it — the badge is fading out through
      // the whole 200ms and a number that changed at the end of that would be a flicker.
      roomView.foldedUnseen = 0;
      roomView.foldedPulse = false;
      renderAsideStrip();
    }

    panel.classList.add('is-folding');
    void panel.offsetWidth; // the value the transition starts from
    panel.classList.toggle('is-strip', want);
    // Tab must not walk into a column that is 2.5rem wide and clipped. `inert` is what the
    // SETTINGS fold two functions up uses for the same thing, and for its reason: a block
    // hidden by `overflow` is invisible and still focusable, and still read out.
    body.inert = want;

    clearTimeout(roomView.foldTimer);
    roomView.foldTimer = setTimeout(() => endAsideFold(), ASIDE_FOLD_MS + 60);
  }

  /**
   * The end of a fold, from either the event or the backstop, and safe to run twice.
   *
   * The remeasure is the part that is not optional. `capTaskList` and the room's five-line
   * clamp both cache what they measured onto the DOM, and both kept running while the
   * panel was folded — the freeze above stops them measuring a 2.5rem column, and this is
   * what puts the honest numbers back once the panel has stopped moving. They are the same
   * three calls the aside's own dividers make when they change this panel's shape, for the
   * same reason.
   */
  function endAsideFold() {
    const panel = roomView.panelEl;
    if (!panel) return;
    clearTimeout(roomView.foldTimer);
    panel.classList.remove('is-folding');
    if (panel.classList.contains('is-strip')) return;
    panel.style.removeProperty('--aside-frozen');
    recapTaskLists();
    renderTasks();
    pinRoom();
  }

  /**
   * Put a freshly mounted aside into the state the preference asks for, without animating.
   *
   * `buildRoomPanel` applies the class before the node is in the document; this is the half
   * that needs a rect, and it runs straight after the mount and before the first paint, so
   * the fallback in `--aside-frozen`'s `var()` covers a gap nobody can see. Measured the
   * same off-read-on way `applyAsideFold` measures, and for the same reason.
   */
  function syncAsideFold() {
    const panel = roomView.panelEl;
    if (!panel || !panel.isConnected || !panel.classList.contains('is-strip')) return;
    panel.classList.remove('is-strip');
    const w = panel.getBoundingClientRect().width;
    panel.classList.add('is-strip');
    panel.style.setProperty('--aside-frozen', `${w}px`);
  }

  /**
   * The room's heading, and the one control on it: `clear` / `show all`.
   *
   * It used to be a plain `section()` line. It keeps `is-band` — that paint is what stops the
   * heading reading as one more row of the tasks list above it, and the band is a paint and
   * nothing else, so the `.tasks-grip` hairline it was measured against is untouched — and
   * gains `has-controls`, which is TASKS' own line: flex, centred, one gap. The button is
   * `room-head-toggle`, the same shape as `hide finished` two headings up, because it is the
   * same kind of thing: it changes what you are looking at and nothing on disk about the
   * team. Unlike that one it carries **no `aria-pressed`** — there is one button at a time
   * and its own word says which state the room is in, so a pressed outline on top of that
   * would be the control saying the same thing twice and disagreeing with itself half the
   * time.
   *
   * No confirmation, deliberately: nothing here is destructive. `room.jsonl` is append-only
   * and `clear` adds one line to it; the pointer this moves is the only thing that changes,
   * and the other button puts it back.
   */
  function buildRoomHead() {
    const head = document.createElement('div');
    head.className = 'room-head is-band has-controls';

    const label = document.createElement('span');
    label.className = 'room-head-label';
    label.textContent = 'Team room (read only)';
    head.title = 'Workers and the lead coordinate here. View only — talk to the lead in the composer.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-head-toggle';
    // `margin-left: auto` comes from `.room-head-note` on the TASKS line; this heading has no
    // note, so the spacer is the button's own. One empty span rather than a second rule in
    // the stylesheet for a heading that will never carry a count.
    const spacer = document.createElement('span');
    spacer.className = 'room-head-note';
    btn.onclick = (e) => {
      // `buildTasksHead`'s line and its reason: this heading carries no click handler today,
      // and this is what keeps that a free choice rather than something the button silently
      // depends on.
      e.stopPropagation();
      pressSlate();
    };
    roomView.slateBtnEl = btn;
    head.append(label, spacer, btn);
    renderRoomHead();
    return head;
  }

  /** Paint the head's one button off the slate the server last told us about. */
  function renderRoomHead() {
    const btn = roomView.slateBtnEl;
    if (!btn) return;
    const { label, title } = slateButton(roomView.slate);
    btn.textContent = label;
    btn.title = title;
    btn.disabled = roomView.slateBusy || !roomView.repo;
  }

  /**
   * Press it. One request, and the answer arrives twice — once as this fetch's body and
   * once as the `room-slate` frame every open window gets, this one included.
   *
   * The frame is what actually repaints, which is the point: a second browser on the same
   * panel has to end up showing the same room without anybody touching it. The body is read
   * only to unstick the button and to notice a refusal, and `slateBusy` is there so three
   * fast clicks write one divider rather than three — `sessionRow`'s `duplicating` lesson,
   * in a heading.
   */
  async function pressSlate() {
    const repo = roomView.repo;
    if (!repo || roomView.slateBusy) return;
    const { action } = slateButton(roomView.slate);
    roomView.slateBusy = true;
    renderRoomHead();
    try {
      const res = await fetch(`/api/team/room/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: repo }),
      });
      const body = await res.json().catch(() => ({}));
      // The socket frame is the authority and normally lands first; this is the fallback for
      // a window whose socket is down, and it is guarded on the room not having moved on to
      // another team while the request was in flight.
      if (res.ok && roomView.repo === repo) {
        roomView.slate = slateActive(body.slate) ? body.slate : null;
        roomView.follow = true;
        roomView.unseen = 0;
        renderRoom();
      }
    } catch {
      /* the socket frame or the next open will settle it */
    } finally {
      roomView.slateBusy = false;
      renderRoomHead();
    }
  }

  function renderRoom() {
    const list = roomView.listEl;
    if (!list || !list.isConnected) return;
    const follow = roomView.follow !== false;
    // Where the reader is, held across the whole repaint — and read *first*, because
    // `list.scrollTop` on an emptied list is a forced layout on a box with nothing in it,
    // which clamps the answer to 0 before you have read it.
    //
    // Holding it used to come for free: `replaceChildren` plus a run of appends never
    // forces a layout, so the old offset survived untouched. The clamp pass below *does*
    // force one, and every height settled after it above the reader slides the list under
    // them — silently, with no scroll event, which is this box's signature failure.
    // Measured at 66px of creep per incoming line before this line existed.
    const held = list.scrollTop;
    // What the slate leaves on screen — the divider and everything after it, or the whole
    // log. Computed once and used for every count below as well as for the paint, or
    // `unseen` would be counting lines this room is not drawing.
    const shown = visibleEntries(roomView.entries, roomView.slate);
    renderRoomHead();
    list.replaceChildren();
    if (!shown.length) {
      const quiet = document.createElement('div');
      quiet.className = 'room-quiet';
      // A cleared room is not an empty one, and saying "nothing yet" over a log with two
      // hundred lines in it would be the panel telling the reader something untrue. It can
      // only be reached in the beat between the divider being written and the append frame
      // arriving, which is exactly when the sentence matters most.
      quiet.textContent = slateActive(roomView.slate)
        ? 'Cleared. New lines land here; the earlier ones are behind “show all”.'
        : 'Nothing yet. Worker updates and escalations land here.';
      list.append(quiet);
      roomView.painted = 0;
      roomView.unseen = 0;
      updateRoomHint();
      return;
    }
    const before = roomView.painted ?? 0;
    // Read every clamp candidate before writing to any of them. `roomEntryNode` marks
    // each one clamped and registers it here; measuring and settling one at a time would
    // interleave a layout read with a class write per entry, which is a reflow per entry
    // on a list that repaints on every incoming post. Two passes is one layout.
    const clamps = [];
    for (const e of shown) list.append(roomEntryNode(e, clamps));
    for (const c of clamps) c.overflows = c.el.scrollHeight > c.el.clientHeight + 1;
    for (const c of clamps) applyRoomClamp(c);
    roomView.painted = shown.length;
    if (follow) {
      pinRoom();
      roomView.unseen = 0;
    } else {
      // Put the reader back exactly where they were. The entries above them are the same
      // entries at the same heights they had last paint — an expanded one re-renders
      // clamped and is un-clamped again before this line — so the old offset is still the
      // right one, and it is only wrong to keep it if you are following the bottom.
      list.scrollTop = held;
      // A full `room` frame can *shrink* the list (a fresh read, a shorter tail), so the
      // arithmetic is floored rather than trusted — this counter must never go negative
      // and start hiding a hint that is due.
      roomView.unseen += Math.max(0, shown.length - before);
    }
    updateRoomHint();
  }

  /** Draw (or drop) the "new below" pill. Quiet by design — see the button's comment. */
  function updateRoomHint() {
    const hint = roomView.hintEl;
    if (!hint) return;
    const n = roomView.follow === false ? roomView.unseen || 0 : 0;
    hint.hidden = n === 0;
    if (n === 0) return;
    hint.textContent = n === 1 ? '1 new below ↓' : `${n} new below ↓`;
    hint.title = 'Jump to the newest line and follow the room again.';
  }

  /**
   * Put the room back on its newest line — but only while you are following it.
   *
   * Two halves. *Following* is an intention, not a geometry test at paint time: the room
   * repaints in full on every incoming post, and a worker's report is now a bubble you
   * can spend a minute reading, so being yanked to the bottom mid-read is worse than
   * scrolling down for the new line yourself. Only the scroll handler flips it.
   *
   * And *the box moves under the scroll*. The tasks list and the settings block above it
   * both arrive over HTTP a beat after the aside mounts, and each one shrinks the room —
   * a shorter box with the same scrollTop is no longer at the bottom, silently, with no
   * scroll event to say so. Measured: the room opened 454px short of its newest line,
   * every time. So the two things that resize it call this when they repaint. A
   * ResizeObserver would be the general answer and was tried; it is also unverifiable
   * from a headless window, where the tab is `hidden` and neither it nor rAF ever fires.
   * These two calls are the whole population of things that change this box's height.
   */
  function pinRoom() {
    const list = roomView.listEl;
    if (!list || !list.isConnected) return;
    // The height this pin was taken at, so the scroll handler above can tell a resize's
    // own event from a reader's. Recorded even when we are not following: the box still
    // changed size, and the next event is still the layout's rather than theirs.
    roomView.followH = list.clientHeight;
    if (roomView.follow === false) return;
    list.scrollTop = list.scrollHeight;
  }

  /**
   * Clamp one long entry to five lines behind a quiet "view more".
   *
   * A worker's DONE report runs to several paragraphs and the room is a 340px aside read
   * beside the conversation with the lead — one report can fill the panel and push
   * everything else out of view. Bubbles and system cards get this; **escalations and
   * alerts never do**, because folding four fifths of a decision behind a control is the
   * exact failure the loud card exists to prevent.
   *
   * Nothing is decided here and nothing is drawn here. The element goes out clamped and
   * registered; `renderRoom` measures the whole batch at once and `applyRoomClamp` is what
   * puts a control on screen — an entry that fits must not grow a "view more" that does
   * nothing when clicked, and whether it fits is a measurement, not a guess about length.
   */
  function roomClampable(el, seq, pending) {
    el.classList.add('room-clamp');
    pending.push({ seq, el, btn: null, overflows: false });
  }

  /**
   * Settle one measured candidate: no overflow, no control; otherwise draw its state.
   *
   * The button is built here rather than during the paint and *only* where it is needed.
   * The first draft made one per clampable entry and removed the ones that turned out to
   * fit — which is 19 nodes built and destroyed per paint on a 22-line room, and worse,
   * every removal above the reader shrank the list under them: 66px of silent creep per
   * incoming line, measured, with no scroll event to notice it by. `renderRoom` holds the
   * offset for what is left of that; this is the half that stops causing it.
   */
  function applyRoomClamp(c) {
    if (!c.overflows) {
      c.el.classList.remove('room-clamp');
      return;
    }
    const open = roomView.expanded.has(c.seq);
    c.el.classList.toggle('room-clamp', !open);
    if (!c.btn) {
      c.btn = document.createElement('button');
      c.btn.className = 'room-more';
      c.btn.type = 'button';
      c.btn.onclick = () => toggleRoomEntry(c);
      c.el.after(c.btn); // directly under the words it cut off, inside the entry's frame
    }
    c.btn.textContent = open ? 'view less' : 'view more';
    c.btn.title = open ? 'Fold this entry back to five lines.' : 'Show the whole entry.';
  }

  /**
   * Open or fold one entry, keeping it where the reader is looking.
   *
   * `follow` is deliberately untouched. Expanding changes the list's height and that must
   * never read as the reader having scrolled away — the intention is the reader's, and
   * only the scroll handler flips it. Nor does this pin: an entry you just opened is one
   * you are about to read, and snapping to the newest line is the yank the whole
   * follow-as-intention rule was built to stop.
   *
   * Growing a node never moves its own top, so the anchor holds for free on the way open.
   * Folding is the case that needs the arithmetic: collapse one near the end of the list
   * and the browser clamps scrollTop to the new maximum, which does move it. Measure the
   * offset either side and put it back.
   */
  function toggleRoomEntry(c) {
    if (roomView.expanded.has(c.seq)) roomView.expanded.delete(c.seq);
    else roomView.expanded.add(c.seq);
    const list = roomView.listEl;
    // The entry's own frame, found from the text rather than remembered: the record is
    // built before the card that will hold it exists, and a stored reference would be one
    // more thing to keep true through the next restyle.
    const node = c.el.closest('.room-msg, .room-system, .room-escalation, .room-alert');
    if (!list || !node || !node.isConnected) {
      applyRoomClamp(c);
      return;
    }
    const top = () => node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const was = top();
    applyRoomClamp(c);
    const now = top();
    if (now !== was) list.scrollTop += now - was;
  }

  /**
   * A sender/recipient identity chip. The lead is one identity, each task id another.
   *
   * **One function builds both ends of a lead→worker line**, and that is the whole point:
   * they name the same worker and have to agree on its hue at both ends of one row. Two
   * builders of one pill is the `isLeadName` lesson in another costume, and here the failure
   * would be visible — `lead → [phone-worker-lines]` in one colour, above that worker's own
   * bubble in another. `is-to` is the *only* thing the recipient adds, and it carries shrink
   * behaviour and nothing else.
   *
   * `colour` is tier 2 and nothing else — see `.room-pill.is-lead`'s comment in the CSS for
   * why tiers 1 and 3 stay muted. `colourFor` is **imported** from `web/session-colour.js`
   * and never re-implemented here: a second copy of that FNV-1a hash is two spellings of a
   * mapping that must agree, and the same worker drawing two different colours in two panes
   * is the same lesson again. The hue is set inline off the ring rather than as a class per
   * slot, because seven near-identical rules is what a later change to `PEER_COLOUR_COUNT`
   * leaves short; `currentColor` on the border keeps a speaker one value rather than two.
   * The lead is never given one — the accent is authority here and is deliberately outside
   * the ring.
   */
  function roomPill(id, { colour = false, to = false } = {}) {
    const lead = id === 'lead';
    const p = document.createElement('span');
    p.className = `room-pill${lead ? ' is-lead' : ''}${to ? ' is-to' : ''}`;
    p.textContent = id;
    p.title = id; // long task ids ellipsize; the full name rides the hover
    if (colour && !lead) {
      p.style.color = `var(--peer-${colourFor(id)})`;
      p.style.borderColor = 'currentColor';
    }
    return p;
  }

  /**
   * The one word a machinery line is *about*, beside who wrote it.
   *
   * **Keyed on `event` and `kind`, never on the sentence.** A dispatch and the `→ working`
   * line that follows it are identical by `about` — both carry the task id — and the text is
   * a message to a human that will be reworded, at which point a sentence-matched keyword
   * turns off silently and the room goes on looking fine. Same rule the machinery colours
   * already keep.
   *
   * So a line with no `event` on the record gets **no keyword at all** rather than a guess.
   * 577 machinery lines in this repo's own room carry none and always will — the log is
   * append-only, and nothing goes back to fill them in. The four commonest of those shapes
   * (`closed`, `pr`, `started`, `model`) are stamped at the source now, in `server/index.js`
   * and `server/watch.js`, so lines written from that point on say what they are; every line
   * written before stays plain, which is correct rather than a gap to paper over. Note there
   * is no case for them here and there must not be one: this returns the event verbatim, so
   * a fifth stamp needs no client change at all, and the day one wants a *colour* it is
   * `roomEntryNode`'s modifier list that grows, not this.
   *
   * The single derived word is `merge-check`: a refused self-merge carries the same `event`
   * as an allowed one and is the panel doing its job rather than a decision taken, so it says
   * what it was — a check — and takes no colour.
   */
  function roomKeyword(e) {
    if (e.kind === 'conflict') return 'conflict';
    if (!e.event) return '';
    return e.event === 'self-merge' && !e.allowed ? 'merge-check' : String(e.event);
  }

  /**
   * Who spoke, on a link entry: the **project**, not the generic `lead`.
   *
   * **Links were retired on 2026-09-05 and these entries were not.** A linked project's
   * room carries both halves of the conversation, so this room shows two different leads
   * talking, and `from: 'lead'` on both of them drew one identical pill over each: with two
   * projects in the log you could not tell which one said what. Nothing writes a
   * `kind: 'link'` entry any more; two dozen of them are on disk across four team rooms,
   * and without this branch every one of them goes back to reading as an anonymous `lead`.
   *
   * **Derived here, not written by the server, and that is the point.** The entry already
   * carries `sender` (an absolute repo path), so a `senderName` field would be a second
   * spelling of a fact already on the record — the `isLeadName` lesson — and it would be
   * missing from every line already on disk. Deriving it instead means the lines written
   * before this existed are named too, without an append-only log being rewritten. It is
   * `projectName`, the same one function the retired joint thread's own pill used, so a
   * line written then and read now names its project identically.
   *
   * `speaker` decides the shape, never the path: a human entry's `sender` is not a repo at
   * all and has no basename to take. That is the field's whole reason for existing, and it
   * is why this branch reads the field rather than working the answer out from the paths.
   */
  function roomLinkPill(e) {
    const human = e.speaker === 'human';
    const p = document.createElement('span');
    p.className = `room-pill is-project${human ? ' is-human' : ''}`;
    p.textContent = human ? 'you' : projectName(e.sender);
    // Two projects can share a basename, so the face is short and the folder rides the
    // hover.
    p.title = human ? 'The maintainer, in the joint thread' : String(e.sender || '');
    return p;
  }

  /**
   * What kind of thing an entry is, in one word, beside who said it.
   *
   * **Read off the record's own fields, never off the sentence.** `report`, `plan` and
   * `kind` are what the poster said the entry *is*; the text is a message to a human and
   * will be reworded, and the day it is, a sentence-matched tag turns off silently and the
   * room goes on looking fine. Same rule the machinery colours already keep — and the
   * reason `about` cannot be used for any of this: it is the task id, which every
   * task-scoped entry carries.
   *
   * Three words today. A `plan` report and a `review` report are one field apart and are
   * genuinely different things to a reader — one is a page to read, the other a branch to
   * merge — so they get different words rather than one `review` covering both. The room's
   * two loud shapes (an escalation, an alert) have tags of their own coming with tier 3;
   * they are deliberately not squeezed in here, where they would land on a card that has
   * not yet been rebuilt to hold them.
   */
  function roomTag(e) {
    const tag = (word, mod) => {
      const s = document.createElement('span');
      s.className = `room-tag ${mod}`;
      s.textContent = word;
      return s;
    };
    // Tier 3's two words, and they are the only red in the room besides its frame. An
    // escalation and an alert now share one card, so the tag and the author line are the
    // whole of what tells them apart — a worker's name against `panel`.
    if (e.kind === 'escalation') return tag('escalation', 'is-loud');
    if (e.alert) return tag('alert', 'is-loud');
    if (e.kind === 'answer') return tag('answer', 'is-answer');
    if (e.report === 'review') return e.plan ? tag('plan', 'is-plan') : tag('review', 'is-review');
    return null;
  }

  /**
   * The identity row over a bubble or card: sender always, recipient only when the
   * message is explicitly addressed. `to: 'lead'` is the room's default destination —
   * a worker bubble in the left lane already says it — but everything a lead or the
   * panel aims at a task id (or `all`) shows both ends.
   *
   * Four slots now — `who · [→ to] · [tag] · time` — and the tag is the new one. It sits
   * between the recipient and the stamp so the row reads as a sentence left to right: who,
   * to whom, about what, when. The other three slots are unchanged in this pass; what
   * fills them, and in what colour, is the talk tier's business.
   *
   * A link entry is the one shape whose sender is a project rather than a role, so it
   * takes its own pill and never draws the `to` half: both ends of a link are leads, and
   * `lead → lead` says nothing the pill has not already said better. It carries no tag
   * either — a link is a remark, and none of the three words is ever true of one.
   */
  function roomMeta(e, { colour = false } = {}) {
    const meta = document.createElement('div');
    meta.className = 'room-meta';
    // A link entry with no `sender` is not a shape anything writes — but an empty pill
    // would be worse than the generic one it replaced, so the fallback is the old pill
    // rather than a blank. Prefer showing nothing new over showing nothing at all.
    if (e.kind === 'link' && (e.sender || e.speaker === 'human')) {
      meta.append(roomLinkPill(e));
      if (e.ts) meta.append(roomStamp(e.ts));
      return meta;
    }
    meta.append(roomPill(e.from, { colour }));
    if (e.to && e.to !== 'lead') {
      const arrow = document.createElement('span');
      arrow.className = 'room-arrow';
      arrow.textContent = '→';
      // The recipient takes the *same* answer about colour as the speaker, so the hue stays a
      // property of the tier rather than of the slot: on a lead→worker bubble both ends are
      // coloured, and on tier 3 — where a green name on a red card would read as a status —
      // neither is.
      meta.append(arrow, roomPill(e.to, { colour, to: true }));
    }
    const tag = roomTag(e);
    if (tag) meta.append(tag);
    if (e.ts) meta.append(roomStamp(e.ts)); // the date lives on hover — no wall of stamps

    return meta;
  }

  /** The audit-trail line under an autonomous answer — quiet, but never hidden. */
  function roomAside(label, text) {
    const g = document.createElement('div');
    g.className = 'room-grounds';
    g.textContent = `${label}: ${text}`;
    return g;
  }

  /** The hh:mm every shape carries, with the full date on hover. */
  function roomStamp(ts) {
    const t = document.createElement('span');
    t.className = 'room-time';
    const d = new Date(ts);
    t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    t.title = d.toLocaleString();
    return t;
  }

  /**
   * The checks a self-merge verdict actually looked at, behind one control.
   *
   * **This overturns a recorded decision and does it deliberately.** The list used to be
   * always open, on the ground that the maintainer reads it back a week later, so it was
   * "not a hover and not a clamp". The measurement that changed it: five self-merges in one
   * 38-entry window of this repo's own room are 1,646px — a third of the room — of which
   * 1,097px is these lists. Folding does not stop it being read back; it stops it being in
   * front of you five times per plan item, and the sentence above already names the PR and
   * the reason. The comment beside `.room-reasons` in `web/styles.css` was rewritten in the
   * same commit, because a comment left arguing against the code beside it is worse than no
   * comment.
   *
   * Keyed on `<seq>:checks` in `roomView.expanded`, the same set the five-line clamp uses and
   * for the same reason: the room repaints in full on every incoming post, and a fold that
   * re-folds under the reader is worse than no fold. A distinct key from the clamp's own
   * `seq`, because one entry can carry both.
   *
   * Opening swaps the button for the list in place and repaints nothing else — a line
   * arriving in another room must never take this aside apart under whoever is reading it.
   * It is one-way until the room is reopened, which is what the signed-off mock-up draws:
   * its open state carries no control at all.
   */
  function roomChecks(e) {
    const key = `${e.seq}:checks`;
    const list = () => {
      const ul = document.createElement('ul');
      ul.className = 'room-reasons';
      for (const r of e.reasons) {
        const li = document.createElement('li');
        li.textContent = String(r);
        ul.append(li);
      }
      return ul;
    };
    if (roomView.expanded.has(key)) return list();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-checks';
    btn.textContent = `${e.reasons.length} checks ›`;
    btn.title = 'Show what the merge check looked at.';
    btn.onclick = () => {
      roomView.expanded.add(key);
      btn.replaceWith(list());
    };
    return btn;
  }

  /**
   * One room entry as one of three *tiers* of loudness, told apart by shape alone.
   *
   * **Tier 1 — machinery** (`system`, `conflict`): a git-log line. Time, author, keyword,
   * sentence, all on one line, with a 2px gutter rule carrying the colour the frame used to.
   * The bookkeeping is the bulk of this room — 24 of 38 entries in a measured window, 55% of
   * its height — and it was drawn in exactly the same boxes as a worker's report.
   *
   * **Tier 2 — talk** (`chat`, `status`, `answer`, legacy `link`): the panel's rooms bubble,
   * full column width, colour on the speaker's pill and nowhere else. The lanes are gone: a
   * lane is a two-sided idea and a team room is one lead, several workers, and a reader who
   * is neither.
   *
   * **Tier 3 — needs you** (`escalation`, `alert`): one framed, tinted, red card — the only
   * red in the room — shared by both and told apart by the author line they now both carry.
   *
   * The first pass at tier 1 drew machinery as centred text between two hairlines; it read as
   * free text and it took the amber box off the conflict line, which was the part that
   * worked. Every line here starts at a left gutter that carries that colour, and every line
   * names who wrote it.
   *
   * Tiers 1 and 2 clamp at five lines — see `roomClampable`. Tier 3's *body* never does;
   * only its audit trail.
   */
  function roomEntryNode(e, pending = []) {
    const kind = e.kind || 'status';

    /* ------------------------------------------------------ tier 3: needs you --- */
    if (e.alert || kind === 'escalation') {
      const card = document.createElement('div');
      // Two class names, one shape. Red is a budget and this card is the whole of it; both
      // names stay because a rename is a large silent diff for nothing.
      card.className = e.alert ? 'room-alert' : 'room-escalation';
      // Every card on this tier names who wrote it, and that is the whole of what tells the
      // two apart: an escalation is a worker speaking, an alert is `panel`. The pill stays
      // muted — the peer hue is tier 2 only, and a green name on a red card reads as a
      // status. A refused link message rides the alert card and is still one project's
      // words; `roomMeta` is the one branch that knows how to attribute one.
      card.append(roomMeta(e));
      const text = document.createElement('div');
      text.className = 'room-text';
      text.textContent = e.text || '';
      card.append(text);
      // The escalation schema's extras, worth their pixels: what the worker weighed,
      // what it recommends, what it checked before asking, what it does meanwhile.
      for (const opt of e.options || []) {
        const o = document.createElement('div');
        o.className = 'room-esc-opt';
        o.textContent = opt.implication ? `${opt.label} — ${opt.implication}` : opt.label;
        card.append(o);
      }
      if (e.recommendation) {
        const r = document.createElement('div');
        r.className = 'room-esc-rec';
        r.textContent = `recommends: ${e.recommendation}`;
        card.append(r);
      }
      // **The audit trail clamps; the decision never does.** Hiding four fifths of a decision
      // behind a control is the exact failure this loud card exists to prevent — so the
      // question, the options and the recommendation stay open always, and `grounds` and
      // `meanwhile` fold. That clamp alone is the 1,015px → 763px on the measured pair.
      //
      // Keyed `<seq>:grounds` / `<seq>:meanwhile`, because one card can carry both and
      // `roomView.expanded` is one flat set.
      for (const [label, value] of [['grounds', e.grounds], ['meanwhile', e.continuing]]) {
        if (!value) continue;
        const aside = roomAside(label, value);
        card.append(aside);
        roomClampable(aside, `${e.seq}:${label}`, pending);
      }
      return card;
    }

    /* ------------------------------------------------------ tier 1: machinery --- */
    if (kind === 'system' || kind === 'conflict') {
      const row = document.createElement('div');
      row.className = 'room-system';
      // The gutter's colour *and* the keyword's, out of one custom property — and every
      // modifier keyed on what the poster said the line **is**, never on how the sentence
      // reads. `about` cannot do it: it is the task id, and every task-scoped system line
      // carries one, so a dispatch and the transition that follows it are identical by that
      // key. Matched exactly, so a new `event` colours nothing by accident.
      if (kind === 'conflict') row.classList.add('is-conflict');
      else if (e.event === 'dispatch') row.classList.add('is-dispatch');
      // A task merely recorded is the opposite of both: nothing started, nothing to look at.
      // It goes *quieter* than the plain row rather than louder — a dashed gutter and no
      // colour. Spending a third hue on "nothing happened" would cost the two that mean
      // something.
      else if (e.event === 'pending') row.classList.add('is-pending');
      // Matched on the event **and** on `allowed`, both exactly: the same endpoint posts a
      // line for every refusal, and a refused check is the panel doing its job.
      else if (e.event === 'self-merge' && e.allowed) row.classList.add('is-self-merge');
      // A row no modifier claimed. The class exists so its keyword takes the row's muted ink
      // rather than the gutter's `--rule-strong`, which is a rule colour and is nowhere near
      // legible as text. The four server-stamped events — `closed`, `pr`, `started`,
      // `model` — land here deliberately: they get a keyword and no colour, because a hue
      // here means *look at this*, and a task closing cleanly is the opposite of that.
      else row.classList.add('is-plain');
      // The slate divider. It is a plain machinery row — plain gutter, `--ink-muted`
      // keyword, no colour of its own, because a hue in this room means *look at this* and
      // a line the reader pressed a button to create is the one thing they already know
      // about. What it adds is a hairline across the column, which is the only shape in the
      // room that says "a boundary" rather than "an event": with a slate up this is the
      // first row and the rule is the top of the slate; under `show all` it is where a
      // clear happened, in its place, which is exactly what it was.
      if (e.event === 'clear') row.classList.add('is-clear');
      if (e.ts) row.append(roomStamp(e.ts), document.createTextNode(' '));
      // `panel` on every machinery line, which is new and was the "some with, some without"
      // complaint. It reads `e.from`, so the lead's own lines — a self-merge among them —
      // say `lead`: one field on the record, not a second spelling of who wrote what.
      row.append(roomPill(e.from), document.createTextNode(' '));
      const word = roomKeyword(e);
      if (word) {
        const key = document.createElement('span');
        key.className = 'room-key';
        key.textContent = word;
        row.append(key, document.createTextNode(' '));
      }
      // Inline with everything above it, so a one-sentence event stays one entry tall — until
      // it overflows five lines, when the clamp turns this span into a block and the sentence
      // starts on its own line. That is the measurement doing it, not a branch here.
      const text = document.createElement('span');
      text.className = 'room-system-text';
      text.textContent = e.text || '';
      row.append(text);
      roomClampable(text, e.seq, pending);
      // What the verdict checked, folded. Drawn from `reasons` rather than from `event`, so
      // any machinery line that grows a list gets it. Deliberately *outside* the clamp:
      // `applyRoomClamp` puts "view more" directly after the text it cut off, so this lands
      // below that control, and its own height is settled before the clamp pass measures
      // anything.
      if (Array.isArray(e.reasons) && e.reasons.length) row.append(roomChecks(e));
      return row;
    }

    /* ----------------------------------------------------------- tier 2: talk --- */
    const wrap = document.createElement('div');
    // `from-lead` no longer names a lane — every bubble is left-aligned and full width. It
    // survives as the hook for the accent edge and the 7% tint, the one bubble variant left.
    wrap.className = `room-msg ${e.from === 'lead' ? 'from-lead' : 'from-worker'} room-${kind}`;
    wrap.append(roomMeta(e, { colour: true }));
    const bubble = document.createElement('div');
    bubble.className = 'room-bubble';
    const text = document.createElement('div');
    text.className = 'room-text';
    text.textContent = e.text || '';
    // The control lands under the text, above the grounds and the reference — those are
    // short, and machinery a clamp must never swallow.
    bubble.append(text);
    roomClampable(text, e.seq, pending);
    if (e.grounds) bubble.append(roomAside('grounds', e.grounds));
    // The done report is the worker talking, so the words are its own. That it *is* the done
    // report is now said by the `review` / `plan` tag in the author line, which is why this
    // line stopped announcing itself and became a bare reference in muted mono: the branch to
    // merge, or — for a planner, whose branch is empty and would send a reader to look at
    // nothing — the plan file that is the deliverable.
    if (e.report === 'review') {
      const ref = document.createElement('div');
      ref.className = 'room-ref';
      ref.textContent = e.plan ? e.plan.split('/').pop() : e.branch || '';
      if (e.plan) ref.title = e.plan;
      // Nothing to name is nothing to draw: an empty node here is a blank line under the
      // words, which is the room asserting a reference it does not have.
      if (ref.textContent) bubble.append(ref);
    }
    wrap.append(bubble);
    return wrap;
  }
  function buildHead(s) {
    const head = document.createElement('div');
    head.className = 'main-head';

    const dot = document.createElement('span');
    dot.className = `dot ${s.status}`;
    head.append(dot);

    const h1 = document.createElement('h1');
    h1.textContent = s.title;
    head.append(h1);

    const meta = document.createElement('div');
    meta.className = 'head-meta';

    const stat = document.createElement('span');
    stat.className = 'head-status';
    renderHeadStatus(stat, s);
    meta.append(stat);

    // The same pin as the rail row, where you are when you decide a session is the one
    // you're staying in.
    const pin = document.createElement('button');
    pin.className = 'ghost-btn pin-toggle';
    paintPinBtn(pin, s);
    // Resolved at click time, not captured: the header is patched in place across roster
    // updates, so the session this button was built with is a snapshot that goes stale.
    pin.onclick = () => {
      const live = current();
      if (!live) return;
      togglePin(live);
      paintPinBtn(pin, live);
    };
    meta.append(pin);

    const think = document.createElement('button');
    think.className = 'ghost-btn';
    think.textContent = 'thinking';
    think.setAttribute('aria-pressed', String(state.showThinking));
    think.onclick = () => {
      state.showThinking = !state.showThinking;
      think.setAttribute('aria-pressed', String(state.showThinking));
      renderAllStreams();
    };
    meta.append(think);

    // Everything the session has produced for a human to read — images, documents and the
    // links it exposed — which is a different set from what is on screen; see `openFiles`.
    // Always here rather than gated on there being any: the panel holds a window of the
    // transcript and could not answer "are there any" without the scan the button itself
    // performs, and a control that came and went on a fact the rail cannot see would be
    // worse than one that sometimes says "none".
    const files = document.createElement('button');
    // `head-files`, in the header's own namespace beside `head-status` and `head-dialog`,
    // rather than a `files-*` name: those belong to the modal, and the one thing this class
    // is for is letting `paintFilesBtn` find this node again after a repaint.
    files.className = 'ghost-btn head-files';
    // The label is a text node of its own so the dot can be a sibling inside the button.
    // Set through `textContent` on the span and never on the button, or the next paint
    // wipes the dot it is supposed to be drawing beside.
    files.append(text('files'));
    files.onclick = () => {
      // Resolved at click time, like the pin above: the header is patched across roster
      // updates, so `s` is a snapshot.
      const live = current();
      if (!live) return;
      // Cleared by *looking*, which is the whole of what the dot promises. Before the
      // modal's own fetch and not after it: the reader has asked, and a dot that survived
      // the press until a fetch came back would read as a press that did nothing.
      view.filesNew = false;
      paintFilesBtn(files);
      openFiles(live.id, live.title);
    };
    paintFilesBtn(files);
    meta.append(files);

    // `interrupt` used to live here, four controls along from `thinking` and a whole
    // header away from the box you type into. It sits above the textarea now — see
    // `buildComposer`.

    // The toggles button is gone: the settings live in the team panel now, always
    // visible in the lead's aside — a scroll-to affordance in a 340px column earns
    // nothing.

    // One pane offers to split; two offer to close. The control is always in the header
    // of the pane it acts on, so there is never a question of which one it means. What it
    // says is `syncSplitBtn`'s, because the answer changes without this header being
    // rebuilt — see there.
    const split = document.createElement('button');
    split.className = 'ghost-btn split-toggle';
    syncSplitBtn(split, s);
    meta.append(split);

    // Last, the two that act outside the panel entirely — a window onto this session, and
    // the folder it runs in. The attach button is only here while there is no window: it
    // appears on a session launched headless, and again the moment you close the window of
    // one that had one, because `attached` is read live off tmux every poll. `syncAttach`
    // is what keeps that promise between rebuilds; this is only the first draw.
    // The folder goes in *first* and the attach button is inserted before it. Built the
    // other way round — folder created, passed to `syncAttach` as the reference node, then
    // appended — `insertBefore` is handed a node that is not a child of `meta` yet and
    // throws, which took the whole panel down: `buildHead` is called from the roster
    // handler, so nothing after it rendered and the rail went empty. It survived testing
    // because the only session I built a header for was already attached, and that is the
    // one case where `syncAttach` returns before inserting anything.
    if (s.paneCwd) meta.append(revealBtn(s));
    syncAttach(meta, s);

    head.append(meta);
    // Last, because it goes *between* the name and `.head-meta` and needs both on the
    // page to place itself. Usually draws nothing on this first pass: the forge arrives
    // with the team config, which `buildRoomPanel` has not asked for yet — see
    // `syncForgeLink`.
    syncForgeLink(head, s);
    return head;
  }

  /**
   * The forge's mark in a lead's header, linking to the repository's own web page.
   *
   * Add-or-drop rather than build-once, for the reason the attach button beside it is:
   * `renderHead` patches this header in place on every roster beat and never rebuilds it,
   * so a control whose *presence* changes has to be synced rather than drawn. Here it
   * changes for a reason nothing else in the header has — the header is appended by
   * `renderMain` **before** `syncRoom` and `buildSettings` have fetched the team config,
   * so at first draw the forge is simply not known yet. `paintForge` is what calls this
   * again when the answer lands; the roster beat is the backstop.
   *
   * Two guards worth keeping:
   *
   *   - **The config is matched against the repo it belongs to.** `roomView.config` is
   *     per pane and cleared by `syncRoom` — but `renderMain` builds the header first, so
   *     on the beat a second lead is opened it still holds the *previous* team's answer.
   *     Without the `roomView.repo === s.paneCwd` test one lead's header would link to
   *     another lead's repository for a frame, which is the panel's oldest rule broken in
   *     miniature: showing nothing beats showing something wrong.
   *   - **`webUrl` is the whole test.** The server has already refused it for `push only`
   *     and `no remote`, so there is no reading to re-decide here and no second place for
   *     that ruling to be spelled differently.
   */
  function syncForgeLink(head, s) {
    if (!head) return;
    const existing = head.querySelector('.head-forge');
    const forge = s?.isLead && roomView.repo && roomView.repo === s.paneCwd ? roomView.config?.forgeResolved : null;
    const url = forge?.webUrl || null;
    if (!url) return existing?.remove();
    if (existing?.dataset.url === url) return; // already this link — the common beat
    existing?.remove();
    head.insertBefore(forgeLink(url, forge.reading), head.querySelector('.head-meta'));
  }

  /**
   * What the split/close control says, decided from what is on screen right now.
   *
   * It used to be decided once, where the header is built — and a header is built when its
   * *session* changes, which is not when the number of panes changes. Close the second pane
   * and the survivor's header went on reading `close`, calling `closePane` on the only pane
   * there is, which returns immediately: a dead control, silently, with nothing to say so.
   *
   * Pre-existing and reachable on its own — split from a session's own header, close the
   * second pane, and the button is dead — but a non-session pane put it on the path most
   * likely to be walked, since "close the room" is exactly a two-panes-to-one transition.
   * Measured before the fix: `['pin','thinking','images','close']` with one pane on screen.
   *
   * So the answer is re-asked wherever the count can have moved — `openSplit`, `closePane`
   * and `openSharedRoom` all already call `renderHead` on every pane for this kind of reason.
   */
  /**
   * The dot on the `files` button: is there anything in this session's files set this pane
   * has not looked at?
   *
   * A dot and not a number, and the choice is the maintainer's own words — "a small
   * indicator" — held up against what a number could honestly say. Three reasons it stays a
   * dot. The count the browser can compute is not the count the modal shows: this pane sees
   * only what arrived while it was watching, the modal scans the whole transcript, and a
   * badge reading `3` over one new row is the thing this repo refuses to do more reliably
   * than any other. A `Write` that overwrote a document lights it without adding a row
   * (`web/files-new.js` has the measurement), which a number would put a figure on and a
   * dot merely hints at. And the header is a flex row of 0.68rem uppercase mono ghost
   * buttons — a filled numeric pill in the middle of it would be the loudest thing in the
   * header, for the quietest fact in it.
   *
   * Appended and removed rather than hidden, the way the merge block is: a button with no
   * dot is byte-identical to the one that shipped before this existed, so nothing about
   * `files`' own metrics moved. The title changes with it, because the dot is 5px and a
   * reader who has noticed it deserves a sentence on hover rather than a guess.
   */
  function paintFilesBtn(btn = host.querySelector('.head-files')) {
    if (!btn) return;
    const on = view.kind === 'session' && view.filesNew === true;
    const dot = btn.querySelector('.head-files-dot');
    if (on && !dot) {
      const d = document.createElement('span');
      d.className = 'head-files-dot';
      // Named for a screen reader, since a bare dot says nothing to one. `role="status"`
      // is deliberately *not* set: this node is built at the moment the fact becomes true,
      // so a live region would announce it the instant a tool wrote a file — an
      // interruption for something whose whole register is "quiet, and here when you look".
      d.setAttribute('aria-label', 'new since you last looked');
      btn.append(d);
    } else if (!on && dot) {
      dot.remove();
    }
    btn.title = on
      ? 'Something new since you last looked — every file and link this session produced'
      : 'Every file and link this session produced — the whole transcript';
  }

  function syncSplitBtn(btn = host.querySelector('.split-toggle'), s = current()) {
    if (!btn) return;
    btn.disabled = false;
    if (panes.length > 1) {
      btn.hidden = false;
      btn.textContent = 'close';
      btn.title = 'Close this pane (⌘\\)';
      btn.onclick = () => closePane(slot);
      return;
    }
    btn.textContent = 'split';
    if (s?.isLead) {
      // A lead's pane is already two frames — the room owns the right half, and a third
      // column would leave nothing readable. Decided in the spec, not a limitation — and
      // a control nobody can press should not be drawn at all, so it is hidden rather
      // than disabled. Cleared in the other two branches, since this button is reused
      // across repaints rather than rebuilt.
      btn.hidden = true;
      btn.onclick = null;
      return;
    }
    btn.hidden = false;
    btn.title = 'Open a second session beside this one (⌘\\)';
    btn.onclick = () => openSplit(); // never the click event — it now takes options
  }

  /** Redraw the header's forge link now that the team config has an answer. */
  function paintForge() {
    const s = current();
    if (s) syncForgeLink(host.querySelector('.main-head'), s);
  }

  /**
   * The anchor itself. Opens in a new tab — the panel is a thing you leave running, and
   * navigating it away would drop every subscription in both panes.
   */
  function forgeLink(url, reading) {
    const a = document.createElement('a');
    a.className = 'head-forge';
    a.href = url;
    a.dataset.url = url; // what `syncForgeLink` compares, so a repaint is a no-op
    a.target = '_blank';
    a.rel = 'noopener';
    // `owner/repo` off the link's own path rather than a second field from the server:
    // one source for the address means the hover can never name a different repository
    // from the one the click opens.
    let where = url;
    try {
      where = new URL(url).pathname.replace(/^\/+/, '') || url;
    } catch {
      /* the server built this string; if it is unparseable the whole URL is the honest label */
    }
    a.title = `${where} on ${reading}`;
    a.setAttribute('aria-label', `Open ${where} on ${reading}`);
    // The mark itself — `web/forge-mark.js`, shared with the phone's Leads-tab card, so
    // both surfaces draw the exact same octicon or git-graph glyph.
    a.insertAdjacentHTML('beforeend', forgeMarkupFor(reading));
    return a;
  }

  /**
   * Add or drop the attach button to match what tmux says right now.
   *
   * Needed because `renderHead` patches the header rather than rebuilding it — the dot, the
   * title, the status and the pin are all written in place, and everything else in that row
   * is the same button it was when the session was selected. That is fine for four controls
   * whose *presence* never changes, and wrong for one whose whole point is that it comes and
   * goes: without this, attaching left the button sitting there until you clicked away and
   * back, and closing a window left a session with no way to get one.
   *
   * It goes in before the folder button so the pair keeps its order on a re-add — found by
   * query rather than passed in, because a reference node that isn't a child of `meta` yet
   * makes `insertBefore` throw, and a throw here empties the whole rail. That is not a
   * hypothetical: it is how this function shipped the first time. The `parentNode` check is
   * the belt to that braces.
   */
  function syncAttach(meta, s) {
    if (!meta) return;
    const existing = meta.querySelector('.attach-btn');
    const wanted = Boolean(s.tmuxSession) && !s.attached;
    if (wanted === Boolean(existing)) return;
    if (!wanted) return existing.remove();
    const before = meta.querySelector('.icon-btn:not(.attach-btn)');
    meta.insertBefore(attachBtn(s), before?.parentNode === meta ? before : null);
  }

  /**
   * Open a Terminal window on this session, on the Mac the server runs on.
   *
   * Only drawn while nothing is attached, so it is a statement as much as a control: this
   * session has no window anywhere, and here is one. Drawn rather than labelled to sit
   * beside the folder — both are about somewhere other than this panel.
   *
   * The title says what attaching costs, because nothing on screen would: the pane resizes
   * to whatever window Terminal opens, and every parser in `server/` reads a pane by its
   * wrapped lines. A 100-column window is a real change to what the panel sees, arriving
   * from a button that looks like it only opens a window.
   */
  function attachBtn(s) {
    const btn = document.createElement('button');
    btn.className = 'ghost-btn icon-btn attach-btn';
    const name = s.label || s.tmuxSession;
    btn.title = `Open a Terminal on ${name} — the pane resizes to fit the window`;
    btn.setAttribute('aria-label', `Open a Terminal on ${name}`);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 14 12');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');

    // A window with a prompt in it: outlined like the folder beside it, for the same
    // reason — a filled 12px glyph next to text buttons reads as a smudge.
    const frame = document.createElementNS(SVG_NS, 'rect');
    frame.setAttribute('x', '0.9');
    frame.setAttribute('y', '1.1');
    frame.setAttribute('width', '12.2');
    frame.setAttribute('height', '9.8');
    frame.setAttribute('rx', '1.4');
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', 'currentColor');
    frame.setAttribute('stroke-width', '1.1');

    const caret = document.createElementNS(SVG_NS, 'path');
    caret.setAttribute('d', 'M3.6 4.4 L5.6 6 L3.6 7.6');
    caret.setAttribute('fill', 'none');
    caret.setAttribute('stroke', 'currentColor');
    caret.setAttribute('stroke-width', '1.1');
    caret.setAttribute('stroke-linecap', 'round');
    caret.setAttribute('stroke-linejoin', 'round');

    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', 'M7.2 7.8 H10.4');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.1');
    line.setAttribute('stroke-linecap', 'round');

    svg.append(frame, caret, line);
    btn.append(svg);

    if (attaching.has(s.id)) {
      btn.disabled = true;
      btn.classList.add('is-busy');
    }

    btn.onclick = async () => {
      if (attaching.has(s.id)) return;
      attaching.add(s.id);
      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/terminal`, {});
        // No re-render here: the next roster poll sees `attached` and drops the button.
      } catch (err) {
        btn.title = err.message;
        btn.classList.add('is-error');
        btn.disabled = false;
      } finally {
        attaching.delete(s.id);
      }
    };
    return btn;
  }

  /**
   * Show the session's folder in Finder, on the Mac the server runs on.
   *
   * Drawn rather than labelled, because the other four controls in this header are verbs
   * about the session and this one is about somewhere else — a folder reads as a place at
   * a glance, where a fifth word would just lengthen the row. The `folder` it opens is the
   * pane's launch directory, the same one the rail heading is named after, not wherever
   * the conversation has since wandered.
   */
  function revealBtn(s) {
    const btn = document.createElement('button');
    btn.className = 'ghost-btn icon-btn';
    const folder = s.paneCwd.split('/').filter(Boolean).at(-1) || s.paneCwd;
    btn.title = `Show ${folder} in Finder`;
    btn.setAttribute('aria-label', `Show ${folder} in Finder`);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 14 12');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');

    // One path: the tab along the top-left, then the body. Outlined rather than filled —
    // a solid 12px folder next to four text buttons reads as a blob, not an icon.
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute(
      'd',
      'M1.2 10.2 V2.3 a0.8 0.8 0 0 1 0.8-0.8 h3.1 l1.3 1.5 h5.6 a0.8 0.8 0 0 1 0.8 0.8 V10.2 a0.8 0.8 0 0 1-0.8 0.8 H2 a0.8 0.8 0 0 1-0.8-0.8 Z',
    );
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.1');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.append(shape);
    btn.append(svg);

    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/reveal`, {});
      } catch (err) {
        btn.title = err.message;
      } finally {
        btn.disabled = false;
      }
    };
    return btn;
  }

  /** Fills the header's status line. Built from elements, so ctx% can carry its tone. */
  function renderHeadStatus(el, s) {
    const parts = [];
    // Ahead of everything else it might say: whether this session stops to ask is the
    // thing you want to know before you type into it, not after.
    if (s.bypass) {
      const b = text('bypass permissions', 'head-bypass');
      b.title = 'Started with --dangerously-skip-permissions — it edits and runs without asking';
      parts.push(b);
    }
    // What it's doing lives down by the composer now, next to the mode picker — beside the
    // box you'd type into, which is the only place the answer changes what you do next.
    // While a dialog owns the terminal there is no footer to read a model out of, so this
    // is the only thing the header can honestly say about the session.
    if (s.status === 'dialog') parts.push(text(`${s.dialog || 'dialog'} open`, 'head-dialog'));
    if (s.model) parts.push(text(shortModel(s.model)));
    if (s.contextPct != null) {
      const wrap = document.createElement('span');
      wrap.append(text('ctx '), ctxEl(s.contextPct));
      parts.push(wrap);
    }
    if (s.effort) parts.push(effortEl(s.effort));


    el.replaceChildren();
    parts.forEach((p, i) => {
      if (i) el.append(text(' · ', 'sep'));
      el.append(p);
    });
  }

  function text(value, cls) {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = value;
    return el;
  }

  /**
   * Rebuild the composer when any of this changes. The prompt's options are part of the
   * signature so a *different* prompt never reuses the previous card's buttons.
   */
  const composerSig = (s) =>
    [
      s.interactive,
      s.mode,
      s.status === 'needs-decision',
      s.prompt ? s.prompt.options.map((o) => `${o.index}:${o.label}`).join('~') : '',
      // A question that changed is a different question. Rebuilding is the point: the
      // ticks you made belong to the box that was on screen, not this one.
      s.question
        ? `${s.question.kind}:${s.question.question}:${s.question.options.map((o) => `${o.index}${o.checked ? '✓' : ''}`).join('')}`
        : '',
      // Same reasoning for the plan box, and it matters more here: its options are built
      // fresh at every render, so a changed list means the numbers behind those buttons
      // have moved.
      s.plan ? `${s.plan.header}:${s.plan.options.map((o) => `${o.index}:${o.label}`).join('~')}` : '',
    ].join('|');
  let lastComposerSig = null;

  function renderHead() {
    // The roster beat, and a link pane's only clock. The record moves under it — a label
    // edited, `lastAt` advancing when either lead speaks — so the head repaints from it and
    // the thread refetches when, and only when, `lastAt` says there is something new.
    // Peer messages has **nothing** on this beat, which is why the branch is a bare return
    // rather than an absence. Its head says how much is in the log and from how many
    // sessions — neither a fact about the roster — so it repaints with the list; and since
    // the `@` composer was retired there is no reach line and no open picker to keep in
    // step with who is live. The guard is explicit because falling through would put a
    // pane with no session behind it into the session path below, which is safe only for
    // as long as `openShared` goes on nulling `view.selected`.
    if (view.kind === 'shared') return;

    /*
     * A room's head is the one that has real work on this beat. The record moves under the
     * pane — a rename, a member added or removed, an archive, from here or from another
     * browser — and every member's **status dot** is a fact about the roster by definition.
     * `renderGroupStrip` rebuilds only when the membership itself changed and patches the
     * dots otherwise, which is what keeps an armed `remove` question from being taken away
     * by a status flicker two seconds later.
     */
    if (view.kind === 'group-room') {
      renderGroupHead();
      renderGroupStrip();
      // …and the folded strip's own three facts, which are roster facts too — the name off
      // the record, a dot per member, and the server's unseen count. Cheap while the room is
      // open: a textContent, a handful of class names and a `hidden` flag on nodes nobody can
      // see. Here rather than in `composerSig`, for the rule one function down.
      renderGroupFoldStrip();
      return;
    }

    const s = current();
    if (!s || !host.firstChild) return;

    const head = host.querySelector('.main-head');
    if (head) {
      head.querySelector('.dot').className = `dot ${s.status}`;
      head.querySelector('h1').textContent = s.title;
      renderHeadStatus(head.querySelector('.head-status'), s);
      paintPinBtn(head.querySelector('.pin-toggle'), s);
      // The two controls here that appear and disappear on their own, so they are the
      // only ones this patch-in-place path has to add or remove rather than just repaint.
      syncAttach(head.querySelector('.head-meta'), s);
      syncForgeLink(head, s);
      // …and the one that stays put and changes what it *does*, because the split can be
      // opened or closed without this header ever being rebuilt.
      syncSplitBtn(head.querySelector('.split-toggle'), s);
      // …and the files button's dot, on this beat for `renderMergeQueue`'s reason and
      // never in `composerSig`: a document landing must not rebuild the textarea under
      // whoever is typing. `appendMessages` paints it the moment it becomes true, so this
      // is the repaint that keeps it honest rather than the one that first draws it — it
      // is also what puts the dot back after anything rebuilds this header.
      paintFilesBtn(head.querySelector('.head-files'));
    }

    // The task list rides the roster beat: renderHead is what every `sessions` frame
    // calls per pane, and refreshTasks holds its own floor so this stays cheap.
    //
    // The merge queue rides the same beat, and deliberately not `composerSig`: the
    // signature is built from `interactive`, `mode`, the prompt/question/plan options and
    // nothing else, so a merge block filled inside `buildComposer` would freeze on
    // whatever the task list said at the last *prompt* change — possibly for hours. And
    // adding tasks to the signature is the other half of the same trap: the composer is
    // torn down and rebuilt when it changes, so a worker reporting done would take the
    // textarea out from under whoever was typing.
    if (roomView.repo) {
      refreshTasks();
      refreshMerge();
      // The folded strip's counts ride the same beat and for the same reason: they come off
      // `s.team`, which is a roster fact, and they must not join `composerSig` — a task
      // reaching `review` would otherwise tear the textarea down under whoever is typing.
      // It is cheap when the aside is open: three `hidden` flags on nodes nobody can see.
      renderAsideStrip();
    }

    const sig = composerSig(s);
    const old = host.querySelector('.composer');
    if (old && sig !== lastComposerSig) {
      // Stash before tearing down; the rebuilt composer restores from the same place.
      saveDraft(s.id);
      old.replaceWith(buildComposer(s));
      composerEl.autoGrow();
    } else {
      renderQueue();
      renderGhostLine();
      updateComposerHint();
    }
    lastComposerSig = sig;
  }

  /* ------------------------------------------------------------ stream --- */

  /** Consecutive sidechain messages collapse into one subagent block. */
  function groupMessages(messages) {
    const out = [];
    let run = null;
    for (const m of messages) {
      if (m.kind === 'title') continue;
      if (m.kind === 'thinking' && !state.showThinking) continue;
      if (m.sidechain) {
        if (!run) {
          run = { kind: 'subagent', items: [] };
          out.push(run);
        }
        run.items.push(m);
      } else {
        run = null;
        out.push(m);
      }
    }
    return out;
  }

  /* ------------------------------------------------------- path links --- */

  /*
   * A path in the conversation, drawn as something you can act on — and the bound that
   * makes that safe.
   *
   * The ruling: a path becomes a link **only** when it names one of this session's own
   * human-facing outputs, or a folder that is the parent directory of one. Paths to code
   * files, to a repo's own docs the session merely read, to anything outside that set,
   * stay plain text. There is no "looks like a path, so link it" anywhere in here — the
   * detector (`web/path-links.js`) answers *shape* and this answers *scope*, off a list
   * the server minted.
   *
   * Three things about the walk, each of which the plan measured before asking for it:
   *
   *   **It walks text nodes, including inline `code`, and skips `pre` and `a`.** The
   *   ruling of 2026-09-11 and the reason it went that way are on `PATH_SKIP` below:
   *   backticks are where a path is most often written and the output-set bound, not the
   *   formatting, is what keeps a source path out. A fenced block stays out because it is
   *   content rather than a mention. Skipping `a` is a different kind of reason — it is
   *   what makes a second walk over an already-linked bubble do nothing at all, since the
   *   link is an `<a>` and its own text is invisible to the next pass. That is the whole
   *   of the idempotency guard; there is no flag on the node, which is what keeps a
   *   re-walk after the output set grows correct rather than merely safe.
   *
   *   **It runs on two prose registers and nothing else** — `.msg-assistant` (the parsed
   *   markdown) and `.msg-user` (a `textContent` div). One helper over both, because the
   *   walk is on live text nodes and never on a string: assistant prose is HTML before
   *   anything can touch it and user prose never is, and one "linkify the text" helper
   *   applied to both would double-escape one or inject into the other. A chip's *output*
   *   is deliberately not a register here — that is command output, not prose.
   *
   *   **Nothing about it joins `composerSig`.** It paints inside the transcript, on the
   *   message beat and on the output set's own arrival; a file landing must never rebuild
   *   the textarea under a reader's cursor (`renderMergeQueue`'s rule, §7 rule 6).
   */

  /** The base a relative path in this session's prose is resolved against. */
  function pathBase() {
    const s = current();
    return s?.cwd || s?.paneCwd || null;
  }

  /**
   * Elements whose text is never walked — and note which one is **not** here.
   *
   * `PRE` is skipped: a fenced block is *content* the session is showing you, not a
   * mention, and a path inside one is part of a file being quoted rather than a thing
   * being named. `CODE` is **walked**, by the 2026-09-11 ruling, and the reasoning is
   * worth keeping because the plan originally said the opposite.
   *
   * §5.2 asked for `code` to be skipped because that is where nearly every *source* path
   * lives — 2,599 of 5,328 path-shaped tokens sit inside backticks — and at the time the
   * skip was the only thing keeping `web/app.js` and `server/index.js` out of the
   * conversation. It is not any more: the output-set bound does that job, and does it
   * better, because it refuses a source path wherever it appears rather than only where it
   * is formatted. What the skip was costing, once the bound existed, was the case a reader
   * actually wants — Claude writes a path in backticks far more often than not, so the one
   * register where a mention is most legible was the one register that could not link.
   *
   * So: a code span naming one of this session's own outputs links; anything else in a
   * code span stays exactly as it was, which is what it was before this module existed.
   * `A` is skipped for the separate reason that it is the whole of the walk's idempotency,
   * and a `CODE` inside a `PRE` is still skipped — the check walks ancestors, not the
   * node's own tag.
   */
  const PATH_SKIP = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SVG']);

  /** The two registers a path link may be drawn in. */
  const PATH_HOSTS = '.msg-assistant, .msg-user';

  /**
   * The anchor itself: the panel's link colour, a dotted underline so it reads as
   * something that happens *here* rather than something that leaves, and the action it
   * can answer.
   *
   * It carries **no `href`**, on purpose. There is nowhere to navigate — a file opens the
   * preview overlay in place and a folder posts to the server — and an `href` would give
   * a middle click a destination the panel cannot honour. `role="link"` plus `tabindex`
   * is what keeps it reachable without one.
   */
  function pathAnchor(hit, sessionId) {
    const a = document.createElement('a');
    a.className = `path-link is-${hit.kind}`;
    a.textContent = hit.text;
    a.setAttribute('role', 'link');
    a.tabIndex = 0;
    a.title =
      hit.kind === 'file'
        ? `Preview ${hit.entry.path}`
        : `Show this folder in Finder (${hit.entry.path} is in it)`;
    const act = (e) => {
      // The chip summary is inside a `<button>` whose own click toggles the chip open, and
      // an assistant bubble may sit inside one too. Stopping here is what keeps a path
      // link from also doing the thing the element around it does.
      e.preventDefault();
      e.stopPropagation();
      if (hit.kind === 'file') openOutputPreview(sessionId, hit.entry);
      else revealOutputFolder(sessionId, hit.entry, a);
    };
    a.onclick = act;
    a.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') act(e);
    };
    return a;
  }

  /**
   * Replace every confirmed path in one element's text nodes with a link.
   *
   * Text nodes are collected before anything is mutated — a `TreeWalker` over a tree being
   * spliced underneath it is a walk with no defined answer — and each node is replaced by
   * a fragment of its own surviving text plus the anchors.
   */
  function linkPathsIn(el) {
    if (!el || view.kind !== 'session' || !view.outputs.length) return;
    const sessionId = view.selected;
    if (!sessionId) return;
    const cwd = pathBase();
    if (!cwd) return;

    const texts = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes('/')) return NodeFilter.FILTER_REJECT;
        for (let p = node.parentElement; p && p !== el.parentElement; p = p.parentElement) {
          if (PATH_SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walk.nextNode()) texts.push(walk.currentNode);

    for (const node of texts) {
      const text = node.nodeValue;
      const hits = pathLinksIn(text, view.outputs, cwd);
      if (!hits.length) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const hit of hits) {
        if (hit.start > at) frag.append(text.slice(at, hit.start));
        frag.append(pathAnchor(hit, sessionId));
        at = hit.end;
      }
      if (at < text.length) frag.append(text.slice(at));
      node.replaceWith(frag);
    }
  }

  /** …and over a node and every prose block inside it, which is what one message is. */
  function linkPathsInTree(node) {
    if (!node) return;
    if (node.nodeType === 1 && node.matches?.(PATH_HOSTS)) linkPathsIn(node);
    for (const el of node.querySelectorAll?.(PATH_HOSTS) || []) linkPathsIn(el);
  }

  /**
   * The `Write` / `SendUserFile` chip's own summary, linked — the higher-yield half.
   *
   * Every human-facing output this session made has a chip naming it, against roughly one
   * mention in prose for every five sessions, and the chip sits at the exact point in the
   * timeline where the file was made. So this is the site worth getting right.
   *
   * It does **not** run the detector over the summary text. `toolSummary` shortens a path
   * for the chip (`…/docs/notes.md`), so the string on screen is not a path at all — the
   * real one is on the message's own `input`, which is the honest witness and the one
   * `web/files-new.js` already asks. The link's *text* stays whatever the summary said;
   * only its behaviour is new.
   *
   * `SendUserFile` links only when it handed over exactly one file: with two, the summary
   * is a caption or a count and names no particular one of them, and a link on it would be
   * a guess about which. The resolved path is stamped on the node either way, so a later
   * pass — the output set arriving after the chip was drawn — can ask again without the
   * message.
   */
  function chipOutputPath(m) {
    const input = m?.input && typeof m.input === 'object' ? m.input : null;
    if (!input) return null;
    if (m.name === 'Write') return typeof input.file_path === 'string' ? input.file_path : null;
    if (m.name === 'SendUserFile') {
      const files = Array.isArray(input.files) ? input.files.filter((f) => typeof f === 'string') : [];
      return files.length === 1 ? files[0] : null;
    }
    return null;
  }

  function markChipPath(node, m) {
    const sum = node?.querySelector?.('.chip-summary');
    if (!sum || !sum.textContent) return;
    const raw = chipOutputPath(m);
    if (!raw) return;
    const abs = resolvePath(raw, pathBase());
    if (!abs) return;
    sum.dataset.path = abs;
    linkChipSummary(sum);
  }

  /** Draw the link on a summary already carrying a resolved path, if it is in the set. */
  function linkChipSummary(sum) {
    if (!sum?.dataset?.path || sum.querySelector('.path-link')) return;
    if (view.kind !== 'session' || !view.selected || !view.outputs.length) return;
    const entry = view.outputs.find((o) => o.path && resolvePath(o.path, null) === sum.dataset.path);
    if (!entry) return;
    const a = pathAnchor({ kind: 'file', entry, text: sum.textContent }, view.selected);
    a.classList.add('path-link-chip');
    sum.replaceChildren(a);
  }

  /** Walk everything on screen again — the output set has grown. */
  function relinkPaths() {
    if (!streamEl || view.kind !== 'session') return;
    for (const el of streamEl.inner.querySelectorAll(PATH_HOSTS)) linkPathsIn(el);
    for (const sum of streamEl.inner.querySelectorAll('.chip-summary[data-path]')) linkChipSummary(sum);
  }

  /**
   * Ask the server what this session has produced, then relink what is already drawn.
   *
   * The same endpoint the files modal opens on, and for the same reason it exists: the
   * panel only ever holds a *window* of a transcript, so a set built from `view.messages`
   * would be a subset and would look complete. A failure is silent — no links is exactly
   * what the panel drew before this feature, and a banner over a garnish would be worse
   * than the garnish being missing.
   */
  async function refreshOutputs() {
    if (view.kind !== 'session' || !view.selected) return;
    if (view.outputsBusy) {
      view.outputsAgain = true;
      return;
    }
    view.outputsBusy = true;
    const mine = view.outputsSeq;
    const id = view.selected;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/outputs`);
      if (!res.ok) return;
      const data = await res.json();
      if (mine !== view.outputsSeq || view.selected !== id) return;
      view.outputs = Array.isArray(data.outputs) ? data.outputs.filter((o) => o && o.path) : [];
      relinkPaths();
    } catch {
      // Offline, or the session went away between the roster and the fetch.
    } finally {
      view.outputsBusy = false;
      if (view.outputsAgain) {
        view.outputsAgain = false;
        refreshOutputs();
      }
    }
  }

  /**
   * A file link's click: the same preview overlay a cell in the files modal opens.
   *
   * The **whole** output set goes over, unfiltered, which is the one thing this caller has
   * to get right — the overlay's arrow keys walk what it was handed, and handing it one
   * entry would make a link a dead end where a cell is a way in. `outputSrcFor` rather
   * than the overlay's default, for the modal's own reason: these are outputs, and a
   * `SendUserFile` screenshot is not an image *block*, so it has no address under
   * `/image/:uuid/:index` at all.
   */
  function openOutputPreview(sessionId, entry) {
    const at = view.outputs.indexOf(entry);
    openLightbox(sessionId, view.outputs, at < 0 ? 0 : at, { src: (id, item) => outputSrcFor(id, item) });
  }

  /**
   * A folder link's click: Finder, selecting the folder — and **no path in the body**.
   *
   * It posts the `{uuid, index}` of the output that folder holds, and the server does the
   * `dirname` off its own re-read of this session's transcript (`revealableFolder`). That
   * is the same bound the file reveal keeps, and the reason it is kept here too is that a
   * folder body would be the first path parameter in the feature — precisely the prior art
   * the plan measured and refused.
   *
   * A refusal flashes on the link itself rather than anywhere else: the reader's attention
   * is on the word they just clicked, and the usual answer is that the file has been
   * deleted since the session wrote it.
   */
  async function revealOutputFolder(sessionId, entry, el) {
    const was = el.textContent;
    try {
      await postJSON(`/api/sessions/${encodeURIComponent(sessionId)}/output/reveal-folder`, {
        uuid: entry.uuid,
        index: entry.index,
      });
    } catch (err) {
      el.textContent = err.message;
      el.classList.add('is-refused');
      setTimeout(() => {
        if (!el.isConnected) return;
        el.textContent = was;
        el.classList.remove('is-refused');
      }, 1800);
    }
  }

  function renderStream() {
    // `renderAllStreams` fires this on every pane when the thinking toggle flips. Neither a
    // thread nor the shared room has a transcript to redraw, or a live `streamEl` to redraw
    // it into — the node the last session left behind is detached, and writing into it is
    // a paint nobody sees rather than an error, which is the sort of thing that survives
    // until it doesn't.
    if (view.kind !== 'session') return;
    if (!streamEl) return;
    chipNodes.clear();
    const frag = document.createDocumentFragment();

    if (view.error) {
      const p = document.createElement('div');
      p.className = 'composer-hint err';
      p.textContent = view.error;
      frag.append(p);
    }

    if (view.hasEarlier) {
      const btn = document.createElement('button');
      btn.className = 'load-earlier';
      btn.textContent = 'load earlier';
      btn.onclick = () => {
        btn.textContent = 'loading…';
        send({ type: 'loadEarlier' });
      };
      frag.append(btn);
    }

    for (const m of groupMessages(view.messages)) frag.append(renderMessage(m));

    if (!view.messages.length && !view.error) {
      const s = current();
      if (s?.binding === 'pane-only' && s.paneOnlyReason === 'ambiguous') {
        frag.append(
          emptyState(
            "Can't tell which history is this one's",
            `Other sessions in ${s.project} write under the same name, so the panel won't guess and risk showing you someone else's conversation. Restarting this session is what fixes it for good — it will name itself uniquely from then on. You can type to it either way.`,
          ),
        );
      } else if (s?.binding === 'pane-only') {
        frag.append(
          emptyState(
            'Nothing said yet',
            'This session has no history yet. Send it a message and the conversation appears here.',
          ),
        );
      } else {
        frag.append(emptyState('Nothing yet', 'This transcript has no messages in the loaded window.'));
      }
    }

    streamEl.inner.replaceChildren(frag);
  }

  function appendMessages(messages) {
    view.messages.push(...messages);

    /*
     * The files button's dot, before anything about *drawing* is decided — and that order
     * is the point. What lands in the modal has nothing to do with what this pane shows: a
     * thinking block is filtered below when the toggle is off, a `tool_result` returns
     * early to patch its chip in place, and a pane with no `streamEl` returns earlier
     * still. Counted down there, a screenshot inside a result would never light the button.
     *
     * Painted here as well as on the roster beat. `renderHead` is the canonical beat and
     * keeps the dot honest after any repaint that rebuilds the header — but a `messages`
     * frame arrives on its own clock, and waiting a poll to show a dot that is already
     * true is a needless lag. One function does both, and it is nowhere near
     * `composerSig`: a file landing must never tear the textarea down under a reader's
     * cursor (`renderMergeQueue`'s rule, and the plan's §7 rule 6).
     */
    if (anyNewOutput(messages)) {
      if (!view.filesNew) {
        view.filesNew = true;
        paintFilesBtn();
      }
      // The same signal, reused rather than polled: a path link is bounded to this
      // session's output set, so the set has to be re-asked when something lands in it —
      // and this is already the one predicate that knows. A file written this turn is
      // linkable in the next sentence Claude writes about it.
      refreshOutputs();
    }

    if (!streamEl) return;

    const stick = isNearBottom();
    const fresh = [];

    for (const m of messages) {
      // A result whose chip is already on screen updates it in place.
      if (m.kind === 'tool_result' && chipNodes.has(m.toolUseId)) {
        const node = chipNodes.get(m.toolUseId);
        applyResult(node, { isError: m.isError, output: m.output, diff: m.diff, images: m.images });
        /*
         * …and this is the moment a write actually becomes an output, which is a beat
         * later than the moment the dot fires. `anyNewOutput` answers on the tool *call*
         * — right for a dot, which is a boolean — while `scanOutputs` needs the
         * `toolUseResult` record, and that is not in the transcript until the result
         * lands. Measured on the bench: the refresh fired on the `Write` frame, the scan
         * came back without the file, and the sentence naming it a second later was drawn
         * against a set that did not have it yet. Nothing re-asked, and the path stayed
         * plain until the pane was reopened.
         *
         * So: a chip carrying a resolved path that is still unlinked is exactly the
         * question "has this become an output yet", asked at the only moment the answer
         * can have changed. It cannot loop — a refresh that finds nothing leaves the chip
         * unlinked and nothing re-triggers until the next result — and a `Write` outside
         * the human-facing set simply never links, which is the correct answer.
         */
        const pending = node.querySelector?.('.chip-summary[data-path]');
        if (pending && !pending.querySelector('.path-link')) refreshOutputs();
        continue;
      }
      if (m.kind === 'title') {
        continue;
      }
      if (m.kind === 'thinking' && !state.showThinking) continue;
      fresh.push(m);
    }

    for (const m of fresh) streamEl.inner.append(renderMessage(m));
    if (stick) {
      scrollToBottom();
      markReadIfCaughtUp();
    }
  }

  /**
   * One normalized message as a node — and the one place a path link is ever drawn on a
   * message as it arrives.
   *
   * The link pass is here rather than inside each branch so that every register gets it on
   * the same terms and none can be missed when a branch is added: a `.msg-assistant` built
   * for a chip's markdown body or for a subagent's `returned` block is prose in exactly the
   * sense the two obvious ones are. The chip summary is the one thing asked for by name,
   * because its link comes off the message's `input` rather than off the text on screen.
   */
  function renderMessage(m) {
    const node = buildMessage(m);
    linkPathsInTree(node);
    if (m?.kind === 'tool_use') markChipPath(node, m);
    return node;
  }

  function buildMessage(m) {
    switch (m.kind) {
      // A pasted screenshot arrives on the user's own record, beside the text — and a
      // message that was *only* an image used to be dropped in `normalize.js` and never
      // reached here at all. Hence the fragment: text, images, or both.
      case 'user': {
        const frag = document.createDocumentFragment();
        if (m.text) {
          const div = document.createElement('div');
          div.className = 'msg-user';
          div.textContent = m.text;
          frag.append(div);
        }
        if (m.images?.length) frag.append(imageStrip(m.images));
        return frag;
      }
      case 'assistant': {
        const div = document.createElement('div');
        div.className = 'msg-assistant';
        div.innerHTML = withBlankTargets(marked.parse(m.text || ''));
        return div;
      }
      case 'command': {
        const div = document.createElement('div');
        div.className = 'msg-command';
        div.textContent = `/${m.name}${m.args ? ` ${m.args}` : ''}`;
        return div;
      }
      // The panel's [room] nudge to a lead — an event line, not something the maintainer
      // typed, so it must not wear the user bubble it used to.
      case 'nudge': {
        const div = document.createElement('div');
        div.className = 'msg-nudge';
        div.textContent = m.text;
        return div;
      }
      /*
       * Another project's lead, delivered down a link and typed into this session by the
       * panel. **Links were retired on 2026-09-05 and nothing writes one of these any
       * more** — this case draws the `[link] ` records already sitting in transcripts on
       * this Mac, which is why `LINK_MARK` outlived the module that owned it
       * (`normalize.js`). Same register as the nudge above and for a sharper reason: drawn
       * as a user bubble it would be **another project's lead speaking in the maintainer's
       * voice**, which is the exact failure that feature was designed around. It is the
       * `task-notification` bug one more time, and the third time this repo has learned it.
       *
       * The contrast that makes the register load-bearing: the merge line
       * (`Merge PR #N — …pressed the merge button…`) carries no prefix and *does* draw as a
       * user bubble, deliberately, because it is the maintainer's own word.
       *
       * The text is drawn whole and never parsed. The envelope — who it is from, that it is
       * a request and not an instruction, the `> ` on every body line — was composed
       * server-side, by the module these records outlived, and *is* the message; a client
       * that picked it apart to restyle the halves would be a second spelling of the one
       * sentence that says which of the two speakers this is. The same holds for the room
       * deliveries that replaced them, composed in `server/rooms-line.js`. `white-space: pre-wrap` is what keeps the quoting
       * lined up, and the quoting is the whole of the injection defence.
       */
      case 'link_message': {
        const div = document.createElement('div');
        div.className = 'msg-link';
        div.textContent = m.text;
        return div;
      }
      /*
       * Another Claude session, talking to this one. Claude Code delivers a peer message
       * as a `user` turn in the recipient's transcript, so without this case it is the
       * `task-notification` bug for the fourth time in this file — a whole message from
       * somewhere else, in the maintainer's own bubble, with nothing saying it came from
       * another session.
       *
       * A quiet `← name` line above the body rather than a chip: this is the *cause* of
       * whatever the session says next, and a reply whose cause is folded shut reads as
       * the session talking to itself. The body is `origin.body`, composed server-side —
       * the ~600 characters of peer-safety boilerplate that Claude Code wraps around it
       * never left `normalize.js`, deliberately.
       *
       * The text is drawn whole and never parsed, `pre-wrap` for the same reason the link
       * message above keeps its whitespace. `m.reply` (the sender's `hopChain`) is
       * deliberately not drawn: the room is where a thread reads as a thread, and one more
       * word on this line would be a second, quieter place to read one.
       */
      case 'peer_message': {
        const div = document.createElement('div');
        div.className = 'msg-peer';
        const who = document.createElement('div');
        who.className = 'msg-peer-from';
        // `from` is null only if a sender ever arrives unnamed — never measured, since
        // Claude Code derives a name for a session launched without one.
        who.textContent = `\u2190 ${m.from || 'another session'}`;
        const body = document.createElement('div');
        body.className = 'msg-peer-body';
        body.textContent = m.text || '';
        div.append(who, body);
        return div;
      }
      // A subagent, background command or monitor reporting back. Claude Code injects it
      // as a user turn and the terminal never shows it, so a chip is the honest register:
      // the summary is self-describing (`Agent "…" finished`, `Background command "…"
      // completed`), which is why the label says only what kind of line this is. The
      // report itself is prose, so it opens as markdown rather than as `chip-out`'s mono.
      case 'task_notification':
        return renderChip({
          name: 'notice',
          summary: m.summary,
          body: m.text,
          markdown: true,
        });
      /*
       * A group-room post, typed into this session's composer by the panel. The fifth time
       * this file has met the `task-notification` shape: a whole message from somewhere
       * else, arriving as a `user` record, which drawn as a bubble is another session
       * speaking in the maintainer's voice. Here it was also the *tallest* — a delivery is
       * often several paragraphs and lands once a turn — which is what the maintainer's
       * ruling of 2026-09-05 was actually about.
       *
       * So: the notice chip's register exactly. One muted line — who spoke, which room,
       * and the post's own first line, ellipsised by `.chip-summary` — plus a `to you` /
       * `to beta-main` mark when the post named somebody, which is the one thing a reader
       * cannot get from the body.
       *
       * **It opens on `m.raw`, the delivery exactly as it arrived**, not on the stripped
       * body beside it. The `> ` / `| ` prefixes are the whole of the trust model and they
       * are composed server-side; a client that redrew the body without them, or restyled
       * the two speakers itself, would be a second spelling of the one distinction this
       * panel refuses to spell twice. `chip-out` is mono and `pre-wrap`, which is what
       * keeps the quoting lined up — the same reason `msg-link` has it.
       */
      case 'group_message':
        return renderChip({
          name: 'room',
          summary: `${m.from} in "${m.room}" · ${firstLine(m.text)}`,
          mark: m.to ? `to ${m.to}` : '',
          body: m.raw,
        });
      // What the command printed back. Sits under its `/model` or `/exit` chip and is
      // styled off it, because that is what it is — the reply, not a turn of its own.
      case 'command_output': {
        const div = document.createElement('div');
        div.className = 'msg-command is-output';
        div.textContent = m.text;
        return div;
      }
      case 'thinking':
        return renderChip({ name: 'thinking', summary: firstLine(m.text), body: m.text, muted: true });
      case 'tool_use': {
        const node = renderChip({
          name: m.name,
          summary: m.summary,
          body: m.result?.output,
          isError: m.result?.isError,
          hasResult: Boolean(m.result),
          result: m.result,
          images: m.result?.images,
        });
        chipNodes.set(m.toolUseId, node);
        return node;
      }
      case 'tool_result':
        return renderChip({
          name: 'result',
          summary: firstLine(m.output),
          body: m.output,
          isError: m.isError,
          images: m.images,
        });
      case 'subagent': {
        const wrap = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'divider';
        label.textContent = `subagent · ${m.items.length} steps`;
        wrap.append(label);
        for (const item of m.items) wrap.append(renderMessage({ ...item, sidechain: false }));
        return wrap;
      }
      default: {
        return document.createComment('unhandled');
      }
    }
  }

  /**
   * The images a turn produced, as a row of thumbnails at the point in the timeline where
   * they landed — not folded inside the tool chip's body, which is collapsed by default
   * and is where a screenshot would go to be forgotten.
   *
   * The session is captured at build time rather than read at click time, and that is
   * correct here where it usually isn't: these nodes belong to one session's stream, and
   * selecting another rebuilds the stream from scratch.
   *
   * It scrolls sideways inside itself and never widens the transcript — `.stream-inner` is
   * 52rem at most and shrinks with the pane, and a strip of five screenshots at any pane
   * width has to stay inside that or the whole conversation starts scrolling horizontally.
   */
  function imageStrip(images) {
    const sessionId = view.selected;
    const strip = document.createElement('div');
    strip.className = 'img-strip';

    images.forEach((ref, i) => {
      const btn = document.createElement('button');
      btn.className = 'img-thumb';
      btn.setAttribute('aria-label', `Open image ${i + 1} of ${images.length}`);

      const img = document.createElement('img');
      // Eager, unlike the gallery. A strip holds one turn's images — one to three, and
      // only for the slice of transcript that is loaded — so deferring them buys nothing,
      // while the gallery can hold ninety (the most in any transcript on this Mac) and
      // needs `lazy` to be affordable at all.
      //
      // Not because lazy is broken: it defers until Chrome actually *renders* the page,
      // which an automated window does not do until something forces a frame, so a bench
      // reads back `complete: false` on thumbnails that are plainly on screen. Same family
      // as the `requestAnimationFrame` / `ResizeObserver` trap the room panel hit. Worth
      // knowing before you spend an hour chasing an empty strip that a screenshot fixes.
      img.src = imageSrc(sessionId, ref);
      img.alt = '';
      btn.append(img);

      btn.onclick = () => openLightbox(sessionId, images, i);
      strip.append(btn);
    });
    return strip;
  }

  function firstLine(text = '') {
    const line = String(text).trim().split('\n')[0];
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }

  /** `2.3s`, `1m 04s` — only worth showing once something actually took time. */
  function humanDuration(ms) {
    if (ms == null || ms < 1500) return '';
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  }

  function renderDiff(diff) {
    const el = document.createElement('div');
    el.className = 'diff';
    for (const line of diff.lines) {
      const row = document.createElement('div');
      row.className = `diff-line ${line.kind}`;
      row.textContent = `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`;
      el.append(row);
    }
    if (diff.truncated) {
      const more = document.createElement('div');
      more.className = 'diff-line gap';
      more.textContent = `⋯ diff truncated at ${diff.lines.length} lines`;
      el.append(more);
    }
    return el;
  }

  /**
   * A subagent run: what it was told, what it did, what it handed back.
   *
   * The agent keeps its own transcript in the same format as any session, so its steps
   * render through exactly the same code — tool chips, diffs and all. It's fetched on
   * first open rather than up front; these files run to hundreds of kilobytes.
   */
  function renderAgentRun(agent, finalText) {
    const el = document.createElement('div');
    el.className = 'agent-run';

    if (agent.prompt) {
      const details = document.createElement('details');
      details.className = 'agent-prompt';
      const summary = document.createElement('summary');
      summary.textContent = 'instructions';
      const body = document.createElement('div');
      body.textContent = agent.prompt;
      details.append(summary, body);
      el.append(details);
    }

    const steps = document.createElement('div');
    steps.className = 'agent-steps';
    el.append(steps);

    if (!agent.outputFile) {
      steps.append(note('This agent kept no separate transcript.'));
    } else {
      const load = document.createElement('button');
      load.className = 'agent-load';
      load.textContent = 'show what it did';
      load.onclick = async () => {
        load.disabled = true;
        load.textContent = 'loading…';
        try {
          const res = await fetch(`/api/agent-run?file=${encodeURIComponent(agent.outputFile)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
          load.remove();
          const inner = document.createElement('div');
          inner.className = 'agent-inner';
          // Its own steps, rendered by the same code that renders a session.
          for (const m of data.messages) {
            if (m.kind === 'title') continue;
            if (m.kind === 'thinking' && !state.showThinking) continue;
            inner.append(renderMessage(m));
          }
          if (!inner.childElementCount) inner.append(note('Nothing recorded.'));
          steps.append(inner);
        } catch (err) {
          load.disabled = false;
          load.textContent = 'show what it did';
          steps.append(note(err.message, 'err'));
        }
      };
      steps.append(load);
    }

    if (finalText?.trim()) {
      const ret = document.createElement('div');
      ret.className = 'agent-return';
      const label = document.createElement('div');
      label.className = 'agent-label';
      label.textContent = 'returned';
      const body = document.createElement('div');
      body.className = 'msg-assistant';
      body.innerHTML = withBlankTargets(marked.parse(finalText));
      ret.append(label, body);
      el.append(ret);
    }

    return el;
  }

  function note(text, kind = '') {
    const el = document.createElement('div');
    el.className = `agent-note${kind ? ` ${kind}` : ''}`;
    el.textContent = text;
    return el;
  }

  function renderChip({ name, summary, mark, body, isError, muted, hasResult, result, images, markdown }) {
    const wrap = document.createElement('div');
    if (muted) wrap.className = 'msg-thinking';

    const chip = document.createElement('button');
    chip.className = 'chip';

    const rule = document.createElement('span');
    rule.className = 'chip-rule';

    const nameEl = document.createElement('span');
    nameEl.className = 'chip-name';
    nameEl.textContent = name;

    const sum = document.createElement('span');
    sum.className = 'chip-summary';
    sum.textContent = summary || '';

    chip.append(rule, nameEl, sum);

    /*
     * One muted word after the summary, for a chip whose line has a fact that is not part
     * of what it summarises — today, only a room delivery's `to you` / `to beta-main`.
     * `flex: none` beside a `flex: 1` summary, so the summary is the half that ellipsises
     * and the mark never gets cut in the middle of a name.
     */
    if (mark) {
      const markEl = document.createElement('span');
      markEl.className = 'chip-mark';
      markEl.textContent = mark;
      chip.append(markEl);
    }

    // An edit says how much it changed without being opened.
    const diff = result?.diff;
    if (diff) {
      const stat = document.createElement('span');
      stat.className = 'chip-stat';
      const add = document.createElement('span');
      add.className = 'add';
      add.textContent = `+${diff.added}`;
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = `−${diff.removed}`;
      stat.append(add, del);
      chip.append(stat);
    }

    const took = humanDuration(result?.durationMs);
    if (took) {
      const dur = document.createElement('span');
      dur.className = 'chip-dur';
      dur.textContent = took;
      chip.append(dur);
    }

    const flag = document.createElement('span');
    flag.className = `chip-flag ${isError ? 'err' : 'ok'}`;
    flag.textContent = isError ? '✕' : result?.bash?.interrupted ? '⊘' : hasResult || body ? '·' : '';
    chip.append(flag);

    wrap.append(chip);

    const agent = result?.agent;
    if (agent?.model) {
      const model = document.createElement('span');
      model.className = 'chip-dur';
      model.textContent = shortModel(agent.model.replace(/^claude-/, '').replace(/-\d{8}$/, ''));
      chip.append(model);
    }

    const out = document.createElement('div');
    out.className = `chip-out${isError ? ' err' : ''}`;
    out.hidden = true;
    if (diff) out.append(renderDiff(diff));
    else if (agent) out.append(renderAgentRun(agent, body));
    // A report written for a human to read, not command output: the same treatment the
    // subagent's `returned` block already gets, one nesting level up.
    else if (markdown && body) {
      const prose = document.createElement('div');
      prose.className = 'msg-assistant';
      prose.innerHTML = withBlankTargets(marked.parse(body));
      out.append(prose);
    } else out.textContent = body || '';
    wrap.append(out);

    // A failure is the one thing you shouldn't have to click to discover.
    if (isError && !agent && out.textContent) out.hidden = false;

    // Below the body, not inside it: `out` is collapsed by default, and a screenshot the
    // session just took is the one part of a tool result worth seeing without a click.
    if (images?.length) wrap.append(imageStrip(images));

    chip.onclick = () => {
      if (!out.textContent && !diff && !agent) return;
      out.hidden = !out.hidden;
    };

    wrap._flag = flag;
    wrap._out = out;
    return wrap;
  }

  function applyResult(node, { isError, output, diff, images }) {
    if (!node?._out) return;
    // The chip was drawn when the call went out, before there was a result to have
    // images. This is the live path — without it a screenshot only appeared for readers
    // who arrived after the turn, and the session that took it showed nothing.
    if (images?.length && !node.querySelector('.img-strip')) node.append(imageStrip(images));
    node._out.replaceChildren();
    if (diff) node._out.append(renderDiff(diff));
    else node._out.textContent = output || '';
    node._out.className = `chip-out${isError ? ' err' : ''}`;
    node._flag.className = `chip-flag ${isError ? 'err' : 'ok'}`;
    node._flag.textContent = isError ? '✕' : '·';
    if (isError) node._out.hidden = false;
  }

  function isNearBottom() {
    if (!streamEl) return true;
    const { stream } = streamEl;
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  }

  /** The newest timestamp we've actually rendered. */
  function latestTs() {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      if (view.messages[i].ts) return view.messages[i].ts;
    }
    return null;
  }

  /**
   * Clear the badge only when the newest message is genuinely on screen. Scrolling
   * back through history is reading the past, not catching up on the present.
   */
  function markReadIfCaughtUp() {
    if (!view.selected || !streamEl) return;
    if (!isNearBottom()) return;
    const ts = latestTs();
    if (!ts || ts === view.lastMarked) return;
    view.lastMarked = ts;
    send({ type: 'markRead', sessionId: view.selected, ts });
  }

  function scrollToBottom() {
    if (!streamEl) return;
    requestAnimationFrame(() => {
      streamEl.stream.scrollTop = streamEl.stream.scrollHeight;
    });
  }

  /* ---------------------------------------------------------- composer --- */

  function buildComposer(s) {
    const wrap = document.createElement('div');
    wrap.className = 'composer';
    const inner = document.createElement('div');
    inner.className = 'composer-inner';
    wrap.append(inner);

    // Most specific first. All three of these read as `needs-decision`, and the order is
    // the lesson each one taught in turn: with the permission branch in front, a question
    // box fell through to "the prompt could not be read" while a perfectly parsed question
    // sat unused — and the plan approval did exactly the same thing one step further along.
    //
    // The trust gate goes ahead of all of them because it is the branch that *refuses*, and
    // a refusal reachable only after three other tests have declined is a refusal waiting
    // to be bypassed. On the measured captures it would arrive here anyway (`plan` and
    // `question` are both null on that screen — `test/pane.test.js`), so this is belt to
    // `buildDecisionBar`'s braces, which refuses again on its own account.
    if (isTrustGate(s.prompt) && s.interactive) {
      inner.append(buildTrustNotice(s.prompt));
    } else if (s.plan && s.interactive) {
      inner.append(buildPlanCard(s));
    } else if (s.question && s.interactive) {
      inner.append(buildQuestionCard(s));
    } else if (s.status === 'needs-decision' && s.interactive) {
      inner.append(buildDecisionBar(s));
    }

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = s.interactive
      ? 'Message this session — Enter to send, Shift+Enter for a new line'
      : 'Read-only: this session has no tmux pane to type into.';
    ta.disabled = !s.interactive;

    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 224)}px`;
    };

    ta.value = state.drafts[s.id] || '';

    ta.oninput = () => {
      autoGrow();
      saveDraft(s.id);
      updateCompletion();
      // Typing puts the line away, the way typing puts the terminal's own ghost text away.
      // It is also what makes "use" safe to press without thinking: the offer is only ever
      // on screen while there is nothing of yours for it to overwrite.
      renderGhostLine();
    };

    ta.onkeydown = (e) => {
      // The popup gets first refusal on Enter/Tab/arrows/Escape while it is open.
      if (completionKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };

    // Caret moves without an input event (arrows, clicks) can also change the token.
    ta.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateCompletion();
    });
    ta.addEventListener('blur', () => setTimeout(closeCompletion, 120));

    // Paste or drop an image, a `.txt` or a `.md` and the path lands in the message — the
    // same thing that happens when you drop a file onto the terminal. Pasted *text* never
    // comes through here: it carries no files, so this returns and the textarea keeps it.
    ta.addEventListener('paste', (e) => {
      const files = attachableFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      attachFiles(files, s.id);
    });

    for (const type of ['dragenter', 'dragover']) {
      wrap.addEventListener(type, (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        wrap.classList.add('dropping');
      });
    }
    for (const type of ['dragleave', 'dragend']) {
      wrap.addEventListener(type, (e) => {
        if (e.target === wrap || !wrap.contains(e.relatedTarget)) wrap.classList.remove('dropping');
      });
    }
    wrap.addEventListener('drop', (e) => {
      wrap.classList.remove('dropping');
      const files = attachableFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      attachFiles(files, s.id);
    });

    // Waiting messages sit above the box, in the order they'll go. Kept out of the
    // composer's signature so a queue that changes while you type never rebuilds the
    // textarea under your cursor.
    const queue = document.createElement('div');
    queue.className = 'queue';
    queue.hidden = true;

    const strip = document.createElement('div');
    strip.className = 'attach-strip';
    strip.hidden = true;

    /*
     * Interrupt rides above the box; send stays below it. Deliberately not one row: they
     * are opposite acts — one stops what is running, one adds to it — and the send button
     * is the one that gets pressed without looking.
     *
     * Present for the whole life of the composer rather than appearing with the session's
     * state, which is what the header's version did and is what keeps the promise that
     * nothing shifts. `s.interactive` is the only thing that takes it away, and that is in
     * `composerSig`, so it goes with a rebuild of the whole composer rather than a patch
     * under a reader's cursor. A row that came and went with `working` would move the
     * textarea and the transcript's bottom edge every time a reply started or stopped —
     * on the exact screen you are typing into.
     */
    const above = document.createElement('div');
    above.className = 'composer-above';

    /*
     * The merge queue goes here, above the interrupt button, because this is the control
     * strip and a PR waiting on the maintainer is a control. It is built empty and *not
     * appended* — `renderMergeQueue` puts it in only when there is something in it, which
     * is what keeps `.composer-above:empty` firing for a read-only session and what makes
     * the no-PR layout byte-identical to the one before this existed. Interrupt stays a
     * plain direct child either way; it is never re-parented.
     */
    const merge = document.createElement('div');
    merge.className = 'merge-queue';

    /*
     * And the ghost-text line, on the same terms — built empty, appended only when there is
     * a suggestion, so a session that is offering nothing is byte-identical to the layout
     * before this existed.
     *
     * It carries the suggestion and nothing else now: the tag and the text. The button that
     * takes the suggestion up is the interrupt button below, which is free to be it because
     * a suggestion only exists while the pane is idle and an idle session's interrupt has
     * nothing to stop — so the two are one row, and `ghost-line` is what flows left in it.
     *
     * `ghost-line`, and note `ghost-btn` two lines below is something else entirely: that
     * is the panel's generic muted-button class, on the interrupt button and half the
     * controls in the app. Nothing here is one of those.
     */
    const ghost = document.createElement('div');
    ghost.className = 'ghost-line';

    let stop = null;
    let stopLabel = null;
    if (s.interactive) {
      stop = document.createElement('button');
      stop.className = 'ghost-btn';
      /*
       * The word lives in a span rather than as the button's own text, and that is layout
       * arithmetic rather than tidiness: the button holds two meanings and its whole design
       * rule is that it never moves, so the widest of the three words (`interrupt`) is
       * always in the box as a hidden `::before` and the live word sits on top of it in the
       * same grid cell. Text straight in the button would be an *anonymous* grid item and
       * could not be placed in that cell — it would auto-place onto a second row and make
       * the button twice as tall. See `.composer-above > .ghost-btn` in `styles.css`.
       */
      stopLabel = document.createElement('span');
      stopLabel.className = 'ghost-btn-label';
      stopLabel.textContent = 'interrupt';
      stop.append(stopLabel);
      stop.dataset.act = 'interrupt';
      stop.title = INTERRUPT_TITLE;
      stop.onclick = () => sendKey('interrupt');
      above.append(stop);
    }

    const row = document.createElement('div');
    row.className = 'composer-row';

    const hint = document.createElement('span');
    hint.className = 'composer-hint';

    // What it's doing, beside the control that says how it's allowed to do it. This used
    // to live in the header, a whole screen away from the box you type into — and the one
    // thing it tells you is whether typing now means waiting.
    const activity = document.createElement('span');
    activity.className = 'composer-activity';

    const model = buildModelPicker(s);
    const effort = buildEffortPicker(s);
    const mode = buildModePicker(s);

    const btn = document.createElement('button');
    btn.className = 'send-btn';
    btn.textContent = 'send';
    btn.disabled = !s.interactive;
    btn.onclick = submit;

    row.append(hint, activity, model, effort, mode, btn);
    inner.append(queue, strip, above, ta, row);

    closeCompletion();
    composerEl = { wrap, ta, hint, activity, model, effort, btn, strip, queue, above, merge, ghost, stop, stopLabel, autoGrow };
    lastComposerSig = composerSig(s);
    renderAttachments();
    renderQueue();
    // Same shape as `renderQueue` above: the composer was just rebuilt, so whatever the
    // last poll knew has to be redrawn into the new nodes. Note this fills a *detached*
    // tree — the wrap is appended by the caller — which is safe only because nothing here
    // guards on `isConnected` and nothing here measures the document. The room and the
    // task list do both, which is why `renderMain` mounts before it paints them.
    renderMergeQueue();
    renderGhostLine();
    updateComposerHint();
    return wrap;
  }

  /**
   * The ghost-text line: Claude Code's own guess at your next prompt, offered above the box.
   *
   * Three rules, and each of them is the point rather than a detail.
   *
   * **It is not in the transcript.** A suggestion is an offer that expires, not something
   * that happened — putting it in the message stream would be the same mistake as reading
   * ghost text as typed text, one layer up. It lives above the composer and nowhere else.
   *
   * **It is not in `composerSig`.** A suggestion appears and changes at the end of every
   * turn; a signature carrying it would tear the whole textarea down and rebuild it under
   * a reader's cursor each time. Same trap the merge queue's own comment names, and this
   * is the second thing to ride `renderHead`'s roster beat for that reason.
   *
   * **It is gone the moment there is anything in the box.** The terminal's own ghost text
   * behaves that way, and here it does a second job: "use" replaces what the composer is
   * holding, so an offer that could only ever appear over an empty box is one that cannot
   * destroy a half-written message. That is why there is no disabled state and no
   * confirmation — the destructive case does not exist.
   *
   * Membership rather than `hidden`, like the merge block, because `.composer-above:empty`
   * is what collapses the strip for a read-only session.
   *
   * **And it has no button of its own.** It shares the interrupt button's row and the
   * interrupt button, which is free to be it because the two can never both be live: a
   * suggestion exists only while the pane is idle, and an idle session's interrupt has
   * nothing to stop. So the row is the height it always was, the button is where it always
   * was, and the word on it says which of the two things a press would do. `paintGhostButton`
   * below is that swap; `web/ghost-action.js` is the rule.
   */
  function renderGhostLine() {
    if (!composerEl?.ghost) return;
    const s = current();
    const { ghost, above, ta, stop } = composerEl;

    const text = s?.interactive && !ta.value.trim() ? s.ghost : null;
    // The button first, and unconditionally, because it is the half that has to change back:
    // the line is *removed* when there is no suggestion and can hold no state across that,
    // while the button is there for the whole life of the composer and has to be reading
    // `interrupt` again by the time this returns.
    paintGhostButton(text);
    if (!text) {
      ghost.replaceChildren();
      ghost.remove();
      return;
    }
    // Nothing to repaint if it already says this. The line sits directly above a textarea
    // somebody may be about to click into, and a `replaceChildren` on every roster frame
    // would drop a focused button out from under a press.
    //
    // The auto-send flag is half the key, not decoration: it changes what the button beside
    // this line says and what pressing it does. `ghostSig` is where that is spelled, once,
    // for both halves of the row — see `web/ghost-action.js`.
    const sig = ghostSig(text, ghostSend.on);
    if (ghost.dataset.sig === sig && ghost.isConnected) return;
    ghost.dataset.sig = sig;

    ghost.replaceChildren();

    const tag = document.createElement('span');
    tag.className = 'ghost-line-tag';
    tag.textContent = 'suggested';

    const body = document.createElement('span');
    body.className = 'ghost-line-text';
    body.textContent = text;
    // One terminal line can be two hundred characters and the strip is one line tall, so
    // the ellipsis is CSS and the whole of it is here for a reader who wants it.
    body.title = text;

    ghost.append(tag, body);
    // Before the interrupt button, never after it — and now on the same row as it rather
    // than above it. Interrupt's whole design is that it never moves, and this line flows
    // into the space to its left instead of pushing it down: the row is the height it has
    // always been, with or without a suggestion in it. The merge block is prepended one
    // step further up and takes a line of its own.
    // There is no `has-ghost` class any more and that is the point: the line shares the row
    // rather than changing its shape, so nothing above needed telling. The merge block still
    // carries its own, because it is still the one thing here that takes a whole line.
    if (stop && stop.parentNode === above) above.insertBefore(ghost, stop);
    else above.append(ghost);
  }

  /**
   * The interrupt button, wearing whichever of its two meanings is live.
   *
   * One node, never two, and never rebuilt: the word and the title are swapped in place and
   * the handler is reassigned. That is what makes a press landing across a swap safe —
   * `onclick` and the visible word are set in the same synchronous pass, so a click can only
   * ever run the handler the word in front of it was naming. The line's old button was a
   * node that appeared and vanished, which is the shape the ghost line's own comment warns
   * about: a `replaceChildren` under a finger already on its way down.
   *
   * The handler is reassigned on every paint rather than guarded — a property write is not a
   * DOM mutation and disturbs nothing — because it closes over *this* suggestion, and a
   * guard on the word alone would leave `use` bound to a suggestion that has since changed.
   * Only the visible parts are guarded, on `data-act`.
   */
  function paintGhostButton(text) {
    const { stop, stopLabel } = composerEl;
    if (!stop) return;
    const { act, title, suggests } = ghostAction(text, ghostSend.on);
    stop.onclick = suggests ? () => useGhost(text) : () => sendKey('interrupt');
    if (stop.dataset.act === act) return;
    stop.dataset.act = act;
    if (stopLabel) stopLabel.textContent = act;
    stop.title = title;
  }

  /**
   * Take the suggestion up.
   *
   * Through the panel's own send path in both cases — `submit` claims the pane, clears the
   * line and types, the same as anything else you write here. The terminal's own Tab is
   * never driven: it would race the `C-u` that `sendText` leads with, and the panel does
   * not mirror keystrokes into a pane it is also typing into.
   */
  function useGhost(text) {
    const s = current();
    if (!s?.interactive || !composerEl) return;
    composerEl.ta.value = text;
    composerEl.autoGrow();
    saveDraft(s.id);
    if (ghostSend.on) {
      submit();
      return;
    }
    // Cursor at the end, so the next keystroke continues the suggestion rather than
    // landing in front of it.
    composerEl.ta.focus();
    composerEl.ta.setSelectionRange(text.length, text.length);
    renderGhostLine();
  }

  /**
   * The waiting list.
   *
   * Server-held, so it is the same list in every tab and it survives closing them all.
   * Shown in delivery order, with the head marked — the one that goes the moment this
   * session is free.
   */
  function renderQueue() {
    if (!composerEl?.queue) return;
    const s = current();
    const items = s?.queued || [];
    const { queue } = composerEl;

    queue.hidden = !items.length;
    queue.replaceChildren();
    if (!items.length) return;

    const head = document.createElement('div');
    head.className = 'queue-head';
    head.textContent = `${items.length} waiting · sends when this session is free`;
    queue.append(head);

    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `queue-item${i === 0 ? ' next' : ''}${item.error ? ' failed' : ''}`;

      const pos = document.createElement('span');
      pos.className = 'queue-pos';
      pos.textContent = i === 0 ? '→' : `${i + 1}`;
      row.append(pos);

      const body = document.createElement('span');
      body.className = 'queue-text';
      body.textContent = item.text;
      body.title = item.text;
      row.append(body);

      if (item.error) {
        const err = document.createElement('span');
        err.className = 'queue-err';
        err.textContent = 'retrying';
        err.title = item.error;
        row.append(err);
      }

      const when = document.createElement('span');
      when.className = 'queue-when';
      when.textContent = relativeTime(item.at);
      row.append(when);

      const drop = document.createElement('button');
      drop.className = 'queue-drop';
      drop.textContent = '✕';
      drop.title = 'Drop this message';
      drop.onclick = () => unqueue(s.id, item.id);
      row.append(drop);

      queue.append(row);
    });
  }

  /* ------------------------------------------------------- merge queue --- */

  /*
   * The PRs waiting on the maintainer, in the control strip above the box they type into.
   *
   * The problem it solves is not "is there a PR" — the rail already says `3 in review` in
   * amber. It is that the *links* are minutes apart up the scrollback, behind other talk,
   * and an hour later they have to hunt for something they already know exists. This is the
   * fixed place they live.
   *
   * **The button does not merge.** It POSTs task ids; the server composes one sentence and
   * types it into the lead's own session, exactly as if the maintainer had typed it, and
   * the lead does what it already does — merges, pulls, restarts, verifies, closes. Every
   * sentence on screen here (`note`, `sharesNote`, `batch.why`) is composed server-side and
   * is rendered **verbatim**: the wording is a property of the panel, so the desktop and
   * the phone cannot drift, exactly as `web/trust-gate.js` is one witness with three
   * readers.
   *
   * And the rule the whole thing turns on (plan §1, the maintainer's own reasoning):
   *
   *   > A **batch** press is refused when the batch does not compose. An **individual**
   *   > press is never refused, only annotated.
   *
   * So `merge all` goes *absent* when the batch does not compose, with `batch.why` drawn
   * where it would have been — a greyed control invites a second click and a hunt for why,
   * a sentence is read once and understood — while every row with a PR keeps its own
   * button, `rebase-first` and `unreadable` included, with the fact in its own line.
   */

  /**
   * Take the question down, if the one on screen belongs to this block.
   *
   * The arming itself is `armConfirm`, module scope, shared with the task list — see the
   * confirmation section above. What stays here is the *scope*: this block's own way of
   * saying "whatever I was asking is about to stop being true". Two callers, both for the
   * same reason — the rows are about to be replaced, or the room they belong to has
   * changed team — and both pass `merge` so a question in the other pane is left alone.
   */
  function disarmMerge() {
    if (composerEl?.merge) disarmConfirm(composerEl.merge);
  }

  /**
   * The queue over HTTP on the roster beat, with its own floor — the same shape as
   * `refreshTasks`, and separate from `/api/team/tasks` on purpose: that one is unfiltered
   * and polled for every team, and this one shells out to git.
   *
   * A missed beat is the next one's problem. The signature is everything the block draws,
   * so a quiet team repaints not at all and an arm survives.
   */
  async function refreshMerge(force = false) {
    if (!roomView.repo || roomView.mergeBusy) return;
    if (!force && Date.now() - roomView.mergeAt < 3000) return;
    roomView.mergeBusy = true;
    roomView.mergeAt = Date.now();
    const repo = roomView.repo;
    try {
      const res = await fetch(`/api/team/merge?folder=${encodeURIComponent(repo)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No merge queue.');
      // The pane can have changed team while this was in flight; that answer is about a
      // repo this block is no longer showing.
      if (roomView.repo !== repo) return;
      const sig = mergeSig(data);
      if (sig !== roomView.mergeSig) {
        roomView.mergeSig = sig;
        roomView.merge = data;
        renderMergeQueue();
      }
    } catch {
      /* a missed refresh is the next roster frame's problem, not an error state */
    } finally {
      roomView.mergeBusy = false;
    }
  }

  /** Everything the block draws, and nothing it doesn't — a repaint costs an arm. */
  function mergeSig(data) {
    /*
     * Explicit separators, written as ordinary punctuation.
     *
     * Joining fields with an empty string is how two different queues come out spelled
     * the same — and the first draft of this line got worse than that: an invisible
     * control character ended up inside the quotes, valid JavaScript that reads as `''`
     * in every editor and is not. `normalize.js` already carries that lesson about its
     * ANSI regex; the same rule holds anywhere a separator is a literal.
     */
    const rows = (data?.rows || [])
      .map((r) => [r.id, r.kind, r.state, r.pr, r.prNumber, r.title, r.note, r.sharesNote].join('|'))
      .join('~');
    const lead = data?.lead ? `${data.lead.id}:${data.lead.status}:${data.lead.queued}` : 'none';
    const batch = [data?.batch?.allowed, data?.batch?.why, (data?.batch?.tasks || []).join(',')].join('|');
    return [rows, batch, lead].join('~');
  }

  /** Locally-pressed rows, minus the ones that have aged out of the lock. */
  function localLock(id) {
    const held = roomView.mergeSent.get(id);
    if (!held) return null;
    if (Date.now() - held.at > MERGE_LOCK_MS) {
      roomView.mergeSent.delete(id);
      return null;
    }
    return held.text;
  }

  /** The standing refusal for one row, or the batch, expired in the reading. */
  function mergeError(key) {
    const held = roomView.mergeErrors.get(key);
    if (!held) return null;
    if (Date.now() - held.at > MERGE_ERR_MS) {
      roomView.mergeErrors.delete(key);
      return null;
    }
    return held.text;
  }

  /**
   * Hold a refusal and show it now.
   *
   * The repaint is what makes it reliable: the press that failed may have been the thing
   * that changed the queue, so the answer often arrives with a repaint already on its way.
   * Painting from the stored map means the sentence is redrawn by that repaint instead of
   * being thrown away with the row it was appended to.
   */
  function holdMergeError(key, text) {
    roomView.mergeErrors.set(key, { text, at: Date.now() });
    renderMergeQueue();
    setTimeout(() => {
      if (mergeError(key) === text) {
        roomView.mergeErrors.delete(key);
        renderMergeQueue();
      }
    }, MERGE_ERR_MS + 100);
  }

  /** The panel's error line, in the block's own voice — the server's words, never a paraphrase. */
  function mergeErrNode(text) {
    const line = document.createElement('div');
    line.className = 'team-err';
    line.textContent = text;
    return line;
  }

  /**
   * Paint the block, and put it in or take it out of `.composer-above`.
   *
   * Membership rather than `hidden`, because `.composer-above:empty` is what collapses the
   * row for a read-only session, and an always-present child would silently stop it firing
   * — the whole "nothing moves when there is nothing to merge" promise runs through that
   * one selector.
   */
  function renderMergeQueue() {
    if (!composerEl?.merge) return;
    const { merge, above } = composerEl;
    const data = roomView.merge;
    const rows = data?.rows || [];

    disarmMerge();

    if (!rows.length) {
      merge.replaceChildren();
      merge.remove();
      above.classList.remove('has-merge');
      return;
    }

    // Read before the swap, never after: `scrollTop` on a box that `replaceChildren` has
    // just emptied clamps to 0, which is how the room put its reader back at the top on
    // every arriving line. Same for the stream — the block appearing moves the
    // transcript's bottom edge, and a reader who was at the bottom should stay there.
    const keepScroll = merge.querySelector('.merge-rows')?.scrollTop || 0;
    const stream = streamEl?.stream;
    // `above`, not `merge`: the block is *out* of the document exactly when it is about to
    // appear, which is the one moment the bottom edge actually moves. `above` is in the
    // document for every live repaint and out of it only while `buildComposer` fills a
    // tree its caller has not appended yet — where there is nothing to measure.
    const pinned =
      stream && above.isConnected ? stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40 : false;

    /*
     * Three parts, and only the middle one scrolls.
     *
     * Found on the bench: with the whole block capped and scrollable, five review rows
     * pushed `batch.why` below the fold — so the panel withheld `merge all` and hid the
     * one sentence that says why, which is the exact failure the "absent, not disabled"
     * rule exists to avoid. The rows are a list you can page through; the refusal and the
     * control are the block's conclusion and are always on screen.
     */
    merge.replaceChildren();
    merge.append(mergeHead(data, rows));

    const list = document.createElement('div');
    list.className = 'merge-rows';
    for (const row of rows) list.append(mergeRow(row));
    merge.append(list);

    const foot = mergeFoot(data, rows);
    if (foot) merge.append(foot);

    above.prepend(merge);
    above.classList.add('has-merge');
    list.scrollTop = keepScroll;
    if (pinned) stream.scrollTop = stream.scrollHeight;
  }

  /** What the block is, plus the one fact about the lead that changes what a press means. */
  function mergeHead(data, rows) {
    const head = document.createElement('div');
    head.className = 'merge-head';

    const label = document.createElement('span');
    label.textContent = `${rows.length} in review · oldest first`;
    head.append(label);

    if (!data.lead) {
      // Not an error and not a refusal — the rows are still worth reading and the links
      // still work. It says why there are no buttons, which is the only thing missing.
      const none = document.createElement('span');
      none.className = 'merge-head-note';
      none.textContent = 'no lead running — nothing to type into';
      head.append(none);
    } else if (data.lead.queued) {
      const waiting = document.createElement('span');
      waiting.className = 'merge-head-note';
      waiting.textContent = `${data.lead.queued} message${data.lead.queued === 1 ? '' : 's'} queued ahead`;
      waiting.title = 'A merge pressed now goes to the back of the lead’s queue.';
      head.append(waiting);
    }
    return head;
  }

  /** One PR: what it was, what it changes that something else changes, and the button. */
  function mergeRow(row) {
    const el = document.createElement('div');
    el.className = `merge-row is-${row.state}`;

    const line = document.createElement('div');
    line.className = 'merge-line';

    const id = document.createElement('span');
    id.className = 'merge-id';
    id.textContent = row.id;
    id.title = row.branch || row.id;
    line.append(id);

    if (row.kind === 'plan') {
      // A planner's deliverable is a page, not a branch. It is here because the rail's
      // amber count includes it and a block that said one fewer would read as a bug — but
      // it never gets a button, and the server refuses it by kind if a client tries.
      const kind = document.createElement('span');
      kind.className = 'merge-kind';
      kind.textContent = 'plan';
      line.append(kind);
    }

    const title = document.createElement('span');
    title.className = 'merge-title';
    title.textContent = row.title || '';
    title.title = row.title || '';
    line.append(title);

    if (row.pr) {
      const pr = document.createElement('a');
      pr.className = 'merge-pr';
      pr.href = row.pr;
      pr.target = '_blank';
      pr.rel = 'noopener';
      pr.textContent = row.prNumber ? `#${row.prNumber}` : 'PR';
      pr.title = row.pr;
      // Explicitly, on the link — the row is a live control strip and a stray bubble
      // into whatever sits behind it is the small wrongness this panel avoids.
      pr.onclick = (e) => e.stopPropagation();
      line.append(pr);
    }

    const held = localLock(row.id);
    const locked = held || row.state === 'sent' || row.state === 'merged';
    if (!locked && row.pr && row.kind !== 'plan') line.append(mergeButton(row));

    el.append(line);

    // Verbatim, all of it. `note` and `sharesNote` are composed by the server so the two
    // clients say the same words; re-wording either here is how they start to drift.
    const clauses = [];
    if (held) clauses.push({ text: held, cls: 'is-sent' });
    else if (row.note) clauses.push({ text: row.note, cls: mergeNoteClass(row.state) });
    if (row.sharesNote) clauses.push({ text: row.sharesNote, cls: 'is-warn' });
    for (const c of clauses) {
      const note = document.createElement('div');
      note.className = `merge-note ${c.cls}`;
      note.textContent = c.text;
      el.append(note);
    }

    const err = mergeError(row.id);
    if (err) el.append(mergeErrNode(err));

    return el;
  }

  /** Amber for the two clauses that say "look at this first", quiet for the rest. */
  function mergeNoteClass(state) {
    if (state === 'rebase-first' || state === 'unreadable') return 'is-warn';
    if (state === 'merged') return 'is-done';
    return 'is-quiet';
  }

  function mergeButton(row) {
    const btn = document.createElement('button');
    btn.className = 'merge-btn';
    btn.textContent = 'merge';
    btn.title = `Ask the lead to merge ${row.prNumber ? `PR #${row.prNumber}` : row.pr} — it merges, pulls, verifies and closes ${row.id}.`;
    btn.onclick = (e) => {
      e.stopPropagation();
      // The PR number is the thing a person recognises, and it is what the lead's sentence
      // will name. With no number there is no honest short handle for the PR, so the
      // branch stands in — it is the row's own `title` already — and the task id last,
      // which is the one thing a row always has.
      const target = row.prNumber ? `#${row.prNumber}` : row.branch || row.id;
      armConfirm(btn, `merge ${target}?`, () => sendMerge([row], btn, row));
    };
    return btn;
  }

  /**
   * The last line: `merge all`, or the sentence that stands where it would have been.
   *
   * Absent, never disabled. Nothing at all when there is nothing to explain — one PR is
   * not a batch, and a control that says "all" over a single row is noise.
   */
  function mergeFoot(data, rows) {
    const batch = data.batch || {};
    const err = mergeError('*');
    if (!batch.allowed && !batch.why && !err) return null;
    if (!data.lead && !err) return null; // no session to type into; the head already says so

    const foot = document.createElement('div');
    foot.className = 'merge-foot';
    if (err) foot.append(mergeErrNode(err));

    if (!batch.allowed) {
      const why = document.createElement('div');
      why.className = 'merge-why';
      why.textContent = batch.why; // verbatim — the refusal is the server's sentence
      foot.append(why);
      return foot;
    }

    const ids = batch.tasks || [];
    const named = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    // A foot holding only a refusal is still a foot: every early return from here on has
    // to keep it, or the sentence explaining a failed batch press disappears with the
    // control it was about.
    if (named.length < 2) return foot.firstChild ? foot : null;
    if (named.some((r) => localLock(r.id))) return foot.firstChild ? foot : null; // one is already gone

    // No label beside it. There is no server sentence for the allowed case — `why` is null
    // when there is nothing to explain — and inventing one here would put a claim about
    // composition in the client's voice, which is the one thing this block does not do.
    const btn = document.createElement('button');
    btn.className = 'merge-btn is-all';
    btn.textContent = 'merge all';
    btn.title = `Ask the lead to merge ${named.length} PRs in order: ${named.map((r) => r.id).join(', ')}.`;
    btn.onclick = (e) => {
      e.stopPropagation();
      // The count, not the ids: five task ids is a paragraph, and the `title` beside it
      // already lists them in the order they would go.
      armConfirm(btn, `merge all ${named.length}?`, () => sendMerge(named, btn, null));
    };
    foot.append(btn);
    return foot;
  }

  /**
   * Press it.
   *
   * `expect` carries the PR each row was *showing* when it was pressed — required by the
   * endpoint, not optional, because the row was drawn from a poll up to three seconds old
   * and the record behind it can have been re-PR'd since. Optional safety is not safety.
   *
   * Refusals surface in the **server's own words**. A 409 here is a real sentence — a
   * batch that does not compose, a second press inside the window, a task that has moved —
   * and paraphrasing it would lose the thing that makes it actionable.
   */
  async function sendMerge(rows, btn, single) {
    btn.disabled = true;
    try {
      const res = await postJSON('/api/team/merge', {
        folder: roomView.repo,
        tasks: rows.map((r) => r.id),
        expect: rows.map((r) => ({ id: r.id, pr: r.pr })),
      });
      const text = res.queued ? 'merge queued — waiting on the lead' : 'merge sent — waiting on the lead';
      const at = Date.now();
      for (const r of rows) roomView.mergeSent.set(r.id, { text, at });
      // Force past the floor: the row must lock now, not up to three seconds from now,
      // and the server's own `sent` state is what holds it for the ten minutes after.
      roomView.mergeSig = ''; // the rows changed under us; make the next answer repaint
      refreshMerge(true);
      renderMergeQueue();
    } catch (err) {
      btn.disabled = false;
      // A refused press leaves nothing armed and nothing sent; the row is still pressable.
      if (single) roomView.mergeSent.delete(single.id);
      // The server's own sentence, verbatim, and held rather than appended — the press
      // that failed is often what changed the queue, so a repaint is already on its way.
      holdMergeError(single ? single.id : '*', err.message);
    }
  }

  /**
   * The question card — Claude asking *you* something.
   *
   * Reads like the permission card on purpose, because from where you're sitting it is the
   * same moment: a session stopped, and it needs a word from you before it goes on. What
   * differs is underneath. A permission option is one digit and it's answered; here a
   * single-select is one press, and a multi-select is a set of toggles followed by a review
   * screen. The card hides that, but the server never does — it re-reads the review and
   * refuses to submit anything it can't see listed there.
   */
  /**
   * The box that ends plan mode.
   *
   * Two things here are deliberate departures from what the terminal shows.
   *
   * The **narrow yes goes first**. Claude Code puts the broad one at the top because that
   * is where its cursor starts; the panel is under no obligation to repeat that, and the
   * top button in a card is the one that gets pressed without reading. On this screen the
   * broad row can be "clear context and bypass permissions" — one press that throws the
   * conversation away *and* stops the session ever asking again.
   *
   * And every button carries **its own digit**, both as a label and as what gets sent. The
   * option list is rebuilt at every render, so position means nothing and the number is the
   * only stable handle on a row.
   */
  function buildPlanCard(s) {
    const p = s.plan;
    const card = document.createElement('div');
    card.className = 'ask plan-card';

    const head = document.createElement('div');
    head.className = 'ask-head';
    head.textContent = 'plan ready';
    card.append(head);

    const q = document.createElement('div');
    q.className = 'ask-q';
    q.textContent = p.header;
    card.append(q);

    const err = document.createElement('div');
    err.className = 'ask-err';
    err.hidden = true;

    if (p.planPath) card.append(planReader(s, p.planPath));

    // narrow, then broad, then the ones that cost you something.
    const rank = { narrow: 0, broad: 1, refine: 2, danger: 3 };
    const opts = [...p.options].sort((a, b) => (rank[a.tone] ?? 1) - (rank[b.tone] ?? 1));

    const list = document.createElement('div');
    list.className = 'plan-opts';
    opts.forEach((o, i) => {
      const b = document.createElement('button');
      b.className = `plan-opt tone-${o.tone}${i === 0 ? ' is-primary' : ''}`;

      const num = document.createElement('span');
      num.className = 'plan-num';
      num.textContent = o.index;

      const label = document.createElement('span');
      label.textContent = o.label;

      b.append(num, label);
      if (o.tone === 'danger') {
        b.title = 'This one changes the session itself, not just this plan — read it twice.';
      } else if (o.tone === 'refine') {
        b.title = 'This sends the plan off this machine, to Claude Code on the web.';
      }
      b.onclick = () =>
        postPlan(s.id, { index: o.index, expectLabel: o.label }, card, err);
      list.append(b);
    });
    card.append(list);

    if (p.feedback) {
      const ta = document.createElement('textarea');
      ta.className = 'plan-feedback';
      ta.rows = 2;
      ta.placeholder = p.feedback.label || 'Tell Claude what to change…';

      const bar = document.createElement('div');
      bar.className = 'ask-bar';
      const send = document.createElement('button');
      send.className = 'ask-submit';
      send.textContent = 'keep planning';
      send.onclick = () => {
        const note = ta.value.trim();
        if (!note) {
          ta.focus();
          return;
        }
        postPlan(s.id, { feedback: note }, card, err);
      };
      bar.append(send);
      card.append(ta, bar);
    }

    card.append(err);
    return card;
  }

  /** The plan file itself, fetched only if you open it. */
  function planReader(s, planPath) {
    const box = document.createElement('details');
    box.className = 'plan-file';

    const summary = document.createElement('summary');
    summary.textContent = planPath.split('/').filter(Boolean).at(-1) || planPath;
    summary.title = planPath;
    box.append(summary);

    const body = document.createElement('div');
    body.className = 'plan-md';
    body.textContent = 'reading…';
    box.append(body);

    let loaded = false;
    box.addEventListener('toggle', async () => {
      if (!box.open || loaded) return;
      loaded = true;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/plan-file`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not read it.');
        body.innerHTML = withBlankTargets(marked.parse(data.markdown));
      } catch (e) {
        loaded = false; // let a retry happen on the next open
        body.textContent = e.message;
      }
    });
    return box;
  }

  async function postPlan(sessionId, body, card, err) {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    err.hidden = true;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `That didn't take (${res.status}).`);
      // The card goes when the next roster frame says the box has gone; leaving the
      // buttons disabled until then is honest about what is in flight.
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  function buildQuestionCard(s) {
    const q = s.question;
    const card = document.createElement('div');
    card.className = 'ask';

    const head = document.createElement('div');
    head.className = 'ask-head';
    head.textContent = q.kind === 'review' ? 'Ready to submit?' : 'Claude is asking';
    card.append(head);

    // A set of questions shows where you are in it — otherwise answering one and seeing
    // another appear reads like the panel did something wrong.
    if (q.questions?.length > 1) {
      const strip = document.createElement('div');
      strip.className = 'ask-steps';
      q.questions.forEach((step) => {
        const chip = document.createElement('span');
        chip.className = `ask-step${step.answered ? ' done' : ''}`;
        chip.textContent = step.label;
        strip.append(chip);
      });
      card.append(strip);
    }

    const question = document.createElement('div');
    question.className = 'ask-q';
    question.textContent = q.question;
    card.append(question);

    const err = document.createElement('div');
    err.className = 'ask-err';
    err.hidden = true;

    if (q.kind === 'review') {
      const list = document.createElement('div');
      list.className = 'ask-review';
      (q.answers || []).forEach((a) => {
        const row = document.createElement('div');
        row.className = 'ask-review-row';
        const qq = document.createElement('span');
        qq.className = 'ask-review-q';
        qq.textContent = a.question;
        const aa = document.createElement('span');
        aa.className = 'ask-review-a';
        aa.textContent = a.answer || '—';
        row.append(qq, aa);
        list.append(row);
      });
      card.append(list);

      const bar = document.createElement('div');
      bar.className = 'ask-bar';
      const submit = document.createElement('button');
      submit.className = 'ask-submit';
      submit.textContent = 'submit answers';
      submit.onclick = () => postQuestion(s.id, { action: 'submit' }, card, err);
      const cancel = document.createElement('button');
      cancel.className = 'ask-cancel';
      cancel.textContent = 'cancel';
      cancel.onclick = () => postQuestion(s.id, { action: 'cancel' }, card, err);
      bar.append(submit, cancel);
      card.append(bar, err);
      return card;
    }

    const picked = new Set(q.options.filter((o) => o.checked).map((o) => o.index));

    const list = document.createElement('div');
    list.className = 'ask-opts';

    q.options.forEach((option) => {
      const row = document.createElement('button');
      row.className = `ask-opt${picked.has(option.index) ? ' on' : ''}`;
      row.setAttribute('aria-pressed', String(picked.has(option.index)));

      const box = document.createElement('span');
      box.className = 'ask-box';
      box.textContent = q.multiSelect ? (picked.has(option.index) ? '☑' : '☐') : option.index;
      row.append(box);

      const body = document.createElement('span');
      body.className = 'ask-opt-body';
      const label = document.createElement('span');
      label.className = 'ask-label';
      label.textContent = option.label;
      body.append(label);
      if (option.description) {
        const desc = document.createElement('span');
        desc.className = 'ask-desc';
        desc.textContent = option.description;
        body.append(desc);
      }
      row.append(body);

      row.onclick = () => {
        if (!q.multiSelect) {
          // One press answers it. No confirm step, because the terminal has none either.
          postQuestion(s.id, { options: [option.index], expect: expectOf(q) }, card, err);
          return;
        }
        if (picked.has(option.index)) picked.delete(option.index);
        else picked.add(option.index);
        row.classList.toggle('on', picked.has(option.index));
        row.setAttribute('aria-pressed', String(picked.has(option.index)));
        box.textContent = picked.has(option.index) ? '☑' : '☐';
        send.disabled = !picked.size;
      };

      list.append(row);
    });
    card.append(list);

    const bar = document.createElement('div');
    bar.className = 'ask-bar';

    const send = document.createElement('button');
    send.className = 'ask-submit';
    send.textContent = 'submit';
    send.disabled = !picked.size;
    send.hidden = !q.multiSelect;
    send.onclick = () =>
      postQuestion(s.id, { options: [...picked], expect: expectOf(q) }, card, err);
    bar.append(send);

    const note = document.createElement('span');
    note.className = 'ask-note';
    note.textContent = q.multiSelect
      ? 'pick any number, then submit'
      : 'pick one — it sends straight away';
    bar.append(note);

    card.append(bar, buildHatches(s, q, card, err), err);
    return card;
  }

  /**
   * The two ways out of a question, for when the answer isn't on the list.
   *
   * They matter more here than in the terminal: while the box is up the composer *queues*
   * rather than sends, so "just say what you mean" is the one thing the panel can't do —
   * and the rows that offer it sit below the rule, outside the numbered run, which is
   * exactly why they were missing from this card in the first place.
   *
   * `chat about this` declines the questions and hands the composer back. The text field
   * answers in your own words — single-select only, because on a multi-select that same
   * digit merely ticks the row and there would be nothing listening to what we typed.
   * Both were pressed by hand; see `planChat` and `planFreeText`.
   */
  function buildHatches(s, q, card, err) {
    const hatch = document.createElement('div');
    hatch.className = 'ask-hatch';

    if (q.freeTextIndex && !q.multiSelect) {
      const form = document.createElement('form');
      form.className = 'ask-text';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 500;
      input.placeholder = 'or answer in your own words';
      const go = document.createElement('button');
      go.type = 'submit';
      go.className = 'ask-cancel';
      go.textContent = 'send';
      form.append(input, go);
      form.onsubmit = (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (text) postQuestion(s.id, { action: 'text', text }, card, err);
      };
      hatch.append(form);
    }

    if (q.chatIndex) {
      const chat = document.createElement('button');
      chat.className = 'ask-cancel';
      chat.textContent = 'chat about this';
      chat.title = 'Declines the questions and frees the composer — nothing gets answered';
      chat.onclick = () => postQuestion(s.id, { action: 'chat' }, card, err);
      hatch.append(chat);
    }

    return hatch;
  }

  /** The labels the card is showing, so the server can refuse if the box moved under us. */
  const expectOf = (q) => q.options.map((o) => ({ index: o.index, label: o.label }));

  async function postQuestion(sessionId, body, card, err) {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    err.hidden = true;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        err.hidden = false;
        err.textContent = data.error || `Could not answer (${res.status}).`;
        card.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  /**
   * The permission card.
   *
   * Every button is built from an option actually on screen and carries that option's
   * own number. Nothing is inferred from position — the old approve/deny pair guessed,
   * and guessed wrong, because "No" is option 3 while option 2 is a broader yes.
   */
  /**
   * Permission mode picker.
   *
   * Reads as direct selection, but underneath the terminal only cycles — the server steps
   * and verifies. Each mode carries its own colour so the current one registers without
   * being read, the way the yellow `⏵⏵` does in the terminal.
   */
  const MODE_LABELS = {
    auto: 'auto',
    manual: 'manual',
    acceptEdits: 'accept edits',
    plan: 'plan',
  };

  function buildModePicker(s) {
    const wrap = document.createElement('div');
    wrap.className = 'mode-picker';

    const select = document.createElement('select');
    select.className = `mode-select mode-${s.mode || 'unknown'}`;
    select.disabled = !s.interactive || !s.mode;
    select.title = 'Permission mode';

    if (!s.mode) {
      const opt = document.createElement('option');
      opt.textContent = s.interactive ? 'mode …' : 'no mode';
      select.append(opt);
    } else {
      for (const [id, label] of Object.entries(MODE_LABELS)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        opt.selected = id === s.mode;
        select.append(opt);
      }
    }

    select.onchange = async () => {
      const target = select.value;
      const previous = s.mode;
      select.disabled = true;
      select.className = 'mode-select mode-pending';
      try {
        const res = await fetch(`/api/sessions/${s.id}/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: target }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Could not switch mode (${res.status}).`);
        setComposerNote(`mode: ${MODE_LABELS[target]}`);
      } catch (err) {
        // Snap back to what the session is actually in, not what was clicked.
        select.value = previous || '';
        select.className = `mode-select mode-${previous || 'unknown'}`;
        setComposerNote(err.message, 'err');
      } finally {
        select.disabled = !s.interactive;
      }
    };

    wrap.append(select);
    return wrap;
  }

  /**
   * The model this session is on, and a menu to change it — for this session only.
   *
   * The list is not hard-coded and not cached: pressing the button opens the real
   * `/model` dialog in the terminal and draws what it actually says. The box staying open
   * behind the menu is the point — the panel is a remote control for it, not a copy of it,
   * and closing the menu Escapes the box rather than leaving one holding the session.
   *
   * Nothing here ever sends a digit *in the picker*. In that one dialog a digit selects
   * *and* writes the global default; the server steps the cursor and presses `s`. The
   * `Switch model?` box `s` sometimes raises behind it is the opposite — a digit there is
   * the only way to answer, and the server does, after checking it names the model that was
   * clicked. See `server/model.js`.
   */
  function buildModelPicker(s) {
    const btn = document.createElement('button');
    btn.className = 'model-btn';
    btn.textContent = shortModel(s.model) || 'model';
    btn.title = s.model
      ? `${s.model} — click to change it for this session only`
      : 'Choose a model for this session';
    btn.disabled = !s.interactive;

    btn.onclick = async () => {
      btn.disabled = true;
      const previous = btn.textContent;
      btn.textContent = 'opening…';
      try {
        const data = await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/model/open`, {});
        // Resolved here rather than captured above, and the difference is a whole await.
        // Opening the box types `/model` into the terminal and waits for it to come up,
        // which is longer than a roster beat — and a session showing that box has no
        // composer footer, so the frame that lands carries `mode: null`, `composerSig`
        // changes, and `renderHead` replaces the entire composer. `btn` is then a detached
        // node, it measures as all zeros, and the menu opens in the corner of the page
        // rather than over the button. Same "resolve at click time" rule the header's pin
        // follows, one await further along.
        const live = composerEl?.model;
        openModelMenu(live?.isConnected ? live : btn, s, data.dialog);
      } catch (err) {
        setComposerNote(err.message, 'err');
      } finally {
        btn.textContent = previous;
        btn.disabled = !s.interactive;
      }
    };
    return btn;
  }

  /**
   * Show a model the panel has just set, without waiting to be told about it.
   *
   * `s.model` comes off the composer footer by way of the roster, and while the picker
   * owned the terminal there was no footer to read — so the next frame names the model
   * this session was on a moment ago, and the label looks one click behind. (The server
   * seeds its own footer memory from the same answer, so the frame after that agrees
   * rather than stomping this back; without that half this repaint would survive about a
   * second.)
   *
   * Written onto the roster entry rather than onto the button, because the button, the
   * header and the rail row all read that one field and painting three places by hand is
   * how they drift apart. It is overwritten wholesale by the next `sessions` frame, which
   * is the point: this is what the panel believes until the pane says otherwise.
   */
  function noteModelPicked(model) {
    const s = current();
    if (!model || !s) return;
    s.model = model;
    renderRail();
    for (const p of panes) p.renderHead();
  }

  function openModelMenu(anchor, s, dialog) {
    const cancel = () =>
      fetch(`/api/sessions/${encodeURIComponent(s.id)}/model/cancel`, { method: 'POST' }).catch(
        () => {},
      );

    const items = dialog.options.map((o) => ({
      label: o.current ? `${o.label} ✓` : o.label,
      hint: o.description,
      onPick: async () => {
        setComposerNote(`switching to ${o.label}…`);
        try {
          const done = await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/model`, {
            index: o.index,
            expectLabel: o.label,
          });
          // Paint the answer before saying anything about it. The roster's model is
          // scraped off the composer footer, the terminal redraws that in its own time,
          // and the response is the only thing on either side that already knows — throw
          // it away and the button goes on naming the model you just left. The order
          // matters: this repaints the head, which rewrites the hint, so the note below
          // has to come after it.
          noteModelPicked(done.footerModel);

          // Mid-conversation the terminal asks one more question — "the history gets
          // re-read on your next message" — which the server answers, because the click
          // already said switch. Saying so is the difference between answering for you and
          // answering behind your back.
          setComposerNote(
            done.reread
              ? `model: ${done.model} — this session only · history re-read on the next message`
              : `model: ${done.model} — this session only`,
          );
        } catch (err) {
          // The box may still be up; don't leave it holding the session.
          await cancel();
          setComposerNote(err.message, 'err');
        }
      },
    }));

    // Dismissing the menu any other way has to close the terminal's box too.
    openMenu(anchor, items, { onDismiss: cancel });
  }

  /**
   * Effort — and the one control here that changes something outside this session.
   *
   * `/effort` has no `s`. Its Enter writes `effortLevel` for every session started
   * afterwards, and the effort row inside `/model` writes globally even when you press the
   * "this session only" key. Both measured. So this looks like the model picker and is
   * labelled as the opposite of it: the menu says what it is before you pick, and the
   * button carries a mark that it is a default rather than a per-session setting.
   */
  function buildEffortPicker(s) {
    const btn = document.createElement('button');
    btn.className = 'effort-btn';
    btn.textContent = s.effort || 'effort';
    btn.title = 'Effort — this is the default for every new session, not just this one';
    btn.disabled = !s.interactive;

    btn.onclick = async () => {
      btn.disabled = true;
      const previous = btn.textContent;
      btn.textContent = 'opening…';
      try {
        const data = await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/effort/open`, {});
        openEffortMenu(btn, s, data.dialog);
      } catch (err) {
        setComposerNote(err.message, 'err');
      } finally {
        btn.textContent = previous;
        btn.disabled = !s.interactive;
      }
    };
    return btn;
  }

  function openEffortMenu(anchor, s, dialog) {
    const cancel = () =>
      fetch(`/api/sessions/${encodeURIComponent(s.id)}/effort/cancel`, { method: 'POST' }).catch(
        () => {},
      );

    const items = [
      { note: 'Sets the default for every new session — Claude Code has no per-session effort.' },
      { separator: true },
      ...dialog.levels.map((l) => ({
        label: l.id,
        checked: l.current,
        onPick: async () => {
          setComposerNote(`setting effort to ${l.id}…`);
          try {
            const done = await postJSON(`/api/sessions/${encodeURIComponent(s.id)}/effort`, {
              level: l.id,
            });
            setComposerNote(`effort: ${done.effort} — ${done.scope}`);
          } catch (err) {
            await cancel();
            setComposerNote(err.message, 'err');
          }
        },
      })),
    ];

    openMenu(anchor, items, { onDismiss: cancel });
  }

  function buildDecisionBar(s) {
    const card = document.createElement('div');
    card.className = 'perm';

    const p = s.prompt;

    // Before anything else, including the unreadable-box branch. Claude Code's folder-trust
    // gate parses as an ordinary permission prompt — `dialog: null`, a full `prompt`, option
    // 1 `Yes, I trust this folder` classed `approve` — so neither of the two obvious tests
    // for "a box the panel must not answer" sees it, and every version of this function
    // before this one drew a full-width, unarmed, one-tap grant of read, edit and execute on
    // a folder nobody vetted, reachable from anything on the LAN. See `web/trust-gate.js`.
    if (isTrustGate(p)) return buildTrustNotice(p);

    if (!p) {
      // Something is blocking, but we could not read the box. Say so; offer nothing.
      card.classList.add('perm-unread');
      const head = document.createElement('div');
      head.className = 'perm-head';
      head.textContent = 'waiting on a prompt';
      const note = document.createElement('p');
      note.className = 'perm-note';
      note.textContent =
        'This session is blocked, but the prompt could not be read. Answer it in the terminal — the panel will not guess.';
      card.append(head, note);
      return card;
    }

    const head = document.createElement('div');
    head.className = 'perm-head';
    const kind = document.createElement('span');
    kind.className = 'perm-kind';
    kind.textContent = p.title || 'permission';
    head.append(kind);
    if (p.subject) {
      const subj = document.createElement('span');
      subj.className = 'perm-subject';
      subj.textContent = p.subject;
      subj.title = p.subject;
      head.append(subj);
    }
    card.append(head);

    if (p.detail?.length) {
      const detail = document.createElement('div');
      detail.className = 'perm-detail';
      for (const line of p.detail) {
        const row = document.createElement('div');
        row.textContent = line;
        // Diff lines arrive as `1 -hello` / `1 +goodbye`.
        if (/^\d+\s*-/.test(line)) row.className = 'del';
        else if (/^\d+\s*\+/.test(line)) row.className = 'add';
        detail.append(row);
      }
      card.append(detail);
    }

    if (p.question) {
      const q = document.createElement('div');
      q.className = 'perm-q';
      q.textContent = p.question;
      card.append(q);
    }

    const opts = document.createElement('div');
    opts.className = 'perm-opts';
    for (const o of p.options) opts.append(buildPermOption(s, o));
    card.append(opts);

    const err = document.createElement('div');
    err.className = 'perm-err';
    err.hidden = true;
    card.append(err);
    card._err = err;

    return card;
  }

  /**
   * One row of the permission card, and — for the yeses that cost more than the call in
   * front of you — a second click.
   *
   * The row this arms is decided by `classify` (`server/permission.js`), never by where it
   * sits in the list. Both broad kinds ask twice; which one it is, is carried by the note
   * rather than by a second colour, because the colour has one job — *this costs more than
   * the call you are looking at* — and the label above it already says whether that is a
   * path rule or the end of prompting. `approve-mode` is a distinct kind all the same: it
   * is the one row on this card that stops the session asking at all, and a consumer that
   * wants to refuse it outright must be able to tell it from a path grant.
   *
   * `needs-arming` is what carries the warning tint, not the tone class — the same choice
   * `web/m/cards.css` argues for and for the same reason: set by the very decision that
   * makes the row ask twice, so a calm-looking row can never fire on one click.
   *
   * **The label is never replaced, and this card keeps its own idiom deliberately.**
   * Everywhere else a destructive control is swapped for a question naming the action
   * (`armConfirm`), because the thing it replaced — a glyph or the word `merge` — named
   * nothing. Here the label already *is* the sentence, and it is the sentence you are
   * re-reading while you decide whether to click again:
   * `Yes, clear context (34% used) and bypass permissions` must not be taken off screen by
   * the very press that asks you to think about it. So the confirmation arrives underneath
   * it and the row stays put. Four seconds, then it disarms itself.
   */
  function buildPermOption(s, o) {
    const broad = o.kind === 'approve-always' || o.kind === 'approve-mode';

    const b = document.createElement('button');
    b.className = `perm-opt ${o.kind}${broad ? ' needs-arming' : ''}`;
    b.dataset.index = String(o.index);

    const num = document.createElement('span');
    num.className = 'perm-num';
    num.textContent = o.index;

    const body = document.createElement('span');
    body.className = 'perm-body';

    const label = document.createElement('span');
    label.className = 'perm-label';
    label.textContent = o.label;
    body.append(label);

    b.append(num, body);

    if (!broad) {
      b.onclick = () => answerPrompt(s.id, o);
      return b;
    }

    const confirm = document.createElement('span');
    confirm.className = 'perm-confirm';
    confirm.hidden = true;
    confirm.textContent =
      o.kind === 'approve-mode'
        ? 'sure? click again — this stops the session asking at all'
        : 'sure? click again — this grants a rule beyond this call';
    body.append(confirm);

    let armed = false;
    let timer = 0;
    const disarm = () => {
      armed = false;
      b.classList.remove('is-armed');
      confirm.hidden = true;
    };
    b.onclick = () => {
      if (!armed) {
        armed = true;
        b.classList.add('is-armed');
        confirm.hidden = false;
        clearTimeout(timer);
        timer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(timer);
      disarm();
      answerPrompt(s.id, o);
    };
    return b;
  }

  async function answerPrompt(sessionId, option) {
    const card = host.querySelector('.perm');
    const buttons = card ? [...card.querySelectorAll('.perm-opt')] : [];
    buttons.forEach((b) => (b.disabled = true));

    try {
      const res = await fetch(`/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The label goes along so the server can refuse if the box changed under us.
        body: JSON.stringify({ option: option.index, expectLabel: option.label }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        if (card?._err) {
          card._err.hidden = false;
          card._err.textContent = error || `Could not answer (${res.status}).`;
        }
        buttons.forEach((b) => (b.disabled = false));
      }
    } catch (err) {
      if (card?._err) {
        card._err.hidden = false;
        card._err.textContent = err.message;
      }
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  /**
   * `Schlepping` and three dots that actually tick, plus the elapsed time.
   *
   * The word-and-dots are rebuilt only when the word changes — the tick animation lives in
   * CSS on the three dot spans, so replacing them every two-second poll would restart it
   * mid-cycle and make the dots stutter rather than run. The duration ticks on every poll
   * regardless, so it's a separate span updated by `textContent` alone, never rebuilt.
   */
  function paintActivity(el, activity, seconds) {
    const word = activity || '';
    if (el.dataset.word !== word) {
      el.dataset.word = word;
      el.replaceChildren();
      if (word) {
        el.append(document.createTextNode(word));
        const dots = document.createElement('span');
        dots.className = 'tick-dots';
        for (let i = 0; i < 3; i += 1) {
          const d = document.createElement('span');
          d.textContent = '.';
          dots.append(d);
        }
        el.append(dots);
        const elapsed = document.createElement('span');
        elapsed.className = 'activity-elapsed';
        el.append(elapsed);
      }
    }
    if (!word) return;
    const elapsed = el.querySelector('.activity-elapsed');
    if (elapsed) elapsed.textContent = seconds != null ? ` ${formatElapsedFull(seconds)}` : '';
  }

  function updateComposerHint() {
    if (!composerEl) return;
    const s = current();
    const { hint, btn, activity, model, effort } = composerEl;
    hint.className = 'composer-hint';
    paintActivity(activity, s?.activity, s?.activitySeconds);

    // Repainted here rather than through `composerSig`, which would tear the whole composer
    // down — draft, focus, caret and all — every time a model changed. It is a label.
    if (model && s) {
      model.textContent = shortModel(s.model) || 'model';
      model.title = s.model
        ? `${s.model} — click to change it for this session only`
        : 'Choose a model for this session';
    }
    if (effort && s) effort.textContent = s.effort || 'effort';

    if (!s) return;
    btn.textContent = s.interactive && s.status !== 'idle' ? 'queue' : 'send';

    if (composerNote && Date.now() < composerNote.until) {
      hint.className = `composer-hint${composerNote.kind ? ` ${composerNote.kind}` : ''}`;
      hint.textContent = composerNote.text;
    } else if (!s.interactive) {
      hint.textContent = 'no tmux pane — read-only';
    } else if (isTrustGate(s.prompt)) {
      // The card above this line says the panel will not answer that box. "Answer the
      // prompt above" would send the reader looking for the button it just refused to
      // draw — and the box is not answerable from a browser at all.
      hint.className = 'composer-hint warn';
      hint.textContent = 'folder-trust gate — answer it at the Mac; messages wait until you do';
    } else if (s.status === 'dialog') {
      // The one the panel used to miss entirely: nothing is running, so this read as
      // `idle`, and the message went into the picker.
      hint.className = 'composer-hint warn';
      hint.textContent = `${s.dialog || 'a dialog'} is open in the terminal — messages wait for it`;
    } else if (s.status === 'working') {
      hint.className = 'composer-hint warn';
      hint.textContent = 'session is busy — your message will be held until it finishes';
    } else if (s.status === 'needs-decision') {
      hint.className = 'composer-hint warn';
      hint.textContent = 'answer the prompt above — messages wait until you do';
    } else {
      // Nothing in the way. The other branches all explain why a message would wait, so
      // there is nothing left to say here — the tmux name and pane id that used to sit
      // here were the same noise being removed from the header.
      hint.textContent = '';
    }
  }

  /* --------------------------------------------------------- completion --- */

  /**
   * Autocomplete for `/commands` and `@file` mentions.
   *
   * Triggers only where the token can start — beginning of input for `/`, and after
   * whitespace for `@` — so a URL or an email address in prose never opens a menu. The
   * list is advisory: nothing is forced, and typing something not on it still sends.
   */
  const completion = {
    open: false,
    kind: null, // 'command' | 'file'
    items: [],
    index: 0,
    start: 0, // index in the textarea where the token begins
    query: '',
    seq: 0,
    el: null,
  };

  function activeToken(value, caret) {
    const upto = value.slice(0, caret);

    // `/cmd` only counts as a command at the very start of the message.
    const slash = /^\/([a-zA-Z0-9:_-]*)$/.exec(upto);
    if (slash) return { kind: 'command', start: 0, query: slash[1] };

    // `@path` needs whitespace (or nothing) in front, so emails and URLs are left alone.
    const at = /(^|\s)@([^\s]*)$/.exec(upto);
    if (at) return { kind: 'file', start: caret - at[2].length - 1, query: at[2] };

    return null;
  }

  function closeCompletion() {
    completion.open = false;
    completion.items = [];
    completion.el?.remove();
    completion.el = null;
  }

  async function updateCompletion() {
    const s = current();
    if (!composerEl || !s) return closeCompletion();

    const ta = composerEl.ta;
    const token = activeToken(ta.value, ta.selectionStart ?? ta.value.length);
    if (!token) return closeCompletion();

    const seq = ++completion.seq;
    let items = [];
    try {
      if (token.kind === 'command') {
        const all = await commandsFor(s.id);
        const q = token.query.toLowerCase();
        items = all
          .filter((c) => c.name.toLowerCase().includes(q))
          .sort((a, b) => {
            const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
            const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
            return ap - bp || a.name.localeCompare(b.name);
          })
          .slice(0, 12)
          .map((c) => ({ label: `/${c.name}`, hint: c.argumentHint, detail: c.description, insert: `/${c.name} ` }));
      } else {
        const res = await fetch(`/api/sessions/${s.id}/files?q=${encodeURIComponent(token.query)}`);
        const body = await res.json();
        items = (body.files || []).map((f) => ({ label: f.path, insert: `@${f.path} ` }));
      }
    } catch {
      return closeCompletion();
    }

    // A slower request must never overwrite a newer one's results.
    if (seq !== completion.seq) return;
    if (!items.length) return closeCompletion();

    Object.assign(completion, { open: true, kind: token.kind, items, index: 0, start: token.start });
    renderCompletion();
  }

  const commandCache = new Map();
  async function commandsFor(sessionId) {
    if (commandCache.has(sessionId)) return commandCache.get(sessionId);
    const res = await fetch(`/api/sessions/${sessionId}/commands`);
    const body = await res.json();
    const list = body.commands || [];
    commandCache.set(sessionId, list);
    return list;
  }

  function renderCompletion() {
    completion.el?.remove();
    if (!completion.open || !composerEl) return;

    const box = document.createElement('div');
    box.className = 'complete';

    completion.items.forEach((item, i) => {
      const row = document.createElement('button');
      row.className = `complete-row${i === completion.index ? ' on' : ''}`;
      row.onmousedown = (e) => {
        e.preventDefault(); // keep focus in the textarea
        applyCompletion(i);
      };

      const label = document.createElement('span');
      label.className = 'complete-label';
      label.textContent = item.label;
      row.append(label);

      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'complete-hint';
        hint.textContent = item.hint;
        row.append(hint);
      }
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'complete-detail';
        detail.textContent = item.detail;
        row.append(detail);
      }
      box.append(row);
    });

    composerEl.wrap.prepend(box);
    completion.el = box;
    box.querySelector('.complete-row.on')?.scrollIntoView({ block: 'nearest' });
  }

  function applyCompletion(index) {
    const item = completion.items[index];
    if (!item || !composerEl) return;
    const ta = composerEl.ta;
    const caret = ta.selectionStart ?? ta.value.length;

    ta.value = ta.value.slice(0, completion.start) + item.insert + ta.value.slice(caret);
    const pos = completion.start + item.insert.length;
    ta.setSelectionRange(pos, pos);

    closeCompletion();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  /** Returns true when the popup consumed the key. */
  function completionKey(e) {
    if (!completion.open) return false;

    if (e.key === 'Escape') {
      closeCompletion();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      completion.index = (completion.index + step + completion.items.length) % completion.items.length;
      renderCompletion();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      applyCompletion(completion.index);
      return true;
    }
    return false;
  }

  /**
   * Images by their reported type, text files by their name — and the asymmetry is the
   * server's, not a shortcut here: a browser reports an empty `File.type` for a `.md` often
   * enough that a type test would refuse the ordinary case. The server re-decides both,
   * on magic bytes and on a strict UTF-8 read, so this is a filter and not a gate.
   *
   * **Only real files, which is what keeps pasted *text* out of it.** `dt.files` is empty
   * when you paste a paragraph — that arrives as a string item — so the textarea gets it,
   * as it always has. Both callers also return early on an empty list, and that is the
   * same guarantee said twice rather than one of them being redundant.
   */
  function attachableFiles(dt) {
    if (!dt) return [];
    return [...(dt.files || [])].filter((f) => f.type?.startsWith('image/') || isTextName(f.name));
  }

  /**
   * Upload each file, then drop its path into the message.
   *
   * The path is plain visible text, not a hidden attachment: Claude Code reads it with
   * the Read tool exactly as it does when you drop a file into the terminal, and you can
   * see and edit what you're about to send.
   */
  async function attachFiles(files, sessionId) {
    if (!composerEl) return;

    for (const file of files) {
      setComposerNote(`uploading ${file.name || 'file'}…`);
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name || 'pasted'),
          },
          body: file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setComposerNote(body.error || `Upload failed (${res.status}).`, 'err');
          return;
        }

        state.attachments[sessionId] = [
          ...attachmentsFor(sessionId),
          // The original name is what you recognise; the path is plumbing. `bytes` is only
          // drawn on a text chip, which has no thumbnail to say how much file this is.
          { path: body.path, name: body.name, label: file.name || body.name, bytes: body.bytes },
        ];
        persistDrafts();
        renderAttachments();
        composerEl.ta.focus();
        setComposerNote(`attached ${file.name || body.name}`);
      } catch (err) {
        setComposerNote(err.message, 'err');
        return;
      }
    }
  }

  /** The strip of pending images above the textarea. */
  function renderAttachments() {
    if (!composerEl?.strip) return;
    const list = attachmentsFor(view.selected);
    const strip = composerEl.strip;
    strip.replaceChildren();
    strip.hidden = list.length === 0;

    list.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'attach';

      if (isTextName(a.name)) {
        chip.append(docGlyph());
      } else {
        const thumb = document.createElement('img');
        thumb.className = 'attach-thumb';
        thumb.src = `/api/image/${encodeURIComponent(a.name)}`;
        thumb.alt = '';
        chip.append(thumb);
      }

      const name = document.createElement('span');
      name.className = 'attach-name';
      name.textContent = a.label || a.name;
      name.title = a.path;
      chip.append(name);

      // Only on a text chip: a thumbnail already says roughly how much file there is, and
      // a size beside every image would be new furniture on a strip that reads fine now.
      const size = isTextName(a.name) ? shortBytes(a.bytes) : '';
      if (size) {
        const bytes = document.createElement('span');
        bytes.className = 'attach-bytes';
        bytes.textContent = size;
        chip.append(bytes);
      }

      const rm = document.createElement('button');
      rm.className = 'attach-remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.setAttribute('aria-label', `Remove ${a.label || a.name}`);
      rm.onclick = () => {
        state.attachments[view.selected] = attachmentsFor(view.selected).filter((_, n) => n !== i);
        if (!state.attachments[view.selected].length) delete state.attachments[view.selected];
        persistDrafts();
        renderAttachments();
        updateComposerHint();
      };
      chip.append(rm);

      strip.append(chip);
    });

    if (composerEl.btn) {
      composerEl.btn.disabled = !current()?.interactive;
    }
  }

  /**
   * A note is what just happened; the hint underneath it is why a message would wait.
   *
   * It is held as state rather than written straight onto the node because the node is not
   * safe to write on: any roster frame repaints the hint, and a composer rebuild replaces
   * it outright. That was always a race — a frame landing in the wrong half-second wiped a
   * note that had barely been drawn — and the model picker made it certain, because the
   * answer it paints from is exactly the thing that makes the next frame differ. The note
   * that says a model was set **for this session only** is not one to lose to a repaint:
   * in this one dialog the alternative is the global default, which is most of what
   * `server/model.js` is about.
   *
   * Four seconds, then the hint goes back to saying whatever is true. Nothing outranks a
   * note inside that window, which is the behaviour that was already there — "switching
   * to…" is drawn over a `dialog is open` warning today — and it is safe because a note
   * only ever exists as the direct answer to something the reader just clicked.
   */
  const NOTE_MS = 4000;
  let noteTimer = null;
  let composerNote = null; // { text, kind, until }

  function setComposerNote(text, kind = '') {
    if (!composerEl) return;
    composerNote = { text, kind, until: Date.now() + NOTE_MS };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      composerNote = null;
      updateComposerHint();
    }, NOTE_MS);
    updateComposerHint();
  }

  async function submit() {
    const s = current();
    if (!s?.interactive || !composerEl) return;

    const typed = composerEl.ta.value.trim();
    const attached = attachmentsFor(s.id);
    if (!typed && !attached.length) return;

    // Paths lead, the way a dropped file does in the terminal — Claude reads them first,
    // then the question about them.
    const text = [...attached.map((a) => a.path), typed].filter(Boolean).join(' ');

    composerEl.ta.value = '';
    composerEl.ta.style.height = 'auto';
    clearDraft(s.id);
    delete state.attachments[s.id];
    persistDrafts();
    renderAttachments();

    // Whether this goes now or waits is the server's call — it is the one that will still
    // be here in two seconds when the session frees up.
    const ok = await deliver(s.id, text);
    // If it didn't go, put it back rather than swallowing what you wrote.
    if (!ok) {
      if (typed) state.drafts[s.id] = typed;
      if (attached.length) state.attachments[s.id] = attached;
      persistDrafts();
      if (view.selected === s.id && composerEl) {
        composerEl.ta.value = typed;
        renderAttachments();
      }
    }
  }

  async function deliver(sessionId, text) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showSendError(body.error || `Send failed (${res.status}).`);
        return false;
      }
      // Held rather than typed. The list above the composer says so; this is just the
      // acknowledgement that the keystroke did something.
      if (body.queued) setComposerNote('queued — it goes when this session is free', 'warn');
      return true;
    } catch (err) {
      showSendError(err.message);
      return false;
    }
  }

  function showSendError(message) {
    if (!composerEl) return;
    composerEl.hint.className = 'composer-hint err';
    composerEl.hint.textContent = message;
  }

  /** Drop something you typed ahead and thought better of. */
  async function unqueue(sessionId, itemId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/queue/${itemId}`, { method: 'DELETE' });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        setComposerNote(error || `Could not drop that (${res.status}).`, 'err');
      }
    } catch (err) {
      setComposerNote(err.message, 'err');
    }
  }

  async function sendKey(action) {
    const s = current();
    if (!s?.interactive) return;
    await fetch(`/api/sessions/${s.id}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => {});
  }


  /** Route a websocket message meant for this pane. */
  function receive(msg) {
    /*
     * The shared room's two frames, ahead of the guard below because they are the one thing
     * a pane holding something that is not a session is *entitled* to receive. `shared` is
     * the tail, sent once when the subscription is taken; `shared-append` is one entry.
     *
     * Both are checked against this pane actually holding the room. The subscription is one
     * per **socket** rather than one per slot (`server/index.js`), and the frames carry the
     * slot of whoever asked — so a pane that has since been given a session must not go on
     * accumulating a log it is not drawing.
     */
    /*
     * One group room's frames, and they are `group-room` / `group-room-append` rather than
     * `room` / `room-append` for the reason `server/index.js`'s own block gives: those two
     * are the **team** room's, keyed by `repo`, and a frame arriving under one of them with a
     * `roomId` and no `repo` is a frame the team-room handler below silently swallows.
     *
     * Both are checked against this pane actually holding **this** room. The subscription is
     * one per **socket** rather than one per slot, and the frames carry the slot of whoever
     * asked — so a pane that has since been given a session, or another room, must not go on
     * accumulating a log it is not drawing.
     */
    if (msg.type === 'group-room') {
      if (view.kind !== 'group-room' || msg.roomId !== view.groupRoom?.id) return;
      // A room the server says is not there. The record stands as far as this pane knows —
      // the roster is what carries it — and an empty log is drawn rather than a blank pane.
      if (msg.room) view.groupRoom = msg.room;
      view.groupEntries = msg.entries || [];
      view.groupCursor = msg.cursor || 0;
      renderGroup();
      renderGroupStrip();
      return;
    }
    if (msg.type === 'group-room-append') {
      if (view.kind !== 'group-room' || msg.roomId !== view.groupRoom?.id || !msg.entry) return;
      view.groupEntries.push(msg.entry);
      view.groupCursor = msg.entry.seq || view.groupCursor;
      renderGroup();
      // The reader is at the newest line, so the count is spent the moment this lands.
      // Scrolled up it is not spent, and the `N new below` pill over the box is what says so
      // — the band row stays quiet either way while the room is on screen (`patchBand` zeroes
      // it for an open room), because two counters saying different things about one box is
      // worse than one saying it in the right place.
      if (view.groupFollow !== false) markGroupSeen();
      return;
    }

    if (msg.type === 'shared') {
      if (view.kind !== 'shared') return;
      view.shared = msg.entries || [];
      view.sharedCursor = msg.cursor || 0;
      renderShared();
      return;
    }
    if (msg.type === 'shared-append') {
      if (view.kind !== 'shared' || !msg.entry) return;
      view.shared.push(msg.entry);
      view.sharedCursor = msg.entry.seq || view.sharedCursor;
      renderShared();
      // The reader is at the newest line, so the count is spent the moment this lands.
      // Scrolled up it is not spent, and the `N new below` pill over the box is what says
      // so — the rail row stays quiet either way while the room is on screen
      // (`renderSharedRow` zeroes it for an open pane), because two counters saying
      // different things about one box is worse than one saying it in the right place.
      if (view.sharedFollow !== false) markSharedSeen();
      return;
    }

    // Nothing addressed to a session or a team room belongs to a pane holding a thread or
    // the shared room. Every branch below already tests `view.selected` or `roomView.repo`,
    // both of which are null here — but `error` does not, and it would call `renderMain` on
    // a pane holding something the message has nothing to do with. Said once, at the top,
    // rather than five times.
    if (view.kind !== 'session') return;

    switch (msg.type) {
      case 'transcript':
        if (msg.sessionId !== view.selected) return;
        view.messages = msg.messages;
        view.hasEarlier = msg.hasEarlier;
        view.error = null;
        renderMain();
        return;
      case 'messages':
        if (msg.sessionId !== view.selected) return;
        appendMessages(msg.messages);
        return;
      case 'earlier':
        if (msg.sessionId !== view.selected) return;
        view.messages = msg.messages.concat(view.messages);
        view.hasEarlier = msg.hasEarlier;
        renderMain();
        return;
      case 'rebound':
        // A session we were watching just earned its real id — follow it silently, and
        // carry any half-written message across with it.
        if (state.drafts[msg.from]) {
          state.drafts[msg.to] = state.drafts[msg.from];
          delete state.drafts[msg.from];
          persistDrafts();
        }
        if (view.selected === msg.from) {
          view.selected = msg.to;
          view.lastMarked = null;
          rememberOpen(slot, msg.to);
          renderRail();
        }
        return;
      case 'room':
        if (msg.repo !== roomView.repo) return;
        roomView.entries = msg.entries || [];
        roomView.cursor = msg.cursor || 0;
        // Where this room starts, off the server on the opening frame. A window that has
        // just connected therefore draws exactly what one that was already open draws.
        roomView.slate = slateActive(msg.slate) ? msg.slate : null;
        renderRoom();
        return;
      /*
       * The slate moved — `clear` or `show all`, pressed here or in another window, on this
       * Mac or on the phone. The fact is on the server, so every open client is told; that
       * is the whole reason it is not a `localStorage` key.
       *
       * Named in the **team room's** `room-` family, not a `rooms-`/`slate-` sibling: a frame
       * this switch does not know is swallowed in silence, and one letter between two
       * different things is the naming trap CLAUDE.md keeps a section on.
       *
       * `follow` is put back on and `unseen` zeroed, because both are answers about a list
       * that has just been replaced wholesale — the reader is being handed a different room,
       * not scrolled inside the one they were reading, and a "3 new below" over it would be
       * counting lines that are no longer there.
       */
      case 'room-slate':
        if (msg.repo !== roomView.repo) return;
        roomView.slate = slateActive(msg.slate) ? msg.slate : null;
        roomView.follow = true;
        roomView.unseen = 0;
        renderRoom();
        return;
      case 'room-append':
        if (msg.repo !== roomView.repo) return;
        roomView.entries.push(msg.entry);
        roomView.cursor = msg.entry.seq;
        /*
         * A line arrived. If this aside is shut, it is the *only* thing that will say so:
         * `roomView.unseen` below counts only while `follow` is false — "arrived while you
         * were scrolled up" — and a folded aside is still following, so it stays at zero
         * behind a shut door. The team room has no server-side unread either.
         *
         * Asked of the panel's own class rather than of `asideFolded`, because the class is
         * what is true on screen: mid-fold, and for a pane that has not caught up with the
         * preference yet, the flag and the panel disagree and the panel is right.
         */
        if (roomView.panelEl?.classList.contains('is-strip')) {
          roomView.foldedUnseen += 1;
          roomView.foldedPulse = true;
          renderAsideStrip();
        }
        renderRoom();
        return;
      case 'error':
        view.error = msg.message;
        renderMain();
    }
  }

  /**
   * The roster moved. If this pane is showing nothing, take the session it was showing
   * last — and only if that's gone, the best one going. Never one the other pane already
   * has, or a split would open as a duplicate.
   *
   * This is what a refresh runs through: the first roster frame finds an empty pane and
   * puts back what you were reading, rather than dropping you on whatever happens to sort
   * first that second.
   */
  function adopt() {
    /*
     * **The sharpest trap in this feature, and it is one line.**
     *
     * The test below is `view.selected` against the roster. A pane holding a thread has no
     * `view.selected` at all, so it fails that test, falls through, and is opened onto
     * whatever session is free — and the roster broadcasts on every change, so this fires
     * within seconds and reads as the thread "randomly closing". A thread is something the
     * maintainer opened on purpose and it stays until it is closed (the locked ruling), so
     * the answer is not a better pick: it is not picking at all.
     */
    if (view.kind !== 'session') return;

    if (view.selected && state.sessions.some((s) => s.id === view.selected)) return;
    const taken = panes.filter((p) => p !== api).map((p) => p.selected());
    const free = (s) => !taken.includes(s.id);
    const last = state.opened[slot];

    /*
     * A reload of a window that had the shared room open. Restored unconditionally: there
     * is no record behind it that could have been deleted, and there always is a room. The
     * `threadSplit` restore is what makes a reloaded window answer "what does closing this
     * do" the way the window it replaced would have.
     */
    if (last?.kind === 'shared') {
      threadSplit = Boolean(last.autoSplit);
      return openShared();
    }

    /*
     * A reload of a window that had a group room open. Restored **only if the room is still
     * there**, unlike the shared room above, because a room is a record that can be gone from
     * the index by hand and a pane put back onto one would draw a name with nothing behind
     * it. Archived is not gone: the roster carries every room, so an archived room comes
     * back read-only, which is what it is.
     */
    if (last?.kind === 'group-room') {
      if (state.rooms.some((r) => r?.id === last.room)) {
        threadSplit = Boolean(last.autoSplit);
        return openGroup(last.room);
      }
      rememberOpenGroup(slot, null);
    }

    const pick =
      (last && state.sessions.find((s) => s.id === last.id && free(s))) ||
      // The id rotated while the tab was closed — same terminal, new conversation.
      (last?.paneId && state.sessions.find((s) => s.paneId === last.paneId && free(s))) ||
      state.sessions.find(free);
    if (pick) open(pick.id);
  }

  function close() {
    // Peer messages has no draft to save: it is a log to read, not a box to type in — and
    // `saveDraft` keys by `view.selected`, which is null there anyway. The unsubscribe goes
    // out either way: this slot may have been showing a session a moment ago, and an
    // unsubscribe for a slot with nothing on it costs the server nothing.
    //
    // A group room's draft is keyed by the room rather than by `view.selected`: there are
    // many rooms and a draft written for one must never be restored into another, which is
    // why it is its own call rather than something `saveDraft` could be taught.
    if (view.kind === 'group-room') saveGroupDraft();
    else saveDraft();
    send({ type: 'unsubscribe', slot });
    // The room's subscription is server state like a tailer's, and a pane that stopped
    // drawing it while the server went on pushing entries into a dead slot is the
    // "subscription that outlives its slot" trap from the other end. Harmless for a socket
    // about to close, load-bearing for a slot closed while the window stays open.
    if (view.kind === 'shared') send({ type: 'unsubscribe-shared', slot });
    // …and a group room's, for every word of the same reason.
    if (view.kind === 'group-room') send({ type: 'unsubscribe-group-room', slot });
    host.remove();
  }

  /** Ask for this pane's transcript again, after a reconnect. */
  function resubscribe() {
    /*
     * The room *is* a subscription, so it is re-taken exactly as a transcript's is — and it
     * is the one this trap was written about. A subscription is server state and dies with
     * the socket, while the roster keeps arriving because that is broadcast to every
     * client: without this the rail goes on looking alive above a room that silently
     * stopped at the moment the connection dropped. The server answers `subscribe-shared`
     * with the whole tail, so nothing has to be reconciled here.
     */
    if (view.kind === 'shared') return void send({ type: 'subscribe-shared', slot });

    /*
     * …and a group room's, which is the same server state under a different name and dies the
     * same way. Without this the rail's band goes on drawing an open room above a pane that
     * silently stopped at the moment the connection dropped — the failure the panel cannot
     * see from the inside, shipped once already in the transcript pane. The server answers
     * `subscribe-group-room` with the whole tail, so nothing has to be reconciled here.
     */
    if (view.kind === 'group-room' && view.groupRoom?.id) {
      return void send({ type: 'subscribe-group-room', roomId: view.groupRoom.id, slot });
    }

    if (view.selected) send({ type: 'subscribe', sessionId: view.selected, slot });
    // The room subscription is server state too, and dies with the socket the same way
    // a tailer does — this is the exact shape of the "silently stopped transcript" trap.
    if (roomView.repo) send({ type: 'subscribe-room', repo: roomView.repo, slot });
  }

  const api = {
    slot,
    host,
    open,
    openShared,
    close,
    adopt,
    resubscribe,
    receive,
    renderHead,
    renderStream,
    /* Re-pin this pane's room after something changed the height of the box it is scrolled
     * inside. Exposed because the thing that changes that height is a *resizer*, which
     * lives outside every pane — see `pinRooms`. */
    pinRoom,
    /* Repaint this pane's TASKS block. Exposed for the same reason `pinRoom` is: the thing
     * that changes it — the `hide finished` filter — is one answer for the browser and
     * lives outside every pane. See `renderTaskLists`. */
    renderTasks,
    /* Put this pane's aside where `asideFolded` says. Exposed for the same reason again:
     * the fold is one answer for the browser and a press in one aside has to reach the
     * other. See `foldAsides`. A pane with no lead in it has no panel and answers by doing
     * nothing, which is why the fan-out can be unconditional. */
    foldAside: applyAsideFold,
    /*
     * This pane's team aside, and **only while its door is actually open** — otherwise null.
     * The auto-collapse asks it two questions in one: is there an aside in the way of a room
     * about to open, and which node does that fold's `transitionend` arrive on.
     *
     * Asked of the panel's own class rather than of `asideFolded`, for `renderAsideStrip`'s
     * reason one function up: mid-fold the preference and the panel disagree, and the panel
     * is the one that is right. A pane with no lead in it has no panel and answers null,
     * which is what lets the caller ask every pane unconditionally.
     */
    expandedAside: () =>
      roomView.panelEl?.isConnected && !roomView.panelEl.classList.contains('is-strip')
        ? roomView.panelEl
        : null,
    /*
     * The session this pane is showing, and **null while it is showing anything else** —
     * said explicitly rather than leaning on `view.selected` happening to be null. Three
     * things read this and every one of them means "which session is on screen": the rail's
     * open marker, `adopt`'s don't-take-what-the-other-pane-has list, and ⇧⇥. A room is none
     * of their business, and a pane that answered with the session it held *before* the room
     * would mark a row open that nobody is looking at.
     *
     * Written as "only when it *is* a session" rather than as a negative, because kinds have
     * already grown twice here and a negative test silently admits the next one —
     * `benchEntries`' recorded reasoning, and the same shape `roomParticipants` is written in.
     */
    selected: () => (view.kind === 'session' ? view.selected : null),
    /*
     * What this pane is holding, as a word, and what every routing decision outside the
     * factory asks. The question they are all really asking is "can this pane hold a
     * session", and asking any *one* view's id instead answers `null` for a pane that is
     * emphatically not a session — the mismatch that was the navigation regression #36: a
     * rail click resolving to a pane that was showing something else, and taking it away.
     */
    kind: () => view.kind,
    /** Is the shared room in this pane? The rail row reads it to mark itself open. */
    sharedOpen: () => view.kind === 'shared',
    /** Put one group room in this pane. `openGroupRoom` is the only caller — it decides
     *  *which* pane, the way `openSharedRoom` does. */
    openGroup,
    /** The group room this pane is holding, or null — the same question `sharedOpen` asks
     *  from the other side, and what the rail's band reads to mark a row open. It is also
     *  what `roomPane` asks, which is how the fold's bookkeeping stays derived rather than
     *  stored: a slot that has stopped holding a room answers `null` and loses its class in
     *  the same beat. */
    groupRoomId: () => (view.kind === 'group-room' ? view.groupRoom?.id ?? null : null),
    /* ---- the fold's five hooks. Exposed for `renderTasks`' own reason: the geometry lives
     * on `.main`, which is one box for the whole frame, while everything it moves is per
     * pane. `applyRoomFold` measures through `stripWidth`, pins through `freezeGroupBody`,
     * arms through `setFolding`, changes the value through `setFolded` and lands through
     * `endFold` — five steps in a fixed order, which is why they are five names rather than
     * one. Every one is a no-op for a pane holding anything else, which is what lets the
     * fan-out say them unconditionally. ---- */
    stripWidth,
    freezeGroupBody,
    setFolding: setGroupFolding,
    setFolded: setGroupFolded,
    endFold: endGroupFold,
  };
  return api;
}

/* =========================================================== the panes === */

/**
 * One pane, or two side by side.
 *
 * The rail always drives the *focused* pane, so opening a session is the same click it
 * always was; which side it lands on is whichever you last touched. That keeps the split
 * out of the way of the common case, where there is only one pane and focus is moot.
 */
const panes = [];
let focusedSlot = 'a';

/**
 * Whether the second pane exists **because a room was opened**, rather than because
 * somebody asked for split view.
 *
 * Closing a room has to put the panel back where it came from, and "back" is two
 * different places: a reader who was in one pane and pressed the row gets one pane back,
 * a reader who was already in split keeps both and that slot goes back to a session. The
 * pane cannot tell those apart by looking at itself — this is the one fact that separates
 * them, so it is written down when the split is made rather than guessed at afterwards.
 */
let threadSplit = false;

const focused = () => panes.find((p) => p.slot === focusedSlot) || panes[0];

/**
 * The pane a session opens into — and the fix for the navigation regression in #36.
 *
 * "The rail drives the focused pane" was true and sufficient right up until a pane could
 * hold something that is not a session. Opening one focused the pane it went into, so the
 * very next rail click resolved to *that* slot: `open()` turned the pane back into a
 * session, what it was holding was gone, and the split the panel had opened for itself
 * stayed — after which every click filled the second slot instead of replacing the first,
 * which is navigation having stopped behaving like navigation.
 *
 * Measured before the fix, on a scratch panel: one pane showing `alpha-lead`, open a
 * non-session view, click `alpha-lead` in the rail — it is drawn **twice**, each with its
 * own aside, the view gone and the split permanent.
 *
 * So a session resolves to a pane that can hold one: the focused pane when it is showing a
 * session, otherwise the other one. A thread is a thing you consult *beside* what you were
 * doing, and ordinary navigation must never be what takes it away — that is the locked
 * ruling ("once open it stays until closed") read from the navigation side.
 *
 * The one case with no session pane to find is a thread left alone after its neighbour was
 * closed by hand. There is nowhere else for the click to go, so it takes that pane: the
 * reader closed the other one themselves, and a rail click that did nothing at all would
 * be the worse answer.
 */
function sessionPane() {
  const here = focused();
  if (here && here.kind() === 'session') return here;
  return panes.find((p) => p.kind() === 'session') || here;
}

/**
 * Open a session, in the pane a session belongs in, and focus that pane.
 *
 * Every path that means "show me this conversation" comes through here — a rail row, ⇧⇥, a
 * notification, and a session just launched or duplicated — so there is one answer to
 * *which pane*, not five copies of `focused().open`. The pane the click changed is the pane
 * the keyboard should now be in, which is what makes the split's focus ring keep pointing
 * at the half a click will move.
 */
function openSession(id) {
  const pane = sessionPane();
  if (!pane) return;
  // The only way here lands on a room is the last-pane fallback above, and it is about to
  // stop being one — so the split is nobody's any more.
  if (pane.kind() !== 'session') threadSplit = false;
  setFocus(pane.slot);
  pane.open(id);
}

function addPane(slot) {
  const host = document.createElement('section');
  host.className = 'pane';
  host.dataset.slot = slot;
  /*
   * Focus follows the click rather than a control, because every click in a pane is
   * already a statement about which one you are working in — with one exception, and it is
   * the fold's.
   *
   * A press on a folded panel's strip is a press on a *door*: it says "open this", not
   * "this is the pane I am working in". Without the guard the focus ring would draw on a
   * 2.5rem column, and the ring is on `.main-head`'s top border, which is inside the very
   * content the strip is standing in front of. Harmless beyond the ring today —
   * `sessionPane()` sends a rail click to a pane that can hold a session regardless — and
   * `sessionPane` is deliberately left alone: this is a fact about one control, not about
   * how the rail routes.
   *
   * The listener is in the **capture** phase, so it runs before anything inside the pane and
   * `stopPropagation` on the strip could never reach it. Asking what was pressed is the only
   * thing that can.
   */
  host.addEventListener(
    'mousedown',
    (e) => {
      if (e.target instanceof Element && e.target.closest('.fold-strip')) return;
      setFocus(slot);
    },
    true,
  );
  host.addEventListener('focusin', () => setFocus(slot));
  el.main.append(host);

  const pane = createPane(slot, host);
  panes.push(pane);
  return pane;
}

function setFocus(slot) {
  if (focusedSlot === slot && panes.length > 1) return;
  focusedSlot = slot;
  paintFocus();
}

function paintFocus() {
  // A single pane is never marked — there is nothing to distinguish it from.
  for (const pane of panes) {
    pane.host.classList.toggle('focused', panes.length > 1 && pane.slot === focusedSlot);
  }
  el.app.classList.toggle('split', panes.length > 1);
  // The fold's own bookkeeping rides the same beat, and it is derived from what the panes
  // hold rather than remembered — see `paintFolds`. Here because focus changes are one of
  // the two ways the shape of the frame moves; the four kind-changing entry points are the
  // other, and each calls it for itself.
  paintFolds();
}

/* ------------------------------------------------- the room slot, folded --- */

/**
 * How long a room slot's fold takes, in milliseconds.
 *
 * Spelled here and in `.app.is-folding .main`'s transition; this copy times the backstop
 * that drops the inline track pair and remeasures, so the two drifting apart costs a
 * remeasure taken slightly early rather than anything visible. 200 is the aside's number
 * one panel over and the settings fold's before that — a second duration in the same frame
 * would read as a second mechanism.
 */
const ROOM_FOLD_MS = 200;

/** The backstop for the end of a fold. Module scope, because the thing that animates is
 *  `.main` and there is exactly one of it. */
let roomFoldTimer = null;

/**
 * Which slot holds a group room, or `null`.
 *
 * Asked of the pane rather than of anything stored, which is the whole of this feature's
 * bookkeeping rule: a slot that no longer holds a room cannot stay folded, because the
 * question is re-asked every time the frame's shape moves. **A room can be in slot `a`** —
 * `openGroupRoom` puts it in the pane you are *not* focused in, which is `panes[0]` when
 * focus is on `b`, so any design that assumes the room is the second column is wrong half
 * the time.
 */
function roomPane() {
  return panes.find((p) => p.groupRoomId()) || null;
}

/**
 * Which slot should be folded right now — `'a'`, `'b'` or `null`.
 *
 * Three conditions and every one of them fails **open**, because the worst thing this
 * feature can produce is a 2.5rem *session* pane and the second worst is a frame that is
 * nothing but a strip. There has to be a room on screen, the preference has to say folded,
 * and there has to be a second pane for the room to fold *beside* — a room alone in the
 * frame folded to a strip would leave the panel with no content at all and no obvious way
 * back, which is why the fold control is not drawn in that state either.
 */
function roomFoldSlot() {
  if (panes.length < 2 || !roomFolded.on) return null;
  return roomPane()?.slot ?? null;
}

/** The two geometry classes, set together so they can never both be on. On `.app` rather
 *  than on `.main`, because `.app.split` is already the switch the track list keys off and
 *  a fold is that switch with one more word on it. */
function setFoldClasses(slot) {
  el.app.classList.toggle('fold-a', slot === 'a');
  el.app.classList.toggle('fold-b', slot === 'b');
}

/**
 * Put the frame where the preference says, **without animating**.
 *
 * Beside `paintFocus` and called from it, and from each of the four kind-changing entry
 * points (`open`, `openShared`, `openGroup`, `closeGroup`/`closePane`) — everywhere a slot
 * can start or stop holding a room. Nothing here is stored: the answer is re-derived from
 * `panes` every time, so a slot that has been given a session loses the class in the same
 * beat it stops being a room.
 *
 * It does not animate and must not. Every transition in this fold is gated on
 * `is-folding`, which only `applyRoomFold` adds — so a class applied here, on a reload's
 * `adopt` or on a pane being closed, simply *is* the layout, with nothing for a transition
 * to run between. That is the same guarantee item 2 bought by building its aside folded,
 * arrived at from the other side.
 */
function paintFolds() {
  const slot = roomFoldSlot();
  /*
   * The panes first, the frame second, and the order is a measurement rather than a style.
   *
   * `setFolded` is the path that pins the content's width for a fold nothing animated — a
   * reload's `adopt`, a slot changing hands — and it reads the pane's own rect to do it.
   * Setting the frame's class first makes that rect **2.5rem**, so the content is frozen at
   * the width it is about to be clipped to instead of the width it was measured at, and the
   * room's five-line clamp then caches its answers against a strip. Benched on a reload:
   * `--room-frozen` came back `40px` where it should read the open pane's width.
   *
   * Unfolding does not measure at all, so this order costs it nothing.
   */
  for (const pane of panes) pane.setFolded?.(pane.slot === slot);
  setFoldClasses(slot);
}

/**
 * Fold the room's slot down to a strip, or open it again — animated.
 *
 * The whole of it in one function, because every step depends on the one before it and
 * splitting them would be four places that have to agree about an order.
 *
 * **Why it cannot be a class swap.** The resting layouts are declarative — `var(--pane-a)
 * 1fr` open, `var(--strip) 1fr` folded — and `1fr` does not interpolate with a length:
 * `50% 1fr` → `2.5rem 1fr` animates and `50% 1fr` → `1fr 2.5rem` does not. So the fold runs
 * through an explicit px pair (`foldTracks`, which is the arithmetic and is tested in node)
 * and only lands on the declarative class at the end.
 *
 * **And why it cannot be `--pane-a`.** `applyResizers()` re-applies the stored width on
 * every `window.resize`, so a fold expressed through the variable the split resizer owns
 * would be silently undone by a window drag. The classes beat `.app.split .main` on
 * specificity instead, and `foreman.paneWidth` comes back untouched on expand.
 *
 * **Measure, freeze, arm, then change the value** — and the reflow is `void offsetWidth`,
 * never `requestAnimationFrame`: an automated Chrome window reports `visibilityState:
 * 'hidden'` and Chrome suspends frame callbacks there, which this repo has lost an hour to
 * more than once.
 *
 * Expanding, the width to animate *to* is the stylesheet's answer and not something this
 * function may compute — `var(--pane-a)`, or half and half where `splitFits` refuses it. So
 * it is measured the only honest way: classes off, read both rects, classes straight back
 * on, all inside one synchronous block, so no frame ever paints the open frame without its
 * transition armed.
 */
function applyRoomFold(want) {
  const target = roomPane();
  const slot = target?.slot ?? null;
  const folded = el.app.classList.contains('fold-a') || el.app.classList.contains('fold-b');
  // Nothing to animate: no room on screen, no second pane to fold beside, or the frame is
  // already where it is being asked to go. The bookkeeping still runs — the preference may
  // have moved even where the geometry cannot.
  if (!slot || panes.length < 2 || folded === Boolean(want)) {
    paintFolds();
    return;
  }

  const widthOf = (s) => panes.find((p) => p.slot === s)?.host.getBoundingClientRect().width || 0;
  const stripW = target.stripWidth();
  const frameW = el.main.getBoundingClientRect().width;
  // A strip with no rect is a pane that has not been laid out, not a strip of zero width —
  // and animating to a zero track would fold the room to nothing and then jump to `--strip`
  // when the declarative class landed. The bookkeeping still applies the fold; only the
  // animation is skipped, which is the same thing reduced motion gets.
  if (!stripW || !frameW) {
    paintFolds();
    return;
  }

  let aW;
  let bW;
  if (want) {
    aW = widthOf('a');
    bW = widthOf('b');
  } else {
    // Off, read, on — one synchronous block, so this never reaches a paint.
    setFoldClasses(null);
    aW = widthOf('a');
    bW = widthOf('b');
    setFoldClasses(slot);
    void el.main.offsetWidth;
  }
  const { from, to } = foldTracks({ frameW, aW, bW, stripW, fold: slot });
  const start = want ? from : to;
  const end = want ? to : from;

  // The content's own width, pinned while the expanded geometry is still in force. Read
  // here rather than inside the pane so it is one measurement rather than a second rect
  // taken a line later against tracks that have moved.
  target.freezeGroupBody(slot === 'a' ? aW : bW);

  /*
   * **Two flushes, and the first one is not redundant — measured, and getting it wrong is
   * the `1fr` trap reappearing one step earlier than the design expected it.**
   *
   * A transition's start value is the computed value as of the previous style change, and
   * whether it starts at all is decided by the *after*-change style's `transition-property`.
   * So arming `is-folding` in the same recalculation that first writes the px pair starts a
   * transition **from the declarative value** — `var(--pane-a) 1fr` open, `1fr var(--strip)`
   * folded — and a length does not interpolate with `1fr`: that track goes **discrete** and
   * jumps at exactly half the duration while the other one eases past it. Setting the end
   * pair a line later only retargets that same transition, so the px pair never rescues it.
   *
   * Benched at 1470px before this line existed: `grid-template-columns` read
   * `799.86px 350.14px` at 59ms and `1007.37px 40px` at 107ms — one track still easing, the
   * other already home, the pair summing to 1047 in a 1150px frame. That is a 100px hole of
   * bare `--ground` opening between the two panes halfway through every fold.
   *
   * So the start pair is settled **unarmed** first, and only then is the transition armed at
   * a value that is two lengths. Both flushes are `void offsetWidth` rather than a frame
   * callback, for the reason above.
   */
  el.main.style.gridTemplateColumns = `${start[0]}px ${start[1]}px`;
  void el.main.offsetWidth; // the declarative track list is gone before anything is armed
  el.app.classList.add('is-folding');
  for (const pane of panes) pane.setFolding?.(true);
  void el.main.offsetWidth; // …and now the armed state is settled, at two plain lengths

  el.main.style.gridTemplateColumns = `${end[0]}px ${end[1]}px`;
  setFoldClasses(want ? slot : null);
  for (const pane of panes) pane.setFolded?.(Boolean(want) && pane.slot === slot);

  clearTimeout(roomFoldTimer);
  roomFoldTimer = setTimeout(endRoomFold, ROOM_FOLD_MS + 60);
}

/* ------------------------------------------------- the auto-collapse --- */

/**
 * The team aside standing between the reader and a room about to open, or `null`.
 *
 * A lead's aside and a room are the two side panels this feature exists for, and having both
 * open is the four-column state the maintainer asked to be rid of — so opening a room folds
 * the aside out of the way first, **every time** rather than only the first, and the aside's
 * remembered flag is set exactly as if the band's own icon had been pressed. No second
 * state, no special case, nothing to explain to a reader who then presses the icon themselves.
 *
 * `skip` is the pane the room is about to be put in, or `null` when nothing is being
 * replaced. An aside inside *that* pane is not in the way — it is going away with its pane —
 * and folding it would animate a panel nobody will see again.
 *
 * The first one wins, and there is only ever one in practice: a lead is not opened in split
 * (`decisions.md`, 2026-09-06). Two would both fold anyway — `foldAsides` fans the
 * preference out to every aside on the page — and this is only picking the node whose
 * `transitionend` the sequence waits on.
 */
function asideInTheWay(skip) {
  for (const pane of panes) {
    if (pane === skip) continue;
    const panel = pane.expandedAside?.();
    if (panel) return panel;
  }
  return null;
}

/**
 * Fold that aside, then run `next` when it has stopped moving — **sequential, never
 * overlapped**. 200ms of fold, then 200ms of slide: the maintainer described fold-then-slide
 * and the two together are the whole of what a click on a room row does.
 *
 * Folding goes through `foldAsides`, which is the same path the band's icon presses, so the
 * flag, the fan-out, the freeze, the spent counter and the remeasure all happen exactly once
 * and in one place.
 *
 * **Three ways out, and the third is the one that is easy to leave off.** `transitionend`
 * guarded on target *and* `propertyName === 'width'`, because this fold moves four properties
 * at once and everything inside the panel is free to transition; a `setTimeout` backstop,
 * because a fold interrupted or re-entered may never deliver the event; and the check
 * *before* either, for the case where nothing is going to move at all. Under reduced motion
 * `.room-panel.is-folding` is `transition: none`, so the aside is already shut by the time
 * this line runs and waiting 260ms would be a dead beat with the room not yet on screen —
 * a stall, which is the one thing reduced motion is asking not to have. The duration is read
 * off the node the fold was just armed on, which is the stylesheet the animation itself
 * obeys rather than a second spelling of the media query in JavaScript.
 */
function foldAsideThen(panel, next) {
  asideFolded.set(true);
  foldAsides();

  const moving = getComputedStyle(panel)
    .transitionDuration.split(',')
    .some((d) => parseFloat(d) > 0);
  if (!moving) {
    next();
    return;
  }

  let timer = null;
  const done = () => {
    clearTimeout(timer);
    panel.removeEventListener('transitionend', onEnd);
    next();
  };
  function onEnd(e) {
    if (e.target === panel && e.propertyName === 'width') done();
  }
  panel.addEventListener('transitionend', onEnd);
  timer = setTimeout(done, ASIDE_FOLD_MS + 60);
}

/**
 * A room arriving in its slot, sliding out of the strip rather than appearing at full width.
 *
 * **Item 3's mechanism, not a second one.** The pane is put into the strip by the two calls
 * that apply a fold with *no* animation — `setFolded` and `setFoldClasses`, which is what
 * `paintFolds` does for a reload — and then `applyRoomFold(false)` runs the ordinary animated
 * expand over it. So the slide is the same 200ms, the same easing and the same measure /
 * freeze / arm / change / land sequence as a fold pressed by hand, and there is one animation
 * in this feature rather than two that have to agree.
 *
 * `paintFolds` cannot do the seeding itself: it derives the fold from `roomFolded`, which
 * `openGroupRoom` has just set to *false* because a room slides in **open**. So the two calls
 * are made here directly — panes first and the frame second, which is `paintFolds`' own order
 * and for its measurement: `setFolded` reads the pane's rect to pin the content, and a frame
 * already on the strip's track list makes that rect 2.5rem.
 *
 * The reflow between them is `void offsetWidth`, never `requestAnimationFrame` — an automated
 * Chrome window reports `visibilityState: 'hidden'` and Chrome suspends frame callbacks
 * there. And nothing paints between the mount and this, so the first frame a reader sees is
 * the strip: it is one synchronous task from the band row's click to here.
 *
 * It refuses on the two shapes item 3 refuses, and for its reason — the worst thing this can
 * produce is a session pane 2.5rem wide, and the second worst a frame that is nothing but a
 * strip. With one pane there is nothing to fold beside, so the room simply arrives open.
 */
function slideRoomIn(pane) {
  if (!pane || panes.length < 2 || roomPane() !== pane) return;
  pane.setFolded?.(true);
  setFoldClasses(pane.slot);
  void el.main.offsetWidth;
  applyRoomFold(false);
}

/**
 * A press on a room the panel is already showing.
 *
 * **Open**: nothing at all, which is what `openGroupRoom` did before there was a fold —
 * taking focus to it is the bug that ate a thread once (#36), and there is nothing else a
 * second press could reveal. **Folded**: the door opens, and stops there. Doing nothing
 * would be a band row that appears not to work, and the band row is the obvious place to
 * press for a room whose badge has just gone up.
 *
 * **The auto-collapse applies here too**, which is a decision rather than an omission: the
 * reader has asked for this room, and an expanded aside is exactly as much in the way of a
 * room being un-shut as it is of one being opened. Same rule, same sequence, same 200 + 200.
 * Nothing is being replaced, so no pane is skipped.
 *
 * The flag moves with the geometry rather than ahead of it — it is set inside the callback,
 * because `paintFolds` reads it and a `paintFolds` landing during the aside's 200ms would
 * open the slot with no animation and take the slide away.
 */
function revealOpenRoom() {
  if (!roomFolded.on) return;
  const open = () => {
    roomFolded.set(false);
    applyRoomFold(false);
  };
  const inTheWay = asideInTheWay(null);
  if (inTheWay) foldAsideThen(inTheWay, open);
  else open();
}

/**
 * The end of a fold, from either the event or the backstop, and safe to run twice.
 *
 * Dropping the inline pair is what lands the frame on the declarative class, so a window
 * resize after a fold recomputes the tracks rather than holding px taken at the old width.
 * The remeasure inside each pane is the part that is not optional: the room's five-line
 * clamp caches `scrollHeight > clientHeight` per entry and goes on running while the pane
 * is folded, because `isConnected` is still true.
 */
function endRoomFold() {
  clearTimeout(roomFoldTimer);
  el.main.style.removeProperty('grid-template-columns');
  el.app.classList.remove('is-folding');
  for (const pane of panes) pane.endFold?.();
}

/*
 * The accurate end of a fold. Wired once, here, because there is exactly one `.main`.
 *
 * Both halves of the guard are load-bearing and both are the aside's lessons one panel
 * over. `target`, because everything inside this frame is free to transition and a control
 * finishing its own would otherwise remeasure two panes; `propertyName`, because
 * `transitionend` fires once per property and the one that means *done* here is the track
 * list. And it is not the only path out — under reduced motion the duration is zero and
 * this never fires at all, which is what the timer in `applyRoomFold` is for.
 */
el.main.addEventListener('transitionend', (e) => {
  if (e.target === el.main && e.propertyName === 'grid-template-columns') endRoomFold();
});

/**
 * Open the second pane.
 *
 * `adopt: false` is for a caller that already knows what the new pane is about to hold —
 * letting it adopt first would subscribe to a session, draw it, and then have it replaced
 * a line later, which is a transcript fetched for nobody and a visible flash of the wrong
 * thing.
 *
 * `focus: false` is for a caller putting something *unfocusable* in the new pane. Focus
 * here means "the pane the rail and the keyboard drive", and a read-only thread is never
 * that — handing it focus is precisely how a rail click came to eat one. See `sessionPane`.
 */
function openSplit({ adopt = true, focus = true } = {}) {
  if (panes.length > 1) return panes.find((p) => p.slot === 'b');
  const pane = addPane('b');
  // A split is somebody's split until a room says otherwise; `openSharedRoom` and
  // `openGroupRoom` set the flag back after this returns, which are the only callers that do.
  threadSplit = false;
  paintFocus();
  if (adopt) pane.adopt();
  if (focus) setFocus('b');
  for (const p of panes) p.renderHead();
  renderRail();
  return pane;
}

/**
 * Put the shared room on screen.
 *
 * Where it lands, and why it is never the pane you are in: **one pane open** → split, and
 * the room takes the new slot, so the conversation you were reading stays where it is.
 * **Two open** → it replaces the pane you are *not* focused in, for the same reason. The
 * room is a thing you consult beside what you were doing; taking that away to show it would
 * defeat the point of putting it in a slot at all.
 *
 * It never leaves **focus** on the room, for the reason `sessionPane` records: focus means
 * "the pane the rail and the keyboard drive", and a read-only view is never that — handing
 * it focus is precisely how a rail click came to eat one (#36). And it never puts a second
 * one on screen: a pane already holding a room of either kind is what it replaces.
 */
function openSharedRoom() {
  // Already on screen. Doing nothing is the whole answer — taking focus to it is the bug
  // above, and there is nothing else a second press could reveal.
  if (panes.some((p) => p.sharedOpen())) return;

  const holder = panes.find((p) => p.kind() !== 'session');
  const madeSplit = !holder && panes.length < 2;
  const target =
    holder ||
    (panes.length > 1
      ? panes.find((p) => p.slot !== focusedSlot) || panes[0]
      : openSplit({ adopt: false, focus: false }));
  if (!target) return;
  if (madeSplit) threadSplit = true;
  target.openShared();
  // Put focus where a click will land, which after this is never the room.
  const keep = sessionPane();
  if (keep) setFocus(keep.slot);
  for (const p of panes) p.renderHead();
  renderRail();
}

function closePane(slot) {
  if (panes.length < 2) return;
  const at = panes.findIndex((p) => p.slot === slot);
  if (at < 0) return;
  panes[at].close();
  panes.splice(at, 1);
  rememberOpen(slot, null); // closed on purpose — don't reopen it on the next load
  // One pane left, so there is no split for a room to have opened.
  threadSplit = false;
  focusedSlot = panes[0].slot;
  paintFocus();
  for (const p of panes) p.renderHead();
  renderRail();
}

/** Re-render every open transcript — for settings shared across panes, like thinking. */
function renderAllStreams() {
  for (const pane of panes) pane.renderStream();
}

/* ---------------------------------------------------------------- go --- */

/**
 * ⇧⇥ jumps to the next session wanting attention — blocked first, then unread.
 * Skips the one you're already on so repeated presses walk the queue, and it walks the
 * focused pane, leaving the other where you parked it — or, if a thread is what you are
 * focused in, the pane that can actually hold a session. Same rule as a rail click, and it
 * is `sessionPane`'s for the same reason: a keypress meaning "next session" must not be
 * what closes a thread.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.shiftKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;

  const queue = state.sessions.filter((s) => s.needsYou);
  if (!queue.length) return;
  e.preventDefault();

  const pane = sessionPane();
  if (!pane) return;
  const at = queue.findIndex((s) => s.id === pane.selected());
  openSession(queue[(at + 1) % queue.length].id);
});

/** ⌘\ / Ctrl+\ opens the split, and closes the pane you are not in. */
document.addEventListener('keydown', (e) => {
  if (e.key !== '\\' || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  if (panes.length > 1) closePane(panes[panes.length - 1].slot);
  else openSplit();
});

el.newSession.onclick = openNewSession;
el.settings.onclick = openSettings;
el.snapshot.onclick = openSnapshot;
// The one way into the shared room. Bound once, at boot, because the row is markup rather
// than something a repaint rebuilds — see `renderSharedRow` for why it is patched in place.
if (el.railShared) el.railShared.onclick = openSharedRoom;
// The rooms band's own control, bound once at boot for the same reason: the head is markup
// rather than something a repaint rebuilds. The rows inside the list are the other way round
// — they are built on demand and their handlers are re-bound on every patch, because a
// handler closing over a stale room record is exactly what reuse would otherwise invite.
if (el.roomsAdd) el.roomsAdd.onclick = openCreateRoom;

function paintFlatToggle() {
  el.flatRail.setAttribute('aria-pressed', String(state.flatRail));
  el.flatRail.title = state.flatRail
    ? 'Back to your groups and folder headings'
    : 'Drop the groups and list every session by what moved last';
}

el.flatRail.onclick = () => {
  state.flatRail = !state.flatRail;
  try {
    localStorage.setItem('foreman.flatRail', state.flatRail ? '1' : '0');
  } catch {
    /* quota or private mode — this window still behaves, it just won't survive a reload */
  }
  paintFlatToggle();
  renderRail();
};
paintFlatToggle();

// Keep relative timestamps honest without a full re-render storm.
setInterval(renderRail, 30_000);
// The gauges' own beat. Nothing incoming moves the "as of" age, and the feed is
// event-driven — measured at two renders in five and a half minutes on a quiet bench — so
// without this a record could sit reading `just now` for an hour. Guarded on a signature at
// the other end, so a tick that changed no string repaints nothing.
setInterval(renderQuota, QUOTA_TICK_MS);

fillRailFooter();

addPane('a');
// A split is part of "where I was" too — reopening one pane when you left two is the same
// wrong answer as reopening the wrong session. Both panes fill from `adopt` on the first
// roster frame.
if (state.opened.b) addPane('b');
paintFocus();
connect();
