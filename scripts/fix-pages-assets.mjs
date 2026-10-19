// Cloudflare Pages does not upload folders named "node_modules", but `expo export -p web`
// puts font files under dist/assets/node_modules/... . Without this step the fonts 404
// (Pages serves index.html instead) and the site falls back to a system font.
// This moves dist/assets/node_modules to dist/assets/vendor and rewrites every reference.
//
// It also injects the Cloudflare Web Analytics beacon into index.html. Expo's "single"
// web output (app.json web.output) uses a built-in HTML template and ignores app/+html.tsx,
// so a post-build injection is the only place the tag can go for every deploy.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';

injectCloudflareBeacon(dist);
injectSplash(dist);
injectEarlyLoad(dist);
writeHeaders(dist);

const assets = join(dist, 'assets');
const vendor = join(assets, 'vendor');
const nodeModules = [];
function findNodeModules(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (name === 'node_modules') nodeModules.push(path);
    else if (path !== vendor && !path.startsWith(`${vendor}/`)) findNodeModules(path);
  }
}
findNodeModules(assets);
for (const from of nodeModules) {
  mkdirSync(vendor, { recursive: true });
  // Merge nested assets into the stable vendor location before removing the Pages-skipped folder.
  cpSync(from, vendor, { recursive: true, force: true });
  rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

let files = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(js|html|json|css|map)$/.test(name)) continue;
    const text = readFileSync(p, 'utf8');
    const next = text.replace(/\/assets\/(?:[^/"'\s]+\/)*node_modules\//g, '/assets/vendor/');
    if (next !== text) { writeFileSync(p, next); files++; }
  }
};
walk(dist);
injectFontPreloads(dist);
console.log(`fix-pages-assets: moved ${nodeModules.length} node_modules asset folder(s) -> assets/vendor, rewrote ${files} file(s)`);

function injectSplash(outDir) {
  const htmlPath = join(outDir, 'index.html');
  if (!existsSync(htmlPath)) return;
  let html = readFileSync(htmlPath, 'utf8');
  if (html.includes('id="element-static-splash"')) return;
  const style = `<style id="element-static-splash-style">#element-static-splash{position:fixed;inset:0;z-index:2147483000;background:#f5f6f2;padding:14vh max(24px,calc((100vw - 480px)/2));font:14px system-ui,sans-serif;color:#152b27}#element-static-splash b{font:600 26px Georgia,serif;letter-spacing:-.5px}.element-skeleton{margin-top:28px;height:52vh;max-height:430px;border:1px solid #e2e6df;border-radius:22px;background:linear-gradient(110deg,#fff 30%,#f4f5f1 45%,#fff 60%);box-shadow:0 8px 30px #15342b0a}</style>`;
  const splash = `${style}<div id="element-static-splash" aria-label="Loading Element"><b>Element</b><div class="element-skeleton"></div></div><script>(function(){var s=document.getElementById('element-static-splash');if(!s)return;setTimeout(function(){var x=document.getElementById('element-static-splash');if(x)x.remove()},8000);var go=function(){var r=document.getElementById('root');if(!r){setTimeout(go,50);return}var done=function(){if(r.childNodes.length){s.remove();var c=document.getElementById('element-static-splash-style');if(c)c.remove();o.disconnect()}};var o=new MutationObserver(done);o.observe(r,{childList:true});done()};go()})()</script>`;
  html = html.replace('</head>', `${splash}</head>`);
  writeFileSync(htmlPath, html);
}

function writeHeaders(outDir) {
  const headers = `/_expo/static/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: public, max-age=0, must-revalidate\n\n/index.html\n  Cache-Control: public, max-age=0, must-revalidate\n`;
  writeFileSync(join(outDir, '_headers'), headers);
}

function injectFontPreloads(outDir) {
  const htmlPath = join(outDir, 'index.html');
  const fontsRoot = join(outDir, 'assets', 'vendor', '@expo-google-fonts');
  if (!existsSync(htmlPath) || !existsSync(fontsRoot)) return;
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(woff2?|ttf|otf)$/i.test(name)) found.push(path);
    }
  };
  walk(fontsRoot);
  const preferred = ['InstrumentSans_400Regular.', 'Newsreader_600SemiBold.'];
  const links = preferred.map((prefix) => found.find((path) => path.split(/[\\/]/).pop().startsWith(prefix))).filter(Boolean)
    .map((path) => `<link rel="preload" href="/${path.slice(outDir.length + 1).replaceAll('\\', '/')}" as="font" type="font/ttf" crossorigin />`).join('');
  if (!links) return;
  let html = readFileSync(htmlPath, 'utf8');
  if (!html.includes('rel="preload"') || !html.includes('as="font"')) {
    html = html.replace('</head>', `${links}</head>`);
    writeFileSync(htmlPath, html);
  }
}

// Insert the Cloudflare Web Analytics beacon just before </head> in index.html.
// Idempotent: re-running the script does not add a second copy.
function injectCloudflareBeacon(outDir) {
  const CF_TOKEN = 'ec307be9fdde492eac623e33156c0a88';
  const beacon =
    `<!-- Cloudflare Web Analytics -->`
    + `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" `
    + `data-cf-beacon='{"token": "${CF_TOKEN}"}'></script>`
    + `<!-- End Cloudflare Web Analytics -->`;
  const htmlPath = join(outDir, 'index.html');
  if (!existsSync(htmlPath)) {
    console.log('fix-pages-assets: index.html not found, skipping Cloudflare beacon');
    return;
  }
  const html = readFileSync(htmlPath, 'utf8');
  if (html.includes('static.cloudflareinsights.com/beacon.min.js')) {
    console.log('fix-pages-assets: Cloudflare beacon already present');
    return;
  }
  if (!html.includes('</head>')) {
    console.log('fix-pages-assets: no </head> in index.html, skipping Cloudflare beacon');
    return;
  }
  writeFileSync(htmlPath, html.replace('</head>', `${beacon}</head>`));
  console.log('fix-pages-assets: injected Cloudflare Web Analytics beacon');
}

// Start the network work before the 1+ MB bundle runs: preconnect to the Supabase origin,
// fetch the first feed page from an inline script (lib/earlyFeed.ts hands it to api.feed),
// and preload the two route chunks the first screen needs (they are otherwise discovered only
// after the main bundle has run). Only the public URL and publishable key are used.
function readEnvValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).split('#')[0].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

function injectEarlyLoad(outDir) {
  const htmlPath = join(outDir, 'index.html');
  if (!existsSync(htmlPath)) return;
  let html = readFileSync(htmlPath, 'utf8');
  if (html.includes('__elementEarly')) return;
  let tags = '';
  const jsDir = join(outDir, '_expo', 'static', 'js', 'web');
  if (existsSync(jsDir)) {
    for (const prefix of ['_layout-', 'index-']) {
      const f = readdirSync(jsDir).find((n) => n.startsWith(prefix) && n.endsWith('.js'));
      if (f) tags += `<link rel="preload" as="script" href="/_expo/static/js/web/${f}" />`;
    }
  }
  const url = readEnvValue('EXPO_PUBLIC_SUPABASE_URL').replace(/\/+$/, '');
  const key = readEnvValue('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const live = readEnvValue('EXPO_PUBLIC_API_MODE').toLowerCase() === 'supabase' && /^https:\/\/[\w.-]+$/.test(url) && /^[\w.-]+$/.test(key);
  if (live) {
    // The body must equal what planRequest builds for the first Trending page (key order matters).
    const body = JSON.stringify({ p_mode: 'top', p_cursor: null, p_limit: 10, p_category: null });
    const headers = { apikey: key, Accept: 'application/json', 'Accept-Profile': 'api', 'Content-Type': 'application/json', 'Content-Profile': 'api' };
    tags += `<link rel="preconnect" href="${url}" crossorigin />`;
    tags += `<script>(function(){try{if(localStorage.getItem('element.session.v1'))return;var b=${JSON.stringify(body)};window.__elementEarly={body:b,t:Date.now(),p:fetch(${JSON.stringify(`${url}/rest/v1/rpc/feed`)},{method:'POST',headers:${JSON.stringify(headers)},body:b}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}}catch(e){}})()</script>`;
  }
  if (!tags) return;
  // Right after <head> so these start first.
  html = html.replace('<head>', `<head>${tags}`);
  writeFileSync(htmlPath, html);
  console.log(`fix-pages-assets: early load tags injected (supabase prefetch ${live ? 'on' : 'off'})`);
}
