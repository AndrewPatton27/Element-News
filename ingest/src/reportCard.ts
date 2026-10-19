// Report-card scoring: prompts, defensive parsing of the scorer's JSON, decisions recomputed in code,
// batch scoring and the write -> score -> revise-once protocol. Network access is injected (ScoreClient),
// so every part is testable with fake clients. The scorer never receives anything but card text
// (headline, summary, category, source names/urls); source text of link-out items never reaches it.
import { config } from './config.ts';
import type { RevisableCard, RevisePayload } from './types.ts';
import { parseJsonLoose } from './summarizer/groq.ts';

export type StoryRelation = 'DUPLICATE' | 'UPDATE' | 'ANGLE' | 'RELATED' | 'NEW';
export type Decision = 'PASS' | 'REVISE' | 'ABANDON';
export interface CardScore {
  topic_fit: boolean; matched_topic: string | null;
  scores: { headline: number; summary: number; trust: number; importance: number; category?: number; necessary_info?: number; key_points?: number; concise?: number };
  decision: Decision; relation: StoryRelation; related_id: string | null;
  reason: string; recommendations: string[];
  category_fix?: string | null; proposed_headline?: string | null;
}
export interface ScoreClient { generate(prompt: string): Promise<string> }
type CardLike = Pick<RevisableCard, 'id' | 'headline' | 'body' | 'category' | 'as_of' | 'ai_generated' | 'sources'> & Partial<Pick<RevisableCard, 'kind' | 'tickers'>> & { detail?: unknown };
type RecentLike = Pick<RevisableCard, 'id' | 'headline'> & { body?: string | null; category?: string };

export const RELATIONS: readonly StoryRelation[] = ['DUPLICATE', 'UPDATE', 'ANGLE', 'RELATED', 'NEW'];
const BASE_KEYS = ['headline', 'summary', 'trust', 'importance'] as const;
const EXTRA_KEYS = ['category', 'necessary_info', 'key_points', 'concise'] as const;
const KEY_ALIASES: Record<string, string> = { necessary: 'necessary_info', necessary_information: 'necessary_info', keypoints: 'key_points', detail: 'key_points', conciseness: 'concise' };

/** The decision comes from the scores, never from the model (it sometimes writes the relation there). */
export function decideFromScores(topicFit: boolean, relation: StoryRelation, scores: Record<string, number>): Decision {
  if (!topicFit || relation === 'DUPLICATE') return 'ABANDON';
  const vals = Object.values(scores);
  return vals.some((n) => n === 0) || vals.filter((n) => n === 1).length >= 2 ? 'REVISE' : 'PASS';
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v === 'string') { const t = v.trim().toLowerCase(); if (['true', 'yes', 'y', '1', 'fits', 'pass'].includes(t)) return true; if (['false', 'no', 'n', '0', 'off-topic'].includes(t)) return false; }
  return undefined;
}
function toScore(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(2, Math.max(0, Math.round(n)));
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Turns whatever the model returned for ONE card into a CardScore, or throws (that card is then
 * unscored; the rest of a batch is unaffected). `knownIds` = ids a related_id may point to; a DUPLICATE or
 * link to an unknown id is downgraded (a hallucinated id must not hide a card).
 */
export function normalizeScore(raw: unknown, opts: { knownIds?: ReadonlySet<string>; selfId?: string } = {}): CardScore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('report-card entry is not an object');
  const x = raw as Record<string, unknown>;
  const decisionField = str(x.decision).toUpperCase();
  let topicFit = toBool(x.topic_fit ?? x.topicFit ?? x.fits);
  if (topicFit === undefined) topicFit = decisionField === 'ABANDON' ? false : true;

  const src = (x.scores && typeof x.scores === 'object' && !Array.isArray(x.scores) ? x.scores : x) as Record<string, unknown>;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) flat[KEY_ALIASES[k.toLowerCase()] ?? k.toLowerCase()] = v;
  const scores: Record<string, number> = {};
  for (const k of BASE_KEYS) {
    const n = toScore(flat[k]);
    if (n === undefined) throw new Error(`report-card score "${k}" missing or not a number`);
    scores[k] = n;
  }
  for (const k of EXTRA_KEYS) { const n = toScore(flat[k]); if (n !== undefined) scores[k] = n; }

  let relation = str(x.relation).toUpperCase() as StoryRelation;
  if (!RELATIONS.includes(relation)) relation = (RELATIONS as readonly string[]).includes(decisionField) ? (decisionField as StoryRelation) : 'NEW';
  let related: string | null = str(x.related_id ?? x.relatedId) || null;
  if (related === 'null' || related === 'none' || related === x.id || related === opts.selfId) related = null;
  if (opts.knownIds && related && !opts.knownIds.has(related)) related = null;
  if (!related && relation !== 'NEW' && opts.knownIds) relation = 'NEW';            // a relation needs a real card to point at
  if (!related && relation !== 'NEW' && !opts.knownIds && relation !== 'DUPLICATE') relation = 'NEW';

  const recs = Array.isArray(x.recommendations) ? x.recommendations : typeof x.recommendations === 'string' ? [x.recommendations] : [];
  const cat = str(x.category_fix);
  const prop = str(x.proposed_headline);
  return {
    topic_fit: topicFit,
    matched_topic: str(x.matched_topic) || null,
    scores: scores as CardScore['scores'],
    decision: decideFromScores(topicFit, relation, scores),
    relation, related_id: related,
    reason: str(x.reason).slice(0, 300),
    recommendations: recs.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim().slice(0, 300)).slice(0, 6),
    category_fix: cat && cat.toLowerCase() !== 'null' && cat.toLowerCase() !== 'none' ? cat : null,
    proposed_headline: prop || null,
  };
}

/** Pulls the per-card entries out of a batch reply: {scores:[...]}, {cards|results|items:[...]}, a bare array, an id-keyed object or one card's object. */
export function extractEntries(parsed: unknown, ids: readonly string[]): Array<unknown | undefined> {
  let list: unknown[] | null = null;
  let byId: Record<string, unknown> | null = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    for (const k of ['scores', 'cards', 'results', 'items', 'evaluations']) if (Array.isArray(o[k])) { list = o[k] as unknown[]; break; }
    if (!list) {
      if (ids.some((id) => o[id] && typeof o[id] === 'object')) byId = o;
      else if ('topic_fit' in o || 'relation' in o || 'decision' in o) list = [o];
      else if (o.scores && typeof o.scores === 'object') list = [o];
    }
  }
  return ids.map((id, i) => {
    if (byId) return byId[id];
    if (!list) return undefined;
    const hit = list.find((e) => e && typeof e === 'object' && String((e as Record<string, unknown>).id ?? '') === id);
    if (hit) return hit;
    const atIndex = list[i];
    const hasId = atIndex && typeof atIndex === 'object' && (atIndex as Record<string, unknown>).id !== undefined;
    return list.length === ids.length && !hasId ? atIndex : undefined;      // by position only when the entry carries no (wrong) id
  });
}

export const REPORT_CARD = `Element gives busy people business and market news affecting money, jobs and lives. Topic must fit markets, economy, known companies, consumer safety/money, consequential regulators, broad tech/science, or major world events. Exclude niche paperwork, Form 144, routine SEC exhibits/amendments, trivial micro-cap, local crime, celebrity/sports without business impact, opinion, speculation, private-person stories, guesses. Score 0-2 (0 fails, 1 small fix, 2 good): headline (sentence case, verb, ~40-80 chars, no clickbait/jargon/form numbers), summary (2-3 plain sentences, adds why it matters, neutral), trust (source link, AI label, fresh, not a duplicate), importance, category (expected one; else category_fix), necessary_info (who/what/how much/when/why), key_points (3-5 clear bullets), concise. relation to a RECENT card: DUPLICATE (same facts and angle), UPDATE (same story, newer facts), ANGLE (same story, different effect), RELATED (different story, same company/theme), NEW. related_id must be an id from RECENT. Never invent facts.
FORMAT AND EDITING CHECK (you run it; the one revision carries it out): headline clear, plain, one statement, 40-80 chars, verb first, no jargon; summary 2-3 short sentences, first sentence adds to (never repeats) the headline, no filler, correct casing and spacing; category fits; key points 3-5 clear one-sentence bullets. Put each fix in recommendations as a short imperative edit.`;
const SHAPE = '{"scores":[{"id":"<card id>","topic_fit":true,"matched_topic":"markets","scores":{"headline":2,"summary":2,"trust":2,"importance":2,"category":2,"necessary_info":2,"key_points":2,"concise":2},"relation":"NEW","related_id":null,"category_fix":null,"reason":"3-8 words","recommendations":["source-grounded fix"]}]}';

const brief = (c: CardLike) => ({
  id: c.id, headline: c.headline, summary: c.body, category: c.category, as_of: c.as_of, ai: c.ai_generated,
  sources: c.sources?.map((s) => ({ name: s.name, url: s.url })),
  ...(c.detail ? { detail: JSON.stringify(c.detail).slice(0, 700) } : {}),
});

/** Compact prompt for a batch of cards. The word "JSON" must appear (Groq JSON mode requires it). The batch cards are left out of the comparison list. */
export function scoreBatchPrompt(cards: CardLike[], recent: RecentLike[] = []): string {
  const batchIds = new Set(cards.map((c) => c.id));
  const others = recent.filter((r) => !batchIds.has(r.id)).slice(0, config.reportCard.scoreMaxRecentCards)
    .map((r) => ({ id: r.id, h: r.headline.slice(0, 110) }));
  return `${REPORT_CARD}\nScore every card in CARDS. Compare each one with RECENT and with the other cards in CARDS. Reply with one JSON object shaped like ${SHAPE} (one entry per card, same ids). Do not put the relation in any other field.\nCARDS ${JSON.stringify(cards.map(brief))}\nRECENT ${JSON.stringify(others)}`;
}
/** Single-card prompt (same format as the batch prompt). */
export const scorePrompt = (card: CardLike, recent: RecentLike[] = []): string => scoreBatchPrompt([card], recent);

/** One scorer call for up to a batch of cards; each card gets a CardScore or an Error (a bad entry or a failed call never throws). */
export async function scoreCards(client: ScoreClient, cards: CardLike[], recent: RecentLike[] = []): Promise<Array<CardScore | Error>> {
  if (!cards.length) return [];
  let parsed: unknown;
  try { parsed = parseJsonLoose(await client.generate(scoreBatchPrompt(cards, recent))); }
  catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return cards.map(() => err); }
  const ids = cards.map((c) => c.id);
  const known = new Set<string>([...recent.map((r) => r.id), ...ids]);
  const entries = extractEntries(parsed, ids);
  return cards.map((c, i) => {
    const e = entries[i];
    if (e === undefined) return new Error(`report-card: no entry for card ${c.id}`);
    const withId = e && typeof e === 'object' && !Array.isArray(e) ? { ...(e as Record<string, unknown>), id: c.id } : e;
    try { return normalizeScore(withId, { knownIds: new Set([...known].filter((k) => k !== c.id)), selfId: c.id }); }
    catch (err) { return err instanceof Error ? err : new Error(String(err)); }
  });
}

/** Scores many cards in batches (config.reportCard.scoreBatchSize, default 3); batch cards are excluded from the comparison list. */
export async function scoreAll(client: ScoreClient, cards: CardLike[], recent: RecentLike[] = [], batchSize: number = config.reportCard.scoreBatchSize): Promise<Array<CardScore | Error>> {
  const out: Array<CardScore | Error> = [];
  for (let i = 0; i < cards.length; i += Math.max(1, batchSize)) out.push(...await scoreCards(client, cards.slice(i, i + Math.max(1, batchSize)), recent));
  return out;
}

/** Scores one card; throws if the reply cannot be used. */
export async function scoreCard(client: ScoreClient, card: CardLike, recent: RecentLike[] = []): Promise<CardScore> {
  const [r] = await scoreCards(client, [card], recent);
  if (!r || r instanceof Error) throw r ?? new Error('invalid report-card JSON');
  return r;
}

export interface ReviewOutcome<P> {
  verdict: 'publish' | 'abandon' | 'duplicate' | 'revise_failed' | 'unscored';
  payload: P; score: CardScore | null; scoreCalls: number; revised: boolean; error?: string;
}
/**
 * The protocol for one freshly written card: score -> (REVISE: one rewrite through `rewrite`, which must
 * re-validate, then re-score) -> publish / abandon. Never throws: a scorer failure gives 'unscored'
 * (the caller leaves the item for a later run); a rewrite failure gives 'revise_failed'.
 */
export async function reviewCard<P extends { headline: string; body: string | null; category: string }>(o: {
  client: ScoreClient; card: Omit<CardLike, 'headline' | 'body' | 'category'>; payload: P; recent: RecentLike[]; rewrite: (recommendations: string[]) => Promise<P>;
}): Promise<ReviewOutcome<P>> {
  let payload = o.payload, scoreCalls = 0, revised = false;
  const as = (p: P): CardLike => ({ ...o.card, headline: p.headline, body: p.body, category: p.category });
  let score: CardScore | Error;
  scoreCalls++;
  [score] = await scoreCards(o.client, [as(payload)], o.recent) as [CardScore | Error];
  if (score instanceof Error) return { verdict: 'unscored', payload, score: null, scoreCalls, revised, error: score.message };
  if (score.decision === 'REVISE') {
    try {
      payload = await o.rewrite(score.recommendations);
      revised = true; scoreCalls++;
      const [again] = await scoreCards(o.client, [as(payload)], o.recent) as [CardScore | Error];
      if (again instanceof Error) return { verdict: 'unscored', payload, score, scoreCalls, revised, error: again.message };
      score = again;
    } catch (e) { return { verdict: 'revise_failed', payload, score, scoreCalls, revised, error: (e as Error).message }; }
    if (score.decision === 'REVISE') return { verdict: 'revise_failed', payload, score, scoreCalls, revised };
  }
  if (score.relation === 'DUPLICATE') return { verdict: 'duplicate', payload, score, scoreCalls, revised };
  if (score.decision === 'ABANDON') return { verdict: 'abandon', payload, score, scoreCalls, revised };
  return { verdict: 'publish', payload, score, scoreCalls, revised };
}

export interface AuditActions { revise(p: RevisePayload): Promise<unknown>; hide(id: string, note: string): Promise<unknown>; link(id: string, related: string, kind: string): Promise<unknown> }
export async function applyAudit(cards: RevisableCard[], scores: CardScore[], actions: AuditActions, reviseText: (card: RevisableCard, recommendations: string[]) => Promise<{ headline: string; body: string | null }>, rescore: (card: RevisableCard, text: { headline: string; body: string | null }) => Promise<CardScore>) {
  const hideCount = scores.filter((s) => s.decision === 'ABANDON').length;
  if (cards.length && hideCount / cards.length > config.reportCard.auditHideMaxFraction) throw new Error('audit hide safety cap exceeded');
  const undo: Array<{ id: string; old_text: { headline: string; body: string | null }; new_text?: { headline: string; body: string | null }; old_status: 'published' }> = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!, s = scores[i]!;
    if (s.decision === 'ABANDON') { await actions.hide(c.id, s.reason || 'report_card_abandon'); undo.push({ id: c.id, old_text: { headline: c.headline, body: c.body }, old_status: 'published' }); continue; }
    if (s.decision === 'REVISE') { const t = await reviseText(c, s.recommendations); const updated = { ...c, ...t }; const check = await rescore(updated, t); if (check.decision === 'PASS') { await actions.revise({ id: c.id, action: 'revise', headline: t.headline, body: t.body, ai_generated: true, model: config.groq.model, prompt_version: config.reportCard.scorePromptVersion, detail: null }); undo.push({ id: c.id, old_text: { headline: c.headline, body: c.body }, new_text: t, old_status: 'published' }); } }
    if (['UPDATE', 'ANGLE', 'RELATED'].includes(s.relation) && s.related_id) await actions.link(c.id, s.related_id, s.relation.toLowerCase());
  }
  return undo;
}
export function auditTable(rows: Array<{ card: RevisableCard; score: CardScore }>): string { return rows.map(({ card: c, score: s }) => `${s.decision === 'PASS' ? '✓' : s.decision === 'REVISE' ? '✎' : '×'} ${c.category}${s.category_fix ? ` → ${s.category_fix}` : ''} | ${s.reason} | ${s.recommendations[0] ?? ''}`).join('\n'); }
