/** A brief white flash on capture.
 *
 *  With grading pushed into the background there is no "Grading…" screen to
 *  confirm the shot landed, so the flash plus the haptic is the whole
 *  acknowledgement — fast enough that it never gets in the way of the next
 *  paper. */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';

export interface CaptureFlashHandle {
  fire(): void;
}

export const CaptureFlash = forwardRef<CaptureFlashHandle, object>(function CaptureFlash(_, ref) {
  const opacity = useRef(new Animated.Value(0)).current;

  useImperativeHandle(
    ref,
    () => ({
      fire() {
        opacity.stopAnimation();
        opacity.setValue(0.85);
        Animated.timing(opacity, {
          toValue: 0,
          duration: 220,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      },
    }),
    [opacity],
  );

  return (
    <Animated.View pointerEvents="none" style={[styles.flash, { opacity }]} />
  );
});

const styles = StyleSheet.create({
  flash: { ...StyleSheet.absoluteFillObject, backgroundColor: '#fff' },
});
