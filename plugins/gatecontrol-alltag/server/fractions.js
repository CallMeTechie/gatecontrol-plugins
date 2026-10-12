'use strict';

// Waste fractions: every name a provider, an ICS file or a rule brings
// ("Restabfall 2wö", "Gelbe Tonne", "Schadstoffmobil Altendorf") is mapped
// by keywords to a known type with a colour and an icon. The administrator
// can rename, recolour, retype or hide a fraction per plan (store.fractions).

const TYPES = ['rest', 'bio', 'paper', 'yellow', 'glass', 'bulky', 'hazardous', 'green', 'other'];

const COLORS = {
  rest: '#6b7280',
  bio: '#8b5a2b',
  paper: '#2563eb',
  yellow: '#eab308',
  glass: '#0d9488',
  bulky: '#9333ea',
  hazardous: '#dc2626',
  green: '#16a34a',
  other: '#64748b',
};

// SVG path data (24×24, stroke) per type — static, never data
const ICONS = {
  rest: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  bio: 'M12 21c-4-2-7-6-7-11 5 0 8 3 7 11zM12 21c4-2 7-6 7-11-5 0-8 3-7 11z',
  paper: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  yellow: 'M7 8l1-4h8l1 4M5 8h14l-1 12H6zM10 12v4M14 12v4',
  glass: 'M9 2h6M10 2v5l-3 4v10h10V11l-3-4V2',
  bulky: 'M3 11h18v6H3zM5 17v3M19 17v3M6 11V7h12v4',
  hazardous: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  green: 'M12 2l7 10h-4l5 7H4l5-7H5zM12 19v3',
  other: 'M4 7h16l-1 13H5zM9 7V4h6v3',
};

// Order matters: the first type with a matching keyword wins
// ("Schadstoffmobil" before anything else, "Weihnachtsbäume" before "Bio" …).
const KEYWORDS = [
  ['hazardous', ['schadstoff', 'problemabfall', 'problemstoff', 'sondermull', 'sonderabfall', 'giftmobil', 'umweltmobil', 'hazard']],
  ['green', ['weihnachtsbaum', 'weihnachtsbaume', 'christbaum', 'tannenbaum', 'grunschnitt', 'grungut', 'grunabfall', 'gartenabfall', 'baumschnitt', 'strauchschnitt', 'astschnitt', 'laub', 'schnittgut', 'garden', 'christmas tree']],
  ['glass', ['glas', 'glass']],
  ['bulky', ['sperr', 'bulky']],
  ['yellow', ['gelb', 'wertstoff', 'leichtverpack', 'verpackung', 'lvp', 'packaging', 'yellow']],
  ['paper', ['papier', 'pappe', 'karton', 'blaue tonne', 'blau', 'ppk', 'paper']],
  ['bio', ['bio', 'braune tonne', 'braun', 'kompost', 'organic', 'food waste']],
  ['rest', ['rest', 'grau', 'hausmull', 'schwarze tonne', 'residual', 'general waste']],
];

/** Lower case, umlauts folded, whitespace collapsed — the key a name is stored under. */
function normalize(name) {
  return String(name == null ? '' : name).toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/** Display name → type. */
function classify(name) {
  const n = normalize(name);
  if (!n) return 'other';
  for (const [type, words] of KEYWORDS) if (words.some((w) => n.includes(w))) return type;
  return 'other';
}

/** "#RRGGBB" or null. */
function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
}

/** The fraction as shown (admin overrides applied). */
function present(f) {
  const type = TYPES.includes(f.type) ? f.type : 'other';
  return { id: f.id, name: f.name || f.source_name, type, color: validColor(f.color) || COLORS[type], hidden: !!f.hidden };
}

module.exports = { TYPES, COLORS, ICONS, KEYWORDS, normalize, classify, validColor, present };
