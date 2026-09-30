/** Everything scanned into one assignment: the roster with scores, the class
 *  average, the problems the class fell down on, and CSV export. */
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { MathText } from '@/components/MathText';
import { useImageUri } from '@/lib/useImageUri';
import { exportCsv, type CsvShape } from '@/lib/csv';
import { ask, confirm, notify } from '@/lib/dialog';
import { assignmentStats, computeTotals } from '@/lib/scoring';
import { useStore } from '@/store/useStore';
import { colors, radius, space } from '@/theme';
import type { RootStackParamList } from '@/navigation';
import type { ScanResult } from '@/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Summary'>;
type Rt = RouteProp<RootStackParamList, 'Summary'>;

export function AssignmentSummaryScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const insets = useSafeAreaInsets();

  const assignment = useStore((s) => s.assignments.find((a) => a.id === params.assignmentId) ?? null);
  const results = useStore((s) => s.resultsByAssignment[params.assignmentId] ?? []);
  const renameAssignment = useStore((s) => s.renameAssignment);
  const deleteResult = useStore((s) => s.deleteResult);
  const startNewAssignment = useStore((s) => s.startNewAssignment);

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [exporting, setExporting] = useState(false);
  /** Scan order matches the physical stack, which is what you want when
   *  transcribing scores back onto the papers. Newest-first is better while
   *  you are still scanning, so it stays the default. */
  const [oldestFirst, setOldestFirst] = useState(false);

  const stats = useMemo(() => assignmentStats(results), [results]);
  const ordered = useMemo(
    () => (oldestFirst ? [...results].reverse() : results),
    [oldestFirst, results],
  );

  const onExport = useCallback(
    async (shape: CsvShape) => {
      if (!assignment || exporting) return;
      setExporting(true);
      try {
        await exportCsv(assignment, results, shape);
      } catch (e) {
        void notify('Export failed', e instanceof Error ? e.message : String(e));
      } finally {
        setExporting(false);
      }
    },
    [assignment, exporting, results],
  );

  const onDelete = useCallback(
    async (result: ScanResult) => {
      const yes = await confirm(
        'Remove this paper?',
        `${result.studentName} will be taken out of the class average.`,
        { confirmLabel: 'Remove', destructive: true },
      );
      if (yes) deleteResult(result.assignmentId, result.id);
    },
    [deleteResult],
  );

  if (!assignment) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>That assignment is gone.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={ordered}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        ListHeaderComponent={
          <View style={styles.header}>
            {renaming ? (
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                onBlur={() => {
                  renameAssignment(assignment.id, nameDraft);
                  setRenaming(false);
                }}
                onSubmitEditing={() => {
                  renameAssignment(assignment.id, nameDraft);
                  setRenaming(false);
                }}
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                style={styles.titleInput}
                placeholder="Assignment name"
                placeholderTextColor={colors.textDim}
              />
            ) : (
              <Pressable
                onPress={() => {
                  setNameDraft(assignment.name);
                  setRenaming(true);
                }}
                hitSlop={8}
              >
                <Text style={styles.title}>
                  {assignment.name}
                  <Text style={styles.editHint}>  rename</Text>
                </Text>
              </Pressable>
            )}

            <View style={styles.statRow}>
              <Stat label="Papers" value={String(stats.count)} />
              <Stat
                label="Class average"
                value={stats.average === null ? '—' : `${stats.average}%`}
                emphasis
              />
              {stats.needsReview > 0 ? (
                <Stat label="Need review" value={String(stats.needsReview)} warn />
              ) : null}
            </View>

            {stats.mostMissed.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Most missed</Text>
                {stats.mostMissed.map((m) => (
                  <View key={m.number} style={styles.missedRow}>
                    <Text style={styles.missedNumber}>{m.number}</Text>
                    <View style={styles.missedBody}>
                      <MathText
                        text={m.questionText || 'Problem ' + m.number}
                        fontSize={14}
                        color={colors.text}
                        numberOfLines={2}
                      />
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.barFill,
                            { width: `${Math.round((m.missed / m.of) * 100)}%` },
                          ]}
                        />
                      </View>
                    </View>
                    <Text style={styles.missedCount}>
                      {m.missed}/{m.of}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.listHeader}>
              <Text style={styles.sectionLabel}>Students</Text>
              <View style={styles.spacer} />
              {results.length > 1 ? (
                <Pressable onPress={() => setOldestFirst((v) => !v)} hitSlop={8}>
                  <Text style={styles.orderToggle}>
                    {oldestFirst ? 'Scan order' : 'Newest first'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item, index }) => (
          <StudentRow
            result={item}
            position={oldestFirst ? index + 1 : results.length - index}
            onOpen={() =>
              navigation.navigate('Results', {
                assignmentId: item.assignmentId,
                resultId: item.id,
              })
            }
            onDelete={() => void onDelete(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No papers yet</Text>
            <Text style={styles.dim}>Scan one and it lands here.</Text>
          </View>
        }
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
        <Pressable
          style={[styles.secondary, results.length === 0 && styles.disabled]}
          disabled={results.length === 0 || exporting}
          onPress={() => {
            void ask<CsvShape | 'cancel'>('Export CSV', 'Which shape do you need?', [
              { label: 'Cancel', value: 'cancel', style: 'cancel' },
              { label: 'Scores only', value: 'summary' },
              { label: 'Every problem', value: 'detail' },
            ]).then((shape) => {
              if (shape && shape !== 'cancel') void onExport(shape);
            });
          }}
        >
          <Text style={styles.secondaryText}>{exporting ? 'Exporting…' : 'Export CSV'}</Text>
        </Pressable>
        <Pressable
          style={styles.primary}
          onPress={() => {
            startNewAssignment();
            navigation.popTo('Camera');
          }}
        >
          <Text style={styles.primaryText}>New assignment</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** One paper in the transcription list.
 *
 *  The thumbnail is the point: when you are working down a physical stack
 *  writing scores on, a name like "Student 4" is useless but a glimpse of
 *  the page is instant. */
function StudentRow({
  result,
  position,
  onOpen,
  onDelete,
}: {
  result: ScanResult;
  position: number;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const totals = computeTotals(result.problems);
  const thumb = useImageUri(result.imageUri);
  const tint =
    totals.percent >= 80
      ? colors.correct
      : totals.percent >= 60
        ? colors.review
        : colors.incorrect;

  return (
    <Pressable style={styles.studentRow} onPress={onOpen} onLongPress={onDelete}>
      <Text style={styles.position}>{position}</Text>
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={styles.thumb} />
      )}
      <View style={styles.studentBody}>
        <Text
          style={[styles.studentName, result.studentNameIsPlaceholder && styles.dim]}
          numberOfLines={1}
        >
          {result.studentName}
        </Text>
        {totals.needsReview > 0 ? (
          <Text style={styles.reviewNote}>
            {totals.needsReview} to check
          </Text>
        ) : null}
      </View>
      <View style={styles.scoreBlock}>
        <Text style={[styles.studentScore, { color: tint }]}>
          {totals.earned}/{totals.possible}
        </Text>
        <Text style={[styles.studentPercent, { color: tint }]}>{totals.percent}%</Text>
      </View>
    </Pressable>
  );
}

function Stat({
  label,
  value,
  emphasis,
  warn,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  warn?: boolean;
}) {
  return (
    <View style={styles.stat}>
      <Text
        style={[
          styles.statValue,
          emphasis && { color: colors.accent, fontSize: 30 },
          warn && { color: colors.review },
        ]}
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  dim: { color: colors.textDim, fontSize: 14 },

  header: { padding: space.lg, gap: space.lg },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  titleInput: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.text,
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
    paddingVertical: 2,
  },
  editHint: { fontSize: 13, fontWeight: '600', color: colors.accent },

  statRow: { flexDirection: 'row', gap: space.xl },
  stat: { gap: 2 },
  statValue: { fontSize: 26, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  statLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.md,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  missedRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  missedNumber: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text,
    minWidth: 24,
  },
  missedBody: { flex: 1, gap: 4 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.incorrect },
  missedCount: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textDim,
    fontVariant: ['tabular-nums'],
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  listHeader: { flexDirection: 'row', alignItems: 'center' },
  spacer: { flex: 1 },
  orderToggle: { fontSize: 13, fontWeight: '700', color: colors.accent },
  studentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.sm,
    paddingRight: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  position: {
    minWidth: 20,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '800',
    color: colors.textDim,
    fontVariant: ['tabular-nums'],
  },
  thumb: {
    width: 44,
    height: 56,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  studentBody: { flex: 1, gap: 2 },
  studentName: { fontSize: 16, fontWeight: '600', color: colors.text },
  reviewNote: { fontSize: 12, fontWeight: '700', color: colors.review },
  scoreBlock: { alignItems: 'flex-end' },
  studentScore: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  studentPercent: {
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },

  empty: { padding: space.xxl, alignItems: 'center', gap: space.sm },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.text },

  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  secondary: {
    flex: 1,
    height: 52,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  primary: {
    flex: 1,
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.4 },
});
