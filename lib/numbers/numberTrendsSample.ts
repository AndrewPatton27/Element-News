// Sample number trends for the mock API (same values as docs/design/web/Web-Final.dc.html).
// Fictional sample data: the app shows the SAMPLE DATA banner when this is in use.

import type { NumberTrend } from '../../contract/types.ts';

export const SAMPLE_NUMBER_TRENDS: NumberTrend[] = [
  { key: 'DGS10', name: '10-year Treasury yield', value: '5.10%', change: '▼ 0.09 this week', direction: 'down', source: 'U.S. Treasury', points: [4.62, 4.7, 4.74, 4.81, 4.86, 4.9, 4.97, 5.02, 5.08, 5.15, 5.19, 5.1] },
  { key: 'CPIAUCSL', name: 'Inflation (CPI, yearly)', value: '3.1%', change: '▼ 0.2 since last month', direction: 'down', source: 'U.S. Bureau of Labor Statistics', points: [3.9, 3.8, 3.8, 3.7, 3.6, 3.6, 3.5, 3.4, 3.4, 3.3, 3.3, 3.1] },
  { key: 'UNRATE', name: 'Unemployment rate', value: '4.2%', change: '● unchanged', direction: 'flat', source: 'U.S. Bureau of Labor Statistics', points: [3.9, 3.9, 4.0, 4.0, 4.0, 4.1, 4.1, 4.1, 4.2, 4.2, 4.2, 4.2] },
  { key: 'DCOILWTICO', name: 'Crude oil (WTI)', value: '$71.40', change: '▲ 0.90 this week', direction: 'up', source: 'U.S. Energy Information Administration', points: [78, 77, 75, 74, 72, 73, 70, 69, 70, 72, 70.5, 71.4] },
];
