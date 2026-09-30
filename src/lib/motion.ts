/** How fast the device is being rotated, in rad/s.
 *
 *  Auto-capture uses this as a cheap early-out: hand shake shows up in the
 *  gyroscope well before the detected page corners move enough to notice, so
 *  it keeps blurry frames out. When there is no gyroscope the subscription
 *  reports 0 — "steady" — and corner drift alone gates the capture, which
 *  still works, just a little more eagerly. */
import { Gyroscope } from 'expo-sensors';

export type AngularSpeedListener = (radiansPerSecond: number) => void;

/** Subscribe to angular speed. Returns an unsubscribe; always safe to call. */
export function subscribeAngularSpeed(
  listener: AngularSpeedListener,
  intervalMs = 100,
): () => void {
  let subscription: { remove(): void } | null = null;
  let cancelled = false;

  void (async () => {
    try {
      // Not every device has a gyroscope, and asking is cheaper than an
      // exception from deep inside the native module.
      if (!(await Gyroscope.isAvailableAsync())) return;
      if (cancelled) return;

      Gyroscope.setUpdateInterval(intervalMs);
      subscription = Gyroscope.addListener(({ x, y, z }) => {
        listener(Math.hypot(x, y, z));
      });
    } catch (e) {
      console.warn('[snapgrade] gyroscope unavailable:', e);
    }
  })();

  return () => {
    cancelled = true;
    subscription?.remove();
    subscription = null;
  };
}
