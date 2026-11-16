// CLI for the D-296 retro pass. From ingest/:  node --experimental-strip-types src/linkoutFillCli.ts <export|check|apply> [--limit N] [--cards file] [--drafts file] [--apply]
// All three commands need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env). apply is a dry run unless --apply is given.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllowed } from './allowlist.ts';
import { config, readEnv } from './config.ts';
import { applyDrafts, checkDrafts, exportCards, FILL_DIR, readJson, type DraftFile, type ExportedCard } from './linkoutFill.ts';
import type { Deps } from './pipeline.ts';
import { createSupabasePublisher } from './publish.ts';
import { memoryCounter } from './summarizer/chain.ts';

const log = (s: string) => console.log(s);

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => rest.includes(`--${n}`);
  const val = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const cardsFile = val('cards') ?? `${FILL_DIR}/cards.json`;
  const draftFiles = (val('drafts') ?? `${FILL_DIR}/drafts-1.json,${FILL_DIR}/drafts-2.json,${FILL_DIR}/drafts-3.json,${FILL_DIR}/drafts-4.json`).split(',');
  if (!['export', 'check', 'apply'].includes(cmd ?? '')) { log('usage: linkoutFillCli.ts <export|check|apply> [--limit N] [--cards file] [--drafts a.json,b.json] [--apply]'); return 2; }
  for (const p of ['.env', '../.env']) if (existsSync(p)) { try { process.loadEnvFile(p); } catch { /* readEnv reports what is missing */ } break; }
  const env = readEnv(process.env);
  const publisher = createSupabasePublisher({ url: env.supabaseUrl, key: env.supabaseServiceRoleKey });
  const deps: Deps = {
    fetchText: async (url, kind) => {
      const r = await fetchAllowed(url, { kind, userAgent: kind === 'publisher' ? config.publisherPage.userAgent : env.secUserAgent, extraHosts: [new URL(env.supabaseUrl).hostname] });
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      return r.text;
    },
    publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: new Date(), log,
  };
  if (cmd === 'export') {
    const limit = val('limit') ? Number(val('limit')) : undefined;
    await exportCards(deps, { limit, file: cardsFile, idsFile: `${FILL_DIR}/ids.json` });
    log(`wrote ${cardsFile} and ${FILL_DIR}/ids.json (git-ignored; cards.json holds publisher text, never commit or share it)`);
    return 0;
  }
  const cards = await readJson<ExportedCard[]>(cardsFile);
  const drafts: DraftFile[] = [];
  for (const f of draftFiles) if (existsSync(f)) drafts.push(...(await readJson<DraftFile[]>(f)));
  const results = await checkDrafts(cards, drafts);
  const ok = results.filter((r) => r.ok).length;
  log(`checked ${results.length} drafts: ${ok} pass, ${results.length - ok} rejected`);
  await writeFile(`${FILL_DIR}/check-report.json`, JSON.stringify(results.map(({ id, ok: o, errors }) => ({ id, ok: o, errors })), null, 2), 'utf8');
  if (cmd === 'check') return 0;
  const allIds = await readJson<{ id: string; headline: string }[]>(`${FILL_DIR}/ids.json`);
  const stats = await applyDrafts(deps, results, { apply: flag('apply'), allIds });
  log(`${flag('apply') ? 'applied' : 'dry run (add --apply to write)'}: ${JSON.stringify(stats)}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
}
