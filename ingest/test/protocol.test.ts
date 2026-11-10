// The report-card protocol inside the pipeline (offline: fixtures, fake writer, fake scorer) and --fix-category.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { DRY_NOW, fixCategory, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, createSupabasePublisher, type Publisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { Summarizer } from '../src/types.ts';
import type { FetchLike } from '../src/allowlist.ts';

const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
function writer(log: Array<{ name: string; retry: boolean }>): Summarizer {
  let n = 0, cur = '';
  return {
    name: 'gemini', usesAi: true, model: 'fake-writer',
    async summarize(i) {
      const retry = !!i.retryErrors?.length;
      if (!retry) cur = NAMES[n++]!;
      log.push({ name: cur, retry });
      return { headline: `A short plain news card ${cur}${retry ? ' revised' : ''}`, body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 };
    },
  };
}
const ENTRY = (id: string, over: Record<string, unknown>) => ({ id, topic_fit: true, matched_topic: 'x', scores: { headline: 2, summary: 2, trust: 2, importance: 2 }, relation: 'NEW', related_id: null, reason: 'ok', recommendations: [], ...over });
/** Scorer script keyed by the headline in the prompt's CARDS section. */
function scorer(calls: string[]) {
  return {
    async generate(prompt: string) {
      const cards = prompt.slice(prompt.lastIndexOf('CARDS '), prompt.lastIndexOf('RECENT '));
      const id = /"id":"([^"]+)"/.exec(cards)![1]!;
      const h = /"headline":"([^"]+)"/.exec(cards)![1]!;
      calls.push(h);
      const out = (over: Record<string, unknown>) => JSON.stringify({ scores: [ENTRY(id, over)] });
      if (h.endsWith('alpha')) return out({});
      if (h.endsWith('bravo')) return out({ topic_fit: false, decision: 'NEW' });
      if (h.endsWith('charlie')) return out({ relation: 'DUPLICATE', related_id: 'old-1' });
      if (h.endsWith('delta')) return out({ scores: { headline: 1, summary: 0, trust: 2, importance: 2 }, recommendations: ['add why it matters'] });
      if (h.endsWith('delta revised')) return out({ relation: 'UPDATE', related_id: 'old-1', decision: 'UPDATE' });
      return out({ scores: { headline: 0, summary: 2, trust: 2, importance: 2 } });          // echo: never good enough
    },
  };
}
function setup(over: Partial<Deps> = {}, pubOver: Partial<Publisher> = {}) {
  const dry = createDryRunPublisher();
  const links: string[][] = [], statuses: string[] = [], lines: string[] = [], wlog: Array<{ name: string; retry: boolean }> = [];
  const publisher: Publisher = {
    ...dry.publisher,
    async setItemStatus(_id, status, note) { statuses.push(`${status}:${note}`); },
    async auditCards() { return [{ id: 'old-1', headline: 'Older story', body: 'x', category: 'policy', as_of: DRY_NOW.toISOString() } as any]; },
    async setStoryLink(id, related, kind) { links.push([id, related, kind]); },
    ...pubOver,
  };
  const deps: Deps = { fetchText: fixtureFetcher(), publisher, providers: [writer(wlog)], counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (l) => lines.push(l), ...over };
  return { deps, dry, links, statuses, lines, wlog };
}

test('the protocol flag is off by default (the scheduled run does not score)', async () => {
  assert.equal(config.reportCard.protocolEnabled, false);
  const calls: string[] = [];
  const t = setup({ reportCard: { scorer: scorer(calls) } });               // scorer given, but not enabled
  const s = await runOnce(t.deps, { only: ['cpsc'], limit: 5 });
  assert.equal(calls.length, 0);
  assert.equal(s.published, 5);
});

test('protocol on: PASS publishes, ABANDON/DUPLICATE do not, REVISE gets one rewrite, links are saved', async () => {
  const calls: string[] = [];
  const t = setup({ reportCard: { enabled: true, scorer: scorer(calls) } });
  const s = await runOnce(t.deps, { only: ['cpsc'], limit: 5 });
  assert.deepEqual(t.dry.cards.map((c) => c.headline), ['A short plain news card alpha', 'A short plain news card delta revised'], t.lines.join('\n'));
  assert.equal(s.published, 2);
  assert.equal(s.report_pass, 2);
  assert.equal(s.report_duplicate, 1);
  assert.equal(s.report_abandon, 3);                                         // bravo, charlie (duplicate), echo (revise failed)
  assert.equal(s.report_revise, 2);                                          // delta and echo each got one rewrite
  assert.deepEqual(t.wlog.filter((w) => w.retry).map((w) => w.name), ['delta', 'echo'], 'exactly one rewrite each');
  assert.deepEqual([...t.statuses].sort(), ['skipped:duplicate_story', 'skipped:report_card_abandon', 'skipped:report_card_revise_failed']);
  assert.equal(t.links.length, 1);
  assert.deepEqual([t.links[0]![1], t.links[0]![2]], ['old-1', 'update']);
});

test('protocol on: a failing setStoryLink is tolerated', async () => {
  const t = setup({ reportCard: { enabled: true, scorer: scorer([]) } }, { setStoryLink: async () => { throw new Error('rpc down'); } });
  const s = await runOnce(t.deps, { only: ['cpsc'], limit: 5 });
  assert.equal(s.published, 2);
  assert.equal(s.failed, 0);
});

test('protocol on: a scorer that is down or returns junk fails open: cards publish unscored and nothing crashes', async () => {
  for (const generate of [async () => { throw new Error('Groq HTTP 429'); }, async () => 'not json', async () => '{"scores":[{"id":"x"}]}']) {
    const t = setup({ reportCard: { enabled: true, scorer: { generate } } });
    const s = await runOnce(t.deps, { only: ['cpsc'], limit: 5 });
    assert.ok(s.published > 0);
    assert.equal(s.report_unscored, s.published);
    assert.equal(s.failed, 0);
    assert.deepEqual(t.statuses, [], 'no item is skipped or failed');
    assert.ok(t.lines.some((l) => /report_card_unscored/.test(l)));
  }
});

test('protocol on: template cards are never scored', async () => {
  const calls: string[] = [];
  const tpl: Summarizer = { name: 'template', usesAi: false, async summarize() { throw new Error('unused'); } };
  const t = setup({ providers: [tpl], reportCard: { enabled: true, scorer: scorer(calls) } });
  await runOnce(t.deps, { only: ['usgs'] });
  assert.equal(calls.length, 0);
  assert.ok(t.dry.cards.length > 0);
});

// ---- the REVISE rewrite runs every draft check (copy limit, numbers in source, shape, detail) -------------
/** Writer for the Apple 8-K fixture: a valid first draft; the rewrite copies a 15-word run and invents a number. */
function copyingWriter(log: string[]): Summarizer {
  return {
    name: 'gemini', usesAi: true, model: 'fake-writer',
    async summarize(i) {
      const money = /\$\d[\d,.]*\d (?:billion|million)/.exec(i.text)?.[0] ?? '$1 billion';
      if (!i.retryErrors?.length) {
        log.push('first');
        return { headline: 'Apple shares its latest quarterly results', body: `Sales came to ${money} for the period. The company told the SEC in a filing.`, category: 'earnings', event_type: 'earnings', tickers: [], everyday_relevance: 4 };
      }
      log.push('rewrite');
      const words = i.text.replace(/\s+/g, ' ').split(' ');
      const at = words.findIndex((_, k) => k > 20 && words.slice(k, k + 15).every((w) => /^[A-Za-z,]+$/.test(w)));
      assert.ok(at > 0, 'the fixture has a 15-word run without numbers');
      const run = words.slice(at, at + 15).join(' ').replace(/,$/, '');             // 15 consecutive source words
      return { headline: 'Apple shares its latest quarterly results', body: `Sales came to ${money} for the period. ${run}. It added 987654 new users.`, category: 'earnings', event_type: 'earnings', tickers: [], everyday_relevance: 4 };
    },
  };
}

test('protocol on: a REVISE rewrite that copies 15 words from an 8-K and invents a number is not published', async () => {
  const wlog: string[] = [];
  const revise = { async generate(prompt: string) {
    const cards = prompt.slice(prompt.lastIndexOf('CARDS '), prompt.lastIndexOf('RECENT '));
    const id = /"id":"([^"]+)"/.exec(cards)![1]!;
    if (/987654/.test(cards)) return JSON.stringify({ scores: [ENTRY(id, {})] });    // the scorer likes the rewrite
    return JSON.stringify({ scores: [ENTRY(id, { scores: { headline: 1, summary: 0, trust: 2, importance: 2 }, recommendations: ['add why it matters'] })] });
  } };
  const t = setup({ providers: [copyingWriter(wlog)], reportCard: { enabled: true, scorer: revise } });
  const s = await runOnce(t.deps, { only: ['sec'], limit: 3 });
  assert.ok(wlog.includes('rewrite'), `the rewrite ran: ${t.lines.join('\n')}`);
  assert.equal(s.published, 0, t.dry.cards.map((c) => c.body).join('\n'));
  assert.ok(!t.dry.cards.some((c) => /987654/.test(c.body ?? '')), 'the invented number never reaches a card');
  assert.ok(t.statuses.includes('skipped:report_card_revise_failed'), t.statuses.join(', '));
});

// ---- --fix-category ------------------------------------------------------------------------------------
const ID = '3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b';
test('fixCategory calls set_card_category through the publisher and returns 0 / 1', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  assert.equal(await fixCategory(['--fix-category', ID, 'earnings'], dry.publisher, (l) => lines.push(l)), 0);
  assert.deepEqual(dry.categories, [{ id: ID, category: 'earnings' }]);
  assert.match(lines[0]!, /updated/);
  assert.equal(await fixCategory(['--fix-category', ID, 'earnings'], { setCardCategory: async (id, category) => ({ status: 'not_found', id, category }) }, () => {}), 1);
});
test('fixCategory validates its arguments and refuses extra options', async () => {
  const p = createDryRunPublisher().publisher;
  for (const argv of [['--fix-category'], ['--fix-category', ID], ['--fix-category', 'not-a-uuid', 'markets'], ['--fix-category', ID, 'Bad Slug!'], ['--fix-category', ID, 'markets', '--apply'], ['--dry-run', '--fix-category', ID, 'markets']]) {
    await assert.rejects(() => fixCategory(argv, p, () => {}), /usage|UUID|slug/, argv.join(' '));
  }
  await assert.rejects(() => fixCategory(['--fix-category', ID, 'markets'], {}, () => {}), /does not support/);
});
test('the Supabase publisher posts api.set_card_category with p_id and p_category', async () => {
  const calls: { url: string; body: unknown; profile: string | null }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)), profile: (init.headers as Record<string, string>)['Content-Profile'] ?? null });
    return new Response(JSON.stringify({ status: 'updated', id: ID, category: 'earnings' }), { status: 200 });
  };
  const pub = createSupabasePublisher({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_test_not_real', fetchImpl: impl });
  assert.equal(await fixCategory(['--fix-category', ID, 'earnings'], pub, () => {}), 0);
  assert.equal(calls[0]!.url, 'https://abcd1234.supabase.co/rest/v1/rpc/set_card_category');
  assert.deepEqual(calls[0]!.body, { p_id: ID, p_category: 'earnings' });
  assert.equal(calls[0]!.profile, 'api');
});
