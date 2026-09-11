import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normaliseUrl, outputBlocks, readOutput, scanOutputs } from '../server/outputs.js';

/*
 * The Files view's one promise is that it is *everything*, and nothing else in the panel
 * reads a transcript whole — the tailer backfills a byte window, `probe` samples head and
 * tail. So the first test is the middle one: a document buried under a megabyte of
 * chatter, which every other reader in this codebase would miss.
 *
 * Every record here is a reconstruction of a measured *shape*. Nothing in this file is
 * anyone's transcript content, and the only project names are `alpha`, `beta` and `gamma`.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-outputs-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const img = (data = PNG, media = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: media, data },
});
const txt = (text) => ({ type: 'text', text });

/** A tool result record: what a `Write`, a `SendUserFile` or a Bash call leaves behind. */
const result = (uuid, ts, toolUseResult, content = 'ok', extra = {}) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t_${uuid}`, content }] },
    toolUseResult,
    ...extra,
  });

/** A `Write`'s own record fields — `type` is `create` or `update`, and `Edit` has neither. */
const write = (filePath, body, type = 'create') => ({
  type,
  filePath,
  content: body,
  structuredPatch: [],
  originalFile: type === 'create' ? null : 'before',
  userModified: false,
});

const edit = (filePath) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a',
  structuredPatch: [],
  userModified: false,
  replaceAll: false,
});

const sendfile = (caption, attachments) => ({ caption, display: 'render', attachments });
const attachment = (p, size, media) => ({
  path: p,
  size,
  isImage: String(media || '').startsWith('image/'),
  media_type: media,
  pathValidated: true,
  file_uuid: `f_${path.basename(p)}`,
});

const assistant = (uuid, ts, content) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: { role: 'assistant', content },
  });

const chatter = (i) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `c${i}`,
    timestamp: '2026-09-09T05:00:00.000Z',
    message: { role: 'assistant', content: [txt(`filler ${i} `.repeat(600))]},
  });

function fileOf(name, lines) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/* ------------------------------------------------------------------ the pass */

test('the scan is the whole file — a document under a megabyte of chatter still lists', async () => {
  const lines = [];
  lines.push(result('head', '2026-09-09T05:00:01.000Z', write('/w/alpha/docs/notes.md', '# alpha notes\n')));
  for (let i = 0; i < 400; i += 1) lines.push(chatter(i));
  lines.push(result('mid', '2026-09-09T05:30:00.000Z', write('/w/beta/report.txt', 'beta ran green\n')));
  for (let i = 400; i < 800; i += 1) lines.push(chatter(i));
  lines.push(result('tail', '2026-09-09T06:00:00.000Z', write('/w/gamma/RELEASE.md', 'gamma 1.0\n')));
  const file = fileOf('big.jsonl', lines);
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024, 'big enough that head-and-tail sampling would miss the middle');

  const { outputs, scan } = await scanOutputs(file);
  assert.deepEqual(
    outputs.map((o) => [o.uuid, o.name, o.kind]),
    [
      ['head', 'notes.md', 'markdown'],
      ['mid', 'report.txt', 'text'],
      ['tail', 'RELEASE.md', 'markdown'],
    ],
    'oldest first, and the one in the middle is there',
  );
  assert.ok(scan.parsed < 10, `only witness-shaped lines are parsed (parsed ${scan.parsed} of ${scan.lines})`);
});

test('a create lists and an update of the same path does not', async () => {
  const file = fileOf('pair.jsonl', [
    result('c1', '2026-09-09T05:00:00.000Z', write('/w/alpha/notes.md', 'first')),
    result('u1', '2026-09-09T05:05:00.000Z', write('/w/alpha/notes.md', 'second', 'update')),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(outputs.map((o) => o.uuid), ['c1'], 'only the call that made a file that did not exist');
  // And the condition is the record's own `type`, not "it has a filePath" — which would
  // admit the update, and Edit's thousands of calls the day somebody reuses it.
  assert.equal(await readOutput(file, 'u1'), null);
});

test('an Edit never lists — its result carries no type at all', async () => {
  const file = fileOf('edit.jsonl', [
    result('e1', '2026-09-09T05:00:00.000Z', edit('/w/alpha/README.md')),
    result('e2', '2026-09-09T05:01:00.000Z', edit('/w/alpha/docs/panel.md')),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(outputs, [], 'a modification is not an output');
});

test('a .py create never lists, and neither does anything outside the document set', async () => {
  const file = fileOf('code.jsonl', [
    result('p1', '2026-09-09T05:00:00.000Z', write('/w/alpha/tool.py', 'print(1)')),
    result('p2', '2026-09-09T05:01:00.000Z', write('/w/alpha/app.js', 'let a')),
    result('p3', '2026-09-09T05:02:00.000Z', write('/w/alpha/data.json', '{}')),
    result('p4', '2026-09-09T05:03:00.000Z', write('/w/alpha/page.html', '<p>')),
    result('p5', '2026-09-09T05:04:00.000Z', write('/w/alpha/notes.md', 'kept')),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(outputs.map((o) => o.name), ['notes.md']);
  assert.equal(await readOutput(file, 'p1'), null, 'and the byte route refuses it too');
});

test('a SendUserFile hands over two files, on the tool own word about them', async () => {
  const file = fileOf('handed.jsonl', [
    result(
      's1',
      '2026-09-09T05:00:00.000Z',
      sendfile('the beta walk-sheet and the sound it makes', [
        attachment('/w/beta/walk-sheet.pdf', 51200, 'application/pdf'),
        attachment('/w/beta/chime.wav', 8000, 'audio/wav'),
      ]),
    ),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(
    outputs.map((o) => [o.source, o.index, o.name, o.kind, o.media, o.bytes]),
    [
      ['sendfile', 0, 'walk-sheet.pdf', 'other', 'application/pdf', 51200],
      ['sendfile', 1, 'chime.wav', 'other', 'audio/wav', 8000],
    ],
    'each attachment is one entry, and a .wav lists because the tool handed it over',
  );
  assert.equal(outputs[0].note, 'the beta walk-sheet and the sound it makes', 'the caption is the note');
  assert.equal(outputs[1].note, 'the beta walk-sheet and the sound it makes');
});

test('an image lists beside a document, and keeps the ordinal the walk gave it', async () => {
  const url = { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } };
  const svg = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zy8+' } };
  const file = fileOf('shot.jsonl', [
    JSON.stringify({
      type: 'user',
      uuid: 'sh',
      timestamp: '2026-09-09T05:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't_sh',
            content: [txt('Successfully captured screenshot (1274x952, png)'), url, svg, img()],
          },
        ],
      },
    }),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(outputs.map((o) => [o.source, o.index]), [['image', 2]], 'the survivor keeps its number');
  assert.equal(outputs[0].path, null, 'and claims no path, because there is none');
  assert.equal(outputs[0].note, 'Successfully captured screenshot (1274x952, png)');
  assert.equal(await readOutput(file, 'sh', 0), null, 'the refused blocks stay refused at the byte end');
  assert.equal(await readOutput(file, 'sh', 1), null);
  assert.ok(await readOutput(file, 'sh', 2));
});

test('one record, images and a document: one index space, and the images keep theirs', async () => {
  // Contrived — a `create` result carries no image blocks in any record measured. It is
  // pinned anyway because `readOutput` has only a uuid and a number to go on, so the
  // enumeration has to be unambiguous whether or not today's data happens to be tidy.
  const file = fileOf('both.jsonl', [
    JSON.stringify({
      type: 'user',
      uuid: 'mix',
      timestamp: '2026-09-09T05:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_mix', content: [img(), img()] }] },
      toolUseResult: write('/w/gamma/notes.md', 'gamma'),
    }),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(
    outputs.map((o) => [o.source, o.index]),
    [['image', 0], ['image', 1], ['write', 2]],
    'the document is numbered past the pre-filter image count',
  );
  const doc = await readOutput(file, 'mix', 2);
  assert.equal(doc.buffer.toString('utf8'), 'gamma', 'and index 2 is the document at both ends');
});

test('a torn last line is skipped, not thrown over', async () => {
  const file = path.join(scratch, 'torn.jsonl');
  fs.writeFileSync(
    file,
    `${result('ok', '2026-09-09T05:00:00.000Z', write('/w/alpha/notes.md', 'kept'))}\n` +
      '{"type":"user","uuid":"half","toolUseResult":{"type":"create","filePath":"/w/alpha/b.md","con',
  );
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(outputs.map((o) => o.uuid), ['ok']);
  assert.ok(await readOutput(file, 'ok'));
});

/* ------------------------------------------------------------------ bytes */

test("a write's bytes come out of the record, not off disk", async () => {
  const body = '# alpha release notes\n\n- it works\n';
  const file = fileOf('bytes.jsonl', [
    result('w1', '2026-09-09T05:00:00.000Z', write('/w/alpha/does-not-exist/RELEASE.md', body)),
  ]);
  const got = await readOutput(file, 'w1');
  assert.equal(got.source, 'write');
  assert.equal(got.media, 'text/markdown; charset=utf-8');
  assert.equal(got.buffer.toString('utf8'), body, 'as written, with nothing on disk to read');
  assert.equal(got.path, '/w/alpha/does-not-exist/RELEASE.md');
});

test("a sendfile's bytes come off disk, and a gone one is a miss", async () => {
  const real = path.join(scratch, 'handed.txt');
  fs.writeFileSync(real, 'beta output\n');
  const file = fileOf('disk.jsonl', [
    result('d1', '2026-09-09T05:00:00.000Z', sendfile('here', [attachment(real, 12, 'text/plain')])),
    result('d2', '2026-09-09T05:01:00.000Z', sendfile('gone', [attachment(path.join(scratch, 'nope.txt'), 3, 'text/plain')])),
  ]);
  const got = await readOutput(file, 'd1', 0);
  assert.equal(got.source, 'sendfile');
  assert.equal(got.buffer.toString('utf8'), 'beta output\n');
  assert.ok(got.mtimeMs > 0 && got.size === 12, 'mtime and size, for the ETag the route builds');
  assert.equal(await readOutput(file, 'd2', 0), null, 'those bytes were never in the transcript');
});

test('the media type is keyed on the extension, never reflected from the record', async () => {
  const file = fileOf('media.jsonl', [
    // The tool's own `media_type` is a lie here on purpose.
    result('m1', '2026-09-09T05:00:00.000Z', sendfile('x', [attachment('/w/alpha/a.txt', 4, 'text/html; charset=evil')])),
    result('m2', '2026-09-09T05:01:00.000Z', sendfile('x', [attachment('/w/alpha/mockup.html', 4, 'text/html')])),
    result('m3', '2026-09-09T05:02:00.000Z', sendfile('x', [attachment('/w/alpha/thing.xyz', 4, 'application/xyz')])),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.deepEqual(outputs.map((o) => o.media), [
    'text/plain; charset=utf-8',
    'text/plain; charset=utf-8', // an .html is never served as HTML
    'application/octet-stream',
  ]);
  assert.deepEqual(outputs.map((o) => o.kind), ['text', 'text', 'other']);
});

test('a miss is a miss, whichever way it misses', async () => {
  const file = fileOf('miss.jsonl', [result('ok', '2026-09-09T05:00:00.000Z', write('/w/alpha/a.md', 'x'))]);
  assert.equal(await readOutput(file, 'nope'), null, 'unknown record');
  assert.equal(await readOutput(file, 'ok', 9), null, 'index past the end');
  assert.equal(await readOutput(file, 'ok', -1), null, 'negative index');
  assert.equal(await readOutput(file, 'ok', Number('x')), null, 'unparseable index');
  assert.equal(await readOutput(file, '', 0), null, 'no uuid at all');
});

test('a sidechain output is kept and flagged', async () => {
  const file = fileOf('side.jsonl', [
    result('s', '2026-09-09T05:00:00.000Z', write('/w/alpha/a.md', 'x'), 'ok', { isSidechain: true }),
  ]);
  const { outputs } = await scanOutputs(file);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].sidechain, true);
});

/* ------------------------------------------------------------------ links */

/** A WebSearch result: thirty hits, one of them issue-shaped, none of them read. */
function searchResult(uuid, ts) {
  const urls = [];
  for (let i = 0; i < 29; i += 1) urls.push(`https://hit${i}.example.test/page/${i}`);
  urls.push('https://forge.example.test/alpha/alpha/issues/77');
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t_${uuid}`, content: urls.map((u) => `- ${u}`).join('\n') }],
    },
    toolUseResult: {
      query: 'how does gamma do it',
      results: [{ tool_use_id: `t_${uuid}`, content: urls.map((url) => ({ title: 'a hit', url })) }],
      durationSeconds: 6.1,
      searchCount: 1,
    },
  });
}

test('thirty URLs in a search result contribute none, while a fetch and a citation do', async () => {
  const file = fileOf('links.jsonl', [
    searchResult('ws', '2026-09-09T05:00:00.000Z'),
    assistant('a1', '2026-09-09T05:01:00.000Z', [
      { type: 'tool_use', id: 'tu1', name: 'WebFetch', input: { url: 'https://docs.example.test/guide', prompt: 'read it' } },
    ]),
    assistant('a2', '2026-09-09T05:02:00.000Z', [
      txt('Per [the release notes](https://docs.example.test/notes) this is fixed.'),
    ]),
  ]);
  const { links } = await scanOutputs(file);
  assert.deepEqual(
    links.map((l) => [l.url, l.from, l.title]),
    [
      ['https://docs.example.test/guide', 'fetched', null],
      ['https://docs.example.test/notes', 'cited', 'the release notes'],
    ],
    'the search result is refused whole — including the issue URL inside it',
  );
  assert.equal(links.every((l) => l.kind === 'link'), true);
  assert.deepEqual(links.map((l) => l.short), ['docs.example.test', 'docs.example.test']);
});

test('an issue or PR URL in a Bash result is what the session created', async () => {
  const file = fileOf('created.jsonl', [
    result(
      'b1',
      '2026-09-09T05:00:00.000Z',
      { stdout: 'https://forge.example.test/alpha/alpha/pulls/133\n', stderr: '', interrupted: false, isImage: false },
      'https://forge.example.test/alpha/alpha/pulls/133\nsomething at https://example.test/unrelated/page too\n',
    ),
  ]);
  const { links } = await scanOutputs(file);
  assert.deepEqual(
    links.map((l) => [l.url, l.from, l.short]),
    [['https://forge.example.test/alpha/alpha/pulls/133', 'created', '#133']],
    'issue/PR-shaped only — the other URL in the same result is not a link the session exposed',
  );
});

test('a fetched page own outbound links are not the session own', async () => {
  const file = fileOf('fetchres.jsonl', [
    result(
      'f1',
      '2026-09-09T05:00:00.000Z',
      { bytes: 1400, code: 200, codeText: 'OK', result: 'see https://forge.example.test/beta/beta/issues/9', durationMs: 300, url: 'https://docs.example.test/guide' },
      'see https://forge.example.test/beta/beta/issues/9',
    ),
  ]);
  const { links } = await scanOutputs(file);
  assert.deepEqual(links, [], 'the URL it went to is read off the tool_use input, not out of the page');
});

test('one address, one row: the strongest provenance wins and the earliest timestamp orders it', async () => {
  const pr = 'https://forge.example.test/gamma/gamma/pulls/12';
  const file = fileOf('dedupe.jsonl', [
    assistant('a1', '2026-09-09T05:00:00.000Z', [txt(`Opened [the gamma PR](${pr}) just now.`)]),
    assistant('a2', '2026-09-09T05:01:00.000Z', [txt(`See ${pr}#issuecomment-1 and ${pr}. Also ${pr})`)]),
    result(
      'b1',
      '2026-09-09T05:02:00.000Z',
      { stdout: pr, stderr: '', interrupted: false, isImage: false },
      `${pr}/files\n${pr}\n`,
    ),
  ]);
  const { links } = await scanOutputs(file);
  assert.equal(links.length, 2, 'the fragment, the trailing full stop and the trailing bracket are one address');
  const row = links.find((l) => l.url === pr);
  assert.equal(row.from, 'created', 'created beats cited');
  assert.equal(row.ts, '2026-09-09T05:00:00.000Z', 'the earliest sighting orders it');
  assert.equal(row.uuid, 'a1', 'and the uuid is that same record — the pair never names two');
  assert.equal(row.title, 'the gamma PR', 'and the title the prose gave it sticks');
  assert.equal(row.short, '#12');
  const other = links.find((l) => l.url !== pr);
  assert.equal(other.url, `${pr}/files`, 'a URL whose number is not last is a different address');
  assert.equal(other.short, 'forge.example.test', 'and gets the host, never an invented number');
});

test('a cited URL with no link text gets no title, and a user record is not prose', async () => {
  const file = fileOf('bare.jsonl', [
    assistant('a1', '2026-09-09T05:00:00.000Z', [txt('Read https://docs.example.test/a for the rest.')]),
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-09-09T05:01:00.000Z',
      message: { role: 'user', content: [txt('what about https://docs.example.test/typed-by-hand')] },
    }),
  ]);
  const { links } = await scanOutputs(file);
  assert.deepEqual(
    links.map((l) => [l.url, l.title]),
    [['https://docs.example.test/a', null]],
    'assistant text blocks only, and no title is invented',
  );
});

test('normalisation drops the fragment and trims the tail, and refuses a non-URL', () => {
  assert.equal(normaliseUrl('https://x.example.test/a#top'), 'https://x.example.test/a');
  assert.equal(normaliseUrl('https://x.example.test/a.'), 'https://x.example.test/a');
  assert.equal(normaliseUrl('https://x.example.test/a),'), 'https://x.example.test/a');
  assert.equal(normaliseUrl('https://x.example.test/a/'), 'https://x.example.test/a');
  assert.equal(normaliseUrl('https://x.example.test/'), 'https://x.example.test');
  assert.equal(normaliseUrl('not a url'), null);
  assert.equal(normaliseUrl('ftp://x.example.test/a'), null);
  assert.equal(normaliseUrl(''), null);
});

test('the enumerator is the only thing that mints an address', () => {
  const rec = {
    uuid: 'r',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [img()] }] },
    toolUseResult: sendfile('two', [attachment('/w/alpha/a.md', 1, 'text/markdown'), attachment('/w/alpha/b.md', 1, 'text/markdown')]),
  };
  assert.deepEqual(
    outputBlocks(rec).map((e) => [e.source, e.index]),
    [['image', 0], ['sendfile', 1], ['sendfile', 2]],
  );
  // A malformed attachment still consumes its number, so the ones after it keep theirs.
  const holey = { ...rec, message: { role: 'user', content: [] }, toolUseResult: sendfile('x', [{ size: 1 }, attachment('/w/alpha/b.md', 1, 'text/markdown')]) };
  assert.deepEqual(outputBlocks(holey).map((e) => [e.source, e.index]), [['sendfile', 1]]);
});
