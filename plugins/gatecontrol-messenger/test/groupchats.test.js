'use strict';

// 1.9.0: group chats for GateControl groups (GateControl ≥ 1.200.0, permissions.groups "read"): the administrator
// picks groups on „Übersicht“ (PUT admin/group-chats), each gets a managed chat with the group's effective members
// (subgroups included), the path as title and its leads / deputies / group admins as chat admins; the hook
// groupsChanged keeps it in step, an archived, deleted (groupDeleting) or deselected group's chat becomes a normal
// chat whose admins are the former leads; groupUsage names the chat; the family group is left to Familie.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, LENA, OMA, HOUR } = require('./helpers');
const groupchats = require('../server/groupchats');
const store = require('../server/store');

const GC = '1.200.0';
const groups = () => [
  { id: 10, name: 'Verwaltung', kind: 'department', members: [{ userId: ADMIN.id, role: 'lead' }] },
  { id: 11, name: 'Buchhaltung', kind: 'team', parentId: 10, members: [{ userId: ANNA.id, role: 'lead' }, { userId: MARC.id, role: 'member' }, { userId: LENA.id, role: 'admin' }] },
  { id: 12, name: 'Kreditoren', kind: 'team', parentId: 11, members: [{ userId: OMA.id, role: 'member' }] },
  { id: 20, name: 'Familie', kind: 'family', source: 'plugin:gatecontrol-familie', key: 'family', members: [{ userId: ANNA.id, role: 'parent' }, { userId: LENA.id, role: 'child' }] },
];

/** The chat of GateControl group `id` → { conv, roles: [[userId, role]] } (members still in it) or null. */
async function chatOf(host, id) {
  const conv = await store.one(host.gc, "SELECT * FROM conversations WHERE managed_by = 'gatecontrol-messenger' AND managed_key = ?", ['group:' + id]);
  if (!conv) return null;
  const rows = await store.all(host.gc, 'SELECT user_id, role FROM members WHERE conv_id = ? AND left_at IS NULL ORDER BY user_id', [conv.id]);
  return { conv, roles: rows.map((r) => [r.user_id, r.role]) };
}

test('an older GateControl (no gc.groups): the card says so, choosing is refused, nothing else changes', () => withHost({}, async (host, c) => {
  assert.equal(host.gc.groups, undefined);
  const r = await c.admin('GET', 'group-chats');
  assert.deepEqual(r.json.groupChats, { available: false, max: 50, selected: [], options: [] });
  assert.equal((await c.admin('PUT', 'group-chats', { groupIds: [11] })).json.code, 'unavailable');
  await host.tick();
}));

test('choosing a group: a managed chat with the effective members, the path as title, leads and group admins as chat admins', () => withHost({ gatecontrol: GC, groups: groups() }, async (host, c) => {
  const opts = (await c.admin('GET', 'group-chats')).json.groupChats.options;
  assert.deepEqual(opts.map((o) => [o.id, o.path, o.family]), [[20, 'Familie', true], [10, 'Verwaltung', false], [11, 'Verwaltung › Buchhaltung', false], [12, 'Verwaltung › Buchhaltung › Kreditoren', false]]);
  c.resetEvents();
  const r = await c.admin('PUT', 'group-chats', { groupIds: [11] });
  assert.equal(r.status, 200);
  const g = r.json.groupChats;
  assert.deepEqual(g.result, { synced: 1, released: 0, dropped: [], errors: 0 });
  assert.deepEqual(g.selected.map((x) => [x.id, x.path, x.members, x.ok, x.error]), [[11, 'Verwaltung › Buchhaltung', 4, true, null]]);
  const chat = await chatOf(host, 11);
  // Oma through the subgroup Kreditoren; the department's lead is no member of Buchhaltung
  assert.deepEqual(chat.roles, [[ANNA.id, 'admin'], [MARC.id, 'member'], [LENA.id, 'admin'], [OMA.id, 'member']]);
  const conv = (await c.as(MARC)('GET', `conversations/${chat.conv.id}`)).json.conversation;
  assert.deepEqual([conv.title, conv.managedBy, conv.coreGroupId, conv.can.leave, conv.can.manageMembers], ['Verwaltung › Buchhaltung', 'gatecontrol-messenger', 11, false, false]);
  assert.equal((await c.as(ANNA)('GET', `conversations/${chat.conv.id}`)).json.conversation.can.pin, true, 'a chat admin may pin');
  assert.equal((await c.as(ANNA)('PATCH', `conversations/${chat.conv.id}`, { add: [ADMIN.id] })).json.code, 'managed', 'members come from the group only');
  assert.ok(c.events('conversation.update').length, 'the members hear of the new chat');
  // the same selection again writes nothing
  c.resetEvents();
  const again = await c.admin('PUT', 'group-chats', { groupIds: [11] });
  assert.deepEqual(again.json.groupChats.result.synced, 0);
  assert.equal(c.events().length, 0);
  // bad bodies
  for (const body of [{}, { groupIds: 'all' }, { groupIds: [0] }, { groupIds: [99] }, { groupIds: Array.from({ length: 51 }, (_, i) => i + 1) }]) {
    assert.equal((await c.admin('PUT', 'group-chats', body)).json.code, 'invalid', JSON.stringify(body));
  }
}));

test('the family group is Familie\'s: never synced here, the administrator is told', () => withHost({ gatecontrol: GC, groups: groups() }, async (host, c) => {
  const r = await c.admin('PUT', 'group-chats', { groupIds: [20, 11] });
  assert.deepEqual(r.json.groupChats.skipped, [{ id: 20, path: 'Familie', reason: 'family' }]);
  assert.deepEqual(r.json.groupChats.selected.map((x) => x.id), [11]);
  assert.equal(await chatOf(host, 20), null);
  assert.deepEqual(await groupchats.selected(host.gc), [11]);
}));

test('groupsChanged: members, roles, subgroups and the name follow; unrelated changes write nothing', () => withHost({ gatecontrol: GC, groups: groups() }, async (host, c) => {
  await c.admin('PUT', 'group-chats', { groupIds: [11] });
  const id = (await chatOf(host, 11)).conv.id;
  host.groupChanges.length = 0;
  host.editGroups.setMember(12, ADMIN.id, 'member');      // into a subgroup
  host.editGroups.setMember(11, MARC.id, 'deputy');        // a deputy becomes chat admin
  host.editGroups.removeMember(11, LENA.id);               // out
  host.editGroups.rename(11, 'Finanzen');
  await host.groupsChanged();
  assert.deepEqual((await chatOf(host, 11)).roles, [[ADMIN.id, 'member'], [ANNA.id, 'admin'], [MARC.id, 'admin'], [OMA.id, 'member']]);
  assert.equal((await c.as(OMA)('GET', `conversations/${id}`)).json.conversation.title, 'Verwaltung › Finanzen');
  assert.equal((await c.as(LENA)('GET', `conversations/${id}`)).status, 404);
  // a subgroup archived: its members leave the chat
  host.editGroups.archive(12);
  await host.groupsChanged();
  assert.deepEqual((await chatOf(host, 11)).roles.map((x) => x[0]), [ANNA.id, MARC.id]);
  // a change elsewhere: compared, nothing written
  c.resetEvents();
  const msgs = (await store.one(host.gc, 'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?', [id])).n;
  host.editGroups.setMember(10, OMA.id, 'member');
  await host.groupsChanged();
  assert.equal(c.events().length, 0);
  assert.equal((await store.one(host.gc, 'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?', [id])).n, msgs);
}));

test('archived or deselected: the chat becomes a normal chat, admins = the former leads; it leaves the selection', () => withHost({ gatecontrol: GC, groups: groups() }, async (host, c) => {
  await c.admin('PUT', 'group-chats', { groupIds: [11, 10] });
  const id11 = (await chatOf(host, 11)).conv.id;
  const id10 = (await chatOf(host, 10)).conv.id;
  host.editGroups.archive(11);
  await host.groupsChanged();
  assert.equal(await chatOf(host, 11), null, 'no longer managed');
  const conv = (await c.as(MARC)('GET', `conversations/${id11}`)).json.conversation;
  assert.deepEqual([conv.managedBy, conv.coreGroupId, conv.can.leave], [null, null, true]);
  const roles = (await store.all(host.gc, 'SELECT user_id, role FROM members WHERE conv_id = ? AND left_at IS NULL ORDER BY user_id', [id11])).map((r) => [r.user_id, r.role]);
  assert.deepEqual(roles, [[ANNA.id, 'admin'], [MARC.id, 'member'], [LENA.id, 'admin'], [OMA.id, 'member']]);
  assert.deepEqual(await groupchats.selected(host.gc), [10]);
  assert.ok(host.logs.some((l) => l.level === 'info' && l.message === 'group chat released 11 archived'), 'in the plugin log');
  // Verwaltung (10) loses the archived subtree's members; deselecting it hands its chat back too
  const r = await c.admin('PUT', 'group-chats', { groupIds: [] });
  assert.deepEqual(r.json.groupChats.result.released, 1);
  assert.equal(await chatOf(host, 10), null);
  assert.equal((await c.as(ADMIN)('GET', `conversations/${id10}`)).json.conversation.managedBy, null);
}));

test('deleting a group: groupDeleting hands the chat back first; groupUsage names it', () => withHost({ gatecontrol: GC, groups: groups() }, async (host, c) => {
  await c.admin('PUT', 'group-chats', { groupIds: [12, 11] });
  assert.deepEqual(await host.groupUsage(11, ANNA.id), [{ kind: 'Messenger', label: 'Gruppenchat Verwaltung › Buchhaltung', onDelete: 'bleibt als normaler Chat ohne Abgleich' }]);
  assert.deepEqual(await host.groupUsage(10), [], 'not selected');
  const id12 = (await chatOf(host, 12)).conv.id;
  await host.editGroups.remove(12);
  assert.equal(await chatOf(host, 12), null);
  const roles = (await store.all(host.gc, 'SELECT user_id, role FROM members WHERE conv_id = ? AND left_at IS NULL', [id12])).map((r) => [r.user_id, r.role]);
  assert.deepEqual(roles, [[OMA.id, 'admin']], 'no lead: the member who joined first');
  assert.deepEqual(await groupchats.selected(host.gc), [11]);
  assert.deepEqual(await host.groupUsage(12), []);
  // the changes of the deletion: Oma leaves Buchhaltung's chat (she was in it through Kreditoren)
  await host.groupsChanged();
  assert.deepEqual((await chatOf(host, 11)).roles.map((x) => x[0]), [ANNA.id, MARC.id, LENA.id]);
}));

test('background: after a start the chats catch up with what changed while stopped; every 6 hours a heal', () => withHost({ gatecontrol: GC, groups: groups() }, async (host, c) => {
  await c.admin('PUT', 'group-chats', { groupIds: [11] });
  // a change the plugin never heard of (no hook while stopped)
  host.groupStore.get(11).members.delete(MARC.id);
  await host.start();
  await host.tick();
  assert.deepEqual((await chatOf(host, 11)).roles.map((x) => x[0]), [ANNA.id, LENA.id, OMA.id]);
  host.groupStore.get(11).members.set(MARC.id, { role: 'member', source: 'local', seq: 99 });
  await host.tick();
  assert.ok(!(await chatOf(host, 11)).roles.some((x) => x[0] === MARC.id), 'not before 6 hours');
  c.clock.add(6 * HOUR);
  await host.tick();
  assert.ok((await chatOf(host, 11)).roles.some((x) => x[0] === MARC.id), 'healed');
}));
