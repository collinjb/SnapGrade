/** The live page outline drawn over the camera preview.
 *
 *  Driven by React Native's Animated with the native driver, fed from the
 *  frame processor at 8fps. That rate is low enough that the JS hop costs
 *  nothing, and transform/opacity animations then run on the UI thread. */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { colors } from '@/theme';

export interface OverlayFrame {
  /** Normalized 0–1 corners, clockwise from top-left. Empty when searching. */
  corners: { x: number; y: number }[];
  /** 0–1 progress through the hold-still window. */
  progress: number;
}

export interface EdgeOverlayHandle {
  /** Push a new detection. Safe to call every frame. */
  update(frame: OverlayFrame): void;
  /** Hide the outline immediately, e.g. right after a capture. */
  clear(): void;
}

interface Props {
  width: number;
  height: number;
}

const BRACKET = 34;
const THICK = 4;

/** Which two edges each corner draws, so the brackets read as a page outline
 *  rather than four floating crosses. */
const CORNER_EDGES = [
  { top: true, left: true },
  { top: true, left: false },
  { top: false, left: false },
  { top: false, left: true },
] as const;

export const EdgeOverlay = forwardRef<EdgeOverlayHandle, Props>(function EdgeOverlay(
  { width, height },
  ref,
) {
  // One pair of Animated.Values per corner, plus shared opacity and progress.
  const positions = useMemo(
    () => CORNER_EDGES.map(() => ({ x: new Animated.Value(0), y: new Animated.Value(0) })),
    [],
  );
  const opacity = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const visible = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      update({ corners, progress: p }) {
        if (corners.length < 4) {
          this.clear();
          return;
        }

        for (let i = 0; i < 4; i++) {
          const c = corners[i]!;
          // setValue rather than a spring: the detector already gives us a
          // smoothed quad, and interpolating would lag the real page.
          positions[i]!.x.setValue(c.x * width - BRACKET / 2);
          positions[i]!.y.setValue(c.y * height - BRACKET / 2);
        }
        progress.setValue(p);

        if (!visible.current) {
          visible.current = true;
          Animated.timing(opacity, {
            toValue: 1,
            duration: 120,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }).start();
        }
      },
      clear() {
        if (!visible.current) return;
        visible.current = false;
        progress.setValue(0);
        Animated.timing(opacity, {
          toValue: 0,
          duration: 140,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      },
    }),
    [height, opacity, positions, progress, width],
  );

  // The brackets tighten and turn green as the steady timer fills, so the
  // countdown is legible without reading any text.
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.85] });
  const lockedOpacity = progress.interpolate({
    inputRange: [0, 0.15, 1],
    outputRange: [0, 1, 1],
  });

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {CORNER_EDGES.map((edges, i) => {
        const pos = positions[i]!;
        return (
          <Animated.View
            key={i}
            style={[
              styles.corner,
              {
                opacity,
                transform: [{ translateX: pos.x }, { translateY: pos.y }, { scale }],
              },
            ]}
          >
            <View
              style={[
                styles.bracket,
                { borderColor: colors.camText },
                bracketEdges(edges.top, edges.left),
              ]}
            />
            <Animated.View
              style={[
                styles.bracket,
                StyleSheet.absoluteFill,
                { borderColor: colors.camLocked, opacity: lockedOpacity },
                bracketEdges(edges.top, edges.left),
              ]}
            />
          </Animated.View>
        );
      })}
    </View>
  );
});

function bracketEdges(top: boolean, left: boolean) {
  return {
    borderTopWidth: top ? THICK : 0,
    borderBottomWidth: top ? 0 : THICK,
    borderLeftWidth: left ? THICK : 0,
    borderRightWidth: left ? 0 : THICK,
    borderTopLeftRadius: top && left ? 6 : 0,
    borderTopRightRadius: top && !left ? 6 : 0,
    borderBottomLeftRadius: !top && left ? 6 : 0,
    borderBottomRightRadius: !top && !left ? 6 : 0,
  };
}

const styles = StyleSheet.create({
  corner: {
    position: 'absolute',
    width: BRACKET,
    height: BRACKET,
  },
  bracket: { flex: 1 },
});
