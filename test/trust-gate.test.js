import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePane } from '../server/tmux.js';
import {
  isTrustGate,
  parseTrustGate,
  trustOption,
  trustPath,
  gateSentences,
  buildTrustCard,
} from '../web/trust-gate.js';

/*
 * The folder-trust gate: how it is read, and — since the 2026-09-19 ruling — how it is
 * answered.
 *
 * `test/pane.test.js` pins what the *parser* sees on that screen, on both the v2.1.247 and
 * the v2.1.257 layouts. This file pins what is done with it.
 *
 * **This file used to assert the opposite of what it now asserts, and the history is the
 * point.** The panel refused this box outright: the card had no button, the phone had no
 * button, and `POST /api/sessions/:id/answer` returned 409 for it so the refusal was a
 * property of the panel rather than a habit of its front end. Before *that*,
 * `buildDecisionBar` had no trust-gate case at all and a rail row sitting on the gate drew a
 * full-width, unarmed, one-tap **"Yes, I trust this folder"** — one click, from any browser
 * that can reach the panel, which by the 2026-08-27 ruling is anything on the LAN, granting
 * Claude Code read, edit and execute in a folder nobody vetted.
 *
 * The maintainer reversed the refusal on 2026-09-19 with that exposure put to him plainly:
 * Foreman must not force a user to open a terminal. So the gate is answerable again — but
 * never as an unremarkable row in a permission bar. What these tests hold is the difference:
 * the card transcribes the folder and the grant, the Yes asks twice, and the answer is a
 * cursor walk that confirms the pane's own `❯` before it presses Enter, because on this
 * screen there is no digit and a blind Enter kills the session.
 *
 * The half of that which needs a real pane — the endpoint, the cursor walk, and
 * `answerTrustGate` — is `test/trust-gate-api.test.js`, split out for the reason
 * `test/rooms-api.test.js` is: that file must set `TMUX_TMPDIR` *before* `server/tmux.js`
 * is evaluated, and a static import in the same file is hoisted above every statement that
 * could set it. The same hoist is what points a test at the machine's real state dir.
 *
 * Note what could not be used as the guard, because it is why the witness is a witness and
 * not a field test: the gate has **no `dialog`**, so "a picker we won't touch" misses it, and
 * it **has a prompt**, so "a box we could not read" misses it too.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** The live layout first, then the one an older Claude Code on this Mac would still draw. */
const WIDTHS = [
  ['v2.1.257, 220 columns', 'pane-trust-gate.txt'],
  ['v2.1.257, 70 columns', 'pane-trust-gate-narrow.txt'],
  ['v2.1.247, 220 columns', 'pane-trust-gate-2.1.247.txt'],
  ['v2.1.247, 70 columns', 'pane-trust-gate-2.1.247-narrow.txt'],
];

/* ─────────────────────────────────────────────────────────────── the witness ─── */

for (const [width, file] of WIDTHS) {
  test(`the gate is recognised from what the parser actually returns (${width})`, () => {
    const { prompt } = parsePane(fixture(file));
    assert.ok(prompt, 'the premise: there is a prompt, which is why the gate needs a witness');
    assert.equal(isTrustGate(prompt), true);
    assert.equal(trustOption(prompt)?.label, 'Yes, I trust this folder');
  });
}

test('every other box the panel can parse is not the trust gate', () => {
  // Swept across every committed capture rather than a chosen few: a witness that also
  // fired on a permission prompt would route an ordinary box to the cursor walk, which
  // sends arrow keys into a screen that answers digits.
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

test('a gate that loses its option label is still recognised', () => {
  // The label is the first test and the fastest, but a wording change that keeps the
  // screen and renames the row must not turn it into an ordinary permission box. The
  // screen's own two sentences are the fallback, and `Do you trust` is the pre-v2.1.247
  // spelling.
  const { prompt } = parsePane(fixture('pane-trust-gate.txt'));
  const renamed = { ...prompt, options: [{ index: 1, label: 'No, exit' }, { index: 2, label: 'Yes, proceed' }] };
  assert.equal(isTrustGate(renamed), true);
  assert.equal(trustOption(renamed), null, 'recognised, but no row we know how to press');

  assert.equal(
    isTrustGate({ title: 'Accessing workspace:', detail: ['Do you trust the files in this folder?'] }),
    true,
    'the older wording',
  );
});

/* ──────────────────────────────────────────────── reading the unnumbered box ─── */

/*
 * `parseTrustGate` is the half of this that the 2.1.257 regression is about. It must read
 * the unnumbered layout and it must refuse everything else, because `OPTION_RE` in
 * `server/permission.js` stays strict: the five screen parsers refuse each other's boxes by
 * exactly that strictness, and teaching the shared regex to match a bare label would teach
 * every screen in the panel to read a sentence as an option.
 */

for (const [width, file] of [WIDTHS[0], WIDTHS[1]]) {
  test(`the unnumbered gate is read off the raw pane (${width})`, () => {
    const p = parseTrustGate(fixture(file));
    assert.ok(p, 'this is the layout `parsePrompt` cannot read at all');
    assert.equal(p.title, 'Accessing workspace:');
    assert.deepEqual(
      p.options,
      [
        { index: 1, label: 'No, exit', kind: 'deny', selected: true },
        { index: 2, label: 'Yes, I trust this folder', kind: 'approve', selected: false },
      ],
      'screen order, and the cursor starts on No',
    );
    assert.equal(p.cursor, 1);
  });
}

test('the unnumbered reader refuses every other screen, including the numbered gate', () => {
  // The numbered gate is refused here on purpose rather than handled twice: `parsePane`
  // tries `parsePrompt` first, so v2.1.247 never reaches this function, and a second
  // reader for a box that already has one is the two-spellings trap.
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'))) {
    const expected = file === 'pane-trust-gate.txt' || file === 'pane-trust-gate-narrow.txt';
    assert.equal(Boolean(parseTrustGate(fixture(file))), expected, file);
  }
});

test('a third row means it is not this screen', () => {
  // Two rows is what the gate has. A run of three is some other box that happens to carry a
  // cursor above an `Enter to confirm` footer, and answering it by cursor would be guessing.
  const grown = fixture('pane-trust-gate.txt').replace(
    '   Yes, I trust this folder',
    '   Yes, I trust this folder\n   Maybe, ask me later',
  );
  assert.equal(parseTrustGate(grown), null);
});

test('a gate with no row that says it grants is not answerable', () => {
  const renamed = fixture('pane-trust-gate.txt').replace('Yes, I trust this folder', 'Yes, proceed');
  assert.equal(parseTrustGate(renamed), null, 'we cannot say which row grants — so we do not press');
});

test('a gate in the scrollback is not a live box', () => {
  // The footer is the only "this is open right now" marker the screen has. Without it the
  // card would offer to answer a box that has already been answered — and the walk would
  // send arrow keys and an Enter into a composer.
  const stale = `${fixture('pane-trust-gate.txt').replace('Enter to confirm · Esc to cancel', '')}\n❯ \n`;
  assert.equal(parseTrustGate(stale), null);
});

/* ──────────────────────────────────────────────────────────────── the copy ─── */

test('the workspace path is reassembled whole at both widths', () => {
  // At 70 columns the body walk takes a *truncated* path as `subject` and leaves the rest at
  // the front of `detail`. A path cut mid-word is worse than no path when the whole question
  // is which folder this is — and under the new ruling it is what somebody decides on.
  const wide = trustPath(parsePane(fixture('pane-trust-gate.txt')).prompt);
  const narrow = trustPath(parsePane(fixture('pane-trust-gate-narrow.txt')).prompt);
  assert.equal(narrow, wide);
  assert.ok(wide.endsWith('/alpha-trust-1'), wide);
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

/* ────────────────────────────────────────────────── the card, and its two rows ─── */

/**
 * Just enough DOM for `buildTrustCard`, and deliberately no more.
 *
 * The point is not to simulate a browser — it is to *record* everything the builder does to
 * a node, so `controls()` below can walk the result and say exactly what could be clicked.
 * Every mutation the builder is allowed to make is here; anything it grows later that this
 * stub does not model will throw rather than pass quietly.
 */
function withDom(fn) {
  const real = globalThis.document;
  const timers = globalThis.setTimeout;
  const nodes = [];
  globalThis.document = {
    createElement(tag) {
      const node = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        hidden: false,
        dataset: {},
        children: [],
        listeners: [],
        classList: {
          add: (...c) => (node.className = `${node.className} ${c.join(' ')}`.trim()),
          remove: (...c) => {
            const drop = new Set(c);
            node.className = node.className.split(/\s+/).filter((x) => x && !drop.has(x)).join(' ');
          },
        },
        append: (...kids) => node.children.push(...kids),
        addEventListener: (type) => node.listeners.push(type),
      };
      nodes.push(node);
      return node;
    },
  };
  // The arming timer must not hold the test runner open.
  globalThis.setTimeout = () => 0;
  try {
    return { node: fn(), nodes };
  } finally {
    globalThis.document = real;
    globalThis.setTimeout = timers;
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
      'contentEditable' in n,
  );
}

const labelsOf = (card) =>
  walk(card)
    .filter((n) => n.className.split(/\s+/).includes('perm-label'))
    .map((n) => n.textContent);

for (const [width, file] of WIDTHS) {
  test(`the card offers exactly the two rows the screen shows (${width})`, () => {
    const { prompt } = parsePane(fixture(file));
    const { node } = withDom(() => buildTrustCard(prompt, () => {}));

    const pressable = controls(node);
    assert.equal(pressable.length, 2, `two answers and nothing else, found ${pressable.length}`);
    assert.deepEqual(pressable.map((n) => n.tagName), ['BUTTON', 'BUTTON']);
    assert.deepEqual(labelsOf(node), prompt.options.map((o) => o.label), 'the screen’s own order');
  });

  test(`the card still says which folder and what it grants (${width})`, () => {
    // The half that did not change with the ruling. Refusing to answer was never refusing to
    // *tell you*; answering makes the transcript matter more, not less — it is what somebody
    // reads before they press Yes.
    const { prompt } = parsePane(fixture(file));
    const { node } = withDom(() => buildTrustCard(prompt, () => {}));
    const text = walk(node).map((n) => n.textContent).join('\n');

    assert.match(text, /folder-trust gate/);
    assert.match(text, /Accessing workspace:/);
    assert.match(text, /alpha-trust-1|trust-gate-fresh-5588/, 'the folder, whole');
    assert.match(text, /read, edit, and execute files here/);
  });

  test(`the rows carry no digit, because the screen no longer shows one (${width})`, () => {
    // v2.1.257 draws the gate unnumbered. A number printed beside a row would invent the
    // one cross-check a reader has against the terminal — and on this screen the digit was
    // never the keystroke anyway.
    const { prompt } = parsePane(fixture(file));
    const { node } = withDom(() => buildTrustCard(prompt, () => {}));
    assert.equal(walk(node).filter((n) => n.className.includes('perm-num')).length, 0);
    for (const label of labelsOf(node)) assert.doesNotMatch(label, /^\d+\./);
  });
}

test('the Yes asks twice and the No does not', () => {
  const { prompt } = parsePane(fixture('pane-trust-gate.txt'));
  const fired = [];
  const { node } = withDom(() => buildTrustCard(prompt, (o) => fired.push(o.label)));
  const [no, yes] = controls(node);

  no.onclick();
  assert.deepEqual(fired, ['No, exit'], 'refusing is the cheap direction — one click');

  yes.onclick();
  assert.deepEqual(fired, ['No, exit'], 'the first click arms and sends nothing');
  assert.match(yes.className, /is-armed/);
  assert.match(
    walk(yes).map((n) => n.textContent).join(' '),
    /read, edit and execute/,
    'and it says what the second click buys',
  );

  yes.onclick();
  assert.deepEqual(fired, ['No, exit', 'Yes, I trust this folder']);
});

test('the label is never taken off screen by the press that asks you to think about it', () => {
  const { prompt } = parsePane(fixture('pane-trust-gate.txt'));
  const { node } = withDom(() => buildTrustCard(prompt, () => {}));
  const yes = controls(node)[1];
  yes.onclick();
  assert.ok(labelsOf(node).includes('Yes, I trust this folder'));
});

test('a card built with no handler has nothing to press', () => {
  // The read-only render. It is also what stops this file being importable only in a
  // browser: `buildTrustCard` is called server-side by nothing today, and a future reader
  // that wants the transcript without the answers gets it without reaching for a stub.
  const { prompt } = parsePane(fixture('pane-trust-gate.txt'));
  const { node } = withDom(() => buildTrustCard(prompt));
  assert.deepEqual(controls(node), []);
  assert.deepEqual(
    walk(node).filter((n) => n.className === 'perm-gate-opt').map((n) => n.textContent),
    ['No, exit', 'Yes, I trust this folder'],
  );
});

/* ─────────────────────────────────────────────────────── the two front ends ─── */

test('the desktop composer routes the gate to its own card, ahead of the permission path', () => {
  // `buildDecisionBar` cannot be imported — it is a closure inside `createPane`, and
  // `web/app.js` imports `/vendor/marked.js` by an absolute browser URL. So the ordering is
  // pinned at the source, which is the thing that actually regressed once: the branch has to
  // come before the option loop, not merely exist somewhere in the function.
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('function buildDecisionBar('));
  const guard = body.indexOf('isTrustGate(');
  const buttons = body.indexOf("createElement('button')");
  assert.ok(guard > -1, 'buildDecisionBar has no trust-gate case');
  assert.ok(buttons > -1, 'the option loop moved — re-read this test before adjusting it');
  assert.ok(guard < buttons, 'the gate must be routed before anything builds a generic option button');
});

test('the answer endpoint answers the gate by cursor, never by digit', () => {
  // The rule this holds is not "the gate is answerable" — it is *how*. `keyForOption`
  // returns the option's own digit, which on v2.1.257 presses nothing at all; the gate is
  // answered by `confirmGateOption`, which walks the cursor and re-reads before it commits.
  const index = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const handler = index.slice(index.indexOf("app.post('/api/sessions/:id/answer'"));
  const end = handler.indexOf("app.post('/api/sessions/:id/question'");
  const body = handler.slice(0, end > 0 ? end : undefined);

  assert.match(body, /isTrustGate\(prompt\)/, 'the endpoint has no trust-gate case');
  assert.match(body, /confirmGateOption\(/, 'and no cursor walk to route it through');
  assert.match(body, /gate \? null : keyForOption\(/, 'a digit must never be computed for the gate');
  assert.match(body, /expectLabel/, 'and the render-to-click guard stays');
});
