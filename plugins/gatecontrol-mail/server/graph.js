'use strict';

// Microsoft accounts through Microsoft Graph (gc.http.fetch, microsoft.js): the folders, a delta query per folder (the
// posteingang every minute, the rest every 15 minutes — engine.js), bodies and attachments on demand, flags, moves and
// sending through Graph. The delta round's nextLink is kept until it ends (a long first sync goes on in the next run),
// then its deltaLink.

const store = require('./store');
const mailstore = require('./mailstore');
const ms = require('./microsoft');
const { fail, line } = require('./util');

const WELL_KNOWN = { inbox: 'inbox', sentitems: 'sent', drafts: 'drafts', archive: 'archive', junkemail: 'junk', deleteditems: 'trash' };
const SELECT = 'id,internetMessageId,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,isRead,flag,hasAttachments,inferenceClassification';
const PAGE = 50;
const PAGES = 10;
const FOLDERS_MAX = 300;

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

/**
 * Send a draft through Graph: an answer or forward of a Graph message as Graph's own reply (threading, the forwarded
 * attachments stay), anything else with sendMail. Attachments of the draft must be links here (the plugin never holds
 * a file's bytes; Graph needs them inline).
 */
async function send(gc, a, d, original) {
  const message = { subject: d.subject, body: { contentType: 'HTML', content: d.html }, toRecipients: recip(d.to), ccRecipients: recip(d.cc), bccRecipients: recip(d.bcc) };
  if (original && original.remote_id && original.account_id === a.id && d.mode) {
    const action = d.mode === 'forward' ? 'createForward' : d.mode === 'replyAll' ? 'createReplyAll' : 'createReply';
    const c = await ms.graph(gc, a, 'POST', `/me/messages/${encodeURIComponent(original.remote_id)}/${action}`, {});
    if (c.status >= 400 || !c.json || !c.json.id) throw fail('unreachable', { reason: ms.graphError(c) });
    const u = await ms.graph(gc, a, 'PATCH', `/me/messages/${encodeURIComponent(c.json.id)}`, message);
    if (u.status >= 400) throw fail('unreachable', { reason: ms.graphError(u) });
    const s = await ms.graph(gc, a, 'POST', `/me/messages/${encodeURIComponent(c.json.id)}/send`, {});
    if (s.status >= 400) throw fail('unreachable', { reason: ms.graphError(s) });
    return { messageId: null };
  }
  const r = await ms.graph(gc, a, 'POST', '/me/sendMail', { message, saveToSentItems: true });
  if (r.status >= 400) throw fail(r.status === 400 ? 'invalid' : 'unreachable', { reason: ms.graphError(r) });
  return { messageId: null };
}

/** GET /me → { email, name } of a freshly signed-in account. */
async function me(gc, a) {
  const x = await get(gc, a, '/me?$select=displayName,mail,userPrincipalName');
  return { email: String((x && (x.mail || x.userPrincipalName)) || '').toLowerCase(), name: (x && x.displayName) || '' };
}

module.exports = { syncFolders, syncFolder, older, message, download, patch, move, destroy, search, send, me, headerOf, WELL_KNOWN };
