/** Skia-backed page rendering: perspective ("keystone") correction for a
 *  detected page quad, plus a contrast boost that makes pencil on white paper
 *  far easier for the model to read.
 *
 *  Skia matrices are full 3x3 homographies, so a four-corner warp is just a
 *  canvas transform: solve the homography that maps the detected source quad
 *  onto an axis-aligned rectangle, draw the image through it, snapshot.
 *
 *  Skia is treated as optional — if the native module is unavailable the
 *  caller falls back to a plain bounding-box crop with no contrast pass. */

import type { NormalizedPoint, Quad } from '@/types';

/** Page corners here are in source-image *pixel* coordinates, not normalized. */
export type { Quad };
type Point = NormalizedPoint;

type SkiaModule = typeof import('@shopify/react-native-skia');

let cached: SkiaModule | null | undefined;

function loadSkia(): SkiaModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = require('@shopify/react-native-skia') as SkiaModule;
  } catch {
    cached = null;
  }
  return cached;
}

export const skiaAvailable = (): boolean => loadSkia() !== null;

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Output size that roughly preserves the page's true aspect ratio: the longer
 *  of each opposing edge pair. */
export function quadOutputSize(q: Quad): { width: number; height: number } {
  return {
    width: Math.round(Math.max(dist(q.topLeft, q.topRight), dist(q.bottomLeft, q.bottomRight))),
    height: Math.round(Math.max(dist(q.topLeft, q.bottomLeft), dist(q.topRight, q.bottomRight))),
  };
}

/**
 * Solve the homography H mapping four source points to four destination
 * points, returned row-major with h22 fixed at 1.
 *
 * Each correspondence contributes two rows to an 8x8 linear system, solved
 * here by Gauss-Jordan elimination with partial pivoting.
 */
export function solveHomography(src: Point[], dst: Point[]): number[] | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    a.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x]);
    b.push(d.x);
    a.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y]);
    b.push(d.y);
  }

  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-9) return null; // degenerate quad
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    [b[col], b[pivot]] = [b[pivot]!, b[col]!];

    const pv = a[col]![col]!;
    for (let c = col; c < n; c++) a[col]![c] = a[col]![c]! / pv;
    b[col] = b[col]! / pv;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r]![c] = a[r]![c]! - f * a[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }

  return [b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!, b[6]!, b[7]!, 1];
}

/** Contrast around mid-grey with a touch of desaturation. Pencil grey gets
 *  pushed toward black and paper toward white without clipping ink strokes. */
const CONTRAST = 1.3;
const OFFSET = (1 - CONTRAST) / 2;
const ENHANCE_MATRIX = [
  CONTRAST, 0, 0, 0, OFFSET,
  0, CONTRAST, 0, 0, OFFSET,
  0, 0, CONTRAST, 0, OFFSET,
  0, 0, 0, 1, 0,
];

export interface RenderResult {
  supported: boolean;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  perspectiveCorrected: boolean;
  reason?: string;
}

/**
 * Render a captured page through Skia.
 *
 * With `quad`, the page is perspective-corrected onto a rectangle; without it
 * the full frame is redrawn. `enhance` applies the contrast boost.
 * Returns encoded JPEG bytes, or `supported: false` when Skia is missing.
 */
export async function renderPage(
  imageUri: string,
  opts: { quad?: Quad | null; maxLongEdge?: number; quality?: number; enhance?: boolean } = {},
): Promise<RenderResult> {
  const RNSkia = loadSkia();
  if (!RNSkia) return { supported: false, perspectiveCorrected: false, reason: 'skia-unavailable' };
  const { Skia, FilterMode, MipmapMode, ImageFormat } = RNSkia;

  const { quad = null, maxLongEdge = 1600, quality = 92, enhance = true } = opts;

  try {
    const data = await Skia.Data.fromURI(imageUri);
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return { supported: false, perspectiveCorrected: false, reason: 'decode-failed' };

    const srcW = image.width();
    const srcH = image.height();

    let width: number;
    let height: number;
    let homography: number[] | null = null;

    if (quad) {
      const size = quadOutputSize(quad);
      if (size.width < 8 || size.height < 8) {
        image.dispose?.();
        return { supported: false, perspectiveCorrected: false, reason: 'quad-too-small' };
      }
      ({ width, height } = size);
    } else {
      width = srcW;
      height = srcH;
    }

    const longEdge = Math.max(width, height);
    if (longEdge > maxLongEdge) {
      const scale = maxLongEdge / longEdge;
      width = Math.max(8, Math.round(width * scale));
      height = Math.max(8, Math.round(height * scale));
    }

    if (quad) {
      homography = solveHomography(
        [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft],
        [
          { x: 0, y: 0 },
          { x: width, y: 0 },
          { x: width, y: height },
          { x: 0, y: height },
        ],
      );
      if (!homography) {
        image.dispose?.();
        return { supported: false, perspectiveCorrected: false, reason: 'degenerate-quad' };
      }
    }

    const surface = Skia.Surface.MakeOffscreen(width, height);
    if (!surface) {
      image.dispose?.();
      return { supported: false, perspectiveCorrected: false, reason: 'surface-failed' };
    }

    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('white'));

    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    if (enhance) paint.setColorFilter(Skia.ColorFilter.MakeMatrix(ENHANCE_MATRIX));

    canvas.save();
    if (homography) {
      // An SkMatrix is a full 3x3 homography, so the nine row-major values go
      // straight in — no decomposition into affine pieces needed.
      canvas.concat(Skia.Matrix(homography as unknown as Parameters<typeof Skia.Matrix>[0]));
      canvas.drawImageOptions(image, 0, 0, FilterMode.Linear, MipmapMode.Linear, paint);
    } else {
      canvas.drawImageRectOptions(
        image,
        Skia.XYWHRect(0, 0, srcW, srcH),
        Skia.XYWHRect(0, 0, width, height),
        FilterMode.Linear,
        MipmapMode.Linear,
        paint,
      );
    }
    canvas.restore();

    const snapshot = surface.makeImageSnapshot();
    const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, quality);

    image.dispose?.();
    snapshot.dispose?.();

    return {
      supported: true,
      bytes,
      width,
      height,
      perspectiveCorrected: Boolean(homography),
    };
  } catch (e) {
    return {
      supported: false,
      perspectiveCorrected: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
