'use strict';

// 1.5.0: the place a line of the quick entry names — a fixed table and a few rules, no AI, and nothing of it in the
// parser (ui/quickparse.js and its vectors stay as they are: the apps carry copies of them). The server finds the
// place in what the parser left as the title; POST parse answers it as `place` beside `parsed`.
//
//   an own place   „bei Oma“, „im Büro“, „zu Hause“      the names of „Meine Orte“ and of the family's places
//   a kind         „beim Baumarkt“, „an der Apotheke“, „Tankstelle“   KINDS below
//   an address     „Ringstraße 21“
//   a name         „bei Lidl“ — whatever stands after bei / beim / im / in der / an der / am / zu and is no known word
//
// KINDS: id → the words people write (German and English, lower case), the label shown, the search phrase and the map
// tags a hit must carry. The phrases are „special phrases“ of Nominatim, each one tried against the public service
// (README "Place search"); the tags keep out what merely has the word in its name.

const KINDS = {
  supermarket: { de: 'Supermarkt', en: 'Supermarket', words: ['supermarkt', 'lebensmittelladen', 'lebensmittelgeschäft', 'discounter', 'supermarket', 'grocery store', 'grocery'], phrase: 'Supermarkt', tags: ['shop=supermarket'] },
  bakery: { de: 'Bäcker', en: 'Bakery', words: ['bäcker', 'bäckerei', 'baecker', 'baeckerei', 'bakery', 'baker'], phrase: 'Bäckerei', tags: ['shop=bakery'] },
  butcher: { de: 'Metzger', en: 'Butcher', words: ['metzger', 'metzgerei', 'fleischer', 'fleischerei', 'schlachter', 'butcher'], phrase: 'Metzgerei', tags: ['shop=butcher'] },
  pharmacy: { de: 'Apotheke', en: 'Pharmacy', words: ['apotheke', 'pharmacy'], phrase: 'Apotheke', tags: ['amenity=pharmacy'] },
  drugstore: { de: 'Drogerie', en: 'Drugstore', words: ['drogerie', 'drogeriemarkt', 'drugstore'], phrase: 'Drogerie', tags: ['shop=chemist'] },
  fuel: { de: 'Tankstelle', en: 'Petrol station', words: ['tankstelle', 'tanke', 'petrol station', 'gas station', 'filling station'], phrase: 'Tankstelle', tags: ['amenity=fuel'] },
  diy: { de: 'Baumarkt', en: 'DIY store', words: ['baumarkt', 'hardware store', 'diy store', 'home improvement store'], phrase: 'Baumarkt', tags: ['shop=doityourself'] },
  post: { de: 'Post', en: 'Post office', words: ['post', 'postamt', 'postfiliale', 'post office'], phrase: 'Postamt', tags: ['amenity=post_office'] },
  parcel: { de: 'Packstation', en: 'Parcel locker', words: ['packstation', 'paketstation', 'parcel locker'], phrase: 'Packstation', tags: ['amenity=parcel_locker'] },
  bank: { de: 'Bank', en: 'Bank', words: ['bank', 'bankfiliale'], phrase: 'Banks', tags: ['amenity=bank'] },
  atm: { de: 'Geldautomat', en: 'ATM', words: ['geldautomat', 'bankautomat', 'atm', 'cash machine'], phrase: 'Geldautomat', tags: ['amenity=atm'] },
  doctor: { de: 'Arzt', en: 'Doctor', words: ['arzt', 'ärztin', 'hausarzt', 'hausärztin', 'arztpraxis', 'doctor', 'doctors'], phrase: 'Arzt', tags: ['amenity=doctors'] },
  dentist: { de: 'Zahnarzt', en: 'Dentist', words: ['zahnarzt', 'zahnärztin', 'dentist'], phrase: 'Zahnarzt', tags: ['amenity=dentist'] },
  hospital: { de: 'Krankenhaus', en: 'Hospital', words: ['krankenhaus', 'klinik', 'hospital'], phrase: 'Krankenhaus', tags: ['amenity=hospital'] },
  vet: { de: 'Tierarzt', en: 'Vet', words: ['tierarzt', 'tierärztin', 'vet', 'veterinary'], phrase: 'Tierarzt', tags: ['amenity=veterinary'] },
  library: { de: 'Bibliothek', en: 'Library', words: ['bibliothek', 'bücherei', 'buecherei', 'library'], phrase: 'Bibliothek', tags: ['amenity=library'] },
  books: { de: 'Buchhandlung', en: 'Bookshop', words: ['buchhandlung', 'buchladen', 'bookshop', 'bookstore'], phrase: 'Buchhandlung', tags: ['shop=books'] },
  florist: { de: 'Blumenladen', en: 'Florist', words: ['blumenladen', 'blumengeschäft', 'florist', 'flower shop'], phrase: 'Blumenladen', tags: ['shop=florist'] },
  hairdresser: { de: 'Friseur', en: 'Hairdresser', words: ['friseur', 'frisör', 'friseurin', 'hairdresser', 'barber'], phrase: 'Friseur', tags: ['shop=hairdresser'] },
  cleaning: { de: 'Reinigung', en: 'Dry cleaner', words: ['reinigung', 'dry cleaner', 'dry cleaning'], phrase: 'Reinigung', tags: ['shop=dry_cleaning'] },
  carwash: { de: 'Waschanlage', en: 'Car wash', words: ['waschanlage', 'autowaschanlage', 'waschstraße', 'car wash'], phrase: 'Autowaschanlage', tags: ['amenity=car_wash'] },
  garage: { de: 'Werkstatt', en: 'Car repair', words: ['werkstatt', 'autowerkstatt', 'car repair'], phrase: 'Autowerkstatt', tags: ['shop=car_repair'] },
  recycling: { de: 'Wertstoffhof', en: 'Recycling centre', words: ['wertstoffhof', 'recyclinghof', 'recycling centre', 'recycling center'], phrase: 'Recyclinghof', tags: ['amenity=recycling'] },
  garden: { de: 'Gartencenter', en: 'Garden centre', words: ['gartencenter', 'gartenmarkt', 'gärtnerei', 'garden centre', 'garden center'], phrase: 'Garden Centre', tags: ['shop=garden_centre'] },
  pet: { de: 'Zoohandlung', en: 'Pet shop', words: ['zoohandlung', 'tierhandlung', 'zoofachmarkt', 'pet shop', 'pet store'], phrase: 'Tierhandlung', tags: ['shop=pet'] },
  beverages: { de: 'Getränkemarkt', en: 'Beverage shop', words: ['getränkemarkt', 'getraenkemarkt', 'beverage shop'], phrase: 'Getränkemarkt', tags: ['shop=beverages'] },
  kiosk: { de: 'Kiosk', en: 'Kiosk', words: ['kiosk', 'späti', 'convenience store'], phrase: 'Kiosk', tags: ['shop=kiosk', 'shop=convenience'] },
  optician: { de: 'Optiker', en: 'Optician', words: ['optiker', 'optician'], phrase: 'Optiker', tags: ['shop=optician'] },
  furniture: { de: 'Möbelhaus', en: 'Furniture store', words: ['möbelhaus', 'möbelgeschäft', 'furniture store'], phrase: 'Möbelgeschäft', tags: ['shop=furniture'] },
  electronics: { de: 'Elektromarkt', en: 'Electronics store', words: ['elektromarkt', 'elektronikmarkt', 'elektronikgeschäft', 'electronics store'], phrase: 'Elektronikgeschäft', tags: ['shop=electronics'] },
  bicycle: { de: 'Fahrradladen', en: 'Bike shop', words: ['fahrradladen', 'fahrradgeschäft', 'bike shop', 'bicycle shop'], phrase: 'Fahrradladen', tags: ['shop=bicycle'] },
  school: { de: 'Schule', en: 'School', words: ['schule', 'school'], phrase: 'Schule', tags: ['amenity=school'] },
  kindergarten: { de: 'Kindergarten', en: 'Kindergarten', words: ['kindergarten', 'kita', 'nursery'], phrase: 'Kindergarten', tags: ['amenity=kindergarten'] },
  station: { de: 'Bahnhof', en: 'Railway station', words: ['bahnhof', 'railway station', 'train station'], phrase: 'Bahnhof', tags: ['railway=station'] },
  townhall: { de: 'Rathaus', en: 'Town hall', words: ['rathaus', 'bürgeramt', 'town hall'], phrase: 'Rathaus', tags: ['amenity=townhall'] },
  restaurant: { de: 'Restaurant', en: 'Restaurant', words: ['restaurant'], phrase: 'Restaurant', tags: ['amenity=restaurant'] },
  cafe: { de: 'Café', en: 'Café', words: ['café', 'cafe'], phrase: 'Café', tags: ['amenity=cafe'] },
  gym: { de: 'Fitnessstudio', en: 'Gym', words: ['fitnessstudio', 'fitnesscenter', 'gym'], phrase: 'Fitnesscenter', tags: ['leisure=fitness_centre'] },
  playground: { de: 'Spielplatz', en: 'Playground', words: ['spielplatz', 'playground'], phrase: 'Spielplatz', tags: ['leisure=playground'] },
};

const KEY_RE = /^(?:kind:[a-z]{2,20}|name:[^\u0000-\u001f\u007f]{2,40})$/;
const HOME_WORDS = ['zu hause', 'zuhause', 'daheim', 'at home'];
// what stands before a place — the stronger ones (a place is meant) first
const PREP_SURE = ['bei der', 'bei dem', 'beim', 'bei', 'at the', 'at'];
const PREP_WEAK = ['in der', 'in dem', 'in den', 'im', 'an der', 'an dem', 'am', 'zu dem', 'zu der', 'zum', 'zur', 'zu', 'auf dem', 'auf der', 'vor dem', 'vor der', 'near the', 'near', 'in the', 'to the'];
const ARTICLE = '(?:(?:der|dem|den|die|das|einem|einer|meinem|meiner|unserem|unserer|the|my|our)\\s+)?';
// words after „bei“ / „im“ / „am“ / „zu“ that are no place
const STOP = new Set(['mir', 'dir', 'uns', 'euch', 'ihm', 'ihr', 'ihnen', 'ihn', 'sich', 'allen', 'allem', 'jedem', 'gelegenheit', 'bedarf', 'regen', 'schnee', 'sonne',
  'zeit', 'zeiten', 'anruf', 'ankunft', 'abfahrt', 'weitem', 'erledigen', 'besten', 'ende', 'anfang', 'voraus', 'moment', 'laufe', 'rahmen', 'internet', 'netz',
  'kopf', 'auge', 'blick', 'griff', 'wochenende', 'abend', 'morgen', 'mittag', 'nachmittag', 'vormittag', 'nacht', 'tag', 'woche', 'monat', 'jahr', 'urlaub', 'ferien',
  'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonnabend', 'sonntag', 'januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august',
  'september', 'oktober', 'november', 'dezember', 'frühling', 'sommer', 'herbst', 'winter', 'me', 'you', 'us', 'them', 'all', 'once', 'least', 'last', 'first', 'time',
  'hause', 'hand', 'telefon', 'handy', 'computer', 'rechner', 'auto', 'fahrrad', 'haus', 'garten', 'keller', 'bad', 'flur', 'zimmer', 'küche', 'wohnzimmer', 'schlafzimmer']);
const STREET = '(?:stra(?:ß|ss)e|str\\.|weg|platz|allee|gasse|ring|damm|ufer|chaussee|steig|pfad|street|road|avenue|lane|drive)';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lower = (s) => String(s || '').normalize('NFC').toLowerCase();
const alt = (list) => list.slice().sort((a, b) => b.length - a.length).map((w) => esc(w).replace(/ /g, '\\s+')).join('|');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const PREPS = `(?:(${alt([...PREP_SURE, ...PREP_WEAK])})\\s+)`;
const SURE = new Set(PREP_SURE);

const WORD_KIND = new Map();
for (const [id, k] of Object.entries(KINDS)) for (const w of k.words) WORD_KIND.set(w, id);
const KIND_RE = new RegExp(`${B}${PREPS}?${ARTICLE}(${alt([...WORD_KIND.keys()])})${E}`, 'giu');
const ADDRESS_RE = new RegExp(`${B}${PREPS}?${ARTICLE}((?:[\\p{L}.\\-]+\\s+(?=${STREET}\\s))?[\\p{L}.\\-]*${STREET}\\s+\\d{1,4}(?:\\s?[a-z])?)${E}`, 'giu');
const NAME_RE = new RegExp(`${B}${PREPS}${ARTICLE}([\\p{L}\\p{N}][\\p{L}\\p{N}&'’.\\-]{1,39})`, 'giu');

const kindOf = (key) => (typeof key === 'string' && key.startsWith('kind:') && Object.prototype.hasOwnProperty.call(KINDS, key.slice(5)) ? KINDS[key.slice(5)] : null);
const validKey = (key) => typeof key === 'string' && KEY_RE.test(key) && (!key.startsWith('kind:') || !!kindOf(key));
const nameKey = (word) => 'name:' + lower(word).replace(/\s+/g, ' ').trim().slice(0, 40);
const cap = (s) => (s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The label of a key in a language: „Baumarkt“ for kind:diy; for a name the name itself as it was written (`as`). */
function labelOf(key, lang, as) {
  const k = kindOf(key);
  if (k) return lang === 'en' ? k.en : k.de;
  return cap(String(as || (typeof key === 'string' ? key.slice(5) : '') || '')).slice(0, 40);
}

/** The title without the phrase at [start, end) — only when at least two words stay („bei Lidl einkaufen“ stays). */
function without(title, start, end) {
  const rest = (title.slice(0, start) + ' ' + title.slice(end)).replace(/\s+/g, ' ').replace(/\s+([,;:.!?])/g, '$1').replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '').trim();
  return rest.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 2 ? rest : title;
}

/**
 * The place a title names → { via: 'own' | 'family' | 'kind' | 'address' | 'name', word (as written, with its
 * preposition), query, key, label, title (without the phrase), certain (a place is surely meant: an own place, or a
 * word after bei / beim), ownId?, familyId? } | null.
 * known = { own: [{ id, name }], family: [{ id, name }] } — the person's named places and the family's.
 */
function detect(title, lang, known = {}) {
  const s = String(title || '').normalize('NFC');
  if (!s.trim() || s.length > 400) return null;
  const hit = (m, word, extra) => ({ word: m[0].trim(), title: without(s, m.index, m.index + m[0].length), ...extra });
  // 1. the person's own places and the family's, the longest name first; „zu Hause“ is the place called so, else the family's home
  const names = [];
  for (const p of known.own || []) if (p && typeof p.name === 'string' && p.name.trim().length >= 2) names.push({ name: p.name.trim(), via: 'own', id: p.id });
  for (const p of known.family || []) if (p && typeof p.name === 'string' && p.name.trim().length >= 2) names.push({ name: p.name.trim(), via: 'family', id: p.id });
  const home = names.find((n) => HOME_WORDS.includes(lower(n.name))) || names.find((n) => n.via === 'family' && n.id === 'home');
  if (home) for (const w of HOME_WORDS) if (lower(home.name) !== w) names.push({ ...home, alias: w, name: w });
  names.sort((a, b) => b.name.length - a.name.length);
  for (const n of names) {
    // „zu Hause“ carries its own preposition
    const re = new RegExp(`${B}${n.alias ? '' : PREPS + '?' + ARTICLE}(${esc(n.name).replace(/\s+/g, '\\s+')})${E}`, 'iu');
    const m = re.exec(s);
    if (!m) continue;
    const label = n.alias ? (names.find((x) => x.id === n.id && x.via === n.via && !x.alias) || n).name : n.name;
    return hit(m, null, { via: n.via, query: label, key: null, label, certain: true, ...(n.via === 'own' ? { ownId: n.id } : { familyId: n.id }) });
  }
  // 2. a kind of place — the first one written
  KIND_RE.lastIndex = 0;
  const k = KIND_RE.exec(s);
  // 3. an address („Ringstraße 21“)
  ADDRESS_RE.lastIndex = 0;
  const a = ADDRESS_RE.exec(s);
  if (a && (!k || a.index <= k.index)) {
    const q = a[2].replace(/\s+/g, ' ').trim();
    return hit(a, null, { via: 'address', query: q, key: null, label: q, certain: true });
  }
  if (k) {
    const id = WORD_KIND.get(lower(k[2]).replace(/\s+/g, ' '));
    const key = 'kind:' + id;
    return hit(k, null, { via: 'kind', query: labelOf(key, lang), key, label: labelOf(key, lang), certain: !!k[1] });
  }
  // 4. a name: the word after a preposition — after bei / beim any word, after the weaker ones only a capital one
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(s))) {
    const prep = lower(m[1]).replace(/\s+/g, ' ');
    const word = m[2].replace(/[.\-’']+$/, '');
    const sure = SURE.has(prep);
    if (word.length < 2 || STOP.has(lower(word)) || /^\d+$/.test(word) || (!sure && !/^\p{Lu}/u.test(word))) { NAME_RE.lastIndex = m.index + m[1].length; continue; }
    const end = m.index + m[0].length - (m[2].length - word.length);
    return { via: 'name', word: s.slice(m.index, end).trim(), query: cap(word), key: nameKey(word), label: cap(word), title: without(s, m.index, end), certain: sure };
  }
  return null;
}

module.exports = { KINDS, kindOf, validKey, nameKey, labelOf, detect, without, lower };
