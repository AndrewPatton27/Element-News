// Two runs in the same process (a warm Edge Function isolate can serve two requests at once) must not
// share per-run state: the narrow-source cap, the topic counters and the recent-card list are per run.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';

function oneRun() {
  const dry = createDryRunPublisher();
  const base = fixtureFetcher();
  const d: Deps = {
    // yield to the event loop so both runs interleave
    fetchText: async (u, k, t) => { await new Promise((r) => setTimeout(r, 5)); return base(u, k, t); },
    publisher: dry.publisher, providers: [templateSummarizer], counter: memoryCounter(), fredApiKey: null,
    now: DRY_NOW, log: () => {},
  };
  return { d, dry };
}

test('two concurrent runs keep separate narrow-source caps (USGS cap is 1 new card per run)', async () => {
  const a = oneRun(), b = oneRun();
  const [sa, sb] = await Promise.all([runOnce(a.d, { only: ['usgs'] }), runOnce(b.d, { only: ['usgs'] })]);
  assert.equal(sa.published, 1);
  assert.equal(sb.published, 1);
});
