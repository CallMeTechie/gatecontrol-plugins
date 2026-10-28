'use strict';

// Office in the browser (since 1.9.0, feature `office`): Drive is a WOPI host for Collabora Online and OnlyOffice.
//
//   setting office_url       the office server's address as the browser reaches it (e.g. https://office.example.de)
//   home target "office"     the same server as GateControl reaches it — the discovery (/hosting/discovery) is read
//                            through it (an administrator assigns it under Plugins › Drive › Zugriffsziele); kept
//                            12 hours (gc.storage), read again when the setting changes
//
// "Im Browser bearbeiten" (portal; the apps open the portal's direct link): POST nodes/<id>/office → { url, mode,
// expiresAt } — a public endpoint of GateControl (≥ 1.211.0, permissions.publicEndpoints) with a token for 2 minutes
// (office/open/<id>); the portal opens it in a new tab (GC.openTab). That request mints the WOPI access_token (4 hours,
// bound to the file, the person and the right — 'w' write or 'r' read — as gc.publicEndpoints token of the path
// wopi/files/<id>) and answers GateControl's form page, which posts access_token and access_token_ttl to the editor's
// urlsrc with WOPISrc=<GateControl>/plugin-public/gatecontrol-drive/wopi/files/<id>.
//
// WOPI (hook publicRequest — the office server, no portal session, the token is the permission):
//   GET  wopi/files/<id>                CheckFileInfo
//   GET  wopi/files/<id>/contents       GetFile (the current media, streamed by GateControl)
//   POST wopi/files/<id>/contents       PutFile (X-WOPI-Override: PUT) → a new version of the file (files.commit)
//   POST wopi/files/<id>                X-WOPI-Override LOCK (with X-WOPI-OldLock: UnlockAndRelock), GET_LOCK,
//                                       REFRESH_LOCK, UNLOCK — 30 minutes (table office_locks); others 501
// Every request checks the person's right to the file again (a token outlives no right), the file is no vault's, and —
// when the discovery has proof keys — the proof (X-WOPI-Proof / X-WOPI-ProofOld, RSA-SHA256 over the token, the URL
// in capitals and X-WOPI-TimeStamp, not older than 20 minutes; failing → 500 as WOPI asks).

const crypto = require('node:crypto');
const store = require('./store');
const nodes = require('./nodes');
const { fail, iso } = require('./util');

const DISCOVERY_KEY = 'office_discovery';
const DISCOVERY_TTL_MS = 12 * 3600 * 1000;
const DISCOVERY_RETRY_MS = 5 * 60 * 1000;
const TOKEN_TTL_S = 4 * 3600;
const OPEN_TTL_S = 120;
const LOCK_MS = 30 * 60 * 1000;
const LOCK_MAX = 1024;
const PROOF_MAX_AGE_MS = 20 * 60 * 1000;
const BODY_MAX = 512 * 1024 * 1024;
// the documents it opens (contract): word processing, spreadsheets, presentations, CSV
const EXTS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'csv', 'doc', 'xls', 'ppt', 'rtf']);
const MIMES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', csv: 'text/csv', doc: 'application/msword',
  xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', rtf: 'application/rtf',
};

const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

/** The office server's address of the setting office_url (http(s), no user info), else null. */
function officeUrl(settings) {
  const v = settings && typeof settings.office_url === 'string' ? settings.office_url.trim() : '';
  if (!v || v.length > 500) return null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u;
  } catch { return null; }
}

// ─── Discovery ──────────────────────────────────

const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return out;
};

/**
 * The discovery XML → { actions: { <ext>: { edit?, view? } }, proof: { modulus, exponent, oldModulus, oldExponent } | null,
 * product }. Only the actions of the documents Drive opens.
 */
function parseDiscovery(xml) {
  const s = String(xml || '');
  if (!/<wopi-discovery[\s>]/.test(s)) return null;
  const actions = {};
  for (const app of s.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    for (const act of app[2].matchAll(/<action\b([^>]*?)\/?>/g)) {
      const x = attrs(act[1]);
      const ext = String(x.ext || '').toLowerCase();
      const name = String(x.name || '').toLowerCase();
      if (!EXTS.has(ext) || !x.urlsrc || (name !== 'edit' && name !== 'view')) continue;
      if (!/^https?:\/\//i.test(x.urlsrc)) continue;
      (actions[ext] || (actions[ext] = {}))[name] = x.urlsrc;
    }
  }
  const pk = /<proof-key\b([^>]*?)\/?>/.exec(s);
  let proof = null;
  if (pk) {
    const p = attrs(pk[1]);
    if (p.modulus && p.exponent) proof = { modulus: p.modulus, exponent: p.exponent, oldModulus: p.oldmodulus || null, oldExponent: p.oldexponent || null };
  }
  return { actions, proof, product: /onlyoffice/i.test(s) ? 'onlyoffice' : (/collabora|cool\.html|loleaflet/i.test(s) ? 'collabora' : null) };
}

/** Read the discovery through the home target "office" → { at, ok, error?, actions, proof, product } (stored). */
async function refreshDiscovery(gc, now = Date.now()) {
  let out;
  try {
    const r = await gc.net.fetchTarget('office', '/hosting/discovery', { method: 'GET', timeoutMs: 15000, headers: { accept: 'application/xml, text/xml' } });
    const d = r && r.status === 200 ? parseDiscovery(typeof r.body === 'string' ? r.body : (r.bodyBase64 ? Buffer.from(r.bodyBase64, 'base64').toString('utf8') : '')) : null;
    if (!d) out = { at: now, ok: false, error: r ? `http_${r.status}` : 'no_answer' };
    else if (!Object.keys(d.actions).length) out = { at: now, ok: false, error: 'no_actions' };
    else out = { at: now, ok: true, ...d };
  } catch (e) {
    out = { at: now, ok: false, error: e && e.code === 'ERR_NET_DENIED' ? 'no_target' : 'unreachable' };
  }
  try { await gc.storage.set(DISCOVERY_KEY, out); } catch (e) { gc.log.warn('office discovery not stored', (e && e.code) || 'error'); }
  return out;
}

/** The stored discovery, read again when older than 12 hours (a failure: 5 minutes). */
async function discovery(gc, now = Date.now(), force = false) {
  let d = null;
  try { d = await gc.storage.get(DISCOVERY_KEY); } catch { d = null; }
  const age = d && Number.isFinite(d.at) ? now - d.at : Infinity;
  if (force || !d || age < 0 || age > (d.ok ? DISCOVERY_TTL_MS : DISCOVERY_RETRY_MS)) d = await refreshDiscovery(gc, now);
  return d;
}

/** Can this host and this setup open office documents? (GET me features, the portal's menu) */
async function available(gc, settings, now) {
  if (!gc.publicEndpoints || typeof gc.publicEndpoints.token !== 'function') return false;
  if (!officeUrl(settings)) return false;
  const d = await discovery(gc, now);
  return !!(d && d.ok);
}

/** The status lines of the settings form (hook settingsStatus). */
async function status(gc, settings, lang, t) {
  if (!officeUrl(settings)) return [];
  if (!gc.publicEndpoints || typeof gc.publicEndpoints.token !== 'function') return [{ tone: 'warn', text: t(lang, 'office.status.host') }];
  const d = await discovery(gc, Date.now(), true);
  if (d && d.ok) return [{ tone: 'ok', text: t(lang, 'office.status.ok', { product: d.product === 'onlyoffice' ? 'OnlyOffice' : (d.product === 'collabora' ? 'Collabora Online' : 'WOPI'), count: Object.keys(d.actions).length }) }];
  return [{ tone: 'error', text: t(lang, d && d.error === 'no_target' ? 'office.status.target' : 'office.status.error', { error: (d && d.error) || '' }) }];
}

/** urlsrc with its placeholders (<name=VALUE&>) filled or dropped, WOPISrc appended, the origin of office_url. */
function actionUrl(urlsrc, wopiSrc, lang, office) {
  const loc = lang === 'en' ? 'en-US' : 'de-DE';
  let u = String(urlsrc).replace(/<([A-Za-z_]+)=([A-Z_]+)&?>/g, (_, name, val) => (val === 'UI_LLCC' || val === 'DC_LLCC' ? `${name}=${loc}&` : ''));
  if (office) {
    try { const x = new URL(u); u = office.origin + x.pathname + x.search; } catch { /* keep */ }
  }
  const sep = u.endsWith('?') || u.endsWith('&') ? '' : (u.includes('?') ? '&' : '?');
  return `${u}${sep}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=${loc}`;
}

// ─── Proof keys ─────────────────────────────────

function rsaKey(modulus, exponent) {
  const n = Buffer.from(modulus, 'base64');
  const e = Buffer.from(exponent, 'base64');
  return crypto.createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' });
}

function len4(buf) { const b = Buffer.alloc(4); b.writeUInt32BE(buf.length); return b; }

/** What the office server signs: token, the URL in capitals, the timestamp — each with its 4-byte length (WOPI proof). */
function proofData(token, url, ticks) {
  const t = Buffer.from(token, 'utf8');
  const u = Buffer.from(String(url).toUpperCase(), 'utf8');
  const ts = Buffer.alloc(8);
  ts.writeBigInt64BE(BigInt(ticks));
  return Buffer.concat([len4(t), t, len4(u), u, len4(ts), ts]);
}

const TICKS_AT_EPOCH = 621355968000000000n;
const ticksToMs = (ticks) => Number((BigInt(ticks) - TICKS_AT_EPOCH) / 10000n);

/**
 * Check the WOPI proof of a request → true / false. `url`: the address the office server called (our WOPISrc + its
 * query). The current or the old key, the current or the old proof (a key rotation on the office server).
 */
function checkProof(proof, headers, token, url, now = Date.now()) {
  const sig = headers['x-wopi-proof'];
  const old = headers['x-wopi-proofold'];
  const ts = headers['x-wopi-timestamp'];
  if (!sig || !ts || !/^\d{1,20}$/.test(ts)) return false;
  if (Math.abs(now - ticksToMs(ts)) > PROOF_MAX_AGE_MS) return false;
  const data = proofData(token, url, ts);
  const keys = [];
  try { keys.push(rsaKey(proof.modulus, proof.exponent)); } catch { return false; }
  let oldKey = null;
  try { if (proof.oldModulus && proof.oldExponent) oldKey = rsaKey(proof.oldModulus, proof.oldExponent); } catch { oldKey = null; }
  const ok = (key, s) => { try { return !!s && crypto.verify('RSA-SHA256', data, key, Buffer.from(s, 'base64')); } catch { return false; } };
  return ok(keys[0], sig) || ok(keys[0], old) || (oldKey ? ok(oldKey, sig) : false);
}

// ─── Opening ────────────────────────────────────

/** The file `id` the viewer may open in the office → { node, area, write }; not a vault's, a document type. */
async function openable(ctx, id) {
  const { node, area, role } = await nodes.reach(ctx, Number(id));
  if (node.is_dir === 1) throw fail('invalid');
  if (node.vault_id) throw fail('encrypted');
  if (!EXTS.has(extOf(node.name))) throw fail('office_unavailable', { reason: 'type' });
  const write = ['write', 'manage'].includes(role) && area.archived_at == null;
  return { node, area, write };
}

/** POST nodes/<id>/office → { url, mode: 'edit'|'view', expiresAt } — the address the portal opens in a new tab. */
async function open(ctx, id) {
  const { node, write } = await openable(ctx, id);
  if (!await available(ctx.gc, await ctx.gc.settings.all(), ctx.now)) throw fail('office_unavailable', { reason: 'setup' });
  const t = await ctx.gc.publicEndpoints.token({ user: ctx.viewer, path: `office/open/${node.id}`, ttlS: OPEN_TTL_S, data: write ? 'w' : 'r' });
  if (!t || !t.url) throw fail('office_unavailable', { reason: 'address' });
  return { url: `${t.url}?access_token=${encodeURIComponent(t.token)}`, mode: write ? 'edit' : 'view', expiresAt: iso(t.expiresAt) };
}

// ─── WOPI (hook publicRequest) ──────────────────

const wopiErr = (status, extra) => ({ status, ...(extra || {}) });

async function lockOf(gc, id, now) {
  const l = await store.one(gc, 'SELECT * FROM office_locks WHERE node_id = ?', [id]);
  if (!l) return null;
  if (l.expires_at <= now) { await store.run(gc, 'DELETE FROM office_locks WHERE node_id = ?', [id]); return null; }
  return l;
}

/**
 * A request of the office server (or the portal's open request) → the hook's answer. `asPerson(uid)` → the
 * person's request context (index.js) or null (no seat, no licence).
 */
async function publicRequest(gc, req, asPerson) {
  const now = Date.now();
  const seg = String(req.path || '').split('/').filter(Boolean);
  const tok = req.token || {};
  const person = req.user && Number.isSafeInteger(req.user.id) ? await asPerson(req.user.id) : null;
  if (!person) return wopiErr(401, { text: 'unauthorized' });
  const settings = await gc.settings.all();
  const d = await discovery(gc, now);
  if (!d || !d.ok) return wopiErr(503, { text: 'office unavailable' });
  const id = Number(seg[2]);
  // the portal's open request: a token for office/open/<id>
  if (seg[0] === 'office' && seg[1] === 'open' && seg.length === 3 && req.method === 'GET') {
    let o;
    try { o = await openable(person, id); } catch { return wopiErr(404, { text: 'not found' }); }
    const write = o.write && tok.data === 'w';
    const t = await gc.publicEndpoints.token({ user: person.viewer, path: `wopi/files/${o.node.id}`, ttlS: TOKEN_TTL_S, data: write ? 'w' : 'r' });
    const act = d.actions[extOf(o.node.name)];
    const urlsrc = act && ((write && act.edit) || act.view || act.edit);
    if (!t || !t.url || !urlsrc) return wopiErr(404, { text: 'not found' });
    return { form: { action: actionUrl(urlsrc, t.url, person.lang, officeUrl(settings)), fields: { access_token: t.token, access_token_ttl: String(t.expiresAt) } } };
  }
  if (seg[0] !== 'wopi' || seg[1] !== 'files' || !Number.isSafeInteger(id) || id <= 0 || seg.length > 4 || (seg.length === 4 && seg[3] !== 'contents')) return wopiErr(404, { text: 'not found' });
  // the proof of the office server (when its discovery has keys)
  if (d.proof) {
    const base = typeof req.url === 'string' ? (() => { try { return new URL(req.url).origin; } catch { return null; } })() : null;
    const own = await ownOrigin(gc);
    const token = req.query && typeof req.query.access_token === 'string' ? req.query.access_token : accessTokenOf(req.originalUrl);
    const urls = [...new Set([own, base].filter(Boolean))].map((o) => o + req.originalUrl);
    if (!token || !urls.some((u) => checkProof(d.proof, req.headers || {}, token, u, now))) return wopiErr(500, { text: 'proof' });
  }
  let o;
  try { o = await openable(person, id); } catch { return wopiErr(404, { text: 'not found' }); }
  const write = o.write && tok.data === 'w';
  const h = req.headers || {};
  const override = String(h['x-wopi-override'] || '').toUpperCase();
  const version = String(o.node.rev);
  const modified = iso(o.node.content_at || o.node.updated_at);
  if (seg.length === 3 && req.method === 'GET') {
    const owner = person.users.get(o.node.created_by);
    return {
      json: {
        BaseFileName: o.node.name, OwnerId: String(o.node.created_by || ''), Size: o.node.size, Version: version, LastModifiedTime: modified,
        UserId: String(person.viewer), UserFriendlyName: person.user ? person.user.name : String(person.viewer), IsAnonymousUser: false,
        UserCanWrite: write, ReadOnly: !write, UserCanNotWriteRelative: true, UserCanRename: false,
        SupportsLocks: true, SupportsGetLock: true, SupportsExtendedLockLength: true, SupportsUpdate: true, SupportsRename: false, SupportsDeleteFile: false,
        SupportsCobalt: false, SupportsContainers: false, SupportsUserInfo: false, DisablePrint: false, HidePrintOption: false, HideSaveOption: false,
        HideExportOption: false, EnableShare: false, BreadcrumbDocName: o.node.name, BreadcrumbBrandName: 'GateControl Drive',
        ...(owner ? { BreadcrumbFolderName: person.areaLabel(o.area) } : {}),
      },
      headers: { 'X-WOPI-ItemVersion': version },
    };
  }
  if (seg.length === 4 && req.method === 'GET') {
    if (!o.node.media_id) return { status: 200, headers: { 'X-WOPI-ItemVersion': version } };
    return { media: o.node.media_id, headers: { 'X-WOPI-ItemVersion': version } };
  }
  if (req.method !== 'POST') return wopiErr(405, { text: 'method' });
  const lock = typeof h['x-wopi-lock'] === 'string' ? h['x-wopi-lock'].slice(0, LOCK_MAX + 1) : '';
  if (seg.length === 4) {
    // PutFile
    if (override && override !== 'PUT') return wopiErr(501, { text: 'not implemented' });
    if (!write) return wopiErr(401, { text: 'read only' });
    const cur = await lockOf(gc, o.node.id, now);
    if (cur && cur.lock !== lock) return { status: 409, headers: { 'X-WOPI-Lock': cur.lock, 'X-WOPI-LockFailureReason': 'locked' } };
    const stamp = h['x-cool-wopi-timestamp'] || h['x-lool-wopi-timestamp'];
    if (stamp && stamp !== modified) return { status: 409, json: { COOLStatusCode: 1010, LOOLStatusCode: 1010 } };
    if (!req.body || !req.body.mediaId) {
      // an empty document: GateControl takes no empty body — nothing to keep
      return { status: 400, text: 'empty' };
    }
    const files = require('./files');
    try {
      const r = await files.commit(person, { mediaId: req.body.mediaId, parentId: o.node.parent_id, name: o.node.name, onConflict: 'version' }, { mime: MIMES[extOf(o.node.name)] || o.node.mime });
      await person.after();
      return { status: 200, headers: { 'X-WOPI-ItemVersion': String(r.node.rev) }, json: { LastModifiedTime: r.node.updatedAt } };
    } catch (e) {
      await person.after(false);
      if (e && e.code === 'device_locked') return { status: 409, text: 'locked' };
      if (e && e.code === 'quota') return { status: 507, text: 'quota' };
      return { status: 500, text: 'not stored' };
    }
  }
  // the locks
  if (!['LOCK', 'GET_LOCK', 'REFRESH_LOCK', 'UNLOCK'].includes(override)) return wopiErr(501, { text: 'not implemented' });
  const cur = await lockOf(gc, o.node.id, now);
  if (override === 'GET_LOCK') return { status: 200, headers: { 'X-WOPI-Lock': cur ? cur.lock : '' } };
  if (!lock || lock.length > LOCK_MAX) return { status: 400, text: 'lock' };
  const conflict = () => ({ status: 409, headers: { 'X-WOPI-Lock': cur ? cur.lock : '', 'X-WOPI-LockFailureReason': cur ? 'locked by another' : 'not locked' } });
  const set = () => store.run(gc, `INSERT INTO office_locks (node_id, lock, user_id, at, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET lock = excluded.lock, user_id = excluded.user_id, at = excluded.at, expires_at = excluded.expires_at`, [o.node.id, lock, person.viewer, now, now + LOCK_MS]);
  if (override === 'LOCK') {
    const oldLock = typeof h['x-wopi-oldlock'] === 'string' ? h['x-wopi-oldlock'] : null;
    if (oldLock != null) {
      if (!cur || cur.lock !== oldLock) return conflict();
    } else if (cur && cur.lock !== lock) return conflict();
    if (!write) return wopiErr(401, { text: 'read only' });
    await set();
    return { status: 200, headers: { 'X-WOPI-ItemVersion': version } };
  }
  if (!cur || cur.lock !== lock) return conflict();
  if (override === 'REFRESH_LOCK') { await set(); return { status: 200 }; }
  await store.run(gc, 'DELETE FROM office_locks WHERE node_id = ?', [o.node.id]);
  return { status: 200, headers: { 'X-WOPI-ItemVersion': version } };
}

function accessTokenOf(originalUrl) {
  try { return new URL(String(originalUrl || ''), 'http://x').searchParams.get('access_token'); } catch { return null; }
}

/** The origin of GateControl's public endpoints (gc.publicEndpoints.base). */
async function ownOrigin(gc) {
  try { const b = await gc.publicEndpoints.base(); return b && b.url ? new URL(b.url).origin : null; } catch { return null; }
}

/** Old locks go (background run). */
async function sweep(gc, now) {
  await store.run(gc, 'DELETE FROM office_locks WHERE expires_at <= ?', [now]);
}

module.exports = {
  EXTS, BODY_MAX, TOKEN_TTL_S, LOCK_MS, extOf, officeUrl, parseDiscovery, refreshDiscovery, discovery, available, status, actionUrl, proofData, checkProof,
  open, openable, publicRequest, sweep, DISCOVERY_KEY,
};
