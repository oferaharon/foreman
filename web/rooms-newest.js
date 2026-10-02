/*
 * The desktop rail's rooms order: the room made most recently goes at the top.
 *
 * The maintainer's ruling of 2026-10-01. **Creation time and nothing else** — never `lastAt`.
 * A band sorted on activity would move a row under the cursor every time anybody posted;
 * `createdAt` only changes when a room is *made*, so the order is as still as the store's own
 * was and the patch-in-place rule in `web/rooms-band.js` is untouched.
 *
 * It lives beside the band rather than inside it, and the caller (`renderRoomsBand` in
 * `web/app.js`) sorts the array it hands to `patchBand` / `bandSig` — the phone's own pattern
 * (`roomsListView`, `web/m/rooms.js`, with `web/m/recent.js`). The shared module gets no order
 * option: a flag there is a flag the other screen could one day be handed by accident.
 * `partitionRooms` preserves the order it is given, so this orders *within* the open and
 * archived sections and never lifts an archived room above a live one.
 *
 * **Tie-break: the reverse of the store's order.** `list()` answers in creation order, oldest
 * first, so where two rooms share a `createdAt` — or an older record carries `0` — the one
 * later in the store was made later and goes first. That also puts every unstamped room below
 * every stamped one, which is where an older room belongs. It is stable across frames because
 * the store's order is.
 *
 * Pure, and never drops a row: anything that is not a room is left in place for
 * `partitionRooms` to refuse, as before.
 */

/** A `createdAt` as a number that can be compared; anything unreadable is `0`. */
function stamp(room) {
  const n = Number(room?.createdAt);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Newest-created first. A new array; the input is not touched. */
export function newestCreatedFirst(rooms = []) {
  const list = Array.isArray(rooms) ? rooms : [];
  return list
    .map((room, index) => ({ room, index }))
    .sort((a, b) => stamp(b.room) - stamp(a.room) || b.index - a.index)
    .map((e) => e.room);
}
