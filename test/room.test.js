import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-room-'));
const { RoomStore } = await import('../server/room.js');

const REPO_A = '/Users/x/Code/Alpha';
const REPO_B = '/Users/x/Code/Beta';

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

test('posts append, read returns them after a cursor', () => {
  const room = new RoomStore();
  room.post(REPO_A, { from: 'panel', kind: 'system', text: 'one' });
  room.post(REPO_A, { from: 'issue-14', kind: 'status', text: 'two' });
  const all = room.read(REPO_A);
  assert.deepEqual(all.entries.map((e) => e.text), ['one', 'two']);
  assert.equal(all.cursor, 2);

  const after = room.read(REPO_A, { since: 1 });
  assert.deepEqual(after.entries.map((e) => e.text), ['two']);
  assert.equal(after.cursor, 2, 'cursor is the newest seq regardless of the window');
});

test('teams do not share a room', () => {
  const room = new RoomStore();
  room.post(REPO_B, { from: 'panel', kind: 'system', text: 'beta only' });
  assert.ok(!room.read(REPO_A).entries.some((e) => e.text === 'beta only'));
});

test('the seq survives a restart', () => {
  const a = new RoomStore();
  a.post(REPO_A, { from: 'lead', kind: 'status', text: 'before' });
  const before = a.read(REPO_A).cursor;

  const b = new RoomStore(); // fresh instance, same files — a server restart
  const entry = b.post(REPO_A, { from: 'lead', kind: 'status', text: 'after' });
  assert.equal(entry.seq, before + 1, 'no seq reuse, no going backwards');
});

test('live posts are emitted for fan-out', () => {
  const room = new RoomStore();
  const got = [];
  room.on('post', (repo, entry) => got.push([repo, entry.text]));
  room.post(REPO_A, { from: 'lead', kind: 'status', text: 'live' });
  assert.deepEqual(got, [[REPO_A, 'live']]);
});

test('a post without a sender is refused', () => {
  const room = new RoomStore();
  assert.throws(() => room.post(REPO_A, { kind: 'status', text: 'anon' }), /sender/);
});

test('an entry carries the poster\'s own keys through disk', () => {
  // The `...rest` passthrough is a contract, not an implementation detail: `conflict`,
  // `escalation`, `report` and now `event` are all keys the *poster* adds and `room.js`
  // has never had to know about. The room's dispatch line is drawn green off `event`, so
  // tidying the spread away would silently turn a colour off in the panel with every test
  // here still passing. This is what makes that a failure instead.
  const a = new RoomStore();
  a.post(REPO_A, {
    from: 'panel', to: 'lead', kind: 'system', about: 'room-clamp-long', event: 'dispatch',
    text: 'Worker room-clamp-long dispatched on agent/room-clamp-long.',
  });

  const b = new RoomStore(); // fresh instance, same files — read it back off disk
  const entry = b.read(REPO_A).entries.at(-1);
  assert.equal(entry.event, 'dispatch', 'the poster said what kind of event this is');
  assert.equal(entry.about, 'room-clamp-long', 'and `about` is still the task id');
});

test('a system line the poster did not label carries no event', () => {
  // The other half of the same rule. `about` cannot tell a dispatch from the transition
  // that follows it — both carry the task id — so the panel matches `event` exactly, and
  // an unlabelled line has to come back with nothing to match rather than an empty string
  // or an inherited value from the entry before it.
  const room = new RoomStore();
  room.post(REPO_A, { from: 'panel', to: 'lead', kind: 'system', about: 'room-clamp-long', text: 'room-clamp-long → working.' });
  const entry = room.read(REPO_A).entries.at(-1);
  assert.equal(entry.event, undefined);
  assert.equal(entry.about, 'room-clamp-long');
});
