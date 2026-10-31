'use strict';

// The sync engine: one worker per account, the work of an account in order (its line of steps). IMAP accounts keep
// a session with IDLE on the posteingang (new mail → a sync of the posteingang at once), the other folders every 15
// minutes and when a list of them is opened; Microsoft accounts are asked every minute (posteingang) and every 15
// minutes (the rest). A session that breaks is opened again in the next background run (with a growing pause); a
// refused sign-in marks the account auth_failed until the person enters the password again or signs in anew.
// GateControl allows the plugin MAX_SESSIONS IMAP sessions at once — beyond them an account works with a session per run.
//
// Syncing goes in short steps (a folder listing, a Graph delta page, an IMAP folder run with a budget, a body), each a
// job of the line — never a whole first sync in one go. What a person waits for never waits behind a sync:
// * Microsoft: bodies, attachments, flags, moves and deletes go beside the line (Graph is plain HTTP; at most
//   DIRECT_PER_ACCOUNT requests of the person per mailbox at once). The access token is renewed once for all
//   (microsoft.js).
// * IMAP: a body or an attachment runs at once in the line when it is free; while a step runs, on a short session of
//   its own beside it (closed right after; at most SIDE_PER_ACCOUNT per account and SIDE_MAX in all, within the plugin's
//   maxConnections) — an IMAP command cannot be broken off and one session has one open mailbox, so sharing the busy
//   session is no option, and a step (300 headers, a large body) may take longer than the person can wait. Without a
//   free short session, and for flags, moves and deletes, the work goes first in the line, before the waiting steps.
// A body or an attachment that loads already is joined, never loaded twice.

const store = require('./store');
const config = require('./config');
const secrets = require('./secrets');
const providers = require('./providers');
const imap = require('./imap');
const graph = require('./graph');
const ms = require('./microsoft');
const mailstore = require('./mailstore');
const push = require('./push');
const storage = require('./storage');
const { fail, MONTH } = require('./util');

const MAX_SESSIONS = 90;
const MAX_CONNECTIONS = 100;          // plugin.json permissions.mail.maxConnections
const SIDE_MAX = 8;
const SIDE_PER_ACCOUNT = 2;
const DIRECT_PER_ACCOUNT = 3;         // Graph allows 4 requests at once per mailbox — one stays for the sync
const FIRST_STEP = 50;                // the first step of a first sync: the newest mail of the posteingang
const PAGES = 10;                     // Graph delta pages per folder and run (a step each)
const LIVE_MS = 5000;                 // the live event while a long sync goes on, at most this often per folder
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
const bodies = new Map();   // message id → the load of its body that runs
const files = new Map();    // attachment id → its download that runs
const waited = new Set();   // since 1.5.0: message ids whose prefetch waited for room at GateControl (storage.js)
const WAITED_MAX = 1000;
const WAITED_PER_RUN = 5;
let sideOpen = 0;
let stopped = false;
let gcRef = null;

const isGraph = (a) => providers.isMicrosoft(a.provider);

function stateOf(id) {
  let s = st.get(id);
  if (!s) {
    s = {
      prio: [], queue: [], busy: false, s: null, openPath: null, retryAt: 0, pause: 0, dirty: false, lastInbox: 0, lastAll: 0, lastReconcile: 0, timer: null,
      side: 0, direct: 0, directWait: [], inbox: null, again: false, newest: new Set(), liveAt: new Map(),
    };
    st.set(id, s);
  }
  return s;
}

/**
 * Run fn(x) for account `a` in its line, after the step that runs now: `prio` (a person waits) before the waiting
 * background steps, else after them.
 */
function run(gc, a, fn, o = {}) {
  const x = stateOf(a.id);
  return new Promise((resolve, reject) => {
    (o.prio ? x.prio : x.queue).push({ fn, resolve, reject });
    pump(x);
  });
}

async function pump(x) {
  if (x.busy) return;
  x.busy = true;
  let job;
  while ((job = x.prio.shift() || x.queue.shift())) {
    try { job.resolve(await job.fn(x)); } catch (e) { job.reject(e); }
  }
  x.busy = false;
}

const waiting = (x) => x.prio.length + x.queue.length;

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
  if (code === 'busy') return e;
  if (code === 'ERR_MAIL_LIMIT') return fail('busy');
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
 * Work with the account's session (IMAP) inside its line: fn(s) for IMAP, fn(null) for Microsoft. A session beyond
 * MAX_SESSIONS is closed after the work; else it goes back to the posteingang and IDLE — unless more work waits or
 * follows at once (o.stay: the next step of the same run). o: { prio (run), stay }.
 */
function withAccount(gc, a, fn, o = {}) {
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
      if (temp && x.s) { try { await x.s.close(); } catch { /* gone */ } x.s = null; x.openPath = null; } else if (!waiting(x) && !o.stay) await backToIdle(gc, a, x);
    }
  }, o);
}

/** Microsoft: work of a person beside the account's line — at most DIRECT_PER_ACCOUNT at once (the rest waits for a turn). */
async function direct(gc, a, fn) {
  const x = stateOf(a.id);
  if (x.direct >= DIRECT_PER_ACCOUNT) await new Promise((r) => x.directWait.push(r)); else x.direct++;
  try {
    return await fn();
  } catch (e) {
    throw await mailError(gc, a, e);
  } finally {
    // the turn goes straight to the next one waiting
    const next = x.directWait.shift();
    if (next) next(); else x.direct--;
  }
}

const NO_SIDE = Symbol('no side session');

/** IMAP: fn(s, x) on a short session of its own (closed after) → its result, or NO_SIDE when none could be opened. */
async function beside(gc, a, x, fn) {
  x.side++;
  sideOpen++;
  let s = null;
  try {
    try {
      s = await gc.mail.imap.connect(await imapOpts(gc, a));
    } catch {
      // the provider's own limit, a hiccup, a refused login: the account's line decides (and reports)
      return NO_SIDE;
    }
    s.on('error', () => { /* closed below */ });
    try { return await fn(s, { openPath: null }); } catch (e) { throw await mailError(gc, a, e); }
  } finally {
    if (s) { try { await s.close(); } catch { /* gone */ } }
    x.side--;
    sideOpen--;
  }
}

/**
 * Work a person waits for (a body, an attachment): Microsoft beside the line; IMAP at once in a free line, beside a busy
 * one on a short session, else first in the line. fn(s, x) like withAccount.
 */
async function forPerson(gc, a, fn) {
  if (isGraph(a)) return direct(gc, a, () => fn(null, { openPath: null }));
  const x = stateOf(a.id);
  const room = x.busy && x.side < SIDE_PER_ACCOUNT && sideOpen < SIDE_MAX && openSessions() + sideOpen < MAX_CONNECTIONS - 1 && gc.mail && gc.mail.imap;
  if (room) {
    const r = await beside(gc, a, x, fn);
    if (r !== NO_SIDE) return r;
  }
  return withAccount(gc, a, fn, { prio: true });
}

/** Work a person waits for that changes the account (flags, moves, deletes): Microsoft beside the line, IMAP first in it. */
function change(gc, a, fn) {
  if (isGraph(a)) return direct(gc, a, () => fn(null, { openPath: null }));
  return withAccount(gc, a, fn, { prio: true });
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

/** The live event while a long sync goes on (at most every LIVE_MS per folder; the end of the sync sends its own). */
function liveSoon(gc, a, x, folderId) {
  const now = Date.now();
  if (now - (x.liveAt.get(folderId) || 0) < LIVE_MS) return;
  x.liveAt.set(folderId, now);
  push.changed(gc, a.user_id, a.id, folderId).catch(() => {});
}

/**
 * One step of folder row `f` (in the line) → { created, changed, more }. The first sync of a posteingang begins with its
 * newest mail (Graph: the newest FIRST_STEP by date, then the delta round; IMAP: the newest FIRST_STEP).
 */
async function folderStep(gc, a, s, x, f, o) {
  if (isGraph(a)) {
    if (o.newest && !f.synced_at && !f.delta && !x.newest.has(f.id)) {
      x.newest.add(f.id);
      try {
        return { ...(await graph.latest(gc, a, f, FIRST_STEP, o.since)), more: true };
      } catch (e) {
        // only a head start: the delta round brings the same
        if (e && (e.auth || e.code === 'auth_failed')) throw e;
        return { created: [], changed: false, more: true };
      }
    }
    return graph.syncFolder(gc, a, f, { since: o.since, arrival: o.arrival, pages: 1 });
  }
  const budget = o.budget || (o.newest && f.uid_next == null ? FIRST_STEP : undefined);
  const r = await imap.syncFolder(gc, a, s, f, { since: o.since, arrival: o.arrival, reconcile: o.reconcile, budget });
  x.openPath = f.path;
  return { ...r, more: false };
}

const hardError = (e) => !!(e && (e.code === 'ERR_MAIL_AUTH' || e.auth || e.code === 'auth_failed' || e.code === 'ERR_MAIL_NET'));

/**
 * Sync a folder in steps (each a job of the line; Graph: a page each, at most PAGES + 1) → { created, changed, folder }.
 * pick(s, x) → the folder row (in the first step; later steps read it again). o: { since, arrival, reconcile, budget,
 * newest, prio, live (events between the steps), soft (a failing folder is skipped with a warning, unless the sign-in
 * or the network failed) }.
 */
async function folderSteps(gc, a, pick, o) {
  const out = { created: [], changed: false, folder: null };
  const steps = isGraph(a) ? PAGES + 1 : 1;
  let id = null;
  for (let i = 0; i < steps; i++) {
    const r = await withAccount(gc, a, async (s, x) => {
      const f = id == null ? await pick(s, x) : await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [id]);
      if (!f) return null;
      id = f.id;
      try {
        return await folderStep(gc, a, s, x, f, o);
      } catch (e) {
        if (!o.soft || hardError(e)) throw e;
        gc.log.warn('folder sync failed', a.id, (e && e.code) || 'error');
        return null;
      }
    }, { prio: o.prio, stay: o.stay });
    if (!r) break;
    out.created.push(...r.created);
    if (r.changed) out.changed = true;
    if (!r.more) break;
    if (o.live && r.changed) liveSoon(gc, a, stateOf(a.id), id);
  }
  if (id != null) out.folder = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [id]);
  return out;
}

/**
 * Sync the posteingang of account `a` now (in steps of its line) → { created }. A sync of it that runs already is
 * joined (and goes once more when asked meanwhile — new mail during a long first sync).
 */
function syncInbox(gc, a, o = {}) {
  const x = stateOf(a.id);
  if (x.inbox) { x.again = true; return x.inbox; }
  const p = (async () => {
    let out;
    do {
      x.again = false;
      out = await inboxRun(gc, a, x, o);
    } while (x.again && !stopped);
    return out;
  })();
  x.inbox = p;
  p.finally(() => { if (x.inbox === p) x.inbox = null; }).catch(() => {});
  return p;
}

async function inboxRun(gc, a, x, o) {
  const cfg = await config.get(gc);
  const since = config.retentionStart(cfg, Date.now());
  const arrival = a.first_done === 1;
  const reconcile = Date.now() - x.lastReconcile > RECONCILE_MS;
  const r = await folderSteps(gc, a, async (s) => {
    let folders = await foldersOf(gc, a);
    if (!folders.length || Date.now() - x.lastAll > FOLDERS_MS * 4) {
      folders = isGraph(a) ? await graph.syncFolders(gc, a) : await imap.syncFolders(gc, a, s, Date.now());
    }
    return folders.find((f) => f.role === 'inbox') || null;
  }, { since, arrival, reconcile, budget: o.budget, newest: !arrival, live: !arrival });
  const f = r.folder;
  if (!f) return { created: [] };
  if (reconcile) x.lastReconcile = Date.now();
  x.dirty = false;
  x.lastInbox = Date.now();
  // the newest bodies at once (snippets; new mail: before its push), a step each; the rest in the background
  await arrivalBodies(gc, a, r.created);
  if (!arrival && (isGraph(a) ? !!f.synced_at : (f.uid_next != null && !f.low_uid))) {
    // the first sync of the posteingang is through: new mail from now on is "arrival" (pushes, bodies at once)
    await store.run(gc, 'UPDATE accounts SET first_done = 1 WHERE id = ?', [a.id]);
    a.first_done = 1;
  }
  await store.run(gc, 'UPDATE accounts SET synced_at = ? WHERE id = ?', [Date.now(), a.id]);
  if (a.state !== 'ok') await setState(gc, a, 'ok', null);
  if (r.changed) await push.changed(gc, a.user_id, a.id, f.id);
  if (arrival && r.created.length) await push.newMail(gc, a);
  return { created: r.created };
}

/** The bodies of the newest ARRIVAL_BODIES of `created` (message ids), a job of the line each. */
async function arrivalBodies(gc, a, created) {
  if (!created.length) return;
  const rows = [];
  for (const part of store.chunks(created)) rows.push(...await store.all(gc, `SELECT * FROM messages WHERE id IN (${store.marks(part.length)})`, part));
  rows.sort((p, q) => q.date - p.date || q.id - p.id);
  const take = rows.slice(0, ARRIVAL_BODIES);
  for (const [i, m] of take.entries()) {
    await withAccount(gc, a, async (s, x) => {
      try { await bodyInLine(gc, a, s, x, m); } catch (e) { if (e && (e.code === 'ERR_MAIL_AUTH' || e.auth)) throw e; }
    }, { stay: i < take.length - 1 });
  }
}

/** Sync every other folder of account `a` (the posteingang has its own rhythm) — a folder at a time. */
async function syncAll(gc, a) {
  const cfg = await config.get(gc);
  const since = config.retentionStart(cfg, Date.now());
  const x = stateOf(a.id);
  const folders = await withAccount(gc, a, (s) => (isGraph(a) ? graph.syncFolders(gc, a) : imap.syncFolders(gc, a, s, Date.now())), { stay: true });
  x.lastAll = Date.now();
  const todo = folders.filter((f) => f.role !== 'inbox' && f.role !== 'all');
  if (!todo.length) await withAccount(gc, a, () => null);
  for (const [i, f] of todo.entries()) {
    const r = await folderSteps(gc, a, () => store.one(gc, 'SELECT * FROM folders WHERE id = ?', [f.id]), { since, arrival: false, reconcile: true, budget: 200, soft: true, stay: i < todo.length - 1 });
    if (r.changed) await push.changed(gc, a.user_id, a.id, f.id);
  }
}

/** One folder now (a list of it was opened and its copy is older than a few minutes) — before the background steps. */
async function syncOne(gc, a, f) {
  const cfg = await config.get(gc);
  const since = config.retentionStart(cfg, Date.now());
  return folderSteps(gc, a, () => store.one(gc, 'SELECT * FROM folders WHERE id = ?', [f.id]), { since, arrival: false, reconcile: true, budget: 200, prio: true });
}

/** Headers of folder `f` older than `before` from the server (a list scrolled past the retention). */
async function loadOlder(gc, a, f, before, count = 50) {
  return withAccount(gc, a, async (s, x) => {
    const r = isGraph(a) ? await graph.older(gc, a, f, before, count) : await imap.older(gc, a, s, f, before, count);
    if (!isGraph(a)) x.openPath = null;
    return r;
  }, { prio: true });
}

// ─── bodies and attachments ─────────────────────

/**
 * Sanitize and store a parsed mail of row `m` (read with session `s` / state `x`). The administrator's "always": its
 * attachments follow — at once in the line, later in the line when a person waits for the body (`person`).
 */
async function storeParsed(gc, a, m, p, s, x, person) {
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
  // invitations (1.2.0): the calendar parts of gc.mail ≥ 1.219.0, Microsoft's event messages — never fail the mail
  try {
    const invites = require('./invites');
    if (Array.isArray(p.calendar) && p.calendar.length) {
      if (await invites.fromParts(gc, a, m, p.calendar)) await push.changed(gc, m.user_id, a.id, m.folder_id, { messageId: m.id });
    } else if (isGraph(a) && m.invite) {
      if (await invites.fromGraph(gc, a, m)) await push.changed(gc, m.user_id, a.id, m.folder_id, { messageId: m.id });
    }
  } catch (e) { gc.log.warn('invitation failed', (e && e.code) || 'error'); }
  // a Microsoft message: List-Id & co. only come with the body — the rules may decide now
  if (p.headers && m.tab_by !== 'user' && m.tab_by !== 'learned') {
    const h = p.headers;
    const pick = (k) => (h[k] == null ? null : String(Array.isArray(h[k]) ? h[k][0] : h[k]));
    if (pick('list-id') || /^(bulk|list|junk)$/i.test(pick('precedence') || '') || (pick('auto-submitted') && !/^no$/i.test(pick('auto-submitted')))) {
      await store.run(gc, "UPDATE messages SET tab = 'other', tab_by = 'rule', ai_pending = 0, list_id = COALESCE(list_id, ?) WHERE id = ?", [pick('list-id'), m.id]);
    }
  }
  const cfg = await config.get(gc);
  if (cfg.attachments !== 'always') return;
  if (person) withAccount(gc, a, (s2, x2) => alwaysFiles(gc, a, m, s2, x2)).catch(() => {});
  else await alwaysFiles(gc, a, m, s, x);
}

/**
 * The attachments of row `m` up to ATT_ALWAYS_MAX into the media (in the line; one that loads already is left to it).
 * Since 1.5.0 not while GateControl has no room for new files (storage.js): they come on demand or with a later mail.
 */
async function alwaysFiles(gc, a, m, s, x) {
  const wait = () => { if (waited.size < WAITED_MAX) waited.add(m.id); };
  if (storage.paused()) { wait(); return; }
  const atts = await store.all(gc, 'SELECT * FROM attachments WHERE message_id = ? AND media_id IS NULL AND inline = 0 AND size <= ?', [m.id, ATT_ALWAYS_MAX]);
  for (const t of atts) {
    if (files.has(t.id)) continue;
    try { await once(files, t.id, () => downloadNow(gc, a, m, t, s, x)); } catch (e) {
      // on demand later; no room for files: not the next one either — the mail waits for filesLater
      if (e && (e.code === 'storage_unavailable' || e.code === 'server_full')) { wait(); break; }
    }
  }
}

/**
 * Since 1.5.0: the prefetch of mails that waited for room at GateControl (storage.js), a few mails per background run
 * once there is room again (in the account's line). → mails handled
 */
async function filesLater(gc) {
  if (!waited.size || storage.paused()) return 0;
  if ((await config.get(gc)).attachments !== 'always') { waited.clear(); return 0; }
  let n = 0;
  for (const id of [...waited].slice(0, WAITED_PER_RUN)) {
    waited.delete(id);
    const m = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [id]);
    const a = m ? await row(gc, m.account_id) : null;
    if (!a || a.state === 'auth_failed') continue;
    try { await withAccount(gc, a, (s, x) => alwaysFiles(gc, a, m, s, x)); n++; } catch { /* on demand */ }
    if (storage.paused()) break;
  }
  return n;
}

/** fn() as the one run of `key` in `map` (removed when it ends). */
function once(map, key, fn) {
  const p = Promise.resolve().then(fn).finally(() => { if (map.get(key) === p) map.delete(key); });
  map.set(key, p);
  return p;
}

/** The body of row `m` from the server with session `s` (IMAP) / state `x`. */
async function bodyNow(gc, a, s, x, m, person = false) {
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
  await storeParsed(gc, a, m, p, s, x, person);
}

/** In the line (arrivals, the background): the body of row `m` — unless a person's load of it runs already. */
async function bodyInLine(gc, a, s, x, m) {
  if (bodies.has(m.id)) return;
  await once(bodies, m.id, () => bodyNow(gc, a, s, x, m));
}

/**
 * The body of message row `m` from the server, for a person who waits (forPerson: never behind a sync step). A load of
 * it that runs already is joined.
 */
function loadBody(gc, a, m) {
  return bodies.get(m.id) || once(bodies, m.id, () => forPerson(gc, a, (s, x) => bodyNow(gc, a, s, x, m, true)));
}

/** Is the body of message `id` being loaded? */
const loading = (id) => bodies.has(id);

/**
 * An attachment into the plugin's media (claimed — since 1.5.0 into the area `attachments`, storage.js) with session `s`
 * (IMAP) → { mediaId, bytes, mime }. No room for a new file at GateControl → 409 storage_unavailable / server_full.
 */
async function downloadNow(gc, a, m, t, s, x) {
  let got;
  try {
    if (isGraph(a)) got = await graph.download(gc, a, m, t, ATT_MAX);
    else {
      const f = await store.one(gc, 'SELECT * FROM folders WHERE id = ?', [m.folder_id]);
      if (!f) throw fail('not_found');
      if (!s) throw fail('unreachable');
      try { got = await imap.download(s, f, m, t, ATT_MAX); } finally { if (x) x.openPath = null; }
    }
  } catch (e) { throw storage.failed(e) || e; }
  await storage.claim(gc, got.mediaId, t);
  const bytes = Number(got.bytes) || Number(t.size) || 0;
  await store.run(gc, 'UPDATE attachments SET media_id = ?, media_bytes = ?, used_at = ? WHERE id = ?', [got.mediaId, bytes, Date.now(), t.id]);
  return { mediaId: got.mediaId, bytes, mime: got.mime || t.mime };
}

/** The cached copy of attachment `t` of row `m` (downloaded when needed — never behind a sync step; a download that runs is joined). */
async function attachment(gc, a, m, t) {
  if (t.media_id) {
    const info = await gc.media.info(t.media_id).catch(() => null);
    if (info) {
      await store.run(gc, 'UPDATE attachments SET used_at = ? WHERE id = ?', [Date.now(), t.id]);
      return { mediaId: t.media_id, bytes: info.bytes, mime: info.mime || t.mime };
    }
  }
  return files.get(t.id) || once(files, t.id, () => forPerson(gc, a, (s, x) => downloadNow(gc, a, m, t, s, x)));
}

// ─── changes the person makes ───────────────────

/** Flags of rows `list` (one account): { unread?, flagged?, answered? } — on the server, then here. */
async function setFlags(gc, a, list, want) {
  if (!list.length) return;
  await change(gc, a, async (s, x) => {
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
  await change(gc, a, async (s, x) => {
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
  await change(gc, a, async (s, x) => {
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
  }, { prio: true });
  return found;
}

// ─── the background run ─────────────────────────

/** Bodies of mail without one (newest first, within the quota) — BACKFILL per account and run, a step each. */
async function backfill(gc, a, quota) {
  if (await mailstore.usage(gc, a.user_id) > quota * 0.85) return 0;
  const rows = await store.all(gc, `SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.account_id = ? AND m.body_state = 'none'
    AND f.role IN ('inbox', 'sent', 'archive') ORDER BY m.date DESC LIMIT ?`, [a.id, BACKFILL]);
  if (!rows.length) return 0;
  for (const [i, m] of rows.entries()) {
    await withAccount(gc, a, async (s, x) => {
      try { await bodyInLine(gc, a, s, x, m); } catch (e) {
        if (e && (e.code === 'ERR_MAIL_AUTH' || e.auth || e.code === 'ERR_MAIL_NET')) throw e;
        await store.run(gc, "UPDATE messages SET body_state = 'failed' WHERE id = ?", [m.id]);
      }
    }, { stay: i < rows.length - 1 });
  }
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
function start(gc) { gcRef = gc; stopped = false; st.clear(); bodies.clear(); files.clear(); waited.clear(); sideOpen = 0; }

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
  run, withAccount, direct, syncInbox, syncAll, syncOne, loadOlder, loadBody, loading, attachment, filesLater, setFlags, move, destroy, appendSent, remoteSearch,
  retention, tick, start, stop, forget, probe, adopt, setState, isGraph, mailError, stateOf, backfill, MONTH,
};
