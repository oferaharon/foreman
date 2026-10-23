import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TAG_MEANINGS, WHAT_TAGS, parseTags, readTags, tagVar, whatTag } from '../web/task-tags.js';

/*
 * A team task's tag: the list, the strict parser every write goes through, the tolerant
 * reader every read goes through, and the one-spelling wall around the four words.
 *
 * No state dir and no imports past the module itself — `web/task-tags.js` is a leaf, which
 * is the whole reason `server/` and the lead's stdio tool server may import it.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* -------------------------------------------------------------- the list --- */

test('four tags, in the ruling’s order, frozen', () => {
  assert.deepEqual([...WHAT_TAGS], ['bug', 'feature', 'research', 'chore']);
  assert.ok(Object.isFrozen(WHAT_TAGS));
  assert.throws(() => WHAT_TAGS.push('idea'), TypeError);
});

test('every tag has a meaning, and nothing else does', () => {
  assert.deepEqual(Object.keys(TAG_MEANINGS), [...WHAT_TAGS]);
  for (const tag of WHAT_TAGS) {
    assert.equal(typeof TAG_MEANINGS[tag], 'string', tag);
    assert.ok(TAG_MEANINGS[tag].trim(), `${tag} has an empty meaning`);
  }
  // Worded as the ruling worded them — the lead's brief and the menu both read these.
  assert.equal(TAG_MEANINGS.research, 'investigate only, no code');
  assert.ok(Object.isFrozen(TAG_MEANINGS));
});

test('tagVar spells the custom property and nothing else', () => {
  assert.equal(tagVar('bug'), 'var(--tag-bug)');
  assert.equal(tagVar('chore'), 'var(--tag-chore)');
});

/* ----------------------------------------------------- the strict parser --- */

test('parseTags accepts exactly one word from the list, as a fresh array', () => {
  for (const tag of WHAT_TAGS) {
    const input = [tag];
    const out = parseTags(input);
    assert.deepEqual(out, { tags: [tag] });
    assert.notEqual(out.tags, input, 'a copy — the caller’s array is never stored');
  }
});

test('parseTags refuses empty, two, unknown and not-a-list — and names the four words', () => {
  const refusals = [
    [[], /exactly one tag.*named 0/],
    [['bug', 'feature'], /exactly one tag.*named 2/],
    [['bug', 'bug'], /exactly one tag.*named 2/],
    [['blocked'], /No such tag: "blocked"/],
    [['Bug'], /No such tag: "Bug"/, 'strict about case'],
    [[' bug'], /No such tag: " bug"/, 'and about whitespace'],
    [['bug', 'nonsense'], /No such tag: "nonsense"/, 'an unknown word is named even beside a good one'],
    [[1], /No such tag: 1/],
    ['bug', /a list holding exactly one/, 'a bare string is not a list'],
    [undefined, /a list holding exactly one/],
    [null, /a list holding exactly one/],
    [{ 0: 'bug', length: 1 }, /a list holding exactly one/, 'array-like is not an array'],
  ];
  for (const [input, re, why] of refusals) {
    const out = parseTags(input);
    assert.ok(out.error, `${JSON.stringify(input)} should be refused${why ? ` — ${why}` : ''}`);
    assert.equal(out.tags, undefined);
    assert.match(out.error, re, JSON.stringify(input));
    assert.match(out.error, /bug, feature, research or chore/, `the refusal names the list: ${out.error}`);
  }
});

/* --------------------------------------------------- the tolerant reader --- */

test('readTags turns anything stored into words this build knows', () => {
  assert.deepEqual(readTags(['feature']), ['feature']);
  for (const junk of [undefined, null, 'bug', 7, {}, { 0: 'bug', length: 1 }]) {
    assert.deepEqual(readTags(junk), [], JSON.stringify(junk));
  }
  assert.deepEqual(readTags([]), []);
  assert.deepEqual(readTags(['nonsense']), [], 'kept by the store, dropped by the reader');
  assert.deepEqual(readTags(['bug', 'bug']), ['bug'], 'a repeat is one tag');
  assert.deepEqual(readTags([null, 3, 'chore']), ['chore']);
});

test('whatTag is the one what-tag, or null', () => {
  assert.equal(whatTag(['research']), 'research');
  assert.equal(whatTag([]), null);
  assert.equal(whatTag(undefined), null, 'a record from before tags');
  assert.equal(whatTag('bug'), null, 'a stored string is not a stored list');
  assert.equal(whatTag(['nonsense']), null);
});

test('a record carrying a word from a later build still reads as its what-tag', () => {
  // The forward-compatibility case: a "why it's waiting" group may join the same array one
  // day. A build that does not know those words must show the what-tag and nothing else —
  // never refuse the record, never draw the stranger.
  const later = ['blocked', 'bug', 'deadline'];
  assert.deepEqual(readTags(later), ['bug']);
  assert.equal(whatTag(later), 'bug');
});

/* ----------------------------------------------------- the one spelling --- */

/** Every script this repo ships, outside `node_modules` and the tests. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(rel);
      } else if (/\.(m?js)$/.test(e.name)) {
        out.push(rel);
      }
    }
  };
  for (const dir of ['server', 'mcp', 'web', 'bin', 'helper', 'scripts']) {
    if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  }
  return out;
}

test('the four words are spelled in one file: no other script quotes one', () => {
  // `docs/traps/one-spelling.md`: two spellings of one contract agree the day they are
  // written and diverge afterwards. A reader that needs the list imports it — the way
  // `test/model-names.test.js` holds the display-only model names to one file.
  const files = sourceFiles();
  assert.ok(files.includes(path.join('web', 'task-tags.js')), 'the walk reaches the leaf');
  assert.ok(files.length > 50, `the walk found only ${files.length} files`);
  const quoted = new RegExp(`(['"])(${WHAT_TAGS.join('|')})\\1`);
  for (const file of files) {
    if (file === path.join('web', 'task-tags.js')) continue;
    const hit = text(file).match(quoted);
    assert.equal(hit, null, `${file} spells ${hit?.[0]} itself — import it from web/task-tags.js`);
  }
});

test('the store and the routes import the leaf, and the leaf imports nothing', () => {
  // The readers item 1 adds, then the lead's tool server and its brief (item 2). The two
  // task lists join this list as they start reading tags.
  for (const file of ['server/tasks.js', 'server/index.js', 'mcp/foreman.js', 'server/lead-brief.js']) {
    assert.match(text(file), /from '\.\.\/web\/task-tags\.js';/, file);
  }
  assert.doesNotMatch(text('web/task-tags.js'), /^\s*import\s/m, 'a leaf, so a stdio child can load it');
});

test('the two task lists read the leaf too — the desktop row and the phone row', () => {
  // Item 3's readers, at their own relative paths. Both also import the pill and the menu
  // from `web/task-tag-chip.js`, which reads the same leaf; neither may hold a copy.
  assert.match(text('web/app.js'), /from '\.\/task-tags\.js';/, 'web/app.js');
  assert.match(text('web/m/tasks.js'), /from '\.\.\/task-tags\.js';/, 'web/m/tasks.js');
  assert.match(text('web/task-tag-chip.js'), /from '\.\/task-tags\.js';/, 'web/task-tag-chip.js');
});

/* ----------------------------------------------------------- the tokens --- */

/**
 * Every `--tag-<word>: #hex;` declaration in `web/tokens.css`, split into the runs it
 * appears in — `test/group-hue.test.js`'s reader, for the same three blocks.
 */
function tagBlocks(css) {
  const blocks = [];
  let current = null;
  for (const line of css.split('\n')) {
    const m = line.match(/^\s*--tag-([a-z]+):\s*(#[0-9a-f]{6});\s*$/);
    if (m) {
      if (!current) {
        current = [];
        blocks.push(current);
      }
      current.push({ tag: m[1], value: m[2] });
    } else if (current && line.trim() !== '') {
      current = null;
    }
  }
  return blocks;
}

test('every tag has a --tag-<word> colour in each of tokens.css’s three blocks', () => {
  // Light `:root`, the dark `prefers-color-scheme` block, and `:root[data-theme="dark"]`.
  // A token missing from any one of them draws that tag with no colour in that mode, and
  // nothing fails — the rule falls back and the pill goes grey.
  const css = text('web/tokens.css');
  const blocks = tagBlocks(css);
  assert.equal(blocks.length, 3, 'light, prefers-color-scheme dark, data-theme dark');
  for (const block of blocks) {
    assert.deepEqual(block.map((d) => d.tag), [...WHAT_TAGS], 'one token per tag, in the leaf’s order');
  }
  // The explicit-choice block mirrors the media query exactly, as every other token does.
  assert.deepEqual(blocks[1], blocks[2]);
  // And each one is the name `tagVar` resolves through — the one spelling of the token.
  for (const tag of WHAT_TAGS) {
    assert.equal(tagVar(tag), `var(--tag-${tag})`);
    assert.equal(css.split(`--tag-${tag}:`).length - 1, 3, `--tag-${tag} is declared three times`);
  }
});

test('the four colours are four, and none of them is a state colour', () => {
  // A tag must never read as a state, and two tags must never read as one.
  const css = text('web/tokens.css');
  const [light, dark] = tagBlocks(css);
  for (const block of [light, dark]) {
    assert.equal(new Set(block.map((d) => d.value)).size, WHAT_TAGS.length, 'four distinct values');
  }
  const stateValues = new Set(
    [...css.matchAll(/--(?:decision|working|idle|accent):\s*(#[0-9a-f]{6});/g)].map((m) => m[1]),
  );
  for (const d of [...light, ...dark]) {
    assert.equal(stateValues.has(d.value), false, `--tag-${d.tag} is ${d.value}, a state colour`);
  }
});
