'use strict';

// The pages, the portal tab and the profile section: every text key they use exists in German and English, the render
// escapes, the frames keep to the sandbox (no network of their own, sessions only through GC.openSession).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const texts = require('../server/texts.json');
const plugin = require('../server/index');

const UI = path.join(__dirname, '..', 'ui');
const files = fs.readdirSync(UI);

describe('pages and texts', () => {
  it('German and English have the same keys', () => {
    assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  });

  it('every key the pages name exists', () => {
    const keys = new Set();
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      for (const m of s.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) keys.add(m[1]);
      for (const m of s.matchAll(/\bT\('([a-z0-9_.]+)'(?!\s*\+)/g)) keys.add(m[1]);
    }
    const missing = [...keys].filter((k) => !(k in texts.de));
    assert.deepEqual(missing, []);
  });

  it('every API error, field, tab, right and option of the editor has a text', () => {
    const { STATUS } = require('../server/util');
    const devices = require('../server/devices');
    for (const code of Object.keys(STATUS)) assert.ok(texts.de['error.' + code], code);
    for (const k of Object.keys(devices.FIELDS)) assert.ok(texts.de['f.' + k], 'f.' + k);
    for (const k of ['connection', 'auth', 'display', 'resources', 'performance', 'session', 'wol', 'browser', 'notes']) assert.ok(texts.de['tab.' + k], k);
    for (const k of ['rdp', 'ssh', 'support', 'share']) assert.ok(texts.de['right.' + k], k);
    for (const k of devices.ACCESS_MODES) assert.ok(texts.de['mode.' + k], k);
    for (const k of devices.PROTOCOLS) assert.ok(texts.de['proto.' + k], k);
    for (const k of ['no_gesture', 'invalid', 'not_allowed', 'timeout', 'failed']) assert.ok(texts.de['connect.failed.' + k], k);
    for (const k of ['admin', 'person', 'group', 'default']) assert.ok(texts.de['rights.src.' + k], k);
  });

  it('render: each page, the portal tab and the profile section, in both languages, without unfilled keys', async () => {
    for (const lang of ['de', 'en']) {
      for (const view of [...ui.PAGES.map((page) => ({ view: 'page', page })), { view: 'portal' }, { view: 'portal', section: 'rights' }]) {
        const { html } = await plugin.render({ ...view, lang });
        assert.doesNotMatch(html, /\{\{t:/, `${view.page || view.section || 'portal'} ${lang}`);
        assert.match(html, /window\.RM_CTX=/);
      }
    }
    assert.match((await plugin.render({ view: 'portal', section: 'rights', lang: 'de' })).html, /Das darfst du \(vom Admin festgelegt\)/);
    assert.equal(ui.island('</script>'), '"\\u003c/script>"');
  });

  it('the frames have no network of their own and open sessions only through GC.openSession', () => {
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(UI, f), 'utf8');
      assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|innerHTML|window\.open\(/, f);
    }
    assert.match(fs.readFileSync(path.join(UI, 'common.js'), 'utf8'), /window\.GC\.openSession\(ref\)/);
    assert.match(fs.readFileSync(path.join(UI, 'style.css'), 'utf8'), /\.rm-portal \.btn[^{]*\{min-height:44px/);
  });

  it('1.8.1: the dialogs keep to GC.viewport — no floor of 420 px any more, only 300 px for head, steps and buttons', () => {
    const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8');
    assert.doesNotMatch(css, /max\(\s*420px\s*,\s*calc\(var\(--gc-viewport-height/);
    for (const [sel, prop, off] of [['.modal.rmx-modal', 'max-height', 64], ['.modal.rm-dlg', 'max-height', 32], ['.modal.rm-dlg.xl', 'height', 32], ['.modal.rmx-modal.rm-wiz', 'height', 32]]) {
      const rules = [...css.matchAll(new RegExp('(?:^|\\})' + sel.replace(/\./g, '\\.') + '\\{([^}]*)\\}', 'gm'))].map((m) => m[1]);
      const want = new RegExp('(?:^|;)' + prop + ':max\\(300px,calc\\(var\\(--gc-viewport-height,100vh\\) - ' + off + 'px\\)\\)');
      assert.ok(rules.some((r) => want.test(r)), sel);
    }
    assert.equal(require('../plugin.json').gatecontrol, '>=1.300.1');
  });

  it('1.7.1: the Linux set-up names the fixed download links of the agent, no placeholders', () => {
    const DL = 'https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download';
    const portal = fs.readFileSync(path.join(UI, 'portal.js'), 'utf8');
    assert.match(portal, /'https:\/\/github\.com\/CallMeTechie\/gatecontrol-linux-agent\/releases'/);
    assert.match(portal, /AGENT_DL \+ '\/gatecontrol-agent_\$\(dpkg --print-architecture\)\.deb/);
    assert.match(portal, /AGENT_DL \+ '\/gatecontrol-agent_x86_64\.pkg\.tar\.zst/);
    assert.doesNotMatch(portal, /gatecontrol-agent_<version>|gatecontrol-agent-<version>/);
    for (const f of ['HANDBUCH.md', 'HANDBOOK.md']) {
      const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const a of ['gatecontrol-agent_amd64.deb', 'gatecontrol-agent_x86_64.pkg.tar.zst', 'gatecontrol-agent_x86_64.rpm']) {
        assert.ok(h.includes(`curl -LO ${DL}/${a}`), `${f}: ${a}`);
      }
      assert.ok(h.includes('](https://github.com/CallMeTechie/gatecontrol-linux-agent/releases)'), f);
      assert.doesNotMatch(h, /gatecontrol-agent_<version>|gatecontrol-agent-<version>/, f);
    }
    assert.match(texts.de['linux.step1'], /gatecontrol-linux-agent\/releases/);
    assert.match(texts.en['linux.step1'], /gatecontrol-linux-agent\/releases/);
  });

  it('1.8: the device page carries the key set-up, the agent codes and the tmux list; icon buttons have a label', async () => {
    const { html } = await plugin.render({ view: 'page', page: 'devices', lang: 'de' });
    assert.match(html, /window\.RMK = \{ open: open \}/);
    assert.match(html, /window\.RMA = \{ panel: panel/);
    assert.match(html, /tmuxDialog: tmuxDialog/);
    const common = fs.readFileSync(path.join(UI, 'common.js'), 'utf8');
    assert.match(common, /'aria-label': o\.label, 'data-tip': o\.tip \|\| o\.label/);
    // the view is remembered in the frame's browser storage, always in try/catch
    const dev = fs.readFileSync(path.join(UI, 'devices.js'), 'utf8');
    assert.match(dev, /try \{ saved = window\.localStorage\.getItem\('rm\.devices\.view'\); \} catch/);
    assert.match(dev, /try \{ window\.localStorage\.setItem\('rm\.devices\.view', v\); \} catch/);
    // the password of the key set-up goes only with the request
    const keys = fs.readFileSync(path.join(UI, 'keys.js'), 'utf8');
    assert.doesNotMatch(keys, /localStorage|sessionStorage/);
    assert.match((await plugin.render({ view: 'portal', lang: 'en' })).html, /tmuxDialog/);
  });

  it('plugin.json: the permissions of the contract, an own licence, the profile section', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
    assert.equal(m.id, 'gatecontrol-remote');
    assert.equal(m.version, '1.9.1');
    assert.equal(m.name.de, 'Fernzugriff');
    assert.equal(m.permissions.remote, true);
    assert.equal(m.license.required, true);
    assert.equal(m.ui.pages[0].id, 'devices');
    assert.equal(m.ui.portal.profileSections[0].id, 'rights');
  });
});
