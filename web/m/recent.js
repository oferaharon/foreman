/*
 * Newest first, on the phone and only on the phone.
 *
 * Two lists here are ordered by when something last happened in them — the Standalones tab
 * (`standaloneSorted` in `web/m/app.js`, on the roster row's `lastActivity`) and the Rooms
 * tab (`roomsListView` in `web/m/rooms.js`, on the record's `lastAt`). Both were ordered by
 * facts that do not move until the maintainer asked for recency on **2026-09-16**: *"On
 * mobile only I'd like the standalone and rooms lists to be sorted by recent at the top."*
 * The desktop keeps the orders it had, and `web/rooms-band.js` says so from the other end.
 *
 * It is one comparator rather than two so the two lists cannot disagree about what recency
 * means — the `isLeadName` rule this repo keeps relearning, in its smallest possible form.
 * The field differs, the tie-break and the missing-stamp rule do not.
 *
 * **The cost, stated because it is real and was accepted:** a row moves when activity moves,
 * so the row you are reaching for can slide out from under a thumb the instant another
 * session says something. That is the trade the maintainer made, and it is the reason the
 * repaint guards on both screens still matter — a signature that carried the raw stamp would
 * repaint on every roster frame instead of only when the order actually changed. Neither
 * signature carries one: both spell their rows' ids out **in list order**, so a reorder
 * changes the string and a stamp advancing without a reorder does not.
 *
 * Pure, and imported by both screens rather than inlined into either — `web/m/app.js` cannot
 * be imported in `node --test` (it reaches for `document` at module scope), and a comparator
 * that can only be read out of the source is a comparator whose tie-break is never actually
 * run.
 */

/**
 * One row's stamp, as a number that can be compared.
 *
 * Anything that is not a real positive millisecond count — absent, `null`, `0`, a string
 * that will not parse, `NaN`, a negative — answers `0`, which under the descending sort
 * below puts it **at the bottom** rather than anywhere random. A pane-only roster row always
 * carries one (`pane.createdMs`), so in practice this is the room the store has never had a
 * word said in; it still has to land somewhere deterministic.
 */
export function recentStamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Newest first by `field`, then by `id`.
 *
 * The id is the tie-break for the reason the orders it replaces used it: two rows that
 * genuinely share a stamp — two sessions minted in the same millisecond, two rooms that have
 * never been spoken in — must not swap places between frames, and the id is the one fact on
 * either record that is unique and does not move. `localeCompare` with an explicit locale,
 * the way every other sort in `web/m/` spells it.
 */
export function byRecent(field) {
  return (a, b) =>
    recentStamp(b?.[field]) - recentStamp(a?.[field]) ||
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'en');
}
