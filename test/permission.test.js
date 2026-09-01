import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePrompt, keyForOption } from '../server/permission.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

test('Bash command prompt', () => {
  const p = parsePrompt(fixture('prompt-bash.txt'));
  assert.ok(p, 'should parse');
  assert.equal(p.title, 'Bash command');
  assert.equal(p.subject, 'chmod 700 sample.txt');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.equal(p.options.length, 3);
  assert.equal(p.cursor, 1);

  assert.deepEqual(
    p.options.map((o) => [o.index, o.kind]),
    [
      [1, 'approve'],
      [2, 'approve-always'],
      [3, 'deny'],
    ],
  );
});

test('Edit file prompt, with its diff', () => {
  const p = parsePrompt(fixture('prompt-edit.txt'));
  assert.ok(p, 'should parse');
  assert.equal(p.title, 'Edit file');
  assert.equal(p.subject, 'sample.txt');
  assert.match(p.question, /Do you want to make this edit/);
  assert.equal(p.options.length, 3);
  assert.equal(p.options[2].kind, 'deny');
  assert.equal(p.options[2].index, 3);
});

test('the v1 defect: deny is option 3, not the second row', () => {
  // v1 sent `Down, Enter` for deny. That lands on option 2 — which in both real
  // prompts is a *broader* approval. This is the regression guard.
  for (const name of ['prompt-bash.txt', 'prompt-edit.txt']) {
    const p = parsePrompt(fixture(name));
    assert.equal(p.options[1].kind, 'approve-always', `${name}: option 2 approves`);
    const deny = p.options.find((o) => o.kind === 'deny');
    assert.equal(deny.index, 3, `${name}: deny is option 3`);
    assert.equal(keyForOption(p, deny.index), '3');
  }
});

test('trust dialog', () => {
  const text = [
    ' Quick safety check: Is this a project you created or one you trust?',
    " Claude Code'll be able to read, edit, and execute files here.",
    ' ❯ 1. Yes, I trust this folder',
    '   2. No, exit',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');
  const p = parsePrompt(text);
  assert.ok(p);
  assert.equal(p.options.length, 2);
  assert.equal(p.options[0].kind, 'approve');
  assert.equal(p.options[1].kind, 'deny');
  assert.equal(p.cursor, 1);
});

test('an idle pane is not a prompt', () => {
  const text = [
    '⏺ All 13 panes now report model and context.',
    '✻ Cooked for 31s',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
    '  Foreman | Opus 5 (1M context) | ctx: 14%',
    '  ⏵⏵ auto mode on · ← 1 agent',
  ].join('\n');
  assert.equal(parsePrompt(text), null);
});

test('an answered prompt scrolled into history is not a live prompt', () => {
  const text = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   3. No',
    ' Esc to cancel · Tab to amend',
    '⏺ Done.',
    '────────────────────────────',
    '❯ ',
    '  permtest | Opus 5 | ctx: 4%',
  ].join('\n');
  assert.equal(parsePrompt(text), null, 'footer must be near the bottom');
});

test('a numbered list in prose is not a prompt', () => {
  const text = [
    '⏺ Here are the steps:',
    '  1. Install the deps',
    '  2. Run the server',
    ' Esc to cancel',
  ].join('\n');
  const p = parsePrompt(text);
  // It may parse the shape, but must never invent a deny option.
  if (p) assert.ok(!p.options.some((o) => o.kind === 'deny'), 'no false deny');
});

test('keyForOption refuses an option that is not on screen', () => {
  const p = parsePrompt(fixture('prompt-bash.txt'));
  assert.equal(keyForOption(p, 9), null);
  assert.equal(keyForOption(null, 1), null);
});

test('question boxes stay off this parser, preview-panel layout included', () => {
  // A digit means "approve" here and "toggle"/"advance" there; the two must never mix.
  for (const file of [
    'dialog-choice-single.txt',
    'dialog-choice-multi.txt',
    'dialog-choice-review.txt',
    'dialog-choice-preview.txt',
  ]) {
    assert.equal(parsePrompt(fixture(file)), null, file);
  }
});

test('the box that offers two standing grants, at 220 columns', () => {
  // The defect this file's structural rule was written for. Real capture, v2.1.247:
  // option 2 grants a rule for a whole tree, option 3 turns prompting off for the
  // session, and the old five-phrase list called both of them a plain `Yes`.
  const p = parsePrompt(fixture('prompt-bash-broad.txt'));
  assert.ok(p, 'should parse');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.equal(p.cursor, 1);
  assert.deepEqual(
    p.options.map((o) => [o.index, o.kind]),
    [
      [1, 'approve'],
      [2, 'approve-always'],
      [3, 'approve-mode'],
      [4, 'deny'],
    ],
  );
  assert.equal(p.options[0].label, 'Yes');
  assert.match(p.options[1].label, /allow reading from \/private\/tmp from this project$/);
  assert.match(p.options[2].label, /^Yes, and switch to auto mode/);
});

test('…and the same box at 70 columns, where option 3 wraps', () => {
  // Pane width is an input to every parser here. Before the tail was joined this box
  // did not parse at all — the walk broke on `      for you`, the run came back one
  // option long, and the panel drew "the prompt could not be read".
  const wide = parsePrompt(fixture('prompt-bash-broad.txt'));
  const narrow = parsePrompt(fixture('prompt-bash-broad-narrow.txt'));
  assert.ok(narrow, 'narrow capture should parse');
  assert.deepEqual(
    narrow.options.map((o) => [o.index, o.label, o.kind]),
    wide.options.map((o) => [o.index, o.label, o.kind]),
    'a wrapped label rejoins to exactly the label the wide pane shows',
  );
  // …which is also what keeps `expectLabel` honest across a terminal being resized
  // between the render and the click.
});

test('a yes that qualifies itself is broader than this call, phrase list or not', () => {
  // The rule is structural: `Yes` alone is the only narrow approval. A yes wrongly
  // called broad costs one extra click; a yes wrongly called narrow is a standing
  // grant on one. So an unseen phrasing must land on the safe side by default.
  const box = (...labels) =>
    parsePrompt(
      [
        ' Bash command',
        ' Do you want to proceed?',
        ...labels.map((l, n) => `${n === 0 ? ' ❯' : '  '} ${n + 1}. ${l}`),
        ' Esc to cancel · Tab to amend',
      ].join('\n'),
    );

  const kinds = (...labels) => box(...labels).options.map((o) => o.kind);

  // Never met before, and still not a plain yes.
  assert.deepEqual(kinds('Yes', 'Yes, and remember that for the whole repo', 'No'), [
    'approve',
    'approve-always',
    'deny',
  ]);
  // A mode change is its own kind: it stops the asking rather than widening it.
  assert.deepEqual(kinds('Yes', 'Yes, and switch to accept edits mode', 'No'), [
    'approve',
    'approve-mode',
    'deny',
  ]);
  // The bare yes survives punctuation and a key hint.
  assert.deepEqual(kinds('Yes (y)', 'No'), ['approve', 'deny']);
});

test('nothing that was already broad has been narrowed to make room', () => {
  // The five phrases the old classifier knew still classify as they did — the structural
  // rule is a widening, and a widening that quietly demoted one of these would be worse
  // than the bug it fixes.
  for (const [name, index] of [
    ['prompt-bash.txt', 1],
    ['prompt-edit.txt', 1],
  ]) {
    const p = parsePrompt(fixture(name));
    assert.equal(p.options[index].kind, 'approve-always', `${name}: option 2 stays broad`);
  }
  // And the trust gate's carve-out: a qualified yes that is deliberately left alone,
  // because it is a different box and the panel does not answer it.
  const trust = parsePrompt(
    [
      ' Quick safety check: Is this a project you created or one you trust?',
      ' ❯ 1. Yes, I trust this folder',
      '   2. No, exit',
      ' Enter to confirm · Esc to cancel',
    ].join('\n'),
  );
  assert.equal(trust.options[0].kind, 'approve');
});

test('a tail that does not line up is not joined onto the option above it', () => {
  // The join is the one place this parser reads an unnumbered line as part of an option,
  // so it is held to alignment: a line indented less than the label it would extend is
  // body text, and a box we cannot line up is one we decline rather than guess at.
  const box = (stray) =>
    parsePrompt(
      [
        ' Bash command',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. Yes, and do something long', // label column 6
        stray,
        '   3. No',
        ' Esc to cancel',
      ].join('\n'),
    );

  // Indented past the floor but short of the label it would extend.
  assert.equal(box('    stray'), null, 'misaligned by two columns is still misaligned');
  // Not indented at all: body text, and the walk stops there as it always did.
  assert.equal(box('  stray'), null);
  // Aligned, and it joins — the control for both refusals above.
  const joined = box('      really long');
  assert.equal(joined.options.length, 3);
  assert.equal(joined.options[1].label, 'Yes, and do something long really long');
});
