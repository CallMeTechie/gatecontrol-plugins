'use strict';

// abfall.io / AbfallPlus (v3) — the waste-calendar backend of many German
// districts. Two steps:
//   GET  https://api.abfall.io/?key=<service key>     → { apiKey, settings.PUB_ABFALLTYPEN }
//   POST https://widgets.abfall.io/graphql             (x-abfallplus-api-key: apiKey)
//        cities · city(id){ idHouseNumber streets } · street(id){ idHouseNumber houseNumbers }
//        appointments(idHouseNumber, wasteTypes, dateMin, dateMax){ date wasteType{ name color } }
// The service key is public (it is in every municipality's widget). Some
// services want the Origin/Referer of their own website. Service list: the
// v3 services that answered a live lookup when this plugin was built
// (reference: mampfes/hacs_waste_collection_schedule); other keys can be
// entered.

const { getJson, items, color, providerError } = require('./http');

const SERVICES = [
  { id: 'efb75cbd1f08fae1d4e47ae72a85c655', title: 'Landkreis Märkisch-Oderland', origin: 'https://www.maerkisch-oderland.de' },
  { id: '1c230a689579b6d3ddb9ceb5a56c6072', title: 'Holding Graz (AT)', origin: 'https://www.holding-graz.at' },
  { id: '15f69fab91c4cae50d9dbb5bcfd383f0', title: 'Landkreis Reutlingen', origin: 'https://www.kreis-reutlingen.de' },
  { id: '51be67f3758f1fb57b420efe065c0663', title: 'Entsorgungsbetriebe Essen', origin: 'https://www.ebe-essen.de' },
  { id: '0d7a92192ba3ae914c028ac37d73e222', title: 'KELL Kommunalentsorgung Landkreis Leipzig GmbH', origin: 'https://kell-gmbh.de' },
  { id: '80acad6c77fe9342ebafad29a8c58bf6', title: 'Wirtschaftsbetriebe Duisburg (WBD)', origin: 'https://www.wb-duisburg.de' },
  { id: '4b5702d771c82b611c386ebbc7629026', title: 'Landkreis Göttingen', origin: 'https://www.landkreisgoettingen.de' },
  { id: '76bdaac8568082d77e7a90cb41129f9b', title: 'Abfallwirtschaft Landkreis Böblingen', origin: 'https://www.awb-bb.de' },
  { id: '2085afd95285e645e15ee9623d0c5172', title: 'ASG Nordsachsen', origin: 'https://www.asg-nordsachsen.de' },
  { id: '30628292bdd8b43db86a48f7e0d85f85', title: 'Amt für Abfallwirtschaft Schwarzwald-Baar-Kreis', origin: 'https://www.lrasbk.de' },
  { id: '8b016df0116d1d5094fa339bebea0c65', title: 'ASO Abfall-Service Osterholz', origin: 'https://www.aso-ohz.de' },
  { id: '0813ea99f520c462373386564a99a51e', title: 'AWG Abfallwirtschaft Landkreis Calw', origin: 'https://www.awg-info.de' },
];

const KEY_RE = /^[0-9a-f]{32}$/;
const GQL = 'https://widgets.abfall.io/graphql';

async function init(gc, service) {
  if (!KEY_RE.test(String(service || ''))) throw providerError('PROVIDER_CONFIG');
  const cfg = await getJson(gc, `https://api.abfall.io/?key=${service}`);
  if (!cfg || typeof cfg.apiKey !== 'string' || !cfg.apiKey) throw providerError('PROVIDER_BAD_RESPONSE');
  const types = ((cfg.settings && cfg.settings.PUB_ABFALLTYPEN) || []).filter((t) => t && t.checked).map((t) => String(t.wasteType));
  return { apiKey: cfg.apiKey, types };
}

async function gql(gc, service, session, query, variables) {
  const known = SERVICES.find((s) => s.id === service);
  const headers = { 'x-abfallplus-api-key': session.apiKey };
  if (known && known.origin) { headers.origin = known.origin; headers.referer = known.origin + '/'; }
  const r = await getJson(gc, GQL, { method: 'POST', headers, json: { query, variables: variables || {} } });
  if (!r || r.errors || !r.data) throw providerError('PROVIDER_BAD_RESPONSE');
  return r.data;
}

const id = (v) => (/^\d{1,12}$/.test(String(v)) ? String(v) : null);

/** The house-number id the appointments need (street or city level when there are no house numbers). */
async function houseId(gc, cfg, session) {
  if (cfg.house && id(cfg.house.id)) return id(cfg.house.id);
  if (cfg.street && id(cfg.street.id)) {
    const d = await gql(gc, cfg.service, session, 'query($id:ID!){street(id:$id){idHouseNumber houseNumbers{id name}}}', { id: id(cfg.street.id) });
    const s = d.street || {};
    if (s.idHouseNumber) return String(s.idHouseNumber);
    if (Array.isArray(s.houseNumbers) && s.houseNumbers.length === 1) return String(s.houseNumbers[0].id);
    throw providerError('PROVIDER_CONFIG');
  }
  if (cfg.place && id(cfg.place.id)) {
    const d = await gql(gc, cfg.service, session, 'query($id:ID!){city(id:$id){idHouseNumber}}', { id: id(cfg.place.id) });
    if (d.city && d.city.idHouseNumber) return String(d.city.idHouseNumber);
  }
  throw providerError('PROVIDER_CONFIG');
}

module.exports = {
  id: 'abfallio',
  title: 'abfall.io / AbfallPlus',
  hosts: ['api.abfall.io', 'widgets.abfall.io'],
  services: SERVICES.map((s) => ({ id: s.id, title: s.title })),
  customService: KEY_RE,

  async places(gc, service) {
    const s = await init(gc, service);
    return items((await gql(gc, service, s, '{cities{id name}}')).cities);
  },

  async streets(gc, service, place) {
    if (!id(place)) throw providerError('PROVIDER_CONFIG');
    const s = await init(gc, service);
    const c = (await gql(gc, service, s, 'query($id:ID!){city(id:$id){idHouseNumber streets{id name}}}', { id: id(place) })).city || {};
    return items(c.streets);
  },

  async houses(gc, service, place, street) {
    if (!id(street)) throw providerError('PROVIDER_CONFIG');
    const s = await init(gc, service);
    const st = (await gql(gc, service, s, 'query($id:ID!){street(id:$id){idHouseNumber houseNumbers{id name}}}', { id: id(street) })).street || {};
    const list = items(st.houseNumbers);
    // one entry ("Alle Hausnummern") or a street-level id: nothing to choose
    return list.length > 1 ? list : [];
  },

  async dates(gc, cfg, { from, to }) {
    const s = await init(gc, cfg.service);
    const idHouseNumber = await houseId(gc, cfg, s);
    const d = await gql(gc, cfg.service, s,
      'query($id:ID!,$types:[ID],$min:Date,$max:Date){appointments(idHouseNumber:$id,wasteTypes:$types,dateMin:$min,dateMax:$max,showInactive:false){date wasteType{name color}}}',
      { id: idHouseNumber, types: s.types.length ? s.types : null, min: from, max: to });
    if (!Array.isArray(d.appointments)) throw providerError('PROVIDER_BAD_RESPONSE');
    const out = [];
    for (const a of d.appointments) {
      const date = String(a && a.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to || !a.wasteType || !a.wasteType.name) continue;
      out.push({ date, name: String(a.wasteType.name), color: color(a.wasteType.color) });
    }
    return out;
  },
};
