/** Makes the web build installable to the home screen.
 *
 *  The head tags are injected at runtime rather than baked into an HTML
 *  template because Expo owns the document shell for a Metro web export.
 *  That works for both platforms: Android reads the manifest whenever it
 *  re-evaluates installability, and iOS reads the apple-* tags at the moment
 *  the user taps Add to Home Screen — both after this has run. */

const THEME_COLOR = '#000000';

function upsertMeta(name: string, content: string): void {
  let tag = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = name;
    document.head.appendChild(tag);
  }
  tag.content = content;
}

function upsertLink(rel: string, href: string, extra: Record<string, string> = {}): void {
  let tag = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!tag) {
    tag = document.createElement('link');
    tag.rel = rel;
    document.head.appendChild(tag);
  }
  tag.href = href;
  for (const [key, value] of Object.entries(extra)) tag.setAttribute(key, value);
}

/** True when launched from the home screen rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    // iOS Safari predates display-mode and still uses this.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function setupPwa(): void {
  if (typeof document === 'undefined') return;

  upsertLink('manifest', './manifest.json');
  upsertLink('apple-touch-icon', './icons/apple-touch-icon.png', { sizes: '180x180' });
  upsertLink('icon', './icons/favicon-64.png');

  upsertMeta('theme-color', THEME_COLOR);
  upsertMeta('mobile-web-app-capable', 'yes');
  // The Apple-prefixed twin is what actually makes an iOS home-screen launch
  // chromeless; Safari still ignores the standard name.
  upsertMeta('apple-mobile-web-app-capable', 'yes');
  upsertMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  upsertMeta('apple-mobile-web-app-title', 'SnapGrade');

  // viewport-fit=cover lets the camera fill the notch area, and safe-area
  // insets then keep the controls clear of it.
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const wanted =
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  if (viewport) viewport.content = wanted;
  else upsertMeta('viewport', wanted);

  registerServiceWorker();
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const register = () => {
    // A worker needs a secure context and a same-origin script, so this
    // fails on a file:// preview and inside some embedded webviews. That is
    // non-fatal: the app just will not open offline.
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => {
      console.warn('[snapgrade] service worker not registered:', e);
    });
  };

  // React can mount after `load` has already fired, in which case waiting for
  // the event means waiting forever.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
