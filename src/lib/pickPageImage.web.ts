/** Grabbing a one-off page photo on the web.
 *
 *  A file input with `capture="environment"` opens the rear camera directly
 *  on both iOS and Android, and falls back to the photo library on desktop —
 *  which is the closest thing the platform has to the OS document scanner. */
import { saveBlob } from './media';

export interface PickedPage {
  uri: string;
  width: number;
  height: number;
}

function measure(objectUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = objectUrl;
  });
}

export async function pickPageImage(): Promise<PickedPage | null> {
  if (typeof document === 'undefined') return null;

  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';

    let settled = false;
    const finish = (value: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.onchange = () => finish(input.files?.[0] ?? null);
    // There is no reliable cancel event; the window regaining focus is the
    // usual signal, and the grace period keeps it from racing onchange.
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(input.files?.[0] ?? null), 500),
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });

  if (!file) return null;

  const objectUrl = URL.createObjectURL(file);
  const size = await measure(objectUrl);
  URL.revokeObjectURL(objectUrl);

  return { uri: await saveBlob(file, 'key'), ...size };
}
