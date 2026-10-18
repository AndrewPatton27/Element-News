// What the About page says about each source: what it gives us, where it lives,
// and its reuse terms. UI copy kept in one place so it can be checked and tested.

export interface SourceInfo {
  key: string; // matches lib/sourceKeys.ts and core.source_keys
  name: string;
  gives: string;
  site: string;
  terms: { label: string; url: string };
}

export const SOURCES: SourceInfo[] = [
  {
    key: 'sec',
    name: 'SEC EDGAR',
    gives: 'Company filings (Form 8-K) from about 150 well-known companies: earnings, leadership changes, big deals, layoffs.',
    site: 'https://www.sec.gov/',
    terms: { label: 'EDGAR access rules', url: 'https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data' },
  },
  {
    key: 'fed',
    name: 'Federal Reserve',
    gives: 'Press releases and interest-rate decisions.',
    site: 'https://www.federalreserve.gov/feeds/feeds.htm',
    terms: { label: 'Website notice', url: 'https://www.federalreserve.gov/disclaimer.htm' },
  },
  {
    key: 'bea',
    name: 'Bureau of Economic Analysis (BEA)',
    gives: 'Economic releases such as GDP and personal income.',
    site: 'https://www.bea.gov/news/2026/',
    terms: { label: 'Reuse FAQ', url: 'https://www.bea.gov/help/faq/147' },
  },
  {
    key: 'fred',
    name: 'FRED (Federal Reserve Bank of St. Louis)',
    gives:
      'The “Numbers to know” and data cards, including Treasury yields. Each number names the agency that made it: Federal Reserve Board, BLS, EIA, Census, BEA or the Department of Labor.',
    site: 'https://fred.stlouisfed.org/',
    terms: { label: 'FRED terms of use', url: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html' },
  },
  {
    key: 'fedreg',
    name: 'Federal Register',
    gives:
      'New final rules from agencies that touch people’s wallets: CFPB, Transportation, FTC, IRS, Treasury, the Fed, SEC, FCC, Energy and Education.',
    site: 'https://www.federalregister.gov/',
    terms: { label: 'API and reuse', url: 'https://www.federalregister.gov/reader-aids/developer-resources/rest-api' },
  },
  {
    key: 'wikipedia',
    name: 'Wikipedia “In the news”',
    gives:
      'Major world events picked by Wikipedia editors. Adapted, credited on each card with a link to the article, and shared under the same license.',
    site: 'https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content',
    terms: { label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  },
  {
    key: 'cpsc',
    name: 'U.S. Consumer Product Safety Commission',
    gives: 'Product recalls.',
    site: 'https://www.cpsc.gov/Recalls',
    terms: { label: 'Recalls data', url: 'https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information' },
  },
  {
    key: 'usgs',
    name: 'U.S. Geological Survey',
    gives: 'Significant earthquakes.',
    site: 'https://earthquake.usgs.gov/earthquakes/feed/',
    terms: { label: 'Copyrights and credits', url: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits' },
  },
  {
    key: 'nasa',
    name: 'NASA',
    gives: 'News releases about space and science.',
    site: 'https://www.nasa.gov/news-release/',
    terms: { label: 'Media guidelines', url: 'https://www.nasa.gov/nasa-brand-center/images-and-media/' },
  },
];
