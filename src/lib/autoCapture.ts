/** Decides *when* a frame is worth capturing.
 *
 *  Auto-capture fires once the page has been framed, flat and still for
 *  STEADY_MS. "Still" is measured as corner drift between consecutive
 *  detections; "flat" is a squareness check on the quad's opposing edges.
 *
 *  This module is deliberately pure — no React, no native calls — so the rule
 *  set stays readable and can be reasoned about directly. */
import type { Corners } from '@/types';

/** Hold-still window before an automatic capture. */
export const STEADY_MS = 700;

/** A page must fill at least this much of the frame — stops us grabbing a
 *  distant page on a desk — and at most this much, so its edges stay visible. */
const MIN_AREA = 0.22;
const MAX_AREA = 0.97;

/** Max corner drift between samples, as a fraction of the frame diagonal. */
const MAX_DRIFT = 0.018;

/** Opposing edges of a page seen near-flat differ by less than this ratio. */
const MAX_EDGE_SKEW = 0.28;

/** Detector confidence below this is treated as "no page". */
const MIN_CONFIDENCE = 0.45;

/** After a capture, the page has to actually change before we will fire
 *  again: either leave the frame, or move by more than this fraction of it.
 *  Without this, batch scanning re-grades the same sheet every cooldown. */
const REARM_DRIFT = 0.1;

/** Angular speed (rad/s) above which the hand counts as moving. */
const STEADY_HAND_RAD_S = 0.35;

export type Readiness =
  | 'searching' // no page detected
  | 'swap-page' // just captured this one; waiting for the next sheet
  | 'too-far' // page found but small in frame
  | 'too-close' // page overflows the frame
  | 'skewed' // page is tilted or folded
  | 'hold-still' // framed, waiting out the steady window
  | 'ready'; // steady long enough — capture now

export interface Sample {
  corners: Corners;
  confidence: number;
  /** ms timestamp. */
  t: number;
}

export interface Evaluation {
  readiness: Readiness;
  /** 0–1 progress through the steady window, for the ring animation. */
  progress: number;
  shouldCapture: boolean;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Shoelace area of the quad as a fraction of the frame. Corners are already
 *  normalized, so the result is directly a 0–1 coverage figure. */
export function quadAreaFraction(corners: Corners): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** Ratio of the shorter to the longer of two lengths, 0–1. */
const evenness = (a: number, b: number): number => {
  const hi = Math.max(a, b);
  return hi === 0 ? 0 : Math.min(a, b) / hi;
};

/** How far the quad departs from a flat rectangle: 0 is perfectly flat. */
export function skew(corners: Corners): number {
  const [tl, tr, br, bl] = corners;
  return Math.max(
    1 - evenness(dist(tl, tr), dist(bl, br)),
    1 - evenness(dist(tl, bl), dist(tr, br)),
  );
}

/** Largest corner-to-corner movement between two detections. */
export function drift(a: Corners, b: Corners): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, dist(a[i]!, b[i]!));
  return worst;
}

export class StabilityTracker {
  private steadySince: number | null = null;
  private last: Sample | null = null;
  private firedAt = 0;
  /** The page we just captured. While set, we are waiting for it to go. */
  private captured: Corners | null = null;

  /** Ignore detections for this long after a capture, so one page does not
   *  trigger a burst while the shutter animation plays. */
  constructor(private readonly cooldownMs = 1500) {}

  reset(): void {
    this.steadySince = null;
    this.last = null;
  }

  /** Clear everything, including the wait for the next sheet. */
  resetAll(): void {
    this.reset();
    this.captured = null;
  }

  /** Call after a capture to start the cooldown and disarm until the page
   *  is swapped. `corners` is the page that was just taken. */
  markCaptured(now: number = Date.now(), corners: Corners | null = null): void {
    this.firedAt = now;
    this.captured = corners;
    this.reset();
  }

  /**
   * Feed one detection (or `null` when the detector sees no page) plus the
   * device's current angular speed in rad/s, and get back what the UI should
   * show and whether to fire the shutter.
   */
  push(sample: Sample | null, angularSpeed = 0): Evaluation {
    const now = sample?.t ?? Date.now();

    if (now - this.firedAt < this.cooldownMs) {
      return { readiness: 'searching', progress: 0, shouldCapture: false };
    }

    if (!sample || sample.confidence < MIN_CONFIDENCE) {
      // The page left the frame, which is exactly the signal we need to arm
      // again for the next sheet.
      this.captured = null;
      this.reset();
      return { readiness: 'searching', progress: 0, shouldCapture: false };
    }

    if (this.captured) {
      if (drift(this.captured, sample.corners) < REARM_DRIFT) {
        this.reset();
        return { readiness: 'swap-page', progress: 0, shouldCapture: false };
      }
      // A different sheet, or the same one moved: arm again.
      this.captured = null;
    }

    const area = quadAreaFraction(sample.corners);
    if (area < MIN_AREA) {
      this.reset();
      this.last = sample;
      return { readiness: 'too-far', progress: 0, shouldCapture: false };
    }
    if (area > MAX_AREA) {
      this.reset();
      this.last = sample;
      return { readiness: 'too-close', progress: 0, shouldCapture: false };
    }
    if (skew(sample.corners) > MAX_EDGE_SKEW) {
      this.reset();
      this.last = sample;
      return { readiness: 'skewed', progress: 0, shouldCapture: false };
    }

    // Hand shake shows up in the gyro well before the corners move enough to
    // notice, so it is a cheap early-out that keeps blurry frames out.
    const handIsSteady = angularSpeed < STEADY_HAND_RAD_S;
    const moved = this.last ? drift(this.last.corners, sample.corners) : Infinity;
    this.last = sample;

    if (!handIsSteady || moved > MAX_DRIFT) {
      this.steadySince = null;
      return { readiness: 'hold-still', progress: 0, shouldCapture: false };
    }

    this.steadySince ??= now;
    const progress = Math.min(1, (now - this.steadySince) / STEADY_MS);

    if (progress >= 1) {
      this.markCaptured(now, sample.corners);
      return { readiness: 'ready', progress: 1, shouldCapture: true };
    }
    return { readiness: 'hold-still', progress, shouldCapture: false };
  }
}

/**
 * Steady-only fallback for builds without the native edge detector: capture
 * once the device has been essentially motionless for the steady window.
 * Requires an explicit arm (the user having pointed at a page) so it cannot
 * fire while the phone is sitting on a table.
 */
export class MotionOnlyTracker {
  private steadySince: number | null = null;
  private firedAt = 0;

  constructor(private readonly cooldownMs = 2000) {}

  reset(): void {
    this.steadySince = null;
  }

  markCaptured(now: number = Date.now()): void {
    this.firedAt = now;
    this.reset();
  }

  push(angularSpeed: number, armed: boolean, now: number = Date.now()): Evaluation {
    if (!armed || now - this.firedAt < this.cooldownMs) {
      this.steadySince = null;
      return { readiness: 'searching', progress: 0, shouldCapture: false };
    }
    if (angularSpeed > 0.25) {
      this.steadySince = null;
      return { readiness: 'hold-still', progress: 0, shouldCapture: false };
    }
    this.steadySince ??= now;
    const progress = Math.min(1, (now - this.steadySince) / STEADY_MS);
    if (progress >= 1) {
      this.markCaptured(now);
      return { readiness: 'ready', progress: 1, shouldCapture: true };
    }
    return { readiness: 'hold-still', progress, shouldCapture: false };
  }
}

export const readinessCopy: Record<Readiness, string> = {
  searching: 'Point at a test',
  'swap-page': 'Next paper',
  'too-far': 'Move closer',
  'too-close': 'Back up a little',
  skewed: 'Flatten the page',
  'hold-still': 'Hold still',
  ready: 'Got it',
};
