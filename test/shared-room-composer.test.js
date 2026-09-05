import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The shared room's `@` composer, and the contracts under it.
 *
 * Nothing here is a rendered check — whether the picker reads as a list of sessions rather
 * than a list of files, and whether the chip's hue is legible in both themes, is a pair of
 * eyes and the report carries those measurements. What a test can hold is the set of
 * contracts that would break **silently**, leaving a composer that looks entirely fine:
 *
 *  - The picker's rows come from the roster, filtered by an allow-list on role. Two sources
 *    for "who is here" is the `isLeadName` lesson, and a *negative* test ("not a worker")
 *    silently admits the next kind that gets added — `benchEntries`' own reasoning.
 *  - The request carries a session id, never a row's position.
 *  - A refusal is the **server's** sentence. Every one of them names something only the
 *    server can know — the character it found, the session that went away — and a paraphrase
 *    would lose exactly that.
 *  - Nothing is drawn locally on a successful send: the endpoint records the entry and the
 *    socket brings it back, so a local append would draw the maintainer's own message twice.
 *  - The shared room stays out of `composerSig`, which tears the composer down.
 *  - Every way out of the room saves the draft, and the composer's state lives inside
 *    `createPane` — a second pane is where module scope gets caught.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');

/*
 * The source with its prose taken out.
 *
 * Two of the checks below are *negative* — "the client never restates a server refusal",
 * "the client never reaches for a peer list" — and both of those phrases belong in the
 * comments that explain why. A negative assertion run over the raw file therefore fails on
 * the very sentences that record the rule, which is the wrong way round. Block comments and
 * whole-line `//` comments come out; nothing else does, and every positive assertion still
 * runs against the file as written.
 */
const code = app
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

const fn = (name) => {
  const m = app.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(m, `\`${name}\` must exist`);
  return m[0];
};

/* ----------------------------------------------------- the participants --- */

test('the picker is built from the roster, never from a peer list', () => {
  const rows = fn('sharedParticipants');
  assert.match(rows, /state\.sessions\.filter/);
  // `listPeers` is the local registry directory — the thing `ListAgents` prints, which on
  // this Mac carries dozens of offline Remote Control rows with no pane here at all. It is
  // for resolving a pid the observer met, never for enumerating who can be addressed.
  assert.ok(!/listPeers/.test(code), 'the client must not reach for a peer list at all');
  // And the popover draws whatever that function answers, rather than filtering again.
  assert.match(fn('sharedPickerRows'), /const rows = sharedParticipants\(\);/);
});

test('the participant test is an allow-list on role, in the server’s own words', () => {
  const rows = fn('sharedParticipants');
  assert.match(rows, /s\.team\?\.role == null \|\| s\.team\.role === 'lead'/);
  // The same shape as `server/observe.js`'s `participant`, which is the other end of the
  // room. Written as "not a worker" it would silently admit the next task kind — kinds have
  // already grown once in this repo (`plan` joined `build`).
  assert.ok(!/role !== 'worker'/.test(code), 'never a negative test on role');
  const observe = text('server/observe.js');
  assert.match(observe, /role == null \|\| row\.team\.role === 'lead'/);
  // A row with no live pane has nothing to type into, and the endpoint would refuse it.
  assert.match(rows, /s\.interactive/);
});

/* ----------------------------------------------------------- the target --- */

test('the request carries a session id, never a row’s position', () => {
  const send = fn('sendSharedMessage');
  assert.match(send, /body: JSON\.stringify\(\{ to: target\.id, text \}\)/);
  const picker = fn('renderSharedPicker');
  // The id rides on the node, so a roster frame landing between the paint and the click
  // cannot re-point the message at whoever moved into that row.
  assert.match(picker, /btn\.dataset\.id = s\.id;/);
  assert.match(picker, /btn\.onclick = \(\) => chooseSharedTarget\(s\.id\);/);
  // …and the choose looks the row up again rather than trusting what it was handed.
  assert.match(fn('chooseSharedTarget'), /sharedParticipants\(\)\.find\(\(s\) => s\.id === id\)/);
});

test('a rotated session id is followed by pane **and** name, never by pane alone', () => {
  const live = fn('sharedLiveTarget');
  // An unbound pane is `pane-3` in the roster and becomes its transcript's uuid the moment
  // one binds — which is the moment its first message lands. `/clear` does it again later.
  assert.match(live, /rows\.find\(\(s\) => s\.id === target\.id\)/);
  assert.match(
    live,
    /s\.paneId === target\.paneId && sharedTargetName\(s\) === target\.name/,
    'both witnesses, because a pane id can be reissued as %0 by a fresh tmux server',
  );
  // And the send re-points *before* it reads the id out, or the body carries the stale one.
  const send = fn('sendSharedMessage');
  const at = send.indexOf('sharedLiveTarget();');
  const read = send.indexOf('const target = view.sharedTarget;');
  assert.ok(at > -1 && read > at, 'the target is read after the re-point, never before');
});

/* --------------------------------------------------------- the refusals --- */

test('a refusal is the server’s own sentence', () => {
  const send = fn('sendSharedMessage');
  assert.match(send, /data\.error \|\| `That message was not sent \(\$\{res\.status\}\)\.`/);
  // The fallback is for a response with no body at all. Nothing else in the send path
  // writes a sentence about a refusal the server made.
  assert.ok(
    !/not live any more|is a worker|cannot contain/.test(code),
    'the client must not restate a server refusal — those sentences live in server/',
  );
  // Held in view state, never painted onto the node that was pressed: this box repaints
  // whenever a message arrives in the room.
  assert.match(send, /view\.sharedError = err\.message;/);
  assert.match(fn('renderSharedError'), /view\.sharedError/);
});

test('a refused body keeps its text, and nothing is ever stripped from it', () => {
  const send = fn('sendSharedMessage');
  // The value goes to the server as it was typed. No trim, no replace, no normalising —
  // a character that could make a quoted line draw as an unquoted one is refused *there*,
  // with the character named, and silently rewriting a body hands somebody a way to have
  // it rewritten into something else.
  assert.match(send, /const text = el\.ta\.value;/);
  assert.ok(!/\.replace\(/.test(send), 'the body is never rewritten on the way out');
  // Cleared only on success, inside the guard that checks this pane still holds the room.
  const cleared = send.slice(send.indexOf('view.sharedError = null;'));
  assert.match(cleared, /el\.ta\.value = '';/);
});

test('nothing is drawn locally on a successful send', () => {
  const send = fn('sendSharedMessage');
  // The endpoint records the entry and the store emits it, so the socket's `shared-append`
  // brings it back to this very pane. Appending here as well would draw the maintainer's
  // own message twice, delivery line and all, and the second copy would look as real.
  assert.ok(!/view\.shared\.push/.test(send), 'the send must not append to the room');
  assert.ok(!/renderShared\(\)/.test(send), 'nor repaint it — the socket frame does that');
  // …and that frame is what appends, one place, unchanged.
  assert.match(app, /if \(msg\.type === 'shared-append'\) \{[\s\S]*?view\.shared\.push\(msg\.entry\);/);
});

/* ------------------------------------------------------------- the keys --- */

test('Enter chooses while the picker is open, and only sends when it is not', () => {
  const keys = fn('onSharedKeyDown');
  const openBlock = keys.slice(keys.indexOf('if (view.sharedPick.open)'), keys.indexOf("if (e.key === 'Enter' && !e.shiftKey)"));
  assert.match(openBlock, /e\.key === 'Enter' \|\| e\.key === 'Tab'/);
  assert.match(openBlock, /chooseSharedTarget\(pick\.id\)/);
  // A reader who has typed `@al` and pressed Enter meant the highlighted row. Sending an
  // unaddressed message there is the one thing this box must never do.
  assert.ok(
    keys.indexOf('sendSharedMessage()') > keys.indexOf('closeSharedPicker({ muted: true })'),
    'the send is the last branch, under the picker’s own',
  );
});

test('an escaped picker stays escaped until a different `@`', () => {
  assert.match(fn('closeSharedPicker'), /if \(muted\) view\.sharedPick\.mutedAt = view\.sharedPick\.at;/);
  // Without it the very next keystroke re-detects the same `@` and reopens the popover the
  // reader just dismissed.
  assert.match(fn('syncSharedPicker'), /token\.at === view\.sharedPick\.mutedAt/);
});

test('an `@` counts at the start or after whitespace, and its token holds no whitespace', () => {
  const token = fn('sharedAtToken');
  assert.match(token, /if \(at > 0 && !\/\\s\/\.test\(upto\[at - 1\]\)\) return null;/);
  assert.match(token, /if \(\/\\s\/\.test\(query\)\) return null;/);
});

/* ----------------------------------------------------------- the drafts --- */

test('every way out of the room saves the half-written message and its target', () => {
  // `clearShared` is the one function all four exits go through — `leaveShared` for a pane
  // being given a session or a thread, `closeShared` for the way out, `close` for a slot
  // going away, `openShared` on the way in (where it writes nothing, there being no
  // composer). Saving anywhere else would mean finding all of them and keeping them in step.
  assert.match(fn('clearShared'), /^\s*function clearShared\(\) \{\n    saveSharedDraft\(\);/m);
  assert.match(app, /else if \(view\.kind === 'shared'\) saveSharedDraft\(\);/);
  // The target rides beside the text: a half-written message addressed to nobody is one
  // this composer refuses to send.
  const save = fn('saveSharedDraft');
  assert.match(save, /state\.drafts\[SHARED_DRAFT_KEY\] = text;/);
  assert.match(save, /state\.drafts\[SHARED_TARGET_KEY\] = JSON\.stringify\(view\.sharedTarget\);/);
});

test('a restored target is re-checked against the roster rather than believed', () => {
  const restore = fn('restoredSharedTarget');
  assert.match(restore, /rows\.find\(\(s\) => s\.id === saved\.id\)/);
  assert.match(restore, /s\.paneId === saved\.paneId && sharedTargetName\(s\) === saved\.name/);
  assert.match(restore, /return row \? sharedTargetOf\(row\) : null;/);
  // Hand-edited, or written by a version that stored something else.
  assert.match(restore, /catch \{\n      return null;/);
});

test('both draft keys are namespaced, like the thread’s', () => {
  // `state.drafts` is keyed by session id and nothing stops one being the literal string
  // `shared` — `linkDraftKey`'s reasoning, one shape along.
  assert.match(app, /const SHARED_DRAFT_KEY = 'shared:room';/);
  assert.match(app, /const SHARED_TARGET_KEY = 'shared:target';/);
});

/* ------------------------------------------------------- where it lives --- */

test('the shared room still never joins `composerSig`', () => {
  const sig = app.match(/const composerSig = \(s\)[\s\S]*?\.join\('\|'\);/)[0];
  for (const field of ['shared', 'sharedTarget', 'sharedPick', 'sharedError']) {
    assert.ok(!sig.includes(field), `\`${field}\` must not be in composerSig`);
  }
  // That signature tears the whole composer down when it changes, and a message arriving in
  // the room would take the textarea out from under whoever is typing.
});

test('every field the composer owns lives inside the pane factory', () => {
  const factory = app.slice(app.indexOf('function createPane('), app.indexOf('const api = {'));
  for (const field of ['sharedTarget:', 'sharedPick:', 'sharedError:', 'sharedBusy:']) {
    assert.ok(factory.includes(field), `${field} must be declared on the pane's own view`);
  }
  assert.match(factory, /let sharedComposerEl = null;/);
  // Split view means two panes at once, and module scope is where the second one gets
  // caught — the reason everything per-session already lives here.
  const outside = app.slice(0, app.indexOf('function createPane('));
  assert.ok(!/sharedComposerEl|sharedTarget/.test(outside), 'nothing composer-shaped in module scope');
});

test('the reach line rides the roster beat, because liveness is a roster fact', () => {
  const head = fn('renderHead');
  assert.match(head, /if \(view\.kind === 'shared'\) \{\n      renderSharedReach\(\);/);
  // An open popover is a live list of who can be addressed, so a session appearing or going
  // away has to move it too.
  assert.match(head, /if \(view\.sharedPick\.open\) renderSharedPicker\(\);/);
});

test('the composer is a sibling of `.shared-body`, not a child of it', () => {
  const pane = fn('renderSharedPane');
  assert.match(pane, /host\.append\(body\);[\s\S]*?host\.append\(buildSharedComposer\(\)\);/);
  // `.shared-body` is the positioned frame the `N new below` pill hangs off, so a composer
  // inside it would put that pill over the textarea instead of over the words it is about.
  assert.match(styles, /\.shared-body \{[^}]*position: relative;/);
  assert.match(styles, /\.shared-composer \{[^}]*position: relative;/);
  // Sizing needs the textarea in the document — `scrollHeight` is 0 before that.
  assert.match(pane, /sharedComposerEl\.autoGrow\(\);/);
});

test('`buildComposer` is still never called for a pane with no session', () => {
  const pane = fn('renderSharedPane');
  assert.ok(!/buildComposer\(/.test(pane), 'the session composer reads five fields that are all null here');
});

/* ------------------------------------------------------------ the words --- */

test('the placeholder says what `@` does here, because it means files one pane over', () => {
  const build = fn('buildSharedComposer');
  assert.match(build, /@session to pick who this goes to/);
  // And the picker's rows are visibly sessions — a status dot, a name, a folder — rather
  // than paths, so the two lists are not mistakable for each other at a glance.
  const picker = fn('renderSharedPicker');
  assert.match(picker, /dot \$\{s\.status\}/);
  assert.match(picker, /shared-picker-where/);
});

test('the composer says what a line typed here is', () => {
  // The same claim the envelope makes on the way out: these are the maintainer's own words
  // and a session may act on them.
  assert.match(fn('buildSharedComposer'), /your own words — the session may act on them/);
});
