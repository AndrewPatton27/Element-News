// Wave 2 feature flags (M9c). Every flag defaults OFF; with all of them off nothing in the app changes.
//
// Turn flags on:
//  - build time: EXPO_PUBLIC_WAVE2_FLAGS=all  or a comma list such as  onboarding,signals  (read by its full
//    static name so Expo inlines it);
//  - tests and demos: in a MOCK build only (EXPO_PUBLIC_API_MODE unset or "mock"), localStorage
//    `element.flags` holds the same text ("all" or a comma list). A live build ignores that key, so a reader can
//    never switch an unfinished feature on in production.
// Pure apart from the store it is given (lib/__tests__/flags.test.ts).

import { defaultStore, type KeyValueStore } from '../storage/storage.ts';

export type FlagName = 'onboarding' | 'signals' | 'since' | 'glossary' | 'topics';
export const FLAG_NAMES: readonly FlagName[] = ['onboarding', 'signals', 'since', 'glossary', 'topics'];
export const FLAGS_OVERRIDE_KEY = 'element.flags';

export type Flags = Record<FlagName, boolean>;
export const ALL_OFF: Flags = { onboarding: false, signals: false, since: false, glossary: false, topics: false };

/** "all" or "a,b" (spaces and case ignored); unknown names are dropped. */
export function parseFlagList(raw: string | null | undefined): Set<FlagName> {
  const out = new Set<FlagName>();
  for (const part of String(raw ?? '').toLowerCase().split(/[,\s]+/)) {
    if (part === 'all') FLAG_NAMES.forEach((n) => out.add(n));
    else if ((FLAG_NAMES as readonly string[]).includes(part)) out.add(part as FlagName);
  }
  return out;
}

export function resolveFlags(o: { env?: string | null; override?: string | null; mock: boolean }): Flags {
  const on = parseFlagList(o.env);
  if (o.mock) parseFlagList(o.override).forEach((n) => on.add(n));
  const flags = { ...ALL_OFF };
  on.forEach((n) => (flags[n] = true));
  return flags;
}

function isMockBuild(): boolean {
  const mode = (process.env.EXPO_PUBLIC_API_MODE ?? '').trim().toLowerCase();
  return mode === '' || mode === 'mock';
}

export function readFlags(store: KeyValueStore = defaultStore()): Flags {
  return resolveFlags({ env: process.env.EXPO_PUBLIC_WAVE2_FLAGS, override: store.get(FLAGS_OVERRIDE_KEY), mock: isMockBuild() });
}

export function flagOn(name: FlagName): boolean {
  return readFlags()[name];
}
