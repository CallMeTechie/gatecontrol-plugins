'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with fake
// internet answers — recorded provider responses (test/fixtures, public
// example addresses only) and calendar servers — and the users of a small
// household.

const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const tz = require('../server/tz');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ADA = { id: 2, name: 'Ada', role: 'user' };
const BOB = { id: 3, name: 'Bob', role: 'user' };
const USERS = [ADMIN, ADA, BOB];
const BERLIN = 'Europe/Berlin';

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

/** Internet handler answering from a recorded provider fixture (URL, and the GraphQL query for POSTs). */
function fixtureFetch(fx, calls = []) {
  return async (url, o = {}) => {
    calls.push({ url, o });
    const q = o.json && o.json.query;
    const hit = fx.responses.find((r) => r.url === url && (!r.query || r.query === q));
    if (!hit) return { status: 404, body: 'not recorded' };
    return { status: hit.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(hit.body) };
  };
}

/**
 * A host with the household users. opts.web: (url, o) → response | undefined
 * (internet), opts.targets, opts.settings.
 */
async function withHost(opts, fn) {
  const calls = [];
  const host = await createHost(DIR, {
    users: USERS,
    settings: opts.settings || {},
    targets: opts.targets,
    notifyFail: opts.notifyFail,
    fetch: async (url, o) => {
      calls.push({ url, o });
      const r = opts.web ? await opts.web(url, o) : undefined;
      if (r === undefined) throw Object.assign(new Error('offline in this test'), { code: 'ERR_NET' });
      return r;
    },
  });
  host.webCalls = calls;
  await host.start();
  try { return await fn(host); } finally { await host.close(); }
}

const asAdmin = (host, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: ADMIN });
const asPortal = (host, user, method, p, loggedIn = true) => host.request({ method, path: p, body: null, user: { ...user, portal: true, loggedIn } });

/** "YYYY-MM-DD" n days from today (Berlin). */
const day = (n, now = Date.now()) => tz.addDays(tz.localDate(now, BERLIN), n);
/** ICS DATE-TIME in UTC for ms. */
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const compact = (d) => d.replace(/-/g, '');

function vcal(...events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//alltag//DE', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
function vevent(props) {
  return ['BEGIN:VEVENT', ...props, 'END:VEVENT'];
}

module.exports = { DIR, ADMIN, ADA, BOB, USERS, BERLIN, fixture, fixtureFetch, withHost, asAdmin, asPortal, day, utc, compact, vcal, vevent };
