import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePane, stripAgentPanel } from '../server/tmux.js';

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
 * Real captures from **two** Claude Code builds (the rest of this file is v2.1.232), each
 * taken by launching a scratch session into a directory Claude Code had never seen, at the
 * launcher's 220 columns and again at 70:
 *
 *   pane-trust-gate.txt / -narrow.txt                v2.1.257 — unnumbered, cursor on No
 *   pane-trust-gate-2.1.247.txt / -2.1.247-narrow.txt v2.1.247 — numbered, cursor on Yes
 *
 * Both are kept and both are read, because nothing in this repo pins which Claude Code is
 * installed. The v2.1.257 layout is what broke the panel's reading of this screen outright:
 * `OPTION_RE` in `server/permission.js` requires an `N.`, so `parsePrompt` returned null,
 * the gate arrived as a nameless `dialog`, and every reader of it — both cards and the
 * needs-you notification — went silent. `parseTrustGate` in `web/trust-gate.js` is the
 * fallback `parsePane` reaches for, and these tests pin that the two layouts come out the
 * same shape.
 *
 * The measurement also contradicts an older CLAUDE.md, which said the gate "parses as
 * `needs-decision` with **no** `prompt` behind it and `dialog` set". It does not, on either
 * build: a full `prompt` with two options and `dialog === null`. The `/exit` guard is
 * unaffected either way — `assertNotBlocked` refuses on `prompt` *or* `needs-decision`, and
 * here both are true — but anything that keys off "needs-decision with nothing behind it"
 * to detect an unanswerable box will not see this screen at all.
 *
 * These tests pin what was observed, not what was expected. If a later Claude Code
 * changes the screen, re-capture; do not adjust a parser to make them pass.
 */

const TRUST_GATE = [
  ['v2.1.257, 220 columns', 'pane-trust-gate.txt'],
  ['v2.1.257, 70 columns', 'pane-trust-gate-narrow.txt'],
  ['v2.1.247, 220 columns', 'pane-trust-gate-2.1.247.txt'],
  ['v2.1.247, 70 columns', 'pane-trust-gate-2.1.247-narrow.txt'],
];

for (const [width, file] of TRUST_GATE) {
  test(`the trust gate reads as a permission prompt, not a nameless dialog (${width})`, () => {
    const state = parsePane(fixture(file));
    assert.equal(state.state, 'needs-decision');
    assert.equal(state.dialog, null, 'no dialog title — the prompt parse wins outright');
    assert.ok(state.prompt, 'CLAUDE.md once said there is no prompt here; there is');
    assert.equal(state.prompt.title, 'Accessing workspace:');
    assert.equal(state.prompt.question, null);
    assert.equal(state.plan, null);
    assert.equal(state.question, null);
    // No composer, so no footer to scrape either.
    assert.equal(state.model, null);
    assert.equal(state.mode, null);
    assert.equal(state.bypass, null, 'unknown, not off — a box owns the mode line');
  });

  test(`the trust gate's two options are parsed with a cursor on exactly one (${width})`, () => {
    // Note what this means for anything drawing buttons off `prompt.options`: the trust row
    // is classed `approve` — a plain, unarmed yes as far as `classify` is concerned — and
    // pressing it grants Claude Code read, edit and execute on the folder. The card arms it
    // on its own account (`gateButton` in `web/trust-gate.js`), never on the `kind`.
    const { options } = parsePane(fixture(file)).prompt;
    assert.equal(options.length, 2);
    assert.deepEqual(options.map((o) => o.index), [1, 2]);
    assert.deepEqual(
      [...options].sort((a, b) => a.label.localeCompare(b.label)).map((o) => [o.label, o.kind]),
      [
        ['No, exit', 'deny'],
        ['Yes, I trust this folder', 'approve'],
      ],
      'the same two rows on both builds — only the order and the cursor moved',
    );
    assert.equal(options.filter((o) => o.selected).length, 1);
  });
}

test('v2.1.257 draws the gate unnumbered, with the cursor on No', () => {
  // The regression this whole fixture pair exists for, stated as the measurement it is.
  // A digit sent at this screen presses nothing; an Enter sent at it without moving the
  // cursor first *exits the session*.
  for (const file of ['pane-trust-gate.txt', 'pane-trust-gate-narrow.txt']) {
    const text = fixture(file);
    assert.doesNotMatch(text, /1\.\s*Yes, I trust this folder/, file);
    assert.match(text, /❯ No, exit/, file);
    const { options } = parsePane(text).prompt;
    assert.equal(options[0].label, 'No, exit', file);
    assert.equal(options[0].selected, true, file);
    assert.equal(options[1].label, 'Yes, I trust this folder', file);
  }
});

test('v2.1.247 draws it numbered, with the cursor on Yes', () => {
  for (const file of ['pane-trust-gate-2.1.247.txt', 'pane-trust-gate-2.1.247-narrow.txt']) {
    const text = fixture(file);
    assert.match(text, /❯ 1\. Yes, I trust this folder/, file);
    const { options, cursor } = parsePane(text).prompt;
    assert.equal(options[0].label, 'Yes, I trust this folder', file);
    assert.equal(cursor, 1, file);
  }
});

test('the trust gate fixtures keep the wording they were captured with', () => {
  // The screen no longer says "Do you trust the files in this folder?" — the phrase an
  // older CLAUDE.md and the mobile plan's §2.6 both quote. Any copy that names this gate
  // has to be written from these lines, not from that one.
  for (const [, file] of TRUST_GATE) {
    const text = fixture(file);
    assert.match(text, /Accessing workspace:/, file);
    assert.match(text, /Quick safety check: Is this a project you created or one you trust\?/, file);
    assert.doesNotMatch(text, /Do you trust the files in this folder/, file);
  }
});

test('the two widths agree on everything answerable and disagree only about the path', () => {
  // Pane width is an input to every parser here, so the divergence is pinned rather than
  // smoothed over. The workspace path is one line at 220 columns and three at 70, and the
  // body walk takes the first line under the title as `subject` — so at 70 the subject is a
  // *truncated* path and its remaining thirds land at the front of `detail`. Nothing that
  // answers the box is affected; anything that *displays* the folder is.
  const wide = parsePane(fixture('pane-trust-gate.txt')).prompt;
  const narrow = parsePane(fixture('pane-trust-gate-narrow.txt')).prompt;

  assert.deepEqual(narrow.options, wide.options);
  assert.equal(narrow.title, wide.title);

  assert.ok(wide.subject.endsWith('/alpha-trust-1'), 'whole path at 220 columns');
  assert.ok(!narrow.subject.endsWith('/alpha-trust-1'), 'cut mid-path at 70');
  assert.equal(wide.detail.length, 3);
  assert.equal(narrow.detail.length, 8, 'the path tail and the wrapped paragraph');
  assert.equal(narrow.detail[1], '-trust-1');
});

/*
 * Background activity, and the agent panel that broke the parser.
 *
 * Real captures from Claude Code v2.1.280, in the sandbox's `alpha` (and `beta` for the
 * bypass pair). The `pane-agents-*` panels come from two sessions created at 220×50 and
 * 80×23 and never resized, because a capture taken just after a resize can still be
 * mid-redraw — one batch was thrown away for exactly that. The 34-column, monitor and bypass
 * captures were resized to width and taken after the pane had settled, and read line by line.
 *
 * With background subagents running, Claude Code draws them in a panel *below* the composer,
 * and that panel pushed the footer and mode line out of every reader's window: at four
 * agents `mode`, `bypass`, `model` and `ctx` went null, at five the pane read as a `dialog`
 * titled with its own footer, and `assertNotBlocked` refused everything. At 80 columns the
 * footer's right-hand `/rc` slot can wrap onto a line of its own between the mode line and
 * the panel, which moved both breaks down by one — the `-narrow` fixtures for three and four
 * agents are exactly that shape, and are the ones that pin the anchor.
 */
const AGENT_PANEL = [
  // [fixture, agents, shells, monitors]
  ['pane-agents-3-narrow.txt', 3, 2, 1], // was idle with mode/bypass/model/ctx all null
  ['pane-agents-4.txt', 4, 3, 1], // was idle with mode/bypass/model/ctx all null
  ['pane-agents-4-narrow.txt', 4, 3, 1], // was `dialog`
  ['pane-agents-5.txt', 5, 3, 1], // was `dialog`
  ['pane-agents-5-narrow.txt', 5, 3, 1], // was `dialog`
  ['pane-agents-more.txt', 7, 5, 1], // was `dialog`
  ['pane-agents-more-narrow.txt', 7, 4, 1], // was `dialog`
];

test('an agent panel under the composer no longer reads as a dialog', () => {
  for (const [file, agents, shells, monitors] of AGENT_PANEL) {
    const text = fixture(file);
    assert.match(text, /^\s*⏺ main\s*$/m, `${file}: the panel is on screen`);
    const state = parsePane(text);
    assert.notEqual(state.state, 'dialog', file);
    assert.equal(state.dialog, null, file);
    assert.equal(state.mode, 'auto', file);
    assert.equal(state.bypass, false, file);
    assert.equal(state.model, 'Sonnet 5', file);
    assert.equal(typeof state.contextPct, 'number', file);
    assert.deepEqual(state.background, { agents, shells, monitors }, file);
  }
});

test('the 80-column shape: the `/rc` slot wrapped between the mode line and the panel', () => {
  for (const file of ['pane-agents-3-narrow.txt', 'pane-agents-4-narrow.txt']) {
    const lines = fixture(file).split('\n');
    const mode = lines.findIndex((l) => /⏵⏵ auto mode on/.test(l));
    assert.match(lines[mode + 1], /^\s+\/rc\s*$/, `${file}: the slot sits on its own line`);
    assert.match(lines[mode + 2], /^\s*$/, file);
    assert.match(lines[mode + 3], /^\s*⏺ main\s*$/, file);
  }
});

test('five rows and `↓ N more` count the hidden ones too', () => {
  for (const file of ['pane-agents-more.txt', 'pane-agents-more-narrow.txt']) {
    const text = fixture(file);
    assert.equal(text.match(/^\s*◯ /gm).length, 5, `${file}: the list caps at five rows`);
    assert.match(text, /^\s*↓ 2 more\s*$/m, file);
    assert.equal(parsePane(text).background.agents, 7, file);
  }
});

/*
 * `← 1 agent` is a navigation hint on every mode line of every session. It read `1` with
 * nothing running and `1` with seven agents running, and it is in every pane fixture this
 * file had before background activity existed — so reading it as a count would have lit the
 * rail's second dot on every row, permanently.
 */
test('`← 1 agent` is not an agent count', () => {
  for (const file of ['pane-idle.txt', 'pane-bypass.txt', 'pane-working.txt', 'pane-working-elapsed.txt']) {
    const text = fixture(file);
    assert.match(text, /← 1 agent/, `${file} carries the hint`);
    assert.deepEqual(parsePane(text).background, { agents: 0, shells: 0, monitors: 0 }, file);
  }
  // …and with seven agents really running, it still reads 1 on the line itself.
  assert.match(fixture('pane-agents-more.txt'), /· ← 1 agent/);
});

test('shells and monitors come off the mode line by name', () => {
  const cases = [
    ['pane-bg-monitor.txt', { agents: 0, shells: 0, monitors: 1 }],
    ['pane-bg-monitor-narrow.txt', { agents: 0, shells: 0, monitors: 1 }],
    ['pane-bg-bypass.txt', { agents: 0, shells: 2, monitors: 1 }],
  ];
  for (const [file, want] of cases) assert.deepEqual(parsePane(fixture(file)).background, want, file);

  // The same counts under bypass, which is nine characters longer and so cut earlier.
  const bypass = parsePane(fixture('pane-bg-bypass.txt'));
  assert.equal(bypass.bypass, true);
  assert.equal(bypass.mode, null, 'bypass is not a mode');
});

/*
 * Below ~44 columns (~52 under bypass) the counter segment is cut with no ellipsis — the
 * line simply ends. A count whose noun was cut off reads as absent: under-reported, never
 * invented.
 */
test('a count cut off before its noun reads as absent', () => {
  const narrow = fixture('pane-agents-cut-narrow.txt');
  assert.match(narrow, /⏵⏵ auto mode on · \d+ shells, 1\s*$/m, 'the monitor count lost its noun');
  const state = parsePane(narrow);
  assert.equal(state.state, 'idle', 'five agents at 34 columns, and still not a dialog');
  assert.equal(state.background.monitors, 0);
  assert.equal(state.background.agents, 5);

  const bypass = fixture('pane-bg-bypass-narrow.txt');
  assert.match(bypass, /⏵⏵ bypass permissions on · 2 shells, 1\s*$/m);
  assert.deepEqual(parsePane(bypass).background, { agents: 0, shells: 2, monitors: 0 });
});

test('a box hides the mode line, and that is unknown rather than none', () => {
  for (const file of ['prompt-bash.txt', 'dialog-model.txt', 'dialog-choice-single.txt', 'pane-trust-gate.txt']) {
    assert.equal(parsePane(fixture(file)).background, null, file);
  }
});

/*
 * The strip is anchored at both ends — last on screen, mode line directly above — because
 * `⏺` is also the transcript's reply glyph. These start from a real capture and change one
 * thing each, in the test, so the capture itself stays untouched.
 */
test('the panel is only stripped when it is the last thing on screen', () => {
  const real = fixture('pane-agents-5.txt').trimEnd();
  assert.equal(stripAgentPanel(real).agents, 5);
  const notLast = stripAgentPanel(`${real}\n  something drawn below it`);
  assert.equal(notLast.agents, 0);
  assert.equal(notLast.text, `${real}\n  something drawn below it`);
});

test('the panel is only stripped with the mode line directly above it', () => {
  const real = fixture('pane-agents-4-narrow.txt');
  // One slot line is allowed (that is the 80-column shape); a second line between is not.
  const twoLines = real.replace(/^(\s+\/rc\s*)$/m, '$1\n  another line');
  assert.equal(stripAgentPanel(twoLines).agents, 0);
  // Nor is a line carrying the footer's `|`, which the slot never does.
  const footerShaped = real.replace(/^\s+\/rc\s*$/m, '  alpha (main) | Sonnet 5');
  assert.equal(stripAgentPanel(footerShaped).agents, 0);
});
