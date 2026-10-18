'use strict';

// 1.4.0: preferences (privacy, notify, chats), last seen / online, blocks, archive, pinned messages,
// chat lists, export, "remind me", suggestions — and the migration of a 1.3 database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHost, ANNA, MARC, LENA, OMA, MIN, HOUR, DAY, T0 } = require('./helpers');

const FAM = 'gatecontrol-familie';

test('prefs: privacy / notify / chats with defaults, partial updates, strict values', async () => {
  await withHost({}, async (host, c) => {
    const anna = c.as(ANNA);
    const p = (await anna('GET', 'me')).json.prefs;
    assert.deepEqual(p.privacy, { lastSeen: 'all', avatar: 'all', statusDefault: 'all', placeInStatus: 'family', groupAdd: 'all', defaultDisappearingS: 0 });
    assert.deepEqual(p.notify, { groupsMentionsOnly: false, reactions: true, statusDigest: false, eventReminderMin: 60 });
    assert.deepEqual(p.chats, { keepArchived: true });
    const r = await anna('PUT', 'prefs', { privacy: { lastSeen: 'nobody' }, notify: { eventReminderMin: 15 }, chats: { keepArchived: false } });
    assert.equal(r.json.prefs.privacy.lastSeen, 'nobody');
    assert.equal(r.json.prefs.privacy.avatar, 'all', 'the rest stays');
    assert.equal(r.json.prefs.notify.eventReminderMin, 15);
    assert.equal(r.json.prefs.readReceipts, true);
    for (const bad of [{ privacy: { lastSeen: 'friends' } }, { privacy: { nope: 1 } }, { notify: { eventReminderMin: 30 } }, { privacy: [] }, { chats: { keepArchived: 'yes' } }, { privacy: { defaultDisappearingS: 5 } }]) {
      assert.equal((await anna('PUT', 'prefs', bad)).json.code, 'invalid', JSON.stringify(bad));
    }
  });
});

test('last seen / online: on members and people, symmetric, family, blocks', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    await c.as(MARC)('GET', 'me');
    let conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    let marc = conv.members.find((m) => m.userId === MARC.id);
    assert.equal(marc.online, true);
    assert.equal(marc.lastSeenAt, new Date(T0).toISOString());
    c.clock.add(10 * MIN);
    conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    marc = conv.members.find((m) => m.userId === MARC.id);
    assert.deepEqual([marc.online, marc.lastSeenAt], [false, new Date(T0).toISOString()]);
    // Marc hides it → nobody sees his; and he sees nobody's (symmetric)
    await c.as(MARC)('PUT', 'prefs', { privacy: { lastSeen: 'nobody' } });
    conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.members.find((m) => m.userId === MARC.id).lastSeenAt, null);
    const fromMarc = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(fromMarc.members.find((m) => m.userId === ANNA.id).lastSeenAt, null);
    // family only: Lena (family) sees Anna, Oma not
    await c.as(ANNA)('PUT', 'prefs', { privacy: { lastSeen: 'family' } });
    await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, LENA.id] } });
    const ppl = async (u) => (await c.as(u)('GET', 'people')).json.people.find((x) => x.id === ANNA.id);
    assert.ok((await ppl(LENA)).lastSeenAt);
    assert.equal((await ppl(OMA)).lastSeenAt, null);
    // a block hides it both ways
    await c.as(ANNA)('POST', 'blocks', { userId: LENA.id });
    assert.equal((await ppl(LENA)).lastSeenAt, null);
  });
});

test('blocks: list, no direct messages either way, groups unaffected, avatar privacy', async () => {
  await withHost({ users: [{ id: 1, name: 'admin', role: 'admin' }, { ...ANNA, avatarUrl: '/avatars/aaaaaaaaaaaaaaaaaaaaaaaa.webp' }, MARC, LENA, OMA] }, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const g = await c.group(ANNA, [MARC]);
    let r = await c.as(ANNA)('POST', 'blocks', { userId: MARC.id });
    assert.deepEqual(r.json.blocks.map((b) => b.userId), [MARC.id]);
    assert.equal((await c.as(ANNA)('POST', 'blocks', { userId: ANNA.id })).json.code, 'invalid');
    const send = (u, id) => c.as(u)('POST', `conversations/${id}/messages`, { clientId: c.cid(), text: 'x' });
    assert.equal((await send(MARC, d.id)).json.code, 'blocked');
    assert.equal((await send(ANNA, d.id)).json.code, 'blocked');
    assert.equal((await send(MARC, g.id)).status, 200, 'groups are not affected');
    const conv = (await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation;
    assert.deepEqual([conv.peer.blocked, conv.can.send], [true, false]);
    assert.equal((await c.as(ANNA)('GET', 'people')).json.people.find((p) => p.id === MARC.id).blocked, true);
    // a blocked person does not get the blocker's picture
    assert.equal((await c.as(MARC)('GET', 'people')).json.people.find((p) => p.id === ANNA.id).avatarUrl, null);
    r = await c.as(ANNA)('DELETE', `blocks/${MARC.id}`);
    assert.deepEqual(r.json.blocks, []);
    assert.equal((await send(MARC, d.id)).status, 200);
    assert.equal((await c.as(MARC)('GET', 'people')).json.people.find((p) => p.id === ANNA.id).avatarUrl, '/avatars/aaaaaaaaaaaaaaaaaaaaaaaa.webp');
    await c.as(ANNA)('PUT', 'prefs', { privacy: { avatar: 'nobody' } });
    assert.equal((await c.as(MARC)('GET', 'people')).json.people.find((p) => p.id === ANNA.id).avatarUrl, null);
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.peer.avatarUrl, null);
  });
});

test('groupAdd and default disappearing messages', async () => {
  await withHost({}, async (host, c) => {
    await c.as(OMA)('PUT', 'prefs', { privacy: { groupAdd: 'nobody' } });
    const r = await c.as(ANNA)('POST', 'conversations', { kind: 'group', userIds: [MARC.id, OMA.id], title: 'Ausflug' });
    assert.deepEqual(r.json.skipped, [OMA.id]);
    assert.deepEqual(r.json.conversation.members.map((m) => m.userId).sort(), [ANNA.id, MARC.id]);
    const p = await c.as(ANNA)('PATCH', `conversations/${r.json.conversation.id}`, { add: [OMA.id, LENA.id] });
    assert.deepEqual(p.json.skipped, [OMA.id]);
    assert.equal((await c.as(ANNA)('POST', 'conversations', { kind: 'group', userIds: [OMA.id], title: 'x' })).json.code, 'not_allowed');
    await c.as(MARC)('PUT', 'prefs', { privacy: { defaultDisappearingS: 86400 } });
    const d = await c.direct(MARC, LENA);
    assert.equal(d.disappearingS, 86400);
  });
});

test('archive (keepArchived), pins (≤ 3, managed groups: admins), lists', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m1 = await c.send(ANNA, d.id, { text: 'eins' });
    let r = await c.as(MARC)('POST', `conversations/${d.id}/archive`, { archived: true });
    assert.equal(r.json.conversation.archived, true);
    assert.equal((await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation.archived, false, 'per member');
    await c.send(ANNA, d.id, { text: 'zwei' });
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.archived, true, 'keepArchived (default): stays');
    await c.as(MARC)('PUT', 'prefs', { chats: { keepArchived: false } });
    await c.send(ANNA, d.id, { text: 'drei' });
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.archived, false, 'comes back');
    assert.equal((await c.as(MARC)('POST', `conversations/${d.id}/archive`, {})).json.code, 'invalid');
    // pins
    const ms = [m1];
    for (const t of ['a', 'b', 'c']) ms.push(await c.send(MARC, d.id, { text: t }));
    for (const m of ms.slice(0, 3)) r = await c.as(MARC)('POST', `conversations/${d.id}/pins`, { messageId: m.id });
    assert.deepEqual(r.json.conversation.pinned, ms.slice(0, 3).map((m) => m.id));
    assert.equal((await c.as(ANNA)('POST', `conversations/${d.id}/pins`, { messageId: ms[3].id })).json.code, 'too_many');
    assert.ok(c.events('conversation.update').some((e) => e.data.reason === 'pins'));
    r = await c.as(ANNA)('DELETE', `conversations/${d.id}/pins/${ms[1].id}`);
    assert.deepEqual(r.json.conversation.pinned, [ms[0].id, ms[2].id]);
    // deleting a message for everyone unpins it
    await c.as(MARC)('DELETE', `messages/${ms[2].id}`, null, { for: 'all' });
    assert.deepEqual((await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation.pinned, [ms[0].id]);
    const fam = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id] } });
    const fm = await c.send(ANNA, fam.conversationId, { text: 'x' });
    assert.equal((await c.as(ANNA)('POST', `conversations/${fam.conversationId}/pins`, { messageId: fm.id })).json.code, 'managed');
    // lists
    r = await c.as(ANNA)('PUT', 'lists', [{ id: 'fam', name: 'Familie', conversationIds: [d.id, fam.conversationId, 9999] }, { id: 'w', name: 'Arbeit', conversationIds: [] }]);
    assert.deepEqual(r.json.lists, [{ id: 'fam', name: 'Familie', conversationIds: [d.id, fam.conversationId] }, { id: 'w', name: 'Arbeit', conversationIds: [] }]);
    assert.deepEqual((await c.as(ANNA)('GET', 'lists')).json.lists.map((l) => l.id), ['fam', 'w']);
    assert.deepEqual((await c.as(MARC)('GET', 'lists')).json.lists, []);
    for (const bad of [{ x: 1 }, [{ id: 'a b', name: 'x', conversationIds: [] }], [{ id: 'a', name: '', conversationIds: [] }], new Array(21).fill(0).map((_, i) => ({ id: 'l' + i, name: 'x', conversationIds: [] }))]) {
      assert.equal((await c.as(ANNA)('PUT', 'lists', bad)).json.code, 'invalid');
    }
    const row = await host.gc.db.get('SELECT data_enc FROM lists WHERE user_id = ?', [ANNA.id]);
    assert.ok(!row.row.data_enc.includes('Arbeit'), 'encrypted');
  });
});

test('export: "dd.mm.yy, HH:MM - Name: text", files as names, chunks with before', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { text: 'Hallo Marc' });
    await c.send(MARC, d.id, { kind: 'location', location: { lat: 50.5, lon: 7.1, label: 'Bonn' } });
    const r = await c.as(ANNA)('GET', `conversations/${d.id}/export`, null, { format: 'txt' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mime, 'text/plain');
    assert.equal(r.json.fileName, 'Chat mit Marc.txt');
    const d0 = new Date(T0);
    const stamp = `${String(d0.getDate()).padStart(2, '0')}.${String(d0.getMonth() + 1).padStart(2, '0')}.${String(d0.getFullYear()).slice(2)}, ${String(d0.getHours()).padStart(2, '0')}:00`;
    assert.equal(r.json.text, `${stamp} - Anna: Hallo Marc\n${stamp} - Marc: <Standort: Bonn 50.5,7.1>\n`);
    assert.deepEqual([r.json.count, r.json.truncated, r.json.before], [2, false, null]);
    assert.equal((await c.as(ANNA)('GET', `conversations/${d.id}/export`, null, { format: 'pdf' })).json.code, 'invalid');
    assert.equal((await c.as(OMA)('GET', `conversations/${d.id}/export`)).status, 404);
  });
});

test('remind me: list, delete, a push at the time (also when muted), gone with the message', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(MARC, d.id, { text: 'Zahnarzt Donnerstag 9 Uhr' });
    await c.as(ANNA)('PATCH', `conversations/${d.id}`, { notify: 'none' });
    let r = await c.as(ANNA)('POST', `messages/${m.id}/remind`, { at: new Date(T0 + HOUR).toISOString() });
    assert.equal(r.status, 200);
    const rid = r.json.reminder.id;
    assert.equal((await c.as(ANNA)('POST', `messages/${m.id}/remind`, { at: new Date(T0 - 1).toISOString() })).json.code, 'invalid');
    const r2 = await c.as(ANNA)('POST', `messages/${m.id}/remind`, { at: new Date(T0 + 2 * HOUR).toISOString() });
    let list = (await c.as(ANNA)('GET', 'reminders')).json.reminders;
    assert.deepEqual(list.map((x) => [x.id, x.messageId, x.preview]), [[rid, m.id, 'Zahnarzt Donnerstag 9 Uhr'], [r2.json.reminder.id, m.id, 'Zahnarzt Donnerstag 9 Uhr']]);
    assert.deepEqual((await c.as(MARC)('GET', 'reminders')).json.reminders, []);
    assert.equal((await c.as(MARC)('DELETE', `reminders/${rid}`)).status, 404);
    assert.equal((await c.as(ANNA)('DELETE', `reminders/${r2.json.reminder.id}`)).status, 200);
    const before = c.pushes().length;
    c.clock.add(HOUR);
    await host.tick();
    const p = c.pushes().slice(before);
    assert.equal(p.length, 1);
    assert.deepEqual([p[0].users, p[0].title, p[0].body, p[0].data.kind, p[0].data.messageId], [[ANNA.id], 'Erinnerung', 'Erinnerung: Zahnarzt Donnerstag 9 Uhr', 'reminder', m.id]);
    assert.deepEqual((await c.as(ANNA)('GET', 'reminders')).json.reminders, []);
    // a deleted message takes its reminders along
    const m2 = await c.send(MARC, d.id, { text: 'Noch was' });
    await c.as(ANNA)('POST', `messages/${m2.id}/remind`, { at: new Date(c.clock.now() + DAY).toISOString() });
    assert.equal((await c.as(MARC)('DELETE', `messages/${m2.id}`, null, { for: 'all' })).status, 200);
    assert.deepEqual((await c.as(ANNA)('GET', 'reminders')).json.reminders, []);
  });
});

test('suggest: items and dates of a message', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'Kannst du Milch, Eier und Brot kaufen? Grillen am Samstag um 15 Uhr.' });
    const r = (await c.as(MARC)('GET', `messages/${m.id}/suggest`)).json;
    assert.deepEqual(r.items, ['Milch', 'Eier', 'Brot']);
    assert.equal(r.dates.length, 1);
    const d0 = new Date(r.dates[0].startsAt);
    assert.deepEqual([d0.getDay(), d0.getHours(), d0.getMinutes()], [6, 15, 0]);
    assert.equal(r.dates[0].title, 'Grillen');
    assert.equal((await c.as(OMA)('GET', `messages/${m.id}/suggest`)).status, 404);
  });
});

test('migration 002: a 1.3 database keeps its messages, ids and files; new kinds fit', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const dir = path.join(__dirname, '..', 'migrations');
  db.exec('BEGIN;' + fs.readFileSync(path.join(dir, '001_init.sql'), 'utf8') + ';COMMIT;');
  db.exec("INSERT INTO conversations (kind, created_at, updated_at) VALUES ('group', 1, 1)");
  for (let i = 0; i < 4; i++) db.exec("INSERT INTO messages (conv_id, kind, body_enc, created_at, updated_at) VALUES (1, 'text', 'v1.x', 1, 1)");
  db.exec('DELETE FROM messages WHERE id = 4');
  db.exec("INSERT INTO media (media_id, conv_id, msg_id, role, kind, bytes, created_at) VALUES ('m1', 1, 1, 'file', 'image', 5, 1)");
  db.exec('BEGIN;' + fs.readFileSync(path.join(dir, '002_status_polls_events_actions.sql'), 'utf8') + ';COMMIT;');
  assert.deepEqual(db.prepare('SELECT id, body_enc FROM messages ORDER BY id').all().map((r) => [r.id, r.body_enc]), [[1, 'v1.x'], [2, 'v1.x'], [3, 'v1.x']]);
  db.exec("INSERT INTO messages (conv_id, kind, created_at, updated_at) VALUES (1, 'poll', 1, 1)");
  assert.equal(db.prepare("SELECT id FROM messages WHERE kind = 'poll'").get().id, 5, 'the id of a deleted message is not reused');
  assert.equal(db.prepare("SELECT bytes FROM media WHERE media_id = 'm1'").get().bytes, 5);
  db.exec("INSERT INTO media (media_id, story_id, role, kind, created_at) VALUES ('s1', 7, 'story', 'image', 1)");
  assert.throws(() => db.exec("INSERT INTO messages (conv_id, kind, created_at, updated_at) VALUES (1, 'nope', 1, 1)"));
  for (const tbl of ['statuses', 'stories', 'story_views', 'blocks', 'lists', 'reminders', 'polls', 'poll_votes', 'events', 'event_rsvps', 'event_checks', 'arrivals', 'action_msgs', 'card_images']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tbl), tbl);
  }
  const sql = fs.readFileSync(path.join(dir, '002_status_polls_events_actions.sql'), 'utf8');
  assert.ok(!/\b(attach|detach|vacuum|pragma|load_extension)\b|_gc_/i.test(sql), 'passes GateControl\'s SQL guard');
});
