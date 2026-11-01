/*
 * The rail narrowed to one group: which rows survive, what the clear toggle counts, and the
 * pinned order a drag may write while some pins are off screen.
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
 * server-side consumer never hear of it. It is keyed by group id, kept per browser
 * (`railFilter` in `web/prefs.js`), and membership is by folder — the same `s.project` the
 * group loop in `renderRail` files rows by, so a row is in the filter exactly when it would
 * be drawn under that group's heading.
 */

/**
 * The folders the filter keeps, or `null` when there is no filter to apply — none set, or
 * the group it names no longer exists. `null` is the caller's cue to clear a stale id.
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
 * The `paneCwd` of every lead the filter keeps — the key `renderRail` nests workers by
 * (`leadRows` is keyed on `paneCwd`, a worker's `workerOf` is its lead's repo). A worker's
 * own `project` is its worktree folder, which is never filed in a group, so this is the
 * only way it can follow its lead through the filter. `null` when there is no filter.
 *
 * @param {object[]} sessions the live roster
 * @param {Set<string>|null} folders
 * @returns {Set<string>|null}
 */
export function keptLeads(sessions, folders) {
  if (!folders || !Array.isArray(sessions)) return null;
  const out = new Set();
  for (const s of sessions) {
    if (s && s.isLead && s.paneCwd && folders.has(s.project)) out.add(s.paneCwd);
  }
  return out;
}

/**
 * Whether one rail row survives the filter. `null` folders means no filter: everything does.
 * A sleeper is a row like any other here — `asleepItem` gives it the same `project`.
 * A worker also survives whenever its lead does (`leads` from `keptLeads`).
 */
export function inFilter(row, folders, leads) {
  if (!folders) return true;
  if (!row) return false;
  if (folders.has(row.project)) return true;
  return Boolean(row.workerOf) && Boolean(leads) && leads.has(row.workerOf);
}

/**
 * How many sessions the filter is hiding that want the maintainer — the number the clear
 * toggle carries, so nothing outside the group waits on them silently.
 *
 * `wants` is the caller's own inbox rule (`needsYou` less a quiet worker), passed in rather
 * than re-spelled here: the count must be about exactly the rows the inbox would have
 * hoisted, and a second spelling would drift from the first the day the inbox rule changes.
 * It is taken over **every** live session — pinned ones included, since a pinned row that
 * wants you is hidden by the filter just the same — and never over sleepers, which by the
 * sleep rule had nothing unread and were asking nothing.
 *
 * @param {object[]} sessions the live roster
 * @param {Set<string>|null} folders
 * @param {(s: object) => boolean} wants
 */
export function hiddenWanting(sessions, folders, wants) {
  if (!folders || !Array.isArray(sessions)) return 0;
  const leads = keptLeads(sessions, folders);
  let n = 0;
  for (const s of sessions) if (s && !inFilter(s, folders, leads) && wants(s)) n++;
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
