/*
 * The rail's bots band, and the bot pane's conversation list: what each draws, in what
 * order, and how it is patched.
 *
 * A **bot** is a deployed agent the panel watches but does not run — a cron job, a chat
 * bridge, an SDK loop on another machine — whose helper ships its transcripts to the panel
 * (`server/bots.js`). It is not a session and never enters the roster's `sessions`: it rides
 * the same frame as a sibling field, `bots`, exactly as `rooms` does, so nothing that walks
 * the session list can ever be handed one. This module is the browser half of that fact, and
 * it is pure for the reason `web/rooms-band.js` gives in its own header — the order, the two
 * lines of text and the in-place patch are all things a node test can hold, and a render
 * function inlined into `web/app.js` is none of them.
 *
 * The maintainer's rulings this module carries (2026-10-12, on the approved plan):
 *
 *  - **Its own band**, below the session list and above the rooms band — a sibling of
 *    `.rail-list`, never inside it. The word on screen is **bots**.
 *  - **Two lines, no third.** Line 1 is the name and a dot; line 2 is the *newest reply's*
 *    model · effort · ctx and the age, plus `N active` when more than one conversation is
 *    active. One record supplies all three facts (the server picks it), so they can never
 *    come from two different replies, and **two conversations' contexts are never summed or
 *    maxed** — they do not add.
 *  - **Read-only, and asks for nothing.** No red, no inbox hoist, no notification, no
 *    unread count. A helper that has gone quiet draws a **grey** dot — the panel's red means
 *    "needs you", and a bot whose shipper stopped needs a look at the settings list, not an
 *    alarm.
 *
 * And the rule the rooms band paid for: **a row already in place is never moved**
 * (`place`, imported from `web/rooms-band.js`, and `docs/traps/rooms.md#moving-a-row-round-
 * a-focused-one-scrolls-the-band`). This band *is* ordered by activity, so rows do move when
 * a quieter bot speaks — but only the row that has to, never every row on every beat, so a
 * focused row is not the anchor Chrome scrolls the band to compensate for.
 *
 * What is deliberately not here: anything about `composerSig`. Nothing about bots may join
 * it — that signature tears the composer down when it changes, and a bot replying would take
 * the textarea out from under whoever is typing to a session one pane over.
 */

// The rail's one spelling of `now` / `5m` / `3h` / `2d` — the same import `roomAge` makes,
// so a bot's `3h` and a session's `3h` cannot come to disagree about where an hour ends.
import { ageText } from './group-summary.js';
// A bot's ctx is painted by the dev session's own function (the maintainer's Q3: "so it
// looks exactly like a dev session's"), lifted into a leaf both can import.
import { ctxFor, ctxText } from './ctx.js';
// The no-move rule and the age ladder's timer, imported rather than re-spelled.
import { nextAgeTick, place } from './rooms-band.js';

/** Every band row's key is `bot:<id>`; bot ids are `^[a-z][a-z0-9-]{0,31}$` server-side. */
export const BOT_KEY_PREFIX = 'bot:';

/* ------------------------------------------------------------ the facts --- */

/** A ms number or an ISO string as ms, or `null`. */
function msOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string' && v) {
    const at = Date.parse(v);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

/**
 * When a bot last did anything, in ms — or `null` for one that has shipped nothing yet.
 *
 * `lastActiveAt` first, because it is the server's own answer to "last active" (the newest
 * timestamped record across every conversation, else when bytes last arrived), and it is
 * the clock the conversation list is sorted on too. A prompt that has just landed with no
 * reply yet moves it, which is the honest reading of a run that has just started.
 */
export function botActivityAt(bot) {
  return msOf(bot?.lastActiveAt) ?? msOf(bot?.lastTs) ?? msOf(bot?.current?.at);
}

/** The model as it is drawn: the resolved name, else the raw id, else nothing. The server
 *  resolves the name and sends the raw id beside it, so no formatter is ever called on
 *  `null` here (the `a-blocked-session-reports-no-model` crash) — and an id the panel has no
 *  name for (`claude-opus-4-6`) is shown exactly as the transcript wrote it. */
export function modelText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const name = typeof rec.modelName === 'string' ? rec.modelName : '';
  if (name) return name;
  return typeof rec.model === 'string' ? rec.model : '';
}

/** `N active`, only when more than one is — one active conversation is what the pulsing dot
 *  already says, and `1 active` beside it would be the same fact twice. */
export function activeText(n) {
  const count = Number(n) || 0;
  return count > 1 ? `${count} active` : '';
}

/**
 * The dot's state, as one word:
 *
 *  - `offline` — the helper has not said hello for 90 s (the store's own clock), **grey**;
 *  - `active`  — a conversation had bytes in the last minute and has not finished, pulsing;
 *  - `online`  — the helper is reporting and nothing is running.
 *
 * Offline wins over active: a helper that stopped reporting is the one fact about the row a
 * reader cannot see any other way, and "active" is in any case the store's guess from the
 * last minute's bytes.
 */
export function dotState(bot) {
  if (!bot?.helper?.online) return 'offline';
  return (Number(bot.active) || 0) > 0 ? 'active' : 'online';
}

/** `just now`, `5m ago`, `3h ago` — the one age ladder, said as a phrase. */
export function seenText(ms, now = Date.now()) {
  const at = msOf(ms);
  if (!at) return '';
  const age = ageText(at, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** The dot in words — its `title` and accessible name — so nothing is carried by colour. */
export function dotText(bot, now = Date.now()) {
  const state = dotState(bot);
  if (state === 'offline') {
    const seen = seenText(bot?.helper?.lastSeen, now);
    return seen ? `helper offline — last seen ${seen}` : 'helper offline — never seen';
  }
  const n = Number(bot.active) || 0;
  if (state === 'active') return `helper online — ${n} conversation${n === 1 ? '' : 's'} active`;
  return 'helper online — nothing running';
}

/**
 * Line 2 of a row, as its parts in reading order: model, effort, ctx, age, and `N active`.
 * Empty parts are left out, so a bot that has shipped nothing yet is a line with nothing on
 * it rather than a line of dots. `ctx` carries the record's `{tokens, window, pct}` for
 * `ctxFor` to paint; every other part is plain text.
 */
export function botLineParts(bot, now = Date.now()) {
  const cur = bot?.current && typeof bot.current === 'object' ? bot.current : null;
  const parts = [];
  const model = modelText(cur);
  if (model) parts.push({ kind: 'model', text: model, title: cur.model || model });
  if (cur?.effort) parts.push({ kind: 'effort', text: String(cur.effort) });
  const ctx = cur ? ctxText(cur.ctx) : '';
  if (ctx) parts.push({ kind: 'ctx', text: ctx, ctx: cur.ctx });
  const at = botActivityAt(bot);
  if (at) parts.push({ kind: 'age', text: ageText(at, now) });
  const active = activeText(bot?.active);
  if (active) parts.push({ kind: 'active', text: active });
  return parts;
}

/** Line 2 as one string — the row's hover and accessible name, and what the tests read. */
export function botLineText(bot, now = Date.now()) {
  return botLineParts(bot, now)
    .map((p) => p.text)
    .join(' · ');
}

/** The row's hover: the name, the helper, the count, and line 2 spelled out. */
export function botTitle(bot, now = Date.now()) {
  const lines = [bot?.name && bot.name !== bot.id ? `${bot.name} (${bot.id})` : bot?.id || 'bot'];
  lines.push(dotText(bot, now));
  const n = Number(bot?.conversations) || 0;
  lines.push(`${n} conversation${n === 1 ? '' : 's'} kept`);
  const line = botLineText(bot, now);
  if (line) lines.push(`newest reply: ${line}`);
  lines.push('read-only — the panel watches this bot, it does not type to it');
  return lines.join('\n');
}

/* ------------------------------------------------------------ the order --- */

/**
 * The bots the band draws, newest activity first — and one that has shipped nothing yet
 * last, by id, so a freshly registered bot is findable at the bottom rather than nowhere.
 *
 * Unlike the rooms band (newest *created* first, so a post never moves a row), this one is
 * ordered by activity — the plan's rule, because a bot's row is the answer to "which one
 * did something", and a band that never reordered would bury the busy one. What keeps that
 * safe under a cursor is `place`, not a static order.
 */
export function botEntries(bots = []) {
  const list = Array.isArray(bots) ? bots : [];
  return list
    .filter((b) => b && typeof b === 'object' && typeof b.id === 'string' && b.id)
    .map((bot) => ({ key: `${BOT_KEY_PREFIX}${bot.id}`, bot, at: botActivityAt(bot) }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
      }
      return a.bot.id < b.bot.id ? -1 : a.bot.id > b.bot.id ? 1 : 0;
    });
}

/**
 * What the band last drew, as one string. Every field the face reads is in it, the clock is
 * not — the age moves with time, not with the frame, and `relightBotsBand` ticks it. `|`
 * within a row and `~` between rows: real punctuation, never what reads as an empty string
 * (the `mergeSig` trap).
 */
export function botsSig(bots = [], { openIds = [] } = {}) {
  const open = new Set(openIds);
  return botEntries(bots)
    .map(({ bot, at }) => {
      const cur = bot.current || {};
      return [
        bot.id,
        bot.name,
        bot.helper?.online ? 1 : 0,
        bot.conversations,
        bot.active,
        at,
        cur.cid,
        cur.model,
        cur.modelName,
        cur.effort,
        cur.ctx?.tokens,
        cur.ctx?.window,
        cur.ctx?.pct,
        open.has(bot.id) ? 1 : 0,
      ].join('|');
    })
    .join('~');
}

/** How long until any row's age changes its words, or `null` — `nextAgeTick`'s ladder. */
export function nextBotTick(bots = [], now = Date.now()) {
  const rows = botEntries(bots)
    .filter((e) => e.at !== null)
    .map((e) => ({ id: e.bot.id, lastAt: e.at }));
  return nextAgeTick(rows, now);
}

/* ------------------------------------------------------------ the nodes --- */

/** Spans inside a row, by the row — `rooms-band.js`'s `WeakMap`, for its reason. */
const parts = new WeakMap();

function span(cls, text = '') {
  const s = document.createElement('span');
  s.className = cls;
  if (text) s.textContent = text;
  return s;
}

/** One bot, as a button with two lines. Built once per bot and patched thereafter. */
function buildBotRow(key) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'bot-row';
  row.dataset.botKey = key;

  const dot = span('bot-dot');
  const name = span('bot-name');
  const meta = span('bot-meta');
  row.append(dot, name, meta);
  parts.set(row, { dot, name, meta });
  return row;
}

/** Fill a meta line from its parts. Rebuilt whole: it is a handful of spans, and a part
 *  that comes or goes (a model the first reply names, `2 active`) changes its shape. */
function paintMeta(meta, list) {
  const kids = [];
  for (const p of list) {
    if (p.kind === 'ctx') {
      const el = ctxFor(p.ctx);
      if (el) kids.push(el);
      continue;
    }
    const el = span(`bot-${p.kind}`, p.text);
    if (p.kind === 'effort') el.className = `bot-effort effort effort-${p.text}`;
    if (p.title) el.title = p.title;
    kids.push(el);
  }
  meta.replaceChildren(...kids);
}

/**
 * Draw the band into `list`, reusing every node already there and moving only the rows that
 * are out of place. `onOpen(id)` is the only way out, re-bound on every patch so a handler
 * never closes over a stale record.
 */
export function patchBotsBand(list, bots = [], opts = {}) {
  const { openIds = [], onOpen = null, now = Date.now() } = opts;
  if (!list) return [];
  const open = new Set(openIds);
  const entries = botEntries(bots);
  const have = takeStale(list, entries, 'botKey');

  const drawn = [];
  for (const { key, bot } of entries) {
    const row = have.get(key) || buildBotRow(key);
    const { dot, name, meta } = parts.get(row);
    const state = dotState(bot);
    dot.className = `bot-dot is-${state}`;
    dot.title = dotText(bot, now);
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', dot.title);
    name.textContent = bot.name || bot.id;
    paintMeta(meta, botLineParts(bot, now));
    row.className = `bot-row${open.has(bot.id) ? ' is-open' : ''}${state === 'offline' ? ' is-offline' : ''}`;
    row.title = botTitle(bot, now);
    row.onclick = () => onOpen?.(bot.id);
    place(list, row, drawn.length);
    drawn.push(row);
  }
  return drawn;
}

/**
 * Re-age the rows on screen and re-word their hovers, against `now`, and touch nothing else —
 * nothing built, moved or measured, so it is safe under a cursor. What the band's one timer
 * calls (`nextBotTick`).
 */
export function relightBotsBand(list, bots = [], now = Date.now()) {
  if (!list) return;
  const byKey = new Map(botEntries(bots).map((e) => [e.key, e.bot]));
  for (const node of [...list.children]) {
    const bot = byKey.get(node.dataset?.botKey);
    const got = parts.get(node);
    if (!bot || !got) continue;
    const age = got.meta.children ? [...got.meta.children].find((c) => c.className === 'bot-age') : null;
    const text = ageText(botActivityAt(bot), now);
    if (age && age.textContent !== text) age.textContent = text;
    got.dot.title = dotText(bot, now);
    got.dot.setAttribute('aria-label', got.dot.title);
    node.title = botTitle(bot, now);
  }
}

/**
 * Take out of `list` every keyed child the next draw does not want, **before** the pass —
 * a stale node left in place sits at an index a survivor belongs at, and `place` would then
 * move every row behind it, a focused one included (`patchBand`'s own measurement). Returns
 * the survivors by key.
 */
function takeStale(list, entries, attr) {
  const wanted = new Set(entries.map((e) => e.key));
  const have = new Map();
  for (const node of [...list.children]) {
    const key = node.dataset?.[attr];
    if (!key) continue;
    if (wanted.has(key)) have.set(key, node);
    else node.remove();
  }
  return have;
}

/* -------------------------------------------- the pane's conversation list --- */

/** A conversation's state, as one word: `active`, `finished`, or `idle` — not finished and
 *  nothing arriving, which is also what a run that was killed looks like forever. */
export function convState(c) {
  if (c?.active) return 'active';
  if (c?.finished) return 'finished';
  return 'idle';
}

/** When a conversation was last active, ms: the server's `activeAt`, else its last record. */
export function convAt(c) {
  return msOf(c?.activeAt) ?? msOf(c?.lastTs) ?? msOf(c?.lastAppendAt);
}

/** When it started, as a short local date and time — `Oct 12, 14:03` — or `''`. */
export function startedText(iso) {
  const at = msOf(iso);
  if (!at) return '';
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * A conversation's second line, as parts in reading order: the root label it was shipped
 * under, its state, its own latest reply's model · effort · ctx, and when it started. Each
 * conversation's three facts are its own (the plan's §2e) — never the bot row's.
 *
 * **When it started goes last because it is the part that gives way** in a narrow pane —
 * measured on the bench at a 960px window in split view, where a state word placed last was
 * clipped mid-word (`activ`) and a start time placed second was cut to `star…`. The full
 * time is on the row's hover either way.
 */
export function convLineParts(c) {
  const out = [];
  if (c?.root) out.push({ kind: 'root', text: String(c.root) });
  out.push({ kind: 'state', text: convState(c) });
  const model = modelText(c);
  if (model) out.push({ kind: 'model', text: model, title: c.model || model });
  if (c?.effort) out.push({ kind: 'effort', text: String(c.effort) });
  const ctx = c ? ctxText(c.ctx) : '';
  if (ctx) out.push({ kind: 'ctx', text: ctx, ctx: c.ctx });
  const started = startedText(c?.firstTs);
  if (started) out.push({ kind: 'started', text: `started ${started}` });
  return out;
}

/** The whole of a conversation row's hover. */
export function convTitle(c, now = Date.now()) {
  const lines = [c?.title || 'conversation'];
  const at = convAt(c);
  if (at) lines.push(`last active ${seenText(at, now)} · ${new Date(at).toLocaleString()}`);
  const started = msOf(c?.firstTs);
  if (started) lines.push(`started ${new Date(started).toLocaleString()}`);
  const n = Number(c?.prompts) || 0;
  lines.push(`${n} prompt${n === 1 ? '' : 's'}`);
  const via = [c?.entrypoint, c?.version ? `Claude Code ${c.version}` : ''].filter(Boolean).join(' · ');
  if (via) lines.push(via);
  if (c?.cid) lines.push(c.cid);
  return lines.join('\n');
}

/** One conversation, as a button with two lines. */
function buildConvRow(key) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'bot-conv';
  row.dataset.convKey = key;
  const dot = span('bot-conv-dot');
  const title = span('bot-conv-title');
  const age = span('bot-conv-age');
  const meta = span('bot-conv-meta');
  row.append(dot, title, age, meta);
  parts.set(row, { dot, title, age, meta });
  return row;
}

/**
 * The conversations list, newest activity first in the order the server sent it, patched in
 * place by `cid` exactly as the band is — the list repaints on every store change for that
 * bot (at most once a second), and a row rebuilt under the cursor on its way to a press is
 * the one thing a list may not do. `onPick(cid)` is the only way out.
 */
export function patchConversations(list, conversations = [], opts = {}) {
  const { selected = null, onPick = null, now = Date.now() } = opts;
  if (!list) return [];
  const seen = new Set();
  const entries = (Array.isArray(conversations) ? conversations : [])
    .filter((c) => c && typeof c.cid === 'string' && !seen.has(c.cid) && seen.add(c.cid))
    .map((c) => ({ key: `conv:${c.cid}`, c }));
  const have = takeStale(list, entries, 'convKey');

  const drawn = [];
  for (const { key, c } of entries) {
    const row = have.get(key) || buildConvRow(key);
    const { dot, title, age, meta } = parts.get(row);
    const state = convState(c);
    dot.className = `bot-conv-dot is-${state}`;
    dot.title = state;
    title.textContent = c.title || `conversation ${c.cid.slice(0, 8)}`;
    const at = convAt(c);
    const ago = at ? ageText(at, now) : '';
    if (age.textContent !== ago) age.textContent = ago;
    paintMeta(meta, convLineParts(c));
    row.className = `bot-conv${c.cid === selected ? ' is-open' : ''}`;
    row.setAttribute('aria-current', c.cid === selected ? 'true' : 'false');
    row.title = convTitle(c, now);
    row.onclick = () => onPick?.(c.cid);
    place(list, row, drawn.length);
    drawn.push(row);
  }
  return drawn;
}

/** Re-age the conversation rows on screen against `now`, and nothing else. */
export function relightConversations(list, conversations = [], now = Date.now()) {
  if (!list) return;
  const byKey = new Map();
  for (const c of Array.isArray(conversations) ? conversations : []) if (c?.cid) byKey.set(`conv:${c.cid}`, c);
  for (const node of [...list.children]) {
    const c = byKey.get(node.dataset?.convKey);
    const got = parts.get(node);
    if (!c || !got) continue;
    const at = convAt(c);
    const ago = at ? ageText(at, now) : '';
    if (got.age.textContent !== ago) got.age.textContent = ago;
    node.title = convTitle(c, now);
  }
}

/* ------------------------------------------------------- the settings list --- */

/** Disk use as the settings list prints it — `12.4 MB in 31 files`. */
export function diskText(disk, bytesText) {
  const bytes = Number.isFinite(disk?.bytes) ? disk.bytes : 0;
  const files = Number.isFinite(disk?.files) ? disk.files : 0;
  return `${bytesText(bytes)} in ${files} file${files === 1 ? '' : 's'}`;
}

/**
 * One `GET /api/bots` row as label/value pairs, in the order the settings list prints them —
 * everything a maintainer needs to tell "not deployed" from "deployed and refused" from
 * "deployed and quiet" without opening a terminal. `bytesText` is the caller's size
 * formatter (`shortBytes` in `web/app.js`), passed in rather than spelled a second time.
 */
export function botFacts(row, { now = Date.now(), bytesText = (n) => `${n} B` } = {}) {
  const h = row?.helper || {};
  const facts = [];
  const seen = seenText(h.lastSeen, now);
  facts.push(['helper', h.online ? `online — seen ${seen || 'just now'}` : seen ? `offline — last seen ${seen}` : 'never seen']);
  if (h.instance) facts.push(['instance', h.since ? `${h.instance} — since ${new Date(msOf(h.since)).toLocaleString()}` : h.instance]);
  if (h.helperVersion) facts.push(['version', h.helperVersion]);
  if (h.host) facts.push(['host', h.host]);
  const roots = Array.isArray(h.roots) ? h.roots.filter((r) => r && (r.label || r.path)) : [];
  if (roots.length) facts.push(['roots', roots.map((r) => (r.path ? `${r.label || '?'} = ${r.path}` : r.label)).join('; ')]);
  if (Array.isArray(h.claudeVersions) && h.claudeVersions.length) facts.push(['Claude Code', h.claudeVersions.join(', ')]);
  const n = Number(row?.conversations) || 0;
  facts.push(['conversations', `${n}${Number(row?.active) > 0 ? ` — ${row.active} active` : ''}`]);
  facts.push(['disk', diskText(row?.disk, bytesText)]);
  const r = row?.lastRefusal;
  facts.push([
    'last refusal',
    r ? `${r.status ?? '?'} ${r.reason || ''} — ${seenText(r.at, now) || 'at an unknown time'}`.replace(/\s+—/, ' —') : 'none',
  ]);
  return facts;
}
