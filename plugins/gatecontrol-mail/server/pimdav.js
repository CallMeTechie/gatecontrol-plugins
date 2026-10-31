'use strict';

// Calendars and address books of password accounts (GMX, WEB.DE, an own domain, Nextcloud …) over CalDAV / CardDAV
// (dav.js, gc.mail.dav ≥ 1.219.0), and iCal subscriptions (Gmail's secret address, any https address; read only).
//
// Addresses: GMX caldav.gmx.net / carddav.gmx.net, WEB.DE caldav.web.de / carddav.web.de (user = the address, password
// = the mail password, or an own davPassword), an own domain from gc.mail.autoconfig (caldav / carddav), else
// /.well-known/caldav of the domain, else what the person enters in the account's settings. T-Online: none. Gmail: no
// CalDAV (Google wants OAuth) — the calendar through the secret iCal address, contacts by importing a vCard file.
//
// A sync per collection: PROPFIND Depth 0 (getctag, sync-token) — unchanged: done. With a sync-token REPORT
// sync-collection (an invalid token: a full sync), else the ETags (calendars: calendar-query in the window); changed
// objects by multiget in blocks of 50. Writing: PUT with If-None-Match: * / If-Match, DELETE with If-Match; a 412 is
// merged field by field against the state before the own change (ics.merge) and sent once more, else conflict.

const store = require('./store');
const secrets = require('./secrets');
const dav = require('./dav');
const ics = require('./ics');
const vcard = require('./vcard');
const pimstore = require('./pimstore');
const cardstore = require('./cardstore');
const { fail, line, clip } = require('./util');

const KNOWN = {
  gmx: { caldav: 'https://caldav.gmx.net', carddav: 'https://carddav.gmx.net' },
  webde: { caldav: 'https://caldav.web.de', carddav: 'https://carddav.web.de' },
};
const NONE = ['tonline', 'gmail', 'outlook', 'm365'];
const ICS_MAX = 10 * 1024 * 1024;
const BACKOFF_MIN = 15 * 60000;
const BACKOFF_MAX = 6 * 3600000;

/** The DAV credentials of account `a` → { user, pass } | null. */
async function authOf(gc, a) {
  const cred = await secrets.get(gc, a.id);
  const pass = cred && (cred.davPassword || cred.password);
  if (!pass) return null;
  return { user: a.dav_username || a.username || a.email, pass };
}

/**
 * The base address of `kind` ('caldav' | 'carddav') for account `a` → url | null (none for this provider). Order: the
 * address the person entered, the provider's, autoconfig (A4), /.well-known of the domain.
 */
async function baseOf(gc, a, kind) {
  const own = kind === 'caldav' ? a.caldav_url : a.carddav_url;
  if (own) return own;
  if (KNOWN[a.provider]) return KNOWN[a.provider][kind];
  if (NONE.includes(a.provider)) return null;
  if (gc.mail && typeof gc.mail.autoconfig === 'function') {
    try {
      const r = await gc.mail.autoconfig(a.email);
      const u = r && r[kind] && dav.httpsUrl(r[kind].url);
      if (u) return u;
    } catch { /* the domain then */ }
  }
  const domain = String(a.email).split('@')[1];
  return domain ? `https://${domain}/.well-known/${kind}` : null;
}

/** The host of a URL (Account.server: never a secret address). */
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };

// ─── discovery ──────────────────────────────────

/**
 * Discovery and the list of collections of `kind` for account `a` → { home, server, list } — throws auth_failed,
 * unreachable, dav_unavailable { reason }.
 */
async function discover(gc, a, kind, base, authIn) {
  const auth = authIn || await authOf(gc, a);
  if (!auth) throw Object.assign(fail('auth_failed'), { dav: true });
  const url = base || await baseOf(gc, a, kind);
  if (!url) throw fail('dav_unavailable', { reason: 'not_found' });
  const d = await dav.discover(gc, auth, url, kind);
  const list = await dav.collections(gc, auth, d.home, kind);
  if (!list.length) throw fail('dav_unavailable', { reason: kind === 'caldav' ? 'no_calendar' : 'not_found' });
  return { home: d.home, server: hostOf(d.home), list, auth };
}

/** The calendar rows of account `a` from its collections (new ones made, gone ones removed). */
async function syncCalendarList(gc, a, found) {
  const have = await store.all(gc, "SELECT * FROM calendars WHERE account_id = ? AND source = 'caldav'", [a.id]);
  const auto = found.auth ? await dav.autoSchedule(gc, found.auth, found.home) : false;
  const now = Date.now();
  const custom = new Set();
  const prefs = await store.one(gc, 'SELECT json FROM cal_prefs WHERE user_id = ?', [a.user_id]);
  try { for (const id of (JSON.parse((prefs && prefs.json) || '{}').custom || [])) custom.add(id); } catch { /* none */ }
  for (const [i, c] of found.list.entries()) {
    const row = have.find((r) => dav.same(r.remote_id, c.url));
    const kind = i === 0 ? (a.kind === 'business' ? 'business' : 'private') : 'other';
    if (row) {
      const keep = custom.has(row.id);
      await store.run(gc, 'UPDATE calendars SET name = ?, color = ?, writable = ?, auto_schedule = ?, sort = ? WHERE id = ?',
        [keep ? row.name : (c.name || row.name), keep ? row.color : (c.color || row.color), c.writable ? 1 : 0, auto ? 1 : 0, i, row.id]);
    } else {
      await store.run(gc, `INSERT INTO calendars (user_id, account_id, source, remote_id, name, color, kind, writable, is_default, sort, auto_schedule, state, created_at)
        VALUES (?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, 'syncing', ?)`,
      [a.user_id, a.id, c.url, c.name || a.email, c.color || await pimstore.nextColor(gc, a.user_id), kind, c.writable ? 1 : 0, i === 0 ? 1 : 0, i, auto ? 1 : 0, now]).catch(() => null);
    }
  }
  for (const r of have) if (!found.list.some((c) => dav.same(r.remote_id, c.url))) await pimstore.dropCalendar(gc, r);
  return store.all(gc, "SELECT * FROM calendars WHERE account_id = ? AND source = 'caldav' ORDER BY sort, id", [a.id]);
}

/** The address book rows of account `a` from its collections. */
async function syncBookList(gc, a, found) {
  const have = await store.all(gc, "SELECT * FROM addressbooks WHERE account_id = ? AND source = 'carddav'", [a.id]);
  const now = Date.now();
  for (const [i, c] of found.list.entries()) {
    const row = have.find((r) => dav.same(r.remote_id, c.url));
    if (row) await store.run(gc, 'UPDATE addressbooks SET writable = ?, vcard_version = ?, is_default = ? WHERE id = ?', [c.writable ? 1 : 0, c.vcardVersion, i === 0 ? 1 : 0, row.id]);
    else {
      await store.run(gc, `INSERT INTO addressbooks (user_id, account_id, source, remote_id, name, writable, is_default, vcard_version, state, created_at)
        VALUES (?, ?, 'carddav', ?, ?, ?, ?, ?, 'syncing', ?)`, [a.user_id, a.id, c.url, c.name || a.email, c.writable ? 1 : 0, i === 0 ? 1 : 0, c.vcardVersion, now]).catch(() => null);
    }
  }
  for (const r of have) if (!found.list.some((c) => dav.same(r.remote_id, c.url))) await cardstore.dropBook(gc, r);
  return store.all(gc, "SELECT * FROM addressbooks WHERE account_id = ? AND source = 'carddav' ORDER BY is_default DESC, id", [a.id]);
}

// ─── syncing a collection ───────────────────────

/**
 * Sync calendar / address book row `col` of account `a` → { changed: [ids], removed, held }. `kind` 'caldav' |
 * 'carddav'; `guard(col, gone, total)` → false: a mass delete is held back (pim.js).
 */
async function syncCollection(gc, a, col, kind, guard) {
  const auth = await authOf(gc, a);
  if (!auth) throw Object.assign(fail('auth_failed'), { dav: true });
  const table = kind === 'caldav' ? 'calendars' : 'addressbooks';
  const st = await dav.state(gc, auth, col.remote_id);
  if ((st.syncToken && st.syncToken === col.sync_token) || (!st.syncToken && st.ctag && st.ctag === col.ctag)) {
    await store.run(gc, `UPDATE ${table} SET synced_at = ?, state = 'ok', error_code = NULL WHERE id = ?`, [Date.now(), col.id]);
    return { changed: [], removed: 0 };
  }
  let changedHrefs = null;
  let removedHrefs = [];
  let token = null;
  if (col.sync_token && st.syncToken) {
    const r = await dav.syncCollection(gc, auth, col.remote_id, col.sync_token);
    if (r) { changedHrefs = r.changed; removedHrefs = r.removed; token = r.token || st.syncToken; }
  }
  const rows = kind === 'caldav' ? await store.all(gc, 'SELECT id, href, etag FROM events WHERE calendar_id = ? AND href IS NOT NULL', [col.id])
    : await store.all(gc, 'SELECT id, href, etag FROM cards WHERE addressbook_id = ? AND href IS NOT NULL', [col.id]);
  const byHref = new Map(rows.map((r) => [r.href, r]));
  const find = (h) => byHref.get(h) || rows.find((r) => dav.same(r.href, h));
  if (!changedHrefs) {
    // a full comparison by ETag (calendars: the window)
    const w = pimstore.windowOf();
    const list = await dav.etags(gc, auth, col.remote_id, kind, kind === 'caldav' ? w : null);
    changedHrefs = list.filter((x) => { const r = find(x.href); return !r || !x.etag || r.etag !== x.etag; });
    const present = list.map((x) => x.href);
    removedHrefs = rows.filter((r) => !present.some((h) => h === r.href || dav.same(h, r.href))).map((r) => r.href);
    token = st.syncToken || null;
    if (removedHrefs.length && guard && !(await guard(col, removedHrefs.length, rows.length))) return { changed: [], removed: 0, held: true };
  }
  const changed = [];
  const got = changedHrefs.length ? await dav.multiget(gc, auth, col.remote_id, kind, changedHrefs.map((x) => x.href)) : [];
  for (const x of got) {
    try {
      if (kind === 'caldav') {
        const ev = await pimstore.storeObject(gc, col, x.data, { href: x.href, etag: x.etag || null });
        changed.push(ev.id);
      } else {
        const c = await storeVcard(gc, col, x.data, { href: x.href, etag: x.etag || null });
        if (c) changed.push(c.id);
      }
    } catch (e) {
      if (e && e.code === 'limit') break;
      gc.log.warn('object skipped', kind, (e && e.code) || 'error');
    }
  }
  let removed = 0;
  for (const h of removedHrefs) {
    const r = find(h);
    if (!r) continue;
    if (kind === 'caldav') { const ev = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [r.id]); if (ev) await pimstore.dropEvent(gc, ev); } else {
      const c = await store.one(gc, 'SELECT * FROM cards WHERE id = ?', [r.id]);
      if (c) await cardstore.dropCard(gc, c);
    }
    removed++;
  }
  await store.run(gc, `UPDATE ${table} SET ctag = ?, sync_token = ?, synced_at = ?, state = 'ok', error_code = NULL, error_at = NULL WHERE id = ?`,
    [st.ctag || null, token, Date.now(), col.id]);
  return { changed, removed };
}

/** Store a vCard text of address book `book` (its photo separately) → the card row. */
async function storeVcard(gc, book, text, x = {}) {
  const [c] = vcard.parseAll(text);
  const photo = vcard.takePhoto(c);
  const f = vcard.fieldsOf(c);
  return cardstore.storeCard(gc, book, { uid: f.uid || x.uid, fields: f, vcard: vcard.toText(c, null), href: x.href, etag: x.etag, photo: photo || null, id: x.id });
}

// ─── writing ────────────────────────────────────

/**
 * PUT calendar object `text` of event `ev` (null: new, `uid`) into CalDAV calendar `cal` → the stored event row. A 412:
 * the provider's state is merged with this change (base: ev.ics) and sent once more; both touched a field → conflict.
 */
async function putEvent(gc, a, cal, ev, text, uid) {
  const auth = await authOf(gc, a);
  if (!auth) throw Object.assign(fail('auth_failed'), { dav: true });
  const href = ev && ev.href ? ev.href : dav.hrefFor(cal.remote_id, uid, 'caldav');
  let r = await dav.put(gc, auth, href, text, ev ? ev.etag : null, 'caldav');
  let body = text;
  if (r.status === 412) {
    const cur = await dav.get(gc, auth, href);
    if (cur.status !== 200 || !cur.data) throw fail('conflict');
    const merged = ev && ev.ics ? ics.merge(ev.ics, cur.data, text, ev.uid) : null;
    if (!merged) {
      await pimstore.storeObject(gc, cal, cur.data, { href, etag: cur.etag, uid: ev ? ev.uid : uid });
      throw fail('conflict');
    }
    r = await dav.put(gc, auth, href, merged, cur.etag, 'caldav');
    if (r.status === 412) throw fail('conflict');
    body = merged;
  }
  let etag = r.etag;
  if (!etag) { const g = await dav.get(gc, auth, href); if (g.status === 200 && g.data) { body = g.data; etag = g.etag; } }
  return pimstore.storeObject(gc, cal, body, { href, etag, uid: ev ? ev.uid : uid });
}

/** DELETE the object of event `ev` (gone already: done; a 412: once more with the provider's ETag). */
async function deleteEvent(gc, a, ev) {
  const auth = await authOf(gc, a);
  if (!auth) throw Object.assign(fail('auth_failed'), { dav: true });
  if (!ev.href) return;
  let r = await dav.remove(gc, auth, ev.href, ev.etag);
  if (r.status === 412) {
    const cur = await dav.get(gc, auth, ev.href);
    if (cur.status === 404 || cur.status === 410) return;
    r = await dav.remove(gc, auth, ev.href, cur.etag);
    if (r.status === 412) throw fail('conflict');
  }
}

/**
 * PUT a card (`c`: the row, null for a new one; `comp`: the ICAL component without photo; `photo`) into CardDAV address
 * book `book` → the stored row. A 412 is merged like events: fields the provider did not touch keep this change.
 */
async function putCard(gc, a, book, c, comp, photo) {
  const auth = await authOf(gc, a);
  if (!auth) throw Object.assign(fail('auth_failed'), { dav: true });
  const f = vcard.fieldsOf(comp);
  const uid = (c && c.uid) || f.uid || vcard.newUid();
  const href = c && c.href ? c.href : dav.hrefFor(book.remote_id, uid, 'carddav');
  const text = vcard.toText(comp, photo);
  let r = await dav.put(gc, auth, href, text, c ? c.etag : null, 'carddav');
  let stored = text;
  if (r.status === 412) {
    const cur = await dav.get(gc, auth, href);
    if (cur.status !== 200 || !cur.data) throw fail('conflict');
    const merged = mergeCard(c && c.vcard, cur.data, vcard.toText(comp, null));
    if (!merged) { await storeVcard(gc, book, cur.data, { href, etag: cur.etag, id: c ? c.id : undefined }); throw fail('conflict'); }
    const [mc] = vcard.parseAll(merged);
    stored = vcard.toText(mc, photo);
    r = await dav.put(gc, auth, href, stored, cur.etag, 'carddav');
    if (r.status === 412) throw fail('conflict');
  }
  let etag = r.etag;
  if (!etag) { const g = await dav.get(gc, auth, href); if (g.status === 200 && g.data) { stored = g.data; etag = g.etag; } }
  return storeVcard(gc, book, stored, { href, etag, id: c ? c.id : undefined, uid });
}

/** Three-way merge of a vCard by property name (as ics.merge): null when both changed the same property. */
function mergeCard(base, theirs, mine) {
  if (!base) return null;
  const snap = (text) => {
    const [c] = vcard.parseAll(text);
    const m = new Map();
    for (const p of c.getAllProperties()) {
      if (['rev', 'prodid', 'photo'].includes(p.name)) continue;
      m.set(p.name, [...(m.get(p.name) || []), p.toICALString()].sort());
    }
    return { c, m };
  };
  const b = snap(base);
  const t = snap(theirs);
  const me = snap(mine);
  const names = new Set([...b.m.keys(), ...me.m.keys()]);
  const changed = [...names].filter((n) => JSON.stringify(me.m.get(n) || []) !== JSON.stringify(b.m.get(n) || []));
  for (const n of changed) if (JSON.stringify(t.m.get(n) || []) !== JSON.stringify(b.m.get(n) || []) && JSON.stringify(t.m.get(n) || []) !== JSON.stringify(me.m.get(n) || [])) return null;
  for (const n of changed) {
    t.c.removeAllProperties(n);
    for (const p of me.c.getAllProperties(n)) t.c.addProperty(new ics.ICAL.Property(JSON.parse(JSON.stringify(p.toJSON())), t.c));
  }
  return vcard.toText(t.c, null);
}

async function deleteCard(gc, a, c) {
  const auth = await authOf(gc, a);
  if (!auth) throw Object.assign(fail('auth_failed'), { dav: true });
  if (!c.href) return;
  let r = await dav.remove(gc, auth, c.href, c.etag);
  if (r.status === 412) {
    const cur = await dav.get(gc, auth, c.href);
    if (cur.status === 404 || cur.status === 410) return;
    r = await dav.remove(gc, auth, c.href, cur.etag);
    if (r.status === 412) throw fail('conflict');
  }
}

// ─── iCal subscriptions ─────────────────────────

const icsKey = (id) => `ics.${id}`;

async function icsUrl(gc, calId) {
  try { const v = await gc.settings.get(icsKey(calId)); return typeof v === 'string' && v ? v : null; } catch { return null; }
}

async function setIcsUrl(gc, calId, url) { await gc.settings.setSecret(icsKey(calId), url); }

/** GET a subscription's file (no credentials) → { status, text, etag, lastModified }; throws unreachable / invalid_ics. */
async function fetchIcs(gc, url, cond = {}) {
  const headers = { accept: 'text/calendar, */*;q=0.5' };
  if (cond.etag) headers['if-none-match'] = cond.etag;
  if (cond.lastModified) headers['if-modified-since'] = cond.lastModified;
  const r = await dav.request(gc, null, { url, method: 'GET', headers, parse: 'none', maxBytes: ICS_MAX });
  if (r.status === 304) return { status: 304 };
  if (r.status === 404 || r.status === 410) throw fail('dav_unavailable', { reason: 'not_found' });
  if (r.status < 200 || r.status >= 300) throw fail('unreachable', { reason: `status_${r.status}` });
  const text = typeof r.body === 'string' ? r.body : '';
  if (!/BEGIN:VCALENDAR/i.test(text)) throw fail('invalid_ics');
  return { status: 200, text, etag: (r.headers || {}).etag || null, lastModified: (r.headers || {})['last-modified'] || null };
}

/**
 * Sync subscription `cal` (every 30 minutes; after a failure 15 min … 6 h) → { changed, removed, skipped }. The ETag in
 * `ctag`, Last-Modified in `sync_token`, the failures in a row in `delta`.
 */
async function syncIcs(gc, cal, guard, now = Date.now()) {
  const fails = Number(cal.delta) || 0;
  if (fails && cal.error_at && now - cal.error_at < Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (fails - 1))) return { skipped: true };
  const url = await icsUrl(gc, cal.id);
  if (!url) return { skipped: true };
  let r;
  try { r = await fetchIcs(gc, url, { etag: cal.ctag, lastModified: cal.sync_token }); } catch (e) {
    await store.run(gc, "UPDATE calendars SET state = 'unreachable', error_code = ?, error_at = ?, delta = ? WHERE id = ?", [String((e && e.code) || 'error').slice(0, 40), now, String(fails + 1), cal.id]);
    throw e;
  }
  if (r.status === 304) {
    await store.run(gc, "UPDATE calendars SET state = 'ok', error_code = NULL, error_at = NULL, delta = NULL, synced_at = ? WHERE id = ?", [now, cal.id]);
    return { changed: 0, removed: 0 };
  }
  const objects = ics.split(r.text);
  const have = await store.all(gc, 'SELECT id, uid, ics FROM events WHERE calendar_id = ?', [cal.id]);
  const byUid = new Map(have.map((e) => [e.uid, e]));
  const seen = new Set(objects.map((o) => o.uid));
  const gone = have.filter((e) => !seen.has(e.uid));
  if (gone.length && guard && !(await guard(cal, gone.length, have.length))) return { held: true };
  let changed = 0;
  for (const o of objects) {
    const prev = byUid.get(o.uid);
    if (prev && prev.ics === o.text) continue;
    try { await pimstore.storeObject(gc, cal, o.text, { uid: o.uid }); changed++; } catch (e) { if (e && e.code === 'limit') break; }
  }
  for (const e of gone) { const ev = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [e.id]); if (ev) await pimstore.dropEvent(gc, ev); }
  await store.run(gc, "UPDATE calendars SET state = 'ok', error_code = NULL, error_at = NULL, delta = NULL, ctag = ?, sync_token = ?, synced_at = ? WHERE id = ?",
    [r.etag, r.lastModified, now, cal.id]);
  return { changed, removed: gone.length };
}

/** A name for a subscription from its file (X-WR-CALNAME) or its host. */
function icsName(text, url) {
  const m = /^X-WR-CALNAME:(.+)$/mi.exec(String(text || ''));
  if (m) return clip(line(m[1]), 80);
  return hostOf(url) || 'iCal';
}

module.exports = {
  KNOWN, NONE, authOf, baseOf, hostOf, discover, syncCalendarList, syncBookList, syncCollection, storeVcard, putEvent, deleteEvent, putCard, mergeCard, deleteCard,
  icsUrl, setIcsUrl, fetchIcs, syncIcs, icsName,
};
