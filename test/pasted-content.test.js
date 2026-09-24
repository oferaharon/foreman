import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeRecord } from '../server/normalize.js';
import { unwrapPasted } from '../server/pasted-content.js';
import { readRoomDelivery } from '../server/room-header.js';
import { probe } from '../server/transcript.js';

/*
 * Claude Code v2.1.280's `<pasted_content>` wrapper, and the two readers that have to see
 * through exactly one of it.
 *
 * `test/fixtures/pasted-content.jsonl` is a **real capture**, not a reconstruction: eleven
 * records off one scratch session on Claude Code v2.1.280 in the sandbox's `alpha`, every
 * one typed by the panel's own `sendText` (or, for the mixed record, by the two tmux calls a
 * keyboard and a paste make), composed by the panel's own `roomPeerLine` / `roomHumanLine`.
 * Only the home directory in `cwd` was rewritten, to the `/Users/dev/…` spelling every
 * other fixture here uses. In file order:
 *
 *    0  peer delivery, delivered idle          → `\n\n<open>…<close>\n`
 *    1  maintainer delivery, queued            → `<open>…<close>`, `promptSource: 'queued'`
 *    2  plain four-line message, queued
 *    3  a message quoting the wrapper's own tags, queued — Claude Code escaped them
 *    4  a two-line message: not folded, so not wrapped
 *    5  one 2,000-character line through `send-keys -l`: two wrappers and a bare tail
 *    6  a sentence typed, then a delivery pasted under it
 *    7  the `queue-operation` enqueue beside record 8
 *    8  peer delivery that arrived while the session was busy, queued
 *    9  maintainer delivery addressed to somebody else, delivered idle
 *   10  plain four-line message, delivered idle
 *
 * The session's paste id is `f4d4` on every one of them — per session, not per paste.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pasted-content.jsonl');
const records = () => fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const content = (rec) => rec.message.content;

/** A real record with its text replaced — the record's fields stay exactly as captured. */
const withText = (rec, text) => ({ ...rec, message: { ...rec.message, content: text } });

/* ------------------------------------------------------------ the capture --- */

test('the capture: a wrapped record carries nothing on it that a typed one does not', () => {
  // Pinned so a Claude Code release that starts marking pastes on the record fails here,
  // rather than leaving a stricter witness unused.
  for (const rec of records().filter((r) => r.type === 'user')) {
    assert.equal(rec.version, '2.1.280');
    assert.deepEqual(rec.origin, { kind: 'human' });
    assert.equal(rec.isMeta, undefined);
    assert.ok(['typed', 'queued'].includes(rec.promptSource), rec.promptSource);
  }
});

test('the capture: two whitespace shapes, one per delivery path, one id per session', () => {
  const r = records();
  // Delivered to an idle session: a blank line above, a newline below.
  assert.match(content(r[0]), /^\n\n<pasted_content id="f4d4">\n[\s\S]*\n<\/pasted_content id="f4d4">\n$/);
  assert.equal(r[0].promptSource, 'typed');
  // Queued while busy, and trimmed on the way out: the tags are the first and last bytes.
  assert.match(content(r[8]), /^<pasted_content id="f4d4">\n[\s\S]*\n<\/pasted_content id="f4d4">$/);
  assert.equal(r[8].promptSource, 'queued');
  // Not folded, not wrapped: two lines stay bare.
  assert.equal(content(r[4]), 'Reply with just OK.\nTwo short lines are not folded.');
});

test('the capture: tags inside the pasted text come back escaped', () => {
  const body = unwrapPasted(content(records()[3]));
  assert.ok(body.includes('<\\pasted_content id="abcd">'), 'an opening tag gets a backslash after <');
  assert.ok(body.includes('<\\/pasted_content id="abcd">'), 'and so does a closing one');
  assert.ok(!/<\/?pasted_content\b/.test(body), 'so an unescaped tag in a body can only be another block');
});

/* ------------------------------------------------------------ the unwrap --- */

test('one whole-record wrapper comes off, in both whitespace shapes', () => {
  const r = records();
  assert.equal(
    unwrapPasted(content(r[10])),
    'Reply with just OK.\nThis one is typed in the panel while the session is idle.\nThird line.\nFourth line, so it folds.',
  );
  assert.equal(
    unwrapPasted(content(r[2])),
    'Reply with just OK.\nA multi-line message typed in the panel.\nThird line.\nFourth line, which is what makes it fold.',
  );
});

test('anything but exactly one whole-record wrapper is left alone', () => {
  const r = records();
  const plain = content(r[10]);

  // A sentence typed above the paste: somebody's own words, and the quoting case.
  assert.equal(unwrapPasted(content(r[6])), null);
  // Two wrappers and a tail — one long line cut into reads by the terminal.
  assert.equal(unwrapPasted(content(r[5])), null);
  // Two wrappers and nothing else, which a 3,000-character line measured as (three, in
  // fact): the lazy match runs first open to last close, and the unescaped close tag left
  // inside is what refuses it — a pasted one would have come back `<\/pasted_content`.
  assert.equal(unwrapPasted(`${plain}${plain}`), null);
  // Never wrapped at all.
  assert.equal(unwrapPasted(content(r[4])), null);

  // Open and close must carry the same id.
  assert.equal(unwrapPasted(plain.replace('</pasted_content id="f4d4">', '</pasted_content id="f4d5">')), null);
  // Anything but whitespace after the close, or before the open.
  assert.equal(unwrapPasted(`${plain}and one more thing`), null);
  assert.equal(unwrapPasted(`note:${plain}`), null);
  // The id is Claude Code's own shape — four lowercase hex digits — and nothing looser.
  assert.equal(unwrapPasted(plain.replaceAll('f4d4', 'F4D4')), null);
  assert.equal(unwrapPasted(plain.replaceAll('f4d4', 'f4d')), null);
  // Not a string at all.
  assert.equal(unwrapPasted(undefined), null);
});

/* ------------------------------------------------------------ the readers --- */

test('a wrapped peer delivery is the chip again, delivered idle or queued', () => {
  const r = records();
  for (const rec of [r[0], r[8]]) {
    const [msg] = normalizeRecord(rec);
    assert.equal(msg.kind, 'group_message');
    assert.equal(msg.speaker, 'peer');
    assert.equal(msg.room, 'the checkout flow');
    assert.equal(msg.roomId, 'room-1');
    assert.equal(msg.pasted, true);
    // What the chip opens on is the delivery the panel typed — prefixes and all, tags off.
    assert.equal(msg.raw, unwrapPasted(content(rec)));
    assert.ok(!msg.raw.includes('pasted_content'));
    assert.ok(msg.raw.includes('\n> '));
  }
  const [addressed] = normalizeRecord(r[0]);
  assert.equal(addressed.from, 'alpha-room');
  assert.equal(addressed.to, 'you');
  assert.equal(
    addressed.text,
    '@beta-room reply with just OK — a status note, no action.\n' +
      'The checkout total was off by one cent on the 3-item cart.\n' +
      'I traced it to the rounding in src/total.js.\n' +
      'Fixed on my side; nothing for you to run or check.',
  );
});

test("a wrapped maintainer delivery is the other speaker, delivered idle or queued", () => {
  const r = records();
  const [queued] = normalizeRecord(r[1]);
  assert.equal(queued.kind, 'group_message');
  assert.equal(queued.speaker, 'human');
  assert.equal(queued.to, null);

  const [idle] = normalizeRecord(r[9]);
  assert.equal(idle.kind, 'group_message');
  assert.equal(idle.speaker, 'human');
  assert.equal(idle.to, 'gamma-room', 'the aside comes off; the names stay');
  assert.ok(idle.raw.includes('\n| @gamma-room'));
});

test('a wrapped panel message is a user bubble holding what was pasted', () => {
  const r = records();
  for (const rec of [r[10], r[2]]) {
    const [msg] = normalizeRecord(rec);
    assert.equal(msg.kind, 'user');
    assert.equal(msg.text, unwrapPasted(content(rec)));
    assert.equal(msg.pasted, true);
  }
  // The escaped tags are shown as the session received them: the escape is lossy (a
  // backslash already in the text is not doubled), so undoing it could only guess.
  const [quoted] = normalizeRecord(r[3]);
  assert.equal(quoted.kind, 'user');
  assert.ok(quoted.text.includes('<\\pasted_content id="abcd">'));
});

test('everything that is not exactly one wrapper reads exactly as it did before', () => {
  const r = records();
  for (const rec of [r[4], r[5], r[6]]) {
    const [msg] = normalizeRecord(rec);
    assert.equal(msg.kind, 'user');
    assert.equal(msg.text, content(rec).trim(), 'the record, untouched');
    assert.equal(msg.pasted, undefined);
  }
  // And a typed sentence above a pasted delivery is still the quoting case: a bubble.
  assert.ok(content(r[6]).startsWith('Reply with just OK. Have a look at this, it came in earlier:\n\n<pasted_content'));
  assert.equal(readRoomDelivery(content(r[6])), null);
  // The queue's own bookkeeping is still dropped, though it carries the same wrapper.
  assert.equal(r[7].type, 'queue-operation');
  assert.deepEqual(normalizeRecord(r[7]), []);
});

test('both witnesses still hold inside the wrapper, neither loosened', () => {
  const [peer] = records();
  const inner = unwrapPasted(content(peer));
  const wrap = (s) => `\n\n<pasted_content id="f4d4">\n${s}\n</pasted_content id="f4d4">\n`;

  // Witness two: a line without the speaker's prefix makes it somebody's own message.
  const ownWords = withText(peer, wrap(`${inner}\nand these are my own words`));
  const [a] = normalizeRecord(ownWords);
  assert.equal(a.kind, 'user');
  assert.equal(a.pasted, true);

  // Witness one: a header that is not the first line inside is not a header.
  const below = withText(peer, wrap(`Look at this one:\n${inner}`));
  const [b] = normalizeRecord(below);
  assert.equal(b.kind, 'user');
  assert.equal(readRoomDelivery(content(below)), null);
});

test("a paste's body is never read as a command, command output, nudge or notice", () => {
  const [peer] = records();
  const wrap = (s) => `\n\n<pasted_content id="f4d4">\n${s}\n</pasted_content id="f4d4">\n`;
  const bodies = [
    '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>\nline four',
    '<local-command-stdout>Set model to Fable 5</local-command-stdout>',
    '[room] New team events (cursor 3).\nline two\nline three\nline four',
    '<task-notification>\n<summary>Agent "x" finished</summary>\n</task-notification>',
  ];
  for (const body of bodies) {
    const [msg] = normalizeRecord(withText(peer, wrap(body)));
    assert.equal(msg.kind, 'user', `a pasted ${body.slice(0, 20)}… stays the paster's words`);
    assert.equal(msg.text, body);
  }
});

test("the rail's fallback title reads a pasted first turn from inside the wrapper", async () => {
  // Before, the first line of a wrapped first turn was the tag, the `<` test skipped the
  // whole turn, and the title came from whichever unwrapped turn happened to be next.
  const meta = await probe(FIXTURE);
  const first = unwrapPasted(content(records()[0])).split('\n')[0];
  assert.equal(meta.title, `${first.slice(0, 57)}…`);
});
