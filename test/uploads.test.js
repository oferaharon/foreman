import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * `IMAGES_DIR` is derived from `STATE_DIR` at module load, so the scratch dir has to be in
 * the environment before the import — the same shape `gc.test.js` uses.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-uploads-'));
const { saveUpload, saveImage, IMAGES_DIR, resolveImage } = await import('../server/uploads.js');

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

/** A real 1x1 PNG — the sniffer reads its first eight bytes, so a fake would not do. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let stamp = 1_700_000_000_000;
const next = () => (stamp += 1);

/** What is actually on disk afterwards, so a test cannot pass on a return value alone. */
const written = (saved) => fs.readFileSync(saved.path);

const rejects = async (buf, name, message) => {
  const before = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [];
  await assert.rejects(() => saveUpload(buf, name, next()), message);
  const after = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [];
  assert.deepEqual(after, before, 'a refusal writes nothing');
};

test('a UTF-8 .txt is accepted and keeps its extension', async () => {
  const body = Buffer.from('plain notes, nothing special\n', 'utf8');
  const saved = await saveUpload(body, 'notes.txt', next());

  assert.equal(saved.ext, 'txt');
  assert.equal(saved.kind, 'text');
  assert.equal(saved.bytes, body.length);
  assert.match(path.basename(saved.path), /^\d+-notes\.txt$/, 'stamp, stem, and the extension Read needs');
  assert.deepEqual(written(saved), body, 'byte for byte');
});

test('a .md is accepted the same way, and non-ASCII survives', async () => {
  // Markdown with a wide character in it: the strict decoder has to *accept* real UTF-8,
  // not merely reject the bytes that are not.
  const body = Buffer.from('# Título\n\nWith an em—dash and an emoji 🙂.\n', 'utf8');
  const saved = await saveUpload(body, 'README.md', next());

  assert.equal(saved.ext, 'md');
  assert.equal(saved.kind, 'text');
  assert.match(path.basename(saved.path), /^\d+-README\.md$/);
  assert.equal(written(saved).toString('utf8'), body.toString('utf8'));
});

test('the extension is matched case-insensitively and saved lowercase', async () => {
  const saved = await saveUpload(Buffer.from('shouty\n', 'utf8'), 'NOTES.TXT', next());
  assert.equal(saved.ext, 'txt');
  assert.match(path.basename(saved.path), /^\d+-NOTES\.txt$/, 'the stem keeps its case, the extension does not');
});

test('magic bytes beat the extension: a real PNG named .txt saves as .png', async () => {
  // The precedence has to be decided rather than fallen into. Bytes win, because the
  // extension is a claim the client makes and the signature is a fact about the file —
  // and saving image bytes under `.txt` would hand `Read` a lie about what it is opening.
  const saved = await saveUpload(PNG, 'screenshot.txt', next());

  assert.equal(saved.ext, 'png');
  assert.equal(saved.kind, 'image');
  assert.match(path.basename(saved.path), /^\d+-screenshot\.png$/);
  assert.deepEqual(written(saved), PNG);
});

test('an image still needs no help from its name', async () => {
  const saved = await saveUpload(PNG, 'pasted', next());
  assert.equal(saved.ext, 'png');
  assert.equal(saved.kind, 'image');
  assert.match(path.basename(saved.path), /^\d+-pasted\.png$/);
});

test('invalid UTF-8 is refused even with a text extension', async () => {
  // A lone 0x80 continuation byte: valid latin1, not valid UTF-8. This is the case a
  // decoder without `fatal: true` would silently paper over with replacement characters.
  await rejects(Buffer.from([0x68, 0x69, 0x80, 0x0a]), 'notes.md', /UTF-8/);
});

test('a NUL byte is refused, because the decoder alone would not', async () => {
  // U+0000 *is* valid UTF-8, so the strict decoder accepts it and only an explicit check
  // catches it. Whatever it is, it is not the plain text this accepts.
  const nul = Buffer.concat([Buffer.from('before'), Buffer.from([0x00]), Buffer.from('after\n')]);
  await rejects(nul, 'notes.txt', /NUL/);
});

test('text over 1MB is refused — the cap is on what lands in a context window', async () => {
  const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
  await rejects(big, 'huge.txt', /1MB/);

  const justUnder = Buffer.alloc(1024 * 1024, 0x61);
  const saved = await saveUpload(justUnder, 'big.txt', next());
  assert.equal(saved.bytes, 1024 * 1024, 'and the cap is a ceiling, not a fence a byte short');
});

test('an unknown type is still refused, and the message says what is accepted', async () => {
  await rejects(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x21, 0x7a]), 'archive.zip', /PNG|\.txt/);
  await rejects(Buffer.from('# not markdown by name\n', 'utf8'), 'notes.rtf', /PNG|\.txt/);
  await rejects(Buffer.from('', 'utf8'), 'empty.txt', /Empty/);
});

test('an extension cannot escape the folder, whatever the name claims', async () => {
  const saved = await saveUpload(Buffer.from('hi\n', 'utf8'), '../../../../etc/passwd.md', next());
  assert.equal(path.dirname(saved.path), IMAGES_DIR, 'basename first, always');
  assert.match(path.basename(saved.path), /^\d+-passwd\.md$/);
  assert.ok(resolveImage(path.basename(saved.path)), 'and it serves back from the one folder');
});

test('safeStem is unchanged — text rides the same sanitising images already got', async () => {
  const saved = await saveUpload(Buffer.from('hi\n', 'utf8'), 'my notes (final)!.md', next());
  assert.match(path.basename(saved.path), /^\d+-my-notes-final-\.md$/);

  const png = await saveUpload(PNG, 'my notes (final)!.png', next());
  assert.match(path.basename(png.path), /^\d+-my-notes-final-\.png$/, 'the same stem an image would get');
});

test('saveImage is still exported, and is the same function', () => {
  assert.equal(saveImage, saveUpload, 'the old name is an alias, not a second implementation');
});
