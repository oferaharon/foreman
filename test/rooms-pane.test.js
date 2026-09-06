import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveMember } from '../server/rooms-line.js';
import {
  addableSessions,
  addReason,
  entryKey,
  handedText,
  handedWaiting,
  memberKey,
  memberName,
  memberRow,
  roomOrdered,
} from '../web/rooms-pane.js';

/*
 * The group room's pane, its header and its composer.
 *
 * Two halves, because the pane is two halves. `web/rooms-pane.js` is a real module and is
 * driven for real here — the order, the resolution, the handed line and the add list, the
 * last of which is driven against `server/rooms-line.js`'s own resolver so the two rung
 * orders are held together by a test rather than by a comment. What lives in `web/app.js`
 * cannot be imported (it reaches for `document` at module scope and there is no browser
 * here), so the contracts on that side are held against the source the way every other web
 * test in this repo holds them.
 *
 * Nothing here is a rendered check. Whether the members strip is legible at rail width, or
 * whether seven hues tell four speakers apart, is a pair of eyes on a screen and the report
 * carries those. What a test can hold is the set of contracts that would break **silently**,
 * leaving a panel that looks entirely fine, and every one pinned here is of that kind:
 *
 *  - **The order.** `ts` is when a thing happened and `seq` is when it was written down, and
 *    they come apart here: a fan-out is serialised per room but the append happens *after*
 *    the typing, so a post that had four panes to reach is written after one that had none. A
 *    view that sorted on `seq` would put an answer above its question, occasionally, with
 *    nothing on screen to say why.
 *  - **Nothing is drawn locally on a send.** The socket brings the entry back to this very
 *    pane, so a local append would draw the maintainer's own message twice — with its handed
 *    line — and the second copy would look exactly as real as the first.
 *  - **The server's own sentence, verbatim.** Every refusal names the thing that is wrong;
 *    a paraphrase would be the panel's guess at a refusal it did not make.
 *  - **`armConfirm` in front of everything destructive.** Remove and archive; the
 *    maintainer's own ruling (#11).
 *  - **An archived room draws no composer at all.** The endpoint refuses a post with a 409,
 *    and a box that takes typing it cannot send is a control that lies about itself.
 *  - **Nothing about rooms joins `composerSig`.** That signature tears the whole composer
 *    down when it changes, and a message landing in a room would take the textarea out from
 *    under whoever is typing.
 *  - **`ws.onopen` re-subscribes the open room.** A subscription is server state and dies
 *    with the socket while the roster keeps arriving — a band that looks alive over a room
 *    that stopped, which is the one failure the panel cannot see from the inside.
 *  - **`group-*` frame names, never the team room's.** One word apart, doing different
 *    things: a frame under `room-append` with a `roomId` and no `repo` is one the team-room
 *    handler silently swallows.
 *  - **The word is `handed`, never *delivered*.** A queued copy may sit for hours and
 *    `queue.prune` may drop it; nothing writes back to an append-only log.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const pane = text('web/rooms-pane.js');

/**
 * The source with its prose taken out.
 *
 * Several checks below are *negative* — "`composerSig` knows nothing about rooms", "nothing
 * is appended locally" — and the phrases they forbid belong in the comments that record the
 * rule. A negative assertion run over the raw file therefore fails on the very sentences that
 * explain it, which is the wrong way round. `rooms-band.test.js` set this and it is the same
 * function.
 */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const code = strip(app);

/** One function out of `web/app.js`, by name, at the pane factory's indentation. */
const fn = (name) => {
  const m = app.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(m, `\`${name}\` must exist`);
  return m[0];
};

/* ------------------------------------------------------------ fixtures --- */

const row = (over = {}) => ({
  id: 'sess-1',
  label: 'alpha-main',
  title: 'alpha-main',
  project: 'alpha',
  paneId: '%1',
  paneCwd: '/sandbox/alpha',
  tmuxSession: 'foreman-alpha-main',
  status: 'idle',
  interactive: true,
  team: null,
  ...over,
});

const member = (over = {}) => ({
  tmuxSession: 'foreman-alpha-main',
  name: 'alpha-main',
  paneId: '%1',
  addedAt: 1,
  ...over,
});

const entry = (over = {}) => ({ seq: 1, ts: 1000, kind: 'peer', from: 'alpha-main', text: 'hi', handed: [], ...over });

/* --------------------------------------------------------------- order --- */

test('entries are ordered on `ts`, with `seq` only as the tie-break', () => {
  // Written out of order on purpose: the fan-out that had panes to reach is appended after
  // the one that had none, so `seq` and `ts` genuinely disagree here.
  const out = roomOrdered([
    entry({ seq: 1, ts: 3000, from: 'gamma-main' }),
    entry({ seq: 2, ts: 1000, from: 'alpha-main' }),
    entry({ seq: 3, ts: 2000, from: 'beta-main' }),
  ]);
  assert.deepEqual(
    out.map((e) => e.from),
    ['alpha-main', 'beta-main', 'gamma-main'],
  );
});

test('two entries inside one millisecond keep a stable order', () => {
  const out = roomOrdered([entry({ seq: 9, ts: 5 }), entry({ seq: 4, ts: 5 })]);
  assert.deepEqual(
    out.map((e) => e.seq),
    [4, 9],
    'without the tie-break they would swap places between paints',
  );
});

test('ordering never sorts the live array in place', () => {
  const live = [entry({ seq: 2, ts: 9 }), entry({ seq: 1, ts: 1 })];
  roomOrdered(live);
  assert.deepEqual(
    live.map((e) => e.seq),
    [2, 1],
    'the socket appends to this array; sorting it would reorder history under an append',
  );
});

test('a malformed frame draws nothing rather than throwing', () => {
  assert.deepEqual(roomOrdered(undefined), []);
  assert.deepEqual(roomOrdered(null), []);
  assert.deepEqual(roomOrdered('entries'), []);
  assert.deepEqual(roomOrdered([null, undefined]).length, 2);
});

test('the paint uses the ordered list, or the sort is decoration', () => {
  const paint = fn('renderGroup');
  assert.match(paint, /const entries = groupOrdered\(\);/);
  assert.ok(
    !/for \(const e of view\.groupEntries\)/.test(paint),
    'the paint must not walk the unsorted array',
  );
  // …and `groupOrdered` is the shared module rather than a second sort inlined here.
  assert.match(code, /const groupOrdered = \(\) => roomOrdered\(view\.groupEntries\);/);
});

test('an entry is keyed on its own `seq` across paints', () => {
  assert.equal(entryKey(entry({ seq: 7 })), '7');
  assert.equal(entryKey({}), '');
});

/* -------------------------------------------------- member resolution --- */

/*
 * The dot's resolution and the fan-out's are two functions in two languages of the same
 * runtime, and the whole risk is that they drift: a live dot beside a member the server will
 * record as unreachable, or the other way round. They are driven against each other here,
 * which is the only mechanism there is — the web module cannot import the server one (that
 * one pulls in `server/observe.js` and runs in node) and the server one cannot import the web
 * module for its own reasons.
 */
const AGREE = [
  {
    what: 'the tmux session name answers first',
    member: member(),
    rows: [row(), row({ id: 'sess-2', label: 'beta-main', tmuxSession: 'foreman-beta-main', paneId: '%2' })],
    expect: 'sess-1',
  },
  {
    what: 'a relaunched member is found by its tmux name under a new pane id',
    member: member({ paneId: '%9' }),
    rows: [row({ paneId: '%77' })],
    expect: 'sess-1',
  },
  {
    what: 'two panes under one tmux name need the exact pane id',
    member: member({ paneId: '%2' }),
    rows: [row(), row({ id: 'sess-2', paneId: '%2' })],
    expect: 'sess-2',
  },
  {
    what: 'two panes under one tmux name and no pane id declines rather than picking the first',
    member: member({ paneId: '' }),
    rows: [row(), row({ id: 'sess-2', paneId: '%2' })],
    expect: null,
  },
  {
    what: 'with no tmux name it takes the pane and the name together',
    member: member({ tmuxSession: '' }),
    rows: [row({ tmuxSession: 'something-else' })],
    expect: 'sess-1',
  },
  {
    what: '…and never the pane alone',
    member: member({ tmuxSession: '', name: 'someone-else' }),
    rows: [row({ tmuxSession: 'something-else' })],
    expect: null,
  },
  {
    what: '…and never the name alone',
    member: member({ tmuxSession: '', paneId: '' }),
    rows: [row({ tmuxSession: 'something-else' })],
    expect: null,
  },
  {
    what: 'a member with nothing live answers nothing',
    member: member(),
    rows: [],
    expect: null,
  },
];

for (const c of AGREE) {
  test(`the dot resolves a member exactly as the fan-out does — ${c.what}`, () => {
    const mine = memberRow(c.member, c.rows);
    const theirs = resolveMember(c.member, c.rows);
    assert.equal(mine?.id ?? null, c.expect);
    assert.equal(
      theirs.row?.id ?? null,
      c.expect,
      '`server/rooms-line.js` must answer the same, or a dot lies about who gets a copy',
    );
  });
}

test('the one deliberate divergence is the participant check, and it is only about a dot', () => {
  /*
   * `resolveMember` refuses a worker — that decides whether a copy is *typed*, and a worker's
   * channel is its lead. `memberRow` does not, because it decides only whether a chip draws a
   * live dot: a member that somehow became a worker should draw its real status rather than
   * vanish off the strip with nothing saying why, and the endpoint refuses it either way.
   */
  const worker = row({ team: { role: 'worker' } });
  assert.equal(memberRow(member(), [worker])?.id, 'sess-1');
  assert.equal(resolveMember(member(), [worker]).row, null);
  assert.equal(resolveMember(member(), [worker]).reason, 'not-a-participant');
  // A lead is a member on both sides — the allow-list, not "not a worker".
  const lead = row({ team: { role: 'lead' } });
  assert.equal(memberRow(member(), [lead])?.id, 'sess-1');
  assert.equal(resolveMember(member(), [lead]).row?.id, 'sess-1');
});

test('the strongest id is what travels as `remove`', () => {
  assert.equal(memberKey(member()), 'foreman-alpha-main');
  assert.equal(memberKey(member({ tmuxSession: '' })), '%1');
  assert.equal(memberKey(member({ tmuxSession: '', paneId: '' })), 'alpha-main');
  assert.equal(memberKey({}), '');
  // Never the label first: two sessions can share one, and `removeMember` takes the first
  // member that answers to the key.
  assert.notEqual(memberKey(member()), 'alpha-main');
});

test('a member is named by its stored name, then its ids, then something', () => {
  assert.equal(memberName(member()), 'alpha-main');
  assert.equal(memberName(member({ name: '' })), 'foreman-alpha-main');
  assert.equal(memberName(member({ name: '', tmuxSession: '' })), '%1');
  assert.equal(memberName({}), 'a session');
});

/* ------------------------------------------------------ the handed line --- */

test('the word is `handed`, and a queued or missed copy is not dressed as one', () => {
  const e = entry({
    handed: [
      { name: 'alpha-main', state: 'typed' },
      { name: 'beta-main', state: 'typed' },
      { name: 'gamma-main', state: 'queued' },
    ],
  });
  assert.equal(handedText(e), 'handed to alpha-main, beta-main · gamma-main queued');
  assert.ok(handedWaiting(e), 'anything not typed is still waiting');
});

test('an unreachable member is named as not reached, never as handed', () => {
  const e = entry({
    handed: [
      { name: 'alpha-main', state: 'typed' },
      { name: 'gamma-main', state: 'unreachable', reason: 'unknown' },
    ],
  });
  assert.equal(handedText(e), 'handed to alpha-main · gamma-main not reached');
  assert.ok(handedWaiting(e));
});

test('a state this version has never heard of reads as a miss, never as a success', () => {
  const e = entry({ handed: [{ name: 'alpha-main', state: 'teleported' }] });
  assert.equal(handedText(e), 'alpha-main not reached');
  assert.ok(handedWaiting(e));
});

test('a post with nobody to hand it to says so, and is not a failure', () => {
  const e = entry({ handed: [] });
  assert.equal(handedText(e), 'nobody else to hand it to');
  assert.equal(handedWaiting(e), false);
  assert.equal(handedText({}), 'nobody else to hand it to');
});

test('nothing in the pane ever calls a handed copy *delivered*', () => {
  /*
   * The plan's §5.4 and the shared room's own precedent: `sendOrQueue` types or queues, a
   * queued copy waits for a pane that may never come free, and `queue.prune` drops it
   * silently. The log records a handoff. The word is load-bearing and it is only ever one
   * careless edit away from being the friendlier, wrong one.
   */
  assert.ok(!/deliver/i.test(strip(pane)), '`web/rooms-pane.js` must not use the word');
  const node = fn('groupEntryNode');
  assert.ok(!/deliver/i.test(strip(node)), '`groupEntryNode` must not use the word');
  assert.match(strip(fn('groupEntryNode')), /handedText\(e\)/);
});

test('the handed line rides on every entry, not only the maintainer’s', () => {
  // A room fans out from whoever spoke, so a session's post has exactly the same question
  // hanging off it. The shared room's delivery line is on `human` entries only because only
  // the maintainer can send from there.
  const node = strip(fn('groupEntryNode'));
  const at = node.indexOf('handedText');
  assert.ok(at > 0);
  const before = node.slice(0, at);
  assert.ok(!/if \(human\)/.test(before.slice(before.lastIndexOf('bubble.append'))), 'not gated on `human`');
});

/* --------------------------------------------------------- who to add --- */

test('the add list is the participants minus the members, and it is a sort not a filter', () => {
  const rows = [
    row({ id: 'a', label: 'alpha-main', tmuxSession: 'foreman-alpha-main', paneId: '%1', paneCwd: '/s/alpha' }),
    row({ id: 'b', label: 'beta-main', tmuxSession: 'foreman-beta-main', paneId: '%2', paneCwd: '/s/beta' }),
    row({ id: 'g', label: 'gamma-main', tmuxSession: 'foreman-gamma-main', paneId: '%3', paneCwd: '/s/gamma' }),
  ];
  const room = { id: 'r1', members: [member()] };
  assert.deepEqual(
    addableSessions(rows, room).map((s) => s.id),
    ['b', 'g'],
    'a member is not offered again',
  );
  // Here first — and everything else still offered, one scroll down, or a cross-project room
  // would be impossible to build from the panel at all.
  assert.deepEqual(
    addableSessions(rows, room, '/s/gamma').map((s) => s.id),
    ['g', 'b'],
  );
});

test('a worker is never offered, and neither is a session with no live pane', () => {
  const rows = [
    row({ id: 'w', team: { role: 'worker' }, tmuxSession: 'foreman-w', paneId: '%8' }),
    row({ id: 'dead', interactive: false, tmuxSession: 'foreman-dead', paneId: '%9' }),
    row({ id: 'ok', tmuxSession: 'foreman-ok', paneId: '%7' }),
  ];
  assert.deepEqual(
    addableSessions(rows, { id: 'r', members: [] }).map((s) => s.id),
    ['ok'],
  );
});

test('a full room and an exhausted list each say why, in the room’s own words', () => {
  const members = Array.from({ length: 8 }, (_, i) => member({ tmuxSession: `t${i}`, name: `n${i}`, paneId: `%${i}` }));
  const full = addReason({ name: 'the checkout flow', members }, [], 8);
  assert.match(full, /already holds 8 sessions and the cap is 8/);
  assert.match(full, /about their panes, not about storage/, 'the create modal’s own sentence');

  const none = addReason({ name: 'r', members: [] }, []);
  assert.match(none, /already in this one/);
  assert.equal(addReason({ name: 'r', members: [] }, [row({ tmuxSession: 'x', paneId: '%4', label: 'z' })]), null);
});

/* --------------------------------------------------------- the header --- */

test('the tally is a line of its own, under the name, with the controls left on the name’s row', () => {
  /*
   * Two lines, and the thing worth pinning is *which* of them the buttons are on. The tally
   * grows as a room fills; while it shared `.head-meta` with `archive` and `close`, those
   * two were pushed leftwards by every message that arrived — a control at a different place
   * on a busy room than on a quiet one. A wrapping flex line fixes the name's ellipsis and
   * reintroduces exactly that, because a wrap takes the controls down with the tally.
   *
   * So: built as a child of the header rather than of `.head-meta` (or nothing has moved at
   * all, and the header looks identical while the tally is back beside the buttons), and the
   * grid rows are stated in the stylesheet — the tally on row 2 spanning to the right edge,
   * the controls pinned to row 1.
   */
  const build = fn('buildGroupHead');
  assert.match(build, /stat\.className = 'head-status group-status group-tally';/);
  assert.match(build, /head\.append\(stat\);/, 'the tally hangs off the header, not off `.head-meta`');
  assert.ok(!/meta\.append\(stat\)/.test(build), 'a tally inside `.head-meta` is back on the name’s line');

  assert.match(styles, /\.main-head\.is-group \{[^}]*display: grid;/);
  const tally = styles.slice(styles.indexOf('.main-head.is-group .group-tally {'));
  assert.match(tally.slice(0, tally.indexOf('}')), /grid-column: 2 \/ -1;[\s\S]*grid-row: 2;/);
  assert.match(styles, /\.main-head\.is-group \.head-meta \{ grid-column: 3; grid-row: 1; \}/);
  // `.main-head` and `.app.split .main-head` both set `gap` as a shorthand, so each of them
  // sets the row gap too — and the split one out-specifies a bare `.main-head.is-group`.
  // Without the second spelling the two lines fall 0.6rem apart in split view only.
  assert.match(styles, /\.app\.split \.main-head\.is-group \{ row-gap:/);

  // And the tally is still the same node `renderGroupHead` writes, so nothing about the
  // repaint changed with the line it sits on.
  assert.match(fn('renderGroupHead'), /els\.stat\.textContent = `\$\{n\} message/);
});

test('remove and archive both go through `armConfirm`', () => {
  const strip_ = fn('renderGroupStrip');
  assert.match(strip_, /armConfirm\(x, `remove \$\{memberName\(m\)\}\?`/);
  const head = fn('renderGroupHead');
  assert.match(head, /armConfirm\(btn, `archive/);
  // …and unarchiving does not, because it takes nothing away. The ruling names destructive
  // controls, not every control.
  assert.match(head, /btn\.onclick = \(\) => patchGroup\(\{ archived: false \}, btn\);/);
});

test('the archive control’s handler is re-bound every paint, not only when it is built', () => {
  /*
   * Found on the bench: the node is replaced only when the *word* on it changes (so an armed
   * confirmation is never taken away by an unrelated roster beat), and the first version bound
   * the handler in the same branch — so a room renamed while the pane was open still asked
   * *"archive “the old name”?"*. `patchBand` records this exact reason one column over: a
   * handler closing over a stale room record is the class of bug the reuse invites.
   */
  const head = fn('renderGroupHead');
  const built = head.indexOf('els.archive = btn;');
  const bound = head.indexOf('btn.onclick');
  assert.ok(built > 0 && bound > built, 'the handler must be bound after — and outside — the build branch');
  assert.match(head, /const btn = els\.archive;/);
});

test('the strip rebuilds only when the membership changes, and patches the dots', () => {
  /*
   * The chips carry `armConfirm` questions that live four seconds. The roster broadcasts
   * every couple of them and a status dot moves on its own, so a strip that rebuilt on the
   * beat would take a *confirmation to remove somebody* away from under the cursor about to
   * answer it. `connSig`'s idiom, and the signature deliberately has no status in it.
   */
  const strip_ = fn('renderGroupStrip');
  assert.match(strip_, /if \(sig !== groupStripSig\)/);
  assert.ok(!/status/.test(strip_.slice(strip_.indexOf('const sig'), strip_.indexOf('groupStripSig ='))));
  // The dots are written after the guard, on every call.
  const after = strip_.slice(strip_.indexOf('for (const m of members)', strip_.indexOf('groupStripSig =')));
  assert.match(after, /dot\.className = `dot \$\{row \? row\.status : 'gone'\}`/);
});

test('the strip’s signature is joined with real punctuation', () => {
  /*
   * `mergeSig`'s first version joined with what read in every editor as an empty string and
   * was three literal control bytes, so two different lists could spell one signature. The
   * band and the connections column both carry the fix and this is the third.
   */
  const strip_ = fn('renderGroupStrip');
  const sig = strip_.slice(strip_.indexOf('const sig = ['), strip_.indexOf("].join('#')"));
  assert.match(strip_, /\]\.join\('#'\)/);
  assert.match(sig, /\.join\('\|'\)/);
  assert.match(sig, /\.join\('~'\)/);
  // Nothing joined with an empty string anywhere in the room's own code.
  assert.ok(!/\.join\(''\)/.test(strip_));
});

test('a member the panel cannot find is faded, never dropped', () => {
  const strip_ = fn('renderGroupStrip');
  assert.match(strip_, /chip\.classList\.toggle\('is-gone', !row\)/);
  assert.match(styles, /\.group-chip\.is-gone \{/);
  // A chip that vanished would leave the panel disagreeing with the store about who is in
  // the room, silently — and the store is what the fan-out reads.
  assert.ok(!/members\.filter\(\(m\) => memberRow/.test(strip_));
});

test('a rename cancels on blur and commits on Enter', () => {
  const rename = fn('startGroupRename');
  assert.match(rename, /input\.onblur = \(\) => done\(false\);/);
  assert.match(rename, /if \(e\.key === 'Enter'\)[\s\S]*?done\(true\)/);
  assert.match(rename, /if \(e\.key === 'Escape'\)[\s\S]*?done\(false\)/);
  // And a repaint mid-edit must not put the heading back under the caret.
  assert.match(fn('renderGroupHead'), /if \(!view\.groupRenaming\) \{/);
});

test('every header press is a PATCH, and the server’s sentence is what a refusal says', () => {
  const patch = fn('patchGroup');
  assert.match(patch, /postJSONMethod\('PATCH', `\/api\/rooms\/\$\{encodeURIComponent\(id\)\}`, body\)/);
  assert.match(patch, /view\.groupHeadError = err\.message;/);
  // Held in view state, never painted onto the node that was pressed: the strip repaints on
  // the roster beat, so a sentence on a chip's ✕ would be in a detached tree in two seconds.
  assert.match(fn('renderGroupHeadError'), /view\.groupHeadError/);
});

/* ------------------------------------------------------- the composer --- */

test('an archived room draws no composer at all', () => {
  const paint = fn('renderGroupPane');
  assert.match(paint, /const archived = Boolean\(room\?\.archivedAt\);/);
  assert.match(paint, /if \(archived\) \{[\s\S]*?group-shut[\s\S]*?\} else \{[\s\S]*?buildGroupComposer\(\)/);
  // …and the pane is redrawn when a room is archived under it, because that changes the
  // pane's shape rather than its contents.
  assert.match(fn('renderGroupHead'), /Boolean\(room\.archivedAt\) !== view\.groupArchivedDrawn/);
});

test('the composer never goes through `buildComposer`', () => {
  /*
   * That function reads `s.prompt`, `s.plan`, `s.question`, `s.mode` and `s.model`, all null
   * at once with no session behind the pane, and `shortModel(null)` threw inside it once
   * already and unwound the whole build — no card, no textarea, and every later roster
   * broadcast throwing again. Three panes now have no session; not one of them may teach that
   * function to cope.
   */
  const build = fn('buildGroupComposer');
  assert.ok(!/buildComposer/.test(build));
  assert.match(fn('renderMain'), /if \(view\.kind === 'group-room'\) return renderGroupPane\(\);/);
});

test('the composer has one destination — no `@`, no target, no chip, no picker', () => {
  const build = strip(fn('buildGroupComposer'));
  for (const gone of ['sharedPick', 'groupTarget', 'picker', '@session']) {
    assert.ok(!build.includes(gone), `a room has one destination, so there is no ${gone}`);
  }
  const send = strip(fn('sendGroupMessage'));
  assert.ok(!/\bto\b:/.test(send), 'the room id is the destination');
});

test('the standing sentence says both halves of what a line typed here is', () => {
  const build = fn('buildGroupComposer');
  assert.match(build, /hint\.textContent = 'your own words, to every member — they may act on them';/);
  assert.match(build, /prefixed so no session can forge it/);
});

test('the send carries no `paneId`, which is the whole of who is speaking', () => {
  /*
   * The endpoint decides the speaker by what the request carries: a pane id means a session
   * posting through its own tool, nothing means the panel, and the panel is the maintainer.
   * There is no `speaker` field and there must never be one — it would be a one-word
   * promotion of a session's message to the human's word.
   */
  const send = fn('sendGroupMessage');
  assert.match(send, /body: JSON\.stringify\(\{ text \}\)/);
  assert.ok(!/paneId/.test(send));
  assert.ok(!/speaker/.test(send));
  assert.match(send, /`\/api\/rooms\/\$\{encodeURIComponent\(id\)\}\/post`/);
});

test('nothing is drawn locally on a successful send', () => {
  /*
   * The store emits the entry and the socket brings it back to this very pane, so a local
   * append would draw the maintainer's own message twice — with its handed line — and the
   * second copy would look exactly as real as the first.
   */
  const send = strip(fn('sendGroupMessage'));
  assert.ok(!/groupEntries\.push/.test(send));
  assert.ok(!/renderGroup\(\)/.test(send), 'the append frame is what repaints');
  // The one place anything is pushed is the frame handler.
  assert.match(code, /view\.groupEntries\.push\(msg\.entry\);/);
});

test('a refusal is the server’s own words, and the box keeps its text', () => {
  const send = fn('sendGroupMessage');
  assert.match(send, /throw new Error\(data\.error \|\| `That message was not sent \(\$\{res\.status\}\)\.`\)/);
  assert.match(send, /view\.groupError = err\.message;/);
  // Cleared only on success, and only if this pane is still holding this room.
  assert.match(send, /if \(view\.kind === 'group-room' && view\.groupRoom\?\.id === id && groupComposerEl === el\)/);
});

test('nothing client-side trims, escapes or normalises the body', () => {
  /*
   * A character that could make a quoted line draw as an unquoted one is refused *with the
   * character named*, by the endpoint, which is the only party that knows what its envelope
   * cannot survive. Silently rewriting somebody's input hands them a way to have it rewritten
   * into something else — and a second copy of that rule is the second spelling this repo
   * keeps learning not to have.
   */
  const send = fn('sendGroupMessage');
  assert.match(send, /const text = el\.ta\.value;/);
  assert.ok(!/\.replace\(/.test(send));
  assert.ok(!/text\.trim\(\),/.test(send), 'the trimmed value is tested, never sent');
});

/* --------------------------------------------------------- the paint --- */

test('the reader’s place is read before the swap, never after', () => {
  /*
   * `scrollTop` after `replaceChildren` is a forced layout on an emptied box, which clamps
   * the answer to zero before you have read it — the room aside's own bug, which put the
   * reader at the top of the list on every arriving line.
   */
  const paint = fn('renderGroup');
  const read = paint.indexOf('const held = el.wrap.scrollTop;');
  const swap = paint.indexOf('el.inner.replaceChildren()');
  assert.ok(read > 0 && swap > 0 && read < swap, '`scrollTop` must be read before the swap');
});

test('the clamp is measured in one pass and its control built only where it is needed', () => {
  /*
   * Interleaving a layout read with a class write per entry is a reflow per entry on a box
   * that repaints whenever a message arrives. And a control built for all and removed from
   * most was 66px of silent creep per incoming line, with no scroll event to notice it by.
   */
  const paint = fn('renderGroup');
  assert.match(paint, /for \(const c of clamps\) c\.overflows = c\.el\.scrollHeight > c\.el\.clientHeight \+ 1;/);
  assert.match(paint, /for \(const c of clamps\) applyGroupClamp\(c\);/);
  const apply = fn('applyGroupClamp');
  assert.match(apply, /if \(!c\.overflows\) \{[\s\S]*?return;/);
  assert.match(apply, /if \(!c\.btn\) \{/);
});

test('the clamp is ten lines and the standard `line-clamp` stays out', () => {
  const rule = styles.match(/\.group-clamp \{[\s\S]*?\}/)[0];
  assert.match(rule, /-webkit-line-clamp: 10;/);
  assert.ok(
    !/[^-]\bline-clamp: 10;/.test(rule),
    'Chrome answers `CSS.supports` false today, and `continue: discard` would remove the ' +
      'lines the overflow test compares — the control would stop appearing on exactly the ' +
      'messages that need it',
  );
});

test('the colour is on the pill and the bubble body is byte-identical whoever spoke', () => {
  const node = fn('groupEntryNode');
  assert.match(node, /who\.style\.color = `var\(--peer-\$\{colourFor\(name\)\}\)`/);
  assert.equal(node.match(/var\(--peer-/g).length, 1, 'one hue read in the whole function');
  const bubble = styles.match(/\n\.group-bubble \{[\s\S]*?\}/)[0];
  assert.ok(!/--peer-/.test(bubble));
});

test('the “new below” pill exists only while the reader is not following', () => {
  const hint = fn('updateGroupHint');
  assert.match(hint, /view\.groupFollow === false \? view\.groupUnseen \|\| 0 : 0/);
  // Floored where it is counted: a fresh frame can be *shorter* than the list it replaces.
  assert.match(fn('renderGroup'), /Math\.max\(0, entries\.length - before\)/);
});

test('following is an intention, and a resize’s own scroll event is swallowed', () => {
  const paint = fn('renderGroupPane');
  assert.match(paint, /if \(wrap\.clientHeight !== view\.groupFollowH\) \{/);
  assert.match(paint, /view\.groupFollow = wrap\.scrollHeight - wrap\.scrollTop - wrap\.clientHeight < 40;/);
});

test('the pill is anchored to a frame that is neither the scroller nor the pane', () => {
  assert.match(fn('renderGroupPane'), /body\.className = 'group-body';/);
  const body = styles.match(/\n\.group-body \{[\s\S]*?\}/)[0];
  assert.match(body, /position: relative;/);
  const hint = styles.match(/\n\.group-hint \{[\s\S]*?\}/)[0];
  assert.match(hint, /position: absolute;/);
});

/* ------------------------------------------------------ the plumbing --- */

test('the frames are `group-*`, never the team room’s `room-*`', () => {
  /*
   * One word apart, doing different things: `subscribe-room` / `room` / `room-append` are the
   * team room's and are keyed by `repo`, so a group frame arriving under one of them with a
   * `roomId` and no `repo` is a frame the team-room handler silently swallows.
   */
  for (const name of ['group-room', 'group-room-append', 'subscribe-group-room', 'unsubscribe-group-room', 'markGroupRoomRead']) {
    assert.ok(code.includes(`'${name}'`), `\`${name}\` must be the spelling`);
  }
  // Both group frames are checked against this pane holding *this* room.
  assert.match(code, /if \(view\.kind !== 'group-room' \|\| msg\.roomId !== view\.groupRoom\?\.id\) return;/);
  assert.match(
    code,
    /if \(view\.kind !== 'group-room' \|\| msg\.roomId !== view\.groupRoom\?\.id \|\| !msg\.entry\) return;/,
  );
});

test('a reconnect re-subscribes the open room, like every other open subscription', () => {
  /*
   * A subscription is server state and dies with the socket, while the roster keeps arriving
   * because that is broadcast to every client — so without this the band goes on drawing an
   * open room above a pane that silently stopped at the moment the connection dropped. It has
   * been shipped once already, in the transcript pane, and it is invisible from inside.
   */
  const re = fn('resubscribe');
  assert.match(re, /view\.kind === 'group-room' && view\.groupRoom\?\.id/);
  assert.match(re, /send\(\{ type: 'subscribe-group-room', roomId: view\.groupRoom\.id, slot \}\)/);
  // And `ws.onopen` is what calls it, for every pane.
  assert.match(code, /ws\.onopen = \(\) => \{[\s\S]*?for \(const pane of panes\) pane\.resubscribe\(\);/);
});

test('every way out of a room gives the subscription back', () => {
  // Given a session, a thread, the shared room or another room…
  assert.match(fn('leaveGroup'), /send\(\{ type: 'unsubscribe-group-room', slot \}\)/);
  for (const name of ['open', 'openLink', 'openShared']) {
    assert.match(fn(name), /leaveGroup\(\);/, `\`${name}\` must give it back`);
  }
  // …closed on purpose…
  assert.match(fn('closeGroup'), /send\(\{ type: 'unsubscribe-group-room', slot \}\)/);
  // …and the slot going away.
  assert.match(fn('close'), /if \(view\.kind === 'group-room'\) send\(\{ type: 'unsubscribe-group-room', slot \}\)/);
});

test('opening a room marks it read, and so does a line arriving at the bottom', () => {
  assert.match(fn('openGroup'), /send\(\{ type: 'markGroupRoomRead', roomId: id, slot \}\)/);
  assert.match(code, /if \(view\.groupFollow !== false\) markGroupSeen\(\);/);
  // …and only ever from the pane actually holding it.
  assert.match(fn('markGroupSeen'), /if \(view\.kind !== 'group-room' \|\| !view\.groupRoom\?\.id\) return;/);
});

test('a room replaces whatever non-session pane is open, and never takes focus', () => {
  const open = app.match(/\nfunction openGroupRoom\(id\) \{[\s\S]*?\n\}/)[0];
  assert.match(open, /if \(panes\.some\(\(p\) => p\.groupRoomId\(\) === id\)\) return;/);
  assert.match(open, /const holder = panes\.find\(\(p\) => p\.kind\(\) !== 'session'\);/);
  assert.match(open, /const keep = sessionPane\(\);\n  if \(keep\) setFocus\(keep\.slot\);/);
  assert.match(open, /openSplit\(\{ adopt: false, focus: false \}\)/);
});

test('the room is remembered as its own shape, and restored only if it is still there', () => {
  const remember = app.match(/\nfunction rememberOpenGroup\([\s\S]*?\n\}/)[0];
  assert.match(remember, /kind: 'group-room', room: roomId, autoSplit: Boolean\(autoSplit\)/);
  const adopt = fn('adopt');
  assert.match(adopt, /if \(last\?\.kind === 'group-room'\) \{/);
  assert.match(adopt, /if \(state\.rooms\.some\(\(r\) => r\?\.id === last\.room\)\) \{/);
  assert.match(adopt, /threadSplit = Boolean\(last\.autoSplit\);/);
  // A pane holding something that is not a session never adopts one.
  assert.match(adopt, /if \(view\.kind !== 'session'\) return;/);
});

test('a pane that can hold a session is asked by kind, and answers `selected` positively', () => {
  // Four kinds now, so a negative test would silently admit the fifth — `benchEntries`'
  // recorded reasoning, and the same shape `roomParticipants` is written in.
  assert.match(code, /selected: \(\) => \(view\.kind === 'session' \? view\.selected : null\),/);
  assert.match(code, /groupRoomId: \(\) => \(view\.kind === 'group-room' \? view\.groupRoom\?\.id \?\? null : null\),/);
  assert.match(app.match(/\nfunction sessionPane\(\) \{[\s\S]*?\n\}/)[0], /p\.kind\(\) === 'session'/);
});

test('a draft is kept per room, and never restored into a different one', () => {
  assert.match(code, /const groupDraftKey = \(id\) => `group:\$\{id\}`;/);
  assert.match(fn('buildGroupComposer'), /state\.drafts\[groupDraftKey\(view\.groupRoom\?\.id\)\]/);
  assert.match(fn('clearGroup'), /saveGroupDraft\(\);/);
});

test('nothing about rooms joins `composerSig`', () => {
  /*
   * That signature is what decides whether the whole composer is torn down and rebuilt, so a
   * message arriving in a room would take the textarea out from under whoever is typing. The
   * merge block, the connections band, the shared room and the rooms band are all outside it
   * and this is the fifth.
   */
  const sig = app.match(/const composerSig = [\s\S]*?\n  let lastComposerSig/)[0];
  assert.ok(!/room/i.test(sig), '`composerSig` must know nothing about rooms');
  assert.ok(!/group/i.test(sig));
});

test('the band’s open marker is asked of the panes, not held in module scope', () => {
  // Split view means two of them, and only a pane knows what it is holding.
  assert.match(code, /const openIds = panes\.map\(\(p\) => p\.groupRoomId\(\)\)\.filter\(Boolean\);/);
});

test('the create modal opens the room it just made', () => {
  assert.match(app, /if \(made\.room\?\.id\) openGroupRoom\(made\.room\.id\);/);
  // …into the pane a room belongs in, which is the module-scope function and not a pane's own
  // `openGroup` — the modal has no pane and must not pick one.
  assert.ok(!/openCreateRoom[\s\S]*?\.openGroup\(/.test(app));
});

/* ------------------------------------------------------------ the CSS --- */

test('the room pane borrows the shared room’s reasoning and none of its classes', () => {
  /*
   * `.shared-*` belongs to a feature whose future is explicitly deferred (the plan's Q5), and
   * a view quietly depending on its rules would come apart on the day that is answered, in a
   * stylesheet nobody was looking at. The same trade `.shared-*` itself made against
   * `.link-*`, paid a second time.
   */
  const paint = fn('renderGroupPane') + fn('buildGroupHead') + fn('groupEntryNode') + fn('buildGroupComposer');
  assert.ok(!/'shared-|`shared-| shared-/.test(paint), 'no `.shared-*` class in the room pane');
  assert.ok(!/'link-/.test(paint));
  for (const cls of ['.group-body', '.group-room', '.group-room-inner', '.group-msg', '.group-pill', '.group-bubble', '.group-handed', '.group-hint', '.group-composer', '.group-strip', '.group-chip', '.group-add-pop', '.group-shut']) {
    assert.ok(styles.includes(`${cls} {`) || styles.includes(`${cls},`), `${cls} must have a rule`);
  }
});

test('a member with no live pane draws a hollow dot rather than a colour', () => {
  // "No pane" is not a status the session is in — it is the absence of one, and `.dot.dialog`
  // uses the same shape for the same kind of reason.
  const rule = styles.match(/\n\.dot\.gone \{[\s\S]*?\}/)[0];
  assert.match(rule, /background: transparent;/);
  assert.match(rule, /border: 1px solid/);
});
