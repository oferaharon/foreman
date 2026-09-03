import { marked } from '/vendor/marked.js';
import { isTrustGate, buildTrustNotice } from './trust-gate.js';
import { step, alertText } from './notify.js';
// The ghost-text auto-send flag. In `web/prefs.js` rather than here because the phone's
// lead screen reads the same key, and two spellings of one setting is a setting that
// appears to work — see that file's header.
import { ghostSend } from './prefs.js';

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
  railList: document.getElementById('railList'),
  railFoot: document.querySelector('.rail-foot'),
  railRepo: document.getElementById('railRepo'),
  railVersion: document.getElementById('railVersion'),
  railGrip: document.getElementById('railGrip'),
  main: document.getElementById('main'),
};

/* ----------------------------------------------------------- resizers --- */

/**
 * One draggable divider, three of them on screen.
 *
 * The rail's right edge shipped first (#4) and this is that code generalised, not a
 * second copy of it: the rail, the lead's aside and the Tasks/Room split inside it all
 * want the same five things — a floor, a live ceiling, a preference remembered in this
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
});

/* ------------------------------------------------- the lead's two edges --- */

/** rem. The aside's floor and the ceiling on a stored value; the live ceiling is the
 *  pane's own width less `LEAD_LEFT_MIN`, so the transcript never collapses. Mirrored in
 *  `.room-panel`'s `min-width`/`max-width`, which is the per-pane guarantee — see there. */
const ASIDE_MIN = 15;
const ASIDE_MAX = 40;
const LEAD_LEFT_MIN = 20;

/** rem. The Tasks block's floor and the room's, either side of the split inside the
 *  aside. `TASKS_MAX` bounds a stored value; what the panel can actually afford is
 *  measured off it at drag time. */
const TASKS_MIN = 3;
const TASKS_MAX = 40;
const ROOM_MIN = 8;

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
  // A dragged Tasks/Room divider is an explicit answer to the question this cap is
  // guessing at, so it wins outright: the block's height comes from `--tasks-h` and the
  // five-row cut is not taken at all. Leaving the cut on as well would clip a block
  // somebody had just deliberately made taller.
  if (readPref('foreman.tasksHeight', TASKS_MIN, TASKS_MAX) != null) {
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
 * them is a reset in both, `--tasks-h` being one number for the browser.
 */
function recapTaskLists() {
  for (const box of document.querySelectorAll('.team-tasks')) {
    capTaskList(box, [...box.querySelectorAll(':scope > .team-task')]);
  }
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
      if (state.sessions.some((s) => s.id === alert.id)) focused().open(alert.id);
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
    // Before the render, so a notification is never held up behind a rail repaint — and
    // before `adopt`, which can change what is on screen but never what happened.
    notifyRoster(msg.sessions);
    for (const pane of panes) pane.adopt();
    renderRail();
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
 * Flipped locally before the request goes, because the roster is up to a poll behind and
 * a star that waits two seconds to fill in reads as a click that missed. The next
 * broadcast overwrites this either way, so a failed request corrects itself.
 */
function togglePin(s) {
  s.pinned = !s.pinned;
  renderRail();
  fetch(`/api/sessions/${s.id}/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: s.pinned }),
  }).catch(() => {});
}

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

  const termCap = document.createElement('label');
  termCap.className = 'field-check';
  const term = document.createElement('input');
  term.type = 'checkbox';
  term.checked = true; // what a launch has always done; unticking is the new thing
  termCap.append(term, document.createTextNode('Open a Terminal window'));
  box.append(termCap);

  const termHint = document.createElement('p');
  termHint.className = 'field-hint';
  termHint.textContent =
    'Unticked, it runs in tmux only — nothing on the desktop to look at. The session header ' +
    'grows a button to open one later.';
  box.append(termHint);

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
      if (made.sessionId) focused().open(made.sessionId);
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
  row.className = 'modal-row';
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
      if (bits.length) drift.style.color = 'var(--decision)';
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

function openGroupMenu(anchor, g) {
  openMenu(anchor, [
    { input: { value: g.name, placeholder: 'Rename…', onSubmit: (name) => renameGroup(g, name) } },
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

  /** A row plus, when it is a lead, its nested workers — always used in its place. */
  const rowsFor = (s) => {
    const rows = [sessionRow(s)];
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

    frag.append(groupHeader(g, count, busy));
    // Collapsing can't hide anything you need: a session that wants you is in the inbox
    // above, and a pinned one is above that. What's left in here is quiet by definition.
    if (g.collapsed) continue;
    let tail = null;
    for (const f of mine) {
      frag.append(folderHeading(f, true));
      for (const s of folders.get(f)) {
        for (const row of rowsFor(s)) {
          row.classList.add('in-group');
          frag.append(row);
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
    frag.append(folderHeading(folder, false));
    for (const s of list) frag.append(...rowsFor(s));
  }

  el.railList.replaceChildren(frag);
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
 */
function folderHeading(folder, inGroup) {
  const row = document.createElement('div');
  row.className = `group-label folder-label${inGroup ? ' in-group' : ''}`;

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder;
  name.title = folder;
  row.append(name);

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

  const menu = document.createElement('button');
  menu.className = 'label-menu';
  menu.textContent = '⋯';
  menu.title = `Rename or delete ${g.name}`;
  menu.onclick = (e) => {
    e.stopPropagation();
    openGroupMenu(menu, g);
  };
  row.append(menu);
  return row;
}

/** One rail row: status dot, name, badges, and the pin that hangs off the end. */
/** Sessions with a duplicate in flight. Module scope because the rows are transient. */
const duplicating = new Set();

function sessionRow(s) {
  // The row is a button and so is the pin, and a button cannot live inside another one —
  // hence the wrapper, which also carries the hover and selected states so they cover
  // the pin as well.
  const row = document.createElement('div');
  row.className = `session-row${s.pinned ? ' is-pinned' : ''}${s.isLead ? ' is-lead' : ''}`;

  const btn = document.createElement('button');
  btn.className = `session${s.unread > 0 ? ' has-unread' : ''}`;
  const isOpen = panes.some((p) => p.selected() === s.id);
  btn.setAttribute('aria-selected', String(isOpen));
  if (isOpen) row.classList.add('is-open');
  btn.onclick = () => focused().open(s.id);

  const dot = document.createElement('span');
  dot.className = `dot ${s.status}`;
  btn.append(dot);

  const mark = bindingMark(s);
  if (mark) btn.append(mark);

  const title = document.createElement('span');
  title.className = 'session-title';
  title.textContent = s.title;
  title.title = s.title;
  btn.append(title);

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
      if (made.sessionId) focused().open(made.sessionId);
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
    body.innerHTML = marked.parse(t.body);
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
        md.innerHTML = marked.parse(data.text);
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
 * One image, big, over everything.
 *
 * Deliberately small: it closes on a click anywhere and on Escape, and there is no zoom
 * and no pan. Arrow keys step through the set that opened it, which is not a carousel so
 * much as the list already being in hand — the strip or the grid passed its whole array,
 * so it costs two lines and no chrome.
 */
function openLightbox(sessionId, images, start = 0) {
  if (!images?.length) return;
  let at = Math.max(0, Math.min(start, images.length - 1));

  const back = document.createElement('div');
  back.className = 'modal-back lightbox';

  const fig = document.createElement('figure');
  fig.className = 'lightbox-fig';
  const img = document.createElement('img');
  img.className = 'lightbox-img';
  const cap = document.createElement('figcaption');
  cap.className = 'lightbox-cap';
  fig.append(img, cap);
  back.append(fig);

  function paint() {
    const ref = images[at];
    img.src = imageSrc(sessionId, ref);
    img.alt = ref.note || 'Image from this session';
    // `note` is the text that came with the image in its own record and is only on refs
    // that came from the gallery's scan; a strip's ref carries the ordinal and nothing
    // else, and the message it belongs to is right there on screen behind this.
    const bits = [];
    if (images.length > 1) bits.push(`${at + 1} / ${images.length}`);
    if (ref.note) bits.push(ref.note);
    cap.textContent = bits.join('  ·  ');
    cap.hidden = bits.length === 0;
  }

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      // The gallery this may have opened from is listening for Escape too, and it
      // registered first, so it would close underneath. Stopping the event here is what
      // makes Escape mean "the thing on top".
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'ArrowRight' && images.length > 1) {
      at = (at + 1) % images.length;
      paint();
    } else if (e.key === 'ArrowLeft' && images.length > 1) {
      at = (at - 1 + images.length) % images.length;
      paint();
    }
  }
  document.addEventListener('keydown', onKey, true);
  back.onmousedown = close;

  paint();
  document.body.append(back);
}

/**
 * Every image one session has produced, in order — a grid, and the promise that it is
 * *everything*.
 *
 * That promise is why this fetches instead of reading `view.messages`. The panel only
 * ever holds a window of a transcript (the tailer backfills a byte range, `probe` samples
 * head and tail), so a gallery built from what is on screen would be a subset and would
 * look complete. `/api/sessions/:id/images` makes its own pass over the whole file —
 * ~10ms on a 2.9MB transcript, ~55ms on the largest one on this Mac at 26MB — which is
 * cheap enough to redo on every open, so nothing here is cached and there is nothing to
 * go stale as the session keeps talking.
 *
 * Nothing in here measures anything during a paint, which is the one thing that would
 * make it need the room's `scrollTop`-across-the-repaint dance: it draws once, from a
 * grid that is already in the document, and never repaints under the reader.
 */
function openGallery(sessionId, sessionTitle) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal is-wide gallery';

  const h = document.createElement('h2');
  h.textContent = 'images';
  box.append(h);

  const sub = document.createElement('div');
  sub.className = 'gallery-sub';
  sub.textContent = sessionTitle || '';
  box.append(sub);

  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  const loading = document.createElement('div');
  loading.className = 'gallery-note';
  loading.textContent = 'reading the transcript…';
  box.append(loading, grid);

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

  // Mounted first, filled second — a grid painted before it is in the document is the
  // room's oldest bug, and a lazily-loaded `<img>` in a detached node never asks for its
  // bytes at all.
  (async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/images`);
      const data = await res.json().catch(() => ({}));
      if (!back.isConnected) return; // closed while we were reading
      if (!res.ok) {
        loading.textContent = data.error || `Could not read the transcript (${res.status}).`;
        return;
      }
      const images = Array.isArray(data.images) ? data.images : [];
      if (!images.length) {
        loading.textContent = data.note || 'No images in this conversation — nothing captured, nothing pasted.';
        return;
      }
      loading.textContent = `${images.length} image${images.length === 1 ? '' : 's'}, whole transcript`;

      const frag = document.createDocumentFragment();
      images.forEach((ref, i) => {
        const cell = document.createElement('button');
        cell.className = 'gallery-cell';
        if (ref.note) cell.title = ref.note;

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = imageSrc(sessionId, ref);
        img.alt = ref.note || '';
        cell.append(img);

        // Only recorded facts under a thumbnail. There is no filename to show: on these
        // records `toolUseResult` is an array that duplicates the content blocks and
        // carries no path, so a name would have to be invented and isn't.
        const capBits = [];
        if (ref.sidechain) capBits.push('subagent');
        if (ref.toolUseId == null) capBits.push('pasted');
        if (ref.ts) capBits.push(agoText(Date.parse(ref.ts)));
        if (capBits.length) {
          const cap = document.createElement('span');
          cap.className = 'gallery-cap';
          cap.textContent = capBits.join(' · ');
          cell.append(cap);
        }

        cell.onclick = () => openLightbox(sessionId, images, i);
        frag.append(cell);
      });
      grid.append(frag);
    } catch (err) {
      if (back.isConnected) loading.textContent = err.message;
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
    selected: null,
    messages: [],
    hasEarlier: false,
    error: null,
    lastMarked: null, // newest timestamp we have reported as read
  };

  const chipNodes = new Map(); // toolUseId -> DOM node, so late results find their chip
  const current = () => state.sessions.find((s) => s.id === view.selected) || null;

  let streamEl = null;
  let composerEl = null;

  // The team room — and, since Wave E, the whole team panel: tasks and settings ride the
  // same aside. Lives in the factory because two leads can be open in two slots and must
  // not share a panel — the same rule as everything else per-session in here.
  const roomView = {
    repo: null,
    entries: [],
    cursor: 0,
    listEl: null,
    tasksEl: null,
    tasks: [],
    tasksSig: '',
    tasksAt: 0,
    tasksBusy: false,
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
    roomView.follow = true; // a room you have just opened is one you are following
    roomView.unseen = 0;
    roomView.painted = 0;
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
    if (view.selected === id) return;
    saveDraft(); // hold on to what was being typed in the session we're leaving
    view.selected = id;
    rememberOpen(slot, id);
    view.messages = [];
    view.hasEarlier = false;
    view.error = null;
    view.lastMarked = null;
    chipNodes.clear();
    send({ type: 'subscribe', sessionId: id, slot });
    renderRail();
    renderMain();
  }

  /* -------------------------------------------------------------- main --- */

  function renderMain() {
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
    label.textContent = 'settings';

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
    const nodes = [];
    for (const t of rows) {
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
    const section = (label, title) => {
      const head = document.createElement('div');
      head.className = 'room-head';
      head.textContent = label;
      head.title = title;
      return head;
    };

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
    const asideGrip = paneGrip('x', 'Panel width', "Drag to set the panel's width · double-click to reset");
    asideGrip.classList.add('aside-grip');
    const roomHead = section('room', 'Workers and the lead coordinate here. View only — talk to the lead in the composer.');
    const tasksGrip = paneGrip('y', 'Tasks and room split', 'Drag to split tasks and room · double-click to reset');
    tasksGrip.classList.add('tasks-grip');

    resizer({
      handle: asideGrip,
      axis: 'x',
      storageKey: 'foreman.asideWidth',
      min: ASIDE_MIN,
      max: ASIDE_MAX,
      // The ceiling is the *pane's*, not the window's: split view puts two of these side
      // by side, and the one being dragged is the only one the pointer is inside. The
      // stylesheet enforces the same floor and ceiling per aside — see `.room-panel` —
      // because `--aside` is one number for the whole browser and the other pane may be
      // narrower than this one.
      ceiling: () => (asideGrip.closest('.lead-cols')?.clientWidth ?? window.innerWidth) / remPx() - LEAD_LEFT_MIN,
      // The aside is flush with the pane's right edge, so what the pointer is asking for
      // is the distance from that edge back to the cursor.
      measure: (e) => (asideGrip.closest('.lead-cols')?.getBoundingClientRect().right ?? window.innerWidth) - e.clientX,
      apply: (rem) => setRootVar('--aside', rem),
      onMove: pinRoom,
    });

    resizer({
      handle: tasksGrip,
      axis: 'y',
      storageKey: 'foreman.tasksHeight',
      min: TASKS_MIN,
      max: TASKS_MAX,
      // What is left under the Tasks block once the room's own floor and the `room`
      // heading are taken out of it. Measured off the panel rather than declared: the
      // settings fold above can be open or shut, and the heading is one line of whatever
      // the type scale says today.
      ceiling: () => {
        const bottom = panel.getBoundingClientRect().bottom;
        const top = tasksList.getBoundingClientRect().top;
        const head = roomHead.getBoundingClientRect().height;
        // Before the aside is laid out every rect is zero; the preference's own `max`
        // is a better answer than a negative one.
        if (bottom <= top) return TASKS_MAX;
        return (bottom - top - head) / remPx() - ROOM_MIN;
      },
      measure: (e) => e.clientY - tasksList.getBoundingClientRect().top,
      apply: (rem) => {
        setRootVar('--tasks-h', rem);
        recapTaskLists();
      },
      onMove: pinRoom,
    });

    // Settings on top (folded, so it is one line), then the two things actually read.
    // Both of the blocks above the room still call `pinRoom` when their own fetch lands
    // — reordering them does not change *which* boxes resize the room, only where they
    // sit, and the room still opens on its newest line rather than 454px short of it.
    // The aside's own grip goes last so it paints over everything it overhangs.
    panel.append(
      settingsHead,
      settingsFold,
      section('tasks', 'Every task this team holds — stored state joined with what the pane shows now.'),
      tasksList,
      tasksGrip,
      roomHead,
      list,
      hint,
      asideGrip,
    );
    return panel;
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
    list.replaceChildren();
    if (!roomView.entries.length) {
      const quiet = document.createElement('div');
      quiet.className = 'room-quiet';
      quiet.textContent = 'Nothing yet. Worker updates and escalations land here.';
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
    for (const e of roomView.entries) list.append(roomEntryNode(e, clamps));
    for (const c of clamps) c.overflows = c.el.scrollHeight > c.el.clientHeight + 1;
    for (const c of clamps) applyRoomClamp(c);
    roomView.painted = roomView.entries.length;
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
      roomView.unseen += Math.max(0, roomView.entries.length - before);
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
    if (!list || !list.isConnected || roomView.follow === false) return;
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
  function roomClampable(el, e, pending) {
    el.classList.add('room-clamp');
    pending.push({ seq: e.seq, el, btn: null, overflows: false });
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
    const node = c.el.closest('.room-msg, .room-system');
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

  /** A sender/recipient identity chip. The lead is one identity, each task id another. */
  function roomPill(id) {
    const p = document.createElement('span');
    p.className = id === 'lead' ? 'room-pill is-lead' : 'room-pill';
    p.textContent = id;
    p.title = id; // long task ids ellipsize; the full name rides the hover
    return p;
  }

  /**
   * The identity row over a bubble or card: sender always, recipient only when the
   * message is explicitly addressed. `to: 'lead'` is the room's default destination —
   * a worker bubble in the left lane already says it — but everything a lead or the
   * panel aims at a task id (or `all`) shows both ends.
   */
  function roomMeta(e) {
    const meta = document.createElement('div');
    meta.className = 'room-meta';
    meta.append(roomPill(e.from));
    if (e.to && e.to !== 'lead') {
      const arrow = document.createElement('span');
      arrow.className = 'room-arrow';
      arrow.textContent = '→';
      meta.append(arrow, roomPill(e.to));
    }
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
   * One room entry as one of three shapes the eye can tell apart mid-scroll: panel
   * machinery (`system`, `conflict`) as its own framed card, agent speech
   * (`chat`, `status`, `answer`) as bubbles laned by direction — worker→lead left,
   * lead→worker right, because the maintainer reads the room without sitting at either end —
   * and escalations as full-width cards, the one thing here that needs them. `e.alert`
   * (stuck/loop) keeps the same loud card whatever kind it rides on.
   *
   * Everything is left-aligned and framed. A first pass drew machinery as centred text
   * between two hairlines, which lost the amber box the conflict line used to have and read
   * as free text — the maintainer's word for it. Each event is a thing that happened; it
   * gets an edge to say where it starts and stops.
   *
   * The first two shapes are the ones that run long, so those are the two that clamp —
   * see `roomClampable`. The escalation and the alert never do.
   */
  function roomEntryNode(e, pending = []) {
    const kind = e.kind || 'status';

    if (e.alert) {
      const card = document.createElement('div');
      card.className = 'room-alert';
      if (e.ts) card.title = new Date(e.ts).toLocaleString();
      const text = document.createElement('div');
      text.className = 'room-text';
      text.textContent = e.text || '';
      card.append(text);
      return card;
    }

    if (kind === 'system' || kind === 'conflict') {
      // Two of the machinery lines are coloured, and both are keyed on what the poster
      // said the line *is* — never on how the sentence reads. `about` cannot do it: it is
      // the task id, and every task-scoped system line carries one, so a dispatch and the
      // transition that follows it are identical by that key. `event` is what separates
      // them, and a line without one stays the plain grey card.
      const card = document.createElement('div');
      card.className = 'room-system';
      // Two workers on one file keeps its amber: attention, not alarm, and the one
      // system line that was already a box before this.
      if (kind === 'conflict') card.classList.add('is-conflict');
      // A worker starting is the one piece of machinery that is good news, so it is the
      // panel's live green — `--idle`, the same token as a session's dot, not a colour of
      // its own. Matched exactly, so adding `event: 'pr'` later colours nothing by
      // accident.
      else if (e.event === 'dispatch') card.classList.add('is-dispatch');
      // …and a task merely recorded is the opposite of both: nothing started, nothing
      // needs looking at. So it goes *quieter* than the plain card rather than louder —
      // a dashed edge, the same muted ink, no colour of its own. Spending a third colour
      // on "nothing happened" would cost the two that mean something.
      else if (e.event === 'pending') card.classList.add('is-pending');
      // A lead that merged on its own authority — the one machinery line where something
      // that used to need the maintainer happened without them. Matched on the event
      // **and** on `allowed`, both exactly: the same endpoint posts a line for every
      // refusal, and a refused check is the panel doing its job, not a thing to mark.
      else if (e.event === 'self-merge' && e.allowed) card.classList.add('is-self-merge');
      // The stamp sits on the first line's baseline to the right, so the text and its
      // "view more" share a column of their own rather than joining that row.
      const body = document.createElement('div');
      body.className = 'room-system-body';
      const text = document.createElement('span');
      text.className = 'room-system-text';
      text.textContent = e.text || '';
      body.append(text);
      roomClampable(text, e, pending);
      // What was actually checked, under the sentence. On a self-merge line this is the
      // substance — the sentence says a decision was taken, the list says on what — and
      // the maintainer reads it back a week later, so it is not a hover and not a clamp.
      //
      // It is drawn from `reasons` rather than from `event`, so any machinery line that
      // grows a reasons list gets it. Deliberately *outside* the clamp: `applyRoomClamp`
      // puts "view more" directly after the text it cut off, so the list lands below the
      // control, and its own height is settled before the clamp pass measures anything.
      if (Array.isArray(e.reasons) && e.reasons.length) {
        const list = document.createElement('ul');
        list.className = 'room-reasons';
        for (const r of e.reasons) {
          const li = document.createElement('li');
          li.textContent = String(r);
          list.append(li);
        }
        body.append(list);
      }
      card.append(body);
      if (e.ts) card.append(roomStamp(e.ts));
      return card;
    }

    if (kind === 'escalation') {
      const card = document.createElement('div');
      card.className = 'room-escalation';
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
      if (e.grounds) card.append(roomAside('grounds', e.grounds));
      if (e.continuing) card.append(roomAside('meanwhile', e.continuing));
      return card;
    }

    const wrap = document.createElement('div');
    wrap.className = `room-msg ${e.from === 'lead' ? 'from-lead' : 'from-worker'} room-${kind}`;
    wrap.append(roomMeta(e));
    const bubble = document.createElement('div');
    bubble.className = 'room-bubble';
    const text = document.createElement('div');
    text.className = 'room-text';
    text.textContent = e.text || '';
    // The control lands under the text, above the grounds and the ready line — those are
    // short, and machinery a clamp must never swallow.
    bubble.append(text);
    roomClampable(text, e, pending);
    if (e.grounds) bubble.append(roomAside('grounds', e.grounds));
    // The done report is the worker talking, so the words are its own; the fact that it
    // *is* the done report is machinery, and rides under them rather than replacing them.
    if (e.report === 'review') {
      const ready = document.createElement('div');
      ready.className = 'room-ready';
      // A planner's branch is empty, so pointing at it here would send whoever read this
      // to look at nothing. The file is the deliverable; name that instead.
      ready.textContent = e.plan
        ? `plan ready · ${e.plan.split('/').pop()}`
        : e.branch ? `ready for review · ${e.branch}` : 'ready for review';
      if (e.plan) ready.title = e.plan;
      bubble.append(ready);
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

    // Every image the session has produced, which is a different set from the ones on
    // screen — see `openGallery`. Always here rather than gated on there being any: the
    // panel holds a window of the transcript and could not answer "are there any" without
    // the scan the button itself performs, and a control that came and went on a fact the
    // rail cannot see would be worse than one that sometimes says "none".
    const gallery = document.createElement('button');
    gallery.className = 'ghost-btn';
    gallery.textContent = 'images';
    gallery.title = 'Every image in this session — the whole transcript, not just what is loaded';
    gallery.onclick = () => {
      // Resolved at click time, like the pin above: the header is patched across roster
      // updates, so `s` is a snapshot.
      const live = current();
      if (live) openGallery(live.id, live.title);
    };
    meta.append(gallery);

    // `interrupt` used to live here, four controls along from `thinking` and a whole
    // header away from the box you type into. It sits above the textarea now — see
    // `buildComposer`.

    // The toggles button is gone: the settings live in the team panel now, always
    // visible in the lead's aside — a scroll-to affordance in a 340px column earns
    // nothing.

    // One pane offers to split; two offer to close. The control is always in the header
    // of the pane it acts on, so there is never a question of which one it means.
    const split = document.createElement('button');
    split.className = 'ghost-btn';
    if (panes.length > 1) {
      split.textContent = 'close';
      split.title = 'Close this pane (⌘\\)';
      split.onclick = () => closePane(slot);
    } else if (s.isLead) {
      // A lead's pane is already two frames — the room owns the right half, and a third
      // column would leave nothing readable. Decided in the spec, not a limitation.
      split.textContent = 'split';
      split.disabled = true;
      split.title = 'A team lead pane holds the room on its right — split view is off here.';
    } else {
      split.textContent = 'split';
      split.title = 'Open a second session beside this one (⌘\\)';
      split.onclick = openSplit;
    }
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
    a.append(reading === 'GitHub' ? githubMark() : forgeMark());
    return a;
  }

  /** GitHub's own mark — the `mark-github` octicon, MIT, drawn in `currentColor`. */
  function githubMark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27s-1.36.09-2 .27c-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z',
    );
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  /**
   * A branching graph, for every forge that is not GitHub.
   *
   * Deliberately generic and drawn here rather than fetched: shipping a third-party logo
   * means shipping its licence and its trademark policy too, and this repo is public.
   * A git graph says "this is the repository" without claiming to be anyone's brand.
   */
  function forgeMark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');

    // The trunk, and the branch leaving it and coming back — one stroke each, so the
    // whole glyph carries the same weight as the GitHub mark beside it in the code.
    const line = (d) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('stroke-linecap', 'round');
      return p;
    };
    const node = (cx, cy) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', '1.9');
      c.setAttribute('fill', 'currentColor');
      return c;
    };

    svg.append(
      line('M4 5.4 V10.6'),
      line('M12 5.4 V6.6 a2.6 2.6 0 0 1-2.6 2.6 H6.6 A2.6 2.6 0 0 0 4 11.8'),
      node(4, 3.5),
      node(4, 12.5),
      node(12, 3.5),
    );
    return svg;
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

  function renderStream() {
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
    if (!streamEl) return;

    const stick = isNearBottom();
    const fresh = [];

    for (const m of messages) {
      // A result whose chip is already on screen updates it in place.
      if (m.kind === 'tool_result' && chipNodes.has(m.toolUseId)) {
        const node = chipNodes.get(m.toolUseId);
        applyResult(node, { isError: m.isError, output: m.output, diff: m.diff, images: m.images });
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

  function renderMessage(m) {
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
        div.innerHTML = marked.parse(m.text || '');
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
      body.innerHTML = marked.parse(finalText);
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

  function renderChip({ name, summary, body, isError, muted, hasResult, result, images }) {
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
    else out.textContent = body || '';
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
     * `ghost-line`, and note `ghost-btn` two lines below is something else entirely: that
     * is the panel's generic muted-button class, on the interrupt button and half the
     * controls in the app. Nothing here is one of those.
     */
    const ghost = document.createElement('div');
    ghost.className = 'ghost-line';

    let stop = null;
    if (s.interactive) {
      stop = document.createElement('button');
      stop.className = 'ghost-btn';
      stop.textContent = 'interrupt';
      stop.title = 'Stop what this session is doing (Escape)';
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
    composerEl = { wrap, ta, hint, activity, model, effort, btn, strip, queue, above, merge, ghost, stop, autoGrow };
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
   */
  function renderGhostLine() {
    if (!composerEl?.ghost) return;
    const s = current();
    const { ghost, above, ta, stop } = composerEl;

    const text = s?.interactive && !ta.value.trim() ? s.ghost : null;
    if (!text) {
      ghost.replaceChildren();
      ghost.remove();
      above.classList.remove('has-ghost');
      return;
    }
    // Nothing to repaint if it already says this. The line sits directly above a textarea
    // somebody may be about to click into, and a `replaceChildren` on every roster frame
    // would drop a focused button out from under a press.
    //
    // The auto-send flag is half the key, not decoration: it changes what the button says
    // and what pressing it does, and a signature holding only the text would leave a button
    // reading `use` behind a setting that now sends. Joined with a visible `|` for the
    // reason `mergeSig` learned the hard way — three control bytes inside a pair of quotes
    // read as an empty-string join in every editor there is.
    const sig = `${ghostSend.on ? 'send' : 'use'}|${text}`;
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

    const use = document.createElement('button');
    use.className = 'ghost-line-use';
    use.type = 'button';
    /*
     * The button says what pressing it does. With the setting on this is a one-press send
     * into a live session, and a control that sends should not be labelled as though it
     * fills a box — the setting picks the behaviour and the label follows it rather than
     * hiding it.
     */
    use.textContent = ghostSend.on ? 'send' : 'use';
    use.title = ghostSend.on
      ? 'Send this to the session now — “send a suggestion straight away” is on for this browser'
      : 'Put this in the box below, to edit or send';
    use.onclick = () => useGhost(text);

    ghost.append(tag, body, use);
    // Before the interrupt button, never after it. Interrupt's whole design is that it
    // never moves, and a line that came and went underneath it would shift it by its own
    // height at the end of every turn — on the one control that gets pressed without
    // looking. The merge block is prepended for the same reason, one step further up.
    if (stop && stop.parentNode === above) above.insertBefore(ghost, stop);
    else above.append(ghost);
    above.classList.add('has-ghost');
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
        body.innerHTML = marked.parse(data.markdown);
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
        renderRoom();
        return;
      case 'room-append':
        if (msg.repo !== roomView.repo) return;
        roomView.entries.push(msg.entry);
        roomView.cursor = msg.entry.seq;
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
    if (view.selected && state.sessions.some((s) => s.id === view.selected)) return;
    const taken = panes.filter((p) => p !== api).map((p) => p.selected());
    const free = (s) => !taken.includes(s.id);
    const last = state.opened[slot];

    const pick =
      (last && state.sessions.find((s) => s.id === last.id && free(s))) ||
      // The id rotated while the tab was closed — same terminal, new conversation.
      (last?.paneId && state.sessions.find((s) => s.paneId === last.paneId && free(s))) ||
      state.sessions.find(free);
    if (pick) open(pick.id);
  }

  function close() {
    saveDraft();
    send({ type: 'unsubscribe', slot });
    host.remove();
  }

  /** Ask for this pane's transcript again, after a reconnect. */
  function resubscribe() {
    if (view.selected) send({ type: 'subscribe', sessionId: view.selected, slot });
    // The room subscription is server state too, and dies with the socket the same way
    // a tailer does — this is the exact shape of the "silently stopped transcript" trap.
    if (roomView.repo) send({ type: 'subscribe-room', repo: roomView.repo, slot });
  }

  const api = {
    slot,
    host,
    open,
    close,
    adopt,
    resubscribe,
    receive,
    renderHead,
    renderStream,
    selected: () => view.selected,
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

const focused = () => panes.find((p) => p.slot === focusedSlot) || panes[0];

function addPane(slot) {
  const host = document.createElement('section');
  host.className = 'pane';
  host.dataset.slot = slot;
  // Focus follows the click rather than a control, because every click in a pane is
  // already a statement about which one you are working in.
  host.addEventListener('mousedown', () => setFocus(slot), true);
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
}

function openSplit() {
  if (panes.length > 1) return;
  const pane = addPane('b');
  paintFocus();
  pane.adopt();
  setFocus('b');
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
 * focused pane, leaving the other where you parked it.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.shiftKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;

  const queue = state.sessions.filter((s) => s.needsYou);
  if (!queue.length) return;
  e.preventDefault();

  const pane = focused();
  const at = queue.findIndex((s) => s.id === pane.selected());
  pane.open(queue[(at + 1) % queue.length].id);
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

fillRailFooter();

addPane('a');
// A split is part of "where I was" too — reopening one pane when you left two is the same
// wrong answer as reopening the wrong session. Both panes fill from `adopt` on the first
// roster frame.
if (state.opened.b) addPane('b');
paintFocus();
connect();
