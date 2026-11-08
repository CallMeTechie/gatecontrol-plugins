'use strict';

// Moving over from Microsoft To Do (board „Umzug“) through Microsoft Graph (graph.microsoft.com, /me/todo) with the
// Microsoft account the person signed in with in GateControl Mail. Mail (≥ 1.12.0) hands out a token that holds only
// Tasks.ReadWrite (gatecontrol-mail:ms_tasks_token) and runs the consent for it (ms_tasks_consent: Microsoft's device
// code); Mail's own mail token never leaves Mail.
//
//   GET  import/mstodo/accounts                 → { available, accounts: [{ id, email, label, kind, tasks }] }
//   POST import/mstodo/consent { accountId, deviceId? } → { userCode, verificationUri, deviceId, … } | { status }
//   GET  import/mstodo/preview?accountId=       → { lists: [{ id, name, open, done, attachments, area, wellknown }], totals }
//   POST import/mstodo/start { accountId, lists: [{ id, area, include }], doneDays: 0|30|90|365|-1, twoWay } → { job }
//   GET  import/jobs/<id>                        → { job }
//   GET  import/mstodo/links                     → { links } · DELETE import/mstodo/links/<id> (the transition ends)
//
// The import runs in the background (≤ 40 Graph requests a minute and person). A list named like work („Arbeit“,
// „Büro“, „Projekt …“, „Work“, „Office“ …) goes to the area Arbeit unless the person picks otherwise. „Markierte
// E-Mails“ (flaggedEmails) is left out by default — Mail's flagged mails come in as a source anyway.
//
// Transition period (twoWay, setting mstodo_sync): every 5 minutes per list, changes made here go to To Do (create,
// title, note, due date, reminder, important, done, delete) and To Do's changes come back (Graph delta query). Both
// changed the same task: the later change wins. Sub tasks (checklistItems) come over with the import and are not kept
// in step afterwards.

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const lists = require('./lists');
const tasks = require('./tasks');
const attachments = require('./attachments');
const events = require('./events');
const R = require('../ui/repeat');
const { fail, posInt, parse, line } = require('./util');

const MAIL = 'gatecontrol-mail';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const WORK_RE = /(arbeit|büro|buero|firma|kunde|projekt|project|work|office|business|job|team|dienst)/i;
const CALLS_PER_TICK = 40;
const SYNC_EVERY = 5 * 60 * 1000;
const tokens = new Map(); // `${userId}|${accountId}` → { token, until }

async function mailCall(gc, ctx, service, payload) {
  let res;
  try {
    if (!(await gc.services.available(MAIL, service))) throw fail('unavailable', { reason: 'mail_missing' });
    res = await gc.services.call({ plugin: MAIL, service, userId: ctx.userId, payload: { v: 1, ...payload } });
  } catch (e) {
    if (e && e.known) throw e;
    throw fail('unavailable', { reason: (e && e.code) || 'mail' });
  }
  if (!res || res.ok !== true) {
    const code = res && typeof res.code === 'string' ? res.code : 'failed';
    if (code === 'consent_required') throw fail('consent_required');
    throw fail(code === 'not_found' || code === 'forbidden' ? code : 'unavailable', { reason: code.slice(0, 40) });
  }
  return res;
}

async function accounts(gc, ctx) {
  const cfg = await config.get(gc);
  if (!cfg.import_mstodo) return { available: false, reason: 'off', accounts: [] };
  try {
    const r = await mailCall(gc, ctx, 'ms_accounts', {});
    return { available: true, accounts: (r.accounts || []).slice(0, 20).map((a) => ({ id: a.id, email: a.email, label: a.label || a.email, kind: a.kind, tasks: !!a.tasks })) };
  } catch (e) {
    return { available: false, reason: (e.extra && e.extra.reason) || e.code, accounts: [] };
  }
}

async function consent(gc, ctx, b) {
  const accountId = posInt(b && b.accountId);
  if (!accountId) throw fail('invalid', { field: 'accountId' });
  const r = await mailCall(gc, ctx, 'ms_tasks_consent', { accountId, ...(b.deviceId ? { deviceId: String(b.deviceId).slice(0, 64) } : {}) });
  if (r.status === 'done') tokens.delete(`${ctx.userId}|${accountId}`);
  const { ok, ...rest } = r;
  return rest;
}

async function token(gc, ctx, accountId) {
  const k = `${ctx.userId}|${accountId}`;
  const have = tokens.get(k);
  if (have && have.until > ctx.now + 120000) return have.token;
  const r = await mailCall(gc, ctx, 'ms_tasks_token', { accountId });
  if (typeof r.token !== 'string' || !r.token) throw fail('unavailable', { reason: 'token' });
  tokens.set(k, { token: r.token, until: Number(r.expiresAt) || ctx.now + 3000000 });
  return r.token;
}

/** One Graph request → JSON (401: the token once more). */
async function graph(gc, ctx, accountId, method, path, body) {
  const url = /^https:\/\/graph\.microsoft\.com\//.test(path) ? path : GRAPH + path;
  for (let i = 0; i < 2; i++) {
    const tk = await token(gc, ctx, accountId);
    let r;
    try {
      r = await gc.http.fetch(url, { method, headers: { authorization: 'Bearer ' + tk, accept: 'application/json' }, ...(body !== undefined ? { json: body } : {}), timeoutMs: 30000 });
    } catch (e) { throw fail('unavailable', { reason: 'unreachable' }); }
    if (r.status === 401 && i === 0) { tokens.delete(`${ctx.userId}|${accountId}`); continue; }
    if (r.status === 401 || r.status === 403) throw fail('consent_required');
    if (r.status === 429 || r.status === 503) throw fail('busy', { retryAfter: Number((r.headers || {})['retry-after']) || 60 });
    if (r.status === 404) throw fail('not_found');
    if (r.status === 204) return {};
    let j = null;
    try { j = typeof r.body === 'string' ? JSON.parse(r.body || '{}') : r.body; } catch { j = null; }
    if (r.status >= 400) throw fail('unavailable', { reason: 'graph_' + r.status });
    return j || {};
  }
  throw fail('consent_required');
}

// ── mapping ─────────────────────────────────────────

const WD = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Graph's { dateTime, timeZone } → ms (timeZone UTC or an IANA zone; anything else: UTC). */
function msOf(dt) {
  if (!dt || typeof dt.dateTime !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dt.dateTime);
  if (!m) return null;
  const zone = typeof dt.timeZone === 'string' && dt.timeZone !== 'UTC' && tz.valid(dt.timeZone) ? dt.timeZone : 'UTC';
  return tz.toUtc({ y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +(m[6] || 0) }, zone);
}
const dateOf = (dt) => (dt && typeof dt.dateTime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dt.dateTime) ? dt.dateTime.slice(0, 10) : null);

function ruleOf(rec) {
  const p = rec && rec.pattern;
  if (!p || typeof p.type !== 'string') return null;
  const interval = Number.isSafeInteger(p.interval) && p.interval > 0 ? p.interval : 1;
  if (p.type === 'daily') return { type: 'daily', interval };
  if (p.type === 'weekly') {
    const days = (p.daysOfWeek || []).map((d) => WD.indexOf(String(d).toLowerCase()) + 1).filter((d) => d > 0);
    return days.length ? { type: 'weekly', interval, days } : null;
  }
  if (p.type === 'absoluteMonthly' || p.type === 'relativeMonthly') return { type: 'monthly', interval, ...(p.dayOfMonth ? { day: p.dayOfMonth } : {}) };
  if (p.type === 'absoluteYearly' || p.type === 'relativeYearly') return { type: 'yearly', interval, ...(p.month ? { month: p.month } : {}), ...(p.dayOfMonth ? { day: p.dayOfMonth } : {}) };
  return null;
}
function recurrenceOf(rule, date) {
  if (!rule) return null;
  const start = { type: 'noEnd', startDate: date || new Date().toISOString().slice(0, 10) };
  if (rule.type === 'daily' || rule.type === 'after') return { pattern: { type: 'daily', interval: rule.interval }, range: start };
  if (rule.type === 'weekly') return { pattern: { type: 'weekly', interval: rule.interval, daysOfWeek: rule.days.map((d) => WD[d - 1]), firstDayOfWeek: 'monday' }, range: start };
  if (rule.type === 'monthly') return { pattern: { type: 'absoluteMonthly', interval: rule.interval, dayOfMonth: rule.day || Number((date || '').slice(8, 10)) || 1 }, range: start };
  return { pattern: { type: 'absoluteYearly', interval: rule.interval, dayOfMonth: rule.day || Number((date || '').slice(8, 10)) || 1, month: rule.month || Number((date || '').slice(5, 7)) || 1 }, range: start };
}

function textOf(body) {
  if (!body || typeof body.content !== 'string') return '';
  let s = body.content;
  if (String(body.contentType).toLowerCase() === 'html') {
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }
  return s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A Graph todoTask → the fields of a hub task. */
function fromGraph(ctx, g) {
  const due = dateOf(g.dueDateTime);
  const remind = g.isReminderOn ? msOf(g.reminderDateTime) : null;
  let note = textOf(g.body);
  for (const l of g.linkedResources || []) if (l && typeof l.webUrl === 'string' && /^https:\/\//.test(l.webUrl)) note += (note ? '\n' : '') + (l.displayName ? l.displayName + ': ' : '') + l.webUrl;
  return {
    title: line(g.title, tasks.TITLE_MAX) || '–', note: note.slice(0, tasks.NOTE_MAX), important: g.importance === 'high',
    due: due ? { date: due, time: null } : null, remindAt: remind, repeat: ruleOf(g.recurrence),
    done: g.status === 'completed', doneAt: g.status === 'completed' ? msOf(g.completedDateTime) || ctx.now : null,
    createdAt: Date.parse(g.createdDateTime) || ctx.now, modifiedAt: Date.parse(g.lastModifiedDateTime) || ctx.now,
    subtasks: (g.checklistItems || []).slice(0, 100).map((c) => ({ title: line(c.displayName, 300) || '–', done: !!c.isChecked })),
  };
}

/** A hub task row → the body of a Graph PATCH / POST. */
function toGraph(r) {
  const rule = parse(r.repeat_json, null);
  return {
    title: r.title, importance: r.important ? 'high' : 'normal', status: r.done_at ? 'completed' : 'notStarted',
    body: { content: r.note || '', contentType: 'text' },
    dueDateTime: r.due_date ? { dateTime: r.due_date + 'T00:00:00', timeZone: 'UTC' } : null,
    isReminderOn: !!r.remind_at, reminderDateTime: r.remind_at ? { dateTime: new Date(r.remind_at).toISOString().slice(0, 19), timeZone: 'UTC' } : null,
    ...(rule ? { recurrence: recurrenceOf(rule, r.due_date) } : {}),
  };
}

// ── preview and import ──────────────────────────────

async function allPages(gc, ctx, accountId, path, max = 50) {
  const out = [];
  let url = path;
  for (let i = 0; url && i < max; i++) {
    const j = await graph(gc, ctx, accountId, 'GET', url);
    out.push(...(j.value || []));
    url = j['@odata.nextLink'] || null;
  }
  return out;
}

async function preview(gc, ctx, q) {
  const accountId = posInt(q.accountId);
  if (!accountId) throw fail('invalid', { field: 'accountId' });
  const ls = await allPages(gc, ctx, accountId, '/me/todo/lists?$top=100', 5);
  const out = [];
  const totals = { lists: 0, open: 0, done: 0, attachments: 0 };
  for (const l of ls.slice(0, 100)) {
    const ts = await allPages(gc, ctx, accountId, `/me/todo/lists/${encodeURIComponent(l.id)}/tasks?$select=id,status,hasAttachments&$top=100`, 20);
    const open = ts.filter((x) => x.status !== 'completed').length;
    const flagged = l.wellknownListName === 'flaggedEmails';
    const item = { id: l.id, name: l.displayName || 'To Do', open, done: ts.length - open, attachments: ts.filter((x) => x.hasAttachments).length,
      area: WORK_RE.test(l.displayName || '') ? 'work' : 'private', wellknown: l.wellknownListName || null, shared: !!l.isShared, include: !flagged };
    out.push(item);
    if (item.include) { totals.lists++; totals.open += open; totals.done += item.done; totals.attachments += item.attachments; }
  }
  return { lists: out, totals };
}

function jobView(j) {
  return { id: j.id, kind: j.kind, state: j.state, stats: parse(j.stats_json, {}), error: j.error || null, createdAt: j.created_at, updatedAt: j.updated_at };
}

async function start(gc, ctx, b) {
  const cfg = await config.get(gc);
  if (!cfg.import_mstodo) throw fail('forbidden', { reason: 'off' });
  const accountId = posInt(b && b.accountId);
  if (!accountId || !Array.isArray(b.lists) || !b.lists.length || b.lists.length > 100) throw fail('invalid', { field: 'lists' });
  const pick = b.lists.filter((l) => l && typeof l.id === 'string' && l.id.length <= 300 && l.include !== false).map((l) => ({ id: l.id, area: l.area === 'work' ? 'work' : 'private', name: line(l.name, 80) || null }));
  if (!pick.length) throw fail('invalid', { field: 'lists' });
  const doneDays = [0, 30, 90, 365, -1].includes(b.doneDays) ? b.doneDays : 90;
  const running = await store.one(gc, "SELECT id FROM imports WHERE user_id = ? AND kind = 'mstodo' AND state = 'running'", [ctx.userId]);
  if (running) throw fail('conflict', { job: running.id });
  await token(gc, ctx, accountId);
  const r = await store.run(gc, `INSERT INTO imports (user_id, kind, state, options_json, stats_json, cursor_json, created_at, updated_at) VALUES (?, 'mstodo', 'running', ?, ?, ?, ?, ?)`,
    [ctx.userId, JSON.stringify({ accountId, lists: pick, doneDays, twoWay: !!b.twoWay && cfg.mstodo_sync, lang: ctx.lang }), JSON.stringify({ lists: 0, tasks: 0, attachments: 0, skipped: 0 }),
      JSON.stringify({ i: 0, next: null, listId: null }), ctx.now, ctx.now]);
  return { job: jobView(await store.one(gc, 'SELECT * FROM imports WHERE id = ?', [Number(r.lastInsertRowid)])) };
}

async function job(gc, ctx, id) {
  const j = await store.one(gc, 'SELECT * FROM imports WHERE id = ? AND user_id = ?', [posInt(id) || 0, ctx.userId]);
  if (!j) throw fail('not_found');
  return { job: jobView(j) };
}

async function addTask(gc, ctx, listId, g, extId) {
  const f = fromGraph(ctx, g);
  const made = await tasks.create(gc, ctx, { title: f.title, note: f.note, important: f.important, due: f.due, remindAt: f.remindAt != null ? new Date(f.remindAt).toISOString() : undefined, repeat: f.repeat || undefined, listId },
    { extId, extAt: f.modifiedAt, createdAt: f.createdAt, doneAt: f.done ? f.doneAt : null });
  for (const s of f.subtasks) {
    const st = await tasks.create(gc, ctx, { title: s.title, parentId: made.task.id });
    if (s.done) await store.run(gc, 'UPDATE tasks SET done_at = ?, done_by = ? WHERE id = ?', [ctx.now, ctx.userId, st.task.id]);
  }
  return made.task.id;
}

/** One step of an import job (≤ CALLS_PER_TICK Graph requests). */
async function step(gc, base, j) {
  const o = parse(j.options_json, {});
  const cur = parse(j.cursor_json, { i: 0 });
  const st = parse(j.stats_json, {});
  const ctx = { ...base, userId: j.user_id, lang: o.lang || 'de' };
  let calls = 0;
  const save = (state, error) => store.run(gc, 'UPDATE imports SET state = ?, stats_json = ?, cursor_json = ?, error = ?, updated_at = ? WHERE id = ?',
    [state, JSON.stringify(st), JSON.stringify(cur), error || null, ctx.now, j.id]);
  try {
    while (calls < CALLS_PER_TICK) {
      const l = o.lists[cur.i];
      if (!l) { await save('done'); events.changed(gc, [ctx.userId], 'lists'); return; }
      if (!cur.listId) {
        const meta = await graph(gc, ctx, o.accountId, 'GET', `/me/todo/lists/${encodeURIComponent(l.id)}`);
        calls++;
        const made = await lists.create(gc, ctx, { name: line(meta.displayName, 80) || l.name || 'To Do', area: l.area, extKind: 'mstodo', extId: l.id });
        cur.listId = made.list.id;
        cur.next = `/me/todo/lists/${encodeURIComponent(l.id)}/tasks?$expand=checklistItems&$top=50`;
        await store.run(gc, `INSERT INTO ext_links (user_id, account_id, ext_list_id, list_id, two_way, next_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, ext_list_id) DO UPDATE SET list_id = excluded.list_id, two_way = excluded.two_way, account_id = excluded.account_id`, [ctx.userId, o.accountId, l.id, cur.listId, 0, 0]);
        st.lists = (st.lists || 0) + 1;
      }
      if (cur.next) {
        const page = await graph(gc, ctx, o.accountId, 'GET', cur.next);
        calls++;
        for (const g of page.value || []) {
          if (g.status === 'completed') {
            const doneAt = msOf(g.completedDateTime) || 0;
            if (o.doneDays === 0 || (o.doneDays > 0 && doneAt < ctx.now - o.doneDays * 86400000)) { st.skipped = (st.skipped || 0) + 1; continue; }
          }
          const have = await store.one(gc, 'SELECT id FROM tasks INDEXED BY idx_tasks_ext WHERE list_id = ? AND ext_id = ?', [cur.listId, g.id]);
          const tid = have ? have.id : await addTask(gc, ctx, cur.listId, g, g.id);
          if (!have) st.tasks = (st.tasks || 0) + 1;
          if (g.hasAttachments && !have) {
            const as = await graph(gc, ctx, o.accountId, 'GET', `/me/todo/lists/${encodeURIComponent(l.id)}/tasks/${encodeURIComponent(g.id)}/attachments`);
            calls++;
            for (const a of (as.value || []).slice(0, 20)) {
              try {
                const tk = await token(gc, ctx, o.accountId);
                const f = await gc.media.fetch(`${GRAPH}/me/todo/lists/${encodeURIComponent(l.id)}/tasks/${encodeURIComponent(g.id)}/attachments/${encodeURIComponent(a.id)}/$value`,
                  { headers: { authorization: 'Bearer ' + tk }, name: line(a.name, 200) || 'Anhang', mime: typeof a.contentType === 'string' ? a.contentType : undefined, timeoutMs: 30000 });
                calls++;
                await attachments.add(gc, ctx, { kind: 'task', refId: tid, mediaId: f.mediaId, name: line(a.name, 200) || 'Anhang' }, { quiet: true, extId: a.id });
                st.attachments = (st.attachments || 0) + 1;
              } catch (e) { st.skipped = (st.skipped || 0) + 1; }
            }
          }
        }
        cur.next = page['@odata.nextLink'] || null;
        if (cur.next) continue;
      }
      if (o.twoWay) {
        // the delta link for the transition period (pages through the list once more)
        let url = cur.delta || `/me/todo/lists/${encodeURIComponent(l.id)}/tasks/delta`;
        let deltaLink = null;
        while (url && calls < CALLS_PER_TICK) {
          const d = await graph(gc, ctx, o.accountId, 'GET', url);
          calls++;
          deltaLink = d['@odata.deltaLink'] || null;
          url = d['@odata.nextLink'] || null;
        }
        if (url) { cur.delta = url; break; }
        await store.run(gc, 'UPDATE ext_links SET two_way = 1, delta = ?, next_at = ?, last_at = ? WHERE user_id = ? AND ext_list_id = ?', [deltaLink, ctx.now + SYNC_EVERY, ctx.now, ctx.userId, l.id]);
      }
      cur.i++;
      cur.listId = null;
      cur.next = null;
      cur.delta = null;
    }
    await save('running');
  } catch (e) {
    if (e && e.code === 'busy') { await save('running'); return; }
    await save('failed', (e && e.code) || 'failed');
  }
  events.changed(gc, [ctx.userId], 'tasks');
}

// ── the transition period ──────────────────────────

async function syncLink(gc, base, link) {
  const cfg = await config.get(gc);
  const ctx = { ...base, userId: link.user_id };
  const L = `/me/todo/lists/${encodeURIComponent(link.ext_list_id)}/tasks`;
  let calls = 0;
  try {
    if (!cfg.mstodo_sync) return;
    // 1) changes made here
    const dirty = await store.all(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_ext_dirty WHERE list_id = ? AND ext_dirty = 1 AND parent_id IS NULL LIMIT 30', [link.list_id]);
    for (const r of dirty) {
      if (r.deleted_at) {
        if (r.ext_id) { try { await graph(gc, ctx, link.account_id, 'DELETE', `${L}/${encodeURIComponent(r.ext_id)}`); } catch (e) { if (e.code !== 'not_found') throw e; } }
      } else if (!r.ext_id) {
        const made = await graph(gc, ctx, link.account_id, 'POST', L, toGraph(r));
        await store.run(gc, 'UPDATE tasks SET ext_id = ?, ext_at = ? WHERE id = ?', [made.id || null, Date.parse(made.lastModifiedDateTime) || ctx.now, r.id]);
      } else {
        try {
          const done = await graph(gc, ctx, link.account_id, 'PATCH', `${L}/${encodeURIComponent(r.ext_id)}`, toGraph(r));
          await store.run(gc, 'UPDATE tasks SET ext_at = ? WHERE id = ?', [Date.parse(done.lastModifiedDateTime) || ctx.now, r.id]);
        } catch (e) { if (e.code !== 'not_found') throw e; }
      }
      calls++;
      await store.run(gc, 'UPDATE tasks SET ext_dirty = 0 WHERE id = ? AND updated_at <= ?', [r.id, r.updated_at]);
    }
    // 2) changes made in To Do (delta)
    let url = link.delta || `${L}/delta`;
    let deltaLink = link.delta;
    let changed = false;
    while (url && calls < CALLS_PER_TICK) {
      const d = await graph(gc, ctx, link.account_id, 'GET', url);
      calls++;
      for (const g of d.value || []) {
        const have = await store.one(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_ext WHERE list_id = ? AND ext_id = ?', [link.list_id, g.id]);
        if (g['@removed']) {
          if (have && !have.deleted_at && !have.ext_dirty) { await store.run(gc, 'UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? OR parent_id = ?', [ctx.now, ctx.now, have.id, have.id]); changed = true; }
          continue;
        }
        if (!g.title && !g.status) continue;
        const f = fromGraph(ctx, g);
        if (!have) { if (!f.done) { await addTask(gc, ctx, link.list_id, g, g.id); changed = true; } continue; }
        if (have.deleted_at) continue;
        if (have.ext_at && f.modifiedAt <= have.ext_at) continue;
        if (have.ext_dirty && have.updated_at > f.modifiedAt) continue; // the later change wins
        await store.run(gc, `UPDATE tasks SET title = ?, note = ?, important = ?, due_date = ?, due_time = NULL, due_at = ?, remind_at = ?, reminded_at = NULL,
          repeat_json = ?, done_at = ?, ext_at = ?, ext_dirty = 0, updated_at = ? WHERE id = ?`,
        [f.title, f.note, f.important ? 1 : 0, f.due ? f.due.date : null, f.due ? tasks.dueAt(ctx, f.due.date, null) : null, f.remindAt, f.repeat ? JSON.stringify(R.normalize(f.repeat)) : null,
          f.done ? (have.done_at || f.doneAt) : null, f.modifiedAt, ctx.now, have.id]);
        changed = true;
      }
      if (d['@odata.deltaLink']) { deltaLink = d['@odata.deltaLink']; url = null; } else url = d['@odata.nextLink'] || null;
    }
    await store.run(gc, 'UPDATE ext_links SET delta = ?, next_at = ?, last_at = ?, error = NULL WHERE id = ?', [url || deltaLink, ctx.now + (url ? 60000 : SYNC_EVERY), ctx.now, link.id]);
    if (changed || dirty.length) events.changed(gc, await lists.memberIds(gc, link.list_id), 'tasks');
  } catch (e) {
    const code = (e && e.code) || 'failed';
    await store.run(gc, 'UPDATE ext_links SET error = ?, next_at = ? WHERE id = ?', [code.slice(0, 40), ctx.now + (code === 'busy' ? 600000 : code === 'consent_required' ? 6 * 3600000 : 30 * 60000), link.id]);
  }
}

async function links(gc, ctx) {
  const rows = await store.all(gc, 'SELECT e.*, l.name AS list_name FROM ext_links e JOIN lists l ON l.id = e.list_id AND l.deleted_at IS NULL WHERE e.user_id = ? ORDER BY e.id', [ctx.userId]);
  return { links: rows.map((r) => ({ id: r.id, listId: r.list_id, listName: r.list_name, accountId: r.account_id, twoWay: !!r.two_way, lastSync: r.last_at || null, error: r.error || null })) };
}
async function unlink(gc, ctx, id) {
  const r = await store.one(gc, 'SELECT * FROM ext_links WHERE id = ? AND user_id = ?', [posInt(id) || 0, ctx.userId]);
  if (!r) throw fail('not_found');
  await store.run(gc, 'UPDATE ext_links SET two_way = 0, delta = NULL WHERE id = ?', [r.id]);
  await store.run(gc, 'UPDATE tasks SET ext_dirty = 0 WHERE list_id = ? AND ext_dirty = 1', [r.list_id]);
  return { ok: true };
}

async function tick(gc, base) {
  const jobs = await store.all(gc, "SELECT * FROM imports INDEXED BY idx_imports_state WHERE state = 'running' AND kind = 'mstodo' ORDER BY id LIMIT 3");
  for (const j of jobs) await step(gc, base, j);
  const due = await store.all(gc, 'SELECT * FROM ext_links INDEXED BY idx_ext_links_next WHERE two_way = 1 AND next_at <= ? ORDER BY next_at LIMIT 5', [base.now]);
  for (const l of due) await syncLink(gc, base, l);
}

module.exports = { accounts, consent, preview, start, job, links, unlink, tick, fromGraph, toGraph, ruleOf, recurrenceOf, WORK_RE, _tokens: tokens };
