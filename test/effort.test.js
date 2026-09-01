import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEffortDialog, nudgeToward } from '../server/effort.js';
import { parseModelDialog } from '../server/model.js';
import { parsePrompt } from '../server/permission.js';
import { parseQuestion } from '../server/question.js';
import { parsePlanPrompt } from '../server/plan.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * `/effort` is a track with a marker on it rather than a numbered list, and it is the one
 * screen the panel drives that has **no session-only path at all**: its `Enter` writes
 * `effortLevel` to `~/.claude/settings.json` for every session started afterwards, and the
 * effort row inside `/model` does the same even when you press `s`. Both measured; both
 * undone from a backup. Arrow keys, though, write nothing — which is what makes stepping
 * safe and is why the marker can be walked into place before anything is committed.
 *
 * Both fixtures are real captures, one at each end of the scale.
 */

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

test('the scale and the marker are read off the track', () => {
  const d = parseEffortDialog(fixture('dialog-effort.txt'));
  assert.equal(d.kind, 'effort');
  assert.deepEqual(d.levels.map((l) => l.id), LEVELS);
  assert.equal(d.current, 'low');
  assert.equal(d.levels[0].current, true);
});

test('the far end of the scale reads as itself', () => {
  const d = parseEffortDialog(fixture('dialog-effort-ultracode.txt'));
  assert.equal(d.current, 'ultracode');
  assert.equal(d.levels.at(-1).current, true);
});

/*
 * The stops are not evenly spaced — the gaps widen towards `ultracode`, and the marker
 * sits left of its label at one end and right of it at the other. So the current level is
 * whichever label's column is *nearest*, never "the last one the marker passed".
 */
test('the nearest label wins, at both ends', () => {
  // The labels sit at columns 29, 37, 48, 57, 68 and 78 of their line; `at` is where the
  // marker goes on the track above, in the same coordinates.
  const box = (at) =>
    [
      '  Effort',
      '',
      `${'─'.repeat(at).padStart(at, '─')}`.padStart(at, ' ').slice(0, at) + '▲' + '─'.repeat(20),
      '                             low     medium     high     xhigh      max       ultracode',
      '',
      '  ←/→ to adjust · Enter to confirm · Esc to cancel',
    ].join('\n');

  assert.equal(parseEffortDialog(box(29)).current, 'low', 'exactly on it');
  assert.equal(parseEffortDialog(box(38)).current, 'medium', 'a column right of its label');
  assert.equal(parseEffortDialog(box(66)).current, 'max', 'two columns left of its label');
  assert.equal(parseEffortDialog(box(78)).current, 'ultracode', 'the far end');
  // The gap between `max` and `ultracode` is the widest on the scale, so the midpoint is
  // the one place a "last one passed" rule and a "nearest" rule disagree.
  assert.equal(parseEffortDialog(box(69)).current, 'max', 'just past max is still max');
});

test('nudging is one press at a time, and stops when it arrives', () => {
  const low = parseEffortDialog(fixture('dialog-effort.txt'));
  const top = parseEffortDialog(fixture('dialog-effort-ultracode.txt'));
  assert.equal(nudgeToward(low, 'max'), 'Right');
  assert.equal(nudgeToward(low, 'low'), null, 'already there — this is where Enter gets sent');
  assert.equal(nudgeToward(top, 'high'), 'Left');
  assert.throws(() => nudgeToward(low, 'turbo'), /No such effort level/);
});

test('nudging never yields anything but an arrow', () => {
  const box = parseEffortDialog(fixture('dialog-effort.txt'));
  for (const id of LEVELS) {
    const key = nudgeToward(box, id);
    assert.ok(key === null || key === 'Left' || key === 'Right', `${id} gave ${key}`);
  }
});

/* Recognition needs the key line, because what follows it ends in a keystroke. */
test('a track under some other footer is not the slider', () => {
  const text = fixture('dialog-effort.txt').replace(
    /←\/→ to adjust.*$/m,
    '  Enter to confirm · Esc to cancel',
  );
  assert.equal(parseEffortDialog(text), null);
});

/* ------------------------------------------------- five parsers, one screen each --- */

test('the other parsers all refuse the effort slider', () => {
  for (const name of ['dialog-effort.txt', 'dialog-effort-ultracode.txt']) {
    assert.equal(parsePrompt(fixture(name)), null, `permission / ${name}`);
    assert.equal(parseQuestion(fixture(name)), null, `question / ${name}`);
    assert.equal(parsePlanPrompt(fixture(name)), null, `plan / ${name}`);
    assert.equal(parseModelDialog(fixture(name)), null, `model / ${name}`);
  }
});

test('the effort parser refuses every other box', () => {
  for (const name of [
    'prompt-bash.txt',
    'prompt-edit.txt',
    'dialog-choice-single.txt',
    'dialog-choice-multi.txt',
    'dialog-choice-review.txt',
    'dialog-choice-preview.txt',
    'dialog-plan-approve.txt',
    'dialog-plan-approve-narrow.txt',
    'dialog-model.txt',
    'dialog-model-open.txt',
    'dialog-config.txt',
    'dialog-resume.txt',
    'pane-idle.txt',
    'pane-working.txt',
    'pane-bypass.txt',
  ]) {
    assert.equal(parseEffortDialog(fixture(name)), null, name);
  }
});
