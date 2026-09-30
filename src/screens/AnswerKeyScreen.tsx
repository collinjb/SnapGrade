/** Pick how the correct answers get established. Chosen once, remembered for
 *  every paper after it, and reachable only from the pill on the camera. */
import { useCallback, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { processAnswerKey } from '@/lib/imaging';
import { pickPageImage } from '@/lib/pickPageImage';
import { useImageUri } from '@/lib/useImageUri';
import { useStore } from '@/store/useStore';
import { colors, radius, space } from '@/theme';
import type { RootStackParamList } from '@/navigation';
import type { AnswerKeyMode } from '@/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'AnswerKey'>;

const MODES: { mode: AnswerKeyMode; title: string; blurb: string }[] = [
  {
    mode: 'ai',
    title: 'Let AI solve it',
    blurb: 'Zero setup. Claude works each problem and grades against its own answer.',
  },
  {
    mode: 'scan',
    title: 'Scan an answer key',
    blurb: 'Photograph the completed key once. Every paper after it is graded against that.',
  },
  {
    mode: 'typed',
    title: 'Type the answers',
    blurb: 'Fastest when you already know them. One per line: 1: 42',
  },
];

export function AnswerKeyScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const assignment = useStore((s) => s.currentAssignment());
  const setAnswerKey = useStore((s) => s.setAnswerKey);
  const startNewAssignment = useStore((s) => s.startNewAssignment);
  const renameAssignment = useStore((s) => s.renameAssignment);

  const current = assignment?.answerKey;
  const [mode, setMode] = useState<AnswerKeyMode>(current?.mode ?? 'ai');
  const [typed, setTyped] = useState(current?.text ?? '');
  const [keyImageUri, setKeyImageUri] = useState(current?.imageUri ?? '');
  const [keyImageBase64, setKeyImageBase64] = useState(current?.imageBase64 ?? '');
  const [name, setName] = useState(assignment?.name ?? '');
  const [scanning, setScanning] = useState(false);
  const keyThumbUri = useImageUri(keyImageUri);

  const scanKey = useCallback(async () => {
    setScanning(true);
    try {
      const scanned = await pickPageImage();
      if (!scanned) return;
      const processed = await processAnswerKey(scanned.uri);
      setKeyImageUri(processed.uri);
      setKeyImageBase64(processed.base64);
      setMode('scan');
    } catch (e) {
      Alert.alert('Could not scan that', e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const save = useCallback(() => {
    if (!assignment) {
      navigation.goBack();
      return;
    }

    if (mode === 'typed' && typed.trim().length === 0) {
      Alert.alert('No answers yet', 'Type at least one answer, or pick another mode.');
      return;
    }
    if (mode === 'scan' && !keyImageBase64) {
      Alert.alert('No key scanned', 'Scan the completed answer key, or pick another mode.');
      return;
    }

    if (name.trim() && name.trim() !== assignment.name) {
      renameAssignment(assignment.id, name);
    }

    setAnswerKey({
      mode,
      text: mode === 'typed' ? typed.trim() : undefined,
      imageUri: mode === 'scan' ? keyImageUri : undefined,
      imageBase64: mode === 'scan' ? keyImageBase64 : undefined,
      updatedAt: Date.now(),
    });
    navigation.goBack();
  }, [
    assignment,
    keyImageBase64,
    keyImageUri,
    mode,
    name,
    navigation,
    renameAssignment,
    setAnswerKey,
    typed,
  ]);

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 100 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.label}>Assignment</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name this assignment"
          placeholderTextColor={colors.textDim}
          style={styles.nameInput}
          returnKeyType="done"
        />

        <Text style={styles.label}>Answer key</Text>
        {MODES.map((m) => (
          <Pressable
            key={m.mode}
            onPress={() => setMode(m.mode)}
            style={[styles.option, mode === m.mode && styles.optionActive]}
          >
            <View style={[styles.radio, mode === m.mode && styles.radioActive]}>
              {mode === m.mode ? <View style={styles.radioDot} /> : null}
            </View>
            <View style={styles.optionBody}>
              <Text style={styles.optionTitle}>{m.title}</Text>
              <Text style={styles.optionBlurb}>{m.blurb}</Text>

              {m.mode === 'scan' && mode === 'scan' ? (
                <View style={styles.keyBlock}>
                  {keyThumbUri ? (
                    <Image
                      source={{ uri: keyThumbUri }}
                      style={styles.keyThumb}
                      resizeMode="cover"
                    />
                  ) : null}
                  <Pressable
                    style={styles.smallButton}
                    onPress={() => void scanKey()}
                    disabled={scanning}
                  >
                    <Text style={styles.smallButtonText}>
                      {scanning ? 'Opening scanner…' : keyImageUri ? 'Rescan key' : 'Scan key now'}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {m.mode === 'typed' && mode === 'typed' ? (
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  multiline
                  placeholder={'1: 42\n2: x = 3\n3: 5/8'}
                  placeholderTextColor={colors.textDim}
                  style={styles.typedInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              ) : null}
            </View>
          </Pressable>
        ))}

        <Pressable
          style={styles.newAssignment}
          onPress={() => {
            Alert.alert(
              'Start a new assignment?',
              'Papers you scan next go into a fresh one. The papers you already scanned stay where they are.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Start new',
                  onPress: () => {
                    startNewAssignment();
                    navigation.goBack();
                  },
                },
              ],
            );
          }}
        >
          <Text style={styles.newAssignmentText}>Start a new assignment</Text>
        </Pressable>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
        <Pressable style={styles.primary} onPress={save}>
          <Text style={styles.primaryText}>Save and scan</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: space.sm,
  },
  nameInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    height: 48,
    fontSize: 16,
    color: colors.text,
  },
  option: {
    flexDirection: 'row',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    padding: space.md,
  },
  optionActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioActive: { borderColor: colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  optionBody: { flex: 1, gap: 4 },
  optionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  optionBlurb: { fontSize: 13, color: colors.textDim, lineHeight: 18 },
  keyBlock: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm },
  keyThumb: { width: 54, height: 70, borderRadius: radius.sm, backgroundColor: colors.border },
  smallButton: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  smallButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  typedInput: {
    marginTop: space.sm,
    minHeight: 120,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.md,
    fontSize: 15,
    color: colors.text,
    textAlignVertical: 'top',
    fontFamily: undefined,
  },
  newAssignment: { alignSelf: 'center', paddingVertical: space.lg },
  newAssignmentText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
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
  primary: {
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
