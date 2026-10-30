/*
 * asleep.js — the phone's view of sleeping sessions. Hibernation item 5.
 *
 * A session the panel has hibernated has no pane, so it is **not a roster row** and never
 * becomes one: it rides the roster frame as a sibling `asleep` list — `[record + {waiting}]`,
 * keyed by tmux session name — exactly as `rooms` does. Nothing in `state.sessions` ever
 * holds one, which is what keeps every reader of that list (the tab marks, `needsKind`, the
 * route claims) from being handed a session that cannot be typed into.
 *
 * The maintainer's rulings of 2026-10-29 for the phone, and this file is the whole of them:
 *
 *   - a sleeper is drawn **greyed, in its usual list** — an ordinary session on
 *     Standalones, a lead as its team's card on Leads;
 *   - a tap opens the **read-only conversation** with **Wake** where the composer goes, and
 *     Wake is the desktop's own route, `POST /api/asleep/:name/wake`;
 *   - **no keep-awake toggle and no forget** — the phone stays a read-and-answer surface.
 *
 * Pure, and imported by `web/m/app.js` rather than inlined into it, because that file reaches
 * for `document` at module scope and cannot be loaded in `node --test`: a route claim that
 * can only be read out of the source is a claim nothing ever runs (`roles.js` left the shell
 * for the same reason).
 */

/**
 * The sleepers that are really asleep — every record whose name is not live right now.
 *
 * A wake removes the record before it broadcasts, so a name in both lists should never be
 * seen. It is filtered anyway because the cost of the other answer is a session drawn twice,
 * one row of which opens onto a Wake button for something already running. The live row
 * wins: it is the one that can be answered.
 *
 * @param {Array<any>|null} asleep the frame's `asleep`, or null before the first frame
 * @param {Array<any>|null} sessions the roster
 */
export function sleepersIn(asleep, sessions) {
  if (!Array.isArray(asleep)) return [];
  const live = new Set((sessions || []).map((s) => s?.tmuxSession).filter(Boolean));
  return asleep.filter((r) => r && typeof r.name === 'string' && r.name && !live.has(r.name));
}

/**
 * The sleepers the Standalones tab draws: every one that was not a lead when it slept.
 *
 * Written as the record's own `lead` flag and nothing else. A worker never sleeps (the
 * verdict's first rule, an allow-list in `server/snapshot.js`), so there is no third kind
 * here to exclude — and if one ever appeared, the route below would still open it read-only
 * and nothing more.
 */
export function standaloneSleepers(asleep, sessions) {
  return sleepersIn(asleep, sessions).filter((r) => !r.lead);
}

/**
 * A team's sleeping lead, or null — matched on the record's `folder`, which is the pane's
 * launch folder (`paneCwd`), the same key `leadFor` matches a live lead on. A `cwd` would
 * move with the session; the folder it was launched in does not.
 */
export function sleepingLeadFor(asleep, sessions, repo) {
  if (!repo) return null;
  return sleepersIn(asleep, sessions).find((r) => r.lead && r.folder === repo) || null;
}

/** One sleeper by name, or null. */
export function sleeperNamed(asleep, sessions, name) {
  if (!name) return null;
  return sleepersIn(asleep, sessions).find((r) => r.name === name) || null;
}

/**
 * The sleeper a live conversation screen was showing, by its session id — so a session that
 * goes to sleep under the reader's eyes turns into its read-only view rather than into
 * "no longer running". A resume keeps the id (measured, plan item 2), so this is also the
 * key the screen follows back the other way.
 */
export function sleeperFor(asleep, sessions, sessionId) {
  if (!sessionId) return null;
  return sleepersIn(asleep, sessions).find((r) => r.sessionId === sessionId) || null;
}

/**
 * The live row a woken sleeper came back as, or null while it is still on its way.
 *
 * By **tmux session name** first: names are the contract a wake is held to (it refuses to
 * mint any other) and pane ids reset. The session id is the fallback, for the one window in
 * which the roster has the row and not yet its name.
 */
export function wokenRow(sessions, { name, sessionId } = {}) {
  const rows = sessions || [];
  return (
    (name && rows.find((s) => s?.tmuxSession === name)) ||
    (sessionId && rows.find((s) => s?.id === sessionId)) ||
    null
  );
}

/**
 * Where a woken session opens: a lead on its own route, anything else as an ordinary
 * session. Asked of the **live row**, never of the record — the route claims (`roles.js`)
 * re-check the row on every frame, and a hash built off a stale record could name a route
 * the claim then refuses.
 */
export function liveRouteFor(row) {
  if (!row?.id) return null;
  return `#/${row.isLead ? 'lead' : 'session'}/${encodeURIComponent(row.id)}`;
}

/**
 * `waiting 2`, or the empty string. Held messages for a sleeper are delivered after it wakes,
 * so the count is a fact about the row and never a summons: muted, no dot, no tab mark.
 */
export function waitingWord(record) {
  const n = Number(record?.waiting) || 0;
  return n > 0 ? `waiting ${n}` : '';
}
