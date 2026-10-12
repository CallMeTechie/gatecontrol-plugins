'use strict';

// Kalender: subscription addresses (allowed hosts, webcal), the secret
// address never leaving the plugin, home-network calendars with Basic auth,
// conditional refreshes, fail-soft errors with backoff.

const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../server/calendar');
const store = require('../server/store');
const config = require('../server/config');
const { withHost, asAdmin, ADMIN, utc, vcal, vevent } = require('./helpers');

const SECRET_URL = 'https://calendar.google.com/calendar/ical/family%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const SECRET_PART = 'private-0123456789abcdef';

function calendarText(now = Date.now()) {
  return vcal(
    vevent(['UID:e1@test', `DTSTART:${utc(now + 3 * 3600000)}`, `DTEND:${utc(now + 4 * 3600000)}`, 'SUMMARY:Zahnarzt', 'LOCATION:Praxis Dr. Muster']),
    vevent(['UID:e2@test', `DTSTART:${utc(now + 26 * 3600000)}`, 'DURATION:PT1H', 'SUMMARY:Elternabend']),
  );
}

test('addresses: Google, iCloud, Outlook (also webcal://); anything else is refused with a clear code', () => {
  assert.deepEqual(calendar.checkUrl(SECRET_URL), { url: SECRET_URL, host: 'calendar.google.com' });
  assert.deepEqual(calendar.checkUrl('webcal://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTA'), { url: 'https://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', host: 'p52-caldav.icloud.com' });
  assert.equal(calendar.checkUrl('webcals://p01-caldav.icloud.com/published/2/abc').host, 'p01-caldav.icloud.com');
  assert.equal(calendar.checkUrl('https://outlook.office365.com/owa/calendar/abc@example.com/def/calendar.ics').host, 'outlook.office365.com');
  assert.equal(calendar.checkUrl('https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/abc/cid-1/calendar.ics').host, 'outlook.live.com');
  assert.equal(calendar.checkUrl('  https://outlook.office.com/owa/calendar/x/y/calendar.ics#frag ').url, 'https://outlook.office.com/owa/calendar/x/y/calendar.ics');
  const refused = {
    'https://calendar.example.com/a.ics': 'URL_HOST_NOT_ALLOWED',
    'https://icloud.com.evil.example/a.ics': 'URL_HOST_NOT_ALLOWED',
    'https://evilicloud.com/a.ics': 'URL_HOST_NOT_ALLOWED',
    'https://calendar.google.com.evil.example/x': 'URL_HOST_NOT_ALLOWED',
    'https://calendar.google.com:8443/x': 'URL_HOST_NOT_ALLOWED',
    'http://calendar.google.com/x': 'URL_INVALID',
    'https://user:pw@calendar.google.com/x': 'URL_INVALID',
    'ftp://calendar.google.com/x': 'URL_INVALID',
    'not a url': 'URL_INVALID',
    '': 'URL_INVALID',
  };
  for (const [u, code] of Object.entries(refused)) assert.throws(() => calendar.checkUrl(u), { code }, u);
  assert.equal(calendar.checkPath('/remote.php/dav/calendars/ada/personal/?export'), '/remote.php/dav/calendars/ada/personal/?export');
  for (const p of ['remote.php', '/a/../b', '/a b', '/a\\b', '/a/..?x']) assert.throws(() => calendar.checkPath(p), { code: 'PATH_INVALID' }, p);
});

test('internet subscription: the secret address is stored as a secret, never returned or logged; default visibility = creator', () => {
  const requested = [];
  return withHost({ web: (url, o) => { requested.push({ url, o }); return { status: 200, headers: { etag: '"v1"' }, bodyBase64: Buffer.from(calendarText()).toString('base64') }; } }, async (host) => {
    const r = await asAdmin(host, 'POST', '/subscriptions', { name: 'Familie', color: '#AA3366', source: 'url', url: SECRET_URL.replace('https://', 'webcal://') });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.result.ok, true);
    assert.equal(r.json.result.events, 2);
    assert.equal(requested[0].url, SECRET_URL, 'webcal:// fetched as https://');
    assert.ok(host.secrets.has(`sub.${r.json.subscription.id}.url`), 'stored with setSecret');
    const st = await asAdmin(host, 'GET', '/status');
    const s = st.json.subscriptions[0];
    assert.equal(s.address, 'calendar.google.com/…');
    assert.deepEqual(s.users.map((u) => u.id), [ADMIN.id], 'only the administrator who added it');
    assert.equal(s.color, '#aa3366');
    assert.equal(s.week_count, 2);
    const everything = JSON.stringify([r.json, st.json, (await asAdmin(host, 'GET', `/subscriptions/${s.id}/events`)).json, host.logs]);
    assert.ok(!everything.includes(SECRET_PART), 'the secret address never leaves the plugin');
    const dbRow = (await host.gc.db.get('SELECT * FROM subscriptions WHERE id = ?', [s.id])).row;
    assert.ok(!JSON.stringify(dbRow).includes(SECRET_PART), 'not in the database either');
    // editing without a new address keeps it; a new address replaces it
    assert.equal((await asAdmin(host, 'PUT', `/subscriptions/${s.id}`, { name: 'Familie Muster', url: '' })).status, 200);
    assert.equal(await store.subSecret(host.gc, s.id, 'url'), SECRET_URL);
    assert.equal((await asAdmin(host, 'PUT', `/subscriptions/${s.id}`, { url: 'https://calendar.example.com/x.ics' })).json.code, 'URL_HOST_NOT_ALLOWED');
    assert.equal((await asAdmin(host, 'POST', '/subscriptions', { name: 'X', source: 'url' })).json.code, 'URL_REQUIRED');
    // deleting removes the secret
    await asAdmin(host, 'DELETE', `/subscriptions/${s.id}`);
    assert.equal(await store.subSecret(host.gc, s.id, 'url'), null);
    assert.ok(!host.secrets.has(`sub.${s.id}.url`));
  });
});

test('a failing server: codes only (never the address), backoff, the last good events stay', () => {
  let mode = 'ok';
  return withHost({
    web: () => {
      if (mode === 'ok') return { status: 200, body: calendarText() };
      if (mode === 'auth') return { status: 401, body: '' };
      if (mode === 'garbage') return { status: 200, body: '<html>login</html>' };
      throw Object.assign(new Error(`connect ECONNREFUSED for ${SECRET_URL}`), { code: 'ERR_NET' });
    },
  }, async (host) => {
    const cfg = config.fromSettings({});
    const r = await asAdmin(host, 'POST', '/subscriptions', { name: 'F', source: 'url', url: SECRET_URL });
    const id = r.json.subscription.id;
    const now = Date.now();
    for (const [m, code, step] of [['auth', 'CAL_AUTH:401', 0], ['net', 'CAL_UNREACHABLE', 1], ['garbage', 'ICS_INVALID', 2]]) {
      mode = m;
      const sub = await store.getSub(host.gc, id);
      await calendar.refreshSub(host.gc, sub, cfg, now);
      const after = await store.getSub(host.gc, id);
      assert.equal(after.status, 'error');
      assert.equal(after.last_error, code);
      assert.equal(after.next_refresh_at, now + calendar.BACKOFF[step]);
      assert.equal(after.event_count, 2, 'last good events kept');
      assert.equal((await store.eventsBetween(host.gc, [id], now, now + 7 * 86400000)).length, 2);
    }
    assert.ok(!JSON.stringify(host.logs).includes(SECRET_PART));
    const st = await asAdmin(host, 'GET', '/status');
    assert.equal(st.json.subscriptions[0].error_text, 'Die Antwort ist kein Kalender (ICS).');
  });
});

test('conditional refresh: ETag / Last-Modified, 304 keeps the events; a full read at least daily', () => {
  const seen = [];
  return withHost({
    web: (url, o) => {
      seen.push(o.headers || {});
      if (o.headers && o.headers['if-none-match'] === '"v1"') return { status: 304, headers: {}, body: '' };
      return { status: 200, headers: { etag: '"v1"', 'last-modified': 'Sun, 11 Oct 2026 08:00:00 GMT' }, body: calendarText() };
    },
  }, async (host) => {
    const cfg = config.fromSettings({});
    const r = await asAdmin(host, 'POST', '/subscriptions', { name: 'F', source: 'url', url: SECRET_URL });
    const id = r.json.subscription.id;
    assert.equal(seen[0]['if-none-match'], undefined, 'first read is unconditional');
    const t1 = Date.now() + 31 * 60000;
    const res = await calendar.refreshSub(host.gc, await store.getSub(host.gc, id), cfg, t1);
    assert.deepEqual(res, { ok: true, unchanged: true });
    assert.equal(seen[1]['if-none-match'], '"v1"');
    assert.equal(seen[1]['if-modified-since'], 'Sun, 11 Oct 2026 08:00:00 GMT');
    assert.equal((await store.getSub(host.gc, id)).event_count, 2);
    const t2 = Date.now() + 25 * 3600000;
    await calendar.refreshSub(host.gc, await store.getSub(host.gc, id), cfg, t2);
    assert.equal(seen[2]['if-none-match'], undefined, 'after a day: full read so the window moves');
    // the background run takes only what is due
    const before = seen.length;
    assert.equal(await calendar.tick(host.gc, cfg, t2 + 60000), 0);
    assert.equal(seen.length, before);
    assert.equal(await calendar.tick(host.gc, cfg, t2 + calendar.EVERY + 1), 1);
  });
});

test('home-network calendar: through the assigned target with Basic auth (credentials secret)', () => {
  const got = [];
  const targets = { calendar: [{ label: 'nextcloud.home', fetch: async (p, o) => { got.push({ p, o }); return { status: 200, bodyBase64: Buffer.from(calendarText(), 'latin1').toString('base64') }; } }] };
  return withHost({ targets }, async (host) => {
    const st0 = await asAdmin(host, 'GET', '/status');
    assert.deepEqual(st0.json.targets, [{ index: 0, label: 'nextcloud.home' }]);
    assert.equal((await asAdmin(host, 'POST', '/subscriptions', { name: 'NC', source: 'target', target_index: 3, path: '/x' })).json.code, 'TARGET_REQUIRED');
    assert.equal((await asAdmin(host, 'POST', '/subscriptions', { name: 'NC', source: 'target', target_index: 0, path: 'x' })).json.code, 'PATH_INVALID');
    const r = await asAdmin(host, 'POST', '/subscriptions', { name: 'Nextcloud', source: 'target', target_index: 0, path: '/remote.php/dav/calendars/ada/personal/?export', username: 'ada', password: 'app-pass-123', users: [2, 3], reminder: '30', allday_reminder: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.result.events, 2);
    assert.equal(got[0].p, '/remote.php/dav/calendars/ada/personal/?export');
    assert.equal(got[0].o.headers.authorization, 'Basic ' + Buffer.from('ada:app-pass-123').toString('base64'));
    assert.equal(got[0].o.index, 0);
    const s = (await asAdmin(host, 'GET', '/status')).json.subscriptions[0];
    assert.deepEqual([s.address, s.target_label, s.has_credentials, s.reminder, s.allday_reminder], ['/remote.php/dav/calendars/ada/personal/?export', 'nextcloud.home', true, '30', false]);
    assert.deepEqual(s.users.map((u) => u.username), ['Ada', 'Bob']);
    assert.ok(!JSON.stringify(s).includes('app-pass-123'));
    // credentials cleared on request
    await asAdmin(host, 'PUT', `/subscriptions/${s.id}`, { clear_credentials: true });
    assert.equal(await store.subSecret(host.gc, s.id, 'password'), null);
    assert.equal(got.at(-1).o.headers.authorization, undefined);
    assert.equal((await asAdmin(host, 'PUT', `/subscriptions/${s.id}`, { users: [42] })).json.code, 'USERS_INVALID');
    assert.equal((await asAdmin(host, 'PUT', `/subscriptions/${s.id}`, { reminder: '5' })).json.code, 'INVALID');
  });
});

test('Latin-1 calendars are read (not valid UTF-8)', () => {
  const text = vcal(vevent(['UID:l', 'DTSTART;VALUE=DATE:20261012', 'SUMMARY:Grünschnitt Größe']));
  assert.ok(calendar.decode({ bodyBase64: Buffer.from(text, 'latin1').toString('base64') }).includes('Grünschnitt Größe'));
  assert.ok(calendar.decode({ bodyBase64: Buffer.from('﻿' + text, 'utf8').toString('base64') }).startsWith('BEGIN:VCALENDAR'));
});

test('the admin API refuses portal viewers and non-admins', () => withHost({}, async (host) => {
  for (const user of [{ id: 2, name: 'Ada', role: 'user' }, { ...ADMIN, portal: true, loggedIn: true }]) {
    const r = await host.request({ method: 'GET', path: '/status', user });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'FORBIDDEN');
  }
}));
