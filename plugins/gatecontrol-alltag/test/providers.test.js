'use strict';

// Online waste providers against recorded answers (test/fixtures — public
// example addresses: Aachen Markt 1-3, Essen Kennedyplatz 5, Regensburg
// Rathausplatz; recorded live when the plugin was built, the abfall.io API
// key replaced). The guided lookup through the admin API, error mapping,
// and the hosts in plugin.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../server/providers');
const http = require('../server/providers/http');
const manifest = require('../plugin.json');
const { createHost, internetAllowed } = require('../../../tools/testing/mock-host');
const { DIR, fixture, fixtureFetch, withHost, asAdmin } = require('./helpers');

const FIXTURES = ['provider_regioit.json', 'provider_abfallio.json', 'provider_awido.json'];

async function hostFor(fx, calls) {
  return createHost(DIR, { fetch: fixtureFetch(fx, calls) });
}

for (const name of FIXTURES) {
  const fx = fixture(name);
  test(`${fx.provider}: lookup place → street → house and the dates of ${fx.config.place.name}, ${fx.config.street.name}`, async () => {
    const calls = [];
    const host = await hostFor(fx, calls);
    try {
      const p = providers.get(fx.provider);
      const places = await p.places(host.gc, fx.service);
      assert.ok(places.some((x) => x.id === fx.config.place.id && x.name === fx.config.place.name));
      const streets = await p.streets(host.gc, fx.service, fx.config.place.id);
      assert.ok(streets.some((x) => x.id === fx.config.street.id && x.name === fx.config.street.name), JSON.stringify(streets));
      const houses = await p.houses(host.gc, fx.service, fx.config.place.id, fx.config.street.id);
      if (fx.config.house) assert.ok(houses.some((x) => x.id === fx.config.house.id), JSON.stringify(houses));
      else assert.deepEqual(houses, []);
      const dates = await p.dates(host.gc, fx.config, fx.window);
      assert.equal(dates.length, fx.expected.dates);
      assert.deepEqual(dates.slice(0, 3), fx.expected.first);
      for (const d of dates) {
        assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(d.date >= fx.window.from && d.date <= fx.window.to);
        assert.ok(d.name);
        assert.ok(d.color === null || /^#[0-9a-f]{6}$/.test(d.color));
      }
      // only declared hosts, always with our User-Agent
      for (const c of calls) {
        assert.ok(internetAllowed(manifest.permissions.network.internet, c.url), c.url);
        assert.match(c.o.headers['user-agent'], /^GateControl-Alltag\//);
      }
    } finally { await host.close(); }
  });
}

test('abfall.io: the checked waste types of the service, its Origin, the API key header', async () => {
  const fx = fixture('provider_abfallio.json');
  const calls = [];
  const host = await hostFor(fx, calls);
  try {
    await providers.get('abfallio').dates(host.gc, fx.config, fx.window);
    const q = calls.find((c) => c.o.json && /appointments/.test(c.o.json.query));
    assert.equal(q.o.headers['x-abfallplus-api-key'], 'FIXTURE-API-KEY');
    assert.equal(q.o.headers.origin, 'https://www.ebe-essen.de');
    const checked = fx.responses[0].body.settings.PUB_ABFALLTYPEN.filter((t) => t.checked).map((t) => t.wasteType);
    assert.deepEqual(q.o.json.variables.types, checked);
    assert.equal(q.o.json.variables.id, fx.config.house.id);
    assert.deepEqual([q.o.json.variables.min, q.o.json.variables.max], [fx.window.from, fx.window.to]);
  } finally { await host.close(); }
});

test('regioit: falls back to the shared host when the service host is unreachable', async () => {
  const seen = [];
  const host = await createHost(DIR, {
    fetch: async (url) => {
      seen.push(url);
      if (url.startsWith('https://example-abfallapp.regioit.de/')) throw Object.assign(new Error('ENOTFOUND'), { code: 'ERR_NET' });
      return { status: 200, body: JSON.stringify([{ id: 1, name: 'Beispielstadt' }]) };
    },
  });
  try {
    assert.deepEqual(await providers.get('regioit').places(host.gc, 'example'), [{ id: '1', name: 'Beispielstadt' }]);
    assert.deepEqual(seen, ['https://example-abfallapp.regioit.de/abfall-app-example/rest/orte', 'https://abfallapp.regioit.de/abfall-app-example/rest/orte']);
  } finally { await host.close(); }
});

test('errors map to codes (never the response body); bad ids never reach the network', async () => {
  const answers = [{ status: 404, body: '' }, { status: 403, body: '' }, { status: 429, body: '' }, { status: 500, body: 'stack trace with secrets' }, { status: 200, body: '<html>' }];
  const host = await createHost(DIR, { fetch: async () => answers.shift() });
  try {
    for (const code of ['PROVIDER_NOT_FOUND', 'PROVIDER_REFUSED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_HTTP', 'PROVIDER_BAD_RESPONSE']) {
      await assert.rejects(http.getJson(host.gc, 'https://awido.cubefour.de/x'), (e) => e.code === code && !/secrets/.test(e.message));
    }
    await assert.rejects(http.getJson(host.gc, 'https://evil.example.com/'), { code: 'PROVIDER_DENIED' });
    const n = host.fetches.length;
    await assert.rejects(providers.get('regioit').places(host.gc, '../../etc'), { code: 'PROVIDER_CONFIG' });
    await assert.rejects(providers.get('abfallio').places(host.gc, 'not-a-key'), { code: 'PROVIDER_CONFIG' });
    await assert.rejects(providers.get('awido').streets(host.gc, 'regensburg', '1 OR 1'), { code: 'PROVIDER_CONFIG' });
    await assert.rejects(providers.get('regioit').dates(host.gc, { service: 'aachen', place: { id: '1' } }, { from: '2026-01-01', to: '2026-02-01' }), { code: 'PROVIDER_CONFIG' });
    assert.equal(host.fetches.length, n);
  } finally { await host.close(); }
});

test('admin lookup and preview through the API (provider → service → place → street → house)', () => {
  const fx = fixture('provider_awido.json');
  return withHost({ web: fixtureFetch(fx) }, async (host) => {
    const st = await asAdmin(host, 'GET', '/status');
    assert.deepEqual(st.json.providers.map((p) => p.id), ['regioit', 'abfallio', 'awido']);
    assert.ok(st.json.providers.find((p) => p.id === 'awido').services.some((s) => s.id === 'regensburg'));
    const l1 = await asAdmin(host, 'POST', '/providers/lookup', { provider: 'awido', service: 'regensburg' });
    assert.equal(l1.json.level, 'places');
    const l2 = await asAdmin(host, 'POST', '/providers/lookup', { provider: 'awido', service: 'regensburg', place: fx.config.place.id });
    assert.equal(l2.json.level, 'streets');
    const l3 = await asAdmin(host, 'POST', '/providers/lookup', { provider: 'awido', service: 'regensburg', place: fx.config.place.id, street: fx.config.street.id });
    assert.deepEqual(l3.json, { ok: true, level: 'houses', items: [] });
    const pv = await asAdmin(host, 'POST', '/providers/preview', { provider: 'awido', provider_config: fx.config });
    assert.equal(pv.status, 200);
    assert.ok(Array.isArray(pv.json.dates));
    assert.equal((await asAdmin(host, 'POST', '/providers/lookup', { provider: 'nope', service: 'x' })).json.code, 'PROVIDER_UNKNOWN');
    assert.equal((await asAdmin(host, 'POST', '/providers/lookup', { provider: 'awido', service: 'unknown-customer' })).json.code, 'PROVIDER_NOT_FOUND');
    assert.equal((await asAdmin(host, 'POST', '/plans', { name: 'x', source: 'provider', provider: 'awido', provider_config: { service: 'regensburg' } })).json.code, 'PROVIDER_CONFIG');
  });
});

test('plugin.json declares exactly the provider and calendar hosts (no TLD wildcards)', () => {
  const calendar = require('../server/calendar');
  const declared = manifest.permissions.network.internet.map((h) => h.replace(/:443$/, ''));
  const wanted = [...calendar.EXACT_HOSTS, ...calendar.SUFFIX_HOSTS.map((s) => '*.' + s), ...providers.hosts()];
  assert.deepEqual([...declared].sort(), [...new Set(wanted)].sort());
  for (const h of declared) if (h.startsWith('*.')) assert.ok(h.split('.').length >= 3, `${h} is too broad`);
  // every service of the built-in lists has a valid id for its adapter
  for (const p of providers.LIST) for (const s of p.services) assert.match(s.id, p.customService, `${p.id}: ${s.id}`);
});
