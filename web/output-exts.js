/*
 * Which extensions count as something a session made *for a human* — one list, two
 * readers.
 *
 * `server/outputs.js` is the authority on what the files modal lists: a `Write` whose
 * result says `type: 'create'` lists only if its path carries one of these. The files
 * button's new-item dot (`web/files-new.js`) has to answer the same question about the
 * same path, live, off a message frame — so the list has to be reachable from the browser
 * too, and `web/` cannot import `server/`.
 *
 * Hence this module, and hence the direction of the import: **`server/outputs.js` imports
 * it from here**, the way `server/` already imports `web/trust-gate.js` and for the same
 * reason — the thing both sides must agree about lives in the one place both sides can
 * reach, rather than being spelled twice and held together by a comment. Two spellings of
 * one naming contract is the `isLeadName` lesson, and this repo has paid it enough times.
 *
 * What is deliberately **not** here: `server/outputs.js`'s `MEDIA` table. That one builds
 * `Content-Type` headers and exists to decide what the byte route will serve; the browser
 * has no business in it, and a module carrying both would invite a client that picked a
 * media type.
 */

/**
 * The fixed human-facing set — the whole of the `Write` filter, and nothing else decides
 * it.
 *
 * Extension rather than location, for `server/outputs.js`'s reason verbatim: a rule about
 * where a file lives rots (the state dir resolves on four rungs; `main` was hardcoded in
 * four places), while an extension is a fact about the file. `.js`, `.json`, `.py`,
 * `.tsx`, `.swift`, `.sh` — source, which the 2026-09-10 ruling says is "not interesting"
 * — are excluded by one short list with no cleverness in it.
 *
 * `SendUserFile` is **not** filtered by this, on either side. Its whole purpose is handing
 * a file to the maintainer, so the tool's own word is the witness and a `.wav` lists.
 */
export const CREATE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.pdf', '.rtf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
]);

/**
 * A path's lowercased extension, including the dot — `node:path.extname` without
 * `node:path`, because this file is loaded by a browser.
 *
 * It is held against the real thing rather than assumed equal to it: the **list** is what
 * the two sides must agree about, and an extractor that disagreed on an edge would undo
 * that agreement one step later. `test/files-new.test.js` runs both over a table of the
 * cases that actually differ between plausible implementations — a dotfile (`.bashrc` has
 * no extension), a dot in a directory name, a trailing dot, no dot at all — and asserts
 * they answer the same. The server keeps `path.extname`, which is the right tool where it
 * is available; nothing here asks it to change.
 */
export function extOf(p) {
  const s = String(p || '');
  const base = s.slice(s.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // `<= 0` and not `=== -1`: a leading dot is a dotfile, not an extension, which is
  // `path.extname`'s own reading of `.bashrc`.
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Is this a path the files modal would list a `Write` of? */
export function isHumanFacingPath(p) {
  return CREATE_EXTS.has(extOf(p));
}
