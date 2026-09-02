import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { svg, FILES } from '../scripts/make-icons.mjs';

/*
 * The installable app: its two manifests, its icons, and the two `<head>`s that reference
 * them.
 *
 * None of this can be proven from a test — whether an icon *looks* right in the Dock is a
 * pair of eyes on a Mac, and the report says so. What a test can hold is everything that
 * breaks silently: a manifest naming a file nobody generated, two apps sharing an `id`
 * (which makes them one app to a browser, so installing the second replaces the first),
 * a `theme_color` that has drifted from the palette it was copied out of, and an
 * `apple-touch-icon` with an alpha channel, which iOS fills in with a colour nobody chose.
 *
 * The PNGs are read here rather than trusted: a decoder for what `make-icons.mjs` writes is
 * a dozen lines, because it writes one filter and one colour type.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'web', 'icons');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const text = (p) => read(p).toString('utf8');

/* ───────────────────────────────────────────────────────────── a png reader ─── */

/** Every chunk type in the file, in order — including the ones we hope are absent. */
function chunks(buf) {
  const out = [];
  let at = 8; // past the signature
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    out.push({ type: buf.toString('latin1', at + 4, at + 8), at: at + 8, len });
    at += 12 + len;
  }
  return out;
}

/**
 * Decode to `{width, height, px(x, y) -> [r,g,b,a]}`.
 *
 * Only what this repo's encoder emits: 8-bit RGBA, no interlace, filter 0 on every
 * scanline. A file that is anything else fails the header assertions first.
 */
function decode(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png signature');
  const list = chunks(buf);
  const ihdr = list.find((c) => c.type === 'IHDR');
  const width = buf.readUInt32BE(ihdr.at);
  const height = buf.readUInt32BE(ihdr.at + 4);
  assert.equal(buf[ihdr.at + 8], 8, 'bit depth');
  assert.equal(buf[ihdr.at + 9], 6, 'colour type: truecolour with alpha');
  assert.equal(buf[ihdr.at + 12], 0, 'not interlaced');

  const idat = Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => buf.subarray(c.at, c.at + c.len)));
  const raw = zlib.inflateSync(idat);
  const stride = width * 4;
  for (let y = 0; y < height; y++) assert.equal(raw[y * (stride + 1)], 0, `scanline ${y} filter`);

  const px = (x, y) => {
    const at = y * (stride + 1) + 1 + x * 4;
    return [raw[at], raw[at + 1], raw[at + 2], raw[at + 3]];
  };
  return { width, height, px, types: list.map((c) => c.type) };
}

/* ─────────────────────────────────────────────────────────────── the files ─── */

test('every icon the generator lists is committed, at the size it claims', () => {
  for (const spec of FILES) {
    const file = path.join(ICONS, spec.file);
    assert.ok(fs.existsSync(file), `${spec.file} is missing — run npm run icons`);
    const { width, height } = decode(fs.readFileSync(file));
    assert.equal(width, spec.size, spec.file);
    assert.equal(height, spec.size, spec.file);
  }
});

test('no metadata rides along in any of them', () => {
  // "Strip metadata" was in the issue, and the encoder has no way to write any — this is
  // the check from the other end, which is the one that would catch a future rewrite that
  // reached for a library.
  for (const spec of FILES) {
    const { types } = decode(fs.readFileSync(path.join(ICONS, spec.file)));
    assert.deepEqual(new Set(types), new Set(['IHDR', 'IDAT', 'IEND']), spec.file);
  }
});

test('the committed SVGs are what the geometry draws', () => {
  // The one place the vector and the bitmaps could drift apart: both come from `GEOMETRY`,
  // and this is what says the checked-in file was not hand-edited afterwards.
  for (const name of ['mark', 'leads']) {
    assert.equal(text(`web/icons/${name}.svg`), svg(name), `${name}.svg is stale — run npm run icons`);
  }
});

test('an `any` icon has transparent corners and a maskable one does not', () => {
  // The whole difference between the two purposes. An `any` icon supplies its own rounded
  // tile, which is what makes it sit correctly in the Dock; a maskable one is full-bleed
  // because the platform crops it to a shape it does not announce in advance.
  const any = decode(read('web/icons/icon-512.png'));
  assert.equal(any.px(2, 2)[3], 0, 'the rounded tile leaves its corners empty');
  assert.equal(any.px(256, 256)[3], 255, 'and is opaque in the middle');

  const maskable = decode(read('web/icons/icon-maskable-512.png'));
  assert.equal(maskable.px(2, 2)[3], 255, 'a maskable icon fills its square');
  assert.equal(maskable.px(511, 511)[3], 255);
});

test('the maskable rows stay inside the safe zone', () => {
  // A maskable icon may be cropped to anything inside the middle 80%. The rows are the only
  // thing in it that must survive, so nothing but tile colour may appear in the outer ring.
  const { px } = decode(read('web/icons/icon-maskable-512.png'));
  const edge = Math.round(512 * 0.1);
  const isRow = ([r, g, b]) => r > 60 || g > 60 || b > 90; // the tile is #1e2030 → #101119
  for (let y = 0; y < 512; y += 4) {
    for (const x of [edge - 1, 512 - edge]) {
      assert.ok(!isRow(px(x, y)), `content at ${x},${y} is outside the safe zone`);
    }
  }
});

test('the Apple touch icons are opaque, because iOS does not honour transparency', () => {
  for (const file of ['apple-touch-icon.png', 'leads-apple-touch-icon.png']) {
    const { px, width } = decode(read(`web/icons/${file}`));
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, width - 1], [width - 1, width - 1], [width >> 1, width >> 1]]) {
      assert.equal(px(x, y)[3], 255, `${file} at ${x},${y}`);
    }
  }
});

test('the two variants are actually different pictures', () => {
  // They are two apps on one Home Screen. If the leads variant ever collapses back to the
  // panel's mark, the only thing telling them apart is a title nobody reads.
  assert.notEqual(read('web/icons/icon-512.png').toString('base64'), read('web/icons/leads-512.png').toString('base64'));
});

/* ─────────────────────────────────────────────────────────────── manifests ─── */

const manifests = {
  '/': JSON.parse(text('web/manifest.webmanifest')),
  '/m/': JSON.parse(text('web/m/manifest.webmanifest')),
};

test('each manifest names files that exist', () => {
  for (const [where, m] of Object.entries(manifests)) {
    assert.ok(m.icons.length, where);
    for (const icon of m.icons) {
      assert.ok(icon.src.startsWith('/'), `${where} ${icon.src} must be root-relative`);
      assert.ok(fs.existsSync(path.join(ROOT, 'web', icon.src)), `${where} names a missing ${icon.src}`);
    }
  }
});

test('each manifest offers a maskable icon and a 512', () => {
  for (const [where, m] of Object.entries(manifests)) {
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'), `${where} has no maskable icon`);
    assert.ok(m.icons.some((i) => i.sizes === '512x512'), `${where} has no 512`);
  }
});

test('the two apps do not share an id', () => {
  // Two manifests on one origin with the same `id` are one app to a browser: installing the
  // phone view would silently replace the panel. `start_url` alone does not settle it —
  // an omitted `id` defaults to `start_url`, which is why both spell it out.
  assert.equal(manifests['/'].id, '/');
  assert.equal(manifests['/m/'].id, '/m/');
  assert.notEqual(manifests['/'].id, manifests['/m/'].id);
  assert.notEqual(manifests['/'].short_name, manifests['/m/'].short_name);
});

test('each app installs as a window of its own, scoped to itself', () => {
  assert.equal(manifests['/'].display, 'standalone');
  assert.equal(manifests['/m/'].display, 'standalone');
  assert.equal(manifests['/m/'].scope, '/m/');
  assert.equal(manifests['/m/'].start_url, '/m/');
});

test('the manifest colours are the palette’s, not a second opinion', () => {
  // `tokens.css` is the one place a colour is defined. A manifest that drifted from it
  // would paint a splash screen and a title bar in a colour the page never uses, and
  // nothing on screen would say where it came from.
  const tokens = text('web/tokens.css');
  const dark = tokens.match(/:root\[data-theme="dark"\][^}]*?--ground:\s*(#[0-9a-f]{6})/i)[1];
  for (const [where, m] of Object.entries(manifests)) {
    assert.equal(m.theme_color.toLowerCase(), dark.toLowerCase(), where);
    assert.equal(m.background_color.toLowerCase(), dark.toLowerCase(), where);
  }
});

/* ────────────────────────────────────────────────────────────────── heads ─── */

const HEADS = [
  ['web/index.html', '/manifest.webmanifest'],
  ['web/m/index.html', '/m/manifest.webmanifest'],
];

test('each page links its own manifest, an icon and an Apple touch icon', () => {
  for (const [file, manifest] of HEADS) {
    const html = text(file);
    assert.match(html, new RegExp(`rel="manifest"\\s+href="${manifest}"`), file);
    assert.match(html, /rel="apple-touch-icon"/, file);
    // Every local asset the head names has to be on disk. A dead icon link is invisible:
    // the browser falls back to a default favicon and nobody notices for months.
    for (const [, href] of html.matchAll(/href="(\/[^"]+\.(?:png|svg|webmanifest))"/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'web', href)), `${file} names a missing ${href}`);
    }
  }
});

test('the desktop head’s theme-color pair is the two grounds', () => {
  const html = text('web/index.html');
  const tokens = text('web/tokens.css');
  const dark = tokens.match(/:root\[data-theme="dark"\][^}]*?--ground:\s*(#[0-9a-f]{6})/i)[1];
  const light = tokens.match(/^:root \{[^}]*?--ground:\s*(#[0-9a-f]{6})/im)[1];
  assert.match(html, new RegExp(`content="${dark}" media="\\(prefers-color-scheme: dark\\)"`, 'i'));
  assert.match(html, new RegExp(`content="${light}" media="\\(prefers-color-scheme: light\\)"`, 'i'));
});

test('the phone view is still not offered notifications', () => {
  // Its own half of the issue was the Home Screen icon. `Notification` needs a secure
  // context and a phone reaches this panel over plain http; a control that could not work
  // is one the panel does not draw.
  for (const file of fs.readdirSync(path.join(ROOT, 'web', 'm'))) {
    if (!file.endsWith('.js')) continue;
    assert.ok(!text(`web/m/${file}`).includes('Notification'), `web/m/${file}`);
  }
});
