'use strict';

// Notices: the filter fell back / answers again (administrators, switch "Bei Ausfall des Filters"), a suspension ran
// out (the person), the weekly report (Mondays, administrators, switch "Wochenbericht", once per week).

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const notices = require('../server/notices');
const plugin = require('../server/index');
const { setup, P, ADMIN, MARC, LEA, BOSS } = require('./helpers');

const t = plugin._t;

describe('events of the DNS protection', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });

  it('outage and recovery go to every administrator', async () => {
    s = await setup();
    await s.host.vpnDnsEvent({ type: 'fallback' });
    assert.deepEqual(s.host.notifications.map((n) => [n.topic, n.users, n.priority, n.title]), [['outage', [ADMIN.id, BOSS.id], 'high', 'DNS-Schutz ausgefallen']], 'one notice for the administrators of a language');
    assert.match(s.host.notifications[0].body, /ungefiltert/);
    await s.host.vpnDnsEvent({ type: 'restored' });
    assert.deepEqual(s.host.notifications.slice(1).map((n) => [n.topic, n.priority, n.title]), [['outage', 'normal', 'DNS-Schutz läuft wieder']]);
    assert.ok(s.host.notifications.every((n) => n.collapseKey === 'dns-outage'));
  });

  it('switched off on the settings page: nothing is sent', async () => {
    s = await setup({ config: { notify: { outage: false } } });
    await s.host.vpnDnsEvent({ type: 'fallback' });
    await s.host.vpnDnsEvent({ type: 'restored' });
    assert.deepEqual(s.host.notifications, []);
  });

  it('a suspension that ran out tells the person — not when it was ended by hand, not for all devices', async () => {
    s = await setup();
    await s.app(LEA, P.leaPhone, 'POST', 'pause', { minutes: 5 });
    await s.app(MARC, P.marcPhone, 'POST', 'pause', { userId: LEA.id, minutes: 5 });
    await s.app(MARC, P.marcPhone, 'POST', 'pause', { minutes: 5 });
    await s.app(MARC, P.marcPhone, 'POST', 'resume', {});
    await s.admin('POST', 'pause', { minutes: 5 });
    assert.deepEqual(s.host.notifications, [], 'pausing and switching back on by hand notify nobody');
    assert.equal(await s.host.vpnDnsExpire(Date.now() + 6 * 60000), 3);
    assert.deepEqual(s.host.notifications.map((n) => [n.topic, n.users, n.title]).sort(), [['pause_end', [LEA.id], 'DNS-Schutz wieder eingeschaltet'], ['pause_end', [LEA.id], 'DNS-Schutz wieder eingeschaltet']]);
    assert.ok(s.host.notifications.some((n) => /Leas Handy/.test(n.body)));
  });

  it('an event the plugin does not know is ignored', async () => {
    s = await setup();
    await s.host.vpnDnsEvent({ type: 'something_new' });
    await notices.onEvent(s.host.gc, t, null);
    assert.deepEqual(s.host.notifications, []);
    assert.ok(!s.host.logs.some((l) => l.level === 'error'));
  });
});

describe('weekly report', () => {
  let s;
  afterEach(async () => { if (s) await s.host.close(); s = null; });
  const MON = new Date(2026, 10, 9, 8, 0, 0).getTime();   // Monday 9 November 2026, 08:00 local time
  const day = (d) => `2026-11-${String(d).padStart(2, '0')}`;
  const days = [2, 3, 4, 5, 6, 7, 8].map((d) => ({ day: day(d), queries: 1000, blocked: 100, cached: 0, top: [{ domain: 'doubleclick.net', count: 40 }, { domain: 'ads.tiktok.com', count: 20 }] }));

  it('mondayKey', () => {
    assert.equal(notices.mondayKey(MON), '2026-11-09');
    assert.equal(notices.mondayKey(new Date(2026, 10, 15, 23, 59).getTime()), '2026-11-09');
    assert.equal(notices.mondayKey(new Date(2026, 10, 16, 0, 0).getTime()), '2026-11-16');
  });

  it('off by default; switched on: the first week is only remembered, then once per week from Monday 7 o\'clock', async () => {
    s = await setup({ vpnDns: { days } });
    const gc = s.host.gc;
    assert.equal(await notices.weekly(gc, t, MON), false, 'the switch is off');
    await s.config({ notify: { weekly: true } });
    assert.equal(await notices.weekly(gc, t, MON - 7 * 86400000), false, 'the first run remembers the week');
    assert.equal(await notices.weekly(gc, t, new Date(2026, 10, 9, 6, 30).getTime()), false, 'Monday before 7 o\'clock');
    assert.deepEqual(s.host.notifications, []);
    // the mock host answers stats for "now": hand the days of last week over as they would be on that Monday
    const real = gc.vpnDns.stats;
    const stats = await real({ days: 90 });
    const fake = { ...gc, vpnDns: { ...gc.vpnDns, stats: async () => ({ ...stats, days, top: [{ domain: 'doubleclick.net', count: 280 }, { domain: 'ads.tiktok.com', count: 140 }] }) } };
    assert.equal(await notices.weekly(fake, t, MON), true);
    assert.deepEqual(s.host.notifications.map((n) => [n.topic, n.users, n.title]), [['weekly', [ADMIN.id, BOSS.id], 'DNS-Schutz: Wochenbericht']]);
    assert.equal(s.host.notifications[0].body, 'Letzte Woche: 7.000 Anfragen, 700 gesperrt (10 %). Am häufigsten gesperrt: doubleclick.net, ads.tiktok.com.');
    assert.equal(await notices.weekly(fake, t, MON + 3600000), false, 'once per week');
    assert.equal(await notices.weekly(fake, t, MON + 2 * 86400000), false);
    assert.equal(s.host.notifications.length, 1);
    assert.equal(await notices.weekly(fake, t, MON + 7 * 86400000), true, 'the next Monday');
  });

  it('the background run calls it and survives a failure', async () => {
    s = await setup({ config: { notify: { weekly: true } } });
    await s.host.tick();
    await s.host.tick();
    assert.ok(!s.host.logs.some((l) => l.level === 'error' || l.level === 'warn'), JSON.stringify(s.host.logs));
  });
});
