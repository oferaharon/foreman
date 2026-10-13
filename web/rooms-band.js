/*
 * The rail's rooms band: what it draws, in what order, and what it repaints on.
 *
 * The sixth shared pure module in `web/`, and here for the reason every one of the five
 * before it gives: the shape of a list, the punctuation of a signature and the arithmetic
 * of a fold are all things a node test can hold, and a render function inlined into
 * `web/app.js` is none of them. `trust-gate.js` set the precedent for a builder that reaches
 * for `document` and is still tested — the stub in `test/trust-gate.test.js` records every
 * mutation and the test walks the result — and `patchBand` below is built to be driven the
 * same way.
 *
 * Three rules are carried in here rather than left to the caller, because each of them has
 * already been paid for somewhere else in this repo:
 *
 * **Patched in place, never rebuilt.** `renderSharedRow` says why for one row and
 * `renderMergeQueue` says it for a list one pane over: the roster broadcasts every couple of
 * seconds, and a band
 * that replaced its children on every beat would take a row out from under the cursor on
 * its way to press it. `patchBand` indexes the children it already has by `data-room-key`,
 * reuses every node it can, and only ever creates the ones that are genuinely new. The row
 * a person is about to click is the same node it was two frames ago.
 *
 * **Joined with real punctuation.** `|` inside a row, `~` between them. `mergeSig`'s first
 * version joined with what read in every editor as an empty string and was three literal
 * control bytes, so two different queues could spell one signature. This one carries the
 * fix.
 *
 * **A count is not a badge that asks for anything.** A room is a log, not an inbox — every
 * message in it was typed into its members' terminals before the panel drew a thing — so
 * zero draws nothing at all, the same reason a `· 0` on a group heading is furniture.
 *
 * What is deliberately *not* here: anything about `composerSig`. Nothing about rooms may
 * ever join it. That signature tears the whole composer down when it changes, and a
 * message landing in a room would take the textarea out from under whoever is typing.
 */

// The rail's own age buckets, imported rather than re-spelled: `relativeTime` in `web/app.js`
// delegates to the same function, so a room's `3h` and a session row's `3h` one block up
// cannot come to disagree about where an hour ends.
import { ageText } from './group-summary.js';
// Who a stored member is on the roster right now — the room pane's member strip asks the
// same function for its per-member dots, so the band's one dot and the strip's several can
// never disagree about who is live. See `roomLiveness` below.
import { memberRow } from './rooms-pane.js';

/** The archived fold's own key in the flat entry list. Rooms take `room:<id>`, so no room
 *  id can ever collide with it — the store's ids are opaque but the prefix is ours. */
export const ARCHIVED_KEY = 'archived';

/** A member as one word: whatever id it actually has, in the order a person would read.
 *  A member record is `{tmuxSession, name, paneId, addedAt}` and any one of the three ids
 *  may be the only one present — `cleanMember` in `server/rooms.js` refuses a record with
 *  none of them, which is what makes this total. */
export function memberLabel(m) {
  if (!m || typeof m !== 'object') return '';
  return m.name || m.tmuxSession || m.paneId || '';
}

/**
 * Open rooms and archived rooms, each in the order the store handed them over.
 *
 * `archivedAt` is what takes a room out of the open list — a number when it was archived
 * and `null` while it is open — so the test is on the field rather than on a `state` word
 * the record does not carry.
 *
 * The order is whatever the caller hands over and is not re-sorted here. Both screens sort
 * the array they pass in, and neither asks this module for it:
 *
 *  - **The desktop** sorts newest *created* first (`newestCreatedFirst`, `web/rooms-newest.js`,
 *    called from `renderRoomsBand`; the maintainer's ruling of 2026-10-01). `createdAt` only
 *    changes when a room is made, so the band still never reorders on a post — sorting on
 *    `lastAt` would move a row under a cursor every time anybody spoke, which is the cost the
 *    whole patch-in-place rule exists to avoid.
 *  - **The phone** sorts newest by *activity* (`roomsListView`, `web/m/rooms.js`; the ruling
 *    of 2026-09-16), accepting that a row moves when anybody speaks.
 *
 * There is deliberately **no option to pass**: an opt-in flag here is a flag one screen could
 * one day be handed by accident, and the whole value of the split is that neither order can be
 * changed from the other side's edit. What this function does carry for both is that the
 * partition preserves the order it is given, so each sort orders *within* the open and
 * archived sections and never lifts an archived room above a live one.
 */
export function partitionRooms(rooms = []) {
  const list = Array.isArray(rooms) ? rooms : [];
  const open = [];
  const archived = [];
  for (const room of list) {
    if (!room || typeof room !== 'object' || !room.id) continue;
    (room.archivedAt ? archived : open).push(room);
  }
  return { open, archived };
}

/**
 * The flat list of things the band draws, top to bottom.
 *
 * Flat rather than nested for `renderRail`'s own reason one column up: the archived fold is
 * a sibling of the rows it opens, not a box around them, so nothing here has to be taken
 * apart to be patched and a row keeps its identity whether the fold above it is open or
 * shut. Every entry carries the `key` `patchBand` indexes on.
 */
export function bandEntries(rooms = [], { archivedCollapsed = true } = {}) {
  const { open, archived } = partitionRooms(rooms);
  const out = open.map((room) => ({ kind: 'room', key: `room:${room.id}`, room }));
  if (!archived.length) return out;
  out.push({ kind: 'fold', key: ARCHIVED_KEY, count: archived.length, collapsed: archivedCollapsed });
  if (archivedCollapsed) return out;
  for (const room of archived) out.push({ kind: 'room', key: `room:${room.id}`, room, archived: true });
  return out;
}

/**
 * What the band last drew, as one string.
 *
 * Every field the face reads is in here, which is the half a signature has to get right: a
 * field a card draws but the signature does not is a card that stops repainting on a real
 * change. `openIds` is in it because a row wears the open tint, and `archivedCollapsed`
 * because the fold's caret and its rows both turn on it.
 *
 * The join is `|` within a row and `~` between rows — real punctuation, never an empty
 * string. See the header.
 *
 * **The liveness dot is in here as its two counts, and the roster is not.** The dot is the
 * one thing on the row decided by the *sessions* rather than by the room record, so the
 * signature takes `sessions` and spells each open room's `live/total` — which changes when a
 * member's session goes or comes back, and on no other beat. Putting the roster itself in
 * would re-sign on every status flicker of every session on the machine and patch the band
 * every two seconds for nothing; leaving it out would leave a green dot beside a room whose
 * members had all exited, until something else about the room happened to change.
 *
 * The age is deliberately **not** in here: it moves with the clock, not the frame, and the
 * timer that ticks it (`nextBandTick`, `relightBand`) touches one span and nothing else.
 * `lastAt` is, as it always was, so a post re-ages its row on the frame that carries it.
 */
export function bandSig(rooms = [], { openIds = [], archivedCollapsed = true, sessions = [] } = {}) {
  const open = new Set(openIds);
  const entries = bandEntries(rooms, { archivedCollapsed });
  return entries
    .map((e) => {
      if (e.kind === 'fold') return ['fold', e.count, e.collapsed].join('|');
      const live = roomLiveness(e.room, sessions);
      return [
        'room',
        e.room.id,
        e.room.name,
        e.room.memberCount,
        e.room.unseen,
        e.room.lastAt,
        e.room.lastFrom,
        e.archived ? 1 : 0,
        open.has(e.room.id) ? 1 : 0,
        live ? `${live.live}/${live.total}` : '-',
      ].join('|');
    })
    .join('~');
}

/** The unseen count as it is drawn: nothing at zero, and capped so a long-quiet room can
 *  never widen a 20rem column. */
export function unseenText(n) {
  const count = Number(n) || 0;
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/** The row's hover, which is where the membership actually lives — the face has room for a
 *  number and nothing else. Archived says so first, because it is the thing about the room
 *  that changes what you can do with it. `live` is `roomLiveness`'s answer, and its sentence
 *  rides on the hover as well as on the dot's own `title`: the dot is seven pixels wide, and a
 *  fact that is only a colour on a target that small is a fact most readers never get. */
export function roomTitle(room, { archived = false, live = null } = {}) {
  const names = (Array.isArray(room?.members) ? room.members : []).map(memberLabel).filter(Boolean);
  const lines = [room?.name || 'room'];
  if (archived) lines.push('archived — read it, but nothing more is typed into anyone');
  lines.push(names.length ? names.join(', ') : 'no members');
  if (live && live.total) lines.push(livenessText(live));
  if (room?.lastAt) {
    lines.push(`last ${new Date(room.lastAt).toLocaleString()}${room.lastFrom ? ` · ${room.lastFrom}` : ''}`);
  }
  return lines.join('\n');
}

/* ----------------------------------------------------------- the mark --- */

/** How long a post keeps a room's `◎` lit: ten minutes. */
export const RECENT_MS = 10 * 60_000;

/**
 * Whether a room was posted in recently enough for its `◎` to be lit.
 *
 * The signal nothing else on the row gives: a room you have already opened reads zero unseen
 * however busy it is, and the number beside it is only the member count. An archived room is
 * never lit — nothing more is typed into anyone from it. `lastAt` is a ms number or `null`
 * (`server/rooms.js` normalises it), and the window is shut at its far end: a post exactly
 * ten minutes old is out.
 *
 * A mark and nothing more. It never orders anything — the band is ordered by creation, see
 * `partitionRooms`, and neither function the phone shares so much as reads `lastAt`.
 */
export function isRecent(room, now = Date.now()) {
  if (!room || typeof room !== 'object' || room.archivedAt) return false;
  const at = Number(room.lastAt);
  if (!room.lastAt || !Number.isFinite(at)) return false;
  return now - at < RECENT_MS;
}

/**
 * How long until the next lit mark goes out, in ms, or `null` when none is lit.
 *
 * `bandSig` carries `lastAt` and knows nothing about the clock, so a room that goes quiet
 * never re-signs and never repaints — right for everything on the row except this one mark.
 * The caller sets one `setTimeout` for the sooner of this and the next age step
 * (`nextBandTick`, below) and calls `relightBand` when it fires.
 */
export function nextUnlight(rooms = [], now = Date.now()) {
  let soonest = null;
  for (const room of partitionRooms(rooms).open) {
    if (!isRecent(room, now)) continue;
    const left = Number(room.lastAt) + RECENT_MS - now;
    if (soonest === null || left < soonest) soonest = left;
  }
  return soonest === null ? null : Math.max(0, soonest);
}

/** The mark's whole class, lit or not. Assigned rather than toggled, so a stale class can
 *  never ride along on a reused node. */
const markClass = (lit) => (lit ? 'room-mark is-lit' : 'room-mark');

/* ------------------------------------------------------------ the age --- */

/**
 * How long ago the room was last posted in, in the rail's own spelling — `now`, `5m`, `3h`,
 * `2d` — or `''` for a room nobody has spoken in.
 *
 * `ageText` is the rail's one spelling of those buckets (`web/group-summary.js`), and this
 * hands it `lastAt` and nothing else: a room with no posts draws nothing rather than an age
 * since it was made, because "made 3d ago" and "spoken in 3d ago" are different facts and
 * one column cannot say which. **Archived rooms are aged too** — the maintainer's ruling of
 * 2026-10-12 — and unlike the `◎`, which is about whether anything is being typed into
 * anybody right now, an age is simply true of an archived room's log.
 */
export function roomAge(room, now = Date.now()) {
  if (!room || typeof room !== 'object' || !room.lastAt) return '';
  const at = Number(room.lastAt);
  return Number.isFinite(at) ? ageText(at, now) : '';
}

/** One step of `ageText`'s ladder: the age it is in changes every minute under an hour,
 *  every hour under a day, and every day after that. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long until the next room's age changes its words, in ms, or `null` when no room has
 * one.
 *
 * `nextUnlight`'s sibling and for its reason: `bandSig` knows nothing about the clock, so a
 * row that reads `5m` would read `5m` for as long as the room stayed quiet. The steps are
 * `ageText`'s own buckets — the next whole minute, hour or day of the age — so the timer
 * wakes exactly when some word on the band is due to change and at no other time. Every room
 * the frame holds counts, archived ones included; a timer that fires for a row the shut fold
 * is hiding costs one walk over the rows that are drawn, and nothing else.
 */
export function nextAgeTick(rooms = [], now = Date.now()) {
  let soonest = null;
  for (const room of Array.isArray(rooms) ? rooms : []) {
    if (!room || typeof room !== 'object' || !room.id || !room.lastAt) continue;
    const at = Number(room.lastAt);
    if (!Number.isFinite(at)) continue;
    const age = Math.max(0, now - at);
    const step = age < HOUR_MS ? MINUTE_MS : age < DAY_MS ? HOUR_MS : DAY_MS;
    const left = (Math.floor(age / step) + 1) * step - age;
    if (soonest === null || left < soonest) soonest = left;
  }
  return soonest;
}

/**
 * The one delay the band's timer waits for: whichever comes first, a lit `◎` going out or an
 * age changing its words. `null` only when there is neither — a band of rooms nobody has
 * ever spoken in holds no timer at all.
 */
export function nextBandTick(rooms = [], now = Date.now()) {
  const waits = [nextUnlight(rooms, now), nextAgeTick(rooms, now)].filter((w) => w !== null);
  return waits.length ? Math.min(...waits) : null;
}

/* ------------------------------------------------------- the liveness --- */

/**
 * Whether a room's members are still on the roster, as two counts and a word — or `null`
 * for an archived room, which draws no dot (the maintainer's ruling of 2026-10-12: nothing
 * more is typed into anyone from it, so whose session is alive is not its question any more).
 *
 * **Resolved through `memberRow`, imported.** The room pane's member strip draws one dot per
 * member off that function, and this is the same answer folded to one dot: a band saying
 * "all live" beside a strip showing a member gone would be two spellings of one fact
 * disagreeing in front of the reader (`one-spelling`). `memberRow` returns the live roster
 * row or `null`, and the roster holds only sessions with a live pane, so a row *is* live.
 *
 * - `all` — every member resolves (a room of one is `all` when that one does),
 * - `some` — at least one does and at least one does not,
 * - `none` — none does, which includes a room whose members have all been removed: there is
 *   nobody for a post to reach, and that is exactly what grey says.
 */
export function roomLiveness(room, sessions = []) {
  if (!room || typeof room !== 'object' || room.archivedAt) return null;
  const members = Array.isArray(room.members) ? room.members : [];
  const total = members.length;
  const live = members.filter((m) => memberRow(m, sessions)).length;
  const state = total > 0 && live === total ? 'all' : live > 0 ? 'some' : 'none';
  return { live, total, state };
}

/** The dot in words — its `title`, its accessible name and a line on the row's hover — so
 *  nothing about it is carried by colour alone. */
export function livenessText(live) {
  if (!live) return '';
  if (!live.total) return 'no members';
  return `${live.live} of ${live.total} member${live.total === 1 ? '' : 's'} live`;
}

/** The dot's whole class. Assigned rather than toggled, `markClass`'s reason. An archived
 *  room keeps the span — so its name lines up with the open rows above it — and wears no
 *  state, which the stylesheet draws as nothing at all. */
const liveClass = (live) => (live ? `room-live is-${live.state}` : 'room-live');

/* ------------------------------------------------------------ the nodes --- */

/**
 * The spans inside a row, by the row.
 *
 * A `WeakMap` rather than three `_`-prefixed properties on the node, and rather than
 * reading `children[1]` positionally: the first pollutes a DOM node with fields that read
 * as browser API to the next person, and the second is a layout change away from patching
 * the wrong span. Keyed on the node, so it goes when the node does.
 */
const parts = new WeakMap();

/** One room, as a node with six spans and nothing measured. Built once per room and
 *  patched thereafter — see `patchBand`.
 *
 *  The order is the reading order: the two marks (activity, then who is alive), the name —
 *  the one span that gives — and then the three that never shrink: how long ago, how many,
 *  and how many unseen. The age sits against the name rather than among the numbers because
 *  it is about the conversation, and `3h 2` would otherwise read as one figure. */
function buildRow(key) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'room-row';
  row.dataset.roomKey = key;

  const mark = document.createElement('span');
  mark.className = 'room-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '◎';
  row.append(mark);

  // The members-liveness dot. Drawn by the stylesheet from its class, and named in words by
  // its own `title` and `aria-label` — see `livenessText`.
  const live = document.createElement('span');
  live.className = 'room-live';
  row.append(live);

  const name = document.createElement('span');
  name.className = 'room-name';
  row.append(name);

  const age = document.createElement('span');
  age.className = 'room-age';
  row.append(age);

  const count = document.createElement('span');
  count.className = 'room-count';
  row.append(count);

  const unseen = document.createElement('span');
  unseen.className = 'room-unseen';
  row.append(unseen);

  parts.set(row, { mark, live, name, age, count, unseen });
  return row;
}

/** The archived fold's own row: the rail's group heading in miniature, and the same caret. */
function buildFold(key) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'room-fold';
  row.dataset.roomKey = key;

  const caret = document.createElement('span');
  caret.className = 'room-fold-caret';
  caret.setAttribute('aria-hidden', 'true');
  row.append(caret);

  const label = document.createElement('span');
  label.className = 'room-fold-name';
  label.textContent = 'archived';
  row.append(label);

  const count = document.createElement('span');
  count.className = 'room-fold-count';
  row.append(count);

  parts.set(row, { caret, count });
  return row;
}

/**
 * Draw the band into `list`, reusing every node that is already there.
 *
 * The index is read off the children the container already has rather than held in a
 * module-scope Map, which is what makes this both stateless and provable: a test can call
 * it twice against a stub container and compare node identity, and a second band on screen
 * one day would need nothing here to change. `append` on a node that is already a child
 * **moves** it, so the reorder and the reuse are one pass.
 *
 * `handlers.onOpen(id)` and `handlers.onToggleArchived()` are the only two ways out. They
 * are re-bound on every patch rather than only at build, because a handler closing over a
 * stale room record is exactly the class of bug the reuse is otherwise inviting.
 */
export function patchBand(list, rooms = [], opts = {}) {
  const {
    openIds = [],
    archivedCollapsed = true,
    onOpen = null,
    onToggleArchived = null,
    sessions = [],
    now = Date.now(),
  } = opts;
  if (!list) return [];
  const open = new Set(openIds);
  const entries = bandEntries(rooms, { archivedCollapsed });

  const have = new Map();
  for (const node of [...list.children]) {
    const key = node.dataset?.roomKey;
    if (key) have.set(key, node);
  }

  const drawn = [];
  for (const entry of entries) {
    const found = have.get(entry.key);
    if (entry.kind === 'fold') {
      const row = found || buildFold(entry.key);
      const { caret, count } = parts.get(row);
      caret.textContent = entry.collapsed ? '▸' : '▾';
      count.textContent = `· ${entry.count}`;
      row.setAttribute('aria-expanded', String(!entry.collapsed));
      row.title = entry.collapsed
        ? `Show ${entry.count} archived room${entry.count === 1 ? '' : 's'}`
        : 'Hide the archived rooms';
      row.onclick = () => onToggleArchived?.();
      have.delete(entry.key);
      list.append(row);
      drawn.push(row);
      continue;
    }

    const { room } = entry;
    const row = found || buildRow(entry.key);
    const { mark, live, name, age, count, unseen } = parts.get(row);
    mark.className = markClass(isRecent(room, now));
    // Archived rows get no dot (`roomLiveness` answers `null`), and lose every word the
    // dot carried on a reused node — a row archived under the cursor keeps its node.
    const facts = entry.archived ? null : roomLiveness(room, sessions);
    live.className = liveClass(facts);
    live.title = livenessText(facts);
    if (facts) {
      live.setAttribute('role', 'img');
      live.setAttribute('aria-label', livenessText(facts));
      live.removeAttribute('aria-hidden');
    } else {
      live.removeAttribute('role');
      live.removeAttribute('aria-label');
      live.setAttribute('aria-hidden', 'true');
    }
    setAge(age, room, now);
    const members = room.memberCount ?? (room.members?.length || 0);
    row.className = `room-row${entry.archived ? ' is-archived' : ''}${open.has(room.id) ? ' is-open' : ''}`;
    name.textContent = room.name;
    count.textContent = String(members);
    count.title = `${members} in this room`;
    // A room you are looking at has nothing unseen in it, whatever the summary last said —
    // `markGroupRoomRead` is a round trip and the next roster frame is the one that clears
    // the count. `renderSharedRow` does the same thing one band up and for the same reason.
    const n = open.has(room.id) ? '' : unseenText(room.unseen);
    unseen.hidden = n === '';
    unseen.textContent = n;
    unseen.title = n ? `${room.unseen} since you last opened this room` : '';
    row.title = roomTitle(room, { archived: entry.archived, live: facts });
    row.onclick = () => onOpen?.(room.id);
    have.delete(entry.key);
    list.append(row);
    drawn.push(row);
  }

  // Whatever the last frame drew and this one does not. A room that was archived while the
  // fold is shut, or one somebody deleted — either way its node goes, and it goes after the
  // survivors have been re-appended so nothing is removed and re-created in one beat.
  for (const node of have.values()) node.remove();
  return drawn;
}

/** The age span, in words and in full on its hover. Shared by the patch and the timer so
 *  the two can never spell one row's age differently. */
function setAge(span, room, now) {
  const text = roomAge(room, now);
  span.textContent = text;
  span.title = text ? `last post ${new Date(Number(room.lastAt)).toLocaleString()}` : '';
}

/**
 * Re-light the marks and re-age the rows the band already has, against `now`, and touch
 * nothing else.
 *
 * What the band's one timer calls (`nextBandTick`). It walks the rows on screen, looks each
 * one's room up by id and assigns one class to one span and one string to another — nothing
 * is built, moved, removed or measured, so it is safe under a cursor and between two
 * patches. A row whose room has gone from `rooms` is left alone: removing it is the next
 * patch's job, not this one's. The liveness dot is not touched here — it moves with the
 * roster, not the clock, and `bandSig` already repaints on it.
 */
export function relightBand(list, rooms = [], now = Date.now()) {
  if (!list) return;
  const byId = new Map();
  for (const room of Array.isArray(rooms) ? rooms : []) if (room?.id) byId.set(room.id, room);
  for (const node of [...list.children]) {
    const key = node.dataset?.roomKey;
    if (!key?.startsWith('room:')) continue;
    const room = byId.get(key.slice('room:'.length));
    const got = parts.get(node);
    if (!room || !got) continue;
    got.mark.className = markClass(isRecent(room, now));
    setAge(got.age, room, now);
  }
}
