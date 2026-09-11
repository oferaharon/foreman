import assert from 'node:assert/strict';
import test from 'node:test';

import { FILE_KINDS, filesCounts, filesFor, filesItems, pillFor } from '../web/files-kinds.js';

/*
 * The filter row's arithmetic, run in plain Node — `web/files-kinds.js` is DOM-free for
 * exactly this reason, the way `web/trust-gate.js` and `web/session-colour.js` are.
 *
 * The fixtures are the two arrays `GET /api/sessions/:id/outputs` really answers with, in
 * the field spellings `server/outputs.js` stamps: a file entry carries
 * `{source, uuid, index, path, name, kind, media, bytes, ts, sidechain, note, onDisk}` and
 * a link entry carries `{kind: 'link', url, title, from, short, uuid, ts}`.
 */

const outputs = [
  // Oldest first, which is the order the scan emits.
  {
    source: 'image',
    uuid: 'aaa',
    index: 0,
    path: null,
    name: null,
    kind: 'image',
    media: 'image/png',
    bytes: 61234,
    ts: '2026-09-11T12:10:00.000Z',
    sidechain: false,
    note: 'a screenshot of the rail',
    onDisk: null,
  },
  {
    source: 'write',
    uuid: 'bbb',
    index: 0,
    path: '/alpha/notes.md',
    name: 'notes.md',
    kind: 'markdown',
    media: 'text/markdown; charset=utf-8',
    bytes: 1240,
    ts: '2026-09-11T12:20:00.000Z',
    sidechain: false,
    note: null,
    onDisk: true,
  },
  {
    source: 'write',
    uuid: 'ccc',
    index: 0,
    path: '/alpha/bench.txt',
    name: 'bench.txt',
    kind: 'text',
    media: 'text/plain; charset=utf-8',
    bytes: 310,
    ts: '2026-09-11T12:40:00.000Z',
    sidechain: false,
    note: null,
    onDisk: false,
  },
  {
    source: 'sendfile',
    uuid: 'ddd',
    index: 0,
    path: '/private/tmp/summary.pdf',
    name: 'summary.pdf',
    kind: 'other',
    media: 'application/pdf',
    bytes: 88000,
    ts: '2026-09-11T12:50:00.000Z',
    sidechain: false,
    note: 'the summary',
    onDisk: false,
  },
];

const links = [
  {
    kind: 'link',
    url: 'https://example.com/guide',
    title: 'A guide to something',
    from: 'fetched',
    short: 'example.com',
    uuid: 'eee',
    ts: '2026-09-11T12:30:00.000Z',
  },
  {
    kind: 'link',
    url: 'https://gitea.example.net/owner/repo/pulls/12',
    title: null,
    from: 'created',
    short: '#12',
    uuid: 'fff',
    ts: '2026-09-11T12:45:00.000Z',
  },
];

const data = { outputs, links };

test('the six pills, in the order the row draws them', () => {
  assert.deepEqual(FILE_KINDS, ['all', 'images', 'markdown', 'text', 'links', 'other']);
});

test('every entry shape the endpoint can send lands on exactly one pill', () => {
  assert.equal(pillFor(outputs[0]), 'images');
  assert.equal(pillFor(outputs[1]), 'markdown');
  assert.equal(pillFor(outputs[2]), 'text');
  assert.equal(pillFor(outputs[3]), 'other');
  assert.equal(pillFor(links[0]), 'links');
  assert.equal(pillFor(links[1]), 'links');
});

test('a link is recognised by its own `kind`, never by having a url', () => {
  // The day a file entry grows a URL-shaped field is the day a document quietly moves
  // into the links pill if this is written as "has a url".
  assert.equal(pillFor({ kind: 'markdown', url: 'https://example.com/x' }), 'markdown');
  assert.equal(pillFor({ kind: 'link', url: 'https://example.com/x' }), 'links');
});

test('a kind the table has never heard of is `other`, not a refusal', () => {
  assert.equal(pillFor({ kind: 'audio' }), 'other');
  assert.equal(pillFor({}), 'other');
});

test('anything that is not an entry at all is refused', () => {
  for (const junk of [null, undefined, 'x', 7, []]) assert.equal(pillFor(junk), null, String(junk));
});

test('the counts: `all` is the total and the other five partition it exactly', () => {
  const items = filesItems(data);
  const counts = filesCounts(items);
  assert.deepEqual(counts, { all: 6, images: 1, markdown: 1, text: 1, links: 2, other: 1 });
  const partitioned = counts.images + counts.markdown + counts.text + counts.links + counts.other;
  assert.equal(partitioned, counts.all, 'the five add up to `all`');
});

test('each pill shows exactly the members it counted', () => {
  const items = filesItems(data);
  const counts = filesCounts(items);
  for (const kind of FILE_KINDS) {
    const shown = filesFor(items, kind);
    assert.equal(shown.length, counts[kind], kind);
    if (kind !== 'all') for (const it of shown) assert.equal(pillFor(it), kind, kind);
  }
  // `all` really is everything, and no entry is in two pills.
  const seen = FILE_KINDS.filter((k) => k !== 'all').flatMap((k) => filesFor(items, k));
  assert.equal(seen.length, items.length);
  assert.equal(new Set(seen).size, items.length);
});

test('files and links interleave by `ts` under `all`, newest first', () => {
  const items = filesItems(data);
  assert.deepEqual(
    items.map((it) => it.name || it.short || 'image'),
    ['summary.pdf', '#12', 'bench.txt', 'example.com', 'notes.md', 'image'],
  );
  // Not files-then-links: the PR link sits between two documents, where its timestamp puts
  // it. Grouping them would make `all` a different order from every other pill's.
  assert.equal(items[1].kind, 'link');
  assert.equal(items[0].kind, 'other');
});

test('an entry the transcript never dated sorts last, not first', () => {
  const items = filesItems({
    outputs: [
      { kind: 'text', name: 'undated.txt', ts: null },
      ...outputs,
    ],
    links: [],
  });
  assert.equal(items[items.length - 1].name, 'undated.txt');
});

test('two entries sharing a timestamp keep the order they arrived in', () => {
  const ts = '2026-09-11T13:00:00.000Z';
  const items = filesItems({
    outputs: [
      { kind: 'markdown', name: 'first.md', ts },
      { kind: 'markdown', name: 'second.md', ts },
    ],
    links: [{ kind: 'link', url: 'https://example.com/z', short: 'example.com', ts }],
  });
  assert.deepEqual(items.map((it) => it.name || it.short), ['first.md', 'second.md', 'example.com']);
});

test('an empty or missing answer is an empty list, never a throw', () => {
  for (const empty of [undefined, null, {}, { outputs: [], links: [] }, { outputs: 'x', links: 3 }]) {
    const items = filesItems(empty);
    assert.deepEqual(items, []);
    assert.deepEqual(filesCounts(items), { all: 0, images: 0, markdown: 0, text: 0, links: 0, other: 0 });
    assert.deepEqual(filesFor(items, 'images'), []);
  }
});

test('junk inside either array is dropped rather than counted', () => {
  const items = filesItems({ outputs: [null, 'x', outputs[1]], links: [undefined, links[0]] });
  assert.equal(items.length, 2);
  assert.deepEqual(filesCounts(items), { all: 2, images: 0, markdown: 1, text: 0, links: 1, other: 0 });
});

test('`filesFor` with no kind, or an unknown one, answers all / nothing', () => {
  const items = filesItems(data);
  assert.equal(filesFor(items, undefined).length, items.length);
  assert.equal(filesFor(items, 'all').length, items.length);
  assert.equal(filesFor(items, 'video').length, 0);
});

test('the gone state rides on the entry and changes no pill', () => {
  // `onDisk: false` is a fact about the disk, not a kind: a deleted `.txt` is still under
  // the text pill, which is what keeps "what did this session produce" answerable.
  const items = filesItems(data);
  const bench = items.find((it) => it.name === 'bench.txt');
  assert.equal(bench.onDisk, false);
  assert.equal(pillFor(bench), 'text');
  assert.ok(filesFor(items, 'text').includes(bench));
});
