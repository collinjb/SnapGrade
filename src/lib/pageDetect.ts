/** Finding the page in a downsampled luma image.
 *
 *  This is the TypeScript twin of the Android detector in
 *  `modules/document-detector/.../DocumentDetectorPlugin.kt` — same algorithm,
 *  same constants — and it is what drives auto-capture in the web build,
 *  where there is no frame-processor plugin to call. Keep the two in step.
 *
 *  iOS uses Vision's rectangle detector instead, which returns four true
 *  corners; this one returns an axis-aligned box, so it supports auto-capture
 *  and cropping but not a real keystone correction.
 *
 *  Pure and dependency-free, so the thresholds can be tested directly. */
import type { Corners } from '@/types';

/** Coarse grid the luma plane is sampled onto. */
export const GRID_W = 96;
export const GRID_H = 96;

/** A row or column counts as "page" once this fraction of it is bright.
 *
 *  This also sets the smallest page the detector can see at all: the box has
 *  to clear the threshold on both axes, so the floor is FILL_THRESHOLD^2 of
 *  the frame. Keep it below `autoCapture`'s MIN_AREA (0.22) — otherwise a
 *  page held too far away is invisible here and the user gets "Point at a
 *  test" instead of the "Move closer" hint that would actually help. */
const FILL_THRESHOLD = 0.35;

/** Below this share of the frame it is not the worksheet we want. */
const MIN_AREA = 0.14;

/** Letter, A4 and legal all sit inside this range in either orientation. */
const MIN_ASPECT = 0.45;
const MAX_ASPECT = 2.4;

/** Below this the detection is not worth reporting at all. */
const MIN_CONFIDENCE = 0.35;

export interface LumaDetection {
  corners: Corners;
  confidence: number;
}

/**
 * Otsu's method: pick the intensity that maximises between-class variance.
 * It adapts to room lighting without any exposed knob.
 *
 * A page against a dark desk gives a histogram with two tight spikes and a
 * dead flat valley between them, so every threshold in that valley scores
 * identically. Taking the first one would sit the threshold right on the
 * background peak and classify the whole frame as page, so we track the
 * whole maximal plateau and cut down its middle.
 */
export function otsuThreshold(histogram: ArrayLike<number>, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;

  let sumBackground = 0;
  let weightBackground = 0;
  let best = -1;
  let plateauStart = 127;
  let plateauEnd = 127;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (between > best) {
      best = between;
      plateauStart = t;
      plateauEnd = t;
    } else if (between === best) {
      plateauEnd = t;
    }
  }

  const threshold = Math.round((plateauStart + plateauEnd) / 2);

  // Bias slightly toward the page: pencil strokes sit just below the paper's
  // brightness and should not carve holes out of the mask.
  return Math.max(0, Math.min(250, threshold - 6));
}

/** Index of the first (or last) entry at or above `limit`, else -1. */
function firstAbove(profile: Int32Array, limit: number, forward: boolean): number {
  if (forward) {
    for (let i = 0; i < profile.length; i++) if (profile[i]! >= limit) return i;
  } else {
    for (let i = profile.length - 1; i >= 0; i--) if (profile[i]! >= limit) return i;
  }
  return -1;
}

/**
 * Locate the page in a `GRID_W x GRID_H` luma buffer (row-major, 0–255).
 *
 * Returns corners normalized 0–1 with the origin at the top-left, clockwise
 * from top-left, or null when nothing in the frame looks like a sheet.
 */
export function detectPageInLuma(
  luma: ArrayLike<number>,
  width = GRID_W,
  height = GRID_H,
): LumaDetection | null {
  const total = width * height;
  if (luma.length < total) return null;

  // --- Histogram + Otsu ---------------------------------------------------
  const histogram = new Int32Array(256);
  for (let i = 0; i < total; i++) histogram[luma[i]! & 0xff]!++;
  const threshold = otsuThreshold(histogram, total);

  // --- Row and column occupancy ------------------------------------------
  const rowFill = new Int32Array(height);
  const colFill = new Int32Array(width);
  let brightCount = 0;

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      if (luma[rowBase + x]! > threshold) {
        rowFill[y]!++;
        colFill[x]!++;
        brightCount++;
      }
    }
  }

  // A frame that is almost all bright (pointed at a lit ceiling) or almost
  // all dark (lens covered) has no page in it.
  const brightFraction = brightCount / total;
  if (brightFraction < MIN_AREA || brightFraction > 0.985) return null;

  // --- Trim in from each edge --------------------------------------------
  const top = firstAbove(rowFill, width * FILL_THRESHOLD, true);
  const bottom = firstAbove(rowFill, width * FILL_THRESHOLD, false);
  const left = firstAbove(colFill, height * FILL_THRESHOLD, true);
  const right = firstAbove(colFill, height * FILL_THRESHOLD, false);

  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  if (bottom <= top || right <= left) return null;

  const x0 = left / width;
  const x1 = (right + 1) / width;
  const y0 = top / height;
  const y1 = (bottom + 1) / height;

  const w = x1 - x0;
  const h = y1 - y0;
  if (w * h < MIN_AREA) return null;

  const aspect = w / h;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return null;

  // --- Confidence ---------------------------------------------------------
  // How solidly the detected box is actually filled: a real page is
  // near-uniform, a scattering of bright objects is not.
  let insideBright = 0;
  let insideTotal = 0;
  for (let y = top; y <= bottom; y++) {
    const rowBase = y * width;
    for (let x = left; x <= right; x++) {
      insideTotal++;
      if (luma[rowBase + x]! > threshold) insideBright++;
    }
  }
  const solidity = insideTotal === 0 ? 0 : insideBright / insideTotal;

  // Contrast against the surroundings: a page lying on a white desk is
  // genuinely ambiguous and should not read as certain.
  const outsideTotal = total - insideTotal;
  const outsideBright = brightCount - insideBright;
  const outsideRatio = outsideTotal === 0 ? 1 : outsideBright / outsideTotal;
  const separation = Math.max(0, Math.min(1, solidity - outsideRatio));

  const confidence = Math.max(0, Math.min(1, solidity * 0.55 + separation * 0.45));
  if (confidence < MIN_CONFIDENCE) return null;

  return {
    corners: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    confidence,
  };
}

/**
 * Convert RGBA pixel data (as `CanvasRenderingContext2D.getImageData` gives
 * it) into the luma buffer `detectPageInLuma` expects. Rec. 601 weights,
 * integer maths — this runs on every sampled frame.
 */
export function rgbaToLuma(rgba: ArrayLike<number>, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    out[i] = (rgba[o]! * 77 + rgba[o + 1]! * 150 + rgba[o + 2]! * 29) >> 8;
  }
  return out;
}
