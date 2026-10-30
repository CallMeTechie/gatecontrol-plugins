'use strict';

// The sync engine: one worker per account, everything of an account in order (a chain of promises). IMAP accounts keep
// a session with IDLE on the posteingang (new mail → a sync of the posteingang at once), the other folders every 15
// minutes and when a list of them is opened; Microsoft accounts are asked every minute (posteingang) and every 15
// minutes (the rest). A session that breaks is opened again in the next background run (with a growing pause); a
// refused sign-in marks the account auth_failed until the person enters the password again or signs in anew.
// GateControl allows the plugin MAX_SESSIONS IMAP sessions at once — beyond them an account works with a session per run.

const store = require('./store');
const config = require('./config');
const secrets = require('./secrets');
const providers = require('./providers');
const imap = require('./imap');
const graph = require('./graph');
const ms = require('./microsoft');
const mailstore = require('./mailstore');
const push = require('./push');
const { fail, MONTH } = require('./util');

const MAX_SESSIONS = 90;
const INBOX_IMAP_MS = 5 * 60000;
const INBOX_GRAPH_MS = 60000;
const FOLDERS_MS = 15 * 60000;
const RECONCILE_MS = 5 * 60000;
const ARRIVAL_BODIES = 20;
const BACKFILL = 10;
const ATT_ALWAYS_MAX = 10 * 1024 * 1024;
const ATT_MAX = 50 * 1024 * 1024;
const BODY_MAX = 50 * 1024 * 1024;

const st = new Map();
let stopped = false;
let gcRef = null;

const isGraph = (a) => providers.isMicrosoft(a.provider);

function stateOf(id) {
  let s = st.get(id);
  if (!s) { s = { chain: Promise.resolve(), s: null, openPath: null, retryAt: 0, pause: 0, dirty: false, lastInbox: 0, lastAll: 0, lastReconcile: 0, timer: null }; st.set(id, s); }
  return s;
}

/** Run fn for account `a` after whatever runs for it now. */
function run(gc, a, fn) {
  const x = stateOf(a.id);
  const p = x.chain.then(() => fn(x), () => fn(x));
  x.chain = p.catch(() => {});
  return p;
}

async function row(gc, id) {
  return store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [id]);
}

/** Account state ok | syncing | auth_failed | unreachable (+ the error code) and the live event. */
async function setState(gc, a, state, code) {
  if (a.state === state && (a.error_code || null) === (code || null)) return;
  const at = code ? Date.now() : null;
  await store.run(gc, 'UPDATE accounts SET state = ?, error_code = ?, error_at = ? WHERE id = ?', [state, code || null, at, a.id]);
  Object.assign(a, { state, error_code: code || null, error_at: at });
  await push.changed(gc, a.user_id, a.id, null);
}

const openSessions = () => [...st.values()].filter((x) => x.s).length;

/** gc.mail's refusals → the account's state; throws the API code. */
async function mailError(gc, a, e) {
  const code = e && e.code;
  if (code === 'ERR_MAIL_AUTH' || (e && e.auth) || code === 'auth_failed') { await setState(gc, a, 'auth_failed', 'auth'); return fail('auth_failed'); }
  if (code === 'ERR_MAIL_NET' || code === 'ERR_NETWORK_DENIED' || code === 'unreachable' || code === 'ERR_MAIL_PROTOCOL') {
    await setState(gc, a, 'unreachable', code === 'ERR_NETWORK_DENIED' ? 'network_denied' : code === 'ERR_MAIL_PROTOCOL' ? 'protocol' : 'network');
    return fail('unreachable');
  }
  if (code === 'ERR_MAIL_LIMIT' || code === 'busy') return fail('busy');
  return e;
}

/** Connect options of IMAP account `a`. */
async function imapOpts(gc, a) {
  const cred = await secrets.get(gc, a.id);
  if (!cred || !cred.password) throw Object.assign(fail('auth_failed'), { auth: true });
  return { host: a.imap_host, port: a.imap_port, security: a.imap_security, auth: { user: a.username || a.email, pass: cred.password }, timeoutMs: 30000 };
}

/** The account's IMAP session (opened when needed, IDLE events wired). */
async function session(gc, a, x) {
  if (x.s) return x.s;
  if (!gc.mail || !gc.mail.imap) throw fail('unreachable');
  const s = await gc.mail.imap.connect(await imapOpts(gc, a));
  x.s = s;
  x.openPath = null;
  x.pause = 0;
  const drop = () => { if (x.s === s) { x.s = null; x.openPath = null; } };
  s.on('close', drop);
  s.on('error', drop);
  s.on('exists', () => { x.dirty = true; soon(a.id); });
  s.on('expunge', () => { x.dirty = true; soon(a.id); });
  s.on('flags', () => { x.dirty = true; soon(a.id); });
  return s;
}

/** A sync of the posteingang shortly (new mail during IDLE). */
function soon(accountId) {
  const x = stateOf(accountId);
  if (x.timer || stopped || !gcRef) return;
  x.timer = setTimeout(async () => {
    x.timer = null;
    const a = await row(gcRef, accountId).catch(() => null);
    if (a) await syncInbox(gcRef, a).catch(() => {});
  }, 800);
  if (x.timer.unref) x.timer.unref();
}

/** After work in another folder: back to the posteingang and IDLE (persistent sessions). */
async function backToIdle(gc, a, x) {
  if (!x.s || isGraph(a)) return;
  const inbox = await store.one(gc, "SELECT path FROM folders WHERE account_id = ? AND role = 'inbox'", [a.id]);
  if (!inbox) return;
  try {
    if (x.openPath !== inbox.path) { await x.s.open(inbox.path, { readOnly: false }); x.openPath = inbox.path; }
    await x.s.idle();
  } catch { x.s = null; x.openPath = null; }
}

/**
 * Work with the account's session (IMAP) inside its chain: fn(s) for IMAP, fn(null) for Microsoft. A session beyond
 * MAX_SESSIONS is closed after the work.
 */
function withAccount(gc, a, fn) {
  return run(gc, a, async (x) => {
    if (isGraph(a)) {
      try { return await fn(null, x); } catch (e) { throw await mailError(gc, a, e); }
    }
    const temp = !x.s && openSessions() >= MAX_SESSIONS;
    let s;
    try { s = await session(gc, a, x); } catch (e) { x.retryAt = Date.now() + backoff(x); throw await mailError(gc, a, e); }
    try {
      const out = await fn(s, x);
      return out;
    } catch (e) {
      if (e && (e.code === 'ERR_MAIL_NET' || e.code === 'ERR_MAIL_PROTOCOL')) { try { await s.close(); } catch { /* gone */ } x.s = null; }
      throw await mailError(gc, a, e);
    } finally {
      if (temp && x.s) { try { await x.s.close(); } catch { /* gone */ } x.s = null; x.openPath = null; } else await backToIdle(gc, a, x);
    }
  });
}

function backoff(x) {
  x.pause = Math.min(x.pause ? x.pause * 2 : 30000, 30 * 60000);
  return x.pause;
}

/** Open folder `f` for work (IMAP) — remembers which one is open. */
async function openFolder(s, x, f, readOnly = false) {
  if (x.openPath === f.path && !readOnly) return;
  await s.open(f.path, { readOnly });
  x.openPath = readOnly ? null : f.path;
}

// ─── syncing ────────────────────────────────────

async function foldersOf(gc, a) {
  return store.all(gc, 'SELECT * FROM folders WHERE account_id = ?', [a.id]);
}

/** Sync the posteingang of account `a` now (in its chain). → { created } */
async function syncInbox(gc, a, o = {}) {
  const cfg = await config.get(gc);
  const since = config.retentionStart(cfg, Date.now());
  const created = [];
  await withAccount(gc, a, async (s, x) => {
    let folders = await foldersOf(gc, a);
    if (!folders.length || Date.now() - x.lastAll > FOLDERS_MS * 4) {
      folders = isGraph(a) ? await graph.syncFolders(gc, a) : await imap.syncFolders(gc, a, s, Date.now());
    }
    const inbox = folders.find((f) => f.role === 'inbox');
    if (!inbox) return;
    const arrival = a.first_done === 1;
    const reconcile = Date.now() - x.lastReconcile > RECONCILE_MS;
    const r = isGraph(a) ? await graph.syncFolder(gc, a, inbox, { since, arrival })
      : await imap.syncFolder(gc, a, s, inbox, { since, arrival, reconcile, budget: o.budget });
    if (!isGraph(a)) x.openPath = inbox.path;
    if (reconcile) x.lastReconcile = Date.now();
    x.dirty = false;
    x.lastInbox = Date.now();
    created.push(...r.created);
    const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [inbox.id]);
    // the newest bodies at once (snippets; new mail: before its push), the rest in the background
    await afterArrivalInChain(gc, a, s, x, r.created);
    if (arrival) { /* first_done already */ } else if (f && (isGraph(a) ? !!f.synced_at : (f.uid_next != null && !f.low_uid))) {
      // the first sync of the posteingang is through: new mail from now on is "arrival" (pushes, bodies at once)
      await store.run(gc, 'UPDATE accounts SET first_done = 1 WHERE id = ?', [a.id]);
      a.first_done = 1;
    }
    await store.run(gc, 'UPDATE accounts SET synced_at = ? WHERE id = ?', [Date.now(), a.id]);
    if (a.state !== 'ok') await setState(gc, a, 'ok', null);
    if (r.changed) await push.changed(gc, a.user_id, a.id, inbox.id);
  });
  if (a.first_done === 1 && created.length) await push.newMail(gc, a);
  return { created };
}

/** In the chain already: bodies of new mail. */
async function afterArrivalInChain(gc, a, s, x, created) {
  if (!created.length) return;
  const ids = created.slice(-ARRIVAL_BODIES);
  const rows = await store.all(gc, `SELECT * FROM messages WHERE id IN (${store.marks(ids.length)})`, ids);
  for (const m of rows) {
    try { await bodyNow(gc, a, s, x, m); } catch (e) { if (e && (e.code === 'ERR_MAIL_AUTH' || e.auth)) throw e; }
  }
}

/** Sync every other folder of account `a` (the posteingang has its own rhythm). */
async function syncAll(gc, a) {
  const cfg = await config.get(gc);
  const since = config.retentionStart(cfg, Date.now());
  await withAccount(gc, a, async (s, x) => {
    const folders = isGraph(a) ? await graph.syncFolders(gc, a) : await imap.syncFolders(gc, a, s, Date.now());
    x.lastAll = Date.now();
    for (const f of folders) {
      if (f.role === 'inbox' || f.role === 'all') continue;
      try {
        const r = isGraph(a) ? await graph.syncFolder(gc, a, f, { since, arrival: false }) : await imap.syncFolder(gc, a, s, f, { since, arrival: false, reconcile: true, budget: 200 });
        if (!isGraph(a)) x.openPath = f.path;
        if (r.changed) await push.changed(gc, a.user_id, a.id, f.id);
      } catch (e) {
        if (e && (e.code === 'ERR_MAIL_AUTH' || e.auth || e.code === 'auth_failed' || e.code === 'ERR_MAIL_NET')) throw e;
        gc.log.warn('folder sync failed', a.id, (e && e.code) || 'error');
      }
    }
  });
}

/** One folder now (a list of it was opened and its copy is older than a few minutes). */
async function syncOne(gc, a, f) {
  const cfg = await config.get(gc);
  const since = config.retentionStart(cfg, Date.now());
  await withAccount(gc, a, async (s, x) => {
    const r = isGraph(a) ? await graph.syncFolder(gc, a, f, { since, arrival: false }) : await imap.syncFolder(gc, a, s, f, { since, arrival: false, reconcile: true, budget: 200 });
    if (!isGraph(a)) x.openPath = f.path;
    return r;
  });
}

/** Headers of folder `f` older than `before` from the server (a list scrolled past the retention). */
async function loadOlder(gc, a, f, before, count = 50) {
  return withAccount(gc, a, async (s, x) => {
    const r = isGraph(a) ? await graph.older(gc, a, f, before, count) : await imap.older(gc, a, s, f, before, count);
    if (!isGraph(a)) x.openPath = null;
    return r;
  });
}

// ─── bodies and attachments ─────────────────────

/** Sanitize and store a parsed mail of row `m` (in the chain). */
async function storeParsed(gc, a, m, p) {
  const now = Date.now();
  let html = null;
  let images = [];
  let trackers = 0;
  if (p.html) {
    const san = await gc.mail.sanitize(p.html, { images: 'placeholder' });
    html = san.html; images = san.images || []; trackers = san.trackers || 0;
  }
  await mailstore.setBody(gc, m.id, { html, text: p.text, images, trackers }, now);
  await mailstore.setAttachments(gc, m.id, p.attachments || [], now);
  // a Microsoft message: List-Id & co. only come with the body — the rules may decide now
  if (p.headers && m.tab_by !== 'user' && m.tab_by !== 'learned') {
    const h = p.headers;
    const pick = (k) => (h[k] == null ? null : String(Array.isArray(h[k]) ? h[k][0] : h[k]));
    if (pick('list-id') || /^(bulk|list|junk)$/i.test(pick('precedence') || '') || (pick('auto-submitted') && !/^no$/i.test(pick('auto-submitted')))) {
      await store.run(gc, "UPDATE messages SET tab = 'other', tab_by = 'rule', ai_pending = 0, list_id = COALESCE(list_id, ?) WHERE id = ?", [pick('list-id'), m.id]);
    }
  }
  const cfg = await config.get(gc);
  if (cfg.attachments === 'always') {
    const atts = await store.all(gc, 'SELECT * FROM attachments WHERE message_id = ? AND media_id IS NULL AND inline = 0 AND size <= ?', [m.id, ATT_ALWAYS_MAX]);
    for (const t of atts) { try { await downloadNow(gc, a, m, t, null, null); } catch { /* on demand later */ } }
  }
}

/** The body of row `m` from the server in the chain. */
async function bodyNow(gc, a, s, x, m) {
  const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [m.folder_id]);
  if (!f) throw fail('not_found');
  let p;
  if (isGraph(a)) p = await graph.message(gc, a, m);
  else {
    try { p = await imap.message(s, f, m); } catch (e) {
      if (!e || e.code !== 'ERR_MAIL_LIMIT') throw e;
      // larger than 25 MB: once more with GateControl's most (50 MB), else the headers only
      try { p = await imap.message(s, f, m, BODY_MAX); } catch (e2) {
        if (!e2 || e2.code !== 'ERR_MAIL_LIMIT') throw e2;
        p = { html: null, text: m.snippet || '', attachments: [] };
      }
    }
    x.openPath = null;
  }
  if (!p) throw fail('not_found');
  await storeParsed(gc, a, m, p);
}

/** The body of message row `m` (from the server when it is not here). */
async function loadBody(gc, a, m, o = {}) {
  void o;
  return withAccount(gc, a, (s, x) => bodyNow(gc, a, s, x, m));
}

/** An attachment into the plugin's media (claimed) → { mediaId, bytes }. In the chain when s / x are given. */
async function downloadNow(gc, a, m, t, s, x) {
  let got;
  if (isGraph(a)) got = await graph.download(gc, a, m, t, ATT_MAX);
  else {
    const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [m.folder_id]);
    const sess = s || (stateOf(a.id).s);
    if (!sess) throw fail('unreachable');
    got = await imap.download(sess, f, m, t, ATT_MAX);
    if (x) x.openPath = null; else stateOf(a.id).openPath = null;
  }
  await gc.media.claim(got.mediaId);
  const bytes = Number(got.bytes) || Number(t.size) || 0;
  await store.run(gc, 'UPDATE attachments SET media_id = ?, media_bytes = ?, used_at = ? WHERE id = ?', [got.mediaId, bytes, Date.now(), t.id]);
  return { mediaId: got.mediaId, bytes, mime: got.mime || t.mime };
}

/** The cached copy of attachment `t` of row `m` (downloaded when needed). */
async function attachment(gc, a, m, t) {
  if (t.media_id) {
    const info = await gc.media.info(t.media_id).catch(() => null);
    if (info) {
      await store.run(gc, 'UPDATE attachments SET used_at = ? WHERE id = ?', [Date.now(), t.id]);
      return { mediaId: t.media_id, bytes: info.bytes, mime: info.mime || t.mime };
    }
  }
  return withAccount(gc, a, (s, x) => downloadNow(gc, a, m, t, s, x));
}

// ─── changes the person makes ───────────────────

/** Flags of rows `list` (one account): { unread?, flagged?, answered? } — on the server, then here. */
async function setFlags(gc, a, list, want) {
  if (!list.length) return;
  await withAccount(gc, a, async (s, x) => {
    if (isGraph(a)) {
      for (const m of list) {
        const body = {};
        if (want.unread != null) body.isRead = !want.unread;
        if (want.flagged != null) body.flag = { flagStatus: want.flagged ? 'flagged' : 'notFlagged' };
        if (Object.keys(body).length) await graph.patch(gc, a, m, body);
      }
    } else {
      for (const [folderId, rows] of byFolder(list)) {
        const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [folderId]);
        if (!f) continue;
        await openFolder(s, x, f);
        const uids = rows.map((r) => r.uid).filter(Number.isSafeInteger);
        if (!uids.length) continue;
        const add = []; const rem = [];
        if (want.unread === true) rem.push('\\Seen'); else if (want.unread === false) add.push('\\Seen');
        if (want.flagged === true) add.push('\\Flagged'); else if (want.flagged === false) rem.push('\\Flagged');
        if (want.answered === true) add.push('\\Answered');
        if (add.length) await s.flags(uids, { add });
        if (rem.length) await s.flags(uids, { remove: rem });
      }
    }
  });
  const sets = [];
  const args = [];
  if (want.unread != null) { sets.push('unread = ?'); args.push(want.unread ? 1 : 0); }
  if (want.flagged != null) { sets.push('flagged = ?'); args.push(want.flagged ? 1 : 0); }
  if (want.answered != null) { sets.push('answered = ?'); args.push(want.answered ? 1 : 0); }
  for (const part of store.chunks(list.map((m) => m.id))) await store.run(gc, `UPDATE messages SET ${sets.join(', ')} WHERE id IN (${store.marks(part.length)})`, [...args, ...part]);
}

function byFolder(list) {
  const out = new Map();
  for (const m of list) { if (!out.has(m.folder_id)) out.set(m.folder_id, []); out.get(m.folder_id).push(m); }
  return out;
}

/** Move rows `list` (one account) to folder row `to`; on the server, then here (new uid / id where known). */
async function move(gc, a, list, to) {
  const moved = [];
  await withAccount(gc, a, async (s, x) => {
    for (const [folderId, rows] of byFolder(list)) {
      if (folderId === to.id) continue;
      const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [folderId]);
      if (!f) continue;
      if (isGraph(a)) {
        for (const m of rows) {
          const nid = await graph.move(gc, a, m, to);
          await store.run(gc, 'UPDATE messages SET folder_id = ?, remote_id = ? WHERE id = ?', [to.id, nid || m.remote_id, m.id]).catch(async () => { await mailstore.remove(gc, [m.id]); });
          moved.push(m.id);
        }
        continue;
      }
      await openFolder(s, x, f);
      const uids = rows.map((r) => r.uid).filter(Number.isSafeInteger);
      if (!uids.length) continue;
      const res = await s.move(uids, to.path);
      const map = (res && res.uidMap) || {};
      for (const m of rows) {
        const nu = map[m.uid] != null ? Number(map[m.uid]) : null;
        if (nu) await store.run(gc, 'UPDATE messages SET folder_id = ?, uid = ? WHERE id = ?', [to.id, nu, m.id]).catch(async () => { await mailstore.remove(gc, [m.id]); });
        else await mailstore.remove(gc, [m.id]); // it comes back with the next sync of the target
        moved.push(m.id);
      }
    }
  });
  return moved;
}

/** Delete rows `list` for good (they are in the trash). */
async function destroy(gc, a, list) {
  await withAccount(gc, a, async (s, x) => {
    for (const [folderId, rows] of byFolder(list)) {
      const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [folderId]);
      if (!f) continue;
      if (isGraph(a)) { for (const m of rows) await graph.destroy(gc, a, m); continue; }
      await openFolder(s, x, f);
      const uids = rows.map((r) => r.uid).filter(Number.isSafeInteger);
      if (!uids.length) continue;
      await s.flags(uids, { add: ['\\Deleted'] });
      await s.expunge(uids);
    }
  });
  await mailstore.remove(gc, list.map((m) => m.id));
}

/** The sent mail (raw media) into the account's Sent folder (IMAP; Gmail and Microsoft keep it themselves). */
async function appendSent(gc, a, rawMediaId) {
  const sent = await store.one(gc, "SELECT * FROM folders WHERE account_id = ? AND role = 'sent'", [a.id]);
  if (!sent) return;
  await withAccount(gc, a, async (s, x) => {
    await s.append(sent.path, rawMediaId, { flags: ['\\Seen'] });
    x.openPath = null;
  });
}

/** Search the account's server beyond the retention → created / found rows. */
async function remoteSearch(gc, a, q) {
  const found = [];
  await withAccount(gc, a, async (s, x) => {
    const folders = await foldersOf(gc, a);
    if (isGraph(a)) {
      for (const g of await graph.search(gc, a, q.text)) {
        const f = folders.find((ff) => ff.remote_id === g.parentFolderId);
        if (!f) continue;
        const r = await mailstore.upsert(gc, a, f, graph.headerOf(g), { arrival: false });
        found.push(r.id);
      }
      return;
    }
    const search = q.text ? { or: [{ subject: q.text }, { from: q.text }, { body: q.text }] } : { uid: '1:*' };
    if (q.after) search.since = new Date(q.after).toISOString();
    if (q.before) search.before = new Date(q.before).toISOString();
    for (const f of folders.filter((ff) => ff.role === 'inbox' || ff.role === 'archive' || ff.role === 'sent')) {
      const uids = await imap.search(s, f, search);
      x.openPath = null;
      const known = new Set((await store.all(gc, `SELECT uid FROM messages WHERE folder_id = ? AND uid IN (${store.marks(Math.min(uids.length, 90) || 1)})`, [f.id, ...(uids.slice(0, 90).length ? uids.slice(0, 90) : [0])])).map((r) => r.uid));
      const want = uids.filter((u) => !known.has(u)).slice(0, 25);
      if (want.length) {
        await s.open(f.path, { readOnly: true });
        for (const e of await imap.fetchUids(s, want)) {
          const r = await mailstore.upsert(gc, a, f, imap.headerOf(e), { arrival: false });
          found.push(r.id);
        }
      }
      for (const u of uids) if (known.has(u)) { const r = await store.one(gc, 'SELECT id FROM messages WHERE folder_id = ? AND uid = ?', [f.id, u]); if (r) found.push(r.id); }
    }
  });
  return found;
}

// ─── the background run ─────────────────────────

/** Bodies of mail without one (newest first, within the quota) — BACKFILL per account and run. */
async function backfill(gc, a, quota) {
  if (await mailstore.usage(gc, a.user_id) > quota * 0.85) return 0;
  const rows = await store.all(gc, `SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.account_id = ? AND m.body_state = 'none'
    AND f.role IN ('inbox', 'sent', 'archive') ORDER BY m.date DESC LIMIT ?`, [a.id, BACKFILL]);
  if (!rows.length) return 0;
  await withAccount(gc, a, async (s, x) => {
    for (const m of rows) {
      try { await bodyNow(gc, a, s, x, m); } catch (e) {
        if (e && (e.code === 'ERR_MAIL_AUTH' || e.auth || e.code === 'ERR_MAIL_NET')) throw e;
        await store.run(gc, "UPDATE messages SET body_state = 'failed' WHERE id = ?", [m.id]);
      }
    }
  });
  return rows.length;
}

/** Mail older than the retention that nobody looked at for a week goes (with its body and attachments). */
async function retention(gc, cfg, now) {
  const since = config.retentionStart(cfg, now);
  if (!since) return 0;
  const rows = await store.all(gc, 'SELECT id FROM messages WHERE date < ? AND (seen_at IS NULL OR seen_at < ?) AND flagged = 0 LIMIT 2000', [since, now - 7 * 86400000]);
  if (rows.length) await mailstore.remove(gc, rows.map((r) => r.id));
  return rows.length;
}

/**
 * The background run (every 15 s, GateControl's tick; ≤ budgetMs): per account the posteingang when due (IMAP: lost
 * session, a new-mail event, every 5 minutes; Microsoft: every minute), the other folders every 15 minutes, a few bodies.
 */
async function tick(gc, now, budgetMs = 60000, skipUsers = new Set()) {
  gcRef = gc;
  const started = Date.now();
  const cfg = await config.get(gc);
  const accounts = await store.all(gc, "SELECT * FROM accounts WHERE state <> 'auth_failed' ORDER BY COALESCE(synced_at, 0)");
  for (const a of accounts) {
    if (Date.now() - started > budgetMs) break;
    // a person an administrator switched off (seats.js): their accounts rest
    if (skipUsers.has(a.user_id)) continue;
    const x = stateOf(a.id);
    if (x.retryAt > now) continue;
    const due = isGraph(a) ? now - x.lastInbox >= INBOX_GRAPH_MS : (!x.s || x.dirty || now - x.lastInbox >= INBOX_IMAP_MS);
    try {
      if (due || a.first_done !== 1) await syncInbox(gc, a);
      if (now - x.lastAll >= FOLDERS_MS && a.first_done === 1) await syncAll(gc, a);
      else if (a.first_done === 1) await backfill(gc, a, config.quotaBytes(cfg));
      x.retryAt = 0;
    } catch (e) {
      if (!x.retryAt || x.retryAt <= now) x.retryAt = Date.now() + backoff(x);
      if (e && e.code !== 'auth_failed' && e.code !== 'unreachable' && e.code !== 'busy') gc.log.warn('sync failed', a.id, (e && e.code) || 'error');
    }
  }
  return { accounts: accounts.length };
}

/** Start: the sessions come with the first background run. */
function start(gc) { gcRef = gc; stopped = false; st.clear(); }

async function stop() {
  stopped = true;
  for (const x of st.values()) {
    if (x.timer) { clearTimeout(x.timer); x.timer = null; }
    if (x.s) { try { await x.s.close(); } catch { /* gone */ } x.s = null; }
  }
}

/** An account was removed or its credentials changed: drop its session and tokens. */
async function forget(accountId) {
  const x = st.get(accountId);
  if (x) {
    if (x.timer) clearTimeout(x.timer);
    if (x.s) { try { await x.s.close(); } catch { /* gone */ } }
    st.delete(accountId);
  }
  ms.forget(accountId);
}

/** Test an IMAP login (POST accounts) → the session (kept for the account) or throws gc.mail's error. */
async function probe(gc, opts) {
  return gc.mail.imap.connect(opts);
}

/** Adopt a probed session for a new account. */
function adopt(gc, a, s) {
  const x = stateOf(a.id);
  x.s = s;
  const drop = () => { if (x.s === s) { x.s = null; x.openPath = null; } };
  s.on('close', drop);
  s.on('error', drop);
  s.on('exists', () => { x.dirty = true; soon(a.id); });
}

module.exports = {
  run, withAccount, syncInbox, syncAll, syncOne, loadOlder, loadBody, attachment, setFlags, move, destroy, appendSent, remoteSearch, retention,
  tick, start, stop, forget, probe, adopt, setState, isGraph, mailError, stateOf, backfill, MONTH,
};
