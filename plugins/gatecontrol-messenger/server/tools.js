'use strict';

// 1.4.0 — chat tools (features.msg_tools, README "Chat tools"): blocks, archive, pinned messages, chat
// lists, export, "remind me" and the suggestions of a message (items for a list, dates for a calendar).

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const messages = require('./messages');
const suggest = require('./suggest');
const { fail, posInt, text, iso, parseIso, parseJson } = require('./util');

const PINS_MAX = 3;
const LISTS_MAX = 20;
const LIST_NAME_MAX = 40;
const LIST_CONVS_MAX = 500;
const LIST_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const REMINDERS_MAX = 100;
const REMIND_MAX_MS = 366 * 86400000;
const EXPORT_MAX_BYTES = 800 * 1024;
const EXPORT_SCAN = 20000;

// ─── blocks ─────────────────────────────────────────────────────────────────

async function blocks(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT blocked_id, at FROM blocks WHERE user_id = ? ORDER BY at DESC', [ctx.viewer]);
  return {
    blocks: rows.map((r) => {
      const u = ctx.users.get(r.blocked_id);
      return { userId: r.blocked_id, name: u ? u.name : null, avatarUrl: u ? u.avatarUrl || null : null, initials: u ? u.initials || null : null, colorHex: u ? u.colorHex || null : null, at: iso(r.at), gone: !u };
    }),
  };
}

/** Everyone who shares a conversation with `a` or `b` should refresh what they see of each other. */
async function blockChanged(ctx, other) {
  const direct = await store.one(ctx.gc, 'SELECT id FROM conversations WHERE direct_key = ?', [`${Math.min(ctx.viewer, other)}:${Math.max(ctx.viewer, other)}`]);
  if (direct) live.queue(ctx.box, [ctx.viewer, other], 'conversation.update', { conversationId: direct.id, reason: 'blocks' });
  live.queue(ctx.box, [ctx.viewer, other], 'status.update', { userId: ctx.viewer });
  live.queue(ctx.box, [ctx.viewer], 'status.update', { userId: other });
}

async function block(ctx, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const id = posInt(b.userId);
  if (!id || id === ctx.viewer || !ctx.users.has(id)) throw fail('invalid');
  await store.run(ctx.gc, 'INSERT OR IGNORE INTO blocks (user_id, blocked_id, at) VALUES (?, ?, ?)', [ctx.viewer, id, ctx.now]);
  await blockChanged(ctx, id);
  return blocks(ctx);
}

async function unblock(ctx, idRaw) {
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  await store.run(ctx.gc, 'DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', [ctx.viewer, id]);
  if (ctx.users.has(id)) await blockChanged(ctx, id);
  return blocks(ctx);
}

// ─── archive, pins ──────────────────────────────────────────────────────────

async function archive(ctx, x, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || typeof b.archived !== 'boolean') throw fail('invalid');
  await store.run(ctx.gc, 'UPDATE members SET archived = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?', [b.archived ? 1 : 0, ctx.now, x.conv.id, ctx.viewer]);
  live.queue(ctx.box, [ctx.viewer], 'conversation.update', { conversationId: x.conv.id, reason: 'archive' });
}

function pinsOf(conv) {
  const l = parseJson(conv.pins, []);
  return Array.isArray(l) ? l.filter((v) => Number.isSafeInteger(v)) : [];
}

function mayPin(x) {
  if (x.conv.readonly) throw fail('readonly');
  if (x.conv.managed_by && x.me.role !== 'admin') throw fail('managed');
}

async function pin(ctx, x, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  mayPin(x);
  const id = posInt(b.messageId);
  if (!id) throw fail('invalid');
  const row = await messages.visibleMessage(ctx, x.me, id);
  if (row.deleted_at || row.kind === 'system') throw fail('invalid');
  const list = pinsOf(x.conv);
  if (!list.includes(id)) {
    if (list.length >= PINS_MAX) throw fail('too_many');
    list.push(id);
    await store.run(ctx.gc, 'UPDATE conversations SET pins = ?, updated_at = ? WHERE id = ?', [JSON.stringify(list), ctx.now, x.conv.id]);
    live.queue(ctx.box, x.members.map((m) => m.user_id), 'conversation.update', { conversationId: x.conv.id, reason: 'pins' });
  }
}

async function unpin(ctx, x, idRaw) {
  mayPin(x);
  const id = posInt(idRaw);
  const list = pinsOf(x.conv);
  if (!id || !list.includes(id)) throw fail('not_found');
  const next = list.filter((v) => v !== id);
  await store.run(ctx.gc, 'UPDATE conversations SET pins = ?, updated_at = ? WHERE id = ?', [next.length ? JSON.stringify(next) : null, ctx.now, x.conv.id]);
  live.queue(ctx.box, x.members.map((m) => m.user_id), 'conversation.update', { conversationId: x.conv.id, reason: 'pins' });
}

/** The pinned message ids the member sees (others' hidden ones and those before joining left out). */
async function pinnedFor(ctx, conv, me) {
  const out = [];
  for (const id of pinsOf(conv)) {
    if (id <= me.joined_msg_id) continue;
    const h = await store.one(ctx.gc, 'SELECT 1 AS x FROM hidden WHERE msg_id = ? AND user_id = ?', [id, me.user_id]);
    if (!h) out.push(id);
  }
  return out;
}

// ─── lists ──────────────────────────────────────────────────────────────────

async function lists(ctx) {
  const r = await store.one(ctx.gc, 'SELECT data_enc FROM lists WHERE user_id = ?', [ctx.viewer]);
  const data = r ? seal.openJson(r.data_enc) : null;
  return { lists: Array.isArray(data) ? data : [] };
}

async function putLists(ctx, body) {
  const raw = Array.isArray(body) ? body : (body && Array.isArray(body.lists) ? body.lists : null);
  if (!raw || raw.length > LISTS_MAX) throw fail('invalid');
  const mine = new Set((await store.all(ctx.gc, 'SELECT conv_id FROM members WHERE user_id = ? AND left_at IS NULL', [ctx.viewer])).map((r) => r.conv_id));
  const out = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !LIST_ID_RE.test(l.id) || out.some((o) => o.id === l.id)) throw fail('invalid');
    if (!Array.isArray(l.conversationIds) || l.conversationIds.length > LIST_CONVS_MAX) throw fail('invalid');
    const ids = [];
    for (const c of l.conversationIds) {
      const id = posInt(c);
      if (!id) throw fail('invalid');
      if (mine.has(id) && !ids.includes(id)) ids.push(id);
    }
    out.push({ id: l.id, name: text(l.name, LIST_NAME_MAX), conversationIds: ids });
  }
  await store.run(ctx.gc, 'INSERT INTO lists (user_id, data_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at',
    [ctx.viewer, out.length ? seal.sealJson(out) : null, ctx.now]);
  live.queue(ctx.box, [ctx.viewer], 'lists.update', {});
  return { lists: out };
}

// ─── export ─────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line of the export for a message row (null for nothing to show). */
function exportLine(ctx, conv, r, t) {
  const who = r.sender_id == null ? 'GateControl' : ((ctx.users.get(r.sender_id) || {}).name || t('portal.gone'));
  if (r.deleted_at) return `${stamp(r.created_at)} - ${who}: ${t('msg.deleted')}`;
  const meta = messages.metaOf(r) || {};
  const body = messages.bodyOf(r);
  let s;
  switch (r.kind) {
    case 'image': s = `<${t('kind.image')}${meta.fileName ? ': ' + meta.fileName : ''}>${body ? ' ' + body : ''}`; break;
    case 'voice': s = `<${t('kind.voice')}>`; break;
    case 'file': s = `<${t('kind.file')}: ${meta.fileName || '?'}>${body ? ' ' + body : ''}`; break;
    case 'location': s = `<${t('kind.location')}: ${meta.location ? `${meta.location.label ? meta.location.label + ' ' : ''}${meta.location.lat},${meta.location.lon}` : '?'}>`; break;
    case 'system': s = typeof body === 'string' && body ? body : `<${(meta.system && meta.system.event) || 'system'}>`; break;
    case 'poll': case 'event': case 'arrival': case 'action': case 'card':
      s = `<${t('kind.' + r.kind)}: ${require('./rich').summaryText(r.kind, meta) || ''}>${typeof body === 'string' && body ? ' ' + body : ''}`; break;
    default: s = typeof body === 'string' ? body : '';
  }
  if (r.kind === 'system' && !(meta.system && meta.system.event === 'notice')) return null;
  return `${stamp(r.created_at)} - ${who}: ${s}`;
}

/**
 * GET conversations/:id/export?format=txt&before=<id> → { format, mime, fileName, text, count, truncated, before }.
 * The newest messages up to ~800 KB, oldest first ("dd.mm.yy, HH:MM - Name: text"); `truncated` with
 * `before` = the oldest message id included → ask again with ?before= for the part before it.
 */
async function exportTxt(ctx, x, query, t) {
  const q = query || {};
  if (q.format != null && q.format !== 'txt') throw fail('invalid');
  const before = q.before == null || q.before === '' ? null : posInt(String(q.before));
  if (q.before != null && q.before !== '' && !before) throw fail('invalid');
  const rows = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${messages.VISIBLE_SQL}${before ? ' AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
    [...messages.visibleArgs(x.me), ...(before ? [before] : []), EXPORT_SCAN + 1]);
  const lines = [];
  let bytes = 0;
  let oldest = null;
  let truncated = rows.length > EXPORT_SCAN;
  for (const r of rows.slice(0, EXPORT_SCAN)) {
    const l = exportLine(ctx, x.conv, r, t);
    if (l == null) { oldest = r.id; continue; }
    const n = Buffer.byteLength(l, 'utf8') + 1;
    if (bytes + n > EXPORT_MAX_BYTES) { truncated = true; break; }
    bytes += n;
    lines.push(l);
    oldest = r.id;
  }
  const title = x.conv.kind === 'group' ? (seal.open(x.conv.title_enc) || 'Chat') : ((ctx.users.get((x.members.find((m) => m.user_id !== ctx.viewer) || {}).user_id) || {}).name || 'Chat');
  const safe = String(title).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'Chat';
  return { format: 'txt', mime: 'text/plain', fileName: `${t('export.file')} ${safe}.txt`, text: lines.reverse().join('\n') + (lines.length ? '\n' : ''), count: lines.length, truncated, before: truncated ? oldest : null };
}

// ─── reminders ──────────────────────────────────────────────────────────────

async function remind(ctx, x, id, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const at = parseIso(b.at);
  if (at == null || at <= ctx.now || at > ctx.now + REMIND_MAX_MS) throw fail('invalid');
  const row = await messages.visibleMessage(ctx, x.me, id);
  if (row.deleted_at) throw fail('deleted');
  const n = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND sent_at IS NULL', [ctx.viewer]);
  if (n && n.n >= REMINDERS_MAX) throw fail('too_many');
  const r = await store.run(ctx.gc, 'INSERT INTO reminders (user_id, conv_id, msg_id, at, created_at) VALUES (?, ?, ?, ?, ?)', [ctx.viewer, x.conv.id, id, at, ctx.now]);
  live.queue(ctx.box, [ctx.viewer], 'reminders.update', {});
  return { reminder: { id: r.lastInsertRowid, messageId: id, conversationId: x.conv.id, at: iso(at), createdAt: iso(ctx.now) } };
}

async function reminders(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM reminders WHERE user_id = ? AND sent_at IS NULL ORDER BY at ASC', [ctx.viewer]);
  const out = [];
  for (const r of rows) {
    const m = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [r.msg_id]);
    const me = m ? await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [m.conv_id, ctx.viewer]) : null;
    if (!m || !me) continue;
    out.push({ id: r.id, messageId: r.msg_id, conversationId: r.conv_id, at: iso(r.at), createdAt: iso(r.created_at), preview: previewOf(m) });
  }
  return { reminders: out };
}

function previewOf(m) {
  if (m.deleted_at) return null;
  const meta = messages.metaOf(m) || {};
  const t = messages.bodyOf(m);
  const s = (typeof t === 'string' && t) || meta.fileName || (meta.location && meta.location.label) || require('./rich').summaryText(m.kind, meta) || null;
  return s ? String(s).replace(/\s+/g, ' ').slice(0, 120) : null;
}

async function unremind(ctx, idRaw) {
  const id = posInt(idRaw);
  const r = id ? await store.one(ctx.gc, 'SELECT id FROM reminders WHERE id = ? AND user_id = ?', [id, ctx.viewer]) : null;
  if (!r) throw fail('not_found');
  await store.run(ctx.gc, 'DELETE FROM reminders WHERE id = ?', [id]);
  live.queue(ctx.box, [ctx.viewer], 'reminders.update', {});
  return { deleted: true };
}

/** Background: reminders due → push jobs (to the person, ignoring mute and dnd: they asked for it). */
async function dueReminders(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM reminders WHERE sent_at IS NULL AND at <= ? ORDER BY at LIMIT 200', [ctx.now]);
  for (const r of rows) {
    await store.run(ctx.gc, 'UPDATE reminders SET sent_at = ? WHERE id = ?', [ctx.now, r.id]);
    const m = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [r.msg_id]);
    const conv = m ? await store.one(ctx.gc, 'SELECT * FROM conversations WHERE id = ?', [m.conv_id]) : null;
    const me = conv ? await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [conv.id, r.user_id]) : null;
    if (!m || !conv || !me || !ctx.users.has(r.user_id)) continue;
    ctx.box.pushes.push({ custom: { kind: 'reminder', conv, members: [me], users: [r.user_id], senderId: m.sender_id, messageId: m.id, params: { preview: previewOf(m) || '' }, respectMute: false, respectDnd: false, reminderId: r.id } });
  }
  await store.run(ctx.gc, 'DELETE FROM reminders WHERE sent_at IS NOT NULL AND sent_at < ?', [ctx.now - 7 * 86400000]);
  return rows.length;
}

// ─── suggest ────────────────────────────────────────────────────────────────

async function suggestFor(ctx, x, id) {
  const row = await messages.visibleMessage(ctx, x.me, id);
  if (row.deleted_at) throw fail('deleted');
  const t = messages.bodyOf(row);
  return suggest.suggest(typeof t === 'string' ? t : '', row.created_at);
}

module.exports = {
  blocks, block, unblock, archive, pin, unpin, pinnedFor, pinsOf, lists, putLists, exportTxt, remind, reminders, unremind, dueReminders, suggestFor, previewOf,
  PINS_MAX, LISTS_MAX, REMINDERS_MAX,
};
