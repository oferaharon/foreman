/*
 * The single-session fold: when a folder heading is furniture, and how a row's own title
 * splits into the path it sits on and the leaf that names it.
 *
 * A rail of nine one-session folders spends nine lines saying a folder name that the row
 * beneath it repeats — so a folder holding exactly one row prints no heading at all, and
 * its name becomes the start of that row's name: `alpha ▾ / main`. The `▾` rides the path,
 * which is the same `openFolderMenu` that heading carried; nothing is lost, a line is.
 *
 * The eleventh pure module under `web/`, and here for the reason each of the ten before it
 * gives: both rules below are the kind that gets quietly re-derived inline the next time
 * somebody touches `renderRail`, and the wrong re-derivation of either **renders
 * perfectly**. A fold taken one row too eagerly hides a folder heading over two sessions;
 * a title split on its own punctuation invents a path that is not the folder. No DOM, no
 * storage, no `window` — plain objects in, plain objects out.
 *
 * Both rules answer about **rows**, not about sessions, and that distinction is the whole
 * of the first one: a lead with three workers is *one* entry in `renderRail`'s folder map
 * and *four* rows on screen, because `rowsFor` expands a lead into itself plus its nested
 * workers. Callers therefore hand `foldsInto` the expanded list.
 */

/** A trimmed string, or `''` — the same door `panel-fold.js` and `rooms-pane.js` put on
 *  every field that arrives off a roster frame. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Does this row draw a team line?
 *
 * The test is `Boolean(s.team)` and nothing subtler, because that is **exactly** the test
 * `sessionRow` draws the third line on (`if (s.team) btn.append(teamLine(...))`). A second,
 * cleverer spelling here — `team.role === 'lead' || team.role === 'worker'` — would be a
 * fold decided by one rule and a row drawn by another, and the day a third kind of team
 * row appears (a planner already has `role: 'worker'`, and kinds have grown once) the two
 * would disagree silently. One question, one answer, asked of the same field.
 */
const hasTeamLine = (s) => Boolean(s?.team);

/**
 * Does a folder fold into its one row?
 *
 * **Exactly one row, and that row carrying no team line.** Both halves are load-bearing
 * and neither subsumes the other:
 *
 * - The **count** is over rows, so a lead with three workers refuses on it even though the
 *   folder holds one *session*. Hand in the list `rowsFor` will expand to, never the
 *   folder map's own entry.
 * - The **team line** refuses a lead standing alone and a worker standing alone (one that
 *   fell back to its own folder heading because its lead is up in the inbox). The audit
 *   table's ruling is that a lead or worker row keeps its full title however alone it is —
 *   its third line already carries a role and a branch, and a path spliced onto the front
 *   of that is three facts fighting for one line.
 *
 * A folder that does not fold keeps its heading, which is today's rail. That is the
 * direction every uncertainty here lands in on purpose: the fold is the addition, so
 * anything unclear draws what it has always drawn.
 *
 * @param {Array<object>} rows the roster rows this folder is about to draw, expanded
 * @returns {boolean}
 */
export function foldsInto(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  return !hasTeamLine(rows[0]);
}

/**
 * A row's title as a path and a leaf — `{path: 'alpha', leaf: 'main'}` — or `null`.
 *
 * **Only when the title begins with the folder's own name and a dash**, and the path is
 * then that folder rather than a slice of the string. The obvious version of this function
 * splits the title on its last dash, and it is wrong on exactly the rows that matter most.
 *
 * `server/sessions.js` sets `title: label || meta.title || project`. `label` is present
 * only for sessions minted under the configured `sessionPrefix`; for anything else it is
 * `null` and the title falls back to Claude Code's own `customTitle`, which several
 * launchers derive as `<repo>-<branch>` — CLAUDE.md's very first trap, and the reason one
 * folder on the machine this was built on held 96 transcripts under one title. On such a
 * row a string split hands back a "path" that is a *repo* name, not the folder the rail
 * filed the row under, and the fold then prints it as though the panel knew it.
 *
 * So the split is bound to `s.project`, which is `basename(cwd)` and is the same string
 * the folder heading itself draws. **A row that cannot be split keeps its folder's
 * heading** — the fold simply does not fire for sessions started by another launcher. That
 * is honest rather than worked around, and it belongs in the docs: `alpha ▾ / main` when
 * the leaf is real beats a row that invents a path.
 *
 * Two shapes answer `null` that look at first like they should split. A title *equal* to
 * the project (`alpha`, which is what a session with no label and no `customTitle` gets)
 * has no dash and no leaf, so there is nothing to bold and `alpha ▾ /` would trail off
 * into nothing. And a title of exactly `alpha-` leaves an empty leaf, same reason.
 *
 * @param {{title?: string, project?: string}} s a roster row
 * @returns {{path: string, leaf: string}|null}
 */
export function splitTitle(s) {
  const title = str(s?.title);
  const project = str(s?.project);
  if (!title || !project) return null;
  const prefix = `${project}-`;
  if (!title.startsWith(prefix)) return null;
  const leaf = title.slice(prefix.length);
  if (!leaf) return null;
  // `project` rather than `title.slice(0, project.length)`: identical by construction here,
  // and naming the folder is the point — the `▾` the fold puts on this path files *that*
  // folder, so the two must be one string.
  return { path: project, leaf };
}
