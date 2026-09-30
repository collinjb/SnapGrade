/** Dialogs that actually appear on every platform.
 *
 *  React Native's `Alert` is a no-op stub under react-native-web — it does
 *  not throw, it simply does nothing — so every confirm in the app silently
 *  failed in the browser, up to and including "save my API key". Rather than
 *  split per platform and end up with `window.confirm` in one and a native
 *  sheet in the other, this routes everything through one in-app modal:
 *  identical behaviour, identical look, and it supports more than the two
 *  buttons `window.confirm` allows.
 *
 *  `DialogHost` (mounted once in App.tsx) does the rendering. */

export type DialogStyle = 'default' | 'cancel' | 'destructive';

export interface DialogOption<T> {
  label: string;
  value: T;
  style?: DialogStyle;
}

export interface DialogRequest {
  title: string;
  message?: string;
  options: DialogOption<unknown>[];
  resolve: (value: unknown) => void;
}

type Handler = (request: DialogRequest) => void;

let handler: Handler | null = null;

/** Called by DialogHost on mount. */
export function registerDialogHost(next: Handler | null): void {
  handler = next;
}

/**
 * Ask the user to pick one of `options`. Resolves with the chosen value, or
 * null if the dialog was dismissed.
 *
 * With no host mounted this resolves null rather than hanging — a missing
 * dialog must never wedge a caller that is awaiting it.
 */
export function ask<T>(
  title: string,
  message: string | undefined,
  options: DialogOption<T>[],
): Promise<T | null> {
  if (!handler) {
    console.warn('[snapgrade] no dialog host mounted; dismissing:', title);
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve) => {
    handler?.({
      title,
      message,
      options: options as DialogOption<unknown>[],
      resolve: (value) => resolve(value as T | null),
    });
  });
}

/** A message with a single acknowledgement. */
export function notify(title: string, message?: string): Promise<void> {
  return ask(title, message, [{ label: 'OK', value: true, style: 'cancel' }]).then(() => undefined);
}

/** A yes/no question. Resolves false on cancel or dismiss. */
export async function confirm(
  title: string,
  message?: string,
  opts: { confirmLabel?: string; cancelLabel?: string; destructive?: boolean } = {},
): Promise<boolean> {
  const chosen = await ask<boolean>(title, message, [
    { label: opts.cancelLabel ?? 'Cancel', value: false, style: 'cancel' },
    {
      label: opts.confirmLabel ?? 'OK',
      value: true,
      style: opts.destructive ? 'destructive' : 'default',
    },
  ]);
  return chosen === true;
}
