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

test('the tip Claude Code draws inside the box does not become the subject', () => {
  // Real captures, v2.1.257, from a sandbox session in manual mode. Claude Code prints
  //
  //     Bash command
  //     Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
  //
  //       cat /private/tmp/permtip-probe.txt
  //
  // and the body walk took the first line under the title, so the tip won the subject slot
  // and the command was demoted into `detail` — on exactly the prompts that offer the
  // auto-mode row, which are exactly the prompts that grant something broad.
  for (const name of ['prompt-bash-tip.txt', 'prompt-bash-tip-narrow.txt']) {
    const p = parsePrompt(fixture(name));
    assert.ok(p, `${name}: should parse`);
    assert.equal(p.title, 'Bash command', name);
    assert.equal(p.subject, 'cat /private/tmp/permtip-probe.txt', `${name}: the command`);
    assert.deepEqual(p.detail, ['Print permtip-probe.txt contents'], name);
    // Not merely demoted — gone. The same sentence is already on the card, carried by
    // option 3, which is the button it is advice about.
    const flat = [p.title, p.subject, ...p.detail].join('\n');
    assert.ok(!/^Tip:/m.test(flat), `${name}: no tip anywhere in the body`);
    assert.match(p.options[2].label, /auto mode handles these prompts for you$/, name);
  }
});

test('…and the tip is dropped identically at 220 and 70 columns, where it wraps', () => {
  // At 70 the tip is two lines, flush at the title's own column, so a walk that dropped
  // only the line matching `Tip:` would leave `auto mode" below` as the subject — the
  // same defect one line down. Same lesson as the option-run join above, one field over.
  const wide = parsePrompt(fixture('prompt-bash-tip.txt'));
  const narrow = parsePrompt(fixture('prompt-bash-tip-narrow.txt'));
  assert.deepEqual(
    [narrow.title, narrow.subject, narrow.detail],
    [wide.title, wide.subject, wide.detail],
    'both widths spell one body',
  );
});

test('the capture the defect was reported from, fixed on that capture', () => {
  // `prompt-bash-broad{,-narrow}.txt` are the v2.1.247 captures the classifier work
  // committed; the tip was in them all along and read as the subject. Pinned here so the
  // fix is held against the screen it was found on, not only against a fresh one.
  for (const name of ['prompt-bash-broad.txt', 'prompt-bash-broad-narrow.txt']) {
    const p = parsePrompt(fixture(name));
    assert.equal(p.subject, 'cat /private/tmp/adu-perm-probe.txt', name);
    assert.deepEqual(p.detail, ['Read probe file'], name);
  }
});

test('a body line that is not a tip is never eaten as one', () => {
  // The rule has two independent stops, and the cost of getting either wrong is losing the
  // command from the card — so each is pinned on its own, with a control.
  const box = (...body) =>
    parsePrompt(
      [
        ' Bash command',
        ...body,
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        ' Esc to cancel',
      ].join('\n'),
    );

  // A blank line ends the block, however flush the subject sits.
  assert.equal(box(' Tip: auto mode handles these prompts', '', ' the command').subject, 'the command');
  // A deeper indent ends it, with no blank to help.
  assert.equal(box(' Tip: auto mode handles these prompts', '   the command').subject, 'the command');
  // The control for both: flush *and* unseparated is a wrap, and is dropped.
  assert.equal(box(' Tip: auto mode handles these', ' prompts for you', '', ' the command').subject, 'the command');
  // A line that merely mentions a tip mid-sentence is body text and stays.
  assert.equal(box(' Read the Tip: file').subject, 'Read the Tip: file');
  // And a box with no tip at all is untouched.
  assert.equal(box(' the command', ' what it does').subject, 'the command');
});

/* ------------------------------------------------ the Claude in Chrome box --- */

/*
 * Real captures, Claude Code v2.1.296, a sandbox alpha session in manual mode asking the
 * Chrome tools to act on a loopback bench page; every box was answered Deny in the terminal.
 * The box draws no question and no key-hint footer — its escape hint rides on the last
 * option — so before `ESC_ROW_RE` the parser returned null and the panel named it a dialog.
 */
// `-agents-80x23` was raised with two background subagents running: their list is drawn
// below the composer, never below this box, so `Deny (esc)` is still the last line.
const CHROME = [
  'prompt-chrome.txt',
  'prompt-chrome-80x23.txt',
  'prompt-chrome-narrow.txt',
  'prompt-chrome-agents-80x23.txt',
];
const CHROME_TWO = ['prompt-chrome-two.txt', 'prompt-chrome-two-80x23.txt', 'prompt-chrome-two-narrow.txt'];

test('the Chrome box with a page reads at 220, 80×23 and 70 columns', () => {
  for (const name of CHROME) {
    const p = parsePrompt(fixture(name));
    assert.ok(p, `${name}: should parse`);
    assert.equal(p.title, 'Claude in Chrome wants to navigate on 127.0.0.1:48796', name);
    assert.equal(p.subject, 'http://127.0.0.1:48796/', name);
    assert.deepEqual(p.detail, [], name);
    assert.equal(p.question, null, name);
    assert.equal(p.cursor, 1, name);
    assert.deepEqual(
      p.options.map((o) => [o.index, o.label, o.kind]),
      [
        [1, 'Allow', 'approve'],
        [2, 'Allow all actions on 127.0.0.1:48796 for this session', 'approve-always'],
        [3, 'Deny (esc)', 'deny'],
      ],
      name,
    );
  }
});

test('…and option 2 there is the broad yes, answered by its own digit', () => {
  // The option-2 trap in this box's vocabulary: the second row is a standing grant for
  // every action on the site, and deny is the third row's digit — never a position.
  for (const name of CHROME) {
    const p = parsePrompt(fixture(name));
    assert.equal(p.options[1].kind, 'approve-always', name);
    const deny = p.options.find((o) => o.kind === 'deny');
    assert.equal(keyForOption(p, deny.index), '3', name);
    assert.equal(keyForOption(p, 1), '1', name);
  }
});

test('the Chrome box with no page reads as Allow / Deny at every width', () => {
  for (const name of CHROME_TWO) {
    const p = parsePrompt(fixture(name));
    assert.ok(p, `${name}: should parse`);
    assert.equal(p.title, 'Claude in Chrome wants to create a browser window and read your tabs', name);
    assert.equal(p.subject, null, name);
    assert.equal(p.question, null, name);
    assert.deepEqual(
      p.options.map((o) => [o.index, o.label, o.kind]),
      [
        [1, 'Allow', 'approve'],
        [2, 'Deny (esc)', 'deny'],
      ],
      name,
    );
    assert.equal(keyForOption(p, 2), '2', name);
  }
});

test('a long host wraps the title and option 2 at 70 columns, and both rejoin', () => {
  const p = parsePrompt(fixture('prompt-chrome-wrapped.txt'));
  const host = 'a-long-bench-host-name-for-wrapping.localhost:48796';
  assert.ok(p, 'should parse');
  // Read the ordinary way the host became the subject and the URL slid into detail.
  assert.equal(p.title, `Claude in Chrome wants to navigate on ${host}`);
  assert.equal(p.subject, `http://${host}/`);
  assert.deepEqual(p.detail, []);
  assert.deepEqual(
    p.options.map((o) => [o.index, o.label, o.kind]),
    [
      [1, 'Allow', 'approve'],
      [2, `Allow all actions on ${host} for this session`, 'approve-always'],
      [3, 'Deny (esc)', 'deny'],
    ],
  );
});

test('the footer stand-in only counts as the very last line, and only as `Deny (esc)`', () => {
  const box = fixture('prompt-chrome-80x23.txt').trimEnd();
  assert.ok(parsePrompt(box), 'control: the box itself parses');

  // Answered and scrolled up: the composer is drawn below it.
  const answered = [
    box,
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  alpha (main) | Opus 5.5 | ctx: 5%',
    '  ⏸ manual mode on · ← 2 agents',
  ].join('\n');
  assert.equal(parsePrompt(answered), null, 'a box with anything below it is history');
  // One stray line under it is enough — a footer may sit in the last three, this may not.
  assert.equal(parsePrompt(`${box}\n  something else`), null);
  // A label that merely begins like it is not it.
  assert.equal(parsePrompt(box.replace('Deny (esc)', 'Deny (esc) and tell Claude why')), null);
  assert.equal(parsePrompt(box.replace('Deny (esc)', 'Deny')), null);
  // And the run rule still applies behind the new anchor: a gap in the digits refuses.
  assert.equal(parsePrompt(box.replace('2. Allow all', '4. Allow all')), null);
});

test('Allow and Deny are classified by the same structural rule as Yes and No', () => {
  const box = (...labels) =>
    parsePrompt(
      [
        ' Claude in Chrome wants to click on example.test',
        ...labels.map((l, n) => `${n === 0 ? ' ❯' : '  '} ${n + 1}. ${l}`),
      ].join('\n'),
    );
  const kinds = (...labels) => box(...labels).options.map((o) => o.kind);

  assert.deepEqual(kinds('Allow', 'Deny (esc)'), ['approve', 'deny']);
  // A qualified Allow is broad, phrase list or not — including one never met before.
  assert.deepEqual(kinds('Allow', 'Allow all actions on example.test for this session', 'Deny (esc)'), [
    'approve',
    'approve-always',
    'deny',
  ]);
  assert.deepEqual(kinds('Allow once more', 'Deny (esc)'), ['approve-always', 'deny']);
  // A word that only starts with the letters is not the word.
  assert.deepEqual(kinds('Allowance', 'Deny (esc)'), ['other', 'deny']);
});
