/** The OS document scanner (VisionKit / ML Kit) has no web equivalent.
 *
 *  The setting that selects it is disabled in the web build, and the
 *  answer-key screen falls back to the in-app camera. */
export interface NativeScan {
  uri: string;
  width: number;
  height: number;
}

export const nativeScannerAvailable = (): boolean => false;

export async function scanWithNativeScanner(): Promise<NativeScan | null> {
  throw new Error('The system document scanner is only available in the installed app.');
}
