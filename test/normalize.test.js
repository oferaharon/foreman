import assert from 'node:assert/strict';
import test from 'node:test';
import { imageBlocks, normalizeRecord, servableImage, stitch } from '../server/normalize.js';

/*
 * Images in a transcript, and the two paths that used to throw them away.
 *
 * Every record shape here is copied from a real one. The tool_result shape is the
 * `mcp__claude-in-chrome__computer` screenshot from
 * a transcript in another project (`5b232be6…jsonl`) — two text blocks then the
 * image, at `message.content[0].content[2]`, with `toolUseResult` an *array* that
 * duplicates those same blocks and carries no file path. The pasted shape is the maintainer's own,
 * from `Foreman/36699c8f…jsonl` — text and image side by side at the top of a `user`
 * record, with `imagePasteIds` beside them.
 *
 * Measured across the 429 transcripts on this Mac: 1027 image blocks, every one
 * `source.type === 'base64'`, only `image/jpeg` and `image/png`, and not one of them on a
 * sidechain record.
 */

const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (data = DATA) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const txt = (text) => ({ type: 'text', text });

const shot = (uuid, blocks) => ({
  type: 'user',
  uuid,
  timestamp: '2026-08-29T05:08:48.736Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: blocks }] },
  toolUseResult: blocks,
});

test('imageBlocks numbers every image in a record, nesting and all', () => {
  const rec = {
    type: 'user',
    uuid: 'r1',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [txt('captured'), png()] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [png(), png()] },
      ],
    },
  };
  const found = imageBlocks(rec);
  assert.deepEqual(
    found.map((f) => [f.index, f.toolUseId]),
    [
      [0, 'toolu_a'],
      [1, 'toolu_b'],
      [2, 'toolu_b'],
    ],
    'ordinals are record-wide and in walk order, not per tool_result',
  );
});

test('an ordinal survives a block we decline to serve', () => {
  const url = { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } };
  const rec = {
    type: 'user',
    uuid: 'r2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [url, png()] }] },
  };
  const found = imageBlocks(rec);
  assert.equal(found.length, 2, 'both are walked');
  assert.equal(servableImage(found[0].block), false);
  assert.equal(servableImage(found[1].block), true);

  const [msg] = normalizeRecord(rec);
  // The one we can serve keeps the number the walk gave it. Renumber the survivors and
  // the endpoint hands back the wrong picture — silently, and only in records with a
  // block we refused.
  assert.deepEqual(msg.images, [{ uuid: 'r2', index: 1, media: 'image/png' }]);
});

test('a captured screenshot is named on the tool_result, not stringified to [image]', () => {
  const rec = shot('u1', [txt('Successfully captured screenshot (1274x952, jpeg)'), txt('Tab Context:'), png()]);
  const [msg] = normalizeRecord(rec);

  assert.equal(msg.kind, 'tool_result');
  assert.deepEqual(msg.images, [{ uuid: 'u1', index: 0, media: 'image/png' }]);
  assert.doesNotMatch(msg.output, /\[image\]/, 'the placeholder is gone');
  assert.match(msg.output, /Successfully captured/, 'the text blocks are untouched');
  assert.equal(JSON.stringify(msg).includes(DATA), false, 'no base64 goes anywhere near the wire');
});

test('images land on the tool_result they came from, when a record carries several', () => {
  const rec = {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-08-29T05:08:48.736Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [txt('no picture here')] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [png()] },
      ],
    },
  };
  const [a, b] = normalizeRecord(rec);
  assert.equal(a.images, undefined, 'a result with no image says nothing about images');
  assert.deepEqual(b.images, [{ uuid: 'u2', index: 0, media: 'image/png' }]);
});

test('a pasted screenshot rides on the user message', () => {
  const rec = {
    type: 'user',
    uuid: 'p1',
    timestamp: '2026-08-24T16:00:32.307Z',
    imagePasteIds: [1],
    message: { role: 'user', content: [txt('[Image #1] - 3 are live, correct?'), png()] },
  };
  const [msg] = normalizeRecord(rec);
  assert.equal(msg.kind, 'user');
  assert.equal(msg.text, '[Image #1] - 3 are live, correct?');
  assert.deepEqual(msg.images, [{ uuid: 'p1', index: 0, media: 'image/png' }]);
});

test('a message that is only an image no longer vanishes', () => {
  const rec = {
    type: 'user',
    uuid: 'p2',
    timestamp: '2026-08-24T16:00:32.307Z',
    message: { role: 'user', content: [png()] },
  };
  const out = normalizeRecord(rec);
  // `textOf` filters to text blocks, and the empty-text check below it returned []. A
  // pasted screenshot with nothing typed beside it was invisible in the panel entirely.
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'user');
  assert.equal(out[0].text, '');
  assert.equal(out[0].images.length, 1);
});

test('a message with neither text nor images is still nothing', () => {
  assert.deepEqual(
    normalizeRecord({ type: 'user', uuid: 'p3', message: { role: 'user', content: [txt('   ')] } }),
    [],
  );
});

test('stitch carries the images onto the chip that asked for them', () => {
  const call = {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-08-29T05:08:40.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }],
    },
  };
  const result = shot('u3', [txt('Successfully captured screenshot'), png()]);
  const [chip] = stitch([...normalizeRecord(call), ...normalizeRecord(result)]);
  assert.equal(chip.kind, 'tool_use');
  assert.deepEqual(chip.result.images, [{ uuid: 'u3', index: 0, media: 'image/png' }]);
});

test('an image on a sidechain record is kept and flagged, not dropped', () => {
  const rec = { ...shot('s1', [txt('captured'), png()]), isSidechain: true };
  const [msg] = normalizeRecord(rec);
  assert.equal(msg.sidechain, true);
  assert.equal(msg.images.length, 1, 'a subagent’s screenshots are part of what the session produced');
});
