'use strict';

// 1.22.0 — „Wer sieht dein Bild?“ in GateControl's profile (server/avatarvis.js): the Messenger asks for every picture
// with its level and decides per reader — all, contacts (family + chat / group partners), family (GateControl's family
// groups), self; GET me avatarInProfile and the mirror for older apps; privacy.avatar of an older app goes to the
// profile; pushes carry the sender's picture only for those who may see it; the one-time takeover (adoptAll).
// An older GateControl keeps everything in the Messenger (tools.test.js „avatar privacy“).

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { withHost, ADMIN, ANNA, MARC, LENA, OMA, SEC } = require('./helpers');
const avatarvis = require('../server/avatarvis');
const people = require('../server/people');

const PIC = '/avatars/aaaaaaaaaaaaaaaaaaaaaaaa.webp';
const USERS = [ADMIN, { ...ANNA, avatarUrl: PIC }, MARC, LENA, OMA];
const FAMILY = [{ id: 10, name: 'Familie', kind: 'family', members: [{ userId: ANNA.id, role: 'parent' }, { userId: LENA.id, role: 'child' }] }];
const OPTS = { users: USERS, gatecontrol: '1.200.0', groups: FAMILY, avatarVisibility: { levels: { [ANNA.id]: 'contacts' } } };

const picOf = async (c, viewer) => (await c.as(viewer)('GET', 'people')).json.people.find((p) => p.id === ANNA.id).avatarUrl;
const later = (c) => c.clock.add(11 * SEC); // the accounts are cached 10 s

test('contacts: the family and chat partners see the picture, nobody else', async () => {
  await withHost(OPTS, async (host, c) => {
    assert.equal(await picOf(c, LENA), PIC, 'family');
    assert.equal(await picOf(c, OMA), null, 'no family, no chat');
    assert.equal(await picOf(c, MARC), null);
    const d = await c.direct(ANNA, MARC);
    assert.equal(await picOf(c, MARC), PIC, 'a direct chat makes a contact');
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.peer.avatarUrl, PIC);
    await c.group(ANNA, [OMA], 'Ausflug');
    assert.equal(await picOf(c, OMA), PIC, 'a group too');
  });
});

test('family and self; the person always sees her own picture', async () => {
  await withHost(OPTS, async (host, c) => {
    await c.direct(ANNA, MARC);
    host.avatarVisibility.set(ANNA.id, 'family');
    later(c);
    assert.equal(await picOf(c, MARC), null, 'a chat partner, no family');
    assert.equal(await picOf(c, LENA), PIC);
    host.avatarVisibility.set(ANNA.id, 'self');
    later(c);
    assert.equal(await picOf(c, LENA), null);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.user.avatarUrl, PIC);
    host.avatarVisibility.set(ANNA.id, 'all');
    later(c);
    assert.equal(await picOf(c, OMA), PIC);
  });
});

test('GET me: avatarInProfile and the mirror; an older app writing privacy.avatar is forwarded to the profile', async () => {
  await withHost(OPTS, async (host, c) => {
    let me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.avatarInProfile, true);
    assert.deepEqual([me.prefs.privacy.avatar, me.prefs.privacy.avatarProfile], ['family', 'contacts']);
    const r = await c.as(ANNA)('PUT', 'prefs', { privacy: { avatar: 'nobody' } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.prefs.privacy.avatar, r.json.prefs.privacy.avatarProfile], ['nobody', 'self']);
    assert.equal(host.avatarVisibility.level(ANNA.id), 'self');
    assert.deepEqual(host.avatarVisibility.calls.filter((x) => x.op === 'set'), [{ op: 'set', userId: ANNA.id, level: 'self' }]);
    assert.equal(await picOf(c, LENA), null, 'at once (the accounts are read again)');
    me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.prefs.privacy.avatarProfile, 'self');
    assert.equal((await c.as(ANNA)('PUT', 'prefs', { privacy: { avatar: 'friends' } })).status, 400);
    // an app sends the whole privacy object: the unchanged mirror changes nothing in the profile
    host.avatarVisibility.set(ANNA.id, 'contacts');
    c.clock.add(11 * SEC);
    await c.as(ANNA)('PUT', 'prefs', { privacy: { lastSeen: 'family', avatar: 'family' } });
    assert.equal(host.avatarVisibility.level(ANNA.id), 'contacts', 'contacts stays (its mirror is family)');
    assert.equal(host.avatarVisibility.calls.filter((x) => x.op === 'set').length, 1);
  });
});

test('an older GateControl: no avatarInProfile, privacy.avatar stays in the Messenger', async () => {
  await withHost({ users: USERS }, async (host, c) => {
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.avatarInProfile, undefined);
    assert.equal(me.prefs.privacy.avatarProfile, undefined);
    await c.as(ANNA)('PUT', 'prefs', { privacy: { avatar: 'nobody' } });
    assert.equal(await picOf(c, MARC), null);
  });
});

test('push: the sender\'s picture only for readers who may see it', async () => {
  await withHost({ ...OPTS, avatarVisibility: { levels: { [ANNA.id]: 'family' } } }, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA], 'Familie');
    await c.send(ANNA, g.id, { text: 'Bin gleich da' });
    const p = c.pushes();
    const forUser = (id) => p.find((x) => x.users.includes(id)).data.sender.avatarUrl;
    assert.equal(forUser(LENA.id), PIC);
    assert.equal(forUser(MARC.id), null);
  });
});

test('adoptAll: once, old values narrower than „Alle“ only, nobody → self', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE prefs (user_id INTEGER PRIMARY KEY, ext TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO prefs (user_id, ext) VALUES (?, ?)');
  ins.run(2, JSON.stringify({ privacy: { avatar: 'nobody' } }));
  ins.run(3, JSON.stringify({ privacy: { avatar: 'family' } }));
  ins.run(4, JSON.stringify({ privacy: { avatar: 'all' } }));
  ins.run(5, null);
  ins.run(6, JSON.stringify({ privacy: { avatar: 'nobody' } }));
  const calls = [];
  const gc = {
    db: {
      query: async (sql, params) => ({ rows: db.prepare(sql).all(...(params || [])) }),
      get: async (sql, params) => ({ row: db.prepare(sql).get(...(params || [])) || null }),
      run: async (sql, params) => { const r = db.prepare(sql).run(...(params || [])); return { changes: Number(r.changes) }; },
      exec: async (sql) => { db.exec(sql); return null; },
    },
    users: {
      setAvatarVisibility: async () => ({}),
      adoptAvatarVisibility: async (id, level) => {
        calls.push([id, level]);
        if (id === 6) { const e = new Error('unknown'); e.code = 'ERR_NOT_FOUND'; throw e; }
        return { adopted: id !== 3, level };
      },
    },
  };
  const r = await avatarvis.adoptAll(gc, people.extOf);
  assert.deepEqual(calls, [[2, 'self'], [3, 'family'], [6, 'self']]);
  assert.deepEqual([r.adopted, r.failed, r.skipped], [1, 0, false]);
  assert.ok(db.prepare('SELECT value FROM settings WHERE key = ?').get(avatarvis.ADOPTED));
  assert.deepEqual(await avatarvis.adoptAll(gc, people.extOf), { adopted: 0, skipped: true }, 'only once');
  assert.equal(calls.length, 3);
  // an older GateControl: nothing
  assert.deepEqual(await avatarvis.adoptAll({ users: {} }, people.extOf), { adopted: 0, skipped: true });
  // a failure leaves the takeover for the next start
  db.exec('DELETE FROM settings');
  gc.users.adoptAvatarVisibility = async () => { const e = new Error('busy'); e.code = 'ERR_TIMEOUT'; throw e; };
  assert.equal((await avatarvis.adoptAll(gc, people.extOf)).failed, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
});

test('levels: fromOld / toOld / sees', () => {
  assert.deepEqual(['all', 'family', 'nobody'].map(avatarvis.fromOld), ['all', 'family', 'self']);
  assert.deepEqual(avatarvis.LEVELS.map(avatarvis.toOld), ['all', 'family', 'family', 'nobody']);
  const fams = new Map([[2, new Set([10])], [4, new Set([10])]]);
  assert.equal(avatarvis.sees('contacts', 3, 2, { fams, partner: true }), true);
  assert.equal(avatarvis.sees('contacts', 3, 2, { fams, partner: false }), false);
  assert.equal(avatarvis.sees('family', 3, 2, { fams, partner: true }), false);
  assert.equal(avatarvis.sees('family', 4, 2, { fams, partner: false }), true);
  assert.equal(avatarvis.sees('self', 4, 2, { fams, partner: true }), false);
  assert.equal(avatarvis.sees('self', 2, 2, { fams: null, partner: false }), true);
});
