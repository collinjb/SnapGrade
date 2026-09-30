/** Web: stored pages live in IndexedDB under a `sg://` URI, so they have to
 *  be resolved into an object URL before an <img> can show them. The resolve
 *  is cached in `media.web.ts`, so this settles on the first render and stays
 *  put afterwards. */
import { useEffect, useState } from 'react';
import { resolveDisplayUri } from './media';

export function useImageUri(uri: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (!uri) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    void resolveDisplayUri(uri).then((next) => {
      if (!cancelled) setResolved(next);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return resolved;
}
