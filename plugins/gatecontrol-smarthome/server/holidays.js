'use strict';

// Gesetzliche Feiertage in Deutschland (since 1.20.0, "Feiertage wie Sonntag"): computed here, no external service.
// A plan with "Feiertage wie Sonntag" (heat_plans.holidays, default on) runs its Sunday on these days — in the server
// part and on a gateway (the list goes with the gateway's configuration).
//
//   region   the setting heat_region: 'auto' (default: the federal state of the place the plugin knows — the location
//            of the logic chains, gc.settings sun.server / sun.<gateway> —, without one or outside Germany the holidays
//            of all states), 'DE' (only the holidays of all states) or a state: BW BY BE BB HB HH HE MV NI NW RP SL SN
//            ST SH TH.
//   days     every state: Neujahr, Karfreitag, Ostermontag, 1. Mai, Christi Himmelfahrt, Pfingstmontag, Tag der
//            Deutschen Einheit, 1. und 2. Weihnachtstag; Heilige Drei Könige (BW, BY, ST), Frauentag (BE from 2019, MV
//            from 2023), Fronleichnam (BW, BY, HE, NW, RP, SL), Mariä Himmelfahrt (SL; BY — there in most, not all
//            communities), Weltkindertag (TH from 2019), Reformationstag (BB, MV, SN, ST, TH; HB, HH, NI, SH from 2018),
//            Allerheiligen (BW, BY, NW, RP, SL), Buß- und Bettag (SN). Holidays of single towns (Augsburger
//            Friedensfest, Fronleichnam in parts of SN / TH) and one-off holidays are not in it.

const REGIONS = Object.freeze(['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH']);
const SETTINGS = Object.freeze(['auto', 'DE', ...REGIONS]);

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => { const x = new Date(Date.UTC(y, m - 1, d)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };

/** Easter Sunday of a year (Gregorian; the anonymous algorithm of Meeus / Jones / Butcher) → { month, day }. */
function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** The holidays of a year in a region ('DE' or a state) → [{ date: 'YYYY-MM-DD', key }] sorted by date. */
function holidaysOf(year, region) {
  const r = REGIONS.includes(region) ? region : 'DE';
  const e = easter(year);
  const fromEaster = (n) => iso(year, e.month, e.day + n);
  const out = [
    { date: iso(year, 1, 1), key: 'new_year' },
    { date: fromEaster(-2), key: 'good_friday' },
    { date: fromEaster(1), key: 'easter_monday' },
    { date: iso(year, 5, 1), key: 'labour_day' },
    { date: fromEaster(39), key: 'ascension' },
    { date: fromEaster(50), key: 'whit_monday' },
    { date: iso(year, 10, 3), key: 'unity_day' },
    { date: iso(year, 12, 25), key: 'christmas' },
    { date: iso(year, 12, 26), key: 'boxing_day' },
  ];
  const add = (states, date, key, since) => { if (states.includes(r) && (!since || year >= since)) out.push({ date, key }); };
  add(['BW', 'BY', 'ST'], iso(year, 1, 6), 'epiphany');
  add(['BE'], iso(year, 3, 8), 'womens_day', 2019);
  add(['MV'], iso(year, 3, 8), 'womens_day', 2023);
  add(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'], fromEaster(60), 'corpus_christi');
  add(['SL', 'BY'], iso(year, 8, 15), 'assumption');
  add(['TH'], iso(year, 9, 20), 'childrens_day', 2019);
  add(['BB', 'MV', 'SN', 'ST', 'TH'], iso(year, 10, 31), 'reformation');
  add(['HB', 'HH', 'NI', 'SH'], iso(year, 10, 31), 'reformation', 2018);
  add(['BW', 'BY', 'NW', 'RP', 'SL'], iso(year, 11, 1), 'all_saints');
  if (r === 'SN') {
    // Buß- und Bettag: the Wednesday before 23 November
    const nov22 = new Date(Date.UTC(year, 10, 22));
    out.push({ date: iso(year, 11, 22 - ((nov22.getUTCDay() - 3 + 7) % 7)), key: 'repentance' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Places in each state (latitude, longitude) — the state of a location is the one of the nearest place. Good enough
// for a default; close to a border the setting decides.
const PLACES = {
  SH: [[54.32, 10.13], [53.87, 10.69], [54.78, 9.44], [54.48, 9.05], [54.2, 9.1], [54.07, 9.98], [53.92, 9.52], [53.7, 10.01], [54.29, 10.88], [54.52, 9.56], [53.63, 10.53]],
  HH: [[53.55, 10.0], [53.49, 10.21], [53.46, 9.98], [53.6, 9.9], [53.65, 10.08]],
  HB: [[53.08, 8.8], [53.55, 8.58], [53.17, 8.63]],
  NI: [[52.37, 9.73], [52.27, 10.52], [52.28, 8.05], [53.14, 8.21], [51.54, 9.93], [53.25, 10.41], [53.53, 8.11], [53.37, 7.21], [52.62, 10.08], [52.42, 10.79],
    [52.15, 9.95], [53.86, 8.69], [52.97, 10.56], [52.52, 7.32], [52.64, 9.21], [53.6, 9.48], [51.91, 10.43], [51.83, 9.45], [52.73, 8.29], [52.92, 9.23],
    [52.97, 11.15], [52.43, 7.07], [53.47, 7.48], [52.1, 9.36], [51.71, 10.25], [53.31, 9.86]],
  NW: [[50.94, 6.96], [51.23, 6.78], [51.51, 7.47], [51.46, 7.01], [51.96, 7.63], [52.02, 8.53], [50.78, 6.08], [50.74, 7.1], [50.87, 8.02], [51.72, 8.75],
    [51.43, 6.76], [51.26, 7.15], [51.4, 8.06], [52.29, 8.92], [51.84, 6.61], [51.77, 9.38], [51.79, 6.14], [50.66, 6.79], [51.03, 7.56], [51.39, 8.57],
    [51.19, 8.53], [52.28, 7.44], [51.94, 8.88], [50.53, 6.47], [51.07, 6.23], [51.68, 7.82], [51.12, 8.36]],
  HE: [[50.11, 8.68], [50.08, 8.24], [51.31, 9.48], [49.87, 8.65], [50.58, 8.68], [50.55, 9.68], [50.81, 8.77], [50.39, 8.06], [50.87, 9.71], [51.27, 8.87],
    [51.19, 10.05], [49.64, 8.63], [49.66, 8.99], [50.13, 8.92], [50.56, 8.5], [50.33, 9.53], [51.0, 9.4], [50.25, 8.6]],
  RP: [[50.0, 8.27], [50.36, 7.59], [49.75, 6.64], [49.44, 7.77], [49.48, 8.44], [49.2, 7.6], [49.85, 7.87], [49.2, 8.12], [49.97, 6.53], [50.44, 7.83],
    [50.69, 7.65], [49.71, 7.31], [50.15, 7.17], [50.2, 6.83], [49.63, 8.36], [50.54, 7.1], [49.95, 7.1], [49.55, 7.4]],
  SL: [[49.24, 6.99], [49.31, 6.75], [49.35, 7.18], [49.44, 6.64], [49.47, 7.17], [49.33, 7.34], [49.5, 6.9]],
  BW: [[48.78, 9.18], [49.01, 8.4], [49.49, 8.47], [47.99, 7.84], [49.4, 8.69], [48.4, 9.99], [49.14, 9.22], [47.66, 9.18], [48.49, 9.21], [47.78, 9.61],
    [48.47, 7.94], [48.06, 8.46], [48.84, 10.09], [49.11, 9.74], [49.62, 9.66], [47.61, 7.66], [48.09, 9.22], [48.89, 8.7], [49.35, 9.15], [48.1, 9.79],
    [48.52, 9.06], [47.62, 8.21], [49.13, 10.07], [48.76, 8.24], [48.35, 8.4], [48.7, 9.65]],
  BY: [[48.14, 11.58], [49.45, 11.08], [48.37, 10.9], [49.01, 12.1], [49.79, 9.95], [48.76, 11.42], [48.57, 13.43], [49.89, 10.89], [49.95, 11.58], [50.31, 11.92],
    [49.97, 9.15], [47.73, 10.31], [47.86, 12.12], [48.54, 12.15], [49.68, 12.16], [50.26, 10.96], [50.05, 10.23], [49.3, 10.57], [47.49, 11.1], [47.63, 13.0],
    [47.55, 9.68], [48.84, 12.96], [49.22, 12.66], [50.2, 10.08], [48.39, 10.01], [47.98, 10.18], [48.85, 10.49], [48.23, 12.68], [49.44, 11.86], [48.89, 11.18],
    [50.24, 11.33], [49.7, 9.26], [49.38, 10.18], [49.03, 10.97], [48.81, 13.55], [50.32, 10.22], [48.0, 11.35], [47.75, 11.75]],
  BE: [[52.52, 13.4], [52.54, 13.2], [52.44, 13.58], [52.6, 13.35], [52.45, 13.3]],
  BB: [[52.4, 13.06], [51.76, 14.33], [52.35, 14.55], [52.41, 12.55], [52.83, 13.82], [53.32, 13.86], [52.93, 12.8], [53.0, 11.75], [52.09, 13.17], [51.63, 13.71],
    [53.06, 14.28], [52.3, 13.63], [53.07, 11.86], [51.52, 14.0], [51.94, 13.89], [52.14, 12.59], [52.75, 13.24], [52.36, 14.06], [51.95, 14.72], [53.12, 13.5],
    [51.69, 13.23]],
  MV: [[53.63, 11.41], [54.09, 12.1], [54.31, 13.09], [54.09, 13.38], [53.56, 13.26], [53.89, 11.47], [53.79, 12.17], [53.52, 12.68], [53.33, 11.5], [53.51, 13.99],
    [54.42, 13.43], [53.43, 11.85], [53.86, 13.69], [53.43, 11.19], [53.36, 13.06], [53.74, 14.04]],
  SN: [[51.05, 13.74], [51.34, 12.37], [50.83, 12.92], [50.72, 12.49], [50.5, 12.14], [51.15, 14.99], [51.18, 14.42], [50.91, 13.34], [51.31, 13.29], [51.56, 13.0],
    [50.58, 13.0], [50.96, 13.94], [51.44, 14.25], [51.12, 13.12], [51.3, 13.11], [51.24, 12.73], [51.53, 12.34], [50.9, 14.81], [50.59, 12.7], [50.65, 13.16],
    [51.5, 14.64], [51.12, 12.5]],
  ST: [[52.12, 11.63], [51.48, 11.97], [51.83, 12.24], [51.87, 12.65], [52.61, 11.86], [51.9, 11.05], [51.84, 10.79], [51.79, 11.74], [51.15, 11.81], [52.85, 11.15],
    [51.47, 11.3], [51.35, 11.99], [51.75, 11.97], [52.27, 11.86], [52.29, 11.41], [51.79, 11.15], [51.05, 12.14], [51.62, 12.33], [52.41, 12.16], [52.82, 12.07],
    [52.53, 11.39], [51.2, 11.97], [52.02, 11.73], [51.53, 11.55]],
  TH: [[50.98, 11.03], [50.93, 11.59], [50.88, 12.08], [50.98, 11.33], [50.95, 10.7], [50.98, 10.32], [50.61, 10.69], [51.5, 10.79], [51.21, 10.45], [50.65, 11.36],
    [50.57, 10.42], [50.35, 11.17], [50.99, 12.43], [50.83, 10.95], [51.38, 10.14], [51.16, 11.12], [50.72, 11.34], [50.66, 12.2], [50.69, 11.59], [50.43, 10.73],
    [51.37, 10.87], [50.81, 10.23], [50.58, 11.81], [51.03, 11.51]],
};
const NEAR_KM = 60;

function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

/** The federal state of a location { lat, lon } — or null (none, outside Germany). */
function regionAt(loc) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  if (loc.lat < 47.2 || loc.lat > 55.1 || loc.lon < 5.8 || loc.lon > 15.1) return null;
  let best = null;
  for (const [r, list] of Object.entries(PLACES)) {
    for (const p of list) {
      const d = km([loc.lat, loc.lon], p);
      if (!best || d < best.d) best = { r, d };
    }
  }
  return best && best.d <= NEAR_KM ? best.r : null;
}

/** The region of the setting: { region: 'DE' | state, auto (from the location) }. */
function resolve(setting, loc) {
  const s = SETTINGS.includes(setting) ? setting : 'auto';
  if (s !== 'auto') return { region: s, auto: false };
  return { region: regionAt(loc) || 'DE', auto: true };
}

/** The holiday dates of the years from `fromYear` (count years) → sorted, without duplicates. */
function datesOf(region, fromYear, years = 2) {
  const out = new Set();
  for (let y = fromYear; y < fromYear + years; y++) for (const h of holidaysOf(y, region)) out.add(h.date);
  return [...out].sort();
}

module.exports = { REGIONS, SETTINGS, easter, holidaysOf, regionAt, resolve, datesOf };
