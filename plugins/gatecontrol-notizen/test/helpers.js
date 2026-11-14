'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) as GateControl 1.216.0 (services with maxPerHour, events,
// media), a household (Anna and Marc parents, Lena a child, Bob from elsewhere), the clock pinned to Sunday
// 2026-11-08 10:00 in Berlin (the mockups' day), and fake sources (Familie, Mail, Drive, Schule, Alltag) that speak
// docs/notes-sources-contract.md: each keeps its items, answers todo_items in pages and todo_complete.

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const clock = require('../server/clock');

const DIR = path.join(__dirname, '..');
const ANNA = { id: 1, name: 'Anna Berg', role: 'admin' };
const MARC = { id: 2, name: 'Marc Berg', role: 'user' };
const LENA = { id: 3, name: 'Lena', role: 'user' };
const BOB = { id: 4, name: 'Bob', role: 'user' };
const USERS = [ANNA, MARC, LENA, BOB];
const T0 = Date.parse('2026-11-08T09:00:00Z'); // Sun 10:00 CET
const PLUGINS = ['gatecontrol-familie', 'gatecontrol-mail', 'gatecontrol-drive', 'gatecontrol-schule', 'gatecontrol-alltag'];

/** A fake source: state.items (id → item), state.calls, completes; `entry.service = null` takes it away (services.available false). */
function fakeSource(plugin, opts = {}) {
  const state = { items: new Map(), calls: [], completes: [], refuse: null, pageSize: opts.pageSize || 2, down: false };
  const provides = { todo_items: { label: { de: 'x', en: 'x' }, maxPerHour: 600 }, todo_complete: { label: { de: 'x', en: 'x' }, maxPerHour: 600 }, ...(opts.provides || {}) };
  const service = async ({ name, caller, user, payload }) => {
    state.calls.push({ name, caller, user: user && user.id, payload });
    if (state.down) throw new Error('down');
    if (opts.service && !['todo_items', 'todo_complete'].includes(name)) return opts.service({ name, caller, user, payload, state });
    if (caller !== 'gatecontrol-notizen') return { ok: false, code: 'forbidden' };
    if (name === 'todo_items') {
      const mine = [...state.items.values()].filter((i) => (i.users || []).includes(user.id));
      const start = payload.cursor ? Number(payload.cursor) : 0;
      const page = mine.slice(start, start + state.pageSize);
      return { ok: true, items: page, cursor: start + state.pageSize < mine.length ? String(start + state.pageSize) : null, now: clock.now() };
    }
    if (name === 'todo_complete') {
      state.completes.push({ id: payload.id, done: payload.done, user: user.id });
      if (state.refuse) return { ok: false, code: state.refuse };
      const it = state.items.get(payload.id);
      if (!it) return { ok: false, code: 'not_found' };
      it.done = payload.done;
      it.updatedAt = clock.now();
      return { ok: true, item: it };
    }
    return { ok: false, code: 'not_found' };
  };
  return { plugin, provides, service, state };
}

function item(plugin, id, extra = {}) {
  return { id, kind: 'task', title: 'Item ' + id, due: '2026-11-08', allDay: true, area: 'private', users: [ANNA.id], important: false, done: false, canComplete: true,
    open: { plugin, route: 'x/' + id }, updatedAt: clock.now(), ...extra };
}

async function withHost(opts = {}) {
  clock.set(opts.now || T0);
  require('../server/config').reset();
  require('../server/people').reset();
  const sources = opts.sources || PLUGINS.map((p) => fakeSource(p));
  const host = await createHost(DIR, {
    gatecontrol: '1.216.0', users: USERS, license: { required: true, licensed: true, state: 'valid', expiresAt: null },
    settings: opts.settings || {}, services: sources.map((s) => { s.entry = { plugin: s.plugin, provides: s.provides, service: s.service }; return s.entry; }),
    fetch: opts.fetch, mediaFetch: opts.mediaFetch,
    ...(opts.host || {}),
  });
  await host.start();
  const call = async (user, method, p, body, query) => {
    const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user: { ...user, portal: true, loggedIn: true } });
    return r;
  };
  const ok = async (user, method, p, body, query) => {
    const r = await call(user, method, p, body, query);
    if (r.status !== 200 || !r.json || r.json.ok !== true) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const src = (plugin) => sources.find((s) => s.plugin === plugin);
  const push = (plugin, payload) => host.callService('todo_changed', { caller: plugin, user: null, payload: { v: 1, ...payload } });
  // a part of the background run or a button that failed is only logged by the plugin — a test must not pass over it
  const close = async () => {
    const bad = host.logs.filter((l) => /^(?:background part failed|notify action failed|calendar sync failed|calendar marks failed)\b/.test(String(l.message))).map((l) => l.message);
    await host.close();
    if (bad.length && !opts.failuresAllowed) throw new Error('logged failures: ' + bad.join(' | '));
  };
  /** A button of a push pressed by `user` (GateControl: once per push and button — a test presses as often as it says). */
  const press = (user, n, action) => host.notifyAction({ userId: user.id, notificationId: n.id == null ? 1 : n.id, action, data: Object.fromEntries(Object.entries(n.data || {}).filter(([k]) => !['route', 'actions', 'facts'].includes(k))) });
  return { host, call, ok, src, push, press, sources, close };
}

module.exports = { withHost, fakeSource, item, ANNA, MARC, LENA, BOB, USERS, T0, PLUGINS, clock };
