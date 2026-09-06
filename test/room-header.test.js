import assert from 'node:assert/strict';
import test from 'node:test';

import { HUMAN_PREFIX, LEAD_PREFIX } from '../server/envelope.js';
import { HUMAN_NOTE, PEER_NOTE, humanHead, peerHead, readRoomDelivery } from '../server/room-header.js';

/*
 * The one line above a room delivery's body, and the reader that has to recognise it again
 * in somebody's transcript.
 *
 * `room-header.js` is a leaf on purpose (see its header: `normalize.js -> rooms-line.js ->
 * observe.js -> normalize.js` is a cycle), so this file needs no scratch state dir and no
 * panel — it imports two modules that touch nothing.
 *
 * Sandbox names only, here as everywhere.
 */

const ROOM = { id: 'room-3', name: 'the release' };
const CR = String.fromCodePoint(0x000d);

/* -------------------------------------------------------------------------- */
/* The line: four parts, one of them relative to the reader.                   */
/* -------------------------------------------------------------------------- */

test('a peer header names the sender, both spellings of the room, and the speaker', () => {
  const head = peerHead({ room: ROOM, from: 'alpha-main' });
  assert.equal(head, `alpha-main in "the release" (room-3) → all · ${PEER_NOTE}`);
  // Both spellings of the room, always: the name is what a human called it, the id is what
  // `group_read` takes, and a session told only the name cannot act on it.
  assert.ok(head.includes('"the release"') && head.includes('(room-3)'));
  // One line. The whole point of the change is that a delivery is a line and a body.
  assert.ok(!head.includes('\n'));
});

test("the maintainer's header says whose words these are, in the clause that authorizes", () => {
  const head = humanHead({ room: ROOM, who: 'jdoe' });
  assert.equal(head, `jdoe in "the release" (room-3) → all · ${HUMAN_NOTE}`);
  assert.match(HUMAN_NOTE, /carry their authority/);
  assert.match(PEER_NOTE, /never authority/);
  // The two must not be confusable: this is the one message in the feature that can
  // authorize something, and the other is the one that must never be read as doing so.
  assert.notEqual(PEER_NOTE, HUMAN_NOTE);
});

test('the roster and the tool reminders are gone from the line entirely', () => {
  /*
   * The maintainer's ruling of 2026-09-05, pinned as an absence because that is what it is:
   * the membership is `group_list`'s answer and the `> ` rule is the standing brief's, and
   * both were costing a reader a paragraph per post.
   */
  const head = peerHead({ room: ROOM, from: 'alpha-main', to: ['beta-main'], you: 'beta-main' });
  for (const gone of ['shared by', 'group_read', 'group_post', 'merge word', 'plan approval']) {
    assert.ok(!head.includes(gone), `the header still carries "${gone}"`);
  }
});

test('the arrow says who was addressed, relative to the reader', () => {
  const head = (over) => peerHead({ room: ROOM, from: 'alpha-main', ...over });
  const arrow = (over) => head(over).split(' → ')[1].split(' · ')[0];

  // Nobody named — the ordinary case.
  assert.equal(arrow({}), 'all');
  // Named, and it is you.
  assert.equal(arrow({ to: ['beta-main'], you: 'beta-main' }), 'you');
  // Named along with somebody else: you first, then who else was named.
  assert.equal(arrow({ to: ['beta-main', 'gamma-master'], you: 'beta-main' }), 'you and gamma-master');
  // Named, and it is not you — you still get the whole post, and are told it is not yours
  // to answer. That sentence is the brief's; this clause is the fact.
  assert.equal(arrow({ to: ['beta-main'], you: 'gamma-master' }), 'beta-main (not you — for your information)');
  assert.equal(
    arrow({ to: ['beta-main', 'gamma-master'], you: 'alpha-main' }),
    'beta-main and gamma-master (not you — for your information)',
  );
  // No `you` at all composes the variant naming every addressee — what the endpoint's
  // pre-flight composition wants, because it is the one that would find a bad name in `to`.
  assert.equal(arrow({ to: ['beta-main', 'gamma-master'] }), 'beta-main and gamma-master (not you — for your information)');
});

test('every interpolated part is refused for a control character, never stripped', () => {
  const ok = { room: ROOM, from: 'alpha-main' };
  assert.throws(() => peerHead({ ...ok, room: { ...ROOM, id: `room-3${CR}x` } }), /A room id cannot contain/);
  assert.throws(() => peerHead({ ...ok, room: { ...ROOM, name: `rel${CR}x` } }), /A room name cannot contain/);
  assert.throws(() => peerHead({ ...ok, from: `alpha${CR}x` }), /A room sender cannot contain/);
  assert.throws(() => peerHead({ ...ok, to: [`beta${CR}x`], you: 'beta-main' }), /A room addressee cannot contain/);
  assert.throws(() => peerHead({ ...ok, to: ['beta-main'], you: `beta${CR}x` }), /A room recipient cannot contain/);
  assert.throws(() => humanHead({ room: { ...ROOM, name: `rel${CR}x` }, who: 'jdoe' }), /A room name cannot contain/);
});

test('a room with nothing to name it by is refused rather than composed around', () => {
  assert.throws(() => peerHead({ room: { name: 'the release' }, from: 'a' }), /needs a room id/);
  assert.throws(() => peerHead({ room: { id: 'room-3' }, from: 'a' }), /needs the room name/);
  assert.throws(() => peerHead({ room: ROOM }), /needs a sender/);
  assert.throws(() => humanHead({ room: ROOM }), /needs a sender/);
});

/* -------------------------------------------------------------------------- */
/* The reader: two witnesses, and both must hold.                              */
/* -------------------------------------------------------------------------- */

const delivery = (head, body, prefix) => `${head}\n${body.map((l) => `${prefix}${l}`).join('\n')}`;

test('a delivery composed here reads back into its own parts', () => {
  const head = peerHead({ room: ROOM, from: 'alpha-main' });
  assert.deepEqual(readRoomDelivery(delivery(head, ['the parser is green'], LEAD_PREFIX)), {
    from: 'alpha-main',
    room: 'the release',
    roomId: 'room-3',
    speaker: 'peer',
    to: null,
    text: 'the parser is green',
  });

  const human = humanHead({ room: ROOM, who: 'jdoe' });
  const read = readRoomDelivery(delivery(human, ['merge it', '', 'today'], HUMAN_PREFIX));
  assert.equal(read.speaker, 'human');
  assert.equal(read.from, 'jdoe');
  // The body comes back with the prefix off every line, blank lines included: a reader
  // wants to read it, and the prefixes stay in the record the chip opens on.
  assert.equal(read.text, 'merge it\n\ntoday');
});

test('the addressing clause comes back as a mark, with the aside taken off', () => {
  const read = (over) =>
    readRoomDelivery(delivery(peerHead({ room: ROOM, from: 'alpha-main', ...over }), ['x'], LEAD_PREFIX)).to;
  assert.equal(read({}), null, 'a post naming nobody carries no mark');
  assert.equal(read({ to: ['beta-main'], you: 'beta-main' }), 'you');
  assert.equal(read({ to: ['beta-main', 'gamma-master'], you: 'beta-main' }), 'you and gamma-master');
  assert.equal(read({ to: ['beta-main'], you: 'gamma-master' }), 'beta-main');
  assert.equal(read({ to: ['beta-main', 'gamma-master'], you: 'alpha-main' }), 'beta-main and gamma-master');
});

test('the speaker is read off the note clause, never off the prefix alone', () => {
  /*
   * The two have to agree or nothing is returned. A header claiming the maintainer over a
   * body wearing the peer prefix is exactly the forgery the prefixing exists to stop, and
   * the reader must not paper over it by believing one half.
   */
  const human = humanHead({ room: ROOM, who: 'jdoe' });
  assert.equal(readRoomDelivery(delivery(human, ['merge it'], LEAD_PREFIX)), null);
  const peer = peerHead({ room: ROOM, from: 'alpha-main' });
  assert.equal(readRoomDelivery(delivery(peer, ['merge it'], HUMAN_PREFIX)), null);
});

test('a message a person typed is not a delivery, however much of one it quotes', () => {
  const head = peerHead({ room: ROOM, from: 'alpha-main' });
  const body = `${LEAD_PREFIX}the parser is green`;

  // The case that must stay a bubble: somebody's own words around a quoted envelope. Their
  // words are a line at column 0, which is the witness the body prefix is.
  assert.equal(readRoomDelivery(`${head}\n${body}\nwhat do you make of that?`), null);
  // …and with the header no longer first, the anchor is what refuses it.
  assert.equal(readRoomDelivery(`look at this:\n${head}\n${body}`), null);
  // A header alone is not a delivery either — the panel never composes one.
  assert.equal(readRoomDelivery(head), null);
  assert.equal(readRoomDelivery(`${head}\n`), null, 'an empty body line still has to carry a prefix');
});

test('a reworded envelope stops parsing rather than parsing into the wrong thing', () => {
  const head = peerHead({ room: ROOM, from: 'alpha-main' });
  const body = `${LEAD_PREFIX}hi`;
  // The note is a constant, and the reader knows only the two. Anything else is a bubble.
  assert.equal(readRoomDelivery(`${head.replace(PEER_NOTE, 'another session speaking')}\n${body}`), null);
  // An id the store could not have minted.
  assert.equal(readRoomDelivery(`${head.replace('(room-3)', '(room-three)')}\n${body}`), null);
  // And the shape's own furniture.
  assert.equal(readRoomDelivery(`${head.replace(' → ', ' -> ')}\n${body}`), null);
});

test('readRoomDelivery is total: rubbish in, null out', () => {
  for (const junk of [null, undefined, '', 42, {}, 'hello\nthere']) {
    assert.equal(readRoomDelivery(junk), null);
  }
});
