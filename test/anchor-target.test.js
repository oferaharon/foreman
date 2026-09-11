import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

import { withBlankTargets } from '../web/anchor-target.js';

/*
 * `marked` (`gfm: true`) autolinks a bare URL and a bare `www.` host with no `target` and
 * no `rel` — see `web/anchor-target.js`'s own header — so this drives the real vendored
 * parser (this package is what `server/index.js` serves at `/vendor/marked.js`) rather
 * than hand-typing HTML, the same reasoning `test/forge-mark.test.js` gives for testing
 * markup strings in plain node.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

marked.setOptions({ gfm: true, breaks: true });

function hrefsIn(html) {
  return [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
}

test('a bare URL, a markdown link and a bare www. autolink all get both attributes', () => {
  const input =
    'See https://example.com/a/b and [a cited page](https://example.com/x) and www.example.org and plain text.';
  const html = withBlankTargets(marked.parse(input));
  const anchors = hrefsIn(html);
  assert.equal(anchors.length, 3, 'all three anchor shapes survived the parse');
  for (const tag of anchors) {
    assert.match(tag, /\shref="/, 'still points somewhere');
    assert.match(tag, /\starget="_blank"/, tag);
    assert.match(tag, /\srel="noopener noreferrer"/, tag);
  }
});

test('an anchor with no href is untouched', () => {
  const html = '<p>before <a name="x">anchor</a> after</p>';
  assert.equal(withBlankTargets(html), html);
});

test('an anchor that already sets its own target is left alone', () => {
  // The panel's hand-built anchors (`forgeLink`, the PR chips) already set `target`
  // themselves — this is what keeps the helper from doubling up if it is ever run over
  // text containing one, and makes a second pass over already-processed HTML a no-op.
  const html = '<a href="https://example.com" target="_self">already set</a>';
  assert.equal(withBlankTargets(html), html);
});

test('falsy input is a no-op, not a throw', () => {
  assert.equal(withBlankTargets(''), '');
  assert.equal(withBlankTargets(null), null);
  assert.equal(withBlankTargets(undefined), undefined);
});

test('plain text with no anchors at all passes through unchanged', () => {
  const html = marked.parse('nothing but prose here, no links');
  assert.equal(withBlankTargets(html), html);
});

test('a self-closing anchor tag is closed correctly', () => {
  const html = '<a href="https://example.com"/>';
  assert.equal(withBlankTargets(html), '<a href="https://example.com" target="_blank" rel="noopener noreferrer"/>');
});

test('other tags in the same string are left alone', () => {
  const html = '<p>hi <b>there</b></p> <a href="https://example.com">link</a>';
  const out = withBlankTargets(html);
  assert.match(out, /<p>hi <b>there<\/b><\/p>/);
  assert.match(out, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">link<\/a>/);
});

/*
 * Every `marked.parse` in this repo has to route through the helper, or the bug just moves
 * to whichever call site was missed — the plan's own words. A source scan rather than a
 * behavioural test here, the same shape `test/rooms-band.test.js` and `test/brief.test.js`
 * use for "this exact call shape must appear", because the alternative is driving five
 * different render paths through a fake DOM for one line of coverage each.
 */

const APP_SRC = text('web/app.js');
const LEAD_SRC = text('web/m/lead.js');
const TASKS_SRC = text('web/m/tasks.js');
const CARDS_SRC = text('web/m/cards.js');

function parseCalls(src) {
  return [...src.matchAll(/marked\.parse\(/g)].length;
}

function wrappedCalls(src) {
  return [...src.matchAll(/withBlankTargets\(marked\.parse\(/g)].length;
}

for (const [name, src] of [
  ['web/app.js', APP_SRC],
  ['web/m/lead.js', LEAD_SRC],
  ['web/m/tasks.js', TASKS_SRC],
  ['web/m/cards.js', CARDS_SRC],
]) {
  test(`every marked.parse(...) in ${name} is wrapped in withBlankTargets(...)`, () => {
    const calls = parseCalls(src);
    assert.ok(calls > 0, `${name} should still call marked.parse at least once`);
    assert.equal(wrappedCalls(src), calls, `${name} has an unwrapped marked.parse call`);
  });
}

test('every file that calls marked.parse imports withBlankTargets from anchor-target.js', () => {
  for (const [name, src] of [
    ['web/app.js', APP_SRC],
    ['web/m/lead.js', LEAD_SRC],
    ['web/m/tasks.js', TASKS_SRC],
    ['web/m/cards.js', CARDS_SRC],
  ]) {
    assert.match(src, /import\s*\{\s*withBlankTargets\s*\}\s*from\s*['"].*anchor-target\.js['"]/, name);
  }
});
