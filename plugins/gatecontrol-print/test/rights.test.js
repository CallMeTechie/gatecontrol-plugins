'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MARC, LEA, TIM } = require('./helpers');

describe('rights per person', () => {
  let h;
  before(async () => { h = await setup(); });
  after(async () => { await h.host.close(); });

  it('defaults: admins everything, children of the family 20 pages a day in b/w, others without a limit', async () => {
    const r = await h.adminReq('GET', 'rights');
    assert.equal(r.ok, true, JSON.stringify(r));
    const by = new Map(r.people.map((p) => [p.id, p]));
    assert.deepEqual([by.get(ADMIN.id).print, by.get(ADMIN.id).scan, by.get(ADMIN.id).pagesPerDay, by.get(ADMIN.id).source], [true, true, 0, 'admin']);
    assert.deepEqual([by.get(MARC.id).pagesPerDay, by.get(MARC.id).bwOnly, by.get(MARC.id).source], [0, false, 'default']);
    assert.deepEqual([by.get(LEA.id).pagesPerDay, by.get(LEA.id).bwOnly, by.get(LEA.id).child, by.get(LEA.id).source], [20, true, true, 'child']);
  });

  it('an administrator changes and resets a person; an admin cannot be limited', async () => {
    let r = await h.adminReq('PUT', 'rights/' + TIM.id, { print: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.rights.print, r.rights.scan, r.rights.source], [false, true, 'custom']);
    r = await h.adminReq('PUT', 'rights/' + TIM.id, { pagesPerDay: 2000 });
    assert.equal(r.code, 'invalid');
    r = await h.adminReq('PUT', 'rights/' + ADMIN.id, { print: false });
    assert.equal(r.code, 'invalid');
    // Tim may not print: the portal refuses it on the server
    const p = await h.req(TIM, 'POST', '/print', { deviceId: 'x', mediaId: 'y' });
    assert.equal(p.code, 'no_right');
    assert.equal(p.status, 403);
    r = await h.adminReq('PUT', 'rights/' + TIM.id, { reset: true });
    assert.equal(r.rights.source, 'child');
  });

  it('admin pages only for an administrator in the admin UI', async () => {
    const r = await h.req(MARC, 'GET', '/admin/rights');
    assert.equal(r.code, 'forbidden');
    const r2 = await h.req(ADMIN, 'GET', '/admin/rights'); // an admin through the portal
    assert.equal(r2.code, 'forbidden');
  });

  it('the portal tab is shown to people who may print or scan', async () => {
    assert.equal(await h.host.portalVisible({ id: MARC.id, name: 'Marc', role: 'user' }), true);
    await h.adminReq('PUT', 'rights/' + MARC.id, { print: false, scan: false });
    assert.equal(await h.host.portalVisible({ id: MARC.id, name: 'Marc', role: 'user' }), false);
    await h.adminReq('PUT', 'rights/' + MARC.id, { reset: true });
  });
});
