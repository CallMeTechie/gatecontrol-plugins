'use strict';

// The licence's people (Mail 1.1, like Drive): a person the administrator allows gets a place of their kind the first time
// they use Mail while the licence has room; without one GET me answers (seat: null) and everything else is 403 no_seat,
// without a valid licence not_licensed. The administrator sees the licence (tier, x of y, exceeded), changes a person's
// kind or switches them off, and fetches the licence anew; a lifetime licence without a tier counts nobody.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA, MARC, BOB, ADMIN } = require('./helpers');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');

const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 1500) {
  for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
function adminGc(host) {
  return {
    async call(method, p, body) {
      const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: ADMIN, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.code = r.json && r.json.error && r.json.error.code; throw e; }
      return r.json;
    },
  };
}

const FAMILY2 = { tier: 'family', seats: { included: 2, family: 0, business: 0 } };

test('family tier with 2 people: the first two get a family place, the third 403 no_seat; switching off frees a place', () => withMail({ license: FAMILY2 }, async (host, c) => {
  const anna = (await c.as(ANNA)('GET', 'me')).json;
  assert.deepEqual([anna.seat, anna.licence], ['family', { valid: true, tier: 'family' }]);
  assert.equal((await c.as(MARC)('GET', 'me')).json.seat, 'family');
  // Bob: GET me answers without a place, the rest is refused with Drive's code and words
  const bob = await c.as(BOB)('GET', 'me');
  assert.deepEqual([bob.status, bob.json.seat], [200, null]);
  const no = await c.as(BOB)('GET', 'folders');
  assert.deepEqual([no.status, no.json.error.code], [403, 'no_seat']);
  assert.match(no.json.error.message, /Mail ist für dich noch nicht freigeschaltet/);
  assert.equal((await c.as(BOB)('POST', 'accounts', { provider: 'gmx', email: 'bob@gmx.de', password: 'x' })).json.error.code, 'no_seat');
  assert.deepEqual(await host.callService('new_draft', { caller: 'gatecontrol-drive', user: { id: BOB.id, name: 'Bob', role: 'user' }, payload: {} }), { ok: false, code: 'no_seat' });
  // the settings page: the licence, 2 of 2, every person with their place
  const st = (await c.admin('GET', 'admin/settings')).json.seats;
  assert.deepEqual([st.licence.tier, st.counts.total, st.limits.total, st.exceeded], ['family', 2, 2, false]);
  assert.deepEqual(st.people.filter((p) => p.allowed).map((p) => [p.name, p.seat]).sort(), [['Anna', 'family'], ['Bob', null], ['Marc', 'family'], ['admin', null]]);
  // a kind the licence has not; a full licence
  assert.equal((await c.admin('PUT', `admin/seats/${BOB.id}`, { kind: 'business' })).json.error.code, 'seat_kind');
  assert.deepEqual([(await c.admin('PUT', `admin/seats/${BOB.id}`, { kind: 'family' })).status], [409]);
  // Marc switched off: his place is free, Bob gets it on his next request; Marc never again on his own
  const off = (await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: null })).json;
  assert.equal(off.seat, null);
  assert.equal(off.seats.counts.total, 1);
  assert.equal((await c.as(MARC)('GET', 'folders')).json.error.code, 'no_seat');
  assert.equal((await c.as(BOB)('GET', 'folders')).status, 200);
  assert.equal((await c.as(MARC)('GET', 'me')).json.seat, null);
  // the overview names the licence too
  const o = (await c.admin('GET', 'admin/overview')).json.seats;
  assert.deepEqual([o.counts.total, o.limits.total, o.exceeded], [2, 2, false]);
}));

test('combo: a member of a family group gets a family place, anyone else a business place; the licence gets smaller → exceeded', () => withMail({
  license: { tier: 'combo', seats: { included: 2, family: 0, business: 0 } },
  groups: [{ id: 1, name: 'Familie Berg', kind: 'family', members: [{ userId: ANNA.id, role: 'parent' }] }],
}, async (host, c) => {
  assert.equal((await c.as(ANNA)('GET', 'me')).json.seat, 'family');
  assert.equal((await c.as(MARC)('GET', 'me')).json.seat, 'business');
  assert.equal((await c.as(BOB)('GET', 'me')).json.seat, null, 'two included, both taken');
  // the administrator changes Marc's kind
  assert.equal((await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: 'family' })).json.seat.kind, 'family');
  // fewer people in the licence: those with a place keep working, the page says exceeded
  host.license.seats = { included: 1, family: 0, business: 0 };
  assert.equal((await c.as(MARC)('GET', 'folders')).status, 200);
  const st = (await c.admin('GET', 'admin/settings')).json.seats;
  assert.deepEqual([st.counts.total, st.limits.total, st.exceeded], [2, 1, true]);
}));

test('a licence without people (lifetime, no tier) counts nobody; no valid licence: not_licensed, nothing synced or sent', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  await c.addGmx(ANNA);
  for (const u of [MARC, BOB]) assert.equal((await c.as(u)('GET', 'me')).json.seat, 'business', 'no limit');
  const st = (await c.admin('GET', 'admin/settings')).json.seats;
  assert.deepEqual([st.licence.tier, st.limits.total, st.exceeded], [null, null, false]);
  const d = (await c.as(ANNA)('POST', 'drafts', { to: ['bo@web.de'], subject: 'Hallo', html: '<p>x</p>' })).json.draft;
  await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
  host.license.licensed = false;
  const me = (await c.as(ANNA)('GET', 'me')).json;
  assert.deepEqual([me.seat, me.licence.valid], [null, false]);
  const r = await c.as(ANNA)('GET', 'folders');
  assert.deepEqual([r.status, r.json.error.code], [403, 'not_licensed']);
  assert.match(r.json.error.message, /Lizenz für Mail fehlt/);
  await host.gc.db.run("UPDATE outbox SET send_at = 0 WHERE state = 'waiting'");
  await c.tick();
  assert.equal(c.mail.sent.length, 0, 'no sending without a licence');
  host.license.licensed = true;
  await c.tick();
  assert.equal(c.mail.sent.length, 1);
}));

test('a person switched off: their outbox waits; "Lizenz jetzt abrufen" fetches the licence', () => withMail({
  license: FAMILY2, licenseRefresh: () => ({ seats: { included: 2, family: 3, business: 0 } }),
}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  await c.addGmx(ANNA);
  const d = (await c.as(ANNA)('POST', 'drafts', { to: ['bo@web.de'], subject: 'Hallo', html: '<p>x</p>' })).json.draft;
  await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
  await c.admin('PUT', `admin/seats/${ANNA.id}`, { kind: null });
  await host.gc.db.run("UPDATE outbox SET send_at = 0 WHERE state = 'waiting'");
  await c.tick();
  assert.equal(c.mail.sent.length, 0);
  await c.admin('PUT', `admin/seats/${ANNA.id}`, { kind: 'family' });
  await c.tick();
  assert.equal(c.mail.sent.length, 1);
  const r = (await c.admin('POST', 'admin/license/refresh')).json;
  assert.equal(r.refreshed, true);
  assert.equal(r.seats.limits.total, 5);
  assert.equal(host.licenseRefreshes.length, 1);
}));

test('the admin page shows the licence card; the portal the note without a place', () => withMail({ license: FAMILY2 }, async (host, c) => {
  const page = await host.render({ view: 'page', page: 'settings', lang: 'de' });
  const html = typeof page === 'string' ? page : page.html;
  assert.match(html, /"a\.seats_title":"Personen und Lizenz"/);
  const portal = await host.render({ view: 'portal', lang: 'de', user: { id: BOB.id, loggedIn: true } });
  const ph = typeof portal === 'string' ? portal : portal.html;
  assert.match(ph, /"p\.no_seat_title":"Mail ist für dich noch nicht freigeschaltet"/);
}));

test('smoke: the settings page shows "Personen und Lizenz" (x of y, full), the administrator switches a person off', () => withMail({ license: FAMILY2 }, async (host, c) => {
  await c.as(ANNA)('GET', 'me');
  await c.as(MARC)('GET', 'me');
  const f = createWindow(ui.render({ view: 'page', page: 'settings', lang: 'de' }, t), adminGc(host));
  try {
    f.run();
    const doc = f.document;
    const page = doc.getElementById('ma-page');
    await until('licence card', () => textOf(page).includes('Personen und Lizenz'));
    assert.ok(textOf(page).includes('Lizenz · Familie'));
    assert.ok(textOf(page).includes('2 von 2 Personen'));
    assert.ok(textOf(page).includes('Die Lizenz ist voll'));
    // since 1.5.0: where the attachments lie — a note pointing to GateControl's „Speicherorte“, nothing to choose here
    assert.ok(textOf(page).includes('Speicherort der Anhänge') && textOf(page).includes('Auf diesem Server'));
    assert.ok(textOf(page).includes('Übersicht › Speicherorte') && textOf(page).includes('Einstellungen › Plugins › Speicher'));
    const sel = await until('Marc\'s place', () => doc.querySelectorAll('select').find((x) => x.getAttribute('aria-label') === 'Mail für Marc'));
    sel.value = '';
    sel.dispatchEvent({ type: 'change', target: sel });
    await until('switched off', () => textOf(doc.getElementById('mp-toast')).includes('Marc ist abgeschaltet'));
    await until('1 of 2', () => textOf(doc.getElementById('ma-page')).includes('1 von 2 Personen'));
    assert.equal((await c.as(MARC)('GET', 'folders')).json.error.code, 'no_seat');
  } finally { f.stop(); }
  // the overview: the licence in one line
  const o = createWindow(ui.render({ view: 'page', page: 'overview', lang: 'de' }, t), adminGc(host));
  try {
    o.run();
    await until('overview licence', () => textOf(o.document.getElementById('ma-page')).includes('1 von 2 Personen'));
  } finally { o.stop(); }
}));
