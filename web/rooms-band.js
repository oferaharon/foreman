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
 * **Patched in place, never rebuilt.** `renderSharedRow` says why for one row and `connSig`
 * says it for a column of cards: the roster broadcasts every couple of seconds, and a band
 * that replaced its children on every beat would take a row out from under the cursor on
 * its way to press it. `patchBand` indexes the children it already has by `data-room-key`,
 * reuses every node it can, and only ever creates the ones that are genuinely new. The row
 * a person is about to click is the same node it was two frames ago.
 *
 * **Joined with real punctuation.** `|` inside a row, `~` between them. `mergeSig`'s first
 * version joined with what read in every editor as an empty string and was three literal
 * control bytes, so two different queues could spell one signature; `connSig` carries the
 * fix and so does this.
 *
 * **A count is not a badge that asks for anything.** A room is a log, not an inbox — every
 * message in it was typed into its members' terminals before the panel drew a thing — so
 * zero draws nothing at all, the same reason a `· 0` on a group heading is furniture.
 *
 * What is deliberately *not* here: anything about `composerSig`. Nothing about rooms may
 * ever join it. That signature tears the whole composer down when it changes, and a
 * message landing in a room would take the textarea out from under whoever is typing.
 */

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
 * The order is the store's and is not re-sorted here. `list()` answers in creation order,
 * which is stable across every frame; sorting on `lastAt` would make the band reorder
 * itself under a cursor every time anybody said anything, which is the cost the whole
 * patch-in-place rule exists to avoid.
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
 * Every field the face reads is in here, which is the half `connSig` had to learn twice: a
 * field a card draws but the signature does not is a card that stops repainting on a real
 * change. `openIds` is in it because a row wears the open tint, and `archivedCollapsed`
 * because the fold's caret and its rows both turn on it.
 *
 * The join is `|` within a row and `~` between rows — real punctuation, never an empty
 * string. See the header.
 */
export function bandSig(rooms = [], { openIds = [], archivedCollapsed = true } = {}) {
  const open = new Set(openIds);
  const entries = bandEntries(rooms, { archivedCollapsed });
  return entries
    .map((e) =>
      e.kind === 'fold'
        ? ['fold', e.count, e.collapsed].join('|')
        : [
            'room',
            e.room.id,
            e.room.name,
            e.room.memberCount,
            e.room.unseen,
            e.room.lastAt,
            e.room.lastFrom,
            e.archived ? 1 : 0,
            open.has(e.room.id) ? 1 : 0,
          ].join('|'),
    )
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
 *  that changes what you can do with it. */
export function roomTitle(room, { archived = false } = {}) {
  const names = (Array.isArray(room?.members) ? room.members : []).map(memberLabel).filter(Boolean);
  const lines = [room?.name || 'room'];
  if (archived) lines.push('archived — read it, but nothing more is typed into anyone');
  lines.push(names.length ? names.join(', ') : 'no members');
  if (room?.lastAt) {
    lines.push(`last ${new Date(room.lastAt).toLocaleString()}${room.lastFrom ? ` · ${room.lastFrom}` : ''}`);
  }
  return lines.join('\n');
}

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

/** One room, as a node with four spans and nothing measured. Built once per room and
 *  patched thereafter — see `patchBand`. */
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

  const name = document.createElement('span');
  name.className = 'room-name';
  row.append(name);

  const count = document.createElement('span');
  count.className = 'room-count';
  row.append(count);

  const unseen = document.createElement('span');
  unseen.className = 'room-unseen';
  row.append(unseen);

  parts.set(row, { name, count, unseen });
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
  const { openIds = [], archivedCollapsed = true, onOpen = null, onToggleArchived = null } = opts;
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
    const { name, count, unseen } = parts.get(row);
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
    row.title = roomTitle(room, { archived: entry.archived });
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
