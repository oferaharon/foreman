/*
 * What a folded group is hiding, in one line.
 *
 * A collapsed group draws one row on screen: its name, its caret, its `· N`. Collapsing is
 * only safe because the inbox hoists anything blocked or unread *out* of its folder first —
 * but **working** is neither, so a busy session is the one state a closed group can
 * genuinely hide. The pulsing dot on the heading has stood in for that since groups
 * existed; this adds the rest of the sentence beside it: `2 working · newest 4m · 3 tasks`.
 *
 * The thirteenth pure module under `web/`, here for the reason each of the twelve before it
 * gives: every mistake available in this arithmetic **renders perfectly**. A count taken
 * over the wrong set draws a calm heading over three running workers; a zero clause printed
 * rather than omitted reads `0 tasks` under a group that has no team in it at all; a second
 * spelling of the age buckets drifts from the one the rows themselves use and nobody
 * notices, because the two are never on screen at the same time — the group is folded.
 *
 * **The set it counts over is worker-inclusive, and it deliberately disagrees with the
 * heading's own `· N` one line up.** `renderRail` lifts a lead's nested workers out of
 * `rest` before the folder map is built, so `count` — and the dot's old input — cover
 * top-level rows only: a worker working inside a closed team group lit nothing until the
 * stuck timer fired, twenty minutes later. That hole is what this closes, on the
 * maintainer's own ruling, and the accepted cost is written down with it: a collapsed team
 * group now pulses when only a worker is busy. The heading's `· N` is left exactly as it
 * was. Two numbers about two different sets, one line apart, on purpose.
 *
 * No DOM, no storage, no `window` — plain objects in, plain numbers and strings out.
 */

/**
 * How long ago, in the rail's own spelling: `now`, `4m`, `3h`, `2d`, and `''` for a
 * timestamp that is not there.
 *
 * **This is `relativeTime`'s body**, lifted here rather than copied: `web/app.js` delegates
 * to it, so the age on a folded group's summary and the age in a row's meta line cannot
 * come to disagree about where a bucket ends. That is the `isLeadName` lesson in its
 * smallest available costume — the two strings are never on screen together, which is
 * exactly what would let a second spelling drift unnoticed.
 *
 * `now` is a parameter rather than a `Date.now()` inside, which is the only reason this is
 * testable at all.
 *
 * @param {number|null|undefined} ms a wall-clock timestamp
 * @param {number} [now] the clock to read it against
 * @returns {string}
 */
export function ageText(ms, now = Date.now()) {
  if (!ms) return '';
  const d = Math.max(0, now - ms) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** A finite, positive number, or `null` — the door every roster field goes through here. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The three facts a folded group's summary is made of, plus the clauses they render as.
 *
 * @param {Array<object>} rows the group's sessions, **workers included** — the top-level
 *   rows plus every worker nested under a lead among them. Callers expand with the same
 *   map `renderRail` already built; this function never knows about nesting, it only
 *   counts what it is handed, which is what keeps the set a decision made in one place.
 * @param {number} [now] the clock the age is read against
 * @returns {{working: number, newestMs: number|null, tasks: number|null, clauses: string[]}}
 */
export function groupSummary(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];

  // The same test `renderRail` has always used for the dot, asked of a wider set.
  const working = list.filter((s) => s?.status === 'working').length;

  let newestMs = null;
  for (const s of list) {
    const at = num(s?.lastActivity);
    if (at !== null && (newestMs === null || at > newestMs)) newestMs = at;
  }

  /*
   * Open tasks, read off the roster's `team` field **exactly as `teamLine` reads it** —
   * `team.role === 'lead'` and then `team.tasks || 0`. Never a second count taken from
   * somewhere else: `server/sessions.js` already filtered that number to `OPEN_STATES`, so
   * a `done` or `failed` task is out of it before the roster leaves the server, and a
   * client-side re-derivation would be a different question wearing the same word.
   *
   * `null` rather than `0` when the group holds no lead at all, because those are two
   * different facts: a group with no team has nothing to say about tasks, while a lead
   * with an empty board says `no tasks` on its own row. Both draw no clause; only one of
   * them could ever grow one.
   */
  let tasks = null;
  for (const s of list) {
    if (s?.team?.role !== 'lead') continue;
    tasks = (tasks ?? 0) + (s.team.tasks || 0);
  }

  const facts = { working, newestMs, tasks };
  return { ...facts, clauses: summaryClauses(facts, now) };
}

/**
 * The line, clause by clause: `['2 working', 'newest 4m', '3 tasks']`.
 *
 * **A clause that is zero is omitted, never printed as a zero.** `0 tasks` under a group
 * with no team in it is furniture in the exact sense the rail already refuses it — the
 * same call `folderHeading`'s `if (count > 0)` and `teamLine`'s `· N in review` both make.
 * What is left when every clause is empty is an empty array, and the caller draws no line
 * rather than an empty one.
 *
 * Returned as clauses rather than as a string because the heading draws a `·` between them
 * as its own muted element, the way the meta line does. `summaryText` is the same answer
 * for anything that wants it flat — a tooltip, a test, a report.
 *
 * @param {{working?: number, newestMs?: number|null, tasks?: number|null}} summary
 * @param {number} [now]
 * @returns {string[]}
 */
export function summaryClauses(summary, now = Date.now()) {
  const out = [];
  const working = summary?.working || 0;
  // "working" is not a noun here, so there is no singular to spell: `1 working` is right.
  if (working > 0) out.push(`${working} working`);

  const age = ageText(summary?.newestMs, now);
  if (age) out.push(`newest ${age}`);

  const tasks = summary?.tasks;
  if (typeof tasks === 'number' && tasks > 0) out.push(`${tasks} task${tasks === 1 ? '' : 's'}`);

  return out;
}

/** The same line as one string — `2 working · newest 4m · 3 tasks`, or `''`. */
export const summaryText = (summary, now = Date.now()) =>
  summaryClauses(summary, now).join(' · ');
