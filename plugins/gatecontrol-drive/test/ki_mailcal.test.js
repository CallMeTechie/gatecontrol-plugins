'use strict';

// Deadlines also into a calendar of Mail (1.17.0, server/deadlines.js, server/insights.js) against stand-ins for Mail's
// services calendar_list / calendar_add and Familie's calendar_add — never Mail itself: GET deadlines/calendars, the
// target per person and area (PATCH areas/<id> { deadlinesTarget }, GET|PUT deadlines/targets, the area switch of 1.14.0
// as the default), POST deadlines/<id>/calendar { target }, new deadlines on their own into the person's target, the
// feature deadlineMailCalendar, Mail missing or refusing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA } = require('./helpers');

const TEXT = 'Kfz-Versicherung Musterversicherung AG\nVersicherungsschein 2026\nKündigung bis 30.11.2026';

function ai() {
  return {
    extract: async (req) => ({
      kind: 'insurance', title: 'Kfz-Versicherung 2026', date: '2026-01-02', sender: 'Musterversicherung AG', amount: null, currency: null, folder: null, name: null,
      deadlines: [{ kind: 'renewal', date: '2026-11-30', label: 'Kfz-Versicherung kündigen' }],
    }),
  };
}

const OUTLOOK = { id: 3, label: 'Outlook.com', kind: 'outlook', email: 'anna@outlook.com' };
const GC = { id: null, label: 'GateControl', kind: 'local', email: null };

/** A stand-in for Mail ≥ 1.6.0: the calendars per person, calendar_add idempotent by key, or what `o` says. */
function mail(o = {}) {
  const calls = [];
  const keys = new Map();
  let next = 500;
  const cals = {
    [ANNA.id]: [{ id: 7, name: 'Kalender', color: '#0078D4', writable: true, account: OUTLOOK }, { id: 8, name: 'Privat', color: '#46E0A0', writable: true, account: GC }],
    [MARC.id]: [{ id: 9, name: 'Privat', color: '#46E0A0', writable: true, account: GC }],
  };
  return {
    calls,
    o,
    entry: {
      plugin: 'gatecontrol-mail', provides: ['new_draft', 'calendar_list', 'calendar_add'],
      service: async ({ name, caller, user, payload }) => {
        calls.push({ name, caller, user: user && user.id, payload });
        if (o.refuse) return { ok: false, code: o.refuse, ...(o.reason ? { reason: o.reason } : {}) };
        if (!user || user.id !== payload.userId) return { ok: false, code: 'forbidden' };
        const mine = cals[user.id] || [];
        if (name === 'calendar_list') return { ok: true, calendars: mine };
        if (name !== 'calendar_add') return { ok: false, code: 'not_found' };
        if (!mine.some((c) => c.id === payload.calendarId)) return { ok: false, code: 'not_found' };
        const k = `${user.id}|${payload.calendarId}|${payload.key}`;
        if (payload.key && keys.has(k)) return { ok: true, eventId: keys.get(k) };
        const id = next++;
        if (payload.key) keys.set(k, id);
        return { ok: true, eventId: id };
      },
    },
  };
}

function familie() {
  const calls = [];
  let next = 100;
  return { calls, entry: { plugin: 'gatecontrol-familie', provides: ['calendar_add'], service: async ({ user, payload }) => { calls.push({ user: user && user.id, payload }); return { ok: true, eventId: next++ }; } } };
}

const adds = (m) => m.calls.filter((x) => x.name === 'calendar_add');

test('the calendars, the target per person and area, new deadlines into a calendar of Mail with note and key, the family calendar beside it', async () => {
  const m = mail();
  const fam = familie();
  await withHost({ ai: ai(), services: [m.entry, fam.entry] }, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('deadlineCalendar') && me.features.includes('deadlineMailCalendar'));
    assert.deepEqual(me.areas.map((x) => [x.kind, x.deadlinesTarget, x.deadlinesToCalendar]), [['mine', null, false], ['family', null, false], ['child', null, false]]);
    // what the apps offer
    const cals = (await a('GET', 'deadlines/calendars')).json;
    assert.equal(cals.family, true);
    assert.deepEqual(cals.mail.map((x) => [x.id, x.name, x.account.label, x.color]), [[7, 'Kalender', 'Outlook.com', '#0078D4'], [8, 'Privat', 'GateControl', '#46E0A0']]);
    assert.deepEqual(m.calls[0], { name: 'calendar_list', caller: 'gatecontrol-drive', user: ANNA.id, payload: { userId: ANNA.id, lang: 'de' } });
    // the targets: the areas where I write with AI for documents on (a child's folder is off by default)
    const mine = me.areas.find((x) => x.kind === 'mine');
    const famArea = me.areas.find((x) => x.kind === 'family');
    assert.deepEqual((await a('GET', 'deadlines/targets')).json.targets, [{ areaId: mine.id, label: 'Meine Dateien', target: null }, { areaId: famArea.id, label: famArea.label, target: null }]);
    // a calendar of Mail for my files: Drive keeps the label from calendar_list
    const p = await a('PATCH', `areas/${mine.id}`, { deadlinesTarget: { kind: 'mail', calendarId: 7, label: 'egal' } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const outlook = { kind: 'mail', calendarId: 7, label: 'Outlook.com · Kalender' };
    assert.deepEqual(p.json.area, { id: mine.id, docAi: true, deadlinesTarget: outlook, deadlinesToCalendar: true });
    assert.deepEqual((await c.area(ANNA, 'mine')).deadlinesTarget, outlook);
    // the upload: the new deadline goes into that calendar, with the file as the note and the key of the deadline
    await c.put(ANNA, mine.rootId, 'Versicherungsschein.pdf', 'pdf', { mime: 'application/pdf', text: TEXT });
    await host.tick();
    const [add] = adds(m);
    const dl = (await a('GET', 'deadlines')).json.deadlines[0];
    assert.equal(add.user, ANNA.id);
    assert.deepEqual({ ...add.payload, note: undefined }, { userId: ANNA.id, calendarId: 7, title: 'Kfz-Versicherung kündigen', startsAt: '2026-11-30', allDay: true, note: undefined, key: `drive:deadline:${dl.id}`, lang: 'de' });
    assert.match(add.payload.note, /^Versicherungsschein\.pdf/);
    assert.ok(add.payload.note.length <= 500);
    assert.equal(fam.calls.length, 0, 'not into the family calendar');
    assert.deepEqual(dl.calendar, { eventId: 500, at: new Date(c.clock.now()).toISOString(), target: { kind: 'mail', label: 'Outlook.com · Kalender' } });
    // again with the same target: the same entry, no call; into the family calendar beside it — the newest is `calendar`
    const before = m.calls.length;
    const again = await a('POST', `deadlines/${dl.id}/calendar`, { target: { kind: 'mail', calendarId: 7 } });
    assert.equal(again.json.deadline.calendar.eventId, 500);
    assert.equal(m.calls.length, before);
    c.clock.add(60000);
    const fr = (await a('POST', `deadlines/${dl.id}/calendar`)).json.deadline;
    assert.deepEqual(fr.calendar.target, { kind: 'family', label: 'Familienkalender' });
    assert.deepEqual(fr.calendars.map((x) => [x.target.kind, x.eventId]), [['mail', 500], ['family', 100]]);
    // another calendar of Mail by hand
    const gc = (await a('POST', `deadlines/${dl.id}/calendar`, { target: { kind: 'mail', calendarId: 8 } })).json.deadline;
    assert.equal(gc.calendars.length, 3);
    assert.equal(adds(m).pop().payload.calendarId, 8);
    // Marc reads my files? no — and his own entries are his
    assert.equal((await c.as(MARC)('POST', `deadlines/${dl.id}/calendar`, { target: { kind: 'mail', calendarId: 9 } })).status, 404);
  });
});

test('the family area: each person their own target; the switch of 1.14.0 is the default; older apps see what they set', async () => {
  const m = mail();
  const fam = familie();
  await withHost({ ai: ai(), services: [m.entry, fam.entry] }, async (host, c) => {
    const famArea = await c.area(ANNA, 'family');
    // Anna: her Outlook calendar; Marc: the family calendar (PUT deadlines/targets); Lena: not at all
    assert.equal((await c.as(ANNA)('PATCH', `areas/${famArea.id}`, { deadlinesTarget: { kind: 'mail', calendarId: 7 } })).status, 200);
    const put = await c.as(MARC)('PUT', 'deadlines/targets', { targets: [{ areaId: famArea.id, target: { kind: 'family' } }] });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.deepEqual(put.json.targets.find((x) => x.areaId === famArea.id).target, { kind: 'family' });
    // the area's switch on (an older app of Marc): his own choice goes, the switch holds for him — Anna keeps hers
    const old = await c.as(MARC)('PATCH', `areas/${famArea.id}`, { deadlinesToCalendar: true });
    assert.deepEqual([old.json.area.deadlinesToCalendar, old.json.area.deadlinesTarget], [true, { kind: 'family' }]);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM deadline_targets WHERE user_id = ?', [MARC.id])).rows[0].n, 0);
    assert.deepEqual((await c.area(ANNA, 'family')).deadlinesTarget, { kind: 'mail', calendarId: 7, label: 'Outlook.com · Kalender' });
    assert.equal((await c.as(LENA)('PUT', 'deadlines/targets', { targets: [{ areaId: famArea.id, target: null }] })).status, 200);
    assert.deepEqual([(await c.area(LENA, 'family')).deadlinesTarget, (await c.area(LENA, 'family')).deadlinesToCalendar], [null, false]);
    // uploads: Anna's into her Outlook calendar, Marc's into the family calendar, Lena's nowhere
    await c.put(ANNA, famArea.rootId, 'Anna.pdf', 'pdf-a', { mime: 'application/pdf', text: TEXT + '\nAnna' });
    await c.put(MARC, famArea.rootId, 'Marc.pdf', 'pdf-m', { mime: 'application/pdf', text: TEXT + '\nMarc' });
    await c.put(LENA, famArea.rootId, 'Lena.pdf', 'pdf-l', { mime: 'application/pdf', text: TEXT + '\nLena' });
    await host.tick();
    assert.deepEqual(adds(m).map((x) => [x.user, x.payload.calendarId]), [[ANNA.id, 7]]);
    assert.deepEqual(fam.calls.map((x) => x.user), [MARC.id]);
  });
});

test('refusals: an unknown calendar, a wrong shape, Mail answering unavailable or refusing Drive; without Mail no feature and no calendars of Mail', async () => {
  const m = mail();
  await withHost({ ai: ai(), services: [m.entry] }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    // without Familie: only Mail
    const me = (await a('GET', 'me')).json;
    assert.ok(!me.features.includes('deadlineCalendar') && me.features.includes('deadlineMailCalendar'));
    assert.equal((await a('GET', 'deadlines/calendars')).json.family, false);
    let r = await a('PATCH', `areas/${mine.id}`, { deadlinesTarget: { kind: 'mail', calendarId: 99 } });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'mail_unavailable', 'not_found']);
    for (const bad of [{ kind: 'outlook' }, { kind: 'mail' }, { kind: 'mail', calendarId: 'a b' }, 'family', true]) {
      r = await a('PATCH', `areas/${mine.id}`, { deadlinesTarget: bad });
      assert.deepEqual([r.status, r.json.code, r.json.field], [400, 'invalid', 'deadlinesTarget'], JSON.stringify(bad));
    }
    r = await a('PATCH', `areas/${mine.id}`, { deadlinesTarget: { kind: 'family' } });
    assert.deepEqual([r.status, r.json.code], [409, 'familie_unavailable']);
    assert.equal((await a('PUT', 'deadlines/targets', { targets: [] })).status, 400);
    assert.equal((await a('PUT', 'deadlines/targets', { targets: [{ areaId: 'mine:999', target: null }] })).status, 404);
    // a deadline: Mail answers unavailable (the sign-in ran out) — nothing kept
    await a('PATCH', `areas/${mine.id}`, { deadlinesTarget: { kind: 'mail', calendarId: 7 } });
    m.o.refuse = 'unavailable'; m.o.reason = 'auth_failed';
    await c.put(ANNA, mine.rootId, 'Vertrag.pdf', 'pdf', { mime: 'application/pdf', text: TEXT });
    await host.tick();
    const d = (await a('GET', 'deadlines')).json.deadlines[0];
    assert.equal(d.calendar, null, 'the automatic entry failed quietly');
    r = await a('POST', `deadlines/${d.id}/calendar`, { target: { kind: 'mail', calendarId: 7 } });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'mail_unavailable', 'auth_failed']);
    // a Mail that does not take Drive: the feature goes for six hours
    m.o.refuse = 'forbidden'; m.o.reason = null;
    r = await a('POST', `deadlines/${d.id}/calendar`, { target: { kind: 'mail', calendarId: 7 } });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'mail_unavailable', 'forbidden']);
    assert.ok(!(await a('GET', 'me')).json.features.includes('deadlineMailCalendar'));
    const none = (await a('GET', 'deadlines/calendars')).json;
    assert.deepEqual([none.family, none.mail], [false, []]);
    c.clock.add(6 * 3600000 + 1);
    m.o.refuse = null;
    assert.ok((await a('GET', 'me')).json.features.includes('deadlineMailCalendar'));
  });
  // no Mail at all: as in 1.16.0
  await withHost({ ai: ai() }, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(!me.features.includes('deadlineMailCalendar'));
    assert.ok(me.areas.every((x) => !('deadlinesTarget' in x)));
    const cals = (await a('GET', 'deadlines/calendars')).json;
    assert.deepEqual([cals.family, cals.mail], [false, []]);
    const mine = me.areas.find((x) => x.kind === 'mine');
    const r = await a('PATCH', `areas/${mine.id}`, { deadlinesTarget: { kind: 'mail', calendarId: 7 } });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'mail_unavailable', 'unavailable']);
  });
});

test('migration 015: the entries of 1.14.0 – 1.16.x stay, in the family calendar; one per person, deadline and target', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const path = require('node:path');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE doc_calendar (deadline_id INTEGER NOT NULL, user_id INTEGER NOT NULL, event_id INTEGER, at INTEGER NOT NULL, auto INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (deadline_id, user_id))`);
  db.prepare('INSERT INTO doc_calendar VALUES (?, ?, ?, ?, ?)').run(1, ANNA.id, 100, 5, 1);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '015_deadline_targets.sql'), 'utf8'));
  assert.deepEqual({ ...db.prepare('SELECT * FROM doc_calendar').get() }, { deadline_id: 1, user_id: ANNA.id, target: 'family', kind: 'family', label: null, event_id: 100, at: 5, auto: 1 });
  db.prepare("INSERT INTO doc_calendar (deadline_id, user_id, target, kind, label, event_id, at) VALUES (1, ?, 'mail:7', 'mail', 'Outlook.com · Kalender', 500, 6)").run(ANNA.id);
  assert.throws(() => db.prepare("INSERT INTO doc_calendar (deadline_id, user_id, target, at) VALUES (1, ?, 'family', 7)").run(ANNA.id), /UNIQUE/);
  assert.deepEqual(db.prepare('SELECT * FROM deadline_targets').all(), []);
  db.close();
});
