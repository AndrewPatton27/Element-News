// Copy for the 4-step first-run tour (designs docs/design/mobile/Mobile-Tutorial*.dc.html
// and docs/design/web/Web-Tutorial*.dc.html). Pure data, rendered by components/Tutorial.tsx.
// Two variants: 'mobile' (touch: swipe, tap) and 'web' (wide desktop: keys, click).
//
// Design copy is kept where it is true of the app; where it was not, it is changed
// as little as possible (tested in lib/__tests__/tutorialLogic.test.ts):
// - cards have no Follow button: legend 3 explains the AI label instead, and the
//   recap says you follow topics, companies and sources (that is what Following does);
// - web feed keys are ↓/j next and ↑/k back; like/dislike is the thumbs buttons
//   (the design's ← / → like/dislike keys do not exist);
// - tapping a number on the strip opens Numbers to know, where every figure links to its official source;
// - there is no 7 AM push yet, so that sentence is dropped;
// - Search was not in the design: one recap line added.

import { AI_NOTICE_FALLBACK } from './labels.ts';

export type TutorialVariant = 'mobile' | 'web';
export type RecapIcon = 'next' | 'swipe' | 'source' | 'follow' | 'search';

export interface LegendItem {
  label: string; // bold lead-in, e.g. "The summary."
  text: string;
}

export interface KeyTile {
  key: string; // key cap glyph, or 'thumbs-up' / 'thumbs-down' (drawn as icons)
  title: string;
  hint: string;
  tone: 'warn' | 'accent' | 'next';
}

export interface RecapRow {
  icon: RecapIcon;
  bold: string;
  text: string;
}

export interface TutorialStep {
  id: 'card' | 'top' | 'brief' | 'recap';
  title: string;
  lead?: string;
  exampleCaption?: string; // right side of the "Example" badge
  legend: LegendItem[];
  tiles?: KeyTile[];
  recap?: RecapRow[];
  continueHint?: string; // "Swipe up to continue" / "Press ↓ or scroll to continue"
  practiceNote?: string; // under the example; the disclaimer is shown once, in the footer
}

export const TUTORIAL_AI_LABEL = AI_NOTICE_FALLBACK;
export const PRACTICE_FOOTER = 'Practice card, not real news';

// Sample values from the design; shown only inside the tour, captioned "sample numbers".
export const SAMPLE_TICKER = [
  { label: '10-YR', value: '5.10%', change: '▼ 0.09', tone: 'down' as const },
  { label: 'FED FUNDS', value: '3.88%', change: '▪ flat', tone: 'flat' as const },
  { label: 'CPI', value: '3.1%', change: '▼ 0.2', tone: 'down' as const },
  { label: 'JOBLESS', value: '4.2%', change: '▪ flat', tone: 'flat' as const },
  { label: 'WTI', value: '$71.40', change: '▲ 0.90', tone: 'up' as const },
];
export const SAMPLE_CATEGORIES = ['All', 'World', 'Government', 'Economy'];

// The practice card is its own sample object, never a real Blurb: nothing with this
// id is ever sent anywhere (see the practice demo in lib/tutorialLogic.ts).
export const PRACTICE_SAMPLE = Object.freeze({
  id: 'tutorial-practice-sample',
  practice: true as const,
  source: 'Source name · Type',
  sourceCount: '1 source',
});

// Motion, copied from the design CSS (@keyframes in Mobile-/Web-Tutorial*.dc.html).
// Every animation there is `ease-in-out` per keyframe segment (marquee: linear),
// loops forever, and stops under prefers-reduced-motion (pills then sit at opacity 1).
// `at` = keyframe offsets 0..1; the other arrays are the values at those offsets.
export const TUTORIAL_MOTION = {
  // .elcard elsway 6s: left (dislike), back, right (like), back.
  sway: {
    ms: 6000,
    at: [0, 0.1, 0.22, 0.34, 0.6, 0.72, 0.84, 1],
    x: [0, -14, -14, 0, 14, 14, 0, 0],
    rotateMobile: [0, -2, -2, 0, 2, 2, 0, 0],
    rotateWeb: [0, -1.5, -1.5, 0, 1.5, 1.5, 0, 0],
  },
  // .elleft / .elright 6s: the DISLIKE and LIKE pills light up as the card leans.
  dislikePill: { ms: 6000, at: [0, 0.1, 0.22, 0.34, 1], opacity: [0.3, 1, 1, 0.3, 0.3] },
  likePill: { ms: 6000, at: [0, 0.4, 0.6, 0.72, 0.84, 1], opacity: [0.3, 0.3, 1, 1, 0.3, 0.3] },
  // .elhint 1.6s: the continue arrow bounces up (phones) or down (web) 9 px.
  hint: { ms: 1600, at: [0, 0.5, 1], y: 9 },
  // .elnl / .elnr 1.6s (phones): the ← / → swipe arrows nudge 5 px outwards.
  nudge: { ms: 1600, at: [0, 0.5, 1], x: 5 },
  // .elmarq elscroll: the numbers strip slides by half its (doubled) width, linear.
  marquee: { msMobile: 30000, msWeb: 40000, gapMobile: 32, gapWeb: 44 },
} as const;

export function getTutorialSteps(variant: TutorialVariant): TutorialStep[] {
  const web = variant === 'web';
  const tap = web ? 'Click' : 'Tap';
  const cont = web ? 'Press ↓ or scroll to continue' : 'Swipe up to continue';
  return [
    {
      id: 'card',
      title: 'Welcome to Element: the news in a few sentences',
      lead: 'Every card is one story, short enough to read in seconds.',
      exampleCaption: 'Practice story',
      legend: [
        { label: 'The summary.', text: 'Short, plain, for busy people.' },
        { label: 'The source.', text: `${tap} it to see where it came from.` },
        { label: 'The label.', text: 'A computer wrote the summary, so check the source.' },
      ],
      tiles: web
        ? [
            { key: 'thumbs-down', title: 'Dislike', hint: 'click the thumbs-down or press ←', tone: 'warn' },
            { key: 'thumbs-up', title: 'Like', hint: 'click the thumbs-up or press →', tone: 'accent' },
            { key: '↓', title: 'Next card', hint: 'or press ↓, or scroll down', tone: 'next' },
          ]
        : [
            { key: '←', title: 'Swipe left', hint: 'Dislike', tone: 'warn' },
            { key: '→', title: 'Swipe right', hint: 'Like', tone: 'accent' },
          ],
      continueHint: cont,
    },
    {
      id: 'top',
      title: 'See the big picture, then pick your topics',
      exampleCaption: 'The top of your feed',
      legend: [
        {
          label: 'Numbers to know.',
          text:
            `The strip keeps key numbers moving past, like interest rates, inflation and jobs. ${tap} a number to open Numbers to know, with every figure and its official source.` +
            (web ? ' Example: “10-YR 5.10% ▼ 0.09” means that rate is 5.10% and fell 0.09 points.' : ''),
        },
        web
          ? { label: 'Categories.', text: 'Pick one on the left to see only that topic. Pick All to see everything.' }
          : { label: 'Categories.', text: 'Tap a chip to see only that topic. Tap All to see everything.' },
      ],
      continueHint: cont,
      practiceNote: 'Practice view, sample numbers',
    },
    {
      id: 'brief',
      title: 'Catch up each morning, then follow what matters',
      exampleCaption: web ? 'Two pages in the top bar' : 'Two tabs to try',
      legend: [
        { label: 'Brief.', text: 'The stories that matter, with a short AI summary.' },
        { label: 'Following.', text: 'Follow topics, companies or sources. Their newest stories collect here.' },
      ],
      continueHint: cont,
      practiceNote: 'Practice examples, not real news',
    },
    {
      id: 'recap',
      title: 'You’re all set',
      lead: 'That’s everything you need. Here’s a quick recap.',
      legend: [],
      recap: [
        web
          ? { icon: 'next', bold: 'Press ↓', text: ' for the next story' }
          : { icon: 'next', bold: 'Swipe up', text: ' for the next story' },
        web
          ? { icon: 'swipe', bold: 'Click the thumbs-down or thumbs-up.', text: ' It tunes your For you feed, no account needed.' }
          : { icon: 'swipe', bold: 'Left to dislike, right to like.', text: ' It tunes your For you feed, no account needed.' },
        { icon: 'source', bold: `${tap} the source`, text: ' on any card to see where it came from.' },
        { icon: 'follow', bold: 'Follow', text: ` a topic to see its stories in the Following ${web ? 'page' : 'tab'}.` },
        { icon: 'search', bold: 'Search', text: ' for a company, agency or topic.' },
      ],
    },
  ];
}

export const TUTORIAL_FOOTNOTE = 'No account needed to read. You can replay this tour anytime in Me.';
