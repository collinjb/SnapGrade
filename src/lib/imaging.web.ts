/** Capture post-processing for the web build.
 *
 *  Same contract and same targets as `imaging.ts` — 1600px long edge, JPEG
 *  q0.8 — but the whole pipeline is a canvas, so there is no
 *  expo-image-manipulator fallback to keep around. */
import { readBase64, resolveDisplayUri, saveJpegBytes } from './media';
import { renderPage } from './pageRender';
import type { Quad } from '@/types';

export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.8;

export interface ProcessedImage {
  uri: string;
  base64: string;
  width: number;
  height: number;
  perspectiveCorrected: boolean;
}

/** Stored pages are `sg://` URIs; a canvas needs a real loadable URL. */
async function loadableUri(uri: string): Promise<string> {
  return (await resolveDisplayUri(uri)) ?? uri;
}

export async function processCapture(
  sourceUri: string,
  sourceSize: { width: number; height: number },
  quad?: Quad | null,
): Promise<ProcessedImage> {
  const rendered = await renderPage(await loadableUri(sourceUri), {
    quad,
    maxLongEdge: MAX_LONG_EDGE,
    quality: Math.round(JPEG_QUALITY * 100),
    enhance: true,
  });

  if (!rendered.supported || !rendered.bytes) {
    throw new Error(`Could not process that page (${rendered.reason ?? 'unknown'}).`);
  }

  const uri = await saveJpegBytes(rendered.bytes, 'page');
  return {
    uri,
    base64: (await readBase64(uri)) ?? '',
    width: rendered.width ?? sourceSize.width,
    height: rendered.height ?? sourceSize.height,
    perspectiveCorrected: false,
  };
}

export async function processAnswerKey(
  sourceUri: string,
): Promise<{ uri: string; base64: string }> {
  const rendered = await renderPage(await loadableUri(sourceUri), {
    maxLongEdge: 1280,
    quality: 75,
    enhance: true,
  });

  if (!rendered.supported || !rendered.bytes) {
    throw new Error(`Could not process that answer key (${rendered.reason ?? 'unknown'}).`);
  }

  const uri = await saveJpegBytes(rendered.bytes, 'key');
  return { uri, base64: (await readBase64(uri)) ?? '' };
}

export function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}
