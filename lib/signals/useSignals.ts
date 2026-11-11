// React side of lib/signals/signalsLogic.ts: reads the device entry, re-reads when any screen changes it
// (defaultStore notifies), and gives small setters. With the `signals` flag off every setter still works but no
// screen offers them.

import { useCallback, useEffect, useState } from 'react';
import { defaultStore, onStoreChange } from '../storage/storage';
import { SIGNALS_KEY, readSignals, writeSignals, type Signals } from './signalsLogic';

const store = defaultStore();

export interface UseSignals {
  signals: Signals;
  update(fn: (s: Signals) => Signals): void;
}

export function useSignals(): UseSignals {
  const [signals, setSignals] = useState<Signals>(() => readSignals(store));
  useEffect(
    () =>
      onStoreChange((k) => {
        if (k === SIGNALS_KEY) setSignals(readSignals(store));
      }),
    [],
  );
  const update = useCallback((fn: (s: Signals) => Signals) => {
    const next = fn(readSignals(store));
    writeSignals(store, next);
    setSignals(next);
  }, []);
  return { signals, update };
}
