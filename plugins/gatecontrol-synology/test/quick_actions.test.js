'use strict';

// Quick actions, widget and Start tiles of the GateControl apps (hooks
// quickActions / runQuickAction / portalTiles / portalVisible): administrators
// only, per enabled NAS a device nas:<id> with "Aktualisieren" (carrying the
// widget), "Backup jetzt" per Hyper Backup task, "Neustart" and
// "Herunterfahren" — the last three ask first and go through the page's code
// paths (checks, log, "power" notice); a Start tile per NAS for the apps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDsm, fixture, withHost, addNas, asAdmin, ADMIN, ADA, netError } = require('./helpers');
const quick = require('../server/quick');
const config = require('../server/config');
const texts = require('../server/texts.json');

const I = quick.ICONS;
const t = (lang, key, params) => {
  let s = (texts[lang] && texts[lang][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
};
const cfg = config.fromSettings({});
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
/** The hook directly, as GateControl calls it (viewer of an app unless given otherwise). */
const direct = (host, user, id, extra = {}) => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang: 'de', id, via: 'app', automation: false, ...extra }, host.gc);
const nasRow = async (host, id) => (await host.gc.db.get('SELECT * FROM nas WHERE id = ?', [id])).row;

/** dsm72 without a pending DSM update (nothing to report) and with `tasks` Hyper Backup tasks. */
function calm({ tasks = 2, temp = 44, tempWarn = false, cpu = null } = {}) {
  const f = fixture('dsm72.json');
  f.responses['SYNO.Core.Upgrade.Server.check'] = { update: { available: false } };
  f.responses['SYNO.Backup.Task.list'].task_list = f.responses['SYNO.Backup.Task.list'].task_list.slice(0, tasks);
  f.responses['SYNO.DSM.Info.getinfo'].temperature = temp;
  f.responses['SYNO.DSM.Info.getinfo'].temperature_warn = tempWarn;
  if (cpu != null) Object.assign(f.responses['SYNO.Core.System.Utilization.get'].cpu, { user_load: cpu, system_load: 0, other_load: 0 });
  return fakeDsm(f);
}

test('visibility: administrators in an app (or their rules) only; anyone else gets nothing and cannot run', async () => {
  const d = calm();
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    assert.ok((await host.quickActions(ADMIN)).length > 0);
    assert.deepEqual(await host.quickActions(ADA), []);
    assert.deepEqual(await host.clientTiles(ADA), []);
    assert.equal(await host.portalVisible({ ...ADA, loggedIn: true, app: true }, 'nas'), false);
    assert.equal(await host.portalVisible({ ...ADMIN, loggedIn: true, app: true }, 'nas'), true);
    // the web portal (no app): nothing, not even for an administrator
    assert.deepEqual(await host.plugin.quickActions({ user: { ...ADMIN, portal: true, loggedIn: true }, lang: 'de' }, host.gc), []);
    assert.deepEqual(await host.portalTiles({ ...ADMIN, loggedIn: true }), []);
    assert.equal(await host.portalVisible({ ...ADMIN, loggedIn: true }, 'nas'), false);
    assert.deepEqual(await host.plugin.quickActions({ user: null, lang: 'de' }, host.gc), []);
    assert.deepEqual(await host.plugin.quickActions({ user: { ...ADMIN, app: true, loggedIn: false }, lang: 'de' }, host.gc), []);
    // a non-admin cannot run (the host answers 404, and the hook refuses on its own as well)
    const calls = d.state.calls.length;
    assert.equal((await host.runQuickAction(ADA, `reboot:${id}`)).status, 404);
    for (const user of [ADA, { ...ADMIN, app: false }, { ...ADMIN, loggedIn: false }]) {
      const r = await direct(host, user, `reboot:${id}`);
      assert.deepEqual(r, { ok: false, message: 'Nur für Administratoren.' }, JSON.stringify(user));
    }
    assert.equal((await host.runQuickAction(ADA, `reboot:${id}`, 'de', { automation: true, via: 'gatecontrol-familie' })).status, 404);
    assert.equal(d.state.calls.length, calls, 'nothing reached the NAS');
    assert.deepEqual(d.state.power, []);
    // an administrator's rule (another plugin's gc.actions.run) sees and runs them
    const r = await host.runQuickAction(ADMIN, `refresh:${id}`, 'de', { automation: true, via: 'gatecontrol-familie' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

test('listing: per enabled NAS a device with refresh (widget), backup per task, restart, shut down; confirm flags', async () => {
  const one = calm({ tasks: 1 });
  const two = calm({ tasks: 2 });
  const off = calm();
  await withHost({ nas: [two, one, off] }, async (host) => {
    const a = await addNas(host, { name: 'Keller', target_index: 0 });
    const b = await addNas(host, { name: 'Büro', target_index: 1 });
    const c = await addNas(host, { name: 'Alt', target_index: 2 });
    await asAdmin(host, 'PUT', `/nas/${c}`, { enabled: false });
    const list = await host.quickActions(ADMIN);
    // the page's order (by name): Büro, Keller; the disabled one is left out
    assert.deepEqual(list.map((x) => x.id), [`refresh:${b}`, `backup:${b}:1`, `reboot:${b}`, `shutdown:${b}`, `refresh:${a}`, `backup:${a}:1`, `backup:${a}:2`, `reboot:${a}`, `shutdown:${a}`]);
    for (const x of list) {
      assert.equal(x.kind, 'button');
      assert.equal(x.confirm, !x.id.startsWith('refresh:'), `${x.id} confirm`);
      assert.equal(x.state, null);
      assert.equal(x.widget == null, !x.id.startsWith('refresh:'), `${x.id}: only refresh carries the widget`);
      assert.equal(x.device.id, `nas:${x.id.split(':')[1]}`);
      assert.deepEqual([x.confirmWhen, x.look, x.verbs, x.targets], [null, null, null, false]);
    }
    const byId = Object.fromEntries(list.map((x) => [x.id, x]));
    assert.deepEqual(byId[`refresh:${a}`].device, { id: `nas:${a}`, title: 'Keller', subtitle: 'DS920+', icon: I.nas });
    assert.deepEqual([byId[`refresh:${a}`].title, byId[`refresh:${a}`].subtitle, byId[`refresh:${a}`].icon], ['Aktualisieren', 'Keller', I.refresh]);
    // one task: "Backup jetzt" with the task; several: the task's name as the title
    assert.deepEqual([byId[`backup:${b}:1`].title, byId[`backup:${b}:1`].subtitle], ['Backup jetzt', 'Büro · USB-Sicherung']);
    assert.deepEqual([byId[`backup:${a}:1`].title, byId[`backup:${a}:1`].subtitle], ['USB-Sicherung', 'Backup jetzt · Keller']);
    assert.deepEqual([byId[`backup:${a}:2`].title, byId[`backup:${a}:2`].icon], ['Cloud (C2)', I.backup]);
    assert.deepEqual([byId[`reboot:${a}`].title, byId[`reboot:${a}`].icon], ['Neustart', I.reboot]);
    assert.deepEqual([byId[`shutdown:${a}`].title, byId[`shutdown:${a}`].icon], ['Herunterfahren', I.shutdown]);
    const en = await host.quickActions(ADMIN, 'en');
    assert.deepEqual(en.filter((x) => x.device.id === `nas:${b}`).map((x) => x.title), ['Refresh', 'Back up now', 'Restart', 'Shut down']);
    // listing asks no NAS
    const calls = [two, one, off].map((x) => x.state.calls.length);
    await host.quickActions(ADMIN);
    await host.clientTiles(ADMIN);
    assert.deepEqual([two, one, off].map((x) => x.state.calls.length), calls);
  });
});

test('listing: at most 16 entries, at most 4 backup tasks per NAS', async () => {
  const f = fixture('dsm72.json');
  const base = f.responses['SYNO.Backup.Task.list'].task_list[0];
  f.responses['SYNO.Backup.Task.list'].task_list = [1, 2, 3, 4, 5, 6].map((i) => ({ ...base, task_id: i, name: `Aufgabe ${i}` }));
  const dsms = [0, 1, 2].map(() => fakeDsm(f));
  await withHost({ nas: dsms }, async (host) => {
    for (const i of [0, 1, 2]) await addNas(host, { name: `NAS ${i}`, target_index: i });
    const list = await host.quickActions(ADMIN);
    assert.equal(list.length, 16);
    assert.equal(list.filter((x) => x.id.startsWith('backup:1:')).length, 4);
  });
});

test('widget: storage used over all volumes, CPU / RAM / temperature, health badge, status line', async () => {
  const d = calm();
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const w = (await host.quickActions(ADMIN)).find((x) => x.id === `refresh:${id}`).widget;
    assert.deepEqual(w, {
      label: 'Speicher belegt', value: 60, unit: '%', status: 'Alles in Ordnung', state: 'good',
      readings: [
        { id: 'cpu', label: 'CPU', value: 14, unit: '%', icon: I.cpu, state: null },
        { id: 'ram', label: 'RAM', value: 31, unit: '%', icon: I.memory, state: null },
        { id: 'temp', label: 'Temperatur', value: 44, unit: '°C', icon: I.thermometer, state: null },
      ],
      controls: [], power: false,
      badge: { icon: I.shieldCheck, value: null, unit: null, state: 'good', label: 'Zustand' },
    });
    const en = (await host.quickActions(ADMIN, 'en')).find((x) => x.id === `refresh:${id}`).widget;
    assert.deepEqual([en.label, en.status, en.badge.label, en.readings[2].label], ['Storage used', 'All good', 'Health', 'Temperature']);
  });
});

test('widget: problems — degraded pool (warn) first, DSM temperature warning, CPU load, a pending update as information', async () => {
  const d71 = fakeDsm('dsm71.json');
  const hot = calm({ tempWarn: true, temp: 61, cpu: 95 });
  const upd = fakeDsm('dsm72.json');
  await withHost({ nas: [d71, hot, upd] }, async (host) => {
    const a = await addNas(host, { name: 'A', target_index: 0 });
    const b = await addNas(host, { name: 'B', target_index: 1 });
    const c = await addNas(host, { name: 'C', target_index: 2 });
    const list = await host.quickActions(ADMIN);
    const wa = list.find((x) => x.id === `refresh:${a}`).widget;
    assert.equal(wa.value, 92);
    assert.equal(wa.state, 'warn');
    assert.equal(wa.status, 'Speicherpool 1 beeinträchtigt'); // pools first, like the page
    assert.deepEqual(wa.badge, { icon: I.shieldAlert, value: null, unit: null, state: 'warn', label: 'Zustand' });
    assert.deepEqual(wa.readings.map((r) => [r.id, r.value]), [['cpu', 42], ['ram', 80], ['temp', 49]]);
    const wb = list.find((x) => x.id === `refresh:${b}`).widget;
    assert.deepEqual(wb.readings.map((r) => [r.id, r.value, r.state]), [['cpu', 95, 'warn'], ['ram', 31, null], ['temp', 61, 'warn']]);
    const wc = list.find((x) => x.id === `refresh:${c}`).widget;
    assert.deepEqual([wc.state, wc.status, wc.badge.state], ['good', 'DSM-Update verfügbar: DSM 7.2.2-72806 Update 2', 'good']);
    // a crashed pool outranks the warnings; an almost full volume is reported with its share
    const data = { volumes: [{ id: 'v1', name: 'Volume 1', status: 'normal', total: 100, used: 95, pct: 95 }], pools: [{ id: 'p1', num: 1, status: 'crashed' }], disks: [], backups: [] };
    const n = { id: 9, name: 'X', status: 'ok', error_count: 0 };
    const w = quick.widgetOf(n, data, cfg, t, 'de');
    assert.deepEqual([w.value, w.state, w.status], [95, 'crit', 'Speicherpool 1 abgestürzt']);
    data.pools = [];
    assert.equal(quick.widgetOf(n, data, cfg, t, 'de').status, 'Volume 1 zu 95 % belegt');
  });
});

test('widget: missing data — new, poll failing, unreachable (last storage kept, no live readings), restarting, shut down', () => {
  const data = { info: { temp: 40 }, util: { cpu: 5, ram: 20 }, volumes: [{ id: 'v1', name: 'Volume 1', status: 'normal', total: 200, used: 50, pct: 25 }] };
  const w = (n, d = data) => quick.widgetOf({ id: 1, name: 'K', status: 'ok', error_count: 0, power_state: null, ...n }, d, cfg, t, 'de');
  const fresh = w({ status: 'new' }, null);
  assert.deepEqual(fresh, {
    label: 'Speicher belegt', value: null, unit: null, status: 'Noch keine Daten', state: null, readings: [], controls: [], power: false,
    badge: { icon: I.shieldCheck, value: null, state: null, label: 'Zustand' },
  });
  // status ok but nothing stored (yet): no value, no readings, neutral
  assert.deepEqual([w({}, null).value, w({}, null).state, w({}, null).status], [null, null, 'Noch keine Daten']);
  // a volume without a size: no value
  assert.equal(w({}, { volumes: [{ id: 'v', name: 'V', status: 'normal', total: null, used: null }] }).value, null);
  const failing = w({ status: 'error', error_count: 1 });
  assert.deepEqual([failing.value, failing.state, failing.status, failing.readings], [25, 'warn', 'Letzte Abfrage fehlgeschlagen', []]);
  const down = w({ status: 'error', error_count: 3 });
  assert.deepEqual([down.value, down.state, down.status, down.badge.icon], [25, 'crit', 'Nicht erreichbar', I.shieldAlert]);
  assert.deepEqual([w({ status: 'auth' }).state, w({ status: 'auth' }).status], ['crit', 'Anmeldung fehlgeschlagen']);
  assert.deepEqual([w({ status: 'otp' }).state, w({ status: 'otp' }).status], ['crit', 'Code erforderlich']);
  assert.deepEqual([w({ power_state: 'reboot' }).state, w({ power_state: 'reboot' }).status], ['warn', 'Startet neu …']);
  assert.deepEqual([w({ power_state: 'shutdown', status: 'error', error_count: 5 }).state, w({ power_state: 'shutdown', status: 'error', error_count: 5 }).status], [null, 'Ausgeschaltet']);
});

test('refresh: polls now and answers with the new widget; a DSM error is the answer\'s message', async () => {
  const d = calm();
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const polls = d.state.calls.filter((c) => c.api === 'SYNO.Core.System.Utilization').length;
    d.state.fixture.responses['SYNO.Core.System.Utilization.get'].memory.real_usage = 77;
    const r = await host.runQuickAction(ADMIN, `refresh:${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.message, 'Keller ist aktualisiert.');
    assert.equal(r.body.widget.readings.find((x) => x.id === 'ram').value, 77);
    assert.equal(d.state.calls.filter((c) => c.api === 'SYNO.Core.System.Utilization').length, polls + 1);
    // the NAS does not answer: the error text, the widget with the last good storage value
    d.state.down = true;
    const bad = await host.runQuickAction(ADMIN, `refresh:${id}`);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.message, 'NAS nicht erreichbar (keine Verbindung).');
    assert.equal(bad.body.widget.value, 60);
    assert.equal(bad.body.widget.state, 'warn');
    assert.deepEqual(bad.body.widget.readings, []);
    // a long DSM text is shortened to its first sentence (≤ 120)
    d.state.down = false;
    d.state.error = { throw: netError('self signed certificate in certificate chain') };
    const tls = await host.runQuickAction(ADMIN, `refresh:${id}`);
    assert.equal(tls.body.ok, false);
    assert.equal(tls.body.message, 'HTTPS-Zertifikat nicht vertrauenswürdig (z. B. das selbstsignierte DSM-Zertifikat).');
    const en = await host.runQuickAction(ADMIN, `refresh:${id}`, 'en');
    assert.equal(en.body.message, 'HTTPS certificate not trusted (e.g. DSM’s self-signed certificate).');
  });
});

test('backup now: the task of the button, logged with the route; DSM error and an unknown task → message', async () => {
  const d = calm();
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const r = await host.runQuickAction(ADMIN, `backup:${id}:2`);
    assert.deepEqual(r, { status: 200, body: { ok: true, message: 'Sicherung „Cloud (C2)“ auf Keller gestartet.', state: null, widget: null, unchanged: false } });
    assert.deepEqual(d.state.backups, [2]);
    assert.ok(host.logs.some((l) => l.level === 'info' && /Hyper Backup task started 1 2 by admin \(App\)/.test(l.message)));
    const rule = await host.runQuickAction(ADMIN, `backup:${id}:1`, 'en', { automation: true, via: 'gatecontrol-familie' });
    assert.equal(rule.body.message, 'Backup “USB-Sicherung” started on Keller.');
    assert.ok(host.logs.some((l) => /Hyper Backup task started 1 1 by admin \(Regel\)/.test(l.message)));
    assert.deepEqual(d.state.backups, [2, 1]);
    // DSM refuses
    d.state.denied.add('SYNO.Backup.Task');
    const denied = await host.runQuickAction(ADMIN, `backup:${id}:1`);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.message, 'Dem DSM-Konto fehlen Administratorrechte.');
    d.state.denied.clear();
    d.state.down = true;
    const down = await host.runQuickAction(ADMIN, `backup:${id}:1`);
    assert.deepEqual([down.body.ok, down.body.message], [false, 'NAS nicht erreichbar (keine Verbindung).']);
    // a task the last status does not know (any more): refused by the page's check, nothing sent
    assert.deepEqual(await direct(host, ADMIN, `backup:${id}:99`), { ok: false, message: 'Nicht gefunden.' });
    assert.deepEqual(d.state.backups, [2, 1]);
  });
});

test('restart / shut down: the page\'s code path (log, "power" notice with the route), DSM error → message', async () => {
  const d = calm();
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const r = await host.runQuickAction(ADMIN, `reboot:${id}`);
    assert.deepEqual(r.body, { ok: true, message: 'Keller wird neu gestartet.', state: null, widget: null, unchanged: false });
    assert.deepEqual(d.state.power, ['reboot']);
    assert.ok(host.logs.some((l) => l.level === 'warn' && /NAS reboot requested 1 Keller by admin \(App\)/.test(l.message)));
    const p = host.notifications.filter((n) => n.topic === 'power');
    assert.equal(p.length, 1);
    assert.match(p[0].body, /angefordert von admin \(App\) in GateControl/);
    assert.equal((await nasRow(host, id)).power_state, 'reboot');
    // the widget follows: restarting
    const w = (await host.quickActions(ADMIN)).find((x) => x.id === `refresh:${id}`).widget;
    assert.deepEqual([w.state, w.status], ['warn', 'Startet neu …']);
    // never shut down from a rule (power on only at the device): refused, nothing sent
    const ruled = await host.runQuickAction(ADMIN, `shutdown:${id}`, 'de', { automation: true, via: 'gatecontrol-familie' });
    assert.deepEqual([ruled.body.ok, ruled.body.message], [false, 'Herunterfahren nur per Hand in der App – Einschalten geht nur am Gerät.']);
    assert.deepEqual(d.state.power, ['reboot']);
    // shut down from the app
    const s = await host.runQuickAction(ADMIN, `shutdown:${id}`);
    assert.deepEqual([s.body.ok, s.body.message], [true, 'Keller wird heruntergefahren. Einschalten nur am Gerät.']);
    assert.deepEqual(d.state.power, ['reboot', 'shutdown']);
    assert.ok(host.logs.some((l) => l.level === 'warn' && /NAS shutdown requested 1 Keller by admin \(App\)/.test(l.message)));
    assert.match(host.notifications.filter((n) => n.topic === 'power').at(-1).body, /angefordert von admin \(App\) in GateControl\. Einschalten nur am Gerät/);
    // the NAS does not answer: the message, nothing sent, no notice
    d.state.down = true;
    const notices = host.notifications.length;
    const bad = await host.runQuickAction(ADMIN, `reboot:${id}`);
    assert.deepEqual([bad.body.ok, bad.body.message], [false, 'NAS nicht erreichbar (keine Verbindung).']);
    assert.deepEqual(d.state.power, ['reboot', 'shutdown']);
    assert.equal(host.notifications.length, notices);
  });
});

test('runs: a disabled or deleted NAS, an unknown id, and an action still waiting for the NAS', async () => {
  const d = calm();
  let delay = 0;
  const slow = { ...d, fetch: async (p, o) => { if (delay) await settle(delay); return d.fetch(p, o); } };
  await withHost({ nas: [slow] }, async (host) => {
    const id = await addNas(host);
    assert.deepEqual(await direct(host, ADMIN, 'format:1'), { ok: false, message: 'Diese Aktion gibt es nicht mehr.' });
    assert.deepEqual(await direct(host, ADMIN, `reboot:${id + 5}`), { ok: false, message: 'Nicht gefunden.' });
    await asAdmin(host, 'PUT', `/nas/${id}`, { enabled: false });
    assert.deepEqual(await host.quickActions(ADMIN), []);
    assert.deepEqual(await direct(host, ADMIN, `shutdown:${id}`), { ok: false, message: 'Das NAS ist deaktiviert.' });
    assert.deepEqual(d.state.power, []);
    await asAdmin(host, 'PUT', `/nas/${id}`, { enabled: true });
    // the answer is due before GateControl gives up (10 s): "requested", the restart still happens
    host.plugin._setQuickActionBudgetForTest(0);
    delay = 20;
    try {
      const r = await direct(host, ADMIN, `reboot:${id}`);
      assert.deepEqual(r, { ok: true, message: 'Angefordert – Keller antwortet gerade langsam.' });
      assert.deepEqual(d.state.power, []);
      await settle(150);
      assert.deepEqual(d.state.power, ['reboot']);
    } finally { host.plugin._setQuickActionBudgetForTest(null); }
  });
});

test('Start tiles (apps): per enabled NAS "62 % belegt", items storage, temperature, health; state from the health', async () => {
  const ok = calm();
  const d71 = fakeDsm('dsm71.json');
  const gone = calm();
  await withHost({ nas: [ok, d71, gone] }, async (host) => {
    const a = await addNas(host, { name: 'Keller', target_index: 0 });
    await addNas(host, { name: 'Büro', target_index: 1 });
    const c = await addNas(host, { name: 'Dach', target_index: 2 });
    gone.state.down = true;
    await host.gc.db.run('UPDATE nas SET status = ?, error_count = 3 WHERE id = ?', ['error', c]);
    const tiles = await host.clientTiles(ADMIN);
    assert.deepEqual(tiles.map((x) => x.title), ['Büro', 'Dach', 'Keller']);
    const [buero, dach, keller] = tiles;
    assert.deepEqual(keller, {
      section: 'nas', title: 'Keller', value: '60 % belegt', unit: null, state: 'good', icon: I.nas,
      items: [
        { label: 'Speicher', value: 60, unit: '%', icon: I.storage, state: null },
        { label: 'Temperatur', value: 44, unit: '°C', icon: I.thermometer, state: null },
        { label: 'OK', value: null, unit: null, icon: I.shieldCheck, state: 'good' },
      ],
    });
    assert.deepEqual([buero.value, buero.state], ['92 % belegt', 'warn']);
    assert.deepEqual(buero.items.map((x) => [x.label, x.value, x.state]), [['Speicher', 92, 'warn'], ['Temperatur', 49, null], ['Warnung', null, 'warn']]);
    // unreachable: the last storage value stays, no live temperature, health red
    assert.deepEqual([dach.value, dach.state], ['60 % belegt', 'crit']);
    assert.deepEqual(dach.items.map((x) => [x.label, x.state]), [['Speicher', null], ['Nicht erreichbar', 'crit']]);
    const en = await host.clientTiles(ADMIN, 'en');
    assert.deepEqual([en[2].value, en[2].items.map((x) => x.label)], ['60 % used', ['Storage', 'Temperature', 'OK']]);
    // nothing for anyone else; a disabled NAS has no tile; a NAS without data shows its health as the value
    assert.deepEqual(await host.clientTiles(ADA), []);
    await asAdmin(host, 'PUT', `/nas/${a}`, { enabled: false });
    assert.equal((await host.clientTiles(ADMIN)).length, 2);
    const tile = quick.tileOf({ id: 4, name: 'Neu', status: 'new', error_count: 0 }, null, cfg, t, 'de');
    assert.deepEqual([tile.value, tile.state, tile.items], ['Neu', null, [{ label: 'Neu', icon: I.shieldCheck, state: null }]]);
  });
});

test('messages stay within what GateControl takes (≤ 120), a long text is cut at a sentence or a word', () => {
  for (const lang of ['de', 'en']) {
    for (const [k, v] of Object.entries(texts[lang])) {
      if (!/^(dsm|error|qa)\./.test(k)) continue;
      const s = quick.short(t(lang, k, { name: 'N'.repeat(40), task: 'T'.repeat(40) }));
      assert.ok(s.length <= 120 && s.length > 0, `${lang}.${k}: ${s}`);
      if (v.length <= 120 && !v.includes('{{')) assert.equal(s, v);
    }
  }
  assert.equal(quick.short('DSM leitet HTTP auf HTTPS um. Schalte ' + 'x'.repeat(200)), 'DSM leitet HTTP auf HTTPS um.');
  const cut = quick.short('wort '.repeat(40));
  assert.ok(cut.length <= 120 && cut.endsWith('wort…'));
});
