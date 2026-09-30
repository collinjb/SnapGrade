import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** False when the app was built without Supabase env vars. The app still runs:
 *  scans queue locally and grade calls surface a clear configuration error. */
export const supabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient = createClient(
  url ?? 'https://placeholder.supabase.co',
  anonKey ?? 'placeholder-anon-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // No deep-link auth callbacks in this app.
      detectSessionInUrl: false,
    },
  },
);

// Refresh tokens only while the app is in front, per supabase-js RN guidance.
AppState.addEventListener('change', (state) => {
  if (!supabaseConfigured) return;
  if (state === 'active') void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});

/** Signs in anonymously on first launch so there is zero signup friction.
 *  The same user can later be upgraded to email/Apple with `linkIdentity`
 *  or `updateUser({ email })` without losing any rows. */
export async function ensureSession(): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;

  const { data: signed, error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.warn('[snapgrade] anonymous sign-in failed:', error.message);
    return null;
  }
  return signed.user?.id ?? null;
}

/** Upgrade an anonymous account to a real one. Rows keep the same user_id. */
export async function upgradeToEmail(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.updateUser({ email });
  return { error: error?.message ?? null };
}
