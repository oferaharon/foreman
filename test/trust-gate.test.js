import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePane } from '../server/tmux.js';
import { isTrustGate, trustPath, gateSentences, buildTrustNotice } from '../web/trust-gate.js';

/*
 * The folder-trust gate, and the fact that nothing in the panel offers to answer it.
 *
 * `test/pane.test.js` pins what the *parser* sees on that screen — an ordinary,
 * fully-populated permission box, `dialog: null`, option 1 `Yes, I trust this folder`
 * classed `approve`. This file pins what is done with it: recognised, and given a card
 * with nothing to press.
 *
 * The bug these tests exist for shipped and ran for a while. `buildDecisionBar` in
 * `web/app.js` had no trust-gate case at all, so a rail row sitting on the gate drew a
 * full-width, unarmed, one-tap **"Yes, I trust this folder"** button — one click, from any
 * browser that can reach the panel (which by the 2026-08-27 ruling is anything on the LAN),
 * granting Claude Code read, edit and execute in a folder nobody vetted.
 *
 * Note what could not be used as the guard, because it is the whole reason the witness is
 * a witness and not a field test: the gate has **no `dialog`**, so "a picker we won't
 * touch" misses it, and it **has a prompt**, so "a box we could not read" misses it too.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const WIDTHS = [
  ['220 columns', 'pane-trust-gate.txt'],
  ['70 columns', 'pane-trust-gate-narrow.txt'],
];

/* ─────────────────────────────────────────────────────────────── the witness ─── */

for (const [width, file] of WIDTHS) {
  test(`the gate is recognised from what the parser actually returns (${width})`, () => {
    const { prompt } = parsePane(fixture(file));
    assert.ok(prompt, 'the premise: there is a prompt, which is why the gate needs a witness');
    assert.equal(isTrustGate(prompt), true);
  });
}

test('every other box the panel can parse is not the trust gate', () => {
  // Swept across every committed capture rather than a chosen few: a witness that also
  // fires on a permission prompt would silently stop the panel answering the prompts it
  // is *for*, and that failure is quiet in a way the original bug was not.
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'))) {
    const expected = file.startsWith('pane-trust-gate');
    const { prompt } = parsePane(fixture(file));
    assert.equal(isTrustGate(prompt), expected, file);
  }
});

test('the witness declines an absent prompt rather than throwing', () => {
  for (const p of [null, undefined, {}, { options: [] }, { detail: [] }]) {
    assert.equal(isTrustGate(p), false);
  }
});

test('a gate that loses its option label is still refused', () => {
  // The label is the first test and the fastest, but a wording change that keeps the
  // screen and renames the row must not turn the button back on. The screen's own two
  // sentences are the fallback, and `Do you trust` is the pre-v2.1.247 spelling.
  const { prompt } = parsePane(fixture('pane-trust-gate.txt'));
  const renamed = { ...prompt, options: [{ index: 1, label: 'Yes, proceed' }, { index: 2, label: 'No, exit' }] };
  assert.equal(isTrustGate(renamed), true);

  assert.equal(
    isTrustGate({ title: 'Accessing workspace:', detail: ['Do you trust the files in this folder?'] }),
    true,
    'the older wording',
  );
});

/* ──────────────────────────────────────────────────────────────── the copy ─── */

test('the workspace path is reassembled whole at both widths', () => {
  // At 70 columns `readOptionBlock` takes a *truncated* path as `subject` and leaves the
  // rest at the front of `detail`. A path cut mid-word is worse than no path when the
  // whole question is which folder this is.
  const wide = trustPath(parsePane(fixture('pane-trust-gate.txt')).prompt);
  const narrow = trustPath(parsePane(fixture('pane-trust-gate-narrow.txt')).prompt);
  assert.equal(narrow, wide);
  assert.ok(wide.endsWith('/trust-gate-fresh-5588'), wide);
});

test('the safety-check sentence keeps the half that tells you how to decide', () => {
  for (const [width, file] of WIDTHS) {
    const said = gateSentences(parsePane(fixture(file)).prompt).join(' ');
    assert.match(said, /Quick safety check: Is this a project you created or one you trust\?/, width);
    // The tail a line-filtering first draft dropped at 70 columns — where the paragraph
    // wraps over four lines and only the first one matches the phrase.
    assert.match(said, /work from your team\)\. If not, take a moment to review/, width);
    assert.match(said, /read, edit, and execute files here/, width);
    assert.doesNotMatch(said, /Security guide/, width);
  }
});

/* ───────────────────────────────────────────────── the card, and its silence ─── */

/**
 * Just enough DOM for `buildTrustNotice`, and deliberately no more.
 *
 * The point is not to simulate a browser — it is to *record* everything the builder does
 * to a node, so `controls()` below can walk the result and fail on anything that could be
 * clicked. Every mutation the builder is allowed to make is here; anything it grows later
 * that this stub does not model will throw rather than pass quietly.
 */
function withDom(fn) {
  const real = globalThis.document;
  const nodes = [];
  globalThis.document = {
    createElement(tag) {
      const node = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        children: [],
        listeners: [],
        classList: { add: (...c) => (node.className = `${node.className} ${c.join(' ')}`.trim()) },
        append: (...kids) => node.children.push(...kids),
        addEventListener: (type) => node.listeners.push(type),
      };
      nodes.push(node);
      return node;
    },
  };
  try {
    return { node: fn(), nodes };
  } finally {
    globalThis.document = real;
  }
}

/** Every node in the tree, depth first. */
function walk(node, out = []) {
  out.push(node);
  for (const kid of node.children || []) walk(kid, out);
  return out;
}

/** Anything a person could press, by any spelling. */
function controls(node) {
  const CLICKABLE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL', 'OPTION']);
  return walk(node).filter(
    (n) =>
      CLICKABLE.has(n.tagName) ||
      n.listeners.length > 0 ||
      Object.keys(n).some((k) => /^on[a-z]/.test(k)) ||
      'href' in n ||
      'tabIndex' in n ||
      'contentEditable' in n ||
      n.className.split(/\s+/).some((c) => /(^|-)(opt|btn|button)$/.test(c) && c !== 'perm-gate-opt'),
  );
}

test('the pressable-node detector is not blind', () => {
  // A test that passes because its detector never fires is worse than no test. This builds
  // the row `buildDecisionBar` used to draw for this box — the permission card's own option
  // button — and asserts the walk above catches it.
  const { node } = withDom(() => {
    const card = document.createElement('div');
    card.className = 'perm';
    const b = document.createElement('button');
    b.className = 'perm-opt approve';
    b.textContent = 'Yes, I trust this folder';
    b.onclick = () => {};
    card.append(b);
    return card;
  });
  assert.equal(controls(node).length, 1);
});

for (const [width, file] of WIDTHS) {
  test(`the decision bar's trust card renders no answering control (${width})`, () => {
    const { prompt } = parsePane(fixture(file));
    const { node } = withDom(() => buildTrustNotice(prompt));

    const pressable = controls(node).map((n) => `${n.tagName}.${n.className}`);
    assert.deepEqual(pressable, [], `nothing here may be pressable, found: ${pressable.join(', ')}`);

    // And specifically not the permission card's own option row, which is what the box
    // would have got with no case for it at all.
    assert.equal(
      walk(node).filter((n) => n.className.split(/\s+/).includes('perm-opt')).length,
      0,
    );
  });

  test(`the trust card still says what the Mac is showing (${width})`, () => {
    // The other half of the rule. Refusing to answer is not refusing to *tell you* — the
    // whole value of the card is that you learn which folder, and what the two rows are,
    // without walking to the terminal to find out whether it is worth walking to the
    // terminal.
    const { prompt } = parsePane(fixture(file));
    const { node } = withDom(() => buildTrustNotice(prompt));
    const text = walk(node)
      .map((n) => n.textContent)
      .join('\n');

    assert.match(text, /folder-trust gate/);
    assert.match(text, /Accessing workspace:/);
    assert.match(text, /trust-gate-fresh-5588/, 'the folder, whole');
    assert.match(text, /1\. Yes, I trust this folder/, 'as text, not as a row you can press');
    assert.match(text, /2\. No, exit/);
    assert.match(text, /answered at the Mac, in the terminal/);
  });
}

/* ─────────────────────────────────────────────────────── the two front ends ─── */

test('the desktop composer refuses the gate before it can reach the permission path', () => {
  // `buildDecisionBar` cannot be imported — it is a closure inside `createPane`, and
  // `web/app.js` imports `/vendor/marked.js` by an absolute browser URL. So the ordering
  // is pinned at the source, which is the thing that actually regressed: the branch has to
  // come before the option loop, not merely exist somewhere in the function.
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('function buildDecisionBar('));
  const guard = body.indexOf('isTrustGate(');
  const buttons = body.indexOf("createElement('button')");
  assert.ok(guard > -1, 'buildDecisionBar has no trust-gate case');
  assert.ok(buttons > -1, 'the option loop moved — re-read this test before adjusting it');
  assert.ok(guard < buttons, 'the refusal must precede anything that builds an option button');
});

test('the answer endpoint refuses the gate too, not just the card', () => {
  // A client-only guard makes "the panel never answers a security gate" a habit of the
  // front end. Every other guard on this path is written the other way round — the
  // endpoint re-reads the pane and checks, rather than trusting whoever called it — and
  // the panel is reachable, unauthenticated, from the LAN by standing ruling.
  const index = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const handler = index.slice(index.indexOf("app.post('/api/sessions/:id/answer'"));
  const guard = handler.indexOf('isTrustGate(prompt)');
  const send = handler.indexOf('keyForOption(');
  assert.ok(guard > -1, 'the answer endpoint has no trust-gate refusal');
  assert.ok(guard < send, 'it must refuse before an option key is ever computed');
});
