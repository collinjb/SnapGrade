/** Math rendering on the web.
 *
 *  `react-native-webview` has no web implementation at all, so the native
 *  component cannot be reused here — and it should not be. In a browser the
 *  document *is* the renderer: KaTeX writes straight into a span, with no
 *  iframe, no bridge and no height round-trip.
 *
 *  KaTeX loads from a CDN once per session. If it never arrives, the plain
 *  text fallback in `mathFormat.ts` takes over. */
import { memo, useEffect, useRef, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import { colors } from '@/theme';
import {
  KATEX_AUTORENDER,
  KATEX_CSS,
  KATEX_DELIMITERS,
  KATEX_JS,
  looksMathy,
  toPlainMath,
} from '@/lib/mathFormat';

export { looksMathy, toPlainMath };

interface KatexWindow extends Window {
  katex?: unknown;
  renderMathInElement?: (el: HTMLElement, options: Record<string, unknown>) => void;
}

let loader: Promise<boolean> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(src)), { once: true });
      // Already finished before we attached: nothing will fire, so check.
      if ((existing as HTMLScriptElement & { dataset: DOMStringMap }).dataset.loaded === '1') {
        resolve();
      }
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error(src));
    document.head.appendChild(script);
  });
}

/** Load KaTeX once per session. Resolves false if it could not be reached. */
function ensureKatex(): Promise<boolean> {
  loader ??= (async () => {
    try {
      if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = KATEX_CSS;
        document.head.appendChild(link);
      }
      // auto-render depends on katex itself, so these cannot race.
      await loadScript(KATEX_JS);
      await loadScript(KATEX_AUTORENDER);
      return typeof (window as KatexWindow).renderMathInElement === 'function';
    } catch {
      return false;
    }
  })();
  return loader;
}

interface Props {
  text: string;
  style?: TextStyle;
  color?: string;
  fontSize?: number;
  numberOfLines?: number;
}

export const MathText = memo(function MathText({
  text,
  style,
  color = colors.text,
  fontSize = 15,
  numberOfLines,
}: Props) {
  const host = useRef<HTMLSpanElement | null>(null);
  const [rendered, setRendered] = useState(false);
  const mathy = looksMathy(text);

  useEffect(() => {
    if (!mathy) return;
    let cancelled = false;

    void ensureKatex().then((ready) => {
      const el = host.current;
      if (cancelled || !ready || !el) return;
      // textContent, never innerHTML: the string came from a model reading a
      // photograph, and it is not going to be treated as markup.
      el.textContent = text;
      try {
        (window as KatexWindow).renderMathInElement?.(el, {
          delimiters: KATEX_DELIMITERS,
          throwOnError: false,
        });
        setRendered(true);
      } catch {
        setRendered(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [mathy, text]);

  if (!text) return null;

  if (!mathy) {
    return (
      <Text style={[{ fontSize, color }, style]} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }

  return (
    <>
      <span
        ref={host}
        style={{
          fontSize,
          color,
          lineHeight: 1.4,
          display: rendered ? 'inline-block' : 'none',
        }}
      />
      {rendered ? null : (
        <Text style={[{ fontSize, color }, style]} numberOfLines={numberOfLines}>
          {toPlainMath(text)}
        </Text>
      )}
    </>
  );
});
