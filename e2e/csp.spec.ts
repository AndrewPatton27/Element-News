import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { parseHeadersFile } from '../scripts/security-headers.mjs';

// CSP check on the EXPORTED web build with its generated _headers applied (the report-only full policy, or the
// enforced one when built with ENFORCE_FULL_CSP=1). The test fails on any CSP violation in mock mode, so an
// inline script without a hash, an eval, or an origin missing from connect-src shows up before a deploy.
// It needs a build, so it skips cleanly without one:
//   EXPO_PUBLIC_API_MODE=mock npm run export:web   (writes dist-pages/ with _headers)
//   npx playwright test e2e/csp.spec.ts --workers=1
// Procedure for switching the policy on: see scripts/scripts.md ("Enforcing the full CSP").

const dist = join(process.cwd(), 'dist-pages');
const built = existsSync(join(dist, 'index.html')) && existsSync(join(dist, '_headers'));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

let server: Server;
let origin = '';

test.beforeAll(async () => {
  if (!built) return;
  const all = parseHeadersFile(readFileSync(join(dist, '_headers'), 'utf8')).find((r) => r.path === '/*');
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^[\\/]+/, '');
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || path === '') file = join(dist, 'index.html'); // SPA fallback
    const headers: Record<string, string> = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' };
    for (const [k, v] of all?.headers ?? []) headers[k] = v;
    res.writeHead(200, headers);
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
test.afterAll(() => { server?.close(); });

test('the exported app loads in mock mode with no CSP violation', async ({ page }) => {
  test.skip(!built, 'no dist-pages build (run EXPO_PUBLIC_API_MODE=mock npm run export:web first)');
  const messages: string[] = [];
  page.on('console', (m) => { if (/content security policy|csp/i.test(m.text())) messages.push(m.text().slice(0, 240)); });
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked ${e.blockedURI.slice(0, 80)}`);
    });
  });
  await page.goto(origin + '/');
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // late scripts, fonts, preloads
  const events = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect([...messages, ...events], 'CSP violations').toEqual([]);
});
