/** The app's front door: a full-screen camera that grades what you point it at.
 *
 *  Nothing here ever blocks on a grade. A capture is flashed, handed to the
 *  background pipeline and forgotten; the preview stays live and the shutter
 *  stays armed, so a stack of papers can be scanned as fast as they can be
 *  laid down. The tray above the shutter is where the queue and the finished
 *  scores show up. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { AnswerKeyPill } from '@/components/AnswerKeyPill';
import {
  CameraView,
  supportsEdgeDetection,
  type CameraStatus,
  type CameraViewHandle,
} from '@/components/CameraView';
import { CaptureFlash, type CaptureFlashHandle } from '@/components/CaptureFlash';
import { EdgeOverlay, type EdgeOverlayHandle } from '@/components/EdgeOverlay';
import { ShutterButton, type ShutterHandle } from '@/components/ShutterButton';
import { ScanTray, buildTrayItems } from '@/components/ScanTray';
import {
  MotionOnlyTracker,
  StabilityTracker,
  readinessCopy,
  type Evaluation,
} from '@/lib/autoCapture';
import { cornersToPixels, type Corners } from '@/lib/documentDetector';
import { hasApiKey } from '@/lib/apiKeys';
import { ask, notify } from '@/lib/dialog';
import { enqueueCapture, queueCounts, startGradingWorker } from '@/lib/gradeFlow';
import { getProvider } from '@/lib/grading';
import { subscribeAngularSpeed } from '@/lib/motion';
import { tapCapture, tapLight } from '@/lib/haptics';
import { scanWithNativeScanner } from '@/lib/nativeScanner';
import { useStore } from '@/store/useStore';
import { colors, radius, space } from '@/theme';
import type { RootStackParamList } from '@/navigation';
import type { PendingScan } from '@/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Camera'>;

export function CameraScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const camera = useRef<CameraViewHandle>(null);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('loading');

  const settings = useStore((s) => s.settings);
  const assignments = useStore((s) => s.assignments);
  const currentAssignmentId = useStore((s) => s.currentAssignmentId);
  const resultsByAssignment = useStore((s) => s.resultsByAssignment);
  const pending = useStore((s) => s.pending);
  const showFirstRunTip = useStore((s) => s.showFirstRunTip);

  const assignment = assignments.find((a) => a.id === currentAssignmentId) ?? null;
  const results = currentAssignmentId ? (resultsByAssignment[currentAssignmentId] ?? []) : [];
  const scanCount = results.length;

  const counts = useMemo(() => queueCounts(pending), [pending]);
  const trayItems = useMemo(
    () =>
      buildTrayItems(
        currentAssignmentId ? pending.filter((p) => p.assignmentId === currentAssignmentId) : [],
        results,
      ),
    [currentAssignmentId, pending, results],
  );

  const [isFocused, setIsFocused] = useState(true);
  const [readinessText, setReadinessText] = useState(readinessCopy.searching);

  // `hasApiKey` reads device storage rather than the store, so re-check it
  // every time this screen comes forward — the user may have just added one.
  const [keyPresent, setKeyPresent] = useState(() => hasApiKey(settings.provider));
  const provider = getProvider(settings.provider);

  // Imperative handles keep per-frame animation out of React's render path.
  const overlayRef = useRef<EdgeOverlayHandle>(null);
  const shutterRef = useRef<ShutterHandle>(null);
  const flashRef = useRef<CaptureFlashHandle>(null);

  // Trackers and the latest detection live in refs: they change every frame
  // and must never trigger a render.
  const tracker = useRef(new StabilityTracker());
  const motionTracker = useRef(new MotionOnlyTracker());
  const latestCorners = useRef<Corners | null>(null);
  const angularSpeed = useRef(0);
  /** True only for the few hundred ms the shutter itself takes. */
  const shooting = useRef(false);
  const captureRef = useRef<() => Promise<void>>(async () => {});

  const detectionEnabled = settings.autoCapture && supportsEdgeDetection && isFocused;
  const detectionEnabledRef = useRef(detectionEnabled);
  detectionEnabledRef.current = detectionEnabled;

  // --- Pause the camera only when this screen is not on top ---------------
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      setKeyPresent(hasApiKey(useStore.getState().settings.provider));
      tracker.current.resetAll();
      motionTracker.current.reset();
      overlayRef.current?.clear();
      shutterRef.current?.setProgress(0);
      return () => setIsFocused(false);
    }, []),
  );

  // --- The background grader ---------------------------------------------
  useEffect(() => startGradingWorker(), []);

  // --- The cheap "is the hand steady" signal ------------------------------
  useEffect(() => {
    if (!settings.autoCapture) return;
    return subscribeAngularSpeed((speed) => {
      angularSpeed.current = speed;
    });
  }, [settings.autoCapture]);

  /** Push an evaluation into the UI and fire the shutter if it says so. */
  const applyEvaluation = useCallback((evaluation: Evaluation, corners?: Corners | null) => {
    shutterRef.current?.setProgress(evaluation.progress);

    if (corners && evaluation.readiness !== 'searching') {
      overlayRef.current?.update({
        corners: corners.map((c) => ({ x: c.x, y: c.y })),
        progress: evaluation.progress,
      });
    } else {
      overlayRef.current?.clear();
    }

    setReadinessText((prev) => {
      const next = readinessCopy[evaluation.readiness];
      return prev === next ? prev : next;
    });

    // A single tick the moment the page locks, so you know to hold still
    // without watching the screen.
    if (evaluation.progress > 0 && evaluation.progress < 0.2) tapLight();
    if (evaluation.shouldCapture) void captureRef.current();
  }, []);

  /** Reported by whichever detector this platform has. */
  const onDetection = useCallback(
    (corners: Corners | null, confidence: number) => {
      if (!detectionEnabledRef.current) return;
      latestCorners.current = corners;
      applyEvaluation(
        tracker.current.push(
          corners ? { corners, confidence, t: Date.now() } : null,
          angularSpeed.current,
        ),
        corners,
      );
    },
    [applyEvaluation],
  );

  // --- Steady-only fallback (platforms with no edge detector) -------------
  useEffect(() => {
    if (supportsEdgeDetection || !settings.autoCapture || !isFocused) return;
    const timer = setInterval(() => {
      // "Armed" means the user is holding the phone in a scanning pose rather
      // than leaving it face-up on a desk; without edge detection that is the
      // best proxy for intent we have.
      const armed = angularSpeed.current < 1.2;
      applyEvaluation(motionTracker.current.push(angularSpeed.current, armed));
    }, 100);
    return () => clearInterval(timer);
  }, [applyEvaluation, isFocused, settings.autoCapture]);

  // --- Capture ------------------------------------------------------------
  const capture = useCallback(async () => {
    // The only thing that gates a capture is another capture already in the
    // shutter. Grading happens elsewhere and never blocks this.
    if (shooting.current) return;
    shooting.current = true;

    try {
      if (useStore.getState().settings.scanEngine === 'native') {
        const scanned = await scanWithNativeScanner();
        if (!scanned) return;
        tapCapture();
        flashRef.current?.fire();
        // The OS scanner already cropped and de-skewed the page.
        enqueueCapture(scanned.uri, { width: scanned.width, height: scanned.height }, null);
        return;
      }

      const photo = await camera.current?.takePhoto();
      if (!photo) return;

      tapCapture();
      flashRef.current?.fire();

      // Corners arrive normalized in frame space, which shares the photo's
      // aspect ratio, so they scale straight into photo pixels. A manual shot
      // reuses the last detection when there is one, so tapping the shutter
      // still gets a de-skewed page.
      const corners = latestCorners.current;
      const quad = corners ? cornersToPixels(corners, photo.width, photo.height) : null;

      // Disarm until the page is actually swapped, so the sheet still lying
      // in frame is not scanned twice.
      tracker.current.markCaptured(Date.now(), corners);
      motionTracker.current.markCaptured();
      overlayRef.current?.clear();
      shutterRef.current?.setProgress(0);

      enqueueCapture(photo.uri, { width: photo.width, height: photo.height }, quad);
    } catch (e) {
      console.warn('[snapgrade] capture failed:', e);
      void notify('That shot did not go through', e instanceof Error ? e.message : 'Try again.');
    } finally {
      shooting.current = false;
    }
  }, []);

  captureRef.current = capture;

  const onPressPending = useCallback(async (item: PendingScan) => {
    if (item.status !== 'failed') return;
    const choice = await ask<'leave' | 'retry' | 'discard'>(
      'This scan did not go through',
      item.lastError ?? 'Unknown error.',
      [
        { label: 'Leave it', value: 'leave', style: 'cancel' },
        { label: 'Try again', value: 'retry' },
        { label: 'Discard', value: 'discard', style: 'destructive' },
      ],
    );
    if (choice === 'retry') useStore.getState().retryPending(item.id);
    if (choice === 'discard') useStore.getState().removePending(item.id);
  }, []);

  // --- Render -------------------------------------------------------------
  if (cameraStatus === 'denied' || cameraStatus === 'no-device') {
    const denied = cameraStatus === 'denied';
    return (
      <View style={styles.center}>
        <Text style={styles.permTitle}>
          {denied ? 'SnapGrade needs the camera' : 'No camera here'}
        </Text>
        <Text style={styles.permBody}>
          {denied
            ? 'That is the whole app: point it at a test and it grades the page.'
            : 'Open SnapGrade on a phone or tablet with a rear camera.'}
        </Text>
        {denied ? (
          <Pressable
            style={styles.permButton}
            onPress={() => {
              void camera.current?.requestPermission().then((granted) => {
                // A hard refusal is remembered by the OS and the browser
                // alike, so the only way back is the settings screen.
                if (!granted && Platform.OS !== 'web') void Linking.openSettings();
              });
            }}
          >
            <Text style={styles.permButtonText}>Allow camera</Text>
          </Pressable>
        ) : null}

        {/* Without this the screen is a dead end: no camera means no way to
            reach Settings, and Settings is where the API key goes. */}
        <Pressable
          style={styles.permSecondary}
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
        >
          <Text style={styles.permSecondaryText}>Open settings</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        ref={camera}
        // Deliberately not gated on grading: the preview stays live while
        // papers are still in the queue.
        isActive={isFocused}
        detectionEnabled={detectionEnabled}
        onDetection={onDetection}
        onStatusChange={setCameraStatus}
      />

      {cameraStatus === 'loading' ? (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator color={colors.camText} />
        </View>
      ) : null}

      <EdgeOverlay ref={overlayRef} width={width} height={height} />
      <CaptureFlash ref={flashRef} />

      {/* Top chrome */}
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <AnswerKeyPill
          mode={assignment?.answerKey.mode ?? 'ai'}
          assignmentName={assignment?.name ?? 'New assignment'}
          scanCount={scanCount}
          workingCount={counts.working + counts.waiting}
          failedCount={counts.failed}
          onPress={() => navigation.navigate('AnswerKey')}
        />
        {!keyPresent ? (
          // Capture still works without a key — the scans just queue up and
          // fail. Saying so here is better than letting the tray fill with
          // red chips.
          <Pressable
            style={styles.warning}
            onPress={() => navigation.navigate('Settings')}
            accessibilityRole="button"
            accessibilityLabel={`Add your ${provider.label} API key`}
          >
            <Text style={styles.warningText}>
              Add your {provider.label} API key to start grading
            </Text>
            <Text style={styles.warningHint}>Tap to open Settings</Text>
          </Pressable>
        ) : showFirstRunTip ? (
          <Pressable
            style={styles.tip}
            onPress={() => useStore.getState().dismissFirstRunTip()}
            accessibilityRole="button"
            accessibilityLabel="Dismiss tip"
          >
            <Text style={styles.tipText}>
              Point at a test. We'll grab it automatically — keep going, grading runs in the
              background.
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Bottom chrome */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
        <ScanTray
          items={trayItems}
          onPressResult={(result) =>
            navigation.navigate('Results', {
              assignmentId: result.assignmentId,
              resultId: result.id,
            })
          }
          onPressPending={(item) => void onPressPending(item)}
        />
        <Text style={styles.readiness}>
          {settings.autoCapture ? readinessText : 'Tap to capture'}
        </Text>
        <View style={styles.controls}>
          <CornerButton
            label="Papers"
            badge={scanCount > 0 ? String(scanCount) : undefined}
            onPress={() => {
              if (currentAssignmentId) {
                navigation.navigate('Summary', { assignmentId: currentAssignmentId });
              }
            }}
            disabled={scanCount === 0}
          />
          <ShutterButton ref={shutterRef} onPress={() => void capture()} />
          <CornerButton label="Settings" onPress={() => navigation.navigate('Settings')} />
        </View>
      </View>
    </View>
  );
}

function CornerButton({
  label,
  onPress,
  badge,
  disabled,
}: {
  label: string;
  onPress: () => void;
  badge?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.cornerButton,
        pressed && { opacity: 0.6 },
        disabled && { opacity: 0.35 },
      ]}
    >
      <Text style={styles.cornerLabel}>{label}</Text>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.camBg },
  center: {
    flex: 1,
    backgroundColor: colors.camBg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  permTitle: { color: colors.camText, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  permBody: { color: colors.camTextDim, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  permButton: {
    marginTop: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.xxl,
    borderRadius: radius.pill,
    backgroundColor: colors.camText,
  },
  permButtonText: { color: colors.camBg, fontSize: 16, fontWeight: '700' },
  permSecondary: { paddingVertical: space.md, paddingHorizontal: space.lg },
  permSecondaryText: { color: colors.camTextDim, fontSize: 15, fontWeight: '600' },

  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  tip: {
    alignSelf: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: 'rgba(105,56,239,0.92)',
  },
  tipText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  warning: {
    alignSelf: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: 'rgba(247,144,9,0.94)',
    alignItems: 'center',
  },
  warningText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  warningHint: { color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 2 },

  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  readiness: {
    color: colors.camText,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cornerButton: {
    minWidth: 78,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.xs,
  },
  cornerLabel: {
    color: colors.camText,
    fontSize: 15,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  badge: {
    minWidth: 20,
    paddingHorizontal: 5,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
});
