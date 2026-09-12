/*
 * The forge's mark — the GitHub octicon for a GitHub repo, a plain git-graph glyph for
 * everything else — shared between the desktop's pane header (`syncForgeLink` in
 * `web/app.js`, on every session) and the phone's Leads-tab card (`web/m/app.js`), so the two surfaces draw
 * the exact same two icons instead of growing near-identical hand copies that drift apart.
 *
 * Markup strings rather than DOM nodes, on purpose: a string is testable in plain Node —
 * `test/forge-mark.test.js` asserts on it directly — the same way `web/session-colour.js`
 * and `web/quota.js` stay DOM-free so they can be. Each caller turns it into pixels with
 * one line: `el.insertAdjacentHTML('beforeend', forgeMarkupFor(reading))`.
 */

const GITHUB_PATH_D =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27s-1.36.09-2 .27c-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

/** GitHub's own mark — the `mark-github` octicon, MIT, drawn in `currentColor`. */
export function githubMarkSVG() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="${GITHUB_PATH_D}"/></svg>`;
}

/**
 * A branching graph, for every forge that is not GitHub.
 *
 * Deliberately generic and drawn here rather than fetched: shipping a third-party logo
 * means shipping its licence and its trademark policy too, and this repo is public. A git
 * graph says "this is the repository" without claiming to be anyone's brand.
 */
export function genericForgeMarkSVG() {
  return (
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M4 5.4 V10.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M12 5.4 V6.6 a2.6 2.6 0 0 1-2.6 2.6 H6.6 A2.6 2.6 0 0 0 4 11.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="4" cy="3.5" r="1.9" fill="currentColor"/>' +
    '<circle cx="4" cy="12.5" r="1.9" fill="currentColor"/>' +
    '<circle cx="12" cy="3.5" r="1.9" fill="currentColor"/>' +
    '</svg>'
  );
}

/** Which of the two marks a reading gets — the one place this decision is made. */
export function forgeMarkupFor(reading) {
  return reading === 'GitHub' ? githubMarkSVG() : genericForgeMarkSVG();
}
