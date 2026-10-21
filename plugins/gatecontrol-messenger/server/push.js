'use strict';

// Chat pushes (GateControl ≥ 1.177.0, notifyTopics[].chat, docs/plugins.md
// "Chat notifications"): one notification per new message to every member
// except the sender who
//   * still has an account,
//   * has not muted the conversation (notify 'none' or mutedUntil in the future),
//   * does not have the conversation open right now (POST …/active within 30 s).
// The text is only in the push for people with the preference "preview" on;
// the others get "Neue Nachricht von Anna" and an empty body. Recipients are
// grouped by preview and language — at most four gc.notify calls per message.
// Actions: reply (the apps post { clientId, kind: 'text', text, source:
// 'notification' } to conversations/<id>/messages) and mark_read
// (conversations/<id>/read with { upTo: <message id> }).
// 1.1.0: a picture message carries its preview as the push picture (`image: { mediaId }`,
// GateControl ≥ 1.178.0 — recognised by gc.services.available, which came with it) — for
// recipients with preview only; the preview file (else the photo itself) when it is PNG/JPEG/WebP
// and ≤ 300 KB. A host that refuses the picture gets the push again without it.
// 1.3.0: a video file with a preview picture (thumbMediaId) carries that preview the same way.
// 1.4.0: nobody with the status preset dnd gets a chat push (messages still arrive); notify.groupsMentionsOnly:
// in groups only messages that name the person (@Name) or answer one of theirs; polls, events, arrivals,
// home actions (a request only to its approvers) and plugin cards (a doorbell card high priority with its
// picture) have texts of their own; custom pushes (send in `custom`) for poll nudges, event reminders,
// departure hints, arrivals, reminders, answered action requests and reactions (notify.reactions).
// 1.6.0: notification cards of the chat sink (server/notices.js): titled with their source, high / critical as high,
// in the family group only to the people GateControl handed the notification for (job.only).

const store = require('./store');
const people = require('./people');
const live = require('./live');
const log = require('./log');
const texts = require('./texts.json');
const { mutedNow } = require('./conversations');

const TOPIC = 'message';
const BODY_MAX = 1000;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_MAX = 300 * 1024;

/** May the host take a push picture from the plugin's media (GateControl ≥ 1.178.0)? */
const mediaPictures = (gc) => !!(gc && gc.services && typeof gc.services.available === 'function');

/**
 * The media id to show as the push picture of a message row, or null. Pictures: the preview, else the photo;
 * 1.3.0: a video file with a preview picture: the preview (never the video, never other files' previews).
 */
async function pictureOf(gc, row) {
  if (!mediaPictures(gc)) return null;
  let ids;
  if (row.kind === 'image') ids = [row.thumb_media_id, row.media_id];
  else if (row.kind === 'file' && row.thumb_media_id && row.media_id) {
    const f = await store.one(gc, 'SELECT mime FROM media WHERE media_id = ?', [row.media_id]);
    if (!f || !/^video\//i.test(f.mime || '')) return null;
    ids = [row.thumb_media_id];
  } else return null;
  for (const id of ids) {
    if (!id) continue;
    const m = await store.one(gc, 'SELECT mime, bytes FROM media WHERE media_id = ? AND orphan = 0', [id]);
    if (m && IMAGE_TYPES.includes(m.mime) && m.bytes <= IMAGE_MAX) return id;
  }
  return null;
}

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function duration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The body of a push with preview: the text, or what was sent ("Foto: caption", "Sprachnachricht (0:14)", …). */
function bodyOf(lang, kind, text, meta) {
  const m = meta || {};
  const caption = typeof text === 'string' && text ? text : null;
  let s;
  switch (kind) {
    case 'image': s = caption ? `${t(lang, 'push.photo')}: ${caption}` : t(lang, 'push.photo'); break;
    case 'voice': s = m.durationMs != null ? `${t(lang, 'push.voice')} (${duration(m.durationMs)})` : t(lang, 'push.voice'); break;
    case 'file': s = `${t(lang, 'push.file')}: ${m.fileName || caption || t(lang, 'push.file_unnamed')}`; break;
    case 'location': s = m.location && m.location.label ? `${t(lang, 'push.location')}: ${m.location.label}` : t(lang, 'push.location'); break;
    case 'poll': s = `${t(lang, 'push.poll')}: ${(m.poll && m.poll.question) || ''}`; break;
    case 'event': s = `${t(lang, 'push.event')}: ${(m.event && m.event.title) || ''}`; break;
    case 'arrival': s = `${t(lang, 'push.arrival')}: ${(m.arrival && m.arrival.dest && m.arrival.dest.label) || ''}`; break;
    case 'action': s = m.action ? t(lang, m.action.mode === 'request' ? 'push.action_request' : (m.action.mode === 'grant' ? 'push.action_grant' : 'push.action_run'), { label: m.action.label || '' }) : ''; break;
    case 'card': s = m.card ? (caption ? `${m.card.title}: ${caption}` : m.card.title) : (caption || ''); break;
    default: s = caption || '';
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > BODY_MAX ? s.slice(0, BODY_MAX - 1) + '…' : s;
}

/**
 * Who gets a push for a new message (ids): active members with an account, not the sender,
 * not muted, not currently in the conversation.
 */
function recipients(conv, members, senderId, users, now) {
  return members.filter((m) => m.user_id !== senderId && users.has(m.user_id) && !mutedNow(m, now) && !live.isActive(m.user_id, conv.id, now)).map((m) => m.user_id);
}

/** Does a message name `name` (@Anna, @Anna Müller)? */
function mentions(textValue, name) {
  if (typeof textValue !== 'string' || !name) return false;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}_])@' + esc + '(?![\\p{L}\\p{N}_])', 'iu').test(textValue)
    || new RegExp('(^|[^\\p{L}\\p{N}_])@' + esc.split(/\s+/)[0] + '(?![\\p{L}\\p{N}_])', 'iu').test(textValue);
}

/** 1.4.0: people with an active dnd status, and the mentions-only filter of groups → the ids that still get the push. */
async function filter14(gc, conv, row, job, to, users, now) {
  const status = require('./status');
  const dnd = await status.dndUsers(gc, now);
  let out = to.filter((u) => !dnd.has(u));
  if (conv.kind === 'group' && row.sender_id != null && out.length) {
    const prefs = await people.prefsOf(gc, out);
    let repliedTo = null;
    if (row.reply_to) { const r = await store.one(gc, 'SELECT sender_id FROM messages WHERE id = ?', [row.reply_to]); repliedTo = r ? r.sender_id : null; }
    out = out.filter((u) => {
      const p = prefs.get(u);
      if (!p || !p.notify || !p.notify.groupsMentionsOnly) return true;
      const name = (users.get(u) || {}).name;
      return repliedTo === u || mentions(job.text, name);
    });
  }
  if (row.kind === 'action') {
    const only = await require('./homeactions').pushUsers(gc, row.id);
    if (only) out = out.filter((u) => only.includes(u));
  }
  return out;
}

/**
 * Send the pushes of one new message (after the commit). job = { conv, members, row, text, meta, title (group title|null) }.
 * → [{ users, preview, lang }] the calls made (for tests / logging).
 */
async function send(gc, job, users, now = Date.now()) {
  if (job.custom) return custom(gc, job.custom, users, now);
  const { conv, members, row } = job;
  const senderId = row.sender_id;
  let to = await filter14(gc, conv, row, job, recipients(conv, members, senderId, users, now), users, now);
  // 1.6.0: a notification in the family group goes to the people GateControl handed it for (job.only)
  if (Array.isArray(job.only)) to = to.filter((u) => job.only.includes(u));
  if (!to.length) return [];
  const prefs = await people.prefsOf(gc, to);
  const sender = senderId == null ? null : users.get(senderId);
  // 1.6.0: a notification card (deliverNotice) comes from its source ("Schule"), high / critical as high
  const notice = row.kind === 'card' && job.meta && job.meta.card && job.meta.card.notice ? job.meta.card.notice : null;
  const senderName = senderId == null ? ((notice && notice.sourceLabel) || 'GateControl') : (sender ? sender.name : null);
  if (!senderName) return [];
  const groups = new Map();
  for (const u of to) {
    const p = prefs.get(u) || {};
    const lang = p.lang === 'en' ? 'en' : 'de';
    const k = `${p.preview ? 1 : 0}:${lang}`;
    if (!groups.has(k)) groups.set(k, { users: [], preview: !!p.preview, lang });
    groups.get(k).users.push(u);
  }
  const calls = [];
  const picture = await pictureOf(gc, row);
  // 1.4.0: a plugin card: its picture as { data, mime }, a doorbell with high priority
  let cardImage = null;
  if (row.kind === 'card') {
    try { cardImage = await require('./homeactions').cardImage(gc, row.id); } catch { cardImage = null; }
  }
  for (const g of groups.values()) {
    const actions = [];
    if (!conv.readonly) actions.push({ type: 'reply', label: t(g.lang, 'push.reply'), path: `conversations/${conv.id}/messages` });
    actions.push({ type: 'mark_read', label: t(g.lang, 'push.mark_read'), path: `conversations/${conv.id}/read`, body: { upTo: row.id } });
    const n = {
      topic: TOPIC,
      title: g.preview ? senderName : t(g.lang, 'push.new_from', { name: senderName }),
      body: g.preview ? bodyOf(g.lang, row.kind, job.text, job.meta) : '',
      users: g.users,
      priority: (row.kind === 'card' && job.meta && job.meta.card && job.meta.card.kind === 'doorbell') || (notice && ['high', 'critical'].includes(notice.priority)) ? 'high' : 'normal',
      conversation: { id: String(conv.id), title: conv.kind === 'group' ? (job.title || null) : null, isGroup: conv.kind === 'group' },
      sender: { id: senderId == null ? 'gatecontrol' : senderId, name: senderName, avatarUrl: sender && sender.avatarUrl ? sender.avatarUrl : null },
      data: { messageId: row.id, conversationId: conv.id, actions },
    };
    if (!n.title.trim()) continue;
    if (g.preview && picture) n.image = { mediaId: picture };
    if (g.preview && cardImage) n.image = { data: cardImage.data, mime: cardImage.mime };
    for (let i = 0; i < g.users.length; i += 100) {
      const part = { ...n, users: g.users.slice(i, i + 100) };
      try {
        let res;
        try {
          res = await gc.notify(part);
        } catch (e) {
          // the host refused the picture (too small, unreadable, …): the message without it
          if (!part.image || !e || e.code !== 'ERR_INVALID') throw e;
          gc.log.warn('push picture refused', String(e.message || '').slice(0, 80));
          delete part.image;
          res = await gc.notify(part);
        }
        if (res && Array.isArray(res.skipped) && res.skipped.length) await log.add(gc, 'push_rate_limit', `skipped ${res.skipped.length}`, now);
        calls.push({ users: part.users, preview: g.preview, lang: g.lang, image: !!part.image });
      } catch (e) {
        await log.add(gc, e && e.code === 'ERR_RATE_LIMIT' ? 'push_rate_limit' : 'push_failed', e && e.code === 'ERR_RATE_LIMIT' ? null : ((e && e.code) || 'error'), now);
      }
    }
  }
  return calls;
}

/**
 * 1.4.0: a push that is not "a new message": job = { kind, conv, members, users (ids), senderId (null =
 * GateControl), messageId, params, respectMute (default true), respectDnd (default true), deepLink?, reminderId? }.
 * Texts push.<kind>_title / push.<kind> per language; preview off → the neutral push.<kind>_neutral.
 */
async function custom(gc, job, users, now = Date.now()) {
  const { conv, members } = job;
  let to = [...new Set(job.users || [])].filter((u) => users.has(u));
  if (job.respectMute !== false) to = to.filter((u) => { const m = (members || []).find((x) => x.user_id === u); return !(m && mutedNow(m, now)); });
  if (job.respectDnd !== false && to.length) { const dnd = await require('./status').dndUsers(gc, now); to = to.filter((u) => !dnd.has(u)); }
  if (!to.length) return [];
  const prefs = await people.prefsOf(gc, to);
  const sender = job.senderId == null ? null : users.get(job.senderId);
  const senderName = job.senderId == null ? 'GateControl' : (sender ? sender.name : 'GateControl');
  const groups = new Map();
  for (const u of to) {
    const p = prefs.get(u) || {};
    const lang = p.lang === 'en' ? 'en' : 'de';
    const k = `${p.preview ? 1 : 0}:${lang}`;
    if (!groups.has(k)) groups.set(k, { users: [], preview: !!p.preview, lang });
    groups.get(k).users.push(u);
  }
  const calls = [];
  const title0 = conv && conv.kind === 'group' ? (require('./conversations').titleOf(conv) || null) : null;
  for (const g of groups.values()) {
    const params = { ...(job.params || {}), name: senderName };
    if (params.startsAt != null) params.time = clock(params.startsAt, g.lang);
    const title = t(g.lang, `push.${job.kind}_title`, params);
    let body = g.preview ? t(g.lang, `push.${job.kind}`, params) : t(g.lang, `push.${job.kind}_neutral`, params);
    body = body.replace(/\s+/g, ' ').trim();
    if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX - 1) + '…';
    const data = { messageId: job.messageId, conversationId: conv.id, kind: job.kind };
    if (job.deepLink) data.deepLink = job.deepLink;
    if (job.reminderId) data.reminderId = job.reminderId;
    const n = {
      topic: TOPIC, title, body, users: g.users, priority: 'normal',
      conversation: { id: String(conv.id), title: title0, isGroup: conv.kind === 'group' },
      sender: { id: job.senderId == null ? 'gatecontrol' : job.senderId, name: senderName, avatarUrl: sender && sender.avatarUrl ? sender.avatarUrl : null },
      collapseKey: `${job.kind}:${conv.id}:${job.messageId}`.slice(0, 120), data,
    };
    try {
      const res = await gc.notify(n);
      if (res && Array.isArray(res.skipped) && res.skipped.length) await log.add(gc, 'push_rate_limit', `skipped ${res.skipped.length}`, now);
      calls.push({ users: g.users, kind: job.kind, lang: g.lang });
    } catch (e) {
      await log.add(gc, e && e.code === 'ERR_RATE_LIMIT' ? 'push_rate_limit' : 'push_failed', e && e.code === 'ERR_RATE_LIMIT' ? null : ((e && e.code) || 'error'), now);
    }
  }
  return calls;
}

/** "Sa., 18.10. 15:00" in the server's time zone. */
function clock(ms, lang) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const days = lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
  return `${days[d.getDay()]} ${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 1.4.0: the daily story digest (topic status, not a chat push) → the calls made. */
async function digest(gc, list, now = Date.now()) {
  const calls = [];
  const byLang = new Map();
  for (const d of list) {
    const lang = d.lang === 'en' ? 'en' : 'de';
    const key = `${lang}:${d.names.slice(0, 3).join(',')}:${d.names.length}`;
    if (!byLang.has(key)) byLang.set(key, { lang, names: d.names, users: [] });
    byLang.get(key).users.push(d.userId);
  }
  for (const g of byLang.values()) {
    const shown = g.names.slice(0, 3).join(', ') + (g.names.length > 3 ? ` +${g.names.length - 3}` : '');
    try {
      await gc.notify({ topic: 'status', title: t(g.lang, 'push.status_digest_title'), body: t(g.lang, 'push.status_digest', { names: shown, n: g.names.length }), users: g.users.slice(0, 100), priority: 'info', collapseKey: 'status-digest', data: { deepLink: 'status' } });
      calls.push({ users: g.users, lang: g.lang });
    } catch (e) {
      await log.add(gc, e && e.code === 'ERR_RATE_LIMIT' ? 'push_rate_limit' : 'push_failed', e && e.code === 'ERR_RATE_LIMIT' ? null : ((e && e.code) || 'error'), now);
    }
  }
  return calls;
}

module.exports = { send, custom, digest, recipients, bodyOf, pictureOf, mentions, TOPIC };
