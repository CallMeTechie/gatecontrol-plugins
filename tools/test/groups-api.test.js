'use strict';

// The mock host's mirror of GateControl 1.200.0 person groups (src/services/plugins/groups.js):
// permissions.groups "read" | "manage", gc.groups.list/get/members/isMember/leadersOf/ensure/remove,
// the hooks groupsChanged / groupUsage / groupDeleting and an administrator's changes (host.editGroups).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Ben', role: 'user' }, { id: 4, name: 'Alt', role: 'user', disabled: true }];
const GROUPS = [
  { id: 1, name: 'Verwaltung', kind: 'department', members: [{ userId: 1, role: 'lead' }] },
  { id: 2, name: 'Buchhaltung', kind: 'team', parentId: 1, members: [{ userId: 2, role: 'member' }, { userId: 4, role: 'deputy' }] },
  { id: 3, name: 'Kreditoren', kind: 'team', parentId: 2, members: [{ userId: 3 }] },
];

/** A plugin folder with plugin.json `manifest` and server/index.js `code` → { dir, done } */
function plugin(manifest, code = 'module.exports = {};') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'grp-test', name: 'G', version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), code);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('groups: only from GateControl 1.200.0; permissions.groups validated; refused without it', async () => {
  const p = plugin({ permissions: { groups: 'read' } });
  const bad = plugin({ permissions: { groups: 'write' } });
  const none = plugin({ permissions: {} });
  try {
    const old = await createHost(p.dir);
    assert.equal(old.gc.groups, undefined, 'an older host has no gc.groups');
    await old.close();
    await assert.rejects(createHost(bad.dir, { gatecontrol: '1.200.0' }), (e) => e.code === 'ERR_INVALID' && /permissions.groups/.test(e.message));
    const h = await createHost(none.dir, { gatecontrol: '1.200.0', groups: GROUPS });
    await assert.rejects(h.gc.groups.list(), (e) => e.code === 'ERR_GROUPS_DENIED');
    await h.close();
  } finally { p.done(); bad.done(); none.done(); }
});

test('groups: reading — list, get, nested members, isMember, leadersOf', async () => {
  const p = plugin({ permissions: { groups: 'read' } });
  const h = await createHost(p.dir, { gatecontrol: '1.200.0', users: USERS, groups: GROUPS });
  try {
    const g = h.gc.groups;
    assert.deepEqual((await g.list()).map((x) => x.path), ['Verwaltung', 'Verwaltung › Buchhaltung', 'Verwaltung › Buchhaltung › Kreditoren']);
    assert.deepEqual((await g.list({ userId: 3, includeInherited: true })).map((x) => [x.id, x.role, x.direct]), [[1, 'member', false], [2, 'member', false], [3, 'member', true]]);
    const b = await g.get(2);
    assert.deepEqual([b.childIds, b.depth, b.memberCount, b.totalMemberCount, b.own, b.key], [[3], 2, 2, 3, false, null]);
    assert.equal(await g.get(99), null);
    assert.deepEqual((await g.members(1, { nested: true })).map((m) => [m.userId, m.role, m.direct, m.groupId, m.enabled]),
      [[1, 'lead', true, 1, true], [4, 'member', false, 2, false], [2, 'member', false, 2, true], [3, 'member', false, 3, true]]);
    assert.deepEqual((await g.members(2, { roles: ['deputy'] })).map((m) => m.userId), [4]);
    await assert.rejects(g.members(99), (e) => e.code === 'ERR_NOT_FOUND');
    assert.equal(await g.isMember(3, 1, { nested: true }), true);
    assert.equal(await g.isMember(3, 1), false);
    assert.equal(await g.isMember(4, 2), false, 'a disabled account is no member');
    // the deputy is disabled: leadership walks up to Verwaltung
    assert.deepEqual(await g.leadersOf(3, { groupId: 3 }), [{ userId: 1, name: 'admin', role: 'lead', groupId: 1 }]);
    assert.deepEqual(await g.leadersOf(1, { groupId: 1 }), [], 'nobody is their own leader');
    await assert.rejects(g.ensure({ key: 'x', name: 'X', kind: 'team', members: [] }), (e) => e.code === 'ERR_GROUPS_DENIED', 'read only');
  } finally { await h.close(); p.done(); }
});

test('groups: ensure / remove of the plugin\'s own groups, changes, hooks', async () => {
  const code = `const seen = []; module.exports = { seen,
    async groupsChanged({ changes }) { seen.push(...changes); },
    async groupUsage({ groupId }) { return groupId === 2 ? [{ label: 'Chat Buchhaltung', onDelete: 'bleibt' }, { kind: 'x' }] : 'nope'; },
    async groupDeleting({ groupId }) { seen.push({ deleting: groupId }); } };`;
  const p = plugin({ permissions: { groups: 'manage' } }, code);
  const h = await createHost(p.dir, { gatecontrol: '1.200.0', users: USERS, groups: GROUPS });
  try {
    const g = h.gc.groups;
    const fam = await g.ensure({ key: 'family', name: 'Familie', kind: 'family', members: [{ userId: 2, role: 'parent' }, { userId: 3 }] });
    assert.deepEqual([fam.created, fam.added, fam.own, fam.key, fam.source], [true, 2, true, 'family', 'plugin:grp-test']);
    assert.deepEqual([...h.groupStore.get(fam.id).members].map(([u, m]) => [u, m.role]), [[2, 'parent'], [3, 'child']]);
    const again = await g.ensure({ key: 'family', name: 'Familie', kind: 'family', members: [{ userId: 2, role: 'child' }] });
    assert.deepEqual([again.created, again.added, again.removed, again.changed], [false, 0, 1, 1]);
    await assert.rejects(g.ensure({ key: 'family', name: 'Familie', kind: 'family', members: [{ userId: 2, role: 'lead' }] }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(g.ensure({ key: 'family', name: 'Familie', kind: 'family', members: [{ userId: 99 }] }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(g.ensure({ key: 'v', name: 'verwaltung', kind: 'team', members: [] }), (e) => e.code === 'ERR_INVALID' && /^NAME_TAKEN/.test(e.message));
    await assert.rejects(g.remove(1), (e) => e.code === 'ERR_READ_ONLY');
    assert.equal(await g.remove('nope'), false);
    const delivered = await h.groupsChanged();
    assert.deepEqual(delivered.map((c) => c.type), ['group_created', 'member_added', 'member_added', 'member_removed', 'role_changed']);
    assert.deepEqual(h.plugin.seen.length, 5);
    assert.deepEqual(await h.groupUsage(2), [{ kind: 'G', label: 'Chat Buchhaltung', onDelete: 'bleibt' }]);
    assert.deepEqual(await h.groupUsage(1), []);
    // an administrator's changes: the plugin's groupDeleting first (not for its own group)
    h.editGroups.setMember(3, 1, 'lead');
    await h.editGroups.remove(3);
    assert.equal(await g.remove('family'), true);
    await h.groupsChanged();
    assert.deepEqual(h.plugin.seen.slice(5).map((c) => c.deleting || c.type), [3, 'member_added', 'member_removed', 'member_removed', 'group_deleted', 'member_removed', 'group_deleted']);
    await assert.rejects(h.editGroups.remove(1), (e) => /HAS_CHILDREN/.test(e.message));
  } finally { await h.close(); p.done(); }
});
