'use strict';

// 1.18.0 — „Neuer Chat“ with the person's contacts (bridges stage 4c; GateControl with gc.bridges version 6, Mail ≥ 1.16.0
// for the address book — both feature-detected). One list in three sections, in this order:
//
//   gatecontrol   the accounts on this server, as before (GET people)
//   whatsapp      the person's contacts at the bridge (gc.bridges.contacts — the bridge's own contact store; listing
//                 them asks WhatsApp nothing). The apps get a name, a picture GateControl already has, the chat that
//                 exists and a sealed reference (`ref`) — never a number. Tapping starts the chat at once:
//                 POST bridges/:network/chats { ref } (nothing to check, nothing counted)
//   addressBook   the person's own contacts with a phone number from Mail (service contacts_phones). Their numbers go
//                 to the apps — they are the person's own. Nothing goes to WhatsApp while nobody taps: tapping one
//                 number (POST bridges/:network/chats { contactId, phoneKind }) asks WhatsApp about exactly that number,
//                 counts in the brake of 1.16.0 (the admin's checks per person and hour) and a „not at WhatsApp“ is
//                 remembered for 30 days (contact id, kind of number and date — never the number; table bridge_not_on)
//
// Merged on this server by the number: an address book number that is a WhatsApp contact (gc.bridges.matchNumbers —
// compared with the bridge's list, no question to WhatsApp) shows ONCE, under WhatsApp, with the name from the address
// book and „auch in deinem Adressbuch“. A chat that exists shows „Chat öffnen“ (conversationId) — for WhatsApp contacts
// by the bridge's room, for address book numbers by the keyed hash of a number a chat was started with (1.16.0).
//
// Nothing of this is logged: the protocol gets „WhatsApp-Nummer geprüft · Quelle Adressbuch · gefunden / nicht
// gefunden“ (code bridge_number_checked) without a number and without a name.

const store = require('./store');
const seal = require('./seal');
const log = require('./log');
const people = require('./people');
const { fail, posInt, bridgeName } = require('./util');

const MAIL = 'gatecontrol-mail';
const MAIL_SERVICE = 'contacts_phones';
const NOT_ON_MS = 30 * 86400000;
const BOOK_PAGES = 20;
const BOOK_KEEP_MS = 60000;
const QUERY_MAX = 100;
const KEY_RE = /^(mobile|work|home|other)(-[2-9])?$/;
const REF_RE = /^k[A-Za-z0-9_-]{40,1400}$/;
const book = new Map(); // `${viewer}|${q}` → { at, r } — the answer of Mail for a minute (the dialog asks while typing)

/** gc.bridges with contacts (version ≥ 6), else null. */
function api(gc) {
  const b = require('./bridgemedia').newChatApi(gc);
  return b && Number(b.version) >= 6 && typeof b.contacts === 'function' && typeof b.matchNumbers === 'function' && typeof b.createDmByRef === 'function' ? b : null;
}

async function mailOffers(gc) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  try { return (await gc.services.available(MAIL, MAIL_SERVICE)) === true; } catch { return false; }
}

/** One call of Mail's contacts_phones → its answer, or { ok: false, code }. */
async function mailCall(ctx, payload) {
  try {
    const r = await ctx.gc.services.call({ plugin: MAIL, service: MAIL_SERVICE, userId: ctx.viewer, payload: { userId: ctx.viewer, lang: ctx.lang, ...payload } });
    return r && typeof r === 'object' ? r : { ok: false, code: 'failed' };
  } catch (e) {
    await log.add(ctx.gc, 'service_refused', `${MAIL}:${MAIL_SERVICE} ${(e && e.code) || 'error'}`, ctx.now);
    return { ok: false, code: (e && e.code) === 'ERR_RATE_LIMIT' ? 'rate_limited' : 'unavailable' };
  }
}

/** The person's contacts with numbers (all pages, ≤ BOOK_PAGES) → { state: 'ok' | 'missing', reason?, items }. */
async function addressBook(ctx, q) {
  if (!(await mailOffers(ctx.gc))) return { state: 'missing', reason: 'no_mail', items: [] };
  const k = `${ctx.viewer}|${q}`;
  const have = book.get(k);
  if (have && ctx.now - have.at < BOOK_KEEP_MS && ctx.now >= have.at) return have.r;
  const items = [];
  let cursor = null;
  let r = { state: 'ok', items };
  for (let i = 0; i < BOOK_PAGES; i++) {
    const p = await mailCall(ctx, { ...(q ? { q } : {}), limit: 100, ...(cursor ? { cursor } : {}) });
    if (!p.ok) { r = { state: 'missing', reason: p.reason || p.code || 'failed', items: [] }; break; }
    items.push(...(Array.isArray(p.items) ? p.items : []));
    if (!p.next) break;
    cursor = p.next;
  }
  for (const [x, v] of book) if (ctx.now - v.at >= BOOK_KEEP_MS) book.delete(x);
  if (book.size > 500) book.clear();
  book.set(k, { at: ctx.now, r });
  return r;
}

/** One contact of the address book (the one tapped) → its row of Mail, or null. */
async function bookContact(ctx, id) {
  if (!(await mailOffers(ctx.gc))) throw fail('mail_missing');
  const p = await mailCall(ctx, { ids: [id] });
  if (!p.ok) throw fail('mail_missing', { reason: p.reason || p.code || null });
  return (p.items || []).find((x) => x && x.id === id) || null;
}

const markOf = (viewer, net, number) => seal.mark(`${viewer}|${net}|${number}`);

/** „nicht bei WhatsApp“ remembered (≤ 30 days) → Set of `${cardId}|${key}`. */
async function notOnSet(ctx, net) {
  const rows = await store.all(ctx.gc, 'SELECT card_id, phone_key FROM bridge_not_on WHERE user_id = ? AND network = ? AND at > ?', [ctx.viewer, net, ctx.now - NOT_ON_MS]);
  return new Set(rows.map((r) => `${r.card_id}|${r.phone_key}`));
}
async function rememberNotOn(ctx, net, cardId, key) {
  await store.run(ctx.gc, `INSERT INTO bridge_not_on (user_id, network, card_id, phone_key, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, network, card_id, phone_key) DO UPDATE SET at = excluded.at`, [ctx.viewer, net, cardId, key, ctx.now]);
}
async function isNotOn(ctx, net, cardId, key) {
  return !!(await store.one(ctx.gc, 'SELECT 1 AS x FROM bridge_not_on WHERE user_id = ? AND network = ? AND card_id = ? AND phone_key = ? AND at > ?', [ctx.viewer, net, cardId, key, ctx.now - NOT_ON_MS]));
}
/** Unlinking forgets them (bridges.forgetNumbers); older than 30 days go in the background run. */
async function forget(gc, userId, net) { await store.run(gc, 'DELETE FROM bridge_not_on WHERE user_id = ? AND network = ?', [userId, net]); }
async function purge(gc, now) { await store.run(gc, 'DELETE FROM bridge_not_on WHERE at <= ?', [now - NOT_ON_MS]); }

/** A picture GateControl already fetched for this contact (the same reference the bridge's events carried). */
async function pictureFor(ctx, net, ref) {
  if (!ref) return { avatarMediaId: null, avatarUrl: null };
  const row = await store.one(ctx.gc, 'SELECT avatar_media_id FROM bridge_contacts WHERE owner_id = ? AND network = ? AND avatar_got = ? AND avatar_media_id IS NOT NULL LIMIT 1', [ctx.viewer, net, ref])
    || await store.one(ctx.gc, 'SELECT avatar_media_id FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_avatar_got = ? AND avatar_media_id IS NOT NULL LIMIT 1', [ctx.viewer, net, ref]);
  const id = row ? await require('./bridgemedia').pictureOf(ctx.gc, row.avatar_media_id) : null;
  let url = null;
  if (id && ctx.portal) { try { url = await ctx.gc.media.url(id, { user: ctx.viewer, ttlS: 6 * 3600 }); } catch { url = null; } }
  return { avatarMediaId: id, avatarUrl: url };
}

/** The conversation of a bridge chat reference of this person (open), or null. */
async function convOfRef(ctx, net, chatId) {
  if (typeof chatId !== 'string' || !chatId) return null;
  const r = await store.one(ctx.gc, 'SELECT id FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_ref = ? AND bridge_closed = 0', [ctx.viewer, net, chatId]);
  return r ? r.id : null;
}

/** Does it look like a phone number (the search field)? → '+49…' or null — the same rules as the dialog of 1.16.0. */
function numberLike(q) {
  if (!/^[+0-9\s\-./()]{6,40}$/.test(q) || (q.match(/[0-9]/g) || []).length < 6) return null;
  let x = q.replace(/\(0\)/g, '').replace(/[\s\-./()]/g, '');
  if (x.startsWith('00')) x = '+' + x.slice(2);
  else if (/^0[1-9]/.test(x)) x = '+49' + x.slice(1);
  return /^\+[1-9][0-9]{6,14}$/.test(x) && !x.startsWith('+490') ? x : null;
}
function shown(e164) {
  const m = /^\+(49|43|41)([0-9]{3})([0-9]+)$/.exec(e164);
  return m ? `+${m[1]} ${m[2]} ${m[3]}` : e164;
}

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de', { sensitivity: 'base' });

/**
 * GET contacts/new-chat?q=&network=whatsapp → { network, query, gatecontrol, whatsapp, addressBook, number, numberEntry,
 * limit } — see README "App-API", 1.18.0.
 */
async function list(ctx, query) {
  const bridges = require('./bridges');
  const qs = query && typeof query === 'object' ? query : {};
  const net = qs.network == null || qs.network === '' ? 'whatsapp' : String(qs.network);
  if (!bridges.NETWORKS.includes(net)) throw fail('invalid');
  const q = typeof qs.q === 'string' ? qs.q.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, QUERY_MAX) : '';
  const ql = q.toLowerCase();

  // ── GateControl: the accounts, as before ──
  const gcList = [];
  for (const p of await people.list(ctx.gc, ctx.viewer)) {
    if (ql && !String(p.name || '').toLowerCase().includes(ql)) continue;
    const key = `${Math.min(ctx.viewer, p.id)}:${Math.max(ctx.viewer, p.id)}`;
    const c = await store.one(ctx.gc, 'SELECT id FROM conversations WHERE direct_key = ? AND last_msg_id IS NOT NULL', [key]);
    gcList.push({ userId: p.id, name: p.name, avatarUrl: p.avatarUrl || null, initials: p.initials || null, colorHex: p.colorHex || null, conversationId: c ? c.id : null });
  }

  // ── which of the other two sections there are ──
  const st = await bridges.newChatOf(ctx, net);
  const limit = st ? st.limit : null;
  const b = api(ctx.gc);
  // missing: never linked, the bridges off or the plugin without the API, locked for a child, a child without new chats
  const waShown = !!(b && st && ['unlinked', 'off', 'child_locked', 'child_new_chat_off'].indexOf(st.reason) < 0);
  const out = { network: net, query: q, gatecontrol: gcList, whatsapp: null, addressBook: null, number: null, numberEntry: false, limit };
  if (!waShown) return out;
  out.numberEntry = true;

  // ── WhatsApp ──
  let waItems = [];
  let waState = st.reason === 'logged_out' ? 'logged_out' : (st.reason === 'unreachable' ? 'unreachable' : 'ok');
  const total = { whatsapp: null };
  if (waState === 'ok') {
    try {
      const r = await b.contacts(ctx.viewer, net, q ? { query: q } : {});
      waItems = Array.isArray(r && r.contacts) ? r.contacts : [];
    } catch (e) {
      waState = e && (e.reason === 'logged_out' || e.reason === 'not_logged_in' || e.reason === 'refused') ? 'logged_out' : 'unreachable';
    }
  }

  // ── the address book (also when WhatsApp is not reachable: shown, but not tappable) ──
  const ab = await addressBook(ctx, q);
  const notOn = await notOnSet(ctx, net);
  // „Chat öffnen“ for a number a chat was started with here (keyed hash, 1.16.0) — no question to WhatsApp
  const numChats = new Map((await store.all(ctx.gc, 'SELECT id, bridge_num FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_num IS NOT NULL AND bridge_closed = 0', [ctx.viewer, net])).map((r) => [r.bridge_num, r.id]));
  const abItems = ab.items.filter((x) => x && posInt(x.id) && Array.isArray(x.phones)).map((x) => ({
    contactId: x.id, name: String(x.name || '').slice(0, 120),
    phones: x.phones.filter((p) => p && KEY_RE.test(String(p.key))).map((p) => ({
      key: p.key, kind: p.kind, number: String(p.value || p.e164 || '').slice(0, 40), e164: p.e164 || null, landline: p.landline === true,
      notOnNetwork: notOn.has(`${x.id}|${p.key}`),
    })),
  })).filter((x) => x.phones.length);

  // ── merged by the number (only the bridge's list is read) ──
  const merged = new Map(); // contactId of the bridge → the address book entry
  if (waState === 'ok' && abItems.length) {
    const nums = [];
    const owner = [];
    for (const x of abItems) for (const p of x.phones) if (p.e164) { nums.push(p.e164); owner.push(x); }
    if (nums.length) {
      let m = null;
      try { m = await b.matchNumbers(ctx.viewer, net, nums.slice(0, 2000)); } catch { m = null; }
      const gone = new Set();
      for (const hit of (m && Array.isArray(m.matches) ? m.matches : [])) {
        const x = owner[hit.index];
        if (!x || gone.has(x.contactId)) continue;
        gone.add(x.contactId);
        const key = hit.contactId || hit.ref;
        if (!merged.has(key)) merged.set(key, { hit, entry: x });
      }
      for (let i = abItems.length - 1; i >= 0; i--) if (gone.has(abItems[i].contactId)) abItems.splice(i, 1);
    }
  }

  if (waState === 'ok') {
    const seen = new Set();
    const rows = [];
    const add = async (c, entry) => {
      const key = c.contactId || c.ref;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        ref: REF_RE.test(String(c.ref || '')) ? c.ref : null,
        // 1.19.0: never a number as a name (a bridge names a contact without a name by it)
        name: (entry && entry.name) || bridgeName(c.name) || require('./bridgechats').titleLabel(ctx, net),
        ...(await pictureFor(ctx, net, c.avatar || null)),
        conversationId: await convOfRef(ctx, net, c.chatId),
        alsoInAddressBook: !!entry,
        addressBookId: entry ? entry.contactId : null,
      });
    };
    for (const c of waItems) { const mm = merged.get(c.contactId || c.ref); await add(c, mm ? mm.entry : null); }
    for (const { hit, entry } of merged.values()) await add(hit, entry);
    rows.sort(byName);
    out.whatsapp = { state: 'ok', items: rows.filter((r) => r.ref), total: rows.filter((r) => r.ref).length };
  } else {
    out.whatsapp = { state: waState, items: [], total: 0 };
  }

  // ── the address book section: missing without Mail, without contacts with a number ──
  if (ab.state === 'ok' && abItems.length) {
    for (const x of abItems) {
      const hit = x.phones.map((p) => (p.e164 ? numChats.get(markOf(ctx.viewer, net, p.e164)) : null)).find(Boolean);
      x.conversationId = hit || null;
    }
    out.addressBook = { state: waState === 'ok' ? 'ok' : waState, items: abItems, total: abItems.length };
  } else if (ab.state !== 'ok') {
    out.addressBook = null;
    out.addressBookReason = ab.reason || null;
  }

  // ── a number typed into the search field: the last line „… bei WhatsApp prüfen“ (checked only when tapped) ──
  const n = numberLike(q);
  if (n) out.number = { e164: n, show: shown(n), conversationId: numChats.get(markOf(ctx.viewer, net, n)) || null };
  return out;
}

/** GET me features.bridge_contacts: GateControl has contacts at the bridge and the person linked a service. */
async function feature(ctx) {
  if (!api(ctx.gc)) return false;
  return !!(await store.one(ctx.gc, 'SELECT 1 AS x FROM bridge_links WHERE user_id = ? LIMIT 1', [ctx.viewer]));
}

/** contacts/* of the app API → the answer's body, or null when the path is not ours. */
async function route(ctx, req, seg) {
  if (seg[0] !== 'contacts' || seg[1] !== 'new-chat' || seg.length !== 2) return null;
  if (String(req.method || 'GET').toUpperCase() !== 'GET') throw fail('not_found');
  return list(ctx, req.query);
}

// ─── names of chats from the address book (1.19.0) ─────────────────────────
//
// A direct chat over a bridge is named like in the messenger's own app: by the person's OWN address book (Mail) when a
// number of a contact there is that chat's contact at the bridge (gc.bridges.matchNumbers — compared with the bridge's
// list, no question to WhatsApp, nothing counted; the number stays between Mail and GateControl), else by the name the
// bridge knows (the contact's public name), else neutrally. Asked inside a request of the person, kept BOOK_NAMES_MS
// per person and network in memory only.
const BOOK_NAMES_MS = 10 * 60000;
const BOOK_NAMES_RETRY_MS = 60000;
const bookNamesKept = new Map(); // `${viewer}|${net}` → { at, names: Map(chat reference → name) }

/** → Map(chat reference of the bridge → the address book's name) for the viewer; empty when it cannot be known. */
async function bookNames(ctx, net, ref) {
  const k = `${ctx.viewer}|${net}`;
  const have = bookNamesKept.get(k);
  // a chat not in the list (new since): asked again, at most once a minute
  const fresh = have && ctx.now >= have.at && (ctx.now - have.at < BOOK_NAMES_MS) && (have.names.has(ref) || ctx.now - have.at < BOOK_NAMES_RETRY_MS);
  if (fresh) return have.names;
  const names = new Map();
  const b = api(ctx.gc);
  let known = !b;
  if (b) {
    try {
      const ab = await addressBook(ctx, '');
      const nums = [];
      const owner = [];
      for (const x of ab.state === 'ok' ? ab.items : []) {
        const name = typeof x.name === 'string' ? x.name.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        if (!name) continue;
        for (const p of Array.isArray(x.phones) ? x.phones : []) if (p && typeof p.e164 === 'string' && nums.length < 2000) { nums.push(p.e164); owner.push(name); }
      }
      if (nums.length) {
        const m = await b.matchNumbers(ctx.viewer, net, nums);
        for (const hit of (m && Array.isArray(m.matches) ? m.matches : [])) {
          if (typeof hit.chatId === 'string' && hit.chatId && owner[hit.index] && !names.has(hit.chatId)) names.set(hit.chatId, owner[hit.index]);
        }
      }
      known = true;
    } catch { known = false; }
  }
  // not known now (WhatsApp away, no request of the person): asked again at the next view, nothing kept
  if (known) {
    for (const [x, v] of bookNamesKept) if (ctx.now - v.at >= BOOK_NAMES_MS) bookNamesKept.delete(x);
    if (bookNamesKept.size > 500) bookNamesKept.clear();
    bookNamesKept.set(k, { at: ctx.now, names });
  }
  return names;
}

/** The address book's name of a bridged direct chat (null: none). Never throws. */
async function bookNameOf(ctx, conv) {
  if (!conv || !conv.bridge_net || conv.kind !== 'direct' || conv.bridge_owner !== ctx.viewer || !(await mailOffers(ctx.gc))) return null;
  try { return (await bookNames(ctx, conv.bridge_net, conv.bridge_ref)).get(conv.bridge_ref) || null; } catch { return null; }
}

module.exports = { route, list, api, feature, bookContact, isNotOn, rememberNotOn, forget, purge, numberLike, bookNameOf, KEY_RE, REF_RE, NOT_ON_MS, _reset: () => { book.clear(); bookNamesKept.clear(); } };
