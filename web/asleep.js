/*
 * Sleepers on the desktop rail — where each greyed row goes, and what a pane showing one
 * follows. A leaf with no imports, so the tests load it as it is.
 *
 * A sleeper is **not** a roster row and never becomes one: it rides the frame as the sibling
 * `asleep` field (`server/index.js`'s `rosterFrame`), and nothing that walks `sessions` —
 * the inbox, notifications, unread, pins, `adopt`'s own pick — is ever handed one. What the
 * rail draws is an *item* built from the record, `{asleep: true, …}`, which `renderRail`
 * slots into the lists it already builds: the pinned group after the row it sat under, and
 * its folder (and so its group) by its stored `lastActivity`, exactly where it was.
 *
 * The maintainer's rulings of 2026-10-29: a sleeping row stays where it was, greyed; it is
 * opened read-only; only Wake restarts it; there is no manual sleep anywhere.
 */

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The folder's last path segment — what the rail heads a folder with for a live row. */
export function folderName(folder) {
  const parts = str(folder).split('/').filter(Boolean);
  return parts.at(-1) || '';
}

/**
 * One record from the frame, as a rail item — or `null` for a record with no name, which
 * nothing could wake or forget.
 *
 * `project` falls back to the folder's basename, the server's own spelling of it for a live
 * row (`path.basename(pane.cwd)`), so a record written without one still lands under the
 * heading its session sat under. `team` is set on a lead for one reader: `foldsInto` refuses
 * to fold a row that draws a team line, and a sleeping lead keeps that third line, so a lead
 * whose folder holds nothing else does not change shape when it goes to sleep.
 */
export function asleepItem(record) {
  const name = str(record?.name);
  if (!name) return null;
  const project = str(record.project) || folderName(record.folder) || 'unknown';
  const lead = record.lead === true;
  return {
    asleep: true,
    name,
    tmuxSession: name,
    sessionId: str(record.sessionId) || null,
    title: str(record.title) || name,
    project,
    folder: str(record.folder) || null,
    lead,
    team: lead ? { role: 'lead', asleep: true } : null,
    bypass: record.bypass === true,
    pinned: record.pinned === true,
    pinAfter: str(record.pinAfter) || null,
    sleptAt: num(record.sleptAt),
    idleSince: num(record.idleSince),
    lastActivity: num(record.lastActivity),
    model: str(record.model) || null,
    waiting: Math.max(0, Math.floor(num(record.waiting) ?? 0)),
  };
}

/** Every drawable sleeper in the frame's array, in its order. Never throws on a bad frame. */
export function asleepItems(records) {
  if (!Array.isArray(records)) return [];
  const out = [];
  const seen = new Set();
  for (const r of records) {
    const item = asleepItem(r);
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
}

/**
 * The pinned group with its sleepers back in place: each one directly under the row it sat
 * beneath (`pinAfter`, a session name), at the top when it had nothing above it, and at the
 * bottom when the row it sat under is no longer pinned — `wakePinOrder`'s rule
 * (`server/hibernate-loop.js`), so a woken row lands where its sleeping row was drawn.
 *
 * A sleeper's anchor can itself be asleep — two pins in a row slept one after the other —
 * so placement repeats until nothing more can be anchored. Sleepers sharing one anchor go in
 * the order they slept: the first to sleep was the one sitting directly under it at the time.
 *
 * @param {Array<{tmuxSession?: string|null}>} live  pinned rows, top first
 * @param {Array<ReturnType<typeof asleepItem>>} sleepers pinned sleepers, any order
 */
export function placePinned(live, sleepers) {
  const out = Array.isArray(live) ? [...live] : [];
  const nameOf = (x) => x?.tmuxSession ?? null;
  let left = (Array.isArray(sleepers) ? sleepers : [])
    .filter(Boolean)
    .sort((a, b) => (a.sleptAt ?? 0) - (b.sleptAt ?? 0));

  // Each anchor's insertion point moves down as sleepers are put under it, so a second
  // sleeper with the same anchor goes below the first rather than above it.
  const under = new Map(); // anchor name -> how many sleepers already sit under it
  const put = (s) => {
    const key = s.pinAfter ?? '';
    const n = under.get(key) || 0;
    const at = s.pinAfter ? out.findIndex((x) => nameOf(x) === s.pinAfter) : -1;
    out.splice(at + 1 + n, 0, s);
    under.set(key, n + 1);
  };

  for (let moved = true; moved && left.length; ) {
    moved = false;
    const next = [];
    for (const s of left) {
      if (!s.pinAfter || out.some((x) => nameOf(x) === s.pinAfter)) {
        put(s);
        moved = true;
      } else next.push(s);
    }
    left = next;
  }
  // Anchored to nothing that is pinned any more: the bottom, the wake's own answer.
  out.push(...left);
  return out;
}

/**
 * A list in recency order with sleepers merged in by their stored `lastActivity`, newest
 * first — so a sleeper sits among its folder's rows where its last turn puts it, and a
 * folder holding only sleepers takes the place among folders its newest sleeper earns.
 *
 * Stable: live rows keep the roster's order exactly (it is not purely recency — blocked and
 * unread rows were already taken out above), and a sleeper goes in front of the first live
 * row older than it. A sleeper with no time goes last.
 */
export function mergeByActivity(live, sleepers) {
  const rows = Array.isArray(live) ? live : [];
  const sl = (Array.isArray(sleepers) ? sleepers : [])
    .filter(Boolean)
    .sort((a, b) => (b.lastActivity ?? -Infinity) - (a.lastActivity ?? -Infinity));
  const out = [];
  let i = 0;
  for (const s of sl) {
    const t = s.lastActivity ?? -Infinity;
    while (i < rows.length && (num(rows[i]?.lastActivity) ?? -Infinity) >= t) out.push(rows[i++]);
    out.push(s);
  }
  while (i < rows.length) out.push(rows[i++]);
  return out;
}

/**
 * What a pane showing session `selected` should do now that the roster has moved.
 *
 * - `{asleep: name}` — the session left the roster **and** a sleeper carries its id: the pane
 *   stays on it, read-only, rather than `adopt` handing it to whatever session sorts first
 *   (the "pane that was showing it lets go" trap).
 * - `null` — anything else; `adopt`'s ordinary rules apply.
 *
 * Asked only when the selected id is no longer in `sessions`.
 */
export function followIntoSleep(selected, sessions, asleep) {
  if (!selected) return null;
  if (Array.isArray(sessions) && sessions.some((s) => s?.id === selected)) return null;
  const hit = (Array.isArray(asleep) ? asleep : []).find((r) => r && r.sessionId === selected && str(r.name));
  return hit ? { asleep: str(hit.name) } : null;
}

/**
 * The live session an asleep pane should go back to, or `null` while it is still asleep.
 *
 * By conversation id first — a wake is `--resume` of the same transcript under the same id
 * (measured, v2.1.296) — and by name second, for the window before the new pane has bound
 * its transcript (a pane-only row carries a synthetic id but the right `tmuxSession`). The
 * name alone is only trusted once the record has gone: while a sleeper still holds the name,
 * a live row under it is a stranger that took it, which the wake refuses for the same reason.
 */
export function wokenSession(view, sessions, asleep) {
  const name = str(view?.name);
  const id = str(view?.sessionId);
  const rows = Array.isArray(sessions) ? sessions : [];
  if (id) {
    const byId = rows.find((s) => s?.id === id);
    if (byId) return byId;
  }
  const stillAsleep = (Array.isArray(asleep) ? asleep : []).some((r) => str(r?.name) === name);
  if (!name || stillAsleep) return null;
  return rows.find((s) => s?.tmuxSession === name) || null;
}

/**
 * The keep-awake toggle's tooltip, from `GET /api/sessions/:id/sleep`'s answer.
 *
 * Asked from the session's own header, so the answer is always "it is open in a browser"
 * unless the route is told to look past that (`?beside=watched`) — which it is, and the
 * sentence then says both halves: why it would not sleep anyway, and that it stays awake
 * while it is on screen.
 */
export function sleepTooltip(answer) {
  if (!answer || typeof answer !== 'object') return 'Keep awake: never put this session to sleep.';
  if (answer.error) return `Keep awake: never put this session to sleep. (${answer.error})`;
  if (answer.keepAwake) return 'Kept awake — hibernation never closes this session. Click to let it sleep when idle.';
  if (answer.rule === 'off') return 'Hibernation is off (settings), so nothing sleeps. Keep awake would hold this session if it is turned on.';
  const shown = answer.watched ? ' It also stays awake while a browser has it open.' : '';
  if (answer.ok) return `Would sleep at the next pass if nothing changes.${shown} Click to keep it awake.`;
  const why = str(answer.why) || 'it does not qualify';
  return `Won’t sleep yet: ${why}.${shown} Click to keep it awake regardless.`;
}

/** The number the rail's stat line prints as `asleep N`. */
export const asleepStat = (items) => (Array.isArray(items) ? items.length : 0);

/** The row's `waiting N` badge text, or `''` when nothing is held. */
export const waitingText = (n) => (Number.isInteger(n) && n > 0 ? `waiting ${n}` : '');
