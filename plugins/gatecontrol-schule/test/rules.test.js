'use strict';

// 1.1.0 — the Familie plugin's rules (server/ruleevents.js): the service school_students (only for
// gatecontrol-familie), the changes of a cycle in ONE rule_event call (only what is pushed, at most
// the 20 newest, the push line as text, in the notification language), quiet hours hold them like
// the pushes, no call without Familie (or without gc.services.available), errors never stop a cycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, setupParent, lessonAt, tickAt, at, LENA, EVA, T0 } = require('./helpers');
const ruleevents = require('../server/ruleevents');

const MIN = 60000;
const FAMILIE = 'gatecontrol-familie';
const pushes = (host) => host.notifications.filter((n) => n.topic === 'changes');
const ruleCalls = (host) => host.serviceCalls.filter((c) => c.plugin === FAMILIE && c.service === 'rule_event');

/** A stand-in Familie plugin: records the payloads of rule_event; answer(c) replaces { ok: true, fired: 1 }. */
function familie(o = {}) {
  const f = {
    plugin: FAMILIE, provides: ['rule_event'], got: [],
    service: async (c) => {
      f.got.push({ caller: c.caller, payload: c.payload });
      if (o.throws) throw new Error('kaputt');
      return o.answer ? o.answer(c) : { ok: true, fired: c.payload.events.length };
    },
  };
  return f;
}

async function household(host) {
  const s = await setupParent(host);
  await asAdmin(host, 'PUT', `/students/${s.lena.id}`, { alias: 'Lena' });
  return s;
}

test('school_students: only for the Familie plugin; enabled students mapped to a user, by display name', () => withHost({}, async (host) => {
  const { lena, max } = await household(host);
  assert.deepEqual(await host.callService('school_students', { caller: FAMILIE, payload: {} }), { ok: true, students: [{ userId: LENA.id, name: 'Lena' }] });
  assert.deepEqual(await host.callService('school_students', { caller: 'gatecontrol-messenger', payload: {} }), { ok: false, code: 'forbidden' });
  // Max mapped to Eva as well; Lena switched off
  await asAdmin(host, 'PUT', `/students/${max.id}`, { user_id: EVA.id });
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: false });
  const r = await host.callService('school_students', { caller: FAMILIE, payload: {} });
  assert.deepEqual(r.students.map((s) => s.userId), [EVA.id]);
}));

test('the changes of a cycle in one call, like the push; never twice; the result on the admin page', () => {
  const f = familie();
  return withHost({ services: [f], gatecontrol: '1.178.0' }, async (host, untis) => {
    await household(host);
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.rules, { available: true, last: null });
    lessonAt(untis, 101, 20261020, 950).code = 'cancelled';   // today 09:50
    lessonAt(untis, 101, 20261021, 1040).code = 'cancelled';  // tomorrow 10:40
    lessonAt(untis, 101, 20261022, 800).code = 'cancelled';   // beyond notify_days: only logged
    lessonAt(untis, 102, 20261020, 950).code = 'cancelled';   // Max: no user — pushed to nobody, no event
    await tickAt(host, T0 + 16 * MIN);
    assert.equal(pushes(host).length, 1);
    assert.equal(ruleCalls(host).length, 1);
    assert.equal(f.got[0].caller, 'gatecontrol-schule');
    assert.deepEqual(f.got[0].payload, {
      type: 'school_change',
      events: [
        { userId: LENA.id, kind: 'cancelled', date: '2026-10-20', start: '09:50', subject: 'Englisch', text: 'Lena: Englisch 3. Std. (09:50) fällt aus' },
        { userId: LENA.id, kind: 'cancelled', date: '2026-10-21', start: '10:40', subject: 'Biologie', text: 'Lena: Biologie 4. Std. (10:40) fällt aus' },
      ],
    });
    const st = (await asAdmin(host, 'GET', '/status')).json.rules;
    assert.deepEqual(st, { available: true, last: { at: T0 + 16 * MIN, ok: true, fired: 2, events: 2, code: null } });
    // the next cycles: nothing new, no call; a substitution and a restored lesson later
    await tickAt(host, T0 + 32 * MIN);
    assert.equal(ruleCalls(host).length, 1);
    const l = lessonAt(untis, 101, 20261020, 1040);
    l.code = 'irregular';
    l.te = [{ id: 14, name: 'KLE', longname: 'Klein', orgid: 12, orgname: 'SCH' }];
    delete lessonAt(untis, 101, 20261021, 1040).code;
    await tickAt(host, T0 + 48 * MIN);
    assert.equal(ruleCalls(host).length, 2);
    assert.deepEqual(f.got[1].payload.events.map((e) => [e.kind, e.date, e.start, e.text]), [
      ['changed', '2026-10-20', '10:40', 'Lena: Geschichte 4. Std. (10:40) – Vertretung'],
      ['restored', '2026-10-21', '10:40', 'Lena: Biologie 4. Std. (10:40) findet doch statt'],
    ]);
  });
});

test('English texts in the notification language', () => withHost({ services: [familie()], gatecontrol: '1.178.0', settings: { notify_lang: 'en' } }, async (host, untis) => {
  await household(host);
  lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(host.serviceCalls[0].payload.events[0].text, 'Lena: Englisch lesson 3 (09:50) cancelled');
}));

test('quiet hours: no call while the pushes are held; the held changes go with the released pushes', () => {
  const f = familie();
  return withHost({ services: [f], gatecontrol: '1.178.0', now: at('2026-10-20T19:30:00Z') }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261021, 800).code = 'cancelled';
    await tickAt(host, at('2026-10-20T20:31:00Z')); // 22:31
    await tickAt(host, at('2026-10-21T03:59:00Z')); // 05:59, still quiet
    assert.equal(f.got.length, 0);
    await tickAt(host, at('2026-10-21T04:01:00Z')); // 06:01
    assert.equal(pushes(host).length, 1);
    assert.deepEqual(f.got.map((x) => x.payload.events.map((e) => [e.date, e.start, e.kind])), [[['2026-10-21', '08:00', 'cancelled']]]);
    await tickAt(host, at('2026-10-21T04:30:00Z'));
    assert.equal(f.got.length, 1, 'once');
  });
});

test('no call without the Familie plugin, or on a GateControl without gc.services.available', async () => {
  for (const opts of [{ gatecontrol: '1.178.0' }, { services: [familie()] }]) {
    await withHost(opts, async (host, untis) => {
      await household(host);
      lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
      await tickAt(host, T0 + 16 * MIN);
      assert.equal(pushes(host).length, 1, 'the push as before');
      assert.equal(ruleCalls(host).length, 0);
      const st = (await asAdmin(host, 'GET', '/status')).json.rules;
      assert.deepEqual(st, { available: false, last: null });
      // handed over (skipped) once: the Familie plugin installed later gets no old changes
      const rows = (await host.gc.db.query('SELECT rule_at FROM changes')).rows;
      assert.deepEqual(rows.map((r) => r.rule_at), [T0 + 16 * MIN]);
    });
  }
});

test('errors never stop the cycle; the last error on the admin page', async () => {
  await withHost({ services: [familie({ throws: true })], gatecontrol: '1.178.0' }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
    await tickAt(host, T0 + 16 * MIN);
    assert.equal(pushes(host).length, 1);
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.rules.last, { at: T0 + 16 * MIN, ok: false, fired: 0, events: 1, code: 'failed' });
    // the next cycle fetches and pushes as ever, the failed change is not sent again
    lessonAt(untis, 101, 20261020, 1040).code = 'cancelled';
    await tickAt(host, T0 + 32 * MIN);
    assert.equal(pushes(host).length, 2);
    assert.equal(ruleCalls(host).length, 2);
    assert.equal(host.serviceCalls[1].payload.events.length, 1);
    const acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
    assert.equal(acc.status, 'ok');
  });
  await withHost({ services: [familie({ answer: () => ({ ok: false, code: 'forbidden' }) })], gatecontrol: '1.178.0' }, async (host, untis) => {
    await household(host);
    lessonAt(untis, 101, 20261020, 950).code = 'cancelled';
    await tickAt(host, T0 + 16 * MIN);
    assert.equal((await asAdmin(host, 'GET', '/status')).json.rules.last.code, 'forbidden');
  });
});

test('send(): at most the 20 newest changes, in lesson order; a throwing host is caught', async () => {
  const calls = [];
  const marked = [];
  const stored = {};
  const gc = {
    services: { available: async () => true, call: async (c) => { calls.push(c); return { ok: true, fired: 3 }; } },
    storage: { set: async (k, v) => { stored[k] = v; }, get: async (k) => stored[k] },
    db: { run: async (sql, params) => { marked.push(params.slice(1)); return { changes: params.length - 1 }; } },
    log: { warn: () => {}, info: () => {} },
  };
  const student = { display: 'Lena', user_id: LENA.id };
  const items = Array.from({ length: 25 }, (_, i) => ({
    student,
    change: { id: i + 1, kind: 'cancelled', date: `2026-10-${String(20 + (i % 3)).padStart(2, '0')}`, t_start: `${String(8 + Math.floor(i / 3)).padStart(2, '0')}:00`, period: 1 + Math.floor(i / 3), subject: 'M', detail: { subjectLong: 'Mathematik' }, detected_at: 1000 + i },
  }));
  const r = await ruleevents.send(gc, { lang: 'de' }, 5000, items);
  assert.deepEqual(r, { at: 5000, ok: true, fired: 3, events: 20, code: null });
  assert.equal(calls.length, 1);
  const ev = calls[0].payload.events;
  assert.equal(ev.length, 20);
  assert.ok(!ev.some((e) => e.start === '08:00' && e.date === '2026-10-20'), 'the five oldest left out');
  const keys = ev.map((e) => `${e.date} ${e.start}`);
  assert.deepEqual(keys, keys.slice().sort(), 'in lesson order');
  assert.equal(ev[0].text, 'Lena: Mathematik 3. Std. (10:00) fällt aus');
  assert.deepEqual(marked.flat().sort((a, b) => a - b), items.map((x) => x.change.id), 'all 25 handed over');
  assert.deepEqual(stored.rule_event, r);
  // a host that throws everywhere: no exception
  const bad = { services: { available: async () => { throw new Error('x'); }, call: async () => { throw new Error('x'); } }, storage: { set: async () => { throw new Error('x'); } }, db: { run: async () => { throw new Error('x'); } }, log: { warn: () => {} } };
  assert.equal(await ruleevents.send(bad, { lang: 'de' }, 1, items), null);
  assert.equal(await ruleevents.send(gc, { lang: 'de' }, 1, []), null);
});
