/** Settings, deliberately short: grading behaviour, capture behaviour, and
 *  the account upgrade. Anything that belongs on the capture path lives on the
 *  camera screen instead. */
import { useCallback, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { detectorLabel } from '@/components/CameraView';
import { pump, queueCounts, retryAllFailed } from '@/lib/gradeFlow';
import { nativeScannerAvailable } from '@/lib/nativeScanner';
import { skiaAvailable } from '@/lib/pageRender';
import { supabaseConfigured, upgradeToEmail } from '@/lib/supabase';
import { storageBackend } from '@/lib/storage';
import { useStore } from '@/store/useStore';
import { colors, radius, space } from '@/theme';

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const pending = useStore((s) => s.pending);
  const assignments = useStore((s) => s.assignments);
  const counts = queueCounts(pending);

  const [email, setEmail] = useState('');
  const [upgrading, setUpgrading] = useState(false);

  const onUpgrade = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed.includes('@')) {
      Alert.alert('Check that address', 'That does not look like an email address.');
      return;
    }
    setUpgrading(true);
    const { error } = await upgradeToEmail(trimmed);
    setUpgrading(false);
    if (error) Alert.alert('Could not link that address', error);
    else {
      Alert.alert(
        'Check your email',
        'Confirm the address and this device keeps everything you have scanned.',
      );
      setEmail('');
    }
  }, [email]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
    >
      <Section title="Grading">
        <Row
          title="Partial credit"
          blurb="Award part marks when the work is right but the answer slips. Off means all-or-nothing."
        >
          <Switch
            value={settings.partialCredit}
            onValueChange={(v) => updateSettings({ partialCredit: v })}
            trackColor={{ true: colors.accent }}
          />
        </Row>
        <Row
          title="Flag anything uncertain"
          blurb={`Problems the model is less than ${Math.round(
            settings.confidenceFloor * 100,
          )}% sure about are marked "Needs review" instead of being guessed.`}
        >
          <View style={styles.stepper}>
            <StepButton
              label="−"
              onPress={() =>
                updateSettings({
                  confidenceFloor: Math.max(0, Math.round((settings.confidenceFloor - 0.1) * 10) / 10),
                })
              }
            />
            <Text style={styles.stepperValue}>{Math.round(settings.confidenceFloor * 100)}%</Text>
            <StepButton
              label="+"
              onPress={() =>
                updateSettings({
                  confidenceFloor: Math.min(0.95, Math.round((settings.confidenceFloor + 0.1) * 10) / 10),
                })
              }
            />
          </View>
        </Row>
      </Section>

      <Section title="Capture">
        <Row
          title="Auto-capture"
          blurb="Grab the page as soon as it is framed and steady. The shutter button always works too."
        >
          <Switch
            value={settings.autoCapture}
            onValueChange={(v) => updateSettings({ autoCapture: v })}
            trackColor={{ true: colors.accent }}
          />
        </Row>
        <Row
          title="Use the system scanner"
          blurb={
            nativeScannerAvailable()
              ? 'Hands capture to iOS VisionKit / Android ML Kit. Slower to open, but the best cropping there is.'
              : Platform.OS === 'web'
                ? 'Only in the installed app — a browser has no system document scanner.'
                : 'Not in this build. Rebuild the dev client with react-native-document-scanner-plugin to enable it.'
          }
        >
          <Switch
            value={settings.scanEngine === 'native'}
            disabled={!nativeScannerAvailable()}
            onValueChange={(v) => updateSettings({ scanEngine: v ? 'native' : 'vision' })}
            trackColor={{ true: colors.accent }}
          />
        </Row>
        <Row title="Haptics" blurb="A tap on capture and on the result.">
          <Switch
            value={settings.hapticsEnabled}
            onValueChange={(v) => updateSettings({ hapticsEnabled: v })}
            trackColor={{ true: colors.accent }}
          />
        </Row>
      </Section>

      <Section title="Sync">
        <Row
          title="Upload page images"
          blurb="Keeps the scanned pages in your Supabase storage as well as on this device. Off by default — student work stays local."
        >
          <Switch
            value={settings.uploadImages}
            onValueChange={(v) => updateSettings({ uploadImages: v })}
            trackColor={{ true: colors.accent }}
          />
        </Row>

        {counts.waiting > 0 || counts.working > 0 ? (
          <Pressable style={styles.action} onPress={() => pump()}>
            <Text style={styles.actionText}>
              {counts.working > 0
                ? `Grading ${counts.working} now, ${counts.waiting} queued`
                : `Grade ${counts.waiting} queued ${counts.waiting === 1 ? 'scan' : 'scans'} now`}
            </Text>
          </Pressable>
        ) : null}

        {counts.failed > 0 ? (
          <>
            <Pressable style={styles.action} onPress={() => retryAllFailed()}>
              <Text style={styles.actionText}>
                Retry {counts.failed} failed {counts.failed === 1 ? 'scan' : 'scans'}
              </Text>
            </Pressable>
            <Pressable
              style={styles.action}
              onPress={() =>
                Alert.alert(
                  'Discard failed scans?',
                  `${counts.failed} ${counts.failed === 1 ? 'scan' : 'scans'} will be deleted without being graded.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Discard',
                      style: 'destructive',
                      onPress: () => useStore.getState().clearFailedPending(),
                    },
                  ],
                )
              }
            >
              <Text style={[styles.actionText, { color: colors.incorrect }]}>
                Discard failed scans
              </Text>
            </Pressable>
          </>
        ) : null}

        <View style={styles.upgrade}>
          <Text style={styles.upgradeTitle}>Sync across devices</Text>
          <Text style={styles.blurb}>
            You are signed in anonymously — everything works without an account. Add an email to
            keep your assignments if you change phones.
          </Text>
          <View style={styles.upgradeRow}>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@school.edu"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={styles.emailInput}
            />
            <Pressable
              style={[styles.smallButton, (!supabaseConfigured || upgrading) && styles.disabled]}
              disabled={!supabaseConfigured || upgrading}
              onPress={() => void onUpgrade()}
            >
              <Text style={styles.smallButtonText}>{upgrading ? '…' : 'Link'}</Text>
            </Pressable>
          </View>
        </View>
      </Section>

      <Section title="Diagnostics">
        <Diag label="Backend" value={supabaseConfigured ? 'connected' : 'not configured'} />
        <Diag label="Platform" value={Platform.OS === 'web' ? 'web (PWA)' : Platform.OS} />
        <Diag label="Edge detector" value={detectorLabel} />
        <Diag label="Perspective correction" value={skiaAvailable() ? 'Skia' : 'crop only'} />
        <Diag label="Local storage" value={storageBackend} />
        <Diag label="Assignments" value={String(assignments.length)} />
        <Diag label="In the grader" value={String(counts.working)} />
        <Diag label="Queued" value={String(counts.waiting)} />
        <Diag label="Failed" value={String(counts.failed)} />
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.blurb}>{blurb}</Text>
      </View>
      {children}
    </View>
  );
}

function StepButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.step}>
      <Text style={styles.stepText}>{label}</Text>
    </Pressable>
  );
}

function Diag({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.diag}>
      <Text style={styles.diagLabel}>{label}</Text>
      <Text style={styles.diagValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.xl },
  section: { gap: space.sm },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  blurb: { fontSize: 13, color: colors.textDim, lineHeight: 18 },

  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  step: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 19, fontWeight: '800', color: colors.accent, lineHeight: 22 },
  stepperValue: {
    minWidth: 44,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },

  action: { padding: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  actionText: { color: colors.accent, fontSize: 15, fontWeight: '700' },

  upgrade: { padding: space.md, gap: space.sm },
  upgradeTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  upgradeRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  emailInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    fontSize: 15,
    color: colors.text,
  },
  smallButton: {
    paddingHorizontal: space.lg,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.4 },

  diag: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  diagLabel: { fontSize: 14, color: colors.textDim },
  diagValue: { fontSize: 14, color: colors.text, fontWeight: '600' },
});
