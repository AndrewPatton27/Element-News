// Which trust labels a card must show. Pure: no React imports, so node --test runs it.
//
// The strings come from api.app_config. The constants below are the fallbacks used
// before the config loads or if it comes back empty, so a card is never rendered
// without its disclaimer.

import type { AppConfig, BlurbCard, NoticePlacement, RequiredNotice } from '../contract/types.ts';

export const DISCLAIMER_FALLBACK = 'Informational only · Not investment advice';
export const AI_NOTICE_FALLBACK = 'AI-generated summary · may contain errors';

export const RENDERABLE_KINDS = ['summary', 'data'] as const;
export type RenderableKind = (typeof RENDERABLE_KINDS)[number];

// 'link_out' is reserved and unknown kinds may arrive from a newer back end: skip them.
export function isRenderableKind(kind: unknown): kind is RenderableKind {
  return kind === 'summary' || kind === 'data';
}

export interface CardLabels {
  disclaimer: string; // always non-empty
  aiLabel: string | null; // set only when the card says ai.generated
  sourcesText: string; // "SEC · +2 sources"
}

function nonEmpty(text: string | null | undefined, fallback: string): string {
  return typeof text === 'string' && text.trim() !== '' ? text : fallback;
}

export function disclaimerText(config: Pick<AppConfig, 'disclaimer'> | null | undefined): string {
  return nonEmpty(config?.disclaimer, DISCLAIMER_FALLBACK);
}

export function aiNoticeText(config: Pick<AppConfig, 'ai_notice'> | null | undefined): string {
  return nonEmpty(config?.ai_notice, AI_NOTICE_FALLBACK);
}

export function primarySource(card: Pick<BlurbCard, 'sources'>) {
  return card.sources.find((s) => s.is_primary) ?? card.sources[0] ?? null;
}

export function sourcesText(card: Pick<BlurbCard, 'sources' | 'source_count'>): string {
  const primary = primarySource(card);
  const name = primary ? primary.name : 'Source';
  const extra = Math.max(card.source_count, card.sources.length) - 1;
  return extra > 0 ? `${name} · +${extra} source${extra === 1 ? '' : 's'}` : name;
}

// The AI label is taken from app_config.ai_notice, not from card.ai.label, so the
// wording is the same on every card and cannot drift per row.
export function cardLabels(card: BlurbCard, config: AppConfig | null | undefined): CardLabels {
  return {
    disclaimer: disclaimerText(config),
    aiLabel: card.ai && card.ai.generated === true ? aiNoticeText(config) : null,
    sourcesText: sourcesText(card),
  };
}

export function noticesFor(config: Pick<AppConfig, 'required_notices'> | null | undefined, placement: NoticePlacement): RequiredNotice[] {
  return (config?.required_notices ?? []).filter((n) => n.placements.includes(placement));
}

// The FRED notice goes on any data card whose figures came through FRED.
export function cardNotices(card: BlurbCard, config: AppConfig | null | undefined): RequiredNotice[] {
  if (card.kind !== 'data') return [];
  const viaFred = card.macro.some((m) => /FRED/.test(m.source_name)) || card.sources.some((s) => /FRED/.test(s.name));
  return viaFred ? noticesFor(config, 'data_card') : [];
}

// "How this card was made", shown in the sources sheet. Honest about AI use.
export function howMadeText(card: Pick<BlurbCard, 'kind' | 'ai'>): string {
  if (card.kind === 'data') {
    return 'Built from official figures with a fixed template. No AI was used. The numbers come from the source above.';
  }
  if (card.ai.generated) {
    return 'An AI wrote this summary from the source above, then it was checked automatically against that text. It can still be wrong, so read the source for anything important.';
  }
  return 'Written from the filing’s details with a fixed template. No AI was used. Read the source for the full picture.';
}

// ---- Where the disclaimer goes on a card ----
//
// Every card shows the disclaimer exactly once. With reaction buttons the footer row is
// taken by them, so the line goes underneath; without them it sits in the footer row.
// One function decides, and exactly one of the two slots is ever true, whatever props
// the card gets (Card.tsx renders from this; lib/__tests__/disclaimer.test.ts checks it).
export interface DisclaimerPlacement {
  inline: boolean; // in the footer row, beside the "next" hint
  below: boolean; // under the footer row (the reaction buttons use the row)
}

export function disclaimerPlacement(hasReactions: boolean): DisclaimerPlacement {
  return hasReactions ? { inline: false, below: true } : { inline: true, below: false };
}

// ---- Share-alike (Wikipedia, CC BY-SA 4.0) ----

export const CC_BY_SA_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
export const CC_BY_SA_MARK = 'CC BY-SA 4.0';

export interface ShareAlikeCredit {
  text: string; // 'Adapted from Wikipedia ("Title") · CC BY-SA 4.0'
  articleUrl: string; // the adapted article (attribution link)
  licenseUrl: string; // the license (from the cc_by_sa notice, else the constant)
}

// Any card with a cc_by_sa source must show its credit line and a license link.
export function shareAlikeCredit(
  card: Pick<BlurbCard, 'sources' | 'attribution'>,
  config: Pick<AppConfig, 'required_notices'> | null | undefined,
): ShareAlikeCredit | null {
  const src = card.sources.find((s) => (s.license_class as string) === 'cc_by_sa');
  if (!src) return null;
  const notice = (config?.required_notices ?? []).find((n) => n.key === 'cc_by_sa');
  const raw = card.attribution || src.attribution || `Adapted from ${src.name}`;
  const text = raw.includes(CC_BY_SA_MARK) ? raw : `${raw} · ${CC_BY_SA_MARK}`;
  return { text, articleUrl: src.url, licenseUrl: notice?.url || CC_BY_SA_LICENSE_URL };
}
