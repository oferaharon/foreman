/*
 * Who a roster row is, on the phone — and which conversation route may show it.
 *
 * Every conversation hash makes a **claim** about the id it names: `#/lead/<id>` says "this
 * is a team lead", `#/session/<id>` says "this belongs to nobody's team", and `#/worker/<id>`
 * says "this is one of a team's workers". The shell re-checks that claim against the roster
 * on **every frame**, not once at mount, and that is a security control rather than
 * tidiness: a lead was measured `/exit`ing and the registry re-binding that *same session id*
 * to a different pane in the same folder, with the screen still updating under the same URL.
 * `routeRefusal` is that check, and `web/m/app.js` asks nothing else.
 *
 * It lives here rather than inside `web/m/app.js` for `recent.js`'s reason one file over:
 * the shell reaches for `document` at module scope and cannot be imported in `node --test`,
 * and a security control that can only be read out of the source is one nothing ever runs.
 * Pure — no DOM, no storage, one import, which is itself pure.
 *
 * **Each claim is an allow-list, never "not the other kinds".** Kinds have grown here once
 * already (`planner`), and a negative test silently admits the next one. A route this file
 * has never heard of is refused outright rather than falling through to whichever branch
 * happens to be last.
 *
 * **Workers open from the phone since the maintainer's ruling of 2026-10-08**, which reversed
 * the 2026-08-29 rule (reaffirmed 2026-09-07) that a worker was never opened here. What did
 * *not* move: a worker is still never on the Standalones list — `standalonesIn` is
 * unchanged — and a worker's box still lights neither the Leads tab nor its lead's card;
 * `needsKind`'s worker quieting in `web/notify.js` is the attention policy and this file
 * decides only who may be *shown*.
 */

import { roomParticipants } from '../rooms-create.js';

/**
 * Every ordinary session — the Standalones tab's list, and what `#/session/` admits.
 *
 * `roomParticipants` is the allow-list, imported rather than restated: `interactive` and
 * `team?.role` either absent or `lead`. Subtracting the leads then leaves exactly the
 * sessions that belong to nobody's team. The desktop's room picker asks the same function,
 * so the phone cannot show as ordinary a session the Mac would refuse to put in a room.
 *
 * `isLead` is the roster's own `team?.role === 'lead'`, written out once in `sessions.js` —
 * one field, not a second opinion.
 */
export function standalonesIn(sessions) {
  return roomParticipants(sessions || []).filter((s) => !s.isLead);
}

/**
 * Is this row a live worker of some team — what `#/worker/` admits.
 *
 * Positive on every clause. `team.role === 'worker'` is the role `workerTeam` in
 * `server/sessions.js` writes for every task-backed row, planners included (a planner is a
 * worker with `kind: 'plan'` on its task, not a different role), and `workerOf` is read back
 * off that same `#team()` answer — so the two must agree on the repo, and a row whose fields
 * disagree is refused rather than believed on either one. `!isLead` only ever narrows: the
 * registry answers lead first and a lead never carries the worker role, so it costs nothing
 * and holds if that ever stops being true.
 *
 * "Live" is the roster's job, not this function's: the roster holds only sessions with a
 * pane, so a worker whose task closed and whose pane went is simply not there — and the
 * shell's gone timer is what answers that.
 */
export function isTeamWorker(s) {
  return (
    Boolean(s) &&
    !s.isLead &&
    s.team?.role === 'worker' &&
    typeof s.workerOf === 'string' &&
    s.workerOf !== '' &&
    s.workerOf === s.team.repo
  );
}

/**
 * What the phone calls a worker — the line under its lead's card and the header of the
 * screen that line opens, one spelling for both.
 *
 * The branch first, and **not** the roster's `label`, which is the tempting field and is
 * the wrong one here: `sessions.js` slices only the session prefix, so a worker's label
 * arrives as `<folder>-<task>` — the folder included — and every line under a card already
 * titled with that team would repeat it and then ellipsise away the half that identifies
 * the worker. The branch is `agent/<task>`, it is what you would type into git, and it is
 * the same chain the desktop rail's own worker line reads (`team.branch || team.task`).
 * The label is kept as the last resort rather than dropped, because a row that arrived
 * without a task join should still be named something rather than blank.
 */
export function workerName(s) {
  return s?.team?.branch || s?.team?.task || s?.label || 'worker';
}

/**
 * Whether a conversation route of this `kind` may show this row, and which refusal it is
 * when it may not: `null` to show it, or `'not-lead'`, `'not-standalone'`, `'not-worker'`,
 * `'unknown-route'`.
 *
 * Each route asks its own allow-list and nothing else — the standalone half asks the
 * **list** (`standalonesIn`), never a second filter written out here, because a membership
 * test spelled twice drifts, and it drifts towards letting something in.
 *
 * A row that is not on the roster at all is **not** a refusal — that is a beat during a
 * rebound or a rotation, and the shell's gone timer covers a session that never arrives.
 *
 * @param {string} kind     the route's kind: `'lead'`, `'session'` or `'worker'`
 * @param {object|null} s   the roster row the hash's id names right now, or null
 * @param {object[]} sessions the whole roster, for the standalone list
 */
export function routeRefusal(kind, s, sessions) {
  if (!s) return null;
  if (kind === 'lead') return s.isLead ? null : 'not-lead';
  if (kind === 'session') {
    return standalonesIn(sessions).some((r) => r.id === s.id) ? null : 'not-standalone';
  }
  if (kind === 'worker') return isTeamWorker(s) ? null : 'not-worker';
  return 'unknown-route';
}
