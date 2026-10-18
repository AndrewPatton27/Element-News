// Composes the brief email (HTML + plain text) and the confirmation email. Pure: no network, no files.
// HTML is a 600 px table layout with inline CSS only (renders in Gmail and Outlook), light theme
// (teal #0B6B5D on #F5F6F2). All text is escaped; links must be https or they are left out.
// Sections: summary (+ AI label), top stories, Markets, stories by topic (breadth: many topics, few
// stories each), numbers to know (green / red / gray), then the footer: AI label, "Informational only
// · Not investment advice", postal line, Unsubscribe and Change your time links.
// The number tone map below is a COPY of lib/numberTone.ts (ingest never imports app code).
// Inputs: the brief JSON (+ stored summary), the subscription token, the postal line.
// Outputs: { subject, html, text, headers } with List-Unsubscribe and List-Unsubscribe-Post.

import { config } from './config.ts';
import type { BriefInput, BriefKind } from './briefSummary.ts';
import { localParts } from './briefTime.ts';
import type { BlurbCard, MacroFact } from '../../contract/types.ts';

export const DISCLAIMER = 'Informational only · Not investment advice';
export const AI_LABEL = 'AI-generated summary · may contain errors';

// ---- tone (copy of lib/numberTone.ts + lib/theme.ts colors) ---------------------------------

export type Tone = 'good' | 'bad' | 'neutral';
/** How an INCREASE is judged. Series not listed (rates, oil, ...) are neutral. Keep in step with lib/numberTone.ts. */
const INCREASE_JUDGED: Readonly<Record<string, 'good' | 'bad'>> = {
  CPIAUCSL: 'bad', UNRATE: 'bad', ICSA: 'bad', GASREGW: 'bad',
  PAYEMS: 'good', RSAFS: 'good', HOUST: 'good', A191RL1Q225SBEA: 'good',
};

/** Tone of a change; 'flat', null and unknown series are neutral. */
export function numberTone(seriesId: string, direction: MacroFact['direction'] | undefined): Tone {
  if (direction !== 'up' && direction !== 'down') return 'neutral';
  const judged = Object.prototype.hasOwnProperty.call(INCREASE_JUDGED, seriesId) ? INCREASE_JUDGED[seriesId] : null;
  if (!judged) return 'neutral';
  if (direction === 'up') return judged;
  return judged === 'good' ? 'bad' : 'good';
}

const C = {
  bg: '#F5F6F2', surface: '#FFFFFF', surfaceMuted: '#F1F4EF', ink: '#14211C', body: '#24322B', muted: '#56635B',
  border: '#E1E6DE', divider: '#E7EBE4', accent: '#0B6B5D', accentSoft: '#DCEEE9', accentInk: '#0A5A4E', onAccent: '#FFFFFF',
  good: '#1B6B34', bad: '#B3261E', flat: '#56635B',
};
export const TONE_COLOR: Record<Tone, string> = { good: C.good, bad: C.bad, neutral: C.flat };
const FONT = "Arial,Helvetica,sans-serif";

// ---- helpers -------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escapes text for HTML (element content and attribute values). */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The URL if it is a valid https URL without credentials, else null (the link is left out). */
export function httpsUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && !p.username && !p.password ? p.toString() : null;
  } catch {
    return null;
  }
}

function checkToken(token: string): string {
  if (!UUID.test(token)) throw new Error('subscription token must be a uuid');
  return token.toLowerCase();
}

const site = (path = '') => `${config.mail.siteUrl}${path}`;
export const unsubscribeUrl = (token: string) => site(`/unsubscribe?token=${checkToken(token)}`);
export const manageUrl = (token: string) => site(`/brief?manage=${checkToken(token)}`);
export const confirmUrl = (token: string) => site(`/confirm?token=${checkToken(token)}`);

const oneLine = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function a(url: string | null, label: string, style = `color:${C.accent};text-decoration:underline;`): string {
  return url ? `<a href="${esc(url)}" style="${style}">${esc(label)}</a>` : esc(label);
}

/** Link to a card on the site (share page), or null. */
function cardUrl(c: BlurbCard): string | null {
  if (typeof c.share_path === 'string' && /^\/[A-Za-z0-9/_-]+$/.test(c.share_path)) return httpsUrl(site(c.share_path));
  return null;
}

function primarySource(c: BlurbCard): { name: string; label: string; url: string | null } | null {
  const s = c.sources?.[0];
  if (!s) return null;
  return { name: s.name, label: s.doc_label ? `${s.name} · ${s.doc_label}` : s.name, url: httpsUrl(s.url) };
}

// ---- layout pieces ------------------------------------------------------------------------

const sectionTitle = (t: string) =>
  `<tr><td style="padding:22px 24px 6px 24px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${C.accent};">${esc(t)}</td></tr>`;

function cardRow(c: BlurbCard): string {
  const link = cardUrl(c);
  const src = primarySource(c);
  const head = link
    ? `<a href="${esc(link)}" style="color:${C.ink};text-decoration:none;">${esc(oneLine(c.headline))}</a>`
    : esc(oneLine(c.headline));
  const body = c.body ? `<div style="font-family:${FONT};font-size:14px;line-height:21px;color:${C.body};padding-top:4px;">${esc(oneLine(c.body))}</div>` : '';
  const meta: string[] = [];
  if (src) meta.push(`Source: ${a(src.url, src.label)}`);
  if (link) meta.push(a(link, 'Read in Element'));
  if (c.ai?.generated) meta.push('AI-generated summary');
  return `<tr><td style="padding:10px 24px;border-top:1px solid ${C.divider};">`
    + `<div style="font-family:${FONT};font-size:16px;line-height:22px;font-weight:bold;color:${C.ink};">${head}</div>${body}`
    + `<div style="font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};padding-top:5px;">${meta.join(' · ')}</div>`
    + `</td></tr>`;
}

const GLYPH: Record<string, string> = { up: '▲', down: '▼', flat: '■' };
const WORD: Record<string, string> = { up: 'up', down: 'down', flat: 'unchanged' };

function numbersTable(nums: MacroFact[]): string {
  const rows = nums.map((n) => {
    const tone = numberTone(n.series_id, n.direction);
    const color = TONE_COLOR[tone];
    const dir = n.direction ?? 'flat';
    const change = n.change ? `${GLYPH[dir]} ${esc(n.change)}` : `${GLYPH.flat} ${WORD.flat}`;
    const src = httpsUrl(n.source_url);
    return `<tr>`
      + `<td style="padding:7px 0;border-top:1px solid ${C.divider};font-family:${FONT};font-size:14px;line-height:20px;color:${C.body};">${esc(n.label)}`
      + `<div style="font-size:11px;line-height:15px;color:${C.muted};">${n.period ? `${esc(n.period)} · ` : ''}${a(src, n.source_short || n.source_name, `color:${C.muted};text-decoration:underline;`)}</div></td>`
      + `<td align="right" style="padding:7px 0 7px 8px;border-top:1px solid ${C.divider};font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:${C.ink};white-space:nowrap;">${esc(n.value)}`
      + `<div style="font-size:12px;line-height:16px;font-weight:bold;color:${color};">${change}</div></td></tr>`;
  }).join('');
  return `<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
}

// ---- the brief email ----------------------------------------------------------------------

export interface BriefEmailOptions {
  kind: BriefKind;
  brief: BriefInput;
  token: string;                 // subscription token (unsubscribe / change-time links)
  postalLine: string;            // physical-contact line (MAIL_POSTAL_LINE)
  now?: Date;
}

export interface Email {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

interface Plan {
  summary: { text: string; ai: boolean } | null;
  top: BlurbCard[];
  market: { cards: BlurbCard[]; numbers: MacroFact[] };
  topics: { label: string; cards: BlurbCard[]; more: { total: number; url: string | null } | null }[];
  numbers: MacroFact[];
}

/** Decides what goes where: no card twice, breadth over depth (see config.mail.email). */
export function planBrief(brief: BriefInput): Plan {
  const e = config.mail.email;
  const used = new Set<string>();
  const take = (cards: BlurbCard[] | undefined, max: number): BlurbCard[] => {
    const out: BlurbCard[] = [];
    for (const c of cards ?? []) {
      if (out.length >= max) break;
      if (!c || used.has(c.id) || !oneLine(c.headline)) continue;
      used.add(c.id);
      out.push(c);
    }
    return out;
  };
  const top = take(brief.headline_cards, e.topStories);
  const marketCards = take(brief.markets?.cards, e.marketCards);
  const marketNumbers = (brief.markets?.numbers ?? []).slice(0, 5);
  const marketSeries = new Set(marketNumbers.map((n) => n.series_id));

  const sections = [...(brief.sections ?? [])].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
  const topics: Plan['topics'] = [];
  for (const s of sections) {
    if (topics.length >= e.topicSections) break;
    const cards = take(s.cards, topics.length < 3 ? e.cardsPerTopTopic : e.cardsPerOtherTopic);
    if (!cards.length) continue;
    const total = s.total ?? s.cards.length;
    const more = total > cards.length && s.slug ? { total, url: httpsUrl(site(`/?category=${encodeURIComponent(s.slug)}`)) } : null;
    topics.push({ label: oneLine(s.label), cards, more });
  }
  const numbers = (brief.numbers ?? []).filter((n) => !marketSeries.has(n.series_id)).slice(0, e.numbers);
  const sum = brief.summary?.text ? { text: brief.summary.text.trim().split(/\n\s*\n/).map(oneLine).join('\n\n'), ai: brief.summary.model !== 'template' } : null;
  return { summary: sum, top, market: { cards: marketCards, numbers: marketNumbers }, topics, numbers };
}

function dateLabel(now: Date): string {
  const { date } = localParts(now, config.mail.timezone);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

const subjectFor = (kind: BriefKind) => (kind === 'daily' ? 'Your Element daily brief' : 'Your Element weekly brief');

function shell(opts: { title: string; preheader: string; inner: string; footer: string }): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};font-size:1px;line-height:1px;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background-color:${C.bg};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.surface}" style="width:100%;max-width:600px;background-color:${C.surface};border:1px solid ${C.border};">
${opts.inner}
${opts.footer}
</table></td></tr></table></body></html>`;
}

function footerHtml(opts: { ai: boolean; token?: string; postalLine: string; why: string }): string {
  const links = opts.token
    ? `<tr><td style="padding:10px 24px 0 24px;font-family:${FONT};font-size:13px;line-height:20px;">${a(unsubscribeUrl(opts.token), 'Unsubscribe')} &nbsp;·&nbsp; ${a(manageUrl(opts.token), 'Change your time')}</td></tr>`
    : '';
  return `<tr><td style="padding:22px 24px 0 24px;"><div style="border-top:1px solid ${C.border};"></div></td></tr>
${opts.ai ? `<tr><td style="padding:12px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${esc(AI_LABEL)}</td></tr>` : ''}
<tr><td style="padding:${opts.ai ? 2 : 12}px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${esc(DISCLAIMER)}</td></tr>
<tr><td style="padding:8px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${esc(opts.why)}</td></tr>
${links}
<tr><td style="padding:10px 24px 22px 24px;font-family:${FONT};font-size:11px;line-height:16px;color:${C.muted};">${esc(opts.postalLine)}</td></tr>`;
}

/** The brief email for one subscriber. Throws on a bad token. */
export function composeBriefEmail(o: BriefEmailOptions): Email {
  const now = o.now ?? new Date();
  const plan = planBrief(o.brief);
  const kindWord = o.kind === 'daily' ? 'Daily' : 'Weekly';
  const anyAi = (plan.summary?.ai ?? false) || [...plan.top, ...plan.market.cards, ...plan.topics.flatMap((t) => t.cards)].some((c) => c.ai?.generated);

  const parts: string[] = [];
  parts.push(`<tr><td style="background-color:${C.accent};padding:16px 24px;font-family:${FONT};"><div style="font-size:20px;line-height:24px;font-weight:bold;color:${C.onAccent};">Element</div>`
    + `<div style="font-size:13px;line-height:18px;color:${C.accentSoft};">${esc(kindWord)} brief · ${esc(dateLabel(now))}</div></td></tr>`);
  if (plan.summary) {
    parts.push(sectionTitle(`${kindWord} summary`));
    parts.push(`<tr><td style="padding:0 24px 10px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.surfaceMuted}" style="background-color:${C.surfaceMuted};border-left:4px solid ${C.accent};padding:12px 14px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.ink};">${plan.summary.text.split(/\n\n/).map((para) => `<p style="margin:0 0 10px 0;">${esc(para)}</p>`).join('')}`
      + `${plan.summary.ai ? `<div style="font-size:11px;line-height:16px;color:${C.muted};padding-top:6px;">${esc(AI_LABEL)}</div>` : ''}</td></tr></table></td></tr>`);
  }
  if (plan.top.length) { parts.push(sectionTitle('Top stories')); parts.push(...plan.top.map(cardRow)); }
  if (plan.market.cards.length || plan.market.numbers.length) {
    parts.push(sectionTitle('Markets'));
    if (plan.market.numbers.length) parts.push(numbersTable(plan.market.numbers));
    parts.push(...plan.market.cards.map(cardRow));
  }
  for (const t of plan.topics) {
    parts.push(sectionTitle(t.label));
    parts.push(...t.cards.map(cardRow));
    if (t.more) parts.push(`<tr><td style="padding:2px 24px 6px 24px;font-family:${FONT};font-size:12px;line-height:18px;">${a(t.more.url, `See all ${t.more.total} in Element`)}</td></tr>`);
  }
  if (plan.numbers.length) {
    parts.push(sectionTitle('Numbers to know'));
    parts.push(numbersTable(plan.numbers));
    parts.push(`<tr><td style="padding:8px 24px 0 24px;font-family:${FONT};font-size:11px;line-height:16px;color:${C.muted};">Green: generally good for households. Red: generally bad. Gray: no change or neither.</td></tr>`);
  }
  if (parts.length === 1) {
    parts.push(`<tr><td style="padding:22px 24px;font-family:${FONT};font-size:15px;line-height:22px;color:${C.body};">There are no new stories in this brief yet. ${a(site('/'), 'Open Element')} for the latest.</td></tr>`);
  }
  const pre = plan.summary ? plan.summary.text.slice(0, 110) : (plan.top[0] ? oneLine(plan.top[0].headline) : 'Your Element brief');
  const html = shell({
    title: subjectFor(o.kind),
    preheader: pre,
    inner: parts.join('\n'),
    footer: footerHtml({ ai: anyAi, token: o.token, postalLine: o.postalLine, why: 'You get this email because you asked for the Element brief with this address.' }),
  });

  // ---- plain text ----
  const t: string[] = [`ELEMENT · ${kindWord} brief · ${dateLabel(now)}`, ''];
  const textCard = (c: BlurbCard) => {
    const src = primarySource(c);
    const link = cardUrl(c);
    const out = [`* ${oneLine(c.headline)}`];
    if (c.body) out.push(`  ${oneLine(c.body)}`);
    if (src) out.push(`  Source: ${src.label}${src.url ? ` ${src.url}` : ''}`);
    if (link) out.push(`  Read in Element: ${link}`);
    return out.join('\n');
  };
  const textNums = (nums: MacroFact[]) => nums.map((n) => {
    const tone = numberTone(n.series_id, n.direction);
    const mood = tone === 'good' ? ' (generally good for households)' : tone === 'bad' ? ' (generally bad for households)' : '';
    return `* ${n.label}: ${n.value}${n.change ? ` (${WORD[n.direction ?? 'flat']} ${n.change})` : ' (unchanged)'}${mood}`;
  }).join('\n');
  if (plan.summary) { t.push(`${kindWord.toUpperCase()} SUMMARY`, plan.summary.text, ...(plan.summary.ai ? [AI_LABEL] : []), ''); }
  if (plan.top.length) t.push('TOP STORIES', plan.top.map(textCard).join('\n'), '');
  if (plan.market.cards.length || plan.market.numbers.length) {
    t.push('MARKETS');
    if (plan.market.numbers.length) t.push(textNums(plan.market.numbers));
    if (plan.market.cards.length) t.push(plan.market.cards.map(textCard).join('\n'));
    t.push('');
  }
  for (const tp of plan.topics) {
    t.push(tp.label.toUpperCase(), tp.cards.map(textCard).join('\n'));
    if (tp.more?.url) t.push(`  See all ${tp.more.total} in Element: ${tp.more.url}`);
    t.push('');
  }
  if (plan.numbers.length) t.push('NUMBERS TO KNOW', textNums(plan.numbers), '');
  t.push('--', ...(anyAi ? [AI_LABEL] : []), DISCLAIMER, 'You get this email because you asked for the Element brief with this address.',
    `Unsubscribe: ${unsubscribeUrl(o.token)}`, `Change your time: ${manageUrl(o.token)}`, o.postalLine);

  return {
    subject: subjectFor(o.kind),
    html,
    text: t.join('\n'),
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(o.token)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

// ---- confirmation email ------------------------------------------------------------------

export interface ConfirmationOptions {
  token: string;
  kind: 'daily' | 'weekly' | 'both';
  sendHour: number;
  tz: string | null;
  postalLine: string;
}

const KIND_WORDS = { daily: 'daily brief', weekly: 'weekly brief (Mondays)', both: 'daily brief and the weekly brief (Mondays)' } as const;

/** "7 AM" style label for an hour 0-23. */
export function hourLabel(h: number): string {
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : config.mail.defaultSendHour;
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The "please confirm" email for a pending subscription (double opt-in). Nothing is sent until the link is opened. */
export function composeConfirmationEmail(o: ConfirmationOptions): Email {
  const url = confirmUrl(o.token);
  const what = KIND_WORDS[o.kind] ?? KIND_WORDS.daily;
  const when = `${hourLabel(o.sendHour)} (${o.tz || config.mail.timezone})`;
  const inner = `<tr><td style="background-color:${C.accent};padding:16px 24px;font-family:${FONT};font-size:20px;line-height:24px;font-weight:bold;color:${C.onAccent};">Element</td></tr>
<tr><td style="padding:22px 24px 8px 24px;font-family:${FONT};font-size:18px;line-height:26px;font-weight:bold;color:${C.ink};">Confirm your Element brief</td></tr>
<tr><td style="padding:0 24px 14px 24px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.body};">Someone asked to get the Element ${esc(what)} by email at ${esc(when)}. If that was you, confirm with the button. We send nothing until you do.</td></tr>
<tr><td style="padding:0 24px 16px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.accent}" style="background-color:${C.accent};border-radius:6px;"><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:${C.onAccent};text-decoration:none;">Confirm my email</a></td></tr></table></td></tr>
<tr><td style="padding:0 24px 0 24px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">Or paste this link into your browser:<br>${a(url, url)}</td></tr>
<tr><td style="padding:12px 24px 0 24px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">Not you? Ignore this email and nothing happens.</td></tr>`;
  const html = shell({
    title: 'Confirm your Element brief',
    preheader: 'One tap to start your Element brief. Not you? Ignore this email.',
    inner,
    footer: `<tr><td style="padding:18px 24px 0 24px;"><div style="border-top:1px solid ${C.border};"></div></td></tr>
<tr><td style="padding:12px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${esc(DISCLAIMER)}</td></tr>
<tr><td style="padding:10px 24px 22px 24px;font-family:${FONT};font-size:11px;line-height:16px;color:${C.muted};">${esc(o.postalLine)}</td></tr>`,
  });
  const text = [
    'Confirm your Element brief', '',
    `Someone asked to get the Element ${what} by email at ${when}.`,
    'If that was you, confirm here. We send nothing until you do:', url, '',
    'Not you? Ignore this email and nothing happens.', '--', DISCLAIMER, o.postalLine,
  ].join('\n');
  return { subject: 'Confirm your Element brief', html, text, headers: {} };
}

/** Every URL in an email body that is not https (used by tests and as a last check before sending). */
export function nonHttpsLinks(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/gi)].map((m) => m[1].replace(/&amp;/g, '&')).filter((u) => !/^https:\/\//i.test(u));
}

