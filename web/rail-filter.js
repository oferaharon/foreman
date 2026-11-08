/*
 * The rail narrowed to one group or one room: which rows survive, what the clear toggle
 * counts, and the pinned order a drag may write while some pins are off screen.
 *
 * Pure for the reason `rail-fold.js` and `group-summary.js` give: every mistake available
 * here **renders perfectly**. A row from another group let through reads as though it were
 * filed here; a hidden session that is asking for the maintainer and is left out of the
 * count waits on them silently, behind a toggle that says `0`; and a drag that writes the
 * order of the *drawn* pins alone is a partial order, which `POST /api/pins/order` refuses
 * (it must name every pin of both kinds, `splitPinOrder`) — or, worse, one that a future
 * server accepted would drop the hidden pins to the bottom. No DOM, no storage, no `window`.
 *
 * What the filter is, said once: **a statement about what this browser's rail draws, and
 * nothing else.** The roster, the inbox's own rule, notifications, the queue and every
 * server-side consumer never hear of it. It is kept per browser (`railFilter` in
 * `web/prefs.js`) as **one** value, which is what makes "one filter at a time across both
 * kinds" a fact rather than a rule two writers have to remember: a group's id (`g3`), or a
 * room's id behind `room:` (`room:room-4`). The store mints group ids as `g<N>` and room ids
 * as `room-<N>`, so the prefix can never be mistaken for a group.
 *
 * Membership differs by kind and nothing else does:
 *
 *  - **A group** keeps rows by folder — the same `s.project` the group loop in `renderRail`
 *    files rows by, so a row is in the filter exactly when it would be drawn under that
 *    group's heading.
 *  - **A room** keeps its members — each resolved by `memberRow`, the one spelling of
 *    "which roster row is this member" that the room pane's strip and the band's liveness dot
 *    already ask (`tmuxSession` first, never a stored pane id alone:
 *    rooms#a-room-member-is-resolved-tmuxsession-first) — and its asleep members by name,
 *    through `asleepMembers`, the pane's own reader of the same question.
 *
 * Everything after that — a lead's workers following it, the count, the pinned order — is
 * one code path for both.
 */

// Who a stored member is on the roster, and which members are asleep: the room pane's own
// two readers, imported so the filter and the pane can never disagree about who is in a room.
import { asleepMembers, memberRow } from './rooms-pane.js';

/** What a room filter's stored value starts with. A group id never does (`g<N>`). */
export const ROOM_FILTER_PREFIX = 'room:';

/** The stored value that narrows the rail to one room. */
export const roomFilterValue = (roomId) => `${ROOM_FILTER_PREFIX}${roomId}`;

/**
 * What a stored value names, without resolving it: `{kind: 'group'|'room', id}`, or `null`
 * for no filter.
 *
 * @param {string|null|undefined} value
 */
export function filterTarget(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith(ROOM_FILTER_PREFIX)) {
    const id = value.slice(ROOM_FILTER_PREFIX.length);
    return id ? { kind: 'room', id } : null;
  }
  return { kind: 'group', id: value };
}

/**
 * The folders a group filter keeps, or `null` when there is no filter to apply — none set,
 * or the group it names no longer exists. The group half of `resolveFilter`.
 *
 * @param {Array<{id: string, folders: string[]}>} groups the roster's groups
 * @param {string|null|undefined} groupId the stored filter
 * @returns {Set<string>|null}
 */
export function filterFolders(groups, groupId) {
  if (!groupId || !Array.isArray(groups)) return null;
  const g = groups.find((x) => x && x.id === groupId);
  if (!g) return null;
  return new Set(Array.isArray(g.folders) ? g.folders : []);
}

/**
 * The members a room filter keeps, or `null` when there is no room to filter to — not
 * found, or **archived**: an archived room is closed to posts, and a filter on one is a
 * filter on a room nobody is in any more, so it lets go exactly as a deleted one does.
 *
 * `sessions` holds the roster ids of the members that resolve to a live row; `sleepers` the
 * tmux session names of the members asleep (`asleepMembers` — a name with a sleep record and
 * no live row wearing it). A member that resolves to nothing and is not asleep has nothing
 * on the rail to keep.
 *
 * @param {Array<{id: string, name?: string, members?: object[], archivedAt?: number|null}>} rooms
 * @param {string} roomId
 * @param {object[]} sessions the live roster
 * @param {Array<{name: string}>} asleep the frame's `asleep` sibling
 */
export function roomFilter(rooms, roomId, sessions = [], asleep = []) {
  if (!roomId || !Array.isArray(rooms)) return null;
  const room = rooms.find((r) => r && r.id === roomId);
  if (!room || room.archivedAt) return null;
  const ids = new Set();
  for (const m of Array.isArray(room.members) ? room.members : []) {
    const row = memberRow(m, sessions);
    if (row?.id) ids.add(row.id);
  }
  return {
    kind: 'room',
    id: room.id,
    name: room.name || room.id,
    sessions: ids,
    sleepers: new Set(asleepMembers(room, sessions, asleep)),
  };
}

/**
 * The filter a stored value names, resolved against the frame — or `null` when there is
 * nothing to apply: none set, or the group or room it names is gone (or, for a room,
 * archived). `null` with a value stored is the caller's cue to clear a stale one.
 *
 * A group filter is `{kind: 'group', id, name, folders}`; a room filter is `roomFilter`'s.
 *
 * @param {string|null|undefined} value the stored filter
 * @param {{groups?: object[], rooms?: object[], sessions?: object[], asleep?: object[]}} frame
 */
export function resolveFilter(value, { groups = [], rooms = [], sessions = [], asleep = [] } = {}) {
  const target = filterTarget(value);
  if (!target) return null;
  if (target.kind === 'room') return roomFilter(rooms, target.id, sessions, asleep);
  const folders = filterFolders(groups, target.id);
  if (!folders) return null;
  const g = groups.find((x) => x && x.id === target.id);
  return { kind: 'group', id: target.id, name: g?.name || target.id, folders };
}

/** What the rail is filtered to, in words — `the group Tools`, `the room alpha ↔ beta` — for
 *  the clear toggle's title and label. `''` for no filter. */
export function filterLabel(filter) {
  if (!filter) return '';
  return `${filter.kind === 'room' ? 'the room' : 'the group'} ${filter.name}`;
}

/** Whether the filter keeps this row in its own right, before a worker's lead is asked. A
 *  sleeper has no roster id, so a room keeps it by name; a group keeps it by folder like any
 *  other row (`asleepItem` gives it the same `project`). */
function keepsDirectly(row, filter) {
  if (filter.kind === 'room') {
    return row.asleep ? Boolean(filter.sleepers?.has(row.name)) : Boolean(filter.sessions?.has(row.id));
  }
  return Boolean(filter.folders?.has(row.project));
}

/**
 * The `paneCwd` of every lead the filter keeps — the key `renderRail` nests workers by
 * (`leadRows` is keyed on `paneCwd`, a worker's `workerOf` is its lead's repo). A worker's
 * own `project` is its worktree folder, which is never filed in a group, and a worker is
 * never a room member (`participant` refuses it), so this is the only way it can follow its
 * lead through either kind of filter. `null` when there is no filter.
 *
 * @param {object[]} sessions the live roster
 * @param {object|null} filter `resolveFilter`'s answer
 * @returns {Set<string>|null}
 */
export function keptLeads(sessions, filter) {
  if (!filter || !Array.isArray(sessions)) return null;
  const out = new Set();
  for (const s of sessions) {
    if (s && s.isLead && s.paneCwd && keepsDirectly(s, filter)) out.add(s.paneCwd);
  }
  return out;
}

/**
 * Whether one rail row survives the filter. A `null` filter means none: everything does.
 * A worker also survives whenever its lead does (`leads` from `keptLeads`).
 */
export function inFilter(row, filter, leads) {
  if (!filter) return true;
  if (!row) return false;
  if (keepsDirectly(row, filter)) return true;
  return Boolean(row.workerOf) && Boolean(leads) && leads.has(row.workerOf);
}

/**
 * How many sessions the filter is hiding that want the maintainer — the number the clear
 * toggle carries, so nothing outside the group or room waits on them silently.
 *
 * `wants` is the caller's own inbox rule (`needsYou` less a quiet worker), passed in rather
 * than re-spelled here: the count must be about exactly the rows the inbox would have
 * hoisted, and a second spelling would drift from the first the day the inbox rule changes.
 * It is taken over **every** live session — pinned ones included, since a pinned row that
 * wants you is hidden by the filter just the same — and never over sleepers, which by the
 * sleep rule had nothing unread and were asking nothing.
 *
 * @param {object[]} sessions the live roster
 * @param {object|null} filter `resolveFilter`'s answer
 * @param {(s: object) => boolean} wants
 */
export function hiddenWanting(sessions, filter, wants) {
  if (!filter || !Array.isArray(sessions)) return 0;
  const leads = keptLeads(sessions, filter);
  let n = 0;
  for (const s of sessions) if (s && !inFilter(s, filter, leads) && wants(s)) n++;
  return n;
}

/**
 * The full pinned order after rearranging only the pins that are drawn.
 *
 * The drawn pins keep the *slots* they held in the full order and are written back into
 * them in their new order; every hidden pin stays exactly where it was. So moving a drawn
 * pin "to the top" puts it in the first slot a drawn pin holds, never above a hidden one —
 * the hidden pins are not on screen to be moved past, and the order written is always the
 * whole order.
 *
 * Null when the two lists do not agree — `visibleNext` naming a key that is not in `full`,
 * or not naming every drawn key exactly once — so a caller with a stale list writes nothing
 * rather than something partial.
 *
 * @param {string[]} full every pinned key, top first, as drawn unfiltered
 * @param {string[]} visibleNext the drawn keys, in their new order
 */
export function mergeFilteredOrder(full, visibleNext) {
  if (!Array.isArray(full) || !Array.isArray(visibleNext)) return null;
  const drawn = new Set(visibleNext);
  if (drawn.size !== visibleNext.length) return null;
  const slots = [];
  full.forEach((key, i) => {
    if (drawn.has(key)) slots.push(i);
  });
  if (slots.length !== visibleNext.length) return null;
  const out = full.slice();
  slots.forEach((slot, i) => {
    out[slot] = visibleNext[i];
  });
  return out;
}
