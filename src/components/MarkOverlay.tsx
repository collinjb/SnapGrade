/** Check marks, X's and review flags positioned over the scanned page.
 *
 *  Each mark sits at the centre of the problem's bbox and is tappable: one tap
 *  cycles the teacher's override, which recomputes the score instantly. */
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { effectiveStatus } from '@/lib/scoring';
import { statusColor } from '@/theme';
import type { ScoredProblem } from '@/types';

const MARK = 30;

const glyph = (status: string): string => {
  switch (status) {
    case 'correct':
      return '✓';
    case 'incorrect':
      return '✗';
    case 'partial':
      return '½';
    case 'blank':
      return '–';
    default:
      return '?';
  }
};

/** One problem, carrying the index it has in the full list so a filtered
 *  overlay can still report the right one when tapped. */
export interface MarkEntry {
  problem: ScoredProblem;
  index: number;
}

interface Props {
  entries: MarkEntry[];
  /** Rendered size of the page image, in points. */
  width: number;
  height: number;
  onPressProblem: (index: number) => void;
  /** Index to pulse, when the list selection should be findable on the page. */
  highlighted?: number | null;
}

export const MarkOverlay = memo(function MarkOverlay({
  entries,
  width,
  height,
  onPressProblem,
  highlighted,
}: Props) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {entries.map(({ problem: p, index: i }, position) => {
        const status = effectiveStatus(p);
        // A zero-size bbox means the model could not place the problem; park
        // those marks down the left margin rather than stacking them at 0,0.
        const hasBox = p.bbox.w > 0.01 && p.bbox.h > 0.01;
        const cx = hasBox ? (p.bbox.x + p.bbox.w / 2) * width : 0.06 * width;
        const cy = hasBox
          ? (p.bbox.y + p.bbox.h / 2) * height
          : ((position + 0.5) / Math.max(entries.length, 1)) * height;

        return (
          <Pressable
            key={`${p.number}-${i}`}
            onPress={() => onPressProblem(i)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Problem ${p.number}, ${status}. Tap to change.`}
            style={[
              styles.mark,
              {
                left: cx - MARK / 2,
                top: cy - MARK / 2,
                backgroundColor: statusColor(status),
                borderWidth: highlighted === i ? 3 : 0,
              },
              p.override ? styles.overridden : null,
            ]}
          >
            <Text style={styles.glyph}>{glyph(status)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  mark: {
    position: 'absolute',
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  /** A dashed rim marks a human decision, so it is obvious at a glance which
   *  marks the teacher set and which the model did. */
  overridden: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#fff',
  },
  glyph: { color: '#fff', fontSize: 16, fontWeight: '900', lineHeight: 19 },
});
