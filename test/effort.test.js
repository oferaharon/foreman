import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEffortDialog, nudgeToward, commitKey } from '../server/effort.js';
import { parseModelDialog } from '../server/model.js';
import { parsePrompt } from '../server/permission.js';
import { parseQuestion } from '../server/question.js';
import { parsePlanPrompt } from '../server/plan.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * `/effort` is a track with a marker on it rather than a numbered list. Arrow keys write
 * nothing, which is what makes stepping safe and is why the marker can be walked into
 * place before anything is committed.
 *
 * Two layouts, every fixture a real capture. `dialog-effort*.txt` without a version is
 * Claude Code v2.1.232: six stops, `ultracode` the last of them, and only `Enter` to
 * commit, which wrote `effortLevel` for every session started afterwards.
 * `dialog-effort-v296*.txt` is v2.1.296: five stops, Ultracode a `Tab` toggle beside the
 * track, and `s` for this session only. Each v2.1.296 capture comes from a session created
 * at the size it was captured at (220×50, 70×30, 80×23 and 56×30) and never resized. The
 * home folder in the banner was shortened to `~/…/foreman-sandbox/alpha`, which no parser
 * reads.
 */

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const LEVELS_V296 = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_FIXTURES = fs.readdirSync(FIXTURES).filter((f) => /^dialog-effort.*\.txt$/.test(f));

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
  // Both layouts draw the track across every label, so this one runs to column 88.
  const box = (at) =>
    [
      '  Effort',
      '',
      '─'.repeat(at) + '▲' + '─'.repeat(88 - at),
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

/* --------------------------------------------------------------- v2.1.296 --- */

/*
 * The break this fixes. v2.1.296 puts the Ultracode toggle's state at the end of the
 * track's own line, so a track test anchored at both ends refused the whole slider. It
 * answered null at 70 columns and wider, which covers every width the panel launches at,
 * and `/effort/open` then answered 502 "The effort slider did not come up".
 */
for (const [file, current, ultracode] of [
  ['dialog-effort-v296.txt', 'xhigh', false],
  ['dialog-effort-v296-narrow.txt', 'xhigh', false],
  ['dialog-effort-v296-short.txt', 'low', true],
  ['dialog-effort-v296-wrapped.txt', 'max', false],
  ['dialog-effort-v296-wrapped-ultracode.txt', 'xhigh', true],
]) {
  test(`v2.1.296 reads as five stops and a toggle / ${file}`, () => {
    const d = parseEffortDialog(fixture(file));
    assert.ok(d, 'the slider was not recognised');
    assert.deepEqual(d.levels.map((l) => l.id), LEVELS_V296, '`Tab to toggle` is not three stops');
    assert.equal(d.current, current);
    assert.equal(d.ultracode, ultracode);
    assert.equal(d.sessionOnly, true);
  });
}

test('the older layout has no toggle and no session-only key', () => {
  for (const name of ['dialog-effort.txt', 'dialog-effort-ultracode.txt']) {
    const d = parseEffortDialog(fixture(name));
    assert.equal(d.ultracode, null, name);
    assert.equal(d.sessionOnly, false, name);
  }
});

/*
 * While Ultracode is on, a caption is drawn under the labels that starts with the word.
 * On a 56-column pane it sits right above the toggle. It must not be read as the toggle.
 */
test('the Ultracode caption is not the toggle', () => {
  const text = fixture('dialog-effort-v296-wrapped-ultracode.txt');
  assert.match(text, /Ultracode: dynamic workflows on every task/);
  const noToggle = text.replace(/^\s*Ultracode\s+on$/m, '');
  assert.equal(parseEffortDialog(noToggle).ultracode, null);
});

/*
 * The two tails are cut by name. Anything else on the track's line, or past the track's
 * end on the labels' line, is something nobody has measured, so the screen is refused
 * rather than read as more stops.
 */
test('an unknown tail on the track or the labels is refused, not read', () => {
  const text = fixture('dialog-effort-v296.txt');
  assert.equal(parseEffortDialog(text.replace('Ultracode  off', 'Turbo  off')), null);
  assert.equal(parseEffortDialog(text.replace('Tab to toggle', 'Shift+Tab: more')), null);
});

/*
 * The session-only key wraps onto the footer's second line at 56 columns
 * (`… s for this` / `session only · Esc to cancel`), and it still has to be seen.
 */
test('the session-only key is read across a wrapped footer', () => {
  const text = fixture('dialog-effort-v296-wrapped.txt');
  assert.match(text, /s for this\n\s*session only/);
  assert.equal(parseEffortDialog(text).sessionOnly, true);
});

/*
 * What commits. `s` writes nothing to disk; `Enter` writes a default for every new
 * session. Both measured on v2.1.296 against a hash of `~/.claude/settings.json`.
 */
test('the commit is `s` where the screen offers it, and `Enter` only where it does not', () => {
  assert.deepEqual(commitKey(parseEffortDialog(fixture('dialog-effort-v296.txt'))), {
    key: 's',
    scope: 'this session only',
  });
  assert.deepEqual(commitKey(parseEffortDialog(fixture('dialog-effort.txt'))), {
    key: 'Enter',
    scope: 'default for new sessions',
  });
});

test('nudging on the five-stop scale', () => {
  const low = parseEffortDialog(fixture('dialog-effort-v296-short.txt'));
  const max = parseEffortDialog(fixture('dialog-effort-v296-wrapped.txt'));
  assert.equal(nudgeToward(low, 'xhigh'), 'Right');
  assert.equal(nudgeToward(max, 'high'), 'Left');
  assert.equal(nudgeToward(max, 'max'), null);
  assert.throws(() => nudgeToward(max, 'ultracode'), /No such effort level/);
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
  for (const name of EFFORT_FIXTURES) {
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
