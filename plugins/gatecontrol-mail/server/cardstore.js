'use strict';

// Contacts on the server (migration 004): a card row per contact of an address book — fields_json is the API's view
// for every source, vcard the whole card without its photo (local, CardDAV: round trip), the photo in card_photos;
// the addresses and phone digits indexed for the lookups, a counter per person for GET cards?since=, tombstones for
// removed cards.

const crypto = require('node:crypto');
const store = require('./store');
const pimstore = require('./pimstore');
const vcard = require('./vcard');
const { fail, bytesOf, parse } = require('./util');

const CARDS_MAX = 10000;           // per address book
const PHOTO_MAX = 256 * 1024;

/** Lower case, umlauts and accents folded (Ä → a, ß → s). */
function fold(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 's').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** The sort key of fields `f`: 'family' (Family Given) or 'given' (Given Family); a name-less card by company / address. */
function sortKeyOf(f, mode = 'family') {
  const n = f.name || {};
  const parts = mode === 'given' ? [n.given, n.family] : [n.family, n.given];
  let k = parts.filter(Boolean).join(' ').trim();
  if (!k) k = n.display || f.company || ((f.emails || [])[0] || {}).value || '';
  return fold(k).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The letter of a sort key: 'A'…'Z' or '#'. */
function letterOf(key) {
  const c = String(key || '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : '#';
}

/**
 * The compared form of one value of a card's field (lists: emails, phones, addresses, urls; single: company,
 * department, title, birthday): an address in lower case, the digits of a number, street|postal code|city folded.
 */
function valueKey(field, v) {
  if (v == null || v === '') return '';
  if (field === 'emails') return String(v.value || '').trim().toLowerCase();
  if (field === 'phones') return vcard.digits(v.value) || String(v.value || '').replace(/\s+/g, '');
  if (field === 'addresses') return fold(`${v.street || ''}|${v.postalCode || ''}|${v.city || ''}`).replace(/\s+/g, ' ').trim();
  if (field === 'urls') return String(v).trim();
  return fold(String(v)).replace(/\s+/g, ' ').trim();
}

const photoEtag = (p) => crypto.createHash('sha1').update(p.data).digest('hex').slice(0, 16);

/**
 * Store a card in address book `book` → the row ({ created }). x: { uid, fields (vcard.fieldsOf shape), vcard (text
 * without photo) | null, href, etag, remoteId, changeKey, photo ({ mime, data } | null; undefined: keep), pending,
 * baseVcard }.
 */
async function storeCard(gc, book, x) {
  const f = x.fields;
  const uid = String(x.uid || f.uid || x.remoteId || vcard.newUid()).slice(0, 255);
  const now = Date.now();
  const have = x.id ? await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [x.id]) : await store.one(gc, 'SELECT * FROM cards WHERE addressbook_id = ? AND uid = ?', [book.id, uid]);
  if (!have) {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM cards WHERE addressbook_id = ?', [book.id]);
    if (n.n >= CARDS_MAX) throw fail('limit', { max: CARDS_MAX });
  }
  const view = { ...f, photo: undefined };
  delete view.photo;
  const json = JSON.stringify(view);
  const version = await pimstore.nextCardVersion(gc, book.user_id);
  const cols = [f.name.display || '', f.name.given || null, f.name.family || null, sortKeyOf(f), f.company || null, f.title || null, f.birthday || null, json,
    x.vcard || null, bytesOf(x.vcard) + bytesOf(json)];
  let id;
  if (have) {
    await store.run(gc, `UPDATE cards SET display = ?, given = ?, family = ?, sort_key = ?, company = ?, title = ?, birthday = ?, fields_json = ?, vcard = ?, bytes = ?, href = COALESCE(?, href),
      etag = ?, remote_id = COALESCE(?, remote_id), change_key = ?, pending = ?, base_vcard = ?, version = ?, updated_at = ? WHERE id = ?`,
    [...cols, x.href || null, x.etag === undefined ? have.etag : x.etag, x.remoteId || null, x.changeKey === undefined ? have.change_key : x.changeKey, x.pending || null, x.baseVcard || null,
      version, now, have.id]);
    id = have.id;
  } else {
    const r = await store.run(gc, `INSERT INTO cards (user_id, addressbook_id, uid, remote_id, href, etag, change_key, display, given, family, sort_key, company, title, birthday, fields_json,
      vcard, bytes, pending, base_vcard, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [book.user_id, book.id, uid, x.remoteId || null, x.href || null, x.etag || null, x.changeKey || null, ...cols, x.pending || null, x.baseVcard || null, version, now, now]);
    id = Number(r.lastInsertRowid);
  }
  await store.run(gc, 'DELETE FROM card_emails WHERE card_id = ?', [id]);
  for (const e of f.emails || []) await store.run(gc, 'INSERT OR IGNORE INTO card_emails (card_id, user_id, email) VALUES (?, ?, ?)', [id, book.user_id, e.value]);
  await store.run(gc, 'DELETE FROM card_phones WHERE card_id = ?', [id]);
  for (const p of f.phones || []) { const d = vcard.digits(p.value); if (d) await store.run(gc, 'INSERT OR IGNORE INTO card_phones (card_id, user_id, digits) VALUES (?, ?, ?)', [id, book.user_id, d]); }
  if (x.photo !== undefined) await setPhoto(gc, id, x.photo);
  await store.run(gc, 'DELETE FROM card_tombstones WHERE user_id = ? AND card_id = ?', [book.user_id, id]);
  const row = await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [id]);
  return { ...row, created: !have };
}

/** The photo of card `id` ({ mime, data } | null). */
async function setPhoto(gc, id, photo) {
  if (!photo || !photo.data) {
    await store.run(gc, 'DELETE FROM card_photos WHERE card_id = ?', [id]);
    await store.run(gc, 'UPDATE cards SET photo_etag = NULL WHERE id = ?', [id]);
    return;
  }
  const bytes = Buffer.byteLength(photo.data, 'base64');
  if (bytes > PHOTO_MAX) return;
  const etag = photoEtag(photo);
  await store.run(gc, `INSERT INTO card_photos (card_id, mime, data, bytes, etag) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, bytes = excluded.bytes, etag = excluded.etag`, [id, photo.mime, photo.data, bytes, etag]);
  await store.run(gc, 'UPDATE cards SET photo_etag = ? WHERE id = ?', [etag, id]);
}

async function photoOf(gc, id) {
  const p = await store.one(gc, 'SELECT mime, data FROM card_photos WHERE card_id = ?', [id]);
  return p ? { mime: p.mime, data: p.data } : null;
}

/** Remove card `c` here (a tombstone for ?since=; its group memberships keep the address). */
async function dropCard(gc, c) {
  const f = parse(c.fields_json, {});
  const first = ((f.emails || [])[0] || {}).value || null;
  await store.run(gc, 'UPDATE card_group_members SET card_id = NULL, email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE card_id = ?', [first, c.display || null, c.id]);
  await store.run(gc, 'DELETE FROM card_group_members WHERE card_id IS NULL AND email IS NULL');
  await store.run(gc, 'UPDATE cards SET link_id = NULL WHERE link_id = ?', [c.id]);
  await store.run(gc, 'DELETE FROM card_emails WHERE card_id = ?', [c.id]);
  await store.run(gc, 'DELETE FROM card_phones WHERE card_id = ?', [c.id]);
  await store.run(gc, 'DELETE FROM card_photos WHERE card_id = ?', [c.id]);
  await store.run(gc, 'DELETE FROM card_dup_ignored WHERE user_id = ? AND (a = ? OR b = ?)', [c.user_id, c.id, c.id]);
  await store.run(gc, 'DELETE FROM card_dismissed WHERE card_id = ? OR source_id = ?', [c.id, c.id]);
  await store.run(gc, 'DELETE FROM card_conflicts WHERE card_id = ? OR source_id = ?', [c.id, c.id]);
  await store.run(gc, 'DELETE FROM card_origins WHERE card_id = ? OR source_id = ?', [c.id, c.id]);
  await store.run(gc, 'DELETE FROM cards WHERE id = ?', [c.id]);
  const version = await pimstore.nextCardVersion(gc, c.user_id);
  await store.run(gc, `INSERT INTO card_tombstones (user_id, card_id, version, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, card_id) DO UPDATE SET version = excluded.version, at = excluded.at`, [c.user_id, c.id, version, Date.now()]);
}

/** Remove address book `b` with its cards. */
async function dropBook(gc, b) {
  for (const c of await store.all(gc, 'SELECT * FROM cards WHERE addressbook_id = ?', [b.id])) await dropCard(gc, c);
  await store.run(gc, 'DELETE FROM addressbooks WHERE id = ?', [b.id]);
}

module.exports = { fold, valueKey, sortKeyOf, letterOf, storeCard, setPhoto, photoOf, dropCard, dropBook, CARDS_MAX, PHOTO_MAX };
