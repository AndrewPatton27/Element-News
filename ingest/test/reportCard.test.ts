import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCard, applyAudit, auditTable } from '../src/reportCard.ts';
import type { RevisableCard } from '../src/types.ts';

const card = (id:string):RevisableCard => ({id,kind:'summary',headline:'Company expands factory',body:'It adds jobs.',category:'markets',event_type:null,ai_generated:true,prompt_version:null,tickers:[],macro:[],attribution:null,as_of:'2026-10-18T00:00:00Z',sort_at:'',dedupe_key:id,sources:[],item:null});
const json=(decision:'PASS'|'REVISE'|'ABANDON'='PASS',relation:'DUPLICATE'|'UPDATE'|'ANGLE'|'RELATED'|'NEW'='NEW')=>JSON.stringify({topic_fit:true,matched_topic:'business',scores:{headline:2,summary:2,trust:2,importance:2},decision,relation,related_id:relation==='NEW'?null:'older',reason:'ok',recommendations:['clarify impact']});
test('parses strict scorer response and forces duplicate to abandon',async()=>{const s=await scoreCard({generate:async()=>json('PASS','DUPLICATE')},card('1'),[{id:'older',headline:'Older'}]);assert.equal(s.decision,'ABANDON');assert.equal(s.relation,'DUPLICATE');});
test('rejects invalid score JSON',async()=>{await assert.rejects(()=>scoreCard({generate:async()=>'{bad'},card('1')));});
test('audit hide fraction guard prevents excessive hides',async()=>{const c=[card('1'),card('2')];await assert.rejects(()=>applyAudit(c,[jsonScore('ABANDON'),jsonScore('PASS')],{revise:async()=>{},hide:async()=>{},link:async()=>{}},async()=>({headline:'',body:null}),async()=>jsonScore('PASS')),/safety cap/);});
test('audit output is glanceable and includes category and action',()=>{const out=auditTable([{card:card('x'),score:jsonScore('PASS')}]);assert.match(out,/✓ markets/);assert.match(out,/test/);});
function jsonScore(decision:'PASS'|'REVISE'|'ABANDON',relation:'DUPLICATE'|'UPDATE'|'ANGLE'|'RELATED'|'NEW'='NEW'){return {topic_fit:true,matched_topic:'business',scores:{headline:2,summary:2,trust:2,importance:2},decision,relation,related_id:null,reason:'test',recommendations:[]};}
