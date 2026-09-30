/** Manual shutter, always available as the fallback to auto-capture.
 *
 *  The ring doubles as the auto-capture countdown, so one control tells you
 *  both what you can do and what is about to happen on its own. */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { colors } from '@/theme';

const SIZE = 78;
const RING = 4;

export interface ShutterHandle {
  /** 0–1 auto-capture progress. */
  setProgress(value: number): void;
}

interface Props {
  onPress: () => void;
  disabled?: boolean;
}

export const ShutterButton = forwardRef<ShutterHandle, Props>(function ShutterButton(
  { onPress, disabled = false },
  ref,
) {
  const progress = useRef(new Animated.Value(0)).current;

  useImperativeHandle(ref, () => ({ setProgress: (v) => progress.setValue(v) }), [progress]);

  const ringScale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const coreScale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] });
  // Colour is not native-driver-safe, so the green state is a second layer
  // faded in over the white one.
  const lockOpacity = progress.interpolate({
    inputRange: [0, 0.05, 1],
    outputRange: [0, 1, 1],
  });

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={16}
      accessibilityRole="button"
      accessibilityLabel="Capture page"
      style={({ pressed }) => [styles.hit, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Animated.View style={[styles.ring, { transform: [{ scale: ringScale }] }]}>
        <Animated.View style={[styles.core, { transform: [{ scale: coreScale }] }]} />
        <Animated.View
          style={[styles.core, styles.coreLocked, { opacity: lockOpacity, transform: [{ scale: coreScale }] }]}
        />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.ringLocked, { opacity: lockOpacity, transform: [{ scale: ringScale }] }]}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  hit: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.35 },
  ring: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: RING,
    borderColor: colors.camText,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringLocked: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: RING,
    borderColor: colors.camLocked,
  },
  core: {
    position: 'absolute',
    width: SIZE - RING * 2 - 8,
    height: SIZE - RING * 2 - 8,
    borderRadius: SIZE / 2,
    backgroundColor: colors.camText,
  },
  coreLocked: { backgroundColor: colors.camLocked },
});
