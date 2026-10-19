'use strict';

// Tests of the repository tooling. The pack/verify round trip needs a
// GateControl checkout (tools/fetch-gatecontrol.sh, or CI) and is skipped without.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const lib = require('../lib');
const { internetAllowed, createHost } = require('../testing/mock-host');

const TOOLS = path.join(__dirname, '..');
let gcDir = null;
try { gcDir = lib.gatecontrolDir(); } catch { /* skipped below */ }

test('tags parse into id and version', () => {
  assert.deepEqual(lib.parseTag('gatecontrol-smarthome-v1.0.0'), { id: 'gatecontrol-smarthome', version: '1.0.0' });
  assert.deepEqual(lib.parseTag('a-v2-v1.2.3-rc.1'), { id: 'a-v2', version: '1.2.3-rc.1' });
  for (const bad of ['gatecontrol-smarthome-1.0.0', 'v1.0.0', 'Smart-v1.0.0', 'x-v1.0', 'x-v01.0.0', 'x-v1.0.0 ']) assert.equal(lib.parseTag(bad), null, bad);
});

test('semver precedence', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  const shuffled = [...sorted].reverse();
  assert.deepEqual(shuffled.sort(lib.compareSemver), sorted);
});

test('changelog sections', () => {
  assert.match(lib.changelogSection('gatecontrol-hello', '1.0.0'), /Erste Version/);
  assert.equal(lib.changelogSection('gatecontrol-hello', '9.9.9'), null);
});

test('example plugins are not released', () => {
  assert.equal(lib.pluginConfig('gatecontrol-hello').release, false);
  assert.equal(lib.pluginConfig('some-other').release, true);
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'release-check.js'), 'gatecontrol-hello-v1.0.0'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not released/);
});

test('mock host internet allowlist', () => {
  const list = ['api.example.com:443', '*.cloud.example', 'plain.example'];
  assert.ok(internetAllowed(list, 'https://api.example.com/x'));
  assert.ok(!internetAllowed(list, 'http://api.example.com/x'));
  assert.ok(internetAllowed(list, 'https://a.b.cloud.example/'));
  assert.ok(!internetAllowed(list, 'https://cloud.example/'));
  assert.ok(internetAllowed(list, 'http://plain.example:8080/'));
  assert.ok(!internetAllowed(list, 'file:///etc/passwd'));
});

test('mock host quick actions: checked like the host, run only for an id listed for that viewer', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'qa-test', name: 'QA', version: '1.0.0', entry: 'server/index.js', permissions: { portal: true } }));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      let answer = null;
      module.exports = {
        _set(a) { answer = a; },
        async quickActions({ user }) { return answer || (user.id === 2 ? [{ id: 'x:1', title: 'Lamp', kind: 'toggle', state: 'on' }] : []); },
        async runQuickAction({ user, id }) { return { ok: true, message: user.app && user.loggedIn ? 'done ' + id : 'no', state: 'off' }; },
      };`);
    const host = await createHost(tmp);
    try {
      assert.deepEqual(await host.quickActions({ id: 2, name: 'Ada', role: 'user' }), [{ id: 'x:1', title: 'Lamp', subtitle: null, icon: null, kind: 'toggle', state: 'on', confirm: false, confirmWhen: null, look: null, device: null, widget: null, verbs: null, targets: false }]);
      assert.deepEqual(await host.runQuickAction({ id: 2, name: 'Ada', role: 'user' }, 'x:1'), { status: 200, body: { ok: true, unchanged: false, message: 'done x:1', state: 'off', widget: null } });
      assert.equal((await host.runQuickAction({ id: 3, name: 'Bob', role: 'user' }, 'x:1')).status, 404, 'not listed for Bob');
      assert.equal((await host.runQuickAction({ id: 2, name: 'Ada', role: 'user' }, 'x:2')).status, 404);
      const many = Array.from({ length: 17 }, (_, i) => ({ id: 'a' + i, title: 'A' }));
      for (const bad of [many, [{ id: 'a b', title: 'A' }], [{ id: 'a', title: 'x'.repeat(41) }], [{ id: 'a', title: 'A', kind: 'slider' }],
        [{ id: 'a', title: 'A', state: 'on' }], [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], [{ id: 'a', title: 'A', icon: '<svg>' }], {}]) {
        host.plugin._set(bad);
        await assert.rejects(host.quickActions({ id: 2, name: 'Ada', role: 'user' }), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 60));
      }
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host quick action widgets: checked like the host, controls run through the route', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-widget-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'qa-widget-test', name: 'QA', version: '1.0.0', entry: 'server/index.js', permissions: { portal: true } }));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      let widget = null;
      module.exports = {
        _set(w) { widget = w; },
        async quickActions() { return [{ id: 'ac:1', title: 'Klima', kind: 'toggle', state: 'on', widget }, { id: 'plain', title: 'Plain' }]; },
        async runQuickAction(a) { return { ok: true, message: [a.id, String(a.control), typeof a.value, String(a.value)].join(' '), state: 'on', widget: a.control === 'mode' ? widget : (a.control === 'target' ? { value: 'x' } : undefined) }; },
      };`);
    const ok = {
      value: 21.5, unit: '°C', status: 'Kühlen · Ziel 22 °C', state: 'on',
      controls: [
        { id: 'target', kind: 'stepper', label: 'Ziel', value: 22, min: 16, max: 30, step: 0.5, unit: '°C' },
        { id: 'mode', kind: 'choice', label: 'Modus', value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen' }] },
      ],
    };
    const host = await createHost(tmp);
    const ada = { id: 2, name: 'Ada', role: 'user' };
    try {
      host.plugin._set(ok);
      const list = await host.quickActions(ada);
      assert.deepEqual(list[0].widget, { label: null, ...ok, controls: [ok.controls[0], ok.controls[1]], readings: [], power: true, badge: null });
      assert.equal(list[1].widget, null, 'no widget → null');
      host.plugin._set({ value: '–' });
      assert.deepEqual((await host.quickActions(ada))[0].widget, { label: null, value: '–', unit: null, status: null, state: null, controls: [], readings: [], power: true, badge: null });
      host.plugin._set(ok);
      assert.deepEqual(await host.runQuickAction(ada, 'ac:1', 'de', { control: 'target', value: 23.5 }), { status: 200, body: { ok: true, unchanged: false, message: 'ac:1 target number 23.5', state: 'on', widget: { label: null, value: 'x', unit: null, status: null, state: null, controls: [], readings: [], power: true, badge: null } } });
      assert.deepEqual((await host.runQuickAction(ada, 'ac:1', 'de', { control: 'mode', value: 'auto' })).body.message, 'ac:1 mode string auto');
      assert.deepEqual((await host.runQuickAction(ada, 'ac:1', 'de', { control: 'mode', value: 'auto' })).body.widget, { label: null, ...ok, readings: [], power: true, badge: null });
      assert.deepEqual((await host.runQuickAction(ada, 'ac:1')).body, { ok: true, unchanged: false, message: 'ac:1 undefined undefined undefined', state: 'on', widget: null });
      for (const [control, value] of [['fan', 50], ['', 1], [5, 1], ['target', 31], ['target', 15.5], ['target', '22'], ['target', NaN], ['mode', 'heat'], ['mode', 1], ['mode', undefined]]) {
        const r = await host.runQuickAction(ada, 'ac:1', 'de', { control, value });
        assert.equal(r.status, 400, `${control} ${value}`);
        assert.equal(r.body.error, typeof control === 'string' && ['target', 'mode'].includes(control) ? 'invalid_value' : 'invalid_control');
      }
      assert.equal((await host.runQuickAction(ada, 'plain', 'de', { control: 'target', value: 22 })).status, 400, 'no widget, no control');
      await assert.rejects(host.runQuickAction(ada, 'ac:1', 'de', { control: 'target', value: 22, automation: true, via: 'gatecontrol-other' }), { code: 'ERR_INVALID' }, 'never through gc.actions.run');
      const ctl = (c) => ({ ...ok, controls: [{ ...ok.controls[0], ...c }] });
      for (const bad of [
        [], 'x', { value: 'x'.repeat(25) }, { unit: 'x'.repeat(9) }, { status: 'x'.repeat(61) }, { state: 'on ' }, { state: 'bad' },
        { controls: {} }, { controls: [1] }, { controls: ok.controls.concat(ok.controls, ok.controls) }, { controls: [ok.controls[0], ok.controls[0]] },
        ctl({ id: 'a b' }), ctl({ id: 'x'.repeat(25) }), ctl({ kind: 'knob' }), ctl({ label: 'x'.repeat(21) }), ctl({ unit: 'x'.repeat(9) }),
        ctl({ value: 31 }), ctl({ value: 15 }), ctl({ value: '22' }), ctl({ min: 30, max: 16 }), ctl({ step: 0 }), ctl({ step: -1 }), ctl({ max: undefined }),
        { controls: [{ ...ok.controls[1], options: [{ id: 'auto', label: 'Auto' }] }] }, { controls: [{ ...ok.controls[1], value: 'heat' }] },
        { controls: [{ ...ok.controls[1], options: [{ id: 'auto', label: 'Auto' }, { id: 'auto', label: 'Auto' }] }] },
        { controls: [{ ...ok.controls[1], options: [{ id: 'auto', label: 'Auto' }, { id: 'cool' }] }] },
        { controls: [{ ...ok.controls[1], options: Array.from({ length: 9 }, (_, i) => ({ id: 'o' + i, label: 'O' })) }] },
      ]) {
        host.plugin._set(bad);
        await assert.rejects(host.quickActions(ada), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 80));
      }
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host devices (GateControl ≥ 1.172.0): device, look, confirmWhen, widget label/readings/power, tile items', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-device-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'qa-device-test', name: 'QA', version: '1.0.0', entry: 'server/index.js', permissions: { portal: true } }));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      let answer = [];
      let tiles = [];
      module.exports = {
        _set(a) { answer = a; },
        _tiles(t) { tiles = t; },
        async quickActions() { return answer; },
        async runQuickAction() { return { ok: true, state: 'on', widget: answer[0] && answer[0].widget }; },
        async portalTiles() { return tiles; },
      };`);
    const host = await createHost(tmp);
    const ada = { id: 2, name: 'Ada', role: 'user' };
    const LOCK = 'M5 11h14v10H5z';
    const device = { id: 'v:1', title: 'Elroq', subtitle: 'Enyaq', icon: 'M5 16l1-5' };
    const lock = { id: 'lock:1', title: 'Verriegelt', kind: 'toggle', state: 'on', confirm: true, confirmWhen: 'off', look: { on: { icon: LOCK, tone: 'good' }, off: { tone: 'crit' } }, device };
    const widget = { label: 'Ladestand', value: 74, unit: '%', readings: [{ id: 'range', label: 'Reichweite', value: 310, unit: 'km', icon: 'M3 19h18' }, { id: 'lock', label: 'Verriegelung', icon: LOCK, state: 'good' }], power: false };
    try {
      host.plugin._set([{ id: 'climate:1', title: 'Klima', kind: 'toggle', device, widget }, lock, { id: 'scene:1', title: 'Abend', device: { id: 'r:1', title: 'Wohnzimmer' } }]);
      const list = await host.quickActions(ada);
      assert.deepEqual(list[0].device, device);
      assert.deepEqual(list[0].widget, {
        label: 'Ladestand', value: 74, unit: '%', status: null, state: null, controls: [], power: false, badge: null,
        readings: [{ id: 'range', label: 'Reichweite', value: 310, unit: 'km', icon: 'M3 19h18', state: null }, { id: 'lock', label: 'Verriegelung', value: null, unit: null, icon: LOCK, state: 'good' }],
      });
      assert.deepEqual([list[0].look, list[0].confirmWhen], [null, null]);
      assert.deepEqual([list[1].confirm, list[1].confirmWhen, list[1].look], [true, 'off', { on: { icon: LOCK, tone: 'good' }, off: { icon: null, tone: 'crit' } }]);
      assert.deepEqual(list[2].device, { id: 'r:1', title: 'Wohnzimmer', subtitle: null, icon: null });
      assert.deepEqual([list[2].look, list[2].confirmWhen], [null, null]);
      assert.equal((await host.runQuickAction(ada, 'climate:1')).body.widget.power, false, 'a run answer is checked the same way');
      // a widget with only readings is fine
      host.plugin._set([{ id: 'a', title: 'A', widget: { readings: [{ id: 'x', label: 'X', value: 'ok' }] } }]);
      assert.deepEqual((await host.quickActions(ada))[0].widget, { label: null, value: null, unit: null, status: null, state: null, controls: [], readings: [{ id: 'x', label: 'X', value: 'ok', unit: null, icon: null, state: null }], power: true, badge: null });
      const rd = (r) => [{ id: 'a', title: 'A', widget: { readings: [{ id: 'x', label: 'X', value: 1, ...r }] } }];
      for (const bad of [
        [{ id: 'a', title: 'A', device: 'v:1' }], [{ id: 'a', title: 'A', device: { id: 'v 1', title: 'X' } }], [{ id: 'a', title: 'A', device: { id: 'v:1' } }],
        [{ id: 'a', title: 'A', device: { id: 'v:1', title: 'x'.repeat(41) } }], [{ id: 'a', title: 'A', device: { id: 'v:1', title: 'X', subtitle: 'x'.repeat(61) } }],
        [{ id: 'a', title: 'A', device: { id: 'v:1', title: 'X', icon: '<svg>' } }],
        [{ id: 'a', title: 'A', look: { on: { tone: 'good' } } }], [{ id: 'a', title: 'A', confirmWhen: 'off' }], [{ ...lock, confirmWhen: 'maybe' }],
        [{ ...lock, look: {} }], [{ ...lock, look: { on: {} } }], [{ ...lock, look: { on: { tone: 'red' } } }], [{ ...lock, look: { off: { icon: '<x>' } } }], [{ ...lock, look: 'good' }],
        [{ id: 'a', title: 'A', widget: { label: 'x'.repeat(25) } }], [{ id: 'a', title: 'A', widget: { power: 'no' } }], [{ id: 'a', title: 'A', widget: { readings: {} } }],
        [{ id: 'a', title: 'A', widget: { readings: Array.from({ length: 5 }, (_, i) => ({ id: 'r' + i, label: 'R', value: i })) } }],
        [{ id: 'a', title: 'A', widget: { readings: [{ id: 'x', label: 'X', value: 1 }, { id: 'x', label: 'Y', value: 2 }] } }],
        rd({ id: 'a b' }), rd({ label: undefined }), rd({ label: 'x'.repeat(21) }), rd({ value: 'x'.repeat(17) }), rd({ value: Infinity }), rd({ value: undefined }),
        rd({ unit: 'x'.repeat(9) }), rd({ icon: '<svg>' }), rd({ state: 'neutral' }),
      ]) {
        host.plugin._set(bad);
        await assert.rejects(host.quickActions(ada), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 80));
      }
      // Start tiles: the portal gets the hook's answer, the apps items (always a list)
      const tile = { section: 's', title: 'Elroq', value: '74 % · 310 km', state: 'good', icon: LOCK, items: [{ label: 'Ladestand', icon: LOCK, value: 74, unit: '%', state: 'good' }, { label: 'Entriegelt', icon: LOCK, state: 'crit' }] };
      host.plugin._tiles([tile, { title: 'Plain', value: 3 }]);
      assert.deepEqual(await host.portalTiles(ada), [tile, { title: 'Plain', value: 3 }]);
      assert.deepEqual(await host.clientTiles(ada), [
        { section: 's', title: 'Elroq', value: '74 % · 310 km', unit: null, state: 'good', icon: LOCK, items: [{ label: 'Ladestand', value: 74, unit: '%', icon: LOCK, state: 'good' }, { label: 'Entriegelt', value: null, unit: null, icon: LOCK, state: 'crit' }] },
        { section: null, title: 'Plain', value: '3', unit: null, state: null, icon: null, items: [] },
      ]);
      for (const items of [{}, Array.from({ length: 5 }, () => ({ label: 'X', value: 1 })), [{ label: 'X' }], [{ value: 1 }], [{ label: 'X', value: 1, state: 'red' }], [{ label: 'X', icon: 'x<' }]]) {
        host.plugin._tiles([{ title: 'T', items }]);
        await assert.rejects(host.portalTiles(ada), { code: 'ERR_INVALID' }, JSON.stringify(items).slice(0, 80));
        await assert.rejects(host.clientTiles(ada), { code: 'ERR_INVALID' });
      }
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host widget badge (GateControl ≥ 1.175.0): always in the answer, checked like the host', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-badge-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'qa-badge-test', name: 'QA', version: '1.0.0', entry: 'server/index.js', permissions: { portal: true } }));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      let answer = [];
      module.exports = {
        _set(a) { answer = a; },
        async quickActions() { return answer; },
        async runQuickAction() { return { ok: true, state: 'on', widget: answer[0] && answer[0].widget }; },
      };`);
    const host = await createHost(tmp);
    const ada = { id: 2, name: 'Ada', role: 'user' };
    const BAT = 'M3 7h15v10H3zM21 10v4';
    const wb = (badge) => [{ id: 'climate:1', title: 'Klima', kind: 'toggle', widget: { value: null, readings: [{ id: 'range', label: 'Reichweite', value: 310, unit: 'km' }], badge } }];
    try {
      host.plugin._set(wb({ icon: BAT, value: 74, unit: '%', state: 'good', label: 'Ladestand' }));
      const w = (await host.quickActions(ada))[0].widget;
      assert.deepEqual(w.badge, { icon: BAT, value: 74, unit: '%', state: 'good', label: 'Ladestand' });
      assert.deepEqual([w.label, w.value, w.unit], [null, null, null], 'a widget without a main value');
      assert.equal(Object.keys(w).at(-1), 'badge', 'the widget\'s last key, as the host');
      assert.deepEqual((await host.runQuickAction(ada, 'climate:1')).body.widget.badge, w.badge, 'a run answer is checked the same way');
      // only the icon is required; the rest comes back as null
      host.plugin._set(wb({ icon: BAT, value: 'voll' }));
      assert.deepEqual((await host.quickActions(ada))[0].widget.badge, { icon: BAT, value: 'voll', unit: null, state: null, label: null });
      for (const none of [undefined, null]) {
        host.plugin._set(wb(none));
        assert.equal((await host.quickActions(ada))[0].widget.badge, null, 'no badge → null');
      }
      for (const bad of [
        'x', [], {}, { value: 5 }, { icon: '<svg>' }, { icon: 5 }, { icon: BAT, value: '123456789' }, { icon: BAT, value: true }, { icon: BAT, value: '' },
        { icon: BAT, value: 1, unit: 'Watts' }, { icon: BAT, unit: '%' }, { icon: BAT, value: ' 5' }, { icon: BAT, state: 'on' }, { icon: BAT, state: 'off' }, { icon: BAT, state: 'neutral' }, { icon: BAT, label: 'x'.repeat(21) }, { icon: BAT, label: ' x' },
      ]) {
        host.plugin._set(wb(bad));
        await assert.rejects(host.quickActions(ada), { code: 'ERR_INVALID' }, JSON.stringify(bad));
      }
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host kiosk users: needs permissions.kiosk, never an administrator or a disabled user', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-plugin-'));
  const write = (permissions) => fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'kiosk-test', name: 'K', version: '1.0.0', entry: 'server/index.js', permissions }));
  const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Küche', role: 'user' }, { id: 3, name: 'Alt', role: 'user', disabled: true }];
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    write({ users: true, kiosk: true });
    const host = await createHost(tmp, { users, kiosk: [9] });
    try {
      assert.deepEqual(await host.gc.kiosk.list(), [9]);
      await host.gc.kiosk.allow(2, true);
      await host.gc.kiosk.allow(2, true);
      assert.deepEqual(await host.gc.kiosk.list(), [2, 9]);
      assert.deepEqual((await host.gc.users.list()).map(({ id, name, role }) => ({ id, name, role })), users.slice(0, 2).map(({ id, name, role }) => ({ id, name, role })), 'disabled accounts are not listed');
      for (const [id, allowed] of [[1, true], [3, true], [4, true], [2, 'yes'], ['2', true], [0, false]]) {
        await assert.rejects(host.gc.kiosk.allow(id, allowed), { code: 'ERR_INVALID' }, `${id} ${allowed}`);
      }
      await host.gc.kiosk.allow(2, false);
      assert.deepEqual([...host.kiosk], [9]);
    } finally {
      await host.close();
    }
    write({ storage: true });
    const without = await createHost(tmp, { users });
    try {
      await assert.rejects(without.gc.kiosk.allow(2, true), { code: 'ERR_KIOSK_DENIED' });
      await assert.rejects(without.gc.kiosk.list(), { code: 'ERR_KIOSK_DENIED' });
    } finally {
      await without.close();
    }
    write({ kiosk: 'yes' });
    await assert.rejects(createHost(tmp, { users }), { code: 'ERR_INVALID' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host gc.users faces (GateControl ≥ 1.168.0): avatarUrl, colour key (default palette[id % 10]), colorHex, initials', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'face-plugin-'));
  const pic = '/avatars/' + 'a'.repeat(22) + '.webp';
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'face-test', name: 'F', version: '1.0.0', entry: 'server/index.js', permissions: { users: true } }));
    const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna Berg', role: 'user', color: 'pink', avatarUrl: pic }, { id: 13, name: 'Tim', role: 'user', color: 'red' }];
    const host = await createHost(tmp, { users });
    try {
      assert.deepEqual(await host.gc.users.list(), [
        { id: 1, name: 'admin', role: 'admin', avatarUrl: null, color: 'teal', colorHex: '#14B8A6', initials: 'AD' },
        { id: 2, name: 'Anna Berg', role: 'user', avatarUrl: pic, color: 'pink', colorHex: '#EC4899', initials: 'AB' },
        { id: 13, name: 'Tim', role: 'user', avatarUrl: null, color: 'lime', colorHex: '#84CC16', initials: 'TI' },
      ], 'red is no favourite colour: the default');
      host.setUserFace(13, { color: 'indigo', avatarUrl: pic });
      assert.deepEqual(await host.gc.users.get(13), { id: 13, name: 'Tim', role: 'user', avatarUrl: pic, color: 'indigo', colorHex: '#6366F1', initials: 'TI' });
      host.setUserFace(13, { avatarUrl: null });
      assert.equal((await host.gc.users.get(13)).avatarUrl, null);
      assert.throws(() => host.setUserFace(13, { avatarUrl: '/avatars/x.gif' }), { code: 'ERR_INVALID' });
    } finally {
      await host.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host plugin actions: needs permissions.actions, checked like the host, other plugins only, 60 runs per hour', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-plugin-'));
  const write = (permissions) => fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'actions-test', name: 'A', version: '1.0.0', entry: 'server/index.js', permissions }));
  const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Alt', role: 'user', disabled: true }];
  const seen = [];
  const actions = [
    { plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home',
      quickActions: (viewer) => (viewer.id === 2 ? [{ id: 'scene:evening', title: 'Abend', icon: 'M3 3h18', confirm: true }, { id: 'light:1', title: 'Flur', kind: 'toggle', state: 'off' }] : []),
      runQuickAction: (viewer, id) => { seen.push([viewer, id]); if (id === 'light:1') throw new Error('boom'); return { ok: true, message: 'Szene gestartet' }; } },
    { plugin: 'actions-test', actions: [{ id: 'own', title: 'Own' }] },
  ];
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), 'module.exports = {};');
    write({ users: true, actions: true });
    const host = await createHost(tmp, { users, actions });
    try {
      assert.deepEqual(await host.gc.actions.list({ userId: 2, lang: 'de' }), [
        { plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home', id: 'scene:evening', title: 'Abend', subtitle: null, icon: 'M3 3h18', kind: 'button', state: null, verbs: null, targets: false, device: null },
        { plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home', id: 'light:1', title: 'Flur', subtitle: null, icon: null, kind: 'toggle', state: 'off', verbs: null, targets: false, device: null },
      ], 'no confirm, never the caller itself');
      assert.deepEqual(await host.gc.actions.list({ userId: 1 }), []);
      assert.deepEqual(await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { ok: true, message: 'Szene gestartet', state: null, unchanged: false });
      assert.deepEqual(seen[0][0], { id: 2, name: 'Anna', role: 'user', portal: true, loggedIn: true, automation: true, via: 'actions-test' });
      assert.deepEqual(await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'light:1' }), { ok: false, message: null, state: null, unchanged: false, error: 'plugin_error' });
      assert.deepEqual(await host.gc.actions.run({ userId: 1, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { ok: false, message: null, state: null, unchanged: false, error: 'not_found' }, 'not listed for that user');
      assert.deepEqual(await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-nothing', id: 'x' }), { ok: false, message: null, state: null, unchanged: false, error: 'not_found' });
      for (const bad of [{ userId: '2', plugin: 'gatecontrol-smarthome', id: 'x' }, { userId: 3, plugin: 'gatecontrol-smarthome', id: 'x' }, { userId: 9, plugin: 'gatecontrol-smarthome', id: 'x' },
        { userId: 2, plugin: 'actions-test', id: 'own' }, { userId: 2, plugin: 'Bad_Id', id: 'x' }, { userId: 2, plugin: 'gatecontrol-smarthome', id: 'bad id' }, { userId: 2, plugin: 'gatecontrol-smarthome', id: 'x', lang: 'fr' }]) {
        await assert.rejects(host.gc.actions.run(bad), { code: 'ERR_INVALID' }, JSON.stringify(bad));
      }
      await assert.rejects(host.gc.actions.list({ userId: 3 }), { code: 'ERR_INVALID' });
      assert.equal(host.actionRuns.length, 4);
      for (let i = 4; i < 60; i++) await host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' });
      await assert.rejects(host.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { code: 'ERR_RATE_LIMIT' });
    } finally {
      await host.close();
    }
    write({ users: true });
    const without = await createHost(tmp, { users, actions });
    try {
      await assert.rejects(without.gc.actions.list({ userId: 2 }), { code: 'ERR_ACTIONS_DENIED' });
      await assert.rejects(without.gc.actions.run({ userId: 2, plugin: 'gatecontrol-smarthome', id: 'scene:evening' }), { code: 'ERR_ACTIONS_DENIED' });
    } finally {
      await without.close();
    }
    write({ actions: 'yes' });
    await assert.rejects(createHost(tmp, { users }), { code: 'ERR_INVALID' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host GateControl 1.169.0: push pictures, quick_action push actions, 5 s background, via/automation of quick action runs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc169-plugin-'));
  const write = (permissions) => fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'gc169-test', name: 'T', version: '1.0.0', entry: 'server/index.js', permissions, notifyTopics: [{ id: 'bell', label: 'Bell' }] }));
  const jpeg = (w, h, pad = 10) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(pad), Buffer.from([0xff, 0xd9])]);
  const png = (w, h, animated) => {
    const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...(animated ? [chunk('acTL', Buffer.alloc(8))] : []), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
  };
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      module.exports = {
        async quickActions({ user }) { return user.id === 2 ? [{ id: 'door:open', title: 'Door' }] : []; },
        async runQuickAction(arg) { return { ok: true, message: [arg.via, arg.automation, !!arg.user.app, arg.user.automation === true].join(' ') }; },
      };`);
    write({ portal: true, notify: true, background: { intervalSeconds: 5 } });
    const host = await createHost(tmp, { users: [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Ada', role: 'user' }] });
    try {
      const img = jpeg(640, 360);
      const r = await host.gc.notify({ topic: 'bell', title: 'Ring', ttl: 10 * 86400, image: { data: img.toString('base64'), mime: 'image/jpeg' } });
      assert.equal(r.pushed, true);
      const n = host.notifications[0];
      assert.deepEqual(n.image, { mime: 'image/jpeg', size: img.length, width: 640, height: 360 });
      assert.match(n.imageUrl, /^\/notify-media\/[A-Za-z0-9_-]{22,}\.jpg$/);
      assert.equal(n.imageTtl, 7 * 86400, 'the picture lives at most 7 days');
      await host.gc.notify({ topic: 'bell', title: 'Ring', image: { data: 'data:image/png;base64,' + png(64, 64).toString('base64'), mime: 'image/png' } });
      assert.equal(host.notifications[1].imageTtl, 86400);
      for (const bad of [
        { data: img.toString('base64'), mime: 'image/png' }, { data: jpeg(20, 360).toString('base64'), mime: 'image/jpeg' }, { data: jpeg(3000, 360).toString('base64'), mime: 'image/jpeg' },
        { data: jpeg(640, 360, 301 * 1024).toString('base64'), mime: 'image/jpeg' }, { data: png(64, 64, true).toString('base64'), mime: 'image/png' },
        { data: img.toString('base64'), mime: 'image/gif' }, { data: '###', mime: 'image/jpeg' }, 'x',
      ]) await assert.rejects(host.gc.notify({ topic: 'bell', title: 'Ring', image: bad }), { code: 'ERR_INVALID' }, JSON.stringify(bad).slice(0, 50));
      assert.equal(host.notifications.length, 2, 'a bad picture pushes nothing');
      const qa = { type: 'quick_action', label: 'Tür öffnen', plugin: 'gc169-test', id: 'door:open', confirm: true, auth: 'device' };
      await host.gc.notify({ topic: 'bell', title: 'Ring', data: { actions: [qa, { type: 'open_app_route', label: 'Ansehen', target: 'plg-gc169-test' }] } });
      for (const bad of [{ ...qa, plugin: 'gatecontrol-other' }, { ...qa, label: 'x'.repeat(25) }, { ...qa, label: '' }, { ...qa, id: 'bad id' }, { ...qa, auth: 'pin' }, { ...qa, confirm: 'yes' }]) {
        await assert.rejects(host.gc.notify({ topic: 'bell', title: 'Ring', data: { actions: [bad] } }), { code: 'ERR_INVALID' }, JSON.stringify(bad));
      }
      const ada = { id: 2, name: 'Ada', role: 'user' };
      assert.equal((await host.runQuickAction(ada, 'door:open')).body.message, 'app false true false');
      assert.equal((await host.runQuickAction(ada, 'door:open', 'de', { via: 'notification' })).body.message, 'notification false true false');
      assert.equal((await host.runQuickAction(ada, 'door:open', 'de', { automation: true, via: 'gatecontrol-familie' })).body.message, 'gatecontrol-familie true false true');
      await assert.rejects(host.runQuickAction(ada, 'door:open', 'de', { automation: true, via: 'gc169-test' }), { code: 'ERR_INVALID' });
    } finally {
      await host.close();
    }
    for (const iv of [4, 86401, '5']) {
      write({ background: { intervalSeconds: iv } });
      await assert.rejects(createHost(tmp), { code: 'ERR_INVALID' }, String(iv));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock host GateControl 1.173.0: verbs and targets of toggles, runs with a target state (route and gc.actions.run)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc173-plugin-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ id: 'gc173-test', name: 'T', version: '1.0.0', entry: 'server/index.js', permissions: { portal: true, users: true, actions: true } }));
    fs.writeFileSync(path.join(tmp, 'server', 'index.js'), `
      let list = null;
      const calls = [];
      module.exports = {
        _set(l) { list = l; }, calls,
        async quickActions() { return list || [
          { id: 'lock:1', title: 'Schloss', kind: 'toggle', state: 'on', verbs: { on: 'Verriegeln', off: 'Entriegeln' }, targets: true },
          { id: 'old:1', title: 'Alt', kind: 'toggle', state: 'on', widget: { value: 'An' } },
          { id: 'unknown:1', title: 'Unklar', kind: 'toggle' },
          { id: 'scene:1', title: 'Abend' },
        ]; },
        async runQuickAction(a) { calls.push([a.id, a.target === undefined ? 'none' : a.target]); return { ok: true, message: 'ran', state: a.target || 'off' }; },
      };`);
    const users = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Ada', role: 'user' }];
    const host = await createHost(tmp, { users });
    const ada = users[1];
    try {
      const list = await host.quickActions(ada);
      assert.deepEqual(list.map((a) => [a.id, a.verbs, a.targets]), [
        ['lock:1', { on: 'Verriegeln', off: 'Entriegeln' }, true], ['old:1', null, false], ['unknown:1', null, false], ['scene:1', null, false],
      ], 'always present: verbs (object or null), targets (boolean)');
      assert.deepEqual(Object.keys(list[0]), ['id', 'title', 'subtitle', 'icon', 'kind', 'state', 'confirm', 'confirmWhen', 'look', 'verbs', 'targets', 'device', 'widget'], 'the host\'s key order');
      // targets: true → the hook gets the target, even for the state it already has
      assert.deepEqual(await host.runQuickAction(ada, 'lock:1', 'de', { state: 'on' }), { status: 200, body: { ok: true, message: 'ran', state: 'on', widget: null, unchanged: false } });
      assert.deepEqual(host.plugin.calls.at(-1), ['lock:1', 'on']);
      // targets: false → the listed state decides
      assert.deepEqual(await host.runQuickAction(ada, 'old:1', 'de', { state: 'on' }), { status: 200, body: { ok: true, message: null, state: 'on', widget: { label: null, value: 'An', unit: null, status: null, state: null, controls: [], readings: [], power: true, badge: null }, unchanged: true } });
      assert.equal(host.plugin.calls.length, 1, 'already there: no hook call');
      assert.equal((await host.runQuickAction(ada, 'old:1', 'de', { state: 'off' })).body.unchanged, false);
      assert.deepEqual(host.plugin.calls.at(-1), ['old:1', 'none'], 'the other state: the hook flips as without a state');
      assert.deepEqual(await host.runQuickAction(ada, 'unknown:1', 'de', { state: 'off' }), { status: 409, body: { ok: false, error: 'state_unknown' } });
      for (const [id, o] of [['scene:1', { state: 'on' }], ['lock:1', { state: 'yes' }], ['lock:1', { state: '' }], ['lock:1', { state: 'on', control: 'x' }]]) {
        assert.deepEqual(await host.runQuickAction(ada, id, 'de', o), { status: 400, body: { ok: false, error: 'invalid_state' } }, `${id} ${JSON.stringify(o)}`);
      }
      assert.equal((await host.runQuickAction(ada, 'lock:1')).body.unchanged, false);
      assert.deepEqual(host.plugin.calls.at(-1), ['lock:1', 'none'], 'without a state: as before');
      assert.equal((await host.runQuickAction(ada, 'lock:1', 'de', { state: null })).body.unchanged, false);
      assert.deepEqual(host.plugin.calls.at(-1), ['lock:1', 'none'], 'state null: a plain run');
      assert.equal((await host.runQuickAction(ada, 'gone:1', 'de', { state: 'bad' })).status, 404, 'unlisted: 404 before the state check');
      for (const bad of [[{ id: 'b', title: 'B', verbs: { on: 'An', off: 'Aus' } }], [{ id: 'b', title: 'B', targets: true }], [{ id: 't', title: 'T', kind: 'toggle', targets: 'yes' }],
        [{ id: 't', title: 'T', kind: 'toggle', verbs: { on: 'An' } }], [{ id: 't', title: 'T', kind: 'toggle', verbs: { on: 'An', off: 'x'.repeat(21) } }],
        [{ id: 't', title: 'T', kind: 'toggle', verbs: { on: ' An', off: 'Aus' } }], [{ id: 't', title: 'T', kind: 'toggle', verbs: { on: 'A\tn', off: 'Aus' } }], [{ id: 't', title: 'T', kind: 'toggle', verbs: ['An', 'Aus'] }]]) {
        host.plugin._set(bad);
        await assert.rejects(host.quickActions(ada), { code: 'ERR_INVALID' }, JSON.stringify(bad));
      }
    } finally {
      await host.close();
    }
    // gc.actions.list / run of another plugin's actions
    const seen = [];
    const other = {
      plugin: 'gatecontrol-skoda', pluginName: 'Fahrzeuge',
      quickActions: () => [
        { id: 'lock:1', title: 'Schloss', kind: 'toggle', state: 'on', verbs: { on: 'Verriegeln', off: 'Entriegeln' }, targets: true, device: { id: 'v:1', title: 'Elroq' } },
        { id: 'old:1', title: 'Alt', kind: 'toggle', state: 'off' }, { id: 'unknown:1', title: 'Unklar', kind: 'toggle' }, { id: 'scene:1', title: 'Abend' },
      ],
      runQuickAction: (viewer, id, lang, extra) => { seen.push([id, extra === undefined ? 'none' : extra.target]); return { ok: true, message: 'ok', state: (extra && extra.target) || 'on' }; },
    };
    const auto = await createHost(tmp, { users, actions: [other] });
    try {
      const listed = await auto.gc.actions.list({ userId: 2 });
      assert.deepEqual(listed[0], {
        plugin: 'gatecontrol-skoda', pluginName: 'Fahrzeuge', id: 'lock:1', title: 'Schloss', subtitle: null, icon: null, kind: 'toggle', state: 'on',
        verbs: { on: 'Verriegeln', off: 'Entriegeln' }, targets: true, device: { id: 'v:1', title: 'Elroq', subtitle: null, icon: null },
      });
      const run = (id, state) => auto.gc.actions.run({ userId: 2, plugin: 'gatecontrol-skoda', id, state });
      assert.deepEqual(await run('lock:1', 'on'), { ok: true, message: 'ok', state: 'on', unchanged: false });
      assert.deepEqual(seen.at(-1), ['lock:1', 'on'], 'locked + target on: still the hook with the target');
      assert.deepEqual(await run('old:1', 'off'), { ok: true, message: null, state: 'off', unchanged: true });
      assert.equal(seen.length, 1);
      assert.deepEqual(await run('old:1', 'on'), { ok: true, message: 'ok', state: 'on', unchanged: false });
      assert.deepEqual(seen.at(-1), ['old:1', 'none']);
      assert.deepEqual(await run('unknown:1', 'on'), { ok: false, message: null, state: null, unchanged: false, error: 'state_unknown' });
      assert.deepEqual(await run('scene:1', 'on'), { ok: false, message: null, state: null, unchanged: false, error: 'invalid_state' });
      assert.deepEqual(await run('lock:1', 'up'), { ok: false, message: null, state: null, unchanged: false, error: 'invalid_state' });
      assert.deepEqual(await run('scene:1'), { ok: true, message: 'ok', state: 'on', unchanged: false });
      assert.deepEqual(auto.actionRuns.map((r) => [r.id, r.state, r.target]), [['lock:1', 'on', 'on'], ['old:1', 'off', null], ['old:1', 'on', null], ['unknown:1', 'on', null], ['scene:1', 'on', null], ['lock:1', 'up', null], ['scene:1', null, null]]);
    } finally {
      await auto.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalog keeps every version and picks the latest stable one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  try {
    const entry = (version, prerelease) => ({ schema: 1, id: 'demo', name: { de: 'Demo', en: 'Demo' }, version, prerelease, sha256: 'a'.repeat(64), url: `https://x/${version}` });
    for (const [v, p] of [['1.0.0', false], ['1.2.0', false], ['2.0.0-rc.1', true]]) fs.writeFileSync(path.join(tmp, `demo-${v}.index.json`), JSON.stringify(entry(v, p)));
    execFileSync(process.execPath, [path.join(TOOLS, 'catalog.js'), tmp, '--out', path.join(tmp, 'catalog.json'), '--repo', 'o/r']);
    const c = JSON.parse(fs.readFileSync(path.join(tmp, 'catalog.json'), 'utf8'));
    assert.equal(c.schema, 1);
    assert.equal(c.plugins.demo.latest.version, '1.2.0');
    assert.deepEqual(c.plugins.demo.versions.map((v) => v.version), ['2.0.0-rc.1', '1.2.0', '1.0.0']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalog: store metadata from catalog-meta.json and release notes from the CHANGELOG', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-meta-'));
  try {
    const entry = (id, version, prerelease = false) => ({ schema: 1, id, name: { de: id, en: id }, description: { de: 'd', en: 'd' }, publisher: 'p', version, prerelease, sha256: 'a'.repeat(64), url: `https://x/${id}/${version}` });
    for (const [id, v, p] of [['gatecontrol-hello', '1.0.0'], ['gatecontrol-hello', '1.1.0-rc.1', true], ['demo', '1.0.0'], ['gatecontrol-familie', '1.9.0']]) {
      fs.writeFileSync(path.join(tmp, `${id}-${v}.index.json`), JSON.stringify(entry(id, v, p)));
    }
    const meta = { plugins: { 'gatecontrol-hello': { category: 'other', icon: 'puzzle', summary: { de: 'Hallo', en: 'Hello' }, audience: 'admins', keywords: ['hallo'], related: ['gatecontrol-door'], extra: 'not copied' } } };
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta));
    const build = (...extra) => {
      execFileSync(process.execPath, [path.join(TOOLS, 'catalog.js'), tmp, '--out', path.join(tmp, 'catalog.json'), '--repo', 'o/r', ...extra]);
      return JSON.parse(fs.readFileSync(path.join(tmp, 'catalog.json'), 'utf8'));
    };

    let c = build('--meta', path.join(tmp, 'meta.json'));
    const hello = c.plugins['gatecontrol-hello'];
    assert.deepEqual(Object.keys(hello), ['id', 'name', 'description', 'publisher', 'latest', 'versions', 'category', 'icon', 'summary', 'audience', 'keywords', 'related']);
    assert.equal(hello.icon, 'puzzle');
    assert.deepEqual(hello.related, ['gatecontrol-door']);
    assert.equal(hello.latest.version, '1.0.0');
    assert.equal(hello.latest.notes, lib.changelogSection('gatecontrol-hello', '1.0.0'));
    assert.match(hello.latest.notes, /Erste Version/);
    assert.equal(hello.versions[1].notes, hello.latest.notes);
    assert.ok(!('notes' in hello.versions[0]), 'no CHANGELOG section → no notes');
    assert.ok(!('notes' in c.plugins.demo.latest), 'no plugin folder → no notes');
    assert.ok(!('category' in c.plugins.demo), 'no meta entry → no store fields');
    assert.deepEqual(Object.keys(c.plugins['gatecontrol-familie']), ['id', 'name', 'description', 'publisher', 'latest', 'versions'], 'not in this meta file');

    c = build('--meta', path.join(tmp, 'missing.json'));
    assert.ok(!('category' in c.plugins['gatecontrol-hello']), 'missing meta file → no store fields');
    assert.match(c.plugins['gatecontrol-hello'].latest.notes, /Erste Version/);

    fs.writeFileSync(path.join(tmp, 'broken.json'), '{');
    const r = spawnSync(process.execPath, [path.join(TOOLS, 'catalog.js'), tmp, '--out', path.join(tmp, 'catalog.json'), '--meta', path.join(tmp, 'broken.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'broken meta never stops the catalogue');
    assert.match(r.stderr, /store metadata left out/);

    c = build(); // the repository's catalog-meta.json
    const familie = c.plugins['gatecontrol-familie'];
    assert.equal(familie.category, 'family');
    assert.equal(familie.highlight.version, '1.9.0');
    assert.ok(familie.latest.notes.length > 100 && familie.latest.notes.length <= 6000);
    assert.equal(c.plugins['gatecontrol-hello'].category, undefined, 'the example has no store metadata');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalog: release notes are capped at 6000 characters on a line end', () => {
  const { capNotes, NOTES_MAX } = require('../catalog');
  assert.equal(capNotes(null), null);
  assert.equal(capNotes('  \n '), null);
  assert.equal(capNotes('\n- a\n- b\n'), '- a\n- b');
  const line = '- ' + 'x'.repeat(97); // 99 characters + "\n"
  const long = Array.from({ length: 100 }, () => line).join('\n');
  const n = capNotes(long);
  assert.ok(n.length <= NOTES_MAX, String(n.length));
  assert.ok(n.endsWith('\n…'));
  assert.ok(n.slice(0, -2).split('\n').every((l) => l === line), 'cut between lines');
  assert.equal(n.slice(0, -2).split('\n').length, 59);
  const oneLine = capNotes('y'.repeat(7000));
  assert.equal(oneLine.length, NOTES_MAX);
  assert.ok(oneLine.endsWith('\n…'));
  assert.equal(capNotes('z'.repeat(NOTES_MAX)), 'z'.repeat(NOTES_MAX));
});

test('catalog-meta.json: valid, and checked strictly', () => {
  const { validateMeta, validateFile, FILE } = require('../catalog-meta');
  assert.deepEqual(validateFile(), [], 'the repository file');
  const raw = lib.readJson(FILE);
  for (const id of lib.listPlugins().filter((i) => lib.pluginConfig(i).release)) assert.ok(raw.plugins[id], `${id} has store metadata`);

  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const changelog = (id, v) => v === '1.0.0';
  const ok = {
    category: 'home', icon: 'bulb', summary: { de: 'Licht.', en: 'Light.' }, audience: 'all', keywords: ['licht', 'light'], related: ['b'],
    highlight: { version: '1.0.0', title: { de: 'Neu', en: 'New' }, text: { de: 'Text', en: 'Text' } },
  };
  const check = (m, root = {}) => validateMeta({ $comment: 'x', plugins: { a: m }, ...root }, { ids, changelog });
  assert.deepEqual(check(ok), []);
  assert.deepEqual(check({}), [], 'every field is optional');
  assert.deepEqual(validateMeta({ plugins: {} }, { ids, changelog }), []);
  const bad = [
    [{ ...ok, color: 'red' }, /unknown key "color"/],
    [{ ...ok, category: 'fun' }, /category: "fun" is not one of/],
    [{ ...ok, icon: 'rocket' }, /icon/],
    [{ ...ok, audience: 'kids' }, /audience/],
    [{ ...ok, summary: 'Licht.' }, /summary: not an object/],
    [{ ...ok, summary: { de: 'Licht.' } }, /summary\.en: missing/],
    [{ ...ok, summary: { de: 'Licht.', en: 'Light.', fr: 'Lumière.' } }, /unknown language "fr"/],
    [{ ...ok, summary: { de: 'x'.repeat(161), en: 'Light.' } }, /summary\.de: 161 characters \(max 160\)/],
    [{ ...ok, summary: { de: ' Licht.', en: 'Light.' } }, /whitespace/],
    [{ ...ok, keywords: 'licht' }, /keywords: not an array/],
    [{ ...ok, keywords: Array.from({ length: 13 }, (_, i) => 'k' + i) }, /keywords: 13 \(max 12\)/],
    [{ ...ok, keywords: ['Licht'] }, /not lowercase/],
    [{ ...ok, keywords: ['x'.repeat(33)] }, /longer than 32/],
    [{ ...ok, keywords: ['', 'a'] }, /keywords: invalid/],
    [{ ...ok, keywords: [1] }, /keywords: invalid/],
    [{ ...ok, keywords: ['a', 'a'] }, /keywords: duplicates/],
    [{ ...ok, related: ['a'] }, /related: names itself/],
    [{ ...ok, related: ['zz'] }, /related: "zz" is not a released plugin/],
    [{ ...ok, related: ['b', 'c', 'd', 'e', 'f'] }, /related: 5 \(max 4\)/],
    [{ ...ok, related: ['b', 'b'] }, /related: duplicates/],
    [{ ...ok, highlight: { ...ok.highlight, version: '1.0' } }, /highlight\.version: "1\.0" is not a version/],
    [{ ...ok, highlight: { ...ok.highlight, version: '2.0.0' } }, /no "## 2\.0\.0" section/],
    [{ ...ok, highlight: { ...ok.highlight, title: { de: 'x'.repeat(81), en: 'New' } } }, /highlight\.title\.de: 81 characters \(max 80\)/],
    [{ ...ok, highlight: { ...ok.highlight, text: { de: 'x'.repeat(281), en: 'Text' } } }, /highlight\.text\.de: 281 characters \(max 280\)/],
    [{ ...ok, highlight: { ...ok.highlight, text: undefined } }, /highlight\.text: not an object/],
    [{ ...ok, highlight: { ...ok.highlight, since: 'x' } }, /highlight: unknown key "since"/],
    ['x', /a: not an object/],
  ];
  for (const [m, re] of bad) {
    const errors = check(m);
    assert.ok(errors.some((e) => re.test(e)), `${JSON.stringify(m).slice(0, 80)} → ${JSON.stringify(errors)}`);
  }
  assert.match(validateMeta({ plugins: { zz: {} } }, { ids, changelog })[0], /zz: not a released plugin/);
  assert.match(check({}, { extra: 1 })[0], /unknown key "extra"/);
  assert.deepEqual(validateMeta({ plugins: [] }, { ids, changelog }), ['plugins: not an object']);
  assert.deepEqual(validateMeta(null, { ids, changelog }), ['not a JSON object']);
  assert.match(validateMeta({ plugins: { 'gatecontrol-hello': {} } })[0], /gatecontrol-hello: not a released plugin/, 'release: false');
});

test('pack → sign → verify round trip with a throwaway key', { skip: !gcDir && 'no GateControl checkout' }, () => {
  const signature = lib.gcRequire('src/services/plugins/signature');
  const kp = signature.generateKeyPair();
  const other = signature.generateKeyPair();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const run = (args, env) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  try {
    // dev builds are unsigned even when a key is in the environment
    let r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-hello', '--out', out], { GC_PLUGIN_SIGNING_KEY: kp.privateSeed });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /UNSIGNED/);
    const file = path.join(out, 'gatecontrol-hello-1.0.0.gcplugin');
    r = run([path.join(TOOLS, 'verify.js'), file], { GC_PLUGIN_PUBLIC_KEY: kp.publicKey });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /UNSIGNED/);

    // --sign without a key fails
    r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-hello', '--sign', '--out', out], { GC_PLUGIN_SIGNING_KEY: '' });
    assert.equal(r.status, 1);

    r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-hello', '--sign', '--out', out], { GC_PLUGIN_SIGNING_KEY: kp.privateSeed });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(\d+ bytes, signed\)/);
    assert.ok(!r.stdout.includes(kp.privateSeed) && !r.stderr.includes(kp.privateSeed));

    // the package holds no test files
    const files = lib.gcRequire('src/services/plugins/package').decode(fs.readFileSync(file));
    assert.ok(files.has('signature') && files.has('ui/page.html') && files.has('migrations/001_init.sql'));
    assert.ok(![...files.keys()].some((p) => p.startsWith('test/')));

    r = run([path.join(TOOLS, 'verify.js'), file, '--id', 'gatecontrol-hello', '--version', '1.0.0'], { GC_PLUGIN_PUBLIC_KEY: kp.publicKey, GITHUB_OUTPUT: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp('key id ' + signature.keyId(kp.publicKey)));

    r = run([path.join(TOOLS, 'verify.js'), file], { GC_PLUGIN_PUBLIC_KEY: other.publicKey });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /different key/);
    r = run([path.join(TOOLS, 'verify.js'), file], { GC_PLUGIN_PUBLIC_KEY: '' });
    assert.equal(r.status, 1);
    r = run([path.join(TOOLS, 'verify.js'), file, '--version', '2.0.0'], { GC_PLUGIN_PUBLIC_KEY: kp.publicKey });
    assert.equal(r.status, 1);

    // index entry + sha256 file
    r = run([path.join(TOOLS, 'index-entry.js'), file, '--tag', 'gatecontrol-hello-v1.0.0', '--repo', 'o/r', '--key-id', signature.keyId(kp.publicKey), '--public-key', kp.publicKey]);
    assert.equal(r.status, 0, r.stderr);
    const entry = JSON.parse(fs.readFileSync(path.join(out, 'gatecontrol-hello-1.0.0.index.json'), 'utf8'));
    assert.equal(entry.size, fs.statSync(file).size);
    assert.equal(entry.url, 'https://github.com/o/r/releases/download/gatecontrol-hello-v1.0.0/gatecontrol-hello-1.0.0.gcplugin');
    assert.equal(entry.gatecontrol, '>=1.146.0');
    assert.equal(fs.readFileSync(file + '.sha256', 'utf8'), `${entry.sha256}  gatecontrol-hello-1.0.0.gcplugin\n`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('--no-license: an unsigned dev build of a licensed plugin that a test server can install', { skip: !gcDir && 'no GateControl checkout' }, () => {
  const pkg = lib.gcRequire('src/services/plugins/package');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
  try {
    let r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-smarthome', '--no-license', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gatecontrol-smarthome-\d+\.\d+\.\d+-dev\.gcplugin .*UNSIGNED/);
    const file = fs.readdirSync(out).find((f) => f.endsWith('-dev.gcplugin'));
    const files = pkg.decode(fs.readFileSync(path.join(out, file)));
    const manifest = JSON.parse(files.get('plugin.json').toString('utf8'));
    assert.deepEqual(manifest.license, { required: false });
    assert.equal(files.has('signature'), false);
    assert.equal(lib.readJson(path.join(lib.pluginDir('gatecontrol-smarthome'), 'plugin.json')).license.required, true, 'the source stays licensed');
    r = run([path.join(TOOLS, 'pack.js'), 'gatecontrol-smarthome', '--no-license', '--sign', '--out', out]);
    assert.notEqual(r.status, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
