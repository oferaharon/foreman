import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.js';

/**
 * Images pasted or dropped into the composer.
 *
 * Dropping a file into the terminal types its path, and Claude Code reads it — verified:
 * the path arrives as user text, Claude calls `Read`, and the tool result carries an
 * image block. So the panel does the same thing: save the bytes, send the path. No new
 * concept, and the transcript stays readable instead of carrying megabytes of base64.
 *
 * Files land outside any repo so a pasted screenshot never shows up in `git status`.
 */

export const IMAGES_DIR = path.join(STATE_DIR, 'images');

const MAX_BYTES = 25 * 1024 * 1024;
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

export async function saveImage(buf, originalName, stamp) {
  if (!buf?.length) throw new Error('Empty upload.');
  if (buf.length > MAX_BYTES) throw new Error('Image is larger than 25MB.');

  const ext = sniff(buf);
  if (!ext) throw new Error('That does not look like a PNG, JPEG, GIF or WebP.');

  await fsp.mkdir(IMAGES_DIR, { recursive: true });
  const file = path.join(IMAGES_DIR, `${stamp}-${safeStem(originalName)}.${ext}`);
  await fsp.writeFile(file, buf);
  return { path: file, bytes: buf.length, ext };
}

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
