/** Renders question and answer text, using KaTeX in a WebView only when the
 *  text actually contains math.
 *
 *  A WebView per list row would be far too heavy for a fast-scrolling results
 *  list, so `looksMathy` gates it: "42" and "x = 3" render as plain text, and
 *  only genuine LaTeX ($\frac{3}{4}$, $x^{2}$) pays for a WebView. */
import { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { colors } from '@/theme';
import {
  KATEX_AUTORENDER,
  KATEX_CSS,
  KATEX_JS,
  looksMathy,
  toPlainMath,
} from '@/lib/mathFormat';

export { looksMathy, toPlainMath };

function escapeForHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHtml(text: string, fontSize: number, color: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<link rel="stylesheet" href="${KATEX_CSS}" />
<style>
  html, body {
    margin: 0; padding: 0; background: transparent;
    font: ${fontSize}px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: ${color};
    overflow: hidden;
  }
  #c { padding: 0; }
  .katex { font-size: 1.05em; }
</style>
</head>
<body>
<div id="c">${escapeForHtml(text)}</div>
<script src="${KATEX_JS}"></script>
<script src="${KATEX_AUTORENDER}"></script>
<script>
  function report() {
    var h = document.getElementById('c').getBoundingClientRect().height;
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(String(Math.ceil(h)));
  }
  function run() {
    try {
      window.renderMathInElement(document.getElementById('c'), {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\\\(', right: '\\\\)', display: false },
          { left: '\\\\[', right: '\\\\]', display: true }
        ],
        throwOnError: false
      });
    } catch (e) {}
    report();
  }
  if (window.renderMathInElement) run();
  else window.addEventListener('load', run);
  // If the CDN never arrives, still report a height so the row sizes itself.
  setTimeout(report, 1200);
</script>
</body>
</html>`;
}

interface Props {
  text: string;
  style?: TextStyle;
  color?: string;
  fontSize?: number;
  numberOfLines?: number;
}

/**
 * Math-aware text. Falls back to a readable plain-text transliteration if the
 * WebView fails to load — offline, or behind a network that blocks the CDN.
 */
export const MathText = memo(function MathText({
  text,
  style,
  color = colors.text,
  fontSize = 15,
  numberOfLines,
}: Props) {
  const mathy = useMemo(() => looksMathy(text), [text]);
  const [height, setHeight] = useState(fontSize * 1.5);
  const [failed, setFailed] = useState(false);

  if (!text) return null;

  if (!mathy || failed) {
    return (
      <Text style={[{ fontSize, color }, style]} numberOfLines={numberOfLines}>
        {mathy ? toPlainMath(text) : text}
      </Text>
    );
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        originWhitelist={['*']}
        source={{ html: buildHtml(text, fontSize, color) }}
        style={styles.web}
        containerStyle={styles.web}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        // Static content: the only navigations allowed are the document
        // itself and the pinned KaTeX assets. Nothing else can load, so a
        // hostile string in a grade can't turn this into a browser.
        javaScriptEnabled
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(r) =>
          r.url.startsWith('about:') ||
          r.url.startsWith('data:') ||
          r.url.startsWith('file:') ||
          r.url.startsWith('https://cdn.jsdelivr.net/npm/katex@')
        }
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        onMessage={(e) => {
          const next = Number(e.nativeEvent.data);
          if (Number.isFinite(next) && next > 0) setHeight(Math.min(next + 2, 240));
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { width: '100%', overflow: 'hidden' },
  web: { backgroundColor: 'transparent', flex: 1 },
});
