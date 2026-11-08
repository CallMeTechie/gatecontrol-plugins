'use strict';

// 1.27.0 — Drive as a source of „Notizen & Aufgaben“ (gatecontrol-notizen, contract v1, server/notizen.js): the deadlines
// of documents as items for everyone who reads the file (a team folder: area 'work'), ticking them off round trip
// (todo_complete and POST deadlines/<id>/done — no reminder for a deadline ticked off), the push only of real changes in
// one call, kept on ERR_RATE_LIMIT, nothing without the hub; only the hub may call todo_items / todo_complete.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, BOB, OFFICE, DAY } = require('./helpers');
const { fakeHub, checkItem, pullAll, HUB } = require('../../../tools/testing/notizen-hub');
const manifest = require('../plugin.json');

const TEXT = 'Rechnung ACME GmbH\nBitte zahlen Sie 84,20 EUR bis zum 20.11.2026.';

function ai() {
  return {
    extract: async (req) => {
      if (req.task !== 'drive_document') throw new Error('unexpected ' + req.task);
      const pdf = (req.input || []).some((x) => x && typeof x.text === 'string' && x.text.includes('Vertrag'));
      if (pdf) {
        return { kind: 'contract', title: 'Wartungsvertrag', date: '2026-01-02', sender: 'Lift AG', amount: null, currency: null, folder: null, name: null,
          deadlines: [{ kind: 'cancellation', date: '2026-12-01', label: 'Wartungsvertrag kündigen' }] };
      }
      return {
        kind: 'invoice', title: 'Rechnung ACME', date: '2026-10-20', sender: 'ACME GmbH', amount: 84.2, currency: 'EUR', folder: null, name: null,
        deadlines: [{ kind: 'payment', date: '2026-11-20', label: null }, { kind: 'objection', date: '2026-01-01', label: 'längst vorbei' }],
      };
    },
  };
}

async function setup(host, c) {
  const me = (await c.as(ANNA)('GET', 'me')).json;
  const fam = me.areas.find((x) => x.kind === 'family');
  const f = (await c.put(ANNA, fam.rootId, 'Rechnung ACME.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
  await host.tick();
  return { fam, file: f };
}

const items = async (host, user) => (await pullAll(host, user)).items;

test('plugin.json: todo_items and todo_complete (600 an hour), todo_changed of the hub', () => {
  assert.equal(manifest.version, '1.27.1');
  for (const n of ['todo_items', 'todo_complete']) assert.equal(manifest.services.provides[n].maxPerHour, 600);
  assert.ok(manifest.permissions.services.includes('gatecontrol-notizen:todo_changed'));
});

test('items: a deadline for everyone who reads the file; a team folder is work; done round trip; no reminder once done', async () => {
  const hub = fakeHub();
  await withHost({ ai: ai(), gatecontrol: '1.216.0', services: [hub] }, async (host, c) => {
    const { fam, file } = await setup(host, c);
    const list = await items(host, ANNA);
    assert.equal(list.length, 1, 'a day long past is not „zu tun“');
    const d = list[0];
    assert.equal(checkItem(d, 'gatecontrol-drive'), null);
    assert.deepEqual([d.kind, d.due, d.allDay, d.area, d.done, d.canComplete, d.subtitle], ['deadline', '2026-11-20', true, 'private', false, true, 'Rechnung ACME.pdf']);
    assert.equal(d.title, 'ACME GmbH bezahlen');
    assert.deepEqual(d.users, [ANNA.id, MARC.id, LENA.id], 'the family area: every member with a seat');
    assert.deepEqual(d.meta, { type: 'payment', amount: '84,20 €' });
    assert.deepEqual(d.open, { plugin: 'gatecontrol-drive', route: `node/${file.id}` });
    assert.deepEqual(d.group, { id: `area:${fam.id}`, label: fam.label });
    assert.deepEqual(await items(host, OMA), [], 'no seat: nothing');
    assert.deepEqual(await items(host, BOB), []);

    // ticked off in the hub: done in Drive for everyone, no reminder any more
    const dl = (await c.as(MARC)('GET', 'deadlines')).json.deadlines[0];
    await c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    const r = await host.callService('todo_complete', { caller: HUB, user: MARC, payload: { v: 1, id: d.id, done: true } });
    assert.deepEqual([r.ok, r.item.done], [true, true]);
    const seen = (await c.as(LENA)('GET', 'deadlines')).json.deadlines[0];
    assert.equal(seen.done.by, MARC.id);
    c.clock.add(30 * DAY);
    await host.tick();
    assert.equal(c.pushes().filter((n) => n.topic === 'deadline').length, 0, 'a deadline ticked off sends no reminder');
    // and back, with the app's own route
    const back = await c.as(ANNA)('DELETE', `deadlines/${dl.id}/done`);
    assert.deepEqual([back.status, back.json.deadline.done], [200, null]);
    assert.equal((await c.as(ANNA)('POST', `deadlines/${dl.id}/done`)).json.deadline.done.by, ANNA.id);
    // refusals
    assert.deepEqual(await host.callService('todo_complete', { caller: HUB, user: BOB, payload: { v: 1, id: d.id, done: true } }), { ok: false, code: 'not_found' });
    assert.deepEqual(await host.callService('todo_complete', { caller: 'gatecontrol-mail', user: ANNA, payload: { v: 1, id: d.id, done: true } }), { ok: false, code: 'forbidden' });
    assert.deepEqual(await host.callService('todo_items', { caller: 'gatecontrol-mail', user: ANNA, payload: { v: 1 } }), { ok: false, code: 'forbidden' });

    // a team folder: work, for its readers with a business seat
    const tm = await c.admin('POST', 'admin/teams', { label: 'Technik', members: [{ principal: `g:${OFFICE}`, role: 'write' }] });
    assert.equal(tm.status, 200);
    const team = (await c.as(BOB)('GET', 'me')).json.areas.find((x) => x.kind === 'team');
    await c.put(BOB, team.rootId, 'Vertrag Lift.pdf', 'pdf', { mime: 'application/pdf', text: 'Vertrag über die Wartung' });
    await host.tick();
    const work = (await items(host, BOB)).find((x) => x.meta.type === 'cancellation');
    assert.ok(work);
    assert.deepEqual([work.area, work.users], ['work', [BOB.id]]);
  });
});

test('push: one call for the changes, only real changes, kept on ERR_RATE_LIMIT; nothing without the hub', async () => {
  let fail = false;
  const hub = fakeHub({ answer: () => { if (fail) throw Object.assign(new Error('rate'), { code: 'ERR_RATE_LIMIT' }); return undefined; } });
  await withHost({ ai: ai(), gatecontrol: '1.216.0', services: [hub] }, async (host, c) => {
    await setup(host, c);
    // the background run pushed what it found (at most every 2 minutes)
    const first = hub.pushes();
    assert.equal(first.length, 1);
    assert.equal(first[0].payload.upsert.length, 1);
    assert.equal(hub.rejected.length, 0);
    c.clock.add(3 * 60000);
    await host.tick();
    assert.equal(hub.pushes().length, 1, 'nothing changed: no call');
    const id = first[0].payload.upsert[0].id;
    const dl = (await c.as(ANNA)('GET', 'deadlines')).json.deadlines[0];
    fail = true;
    await c.as(ANNA)('POST', `deadlines/${dl.id}/done`);
    c.clock.add(3 * 60000);
    await host.tick();
    assert.equal(hub.items.get(`gatecontrol-drive|${id}`).done, false, 'refused by the rate limit');
    fail = false;
    c.clock.add(3 * 60000);
    await host.tick();
    assert.equal(hub.items.get(`gatecontrol-drive|${id}`).done, true, 'kept and sent with the next run');
    // the file deleted: the item goes
    await c.as(ANNA)('DELETE', `nodes/${dl.node.id}`);
    c.clock.add(3 * 60000);
    await host.tick();
    assert.deepEqual(hub.pushes().at(-1).payload.remove, [id]);
    assert.equal(hub.items.size, 0);
  });
  await withHost({ ai: ai(), gatecontrol: '1.216.0' }, async (host, c) => {
    await setup(host, c);
    c.clock.add(3 * 60000);
    await host.tick();
    assert.equal(host.serviceCalls.filter((x) => x.plugin === HUB).length, 0);
  });
});
