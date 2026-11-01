#!/usr/bin/env node
'use strict';

// Builds server/places.txt.gz — the place names Drive finds offline for a photo's coordinates (server/geonames.js,
// since 1.16.0) — from GeoNames (https://www.geonames.org, CC BY 4.0). Not part of the package (test/ is left out);
// run it again to refresh the data:
//
//   curl -O https://download.geonames.org/export/dump/cities1000.zip && unzip cities1000.zip
//   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   curl -O https://download.geonames.org/export/dump/alternateNamesV2.zip
//   unzip -p alternateNamesV2.zip alternateNamesV2.txt | awk -F'\t' '$3=="de"||$3=="en"' > alt-de-en.txt
//   node test/build-places.js <folder with the three files> server/places.txt.gz
//
// Kept of cities1000 (every populated place with ≥ 1000 inhabitants, ~170 000): the geonameid, the coordinates (1e-4°,
// ~11 m), the country, admin1 (the region), the name and — where GeoNames has one that differs — the German and the
// English name. Left out: historical, abandoned and destroyed places (PPLH, PPLQ, PPLW, PPLCH).
//
// A place is a city (Stadt bzw. Gemeinde) or a district (Ortsteil) of one:
//   * where the admin codes name the municipality (DE, FR, BE: admin4; AT, CH, IT, ES, PL: admin3; NL: admin2), every
//     place of a municipality but its largest is a district of the largest (Hamburg: Altona, Ottensen …; a village
//     of a German Gemeinde: an Ortsteil of its main place)
//   * elsewhere a section of a populated place (PPLX) is a district of the nearest city of its country within 15 km
//   * every other place is a city
//
// The file (UTF-8 text, gzip): the line "GN1", the regions as "<name>\t<German name or empty>", the line "--", then the
// places by geonameid: "<id − previous id>\t<lat·1e4>\t<lon·1e4>\t<country>\t<region index>\t<parent index or empty:
// a city>\t<name>\t<German name or empty>\t<English name or empty>".

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');

const SKIP = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
const LEVEL = { DE: 4, FR: 4, BE: 4, AT: 3, CH: 3, IT: 3, ES: 3, PL: 3, NL: 2 };
const NEAR_KM = 15;

async function lines(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) if (l) fn(l.split('\t'));
}

function km(a, b) {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

const clean = (s) => String(s || '').replace(/[\t\n\r]/g, ' ').trim();

async function main(dir, out) {
  const places = [];
  await lines(path.join(dir, 'cities1000.txt'), (c) => {
    if (SKIP.has(c[7])) return;
    places.push({ id: Number(c[0]), name: clean(c[1]), lat: Number(c[4]), lon: Number(c[5]), fc: c[7], cc: c[8], a: [c[10], c[11], c[12], c[13]], pop: Number(c[14]) || 0 });
  });
  places.sort((x, y) => x.id - y.id);
  const byId = new Map(places.map((p, i) => [p.id, i]));
  // regions: admin1 "CC.code" → { name, gid }
  const admin1 = new Map();
  await lines(path.join(dir, 'admin1CodesASCII.txt'), (c) => admin1.set(c[0], { name: clean(c[1]), gid: Number(c[3]) }));
  const regionGids = new Map([...admin1.values()].map((r) => [r.gid, r]));
  // German and English names: the preferred one, else the shortest — in German-speaking countries only a preferred
  // German name (the name is German there; the others are mostly longer forms like „Oberhaching bei München“)
  const alt = { de: new Map(), en: new Map() };
  const shortest = new Map();
  await lines(path.join(dir, 'alt-de-en.txt'), (r) => {
    const lang = r[2];
    if (lang !== 'de' && lang !== 'en') return;
    if (r[6] === '1' || r[7] === '1') return; // colloquial, historic
    const gid = Number(r[1]);
    if (!byId.has(gid) && !regionGids.has(gid)) return;
    const m = alt[lang];
    const cur = m.get(gid);
    const x = { name: clean(r[3]), pref: r[4] === '1' };
    if (!x.name) return;
    if (!cur || (x.pref && !cur.pref) || (x.pref === cur.pref && x.name.length < cur.name.length)) m.set(gid, x);
    // a region: its shortest German name („Hamburg“, not „Freie und Hansestadt Hamburg“)
    const s = shortest.get(gid);
    if (lang === 'de' && regionGids.has(gid) && (!s || x.name.length < s.length)) shortest.set(gid, x.name);
  });
  const GERMAN = new Set(['DE', 'AT', 'CH', 'LI']);
  const de = (gid, name, cc) => { const x = alt.de.get(gid); return x && x.name !== name && (x.pref || !GERMAN.has(cc)) ? x.name : ''; };
  const en = (gid, name, d) => { const x = alt.en.get(gid); return x && x.name !== name && x.name !== d ? x.name : ''; };
  // regions used
  const regions = [];
  const regionIdx = new Map();
  for (const p of places) {
    const key = `${p.cc}.${p.a[0]}`;
    if (!regionIdx.has(key)) {
      const r = admin1.get(key);
      regionIdx.set(key, r ? regions.length : -1);
      if (r) regions.push({ name: r.name, de: shortest.has(r.gid) && shortest.get(r.gid) !== r.name ? shortest.get(r.gid) : '' });
    }
    p.region = regionIdx.get(key);
  }
  // municipalities: every place but the largest becomes its district
  const groups = new Map();
  places.forEach((p, i) => {
    const lv = LEVEL[p.cc];
    if (!lv || !p.a[lv - 1]) return;
    const key = [p.cc, ...p.a.slice(0, lv)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    let seat = -1;
    for (const i of ids) if (places[i].fc !== 'PPLX' && (seat < 0 || places[i].pop > places[seat].pop)) seat = i;
    if (seat < 0) continue;
    for (const i of ids) if (i !== seat) places[i].parent = seat;
  }
  // the other sections of a place: the nearest city of their country (a grid of 0.5°)
  const cell = (lat, lon) => `${Math.floor(lat * 2)}:${Math.floor(lon * 2)}`;
  const grid = new Map();
  places.forEach((p, i) => {
    if (p.fc === 'PPLX' || p.parent != null) return;
    const k = cell(p.lat, p.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  for (const p of places) {
    if (p.fc !== 'PPLX' || p.parent != null) continue;
    let best = -1;
    let bestKm = NEAR_KM;
    const la = Math.floor(p.lat * 2);
    const lo = Math.floor(p.lon * 2);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const i of grid.get(`${la + dy}:${lo + dx}`) || []) {
          const q = places[i];
          if (q.cc !== p.cc) continue;
          const d = km(p, q);
          // the nearest, a larger one wins when about as near (a section lies inside its city, not its suburb)
          const w = d / (1 + Math.log10(1 + q.pop / 10000));
          if (w < bestKm) { bestKm = w; best = i; }
        }
      }
    }
    if (best >= 0) p.parent = best;
  }
  const rows = ['GN1'];
  for (const r of regions) rows.push(`${r.name}\t${r.de}`);
  rows.push('--');
  let prev = 0;
  for (const p of places) {
    const d = de(p.id, p.name, p.cc);
    rows.push([p.id - prev, Math.round(p.lat * 1e4), Math.round(p.lon * 1e4), p.cc, p.region, p.parent == null ? '' : p.parent, p.name, d, en(p.id, p.name, d)].join('\t'));
    prev = p.id;
  }
  const buf = zlib.gzipSync(Buffer.from(rows.join('\n') + '\n', 'utf8'), { level: 9 });
  fs.writeFileSync(out, buf);
  const districts = places.filter((p) => p.parent != null).length;
  process.stdout.write(`${places.length} places (${districts} districts), ${regions.length} regions → ${out} (${buf.length} bytes)\n`);
}

if (process.argv.length < 4) {
  process.stderr.write('usage: node test/build-places.js <folder> <out.txt.gz>\n');
  process.exit(2);
}
main(process.argv[2], process.argv[3]).catch((e) => { process.stderr.write(String(e && e.stack) + '\n'); process.exit(1); });
