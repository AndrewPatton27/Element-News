import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { auditTable, type CardScore } from './reportCard.ts';
import type { RevisableCard, RevisePayload } from './types.ts';

const out = 'docs/work/card-audit.md';
const actionsPath = 'docs/work/card-audit-actions.json';
const batchSize = config.reportCard.auditBatchSize;
type AuditRow = { card: RevisableCard; score: CardScore };

function parseScore(x: any): CardScore {
  // The model sometimes puts the relation (NEW, RELATED...) in the decision field: the decision is recomputed from the scores below.
  if (x && typeof x === 'object' && !['PASS', 'REVISE', 'ABANDON'].includes(x.decision)) x.decision = 'PASS';
  const scoreKeys = ['headline','summary','trust','importance','category','necessary','key_points','concise'];
  if (!x || typeof x.topic_fit !== 'boolean' || !x.scores || !scoreKeys.every(k => Number.isInteger(x.scores[k]) && x.scores[k] >= 0 && x.scores[k] <= 2) || !['PASS','REVISE','ABANDON'].includes(x.decision) || !['DUPLICATE','UPDATE','ANGLE','RELATED','NEW'].includes(x.relation) || !Array.isArray(x.recommendations)) throw new Error('invalid report-card response: ' + JSON.stringify(x).slice(0, 260));
  if (!x.topic_fit || x.relation === 'DUPLICATE') x.decision = 'ABANDON';
  else if (Object.values(x.scores).some((n: any) => n === 0) || Object.values(x.scores).filter((n: any) => n === 1).length >= 2) x.decision = 'REVISE';
  return x as CardScore;
}

async function groq(apiKey: string, prompt: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try { return await groqOnce(apiKey, prompt); }
    catch (e: any) {
      const m = /HTTP 429.*try again in ([0-9.]+)s/i.exec(String(e?.message ?? ''));
      if (!m || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, Math.ceil(Number(m[1]) * 1000) + 1500));
    }
  }
}
async function groqOnce(apiKey: string, prompt: string): Promise<any> {
  const res = await fetch(config.groq.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.groq.model, messages: [{ role: 'user', content: prompt + ' Respond with one JSON object only.' }], response_format: { type: 'json_object' }, temperature: 0.1, max_completion_tokens: config.groq.maxCompletionTokens }) });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json(); const raw = j.choices?.[0]?.message?.content ?? ''; if (process.env.AUDIT_DEBUG) console.error('RAW', String(raw).slice(0, 1500)); return JSON.parse(raw);
}
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

type RecentCard = Pick<RevisableCard,'id'|'headline'|'body'|'category'|'as_of'>;
export async function runAudit(opts: { cards: RevisableCard[]; apply: boolean; noGemini: boolean; groqKey: string; revise: (card: RevisableCard, recs: string[]) => Promise<{headline:string;body:string|null;detail?:any}>; write: (p:RevisePayload)=>Promise<unknown>; hide:(id:string,note:string)=>Promise<unknown>; link:(id:string,related:string,kind:string)=>Promise<void>; score?: (cards: RevisableCard[], recent: RecentCard[]) => Promise<CardScore[]> }): Promise<AuditRow[]> {
  const cards = opts.cards;
  const scoreBatch = opts.score ?? (async (batch, recent) => {
    const brief=(c:RevisableCard)=>({id:c.id,headline:c.headline,summary:c.body,category:c.category,kind:c.kind,as_of:c.as_of,ai_generated:c.ai_generated,sources:c.sources?.map(s=>({name:s.name,url:s.url,published_at:s.published_at})),tickers:c.tickers,detail:(c as any).detail});
    const result = await groq(opts.groqKey, `Apply all six sections of the Element card report card. Score headline, summary, trust, importance, category, necessary information, key_points/detail and concise (0-2). Check who/what/when/why, facts, labels, links and freshness. Category must be expected; propose category_fix when wrong. Key points need 3-5 complete, useful bullets. Compare every supplied recent card and other cards in this batch; ignore a card with the same id; choose DUPLICATE/UPDATE/ANGLE/RELATED/NEW. Return {scores:[{id,topic_fit,matched_topic,scores:{headline,summary,trust,importance,category,necessary,key_points,concise},decision,relation,related_id,category_fix,proposed_headline,reason,recommendations}]}. Score cards: ${JSON.stringify(batch.map(brief))}. Recent seven-day cards (may include same id): ${JSON.stringify(recent.filter((r) => !batch.some((x) => x.id === r.id)))}. DUPLICATE is ABANDON. Never invent facts.`);
    return batch.map(c => parseScore(result.scores.find((s:any)=>s.id===c.id)));
  });
  const scores: CardScore[] = [];
  const cutoff = Date.now() - config.reportCard.recentCardDays*86400000;
  const recent = cards.filter(c=>Date.parse(c.as_of)>=cutoff);
  for (let i=0;i<cards.length;i+=batchSize) scores.push(...await scoreBatch(cards.slice(i,i+batchSize), recent.map(c=>({id:c.id,headline:c.headline,category:c.category,body:'',as_of:''}))));
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
      const text=await opts.revise(card,score.recommendations);
      await opts.write({id:card.id,action:'revise',headline:text.headline,body:text.body,ai_generated:true,model:config.groq.model,prompt_version:config.reportCard.scorePromptVersion,detail:text.detail ?? null});
      if (score.category_fix) categoryFixes.push(`${card.id}: ${card.category} → ${score.category_fix}`);
      undo.push({id:card.id,old_text:{headline:card.headline,body:card.body},new_text:text,old_status:'published'});
      const revised={...card,headline:text.headline,body:text.body};
      const checked=parseScore((await scoreBatch([revised], recent.filter(c=>c.id!==card.id)))[0]);
      score.decision=checked.decision; score.reason=checked.reason;
    }
    if (['UPDATE','ANGLE','RELATED'].includes(score.relation) && score.related_id) await opts.link(card.id,score.related_id,score.relation.toLowerCase());
  }
  rows=rows;
  writeFileSync(actionsPath, JSON.stringify({actions:undo,categoryFixes},null,2));
  if (categoryFixes.length) writeFileSync(out, `# Published card audit\n\nGenerated ${new Date().toISOString()}. Applied; ${cards.length} distinct live cards.\n\n${glance(rows)}\n\n## Category fixes needing a separate update\n${categoryFixes.map(x=>`- ${x}`).join('\n')}\n`);
  return rows;
}

export async function groqRevision(apiKey:string, card:RevisableCard, recommendations:string[]) {
  const result=await groq(apiKey,`Rewrite the headline, 2-3 sentence summary and detail key_points (3-5 bullets) using only existing card facts and recommendations. Keep the report-card labels and facts intact. Return {headline,body,detail:{paragraphs:[],key_points:[]}}. Recommendations: ${JSON.stringify(recommendations)}. Card: ${JSON.stringify({headline:card.headline,body:card.body})}`);
  if(typeof result.headline!=='string'||(result.body!==null&&typeof result.body!=='string')) throw new Error('invalid Groq revision');
  return {headline:result.headline,body:result.body,detail:result.detail};
}
