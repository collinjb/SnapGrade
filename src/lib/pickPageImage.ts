/** Grabbing a one-off page photo outside the main camera screen — currently
 *  just the answer key.
 *
 *  Native hands this to the OS document scanner, which crops and de-skews
 *  the key for free. The web build swaps in a file input. */
import { scanWithNativeScanner } from './nativeScanner';

export interface PickedPage {
  uri: string;
  width: number;
  height: number;
}

/** Returns null when the user backs out. Throws if there is no way to do it. */
export async function pickPageImage(): Promise<PickedPage | null> {
  return scanWithNativeScanner();
}
