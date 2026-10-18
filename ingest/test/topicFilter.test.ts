import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopicFilterState, filterTopic, recordTopic } from '../src/topicFilter.ts';
import type { RawItem } from '../src/types.ts';

function item(title: string, source: RawItem['source'] = 'fedreg'): RawItem {
  return { source, external_id: title, url: 'https://example.test/story', title, published_at: '2026-10-18T00:00:00Z', license_class: 'public_domain', category: 'policy', event_type: null, tickers: [], source_name: 'Source', source_kind: 'government', doc_label: 'Release', summary_text: '', attribution: undefined };
}

test('topic prefilter allows broad stories and screens routine paperwork and celebrity/sports', () => {
  const s = createTopicFilterState();
  assert.equal(filterTopic(item('Federal Reserve holds rates'), s), null);
  assert.equal(filterTopic(item('Company files Form 144'), s), 'report_card_topic_exclusion');
  assert.equal(filterTopic(item('Actor discusses a movie'), s), 'report_card_topic_exclusion');
  assert.equal(filterTopic(item('Company reports $4 billion in earnings'), s), null);
});

test('airworthiness directive narrow source is capped at two per run', () => {
  const s = createTopicFilterState();
  const a = item('Airworthiness Directive for Model X');
  assert.equal(filterTopic(a, s), null); recordTopic(a, s);
  assert.equal(filterTopic(a, s), null); recordTopic(a, s);
  assert.equal(filterTopic(a, s), 'report_card_variety_cap');
});
