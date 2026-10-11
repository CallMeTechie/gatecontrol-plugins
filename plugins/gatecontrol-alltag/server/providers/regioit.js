'use strict';

// regio iT "AbfallNavi" (abfallapp.regioit.de) — the waste app of many
// municipalities in NRW and beyond. Public JSON REST per service:
//   https://<service>-abfallapp.regioit.de/abfall-app-<service>/rest/
//     orte                          places
//     orte/<id>/strassen            streets of a place
//     strassen/<id>                 the street with its house numbers
//     fraktionen                    fractions (name, colour)
//     hausnummern|strassen/<id>/termine?fraktion=<id>&…   dates
// A few services only answer on the shared host abfallapp.regioit.de.
// Service list: the services that answered a live lookup when this
// plugin was built (reference: mampfes/hacs_waste_collection_schedule).

const { getJson, items, color, providerError } = require('./http');

const SERVICES = [
  { id: 'aachen', title: 'Stadt Aachen' },
  { id: 'aw-bgl2', title: 'Abfallwirtschaftsbetrieb Bergisch Gladbach' },
  { id: 'zew2', title: 'AWA Entsorgungs GmbH' },
  { id: 'krwaf', title: 'AWG Kreis Warendorf' },
  { id: 'bav', title: 'Bergischer Abfallwirtschaftverbund' },
  { id: 'coe', title: 'Kreis Coesfeld' },
  { id: 'cottbus', title: 'Stadt Cottbus' },
  { id: 'din', title: 'Dinslaken' },
  { id: 'dorsten', title: 'Stadt Dorsten' },
  { id: 'wml2', title: 'EGW Westmünsterland' },
  { id: 'krwaf', title: 'Kreis Gütersloh GEG' },
  { id: 'hlv', title: 'Halver' },
  { id: 'krhs', title: 'Kreis Heinsberg' },
  { id: 'kronberg', title: 'Kronberg im Taunus' },
  { id: 'muelheim', title: 'MHEG Mülheim an der Ruhr' },
  { id: 'nds', title: 'Stadt Norderstedt' },
  { id: 'pi', title: 'Kreis Pinneberg' },
  { id: 'solingen', title: 'Stadt Solingen' },
  { id: 'stl', title: 'STL Lüdenscheid' },
  { id: 'unna', title: 'GWA - Kreis Unna mbH', shared: true },
  { id: 'viersen', title: 'Kreis Viersen' },
  { id: 'oberhausen', title: 'WBO Wirtschaftsbetriebe Oberhausen' },
  { id: 'zew2', title: 'ZEW Zweckverband Entsorgungsregion West' },
  { id: 'cux', title: 'Stadt Cuxhaven' },
  { id: 'frankenthal', title: 'Stadt Frankenthal', shared: true },
  { id: 'awvlippe', title: 'Abfallwirtschaftsverband Lippe', shared: true },
  { id: 'kranenburg', title: 'Gemeinde Kranenburg', shared: true },
  { id: 'portawestfalica', title: 'Stadt Porta Westfalica' },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function bases(service) {
  const known = SERVICES.find((s) => s.id === service);
  const own = `https://${service}-abfallapp.regioit.de/abfall-app-${service}/rest`;
  const shared = `https://abfallapp.regioit.de/abfall-app-${service}/rest`;
  return known && known.shared ? [shared, own] : [own, shared];
}

/** GET on the service, falling back to the other host when one is unreachable or unknown. */
async function api(gc, service, path) {
  if (!ID_RE.test(String(service || ''))) throw providerError('PROVIDER_CONFIG');
  let last = null;
  for (const base of bases(service)) {
    try { return await getJson(gc, `${base}/${path}`); } catch (e) {
      last = e;
      if (e.code !== 'PROVIDER_UNREACHABLE' && e.code !== 'PROVIDER_NOT_FOUND') throw e;
    }
  }
  throw last;
}

const num = (v) => (/^\d{1,12}$/.test(String(v)) ? String(v) : null);

module.exports = {
  id: 'regioit',
  title: 'AbfallNavi (regio iT)',
  hosts: ['*.regioit.de'],
  services: SERVICES.map((s) => ({ id: s.id, title: s.title })),
  customService: ID_RE,

  async places(gc, service) {
    return items((await api(gc, service, 'orte')).map((o) => ({ id: o.id, name: o.name })));
  },

  async streets(gc, service, place) {
    if (!num(place)) throw providerError('PROVIDER_CONFIG');
    const list = await api(gc, service, `orte/${num(place)}/strassen`);
    // a street name can appear once per district (e.g. Solingen): name the district then
    const count = new Map();
    for (const s of list) count.set(s.name, (count.get(s.name) || 0) + 1);
    return items(list.map((s) => ({ id: s.id, name: count.get(s.name) > 1 && s.ortsteilName && s.ortsteilName !== 'default' ? `${s.name} (${s.ortsteilName})` : s.name })));
  },

  async houses(gc, service, place, street) {
    if (!num(street)) throw providerError('PROVIDER_CONFIG');
    const s = await api(gc, service, `strassen/${num(street)}`);
    return items(((s && s.hausNrList) || []).map((h) => ({ id: h.id, name: h.nr })));
  },

  /** → [{ date, name, color }] within [from, to] ("YYYY-MM-DD"). */
  async dates(gc, cfg, { from, to }) {
    const target = cfg.house && num(cfg.house.id) ? `hausnummern/${num(cfg.house.id)}` : (cfg.street && num(cfg.street.id) ? `strassen/${num(cfg.street.id)}` : null);
    if (!target) throw providerError('PROVIDER_CONFIG');
    const fr = await api(gc, cfg.service, 'fraktionen');
    const byId = new Map(fr.map((f) => [f.id, f]));
    const qs = fr.map((f) => `fraktion=${encodeURIComponent(f.id)}`).join('&');
    const list = await api(gc, cfg.service, `${target}/termine${qs ? '?' + qs : ''}`);
    if (!Array.isArray(list)) throw providerError('PROVIDER_BAD_RESPONSE');
    const out = [];
    for (const t of list) {
      const date = String(t && t.datum || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
      const f = byId.get(t.bezirk && t.bezirk.fraktionId);
      if (!f) continue;
      out.push({ date, name: String(f.name), color: color(f.farbeRgb) });
    }
    return out;
  },

  _bases: bases,
};
