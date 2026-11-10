// Card corpora for the offline evaluations.
//  - synthCorpus(seed, scale): a deterministic synthetic corpus shaped like the live feed on 2026-11-09
//    (about 290 published cards: earnings 20%, markets 20%, deals 11%, economy 9%, policy 9% of which about
//    half are FAA / FCC Federal Register rules, science 6%, recalls 23% (most sold through Amazon / Walmart
//    by small sellers), world 2%; ages spread over 180 days, few in the last day). scale multiplies the count
//    (ages spread over the same window), for the speed runs at 10x / 100x.
//  - loadCards(db, cards): inserts cards in the api card shape (core.cards_json: headline, body, category,
//    event_type, kind, importance, sort_at, tickers, macro, detail, sources, attribution). A local snapshot of
//    the public feed can be passed the same way (never committed: data files stay out of git).
// rank_score is set the way core.refresh_rank does it for a single-source card (hours of sort_at + H log2 importance).

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

const TECH = [['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['GOOGL', 'Alphabet'], ['META', 'Meta'], ['NVDA', 'Nvidia'], ['AMZN', 'Amazon']];
const BANKS = [['JPM', 'JPMorgan Chase'], ['GS', 'Goldman Sachs'], ['WFC', 'Wells Fargo'], ['C', 'Citigroup'], ['PNC', 'PNC Financial Services'], ['STT', 'State Street']];
const CONSUMER = [['SBUX', 'Starbucks'], ['LULU', 'Lululemon'], ['WMT', 'Walmart'], ['TGT', 'Target'], ['COST', 'Costco'], ['DAL', 'Delta Air Lines'], ['CCL', 'Carnival'], ['TSLA', 'Tesla'], ['LCID', 'Lucid']];
export const SECTOR = Object.fromEntries([...TECH.map(([t]) => [t, 'tech']), ...BANKS.map(([t]) => [t, 'bank']), ...CONSUMER.map(([t]) => [t, 'consumer'])]);
const ALLCO = [...TECH, ...BANKS, ...CONSUMER];
const PLACES = ['Japan region', 'Vanuatu', 'Chile', 'Alaska', 'Indonesia', 'Peru', 'Russia', 'China'];
const PLANES = ['Boeing 737', 'Boeing 787', 'Airbus A330', 'Embraer 175', 'Boeing 757', 'Airbus A320'];
const PRODUCTS = ['dressers', 'baby bottles', 'bicycle helmets', 'power banks', 'teething toys', 'space heaters', 'bed rails', 'patio swings', 'dumbbells', 'nursing pillows'];
const BRANDS = ['Hasuit', 'Gudook', 'Arlopu', 'Yinklev', 'Kikea', 'Truststone', 'Busoha', 'Titan', 'EnHomee', 'Pillani'];
const HAZ = ['fire hazard', 'choking hazard', 'tip-over hazard', 'fall hazard', 'burn hazard'];

function src(name, kind, license, url, attribution = null) {
  return [{ name, kind, license_class: license, url, is_primary: true, attribution }];
}

// one card; i makes dedupe keys unique, age in hours
function make(r, i, age) {
  const roll = r();
  const at = new Date(Date.now() - age * 3600e3).toISOString();
  const pct = (a, b) => (a + r() * (b - a)).toFixed(2);
  if (roll < 0.20) { // earnings
    const [t, n] = pick(r, ALLCO);
    const q = pick(r, ['third quarter', 'second quarter']);
    return { headline: `${n} reports ${q} revenue of $${pct(1, 90)} billion`, body: `${n} said net income rose and shares moved after the ${q} results. The company updated its outlook.`,
      category: 'earnings', event_type: 'earnings', kind: 'summary', importance: 6, tickers: [{ symbol: t, name: n }], sources: src('SEC', 'filing', 'company_filing', `https://www.sec.gov/e/${i}`), at, _topic: 'earnings', _co: t };
  }
  if (roll < 0.30) { // markets: yields (data)
    const y = pick(r, [['DGS2', '2-year'], ['DGS10', '10-year'], ['DGS5', '5-year']]);
    const dir = r() < 0.5 ? 'rises' : 'falls';
    return { headline: `${y[1]} Treasury yield ${dir} to ${pct(3.9, 5.2)}%`, body: `The ${y[1]} Treasury yield ${dir} as investors weigh the interest rate outlook from the Federal Reserve.`,
      category: 'markets', event_type: 'data', kind: 'data', importance: 10, macro: [{ series_id: y[0] }], sources: src('U.S. Treasury', 'government', 'public_domain', `https://home.treasury.gov/y/${i}`), at, _topic: 'rates' };
  }
  if (roll < 0.40) { // markets: leadership 8-K
    const [t, n] = pick(r, ALLCO);
    return { headline: `${n} reports a change in its top leaders`, body: `${n} named a new chief financial officer in a filing. The former officer will stay on as an adviser.`,
      category: 'markets', event_type: 'leadership', kind: 'summary', importance: 3, tickers: [{ symbol: t, name: n }], sources: src('SEC', 'filing', 'company_filing', `https://www.sec.gov/l/${i}`), at, _topic: 'leadership', _co: t };
  }
  if (roll < 0.51) { // deals
    const [t, n] = pick(r, ALLCO);
    const d = pick(r, [`${n} secures $${pct(1, 9)} billion credit facility`, `${n} agrees to acquire a software maker`, `${n} issues senior notes`]);
    return { headline: d, body: `${n} disclosed the borrowing terms in a filing. The deal adds to its financing options.`,
      category: 'deals', event_type: 'deal', kind: 'summary', importance: 4, tickers: [{ symbol: t, name: n }], sources: src('SEC', 'filing', 'company_filing', `https://www.sec.gov/d/${i}`), at, _topic: 'deals', _co: t };
  }
  if (roll < 0.60) { // economy (data)
    const e = pick(r, [
      ['CPIAUCSL', `Consumer prices up ${pct(2.5, 4)}% from a year earlier`, 'Inflation stayed above the Federal Reserve goal as prices for shelter and food rose.', 'inflation'],
      ['PAYEMS', `Nonfarm payroll jobs rise to ${pct(158, 160)}M`, 'Employers added jobs last month, the jobs report shows.', 'jobs'],
      ['UNRATE', `Unemployment rate rises to ${pct(3.9, 4.4)}%`, 'The jobless rate moved as more people looked for work.', 'jobs'],
      ['HOUST', `Housing starts fall to ${pct(1.1, 1.4)}M (annual rate)`, 'Builders started fewer new homes as mortgage rates stayed high.', 'housing'],
      ['BOPGSTB', `U.S. trade deficit shrinks to $${pct(90, 110)} billion`, 'Imports fell faster than exports.', 'trade'],
      ['A191RL1Q225SBEA', `Real GDP growth rate rises to ${pct(1, 4)}%`, 'The economy grew faster than expected.', 'gdp']]);
    return { headline: e[1], body: e[2], category: 'economy', event_type: 'data', kind: 'data', importance: 10, macro: [{ series_id: e[0] }],
      sources: src('Bureau of Labor Statistics', 'government', 'public_domain', `https://www.bls.gov/x/${i}`), at, _topic: e[3] };
  }
  if (roll < 0.645) { // policy: Fed or economic Federal Register
    const e = pick(r, [
      ['Fed holds federal funds rate target range steady', 'The Federal Reserve kept its policy rate unchanged and signalled a possible rate cut later.', 'Federal Reserve Board', 'fed', null],
      ['Federal Reserve releases FOMC meeting minutes', 'Officials debated how fast to cut interest rates.', 'Federal Reserve Board', 'fed', null],
      ['OCC issues rules for payment stablecoins', 'Banks get new rules for issuing stablecoins.', 'Federal Register', 'policy-econ', 'Source: Federal Register (National Archives), Comptroller of the Currency'],
      ['IRS finalises rules for paying taxes by card', 'Taxpayers can pay with cards under the final rule.', 'Federal Register', 'policy-econ', 'Source: Federal Register (National Archives), Internal Revenue Service']]);
    return { headline: e[0], body: e[1], category: 'policy', event_type: e[3] === 'fed' ? 'fed' : 'rule', kind: 'summary', importance: e[3] === 'fed' ? 10 : 2.5, attribution: e[4],
      sources: src(e[2], 'government', 'public_domain', `https://www.federalregister.gov/p/${i}`, e[4]), at, _topic: e[3] === 'fed' ? 'rates' : 'policy-econ' };
  }
  if (roll < 0.69) { // policy: non-economic Federal Register (FAA, FCC)
    const plane = pick(r, PLANES);
    const faa = r() < 0.8;
    const att = faa ? 'Source: Federal Register (National Archives), Federal Aviation Administration' : 'Source: Federal Register (National Archives), Federal Communications Commission';
    return { headline: faa ? `FAA orders fixes for some ${plane} planes` : 'FCC updates rules for stopping unwanted robocalls', body: faa ? 'Airlines must inspect and repair the parts within set deadlines.' : 'Phone companies must block more illegal calls.',
      category: 'policy', event_type: 'rule', kind: 'summary', importance: 2.5, attribution: att, sources: src('Federal Register', 'government', 'public_domain', `https://www.federalregister.gov/f/${i}`, att), at, _topic: 'faa' };
  }
  if (roll < 0.75) { // science
    const quake = r() < 0.7;
    return { headline: quake ? `Magnitude ${pct(6, 7.2).slice(0, 3)} earthquake hits ${pick(r, PLACES)}` : 'NASA awards contracts for Moon Base projects', body: quake ? 'No tsunami warning was issued.' : 'The contracts cover transport and science work.',
      category: 'science', event_type: quake ? 'quake' : 'space', kind: 'summary', importance: 1.875, sources: src(quake ? 'U.S. Geological Survey' : 'NASA', 'government', 'public_domain', `https://www.usgs.gov/s/${i}`), at, _topic: 'science' };
  }
  if (roll < 0.98) { // recalls
    const retailer = r() < 0.15;
    const brand = retailer ? pick(r, ['Walmart', 'Amazon', 'Target']) : pick(r, BRANDS);
    const prod = pick(r, PRODUCTS);
    const where = retailer ? '' : ` The items were sold on ${pick(r, ['Amazon', 'Walmart.com', 'Amazon and at Target'])}.`;
    return { headline: `${brand} recalls ${prod} over ${pick(r, HAZ)}`, body: `Stop using the ${prod} right away and contact the company for a refund.${where}`,
      category: 'safety', event_type: 'recall', kind: 'summary', importance: 1.875, sources: src('U.S. Consumer Product Safety Commission', 'government', 'public_domain', `https://www.cpsc.gov/r/${i}`), at, _topic: 'recall' };
  }
  return { headline: 'Timekeeping group votes to phase out leap seconds', body: 'Clocks will drift from the Earth rotation by design.', category: 'world', event_type: 'world', kind: 'summary', importance: 4.8,
    sources: src('Wikipedia', 'news', 'public_domain', `https://en.wikipedia.org/w/${i}`), at, _topic: 'world' };
}

export function synthCorpus(seed = 7, scale = 1) {
  const r = rng(seed);
  const n = Math.round(290 * scale);
  const out = [];
  for (let i = 0; i < n; i++) {
    // ages: 2% within 6 h, 4% within a day, the rest spread over 180 days (the live supply on 2026-11-09)
    const u = r();
    const age = u < 0.02 ? r() * 6 : u < 0.04 ? 6 + r() * 18 : 24 + r() * r() * 4300;
    const c = make(r, i, age);
    c.dedupe_key = `synth-${seed}-${i}`;
    out.push(c);
  }
  return out;
}

// Inserts cards (api shape). Returns the ids in input order. Fires the company tagging triggers; afterwards the
// recall verdicts are (re)computed from card text like the migration backfill did on the live project.
export async function loadCards(db, cards, { halfLife = 8 } = {}) {
  const ids = [];
  await db.exec(`insert into core.categories (slug, name, sort_order) values
    ('world','World',20),('science','Science & Space',21),('safety','Recalls & Safety',22) on conflict (slug) do nothing`);
  for (const [i, c] of cards.entries()) {
    const at = c.sort_at || c.at || c.published_at;
    const imp = Number(c.importance) || 2;
    const rank = Date.parse(at) / 3600e3 + halfLife * Math.log2(imp);
    const res = await db.query(
      `insert into core.blurbs (id, dedupe_key, kind, headline, body, category, event_type, status, attribution, tickers, macro, detail,
                                as_of, published_at, sort_at, importance, rank_score)
       values (coalesce($14::uuid, gen_random_uuid()), $1, $2, left($3, 90), $4, $5, $6, 'published', $7, $8::jsonb, $9::jsonb, $10::jsonb,
               $11::timestamptz, $11::timestamptz, $11::timestamptz, $12, $13)
       on conflict (dedupe_key) do nothing returning id`,
      [c.dedupe_key || c.id || `card-${i}`, c.kind === 'link_out' ? 'summary' : c.kind || 'summary', c.headline, c.body || null, c.category, c.event_type || null, c.attribution || null,
        JSON.stringify((c.tickers || []).slice(0, 5).map((t) => ({ symbol: t.symbol, name: t.name }))), JSON.stringify((c.macro || []).slice(0, 3).map((m) => ({ series_id: m.series_id }))),
        c.detail ? JSON.stringify(c.detail) : null, at, imp, rank.toFixed(6), c.id || null]);
    const id = res.rows[0]?.id; if (!id) continue;
    ids.push(id);
    for (const [p, s] of (c.sources || []).entries()) {
      await db.query(`insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary, attribution, position)
                      values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, s.name, ['filing', 'government', 'news'].includes(s.kind) ? s.kind : 'news', /^https:\/\//.test(s.url || '') ? s.url : `https://example.com/${id}/${p}`,
          ['public_domain', 'company_filing', 'guardian_noncomm', 'link_out', 'iex_hist'].includes(s.license_class) ? s.license_class : 'public_domain', p === 0, s.attribution || null, p]);
    }
  }
  await db.exec(`select core.backfill_recall_material(true)`);
  return ids;
}
