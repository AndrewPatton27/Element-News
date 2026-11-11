// True when the `signals` flag is on and the reader chose the "Short" depth. Cheap: one device read, re-read when the
// signals entry changes. Cards call this, so with the flag off it never subscribes to anything.

import { useEffect, useState } from 'react';
import { flagOn } from '../flags/flags';
import { defaultStore, onStoreChange } from '../storage/storage';
import { SIGNALS_KEY, readSignals } from './signalsLogic';

const store = defaultStore();
const read = () => flagOn('signals') && readSignals(store).depth === 'short';

export function useShortDepth(): boolean {
  const [short, setShort] = useState(read);
  useEffect(() => {
    if (!flagOn('signals')) return;
    return onStoreChange((k) => {
      if (k === SIGNALS_KEY) setShort(read());
    });
  }, []);
  return short;
}
