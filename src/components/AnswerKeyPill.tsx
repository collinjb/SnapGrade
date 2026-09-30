/** The small status pill at the top of the camera: which answer-key mode is
 *  active, and how many papers are in this assignment so far. Tapping it is
 *  the only route into setup, which keeps the capture screen at zero chrome. */
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '@/theme';
import type { AnswerKeyMode } from '@/types';

export const modeLabel: Record<AnswerKeyMode, string> = {
  ai: 'AI solves it',
  scan: 'Scanned key',
  typed: 'Typed answers',
};

interface Props {
  mode: AnswerKeyMode;
  assignmentName: string;
  /** Papers already graded into this assignment. */
  scanCount: number;
  /** Papers still moving through the background grader. */
  workingCount: number;
  /** Papers that gave up and need a decision. */
  failedCount: number;
  onPress: () => void;
}

export const AnswerKeyPill = memo(function AnswerKeyPill({
  mode,
  assignmentName,
  scanCount,
  workingCount,
  failedCount,
  onPress,
}: Props) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={
        `Assignment ${assignmentName}, answer key: ${modeLabel[mode]}, ` +
        `${scanCount} graded${workingCount > 0 ? `, ${workingCount} in progress` : ''}` +
        `${failedCount > 0 ? `, ${failedCount} failed` : ''}. Tap to change.`
      }
      style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
    >
      <View style={[styles.dot, mode === 'ai' ? styles.dotAi : styles.dotKey]} />
      <Text style={styles.name} numberOfLines={1}>
        {assignmentName}
      </Text>
      <Text style={styles.sep}>·</Text>
      <Text style={styles.mode} numberOfLines={1}>
        {modeLabel[mode]}
      </Text>
      {scanCount > 0 ? (
        <View style={styles.count}>
          <Text style={styles.countText}>{scanCount}</Text>
        </View>
      ) : null}
      {workingCount > 0 ? (
        <View style={[styles.count, styles.working]}>
          <Text style={styles.countText}>+{workingCount}</Text>
        </View>
      ) : null}
      {failedCount > 0 ? (
        <View style={[styles.count, styles.failed]}>
          <Text style={styles.countText}>{failedCount} failed</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '92%',
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.camChrome,
    gap: space.sm,
  },
  pressed: { opacity: 0.7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotAi: { backgroundColor: colors.accent },
  dotKey: { backgroundColor: colors.camLocked },
  name: { color: colors.camText, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  sep: { color: colors.camTextDim, fontSize: 14 },
  mode: { color: colors.camTextDim, fontSize: 14, flexShrink: 1 },
  count: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  working: { backgroundColor: 'rgba(105,56,239,0.55)' },
  failed: { backgroundColor: 'rgba(240,68,56,0.6)' },
  countText: { color: colors.camText, fontSize: 12, fontWeight: '700' },
});
