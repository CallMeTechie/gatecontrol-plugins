'use strict';

// Mail as a source of „Notizen & Aufgaben“ (1.11.0, gatecontrol-notizen; contract v1, server/todohub.js):
//
//   „Zu tun“ of the AI   { id: 'todo:<messageId>:<key>', kind: 'task', title: the to-do („Rechnung bis 28.11. bezahlen“),
//                          subtitle: „Zu tun aus „<subject>““, due: its date (and time, in the person's time zone),
//                          meta: { type: question | deadline | event | amount | task, amount?: „84,20 €“ },
//                          done: ticked off (table todo_done), open: message/<messageId> }
//                          — of mails the AI read within the last TODO_DAYS days (not in the trash or junk); key: a short
//                          hash of the to-do's kind and text, so a new AI run that finds the same keeps the tick
//   a flagged mail       { id: 'flag:<messageId>', kind: 'task', title: the subject, subtitle: the sender, important: true,
//                          meta: { type: 'flagged', flagged: true } } — the newest FLAGGED_MAX per person; ticked off =
//                          the flag cleared (on the server too, like „Markierung entfernen“), kept a day as done so the
//                          hub can undo it (flags it again)
//
// users: the account's owner (only while that person may use Mail: allowed, a licence, a seat); area: 'work' for an
// account of kind business, else 'private'; group: the account (account:<id>, its name or address).

const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const seats = require('./seats');
const people = require('./people');
const pimstore = require('./pimstore');
const messages = require('./messages');
const tz = require('./tz');
const todohub = require('./todohub');
const { t } = require('./text');
const { parse } = require('./util');

const PLUGIN = 'gatecontrol-mail';
const TODO_DAYS = 30;
const TODO_MAX = 2000;
const FLAGGED_MAX = 200;
const DAY = 86400000;
const KINDS = ['question', 'deadline', 'event', 'amount', 'task'];
const OUT_ROLES = ['trash', 'junk'];

/** The key of a to-do of the AI: stable while its kind and text stay. */
const keyOf = (td) => crypto.createHash('sha1').update(`${td.kind}|${td.text}`).digest('hex').slice(0, 10);

function money(amount, currency, lang) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (!currency) return String(amount);
  try { return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency }).format(amount); } catch { return `${amount} ${currency}`; }
}

/** The people who may use Mail now (allowed, licence, a seat) → Map id → { lang, zone }. */
async function persons(gc, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cfg = await config.get(gc);
  const lic = await people.licence(gc);
  if (!lic.valid) return out;
  const us = await people.users(gc);
  for (const id of ids) {
    const u = us.get(id);
    if (!u || u.disabled) continue;
    const seat = await seats.get(gc, id);
    if (!seat || seat.kind === 'none' || !(await config.allowed(gc, cfg, id))) continue;
    let zone = 'Europe/Berlin';
    try { zone = (await pimstore.zoneOf(gc, id)) || zone; } catch { /* the default */ }
    out.set(id, { lang: u.lang === 'en' ? 'en' : 'de', zone });
  }
  return out;
}

const accountGroup = (a) => ({ id: `account:${a.id}`, label: a.name || a.email });

/** Every item of every person. */
async function collect(gc, now) {
  const accounts = new Map((await store.all(gc, 'SELECT id, user_id, email, name, kind FROM accounts')).map((a) => [a.id, a]));
  if (!accounts.size) return [];
  const who = await persons(gc, [...new Set([...accounts.values()].map((a) => a.user_id))]);
  if (!who.size) return [];
  const out = [];
  const base = (a) => ({ area: a.kind === 'business' ? 'work' : 'private', users: [a.user_id], group: accountGroup(a) });

  // „Zu tun“ of the AI
  const rows = await store.all(gc, `SELECT r.message_id, r.todos_json, r.at, m.user_id, m.account_id, m.subject, f.role FROM ai_results r
    JOIN messages m ON m.id = r.message_id JOIN folders f ON f.id = m.folder_id
    WHERE r.at >= ? AND r.todos_json <> '[]' ORDER BY r.at DESC LIMIT ?`, [now - TODO_DAYS * DAY, TODO_MAX]);
  const done = new Map();
  for (const part of store.chunks(rows.map((r) => r.message_id))) {
    for (const d of await store.all(gc, `SELECT id, at FROM todo_done WHERE message_id IN (${store.marks(part.length)})`, part)) done.set(d.id, d.at);
  }
  for (const r of rows) {
    const a = accounts.get(r.account_id);
    const p = a && who.get(r.user_id);
    if (!p || OUT_ROLES.includes(r.role)) continue;
    const seen = new Set();
    for (const td of parse(r.todos_json, [])) {
      if (!td || !KINDS.includes(td.kind) || typeof td.text !== 'string' || !td.text.trim()) continue;
      const key = keyOf(td);
      if (seen.has(key)) continue;
      seen.add(key);
      const id = `todo:${r.message_id}:${key}`;
      const at = done.get(id);
      // ticked off more than a day ago: not „zu tun“ any more
      if (at != null && now - at >= DAY) continue;
      let due = null;
      if (typeof td.date === 'string') {
        due = td.date;
        if (typeof td.time === 'string' && tz.parseTime(td.time)) {
          try { due = todohub.isoIn(tz.at(td.date, tz.parseTime(td.time), p.zone), p.zone); } catch { due = td.date; }
        }
      }
      const amount = td.kind === 'amount' ? money(td.amount, td.currency, p.lang) : null;
      out.push({
        ...base(a), id, kind: 'task', title: td.text, subtitle: t(p.lang, 'notizen.todo_from', { subject: todohub.plain(r.subject, 150) || t(p.lang, 'notizen.no_subject') }),
        due, important: false, done: at != null, canComplete: true, meta: { type: td.kind, ...(amount ? { amount } : {}) },
        open: { plugin: PLUGIN, route: `message/${r.message_id}` }, updatedAt: Math.max(r.at, at || 0),
      });
    }
  }

  // flagged mails, and the ones the hub unflagged within the last day (done)
  const flagged = [];
  for (const uid of who.keys()) {
    flagged.push(...await store.all(gc, `SELECT m.id, m.user_id, m.account_id, m.subject, m.from_name, m.from_email, m.date, f.role FROM messages m
      JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.flagged = 1 ORDER BY m.date DESC LIMIT ?`, [uid, FLAGGED_MAX]));
  }
  const unflagged = await store.all(gc, `SELECT d.at AS done_at, m.id, m.user_id, m.account_id, m.subject, m.from_name, m.from_email, m.date, f.role
    FROM todo_done d JOIN messages m ON m.id = d.message_id JOIN folders f ON f.id = m.folder_id
    WHERE d.id LIKE 'flag:%' AND d.at > ? AND m.flagged = 0`, [now - DAY]);
  for (const m of [...flagged, ...unflagged]) {
    const a = accounts.get(m.account_id);
    const p = a && who.get(m.user_id);
    if (!p || OUT_ROLES.includes(m.role)) continue;
    out.push({
      ...base(a), id: `flag:${m.id}`, kind: 'task', title: todohub.plain(m.subject, 200) || t(p.lang, 'notizen.no_subject'),
      subtitle: m.from_name || m.from_email || null, due: null, important: true, done: m.done_at != null, canComplete: true,
      meta: { type: 'flagged', flagged: true }, open: { plugin: PLUGIN, route: `message/${m.id}` }, updatedAt: m.done_at || 0,
    });
  }
  return out;
}

/** A to-do of the AI ticked off (or not) in Mail: by message, key and person. */
async function setTodo(gc, userId, messageId, key, done, now) {
  const id = `todo:${messageId}:${key}`;
  if (done) {
    await store.run(gc, `INSERT INTO todo_done (id, user_id, message_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, [id, userId, messageId, now]);
  } else await store.run(gc, 'DELETE FROM todo_done WHERE id = ?', [id]);
}

/** The keys of a message's to-dos that are ticked off → Set. */
async function doneKeys(gc, messageId) {
  const rows = await store.all(gc, "SELECT id FROM todo_done WHERE message_id = ? AND id LIKE 'todo:%'", [messageId]);
  return new Set(rows.map((r) => r.id.split(':')[2]));
}

async function complete(gc, user, item, done, now) {
  const [kind, raw, key] = item.id.split(':');
  const messageId = Number(raw);
  const m = await store.one(gc, 'SELECT id, user_id FROM messages WHERE id = ?', [messageId]);
  if (!m || m.user_id !== user.id) return { ok: false, code: 'not_found' };
  if (kind === 'todo') {
    await setTodo(gc, user.id, messageId, key, done, now);
    return { ok: true };
  }
  // a flagged mail: the flag cleared (or set again) like in Mail — on the server, then here
  await messages.flags(gc, user.id, { ids: [messageId], flagged: !done });
  if (done) await store.run(gc, 'INSERT INTO todo_done (id, user_id, message_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at', [`flag:${messageId}`, user.id, messageId, now]);
  else await store.run(gc, 'DELETE FROM todo_done WHERE id = ?', [`flag:${messageId}`]);
  return { ok: true };
}

/** Retention: ticks of mails that are gone, flags cleared more than a day ago. */
async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM todo_done WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = todo_done.message_id)');
  await store.run(gc, "DELETE FROM todo_done WHERE id LIKE 'flag:%' AND at < ?", [now - DAY]);
}

const source = todohub.create({ plugin: PLUGIN, collect, complete, tx: (gc, fn) => store.tx(gc, fn), intervalMs: 60000 });

module.exports = { source, collect, complete, purge, keyOf, setTodo, doneKeys, TODO_DAYS, FLAGGED_MAX };
