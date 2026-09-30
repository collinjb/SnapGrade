/** Haptics on the web: the Vibration API where it exists (Android Chrome),
 *  and silence everywhere else. iOS Safari has no vibration API at all, so
 *  on an iPhone-installed PWA these are all no-ops — the capture flash and
 *  the tray chip carry the feedback instead. */
let enabled = true;

export function setHapticsEnabled(next: boolean): void {
  enabled = next;
}

function buzz(pattern: number | number[]): void {
  if (!enabled) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported, or blocked without a user gesture */
  }
}

export const tapCapture = (): void => buzz(18);
export const tapLock = (): void => buzz(8);
export const tapGraded = (needsReview: boolean): void => buzz(needsReview ? [14, 60, 14] : 24);
export const tapError = (): void => buzz([40, 50, 40]);
export const tapLight = (): void => buzz(6);
