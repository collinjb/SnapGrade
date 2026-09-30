/** Binding to the native `detectDocument` frame-processor plugin.
 *
 *  The plugin ships with this repo as a local Expo module
 *  (modules/document-detector) and is autolinked into the dev build. When it
 *  is absent — Expo Go, or a dev build made before the module was added —
 *  `detectorMode` reports 'steady-only' and auto-capture falls back to
 *  hold-still detection driven by the device's gyroscope. */
import { VisionCameraProxy, type Frame } from 'react-native-vision-camera';
import type { Corners, NormalizedPoint } from '@/types';

export type { Corners, NormalizedPoint };

export interface Detection {
  corners: Corners;
  /** Detector's own 0–1 confidence that this really is a page. */
  confidence: number;
}

/** Flat shape the native plugin returns, so it crosses the JSI boundary
 *  cheaply: [x0,y0, x1,y1, x2,y2, x3,y3, confidence]. */
type RawDetection = number[] | null | undefined;

function initPlugin(): ReturnType<typeof VisionCameraProxy.initFrameProcessorPlugin> | null {
  try {
    return VisionCameraProxy.initFrameProcessorPlugin('detectDocument', {});
  } catch {
    return null;
  }
}

const plugin = initPlugin();

export const detectorMode: 'edges' | 'steady-only' = plugin ? 'edges' : 'steady-only';

/** Worklet. Runs on the frame-processor thread; returns null when the native
 *  plugin is unavailable or no page is visible in this frame. */
export function detectDocument(frame: Frame): Detection | null {
  'worklet';
  if (plugin == null) return null;
  const raw = plugin.call(frame) as unknown as RawDetection;
  if (raw == null || raw.length < 9) return null;
  return {
    corners: [
      { x: raw[0]!, y: raw[1]! },
      { x: raw[2]!, y: raw[3]! },
      { x: raw[4]!, y: raw[5]! },
      { x: raw[6]!, y: raw[7]! },
    ],
    confidence: raw[8]!,
  };
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
