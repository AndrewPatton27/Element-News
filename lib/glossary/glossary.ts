// D-02 tap-to-define (flag `glossary`): about 60 finance terms with a plain one- or two-sentence meaning. Static text
// written for Element, no AI and no network. Informational only: a definition says what a word means, never what to do.
// Pure: no React imports (lib/__tests__/glossary.test.ts).

export interface GlossaryTerm {
  term: string; // as shown in the sheet title
  match: string[]; // phrases found in card text (case-insensitive, whole words)
  meaning: string;
}

export const GLOSSARY: GlossaryTerm[] = [
  { term: 'Basis point', match: ['basis points', 'basis point', 'bps', 'bp'], meaning: 'One hundredth of a percentage point. A move of 25 basis points is a quarter of a percentage point.' },
  { term: 'GDP', match: ['gross domestic product', 'GDP'], meaning: 'Gross domestic product: the total value of everything a country produces in a period. It is the main measure of the size of an economy.' },
  { term: 'CPI', match: ['consumer price index', 'CPI'], meaning: 'Consumer price index: tracks how much a typical basket of goods and services costs. Its yearly change is a common measure of inflation.' },
  { term: 'PCE', match: ['personal consumption expenditures', 'PCE'], meaning: 'Personal consumption expenditures: a price measure from the Commerce Department. The Federal Reserve watches it for its 2% inflation goal.' },
  { term: 'Inflation', match: ['inflation'], meaning: 'The rate at which prices in general rise over time, so each dollar buys less.' },
  { term: 'Disinflation', match: ['disinflation'], meaning: 'Prices still rise, but more slowly than before. It is not the same as prices falling.' },
  { term: 'Recession', match: ['recession'], meaning: 'A broad, lasting fall in economic activity, often seen as jobs, spending and output all shrinking for months.' },
  { term: 'Fed funds rate', match: ['fed funds rate', 'federal funds rate', 'fed funds'], meaning: 'The interest rate banks charge each other for overnight loans. The Federal Reserve sets a target range for it, and many other rates follow.' },
  { term: 'FOMC', match: ['FOMC', 'Federal Open Market Committee'], meaning: 'Federal Open Market Committee: the Federal Reserve group that meets about eight times a year to set the target interest rate.' },
  { term: 'Treasury yield', match: ['treasury yields', 'treasury yield', 'yields', 'yield'], meaning: 'The annual return an investor earns from a government bond at its current price. Yields move opposite to bond prices.' },
  { term: 'Yield curve', match: ['yield curve'], meaning: 'A line comparing Treasury yields across different lengths of time. When short-term yields are higher than long-term ones, the curve is called inverted.' },
  { term: 'Inverted yield curve', match: ['inverted yield curve', 'inverted curve', 'inversion'], meaning: 'Short-term Treasury yields are higher than long-term ones. It has often come before slowdowns, though not every time.' },
  { term: 'Quantitative tightening', match: ['quantitative tightening'], meaning: 'The Federal Reserve letting bonds it holds mature without replacing them, which shrinks its balance sheet and takes money out of the system.' },
  { term: 'Balance sheet', match: ['balance sheet'], meaning: 'A list of what an organization owns (assets) and owes (liabilities) at one moment.' },
  { term: 'Mortgage rate', match: ['mortgage rates', 'mortgage rate'], meaning: 'The interest rate on a home loan. Higher rates make the same loan cost more each month.' },
  { term: 'Payrolls', match: ['nonfarm payrolls', 'non-farm payrolls', 'payrolls'], meaning: 'The number of paid jobs in the economy outside farms. The monthly count is the jobs report from the Bureau of Labor Statistics.' },
  { term: 'Unemployment rate', match: ['unemployment rate'], meaning: 'The share of people who want a job and are looking for one but do not have one.' },
  { term: 'Jobless claims', match: ['jobless claims', 'initial claims'], meaning: 'The number of people who filed for unemployment benefits for the first time in a week. It is an early sign of layoffs.' },
  { term: 'Tariff', match: ['tariffs', 'tariff'], meaning: 'A tax a government charges on imported goods. Importers often pass part of it on in prices.' },
  { term: 'Trade deficit', match: ['trade deficit'], meaning: 'A country buys more from other countries (imports) than it sells to them (exports) in a period.' },
  { term: 'Earnings per share', match: ['earnings per share', 'EPS', 'diluted EPS'], meaning: 'A company profit divided by its number of shares. It lets you compare profit between companies of different sizes.' },
  { term: 'GAAP', match: ['GAAP', 'non-GAAP'], meaning: 'Generally Accepted Accounting Principles: the standard U.S. accounting rules. Non-GAAP figures leave out some items a company chooses.' },
  { term: 'Guidance', match: ['guidance', 'outlook'], meaning: 'The forecast a company gives for its own coming results, such as expected revenue or profit.' },
  { term: 'Revenue', match: ['revenue', 'revenues'], meaning: 'All the money a company brings in from sales before costs are taken out. Also called sales.' },
  { term: 'Net income', match: ['net income', 'net profit'], meaning: 'What is left of a company revenue after all costs, interest and taxes. Also called profit or earnings.' },
  { term: 'Operating margin', match: ['operating margin'], meaning: 'The share of revenue left after the costs of running the business, before interest and taxes.' },
  { term: 'Free cash flow', match: ['free cash flow'], meaning: 'Cash a company generates after paying to run and maintain the business. It is what is left for debt, dividends and growth.' },
  { term: 'Year over year', match: ['year over year', 'year-over-year', 'YoY'], meaning: 'Compared with the same period a year earlier, which removes seasonal swings.' },
  { term: 'Sequential', match: ['sequentially', 'quarter over quarter', 'quarter-over-quarter', 'QoQ'], meaning: 'Compared with the period just before, such as this quarter against the last one.' },
  { term: 'Market capitalization', match: ['market capitalization', 'market cap'], meaning: 'The total value of a company shares: share price times the number of shares.' },
  { term: 'Dividend', match: ['dividends', 'dividend'], meaning: 'A payment some companies make to shareholders out of profit, usually every quarter.' },
  { term: 'Share buyback', match: ['share buybacks', 'share buyback', 'buybacks', 'buyback', 'repurchase'], meaning: 'A company buys its own shares from the market. That leaves fewer shares, so each remaining share owns a bigger slice.' },
  { term: 'IPO', match: ['initial public offering', 'IPO'], meaning: 'Initial public offering: the first time a company sells its shares to the public on a stock exchange.' },
  { term: 'Merger', match: ['mergers', 'merger'], meaning: 'Two companies combine into one.' },
  { term: 'Acquisition', match: ['acquisitions', 'acquisition', 'acquires', 'acquire'], meaning: 'One company buys another company or a large part of it.' },
  { term: 'Form 8-K', match: ['Form 8-K', '8-K'], meaning: 'A report U.S. public companies file with the SEC to announce major events, such as a deal, a leader leaving or results.' },
  { term: 'Form 10-K', match: ['Form 10-K', '10-K'], meaning: 'The yearly report a U.S. public company files with the SEC. It covers the business, risks and audited finances.' },
  { term: 'Form 10-Q', match: ['Form 10-Q', '10-Q'], meaning: 'The quarterly report a U.S. public company files with the SEC, with unaudited results for the quarter.' },
  { term: 'SEC', match: ['SEC', 'Securities and Exchange Commission'], meaning: 'Securities and Exchange Commission: the U.S. regulator that oversees stock markets and public company reporting.' },
  { term: 'Stockholder rights plan', match: ['stockholder rights plan', 'shareholder rights plan', 'poison pill'], meaning: 'A defense that makes a takeover more expensive by letting existing shareholders buy more shares cheaply if one buyer gets too large a stake.' },
  { term: 'Depositary shares', match: ['depositary shares'], meaning: 'Shares that stand for a fraction of another security, often a preferred share, so it can be sold in smaller pieces.' },
  { term: 'Preferred stock', match: ['preferred stock', 'preferred shares'], meaning: 'A kind of share that usually pays a fixed dividend and is paid before common shareholders if a company is wound up.' },
  { term: 'Senior notes', match: ['senior notes'], meaning: 'Bonds that must be repaid before other kinds of company debt if the company runs into trouble.' },
  { term: 'Credit rating', match: ['credit rating', 'credit ratings'], meaning: 'A grade from a rating agency of how likely a borrower is to repay its debt.' },
  { term: 'Bond', match: ['bonds', 'bond'], meaning: 'A loan to a government or company that pays interest and is repaid on a set date.' },
  { term: 'Volatility', match: ['volatility'], meaning: 'How much and how fast a price moves up and down. High volatility means bigger swings.' },
  { term: 'Bull market', match: ['bull market'], meaning: 'A stretch when stock prices are rising broadly, often defined as a rise of 20% or more from a low.' },
  { term: 'Bear market', match: ['bear market'], meaning: 'A stretch when stock prices fall broadly, often defined as a drop of 20% or more from a high.' },
  { term: 'S&P 500', match: ['S&P 500'], meaning: 'An index of 500 large U.S. companies. It is a common gauge of how the U.S. stock market is doing.' },
  { term: 'Index fund', match: ['index fund', 'index funds'], meaning: 'A fund built to copy a market index, such as the S&P 500, rather than pick individual stocks.' },
  { term: 'ETF', match: ['exchange-traded fund', 'ETFs', 'ETF'], meaning: 'Exchange-traded fund: a basket of investments that trades on an exchange like a single stock.' },
  { term: '401(k)', match: ['401(k)', '401k'], meaning: 'A U.S. retirement savings account offered through an employer, where contributions can be tax-advantaged.' },
  { term: 'IRA', match: ['IRA', 'individual retirement account'], meaning: 'Individual retirement account: a tax-advantaged account a person opens on their own to save for retirement.' },
  { term: 'Social Security', match: ['Social Security'], meaning: 'The U.S. program that pays monthly benefits to retired and disabled workers and their families, funded by payroll taxes.' },
  { term: 'Stablecoin', match: ['stablecoins', 'stablecoin'], meaning: 'A crypto token designed to hold a steady value, usually by being tied to a currency such as the U.S. dollar.' },
  { term: 'Semiconductor', match: ['semiconductors', 'semiconductor'], meaning: 'The material and parts behind computer chips, which run nearly every electronic device.' },
  { term: 'Supply chain', match: ['supply chains', 'supply chain'], meaning: 'The steps and companies that turn raw materials into a product on a shelf. A break in one step can slow all the rest.' },
  { term: 'Subprime', match: ['subprime'], meaning: 'Loans made to borrowers with weaker credit histories, usually at higher interest rates.' },
  { term: 'Liquidity', match: ['liquidity'], meaning: 'How easily something can be sold for cash without moving its price. Cash is the most liquid asset.' },
  { term: 'Default', match: ['defaults', 'default'], meaning: 'Failing to make a required loan or bond payment on time.' },
  { term: 'Stimulus', match: ['stimulus'], meaning: 'Government or central bank action meant to boost spending and growth, such as tax cuts or lower interest rates.' },
  { term: 'Fiscal policy', match: ['fiscal policy'], meaning: 'A government decisions on taxes and spending. It is different from monetary policy, which a central bank sets.' },
  { term: 'Monetary policy', match: ['monetary policy'], meaning: 'A central bank actions on interest rates and the money supply to keep prices stable and jobs steady.' },
  { term: 'Deficit', match: ['budget deficit', 'deficit'], meaning: 'When a government spends more than it takes in during a period. The running total of past deficits is the national debt.' },
];

export interface Segment {
  text: string;
  term?: GlossaryTerm;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One pattern over every phrase, longest first so "yield curve" beats "yield". Case-insensitive except the short
// all-caps ones that would match ordinary words (bp, EPS... are fine; "SEC" must not match "sec").
interface Entry {
  phrase: string;
  term: GlossaryTerm;
  cased: boolean;
}
const ENTRIES: Entry[] = GLOSSARY.flatMap((term) => term.match.map((phrase) => ({ phrase, term, cased: phrase.length <= 4 && phrase === phrase.toUpperCase() || phrase === 'bp' || phrase === 'bps' })))
  .sort((a, b) => b.phrase.length - a.phrase.length);
const BY_PHRASE = new Map(ENTRIES.map((e) => [e.phrase.toLowerCase(), e]));
// Word boundaries that also work next to "(", "&" and digits ("401(k)", "S&P 500").
// No lookbehind (older Safari): the character before the phrase is captured and skipped.
const PATTERN = new RegExp(`(^|[^A-Za-z0-9])(${ENTRIES.map((e) => esc(e.phrase)).join('|')})(?![A-Za-z0-9])`, 'gi');

/**
 * Splits text into plain pieces and glossary terms. Each term is marked only the first time it appears in the
 * text (underlining every repeat is noise), and at most `max` terms are marked.
 */
export function segmentText(text: string, max = 4): Segment[] {
  if (!text) return [];
  const out: Segment[] = [];
  const used = new Set<string>();
  let last = 0;
  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(text); m; m = PATTERN.exec(text)) {
    const word = m[2];
    const start = m.index + m[1].length;
    const e = BY_PHRASE.get(word.toLowerCase());
    if (!e) continue;
    if (e.cased && word !== e.phrase) continue; // "sec" or "ira" in running words stays plain
    if (used.has(e.term.term) || used.size >= max) continue;
    used.add(e.term.term);
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: word, term: e.term });
    last = start + word.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
