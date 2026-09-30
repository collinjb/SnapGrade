/** There is no VisionCamera frame-processor plugin in a browser.
 *
 *  The web build detects the page in `CameraView.web.tsx` instead, by
 *  sampling video frames onto a small canvas and running the same algorithm
 *  through `pageDetect.ts`. This module exists only so shared imports
 *  resolve; nothing here is called on web. */
import type { Corners, NormalizedPoint } from '@/types';

export type { Corners, NormalizedPoint };

export interface Detection {
  corners: Corners;
  confidence: number;
}

/** Web detection is real, it just does not come through a native plugin. */
export const detectorMode: 'edges' | 'steady-only' = 'edges';

export function detectDocument(): Detection | null {
  return null;
}

/** Scale normalized corners up to the pixel coordinates of a captured photo. */
export function cornersToPixels(
  corners: Corners,
  width: number,
  height: number,
): {
  topLeft: NormalizedPoint;
  topRight: NormalizedPoint;
  bottomRight: NormalizedPoint;
  bottomLeft: NormalizedPoint;
} {
  const s = (p: NormalizedPoint) => ({ x: p.x * width, y: p.y * height });
  return {
    topLeft: s(corners[0]),
    topRight: s(corners[1]),
    bottomRight: s(corners[2]),
    bottomLeft: s(corners[3]),
  };
}
