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

export function diversifyFeed(cards: BlurbCard[], options: { maxRun?: 1 | 2; window?: number } = {}): BlurbCard[] {
  const cap = options.maxRun ?? 2, window = Math.max(cap + 1, Math.trunc(options.window ?? 5));
  const remaining = cards.map((card, index) => ({ card, index })), out: BlurbCard[] = [];
  while (remaining.length) {
    const pos = out.length;
    const eligible = (x: typeof remaining[number]) => {
      if (pos - x.index > 6) return false;
      if (pos && out[pos - 1].category === x.card.category) return false;
      const start = Math.max(0, pos - window + 1);
      return out.slice(start).filter((c) => c.category === x.card.category).length < cap;
    };
    let i = remaining.findIndex(eligible);
    // Preserve the window cap even when satisfying the six-place quality bound is impossible.
    if (i < 0) i = remaining.findIndex((x) => {
      const start = Math.max(0, pos - window + 1);
      return out.slice(start).filter((c) => c.category === x.card.category).length < cap && !(pos && out[pos - 1].category === x.card.category);
    });
    if (i < 0) i = 0;
    out.push(remaining.splice(i, 1)[0].card);
  }
  return out;
}
