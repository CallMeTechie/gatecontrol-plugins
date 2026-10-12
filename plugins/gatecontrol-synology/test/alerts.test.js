'use strict';

// Notifications: the pure transition logic (alerts.evaluate) for every
// alert — first sighting, transition, recovery, dedupe after a restart,
// thresholds with hysteresis — the payloads (topics, priorities, facts) and
// the whole path poll → gc.notify against the mock host.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const parse = require('../server/parse');
const manifest = require('../plugin.json');
const { fixture, fakeDsm, withHost, asAdmin, addNas } = require('./helpers');

const CFG = { unreachablePolls: 3, fullPct: 90, diskTempMax: 55, lang: 'de' };
const NAS = { id: 1, name: 'Keller' };
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const MIN = 60000;
const R72 = fixture('dsm72.json').responses;

/** A normalised status (DSM 7.2 fixture), changed by `fn`. */
function snap(fn) {
  const st = parse.storage(R72['SYNO.Storage.CGI.Storage.load_info']);
  const s = {
    info: parse.dsmInfo(R72['SYNO.DSM.Info.getinfo']), volumes: st.volumes, pools: st.pools, disks: st.disks,
    update: { available: false, version: null }, backups: parse.backups(R72['SYNO.Backup.Task.list']), ups: null,
  };
  if (fn) fn(s);
  return JSON.parse(JSON.stringify(s));
}
const up = (s, extra) => ({ nas: NAS, reachable: true, failures: 0, snap: s, ...extra });
const down = (failures, extra) => ({ nas: NAS, reachable: false, failures, snap: null, ...extra });
/** run a sequence of observations from `memo`; JSON round trip in between (= restart-safe storage) */
function run(memo, list, cfg = CFG, start = T0) {
  let m = memo;
  const all = [];
  list.forEach((o, i) => {
    const r = alerts.evaluate(m, [o], cfg, start + i * 2 * MIN);
    m = JSON.parse(JSON.stringify(r.memo));
    all.push(r.events);
  });
  return { memo: m, events: all };
}
const kinds = (evs) => evs.map((e) => `${e.topic}:${e.kind}${e.status ? ':' + e.status : ''}`);
const seen = () => run(null, [up(snap())]).memo; // the NAS seen once, healthy

test('first sighting: a NAS already degraded, full, hot, with an update and a failed backup → nothing', () => {
  const bad = snap((s) => {
    s.volumes[0].status = 'crashed'; s.volumes[0].pct = 97; s.pools[0].status = 'degraded';
    s.disks[0].health = 'failing'; s.disks[1].temp = 61; s.update = { available: true, version: 'DSM 7.3' }; s.backups[0].result = 'failed';
  });
  const r = alerts.evaluate(null, [up(bad)], CFG, T0);
  assert.deepEqual(r.events, []);
  // a NAS added later (memo exists, NAS not in it) is a first sighting as well
  const other = alerts.evaluate({ v: 1, nas: { 9: { down: null, seen: true } } }, [up(bad)], CFG, T0);
  assert.deepEqual(other.events, []);
  // already down when first seen: muted, no "reachable again" later
  const r2 = run(null, [down(5), down(6), up(snap())]);
  assert.deepEqual(r2.events.flat(), []);
});

test('unreachable after N failed polls (once), "reachable again" after; dedupe across a restart', () => {
  const r = run(seen(), [down(1), down(2), down(3), down(4)]);
  assert.deepEqual(r.events.map(kinds), [[], [], ['unreachable:down'], []]);
  // restart: the memo comes back from storage
  const again = run(r.memo, [down(5), up(snap())]);
  assert.deepEqual(again.events.map(kinds), [[], ['unreachable:up']]);
  // threshold from the settings
  const one = run(seen(), [down(1)], { ...CFG, unreachablePolls: 1 });
  assert.deepEqual(kinds(one.events[0]), ['unreachable:down']);
  // a login problem: the NAS answered → not unreachable
  const auth = run(seen(), [{ nas: NAS, reachable: true, failures: 0, snap: null }]);
  assert.deepEqual(auth.events.flat(), []);
});

test('reboot / shutdown requested here: no "unreachable" during the reboot grace, none after a shutdown', () => {
  const reboot = { state: 'reboot', at: T0 };
  const r = run(seen(), [down(3, { power: reboot }), down(4, { power: reboot }), up(snap())]);
  assert.deepEqual(r.events.flat(), []);
  // a reboot that does not come back within 20 minutes is reported
  const late = alerts.evaluate(seen(), [down(5, { power: reboot })], CFG, T0 + alerts.REBOOT_GRACE_MS + MIN);
  assert.deepEqual(kinds(late.events), ['unreachable:down']);
  const off = { state: 'shutdown', at: T0 };
  const r2 = run(seen(), [down(3, { power: off }), down(10, { power: off }), up(snap())]);
  assert.deepEqual(r2.events.flat(), []);
});

test('volume / pool degraded and crashed (high), back to normal (info)', () => {
  const r = run(seen(), [
    up(snap((s) => { s.volumes[0].status = 'degraded'; s.pools[0].status = 'degraded'; })),
    up(snap((s) => { s.volumes[0].status = 'crashed'; s.pools[0].status = 'degraded'; })),
    up(snap((s) => { s.volumes[0].status = 'crashed'; s.pools[0].status = 'degraded'; })),
    up(snap()),
  ]);
  assert.deepEqual(r.events.map(kinds), [
    ['storage:volume:degraded', 'storage:pool:degraded'],
    ['storage:volume:crashed'],
    [],
    ['storage:volume:normal', 'storage:pool:normal'],
  ]);
  // an unreadable status (unknown) keeps what was known: no flapping
  const u = run(r.memo, [up(snap((s) => { s.volumes[0].status = 'unknown'; })), up(snap())]);
  assert.deepEqual(u.events.flat(), []);
});

test('storage almost full: at the threshold once; again only after falling 2 points below; threshold setting', () => {
  const pct = (p) => up(snap((s) => { s.volumes[0].pct = p; }));
  const r = run(seen(), [pct(89.9), pct(90), pct(95), pct(89), pct(91), pct(87.5), pct(90.5)]);
  assert.deepEqual(r.events.map(kinds), [[], ['storage:full'], [], [], [], [], ['storage:full']]);
  const r2 = run(seen(), [pct(80)], { ...CFG, fullPct: 75 });
  assert.deepEqual(kinds(r2.events[0]), ['storage:full']);
});

test('drive health warning / failing (high), temperature at the threshold (hysteresis 3 °C)', () => {
  const r = run(seen(), [
    up(snap((s) => { s.disks[1].health = 'warning'; })),
    up(snap((s) => { s.disks[1].health = 'warning'; })),
    up(snap((s) => { s.disks[1].health = 'failing'; })),
    up(snap()), // drive replaced: recorded, nothing announced
  ]);
  assert.deepEqual(r.events.map(kinds), [['disk:warning'], [], ['disk:failing'], []]);
  const temp = (t) => up(snap((s) => { s.disks[0].temp = t; }));
  const h = run(seen(), [temp(54), temp(55), temp(57), temp(53), temp(56), temp(51), temp(55)]);
  assert.deepEqual(h.events.map(kinds), [[], ['disk:hot'], [], [], [], [], ['disk:hot']]);
  const h2 = run(seen(), [temp(46)], { ...CFG, diskTempMax: 45 });
  assert.deepEqual(kinds(h2.events[0]), ['disk:hot']);
});

test('DSM update: once per version, also after a restart and when it disappears and comes back', () => {
  const upd = (v) => up(snap((s) => { s.update = v ? { available: true, version: v } : { available: false, version: null }; }));
  const noCheck = up(snap((s) => { s.update = null; }));
  const r = run(seen(), [upd('DSM 7.2.2-72806'), upd('DSM 7.2.2-72806'), noCheck, upd(null), upd('DSM 7.2.2-72806'), upd('DSM 7.2.2-72806 Update 1')]);
  assert.deepEqual(r.events.map(kinds), [['update:available'], [], [], [], [], ['update:available']]);
  assert.equal(r.events[0][0].version, 'DSM 7.2.2-72806');
  assert.equal(r.events[0][0].installed, 'DSM 7.2.1-69057 Update 5');
});

test('Hyper Backup: a new failed / partial run once; the same failed run is not repeated', () => {
  const res = (result, time) => up(snap((s) => { s.backups[0].result = result; s.backups[0].last_time = time; }));
  const r = run(seen(), [res('failed', '2026/10/13 03:12'), res('failed', '2026/10/13 03:12'), res('ok', '2026/10/14 03:40'), res('partial', '2026/10/15 03:30'), res('failed', '2026/10/16 03:01')]);
  assert.deepEqual(r.events.map(kinds), [['backup:failed'], [], [], ['backup:partial'], ['backup:failed']]);
  // a new task appears already failed: first sighting
  const n = run(seen(), [up(snap((s) => { s.backups.push({ id: 7, name: 'Neu', result: 'failed', last_time: 'x' }); }))]);
  assert.deepEqual(n.events.flat(), []);
});

test('NAS not polled now keep their state; removed volumes/drives leave the memo', () => {
  const m = seen();
  const r = alerts.evaluate(m, [], CFG, T0);
  assert.deepEqual(r.memo, m);
  const fewer = alerts.evaluate(m, [up(snap((s) => { s.disks = s.disks.slice(0, 1); }))], CFG, T0).memo;
  assert.deepEqual(Object.keys(fewer.nas[1].disk), ['sata1']);
});

test('payloads: declared topics, priorities, collapse keys, facts within the host limits, open action, German and English', () => {
  const topics = new Set(manifest.notifyTopics.map((x) => x.id));
  const gc = { plugin: { id: 'gatecontrol-synology' } };
  const s = snap();
  const evs = [
    { topic: 'unreachable', kind: 'down', nas: NAS, failures: 3, lastSeen: T0 },
    { topic: 'unreachable', kind: 'up', nas: NAS },
    { topic: 'storage', kind: 'volume', status: 'degraded', nas: NAS, item: s.volumes[0] },
    { topic: 'storage', kind: 'pool', status: 'crashed', nas: NAS, item: s.pools[0] },
    { topic: 'storage', kind: 'volume', status: 'normal', nas: NAS, item: s.volumes[0] },
    { topic: 'storage', kind: 'full', nas: NAS, item: { ...s.volumes[0], pct: 93.4 } },
    { topic: 'disk', kind: 'failing', nas: NAS, item: s.disks[0] },
    { topic: 'disk', kind: 'hot', nas: NAS, item: { ...s.disks[0], temp: 58 } },
    { topic: 'update', kind: 'available', nas: NAS, version: 'DSM 7.2.2-72806', installed: 'DSM 7.2.1-69057' },
    { topic: 'backup', kind: 'failed', nas: NAS, item: s.backups[0] },
  ];
  for (const lang of ['de', 'en']) {
    for (const ev of evs) {
      const n = alerts.toNotification(gc, ev, { ...CFG, lang });
      assert.ok(topics.has(n.topic), n.topic);
      assert.ok(n.title && n.title.length <= 120 && !/\{\{/.test(n.title + n.body), n.title);
      assert.ok(['info', 'normal', 'high'].includes(n.priority));
      assert.match(n.collapseKey, /^[A-Za-z0-9_.:@/-]{1,120}$/);
      assert.equal(n.users, null, 'the topic rule decides (administrators)');
      assert.equal(n.data.route, 'plg-gatecontrol-synology');
      assert.deepEqual(n.data.actions.map((a) => a.type), ['open_app_route']);
      assert.ok(Array.isArray(n.data.facts) && n.data.facts.length >= 1 && n.data.facts.length <= 6);
      for (const f of n.data.facts) assert.ok(f.label.length <= 60 && f.value.length <= 120 && f.value);
      assert.ok(Buffer.byteLength(JSON.stringify(n.data)) <= 4096);
    }
  }
  const de = (i) => alerts.toNotification(gc, evs[i], CFG);
  assert.equal(de(0).priority, 'high');
  assert.equal(de(1).priority, 'info');
  assert.equal(de(0).collapseKey, de(1).collapseKey, '"reachable again" replaces the alarm');
  assert.equal(de(2).title, 'Volume beeinträchtigt');
  assert.equal(de(3).title, 'Speicherpool abgestürzt');
  assert.equal(de(4).priority, 'info');
  assert.deepEqual(de(5).data.facts.map((f) => f.label), ['NAS', 'Volume', 'Belegt', 'Frei']);
  assert.match(de(5).body, /Volume 1 auf Keller ist zu 93,4 % belegt/);
  assert.equal(de(6).priority, 'high');
  assert.deepEqual(de(6).data.facts.slice(0, 3).map((f) => f.value), ['Keller', 'Drive 1', 'WDC WD40EFZX-68AWUN0']);
  assert.match(de(7).body, /58 °C/);
  assert.deepEqual(de(8).data.facts.map((f) => f.value), ['Keller', 'DSM 7.2.1-69057', 'DSM 7.2.2-72806']);
  assert.equal(alerts.toNotification(gc, evs[2], { ...CFG, lang: 'en' }).title, 'Volume degraded');
  const p = alerts.powerNotification(gc, NAS, 'shutdown', 'admin', CFG);
  assert.equal(p.topic, 'power');
  assert.match(p.body, /Einschalten nur am Gerät/);
});

test('poll → notifications through the host: nothing at first, then a degraded volume, no repeat; recipients by topic rule', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    assert.deepEqual(host.notifications, [], 'first sighting');
    const lr = d.fixture.responses['SYNO.Storage.CGI.Storage.load_info'];
    lr.volumes[0].status = 'degraded';
    lr.disks[2].smart_status = 'failing';
    await asAdmin(host, 'POST', `/nas/${id}/refresh`);
    assert.deepEqual(host.notifications.map((n) => [n.topic, n.priority, n.title]), [
      ['storage', 'high', 'Volume beeinträchtigt'],
      ['disk', 'high', 'Laufwerk fällt aus'],
    ]);
    assert.equal(host.notifications[0].users, null);
    await asAdmin(host, 'POST', `/nas/${id}/refresh`);
    assert.equal(host.notifications.length, 2, 'no repeat');
    // restart of the plugin (state from gc.storage): still no repeat
    await host.start();
    await asAdmin(host, 'POST', `/nas/${id}/refresh`);
    assert.equal(host.notifications.length, 2);
  });
});

test('background: N failed polls → one "unreachable", then "reachable again"', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d], settings: { unreachable_polls: 2 } }, async (host) => {
    const id = await addNas(host);
    d.state.down = true;
    const due = () => host.gc.db.run('UPDATE nas SET next_poll_at = 0 WHERE id = ?', [id]);
    for (let i = 0; i < 3; i++) { await due(); await host.tick(); }
    assert.deepEqual(host.notifications.map((n) => [n.topic, n.priority]), [['unreachable', 'high']]);
    assert.match(host.notifications[0].body, /Keller antwortet seit 2 Abfragen nicht/);
    d.state.down = false;
    await due(); await host.tick();
    assert.deepEqual(host.notifications.map((n) => n.title), ['NAS nicht erreichbar', 'NAS wieder erreichbar']);
    assert.equal(host.notifications[0].collapseKey, host.notifications[1].collapseKey);
  });
});
