import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseModelDialog,
  parseModelConfirm,
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
