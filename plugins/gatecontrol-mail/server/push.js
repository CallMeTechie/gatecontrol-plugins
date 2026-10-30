'use strict';

// Pushes (topic mail: title = sender, text = subject, data { mail: { messageId, accountId } }; more than one new mail of a
// person in one run: one push "3 neue Mails"; topic mail_failed with data { mail: { outboxId } }) and the live event
// 'mail' { kind: 'changed', accountId, folderId } (lists load again; since 1.1.2 with messageId — a body or an attachment
// the answer did not wait for is there now, with attachmentId —, or threadId). GateControl's quiet hours and the person's topic
// switch apply; the plugin keeps to its 120 pushes an hour (a refused push is dropped, the mail is not lost).

const store = require('./store');
const { t } = require('./text');
const { clip } = require('./util');

async function langOf(gc, userId) {
  try { const u = await gc.users.get(userId); return u && u.lang === 'en' ? 'en' : 'de'; } catch { return 'de'; }
}

/** The live event to `userId`: lists of the account / folder changed (extra: { messageId?, attachmentId?, threadId? }). Never fails. */
async function changed(gc, userId, accountId, folderId, extra) {
  try {
    await gc.events.emit({ users: [userId], type: 'mail', data: { kind: 'changed', accountId: accountId || null, folderId: folderId || null, ...(extra || {}) } });
  } catch { /* nobody listening, or the budget is used up */ }
}

/**
 * New mail of the posteingang of account `a` (rows with notified = 0): a push per the account's `push` (off | relevant |
 * all), then notified = 1.
 */
async function newMail(gc, a) {
  const rows = await store.all(gc, `SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.account_id = ? AND m.notified = 0 AND f.role = 'inbox'
    ORDER BY m.date DESC LIMIT 50`, [a.id]);
  if (!rows.length) return 0;
  await store.run(gc, `UPDATE messages SET notified = 1 WHERE id IN (${store.marks(rows.length)})`, rows.map((r) => r.id));
  const want = rows.filter((r) => r.unread === 1 && (a.push === 'all' || (a.push === 'relevant' && r.tab === 'relevant')));
  if (!want.length || a.push === 'off') return 0;
  const lang = await langOf(gc, a.user_id);
  const top = want[0];
  const one = want.length === 1;
  try {
    await gc.notify({
      topic: 'mail', users: [a.user_id], collapseKey: `mail:${a.id}`,
      title: clip(one ? (top.from_name || top.from_email || t(lang, 'push.unknown')) : t(lang, 'push.many', { count: want.length }), 120),
      body: clip(one ? (top.subject || t(lang, 'push.no_subject')) : want.slice(0, 3).map((r) => `${r.from_name || r.from_email}: ${r.subject || ''}`).join('\n'), 1000),
      data: { mail: { messageId: top.id, accountId: a.id } },
    });
    return want.length;
  } catch (e) {
    gc.log.warn('mail push failed', (e && e.code) || 'error');
    return 0;
  }
}

/** A mail of the outbox could not be sent. */
async function sendFailed(gc, userId, outboxId, subject) {
  const lang = await langOf(gc, userId);
  try {
    await gc.notify({ topic: 'mail_failed', users: [userId], priority: 'high', title: t(lang, 'push.failed_title'), body: clip(subject || t(lang, 'push.no_subject'), 300), data: { mail: { outboxId } } });
  } catch (e) { gc.log.warn('failed push failed', (e && e.code) || 'error'); }
}

module.exports = { changed, newMail, sendFailed, langOf };
