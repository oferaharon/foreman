import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-shared-room-'));
const { SharedRoomStore, MAX_BYTES } = await import('../server/shared-room.js');

const DIR = process.env.FOREMAN_STATE_DIR;

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

/** A scratch log of its own per test, so one test's rotation is not another's history. */
let n = 0;
function scratchFile() {
  return path.join(DIR, `shared-room-${++n}.jsonl`);
}

const ALPHA = { name: 'alpha-main', pid: 15351, tmuxSession: 'foreman-alpha-main', paneId: '%12' };
const BETA = { name: 'beta-main', tmuxSession: 'foreman-beta-main', paneId: '%19' };

function peer(msgId, text, extra = {}) {
  return { kind: 'peer', msgId, text, from: ALPHA, to: BETA, fromSource: 'registry', ...extra };
}

test('posts append, read returns them after a cursor', () => {
  const room = new SharedRoomStore(scratchFile());
  room.post(peer('m-1', 'one'));
  room.post(peer('m-2', 'two'));

  const all = room.read();
  assert.deepEqual(all.entries.map((e) => e.text), ['one', 'two']);
  assert.equal(all.cursor, 2);

  const after = room.read({ since: 1 });
  assert.deepEqual(after.entries.map((e) => e.text), ['two']);
  assert.equal(after.cursor, 2, 'cursor is the newest seq regardless of the window');
});

test('an entry carries the poster\'s own keys through disk', () => {
  // The `...rest` passthrough is the contract `room.js` has: `reply`, `fromRole`, `toRole`
  // and whatever a later kind adds are the *poster's* keys, and the store stores them.
  const file = scratchFile();
  const room = new SharedRoomStore(file);
  room.post(peer('m-1', 'hello', { reply: true, toRole: 'lead' }), { now: 1788638903170 });

  const [line] = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(line), {
    seq: 1,
    ts: 1788638903170,
    kind: 'peer',
    msgId: 'm-1',
    text: 'hello',
    from: ALPHA,
    to: BETA,
    fromSource: 'registry',
    reply: true,
    toRole: 'lead',
  });
});

test('a second post with the same msgId is refused and the seq does not advance', () => {
  const file = scratchFile();
  const room = new SharedRoomStore(file);
  const emitted = [];
  room.on('post', (e) => emitted.push(e.text));

  const first = room.post(peer('m-1', 'sent once'));
  const again = room.post(peer('m-1', 'seen a second time by the boot sweep'));
  const next = room.post(peer('m-2', 'a different message'));

  assert.equal(first.seq, 1);
  assert.equal(again, null, 'a known msgId is a no-op, not an error');
  assert.equal(next.seq, 2, 'the refused post consumed no seq');
  assert.deepEqual(emitted, ['sent once', 'a different message'], 'and emitted nothing');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2, 'one line per stored entry');
});

test('the seen-set is seeded from the file, so a restart does not re-post the sweep', () => {
  const file = scratchFile();
  const a = new SharedRoomStore(file);
  a.post(peer('m-1', 'before the restart'));

  const b = new SharedRoomStore(file); // fresh instance, same file — a server restart
  assert.equal(b.post(peer('m-1', 'the sweep finds it again')), null);
  assert.deepEqual(b.readAll().map((e) => e.text), ['before the restart']);
});

test('an entry with no msgId is always appended — there is nothing to dedupe on', () => {
  // The `@` composer's own `human` entries are written by the panel, not observed on the
  // wire, and two identical ones a minute apart are two things a person did.
  const room = new SharedRoomStore(scratchFile());
  room.post({ kind: 'human', from: 'panel', to: BETA, text: 'ping' });
  room.post({ kind: 'human', from: 'panel', to: BETA, text: 'ping' });
  assert.deepEqual(room.readAll().map((e) => e.seq), [1, 2]);
});

test('the seq survives a restart', () => {
  const file = scratchFile();
  const a = new SharedRoomStore(file);
  a.post(peer('m-1', 'before'));
  a.post(peer('m-2', 'also before'));
  const before = a.read().cursor;

  const b = new SharedRoomStore(file);
  const entry = b.post(peer('m-3', 'after'));
  assert.equal(entry.seq, before + 1, 'no seq reuse, no going backwards');
});

test('a torn final line is skipped rather than thrown', () => {
  const file = scratchFile();
  const a = new SharedRoomStore(file);
  a.post(peer('m-1', 'whole'));
  fs.appendFileSync(file, '{"seq":2,"kind":"peer","text":"half a li'); // a crash mid-append

  const b = new SharedRoomStore(file);
  assert.deepEqual(b.readAll().map((e) => e.text), ['whole']);
  assert.equal(b.post(peer('m-2', 'after the tear')).seq, 2, 'the counter comes off the last good line');
});

test('a post without a sender is refused', () => {
  const room = new SharedRoomStore(scratchFile());
  assert.throws(() => room.post({ kind: 'peer', msgId: 'm-1', text: 'anon' }), /sender/);
});

test('live posts are emitted for fan-out', () => {
  const room = new SharedRoomStore(scratchFile());
  const got = [];
  room.on('post', (entry) => got.push(entry.text));
  room.post(peer('m-1', 'live'));
  assert.deepEqual(got, ['live']);
});

/* ------------------------------------------------------------- rotation --- */

/** Fill a log past the cap with real entries, so the rotated generation is readable
 *  history and the carried seq is a real one. */
function fillPastCap(file, { from = 1 } = {}) {
  const pad = 'x'.repeat(2048);
  let seq = from - 1;
  const lines = [];
  let bytes = 0;
  while (bytes <= MAX_BYTES) {
    seq += 1;
    const line = `${JSON.stringify({ seq, ts: 1788638903170, kind: 'peer', msgId: `old-${seq}`, text: pad, from: ALPHA, to: BETA })}\n`;
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  fs.writeFileSync(file, lines.join(''));
  return seq;
}

test('a file over the cap is rotated at construction and the old content is in .1', () => {
  const file = scratchFile();
  const lastSeq = fillPastCap(file);
  const sizeBefore = fs.statSync(file).size;
  assert.ok(sizeBefore > MAX_BYTES);

  const room = new SharedRoomStore(file);

  assert.equal(fs.existsSync(file), false, 'a rename, never a rewrite — the fresh file is created by the next append');
  assert.equal(fs.statSync(`${file}.1`).size, sizeBefore, 'the retired generation is byte-identical, not compacted');
  assert.deepEqual(room.readAll(), [], 'and the live log starts empty');
  assert.equal(room.rotated.bytes, sizeBefore);
  assert.equal(room.rotated.to, `${path.basename(file)}.1`);

  const entry = room.post(peer('m-new', 'after the rotation'));
  assert.equal(entry.seq, lastSeq + 1, 'the seq is monotonic across the rotation, so a held cursor still advances');
  assert.equal(fs.statSync(file).size, Buffer.byteLength(`${JSON.stringify(entry)}\n`));
});

test('a .1 that already exists is overwritten', () => {
  const file = scratchFile();
  fs.writeFileSync(`${file}.1`, 'the generation before last\n');
  fillPastCap(file);
  const sizeBefore = fs.statSync(file).size;

  new SharedRoomStore(file);

  const kept = fs.readFileSync(`${file}.1`, 'utf8');
  assert.equal(Buffer.byteLength(kept), sizeBefore, 'one generation, overwritten — no .2');
  assert.ok(!kept.includes('the generation before last'));
  assert.equal(fs.existsSync(`${file}.2`), false);
});

test('a file under the cap is left exactly where it is', () => {
  const file = scratchFile();
  const a = new SharedRoomStore(file);
  a.post(peer('m-1', 'small'));
  const before = fs.statSync(file).size;

  const b = new SharedRoomStore(file);
  assert.equal(b.rotated, null);
  assert.equal(fs.statSync(file).size, before);
  assert.equal(fs.existsSync(`${file}.1`), false);
  assert.deepEqual(b.readAll().map((e) => e.text), ['small']);
});
