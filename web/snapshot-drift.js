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
