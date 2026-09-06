import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVED_KEY,
  bandEntries,
  bandSig,
  memberLabel,
  partitionRooms,
  patchBand,
  roomTitle,
  unseenText,
} from '../web/rooms-band.js';

/*
 * The rail's rooms band.
 *
 * Two halves, because the band is two halves. `web/rooms-band.js` is a real module and is
 * driven for real here — the partition, the fold, the signature and, under the stub DOM
 * below, the patch itself. What lives in `web/app.js` cannot be imported (it reaches for
 * `document` at module scope and there is no browser here), so the contracts on that side
 * are held against the source the way every other web test in this repo holds them.
 *
 * What is pinned, and why each one would otherwise break **silently**, leaving a band that
 * looks entirely fine:
 *
 *  - The band is hidden with no rooms and shown with one. A gate that stopped firing would
 *    leave an empty box in a 20rem column that nobody would read as a bug.
 *  - **Patched, never rebuilt.** The roster broadcasts every couple of seconds; a band that
 *    replaced its children on every beat would take a row out from under the cursor on its
 *    way to press it, and nothing on screen would say so. This is the one the stub DOM is
 *    here for: it compares node *identity* across two frames, which no source assertion can.
 *  - Archived rooms fold. A fold that silently drew them as ordinary rows would offer a way
 *    into a room that accepts nothing.
 *  - **Nothing about rooms joins `composerSig`.** That signature tears the whole composer
 *    down when it changes, and a message landing in a room would take the textarea out from
 *    under whoever is typing.
 *  - The frame is read with `'rooms' in msg`, never a truth test: an empty array is the
 *    ordinary answer and a truth test reads it as "the frame didn't mention it".
 *  - Every signature is joined with real punctuation. `mergeSig` was once joined with what
 *    read in every editor as an empty string and was three literal control bytes.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const html = text('web/index.html');
const styles = text('web/styles.css');
const band = text('web/rooms-band.js');

/**
 * The source with its prose taken out.
 *
 * Several checks below are *negative* — "`composerSig` knows nothing about rooms", "the
 * frame is never read with a truth test" — and the phrases they forbid belong in the
 * comments that record the rule. A negative assertion run over the raw file therefore fails
 * on the very sentences that explain it, which is the wrong way round. Block comments and
 * whole-line `//` comments come out; nothing else does.
 */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const code = strip(app);

const fn = (name, src = app) => {
  const m = src.match(new RegExp(`\\n(?:  )?(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n(?:  )?\\}`));
  assert.ok(m, `\`${name}\` must exist`);
  return m[0];
};

/* ------------------------------------------------------------- fixtures --- */

const room = (id, name, over = {}) => ({
  id,
  name,
  members: [
    { tmuxSession: 'foreman-alpha-main', name: 'alpha-main', paneId: '%1', addedAt: 1 },
    { tmuxSession: 'foreman-beta-main', name: 'beta-main', paneId: '%2', addedAt: 1 },
  ],
  memberCount: 2,
  unseen: 0,
  seq: 0,
  lastAt: null,
  lastFrom: null,
  createdAt: 1,
  archivedAt: null,
  ...over,
});

/* ------------------------------------------------------------ the stub --- */

/**
 * Just enough DOM for `patchBand`, and deliberately no more.
 *
 * `test/trust-gate.test.js` set this pattern: the point is not to simulate a browser but to
 * *record* what the builder does, so a test can compare what came back. Everything
 * `patchBand` is allowed to touch is modelled — `children` as a live-enough array, `append`
 * that **moves** a node that is already a child (which is what makes the reorder and the
 * reuse one pass in a real DOM), `remove`, and `dataset`. Anything it grows later that this
 * does not model throws rather than passing quietly.
 */
function withDom(fn) {
  const real = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const node = {
        tagName: tag.toUpperCase(),
        type: '',
        className: '',
        textContent: '',
        title: '',
        hidden: false,
        dataset: {},
        attrs: {},
        children: [],
        parent: null,
        onclick: null,
        setAttribute: (k, v) => (node.attrs[k] = v),
        append(...kids) {
          for (const kid of kids) {
            // A real `append` on a node that is already a child moves it. Model that, or a
            // test would pass on a reorder that duplicates every row on screen.
            if (kid.parent) kid.parent.children.splice(kid.parent.children.indexOf(kid), 1);
            kid.parent = node;
            node.children.push(kid);
          }
        },
        remove() {
          if (!node.parent) return;
          node.parent.children.splice(node.parent.children.indexOf(node), 1);
          node.parent = null;
        },
      };
      return node;
    },
  };
  try {
    return fn();
  } finally {
    globalThis.document = real;
  }
}

/** A container shaped like the one `patchBand` is handed. */
const container = () => ({
  children: [],
  append(...kids) {
    for (const kid of kids) {
      if (kid.parent) kid.parent.children.splice(kid.parent.children.indexOf(kid), 1);
      kid.parent = this;
      this.children.push(kid);
    }
  },
});

const span = (row, cls) => row.children.find((c) => c.className === cls);

/* ------------------------------------------------------- the partition --- */

test('a room is open or archived by `archivedAt`, never by a word it does not carry', () => {
  const rooms = [room('r1', 'alpha ↔ beta'), room('r2', 'gamma', { archivedAt: 5 })];
  const { open, archived } = partitionRooms(rooms);
  assert.deepEqual(
    open.map((r) => r.id),
    ['r1'],
  );
  assert.deepEqual(
    archived.map((r) => r.id),
    ['r2'],
  );
  // The record has no `state` field and the client must never invent one.
  assert.ok(!/room\.state|r\.state\b/.test(strip(band)), 'the band decides on `archivedAt` alone');
});

test('a malformed frame draws an empty band rather than throwing', () => {
  assert.deepEqual(partitionRooms(undefined), { open: [], archived: [] });
  assert.deepEqual(partitionRooms(null), { open: [], archived: [] });
  assert.deepEqual(partitionRooms('rooms'), { open: [], archived: [] });
  assert.deepEqual(partitionRooms([null, {}, { id: '' }]), { open: [], archived: [] });
});

test('the store’s order is kept — the band never re-sorts on `lastAt`', () => {
  const rooms = [room('r1', 'first', { lastAt: 9 }), room('r2', 'second', { lastAt: 1 })];
  assert.deepEqual(
    partitionRooms(rooms).open.map((r) => r.id),
    ['r1', 'r2'],
    'a band that reordered itself when anybody spoke would move a row under the cursor',
  );
});

/* ------------------------------------------------------------- the fold --- */

test('with no archived rooms there is no fold at all', () => {
  const entries = bandEntries([room('r1', 'alpha ↔ beta')]);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['room'],
  );
});

test('archived rooms fold into one entry, and their rows are not drawn while it is shut', () => {
  const rooms = [room('r1', 'open one'), room('r2', 'gone', { archivedAt: 5 }), room('r3', 'also gone', { archivedAt: 6 })];
  const shut = bandEntries(rooms, { archivedCollapsed: true });
  assert.deepEqual(
    shut.map((e) => e.kind),
    ['room', 'fold'],
  );
  assert.equal(shut[1].count, 2, 'the fold counts what it is hiding');
  assert.equal(shut[1].key, ARCHIVED_KEY);

  const opened = bandEntries(rooms, { archivedCollapsed: false });
  assert.deepEqual(
    opened.map((e) => e.kind),
    ['room', 'fold', 'room', 'room'],
  );
  assert.ok(
    opened.slice(2).every((e) => e.archived === true),
    'an archived row says so, because it opens a room that accepts nothing',
  );
});

test('the fold defaults to shut', () => {
  const rooms = [room('r1', 'gone', { archivedAt: 5 })];
  assert.deepEqual(
    bandEntries(rooms).map((e) => e.kind),
    ['fold'],
  );
});

test('the fold is a sibling of the rows it opens, never a box around them', () => {
  const rooms = [room('r1', 'gone', { archivedAt: 5 })];
  const entries = bandEntries(rooms, { archivedCollapsed: false });
  assert.ok(
    entries.every((e) => !('children' in e)),
    'nothing has to be taken apart to be patched',
  );
});

/* -------------------------------------------------------- the signature --- */

test('the signature is joined with real punctuation, never an empty string', () => {
  const sig = bandSig([room('r1', 'alpha ↔ beta'), room('r2', 'gamma')]);
  assert.match(sig, /~/, 'rows are separated');
  assert.match(sig, /\|/, 'fields within a row are separated');
  // `mergeSig`'s lesson: three literal control bytes once sat inside what every editor drew
  // as an empty string. Nothing invisible may be load-bearing here.
  assert.ok(!/[ --]/.test(sig), 'no control byte in the signature');
  assert.ok(!/join\(''\)/.test(strip(band)), 'nothing in the band joins with an empty string');
});

test('every field the row draws is in the signature', () => {
  const base = [room('r1', 'alpha ↔ beta')];
  const seen = bandSig(base);
  for (const [field, value] of [
    ['name', 'renamed'],
    ['memberCount', 3],
    ['unseen', 4],
    ['lastAt', 99],
    ['lastFrom', 'alpha-main'],
  ]) {
    assert.notEqual(
      bandSig([room('r1', 'alpha ↔ beta', { [field]: value })]),
      seen,
      `\`${field}\` is on the face, so a change to it must repaint`,
    );
  }
  assert.notEqual(bandSig(base, { openIds: ['r1'] }), seen, 'the open tint is on the face');
  assert.notEqual(
    bandSig([room('r1', 'x'), room('r2', 'gone', { archivedAt: 1 })], { archivedCollapsed: false }),
    bandSig([room('r1', 'x'), room('r2', 'gone', { archivedAt: 1 })], { archivedCollapsed: true }),
    'the fold’s own state is on the face',
  );
});

test('a beat that changed nothing spells the same signature', () => {
  const a = bandSig([room('r1', 'alpha ↔ beta'), room('r2', 'gamma', { archivedAt: 3 })]);
  const b = bandSig([room('r1', 'alpha ↔ beta'), room('r2', 'gamma', { archivedAt: 3 })]);
  assert.equal(a, b);
});

/* -------------------------------------------------------------- the row --- */

test('zero unseen draws nothing at all, and a long-quiet room cannot widen the rail', () => {
  assert.equal(unseenText(0), '');
  assert.equal(unseenText(null), '');
  assert.equal(unseenText(undefined), '');
  assert.equal(unseenText(1), '1');
  assert.equal(unseenText(99), '99');
  assert.equal(unseenText(100), '99+');
});

test('a member reads by whichever id it actually has', () => {
  assert.equal(memberLabel({ name: 'alpha-main', tmuxSession: 'foreman-alpha-main' }), 'alpha-main');
  assert.equal(memberLabel({ tmuxSession: 'foreman-beta-main', name: null, paneId: '%2' }), 'foreman-beta-main');
  assert.equal(memberLabel({ paneId: '%3' }), '%3');
  assert.equal(memberLabel(null), '');
});

test('the membership lives on the hover, and archived says so first', () => {
  const t = roomTitle(room('r1', 'alpha ↔ beta'));
  assert.match(t, /alpha-main, beta-main/);
  const arch = roomTitle(room('r1', 'alpha ↔ beta', { archivedAt: 5 }), { archived: true });
  assert.match(arch.split('\n')[1], /archived/);
});

/* ------------------------------------------ patched in place, not rebuilt --- */

test('the band draws nothing at all for an empty list', () => {
  withDom(() => {
    const list = container();
    patchBand(list, []);
    assert.equal(list.children.length, 0);
  });
});

test('one room is one row, with its name, its member count and no badge', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'alpha ↔ beta')]);
    assert.equal(list.children.length, 1);
    const [row] = list.children;
    assert.equal(row.tagName, 'BUTTON');
    assert.equal(span(row, 'room-name').textContent, 'alpha ↔ beta');
    assert.equal(span(row, 'room-count').textContent, '2');
    assert.equal(span(row, 'room-unseen').hidden, true, 'zero draws nothing');
  });
});

test('the same node survives two frames — patched, never rebuilt', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'alpha ↔ beta'), room('r2', 'gamma')]);
    const first = [...list.children];

    // A second frame that genuinely changed something, so the patch path actually runs.
    patchBand(list, [room('r1', 'alpha ↔ beta', { unseen: 3 }), room('r2', 'gamma')]);
    const second = [...list.children];

    assert.equal(second.length, 2);
    assert.equal(second[0], first[0], 'the row a cursor is on is the node it was');
    assert.equal(second[1], first[1]);
    assert.equal(span(second[0], 'room-unseen').textContent, '3', 'and it was patched');
    assert.equal(span(second[0], 'room-unseen').hidden, false);
  });
});

test('a new room joins without disturbing the rows already there', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'alpha ↔ beta')]);
    const [kept] = list.children;
    patchBand(list, [room('r1', 'alpha ↔ beta'), room('r2', 'gamma')]);
    assert.equal(list.children.length, 2);
    assert.equal(list.children[0], kept);
  });
});

test('a room that goes away takes its node with it, and takes nothing else', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'alpha ↔ beta'), room('r2', 'gamma')]);
    const kept = list.children[1];
    patchBand(list, [room('r2', 'gamma')]);
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0], kept);
  });
});

test('opening the fold keeps the fold’s own node and the rows above it', () => {
  withDom(() => {
    const list = container();
    const rooms = [room('r1', 'open one'), room('r2', 'gone', { archivedAt: 5 })];
    patchBand(list, rooms, { archivedCollapsed: true });
    assert.equal(list.children.length, 2);
    const [openRow, fold] = list.children;
    assert.equal(fold.className, 'room-fold');
    assert.equal(span(fold, 'room-fold-caret').textContent, '▸');

    patchBand(list, rooms, { archivedCollapsed: false });
    assert.equal(list.children.length, 3);
    assert.equal(list.children[0], openRow);
    assert.equal(list.children[1], fold, 'the control that was just pressed is the same node');
    assert.equal(span(fold, 'room-fold-caret').textContent, '▾');
    assert.match(list.children[2].className, /is-archived/);
  });
});

test('a row points at a room id, never at its position', () => {
  withDom(() => {
    const list = container();
    const opened = [];
    patchBand(list, [room('r1', 'alpha ↔ beta'), room('r2', 'gamma')], {
      onOpen: (id) => opened.push(id),
    });
    list.children[1].onclick();
    assert.deepEqual(opened, ['r2']);
  });
});

test('a reused row is re-bound, so a handler can never close over a stale record', () => {
  withDom(() => {
    const list = container();
    const opened = [];
    patchBand(list, [room('r1', 'alpha ↔ beta')], { onOpen: () => opened.push('first') });
    patchBand(list, [room('r1', 'alpha ↔ beta', { unseen: 1 })], { onOpen: () => opened.push('second') });
    list.children[0].onclick();
    assert.deepEqual(opened, ['second']);
  });
});

test('the room you are looking at shows no unseen count, whatever the summary said', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'alpha ↔ beta', { unseen: 7 })], { openIds: ['r1'] });
    const [row] = list.children;
    assert.match(row.className, /is-open/);
    assert.equal(span(row, 'room-unseen').hidden, true, '`markGroupRoomRead` is a round trip');
  });
});

/* ---------------------------------------------------- the band in the app --- */

test('the rows are shown only when a room exists, and the gate is a CSS trade', () => {
  const render = fn('renderRoomsBand');
  assert.match(render, /classList\.toggle\('has-rooms', rooms\.length > 0\)/);
  // The markup is always there and CSS decides — `.app.has-links`'s trade one band down,
  // and `.app.split .main`'s two columns over.
  assert.match(styles, /\.rooms-list\s*\{[^}]*display:\s*none/);
  assert.match(styles, /\.app\.has-rooms \.rooms-list\s*\{\s*display:\s*flex/);
  assert.match(html, /class="rail-rooms" id="railRooms"/);
});

test('the head is persistent — `+ room` is in the rail with `rooms: []`', () => {
  /*
   * The one place this band does not copy `.app.has-links`, and it is a ruling rather than
   * an oversight. `+ room` is the only way into the create modal (plan §2 item 8), so a gate
   * over the whole band would mean the first room could never be made from the panel — the
   * control would appear only once traffic existed, which is exactly what the shared-room
   * row above refuses to do in its own markup's words. So the gate names `.rooms-list` and
   * only `.rooms-list`.
   *
   * Written as three assertions rather than one because each fails for a different edit: a
   * `display: none` creeping back onto the band, a gate widened to the band, and the head
   * being moved inside the list where the gate would swallow it anyway.
   */
  const band = styles.match(/\.rail-rooms\s*\{[^}]*\}/)[0];
  assert.match(band, /display:\s*flex/, 'the band itself is never hidden');
  assert.ok(!/display:\s*none/.test(band), 'the band carries no hidden state of its own');
  assert.ok(
    !/\.app\.has-rooms \.rail-rooms/.test(styles) && !/\.app\.has-rooms \.rooms-head/.test(styles),
    'the gate names the list alone — never the band, never the head',
  );
  // …and the head is a sibling of the list, which is what makes that gate possible at all.
  const markup = html.slice(html.indexOf('<div class="rail-rooms"'), html.indexOf('</div>', html.indexOf('id="roomsList"')));
  const head = markup.indexOf('class="rooms-head"');
  const list = markup.indexOf('id="roomsList"');
  assert.ok(head > -1 && list > head, 'the head opens and closes before the list begins');
  assert.match(markup.slice(head, list), /id="roomsAdd"/, '`+ room` lives in the head');
  assert.ok(
    !/rooms-head/.test(markup.slice(list)),
    'the head is not inside the list, where the gate would hide it anyway',
  );
});

test('the band is a sibling of `.rail-list`, never a block inside it', () => {
  const rail = html.slice(html.indexOf('<div class="rail-list"'), html.indexOf('class="rail-foot"'));
  assert.match(rail, /class="rail-list" id="railList"><\/div>/, 'the list closes before the bands begin');
  const list = html.indexOf('<div class="rail-list"');
  const listEnd = html.indexOf('</div>', list);
  const rooms = html.indexOf('<div class="rail-rooms"');
  assert.ok(rooms > listEnd, 'the rooms band opens after the list has closed');
  // An open group's tint is tiled from three full-width rows *inside* that list, and
  // `.folder-label.in-group`'s sticky `top` is a hand-measured offset against the row
  // heights in there. A vertical margin out here would cut through the first.
  const decl = styles.match(/\.rail-rooms\s*\{[^}]*\}/)[0];
  assert.ok(!/\bmargin\b/.test(decl), 'the band carries no vertical margin');
});

test('the band sits below the shared row and above the connections', () => {
  const shared = html.indexOf('class="rail-shared"');
  const rooms = html.indexOf('<div class="rail-rooms"');
  const conn = html.indexOf('class="pane-grip grip-row conn-grip"');
  assert.ok(shared < rooms && rooms < conn);
});

test('the rooms band never joins `composerSig`', () => {
  const sig = app.match(/const composerSig = \(s\)[\s\S]*?\.join\('\|'\);/)[0];
  assert.ok(!/room/i.test(sig), '`composerSig` must know nothing about rooms');
  // …and the two signatures are genuinely different things, not one reused.
  assert.match(app, /let roomsSig = '';/);
  const render = fn('renderRoomsBand');
  assert.ok(!/composerSig/.test(render));
});

test('the frame is read with `in`, never a truth test', () => {
  assert.match(code, /if \('rooms' in msg\) state\.rooms = Array\.isArray\(msg\.rooms\) \? msg\.rooms : \[\];/);
  // An empty array is the ordinary answer — most of the time there are no rooms — and a
  // truth test reads that as "the frame didn't mention it", pinning rows for rooms that
  // have since been deleted. `rateLimits` learned this the expensive way.
  assert.ok(!/if \(msg\.rooms\)/.test(code), 'never a truth test on the rooms field');
});

test('the band is drawn on the roster beat, from `renderRail`, on both its paths', () => {
  // `fn` above stops at the first line that closes at its own indent, which is fine for a
  // short helper and wrong for `renderRail` — that one is full of nested blocks. Sliced to
  // the next top-level declaration instead.
  const at = app.indexOf('function renderRail(');
  assert.ok(at > -1, '`renderRail` must exist');
  const rail = app.slice(at, app.indexOf('\n/* ---', at));
  assert.equal(
    (rail.match(/renderRoomsBand\(\);/g) || []).length,
    2,
    'the flat path and the grouped path both end in a drawn band',
  );
});

test('the two hooks items 8 and 9/10 fill in are named, and do nothing else yet', () => {
  const open = fn('openGroupRoom');
  const create = fn('openCreateRoom');
  for (const stub of [open, create]) {
    assert.match(stub, /console\.info/);
    assert.ok(!/fetch\(/.test(stub), 'a hook that quietly called an endpoint would be a half-built feature');
  }
  assert.match(fn('renderRoomsBand'), /onOpen: openGroupRoom/);
  assert.match(code, /el\.roomsAdd\.onclick = openCreateRoom;/);
});

test('the head’s control is bound once at boot, because the head is markup', () => {
  // The rows are the other way round — built on demand, re-bound on every patch. Binding a
  // node a repaint replaces is how a control stops working with nothing on screen to say so.
  assert.match(code, /if \(el\.roomsAdd\) el\.roomsAdd\.onclick = openCreateRoom;/);
  assert.match(code, /roomsAdd: document\.getElementById\('roomsAdd'\)/);
});

test('the name ellipsises and no number ever shrinks — the rail is 20rem', () => {
  const name = styles.match(/\.room-name\s*\{[^}]*\}/)[0];
  assert.match(name, /text-overflow:\s*ellipsis/);
  assert.match(name, /min-width:\s*0/);
  for (const cls of ['.room-count', '.room-unseen', '.room-mark']) {
    const decl = styles.match(new RegExp(`\\${cls}\\s*\\{[^}]*\\}`))[0];
    assert.match(decl, /flex:\s*none/, `${cls} must never shrink`);
  }
});

test('both themes, by tokens rather than by literal colours', () => {
  const block = styles.slice(styles.indexOf('/* ============================================================= rooms ==='), styles.indexOf('/* ======================================================= connections ==='));
  assert.ok(block.length > 500, 'the rooms block is where these rules live');
  // Every colour in the band is a token, so the light and dark palettes both answer for it
  // — the same reason `--shelf` and `--row-open` exist rather than two hand-picked tints.
  const colours = block.match(/(?:^|[\s:])(#[0-9a-f]{3,8}|rgba?\()/gim) || [];
  assert.deepEqual(colours, [], 'no literal colour may be defined only for one theme');
  assert.match(block, /var\(--row-open\)/, 'the open row borrows the rail’s own answer');
});
