// Factual in-depth summaries for template cards (no AI). Built only from structured fields that
// the card already shows (company, 8-K items, agency, title, date, quake data), plus fixed plain
// explanations of what an agency or a filing type is. No new facts, no advice, no predictions.
// Inputs: a RawItem. Outputs: a CardDetail (paragraphs + key points) or null.

import type { CardDetail } from '../../contract/types.ts';
import { config } from './config.ts';
import { ITEM_TITLE_BY_NUMBER } from './sources/sec.ts';
import { ITEM_TEXT } from './summarizer/template.ts';
import type { RawItem } from './types.ts';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => { const d = new Date(iso); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };

/** Cuts a key point to the word limit (adds an ellipsis when cut). */
function shortPoint(s: string, max: number = config.detail.keyPointMaxWords): string {
  const w = s.trim().split(/\s+/);
  return w.length <= max ? w.join(' ') : `${w.slice(0, max - 1).join(' ')}…`;
}

function agencyIntro(it: RawItem): string {
  switch (it.source) {
    case 'fed_rss': return 'The Federal Reserve is the U.S. central bank. It sets key interest rates and watches over banks.';
    case 'bea_rss': return 'The U.S. Bureau of Economic Analysis is the government office that measures the economy, such as GDP and trade.';
    case 'fedreg': return 'The Federal Register is the government\'s daily journal, where agencies publish their official rules.';
    case 'nasa': return 'NASA is the U.S. space agency.';
    case 'cpsc': return 'The U.S. Consumer Product Safety Commission is the agency that watches over the safety of products people buy.';
    default: return '';
  }
}

/** Detail for a template card, or null when there is nothing factual to add. */
export function templateDetail(it: RawItem): CardDetail | null {
  if (it.source === 'sec_8k') {
    const items = (it.items ?? []).filter((i) => i.number !== '9.01');
    const main = items[0];
    if (!main) return null;
    const co = it.company ?? it.tickers[0]?.name ?? 'The company';
    const title = ITEM_TITLE_BY_NUMBER[main.number] ?? main.title;
    const explain = ITEM_TEXT[main.number]?.explain ?? 'a reportable event';
    const others = items.slice(1).map((i) => `Item ${i.number}`);
    return {
      paragraphs: [
        `${co} sent a report called a Form 8-K to the SEC, the U.S. agency that oversees companies whose stock is sold to the public. Companies file one when something important happens.`,
        `This report is filed under Item ${main.number} ("${title}"), which covers ${explain}.${others.length ? ` It also lists ${others.join(' and ')}.` : ''} The full details are in the filing linked below.`,
      ],
      key_points: [
        shortPoint(`Company: ${co}`),
        `Filed with the SEC on ${day(it.published_at)}`,
        shortPoint(`Main topic: ${explain}`),
      ],
    };
  }
  if (it.source === 'usgs') {
    const d = JSON.parse(it.summary_text) as { mag: number; place: string | null; time: number; alert: string | null };
    const t = new Date(d.time);
    const when = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC on ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`;
    const where = d.place ?? 'an unnamed location';
    const paragraphs = [
      `A magnitude ${d.mag.toFixed(1)} earthquake happened ${/^\d/.test(where) ? '' : 'in the '}${where} at ${when}.`,
      `Magnitude measures how much energy an earthquake releases. A higher number means a stronger quake.${d.alert ? ` The USGS alert level was ${d.alert}, on its scale for expected damage that runs from green to red.` : ''}`,
      'The data comes from the U.S. Geological Survey.',
    ];
    const key_points = [`Magnitude ${d.mag.toFixed(1)}`, shortPoint(`Location: ${where}`), `Time: ${when}`];
    if (d.alert) key_points.push(`USGS alert level: ${d.alert}`);
    return { paragraphs, key_points };
  }
  const intro = agencyIntro(it);
  if (!intro) return null;
  return {
    paragraphs: [
      `${it.agency ?? it.source_name} published "${it.title}" on ${day(it.published_at)}.`,
      `${intro} The full text is linked below.`,
    ],
    key_points: [
      shortPoint(`From: ${it.agency ?? it.source_name}`),
      `Published: ${day(it.published_at)}`,
      shortPoint(`Title: ${it.title}`),
    ],
  };
}
