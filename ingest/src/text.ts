// Small text helpers for headlines and summaries (no network, no dependencies).
// sentenceCase: Title Case -> sentence case WITHOUT touching proper nouns or tickers: only words on a
// list of common words are lowercased; every other word (company names, places, ALL-CAPS tickers,
// acronyms, months, anything unknown) keeps its capitals. The first word is never changed.
// mentionsProductCodes: finds outright mentions of model numbers, SKUs, UPCs and lot numbers.
// Inputs: a string. Outputs: a string or a list of matches.

/** Everyday words that are only capitalised in Title Case headlines. Names and places are NOT here on purpose. */
const COMMON_LOWER: ReadonlySet<string> = new Set([
  // small words
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'off', 'on', 'onto', 'or', 'over',
  'per', 'the', 'to', 'up', 'via', 'vs', 'with', 'without', 'after', 'before', 'than', 'that', 'this', 'its', 'their',
  // periods
  'first', 'second', 'third', 'fourth', 'quarter', 'quarterly', 'annual', 'monthly', 'weekly', 'daily', 'year', 'month',
  'week', 'half', 'full',
  // news / release words
  'advance', 'preliminary', 'final', 'revised', 'estimate', 'estimates', 'report', 'reports', 'reported', 'release',
  'releases', 'statement', 'statements', 'minutes', 'meeting', 'meetings', 'announces', 'announced', 'announcement',
  'issues', 'issued', 'approves', 'approved', 'adopts', 'finalizes', 'publishes', 'proposes', 'proposed', 'delays',
  'extends', 'orders', 'requires', 'recalls', 'recall', 'warns', 'names', 'sets', 'holds', 'raises', 'cuts', 'lowers',
  'rises', 'falls', 'says', 'shares', 'files', 'plans', 'launches', 'agrees', 'completes', 'expects', 'updates',
  'new', 'latest', 'rule', 'rules', 'notice', 'order', 'results', 'result', 'update', 'data', 'summary', 'outlook',
  // economy words
  'gross', 'domestic', 'product', 'products', 'international', 'trade', 'goods', 'services', 'personal', 'income',
  'outlays', 'spending', 'consumer', 'consumers', 'price', 'prices', 'index', 'inflation', 'employment', 'unemployment',
  'situation', 'jobs', 'wages', 'sales', 'retail', 'housing', 'starts', 'permits', 'construction', 'manufacturing',
  'industrial', 'production', 'productivity', 'costs', 'cost', 'earnings', 'revenue', 'profit', 'profits',
  'financial', 'economic', 'monetary', 'policy', 'discount', 'rate', 'rates', 'interest', 'loans', 'loan', 'credit',
  'debt', 'budget', 'deficit', 'balance', 'payments', 'payment', 'benefits', 'claims', 'tax', 'taxes', 'fees', 'fee',
  'energy', 'oil', 'gas', 'safety', 'health', 'cars', 'vehicles', 'planes', 'airplanes', 'airline', 'flights',
  'directives', 'directive', 'airworthiness', 'penalties', 'penalty', 'requirements', 'standards', 'regulation',
  'regulations', 'changes', 'change', 'increase', 'decrease', 'higher', 'lower', 'steady', 'unchanged', 'amid', 'against',
]);

const coreOf = (w: string) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');

/** True when most of the longer words are capitalised (a Title Case headline). Mixed or sentence case returns false. */
function looksTitleCase(words: string[]): boolean {
  const long = words.slice(1).map(coreOf).filter((w) => /^[A-Za-z][A-Za-z'’-]{3,}$/.test(w));
  if (long.length < 2) return false;
  const caps = long.filter((w) => /^[A-Z]/.test(w)).length;
  return caps / long.length >= 0.6;
}

/**
 * Headline to sentence case: capitalise only the first word and proper nouns. Only words on a list of
 * everyday words are lowercased, so proper nouns, tickers and acronyms are never changed. Text that is
 * not in Title Case is returned as is.
 */
export function sentenceCase(headline: string): string {
  const parts = headline.split(/(\s+)/);          // keep the whitespace
  const words = parts.filter((p) => p.trim() !== '');
  if (!looksTitleCase(words)) return headline;
  let seen = 0;
  return parts.map((p) => {
    if (p.trim() === '') return p;
    if (seen++ === 0) return p;                   // the first word keeps its capital
    const m = /^([^A-Za-z]*)([A-Z][a-z]+)([^A-Za-z]*)$/.exec(p);   // "(Third" "Quarter," "Estimate)"; not "Board's", "GDP" or "Mid-Atlantic"
    if (!m || !COMMON_LOWER.has(m[2].toLowerCase())) return p;
    return `${m[1]}${m[2].toLowerCase()}${m[3]}`;
  }).join('');
}

/**
 * Outright mentions of a model number, SKU, UPC or lot number ("SKU", "UPC", "model number", "lot no.").
 * They belong in the detail key points only, never in a headline or summary. A bare "Model 737" is not
 * flagged (a well-known model name is fine); only the labelled-code wording is.
 */
export function mentionsProductCodes(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(/\b(?:SKUs?|UPCs?|GTINs?)\b|\b(?:model|lot|item|serial|batch)\s+(?:numbers?|nos?\b\.?|#|codes?)/gi)) hits.add(m[0].toLowerCase());
  return [...hits];
}
