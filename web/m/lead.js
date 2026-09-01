/*
 * lead.js — item 6. The lead screen: one conversation, one box to type into.
 *
 * The phone's whole reason for existing is the moment a lead is waiting on the maintainer
 * and they are not at the Mac. So this screen is deliberately *less* than the desktop's pane
 * rather than a smaller copy of it: there is no `/exit`, no duplicate, no mode picker, no
 * `/model` and no `/effort` on it. The one recovery action that does not need a Mac —
 * interrupt — is in the header, and everything else here is reading and replying.
 *
 * The **merge queue** is the one thing that has since been added to that list, and it fits
 * the rule rather than breaking it: it is not administration, it is a decision only the
 * maintainer can take, arriving at the moment they are furthest from the Mac. It sits above
 * the composer with the answer cards, in the slot their eye already uses for decisions, and
 * it types a sentence into the lead — it does not merge anything. See the merge-queue
 * section below.
 *
 * Three things it owns that nothing else on this route does:
 *
 *   **The back chevron.** The shell hides its own header here (`.m-app.no-head`), so if
 *   this screen does not draw a way out there isn't one but the phone's own gesture.
 *
 *   **The connection indicator.** Same reason, and it is not a nicety. The socket is what
 *   feeds the transcript; when it dies the roster stops too and the page freezes looking
 *   perfectly alive. That is the single most expensive bug in this project's history and
 *   it costs nothing to say out loud. See `watchConnection` for where the fact comes from.
 *
 *   **A collapsed conversation.** One `transcript` frame for a real lead is
 *   95 KB across 46 messages, of which 9.3 KB is user+assistant text — nine tenths of it
 *   is tool output. The bytes arrive either way (it is a shared endpoint and filtering it
 *   server-side would change the desktop), so the saving is in the rendering: a tool call
 *   is one line, name and summary, and no body, diff or result at all.
 *
 * The answer cards (item 7) and the tasks tab (item 8) are separate modules behind fixed
 * signatures — `buildCard(session)` and `mountTasks(host, repo)`. Nothing else is imported
 * from either.
 */

import { marked } from '/vendor/marked.js';
import { buildCard } from './cards.js';
import { mountTasks } from './tasks.js';

marked.setOptions({ gfm: true, breaks: true });

/** Per-session composer drafts. Mobile's own key — the desktop's is not shared. */
const DRAFTS_KEY = 'foreman.m.drafts';

/** Close enough to the bottom to count as caught up, in px. */
const NEAR_BOTTOM = 120;

/**
 * How often the merge block asks what is waiting.
 *
 * Matches `m/tasks.js` and the desktop's `refreshTasks`. This screen is otherwise entirely
 * websocket-driven — the roster and the transcript are pushed — and this is the one HTTP
 * poll on it, because the queue's facts are git reads (`git diff base...branch` per review
 * PR) that have no business inside a broadcast. It costs no git at all on a team with
 * nothing in review, which is the ordinary case.
 */
const MERGE_POLL_MS = 3000;

/** How long an armed control stays armed. The card's own figure, and for the same reason. */
const ARM_MS = 4000;

/**
 * Everything this screen holds. Module scope rather than a closure because the contract is
 * two free functions — `mountLead` builds, `updateLead` is called by the shell on every
 * roster frame — and there is exactly one lead screen at a time (a phone shows one thing;
 * split view is the desktop's problem).
 */
const view = {
  host: null,
  ctx: null,
  /** The id these nodes were built for, so a rebound can carry the draft across. */
  id: null,
  messages: [],
  hasEarlier: false,
  /** Follow new messages only while the reader is at the bottom. */
  follow: true,
  tab: 'chat',
  /** Last non-null roster row, so a null tick does not blank the header. */
  last: null,
  /** What the mounted card was built from, so it is not rebuilt under a thumb. */
  cardSig: null,
  /** The last `GET /api/team/merge` answer, and what the block was built from. */
  merge: null,
  mergeSig: null,
  /** The server's own refusal from the last press, and the rows it was about. */
  mergeErr: null,
  mergeErrFor: null,
  /**
   * Rows pressed here but not yet confirmed by a poll — id -> `{label, since}`.
   *
   * An optimistic overlay and nothing more: it lasts exactly until the first poll that
   * *started* after the press, at which point the server's own `sent` state takes over. It
   * is not a second source of truth about what was sent — the server's dedupe window is
   * ten minutes and this is three seconds, so an entry that outlived its poll would lock a
   * row the maintainer is entitled to press again.
   */
  pending: new Map(),
  tasksMounted: false,
  sending: false,
  error: null,
  /** The newest timestamp already reported read, so one arrival is not marked twice. */
  lastMarked: null,
  el: null,
  timers: [],
};

/* ------------------------------------------------------------- drafts --- */

function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts) {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* a full or disabled store must not stop anyone typing */
  }
}

function draftFor(id) {
  return (id && readDrafts()[id]) || '';
}

function setDraft(id, text) {
  if (!id) return;
  const drafts = readDrafts();
  if (text) drafts[id] = text;
  else delete drafts[id];
  writeDrafts(drafts);
}

/**
 * A session that earned its real id keeps what was half-written for it.
 *
 * A lead launched from the phone opens on a synthetic `pane-19` and the registry moves it
 * the moment it first speaks — which is exactly when somebody is most likely to be typing
 * their first message to it.
 */
function moveDraft(from, to) {
  if (!from || !to || from === to) return;
  const drafts = readDrafts();
  if (!drafts[from]) return;
  drafts[to] = drafts[from];
  delete drafts[from];
  writeDrafts(drafts);
}

/* ---------------------------------------------------------------- mount --- */

export function mountLead(host, ctx) {
  // Re-entering the route builds a fresh screen; anything the last one left ticking goes
  // with it. There is no `unmountLead` in the contract, so this is the only place a timer
  // from a previous mount can be stopped deterministically — the rest is `stopIfDetached`.
  for (const t of view.timers) clearInterval(t);

  Object.assign(view, {
    host,
    ctx,
    id: ctx.sessionId,
    messages: [],
    hasEarlier: false,
    follow: true,
    tab: 'chat',
    last: ctx.session(),
    cardSig: null,
    merge: null,
    mergeSig: null,
    mergeErr: null,
    mergeErrFor: null,
    pending: new Map(),
    tasksMounted: false,
    sending: false,
    error: null,
    lastMarked: null,
    el: null,
    timers: [],
  });

  host.classList.add('m-lead');
  host.replaceChildren();
  view.el = build(host);

  ctx.on('transcript', (msg) => {
    if (msg.sessionId !== ctx.sessionId) return;
    view.messages = msg.messages || [];
    view.hasEarlier = Boolean(msg.hasEarlier);
    view.error = null;
    // A `transcript` frame is either the first paint or a re-subscribe after the socket
    // came back. Both want the newest message, so both pin to the bottom.
    view.follow = true;
    renderStream({ pin: true });
  });

  ctx.on('messages', (msg) => {
    if (msg.sessionId !== ctx.sessionId) return;
    appendMessages(msg.messages || []);
  });

  ctx.on('earlier', (msg) => {
    if (msg.sessionId !== ctx.sessionId) return;
    prependMessages(msg.messages || [], Boolean(msg.hasEarlier));
  });

  ctx.on('error', (msg) => {
    view.error = msg.message || null;
    renderStream();
  });

  watchConnection();
  watchMergeQueue();

  // Painted only now that `host` is in the document — the shell appends it before calling
  // this, and everything below measures something (`scrollHeight`, `clientHeight`). A
  // paint that runs before its container is mounted draws nothing and says nothing about
  // it: a busy screen self-heals on the next frame, a quiet one stays blank for hours.
  renderStream({ pin: true });
  updateLead(ctx.session());
}

/* ------------------------------------------------------------- the frame --- */

function build(host) {
  const el = {};

  /* --- header, row 1: out, who, and what it is running on --- */

  const head = document.createElement('header');
  head.className = 'm-lead-head';

  const top = document.createElement('div');
  top.className = 'm-lead-top';

  el.back = document.createElement('button');
  el.back.type = 'button';
  el.back.className = 'm-lead-back';
  el.back.textContent = '‹';
  el.back.setAttribute('aria-label', 'Back to leads');
  el.back.addEventListener('click', () => {
    location.hash = '#/';
  });

  el.name = document.createElement('div');
  el.name.className = 'm-lead-name';

  // Model and `ctx:` are scraped off the composer footer, and *any* box covers that footer
  // — so a lead reporting no model is not an error, it is what a blocked lead looks like
  // for as long as it is blocked, which can be hours. The desktop read it unguarded once
  // and the `TypeError` unwound the whole composer build from inside, after it had already
  // decided to draw the question card: no card, no textarea, and the one session you could
  // not answer was the one asking you something. Every read of either value here goes
  // through `modelLine`, which is total.
  el.model = document.createElement('div');
  el.model.className = 'm-lead-model';

  el.conn = document.createElement('span');
  el.conn.className = 'm-lead-conn';
  el.conn.textContent = '●';

  top.append(el.back, el.name, el.model, el.conn);

  /* --- header, row 2: the two tabs, and the one control --- */

  const bar = document.createElement('div');
  bar.className = 'm-lead-bar';

  el.tabs = document.createElement('div');
  el.tabs.className = 'm-tabs';
  el.tabChat = tabButton('chat', () => setTab('chat'));
  el.tabTasks = tabButton('tasks', () => setTab('tasks'));
  el.tabChat.classList.add('is-on');
  el.tabs.append(el.tabChat, el.tabTasks);

  // The workers running behind this conversation. From the chat tab they are otherwise
  // invisible — the phone shows leads only, by ruling, so there is no row for a worker
  // anywhere on this device — and this is a fact, not a summons: muted, no amber, no
  // pulse, and gone entirely at zero. The amber and the pulse belong to the home list's
  // second dot, which is what says *something is happening*; this only says *how many*.
  el.tabCount = document.createElement('span');
  el.tabCount.className = 'm-tab-count';
  el.tabTasks.append(el.tabCount);

  /*
   * What this lead is doing, and for how long.
   *
   * On row 2 rather than beside the model, and measured before it was put there: at 390px
   * the top row has 44px of back chevron and ~87px of `Opus 5 · 34%` before the team name
   * gets anything at all, and a word like `Deciphering…` with its elapsed is another
   * ~134px — the name is the thing that would have ellipsised, on the one row that says
   * which team you are looking at. Here it sits between the tabs and the interrupt button,
   * which is also the decision it exists to inform: the elapsed is the half that tells you
   * whether to keep waiting or to press stop.
   *
   * Two spans, because only one of them may shrink. The word ellipsises; the elapsed never
   * does — a clipped `Deciphering…` still says it is working, a clipped `16m 10s` is the
   * half that was worth the room.
   */
  el.activity = document.createElement('div');
  el.activity.className = 'm-lead-activity';
  el.activityWord = document.createElement('span');
  el.activityWord.className = 'm-lead-activity-word';
  el.activityElapsed = document.createElement('span');
  el.activityElapsed.className = 'm-lead-activity-elapsed';
  el.activity.append(el.activityWord, el.activityElapsed);

  // Interrupt, and nothing else in this header. It is the only recovery action that does
  // not need a Mac,
  // and the endpoint does the part the panel could not otherwise know — an Escape fires no
  // `Stop` hook, so the status receipt would say `working` for ten more minutes unless
  // this call dropped it.
  //
  // Deliberately at the opposite end of the screen from the send button, and in the header
  // rather than beside the textarea: stopping what a session is doing and adding to what it
  // is doing are opposite acts, and one of them gets tapped without looking.
  el.stop = document.createElement('button');
  el.stop.type = 'button';
  el.stop.className = 'm-lead-stop';
  el.stop.append(stopIcon());
  el.stop.title = 'Stop what this lead is doing (Escape)';
  el.stop.setAttribute('aria-label', 'Interrupt');
  el.stop.addEventListener('click', interrupt);

  bar.append(el.tabs, el.activity, el.stop);
  head.append(top, bar);

  /* --- the two panes --- */

  const body = document.createElement('div');
  body.className = 'm-lead-body';

  el.stream = document.createElement('div');
  el.stream.className = 'm-lead-stream';
  el.stream.addEventListener('scroll', onScroll, { passive: true });

  el.inner = document.createElement('div');
  el.inner.className = 'm-lead-inner';
  el.stream.append(el.inner);

  el.tasks = document.createElement('div');
  el.tasks.className = 'm-lead-tasks';
  el.tasks.hidden = true;

  body.append(el.stream, el.tasks);

  /* --- the card slot, then the composer --- */

  // Item 7's card mounts here: above the composer, below the conversation, so the answer
  // and the thing you would otherwise type into are in the same glance.
  el.card = document.createElement('div');
  el.card.className = 'm-card-slot';
  el.card.hidden = true;

  // The merge queue, under the card and over the composer — the slot the maintainer's eye
  // already uses for decisions. It is empty and hidden on every team with nothing in
  // review, which is nearly always, so the screen below the conversation is byte-identical
  // to today's until three workers finish at once.
  el.merge = document.createElement('div');
  el.merge.className = 'm-mq';
  el.merge.hidden = true;

  const composer = document.createElement('div');
  composer.className = 'm-composer';
  el.composer = composer;

  el.queue = document.createElement('div');
  el.queue.className = 'm-queue';
  el.queue.hidden = true;

  el.err = document.createElement('div');
  el.err.className = 'm-send-error';
  el.err.hidden = true;

  const row = document.createElement('div');
  row.className = 'm-composer-row';

  el.ta = document.createElement('textarea');
  el.ta.className = 'm-input';
  el.ta.rows = 1;
  el.ta.placeholder = 'type a reply…';
  el.ta.value = draftFor(view.id);
  // Enter is **not** bound to send. On a phone keyboard the return key is a newline and
  // nothing else; a send bound to it fires a half-written message every time.
  el.ta.addEventListener('input', () => {
    setDraft(view.ctx?.sessionId, el.ta.value);
    autoGrow();
    syncSend();
  });

  el.send = document.createElement('button');
  el.send.type = 'button';
  el.send.className = 'm-send';
  el.send.textContent = '→';
  el.send.setAttribute('aria-label', 'Send');
  el.send.addEventListener('click', submit);

  row.append(el.ta, el.send);
  composer.append(el.queue, el.err, row);

  host.append(head, body, el.card, el.merge, composer);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The interrupt glyph. A plain filled square is the universal "stop" mark, but a bare
 * `■` renders as a colour emoji on iOS — its own metrics, its own baseline, immune to
 * `color`. This draws the same idea instead: a slightly rounded square, `currentColor`
 * fill, `em`-sized so it scales with the header. `aria-hidden` because the button already
 * names itself once (`aria-label="Interrupt"`); an SVG with no title adds nothing to
 * announce twice.
 */
function stopIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'm-lead-stop-icon');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '6.5');
  rect.setAttribute('y', '6.5');
  rect.setAttribute('width', '11');
  rect.setAttribute('height', '11');
  rect.setAttribute('rx', '2.75');
  svg.append(rect);
  return svg;
}

function tabButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'm-tab';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function setTab(tab) {
  if (view.tab === tab) return;
  view.tab = tab;

  const el = view.el;
  el.stream.hidden = tab !== 'chat';
  el.tasks.hidden = tab !== 'tasks';
  // The card and the box to type into belong to the conversation. On the tasks tab they
  // would be answering a screen that is not on screen. The merge block goes with them for
  // the same reason and one more: the tasks tab already lists every one of these tasks,
  // and two places to press merge from is one too many.
  el.card.hidden = tab !== 'chat' || !el.card.firstChild;
  syncMergeSlot();
  el.composer.hidden = tab !== 'chat';
  el.tabChat.classList.toggle('is-on', tab === 'chat');
  el.tabTasks.classList.toggle('is-on', tab === 'tasks');

  if (tab === 'tasks') mountTasksOnce();
  // Coming back to a conversation that moved while you were away: the stream was
  // `display: none`, so nothing scrolled and the follow flag still says what it said.
  else if (view.follow) pinBottom();
}

/**
 * Item 8's tab, mounted the first time it is asked for and never torn down.
 *
 * Lazy because the contract has no unmount and no visibility signal, so a tasks module
 * mounted at page load would be polling for a tab nobody has opened. Once mounted it stays
 * — rebuilding it on every switch would throw away whatever state item 8 keeps.
 */
function mountTasksOnce() {
  if (view.tasksMounted) return;
  const repo = view.last?.paneCwd || view.ctx?.session()?.paneCwd || '';
  if (!repo) return; // the roster has not landed yet; the next switch will have it
  view.tasksMounted = true;
  mountTasks(view.el.tasks, repo);
}

/* ------------------------------------------------------------- the roster --- */

/**
 * The roster moved.
 *
 * `session` is **null for a tick** while a freshly launched lead rebinds from its synthetic
 * id to a real one, and again for a beat during a `/clear` rotation. Every read below is
 * written for that: the header falls back to the last row we saw rather than blanking, and
 * nothing dereferences `session` without asking first.
 */
export function updateLead(session) {
  const el = view.el;
  if (!el || !view.host?.isConnected) return;

  // A rebound moved the id under us. `ctx.sessionId` is a live getter and has already
  // followed it; the draft has to be carried across by hand.
  const id = view.ctx?.sessionId ?? null;
  if (id !== view.id) {
    moveDraft(view.id, id);
    view.id = id;
    if (!el.ta.value) el.ta.value = draftFor(id);
  }

  if (session) view.last = session;
  const s = session || view.last;

  el.name.textContent = s?.project || s?.title || 'lead';
  el.model.textContent = modelLine(s);
  paintActivity(s);
  paintTabCount();
  el.stop.disabled = !session;
  syncSend();
  renderQueue(session);
  renderCard(session);
  autoGrow();
}

/**
 * `Deciphering… 16m 10s`, or nothing at all.
 *
 * Total by construction, and that is not decoration. `activity` is written by
 * `sessions.js` gated on `working`, so it is **null for every session that is not working
 * right now** — which on this screen is most of the time and always includes the moment
 * somebody opened it because the lead was waiting on them. Its neighbour `model` is null
 * under exactly the opposite condition and for the same underlying reason: both are
 * scraped off the composer footer, which any box covers completely.
 *
 * The desktop read one of these unguarded once. `shortModel` did `model.replace(...)` on a
 * null, the `TypeError` unwound `buildComposer` from inside *after* it had decided to draw
 * the question card, and every later roster frame threw again in the same place — no card,
 * no textarea, and the one session the maintainer could not answer was the one asking them
 * something. So every read here asks first, and an absent value draws an empty span rather
 * than a separator with nothing on one side of it.
 *
 * The word is rebuilt only when the word changes; the elapsed is written on every frame,
 * which is what makes it tick. Nothing here animates, so the split is about honesty rather
 * than about a restarting keyframe — but it is the same split the desktop's `paintActivity`
 * makes, for the reason it makes it.
 */
function paintActivity(s) {
  const el = view.el;
  const word = typeof s?.activity === 'string' ? s.activity.trim() : '';
  if (el.activityWord.dataset.word !== word) {
    el.activityWord.dataset.word = word;
    el.activityWord.textContent = word ? `${word}…` : '';
  }
  const secs = s?.activitySeconds;
  // No word means no elapsed: `16m 10s` on its own would be a duration for nothing. The
  // space before it is `padding-left` in the stylesheet rather than a character here — a
  // flex item trims its own leading white space, so a written one renders welded to the
  // word, and `:not(:empty)` is what takes the padding away again when there is no elapsed.
  el.activityElapsed.textContent =
    word && Number.isFinite(secs) ? formatElapsed(Math.max(0, Math.floor(secs))) : '';
}

/**
 * `16m 10s`. The desktop's composer formatter, re-spelled here rather than imported —
 * `/m` shares no render code with `web/app.js` by ruling, and this is four lines.
 */
function formatElapsed(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

/**
 * The mark on the `tasks` tab: how many workers are running behind this conversation.
 *
 * The count is the shell's — `ctx.workers()` — so live panes and the `review` exclusion are
 * decided in exactly one place, the same place the home list's `2 workers` comes from. The
 * task store is deliberately never pruned when a pane dies, so a crashed or hand-`/exit`ed
 * worker would otherwise be advertised here for ever.
 *
 * Zero draws nothing. Not a zero, not an empty pill — the tab goes back to being the word
 * `tasks`.
 */
function paintTabCount() {
  const n = view.ctx?.workers?.() ?? 0;
  const text = n > 0 ? String(n) : '';
  if (view.el.tabCount.textContent === text) return;
  view.el.tabCount.textContent = text;
  view.el.tabTasks.title = n > 0 ? `${n} ${n === 1 ? 'worker' : 'workers'} running` : '';
}

/**
 * `Opus 5 · 34%`, or as much of it as there is.
 *
 * Total by construction. Both halves are scraped off the composer footer and a box covers
 * it, so `null` is the normal reading for exactly as long as a lead is blocked — which is
 * exactly when somebody is looking at this screen. An empty slot is the correct answer;
 * a thrown `TypeError` here would take the composer and the answer card with it.
 */
function modelLine(s) {
  if (!s) return '';
  const model = typeof s.model === 'string' ? s.model.replace(/\s*\(.*\)\s*$/, '').trim() : '';
  const pct = Number.isFinite(s.contextPct) ? `${Math.round(s.contextPct)}%` : '';
  return [model, pct].filter(Boolean).join(' · ');
}

/**
 * Item 7's card, rebuilt only when the thing it is about has actually changed.
 *
 * `updateLead` runs on every roster frame, and a question box's card can hold a half-typed
 * free-text answer — the typed text *replaces* the row's label, so the box's own parse
 * changes shape while somebody is using it. Rebuilding on every frame would take the card
 * away from under a thumb mid-answer. The signature is the blocking facts and nothing else.
 */
function renderCard(session) {
  const el = view.el;
  const sig = session
    ? JSON.stringify([session.prompt, session.plan, session.question, session.status, session.dialog])
    : null;
  if (sig === view.cardSig) return;
  view.cardSig = sig;

  const stick = isNearBottom();
  const card = session ? buildCard(session) : null;
  el.card.replaceChildren();
  if (card) el.card.append(card);
  el.card.hidden = !card || view.tab !== 'chat';
  // A card arriving takes the merge block off the screen with it — see `syncMergeSlot`.
  syncMergeSlot();
  // A card appearing takes height from the conversation above it, which would otherwise
  // slide the last reply up out of sight at the moment it matters most.
  if (stick) pinBottom();
}

/* ---------------------------------------------------------- merge queue --- */

/*
 * The PRs waiting on the maintainer, and the one press that asks their lead for each.
 *
 * **The button does not merge.** It POSTs task ids, and the server types a sentence into
 * the lead's own session as if the maintainer had typed it — the lead then merges, pulls,
 * restarts, verifies and closes, all of which it already does. Nothing here talks to Gitea
 * and nothing here composes the sentence: `note`, `sharesNote` and `batch.why` are all
 * written server-side and drawn **verbatim**, which is the trust-gate move
 * (`web/trust-gate.js`) — one measured fact with two readers must not become two facts, and
 * the desktop's block and this one share no code by ruling.
 *
 * The rule the whole design turns on, and the only one that shapes what is drawn:
 *
 *   > A **batch** press is refused when the batch does not compose. An **individual**
 *   > press is never refused, only annotated.
 *
 * So a button belongs on any row with a PR that is not already sent or merged — `ready`,
 * `rebase-first` and `unreadable` all keep theirs, with the reason on the row — while
 * `merge all` is **absent, not disabled** the moment `batch.allowed` is false, with
 * `batch.why` in its place. A greyed control invites a second tap and a hunt for why; a
 * sentence where the control was is read once.
 */

/** Whose queue this is, or null. §8d: the block belongs to a lead and nothing else. */
function repoOf() {
  const s = view.last || view.ctx?.session() || null;
  // A non-lead session has no team to draw and, more to the point, nothing to type into:
  // the sentence goes to the *folder's* lead, which on any other row is someone else.
  if (!s?.isLead) return null;
  // `paneCwd` is the launch folder. The roster's `cwd` is the transcript's and moves when
  // a session changes directory mid-conversation, which is the binding trap one file over.
  return s.paneCwd || null;
}

/**
 * The one HTTP poll on this screen.
 *
 * Everything else here is pushed over the websocket, and this is not, because the queue's
 * facts are git reads — `git diff base...branch` per review PR — which have no business
 * inside a roster broadcast sent to every client. Three review PRs cost ~35ms of git a
 * beat and a team with nothing in review costs no git at all.
 *
 * The timer goes into `view.timers` and every tick asks `stopIfDetached()` first. There is
 * no `unmountLead` in this module's contract: leaving the route detaches the frame and
 * nothing else, so a poll that did neither would outlive the screen it draws and go on
 * fetching for a lead nobody is looking at.
 */
function watchMergeQueue() {
  const tick = async () => {
    if (stopIfDetached()) return;
    // Not a slower poll on the tasks tab — none. The block is hidden there with the card
    // and the composer, and the tab beside it is already listing the same records.
    if (view.tab !== 'chat') return;
    const repo = repoOf();
    if (!repo) return; // the roster has not landed yet; the next tick will have it

    const startedAt = Date.now();
    try {
      const res = await fetch(`/api/team/merge?folder=${encodeURIComponent(repo)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not read the merge queue (${res.status}).`);
      view.merge = { lead: data.lead || null, rows: data.rows || [], batch: data.batch || null };
      // A press's overlay has done its job the moment a poll that *began after it* comes
      // back: from here the server's own `sent` state is the answer, and it has to be,
      // because the server's window is ten minutes and this is one beat. An overlay that
      // outlived its poll would lock a row the maintainer is entitled to press again.
      for (const [id, p] of view.pending) if (p.since < startedAt) view.pending.delete(id);
    } catch {
      // A dropped beat leaves the last good answer on screen. This block is a convenience
      // over a conversation that still works, and a red line across it for one missed
      // fetch would cost more attention than the fetch was worth. Nothing has ever
      // loaded is a different case — then there is simply nothing to draw yet.
      if (!view.merge) return;
    }
    renderMerge();
  };
  tick();
  view.timers.push(setInterval(tick, MERGE_POLL_MS));
}

/**
 * The block, rebuilt only when what it says has actually changed.
 *
 * Signature-memoised exactly as `renderCard` is, and for a sharper version of the same
 * reason: a poll fires every three seconds, and a row that vanished and came back between
 * the two presses of an armed control is the worst thing this block could do. So a tick
 * that changes nothing touches no DOM at all, and a tick that does change something
 * disarms first — an armed control whose row was rebuilt under it is a control pointing at
 * a fact that has moved.
 */
function renderMerge() {
  const el = view.el;
  if (!el?.merge.isConnected) return;

  const q = view.merge;
  const rows = q?.rows || [];
  const rowsSig = JSON.stringify(
    rows.map((r) => [r.id, r.kind, r.pr, r.prNumber, r.title, r.state, r.note, r.sharesNote]),
  );

  /*
   * A refusal lives until the rows it was about change, and then it goes.
   *
   * It has to outlive the repaint that follows the press — that repaint is what draws it —
   * so it cannot be cleared on every poll. And it must not outlive its own cause: *"the row
   * said #52 and the record says #77"* is true for one beat and misleading from the next,
   * because by then the row is showing #77 and the sentence is arguing with what is on
   * screen. Benched: without this the message sat under a row it no longer described.
   *
   * `mergeErrFor` is stamped on the first paint that carries the error and compared on
   * every one after, which is why `pressMerge` sets it back to null rather than to a value.
   */
  if (view.mergeErr) {
    if (view.mergeErrFor === null) view.mergeErrFor = rowsSig;
    else if (view.mergeErrFor !== rowsSig) {
      view.mergeErr = null;
      view.mergeErrFor = null;
    }
  }

  const sig = JSON.stringify([
    rowsSig,
    q?.batch?.allowed ?? null,
    q?.batch?.why ?? null,
    (q?.batch?.tasks || []).join(','),
    // Whether there is a lead, not which one and not how deep its queue is: a queue that
    // grew every time the maintainer sent a message would rebuild this block under their
    // thumb.
    Boolean(q?.lead),
    [...view.pending].map(([id, p]) => [id, p.label]),
    view.mergeErr,
  ]);
  if (sig === view.mergeSig) return;
  view.mergeSig = sig;

  disarmMerge();
  const stick = isNearBottom();

  const frag = document.createDocumentFragment();
  if (rows.length) {
    frag.append(mergeHead(rows, q));
    // `batch.why` is `null` when there is nothing to explain — one row, or no candidates
    // at all — and a sentence only when the batch is genuinely withheld. Drawn under the
    // header rather than in the header's right-hand end because it is a sentence and the
    // screen is 390px wide: it wraps where a control cannot.
    if (q?.batch && !q.batch.allowed && q.batch.why) {
      const why = document.createElement('div');
      why.className = 'm-mq-why';
      why.textContent = q.batch.why;
      frag.append(why);
    }
    if (!q?.lead) {
      const none = document.createElement('div');
      none.className = 'm-mq-nolead';
      none.textContent = 'No lead is running here — the rows are readable, the buttons need one.';
      frag.append(none);
    }
    for (const row of rows) frag.append(mergeRow(row, q));
    if (view.mergeErr) {
      // The server's own words. Its refusals name the tasks and say what moved; a
      // paraphrase would be a second account of a fact that already has one.
      const err = document.createElement('div');
      err.className = 'm-mq-err';
      err.textContent = view.mergeErr;
      frag.append(err);
    }
  }

  el.merge.replaceChildren(frag);
  syncMergeSlot();
  // The block appearing takes height from the conversation above it, which would otherwise
  // slide the lead's last reply — the one naming these PRs — up out of sight.
  if (stick) pinBottom();
}

/**
 * Whether the block is on screen at all — and the one place that answers it, because two
 * callers decide it: the poll that fills the block and the roster frame that mounts a card
 * above it.
 *
 * **The card wins, and that was measured rather than assumed.** Three slots now compete for
 * a 390×844 screen. Benched against a real four-option Bash prompt on a scratch lead, with
 * three PRs waiting: header 103 + card 396 + merge 229 + composer 67 = 795 of 844, leaving
 * the conversation **50px** — one clipped line — and that card was not even at its own
 * `55vh` cap. A longer prompt leaves nothing at all. So the merge block stands down while
 * an answer card is up, which was the plan's pre-decided fallback for exactly this
 * measurement.
 *
 * Nothing is lost by it. The box above is answered in seconds, the block comes straight
 * back, and a press made while a lead is blocked would have been queued by `sendOrQueue`
 * anyway — so waiting for the card costs the merge nothing and buys back the conversation
 * the card is about.
 */
function syncMergeSlot() {
  const el = view.el;
  if (!el) return;
  el.merge.hidden = !el.merge.firstChild || view.tab !== 'chat' || Boolean(el.card.firstChild);
}

/** `3 in review`, and the batch control if there is one to draw. */
function mergeHead(rows, q) {
  const head = document.createElement('div');
  head.className = 'm-mq-head';

  const count = document.createElement('span');
  count.className = 'm-mq-count';
  // The same words as the rail's amber `N in review`, counting the same thing: a review
  // task with no PR yet is a row here too, or the block and the count disagree.
  count.textContent = `${rows.length} in review`;
  head.append(count);

  if (q?.lead && q.batch?.allowed && q.batch.tasks?.length > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'm-mq-go is-all';
    armMerge(all, 'merge all', () => pressMerge(q.batch.tasks, all));
    head.append(all);
  }
  return head;
}

/**
 * One PR.
 *
 * Three lines rather than the one the desktop can afford: at 390px a task id is most of a
 * line on its own, so the id, the PR link and the button take the first, the brief's first
 * line takes the second (ellipsised — it is a title, and the row is not where you read a
 * brief), and the state clauses take the rest. The clauses wrap and are never clipped:
 * `note` and `sharesNote` are the whole reason a row is annotated rather than refused, and
 * a truncated warning is worse than none.
 */
function mergeRow(row, q) {
  const el = document.createElement('div');
  el.className = `m-mq-row is-${row.state}`;

  const line = document.createElement('div');
  line.className = 'm-mq-line';

  const id = document.createElement('span');
  id.className = 'm-mq-id';
  id.textContent = row.id;
  line.append(id);

  if (row.pr) {
    const pr = document.createElement('a');
    pr.className = 'm-mq-pr';
    pr.href = row.pr;
    pr.target = '_blank';
    pr.rel = 'noopener';
    // Never a guessed number: a PR URL with no trailing digits names itself instead.
    pr.textContent = row.prNumber ? `#${row.prNumber}` : 'PR';
    pr.title = row.pr;
    line.append(pr);
  }

  const pending = view.pending.get(row.id) || null;
  /*
   * A button belongs on any row with a PR that is not already sent or merged — `ready`,
   * `rebase-first` and `unreadable` all keep theirs, because an individual press is never
   * refused, only annotated. `kind !== 'plan'` is named rather than left to `pr` being
   * null: a planner never opens one today, but a rule that holds by accident stops holding
   * the day the data changes, and the server refuses a plan by kind for the same reason.
   */
  const pressable =
    row.kind !== 'plan' && row.pr && row.state !== 'sent' && row.state !== 'merged' && !pending;
  if (pressable && q?.lead) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'm-mq-go';
    armMerge(go, 'merge', () => pressMerge([row.id], go));
    line.append(go);
  }

  el.append(line);

  if (row.title) {
    const title = document.createElement('div');
    title.className = 'm-mq-title';
    title.textContent = row.title;
    el.append(title);
  }

  // Verbatim, both of them. Every sentence in this block is composed server-side so the
  // phone and the desktop cannot drift into two accounts of the same fact.
  const notes = [];
  if (pending) notes.push({ text: pending.label, cls: 'is-sent' });
  else if (row.note) notes.push({ text: row.note, cls: NOTE_TONE[row.state] || '' });
  if (row.sharesNote) notes.push({ text: row.sharesNote, cls: 'is-warn' });
  for (const n of notes) {
    const note = document.createElement('div');
    note.className = `m-mq-note ${n.cls}`.trim();
    note.textContent = n.text;
    el.append(note);
  }

  return el;
}

/**
 * Which tone a state's own note carries. Existing tokens only, and the two that matter are
 * the amber the conflict line and the rail's `N in review` already use: an overlap and a
 * moved base are the same class of fact — a human should look at this one first.
 */
const NOTE_TONE = {
  'rebase-first': 'is-warn',
  unreadable: 'is-warn',
  sent: 'is-sent',
  merged: 'is-sent',
  'no-pr': '',
};

/* --- arming ------------------------------------------------------------- */

/**
 * One armed control at a time, across the whole block.
 *
 * Module scope rather than per-button because that is the whole rule: arming a second
 * disarms the first, or a stack of armed rows is a screen where a thumb cannot tell which
 * press is the one that sends. Four seconds, then it lets go by itself.
 */
let armedMerge = null;

function disarmMerge() {
  if (!armedMerge) return;
  clearTimeout(armedMerge.timer);
  // The node may already be detached by a rebuild; resetting it then is harmless and
  // resetting it always is one fewer branch to get wrong.
  armedMerge.reset();
  armedMerge = null;
}

function armMerge(btn, label, fire) {
  btn.textContent = label;
  btn.onclick = () => {
    if (armedMerge?.btn === btn) {
      disarmMerge();
      fire();
      return;
    }
    disarmMerge();
    btn.textContent = 'sure?';
    btn.classList.add('is-armed');
    armedMerge = {
      btn,
      timer: setTimeout(disarmMerge, ARM_MS),
      reset: () => {
        btn.textContent = label;
        btn.classList.remove('is-armed');
      },
    };
  };
}

/* --- the press ---------------------------------------------------------- */

/**
 * Ask the lead to merge these, and say what it said back.
 *
 * `expect` is required by the endpoint and is the point of it: one `{id, pr}` per task,
 * the PR the row was showing when it was pressed. The row was drawn from a poll up to
 * three seconds old and the record behind it can have been re-PR'd since; without this the
 * press would merge blind and nothing would say so.
 *
 * Every refusal is surfaced in the server's own words. Its sentences name the tasks and
 * say exactly what moved — *"a merge line for X already went to the lead"*, *"X and Y both
 * change web/app.js"* — and each is a different fact from "that didn't work".
 */
async function pressMerge(ids, control) {
  const repo = repoOf();
  if (!repo || !ids?.length) return;

  const byId = new Map((view.merge?.rows || []).map((r) => [r.id, r]));
  const expect = ids.map((id) => ({ id, pr: byId.get(id)?.pr ?? null }));

  control.disabled = true;
  view.mergeErr = null;
  view.mergeErrFor = null;
  try {
    const res = await fetch('/api/team/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: repo, tasks: ids, expect }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That didn't take (${res.status}).`);
    // The overlay, for the beat before a poll confirms it. `queued` is the server's own
    // answer about whether the line was typed or is waiting for the lead to be free — the
    // one thing the press knows that the next `GET` does not distinguish.
    const label = data.queued ? 'merge queued — waiting on the lead' : 'merge sent — waiting on the lead';
    const since = Date.now();
    for (const id of data.tasks?.length ? data.tasks : ids) view.pending.set(id, { label, since });
  } catch (err) {
    view.mergeErr = err.message || String(err);
    // Stamped by the paint below, not here — see `renderMerge`.
    view.mergeErrFor = null;
  }
  // Forced, not memoised: the same refusal twice is the same signature, and a block that
  // skipped that repaint would leave the control it just disabled disabled for good.
  view.mergeSig = null;
  renderMerge();
}

/* --------------------------------------------------------------- stream --- */

/**
 * One turn, one node.
 *
 * The table this implements is §2.3's. What is *not* here is as deliberate as what is:
 * `thinking`, `title` and `tool_result` are dropped outright, and so is anything on a
 * sidechain (which is what the desktop groups into its `subagent` run). A tool call is one
 * line — its name and its one-line summary — with no body, no diff and no result, which is
 * what turns a 95 KB frame into a screen you can read with a thumb.
 */
function renderMessage(m) {
  switch (m.kind) {
    case 'user': {
      const div = document.createElement('div');
      div.className = 'm-msg-user';
      // A pasted screenshot rides on the user's own record. The phone draws no images, but
      // a message that was *only* an image would otherwise be an empty bubble, which reads
      // as a bug rather than as a picture you are not being shown.
      const note = m.images?.length ? `${m.images.length === 1 ? 'image' : `${m.images.length} images`}` : '';
      if (m.text) {
        div.textContent = m.text;
        if (note) div.append(mutedTag(note));
      } else if (note) {
        div.append(mutedTag(note));
      } else {
        return null;
      }
      return div;
    }
    case 'assistant': {
      const div = document.createElement('div');
      div.className = 'm-msg-assistant';
      div.innerHTML = marked.parse(m.text || '');
      return div;
    }
    // The panel's own [room] poke at a lead. Nobody typed it, so it must not wear the
    // user's bubble — a quiet centred event line, the register the desktop uses too.
    case 'nudge': {
      const div = document.createElement('div');
      div.className = 'm-msg-event';
      div.textContent = m.text || '';
      return div;
    }
    case 'command': {
      const div = document.createElement('div');
      div.className = 'm-msg-command';
      div.textContent = `/${m.name}${m.args ? ` ${m.args}` : ''}`;
      return div;
    }
    case 'command_output': {
      const div = document.createElement('div');
      div.className = 'm-msg-command is-output';
      div.textContent = m.text || '';
      return div;
    }
    case 'tool_use': {
      const div = document.createElement('div');
      div.className = 'm-msg-tool';
      const name = document.createElement('span');
      name.className = 'm-tool-name';
      name.textContent = m.name || 'tool';
      div.append(name);
      if (m.summary) {
        const sum = document.createElement('span');
        sum.className = 'm-tool-summary';
        sum.textContent = m.summary;
        div.append(sum);
      }
      return div;
    }
    default:
      return null;
  }
}

function mutedTag(text) {
  const span = document.createElement('span');
  span.className = 'm-msg-tag';
  span.textContent = text;
  return span;
}

/** Everything this screen will actually draw, in order. */
function drawable(messages) {
  return messages.filter((m) => !m.sidechain && DRAWN.has(m.kind));
}

const DRAWN = new Set(['user', 'assistant', 'nudge', 'command', 'command_output', 'tool_use']);

function renderStream({ pin = false } = {}) {
  const el = view.el;
  if (!el?.inner.isConnected) return;

  const frag = document.createDocumentFragment();

  if (view.error) {
    const p = document.createElement('div');
    p.className = 'm-lead-error';
    p.textContent = view.error;
    frag.append(p);
  }

  if (view.hasEarlier) frag.append(earlierButton());

  for (const m of drawable(view.messages)) {
    const node = renderMessage(m);
    if (node) frag.append(node);
  }

  if (!view.messages.length && !view.error) {
    const empty = document.createElement('div');
    empty.className = 'm-lead-empty';
    empty.textContent = 'Nothing said yet. Type below and it starts here.';
    frag.append(empty);
  }

  el.inner.replaceChildren(frag);
  if (pin || view.follow) pinBottom();
}

function earlierButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'm-earlier';
  btn.textContent = 'load earlier';
  btn.addEventListener('click', () => {
    btn.textContent = 'loading…';
    btn.disabled = true;
    view.ctx?.send({ type: 'loadEarlier' });
  });
  return btn;
}

/** New messages arriving live. Append-only, and only follows if you were already there. */
function appendMessages(messages) {
  view.messages.push(...messages);
  const el = view.el;
  if (!el?.inner.isConnected) return;

  const stick = isNearBottom();
  // The empty state, if it is up, is not a message and has to go before one is appended.
  if (el.inner.querySelector('.m-lead-empty')) {
    renderStream({ pin: stick });
    if (stick) markReadIfCaughtUp();
    return;
  }

  for (const m of drawable(messages)) {
    const node = renderMessage(m);
    if (node) el.inner.append(node);
  }

  if (stick) {
    pinBottom();
    markReadIfCaughtUp();
  }
}

/**
 * A window of older history, spliced onto the front.
 *
 * The reader's place is held across it by hand. `replaceChildren` plus a run of appends
 * forces no layout on its own, but growing the list *above* the viewport moves everything
 * below it — so the offset is read before the swap (reading it after, on an emptied box,
 * clamps the answer to 0 and puts the reader at the top) and the difference in height is
 * added back afterwards.
 */
function prependMessages(messages, hasEarlier) {
  const el = view.el;
  const before = el?.inner.isConnected ? el.stream.scrollHeight : 0;
  const top = el?.inner.isConnected ? el.stream.scrollTop : 0;

  view.messages = messages.concat(view.messages);
  view.hasEarlier = hasEarlier;
  renderStream();

  if (!el?.inner.isConnected) return;
  el.stream.scrollTop = top + (el.stream.scrollHeight - before);
}

function isNearBottom() {
  const el = view.el;
  if (!el?.stream.isConnected) return true;
  const { stream } = el;
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < NEAR_BOTTOM;
}

function pinBottom() {
  const el = view.el;
  if (!el?.stream.isConnected) return;
  el.stream.scrollTop = el.stream.scrollHeight;
  view.follow = true;
}

function onScroll() {
  // Following is an intention, flipped only by a real scroll — never re-asserted by a
  // repaint, or an arriving message would yank the screen out from under a reader
  // halfway up a long reply.
  view.follow = isNearBottom();
  if (view.follow) markReadIfCaughtUp();
}

/**
 * Clear the unread badge only when the newest message is genuinely on screen.
 *
 * The watermark is server-side and global: reading on the phone clears the desktop's badge
 * for the same session and the other way round. That is correct — it is one person's read
 * state, not one device's — but it is why the rule has to be "actually at the bottom"
 * rather than "the screen is open". Scrolling back through history is reading the past.
 */
function markReadIfCaughtUp() {
  if (!isNearBottom()) return;
  const ts = latestTs();
  if (!ts || ts === view.lastMarked) return;
  view.lastMarked = ts;
  view.ctx?.send({ type: 'markRead', sessionId: view.ctx.sessionId, ts });
}

function latestTs() {
  for (let i = view.messages.length - 1; i >= 0; i -= 1) {
    if (view.messages[i].ts) return view.messages[i].ts;
  }
  return null;
}

/* -------------------------------------------------------------- composer --- */

function autoGrow() {
  const ta = view.el?.ta;
  if (!ta?.isConnected) return;
  ta.style.height = 'auto';
  // Capped, because the composer eats the conversation otherwise — and on a phone with the
  // keyboard up there is not much conversation left to eat.
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.3))}px`;
}

function syncSend() {
  const el = view.el;
  if (!el) return;
  el.send.disabled = view.sending || !el.ta.value.trim() || !view.ctx?.session();
}

/**
 * Send it, and let the server decide whether that means typing or queueing.
 *
 * `POST /api/sessions/:id/send` looks at the pane and either types the message or holds it
 * — because only the server knows, two seconds later, that the session has gone idle and
 * the message can go. The browser holding it in a variable is what v1 did, and closing the
 * tab lost it.
 */
async function submit() {
  const el = view.el;
  const text = el.ta.value;
  const id = view.ctx?.sessionId;
  if (!text.trim() || !id || view.sending) return;

  view.sending = true;
  view.error = null;
  el.err.hidden = true;
  syncSend();

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Send failed (${res.status}).`);

    el.ta.value = '';
    setDraft(id, '');
    autoGrow();
    // A queued message shows up in the list above the box on the next roster frame, which
    // the send itself triggers — there is nothing to say here that the list will not say
    // better a beat later.
    view.follow = true;
    pinBottom();
  } catch (err) {
    el.err.textContent = err.message || String(err);
    el.err.hidden = false;
  } finally {
    view.sending = false;
    syncSend();
  }
}

/**
 * What is waiting, in delivery order, with the head marked.
 *
 * Read off the roster row rather than polled from `GET /api/sessions/:id/queue`: it is the
 * same server-held list, `queueSig` is in the registry's own diff so a change broadcasts,
 * and a phone polling every few seconds for something already being pushed to it is the
 * payload mistake this whole view exists to avoid. The endpoint is still what *removes*
 * one, and its reply is applied straight away rather than waiting for the next frame.
 */
function renderQueue(session) {
  const el = view.el;
  const items = session?.queued || [];
  el.queue.hidden = !items.length;
  el.queue.replaceChildren();
  if (!items.length) return;

  const head = document.createElement('div');
  head.className = 'm-queue-head';
  head.textContent = `${items.length} waiting · sends when this lead is free`;
  el.queue.append(head);

  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = `m-queue-item${i === 0 ? ' is-next' : ''}`;

    const text = document.createElement('span');
    text.className = 'm-queue-text';
    text.textContent = item.text;
    row.append(text);

    if (item.error) {
      const err = document.createElement('span');
      err.className = 'm-queue-err';
      err.textContent = 'retrying';
      err.title = item.error;
      row.append(err);
    }

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'm-queue-drop';
    drop.textContent = '✕';
    drop.setAttribute('aria-label', 'Drop this message');
    drop.addEventListener('click', () => unqueue(item.id, drop));
    row.append(drop);

    el.queue.append(row);
  });
}

async function unqueue(itemId, btn) {
  const id = view.ctx?.sessionId;
  if (!id) return;
  btn.disabled = true;
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || 'Could not drop that message.');
    // The endpoint refreshes the registry, so the roster frame is on its way — but the
    // reply already carries the new list and there is no reason to leave a dropped message
    // on screen for a poll.
    renderQueue({ ...(view.ctx.session() || {}), queued: data.queued || [] });
  } catch (err) {
    btn.disabled = false;
    view.el.err.textContent = err.message || String(err);
    view.el.err.hidden = false;
  }
}

async function interrupt() {
  const id = view.ctx?.sessionId;
  if (!id) return;
  const el = view.el;
  el.stop.classList.add('is-busy');
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'interrupt' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Interrupt failed (${res.status}).`);
  } catch (err) {
    el.err.textContent = err.message || String(err);
    el.err.hidden = false;
  } finally {
    el.stop.classList.remove('is-busy');
  }
}

/* ------------------------------------------------------------ connection --- */

/**
 * Say when the socket is down.
 *
 * The fact itself belongs to the shell — `app.js` owns the socket, its backoff and its
 * re-subscribe, and it already paints the answer onto its own header's dot. On this route
 * that header is hidden, so the state is *tracked* and nowhere *shown*, which is the exact
 * shape of the failure it exists to catch: the transcript stops, the page looks alive, and
 * nothing says otherwise.
 *
 * So this mirrors the shell's own indicator rather than inventing a second source. A
 * second WebSocket of our own would be worse than no indicator at all — it can be up while
 * the shell's is down, and would then draw a green light over a transcript that has
 * genuinely stopped. Polling a class is cheap, needs no edit to a file this item does not
 * own, and cannot disagree with the thing it is reporting on.
 *
 * A node that is missing entirely reads as **unknown**, never as connected: if item 5's
 * markup changes under this, the indicator has to fail loudly rather than quietly promise
 * a live socket.
 */
function watchConnection() {
  const tick = () => {
    if (stopIfDetached()) return;
    const src = document.querySelector('.m-app > .m-head .m-conn');
    const el = view.el;
    if (!src) {
      el.conn.className = 'm-lead-conn is-unknown';
      el.conn.textContent = '?';
      el.conn.title = 'The connection indicator could not be read.';
      return;
    }
    const down = src.classList.contains('is-down');
    el.conn.className = `m-lead-conn${down ? ' is-down' : ''}`;
    el.conn.textContent = down ? 'offline' : '●';
    el.conn.title = down ? 'The socket is down — this conversation is not updating.' : 'connected';
  };
  tick();
  // A plain interval, not a MutationObserver and not `requestAnimationFrame`: an automated
  // Chrome window reports `visibilityState: 'hidden'` and Chrome suspends the frame-driven
  // callbacks there, which has cost this project two separate hours. Timers are not
  // affected, and one class read a second is free.
  view.timers.push(setInterval(tick, 1000));
}

/**
 * The contract has no unmount, so anything left ticking stops itself.
 *
 * Leaving the route replaces `.m-screen`'s children, which detaches this whole frame; the
 * next mount clears the timer list anyway, and this covers the gap in between.
 */
function stopIfDetached() {
  if (view.host?.isConnected) return false;
  for (const t of view.timers) clearInterval(t);
  view.timers = [];
  return true;
}

/* --------------------------------------------------------------- keyboard --- */

/**
 * Keep the composer above the software keyboard.
 *
 * `100dvh` is the honest viewport height and the shell is laid out on it — but on iOS
 * Safari the keyboard does not change it. The layout viewport stays the full height and
 * the keyboard is simply drawn over the bottom of it, so a bottom-anchored composer ends
 * up underneath. `visualViewport` is the only thing that reports the covered strip, and
 * the inset it gives is applied as padding on the frame: `.m-lead` is a border-box flex
 * column, so padding at the bottom lifts the composer by exactly that much.
 *
 * Registered once at module load rather than per mount — there is one lead screen at a
 * time and the handler is a no-op with nothing mounted.
 */
if (window.visualViewport) {
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
