/** Capture post-processing: perspective-correct (or crop), boost legibility,
 *  downscale, and emit base64 JPEG for the grading call.
 *
 *  Target: max 1600px on the long edge at quality ~0.8. That keeps a typical
 *  worksheet under ~350 KB, which is the difference between a four-second and
 *  a twelve-second round trip on cell data. */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { readBase64, saveJpegBytes } from './media';
import { renderPage } from './pageRender';
import type { Quad } from '@/types';

export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.8;

export interface ProcessedImage {
  /** Stored URI of the processed page, kept for the results overlay. */
  uri: string;
  base64: string;
  width: number;
  height: number;
  /** True when a real four-corner warp was applied. */
  perspectiveCorrected: boolean;
}

/** Bounding box of a quad, clamped to the frame. Used when Skia is absent. */
function quadBounds(
  quad: Quad,
  width: number,
  height: number,
): { originX: number; originY: number; width: number; height: number } | null {
  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
  const originX = Math.max(0, Math.floor(Math.min(...xs)));
  const originY = Math.max(0, Math.floor(Math.min(...ys)));
  const w = Math.min(width - originX, Math.ceil(Math.max(...xs)) - originX);
  const h = Math.min(height - originY, Math.ceil(Math.max(...ys)) - originY);
  if (w < 32 || h < 32) return null;
  return { originX, originY, width: w, height: h };
}

/**
 * Normalize a captured photo for grading.
 *
 * `quad` (page corners in source-pixel coordinates) enables a true
 * perspective warp plus contrast boost via Skia — one encode, at the final
 * quality, so the page is never compressed twice. Without Skia we fall back
 * to expo-image-manipulator and the quad's bounding box, which is still a
 * large win over the raw frame.
 */
export async function processCapture(
  sourceUri: string,
  sourceSize: { width: number; height: number },
  quad?: Quad | null,
): Promise<ProcessedImage> {
  const rendered = await renderPage(sourceUri, {
    quad,
    maxLongEdge: MAX_LONG_EDGE,
    quality: Math.round(JPEG_QUALITY * 100),
    enhance: true,
  });

  if (rendered.supported && rendered.bytes) {
    const uri = await saveJpegBytes(rendered.bytes, 'page');
    return {
      uri,
      base64: (await readBase64(uri)) ?? '',
      width: rendered.width ?? sourceSize.width,
      height: rendered.height ?? sourceSize.height,
      perspectiveCorrected: rendered.perspectiveCorrected,
    };
  }

  // --- Fallback: crop and resize without Skia -----------------------------
  let width = sourceSize.width;
  let height = sourceSize.height;
  const context = ImageManipulator.manipulate(sourceUri);

  if (quad) {
    const box = quadBounds(quad, width, height);
    if (box) {
      context.crop(box);
      width = box.width;
      height = box.height;
    }
  }

  const longEdge = Math.max(width, height);
  if (longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    context.resize({ width, height });
  }

  const ref = await context.renderAsync();
  const saved = await ref.saveAsync({
    compress: JPEG_QUALITY,
    format: SaveFormat.JPEG,
    base64: true,
  });

  return {
    uri: saved.uri,
    base64: saved.base64 ?? '',
    width: saved.width || width,
    height: saved.height || height,
    perspectiveCorrected: false,
  };
}

/** Shrink an answer-key photo harder than a student page: we only need the
 *  final answers off it, not every stroke of work. */
export async function processAnswerKey(
  sourceUri: string,
): Promise<{ uri: string; base64: string }> {
  const rendered = await renderPage(sourceUri, {
    maxLongEdge: 1280,
    quality: 75,
    enhance: true,
  });

  if (rendered.supported && rendered.bytes) {
    const uri = await saveJpegBytes(rendered.bytes, 'key');
    return { uri, base64: (await readBase64(uri)) ?? '' };
  }

  const context = ImageManipulator.manipulate(sourceUri);
  context.resize({ width: 1280 });
  const ref = await context.renderAsync();
  const saved = await ref.saveAsync({
    compress: 0.75,
    format: SaveFormat.JPEG,
    base64: true,
  });
  return { uri: saved.uri, base64: saved.base64 ?? '' };
}

/** Approximate decoded size of a base64 payload, for the request size guard. */
export function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}
