// --rewrite: redo published cards written with an older prompt or template version, in place.
// For each card from api.blurbs_to_revise (status published, prompt_version not current):
// - data card: rebuild the text with the current plain template from the numbers already on it.
// - template card (no AI): rebuild from the same feed metadata with the current template.
// - AI card: rebuild the licensed source text through the same allowlisted fetches as a normal
//   run, then the same chain (license gate, caps, pacing), validator and relevance gate.
//   Relevance below the minimum -> the card is hidden. No valid AI draft -> the old card stays.
// The card keeps its id, category, event type, sources and sort_at (the feed order does not jump);
// api.revise_blurb sets revision + 1 and updated_at.
// Inputs: Deps (same as a normal run; the publisher must support listToRevise/reviseBlurb), a card limit.
// Outputs: RewriteStats; cards are revised or hidden through deps.publisher.

import { config } from './config.ts';
import type { Deps } from './pipeline.ts';
import { buildPublishPayload } from './publish.ts';
import { secFilingPageText } from './sec-text.ts';
import { beaItemToItem } from './sources/bea.ts';
import { cpscToItem, cpscUrl, parseCpscJson } from './sources/cpsc.ts';
import { fedItemToItem, fedPageText, mergeFedItems, parseRss } from './sources/fed.ts';
import { fedRegDocToItem, type FrDoc } from './sources/fedreg.ts';
import { buildDataCard, observationFromFact } from './sources/macro.ts';
import { nasaToItem, parseNasaRss } from './sources/nasa.ts';
import { classifySecEntry, parseSubmissionsJson } from './sources/sec.ts';
import { parseUsgsGeoJson, usgsDraft, usgsToItem } from './sources/usgs.ts';
import { createChainState, summarizeWithChain } from './summarizer/chain.ts';
import { templateDraft } from './summarizer/template.ts';
import type { RawItem, RevisableCard, RevisePayload } from './types.ts';
import { hasFigures, requiresFigures, SUMMARIZABLE, validatePublish } from './validate.ts';

export interface RewriteStats {
  selected: number;
  revised: number;
  hidden: number;
  kept: number;                       // old card left unchanged (no valid draft, source gone, unsupported)
  failed: number;
  ai: number;
}

/** Versions that count as current: the AI prompt and the template wording. */
export const currentVersions = (): string[] => [config.promptVersion, config.templateVersion];

type Rebuilt = { item: RawItem; pageText: () => Promise<string> } | { reason: string } | { hide: string };

const noPage = async () => '';

/** Rebuilds the RawItem (and how to get its page text) for a card, from the same sources a normal run uses. */
async function rebuildItem(card: RevisableCard, deps: Pick<Deps, 'fetchText' | 'now' | 'log'>): Promise<Rebuilt> {
  const src = card.item;
  if (!src) return { reason: 'no collected item behind this card' };
  const url = src.url;
  switch (src.source) {
    case 'sec_8k': {
      const cik = /\/edgar\/data\/(\d+)\//.exec(url)?.[1];
      if (!cik) return { reason: 'no CIK in the filing URL' };
      const json = await deps.fetchText(config.secSubmissionsUrl.replace('{cik}', cik.padStart(10, '0')), 'api', 0);
      const entry = parseSubmissionsJson(json, deps.now, 3650).find((e) => e.accession === src.external_id || e.url === url);
      if (!entry) return { reason: 'filing not found in the company filing list' };
      const r = classifySecEntry(entry, null);
      if (!('item' in r)) return { reason: `filing not a card candidate (${r.skip})` };
      const item = { ...r.item, url, tickers: card.tickers.length ? card.tickers : r.item.tickers };
      if (item.tickers[0]) item.company = item.tickers[0].name;
      // primary document, plus the EX-99.1 press release for an earnings filing (same fetch path as a normal run)
      return { item, pageText: () => secFilingPageText(deps.fetchText, item, deps.log) };
    }
    case 'fed_rss': {
      const item = fedItemToItem({ title: src.title ?? card.headline, link: url, description: '', category: null, pubDate: card.as_of, guid: src.external_id ?? url });
      return { item: { ...item, event_type: card.event_type }, pageText: async () => fedPageText(await deps.fetchText(url, 'page', config.cacheTtlMinutes)) };
    }
    case 'bea_rss': {
      const list = mergeFedItems([parseRss(await deps.fetchText(config.feeds.beaRss, 'api', config.feedCacheTtlMinutes))], deps.now, 3650);
      const hit = list.find((i) => i.link === url);
      return hit ? { item: beaItemToItem(hit), pageText: noPage } : { reason: 'release no longer in the BEA feed' };
    }
    case 'fedreg': {
      if (!src.external_id) return { reason: 'no document number' };
      const u = new URL(config.fedRegister.documentEndpoint.replace('{doc}', encodeURIComponent(src.external_id)));
      for (const f of config.fedRegister.fields) u.searchParams.append('fields[]', f);
      const doc = JSON.parse(await deps.fetchText(u.toString(), 'api', 0)) as FrDoc;
      const r = fedRegDocToItem(doc, deps.now);
      return 'item' in r ? { item: r.item, pageText: noPage } : { reason: `rule not usable (${r.skip})` };
    }
    case 'usgs': {
      // Re-read the significant-earthquakes feed and find this event by its id (or event URL).
      // Older quakes may have aged out of the week feed; those are kept unchanged.
      const feed = parseUsgsGeoJson(await deps.fetchText(config.usgs.url, 'api', config.feedCacheTtlMinutes));
      const f = feed.find((x) => x.id === src.external_id || x.properties?.url === url);
      if (!f) return { reason: 'earthquake no longer in the USGS significant-week feed' };
      const r = usgsToItem(f, deps.now);
      if ('item' in r) return { item: r.item, pageText: noPage };
      // A published quake that the current threshold would not publish (green alert at sea, or small) is hidden.
      return r.skip === 'low_interest' ? { hide: `low_interest (${r.note})` } : { reason: `earthquake not usable (${r.skip})` };
    }
    case 'cpsc': {
      // Recalls older than the normal lookback are looked up over a longer window; one that aged out is kept unchanged.
      const list = parseCpscJson(await deps.fetchText(cpscUrl(deps.now, config.cpsc.rewriteLookbackDays), 'api', 0));
      const hit = list.find((x) => x.URL === url || (src.external_id && x.RecallNumber === src.external_id));
      if (!hit) return { reason: 'recall no longer in the CPSC list' };
      const r = cpscToItem(hit, deps.now);
      return 'item' in r ? { item: r.item, pageText: noPage } : { reason: `recall not usable (${r.skip})` };
    }
    case 'nasa': {
      const hit = parseNasaRss(await deps.fetchText(config.nasa.feedUrl, 'api', 0)).find((x) => x.link === url);
      return hit ? { item: nasaToItem(hit, deps.now), pageText: noPage } : { reason: 'release no longer in the NASA feed' };
    }
    default:
      return { reason: `source ${src.source} is not supported by --rewrite (Wikipedia stories leave the feed after one day)` };
  }
}

/**
 * --rewrite: redoes up to `opts.limit` (default 20) published cards that are not on the current
 * prompt/template version. Left as one function because each branch ends the card with `continue`;
 * outline per card:
 *   1. data card     -> rebuild from its stored numbers with the current data template
 *   2. other non-summary kinds -> kept
 *   3. rebuild the source item (rebuildItem); not possible -> kept
 *   4. template card -> rebuild with the current template (no AI)
 *   5. AI card       -> license gate, page text, summarizer chain:
 *                       low relevance -> hidden; no valid AI draft or failed publish check -> kept;
 *                       otherwise revised in place
 * Any error leaves the old card unchanged (counted as failed).
 */
export async function runRewrite(deps: Deps, opts: { limit?: number } = {}): Promise<RewriteStats> {
  const stats: RewriteStats = { selected: 0, revised: 0, hidden: 0, kept: 0, failed: 0, ai: 0 };
  const pub = deps.publisher;
  if (!pub.listToRevise || !pub.reviseBlurb) throw new Error('publisher cannot list or revise cards');
  const cards = await pub.listToRevise(currentVersions(), opts.limit ?? 20);
  stats.selected = cards.length;
  deps.log(`rewrite: ${cards.length} published cards not on ${currentVersions().join(' / ')}`);
  const chain = createChainState();

  const revise = async (card: RevisableCard, p: RevisePayload, how: string) => {
    const res = await pub.reviseBlurb!(p);
    if (res.status === 'revised') stats.revised++;
    else if (res.status === 'hidden') stats.hidden++;
    else stats.kept++;
    deps.log(`${res.status} [${how}] ${card.headline}${p.action === 'revise' ? `  ->  ${p.headline}` : `  (${p.note})`}`);
  };

  for (const card of cards) {
    try {
      // 1. data cards: same numbers, current plain template
      if (card.kind === 'data') {
        const facts = card.macro.map(observationFromFact);
        if (!facts[0] || facts.some((f) => !f)) { stats.kept++; deps.log(`kept (unknown series): ${card.headline}`); continue; }
        const d = buildDataCard(facts[0]!, facts.slice(1) as NonNullable<(typeof facts)[0]>[], { force: true });
        if (!d) { stats.kept++; deps.log(`kept (no change to describe): ${card.headline}`); continue; }
        await revise(card, { id: card.id, action: 'revise', headline: d.headline, body: d.body, ai_generated: false, model: null, prompt_version: config.templateVersion, detail: d.detail ?? null }, 'data template');
        continue;
      }
      if (card.kind !== 'summary') { stats.kept++; deps.log(`kept (kind ${card.kind}): ${card.headline}`); continue; }

      const rb = await rebuildItem(card, deps);
      if ('hide' in rb) { await revise(card, { id: card.id, action: 'hide', note: rb.hide }, 'rule'); continue; }
      if ('reason' in rb) { stats.kept++; deps.log(`kept (${rb.reason}): ${card.headline}`); continue; }
      const it = rb.item;

      // 2. template cards: same metadata, current plain template (no AI)
      if (!card.ai_generated) {
        const draft = it.source === 'usgs' ? usgsDraft(it) : templateDraft({ item: it, text: '' });
        // An earnings card without figures is hidden, not kept (a template card cannot state figures).
        if (requiresFigures(it) && !hasFigures(draft.body)) {
          await revise(card, { id: card.id, action: 'hide', note: 'no_figures' }, 'template');
          continue;
        }
        const p = buildPublishPayload(it, draft, { aiGenerated: false, model: null });
        await revise(card, { id: card.id, action: 'revise', headline: p.headline, body: p.body, ai_generated: false, model: null, prompt_version: config.templateVersion, detail: p.detail ?? null }, 'template');
        continue;
      }

      // 3. AI cards: same licensed text, same chain, validator and relevance gate
      if (!(SUMMARIZABLE as readonly string[]).includes(it.license_class)) {
        stats.kept++; deps.log(`kept (license ${it.license_class} may not be summarized): ${card.headline}`); continue;
      }
      let text = it.summary_text;
      try {
        const page = await rb.pageText();
        if (page) text = `${it.summary_text}\n\n${page}`.slice(0, config.sourceTextMaxChars);
      } catch (e) {
        deps.log(`page text unavailable (feed text only): ${it.url}: ${(e as Error).message}`);
      }
      const r = await summarizeWithChain({ item: it, text }, deps.providers, deps.counter, {
        state: chain, minRelevance: config.minEverydayRelevance, requireRelevance: true,
      });
      if (r.ai_generated) stats.ai++;
      if (r.low_relevance) {
        await revise(card, { id: card.id, action: 'hide', note: `low_relevance (${r.relevance})` }, r.provider);
        continue;
      }
      if (!r.ai_generated) {
        // No valid AI draft. An earnings card that already has no figures (and cannot get any now) is hidden;
        // anything else keeps its old card, e.g. when the AI was only capped or rate limited.
        if (requiresFigures(it) && !hasFigures(card.body)) {
          await revise(card, { id: card.id, action: 'hide', note: 'no_figures' }, r.provider);
          continue;
        }
        stats.kept++;
        deps.log(`kept (no valid AI draft; old card unchanged): ${card.headline}  (${r.log.join(' | ')})`);
        continue;
      }
      const p = buildPublishPayload(it, r.draft, { aiGenerated: true, model: r.model });
      if (requiresFigures(it) && !hasFigures(p.body)) {      // cannot happen (the validator rejects it); belt and braces
        await revise(card, { id: card.id, action: 'hide', note: 'no_figures' }, r.provider);
        continue;
      }
      const v = validatePublish(p);
      if (!v.ok) { stats.kept++; deps.log(`kept (publish check failed: ${v.errors.join('; ')}): ${card.headline}`); continue; }
      await revise(card, { id: card.id, action: 'revise', headline: p.headline, body: p.body, ai_generated: true, model: r.model, prompt_version: config.promptVersion, detail: p.detail ?? null }, `${r.provider}, relevance ${r.relevance}${p.detail ? ', with detail' : ', no detail'}`);
    } catch (e) {
      stats.failed++;
      deps.log(`failed (old card unchanged): ${card.headline}: ${(e as Error).message}`);
    }
  }
  return stats;
}
