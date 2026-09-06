import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * Scratch state dir before the import: `rooms.js` resolves `rooms.json` off `STATE_DIR` at
 * load. Pointed at the real one, a test that constructed a default store would be
 * reasoning about the maintainer's actual rooms — and writing to them.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rooms-state-'));

const {
  GroupRoomStore,
  MAX_BYTES,
  MAX_MEMBERS,
  MAX_POSTS_PER_ROOM,
  MAX_POSTS_PER_SESSION,
  MAX_ROOM_NAME,
  POST_FLOOR_MS,
  RATE_WINDOW_MS,
  logDirFor,
  memberMatches,
  parseEntries,
} = await import('../server/rooms.js');

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

/** A scratch index (and therefore a scratch log directory) per test, so one test's
 *  rotation is never another test's history. */
function scratch(name = 'rooms.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rooms-')), name);
}

const store_ = (file) => new GroupRoomStore(file);

/* Sandbox names only, here as everywhere. */
const ALPHA = { tmuxSession: 'foreman-alpha-main', name: 'alpha-main', paneId: '%12' };
const BETA = { tmuxSession: 'foreman-beta-main', name: 'beta-main', paneId: '%19' };
const GAMMA = { tmuxSession: 'foreman-gamma-master', name: 'gamma-master', paneId: '%23' };

/*
 * The character this file is mostly about, spelled as a numeric escape for the reason
 * `normalize.js` gives on its own ANSI regex: an invisible control character in source
 * lasts until the next careless edit, and a test that lost one would go on passing.
 */
const CR = '\u000D';

/* -------------------------------------------------------------------------- */
/* Create, list, archive.                                                      */
/* -------------------------------------------------------------------------- */

test('a room is created with its members and lands in the open list', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA, BETA, GAMMA]);

  assert.equal(room.id, 'room-1');
  assert.equal(room.name, 'the release');
  assert.equal(room.memberCount, 3);
  assert.deepEqual(room.members.map((m) => m.name), ['alpha-main', 'beta-main', 'gamma-master']);
  assert.equal(room.archivedAt, null);
  assert.equal(room.unseen, 0);
  assert.equal(room.seq, 0);
  assert.ok(room.members.every((m) => m.addedAt > 0), 'every member is stamped when it joins');

  assert.deepEqual(store.list().map((r) => r.id), ['room-1']);
  assert.deepEqual(store.get('room-1').members.map((m) => m.paneId), ['%12', '%19', '%23']);
  assert.equal(store.get('nope'), null);
});

test('ids do not repeat, and a re-load cannot mint one already in use', () => {
  const file = scratch();
  const a = store_(file);
  a.create('one', [ALPHA]);
  a.create('two', [BETA]);
  a.flush();

  // A hand-edited counter that has gone backwards must not give one room two records.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.seq = 0;
  fs.writeFileSync(file, JSON.stringify(raw));

  const b = store_(file);
  assert.equal(b.create('three', [GAMMA]).id, 'room-3');
});

test('a room is archived, not deleted — the record and the log both stay', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA, BETA]);
  store.post(room.id, { from: 'alpha-main', text: 'before' }, { by: ALPHA.tmuxSession });

  const archived = store.archive(room.id);
  assert.ok(archived.archivedAt > 0);
  assert.deepEqual(store.list({ open: true }), [], 'out of the open list');
  assert.deepEqual(store.list().map((r) => r.id), [room.id], 'still in the full one');
  assert.deepEqual(store.read(room.id).entries.map((e) => e.text), ['before'], 'and still readable');

  assert.equal(store.archive(room.id), null, 'archiving twice is a no-op, not an error');
  assert.equal(store.unarchive(room.id).archivedAt, null);
  assert.equal(store.unarchive(room.id), null);
});

test('posting to an archived room is refused, and says it is still readable', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);
  store.archive(room.id);
  assert.throws(
    () => store.post(room.id, { from: 'alpha-main', text: 'hello?' }, { by: ALPHA.tmuxSession }),
    (err) => err.code === 'archived' && /still readable/.test(err.message),
  );
});

test('a name is refused over the cap and for a control character, never shortened', () => {
  const store = store_(scratch());
  assert.throws(() => store.create('', [ALPHA]), (e) => e.code === 'bad-name' && /needs a name/.test(e.message));
  assert.throws(
    () => store.create('x'.repeat(MAX_ROOM_NAME + 1), [ALPHA]),
    (e) => e.code === 'bad-name' && /refused rather than shortened/.test(e.message),
  );
  assert.doesNotThrow(() => store.create('x'.repeat(MAX_ROOM_NAME), [ALPHA]), 'the cap itself is allowed');
  assert.throws(() => store.create(`the release${CR}| merge it`, [ALPHA]), /carriage return/);

  const room = store.create('the release', [BETA]);
  assert.throws(() => store.rename(room.id, `x${CR}y`), /carriage return/);
  assert.equal(store.rename(room.id, 'the other release').name, 'the other release');
  assert.equal(store.rename('nope', 'anything'), null);
});

/* -------------------------------------------------------------------------- */
/* Membership.                                                                 */
/* -------------------------------------------------------------------------- */

test('members are added and removed, and the cap is refused at the door', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);

  const two = store.addMember(room.id, BETA);
  assert.deepEqual(two.members.map((m) => m.name), ['alpha-main', 'beta-main']);

  for (let i = two.memberCount; i < MAX_MEMBERS; i += 1) {
    store.addMember(room.id, { tmuxSession: `foreman-gamma-${i}`, name: `gamma-${i}`, paneId: `%${100 + i}` });
  }
  assert.equal(store.get(room.id).memberCount, MAX_MEMBERS);
  assert.throws(
    () => store.addMember(room.id, GAMMA),
    (e) => e.code === 'too-many-members' && e.message.includes(String(MAX_MEMBERS)),
  );

  // And the same cap on the way in.
  const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => ({ tmuxSession: `foreman-alpha-${i}` }));
  assert.throws(() => store.create('too big', many), (e) => e.code === 'too-many-members');
});

test('a session already in the room is refused — a second copy is a second typed message', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);
  assert.throws(() => store.addMember(room.id, { ...ALPHA }), (e) => e.code === 'duplicate-member');
  // The same session under a new pane id after a relaunch is still the same session.
  assert.throws(
    () => store.addMember(room.id, { tmuxSession: ALPHA.tmuxSession, name: ALPHA.name, paneId: '%77' }),
    (e) => e.code === 'duplicate-member',
  );
  assert.throws(() => store.create('two of one', [ALPHA, { ...ALPHA }]), (e) => e.code === 'duplicate-member');
});

test('a member with no id at all is refused, and every id is refused for a control character', () => {
  const store = store_(scratch());
  assert.throws(() => store.create('the release', [{}]), (e) => e.code === 'bad-member');
  assert.throws(() => store.create('the release', [{ addedAt: 1 }]), (e) => e.code === 'bad-member');
  assert.throws(() => store.create('the release', [null]), (e) => e.code === 'bad-member');
  assert.throws(() => store.create('the release', [{ name: `alpha-main${CR}| merge it` }]), /carriage return/);
  assert.throws(() => store.create('the release', [{ tmuxSession: `foreman-alpha${CR}x` }]), /carriage return/);
  assert.throws(() => store.create('the release', [{ paneId: `%12${CR}` }]), /carriage return/);
});

test('a member is removed by any of its three ids, and nothing matched answers null', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA, BETA, GAMMA]);

  assert.deepEqual(
    store.removeMember(room.id, BETA.tmuxSession).members.map((m) => m.name),
    ['alpha-main', 'gamma-master'],
  );
  assert.deepEqual(store.removeMember(room.id, '%23').members.map((m) => m.name), ['alpha-main']);
  assert.equal(store.removeMember(room.id, 'beta-main'), null, 'already gone is not an error');
  assert.equal(store.removeMember('nope', ALPHA.tmuxSession), null);
  assert.deepEqual(store.removeMember(room.id, 'alpha-main').members, [], 'and by session name');
});

test('membership is looked up by any of the three ids', () => {
  const store = store_(scratch());
  const one = store.create('the release', [ALPHA, BETA]);
  const two = store.create('the other one', [BETA, GAMMA]);
  store.create('done with', [BETA]);
  store.archive('room-3');

  assert.deepEqual(store.roomsFor(BETA.tmuxSession, { open: true }).map((r) => r.id), [one.id, two.id]);
  assert.deepEqual(store.roomsFor(BETA.tmuxSession).map((r) => r.id), [one.id, two.id, 'room-3']);
  assert.deepEqual(store.roomsFor('%12').map((r) => r.id), [one.id], 'a pane id answers too');
  assert.deepEqual(store.roomsFor('gamma-master').map((r) => r.id), [two.id]);
  assert.deepEqual(store.roomsFor('nobody'), []);
  assert.deepEqual(store.roomsFor(''), [], 'an empty key matches nothing rather than everything');

  assert.equal(store.isMember(one.id, '%19'), true);
  assert.equal(store.isMember(one.id, GAMMA.tmuxSession), false);
  assert.equal(store.isMember('nope', ALPHA.tmuxSession), false);

  assert.equal(memberMatches(ALPHA, '%12'), true);
  assert.equal(memberMatches(ALPHA, ''), false);
  assert.equal(memberMatches(null, '%12'), false);
  assert.equal(memberMatches({ tmuxSession: null, paneId: null, name: null }, ''), false);
});

test('a caller cannot reach in and mutate the store through a copy', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);
  room.name = 'renamed behind the back of the store';
  room.members[0].tmuxSession = 'foreman-beta-main';
  room.members.push(BETA);

  assert.equal(store.get(room.id).name, 'the release');
  assert.deepEqual(store.get(room.id).members.map((m) => m.tmuxSession), [ALPHA.tmuxSession]);
});

/* -------------------------------------------------------------------------- */
/* The log.                                                                    */
/* -------------------------------------------------------------------------- */

test('posts append to a room own log and read back after a cursor', () => {
  const file = scratch();
  const store = store_(file);
  const room = store.create('the release', [ALPHA, BETA]);
  store.post(room.id, { from: 'alpha-main', text: 'one' }, { by: ALPHA.tmuxSession });
  store.post(room.id, { from: 'beta-main', text: 'two' }, { by: BETA.paneId });

  const all = store.read(room.id);
  assert.deepEqual(all.entries.map((e) => e.text), ['one', 'two']);
  assert.equal(all.cursor, 2);
  assert.equal(all.truncated, false);

  const after = store.read(room.id, { since: 1 });
  assert.deepEqual(after.entries.map((e) => e.text), ['two']);
  assert.equal(after.cursor, 2, 'the cursor is the newest seq regardless of the window');

  const capped = store.read(room.id, { limit: 1 });
  assert.deepEqual(capped.entries.map((e) => e.text), ['two'], 'capped from the end — a pane opens on a tail');
  assert.equal(capped.truncated, true);

  assert.equal(fs.existsSync(path.join(logDirFor(file), `${room.id}.jsonl`)), true);
});

test('an entry carries the keys its poster put on it through disk', () => {
  const file = scratch();
  const store = store_(file);
  const room = store.create('the release', [ALPHA, BETA]);
  store.post(
    room.id,
    { from: 'alpha-main', text: 'the branch is up', handed: [{ name: 'beta-main', state: 'queued' }] },
    { by: ALPHA.tmuxSession, now: 1788638903170 },
  );

  const [line] = fs.readFileSync(path.join(logDirFor(file), `${room.id}.jsonl`), 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(line), {
    seq: 1,
    ts: 1788638903170,
    kind: 'peer',
    from: 'alpha-main',
    text: 'the branch is up',
    handed: [{ name: 'beta-main', state: 'queued' }],
  });
});

test('a post is emitted with its room id, for a per-room subscription', () => {
  const store = store_(scratch());
  const a = store.create('the release', [ALPHA]);
  const b = store.create('the other one', [BETA]);
  const got = [];
  store.on('post', (id, entry) => got.push(`${id}:${entry.text}`));

  store.post(a.id, { from: 'alpha-main', text: 'one' }, { by: ALPHA.tmuxSession });
  store.post(b.id, { from: 'beta-main', text: 'two' }, { by: BETA.tmuxSession });
  assert.deepEqual(got, ['room-1:one', 'room-2:two']);
});

test('the refusals a post can carry, each with a code the endpoint maps to a status', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);

  assert.throws(
    () => store.post(room.id, { from: 'alpha-main', text: 'hi' }),
    (e) => e.code === 'bad-poster' && /null for the maintainer/.test(e.message),
    'an omitted `by` is refused rather than read as the maintainer',
  );
  assert.throws(() => store.post(room.id, { text: 'hi' }, { by: null }), (e) => e.code === 'bad-sender');
  assert.throws(() => store.post('nope', { from: 'alpha-main' }, { by: null }), (e) => e.code === 'no-room');
  assert.throws(
    () => store.post(room.id, { from: 'beta-main', text: 'hi' }, { by: BETA.tmuxSession }),
    (e) => e.code === 'not-a-member',
  );
  assert.throws(() => store.post(room.id, { from: `alpha${CR}x` }, { by: null }), /carriage return/);
  assert.throws(() => store.post(room.id, { from: 'alpha-main', text: `a${CR}b` }, { by: null }), /carriage return/);
  assert.throws(() => store.post(room.id, { from: 'alpha-main', text: '   ' }, { by: null }), /something to say/);
  assert.throws(
    () => store.post(room.id, { from: 'alpha-main', text: 'x'.repeat(4001) }, { by: null }),
    /refused rather than shortened/,
  );
  assert.deepEqual(store.read(room.id).entries, [], 'and none of them wrote a line');
});

test('reading a room that does not exist is an answer, not an empty log', () => {
  const store = store_(scratch());
  assert.throws(() => store.read('room-9'), (e) => e.code === 'no-room');
  assert.throws(() => store.readAll('room-9'), (e) => e.code === 'no-room');
});

test('a torn final line is skipped, and the counter comes off the last good one', () => {
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA]);
  a.post(room.id, { from: 'alpha-main', text: 'whole' }, { by: ALPHA.tmuxSession });
  a.flush();
  const log = path.join(logDirFor(file), `${room.id}.jsonl`);
  fs.appendFileSync(log, '{"seq":2,"kind":"peer","text":"half a li'); // a crash mid-append

  const b = store_(file);
  assert.deepEqual(b.readAll(room.id).map((e) => e.text), ['whole']);
  const next = b.post(room.id, { from: 'alpha-main', text: 'after the tear' }, { by: ALPHA.tmuxSession });
  assert.equal(next.seq, 2);
  assert.deepEqual(parseEntries(fs.readFileSync(log, 'utf8')).map((e) => e.text), ['whole', 'after the tear']);
});

test('the seq is monotonic across a reload', () => {
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA]);
  a.post(room.id, { from: 'alpha-main', text: 'one' }, { by: ALPHA.tmuxSession });
  a.post(room.id, { from: 'alpha-main', text: 'two' }, { by: ALPHA.tmuxSession, now: Date.now() + POST_FLOOR_MS });
  a.flush();

  const b = store_(file);
  assert.equal(b.get(room.id).seq, 2, 'the counter is in memory before the first roster frame');
  assert.equal(b.post(room.id, { from: 'alpha-main', text: 'three' }, { by: ALPHA.tmuxSession }).seq, 3);
});

test('lastAt and lastFrom are healed from the log when the index was left behind', () => {
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA, BETA]);
  a.flush(); // the index is written before the post, and then the panel dies

  const log = path.join(logDirFor(file), `${room.id}.jsonl`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(
    log,
    `${JSON.stringify({ seq: 1, ts: 1788638903170, kind: 'peer', from: 'beta-main', text: 'landed' })}\n`,
  );

  const b = store_(file);
  assert.equal(b.get(room.id).lastAt, 1788638903170);
  assert.equal(b.get(room.id).lastFrom, 'beta-main');
  assert.equal(b.get(room.id).seq, 1);
});

/* -------------------------------------------------------------------------- */
/* Rotation.                                                                   */
/* -------------------------------------------------------------------------- */

/** Fill one room's log past the cap with real entries, so the retired generation is
 *  readable history and the carried seq is a real one. */
function fillPastCap(log) {
  const pad = 'x'.repeat(2048);
  let seq = 0;
  let bytes = 0;
  const lines = [];
  fs.mkdirSync(path.dirname(log), { recursive: true });
  while (bytes <= MAX_BYTES) {
    seq += 1;
    const line = `${JSON.stringify({ seq, ts: 1788638903170, kind: 'peer', from: 'alpha-main', text: pad })}\n`;
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  fs.writeFileSync(log, lines.join(''));
  return seq;
}

test('an oversized log is rotated at boot and the seq is carried across it', () => {
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA]);
  a.flush();
  const log = path.join(logDirFor(file), `${room.id}.jsonl`);
  const lastSeq = fillPastCap(log);
  const sizeBefore = fs.statSync(log).size;

  const b = store_(file);
  assert.equal(fs.existsSync(log), false, 'a rename, never a rewrite — the next append creates the fresh file');
  assert.equal(fs.statSync(`${log}.1`).size, sizeBefore, 'byte-identical, not compacted');
  assert.deepEqual(b.readAll(room.id), []);
  assert.deepEqual(b.rotations().map((r) => r.room), [room.id]);
  assert.equal(b.rotations()[0].carriedSeq, lastSeq);

  const entry = b.post(room.id, { from: 'alpha-main', text: 'after the rotation' }, { by: ALPHA.tmuxSession });
  assert.equal(entry.seq, lastSeq + 1, 'a held cursor still advances rather than being sent back to zero');
});

test('a log under the cap is left exactly where it is', () => {
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA]);
  a.post(room.id, { from: 'alpha-main', text: 'small' }, { by: ALPHA.tmuxSession });
  a.flush();

  const b = store_(file);
  assert.deepEqual(b.rotations(), []);
  assert.deepEqual(b.readAll(room.id).map((e) => e.text), ['small']);
});

/* -------------------------------------------------------------------------- */
/* The tolerant boot read, and what must survive it.                           */
/* -------------------------------------------------------------------------- */

test('an unparseable index is moved aside before the first flush can overwrite it', () => {
  const file = scratch();
  fs.writeFileSync(file, '{"seq": 2, "rooms": [ this was hand-edited');

  const store = store_(file);
  assert.deepEqual(store.list(), [], 'a boot has to finish — it starts clean rather than throwing');
  assert.equal(fs.existsSync(`${file}.bad`), false, 'and nothing is moved until something is actually written');

  store.create('the release', [ALPHA]);
  store.flush();
  assert.match(fs.readFileSync(`${file}.bad`, 'utf8'), /hand-edited/, 'the file with the typo is still recoverable');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rooms.map((r) => r.name), ['the release']);
});

test('a record this version does not understand survives a load and a flush', () => {
  const file = scratch();
  fs.writeFileSync(
    file,
    JSON.stringify({
      seq: 4,
      // A top-level key a later version added.
      pinnedRoom: 'room-4',
      rooms: [
        {
          id: 'room-4',
          name: 'the release',
          members: [{ tmuxSession: 'foreman-alpha-main', name: 'alpha-main', paneId: '%12', addedAt: 5, role: 'lead' }],
          createdAt: 5,
          archivedAt: null,
          lastAt: 6,
          lastFrom: 'alpha-main',
          // Fields a later version added, on the record.
          colour: 'amber',
          mutedUntil: 99,
        },
        // Impossible shapes: no id, not an object, a duplicate id.
        { name: 'no id at all', members: [] },
        'not a record',
        { id: 'room-4', name: 'the same id twice' },
      ],
    }),
  );

  const store = store_(file);
  assert.deepEqual(store.list().map((r) => r.id), ['room-4'], 'only the impossible shapes are dropped');
  store.rename('room-4', 'the release, renamed');
  store.flush();

  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.pinnedRoom, 'room-4', 'a file-level key it has never heard of');
  assert.equal(back.rooms[0].colour, 'amber', 'a record-level one');
  assert.equal(back.rooms[0].mutedUntil, 99);
  assert.equal(back.rooms[0].members[0].role, 'lead', 'and one on a member');
  assert.equal(back.rooms[0].name, 'the release, renamed');
  assert.equal(back.seq, 4);

  // The memory-held counters are never written into the record they are folded into.
  assert.deepEqual(
    Object.keys(back.rooms[0]).filter((k) => ['unseen', 'seq', 'memberCount', 'seenAt'].includes(k)),
    [],
  );
});

test('the boot read tolerates what the door refuses, rather than deleting the room', () => {
  const file = scratch();
  fs.writeFileSync(
    file,
    JSON.stringify({
      seq: 1,
      rooms: [
        {
          id: 'room-1',
          name: 'x'.repeat(MAX_ROOM_NAME + 40), // over the cap: sliced, not dropped
          members: [
            ...Array.from({ length: MAX_MEMBERS + 2 }, (_, i) => ({ tmuxSession: `foreman-alpha-${i}` })),
            { addedAt: 3 }, // no id at all — nothing to resolve by and nothing to lose
            'not a member',
          ],
        },
      ],
    }),
  );

  const store = store_(file);
  const room = store.get('room-1');
  assert.equal(room.name.length, MAX_ROOM_NAME, 'clamped, exactly as a hand-typed link label is');
  assert.equal(room.memberCount, MAX_MEMBERS + 2, 'an over-cap membership is kept rather than silently trimmed');
  assert.throws(() => store.addMember('room-1', ALPHA), (e) => e.code === 'too-many-members');
});

test('a room id that could name a file elsewhere keeps its record and loses only its log', () => {
  const file = scratch();
  fs.writeFileSync(
    file,
    JSON.stringify({ seq: 1, rooms: [{ id: '../escape', name: 'the release', members: [ALPHA] }] }),
  );

  const store = store_(file);
  assert.deepEqual(store.list().map((r) => r.id), ['../escape'], 'the record is kept — dropping it would delete it');
  assert.throws(() => store.logFile('../escape'), (e) => e.code === 'bad-room-id');
  assert.throws(() => store.readAll('../escape'), (e) => e.code === 'bad-room-id');
  store.rename('../escape', 'still editable');
  store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rooms[0].name, 'still editable');
});

test('an index that is valid JSON but the wrong shape starts clean without clobbering', () => {
  const file = scratch();
  fs.writeFileSync(file, JSON.stringify({ rooms: 'not a list' }));
  const store = store_(file);
  assert.deepEqual(store.list(), []);
  assert.equal(store.create('the release', [ALPHA]).id, 'room-1');
});

/* -------------------------------------------------------------------------- */
/* Unseen — a room is a log, not an inbox.                                     */
/* -------------------------------------------------------------------------- */

test('unseen opens at zero at boot, however much the room already holds', () => {
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA, BETA]);
  let now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    now += POST_FLOOR_MS;
    a.post(room.id, { from: 'alpha-main', text: `old ${i}` }, { by: ALPHA.tmuxSession, now });
  }
  assert.equal(a.get(room.id).unseen, 5);
  a.flush();

  const b = store_(file);
  assert.equal(b.get(room.id).unseen, 0, 'a badge opening at everything ever said asks for attention nobody owes it');
  assert.equal(b.get(room.id).seq, 5, 'while the cursor is exactly where the log left it');
});

test('unseen counts what a session posted, never what the maintainer typed', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA, BETA]);

  store.post(room.id, { from: 'panel', text: 'ship it' }, { by: null });
  assert.equal(store.get(room.id).unseen, 0, 'his own typing must not badge the room he is looking at');

  store.post(room.id, { from: 'alpha-main', text: 'on it' }, { by: ALPHA.tmuxSession });
  store.post(room.id, { from: 'beta-main', text: 'me too' }, { by: BETA.tmuxSession });
  assert.equal(store.get(room.id).unseen, 2);

  const seen = store.seen(room.id, { now: 1788638903170 });
  assert.equal(seen.unseen, 0);
  assert.equal(seen.seenAt, 1788638903170);
  assert.equal(store.seen('nope'), null);
});

test('the answer the roster frame reads never touches a file', () => {
  // `rosterFrame` runs every two seconds and is broadcast to every client, so everything
  // it wants has to be in memory (plan 5.9). Taking the files away is the only honest
  // test of that: a `list()` that touched one would come back short.
  const file = scratch();
  const store = store_(file);
  const room = store.create('the release', [ALPHA, BETA]);
  store.post(room.id, { from: 'alpha-main', text: 'one' }, { by: ALPHA.tmuxSession, now: 1788638903170 });

  fs.rmSync(logDirFor(file), { recursive: true, force: true });
  fs.rmSync(file, { force: true });

  const [row] = store.list({ open: true });
  assert.equal(row.seq, 1);
  assert.equal(row.unseen, 1);
  assert.equal(row.lastAt, 1788638903170);
  assert.equal(row.lastFrom, 'alpha-main');
  assert.equal(row.memberCount, 2);
});

/* -------------------------------------------------------------------------- */
/* The rate limiter (plan 5.6).                                                */
/* -------------------------------------------------------------------------- */

test('a session may not post twice inside the floor, and the refusal says so', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA, BETA]);
  const t0 = 1788638903170;

  store.post(room.id, { from: 'alpha-main', text: 'one' }, { by: ALPHA.tmuxSession, now: t0 });
  assert.throws(
    () => store.post(room.id, { from: 'alpha-main', text: 'again' }, { by: ALPHA.tmuxSession, now: t0 + 4000 }),
    (e) => e.code === 'rate-limited' && /already said this to everyone/.test(e.message),
  );
  assert.deepEqual(store.read(room.id).entries.map((e) => e.text), ['one'], 'refused, never silently dropped');

  // Another member in the same room is not held by the first one's floor.
  assert.ok(store.post(room.id, { from: 'beta-main', text: 'mine' }, { by: BETA.tmuxSession, now: t0 + 4000 }));
  // And the floor expires.
  assert.ok(
    store.post(room.id, { from: 'alpha-main', text: 'later' }, { by: ALPHA.tmuxSession, now: t0 + POST_FLOOR_MS }),
  );
});

test('a session is capped per window, and the cap is per session', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA, BETA, GAMMA]);
  const t0 = 1788638903170;

  let at = t0;
  for (let i = 0; i < MAX_POSTS_PER_SESSION; i += 1) {
    at = t0 + i * (POST_FLOOR_MS + 1000);
    store.post(room.id, { from: 'alpha-main', text: `n${i}` }, { by: ALPHA.tmuxSession, now: at });
  }
  const over = store.rateFault(room.id, ALPHA.tmuxSession, { now: at + POST_FLOOR_MS + 1000 });
  assert.equal(over.code, 'rate-limited');
  assert.match(over.message, new RegExp(`posted ${MAX_POSTS_PER_SESSION} times`));
  assert.ok(over.retryAfterMs > 0);
  assert.equal(store.rateFault(room.id, BETA.tmuxSession, { now: at }), null, 'and it is per session');

  // Past the window, the same session is clear again.
  assert.equal(store.rateFault(room.id, ALPHA.tmuxSession, { now: t0 + RATE_WINDOW_MS * 2 }), null);
});

test('the room-wide cap counts every post, the maintainer own included', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);
  const t0 = 1788638903170;

  for (let i = 0; i < MAX_POSTS_PER_ROOM; i += 1) {
    store.post(room.id, { from: 'panel', text: `n${i}` }, { by: null, now: t0 + i });
  }
  const over = store.rateFault(room.id, ALPHA.tmuxSession, { now: t0 + 1000 });
  assert.equal(over.code, 'rate-limited');
  assert.match(over.message, /is at its limit/);
  assert.throws(
    () => store.post(room.id, { from: 'alpha-main', text: 'may I' }, { by: ALPHA.tmuxSession, now: t0 + 1000 }),
    (e) => e.code === 'rate-limited',
  );
});

test('the maintainer is never refused — the limiter is an amplification guard', () => {
  const store = store_(scratch());
  const room = store.create('the release', [ALPHA]);
  const t0 = 1788638903170;

  for (let i = 0; i < MAX_POSTS_PER_ROOM + 5; i += 1) {
    assert.ok(store.post(room.id, { from: 'panel', text: `n${i}` }, { by: null, now: t0 + i }));
  }
  assert.equal(store.rateFault(room.id, null, { now: t0 }), null);
  assert.equal(
    store.rateFault('nope', ALPHA.tmuxSession, { now: t0 }),
    null,
    'and a room that is not there mints no counters',
  );
});

test('a control character at either end is refused, not trimmed away', () => {
  // The order inside the door is the whole of this: `String#trim` strips carriage return,
  // newline and tab, so a value trimmed *before* it is checked arrives at the refusal
  // looking perfectly ordinary — and the character this repo refuses rather than strips
  // has been stripped. Nothing about the stored value looks wrong afterwards, so a test
  // asserting the refusal is the only thing that ever catches it.
  const store = store_(scratch());
  assert.throws(() => store.create(`the release${CR}`, [ALPHA]), /carriage return/);
  assert.throws(() => store.create(`${CR}the release`, [ALPHA]), /carriage return/);
  assert.throws(() => store.create('the release', [{ paneId: `%12${CR}` }]), /carriage return/);
  assert.throws(() => store.create('the release', [{ tmuxSession: `${CR}foreman-alpha-main` }]), /carriage return/);

  const room = store.create('the release', [ALPHA]);
  assert.throws(() => store.post(room.id, { from: `alpha-main${CR}` }, { by: null }), /carriage return/);
  assert.throws(() => store.addMember(room.id, { name: `beta-main${CR}` }), /carriage return/);
});

test('an append after a torn line does not weld itself onto it', () => {
  // `parseEntries` skipping a torn last line is only half of it. A crash leaves that half
  // with no terminator, and the next append lands flush against it — one unparseable line
  // where there should be a tear and a good entry, and the post a session believes it
  // made to everyone is gone.
  const file = scratch();
  const a = store_(file);
  const room = a.create('the release', [ALPHA, BETA]);
  a.post(room.id, { from: 'alpha-main', text: 'whole' }, { by: ALPHA.tmuxSession });
  const log = path.join(logDirFor(file), `${room.id}.jsonl`);
  fs.appendFileSync(log, '{"seq":2,"kind":"peer","text":"half a li');

  const entry = a.post(room.id, { from: 'beta-main', text: 'after the tear' }, { by: BETA.tmuxSession });
  assert.equal(entry.seq, 2);
  assert.deepEqual(
    parseEntries(fs.readFileSync(log, 'utf8')).map((e) => e.text),
    ['whole', 'after the tear'],
    'the tear stays torn and stays unparseable — it is terminated, never repaired',
  );
  assert.match(fs.readFileSync(log, 'utf8'), /half a li/, 'and the half-line is still on disk exactly as found');
});

/* -------------------------------------------------------------------------- */
/* Where the files are.                                                        */
/* -------------------------------------------------------------------------- */

test('the logs sit beside the index, under the state dir and nowhere else', () => {
  assert.equal(logDirFor('/x/y/rooms.json'), '/x/y/rooms');
  assert.equal(logDirFor('/x/y/rooms'), '/x/y/rooms-logs', 'never the index file itself');

  const file = scratch();
  const store = store_(file);
  const room = store.create('the release', [ALPHA]);
  store.post(room.id, { from: 'alpha-main', text: 'one' }, { by: ALPHA.tmuxSession });
  store.flush();

  assert.deepEqual(fs.readdirSync(logDirFor(file)), [`${room.id}.jsonl`]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['rooms', 'rooms.json']);
});

test('stop flushes and stops the timer', () => {
  const file = scratch();
  const store = store_(file);
  store.create('the release', [ALPHA]);
  store.stop();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rooms.map((r) => r.name), ['the release']);
});
