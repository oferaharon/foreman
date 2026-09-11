import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { revealablePath } from '../server/outputs.js';
import { revealFile, revealInFinder } from '../server/launch.js';

/*
 * Reveal, and the two halves of what bounds it.
 *
 * The first half is the **address space**: the browser sends `{uuid, index}` and never a
 * path, so `revealablePath` is what turns a record reference into something on disk — and
 * every way that can miss is a test below, because a resolver that answered a path for
 * something it should not have is the whole of what this feature could get wrong. The
 * prior art the plan was measured against accepted any absolute path on its reveal route;
 * here a caller can only name a record, and the records were written by Claude.
 *
 * The second half is **`-R` versus nothing**: `open <file>` runs the file's default
 * handler and `open -R <file>` selects it in Finder. `revealFile` and `revealInFinder`
 * are siblings with opposite guards for that reason, and the tests hold both — a
 * `revealInFinder` loosened to accept a file is how a folder reveal becomes a launch.
 *
 * The spawn is **recorded, never run**: `revealFile` takes its exec as a defaulted
 * parameter (the trick `sessionName` plays with `prefix`), so nothing here puts a Finder
 * window on anybody's screen. Nothing in `server/` passes one.
 *
 * Every record is a reconstruction of a measured shape, and the only project names are
 * `alpha`, `beta` and `gamma`.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-reveal-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A tool-result record: what a `Write` or a `SendUserFile` leaves behind. */
const result = (uuid, toolUseResult, content = 'ok') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-09-11T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t_${uuid}`, content }] },
    toolUseResult,
  });

const write = (filePath, body, type = 'create') => ({
  type,
  filePath,
  content: body,
  structuredPatch: [],
  originalFile: type === 'create' ? null : 'before',
  userModified: false,
});

/** A pasted screenshot: an image block, and 76% of the ones on this Mac have no path. */
const pastedImage = (uuid) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-09-11T10:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }],
    },
  });

/** An assistant record carrying a URL — a link entry's uuid, which names no file at all. */
const citation = (uuid) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-11T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'See https://example.com/alpha/notes' }] },
  });

function transcript(name, lines) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/* --------------------------------------------------------------- resolver */

test('a real write resolves to the path the record carries', async () => {
  const doc = path.join(scratch, 'notes.md');
  const file = transcript('alpha.jsonl', [result('u-write', write(doc, '# notes\n'))]);
  assert.equal(await revealablePath(file, 'u-write'), doc);
  // …and `index` defaults to 0, which is the only index a create ever has.
  assert.equal(await revealablePath(file, 'u-write', 0), doc);
});

test('a SendUserFile attachment resolves — the tool own word, not the extension list', async () => {
  // `web/output-exts.js` filters a `Write` and deliberately not a handover: the tool's
  // whole purpose is giving the maintainer a file, so a `.wav` reveals the way it lists.
  // Being stricter here than the modal is would draw a button that refuses itself.
  const wav = path.join(scratch, 'reading.wav');
  const file = transcript('alpha-wav.jsonl', [
    result('u-send', {
      caption: 'the recording',
      display: 'render',
      attachments: [{ path: wav, size: 12, isImage: false, media_type: 'audio/wav', pathValidated: true }],
    }),
  ]);
  assert.equal(await revealablePath(file, 'u-send'), wav);
});

test('a fabricated uuid resolves to nothing', async () => {
  const file = transcript('alpha-fake.jsonl', [result('u-write', write(path.join(scratch, 'notes.md'), 'x'))]);
  assert.equal(await revealablePath(file, '11111111-2222-3333-4444-555555555555'), null);
  assert.equal(await revealablePath(file, ''), null);
  assert.equal(await revealablePath(file, null), null);
});

test('a real uuid from another session resolves to nothing in this one', async () => {
  // The whole bound, stated as a test: `beta` wrote a document and `alpha` did not, so
  // beta's uuid is simply not in alpha's file. Nothing else refuses it and nothing else
  // has to.
  const betaDoc = path.join(scratch, 'beta-report.md');
  transcript('beta.jsonl', [result('u-beta', write(betaDoc, '# beta\n'))]);
  const alpha = transcript('alpha-only.jsonl', [result('u-alpha', write(path.join(scratch, 'a.md'), 'a'))]);
  assert.equal(await revealablePath(alpha, 'u-beta'), null);
});

test('a .py create resolves to nothing — the extension list, re-asked server-side', async () => {
  const file = transcript('alpha-py.jsonl', [
    result('u-py', write(path.join(scratch, 'build.py'), 'print(1)\n')),
    result('u-js', write(path.join(scratch, 'app.js'), 'let a\n')),
  ]);
  assert.equal(await revealablePath(file, 'u-py'), null);
  assert.equal(await revealablePath(file, 'u-js'), null);
});

test('an update is not a create, and neither reveals', async () => {
  const file = transcript('alpha-update.jsonl', [
    result('u-up', write(path.join(scratch, 'notes.md'), 'more', 'update')),
  ]);
  assert.equal(await revealablePath(file, 'u-up'), null);
});

test('a pathless image resolves to nothing — there is nothing for Finder to select', async () => {
  const file = transcript('alpha-img.jsonl', [pastedImage('u-img')]);
  assert.equal(await revealablePath(file, 'u-img'), null);
});

test('a link entry uuid names no file at all', async () => {
  // A link is a string in the other array; its `uuid` is a real record in this transcript
  // and holds no output block, which is the only reason it misses.
  const file = transcript('alpha-link.jsonl', [citation('u-link')]);
  assert.equal(await revealablePath(file, 'u-link'), null);
});

test('an index past the end, and an index that is not one, resolve to nothing', async () => {
  const doc = path.join(scratch, 'notes.md');
  const file = transcript('alpha-index.jsonl', [result('u-write', write(doc, '# notes\n'))]);
  assert.equal(await revealablePath(file, 'u-write', 1), null);
  assert.equal(await revealablePath(file, 'u-write', -1), null);
  assert.equal(await revealablePath(file, 'u-write', 1.5), null);
  assert.equal(await revealablePath(file, 'u-write', Number('nope')), null);
});

test('a child record naming this one as its parent is not this record', async () => {
  // The line scan is a substring test, so a `parentUuid` match reaches the parse; the
  // record's own field is what decides. `readOutput` learned this first.
  const doc = path.join(scratch, 'notes.md');
  const file = transcript('alpha-child.jsonl', [
    JSON.stringify({ type: 'assistant', uuid: 'u-child', parentUuid: 'u-write', timestamp: '2026-09-11T10:00:01.000Z', message: { role: 'assistant', content: [] } }),
    result('u-write', write(doc, '# notes\n')),
  ]);
  assert.equal(await revealablePath(file, 'u-write'), doc);
});

test('a torn last line is skipped, not thrown over', async () => {
  const doc = path.join(scratch, 'notes.md');
  const file = path.join(scratch, 'alpha-torn.jsonl');
  fs.writeFileSync(file, `${result('u-write', write(doc, '# notes\n'))}\n{"uuid":"u-write","toolUse`);
  assert.equal(await revealablePath(file, 'u-write'), doc);
});

/* ------------------------------------------------------------- the spawn */

test('revealFile reveals rather than opens, and never without -R', async () => {
  const doc = path.join(scratch, 'real-notes.md');
  fs.writeFileSync(doc, '# notes\n');
  const calls = [];
  const out = await revealFile(doc, (...args) => {
    calls.push(args);
    return Promise.resolve({ stdout: '', stderr: '' });
  });
  assert.equal(out, doc);
  assert.equal(calls.length, 1);
  const [bin, argv] = calls[0];
  assert.equal(bin, '/usr/bin/open');
  // `-R` first and the path second: without the flag this is the launcher, which is the
  // one thing the 2026-09-10 ruling removed from a port that has no authentication.
  assert.deepEqual(argv, ['-R', doc]);
});

test('revealFile refuses a directory, and revealInFinder still refuses a file', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'folder-'));
  const doc = path.join(dir, 'notes.md');
  fs.writeFileSync(doc, '# notes\n');

  // Siblings with opposite guards. Loosening either one is how a folder reveal becomes a
  // file launch, which is why the plan asked for a sibling by name.
  await assert.rejects(() => revealFile(dir, () => assert.fail('nothing may be spawned')), /folder, not a file/);
  await assert.rejects(() => revealInFinder(doc), /Not a folder any more/);
});

test('revealFile refuses a gone file and an empty one, and spawns nothing either way', async () => {
  const never = () => assert.fail('nothing may be spawned');
  await assert.rejects(() => revealFile(path.join(scratch, 'deleted.md'), never), /Not a file any more/);
  await assert.rejects(() => revealFile('', never), /Which file\?/);
  await assert.rejects(() => revealFile(null, never), /Which file\?/);
  await assert.rejects(() => revealFile('   ', never), /Which file\?/);
});
