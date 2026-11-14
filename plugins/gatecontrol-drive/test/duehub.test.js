'use strict';

// 1.30.0 — who reminds of a deadline: Drive, or „Notizen & Aufgaben“ (server/duehub.js; Notizen 1.7.0 server/drivedue.js).
// Both plugins are the real ones here, each in its own mock host, calling each other's services:
//   * the setting „Fristen erinnert“ is 'drive' unless chosen — nothing changes, the hub hears nothing of reminders;
//   * 'notizen': the reminder is a task of the hub (Task.deadline, GET reminders), it rings from there once („Frist in
//     3 Tagen: …“, Erledigt / Später / Datei öffnen), Drive sends no notification of its own, and says who rings (`by`);
//   * changing, removing, ticking off — in Drive and in the hub — reach the other side; a deleted task is „no reminder“;
//   * the way back, a hub that is older, stopped at the moment or refuses: Drive reminds itself, nothing rings twice;
//   * a vault's file never reaches the hub or a notification.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { withHost, ANNA, MARC, BOB, USERS, GROUPS, DAY, MIN } = require('./helpers');
const { fakeHub, HUB } = require('../../../tools/testing/notizen-hub');
const duehub = require('../server/duehub');
const manifest = require('../plugin.json');

const DRIVE = 'gatecontrol-drive';
const NOTIZEN_DIR = path.join(__dirname, '..', '..', HUB);
const TEXT = 'Kfz-Versicherung\nKündigung bis zum 30.11.2026 möglich.';

function ai() {
  return {
    extract: async () => ({
      kind: 'contract', title: 'Kfz-Versicherung', date: '2026-01-02', sender: 'Versichert AG', amount: null, currency: null, folder: null, name: null,
      deadlines: [{ kind: 'cancellation', date: '2026-11-30', label: 'Kfz-Versicherung kündigen' }],
    }),
  };
}

/**
 * Drive and the hub, linked both ways. o.settings: Drive's settings; o.noClaim: a hub whose permission to ask Drive is
 * not there (Drive offers no deadline_claim to it). fn(d): { drive, c (Drive's helpers), hub (the hub's host), asHub(user,
 * method, path, body), both() — a background run of each, Drive first }.
 */
async function linked(o, fn) {
  const state = { drive: null, down: false };
  const entry = {
    plugin: DRIVE,
    provides: Object.fromEntries(['todo_items', 'todo_complete', ...(o.noClaim ? [] : ['deadline_claim'])].map((n) => [n, { label: { de: n, en: n }, maxPerHour: 600 }])),
    service: (call) => { if (state.down) throw new Error('down'); return state.drive.callService(call.name, { caller: call.caller, user: call.user, payload: call.payload }); },
  };
  const hub = await createHost(NOTIZEN_DIR, { gatecontrol: '1.216.0', users: USERS, groups: GROUPS, license: { required: true, licensed: true, state: 'valid', expiresAt: null }, services: [entry] });
  await hub.start();
  try {
    // (the mock host turns this entry into the hub's services; `hubEntry.service = null`: the hub is not there for Drive)
    const hubEntry = { plugin: HUB, host: hub };
    await withHost({ ai: ai(), gatecontrol: '1.216.0', settings: o.settings || {}, services: [hubEntry] }, async (drive, c) => {
      state.drive = drive;
      const asHub = async (user, method, p, body) => {
        const r = await hub.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: { ...user, portal: true, loggedIn: true } });
        assert.equal(r.status, 200, `${method} ${p}: ${JSON.stringify(r.json)}`);
        return r.json;
      };
      const both = async (ms = 3 * MIN) => { c.clock.add(ms); await drive.tick(); await hub.tick(); };
      await fn({ drive, c, hub, asHub, both, state, hubEntry });
    });
  } finally {
    const bad = hub.logs.filter((l) => /background part failed|notify action failed|service failed/.test(String(l.message))).map((l) => l.message);
    await hub.close();
    assert.deepEqual(bad, [], 'the hub logged no failure');
  }
}

/** Anna's file with the deadline of 30.11.2026 in her own files → { file, dl (the deadline as GET deadlines gives it) }. */
async function contract(d, name = 'Versicherungsschein.pdf') {
  const mine = await d.c.area(ANNA, 'mine');
  const file = (await d.c.put(ANNA, mine.rootId, name, 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
  await d.drive.tick();
  const dl = (await d.c.as(ANNA)('GET', 'deadlines')).json.deadlines.find((x) => x.node.id === file.id);
  assert.ok(dl, 'the deadline was found');
  return { file, dl };
}

const deadlineOf = async (d, user, id) => (await d.c.as(user)('GET', 'deadlines')).json.deadlines.find((x) => x.id === id);
const hubTasks = async (d, user) => (await d.asHub(user, 'GET', 'views/planned')).sections.flatMap((s) => s.items).filter((x) => x.type === 'task' && x.deadline);
const drivePushes = (d) => d.c.pushes().filter((n) => n.topic === 'deadline');
const hubPushes = (d) => d.hub.notifications.filter((n) => n.topic === 'reminders');
const puts = (d) => d.drive.serviceCalls.filter((x) => x.service === duehub.PUT);

test('plugin.json: the setting (default drive), the service deadline_claim, the permission to hand over', () => {
  const s = manifest.ui.settings.find((x) => x.key === 'deadline_reminders');
  assert.deepEqual([s.type, s.default, s.options.map((x) => x.value)], ['select', 'drive', ['drive', 'notizen']]);
  assert.equal(manifest.services.provides.deadline_claim.maxPerHour, 600);
  assert.ok(manifest.permissions.services.includes('gatecontrol-notizen:deadline_reminders'));
});

test('unless chosen nothing changes: Drive reminds itself, the hub hears nothing of reminders and makes no task', async () => {
  await linked({}, async (d) => {
    const { dl } = await contract(d);
    const set = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    assert.equal(set.reminder.by, 'drive');
    await d.both();
    assert.equal(puts(d).length, 0, 'no list for the hub');
    assert.deepEqual(await hubTasks(d, ANNA), []);
    assert.equal((await d.c.as(ANNA)('GET', 'me')).json.features.includes('deadlineHub'), false);
    assert.equal((await d.asHub(ANNA, 'GET', 'me')).driveDeadlines.active, false);
    d.c.clock.add(40 * DAY);
    await d.drive.tick();
    await d.hub.tick();
    assert.equal(drivePushes(d).length, 1, 'Drive\'s own notification, as ever');
    assert.equal(hubPushes(d).length, 0);
  });
});

test('„Notizen & Aufgaben“ chosen: the reminder is a task there, rings once from there with Erledigt / Später / Datei öffnen; Drive sends none and says who rings', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { file, dl } = await contract(d);
    await d.both();
    assert.deepEqual(await hubTasks(d, ANNA), [], 'a deadline without a reminder is an item of the hub, no task');
    const set = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    await d.both();
    assert.ok((await d.c.as(ANNA)('GET', 'me')).json.features.includes('deadlineHub'));
    const seen = await deadlineOf(d, ANNA, dl.id);
    assert.deepEqual([seen.reminder.by, seen.reminder.sent, seen.reminder.daysBefore], ['notizen', false, 3]);
    // the hub: one task of Anna's that carries Drive's item
    const me = await d.asHub(ANNA, 'GET', 'me');
    assert.ok(me.features.includes('driveDeadlines'));
    assert.deepEqual(me.driveDeadlines, { available: true, active: true });
    const [t] = await hubTasks(d, ANNA);
    assert.ok(t, 'the task is there');
    assert.equal(t.title, 'Kfz-Versicherung kündigen');
    assert.deepEqual(t.due, { date: '2026-11-30', time: null });
    assert.deepEqual(t.source, { plugin: DRIVE, id: `deadline:${dl.id}` });
    assert.deepEqual(t.deadline, { date: '2026-11-30', kind: 'cancellation', file: 'Versicherungsschein.pdf', daysBefore: 3, open: { plugin: DRIVE, route: `node/${file.id}` } });
    assert.equal(t.reminder.atMs, Date.parse(set.reminder.at), 'at Drive\'s time');
    assert.deepEqual(await hubTasks(d, MARC), [], 'only the person whose reminder it is');
    // a device's own alarm: GET reminders (the next 30 days)
    await d.both(10 * DAY);
    const feed = (await d.asHub(ANNA, 'GET', 'reminders')).reminders;
    assert.equal(feed.length, 1);
    assert.deepEqual([feed[0].taskId, feed[0].title, feed[0].body], [t.id, 'Frist in 3 Tagen: Kfz-Versicherung kündigen', 'Kündigung bis 30.11.2026 · Versicherungsschein.pdf']);
    assert.deepEqual(feed[0].deadline, t.deadline);
    assert.deepEqual(feed[0].actions.map((a) => a.id), ['done', 'snooze_1h', 'snooze_eve'], 'the buttons of every reminder (an app adds „Datei öffnen“ from `deadline`)');
    // the moment comes: the hub rings, Drive does not
    d.c.clock.add(Date.parse(set.reminder.at) - d.c.clock.now() + MIN);
    await d.drive.tick();
    await d.hub.tick();
    assert.equal(drivePushes(d).length, 0, 'no notification of Drive\'s own');
    const [p] = hubPushes(d);
    assert.ok(p, 'the hub rang');
    assert.deepEqual([p.users, p.title, p.body], [[ANNA.id], 'Frist in 3 Tagen: Kfz-Versicherung kündigen', 'Kündigung bis 30.11.2026 · Versicherungsschein.pdf']);
    assert.deepEqual(p.data.actions.map((a) => [a.id, a.type]), [['done', 'callback'], ['snooze_1h', 'callback'], ['snooze_eve', 'callback'], ['open_file', 'open_portal']]);
    assert.equal(p.data.actions[3].target, `/portal?drive=${file.id}#plg-gatecontrol-drive`);
    assert.deepEqual(p.data.notizen.deadline, t.deadline);
    assert.equal((await deadlineOf(d, ANNA, dl.id)).reminder.sent, true, 'Drive knows it rang');
    // more runs: nothing again, from neither
    await d.both();
    await d.both(2 * DAY);
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [0, 1]);
    // „Später“: it rings again from the hub, without asking Drive, and Drive stays silent
    const claims = d.hub.serviceCalls.filter((x) => x.service === 'deadline_claim').length;
    assert.equal(claims, 1, 'asked once');
    const sn = await d.asHub(ANNA, 'POST', `tasks/${t.id}/snooze`, { until: '1h' });
    assert.equal(sn.snoozed, true);
    d.c.clock.add(61 * MIN);
    await d.drive.tick();
    await d.hub.tick();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [0, 2]);
    assert.equal(hubPushes(d)[1].title, 'Frist morgen: Kfz-Versicherung kündigen', 'the days are counted when it rings (two days on)');
    assert.equal(d.hub.serviceCalls.filter((x) => x.service === 'deadline_claim').length, claims);
  });
});

test('ticked off, changed, removed — on either side', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.both();
    let [t] = await hubTasks(d, ANNA);
    // another time in Drive: the task's reminder is that one
    await d.c.as(ANNA)('DELETE', `deadlines/${dl.id}/remind`);
    const again = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 7 })).json.deadline;
    await d.both();
    const list = await hubTasks(d, ANNA);
    assert.equal(list.length, 1, 'one task, not two');
    assert.deepEqual([list[0].deadline.daysBefore, list[0].reminder.atMs], [7, Date.parse(again.reminder.at)]);
    t = list[0];
    // ticked off in the hub: ticked off in Drive (for everyone who reads the file), no reminder from either
    await d.asHub(ANNA, 'POST', `tasks/${t.id}/complete`, { done: true });
    assert.equal((await deadlineOf(d, ANNA, dl.id)).done.by, ANNA.id);
    await d.both();
    d.c.clock.add(40 * DAY);
    await d.drive.tick();
    await d.hub.tick();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [0, 0]);
  });
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { file, dl } = await contract(d);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.both();
    const [t] = await hubTasks(d, ANNA);
    // ticked off in Drive: the task is done
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/done`);
    await d.both();
    const done = (await d.asHub(ANNA, 'GET', `tasks/${t.id}`)).task;
    assert.equal(done.done, true);
    // (the list still names it for a day — the task is not taken away before the hub heard that it is done)
    assert.deepEqual(puts(d).pop().payload.reminders.map((r) => r.id), [`deadline:${dl.id}`]);
    // … and not done after all: open again, with its reminder
    await d.c.as(ANNA)('DELETE', `deadlines/${dl.id}/done`);
    await d.both();
    assert.equal((await d.asHub(ANNA, 'GET', `tasks/${t.id}`)).task.done, false);
    assert.equal((await hubTasks(d, ANNA)).length, 1);
    // the reminder removed in Drive: the task goes
    await d.c.as(ANNA)('DELETE', `deadlines/${dl.id}/remind`);
    await d.both();
    assert.deepEqual(await hubTasks(d, ANNA), []);
    // set again and the file deleted: the task goes with the deadline
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.both();
    assert.equal((await hubTasks(d, ANNA)).length, 1);
    assert.equal((await d.c.as(ANNA)('DELETE', `nodes/${file.id}`)).status, 200);
    await d.both();
    assert.deepEqual(await hubTasks(d, ANNA), []);
    d.c.clock.add(40 * DAY);
    await d.drive.tick();
    await d.hub.tick();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [0, 0]);
  });
});

test('the task deleted in the hub: no reminder for this deadline, from neither — until another one is set in Drive', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    const first = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    await d.both();
    const [t] = await hubTasks(d, ANNA);
    await d.asHub(ANNA, 'DELETE', `tasks/${t.id}`);
    await d.both();
    await d.both(7 * 60 * MIN);
    assert.deepEqual(await hubTasks(d, ANNA), [], 'the lists that follow do not bring it back');
    d.c.clock.add(Date.parse(first.reminder.at) - d.c.clock.now() + MIN);
    await d.drive.tick();
    await d.hub.tick();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [0, 0]);
  });
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.both();
    const [t] = await hubTasks(d, ANNA);
    await d.asHub(ANNA, 'DELETE', `tasks/${t.id}`);
    await d.both();
    await d.c.as(ANNA)('DELETE', `deadlines/${dl.id}/remind`);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 1 });
    await d.both();
    const list = await hubTasks(d, ANNA);
    assert.equal(list.length, 1, 'another reminder set in Drive is a new one');
    assert.equal(list[0].deadline.daysBefore, 1);
  });
});

test('the way back: the setting on Drive again — the tasks go, Drive reminds itself, nothing twice', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    const set = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    await d.both();
    assert.equal((await hubTasks(d, ANNA)).length, 1);
    await d.drive.saveSettings({ deadline_reminders: 'drive' });
    assert.deepEqual(await hubTasks(d, ANNA), [], 'told at once');
    assert.equal((await deadlineOf(d, ANNA, dl.id)).reminder.by, 'drive');
    assert.equal((await d.asHub(ANNA, 'GET', 'me')).driveDeadlines.active, false);
    d.c.clock.add(Date.parse(set.reminder.at) - d.c.clock.now() + MIN);
    await d.drive.tick();
    await d.hub.tick();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [1, 0]);
    // and there again
    await d.drive.saveSettings({ deadline_reminders: 'notizen' });
    await d.both();
    assert.deepEqual(await hubTasks(d, ANNA), [], 'what Drive reminded of already is not handed over');
  });
});

test('the hub stopped just when the reminder is due: Drive sends it, and the hub does not ring it afterwards', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    const set = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    await d.both();
    assert.equal((await hubTasks(d, ANNA)).length, 1);
    // the hub is gone for Drive (stopped for an update): its service is not there
    const service = d.hubEntry.service;
    d.hubEntry.service = null;
    d.c.clock.add(Date.parse(set.reminder.at) - d.c.clock.now() + MIN);
    await d.drive.tick();
    assert.equal(drivePushes(d).length, 1, 'Drive reminds itself');
    // the hub is back; its task is overdue — it asks Drive, and Drive says no
    d.hubEntry.service = service;
    await d.hub.tick();
    await d.both();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [1, 0]);
  });
});

test('the hub stopped for good, an older hub, a hub that cannot ask back: Drive reminds itself and says why', async () => {
  // an older „Notizen & Aufgaben“: it takes items, but offers no deadline_reminders
  const old = fakeHub();
  await withHost({ ai: ai(), gatecontrol: '1.216.0', settings: { deadline_reminders: 'notizen' }, services: [old] }, async (drive, c) => {
    const d = { drive, c };
    const { dl } = await contract(d);
    const set = (await c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    assert.equal(set.reminder.by, 'drive');
    c.clock.add(3 * MIN);
    await drive.tick();
    assert.equal(old.calls.filter((x) => x.name === duehub.PUT).length, 0, 'not even tried');
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.includes('deadlineHub'), false);
    const lines = await drive.settingsStatus('de');
    assert.ok(lines.some((l) => l.tone === 'warn' && /bietet das aber nicht an/.test(l.text)), JSON.stringify(lines));
    c.clock.add(40 * DAY);
    await drive.tick();
    assert.equal(drivePushes(d).length, 1);
  });
  // the hub may not ask Drive back (the permission is not confirmed there): it refuses the list as a whole
  await linked({ settings: { deadline_reminders: 'notizen' }, noClaim: true }, async (d) => {
    const { dl } = await contract(d);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.both();
    assert.equal(puts(d).length, 1, 'offered once …');
    assert.deepEqual(await hubTasks(d, ANNA), []);
    assert.equal((await deadlineOf(d, ANNA, dl.id)).reminder.by, 'drive');
    assert.ok((await d.drive.settingsStatus('de')).some((l) => l.tone === 'warn' && /übernimmt die Erinnerungen gerade nicht/.test(l.text)));
    await d.both();
    await d.both();
    assert.equal(puts(d).length, 1, '… and not again every run');
    await d.both(11 * MIN);
    assert.equal(puts(d).length, 2, 'but after a while');
    d.c.clock.add(40 * DAY);
    await d.drive.tick();
    await d.hub.tick();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [1, 0]);
  });
});

test('Drive not reachable when the hub wants to ring: nothing rings unasked; asked again later, then it rings — once', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    const set = (await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 })).json.deadline;
    await d.both();
    d.state.down = true;
    d.c.clock.add(Date.parse(set.reminder.at) - d.c.clock.now() + MIN);
    await d.hub.tick();
    d.c.clock.add(MIN);
    await d.hub.tick();
    assert.equal(hubPushes(d).length, 0);
    assert.equal(d.hub.serviceCalls.filter((x) => x.service === 'deadline_claim').length, 1, 'not asked every minute');
    d.state.down = false;
    d.c.clock.add(6 * MIN);
    await d.drive.tick();
    await d.hub.tick();
    await d.both();
    assert.deepEqual([drivePushes(d).length, hubPushes(d).length], [0, 1]);
  });
});

test('deadline_claim: only the hub, only for the person of the call, only what was handed over and is still theirs to read', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { dl } = await contract(d);
    const claim = (user, payload, caller = HUB) => d.drive.callService('deadline_claim', { caller, user, payload });
    const p = { v: 1, id: `deadline:${dl.id}`, userId: ANNA.id };
    assert.deepEqual(await claim(ANNA, p, 'gatecontrol-mail'), { ok: false, code: 'forbidden' });
    assert.deepEqual(await claim(MARC, p), { ok: false, code: 'invalid' }, 'for another person than the call\'s');
    assert.deepEqual(await claim(ANNA, { ...p, id: 'x' }), { ok: false, code: 'invalid' });
    assert.deepEqual(await claim(ANNA, p), { ok: true, send: false }, 'no reminder');
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    assert.deepEqual(await claim(ANNA, p), { ok: true, send: false }, 'not handed over yet: Drive\'s own');
    await d.both();
    assert.deepEqual(await claim(BOB, { ...p, userId: BOB.id }), { ok: true, send: false }, 'not Bob\'s');
    assert.deepEqual(await claim(ANNA, p), { ok: true, send: true });
    assert.deepEqual(await claim(ANNA, p), { ok: true, send: true }, 'asked twice (the answer was lost): the same');
    assert.equal((await deadlineOf(d, ANNA, dl.id)).reminder.sent, true);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/done`);
    assert.deepEqual(await claim(ANNA, p), { ok: true, send: false }, 'ticked off');
  });
});

test('a vault: a reminder left on a vault\'s file is never handed over, never claimed, and its name is in no notification', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const { file, dl } = await contract(d, 'Geheimer Vertrag.pdf');
    const other = await contract(d, 'Offen.pdf');
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.c.as(ANNA)('POST', `deadlines/${other.dl.id}/remind`, { daysBefore: 3 });
    // the file lies in a vault now and its rows are still there (what the plugin itself never leaves behind)
    await d.drive.gc.db.run('UPDATE nodes SET vault_id = 1 WHERE id = ?', [file.id]);
    await d.both();
    const last = puts(d).pop().payload.reminders;
    assert.deepEqual(last.map((r) => r.id), [`deadline:${other.dl.id}`], 'only the open file\'s');
    assert.deepEqual((await hubTasks(d, ANNA)).map((t) => t.deadline.file), ['Offen.pdf']);
    assert.deepEqual(await d.drive.callService('deadline_claim', { caller: HUB, user: ANNA, payload: { v: 1, id: `deadline:${dl.id}`, userId: ANNA.id } }), { ok: true, send: false });
    d.c.clock.add(40 * DAY);
    await d.drive.tick();
    await d.hub.tick();
    const all = JSON.stringify([...d.c.pushes(), ...d.hub.notifications]);
    assert.equal(all.includes('Geheimer'), false, 'the vault file\'s name left neither plugin');
    assert.equal(drivePushes(d).length, 0);
    assert.equal(hubPushes(d).length, 1, 'the open file\'s reminder rang');
  });
  // and with Drive reminding itself
  await linked({}, async (d) => {
    const { file, dl } = await contract(d, 'Geheimer Vertrag.pdf');
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.drive.gc.db.run('UPDATE nodes SET vault_id = 1 WHERE id = ?', [file.id]);
    d.c.clock.add(40 * DAY);
    await d.drive.tick();
    assert.equal(JSON.stringify(d.c.pushes()).includes('Geheimer'), false);
  });
});

test('two people, each their own reminder; who no longer reads the file loses the task', async () => {
  await linked({ settings: { deadline_reminders: 'notizen' } }, async (d) => {
    const fam = await d.c.area(ANNA, 'family');
    const file = (await d.c.put(ANNA, fam.rootId, 'Hausrat.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    await d.drive.tick();
    const dl = (await d.c.as(ANNA)('GET', 'deadlines')).json.deadlines.find((x) => x.node.id === file.id);
    await d.c.as(ANNA)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 3 });
    await d.c.as(MARC)('POST', `deadlines/${dl.id}/remind`, { daysBefore: 7 });
    await d.both();
    assert.deepEqual((await hubTasks(d, ANNA)).map((t) => t.deadline.daysBefore), [3]);
    assert.deepEqual((await hubTasks(d, MARC)).map((t) => t.deadline.daysBefore), [7]);
    // Marc's seat goes: he reads nothing any more
    assert.equal((await d.c.admin('PUT', `admin/seats/${MARC.id}`, { kind: null })).status, 200);
    await d.both();
    assert.deepEqual(await hubTasks(d, MARC), []);
    assert.equal((await hubTasks(d, ANNA)).length, 1);
  });
});
