// The 39-query search battery shared by search-eval.mjs and scale-bench.mjs: [class, query, relevance pattern].
// Relevance is judged by the pattern over headline, summary and tickers (text() below).
export const BATTERY = [
  ['ticker', 'AAPL', /\bAAPL\b|\bApple\b/], ['ticker', 'MSFT', /MSFT|Microsoft/], ['ticker', 'JPM', /\bJPM\b|JPMorgan/],
  ['ticker', 'LCID', /LCID|Lucid/], ['ticker', '$GOOGL', /GOOGL|Alphabet/], ['ticker', 'TSLA', /TSLA|Tesla/],
  ['company', 'apple', /\bAAPL\b|^Apple /], ['company', 'microsoft', /Microsoft/], ['company', 'jpmorgan', /JPMorgan/],
  ['company', 'goldman sachs', /Goldman/], ['company', 'amazon', /\bAMZN\b|^Amazon /], ['company', 'walmart', /^Walmart |\bWMT\b/],
  ['company', 'boeing', /Boeing/], ['company', 'state street', /State Street/],
  ['typo', 'microsft', /Microsoft/], ['typo', 'lululemn', /Lululemon/], ['typo', 'starbuks', /Starbucks/],
  ['typo', 'unemployement', /[Uu]nemployment/], ['typo', 'inflaton', /[Ii]nflation|[Cc]onsumer prices/], ['typo', 'treasurey yield', /Treasury yield/],
  ['typo', 'goldmen sachs', /Goldman/],
  ['topic', 'inflation', /[Ii]nflation|[Cc]onsumer prices|CPI/], ['topic', 'rate cut', /[Ff]ederal funds|FOMC|rate cut|cut interest rates|Treasury yield/],
  ['topic', 'Fed', /\bFed\b|Federal Reserve|FOMC|federal funds/], ['topic', 'interest rates', /[Ii]nterest rate|federal funds|FOMC|Treasury yield/],
  ['topic', 'jobs report', /payroll|[Uu]nemployment|jobs report/], ['topic', 'housing', /[Hh]ousing starts|mortgage/],
  ['topic', 'earthquake', /[Ee]arthquake/], ['topic', 'recall', /[Rr]ecall/], ['topic', 'stablecoin', /stablecoin/],
  ['topic', 'gdp', /GDP|economy grew/], ['topic', 'trade deficit', /trade deficit/],
  ['multi', 'bank earnings', /^(JPMorgan|Goldman|Wells Fargo|Citigroup|PNC|State Street|U.S. Bancorp|Truist|Schwab|BlackRock|SoFi).* (reports|posts) /],
  ['multi', 'fed rate cut', /[Ff]ederal funds|FOMC|rate cut/], ['multi', 'ceo change', /top leaders|chief (executive|financial) officer/],
  ['multi', 'credit facility', /credit (facility|agreement|line)|senior notes|borrowing|financing|loan/], ['multi', '10 year treasury', /10-year Treasury/],
  ['multi', 'quarterly revenue record', /revenue/], ['multi', 'faa boeing', /FAA.*Boeing/],
];

export const text = (c) => `${c.headline} ${c.body || ''} ${(c.tickers || []).map((t) => `${t.symbol} ${t.name || ''}`).join(' ')}`;
