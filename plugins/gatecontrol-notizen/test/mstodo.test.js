'use strict';

// Moving over from Microsoft To Do (mstodo.js): the token comes from Mail (ms_tasks_token, only Tasks.ReadWrite), the
// consent through Mail (ms_tasks_consent), a fake Microsoft Graph behind gc.http.fetch / gc.media.fetch — lists to
// areas, tasks with sub tasks, recurrence, reminders, attachments, done ones of the last days; then the transition
// period in both directions (delta query).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, fakeSource, ANNA, MARC, clock, T0, PLUGINS } = require('./helpers');
const { fromGraph, toGraph, ruleOf } = require('../server/mstodo');

const G = 'https://graph.microsoft.com/v1.0';

/** A fake Graph for one account: lists, tasks (with checklistItems), attachments, a delta per list. */
function fakeGraph() {
  const st = {
    token: 'tok-tasks-1',
    lists: [
      { id: 'L1', displayName: 'Aufgaben', wellknownListName: 'defaultList' },
      { id: 'L2', displayName: 'Projekt X', wellknownListName: 'none' },
      { id: 'L3', displayName: 'Markierte E-Mail', wellknownListName: 'flaggedEmails' },
    ],
    tasks: {
      L1: [
        { id: 'T1', title: 'Zahnarzt anrufen', status: 'notStarted', importance: 'high', body: { content: '<p>Praxis <b>Müller</b></p>', contentType: 'html' },
          dueDateTime: { dateTime: '2026-11-09T00:00:00.0000000', timeZone: 'UTC' }, isReminderOn: true, reminderDateTime: { dateTime: '2026-11-09T08:00:00.0000000', timeZone: 'UTC' },
          createdDateTime: '2026-10-01T10:00:00Z', lastModifiedDateTime: '2026-11-01T10:00:00Z', checklistItems: [{ displayName: 'Nummer suchen', isChecked: true }, { displayName: 'Anrufen', isChecked: false }], hasAttachments: true },
        { id: 'T2', title: 'Rasen mähen', status: 'notStarted', importance: 'normal', recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['saturday'] }, range: { type: 'noEnd', startDate: '2026-11-14' } },
          dueDateTime: { dateTime: '2026-11-14T00:00:00.0000000', timeZone: 'Europe/Berlin' }, createdDateTime: '2026-10-01T10:00:00Z', lastModifiedDateTime: '2026-10-02T10:00:00Z' },
        { id: 'T3', title: 'Alt erledigt', status: 'completed', completedDateTime: { dateTime: '2025-01-01T10:00:00.0000000', timeZone: 'UTC' }, createdDateTime: '2024-10-01T10:00:00Z', lastModifiedDateTime: '2025-01-01T10:00:00Z' },
        { id: 'T4', title: 'Neu erledigt', status: 'completed', completedDateTime: { dateTime: '2026-11-01T10:00:00.0000000', timeZone: 'UTC' }, createdDateTime: '2026-10-01T10:00:00Z', lastModifiedDateTime: '2026-11-01T10:00:00Z' },
      ],
      L2: [{ id: 'T5', title: 'Angebot schreiben', status: 'notStarted', importance: 'normal', createdDateTime: '2026-10-01T10:00:00Z', lastModifiedDateTime: '2026-10-02T10:00:00Z' }],
      L3: [{ id: 'T6', title: 'Mail von Chef', status: 'notStarted' }],
    },
    attachments: { T1: [{ id: 'A1', name: 'Überweisung.pdf', contentType: 'application/pdf', size: 12 }] },
    requests: [], patches: [], posts: [], deletes: [], delta: { L2: [] }, deltaRuns: 0,
  };
  const page = (value, next) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, ...(next ? { '@odata.nextLink': next } : {}) }) });
  const fetch = async (url, opts) => {
    st.requests.push({ url, method: opts.method || 'GET', auth: (opts.headers || {}).authorization });
    if ((opts.headers || {}).authorization !== 'Bearer ' + st.token) return { status: 401, body: '{}' };
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    let m;
    if (p === '/me/todo/lists') return page(st.lists);
    if ((m = /^\/me\/todo\/lists\/([^/]+)$/.exec(p))) return { status: 200, body: JSON.stringify(st.lists.find((l) => l.id === m[1])) };
    if ((m = /^\/me\/todo\/lists\/([^/]+)\/tasks\/delta$/.exec(p))) {
      st.deltaRuns++;
      if (u.searchParams.get('token')) { const v = st.delta[m[1]] || []; st.delta[m[1]] = []; return { status: 200, body: JSON.stringify({ value: v, '@odata.deltaLink': `${G}/me/todo/lists/${m[1]}/tasks/delta?token=t${st.deltaRuns}` }) }; }
      return { status: 200, body: JSON.stringify({ value: st.tasks[m[1]] || [], '@odata.deltaLink': `${G}/me/todo/lists/${m[1]}/tasks/delta?token=t${st.deltaRuns}` }) };
    }
    if ((m = /^\/me\/todo\/lists\/([^/]+)\/tasks$/.exec(p))) {
      if (opts.method === 'POST') { const t = { id: 'N' + (st.posts.length + 1), ...opts.json, lastModifiedDateTime: new Date(clock.now()).toISOString() }; st.posts.push(t); return { status: 201, body: JSON.stringify(t) }; }
      const all = st.tasks[m[1]] || [];
      const skip = Number(u.searchParams.get('$skip') || 0);
      const top = 2;
      return page(all.slice(skip, skip + top), skip + top < all.length ? `${G}/me/todo/lists/${m[1]}/tasks?$expand=checklistItems&$top=50&$skip=${skip + top}` : null);
    }
    if ((m = /^\/me\/todo\/lists\/([^/]+)\/tasks\/([^/]+)\/attachments$/.exec(p))) return page(st.attachments[m[2]] || []);
    if ((m = /^\/me\/todo\/lists\/([^/]+)\/tasks\/([^/]+)\/attachments\/([^/]+)\/\$value$/.exec(p))) return { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.4 x') };
    if ((m = /^\/me\/todo\/lists\/([^/]+)\/tasks\/([^/]+)$/.exec(p))) {
      if (opts.method === 'PATCH') { st.patches.push({ id: m[2], body: opts.json }); return { status: 200, body: JSON.stringify({ id: m[2], lastModifiedDateTime: new Date(clock.now()).toISOString() }) }; }
      if (opts.method === 'DELETE') { st.deletes.push(m[2]); return { status: 204, body: '' }; }
    }
    return { status: 404, body: '{}' };
  };
  return { st, fetch };
}

function fakeMail(graph, opts = {}) {
  const st = { consented: opts.consented !== false, calls: [] };
  const provides = { todo_items: { label: { de: 'x', en: 'x' }, maxPerHour: 600 }, todo_complete: { label: { de: 'x', en: 'x' }, maxPerHour: 600 },
    ms_accounts: { label: { de: 'x', en: 'x' }, maxPerHour: 600 }, ms_tasks_token: { label: { de: 'x', en: 'x' }, maxPerHour: 600 }, ms_tasks_consent: { label: { de: 'x', en: 'x' }, maxPerHour: 600 } };
  const src = fakeSource('gatecontrol-mail', {
    provides,
    service: ({ name, user, payload }) => {
      st.calls.push({ name, user: user && user.id, payload });
      if (!user || user.id !== ANNA.id) return { ok: true, accounts: [] };
      if (name === 'ms_accounts') return { ok: true, accounts: [{ id: 3, email: 'anna@outlook.com', label: 'Outlook.com', kind: 'personal', tasks: st.consented }] };
      if (name === 'ms_tasks_token') return st.consented ? { ok: true, token: graph.st.token, expiresAt: clock.now() + 3600000, email: 'anna@outlook.com' } : { ok: false, code: 'consent_required' };
      if (name === 'ms_tasks_consent') {
        if (!payload.deviceId) return { ok: true, deviceId: 'dev1', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 };
        st.consented = true;
        return { ok: true, status: 'done' };
      }
      return { ok: false, code: 'not_found' };
    },
  });
  return { st, src };
}

async function host(graph, mailOpts) {
  const mail = fakeMail(graph, mailOpts);
  const others = PLUGINS.filter((p) => p !== 'gatecontrol-mail').map((p) => fakeSource(p));
  const h = await withHost({ sources: [mail.src, ...others], host: { fetch: graph.fetch } });
  return { h, mail };
}

async function runJob(h, id) {
  for (let i = 0; i < 20; i++) {
    clock.advance(60000);
    await h.host.tick();
    const j = (await h.ok(ANNA, 'GET', 'import/jobs/' + id)).job;
    if (j.state !== 'running') return j;
  }
  throw new Error('job did not end');
}

test('To Do mapping: fields, recurrence, reminders both ways', () => {
  const ctx = { now: T0, tz: 'Europe/Berlin' };
  const g = fakeGraph().st.tasks.L1[0];
  const f = fromGraph(ctx, g);
  assert.equal(f.note, 'Praxis Müller');
  assert.deepEqual(f.due, { date: '2026-11-09', time: null });
  assert.equal(f.remindAt, Date.parse('2026-11-09T08:00:00Z'));
  assert.equal(f.important, true);
  assert.deepEqual(f.subtasks, [{ title: 'Nummer suchen', done: true }, { title: 'Anrufen', done: false }]);
  assert.deepEqual(ruleOf({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'thursday'] } }), { type: 'weekly', interval: 2, days: [1, 4] });
  assert.deepEqual(ruleOf({ pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 } }), { type: 'monthly', interval: 1, day: 15 });
  const out = toGraph({ title: 'X', important: 1, done_at: null, note: 'n', due_date: '2026-11-09', remind_at: Date.parse('2026-11-09T08:00:00Z'), repeat_json: JSON.stringify({ type: 'weekly', interval: 1, days: [6] }) });
  assert.deepEqual(out.dueDateTime, { dateTime: '2026-11-09T00:00:00', timeZone: 'UTC' });
  assert.deepEqual(out.reminderDateTime, { dateTime: '2026-11-09T08:00:00', timeZone: 'UTC' });
  assert.deepEqual(out.recurrence.pattern, { type: 'weekly', interval: 1, daysOfWeek: ['saturday'], firstDayOfWeek: 'monday' });
  assert.equal(out.importance, 'high');
});

test('To Do: consent through Mail, preview with areas, the import with sub tasks and attachments', async () => {
  const graph = fakeGraph();
  const { h, mail } = await host(graph, { consented: false });
  try {
    const acc = await h.ok(ANNA, 'GET', 'import/mstodo/accounts');
    assert.deepEqual(acc.accounts.map((a) => [a.id, a.tasks]), [[3, false]]);
    assert.equal((await h.call(ANNA, 'GET', 'import/mstodo/preview', null, { accountId: 3 })).status, 409, 'consent first');
    const c = await h.ok(ANNA, 'POST', 'import/mstodo/consent', { accountId: 3 });
    assert.equal(c.userCode, 'ABCD-EFGH');
    assert.equal((await h.ok(ANNA, 'POST', 'import/mstodo/consent', { accountId: 3, deviceId: c.deviceId })).status, 'done');
    const pv = await h.ok(ANNA, 'GET', 'import/mstodo/preview', null, { accountId: 3 });
    assert.deepEqual(pv.lists.map((l) => [l.name, l.area, l.open, l.include]), [['Aufgaben', 'private', 2, true], ['Projekt X', 'work', 1, true], ['Markierte E-Mail', 'private', 1, false]]);
    assert.deepEqual(pv.totals, { lists: 2, open: 3, done: 2, attachments: 1 });
    assert.ok(graph.st.requests.every((r) => r.auth === 'Bearer tok-tasks-1'), 'only the token Mail handed out');
    const s = await h.ok(ANNA, 'POST', 'import/mstodo/start', { accountId: 3, lists: pv.lists.map((l) => ({ id: l.id, name: l.name, area: l.area, include: l.include })), doneDays: 90 });
    assert.equal((await h.call(ANNA, 'POST', 'import/mstodo/start', { accountId: 3, lists: [{ id: 'L1' }] })).status, 409, 'one at a time');
    const j = await runJob(h, s.job.id);
    assert.equal(j.state, 'done');
    assert.deepEqual([j.stats.lists, j.stats.tasks, j.stats.attachments, j.stats.skipped], [2, 4, 1, 1]);
    const nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
    const l1 = nav.lists.find((l) => l.name === 'Aufgaben' && l.ext);
    const v = await h.ok(ANNA, 'GET', 'views/list:' + l1.id);
    const zahn = v.sections[0].items.find((x) => x.title === 'Zahnarzt anrufen');
    assert.deepEqual(zahn.progress, { done: 1, total: 2 });
    assert.equal(zahn.important, true);
    assert.equal(zahn.attachments, 1);
    const full = (await h.ok(ANNA, 'GET', 'tasks/' + zahn.id)).task;
    assert.equal(full.note, 'Praxis Müller');
    assert.equal(full.remindAt, '2026-11-09T09:00:00+01:00');
    assert.equal(full.attachmentList[0].name, 'Überweisung.pdf');
    const rasen = v.sections[0].items.find((x) => x.title === 'Rasen mähen');
    assert.deepEqual(rasen.repeat, { type: 'weekly', interval: 1, days: [6] });
    assert.deepEqual(v.sections[1].items.map((x) => x.title), ['Neu erledigt']);
    const work = await h.ok(ANNA, 'GET', 'nav', null, { area: 'work' });
    assert.ok(work.lists.some((l) => l.name === 'Projekt X'));
    assert.ok(mail.st.calls.some((x) => x.name === 'ms_tasks_token'));
  } finally { await h.close(); clock.set(T0); }
});

test('To Do: the transition period keeps both sides in step; ending it', async () => {
  const graph = fakeGraph();
  const { h } = await host(graph);
  try {
    const s = await h.ok(ANNA, 'POST', 'import/mstodo/start', { accountId: 3, lists: [{ id: 'L2', area: 'work' }], doneDays: 0, twoWay: true });
    const j = await runJob(h, s.job.id);
    assert.equal(j.state, 'done');
    const nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'work' });
    const l = nav.lists.find((x) => x.name === 'Projekt X');
    const t5 = (await h.ok(ANNA, 'GET', 'views/list:' + l.id)).sections[0].items[0];
    // here → To Do
    await h.ok(ANNA, 'PATCH', 'tasks/' + t5.id, { title: 'Angebot schreiben bis Freitag' });
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Neue Aufgabe', listId: l.id });
    await h.ok(ANNA, 'POST', `tasks/${t5.id}/complete`, { done: true });
    // To Do → here
    graph.st.delta.L2 = [{ id: 'T9', title: 'Von To Do', status: 'notStarted', lastModifiedDateTime: new Date(T0 + 3600000).toISOString() }];
    clock.advance(6 * 60000);
    await h.host.tick();
    assert.deepEqual(graph.st.patches.map((p) => [p.id, p.body.title, p.body.status]), [['T5', 'Angebot schreiben bis Freitag', 'completed']]);
    assert.deepEqual(graph.st.posts.map((p) => p.title), ['Neue Aufgabe']);
    const v = await h.ok(ANNA, 'GET', 'views/list:' + l.id);
    assert.ok(v.sections[0].items.some((x) => x.title === 'Von To Do'));
    // a removal in To Do; a deletion here
    graph.st.delta.L2 = [{ id: 'T9', '@removed': { reason: 'deleted' } }];
    await h.ok(ANNA, 'DELETE', 'tasks/' + t.task.id);
    clock.advance(6 * 60000);
    await h.host.tick();
    assert.deepEqual(graph.st.deletes, ['N1']);
    assert.ok(!(await h.ok(ANNA, 'GET', 'views/list:' + l.id)).sections[0].items.some((x) => x.title === 'Von To Do'));
    // ending the transition period
    const links = await h.ok(ANNA, 'GET', 'import/mstodo/links');
    await h.ok(ANNA, 'DELETE', 'import/mstodo/links/' + links.links[0].id);
    const before = graph.st.requests.length;
    await h.ok(ANNA, 'PATCH', 'tasks/' + t5.id, { title: 'nur noch hier' });
    clock.advance(6 * 60000);
    await h.host.tick();
    assert.equal(graph.st.requests.length, before);
    assert.equal((await h.call(MARC, 'DELETE', 'import/mstodo/links/' + links.links[0].id)).status, 404);
  } finally { await h.close(); clock.set(T0); }
});

test('To Do: without Mail, or switched off, it says so', async () => {
  const h = await withHost({ sources: PLUGINS.filter((p) => p !== 'gatecontrol-mail').map((p) => fakeSource(p)) });
  try {
    const r = await h.ok(ANNA, 'GET', 'import/mstodo/accounts');
    assert.deepEqual([r.available, r.reason], [false, 'mail_missing']);
    await h.host.saveSettings({ import_mstodo: false });
    assert.equal((await h.ok(ANNA, 'GET', 'import/mstodo/accounts')).reason, 'off');
    assert.equal((await h.call(ANNA, 'POST', 'import/mstodo/start', { accountId: 3, lists: [{ id: 'L1' }] })).status, 403);
  } finally { await h.close(); }
});
