'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');

async function withHost(opts, fn) {
  const host = await createHost(DIR, opts);
  try {
    await host.start();
    await fn(host);
  } finally {
    await host.stop();
    await host.close();
  }
}

test('ping answers with the request', () => withHost({}, async (host) => {
  const r = await host.request({ method: 'GET', path: '/ping', query: { a: '1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, method: 'GET', user: { id: 1, name: 'admin', role: 'admin' }, query: { a: '1' }, lang: 'de' });
  assert.ok(host.logs.some((l) => l.message.startsWith('hello started')));
}));

test('migrations ran and greetings are stored in the plugin database', () => withHost({}, async (host) => {
  let r = await host.request({ method: 'POST', path: '/greetings', body: { text: 'second' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 2);
  r = await host.request({ path: '/greetings' });
  assert.deepEqual(r.json.rows.map((x) => x.text), ['first', 'second']);
  r = await host.request({ method: 'POST', path: '/greetings', body: { text: ' ' } });
  assert.equal(r.status, 400);
}));

test('the host refuses SQL that leaves the database', () => withHost({}, async (host) => {
  await assert.rejects(host.gc.db.exec("ATTACH DATABASE '/tmp/x.db' AS x"), { code: 'ERR_INVALID' });
}));

test('background tick counts in key/value storage', () => withHost({}, async (host) => {
  await host.tick();
  await host.tick();
  const r = await host.request({ path: '/ticks' });
  assert.equal(r.json.ticks, 2);
}));

test('render fills the page template with escaped settings', () => withHost({ settings: { greeting: '<b>Moin</b>', loud: true } }, async (host) => {
  const r = await host.render({ view: 'portal', page: null, user: { id: 2, name: 'Ada', role: 'user' } });
  assert.match(r.html, /<h1 id="hello">&lt;B&gt;MOIN&lt;\/B&gt;, Ada!<\/h1>/);
  assert.match(r.html, /<p id="view">portal:<\/p>/);
  assert.match(r.html, /<span id="count">1<\/span>/);
}));

test('settings defaults come from plugin.json', () => withHost({}, async (host) => {
  const r = await host.request({ path: '/settings' });
  assert.deepEqual(r.json.values, { greeting: 'Hallo', loud: false, repeat: 1, token: null });
}));

test('internet access is limited to the declared hosts', () => withHost({ fetch: async (url) => ({ status: 200, body: 'pong ' + url }) }, async (host) => {
  let r = await host.request({ path: '/fetch', query: { url: 'https://api.example.com/v1' } });
  assert.deepEqual(r.json, { ok: true, status: 200, body: 'pong https://api.example.com/v1' });
  r = await host.request({ path: '/fetch', query: { url: 'https://evil.example.org/' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'ERR_NET_DENIED');
  r = await host.request({ path: '/fetch', query: { url: 'http://api.example.com:8080/' } });
  assert.equal(r.json.code, 'ERR_NET_DENIED');
  r = await host.request({ path: '/fetch', query: { url: 'https://eu.cloud.example/x' } });
  assert.equal(r.json.ok, true);
  assert.equal(host.fetches.length, 2);
}));

test('home targets are reachable only once assigned', async () => {
  await withHost({}, async (host) => {
    const r = await host.request({ path: '/gateway' });
    assert.equal(r.json.code, 'ERR_NET_DENIED');
  });
  const targets = { gateway: [{ label: 'deCONZ', fetch: async (p) => ({ status: 200, body: JSON.stringify({ path: p }) }) }] };
  await withHost({ targets }, async (host) => {
    const r = await host.request({ path: '/gateway' });
    assert.deepEqual(r.json, { ok: true, status: 200, body: '{"path":"/api/config"}' });
    const t = await host.request({ path: '/targets' });
    assert.deepEqual(t.json.targets.map((x) => [x.id, x.assigned.length]), [['gateway', 1], ['device', 0]]);
  });
});

test('users, notify and license go through the host', () => withHost({ users: [{ id: 7, name: 'Ada', role: 'admin' }] }, async (host) => {
  assert.deepEqual((await host.request({ path: '/users' })).json.users, [{ id: 7, name: 'Ada', role: 'admin' }]);
  await host.request({ path: '/notify' });
  assert.deepEqual(host.notifications, [{ message: 'hello from the plugin', severity: 'info' }]);
  assert.equal((await host.request({ path: '/license' })).json.license.required, false);
}));

test('unknown paths are 404', () => withHost({}, async (host) => {
  assert.equal((await host.request({ path: '/nope' })).status, 404);
}));
