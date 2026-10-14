'use strict';

// The emergency card — "Notfall-Karte" (module emergency). Sensitive health
// data: stored only in this plugin's database on the family's own server,
// readable by every member (in an emergency anyone may need it), never in a
// push and never in a log line (errors name the field, never the value).
//
//   GET emergency                     every member's card + the family's contacts
//   PUT emergency/members/<userId>    parents: anyone's card; any member: their own
//   PUT emergency/contacts            parents: the family-wide contacts
//
// PUT replaces the fields it names (the others stay). No default contacts are
// seeded — no numbers we could get wrong; the apps suggest labels and show a
// fixed "Notruf 112" of their own.

const store = require('./store');
const { fail, posInt, optText, multiline, iso, parseJson } = require('./util');

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', '0+', '0-', 'unknown'];
const TEXT_MAX = 300;
const NOTES_MAX = 500;
const INSURANCE_NAME_MAX = 60;
const INSURANCE_NUMBER_MAX = 40;
const LABEL_MAX = 60;
const PHONE_MAX = 30;
const CONTACT_NOTE_MAX = 80;
const MEMBER_CONTACTS_MAX = 10;
const FAMILY_CONTACTS_MAX = 20;
const PHONE_RE = /^[0-9 +/()-]+$/;

const invalid = (field) => fail('invalid', { field });

function emptyCard() {
  return {
    bloodType: null, weightKg: null, allergies: '', medications: '', conditions: '', notes: '', insurance: null, contacts: [], updatedAt: null, updatedBy: null,
  };
}

function rowToCard(r) {
  return {
    bloodType: BLOOD_TYPES.includes(r.blood_type) ? r.blood_type : null,
    weightKg: r.weight_kg == null ? null : r.weight_kg,
    allergies: r.allergies || '', medications: r.medications || '', conditions: r.conditions || '', notes: r.notes || '',
    insurance: r.insurance_name || r.insurance_number ? { name: r.insurance_name || '', number: r.insurance_number || '' } : null,
    contacts: parseJson(r.contacts_json, []),
    updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

function by(fam, id) {
  if (id == null) return null;
  const m = fam.byId.get(id);
  const u = m || fam.users.get(id);
  return { userId: id, name: u ? u.name : null };
}

function cardView(m, card, fam) {
  return {
    userId: m.userId, name: m.name, birthdate: m.role === 'wall' ? null : m.birthdate, age: m.age,
    bloodType: card.bloodType, weightKg: card.weightKg,
    allergies: card.allergies, medications: card.medications, conditions: card.conditions, notes: card.notes,
    insurance: card.insurance, contacts: card.contacts,
    updatedAt: iso(card.updatedAt), updatedBy: by(fam, card.updatedBy),
  };
}

async function cardOf(gc, userId) {
  const r = await store.one(gc, 'SELECT * FROM emergency_cards WHERE user_id = ?', [userId]);
  return r ? rowToCard(r) : emptyCard();
}

async function family(gc) {
  const r = await store.one(gc, 'SELECT * FROM emergency_family WHERE id = 1');
  return r ? { contacts: parseJson(r.contacts_json, []), updatedAt: r.updated_at, updatedBy: r.updated_by } : { contacts: [], updatedAt: null, updatedBy: null };
}

/** GET emergency */
async function get(gc, r) {
  const rows = await store.all(gc, 'SELECT * FROM emergency_cards');
  const cards = new Map(rows.map((x) => [x.user_id, rowToCard(x)]));
  const fam = await family(gc);
  const list = r.fam.list.map((m) => cardView(m, cards.get(m.userId) || emptyCard(), r.fam));
  let latest = fam.updatedAt;
  for (const m of r.fam.list) {
    const c = cards.get(m.userId);
    if (c && c.updatedAt != null && (latest == null || c.updatedAt > latest)) latest = c.updatedAt;
  }
  return { members: list, contacts: fam.contacts, updatedAt: iso(latest) };
}

// ─── input ──────────────────────────────────────

function field(v, max, name, multi) {
  if (v == null) return '';
  const s = multi ? multiline(v) : optText(v, max);
  if (s == null) throw invalid(name);
  if (s.length > max) throw invalid(name);
  return s;
}

function bloodType(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw invalid('bloodType');
  const s = v.trim().toUpperCase().replace(/^O/, '0').replace(/\s+/g, '');
  const n = s === 'UNKNOWN' ? 'unknown' : s;
  if (!BLOOD_TYPES.includes(n)) throw invalid('bloodType');
  return n;
}

function weight(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 400) throw invalid('weightKg');
  return Math.round(v * 10) / 10;
}

function insurance(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('insurance');
  const name = optText(v.name == null ? null : v.name, INSURANCE_NAME_MAX);
  const number = optText(v.number == null ? null : v.number, INSURANCE_NUMBER_MAX);
  return name || number ? { name: name || '', number: number || '' } : null;
}

/** Phone numbers: digits, spaces and + / ( ) - only (at least one digit). */
function phone(v, name) {
  if (typeof v !== 'string') throw invalid(name);
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s || s.length > PHONE_MAX || !PHONE_RE.test(s) || !/\d/.test(s)) throw invalid(name);
  return s;
}

function contacts(v, max, prefix) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw invalid(prefix);
  return v.map((c, i) => {
    const at = `${prefix}.${i}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw invalid(at);
    let label;
    try { label = optText(c.label, LABEL_MAX); } catch { label = null; }
    if (!label) throw invalid(`${at}.label`);
    let note;
    try { note = optText(c.note == null ? null : c.note, CONTACT_NOTE_MAX); } catch { throw invalid(`${at}.note`); }
    return { label, phone: phone(c.phone, `${at}.phone`), note: note || '' };
  });
}

function textField(v, max, name) {
  try { return field(v, max, name, true); } catch { throw invalid(name); }
}

/** PUT emergency/members/<userId> (parents: anyone; any member: their own card) */
async function putMember(gc, r, raw) {
  const userId = posInt(raw);
  const m = userId ? r.fam.byId.get(userId) : null;
  if (!m) throw fail('not_found');
  if (r.me.role !== 'parent' && userId !== r.me.userId) throw fail('parents_only');
  const b = r.body || {};
  const cur = await cardOf(gc, userId);
  const next = {
    bloodType: b.bloodType !== undefined ? bloodType(b.bloodType) : cur.bloodType,
    weightKg: b.weightKg !== undefined ? weight(b.weightKg) : cur.weightKg,
    allergies: b.allergies !== undefined ? textField(b.allergies, TEXT_MAX, 'allergies') : cur.allergies,
    medications: b.medications !== undefined ? textField(b.medications, TEXT_MAX, 'medications') : cur.medications,
    conditions: b.conditions !== undefined ? textField(b.conditions, TEXT_MAX, 'conditions') : cur.conditions,
    notes: b.notes !== undefined ? textField(b.notes, NOTES_MAX, 'notes') : cur.notes,
    insurance: cur.insurance,
    contacts: b.contacts !== undefined ? contacts(b.contacts, MEMBER_CONTACTS_MAX, 'contacts') : cur.contacts,
  };
  if (b.insurance !== undefined) {
    try { next.insurance = insurance(b.insurance); } catch { throw invalid('insurance'); }
  }
  await store.run(gc, `INSERT INTO emergency_cards (user_id, blood_type, weight_kg, allergies, medications, conditions, notes, insurance_name, insurance_number, contacts_json, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET blood_type = excluded.blood_type, weight_kg = excluded.weight_kg, allergies = excluded.allergies,
      medications = excluded.medications, conditions = excluded.conditions, notes = excluded.notes, insurance_name = excluded.insurance_name,
      insurance_number = excluded.insurance_number, contacts_json = excluded.contacts_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  [userId, next.bloodType, next.weightKg, next.allergies, next.medications, next.conditions, next.notes,
    next.insurance ? next.insurance.name : null, next.insurance ? next.insurance.number : null, JSON.stringify(next.contacts), r.now, r.me.userId]);
  return { member: cardView(m, await cardOf(gc, userId), r.fam) };
}

/** PUT emergency/contacts { contacts } (parents) */
async function putContacts(gc, r) {
  if (r.me.role !== 'parent') throw fail('parents_only');
  const b = r.body || {};
  if (!Array.isArray(b.contacts)) throw invalid('contacts');
  const list = contacts(b.contacts, FAMILY_CONTACTS_MAX, 'contacts');
  await store.run(gc, `INSERT INTO emergency_family (id, contacts_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET contacts_json = excluded.contacts_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  [JSON.stringify(list), r.now, r.me.userId]);
  const f = await family(gc);
  return { contacts: f.contacts, updatedAt: iso(f.updatedAt), updatedBy: by(r.fam, f.updatedBy) };
}

module.exports = { BLOOD_TYPES, PHONE_RE, get, putMember, putContacts };
