import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQL_FILE, formatTable, isReadOnlySql, parseRows, runReadout, splitQueries } from '../supply-readout.mjs';

const queries = splitQueries(readFileSync(SQL_FILE, 'utf8'));

test('the SQL file holds the documented queries, each one read-only', () => {
  const names = queries.map((q) => q.name);
  for (const n of ['cards_per_day_by_source', 'cards_per_day_by_category', 'market_hour_gaps_14d', 'live_cards_by_topic', 'items_by_status', 'ai_usage_vs_caps', 'gemini_vs_groq_share_30d'])
    assert.ok(names.includes(n), n);
  for (const q of queries) assert.ok(isReadOnlySql(q.sql), q.name);
});

test('isReadOnlySql refuses writes, multi-statements and DDL', () => {
  assert.equal(isReadOnlySql('select 1'), true);
  assert.equal(isReadOnlySql('-- c\nwith a as (select 1) select * from a;'), true);
  assert.equal(isReadOnlySql("select 'delete me'"), true);
  for (const bad of ['delete from core.blurbs', 'select 1; drop table x', 'update core.blurbs set status = 1', 'with a as (delete from x returning 1) select * from a', 'insert into x values (1)', '']) assert.equal(isReadOnlySql(bad), false, bad);
});

test('splitQueries splits on name markers and drops the header', () => {
  const q = splitQueries('-- header\n-- name: a_b\nselect 1;\n-- name: c\n-- note\nselect 2;');
  assert.deepEqual(q.map((x) => x.name), ['a_b', 'c']);
  assert.match(q[1].sql, /select 2/);
});

test('parseRows reads CLI output with log text before the JSON, and reports errors', () => {
  assert.deepEqual(parseRows('Connecting...\n{"rows":[{"a":1}]}'), [{ a: 1 }]);
  assert.throws(() => parseRows('{"error":{"message":"nope"}}'), /query failed: nope/);
});

test('runReadout runs each query through the runner, filters by name, and keeps going after one failure', () => {
  const seen = [];
  const out = runReadout(queries, (sql) => { seen.push(sql); if (/ai_usage/.test(sql) && /from core.ai_usage u/.test(sql)) throw new Error('boom'); return '{"rows":[{"n":1}]}'; });
  assert.equal(out.length, queries.length);
  assert.equal(out.find((r) => r.name === 'ai_usage_vs_caps').error, 'boom');
  assert.deepEqual(out.find((r) => r.name === 'pool_size').rows, [{ n: 1 }]);
  const one = runReadout(queries, () => '{"rows":[]}', ['pool_size']);
  assert.deepEqual(one.map((r) => r.name), ['pool_size']);
  const refused = runReadout([{ name: 'x', sql: 'delete from core.blurbs' }], () => { throw new Error('must not run'); });
  assert.match(refused[0].error, /refused/);
});

test('formatTable aligns columns and handles empty and null', () => {
  assert.equal(formatTable([]), '(no rows)');
  const t = formatTable([{ day: '2026-11-09', cards: 5 }, { day: '2026-11-10', cards: null }]).split('\n');
  assert.equal(t[0], 'day         cards');
  assert.equal(t[2], '2026-11-09  5');
});
