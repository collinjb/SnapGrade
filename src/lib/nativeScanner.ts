/** The "native" capture engine: the OS document scanner.
 *
 *  react-native-document-scanner-plugin wraps VisionKit on iOS and the ML Kit
 *  Document Scanner on Android. Both give best-in-class auto-capture and true
 *  perspective correction for free, at the cost of a modal OS UI instead of
 *  our own camera. Offered in Settings as the reliable option when the in-app
 *  detector struggles with a particular room's lighting, and used for
 *  photographing an answer key. */
import { Image } from 'react-native';

type ScannerModule = typeof import('react-native-document-scanner-plugin');

export interface NativeScan {
  uri: string;
  width: number;
  height: number;
}

function loadScanner(): ScannerModule | null {
  try {
    // Required lazily so a dev build without the native module degrades
    // instead of crashing at import time.
    return require('react-native-document-scanner-plugin') as ScannerModule;
  } catch {
    return null;
  }
}

export const nativeScannerAvailable = (): boolean =>
  typeof loadScanner()?.default?.scanDocument === 'function';

/** Measure an image file so the results overlay knows its aspect ratio. */
function measure(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve({ width: 0, height: 0 }),
    );
  });
}

/**
 * Open the OS scanner and return the single cropped page.
 *
 * Returns null when the user cancels. Throws when the plugin is missing from
 * this build, so callers can say so rather than appearing to do nothing.
 */
export async function scanWithNativeScanner(): Promise<NativeScan | null> {
  const scanner = loadScanner()?.default;
  if (typeof scanner?.scanDocument !== 'function') {
    throw new Error(
      'The system document scanner is not in this build. Rebuild the dev client with react-native-document-scanner-plugin.',
    );
  }

  const { scannedImages } = await scanner.scanDocument({
    croppedImageQuality: 85,
    maxNumDocuments: 1,
  });

  const first = scannedImages?.[0];
  if (!first) return null; // user backed out

  const uri = first.startsWith('file://') ? first : `file://${first}`;
  return { uri, ...(await measure(uri)) };
}
