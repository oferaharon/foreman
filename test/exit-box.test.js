import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_BOX_TITLE, STOP_AND_EXIT, isExitBox, parseExitBox, stopAndExitOption } from '../server/exit-box.js';
import { parsePrompt } from '../server/permission.js';
import { parseQuestion } from '../server/question.js';
import { parsePlanPrompt } from '../server/plan.js';
import { parseModelConfirm, parseModelDialog, modelConfirmOpen, modelDialogOpen } from '../server/model.js';
import { parseEffortDialog } from '../server/effort.js';
import { parseTrustGate } from '../web/trust-gate.js';
import { parsePane } from '../server/tmux.js';
import { heldBy } from '../server/snapshot.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * The box `/exit` raises over running background work. All three captures are real
 * `capture-pane -p` output from Claude Code v2.1.296 in the sandbox's `alpha`, each taken in
 * a session created at the size it was captured at, never resized:
 *
 *   dialog-exit-background.txt          220×50, a background shell and a Monitor, cursor on 1
 *   dialog-exit-background-narrow.txt   80×23, a background shell, cursor on 1
 *   dialog-exit-background-cursor2.txt  220×50, the first box after one `Down`, cursor on 2
 */
const BOXES = ['dialog-exit-background.txt', 'dialog-exit-background-narrow.txt', 'dialog-exit-background-cursor2.txt'];

const ROWS = ['Exit and stop tasks', 'Move to background and exit', 'Stay'];

test('the box is read at both widths, with what it would stop', () => {
  const wide = parseExitBox(fixture('dialog-exit-background.txt'));
  assert.equal(wide.title, EXIT_BOX_TITLE);
  assert.deepEqual(wide.stopping, ['shell · sleep 600', 'monitor · wait for the marker file']);
  assert.deepEqual(wide.options.map((o) => o.label), ROWS);
  assert.equal(wide.cursor, 1);

  const narrow = parseExitBox(fixture('dialog-exit-background-narrow.txt'));
  assert.deepEqual(narrow.stopping, ['shell · sleep 600']);
  assert.deepEqual(narrow.options.map((o) => o.label), ROWS);
  assert.equal(narrow.cursor, 1);

  const moved = parseExitBox(fixture('dialog-exit-background-cursor2.txt'));
  assert.equal(moved.cursor, 2, 'the cursor is read off the pane, never assumed to start on 1');
  assert.equal(stopAndExitOption(moved).label, STOP_AND_EXIT);
  assert.equal(stopAndExitOption(moved).selected, false);
});

/* ---------------------------------------- six parsers, and they refuse each other --- */

test('every other screen parser refuses the box', () => {
  for (const name of BOXES) {
    const text = fixture(name);
    // The one that mattered: `parsePrompt` read this box as a permission prompt — three rows
    // drawn as one-tap buttons answered by digit, on a box where a digit commits.
    assert.equal(parsePrompt(text), null, `permission / ${name}`);
    assert.equal(parseQuestion(text), null, `question / ${name}`);
    assert.equal(parsePlanPrompt(text), null, `plan / ${name}`);
    assert.equal(parseModelDialog(text), null, `model / ${name}`);
    assert.equal(parseModelConfirm(text), null, `model confirm / ${name}`);
    assert.equal(modelDialogOpen(text), false, `model witness / ${name}`);
    assert.equal(modelConfirmOpen(text), false, `model confirm witness / ${name}`);
    assert.equal(parseEffortDialog(text), null, `effort / ${name}`);
    assert.equal(parseTrustGate(text), null, `trust gate / ${name}`);
  }
});

test('the box reader refuses every other committed capture', () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    if (!name.endsWith('.txt') || BOXES.includes(name)) continue;
    const text = fixture(name);
    assert.equal(parseExitBox(text), null, `reader / ${name}`);
    assert.equal(isExitBox(text), false, `witness / ${name}`);
  }
});

test('parsePane reads it as blocked, by name — never as a composer, never as a permission prompt', () => {
  for (const name of BOXES) {
    const pane = parsePane(fixture(name));
    assert.equal(pane.state, 'dialog', name);
    assert.equal(pane.dialog, EXIT_BOX_TITLE, name);
    assert.equal(pane.prompt, null, name);
    assert.equal(pane.question, null, name);
    assert.equal(pane.plan, null, name);
    // It used to say "a permission prompt" here (`docs/traps/launch.md`, the `/loop` trap):
    // blocked, under the wrong words.
    assert.equal(heldBy(pane), `“${EXIT_BOX_TITLE}” is open in its terminal`, name);
  }
});

/* --------------------------------------------------------- where the witness stops --- */

const lines = (name) => fixture(name).split('\n');
/** The wide capture with its rows replaced, everything else exactly as captured. */
const withRows = (rows) => {
  const out = [];
  let put = false;
  for (const l of lines('dialog-exit-background.txt')) {
    if (/^\s*(❯\s*)?\d\.\s/.test(l)) {
      if (!put) out.push(...rows);
      put = true;
      continue;
    }
    out.push(l);
  }
  return out.join('\n');
};

test('a box it can recognise but not answer is still refused by every other parser', () => {
  // A later Claude Code that renames the row: still this box, still nobody else's, and
  // still not answerable — the close Escapes it rather than guessing.
  const renamed = withRows(['  ❯ 1. Exit and stop all tasks', '    2. Move to background and exit', '    3. Stay']);
  assert.equal(isExitBox(renamed), true);
  assert.equal(stopAndExitOption(parseExitBox(renamed)), null);
  assert.equal(parsePrompt(renamed), null);

  // A label that wraps on a very narrow pane: the strict reader declines it, the witness
  // still knows the box.
  const wrapped = withRows(['  ❯ 1. Exit and stop tasks', '    2. Move to background', '       and exit', '    3. Stay']);
  assert.equal(parseExitBox(wrapped), null);
  assert.equal(isExitBox(wrapped), true);
  assert.equal(parsePrompt(wrapped), null);
  assert.equal(parsePane(wrapped).state, 'dialog');
});

test('a copy of the box in the scrollback does not vouch for the box drawn below it', () => {
  // The trust gate shares this box's footer word for word. A transcript that shows the
  // background-work box — a worker editing these very fixtures — and then lands on a gate
  // must still read as the gate.
  const exit = lines('dialog-exit-background.txt').filter((l) => l.trim()).slice(-9);
  const gate = fixture('pane-trust-gate-2.1.247.txt');
  const text = [...exit, '', '⏺ Read 1 file', '', gate].join('\n');
  assert.equal(isExitBox(text), false);
  assert.equal(parseExitBox(text), null);
  assert.ok(parsePrompt(text), 'the numbered gate still parses');
});

test('the cron box /exit raises is the same box, and is read the same way', () => {
  // `docs/traps/launch.md` (the `/loop` trap) recorded this list line under the same title,
  // rows and footer, with a cron live. Same reader, same answer.
  const text = lines('dialog-exit-background-narrow.txt')
    .map((l) => (l.trim() === 'shell · sleep 600' ? '  scheduled task · Every 30 minutes · check the build' : l))
    .join('\n');
  const box = parseExitBox(text);
  assert.deepEqual(box.stopping, ['scheduled task · Every 30 minutes · check the build']);
  assert.equal(stopAndExitOption(box).index, 1);
});

test('the box with its footer scrolled off, or its title missing, is not the box', () => {
  const noFooter = lines('dialog-exit-background.txt')
    .filter((l) => !/Enter to confirm/.test(l))
    .concat(['', '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on'])
    .join('\n');
  assert.equal(parseExitBox(noFooter), null);
  assert.equal(isExitBox(noFooter), false);

  const noTitle = lines('dialog-exit-background.txt').filter((l) => !/Background work is running/.test(l)).join('\n');
  assert.equal(parseExitBox(noTitle), null);
  assert.equal(isExitBox(noTitle), false);
});
