'use strict';

// Mail 1.4.0 — the GateControl contact as the master (Nachtrag „Kontakte: GC-Kontakt als Master“). Duplicates become
// one contact in the person's own address book (GC); the cards of the accounts (Graph, CardDAV) are linked to it, stay
// at their provider and are not listed on their own. What a linked card has and the master has not is taken over;
// another value of the same kind is a conflict the person takes over or dismisses (a dismissed value stays away until it
// changes at the provider). Certain duplicates (a shared address or number and a similar name) are merged without
// asking — once for the existing contacts after the update, then after every sync; the others wait in the list.
// Nothing is deleted at a provider; a merge can be undone. Favourites and the main number live in GateControl only.

const store = require('./store');
const config = require('./config');
const vcard = require('./vcard');
const pimstore = require('./pimstore');
const cardstore = require('./cardstore');
const { fail, parse, posInt } = require('./util');

const cards = () => require('./cards');

const MERGE_MAX = 10;
const FAVORITES_MAX = 50;
const LISTS = ['emails', 'phones', 'addresses', 'urls'];
const TYPED = ['phones', 'addresses'];
const SINGLES = ['company', 'department', 'title', 'birthday'];
const PHONE_RANK = { mobile: 0, work: 1, home: 2, fax: 3, other: 4 };
const EMOJI = /\p{Extended_Pictographic}/u;
const key = cardstore.valueKey;

const fieldsOf = (row) => parse(row.fields_json, {});
const clone = (x) => JSON.parse(JSON.stringify(x));

// ─── names ──────────────────────────────────────

/** Does a card's name carry an emoji („Schatzimausi 💞“: obviously the person's own name for someone)? */
function hasEmoji(f) {
  const n = f.name || {};
  return EMOJI.test(`${n.display || ''} ${n.given || ''} ${n.family || ''}`);
}

/** The folded words of a card's name; [] for a card without a name (only an address, a number or a company). */
function nameWords(f) {
  const n = f.name || {};
  let s = [n.given, n.middle, n.family].filter(Boolean).join(' ');
  if (!s) {
    const d = String(n.display || '').trim();
    const firstMail = ((f.emails || [])[0] || {}).value || '';
    if (!d || d.includes('@') || /^[\d\s+()/.-]+$/.test(d) || d === firstMail || (f.company && d === f.company)) return [];
    s = d;
  }
  return cardstore.fold(s).replace(/[\p{Extended_Pictographic}‍️]/gu, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Are the names of two cards similar (Nachtrag 2.2)? */
function similar(a, b) {
  const wa = nameWords(a);
  const wb = nameWords(b);
  if (!wa.length || !wb.length) return true;
  if (wa.join(' ') === wb.join(' ')) return true;
  const fold = (s) => cardstore.fold(s || '').replace(/[.\s]+$/, '').trim();
  const na = a.name || {};
  const nb = b.name || {};
  if (fold(na.family) && fold(na.family) === fold(nb.family)) {
    const ga = fold(na.given);
    const gb = fold(nb.given);
    if (!ga || !gb || ga === gb || (ga.length === 1 && gb.startsWith(ga)) || (gb.length === 1 && ga.startsWith(gb))) return true;
  }
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return small.every((w) => big.some((x) => x === w || (w.length === 1 && x.startsWith(w))));
}

/** The points of a name for „the most complete one“. */
function nameScore(f) {
  const n = f.name || {};
  return (n.given ? 1 : 0) + (n.family ? 1 : 0) + (n.middle ? 0.5 : 0) + (n.prefix ? 0.5 : 0) + (n.suffix ? 0.5 : 0);
}

const fullName = (n) => ({ display: n.display || '', given: n.given || '', family: n.family || '', middle: n.middle || null, prefix: n.prefix || null, suffix: n.suffix || null, nickname: n.nickname || null });

// ─── books, rows ────────────────────────────────

async function bookMap(gc, userId) {
  return new Map((await store.all(gc, 'SELECT * FROM addressbooks WHERE user_id = ?', [userId])).map((b) => [b.id, b]));
}

/** The person's GateControl address book (the local one). */
async function gcBook(gc, userId, lang) {
  let b = await store.one(gc, "SELECT * FROM addressbooks WHERE user_id = ? AND source = 'local' ORDER BY is_default DESC, id LIMIT 1", [userId]);
  if (!b) { await pimstore.ensureSetup(gc, userId, lang); b = await store.one(gc, "SELECT * FROM addressbooks WHERE user_id = ? AND source = 'local' ORDER BY is_default DESC, id LIMIT 1", [userId]); }
  return b;
}

/** Has the person's one run after the update (Nachtrag 2.6) been done? Before it, a link shows joined like 1.3.6. */
async function migrated(gc, userId) {
  const r = await store.one(gc, 'SELECT master_at FROM card_runs WHERE user_id = ?', [userId]);
  return !!(r && r.master_at);
}

/** A Source of the API for card row `c`. */
function sourceView(c, books, accounts) {
  const b = books.get(c.addressbook_id) || {};
  const a = b.account_id ? accounts.get(b.account_id) : null;
  return { id: c.id, addressbookId: c.addressbook_id, addressbook: b.name || '', source: b.source || 'local', accountId: b.account_id || null, account: a ? a.email : null };
}

async function accountMap(gc, userId) {
  return new Map((await store.all(gc, 'SELECT id, email FROM accounts WHERE user_id = ?', [userId])).map((a) => [a.id, a]));
}

/** The main number of fields `f` (`chosen`: the value key the person picked) → { value, type } | null. */
function mainPhoneOf(f, chosen) {
  const list = f.phones || [];
  return (chosen && list.find((p) => key('phones', p) === chosen)) || list.find((p) => p.type === 'mobile') || list[0] || null;
}

// ─── the fields of a merge ──────────────────────

/**
 * The fields of the contact that `entries` ([{ row, f, local }], the order: GC cards first, then the newest) become
 * (Nachtrag 2.3) → { fields, origins: [{ field, key, sourceId }], photoFrom, singleLosers: [{ field, value, sourceId }] }.
 */
async function unionOf(gc, entries, o = {}) {
  const pick = o.pick && typeof o.pick === 'object' ? o.pick : {};
  const byId = new Map(entries.map((e) => [e.row.id, e]));
  const pickEntry = (k) => { const id = posInt(pick[k]); return id && byId.has(id) ? byId.get(id) : null; };
  const primary = o.primaryId && byId.has(o.primaryId) ? byId.get(o.primaryId) : null;
  const order = primary ? [primary, ...entries.filter((e) => e !== primary)] : entries;
  const out = { emails: [], phones: [], addresses: [], urls: [] };
  const seen = { emails: new Map(), phones: new Map(), addresses: new Map(), urls: new Map() };
  const sourcesOf = new Map(); // 'field|key' → [entry]
  const localValue = new Set();
  for (const field of LISTS) {
    for (const e of order) {
      for (const v of e.f[field] || []) {
        const k = key(field, v);
        if (!k) continue;
        const sk = `${field}|${k}`;
        if (!sourcesOf.has(sk)) sourcesOf.set(sk, []);
        sourcesOf.get(sk).push(e);
        if (seen[field].has(k)) {
          if (field === 'phones') {
            const have = seen.phones.get(k);
            if ((PHONE_RANK[v.type] ?? 9) < (PHONE_RANK[have.type] ?? 9)) have.type = v.type;
            // the spelling of a GC card stays; among the accounts' cards one with + wins
            if (!localValue.has(`phones|${k}`) && !String(have.value).startsWith('+') && String(v.value).startsWith('+')) have.value = v.value;
          }
          continue;
        }
        const copy = typeof v === 'object' ? { ...v } : v;
        if (e.local) localValue.add(`${field}|${k}`);
        seen[field].set(k, copy);
        out[field].push(copy);
      }
    }
  }
  out.emails = out.emails.map((e, i) => ({ ...e, primary: i === 0 }));
  // the name: picked; else an emoji name (a GC one first); else the most complete one
  let nameFrom = pickEntry('name') || primary;
  if (!nameFrom) nameFrom = order.find((e) => hasEmoji(e.f) && e.local) || order.find((e) => hasEmoji(e.f));
  if (!nameFrom) {
    nameFrom = [...order].sort((a, b) => nameScore(b.f) - nameScore(a.f) || String((b.f.name || {}).display || '').length - String((a.f.name || {}).display || '').length
      || (b.local ? 1 : 0) - (a.local ? 1 : 0))[0];
  }
  const name = fullName(nameFrom.f.name || {});
  if (name.given && !name.family && !hasEmoji(nameFrom.f)) {
    const g = cardstore.fold(name.given).trim();
    const other = order.find((e) => e !== nameFrom && (e.f.name || {}).family && cardstore.fold((e.f.name || {}).given || '').trim() === g);
    if (other) { name.family = other.f.name.family; name.display = [name.given, name.family].join(' '); }
  }
  if (!name.display) name.display = [name.given, name.family].filter(Boolean).join(' ') || ((order.find((e) => e.f.company) || {}).f || {}).company || (out.emails[0] || {}).value || '';
  const fields = { name, ...out, company: null, department: null, title: null, birthday: null, note: '' };
  const singleFrom = {};
  const singleLosers = [];
  for (const k of SINGLES) {
    let from = pickEntry(k === 'department' ? 'company' : k);
    if (!from && primary && primary.f[k]) from = primary;
    if (!from) from = order.find((e) => e.f[k]) || null;
    if (k === 'birthday' && from && String(from.f.birthday).startsWith('--')) {
      const full = order.find((e) => e.f.birthday && !e.f.birthday.startsWith('--') && e.f.birthday.slice(-5) === from.f.birthday.slice(-5));
      if (full) from = full;
    }
    fields[k] = from ? from.f[k] || null : null;
    singleFrom[k] = from;
    if (fields[k]) {
      for (const e of order) {
        const v = e.f[k];
        if (!v || e.local || key(k, v) === key(k, fields[k])) continue;
        if (k === 'birthday' && v.slice(-5) === fields[k].slice(-5)) continue;
        if (!singleLosers.some((x) => x.field === k && key(k, x.value) === key(k, v))) singleLosers.push({ field: k, value: v, sourceId: e.row.id });
      }
    }
  }
  const notes = [];
  for (const e of order) { const n = String(e.f.note || '').trim(); if (n && !notes.includes(n)) notes.push(n); }
  fields.note = Buffer.from(notes.join('\n\n')).subarray(0, vcard.NOTE_MAX).toString().replace(/�$/, '');
  // where each value came from: only values that no GC card has (they are GateControl's own)
  const origins = [];
  for (const field of LISTS) {
    for (const v of fields[field]) {
      const k = key(field, v);
      const src = sourcesOf.get(`${field}|${k}`) || [];
      if (src.some((e) => e.local)) continue;
      if (src[0]) origins.push({ field, key: k, sourceId: src[0].row.id });
    }
  }
  for (const k of SINGLES) {
    const from = singleFrom[k];
    if (fields[k] && from && !from.local && !order.some((e) => e.local && key(k, e.f[k]) === key(k, fields[k]))) origins.push({ field: k, key: key(k, fields[k]), sourceId: from.row.id });
  }
  // the picture: picked; else a GC card's; else the largest
  let photoFrom = pickEntry('photo');
  if (photoFrom && !photoFrom.row.photo_etag) photoFrom = null;
  if (!photoFrom) photoFrom = order.find((e) => e.local && e.row.photo_etag) || null;
  if (!photoFrom) {
    let best = 0;
    for (const e of order) {
      if (!e.row.photo_etag) continue;
      const p = await store.one(gc, 'SELECT bytes FROM card_photos WHERE card_id = ?', [e.row.id]);
      if (p && p.bytes > best) { best = p.bytes; photoFrom = e; }
    }
  }
  return { fields, origins, photoFrom: photoFrom ? photoFrom.row.id : null, singleLosers, nameFrom: nameFrom.row.id };
}

/** The cards `ids` of the person → the entries of a merge (a linked card stands for its master; an old link of an account card brings its linked cards). */
async function entriesOf(gc, userId, ids) {
  const books = await bookMap(gc, userId);
  const rows = new Map();
  const add = (r) => { if (r && !rows.has(r.id)) rows.set(r.id, r); };
  for (const id of ids) {
    const r = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM cards WHERE id = ? AND user_id = ?', [id, userId]) : null;
    if (!r) throw fail('not_found');
    if (r.link_id) {
      const m = await store.one(gc, 'SELECT * FROM cards WHERE id = ? AND user_id = ?', [r.link_id, userId]);
      add(m || r);
    } else add(r);
  }
  for (const r of [...rows.values()]) {
    const b = books.get(r.addressbook_id);
    if (b && b.source !== 'local') for (const l of await store.all(gc, 'SELECT * FROM cards WHERE link_id = ? AND user_id = ?', [r.id, userId])) add(l);
  }
  const list = [...rows.values()].map((row) => ({ row, f: fieldsOf(row), book: books.get(row.addressbook_id) || {}, local: (books.get(row.addressbook_id) || {}).source === 'local' }));
  // GC cards first (the oldest), then the account cards (the newest first)
  list.sort((a, b) => (b.local ? 1 : 0) - (a.local ? 1 : 0) || (a.local ? a.row.id - b.row.id : b.row.updated_at - a.row.updated_at || a.row.id - b.row.id));
  return { list, books };
}

/** The GC card that stays the master of `entries` (the given one, else the one with the most links, else the oldest). */
async function masterOf(gc, entries, primaryId) {
  const locals = entries.filter((e) => e.local);
  if (!locals.length) return null;
  const p = locals.find((e) => e.row.id === primaryId);
  if (p) return p;
  let best = null;
  for (const e of locals) {
    const n = (await store.one(gc, 'SELECT COUNT(*) AS n FROM cards WHERE link_id = ?', [e.row.id])).n;
    if (!best || n > best.n || (n === best.n && e.row.id < best.e.row.id)) best = { e, n };
  }
  return best.e;
}

// ─── merging ────────────────────────────────────

async function addOrigins(gc, masterId, origins) {
  const now = Date.now();
  for (const o of origins) {
    await store.run(gc, `INSERT INTO card_origins (card_id, field, value_key, source_id, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(card_id, field, value_key) DO UPDATE SET source_id = excluded.source_id, at = excluded.at`, [masterId, o.field, o.key, o.sourceId, now]);
  }
}

async function ignorePair(gc, userId, x, y) {
  if (x === y) return;
  const [a, b] = x < y ? [x, y] : [y, x];
  await store.run(gc, 'INSERT OR IGNORE INTO card_dup_ignored (user_id, a, b) VALUES (?, ?, ?)', [userId, a, b]);
}

/**
 * Merge the cards `ids` of person `userId` into one GC contact (Nachtrag 2.3) → { masterId, mergeId }. o: { primaryId,
 * pick, mode: 'manual'|'auto'|'migrated', reason, lang }. Account cards are linked (nothing deleted at a provider);
 * other GC cards go up in the master (kept in the protocol for an undo).
 */
async function mergeCards(gc, userId, ids, o = {}) {
  const { list: entries, books } = await entriesOf(gc, userId, ids);
  if (entries.length < 2) {
    if (entries.length === 1 && (entries[0].local || o.mode !== 'manual')) return { masterId: entries[0].row.id, mergeId: null };
    throw fail('invalid', { field: 'ids' });
  }
  if (entries.length > MERGE_MAX * 2) throw fail('invalid', { field: 'ids' });
  const keep = await masterOf(gc, entries, o.primaryId);
  const book = keep ? keep.book : await gcBook(gc, userId, o.lang);
  if (!book) throw fail('not_found');
  const u = await unionOf(gc, entries, { pick: o.pick, primaryId: o.primaryId });
  const f = u.fields;
  let photo;
  if (u.photoFrom && (!keep || u.photoFrom !== keep.row.id)) photo = await cardstore.photoOf(gc, u.photoFrom);
  const stored = await cards().write(gc, book, keep ? keep.row : null, f, photo || undefined);
  const masterId = stored.id;
  const removed = [];
  const now = Date.now();
  // favourites and the main number: the best position; the master's main number while it still has it
  const fav = entries.map((e) => e.row.favorite || 0).filter((x) => x > 0);
  const mainKeys = [keep ? keep.row.main_phone : null, ...entries.map((e) => e.row.main_phone)].filter(Boolean);
  const main = mainKeys.find((k) => f.phones.some((p) => key('phones', p) === k)) || null;
  await store.run(gc, 'UPDATE cards SET favorite = ?, main_phone = ? WHERE id = ?', [fav.length ? Math.min(...fav) : 0, main, masterId]);
  for (const e of entries) {
    if (e.row.id === masterId) continue;
    // what hung on this card moves to the master: its groups, its links, the values removed from it
    await store.run(gc, 'UPDATE card_group_members SET card_id = ? WHERE card_id = ? AND group_id NOT IN (SELECT group_id FROM card_group_members WHERE card_id = ?)', [masterId, e.row.id, masterId]);
    await store.run(gc, 'DELETE FROM card_group_members WHERE card_id = ?', [e.row.id]);
    await store.run(gc, 'UPDATE cards SET link_id = ? WHERE link_id = ?', [masterId, e.row.id]);
    await store.run(gc, 'UPDATE OR IGNORE card_dismissed SET card_id = ? WHERE card_id = ?', [masterId, e.row.id]);
    await store.run(gc, 'DELETE FROM card_conflicts WHERE card_id = ?', [e.row.id]);
    await store.run(gc, 'UPDATE OR IGNORE card_origins SET card_id = ? WHERE card_id = ?', [masterId, e.row.id]);
    if (e.local) {
      // a GC card goes up in the master — only here, never at a provider; kept for an undo
      removed.push({ id: e.row.id, uid: e.row.uid, vcard: e.row.vcard, fields: e.row.fields_json, favorite: e.row.favorite || 0 });
      await cardstore.dropCard(gc, e.row);
    } else {
      await store.run(gc, 'UPDATE cards SET link_id = ?, version = ? WHERE id = ?', [masterId, await pimstore.nextCardVersion(gc, userId), e.row.id]);
    }
  }
  await store.run(gc, 'UPDATE cards SET link_id = NULL WHERE id = ?', [masterId]);
  await addOrigins(gc, masterId, u.origins.filter((x) => x.sourceId !== masterId));
  // a single field that lost (another company …) becomes a conflict at once
  await reconcile(gc, userId, masterId, { quiet: true });
  const cardsInfo = entries.map((e) => ({ id: e.row.id, name: (e.f.name || {}).display || '', addressbookId: e.row.addressbook_id, addressbook: (books.get(e.row.addressbook_id) || {}).name || '',
    source: (books.get(e.row.addressbook_id) || {}).source || 'local', removed: e.local && e.row.id !== masterId }));
  const r = await store.run(gc, 'INSERT INTO card_merges (user_id, master_id, created, mode, reason, cards_json, removed_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, masterId, keep ? 0 : 1, o.mode || 'manual', o.reason || null, JSON.stringify(cardsInfo), JSON.stringify(removed), now]);
  if (!o.quiet) await pimstore.live(gc, userId, 'contacts', { kind: 'merged', masterId, contactIds: entries.map((e) => e.row.id).slice(0, 50), auto: o.mode === 'auto' || o.mode === 'migrated' });
  return { masterId, mergeId: Number(r.lastInsertRowid) };
}

// ─── keeping the master up to date ──────────────

/**
 * Bring master `masterId` up to date with its linked cards (Nachtrag 2.4): take over what it lacks, a different value of
 * the same kind becomes a conflict, dismissed values stay away — also when the provider drops one and brings it back
 * later (Link to Windows copies the phone's contacts again); another value is a new one.
 * → { changed, conflicts }.
 */
async function reconcile(gc, userId, masterId, o = {}) {
  const m = await store.one(gc, 'SELECT * FROM cards WHERE id = ? AND user_id = ?', [masterId, userId]);
  if (!m || m.link_id) return { changed: false, conflicts: 0 };
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [m.addressbook_id]);
  if (!book || book.source !== 'local') return { changed: false, conflicts: 0 };
  const links = await store.all(gc, 'SELECT * FROM cards WHERE link_id = ? AND user_id = ? ORDER BY id', [m.id, userId]);
  const before = await store.all(gc, 'SELECT * FROM card_conflicts WHERE card_id = ?', [m.id]);
  const f = clone(fieldsOf(m));
  for (const field of LISTS) f[field] = f[field] || [];
  f.name = fullName(f.name || {});
  const dismissed = new Set((await store.all(gc, 'SELECT source_id, field, value_key FROM card_dismissed WHERE card_id = ?', [m.id])).map((r) => `${r.source_id}|${r.field}|${r.value_key}`));
  const originOf = new Map((await store.all(gc, 'SELECT field, value_key, source_id FROM card_origins WHERE card_id = ?', [m.id])).map((r) => [`${r.field}|${r.value_key}`, r.source_id]));
  const adopted = [];
  const want = new Map();
  let changed = false;
  let photo;
  for (const l of links) {
    const lf = fieldsOf(l);
    const gone = (field, k) => dismissed.has(`${l.id}|${field}|${k}`);
    for (const field of LISTS) {
      const lkeys = new Set((lf[field] || []).map((v) => key(field, v)));
      for (const v of lf[field] || []) {
        const k = key(field, v);
        if (!k || gone(field, k) || f[field].some((x) => key(field, x) === k)) continue;
        if (TYPED.includes(field)) {
          const same = f[field].filter((x) => x.type === v.type);
          if (same.length) {
            // what it replaces: the value taken over from this very card, else one this card does not have
            const rep = same.find((x) => originOf.get(`${field}|${key(field, x)}`) === l.id && !lkeys.has(key(field, x))) || same.find((x) => !lkeys.has(key(field, x))) || null;
            want.set(`${l.id}|${field}|${k}`, { source: l.id, field, type: v.type, value: v, k, replaces: rep ? key(field, rep) : null });
            continue;
          }
        }
        f[field].push(field === 'emails' ? { ...v, primary: !f.emails.length } : v);
        adopted.push({ field, key: k, sourceId: l.id });
        changed = true;
      }
    }
    for (const s of SINGLES) {
      const v = lf[s];
      if (!v) continue;
      const k = key(s, v);
      if (gone(s, k)) continue;
      if (!f[s]) { f[s] = v; adopted.push({ field: s, key: k, sourceId: l.id }); changed = true; continue; }
      if (key(s, f[s]) === k) continue;
      if (s === 'birthday' && f[s].slice(-5) === v.slice(-5)) {
        if (f[s].startsWith('--') && !v.startsWith('--')) { f[s] = v; adopted.push({ field: s, key: k, sourceId: l.id }); changed = true; }
        continue;
      }
      want.set(`${l.id}|${s}|${k}`, { source: l.id, field: s, type: null, value: v, k, replaces: key(s, f[s]) });
    }
    if (!String(f.note || '').trim() && String(lf.note || '').trim()) { f.note = lf.note; changed = true; }
    const ln = lf.name || {};
    if (f.name.given && !f.name.family && !hasEmoji(f) && ln.family && cardstore.fold(ln.given || '').trim() === cardstore.fold(f.name.given).trim()) {
      f.name.family = ln.family;
      f.name.display = [f.name.given, f.name.family].join(' ');
      changed = true;
    }
    if (!m.photo_etag && photo === undefined && l.photo_etag) { photo = await cardstore.photoOf(gc, l.id); if (photo) changed = true; else photo = undefined; }
  }
  if (changed) await cards().write(gc, book, m, f, photo);
  await addOrigins(gc, m.id, adopted);
  // origins of values the master no longer has go
  const has = new Set();
  for (const field of LISTS) for (const v of f[field]) has.add(`${field}|${key(field, v)}`);
  for (const s of SINGLES) if (f[s]) has.add(`${s}|${key(s, f[s])}`);
  for (const r of await store.all(gc, 'SELECT field, value_key FROM card_origins WHERE card_id = ?', [m.id])) {
    if (!has.has(`${r.field}|${r.value_key}`)) await store.run(gc, 'DELETE FROM card_origins WHERE card_id = ? AND field = ? AND value_key = ?', [m.id, r.field, r.value_key]);
  }
  // the conflicts: kept with their id while they stand, new ones added, settled ones gone
  const now = Date.now();
  for (const c of before) if (!want.has(`${c.source_id}|${c.field}|${c.value_key}`)) await store.run(gc, 'DELETE FROM card_conflicts WHERE id = ?', [c.id]);
  for (const c of want.values()) {
    await store.run(gc, `INSERT INTO card_conflicts (user_id, card_id, source_id, field, type, value_key, value_json, replaces_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(card_id, source_id, field, value_key) DO UPDATE SET type = excluded.type, value_json = excluded.value_json, replaces_key = excluded.replaces_key`,
    [userId, m.id, c.source, c.field, c.type, c.k, JSON.stringify(c.value), c.replaces, now]);
  }
  const conflictsMoved = before.length !== want.size || before.some((c) => !want.has(`${c.source_id}|${c.field}|${c.value_key}`));
  if (!o.quiet) {
    if (changed) await pimstore.live(gc, userId, 'contacts', { kind: 'changed', addressbookId: m.addressbook_id, contactIds: [m.id] });
    if (conflictsMoved) await pimstore.live(gc, userId, 'contacts', { kind: 'conflicts', contactIds: [m.id] });
  }
  return { changed, conflicts: want.size };
}

/** The Conflicts of master row `m` for the API. */
async function conflictsOf(gc, userId, m, ctxMaps) {
  const rows = await store.all(gc, 'SELECT * FROM card_conflicts WHERE card_id = ? ORDER BY id', [m.id]);
  if (!rows.length) return [];
  const books = (ctxMaps && ctxMaps.books) || await bookMap(gc, userId);
  const accounts = (ctxMaps && ctxMaps.accounts) || await accountMap(gc, userId);
  const f = fieldsOf(m);
  const out = [];
  for (const r of rows) {
    const src = await store.one(gc, 'SELECT id, addressbook_id FROM cards WHERE id = ?', [r.source_id]);
    if (!src) continue;
    const isList = LISTS.includes(r.field);
    const replaces = r.replaces_key ? (isList ? (f[r.field] || []).find((x) => key(r.field, x) === r.replaces_key) : (key(r.field, f[r.field]) === r.replaces_key ? f[r.field] : null)) || null : null;
    out.push({ id: r.id, field: r.field, type: r.type || null, value: parse(r.value_json, null), replaces, source: sourceView(src, books, accounts), at: r.at });
  }
  return out;
}

/** Remember value `k` of `field` as dismissed for every link of master `m` that has it. */
async function dismissEverywhere(gc, userId, m, field, k) {
  const now = Date.now();
  for (const l of await store.all(gc, 'SELECT id, fields_json FROM cards WHERE link_id = ?', [m.id])) {
    const lf = fieldsOf(l);
    const vals = LISTS.includes(field) ? (lf[field] || []) : (lf[field] ? [lf[field]] : []);
    if (vals.some((v) => key(field, v) === k)) await store.run(gc, 'INSERT OR IGNORE INTO card_dismissed (user_id, card_id, source_id, field, value_key, at) VALUES (?, ?, ?, ?, ?, ?)', [userId, m.id, l.id, field, k, now]);
  }
}

async function ownConflict(gc, userId, cardId, cid) {
  const r = Number.isSafeInteger(cid) ? await store.one(gc, 'SELECT * FROM card_conflicts WHERE id = ? AND card_id = ? AND user_id = ?', [cid, cardId, userId]) : null;
  if (!r) throw fail('not_found');
  return r;
}

/** POST cards/<id>/conflicts/<cid>/accept { mode? } → { card } — the provider's value into the GC contact (not back). */
async function accept(gc, ctx, id, cid, b) {
  const m = await cards().ownCard(gc, ctx.userId, id);
  const c = await ownConflict(gc, ctx.userId, m.id, cid);
  const mode = b && b.mode !== undefined ? b.mode : (c.replaces_key ? 'replace' : 'add');
  if (mode !== 'replace' && mode !== 'add') throw fail('invalid', { field: 'mode' });
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [m.addressbook_id]);
  const f = clone(fieldsOf(m));
  const v = parse(c.value_json, null);
  let replaced = null;
  if (LISTS.includes(c.field)) {
    f[c.field] = f[c.field] || [];
    const i = mode === 'replace' && c.replaces_key ? f[c.field].findIndex((x) => key(c.field, x) === c.replaces_key) : -1;
    if (i >= 0) { replaced = c.replaces_key; f[c.field][i] = v; } else f[c.field].push(v);
  } else {
    if (f[c.field]) replaced = key(c.field, f[c.field]);
    f[c.field] = v;
  }
  await cards().write(gc, book, m, f, undefined);
  if (replaced && replaced !== c.value_key) {
    await dismissEverywhere(gc, ctx.userId, m, c.field, replaced);
    if (c.field === 'phones' && m.main_phone === replaced) await store.run(gc, 'UPDATE cards SET main_phone = ? WHERE id = ?', [c.value_key, m.id]);
  }
  await addOrigins(gc, m.id, [{ field: c.field, key: c.value_key, sourceId: c.source_id }]);
  await store.run(gc, 'DELETE FROM card_conflicts WHERE id = ?', [c.id]);
  await reconcile(gc, ctx.userId, m.id, { quiet: true });
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'conflicts', contactIds: [m.id] });
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: m.addressbook_id, contactIds: [m.id] });
  return { card: await cards().full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [m.id])) };
}

/** POST cards/<id>/conflicts/<cid>/dismiss → { card } — the value stays away until it changes at the provider. */
async function dismiss(gc, ctx, id, cid) {
  const m = await cards().ownCard(gc, ctx.userId, id);
  const c = await ownConflict(gc, ctx.userId, m.id, cid);
  await store.run(gc, 'INSERT OR IGNORE INTO card_dismissed (user_id, card_id, source_id, field, value_key, at) VALUES (?, ?, ?, ?, ?, ?)', [ctx.userId, m.id, c.source_id, c.field, c.value_key, Date.now()]);
  await store.run(gc, 'DELETE FROM card_conflicts WHERE id = ?', [c.id]);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'conflicts', contactIds: [m.id] });
  return { card: await cards().full(gc, ctx.userId, m) };
}

/** GET cards/conflicts → { items: [{ card, conflicts }] } */
async function conflicts(gc, ctx) {
  const ids = (await store.all(gc, 'SELECT DISTINCT card_id FROM card_conflicts WHERE user_id = ? ORDER BY card_id LIMIT 500', [ctx.userId])).map((r) => r.card_id);
  const prefs = await pimstore.cardPrefs(gc, ctx.userId);
  const maps = { books: await bookMap(gc, ctx.userId), accounts: await accountMap(gc, ctx.userId) };
  const items = [];
  for (const id of ids) {
    const m = await store.one(gc, 'SELECT * FROM cards WHERE id = ? AND user_id = ?', [id, ctx.userId]);
    if (!m) continue;
    const list = await conflictsOf(gc, ctx.userId, m, maps);
    if (list.length) items.push({ card: (await cards().summaries(gc, ctx.userId, [m], prefs))[0], conflicts: list });
  }
  return { items };
}

// ─── the person changes the master ──────────────

/**
 * A change of master `m` (old fields `old`, new fields `f`; Nachtrag 2.5): values that linked cards have and the
 * change removes are dismissed for them; a value taken over from a linked card (card_origins) that the person changes
 * or removes is written back to exactly that card at its provider (when its address book is writable).
 * → [{ id, addressbookId, ok, code? }].
 */
async function afterMasterChange(gc, userId, m, old, f) {
  const links = await store.all(gc, 'SELECT * FROM cards WHERE link_id = ? AND user_id = ?', [m.id, userId]);
  if (!links.length) return [];
  const origins = await store.all(gc, 'SELECT * FROM card_origins WHERE card_id = ?', [m.id]);
  const originOf = (field, k) => (origins.find((o) => o.field === field && o.value_key === k) || {}).source_id || null;
  const edits = new Map(); // linked card id → its new fields
  const editOf = (id) => { if (!edits.has(id)) { const l = links.find((x) => x.id === id); edits.set(id, clone(fieldsOf(l))); } return edits.get(id); };
  const newOrigins = [];
  for (const field of LISTS) {
    const oldList = old[field] || [];
    const newList = f[field] || [];
    const newKeys = new Set(newList.map((v) => key(field, v)));
    const oldKeys = new Set(oldList.map((v) => key(field, v)));
    const added = newList.filter((v) => !oldKeys.has(key(field, v)));
    for (const v of oldList) {
      const k = key(field, v);
      if (!k || newKeys.has(k)) continue;
      await dismissEverywhere(gc, userId, m, field, k);
      const src = originOf(field, k);
      if (!src || !links.some((l) => l.id === src)) continue;
      const lf = editOf(src);
      const i = (lf[field] || []).findIndex((x) => key(field, x) === k);
      if (i < 0) continue;
      // changed (a new value of the same kind came) or removed
      const j = added.findIndex((x) => !TYPED.includes(field) || x.type === v.type);
      if (j >= 0) {
        const nv = added.splice(j, 1)[0];
        lf[field][i] = field === 'emails' ? { ...nv, primary: lf[field][i].primary } : nv;
        newOrigins.push({ field, key: key(field, nv), sourceId: src });
      } else lf[field].splice(i, 1);
    }
  }
  for (const s of SINGLES) {
    const ok = key(s, old[s]);
    if (!ok || ok === key(s, f[s])) continue;
    await dismissEverywhere(gc, userId, m, s, ok);
    const src = originOf(s, ok);
    if (!src || !links.some((l) => l.id === src)) continue;
    editOf(src)[s] = f[s] || null;
    if (f[s]) newOrigins.push({ field: s, key: key(s, f[s]), sourceId: src });
  }
  const out = [];
  for (const [id, lf] of edits) {
    const l = links.find((x) => x.id === id);
    const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [l.addressbook_id]);
    try {
      if (!book || book.writable !== 1) throw fail('read_only');
      await cards().write(gc, book, l, lf, undefined);
      await addOrigins(gc, m.id, newOrigins.filter((o) => o.sourceId === id));
      out.push({ id, addressbookId: l.addressbook_id, ok: true });
    } catch (e) {
      out.push({ id, addressbookId: l.addressbook_id, ok: false, code: (e && e.code) || 'error' });
    }
  }
  return out;
}

// ─── undo ───────────────────────────────────────

/** A GC card that went up in a merge (its snapshot `r`) back into address book `book` → the row | null. */
async function restore(gc, book, r) {
  try {
    const comp = r.vcard ? vcard.parseAll(r.vcard)[0] : null;
    const taken = await store.one(gc, 'SELECT 1 AS x FROM cards WHERE addressbook_id = ? AND uid = ?', [book.id, r.uid]);
    const uid = taken || !r.uid ? vcard.newUid() : r.uid;
    if (comp) comp.updatePropertyWithValue('uid', uid);
    const fields = comp ? vcard.fieldsOf(comp) : parse(r.fields, {});
    const c = await cardstore.storeCard(gc, book, { uid, fields, vcard: comp ? vcard.toText(comp, null) : null });
    if (r.favorite) await store.run(gc, 'UPDATE cards SET favorite = ? WHERE id = ?', [r.favorite, c.id]);
    return c;
  } catch { return null; }
}

/**
 * Loosen the linked cards `ids` (all when null) of master `m` (Nachtrag 2.8) → { card, unlinked, restored }. When no
 * link is left: the GC cards that went up in its merges come back, and a master the merges created goes (unless
 * `keepMaster`). The pairs are kept apart from now on (card_dup_ignored).
 */
async function loosen(gc, userId, m, ids, keepMaster, lang) {
  const links = await store.all(gc, 'SELECT * FROM cards WHERE link_id = ? AND user_id = ?', [m.id, userId]);
  const targets = ids ? links.filter((l) => ids.includes(l.id)) : links;
  if (ids && targets.length !== ids.length) throw fail('not_found');
  for (const t of targets) {
    await store.run(gc, 'UPDATE cards SET link_id = NULL, version = ? WHERE id = ?', [await pimstore.nextCardVersion(gc, userId), t.id]);
    for (const tb of ['card_dismissed', 'card_conflicts', 'card_origins']) await store.run(gc, `DELETE FROM ${tb} WHERE card_id = ? AND source_id = ?`, [m.id, t.id]);
    await ignorePair(gc, userId, m.id, t.id);
  }
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) await ignorePair(gc, userId, targets[i].id, targets[j].id);
  const left = links.length - targets.length;
  const restored = [];
  let card = m;
  if (!left) {
    const merges = await store.all(gc, 'SELECT * FROM card_merges WHERE master_id = ? AND user_id = ? AND undone_at IS NULL ORDER BY id', [m.id, userId]);
    const book = await gcBook(gc, userId, lang);
    for (const mg of merges) {
      for (const r of parse(mg.removed_json, [])) {
        const c = await restore(gc, book, r);
        if (!c) continue;
        restored.push(c.id);
        await ignorePair(gc, userId, c.id, m.id);
        for (const t of targets) await ignorePair(gc, userId, c.id, t.id);
      }
      await store.run(gc, 'UPDATE card_merges SET undone_at = ? WHERE id = ?', [Date.now(), mg.id]);
    }
    if (merges.some((mg) => mg.created === 1) && !keepMaster) { await cardstore.dropCard(gc, m); card = null; }
  }
  await pimstore.live(gc, userId, 'contacts', { kind: 'merged', masterId: card ? m.id : null, contactIds: [m.id, ...targets.map((t) => t.id), ...restored].slice(0, 50), auto: false });
  return { card: card ? await cards().full(gc, userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [m.id])) : null, unlinked: targets.map((t) => t.id), restored };
}

/** POST cards/<id>/unmerge { ids?, keepMaster? } */
async function unmerge(gc, ctx, id, b) {
  const m = await cards().ownCard(gc, ctx.userId, id);
  const ids = b && Array.isArray(b.ids) ? [...new Set(b.ids.map(posInt).filter(Boolean))] : null;
  return loosen(gc, ctx.userId, m, ids && ids.length ? ids : null, !!(b && b.keepMaster), ctx.lang);
}

/** POST cards/merges/<id>/undo { keepMaster? } */
async function undo(gc, ctx, id, b) {
  const mg = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM card_merges WHERE id = ? AND user_id = ?', [id, ctx.userId]) : null;
  if (!mg || mg.undone_at) throw fail('not_found');
  const m = await store.one(gc, 'SELECT * FROM cards WHERE id = ? AND user_id = ?', [mg.master_id, ctx.userId]);
  if (!m) throw fail('not_found');
  const mine = parse(mg.cards_json, []).filter((x) => !x.removed && x.id !== m.id).map((x) => x.id);
  const linked = (await store.all(gc, 'SELECT id FROM cards WHERE link_id = ?', [m.id])).map((r) => r.id);
  const ids = mine.filter((x) => linked.includes(x));
  if (ids.length && ids.length < linked.length) {
    // other merges stay: only this one's cards are loosened, its GC cards come back
    const r = await loosen(gc, ctx.userId, m, ids, true, ctx.lang);
    const book = await gcBook(gc, ctx.userId, ctx.lang);
    for (const x of parse(mg.removed_json, [])) {
      const c = await restore(gc, book, x);
      if (!c) continue;
      r.restored.push(c.id);
      await ignorePair(gc, ctx.userId, c.id, m.id);
    }
    await store.run(gc, 'UPDATE card_merges SET undone_at = ? WHERE id = ?', [Date.now(), mg.id]);
    return r;
  }
  return loosen(gc, ctx.userId, m, null, !!(b && b.keepMaster), ctx.lang);
}

/** GET cards/merges?limit= → { items: [Merge] } */
async function merges(gc, ctx, q) {
  const limit = Math.min(Math.max(posInt(q.limit) || 50, 1), 200);
  const rows = await store.all(gc, 'SELECT * FROM card_merges WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?', [ctx.userId, limit]);
  return { items: rows.map((r) => ({ id: r.id, masterId: r.master_id, mode: r.mode, created: r.created === 1, reason: r.reason || null, at: r.at, undoneAt: r.undone_at || null, cards: parse(r.cards_json, []) })) };
}

// ─── duplicates, certain ones, automatic ────────

/**
 * The duplicate groups of the person over the shown entries (a master stands for its links): → [{ reason, key,
 * ids (entry ids), certain }]. `scope`: only groups touching these card ids.
 */
async function groupsOf(gc, userId, scope) {
  const cfg = await config.get(gc);
  const { rows: bookRows } = await cards().books(gc, cfg, userId);
  const visible = new Set(bookRows.filter((b) => b.visible === 1).map((b) => b.id));
  if (!visible.size) return { groups: [], entries: new Map() };
  const all = await store.all(gc, 'SELECT id, addressbook_id, link_id, fields_json FROM cards WHERE user_id = ? LIMIT 50000', [userId]);
  const entryOf = new Map();
  const entries = new Map();
  for (const r of all) if (!r.link_id && visible.has(r.addressbook_id)) { entries.set(r.id, fieldsOf(r)); entryOf.set(r.id, r.id); }
  for (const r of all) if (r.link_id && entries.has(r.link_id)) entryOf.set(r.id, r.link_id);
  const ignored = new Set((await store.all(gc, 'SELECT a, b FROM card_dup_ignored WHERE user_id = ?', [userId])).map((r) => `${r.a}:${r.b}`));
  const isIgnored = (x, y) => ignored.has(x < y ? `${x}:${y}` : `${y}:${x}`);
  const index = new Map(); // 'email|…' / 'phone|…' → Set of entry ids
  const put = (k, e) => { if (!index.has(k)) index.set(k, new Set()); index.get(k).add(e); };
  for (const r of all) {
    const e = entryOf.get(r.id);
    if (!e) continue;
    const f = r.id === e ? entries.get(e) : fieldsOf(r);
    for (const m of f.emails || []) { const k = key('emails', m); if (k) put(`email|${k}`, e); }
    for (const p of f.phones || []) { const k = vcard.digits(p.value); if (k) put(`phone|${k}`, e); }
  }
  for (const [e, f] of entries) {
    if ((f.emails || []).length) continue;
    const d = cardstore.fold((f.name || {}).display || '').trim();
    if (d) put(`name|${d}`, e);
  }
  const groups = [];
  const seen = new Set();
  for (const [k, set] of index) {
    if (set.size < 2) continue;
    const reason = k.startsWith('email|') ? 'email' : k.startsWith('phone|') ? 'phone' : 'name';
    const ids = [...set].sort((a, b) => a - b);
    // pairs kept apart by the person do not count
    const ok = ids.filter((x) => ids.some((y) => y !== x && !isIgnored(x, y)));
    if (ok.length < 2) continue;
    const sig = ok.join('-');
    if (seen.has(sig)) continue;
    seen.add(sig);
    if (scope && !ok.some((x) => scope.has(x))) continue;
    let certain = reason !== 'name' && ok.length <= MERGE_MAX;
    for (let i = 0; certain && i < ok.length; i++) for (let j = i + 1; certain && j < ok.length; j++) if (isIgnored(ok[i], ok[j]) || !similar(entries.get(ok[i]), entries.get(ok[j]))) certain = false;
    groups.push({ reason, key: sig, ids: ok.slice(0, MERGE_MAX), certain });
  }
  return { groups, entries, isIgnored };
}

/** The certain groups joined over shared cards (a component of certain pairs, 2…10, no pair kept apart). */
function components(groups, isIgnored) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const reasons = new Map();
  for (const g of groups) {
    if (!g.certain) continue;
    for (const x of g.ids) if (!parent.has(x)) parent.set(x, x);
    for (const x of g.ids.slice(1)) parent.set(find(x), find(g.ids[0]));
  }
  for (const g of groups) if (g.certain) reasons.set(find(g.ids[0]), reasons.get(find(g.ids[0])) || g.reason);
  const comps = new Map();
  for (const x of parent.keys()) { const r = find(x); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(x); }
  const out = [];
  for (const [r, ids] of comps) {
    if (ids.length < 2 || ids.length > MERGE_MAX) continue;
    let apart = false;
    for (let i = 0; !apart && i < ids.length; i++) for (let j = i + 1; !apart && j < ids.length; j++) if (isIgnored(ids[i], ids[j])) apart = true;
    if (!apart) out.push({ ids: ids.sort((a, b) => a - b), reason: reasons.get(r) || 'email' });
  }
  return out;
}

/** Merge the certain duplicates of the person (`scope`: only those touching these card ids) → [mergeId]. */
async function autoMerge(gc, userId, scope, lang) {
  const { groups, isIgnored } = await groupsOf(gc, userId, scope ? new Set(scope) : null);
  const done = [];
  for (const c of components(groups, isIgnored || (() => false))) {
    try {
      const r = await mergeCards(gc, userId, c.ids, { mode: 'auto', reason: c.reason, lang });
      if (r.mergeId) done.push(r.mergeId);
    } catch (e) {
      if (e && e.code === 'limit') break;
      gc.log.warn('contacts auto merge failed', userId, (e && e.code) || 'error');
    }
  }
  return done;
}

/** POST cards/merge/auto → { merged, open, items } */
async function autoNow(gc, ctx) {
  const ids = await autoMerge(gc, ctx.userId, null, ctx.lang);
  const open = (await groupsOf(gc, ctx.userId, null)).groups.length;
  const rows = ids.length ? await store.all(gc, `SELECT * FROM card_merges WHERE id IN (${store.marks(ids.length)}) ORDER BY id`, ids) : [];
  return { merged: ids.length, open, items: rows.map((r) => ({ id: r.id, masterId: r.master_id, mode: r.mode, created: r.created === 1, reason: r.reason || null, at: r.at, undoneAt: null, cards: parse(r.cards_json, []) })) };
}

/** The preview of merging `ids` (nothing stored) → Preview. */
async function previewOf(gc, userId, ids, maps) {
  const { list, books } = await entriesOf(gc, userId, ids);
  const keep = await masterOf(gc, list, null);
  const u = await unionOf(gc, list, {});
  const accounts = (maps && maps.accounts) || await accountMap(gc, userId);
  const f = u.fields;
  return {
    id: keep ? keep.row.id : null, name: f.name, emails: f.emails, phones: f.phones, company: f.company, department: f.department, title: f.title, addresses: f.addresses,
    birthday: f.birthday, note: f.note, urls: f.urls, mainPhone: mainPhoneOf(f, null), photoFrom: u.photoFrom,
    sources: list.map((e) => sourceView(e.row, books, accounts)),
    conflicts: u.singleLosers.map((x) => ({ field: x.field, value: x.value, source: sourceView(list.find((e) => e.row.id === x.sourceId).row, books, accounts) })),
  };
}

/** POST cards/merge/preview { ids } → { preview } */
async function preview(gc, ctx, b) {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(posInt).filter(Boolean))] : [];
  if (ids.length < 2 || ids.length > MERGE_MAX) throw fail('invalid', { field: 'ids' });
  return { preview: await previewOf(gc, ctx.userId, ids) };
}

/** GET cards/duplicates?details=1 → { items: [{ key, reason, certain, cards, details?, preview? }] } (uncertain ones first) */
async function duplicates(gc, ctx, q) {
  const prefs = await pimstore.cardPrefs(gc, ctx.userId);
  const { groups } = await groupsOf(gc, ctx.userId, null);
  const details = q && (q.details === '1' || q.details === 'true');
  const maps = details ? { books: await bookMap(gc, ctx.userId), accounts: await accountMap(gc, ctx.userId) } : null;
  const sorted = [...groups.filter((g) => !g.certain), ...groups.filter((g) => g.certain)].slice(0, 200);
  const items = [];
  for (const g of sorted) {
    const rows = [];
    for (const part of store.chunks(g.ids, 80)) rows.push(...await store.all(gc, `SELECT * FROM cards WHERE id IN (${store.marks(part.length)}) AND user_id = ? ORDER BY id`, [...part, ctx.userId]));
    if (rows.length < 2) continue;
    const item = { key: g.key, reason: g.reason, certain: g.certain, cards: await cards().summaries(gc, ctx.userId, rows, prefs) };
    if (details) {
      item.details = [];
      for (const r of rows) item.details.push({ card: await cards().full(gc, ctx.userId, r), source: sourceView(r, maps.books, maps.accounts) });
      try { item.preview = await previewOf(gc, ctx.userId, rows.map((r) => r.id), maps); } catch { item.preview = null; }
    }
    items.push(item);
  }
  return { items };
}

// ─── after a sync, the one run after the update ─

/** After a sync / an import changed cards `ids` of the person: their masters up to date, new certain duplicates merged. */
async function afterSync(gc, userId, ids) {
  if (!ids || !ids.length) return;
  if (!(await migrated(gc, userId))) { idleUntil = 0; return; }
  const cfg = await config.get(gc);
  if (!cfg.contacts.enabled) return;
  const masters = new Set();
  for (const part of store.chunks([...new Set(ids)], 80)) {
    for (const r of await store.all(gc, `SELECT link_id FROM cards WHERE id IN (${store.marks(part.length)}) AND link_id IS NOT NULL`, part)) masters.add(r.link_id);
  }
  for (const m of masters) { try { await reconcile(gc, userId, m); } catch (e) { gc.log.warn('contacts reconcile failed', userId, (e && e.code) || 'error'); } }
  const loose = [];
  for (const part of store.chunks([...new Set(ids)], 80)) {
    for (const r of await store.all(gc, `SELECT id FROM cards WHERE id IN (${store.marks(part.length)}) AND link_id IS NULL`, part)) loose.push(r.id);
  }
  if (loose.length) await autoMerge(gc, userId, loose);
}

/**
 * The person's one run after the update (Nachtrag 2.6): old links with an account card as the main one become a GC
 * master, the GC masters take over from their links, the certain duplicates are merged; a protocol.
 */
async function migrate(gc, userId) {
  const stats = { migrated: 0, reconciled: 0, merged: 0, conflicts: 0 };
  const olds = await store.all(gc, `SELECT DISTINCT p.id FROM cards c JOIN cards p ON p.id = c.link_id JOIN addressbooks b ON b.id = p.addressbook_id
    WHERE c.user_id = ? AND b.source <> 'local' AND p.link_id IS NULL`, [userId]);
  for (const o of olds) {
    try { await mergeCards(gc, userId, [o.id], { mode: 'migrated', reason: 'link', quiet: true }); stats.migrated++; } catch (e) { gc.log.warn('contacts link migration failed', userId, (e && e.code) || 'error'); }
  }
  const masters = await store.all(gc, `SELECT DISTINCT c.link_id AS id FROM cards c JOIN cards m ON m.id = c.link_id JOIN addressbooks b ON b.id = m.addressbook_id WHERE c.user_id = ? AND b.source = 'local'`, [userId]);
  for (const m of masters) { try { const r = await reconcile(gc, userId, m.id, { quiet: true }); stats.reconciled++; stats.conflicts += r.conflicts; } catch { /* the next sync again */ } }
  await store.run(gc, `INSERT INTO card_runs (user_id, master_at, stats_json) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET master_at = excluded.master_at`, [userId, Date.now(), '{}']);
  stats.merged = (await autoMerge(gc, userId, null)).length;
  stats.open = (await groupsOf(gc, userId, null)).groups.length;
  await store.run(gc, 'UPDATE card_runs SET stats_json = ? WHERE user_id = ?', [JSON.stringify(stats), userId]);
  gc.log.info('contacts merged', userId, JSON.stringify(stats));
  await pimstore.live(gc, userId, 'contacts', { kind: 'addressbooks' });
  return stats;
}

let idleUntil = 0;   // nobody waits for the run: no look again before this (a new person's first sync clears it)

/** The background run: one person per run whose contacts were not yet brought into the master model. */
async function tick(gc, skipUsers = new Set(), now = Date.now()) {
  const cfg = await config.get(gc);
  if (!cfg.contacts.enabled || now < idleUntil) return 0;
  const rows = await store.all(gc, `SELECT DISTINCT c.user_id FROM cards c LEFT JOIN card_runs r ON r.user_id = c.user_id WHERE r.master_at IS NULL ORDER BY c.user_id LIMIT 20`);
  const u = rows.find((r) => !skipUsers.has(r.user_id));
  if (!u) { idleUntil = now + 5 * 60000; return 0; }
  try { await migrate(gc, u.user_id); } catch (e) {
    gc.log.warn('contacts merge run failed', u.user_id, (e && e.code) || 'error');
    await store.run(gc, `INSERT INTO card_runs (user_id, master_at, stats_json) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET master_at = excluded.master_at`, [u.user_id, Date.now(), '{"failed":true}']);
  }
  return 1;
}

// ─── favourites ─────────────────────────────────

/** Card `id` a favourite or not (the end of the row; positions stay without gaps). */
async function setFavorite(gc, userId, c, on) {
  if (on && !(c.favorite > 0)) {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n, MAX(favorite) AS mx FROM cards WHERE user_id = ? AND favorite > 0', [userId]);
    if (n.n >= FAVORITES_MAX) throw fail('limit', { max: FAVORITES_MAX });
    await store.run(gc, 'UPDATE cards SET favorite = ? WHERE id = ?', [(n.mx || 0) + 1, c.id]);
  } else if (!on && c.favorite > 0) {
    await store.run(gc, 'UPDATE cards SET favorite = 0 WHERE id = ?', [c.id]);
    const rest = await store.all(gc, 'SELECT id FROM cards WHERE user_id = ? AND favorite > 0 ORDER BY favorite, id', [userId]);
    for (let i = 0; i < rest.length; i++) await store.run(gc, 'UPDATE cards SET favorite = ? WHERE id = ?', [i + 1, rest[i].id]);
  } else return false;
  return true;
}

async function favoriteItems(gc, userId) {
  const rows = await store.all(gc, 'SELECT * FROM cards WHERE user_id = ? AND favorite > 0 AND link_id IS NULL ORDER BY favorite, id', [userId]);
  const prefs = await pimstore.cardPrefs(gc, userId);
  const sums = await cards().summaries(gc, userId, rows, prefs);
  return rows.map((r, i) => {
    const f = fieldsOf(r);
    const p = mainPhoneOf(f, r.main_phone);
    return { id: r.id, name: sums[i].name, photo: !!r.photo_etag, photoEtag: r.photo_etag || null, phone: p ? { value: p.value, type: p.type } : null, email: ((f.emails || [])[0] || {}).value || null };
  });
}

/** GET cards/favorites → { items } */
async function favorites(gc, ctx) {
  return { items: await favoriteItems(gc, ctx.userId) };
}

/** PUT cards/favorites { ids } → { items } — the order; cards not named are no favourites any more. */
async function putFavorites(gc, ctx, b) {
  if (!Array.isArray(b.ids) || b.ids.length > FAVORITES_MAX) throw fail('invalid', { field: 'ids' });
  const ids = [...new Set(b.ids.map(posInt).filter(Boolean))];
  for (const id of ids) { const c = await cards().ownCard(gc, ctx.userId, id); if (c.link_id) throw fail('invalid', { field: 'ids' }); }
  await store.run(gc, 'UPDATE cards SET favorite = 0 WHERE user_id = ? AND favorite > 0', [ctx.userId]);
  for (let i = 0; i < ids.length; i++) await store.run(gc, 'UPDATE cards SET favorite = ? WHERE id = ?', [i + 1, ids[i]]);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'favorites' });
  return { items: await favoriteItems(gc, ctx.userId) };
}

const reset = () => { idleUntil = 0; };

module.exports = {
  reset, hasEmoji, similar, nameWords, mainPhoneOf, unionOf, mergeCards, reconcile, conflictsOf, accept, dismiss, conflicts, afterMasterChange, unmerge, undo,
  merges, groupsOf, components, autoMerge, autoNow, preview, previewOf, duplicates, afterSync, migrate, migrated, tick, setFavorite, favorites, putFavorites,
  sourceView, bookMap, accountMap, LISTS, SINGLES, MERGE_MAX, FAVORITES_MAX,
};
