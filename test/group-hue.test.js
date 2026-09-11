import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GROUP_COLOUR_COUNT, assignColour, hueVar, isGroupColour } from '../web/group-hue.js';

/*
 * The rail's group ring: the slot rule, and the one thing that holds the count in
 * JavaScript against the tokens in CSS.
 *
 * No state dir and no imports past the module itself — `web/group-hue.js` is pure, which
 * is the whole reason `server/groups.js` is allowed to import it.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('hueVar spells the custom property and nothing else', () => {
  assert.equal(hueVar(1), 'var(--group-1)');
  assert.equal(hueVar(GROUP_COLOUR_COUNT), `var(--group-${GROUP_COLOUR_COUNT})`);
});

test('a slot is a whole number inside the ring', () => {
  assert.equal(isGroupColour(1), true);
  assert.equal(isGroupColour(GROUP_COLOUR_COUNT), true);
  assert.equal(isGroupColour(0), false);
  assert.equal(isGroupColour(GROUP_COLOUR_COUNT + 1), false);
  assert.equal(isGroupColour(1.5), false);
  assert.equal(isGroupColour('2'), false, 'a number over the wire is not a number');
  assert.equal(isGroupColour(null), false);
  assert.equal(isGroupColour(undefined), false);
  assert.equal(isGroupColour(NaN), false);
});

test('the first group takes slot 1, and an empty rail is not a special case', () => {
  assert.equal(assignColour([]), 1);
  assert.equal(assignColour(), 1, 'called with nothing at all');
  assert.equal(assignColour(null), 1);
});

/* The whole of the rule: count what is taken, take the least-taken. */
test('least-used wins', () => {
  const groups = [{ colour: 1 }, { colour: 1 }, { colour: 2 }, { colour: 3 }, { colour: 3 }];
  assert.equal(assignColour(groups), 4, 'slots 4 upward are untaken');
});

test('ties break on the lowest index', () => {
  assert.equal(assignColour([{ colour: 2 }]), 1, 'slot 1 and slots 3+ are level — take 1');
  const all = Array.from({ length: GROUP_COLOUR_COUNT }, (_, i) => ({ colour: i + 1 }));
  assert.equal(assignColour(all), 1, 'a full ring is level, so it wraps to the first slot');
});

test('N groups take N different slots', () => {
  const groups = [];
  for (let i = 0; i < GROUP_COLOUR_COUNT; i += 1) groups.push({ colour: assignColour(groups) });
  const slots = groups.map((g) => g.colour);
  assert.deepEqual(slots, Array.from({ length: GROUP_COLOUR_COUNT }, (_, i) => i + 1));
  assert.equal(new Set(slots).size, GROUP_COLOUR_COUNT, 'no collision inside one ring');
});

test('the N+1th wraps to the least-used rather than colliding twice', () => {
  const groups = [];
  for (let i = 0; i < GROUP_COLOUR_COUNT + 3; i += 1) groups.push({ colour: assignColour(groups) });
  const counts = new Map();
  for (const g of groups) counts.set(g.colour, (counts.get(g.colour) ?? 0) + 1);
  assert.deepEqual(groups.slice(GROUP_COLOUR_COUNT).map((g) => g.colour), [1, 2, 3]);
  assert.equal(Math.max(...counts.values()), 2, 'nothing is tripled while a slot holds one');
});

/*
 * A record whose colour is nonsense is counted as nothing, not as itself — this is what
 * `GroupStore`'s backfill relies on when it walks a store read off disk in list order.
 */
test('a record with no usable colour is not counted as holding a slot', () => {
  assert.equal(assignColour([{ colour: null }, { colour: 'red' }, { colour: 99 }, {}]), 1);
  assert.equal(assignColour([{ colour: 1 }, { colour: 'red' }]), 2);
});

/* ------------------------------------------------------ the count vs the stylesheet --- */

/*
 * The count is spelled once in JavaScript and three times in CSS (light, the
 * `prefers-color-scheme` block, and the `data-theme="dark"` mirror), and CSS cannot import
 * anything — so this is the only mechanism that stops the two drifting. Same shape as
 * `test/logs.test.js`, which holds one exported label against a shell script and a
 * `package.json`.
 */
const TOKENS = fs.readFileSync(path.join(ROOT, 'web', 'tokens.css'), 'utf8');

/** Every `--group-N: #hex;` declaration, in source order, split into the three blocks. */
function groupBlocks(css) {
  const blocks = [];
  let current = null;
  for (const line of css.split('\n')) {
    const m = line.match(/^\s*--group-(\d+):\s*(#[0-9a-f]{6});\s*$/);
    if (m) {
      if (!current) { current = []; blocks.push(current); }
      current.push({ slot: Number(m[1]), value: m[2] });
    } else if (current && line.trim() !== '') {
      current = null;
    }
  }
  return blocks;
}

test('tokens.css defines exactly GROUP_COLOUR_COUNT slots, in three blocks, in slot order', () => {
  const blocks = groupBlocks(TOKENS);
  assert.equal(blocks.length, 3, 'light, prefers-color-scheme dark, data-theme dark');
  const want = Array.from({ length: GROUP_COLOUR_COUNT }, (_, i) => i + 1);
  for (const block of blocks) {
    assert.deepEqual(
      block.map((d) => d.slot),
      want,
      `a block defines 1..${GROUP_COLOUR_COUNT} once each — change the count and re-measure the ring`,
    );
  }
});

/* The explicit-choice block must win over the media query with the *same* values, the way
 * `--peer-N` does: two spellings of one theme is how a toggle starts disagreeing with the
 * system setting. */
test('both dark blocks carry identical values', () => {
  const [, media, explicit] = groupBlocks(TOKENS);
  assert.deepEqual(media, explicit);
});

test('the light ring is a different ring, not a copy of the dark one', () => {
  const [light, media] = groupBlocks(TOKENS);
  assert.notDeepEqual(light, media);
});

/* The ring is deliberately its own, measured for a 3px bar on `--surface`/`--shelf`, and
 * not the room's speaker ring measured as 7:1 text on `--ground`. A slot that had quietly
 * been set to a `--peer-N` value would pass every test above. */
test('no slot borrows a --peer-N value', () => {
  const peers = new Set([...TOKENS.matchAll(/--peer-\d+:\s*(#[0-9a-f]{6});/g)].map((m) => m[1]));
  for (const block of groupBlocks(TOKENS)) {
    for (const d of block) {
      assert.equal(peers.has(d.value), false, `--group-${d.slot} is ${d.value}, a peer colour`);
    }
  }
});
