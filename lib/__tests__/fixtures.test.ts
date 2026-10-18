// Checks the shared sample fixtures against the app's guards and label rules,
// and scans app code for secret keys. Fixture checks skip if the files are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cardLabels } from '../labels.ts';
import { isBlurbCard, parseAppConfig, parseCategories, parseMacroFacts } from '../types.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIX = join(ROOT, 'contract', 'fixtures');
const read = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
const have = existsSync(join(FIX, 'feed.page1.json'));

test(
  'sample feed fixtures render: every card valid, [SAMPLE], disclaimer, source link',
  { skip: !have && 'contract/fixtures not written yet' },
  () => {
    const cfg = parseAppConfig(read('app_config.json'));
    const cards = [...read('feed.page1.json').items, ...read('feed.page2.json').items];
    assert.ok(read('feed.page1.json').items.length >= 20, 'page 1 has at least 20 cards');
    assert.deepEqual(read('feed.empty.json').items, []);
    const kinds = new Set<string>();
    for (const c of cards) {
      if (c.kind === 'link_out') continue;
      assert.ok(isBlurbCard(c), `card ${c.id} passes the guard`);
      assert.ok(c.headline.startsWith('[SAMPLE]'), `card ${c.id} headline is marked [SAMPLE]`);
      assert.equal(c.image, null);
      for (const t of c.tickers) assert.equal(t.quote, null);
      const labels = cardLabels(c, cfg);
      assert.ok(labels.disclaimer.length > 0);
      if (c.ai.generated) assert.equal(labels.aiLabel, cfg.ai_notice);
      kinds.add(c.kind);
    }
    assert.ok(kinds.has('summary') && kinds.has('data'));
    const cats = parseCategories(read('categories.json'));
    assert.ok(cats.length >= 9, 'at least the original 9 categories');
    assert.ok(
      cats.some((c) => c.slug === ('world' as string)),
      'broad topics present',
    );
    assert.equal(parseMacroFacts(read('numbers_to_know.json')).length, 6);
  },
);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|json)$/.test(name)) out.push(p);
  }
  return out;
}

test('app code contains no secret keys', () => {
  const files = ['app', 'components', 'lib'].flatMap((d) => walk(join(ROOT, d)));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/sb_secret_[A-Za-z0-9]/.test(text), `${f} has a secret key`);
    assert.ok(!/SERVICE_ROLE/.test(text), `${f} mentions the service role key`);
  }
});
