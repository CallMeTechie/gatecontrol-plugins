'use strict';

// Sunrise and sunset for the logic chains (since 1.12.0) — pure, no I/O, used by the edge part on the gateway and by
// the server part for the chains that run there (server/serverchains.js).
//
//   times(date, lat, lon) → { rise, set } — ms since the epoch of that day's sunrise / sunset at the place
//                           (`date` 'YYYY-MM-DD', the day of the house); null for one that does not happen there that
//                           day (polar night: no rise and no set; polar day: neither either — the sun stays up)
//   polar(date, lat, lon) → 'day' | 'night' | null
//
// The NOAA approximation (equation of time and declination as Fourier series, the sun's upper limb with refraction:
// zenith 90.833°). Within one or two minutes for the inhabited latitudes — plenty for "30 min after sunset".

const RAD = Math.PI / 180;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validPlace(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function dayOfYear(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

/** The hour angle (degrees) of sunrise / sunset, or 'day' / 'night' when the sun does not cross the horizon. */
function solar(date, lat, lon) {
  const m = DATE_RE.exec(String(date || ''));
  if (!m || !validPlace(lat, lon)) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null; // 2026-13-01, 2026-02-30
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const g = ((2 * Math.PI) / (leap ? 366 : 365)) * (dayOfYear(y, mo, d) - 1);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const phi = lat * RAD;
  const cosH = Math.cos(90.833 * RAD) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
  const base = Date.UTC(y, mo - 1, d);
  if (cosH > 1) return { polar: 'night', base, eqtime };
  if (cosH < -1) return { polar: 'day', base, eqtime };
  return { polar: null, ha: Math.acos(cosH) / RAD, base, eqtime };
}

function times(date, lat, lon) {
  const s = solar(date, lat, lon);
  if (!s || s.polar) return { rise: null, set: null };
  const minutes = (sign) => 720 - 4 * (lon + sign * s.ha) - s.eqtime;
  return { rise: Math.round(s.base + minutes(1) * 60000), set: Math.round(s.base + minutes(-1) * 60000) };
}

function polar(date, lat, lon) {
  const s = solar(date, lat, lon);
  return s ? s.polar : null;
}

module.exports = { times, polar, validPlace };
