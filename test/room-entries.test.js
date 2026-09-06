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
  // asks `roomMeta` rather than growing a second copy of the test.
  const node = app.match(/function roomEntryNode\(e, pending = \[\]\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(node, /if \(kind === 'link'\) card\.append\(roomMeta\(e\)\);/);
});

test('the project pill has a rule of its own, distinct from the lead’s', () => {
  // Filled rather than outlined, so a project reads as a different kind of speaker from the
  // accent-outlined lead at a glance. Deleting the rule and keeping the branch would draw an
  // unstyled pill, which is the failure this catches.
  assert.match(styles, /\.room-pill\.is-project \{/);
  assert.match(styles, /\.room-pill\.is-project\.is-human \{[^}]*var\(--accent\)/);
});
