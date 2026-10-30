'use strict';

// Relevant / Sonstige ("Other") for mail that arrives in a posteingang:
//   1. what the person taught for the sender (POST messages/tab — table senders) wins;
//   2. rules: newsletters and machines are Other — List-Id, Precedence bulk/list/junk, Auto-Submitted (not "no"), a
//      no-reply sender, List-Unsubscribe; Microsoft's own "Other" (inferenceClassification) — and Relevant: someone the
//      person wrote to (contacts.sent), an answer to the person's mail;
//   3. unclear cases are Relevant at first and, while the administrator allows "Sortieren" and the account its AI, the
//      AI decides in the background (ai_pending, within GateControl's AI budget — PER_TICK at a time).

const store = require('./store');
const { clip } = require('./util');

const NOREPLY_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|newsletter|news|mailer-daemon|postmaster|notifications?|notify|info|marketing|bounce[s]?|automated?|alerts?)([+._-].*)?@/i;
const BULK_PREC = /^(bulk|list|junk)$/i;

/**
 * The tab of a new message by the rules → { tab, by: 'learned'|'rule', sure } — `sure: false` for the unclear ones.
 * m: { userId, fromEmail, listId, precedence, autoSubmitted, listUnsub, inReplyTo, inference }
 */
async function byRules(gc, m) {
  const from = String(m.fromEmail || '').toLowerCase();
  if (from) {
    const learned = await store.one(gc, 'SELECT tab FROM senders WHERE user_id = ? AND address = ?', [m.userId, from]);
    if (learned) return { tab: learned.tab, by: 'learned', sure: true };
  }
  const auto = m.autoSubmitted && !/^no$/i.test(String(m.autoSubmitted).trim());
  if (m.listId || (m.precedence && BULK_PREC.test(String(m.precedence).trim())) || auto) return { tab: 'other', by: 'rule', sure: true };
  if (from && NOREPLY_RE.test(from)) return { tab: 'other', by: 'rule', sure: true };
  if (from) {
    const c = await store.one(gc, 'SELECT sent FROM contacts WHERE user_id = ? AND email = ?', [m.userId, from]);
    if (c && c.sent > 0) return { tab: 'relevant', by: 'rule', sure: true };
  }
  if (m.inReplyTo) {
    const mine = await store.one(gc, `SELECT 1 AS x FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.message_id = ? AND f.role = 'sent'`, [m.userId, m.inReplyTo]);
    if (mine) return { tab: 'relevant', by: 'rule', sure: true };
  }
  if (m.listUnsub) return { tab: 'other', by: 'rule', sure: false };
  if (m.inference === 'other') return { tab: 'other', by: 'rule', sure: false };
  return { tab: 'relevant', by: 'rule', sure: false };
}

const SCHEMA = {
  type: 'object',
  required: ['tab'],
  properties: { tab: { type: 'string', enum: ['relevant', 'other'] } },
};
const INSTRUCTIONS = [
  'Sort one incoming e-mail of a private person or a small team into "relevant" or "other".',
  'relevant: written by a person to the reader, needs attention or an answer, bills, appointments, orders, deliveries,',
  'messages from school, doctors, authorities, the employer. other: newsletters, advertising, offers, social network',
  'notifications, automatic reports. Answer only from the given mail.',
].join('\n');

/** Ask the AI for message row `r` (with its snippet) → 'relevant' | 'other' | null (not now). */
async function byAi(gc, r) {
  if (!gc.ai || typeof gc.ai.extract !== 'function') return null;
  try {
    const res = await gc.ai.extract({
      task: 'mail_sort', user: r.user_id, instructions: INSTRUCTIONS, schema: SCHEMA, maxOutputTokens: 30, timeoutMs: 20000,
      input: [
        { type: 'text', label: 'From', text: clip(`${r.from_name || ''} <${r.from_email || ''}>`, 300) },
        { type: 'text', label: 'Subject', text: clip(r.subject || '', 300) },
        { type: 'text', label: 'Beginning', text: clip(r.snippet || '', 600) },
      ],
    });
    const tab = res && res.data && res.data.tab;
    return tab === 'relevant' || tab === 'other' ? tab : null;
  } catch (e) {
    if (e && (e.code === 'ERR_RATE_LIMIT' || e.code === 'ERR_AI_BUDGET' || e.code === 'ERR_AI_NOT_CONFIGURED' || e.code === 'ERR_AI_DENIED')) throw e;
    return null;
  }
}

/** POST messages/tab: the person's correction — kept for the sender (lower case address). */
async function learn(gc, userId, address, tab, now) {
  const a = String(address || '').toLowerCase();
  if (!a) return;
  await store.run(gc, 'INSERT INTO senders (user_id, address, tab, at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, address) DO UPDATE SET tab = excluded.tab, at = excluded.at',
    [userId, a, tab, now]);
}

module.exports = { byRules, byAi, learn, NOREPLY_RE };
