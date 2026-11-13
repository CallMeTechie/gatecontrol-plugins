'use strict';

// Writes of the background poll. GateControl's protocols (8. 11., 12./13. 11.): the snapshot upsert was the plugin's
// slow statement — every poll before 1.2.2, every 5 minutes with 1.2.2 (240–288 a day and NAS, up to 5 s on a slow
// disk), and as often "UPDATE nas SET … last_attempt_at = ?". Since 1.2.3 (server/store.js): the newest status and
// poll times are read from memory; the snapshot is stored when more than the live values changed, else once an
// hour, and when the plugin stops; the poll times go along with the next write of the row.

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server/service');
const store = require('../server/store');
const config = require('../server/config');
const { fakeDsm, withHost, asAdmin, addNas } = require('./helpers');

const MIN = 60000;
const HOUR = 60 * MIN;
const snapWrites = (host) => host.dbWrites.filter((w) => /INTO snapshots/.test(w.sql || '')).length;
const nasWrites = (host) => host.dbWrites.filter((w) => /UPDATE nas/.test(w.sql || '')).length;
const storedSnap = async (host, id) => {
  const { row } = await host.gc.db.get('SELECT data, fetched_at FROM snapshots WHERE nas_id = ?', [id]);
  return row ? { data: JSON.parse(row.data), fetched_at: Number(row.fetched_at) } : null;
};
const due = (host, id) => store.updateNas(host.gc, id, { next_poll_at: 0 });

/** The live values of a NAS as they move from poll to poll: uptime, temperatures, CPU, RAM, bytes used, UPS. */
function live(d, i, { usedPerPoll = 0 } = {}) {
  const r = d.fixture.responses;
  r['SYNO.DSM.Info.getinfo'].uptime = 1123200 + i * 120;
  r['SYNO.DSM.Info.getinfo'].temperature = 42 + (i % 5);
  r['SYNO.Core.System.Utilization.get'].cpu.user_load = 5 + (i * 7) % 60;
  r['SYNO.Core.System.Utilization.get'].memory.real_usage = 30 + (i * 3) % 40;
  const st = r['SYNO.Storage.CGI.Storage.load_info'];
  st.disks.forEach((x, k) => { x.temp = 35 + ((i + k) % 6); });
  st.volumes[0].size.used = String(6907128235622 + i * usedPerPoll);
  r['SYNO.Core.ExternalDevice.UPS.get'].runtime = 1900 + (i % 9) * 10;
}

test('a day of polls every 2 minutes with moving live values: 30 snapshot writes at most instead of 240, the poll times with the row; every poll is read', async (t) => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const cfg = await config.load(host.gc);
    assert.equal(cfg.interval, 120, 'the default interval');
    const t0 = Date.now() + MIN;
    const polls = 24 * 30;
    const sizes = [];
    // what 1.2.2 stored: the snapshot and the poll times whenever the last write was 5 minutes ago
    let before = 0;
    let last122 = -Infinity;
    const first = await storedSnap(host, id); // the poll of "add"
    const uptimeAt = new Map([[first.fetched_at, first.data.info.uptime_s]]);
    host.resetDbWrites();
    for (let i = 0; i < polls; i++) {
      const now = t0 + i * 2 * MIN;
      // 150 GB more over the day (1.3 points of the volume); a Hyper Backup run at 03:00
      live(d, i, { usedPerPoll: Math.round(150e9 / polls) });
      const task = d.fixture.responses['SYNO.Backup.Task.list'].task_list[0];
      if (i === 90) task.status = 'backup';
      if (i === 110) { task.status = 'none'; task.last_bkp_time = '2026/10/13 03:00'; task.last_bkp_end_time = '2026/10/13 03:40'; task.next_bkp_time = '2026/10/14 03:00'; }
      const r = await service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now });
      assert.equal(r.ok, true, JSON.stringify(r));
      if (now - last122 >= 5 * MIN) { before++; last122 = now; }
      const n = await store.getNas(host.gc, id);
      assert.equal(n.last_success_at, now, 'the newest poll time is read');
      assert.equal(n.next_poll_at, now + 2 * MIN);
      uptimeAt.set(now, 1123200 + i * 120);
      const snap = await store.getSnapshot(host.gc, id);
      assert.equal(snap.fetched_at, now, 'the newest snapshot is read');
      assert.equal(snap.data.info.uptime_s, 1123200 + i * 120, 'with the live values of this poll');
      assert.equal((await store.allSnapshots(host.gc)).get(id).fetched_at, now);
      if (i === 0) sizes.push(JSON.stringify(snap.data).length);
      // what is stored is never older than an hour and never claims another time than its own
      const disk = await storedSnap(host, id);
      assert.ok(now - disk.fetched_at < HOUR, `stored ${Math.round((now - disk.fetched_at) / MIN)} min ago`);
      assert.equal(disk.data.info.uptime_s, uptimeAt.get(disk.fetched_at), 'stored values belong to the stored time');
    }
    const snaps = snapWrites(host);
    const nas = nasWrites(host);
    assert.equal(before, 240, '1.2.2 at this interval: 240 snapshot writes and as many of the poll times (288 with 60 s)');
    // 24 hourly ones, the backup run (start, end), the volume one point fuller
    assert.ok(snaps >= 24 && snaps <= 30, `snapshot writes ${snaps} (1.2.2: ${before})`);
    // the first poll after the manual one, the update check every 6 h
    assert.ok(nas <= 6, `nas writes ${nas} (1.2.2: ${before})`);
    assert.equal(host.dbWrites.filter((w) => w.kind === 'kv.set' || w.kind === 'settings.set').length, 0, 'no notification state, no setting');
    assert.ok(host.dbWrites.length <= 36, `all writes of the day: ${host.dbWrites.length} (1.2.2: ${2 * before})`);
    assert.ok(sizes[0] > 1500, `a snapshot is ${sizes[0]} characters`);
    t.diagnostic(`writes of the day: snapshots ${snaps}, nas ${nas}, all ${host.dbWrites.length} — 1.2.2: ${before} + ${before}; a snapshot: ${sizes[0]} characters`);
  });
});

test('live values alone write nothing; a status, a threshold of the settings, a fuller volume, a backup result write at once', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const cfg = await config.load(host.gc);
    let now = Date.now() + MIN;
    const poll = async () => {
      now += 2 * MIN;
      host.resetDbWrites();
      const r = await service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now });
      assert.equal(r.ok, true, JSON.stringify(r));
      return snapWrites(host);
    };
    const st = d.fixture.responses['SYNO.Storage.CGI.Storage.load_info'];
    await poll();
    for (let i = 1; i <= 5; i++) {
      live(d, i);
      assert.equal(await poll(), 0, 'CPU, RAM, temperatures, uptime');
      assert.equal(host.dbWrites.length, 0, 'nothing at all');
    }
    // a drive at the threshold of the settings (55 °C): the page flags it
    st.disks[1].temp = 55;
    assert.equal(await poll(), 1, 'drive too hot');
    assert.equal((await storedSnap(host, id)).data.disks[1].temp, 55);
    st.disks[1].temp = 56;
    assert.equal(await poll(), 0, 'still hot, one degree more');
    st.disks[1].temp = 40;
    assert.equal(await poll(), 1, 'cool again');
    // storage status
    st.storagePools[0].status = 'degraded';
    assert.equal(await poll(), 1, 'pool degraded');
    assert.equal((await storedSnap(host, id)).data.pools[0].status, 'degraded');
    st.storagePools[0].status = 'normal';
    assert.equal(await poll(), 1, 'pool healthy again');
    st.disks[0].smart_status = 'warning';
    assert.equal(await poll(), 1, 'drive health');
    st.disks[0].smart_status = 'normal';
    assert.equal(await poll(), 1);
    // the volume: half a point more is a live value, a whole point is stored
    const total = 11511880392704;
    st.volumes[0].size.used = String(Math.round(total * 0.605));
    assert.equal(await poll(), 0, 'half a point');
    st.volumes[0].size.used = String(Math.round(total * 0.611));
    assert.equal(await poll(), 1, 'a point since the stored one');
    st.volumes[0].size.used = String(Math.round(total * 0.905));
    assert.equal(await poll(), 1, 'almost full');
    st.volumes[0].size.used = String(Math.round(total * 0.6));
    assert.equal(await poll(), 1);
    // backup result, DSM version, UPS on battery
    d.fixture.responses['SYNO.Backup.Task.list'].task_list[1].last_bkp_result = 'failed';
    assert.equal(await poll(), 1, 'backup failed');
    d.fixture.responses['SYNO.DSM.Info.getinfo'].version_string = 'DSM 7.2.2-72806';
    assert.equal(await poll(), 1, 'DSM version');
    d.fixture.responses['SYNO.Core.ExternalDevice.UPS.get'].status = 'usb_ups_status_onbatt';
    assert.equal(await poll(), 1, 'UPS on battery');
    d.fixture.responses['SYNO.Core.ExternalDevice.UPS.get'].charge = 80;
    assert.equal(await poll(), 0, 'charge is a live value');
    // a stricter threshold in the settings: what the page flags changes
    assert.equal(await service.poll(host.gc, await store.getNas(host.gc, id), { ...cfg, fullPct: 55 }, { now: now + MIN }).then(() => snapWrites(host)), 1, 'threshold changed');
    // a failed poll: status and error at once, with the poll times kept so far
    d.state.down = true;
    now += 10 * MIN;
    host.resetDbWrites();
    await service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now });
    assert.equal(nasWrites(host), 1);
    const row = (await host.gc.db.get('SELECT status, last_success_at, last_attempt_at FROM nas WHERE id = ?', [id])).row;
    assert.equal(row.status, 'error');
    assert.equal(row.last_attempt_at, now);
    assert.equal(row.last_success_at, now - 9 * MIN, 'the last good poll, stored with the error');
  });
});

test('restart: the stored status with its own time until the next poll, which is due at once; a stop stores the newest', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const cfg = await config.load(host.gc);
    const view = async () => (await asAdmin(host, 'GET', '/status')).json.nas[0];
    const first = await storedSnap(host, id); // the poll of "add": stored
    const t0 = first.fetched_at + MIN;
    let last = 0;
    for (let i = 0; i < 20; i++) {
      live(d, i + 1);
      last = t0 + i * 2 * MIN;
      await service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now: last });
    }
    const liveView = await view();
    assert.equal(liveView.fetched_at, last);
    assert.equal(liveView.last_success_at, last);

    // a crash (nothing flushed): the stored status, 39 minutes old — and said so
    host.resetDbWrites();
    store._forget(host.gc);
    let v = await view();
    assert.equal(v.status, 'ok');
    assert.equal(v.fetched_at, first.fetched_at, 'the time the stored status was fetched');
    assert.equal(v.last_success_at, first.fetched_at, '"updated" is that time, never a newer one');
    assert.equal(v.data.info.model, 'DS920+');
    assert.deepEqual(v.data, first.data, 'the values of that poll');
    assert.equal(v.data.volumes.length, 1);
    assert.deepEqual(v.issues, liveView.issues, 'what the page flags is as it was');
    const n = await store.getNas(host.gc, id);
    assert.ok(n.enabled && n.next_poll_at <= last, 'the stored time of the next poll is long past: due at the first tick');
    // … which polls (unchanged status, stored less than an hour ago: no snapshot write)
    const poll = async (now) => service.poll(host.gc, await store.getNas(host.gc, id), cfg, { now });
    await poll(last + 2 * MIN);
    v = await view();
    assert.equal(v.fetched_at, last + 2 * MIN, 'the new poll');
    assert.equal(v.last_success_at, last + 2 * MIN);
    assert.equal(snapWrites(host), 0);

    // a regular stop stores the newest status and poll times
    live(d, 77);
    await poll(last + 4 * MIN);
    const newest = await view();
    assert.equal(newest.fetched_at, last + 4 * MIN);
    assert.equal((await storedSnap(host, id)).fetched_at, first.fetched_at, 'not stored yet');
    host.resetDbWrites();
    await host.stop();
    assert.equal(snapWrites(host), 1);
    assert.equal(nasWrites(host), 1);
    store._forget(host.gc);
    v = await view();
    assert.equal(v.fetched_at, newest.fetched_at);
    assert.equal(v.last_success_at, newest.last_success_at);
    assert.deepEqual(v.data, newest.data);
    assert.equal((await store.getNas(host.gc, id)).next_poll_at, newest.next_poll_at);
    host.resetDbWrites();
    await host.stop();
    assert.equal(host.dbWrites.length, 0, 'nothing new: nothing written');
  });
});

test('down right after a crash: the last good status stays, "last reachable" is its time', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const view = async () => (await asAdmin(host, 'GET', '/status')).json.nas[0];
    // an older row: the poll times were last written long ago, the snapshot later
    const stored = (await view()).fetched_at;
    await host.gc.db.run('UPDATE nas SET last_success_at = ?, next_poll_at = ? WHERE id = ?', [stored - 5 * HOUR, stored - 5 * HOUR, id]);
    store._forget(host.gc);
    require('../server/alerts').reset();
    d.state.down = true;
    for (let i = 0; i < 3; i++) { await host.tick(); await due(host, id); }
    const down = host.notifications.filter((x) => x.topic === 'unreachable');
    assert.equal(down.length, 1);
    const when = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    assert.ok(JSON.stringify(down[0]).includes(when(stored)), 'last reachable: ' + JSON.stringify(down[0].card || down[0]));
    assert.ok(!JSON.stringify(down[0]).includes(when(stored - 5 * HOUR)));
    const v = await view();
    assert.equal(v.status, 'error');
    assert.equal(v.last_success_at, stored, 'the time of the stored status, not the older row');
    assert.equal(v.fetched_at, stored);
    assert.equal(v.data.info.model, 'DS920+', 'the last good status stays');
  });
});

test('notifications as before: at the poll that sees it, also when nothing was stored in between', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    const st = d.fixture.responses['SYNO.Storage.CGI.Storage.load_info'];
    const topics = () => host.notifications.map((x) => x.topic);
    const step = async (i) => { live(d, i); await due(host, id); await host.tick(); };
    host.resetDbWrites();
    for (let i = 1; i <= 6; i++) await step(i);
    assert.deepEqual(topics(), [], 'live values: no notification');
    assert.equal(snapWrites(host), 0);
    // temperature: 54 °C is a live value (nothing stored), 55 °C is announced by the very next poll
    await step(7); st.disks[2].temp = 54; await due(host, id); await host.tick();
    assert.deepEqual(topics(), []);
    assert.equal(snapWrites(host), 0);
    st.disks[2].temp = 55; await due(host, id); await host.tick();
    assert.deepEqual(topics(), ['disk']);
    assert.equal(snapWrites(host), 1);
    // volume almost full, pool degraded, drive failing, backup failed — each at its poll
    st.volumes[0].size.used = String(Math.round(11511880392704 * 0.93)); await due(host, id); await host.tick();
    assert.deepEqual(topics(), ['disk', 'storage']);
    st.storagePools[0].status = 'degraded'; await due(host, id); await host.tick();
    assert.deepEqual(topics(), ['disk', 'storage', 'storage']);
    st.disks[0].smart_status = 'failing'; await due(host, id); await host.tick();
    assert.deepEqual(topics(), ['disk', 'storage', 'storage', 'disk']);
    const task = d.fixture.responses['SYNO.Backup.Task.list'].task_list[0];
    task.last_bkp_result = 'failed'; task.last_bkp_end_time = '2026/10/13 03:41'; await due(host, id); await host.tick();
    assert.deepEqual(topics(), ['disk', 'storage', 'storage', 'disk', 'backup']);
    // a restart neither repeats nor loses: the state of the notifications is stored when it changes (gc.storage)
    store._forget(host.gc);
    require('../server/alerts').reset();
    await due(host, id); await host.tick();
    assert.equal(topics().length, 5, 'nothing twice');
    st.storagePools[0].status = 'normal'; await due(host, id); await host.tick();
    assert.equal(topics().length, 6, 'pool healthy again');
    // unreachable after 3 failed polls, reachable again
    d.state.down = true;
    for (let i = 0; i < 3; i++) { await due(host, id); await host.tick(); }
    assert.equal(topics().at(-1), 'unreachable');
    d.state.down = false;
    await due(host, id); await host.tick();
    assert.equal(topics().filter((x) => x === 'unreachable').length, 2);
  });
});
