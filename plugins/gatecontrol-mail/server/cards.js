'use strict';

// The contacts of a person (C3 „Kontakte“, path `cards`; `contacts` stays the suggestions while writing): the own
// address book „Meine Kontakte“ (vCard), the address books of the accounts (Graph, CardDAV; Gmail: import a vCard
// file), search, groups (GateControl's own distribution lists, across sources), „Als Kontakt speichern“ from a mail,
// duplicates (merge in one address book, link across them), the sender view, vCard import and export.

const store = require('./store');
const config = require('./config');
const engine = require('./engine');
const ai = require('./ai');
const vcard = require('./vcard');
const pimstore = require('./pimstore');
const cardstore = require('./cardstore');
const pimgraph = require('./pimgraph');
const pimdav = require('./pimdav');
const pim = require('./pim');
const mailstore = require('./mailstore');
const { fail, parse, clip, line, posInt, email, COLOR_RE } = require('./util');

const LIMIT = 200;
const GROUPS_MAX = 200;
const MEMBERS_MAX = 500;
const IMPORT_MAX = 5 * 1024 * 1024;
const MERGE_MAX = 10;
const SIGNATURE_LINES = 12;

// ─── address books ──────────────────────────────

async function accountsOf(gc, userId) {
  return new Map((await store.all(gc, 'SELECT * FROM accounts WHERE user_id = ?', [userId])).map((a) => [a.id, a]));
}

/** The address books the person sees (account ones only while synced). */
async function books(gc, cfg, userId) {
  const accounts = await accountsOf(gc, userId);
  const rows = (await pimstore.addressbooksOf(gc, userId)).filter((b) => {
    if (b.account_id == null) return true;
    const a = accounts.get(b.account_id);
    return cfg.contacts.accounts && !!(a && a.contacts_sync !== 0);
  });
  return { rows, accounts };
}

function bookView(b, count) {
  return {
    id: b.id, source: b.source, accountId: b.account_id || null, name: b.name, writable: b.writable === 1, visible: b.visible === 1, isDefault: b.is_default === 1 && b.source === 'local',
    count, state: b.source === 'local' ? 'ok' : b.state, error: b.error_code ? { code: b.error_code, at: b.error_at } : null, syncedAt: b.synced_at || null,
  };
}

async function groupsView(gc, userId) {
  const rows = await store.all(gc, `SELECT g.*, (SELECT COUNT(*) FROM card_group_members m WHERE m.group_id = g.id) AS n FROM card_groups g WHERE g.user_id = ? ORDER BY g.name COLLATE NOCASE, g.id`, [userId]);
  return rows.map((g) => ({ id: g.id, name: g.name, color: g.color || null, count: g.n }));
}

/** GET addressbooks → { items, groups, prefs } */
async function addressbooks(gc, ctx) {
  const cfg = await config.get(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  pim.opened(gc, ctx.userId, 'contacts');
  const { rows } = await books(gc, cfg, ctx.userId);
  const counts = new Map((await store.all(gc, 'SELECT addressbook_id, COUNT(*) AS n FROM cards WHERE user_id = ? GROUP BY addressbook_id', [ctx.userId])).map((r) => [r.addressbook_id, r.n]));
  return { items: rows.map((b) => bookView(b, counts.get(b.id) || 0)), groups: await groupsView(gc, ctx.userId), prefs: await pimstore.cardPrefs(gc, ctx.userId) };
}

/** PATCH addressbooks/<id> { visible?, name? } → { addressbook } */
async function patchBook(gc, ctx, id, b) {
  const book = await pimstore.ownBook(gc, ctx.userId, id);
  if (b.visible !== undefined) { if (typeof b.visible !== 'boolean') throw fail('invalid', { field: 'visible' }); await store.run(gc, 'UPDATE addressbooks SET visible = ? WHERE id = ?', [b.visible ? 1 : 0, book.id]); }
  if (b.name !== undefined) {
    const n = clip(line(typeof b.name === 'string' ? b.name : ''), 80);
    if (!n) throw fail('invalid', { field: 'name' });
    await store.run(gc, 'UPDATE addressbooks SET name = ? WHERE id = ?', [n, book.id]);
  }
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM cards WHERE addressbook_id = ?', [book.id]);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'addressbooks' });
  return { addressbook: bookView(await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [book.id]), n.n) };
}

/** PUT cards/settings { sort?, show?, defaultAddressbookId?, birthdays? } → { prefs } */
async function settings(gc, ctx, b) {
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const p = await pimstore.cardPrefs(gc, ctx.userId);
  const bad = (field) => { throw fail('invalid', { field }); };
  if (b.sort !== undefined) { if (b.sort !== 'family' && b.sort !== 'given') bad('sort'); p.sort = b.sort; }
  if (b.show !== undefined) { if (b.show !== 'given_family' && b.show !== 'family_given') bad('show'); p.show = b.show; }
  if (b.birthdays !== undefined) { if (typeof b.birthdays !== 'boolean') bad('birthdays'); p.birthdays = b.birthdays; }
  if (b.defaultAddressbookId !== undefined) {
    const book = await pimstore.ownBook(gc, ctx.userId, posInt(b.defaultAddressbookId));
    if (book.writable !== 1) bad('defaultAddressbookId');
    p.defaultAddressbookId = book.id;
  }
  await pimstore.saveCardPrefs(gc, ctx.userId, p);
  return { prefs: p };
}

// ─── views ──────────────────────────────────────

/** The person each address belongs to (another GateControl person with a Mail account) → Map email → userId. */
async function gcPeople(gc, userId, emails) {
  const out = new Map();
  for (const part of store.chunks([...new Set(emails)], 80)) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT email, MIN(user_id) AS user_id FROM accounts WHERE user_id <> ? AND email IN (${store.marks(part.length)}) GROUP BY email`, [userId, ...part])) out.set(r.email, r.user_id);
  }
  return out;
}

const nameShown = (f, show) => {
  const n = f.name || {};
  if (!n.given && !n.family) return n.display || f.company || ((f.emails || [])[0] || {}).value || '';
  return show === 'family_given' ? [n.family, n.given].filter(Boolean).join(', ') : [n.given, n.family].filter(Boolean).join(' ');
};

/** Card rows → CardSummaries (linked ones under their primary). */
async function summaries(gc, userId, rows, prefs) {
  const ids = rows.map((r) => r.id);
  const groups = new Map();
  const linked = new Map();
  for (const part of store.chunks(ids, 80)) {
    if (!part.length) continue;
    for (const g of await store.all(gc, `SELECT card_id, group_id FROM card_group_members WHERE card_id IN (${store.marks(part.length)})`, part)) {
      if (!groups.has(g.card_id)) groups.set(g.card_id, []);
      groups.get(g.card_id).push(g.group_id);
    }
    for (const l of await store.all(gc, `SELECT id, link_id FROM cards WHERE link_id IN (${store.marks(part.length)})`, part)) {
      if (!linked.has(l.link_id)) linked.set(l.link_id, []);
      linked.get(l.link_id).push(l.id);
    }
  }
  const emails = rows.flatMap((r) => (parse(r.fields_json, {}).emails || []).map((e) => e.value));
  const people = await gcPeople(gc, userId, emails);
  return rows.map((r) => {
    const f = parse(r.fields_json, {});
    const key = cardstore.sortKeyOf(f, prefs.sort);
    const em = (f.emails || []).map((e) => e.value);
    return {
      id: r.id, addressbookId: r.addressbook_id, name: nameShown(f, prefs.show), sortKey: key, letter: cardstore.letterOf(key), company: f.company || null, title: f.title || null,
      emails: em.slice(0, 3), phone: ((f.phones || [])[0] || {}).value || null, photo: !!r.photo_etag, photoEtag: r.photo_etag || null, groups: groups.get(r.id) || [],
      linked: linked.get(r.id) || [], gcUserId: em.map((e) => people.get(e)).find(Boolean) || null, updatedAt: r.updated_at,
    };
  });
}

/** The API's etag of a card. */
const etagOf = (c) => `"${c.version}"`;

/** A card row → the full Card (linked ones' fields joined in; `readOnly` from its address book). */
async function full(gc, userId, c) {
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [c.addressbook_id]);
  const f = parse(c.fields_json, {});
  const links = await store.all(gc, 'SELECT * FROM cards WHERE link_id = ? AND user_id = ?', [c.id, userId]);
  // the values of the linked cards joined in — but not the ones the person removed from this contact (1.3.6)
  const gone = links.length ? await dismissedOf(gc, c.id) : new Set();
  const merged = { ...f };
  const key = cardstore.valueKey;
  for (const l of links) {
    const lf = parse(l.fields_json, {});
    const keep = (field) => (v) => !gone.has(`${l.id}|${field}|${key(field, v)}`);
    merged.emails = uniq([...(merged.emails || []), ...(lf.emails || []).filter(keep('emails'))], (e) => key('emails', e));
    merged.phones = uniq([...(merged.phones || []), ...(lf.phones || []).filter(keep('phones'))], (p) => key('phones', p));
    merged.addresses = uniq([...(merged.addresses || []), ...(lf.addresses || []).filter(keep('addresses'))], (a) => key('addresses', a));
    for (const k of SINGLE_FIELDS) if (!merged[k] && lf[k] && keep(k)(lf[k])) merged[k] = lf[k];
  }
  const groups = (await store.all(gc, 'SELECT group_id FROM card_group_members WHERE card_id = ?', [c.id])).map((r) => r.group_id);
  const people = await gcPeople(gc, userId, (merged.emails || []).map((e) => e.value));
  const bookOf = new Map();
  for (const l of links) { if (!bookOf.has(l.addressbook_id)) bookOf.set(l.addressbook_id, await store.one(gc, 'SELECT source FROM addressbooks WHERE id = ?', [l.addressbook_id])); }
  return {
    id: c.id, addressbookId: c.addressbook_id, source: book ? book.source : 'local', readOnly: !book || book.writable !== 1, etag: etagOf(c),
    name: { display: f.name ? f.name.display || '' : '', given: (f.name && f.name.given) || '', family: (f.name && f.name.family) || '', middle: (f.name && f.name.middle) || null,
      prefix: (f.name && f.name.prefix) || null, suffix: (f.name && f.name.suffix) || null, nickname: (f.name && f.name.nickname) || null },
    emails: merged.emails || [], phones: merged.phones || [], company: merged.company || null, department: merged.department || null, title: merged.title || null,
    addresses: merged.addresses || [], birthday: merged.birthday || null, note: f.note || '', urls: f.urls || [],
    photo: c.photo_etag ? { etag: c.photo_etag, mime: ((await store.one(gc, 'SELECT mime FROM card_photos WHERE card_id = ?', [c.id])) || {}).mime || 'image/jpeg' } : null,
    groups, linked: links.map((l) => ({ id: l.id, addressbookId: l.addressbook_id, source: (bookOf.get(l.addressbook_id) || {}).source || 'local' })),
    gcUserId: [...people.values()][0] || null, updatedAt: c.updated_at,
  };
}

const LIST_FIELDS = ['emails', 'phones', 'addresses'];
const SINGLE_FIELDS = ['company', 'department', 'title', 'birthday'];

/** The values of linked cards the person removed from card `cardId` → Set of 'sourceId|field|valueKey'. */
async function dismissedOf(gc, cardId) {
  return new Set((await store.all(gc, 'SELECT source_id, field, value_key FROM card_dismissed WHERE card_id = ?', [cardId])).map((r) => `${r.source_id}|${r.field}|${r.value_key}`));
}

/**
 * A change `ch` (vcard.check) of card `c`, whose view joins in its linked cards: every value of a linked card that the
 * change leaves out is remembered as removed, so the view does not bring it back (the linked card at its provider stays
 * as it is). A value the person adds again is no longer removed.
 */
async function rememberRemoved(gc, userId, c, ch) {
  const links = await store.all(gc, 'SELECT id, fields_json FROM cards WHERE link_id = ? AND user_id = ?', [c.id, userId]);
  if (!links.length) return;
  const key = cardstore.valueKey;
  const now = Date.now();
  const mark = (l, field, k, on) => (on
    ? store.run(gc, 'INSERT OR IGNORE INTO card_dismissed (user_id, card_id, source_id, field, value_key, at) VALUES (?, ?, ?, ?, ?, ?)', [userId, c.id, l.id, field, k, now])
    : store.run(gc, 'DELETE FROM card_dismissed WHERE card_id = ? AND source_id = ? AND field = ? AND value_key = ?', [c.id, l.id, field, k]));
  for (const field of LIST_FIELDS) {
    if (ch[field] === undefined) continue;
    const want = new Set(ch[field].map((v) => key(field, v)));
    for (const l of links) for (const v of parse(l.fields_json, {})[field] || []) { const k = key(field, v); if (k) await mark(l, field, k, !want.has(k)); }
  }
  for (const field of SINGLE_FIELDS) {
    if (ch[field] === undefined) continue;
    const want = key(field, ch[field]);
    for (const l of links) { const v = parse(l.fields_json, {})[field]; const k = key(field, v); if (k) await mark(l, field, k, k !== want); }
  }
}

function uniq(list, key) {
  const seen = new Set();
  return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function ownCard(gc, userId, id) {
  const c = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM cards WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!c) throw fail('not_found');
  return c;
}

// ─── the list ───────────────────────────────────

const cursorOf = (r) => Buffer.from(`${r.sort_key}\u0000${r.id}`).toString('base64url');
function cursorArg(v) {
  if (typeof v !== 'string' || !v) return null;
  try { const [k, id] = Buffer.from(v, 'base64url').toString('utf8').split('\u0000'); return Number.isSafeInteger(Number(id)) ? { key: k, id: Number(id) } : null; } catch { return null; }
}

/** GET cards?q=&book=<id>|all&group=<id>&cursor=&limit=&since= → { items, next, version, deleted } */
async function list(gc, ctx, q) {
  const cfg = await config.get(gc);
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  pim.touch(ctx.userId, 'contacts');
  const prefs = await pimstore.cardPrefs(gc, ctx.userId);
  const { rows: bookRows } = await books(gc, cfg, ctx.userId);
  let bookIds = bookRows.filter((b) => b.visible === 1).map((b) => b.id);
  if (q.book && q.book !== 'all') {
    const id = posInt(q.book);
    if (!bookRows.some((b) => b.id === id)) throw fail('not_found');
    bookIds = [id];
  }
  const limit = Math.min(Math.max(posInt(q.limit) || LIMIT, 1), 1000);
  const where = ['c.user_id = ?', `c.addressbook_id IN (${store.marks(bookIds.length || 1)})`];
  const args = [ctx.userId, ...(bookIds.length ? bookIds : [0])];
  // linked ones show under their primary (in every list but the one of their own address book)
  if (!q.book || q.book === 'all') where.push('c.link_id IS NULL');
  if (q.group) {
    const g = await store.one(gc, 'SELECT id FROM card_groups WHERE id = ? AND user_id = ?', [posInt(q.group), ctx.userId]);
    if (!g) throw fail('not_found');
    where.push('c.id IN (SELECT card_id FROM card_group_members WHERE group_id = ? AND card_id IS NOT NULL)');
    args.push(g.id);
  }
  const text = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '';
  if (text) {
    const like = `%${cardstore.fold(text).replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
    const raw = `%${text.toLowerCase().replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
    const digits = text.replace(/\D/g, '');
    where.push(`(c.sort_key LIKE ? ESCAPE '\\' OR LOWER(c.display) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.company, '')) LIKE ? ESCAPE '\\'
      OR c.id IN (SELECT card_id FROM card_emails WHERE user_id = ? AND email LIKE ? ESCAPE '\\')${digits.length >= 3 ? ' OR c.id IN (SELECT card_id FROM card_phones WHERE user_id = ? AND digits LIKE ?)' : ''})`);
    args.push(like, raw, raw, ctx.userId, raw);
    if (digits.length >= 3) args.push(ctx.userId, `%${vcard.digits(digits) || digits}%`);
  }
  let deleted;
  let version;
  if (q.since != null && q.since !== '') {
    const since = Number(q.since);
    if (!Number.isSafeInteger(since) || since < 0) throw fail('invalid', { field: 'since' });
    where.push('c.version > ?');
    args.push(since);
    deleted = (await store.all(gc, 'SELECT card_id FROM card_tombstones WHERE user_id = ? AND version > ? ORDER BY version LIMIT 5000', [ctx.userId, since])).map((r) => r.card_id);
  }
  version = await pimstore.cardVersion(gc, ctx.userId);
  const order = prefs.sort === 'given' ? 'COALESCE(c.given, c.display) COLLATE NOCASE, c.id' : 'c.sort_key, c.id';
  const cur = cursorArg(q.cursor);
  if (cur && prefs.sort !== 'given') { where.push('(c.sort_key > ? OR (c.sort_key = ? AND c.id > ?))'); args.push(cur.key, cur.key, cur.id); }
  const offset = cur && prefs.sort === 'given' ? cur.id : 0;
  const rows = await store.all(gc, `SELECT c.* FROM cards c WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit + 1, offset]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await summaries(gc, ctx.userId, page, prefs);
  let next = null;
  if (more) next = prefs.sort === 'given' ? Buffer.from(`\u0000${offset + limit}`).toString('base64url') : cursorOf(page[page.length - 1]);
  return { items, next, version, ...(deleted ? { deleted } : {}) };
}

/** GET cards/<id> → Card */
async function get(gc, ctx, id) {
  return full(gc, ctx.userId, await ownCard(gc, ctx.userId, id));
}

// ─── writing ────────────────────────────────────

/** The person's default address book (CardPrefs, else the local one). */
async function defaultBook(gc, userId) {
  const p = await pimstore.cardPrefs(gc, userId);
  if (p.defaultAddressbookId) { const b = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ? AND user_id = ? AND writable = 1', [p.defaultAddressbookId, userId]); if (b) return b; }
  return store.one(gc, "SELECT * FROM addressbooks WHERE user_id = ? AND source = 'local' ORDER BY is_default DESC, id LIMIT 1", [userId]);
}

const accountOf = (gc, book) => (book.account_id ? store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [book.account_id]) : null);

/**
 * Write card fields `f` (the whole set: vcard.check over the current fields) into address book `book` (`c`: the row,
 * null for a new card; `photo`: { mime, data } | null | undefined = keep) → the stored row.
 */
async function write(gc, book, c, f, photo) {
  if (book.writable !== 1) throw fail('read_only');
  if (book.source === 'graph') {
    const a = await accountOf(gc, book);
    const x = await pim.forPerson(gc, a, async () => {
      const r = c ? await pimgraph.updateContact(gc, a, c.remote_id, f) : await pimgraph.createContact(gc, a, book, f);
      if (photo && photo.data) await pimgraph.putPhoto(gc, a, r.id || c.remote_id, photo);
      return r;
    });
    const fields = x && x.id ? pimgraph.contactFields(x) : f;
    return cardstore.storeCard(gc, book, { id: c ? c.id : undefined, uid: c ? c.uid : `graph:${x.id}`, fields, vcard: null, remoteId: x.id || (c && c.remote_id), changeKey: x.changeKey || null, photo });
  }
  // vCard: round trip of the stored card (unknown properties stay)
  let comp;
  if (c && c.vcard) comp = vcard.parseAll(c.vcard)[0];
  else comp = vcard.create((c && c.uid) || vcard.newUid(), book.source === 'carddav' ? book.vcard_version : '4.0');
  vcard.apply(comp, f);
  const keepPhoto = photo === undefined && c ? await cardstore.photoOf(gc, c.id) : (photo || null);
  if (book.source === 'carddav') {
    const a = await accountOf(gc, book);
    return pim.forPerson(gc, a, () => pimdav.putCard(gc, a, book, c, comp, keepPhoto));
  }
  const fields = vcard.fieldsOf(comp);
  return cardstore.storeCard(gc, book, { id: c ? c.id : undefined, uid: fields.uid, fields, vcard: vcard.toText(comp, null), photo });
}

/** The full fields of a card after change `ch` (vcard.check) over the current fields. */
function mergedFields(cur, ch) {
  const out = { ...cur, ...ch };
  out.name = ch.name ? { ...(cur.name || {}), ...Object.fromEntries(Object.entries(ch.name).filter(([, v]) => v !== undefined)) } : { ...(cur.name || { display: '', given: '', family: '' }) };
  if (!ch.name || ch.name.display == null) out.name.display = [out.name.given, out.name.family].filter(Boolean).join(' ') || out.name.display || out.company || ((out.emails || [])[0] || {}).value || '';
  return out;
}

const empty = { name: { display: '', given: '', family: '' }, emails: [], phones: [], company: null, department: null, title: null, addresses: [], birthday: null, note: '', urls: [] };

/** POST cards { addressbookId?, …Card fields } → { card } */
async function create(gc, ctx, b) {
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  const book = b.addressbookId != null ? await pimstore.ownBook(gc, ctx.userId, posInt(b.addressbookId)) : await defaultBook(gc, ctx.userId);
  if (!book) throw fail('not_found');
  const ch = vcard.check(b);
  const f = mergedFields(empty, ch);
  if (!f.name.display && !f.emails.length && !f.phones.length && !f.company) throw fail('invalid', { field: 'name' });
  const c = await write(gc, book, null, f, undefined);
  await setGroups(gc, ctx.userId, c.id, b.groups);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: book.id, contactIds: [c.id] });
  return { card: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [c.id])) };
}

/** The groups of a card (a list of group ids of the person; undefined: unchanged). */
async function setGroups(gc, userId, cardId, groups) {
  if (groups === undefined) return;
  if (!Array.isArray(groups) || groups.length > GROUPS_MAX) throw fail('invalid', { field: 'groups' });
  const own = new Set((await store.all(gc, 'SELECT id FROM card_groups WHERE user_id = ?', [userId])).map((g) => g.id));
  const want = groups.map(posInt).filter((g) => own.has(g));
  await store.run(gc, 'DELETE FROM card_group_members WHERE card_id = ?', [cardId]);
  for (const g of want) {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM card_group_members WHERE group_id = ?', [g]);
    if (n.n >= MEMBERS_MAX) throw fail('limit', { max: MEMBERS_MAX });
    await store.run(gc, 'INSERT INTO card_group_members (group_id, card_id) VALUES (?, ?)', [g, cardId]);
  }
}

/** PATCH cards/<id> { …fields, etag } → { card } — 409 conflict { current }, 409 read_only. */
async function patch(gc, ctx, id, b) {
  const c = await ownCard(gc, ctx.userId, id);
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [c.addressbook_id]);
  if (!book || book.writable !== 1) throw fail('read_only');
  if (b.etag !== undefined && b.etag !== etagOf(c)) throw fail('conflict', { current: await full(gc, ctx.userId, c) });
  const ch = vcard.check(b);
  const f = mergedFields(parse(c.fields_json, {}), ch);
  await rememberRemoved(gc, ctx.userId, c, ch);
  let stored;
  try { stored = await write(gc, book, c, f, undefined); } catch (e) {
    if (e && e.code === 'conflict') throw fail('conflict', { current: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [c.id]) || c) });
    throw e;
  }
  await setGroups(gc, ctx.userId, stored.id, b.groups);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: book.id, contactIds: [stored.id] });
  return { card: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [stored.id])) };
}

/** Delete card `c` at its provider and here. */
async function destroy(gc, c) {
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [c.addressbook_id]);
  if (!book || book.writable !== 1) throw fail('read_only');
  if (book.source === 'graph') { const a = await accountOf(gc, book); await pim.forPerson(gc, a, () => pimgraph.deleteContact(gc, a, c.remote_id)); }
  if (book.source === 'carddav') { const a = await accountOf(gc, book); await pim.forPerson(gc, a, () => pimdav.deleteCard(gc, a, c)); }
  await cardstore.dropCard(gc, c);
}

/** DELETE cards/<id> → { ok } */
async function remove(gc, ctx, id) {
  const c = await ownCard(gc, ctx.userId, id);
  await destroy(gc, c);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: c.addressbook_id, contactIds: [c.id] });
  return { ok: true };
}

// ─── photos ─────────────────────────────────────

/** GET cards/<id>/photo → { mime, size, data } */
async function photo(gc, ctx, id) {
  const c = await ownCard(gc, ctx.userId, id);
  const p = await store.one(gc, 'SELECT * FROM card_photos WHERE card_id = ?', [c.id]);
  if (!p) throw fail('not_found');
  return { mime: p.mime, size: p.bytes, data: p.data };
}

/** PUT cards/<id>/photo { mime, data } (≤ 256 KB) → { card } */
async function putPhoto(gc, ctx, id, b) {
  const c = await ownCard(gc, ctx.userId, id);
  if (b.mime !== 'image/jpeg' && b.mime !== 'image/png') throw fail('invalid', { field: 'mime' });
  if (typeof b.data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(b.data)) throw fail('invalid', { field: 'data' });
  const data = b.data.replace(/\s+/g, '');
  if (Buffer.byteLength(data, 'base64') > cardstore.PHOTO_MAX) throw fail('too_large');
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [c.addressbook_id]);
  if (!book || book.writable !== 1) throw fail('read_only');
  const stored = await write(gc, book, c, parse(c.fields_json, {}), { mime: b.mime, data });
  await cardstore.setPhoto(gc, stored.id, { mime: b.mime, data });
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: book.id, contactIds: [stored.id] });
  return { card: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [stored.id])) };
}

/** DELETE cards/<id>/photo → { card } */
async function deletePhoto(gc, ctx, id) {
  const c = await ownCard(gc, ctx.userId, id);
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [c.addressbook_id]);
  if (!book || book.writable !== 1) throw fail('read_only');
  if (book.source !== 'graph') await write(gc, book, c, parse(c.fields_json, {}), null);
  await cardstore.setPhoto(gc, c.id, null);
  return { card: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [c.id])) };
}

// ─── lookup, activity, draft ────────────────────

/** The person's card of an address (the first visible one; a linked one → its primary), or null. */
async function cardOf(gc, userId, addr) {
  const r = await store.one(gc, `SELECT c.* FROM card_emails e JOIN cards c ON c.id = e.card_id JOIN addressbooks b ON b.id = c.addressbook_id
    WHERE e.user_id = ? AND e.email = ? ORDER BY b.visible DESC, CASE b.source WHEN 'local' THEN 0 ELSE 1 END, c.id LIMIT 1`, [userId, addr]);
  if (r && r.link_id) return (await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [r.link_id])) || r;
  return r;
}

/** GET cards/lookup?email= → { card, person, recent } */
async function lookup(gc, ctx, q) {
  const addr = email(q.email);
  if (!addr) throw fail('invalid', { field: 'email' });
  const c = await cardOf(gc, ctx.userId, addr);
  let person = null;
  const p = await store.one(gc, 'SELECT user_id FROM accounts WHERE email = ? AND user_id <> ? LIMIT 1', [addr, ctx.userId]);
  if (p) { try { const u = await gc.users.get(p.user_id); if (u) person = { userId: p.user_id, name: u.name || '' }; } catch { person = null; } }
  const r = await store.one(gc, 'SELECT * FROM contacts WHERE user_id = ? AND email = ?', [ctx.userId, addr]);
  return { card: c ? await full(gc, ctx.userId, c) : null, person, recent: r ? { name: r.name || '', sent: r.sent, received: r.received, lastAt: r.last_at } : null };
}

/** GET cards/<id>/activity → { mails: [Summary] (≤ 5), events: [Occurrence] (≤ 5) } */
async function activity(gc, ctx, id) {
  const c = await ownCard(gc, ctx.userId, id);
  const f = (await full(gc, ctx.userId, c));
  const addrs = f.emails.map((e) => e.value).slice(0, 10);
  if (!addrs.length) return { mails: [], events: [] };
  const like = addrs.map(() => "m.to_json LIKE ? ESCAPE '\\'").join(' OR ');
  const esc = (s) => `%"email":"${s.replace(/[%_\\]/g, (ch) => '\\' + ch)}"%`;
  const rows = await store.all(gc, `SELECT m.*, 1 AS thread_count, 0 AS saved_count, NULL AS ai_summary FROM messages m WHERE m.user_id = ? AND (m.from_email IN (${store.marks(addrs.length)}) OR ${like})
    ORDER BY m.date DESC LIMIT 5`, [ctx.userId, ...addrs, ...addrs.map(esc)]);
  const now = Date.now();
  const calendars = require('./calendars');
  const zone = await pimstore.zoneOf(gc, ctx.userId);
  const evLike = addrs.map(() => "(e.attendees_json LIKE ? ESCAPE '\\' OR COALESCE(e.organizer_json, '') LIKE ? ESCAPE '\\')").join(' OR ');
  const occ = async (dir) => store.all(gc, `SELECT ${calendars.OCC_COLS} FROM occurrences o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? AND (${evLike}) AND o.start ${dir === 'next' ? '>=' : '<'} ?
    ORDER BY o.start ${dir === 'next' ? 'ASC' : 'DESC'} LIMIT 5`, [ctx.userId, ...addrs.flatMap((a) => [esc(a), esc(a)]), now]);
  const next = await occ('next');
  const last = await occ('last');
  const events = [...next.slice(0, 3), ...last.slice(0, 5 - Math.min(3, next.length))].slice(0, 5).map((r) => calendars.occurrenceView(r, zone));
  return { mails: rows.map((r) => mailstore.summary(r)), events };
}

const PHONE_RE = /(?:\+|00)?\d[\d\s/().-]{6,20}\d/;
const LABELED_PHONE = /^(?:tel(?:efon)?|phone|fon|mobil(?:e)?|handy|mob|cell|fax)\.?\s*[:.]?\s*(.+)$/i;

/** Telephone, company and position from a signature (rules) → { phones, company, title }. */
function fromSignature(text, name) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  let start = lines.findIndex((l) => /^-- ?$/.test(l));
  if (start < 0) {
    const greet = lines.findIndex((l) => /^(viele grüße|mit freundlichen grüßen|beste grüße|liebe grüße|gruß|grüße|best regards|kind regards|regards|cheers|thanks|danke)[,!.]?$/i.test(l));
    start = greet >= 0 ? greet : Math.max(0, lines.length - SIGNATURE_LINES);
  }
  const sig = lines.slice(start + 1, start + 1 + SIGNATURE_LINES).filter(Boolean).filter((l) => !/^>/.test(l));
  const phones = [];
  let company = null;
  let title = null;
  for (const l of sig) {
    const lab = LABELED_PHONE.exec(l);
    const m = PHONE_RE.exec(lab ? lab[1] : l);
    if (m && (lab || /^\+?[\d\s/().-]+$/.test(l))) {
      const type = /mobil|handy|mob|cell/i.test(l) ? 'mobile' : /fax/i.test(l) ? 'fax' : 'work';
      if (phones.length < 3 && !phones.some((p) => vcard.digits(p.value) === vcard.digits(m[0]))) phones.push({ value: m[0].trim(), type });
      continue;
    }
    if (!company && /\b(gmbh|ag|kg|ug|e\.?\s?v\.?|ohg|gbr|ltd|inc|llc|se|co\.?)\b/i.test(l) && l.length <= 80) { company = l; continue; }
    if (!title && name && l !== name && l.length <= 60 && /(leiter(in)?|manager(in)?|geschäftsführer(in)?|berater(in)?|director|head|ceo|cto|cfo|engineer|entwickler(in)?|referent(in)?|assistent(in)?|sachbearbeiter(in)?|inhaber(in)?|vertrieb|sales|consultant)\b/i.test(l)) title = l;
  }
  return { phones, company, title };
}

const AI_INSTRUCTIONS = [
  'You read the signature of one e-mail and fill a contact card of its sender. Answer only from the text; never invent anything.',
  'given / family: the sender\'s name; company, title (position), phones (with type mobile|work|fax), address of the company — null when not there.',
].join('\n');
const AI_SCHEMA = {
  type: 'object', required: ['given', 'family'],
  properties: {
    given: { type: 'string', maxLength: 80, nullable: true }, family: { type: 'string', maxLength: 80, nullable: true },
    company: { type: 'string', maxLength: 120, nullable: true }, title: { type: 'string', maxLength: 120, nullable: true },
    phones: { type: 'array', maxItems: 3, items: { type: 'object', required: ['value'], properties: { value: { type: 'string', maxLength: 40 }, type: { type: 'string', enum: ['mobile', 'work', 'fax'] } } } },
    street: { type: 'string', maxLength: 120, nullable: true }, postalCode: { type: 'string', maxLength: 20, nullable: true }, city: { type: 'string', maxLength: 80, nullable: true },
  },
};

/** GET cards/draft?messageId=<id>&email=<address> → { draft, existing } („Als Kontakt speichern“ — nothing is stored). */
async function draft(gc, ctx, q) {
  const cfg = await config.get(gc);
  const mid = posInt(q.messageId);
  const m = mid ? await store.one(gc, 'SELECT * FROM messages WHERE id = ? AND user_id = ?', [mid, ctx.userId]) : null;
  if (!m) throw fail('not_found');
  const addr = email(q.email) || m.from_email;
  if (!addr) throw fail('invalid', { field: 'email' });
  const people = [{ name: m.from_name, email: m.from_email }, ...parse(m.to_json, []), ...parse(m.cc_json, [])];
  const p = people.find((x) => x && x.email === addr) || { name: '', email: addr };
  const parts = String(p.name || '').replace(/["']/g, '').trim();
  let given = '';
  let family = '';
  if (/,/.test(parts)) { [family, given] = parts.split(',').map((s) => s.trim()); } else if (parts) { const w = parts.split(/\s+/); family = w.length > 1 ? w.pop() : ''; given = w.join(' '); }
  const out = { name: { display: parts || '', given, family, middle: null, prefix: null, suffix: null, nickname: null }, emails: [{ value: addr, type: 'other', primary: true }],
    phones: [], company: null, department: null, title: null, addresses: [], birthday: null, note: '', urls: [] };
  // from the signature: only of a mail the sender wrote
  if (addr === m.from_email) {
    const b = await store.one(gc, 'SELECT text FROM bodies WHERE message_id = ?', [m.id]);
    const text = (b && b.text) || '';
    const sig = fromSignature(text, parts);
    out.phones = sig.phones; out.company = sig.company; out.title = sig.title;
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]);
    if (text && cfg.contacts.ai && await ai.allowedFor(gc, cfg, a, 'bar')) {
      try {
        const res = await gc.ai.extract({ task: 'contact_card', user: ctx.userId, instructions: AI_INSTRUCTIONS, maxOutputTokens: 400, timeoutMs: 30000, schema: AI_SCHEMA,
          input: [{ type: 'text', label: 'From', text: clip(`${m.from_name || ''} <${m.from_email}>`, 300) }, { type: 'text', label: 'Mail', text: clip(text.split('\n').slice(-40).join('\n'), 4000) }] });
        const d = res && res.data && typeof res.data === 'object' ? res.data : {};
        const s = (v, n) => (typeof v === 'string' && v.trim() ? clip(line(v), n) : null);
        if (s(d.given, 80)) out.name.given = s(d.given, 80);
        if (s(d.family, 80)) out.name.family = s(d.family, 80);
        out.company = s(d.company, 120) || out.company;
        out.title = s(d.title, 120) || out.title;
        for (const ph of Array.isArray(d.phones) ? d.phones : []) {
          if (ph && typeof ph.value === 'string' && /\d{5,}/.test(ph.value.replace(/\D/g, '')) && !out.phones.some((x) => vcard.digits(x.value) === vcard.digits(ph.value)) && out.phones.length < 3) out.phones.push({ value: clip(line(ph.value), 40), type: ['mobile', 'work', 'fax'].includes(ph.type) ? ph.type : 'work' });
        }
        if (s(d.city, 80)) out.addresses = [{ type: 'work', street: s(d.street, 120) || '', postalCode: s(d.postalCode, 20) || '', city: s(d.city, 80), region: '', country: '' }];
      } catch { /* the rules then */ }
    }
  }
  out.name.display = [out.name.given, out.name.family].filter(Boolean).join(' ') || out.name.display;
  const existing = await cardOf(gc, ctx.userId, addr);
  return { draft: out, existing: existing ? await full(gc, ctx.userId, existing) : null };
}

// ─── duplicates ─────────────────────────────────

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);

/** GET cards/duplicates → { items: [{ key, reason, cards }] } */
async function duplicates(gc, ctx) {
  const cfg = await config.get(gc);
  const prefs = await pimstore.cardPrefs(gc, ctx.userId);
  const { rows: bookRows } = await books(gc, cfg, ctx.userId);
  const visible = bookRows.filter((b) => b.visible === 1).map((b) => b.id);
  if (!visible.length) return { items: [] };
  const marks = store.marks(visible.length);
  const ignored = new Set((await store.all(gc, 'SELECT a, b FROM card_dup_ignored WHERE user_id = ?', [ctx.userId])).map((r) => `${r.a}:${r.b}`));
  const linked = new Set((await store.all(gc, 'SELECT id, link_id FROM cards WHERE user_id = ? AND link_id IS NOT NULL', [ctx.userId])).map((r) => pairKey(r.id, r.link_id).join(':')));
  const groups = [];
  const add = (reason, ids) => {
    const uniqIds = [...new Set(ids)];
    const ok = uniqIds.filter((x, i) => uniqIds.some((y, j) => j !== i && !ignored.has(pairKey(x, y).join(':')) && !linked.has(pairKey(x, y).join(':'))));
    if (ok.length >= 2) groups.push({ reason, ids: ok });
  };
  for (const r of await store.all(gc, `SELECT e.email, GROUP_CONCAT(e.card_id) AS ids FROM card_emails e JOIN cards c ON c.id = e.card_id
    WHERE e.user_id = ? AND c.addressbook_id IN (${marks}) GROUP BY e.email HAVING COUNT(DISTINCT e.card_id) > 1 LIMIT 500`, [ctx.userId, ...visible])) add('email', String(r.ids).split(',').map(Number));
  for (const r of await store.all(gc, `SELECT p.digits, GROUP_CONCAT(p.card_id) AS ids FROM card_phones p JOIN cards c ON c.id = p.card_id
    WHERE p.user_id = ? AND c.addressbook_id IN (${marks}) GROUP BY p.digits HAVING COUNT(DISTINCT p.card_id) > 1 LIMIT 500`, [ctx.userId, ...visible])) add('phone', String(r.ids).split(',').map(Number));
  for (const r of await store.all(gc, `SELECT LOWER(c.display) AS d, GROUP_CONCAT(c.id) AS ids FROM cards c WHERE c.user_id = ? AND c.addressbook_id IN (${marks}) AND c.display <> ''
    AND NOT EXISTS (SELECT 1 FROM card_emails e WHERE e.card_id = c.id) GROUP BY LOWER(c.display) HAVING COUNT(*) > 1 LIMIT 500`, [ctx.userId, ...visible])) add('name', String(r.ids).split(',').map(Number));
  // one entry per set of cards (the first reason)
  const seen = new Set();
  const items = [];
  for (const g of groups) {
    const ids = [...new Set(g.ids)].sort((x, y) => x - y).slice(0, MERGE_MAX);
    const key = ids.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = [];
    for (const part of store.chunks(ids, 80)) rows.push(...await store.all(gc, `SELECT * FROM cards WHERE id IN (${store.marks(part.length)}) AND user_id = ?`, [...part, ctx.userId]));
    if (rows.length < 2) continue;
    items.push({ key, reason: g.reason, cards: await summaries(gc, ctx.userId, rows, prefs) });
  }
  return { items: items.slice(0, 200) };
}

/** POST cards/duplicates/ignore { ids } → { ok } */
async function ignore(gc, ctx, b) {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(posInt).filter(Boolean))] : [];
  if (ids.length < 2 || ids.length > MERGE_MAX) throw fail('invalid', { field: 'ids' });
  for (const id of ids) await ownCard(gc, ctx.userId, id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const [a, c] = pairKey(ids[i], ids[j]);
    await store.run(gc, 'INSERT OR IGNORE INTO card_dup_ignored (user_id, a, b) VALUES (?, ?, ?)', [ctx.userId, a, c]);
  }
  return { ok: true };
}

/**
 * POST cards/merge { ids (2…10), primaryId, pick? } → { card }. In one writable address book: one card stays (fields
 * joined, single fields after `pick`, notes joined), the others are deleted at the provider, their groups move. Across
 * address books: linked (nothing deleted at a provider).
 */
async function merge(gc, ctx, b) {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(posInt).filter(Boolean))] : [];
  if (ids.length < 2 || ids.length > MERGE_MAX) throw fail('invalid', { field: 'ids' });
  const primaryId = posInt(b.primaryId);
  if (!ids.includes(primaryId)) throw fail('invalid', { field: 'primaryId' });
  const cards = [];
  for (const id of ids) cards.push(await ownCard(gc, ctx.userId, id));
  const primary = cards.find((c) => c.id === primaryId);
  const others = cards.filter((c) => c.id !== primaryId);
  const sameBook = others.every((c) => c.addressbook_id === primary.addressbook_id);
  if (!sameBook) {
    for (const c of others) {
      await store.run(gc, 'UPDATE cards SET link_id = ?, version = ? WHERE id = ?', [primary.id, await pimstore.nextCardVersion(gc, ctx.userId), c.id]);
      // cards that were linked to the merged one follow it (with the values the person removed)
      await store.run(gc, 'UPDATE cards SET link_id = ? WHERE link_id = ?', [primary.id, c.id]);
      await store.run(gc, 'UPDATE OR IGNORE card_dismissed SET card_id = ? WHERE card_id = ?', [primary.id, c.id]);
    }
    await store.run(gc, 'UPDATE cards SET link_id = NULL, version = ? WHERE id = ?', [await pimstore.nextCardVersion(gc, ctx.userId), primary.id]);
    await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: primary.addressbook_id, contactIds: ids });
    return { card: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [primary.id])) };
  }
  const book = await store.one(gc, 'SELECT * FROM addressbooks WHERE id = ?', [primary.addressbook_id]);
  if (!book || book.writable !== 1) throw fail('read_only');
  const fs = new Map(cards.map((c) => [c.id, parse(c.fields_json, {})]));
  const pick = b.pick && typeof b.pick === 'object' ? b.pick : {};
  const pf = fs.get(primary.id);
  const f = { ...pf };
  f.emails = uniq(cards.flatMap((c) => fs.get(c.id).emails || []), (e) => e.value).map((e, i) => ({ ...e, primary: i === 0 }));
  f.phones = uniq(cards.flatMap((c) => fs.get(c.id).phones || []), (p) => vcard.digits(p.value) || p.value);
  f.addresses = uniq(cards.flatMap((c) => fs.get(c.id).addresses || []), (a) => `${a.street}|${a.postalCode}|${a.city}`.toLowerCase());
  f.urls = uniq(cards.flatMap((c) => fs.get(c.id).urls || []), (u) => u);
  const from = (k) => { const id = posInt(pick[k]); return id && fs.has(id) ? fs.get(id) : null; };
  if (from('name')) f.name = from('name').name;
  for (const k of ['company', 'title', 'birthday']) { const src = from(k); if (src) f[k] = src[k] || null; else if (!f[k]) f[k] = (cards.map((c) => fs.get(c.id)[k]).find(Boolean)) || null; }
  if (from('company')) f.department = from('company').department || null;
  f.note = pick.note === 'join' ? cards.map((c) => fs.get(c.id).note).filter(Boolean).join('\n\n').slice(0, vcard.NOTE_MAX) : (pf.note || '');
  let ph;
  const photoFrom = posInt(pick.photo);
  if (photoFrom && fs.has(photoFrom) && photoFrom !== primary.id) ph = await cardstore.photoOf(gc, photoFrom);
  else if (!primary.photo_etag) { const withPhoto = others.find((c) => c.photo_etag); if (withPhoto) ph = await cardstore.photoOf(gc, withPhoto.id); }
  const stored = await write(gc, book, primary, f, ph || undefined);
  if (ph) await cardstore.setPhoto(gc, stored.id, ph);
  for (const c of others) {
    await store.run(gc, `UPDATE card_group_members SET card_id = ? WHERE card_id = ? AND group_id NOT IN (SELECT group_id FROM card_group_members WHERE card_id = ?)`, [stored.id, c.id, stored.id]);
    await store.run(gc, 'DELETE FROM card_group_members WHERE card_id = ?', [c.id]);
    await store.run(gc, 'UPDATE cards SET link_id = ? WHERE link_id = ?', [stored.id, c.id]);
    await store.run(gc, 'UPDATE OR IGNORE card_dismissed SET card_id = ? WHERE card_id = ?', [stored.id, c.id]);
    await destroy(gc, c);
  }
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: book.id, contactIds: ids });
  return { card: await full(gc, ctx.userId, await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [stored.id])) };
}

// ─── import / export ────────────────────────────

/** POST cards/import { addressbookId?, vcf } → { imported, updated, skipped } */
async function importVcf(gc, ctx, b) {
  await pimstore.ensureSetup(gc, ctx.userId, ctx.lang);
  if (typeof b.vcf !== 'string' || !b.vcf) throw fail('invalid', { field: 'vcf' });
  if (Buffer.byteLength(b.vcf) > IMPORT_MAX) throw fail('too_large');
  const book = b.addressbookId != null ? await pimstore.ownBook(gc, ctx.userId, posInt(b.addressbookId)) : await defaultBook(gc, ctx.userId);
  if (!book) throw fail('not_found');
  if (book.writable !== 1) throw fail('read_only');
  const comps = vcard.parseAll(b.vcf);
  const out = { imported: 0, updated: 0, skipped: 0 };
  const changed = [];
  for (const comp of comps) {
    try {
      const photo = vcard.takePhoto(comp);
      const f = vcard.fieldsOf(comp);
      if (!f.name.display && !f.emails.length && !f.phones.length) { out.skipped++; continue; }
      // the same contact again: by UID, else by its first address in this address book
      let have = f.uid ? await store.one(gc, 'SELECT * FROM cards WHERE addressbook_id = ? AND uid = ?', [book.id, f.uid]) : null;
      if (!have && f.emails[0]) have = await store.one(gc, 'SELECT c.* FROM card_emails e JOIN cards c ON c.id = e.card_id WHERE c.addressbook_id = ? AND e.email = ? LIMIT 1', [book.id, f.emails[0].value]);
      if (have) {
        const cur = parse(have.fields_json, {});
        const same = JSON.stringify({ ...cur, uid: null, version: null, photo: null }) === JSON.stringify({ ...f, uid: null, version: null, photo: null, categories: cur.categories });
        if (same && (!photo || have.photo_etag)) { out.skipped++; continue; }
        const merged = mergedFields(cur, vcard.check({ name: f.name, emails: f.emails, phones: f.phones, company: f.company, department: f.department, title: f.title,
          addresses: f.addresses, birthday: f.birthday, note: f.note, urls: f.urls }));
        const c = await write(gc, book, have, merged, photo || undefined);
        if (photo) await cardstore.setPhoto(gc, c.id, photo);
        changed.push(c.id);
        out.updated++;
        continue;
      }
      let c;
      if (book.source === 'local') {
        if (!f.uid) comp.addPropertyWithValue('uid', vcard.newUid());
        const ff = vcard.fieldsOf(comp);
        c = await cardstore.storeCard(gc, book, { uid: ff.uid, fields: ff, vcard: vcard.toText(comp, null), photo });
      } else c = await write(gc, book, null, mergedFields(empty, vcard.check({ name: f.name, emails: f.emails, phones: f.phones, company: f.company, department: f.department,
        title: f.title, addresses: f.addresses, birthday: f.birthday, note: f.note, urls: f.urls })), photo || undefined);
      changed.push(c.id);
      out.imported++;
    } catch (e) {
      if (e && e.code === 'limit') throw e;
      out.skipped++;
    }
  }
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'changed', addressbookId: book.id, ...(changed.length <= 50 ? { contactIds: changed } : {}) });
  return out;
}

/** GET cards/export?book=<id>|all&group=<id> → { name, mime, data } (vCard 4.0) */
async function exportVcf(gc, ctx, q) {
  const cfg = await config.get(gc);
  const { rows: bookRows } = await books(gc, cfg, ctx.userId);
  let ids = bookRows.map((b) => b.id);
  if (q.book && q.book !== 'all') { const id = posInt(q.book); if (!ids.includes(id)) throw fail('not_found'); ids = [id]; }
  if (!ids.length) return { name: 'kontakte.vcf', mime: 'text/vcard', data: '' };
  let rows = await store.all(gc, `SELECT * FROM cards WHERE user_id = ? AND addressbook_id IN (${store.marks(ids.length)}) ORDER BY sort_key, id LIMIT 10000`, [ctx.userId, ...ids]);
  if (q.group) {
    const g = await store.one(gc, 'SELECT id FROM card_groups WHERE id = ? AND user_id = ?', [posInt(q.group), ctx.userId]);
    if (!g) throw fail('not_found');
    const members = new Set((await store.all(gc, 'SELECT card_id FROM card_group_members WHERE group_id = ?', [g.id])).map((r) => r.card_id));
    rows = rows.filter((r) => members.has(r.id));
  }
  const parts = [];
  for (const r of rows) {
    const ph = r.photo_etag ? await cardstore.photoOf(gc, r.id) : null;
    let comp;
    if (r.vcard) { try { comp = vcard.parseAll(r.vcard)[0]; } catch { comp = null; } }
    if (!comp) { comp = vcard.create(r.uid, '4.0'); vcard.apply(comp, vcard.check(stripForCheck(parse(r.fields_json, {})))); }
    parts.push(vcard.asV4(comp, ph));
  }
  return { name: 'kontakte.vcf', mime: 'text/vcard', data: Buffer.from(parts.join('')).toString('base64') };
}

const stripForCheck = (f) => ({ name: f.name, emails: f.emails, phones: f.phones, company: f.company, department: f.department, title: f.title, addresses: f.addresses, birthday: f.birthday, note: f.note, urls: f.urls });

// ─── groups ─────────────────────────────────────

async function ownGroup(gc, userId, id) {
  const g = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM card_groups WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!g) throw fail('not_found');
  return g;
}

const groupName = (v) => { const s = clip(line(typeof v === 'string' ? v : ''), 80); if (!s) throw fail('invalid', { field: 'name' }); return s; };

async function members(gc, g) {
  const rows = await store.all(gc, 'SELECT m.*, c.display, c.fields_json FROM card_group_members m LEFT JOIN cards c ON c.id = m.card_id WHERE m.group_id = ? ORDER BY m.id', [g.id]);
  return rows.map((r) => {
    const f = r.card_id ? parse(r.fields_json, {}) : null;
    return { id: r.id, contactId: r.card_id || null, name: f ? (r.display || '') : (r.name || ''), email: f ? (((f.emails || []).find((e) => e.primary) || (f.emails || [])[0] || {}).value || null) : (r.email || null) };
  });
}

async function groupOut(gc, g) {
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM card_group_members WHERE group_id = ?', [g.id]);
  return { id: g.id, name: g.name, color: g.color || null, count: n.n };
}

/** POST groups { name, color? } → { group } */
async function createGroup(gc, ctx, b) {
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM card_groups WHERE user_id = ?', [ctx.userId]);
  if (n.n >= GROUPS_MAX) throw fail('limit', { max: GROUPS_MAX });
  if (b.color != null && !(typeof b.color === 'string' && COLOR_RE.test(b.color))) throw fail('invalid', { field: 'color' });
  const r = await store.run(gc, 'INSERT INTO card_groups (user_id, name, color, created_at) VALUES (?, ?, ?, ?)', [ctx.userId, groupName(b.name), b.color ? b.color.toUpperCase() : null, Date.now()]);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'groups' });
  return { group: await groupOut(gc, await store.one(gc, 'SELECT * FROM card_groups WHERE id = ?', [Number(r.lastInsertRowid)])) };
}

/** PATCH groups/<id> { name?, color? } → { group } */
async function patchGroup(gc, ctx, id, b) {
  const g = await ownGroup(gc, ctx.userId, id);
  if (b.name !== undefined) await store.run(gc, 'UPDATE card_groups SET name = ? WHERE id = ?', [groupName(b.name), g.id]);
  if (b.color !== undefined) {
    if (b.color !== null && !(typeof b.color === 'string' && COLOR_RE.test(b.color))) throw fail('invalid', { field: 'color' });
    await store.run(gc, 'UPDATE card_groups SET color = ? WHERE id = ?', [b.color ? b.color.toUpperCase() : null, g.id]);
  }
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'groups' });
  return { group: await groupOut(gc, await store.one(gc, 'SELECT * FROM card_groups WHERE id = ?', [g.id])) };
}

async function removeGroup(gc, ctx, id) {
  const g = await ownGroup(gc, ctx.userId, id);
  await store.run(gc, 'DELETE FROM card_group_members WHERE group_id = ?', [g.id]);
  await store.run(gc, 'DELETE FROM card_groups WHERE id = ?', [g.id]);
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'groups' });
  return { ok: true };
}

/** GET groups/<id> → { group, members } */
async function getGroup(gc, ctx, id) {
  const g = await ownGroup(gc, ctx.userId, id);
  return { group: await groupOut(gc, g), members: await members(gc, g) };
}

/** POST groups/<id>/members { add: [{ contactId } | { email, name? }], remove: [memberId] } → { group, members } */
async function groupMembers(gc, ctx, id, b) {
  const g = await ownGroup(gc, ctx.userId, id);
  const add = Array.isArray(b.add) ? b.add : [];
  const rem = Array.isArray(b.remove) ? b.remove : [];
  if (add.length > MEMBERS_MAX || rem.length > MEMBERS_MAX) throw fail('invalid', { field: 'add' });
  for (const r of rem) await store.run(gc, 'DELETE FROM card_group_members WHERE id = ? AND group_id = ?', [posInt(r), g.id]);
  for (const x of add) {
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM card_group_members WHERE group_id = ?', [g.id]);
    if (n.n >= MEMBERS_MAX) throw fail('limit', { max: MEMBERS_MAX });
    if (x && x.contactId != null) {
      const c = await ownCard(gc, ctx.userId, posInt(x.contactId));
      if (!(await store.one(gc, 'SELECT 1 AS x FROM card_group_members WHERE group_id = ? AND card_id = ?', [g.id, c.id]))) await store.run(gc, 'INSERT INTO card_group_members (group_id, card_id) VALUES (?, ?)', [g.id, c.id]);
      continue;
    }
    const e = email(x && x.email);
    if (!e) throw fail('invalid', { field: 'add' });
    if (await store.one(gc, 'SELECT 1 AS x FROM card_group_members WHERE group_id = ? AND email = ?', [g.id, e])) continue;
    await store.run(gc, 'INSERT INTO card_group_members (group_id, card_id, email, name) VALUES (?, NULL, ?, ?)', [g.id, e, clip(line((x && x.name) || ''), 120)]);
  }
  await pimstore.live(gc, ctx.userId, 'contacts', { kind: 'groups' });
  return { group: await groupOut(gc, g), members: await members(gc, g) };
}

// ─── suggestions while writing (GET contacts?q=) ─

/**
 * The person's own contacts matching `text` → [{ name, email, source: 'contact', contactId, photo }] (every address of a
 * card on its own) and the groups → [{ name, email: null, source: 'group', groupId, members }].
 */
async function suggest(gc, userId, text, max = 10) {
  const cfg = await config.get(gc);
  if (!cfg.contacts.enabled) return { contacts: [], groups: [] };
  const like = `%${cardstore.fold(text).replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
  const likeMail = `%${text.toLowerCase().replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
  const rows = await store.all(gc, `SELECT DISTINCT c.id, c.display, c.photo_etag, c.fields_json, c.link_id FROM cards c JOIN addressbooks b ON b.id = c.addressbook_id
    WHERE c.user_id = ? AND b.visible = 1 AND (c.sort_key LIKE ? ESCAPE '\\' OR LOWER(c.display) LIKE ? ESCAPE '\\' OR c.id IN (SELECT card_id FROM card_emails WHERE user_id = ? AND email LIKE ? ESCAPE '\\'))
    ORDER BY c.sort_key LIMIT 50`, [userId, like, like, userId, likeMail]);
  const contacts = [];
  for (const r of rows) {
    const f = parse(r.fields_json, {});
    for (const e of f.emails || []) {
      if (contacts.some((x) => x.email === e.value)) continue;
      contacts.push({ name: r.display || '', email: e.value, source: 'contact', contactId: r.link_id || r.id, photo: !!r.photo_etag });
    }
  }
  const groups = [];
  for (const g of await store.all(gc, "SELECT * FROM card_groups WHERE user_id = ? AND LOWER(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 5", [userId, likeMail])) {
    const m = (await members(gc, g)).filter((x) => x.email).slice(0, 50).map((x) => ({ name: x.name || '', email: x.email }));
    if (m.length) groups.push({ name: `${g.name} (${m.length})`, email: null, source: 'group', groupId: g.id, members: m });
  }
  return { contacts: contacts.slice(0, max), groups };
}

module.exports = {
  addressbooks, patchBook, settings, list, get, create, patch, remove, photo, putPhoto, deletePhoto, lookup, activity, draft, duplicates, ignore, merge,
  importVcf, exportVcf, createGroup, patchGroup, removeGroup, getGroup, groupMembers, suggest, fromSignature, full, cardOf, defaultBook, summaries,
};
