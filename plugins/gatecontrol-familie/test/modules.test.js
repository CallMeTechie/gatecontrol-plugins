'use strict';

// Module switches (page "Funktionen", settings mod_*): an off module answers
// 403 module_off on every endpoint, is null in the overview, sends nothing
// and keeps its data; the admin API checks the switches. 1.1.0 adds rides,
// emergency (default on) and wall (default off); 1.2.0 allowance (off), wishes
// (on), expenses (off), board (on), meals (off) and presence (off).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, LENA, TIM } = require('./helpers');
const config = require('../server/config');

const ENDPOINTS = {
  shopping: [['GET', '/shopping'], ['POST', '/shopping/ops', { ops: [] }], ['POST', '/shopping/lists/list-0000-0001/going']],
  tasks: [['GET', '/tasks'], ['POST', '/tasks/1/done'], ['POST', '/tasks/1/snooze', { minutes: 30 }]],
  dates: [['GET', '/dates'], ['POST', '/dates', { title: 'x', date: '2026-10-14' }], ['DELETE', '/dates/1']],
  locate: [['POST', `/locate/${TIM.id}`], ['GET', '/locate/requests'], ['POST', '/locate/requests/1/answer', { lat: 1, lon: 2 }]],
  arrival_sos: [['POST', '/arrival', {}], ['POST', '/sos', {}], ['POST', '/sos/1/ack']],
  places: [['GET', '/places'], ['POST', '/places', {}], ['POST', '/places/1/triggered', { transition: 'enter' }]],
  rides: [['GET', '/rides'], ['POST', '/rides', { date: '2026-10-14', time: '16:00', title: 'x' }], ['PATCH', '/rides/1', { time: '17:00' }], ['POST', '/rides/1/take'],
    ['POST', '/rides/1:2026-10-14/ask'], ['DELETE', '/rides/1']],
  emergency: [['GET', '/emergency'], ['PUT', `/emergency/members/${TIM.id}`, { notes: 'x' }], ['PUT', '/emergency/contacts', { contacts: [] }]],
  wall: [['GET', '/wall']],
  allowance: [['GET', '/allowance'], ['POST', `/allowance/${TIM.id}/bookings`, { cents: 100 }], ['PUT', `/allowance/${TIM.id}/rule`, { amountCents: 500 }],
    ['POST', `/allowance/${TIM.id}/convert`, { stars: 10 }], ['POST', '/allowance/requests/1/approve']],
  wishes: [['GET', '/wishes'], ['POST', '/wishes', { title: 'x' }], ['POST', '/wishes/1/reserve']],
  expenses: [['GET', '/expenses'], ['POST', '/expenses', { cents: 100, category: 'food' }], ['POST', '/expenses/settle', {}]],
  board: [['GET', '/board'], ['POST', '/board/notes', { text: 'x' }], ['POST', '/board/checklists/1/items', { text: 'x' }], ['GET', '/board/templates']],
  meals: [['GET', '/meals'], ['PUT', '/meals/2026-10-14/dinner', { title: 'x' }], ['POST', '/meals/2026-10-14/dinner/to-shopping', { listId: 'list-0000-0001' }]],
  presence: [['GET', '/presence'], ['POST', '/presence', { home: true }], ['PUT', '/presence/consent', { share: true }], ['GET', '/presence/rules'], ['GET', '/presence/actions']],
};
const ON_FIRST = ['allowance', 'expenses', 'meals', 'presence'];

test('defaults: every module on but the wall tablet; settings parse booleans; unknown time zone falls back with a problem', () => {
  assert.deepEqual(config.fromSettings({}).modules, {
    shopping: true, tasks: true, stars: true, dates: true, locate: true, arrival_sos: true, places: true, rides: true, emergency: true, wall: false,
    allowance: false, wishes: true, expenses: false, board: true, meals: false, presence: false,
  });
  assert.equal(config.fromSettings({}).location, null);
  assert.deepEqual(config.fromSettings({ lat: '50,94', lon: '6.96' }).location, { lat: 50.94, lon: 6.96 });
  assert.equal(config.fromSettings({ lat: '50.94', lon: '' }).location, null, 'both or nothing');
  assert.equal(config.fromSettings({ lat: '95', lon: '6' }).location, null);
  assert.equal(config.fromSettings({ mod_wall: true }).modules.wall, true);
  assert.equal(config.fromSettings({}).wallList, '');
  assert.equal(config.fromSettings({ wall_list: 'list-0000-0001' }).wallList, 'list-0000-0001');
  assert.equal(config.fromSettings({ mod_tasks: false, mod_places: 'false' }).modules.tasks, false);
  assert.equal(config.fromSettings({ mod_places: 'false' }).modules.places, false);
  const bad = config.fromSettings({ timezone: 'Mars/Olympus' });
  assert.deepEqual(bad.problems, ['timezone']);
  assert.equal(bad.tz, config.serverTz());
  assert.equal(config.fromSettings({ timezone: 'America/New_York' }).tz, 'America/New_York');
  assert.equal(config.fromSettings({ notify_lang: 'en' }).lang, 'en');
});

test('a module switched off: 403 module_off on its endpoints, null in the overview, the others keep working', () => withFamily({}, async (host, { as, admin }) => {
  await admin('PUT', 'modules', Object.fromEntries(ON_FIRST.map((m) => [m, true])));
  for (const mod of Object.keys(ENDPOINTS)) {
    const r = await admin('PUT', 'modules', { [mod]: false });
    assert.equal(r.json.modules[mod], false);
    for (const [m, p, b] of ENDPOINTS[mod]) {
      const who = mod === 'arrival_sos' && p.endsWith('/ack') ? ANNA : (mod === 'locate' && p.includes('answer') ? TIM : ANNA);
      const x = await as(who)(m, p, b);
      assert.deepEqual([x.status, x.json.ok, x.json.code], [403, false, 'module_off'], `${mod}: ${m} ${p}`);
    }
    const me = await as(ANNA)('GET', '/me');
    assert.equal(me.json.modules[mod], false);
    const ov = await as(ANNA)('GET', '/overview');
    const key = { shopping: 'shopping', tasks: 'tasks', dates: 'dates', locate: 'locate', arrival_sos: 'arrivals', places: null, rides: 'rides', emergency: null, wall: null,
      allowance: 'allowance', wishes: 'wishes', expenses: 'expenses', board: 'board', meals: 'meals', presence: 'presence' }[mod];
    if (key) assert.equal(ov.json[key], null, `overview.${key}`);
    await admin('PUT', 'modules', { [mod]: true });
  }
  assert.equal((await as(ANNA)('GET', '/shopping')).status, 200);
  const ov = await as(ANNA)('GET', '/overview');
  assert.deepEqual(ov.json.rides, { next: [], open: 0 }, 'rides card when on');
  // 1.2.0 cards
  assert.deepEqual(ov.json.allowance, { sumCents: 0, children: [{ childId: LENA.id, balanceCents: 0 }, { childId: TIM.id, balanceCents: 0 }], pendingRequests: 0 });
  assert.deepEqual(ov.json.wishes, { mine: 0, reservedByMe: 0 });
  assert.deepEqual(ov.json.expenses, { month: '2026-10', totalCents: 0, sharedCents: 0, settlement: null, settled: false });
  assert.deepEqual(ov.json.board, { pinned: 0, notes: 0, openChecklists: 0 });
  assert.deepEqual(ov.json.meals, { date: '2026-10-14', lunch: null, dinner: null });
  assert.deepEqual(ov.json.presence, { home: [], share: false });
  const kid = (await as(TIM)('GET', '/overview')).json;
  assert.deepEqual(kid.allowance, { balanceCents: 0, nextPayout: null, amountCents: 0, convertibleStars: 0, pendingRequests: 0 });
  assert.equal(kid.expenses, null, 'parents only');
  assert.equal((await as(TIM)('GET', '/expenses')).json.code, 'parents_only');
}));

test('data stays while a module is off', () => withFamily({}, async (host, { as, admin }) => {
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-0000-0001', name: 'REWE' }] });
  await admin('PUT', 'modules', { shopping: false });
  await admin('PUT', 'modules', { shopping: true });
  assert.deepEqual((await as(ANNA)('GET', '/shopping')).json.lists.map((l) => l.name), ['REWE']);
}));

test('admin modules API: booleans of known modules only', () => withFamily({}, async (host, { admin }) => {
  assert.equal((await admin('PUT', 'modules', { nonsense: true })).json.code, 'invalid', 'unknown module');
  assert.equal((await admin('PUT', 'modules', { meals: true })).json.modules.meals, true, 'built in 1.2');
  assert.equal((await admin('PUT', 'modules', { wall: true })).json.modules.wall, true);
  assert.equal((await admin('PUT', 'modules', { tasks: 'off' })).json.code, 'invalid');
  assert.equal((await admin('PUT', 'modules', {})).json.code, 'invalid');
  const r = await admin('PUT', 'modules', { tasks: false, stars: false });
  assert.deepEqual([r.json.modules.tasks, r.json.modules.stars, r.json.modules.shopping], [false, false, true]);
  assert.equal(host.settings.mod_tasks, false, 'stored as plugin settings mod_*');
  assert.ok(!host.manifest.ui.settings.some((s) => s.key.startsWith('mod_')), 'one source of truth: not in ui.settings');
}));
