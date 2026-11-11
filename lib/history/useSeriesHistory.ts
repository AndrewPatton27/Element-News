// React hook: the history of a card's series, loaded lazily when the card is shown, cached per API instance.
// status 'loading' reserves the chart's room (no shift when it arrives); 'none' means no chart (no data or a failure).

import { useEffect, useState } from 'react';
import type { Api } from '../api/api.ts';
import { useOptionalAppData } from '../shared/appData';
import { createHistoryLoader, type HistoryLoader } from './historyLoader.ts';
import { usableSeries, type ChartSpec, type MacroHistory } from './seriesHistory.ts';

const loaders = new WeakMap<Api, HistoryLoader>();
function loaderFor(api: Api): HistoryLoader {
  let l = loaders.get(api);
  if (!l) { l = createHistoryLoader({ fetchHistory: (ids) => api.macroHistory(ids) }); loaders.set(api, l); }
  return l;
}

export type HistoryState = { status: 'loading' } | { status: 'none' } | { status: 'ready'; history: MacroHistory };

const settle = (spec: ChartSpec, history: MacroHistory): HistoryState =>
  usableSeries(spec, history).length > 0 ? { status: 'ready', history } : { status: 'none' };

export function useSeriesHistory(spec: ChartSpec | null): HistoryState {
  const app = useOptionalAppData();
  const key = spec ? spec.series.join(',') : '';
  const [state, setState] = useState<HistoryState>(() => {
    if (!spec || !app) return { status: 'none' };
    const cached = loaderFor(app.api).peek(spec.series);
    return cached ? settle(spec, cached) : { status: 'loading' };
  });
  useEffect(() => {
    if (!spec || !app) { setState({ status: 'none' }); return; }
    let alive = true;
    const loader = loaderFor(app.api);
    const cached = loader.peek(spec.series);
    if (cached) { setState(settle(spec, cached)); return; }
    setState({ status: 'loading' });
    loader.load(spec.series).then((h) => { if (alive) setState(settle(spec, h)); }, () => { if (alive) setState({ status: 'none' }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, app?.api]);
  return state;
}
