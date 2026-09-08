import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The lead's aside — the column of section headings beside a lead's transcript.
 *
 * Only the two things about it that would break **silently** are pinned here. Nothing in
 * this file is a rendered check; whether a band is visible on a screen is a pair of eyes and
 * a computed contrast reading, and the report carries those.
 *
 *  - **The team room's heading names itself.** It was the bare word `room`, one of four
 *    lowercase labels in a column, and it is the one section a reader can look at but not
 *    type into. The heading is display text and nothing else: `room` is still the team
 *    room's word in every variable, pane kind, socket frame and tool name, which is the
 *    `group_*` naming decision's whole point, so a rename that reached the code would be
 *    the mistake this pins against.
 *  - **The band under that heading is a paint and nothing else.** `.tasks-grip` sits
 *    directly above it with `-4px / -3px` margins measured to land its hairline on the
 *    tasks block's own bottom rule, so a `border-top` on the heading is both a second
 *    hairline and a pixel of height, and the grip stops meeting what it was measured
 *    against. A background changes no metrics; that is the only reason this was safe to
 *    add. `.folder-label.in-group`'s hand-measured sticky offset is the rail's version of
 *    the same trap.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const tokens = text('web/tokens.css');

test('the team room’s section says what it is, and says it only on screen', () => {
  // Built by hand since the room grew its `clear` / `show all` control — the `section()`
  // helper this used to assert on is gone, and with it the last plain heading in the aside.
  // The contract is unchanged and is the reason this line moved rather than went: the room's
  // heading says what the room is, in those words, and says it on screen only.
  assert.match(app, /label\.textContent = 'Team room \(read only\)';/);
  // The hint sentence is unchanged — the heading was the ask, not the copy under it. It is
  // the heading's `title` now rather than the helper's second argument; same sentence, same
  // place a reader meets it.
  assert.match(app, /'Workers and the lead coordinate here\. View only — talk to the lead in the composer\.'/);

  // Display text only. Every one of these is the team room's word in code and none of them
  // moved: two spellings of a name is the `isLeadName` lesson, and this file's rename is
  // deliberately not one.
  for (const spelling of ["'room-append'", "'subscribe-room'", 'roomView', 'renderRoom', 'pinRoom']) {
    assert.ok(app.includes(spelling), `${spelling} must survive a display-only rename`);
  }
});

test('the heading’s band is a background and nothing else, because the grip is measured against its height', () => {
  const rule = styles.match(/\.room-head\.is-band \{[^}]*\}/);
  assert.ok(rule, '`.room-head.is-band` must exist');
  assert.match(rule[0], /background: var\(--band-head\);/);
  // Anything here that occupies space moves `.tasks-grip` off the rule it was measured to
  // land on — and nothing on screen would say so, which is why this is a test and not a
  // comment.
  for (const metric of ['border', 'padding', 'margin', 'height', 'font-size', 'line-height']) {
    assert.ok(!new RegExp(`${metric}`).test(rule[0]), `\`${metric}\` in this rule changes the heading's box`);
  }
  // The grip's own numbers, pinned beside it so a change to either is a change to a test.
  assert.match(styles, /\.tasks-grip \{[^}]*margin: -4px 0 -3px;/);
  // `has-controls` joined it with the slate button — TASKS' own line, and flex/gap only.
  // `is-band` is what this test is about and it is still there: the paint stays, the box
  // does not change, and the grip above still meets the rule it was measured to.
  assert.match(app, /head\.className = 'room-head is-band has-controls';/);
});

test('`--band-head` is a mix off the palette, so one line answers for both themes', () => {
  // The `--shelf` trick, one step deeper. A literal colour here would be defined for
  // whichever theme it was picked in and wrong in the other — the reason every tint in this
  // file is a `color-mix` rather than two hand-chosen values.
  assert.match(tokens, /--band-head: color-mix\(in srgb, var\(--ink\) 8%, var\(--surface\)\);/);
  // Not a second spelling of an existing tint: both places it is used sit next to something
  // already wearing `--shelf`, so reusing that would be invisible in one and mean "this is
  // an open group" in the other.
  assert.ok(!/--band-head:\s*var\(--shelf\)/.test(tokens));
});
