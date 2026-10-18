// Template cards: no AI. Built only from feed metadata (company, 8-K item numbers,
// press-release title), so they are always truthful. ai_generated = false.
// Inputs: SummarizeInput (only the item's metadata is read). Outputs: a SummaryDraft.

import { config } from '../config.ts';
import { sentenceCase } from '../text.ts';
import type { SummarizeInput, Summarizer, SummaryDraft } from '../types.ts';

/** Short label for headlines and a plain explanation for the body, per 8-K item. */
export const ITEM_TEXT: Record<string, { short: string; explain: string }> = {
  '1.01': { short: 'material agreement', explain: 'entering a major agreement' },
  '1.02': { short: 'agreement ended', explain: 'ending a major agreement' },
  '1.03': { short: 'bankruptcy or receivership', explain: 'a bankruptcy or receivership' },
  '1.05': { short: 'cybersecurity incident', explain: 'a material cybersecurity incident' },
  '2.01': { short: 'acquisition or sale completed', explain: 'completing an acquisition or a sale of assets' },
  '2.02': { short: 'results of operations', explain: 'quarterly or annual results' },
  '2.05': { short: 'exit or restructuring costs', explain: 'costs of exiting a business or restructuring' },
  '2.06': { short: 'material impairment', explain: 'a large write-down of assets' },
  '3.01': { short: 'listing rule notice', explain: 'a notice that the company no longer meets an exchange listing rule' },
  '4.01': { short: 'auditor change', explain: 'a change of outside auditor' },
  '4.02': { short: 'non-reliance on prior financials', explain: 'earlier financial statements that can no longer be relied on' },
  '5.02': { short: 'officer or director change', explain: 'changes in directors or senior officers' },
  '7.01': { short: 'Regulation FD disclosure', explain: 'information shared with investors under Regulation FD' },
  '8.01': { short: 'other events', explain: 'other events the company chooses to report' },
  '9.01': { short: 'financial statements and exhibits', explain: 'attached financial statements and exhibits' },
};

/**
 * Plain-language card text per 8-K item (8th-grade reading level, no jargon). The pipeline only
 * publishes template cards for watch-list companies and config.templateSecItems; other items fall
 * back to ITEM_TEXT wording.
 */
const PLAIN_ITEM: Record<string, { headline: (co: string) => string; body: (co: string) => string }> = {
  '2.02': {
    headline: (co) => `${co} shares its latest financial results`,
    body: (co) => `${co} sent the SEC a report on its latest results, like sales and profit. Open the filing to see the numbers.`,
  },
  '5.02': {
    headline: (co) => `${co} reports a change in its top leaders`,
    body: (co) => `${co} told the SEC about a change among its top leaders. Open the filing to see who is coming or going.`,
  },
  '1.05': {
    headline: (co) => `${co} reports a cybersecurity incident`,
    body: (co) => `${co} told the SEC about a serious cybersecurity incident, such as a hack. Open the filing for details.`,
  },
  '4.02': {
    headline: (co) => `${co} says some past financial reports were wrong`,
    body: (co) => `${co} told the SEC that some earlier financial reports can no longer be trusted and must be fixed. Open the filing for details.`,
  },
  '2.05': {
    headline: (co) => `${co} reports costs to cut back part of its business`,
    body: (co) => `${co} told the SEC it expects costs from cutting back or closing part of its business. This kind of filing covers costs like layoffs or closing sites.`,
  },
};

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}

/**
 * A short agency name for a plain Federal Register headline. The full official name is replaced by
 * a short, recognizable one; anything unknown falls back to "A federal agency".
 */
function shortAgency(agency: string | null | undefined): string {
  const a = (agency ?? '').toLowerCase();
  if (/federal aviation|\bfaa\b/.test(a)) return 'The FAA';
  if (/transportation/.test(a)) return 'The Transportation Dept.';
  if (/consumer financial/.test(a)) return 'The CFPB';
  if (/federal trade/.test(a)) return 'The FTC';
  if (/internal revenue|\birs\b/.test(a)) return 'The IRS';
  if (/securities and exchange|\bsec\b/.test(a)) return 'The SEC';
  if (/federal communications|\bfcc\b/.test(a)) return 'The FCC';
  if (/federal reserve/.test(a)) return 'The Federal Reserve';
  if (/treasury|fiscal service/.test(a)) return 'The Treasury Dept.';
  if (/energy/.test(a)) return 'The Energy Dept.';
  if (/education/.test(a)) return 'The Education Dept.';
  return 'A federal agency';
}

/**
 * Plain Federal Register headline: never the raw official document title (which starts with phrases
 * like "Airworthiness Directives;" or long section citations). Says, in plain words, who made a rule
 * and what it is about. No docket, item or section numbers, no long official title.
 */
function fedRegHeadline(title: string, agency: string | null | undefined): string {
  const t = (title ?? '').trim();
  const who = shortAgency(agency);
  // Airworthiness Directives: a safety fix order for aircraft. Name the planemaker if the title does.
  if (/^airworthiness directives/i.test(t)) {
    const maker = /boeing/i.test(t) ? 'Boeing' : /airbus/i.test(t) ? 'Airbus' : /bombardier/i.test(t) ? 'Bombardier'
      : /embraer/i.test(t) ? 'Embraer' : /cessna|textron/i.test(t) ? 'Cessna' : null;
    const planes = maker ? `${maker} planes` : 'certain planes';
    return cutAtWord(`${who === 'A federal agency' ? 'The FAA' : who} issues a safety order for ${planes}`, config.headlineMaxChars);
  }
  // Delay / extension of an effective date.
  if (/delay of effective date|delays? the effective date|extension of (the )?compliance/i.test(t)) {
    return cutAtWord(`${who} delays a rule's start date`, config.headlineMaxChars);
  }
  // Civil penalties / fines.
  if (/civil penalt/i.test(t)) {
    return cutAtWord(`${who} sets new penalties under a rule`, config.headlineMaxChars);
  }
  // Default: a plain "issues a new rule" line (the body and detail carry the agency and date).
  return cutAtWord(`${who} issues a new federal rule`, config.headlineMaxChars);
}

/** Template draft per source: plain 8-K wording, a plain Federal Register headline, or the Fed/BEA release title. */
export function templateDraft(input: SummarizeInput): SummaryDraft {
  const it = input.item;
  if (it.source === 'sec_8k') {
    const items = it.items ?? [];
    const main = items[0];
    const company = it.company ?? 'A company';
    const plain = PLAIN_ITEM[main?.number ?? ''];
    const t = ITEM_TEXT[main?.number] ?? { short: 'filing', explain: 'a reportable event' };
    const headline = cutAtWord(plain ? plain.headline(company) : `${company} reports ${t.explain}`, config.headlineMaxChars);
    const body = plain ? plain.body(company) : `${company} told the SEC about ${t.explain}. Open the filing for details.`;
    return { headline, body, category: it.category, event_type: it.event_type, tickers: it.tickers.map((x) => x.symbol) };
  }
  if (it.source === 'fedreg') {
    // Plain headline (never the raw official rule title); the body and detail carry the specifics.
    return {
      headline: fedRegHeadline(it.title, it.agency),
      // Not published by the pipeline (no relevance score without the AI); kept for completeness.
      body: `${it.agency ?? 'A federal agency'} published this final rule in the Federal Register. Open the source for the full text.`,
      category: it.category,
      event_type: null,
      tickers: [],
    };
  }
  if (it.source === 'cpsc') {
    // Never published by the pipeline (no relevance score without the AI). Generic on purpose: the recall
    // title is full of brand names, model numbers, SKUs and Title Case, none of which belong in a headline.
    return {
      headline: 'A product recall was announced',
      body: `${config.cpsc.sourceName} announced a product recall. Open the source to see which product it covers and what to do.`,
      category: it.category,
      event_type: it.event_type,
      tickers: [],
    };
  }
  // Federal Reserve or BEA release: the public-domain title is the headline, in sentence case
  // (only everyday words are lowercased; names and acronyms keep their capitals).
  return {
    headline: cutAtWord(sentenceCase(it.title), config.headlineMaxChars),
    body: it.source === 'bea_rss'
      ? 'The U.S. Bureau of Economic Analysis, the government office that tracks the economy, posted this report. Open the source to read it.'
      : 'The Federal Reserve, the central bank that sets U.S. interest rates, posted this news. Open the source to read it.',
    category: it.category,
    event_type: it.event_type,
    tickers: [],
  };
}

/** The last-resort summarizer in the chain: never calls an AI. */
export const templateSummarizer: Summarizer = {
  name: 'template',
  usesAi: false,
  async summarize(input) {
    return templateDraft(input);
  },
};
