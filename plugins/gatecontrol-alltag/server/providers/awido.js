'use strict';

// AWIDO (awido.cubefour.de) — the waste app of many districts in Bavaria,
// Hesse, Thuringia and Rhineland-Palatinate. Public JSON per customer:
//   …/Awido.Service.svc/secure/getPlaces/client=<customer>       places
//   …/secure/getGroupedStreets/<place oid>?client=<customer>      streets
//   …/secure/getStreetAddons/<street oid>?client=<customer>       house numbers
//   …/secure/getData/<oid>?fractions=&client=<customer>           fractions + calendar
// Customer list: the customers that answered a live lookup when this plugin
// was built (reference: mampfes/hacs_waste_collection_schedule).

const { getJson, items, color, providerError } = require('./http');

const BASE = 'https://awido.cubefour.de/WebServices/Awido.Service.svc/secure';

const SERVICES = [
  { id: 'rmk', title: 'Abfallwirtschaft Rems-Murr (AWRM)' },
  { id: 'lra-schweinfurt', title: 'Landkreis Schweinfurt' },
  { id: 'gotha', title: 'Landkreis Gotha' },
  { id: 'zaso', title: 'Zweckverband Abfallwirtschaft Saale-Orla' },
  { id: 'unterhaching', title: 'Gemeinde Unterhaching' },
  { id: 'kaufbeuren', title: 'Stadt Kaufbeuren' },
  { id: 'bgl', title: 'Landkreis Berchtesgadener Land' },
  { id: 'pullach', title: 'Pullach im Isartal' },
  { id: 'ffb', title: 'AWB Landkreis Fürstenfeldbruck' },
  { id: 'unterschleissheim', title: 'Stadt Unterschleißheim' },
  { id: 'kreis-tir', title: 'Landkreis Tirschenreuth' },
  { id: 'rosenheim', title: 'Landkreis Rosenheim' },
  { id: 'tuebingen', title: 'Landkreis Tübingen' },
  { id: 'kronach', title: 'Landkreis Kronach' },
  { id: 'kulmbach', title: 'Landkreis Kulmbach' },
  { id: 'lichtenfels', title: 'Landkreis Lichtenfels' },
  { id: 'erding', title: 'Landkreis Erding' },
  { id: 'zv-muc-so', title: 'Zweckverband München-Südost' },
  { id: 'coburg', title: 'Landkreis Coburg' },
  { id: 'ansbach', title: 'Landkreis Ansbach' },
  { id: 'awb-duerkheim', title: 'AWB Landkreis Bad Dürkheim' },
  { id: 'aic-fdb', title: 'Landratsamt Aichach-Friedberg' },
  { id: 'wgv', title: 'WGV Recycling GmbH' },
  { id: 'neustadt', title: 'Neustadt a.d. Waldnaab' },
  { id: 'kelheim', title: 'Landkreis Kelheim' },
  { id: 'kaw-guenzburg', title: 'Landkreis Günzburg' },
  { id: 'memmingen', title: 'Stadt Memmingen' },
  { id: 'eww-suew', title: 'Landkreis Südliche Weinstraße' },
  { id: 'lra-dah', title: 'Landratsamt Dachau' },
  { id: 'landkreisbetriebe', title: 'Landkreisbetriebe Neuburg-Schrobenhausen' },
  { id: 'awb-ak', title: 'Abfallwirtschaftsbetrieb Landkreis Altenkirchen' },
  { id: 'awld', title: 'Abfallwirtschaft Lahn-Dill-Kreises' },
  { id: 'azv-hef-rof', title: 'Abfallwirtschafts-Zweckverband des Landkreises Hersfeld-Rotenburg' },
  { id: 'awv-nordschwaben', title: 'Abfall-Wirtschafts-Verband Nordschwaben' },
  { id: 'regensburg', title: 'Stadt Regensburg' },
  { id: 'awv-isar-inn', title: 'Abfallwirtschaft Isar-Inn' },
  { id: 'fulda', title: 'Landkreis Fulda' },
  { id: 'fulda-stadt', title: 'Stadt Fulda' },
  { id: 'lra-ab', title: 'Landkreis Aschaffenburg' },
  { id: 'lra-mue', title: 'Landkreis Mühldorf a. Inn' },
  { id: 'roth', title: 'Landkreis Roth' },
  { id: 'lra-regensburg', title: 'Landratsamt Regensburg' },
  { id: 'lkgi', title: 'Landkreis Gießen' },
  { id: 'gifhorn', title: 'Landkreis Gifhorn' },
  { id: 'koenigstein', title: 'Stadt Königstein im Taunus' },
  { id: 'ebu', title: 'EBU Ulm' },
  { id: 'ebe', title: 'Landkreis Ebersberg' },
  { id: 'awb-altenburg', title: 'Abfallwirtschaft Altenburger Land' },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const OID_RE = /^[0-9a-fA-F-]{36}$/;

function client(service) {
  if (!ID_RE.test(String(service || ''))) throw providerError('PROVIDER_CONFIG');
  return encodeURIComponent(service);
}
const oid = (v) => (OID_RE.test(String(v)) ? String(v) : null);
const kv = (list) => (Array.isArray(list) ? list : []).map((x) => ({ id: x && x.key, name: x && x.value }));

module.exports = {
  id: 'awido',
  title: 'AWIDO',
  hosts: ['awido.cubefour.de'],
  services: SERVICES.map((s) => ({ id: s.id, title: s.title })),
  customService: ID_RE,

  async places(gc, service) {
    return items(kv(await getJson(gc, `${BASE}/getPlaces/client=${client(service)}`)));
  },

  async streets(gc, service, place) {
    if (!oid(place)) throw providerError('PROVIDER_CONFIG');
    return items(kv(await getJson(gc, `${BASE}/getGroupedStreets/${oid(place)}?client=${client(service)}`)));
  },

  async houses(gc, service, place, street) {
    if (!oid(street)) throw providerError('PROVIDER_CONFIG');
    const list = items(kv(await getJson(gc, `${BASE}/getStreetAddons/${oid(street)}?client=${client(service)}`)));
    // a single entry without a number (the street itself): nothing to choose
    return list.length > 1 || (list.length === 1 && list[0].id !== String(street)) ? list : [];
  },

  async dates(gc, cfg, { from, to }) {
    const target = (cfg.house && oid(cfg.house.id)) || (cfg.street && oid(cfg.street.id));
    if (!target) throw providerError('PROVIDER_CONFIG');
    const d = await getJson(gc, `${BASE}/getData/${target}?fractions=&client=${client(cfg.service)}`, { timeoutMs: 20000 });
    if (!d || !Array.isArray(d.calendar) || !Array.isArray(d.fracts)) throw providerError('PROVIDER_BAD_RESPONSE');
    const fr = new Map(d.fracts.map((f) => [f.snm, f]));
    const out = [];
    for (const c of d.calendar) {
      if (!c || !Array.isArray(c.fr)) continue; // public holidays have no fractions
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(c.dt || ''));
      if (!m) continue;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      if (date < from || date > to) continue;
      for (const snm of c.fr) {
        const f = fr.get(snm);
        if (f && f.nm) out.push({ date, name: String(f.nm), color: color(f.bg) });
      }
    }
    return out;
  },
};
