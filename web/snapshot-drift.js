/*
 * The snapshot box's drift, as rows a reader can recognise.
 *
 * `snapshot.drift()` on the server answers by tmux session **name** and nothing else —
 * `{missing, extra}`, two arrays of strings — because a name is what it compares. A name
 * alone is usually enough, but two checkouts of one repo can mint near-identical ones, so
 * each row also carries the folder it belongs to when one is known:
 *
 *   - `missing` (saved, not running) is looked up in the saved entries, whose `folder` is
 *     the one a restore would launch into;
 *   - `extra` (running, not saved) is looked up in the live roster, by `paneCwd` first —
 *     the same field `benchEntries` saves, so the folder shown is the folder a save would
 *     record — and the transcript's `cwd` only when the pane has none.
 *
 * A name found in neither still gets its row, with `folder: null`: the server said it
 * drifted, and leaving it out would make the list disagree with the count above it.
 *
 * `snapshotPrimary` below reads the same answer for one more thing: which of the box's two
 * bench buttons is the primary one.
 *
 * DOM-free, the way `web/files-new.js` and `web/group-summary.js` are, so
 * `test/snapshot-drift.test.js` runs it in plain Node.
 */

const byName = (rows, folderOf) => {
  const out = new Map();
  for (const r of rows || []) {
    if (r && r.tmuxSession && !out.has(r.tmuxSession)) out.set(r.tmuxSession, folderOf(r) || null);
  }
  return out;
};

/**
 * @param {{missing?: string[], extra?: string[]}} drift  what the server sent
 * @param {{saved?: Array<{tmuxSession?: string, folder?: string}>,
 *          live?: Array<{tmuxSession?: string, paneCwd?: string, cwd?: string}>}} sources
 * @returns {{extra: Array<{name: string, folder: string|null}>,
 *            missing: Array<{name: string, folder: string|null}>}}
 */
export function driftRows(drift, { saved = [], live = [] } = {}) {
  const savedFolder = byName(saved, (e) => e.folder);
  const liveFolder = byName(live, (s) => s.paneCwd || s.cwd);
  const rows = (names, folders) =>
    (Array.isArray(names) ? names : [])
      .filter((n) => typeof n === 'string' && n)
      .map((name) => ({ name, folder: folders.get(name) ?? null }));
  return {
    extra: rows(drift?.extra, liveFolder),
    missing: rows(drift?.missing, savedFolder),
  };
}

/**
 * Which of the summary view's two bench buttons is the primary one, if either.
 *
 * The box is opened for one of two reasons and the emphasis follows whichever the facts
 * point at; most of the time they point at neither, and then nothing is primary — an
 * outlined button on a box that wants nothing done is a nudge towards pressing it.
 *
 *   - `restore` when there is something saved to put back **and** either nothing is
 *     running or some saved session isn't. It wins over `save` whenever both hold, and
 *     that order is the point: after a reboot the bench is empty, which is drift, and a
 *     `save now` pressed then would replace the only record of the bench with an empty one.
 *   - `save` when nothing has been saved yet, or what is running has drifted from the save
 *     (in practice, sessions running that the save doesn't have — a missing one has
 *     already gone to `restore`).
 *
 * `live` is every tmux name the roster holds, `GET /api/snapshot`'s own field; `drift` is
 * `snapshot.drift()`'s `{missing, extra}`, which already leaves workers out.
 *
 * @param {{savedAt?: number|null, sessions?: unknown[], live?: string[],
 *          drift?: {missing?: string[], extra?: string[]}}} snap
 * @returns {'save'|'restore'|null}
 */
export function snapshotPrimary(snap) {
  const saved = Array.isArray(snap?.sessions) ? snap.sessions.length : 0;
  const running = Array.isArray(snap?.live) ? snap.live.length : 0;
  const missing = Array.isArray(snap?.drift?.missing) ? snap.drift.missing.length : 0;
  const extra = Array.isArray(snap?.drift?.extra) ? snap.drift.extra.length : 0;
  if (saved && (!running || missing)) return 'restore';
  if (!snap?.savedAt || missing || extra) return 'save';
  return null;
}
