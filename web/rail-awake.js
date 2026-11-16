/*
 * The rail with its sleepers hidden — the rail head's "awake only" toggle (the maintainer's
 * ask of 2026-11-16).
 *
 * A leaf with no imports, pure for `rail-filter.js`'s reason: every mistake available here
 * renders perfectly. A sleeper let through reads as a toggle that does nothing; a funnel that
 * lets go because this toggle emptied it reads as the funnel forgetting what it was asked;
 * and a drag that writes only the drawn pins is a partial order the server refuses.
 *
 * What it is, said once: **a second, independent statement about what this browser's rail
 * draws** — on or off, stored per browser (`awakeOnly` in `web/prefs.js`), never a third
 * value of the group/room funnel's one stored string. The two compose: a row is drawn when
 * the funnel keeps it *and* this toggle keeps it. Nothing on disk hears of it — not pins, not
 * a group's collapse, not a sleep record — and nothing server-side does either.
 *
 * Where it bites is the one place the rail decides a sleeper is drawn: the `shown` predicate
 * `renderRail` cuts every list with, *before* the folder map is built. So a folder whose only
 * sessions are asleep has no rows, and the empty-heading rule
 * (rail-and-groups#an-empty-heading-isnt-drawn) drops its heading and then its group's —
 * the same rule, unchanged, measuring what is now drawn.
 */

/** Whether the toggle keeps this row: everything while off, only the awake while on. */
export function awakeShown(row, on) {
  return !on || !row?.asleep;
}

/**
 * The rail's one `shown` predicate: the funnel's answer (`inFunnel`, already bound to its
 * filter and kept leads) and this toggle's, both. Either can be absent — no funnel keeps
 * everything.
 *
 * @param {((row: object) => boolean)|null} inFunnel
 * @param {boolean} awakeOnly
 */
export function railShown(inFunnel, awakeOnly) {
  return (row) => (inFunnel ? inFunnel(row) : true) && awakeShown(row, awakeOnly);
}

/**
 * Whether the funnel has anything at all to draw — live rows or sleepers, pinned or not —
 * **regardless of this toggle**. The funnel lets go of itself when it would leave a blank
 * rail (its group or room emptied out from under it); this toggle emptying it is not that,
 * and must not cost the maintainer the funnel they set. Turning the toggle off again has to
 * hand back exactly the funnel it found.
 *
 * @param {object[]} sessions the live roster
 * @param {object[]} sleepers `asleepItems`
 * @param {(row: object) => boolean} inFunnel
 */
export function funnelHolds(sessions, sleepers, inFunnel) {
  const any = (list) => (Array.isArray(list) ? list : []).some((s) => s && inFunnel(s));
  return any(sessions) || any(sleepers);
}

/**
 * How many sleepers the toggle is keeping off this rail right now — the ones the funnel
 * would otherwise draw. `0` while off. For the toggle's title, never a badge: the head has
 * no width for one (rail-and-groups#a-fifth-button-in-the-rail-head), and the rail's own
 * stat line already prints `asleep N`.
 */
export function hiddenSleepers(sleepers, inFunnel, on) {
  if (!on) return 0;
  return (Array.isArray(sleepers) ? sleepers : []).filter((s) => s && (inFunnel ? inFunnel(s) : true)).length;
}

/**
 * The toggle's face: pressed while sleepers are hidden, and a title that says what a click
 * will do — the `recent` toggle's own convention.
 */
export function awakeToggleFace(on, hidden = 0) {
  const n = Number.isInteger(hidden) && hidden > 0 ? hidden : 0;
  const what = n ? `the ${n} sleeping session${n === 1 ? '' : 's'}` : 'sleeping sessions';
  return {
    pressed: Boolean(on),
    title: on ? `Show ${what}` : 'Hide sleeping sessions',
    label: on ? `Show ${what}` : 'Hide sleeping sessions',
  };
}
