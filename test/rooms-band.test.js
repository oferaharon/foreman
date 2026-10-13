import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVED_KEY,
  bandEntries,
  bandSig,
  isRecent,
  livenessText,
  memberLabel,
  nextAgeTick,
  nextBandTick,
  nextUnlight,
  partitionRooms,
  patchBand,
  RECENT_MS,
  relightBand,
  roomAge,
  roomLiveness,
  roomTitle,
  unseenText,
} from '../web/rooms-band.js';
import { ageText } from '../web/group-summary.js';
import { memberRow } from '../web/rooms-pane.js';
import { newestCreatedFirst } from '../web/rooms-newest.js';

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
        removeAttribute: (k) => delete node.attrs[k],
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

/**
 * A container shaped like the one `patchBand` is handed.
 *
 * `moves` counts every insertion, a new node's included, because a move is what the band
 * must not make for a row already in place (`place` in `web/rooms-band.js`): moving rows
 * round a focused one is what scrolled the real band to the top. `append` is still modelled
 * and still counted, so a patch that drifted back to re-appending would show up as moves
 * rather than as a missing method.
 */
const container = () => ({
  children: [],
  moves: 0,
  append(...kids) {
    for (const kid of kids) this.insertBefore(kid, null);
  },
  insertBefore(kid, ref) {
    this.moves += 1;
    if (kid.parent) kid.parent.children.splice(kid.parent.children.indexOf(kid), 1);
    kid.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (ref && at < 0) throw new Error('insertBefore: the reference node is not a child');
    if (at < 0) this.children.push(kid);
    else this.children.splice(at, 0, kid);
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

test('the shared module’s default is untouched by either screen’s sort', () => {
  /*
   * The maintainer's ruling of **2026-09-16** put the *phone's* Rooms tab into recency order
   * (`roomsListView`, `web/m/rooms.js`). This module is shared with the rail band, so the one
   * thing that had to stay true is that the Mac's order did not move — and that the phone got
   * there without an option here, because an opt-in flag is a flag the rail can one day be
   * handed by accident.
   *
   * The fixture is chosen so a recency sort would be *visible*: creation order and `lastAt`
   * order disagree on every row, in both sections.
   */
  const rooms = [
    room('r1', 'oldest word', { lastAt: 1 }),
    room('r2', 'newest word', { lastAt: 900 }),
    room('r3', 'never spoken', { lastAt: null }),
    room('r4', 'archived, old', { archivedAt: 5, lastAt: 2 }),
    room('r5', 'archived, new', { archivedAt: 6, lastAt: 800 }),
  ];

  const ids = (entries) => entries.map((e) => (e.kind === 'fold' ? 'fold' : e.room.id));
  assert.deepEqual(ids(bandEntries(rooms)), ['r1', 'r2', 'r3', 'fold']);
  assert.deepEqual(ids(bandEntries(rooms, { archivedCollapsed: false })), [
    'r1',
    'r2',
    'r3',
    'fold',
    'r4',
    'r5',
  ]);

  // `partitionRooms` hands both halves back in the order it was given them, which is the
  // property the phone's sort-before-partition leans on: recency orders *within* a section.
  const { open, archived } = partitionRooms(rooms);
  assert.deepEqual(open.map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(archived.map((r) => r.id), ['r4', 'r5']);

  // And the module offers nothing to opt in with. `bandEntries` takes exactly one option.
  const sorted = [...rooms].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  assert.notDeepEqual(ids(bandEntries(sorted)), ids(bandEntries(rooms)), 'the fixture would show a sort');
  assert.ok(
    !/lastAt/.test(fn('bandEntries', band)) && !/lastAt/.test(fn('partitionRooms', band)),
    'neither function so much as reads `lastAt`',
  );
  // Scoped to the two functions the phone shares. The module does know the word now —
  // `isRecent` lights the rail's `◎` — but that is a mark on a row, never an order, and it
  // lives outside both of these.
  for (const name of ['bandEntries', 'partitionRooms']) {
    assert.ok(
      !/recent|newest|sort/i.test(strip(fn(name, band)).replace(/'[^']*'/g, '')),
      `no recency option was added to \`${name}\``,
    );
  }
  assert.match(fn('bandEntries', band), /\{ archivedCollapsed = true \} = \{\}/, 'one option, still');
});

/* --------------------------------------------------- the desktop's order --- */

const bandIds = (rooms, opts) =>
  bandEntries(rooms, opts).map((e) => (e.kind === 'fold' ? 'fold' : e.room.id));

test('the desktop draws the room made most recently first, open above archived', () => {
  // Store order (oldest first), with `lastAt` disagreeing with creation on every row so an
  // activity sort would be visible.
  const store = [
    room('r1', 'first made', { createdAt: 100, lastAt: 900 }),
    room('r2', 'second made', { createdAt: 200, lastAt: 1 }),
    room('r3', 'third made', { createdAt: 300, lastAt: null }),
    room('r4', 'archived, old', { createdAt: 150, archivedAt: 5, lastAt: 800 }),
    room('r5', 'archived, new', { createdAt: 250, archivedAt: 6, lastAt: 2 }),
  ];
  const sorted = newestCreatedFirst(store);
  assert.deepEqual(bandIds(sorted), ['r3', 'r2', 'r1', 'fold']);
  assert.deepEqual(bandIds(sorted, { archivedCollapsed: false }), ['r3', 'r2', 'r1', 'fold', 'r5', 'r4']);
  assert.deepEqual(store.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5'], 'the input is not mutated');
});

test('a post moves nothing: the order is the same before and after `lastAt` changes', () => {
  const before = [room('r1', 'a', { createdAt: 100 }), room('r2', 'b', { createdAt: 200 })];
  const after = [room('r1', 'a', { createdAt: 100, lastAt: 5000 }), room('r2', 'b', { createdAt: 200 })];
  assert.deepEqual(bandIds(newestCreatedFirst(before)), ['r2', 'r1']);
  assert.deepEqual(bandIds(newestCreatedFirst(after)), ['r2', 'r1']);
});

test('ties and unstamped rooms fall back to the reverse of the store’s order', () => {
  // `list()` is oldest first, so later in the store = made later = first. Records from before
  // `createdAt` read 0 and sit below every stamped room.
  const store = [
    room('r1', 'old, no stamp', { createdAt: 0 }),
    room('r2', 'old, no stamp too', { createdAt: 0 }),
    room('r3', 'stamped', { createdAt: 50 }),
    room('r4', 'same stamp', { createdAt: 50 }),
    room('r5', 'archived tie a', { createdAt: 7, archivedAt: 1 }),
    room('r6', 'archived tie b', { createdAt: 7, archivedAt: 1 }),
  ];
  assert.deepEqual(bandIds(newestCreatedFirst(store), { archivedCollapsed: false }), [
    'r4',
    'r3',
    'r2',
    'r1',
    'fold',
    'r6',
    'r5',
  ]);
  // Unreadable stamps are 0, and nothing is dropped or thrown on.
  const odd = [room('a', 'a', { createdAt: 'x' }), room('b', 'b', { createdAt: -4 }), room('c', 'c', { createdAt: 9 })];
  assert.deepEqual(newestCreatedFirst(odd).map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(newestCreatedFirst(undefined), []);
  assert.equal(newestCreatedFirst([null, room('z', 'z')]).length, 2);
});

test('the sort is wired in the desktop caller, once, and never into the shared module', () => {
  const body = strip(fn('renderRoomsBand'));
  assert.match(body, /newestCreatedFirst\(state\.rooms\)/, 'renderRoomsBand sorts what it hands over');
  assert.ok(!/state\.rooms\b/.test(body.replace(/newestCreatedFirst\(state\.rooms\)/, '')), 'one sorted array feeds signature and patch');
  assert.ok(!/newestCreatedFirst|createdAt/.test(strip(band)), 'the shared module does not know the order');
  assert.ok(!/lastAt/.test(strip(fs.readFileSync(path.join(ROOT, 'web/rooms-newest.js'), 'utf8'))), 'creation only, never activity');
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

/* ------------------------------------- a row in place is never moved --- */

/** Node identity, element by element — `deepEqual` would also pass on two equal copies. */
const sameNodes = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);

const eight = () => Array.from({ length: 8 }, (_, i) => room(`r${8 - i}`, `room ${8 - i}`, { createdAt: 8 - i }));

test('a click’s repaint moves no row — moving them round a focused one scrolled the band to the top', () => {
  withDom(() => {
    const list = container();
    patchBand(list, eight());
    const before = [...list.children];
    list.moves = 0;

    // Exactly the patch a band click causes: the lowest room turns `is-open`, nothing else.
    patchBand(list, eight(), { openIds: ['r1'] });
    assert.equal(list.moves, 0, 'a row already in place is left where it is');
    assert.ok(sameNodes(list.children, before), 'and every node is the one it was');
    assert.match(list.children[7].className, /is-open/, 'while still being patched');

    // And the frames after it, which a roster beat re-signs on anything the band shows.
    patchBand(list, eight().map((r) => ({ ...r, unseen: 2 })), { openIds: ['r1'] });
    assert.equal(list.moves, 0);
  });
});

test('pressing the archived fold moves neither the rows above it nor the fold itself', () => {
  withDom(() => {
    const list = container();
    const rooms = [...eight(), room('r0', 'gone', { createdAt: 0, archivedAt: 5 })];
    patchBand(list, rooms, { archivedCollapsed: true });
    list.moves = 0;
    patchBand(list, rooms, { archivedCollapsed: false });
    assert.equal(list.moves, 1, 'only the archived row arriving below the fold');
    list.moves = 0;
    patchBand(list, rooms, { archivedCollapsed: true });
    assert.equal(list.moves, 0, 'and shutting it only takes that row away');
    assert.equal(list.children.length, 9);
  });
});

test('a room arriving above the rows is the only node that moves', () => {
  withDom(() => {
    const list = container();
    patchBand(list, eight());
    const before = [...list.children];
    list.moves = 0;
    patchBand(list, [room('r9', 'room 9', { createdAt: 9 }), ...eight()]);
    assert.equal(list.moves, 1);
    assert.ok(sameNodes(list.children.slice(1), before));
  });
});

test('a room going away is taken out before the pass, so the rows behind it stay put', () => {
  withDom(() => {
    const list = container();
    patchBand(list, eight());
    const behind = [...list.children].slice(4);
    list.moves = 0;
    // `r5` is the fourth row. Removed only after the pass, its node would sit at index 3 and
    // every row behind it would be moved in front of it, one by one.
    patchBand(list, eight().filter((r) => r.id !== 'r5'));
    assert.equal(list.moves, 0);
    assert.ok(sameNodes(list.children.slice(3), behind));
  });
});

test('a reorder still comes out in the order the frame says', () => {
  withDom(() => {
    const list = container();
    const rooms = eight();
    patchBand(list, rooms);
    // `r6` archived with the fold open: it leaves the open rows for the foot of the band.
    const next = rooms.map((r) => (r.id === 'r6' ? { ...r, archivedAt: 5 } : r));
    patchBand(list, next, { archivedCollapsed: false });
    assert.deepEqual(
      list.children.map((n) => n.dataset.roomKey),
      ['r8', 'r7', 'r5', 'r4', 'r3', 'r2', 'r1', ARCHIVED_KEY, 'r6'].map((k) => (k === ARCHIVED_KEY ? k : `room:${k}`)),
    );
    // And back again, unarchived into its created position.
    patchBand(list, rooms, { archivedCollapsed: false });
    assert.deepEqual(
      list.children.map((n) => n.dataset.roomKey),
      rooms.map((r) => `room:${r.id}`),
    );
  });
});

test('`patchBand` places rows through `place` and never re-appends them', () => {
  const start = band.indexOf('export function patchBand(');
  const body = strip(band.slice(start, band.indexOf('\n}\n', start)));
  assert.ok(start >= 0, '`patchBand` must exist');
  assert.ok(!/\blist\.append\(/.test(body), 'a re-append moves a row that is already in place');
  assert.match(body, /place\(list, row, drawn\.length\)/);
  assert.match(strip(band), /function place\(list, row, index\) \{[\s\S]*?if \(at !== row\) list\.insertBefore\(row, at\);/);
});

/* ------------------------------------------------------------- the mark --- */

const NOW = 1_000_000_000;
const MIN = 60_000;
const mark = (row) => row.children.find((c) => /^room-mark\b/.test(c.className));

test('the mark is lit inside ten minutes, out at the edge and past it', () => {
  assert.equal(RECENT_MS, 10 * MIN);
  assert.equal(isRecent(room('r1', 'a', { lastAt: NOW }), NOW), true, 'just now');
  assert.equal(isRecent(room('r1', 'a', { lastAt: NOW - 9 * MIN }), NOW), true, 'inside the window');
  assert.equal(isRecent(room('r1', 'a', { lastAt: NOW - RECENT_MS + 1 }), NOW), true, 'a millisecond inside');
  assert.equal(isRecent(room('r1', 'a', { lastAt: NOW - RECENT_MS }), NOW), false, 'exactly ten minutes is out');
  assert.equal(isRecent(room('r1', 'a', { lastAt: NOW - 11 * MIN }), NOW), false, 'past it');
});

test('a room never spoken in, an archived room and a malformed one are never lit', () => {
  assert.equal(isRecent(room('r1', 'a', { lastAt: null }), NOW), false, '`null` lastAt');
  assert.equal(isRecent(room('r1', 'a', { lastAt: NOW, archivedAt: NOW }), NOW), false, 'archived');
  assert.equal(isRecent(null, NOW), false);
  assert.equal(isRecent(room('r1', 'a', { lastAt: 'soon' }), NOW), false);
});

test('the next expiry is the soonest lit room’s, and there is none with nothing lit', () => {
  const rooms = [
    room('r1', 'a', { lastAt: NOW - 2 * MIN }),
    room('r2', 'b', { lastAt: NOW - 7 * MIN }),
    room('r3', 'c', { lastAt: NOW - 30 * MIN }),
    room('r4', 'd', { lastAt: NOW - MIN, archivedAt: 5 }),
  ];
  assert.equal(nextUnlight(rooms, NOW), 3 * MIN, 'r2 goes out first; r3 is already out, r4 is archived');
  assert.equal(nextUnlight([room('r1', 'a')], NOW), null, 'no timer for a band with nothing lit');
  assert.equal(nextUnlight(undefined, NOW), null);
});

test('a patched row wears the lit class, and loses it on the next patch once quiet', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'a', { lastAt: NOW - MIN }), room('r2', 'b', { lastAt: NOW - 20 * MIN })], { now: NOW });
    const [lit, quiet] = list.children;
    assert.equal(mark(lit).className, 'room-mark is-lit');
    assert.equal(mark(quiet).className, 'room-mark');
    assert.equal(mark(lit).textContent, '◎', 'the glyph is unchanged');

    patchBand(list, [room('r1', 'a', { lastAt: NOW - MIN }), room('r2', 'b', { lastAt: NOW - 20 * MIN })], {
      now: NOW + 10 * MIN,
    });
    assert.equal(list.children[0], lit, 'patched, never rebuilt');
    assert.equal(mark(lit).className, 'room-mark');
  });
});

test('an archived row is never lit, however recent its last post', () => {
  withDom(() => {
    const list = container();
    patchBand(list, [room('r1', 'gone', { archivedAt: 5, lastAt: NOW })], { archivedCollapsed: false, now: NOW });
    const row = list.children.find((c) => c.dataset.roomKey === 'room:r1');
    assert.equal(mark(row).className, 'room-mark');
  });
});

test('the timer’s relight puts a mark out in place, moving and rebuilding nothing', () => {
  withDom(() => {
    const list = container();
    const rooms = [room('r1', 'a', { lastAt: NOW - MIN, unseen: 2 }), room('r2', 'gone', { archivedAt: 5 })];
    patchBand(list, rooms, { archivedCollapsed: true, now: NOW });
    const before = [...list.children];
    const [row] = before;
    assert.equal(mark(row).className, 'room-mark is-lit');

    relightBand(list, rooms, NOW + 9 * MIN - 1);
    assert.equal(mark(row).className, 'room-mark is-lit', 'still inside the window');

    relightBand(list, rooms, NOW + 9 * MIN);
    assert.equal(mark(row).className, 'room-mark', 'out once the window runs out');
    assert.deepEqual([...list.children], before, 'same nodes, same order');
    assert.equal(span(row, 'room-unseen').textContent, '2', 'the badge is untouched');
    assert.equal(span(row, 'room-count').textContent, '2', 'and so is the member count');

    relightBand(null, rooms, NOW);
    relightBand(list, [], NOW);
    assert.equal(mark(row).className, 'room-mark', 'a room gone from the frame is the next patch’s job');
  });
});

test('the app re-arms one expiry timer on every patch, and the timer only relights', () => {
  // Sliced by hand: `fn` stops at the first two-space `}`, which is `patchBand`'s own `});`.
  const from = app.indexOf('\nfunction renderRoomsBand(');
  const render = app.slice(from, app.indexOf('\n}\n', from));
  assert.ok(
    render.indexOf('scheduleRoomsTick();') > render.indexOf('patchBand('),
    'the timer is re-armed after the patch that may have lit a mark',
  );
  const schedule = fn('scheduleRoomsTick');
  assert.match(schedule, /clearTimeout\(roomsTickTimer\)/, 'one timer, never a pile of them');
  // One timer for both clock-driven words — the `◎` going out and the age moving on — never
  // a second `setTimeout` beside it for the ages.
  assert.match(schedule, /nextBandTick\(state\.rooms\)/);
  assert.equal((code.match(/roomsTickTimer = setTimeout/g) || []).length, 1, 'exactly one band timer');
  assert.match(schedule, /relightBand\(el\.roomsList, state\.rooms\)/);
  assert.ok(!/patchBand|replaceChildren|roomsSig/.test(strip(schedule)), 'the timer never rebuilds the band');
  assert.match(styles, /\.room-mark\.is-lit\s*\{\s*color:\s*var\(--accent\);\s*\}/, 'lit is the accent token');
});

/* ------------------------------------------------------------- the age --- */

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('the age is the rail’s own buckets, read off `lastAt`, at every boundary', () => {
  const at = (ago) => roomAge(room('r1', 'a', { lastAt: NOW - ago }), NOW);
  assert.equal(at(0), 'now');
  assert.equal(at(59_999), 'now', 'under a minute is now');
  assert.equal(at(MIN), '1m', 'a minute is a minute');
  assert.equal(at(5 * MIN), '5m');
  assert.equal(at(HOUR - 1), '59m', 'never 60m');
  assert.equal(at(HOUR), '1h');
  assert.equal(at(3 * HOUR + 59 * MIN), '3h', 'floored, never rounded up');
  assert.equal(at(DAY - 1), '23h', 'never 24h');
  assert.equal(at(DAY), '1d');
  assert.equal(at(2 * DAY + 23 * HOUR), '2d');
  // The same function the rail's session rows read, so the two can never disagree.
  for (const ago of [0, MIN, HOUR, DAY, 9 * DAY]) assert.equal(at(ago), ageText(NOW - ago, NOW));
  // A clock a little behind the server's must not print a negative age.
  assert.equal(roomAge(room('r1', 'a', { lastAt: NOW + 5000 }), NOW), 'now');
});

test('a room nobody has spoken in has no age, and a malformed one has none either', () => {
  assert.equal(roomAge(room('r1', 'a', { lastAt: null }), NOW), '', 'not an age since it was made');
  assert.equal(roomAge(room('r1', 'a', { lastAt: 0 }), NOW), '');
  assert.equal(roomAge(room('r1', 'a', { lastAt: 'soon' }), NOW), '');
  assert.equal(roomAge(null, NOW), '');
});

test('archived rooms carry an age — unlike the `◎`, which they never light', () => {
  const gone = room('r1', 'gone', { archivedAt: NOW - DAY, lastAt: NOW - 2 * DAY });
  assert.equal(roomAge(gone, NOW), '2d');
  assert.equal(isRecent(room('r2', 'x', { archivedAt: 1, lastAt: NOW }), NOW), false, 'the mark is unchanged');
});

test('the age is imported, never re-spelled', () => {
  const src = strip(band);
  assert.match(band, /import \{ ageText \} from '\.\/group-summary\.js';/);
  assert.match(fn('roomAge', band), /ageText\(/);
  // No second spelling of the buckets' words anywhere in the module.
  assert.ok(!/`[^`]*\}(m|h|d)`/.test(src), 'no `${n}m` / `${n}h` / `${n}d` template in the band');
  assert.ok(!/'now'/.test(src), 'no second `now`');
});

test('the next age tick is the next whole step of the soonest-changing age', () => {
  const tick = (...agos) => nextAgeTick(agos.map((ago, i) => room(`r${i}`, 'a', { lastAt: NOW - ago })), NOW);
  assert.equal(tick(0), MIN, '`now` becomes `1m` a minute after the post');
  assert.equal(tick(30_000), 30_000);
  assert.equal(tick(5 * MIN + 20_000), 40_000, '`5m` becomes `6m` at the next whole minute');
  assert.equal(tick(HOUR - MIN), MIN, '`59m` becomes `1h`');
  assert.equal(tick(3 * HOUR + 10 * MIN), 50 * MIN, '`3h` only changes on the hour');
  assert.equal(tick(DAY - HOUR), HOUR, '`23h` becomes `1d`');
  assert.equal(tick(2 * DAY + HOUR), DAY - HOUR, '`2d` only changes on the day');
  assert.equal(tick(2 * DAY, 4 * MIN + 1000), 59_000, 'the soonest of several');
  // Archived rooms count: they are aged too, and their age has to move on as well.
  assert.equal(nextAgeTick([room('r1', 'a', { lastAt: NOW - 30_000, archivedAt: 5 })], NOW), 30_000);
  assert.equal(nextAgeTick([room('r1', 'a')], NOW), null, 'no posts, no tick');
  assert.equal(nextAgeTick(undefined, NOW), null);
  assert.equal(nextAgeTick([null, { id: '' }, room('r1', 'a', { lastAt: 'soon' })], NOW), null);
});

test('the band’s one timer waits for whichever comes first, the `◎` or an age', () => {
  // Lit for two more minutes, aged `8m` — the age moves first.
  assert.equal(nextBandTick([room('r1', 'a', { lastAt: NOW - 8 * MIN - 10_000 })], NOW), 50_000);
  // Lit, and the `◎` goes out on exactly the beat its age turns `10m` — one wake for both.
  assert.equal(nextBandTick([room('r1', 'a', { lastAt: NOW - 9 * MIN })], NOW), MIN);
  // Long quiet: no mark, and the age moves on the hour.
  assert.equal(nextBandTick([room('r1', 'a', { lastAt: NOW - 3 * HOUR })], NOW), HOUR);
  assert.equal(nextBandTick([room('r1', 'a')], NOW), null, 'a band nobody has spoken in holds no timer');
});

test('a row draws its age beside its name, and an archived row draws one too', () => {
  withDom(() => {
    const list = container();
    patchBand(
      list,
      [
        room('r1', 'a', { lastAt: NOW - 3 * HOUR }),
        room('r2', 'quiet'),
        room('r3', 'gone', { archivedAt: 5, lastAt: NOW - 2 * DAY }),
      ],
      { archivedCollapsed: false, now: NOW },
    );
    const rows = list.children.filter((c) => /^room-row\b/.test(c.className));
    const [spoken, quiet, gone] = rows;
    const names = spoken.children.map((c) => c.className.split(' ')[0]);
    assert.deepEqual(names, ['room-mark', 'room-live', 'room-name', 'room-age', 'room-count', 'room-unseen']);
    assert.equal(span(spoken, 'room-age').textContent, '3h');
    assert.match(span(spoken, 'room-age').title, /^last post /);
    assert.equal(span(quiet, 'room-age').textContent, '', 'no posts, no age');
    assert.equal(span(quiet, 'room-age').title, '');
    assert.equal(span(gone, 'room-age').textContent, '2d', 'archived rooms are aged');
  });
});

test('the timer re-ages a row in place, and moves and rebuilds nothing', () => {
  withDom(() => {
    const list = container();
    const rooms = [room('r1', 'a', { lastAt: NOW - 59 * MIN, unseen: 2 })];
    patchBand(list, rooms, { now: NOW });
    const before = [...list.children];
    const [row] = before;
    assert.equal(span(row, 'room-age').textContent, '59m');
    relightBand(list, rooms, NOW + MIN);
    assert.equal(span(row, 'room-age').textContent, '1h');
    assert.deepEqual([...list.children], before, 'same nodes, same order');
    assert.equal(span(row, 'room-unseen').textContent, '2', 'nothing else on the row moved');
  });
});

/* ----------------------------------------------------------- the liveness --- */

/** Roster rows for the room fixture's two members, by tmux session name. */
const alphaRow = { id: 's1', tmuxSession: 'foreman-alpha-main', paneId: '%1', label: 'alpha-main', status: 'idle' };
const betaRow = { id: 's2', tmuxSession: 'foreman-beta-main', paneId: '%2', label: 'beta-main', status: 'working' };
const gammaRow = { id: 's3', tmuxSession: 'foreman-gamma-master', paneId: '%3', label: 'gamma-master', status: 'idle' };
const live = (rm, sessions) => roomLiveness(rm, sessions);

test('every member live is green, some is amber, none is grey', () => {
  const r = room('r1', 'alpha ↔ beta');
  assert.deepEqual(live(r, [alphaRow, betaRow, gammaRow]), { live: 2, total: 2, state: 'all' });
  assert.deepEqual(live(r, [betaRow, gammaRow]), { live: 1, total: 2, state: 'some' });
  assert.deepEqual(live(r, [gammaRow]), { live: 0, total: 2, state: 'none' });
  assert.deepEqual(live(r, []), { live: 0, total: 2, state: 'none' });
  assert.deepEqual(live(r, undefined), { live: 0, total: 2, state: 'none' });
});

test('a room of one is green when that one is live, grey when it is not', () => {
  const solo = room('r1', 'solo', { members: [{ tmuxSession: 'foreman-gamma-master', name: 'gamma-master' }] });
  assert.deepEqual(live(solo, [gammaRow]), { live: 1, total: 1, state: 'all' });
  assert.deepEqual(live(solo, [alphaRow]), { live: 0, total: 1, state: 'none' });
  assert.equal(livenessText(live(solo, [gammaRow])), '1 of 1 member live');
});

test('a room with nobody left in it is grey — there is nobody for a post to reach', () => {
  const empty = room('r1', 'empty', { members: [], memberCount: 0 });
  assert.deepEqual(live(empty, [alphaRow]), { live: 0, total: 0, state: 'none' });
  assert.equal(livenessText(live(empty, [alphaRow])), 'no members');
});

test('an archived room has no liveness at all, however alive its members are', () => {
  assert.equal(live(room('r1', 'gone', { archivedAt: 5 }), [alphaRow, betaRow]), null);
  assert.equal(livenessText(null), '');
  assert.equal(live(null, [alphaRow]), null);
});

test('liveness is `memberRow`’s answer, member by member — never a second resolution', () => {
  /*
   * Fixtures picked so a looser match would disagree with `memberRow`: a member whose pane id
   * is live but now carries a *different* name (rung 2 needs both witnesses), and a member
   * whose tmux session holds two Claude panes, neither its own (rung 1 declines a split).
   */
  const members = [
    { tmuxSession: 'foreman-alpha-main', name: 'alpha-main', paneId: '%1' },
    { name: 'beta-old', paneId: '%2' },
    { tmuxSession: 'foreman-gamma-master', name: 'gamma-master', paneId: '%9' },
  ];
  const split = [gammaRow, { ...gammaRow, id: 's4', paneId: '%4' }];
  const sessions = [alphaRow, betaRow, ...split];
  const expected = members.filter((m) => memberRow(m, sessions)).length;
  assert.equal(expected, 1, 'the fixture really does exercise the rungs');
  assert.deepEqual(live(room('r1', 'x', { members }), sessions), { live: 1, total: 3, state: 'some' });

  // Imported, and the band spells none of the rungs itself.
  assert.match(band, /import \{ memberRow \} from '\.\/rooms-pane\.js';/);
  assert.match(fn('roomLiveness', band), /memberRow\(m, sessions\)/);
  assert.ok(!/tmuxSession|paneId/.test(strip(fn('roomLiveness', band))), 'no rung re-spelled here');
});

test('the dot says it in words, on its own title and on the row’s hover', () => {
  assert.equal(livenessText({ live: 2, total: 3, state: 'some' }), '2 of 3 members live');
  assert.equal(livenessText({ live: 3, total: 3, state: 'all' }), '3 of 3 members live');
  assert.equal(livenessText({ live: 0, total: 2, state: 'none' }), '0 of 2 members live');
  const r = room('r1', 'alpha ↔ beta');
  assert.match(roomTitle(r, { live: live(r, [alphaRow]) }), /\n1 of 2 members live/);
  assert.ok(!/members live/.test(roomTitle(r)), 'no liveness line when none was worked out');
});

test('a patched row wears its liveness, and an archived row wears none', () => {
  withDom(() => {
    const list = container();
    const rooms = [room('r1', 'alpha ↔ beta'), room('r2', 'gone', { archivedAt: 5 })];
    const opts = { archivedCollapsed: false, now: NOW };
    patchBand(list, rooms, { ...opts, sessions: [alphaRow, betaRow] });
    const row = list.children.find((c) => c.dataset.roomKey === 'room:r1');
    const gone = list.children.find((c) => c.dataset.roomKey === 'room:r2');
    const dot = (n) => n.children[1];
    assert.equal(row.children[1].className, 'room-live is-all');
    assert.equal(row.children[1].title, '2 of 2 members live');
    assert.equal(row.children[1].attrs['aria-label'], '2 of 2 members live');
    assert.equal(row.children[1].attrs.role, 'img');
    assert.match(row.title, /2 of 2 members live/);

    // An archived row keeps the span, so its name lines up, and draws nothing in it.
    assert.equal(dot(gone).className, 'room-live', 'no state, so the stylesheet draws no dot');
    assert.equal(dot(gone).title, '');
    assert.equal(dot(gone).attrs['aria-hidden'], 'true');
    assert.ok(!('aria-label' in dot(gone).attrs));
    assert.ok(!/members live/.test(gone.title));

    // One member exits: amber, on the same node. Both exit: grey.
    patchBand(list, rooms, { ...opts, sessions: [betaRow] });
    assert.equal(list.children.find((c) => c.dataset.roomKey === 'room:r1'), row, 'patched, never rebuilt');
    assert.equal(row.children[1].className, 'room-live is-some');
    assert.equal(row.children[1].title, '1 of 2 members live');
    patchBand(list, rooms, { ...opts, sessions: [] });
    assert.equal(row.children[1].className, 'room-live is-none');

    // Archived while on screen: the reused node loses every word the dot carried.
    patchBand(list, [room('r1', 'alpha ↔ beta', { archivedAt: 9 })], { ...opts, sessions: [alphaRow, betaRow] });
    const archived = list.children.find((c) => c.dataset.roomKey === 'room:r1');
    assert.equal(archived, row, 'the same node, now archived');
    assert.equal(row.children[1].className, 'room-live');
    assert.ok(!('role' in row.children[1].attrs) && !('aria-label' in row.children[1].attrs));
  });
});

test('the signature moves when a member’s session comes or goes, and on no other roster beat', () => {
  const rooms = [room('r1', 'alpha ↔ beta'), room('r2', 'gone', { archivedAt: 5 })];
  const sig = (sessions) => bandSig(rooms, { sessions, archivedCollapsed: false });
  const both = sig([alphaRow, betaRow]);
  assert.notEqual(sig([betaRow]), both, 'a member exiting repaints the dot');
  assert.notEqual(sig([]), sig([betaRow]), 'and the last one exiting repaints it again');
  // A status flicker, a stranger arriving, or the roster reordering changes no count.
  assert.equal(sig([{ ...alphaRow, status: 'working' }, betaRow]), both);
  assert.equal(sig([betaRow, gammaRow, alphaRow]), both);
  // An archived room's members coming and going repaints nothing — it has no dot.
  const archivedOnly = [room('r2', 'gone', { archivedAt: 5 })];
  assert.equal(
    bandSig(archivedOnly, { sessions: [alphaRow, betaRow], archivedCollapsed: false }),
    bandSig(archivedOnly, { sessions: [], archivedCollapsed: false }),
  );
  // The signature never carries the clock: the age is the timer's, not the frame's.
  assert.ok(!/Date\.now|roomAge|ageText/.test(fn('bandSig', band)));
});

test('the app hands the roster to both the signature and the patch', () => {
  const from = app.indexOf('\nfunction renderRoomsBand(');
  const render = app.slice(from, app.indexOf('\n}\n', from));
  assert.match(render, /bandSig\(rooms, \{ openIds, archivedCollapsed, sessions \}\)/);
  assert.match(render, /patchBand\(el\.roomsList, rooms, \{[\s\S]*?\bsessions,/);
  assert.match(render, /const sessions = state\.sessions;/, 'one read, so the two cannot see different rosters');
});

test('the dot is three tokens, grey for none and never the decision red', () => {
  assert.match(styles, /\.room-live\.is-all \{ background: var\(--idle\); \}/);
  assert.match(styles, /\.room-live\.is-some \{ background: var\(--working\); \}/);
  assert.match(styles, /\.room-live\.is-none \{ background: var\(--ink-faint\); \}/);
  const block = styles.slice(styles.indexOf('.room-live {'), styles.indexOf('.room-live.is-none'));
  assert.ok(!/--decision/.test(block), 'red is the panel’s “needs you”, and a dead room needs nobody');
  const base = styles.match(/\.room-live \{[^}]*\}/)[0];
  assert.match(base, /flex: none;/);
  assert.match(base, /background: transparent;/, 'no state draws nothing — the archived row');
  assert.ok(!/transition|animation/.test(base));
  const age = styles.match(/\.room-age \{[^}]*\}/)[0];
  assert.match(age, /flex: none;/, 'an age never shrinks to `2…`');
});

/* -------------------------------------------------------- the band's height --- */

test('the band’s height is the shared resizer, on the y axis, and nothing else', () => {
  const at = app.indexOf("handle: el.roomsGrip,");
  assert.ok(at > -1, 'the grip is handed to a resizer');
  const call = app.slice(app.lastIndexOf('resizer({', at), app.indexOf('\n});', at));
  assert.match(call, /axis: 'y'/);
  assert.match(call, /storageKey: 'foreman\.roomsBandHeight'/);
  assert.match(call, /min: ROOMS_MIN/);
  assert.match(call, /max: ROOMS_MAX/);
  // The live ceiling keeps the session list above on screen.
  assert.match(call, /ceiling: \(\) => \{[\s\S]*el\.railList[\s\S]*el\.railRooms[\s\S]*RAIL_LIST_MIN/);
  assert.match(call, /setRootVar\('--rooms-band-h', rem\)/);
  assert.match(call, /classList\.toggle\('rooms-band-sized', rem != null\)/);
  // One resizer in the file: no second drag implementation grew beside it.
  assert.equal((code.match(/\nfunction resizer\(/g) || []).length, 1, 'one resizer, never a second');
  assert.ok(!/roomsGrip\.addEventListener/.test(code), 'the grip has no handlers of its own');
});

test('the floor holds a row and the head, and the ceiling has a default before layout', () => {
  const min = Number(app.match(/const ROOMS_MIN = ([\d.]+);/)[1]);
  const max = Number(app.match(/const ROOMS_MAX = ([\d.]+);/)[1]);
  const list = Number(app.match(/const RAIL_LIST_MIN = ([\d.]+);/)[1]);
  // Measured, not summed from the stylesheet: head 33.7px + row 27.6px + padding 8.8px + the
  // 1px rule = 71.1px at 16px a rem. Anything under that cuts the one row the floor promises.
  assert.ok(min * 16 >= 71.1, 'the head, one whole row and the list’s padding');
  assert.ok(max > min && list > 0);
  const call = app.slice(app.indexOf('handle: el.roomsGrip,'));
  assert.match(call.slice(0, call.indexOf('\n});')), /if \(bottom <= top\) return ROOMS_MAX;/);
});

test('nothing stored is the stylesheet’s answer: no default height, and the cap is the fallback', () => {
  const tokens = text('web/tokens.css');
  assert.ok(!/--rooms-band-h/.test(tokens), 'unset is a mode, not a size');
  assert.match(styles, /\.rooms-list\s*\{[^}]*max-height:\s*11rem/, 'the band that shipped, untouched');
  assert.match(styles, /:root\.rooms-band-sized \.app\.has-rooms \.rail-rooms \{ height: var\(--rooms-band-h\); \}/);
  const sized = styles.match(/:root\.rooms-band-sized \.rooms-list \{[^}]*\}/)[0];
  assert.match(sized, /max-height: none/);
  assert.match(sized, /flex: 1 1 auto/, 'the list scrolls inside the height it is given');
  // Nothing a drag moves may ease into place.
  for (const sel of ['.rail-rooms', '.rooms-list', '.rooms-grip']) {
    for (const [decl] of styles.matchAll(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`, 'g'))) {
      assert.ok(!/transition/.test(decl), `${sel} carries no transition`);
    }
  }
});

test('the grip sits on the band’s top rule, outside every list a roster beat rebuilds', () => {
  const grip = html.indexOf('id="roomsGrip"');
  const listEnd = html.indexOf('</div>', html.indexOf('<div class="rail-list"'));
  const band = html.indexOf('<div class="rail-rooms"');
  assert.ok(grip > listEnd && grip < band, 'between the session list and the band, a sibling of both');
  const tag = html.slice(html.lastIndexOf('<div', grip), html.indexOf('></div>', grip));
  assert.match(tag, /class="pane-grip grip-row rooms-grip"/);
  assert.match(tag, /role="separator"/);
  assert.match(tag, /aria-orientation="horizontal"/);
  assert.ok(!/\bhidden\b/.test(tag), '`.pane-grip`’s display beats `[hidden]` — gated by class instead');
  assert.match(styles, /\.rooms-grip \{[^}]*display: none;[^}]*margin: -4px 0 -3px;/);
  assert.match(styles, /\.app\.has-rooms \.rooms-grip \{ display: flex; \}/);
});

test('the band’s size never shares a name with the aside’s room one letter away', () => {
  // `.room-sized` / `--room-h` / `foreman.roomHeight` are the lead aside's. A `rooms-sized`
  // beside them is the sibling name the one-spelling rule refuses.
  for (const src of [code, strip(styles), html]) {
    assert.ok(!/rooms-sized|--rooms-h\b|roomsHeight/.test(src), 'no one-letter sibling of the aside’s names');
  }
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
  // The visibility gate names the list alone. A rule on `.has-rooms .rail-rooms` does exist
  // now — the dragged height, which must not hold an empty band open over a list that is
  // not drawn — so the assertion is on what such a rule may *say*: a height, never a
  // `display`, and nothing at all on the head.
  for (const [, decl] of styles.matchAll(/\.app\.has-rooms \.rail-rooms\s*\{([^}]*)\}/g)) {
    assert.ok(!/display/.test(decl), 'the gate names the list alone — never the band');
  }
  assert.ok(!/\.app\.has-rooms \.rooms-head/.test(styles), 'the gate never names the head');
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

test('the band sits above the shared row and above the footer', () => {
  const rooms = html.indexOf('<div class="rail-rooms"');
  const shared = html.indexOf('class="rail-shared"');
  const foot = html.indexOf('class="rail-foot"');
  assert.ok(rooms < shared && shared < foot);
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

test('both of the band’s ways out reach a real pane', () => {
  /*
   * Both hooks are filled in now — item 8's create modal and items 9/10's room pane — and
   * what this holds is the wiring the band itself owns: a row opens a room, the head's
   * control opens the modal, and neither of them was quietly left pointing at a stub. The
   * pane's own contracts are `test/rooms-pane.test.js`'s.
   */
  const open = fn('openGroupRoom');
  assert.ok(!/console\.info/.test(open), 'the hook is built — a row must not merely log');
  // Item 4 split the mount off the decision, because the auto-collapse may run it 200ms
  // later on the far side of an aside's fold. The row still ends in a room being put in a
  // pane; it is one function along.
  assert.match(open, /mountGroupRoom\(id\)/);
  assert.match(fn('mountGroupRoom'), /target\.openGroup\(id\);/);
  // …and a row for a room that is on screen but **folded** opens the strip rather than
  // doing nothing, which is what the bare early return did before there was a fold. See
  // `revealOpenRoom` — hoisted rather than written inline, because a nested `}` at this
  // indent is where `fn`'s own walk above stops.
  assert.match(open, /return revealOpenRoom\(\);/);
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
  // The band's own block, cut at the create modal's divider below it. The end anchor used
  // to be the connections banner; that section was deleted with the links feature, and an
  // `indexOf` that misses returns -1, which slices to the end of the file and drags every
  // later rule into the assertion. Anchored on a divider inside this section instead.
  const start = styles.indexOf('/* ============================================================= rooms ===');
  const end = styles.indexOf('/* ---------------------------------------------- the create-room modal ---', start);
  assert.ok(start > -1 && end > start, 'both anchors must be found, in order');
  const block = styles.slice(start, end);
  assert.ok(block.length > 500, 'the rooms block is where these rules live');
  // Every colour in the band is a token, so the light and dark palettes both answer for it
  // — the same reason `--shelf` and `--row-open` exist rather than two hand-picked tints.
  const colours = block.match(/(?:^|[\s:])(#[0-9a-f]{3,8}|rgba?\()/gim) || [];
  assert.deepEqual(colours, [], 'no literal colour may be defined only for one theme');
  assert.match(block, /var\(--row-open\)/, 'the open row borrows the rail’s own answer');
});

test('the band’s head is not spelled like a folder heading — measured, not eyeballed', () => {
  /*
   * It was: `--ink-faint`, 0.63rem, 0.13em, uppercase, on `--surface` — the same five values
   * `.group-label` uses for a folder heading three rows up. So the one heading in this column
   * that is not a folder read as one of them, and at 3.48 against the dark surface the words
   * were faint on top of that.
   *
   * Both halves are pinned because either alone leaves the complaint standing: a stronger ink
   * on the same ground still reads as a folder heading, and a ground with faint text on it is
   * a band whose words got quieter. And the `+ room` control has to come up with the title —
   * `--ink-faint` measures 2.87 on the new ground, *worse* than the 3.48 it had, and it is the
   * only way into the create modal.
   */
  const head = styles.match(/\.rooms-head \{[\s\S]*?\n\}/)[0];
  assert.match(head, /background: var\(--band-head\);/);
  const title = styles.match(/\.rooms-title \{[^}]*\}/)[0];
  assert.match(title, /color: var\(--ink\);/);
  const add = styles.match(/\.rooms-add \{[\s\S]*?\n\}/)[0];
  assert.match(add, /color: var\(--ink-muted\);/);
  // Neither may go back to the token that started this.
  assert.ok(!/color: var\(--ink-faint\)/.test(title));
  assert.ok(!/color: var\(--ink-faint\)/.test(add));

  // Not the accent — in this panel that means a selected row and the maintainer's own
  // authority, and a band heading wearing it would be claiming to be one of those.
  for (const decl of [head, title, add]) assert.ok(!/var\(--accent/.test(decl));

  // The size is deliberately untouched: two bands in one column reading at two sizes is the
  // thing a person notices without being able to say what is wrong — `.conn-head`'s own
  // recorded reason, and this fix is about weight and ground, never scale.
  assert.match(title, /font-size: 0\.63rem;/);
  assert.match(title, /letter-spacing: 0\.13em;/);
  assert.match(head, /padding: 0\.7rem 1\.1rem 0\.4rem;/);

  // The ground stops at the head. A permanently tinted block in the rail would be competing
  // with an open group's tint for the same meaning.
  const list = styles.match(/\.rooms-list \{[^}]*\}/)[0];
  assert.ok(!/background/.test(list));
});
