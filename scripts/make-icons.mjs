#!/usr/bin/env node
/**
 * The app mark, drawn once and written out as both an SVG and every PNG size the
 * manifests ask for.
 *
 * Why a rasterizer rather than `sips`: this Mac has `sips` and `qlmanage` and nothing
 * else — no `rsvg-convert`, no ImageMagick, no PIL, no cairosvg — and `sips` cannot read
 * SVG at all. The remaining options were Quick Look (which renders through WebKit and
 * whose output is a thumbnail, sized and padded to its own taste) or headless Chrome
 * (which would make regenerating an icon depend on a browser). Neither is worth it for a
 * mark that is four rounded rectangles, so the shapes are rasterized here in about a
 * hundred lines of arithmetic and encoded as PNG with `node:zlib`. `npm run icons` needs
 * nothing but node, which is also what makes it honest to check the output into the repo.
 *
 * **One set of numbers, two outputs.** `GEOMETRY` below is the only description of the
 * mark. The SVG is written from it and the PNGs are rasterized from it, so the vector and
 * the bitmaps cannot drift into disagreeing about what the icon is — the same reasoning
 * `imageBlocks` carries in `normalize.js` for the two ends of an image ordinal, and
 * `isLeadName` for the two readers of a session name. Change a number here and
 * `npm run icons` moves every file at once.
 *
 * Metadata is stripped by construction: the encoder writes IHDR, IDAT and IEND and has no
 * way to write anything else. `test/icons.test.js` checks that from the other end.
 *
 * Usage: `npm run icons` (or `node scripts/make-icons.mjs`). Writes `web/icons/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

/* ─────────────────────────────────────────────────────────────── the mark ─── */

/**
 * The panel in one glyph: a rail of rows, the top one wanting something.
 *
 * Colours are the dark theme's own tokens (`web/tokens.css`) — `--accent-soft` to
 * `--ground` for the tile, `--decision` for the row that needs you, `--accent` for the
 * rest. Dark is the only theme this has to read in (the maintainer's ruling of
 * 2026-08-27), and a dark tile is also what the issue asks for so the icon holds its own
 * in the Dock and on a Home Screen.
 *
 * The phone's variant says what the phone view is instead: a list of leads, with their
 * workers indented under them. Same tile, different rows, so the two installed apps are
 * telling apart at a glance on a Home Screen rather than by their titles.
 *
 * All coordinates are in a 512-unit square and scaled to whatever size is asked for.
 */
const SIZE = 512;

const TILE = {
  radius: 114, // ≈22.3% — the corner iOS and macOS both round icons to
  top: '#1e2030', // --accent-soft, dark
  bottom: '#101119', // a shade under --ground, so the tile has a little depth
};

const GEOMETRY = {
  /** The desktop panel: three rows, the top one in the colour of a session that needs you. */
  mark: [
    { x: 112, y: 136, w: 288, h: 56, fill: '#e8746e', alpha: 1 }, // --decision
    { x: 112, y: 228, w: 232, h: 56, fill: '#8d95f2', alpha: 1 }, // --accent
    { x: 112, y: 320, w: 184, h: 56, fill: '#8d95f2', alpha: 0.45 },
  ],
  /** The phone view: one lead, two workers nested under it. */
  leads: [
    { x: 112, y: 136, w: 288, h: 56, fill: '#8d95f2', alpha: 1 },
    { x: 168, y: 228, w: 208, h: 56, fill: '#8d95f2', alpha: 0.5 },
    { x: 168, y: 320, w: 168, h: 56, fill: '#8d95f2', alpha: 0.5 },
  ],
};

/**
 * How much of the tile a maskable icon's content may use.
 *
 * A maskable icon is cropped by the platform to a shape it does not tell you in advance —
 * anything outside the middle 80% can be cut off — so that variant is drawn full-bleed
 * (square, no rounded corners, since the platform supplies the corners) with the rows
 * scaled in about the centre. 0.72 keeps the whole block inside the safe circle with room
 * to spare; `any` icons keep their own rounded corners and are not scaled.
 */
const MASKABLE_SCALE = 0.72;

/* ───────────────────────────────────────────────────────────────── shapes ─── */

/** Is (px, py) inside a rounded rectangle? The only shape test the mark needs. */
function inRoundRect(px, py, { x, y, w, h, r }) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const rr = Math.min(r, w / 2, h / 2);
  if (rr <= 0) return true;
  // Inside the cross formed by the two inset rectangles, or inside one of the four corner
  // discs. Anything else is a corner that has been cut away.
  const cx = Math.min(Math.max(px, x + rr), x + w - rr);
  const cy = Math.min(Math.max(py, y + rr), y + h - rr);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rr * rr;
}

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

/** Scale a row about the centre of the tile — the maskable variant's only transform. */
const scaleRow = (row, k) => ({
  ...row,
  x: SIZE / 2 + (row.x - SIZE / 2) * k,
  y: SIZE / 2 + (row.y - SIZE / 2) * k,
  w: row.w * k,
  h: row.h * k,
});

/**
 * The layers of one icon, back to front, in 512-unit coordinates.
 *
 * @param {'mark'|'leads'} variant which glyph
 * @param {boolean} maskable full-bleed square with the rows pulled in, rather than a
 *   rounded tile at full size
 */
function layers(variant, maskable) {
  const rows = GEOMETRY[variant].map((row) => (maskable ? scaleRow(row, MASKABLE_SCALE) : row));
  return {
    tile: { x: 0, y: 0, w: SIZE, h: SIZE, r: maskable ? 0 : TILE.radius },
    rows: rows.map((row) => ({ ...row, r: row.h / 2 })),
  };
}

/* ────────────────────────────────────────────────────────────────── raster ─── */

/**
 * Render one icon to straight-alpha RGBA bytes.
 *
 * Supersampled 4×4 per pixel and averaged in *premultiplied* space, which is the part that
 * matters: averaging straight alpha darkens or lightens every antialiased edge, and every
 * edge in this mark is a curve. 16 samples is plenty for four rounded rectangles and keeps
 * a 512² render well under a second.
 */
function render(variant, size, maskable) {
  const { tile, rows } = layers(variant, maskable);
  const [topR, topG, topB] = hex(TILE.top);
  const [botR, botG, botB] = hex(TILE.bottom);
  const rowColours = rows.map((row) => hex(row.fill));

  const SS = 4;
  const step = SIZE / size / SS;
  const half = step / 2;
  const out = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (px * SS + sx) * step + half;
          const uy = (py * SS + sy) * step + half;

          if (!inRoundRect(ux, uy, tile)) continue; // outside the tile: transparent

          // The tile's vertical gradient, then each row composited over it in turn.
          const t = uy / SIZE;
          let r = topR + (botR - topR) * t;
          let g = topG + (botG - topG) * t;
          let b = topB + (botB - topB) * t;

          for (const [i, row] of rows.entries()) {
            if (!inRoundRect(ux, uy, row)) continue;
            const [rr, rg, rb] = rowColours[i];
            const a = row.alpha;
            r += (rr - r) * a;
            g += (rg - g) * a;
            b += (rb - b) * a;
          }

          ar += r;
          ag += g;
          ab += b;
          aa += 1;
        }
      }

      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (aa === 0) continue; // stays 0,0,0,0
      // Premultiplied average back to straight alpha: the accumulated colour is already
      // weighted by coverage, so dividing by the covered sample count (not by n) is what
      // recovers the edge pixel's true colour.
      out[i] = Math.round(ar / aa);
      out[i + 1] = Math.round(ag / aa);
      out[i + 2] = Math.round(ab / aa);
      out[i + 3] = Math.round((aa / n) * 255);
    }
  }
  return out;
}

/**
 * Flatten onto the tile's own bottom colour.
 *
 * iOS does not honour transparency in an `apple-touch-icon` — it composites onto whatever
 * it likes, historically black or white, and a mark with rounded transparent corners comes
 * back with the corners filled in a colour nobody chose. So the touch icon is an opaque
 * square and iOS supplies the rounding itself.
 */
function flatten(rgba) {
  const [br, bg, bb] = hex(TILE.bottom);
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255;
    out[i] = Math.round(out[i] * a + br * (1 - a));
    out[i + 1] = Math.round(out[i + 1] * a + bg * (1 - a));
    out[i + 2] = Math.round(out[i + 2] * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────── png ─── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA, no interlacing, filter 0 on every scanline. Nothing ancillary is written. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────────────────────────────────────────────────── svg ─── */

export function svg(variant) {
  const { tile, rows } = layers(variant, false);
  const bars = rows
    .map(
      (row) =>
        `  <rect x="${row.x}" y="${row.y}" width="${row.w}" height="${row.h}" rx="${row.r}" ` +
        `fill="${row.fill}"${row.alpha < 1 ? ` opacity="${row.alpha}"` : ''}/>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Foreman">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TILE.top}"/>
      <stop offset="1" stop-color="${TILE.bottom}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${tile.r}" fill="url(#tile)"/>
${bars}
</svg>
`;
}

/* ──────────────────────────────────────────────────────────────────── write ─── */

/**
 * Every file the two manifests and the two `<head>`s reference.
 *
 * `apple` means opaque and unrounded — see `flatten`. `maskable` means full-bleed with the
 * rows pulled into the safe zone. Everything else is the rounded tile with transparent
 * corners, which is what makes it sit correctly in the Dock.
 */
export const FILES = [
  { file: 'icon-32.png', variant: 'mark', size: 32 },
  { file: 'icon-192.png', variant: 'mark', size: 192 },
  { file: 'icon-512.png', variant: 'mark', size: 512 },
  { file: 'icon-maskable-512.png', variant: 'mark', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', variant: 'mark', size: 180, apple: true },
  { file: 'leads-192.png', variant: 'leads', size: 192 },
  { file: 'leads-512.png', variant: 'leads', size: 512 },
  { file: 'leads-maskable-512.png', variant: 'leads', size: 512, maskable: true },
  { file: 'leads-apple-touch-icon.png', variant: 'leads', size: 180, apple: true },
];

export function build() {
  fs.mkdirSync(OUT, { recursive: true });
  const written = [];

  for (const name of ['mark', 'leads']) {
    const file = `${name}.svg`;
    fs.writeFileSync(path.join(OUT, file), svg(name));
    written.push(file);
  }

  for (const spec of FILES) {
    let rgba = render(spec.variant, spec.size, Boolean(spec.maskable));
    if (spec.apple) rgba = flatten(rgba);
    fs.writeFileSync(path.join(OUT, spec.file), encodePng(rgba, spec.size));
    written.push(spec.file);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const file of build()) {
    const { size } = fs.statSync(path.join(OUT, file));
    console.log(`  web/icons/${file}  ${(size / 1024).toFixed(1)} KB`);
  }
}
