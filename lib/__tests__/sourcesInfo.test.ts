import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES } from '../sourcesInfo.ts';

test('About lists every source with a site and terms link (https only)', () => {
  const names = SOURCES.map((s) => s.name).join(' | ');
  for (const must of [
    'SEC',
    'Federal Reserve',
    'BEA',
    'FRED',
    'Federal Register',
    'Wikipedia',
    'Consumer Product Safety',
    'Geological Survey',
    'NASA',
  ]) {
    assert.ok(names.includes(must), `${must} is listed`);
  }
  for (const s of SOURCES) {
    assert.match(s.site, /^https:\/\//, s.name);
    assert.match(s.terms.url, /^https:\/\//, s.name);
    assert.ok(s.gives.length > 10, s.name);
  }
  const wiki = SOURCES.find((s) => s.name.startsWith('Wikipedia'))!;
  assert.equal(wiki.terms.url, 'https://creativecommons.org/licenses/by-sa/4.0/');
  // macro numbers cite the original agency, never bare "FRED" (project rule 8)
  assert.match(SOURCES.find((s) => s.name.startsWith('FRED'))!.gives, /names the agency/);
});
