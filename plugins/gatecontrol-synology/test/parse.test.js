'use strict';

// Adapters (server/parse.js) against synthetic DSM answers in the shapes of
// DSM 7.2, 7.1 and 6.2 (test/fixtures), plus the status mappings.

const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../server/parse');
const { fixture } = require('./helpers');

const R72 = fixture('dsm72.json').responses;
const R71 = fixture('dsm71.json').responses;
const R62 = fixture('dsm62.json').responses;

test('DSM 7.2: SYNO.DSM.Info getinfo, Utilization, Storage load_info', () => {
  assert.deepEqual(parse.dsmInfo(R72['SYNO.DSM.Info.getinfo']), {
    model: 'DS920+', dsm: 'DSM 7.2.1-69057 Update 5', build: '69057', uptime_s: 1123200, temp: 44, temp_warn: false, ram_mb: 4096,
  });
  assert.deepEqual(parse.utilization(R72['SYNO.Core.System.Utilization.get']), { cpu: 14, ram: 31 });
  const st = parse.storage(R72['SYNO.Storage.CGI.Storage.load_info']);
  assert.equal(st.source, 'storage');
  assert.equal(st.volumes.length, 1);
  const v = st.volumes[0];
  assert.equal(v.id, 'volume_1');
  assert.equal(v.name, 'Volume 1');
  assert.equal(v.desc, 'Daten');
  assert.equal(v.status, 'normal');
  assert.equal(v.fs, 'btrfs');
  assert.equal(v.total, 11511880392704);
  assert.equal(v.pct, 60);
  assert.deepEqual(st.pools.map((p) => [p.id, p.num, p.raid, p.status, p.disks.length]), [['reuse_1', 1, 'SHR', 'normal', 3]]);
  assert.equal(st.disks.length, 4);
  assert.deepEqual(st.disks.map((d) => [d.id, d.health, d.temp]), [['sata1', 'normal', 36], ['sata2', 'normal', 38], ['sata3', 'normal', 37], ['nvme0n1', 'normal', 41]]);
  assert.equal(st.disks[0].vendor, 'WDC');
  assert.equal(st.disks[0].remain_life, null, 'an untrusted remaining life is not shown');
  assert.equal(st.disks[3].remain_life, 97);
  assert.equal(st.disks[3].ssd, true);
  assert.ok(!('serial' in st.disks[0]), 'serial numbers are not kept');
});

test('DSM 7.2: update (DSM 7 shape), Hyper Backup tasks, UPS', () => {
  assert.deepEqual(parse.upgrade(R72['SYNO.Core.Upgrade.Server.check']), { available: true, version: 'DSM 7.2.2-72806 Update 2', reboot: 'now' });
  const b = parse.backups(R72['SYNO.Backup.Task.list']);
  assert.deepEqual(b.map((t) => [t.id, t.name, t.result, t.last_time, t.next_time, t.running]), [
    [1, 'USB-Sicherung', 'ok', '2026/10/12 03:41', '2026/10/13 03:00', false],
    [2, 'Cloud (C2)', 'ok', '2026/10/12 04:22', '2026/10/13 04:00', false],
  ]);
  assert.deepEqual(parse.ups(R72['SYNO.Core.ExternalDevice.UPS.get']), { model: 'APC Back-UPS ES 700G', state: 'online', charge: 100, runtime_s: 1980 });
  assert.equal(parse.ups({ enable: false, usb_ups_connect: false, status: '' }), null, 'no UPS connected → nothing');
  assert.equal(parse.ups({ usb_ups_connect: true, status: 'usb_ups_status_onbattery', charge: 64 }).state, 'battery');
  assert.equal(parse.ups({ usb_ups_connect: true, status: 'usb_ups_status_lowbattery', charge: 9 }).state, 'low');
});

test('DSM 7.1: sizes as numbers, degraded pool/volume, drive warning, RAM from total/avail, no update', () => {
  assert.equal(parse.dsmInfo(R71['SYNO.DSM.Info.getinfo']).dsm, 'DSM 7.1.1-42962 Update 6');
  assert.deepEqual(parse.utilization(R71['SYNO.Core.System.Utilization.get']), { cpu: 42, ram: 80 });
  const st = parse.storage(R71['SYNO.Storage.CGI.Storage.load_info']);
  assert.equal(st.volumes[0].status, 'degraded');
  assert.equal(st.volumes[0].pct, 92);
  assert.equal(st.pools[0].status, 'degraded');
  assert.equal(st.pools[0].raid, 'RAID 1');
  assert.deepEqual(st.disks.map((d) => d.health), ['normal', 'warning']);
  assert.deepEqual(parse.upgrade(R71['SYNO.Core.Upgrade.Server.check']), { available: false, version: null, reboot: null });
});

test('DSM 6.2: SYNO.Core.System info (fallback) and type=storage, DSM 6 update shape', () => {
  assert.deepEqual(parse.systemInfo(R62['SYNO.Core.System.info']), {
    model: 'DS216j', dsm: 'DSM 6.2.4-25556 Update 7', build: null, uptime_s: 3600, temp: 41, temp_warn: false, ram_mb: 512,
  });
  const st = parse.storageFallback(R62['SYNO.Core.System.info:storage']);
  assert.equal(st.source, 'system');
  assert.deepEqual(st.volumes.map((v) => [v.id, v.name, v.status, v.pct]), [['volume_1', 'Volume 1', 'normal', 50]]);
  assert.deepEqual(st.pools, []);
  assert.deepEqual(st.disks.map((d) => [d.id, d.name, d.health, d.temp, d.size]), [['Disk 1', 'Disk 1', 'normal', 33, 3000592982016], ['Disk 2', 'Disk 2', 'normal', 34, 3000592982016]]);
  assert.deepEqual(parse.upgrade(R62['SYNO.Core.Upgrade.Server.check']), { available: true, version: 'DSM 6.2.4-25556 Update 8', reboot: 'now' });
  assert.deepEqual(parse.utilization(R62['SYNO.Core.System.Utilization.get']), { cpu: 10, ram: 45 });
});

test('status mappings: volumes/pools, drive health, backup results, uptime', () => {
  for (const [raw, want] of [['normal', 'normal'], ['background', 'normal'], ['data_scrubbing', 'normal'], ['expanding', 'normal'], ['degraded', 'degraded'],
    ['attention', 'degraded'], ['repairing', 'degraded'], ['crashed', 'crashed'], ['crash', 'crashed'], ['', 'unknown'], ['weird', 'unknown']]) {
    assert.equal(parse.storageStatus(raw), want, raw);
  }
  assert.equal(parse.diskHealth({ status: 'normal', smart_status: 'normal' }), 'normal');
  assert.equal(parse.diskHealth({ status: 'normal', smart_status: 'warning' }), 'warning');
  assert.equal(parse.diskHealth({ status: 'normal', below_remain_life_thr: true }), 'warning');
  assert.equal(parse.diskHealth({ overview_status: 'failing' }), 'failing');
  assert.equal(parse.diskHealth({ status: 'crashed' }), 'failing');
  assert.equal(parse.diskHealth({ status: 'not_initialized' }), 'normal', 'a new drive outside a pool is healthy');
  assert.equal(parse.diskHealth({}), 'unknown');
  for (const [raw, want] of [['done', 'ok'], ['failed', 'failed'], ['partial', 'partial'], ['cancel', 'cancelled'], ['', 'none'], ['backingup', 'running'], ['???', 'unknown']]) {
    assert.equal(parse.backupResult(raw), want, raw);
  }
  assert.equal(parse.uptimeSeconds('312:00:05'), 312 * 3600 + 5);
  assert.equal(parse.uptimeSeconds(42), 42);
  assert.equal(parse.uptimeSeconds('x'), null);
});

test('garbage in → empty values, never an exception; control characters removed', () => {
  assert.deepEqual(parse.storage(null), { source: 'storage', volumes: [], pools: [], disks: [] });
  assert.deepEqual(parse.storage({ volumes: 'x', disks: [null, 1, {}] }).disks, []);
  assert.deepEqual(parse.backups({ task_list: [{ name: 'no id' }] }), []);
  assert.deepEqual(parse.utilization({}), { cpu: null, ram: null });
  assert.equal(parse.dsmInfo({ model: 'DS\u0000920+\n<b>' }).model, 'DS 920+ <b>');
  assert.equal(parse.upgrade(null).available, false);
});
