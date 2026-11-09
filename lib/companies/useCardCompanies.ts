// Company tags for one card ("About: Apple" chips), batched across every card on screen
// (lib/companies/tagBatcher.ts). Undefined until known; the chips show the card's own tickers meanwhile.

import { useEffect, useState } from 'react';
import type { CompanyApi } from './companyApi';
import type { CardCompany } from './companyLogic';
import { createTagBatcher, type TagBatcher } from './tagBatcher';

const batchers = new WeakMap<CompanyApi, TagBatcher>();

function batcherFor(api: CompanyApi): TagBatcher {
  let b = batchers.get(api);
  if (!b) {
    b = createTagBatcher((ids) => api.tags(ids));
    batchers.set(api, b);
  }
  return b;
}

export function useCardCompanies(api: CompanyApi | null | undefined, cardId: string): CardCompany[] | undefined {
  const batcher = api ? batcherFor(api) : null;
  const [tags, setTags] = useState<CardCompany[] | undefined>(() => batcher?.get(cardId));
  useEffect(() => {
    if (!batcher) return;
    const hit = batcher.get(cardId);
    if (hit) { setTags(hit); return; }
    setTags(undefined);
    let alive = true;
    const off = batcher.request(cardId, (t) => { if (alive) setTags(t); });
    return () => { alive = false; off(); };
  }, [batcher, cardId]);
  return tags;
}
