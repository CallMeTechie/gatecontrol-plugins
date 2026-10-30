'use strict';

// Writing (C2 "Schreiben"): drafts with attachments from the device, from a mail (forward) or from Drive (a copy or a
// link), the warnings, the outbox (sent 10 s after "Senden" — undo until then — or at the planned time) and sending:
// IMAP accounts through GateControl's SMTP (gc.mail.smtp.send) with a copy into "Gesendet" (not Gmail: it keeps one
// itself), Microsoft accounts through Graph (graph.js — attachments there only as links: the plugin never holds the
// bytes Graph wants inline). Contacts for the suggestions.

const store = require('./store');
const providers = require('./providers');
const engine = require('./engine');
const graph = require('./graph');
const messages = require('./messages');
const mailstore = require('./mailstore');
const drive = require('./drive');
const push = require('./push');
const { t } = require('./text');
const secrets = require('./secrets');
const { fail, posInt, people, parse, clip, line, esc, textHtml, htmlText } = require('./util');

const MEDIA_RE = /^[0-9a-f]{32}$/;

const UNDO_MS = 10000;
const TIMER_MS = 120000;
const SEND_AHEAD_MAX = 366 * 86400000;
const HTML_MAX = 2 * 1024 * 1024;
const ATTS_MAX = 50;
const RETRIES = 3;

const timers = new Map();

async function own(gc, userId, id) {
  const d = posInt(id) ? await store.one(gc, 'SELECT * FROM drafts WHERE id = ? AND user_id = ?', [posInt(id), userId]) : null;
  if (!d) throw fail('not_found');
  return d;
}

async function accountOf(gc, userId, id) {
  const a = posInt(id) ? await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [posInt(id), userId]) : null;
  if (!a) throw fail('not_found', { field: 'accountId' });
  return a;
}

const prefixed = (subject, p) => (new RegExp(`^\\s*(${p}|re|aw|fwd?|wg)\\s*:`, 'i').test(subject) && p !== 'Fwd' ? subject : (p === 'Fwd' && /^\s*(fwd?|wg)\s*:/i.test(subject) ? subject : `${p}: ${subject}`));

/** The quote of the original below an answer / forward. */
function quoteOf(lang, m, full, mode) {
  const when = new Date(m.date).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });
  const from = m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email;
  const body = full.html || textHtml(full.text || '');
  if (mode === 'forward') {
    const to = parse(m.to_json, []).map((p) => p.email).join(', ');
    return `<p>${esc(t(lang, 'compose.fwd_head'))}<br>${esc(t(lang, 'compose.from'))}: ${esc(from)}<br>${esc(t(lang, 'compose.date'))}: ${esc(when)}<br>`
      + `${esc(t(lang, 'compose.subject'))}: ${esc(m.subject)}<br>${esc(t(lang, 'compose.to'))}: ${esc(to)}</p>${body}`;
  }
  return `<p>${esc(t(lang, 'compose.wrote', { when, who: from }))}</p><blockquote>${body}</blockquote>`;
}

/** No script, frame, form or event handler in a draft's HTML (its pictures stay as they are — the mail needs them). */
function scrub(html) {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|form|input|button|meta|link|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

/** The original's body for a quote: its external pictures as they were (the stored copy has gc-img:<n>). */
async function originalBody(gc, m) {
  const b = await store.one(gc, 'SELECT html, text, images_json FROM bodies WHERE message_id = ?', [m.id]);
  if (!b) return { html: null, text: m.snippet || '' };
  const images = parse(b.images_json, []);
  const html = b.html ? b.html.replace(/gc-img:(\d{1,4})/g, (all, n) => (images[Number(n)] ? esc(images[Number(n)]) : '')) : null;
  return { html, text: b.text || '' };
}

/** The person's own addresses (never a recipient of "Allen antworten"). */
async function ownAddresses(gc, userId) {
  return new Set((await store.all(gc, 'SELECT email FROM accounts WHERE user_id = ?', [userId])).map((r) => r.email));
}

/** The draft row's attachments → the API's list. */
async function attsOf(gc, draftId) {
  return (await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ? ORDER BY id', [draftId])).map((x) => ({
    id: x.id, name: x.name, size: x.size, mime: x.mime, as: x.as_link ? 'link' : 'copy', ...(x.as_link ? { url: x.url } : {}),
  }));
}

/** Can Graph send attachment `x` of draft `d`: a link, or an attachment of the mail it forwards (Graph's own forward)? */
const graphOk = (d, x) => !!x.as_link || (x.kind === 'message' && d.mode === 'forward' && x.src_message === d.reply_msg);

/** Warnings of a draft: no subject, a password, too large (switched to links), files Microsoft cannot send. */
async function warnings(gc, lang, d, a) {
  const out = [];
  const atts = await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ?', [d.id]);
  if (!String(d.subject || '').trim()) out.push({ kind: 'no_subject', text: t(lang, 'warn.no_subject') });
  if (atts.some((x) => x.has_password)) out.push({ kind: 'password', text: t(lang, 'warn.link_password') });
  else if (/\b(passwor[dt]|kennwort|pin)\s*[:=]\s*\S{3,}/i.test(htmlText(d.html || ''))) out.push({ kind: 'password', text: t(lang, 'warn.password') });
  if (atts.some((x) => x.auto_link)) out.push({ kind: 'too_large', text: t(lang, engine.isGraph(a) ? 'warn.graph_links' : 'warn.too_large') });
  if (engine.isGraph(a) && atts.some((x) => !graphOk(d, x))) out.push({ kind: 'too_large', text: t(lang, 'warn.graph_files') });
  return out;
}

async function view(gc, lang, d) {
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [d.account_id]);
  return {
    id: d.id, accountId: d.account_id, to: parse(d.to_json, []), cc: parse(d.cc_json, []), bcc: parse(d.bcc_json, []), subject: d.subject, html: d.html,
    attachments: await attsOf(gc, d.id), warnings: a ? await warnings(gc, lang, d, a) : [],
  };
}

/** Add attachment `x` (one of the Att forms) to draft `d`. */
async function addAtt(gc, ctx, d, a, x) {
  if (!x || typeof x !== 'object') throw fail('invalid', { field: 'attachments' });
  if (x.mediaId != null) {
    // a file the device uploaded (PUT …/media): the person's own, not yet used
    if (typeof x.mediaId !== 'string' || !MEDIA_RE.test(x.mediaId)) throw fail('invalid', { field: 'attachments' });
    const info = await gc.media.info(x.mediaId);
    if (!info || info.owner !== ctx.userId || info.claimed) throw fail('invalid', { field: 'attachments', reason: 'media' });
    await gc.media.claim(x.mediaId);
    await store.run(gc, 'INSERT INTO draft_atts (draft_id, kind, media_id, name, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
      [d.id, 'media', x.mediaId, clip(line(x.name || info.name || '') || 'Datei', 200), info.mime, info.bytes]);
    return;
  }
  if (x.messageId != null) {
    const { m, t: att } = await messages.attachmentRow(gc, ctx.userId, x.messageId, x.attachmentId);
    await store.run(gc, 'INSERT INTO draft_atts (draft_id, kind, name, mime, size, src_message, src_att) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.id, 'message', att.name, att.mime, att.size, m.id, att.id]);
    return;
  }
  if (x.driveNodeId != null) {
    const node = posInt(x.driveNodeId);
    if (!node) throw fail('invalid', { field: 'attachments' });
    const as = x.as === 'link' ? 'link' : 'copy';
    if (as === 'link') {
      const days = x.expiresDays == null ? 14 : Number(x.expiresDays);
      const link = await drive.shareLink(gc, ctx.userId, node, days, x.password);
      await store.run(gc, 'INSERT INTO draft_atts (draft_id, kind, name, mime, size, as_link, url, drive_node, link_days, has_password) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
        [d.id, 'drive', clip(line(x.name || '') || link.name || 'Drive', 200), 'text/uri-list', 0, link.url, node, days, x.password ? 1 : 0]);
      return;
    }
    const f = await drive.giveFile(gc, ctx.userId, node);
    await gc.media.claim(f.mediaId);
    await store.run(gc, 'INSERT INTO draft_atts (draft_id, kind, media_id, name, mime, size, drive_node) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.id, 'drive', f.mediaId, f.name, f.mime, f.size, node]);
    return;
  }
  if (x.id != null) return; // an attachment of this draft that stays (handled by the caller)
  throw fail('invalid', { field: 'attachments' });
}

/**
 * Too large for the provider (or a Microsoft account): copies from Drive become links (auto_link); files from the device
 * or a mail cannot → 413 too_large.
 */
async function fit(gc, ctx, d, a, staying = () => true) {
  const atts = (await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ? AND as_link = 0', [d.id])).filter(staying);
  const limit = providers.maxBytes(a.provider);
  let total = atts.reduce((s, x) => s + (Number(x.size) || 0), 0) + Buffer.byteLength(d.html || '');
  const graphAcc = engine.isGraph(a);
  for (const x of atts.filter((y) => y.kind === 'drive' && y.drive_node).sort((p, q) => q.size - p.size)) {
    if (!graphAcc && total * 1.37 <= limit) break;
    const link = await drive.shareLink(gc, ctx.userId, x.drive_node, 14, null).catch(() => null);
    if (!link) continue;
    if (x.media_id) { try { await gc.media.delete(x.media_id); } catch { /* gone */ } }
    await store.run(gc, "UPDATE draft_atts SET as_link = 1, url = ?, media_id = NULL, mime = 'text/uri-list', auto_link = 1, link_days = 14 WHERE id = ?", [link.url, x.id]);
    total -= Number(x.size) || 0;
  }
  if (!graphAcc && total * 1.37 > limit) throw fail('too_large', { max: limit });
}

/** Fill a draft row from body `b` (POST and PUT). */
async function fill(gc, ctx, d, b, creating) {
  const a = await accountOf(gc, ctx.userId, b.accountId != null ? b.accountId : d.account_id);
  const to = b.to !== undefined ? people(b.to, 'to') : parse(d.to_json, []);
  const cc = b.cc !== undefined ? people(b.cc, 'cc') : parse(d.cc_json, []);
  const bcc = b.bcc !== undefined ? people(b.bcc, 'bcc') : parse(d.bcc_json, []);
  if (b.subject !== undefined && typeof b.subject !== 'string') throw fail('invalid', { field: 'subject' });
  if (b.html !== undefined && (typeof b.html !== 'string' || b.html.length > HTML_MAX)) throw fail('invalid', { field: 'html' });
  // the draft's HTML is the person's own text (and quotes of sanitized mail): scripts, frames and event handlers never stay
  const html = b.html !== undefined ? scrub(b.html) : d.html;
  const subject = b.subject !== undefined ? clip(line(b.subject), 500) : d.subject;
  await store.run(gc, 'UPDATE drafts SET account_id = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, html = ?, updated_at = ? WHERE id = ?',
    [a.id, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, html, Date.now(), d.id]);
  const before = new Set((await store.all(gc, 'SELECT id FROM draft_atts WHERE draft_id = ?', [d.id])).map((x) => x.id));
  let keep = null;
  try {
    if (b.attachments !== undefined) {
      if (!Array.isArray(b.attachments) || b.attachments.length > ATTS_MAX) throw fail('invalid', { field: 'attachments' });
      keep = new Set(b.attachments.filter((x) => x && x.id != null).map((x) => posInt(x.id)));
      for (const x of b.attachments) await addAtt(gc, ctx, d, a, x);
    }
    // the size counts what stays
    const staying = keep ? (x) => !before.has(x.id) || keep.has(x.id) : () => true;
    await fit(gc, ctx, await store.one(gc, 'SELECT * FROM drafts WHERE id = ?', [d.id]), a, staying);
  } catch (e) {
    // a refused attachment: what this call added goes again, the draft keeps its attachments
    for (const x of await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ?', [d.id])) {
      if (before.has(x.id)) continue;
      if (x.media_id && x.kind !== 'message') { try { await gc.media.delete(x.media_id); } catch { /* gone */ } }
      await store.run(gc, 'DELETE FROM draft_atts WHERE id = ?', [x.id]);
    }
    throw e;
  }
  if (keep && !creating) {
    for (const x of await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ?', [d.id])) {
      if (!before.has(x.id) || keep.has(x.id)) continue;
      if (x.media_id && x.kind !== 'message') { try { await gc.media.delete(x.media_id); } catch { /* gone */ } }
      await store.run(gc, 'DELETE FROM draft_atts WHERE id = ?', [x.id]);
    }
  }
  return store.one(gc, 'SELECT * FROM drafts WHERE id = ?', [d.id]);
}

/** POST drafts { accountId, to, cc, bcc, subject, html, replyTo?, mode?, attachments } → { draft } */
async function create(gc, ctx, b) {
  const body = b && typeof b === 'object' ? { ...b } : {};
  let original = null;
  const mode = body.mode == null ? null : String(body.mode);
  if (mode && !['reply', 'replyAll', 'forward'].includes(mode)) throw fail('invalid', { field: 'mode' });
  if (body.replyTo != null) original = await messages.own(gc, ctx.userId, body.replyTo);
  if (mode && !original) throw fail('invalid', { field: 'replyTo' });
  // an answer always goes out of the account the mail came to
  if (original && mode !== 'forward') body.accountId = original.account_id;
  if (original && body.accountId == null) body.accountId = original.account_id;
  if (body.accountId == null) {
    const first = await store.one(gc, 'SELECT id FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1', [ctx.userId]);
    if (!first) throw fail('not_found', { field: 'accountId' });
    body.accountId = first.id;
  }
  const a = await accountOf(gc, ctx.userId, body.accountId);
  if (original && mode) {
    await messages.full(gc, original); // the body from the server when it is not here
    const full = await originalBody(gc, original);
    const mine = await ownAddresses(gc, ctx.userId);
    if (body.to === undefined && mode !== 'forward') {
      const replyTo = parse(original.reply_to_json, []);
      const first = replyTo.length ? replyTo : [{ name: original.from_name, email: original.from_email }];
      let to = first.filter((p) => p.email && !mine.has(p.email));
      if (!to.length) to = first;
      let cc = [];
      if (mode === 'replyAll') {
        to = [...to, ...parse(original.to_json, []).filter((p) => !mine.has(p.email) && !to.some((x) => x.email === p.email))];
        cc = parse(original.cc_json, []).filter((p) => !mine.has(p.email) && !to.some((x) => x.email === p.email));
      }
      body.to = to;
      if (body.cc === undefined) body.cc = cc;
    }
    if (body.subject === undefined) body.subject = prefixed(original.subject || '', mode === 'forward' ? 'Fwd' : 'Re');
    if (body.html === undefined) {
      const sigHtml = a.signature ? `<p>-- <br>${esc(a.signature).replace(/\n/g, '<br>')}</p>` : '';
      body.html = `<p></p>${sigHtml}${quoteOf(ctx.lang, original, full, mode)}`;
    }
    if (mode === 'forward' && body.attachments === undefined) {
      body.attachments = (await store.all(gc, 'SELECT id FROM attachments WHERE message_id = ? AND inline = 0', [original.id])).map((x) => ({ messageId: original.id, attachmentId: x.id }));
    }
  } else if (body.html === undefined && a.signature) {
    body.html = `<p></p><p>-- <br>${esc(a.signature).replace(/\n/g, '<br>')}</p>`;
  }
  const now = Date.now();
  const refs = original ? [...String(original.refs || '').split(/\s+/).filter(Boolean), original.message_id].filter(Boolean).slice(-20).join(' ') : null;
  const r = await store.run(gc, 'INSERT INTO drafts (user_id, account_id, subject, html, reply_msg, mode, in_reply_to, refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ctx.userId, a.id, '', '', original ? original.id : null, mode, original && mode !== 'forward' ? original.message_id : null, mode !== 'forward' ? refs : null, now, now]);
  const d = await store.one(gc, 'SELECT * FROM drafts WHERE id = ?', [Number(r.lastInsertRowid)]);
  try {
    return { draft: await view(gc, ctx.lang, await fill(gc, ctx, d, body, true)) };
  } catch (e) {
    await drop(gc, d.id);
    throw e;
  }
}

/** PUT drafts/<id> */
async function update(gc, ctx, id, b) {
  const d = await own(gc, ctx.userId, id);
  if (await store.one(gc, "SELECT 1 AS x FROM outbox WHERE draft_id = ? AND state IN ('waiting', 'sending')", [d.id])) throw fail('not_waiting');
  return { draft: await view(gc, ctx.lang, await fill(gc, ctx, d, b && typeof b === 'object' ? b : {}, false)) };
}

async function get(gc, ctx, id) {
  return { draft: await view(gc, ctx.lang, await own(gc, ctx.userId, id)) };
}

/** A draft and its own files go. */
async function drop(gc, id) {
  for (const x of await store.all(gc, "SELECT media_id FROM draft_atts WHERE draft_id = ? AND media_id IS NOT NULL AND kind <> 'message'", [id])) {
    try { await gc.media.delete(x.media_id); } catch { /* gone */ }
  }
  await store.run(gc, 'DELETE FROM draft_atts WHERE draft_id = ?', [id]);
  await store.run(gc, 'DELETE FROM drafts WHERE id = ?', [id]);
}

async function remove(gc, ctx, id) {
  const d = await own(gc, ctx.userId, id);
  await store.run(gc, "DELETE FROM outbox WHERE draft_id = ? AND state IN ('waiting', 'failed')", [d.id]);
  await drop(gc, d.id);
  return { ok: true };
}

// ─── the outbox ─────────────────────────────────

/** POST drafts/<id>/send { sendAt? } → { outboxId, undoUntil, sendAt } */
async function send(gc, ctx, id, b) {
  const d = await own(gc, ctx.userId, id);
  const to = [...parse(d.to_json, []), ...parse(d.cc_json, []), ...parse(d.bcc_json, [])];
  if (!to.length) throw fail('invalid', { field: 'to' });
  const now = Date.now();
  let at = now + UNDO_MS;
  if (b && b.sendAt != null) {
    const s = Number(b.sendAt);
    if (!Number.isSafeInteger(s) || s > now + SEND_AHEAD_MAX) throw fail('invalid', { field: 'sendAt' });
    at = Math.max(at, s);
  }
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [d.account_id]);
  if (engine.isGraph(a) && (await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ?', [d.id])).some((x) => !graphOk(d, x))) throw fail('attachments_unsupported');
  await store.run(gc, "DELETE FROM outbox WHERE draft_id = ? AND state = 'failed'", [d.id]);
  if (await store.one(gc, 'SELECT 1 AS x FROM outbox WHERE draft_id = ?', [d.id])) throw fail('not_waiting');
  const r = await store.run(gc, 'INSERT INTO outbox (draft_id, user_id, account_id, subject, send_at, undo_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [d.id, ctx.userId, d.account_id, d.subject, at, now + UNDO_MS, now]);
  const outboxId = Number(r.lastInsertRowid);
  schedule(gc, outboxId, at);
  return { outboxId, undoUntil: now + UNDO_MS, sendAt: at };
}

/** POST outbox/<id>/cancel → { draftId } */
async function cancel(gc, ctx, id) {
  const o = posInt(id) ? await store.one(gc, 'SELECT * FROM outbox WHERE id = ? AND user_id = ?', [posInt(id), ctx.userId]) : null;
  if (!o) throw fail('not_found');
  if (o.state === 'sending') throw fail('not_waiting');
  await store.run(gc, 'DELETE FROM outbox WHERE id = ?', [o.id]);
  const tm = timers.get(o.id);
  if (tm) { clearTimeout(tm); timers.delete(o.id); }
  return { draftId: o.draft_id };
}

/** GET outbox */
async function outbox(gc, ctx) {
  const rows = await store.all(gc, 'SELECT * FROM outbox WHERE user_id = ? ORDER BY send_at', [ctx.userId]);
  return { items: rows.map((o) => ({ id: o.id, draftId: o.draft_id, accountId: o.account_id, subject: o.subject, sendAt: o.send_at, state: o.state, ...(o.error ? { error: o.error } : {}) })) };
}

function schedule(gc, id, at) {
  const wait = at - Date.now();
  if (wait > TIMER_MS) return; // the background run takes it
  if (timers.has(id)) clearTimeout(timers.get(id));
  const tm = setTimeout(() => { timers.delete(id); sendOne(gc, id).catch(() => {}); }, Math.max(0, wait));
  if (tm.unref) tm.unref();
  timers.set(id, tm);
}

/** The draft's message for gc.mail.smtp.send (attachments as media of the plugin; links into the text). */
async function messageOf(gc, d, a) {
  const atts = await store.all(gc, 'SELECT * FROM draft_atts WHERE draft_id = ? ORDER BY id', [d.id]);
  const files = [];
  for (const x of atts.filter((y) => !y.as_link)) {
    let mediaId = x.media_id;
    if (x.kind === 'message') {
      const m = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [x.src_message]);
      const att = m ? await store.one(gc, 'SELECT * FROM attachments WHERE id = ?', [x.src_att]) : null;
      if (!m || !att) continue;
      const acc = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]);
      mediaId = (await engine.attachment(gc, acc, m, att)).mediaId;
    }
    if (mediaId) files.push({ mediaId, filename: x.name, contentType: x.mime });
  }
  const links = atts.filter((y) => y.as_link && y.url);
  const linkHtml = links.length ? `<p>${links.map((l) => `<a href="${esc(l.url)}">${esc(l.name)}</a>`).join('<br>')}</p>` : '';
  const html = (d.html || '') + linkHtml;
  return {
    from: { name: a.name || '', address: a.email }, to: parse(d.to_json, []).map((p) => ({ name: p.name, address: p.email })),
    cc: parse(d.cc_json, []).map((p) => ({ name: p.name, address: p.email })), bcc: parse(d.bcc_json, []).map((p) => ({ name: p.name, address: p.email })),
    subject: d.subject || '', html, text: htmlText(html),
    ...(d.in_reply_to ? { inReplyTo: d.in_reply_to } : {}), ...(d.refs ? { references: d.refs.split(/\s+/).filter(Boolean) } : {}),
    attachments: files,
  };
}

/** Send outbox entry `id` now. */
async function sendOne(gc, id) {
  const o = await store.one(gc, "SELECT * FROM outbox WHERE id = ? AND state = 'waiting'", [id]);
  if (!o || o.send_at > Date.now() + 1000) return false;
  const claimed = await store.run(gc, "UPDATE outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ? AND state = 'waiting'", [id]);
  if (!claimed.changes) return false;
  const d = await store.one(gc, 'SELECT * FROM drafts WHERE id = ?', [o.draft_id]);
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [o.account_id]);
  if (!d || !a) { await store.run(gc, 'DELETE FROM outbox WHERE id = ?', [id]); return false; }
  try {
    const original = d.reply_msg ? await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [d.reply_msg]) : null;
    if (engine.isGraph(a)) {
      const msg = await messageOf(gc, { ...d, html: d.html }, a);
      await engine.withAccount(gc, a, () => graph.send(gc, a, { mode: d.mode, subject: d.subject, html: msg.html, to: parse(d.to_json, []), cc: parse(d.cc_json, []), bcc: parse(d.bcc_json, []) }, original));
    } else {
      const cred = await secrets.get(gc, a.id);
      if (!cred || !cred.password) throw Object.assign(fail('auth_failed'), { auth: true });
      const message = await messageOf(gc, d, a);
      let res;
      try {
        res = await gc.mail.smtp.send({ host: a.smtp_host, port: a.smtp_port, security: a.smtp_security, auth: { user: a.username || a.email, pass: cred.password }, message, appendCopy: a.provider !== 'gmail' });
      } catch (e) { throw await engine.mailError(gc, a, e); }
      if (res && res.raw && res.raw.mediaId) {
        try { await engine.appendSent(gc, a, res.raw.mediaId); } catch (e) { gc.log.warn('copy to sent failed', a.id, (e && e.code) || 'error'); }
        try { await gc.media.delete(res.raw.mediaId); } catch { /* gone */ }
      }
    }
    if (original && d.mode !== 'forward') {
      const acc = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [original.account_id]);
      try { await engine.setFlags(gc, acc, [original], { answered: true }); } catch { /* the flag only */ }
    }
    const now = Date.now();
    for (const p of [...parse(d.to_json, []), ...parse(d.cc_json, []), ...parse(d.bcc_json, [])]) await mailstore.contact(gc, d.user_id, p, 'sent', now);
    await store.run(gc, 'DELETE FROM outbox WHERE id = ?', [id]);
    await drop(gc, d.id);
    await push.changed(gc, d.user_id, a.id, null);
    // the sent folder shows it after the next sync
    engine.syncInbox(gc, a).catch(() => {});
    return true;
  } catch (e) {
    const code = (e && e.code) || 'failed';
    const retry = (code === 'unreachable' || code === 'busy') && o.attempts + 1 < RETRIES;
    if (retry) {
      await store.run(gc, "UPDATE outbox SET state = 'waiting', send_at = ?, error = ? WHERE id = ?", [Date.now() + 60000, code, id]);
      schedule(gc, id, Date.now() + 60000);
    } else {
      const err = code === 'ERR_MAIL_REJECTED' ? 'rejected' : code;
      await store.run(gc, "UPDATE outbox SET state = 'failed', error = ? WHERE id = ?", [String(err).slice(0, 60), id]);
      await push.sendFailed(gc, d.user_id, id, d.subject);
      await push.changed(gc, d.user_id, a.id, null);
    }
    gc.log.warn('send failed', id, code);
    return false;
  }
}

/** The background run: every due entry (timers are lost with a restart). */
async function due(gc, now) {
  // an entry stuck in "sending" (the process ended meanwhile) is tried again
  await store.run(gc, "UPDATE outbox SET state = 'waiting' WHERE state = 'sending' AND send_at < ?", [now - 10 * 60000]);
  const rows = await store.all(gc, "SELECT id FROM outbox WHERE state = 'waiting' AND send_at <= ? ORDER BY send_at LIMIT 20", [now + 1000]);
  for (const r of rows) await sendOne(gc, r.id);
  for (const r of await store.all(gc, "SELECT id, send_at FROM outbox WHERE state = 'waiting' AND send_at > ? AND send_at <= ?", [now + 1000, now + TIMER_MS])) schedule(gc, r.id, r.send_at);
  return rows.length;
}

function stop() {
  for (const tm of timers.values()) clearTimeout(tm);
  timers.clear();
}

// ─── contacts ───────────────────────────────────

/** GET contacts?q= → { items: [{ name, email, source }] } (≤ 10) */
async function contacts(gc, ctx, q) {
  const text = String(q || '').trim().toLowerCase().slice(0, 100);
  const mine = await ownAddresses(gc, ctx.userId);
  const out = [];
  // people of this GateControl with a Mail account
  if (text) {
    let users = [];
    try { users = await gc.users.list(); } catch { users = []; }
    const names = new Map(users.map((u) => [u.id, u.name]));
    const rows = await store.all(gc, 'SELECT user_id, email, MIN(id) AS id FROM accounts WHERE user_id <> ? GROUP BY user_id', [ctx.userId]);
    for (const r of rows) {
      const name = names.get(r.user_id) || '';
      if (!names.has(r.user_id)) continue;
      if (name.toLowerCase().includes(text) || r.email.includes(text)) out.push({ name, email: r.email, source: 'person' });
    }
  }
  const like = `%${text.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const rows = await store.all(gc, `SELECT email, name FROM contacts WHERE user_id = ? AND (? = '' OR email LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\')
    ORDER BY sent DESC, last_at DESC LIMIT 30`, [ctx.userId, text, like, like]);
  for (const r of rows) {
    if (mine.has(r.email) || out.some((x) => x.email === r.email)) continue;
    out.push({ name: r.name || '', email: r.email, source: 'recent' });
  }
  return { items: out.slice(0, 10) };
}

/** Service new_draft (Drive: "Per Mail senden"): { files: [{ mediaId, name? }], subject? } handed over → { ok, draftId } */
async function serviceDraft(gc, user, payload) {
  if (!user || !Number.isSafeInteger(user.id)) return { ok: false, code: 'invalid' };
  const p = payload && typeof payload === 'object' ? payload : {};
  const files = Array.isArray(p.files) ? p.files.slice(0, 20) : [];
  try {
    const r = await create(gc, { userId: user.id, lang: p.lang === 'en' ? 'en' : 'de', userName: user.name }, {
      subject: typeof p.subject === 'string' ? p.subject : '', attachments: files.map((f) => ({ mediaId: f && f.mediaId, name: f && f.name })),
    });
    return { ok: true, draftId: r.draft.id };
  } catch (e) {
    return { ok: false, code: (e && typeof e.code === 'string' && e.code) || 'failed' };
  }
}

module.exports = { create, update, get, remove, send, cancel, outbox, due, sendOne, contacts, serviceDraft, stop, prefixed };
