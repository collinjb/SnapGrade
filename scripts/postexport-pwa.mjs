/**
 * Patches the exported index.html with the tags that make the app
 * installable.
 *
 *   node scripts/postexport-pwa.mjs [dist-dir]
 *
 * `src/lib/pwa.web.ts` injects the same tags at runtime, which covers the dev
 * server. This script puts them in the document itself so the *deployed*
 * build does not depend on JavaScript having run first — Chrome weighs the
 * manifest when deciding whether to offer an install, and a page that fails
 * to boot should still be addable to the home screen.
 *
 * Safe to run twice: it removes its own block before re-adding it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.cwd(), process.argv[2] ?? 'dist');
const indexPath = resolve(dist, 'index.html');

if (!existsSync(indexPath)) {
  console.error(`postexport-pwa: no index.html in ${dist}. Run the web export first.`);
  process.exit(1);
}

const START = '<!-- snapgrade:pwa -->';
const END = '<!-- /snapgrade:pwa -->';

const BLOCK = `${START}
    <link rel="manifest" href="./manifest.json" />
    <link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="64x64" href="./icons/favicon-64.png" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="SnapGrade" />
    ${END}`;

let html = readFileSync(indexPath, 'utf8');

// Drop any previous run's block.
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from !== -1 && to !== -1) html = html.slice(0, from) + html.slice(to + END.length);

// The camera needs to reach under the notch, and the controls then sit on
// the safe-area insets. Expo's default viewport has neither.
html = html.replace(
  /<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />',
);

if (!html.includes('</head>')) {
  console.error('postexport-pwa: index.html has no </head>; nothing was changed.');
  process.exit(1);
}

html = html.replace('</head>', `  ${BLOCK}\n  </head>`);
writeFileSync(indexPath, html);

console.log(`postexport-pwa: patched ${indexPath}`);
