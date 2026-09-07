import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * A group room's slot folded down to a strip — item 3 of the collapsible side panels.
 *
 * Nothing here renders anything, for `test/aside-fold.test.js`' reason one panel over: what
 * a fold *looks* like is a pair of eyes and a sampled width series, and the report carries
 * those. What this pins is the handful of facts about this fold that would break
 * **silently** — a fold expressed through the variable a resizer owns, a transition that
 * stops being class-gated, a remeasure that stops running, a badge derived from the counter
 * that is always zero behind a shut door, a mark that mutes the room in two places at once.
 * Every one of those leaves a panel that still opens and closes on screen and is wrong
 * underneath.
 *
 * The geometry half is genuinely different from the aside's and that is why it is a second
 * file rather than more cases in the first. An aside is a box inside a pane and folds by
 * having its own width pinned; a room is a **grid track** of `.main` and folds by the
 * frame's track list changing under it — different property, different owner, and a
 * different way to get it wrong.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');

/** Comments explain the rules, so a negative assertion run over the raw file fails on the
 *  very sentences that record them. Block comments and whole-line `//` come out. */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

/** One CSS rule by its exact selector list, braces and all. */
const rule = (selector) => {
  const i = styles.indexOf(`${selector} {`);
  assert.ok(i >= 0, `\`${selector}\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/**
 * One function body out of `web/app.js`, by balancing braces from its declaration.
 *
 * The parameter list is walked first and skipped, because one of the functions here takes a
 * **destructured** argument — `foldGlyph({ column, chevron })` — and a brace walk that began
 * at the first `{` it saw would balance on the parameter list and hand back a signature with
 * no body in it. Silently, and every assertion about the drawing would then pass by
 * examining nothing.
 */
const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `\`${name}\` must exist in web/app.js`);
  let parens = 0;
  let after = app.indexOf('(', start);
  for (; after < app.length; after += 1) {
    if (app[after] === '(') parens += 1;
    else if (app[after] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  for (let j = app.indexOf('{', after); j < app.length; j += 1) {
    if (app[j] === '{') depth += 1;
    else if (app[j] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/* ------------------------------------------------------------- geometry --- */

test('the fold is a class on the frame, and it is not `--pane-a`', () => {
  // `applyResizers()` re-applies the stored split width on every `window.resize`, so a fold
  // written into the variable the split resizer owns would be silently undone by a window
  // drag — and the dragged width would be gone with it.
  assert.match(rule('.app.split.fold-a .main'), /grid-template-columns: var\(--strip\) 1fr;/);
  assert.match(rule('.app.split.fold-b .main'), /grid-template-columns: 1fr var\(--strip\);/);
  for (const name of ['applyRoomFold', 'paintFolds', 'endRoomFold', 'setFoldClasses', 'roomFoldSlot']) {
    const body = strip(fn(name));
    assert.ok(!/--pane-a/.test(body), `${name} must not write --pane-a`);
    assert.ok(!/paneWidth/.test(body), `${name} must not touch foreman.paneWidth`);
  }
});

test('the fold rules beat the split’s own, on specificity and on order', () => {
  // `.app.split .main` is what they have to override; three classes against four, and after
  // it in the file so a tie could not go the other way either.
  const base = styles.indexOf('.app.split .main {');
  assert.ok(base >= 0, '`.app.split .main` must still exist to be beaten');
  assert.ok(styles.indexOf('.app.split.fold-a .main {') > base);
  assert.ok(styles.indexOf('.app.split.fold-b .main {') > base);
});

test('a room can be in slot `a`, so both directions are real', () => {
  // `openGroupRoom` puts a room in the pane you are *not* focused in, which is the first
  // column half the time. A design that assumed the second column is wrong half the time.
  assert.match(fn('paintFolds'), /setFoldClasses\(slot\)/);
  assert.match(fn('setFoldClasses'), /toggle\('fold-a', slot === 'a'\)/);
  assert.match(fn('setFoldClasses'), /toggle\('fold-b', slot === 'b'\)/);
});

test('`1fr` does not interpolate, so the animation runs through an explicit px pair', () => {
  // `50% 1fr` → `2.5rem 1fr` animates and `50% 1fr` → `1fr 2.5rem` does not, which is why the
  // fold cannot be a class swap and why `foldTracks` exists at all.
  const apply = fn('applyRoomFold');
  assert.match(apply, /foldTracks\(\{ frameW, aW, bW, stripW, fold: slot \}\)/);
  assert.match(apply, /el\.main\.style\.gridTemplateColumns = `\$\{start\[0\]\}px \$\{start\[1\]\}px`;/);
  assert.match(apply, /el\.main\.style\.gridTemplateColumns = `\$\{end\[0\]\}px \$\{end\[1\]\}px`;/);
  // …and the inline pair is dropped at the end, or a later window resize would hold px
  // taken at the old width instead of recomputing the tracks.
  assert.match(fn('endRoomFold'), /el\.main\.style\.removeProperty\('grid-template-columns'\);/);
});

test('the transition is class-gated, so a grip drag stays instant', () => {
  assert.match(rule('.app.is-folding .main'), /transition: grid-template-columns 200ms ease;/);
  // A transition standing on `.app.split .main` permanently would make every split-grip drag
  // lag the cursor by a fifth of a second.
  assert.ok(!/transition/.test(rule('.app.split .main')), '`.app.split .main` must carry no transition');
});

test('the duration in the timer and the duration in the stylesheet are the same number', () => {
  const ms = /const ROOM_FOLD_MS = (\d+);/.exec(app);
  assert.ok(ms, 'ROOM_FOLD_MS must be spelled');
  assert.match(rule('.app.is-folding .main'), new RegExp(`grid-template-columns ${ms[1]}ms ease`));
});

test('the strip’s width is measured off a node wearing the token, never converted from it', () => {
  // `tokens.css` says `--strip` is spelled once and that `foldTracks`' `stripW` is resolved
  // by measuring a node that wears it — a second conversion here (rem × root font size)
  // would be a second answer to how wide a closed panel is.
  assert.match(fn('stripWidth'), /getBoundingClientRect\(\)\.width/);
  assert.ok(!/--strip/.test(strip(fn('applyRoomFold'))), 'the arithmetic must not re-read the token');
  assert.match(fn('applyRoomFold'), /const stripW = target\.stripWidth\(\);/);
});

/* ----------------------------------------------------------- the grip --- */

test('a handle on a boundary that will not move is not drawn', () => {
  const hidden = rule('.app.split.fold-a .split-grip,\n.app.split.fold-b .split-grip,\n.app.split.is-folding .split-grip');
  assert.match(hidden, /display: none;/);
  // …and it is still shown by the rule that was there before, so this is an override rather
  // than a deletion — it comes back the moment the room does.
  assert.match(rule('.app.split .split-grip'), /display: flex;/);
});

/* ----------------------------------------------------------- the freeze --- */

test('the flow is frozen at a measured width while the pane moves, and clipped rather than re-wrapped', () => {
  // `renderGroup`'s clamp pass caches `scrollHeight > clientHeight` per entry and keeps
  // running while the pane is folded, because `isConnected` is still true. A measurement
  // taken at 2.5rem is wrong and it is cached onto the DOM.
  assert.match(
    rule('.pane.is-strip > .group-pane-body,\n.pane.is-folding > .group-pane-body'),
    /width: var\(--room-frozen, 100%\);/,
  );
  assert.match(rule('.pane.is-strip,\n.pane.is-folding'), /overflow: hidden;/);
});

test('the remeasure on the way out is not optional, and it is the clamp pass', () => {
  const end = fn('endGroupFold');
  assert.match(end, /host\.style\.removeProperty\('--room-frozen'\);/);
  assert.match(end, /renderGroup\(\);/);
  assert.match(end, /pinGroup\(\);/);
  // …and never while the pane is still shut: an answer measured at 2.5rem is the one thing
  // this whole apparatus exists to avoid caching.
  assert.match(end, /if \(host\.classList\.contains\('is-strip'\)\) return;/);
});

test('the pin survives the expand and is dropped at its end, not at its start', () => {
  // The content has to keep the width it will land at while the pane grows into it, or it
  // re-wraps through every intermediate one and the remeasure is remeasuring nothing.
  assert.match(
    fn('setGroupFolded'),
    /if \(!host\.classList\.contains\('is-folding'\)\) host\.style\.removeProperty\('--room-frozen'\);/,
  );
});

test('the path that does not animate measures the freeze for itself', () => {
  // A fold applied by `paintFolds` — a reload's `adopt`, a slot changing hands — never went
  // through `applyRoomFold`, so nothing measured anything. It runs before the first paint,
  // so the pane is still at its open width and this is the honest moment to read it.
  assert.match(fn('setGroupFolded'), /if \(on && !host\.style\.getPropertyValue\('--room-frozen'\)\) \{/);
  // …and it must not re-read one that is already set: by then `applyRoomFold` has moved the
  // tracks, and a rect read there pins the content at 2.5rem.
  assert.match(fn('applyRoomFold'), /target\.freezeGroupBody\(slot === 'a' \? aW : bW\);/);
});

/* ------------------------------------------------- the animation's ends --- */

test('the end of a fold is guarded on target AND property, and backstopped by a timer', () => {
  // `transitionend` fires once per property and several move at once here — the track list
  // and both halves of the cross-fade. Under reduced motion it fires none at all, which is
  // what the timer is for.
  assert.match(
    app,
    /if \(e\.target === el\.main && e\.propertyName === 'grid-template-columns'\) endRoomFold\(\);/,
  );
  assert.match(fn('applyRoomFold'), /setTimeout\(endRoomFold, ROOM_FOLD_MS \+ 60\)/);
});

test('a value change is forced through a synchronous reflow, never a frame callback', () => {
  // An automated Chrome window reports `visibilityState: 'hidden'` and Chrome suspends
  // `requestAnimationFrame` there — measured in this repo more than once. Comments stripped,
  // because the ones that explain why say the word.
  assert.match(fn('applyRoomFold'), /void el\.main\.offsetWidth;/);
  for (const name of ['applyRoomFold', 'endRoomFold', 'paintFolds', 'setGroupFolded', 'renderGroupFoldStrip']) {
    assert.ok(!/requestAnimationFrame/.test(strip(fn(name))), `${name} must not depend on a frame callback`);
  }
});

test('expanding measures the open width with the classes off, inside one synchronous block', () => {
  // The width to animate *to* is the stylesheet's answer — `var(--pane-a)`, or half and half
  // where `splitFits` refuses it — and not something this function may compute. Off, read,
  // on, with no frame in between, so nothing ever paints the open frame unarmed.
  const apply = fn('applyRoomFold');
  const expand = apply.slice(apply.indexOf('} else {'));
  assert.match(expand, /setFoldClasses\(null\);[\s\S]{0,200}setFoldClasses\(slot\);[\s\S]{0,120}void el\.main\.offsetWidth;/);
});

test('reduced motion turns the whole fold off, both cross-fades included', () => {
  const at = styles.indexOf('@media (prefers-reduced-motion: reduce) {', styles.indexOf('.fold-strip {'));
  const body = styles.slice(at, styles.indexOf('\n}', at));
  for (const sel of ['.app.is-folding .main', '.pane.is-folding > .fold-strip', '.pane.is-folding > .group-pane-body']) {
    assert.ok(body.includes(sel), `${sel} must be silenced under reduced motion`);
  }
});

/* -------------------------------------------------------- the bookkeeping --- */

test('the fold is derived from what the panes hold, never stored, and fails open', () => {
  // A 2.5rem *session* pane is the worst thing this feature can produce, so every
  // uncertainty lands on open: no room, no split, no preference — all three answer null.
  const slot = fn('roomFoldSlot');
  assert.match(slot, /if \(panes\.length < 2 \|\| !roomFolded\.on\) return null;/);
  assert.match(slot, /return roomPane\(\)\?\.slot \?\? null;/);
  assert.match(fn('roomPane'), /panes\.find\(\(p\) => p\.groupRoomId\(\)\)/);
  // …and every pane is asked, so one that has stopped holding a room loses the class in the
  // same beat rather than keeping one nobody re-derived.
  assert.match(fn('paintFolds'), /for \(const pane of panes\) pane\.setFolded\?\.\(pane\.slot === slot\);/);
});

test('every entry that can change what a slot holds re-derives the fold', () => {
  // `paintFocus` covers focus and `closePane`; the four kind-changing entries say it for
  // themselves, because none of them goes through `paintFocus`.
  assert.match(fn('paintFocus'), /paintFolds\(\);/);
  for (const name of ['open', 'openShared', 'openGroup', 'closeGroup']) {
    assert.match(fn(name), /paintFolds\(\);/, `${name} must re-derive the fold`);
  }
});

test('the cleanup is unconditional, so a slot given a session is never 2.5rem wide', () => {
  const set = fn('setGroupFolded');
  assert.match(set, /const on = Boolean\(want\) && view\.kind === 'group-room';/);
  assert.match(set, /host\.classList\.toggle\('is-strip', on\);/);
});

/* ------------------------------------------------------------- the strip --- */

test('the strip’s facts are `roomStripFacts`’ answer, not a second derivation', () => {
  assert.match(app, /import \{ asideStripFacts, foldTracks, roomStripFacts \} from '\.\/panel-fold\.js';/);
  assert.match(fn('renderGroupFoldStrip'), /roomStripFacts\(room, state\.sessions\)/);
  // One call site. `memberRow`'s rung order is mirrored from the server's own resolution and
  // a second walk of it here is the `isLeadName` lesson in one more costume.
  const calls = app.split('\n').filter((l) => /roomStripFacts\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
  assert.equal(calls.length, 1, `exactly one call site, found ${calls.length}`);
});

test('the badge is the SERVER’s number, never the pane’s `N new below` counter', () => {
  // `view.groupUnseen` is incremented only while the reader is scrolled up, and a folded pane
  // is still following its room — so behind a shut door it stays at zero and a badge built on
  // it would never appear at all.
  const render = strip(fn('renderGroupFoldStrip'));
  assert.ok(!/groupUnseen/.test(render), 'the strip must not read the pane’s own counter');
  assert.match(render, /Number\(room\?\.unseen\)/);
});

test('a folded pane never marks the room read, or it is muted in two places at once', () => {
  // The rail band draws no count for a room a pane is holding, so behind a shut door the
  // strip's badge is the only counter — and marking read would zero the server's number it
  // is drawn from.
  const mark = fn('markGroupSeen');
  assert.match(mark, /if \(host\.classList\.contains\('is-strip'\)\) return;/);
  // Asked of the pane's own class rather than of the preference: mid-fold the two disagree
  // and the pane is right.
  assert.ok(!/roomFolded/.test(strip(mark)), 'the refusal must ask the pane, not the flag');
});

test('the mark fires on the way out, and it is the class change that releases it', () => {
  const set = fn('setGroupFolded');
  const expand = set.slice(set.indexOf("host.classList.toggle('is-strip', on);"));
  assert.match(expand, /markGroupSeen\(\);/);
});

test('the strip is patched, never rebuilt, or a repaint takes a running pulse away', () => {
  const render = fn('renderGroupFoldStrip');
  // One exception, and it is the only node with no state to lose: a member dot, added or
  // removed when the membership itself changes.
  assert.match(render, /els\.dots\.append\(document\.createElement\('span'\)\)/);
  assert.ok(!/createElement\('button'\)/.test(render), 'renderGroupFoldStrip must not rebuild the strip');
  // The animation is restarted by remove → forced reflow → add. Re-assigning the same class
  // name does nothing at all.
  assert.match(render, /classList\.remove\('is-new'\);\s*\n\s*void els\.badge\.offsetWidth;\s*\n\s*els\.badge\.classList\.add\('is-new'\)/);
});

test('the pulse is armed by the number going up, and never by a paint', () => {
  const render = fn('renderGroupFoldStrip');
  assert.match(render, /if \(now > \(view\.groupFoldSeen \|\| 0\)\) \{/);
  assert.match(render, /view\.groupFoldSeen = now;/);
});

test('the strip cross-fades at its final size, pinned from the first frame', () => {
  // Letting it take the animating box's width is what makes a fold read as a reveal: the
  // label slides across the column as it closes instead of standing still.
  const strp = rule('.pane > .fold-strip');
  assert.match(strp, /position: absolute;/);
  assert.match(strp, /width: var\(--strip\);/);
  assert.match(strp, /opacity: 0;/);
  assert.match(strp, /pointer-events: none;/);
  // Item 1's own 120ms nudge transition is off inside this host, which does not use it — the
  // *track* is what nudges here.
  assert.match(strp, /transition: none;/);
  assert.match(rule('.pane.is-strip > .fold-strip'), /opacity: 1;/);
  assert.match(rule('.pane.is-strip > .group-pane-body'), /opacity: 0;/);
});

test('the pane is positioned only where a strip actually is', () => {
  // `.pane` is shared with every session pane, and giving *that* a position would re-anchor
  // anything else ever absolutely placed in one — the room's own `N new below` pill was
  // bitten by exactly that once.
  assert.match(rule('.pane:has(> .fold-strip)'), /position: relative;/);
  assert.ok(!/position:\s*relative/.test(rule('.pane')), '`.pane` itself must stay unpositioned');
});

test('the seam is drawn once — the split’s own rule stands and the strip drops one', () => {
  assert.match(rule('.app.split .pane + .pane'), /border-left-color: var\(--rule\);/);
  assert.match(rule('.app.split .pane + .pane > .fold-strip'), /border-left: 0;/);
  // …and in the first column the pane lends it nothing, so item 1's rule is what draws it.
  assert.match(rule('.fold-strip'), /border-left: 1px solid var\(--rule\);/);
});

test('the hover nudge is carried by the track, because the track is what sets the width', () => {
  // Scoped by a direct-child chain: a lead's aside in the other pane draws a `.fold-strip`
  // too, and an unscoped `:has()` would nudge this room's track whenever the cursor crossed
  // that one.
  for (const s of ['a', 'b']) {
    const r = rule(`.app.split.fold-${s} .main:has(> .pane.is-strip > .fold-strip:hover)`);
    assert.match(r, /calc\(var\(--strip\) \+ 3px\)/);
  }
  assert.match(rule('.pane.is-strip > .fold-strip:hover'), /width: calc\(var\(--strip\) \+ 3px\);/);
});

/* ------------------------------------------------------------ the controls --- */

test('the collapse control is in the room header, and it is hidden with nothing to fold beside', () => {
  const head = fn('buildGroupHead');
  assert.match(head, /fold\.className = 'ghost-btn room-fold-btn';/);
  assert.match(head, /meta\.append\(fold, close\);/);
  // Both axes come off the slot: a room in `a` is a left column that closes leftwards, one
  // in `b` a right column that closes rightwards. A pane's slot never changes, so it is
  // decided once and never repainted.
  assert.match(
    head,
    /fold\.append\(foldGlyph\(\{ column: slot === 'a' \? 'left' : 'right', chevron: slot === 'a' \? 'left' : 'right' \}\)\);/,
  );
  // A room alone in the frame has nothing to fold beside it, and a frame that was nothing but
  // a strip would be a panel with no content and no obvious way back.
  assert.match(fn('renderGroupHead'), /if \(els\.fold\) els\.fold\.hidden = panes\.length < 2;/);
});

test('one drawing, four uses — the mark is `foldGlyph`’s and neither host draws its own', () => {
  /*
   * A reader learns this mark once: it is on the strip that opens a panel, on the control
   * that shuts it, and it is the lead aside's too. Two hand-drawn spellings would drift the
   * first time either was adjusted — the `isLeadName` lesson in one more costume — so this
   * pins that both of this item's controls come from the one helper, and that the helper
   * takes its two directions independently.
   */
  const glyph = fn('foldGlyph');
  assert.match(glyph, /function foldGlyph\(\{ column, chevron \}\)/);
  // Mirroring the whole drawing would flip the column and the chevron together and could
  // only ever reach half of the four cases — a right column that opens leftwards and the
  // same right column that closes rightwards are not mirrors of each other.
  assert.match(glyph, /const at = column === 'left' \? 9 : 15;/);
  assert.match(glyph, /const dx = chevron === 'left' \? 1\.6 : -1\.6;/);
  // `currentColor` throughout, so a host sets the tone and its hover in the stylesheet and
  // the drawing never has an opinion about either.
  assert.match(glyph, /setAttribute\('stroke', 'currentColor'\)/);
  assert.match(glyph, /setAttribute\('stroke-width', '1\.8'\)/);
  assert.ok(!/var\(--/.test(glyph), 'the drawing must name no token');
  // Two call sites in this item — the strip and the header — and no third drawing anywhere.
  const calls = app
    .split('\n')
    .filter((l) => /foldGlyph\(\{/.test(l) && !/^\s*(\*|\/\/)/.test(l) && !/^function /.test(l));
  assert.equal(calls.length, 2, `exactly two call sites, found ${calls.length}`);
  // One rule for its size and its colour, shared by both panels for the same reason.
  const css = rule('.fold-glyph');
  assert.match(css, /color: var\(--ink-muted\);/);
  assert.match(css, /width: 0\.95rem;/);
  assert.match(rule('button:hover > .fold-glyph,\nbutton:hover .fold-glyph'), /color: var\(--accent\);/);
});

test('the strip’s own control is the same mark, at the top, pointing the other way', () => {
  const build = fn('buildGroupFoldStrip');
  assert.match(
    build,
    /chev\.append\(foldGlyph\(\{ column: slot === 'a' \? 'left' : 'right', chevron: slot === 'a' \? 'right' : 'left' \}\)\);/,
  );
  // First child of a column flex, which is what puts it at the top — where the control that
  // shut the panel was, so the eye goes back to the same corner to reopen it.
  assert.match(build, /strip\.append\(chev, label, dots, badge\);/);
  assert.match(rule('.fold-strip'), /flex-direction: column;/);
});

test('the strip is a button, and a press on it is not a statement about focus', () => {
  const build = fn('buildGroupFoldStrip');
  assert.match(build, /createElement\('button'\)/);
  assert.match(build, /strip\.type = 'button';/);
  // The pane's own `mousedown` listener is in the capture phase, so `stopPropagation` on the
  // strip could never reach it — asking what was pressed is the only thing that can. And
  // `sessionPane` is deliberately untouched: this is a fact about one control, not about how
  // the rail routes.
  assert.match(app, /if \(e\.target instanceof Element && e\.target\.closest\('\.fold-strip'\)\) return;/);
  assert.match(fn('addPane'), /'mousedown',/);
});

test('a folded column is not walked into by Tab', () => {
  assert.match(fn('setGroupFolded'), /view\.groupBodyEl\.inert = on;/);
  assert.match(fn('renderGroupPane'), /flow\.inert = host\.classList\.contains\('is-strip'\);/);
});

/* --------------------------------------------------- what is remembered --- */

test('a room slides in open every time, so opening one clears the memory', () => {
  // The remembered fold has exactly one job left: a reload, where `adopt` puts the pane back
  // from `state.opened`. Without this line a room opened fresh would come back folded after
  // the next reload — the memory answering a question nobody asked.
  const open = app.match(/\nfunction openGroupRoom\(id\) \{[\s\S]*?\n\}/)[0];
  assert.match(open, /roomFolded\.set\(false\);/);
  // …and a press on a room already on screen but shut opens the door rather than doing
  // nothing, which is what a band row for a room whose badge just went up has to do.
  assert.match(open, /return revealOpenRoom\(\);/);
  assert.match(fn('revealOpenRoom'), /roomFolded\.set\(false\);[\s\S]{0,80}applyRoomFold\(false\);/);
});

test('the preference is one flag in `prefs.js`, and the only module-scope state here', () => {
  assert.match(app, /import \{ asideFolded, ghostSend, hideFinished, isFinishedState, roomFolded \} from '\.\/prefs\.js';/);
  // Everything per-pane lives inside `createPane` — the strip's nodes, the seen count, the
  // frozen width. Module scope holds the preference, the geometry (there is one `.main`) and
  // one timer for it.
  assert.match(app, /let roomFoldTimer = null;/);
  for (const field of ['groupFoldEls', 'groupFoldSeen', 'groupBodyEl']) {
    assert.match(fn('clearGroup'), new RegExp(`view\\.${field} =`), `${field} must be cleared with the room`);
  }
});

/* ------------------------------------------------ what it must not join --- */

test('nothing about the fold joins `composerSig`', () => {
  // A fold, or a count going up, must never tear a textarea down under whoever is typing —
  // the merge block's rule, and `renderQueue`/`renderMergeQueue`'s precedent. The strip
  // repaints on the roster beat instead.
  const at = app.indexOf('const composerSig = (s) =>');
  assert.ok(at >= 0, '`composerSig` must exist in web/app.js');
  const sig = app.slice(at, app.indexOf('].join', at));
  for (const word of ['fold', 'strip', 'room', 'unseen']) {
    assert.ok(!new RegExp(word, 'i').test(sig), `composerSig must not read ${word}`);
  }
  assert.match(fn('renderHead'), /renderGroupStrip\(\);[\s\S]{0,400}renderGroupFoldStrip\(\);/);
});
