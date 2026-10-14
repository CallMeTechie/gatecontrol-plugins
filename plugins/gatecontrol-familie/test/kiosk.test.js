'use strict';

// Kiosk login for the wall tablet (1.1.1, permissions.kiosk): exactly the
// members with the role 'wall' are kiosk users — every role change keeps
// gc.kiosk in step, start reconciles it; a paired kiosk device
// (req.user.kiosk) writes like a signed-in viewer, device trust only reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, OMA, KUECHE, USERS, portal, kioskViewer } = require('./helpers');

const kioskOf = (host) => [...host.kiosk].sort((a, b) => a - b);

test('role changes: wall → gc.kiosk.allow(id, true), away from wall or removed → false; other members untouched', () => withFamily({}, async (host, { admin }) => {
  assert.deepEqual(kioskOf(host), [], 'parents and children are no kiosk users');
  assert.equal((await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' })).status, 200);
  assert.deepEqual(kioskOf(host), [KUECHE.id]);
  // edits that keep the role change nothing
  assert.equal((await admin('PATCH', 'members/' + KUECHE.id, { color: '#123456' })).status, 200);
  assert.equal((await admin('PATCH', 'members/' + ANNA.id, { color: '#654321' })).status, 200);
  assert.deepEqual(kioskOf(host), [KUECHE.id]);
  // away from wall
  assert.equal((await admin('PATCH', 'members/' + KUECHE.id, { role: 'parent' })).status, 200);
  assert.deepEqual(kioskOf(host), []);
  // back to wall
  assert.equal((await admin('PATCH', 'members/' + KUECHE.id, { role: 'wall' })).status, 200);
  assert.deepEqual(kioskOf(host), [KUECHE.id]);
  // a refused change (child without birthdate) keeps it
  assert.equal((await admin('PATCH', 'members/' + KUECHE.id, { role: 'child' })).json.code, 'invalid');
  assert.deepEqual(kioskOf(host), [KUECHE.id]);
  // a parent becomes a wall tablet and back
  await admin('PATCH', 'members/' + MARC.id, { role: 'wall' });
  assert.deepEqual(kioskOf(host), [MARC.id, KUECHE.id]);
  await admin('PATCH', 'members/' + MARC.id, { role: 'parent' });
  assert.deepEqual(kioskOf(host), [KUECHE.id]);
  // removed
  assert.equal((await admin('DELETE', 'members/' + KUECHE.id)).status, 200);
  assert.deepEqual(kioskOf(host), []);
  // removing a non-wall member does not touch gc.kiosk
  host.kiosk.add(TIM.id);
  await admin('DELETE', 'members/' + TIM.id);
  assert.deepEqual(kioskOf(host), [TIM.id], 'only a wall member is withdrawn on removal');
  assert.ok(!host.logs.some((l) => l.message.startsWith('kiosk')), JSON.stringify(host.logs.filter((l) => l.level === 'warn')));
}));

test('an administrator account as wall tablet: still a member, the host refuses the kiosk (logged), the page warns', () => withFamily({}, async (host, { admin }) => {
  const r = await admin('POST', 'members', { userId: ADMIN.id, role: 'wall' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.member.role, r.json.member.gcRole], ['wall', 'admin']);
  assert.deepEqual(kioskOf(host), []);
  assert.ok(host.logs.some((l) => l.level === 'warn' && l.message.startsWith('kiosk allow failed') && l.message.includes('ERR_INVALID')));
  assert.equal((await admin('DELETE', 'members/' + ADMIN.id)).status, 200, 'removing it works although the host refuses the withdrawal');
}));

test('start reconciles: exactly the current wall members (enabled, no administrators)', () => withFamily({ kiosk: [ANNA.id, OMA.id] }, async (host, { admin }) => {
  // the first start (withFamily) already withdrew Anna and Oma: no wall members yet
  assert.deepEqual(kioskOf(host), []);
  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  await admin('POST', 'members', { userId: OMA.id, role: 'wall' });
  await admin('POST', 'members', { userId: ADMIN.id, role: 'wall' });
  // drift (e.g. a change while the plugin was stopped, a failed call): one missing, one left over
  host.kiosk.delete(KUECHE.id);
  host.kiosk.add(TIM.id);
  await host.start();
  assert.deepEqual(kioskOf(host), [OMA.id, KUECHE.id]);
  assert.ok(host.logs.some((l) => l.message === 'kiosk users reconciled 1 1'), JSON.stringify(host.logs.slice(-5)));
  // in step: a second start changes nothing
  const n = host.logs.length;
  await host.start();
  assert.deepEqual(kioskOf(host), [OMA.id, KUECHE.id]);
  assert.ok(!host.logs.slice(n).some((l) => l.message.startsWith('kiosk')));
}));

test('start: a disabled wall account is withdrawn, a member whose account is gone is never allowed', () => withFamily({
  users: USERS.map((u) => (u.id === OMA.id ? { ...u, disabled: true } : u)), kiosk: [KUECHE.id], family: false,
}, async (host) => {
  // Küche was allowed before but is no wall member (any more) → withdrawn on start
  assert.deepEqual(kioskOf(host), []);
  await host.gc.db.run("INSERT INTO members (user_id, role, birthdate, locate_mode, star_goal, color, created_at) VALUES (?, 'wall', NULL, 'confirm', 20, NULL, 0)", [OMA.id]);
  await host.start();
  assert.deepEqual(kioskOf(host), [], 'a disabled account is not listed by gc.users and never allowed');
}));

test('a kiosk device writes like a signed-in viewer; device trust only reads; the wall guard still applies', () => withFamily({ settings: { mod_wall: true } }, async (host, { admin, as, call }) => {
  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  const fix = (await as(ANNA)('POST', '/tasks', { title: 'Zimmer aufräumen', mode: 'fixed', assignees: [LENA.id, TIM.id], repeat: 'daily' })).json.task;
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-0000-0001', name: 'REWE' }] });

  // device trust: read only
  const trust = portal(KUECHE, false);
  assert.equal((await call(trust, 'GET', '/wall')).status, 200);
  assert.equal((await call(trust, 'POST', `/tasks/${fix.id}/done`, { userId: LENA.id })).json.code, 'login_required');
  assert.equal((await call(trust, 'POST', '/shopping/ops', { ops: [{ op: 'item_add', id: 'item-0000-0001', listId: 'list-0000-0001', text: 'Milch' }] })).json.code, 'login_required');

  // a kiosk device (loggedIn true from GateControl; kiosk alone counts as well)
  for (const [i, viewer] of [kioskViewer(KUECHE), kioskViewer(KUECHE, false)].entries()) {
    const assignee = i === 0 ? LENA.id : TIM.id;
    const d = await call(viewer, 'POST', `/tasks/${fix.id}/done`, { userId: assignee });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const ops = await call(viewer, 'POST', '/shopping/ops', { ops: [{ op: 'item_add', id: `item-0000-000${i + 1}`, listId: 'list-0000-0001', text: 'Milch' }] });
    assert.deepEqual([ops.status, ops.json.applied], [200, 1]);
    // still only what the wall may do
    for (const [m, p, b] of [['POST', '/sos', {}], ['GET', '/emergency'], ['POST', '/tasks', { title: 'x', assignees: [TIM.id] }], ['GET', '/places']]) {
      assert.deepEqual([(await call(viewer, m, p, b)).json.code], ['forbidden'], `${m} ${p}`);
    }
  }
  const w = (await call(kioskViewer(KUECHE), 'GET', '/wall')).json;
  assert.deepEqual(w.shopping.items.map((x) => x.text), ['Milch', 'Milch']);

  // the portal tab: the wall view, writable for the kiosk device, "Nur lesen" for device trust
  const ctxOf = (html) => JSON.parse(html.split('window.FA_CTX=')[1].split(';</script>')[0]);
  const k = (await host.render({ view: 'portal', user: kioskViewer(KUECHE, false), loggedIn: false })).html;
  assert.deepEqual([ctxOf(k).page, ctxOf(k).loggedIn], ['wall', true]);
  const tr = (await host.render({ view: 'portal', user: trust, loggedIn: false })).html;
  assert.deepEqual([ctxOf(tr).page, ctxOf(tr).loggedIn], ['wall', false]);
}));
