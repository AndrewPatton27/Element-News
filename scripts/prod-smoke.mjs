// Production smoke test. Public values only: SITE_URL (default https://element-news.pages.dev),
// SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from the environment (never written to files, never printed).
// Usage: SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... node scripts/prod-smoke.mjs
// Optional: MAX_AGE_HOURS (default 6 on weekdays, 48 on weekends, UTC), EXPECT_TITLE (default "Element").
// Exit codes: 0 all checks passed, 1 a check failed, 2 missing configuration.
import { fileURLToPath } from 'node:url';

export const DEFAULT_SITE = 'https://element-news.pages.dev';

/** Newest-card age limit in hours: 48 on Saturday and Sunday (UTC), else 6, unless overridden. */
export function maxAgeHours(now = new Date(), override) {
  const n = Number(override);
  if (override !== undefined && override !== '' && Number.isFinite(n) && n > 0) return n;
  const day = now.getUTCDay();
  return day === 0 || day === 6 ? 48 : 6;
}

export function checkTitle(html, expected) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!m) return 'page has no <title>';
  return m[1].toLowerCase().includes(expected.toLowerCase()) ? null : `title "${m[1].trim()}" does not contain "${expected}"`;
}

/** First script src ending in .js, resolved against the site URL; null when none. */
export function findBundle(html, site) {
  const m = /<script[^>]*\ssrc=["']([^"']+\.js[^"']*)["']/i.exec(html);
  return m ? new URL(m[1], site).toString() : null;
}

export function checkFreshness(cards, now, limitHours) {
  if (!Array.isArray(cards) || cards.length === 0) return 'feed returned no cards';
  const times = cards.map((c) => Date.parse(c?.published_at ?? c?.sort_at)).filter(Number.isFinite);
  if (!times.length) return 'no card has a readable published_at';
  const ageH = (now.getTime() - Math.max(...times)) / 3_600_000;
  return ageH <= limitHours ? null : `newest card is ${ageH.toFixed(1)} h old (limit ${limitHours} h)`;
}

export function checkFeedStatus(x) {
  const row = Array.isArray(x) ? x[0] : x;
  if (!row || typeof row !== 'object') return 'feed_status returned nothing readable';
  return (row.delayed ?? row.is_delayed) === true ? 'feed_status says updates are delayed' : null;
}

/** Contract rules: app_config.disclaimer set; each card has >= 1 http(s) source link; AI cards carry the AI label. */
export function checkCards(cards, config) {
  const problems = [];
  if (!config || typeof config.disclaimer !== 'string' || !config.disclaimer.trim()) problems.push('app_config.disclaimer is empty');
  cards.forEach((c, i) => {
    const id = c?.id ?? `#${i}`;
    const urls = Array.isArray(c?.sources) ? c.sources.filter((s) => typeof s?.url === 'string' && /^https?:\/\//.test(s.url)) : [];
    if (!urls.length) problems.push(`card ${id} has no source link`);
    if (c?.ai?.generated === true && !(typeof c.ai.label === 'string' && c.ai.label.trim())) problems.push(`card ${id} is AI-generated but has no AI label`);
  });
  return problems;
}

const rpc = (fetchFn, base, key, name, body) =>
  fetchFn(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Accept: 'application/json', 'Accept-Profile': 'api', 'Content-Profile': 'api', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Runs every check; returns [{ name, ok, skipped, message }]. fetchFn is injectable for tests. */
export async function runSmoke({ site = DEFAULT_SITE, supabaseUrl, key, now = new Date(), fetchFn = fetch, maxAge, title = 'Element' }) {
  const results = [];
  // fn returns null (pass), a string (fail) or { skip: string }.
  const step = async (name, fn) => {
    try {
      const r = await fn();
      if (r && typeof r === 'object') results.push({ name, ok: true, skipped: true, message: r.skip });
      else results.push({ name, ok: !r, skipped: false, message: r ?? 'ok' });
    } catch (e) {
      results.push({ name, ok: false, skipped: false, message: `${e?.name ?? 'Error'}: ${e?.message ?? e}` });
    }
  };
  const base = supabaseUrl.replace(/\/+$/, '');
  const siteUrl = site.replace(/\/+$/, '') + '/';
  let html = '';
  let cards = [];
  const limit = maxAgeHours(now, maxAge);

  await step('site 200 + title', async () => {
    const res = await fetchFn(siteUrl);
    if (res.status !== 200) return `site returned HTTP ${res.status}`;
    html = await res.text();
    return checkTitle(html, title);
  });
  await step('JS bundle loads', async () => {
    const url = findBundle(html, siteUrl);
    if (!url) return 'no script bundle found in the page';
    const res = await fetchFn(url);
    if (res.status !== 200) return `bundle returned HTTP ${res.status}`;
    return (await res.text()).length > 1000 ? null : 'bundle is suspiciously small';
  });
  await step('feed returns cards', async () => {
    const res = await rpc(fetchFn, base, key, 'feed', { p_mode: 'latest', p_cursor: null, p_limit: 20, p_category: null });
    if (!res.ok) return `feed RPC returned HTTP ${res.status}`;
    const page = await res.json();
    cards = Array.isArray(page?.items) ? page.items : [];
    return cards.length ? null : 'feed returned no cards';
  });
  await step(`newest card within ${limit} h`, async () => checkFreshness(cards, now, limit));
  await step('feed_status not delayed', async () => {
    const res = await rpc(fetchFn, base, key, 'feed_status', {});
    if (res.status === 404) return { skip: 'api.feed_status not present' };
    if (!res.ok) return `feed_status returned HTTP ${res.status}`;
    return checkFeedStatus(await res.json());
  });
  await step('cards: source link, disclaimer, AI label', async () => {
    const res = await fetchFn(`${base}/rest/v1/app_config?select=*&limit=1`, { headers: { apikey: key, Accept: 'application/json', 'Accept-Profile': 'api' } });
    if (!res.ok) return `app_config returned HTTP ${res.status}`;
    const rows = await res.json();
    const problems = checkCards(cards, Array.isArray(rows) ? rows[0] : rows);
    return problems.length ? problems.slice(0, 5).join('; ') : null;
  });
  return results;
}

export function formatTable(results) {
  const w = Math.max(...results.map((r) => r.name.length));
  return results.map((r) => `${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.message}`).join('\n');
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (public values) in the environment.');
    process.exit(2);
  }
  const results = await runSmoke({ site: process.env.SITE_URL || DEFAULT_SITE, supabaseUrl, key, maxAge: process.env.MAX_AGE_HOURS, title: process.env.EXPECT_TITLE || 'Element' });
  console.log(formatTable(results));
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nSMOKE FAILED: ${failed} check(s)` : '\nSMOKE PASSED');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
