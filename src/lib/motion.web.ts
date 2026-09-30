/** Angular speed on the web, from the DeviceMotion event.
 *
 *  iOS 13+ gates DeviceMotion behind an explicit permission that can only be
 *  requested from a user gesture. Asking for it the moment the camera opens
 *  would be a second permission prompt stacked on the camera's own, for a
 *  signal that is only an optimisation — so we just listen. If the events
 *  never arrive the speed stays 0, which reads as "steady", and corner drift
 *  alone gates the capture. */
export type AngularSpeedListener = (radiansPerSecond: number) => void;

const DEG_TO_RAD = Math.PI / 180;

export function subscribeAngularSpeed(
  listener: AngularSpeedListener,
  _intervalMs = 100,
): () => void {
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
    return () => {};
  }

  const onMotion = (event: DeviceMotionEvent) => {
    const rate = event.rotationRate;
    if (!rate) return;
    // The spec says degrees per second; the trackers work in radians.
    listener(
      Math.hypot(rate.alpha ?? 0, rate.beta ?? 0, rate.gamma ?? 0) * DEG_TO_RAD,
    );
  };

  window.addEventListener('devicemotion', onMotion);
  return () => window.removeEventListener('devicemotion', onMotion);
}
