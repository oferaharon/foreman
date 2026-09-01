import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readImage, scanImages } from '../server/images.js';

/*
 * The gallery's one promise is that it is *everything*, and nothing else in the panel
 * reads a transcript whole — the tailer backfills a byte window, `probe` samples head and
 * tail. So the test that matters is the middle one: an image buried under a megabyte of
 * chatter, which every other reader in this codebase would miss.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-images-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// A real 1x1 PNG and a real 1x1 JPEG — decoded bytes are checked against their magic
// numbers below, so a base64 round trip that quietly mangles anything shows up here.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z';

const img = (data, media) => ({ type: 'image', source: { type: 'base64', media_type: media, data } });
const txt = (text) => ({ type: 'text', text });

const shot = (uuid, ts, blocks, extra = {}) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t_${uuid}`, content: blocks }] },
    toolUseResult: blocks,
    ...extra,
  });

const chatter = (i, parent) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `c${i}`,
    parentUuid: parent,
    timestamp: '2026-08-29T05:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: `filler ${i} `.repeat(600) }] },
  });

/** A file with images at the very start, the very middle and the very end. */
function bigFile(name) {
  const file = path.join(scratch, name);
  const lines = [];
  lines.push(shot('head', '2026-08-29T05:00:01.000Z', [txt('Successfully captured screenshot (1274x952, jpeg)'), img(JPEG, 'image/jpeg')]));
  for (let i = 0; i < 400; i += 1) lines.push(chatter(i, 'head'));
  lines.push(
    JSON.stringify({
      type: 'user',
      uuid: 'pasted',
      timestamp: '2026-08-29T05:30:00.000Z',
      imagePasteIds: [1],
      message: { role: 'user', content: [txt('[Image #1] - is that right?'), img(PNG, 'image/png')] },
    }),
  );
  for (let i = 400; i < 800; i += 1) lines.push(chatter(i, 'pasted'));
  lines.push(shot('tail', '2026-08-29T06:00:00.000Z', [txt('two of them'), img(PNG, 'image/png'), img(JPEG, 'image/jpeg')]));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('the scan is the whole file, not the window a reader would see', async () => {
  const file = bigFile('big.jsonl');
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024, 'big enough that head-and-tail sampling would miss the middle');

  const { images, scan } = await scanImages(file);
  assert.deepEqual(
    images.map((i) => [i.uuid, i.index, i.media]),
    [
      ['head', 0, 'image/jpeg'],
      ['pasted', 0, 'image/png'],
      ['tail', 0, 'image/png'],
      ['tail', 1, 'image/jpeg'],
    ],
    'oldest first, and the one in the middle is there',
  );
  assert.ok(scan.parsed < 10, `only image-shaped lines are parsed (parsed ${scan.parsed} of ${scan.lines})`);
});

test('a scanned image says where it came from, and nothing it cannot know', async () => {
  const { images } = await scanImages(bigFile('notes.jsonl'));
  const [head, pasted] = images;

  assert.equal(head.toolUseId, 't_head', 'a tool captured this one');
  assert.equal(head.note, 'Successfully captured screenshot (1274x952, jpeg)');
  assert.equal(head.ts, '2026-08-29T05:00:01.000Z');
  assert.equal(head.sidechain, false);

  assert.equal(pasted.toolUseId, null, 'this one was pasted at the top of a user record');
  assert.equal(pasted.note, '[Image #1] - is that right?');

  // There is no filename anywhere in these records — `toolUseResult` duplicates the
  // content blocks and carries no path — so nothing here claims one.
  assert.equal('file' in head, false);
  assert.equal('path' in head, false);
});

test('a sidechain image is kept and flagged', async () => {
  const file = path.join(scratch, 'side.jsonl');
  fs.writeFileSync(file, `${shot('s1', '2026-08-29T05:00:00.000Z', [img(PNG, 'image/png')], { isSidechain: true })}\n`);
  const { images } = await scanImages(file);
  assert.equal(images.length, 1);
  assert.equal(images[0].sidechain, true);
});

test('an image the panel will not serve is not offered', async () => {
  const file = path.join(scratch, 'odd.jsonl');
  const url = { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } };
  const svg = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zy8+' } };
  fs.writeFileSync(file, `${shot('o1', '2026-08-29T05:00:00.000Z', [url, svg, img(PNG, 'image/png')])}\n`);

  const { images } = await scanImages(file);
  assert.deepEqual(images.map((i) => i.index), [2], 'the survivor keeps the ordinal the walk gave it');
  assert.equal(await readImage(file, 'o1', 0), null, 'and the two we refused stay refused at the byte end too');
  assert.equal(await readImage(file, 'o1', 1), null);
});

test('the bytes come back, and they are the right ones', async () => {
  const file = bigFile('bytes.jsonl');

  const first = await readImage(file, 'tail', 0);
  assert.equal(first.media, 'image/png');
  assert.deepEqual([...first.buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');

  const second = await readImage(file, 'tail', 1);
  assert.equal(second.media, 'image/jpeg');
  assert.deepEqual([...second.buffer.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');

  assert.notDeepEqual(first.buffer, second.buffer, 'the ordinal picks between two images in one record');
});

test('a uuid that is only mentioned by a later record is not that record', async () => {
  // Every reply names its parent in `parentUuid`, so the raw substring matches hundreds of
  // lines. Only `rec.uuid` decides — search-and-take-the-first hands back the wrong image
  // whenever the record has children, which is always.
  const file = bigFile('parents.jsonl');
  const got = await readImage(file, 'head', 0);
  assert.equal(got.media, 'image/jpeg', 'the record itself, not the first line that mentions it');
});

test('a miss is a miss, whichever way it misses', async () => {
  const file = bigFile('miss.jsonl');
  assert.equal(await readImage(file, 'nope', 0), null, 'unknown record');
  assert.equal(await readImage(file, 'tail', 9), null, 'index past the end');
  assert.equal(await readImage(file, 'tail', -1), null, 'negative index');
  assert.equal(await readImage(file, 'tail', Number('x')), null, 'unparseable index');
  assert.equal(await readImage(file, '', 0), null, 'no uuid at all');
});

test('a torn last line is skipped, not thrown over', async () => {
  const file = path.join(scratch, 'torn.jsonl');
  fs.writeFileSync(
    file,
    `${shot('ok', '2026-08-29T05:00:00.000Z', [img(PNG, 'image/png')])}\n{"type":"user","uuid":"half","message":{"content":[{"type":"image`,
  );
  const { images } = await scanImages(file);
  assert.deepEqual(images.map((i) => i.uuid), ['ok']);
  assert.ok(await readImage(file, 'ok', 0));
});
