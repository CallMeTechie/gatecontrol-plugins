'use strict';

// Pages, portal tab and manifest: every page renders in de and en with all
// texts filled, every text key used by the UI exists in both languages, the
// Leaflet URL lives in one constant, plugin.json declares what the contract
// asks for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const texts = require('../server/texts.json');
const ui = require('../server/ui');
const push = require('../server/push');
const manifest = require('../plugin.json');

const t = (lang, k) => (texts[lang] && texts[lang][k]) || texts.de[k] || k;
const ctxOf = (html) => JSON.parse(html.split('window.FA_CTX=')[1].split(';</script>')[0]);

test('render: members, modules, log and the portal tab in de and en; no unresolved keys', () => {
  for (const lang of ['de', 'en']) {
    for (const view of [{ view: 'page', page: 'members' }, { view: 'page', page: 'modules' }, { view: 'page', page: 'presence' }, { view: 'page', page: 'rules' }, { view: 'page', page: 'log' }, { view: 'portal', loggedIn: true }, { view: 'portal', user: { id: 2, loggedIn: false } },
      { view: 'portal', wall: true, loggedIn: true }, { view: 'portal', wall: true, loggedIn: false }]) {
      const html = ui.render({ ...view, lang }, t);
      assert.ok(!/\{\{t:/.test(html), `${view.page || view.view}: all keys filled`);
      const ctx = ctxOf(html);
      assert.equal(ctx.lang, lang);
      assert.deepEqual(ctx.leaflet, ui.LEAFLET);
      assert.ok(html.includes('window.FA = {'), 'common helpers');
    }
  }
  assert.equal(ctxOf(ui.render({ view: 'portal', user: { loggedIn: false } }, t)).loggedIn, false);
  assert.equal(ctxOf(ui.render({ view: 'portal', loggedIn: true }, t)).loggedIn, true);
  assert.equal(ctxOf(ui.render({ view: 'portal', wall: true, user: { id: 7, portal: true, kiosk: true } }, t)).loggedIn, true, 'a kiosk device writes');
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'nope' }, t)).page, 'members', 'unknown page → members');
  assert.ok(ui.render({ view: 'page', page: 'log' }, t).includes('window.FA.map'), 'the log page has the map');
  assert.ok(!ui.render({ view: 'page', page: 'modules' }, t).includes('window.FA.map'), 'the modules page does not need it');
  // 1.2.0: the rule editor on the presence page and in the portal, the new portal sections
  const pres = ui.render({ view: 'page', page: 'presence' }, t);
  assert.ok(pres.includes('A.rules = {') && pres.includes('id="fa-pr-rules"'));
  const portalHtml = ui.render({ view: 'portal', loggedIn: true }, t);
  for (const id of ['fa-board', 'fa-meals', 'fa-wishes', 'fa-allowance', 'fa-expenses', 'fa-presence']) assert.ok(portalHtml.includes(`id="${id}"`), id);
  assert.ok(portalHtml.includes('A.rules = {') && portalHtml.includes('function form(title, fields, opts)'));
  // 1.4.0: one rule editor (ui/rules.js) for the admin page and the portal: the wide three-column dialog
  for (const html of [pres, portalHtml]) assert.ok(html.includes("class: 'fa-rm'") && html.includes('.fa-rm-body{') && html.includes("'aria-pressed'"));
  // 1.5.0: places as triggers — the section „Orte“ on the admin page and in the portal, the place editor on the map (ui/map.js pick)
  assert.ok(pres.includes('id="fa-pr-places"') && pres.includes('id="fa-pr-place-add"') && portalHtml.includes('id="fa-pres-places"') && portalHtml.includes('id="fa-pres-place-add"'));
  for (const html of [pres, portalHtml]) assert.ok(html.includes('window.FA.map') && html.includes('function pick(box, o)') && html.includes('function editPlace(p, data, opts, done)') && html.includes('.fa-pe{'));
  for (const lang of ['de', 'en']) {
    const h = ui.render({ view: 'page', page: 'presence', lang }, t);
    assert.ok(h.includes(texts[lang]['places.intro'].replace(/"/g, '&quot;').replace(/'/g, '&#39;')) && h.includes(texts[lang]['presence.note_places'].replace(/"/g, '&quot;').replace(/'/g, '&#39;')), lang);
  }
  // 1.10.0: one editor for every rule — the page „Regeln & Erinnerungen“ and ui/reminders.js are gone; the presence page
  // and the portal section „Regeln und Erinnerungen“ use ui/rules.js through the rules API, with reminders (schedule),
  // device values, events, buttons and the dry run
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'rules' }, t)).page, 'members', 'no page „rules“ any more');
  for (const html of [pres, portalHtml]) {
    assert.ok(!html.includes('A.reminders') && !html.includes('fa-rr-'), 'no second editor');
    assert.ok(html.includes("'schedule'") && html.includes('function deviceBlock()') && html.includes('function calendarBlock()') && html.includes('function probe()') && html.includes('.fa-rm-probe{'));
  }
  assert.ok(pres.includes("rulesBase: 'admin/rules'") && pres.includes("A.api('GET', 'admin/rules/options')"));
  assert.ok(portalHtml.includes('id="fa-rules"') && portalHtml.includes('id="fa-rules-box"') && portalHtml.includes("rulesBase: 'rules'") && !portalHtml.includes('id="fa-pres-rules"'));
  // 1.3.0: member chips in the portal header, the help on the members page, one avatar renderer
  assert.ok(portalHtml.includes('id="fa-p-people"') && portalHtml.includes('function avatar(m, size, opts)'));
  // 1.3.1: no own title — the portal shows the tab name „Familie“ above the frame
  assert.ok(!/<h1|fa-p-title/.test(portalHtml));
  const membersHtml = ui.render({ view: 'page', page: 'members', lang: 'de' }, t);
  assert.ok(membersHtml.includes('Profilbild und Lieblingsfarbe ändert jede Person in der GateControl-App (Einstellungen → Profil) oder der Admin im Benutzerprofil.'));
  assert.ok(!membersHtml.includes('fa-m-color'), 'no own member colour any more');
  const wall = ui.render({ view: 'portal', wall: true, loggedIn: false }, t);
  assert.deepEqual([ctxOf(wall).page, ctxOf(wall).loggedIn], ['wall', false]);
  assert.ok(wall.includes('id="fa-wall"') && !wall.includes('window.FA.map'), 'the wall view, no map');
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'members', wall: true }, t)).page, 'members', 'wall only in the portal');
});

test('texts: every key used by the pages exists in de and en; both languages have the same keys', () => {
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  const dir = path.join(__dirname, '..', 'ui');
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}|\bT\('([a-z0-9_.-]+)'/g)) used.add(m[1] || m[2]);
  }
  for (const k of used) if (!k.endsWith('.') && !k.endsWith('_')) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  const MODS = ['shopping', 'tasks', 'stars', 'dates', 'locate', 'arrival_sos', 'places', 'rides', 'emergency', 'allowance', 'wishes', 'expenses', 'board', 'meals', 'presence'];
  const dyn = [
    ...MODS.flatMap((m) => ['module.' + m, 'module.' + m + '_desc', 'card.' + m + '_parent', 'card.' + m + '_child']),
    'module.wall', 'module.wall_desc', 'role.wall',
    ...['all', 'parents', 'children', 'none', 'family'].map((x) => 'who.' + x),
    ...['everyday', 'out', 'kids', 'money', 'home'].map((x) => 'group.' + x),
    ...require('../server/allowance').KINDS.map((x) => 'allowance.kind_' + x),
    ...require('../server/wishes').OCCASIONS.map((x) => 'wishes.occ_' + x),
    ...require('../server/expenses').CATEGORIES.map((x) => 'expenses.cat_' + x),
    ...require('../server/board').COLORS.map((x) => 'board.color_' + x),
    ...require('../server/meals').SLOTS.map((x) => 'meal.' + x),
    ...require('../server/presence').TRIGGERS.map((x) => 'rule.trigger_' + x),
    ...['home', 'away', 'unknown', 'not_shared'].map((x) => 'presence.' + x),
    ...['home', 'away'].map((x) => 'avatar.' + x),
    ...['not_found', 'plugin_error', 'timeout', 'rate_limit', 'invalid', 'denied', 'unavailable', 'no_recipients', 'failed', 'error', 'needs_target', 'state_unknown', 'invalid_state'].map((x) => 'rule.err.' + x),
    ...require('../server/rules').TRIGGERS.flatMap((x) => ['rule.m_trig_' + x, 'rule.m_trig_' + x + '_hint']),
    ...['time', 'home', 'places'].map((x) => 'rule.m_group_' + x), 'rule.m_btn_snooze', 'rule.m_btn_done',
    ...Object.keys(require('../server/presence').PLACE_TRIGGERS).map((x) => 'rule.log_' + x),
    'rule.m_on', 'rule.m_off',
    // 1.9.0: the module, the rule log of the presence page, the editor of ui/reminders.js
    'module.rules', 'module.rules_desc', 'rule.trigger_schedule', 'rule.trigger_button',
    ...require('../server/rules').TRIGGERS.map((x) => 'rr.trig_' + x),
    ...['person_home', 'person_away', 'place_enter', 'place_exit', 'all_away'].map((x) => 'rr.trig_' + x + '_s'),
    ...['all', 'reminder', 'presence', 'place'].map((x) => 'rr.filter_' + x),
    ...[1, 2, 3, 4, 5, 6, 7].map((x) => 'rr.wd_' + x), 'rr.cal_today_s', 'rr.cal_tomorrow_s',
    // 1.6.0: the results of a messenger action in the rule log and on the page „Funktionen“
    ...['unavailable', 'group_off', 'not_found', 'forbidden', 'invalid', 'rate_limit', 'timeout', 'failed', 'no_recipients'].map((x) => 'rule.msg_err.' + x),
    ...['pending', 'answered', 'declined', 'failed', 'expired'].map((x) => 'status.' + x),
    ...['no_permission', 'location_off', 'timeout'].map((x) => 'fail.' + x),
    'decline.busy', 'problem.timezone',
    ...['locate', 'arrival', 'sos', 'place'].map((x) => 'kind.' + x),
    ...['auto', 'confirm', 'off'].map((x) => 'mode.' + x),
    ...['parent', 'child'].map((x) => 'role.' + x),
    ...['none', 'daily', 'weekly', 'monthly'].map((x) => 'repeat.' + x),
    ...['fixed', 'rotate', 'first'].map((x) => 'task.mode_' + x + '_short'),
    ...Object.keys(require('../server/util').STATUS).map((c) => 'error.' + c),
  ];
  for (const k of dyn) for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  assert.deepEqual(Object.keys(push.TEXTS.de).sort(), Object.keys(push.TEXTS.en).sort(), 'push texts in both languages');
});

test('Leaflet: one constant (server/ui.js), nowhere else', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  for (const sub of ['server', 'ui']) {
    for (const f of fs.readdirSync(path.join(root, sub))) {
      if (!fs.statSync(path.join(root, sub, f)).isFile()) continue; // server/vendor (1.14.0: the QR encoder)
      const src = fs.readFileSync(path.join(root, sub, f), 'utf8');
      if (src.includes('/leaflet/leaflet.js')) hits.push(`${sub}/${f}`);
    }
  }
  assert.deepEqual(hits, ['server/ui.js']);
  assert.match(ui.LEAFLET.js, /^\/[A-Za-z0-9_./-]+\.js$/);
  assert.match(ui.LEAFLET.css, /^\/[A-Za-z0-9_./-]+\.css$/);
  assert.equal(ui.TILES, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
});

test('plugin.json: permissions (kiosk, actions), app tab, maps, the eleven topics with SOS allowed critical', () => {
  assert.equal(manifest.id, 'gatecontrol-familie');
  assert.equal(manifest.version, '1.15.2');
  // 1.6.0 stays on 1.173.0: the messenger services (GateControl ≥ 1.177.0) are optional — an older host ignores
  // permissions.services and has no gc.services, so the group and the rule action stay hidden there.
  // 1.14.2 too: GC.viewport (GateControl ≥ 1.199.0) is optional — without it the wall keeps its 640 px
  // 1.15.0 too: the GateControl group „Familie“ (gc.groups, GateControl ≥ 1.200.0) is feature-detected — an older host
  // ignores permissions.groups and has no gc.groups
  assert.equal(manifest.gatecontrol, '>=1.173.0', 'target states of switches (gc.actions.run state, verbs/targets/device in gc.actions.list) need GateControl 1.173.0');
  const p = manifest.permissions;
  assert.deepEqual([p.storage, p.portal, p.users, p.app, p.notify, p.background, p.kiosk, p.actions], [true, true, true, true, { perHour: 120 }, { intervalSeconds: 60 }, true, true]);
  assert.equal(p.groups, 'manage', '1.15.0: the family as a GateControl group of the plugin (gc.groups.ensure)');
  assert.deepEqual(p.services, ['gatecontrol-messenger:sync_group', 'gatecontrol-messenger:send_message', 'gatecontrol-messenger:release_group',
    'gatecontrol-messenger:set_place_status', 'gatecontrol-alltag:calendar_query', 'gatecontrol-alltag:calendar_list', 'gatecontrol-schule:school_students',
    'gatecontrol-schule:school_day'],
  '1.7.0: release_group (messenger ≥ 1.1.0); 1.8.0: set_place_status (messenger ≥ 1.4.0); 1.9.0: the Alltag calendars for calendar conditions; 1.12.0: the Schule students; 1.13.0: the school day on the wall');
  assert.deepEqual(Object.keys(manifest.services.provides), ['list_add', 'calendar_add', 'calendar_upsert', 'calendar_remove', 'places', 'family_roles', 'rule_event', 'school_day_end', 'wall_wifi'],
    '1.8.0: services for the Messenger; 1.9.0: family_roles; 1.12.0: rule_event for the Schule plugin; 1.13.0: school_day_end; 1.14.0: wall_wifi for Vault');
  for (const sv of Object.values(manifest.services.provides)) assert.ok(sv.label.de && sv.label.en && sv.label.de.length <= 60 && sv.label.en.length <= 60);
  // 1.10.0: no page „Regeln & Erinnerungen“ — every rule is on „Anwesenheit & Smart Home“
  assert.deepEqual(manifest.ui.pages.map((x) => x.id), ['members', 'modules', 'presence', 'log']);
  assert.deepEqual(manifest.ui.pages[2].title, { de: 'Anwesenheit & Smart Home', en: 'Presence & smart home' });
  // 1.9.0: children's own reminders (off), how a shopping list is asked of someone (direct), „Ich gehe einkaufen“ in the family chat (on)
  // 1.13.0: an early end of school without a pickup tells the parents (on)
  assert.deepEqual(manifest.ui.settings.map((x) => x.key), ['timezone', 'notify_lang', 'lat', 'lon', 'children_own_rules', 'shopping_notify', 'shopping_chat', 'school_early_end_notify']);
  assert.deepEqual(manifest.ui.settings.slice(4).map((x) => x.default), [false, 'direct', 'family', true]);
  assert.deepEqual(manifest.ui.settings[5].options.map((o) => o.value), ['direct', 'family', 'push']);
  assert.deepEqual(manifest.ui.settings[6].options.map((o) => o.value), ['family', 'off']);
  // 1.9.0: device values and buttons need GateControl 1.181.0 — feature-detected, so the requirement stays
  assert.equal(manifest.gatecontrol, '>=1.173.0');
  assert.equal(manifest.ui.maps, true);
  const ICON = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
  for (const k of ['nav', 'portal', 'app']) {
    assert.ok(ICON.test(manifest.ui[k].icon), k);
    assert.deepEqual(manifest.ui[k].label, { de: 'Familie', en: 'Family' });
  }
  assert.deepEqual(manifest.notifyTopics.map((x) => x.id), ['shopping', 'tasks', 'dates', 'locate', 'arrival', 'sos', 'places', 'rides', 'allowance', 'presence', 'reminders']);
  assert.deepEqual(manifest.notifyTopics.find((x) => x.id === 'reminders').label, { de: 'Regeln & Erinnerungen', en: 'Rules & reminders' });
  assert.deepEqual(manifest.notifyTopics.find((x) => x.id === 'allowance').label, { de: 'Taschengeld', en: 'Pocket money' });
  assert.deepEqual(manifest.notifyTopics.find((x) => x.id === 'presence').label, { de: 'Anwesenheit & Smart Home', en: 'Presence & smart home' });
  assert.deepEqual(manifest.notifyTopics.find((x) => x.id === 'rides').label, { de: 'Abholen & Fahrten', en: 'Pick-ups & rides' });
  assert.deepEqual(manifest.notifyTopics.filter((x) => x.allowCritical).map((x) => x.id), ['sos']);
  for (const tp of manifest.notifyTopics) assert.ok(tp.label.de && tp.label.en && tp.label.de.length <= 60 && tp.label.en.length <= 60);
});
