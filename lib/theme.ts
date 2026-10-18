// Design tokens (from the Element design canvas). Light is the default; dark is
// derived from the same roles. Pure: no React imports.

export interface Palette {
  bg: string; // page background
  surface: string; // cards, sheets, nav bars
  surfaceMuted: string; // source row, close button, "how this card was made"
  ink: string; // headlines and primary text
  inkBody: string; // card body text
  inkSoft: string; // chip text, secondary labels
  inkPlain: string; // plain-language explainers
  muted: string; // meta text, disclaimer, captions
  border: string; // card border
  borderStrong: string; // chips and outline buttons
  divider: string; // card footer rule
  rowDivider: string; // list rows in the numbers panel
  navBorder: string; // bottom nav and tab rule
  handle: string; // sheet grab handle
  accent: string; // wordmark, active tab, primary button
  accentInk: string; // text on accentSoft
  accentSoft: string; // active chip, Summary badge, active nav item
  onAccent: string; // text on accent
  dataSoft: string; // "New data" badge
  dataInk: string; // text on dataSoft and the data panel label
  dataPanel: string; // the big-number panel on data cards
  up: string; // change went up
  down: string; // change went down
  flat: string; // unchanged
  good: string; // change generally good for households (green, AA on bg and white)
  bad: string; // change generally bad for households (red, AA on bg and white)
  overlay: string; // behind sheets
  warn: string; // design --warn: alerts, "updated" dots, rises in a number
}

export const light: Palette = {
  bg: '#F5F6F2',
  surface: '#FFFFFF',
  surfaceMuted: '#F1F4EF',
  ink: '#14211C',
  inkBody: '#24322B',
  inkSoft: '#33403A',
  inkPlain: '#44514A',
  muted: '#56635B',
  border: '#E1E6DE',
  borderStrong: '#D5DBD2',
  divider: '#E7EBE4',
  rowDivider: '#EDF0EA',
  navBorder: '#DDE2DA',
  handle: '#CBD2C8',
  accent: '#0B6B5D',
  accentInk: '#0A5A4E',
  accentSoft: '#DCEEE9',
  onAccent: '#FFFFFF',
  dataSoft: '#FBEFD2',
  dataInk: '#6B4400',
  dataPanel: '#F7F3E8',
  up: '#8A3B12',
  down: '#0A5A4E',
  flat: '#56635B',
  good: '#1B6B34',
  bad: '#B3261E',
  overlay: 'rgba(20,33,28,0.5)',
  warn: '#8A3B12',
};

export const dark: Palette = {
  bg: '#0F1513',
  surface: '#18201D',
  surfaceMuted: '#1F2925',
  ink: '#E8EEEA',
  inkBody: '#D3DCD6',
  inkSoft: '#C2CCC5',
  inkPlain: '#B3BEB7',
  muted: '#98A59D',
  border: '#2A3530',
  borderStrong: '#36433D',
  divider: '#26302C',
  rowDivider: '#222B27',
  navBorder: '#2A3530',
  handle: '#45524C',
  accent: '#4FB8A5',
  accentInk: '#9FE0D3',
  accentSoft: '#17352F',
  onAccent: '#06201B',
  dataSoft: '#3A2E14',
  dataInk: '#F1C770',
  dataPanel: '#2A2416',
  up: '#F0A07A',
  down: '#6FD0BD',
  flat: '#98A59D',
  good: '#6FCB8A',
  bad: '#F29B94',
  overlay: 'rgba(0,0,0,0.6)',
  warn: '#F0A07A',
};

// The design files' CSS variable names (docs/design/*.dc.html, Classic teal)
// mapped to Palette roles, so new screens can be written straight from the
// design: design.line -> p[design.line] === '#E1E6DE'.
export const design = {
  bg: 'bg',
  surface: 'surface',
  surface2: 'surfaceMuted',
  ink: 'ink',
  ink2: 'inkSoft',
  muted: 'muted',
  line: 'border',
  lineSoft: 'divider',
  lineStrong: 'borderStrong',
  accent: 'accent',
  tint: 'accentSoft',
  tintInk: 'accentInk',
  warn: 'warn',
  onAccent: 'onAccent',
} as const satisfies Record<string, keyof Palette>;

// Light only for now. The dark palette above is kept for later; set this to
// true (and app.json "userInterfaceStyle" to "automatic") to follow the system.
export const DARK_MODE_ENABLED = false;

export function paletteFor(scheme: string | null | undefined): Palette {
  return DARK_MODE_ENABLED && scheme === 'dark' ? dark : light;
}

// Font family names as registered by expo-font (see app/_layout.tsx). Each weight
// is its own family, so never combine these with fontWeight (it would fake-bold).
export const fonts = {
  serif: 'Newsreader_600SemiBold',
  sans: 'InstrumentSans_400Regular',
  sansMedium: 'InstrumentSans_500Medium',
  sansSemi: 'InstrumentSans_600SemiBold',
} as const;

// Spacing, radii and type sizes from the design files. Existing keys keep their
// values; the later keys were added for the UI overhaul (P0.4).
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  page: 16, // mobile page side padding
  pageWide: 32, // web page side padding
  section: 22, // gap between sections on a web page
  pageTopWide: 40, // web page top padding under the top bar
  pageBottomWide: 90, // room for the floating About pill
} as const;
export const radius = {
  sm: 12, // source row, inputs
  md: 14, // badges
  lg: 18,
  tile: 20, // list cards (Following, Search results)
  chip: 22, // 44 px chips and the Sign in pill
  card: 24, // feed card
  sheet: 28,
  pill: 999,
} as const;
export const font = {
  small: 12, // tab labels, disclaimer
  meta: 13,
  chip: 14,
  nav: 15, // web top-bar links, mobile tab text in headers
  body: 16,
  navTab: 16, // web Main nav / feed tabs
  cardBody: 18,
  headerWordmark: 22, // mobile header
  wordmark: 26, // web top bar
  cardTitle: 28,
  title: 32,
  pageTitle: 44, // web page h1 (Brief, Search, Following, Me)
  big: 64,
} as const;

// Fixed bar heights from the design.
export const TOP_BAR_HEIGHT = 64; // web top bar
export const MOBILE_HEADER_HEIGHT = 56; // mobile screen header
export const TAB_BAR_MIN_HEIGHT = 48; // each mobile tab's touch target
// Max width of a web page body (Brief, Search, Following, Me).
export const PAGE_MAX_WIDTH = 1000;

// At this width and above the web layout switches to three columns.
export const WIDE_BREAKPOINT = 1024;
export const RAIL_WIDTH = 220;
export const ASIDE_WIDTH = 340;
// The centred content column on wide screens (the news cards). The bottom nav is
// capped to the same width so its icons line up with the cards and never spill
// past them.
export const CARD_MAX_WIDTH = 640;
