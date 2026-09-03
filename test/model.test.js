import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseModelDialog,
  parseModelConfirm,
  modelDialogOpen,
  modelConfirmOpen,
  confirmNames,
  stepToward,
  footerModelName,
} from '../server/model.js';
import { parsePrompt } from '../server/permission.js';
import { parseQuestion } from '../server/question.js';
import { parsePlanPrompt } from '../server/plan.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * Both fixtures are real `capture-pane` output from a scratch session. The reason this
 * parser exists at all is in its module comment, and it is worth repeating here: in this
 * one dialog **a digit commits, and commits as the global default**. It was measured the
 * expensive way — pressing `4` rewrote `model` in `~/.claude/settings.json` and the file
 * had to be restored from a backup. Nothing in this module or its endpoint may ever send
 * a digit or `Enter`; the cursor is stepped and `s` commits.
 */

test('the picker parses into rows, a cursor and a current model', () => {
  const d = parseModelDialog(fixture('dialog-model.txt'));
  assert.equal(d.kind, 'model');
  assert.deepEqual(
    d.options.map((o) => o.label),
    ['Default (recommended)', 'Opus (1M context)', 'Fable', 'Sonnet', 'Haiku'],
  );
  assert.equal(d.cursorIndex, 2);
  assert.equal(d.currentIndex, 2);
  assert.match(d.options[3].description, /Efficient for routine tasks/);
});

/* The tick rides on the label and the blurb shares the line — a column gap, not a wrap. */
test('the tick is stripped from the label, not left in it', () => {
  const d = parseModelDialog(fixture('dialog-model-open.txt'));
  assert.equal(d.cursorIndex, 5);
  assert.equal(d.currentIndex, 5);
  assert.equal(d.options[4].label, 'Haiku', 'no ✔ and no blurb');
  assert.equal(d.options[4].current, true);
  assert.match(d.options[4].description, /Fastest for quick answers/);
});

/*
 * A plan is returned rather than a count, so the caller presses once, re-reads and asks
 * again. `changeMode` learned this the same way: a count computed up front and fired blind
 * lands somewhere nobody chose the first time the layout moves.
 */
test('stepping is one direction at a time, and stops when it arrives', () => {
  assert.equal(stepToward(2, 5), 'Down');
  assert.equal(stepToward(5, 2), 'Up');
  assert.equal(stepToward(4, 4), null, 'already there — this is where `s` gets sent');
  assert.equal(stepToward(null, 3), null, 'no cursor read means no blind pressing');
});

test('stepping never yields anything but an arrow', () => {
  for (let from = 1; from <= 5; from += 1) {
    for (let to = 1; to <= 5; to += 1) {
      const key = stepToward(from, to);
      assert.ok(key === null || key === 'Up' || key === 'Down', `${from}->${to} gave ${key}`);
    }
  }
});

/* Recognition needs the footer, because the code downstream of it ends in a keystroke. */
test('a list of models under some other footer is not the picker', () => {
  const text = fixture('dialog-model.txt').replace(
    /Enter to set as default.*$/m,
    '  Enter to confirm · Esc to cancel',
  );
  assert.equal(parseModelDialog(text), null);
});

/* ------------------------------------------------------ the second screen --- */

/*
 * `s` is not always the last key. Mid-conversation Claude Code holds the switch behind
 * `Switch model?`, and until that is answered nothing has changed — which is how the panel
 * came to report a model it had not set, over a session left sitting on a box. All three
 * fixtures are real captures, at 220, 70 and 50 columns; the last one is why the label and
 * its wrapped tail are read together.
 */

test('the confirmation parses, at every width, and names its target', () => {
  const cases = [
    ['dialog-model-confirm.txt', 'Opus 5 (1M context)'],
    ['dialog-model-confirm-narrow.txt', 'Sonnet 5'],
    ['dialog-model-confirm-wrapped.txt', 'Opus 5 (1M context) (default)'],
  ];
  for (const [name, target] of cases) {
    const c = parseModelConfirm(fixture(name));
    assert.equal(c.kind, 'model-confirm', name);
    assert.equal(c.target, target, `${name} — the wrapped tail belongs to the label`);
    assert.equal(c.yesIndex, 1, 'the broad answer is option 1 here, like the plan box');
    assert.equal(c.noIndex, 2);
  }
});

/*
 * Narrow on purpose. The caller answers this box by pressing a digit, so a third row —
 * an "and don't ask again" of the kind the permission box grew — must stop it dead rather
 * than have it press 1 at something new.
 */
test('anything but the exact yes/no pair is refused', () => {
  const text = fixture('dialog-model-confirm.txt');
  assert.equal(parseModelConfirm(text.replace(/Switch model\?/, 'Switch branch?')), null, 'title');
  assert.equal(
    parseModelConfirm(text.replace(/2\. No, go back/, '2. Yes, and stop asking\n    3. No, go back')),
    null,
    'a third row',
  );
  assert.equal(
    parseModelConfirm(text.replace(/1\. Yes, switch to .*/, '1. Yes')),
    null,
    'a yes that names nothing',
  );
});

/*
 * The two screens spell the same model differently, so the check is by word rather than by
 * string — and it still has to tell the default row from the Opus row, which share a blurb.
 */
test('the confirmation is matched against the row that was clicked', () => {
  const rows = parseModelDialog(fixture('dialog-model.txt')).options;
  const row = (label) => rows.find((o) => o.label === label);

  assert.equal(confirmNames('Sonnet 5', row('Sonnet')), true);
  assert.equal(confirmNames('Haiku 4.5', row('Haiku')), true);
  assert.equal(confirmNames('Fable 5', row('Fable')), true);
  assert.equal(confirmNames('Opus 5 (1M context) (default)', row('Default (recommended)')), true);

  assert.equal(confirmNames('Sonnet 5', row('Haiku')), false, 'a different model');
  assert.equal(
    confirmNames('Opus 5 (1M context) (default)', row('Opus (1M context)')),
    false,
    'only one of the two Opus rows is the default',
  );
  assert.equal(confirmNames('', row('Sonnet')), false, 'nothing named is not a match');
  assert.equal(confirmNames('Sonnet 5', null), false);
});

/* ------------------------------------------------- four parsers, one screen each --- */

test('the other parsers all refuse the model picker', () => {
  for (const name of [
    'dialog-model.txt',
    'dialog-model-open.txt',
    'dialog-model-confirm.txt',
    'dialog-model-confirm-narrow.txt',
    'dialog-model-confirm-wrapped.txt',
  ]) {
    assert.equal(parsePrompt(fixture(name)), null, `permission / ${name}`);
    assert.equal(parseQuestion(fixture(name)), null, `question / ${name}`);
    assert.equal(parsePlanPrompt(fixture(name)), null, `plan / ${name}`);
  }
});

/* The picker and its confirmation are the same feature and still two screens. */
test('the picker and the confirmation refuse each other', () => {
  for (const name of [
    'dialog-model-confirm.txt',
    'dialog-model-confirm-narrow.txt',
    'dialog-model-confirm-wrapped.txt',
  ]) {
    assert.equal(parseModelDialog(fixture(name)), null, name);
  }
  for (const name of ['dialog-model.txt', 'dialog-model-open.txt']) {
    assert.equal(parseModelConfirm(fixture(name)), null, name);
  }
});

test('the model parser refuses every other box', () => {
  for (const name of [
    'prompt-bash.txt',
    'prompt-edit.txt',
    'dialog-choice-single.txt',
    'dialog-choice-multi.txt',
    'dialog-choice-review.txt',
    'dialog-choice-preview.txt',
    'dialog-plan-approve.txt',
    'dialog-plan-approve-narrow.txt',
    'dialog-effort.txt',
    'dialog-config.txt',
    'dialog-resume.txt',
    'pane-idle.txt',
    'pane-working.txt',
    'pane-bypass.txt',
  ]) {
    assert.equal(parseModelDialog(fixture(name)), null, name);
    assert.equal(parseModelConfirm(fixture(name)), null, `confirm / ${name}`);
  }
});

/*
 * The picker's rows and the composer footer do not spell a model the same way, and the
 * panel has to know what the footer *will* say before the terminal redraws it — that is
 * the whole of why the label used to sit one switch behind. These pin the bridge on the
 * real fixture, and pin that it declines rather than guesses.
 */
test("a picker row says what the footer will call it", () => {
  const d = parseModelDialog(fixture('dialog-model.txt'));
  assert.deepEqual(
    d.options.map(footerModelName),
    ['Opus 5', 'Opus 5', 'Fable 5', 'Sonnet 5', 'Haiku 4.5'],
  );
});

test('a row with no blurb to read yields nothing rather than a guess', () => {
  // A row with no blurb is a layout nobody has met — at 70 columns the blurb wraps but
  // survives, pinned below. If one ever arrives, the label alone names a *choice*, not a
  // model: reading `Sonnet` as the footer's `Sonnet 5` would be inventing the version.
  assert.equal(footerModelName({ label: 'Sonnet', description: null }), null);
  assert.equal(footerModelName({ label: 'Default (recommended)', description: '' }), null);
  assert.equal(footerModelName(undefined), null);
  // ...and a blurb that names no model is the same case, not a partial match.
  assert.equal(footerModelName({ label: 'Sonnet', description: 'Efficient for routine tasks' }), null);
});

test('the footer spelling is read with the footer\'s own pattern, parenthetical and all', () => {
  // `parsePane` reads this exact shape off the footer line; the client's `shortModel`
  // drops the trailing parenthetical, which is why `Opus 5` and `Opus 5 (1M context)`
  // are the same label on screen and the seed never wobbles.
  assert.equal(
    footerModelName({ label: 'Opus', description: 'Opus 5 (1M context) · Best for everyday tasks' }),
    'Opus 5 (1M context)',
  );
  assert.equal(footerModelName({ label: 'Haiku', description: 'Haiku 4.5 · Fastest' }), 'Haiku 4.5');
});

/*
 * The same box at 70 columns, captured from a session in the sandbox's `alpha`. Pane width
 * is an input to every parser here, and this one had no narrow capture at all.
 *
 * The thing it pins beyond the parse: the blurb *wraps* but is not lost, and the model name
 * sits at its front — `Fable 5.1 · Most capable for your` — so what `footerModelName` reads
 * is the half that survives. That is why the picker can predict the footer at any width
 * rather than only on a wide terminal, and it is measured here rather than assumed.
 */
test('the picker parses at 70 columns, and the footer name survives the wrap', () => {
  const d = parseModelDialog(fixture('dialog-model-narrow.txt'));
  assert.deepEqual(
    d.options.map((o) => o.label),
    ['Default (recommended)', 'Opus (1M context)', 'Fable', 'Sonnet', 'Haiku'],
  );
  assert.equal(d.currentIndex, 4);
  assert.deepEqual(
    d.options.map(footerModelName),
    ['Opus 5', 'Opus 5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5'],
  );
});

/* ------------------------------------------------- the scrolling window --- */

/*
 * What the picker becomes on a short pane, and the reason this whole section exists: the
 * panel's own attach-terminal button opens a default macOS Terminal window, which shrinks
 * the pane to **80×23**, and at that height Claude Code stops drawing five rows and draws
 * a three-row scrolling window instead — `↑`/`↓` markers in the cursor column and a
 * `… +2 models` row counting what is hidden.
 *
 * Every fixture below is a real `capture-pane` from a scratch session in the sandbox's
 * `alpha` on v2.1.257, one per cursor position, plus the same box at 220 columns and 23
 * rows. That last one is the measurement that decided the fix: **the collapse is height,
 * not width.** 220×23 windows exactly like 80×23 while 220×50 shows all five rows, so
 * this is not a narrow-terminal case and a wide capture proves nothing on its own.
 *
 * What it cost before: `↓ 3.` does not match `OPTION_RE`, so the run came back as 1..2 or
 * as 3..4 — not a 1..N run at all — and the parser answered null over a box the panel had
 * opened itself, which it then could not read, could not close, and which blocked the
 * composer until somebody pressed Esc in the terminal.
 */

const SCROLLED = {
  // fresh open: the cursor sits on the ✔ row, which is the last visible one, so the `↓`
  // that would mark it is not drawn — this is the state that used to parse and quietly
  // return three models out of five.
  'dialog-model-scroll-top.txt': { window: [1, 2, 3], cursor: 3 },
  // one `Up`: `↓ 3.` on the bottom row.
  'dialog-model-scroll-down.txt': { window: [1, 2, 3], cursor: 2 },
  // `↑ 2.` on the top row, and the run no longer starts at 1.
  'dialog-model-scroll-up.txt': { window: [2, 3, 4], cursor: 4 },
  // the end of the list: `↑ 3.` above, and the effort line changes to "not supported".
  'dialog-model-scroll-end.txt': { window: [3, 4, 5], cursor: 5 },
  // 220 columns, 23 rows — same window, no wrapped blurbs. Height, not width.
  'dialog-model-scroll-wide.txt': { window: [1, 2, 3], cursor: 2 },
};

const NAMES = {
  1: 'Default (recommended)',
  2: 'Opus (1M context)',
  3: 'Fable',
  4: 'Sonnet',
  5: 'Haiku',
};

test('a scrolled window parses, at every cursor position, keeping the list\'s own numbers', () => {
  for (const [name, want] of Object.entries(SCROLLED)) {
    const d = parseModelDialog(fixture(name));
    assert.ok(d, `${name} — the whole point: this used to be null`);
    assert.deepEqual(d.options.map((o) => o.index), want.window, name);
    assert.deepEqual(
      d.options.map((o) => o.label),
      want.window.map((i) => NAMES[i]),
      `${name} — the marker column is not part of the label`,
    );
    assert.equal(d.cursorIndex, want.cursor, `${name} — a marker is never the cursor`);
  }
});

/*
 * `… +N models` counts everything hidden, not what is below the fold: it reads `+2` at the
 * top of the list and `+2` at the bottom. So `visible + N` is the length of the whole list
 * — the only thing on screen that says how many models there are, and what tells the
 * enumeration when to stop pressing.
 */
test('the window says how much of the list it is not showing', () => {
  for (const name of Object.keys(SCROLLED)) {
    const d = parseModelDialog(fixture(name));
    assert.equal(d.windowed, true, name);
    assert.equal(d.hidden, 2, `${name} — +2 at either end of the list`);
    assert.equal(d.total, 5, name);
    assert.equal(d.partial, true, `${name} — three of five is not a menu`);
  }
});

/* The wide, tall box is untouched by any of it: no markers, no `… +N`, nothing to rebase. */
test('a box showing the whole list says so, and reads exactly as before', () => {
  for (const name of ['dialog-model.txt', 'dialog-model-open.txt', 'dialog-model-narrow.txt']) {
    const d = parseModelDialog(fixture(name));
    assert.equal(d.windowed, false, name);
    assert.equal(d.partial, false, name);
    assert.equal(d.hidden, 0, name);
    assert.equal(d.total, 5, name);
    assert.equal(d.options.length, 5, name);
  }
});

/*
 * The ✔ can be off-window, and then there is no current row to report. Null rather than a
 * guess, for the reason the rest of this file keeps choosing: a wrong tick on a menu says
 * "you are already on this one" about a model the session is not running.
 */
test('a tick outside the window is reported as absent, not moved', () => {
  const d = parseModelDialog(fixture('dialog-model-scroll-end.txt'));
  assert.equal(d.currentIndex, 3, 'Fable is still visible at the top of this window');
  const off = parseModelDialog(
    fixture('dialog-model-scroll-end.txt').replace('3. Fable ✔  ', '3. Fable    '),
  );
  assert.deepEqual(off.options.map((o) => o.index), [3, 4, 5]);
  assert.equal(off.currentIndex, null);
});

/*
 * The window is flattened *inside* this module — marker column blanked, `… +N` lifted out,
 * run rebased to 1 — so the shared block reader and the four other parsers see nothing new.
 * These are the cross-refusals for the new shape, and they are the reason `OPTION_RE` in
 * `question.js` was left exactly as it was.
 */
test('the other parsers all refuse the scrolling picker too', () => {
  for (const name of [...Object.keys(SCROLLED), 'dialog-model-confirm-short.txt']) {
    assert.equal(parsePrompt(fixture(name)), null, `permission / ${name}`);
    assert.equal(parseQuestion(fixture(name)), null, `question / ${name}`);
    assert.equal(parsePlanPrompt(fixture(name)), null, `plan / ${name}`);
  }
});

test('the picker and the confirmation still refuse each other on a short pane', () => {
  assert.equal(parseModelDialog(fixture('dialog-model-confirm-short.txt')), null);
  for (const name of Object.keys(SCROLLED)) {
    assert.equal(parseModelConfirm(fixture(name)), null, name);
  }
});

/* The second screen is unchanged by the height — captured at 80×23, the yes label unwrapped. */
test('the confirmation still parses at 80x23', () => {
  const c = parseModelConfirm(fixture('dialog-model-confirm-short.txt'));
  assert.equal(c.kind, 'model-confirm');
  assert.equal(c.target, 'Haiku 4.5');
  assert.equal(c.yesIndex, 1);
  assert.equal(c.noIndex, 2);
  assert.equal(confirmNames(c.target, { label: 'Haiku', description: 'Haiku 4.5 · Fastest' }), true);
});

/* A window's rows still say what the footer will call them — the blurb survives the fold. */
test('the footer name is readable from a windowed row', () => {
  const d = parseModelDialog(fixture('dialog-model-scroll-end.txt'));
  assert.deepEqual(d.options.map(footerModelName), ['Fable 5.1', 'Sonnet 5', 'Haiku 4.5']);
});

/* ---------------------------------------------------- getting back out --- */

/*
 * The second half of the bug, and the half that made the first half unrecoverable.
 *
 * `closeModelDialog` used to ask `parseModelDialog` whether there was anything to close, so
 * a box it could not read was a box it decided was not there: it pressed nothing, reported
 * success, and left the session blocked. Whether the panel may *drive* the picker and
 * whether there is a picker to get **out of** are different questions, and only the second
 * one is allowed to be answered by the title and the footer alone.
 */
test('the picker is recognised as open even when its rows cannot be read', () => {
  for (const name of [...Object.keys(SCROLLED), 'dialog-model.txt', 'dialog-model-narrow.txt']) {
    assert.equal(modelDialogOpen(fixture(name)), true, name);
  }
  // The shape that started all this, stood up synthetically because the real one is fixed:
  // a run this module cannot make sense of. Broken in the middle rather than at an edge, so
  // it fails the way a future layout would — rows that are there and do not line up.
  const broken = fixture('dialog-model-scroll-up.txt').replace(/^(\s*)3\. Fable/m, '$19. Fable');
  assert.equal(parseModelDialog(broken), null, 'unreadable, by construction');
  assert.equal(modelDialogOpen(broken), true, 'and still plainly on screen');
});

test('the confirmation is recognised as open by its title alone', () => {
  assert.equal(modelConfirmOpen(fixture('dialog-model-confirm-short.txt')), true);
  assert.equal(modelConfirmOpen(fixture('dialog-model-confirm.txt')), true);
  // Narrow on purpose, so a third row makes `parseModelConfirm` refuse — and the box the
  // panel then cannot answer is exactly the one it must still be able to Escape.
  const grown = fixture('dialog-model-confirm.txt').replace(
    /2\. No, go back/,
    '2. Yes, and stop asking\n    3. No, go back',
  );
  assert.equal(parseModelConfirm(grown), null);
  assert.equal(modelConfirmOpen(grown), true);
});

test('neither witness fires on a screen that is not the picker', () => {
  for (const name of [
    'prompt-bash.txt',
    'dialog-choice-single.txt',
    'dialog-plan-approve.txt',
    'dialog-effort.txt',
    'dialog-config.txt',
    'dialog-resume.txt',
    'pane-idle.txt',
    'pane-working.txt',
    'pane-trust-gate.txt',
  ]) {
    assert.equal(modelDialogOpen(fixture(name)), false, name);
    assert.equal(modelConfirmOpen(fixture(name)), false, `confirm / ${name}`);
  }
});

/*
 * The footer has to sit *below* the heading. A `Select model` line left in the scrollback
 * by an earlier `/model` must not stand in for a live box — the witness ends in Escape
 * keystrokes, and pressing those into a composer is not free.
 */
test('a heading in the scrollback is not a box', () => {
  const stale = `${fixture('dialog-model.txt')
    .split('\n')
    .filter((l) => !/to set as default/.test(l))
    .join('\n')}\n❯ \n`;
  assert.equal(modelDialogOpen(stale), false);
});
