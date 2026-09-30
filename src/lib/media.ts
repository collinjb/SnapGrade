/** Image and file storage, native implementation.
 *
 *  Everything that touches bytes on disk goes through here so the web build
 *  can swap in `media.web.ts` (IndexedDB + object URLs) without any caller
 *  knowing. Native is the straightforward case: real files in the cache
 *  directory, real URIs. */
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** True when `imageUri` values are real file URLs an <Image> can load as-is. */
export const mediaUrisAreDirect = true;

function scratchDir(name: string): Directory {
  const dir = new Directory(Paths.cache, name);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function uniqueName(tag: string): string {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
}

export async function saveJpegBytes(bytes: Uint8Array, tag: string): Promise<string> {
  const file = new File(scratchDir('snapgrade'), uniqueName(tag));
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

/**
 * Store a Blob. Only the web build captures into Blobs, but the function
 * exists on both sides so shared code can call it without a platform check.
 */
export async function saveBlob(blob: Blob, tag: string): Promise<string> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma === -1) reject(new Error('Could not read that image.'));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(blob);
  });

  const file = new File(scratchDir('snapgrade'), uniqueName(tag));
  file.create({ overwrite: true });
  file.write(base64, { encoding: 'base64' });
  return file.uri;
}

export async function readBase64(uri: string): Promise<string | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    return file.base64Sync();
  } catch {
    return null;
  }
}

export async function readBytes(uri: string): Promise<Uint8Array | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    return file.bytesSync();
  } catch {
    return null;
  }
}

export async function mediaExists(uri: string): Promise<boolean> {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export async function removeMedia(uri: string): Promise<void> {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cache eviction already got there, or the path is not ours.
  }
}

/**
 * Resolve a stored URI into something an <Image> can render. Identity on
 * native; the web build has to hand back an object URL.
 */
export async function resolveDisplayUri(uri: string): Promise<string | null> {
  return (await mediaExists(uri)) ? uri : null;
}

/** Write a text file and open the native share sheet. Returns the file URI. */
export async function saveTextAndShare(
  fileName: string,
  text: string,
  mimeType: string,
  dialogTitle: string,
): Promise<string> {
  const file = new File(scratchDir('exports'), fileName);
  file.create({ overwrite: true });
  file.write(text);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType,
      dialogTitle,
      UTI: mimeType === 'text/csv' ? 'public.comma-separated-values-text' : undefined,
    });
  }
  return file.uri;
}
