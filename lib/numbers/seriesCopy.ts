// One plain-language line per macro series for the Numbers screen. This is UI
// copy, not data: unknown series simply show no explainer.

const PLAIN: Record<string, string> = {
  DGS10: 'What the U.S. government pays to borrow for 10 years. Moves mortgage rates.',
  DGS2: 'Where traders expect short-term rates to go.',
  DFF: 'The Fed’s main lending rate. Sets the tone for loans and savings.',
  CPIAUCSL: 'How much more everyday things cost than a year ago.',
  UNRATE: 'Share of people looking for work who can’t find it.',
  DCOILWTICO: 'A key oil price. Feeds into gas and shipping costs.',
};

export function plainExplainer(seriesId: string): string | null {
  return PLAIN[seriesId] ?? null;
}
