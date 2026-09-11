/*
 * The glyph a link row wears — a plain chain link for an ordinary address, the forge's own
 * mark for an issue or a pull request.
 *
 * **No favicons, ever**, and the weaker of the two reasons is the panel's no-fetch rule.
 * The stronger one is that a favicon fetched by the *browser* still phones out to every
 * host the transcript mentions the moment the modal opens, which turns a local list into a
 * beacon. `web/forge-mark.js`'s header already settled the adjacent argument for logos:
 * shipping a third-party logo means shipping its licence and its trademark policy too, and
 * this repo is public.
 *
 * Markup strings rather than DOM nodes, for `forge-mark.js`'s reason verbatim: a string is
 * testable in plain Node, and `test/link-mark.test.js` asserts on it directly. Each caller
 * turns it into pixels with one line —
 * `el.insertAdjacentHTML('beforeend', linkMarkupFor(entry))`.
 *
 * Two glyphs and not three: an issue/PR link reaches `forgeMarkupFor`, which is already
 * the one place in this repo that decides between the octicon and the generic git graph.
 * A second copy of that decision here would be the `isLeadName` lesson in a smaller hat.
 */

import { forgeMarkupFor } from './forge-mark.js';

/**
 * A chain link, drawn here, in `currentColor`.
 *
 * Two rounded strokes meeting across a short bar — the shape every reader already reads as
 * "this goes somewhere else", and generic enough to belong to nobody.
 */
export function linkMarkSVG() {
  return (
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M6.6 9.4 A2.4 2.4 0 0 1 6.6 6.0 L8.9 3.7 A2.4 2.4 0 0 1 12.3 7.1 L11.2 8.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M9.4 6.6 A2.4 2.4 0 0 1 9.4 10.0 L7.1 12.3 A2.4 2.4 0 0 1 3.7 8.9 L4.8 7.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>'
  );
}

/**
 * Is this address an issue or a pull request?
 *
 * Read off the entry's **`short`**, which `server/outputs.js` already computed through
 * `prNumber` — `#540` for an issue or a PR, the bare host for everything else. Re-parsing
 * the URL here would be a second answer to a question the server has already answered, and
 * the two could disagree about a row the reader is looking at.
 */
function isIssueOrPr(entry) {
  return typeof entry?.short === 'string' && entry.short.startsWith('#');
}

/**
 * `GitHub` or not, from the address itself.
 *
 * This is deliberately *not* the panel's forge detection (`server/forge.js`, which reads
 * `git remote get-url origin`): a link in a transcript can name any forge, including one
 * this repo has no remote on. All this decides is which of `forgeMarkupFor`'s two marks a
 * row wears, and for that the host is the only honest witness. Anything that is not
 * github.com — a self-hosted Gitea, a GitLab, an unparseable string — takes the generic
 * git-graph mark, which claims nothing.
 */
function readingFor(url) {
  try {
    const host = new URL(String(url)).host.toLowerCase().replace(/^www\./, '');
    return host === 'github.com' ? 'GitHub' : 'other';
  } catch {
    return 'other';
  }
}

/** Which mark one link entry gets — the one place this decision is made. */
export function linkMarkupFor(entry) {
  if (isIssueOrPr(entry)) return forgeMarkupFor(readingFor(entry?.url));
  return linkMarkSVG();
}
