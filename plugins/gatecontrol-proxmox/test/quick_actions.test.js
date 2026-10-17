'use strict';

// Quick actions, widgets and the Start tile of the GateControl apps
// (server/quick.js): administrators only, per connection a refresh button
// carrying the connection's widget, per watched guest a start / shutdown
// toggle (target states, asks before shutting down only) and a reboot
// button, the runs through the page's control code and log — never a hard stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const control = require('../server/control');
const quick = require('../server/quick');
const store = require('../server/store');
const { withHost, asAdmin, addHost, ADA, ADMIN } = require('./helpers');

control.timing.pollMs = 1;
control.timing.waitMs = 200;

const APP_ADMIN = { ...ADMIN, loggedIn: true, app: true };
const watch = (host, id, vmid) => asAdmin(host, 'PUT', `/hosts/${id}/guests/${vmid}/watch`, { watched: true });
const posts = (fake) => fake.calls.filter((c) => c.method === 'POST').map((c) => c.path.replace('/api2/json', ''));
const byId = (list, id) => list.find((a) => a.id === id);

/** A connection polled once with the guests 100 (web, running) and 101 (db, stopped) watched. */
async function setup(host, extra) {
  const id = await addHost(host, extra);
  await watch(host, id, 100);
  await watch(host, id, 101);
  return id;
}

test('visibility: administrators only — no actions, no tile and no portal for anybody else', async () => {
  await withHost({}, async (host) => {
    const id = await setup(host);
    assert.deepEqual(await host.quickActions(ADA), []);
    assert.deepEqual(await host.clientTiles(ADA), []);
    assert.equal((await host.runQuickAction(ADA, `guest:${id}:100`)).status, 404);
    assert.equal((await host.runQuickAction(ADA, `refresh:${id}`, 'de', { automation: true, via: 'gatecontrol-familie' })).status, 404);
    // the web portal's Start tab gets no tile, not even for an administrator
    assert.deepEqual(await host.portalTiles(ADMIN), []);
    assert.equal(await host.portalVisible(ADMIN), false);
    assert.ok((await host.quickActions(ADMIN)).length > 0);
    assert.equal((await host.clientTiles(ADMIN)).length, 1);
    assert.equal(await host.portalVisible(APP_ADMIN), true);
    // the run checks the administrator again (also when called past the host's listing)
    const r = await host.plugin.runQuickAction({ user: { ...ADA, app: true }, lang: 'de', id: `guest:${id}:100` }, host.gc);
    assert.deepEqual(r, { ok: false, message: 'Nur für Administratoren.' });
    assert.equal(host.pve.calls.filter((c) => c.method === 'POST').length, 0);
  });
});

test('listing: per connection a refresh button with its device, per watched guest a toggle and a reboot button', async () => {
  await withHost({}, async (host) => {
    const id = await setup(host);
    await watch(host, id, 9000); // a template: nothing to switch
    await watch(host, id, 555);  // unknown to Proxmox: left out
    const list = await host.quickActions(ADMIN);
    assert.deepEqual(list.map((a) => a.id), [`refresh:${id}`, `guest:${id}:100`, `reboot:${id}:100`, `guest:${id}:101`, `reboot:${id}:101`]);

    const r = byId(list, `refresh:${id}`);
    assert.equal(r.kind, 'button');
    assert.equal(r.title, 'Aktualisieren');
    assert.equal(r.confirm, false);
    assert.deepEqual(r.device, { id: `host:${id}`, title: 'Homelab', subtitle: 'Proxmox VE · homelab', icon: quick.ICONS.server });

    const g = byId(list, `guest:${id}:100`);
    assert.equal(g.kind, 'toggle');
    assert.equal(g.title, 'web');
    assert.equal(g.subtitle, 'VM 100 · Homelab');
    assert.equal(g.state, 'on');
    assert.equal(g.confirm, true);
    assert.equal(g.confirmWhen, 'off', 'asks before shutting down only');
    assert.deepEqual(g.verbs, { on: 'Starten', off: 'Herunterfahren' });
    assert.equal(g.targets, true);
    assert.deepEqual(g.look, { on: { icon: quick.ICONS.play, tone: 'good' }, off: { icon: quick.ICONS.stop, tone: 'neutral' } });
    assert.deepEqual(g.device, { id: `vm:${id}:100`, title: 'web', subtitle: 'VM 100 · Homelab', icon: quick.ICONS.qemu });
    assert.equal(byId(list, `guest:${id}:101`).state, 'off');

    const b = byId(list, `reboot:${id}:100`);
    assert.equal(b.kind, 'button');
    assert.equal(b.title, 'Neustart');
    assert.equal(b.confirm, true);
    assert.equal(b.widget, null);
    assert.deepEqual(b.device, g.device);

    // English
    const en = await host.quickActions(ADMIN, 'en');
    assert.equal(byId(en, `refresh:${id}`).title, 'Refresh');
    assert.deepEqual(byId(en, `guest:${id}:100`).verbs, { on: 'Start', off: 'Shut down' });
    assert.equal(byId(en, `reboot:${id}:100`).title, 'Reboot');
  });
});

test('listing: a disabled connection is left out; at most 16 actions, a guest never without its reboot button', async () => {
  await withHost({}, async (host, fake) => {
    for (let i = 0; i < 10; i++) {
      fake.fx.cluster_resources.push({ id: `qemu/${300 + i}`, type: 'qemu', vmid: 300 + i, node: 'pve1', name: `vm${i}`, status: 'stopped', template: 0, cpu: 0, maxcpu: 1, mem: 0, maxmem: 1073741824, uptime: 0 });
    }
    const id = await setup(host);
    for (let i = 0; i < 10; i++) await watch(host, id, 300 + i);
    const list = await host.quickActions(ADMIN);
    assert.equal(list.length, 15, '1 refresh + 7 guests × 2');
    for (const a of list.filter((x) => x.id.startsWith('guest:'))) assert.ok(byId(list, a.id.replace('guest:', 'reboot:')), a.id);

    await asAdmin(host, 'PUT', `/hosts/${id}`, { enabled: false });
    assert.deepEqual(await host.quickActions(ADMIN), []);
    assert.deepEqual(await host.clientTiles(APP_ADMIN), []);
  });
});

test('widget of a connection: guests running, CPU / RAM / storage of the cluster, reachability badge, problems as status', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    const w = byId(await host.quickActions(ADMIN), `refresh:${id}`).widget;
    assert.deepEqual(w, {
      label: 'Gäste aktiv', value: '2/3', unit: null, status: null, state: 'good',
      readings: [
        { id: 'cpu', label: 'CPU', value: 5, unit: '%', icon: quick.ICONS.cpu, state: null },
        { id: 'ram', label: 'RAM', value: 35, unit: '%', icon: quick.ICONS.memory, state: null },
        { id: 'storage', label: 'Speicher', value: 60, unit: '%', icon: quick.ICONS.disk, state: null },
      ],
      controls: [], power: false,
      badge: { icon: quick.ICONS.server, value: null, unit: null, state: 'good', label: 'Erreichbar' },
    });

    // a node offline
    fake.fx.cluster_resources.find((r) => r.id === 'node/pve2').status = 'offline';
    fake.fx.cluster_status.find((r) => r.name === 'pve2').online = 0;
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    let x = byId(await host.quickActions(ADMIN), `refresh:${id}`).widget;
    assert.equal(x.status, 'Node pve2 offline');
    assert.equal(x.state, 'warn');
    assert.equal(x.badge.state, 'good');

    // a storage at the threshold
    await host.gc.settings.set('storage_threshold', 70);
    fake.fx.cluster_resources.find((r) => r.id === 'node/pve2').status = 'online';
    fake.fx.cluster_status.find((r) => r.name === 'pve2').online = 1;
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    x = byId(await host.quickActions(ADMIN), `refresh:${id}`).widget;
    assert.equal(x.status, 'Speicher local-lvm zu 75 % belegt');
    assert.equal(x.state, 'warn');
    assert.equal(x.readings.find((r) => r.id === 'storage').state, 'warn');

    // unreachable: the last good values stay, red badge, the reason as status
    fake.down = true;
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    x = byId(await host.quickActions(ADMIN), `refresh:${id}`).widget;
    assert.equal(x.value, '2/3');
    assert.equal(x.state, 'crit');
    assert.equal(x.status, 'Proxmox nicht erreichbar.');
    assert.deepEqual(x.badge, { icon: quick.ICONS.server, value: null, unit: null, state: 'crit', label: 'Nicht erreichbar' });
  });
});

test('widget of a guest: CPU as the value, RAM and uptime, on/off as the switch, no badge', async () => {
  await withHost({}, async (host) => {
    const id = await setup(host);
    const list = await host.quickActions(ADMIN);
    assert.deepEqual(byId(list, `guest:${id}:100`).widget, {
      label: 'CPU', value: 3, unit: '%', status: 'Läuft · pve1', state: 'on',
      readings: [
        { id: 'ram', label: 'RAM', value: 38, unit: '%', icon: quick.ICONS.memory, state: null },
        { id: 'uptime', label: 'Laufzeit', value: '4 T', unit: null, icon: quick.ICONS.clock, state: null },
      ],
      controls: [], power: true, badge: null,
    });
    const off = byId(list, `guest:${id}:101`).widget;
    assert.equal(off.value, null);
    assert.deepEqual(off.readings, []);
    assert.equal(off.status, 'Gestoppt');
    assert.equal(off.state, 'off');
    assert.equal(byId(await host.quickActions(ADMIN, 'en'), `guest:${id}:100`).widget.readings[1].value, '4 d');
  });
  const t = (lang, key, p) => `${p.n} ${key}`;
  assert.equal(quick.uptimeText(59, t, 'de'), '1 uptime.min');
  assert.equal(quick.uptimeText(7200, t, 'de'), '2 uptime.h');
  assert.equal(quick.uptimeText(0, t, 'de'), null);
});

test('toggle, plain run: a running guest is shut down cleanly, a stopped one started; logged with the admin and „App“', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    let r = await host.runQuickAction(ADMIN, `guest:${id}:100`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.state, 'off');
    assert.equal(r.body.message, 'web heruntergefahren.');
    assert.equal(r.body.widget.state, 'off');
    assert.deepEqual(posts(fake), ['/nodes/pve1/qemu/100/status/shutdown']);
    assert.ok(host.logs.some((l) => l.level === 'info' && /proxmox action #1 shutdown qemu\/100 on pve1 connection 1 by admin via App/.test(l.message)));
    const a = (await store.recentActions(host.gc, 1))[0];
    assert.equal(a.user_name, 'admin (App)');
    assert.equal(a.user_id, ADMIN.id);
    // until the next poll the list shows the outcome
    assert.equal(byId(await host.quickActions(ADMIN), `guest:${id}:100`).state, 'off');

    fake.calls.length = 0;
    r = await host.runQuickAction(ADMIN, `guest:${id}:101`);
    assert.equal(r.body.state, 'on');
    assert.equal(r.body.message, 'db gestartet.');
    assert.deepEqual(posts(fake), ['/nodes/pve1/qemu/101/status/start']);
  });
});

test('toggle with a target: start unless running, shut down unless stopped — else nothing to do', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    let r = await host.runQuickAction(ADMIN, `guest:${id}:100`, 'de', { state: 'on' });
    assert.deepEqual([r.body.ok, r.body.state, r.body.message, r.body.unchanged], [true, 'on', 'web läuft bereits.', false]);
    r = await host.runQuickAction(ADMIN, `guest:${id}:101`, 'de', { state: 'off' });
    assert.deepEqual([r.body.ok, r.body.state, r.body.message], [true, 'off', 'db ist bereits aus.']);
    assert.deepEqual(posts(fake), [], 'no change for a guest already there');
    assert.equal((await store.recentActions(host.gc, 5)).length, 0);

    r = await host.runQuickAction(ADMIN, `guest:${id}:101`, 'de', { state: 'on' });
    assert.deepEqual([r.body.ok, r.body.state, r.body.message], [true, 'on', 'db gestartet.']);
    r = await host.runQuickAction(ADMIN, `guest:${id}:100`, 'en', { state: 'off' });
    assert.deepEqual([r.body.ok, r.body.state, r.body.message], [true, 'off', 'web shut down.']);
    assert.deepEqual(posts(fake), ['/nodes/pve1/qemu/101/status/start', '/nodes/pve1/qemu/100/status/shutdown']);
  });
});

test('toggle from another plugin\'s rule: logged as „Regel“; a rule of a non-admin finds nothing', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    const r = await host.runQuickAction(ADMIN, `guest:${id}:101`, 'de', { automation: true, via: 'gatecontrol-familie', state: 'on' });
    assert.equal(r.body.ok, true);
    assert.equal((await store.recentActions(host.gc, 1))[0].user_name, 'admin (Regel)');
    assert.ok(host.logs.some((l) => /by admin via Regel/.test(l.message)));
    assert.equal((await host.runQuickAction(ADA, `guest:${id}:100`, 'de', { automation: true, via: 'gatecontrol-familie', state: 'off' })).status, 404);
    assert.deepEqual(posts(fake), ['/nodes/pve1/qemu/101/status/start']);
  });
});

test('reboot: a running guest is rebooted cleanly; a stopped one says why not', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    let r = await host.runQuickAction(ADMIN, `reboot:${id}:100`);
    assert.deepEqual([r.body.ok, r.body.state, r.body.message], [true, null, 'web neu gestartet.']);
    assert.equal(r.body.widget.state, 'on');
    r = await host.runQuickAction(ADMIN, `reboot:${id}:101`);
    assert.deepEqual([r.body.ok, r.body.message], [false, 'db läuft nicht – ein Neustart ist nicht möglich.']);
    assert.deepEqual(posts(fake), ['/nodes/pve1/qemu/100/status/reboot']);
  });
});

test('a long task: the answer says it runs, the list shows where it is heading; a slow Proxmox answers „sent“', async () => {
  await withHost({ pveOpts: { taskPolls: 1000 } }, async (host, fake) => {
    const id = await setup(host);
    const r = await host.runQuickAction(ADMIN, `guest:${id}:100`);
    assert.deepEqual([r.body.ok, r.body.state, r.body.message], [true, 'off', 'web wird heruntergefahren …']);
    const g = byId(await host.quickActions(ADMIN), `guest:${id}:100`);
    assert.equal(g.state, 'off');
    assert.equal(g.widget.status, 'Wird heruntergefahren …');
    assert.equal(g.widget.value, null);

    // Proxmox answers slowly: the answer does not wait for it
    const fetch = fake.fetch;
    fake.fetch = async (p, o) => { await new Promise((res) => setTimeout(res, 30)); return fetch(p, o); };
    quick._setBudgetForTest(0);
    try {
      const p = await host.runQuickAction(ADMIN, `guest:${id}:101`);
      assert.deepEqual([p.body.ok, p.body.state, p.body.message], [true, null, 'db: Auftrag an Proxmox gesendet, das Ergebnis steht gleich in der Liste.']);
      const q = await host.runQuickAction(ADMIN, `refresh:${id}`);
      assert.deepEqual([q.body.ok, q.body.message], [true, 'Homelab wird abgefragt – das Ergebnis folgt gleich.']);
      await new Promise((res) => setTimeout(res, 400)); // let the runs finish before the host closes
    } finally { quick._setBudgetForTest(null); }
  });
});

test('errors: a failed task, Proxmox unreachable, missing rights — clear messages, never a hard stop', async () => {
  await withHost({ pveOpts: { taskExit: "can't lock file '/var/lock/qemu-server/lock-100.conf' - got timeout" } }, async (host, fake) => {
    const id = await setup(host);
    let r = await host.runQuickAction(ADMIN, `guest:${id}:100`);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.state, null);
    assert.equal(r.body.message, "web: Herunterfahren fehlgeschlagen – can't lock file '/var/lock/qemu-server/lock-100.conf' - got timeout");
    assert.equal(byId(await host.quickActions(ADMIN), `guest:${id}:100`).state, 'on', 'a failed action changes nothing');

    fake.fail = (p, o) => (o.method === 'POST' ? { status: 403 } : undefined);
    r = await host.runQuickAction(ADMIN, `guest:${id}:101`);
    assert.deepEqual([r.body.ok, r.body.message], [false, 'Fehlende Rechte – dem Token PVEAuditor auf / bzw. VM.PowerMgmt auf /vms geben.']);
    fake.fail = null;

    fake.down = true;
    r = await host.runQuickAction(ADMIN, `guest:${id}:100`, 'en');
    assert.deepEqual([r.body.ok, r.body.message], [false, 'Proxmox not reachable.']);
    r = await host.runQuickAction(ADMIN, `refresh:${id}`);
    assert.deepEqual([r.body.ok, r.body.message], [false, 'Homelab: Proxmox nicht erreichbar.']);
    assert.equal(r.body.widget.badge.state, 'crit');
    assert.ok(!fake.calls.some((c) => /\/status\/stop$/.test(c.path)), 'never a hard stop');
  });
});

test('refresh: polls the connection now and answers with the fresh widget', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    fake.fx.cluster_resources.find((r) => r.vmid === 101).status = 'running';
    fake.calls.length = 0;
    const r = await host.runQuickAction(ADMIN, `refresh:${id}`);
    assert.deepEqual([r.body.ok, r.body.state, r.body.message], [true, null, 'Homelab aktualisiert.']);
    assert.equal(r.body.widget.value, '3/3');
    assert.ok(fake.calls.some((c) => c.path.startsWith('/api2/json/cluster/resources')));
    assert.equal(byId(await host.quickActions(ADMIN), `guest:${id}:101`).state, 'on');
  });
});

test('Start tile of the apps: „Proxmox“ over every connection, items guests / CPU / RAM / storage, colour from problems', async () => {
  await withHost({}, async (host, fake) => {
    const id = await setup(host);
    assert.deepEqual(await host.clientTiles(APP_ADMIN), [{
      section: null, title: 'Proxmox', value: '2/3 aktiv', unit: null, state: 'good', icon: quick.ICONS.server,
      items: [
        { label: 'Gäste', value: '2/3', unit: null, icon: quick.ICONS.guests, state: null },
        { label: 'CPU', value: 5, unit: '%', icon: quick.ICONS.cpu, state: null },
        { label: 'RAM', value: 35, unit: '%', icon: quick.ICONS.memory, state: null },
        { label: 'Speicher', value: 60, unit: '%', icon: quick.ICONS.disk, state: null },
      ],
    }]);
    assert.equal((await host.clientTiles(APP_ADMIN, 'en'))[0].value, '2/3 running');
    fake.down = true;
    await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    const [tile] = await host.clientTiles(APP_ADMIN);
    assert.equal(tile.state, 'crit');
    assert.equal(tile.value, '2/3 aktiv', 'the last good values stay');
    assert.deepEqual(await host.clientTiles({ ...ADA, loggedIn: true, app: true }), []);
  });
});
