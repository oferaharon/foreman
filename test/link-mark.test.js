import assert from 'node:assert/strict';
import test from 'node:test';

import { genericForgeMarkSVG, githubMarkSVG } from '../web/forge-mark.js';
import { linkMarkSVG, linkMarkupFor } from '../web/link-mark.js';

/*
 * Markup strings, not DOM nodes, so this module is testable in plain Node the way
 * `test/forge-mark.test.js` tests its neighbour. The string is the thing worth pinning for
 * the same reason it is there: the glyph is drawn *here*, in `currentColor`, because the
 * alternative — a favicon — would have the browser phone out to every host the transcript
 * mentions the moment the files modal opens.
 */

test('linkMarkSVG is the chain-link glyph, in currentColor, aria-hidden', () => {
  const svg = linkMarkSVG();
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.match(svg, /aria-hidden="true"/);
  const strokes = (svg.match(/stroke="currentColor"/g) || []).length;
  assert.equal(strokes, 2, 'two halves of the link, one stroke each');
  assert.equal((svg.match(/fill="none"/g) || []).length, 2, 'strokes only, never filled');
});

test('the glyph fetches nothing — no img, no external reference of any kind', () => {
  const svg = linkMarkSVG();
  assert.doesNotMatch(svg, /<img/i);
  assert.doesNotMatch(svg, /<image/i);
  assert.doesNotMatch(svg, /href/i, 'an <image href> or an xlink:href would be a network fetch');
  assert.doesNotMatch(svg, /https?:/i);
});

test('an ordinary link gets the chain mark', () => {
  for (const entry of [
    { url: 'https://example.com/a/b', short: 'example.com' },
    { url: 'https://github.com/owner/repo', short: 'github.com' },
    { url: 'https://127.0.0.1:48771/', short: '127.0.0.1:48771' },
  ]) {
    assert.equal(linkMarkupFor(entry), linkMarkSVG(), entry.url);
  }
});

/*
 * An issue or a PR reads as "this is the repository", so it wears the forge's own mark —
 * and `forgeMarkupFor` is the one place that decision lives. A second copy of it here
 * would be the `isLeadName` lesson in a smaller hat.
 */
test('an issue or PR on github.com gets the octicon', () => {
  for (const url of [
    'https://github.com/owner/repo/issues/12',
    'https://github.com/owner/repo/pull/540',
    'https://www.github.com/owner/repo/pull/7',
  ]) {
    assert.equal(linkMarkupFor({ url, short: '#12' }), githubMarkSVG(), url);
  }
});

test('an issue or PR anywhere else gets the generic forge mark, never the octicon', () => {
  for (const url of [
    'https://gitea.example.net/owner/repo/pulls/3',
    'https://gitlab.com/owner/repo/merge_requests/9',
    'https://codeberg.org/owner/repo/issues/4',
  ]) {
    assert.equal(linkMarkupFor({ url, short: '#3' }), genericForgeMarkSVG(), url);
  }
});

/*
 * `short` is the witness, not a second parse of the URL. `server/outputs.js` already
 * computed it through `prNumber` — `#N` for an issue or a PR, the bare host otherwise — and
 * asking the URL again here is how the glyph and the label beside it come to disagree about
 * the row a reader is looking at.
 */
test('the issue/PR decision is read off `short`, not re-parsed from the URL', () => {
  // Issue-shaped URL, but the server declined to call it one (`…/pull/12/files` — the
  // number is not last, so `shortFor` fell back to the host). The glyph follows.
  const hostShort = { url: 'https://github.com/owner/repo/pull/12/files', short: 'github.com' };
  assert.equal(linkMarkupFor(hostShort), linkMarkSVG());
});

test('a malformed or missing entry takes the chain mark rather than throwing', () => {
  assert.equal(linkMarkupFor(undefined), linkMarkSVG());
  assert.equal(linkMarkupFor(null), linkMarkSVG());
  assert.equal(linkMarkupFor({}), linkMarkSVG());
  assert.equal(linkMarkupFor({ url: 'not a url', short: null }), linkMarkSVG());
  // `#N` with an unparseable URL still means issue/PR; the host can only decide *which*
  // forge mark, and an unreadable one is the generic mark, which claims nothing.
  assert.equal(linkMarkupFor({ url: 'not a url', short: '#9' }), genericForgeMarkSVG());
});

test('the two marks this module can return are distinct strings', () => {
  assert.notEqual(linkMarkSVG(), githubMarkSVG());
  assert.notEqual(linkMarkSVG(), genericForgeMarkSVG());
});
