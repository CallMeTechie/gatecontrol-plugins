'use strict';

// 1.4.0 — GET messages/:id/suggest: a small German rule-based parser (no external service) that finds
//   items  — things to buy or bring: bullet lines, and comma / "und" lists next to kaufen, besorgen,
//            mitbringen (also "bring … mit"), mitnehmen, holen, brauchen, Einkaufsliste:
//   dates  — heute, morgen, übermorgen, weekdays ("am Samstag", "nächsten Montag"), 18.10., 18.10.2026,
//            "18. Oktober", times "um 15 Uhr", "15:30", "15.30 Uhr", "halb 4" (relative to when the message was sent,
//            in the server's time zone)
// → { items: [string], dates: [{ startsAt, label, title, allDay }] }. English texts give fewer hits.

const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
const MONTHS_SHORT = ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'];
const SHORT_DAY = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

const VERB = '(?:kaufen|kauf|kaufst|besorgen|besorg|besorgst|mitbringen|mitnehmen|holen|hol|brauchen|brauche|braucht|einkaufen|buy|get|bring)';
const FILLER = new Set(['bitte', 'noch', 'auch', 'mal', 'du', 'kannst', 'könntest', 'kann', 'wir', 'ihr', 'ich', 'uns', 'mir', 'dir', 'für', 'heute', 'morgen', 'gleich',
  'dann', 'eben', 'schnell', 'vielleicht', 'doch', 'ja', 'also', 'und', 'oder', 'sowie', 'zum', 'zur', 'vom', 'beim', 'im', 'am', 'aus', 'dem', 'vorbei', 'wieder', 'evtl', 'evtl.',
  'please', 'some', 'also', 'and', 'could', 'you', 'we', 'need']);
const ARTICLES = new Set(['ein', 'eine', 'einen', 'einer', 'eines', 'etwas', 'paar', 'die', 'der', 'das', 'den', 'des', 'neue', 'neuen', 'frische', 'frischen', 'a', 'an', 'the']);
const ITEM_MAX = 40;
const ITEMS_MAX = 30;

/** Sentences: split at ! ? and at a full stop that does not end a number ("23.10. um", "5. November"). */
function sentencesOf(text) {
  return String(text || '').replace(/\n+/g, '\n').split(/\n|(?<=[!?])\s+|(?<=[^\d\s][.])\s+(?=[A-ZÄÖÜ])/);
}

function clean(s) { return String(s || '').replace(/[​­]/g, '').replace(/\s+/g, ' ').trim(); }

/** One list entry: fillers and articles at the start removed, punctuation trimmed → string or null. */
function tidy(raw) {
  let words = clean(raw).replace(/^[-–•*·]+\s*/, '').replace(/[.!?;:"„“”()]+$/g, '').replace(/^[„“"(]+/, '').split(' ').filter(Boolean);
  while (words.length && (FILLER.has(words[0].toLowerCase()) || ARTICLES.has(words[0].toLowerCase()))) words.shift();
  while (words.length && FILLER.has(words[words.length - 1].toLowerCase().replace(/[.,!?]$/, ''))) words.pop();
  const s = words.join(' ').replace(/[,.!?]+$/, '').trim();
  if (!s || s.length > ITEM_MAX || words.length > 5) return null;
  if (!/[A-Za-zÄÖÜäöüß]/.test(s)) return null;
  if (new RegExp('^' + VERB + '$', 'i').test(s)) return null;
  return s;
}

function splitList(phrase) {
  return phrase.split(/\s*(?:,|;|\s+und\s+|\s+sowie\s+|\s+&\s+|\s+and\s+|\s+oder\s+)\s*/i).map(tidy).filter(Boolean);
}

function items(text) {
  const out = [];
  const add = (x) => { if (x && !out.some((y) => y.toLowerCase() === x.toLowerCase()) && out.length < ITEMS_MAX) out.push(x); };
  const lines = String(text || '').split(/\n/);
  // bullet lists
  for (const l of lines) {
    const m = /^\s*(?:[-–•*·]|\d{1,2}[.)])\s+(.+)$/.exec(l);
    if (m) splitList(m[1]).forEach(add);
  }
  // "Einkaufsliste: a, b, c" / "Einkauf: …"
  for (const l of lines) {
    const m = /(?:einkaufsliste|einkauf|shopping list|liste)\s*:\s*(.+)$/i.exec(l);
    if (m) splitList(m[1]).forEach(add);
  }
  const sentences = sentencesOf(text);
  for (const sRaw of sentences) {
    const s = clean(sRaw);
    if (!s) continue;
    // "bring … mit" (separable verb): the part in between
    let m = /\bbring(?:e|st|t)?\b\s+(.+?)\s+mit\b/i.exec(s);
    if (m) { splitList(m[1]).forEach(add); continue; }
    // verb first: "kauf bitte Milch und Eier", "wir brauchen noch Butter, Mehl"
    m = new RegExp('\\b' + VERB + '\\b\\s+(.+)$', 'i').exec(s);
    if (m && !new RegExp('\\b' + VERB + '[.!?]?$', 'i').test(s)) { splitList(m[1].replace(/[.!?]+$/, '')).forEach(add); continue; }
    // verb last: "Kannst du Milch, Eier und Brot kaufen?"
    m = new RegExp('^(.+?)\\s+' + VERB + '[.!?]*$', 'i').exec(s);
    if (m) {
      let phrase = m[1];
      // drop the start of the sentence up to the subject ("Kannst du", "Könntest du bitte")
      phrase = phrase.replace(/^(?:kannst|könntest|kann|könnte|würdest|magst|willst|sollen|soll|could|can)\s+(?:du|ihr|wer|jemand|you|someone)\s+/i, '');
      phrase = phrase.replace(/^(?:wir|ich|ihr|du)\s+(?:müssen|muss|müsst|sollten|sollen|wollen)\s+(?:noch\s+)?/i, '');
      splitList(phrase).forEach(add);
    }
  }
  return out;
}

// ─── dates ─────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function label(d, allDay) {
  const s = `${SHORT_DAY[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  return allDay ? s : `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The first time of day in the text → { h, m } or null. */
function timeOf(s) {
  let m = /\b(?:um|ab|gegen|at)?\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:uhr|h)?\b/i.exec(s);
  if (m) return { h: Number(m[1]), m: Number(m[2]), match: m[0] };
  m = /\b(?:um|ab|gegen)?\s*([01]?\d|2[0-3])\s*uhr\b/i.exec(s);
  if (m) return { h: Number(m[1]), m: 0, match: m[0] };
  m = /\bhalb\s+([1-9]|1[0-2])\b/i.exec(s);
  if (m) { let h = Number(m[1]) - 1; if (h < 7) h += 12; return { h, m: 30, match: m[0] }; }
  m = /\b(?:um|at)\s+([1-9]|1[0-2])\s*(pm|am)\b/i.exec(s);
  if (m) return { h: (Number(m[1]) % 12) + (m[2].toLowerCase() === 'pm' ? 12 : 0), m: 0, match: m[0] };
  return null;
}

/** The first day in the text relative to `base` (Date) → { date (midnight), match } or null. */
function dayOf(s, base) {
  const day0 = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const plus = (n) => new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + n);
  let m = /\bübermorgen\b/i.exec(s);
  if (m) return { date: plus(2), match: m[0] };
  m = /\b(?:morgen|tomorrow)\b/i.exec(s);
  if (m) return { date: plus(1), match: m[0] };
  m = /\b(?:heute|today)\b/i.exec(s);
  if (m) return { date: plus(0), match: m[0] };
  m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?!\d)/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]) - 1;
    let y = m[3] ? Number(m[3]) : day0.getFullYear();
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 0 && mo <= 11) {
      let date = new Date(y, mo, d);
      if (!m[3] && date < day0) date = new Date(y + 1, mo, d);
      if (date.getDate() === d) return { date, match: m[0] };
    }
  }
  m = new RegExp('\\b(\\d{1,2})\\.?\\s*(' + MONTHS.join('|') + '|' + MONTHS_SHORT.join('|') + ')\\.?(?:\\s+(\\d{4}))?\\b', 'i').exec(s);
  if (m) {
    const name = m[2].toLowerCase();
    let mo = MONTHS.indexOf(name);
    if (mo < 0) mo = MONTHS_SHORT.indexOf(name.slice(0, 3));
    const d = Number(m[1]);
    let date = new Date(m[3] ? Number(m[3]) : day0.getFullYear(), mo, d);
    if (!m[3] && date < day0) date = new Date(day0.getFullYear() + 1, mo, d);
    if (date.getDate() === d) return { date, match: m[0] };
  }
  m = new RegExp('\\b(?:(nächsten|kommenden|diesen|am|next|on)\\s+)?(' + WEEKDAYS.join('|') + '|' + WEEKDAYS_EN.join('|') + ')\\b', 'i').exec(s);
  if (m) {
    const w = m[2].toLowerCase();
    let idx = WEEKDAYS.indexOf(w);
    if (idx < 0) idx = WEEKDAYS_EN.indexOf(w);
    let diff = (idx - day0.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // "Samstag" said on a Saturday: next week
    if (m[1] && /^(nächsten|next)$/i.test(m[1]) && diff < 2) diff += 7;
    return { date: plus(diff), match: m[0] };
  }
  return null;
}

/** A title for the date: the sentence without the date words, ≤ 60 characters. */
function titleFrom(sentence, parts) {
  let t = sentence;
  for (const p of parts) if (p) t = t.replace(p, ' ');
  t = t.replace(/\b(?:um|am|ab|gegen|bis|wir|ich|treffen uns|lass uns|lasst uns)\b/gi, ' ').replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:und|aber|also|dann|ok|okay|and)\s+/i, '');
  if (t.length > 60) t = t.slice(0, 59).replace(/\s+\S*$/, '') + '…';
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

function dates(text, sentAt) {
  const base = new Date(sentAt);
  const out = [];
  const sentences = sentencesOf(text);
  for (const sRaw of sentences) {
    const s = clean(sRaw);
    if (!s) continue;
    const day = dayOf(s, base);
    const time = timeOf(day ? s.replace(day.match, ' ') : s);
    if (!day && !time) continue;
    let d;
    let allDay = false;
    if (day) {
      d = new Date(day.date);
      if (time) d.setHours(time.h, time.m, 0, 0); else allDay = true;
    } else {
      d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), time.h, time.m, 0, 0);
      if (d.getTime() < base.getTime() - 3600000) d.setDate(d.getDate() + 1); // a time already past: tomorrow
    }
    const startsAt = d.toISOString();
    if (out.some((x) => x.startsAt === startsAt)) continue;
    out.push({ startsAt, label: label(d, allDay), title: titleFrom(s, [day && day.match, time && time.match]), allDay });
    if (out.length >= 5) break;
  }
  return out;
}

function suggest(text, sentAt) {
  const t = typeof text === 'string' ? text : '';
  return { items: items(t), dates: dates(t, sentAt) };
}

module.exports = { suggest, items, dates };
