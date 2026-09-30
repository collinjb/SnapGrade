/** One row of the results list: what was asked, what the student put, what it
 *  should have been, and why it was wrong — in that reading order. */
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MathText } from './MathText';
import { effectiveStatus } from '@/lib/scoring';
import { colors, radius, space, statusColor, statusLabel } from '@/theme';
import type { ScoredProblem } from '@/types';

interface Props {
  problem: ScoredProblem;
  index: number;
  onToggle: (index: number) => void;
  onPress?: (index: number) => void;
  selected?: boolean;
}

export const ProblemRow = memo(function ProblemRow({
  problem,
  index,
  onToggle,
  onPress,
  selected,
}: Props) {
  const status = effectiveStatus(problem);
  const tint = statusColor(status);
  const isCorrect = status === 'correct';
  const isBlank = status === 'blank';

  return (
    <Pressable
      onPress={() => onPress?.(index)}
      style={[styles.row, selected && styles.rowSelected]}
      accessibilityRole="button"
    >
      <View style={[styles.stripe, { backgroundColor: tint }]} />

      <View style={styles.body}>
        <View style={styles.header}>
          <Text style={styles.number}>{problem.number || index + 1}</Text>
          <Text style={[styles.status, { color: tint }]}>{statusLabel(status)}</Text>
          {problem.override ? <Text style={styles.manual}>manual</Text> : null}
          <View style={styles.spacer} />
          <Text style={styles.points}>
            {problem.override === 'correct'
              ? problem.points_possible
              : problem.override === 'incorrect'
                ? 0
                : problem.points_earned}
            /{problem.points_possible}
          </Text>
        </View>

        {problem.question_text ? (
          <MathText
            text={problem.question_text}
            color={colors.text}
            fontSize={15}
            numberOfLines={3}
          />
        ) : null}

        <View style={styles.answers}>
          <View style={styles.answerCol}>
            <Text style={styles.answerLabel}>{isBlank ? 'Left blank' : 'Their answer'}</Text>
            <MathText
              text={problem.student_answer || '—'}
              color={isCorrect ? colors.text : isBlank ? colors.textDim : colors.incorrect}
              fontSize={15}
            />
          </View>
          {!isCorrect ? (
            <View style={styles.answerCol}>
              <Text style={styles.answerLabel}>Correct</Text>
              <MathText text={problem.correct_answer || '—'} color={colors.correct} fontSize={15} />
            </View>
          ) : null}
        </View>

        {!isCorrect && problem.explanation ? (
          <Text style={styles.explanation}>{problem.explanation}</Text>
        ) : null}

        {status === 'needs_review' ? (
          <View style={styles.reviewActions}>
            <Text style={styles.reviewHint}>
              {problem.confidence < 0.4 ? 'Low confidence' : 'Unclear'} — you decide
            </Text>
            <View style={styles.spacer} />
            <Pressable
              onPress={() => onToggle(index)}
              style={[styles.reviewButton, { borderColor: tint }]}
              hitSlop={8}
            >
              <Text style={[styles.reviewButtonText, { color: tint }]}>Mark it</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => onToggle(index)} hitSlop={8} style={styles.overrideLink}>
            <Text style={styles.overrideLinkText}>
              {problem.override ? 'Reset to AI grade' : 'Change this'}
            </Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowSelected: { borderColor: colors.accent, borderWidth: 2 },
  stripe: { width: 5 },
  body: { flex: 1, padding: space.md, gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  number: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text,
    minWidth: 22,
  },
  status: { fontSize: 13, fontWeight: '700' },
  manual: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  spacer: { flex: 1 },
  points: { fontSize: 14, fontWeight: '700', color: colors.textDim, fontVariant: ['tabular-nums'] },
  answers: { flexDirection: 'row', gap: space.lg },
  answerCol: { flex: 1, gap: 2 },
  answerLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  explanation: { fontSize: 14, color: colors.textDim, lineHeight: 19 },
  reviewActions: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  reviewHint: { fontSize: 13, color: colors.review, fontWeight: '600' },
  reviewButton: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1.5,
  },
  reviewButtonText: { fontSize: 13, fontWeight: '700' },
  overrideLink: { alignSelf: 'flex-start', paddingVertical: 2 },
  overrideLinkText: { fontSize: 13, color: colors.accent, fontWeight: '600' },
});
