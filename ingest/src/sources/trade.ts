// Federal Register trade documents (JSON API, no key) -> template cards (no AI, no abstract, no page download).
// Agencies: USTR (Section 301 and 232 tariff actions, product exclusions), Commerce BIS (export controls, Section 232 notices).
// Reuse permitted (1 CFR 2.6, same basis as fedreg.ts). The headline is built from a fixed phrase plus a country name found in
// the title; the document title is quoted in the body (public-domain copy limit 25 words, shortened at a word boundary).
// Never read: Treasury/OFAC ("Notice of OFAC Sanctions Action" titles have no content) and ITA antidumping notices (micro news).
// Inputs: documents.json responses. Outputs: TradeDoc list, PublishPayload | null. Key: FRTRADE:<document number> (one card each).

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, shortDate } from './agencyData.ts';
import { parseFedRegJson, type FrDoc } from './fedreg.ts';

export const TRADE_FIELDS = ['title', 'type', 'html_url', 'publication_date', 'agencies', 'document_number'];

export function tradeUrl(now: Date): string {
  const c = config.agency.trade;
  const from = new Date(now.getTime() - c.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const q = [`per_page=${c.perPage}`, 'order=newest', `conditions[publication_date][gte]=${from}`,
    ...c.agencies.map((a) => `conditions[agencies][]=${a}`), ...TRADE_FIELDS.map((f) => `fields[]=${f}`)];
  return `${c.endpoint}?${q.join('&')}`;
}

export function parseTrade(json: string): FrDoc[] { return parseFedRegJson(json); }

interface Agency { short: string; full: string; slug: string }
const USTR: Agency = { short: 'USTR', full: 'Office of the U.S. Trade Representative', slug: 'trade-representative-office-of-united-states' };
const BIS: Agency = { short: 'Commerce', full: 'Bureau of Industry and Security (U.S. Department of Commerce)', slug: 'industry-and-security-bureau' };
const ITA: Agency = { short: 'Commerce', full: 'International Trade Administration (U.S. Department of Commerce)', slug: 'international-trade-administration' };

const slugsOf = (d: FrDoc): string[] => (d.agencies ?? []).map((a) => String((a as { slug?: string }).slug ?? ''));
export function agencyOf(d: FrDoc): Agency | null {
  const s = slugsOf(d);
  if (s.includes(USTR.slug)) return USTR;
  if (s.includes(BIS.slug)) return BIS;
  if (s.includes(ITA.slug)) return ITA;
  return null;
}

const COUNTRIES = ['China', 'Vietnam', 'Brazil', 'Nicaragua', 'Mexico', 'Canada', 'India', 'Japan', 'Korea', 'Indonesia', 'Thailand', 'Russia', 'Taiwan', 'Malaysia', 'Cambodia', 'the European Union'];
const country = (title: string): string | null => {
  const hit = COUNTRIES.find((c) => new RegExp(`\\b${c.replace(/^the /, '')}`, 'i').test(title));
  return hit ?? null;
};

/** What the document is, in a phrase for the headline; null = not material, skip it. */
export function tradeAction(d: FrDoc): { verb: string; tag: string } | null {
  const a = agencyOf(d);
  const t = d.title;
  if (!a) return null;
  if (/information collection|paperwork reduction|submission to the office of management|performance review board|privacy act/i.test(t)) return null;
  if (a === USTR) {
    if (/exclusion/i.test(t)) return { verb: 'extends tariff exclusions', tag: 'exclusions' };
    if (/modification/i.test(t) && /section 301/i.test(t)) return { verb: 'changes its Section 301 tariff action', tag: 'section301' };
    if (/extend.*section 301|section 301.*extend/i.test(t)) return { verb: 'extends a Section 301 trade investigation', tag: 'section301' };
    if (/initiation.*section 301|section 301.*initiation|institution of .*section 301/i.test(t)) return { verb: 'opens a Section 301 trade investigation', tag: 'section301' };
    if (/request for comments/i.test(t) && /section 301|section 232|tariff|exclusion/i.test(t)) return { verb: 'asks for comments on a tariff action', tag: 'comments' };
    if (/section 301|section 232|section 201|safeguard|tariff|reciprocal|trade agreement|determination/i.test(t) && !/performance review|privacy|advisory committee/i.test(t)) return { verb: 'publishes a trade action', tag: 'action' };
    return null;
  }
  if (a === BIS) {
    if (/section 232/i.test(t)) return { verb: 'publishes a Section 232 tariff notice', tag: 'section232' };
    if (d.type !== 'Rule' && d.type !== 'Proposed Rule') return null;           // denial orders and license notices are single companies
    if (/entity list/i.test(t)) return { verb: 'changes its export blacklist', tag: 'entity' };
    if (/export administration|export control|end-user|advanced computing|semiconductor|license requirement/i.test(t)) return { verb: 'changes export controls', tag: 'export' };
    return null;
  }
  // ITA: only a tariff or Section 232 notice, never the antidumping stream
  if (/section 232|steel and aluminum derivative|inclusions? process/i.test(t) && !/antidumping|countervailing/i.test(t)) return { verb: 'publishes a Section 232 tariff notice', tag: 'section232' };
  return null;
}

/** Documents that make a card, newest first, unique by document number, within the lookback window. */
export function selectTrade(docs: FrDoc[], now: Date): { doc: FrDoc; verb: string; tag: string }[] {
  const oldest = now.getTime() - config.agency.trade.lookbackDays * 86_400_000;
  const seen = new Set<string>();
  const out: { doc: FrDoc; verb: string; tag: string }[] = [];
  for (const doc of [...docs].sort((a, b) => b.publication_date.localeCompare(a.publication_date))) {
    if (seen.has(doc.document_number) || Date.parse(`${doc.publication_date}T00:00:00Z`) < oldest) continue;
    seen.add(doc.document_number);
    const act = tradeAction(doc);
    if (act) out.push({ doc, ...act });
  }
  return out;
}

const clip = (title: string, maxWords: number): string => {
  const w = title.replace(/\s+/g, ' ').trim().split(' ');
  return w.length <= maxWords ? w.join(' ') : `${w.slice(0, maxWords).join(' ')} ...`;
};

export function tradeCard(doc: FrDoc, verb: string, now: Date): PublishPayload | null {
  const a = agencyOf(doc);
  if (!a) return null;
  let url: URL;
  try { url = new URL(doc.html_url); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'www.federalregister.gov') return null;
  const c = config.agency.trade;
  const who = country(doc.title);
  const headline = `${a.short} ${verb}${who && !/trade action|export blacklist|export controls/.test(verb) ? ` for ${who}` : ''}`.slice(0, config.headlineMaxChars);
  const title = clip(doc.title, c.maxTitleWords);
  const date = shortDate(doc.publication_date);
  const body = `The ${a.full} published a notice in the Federal Register on ${date}. Its title reads: "${title}"`;
  const at = new Date(`${doc.publication_date}T12:00:00Z`);
  const asOf = new Date(Math.min(at.getTime(), now.getTime())).toISOString();
  const attribution = `${c.attributionPrefix}, ${a.full}`;
  return {
    ...buildAgencyDataCard({
      dedupeKey: `FRTRADE:${doc.document_number}`, headline, body, category: 'policy', asOf,
      agencyName: a.full, agencyUrl: url.toString(), docLabel: doc.type === 'Rule' ? 'Rule' : 'Notice', attribution,
      paragraphs: [
        body,
        'What this means: tariffs and export controls change what imported goods cost and which products can be sold abroad. The notice sets out the legal detail; the Federal Register page has the full text.',
        `The notice comes from the ${a.full}.`,
      ],
      keyPoints: [`Agency: ${a.full}`, `Published: ${date}`, `Type: ${doc.type ?? 'Notice'}`, 'Full text: Federal Register page', `Source: Federal Register (National Archives)`],
    }),
    kind: 'summary',                       // an event, not a data series: unique key, never superseded
    event_type: null,
  };
}
