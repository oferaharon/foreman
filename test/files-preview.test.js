import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREVIEW_KINDS,
  previewActions,
  previewFoot,
  previewHow,
  previewKindFor,
  previewLost,
  previewable,
} from '../web/files-preview.js';

/*
 * Which renderer the preview overlay gives one entry, and what it may be asked to do —
 * run in plain Node, the way `test/files-kinds.test.js` and `test/trust-gate.test.js` are.
 *
 * The entries below are the shapes `GET /api/sessions/:id/outputs` really answers with, in
 * the field spellings `server/outputs.js` stamps — `{source, uuid, index, path, name,
 * kind, media, bytes, ts, sidechain, note, onDisk}` for a file and
 * `{kind: 'link', url, title, from, short, uuid, ts}` for a link — plus the third shape the
 * overlay also has to take: the per-turn strip's `{uuid, index, media}`, which
 * `imageBlocks` in `server/normalize.js` mints and which carries no `kind` and no `source`
 * at all.
 *
 * The load-bearing case is the `.svg` pair. `server/outputs.js`'s media table maps `.svg`
 * to `kind: 'image'`, which is the right answer for a grid thumbnail and the wrong one for
 * a preview, so the same `kind` has to come out `image` for a block and `text` for a file —
 * and `source` is the only field that separates them.
 */

/** A file entry with the defaults filled in, so each test says only what it is about. */
const file = (over = {}) => ({
  source: 'write',
  uuid: 'u1',
  index: 0,
  path: '/Users/someone/alpha/docs/notes.md',
  name: 'notes.md',
  kind: 'markdown',
  media: 'text/markdown; charset=utf-8',
  bytes: 1234,
  ts: '2026-09-11T13:48:00.000Z',
  sidechain: false,
  note: null,
  onDisk: true,
  ...over,
});

test('the four renderer names are the ones the overlay branches on', () => {
  assert.deepEqual(PREVIEW_KINDS, ['image', 'markdown', 'text', 'plain-other']);
});

test('markdown renders, plain text and csv show as text', () => {
  assert.equal(previewKindFor(file()), 'markdown');
  assert.equal(previewKindFor(file({ name: 'notes.markdown', kind: 'markdown' })), 'markdown');
  assert.equal(previewKindFor(file({ name: 'log.txt', kind: 'text' })), 'text');
  assert.equal(previewKindFor(file({ name: 'rows.csv', kind: 'text' })), 'text');
});

test('an image block is an image, whatever it is called', () => {
  // `source: 'image'` is a block in the record: a browser-automation screenshot, a paste,
  // or a `Read` of a picture. 76% of them have no path and no name at all.
  assert.equal(previewKindFor(file({ source: 'image', kind: 'image', name: null, path: null })), 'image');
  assert.equal(previewKindFor(file({ source: 'image', kind: 'image', name: 'shot.png' })), 'image');
});

test("the strip's own ref — no kind, no source, an image media — is an image", () => {
  // Anything else sends the per-turn strip's lightbox to the "no preview" branch, which is
  // the one regression this widening could cause and could not be seen in a unit test of
  // the modal.
  assert.equal(previewKindFor({ uuid: 'u9', index: 2, media: 'image/png' }), 'image');
  assert.equal(previewKindFor({ uuid: 'u9', index: 0, media: 'image/jpeg' }), 'image');
});

test('an .html file is shown as text, never rendered — §7 rule 4', () => {
  // The server already serves it as `text/plain`; this is the same refusal one floor up,
  // so no `innerHTML` and no `iframe` can be reached for it here either.
  assert.equal(previewKindFor(file({ name: 'report.html', kind: 'text' })), 'text');
  assert.equal(previewKindFor(file({ name: 'report.htm', kind: 'text' })), 'text');
  assert.equal(previewKindFor(file({ source: 'sendfile', name: 'page.HTML', kind: 'text' })), 'text');
});

test('an .svg document is text, an .svg image block keeps its <img>', () => {
  // The whole reason this module reads `source` and not only `kind`: the server maps
  // `.svg` to `kind: 'image'`, and an `<img>` of a document the transcript holds is rule 4
  // broken one element over from `innerHTML`.
  assert.equal(previewKindFor(file({ source: 'write', name: 'chart.svg', kind: 'image' })), 'text');
  assert.equal(previewKindFor(file({ source: 'sendfile', name: 'chart.svg', kind: 'image' })), 'text');
  assert.equal(previewKindFor(file({ source: 'image', name: 'chart.svg', kind: 'image' })), 'image');
});

test('an .svg or .html recognised off the path when the entry has no name', () => {
  assert.equal(previewKindFor(file({ name: null, path: '/tmp/alpha/out.svg', kind: 'image' })), 'text');
  assert.equal(previewKindFor(file({ name: null, path: '/tmp/alpha/out.html', kind: 'text' })), 'text');
});

test('everything without a renderer falls to plain-other rather than a failed fetch', () => {
  assert.equal(previewKindFor(file({ name: 'paper.pdf', kind: 'other', media: 'application/pdf' })), 'plain-other');
  assert.equal(previewKindFor(file({ name: 'memo.rtf', kind: 'other' })), 'plain-other');
  assert.equal(previewKindFor(file({ source: 'sendfile', name: 'take.wav', kind: 'other' })), 'plain-other');
  // A kind the wire has never carried is still something the session produced.
  assert.equal(previewKindFor(file({ name: 'x.zip', kind: undefined })), 'plain-other');
});

test('nothing throws on anything, and a non-entry is plain-other', () => {
  for (const junk of [null, undefined, 0, '', 'notes.md', [], [{ kind: 'markdown' }]]) {
    assert.equal(previewKindFor(junk), 'plain-other');
  }
});

test('a link is not previewable and the overlay would refuse it anyway', () => {
  const link = { kind: 'link', url: 'https://example.com/a', title: null, from: 'fetch', short: null, uuid: 'u2', ts: '2026-09-11T13:00:00.000Z' };
  assert.equal(previewable(link), false);
  assert.equal(previewKindFor(link), 'plain-other');
  // …and every file kind is, including the ones with nothing to draw.
  assert.equal(previewable(file()), true);
  assert.equal(previewable(file({ kind: 'other', name: 'paper.pdf' })), true);
  assert.equal(previewable(file({ source: 'sendfile', onDisk: false })), true);
  assert.equal(previewable(null), false);
  assert.equal(previewable([]), false);
});

test('a path buys copy, and no path buys nothing at all', () => {
  // Never a disabled button — the trust gate's discipline, and three images in four on
  // this Mac are pastes or automation screenshots with no path to copy.
  assert.deepEqual(previewActions(file()), ['copy-path']);
  assert.deepEqual(previewActions(file({ path: null })), []);
  assert.deepEqual(previewActions(file({ path: '   ' })), []);
  assert.deepEqual(previewActions(file({ path: 42 })), []);
  assert.deepEqual(previewActions(null), []);
});

test('a gone SendUserFile has nothing left; a gone Write still has the record', () => {
  assert.equal(previewLost(file({ source: 'sendfile', onDisk: false })), true);
  assert.equal(previewLost(file({ source: 'sendfile', onDisk: true })), false);
  assert.equal(previewLost(file({ source: 'write', onDisk: false })), false);
  assert.equal(previewLost(file({ source: 'image', onDisk: null })), false);
  assert.equal(previewLost(null), false);
});

test('how it is shown says when the panel is declining rather than failing', () => {
  assert.equal(previewHow(file()), 'rendered as markdown');
  assert.equal(previewHow(file({ name: 'log.txt', kind: 'text' })), 'shown as text');
  assert.equal(previewHow(file({ name: 'report.html', kind: 'text' })), 'shown as text, never rendered');
  assert.equal(previewHow(file({ name: 'chart.svg', kind: 'image' })), 'shown as text, never rendered');
  assert.equal(previewHow(file({ source: 'image', kind: 'image', name: null, path: null })), 'shown as an image');
  assert.equal(previewHow(file({ name: 'paper.pdf', kind: 'other' })), 'no preview');
});

test('the footer names the time, the size and the way it is drawn', () => {
  assert.equal(
    previewFoot(file(), { at: '13:48', size: '1 KB' }),
    'written by Claude at 13:48 · 1 KB · rendered as markdown',
  );
});

test('a gone Write reads as written, and a gone attachment says there is nothing', () => {
  assert.equal(
    previewFoot(file({ onDisk: false }), { at: '13:48', size: '1 KB' }),
    'written by Claude at 13:48 · 1 KB · as written — the file is no longer on disk',
  );
  assert.equal(
    previewFoot(file({ source: 'sendfile', onDisk: false }), { at: '13:48', size: '1 KB' }),
    'no longer on disk, nothing to preview',
  );
});

test('a strip ref has nothing to put in a footer, and gets no footer', () => {
  // This is what keeps the per-turn strip's lightbox byte-identical to the overlay before
  // documents existed: no `ts`, no `bytes`, so nothing formatted reaches this.
  assert.equal(previewFoot({ uuid: 'u9', index: 1, media: 'image/png' }, {}), '');
  assert.equal(previewFoot({ uuid: 'u9', index: 1, media: 'image/png' }), '');
});

test('a footer with only one fact still draws it', () => {
  assert.equal(previewFoot(file({ ts: null }), { size: '1 KB' }), '1 KB · rendered as markdown');
  assert.equal(previewFoot(file({ bytes: null }), { at: '13:48' }), 'written by Claude at 13:48 · rendered as markdown');
  // Gone is a fact on its own, even with neither of the other two.
  assert.equal(previewFoot(file({ onDisk: false }), {}), 'as written — the file is no longer on disk');
});
