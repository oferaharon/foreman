import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseQuestion, planAnswer, planChat, planFreeText } from '../server/question.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * Every fixture is a real `capture-pane` from v2.1.232, and every keystroke asserted here
 * was verified by pressing it in a scratch session and reading the result back.
 */

test('single-select: options, descriptions, and the escape hatches', () => {
  const q = parseQuestion(fixture('dialog-choice-single.txt'));
  assert.equal(q.kind, 'question');
  assert.equal(q.multiSelect, false);
  assert.equal(q.question, "What's your favourite colour?");
  assert.deepEqual(
    q.options.map((o) => o.label),
    ['Blue', 'Green', 'Red'],
  );
  assert.equal(q.options[0].description, 'The safe answer everyone gives');
  // "Type something" and "Chat about this" are rows, but not answers the panel offers.
  assert.equal(q.freeTextIndex, 4);
  assert.equal(q.chatIndex, 5);
});

test('multi-select is told apart by its checkboxes, not by its wording', () => {
  const q = parseQuestion(fixture('dialog-choice-multi.txt'));
  assert.equal(q.multiSelect, true);
  assert.equal(q.question, 'Which fruits do you like?');
  assert.equal(q.options.length, 4);
  assert.deepEqual(q.chosen, [], 'nothing ticked yet');
});

test('the review screen is its own kind, because its digits mean something else', () => {
  // On the question screen 1 toggles the first option. Here 1 submits everything.
  const q = parseQuestion(fixture('dialog-choice-review.txt'));
  assert.equal(q.kind, 'review');
  assert.equal(q.submitIndex, 1);
  assert.equal(q.cancelIndex, 2);
  assert.deepEqual(q.answers, [
    {
      question: 'What are you in the mood for at breakfast?',
      answer: 'Pastry & coffee, Just coffee',
    },
  ]);
});

test('everything that is not a question box is refused', () => {
  for (const file of [
    'dialog-model.txt',
    'dialog-effort.txt',
    'dialog-config.txt',
    'dialog-resume.txt',
    'prompt-bash.txt',
    'prompt-edit.txt',
    'pane-idle.txt',
    'pane-working.txt',
  ]) {
    assert.equal(parseQuestion(fixture(file)), null, file);
  }
});

/* ------------------------------------------------------------- answering --- */

test('a preview panel beside the options is cut away, not read as labels', () => {
  const q = parseQuestion(fixture('dialog-choice-preview.txt'));
  assert.equal(q.kind, 'question');
  assert.equal(q.multiSelect, false);
  assert.equal(q.question, 'How do you want to put a folder group into a manual group?');
  // Wrapped labels rejoin; the ASCII mock-up to their right contributes nothing.
  assert.deepEqual(
    q.options.map((o) => o.label),
    ['Hover menu on the folder heading', 'Drag the heading onto a group', "A 'manage groups' editor"],
  );
  // This layout drops the free-text row and leaves `Chat about this` unnumbered.
  assert.equal(q.freeTextIndex, null);
  assert.deepEqual(
    q.questions.map((t) => t.label),
    ['Assign UI', 'Collapse'],
  );
  // The trap: here a digit only moves the cursor. `Enter` is what selects.
  assert.equal(q.needsConfirm, true);
  assert.deepEqual(planAnswer(q, [2]).keys, ['2', 'Enter']);
});

test('a plain single-select still answers on the digit alone', () => {
  const q = parseQuestion(fixture('dialog-choice-single.txt'));
  assert.equal(q.needsConfirm, false);
  assert.deepEqual(planAnswer(q, [2]).keys, ['2']);
});

test('single-select answers in one press', () => {
  const q = parseQuestion(fixture('dialog-choice-single.txt'));
  assert.deepEqual(planAnswer(q, [2]), { keys: ['2'], needsReview: false });
});

test('single-select refuses more than one answer', () => {
  const q = parseQuestion(fixture('dialog-choice-single.txt'));
  assert.throws(() => planAnswer(q, [1, 2]), /single answer/);
});

test('multi-select toggles each pick, then needs the review screen', () => {
  const q = parseQuestion(fixture('dialog-choice-multi.txt'));
  const plan = planAnswer(q, [2, 4]);
  assert.deepEqual(plan.keys, ['2', '4']);
  assert.equal(plan.needsReview, true, 'a multi-select is never submitted by a digit alone');
});

/*
 * The box remembers what is ticked, so the keys are a *diff*, not a re-selection. Sending
 * a digit for something already ticked would turn it off — the exact bug that makes
 * "just send the chosen indexes" wrong.
 */
test('multi-select toggles relative to what is already ticked', () => {
  const q = parseQuestion(fixture('dialog-choice-multi.txt'));
  q.options[1].checked = true; // pretend Strawberry is already on

  assert.deepEqual(planAnswer(q, [2]).keys, [], 'already ticked — nothing to press');
  assert.deepEqual(planAnswer(q, [3]).keys, ['2', '3'], 'untick 2, tick 3');
});

test('an option that is not on screen is refused rather than guessed', () => {
  const q = parseQuestion(fixture('dialog-choice-multi.txt'));
  assert.throws(() => planAnswer(q, [9]), /not on screen/);
  assert.throws(() => planAnswer(q, []), /Nothing was chosen/);
});

test('the review screen cannot be answered as if it were a question', () => {
  const q = parseQuestion(fixture('dialog-choice-review.txt'));
  assert.throws(() => planAnswer(q, [1]), /Not a question box/);
});

/* -------------------------------------------------- wrapping, and the way out --- */

/*
 * A question long enough to be worth asking wraps, and taking only the line nearest the
 * options showed the tail of the sentence with the subject missing — a card reading
 * "lighter preparation-and-reminder track?" over a terminal that had asked "Should
 * durable_power_of_attorney be a full first-class workflow, or a lighter
 * preparation-and-reminder track?". Real capture, 74 columns, four wrapped lines.
 */
test('a wrapped question is read whole, not from its last line', () => {
  const q = parseQuestion(fixture('dialog-choice-wrapped.txt'));
  assert.match(q.question, /^When displaying the list of sessions/);
  assert.match(q.question, /visually clustered together\?$/);
  assert.equal(q.question.includes('  '), false, 'joined with single spaces');
});

test('a wrapped description keeps every line of itself', () => {
  const q = parseQuestion(fixture('dialog-choice-wrapped.txt'));
  const first = q.options[0].description;
  assert.match(first, /^Sessions are grouped under the exact working directory/);
  assert.match(first, /fragment one project into many groups\.$/, 'not cut at the first line');
  assert.equal(q.options.length, 3, 'still three answers, and the hatches are not among them');
});

/* The chrome above the question is its top edge — stepping over it splices the transcript on. */
test('the question stops at the box, not at the conversation above it', () => {
  const q = parseQuestion(fixture('dialog-choice-wrapped.txt'));
  assert.equal(/Use AskUserQuestion/.test(q.question), false, 'the prompt above is not the question');
});

/*
 * `Chat about this` is the same one press on every layout: it declines the questions, the
 * box closes and the composer comes back. Pressed by hand on both a single- and a
 * multi-select, where every other digit merely toggles.
 */
test('chat about this is answered by its own digit, wherever it sits', () => {
  assert.deepEqual(planChat(parseQuestion(fixture('dialog-choice-single.txt'))).keys, ['5']);
  assert.deepEqual(planChat(parseQuestion(fixture('dialog-choice-multi.txt'))).keys, ['6']);
});

/* The preview layout leaves the row unnumbered — nothing to press, so nothing is offered. */
test('a box with no chat row refuses rather than guessing a digit', () => {
  assert.throws(
    () => planChat(parseQuestion(fixture('dialog-choice-preview.txt'))),
    /no "Chat about this" row/,
  );
});

/*
 * The free-text row is three steps and not one: the digit opens an editor on that row
 * (the footer grows `ctrl+g to edit in Vim`), what you type replaces its label, and Enter
 * sends it. All three measured.
 */
test('free text opens the row, types, and submits — in that order', () => {
  const plan = planFreeText(parseQuestion(fixture('dialog-choice-single.txt')), '  teal,  obviously ');
  assert.deepEqual(plan, { open: '4', text: 'teal, obviously', submit: 'Enter' });
});

/*
 * And it is single-select only. On a multi-select the same digit *ticks* the row — cursor
 * unmoved, no editor — so anything typed after it would land nowhere anyone can see.
 */
test('a multi-select free-text row is refused, because its digit only ticks', () => {
  assert.throws(
    () => planFreeText(parseQuestion(fixture('dialog-choice-multi-hatch.txt')), 'teal'),
    /ticks, not typing/,
  );
});

test('nothing typed is not an answer', () => {
  assert.throws(
    () => planFreeText(parseQuestion(fixture('dialog-choice-single.txt')), '   '),
    /Nothing was typed/,
  );
});

test('a box with no free-text row refuses it', () => {
  assert.throws(
    () => planFreeText(parseQuestion(fixture('dialog-choice-preview.txt')), 'teal'),
    /no free-text row/,
  );
});

test('an essay is refused before it is typed into a one-line field', () => {
  assert.throws(
    () => planFreeText(parseQuestion(fixture('dialog-choice-single.txt')), 'x'.repeat(501)),
    /too long/,
  );
});

/*
 * Half-answered: someone has pressed the free-text row and typed into it, here or in the
 * terminal. Its label is no longer "Type something." — and recognising the box only by
 * that row meant it stopped parsing mid-answer, taking the card away from under whoever
 * was typing. The numbered `Chat about this` row is the second witness.
 */
test('a box being typed into is still a question box', () => {
  const q = parseQuestion(fixture('dialog-choice-typed.txt'));
  assert.equal(q.kind, 'question');
  assert.equal(q.chatIndex, 5, 'the way out is still there');
  assert.equal(q.freeTextIndex, null, 'that row is holding text now, not an invitation');
  assert.match(q.options.at(-1).label, /^neither/, 'and it shows what is actually typed');
});
