/**
 * What the team room draws, given the slate the server is holding.
 *
 * The **slate** is one number in `team.json`: the `seq` of the `event: 'clear'` divider the
 * maintainer last pressed, or `null` for "show all". `clear` sets it, `show all` unsets it,
 * and `room.jsonl` is untouched by either — nothing in this feature deletes a line, and the
 * whole log comes back the moment the pointer goes. So this module answers one question
 * (which entries are on screen) and answers it the same way in every window, because the
 * number it reads came off the server rather than out of this browser's storage.
 *
 * Pure on purpose — no DOM, no fetch, no storage — so the rule can be pinned in node the way
 * `web/notify.js` and `web/trust-gate.js` are. The wiring in `web/app.js` decides when to
 * repaint; everything here decides *what a paint contains*, and those are the two halves
 * that must not be confused.
 *
 * **The divider is an ordinary entry, not a marker the client synthesises.** It is the entry
 * *at* the slate, which is why the comparison is `>=` and not `>`: the first thing in a
 * cleared room has to be the line saying it was cleared, or the room starts mid-conversation
 * with nothing explaining the gap. It also means a second `clear` needs no special case —
 * the pointer moves to the new divider and the old one is simply history, back in its place
 * under `show all`.
 */

/**
 * Is a slate up? A positive integer and nothing else.
 *
 * Written as a type test rather than truthiness because the wrong answer here is silent
 * both ways: a `0` or a `"12"` arriving from anywhere would read as "show all" or as a
 * comparison against a string, and the room would look entirely fine either way.
 */
export function slateActive(slate) {
  return Number.isInteger(slate) && slate > 0;
}

/**
 * The entries a paint may draw — the tail from the divider on, or all of them.
 *
 * Returns the same array when there is no slate, so the no-slate path costs nothing and
 * cannot reorder anything. Entries keep the log's own order: `seq` is monotonic per team,
 * so filtering is the whole of it and the divider comes out first by arithmetic rather
 * than by being moved.
 *
 * An entry with no usable `seq` is **kept**, deliberately. A torn line the store skipped
 * never gets here, so anything that arrives without one is a shape this panel has not met
 * — and hiding what you cannot classify is how a room quietly stops showing something.
 */
export function visibleEntries(entries, slate) {
  const list = Array.isArray(entries) ? entries : [];
  if (!slateActive(slate)) return list;
  return list.filter((e) => !Number.isInteger(e?.seq) || e.seq >= slate);
}

/** What the room head's one button says, and what it will do. `clear` or `show all`. */
export function slateButton(slate) {
  return slateActive(slate)
    ? {
      label: 'show all',
      title: 'Bring back every earlier line. Nothing was ever deleted — this is a pointer, not a truncation.',
      action: 'show-all',
    }
    : {
      label: 'clear',
      title: 'Start the room from here. Earlier lines stay in the log and come back with “show all”.',
      action: 'clear',
    };
}
