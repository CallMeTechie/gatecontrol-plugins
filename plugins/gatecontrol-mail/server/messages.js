'use strict';

// Folders, lists, search, reading and the changes a person makes to mail (C2 "Ordner, Listen, Suche").
// External pictures of a body are `img/<token>` (token = message id, the picture's number and a signature of this
// server) — answered by GET img/<token> through GateControl's picture fetcher (gc.http.fetchImage), only while they are
// allowed (POST messages/<id>/images: once, or always for the sender). A plugin answers only JSON: the picture comes as
// { mime, size, data (base64) }; embedded pictures (cid:) as the attachment's media file (GET cid/…).

const crypto = require('node:crypto');
const store = require('./store');
const scan = require('./scan');
const engine = require('./engine');
const mailstore = require('./mailstore');
const classify = require('./classify');
const push = require('./push');
const undo = require('./undo');
const searchIndex = require('./search');
const { fail, posInt, parse, clip } = require('./util');

const LIMIT = 50;
const OPEN_SYNC_MS = 5 * 60000;
const WAIT_MS = 8000;
// what a person waits for at most before the answer goes without it (the apps give up after 25 s); the work goes on and
// the live event `mail` { kind: 'changed', …, messageId } tells when it is there
const timing = { bodyMs: 12000, fileMs: 12000 };
const IMG_MAX = 700 * 1024; // the picture travels as base64 in a JSON answer (≤ 1 MB)

const SUMMARY_COLS = `m.*, (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id AND t.user_id = m.user_id) AS thread_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id AND a.saved_node IS NOT NULL) AS saved_count,
  (SELECT r.summary FROM ai_results r WHERE r.message_id = m.id) AS ai_summary`;

/** A promise that gives up waiting after `ms` (the work goes on in the background). */
function within(p, ms) {
  let timer;
  return Promise.race([p.catch(() => null), new Promise((res) => { timer = setTimeout(res, ms); if (timer.unref) timer.unref(); })]).finally(() => clearTimeout(timer));
}

/** p within `ms` → { done: true, value } | { done: true, error } | { done: false } (p goes on). */
function settled(p, ms) {
  let timer;
  return Promise.race([
    p.then((value) => ({ done: true, value }), (error) => ({ done: true, error })),
    new Promise((res) => { timer = setTimeout(() => res({ done: false }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Work the answer did not wait for: the live event to the person when it is through (lists and the open mail load again). */
function later(gc, userId, accountId, folderId, p, extra) {
  p.then(() => push.changed(gc, userId, accountId, folderId, extra), () => {});
}

/** Errors of loading a body the answer goes without (the copy's snippet, bodyMissing) — the rest is the answer. */
const tolerated = (e) => !!(e && (e.code === 'unreachable' || e.code === 'not_found' || e.code === 'busy'));

async function accountsOf(gc, userId) {
  return store.all(gc, 'SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [userId]);
}

/** A message of the person → its row (with its account), else not_found. */
async function own(gc, userId, id) {
  const m = posInt(id) ? await store.one(gc, 'SELECT * FROM messages WHERE id = ? AND user_id = ?', [posInt(id), userId]) : null;
  if (!m) throw fail('not_found');
  return m;
}

/** GET folders */
async function folders(gc, userId) {
  const out = [];
  for (const a of await accountsOf(gc, userId)) {
    const rows = await store.all(gc, `SELECT f.*, (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.unread = 1) AS unread_n,
      (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id) AS total_n FROM folders f WHERE f.account_id = ? AND (f.role IS NULL OR f.role <> 'all') ORDER BY f.path`, [a.id]);
    const order = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 };
    rows.sort((x, y) => (order[x.role] != null ? order[x.role] : 9) - (order[y.role] != null ? order[y.role] : 9) || (x.path < y.path ? -1 : 1));
    out.push({
      accountId: a.id,
      folders: rows.map((f) => ({ id: f.id, name: f.name, path: f.path, role: f.role || null, parentId: f.parent_id || null, unread: f.unread_n, total: Math.max(f.total_n, Number(f.remote_total) || 0) })),
    });
  }
  return { accounts: out };
}

const cursorOf = (r) => Buffer.from(`${r.date}.${r.id}`).toString('base64url');
function cursorArg(v) {
  if (v == null || v === '') return null;
  const m = /^(\d{1,15})\.(\d{1,15})$/.exec(Buffer.from(String(v), 'base64url').toString('utf8'));
  if (!m) throw fail('invalid', { field: 'before' });
  return { date: Number(m[1]), id: Number(m[2]) };
}
const on = (v) => v === '1' || v === 'true' || v === true;

/** The folders a list shows: { ids, inbox (all posteingänge), accounts } for box / folder. */
async function scope(gc, userId, q) {
  const accounts = await accountsOf(gc, userId);
  if (q.folder != null && q.folder !== '') {
    const f = posInt(q.folder) ? await store.one(gc, 'SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', [posInt(q.folder), userId]) : null;
    if (!f) throw fail('not_found', { field: 'folder' });
    return { folders: [f], inbox: f.role === 'inbox', accounts: accounts.filter((a) => a.id === f.account_id) };
  }
  const box = q.box == null || q.box === '' || q.box === 'all' ? 'all' : posInt(q.box);
  if (!box) throw fail('invalid', { field: 'box' });
  const acc = box === 'all' ? accounts : accounts.filter((a) => a.id === box);
  if (box !== 'all' && !acc.length) throw fail('not_found', { field: 'box' });
  if (!acc.length) return { folders: [], inbox: true, accounts: [] };
  const fs = await store.all(gc, `SELECT * FROM folders WHERE role = 'inbox' AND account_id IN (${store.marks(acc.length)})`, acc.map((a) => a.id));
  return { folders: fs, inbox: true, accounts: acc };
}

async function threadsOn(gc, userId) {
  const p = await store.one(gc, 'SELECT threads FROM prefs WHERE user_id = ?', [userId]);
  return !p || p.threads === 1;
}

/** The rows of a list (one page) → { rows, next }. */
async function page(gc, userId, sc, q, limit) {
  if (!sc.folders.length) return { rows: [], next: null };
  const ids = sc.folders.map((f) => f.id);
  const where = [`m.folder_id IN (${store.marks(ids.length)})`];
  const args = [...ids];
  const tab = q.tab === 'relevant' || q.tab === 'other' ? q.tab : 'all';
  const tabbed = sc.inbox && tab !== 'all';
  if (tabbed) { where.push('m.tab = ?'); args.push(tab); }
  if (on(q.unread)) where.push('m.unread = 1');
  if (on(q.flagged)) where.push('m.flagged = 1');
  if (on(q.attachments)) where.push('m.has_att = 1');
  const c = cursorArg(q.before);
  if (c) { where.push('(m.date < ? OR (m.date = ? AND m.id < ?))'); args.push(c.date, c.date, c.id); }
  // one row per conversation (its newest mail in these folders that passes the filter) while the person wants
  // conversations — 1.10.1: a newer mail counts only when it passes „mit Anhang“ and the tab too; before, a
  // conversation whose newest mail had no attachment (or was in the other tab) vanished from the filtered list
  if (await threadsOn(gc, userId) && !on(q.unread) && !on(q.flagged)) {
    const same = [];
    if (tabbed) same.push('AND n.tab = ?');
    if (on(q.attachments)) same.push('AND n.has_att = 1');
    where.push(`NOT EXISTS (SELECT 1 FROM messages n WHERE n.thread_id = m.thread_id AND n.folder_id IN (${store.marks(ids.length)}) AND n.id <> m.id
      ${same.join(' ')} AND (n.date > m.date OR (n.date = m.date AND n.id > m.id)))`);
    args.push(...ids, ...(tabbed ? [tab] : []));
  }
  const rows = await store.all(gc, `SELECT ${SUMMARY_COLS} FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.id DESC LIMIT ?`, [...args, limit + 1]);
  const more = rows.length > limit;
  const list = rows.slice(0, limit);
  return { rows: list, next: more ? cursorOf(list[list.length - 1]) : null };
}

/** GET messages?box=&folder=&tab=&unread=&flagged=&attachments=&before=&limit= */
async function list(gc, userId, q) {
  const limit = Math.min(Math.max(posInt(q.limit) || LIMIT, 1), 100);
  const sc = await scope(gc, userId, q);
  // a folder other than the posteingang: synced when its copy is older than a few minutes (waits a little)
  if (sc.folders.length === 1 && sc.folders[0].role !== 'inbox' && !q.before) {
    const f = sc.folders[0];
    if (Date.now() - engine.folderSynced(f) > OPEN_SYNC_MS) await within(engine.syncOne(gc, sc.accounts[0], f), WAIT_MS);
  }
  let res = await page(gc, userId, sc, q, limit);
  // past the retention (one folder): the end of the copy here gives a cursor; asking for that page loads older mail
  // from the server
  const older = sc.folders.length === 1 && !sc.folders[0].complete;
  if (!res.next && older && q.before && res.rows.length < limit) {
    const before = res.rows.length ? res.rows[res.rows.length - 1].date : cursorArg(q.before).date;
    const got = await within(engine.loadOlder(gc, sc.accounts[0], sc.folders[0], before, limit), WAIT_MS);
    if (got && got.length) res = await page(gc, userId, sc, q, limit);
  }
  if (!res.next && older && res.rows.length === limit) res.next = cursorOf(res.rows[res.rows.length - 1]);
  if (!res.next && older && !q.before && res.rows.length && res.rows.length < limit) res.next = cursorOf(res.rows[res.rows.length - 1]);
  const counts = { relevant: 0, other: 0 };
  if (sc.inbox && sc.folders.length) {
    const ids = sc.folders.map((f) => f.id);
    for (const r of await store.all(gc, `SELECT tab, COUNT(*) AS n FROM messages WHERE folder_id IN (${store.marks(ids.length)}) AND unread = 1 GROUP BY tab`, ids)) counts[r.tab === 'other' ? 'other' : 'relevant'] = r.n;
  }
  return { items: res.rows.map((r) => mailstore.summary(r)), next: res.next, counts };
}

/**
 * GET search?q=&box=&from=&after=&before=&attachments=&unread=&cursor= → { items, next, remote, index }. `q` is looked
 * for as it is typed (one piece of text, anywhere in the subject, the sender, the recipients, the snippet or the mail's
 * text; upper and lower case alike).
 */
async function search(gc, userId, q) {
  const text = clip(String(q.q || '').trim(), 200);
  const accounts = await accountsOf(gc, userId);
  const box = q.box == null || q.box === '' || q.box === 'all' ? 'all' : posInt(q.box);
  if (!box) throw fail('invalid', { field: 'box' });
  const acc = box === 'all' ? accounts : accounts.filter((a) => a.id === box);
  if (!acc.length) return { items: [], next: null, remote: false };
  const ms = (v) => { if (v == null || v === '') return null; const n = /^\d{1,15}$/.test(String(v)) ? Number(v) : Date.parse(v); if (!Number.isFinite(n)) throw fail('invalid', { field: 'date' }); return n; };
  const after = ms(q.after);
  const before = ms(q.before);
  // 1.14.0: the full-text index (search.js) for the mails it holds, the old way (LIKE over the fields and the text)
  // for the rest — the mails whose turn in the build has not come, the long rest of a very long text. While the option
  // is off (the usual case) or the index is being removed: every mail the old way, as in 1.13. Fewer than three characters: no trigram — the fields of the list
  // (subject, sender, recipients, snippet) by LIKE, not the texts (two letters are in nearly every text; reading all
  // of them for that is what made the search slow).
  const index = await searchIndex.view(gc);
  const indexed = searchIndex.isOn();
  const match = indexed ? searchIndex.matchOf(text) : null;
  const like = text ? `%${text.replace(/[%_\\]/g, (c) => '\\' + c)}%` : null;
  const HEAD = "m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_email LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\'";
  const scope = () => {
    const where = [`m.account_id IN (${store.marks(acc.length)})`, "f.role IS NOT 'trash'", "f.role IS NOT 'junk'"];
    const args = acc.map((a) => a.id);
    if (q.from) { where.push('m.from_email LIKE ?'); args.push(`%${String(q.from).toLowerCase().slice(0, 200)}%`); }
    if (after) { where.push('m.date >= ?'); args.push(after); }
    if (before) { where.push('m.date < ?'); args.push(before); }
    if (on(q.attachments)) where.push('m.has_att = 1');
    if (on(q.unread)) where.push('m.unread = 1');
    const c = cursorArg(q.cursor);
    if (c) { where.push('(m.date < ? OR (m.date = ? AND m.id < ?))'); args.push(c.date, c.date, c.id); }
    return { where, args };
  };
  // the newest LIMIT + 1 of a statement as { id, date } — the columns of the list (with their subqueries) are read
  // for the mails of the page only (rowsOf), not for every mail that matches
  const TAIL = 'ORDER BY m.date DESC, m.id DESC LIMIT ?';
  /** The mails that match by LIKE — `rest`: only the ones the index does not hold completely; `texts`: the texts too. */
  const byLike = async (rest, texts) => {
    const { where, args } = scope();
    if (rest) where.unshift('m.fts <> 1');
    if (text) {
      where.push(`(${HEAD}${texts ? " OR b.text LIKE ? ESCAPE '\\'" : ''})`);
      args.push(like, like, like, like, like, ...(texts ? [like] : []));
    }
    return store.all(gc, `SELECT m.id, m.date FROM messages m JOIN folders f ON f.id = m.folder_id${texts ? ' LEFT JOIN bodies b ON b.message_id = m.id' : ''}
      WHERE ${where.join(' AND ')} ${TAIL}`, [...args, LIMIT + 1]);
  };
  /** The mails the index finds. */
  const byIndex = async () => {
    const { where, args } = scope();
    // the phrase for every table of the index (search.js MATCH_ALL)
    return store.all(gc, `SELECT m.id, m.date FROM ${searchIndex.MATCH_ALL} x JOIN messages m ON m.id = x.rowid JOIN folders f ON f.id = m.folder_id
      WHERE ${where.join(' AND ')} ${TAIL}`, [...searchIndex.matchArgs(match), ...args, LIMIT + 1]);
  };
  /** The rows of the list for `found` ([{ id, date }], in their order). */
  const rowsOf = async (found) => {
    const byId = new Map();
    for (const part of store.chunks(found.map((r) => r.id))) {
      for (const r of await store.all(gc, `SELECT ${SUMMARY_COLS} FROM messages m WHERE m.id IN (${store.marks(part.length)})`, part)) byId.set(r.id, r);
    }
    return found.map((r) => byId.get(r.id)).filter(Boolean);
  };
  const run = async () => {
    let found;
    if (!text) found = await byLike(false, false);
    else if (!indexed) found = await byLike(false, true);
    else if (!match) found = await byLike(false, false);
    else {
      // both, newest first, a mail once (one with a long text may be found by its fields in the index and by LIKE)
      const seen = new Set();
      found = [...await byIndex(), ...await byLike(true, true)].filter((r) => !seen.has(r.id) && seen.add(r.id))
        .sort((x, y) => y.date - x.date || y.id - x.id);
    }
    const more = found.length > LIMIT;
    const rows = await rowsOf(found.slice(0, LIMIT));
    return { rows, next: more && rows.length ? cursorOf(rows[rows.length - 1]) : null };
  };
  let res = await run();
  let remote = false;
  // the first page with few hits: ask the servers too (mail beyond the retention)
  if (text && !q.cursor && res.rows.length < LIMIT) {
    remote = true;
    await within(Promise.all(acc.map((a) => engine.remoteSearch(gc, a, { text, after, before }).catch(() => []))), WAIT_MS * 1.5);
    res = await run();
  }
  // index (1.14.0): 'off' (the usual: the search of 1.13) | 'building' (pending: mails still searched the old way — the
  // results are complete either way) | 'ready' | 'removing' | 'unavailable'
  return { items: res.rows.map((r) => mailstore.summary(r)), next: res.next, remote, index: { state: index.state, pending: index.pending } };
}

// ─── one message ────────────────────────────────

let secret = null;
async function imgSecret(gc) {
  if (secret) return secret;
  let s = null;
  try { s = await gc.storage.get('img_secret'); } catch { s = null; }
  if (typeof s !== 'string' || s.length < 32) { s = crypto.randomBytes(32).toString('hex'); await gc.storage.set('img_secret', s); }
  secret = s;
  return s;
}
const sig = (key, id, n, user) => crypto.createHmac('sha256', key).update(`${id}.${n}.${user}`).digest('base64url').slice(0, 22);

async function imagesAllowed(gc, m) {
  if (await store.one(gc, 'SELECT 1 AS x FROM image_once WHERE message_id = ?', [m.id])) return true;
  return !!(m.from_email && await store.one(gc, 'SELECT 1 AS x FROM image_senders WHERE user_id = ? AND sender = ?', [m.user_id, m.from_email]));
}

const hasImages = (gc) => !!(gc.http && typeof gc.http.fetchImage === 'function');

/** Attachments of a message → the API's list. */
async function attachmentsOf(gc, m) {
  const rows = await store.all(gc, 'SELECT * FROM attachments WHERE message_id = ? ORDER BY id', [m.id]);
  return rows.map((t) => ({
    id: t.id, name: t.name, mime: t.mime, size: t.size, inline: t.inline === 1, cid: t.cid || null,
    savedTo: t.saved_node ? { nodeId: t.saved_node, where: t.saved_where || '' } : null, suggestion: parse(t.suggestion_json, null),
    // 1.8.0: GateControl's virus scan — only once a result is known (scan.js)
    ...(scan.ofRow(t) ? { scan: scan.ofRow(t) } : {}),
  }));
}

/**
 * The full Message of row `m` (the body from the server when it is not here — waited for timing.bodyMs at most: then
 * the answer goes with bodyMissing, the load goes on and its end comes as the live event with the messageId).
 */
async function full(gc, m, { load = true } = {}) {
  let b = await store.one(gc, 'SELECT * FROM bodies WHERE message_id = ?', [m.id]);
  if (!b && load) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]);
    const p = engine.loadBody(gc, a, m);
    const r = await settled(p, timing.bodyMs);
    if (!r.done) later(gc, m.user_id, m.account_id, m.folder_id, p, { messageId: m.id });
    else if (r.error && !tolerated(r.error)) throw r.error;
    b = await store.one(gc, 'SELECT * FROM bodies WHERE message_id = ?', [m.id]);
    m = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [m.id]) || m;
  }
  const now = Date.now();
  await store.run(gc, 'UPDATE messages SET seen_at = ? WHERE id = ?', [now, m.id]);
  if (b) await store.run(gc, 'UPDATE bodies SET used_at = ? WHERE message_id = ?', [now, m.id]);
  const row = await store.one(gc, `SELECT ${SUMMARY_COLS} FROM messages m WHERE m.id = ?`, [m.id]);
  const images = b ? parse(b.images_json, []) : [];
  const blocked = images.length > 0 && (!hasImages(gc) || !(await imagesAllowed(gc, m)));
  let html = b ? b.html : null;
  if (html && images.length) {
    const key = await imgSecret(gc);
    html = html.replace(/gc-img:(\d{1,4})/g, (all, n) => (Number(n) < images.length ? `img/${m.id}.${n}.${sig(key, m.id, n, m.user_id)}` : ''));
  }
  return {
    ...mailstore.summary(row),
    cc: parse(m.cc_json, []), bcc: parse(m.bcc_json, []), replyTo: parse(m.reply_to_json, []),
    html, text: b ? b.text || '' : (m.snippet || ''), imagesBlocked: blocked, trackers: b ? b.trackers : 0,
    attachments: await attachmentsOf(gc, m), listUnsubscribe: parse(m.unsub_json, null), bodyMissing: !b,
    // since 1.2.0: the invitation of the mail (C6), or null
    invite: await inviteOf(gc, m),
  };
}

/** The Invitation of mail row `m` (calendars on), else null. */
async function inviteOf(gc, m) {
  const cfg = await require('./config').get(gc);
  if (!cfg.calendar.enabled) return null;
  try { return await require('./invites').forMessage(gc, m.user_id, m.id); } catch { return null; }
}

/** GET messages/<id> */
async function get(gc, userId, id) {
  return full(gc, await own(gc, userId, id));
}

/**
 * GET threads/<threadId> → { items } oldest first. Up to 10 missing bodies load at once, waited for timing.bodyMs in
 * all; what is not there by then comes with bodyMissing (the live event with the threadId follows).
 */
async function thread(gc, userId, threadId) {
  const tid = posInt(threadId);
  if (!tid) throw fail('not_found');
  const rows = await store.all(gc, 'SELECT * FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY date, id LIMIT 100', [tid, userId]);
  if (!rows.length) throw fail('not_found');
  const missing = [];
  for (const m of rows) {
    if (missing.length >= 10) break;
    if (!(await store.one(gc, 'SELECT 1 AS x FROM bodies WHERE message_id = ?', [m.id]))) missing.push(m);
  }
  if (missing.length) {
    const accs = new Map();
    const loads = [];
    for (const m of missing) {
      if (!accs.has(m.account_id)) accs.set(m.account_id, await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]));
      loads.push(engine.loadBody(gc, accs.get(m.account_id), m).then(() => null, (e) => e));
    }
    const all = Promise.all(loads);
    const r = await settled(all, timing.bodyMs);
    if (!r.done) for (const accountId of accs.keys()) later(gc, userId, accountId, null, all, { threadId: tid });
    else {
      const bad = r.value.filter((e) => e && !tolerated(e));
      if (bad.length) throw bad.find((e) => e.code === 'auth_failed') || bad[0];
    }
  }
  const out = [];
  for (const m of rows) out.push(await full(gc, m, { load: false }));
  return { items: out };
}

/** POST messages/<id>/images { allow: 'once'|'sender' } → Message */
async function allowImages(gc, userId, id, b) {
  const m = await own(gc, userId, id);
  const allow = b && b.allow;
  if (allow !== 'once' && allow !== 'sender') throw fail('invalid', { field: 'allow' });
  if (!hasImages(gc)) throw fail('images_off');
  const now = Date.now();
  if (allow === 'sender' && m.from_email) await store.run(gc, 'INSERT INTO image_senders (user_id, sender, at) VALUES (?, ?, ?) ON CONFLICT(user_id, sender) DO UPDATE SET at = excluded.at', [userId, m.from_email, now]);
  else await store.run(gc, 'INSERT INTO image_once (message_id, at) VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET at = excluded.at', [m.id, now]);
  return full(gc, m);
}

const imgCache = new Map(); // token → { at, out } (a few recent pictures)

/** GET img/<token> → { mime, size, data } */
async function image(gc, userId, token) {
  const mt = /^(\d{1,15})\.(\d{1,4})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!mt) throw fail('not_found');
  const key = await imgSecret(gc);
  if (sig(key, mt[1], mt[2], userId) !== mt[3]) throw fail('not_found');
  const m = await own(gc, userId, Number(mt[1]));
  if (!hasImages(gc)) throw fail('images_off');
  if (!(await imagesAllowed(gc, m))) throw fail('images_blocked');
  const hit = imgCache.get(token);
  if (hit && Date.now() - hit.at < 600000) return hit.out;
  const b = await store.one(gc, 'SELECT images_json FROM bodies WHERE message_id = ?', [m.id]);
  const url = b ? parse(b.images_json, [])[Number(mt[2])] : null;
  if (!url) throw fail('not_found');
  let r;
  try { r = await gc.http.fetchImage(url, { maxBytes: IMG_MAX, timeoutMs: 15000 }); } catch (e) {
    if (e && e.code === 'ERR_MEDIA_TOO_LARGE') throw fail('too_large');
    throw fail('not_found', { reason: (e && e.code) || 'fetch' });
  }
  const buf = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes || '');
  if (buf.length > IMG_MAX) throw fail('too_large');
  const out = { mime: r.mime, size: buf.length, data: buf.toString('base64') };
  imgCache.set(token, { at: Date.now(), out });
  if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
  return out;
}

/** An attachment of the person's message → { m, t, a }. */
async function attachmentRow(gc, userId, messageId, attId) {
  const m = await own(gc, userId, messageId);
  const t = posInt(attId) ? await store.one(gc, 'SELECT * FROM attachments WHERE id = ? AND message_id = ?', [posInt(attId), m.id]) : null;
  if (!t) throw fail('not_found');
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]);
  return { m, t, a };
}

/**
 * The cached copy of attachment `t` for a person (waited for timing.fileMs at most: then 409 busy { reason: 'loading',
 * retryAfter } — the download goes on, the live event with messageId and attachmentId tells when it is there, and asking
 * again joins it).
 */
async function fileFor(gc, m, t, a) {
  const p = engine.attachment(gc, a, m, t);
  const r = await settled(p, timing.fileMs);
  if (!r.done) {
    later(gc, m.user_id, m.account_id, m.folder_id, p, { messageId: m.id, attachmentId: t.id });
    throw fail('busy', { reason: 'loading', retryAfter: 5 });
  }
  if (r.error) throw r.error;
  return r.value;
}

/** GET messages/<id>/attachments/<aid> → { mediaId, name, mime, size, url, scan? } */
async function attachment(gc, userId, messageId, attId) {
  const { m, t, a } = await attachmentRow(gc, userId, messageId, attId);
  const got = await fileFor(gc, m, t, a);
  // 1.8.0: a copy GateControl's virus scan holds back: 423 quarantined / scan_pending / scan_blocked { scan }
  scan.guard(got.scan);
  // url: a signed address the portal's frame can open (the apps load the media with their token)
  let url = null;
  try { url = await gc.media.url(got.mediaId, { user: userId, ttlS: 3600 }); } catch { url = null; }
  return { mediaId: got.mediaId, name: t.name, mime: got.mime || t.mime, size: got.bytes || t.size, url, ...(got.scan ? { scan: got.scan } : {}) };
}

/** GET cid/<messageId>/<attachmentId> → { mediaId, mime, size, url } (url: a signed address for the portal's frame). */
async function cid(gc, userId, messageId, attId) {
  const { m, t, a } = await attachmentRow(gc, userId, messageId, attId);
  const got = await fileFor(gc, m, t, a);
  scan.guard(got.scan);
  let url = null;
  try { url = await gc.media.url(got.mediaId, { user: userId, ttlS: 3600 }); } catch { url = null; }
  return { mediaId: got.mediaId, mime: got.mime || t.mime, size: got.bytes || t.size, url };
}

// ─── changes ────────────────────────────────────

// 1.13.0: what `all: true` (and `threads: true`) may take in one call (tests lower it)
const bulk = { allMax: 2000 };

async function rowsOf(gc, userId, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw fail('invalid', { field: 'ids' });
  const list = [...new Set(ids.map(posInt))];
  if (list.some((x) => !x)) throw fail('invalid', { field: 'ids' });
  const rows = [];
  for (const part of store.chunks(list)) rows.push(...await store.all(gc, `SELECT * FROM messages WHERE user_id = ? AND id IN (${store.marks(part.length)})`, [userId, ...part]));
  if (!rows.length) throw fail('not_found');
  return rows;
}

/** The filter of a list (box / folder, tab, unread, flagged, attachments) → { where, args } over messages m. */
function filterOf(sc, q) {
  const ids = sc.folders.map((f) => f.id);
  const where = [`m.folder_id IN (${store.marks(ids.length)})`];
  const args = [...ids];
  const tab = q.tab === 'relevant' || q.tab === 'other' ? q.tab : 'all';
  if (sc.inbox && tab !== 'all') { where.push('m.tab = ?'); args.push(tab); }
  if (on(q.unread)) where.push('m.unread = 1');
  if (on(q.flagged)) where.push('m.flagged = 1');
  if (on(q.attachments)) where.push('m.has_att = 1');
  return { where, args };
}

/** 1.13.0: the ids of a list's whole range (every mail, no conversations) → { ids (newest first, ≤ max), total }. */
async function rangeIds(gc, userId, q, max) {
  const sc = await scope(gc, userId, q);
  if (!sc.folders.length) return { ids: [], total: 0 };
  const { where, args } = filterOf(sc, q);
  const total = (await store.one(gc, `SELECT COUNT(*) AS n FROM messages m WHERE ${where.join(' AND ')}`, args)).n;
  const rows = await store.all(gc, `SELECT m.id FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.id DESC LIMIT ?`, [...args, max]);
  return { ids: rows.map((r) => r.id), total };
}

/** GET messages/ids?box=&folder=&tab=&unread=&flagged=&attachments= → { ids, total, max, truncated } (1.13.0) */
async function idsOf(gc, userId, q) {
  const r = await rangeIds(gc, userId, q || {}, bulk.allMax);
  return { ids: r.ids, total: r.total, max: bulk.allMax, truncated: r.total > r.ids.length };
}

async function rowsById(gc, userId, ids) {
  const rows = [];
  for (const part of store.chunks(ids)) rows.push(...await store.all(gc, `SELECT * FROM messages WHERE user_id = ? AND id IN (${store.marks(part.length)})`, [userId, ...part]));
  return rows;
}

/**
 * The mails a change is for (1.13.0): `ids` (≤ 500), or `all: true` with the range of a list (box | folder, tab,
 * filter { unread, flagged, attachments }; `except` ids left out; ≤ bulk.allMax); `threads: true` adds the other mails of each one's
 * conversation in the same folder. → rows (may be empty with `all`).
 */
async function selection(gc, userId, b) {
  const x = b && typeof b === 'object' ? b : {};
  if (x.threads !== undefined && typeof x.threads !== 'boolean') throw fail('invalid', { field: 'threads' });
  let rows;
  if (x.all !== undefined && x.all !== false) {
    if (x.all !== true || x.ids !== undefined) throw fail('invalid', { field: 'all' });
    let except = new Set();
    if (x.except !== undefined) {
      if (!Array.isArray(x.except) || x.except.length > 500 || x.except.some((v) => !posInt(v))) throw fail('invalid', { field: 'except' });
      except = new Set(x.except.map(posInt));
    }
    // the list's filters go in `filter` (unread / flagged at the top are what messages/flags sets)
    let filter = {};
    if (x.filter !== undefined) {
      if (!x.filter || typeof x.filter !== 'object' || Array.isArray(x.filter)) throw fail('invalid', { field: 'filter' });
      filter = x.filter;
    }
    const q = { box: x.box, folder: x.folder, tab: x.tab, unread: filter.unread, flagged: filter.flagged, attachments: filter.attachments };
    const r = await rangeIds(gc, userId, q, bulk.allMax + except.size + 1);
    const ids = r.ids.filter((id) => !except.has(id));
    const count = r.total - [...except].filter((id) => r.ids.includes(id)).length;
    if (count > bulk.allMax || ids.length > bulk.allMax) throw fail('too_large', { max: bulk.allMax, count });
    rows = await rowsById(gc, userId, ids);
  } else rows = await rowsOf(gc, userId, x.ids);
  if (x.threads === true && rows.length) rows = await withThreads(gc, userId, rows);
  return rows;
}

/** The rows and the other mails of their conversations, each in its own folder (1.13.0, `threads: true`). */
async function withThreads(gc, userId, rows) {
  const out = new Map(rows.map((m) => [m.id, m]));
  const byFolder = new Map();
  for (const m of rows) {
    if (m.thread_id == null) continue;
    if (!byFolder.has(m.folder_id)) byFolder.set(m.folder_id, new Set());
    byFolder.get(m.folder_id).add(m.thread_id);
  }
  for (const [folderId, threads] of byFolder) {
    for (const part of store.chunks([...threads], 80)) {
      for (const m of await store.all(gc, `SELECT * FROM messages WHERE user_id = ? AND folder_id = ? AND thread_id IN (${store.marks(part.length)})`, [userId, folderId, ...part])) out.set(m.id, m);
      if (out.size > bulk.allMax) throw fail('too_large', { max: bulk.allMax, count: out.size });
    }
  }
  return [...out.values()];
}

function byAccount(rows) {
  const out = new Map();
  for (const m of rows) { if (!out.has(m.account_id)) out.set(m.account_id, []); out.get(m.account_id).push(m); }
  return out;
}

/** The Summaries of local ids (those still here). */
async function summaries(gc, userId, ids) {
  const rows = [];
  for (const part of store.chunks(ids)) rows.push(...await store.all(gc, `SELECT ${SUMMARY_COLS} FROM messages m WHERE m.user_id = ? AND m.id IN (${store.marks(part.length)})`, [userId, ...part]));
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((x, y) => order.get(x.id) - order.get(y.id));
  return rows.map((r) => mailstore.summary(r));
}

/** The answer of a change: the live events, { ok, items, count, ids } and what `extra` adds (undo, purged). */
async function answer(gc, userId, ids, touched, rows, extra) {
  for (const [accountId, folderIds] of touched) for (const f of folderIds) await push.changed(gc, userId, accountId, f);
  return { ok: true, items: await summaries(gc, userId, ids), count: rows.length, ids: rows.map((m) => m.id), ...(extra || {}) };
}

const touch = (rows) => {
  const t = new Map();
  for (const m of rows) { if (!t.has(m.account_id)) t.set(m.account_id, new Set()); t.get(m.account_id).add(m.folder_id); }
  return t;
};

/** POST messages/flags { ids | all…, unread?, flagged?, threads? } */
async function flags(gc, userId, b) {
  const want = {};
  if (b.unread !== undefined) { if (typeof b.unread !== 'boolean') throw fail('invalid', { field: 'unread' }); want.unread = b.unread; }
  if (b.flagged !== undefined) { if (typeof b.flagged !== 'boolean') throw fail('invalid', { field: 'flagged' }); want.flagged = b.flagged; }
  if (!Object.keys(want).length) throw fail('invalid', { field: 'unread' });
  const rows = await selection(gc, userId, b);
  for (const [accountId, list] of byAccount(rows)) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
    await engine.setFlags(gc, a, list, want);
  }
  return answer(gc, userId, rows.map((m) => m.id), touch(rows), rows);
}

async function folderOfRole(gc, accountId, roles) {
  for (const role of roles) {
    const f = await store.one(gc, 'SELECT * FROM folders WHERE account_id = ? AND role = ?', [accountId, role]);
    if (f) return f;
  }
  return null;
}

/** What engine.move told about the rows of `list` → the entries of an undo (1.13.0). */
function undoEntries(a, list, to, done) {
  const rows = new Map(list.map((m) => [m.id, m]));
  return done.map((d) => ({
    id: d.id, newId: d.kept ? d.id : null, accountId: a.id, fromFolderId: d.fromFolderId, toFolderId: to.id,
    uid: d.uid || null, remoteId: d.remoteId || null, hint: d.hint || null, messageId: (rows.get(d.id) && rows.get(d.id).message_id) || null,
  }));
}

/** Move rows (several accounts) — target(a) → folder row; none → no_folder. kind: the undo's (1.13.0). */
async function moveTo(gc, userId, rows, target, kind) {
  const moved = [];
  const entries = [];
  const t = touch(rows);
  for (const [accountId, list] of byAccount(rows)) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
    const to = await target(a, list);
    if (!to) throw fail('no_folder');
    const done = await engine.move(gc, a, list, to);
    moved.push(...done.filter((d) => d.kept).map((d) => d.id));
    entries.push(...undoEntries(a, list, to, done));
    t.get(accountId).add(to.id);
  }
  return answer(gc, userId, moved, t, rows, { undo: await undo.keep(gc, userId, kind, entries) });
}

/** The target folder of a move or copy: the person's, of the mails' one account (else invalid reason 'account'). */
async function targetOf(gc, userId, b, rows) {
  const f = posInt(b.folderId) ? await store.one(gc, 'SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', [posInt(b.folderId), userId]) : null;
  if (!f) throw fail('not_found', { field: 'folderId' });
  if (rows.some((m) => m.account_id !== f.account_id)) throw fail('invalid', { field: 'folderId', reason: 'account' });
  return f;
}

/** POST messages/move { ids | all…, folderId, threads? } */
async function move(gc, userId, b) {
  if (!posInt(b && b.folderId)) throw fail('not_found', { field: 'folderId' });
  const rows = await selection(gc, userId, b);
  const f = await targetOf(gc, userId, b, rows);
  return moveTo(gc, userId, rows, async () => f, 'move');
}

/**
 * POST messages/copy { ids | all…, folderId, threads? } (1.13.0) — into a folder of the same account (IMAP UID COPY,
 * Graph copy); the target syncs a little so the copies are mostly here in the answer.
 */
async function copy(gc, userId, b) {
  if (!posInt(b && b.folderId)) throw fail('not_found', { field: 'folderId' });
  const rows = await selection(gc, userId, b);
  const f = await targetOf(gc, userId, b, rows);
  const entries = [];
  const created = [];
  if (rows.length) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [f.account_id]);
    const done = await engine.copy(gc, a, rows, f);
    await within(engine.syncOne(gc, a, f), WAIT_MS);
    const byId = new Map(rows.map((m) => [m.id, m]));
    for (const d of done) {
      let copyRow = null;
      if (d.uid) copyRow = await store.one(gc, 'SELECT id FROM messages WHERE folder_id = ? AND uid = ?', [f.id, d.uid]);
      else if (d.remoteId) copyRow = await store.one(gc, 'SELECT id FROM messages WHERE folder_id = ? AND remote_id = ?', [f.id, d.remoteId]);
      if (copyRow) created.push(copyRow.id);
      const m = byId.get(d.id);
      entries.push({ id: d.id, newId: copyRow ? copyRow.id : null, accountId: a.id, fromFolderId: m.folder_id, toFolderId: f.id, uid: d.uid || null, remoteId: d.remoteId || null, hint: d.hint || null, messageId: m.message_id || null });
    }
  }
  const t = touch(rows);
  if (rows.length) t.get(f.account_id).add(f.id);
  return answer(gc, userId, created, t, rows, { undo: await undo.keep(gc, userId, 'copy', entries) });
}

/** POST messages/archive { ids | all…, threads? } — Gmail: out of the posteingang into "All Mail". */
async function archive(gc, userId, b) {
  const rows = await selection(gc, userId, b);
  return moveTo(gc, userId, rows, (a) => folderOfRole(gc, a.id, ['archive', 'all']), 'archive');
}

/** POST messages/delete { ids | all…, threads? } — into the trash; what is in the trash (or without one) goes for good. */
async function remove(gc, userId, b) {
  const rows = await selection(gc, userId, b);
  const t = touch(rows);
  const moved = [];
  const purged = [];
  const entries = [];
  for (const [accountId, list] of byAccount(rows)) {
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
    const trash = await folderOfRole(gc, a.id, ['trash']);
    const inTrash = trash ? list.filter((m) => m.folder_id === trash.id) : list;
    const rest = trash ? list.filter((m) => m.folder_id !== trash.id) : [];
    if (inTrash.length) { await engine.destroy(gc, a, inTrash); purged.push(...inTrash.map((m) => m.id)); }
    if (rest.length) {
      const done = await engine.move(gc, a, rest, trash);
      moved.push(...done.filter((d) => d.kept).map((d) => d.id));
      entries.push(...undoEntries(a, rest, trash, done));
      t.get(accountId).add(trash.id);
    }
  }
  return answer(gc, userId, moved, t, rows, { undo: await undo.keep(gc, userId, 'delete', entries), purged });
}

/** POST messages/junk { ids | all…, threads? } */
async function junk(gc, userId, b) {
  const rows = await selection(gc, userId, b);
  return moveTo(gc, userId, rows, (a) => folderOfRole(gc, a.id, ['junk']), 'junk');
}

/** POST messages/undo { token } (1.13.0) */
async function undoChange(gc, userId, b) {
  return undo.run(gc, userId, b, summaries);
}

/** POST messages/tab { ids | all…, tab, threads? } — the person sorts: learned per sender. */
async function tab(gc, userId, b) {
  const tb = b && b.tab;
  if (tb !== 'relevant' && tb !== 'other') throw fail('invalid', { field: 'tab' });
  const rows = await selection(gc, userId, b);
  const now = Date.now();
  for (const part of store.chunks(rows.map((m) => m.id))) await store.run(gc, `UPDATE messages SET tab = ?, tab_by = 'user', ai_pending = 0 WHERE id IN (${store.marks(part.length)})`, [tb, ...part]);
  for (const from of new Set(rows.map((m) => m.from_email).filter(Boolean))) {
    await classify.learn(gc, userId, from, tb, now);
    // the sender's other mail in the posteingänge follows, unless the person sorted it by hand
    await store.run(gc, `UPDATE messages SET tab = ?, tab_by = 'learned', ai_pending = 0 WHERE user_id = ? AND from_email = ? AND (tab_by IS NULL OR tab_by <> 'user')
      AND folder_id IN (SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE a.user_id = ? AND f.role = 'inbox')`, [tb, userId, from, userId]);
  }
  return answer(gc, userId, rows.map((m) => m.id), touch(rows), rows);
}

/** Unread mail of the posteingänge: { all, byAccount: { id: n } } */
async function unread(gc, userId) {
  // 1.10.1: per posteingang from the index messages_unread — before, every mail of the person was read (each GET me)
  const rows = await store.all(gc, `SELECT f.account_id, COUNT(*) AS n FROM folders f JOIN accounts a ON a.id = f.account_id
    JOIN messages m INDEXED BY messages_unread ON m.folder_id = f.id AND m.unread = 1 WHERE a.user_id = ? AND f.role = 'inbox' GROUP BY f.account_id`, [userId]);
  const by = {};
  let all = 0;
  for (const r of rows) { by[String(r.account_id)] = r.n; all += r.n; }
  return { all, byAccount: by };
}

function reset() { secret = null; imgCache.clear(); }

module.exports = {
  reset, folders, list, search, get, thread, allowImages, image, attachment, cid, flags, move, copy, archive, remove, junk, tab, unread, own, full, attachmentRow,
  idsOf, undoChange, bulk,
  folderOfRole, within, settled, timing,
};
