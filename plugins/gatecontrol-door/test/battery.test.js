'use strict';

// 1.8.0 — the battery of a Nuki lock / opener in the apps: GateControl's widget.badge { icon, value, unit, state,
// label } on the lock's first quick action (the mock host checks the badge as strictly as GateControl), from what the
// bridge (batteryChargeState, batteryCritical, batteryCharging) or Nuki Web (batteryCharge …) reports; the same steps
// as the small symbol on the portal and the admin page (ui/common.js batteryChip).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const battery = require('../server/battery');
const texts = require('../server/texts.json');
const { withDoor, app, ANNA, MARC } = require('./helpers');

const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
const t = (lang, key) => texts[lang][key] || key;
const FULL = battery.BATTERY_ICONS[3][1];

test('badge: level icon, whole %, warn ≤ 30 %, crit ≤ 15 % or when Nuki says critical, charging, nothing without a value', () => {
  const b = (s, lang = 'de') => battery.badge(t, lang, s);
  assert.equal(b({}), null, 'nothing reported: no badge');
  assert.equal(b({ batteryCritical: false, batteryPercent: null }), null, 'an older bridge, not critical: no badge');
  assert.deepEqual(b({ batteryPercent: 80 }), { icon: FULL, value: 80, unit: '%', state: 'good', label: 'Batterie' });
  assert.deepEqual(b({ batteryPercent: 31 }).state, 'good');
  assert.deepEqual(b({ batteryPercent: 30 }), { icon: battery.BATTERY_ICONS[1][1], value: 30, unit: '%', state: 'warn', label: 'Batterie' });
  assert.deepEqual(b({ batteryPercent: 15.4 }), { icon: battery.BATTERY_ICONS[0][1], value: 15, unit: '%', state: 'crit', label: 'Batterie' });
  assert.deepEqual(b({ batteryPercent: 60, batteryCritical: true }, 'en'), { icon: battery.BATTERY_ICONS[2][1], value: 60, unit: '%', state: 'crit', label: 'Battery almost empty' });
  assert.deepEqual(b({ batteryCritical: true }), { icon: battery.BATTERY_CRITICAL_ICON, value: 'leer', state: 'crit', label: 'Batterie fast leer' });
  assert.deepEqual(b({ batteryPercent: 45, batteryCharging: true }), { icon: battery.BATTERY_CHARGING_ICON, value: 45, unit: '%', state: 'good', label: 'Akku lädt' });
  for (const s of [{ batteryPercent: 0 }, { batteryPercent: 100 }, { batteryCritical: true }, { batteryPercent: 5, batteryCharging: true, batteryCritical: true }]) {
    for (const lang of ['de', 'en']) {
      const x = b(s, lang);
      assert.match(x.icon, ICON_RE);
      assert.ok(x.label.length <= 20 && String(x.value).length <= 8, JSON.stringify(x));
    }
  }
});

test('quick actions: the battery as the badge on the lock\'s first action, the state as the widget\'s value', () => withDoor({
  devices: { 1001: { deviceType: 4, name: 'Haustür', state: 1, door: 2, battery: 12 }, 2002: { deviceType: 2, name: 'Opener', state: 1, battery: 64 } },
}, async (host, { lockId, openerId, bridge }) => {
  let anna = await host.quickActions(ANNA);
  assert.deepEqual(anna.map((a) => a.id), [`${lockId}:lock`, `${lockId}:unlock`, `${lockId}:open`, `${openerId}:open`]);
  assert.deepEqual(anna[0].widget, {
    label: null, value: 'Zugesperrt', unit: null, status: 'Tür zu', state: 'good', readings: [], controls: [], power: false,
    badge: { icon: battery.BATTERY_ICONS[0][1], value: 12, unit: '%', state: 'crit', label: 'Batterie' },
  });
  assert.deepEqual([anna[1].widget, anna[2].widget], [null, null], 'only once per lock');
  assert.deepEqual(anna[3].widget.badge, { icon: battery.BATTERY_ICONS[2][1], value: 64, unit: '%', state: 'good', label: 'Batterie' });
  // Marc (right "lock") sees the lock's first action he may use — with the badge
  const marc = await host.quickActions(MARC);
  assert.equal(marc[0].widget.badge.value, 12);
  // the bridge reports "critical": crit whatever the percentage, in English too
  bridge.devices[1001].battery = 60;
  bridge.devices[1001].batteryCritical = true;
  await host.request({ method: 'POST', path: `/admin/locks/${lockId}/refresh`, user: { id: 1, name: 'Admin', role: 'admin' }, body: null, query: {} });
  await host.tick();
  anna = await host.quickActions(ANNA, 'en');
  assert.deepEqual(anna[0].widget.badge, { icon: battery.BATTERY_ICONS[2][1], value: 60, unit: '%', state: 'crit', label: 'Battery almost empty' });
  // the portal / app API keeps the battery fields the small symbol is drawn from
  const me = (await host.request({ method: 'GET', path: '/me', user: app(ANNA), body: null, query: {} })).json;
  const s = me.locks.find((l) => l.id === lockId).state;
  assert.deepEqual([s.batteryPercent, s.batteryCritical, s.batteryCharging], [60, true, false]);
}));

test('portal and admin page: the battery as a small symbol beside the state (no longer as text)', () => {
  const ui = (f) => fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
  assert.match(ui('common.js'), /batteryChip: batteryChip/);
  assert.match(ui('portal.js'), /D\.batteryChip\(lock\)/);
  assert.match(ui('devices.js'), /D\.batteryChip\(l\)/);
  assert.doesNotMatch(ui('common.js'), /parts\.push\(s\.batteryPercent/);
  assert.match(ui('style.css'), /\.dr-batt\[data-tone="crit"\]/);
});
