import { useColorScheme, useWindowDimensions } from 'react-native';
import { paletteFor, WIDE_BREAKPOINT, type Palette } from './theme.ts';

export function usePalette(): Palette {
  return paletteFor(useColorScheme());
}

// Wide = the three-column desktop web layout.
export function useWide(): boolean {
  return useWindowDimensions().width >= WIDE_BREAKPOINT;
}
