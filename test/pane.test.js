import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePane } from '../server/tmux.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/*
 * Every fixture here is a real `capture-pane` from Claude Code v2.1.232, not a
 * reconstruction. The whole point of this file is that the panel stops guessing at what
 * the TUI looks like — see CLAUDE.md, "verify against a scratch session".
 */

test('an idle session with its composer showing is idle', () => {
  const state = parsePane(fixture('pane-idle.txt'));
  assert.equal(state.state, 'idle');
  assert.equal(state.dialog, null);
  assert.equal(state.mode, 'manual');
  assert.equal(state.model, 'Opus 5 (1M context)');
});

test('a running session is working, not a dialog', () => {
  const state = parsePane(fixture('pane-working.txt'));
  assert.equal(state.state, 'working');
  assert.equal(state.dialog, null, 'the composer is still on screen while it works');
  assert.equal(state.activity, 'Orbiting');
  assert.equal(state.activitySeconds, 3);
});

/*
 * Real captures from a scratch session left running past the one-minute mark — the
 * `Xm Ys` shape only shows up once a turn runs long, which `pane-working.txt`'s 3s
 * spinner never exercises. Captured at both the launcher's 220 columns and a narrow
 * 70, since pane width is an input to every parser here.
 */
test('a working line past one minute parses "Xm Ys" into total seconds', () => {
  const state = parsePane(fixture('pane-working-elapsed.txt'));
  assert.equal(state.state, 'working');
  assert.equal(state.activity, 'Scampering');
  assert.equal(state.activitySeconds, 61);
});

test('the same holds at a narrow pane width', () => {
  const state = parsePane(fixture('pane-working-elapsed-narrow.txt'));
  assert.equal(state.state, 'working');
  assert.equal(state.activity, 'Working');
  assert.equal(state.activitySeconds, 60);
});

/*
 * The first spinner frame of a turn — `✶ Nebulizing…` with no parenthesised duration at
 * all — used to defeat ACTIVITY_RE outright, leaving `activity` null on a session the hook
 * reports as working. This is the same ~1.8s gap the `WORKING_RE` trap in CLAUDE.md already
 * documents; `state` reads `idle` here for that separately-tracked reason, but the activity
 * word must still come through.
 */
test('a bare spinner frame with no duration yet still yields the word', () => {
  const state = parsePane(fixture('pane-working-bare-activity.txt'));
  assert.equal(state.activity, 'Nebulizing');
  assert.equal(state.activitySeconds, null);
});

/*
 * The gap this closes: none of these are running anything and none of them are permission
 * boxes, so all four used to read as plain `idle` — and a message sent then is typed into
 * the picker, where the characters select options.
 */
for (const [name, file, title] of [
  ['/model', 'dialog-model.txt', 'Select model'],
  ['/effort', 'dialog-effort.txt', 'Effort'],
  ['/resume', 'dialog-resume.txt', 'Resume session'],
]) {
  test(`${name} reads as a dialog, not idle`, () => {
    const state = parsePane(fixture(file));
    assert.equal(state.state, 'dialog');
    assert.equal(state.dialog, title);
  });
}

/*
 * `AskUserQuestion` — Claude asking *you* to pick. A different shape from both the
 * permission box and the settings pickers, and the most dangerous of the three to type
 * into: the rows are checkboxes, so a stray Enter ticks one and a digit moves the cursor.
 * Neither submits, so nothing tells you it happened.
 */
test('a single-select question box is a dialog, named by its question', () => {
  const state = parsePane(fixture('dialog-choice-single.txt'));
  assert.equal(state.state, 'dialog');
  assert.equal(state.dialog, "What's your favourite colour?");
});

test('a multi-select question box is a dialog, named by its question', () => {
  const state = parsePane(fixture('dialog-choice-multi.txt'));
  assert.equal(state.state, 'dialog');
  assert.equal(state.dialog, 'Which fruits do you like?');
});

test('a question box is never mistaken for a permission prompt', () => {
  // It has numbered options and an "Esc to cancel" footer, so it looks the part. But its
  // last option sits below a rule of its own, which breaks the 1..N run — and that is the
  // only thing stopping the panel offering answer buttons that would tick a box instead
  // of answering. If this ever fails, do not "fix" it by loosening parsePrompt.
  for (const file of ['dialog-choice-single.txt', 'dialog-choice-multi.txt']) {
    assert.equal(parsePane(fixture(file)).prompt, null, file);
  }
});

test('the dialog name comes from inside the box, not the transcript above it', () => {
  // The multi-select fixture has an earlier question sitting in the scrollback
  // ("What's your favourite colour?"). Naming the open box after it would be a lie.
  const text = fixture('dialog-choice-multi.txt');
  assert.ok(text.includes("What's your favourite colour?"), 'fixture must keep the decoy');
  assert.equal(parsePane(text).dialog, 'Which fruits do you like?');
});

test('/config reads as a dialog even though its hint says "Esc to clear"', () => {
  // Not "cancel" — the hint wording varies per dialog, so detection can't key on one.
  const state = parsePane(fixture('dialog-config.txt'));
  assert.equal(state.state, 'dialog');
});

test('a dialog whose hint wraps onto a second line is still caught', () => {
  // /resume's hint is too long for the pane and breaks mid-sentence; only the tail of it
  // ("search · Esc to cancel") lands on the last line.
  const text = fixture('dialog-resume.txt');
  assert.ok(/Type to\n\s+search · Esc to cancel/.test(text), 'fixture must keep the wrap');
  assert.equal(parsePane(text).state, 'dialog');
});

test('a permission box is a decision, never a dialog', () => {
  // It matches the hint half — "Esc to cancel" — and has no composer either. The prompt
  // has to win, or the answer buttons would never be offered.
  const state = parsePane(fixture('prompt-bash.txt'));
  assert.equal(state.state, 'needs-decision');
  assert.equal(state.dialog, null);
  assert.equal(state.prompt.options.length, 3);
});

test('a dialog naming a model does not leak that into the header', () => {
  // The /model picker lists "Opus 5", "Sonnet 5", "Haiku 4.5" as options. Reading one of
  // those as the session's model would put a lie in the header.
  const state = parsePane(fixture('dialog-model.txt'));
  assert.equal(state.model, null);
  assert.equal(state.contextPct, null);
});

test('prompt-shaped text in the transcript is not a prompt', () => {
  // A session working in this very repo scrolls "Do you want to proceed?", a numbered
  // run of options and "Esc to cancel" through its pane every time it shows a diff of
  // the permission fixtures. The composer is drawn the whole time, and that is the only
  // thing that settles it: somewhere to type means nothing is waiting on an answer.
  const text = fixture('pane-prompt-shaped-text.txt');
  assert.match(text, /Do you want to proceed\?/, 'fixture must keep the bait');
  const s = parsePane(text);
  assert.equal(s.state, 'idle');
  assert.equal(s.prompt, null);
  assert.equal(s.dialog, null);
});

/*
 * Permission prompts off. Claude Code writes it on the same footer line as every other
 * mode — `⏵⏵ bypass permissions on` where the rest say `auto mode on` — so the panel reads
 * it from there rather than from the launch arguments in `ps`, which can only ever say how
 * a session started. `pane-bypass.txt` is a real capture of a session started with
 * `--dangerously-skip-permissions`.
 *
 * It is pointedly not one of `MODES`: that list is the shift+tab cycle `changeMode` steps
 * through, and a bypass entry in it would hand the panel a way to switch a session into
 * running without asking.
 */

test('a session with permission prompts off says so', () => {
  const state = parsePane(fixture('pane-bypass.txt'));
  assert.equal(state.bypass, true);
  assert.equal(state.state, 'idle');
  assert.equal(state.mode, null, 'bypass is not one of the modes shift+tab cycles');
  assert.equal(state.model, 'Opus 5 (1M context)');
});

test('an ordinary session says permission prompts are on', () => {
  assert.equal(parsePane(fixture('pane-idle.txt')).bypass, false);
  assert.equal(parsePane(fixture('pane-working.txt')).bypass, false);
});

/* Not the same as "off": with a box or a picker owning the footer there is no mode line
   to read, and the registry keeps its last answer rather than letting a session stop
   looking dangerous for as long as it spends asking you something. */
test('no mode line on screen is unknown, not off', () => {
  assert.equal(parsePane(fixture('dialog-model.txt')).bypass, null);
  assert.equal(parsePane(fixture('prompt-edit.txt')).bypass, null);
});

/*
 * ── The startup trust gate ───────────────────────────────────────────────────────────
 *
 * Real captures from Claude Code **v2.1.247** (the rest of this file is v2.1.232), taken
 * by launching a scratch session into a directory Claude Code had never seen, at the
 * launcher's 220 columns and again at 70. The gate was never answered — that is the
 * panel's standing stance and it is also the only way the state survives to be captured.
 *
 * The measurement contradicts CLAUDE.md, which says the gate "parses as `needs-decision`
 * with **no** `prompt` behind it and `dialog` set". It does not. On v2.1.247 it parses as
 * an ordinary permission box: a full `prompt` with two options and `dialog === null`. The
 * `/exit` guard is unaffected either way — `assertNotBlocked` refuses on `prompt` *or*
 * `needs-decision`, and here both are true — but anything that keys off "needs-decision
 * with nothing behind it" to detect an unanswerable box will not see this screen at all.
 *
 * These tests pin what was observed, not what was expected. If a later Claude Code
 * changes the screen, re-capture; do not adjust a parser to make them pass.
 */

const TRUST_GATE = [
  ['220 columns', 'pane-trust-gate.txt'],
  ['70 columns', 'pane-trust-gate-narrow.txt'],
];

for (const [width, file] of TRUST_GATE) {
  test(`the trust gate reads as a permission prompt, not a nameless dialog (${width})`, () => {
    const state = parsePane(fixture(file));
    assert.equal(state.state, 'needs-decision');
    assert.equal(state.dialog, null, 'no dialog title — the prompt parse wins outright');
    assert.ok(state.prompt, 'CLAUDE.md says there is no prompt here; there is');
    assert.equal(state.prompt.title, 'Accessing workspace:');
    assert.equal(state.prompt.question, null);
    assert.equal(state.prompt.cursor, 1);
    assert.equal(state.plan, null);
    assert.equal(state.question, null);
    // No composer, so no footer to scrape either.
    assert.equal(state.model, null);
    assert.equal(state.mode, null);
    assert.equal(state.bypass, null, 'unknown, not off — a box owns the mode line');
  });

  test(`the trust gate's two options are parsed with their own digits (${width})`, () => {
    // Note what this means for anything drawing buttons off `prompt.options`: option 1 is
    // classed `approve` — a plain, unarmed yes — and pressing it grants Claude Code read,
    // edit and execute on the folder. The panel deliberately never answers a security
    // gate; this is the shape it would have to refuse.
    const { options } = parsePane(fixture(file)).prompt;
    assert.equal(options.length, 2);
    assert.deepEqual(options[0], {
      index: 1,
      label: 'Yes, I trust this folder',
      kind: 'approve',
      selected: true,
    });
    assert.deepEqual(options[1], {
      index: 2,
      label: 'No, exit',
      kind: 'deny',
      selected: false,
    });
  });
}

test('the trust gate fixtures keep the v2.1.247 wording they were captured with', () => {
  // The screen no longer says "Do you trust the files in this folder?" — the phrase
  // CLAUDE.md and the mobile plan's §2.6 both quote. Any copy that names this gate has to
  // be written from these two lines, not from that one.
  for (const [, file] of TRUST_GATE) {
    const text = fixture(file);
    assert.match(text, /Accessing workspace:/, file);
    assert.match(text, /Quick safety check: Is this a project you created or one you trust\?/, file);
    assert.doesNotMatch(text, /Do you trust the files in this folder/, file);
  }
});

test('the two widths agree on everything answerable and disagree only about the path', () => {
  // Pane width is an input to every parser here, so the divergence is pinned rather than
  // smoothed over. The workspace path is one line at 220 columns and three at 70, and
  // `readOptionBlock` takes the first line under the title as `subject` — so at 70 the
  // subject is a *truncated* path and its remaining thirds land at the front of `detail`.
  // Nothing that answers the box is affected; anything that *displays* the folder is.
  const wide = parsePane(fixture('pane-trust-gate.txt')).prompt;
  const narrow = parsePane(fixture('pane-trust-gate-narrow.txt')).prompt;

  assert.deepEqual(narrow.options, wide.options);
  assert.equal(narrow.title, wide.title);

  assert.ok(wide.subject.endsWith('/trust-gate-fresh-5588'), 'whole path at 220 columns');
  assert.ok(!narrow.subject.endsWith('/trust-gate-fresh-5588'), 'cut mid-path at 70');
  assert.equal(wide.detail.length, 3);
  assert.equal(narrow.detail.length, 8, 'the path tail and the wrapped paragraph');
  assert.equal(narrow.detail[1], 'cratchpad/trust-gate-fresh-5588');
});
