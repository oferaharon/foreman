import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The lead's team aside folded down to a strip — item 2 of the collapsible side panels.
 *
 * Nothing here renders anything. What it pins is the handful of facts about this fold that
 * would break **silently**: a rule that stops overriding a floor, a transition that stops
 * being class-gated, a remeasure that stops running, a counter derived from the wrong
 * number. Every one of those leaves a panel that still opens and closes on screen and is
 * wrong underneath — which is exactly the population a source test is for. What a fold
 * *looks* like is a pair of eyes and a sampled width series, and the report carries those.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const tokens = text('web/tokens.css');

/** One CSS rule by its exact selector list, braces and all. */
const rule = (selector) => {
  const i = styles.indexOf(`${selector} {`);
  assert.ok(i >= 0, `\`${selector}\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/** One CSS rule by the *last* selector of a multi-line list — `rule()` keys off
 *  `<selector> {`, which a list spanning lines does not spell anywhere. */
const listRule = (last) => {
  const i = styles.indexOf(`${last} {`);
  assert.ok(i >= 0, `\`${last} {\` must exist in web/styles.css`);
  return styles.slice(i, styles.indexOf('}', i) + 1);
};

/** One function body out of `web/app.js`, by balancing braces from its declaration. */
const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `\`${name}\` must exist in web/app.js`);
  let i = app.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < app.length; j += 1) {
    if (app[j] === '{') depth += 1;
    else if (app[j] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/* ------------------------------------------------------------- geometry --- */

test('all three width axes move, because `min-width: 15rem` beats any width a fold sets', () => {
  const strip = rule('.room-panel.is-strip');
  for (const prop of ['width', 'min-width', 'max-width']) {
    assert.match(strip, new RegExp(`(^|\\n)\\s*${prop}: var\\(--strip\\);`), `${prop} must be pinned to var(--strip)`);
  }
  // …and the floor is still there to be beaten, or this test is pinning nothing.
  assert.match(rule('.room-panel'), /min-width: 15rem;/);
});

test('all three transition, or the used width snaps to the floor while one of them eases', () => {
  const folding = rule('.room-panel.is-folding');
  for (const prop of ['width', 'min-width', 'max-width']) {
    assert.match(folding, new RegExp(`${prop} 200ms ease`), `${prop} must ease with the other two`);
  }
});

test('the hover nudge is carried by the host, because the host is what pins the width', () => {
  // Item 1's `.fold-strip:hover` cannot widen a node inside a box pinned on all three
  // axes; the panel nudges instead, and it has to nudge on all three for the same reason
  // the fold does.
  const hover = rule('.room-panel.is-strip:hover');
  for (const prop of ['width', 'min-width', 'max-width']) {
    assert.match(hover, new RegExp(`${prop}: calc\\(var\\(--strip\\) \\+ 3px\\);`));
  }
});

test('the seam is drawn once — the panel keeps its rule and the strip inside it drops one', () => {
  assert.match(rule('.room-panel'), /border-left: 1px solid var\(--rule\);/);
  assert.match(rule('.room-panel > .fold-strip'), /border-left: 0;/);
});

test('nothing a drag moves carries a transition: the fold is class-gated, the strip is silenced', () => {
  // A transition standing on `.room-panel`'s own width would make an `.aside-grip` drag lag
  // the cursor by a fifth of a second. It has to live on `is-folding`, which exists only
  // around the animation.
  assert.ok(!/transition[^;]*width/.test(rule('.room-panel')), '`.room-panel` itself must carry no width transition');
  // And item 1's own 120ms nudge transition is turned off inside this host, which does not
  // use it — measured, it eased the 1px between `var(--strip)` and `100%` of a bordered
  // panel at the end of every fold.
  assert.match(rule('.room-panel > .fold-strip'), /transition: none;/);
});

/* ----------------------------------------------------------- the freeze --- */

test('the body is frozen at a measured width while the panel moves, and clipped rather than re-wrapped', () => {
  const frozen = rule('.room-panel.is-strip > .room-panel-body,\n.room-panel.is-folding > .room-panel-body');
  assert.match(frozen, /width: var\(--aside-frozen, var\(--aside\)\);/);
  assert.match(rule('.room-panel.is-strip,\n.room-panel.is-folding'), /overflow: hidden;/);
});

test('the freeze is what protects the two cached measurements, so the remeasure is on the way out', () => {
  // `capTaskList` writes a px max-height off row rects; the room's clamp caches
  // `scrollHeight > clientHeight` per entry. Both go on running while folded because
  // `isConnected` is still true, so both have to be re-taken once the panel has stopped.
  const end = fn('endAsideFold');
  for (const call of ['recapTaskLists()', 'renderTasks()', 'pinRoom()']) {
    assert.ok(end.includes(call), `the end of a fold must call ${call}`);
  }
  assert.match(end, /removeProperty\('--aside-frozen'\)/);
});

test('the wrapper holds what is in the flow and neither of the two absolute children', () => {
  // `.room-hint` hangs off the room's bottom edge and `.aside-band` sits on the panel's
  // left edge; both are positioned against `.room-panel` and must stay its children.
  assert.match(app, /body\.append\(settingsHead, settingsFold, tasksHead, tasksList, tasksGrip, roomHead, list\);/);
  assert.match(app, /panel\.append\(body, buildAsideStrip\(\), hint, asideBand\);/);
});

/* ------------------------------------------------------ the animation's ends --- */

test('the end of a fold is guarded on target AND property, and backstopped by a timer', () => {
  // Four properties move at once — three widths and the cross-fade's opacity — and
  // `transitionend` fires once per property, so an unguarded listener runs the end of the
  // fold four times. Under reduced motion it fires none, which is what the timer is for.
  assert.match(app, /if \(e\.target === panel && e\.propertyName === 'width'\) endAsideFold\(\);/);
  assert.match(fn('applyAsideFold'), /setTimeout\(\(\) => endAsideFold\(\), ASIDE_FOLD_MS \+ 60\)/);
  assert.match(app, /const ASIDE_FOLD_MS = 200;/);
});

test('the duration in the timer and the duration in the stylesheet are the same number', () => {
  const ms = /const ASIDE_FOLD_MS = (\d+);/.exec(app);
  assert.ok(ms, 'ASIDE_FOLD_MS must be spelled');
  assert.match(rule('.room-panel.is-folding'), new RegExp(`width ${ms[1]}ms ease`));
});

test('a value change is forced through a synchronous reflow, never a frame callback', () => {
  // An automated Chrome window reports `visibilityState: 'hidden'` and Chrome suspends
  // `requestAnimationFrame` there — measured in this repo more than once. Every
  // apply-the-class-then-change-the-value step in the fold uses `void offsetWidth`.
  // Comments stripped: all three of these say the word while explaining why they do not
  // use it, and a test that cannot tell those apart pins nothing.
  const code = (name) => fn(name).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(fn('applyAsideFold'), /void panel\.offsetWidth;/);
  for (const name of ['applyAsideFold', 'syncAsideFold', 'renderAsideStrip', 'endAsideFold']) {
    assert.ok(!/requestAnimationFrame/.test(code(name)), `${name} must not depend on a frame callback`);
  }
});

test('reduced motion turns the whole fold off, the cross-fade included', () => {
  const block = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce) {', styles.indexOf('.fold-strip {')));
  const end = block.indexOf('\n}');
  const body = block.slice(0, end);
  for (const sel of ['.room-panel.is-folding', '.room-panel.is-folding > .fold-strip', '.room-panel.is-folding > .room-panel-body']) {
    assert.ok(body.includes(sel), `${sel} must be silenced under reduced motion`);
  }
});

/* -------------------------------------------------------- what is stored --- */

test('a fold never writes `--aside`, so a dragged width comes straight back', () => {
  for (const name of ['applyAsideFold', 'endAsideFold', 'syncAsideFold', 'foldAsides']) {
    const body = fn(name);
    assert.ok(!/setRootVar\('--aside'/.test(body), `${name} must not write --aside`);
    assert.ok(!/asideWidth/.test(body), `${name} must not touch foreman.asideWidth`);
  }
});

test('the preference is one answer for the browser, fanned out, and never per-pane in module scope', () => {
  // `foldAsides` asks each pane rather than walking `.room-panel` nodes, which is
  // `renderTaskLists`' shape and its reason: the fold has to run through the pane's own
  // animation, which measures, freezes, clears a counter and remeasures.
  assert.match(fn('foldAsides'), /for \(const pane of panes\) pane\.foldAside\?\.\(\);/);
  assert.match(app, /foldAside: applyAsideFold,/);
  assert.match(app, /import \{ asideFolded, ghostSend, hideFinished, isFinishedState \} from '\.\/prefs\.js';/);
});

/* ----------------------------------------------------------- the strip --- */

test('the strip’s counts are `asideStripFacts`’ answer, not a second derivation', () => {
  assert.match(app, /import \{ asideStripFacts \} from '\.\/panel-fold\.js';/);
  assert.match(fn('renderAsideStrip'), /asideStripFacts\(current\(\)\?\.team\)/);
  // The rail row reads the same object. A second walk of `s.team` here is the `isLeadName`
  // lesson in one more costume.
  // One call site. A second walk of `s.team` here is the `isLeadName` lesson in one more
  // costume — a strip and the rail row it stands in for reading two different numbers.
  const calls = app.split('\n').filter((l) => /asideStripFacts\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
  assert.equal(calls.length, 1, `exactly one call site, found ${calls.length}`);
});

test('the strip is patched, never rebuilt, or a repaint takes a running pulse away', () => {
  const render = fn('renderAsideStrip');
  assert.ok(!/createElement/.test(render), 'renderAsideStrip must not build nodes');
  assert.ok(/roomView\.stripRoomEl/.test(render));
  // The animation is restarted by remove → forced reflow → add. Re-assigning the same
  // class name does nothing at all.
  assert.match(render, /classList\.remove\('is-new'\)[\s\S]*void roomView\.stripRoomEl\.offsetWidth;[\s\S]*classList\.add\('is-new'\)/);
});

test('the pulse is re-armed by an arrival and never by a paint', () => {
  const render = fn('renderAsideStrip');
  assert.match(render, /if \(roomView\.foldedPulse && roomView\.stripRoomEl\) \{\s*\n\s*roomView\.foldedPulse = false;/);
});

/* ------------------------------------------------- unread behind a shut door --- */

test('a folded aside counts its own arrivals, because `unseen` cannot', () => {
  // `roomView.unseen` counts only while `follow === false` — "arrived while you were
  // scrolled up" — and a folded aside is still following. There is no server-side unread
  // for the team room either, so this counter is the only source.
  const branch = app.slice(app.indexOf("case 'room-append':"), app.indexOf("case 'error':"));
  assert.match(branch, /roomView\.panelEl\?\.classList\.contains\('is-strip'\)/);
  assert.match(branch, /roomView\.foldedUnseen \+= 1;/);
  assert.match(branch, /roomView\.foldedPulse = true;/);
  // Asked of the panel's own class rather than of the preference: mid-fold, and for a pane
  // that has not caught up with the flag, the two disagree and the panel is right.
  assert.ok(!/asideFolded\.on/.test(branch), 'the arrival must ask the panel, not the flag');
});

test('the counter is spent on expand, before the animation rather than after it', () => {
  const apply = fn('applyAsideFold');
  const expand = apply.slice(apply.indexOf('} else {'));
  assert.match(expand, /roomView\.foldedUnseen = 0;/);
  assert.match(expand, /roomView\.foldedPulse = false;/);
});

test('another team’s lines are not lines you missed in this one', () => {
  const sync = fn('syncRoom');
  assert.match(sync, /roomView\.foldedUnseen = 0;/);
  assert.match(sync, /roomView\.foldedPulse = false;/);
});

/* ------------------------------------------------------ what it must not join --- */

test('nothing about the fold joins `composerSig`', () => {
  // A fold, a count, or a task reaching `review` must never tear the textarea down under
  // whoever is typing — the merge block's rule, and `renderQueue`/`renderMergeQueue`'s
  // precedent. The strip repaints on the roster beat instead.
  // An arrow function, so it is read by its own bracket rather than by `fn`'s brace walk.
  const at = app.indexOf('const composerSig = (s) =>');
  assert.ok(at >= 0, '`composerSig` must exist in web/app.js');
  const sig = app.slice(at, app.indexOf('].join', at));
  for (const word of ['fold', 'strip', 'team', 'task']) {
    assert.ok(!new RegExp(word, 'i').test(sig), `composerSig must not read ${word}`);
  }
  const head = fn('renderHead');
  assert.match(head, /refreshTasks\(\);\s*\n\s*refreshMerge\(\);[\s\S]{0,600}renderAsideStrip\(\);/);
});

/* ------------------------------------------- the rebuild, and the control --- */

test('the fold is applied at build time, so a rebuild never re-runs the animation', () => {
  // `renderMain` rebuilds this whole aside on every `transcript` frame. A transition fires
  // on a value change to an element that is already laid out; a panel born folded has
  // never had another width.
  const build = fn('buildRoomPanel');
  assert.match(build, /panel\.classList\.toggle\('is-strip', asideFolded\.on\);/);
  assert.ok(!/is-folding/.test(build.slice(build.indexOf("panel.classList.toggle('is-strip'"))), 'the build must not arm a transition');
  // …and the measurement that needs a rect runs after the mount, before the first paint.
  assert.match(fn('renderMain'), /applyResizers\(\);[\s\S]{0,400}syncAsideFold\(\);/);
});

test('the collapse control is the band on the aside’s left edge, and nowhere else', () => {
  // It was a `›` in the SETTINGS heading for one review and the maintainer rejected it: a
  // third knob in a settings header, for a thing about the panel's edge. The heading is
  // back to label + gear, and the pane header — already carrying pin / thinking / images /
  // split / reveal / attach / forge, and recorded overflowing below about 1400px — never
  // grew one either.
  const settings = fn('buildSettingsHead');
  assert.match(settings, /head\.append\(label, gear\);/);
  for (const where of ['buildSettingsHead', 'buildHead']) {
    assert.ok(!/room-head-fold/.test(fn(where)), `${where} must not carry a fold control`);
    assert.ok(!/asideFolded\.set/.test(fn(where)), `${where} must not fold the aside`);
  }
  assert.ok(!/room-head-fold/.test(styles), '`.room-head-fold` must be gone from the stylesheet');
  // The gear's box is still what keeps this heading as tall as `tasks` and `room` below it
  // — `.tasks-grip`'s hairline is measured against those heights.
  assert.match(rule('.room-head-gear'), /margin: -0\.35rem -0\.2rem -0\.35rem 0;/);
});

test('the band is the grip: one node, `resizer` unchanged, and the icon does not start a drag', () => {
  const band = fn('buildAsideBand');
  // `paneGrip` builds it, so the separator ARIA stays in the one place all four dividers
  // read it from — a hand-rolled div here would be a second spelling of that.
  assert.match(band, /paneGrip\('x', 'Panel width'/);
  assert.match(band, /band\.classList\.add\('aside-band'\);/);
  // And it is the handle the width resizer is wired to, with the storage key and the
  // bounds untouched.
  const panel = fn('buildRoomPanel');
  assert.match(panel, /const asideBand = buildAsideBand\(\);/);
  assert.match(panel, /handle: asideBand,\s*\n\s*axis: 'x',\s*\n\s*storageKey: 'foreman\.asideWidth',/);
  // `resizer` listens on the handle, so a `pointerdown` on a button inside it would begin a
  // width drag — and the pointer capture that follows means the `click` never lands. The
  // handle's double-click reset is the second event that has to be stopped.
  assert.match(band, /fold\.addEventListener\('pointerdown', \(e\) => e\.stopPropagation\(\)\);/);
  assert.match(band, /fold\.addEventListener\('dblclick', \(e\) => e\.stopPropagation\(\)\);/);
  assert.match(band, /asideFolded\.set\(true\);/);
});

test('the band is painted inside the panel, and the content is padded off it by the resting width', () => {
  // A painted band on the grip's old `left: -3px` would put three pixels of `--band` over
  // the transcript. One token, read twice, so the two cannot come apart.
  // `.pane-grip.grip-col` pins `width: 7px` at two classes, so a one-class `.aside-band`
  // loses on specificity wherever it sits in the file — measured, the band came back 7px
  // wide with `var(--band-w)` on the books. The whole block carries the extra class.
  const band = rule('.pane-grip.aside-band');
  assert.match(band, /left: 0;/);
  assert.match(band, /background: var\(--band\);/);
  // The padding is the *resting* width, not the hovered one: content sits flush against the
  // hairline, and the hover width overhangs `.lead-left` instead of growing into a reserved
  // gap here — the reserved-padding design read as a notch beside `TEAM ROOM`'s own darker
  // fill and was reversed for it.
  // `rule()` takes the first `<selector> {` and `.room-panel-body` is also the tail of the
  // freeze's two-selector rule above it, so this reads the declaration where it sits — the
  // last one in that block, against the closing brace.
  assert.match(styles, /\n  padding-left: var\(--band-w-rest\);\n\}/);
  // Two rules, two different edges: the panel's own left border is the transcript boundary,
  // the band's right border is the content boundary. Neither is drawn twice.
  assert.match(band, /border-right: 1px solid var\(--rule\);/);
  assert.match(rule('.room-panel'), /border-left: 1px solid var\(--rule\);/);
});

test('the band is a hairline at rest and a column under the cursor, and a drag holds it open', () => {
  // Two widths, two tokens — `--band-w-rest` is what the body pads off now, and `--band-w`
  // is still what the band grows to under the cursor.
  const band = rule('.pane-grip.aside-band');
  assert.match(band, /width: var\(--band-w-rest\);/);
  assert.match(band, /transition: width 160ms ease, left 160ms ease, background 120ms ease;/);
  const open = listRule('.pane-grip.aside-band.is-dragging');
  assert.match(open, /width: var\(--band-w\);/);
  assert.match(open, /background: var\(--accent-soft\);/);
  // `:focus-within` is the keyboard half — tabbing to the fold is what opens the band — and
  // `is-dragging` is the one that matters most: a pointer capture is not a promise about
  // hover, and a target that shrank to a hairline mid-drag is the failure this rules out.
  assert.match(
    styles,
    /\.pane-grip\.aside-band:hover,\n\.pane-grip\.aside-band:focus-within,\n\.pane-grip\.aside-band\.is-dragging \{/,
  );
  // The resting width is the old `.pane-grip.grip-col` strip, so the drag target at rest is
  // the one the other three dividers still offer rather than a number picked by eye.
  assert.match(tokens, /--band-w-rest: 0\.45rem;/);
  assert.match(rule('.pane-grip.grip-col'), /width: 7px;/);
});

test('the band overhangs the transcript on hover rather than growing into the aside', () => {
  // The right edge is what has to hold still: `left` moves negative by exactly what `width`
  // gains, so the new pixels land on `.lead-left`'s side of the hairline and the aside's own
  // content — padded off at the resting width now — never moves.
  const open = listRule('.pane-grip.aside-band.is-dragging');
  assert.match(open, /left: calc\(var\(--band-w-rest\) - var\(--band-w\)\);/);
  // Clear of `.lead-left`'s own content and its transcript's scrollbar — nothing in that
  // pane carries a z-index this high.
  const band = rule('.pane-grip.aside-band');
  assert.match(band, /z-index: 5;/);
  // `.room-panel` must not clip the overhang: its own overflow is `visible`, not the
  // `overflow-y: auto` that used to compute `overflow-x` to `auto` as a side effect (a
  // scroll container's negative-going overflow is unreachable in LTR). It is its own
  // one-line rule — `rule()` keys off the first `.room-panel {` in the file, which is the
  // unrelated width/border block above, so this reads the literal declaration instead. The
  // fold states still win back `overflow: hidden` on top of this, unrelated to the band.
  assert.match(styles, /\n\.room-panel \{ overflow: visible; \}/);
});

test('the fold is not drawn, and cannot be pressed, until the band has room for it', () => {
  // A 15px glyph in a 7px column is a clipped icon, not a smaller one.
  const fold = rule('.aside-band-fold');
  assert.match(fold, /opacity: 0;/);
  // `pointer-events` is the whole of the JS this needed: the button stays a real button in
  // the tree, nothing toggles `tabindex` or `aria-hidden`, and a pointer on the hairline
  // reaches the *band* and starts a drag instead of pressing an icon nobody can see.
  assert.match(fold, /pointer-events: none;/);
  assert.ok(
    !/aria-hidden|tabIndex|tabindex/.test(fn('buildAsideBand')),
    'the hidden state is CSS; the builder must not toggle focusability',
  );
  const shown = listRule('.aside-band.is-dragging > .aside-band-fold');
  assert.match(shown, /opacity: 1;/);
  assert.match(shown, /pointer-events: auto;/);
  // Delayed behind the widening on the way in, and not on the way out.
  assert.match(shown, /transition: opacity 120ms ease 60ms, color 120ms ease;/);
  assert.match(fold, /transition: opacity 120ms ease, color 120ms ease;/);
  assert.match(
    styles,
    /\.aside-band:hover > \.aside-band-fold,\n\.aside-band:focus-within > \.aside-band-fold,\n\.aside-band\.is-dragging > \.aside-band-fold \{/,
  );
  // Both halves of the reveal go instant together: a `transition: none` that reached only
  // the closed state would leave the icon arriving 60ms late for a reader who asked for no
  // motion at all.
  const after = styles.slice(styles.indexOf('.aside-band-fold:hover { color: var(--accent); }'));
  const at = after.indexOf('@media (prefers-reduced-motion: reduce) {');
  assert.ok(at >= 0, 'the band needs a reduced-motion block after the fold rules');
  const block = after.slice(at, after.indexOf('}', after.indexOf('transition: none;', at)) + 1);
  for (const sel of [
    '.pane-grip.aside-band',
    '.aside-band-fold',
    '.aside-band:hover > .aside-band-fold',
    '.aside-band:focus-within > .aside-band-fold',
    '.aside-band.is-dragging > .aside-band-fold',
  ]) assert.ok(block.includes(sel), `reduced motion must name ${sel}`);
});

test('the drag mark is drawn at rest, at the band’s middle, and never lights up', () => {
  // The maintainer's call on top of the mock-up, which hid it until hover. It reverses the
  // reasoning the band shipped with — something that plainly *is* a control needs no second
  // mark — because a hairline is not plainly anything: at rest this is the only thing on the
  // edge saying it can be grabbed, which is the job the other three grips' bars already do.
  // Absolute rather than flex-centred, because the icon is a real flex item.
  const mark = rule('.aside-band::after');
  assert.match(mark, /position: absolute;/);
  assert.match(mark, /top: 50%;/);
  assert.match(mark, /width: 2px;/);
  assert.match(mark, /height: 1\.6rem;/);
  assert.match(mark, /background: var\(--rule-strong\);/);
  assert.ok(!/opacity/.test(mark), 'no opacity of its own — it rides the band\u2019s width');
  assert.ok(
    !/\.aside-band:hover::after,\n\.aside-band\.is-dragging::after \{ opacity/.test(styles),
    'the reveal-on-hover rule is gone',
  );
  // `.pane-grip::before` is the shared hairline that lights accent under the cursor; the
  // band says the same thing with its own background, and both would be two answers.
  assert.match(rule('.aside-band::before'), /display: none;/);
});

test('the fold glyph is one drawing, mirrored, and both halves of the fold read it from there', () => {
  // Three call sites and counting — the band, the aside's strip, and a group room pane's
  // strip. Three copies of an eight-coordinate drawing would not break; they would drift,
  // and a reader would find two panels in one window whose collapse controls do not match.
  const icon = fn('foldIcon');
  assert.match(icon, /\['x', '3'\], \['y', '4\.5'\], \['width', '18'\], \['height', '15'\], \['rx', '2\.5'\]/);
  assert.match(icon, /divider\.setAttribute\('d', 'M15 4\.5V19\.5'\);/);
  // Collapse points right, expand points left, and only the chevron moves — the frame is
  // what the icon is *about*.
  assert.match(icon, /dir === 'expand' \? 'M11 9\.5 L8\.5 12 L11 14\.5' : 'M8 9\.5 L10\.5 12 L8 14\.5'/);
  assert.match(icon, /stroke', 'currentColor'/);
  assert.match(icon, /stroke-width', '1\.8'/);
  assert.match(fn('buildAsideBand'), /foldIcon\('collapse'\)/);
  assert.match(fn('buildAsideStrip'), /foldIcon\('expand'\)/);
  // One definition. A second `createElementNS(SVG_NS, 'svg')` that draws this shape is the
  // whole thing this test exists to refuse.
  const defs = app.split('\n').filter((l) => /^function foldIcon\(/.test(l));
  assert.equal(defs.length, 1, `exactly one definition, found ${defs.length}`);
});

test('the strip is a button, so the focus ring is the browser’s own and not a ring on a 2.5rem column', () => {
  const build = fn('buildAsideStrip');
  assert.match(build, /createElement\('button'\)/);
  assert.match(build, /strip\.type = 'button';/);
  // Clicking it also runs the pane's own `mousedown` focus handler. That is left alone —
  // `:focus-visible` is what draws a ring, and a mouse press does not raise it.
  assert.match(styles, /:focus-visible \{ outline: 2px solid var\(--accent\)/);
});

test('a handle on an edge that will not move is not drawn', () => {
  assert.match(rule('.room-panel.is-strip > .aside-band'), /display: none;/);
  // …and the padding that kept content off the band goes with it, under `is-strip` alone.
  // Not `is-folding`: the body is frozen and clipped through the animation, and a padding
  // that changed mid-fold would re-wrap the content the freeze exists to hold still.
  assert.match(styles, /\.room-panel\.is-strip > \.room-panel-body \{ padding-left: 0; \}/);
});

test('a folded column is not walked into by Tab', () => {
  // `inert` is what the SETTINGS fold one function up uses, for its reason: a block hidden
  // by `overflow` is invisible and still focusable, and still read out.
  assert.match(fn('applyAsideFold'), /body\.inert = want;/);
  assert.match(fn('buildRoomPanel'), /body\.inert = asideFolded\.on;/);
});
