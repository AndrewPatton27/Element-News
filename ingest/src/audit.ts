import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { scoreCards, type CardScore } from './reportCard.ts';
import { createGroqSummarizer, parseJsonLoose } from './summarizer/groq.ts';
import type { RevisableCard, RevisePayload, Summarizer } from './types.ts';

const out = 'docs/work/card-audit.md';
const actionsPath = 'docs/work/card-audit-actions.json';
const batchSize = config.reportCard.scoreBatchSize;
type AuditRow = { card: RevisableCard; score: CardScore };

/** Groq client for the audit: paced (8,000 tokens per minute), honours the 429 retry hint, JSON mode. */
function groqClient(apiKey: string) { return createGroqSummarizer({ apiKey }) as Summarizer & Required<Pick<Summarizer, 'generate'>>; }
const JSON_WORD = ' Reply with one JSON object only.';
async function groqJson(apiKey: string, prompt: string, maxTokens = 1400): Promise<any> {
  return parseJsonLoose(await groqClient(apiKey).generate(prompt + JSON_WORD, { maxTokens }));
}
const unscored = (why: string): CardScore => ({ topic_fit: true, matched_topic: null, scores: { headline: 2, summary: 2, trust: 2, importance: 2 }, decision: 'PASS', relation: 'NEW', related_id: null, reason: 'Not scored: ' + why.slice(0, 80), recommendations: [] });
const clean = (s: string | null | undefined) => (s ?? '').replace(/[|\n\r]+/g, ' ').trim();
function glance(rows: AuditRow[]): string {
  const count = (d: string) => rows.filter(r => r.score.decision === d).length;
  const patterns = new Map<string, number>();
  for (const r of rows.filter(x => x.score.decision !== 'PASS')) { const k = clean(r.score.reason) || 'Needs review'; patterns.set(k, (patterns.get(k) ?? 0) + 1); }
  const top = [...patterns].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,n])=>`${k} (${n})`).join('; ') || 'none';
  const sources = new Map<string, number>();
  for (const r of rows.filter(x=>x.score.decision==='ABANDON')) for(const s of r.card.sources ?? []) sources.set(s.name,(sources.get(s.name)??0)+1);
  const misfit = [...sources].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,n])=>`${k} (${n})`).join(', ') || 'none';
  const ordered = [...rows].sort((a,b)=>rank(a.score.decision)-rank(b.score.decision) || (a.score.topic_fit===b.score.topic_fit?0:a.score.topic_fit?1:-1));
  const lines = ordered.map(({card:c,score:s})=>`${s.decision==='PASS'?'✓':s.decision==='REVISE'?'✎':'×'} ${c.category}${s.category_fix?` → ${s.category_fix}`:''} | ${clean(s.reason).split(' ').slice(0,6).join(' ')} | ${clean(s.recommendations[0] ?? s.category_fix ?? 'No change')}`);
  const details = ordered.filter(x=>x.score.decision!=='PASS').map(({card:c,score:s})=>`**${s.decision==='ABANDON'?'HIDE':'FIX'} — ${clean(c.headline)}**\nBefore: ${clean(c.body)}\nAfter: ${s.decision==='ABANDON'?'Hidden from feed':clean(s.proposed_headline ?? s.recommendations[0] ?? 'Revised from source facts')}`).join('\n\n');
  return `## Summary\nPASS ${count('PASS')} · FIX ${count('REVISE')} · HIDE ${count('ABANDON')}\nTop patterns: ${top}\nSources to review: ${misfit}\n\n## Cards (worst first)\n${lines.join('\n')}\n\n## Before / after\n${details || 'No changes recommended.'}`;
}
function rank(d:string){return d==='ABANDON'?0:d==='REVISE'?1:2;}

const withDetail = (c: RevisableCard) => c as RevisableCard & { detail?: unknown };
type RecentCard = Pick<RevisableCard,'id'|'headline'|'body'|'category'|'as_of'>;
export async function runAudit(opts: { cards: RevisableCard[]; apply: boolean; noGemini: boolean; groqKey: string; revise: (card: RevisableCard, recs: string[]) => Promise<{headline:string;body:string|null;detail?:any}>; write: (p:RevisePayload)=>Promise<unknown>; hide:(id:string,note:string)=>Promise<unknown>; link:(id:string,related:string,kind:string)=>Promise<void>; score?: (cards: RevisableCard[], recent: RecentCard[]) => Promise<CardScore[]> }): Promise<AuditRow[]> {
  const cards = opts.cards;
  const client = opts.groqKey ? groqClient(opts.groqKey) : null;
  const scoreBatch = opts.score ?? (async (batch: RevisableCard[], recent: RecentCard[]) => {
    if (!client) throw new Error('no Groq key');
    // One bad card never stops the batch: a card the model answered badly is listed as "Not scored".
    return (await scoreCards({ generate: (p) => client.generate(p + JSON_WORD, { maxTokens: 1800 }) }, batch.map(withDetail), recent)).map((r) => (r instanceof Error ? unscored(r.message) : r));
  });
  const scores: CardScore[] = [];
  const cutoff = Date.now() - config.reportCard.recentCardDays*86400000;
  const recent = cards.filter(c=>Date.parse(c.as_of)>=cutoff);
  for (let i=0;i<cards.length;i+=batchSize) {
    const batch=cards.slice(i,i+batchSize);
    try { scores.push(...await scoreBatch(batch, recent.map(c=>({id:c.id,headline:c.headline,category:c.category,body:'',as_of:''})))); }
    catch (e) { scores.push(...batch.map(()=>unscored((e as Error).message))); }     // a failed batch (rate limit, bad reply) never stops the audit
  }
  let rows = cards.map((card,i)=>({card,score:scores[i]!}));
  const summary = glance(rows);
  mkdirSync(dirname(out), {recursive:true});
  writeFileSync(out, `# Published card audit\n\nGenerated ${new Date().toISOString()}. ${opts.apply?'Applied':'Dry run'}; ${cards.length} distinct live cards.\n\n${summary}\n`);
  console.log(summary);
  if (!opts.apply) return rows;
  const hides = rows.filter(r=>r.score.decision==='ABANDON').length;
  if (cards.length && hides/cards.length > config.reportCard.auditHideMaxFraction) throw new Error('audit hide safety cap exceeded');
  const undo: any[] = [], categoryFixes: string[] = [];
  for (const {card,score} of rows) {
    if (score.decision==='ABANDON') { await opts.hide(card.id,score.reason); undo.push({id:card.id,old_text:{headline:card.headline,body:card.body},old_status:'published'}); }
    else if (score.decision==='REVISE') {
     try {
      const text=await opts.revise(card,score.recommendations);
      await opts.write({id:card.id,action:'revise',headline:text.headline,body:text.body,ai_generated:true,model:config.groq.model,prompt_version:config.reportCard.scorePromptVersion,detail:text.detail ?? null});
      undo.push({id:card.id,old_text:{headline:card.headline,body:card.body},new_text:text,old_status:'published'});
      const revised={...card,headline:text.headline,body:text.body};
      const checked=(await scoreBatch([revised], recent.filter(c=>c.id!==card.id)))[0]!;
      score.decision=checked.decision; score.reason=checked.reason;
     } catch (e) { console.error(`revise failed for ${card.id}: ${(e as Error).message}`); }
    }
    if (score.decision!=='ABANDON' && score.category_fix && score.category_fix!==card.category) categoryFixes.push(`node src/main.ts --fix-category ${card.id} ${score.category_fix}   (${card.category} → ${score.category_fix})`);
    if (['UPDATE','ANGLE','RELATED'].includes(score.relation) && score.related_id) await opts.link(card.id,score.related_id,score.relation.toLowerCase());
  }
  rows=rows;
  writeFileSync(actionsPath, JSON.stringify({actions:undo,categoryFixes},null,2));
  if (categoryFixes.length) writeFileSync(out, `# Published card audit\n\nGenerated ${new Date().toISOString()}. Applied; ${cards.length} distinct live cards.\n\n${glance(rows)}\n\n## Category fixes (run each line to apply; needs api.set_card_category and the service role key)\n${categoryFixes.map(x=>`- ${x}`).join('\n')}\n`);
  return rows;
}

export async function groqRevision(apiKey:string, card:RevisableCard, recommendations:string[]) {
  const result=await groqJson(apiKey,`Rewrite the headline, 2-3 sentence summary and detail key_points (3-5 bullets) using only existing card facts and recommendations. Keep the report-card labels and facts intact. Return {headline,body,detail:{paragraphs:[],key_points:[]}}. Recommendations: ${JSON.stringify(recommendations)}. Card: ${JSON.stringify({headline:card.headline,body:card.body})}`,1800);
  if(typeof result.headline!=='string'||(result.body!==null&&typeof result.body!=='string')) throw new Error('invalid Groq revision');
  return {headline:result.headline,body:result.body,detail:result.detail};
}
