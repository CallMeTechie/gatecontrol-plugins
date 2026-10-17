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

const people = require('./people');
const live = require('./live');
const log = require('./log');
const texts = require('./texts.json');
const { mutedNow } = require('./conversations');

const TOPIC = 'message';
const BODY_MAX = 1000;

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

/**
 * Send the pushes of one new message (after the commit). job = { conv, members, row, text, meta, title (group title|null) }.
 * → [{ users, preview, lang }] the calls made (for tests / logging).
 */
async function send(gc, job, users, now = Date.now()) {
  const { conv, members, row } = job;
  const senderId = row.sender_id;
  const to = recipients(conv, members, senderId, users, now);
  if (!to.length) return [];
  const prefs = await people.prefsOf(gc, to);
  const sender = senderId == null ? null : users.get(senderId);
  const senderName = senderId == null ? 'GateControl' : (sender ? sender.name : null);
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
  for (const g of groups.values()) {
    const actions = [];
    if (!conv.readonly) actions.push({ type: 'reply', label: t(g.lang, 'push.reply'), path: `conversations/${conv.id}/messages` });
    actions.push({ type: 'mark_read', label: t(g.lang, 'push.mark_read'), path: `conversations/${conv.id}/read`, body: { upTo: row.id } });
    const n = {
      topic: TOPIC,
      title: g.preview ? senderName : t(g.lang, 'push.new_from', { name: senderName }),
      body: g.preview ? bodyOf(g.lang, row.kind, job.text, job.meta) : '',
      users: g.users,
      priority: 'normal',
      conversation: { id: String(conv.id), title: conv.kind === 'group' ? (job.title || null) : null, isGroup: conv.kind === 'group' },
      sender: { id: senderId == null ? 'gatecontrol' : senderId, name: senderName, avatarUrl: sender && sender.avatarUrl ? sender.avatarUrl : null },
      data: { messageId: row.id, conversationId: conv.id, actions },
    };
    if (!n.title.trim()) continue;
    for (let i = 0; i < g.users.length; i += 100) {
      const part = { ...n, users: g.users.slice(i, i + 100) };
      try {
        const res = await gc.notify(part);
        if (res && Array.isArray(res.skipped) && res.skipped.length) await log.add(gc, 'push_rate_limit', `skipped ${res.skipped.length}`, now);
        calls.push({ users: part.users, preview: g.preview, lang: g.lang });
      } catch (e) {
        await log.add(gc, e && e.code === 'ERR_RATE_LIMIT' ? 'push_rate_limit' : 'push_failed', e && e.code === 'ERR_RATE_LIMIT' ? null : ((e && e.code) || 'error'), now);
      }
    }
  }
  return calls;
}

module.exports = { send, recipients, bodyOf, TOPIC };
