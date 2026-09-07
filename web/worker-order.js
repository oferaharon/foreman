/*
 * The order a lead's workers are drawn in, which is the one order in the rail that never
 * changes.
 *
 * The eleventh pure module under `web/`, and here for the reason `trust-gate.js` set and
 * the nine after it kept: a rule about which row goes above which is something a node test
 * can hold, and the same comparator inlined into `renderRail` is not. No DOM, no storage,
 * no `window` — an array of roster rows in, a new array out.
 *
 * **Everything else in the rail is recency, and that is right everywhere except here.**
 * The roster hands sessions over most-recently-active first, which is what makes the folder
 * you were last in sit near the top of whatever holds it. Under a lead it is wrong: a team
 * is read as a block, a worker is found by where it was the last time you looked, and
 * "speak to one and it jumps" is a rail that has to be re-read every time it is glanced at.
 * So a lead's workers are sorted **once, by when they were dispatched, newest on top**, and
 * then left alone for as long as they run.
 *
 * That only holds because the key cannot move. `since` is the task's `dispatchedAt`,
 * stamped at the transition to `dispatched` and never written again (`workerTeam` in
 * `server/sessions.js` is the one place it is read off the record) — so a row that is
 * repainted for any other reason comes back in the same place. A key derived from activity,
 * or recomputed here from anything the poll can see, would quietly put the old behaviour
 * back under a function named for the new one.
 *
 * Three rules it is strict about, each of which would cost something real.
 *
 * **It never throws and never drops a row.** A rail row that vanishes is the panel's worst
 * failure — same class as a blanked transcript — and a sort helper is a silly place to
 * risk it. A row with no readable stamp is not an error and is not skipped: it sorts last,
 * in the order it arrived, which is exactly what an older panel's rows or a row the task
 * join missed should do. Fail open, in the direction of still being on screen.
 *
 * **The tie-break is the task id, not the index.** Two workers dispatched in the same
 * millisecond is not a real event, but a tie broken by arrival order is a tie broken by
 * recency — the thing this module exists to remove — so it would reorder on a slow day and
 * nothing else. The id is a fact about the ticket and holds still.
 *
 * **It answers a new array.** `renderRail` files workers into a Map as it walks the roster;
 * sorting that array in place would mean the order depended on whether this had been called
 * yet, which is the kind of thing that works until a second caller appears.
 */

/**
 * The dispatch stamp on a roster row, or `null` if there isn't a usable one.
 *
 * Deliberately narrow: a finite number and nothing else. A stamp that arrives as a string,
 * a `NaN` or an ISO date is not a stamp this comparator can order against, and reading it
 * as one would put a row somewhere arbitrary rather than at the end where it can be seen.
 */
const stampOf = (row) => {
  const n = row?.team?.since;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** The ticket a row belongs to, as a string — the tie-break, and `''` for a row without one. */
const taskOf = (row) => String(row?.team?.task ?? '');

/**
 * A lead's nested workers, newest dispatch first.
 *
 * @param {Array<object>} rows the worker rows filed under one lead, in roster order
 * @returns {Array<object>} the same rows, ordered; a new array, never the input
 */
export function orderWorkers(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row, i) => ({ row, i, since: stampOf(row) }))
    .sort((a, b) => {
      // Undated rows go last, and keep the order they arrived in among themselves.
      if (a.since === null || b.since === null) {
        if (a.since === b.since) return a.i - b.i;
        return a.since === null ? 1 : -1;
      }
      if (a.since !== b.since) return b.since - a.since;
      const ta = taskOf(a.row);
      const tb = taskOf(b.row);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.i - b.i;
    })
    .map((e) => e.row);
}
