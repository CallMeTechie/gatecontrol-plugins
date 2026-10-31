'use strict';

// AI for mail (GateControl's AI service, gc.ai ≥ 1.214.0 — provider, keys and the monthly budget are the
// administrator's): "Kurz gesagt" (a summary — none for short mail < 600 characters), "Zu tun" (questions, deadlines,
// dates, amounts, tasks), reply suggestions; the sorting into Relevant / Sonstige for unclear mail (classify.js).
// The text goes first; the pictures of a mail only when it has no text and GateControl lets pictures go to the AI.
// Off: the administrator's switches (ai.bar, ai.sort; ai.blockBusiness for business accounts), the account's own switch,
// or a GateControl without AI.

const store = require('./store');
const config = require('./config');
const engine = require('./engine');
const classify = require('./classify');
const push = require('./push');
const { t } = require('./text');
const { fail, parse, clip, posInt } = require('./util');

const TEXT_MAX = 12000;
const SHORT = 600;
const PER_TICK = 5;
const KINDS = ['question', 'deadline', 'event', 'amount', 'task'];
const ERRORS = { ERR_RATE_LIMIT: 'rate_limited', ERR_AI_BUDGET: 'ai_unavailable', ERR_AI_NOT_CONFIGURED: 'ai_unavailable', ERR_AI_DENIED: 'ai_off', ERR_AI_PROVIDER: 'ai_unavailable', ERR_TIMEOUT: 'ai_unavailable', ERR_AI_INVALID_OUTPUT: 'ai_unavailable', ERR_AI_MEDIA_DISABLED: 'ai_unavailable', ERR_AI_CAPABILITY: 'ai_unavailable' };

const hasAi = (gc) => !!(gc.ai && typeof gc.ai.extract === 'function' && typeof gc.ai.available === 'function');

/** Is AI set up in GateControl and allowed for this plugin (no provider asked)? */
async function ready(gc) {
  if (!hasAi(gc)) return false;
  try { return (await gc.ai.available()) === true; } catch { return false; }
}

/** May AI work on mail of account `a` (bar: the AI bar; sort: the sorting)? */
async function allowedFor(gc, cfg, a, what) {
  if (!cfg.ai[what]) return false;
  if (!a || a.ai !== 1) return false;
  if (cfg.ai.blockBusiness && a.kind === 'business') return false;
  return ready(gc);
}

const INSTRUCTIONS = [
  'You read one e-mail a person received and help them deal with it. Answer only from the mail; never invent anything.',
  'Write in the language of the mail.',
  'summary: one or two short sentences "in short" — what it is about and what matters; null when told the mail is short.',
  'todos: what the reader has to do or keep in mind, at most 5: question (a question to the reader), deadline (a date by',
  'which something must happen), event (an appointment or date with optional time), amount (a sum to pay or received, with',
  'currency ISO 4217), task (something to do). text: a short line, e.g. "Rechnung bis 28.11. bezahlen". date YYYY-MM-DD',
  '(work out "next Tuesday" from "Today"), time HH:MM, else null.',
  'replies: up to 3 short reply suggestions the reader could send as they are; label: 2-4 words; text: the whole reply.',
  'No replies to newsletters or automatic mail.',
].join('\n');

const SCHEMA = {
  type: 'object',
  required: ['summary', 'todos', 'replies'],
  properties: {
    summary: { type: 'string', maxLength: 400, nullable: true },
    todos: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: KINDS }, text: { type: 'string', maxLength: 160 }, date: { type: 'string', maxLength: 10, nullable: true },
          time: { type: 'string', maxLength: 5, nullable: true }, amount: { type: 'number', nullable: true }, currency: { type: 'string', maxLength: 3, nullable: true },
        },
      },
    },
    replies: { type: 'array', maxItems: 3, items: { type: 'object', required: ['label', 'text'], properties: { label: { type: 'string', maxLength: 40 }, text: { type: 'string', maxLength: 1500 } } } },
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const day = (v) => (typeof v === 'string' && DATE_RE.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v ? v : null);

function view(r) {
  return { status: 'done', summary: r.summary || null, todos: parse(r.todos_json, []), replies: parse(r.replies_json, []) };
}

async function ctxOf(gc, userId, messageId) {
  const m = posInt(messageId) ? await store.one(gc, 'SELECT * FROM messages WHERE id = ? AND user_id = ?', [posInt(messageId), userId]) : null;
  if (!m) throw fail('not_found');
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]);
  return { m, a };
}

/** GET ai/<messageId> → AiResult | { status: 'none' } */
async function get(gc, userId, messageId) {
  const { m } = await ctxOf(gc, userId, messageId);
  const r = await store.one(gc, 'SELECT * FROM ai_results WHERE message_id = ?', [m.id]);
  return r ? view(r) : { status: 'none' };
}

/** ai_off (the administrator, the account, business accounts blocked) / ai_unavailable (GateControl's AI) — or nothing. */
async function mayRun(gc, a) {
  const cfg = await config.get(gc);
  if (!(await allowedFor(gc, cfg, a, 'bar'))) throw fail(hasAi(gc) && cfg.ai.bar && a.ai === 1 && !(cfg.ai.blockBusiness && a.kind === 'business') ? 'ai_unavailable' : 'ai_off');
}

const running = new Map(); // message id → the promise of its run (one at a time)
const recent = new Map(); // user id → [times] (PER_HOUR runs an hour)
const PER_HOUR = 60;

/**
 * POST ai/<messageId> { again? } → AiResult. A result that is there is answered as it is (the apps ask on opening a
 * mail) — `again: true` asks the AI anew; a run for the same mail in progress is shared; PER_HOUR runs a person and hour.
 */
async function run(gc, userId, messageId, b) {
  const { m, a } = await ctxOf(gc, userId, messageId);
  await mayRun(gc, a);
  if (!(b && b.again === true)) {
    const have = await store.one(gc, 'SELECT * FROM ai_results WHERE message_id = ?', [m.id]);
    if (have) return view(have);
  }
  if (running.has(m.id)) return running.get(m.id);
  const now = Date.now();
  const list = (recent.get(userId) || []).filter((x) => now - x < 3600000);
  if (list.length >= PER_HOUR) throw fail('rate_limited');
  list.push(now);
  recent.set(userId, list);
  const p = runNow(gc, userId, m.id).finally(() => running.delete(m.id));
  running.set(m.id, p);
  return p;
}

async function runNow(gc, userId, messageId) {
  const { m, a } = await ctxOf(gc, userId, messageId);
  await mayRun(gc, a);
  let b = await store.one(gc, 'SELECT * FROM bodies WHERE message_id = ?', [m.id]);
  if (!b) {
    try { await engine.loadBody(gc, a, m); } catch (e) { throw fail(e && e.code === 'auth_failed' ? 'auth_failed' : 'unreachable'); }
    b = await store.one(gc, 'SELECT * FROM bodies WHERE message_id = ?', [m.id]);
  }
  const text = String((b && b.text) || m.snippet || '').trim();
  const now = Date.now();
  const input = [
    { type: 'text', label: 'From', text: clip(`${m.from_name || ''} <${m.from_email || ''}>`, 300) },
    { type: 'text', label: 'Subject', text: clip(m.subject || '', 300) },
    { type: 'text', label: 'Date', text: new Date(m.date).toISOString().slice(0, 16).replace('T', ' ') },
    { type: 'text', label: 'Today', text: new Date(now).toISOString().slice(0, 10) },
  ];
  if (text.length < SHORT) input.push({ type: 'text', label: 'Note', text: 'The mail is short: summary null.' });
  if (text) input.push({ type: 'text', label: 'Mail', text: clip(text, TEXT_MAX) });
  else {
    // no text: its pictures, when GateControl lets pictures go to the AI
    let vision = false;
    try { vision = (await gc.ai.available({ capability: 'vision' })) === true; } catch { vision = false; }
    const pics = vision ? await store.all(gc, "SELECT * FROM attachments WHERE message_id = ? AND mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif') AND size <= ? ORDER BY id LIMIT 3", [m.id, 10 * 1024 * 1024]) : [];
    for (const p of pics) {
      try { input.push({ type: 'media', mediaId: (await engine.attachment(gc, a, m, p)).mediaId }); } catch { /* without it */ }
    }
    if (input.length === 4) throw fail('ai_unavailable', { reason: 'no_text' });
  }
  let res;
  try {
    res = await gc.ai.extract({ task: 'mail_assist', user: userId, instructions: INSTRUCTIONS, input, schema: SCHEMA, maxOutputTokens: 1200, timeoutMs: 45000 });
  } catch (e) {
    throw fail(ERRORS[e && e.code] || 'ai_unavailable');
  }
  const d = res && res.data && typeof res.data === 'object' ? res.data : {};
  const todos = (Array.isArray(d.todos) ? d.todos : []).filter((x) => x && KINDS.includes(x.kind) && typeof x.text === 'string' && x.text.trim()).slice(0, 5).map((x) => ({
    kind: x.kind, text: clip(x.text.trim(), 160),
    ...(day(x.date) ? { date: day(x.date) } : {}), ...(typeof x.time === 'string' && TIME_RE.test(x.time) ? { time: x.time } : {}),
    ...(typeof x.amount === 'number' && Number.isFinite(x.amount) ? { amount: Math.round(x.amount * 100) / 100 } : {}),
    ...(typeof x.currency === 'string' && /^[A-Za-z]{3}$/.test(x.currency) ? { currency: x.currency.toUpperCase() } : {}),
  }));
  const replies = (Array.isArray(d.replies) ? d.replies : []).filter((x) => x && typeof x.label === 'string' && typeof x.text === 'string' && x.text.trim()).slice(0, 3)
    .map((x) => ({ label: clip(x.label.trim(), 40), text: clip(x.text.trim(), 1500) }));
  const summary = text.length >= SHORT && typeof d.summary === 'string' && d.summary.trim() ? clip(d.summary.trim(), 400) : null;
  await store.run(gc, `INSERT INTO ai_results (message_id, summary, todos_json, replies_json, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET summary = excluded.summary, todos_json = excluded.todos_json, replies_json = excluded.replies_json, at = excluded.at`,
  [m.id, summary, JSON.stringify(todos), JSON.stringify(replies), now]);
  return view(await store.one(gc, 'SELECT * FROM ai_results WHERE message_id = ?', [m.id]));
}

/** POST ai/<messageId>/todo/<index> { action: 'family_calendar' } → { where } */
async function todo(gc, userId, lang, messageId, index, b) {
  const { m } = await ctxOf(gc, userId, messageId);
  if (!b || b.action !== 'family_calendar') throw fail('invalid', { field: 'action' });
  const r = await store.one(gc, 'SELECT * FROM ai_results WHERE message_id = ?', [m.id]);
  const list = r ? parse(r.todos_json, []) : [];
  const i = Number(index);
  const item = Number.isInteger(i) && i >= 0 ? list[i] : null;
  if (!item) throw fail('not_found');
  if (!item.date) throw fail('invalid', { field: 'date' });
  if (!gc.services || typeof gc.services.call !== 'function') throw fail('familie_unavailable', { reason: 'unavailable' });
  let res;
  try {
    res = await gc.services.call({ plugin: 'gatecontrol-familie', service: 'calendar_add', userId, payload: {
      userId, title: clip(item.text, 80), ...(item.time ? { startsAt: `${item.date}T${item.time}:00`, allDay: false } : { startsAt: item.date, allDay: true }),
    } });
  } catch (e) {
    throw fail(e && e.code === 'ERR_RATE_LIMIT' ? 'rate_limited' : 'familie_unavailable', { reason: 'unavailable' });
  }
  if (!res || res.ok !== true) throw fail('familie_unavailable', { reason: (res && res.code) || 'failed' });
  const when = new Date(item.date + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return { where: t(lang, 'ai.where_family', { date: when + (item.time ? ` ${item.time}` : '') }) };
}

/**
 * POST ai/<messageId>/todo/<index> { action: 'calendar', calendarId? } → { where, eventId } (1.2.0): the to-do into the own
 * calendar (the default calendar without calendarId). `create(gc, ctx, item, calendarId)` is events.fromTodo.
 */
async function todoCalendar(gc, ctx, messageId, index, b, create) {
  const { m } = await ctxOf(gc, ctx.userId, messageId);
  const r = await store.one(gc, 'SELECT * FROM ai_results WHERE message_id = ?', [m.id]);
  const list = r ? parse(r.todos_json, []) : [];
  const i = Number(index);
  const item = Number.isInteger(i) && i >= 0 ? list[i] : null;
  if (!item) throw fail('not_found');
  if (!item.date) throw fail('invalid', { field: 'date' });
  const res = await create(gc, ctx, item, b.calendarId);
  const when = new Date(item.date + 'T12:00:00Z').toLocaleDateString(ctx.lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return { where: t(ctx.lang, 'todo.calendar_where', { calendar: res.calendar ? res.calendar.name : '', date: when + (item.time ? ` ${item.time}` : '') }), eventId: res.eventId };
}

/** Is Familie's calendar reachable (GET me features.familyCalendar)? */
async function familyCalendar(gc) {
  if (!gc.services || typeof gc.services.available !== 'function') return false;
  try { return (await gc.services.available('gatecontrol-familie', 'calendar_add')) === true; } catch { return false; }
}

/** The background run: unclear mail sorted by the AI (PER_TICK at most). */
async function tick(gc) {
  const cfg = await config.get(gc);
  if (!cfg.ai.sort || !(await ready(gc))) return 0;
  const rows = await store.all(gc, `SELECT m.*, a.ai AS acc_ai, a.kind AS acc_kind FROM messages m JOIN accounts a ON a.id = m.account_id
    WHERE m.ai_pending = 1 AND m.tab_by = 'rule' ORDER BY m.date DESC LIMIT ?`, [PER_TICK * 4]);
  let n = 0;
  for (const m of rows) {
    if (n >= PER_TICK) break;
    if (m.acc_ai !== 1 || (cfg.ai.blockBusiness && m.acc_kind === 'business')) { await store.run(gc, 'UPDATE messages SET ai_pending = 0 WHERE id = ?', [m.id]); continue; }
    let tab;
    try { tab = await classify.byAi(gc, m); } catch { break; }
    n++;
    await store.run(gc, 'UPDATE messages SET ai_pending = 0, tab = COALESCE(?, tab), tab_by = CASE WHEN ? IS NULL THEN tab_by ELSE \'ai\' END WHERE id = ? AND tab_by = \'rule\'', [tab, tab, m.id]);
    if (tab && tab !== m.tab) await push.changed(gc, m.user_id, m.account_id, m.folder_id);
  }
  return n;
}

function reset() { running.clear(); recent.clear(); }

module.exports = { reset, get, run, todo, todoCalendar, tick, ready, allowedFor, familyCalendar, SHORT };
