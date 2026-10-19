// App configuration read from EXPO_PUBLIC_* env vars.
// Expo inlines EXPO_PUBLIC_* values at build time only when they are read by their
// full static name, so readEnv() spells each one out. Only public values live here:
// the Supabase URL and the publishable key. Never a secret key.

export const APP_NAME = 'Element'; // working name from the designs; change it here only

export const FEED_PAGE_SIZE = 20; // api.feed clamps p_limit to 10..30
export const MOCK_DELAY_MS = 200; // fake latency in mock mode so loading states are visible
export const MAX_COLUMN_WIDTH = 480; // centered card column on wide screens

export type ApiMode = 'mock' | 'supabase';

export interface RawEnv {
  EXPO_PUBLIC_API_MODE?: string;
  EXPO_PUBLIC_SUPABASE_URL?: string;
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
}

export type ApiConfig = { ok: true; mode: 'mock' } | { ok: true; mode: 'supabase'; url: string; key: string } | { ok: false; error: string };

export function readEnv(): RawEnv {
  return {
    EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
}

// Template values such as "https://your-project.supabase.co" or "<publishable key>".
const PLACEHOLDER = /^(https:\/\/)?(your[-_]|<|changeme)|example\.(com|co)/i;

// Mock is the default so the app runs with no keys. Asking for supabase without a
// usable URL and key is an error, never a silent fallback to sample data.
export function resolveApiConfig(env: RawEnv): ApiConfig {
  const mode = (env.EXPO_PUBLIC_API_MODE ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'mock') return { ok: true, mode: 'mock' };
  if (mode !== 'supabase') {
    return { ok: false, error: `EXPO_PUBLIC_API_MODE must be "mock" or "supabase", got "${mode}".` };
  }
  const url = (env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const key = (env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  const missing: string[] = [];
  if (!/^https:\/\/[^\s/]+/.test(url) || PLACEHOLDER.test(url)) missing.push('EXPO_PUBLIC_SUPABASE_URL');
  if (key === '' || PLACEHOLDER.test(key)) missing.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (key.startsWith('sb_secret_')) {
    return { ok: false, error: 'The app was given a secret key. Use the publishable key only.' };
  }
  if (missing.length > 0) {
    return { ok: false, error: `API mode is "supabase" but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing or a placeholder.` };
  }
  return { ok: true, mode: 'supabase', url, key };
}
