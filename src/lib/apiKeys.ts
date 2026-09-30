/** Where the user's own API key lives.
 *
 *  Deliberately kept out of the zustand store: the store is serialised in
 *  full for persistence and passed around freely, and a credential should
 *  not ride along with it into a log line or an export. This module is the
 *  only thing that reads or writes it.
 *
 *  The key sits in device storage — MMKV on a phone, localStorage in a
 *  browser. That is the trade for having no backend: it is the user's own
 *  key on the user's own device, never sent anywhere except the provider. */
import { kv } from './storage';
import type { ProviderId } from './grading/provider';

const keyFor = (provider: ProviderId): string => `apiKey:${provider}`;

export function getApiKey(provider: ProviderId): string {
  return kv.getString(keyFor(provider))?.trim() ?? '';
}

export function setApiKey(provider: ProviderId, key: string): void {
  const trimmed = key.trim();
  if (trimmed) kv.set(keyFor(provider), trimmed);
  else kv.delete(keyFor(provider));
}

export function hasApiKey(provider: ProviderId): boolean {
  return getApiKey(provider).length > 0;
}

export function clearApiKey(provider: ProviderId): void {
  kv.delete(keyFor(provider));
}

/** Masked form for display, so a shoulder-surfer gets nothing useful. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 6)}${'•'.repeat(10)}${key.slice(-4)}`;
}
