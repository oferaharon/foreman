import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * How the joint thread and the room read, once two projects are talking.
 *
 * Nothing here is a rendered check — whether ten lines is the right fold, or whether the
 * green and the blue are told apart across a room, is a pair of eyes on a dark screen and
 * the report carries those measurements. What a test can hold is the set of contracts
 * underneath them, and every one pinned here is of the same kind: it would break
 * **silently**, leaving a panel that looks entirely fine.
 *
 * Four of them, and the reasoning for each is on its own test:
 *
 *  - The clamp's number, and the standard `line-clamp` property staying *out* — the room
 *    learned that one the hard way and this inherits both halves.
 *  - The clamp key carrying the repo as well as the seq. A joint thread is two rooms
 *    merged and `seq` is per repo (`server/room.js`), so the two sides collide constantly:
 *    a `seq`-only key opens somebody else's message. Measured on a real desynchronised
 *    pair, alpha and beta both at `seq: 12`.
 *  - The room's project name being *derived* from the path already on the entry, never a
 *    field the server writes. A `senderName` would be a second spelling of one fact (the
 *    `isLeadName` lesson) and would be absent from every line already on disk.
 *  - The two speaker colours: existing tokens, measurably apart, and the accent left alone
 *    because it is the maintainer's own colour in this same list.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const styles = text('web/styles.css');
const tokens = text('web/tokens.css');
const app = text('web/app.js');

/* ------------------------------------------------------------- the clamp --- */

test('the thread folds at ten lines — twice the room’s five, deliberately', () => {
  const thread = styles.match(/\.link-clamp \{[\s\S]*?\}/)?.[0];
  assert.ok(thread, '`.link-clamp` must exist');
  assert.match(thread, /-webkit-line-clamp: 10;/);
  assert.match(thread, /display: -webkit-box;/);
  assert.match(thread, /-webkit-box-orient: vertical;/);
  assert.match(thread, /overflow: hidden;/);
  // And the room stays at five. These are two numbers for two kinds of content — the room
  // logs events a line each, this is two leads writing paragraphs — so a later reader
  // "unifying" them would be undoing the maintainer's own call, not tidying.
  assert.match(styles.match(/\.room-clamp \{[\s\S]*?\}/)[0], /-webkit-line-clamp: 5;/);
});

test('the standard `line-clamp` is not set beside the webkit one', () => {
  /*
   * Chrome answers `CSS.supports('line-clamp', '10')` with false today, so it would be
   * inert — and the shape it will eventually ship is `continue: discard`, which *removes*
   * the clamped lines from the box rather than hiding them. The overflow test both clamps
   * rest on is `scrollHeight > clientHeight`; discard the lines and those two are equal,
   * every message reads as fitting, and the control silently stops appearing on exactly
   * the ones that need it. Add it the day it can be measured, not the day it parses.
   */
  for (const block of ['.link-clamp', '.room-clamp']) {
    const rule = styles.match(new RegExp(`\\${block} \\{[\\s\\S]*?\\}`))[0];
    assert.doesNotMatch(rule, /(^|[^-])\bline-clamp:/m, `${block} must not set the standard property`);
  }
});

test('a clamp candidate is keyed by repo AND seq, because a joint thread collides on seq', () => {
  // `seq` is per repo, so the two sides of one thread share values constantly — measured
  // on the bench with alpha and beta both landing on `seq: 12`. Keyed on `seq` alone,
  // opening one of those opens the other.
  assert.match(app, /const threadKey = \(e\) => `\$\{e\.repo \|\| ''\}:\$\{e\.seq \?\? ''\}`;/);
  assert.match(app, /pending\.push\(\{ key: threadKey\(e\), el, btn: null, overflows: false \}\)/);
  // …and it is keyed on the record, never the node: every child is replaced on every
  // paint, so a node's identity is gone by the next arriving message.
  assert.match(app, /view\.threadOpen\.has\(c\.key\)/);
  assert.match(app, /view\.threadOpen\.delete\(c\.key\)/);
});

test('the control is built only where a message actually overflows', () => {
  /*
   * The room's first draft built one per candidate and removed the ones that fit, and
   * every removal above the reader shrank the list under them — 66px of silent creep per
   * incoming line, with no scroll event to notice it by. So `threadClampable` marks and
   * registers and draws nothing, and `applyThreadClamp` returns before building anything
   * when the measurement says it fits.
   */
  const clampable = app.match(/function threadClampable\([\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(clampable, /createElement/, 'nothing may be drawn during the paint pass');

  const apply = app.match(/function applyThreadClamp\([\s\S]*?\n  \}/)[0];
  assert.match(apply, /if \(!c\.overflows\) \{[\s\S]*?return;/, 'a message that fits gets no control');
  const fits = apply.indexOf('if (!c.overflows)');
  const builds = apply.indexOf("createElement('button')");
  assert.ok(fits >= 0 && builds > fits, 'the button is built after the overflow test, never before');
});

test('the reader’s place is read before the swap and restored after the clamp pass', () => {
  /*
   * Two halves of one rule. Reading `scrollTop` after `replaceChildren` is a forced layout
   * on an emptied box, which clamps the answer to zero before you have read it — the
   * room's own bug, which put the reader at the top of the list on every arriving line.
   * And the restore has to land after the measurement, or the heights above them are still
   * settling when their offset goes back.
   */
  const render = app.match(/function renderThread\(\)[\s\S]*?\n  \}/)[0];
  const read = render.indexOf('const held = el.wrap.scrollTop;');
  const swap = render.indexOf('el.inner.replaceChildren(frag);');
  const measure = render.indexOf('c.overflows = c.el.scrollHeight');
  const restore = render.indexOf('el.wrap.scrollTop = held;');
  assert.ok(read >= 0 && swap > read, 'scrollTop is read before replaceChildren');
  assert.ok(measure > swap, 'nothing can be measured before it is in the document');
  assert.ok(restore > measure, 'the offset goes back after the heights are final');
  // One read pass over the whole batch, then one write pass. Interleaved, it is a reflow
  // per entry on a box that repaints whenever a message arrives.
  const applyAll = render.indexOf('applyThreadClamp(c)');
  assert.ok(applyAll > measure, 'measure every candidate before writing to any of them');
});

/* -------------------------------------------------- the room’s attribution --- */

test('a link entry in the room is labelled with the project, not the generic `lead`', () => {
  assert.match(app, /function roomLinkPill\(e\) \{/);
  assert.match(app, /if \(e\.kind === 'link' && \(e\.sender \|\| e\.speaker === 'human'\)\)/);
  // The name is derived from the path the entry already carries, using the one function
  // the joint thread's own pill uses — so the two readers of one entry cannot disagree
  // about who spoke, and lines written before this existed are named too.
  const pill = app.match(/function roomLinkPill\(e\)[\s\S]*?\n  \}/)[0];
  assert.match(pill, /projectName\(e\.sender\)/);
  assert.match(pill, /p\.title = human \? .* : String\(e\.sender \|\| ''\)/);
  // Two projects can share a basename, so the full path has to be somewhere — and the
  // hover is where every other face in this feature puts it.
  // The record is never asked for a name. (A prose mention of the field is fine — this is
  // about code, so the pattern is a property read.)
  assert.doesNotMatch(app, /\be\.senderName\b/, 'the name is derived, never a second field on the record');
  assert.doesNotMatch(text('server/index.js'), /senderName/, 'and the server never writes one');
});

test('`speaker` decides the shape, never the path — in both readers, identically', () => {
  // A human entry's `sender` is not a repo at all and has no basename to take. That is the
  // field's whole reason for existing (plan §3d), and the room must not work it out from
  // the paths any more than the thread does.
  for (const fn of ['roomLinkPill', 'linkEntryNode']) {
    const body = app.match(new RegExp(`function ${fn}\\(e[\\s\\S]*?\\n  \\}`))[0];
    assert.match(body, /e\.speaker === 'human'/, `${fn} reads the field`);
    assert.match(body, /human \? 'you' : projectName\(e\.sender\)/, `${fn} names the project otherwise`);
  }
});

/* ------------------------------------------------- the relaunch sentence --- */

test('no live surface asks for a relaunch, and there is no constant left to render', () => {
  /*
   * The sentence was composed once in the link-create endpoint and rendered in three
   * places: the room line, the connect form's fine print, and the toast after the press.
   * All three are gone. It was only true of a lead launched *before* the link tools
   * shipped — one started now has `link_list` / `link_send` / `link_read` from birth and
   * resolves a link at the moment it uses one — and it carried no expiry, so it was
   * permanent noise on every link anybody would ever make.
   *
   * Removed rather than softened into a conditional, which is the approved plan's decision
   * 3 rather than a preference: the panel cannot tell what a running lead was launched
   * with, and the plan refused to build a detector because a stamped tools-version
   * compared at run time is a second source of truth about a running process.
   *
   * Whole mechanism, not one rendering — so this pins that the constant itself is gone
   * too. A dead `RELAUNCH_NOTE` sitting there is an invitation to render it again.
   */
  // Patterns are *code* shapes, not the bare word: the comment left where the constant
  // used to be names it, on purpose, so nobody reintroduces it without reading why.
  assert.doesNotMatch(app, /const RELAUNCH_NOTE\b/, 'no orphan constant left declared');
  assert.doesNotMatch(app, /\$\{RELAUNCH_NOTE\}/, 'nothing interpolates it');
  assert.doesNotMatch(app, /=\s*RELAUNCH_NOTE\s*;/, 'nothing assigns it into a node');
  assert.doesNotMatch(app, /'Both leads need one relaunch/, 'and no inlined copy of it');
  // The node is removed rather than emptied: a `.conn-form-note` with no text still takes
  // its line-height, and a gap under the button is a thing a reader looks for a reason for.
  const form = app.match(/const foot = document\.createElement\('div'\)[\s\S]*?renderConnect/)?.[0] ?? app;
  assert.doesNotMatch(form, /note\.textContent/, 'the fine-print node is gone, not blanked');
  // `server/index.js` keeps exactly one copy, in the `decisions.md` block — a dated record
  // of what was true when the link was opened, which is not a live surface.
  const server = text('server/index.js');
  const hits = [...server.matchAll(/Both leads need one relaunch/g)];
  assert.equal(hits.length, 1, 'one copy only, and it is the decisions.md block');
  assert.ok(
    server.slice(0, hits[0].index).lastIndexOf('appendDecision') >
      server.slice(0, hits[0].index).lastIndexOf('room.post'),
    'the surviving copy is inside the decisions.md append, not a room post',
  );
});

/* ------------------------------------------------------- speaker colours --- */

/** The dark palette — the only one this project renders. Read, never restated. */
function darkTokens() {
  const block = tokens.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\}/)[1];
  const out = {};
  for (const [, k, v] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}

const srgb = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(srgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** CIE L*a*b*, D65 — enough for "are these two obviously different colours". */
const lab = (hex) => {
  const [r, g, b] = rgb(hex).map(srgb);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

test('the two speaker colours are existing tokens, on the header only', () => {
  assert.match(styles, /\.link-msg\.from-a \.link-pill \{ color: var\(--idle\);/);
  assert.match(styles, /\.link-msg\.from-b \.link-pill \{ color: var\(--mode-edits\);/);
  // The bubble body is untouched, and that is the maintainer's own correction of an
  // earlier coloured-bubbles suggestion. Two tinted bodies in one column would be two
  // competing page backgrounds rather than two labels.
  assert.doesNotMatch(styles, /\.link-msg\.from-[ab] \.link-bubble \{[^}]*background/);
});

test('the accent stays the maintainer’s own colour in this list', () => {
  // Item 7 puts his lines here beside these two. Two identical pills in one thread, one of
  // them the one speaker whose word can authorize, is not a trade worth a few ΔE.
  assert.match(styles, /\.link-pill\.is-human \{ color: var\(--accent\);/);
  // `indexOf` on the bare selector would find this rule's own explanatory comment above
  // the lanes, so both anchors are the rules themselves.
  const human = styles.indexOf('.link-pill.is-human { color: var(--accent);');
  const lanes = styles.indexOf('.link-msg.from-b .link-pill { color: var(--mode-edits);');
  assert.ok(human > lanes, 'the human rule is last, so a renamed lane cannot outrank it');
});

test('the pair clears AAA on the pane it sits on, and is far apart from itself', () => {
  const t = darkTokens();
  // The name pill sits above the bubble, so its background is the pane's own ground.
  for (const name of ['--idle', '--mode-edits']) {
    const ratio = contrast(t[name], t['--ground']);
    assert.ok(ratio >= 7, `${name} is ${ratio.toFixed(2)}:1 on --ground — AAA wants 7:1`);
  }
  // Two labels a reader is meant to tell apart mid-scroll. 20 is far past "noticeably
  // different"; the measured pair is ~23. This is the guard for a later retune of either
  // token quietly collapsing them into one colour.
  const apart = deltaE(t['--idle'], t['--mode-edits']);
  assert.ok(apart >= 20, `--idle and --mode-edits are ΔE ${apart.toFixed(1)} apart — too close to tell`);
});

test('which project is which is stable, and nothing is stored to make it so', () => {
  /*
   * `links.open` sorts the two paths and writes them as `a` and `b`, once, and an opened
   * link is never rewritten — so `a` is the lexicographically-lower project for the life of
   * the record, whoever made the link and whoever spoke first. The lane class is read off
   * that pair, so the colour follows it for free: no stored assignment, nothing to migrate,
   * and no "first speaker is green" to repaint the thread the day a truncated tail no
   * longer contains the first message.
   */
  const links = text('server/links.js');
  assert.match(links, /const \[lo, hi\] = \[one, two\]\.sort\(\);/);
  assert.match(links, /a: lo,\n\s*b: hi,/);
  assert.match(app, /e\.sender === link\?\.a \? 'from-a' : 'from-b'/);
});

/* ---------------------------------------------------------- the type scale --- */

test('the thread reads at the room’s scale, which is the second one and not a third', () => {
  /*
   * It was inheriting the body's 16px serif — measured identical, to the pixel, to an
   * ordinary transcript message — which is what made it read as a conversation rather than
   * a log. A joint thread is a *view* over the two projects' rooms, so it takes the size
   * those same entries already have one pane over. Two spellings of one number is the
   * family this repo keeps getting bitten by, so they are pinned equal here.
   */
  const thread = styles.match(/\.link-thread-inner \{[\s\S]*?\}/)[0].match(/font-size:\s*([^;]+);/);
  const room = styles.match(/\.room-list \{[\s\S]*?\n\}/)[0].match(/font-size:\s*([^;]+);/);
  assert.ok(thread && room, 'both blocks must spell a size');
  assert.equal(thread[1].trim(), room[1].trim());
});
