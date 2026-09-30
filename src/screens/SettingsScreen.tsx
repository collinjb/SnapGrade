/** Settings, deliberately short: grading behaviour, capture behaviour, and
 *  the account upgrade. Anything that belongs on the capture path lives on the
 *  camera screen instead. */
import { useCallback, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import {
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
import { getApiKey, maskKey, setApiKey } from '@/lib/apiKeys';
import { confirm } from '@/lib/dialog';
import { DEFAULT_PROVIDER, PROVIDER_LIST, getProvider } from '@/lib/grading';
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

  const provider = getProvider(settings.provider ?? DEFAULT_PROVIDER);
  const [keyDraft, setKeyDraft] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  // `getApiKey` reads device storage, which React cannot observe, so a save
  // has to bump this to force the masked view to re-read.
  const [keyRevision, setKeyRevision] = useState(0);
  const [keyStatus, setKeyStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(
    null,
  );
  const activeModel = settings.models?.[provider.id] ?? provider.defaultModel;
  const [modelDraft, setModelDraft] = useState(activeModel);
  const [modelOpen, setModelOpen] = useState(false);
  const storedKey = useMemo(() => getApiKey(provider.id), [provider.id, keyRevision]);

  const saveKey = useCallback(() => {
    const next = keyDraft.trim();

    // Never fail silently. The previous version bailed into a confirm dialog
    // that react-native-web renders as nothing at all, so on the web the
    // button simply appeared dead.
    if (!next) {
      setKeyStatus({ tone: 'error', text: 'Paste your key into the box first.' });
      return;
    }

    setApiKey(provider.id, next);
    setKeyRevision((n) => n + 1);
    setEditingKey(false);
    setKeyDraft('');

    // The format check is a hint, not a gate: key formats change, and being
    // locked out by my regex is far worse than one wrong-looking key that
    // the first scan will reject with a clear message anyway.
    setKeyStatus(
      provider.looksLikeKey(next)
        ? { tone: 'ok', text: 'Saved. Point the camera at a paper.' }
        : {
            tone: 'warn',
            text: `Saved. Heads up: ${provider.label} keys normally start with ${provider.keyPrefix}.`,
          },
    );
  }, [keyDraft, provider]);

  const saveModel = useCallback(
    (value: string) => {
      const next = value.trim();
      updateSettings({
        models: {
          ...settings.models,
          // Storing undefined means "use whatever this build ships with",
          // so clearing the box is how you get back to the default.
          [provider.id]: next && next !== provider.defaultModel ? next : undefined,
        },
      });
      setModelOpen(false);
    },
    [provider, settings.models, updateSettings],
  );

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

      <Section title="Grader">
        <View style={styles.providerRow}>
          {PROVIDER_LIST.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => updateSettings({ provider: p.id })}
              style={[styles.providerChip, provider.id === p.id && styles.providerChipActive]}
            >
              <Text
                style={[
                  styles.providerChipText,
                  provider.id === p.id && styles.providerChipTextActive,
                ]}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.keyBlock}>
          <Text style={styles.rowTitle}>{provider.label} API key</Text>
          <Text style={styles.blurb}>
            Stored on this device only, and sent nowhere except {provider.label}. There is no
            SnapGrade server.
          </Text>

          {editingKey || !storedKey ? (
            <>
              <TextInput
                value={keyDraft}
                onChangeText={setKeyDraft}
                placeholder={provider.keyHint}
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                secureTextEntry
                style={styles.keyInput}
              />
              <View style={styles.keyActions}>
                <Pressable
                  style={styles.smallButton}
                  onPress={saveKey}
                  accessibilityRole="button"
                  accessibilityLabel="Save API key"
                >
                  <Text style={styles.smallButtonText}>Save key</Text>
                </Pressable>
                <Pressable
                  style={styles.linkButton}
                  onPress={() => void Linking.openURL(provider.keyUrl)}
                >
                  <Text style={styles.linkButtonText}>Get a key</Text>
                </Pressable>
                {storedKey ? (
                  <Pressable
                    style={styles.linkButton}
                    onPress={() => {
                      setEditingKey(false);
                      setKeyDraft('');
                    }}
                  >
                    <Text style={styles.linkButtonText}>Cancel</Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : (
            <View style={styles.keyActions}>
              <Text style={styles.keyMask}>{maskKey(storedKey)}</Text>
              <View style={styles.spacer} />
              <Pressable style={styles.linkButton} onPress={() => setEditingKey(true)}>
                <Text style={styles.linkButtonText}>Replace</Text>
              </Pressable>
              <Pressable
                style={styles.linkButton}
                onPress={() => {
                  void confirm('Remove this key?', 'Grading stops until you add another.', {
                    confirmLabel: 'Remove',
                    destructive: true,
                  }).then((yes) => {
                    if (!yes) return;
                    setApiKey(provider.id, '');
                    setKeyRevision((n) => n + 1);
                    setEditingKey(true);
                    setKeyStatus(null);
                  });
                }}
              >
                <Text style={[styles.linkButtonText, { color: colors.incorrect }]}>Remove</Text>
              </Pressable>
            </View>
          )}
          <Pressable
            onPress={() => {
              setModelDraft(activeModel);
              setModelOpen((v) => !v);
            }}
            hitSlop={6}
            style={styles.modelRow}
          >
            <Text style={styles.modelLabel}>Model</Text>
            <Text style={styles.modelValue} numberOfLines={1}>
              {activeModel}
            </Text>
            <Text style={styles.linkButtonText}>{modelOpen ? 'Close' : 'Change'}</Text>
          </Pressable>

          {modelOpen ? (
            <>
              <TextInput
                value={modelDraft}
                onChangeText={setModelDraft}
                placeholder={provider.defaultModel}
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                style={styles.keyInput}
              />
              <Text style={styles.blurb}>
                Providers retire model names on their own schedule. If grading starts failing with
                a &quot;does not recognise the model&quot; error, paste the new id here — no new
                build needed. Empty resets to {provider.defaultModel}.
              </Text>
              <View style={styles.keyActions}>
                <Pressable style={styles.smallButton} onPress={() => saveModel(modelDraft)}>
                  <Text style={styles.smallButtonText}>Save model</Text>
                </Pressable>
                <Pressable style={styles.linkButton} onPress={() => saveModel('')}>
                  <Text style={styles.linkButtonText}>Reset</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {keyStatus ? (
            <Text
              style={[
                styles.keyStatus,
                keyStatus.tone === 'ok' && { color: colors.correct },
                keyStatus.tone === 'warn' && { color: colors.review },
                keyStatus.tone === 'error' && { color: colors.incorrect },
              ]}
            >
              {keyStatus.text}
            </Text>
          ) : null}
        </View>
      </Section>

      <Section title="Queue">
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
              onPress={() => {
                void confirm(
                  'Discard failed scans?',
                  `${counts.failed} ${counts.failed === 1 ? 'scan' : 'scans'} will be deleted without being graded.`,
                  { confirmLabel: 'Discard', destructive: true },
                ).then((yes) => {
                  if (yes) useStore.getState().clearFailedPending();
                });
              }}
            >
              <Text style={[styles.actionText, { color: colors.incorrect }]}>
                Discard failed scans
              </Text>
            </Pressable>
          </>
        ) : null}

        <Pressable
          style={styles.action}
          onPress={() => {
            void confirm(
              'Clear everything?',
              'Every assignment, grade and queued scan on this device is deleted. Your settings and API key are kept.',
              { confirmLabel: 'Clear', destructive: true },
            ).then((yes) => {
              if (yes) useStore.getState().clearEverything();
            });
          }}
        >
          <Text style={[styles.actionText, { color: colors.incorrect }]}>Clear everything</Text>
        </Pressable>
      </Section>

      <Section title="Diagnostics">
        <Diag label="Grader" value={provider.label} />
        <Diag label="Model" value={activeModel} />
        <Diag label="API key" value={storedKey ? 'set' : 'not set'} />
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

  providerRow: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  providerChip: {
    flex: 1,
    paddingVertical: space.sm + 2,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
  },
  providerChipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  providerChipText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  providerChipTextActive: { color: colors.accent },
  keyBlock: { padding: space.md, gap: space.sm },
  keyInput: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    fontSize: 15,
    color: colors.text,
  },
  keyActions: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  keyStatus: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: space.xs,
  },
  modelLabel: { fontSize: 14, color: colors.textDim },
  modelValue: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  keyMask: {
    fontSize: 14,
    color: colors.textDim,
    fontVariant: ['tabular-nums'],
  },
  linkButton: { paddingVertical: space.sm, paddingHorizontal: space.sm },
  linkButtonText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  spacer: { flex: 1 },
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
