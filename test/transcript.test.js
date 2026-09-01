import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTail } from '../server/transcript.js';
import { normalizeRecord } from '../server/normalize.js';

/*
 * readTail is the lead's `worker_read` — one bounded read, no watcher held. The records
 * here are shaped like real transcript lines (type/message/timestamp/uuid), because
 * normalizeRecord drops anything that isn't.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tail-'));

const user = (i) =>
  JSON.stringify({
    type: 'user',
    uuid: `u${i}`,
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    message: { role: 'user', content: `question ${i}` },
  });
const assistant = (i) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a${i}`,
    timestamp: new Date(1700000000500 + i * 1000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
  });

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('the tail is the newest messages, bounded', async () => {
  const file = path.join(scratch, 'a.jsonl');
  const lines = [];
  for (let i = 0; i < 40; i += 1) lines.push(user(i), assistant(i));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const { messages, truncated } = await readTail(file, 10);
  assert.equal(messages.length, 10);
  assert.match(messages.at(-1).text, /answer 39/, 'newest last');
  assert.equal(truncated, true, 'there was more than it returned');
});

test('a short transcript comes back whole and says so', async () => {
  const file = path.join(scratch, 'b.jsonl');
  fs.writeFileSync(file, `${user(1)}\n${assistant(1)}\n`);
  const { messages, truncated } = await readTail(file, 30);
  assert.equal(messages.length, 2);
  assert.equal(truncated, false);
});

test('a torn last line is left for the writer, not misparsed', async () => {
  const file = path.join(scratch, 'c.jsonl');
  fs.writeFileSync(file, `${user(1)}\n${assistant(1)}\n{"type":"assistant","mess`);
  const { messages } = await readTail(file, 30);
  assert.equal(messages.length, 2);
});

test('a [room] nudge is an event line, not the user speaking', () => {
  const rec = (text) => ({
    type: 'user',
    uuid: 'n1',
    timestamp: new Date(1700000000000).toISOString(),
    message: { role: 'user', content: text },
  });
  const [nudge] = normalizeRecord(
    rec('[room] New team events (cursor 3). Use room_read and team_status, act on what you can, and surface to the human only what needs them.'),
  );
  assert.equal(nudge.kind, 'nudge');
  // Prefix-anchored: mentioning the marker mid-sentence stays the user's words, and so
  // does the bare marker with nothing behind it.
  assert.equal(normalizeRecord(rec('the [room] nudge rendered wrong yesterday'))[0].kind, 'user');
  assert.equal(normalizeRecord(rec('[room]'))[0].kind, 'user');
});
