import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * How the team room draws one entry: the fold, and who a historical `kind: 'link'` line is
 * attributed to.
 *
 * These two contracts used to live in `test/link-thread.test.js`, beside the joint thread's
 * own. The thread was retired on 2026-09-05 and its tests went with it; these did not,
 * because neither is about links being a live feature:
 *
 *  - **The room's five-line fold**, and the standard `line-clamp` property staying *out* of
 *    it. Chrome answers `CSS.supports('line-clamp', '5')` with false today, so it is inert —
 *    and the shape it will eventually ship is `continue: discard`, which *removes* the
 *    clamped lines from the box rather than hiding them. The overflow test is
 *    `scrollHeight > clientHeight`; discard the lines and those two are equal, every entry
 *    reads as fitting, and the control silently stops appearing on exactly the entries that
 *    need it. Add the property the day it can be measured, not the day it parses.
 *  - **A `kind: 'link'` entry is attributed to the project that spoke.** Two dozen of them
 *    are on disk across four team rooms and nothing writes another. Both ends of a link were
 *    leads, so `from` is `'lead'` on every one of them — without this branch `roomMeta` falls
 *    back to `roomPill(e.from)` and every one of those lines goes back to reading as an
 *    anonymous `lead`, which is precisely the bug `roomLinkPill` was built to fix. It derives
 *    everything from the entry and depends on nothing that was removed, which is why it was
 *    kept when the rest of the feature went.
 *
 * Nothing here is a rendered check; whether a fold is the right length on a screen is a pair
 * of eyes and the report carries those. What is pinned is the set of contracts that would
 * break **silently**, leaving a panel that looks entirely fine.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const styles = text('web/styles.css');
const app = text('web/app.js');

/* ------------------------------------------------------------- the fold --- */

test('the room folds at five lines', () => {
  const room = styles.match(/\.room-clamp \{[\s\S]*?\}/)?.[0];
  assert.ok(room, '`.room-clamp` must exist');
  assert.match(room, /-webkit-line-clamp: 5;/);
  assert.match(room, /display: -webkit-box;/);
  assert.match(room, /-webkit-box-orient: vertical;/);
  assert.match(room, /overflow: hidden;/);
});

test('the standard `line-clamp` is not set beside the webkit one', () => {
  const rule = styles.match(/\.room-clamp \{[\s\S]*?\}/)[0];
  assert.doesNotMatch(rule, /(^|[^-])\bline-clamp:/m, '`.room-clamp` must not set the standard property');
});

/* ------------------------------------------------ the room’s attribution --- */

test('a historical link entry in the room is labelled with the project, not the generic `lead`', () => {
  assert.match(app, /function roomLinkPill\(e\) \{/);
  assert.match(app, /if \(e\.kind === 'link' && \(e\.sender \|\| e\.speaker === 'human'\)\)/);
  // The name is derived from the path the entry already carries, so lines written years
  // before anything read them are named too and an append-only log is never rewritten.
  const pill = app.match(/function roomLinkPill\(e\)[\s\S]*?\n  \}/)[0];
  assert.match(pill, /projectName\(e\.sender\)/);
  assert.match(pill, /p\.title = human \? .* : String\(e\.sender \|\| ''\)/);
  // The record is never asked for a name. (A prose mention of the field is fine — this is
  // about code, so the pattern is a property read.)
  assert.doesNotMatch(app, /\be\.senderName\b/, 'the name is derived, never a second field on the record');
  assert.doesNotMatch(text('server/index.js'), /senderName/, 'and the server never writes one');
});

test('`speaker` decides the shape, never the path', () => {
  // A human entry's `sender` is not a repo at all and has no basename to take. That is the
  // field's whole reason for existing, and the room must not work it out from the paths.
  const body = app.match(/function roomLinkPill\(e[\s\S]*?\n  \}/)[0];
  assert.match(body, /e\.speaker === 'human'/, 'it reads the field');
  assert.match(body, /human \? 'you' : projectName\(e\.sender\)/, 'and names the project otherwise');
});

test('the pill and the alert card both route through the one branch', () => {
  // A refused link message rode the alert card, and it is still one project's words —
  // knowing whose is exactly as useful there as on a delivered one, so `roomEntryNode`
  // asks `roomMeta` rather than growing a second copy of the test. Tier 3 widened that from
  // a link-only branch to *every* card on the tier: an alert now carries an author line
  // (`panel alert HH:MM`), which is the whole of what tells it apart from an escalation
  // sharing the same frame. The link case is subsumed rather than dropped.
  const node = app.match(/function roomEntryNode\(e, pending = \[\]\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(node, /if \(e\.alert \|\| kind === 'escalation'\)/, 'one card for both');
  assert.match(node, /card\.className = e\.alert \? 'room-alert' : 'room-escalation';/);
  assert.match(node, /card\.append\(roomMeta\(e\)\);/, 'and it is attributed');
});

test('the project pill has a rule of its own, distinct from the lead’s', () => {
  // Filled rather than outlined, so a project reads as a different kind of speaker from the
  // accent-outlined lead at a glance. Deleting the rule and keeping the branch would draw an
  // unstyled pill, which is the failure this catches.
  assert.match(styles, /\.room-pill\.is-project \{/);
  assert.match(styles, /\.room-pill\.is-project\.is-human \{[^}]*var\(--accent\)/);
});

/* -------------------------------------------------- tier 1: the keyword --- */

/*
 * `roomKeyword` is the one place a machinery line's word is decided, and the whole of its
 * contract is *what it is allowed to look at*. A dispatch and the `→ working` transition
 * that follows it are identical by `about` — both carry the task id — and identical by every
 * word a regex could match; only `event` separates them. The sentence is a message to a
 * human and will be reworded, and the day it is, a sentence-matched keyword turns off
 * silently and the room goes on looking entirely fine. That is the failure these pin.
 */

const keyword = (() => {
  const src = app.match(/function roomKeyword\(e\) \{[\s\S]*?\n  \}/)[0];
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return roomKeyword;`)();
})();

test('a machinery keyword is read off `event` and `kind`, never off the sentence', () => {
  assert.equal(keyword({ kind: 'system', event: 'dispatch', text: 'Worker x dispatched.' }), 'dispatch');
  assert.equal(keyword({ kind: 'conflict', text: 'Workers a and b are both touching web/app.js.' }), 'conflict');
  assert.equal(keyword({ kind: 'system', event: 'pending', text: 'Task x recorded as pending.' }), 'pending');
  // The one derived word: a refused check is the panel doing its job, not a decision taken.
  assert.equal(keyword({ kind: 'system', event: 'self-merge', allowed: true }), 'self-merge');
  assert.equal(keyword({ kind: 'system', event: 'self-merge', allowed: false }), 'merge-check');
});

test('the four server-stamped events come back as their own word, and take no colour', () => {
  // `closed`, `pr`, `started` and `model` are stamped at the source in `server/index.js` and
  // `server/watch.js` — the four commonest machinery shapes in this room, 543 lines between
  // them. There is deliberately no case for any of them in `roomKeyword`: it returns the
  // event verbatim, so a fifth stamp needs no client change at all.
  assert.equal(keyword({ kind: 'system', event: 'closed', text: 'Task x is done.' }), 'closed');
  assert.equal(keyword({ kind: 'system', event: 'pr', text: 'PR opened for x: …' }), 'pr');
  assert.equal(keyword({ kind: 'system', event: 'started', text: 'Worker x started working.' }), 'started');
  assert.equal(keyword({ kind: 'system', event: 'model', text: 'Worker x launched on …' }), 'model');

  // And none of the four is in the modifier list, so all four draw the plain gutter and a
  // muted keyword. A hue in this column means *look at this*; a task closing cleanly, a PR
  // opening and a worker starting are the opposite of that, and spending a colour on them
  // would cost the two that already mean something.
  const branch = app.match(/if \(kind === 'system' \|\| kind === 'conflict'\) \{[\s\S]*?is-plain'\);/)[0];
  for (const event of ['closed', 'pr', 'started', 'model']) {
    assert.doesNotMatch(branch, new RegExp(`e\\.event === '${event}'`), `${event} takes no modifier`);
  }
});

test('an `event`-less line gets no keyword, whatever its sentence says', () => {
  // 577 machinery lines in this repo's own room carry no `event` and never will — the log is
  // append-only. Stamping four of those shapes is an additive server change; guessing from
  // the text here is the thing the room's colour rule forbids.
  for (const text of [
    'Task phone-tabs-bar is done — merged and cleaned up.',
    'PR opened for phone-worker-lines: https://example.invalid/pull/117',
    'Worker phone-rooms started working.',
    'Worker phone-rooms launched on opus.',
    'dispatch conflict pending self-merge',
  ]) {
    assert.equal(keyword({ kind: 'system', text }), '', `no keyword for: ${text}`);
  }
});

/* --------------------------------------------- tier 2: one hue per speaker --- */

test('the room imports `colourFor` rather than carrying a second copy of the hash', () => {
  // Two spellings of one mapping is the `isLeadName` lesson: the same worker drawing two
  // different colours in two panes. The module is pure and node-tested; the panel must ask
  // it, at both ends of a `lead → [worker]` line.
  assert.match(app, /import \{ colourFor \} from '\.\/session-colour\.js';/);
  assert.doesNotMatch(app, /0x811c9dc5|FNV_PRIME/, 'no re-implementation of the hash');
  const pill = app.match(/function roomPill\(id, \{[\s\S]*?\n  \}/)[0];
  assert.match(pill, /var\(--peer-\$\{colourFor\(id\)\}\)/);
  assert.match(pill, /borderColor = 'currentColor'/);
  assert.match(pill, /if \(colour && !lead\)/, 'the lead is never given a ring hue');
});

test('one speaker name always folds to the same hue', async () => {
  const { colourFor, PEER_COLOUR_COUNT } = await import('../web/session-colour.js');
  for (const name of ['phone-tabs-bar', 'phone-worker-lines', 'room-ux-2-tiers', 'lead']) {
    const first = colourFor(name);
    assert.equal(colourFor(name), first, `${name} is stable within a run`);
    assert.ok(first >= 1 && first <= PEER_COLOUR_COUNT, `${name} lands in the ring`);
  }
  // The recipient pill and the speaker's own bubble pill are the same call on the same
  // string, which is what makes `lead → [worker]` recognisable as the worker three rows up.
  assert.equal(colourFor('phone-worker-lines'), colourFor('phone-worker-lines'));
  // Recorded slots, so a change to the hash is a failing test rather than a silent recolour
  // of every room and every pill in the panel. Sandbox names, for the usual reason.
  assert.deepEqual(['alpha', 'beta', 'gamma'].map(colourFor), [6, 5, 3]);
});

/* ---------------------------------------------------- the self-merge fold --- */

test('a self-merge’s checks start folded, keyed by seq', () => {
  // The room repaints in full on every incoming post, so an expanded fold that is not
  // remembered re-folds under the reader — worse than no fold at all. `roomView.expanded` is
  // the set the five-line clamp already uses; the key is distinct because one entry can
  // carry both.
  const fn = app.match(/function roomChecks\(e\) \{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /const key = `\$\{e\.seq\}:checks`;/);
  assert.match(fn, /if \(roomView\.expanded\.has\(key\)\) return list\(\);/, 'folded is the default');
  assert.match(fn, /checks ›/);
  assert.match(fn, /roomView\.expanded\.add\(key\)/);
});

test('the `.room-reasons` comment no longer argues against the code beside it', () => {
  // It used to say at length that the list is "not a hover and not a clamp". The maintainer
  // overturned that on 2026-09-08 having been shown the measurement, and a comment left
  // arguing against the code beside it is worse than no comment — this file is read for its
  // comments.
  const block = styles.match(/\/\*[^*]*What the verdict actually checked[\s\S]*?\.room-reasons \{/);
  assert.ok(block, 'the reasons list still explains itself');
  assert.match(block[0], /starts folded/, 'it says what the code now does');
  assert.match(block[0], /overturn/, 'and that the old decision was overturned, not overlooked');
  // The old sentence may still appear — quoted, as the thing being overturned. What must not
  // survive is it standing as this comment's own argument, which is what the two lines above
  // pin: a reader arriving at "not a hover and not a clamp" now meets "it argued" in front
  // of it.
  assert.doesNotMatch(block[0], /^\s*No bullet glyph[\s\S]*not a hover and not a clamp[^"]/m);
});

/* ------------------------------------------------------ the three tiers --- */

test('tier 1 is a gutter rule, not a frame', () => {
  // The 2026-08-26 attempt drew machinery as centred text between two hairlines: it read as
  // free text and it took the amber box off the conflict line, which was the part that
  // worked. The left gutter and its colour are what stop that reopening.
  const rule = styles.match(/\.room-system \{[\s\S]*?\}/)[0];
  assert.match(rule, /border-left: 2px solid var\(--mark\);/);
  assert.doesNotMatch(rule, /text-align: center/);
  assert.doesNotMatch(rule, /border-radius/, 'no frame');
  assert.match(styles, /\.room-system\.is-conflict \{ --mark: var\(--working\); \}/);
  assert.match(styles, /\.room-system\.is-dispatch \{ --mark: var\(--idle\); \}/);
  assert.match(styles, /\.room-system\.is-self-merge \{ --mark: var\(--accent\); \}/);
  assert.match(styles, /\.room-system\.is-pending \{ border-left-style: dashed; \}/);
});

test('an uncoloured keyword is muted ink, pending included', () => {
  // **The one place the room departs from the signed-off mock-up**, so it is pinned rather
  // than left to a comment somebody may tidy back. The mock-up scopes this rule to
  // `is-plain`, which leaves the word `pending` inheriting the gutter's `--rule-strong` —
  // measured on the rendered row in dark on `--shelf`, 1.47:1, the only text in the room
  // under AA, in the same change that evicts `--ink-faint` (3.17) for exactly that reason.
  // Ruled 2026-09-08: an uncoloured keyword is `--ink-muted` like every other uncoloured
  // keyword, and the dashed gutter stays the whole signal. Reverting this selector is a
  // silent contrast regression on one word, which is why it is a test and not a comment.
  const rule = styles.match(/\.room-system\.is-plain \.room-key,\n\.room-system\.is-pending \.room-key \{[^}]*\}/);
  assert.ok(rule, 'both uncoloured kinds take the keyword rule');
  assert.match(rule[0], /color: var\(--ink-muted\)/);
  // …and the dash is still the whole of what makes a pending line quieter.
  assert.match(styles, /\.room-system\.is-pending \{ border-left-style: dashed; \}/);
  const pending = styles.match(/\.room-system\.is-pending \{[^}]*\}/)[0];
  assert.doesNotMatch(pending, /--mark/, 'and it still spends no colour of its own');
});

test('tier 2 has no lane and no max-width', () => {
  // A lane is a two-sided idea and a team room is one lead, several workers and a reader who
  // is neither. Full width is what puts a bubble's outer edges on the same column the
  // machinery rows start and stop at.
  const rule = styles.match(/\n\.room-msg \{[^}]*\}/)[0];
  assert.match(rule, /align-self: stretch/);
  assert.match(rule, /max-width: 100%/);
  assert.doesNotMatch(styles, /\.room-msg\.from-lead \{ align-self: flex-end; \}/);
});

test('tier 3 is one card under two names', () => {
  // Red is a budget: an escalation and an alert share the frame and are told apart by the
  // author line they both now carry.
  assert.match(styles, /\.room-escalation, \.room-alert \{/);
  assert.match(styles, /\.room-tag\.is-loud \{ color: var\(--decision\); \}/);
});
