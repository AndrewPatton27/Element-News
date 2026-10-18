// USGS significant earthquakes (GeoJSON, no key) -> template card (no AI), category science.
// Public domain ("USGS-authored or produced data and information are considered to be in the
// U.S. Public Domain"). Credit: U.S. Geological Survey. No page is downloaded.
// Inputs: the significant-week GeoJSON. Outputs: RawItems (event data as JSON in summary_text)
// and plain template drafts (headline/body without distances, bearings or clock times).

import { config } from '../config.ts';
import type { RawItem, SummaryDraft } from '../types.ts';

export interface UsgsFeature {
  id: string;
  properties: {
    mag?: number | null;
    place?: string | null;
    time?: number | null;            // epoch ms
    url?: string | null;             // event page
    alert?: string | null;           // green | yellow | orange | red | null
    tsunami?: number | null;         // 1 = oceanic region flag (not a warning)
    title?: string | null;
    type?: string | null;
  };
}

/** Parses the GeoJSON feature list; throws on non-JSON or a missing list. */
export function parseUsgsGeoJson(text: string): UsgsFeature[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('usgs: response is not JSON'); }
  const f = (j as { features?: unknown })?.features;
  if (!Array.isArray(f)) throw new Error('usgs: no features list');
  return f.filter((x): x is UsgsFeature => !!x && typeof x.id === 'string' && !!x.properties);
}

export type UsgsSkipReason = 'bad_url' | 'too_old' | 'no_data' | 'low_interest';

/** true when the place name means open water: no country after a comma, or a ridge / rise / ocean / sea / trench word. */
export function isAtSea(place: string | null | undefined): boolean {
  const p = (place ?? '').trim();
  if (!p || !p.includes(',')) return true;                 // "central Mid-Atlantic Ridge": no country
  return config.usgs.atSeaPattern.test(p);
}

/**
 * Publishing threshold. A PAGER alert of yellow, orange or red always publishes. A quake whose alert is
 * green or missing is low interest (returns the reason) when it is at sea / on an ocean ridge or rise / has
 * no country, or when its magnitude is under config.usgs.minMagnitudeWithoutAlert (6.5). Otherwise null.
 */
export function lowInterestReason(p: { mag?: number | null; place?: string | null; alert?: string | null }): string | null {
  const alert = (p.alert ?? '').toLowerCase();
  if ((config.usgs.keepAlerts as readonly string[]).includes(alert)) return null;
  const alertText = alert || 'no';
  if (isAtSea(p.place)) return `${alertText} alert, at sea or no country`;
  if (typeof p.mag === 'number' && p.mag < config.usgs.minMagnitudeWithoutAlert) {
    return `${alertText} alert, magnitude ${p.mag.toFixed(1)} under ${config.usgs.minMagnitudeWithoutAlert}`;
  }
  return null;
}

/**
 * Feature -> RawItem, or a skip reason (missing data, older than config.usgs.maxAgeDays, non-USGS URL,
 * low interest: see lowInterestReason). `note` explains a low_interest skip for the log.
 */
export function usgsToItem(f: UsgsFeature, now: Date): { item: RawItem } | { skip: UsgsSkipReason; note?: string } {
  const p = f.properties;
  if (typeof p.mag !== 'number' || !p.time || !p.title) return { skip: 'no_data' };
  if (p.time < now.getTime() - config.usgs.maxAgeDays * 86_400_000) return { skip: 'too_old' };
  let url: URL;
  try { url = new URL(p.url ?? ''); } catch { return { skip: 'bad_url' }; }
  if (url.protocol !== 'https:' || url.hostname !== 'earthquake.usgs.gov') return { skip: 'bad_url' };
  const low = lowInterestReason(p);
  if (low) return { skip: 'low_interest', note: low };
  return {
    item: {
      source: 'usgs',
      external_id: f.id,
      url: url.toString(),
      title: p.title,
      published_at: new Date(Math.min(p.time, now.getTime())).toISOString(),
      license_class: 'public_domain',
      category: config.usgs.category,
      event_type: config.usgs.eventType,
      tickers: [],
      source_name: config.usgs.sourceName,
      source_kind: 'government',
      doc_label: 'Earthquake',
      summary_text: JSON.stringify({ mag: p.mag, place: p.place ?? null, time: p.time, alert: p.alert ?? null, tsunami: p.tsunami ?? 0 }),
      attribution: config.usgs.attribution,
    },
  };
}

/** US state and territory abbreviations -> full names (USGS places use "..., CA"). */
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'Washington, D.C.', PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

/**
 * A plain, recognizable place for a USGS quake, with no distance, bearing or nearest town.
 * Returns the broad place plus a verb for the headline and a preposition for the body:
 *   headline reads "earthquake <headlineVerb> <region>", body reads "struck <bodyPrep> <region>".
 * - "48 km WNW of Khuzdar, Pakistan" -> hits / in Pakistan
 * - "10 km N of Ridgecrest, CA"       -> in / in California
 * - "central Mid-Atlantic Ridge"      -> on the / on the Mid-Atlantic Ridge
 */
export function plainQuakeLocation(place: string | null): { region: string; headlineVerb: string; bodyPrep: string } | null {
  if (!place) return null;
  const comma = place.lastIndexOf(',');
  if (comma >= 0) {
    // Take whatever follows the last comma (country, or a US state code / name).
    const tail = place.slice(comma + 1).trim();
    if (!tail) return null;
    const state = US_STATES[tail.toUpperCase()];
    if (state) return { region: state, headlineVerb: 'in', bodyPrep: 'in' };     // US state abbreviation -> full name
    return { region: tail, headlineVerb: 'hits', bodyPrep: 'in' };               // country or named region
  }
  // No comma: an ocean ridge, sea or offshore region. Drop a leading direction word
  // ("central", "northern", "southern", "eastern", "western") so it reads naturally.
  const region = place.replace(/^(central|north(ern)?|south(ern)?|east(ern)?|west(ern)?)\s+/i, '').trim();
  if (!region) return null;
  const prep = /\b(sea|ocean|gulf|strait)\b/i.test(region) ? 'in the'
    : /\b(ridge|rise|trench|coast|border|region|island|islands|rift)\b/i.test(region) ? 'on the'
    : 'near';
  return { region, headlineVerb: prep, bodyPrep: prep };
}

/** Plain earthquake headline: "Magnitude 5.7 earthquake hits Pakistan". Never exposes distance/bearing/town. */
export function usgsHeadline(mag: number, place: string | null): string {
  const loc = plainQuakeLocation(place);
  const base = loc ? `Magnitude ${mag.toFixed(1)} earthquake ${loc.headlineVerb} ${loc.region}` : `Magnitude ${mag.toFixed(1)} earthquake reported`;
  return base.length > config.headlineMaxChars ? base.slice(0, config.headlineMaxChars - 1) + '…' : base;
}

/** Template card text from the event data (no AI). Headline and body stay plain:
 *  no exact distance, bearing, nearest town or clock time (those go only in the detail key points). */
export function usgsDraft(it: RawItem): SummaryDraft {
  const d = JSON.parse(it.summary_text) as { mag: number; place: string | null; time: number; alert: string | null; tsunami: number };
  const loc = plainQuakeLocation(d.place);
  const where = loc ? `${loc.bodyPrep} ${loc.region}` : 'in an unnamed area';
  const parts = [`A magnitude ${d.mag.toFixed(1)} earthquake struck ${where}.`];
  if (d.alert) {
    const ALERT_MEANING: Record<string, string> = {
      green: 'little or no damage is expected',
      yellow: 'some damage is possible',
      orange: 'significant damage is likely',
      red: 'heavy damage is likely',
    };
    const meaning = ALERT_MEANING[d.alert.toLowerCase()];
    parts.push(`The USGS rated the expected damage as ${d.alert}${meaning ? ` (${meaning})` : ''}.`);
  }
  if (d.tsunami === 1) parts.push('It was in an ocean region; official tsunami warnings come from tsunami.gov.');
  return {
    headline: usgsHeadline(d.mag, d.place),
    body: parts.join(' '),
    category: it.category,
    event_type: it.event_type,
    tickers: [],
  };
}
