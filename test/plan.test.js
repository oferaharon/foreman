import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlanPrompt, approvalKeys } from '../server/plan.js';
import { parsePrompt } from '../server/permission.js';
import { parseQuestion } from '../server/question.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * `dialog-plan-approve.txt` is a real `capture-pane` from a scratch session driven into
 * plan mode — not a reconstruction. The synthetic boxes below are assembled from label
 * strings read out of Claude Code v2.1.232's own option builder, which is the only way to
 * exercise variants that need a full context window or an enterprise flag to appear.
 * They are quoted, not invented; check them against the table in `server/plan.js`.
 */

const box = (header, rows, footer = ' ctrl+g to edit in Vim · ~/.claude/plans/some-plan.md') =>
  ['', ' '.padEnd(80, '─'), ` ${header}`, '', ...rows, '', footer, ''].join('\n');

const PROCEED = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';

test('the real box parses into options, a feedback row and a plan path', () => {
  const p = parsePlanPrompt(fixture('dialog-plan-approve.txt'));
  assert.equal(p.kind, 'plan');
  assert.equal(p.header, PROCEED);
  assert.deepEqual(
    p.options.map((o) => [o.index, o.label, o.tone]),
    [
      [1, 'Yes, and use auto mode', 'broad'],
      [2, 'Yes, manually approve edits', 'narrow'],
    ],
  );
  assert.equal(p.feedback.index, 3);
  assert.match(p.feedback.hint, /shift\+tab to approve with this feedback/);
  assert.equal(p.planPath, '~/.claude/plans/add-a-farewell-function-quizzical-pie.md');
});

/*
 * The free-text row's own sub-line sits *below* the numbered run, so it is not attached to
 * the row by the block reader and has to be found a line past the end. Miss it and the row
 * becomes a button that presses `3` and walks away, leaving a text input open in a terminal
 * nobody is looking at.
 */
test('the free-text row is never one of the answers', () => {
  const p = parsePlanPrompt(fixture('dialog-plan-approve.txt'));
  assert.equal(p.options.some((o) => /tell claude what to change/i.test(o.label)), false);
  assert.throws(() => approvalKeys(p, { index: 3 }), /not on screen/);
});

/*
 * A narrow pane wraps the box, and that is not a corner case — it is what a session in a
 * split Terminal window looks like, which is where this was found: the panel showed
 * "blocked, but the prompt could not be read" for a box it had every part of. Three things
 * wrap at 70 columns, and each one broke something:
 *
 *   the header    "…Would you like" / "to proceed?"        recognition failed outright
 *   the footer    "ctrl+g to edit in Vim ·" / "~/.claude…"  the plan file went unreadable
 *   a long label  its tail becomes the next line            the feedback row nearly
 *                                                           became a button
 *
 * `dialog-plan-approve-narrow.txt` is a real capture from a 70-column session.
 */
test('a wrapped box parses like an unwrapped one', () => {
  const p = parsePlanPrompt(fixture('dialog-plan-approve-narrow.txt'));
  assert.equal(p.header, PROCEED, 'the header is joined back together');
  assert.deepEqual(
    p.options.map((o) => [o.index, o.label]),
    [
      [1, 'Yes, and use auto mode'],
      [2, 'Yes, manually approve edits'],
    ],
  );
  assert.equal(p.feedback.index, 3);
  assert.equal(p.planPath, '~/.claude/plans/add-a-farewell-name-function-valiant-lemon.md');
});

/* The worst thing this parser could do: put a button on the row that opens a text input,
   press its digit, and leave a terminal nobody is watching waiting to be typed into. */
test('a wrapped feedback row is still not an answer', () => {
  const p = parsePlanPrompt(
    box(PROCEED, [
      ' ❯ 1. Yes, and use auto mode',
      '   2. Yes, manually approve edits',
      '   3. Tell Claude what to',
      '      change',
    ]),
  );
  assert.equal(p.options.length, 2);
  assert.equal(p.feedback.index, 3);
});

/* The two answers that cost you more than this plan. */
test('bypass and clear-context are marked danger', () => {
  const p = parsePlanPrompt(
    box(PROCEED, [
      ' ❯ 1. Yes, clear context (34% used) and bypass permissions',
      '   2. Yes, and bypass permissions',
      '   3. Yes, manually approve edits',
    ]),
  );
  assert.deepEqual(
    p.options.map((o) => o.tone),
    ['danger', 'danger', 'narrow'],
  );
});

test('auto-accept is broad, and Ultraplan is its own thing', () => {
  const p = parsePlanPrompt(
    box(PROCEED, [
      ' ❯ 1. Yes, auto-accept edits',
      '   2. Yes, manually approve edits',
      '   3. No, refine with Ultraplan on Claude Code on the web',
    ]),
  );
  assert.deepEqual(
    p.options.map((o) => o.tone),
    ['broad', 'narrow', 'refine'],
  );
});

/*
 * The rule this module exists for. Claude Code builds the option list per render, so the
 * safe answer is not at a fixed number — and unlike a permission box, *option 1 here is
 * the broad one*. Anything that answered by position would eventually press "clear context
 * and bypass permissions" while meaning "manually approve edits".
 */
test('an option is answered by its own digit, never its position', () => {
  const p = parsePlanPrompt(
    box(PROCEED, [
      ' ❯ 1. Yes, clear context (91% used) and bypass permissions',
      '   2. Yes, and use auto mode',
      '   3. Yes, manually approve edits',
    ]),
  );
  const narrow = p.options.find((o) => o.tone === 'narrow');
  assert.equal(narrow.index, 3, 'the safe answer is last here, on purpose');
  assert.deepEqual(approvalKeys(p, { index: narrow.index }).keys, ['3']);
  assert.deepEqual(approvalKeys(p, { index: 1 }).keys, ['1']);
});

/*
 * On the feedback row `Enter` means "keep planning with this note" and `shift+tab` means
 * "approve the plan *and* pass the note along". Those are opposite answers, and BTab is
 * what the mode picker would send.
 */
test('feedback opens the row, types, and presses Enter — never shift+tab', () => {
  const p = parsePlanPrompt(fixture('dialog-plan-approve.txt'));
  const { keys } = approvalKeys(p, { feedback: '  use pathlib instead  ' });
  assert.deepEqual(keys, ['3', { text: 'use pathlib instead' }, 'Enter']);
  assert.equal(keys.includes('BTab'), false);
});

test('empty feedback is not sent', () => {
  const p = parsePlanPrompt(fixture('dialog-plan-approve.txt'));
  assert.throws(() => approvalKeys(p, { feedback: '   ' }), /Nothing to send/);
});

test('the artifact and legacy variants parse too', () => {
  const artifact = parsePlanPrompt(
    box('Claude has written up a plan. Would you like to review it as an artifact first?', [
      ' ❯ 1. Review plan as artifact',
      '   2. Skip',
    ]),
  );
  assert.equal(artifact.options.length, 2);
  assert.equal(artifact.feedback, null, 'no free-text row on this one');

  const legacy = parsePlanPrompt(
    box('Claude wants to exit plan mode', [' ❯ 1. Yes', '   2. No'], ' Esc to cancel'),
  );
  assert.deepEqual(
    legacy.options.map((o) => o.label),
    ['Yes', 'No'],
  );
  assert.equal(legacy.planPath, null);
});

/*
 * Recognition is the header and nothing else. A numbered list under a heading this parser
 * doesn't know is some other screen, and must not be handed approval buttons.
 */
test('a numbered list under an unknown header is not a plan box', () => {
  assert.equal(
    parsePlanPrompt(box('Pick a favourite', [' ❯ 1. Yes, and use auto mode', '   2. No'])),
    null,
  );
});

/* ------------------------------------------------- three parsers, one screen each --- */

test('the permission and question parsers both refuse the plan box', () => {
  const text = fixture('dialog-plan-approve.txt');
  assert.equal(parsePrompt(text), null);
  assert.equal(parseQuestion(text), null);
});

test('the plan parser refuses every other box', () => {
  for (const name of [
    'prompt-bash.txt',
    'prompt-edit.txt',
    'dialog-choice-single.txt',
    'dialog-choice-multi.txt',
    'dialog-choice-review.txt',
    'dialog-choice-preview.txt',
    'dialog-model.txt',
    'dialog-effort.txt',
    'dialog-config.txt',
    'dialog-resume.txt',
    'pane-idle.txt',
    'pane-working.txt',
    'pane-prompt-shaped-text.txt',
  ]) {
    assert.equal(parsePlanPrompt(fixture(name)), null, name);
  }
});
