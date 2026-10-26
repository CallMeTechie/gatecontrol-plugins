'use strict';

// 1.15.0: the family as a GateControl group (GateControl ≥ 1.200.0, permissions.groups "manage"):
// gc.groups.ensure({ key: 'family', kind: 'family' }) with parents → parent, children → child, never a
// wall tablet — after every member change, at start, when it differs (background) and to heal; the hook
// groupsChanged brings an archived or deleted group back; NAME_TAKEN → „Familie (Plugin)“; an older
// GateControl without gc.groups changes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA, KUECHE, MIN, HOUR, birth } = require('./helpers');
const groups = require('../server/groups');

const GC = '1.200.0';
const SOURCE = 'plugin:gatecontrol-familie';

/** The plugin's family group in the mock host's store (or null). */
function familyGroup(host) {
  return [...host.groupStore.values()].find((g) => g.source === SOURCE && g.externalId === 'family') || null;
}
const roster = (g) => [...g.members].map(([userId, m]) => [userId, m.role]).sort((a, b) => a[0] - b[0]);

test('the family becomes the GateControl group „Familie“: parents as parent, children as child', () => withFamily({ gatecontrol: GC }, async (host, { admin }) => {
  const g = familyGroup(host);
  assert.ok(g, 'created by the first member change');
  assert.deepEqual([g.name, g.kind, g.parentId, g.archived], ['Familie', 'family', null, false]);
  assert.deepEqual(roster(g), [[ANNA.id, 'parent'], [MARC.id, 'parent'], [LENA.id, 'child'], [TIM.id, 'child']]);
  // the plugin reads it like any plugin: own, with its key
  const own = (await host.gc.groups.list({ kind: 'family' }))[0];
  assert.deepEqual([own.own, own.key, own.source, own.memberCount], [true, 'family', SOURCE, 4]);
  // GET admin/status tells the pages
  const st = await admin('GET', 'status');
  assert.deepEqual([st.json.group.available, st.json.group.groupId, st.json.group.name, st.json.group.ok, st.json.group.members], [true, g.id, 'Familie', true, 4]);
}));

test('every member change follows at once: add, role change, wall tablet never, remove', () => withFamily({ gatecontrol: GC }, async (host, { admin }) => {
  const g = familyGroup(host);
  host.groupChanges.length = 0;
  assert.equal((await admin('POST', 'members', { userId: OMA.id, role: 'parent' })).status, 200);
  assert.deepEqual(host.groupChanges, [{ type: 'member_added', groupId: g.id, userId: OMA.id, role: 'parent' }]);
  // a wall tablet is no member of the group
  assert.equal((await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' })).status, 200);
  assert.ok(!g.members.has(KUECHE.id));
  // Marc becomes a child (with a birthdate), Lena a parent
  assert.equal((await admin('PATCH', 'members/' + MARC.id, { role: 'child', birthdate: birth(16) })).status, 200);
  assert.equal((await admin('PATCH', 'members/' + LENA.id, { role: 'parent' })).status, 200);
  // Tim becomes a wall tablet: out of the group
  assert.equal((await admin('PATCH', 'members/' + TIM.id, { role: 'wall' })).status, 200);
  assert.equal((await admin('DELETE', 'members/' + OMA.id)).status, 200);
  assert.deepEqual(roster(g), [[ANNA.id, 'parent'], [MARC.id, 'child'], [LENA.id, 'parent']]);
  assert.deepEqual(host.groupChanges.slice(1).map((c) => [c.type, c.userId, c.role]), [
    ['role_changed', MARC.id, 'child'], ['role_changed', LENA.id, 'parent'], ['member_removed', TIM.id, 'child'], ['member_removed', OMA.id, 'parent'],
  ]);
  // nothing changed → the background run calls nothing
  const before = host.groupChanges.length;
  await host.tick();
  assert.equal(host.groupChanges.length, before);
}));

test('background: the name follows the notification language; a heal every 6 hours is a no-op', () => withFamily({ gatecontrol: GC }, async (host, { clock }) => {
  const g = familyGroup(host);
  host.settings.notify_lang = 'en';
  await host.tick();
  assert.equal(g.name, 'Family');
  assert.equal(host.groupChanges.at(-1).type, 'group_renamed');
  const at = (await groups.loadState(host.gc)).at;
  clock.add(HOUR);
  await host.tick();
  assert.equal((await groups.loadState(host.gc)).at, at, 'not due before 6 hours');
  clock.add(6 * HOUR);
  const n = host.groupChanges.length;
  await host.tick();
  assert.ok((await groups.loadState(host.gc)).at > at, 'healed');
  assert.equal(host.groupChanges.length, n, 'nothing to change');
}));

test('start: a family that exists before the upgrade gets its group on start; an empty one none', () => withFamily({ gatecontrol: GC, family: false }, async (host) => {
  assert.equal(familyGroup(host), null, 'an empty family creates no group');
  // members kept on an older GateControl (no group yet), then the plugin starts on one with groups
  for (const [u, role, b] of [[ANNA, 'parent', null], [LENA, 'child', birth(12)], [KUECHE, 'wall', null]]) {
    await host.gc.db.run('INSERT INTO members (user_id, role, birthdate, locate_mode, star_goal, color, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', [u.id, role, b, 'confirm', 20, Date.now()]);
  }
  await host.start();
  assert.deepEqual(roster(familyGroup(host)), [[ANNA.id, 'parent'], [LENA.id, 'child']]);
}));

test('groupsChanged: the group archived or deleted in GateControl comes back on the next background run', () => withFamily({ gatecontrol: GC }, async (host) => {
  const g = familyGroup(host);
  host.editGroups.archive(g.id);
  await host.groupsChanged();
  await host.tick();
  assert.equal(g.archived, false, 'ensure restores an archived group of the plugin');
  await host.editGroups.remove(g.id);
  assert.equal(familyGroup(host), null);
  await host.groupsChanged();
  await host.tick();
  const g2 = familyGroup(host);
  assert.ok(g2 && g2.id !== g.id, 'created anew');
  assert.equal(g2.members.size, 4);
  assert.equal((await groups.loadState(host.gc)).groupId, g2.id);
  // other groups do not concern Familie
  const other = host.editGroups.create({ name: 'Team', kind: 'team', members: [{ userId: OMA.id }] });
  host.editGroups.removeMember(other, OMA.id);
  await host.groupsChanged();
  assert.notEqual((await groups.loadState(host.gc)).hash, null, 'nothing to do');
}));

test('a local group „Familie“ at the top level: the plugin\'s group is called „Familie (Plugin)“', () => withFamily({ gatecontrol: GC, groups: [{ id: 50, name: 'Familie', kind: 'department' }] }, async (host) => {
  const g = familyGroup(host);
  assert.equal(g.name, 'Familie (Plugin)');
  assert.equal(g.members.size, 4);
}));

test('ensure refused: logged once, status says so, retried after 15 minutes', () => withFamily({ gatecontrol: GC, groups: [{ id: 50, name: 'Familie', kind: 'team' }, { id: 51, name: 'Familie (Plugin)', kind: 'team' }] }, async (host, { admin, clock }) => {
  assert.equal(familyGroup(host), null);
  const st = await admin('GET', 'status');
  assert.deepEqual([st.json.group.ok, st.json.group.error], [false, 'ERR_INVALID']);
  assert.equal(host.logs.filter((l) => /family group not ensured/.test(l.message)).length, 1, 'logged once, not per member change');
  host.groupStore.delete(51);
  await host.tick();
  assert.equal(familyGroup(host), null, 'not before 15 minutes (the members did not change)');
  clock.add(15 * MIN);
  await host.tick();
  assert.equal(familyGroup(host).name, 'Familie (Plugin)');
  assert.equal((await admin('GET', 'status')).json.group.ok, true);
}));

test('an older GateControl (no gc.groups): member changes work as before, status group.available false', () => withFamily({}, async (host, { admin }) => {
  assert.equal(host.gc.groups, undefined);
  assert.equal((await admin('PATCH', 'members/' + TIM.id, { starGoal: 30 })).status, 200);
  await host.tick();
  const st = await admin('GET', 'status');
  assert.deepEqual(st.json.group, { available: false, groupId: null, name: null, ok: false, error: null, at: null, members: null });
  assert.ok(!host.logs.some((l) => /group/.test(l.message) && l.level === 'warn'));
  // family_roles stays for older callers
  const r = await host.callService('family_roles', { caller: 'gatecontrol-messenger', payload: {} });
  assert.deepEqual([r.parents, r.children], [[ANNA.id, MARC.id], [LENA.id, TIM.id]]);
}));
