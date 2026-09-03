import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.js';

/**
 * Images and plain-text files pasted or dropped into the composer.
 *
 * Dropping a file into the terminal types its path, and Claude Code reads it — verified:
 * the path arrives as user text, Claude calls `Read`, and the tool result carries an
 * image block. So the panel does the same thing: save the bytes, send the path. No new
 * concept, and the transcript stays readable instead of carrying megabytes of base64.
 *
 * Files land outside any repo so a pasted screenshot never shows up in `git status`.
 *
 * **Text lives in the same folder as images, deliberately.** In manual permission mode a
 * session asks once before reading from a directory outside its project, and the panel's
 * permission card handles that. A second directory would be a second prompt for the same
 * gesture, and the seven-day prune already sweeps whatever is in here.
 *
 * **Two acceptors, and the order between them is the decision.** Images are recognised by
 * their magic bytes and text by its extension, because text has no signature to sniff — so
 * the two questions cannot be asked the same way, and something has to win when they
 * disagree. **Bytes win.** A signature is a fact about the contents; an extension is a
 * claim the client makes about them, and the client here is a browser reporting what some
 * other program happened to name a file. Saving PNG bytes as `notes.txt` because the name
 * said so would hand `Read` a lie about what it is opening. The mirror mistake — a real
 * text file refused because its first bytes looked like a signature — cannot happen: every
 * signature here starts with a byte that is not valid UTF-8, or with `RIFF`/`GIF8` followed
 * by bytes that are not.
 */

export const IMAGES_DIR = path.join(STATE_DIR, 'images');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/**
 * A text file is read straight into a context window, so this cap is about what a session
 * can afford rather than what the disk can hold: a 20MB log dropped by accident is a 20MB
 * `Read`, and by the time anyone notices, the context is spent.
 */
const MAX_TEXT_BYTES = 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;

/** Trust the bytes, not the client's content-type. */
const SIGNATURES = [
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', test: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  {
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** The only extensions that get in on their name alone. */
const TEXT_EXTS = new Set(['txt', 'md']);

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buf))?.ext ?? null;
}

/** Keep the user's name where it's harmless, drop anything that could escape the dir. */
function safeStem(name) {
  const base = path.basename(String(name || 'image'));
  const stem = base.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '');
  return (stem || 'image').slice(0, 60);
}

/**
 * The extension off the same safe basename `safeStem` reduces, matched against a closed
 * set — so nothing a name can spell ever reaches the filesystem as an extension, only
 * `txt`, `md`, or nothing at all.
 */
function textExt(name) {
  const base = path.basename(String(name || ''));
  const ext = (base.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  return TEXT_EXTS.has(ext) ? ext : null;
}

/**
 * Strict UTF-8 and no NUL, which are two checks rather than one on purpose.
 *
 * `fatal: true` is the whole of what makes the decoder a gate — without it, invalid bytes
 * come back as replacement characters and every file on earth is "text". And a NUL passes
 * that gate on its own merits, because U+0000 is perfectly valid UTF-8: it is the byte
 * that says this came out of something binary, and the decoder will never object to it.
 */
function assertPlainText(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Error('That file is not valid UTF-8 text.');
  }
  if (buf.includes(0)) throw new Error('That file has NUL bytes in it, so it is not plain text.');
}

/**
 * Save an upload and hand back where it landed.
 *
 * The extension on the saved name is load-bearing rather than tidy: `Read` opens the path
 * we hand it, and what it makes of the file it finds there depends on that suffix.
 */
export async function saveUpload(buf, originalName, stamp) {
  if (!buf?.length) throw new Error('Empty upload.');

  const image = sniff(buf);
  const ext = image ?? textExt(originalName);
  if (!ext) throw new Error('That is not a PNG, JPEG, GIF or WebP, or a .txt or .md file.');

  if (image) {
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image is larger than 25MB.');
  } else {
    if (buf.length > MAX_TEXT_BYTES) throw new Error('Text file is larger than 1MB.');
    assertPlainText(buf);
  }

  await fsp.mkdir(IMAGES_DIR, { recursive: true });
  const file = path.join(IMAGES_DIR, `${stamp}-${safeStem(originalName)}.${ext}`);
  await fsp.writeFile(file, buf);
  return { path: file, bytes: buf.length, ext, kind: image ? 'image' : 'text' };
}

/** What this was called before it took text too. Kept so no caller breaks on the rename. */
export { saveUpload as saveImage };

/** Housekeeping so a year of pasted screenshots doesn't quietly pile up. */
export async function pruneImages(now) {
  try {
    const names = await fsp.readdir(IMAGES_DIR);
    await Promise.all(
      names.map(async (n) => {
        const f = path.join(IMAGES_DIR, n);
        const st = await fsp.stat(f).catch(() => null);
        if (st && now - st.mtimeMs > KEEP_MS) await fsp.unlink(f).catch(() => {});
      }),
    );
  } catch {
    /* nothing saved yet */
  }
}

/** Only ever serve files we wrote ourselves. */
export function resolveImage(name) {
  const file = path.join(IMAGES_DIR, path.basename(String(name)));
  return fs.existsSync(file) ? file : null;
}
