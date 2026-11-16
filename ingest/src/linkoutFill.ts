// One-off retro pass (D-296): add AI summaries to link-out cards that were published headline-only.
// The drafts are written locally by Claude Haiku (Claude Code subagents; no paid API key, D-13 stays). This file does the rest:
//   export  list published link_out cards with no body, fetch each publisher page, build the sum-v7 prompt -> state/linkout-fill/cards.json
//   check   replay each draft through the normal chain (shape, relevance, advice, numbers, copy limit, detail checks), report only
//   apply   same checks, then api.revise_blurb for the passing drafts (dry run unless --apply)
// The headline, publisher link, "via NewsData.io" and the 12 h delay are untouched; only body, detail and the AI label change.
// Inputs: Deps (publisher with listToRevise/reviseBlurb, fetchText), the exported cards file, a drafts file [{ id, draft }].
// Outputs: JSON files under state/linkout-fill/ (git-ignored, never pushed: they hold publisher text) and revise calls.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { fetchPublisherText } from './publisherPage.ts';
import { buildPrompt } from './summarizer/gemini.ts';
import { memoryCounter, summarizeWithChain } from './summarizer/chain.ts';
import { newsdataSummaryPayload, withPageText } from './sources/newsdata.ts';
import type { Deps } from './pipeline.ts';
import type { RawItem, RevisableCard, RevisePayload, SummaryDraft, Summarizer } from './types.ts';
import { validatePublish } from './validate.ts';

export const HAIKU_MODEL = 'claude-haiku-5-5';
export const FILL_DIR = 'state/linkout-fill';

export interface ExportedCard {
  id: string;
  headline: string;
  url: string;
  source_name: string;
  category: string;
  as_of: string;
  tickers: RevisableCard['tickers'];
  text: string;          // fetched publisher text (never stored in the database)
  prompt: string;        // the sum-v7 prompt for this card; the answer is one JSON object
}
export interface DraftFile { id: string; draft: SummaryDraft }
export interface CheckResult { id: string; ok: boolean; errors: string[]; payload?: RevisePayload }

const cardItem = (c: RevisableCard | ExportedCard, url: string, source_name: string): RawItem => ({
  source: 'newsdata', external_id: c.id, url, title: c.headline, published_at: c.as_of,
  license_class: 'link_out', category: c.category as RawItem['category'], event_type: null, tickers: c.tickers,
  source_name, source_kind: 'news', doc_label: '', summary_text: '', attribution: config.newsdata.attribution,
});

/** Published and queued link-out cards that still have no body. */
export async function listFillable(deps: Deps, limit = 200): Promise<RevisableCard[]> {
  const pub = deps.publisher;
  if (!pub.listLinkOutWithoutSummary && !pub.listToRevise) throw new Error('publisher cannot list cards');
  const n = Math.min(Math.max(limit, 1), 500);
  // preferred: api.link_out_without_summary (published + queued); fallback: published cards via api.blurbs_to_revise
  const all = pub.listLinkOutWithoutSummary ? await pub.listLinkOutWithoutSummary(n) : await pub.listToRevise!([], Math.min(n, 200));
  return all.filter((c) => c.kind === 'link_out' && !c.body && c.sources?.[0]?.url);
}

export interface ExportResult { cards: ExportedCard[]; noText: number; allIds: { id: string; headline: string }[] }

export async function exportCards(deps: Deps, opts: { limit?: number; file?: string; idsFile?: string } = {}): Promise<ExportResult> {
  const listed = await listFillable(deps, opts.limit ?? 200);
  const cards: ExportedCard[] = [];
  const allIds = listed.map((c) => ({ id: c.id, headline: c.headline }));   // every card that still has no summary; the ones that stay so get hidden (D-130)
  let noText = 0;
  for (const c of listed) {
    const src = c.sources[0];
    const text = await fetchPublisherText(src.url, { fetchText: (u) => deps.fetchText(u, 'publisher', 0), log: deps.log });
    if (!text) { noText++; continue; }
    const item = withPageText(cardItem(c, src.url, src.name));
    cards.push({
      id: c.id, headline: c.headline, url: src.url, source_name: src.name, category: c.category, as_of: c.as_of, tickers: c.tickers,
      text, prompt: buildPrompt({ item, text }),
    });
  }
  deps.log(`export: ${listed.length} link-out cards without a summary, ${cards.length} with usable page text, ${noText} without (stay headline-only)`);
  if (opts.file) { await mkdir(dirname(opts.file), { recursive: true }); await writeFile(opts.file, JSON.stringify(cards, null, 2), 'utf8'); }
  if (opts.idsFile) { await mkdir(dirname(opts.idsFile), { recursive: true }); await writeFile(opts.idsFile, JSON.stringify(allIds, null, 2), 'utf8'); }
  return { cards, noText, allIds };
}

/** A provider that returns a draft written elsewhere, so the normal chain checks it exactly like a live one. */
function replayProvider(draft: SummaryDraft): Summarizer {
  return { name: 'haiku', usesAi: true, model: HAIKU_MODEL, dailyCap: 1_000_000, minIntervalMs: 0, async summarize() { return draft; } };
}

export async function checkDrafts(cards: ExportedCard[], drafts: DraftFile[]): Promise<CheckResult[]> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: CheckResult[] = [];
  for (const d of drafts) {
    const card = byId.get(d.id);
    if (!card) { out.push({ id: d.id, ok: false, errors: ['id not in the exported cards file'] }); continue; }
    const item = withPageText(cardItem(card, card.url, card.source_name));
    try {
      const r = await summarizeWithChain({ item, text: card.text }, [replayProvider(d.draft)], memoryCounter(), {
        minRelevance: config.minEverydayRelevance, requireRelevance: true, maxAttempts: 1,
      });
      if (!r.ai_generated || r.low_relevance) { out.push({ id: d.id, ok: false, errors: r.log.length ? r.log : ['low relevance'] }); continue; }
      const full = newsdataSummaryPayload(item, r.draft, { itemId: card.id, model: HAIKU_MODEL });
      const v = validatePublish({ ...full, kind: 'link_out' }, { linkOutEnabled: true });
      if (!v.ok) { out.push({ id: d.id, ok: false, errors: v.errors }); continue; }
      out.push({
        id: d.id, ok: true, errors: [],
        payload: { id: card.id, action: 'revise', headline: card.headline, body: full.body, ai_generated: true, model: HAIKU_MODEL, prompt_version: config.promptVersion, detail: full.detail ?? null, everyday_relevance: full.everyday_relevance },
      });
    } catch (e) {
      out.push({ id: d.id, ok: false, errors: [(e as Error).message] });
    }
  }
  return out;
}

/**
 * Applies the check results. Passing drafts are revised in place (summary + key points). With `allIds` (every link-out card that had no
 * summary when exported), every card that did NOT get a passing draft is hidden (D-130: no key points, no card). Dry run unless apply.
 */
export async function applyDrafts(
  deps: Deps, results: CheckResult[], opts: { apply: boolean; allIds?: { id: string; headline: string }[] },
): Promise<{ revised: number; hidden: number; notFound: number; skipped: number }> {
  const stats = { revised: 0, hidden: 0, notFound: 0, skipped: 0 };
  const passed = new Set<string>();
  for (const r of results) {
    if (!r.ok || !r.payload) { stats.skipped++; deps.log(`no valid draft ${r.id}: ${r.errors.join('; ').slice(0, 160)}`); continue; }
    passed.add(r.id);
    if (!opts.apply) { stats.revised++; deps.log(`dry run, would revise ${r.id}`); continue; }
    const res = await deps.publisher.reviseBlurb!(r.payload);
    if (res.status === 'revised') stats.revised++; else stats.notFound++;
    deps.log(`${res.status} ${r.id}`);
  }
  for (const c of opts.allIds ?? []) {
    if (passed.has(c.id)) continue;
    if (!opts.apply) { stats.hidden++; deps.log(`dry run, would hide ${c.id}: ${c.headline.slice(0, 80)}`); continue; }
    const res = await deps.publisher.reviseBlurb!({ id: c.id, action: 'hide', note: 'no_summary (D-130: link-out cards need key points)' });
    if (res.status === 'hidden') stats.hidden++; else stats.notFound++;
    deps.log(`${res.status} ${c.id}`);
  }
  return stats;
}

export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T; }
