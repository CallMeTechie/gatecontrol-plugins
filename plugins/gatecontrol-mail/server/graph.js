'use strict';

// Microsoft accounts through Microsoft Graph (gc.http.fetch, microsoft.js): the folders, a delta query per folder (the
// posteingang every minute, the rest every 15 minutes — engine.js), bodies and attachments on demand, flags, moves and
// sending through Graph. The delta round's nextLink is kept until it ends (a long first sync goes on in the next run),
// then its deltaLink.
//
// Files go along through GateControl ≥ 1.217.0 (gc.http.fetch with bodyMedia — the host streams the plugin's media file,
// the plugin never holds the bytes): a Graph draft, every file < 3 MB as fileAttachment with contentBytes (the host puts
// the file in base64 where gc.http.MEDIA_BASE64 stands), larger ones through an upload session in pieces of < 4 MB, then
// send. Older hosts: files only as links (compose.js refuses the rest with attachments_unsupported).

const store = require('./store');
const mailstore = require('./mailstore');
const ms = require('./microsoft');
const { fail, line } = require('./util');

const WELL_KNOWN = { inbox: 'inbox', sentitems: 'sent', drafts: 'drafts', archive: 'archive', junkemail: 'junk', deleteditems: 'trash' };
const SELECT = 'id,internetMessageId,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,isRead,flag,hasAttachments,inferenceClassification';
const PAGE = 50;
const PAGES = 10;
const FOLDERS_MAX = 300;
const SMALL_MAX = 3 * 1024 * 1024;   // below: one POST with contentBytes; from here: an upload session (Graph: 3 MB … 150 MB)
const PIECE = 9 * 320 * 1024;        // bytes per PUT of an upload session (Graph: keep each under 4 MB)
const PIECES_MAX = 200;
const UPLOAD_TIMEOUT = 120000;
const UPLOAD_URL_RE = /^https:\/\/outlook\.office(365)?\.com\//;

const person = (r) => (r && r.emailAddress ? { name: r.emailAddress.name || '', email: r.emailAddress.address || '' } : null);
const people = (l) => (Array.isArray(l) ? l.map(person).filter(Boolean) : []);

/** A Graph message → mailstore header. */
function headerOf(x) {
  return {
    remoteId: x.id, messageId: x.internetMessageId || null, conv: x.conversationId || null, refs: [],
    date: Date.parse(x.receivedDateTime) || Date.now(), from: person(x.from), to: people(x.toRecipients), cc: people(x.ccRecipients),
    bcc: people(x.bccRecipients), replyTo: people(x.replyTo), subject: x.subject || '', snippet: x.bodyPreview || '',
    unread: x.isRead === false, flagged: !!(x.flag && x.flag.flagStatus === 'flagged'), answered: false, hasAtt: x.hasAttachments === true,
    size: 0, inference: x.inferenceClassification === 'other' ? 'other' : null,
  };
}

async function get(gc, a, path, extra) {
  const r = await ms.graph(gc, a, 'GET', path, undefined, extra);
  if (r.status === 404) return null;
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  return r.json || {};
}

/** The folders of account `a` (and the roles of the well-known ones). → rows */
async function syncFolders(gc, a) {
  const roles = new Map();
  for (const [wk, role] of Object.entries(WELL_KNOWN)) {
    try { const x = await get(gc, a, `/me/mailFolders/${wk}?$select=id`); if (x && x.id) roles.set(x.id, role); } catch (e) { if (e.code === 'auth_failed') throw e; }
  }
  const found = [];
  const walk = async (url, parentPath, depth) => {
    let next = url;
    while (next && found.length < FOLDERS_MAX) {
      const page = await get(gc, a, next);
      if (!page) break;
      for (const x of page.value || []) {
        if (found.length >= FOLDERS_MAX) break;
        const name = line(x.displayName || '') || x.id;
        const p = parentPath ? `${parentPath}/${name}` : name;
        found.push({ id: x.id, name, path: p, parent: parentPath, role: roles.get(x.id) || null, total: x.totalItemCount, unread: x.unreadItemCount });
        if (x.childFolderCount > 0 && depth < 3) await walk(`/me/mailFolders/${encodeURIComponent(x.id)}/childFolders?$top=100`, p, depth + 1);
      }
      next = page['@odata.nextLink'] || null;
    }
  };
  await walk('/me/mailFolders?$top=100', '', 0);
  const rows = await store.all(gc, 'SELECT * FROM folders WHERE account_id = ?', [a.id]);
  for (const x of found) {
    const have = rows.find((r) => r.remote_id === x.id);
    if (have) {
      await store.run(gc, 'UPDATE folders SET path = ?, name = ?, role = ?, remote_total = ?, remote_unread = ? WHERE id = ?', [x.path, x.name, x.role, x.total || 0, x.unread || 0, have.id]);
    } else {
      await store.run(gc, 'INSERT INTO folders (account_id, path, name, delim, role, remote_id, remote_total, remote_unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [a.id, x.path, x.name, '/', x.role, x.id, x.total || 0, x.unread || 0]).catch(() => null);
    }
  }
  const ids = new Set(found.map((x) => x.id));
  for (const r of rows) {
    if (ids.has(r.remote_id)) continue;
    const gone = (await store.all(gc, 'SELECT id FROM messages WHERE folder_id = ?', [r.id])).map((x) => x.id);
    await mailstore.remove(gc, gone);
    await store.run(gc, 'DELETE FROM folders WHERE id = ?', [r.id]);
  }
  const now2 = await store.all(gc, 'SELECT id, path FROM folders WHERE account_id = ?', [a.id]);
  for (const r of now2) {
    const i = r.path.lastIndexOf('/');
    const parent = i > 0 ? now2.find((x) => x.path === r.path.slice(0, i)) : null;
    await store.run(gc, 'UPDATE folders SET parent_id = ? WHERE id = ?', [parent ? parent.id : null, r.id]);
  }
  return store.all(gc, 'SELECT * FROM folders WHERE account_id = ?', [a.id]);
}

/** One delta run of folder `f` → { created, changed }. o: { since, arrival }. */
async function syncFolder(gc, a, f, o) {
  const now = Date.now();
  const out = { created: [], changed: false };
  let url = f.delta;
  if (!url) {
    const filter = o.since ? `&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(o.since).toISOString()}`)}` : '';
    url = `/me/mailFolders/${encodeURIComponent(f.remote_id)}/messages/delta?$select=${SELECT}${filter}`;
  }
  const first = !f.synced_at;
  let pages = 0;
  let done = false;
  while (url && pages < PAGES) {
    const r = await ms.graph(gc, a, 'GET', url, undefined, { headers: { prefer: `odata.maxpagesize=${PAGE}` } });
    if (r.status === 410 || (r.status === 400 && /sync/i.test(ms.graphError(r)))) {
      // the delta token ran out: start over
      await store.run(gc, 'UPDATE folders SET delta = NULL WHERE id = ?', [f.id]);
      f.delta = null;
      return syncFolder(gc, a, f, o);
    }
    if (r.status === 404) throw fail('not_found');
    if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
    const j = r.json || {};
    for (const x of j.value || []) {
      if (x['@removed']) {
        const gone = await store.one(gc, 'SELECT id FROM messages WHERE folder_id = ? AND remote_id = ?', [f.id, x.id]);
        if (gone) { await mailstore.remove(gc, [gone.id]); out.changed = true; }
        continue;
      }
      const res = await mailstore.upsert(gc, a, f, headerOf(x), { arrival: o.arrival && !first, now });
      if (res.created) out.created.push(res.id);
      if (res.changed) out.changed = true;
    }
    pages++;
    if (j['@odata.deltaLink']) { url = j['@odata.deltaLink']; done = true; break; }
    url = j['@odata.nextLink'] || null;
  }
  await store.run(gc, 'UPDATE folders SET delta = ?, synced_at = ?, complete = ? WHERE id = ?', [url, done || f.synced_at ? now : null, done && !o.since ? 1 : 0, f.id]);
  if (out.created.length) out.changed = true;
  return out;
}

/** Older messages of folder `f` than `before` (beyond the retention) → created ids. */
async function older(gc, a, f, before, count) {
  const filter = encodeURIComponent(`receivedDateTime lt ${new Date(before).toISOString()}`);
  const j = await get(gc, a, `/me/mailFolders/${encodeURIComponent(f.remote_id)}/messages?$select=${SELECT}&$filter=${filter}&$orderby=receivedDateTime desc&$top=${count}`);
  const created = [];
  for (const x of (j && j.value) || []) {
    const r = await mailstore.upsert(gc, a, f, headerOf(x), { arrival: false });
    if (r.created) created.push(r.id);
  }
  if (!created.length) await store.run(gc, 'UPDATE folders SET complete = 1 WHERE id = ?', [f.id]);
  return created;
}

/** Body and attachments of message row `m` → { html, text, attachments, headers } like gc.mail's parsed mail. */
async function message(gc, a, m) {
  const x = await get(gc, a, `/me/messages/${encodeURIComponent(m.remote_id)}?$select=body,internetMessageHeaders,hasAttachments`, { headers: { prefer: 'outlook.body-content-type="html"' } });
  if (!x) throw fail('not_found');
  const headers = {};
  for (const h of x.internetMessageHeaders || []) if (h && h.name) headers[String(h.name).toLowerCase()] = h.value;
  let attachments = [];
  if (x.hasAttachments || /cid:/i.test((x.body && x.body.content) || '')) {
    const list = await get(gc, a, `/me/messages/${encodeURIComponent(m.remote_id)}/attachments?$select=id,name,contentType,size,isInline`);
    attachments = ((list && list.value) || []).filter((t) => t['@odata.type'] !== '#microsoft.graph.itemAttachment' || true).map((t) => ({
      remoteId: t.id, filename: t.name, contentType: t.contentType, size: t.size, inline: t.isInline === true, contentId: t.contentId || null,
    }));
  }
  const html = x.body && x.body.contentType === 'html' ? x.body.content : null;
  const text = x.body && x.body.contentType !== 'html' ? x.body.content : null;
  return { html, text, attachments, headers };
}

/** An attachment into the plugin's media (gc.media.fetch with the token) → { mediaId, bytes, mime, name }. */
async function download(gc, a, m, att, maxBytes) {
  const token = await ms.accessToken(gc, a);
  try {
    return await gc.media.fetch(`${ms.GRAPH}/me/messages/${encodeURIComponent(m.remote_id)}/attachments/${encodeURIComponent(att.remote_id)}/$value`, {
      headers: { authorization: `Bearer ${token}` }, name: att.name, mime: att.mime, maxBytes, timeoutMs: 60000,
    });
  } catch (e) {
    if (e && e.code === 'ERR_HTTP' && e.status === 401) throw Object.assign(fail('auth_failed'), { auth: true });
    throw e;
  }
}

async function patch(gc, a, m, body) {
  const r = await ms.graph(gc, a, 'PATCH', `/me/messages/${encodeURIComponent(m.remote_id)}`, body);
  if (r.status >= 400 && r.status !== 404) throw fail('unreachable', { reason: ms.graphError(r) });
}

/** Move message row `m` to folder row `to` → its new Graph id. */
async function move(gc, a, m, to) {
  const r = await ms.graph(gc, a, 'POST', `/me/messages/${encodeURIComponent(m.remote_id)}/move`, { destinationId: to.remote_id });
  if (r.status >= 400) throw fail('unreachable', { reason: ms.graphError(r) });
  return r.json && r.json.id ? r.json.id : null;
}

async function destroy(gc, a, m) {
  const r = await ms.graph(gc, a, 'DELETE', `/me/messages/${encodeURIComponent(m.remote_id)}`);
  if (r.status >= 400 && r.status !== 404) throw fail('unreachable', { reason: ms.graphError(r) });
}

/** Search the mailbox (beyond the retention) → Graph messages (≤ 25). */
async function search(gc, a, q) {
  const j = await get(gc, a, `/me/messages?$select=${SELECT},parentFolderId&$search=${encodeURIComponent(`"${String(q).replace(/"/g, '')}"`)}&$top=25`);
  return (j && j.value) || [];
}

const recip = (l) => (l || []).map((p) => ({ emailAddress: { address: p.email, ...(p.name ? { name: p.name } : {}) } }));

/** Can this GateControl send media files as a request body (gc.http.fetch bodyMedia, ≥ 1.217.0)? */
const canAttach = (gc) => !!(gc && gc.http && typeof gc.http.MEDIA_BASE64 === 'string');

/** Does a draft with `mode` on `original` go out as Graph's own reply / forward of account `a`? */
const ownReply = (a, mode, original) => !!(mode && original && original.remote_id && original.account_id === a.id);

/** The start of the first range Graph still expects (nextExpectedRanges: ['2097152-'] …) → a number or null. */
function nextStart(j) {
  const r = j && (j.nextExpectedRanges || j.NextExpectedRanges);
  const m = Array.isArray(r) && r.length ? /^(\d+)/.exec(String(r[0])) : null;
  return m ? Number(m[1]) : null;
}

/** File `f` ({ mediaId, filename, contentType }) onto Graph message `id` — streamed by GateControl. */
async function attach(gc, a, id, f) {
  const info = await gc.media.info(f.mediaId);
  if (!info) throw fail('not_found', { field: 'attachments' });
  const name = f.filename || info.name || 'Datei';
  const contentType = f.contentType || info.mime || 'application/octet-stream';
  const base = `/me/messages/${encodeURIComponent(id)}/attachments`;
  if (info.bytes < SMALL_MAX) {
    const r = await ms.graph(gc, a, 'POST', base, { '@odata.type': '#microsoft.graph.fileAttachment', name, contentType, contentBytes: gc.http.MEDIA_BASE64 },
      { bodyMedia: { mediaId: f.mediaId }, timeoutMs: UPLOAD_TIMEOUT });
    if (r.status >= 400) throw fail(r.status === 413 ? 'too_large' : 'unreachable', { reason: ms.graphError(r) });
    return;
  }
  const s = await ms.graph(gc, a, 'POST', `${base}/createUploadSession`, { AttachmentItem: { attachmentType: 'file', name, size: info.bytes, contentType } });
  const url = s.json && s.json.uploadUrl;
  if (s.status >= 400 || typeof url !== 'string' || !UPLOAD_URL_RE.test(url)) throw fail(s.status === 413 ? 'too_large' : 'unreachable', { reason: ms.graphError(s) });
  let start = nextStart(s.json) || 0;
  for (let i = 0; i < PIECES_MAX && start < info.bytes; i++) {
    const end = Math.min(info.bytes, start + PIECE) - 1;
    let r;
    try {
      // the upload URL carries its own authorization: no Bearer token here
      r = await gc.http.fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, bodyMedia: { mediaId: f.mediaId, start, end }, timeoutMs: UPLOAD_TIMEOUT });
    } catch (e) {
      throw fail('unreachable', { reason: (e && e.code) || 'network' });
    }
    if (r.status === 201) return;
    if (r.status === 429 || r.status === 503) throw fail('busy', { retryAfter: Number((r.headers || {})['retry-after']) || 30 });
    if (r.status !== 200) throw fail('unreachable', { reason: `upload_${r.status}` });
    let j = null;
    try { j = typeof r.body === 'string' ? JSON.parse(r.body || '{}') : r.body; } catch { j = null; }
    const next = nextStart(j);
    if (next == null) return; // nothing more expected
    start = next > start ? next : end + 1;
  }
  if (start < info.bytes) throw fail('unreachable', { reason: 'upload_incomplete' });
}

/**
 * Graph's own forward carries every attachment of the original: the ones the person took out of the draft go again.
 * keep: [{ name, size }] of the original's attachments that stay.
 */
async function pruneForward(gc, a, id, keep) {
  const j = await get(gc, a, `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,size,isInline`);
  const left = [...keep];
  for (const t of (j && j.value) || []) {
    if (t.isInline) continue;
    let i = left.findIndex((k) => k.name === t.name && Number(k.size) === Number(t.size));
    if (i < 0) i = left.findIndex((k) => k.name === t.name);
    if (i >= 0) { left.splice(i, 1); continue; }
    const r = await ms.graph(gc, a, 'DELETE', `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(t.id)}`);
    if (r.status >= 400 && r.status !== 404) throw fail('unreachable', { reason: ms.graphError(r) });
  }
}

/** A Graph draft that did not go out is removed again (best effort). */
async function discard(gc, a, id) {
  try { await ms.graph(gc, a, 'DELETE', `/me/messages/${encodeURIComponent(id)}`); } catch { /* stays in Entwürfe */ }
}

/**
 * Send a draft through Graph: an answer or forward of a Graph message of this account as Graph's own reply (threading,
 * the forwarded attachments stay — those taken out go), anything else as a new message. d.files: [{ mediaId, filename,
 * contentType }] go along as attachments (GateControl ≥ 1.217.0, `canAttach`); d.keep: the original's attachments that
 * stay in a forward (null: all). Without files and own reply: one sendMail.
 */
async function send(gc, a, d, original) {
  const message = { subject: d.subject, body: { contentType: 'HTML', content: d.html }, toRecipients: recip(d.to), ccRecipients: recip(d.cc), bccRecipients: recip(d.bcc) };
  const files = canAttach(gc) ? (d.files || []) : [];
  const own = ownReply(a, d.mode, original);
  if (!own && !files.length) {
    const r = await ms.graph(gc, a, 'POST', '/me/sendMail', { message, saveToSentItems: true });
    if (r.status >= 400) throw fail(r.status === 400 ? 'invalid' : 'unreachable', { reason: ms.graphError(r) });
    return { messageId: null };
  }
  let id;
  if (own) {
    const action = d.mode === 'forward' ? 'createForward' : d.mode === 'replyAll' ? 'createReplyAll' : 'createReply';
    const c = await ms.graph(gc, a, 'POST', `/me/messages/${encodeURIComponent(original.remote_id)}/${action}`, {});
    if (c.status >= 400 || !c.json || !c.json.id) throw fail('unreachable', { reason: ms.graphError(c) });
    id = c.json.id;
  } else {
    const c = await ms.graph(gc, a, 'POST', '/me/messages', message);
    if (c.status >= 400 || !c.json || !c.json.id) throw fail(c.status === 400 ? 'invalid' : 'unreachable', { reason: ms.graphError(c) });
    id = c.json.id;
  }
  try {
    if (own) {
      const u = await ms.graph(gc, a, 'PATCH', `/me/messages/${encodeURIComponent(id)}`, message);
      if (u.status >= 400) throw fail('unreachable', { reason: ms.graphError(u) });
      if (d.mode === 'forward' && Array.isArray(d.keep)) await pruneForward(gc, a, id, d.keep);
    }
    for (const f of files) await attach(gc, a, id, f);
  } catch (e) {
    await discard(gc, a, id);
    throw e;
  }
  const s = await ms.graph(gc, a, 'POST', `/me/messages/${encodeURIComponent(id)}/send`, {});
  if (s.status >= 400) {
    await discard(gc, a, id);
    throw fail('unreachable', { reason: ms.graphError(s) });
  }
  return { messageId: null };
}

/** GET /me → { email, name } of a freshly signed-in account. */
async function me(gc, a) {
  const x = await get(gc, a, '/me?$select=displayName,mail,userPrincipalName');
  return { email: String((x && (x.mail || x.userPrincipalName)) || '').toLowerCase(), name: (x && x.displayName) || '' };
}

module.exports = { syncFolders, syncFolder, older, message, download, patch, move, destroy, search, send, me, headerOf, canAttach, ownReply, WELL_KNOWN, SMALL_MAX, PIECE };
