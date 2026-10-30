'use strict';

// Deadlines and the family calendar (1.14.0, server/deadlines.js, server/insights.js) against the mock host's gc.ai and a
// stand-in for the Familie plugin's service calendar_add: the new kinds warranty and renewal, GET deadlines with what
// the AI read, POST deadlines/<id>/calendar (once per person, Familie's refusals as familie_unavailable), the area's
// "new deadlines into the calendar on their own", the feature deadlineCalendar.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, DAY } = require('./helpers');

const TEXT = 'Kfz-Versicherung Musterversicherung AG\nVersicherungsschein 2026\nLaufzeit 01.01.2026 bis 31.12.2026, verlängert sich um ein Jahr\nKündigung bis 30.11.2026';

function ai() {
  return {
    extract: async (req) => {
      if (req.task !== 'drive_document') throw new Error('unexpected ' + req.task);
      // the new kinds are in the schema and the instructions
      assert.ok(req.schema.properties.deadlines.items.properties.kind.enum.includes('warranty'));
      assert.match(req.instructions, /renewal/);
      return {
        kind: 'insurance', title: 'Kfz-Versicherung 2026', date: '2026-01-02', sender: 'Musterversicherung AG', amount: 312.5, currency: 'EUR', folder: null, name: null,
        deadlines: [
          { kind: 'renewal', date: '2026-11-30', label: 'Kfz-Versicherung kündigen' },
          { kind: 'warranty', date: '2026-12-12', label: null },
          { kind: 'payment', date: '2026-01-01', label: 'längst vorbei' },
        ],
      };
    },
  };
}

/** A stand-in for Familie: calendar_add answers an event id, or what `o.refuse` says. */
function familie(o = {}) {
  const calls = [];
  let next = 100;
  return {
    calls,
    entry: {
      plugin: 'gatecontrol-familie', provides: ['calendar_add'],
      service: async ({ name, caller, user, payload }) => {
        calls.push({ name, caller, user: user && user.id, payload });
        if (o.refuse) return { ok: false, code: o.refuse };
        return { ok: true, eventId: next++ };
      },
    },
  };
}

test('new kinds, GET deadlines with the document, the family calendar once per person', async () => {
  const fam = familie();
  await withHost({ ai: ai(), services: [fam.entry] }, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('deadlineCalendar'));
    assert.deepEqual(me.areas.map((x) => [x.kind, x.deadlinesToCalendar]), [['mine', false], ['family', false], ['child', false]]);
    const famArea = me.areas.find((x) => x.kind === 'family');
    const f = (await c.put(ANNA, famArea.rootId, 'Versicherungsschein Kfz 2026.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    await host.tick();
    const list = (await a('GET', 'deadlines')).json.deadlines;
    assert.deepEqual(list.map((d) => [d.kind, d.date]), [['renewal', '2026-11-30'], ['warranty', '2026-12-12']], 'a day in the past is not listed');
    const [renewal, warranty] = list;
    assert.equal(renewal.label, 'Kfz-Versicherung kündigen');
    assert.deepEqual(renewal.doc, { kind: 'insurance', title: 'Kfz-Versicherung 2026', sender: 'Musterversicherung AG', amount: 312.5, currency: 'EUR' });
    assert.equal(renewal.foundAt, new Date(c.clock.now()).toISOString());
    assert.equal(renewal.calendar, null);
    assert.equal(renewal.node.id, f.id);
    assert.equal(fam.calls.length, 0, 'nothing on its own (the area is off)');

    // into the calendar: Familie's calendar_add for Anna, all day
    const r = await a('POST', `deadlines/${renewal.id}/calendar`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.deadline.calendar, { eventId: 100, at: new Date(c.clock.now()).toISOString() });
    assert.deepEqual(fam.calls[0], { name: 'calendar_add', caller: 'gatecontrol-drive', user: ANNA.id, payload: { userId: ANNA.id, title: 'Kfz-Versicherung kündigen', startsAt: '2026-11-30', allDay: true } });
    // again: the same entry, no second date
    const again = await a('POST', `deadlines/${renewal.id}/calendar`);
    assert.equal(again.json.deadline.calendar.eventId, 100);
    assert.equal(fam.calls.length, 1);
    // a deadline without a label: what to do and the sender (≤ 80)
    await a('POST', `deadlines/${warranty.id}/calendar`);
    assert.equal(fam.calls[1].payload.title, 'Garantie endet: Musterversicherung AG');
    // Marc reads the family's files: his own entry
    await c.as(MARC)('POST', `deadlines/${renewal.id}/calendar`);
    assert.equal(fam.calls[2].user, MARC.id);
    // each sees their own
    const mine = (await a('GET', `nodes/${f.id}/insight`)).json.deadlines.find((d) => d.id === renewal.id);
    assert.equal(mine.calendar.eventId, 100);
    assert.equal((await c.as(MARC)('GET', 'deadlines')).json.deadlines.find((d) => d.id === renewal.id).calendar.eventId, 102);
    assert.equal((await c.as(LENA)('GET', 'deadlines')).json.deadlines.find((d) => d.id === renewal.id).calendar, null);
    // Bob does not read the file
    assert.equal((await c.as(BOB)('POST', `deadlines/${renewal.id}/calendar`)).status, 404);
    assert.equal((await a('POST', 'deadlines/99999/calendar')).status, 404);

    // the reminder of a warranty says what it is
    await a('POST', `deadlines/${warranty.id}/remind`, { daysBefore: 0 });
    c.clock.add(50 * DAY);
    await host.tick();
    const push = c.pushes().find((n) => n.topic === 'deadline');
    assert.equal(push.title, 'Garantieende am 12.12.2026');
  });
});

test('Familie not there or refusing: 409 familie_unavailable, no feature, the switch refused', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('docAi'));
    assert.ok(!me.features.includes('deadlineCalendar'));
    assert.ok(me.areas.every((x) => !('deadlinesToCalendar' in x)));
    const mine = me.areas.find((x) => x.kind === 'mine');
    await c.put(ANNA, mine.rootId, 'Vertrag.pdf', 'pdf', { mime: 'application/pdf', text: TEXT });
    await host.tick();
    const d = (await a('GET', 'deadlines')).json.deadlines[0];
    const r = await a('POST', `deadlines/${d.id}/calendar`);
    assert.equal(r.status, 409);
    assert.deepEqual([r.json.code, r.json.reason], ['familie_unavailable', 'unavailable']);
    const p = await a('PATCH', `areas/${mine.id}`, { deadlinesToCalendar: true });
    assert.deepEqual([p.status, p.json.code], [409, 'familie_unavailable']);
    // docAi alone still works and answers as before
    assert.deepEqual((await a('PATCH', `areas/${mine.id}`, { docAi: true })).json.area, { id: mine.id, docAi: true });
  });
  const fam = familie({ refuse: 'forbidden' });
  await withHost({ ai: ai(), services: [fam.entry] }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Vertrag.pdf', 'pdf', { mime: 'application/pdf', text: TEXT });
    await host.tick();
    const d = (await a('GET', 'deadlines')).json.deadlines[0];
    const r = await a('POST', `deadlines/${d.id}/calendar`);
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'familie_unavailable', 'forbidden']);
    assert.equal((await a('GET', 'deadlines')).json.deadlines[0].calendar, null, 'nothing kept');
  });
});

test('an area with deadlinesToCalendar: new deadlines go in on their own for the uploader, once', async () => {
  const fam = familie();
  await withHost({ ai: ai(), services: [fam.entry] }, async (host, c) => {
    const a = c.as(ANNA);
    const famArea = await c.area(ANNA, 'family');
    assert.equal((await a('PATCH', `areas/${famArea.id}`, { deadlinesToCalendar: 'ja' })).status, 400);
    // a reader may not switch it (Lena reads the family's files? she writes there — Bob does not see it at all)
    assert.equal((await c.as(BOB)('PATCH', `areas/${famArea.id}`, { deadlinesToCalendar: true })).status, 404);
    const on = await a('PATCH', `areas/${famArea.id}`, { deadlinesToCalendar: true });
    assert.deepEqual(on.json.area, { id: famArea.id, docAi: true, deadlinesToCalendar: true });
    assert.equal((await c.area(ANNA, 'family')).deadlinesToCalendar, true);
    await c.put(MARC, famArea.rootId, 'Versicherung.pdf', 'pdf', { mime: 'application/pdf', text: TEXT });
    await host.tick();
    // the renewal and the warranty for Marc (the uploader) — not the payment of the past
    assert.deepEqual(fam.calls.map((x) => [x.user, x.payload.startsAt]), [[MARC.id, '2026-11-30'], [MARC.id, '2026-12-12']]);
    const list = (await c.as(MARC)('GET', 'deadlines')).json.deadlines;
    assert.ok(list.every((d) => d.calendar && d.calendar.eventId));
    // Anna's own entry is still hers to make
    assert.ok((await a('GET', 'deadlines')).json.deadlines.every((d) => d.calendar === null));
    // a new version with the same deadlines: nothing again
    await c.put(MARC, famArea.rootId, 'Versicherung.pdf', 'pdf2', { mime: 'application/pdf', text: TEXT + '\nSeite 2', onConflict: 'version' });
    await host.tick();
    assert.equal(fam.calls.length, 2);
  });
});
