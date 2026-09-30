/** The grade, laid over the page it came from.
 *
 *  The page image with marks on it sits at the top so a teacher can check the
 *  model's work against the paper without leaving the screen; the list below
 *  carries the detail. One button — Next — goes straight back to the camera,
 *  which is the loop the whole app is built around. */
import { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { MarkOverlay } from '@/components/MarkOverlay';
import { ProblemRow } from '@/components/ProblemRow';
import { computeTotals } from '@/lib/scoring';
import { tapLight } from '@/lib/haptics';
import { useImageUri } from '@/lib/useImageUri';
import { useStore } from '@/store/useStore';
import { colors, radius, space } from '@/theme';
import type { RootStackParamList } from '@/navigation';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Results'>;
type Rt = RouteProp<RootStackParamList, 'Results'>;

export function ResultsScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const result = useStore(
    (s) => s.resultsByAssignment[params.assignmentId]?.find((r) => r.id === params.resultId) ?? null,
  );
  const toggleProblemOverride = useStore((s) => s.toggleProblemOverride);
  const updateResult = useStore((s) => s.updateResult);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const pageUri = useImageUri(result?.imageUri);

  const totals = useMemo(() => (result ? computeTotals(result.problems) : null), [result]);

  const onToggle = useCallback(
    (index: number) => {
      if (!result) return;
      tapLight();
      toggleProblemOverride(result.assignmentId, result.id, index);
    },
    [result, toggleProblemOverride],
  );

  const commitName = useCallback(() => {
    if (!result) return;
    const next = nameDraft.trim();
    setEditingName(false);
    if (!next || next === result.studentName) return;
    updateResult(result.assignmentId, result.id, {
      studentName: next,
      studentNameIsPlaceholder: false,
    });
  }, [nameDraft, result, updateResult]);

  if (!result || !totals) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>That result is no longer here.</Text>
        <Pressable style={styles.primary} onPress={() => navigation.popTo('Camera')}>
          <Text style={styles.primaryText}>Back to camera</Text>
        </Pressable>
      </View>
    );
  }

  const aspect = result.imageHeight > 0 ? result.imageWidth / result.imageHeight : 0.77;
  const imageWidth = width;
  const imageHeight = Math.min(imageWidth / aspect, 420);
  // The image is letterboxed inside its box by `resizeMode: contain`, so the
  // marks have to use the *displayed* rectangle, not the container.
  const displayedWidth = Math.min(imageWidth, imageHeight * aspect);
  const displayedHeight = displayedWidth / aspect;
  const offsetX = (imageWidth - displayedWidth) / 2;
  const offsetY = (imageHeight - displayedHeight) / 2;

  const percentColor =
    totals.percent >= 80 ? colors.correct : totals.percent >= 60 ? colors.review : colors.incorrect;

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        stickyHeaderIndices={[0]}
      >
        {/* Score header */}
        <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
          <View style={styles.headerRow}>
            <View style={styles.scoreBlock}>
              <Text style={[styles.score, { color: percentColor }]}>
                {totals.earned}/{totals.possible}
              </Text>
              <Text style={[styles.percent, { color: percentColor }]}>{totals.percent}%</Text>
            </View>
            <View style={styles.spacer} />
            <Pressable
              onPress={() => navigation.navigate('Summary', { assignmentId: result.assignmentId })}
              hitSlop={10}
              style={styles.headerLink}
            >
              <Text style={styles.headerLinkText}>All papers</Text>
            </Pressable>
          </View>

          {editingName ? (
            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              onBlur={commitName}
              onSubmitEditing={commitName}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              style={styles.nameInput}
              placeholder="Student name"
              placeholderTextColor={colors.textDim}
            />
          ) : (
            <Pressable
              onPress={() => {
                setNameDraft(result.studentNameIsPlaceholder ? '' : result.studentName);
                setEditingName(true);
              }}
              hitSlop={8}
            >
              <Text
                style={[styles.name, result.studentNameIsPlaceholder && styles.namePlaceholder]}
              >
                {result.studentName}
                <Text style={styles.editHint}>  edit</Text>
              </Text>
            </Pressable>
          )}

          {totals.needsReview > 0 ? (
            <View style={styles.reviewBanner}>
              <Text style={styles.reviewBannerText}>
                {totals.needsReview} {totals.needsReview === 1 ? 'problem needs' : 'problems need'}{' '}
                your call — tap a mark or a row
              </Text>
            </View>
          ) : null}
        </View>

        {/* The page, with marks */}
        <View style={[styles.imageWrap, { width: imageWidth, height: imageHeight }]}>
          {pageUri ? (
            <Image
              source={{ uri: pageUri }}
              style={{ width: imageWidth, height: imageHeight }}
              resizeMode="contain"
            />
          ) : (
            // The grade itself is always kept; the photo behind it can be
            // evicted from the cache, so say so rather than showing a void.
            <View style={[styles.noImage, { width: imageWidth, height: imageHeight }]}>
              <Text style={styles.noImageText}>Page image is no longer stored</Text>
            </View>
          )}
          <View
            style={{
              position: 'absolute',
              left: offsetX,
              top: offsetY,
              width: displayedWidth,
              height: displayedHeight,
            }}
            pointerEvents="box-none"
          >
            <MarkOverlay
              problems={result.problems}
              width={displayedWidth}
              height={displayedHeight}
              onPressProblem={onToggle}
              highlighted={selected}
            />
          </View>
        </View>

        <View style={styles.tallyRow}>
          <Tally label="Correct" value={totals.correct} color={colors.correct} />
          {totals.partial > 0 ? (
            <Tally label="Partial" value={totals.partial} color={colors.partial} />
          ) : null}
          <Tally label="Wrong" value={totals.incorrect} color={colors.incorrect} />
          {totals.needsReview > 0 ? (
            <Tally label="Review" value={totals.needsReview} color={colors.review} />
          ) : null}
        </View>

        {result.problems.map((p, i) => (
          <ProblemRow
            key={`${p.number}-${i}`}
            problem={p}
            index={i}
            onToggle={onToggle}
            onPress={setSelected}
            selected={selected === i}
          />
        ))}

        {result.problems.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing gradable on that page</Text>
            <Text style={styles.emptyBody}>
              Retake it with the whole worksheet in frame and good light.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* The loop: one tap back to the camera. */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
        <Pressable
          style={styles.next}
          onPress={() => navigation.popTo('Camera')}
          accessibilityRole="button"
          accessibilityLabel="Next paper"
        >
          <Text style={styles.nextText}>Next paper</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Tally({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.tally}>
      <Text style={[styles.tallyValue, { color }]}>{value}</Text>
      <Text style={styles.tallyLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  missing: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  missingText: { fontSize: 16, color: colors.textDim },

  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: space.xs,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-end' },
  scoreBlock: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  score: { fontSize: 38, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  percent: { fontSize: 20, fontWeight: '700' },
  spacer: { flex: 1 },
  headerLink: { paddingVertical: space.xs, paddingHorizontal: space.sm },
  headerLinkText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  name: { fontSize: 17, fontWeight: '600', color: colors.text },
  namePlaceholder: { color: colors.textDim },
  editHint: { fontSize: 13, color: colors.accent, fontWeight: '600' },
  nameInput: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
    paddingVertical: 4,
  },
  reviewBanner: {
    marginTop: space.sm,
    backgroundColor: '#FEF0C7',
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  reviewBannerText: { color: '#93370D', fontSize: 13, fontWeight: '600' },

  imageWrap: { backgroundColor: '#111', alignSelf: 'center' },
  noImage: { alignItems: 'center', justifyContent: 'center' },
  noImageText: { color: 'rgba(255,255,255,0.55)', fontSize: 13 },

  tallyRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: space.lg,
  },
  tally: { alignItems: 'center', minWidth: 62 },
  tallyValue: { fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tallyLabel: {
    fontSize: 11,
    color: colors.textDim,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  empty: { padding: space.xxl, alignItems: 'center', gap: space.sm },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  emptyBody: { fontSize: 14, color: colors.textDim, textAlign: 'center' },

  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  next: {
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  primary: {
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
