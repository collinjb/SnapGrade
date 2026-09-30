/** Renders whatever `dialog.ts` asks for. Mounted once, at the app root.
 *
 *  Deliberately an in-app Modal rather than the platform's native alert: RN's
 *  Alert does nothing at all on web, and `window.confirm` cannot show more
 *  than two buttons or look like the rest of the app. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { registerDialogHost, type DialogRequest, type DialogStyle } from '@/lib/dialog';
import { colors, radius, space } from '@/theme';

export function DialogHost() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  // Guards against resolving the same promise twice — a fast double-tap, or
  // a dismiss racing a button press.
  const settled = useRef(false);

  useEffect(() => {
    registerDialogHost((next) => {
      settled.current = false;
      setRequest(next);
    });
    return () => registerDialogHost(null);
  }, []);

  const settle = useCallback(
    (value: unknown) => {
      if (settled.current) return;
      settled.current = true;
      request?.resolve(value);
      setRequest(null);
    },
    [request],
  );

  if (!request) return null;

  const cancelValue = request.options.find((o) => o.style === 'cancel')?.value ?? null;

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      // Android back button and Escape on web both land here.
      onRequestClose={() => settle(cancelValue)}
    >
      <Pressable style={styles.scrim} onPress={() => settle(cancelValue)}>
        {/* Swallow taps inside the card so they do not dismiss it. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{request.title}</Text>
          {request.message ? <Text style={styles.message}>{request.message}</Text> : null}

          <View style={styles.actions}>
            {request.options.map((option) => (
              <Pressable
                key={option.label}
                onPress={() => settle(option.value)}
                style={({ pressed }) => [
                  styles.button,
                  buttonStyle(option.style),
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
              >
                <Text style={[styles.buttonText, textStyle(option.style)]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function buttonStyle(style: DialogStyle | undefined) {
  if (style === 'cancel') return styles.buttonCancel;
  if (style === 'destructive') return styles.buttonDestructive;
  return styles.buttonDefault;
}

function textStyle(style: DialogStyle | undefined) {
  if (style === 'cancel') return styles.textCancel;
  if (style === 'destructive') return styles.textDestructive;
  return styles.textDefault;
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.xl,
    gap: space.sm,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  message: { fontSize: 15, color: colors.textDim, lineHeight: 21 },
  actions: { marginTop: space.md, gap: space.sm },
  button: {
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  buttonDefault: { backgroundColor: colors.accent },
  buttonCancel: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  buttonDestructive: { backgroundColor: colors.incorrect },
  buttonText: { fontSize: 16, fontWeight: '700' },
  textDefault: { color: '#fff' },
  textCancel: { color: colors.text },
  textDestructive: { color: '#fff' },
});
