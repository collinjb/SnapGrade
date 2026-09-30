/** The queue, as a strip of thumbnails above the shutter.
 *
 *  This is what replaces a blocking "Grading…" screen: you can see every
 *  paper you have shot, which ones are still working, and what the finished
 *  ones scored — without any of it stopping you taking the next one. */
import { memo, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { computeTotals } from '@/lib/scoring';
import { useImageUri } from '@/lib/useImageUri';
import { colors, radius, space } from '@/theme';
import type { PendingScan, ScanResult } from '@/types';

const CHIP = 54;
/** Enough to show a burst of scanning without crowding the shutter. */
const MAX_CHIPS = 8;

export interface TrayItem {
  key: string;
  createdAt: number;
  imageUri: string;
  kind: 'pending' | 'result';
  pending?: PendingScan;
  result?: ScanResult;
}

/** Merge the queue and the recent grades into one newest-first strip. A
 *  finished scan keeps its place, so a chip simply changes appearance
 *  instead of jumping. */
export function buildTrayItems(pending: PendingScan[], results: ScanResult[]): TrayItem[] {
  const items: TrayItem[] = [
    ...pending.map((p) => ({
      key: p.id,
      createdAt: p.createdAt,
      imageUri: p.imageUri,
      kind: 'pending' as const,
      pending: p,
    })),
    ...results.map((r) => ({
      key: r.id,
      createdAt: r.createdAt,
      imageUri: r.imageUri,
      kind: 'result' as const,
      result: r,
    })),
  ];
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_CHIPS);
}

interface Props {
  items: TrayItem[];
  onPressResult: (result: ScanResult) => void;
  onPressPending: (pending: PendingScan) => void;
}

export const ScanTray = memo(function ScanTray({ items, onPressResult, onPressPending }: Props) {
  if (items.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      // The newest chip is on the left, so there is nothing to scroll to.
      style={styles.scroll}
    >
      {items.map((item) => (
        <Chip
          key={item.key}
          item={item}
          onPress={() => {
            if (item.result) onPressResult(item.result);
            else if (item.pending) onPressPending(item.pending);
          }}
        />
      ))}
    </ScrollView>
  );
});

function Chip({ item, onPress }: { item: TrayItem; onPress: () => void }) {
  const entrance = useRef(new Animated.Value(0)).current;
  const uri = useImageUri(item.imageUri);

  useEffect(() => {
    Animated.spring(entrance, {
      toValue: 1,
      useNativeDriver: true,
      damping: 14,
      stiffness: 180,
      mass: 0.6,
    }).start();
  }, [entrance]);

  const style = {
    opacity: entrance,
    transform: [
      { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
    ],
  };

  return (
    <Animated.View style={style}>
      <Pressable
        onPress={onPress}
        style={styles.chip}
        accessibilityRole="button"
        accessibilityLabel={describe(item)}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />
        ) : (
          <View style={styles.thumb} />
        )}
        {item.result ? <ResultBadge result={item.result} /> : null}
        {item.pending ? <PendingBadge pending={item.pending} /> : null}
      </Pressable>
    </Animated.View>
  );
}

function ResultBadge({ result }: { result: ScanResult }) {
  const totals = computeTotals(result.problems);
  const tint =
    totals.needsReview > 0
      ? colors.review
      : totals.percent >= 80
        ? colors.correct
        : totals.percent >= 60
          ? colors.review
          : colors.incorrect;

  return (
    <>
      <View style={[styles.ring, { borderColor: tint }]} />
      <View style={[styles.scorePill, { backgroundColor: tint }]}>
        <Text style={styles.scoreText}>
          {totals.needsReview > 0 ? `${totals.needsReview}?` : `${totals.percent}%`}
        </Text>
      </View>
    </>
  );
}

function PendingBadge({ pending }: { pending: PendingScan }) {
  if (pending.status === 'failed') {
    return (
      <>
        <View style={[styles.ring, { borderColor: colors.incorrect }]} />
        <View style={styles.scrim}>
          <Text style={styles.bang}>!</Text>
        </View>
      </>
    );
  }

  if (pending.status === 'waiting') {
    return (
      <>
        <View style={[styles.ring, { borderColor: colors.review }]} />
        <View style={styles.scrim}>
          <Text style={styles.waitGlyph}>⏱</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <View style={[styles.ring, { borderColor: colors.camText }]} />
      <View style={styles.scrim}>
        <ActivityIndicator color="#fff" size="small" />
      </View>
    </>
  );
}

function describe(item: TrayItem): string {
  if (item.result) {
    const totals = computeTotals(item.result.problems);
    return `${item.result.studentName}, ${totals.earned} out of ${totals.possible}. Tap to open.`;
  }
  switch (item.pending?.status) {
    case 'failed':
      return 'This scan failed. Tap for options.';
    case 'waiting':
      return 'Waiting to be graded.';
    default:
      return 'Grading.';
  }
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  strip: { gap: space.sm, paddingHorizontal: space.xs, paddingVertical: space.xs },
  chip: {
    width: CHIP,
    height: CHIP,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: '#222',
  },
  thumb: { width: '100%', height: '100%' },
  ring: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.sm,
    borderWidth: 2.5,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bang: { color: '#fff', fontSize: 22, fontWeight: '900' },
  waitGlyph: { color: '#fff', fontSize: 18 },
  scorePill: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 2,
    alignItems: 'center',
  },
  scoreText: { color: '#fff', fontSize: 11, fontWeight: '800' },
});
