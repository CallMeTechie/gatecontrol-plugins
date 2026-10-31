'use strict';

// vCard 3.0 / 4.0 (RFC 2426 / RFC 6350) with ical.js (vendor/ical.cjs): reading a card into the fields of the API and
// changing a card round trip (unknown properties stay — two-way CardDAV). Properties are written as lines of the card's
// own version and parsed back by ical.js, so values are escaped once and typed the way that version wants. A photo
// travels separately (card_photos): the stored card has none, toText() puts it back for the provider.

const crypto = require('node:crypto');
const { ICAL } = require('./ics');
const { fail, line, clip } = require('./util');

const NOTE_MAX = 8 * 1024;
const LIST_MAX = 20;
const EMAIL_TYPES = ['home', 'work', 'other'];
const PHONE_TYPES = ['mobile', 'home', 'work', 'fax', 'other'];
const ADR_TYPES = ['home', 'work', 'other'];

/** Every VCARD of a text (a .vcf may hold many) → [ICAL.Component]; throws invalid_vcard. */
function parseAll(text) {
  if (typeof text !== 'string' || !/BEGIN:VCARD/i.test(text)) throw fail('invalid_vcard');
  // ical.js wants CRLF or LF line ends and unfolded lines it can fold itself
  let j;
  try { j = ICAL.parse(text.replace(/\r?\n/g, '\r\n')); } catch { throw fail('invalid_vcard'); }
  const list = Array.isArray(j) && Array.isArray(j[0]) ? j : [j];
  const out = [];
  for (const x of list) {
    try { const c = new ICAL.Component(x); if (c.name === 'vcard') out.push(c); } catch { /* one broken card */ }
  }
  if (!out.length) throw fail('invalid_vcard');
  return out;
}

const versionOf = (c) => (String(c.getFirstPropertyValue('version') || '3.0').startsWith('4') ? '4.0' : '3.0');

/** Escape a text value of a vCard line (escComp: a component of a structured value — N, ADR, ORG — also `;`). */
const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,');
const escComp = (s) => esc(s).replace(/;/g, '\\;');

/** Property lines (unfolded, of `version`) → ICAL.Property objects ready to add to card `c`. */
function props(lines, version) {
  if (!lines.length) return [];
  const card = new ICAL.Component(ICAL.parse(`BEGIN:VCARD\r\nVERSION:${version}\r\n${lines.join('\r\n')}\r\nEND:VCARD\r\n`));
  return card.getAllProperties().filter((p) => p.name !== 'version');
}

function replace(c, names, lines) {
  for (const n of names) c.removeAllProperties(n);
  for (const p of props(lines, versionOf(c))) c.addProperty(p);
}

const types = (p) => {
  const t = p.getParameter('type');
  return (Array.isArray(t) ? t : t ? [t] : []).flatMap((x) => String(x).toLowerCase().split(','));
};

function textVal(c, name) {
  const v = c.getFirstPropertyValue(name);
  return v == null ? '' : String(Array.isArray(v) ? v.join(' ') : v);
}

/** A BDAY property → 'YYYY-MM-DD' | '--MM-DD' | null. */
function birthdayOf(c) {
  const p = c.getFirstProperty('bday');
  if (!p) return null;
  const v = p.getFirstValue();
  // Apple writes a birthday without a year as 1604-MM-DD with X-APPLE-OMIT-YEAR
  const omit = String(p.getParameter('x-apple-omit-year') || '');
  const noYear = (y) => !y || String(y) === omit || Number(y) === 1604;
  let s = v && v._time ? null : String(v || '');
  if (v && v._time) {
    const t = v._time;
    if (!t.month || !t.day) return null;
    const mm = String(t.month).padStart(2, '0');
    const dd = String(t.day).padStart(2, '0');
    return noYear(t.year) ? `--${mm}-${dd}` : `${String(t.year).padStart(4, '0')}-${mm}-${dd}`;
  }
  s = s.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return noYear(m[1]) ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = /^--(\d{2})-?(\d{2})/.exec(s);
  return m ? `--${m[1]}-${m[2]}` : null;
}

/** The photo of a card → { mime, data (base64) } | { uri } | null. */
function photoOf(c) {
  const p = c.getFirstProperty('photo');
  if (!p) return null;
  const v = String(p.getFirstValue() || '');
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v);
  if (m) return { mime: m[1].toLowerCase(), data: m[2].replace(/\s+/g, '') };
  const enc = String(p.getParameter('encoding') || '').toLowerCase();
  if (enc === 'b' || enc === 'base64' || p.type === 'binary') {
    const t = String(p.getParameter('type') || 'jpeg').toLowerCase();
    return { mime: t.includes('/') ? t : `image/${t === 'jpg' ? 'jpeg' : t}`, data: v.replace(/\s+/g, '') };
  }
  return /^https?:\/\//i.test(v) ? { uri: v.slice(0, 2000) } : null;
}

/** The fields of a card (the API's Card without ids). */
function fieldsOf(c) {
  const n = c.getFirstPropertyValue('n');
  const np = Array.isArray(n) ? n : (typeof n === 'string' ? n.split(';') : []);
  const s = (i) => clip(line(Array.isArray(np[i]) ? np[i].join(' ') : (np[i] || '')), 120);
  const org = c.getFirstProperty('org');
  const orgv = org ? org.getValues().flat() : [];
  const emails = [];
  for (const p of c.getAllProperties('email')) {
    const value = String(p.getFirstValue() || '').trim().toLowerCase().replace(/^mailto:/, '');
    if (!/^[^\s@]+@[^\s@]+$/.test(value) || emails.some((e) => e.value === value) || emails.length >= LIST_MAX) continue;
    const ty = types(p);
    emails.push({ value: value.slice(0, 254), type: ty.includes('work') ? 'work' : ty.includes('home') ? 'home' : 'other', primary: ty.includes('pref') || p.getParameter('pref') === '1' || p.getParameter('pref') === 1 });
  }
  if (emails.length && !emails.some((e) => e.primary)) emails[0].primary = true;
  const phones = [];
  for (const p of c.getAllProperties('tel')) {
    const value = clip(line(String(p.getFirstValue() || '').replace(/^tel:/i, '')), 40);
    if (!value || phones.length >= LIST_MAX) continue;
    const ty = types(p);
    phones.push({ value, type: ty.includes('fax') ? 'fax' : (ty.includes('cell') || ty.includes('mobile')) ? 'mobile' : ty.includes('work') ? 'work' : ty.includes('home') ? 'home' : 'other' });
  }
  const addresses = [];
  for (const p of c.getAllProperties('adr')) {
    const v = p.getFirstValue();
    const a = Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x.join(' ') : String(x || ''))) : String(v || '').split(';');
    const ty = types(p);
    const one = { type: ty.includes('work') ? 'work' : ty.includes('home') ? 'home' : 'other', street: clip(line([a[1], a[2]].filter(Boolean).join(' ')), 200), postalCode: clip(line(a[5] || ''), 20),
      city: clip(line(a[3] || ''), 100), region: clip(line(a[4] || ''), 100), country: clip(line(a[6] || ''), 100) };
    if ((one.street || one.city || one.postalCode || one.country) && addresses.length < LIST_MAX) addresses.push(one);
  }
  const urls = c.getAllProperties('url').map((p) => String(p.getFirstValue() || '').trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 10).map((u) => u.slice(0, 500));
  const given = s(1);
  const family = s(0);
  let display = clip(line(textVal(c, 'fn')), 200);
  if (!display) display = [given, family].filter(Boolean).join(' ') || clip(line(orgv[0] || ''), 200) || (emails[0] ? emails[0].value : '');
  const cats = [];
  for (const p of c.getAllProperties('categories')) for (const x of p.getValues().flat()) if (x && cats.length < 20) cats.push(clip(line(String(x)), 60));
  return {
    uid: String(c.getFirstPropertyValue('uid') || '').slice(0, 255) || null, version: versionOf(c),
    name: { display, given, family, middle: s(2) || null, prefix: s(3) || null, suffix: s(4) || null, nickname: clip(line(textVal(c, 'nickname')), 120) || null },
    emails, phones, company: clip(line(String(orgv[0] || '')), 200) || null, department: clip(line(String(orgv[1] || '')), 200) || null,
    title: clip(line(textVal(c, 'title')), 200) || null, addresses, birthday: birthdayOf(c), note: textVal(c, 'note').slice(0, NOTE_MAX), urls, categories: cats,
    photo: photoOf(c),
  };
}

/**
 * Check the Card fields of the API (POST / PATCH cards) → the clean fields given (only those present); throws invalid.
 */
function check(b) {
  const out = {};
  const bad = (field) => { throw fail('invalid', { field }); };
  const str = (v, max, field) => { if (v == null) return null; if (typeof v !== 'string' || v.length > max) bad(field); return clip(line(v), max) || null; };
  if (b.name !== undefined) {
    if (!b.name || typeof b.name !== 'object') bad('name');
    const n = {};
    for (const k of ['display', 'given', 'family', 'middle', 'prefix', 'suffix', 'nickname']) n[k] = str(b.name[k], 200, `name.${k}`);
    out.name = n;
  }
  if (b.emails !== undefined) {
    if (!Array.isArray(b.emails) || b.emails.length > LIST_MAX) bad('emails');
    out.emails = [];
    for (const e of b.emails) {
      const v = e && typeof e === 'object' ? String(e.value || '').trim().toLowerCase() : '';
      if (!/^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/.test(v)) bad('emails');
      if (out.emails.some((x) => x.value === v)) continue;
      out.emails.push({ value: v, type: EMAIL_TYPES.includes(e.type) ? e.type : 'other', primary: e.primary === true });
    }
    if (out.emails.length && !out.emails.some((e) => e.primary)) out.emails[0].primary = true;
  }
  if (b.phones !== undefined) {
    if (!Array.isArray(b.phones) || b.phones.length > LIST_MAX) bad('phones');
    out.phones = b.phones.map((p) => {
      const v = p && typeof p === 'object' && typeof p.value === 'string' ? line(p.value) : '';
      if (!v || v.length > 40 || !/\d/.test(v)) bad('phones');
      return { value: v, type: PHONE_TYPES.includes(p.type) ? p.type : 'other' };
    });
  }
  for (const k of ['company', 'department', 'title']) if (b[k] !== undefined) out[k] = str(b[k], 200, k);
  if (b.addresses !== undefined) {
    if (!Array.isArray(b.addresses) || b.addresses.length > LIST_MAX) bad('addresses');
    out.addresses = b.addresses.map((a) => {
      if (!a || typeof a !== 'object') bad('addresses');
      return { type: ADR_TYPES.includes(a.type) ? a.type : 'other', street: str(a.street, 200, 'addresses') || '', postalCode: str(a.postalCode, 20, 'addresses') || '',
        city: str(a.city, 100, 'addresses') || '', region: str(a.region, 100, 'addresses') || '', country: str(a.country, 100, 'addresses') || '' };
    });
  }
  if (b.birthday !== undefined) {
    if (b.birthday !== null && !(typeof b.birthday === 'string' && /^(\d{4}|-)-(\d{2})-(\d{2})$/.test(b.birthday) && validDay(b.birthday))) bad('birthday');
    out.birthday = b.birthday;
  }
  if (b.note !== undefined) { if (b.note !== null && (typeof b.note !== 'string' || Buffer.byteLength(b.note) > NOTE_MAX)) bad('note'); out.note = b.note || ''; }
  if (b.urls !== undefined) {
    if (!Array.isArray(b.urls) || b.urls.length > 10 || !b.urls.every((u) => typeof u === 'string' && /^https?:\/\/\S{1,490}$/i.test(u))) bad('urls');
    out.urls = b.urls;
  }
  return out;
}

function validDay(s) {
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(s);
  const y = m[1] === '-' ? 2000 : Number(m[1]);
  const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const V3 = { email: { home: 'INTERNET,HOME', work: 'INTERNET,WORK', other: 'INTERNET' }, tel: { mobile: 'CELL,VOICE', home: 'HOME,VOICE', work: 'WORK,VOICE', fax: 'FAX', other: 'VOICE' }, adr: { home: 'HOME', work: 'WORK', other: 'OTHER' } };
const V4 = { email: { home: 'home', work: 'work', other: null }, tel: { mobile: 'cell', home: 'home', work: 'work', fax: 'fax', other: 'voice' }, adr: { home: 'home', work: 'work', other: null } };

/** Apply the checked fields `f` (check()) to card component `c` (round trip: other properties stay). */
function apply(c, f) {
  const v = versionOf(c);
  const map = v === '4.0' ? V4 : V3;
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  if (has('name')) {
    const n = f.name;
    const display = n.display || [n.prefix, n.given, n.middle, n.family, n.suffix].filter(Boolean).join(' ') || (f.company || '') || '';
    replace(c, ['n', 'fn'], [`N:${[n.family, n.given, n.middle, n.prefix, n.suffix].map((x) => escComp(x || '')).join(';')}`, `FN:${esc(display || ' ')}`]);
    replace(c, ['nickname'], n.nickname ? [`NICKNAME:${esc(n.nickname)}`] : []);
  }
  if (has('emails')) {
    replace(c, ['email'], f.emails.map((e) => {
      const t = map.email[e.type];
      const pref = e.primary ? (v === '4.0' ? ';PREF=1' : (t ? ',PREF' : ';TYPE=PREF')) : '';
      return `EMAIL${t ? `;TYPE=${t}` : ''}${pref}:${e.value}`;
    }));
  }
  if (has('phones')) replace(c, ['tel'], f.phones.map((p) => `TEL;TYPE=${map.tel[p.type]}:${esc(p.value)}`));
  if (has('company') || has('department')) {
    const cur = fieldsOf(c);
    const company = has('company') ? f.company : cur.company;
    const dept = has('department') ? f.department : cur.department;
    replace(c, ['org'], company || dept ? [`ORG:${escComp(company || '')}${dept ? ';' + escComp(dept) : ''}`] : []);
  }
  if (has('title')) replace(c, ['title'], f.title ? [`TITLE:${esc(f.title)}`] : []);
  if (has('addresses')) {
    replace(c, ['adr'], f.addresses.map((a) => {
      const t = map.adr[a.type];
      return `ADR${t ? `;TYPE=${t}` : ''}:;;${[a.street, a.city, a.region, a.postalCode, a.country].map(escComp).join(';')}`;
    }));
  }
  if (has('birthday')) {
    let lineB = null;
    if (f.birthday) {
      const full = /^\d{4}-/.test(f.birthday);
      if (v === '4.0') lineB = `BDAY:${full ? f.birthday.replace(/-/g, '') : '--' + f.birthday.slice(2).replace('-', '')}`;
      else lineB = full ? `BDAY:${f.birthday}` : `BDAY;X-APPLE-OMIT-YEAR=1604:1604-${f.birthday.slice(2)}`;
    }
    replace(c, ['bday'], lineB ? [lineB] : []);
  }
  if (has('note')) replace(c, ['note'], f.note ? [`NOTE:${esc(f.note)}`] : []);
  if (has('urls')) replace(c, ['url'], f.urls.map((u) => `URL:${u}`));
  c.removeAllProperties('rev');
  for (const p of props([`REV:${new Date().toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, '')}`], v)) c.addProperty(p);
}

/** A new card of `version` with `uid`. */
function create(uid, version = '3.0') {
  const v = version === '4.0' ? '4.0' : '3.0';
  const c = new ICAL.Component(ICAL.parse(`BEGIN:VCARD\r\nVERSION:${v}\r\nUID:${esc(uid)}\r\nFN: \r\nN:;;;;\r\nEND:VCARD\r\n`));
  if (v === '4.0') replace(c, ['prodid'], ['PRODID:-//GateControl//Mail//DE']);
  return c;
}

/** Take the photo out of card `c` (data photos only) → { mime, data } | null. */
function takePhoto(c) {
  const ph = photoOf(c);
  if (ph && ph.data) c.removeAllProperties('photo');
  return ph && ph.data ? ph : null;
}

/** The text of card `c` with `photo` ({ mime, data }) put back for the provider. */
function toText(c, photo) {
  const copy = new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));
  if (photo && photo.data) {
    copy.removeAllProperties('photo');
    const v = versionOf(copy);
    const line4 = `PHOTO;VALUE=URI:data:${photo.mime};base64,${photo.data}`;
    const line3 = `PHOTO;ENCODING=b;TYPE=${photo.mime === 'image/png' ? 'PNG' : 'JPEG'}:${photo.data}`;
    for (const p of props([v === '4.0' ? line4 : line3], v)) copy.addProperty(p);
  }
  // a data URI is no text: ical.js escapes its comma (vCard 4.0), other clients would not read it
  const out = copy.toString().replace(/^(PHOTO[^:\r\n]*:data:[\w/+.-]+;base64)\\,/gm, '$1,');
  return out.replace(/\r?\n/g, '\r\n') + (out.endsWith('\n') ? '' : '\r\n');
}

/** A version-4.0 copy of card `c` for the export (the values kept, the version line swapped). */
function asV4(c, photo) {
  const text = toText(c, null).replace(/^VERSION:3\.0\r?$/m, 'VERSION:4.0');
  let out;
  try { out = parseAll(text)[0]; } catch { out = c; }
  return toText(out, photo);
}

/** A stable uid for a new card. */
const newUid = () => crypto.randomUUID();

/** Digits of a phone number for comparisons: +49 / 0049 / 0 the same; the last 9 digits. */
function digits(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('49')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d.length >= 5 ? d.slice(-9) : '';
}

module.exports = { parseAll, fieldsOf, check, apply, create, takePhoto, toText, asV4, newUid, digits, versionOf, photoOf, NOTE_MAX };
