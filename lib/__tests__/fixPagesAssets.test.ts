import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/fix-pages-assets.mjs', import.meta.url));

for (const layout of ['node_modules', 'expo/node_modules']) {
  test(`fix-pages-assets relocates ${layout} asset layout and injects HTML helpers idempotently`, () => {
    const root = mkdtempSync(join(process.cwd(), '.pgtmp', 'pages-assets-'));
    try {
      const dist = join(root, 'dist');
      const packageDir = join(dist, 'assets', layout, 'fixture-fonts');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'font.ttf'), 'fixture');
      const instrument = join(dist, 'assets', layout, '@expo-google-fonts', 'instrument-sans', '400Regular');
      const newsreader = join(dist, 'assets', layout, '@expo-google-fonts', 'newsreader', '600SemiBold');
      mkdirSync(instrument, { recursive: true });
      mkdirSync(newsreader, { recursive: true });
      writeFileSync(join(instrument, 'InstrumentSans_400Regular.hash.ttf'), 'font');
      writeFileSync(join(newsreader, 'Newsreader_600SemiBold.hash.ttf'), 'font');
      mkdirSync(join(dist, '_expo', 'static', 'js', 'web'), { recursive: true });
      writeFileSync(join(dist, 'index.html'), '<html><head></head><body><div id="root"></div></body></html>');
      writeFileSync(join(dist, '_expo', 'static', 'js', 'web', 'entry.js'), `const font="/assets/${layout}/node_modules/fixture-fonts/font.ttf"`);
      execFileSync(process.execPath, [script, dist], { stdio: 'pipe' });
      execFileSync(process.execPath, [script, dist], { stdio: 'pipe' });
      assert.equal(readFileSync(join(dist, 'assets', 'vendor', 'fixture-fonts', 'font.ttf'), 'utf8'), 'fixture');
      assert.match(readFileSync(join(dist, '_expo', 'static', 'js', 'web', 'entry.js'), 'utf8'), /\/assets\/vendor\/fixture-fonts\/font.ttf/);
      const html = readFileSync(join(dist, 'index.html'), 'utf8');
      assert.equal((html.match(/static\.cloudflareinsights\.com\/beacon\.min\.js/g) ?? []).length, 1);
      assert.equal((html.match(/element-static-splash"/g) ?? []).length, 1);
      assert.equal((html.match(/as="font"/g) ?? []).length, 2);
      assert.match(html, /crossorigin/);
      assert.match(readFileSync(join(dist, '_headers'), 'utf8'), /max-age=31536000, immutable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
