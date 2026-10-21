'use strict';

// The shared notifier (plugins/<id>/server/notify.js): one file, copied into
// every plugin that notifies. Checks that the copies are identical and the
// behaviour against the mock host: new form, fallbacks for older/stricter
// hosts, own hourly budget with a reserve for alarms, dedupe, state helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib');
const { createHost } = require('../testing/mock-host');

const copies = lib.listPlugins().map((id) => path.join(lib.pluginDir(id), 'server', 'notify.js')).filter((f) => fs.existsSync(f));
const SKODA = lib.pluginDir('gatecontrol-skoda');
const notify = require(path.join(SKODA, 'server', 'notify.js'));
const N = { topic: 'charging_done', title: 'Laden abgeschlossen', body: 'Elroq · 80 % · ca. 390 km', priority: 'normal', collapseKey: 'charge:VIN1', data: { route: 'plg-gatecontrol-skoda' } };

async function host(opts) {
  const h = await createHost(SKODA, opts);
  return h;
}

test('every plugin that notifies carries the same notify.js', () => {
  assert.ok(copies.length >= 3, copies.join(', '));
  const ref = fs.readFileSync(copies[0], 'utf8');
  for (const f of copies) assert.equal(fs.readFileSync(f, 'utf8'), ref, `${path.relative(lib.ROOT, f)} differs — copy plugins/gatecontrol-skoda/server/notify.js`);
});

test('new form: gc.notify({ topic, … }) on GateControl ≥ 1.154.0', async () => {
  const h = await host();
  try {
    const r = await notify.deliver(h.gc, { ...N, users: [], ttl: null });
    assert.deepEqual(r, { sent: true, pushed: true, form: 'v2', error: null });
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].topic, 'charging_done');
    assert.equal(h.notifications[0].users, null, 'empty users are left out (the topic rule decides)');
    assert.ok(!Object.hasOwn(JSON.parse(JSON.stringify(notify.payload(N))), 'toString'), 'the string form never crosses the IPC');
    assert.equal(String(notify.payload(N)), 'Laden abgeschlossen – Elroq · 80 % · ca. 390 km');
  } finally { await h.close(); }
});

test('older GateControl (< 1.154.0, string-only notify): "<title> – <body>", not "[object Object]"', async () => {
  const h = await host({ notifyApi: 'legacy' });
  try {
    const r = await notify.deliver(h.gc, N);
    assert.deepEqual(r, { sent: true, pushed: false, form: 'legacy', error: null });
    assert.deepEqual(h.notifications, [{ message: 'Laden abgeschlossen – Elroq · 80 % · ca. 390 km', severity: 'info' }]);
  } finally { await h.close(); }
});

test('ERR_INVALID (e.g. a host that does not know the topic) → sent once more in the old form', async () => {
  const h = await host();
  try {
    const r = await notify.deliver(h.gc, { ...N, topic: 'not_declared', priority: 'high' });
    assert.deepEqual(r, { sent: true, pushed: false, form: 'legacy', error: null });
    assert.deepEqual(h.notifications, [{ message: 'Laden abgeschlossen – Elroq · 80 % · ca. 390 km', severity: 'warning' }]);
  } finally { await h.close(); }
});

test('host errors are reported, not thrown: rate limit, missing permission', async () => {
  const h = await host({ notifyFail: () => 'ERR_RATE_LIMIT' });
  try {
    assert.deepEqual(await notify.deliver(h.gc, N), { sent: false, pushed: false, form: null, error: 'ERR_RATE_LIMIT' });
    const n = notify.createNotifier(h.gc);
    await n.send(N);
    await n.send({ ...N, collapseKey: 'x' });
    assert.equal(h.logs.filter((l) => /not sent/.test(l.message)).length, 1, 'logged once');
  } finally { await h.close(); }
  const gc = { notify: async () => { throw Object.assign(new Error('x'), { code: 'ERR_NOTIFY_DENIED' }); }, log: { warn() {} } };
  assert.equal((await notify.deliver(gc, N)).error, 'ERR_NOTIFY_DENIED');
});

test('own budget below the host limit: 25/h, the last 5 only for high priority; the window slides', async () => {
  let t = Date.parse('2026-10-11T08:00:00Z');
  const sent = [];
  const gc = { notify: async (n) => { sent.push(n.priority); return { pushed: true, id: sent.length }; }, log: { warn() {} } };
  const n = notify.createNotifier(gc, { now: () => t });
  for (let i = 0; i < 22; i++) await n.send({ ...N, collapseKey: `k${i}` });
  assert.equal(sent.length, 20, 'normal ones stop at 20');
  assert.equal((await n.send({ ...N, collapseKey: 'more' })).error, 'THROTTLED');
  for (let i = 0; i < 6; i++) await n.send({ ...N, priority: 'high', collapseKey: `h${i}` });
  assert.equal(sent.length, 25, 'high ones use the reserve up to 25');
  assert.equal(n.sentLastHour(), 25);
  t += 3600000;
  assert.equal((await n.send({ ...N, collapseKey: 'later' })).sent, true, 'an hour later there is room again');
});

test('dedupe: the same topic + collapse key within minGapMs is dropped', async () => {
  let t = 0;
  const gc = { notify: async () => ({ pushed: true, id: 1 }), log: { warn() {} } };
  const n = notify.createNotifier(gc, { now: () => t });
  assert.equal((await n.send(N, { minGapMs: 600000 })).sent, true);
  t = 300000;
  assert.equal((await n.send(N, { minGapMs: 600000 })).error, 'DEDUPED');
  assert.equal((await n.send({ ...N, collapseKey: 'other' }, { minGapMs: 600000 })).sent, true);
  assert.equal((await n.send(N)).sent, true, 'without minGapMs nothing is deduped');
  t = 2000000;
  assert.equal((await n.send(N, { minGapMs: 600000 })).sent, true);
});

test('state helpers: null on the first run, written only when changed, storage errors only logged', async () => {
  const h = await host();
  try {
    assert.equal(await notify.loadState(h.gc, 'notify.state'), null);
    const j = await notify.saveState(h.gc, 'notify.state', { v: 1, a: 1 }, null);
    assert.deepEqual(await notify.loadState(h.gc, 'notify.state'), { v: 1, a: 1 });
    await h.gc.storage.set('notify.state', { touched: true });
    await notify.saveState(h.gc, 'notify.state', { v: 1, a: 1 }, j); // unchanged → no write
    assert.deepEqual(await notify.loadState(h.gc, 'notify.state'), { touched: true });
  } finally { await h.close(); }
  const warns = [];
  const gc = { storage: { get: async () => { throw new Error('x'); }, set: async () => { throw Object.assign(new Error('x'), { code: 'ERR_STORAGE_DENIED' }); } }, log: { warn: (...a) => warns.push(a.join(' ')) } };
  assert.equal(await notify.loadState(gc, 'k'), null);
  await notify.saveState(gc, 'k', { a: 1 }, null);
  assert.match(warns[0], /ERR_STORAGE_DENIED/);
});

test('texts and numbers in the notification language', () => {
  const texts = { de: { a: 'Hallo {{name}}' }, en: { a: 'Hello {{name}}' } };
  assert.equal(notify.fmt(texts, 'en', 'a', { name: 'Ada' }), 'Hello Ada');
  assert.equal(notify.fmt(texts, 'fr', 'a', { name: 'Ada' }), 'Hallo Ada');
  assert.equal(notify.num(1234.5, 'de', 1), '1.234,5');
  assert.equal(notify.num(1234.5, 'en'), '1,235');
  assert.equal(notify.langOf({ notify_lang: 'en' }), 'en');
  assert.equal(notify.langOf(null), 'de');
  assert.deepEqual(notify.openAction({ plugin: { id: 'gatecontrol-midea' } }, 'de'),
    { route: 'plg-gatecontrol-midea', actions: [{ id: 'open', label: 'Öffnen', type: 'open_app_route', target: 'plg-gatecontrol-midea' }] });
});

test('a picture the host refuses never costs the message: sent again without it (GateControl ≥ 1.169.0 image)', async () => {
  const h = await host({ notifyFail: (n) => (n && n.image ? 'ERR_INVALID' : null) });
  try {
    const r = await notify.deliver(h.gc, { ...N, image: { data: 'AAAA', mime: 'image/jpeg' } });
    assert.deepEqual(r, { sent: true, pushed: true, form: 'v2', error: null, imageDropped: true });
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].image, undefined);
    assert.equal(h.notifications[0].title, N.title);
    assert.deepEqual(Object.keys(notify.payload({ ...N, image: { data: 'x', mime: 'image/png' } })).includes('image'), true);
  } finally { await h.close(); }
});

test('card (GateControl ≥ 1.191.0): passed on and checked by the host; ignored by older hosts; refused → sent without it', async () => {
  const card = { text: 'Ladung beendet.\nReichweite ca. 390 km', link: { label: 'Fahrzeug öffnen', route: 'plg-gatecontrol-skoda' } };
  let h = await host({ gatecontrol: '1.191.0' });
  try {
    const r = await notify.deliver(h.gc, { ...N, card });
    assert.deepEqual(r, { sent: true, pushed: true, form: 'v2', error: null });
    assert.deepEqual(h.notifications[0].card, { ...card, actions: null });
    // the host cuts the text to 4000 and the link label to 40
    await notify.deliver(h.gc, { ...N, card: { text: 'x'.repeat(5000), link: { label: 'y'.repeat(60), route: 'inbox' } } });
    assert.deepEqual([h.notifications[1].card.text.length, h.notifications[1].card.link.label.length], [4000, 40]);
    // a card the host refuses (no app route): the notification without it
    const bad = await notify.deliver(h.gc, { ...N, card: { text: 'x', link: { label: 'x', route: 'https://example.com' } } });
    assert.deepEqual(bad, { sent: true, pushed: true, form: 'v2', error: null, cardDropped: true });
    assert.equal(h.notifications[2].card, undefined);
  } finally { await h.close(); }
  h = await host({ gatecontrol: '1.190.0' });
  try {
    assert.equal((await notify.deliver(h.gc, { ...N, card })).sent, true);
    assert.equal(h.notifications[0].card, undefined, 'an older host ignores card');
  } finally { await h.close(); }
});
