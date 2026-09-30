/** Thin wrapper so a user who turns haptics off in Settings silences every
 *  call site at once, and so a device without a taptic engine never throws. */
import * as Haptics from 'expo-haptics';

let enabled = true;

export function setHapticsEnabled(next: boolean): void {
  enabled = next;
}

const guard = (fn: () => Promise<unknown>): void => {
  if (!enabled) return;
  void fn().catch(() => {});
};

/** The moment the shutter fires. */
export const tapCapture = (): void => guard(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));

/** The page has been framed and the steady countdown has started. */
export const tapLock = (): void => guard(() => Haptics.selectionAsync());

/** A grade came back. Success/warning reads differently in the pocket, which
 *  is the point: you can scan a stack without looking at the screen. */
export const tapGraded = (needsReview: boolean): void =>
  guard(() =>
    Haptics.notificationAsync(
      needsReview
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Success,
    ),
  );

export const tapError = (): void =>
  guard(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));

export const tapLight = (): void => guard(() => Haptics.selectionAsync());
