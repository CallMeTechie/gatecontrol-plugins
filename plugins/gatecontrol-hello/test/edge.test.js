'use strict';

// The edge part (edge/index.js) with a `gc` of its own, shaped like the gateway's (gatecontrol-gateway
// src/edge/child/bootstrap.js): gc.handle, gc.emit, gc.config, gc.onConfig, gc.log. On the gateway a handler gets
// (params, gc); an error with a code of its own reaches the server part as edge_error "<code>: <message>".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');

/** A fresh edge part and a fake gc: handlers, emitted events, log lines, configure(data) like the edge host. */
function load() {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  const handlers = new Map();
  const listeners = [];
  const events = [];
  const logs = [];
  let config = null;
  const gc = Object.freeze({
    id: 'gatecontrol-hello',
    version: '1.1.0',
    handle: (method, fn) => {
      if (typeof method !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(method)) throw new Error('gc.handle: invalid method name');
      handlers.set(method, fn);
    },
    emit: (name, data) => {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(name)) throw new Error('gc.emit: invalid event name');
      events.push({ name, data: JSON.parse(JSON.stringify(data === undefined ? null : data)) });
    },
    config: () => config,
    onConfig: (fn) => { listeners.push(fn); },
    log: Object.freeze({ info: (...a) => logs.push(['info', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) }),
  });
  return {
    part, gc, events, logs,
    /** gc.edge.call(gatewayId, method, params) as the edge host runs it: unknown method → unknown_method, JSON both ways */
    async call(method, params) {
      const fn = handlers.get(method);
      if (!fn) throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown_method' });
      return JSON.parse(JSON.stringify(await fn(JSON.parse(JSON.stringify(params)), gc)));
    },
    /** gc.edge.configure(gatewayId, data) arrives */
    configure(data) { config = data; for (const fn of listeners) fn(config, gc); },
  };
}

test('greet answers with the name, the time and the greeting of the configuration', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-11-05T10:00:00.000Z') });
  const e = load();
  await e.part.start(e.gc);
  try {
    assert.deepEqual(await e.call('greet', { name: 'Ada' }), { text: 'Hallo Ada vom Gateway', at: '2026-11-05T10:00:00.000Z', greeting: null });
    e.configure({ greeting: 'Moin' });
    assert.deepEqual(await e.call('greet', { name: '  Ben ' }), { text: 'Hallo Ben vom Gateway', at: '2026-11-05T10:00:00.000Z', greeting: 'Moin' });
    assert.deepEqual(await e.call('greet', { name: 'x'.repeat(64) }).then((r) => r.text.length), 'Hallo  vom Gateway'.length + 64);
  } finally { e.part.stop(e.gc); }
});

test('greet checks its input: a text of 1 to 64 characters, else invalid_name', async () => {
  const e = load();
  await e.part.start(e.gc);
  try {
    for (const params of [{}, null, { name: '' }, { name: '   ' }, { name: 42 }, { name: ['Ada'] }, { name: 'x'.repeat(65) }]) {
      await assert.rejects(e.call('greet', params), (err) => err.code === 'invalid_name' && err.code.length <= 32, JSON.stringify(params));
    }
    await assert.rejects(e.call('nope', {}), (err) => err.code === 'unknown_method');
  } finally { e.part.stop(e.gc); }
});

test('a heartbeat at start and every 60 s with the uptime; stop() ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const e = load();
  await e.part.start(e.gc);
  assert.deepEqual(e.events, [{ name: 'heartbeat', data: { uptimeS: 0 } }]);
  t.mock.timers.tick(59 * 1000);
  assert.equal(e.events.length, 1);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(60 * 1000);
  assert.deepEqual(e.events.slice(1), [{ name: 'heartbeat', data: { uptimeS: 60 } }, { name: 'heartbeat', data: { uptimeS: 120 } }]);
  e.part.stop(e.gc);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(e.events.length, 3);
});

test('a configuration that arrives is logged', async () => {
  const e = load();
  await e.part.start(e.gc);
  try {
    e.configure({ greeting: 'Servus' });
    e.configure(null);
    assert.deepEqual(e.logs, [['info', 'configuration received greeting "Servus"'], ['info', 'configuration received without greeting']]);
  } finally { e.part.stop(e.gc); }
});
