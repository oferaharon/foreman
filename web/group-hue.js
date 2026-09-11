/*
 * A group's colour: which slot of the rail's ring it wears, and how that slot is spelled.
 *
 * The rail is about to carry a **spine** — a 3px bar down the left edge of an open
 * group's block — so every group needs a colour, and the colour has to survive a reload,
 * a `/clear` and a restart. It therefore lives on the group record (`server/groups.js`),
 * which means the *assignment rule* has to be reachable from the server; the *slot count*
 * has to be reachable from the browser, which is what will draw the swatch row; and the
 * tokens themselves live in `web/tokens.css`, which is neither.
 *
 * Hence this module, and hence the direction of the import: **`server/groups.js` imports
 * it from here**, the way `server/outputs.js` imports `web/output-exts.js` and
 * `server/index.js` imports `web/trust-gate.js`. The count is then spelled once for
 * JavaScript, and `test/group-hue.test.js` holds it against the number of `--group-N`
 * tokens in the stylesheet — which is the only mechanism available, since CSS cannot
 * import anything.
 *
 * What is deliberately **not** here: a hash of the group's name. That is what the room's
 * speaker ring does (`web/session-colour.js`), it is right there, and it is right *there* —
 * a hash collision in a log means two speakers share a pill colour, which is a mild
 * nuisance. Here a collision means two groups **adjacent in the rail** wearing the same
 * spine, which is the one thing the spine exists to prevent. So slots are handed out by
 * counting what is already taken, not by hashing a string.
 */

/**
 * How many slots the ring has.
 *
 * Ten, and the number is not a guess. There are **eight** groups on the machine this was
 * built on, so the mock-up's six and the room's seven both wrap before the rail is even
 * full; ten leaves room and is still measurable — see the `--group-N` comment in
 * `web/tokens.css` for the contrast and ΔE2000 figures every one of the ten had to clear
 * in both themes. Changing this number means re-measuring that block, and the test will
 * say so.
 */
export const GROUP_COLOUR_COUNT = 10;

/** Is this a slot at all? The one place the range is spelled. */
export const isGroupColour = (n) =>
  Number.isInteger(n) && n >= 1 && n <= GROUP_COLOUR_COUNT;

/**
 * The custom property a slot resolves through — `hueVar(3)` → `var(--group-3)`.
 *
 * A function rather than a table so the count above is the only thing that bounds it, and
 * deliberately unvalidated: every caller in this repo holds a slot that
 * `isGroupColour` has already passed, and a helper that silently substituted a *different*
 * colour for a bad slot would paint the wrong group the wrong colour rather than nothing.
 */
export const hueVar = (n) => `var(--group-${n})`;

/**
 * The slot a new group gets: **least-used, ties broken by the lowest index.**
 *
 * With fewer groups than slots this hands out 1, 2, 3… in creation order, which is why
 * the ring in `web/tokens.css` is ordered so that *consecutive* slots are the furthest
 * apart — the first few groups on a rail are the ones that have to look nothing like each
 * other. Past ten it wraps to whichever slot is carrying the fewest groups, so a rail of
 * twelve groups has two doubled-up pairs rather than two collisions on slot 1.
 *
 * Anything in `groups` whose `colour` is not a slot is counted as nothing, which is what
 * makes this safe to run over a store that has just been read off disk with records that
 * predate the field — `GroupStore` backfills them through this same function, in list
 * order, so each one sees what the ones before it took.
 *
 * @param {Array<{colour?: unknown}>} [groups] the groups that already exist
 * @returns {number} a slot in `1..GROUP_COLOUR_COUNT`
 */
export function assignColour(groups = []) {
  const used = new Array(GROUP_COLOUR_COUNT).fill(0);
  for (const g of groups ?? []) {
    const n = g?.colour;
    if (isGroupColour(n)) used[n - 1] += 1;
  }
  let slot = 0;
  for (let i = 1; i < used.length; i++) if (used[i] < used[slot]) slot = i;
  return slot + 1;
}
