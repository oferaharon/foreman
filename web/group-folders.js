/*
 * Which folders a group's `+` may offer.
 *
 * The rail's group header gains a `+`: pick a folder and file it here, one click. That is
 * the reverse of the flow that already exists — today a folder is filed from its *own* `▾`,
 * which means finding it in the rail first, and the rail is exactly what you are looking at
 * when you know the group and not the folder.
 *
 * The rule it needs is one line to describe and two ways to get wrong, which is why it is a
 * module and not an inline `filter` inside the menu builder. The twelfth pure module under
 * `web/`, here for the reason each of the eleven before it gives: both mistakes below
 * **render perfectly**. A menu that forgets to exclude the group's own folders offers a
 * pick that is a no-op, and the reader is left wondering whether the click missed. A menu
 * built from the sessions alone silently loses every folder that is filed somewhere but has
 * nothing running in it right now — so a folder you filed this morning is unmovable this
 * afternoon, with nothing on screen saying why.
 *
 * **What it can offer is what the browser knows**, and that bound is deliberate. A folder
 * with no live session and no filing has never reached this client in any frame; the panel
 * does not enumerate directories and this change does not add an endpoint that would. The
 * menu says so in its empty state rather than pretending the list is the disk.
 *
 * No DOM, no storage, no `window` — plain objects in, plain strings out.
 */

/** A trimmed string, or `''` — the same door `rail-fold.js` puts on every roster field. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Every folder this client has heard of: one with a live session, plus one filed in any
 * group.
 *
 * The union is the whole point. `state.sessions` alone misses a quiet folder that is
 * already filed; `state.groups` alone misses a folder that is running and ungrouped — which
 * is the common case, since an ungrouped folder is precisely what you reach for the `+` to
 * fix.
 *
 * @param {Array<{project?: string}>} [sessions] roster rows
 * @param {Array<{folders?: string[]}>} [groups] group records
 * @returns {string[]} folder names, de-duplicated, in no particular order
 */
export function knownFolders(sessions = [], groups = []) {
  const out = new Set();
  for (const s of sessions ?? []) {
    const f = str(s?.project);
    if (f) out.add(f);
  }
  for (const g of groups ?? []) {
    for (const f of g?.folders ?? []) {
      const name = str(f);
      if (name) out.add(name);
    }
  }
  return [...out];
}

/**
 * The folders a group's `+` may offer: everything the client knows about, **less whatever
 * is already in this group**.
 *
 * Folders filed in *other* groups stay in the list, and that is `assign`'s own semantics
 * rather than a decision taken here — a folder is in exactly one group, so picking one from
 * another group moves it. The menu says which group it is leaving; this function only says
 * it is offerable.
 *
 * Sorted, case-insensitively, with the raw string as the tiebreak so the order is total and
 * does not depend on `Set` insertion — a list you type into is a list you scan, and a stable
 * alphabetical order is the only one a reader can predict. No locale collation: the answer
 * must be the same on every machine a bench runs on.
 *
 * An unknown `groupId` (a group deleted under an open menu, say) excludes nothing, which is
 * the safe direction — an over-full list costs one no-op pick, and this function never
 * performs the assign itself.
 *
 * @param {Array<{project?: string}>} [sessions] roster rows
 * @param {Array<{id?: string, folders?: string[]}>} [groups] group records
 * @param {string} [groupId] the group the `+` was clicked on
 * @returns {string[]} folder names, sorted
 */
export function eligibleFolders(sessions = [], groups = [], groupId = null) {
  const mine = new Set(
    (groups ?? []).find((g) => g?.id === groupId)?.folders?.map(str).filter(Boolean) ?? [],
  );
  return knownFolders(sessions, groups)
    .filter((f) => !mine.has(f))
    .sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/**
 * Does this label survive the menu's filter box?
 *
 * Case-insensitive substring, and **the same function the menu applies**, which is the
 * whole reason it lives here beside the list it filters rather than inline in `openMenu`:
 * a test that proves the exclusion rule against one spelling of "matches" while the browser
 * runs another proves nothing about what is on screen.
 *
 * An empty query matches everything — a filter box you have not typed in yet hides nothing.
 *
 * @param {string} label the item's own label
 * @param {string} query what has been typed
 * @returns {boolean}
 */
export const matchesFilter = (label, query) =>
  str(label).toLowerCase().includes(str(query).toLowerCase());
