'use strict';

// Is the sun down at a place? (presence rules: condition "after sunset").
// The sun's altitude from the usual low-precision formulas (about 1′ —
// minutes off at most); "down" = below −0.833° (refraction and the sun's
// radius, the definition of sunrise/sunset). Polar day/night simply follow.

const RAD = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** The sun's altitude in degrees at `ms` seen from lat/lon. */
function altitude(ms, lat, lon) {
  const d = (ms - J2000_MS) / 86400000;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d;
  const ha = ((gmst * 15 + lon) * RAD) - ra;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) / RAD;
}

/** After sunset and before the next sunrise. */
function isDown(ms, lat, lon) {
  return altitude(ms, lat, lon) < -0.833;
}

module.exports = { altitude, isDown };
