// NewsData.io (free plan) -> link-out items. OFF by default (config.newsdata.enabled, env NEWSDATA_ENABLED=1, and the
// database flag core.app_config.linkout_cards); with no NEWSDATA_API_KEY the source does nothing.
// Rule 7: a link-out card is the publisher's headline verbatim (200-char cap), the publisher's URL, "via NewsData.io" and
// "Delayed 12 h". Never a description, content, image or AI text: parseNewsdata keeps only the fields listed in
// NewsdataArticle, so nothing else can reach an item or a card. The article page is never downloaded.
// Standing content rule: only business, macro, markets and investing headlines; recalls and micro-cap news are skipped
// unless a watch-list company is named; advice-like headlines (buy, sell, price target, ...) are skipped.
// Inputs: /latest or /market JSON. Outputs: RawItems (license_class link_out) and link_out publish payloads.

import { config } from '../config.ts';
import type { PublishPayload, RawItem, TickerRef } from '../types.ts';
import { contentWords, findAdvice } from '../validate.ts';

export type NewsdataEndpoint = 'latest' | 'market';

/** The ONLY fields read from the API. description, content, image_url, ai_summary and the rest are never kept. */
export interface NewsdataArticle {
  article_id: string;
  title: string;
  link: string;
  pubDate: string;                   // "2026-11-11 08:30:00" (UTC)
  source_name: string;
  symbols: string[];
}

export type NewsdataSkipReason =
  | 'bad_url' | 'no_title' | 'too_old' | 'off_topic' | 'not_finance' | 'micro_or_recall' | 'advice_language' | 'bad_date';

/** Request URL. The key is in the query string, so callers must never log this URL (use redactKey for messages). */
export function newsdataUrl(endpoint: NewsdataEndpoint, apiKey: string): string {
  const c = config.newsdata;
  const q = new URLSearchParams({ apikey: apiKey, language: c.language, size: String(c.pageSize), removeduplicate: '1' });
  if (endpoint === 'latest') { q.set('category', 'business'); q.set('country', c.country); }
  return `${c.baseUrl}/${endpoint}?${q.toString()}`;
}

/** Removes the key (and the apikey= query value) from a message. */
export function redactKey(message: string, apiKey: string | null | undefined): string {
  let m = message.replace(/apikey=[^&\s]+/gi, 'apikey=[redacted]');
  if (apiKey) m = m.split(apiKey).join('[redacted]');
  return m;
}

const tidy = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** Parses a /latest or /market response. Throws (without the key) on non-JSON or an error status. */
export function parseNewsdata(text: string): NewsdataArticle[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('newsdata: response is not JSON'); }
  const o = j as { status?: unknown; results?: unknown; message?: unknown };
  if (!o || typeof o !== 'object') throw new Error('newsdata: unexpected response');
  if (o.status !== 'success') {
    const msg = tidy((o.results as { message?: unknown } | undefined)?.message ?? o.message).slice(0, 120);
    throw new Error(`newsdata: API status ${String(o.status)}${msg ? ` (${msg})` : ''}`);
  }
  if (!Array.isArray(o.results)) throw new Error('newsdata: no results list');
  const out: NewsdataArticle[] = [];
  for (const r of o.results as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    out.push({
      article_id: tidy(r.article_id),
      title: tidy(r.title),
      link: tidy(r.link),
      pubDate: tidy(r.pubDate),
      source_name: tidy(r.source_name) || tidy(r.source_id),
      symbols: Array.isArray(r.symbol) ? (r.symbol as unknown[]).map((s) => tidy(s).toUpperCase()).filter((s) => /^[A-Z][A-Z.]{0,4}$/.test(s)) : [],
    });
  }
  return out;
}

/** "2026-11-11 08:30:00" (UTC) -> Date, or null. */
function parsePubDate(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  const d = m ? new Date(`${m[1]}T${m[2]}Z`) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}

/** Watch-list tickers (config.cpsc.watchNames) named in the headline: such a company's news counts as material. */
export function watchTickers(title: string): string[] {
  return [...new Set(config.cpsc.watchNames.filter(([pat]) => new RegExp(`\\b(?:${pat})\\b`, 'i').test(title)).map(([, t]) => t))];
}

/** Article -> link-out RawItem, or the reason it is skipped. Pure. */
export function newsdataToItem(a: NewsdataArticle, now: Date): { item: RawItem } | { skip: NewsdataSkipReason } {
  const c = config.newsdata;
  let url: URL;
  try { url = new URL(a.link); } catch { return { skip: 'bad_url' }; }
  if (url.protocol !== 'https:' || /(^|\.)newsdata\.io$/i.test(url.hostname)) return { skip: 'bad_url' };
  if (!a.title) return { skip: 'no_title' };
  const when = parsePubDate(a.pubDate);
  if (!when) return { skip: 'bad_date' };
  if (now.getTime() - when.getTime() > c.maxAgeHours * 3_600_000) return { skip: 'too_old' };
  if (c.offTopicPattern.test(a.title)) return { skip: 'off_topic' };
  if (!c.financePattern.test(a.title)) return { skip: 'not_finance' };
  const watch = watchTickers(a.title);
  if (c.microPattern.test(a.title) && !watch.length) return { skip: 'micro_or_recall' };
  if (findAdvice(a.title).length) return { skip: 'advice_language' };
  const tickers: TickerRef[] = [...new Set([...watch, ...a.symbols])].slice(0, config.maxTickersPerCard).map((symbol) => ({ symbol, name: symbol, exchange: null }));
  return {
    item: {
      source: 'newsdata',
      external_id: a.article_id || url.pathname,
      url: url.toString(),
      title: a.title.slice(0, c.headlineMaxChars),               // verbatim, 200-char safety cap
      published_at: new Date(Math.min(when.getTime(), now.getTime())).toISOString(),
      license_class: 'link_out',
      category: c.category as RawItem['category'],
      event_type: c.eventType,
      tickers,
      source_name: a.source_name || url.hostname.replace(/^www\./, ''),   // the publisher
      source_kind: 'news',
      doc_label: '',
      summary_text: '',                                           // no text is ever kept
      attribution: c.attribution,
    },
  };
}

/** Link-out publish payload: no body, no detail, no AI, one publisher source. */
export function newsdataPayload(item: RawItem, itemId?: string): PublishPayload {
  return {
    dedupe_key: item.url,
    item_id: itemId,
    kind: 'link_out',
    origin: 'newsdata',
    headline: item.title,
    body: null,
    category: item.category,
    event_type: item.event_type,
    ai_generated: false,
    tickers: item.tickers,
    macro: [],
    as_of: item.published_at,
    sort_at: item.published_at,                 // source time, so the 12 h delay makes these sink
    model: null,
    prompt_version: null,
    detail: null,
    everyday_relevance: null,
    attribution: config.newsdata.attribution,
    sources: [{
      name: item.source_name, kind: 'news', doc_label: null, url: item.url,
      published_at: item.published_at, license_class: 'link_out', attribution: config.newsdata.attribution, is_primary: true,
    }],
  };
}

/** True when the headline is (nearly) the same story as one already published: >= 60% of the shorter one's key words are shared. */
export function isNearDuplicate(title: string, existing: readonly string[], min = 0.6): boolean {
  const a = contentWords(title);
  if (a.size < 3) return false;
  for (const e of existing) {
    const b = contentWords(e);
    if (b.size < 3) continue;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let n = 0;
    for (const w of small) if (big.has(w)) n++;
    if (n / small.size >= min) return true;
  }
  return false;
}
