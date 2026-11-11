// A-17 three-question setup (flag `onboarding`): what you want to follow, how much you invest, how much detail.
// The answers become device settings and follows; nothing is sent anywhere beyond what the account already stores
// (followed topics, when signed in). Pure: no React imports (lib/__tests__/setup.test.ts).

import { FINE_NAMES, FINE_PARENT, LANE_TOPICS, MACRO_FINE, isFineTopic, type FineTopic } from '../topics/fineTopics.ts';
import type { Depth, Signals } from '../signals/signalsLogic.ts';

export type InvestLevel = 'learning' | 'none' | 'some' | 'active';

export interface SetupAnswers {
  topics: string[]; // fine topics, lane topics and plain category slugs mixed
  invest: InvestLevel | null;
  depth: Depth;
}

export const EMPTY_ANSWERS: SetupAnswers = { topics: [], invest: null, depth: 'normal' };

/** Plain categories offered next to the fine topics in question 1. */
export const SETUP_CATEGORIES: { slug: string; name: string }[] = [
  { slug: 'earnings', name: 'Company earnings' },
  { slug: 'deals', name: 'Deals' },
  { slug: 'energy', name: 'Energy' },
  { slug: 'personal-finance', name: 'Your money' },
];

export const INVEST_OPTIONS: { id: InvestLevel; label: string; hint: string }[] = [
  { id: 'learning', label: 'I am learning', hint: 'New to this. Start me with plain money and economy news.' },
  { id: 'none', label: 'Not at all', hint: 'I just want to follow the news that affects me.' },
  { id: 'some', label: 'A little', hint: 'A retirement account or an index fund.' },
  { id: 'active', label: 'I pick investments', hint: 'I follow companies and the market closely.' },
];

export const DEPTH_OPTIONS: { id: Depth; label: string; hint: string }[] = [
  { id: 'short', label: 'Short', hint: 'The headline and the one point that matters.' },
  { id: 'normal', label: 'Normal', hint: 'A few key points on every card.' },
];

/** Categories each investing level adds to the follows (on top of what the reader picked). */
const INVEST_SEEDS: Record<InvestLevel, string[]> = {
  learning: ['personal-finance', 'economy'],
  none: ['personal-finance'],
  some: ['personal-finance', 'markets'],
  active: ['earnings', 'markets'],
};

export interface SetupPlan {
  signals: Signals;
  /** Category slugs to add to the reader's followed topics (the server only knows categories). */
  followTopics: string[];
}

/** Turns the answers into the new signals entry and the categories to follow. Existing choices are kept. */
export function planSetup(a: SetupAnswers, current: Signals, existingFollows: string[] = []): SetupPlan {
  const fine = a.topics.filter(isFineTopic) as FineTopic[];
  const interests = fine.filter((t) => (MACRO_FINE as readonly string[]).includes(t));
  const lanes = fine.filter((t) => (LANE_TOPICS as readonly string[]).includes(t));
  const plain = a.topics.filter((t) => !isFineTopic(t));
  // Lanes are opt-in only (D-121): they are never seeded as a follow, only switched on in the signals entry.
  const parents = interests.map((t) => FINE_PARENT[t]);
  const seeds = a.invest ? INVEST_SEEDS[a.invest] : [];
  const wanted = [...plain, ...parents, ...seeds];
  const followTopics: string[] = [];
  for (const t of wanted) if (!existingFollows.includes(t) && !followTopics.includes(t)) followTopics.push(t);
  const signals: Signals = {
    ...current,
    interests: [...new Set([...current.interests, ...interests])],
    optIn: [...new Set([...current.optIn, ...lanes])],
    depth: a.depth,
    setup: 'done',
  };
  return { signals, followTopics: followTopics.slice(0, 8) };
}

export function skipSetup(current: Signals): Signals {
  return { ...current, setup: 'skipped' };
}

/** The fine topics the reader picked in setup (macro interests first, then opted-in lanes), by display name. */
export function pickedTopicNames(s: Pick<Signals, 'interests' | 'optIn'>): string[] {
  const slugs = [...s.interests, ...s.optIn].filter((t, i, all) => isFineTopic(t) && all.indexOf(t) === i);
  return slugs.map((t) => FINE_NAMES[t as FineTopic]);
}

/** "Rates, Labor and Trade" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The "because you picked" line for For you and Following; null when nothing was picked. */
export function pickedReason(s: Pick<Signals, 'interests' | 'optIn'>): string | null {
  const names = pickedTopicNames(s);
  return names.length ? `Because you picked ${joinNames(names)} in setup.` : null;
}
