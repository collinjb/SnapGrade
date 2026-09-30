/**
 * Generates the app icons as PNGs, with no image-library dependency.
 *
 *   node scripts/make-icons.mjs
 *
 * The output is committed, so this only needs re-running when the mark
 * changes. A tiny rasteriser plus zlib is all a flat-shape icon needs, and it
 * keeps the repo free of a build step just to produce four squares.
 *
 * The mark: a white page on the brand purple, with a green check over it.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'public', 'icons');

const PURPLE = [0x69, 0x38, 0xef];
const WHITE = [0xff, 0xff, 0xff];
const GREEN = [0x12, 0xb7, 0x6a];
const INK = [0xc7, 0xcc, 0xd6];

// ---------------------------------------------------------------------------
// A very small RGBA canvas
// ---------------------------------------------------------------------------

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  /** Alpha-blend one pixel. `a` is 0–1 coverage, which is how the shape
   *  helpers get their anti-aliasing. */
  blend(x, y, [r, g, b], a = 1) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const inv = 1 - a;
    this.data[i] = this.data[i] * inv + r * a;
    this.data[i + 1] = this.data[i + 1] * inv + g * a;
    this.data[i + 2] = this.data[i + 2] * inv + b * a;
    this.data[i + 3] = Math.min(255, this.data[i + 3] * inv + 255 * a);
  }

  /** Fill by sampling a coverage function 3x3 per pixel. Crude supersampling,
   *  but at icon sizes it is indistinguishable from anything smarter. */
  fill(color, coverage) {
    const S = 3;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let hits = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            if (coverage(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
          }
        }
        if (hits > 0) this.blend(x, y, color, hits / (S * S));
      }
    }
  }
}

const roundedRect = (x0, y0, x1, y1, r) => (px, py) => {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};

/** Coverage for a thick line segment with round caps. */
const segment = (ax, ay, bx, by, width) => {
  const half = width / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;
  return (px, py) => {
    const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return (px - qx) ** 2 + (py - qy) ** 2 <= half * half;
  };
};

const union =
  (...shapes) =>
  (px, py) =>
    shapes.some((s) => s(px, py));

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  // Each scanline is prefixed with its filter type; 0 (none) is plenty for
  // flat shapes and keeps this readable.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/**
 * @param size   pixel dimensions
 * @param inset  fraction of the canvas to leave empty around the mark.
 *               Maskable icons get a wide safe zone so a circular or
 *               squircle crop never clips the check.
 * @param square true for a full-bleed background (maskable), false for a
 *               rounded tile.
 */
function drawIcon(size, { inset = 0.12, square = false } = {}) {
  const c = new Canvas(size);
  const u = size / 100; // work in percentage units

  if (square) {
    c.fill(PURPLE, () => true);
  } else {
    c.fill(PURPLE, roundedRect(0, 0, size, size, 22 * u));
  }

  // The page, tilted slightly by drawing it inset and adding a lifted corner.
  const pad = size * inset;
  const pageW = size - pad * 2;
  const pageH = pageW * 1.18;
  const px0 = pad;
  const py0 = (size - pageH) / 2;
  c.fill(WHITE, roundedRect(px0, py0, px0 + pageW, py0 + pageH, 4 * u));

  // Two ruled lines, suggesting problems on the sheet.
  const lineW = 3.2 * u;
  const lx0 = px0 + pageW * 0.16;
  const lx1 = px0 + pageW * 0.66;
  c.fill(
    INK,
    union(
      segment(lx0, py0 + pageH * 0.26, lx1, py0 + pageH * 0.26, lineW),
      segment(lx0, py0 + pageH * 0.44, lx1 - pageW * 0.16, py0 + pageH * 0.44, lineW),
    ),
  );

  // The check, weighted toward the lower right so it reads as an overlay.
  const checkW = 9 * u;
  const cx = px0 + pageW * 0.52;
  const cy = py0 + pageH * 0.68;
  const s = pageW * 0.34;
  c.fill(
    GREEN,
    union(
      segment(cx - s * 0.52, cy, cx - s * 0.12, cy + s * 0.42, checkW),
      segment(cx - s * 0.12, cy + s * 0.42, cx + s * 0.62, cy - s * 0.46, checkW),
    ),
  );

  return c;
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, opts: { inset: 0.14 } },
  { file: 'icon-512.png', size: 512, opts: { inset: 0.14 } },
  // Maskable: full bleed, mark pulled well inside the safe zone.
  { file: 'icon-maskable-512.png', size: 512, opts: { inset: 0.24, square: true } },
  // iOS home screen. No transparency, no rounding — iOS applies its own.
  { file: 'apple-touch-icon.png', size: 180, opts: { inset: 0.14, square: true } },
  { file: 'favicon-64.png', size: 64, opts: { inset: 0.1 } },
];

for (const { file, size, opts } of targets) {
  writeFileSync(resolve(OUT, file), encodePng(drawIcon(size, opts)));
  console.log(`wrote public/icons/${file} (${size}x${size})`);
}
