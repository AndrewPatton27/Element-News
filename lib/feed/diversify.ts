import type { BlurbCard } from '../../contract/types.ts';

const family = (c: BlurbCard): string => {
  const anyCard = c as BlurbCard & { dedupe_key?: string | null };
  const key = anyCard.dedupe_key;
  return key ? key.replace(/(?:[:/_-](?:\d{4}[-/]?\d{0,2}[-/]?\d{0,2}|\d+))$/, '') : '';
};
const series = (c: BlurbCard) => c.macro.map((m) => m.series_id).filter(Boolean);
const tickerSet = (c: BlurbCard) => c.tickers.map((t) => t.symbol.toUpperCase()).filter(Boolean);
const linked = (a: BlurbCard, b: BlurbCard) => a.id === b.id || a.story_link?.related_id === b.id || b.story_link?.related_id === a.id || (!!a.story_link?.related_id && a.story_link.related_id === b.story_link?.related_id);
const overlaps = (a: string[], b: string[]) => a.some((x) => b.includes(x));
function related(a: BlurbCard, b: BlurbCard): boolean {
  return linked(a, b) || overlaps(tickerSet(a), tickerSet(b)) || overlaps(series(a), series(b)) || (!!family(a) && family(a) === family(b)) ||
    (a.event_type === b.event_type && a.sources.some((s) => b.sources.some((t) => s.name.toLowerCase() === t.name.toLowerCase())));
}

export function pickTopStories(cards: BlurbCard[], n = 5): BlurbCard[] {
  const chosen: BlurbCard[] = [], used = new Set<BlurbCard>();
  const target = Math.max(0, Math.trunc(n));
  for (const c of cards) {
    if (chosen.length >= target) break;
    if (used.has(c) || chosen.some((x) => related(x, c)) || chosen.some((x) => x.category === c.category)) continue;
    chosen.push(c); used.add(c);
  }
  // Preserve hard relation exclusions; relax the category cap only to fill a short list.
  if (chosen.length < target) for (const c of cards) {
    if (chosen.length >= target) break;
    if (used.has(c) || chosen.some((x) => related(x, c))) continue;
    chosen.push(c); used.add(c);
  }
  return chosen;
}

// Trending's category mix. Greedy, one place at a time; at each place the first remaining card (in
// the input order) wins that:
//   1. is at most 6 places later than its input place, is not the previous card's topic, and whose
//      topic appears fewer than `maxRun` times among the last `window - 1` placed cards;
//   2. else the same without the 6-place bound (the window cap still holds);
//   3. else the first remaining card.
// "First remaining with an allowed topic" is the smallest input index over the allowed topics, so each
// topic keeps a pointer to its first candidate and each place costs O(topics), not O(cards): the whole
// pass is O(cards x topics) instead of O(cards^2) (P2-13). Same output as the old list scan
// (lib/__tests__/diversify.test.ts compares them on random feeds).
// `before`: cards already placed ahead of these (kept as they are); they count for the topic rules.
// `topicOf` (default: the category) lets For you treat each macro data series as its own topic (CPI, payrolls, gas).
export function diversifyFeed(cards: BlurbCard[], options: { maxRun?: 1 | 2; window?: number; before?: BlurbCard[]; topicOf?: (c: BlurbCard) => string } = {}): BlurbCard[] {
  const topicOf = options.topicOf ?? ((c: BlurbCard) => c.category);
  const cap = options.maxRun ?? 2, window = Math.max(cap + 1, Math.trunc(options.window ?? 5));
  const span = window - 1; // how many placed cards the window cap looks back at
  const n = cards.length;
  const removed = new Uint8Array(n);
  const byTopic = new Map<string, number[]>();
  cards.forEach((c, i) => { const k = topicOf(c); const list = byTopic.get(k); if (list) list.push(i); else byTopic.set(k, [i]); });
  const topics = [...byTopic.keys()];
  const near = new Map<string, number>(topics.map((t) => [t, 0])); // pointer: first card not removed and not too far behind
  const any = new Map<string, number>(topics.map((t) => [t, 0])); // pointer: first card not removed
  let first = 0; // first card not removed, any topic
  const placed: string[] = (options.before ?? []).slice(-span).map(topicOf);
  const recent = new Map<string, number>();
  for (const t of placed) recent.set(t, (recent.get(t) ?? 0) + 1);
  const out: BlurbCard[] = [];
  for (let pos = 0; pos < n; pos++) {
    const last = placed.length ? placed[placed.length - 1] : null;
    let pick = -1;
    // 1. allowed topic, within six places
    for (const t of topics) {
      if (t === last || (recent.get(t) ?? 0) >= cap) continue;
      const list = byTopic.get(t)!;
      let k = near.get(t)!;
      while (k < list.length && (removed[list[k]] || pos - list[k] > 6)) k++;
      near.set(t, k);
      if (k < list.length && (pick < 0 || list[k] < pick)) pick = list[k];
    }
    // 2. allowed topic, any distance (preserve the window cap when the six-place bound cannot hold)
    if (pick < 0) for (const t of topics) {
      if (t === last || (recent.get(t) ?? 0) >= cap) continue;
      const list = byTopic.get(t)!;
      let k = any.get(t)!;
      while (k < list.length && removed[list[k]]) k++;
      any.set(t, k);
      if (k < list.length && (pick < 0 || list[k] < pick)) pick = list[k];
    }
    // 3. the first remaining card
    if (pick < 0) {
      while (removed[first]) first++;
      pick = first;
    }
    removed[pick] = 1;
    const card = cards[pick];
    out.push(card);
    const key = topicOf(card);
    placed.push(key);
    recent.set(key, (recent.get(key) ?? 0) + 1);
    if (placed.length > span) {
      const gone = placed[placed.length - 1 - span];
      recent.set(gone, recent.get(gone)! - 1);
    }
  }
  return out;
}

/** Cards from the end of the loaded list that a new page may still mix with. */
export const DIVERSIFY_TAIL = 30;

/**
 * Trending paging: `next` is `prev` with a new page appended (lib/feed/feedLogic.ts appendPage). Only the
 * last DIVERSIFY_TAIL cards of `prev` plus the new cards are re-mixed; everything before stays where it is
 * and counts as context for the topic rules. Each page costs O(tail + page), not O(whole list) (P2-13).
 */
export function diversifyAppend(prev: BlurbCard[], next: BlurbCard[], tail: number = DIVERSIFY_TAIL): BlurbCard[] {
  const cut = Math.max(0, prev.length - Math.max(0, Math.trunc(tail)));
  if (cut === 0) return diversifyFeed(next);
  const frozen = next.slice(0, cut);
  return frozen.concat(diversifyFeed(next.slice(cut), { before: frozen.slice(-8) }));
}
