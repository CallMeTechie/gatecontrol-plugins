'use strict';

// Logic chains: ported from GateControl tests/smarthome_rules_service.test.js,
// smarthome_rules_api.test.js, smarthome_rules_resync.test.js and
// smarthome_deconz_rules_client.test.js (built-in Smart Home) — against the
// fake deCONZ gateway behind the mock host's home target.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDeconz, withHost, asAdmin, connected, ADMIN } = require('./helpers');

const q = (host, p, query) => host.request({ path: p, query, user: ADMIN });

function motionDef(by, extra = {}) {
  return { triggers: [{ kind: 'motion', resourceId: by('Bewegung Flur').id, event: 'detected' }], actions: [{ kind: 'group', resourceId: by('Wohnzimmer').id, set: { on: true } }], ...extra };
}

test('create puts a GC-labelled rule on the gateway and lists it as synced', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    const r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'Flur', definition: motionDef(by) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rule = r.json.rule;
    assert.ok(rule.deconz_rule_id);
    const onGw = gw.rules[rule.deconz_rule_id];
    assert.equal(onGw.name, `GC:${rule.id}:Flur`);
    assert.deepEqual(onGw.conditions[0], { address: '/sensors/12/state/presence', operator: 'eq', value: 'true' });
    assert.deepEqual(onGw.actions, [{ address: '/groups/8/action', method: 'PUT', body: { on: true } }]);
    const list = await q(host, '/rules', { gateway_id: String(id) });
    assert.equal(list.json.rules[0].synced, true);
    assert.equal(list.json.rules[0].orphaned, false);
    assert.equal(list.json.gc_rule_count, 1);
    assert.equal(list.json.limit_warn, false);
    assert.equal(list.json.cancelSupported, true);
  });
});

test('a delayed rule creates the schedule with the /api/<key> prefix and arms it', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    const r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'Licht aus', definition: motionDef(by, { delay: { minutes: 5, onRetrigger: 'reset' } }) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sched = gw.schedules[r.json.rule.deconz_schedule_id];
    assert.equal(sched.command.address, '/api/KEY1234567/groups/8/action');
    assert.equal(sched.time, 'PT00:05:00');
    const names = Object.values(gw.rules).map((x) => x.name).sort();
    assert.deepEqual(names, [`GC:${r.json.rule.id}:Licht aus`, `GC:${r.json.rule.id}:Licht aus#reset`]);
    assert.deepEqual(gw.rules[r.json.rule.deconz_rule_id].actions, [{ address: `/schedules/${r.json.rule.deconz_schedule_id}`, method: 'PUT', body: { status: 'enabled' } }]);
  });
});

test('cancel mode creates a CLIP flag; invalid definitions are refused with a detail', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    let r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'C', definition: motionDef(by, { delay: { minutes: 2, onRetrigger: 'cancel' } }) });
    assert.equal(r.status, 200);
    assert.ok(r.json.rule.deconz_clip_sensor_id);
    assert.equal(gw.clip[r.json.rule.deconz_clip_sensor_id].type, 'CLIPGenericFlag');
    r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'X'.repeat(21), definition: motionDef(by) });
    assert.equal(r.status, 400);
    assert.equal(r.json.detail, 'name_too_long');
    r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'P', definition: { triggers: [], actions: [{ kind: 'plug', resourceId: by('Poolpumpe').id, set: { bri: 5 } }] } });
    assert.equal(r.json.detail, 'plug_no_bri');
    r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'F', definition: { triggers: [], actions: [{ kind: 'light', resourceId: 9999, set: { on: true } }] } });
    assert.equal(r.json.detail, 'foreign_resource');
    r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'M' });
    assert.equal(r.json.code, 'SMARTHOME_RULE_INVALID');
    assert.equal((await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'M', definition: { triggers: 'x' } })).status, 400);
    const rows = (await host.gc.db.query('SELECT name FROM rules')).rows.map((x) => x.name);
    assert.deepEqual(rows, ['C'], 'no orphan rows');
  });
});

test('the rule limit: compensation removes what was created, no GC row stays', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    gw.failRulesWith = { status: 503, body: JSON.stringify([{ error: { type: 601, description: 'rule limit reached' } }]) };
    const r = await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'L', definition: motionDef(by, { delay: { minutes: 5, onRetrigger: 'ignore' } }) });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'DECONZ_RULE_LIMIT_REACHED');
    assert.deepEqual(gw.schedules, {}, 'schedule deleted again');
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM rules')).row.n, 0);
  });
});

test('update replaces the gateway objects, delete removes them (404 ignored), enabled toggles the gateway rule', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    const rule = (await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'R', definition: motionDef(by) })).json.rule;
    const old = rule.deconz_rule_id;
    let r = await asAdmin(host, 'PUT', `/rules/${rule.id}`, { name: 'R2', definition: motionDef(by) });
    assert.equal(r.status, 200);
    assert.equal(r.json.rule.name, 'R2');
    assert.ok(!gw.rules[old], 'old rule deleted');
    assert.equal(gw.rules[r.json.rule.deconz_rule_id].name, `GC:${rule.id}:R2`);
    r = await asAdmin(host, 'POST', `/rules/${rule.id}/enabled`, { enabled: false });
    assert.equal(r.json.rule.enabled, false);
    assert.ok(gw.calls.some((c) => c.method === 'PUT' && c.path.endsWith(`/rules/${r.json.rule.deconz_rule_id}`) && c.body.status === 'disabled'));
    assert.equal((await asAdmin(host, 'POST', `/rules/${rule.id}/enabled`, { enabled: 'no' })).status, 400);
    delete gw.rules[r.json.rule.deconz_rule_id]; // gone on the gateway already → 404 ignored
    r = await asAdmin(host, 'DELETE', `/rules/${rule.id}`);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM rules')).row.n, 0);
    assert.equal((await asAdmin(host, 'PUT', '/rules/999', { name: 'x', definition: {} })).status, 404);
  });
});

test('a rule whose device disappeared is listed as orphaned', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { id, by } = await connected(host);
  await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'O', definition: motionDef(by) });
  await host.gc.db.run('DELETE FROM resources WHERE id = ?', [by('Bewegung Flur').id]);
  const list = await q(host, '/rules', { gateway_id: String(id) });
  assert.equal(list.json.rules[0].orphaned, true);
  assert.equal((await q(host, '/rules', {})).json.code, 'SMARTHOME_RULE_INVALID');
}));

test('gateway count attributes GC-named rules (incl #reset/#cancel) to GateControl', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id } = await connected(host);
    gw.rules = { 1: { name: 'GC:5:Flur' }, 2: { name: 'GC:5:Flur#reset' }, 3: { name: 'GC:8:Bad#cancel' }, 4: { name: 'pir-fsm-reset' }, 5: { name: 'my hue rule' } };
    const r = await q(host, '/rules/gateway-count', { gateway_id: String(id) });
    assert.deepEqual(r.json, { ok: true, total_rules: 5, gc_rules: 3, external_rules: 2 });
  });
});

test('background: rules that lost their gateway objects are pushed again once', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    const rule = (await asAdmin(host, 'POST', '/rules', { gateway_id: id, name: 'Re', definition: motionDef(by) })).json.rule;
    await host.gc.db.run('UPDATE rules SET deconz_rule_id = NULL WHERE id = ?', [rule.id]);
    gw.rules = {}; // gateway was reset
    host.plugin._state.resynced = false;
    await host.tick();
    const row = (await host.gc.db.get('SELECT deconz_rule_id FROM rules WHERE id = ?', [rule.id])).row;
    assert.ok(row.deconz_rule_id);
    assert.equal(gw.rules[row.deconz_rule_id].name, `GC:${rule.id}:Re`);
  });
});
