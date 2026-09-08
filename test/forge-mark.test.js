import assert from 'node:assert/strict';
import test from 'node:test';

import { forgeMarkupFor, genericForgeMarkSVG, githubMarkSVG } from '../web/forge-mark.js';

/*
 * Markup strings, not DOM nodes, so this module is testable in plain Node the way
 * `web/session-colour.js` and `web/quota.js` are — the desktop's lead header and the
 * phone's Leads-tab card each turn one of these into pixels with one `insertAdjacentHTML`
 * call, but the string itself is the thing worth pinning: both surfaces must draw the
 * *same* mark, and a future edit to one glyph must not silently leave the other behind.
 */

test('githubMarkSVG is the octicon, in currentColor, aria-hidden', () => {
  const svg = githubMarkSVG();
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /fill="currentColor"/);
  assert.match(svg, /<path /);
});

test('genericForgeMarkSVG is the git-graph glyph — two strokes, three nodes, no fill on the strokes', () => {
  const svg = genericForgeMarkSVG();
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.match(svg, /aria-hidden="true"/);
  const strokeCount = (svg.match(/stroke="currentColor"/g) || []).length;
  const circleCount = (svg.match(/<circle/g) || []).length;
  assert.equal(strokeCount, 2, 'the trunk and the branch, one stroke each');
  assert.equal(circleCount, 3, 'three commit nodes');
});

test('forgeMarkupFor picks the octicon for GitHub and the generic mark for everything else', () => {
  assert.equal(forgeMarkupFor('GitHub'), githubMarkSVG());
  for (const reading of ['Gitea', 'push only', 'no remote', 'anything else']) {
    assert.equal(forgeMarkupFor(reading), genericForgeMarkSVG(), reading);
  }
});

test('the two marks are distinct strings', () => {
  assert.notEqual(githubMarkSVG(), genericForgeMarkSVG());
});
