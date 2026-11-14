'use strict';

// Fakes for the tests of places (1.5.0): a search service that speaks Nominatim's /search (a handful of places around
// the Alexanderplatz), Familie as far as places go (the services `places` and `geofences`), and a host with both.

const { withHost, fakeSource, ANNA, MARC, LENA, PLUGINS } = require('./helpers');
const search = require('../server/placesearch');
const places = require('../server/places');
const shopping = require('../server/shopping');

const HOME = { lat: 52.5203, lon: 13.4051 };       // where the phone is (never to be seen by the search service)
const CELL = { lat: 52.52, lon: 13.41 };
const POI = [
  { osm_type: 'way', osm_id: 101, lat: '52.5390', lon: '13.4240', category: 'shop', type: 'doityourself', name: 'Baumarkt Nord', address: { road: 'Industriestraße', house_number: '4', city: 'Berlin' } },
  { osm_type: 'way', osm_id: 102, lat: '52.5010', lon: '13.3620', category: 'shop', type: 'doityourself', name: 'Baumarkt am Ring', address: { road: 'Ringstraße', house_number: '21', city: 'Berlin' } },
  { osm_type: 'node', osm_id: 103, lat: '52.4600', lon: '13.4900', category: 'shop', type: 'doityourself', name: 'Baumarkt Süd', address: { road: 'Am Hafen', house_number: '2', city: 'Berlin' } },
  { osm_type: 'node', osm_id: 104, lat: '52.5215', lon: '13.4100', category: 'amenity', type: 'restaurant', name: 'Zum Baumarkt', address: { road: 'Kneipenweg', city: 'Berlin' } },
  { osm_type: 'node', osm_id: 201, lat: '52.5260', lon: '13.4160', category: 'shop', type: 'supermarket', name: 'Lidl', address: { road: 'Marktstraße', house_number: '12', city: 'Berlin' } },
  { osm_type: 'node', osm_id: 202, lat: '52.5080', lon: '13.3750', category: 'shop', type: 'supermarket', name: 'Lidl', address: { road: 'Bahnhofsplatz', house_number: '3', city: 'Berlin' } },
  { osm_type: 'node', osm_id: 301, lat: '52.5210', lon: '13.4090', category: 'place', type: 'house', name: '', display_name: 'Ringstraße 21, Berlin', address: { road: 'Ringstraße', house_number: '21', city: 'Berlin' } },
];

/** A fake Nominatim: answers by the query (a special phrase in brackets, a name, an address) inside the viewbox. */
function nominatim(state) {
  return async (url, opts) => {
    const u = new URL(/^https?:/.test(url) ? url : 'https://own.example' + url);
    state.calls.push({ url: String(url), q: u.searchParams.get('q'), viewbox: u.searchParams.get('viewbox'), bounded: u.searchParams.get('bounded'), agent: opts && opts.headers && opts.headers['user-agent'], at: Date.now() });
    if (state.fail) return { status: 503, body: 'down' };
    const q = u.searchParams.get('q');
    const [left, top, right, bottom] = u.searchParams.get('viewbox').split(',').map(Number);
    const inBox = (p) => Number(p.lat) <= top && Number(p.lat) >= bottom && Number(p.lon) >= left && Number(p.lon) <= right;
    let hits;
    if (q === '[Baumarkt]') hits = POI.filter((p) => /Baumarkt/.test(p.name));
    else if (/^lidl$/i.test(q)) hits = POI.filter((p) => p.name === 'Lidl');
    else if (/Ringstraße 21/.test(q)) hits = POI.filter((p) => p.osm_id === 301);
    else hits = [];
    return { status: 200, body: JSON.stringify(u.searchParams.get('bounded') === '1' ? hits.filter(inBox) : hits) };
  };
}

/** Familie as far as places go: the service `places` (home, a rule place) and `geofences` (what its phones watch). */
function familie(state) {
  const provides = { places: { label: { de: 'x', en: 'x' }, maxPerHour: 3600 }, ...(state.noBudget ? {} : { geofences: { label: { de: 'x', en: 'x' }, maxPerHour: 3600 } }) };
  return fakeSource('gatecontrol-familie', { provides, service: async ({ name, payload }) => {
    if (name === 'places') return [ANNA.id, MARC.id, LENA.id].includes(payload.userId) ? [{ id: 'home', name: 'Zuhause', lat: 52.5203, lon: 13.4051, radiusM: 150 }, { id: 'place:3', name: 'Schule', lat: 52.5301, lon: 13.4101, radiusM: 300 }] : [];
    if (name === 'geofences') return { ok: true, reminders: state.reminders || 0, rulePlaces: 1, total: (state.reminders || 0) + 1, max: 100 };
    return { ok: false, code: 'not_found' };
  } });
}

async function host(opts = {}) {
  const net = { calls: [], fail: false };
  const fam = { reminders: 0, ...(opts.fam || {}) };
  const sources = opts.noFamily ? PLUGINS.filter((p) => p !== 'gatecontrol-familie').map((p) => fakeSource(p)) : PLUGINS.map((p) => (p === 'gatecontrol-familie' ? familie(fam) : fakeSource(p)));
  const h = await withHost({ settings: { place_search: 'osm', ...(opts.settings || {}) }, sources, fetch: nominatim(net), host: opts.targets ? { targets: { places: [{ label: 'Nominatim', fetch: nominatim(net) }] } } : {}, ...(opts.now ? { now: opts.now } : {}) });
  shopping.state.noTimer = true;
  search.reset(); places.reset();
  search.state.pauseMs = opts.pauseMs || 0;
  return Object.assign(h, { net, fam });
}

module.exports = { host, nominatim, familie, POI, HOME, CELL };
