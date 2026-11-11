// Treasury FiscalData auctions query -> template data cards for note and bond auction results.
// FiscalData is open ("offered free, without restriction"); the card names the Fiscal Service (rule 8).
// Inputs: API JSON text (values are strings, missing = "null"). Outputs: AuctionResult[] and PublishPayload.
// Field names follow the FiscalData data dictionary for auctions_query; a row without a high yield is an auction
// that has no results yet and is skipped.

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, fmt, shortDate, toNum } from './agencyData.ts';

export interface AuctionResult {
  cusip: string; securityType: string; term: string; auctionDate: string;
  highYield: number; bidToCover: number | null; offeringAmt: number | null; tips: boolean;
}

const AGENCY = 'U.S. Department of the Treasury, Fiscal Service';

export function auctionsUrl(now: Date): string {
  const a = config.agency.auctions;
  const from = new Date(now.getTime() - a.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  return `${config.fiscalData.base}${a.path}?sort=-auction_date&page[size]=${a.pageSize}&filter=auction_date:gte:${from}`;
}

/** JSON -> results of note/bond auctions that have a high yield, newest first. */
export function parseAuctions(json: string): AuctionResult[] {
  const out: AuctionResult[] = [];
  const types = config.agency.auctions.securityTypes;
  for (const r of (JSON.parse(json) as { data?: Record<string, string>[] }).data ?? []) {
    const highYield = toNum(r.high_yield);
    if (highYield === null || !types.includes(r.security_type) || !/^\d{4}-\d{2}-\d{2}$/.test(r.auction_date ?? '') || !r.cusip) continue;
    out.push({
      cusip: r.cusip, securityType: r.security_type, term: (r.security_term ?? '').trim(), auctionDate: r.auction_date,
      highYield, bidToCover: toNum(r.bid_to_cover_ratio), offeringAmt: toNum(r.offering_amt),
      tips: /yes/i.test(r.inflation_index_security ?? ''),
    });
  }
  return out.sort((a, b) => b.auctionDate.localeCompare(a.auctionDate));
}

/** "10-Year" -> "10-year"; null for terms that are not whole years ("52-Week"). */
const termWords = (t: string): string | null => (/^\d+-Year$/i.test(t) ? t.toLowerCase() : null);

export function auctionCard(a: AuctionResult): PublishPayload | null {
  const term = termWords(a.term);
  if (!term || a.tips) return null;
  const kind = a.securityType === 'Bond' ? 'bond' : 'note';
  const day = shortDate(a.auctionDate);
  const headline = `${term[0].toUpperCase()}${term.slice(1)} Treasury ${kind} auction clears at ${fmt(a.highYield, 3)}%`;
  const sold = a.offeringAmt !== null && a.offeringAmt >= 1e9 ? ` The Treasury offered $${fmt(a.offeringAmt / 1e9, 0)} billion.` : '';
  const cover = a.bidToCover !== null ? ` Buyers bid ${fmt(a.bidToCover, 2)} times the amount offered (the bid-to-cover ratio).` : '';
  const body = `The Treasury's ${day} auction of ${term} ${kind}s set a high yield of ${fmt(a.highYield, 3)}%, the highest rate accepted.${sold}${cover}`;
  const at = new Date(`${a.auctionDate}T17:00:00Z`).toISOString();
  return buildAgencyDataCard({
    dedupeKey: `AUCTION_${term.replace("-year","Y").toUpperCase()}_${kind.toUpperCase()}:${a.auctionDate}`, headline, body, category: 'markets', asOf: at,
    agencyName: AGENCY, agencyUrl: 'https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/', docLabel: 'Treasury Securities Auctions Data',
    attribution: config.agency.auctions.attribution,
    paragraphs: [
      body,
      'What this number measures: the interest rate the government agreed to pay to borrow for this term. Auction results show how much investors ask in return for lending to the U.S.',
      'The numbers come from the U.S. Department of the Treasury, Fiscal Service.',
    ],
    keyPoints: [
      `High yield: ${fmt(a.highYield, 3)}%`,
      ...(a.bidToCover !== null ? [`Bid-to-cover ratio: ${fmt(a.bidToCover, 2)}`] : []),
      ...(a.offeringAmt !== null ? [`Offering amount: $${fmt(a.offeringAmt / 1e9, 0)} billion`] : []),
      `Auction date: ${day}`, `Source: ${AGENCY}`,
    ],
  });
}
