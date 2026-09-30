/** Deciding whether a string needs a real math renderer, and degrading it
 *  readably when one is not available.
 *
 *  Pure, so both the native WebView renderer and the web DOM renderer share
 *  exactly one definition of "is this mathy" — and so the fallback can be
 *  tested without a browser. */

/** LaTeX commands and delimiters worth spinning up a renderer for. */
const MATH_PATTERN =
  /(\$[^$]+\$)|\\\(|\\\[|\\frac|\\sqrt|\\pi|\\times|\\div|\\le|\\ge|\\neq|\\pm|\\cdot|\\sum|\\int|\^\{|_\{/;

export function looksMathy(text: string): boolean {
  return MATH_PATTERN.test(text);
}

/**
 * Strip LaTeX down to something a person can still read.
 *
 * Used when KaTeX cannot load — offline, or behind a network that blocks the
 * CDN. `\frac{3}{4}` becoming `3/4` is worth far more than raw backslash
 * soup, and a teacher can still grade from it.
 */
export function toPlainMath(text: string): string {
  return text
    .replace(/\$\$?/g, '')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
    .replace(/\^\{([^{}]*)\}/g, '^$1')
    .replace(/_\{([^{}]*)\}/g, '_$1')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\cdot/g, '·')
    .replace(/\\pm/g, '±')
    .replace(/\\pi/g, 'π')
    .replace(/\\le(?![a-z])/g, '≤')
    .replace(/\\ge(?![a-z])/g, '≥')
    .replace(/\\neq/g, '≠')
    .replace(/\\left|\\right/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pinned so a CDN change cannot silently alter how a grade renders. */
export const KATEX_VERSION = '0.16.11';
export const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist`;
export const KATEX_CSS = `${KATEX_BASE}/katex.min.css`;
export const KATEX_JS = `${KATEX_BASE}/katex.min.js`;
export const KATEX_AUTORENDER = `${KATEX_BASE}/contrib/auto-render.min.js`;

/** The delimiter set both renderers use. */
export const KATEX_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '$', right: '$', display: false },
  { left: '\\(', right: '\\)', display: false },
  { left: '\\[', right: '\\]', display: true },
];
