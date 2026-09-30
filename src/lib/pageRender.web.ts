/** Page rendering for the web build.
 *
 *  The browser's 2D canvas can only do affine transforms, so there is no
 *  cheap equivalent of the Skia homography the native build uses: web crops
 *  to the detected page's bounding box and boosts contrast, which is the same
 *  trade-off Android makes. Everything else in the pipeline is unchanged.
 *
 *  Same module shape as `pageRender.ts` so `imaging.ts` does not care which
 *  one it got. */
import type { Quad } from '@/types';

export type { Quad };

/** True keystone correction needs Skia; the web build does not have it. */
export const skiaAvailable = (): boolean => false;

/** Contrast around mid-grey: pencil goes toward black, paper toward white. */
const CONTRAST = 1.3;

export interface RenderResult {
  supported: boolean;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  perspectiveCorrected: boolean;
  reason?: string;
}

function quadBounds(quad: Quad) {
  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

async function loadImage(uri: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.crossOrigin = 'anonymous';
    img.src = uri;
  });
}

/** `ctx.filter` is the fast path but Safari only got it in 15.4, so fall
 *  back to walking the pixels. A 1600px page is a few million operations —
 *  tens of milliseconds, and it happens off the capture path. */
function applyContrast(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const data = ctx.getImageData(0, 0, width, height);
  const px = data.data;
  const offset = 128 * (1 - CONTRAST);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = clamp8(px[i]! * CONTRAST + offset);
    px[i + 1] = clamp8(px[i + 1]! * CONTRAST + offset);
    px[i + 2] = clamp8(px[i + 2]! * CONTRAST + offset);
  }
  ctx.putImageData(data, 0, 0);
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

function supportsCanvasFilter(ctx: CanvasRenderingContext2D): boolean {
  return typeof (ctx as { filter?: unknown }).filter === 'string';
}

function canvasToBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      },
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Crop to the detected page, boost contrast, downscale, and encode JPEG.
 * `quad` is in source-image pixel coordinates; without it the whole frame is
 * used.
 */
export async function renderPage(
  imageUri: string,
  opts: { quad?: Quad | null; maxLongEdge?: number; quality?: number; enhance?: boolean } = {},
): Promise<RenderResult> {
  const { quad = null, maxLongEdge = 1600, quality = 92, enhance = true } = opts;

  if (typeof document === 'undefined') {
    return { supported: false, perspectiveCorrected: false, reason: 'no-dom' };
  }

  const image = await loadImage(imageUri);
  if (!image) return { supported: false, perspectiveCorrected: false, reason: 'decode-failed' };

  const srcW = image.naturalWidth;
  const srcH = image.naturalHeight;
  if (srcW === 0 || srcH === 0) {
    return { supported: false, perspectiveCorrected: false, reason: 'empty-image' };
  }

  // Source rectangle: the page's bounding box, clamped into the image.
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;

  if (quad) {
    const box = quadBounds(quad);
    const cx = Math.max(0, Math.floor(box.x));
    const cy = Math.max(0, Math.floor(box.y));
    const cw = Math.min(srcW - cx, Math.ceil(box.w));
    const ch = Math.min(srcH - cy, Math.ceil(box.h));
    if (cw > 32 && ch > 32) {
      sx = cx;
      sy = cy;
      sw = cw;
      sh = ch;
    }
  }

  let width = sw;
  let height = sh;
  const longEdge = Math.max(width, height);
  if (longEdge > maxLongEdge) {
    const scale = maxLongEdge / longEdge;
    width = Math.max(8, Math.round(width * scale));
    height = Math.max(8, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return { supported: false, perspectiveCorrected: false, reason: 'no-2d-context' };

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const useFilter = enhance && supportsCanvasFilter(ctx);
  if (useFilter) ctx.filter = `contrast(${Math.round(CONTRAST * 100)}%)`;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
  if (useFilter) ctx.filter = 'none';
  else if (enhance) applyContrast(ctx, width, height);

  const bytes = await canvasToBytes(canvas, quality / 100);
  if (!bytes) return { supported: false, perspectiveCorrected: false, reason: 'encode-failed' };

  return { supported: true, bytes, width, height, perspectiveCorrected: false };
}
