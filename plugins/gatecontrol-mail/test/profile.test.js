'use strict';

// 1.17.0 — the suggestion from the user profile (GateControl ≥ 1.280.0, gc.profile, permissions.profile ["firstName",
// "lastName"]): GET me `suggest` — sender name and signature "Vorname Nachname", read as the person herself (she sees
// "Nur ich" too); without names or on an older GateControl the display name, no signature. Only a suggestion: a new
// account takes what the person confirmed, nothing changes by itself when the profile changes.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withMail, app, ANNA, MARC, DIR } = require('./helpers');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');

const PROFILE = { people: { [ANNA.id]: { firstName: 'Anna', lastName: 'Berger', visibility: { lastName: 'self', firstName: 'self' } } } };

test('plugin.json: version 1.17.0, the profile fields first and last name only — no telephone numbers', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  assert.equal(m.version, '1.18.0');
  assert.deepEqual(m.permissions.profile, ['firstName', 'lastName']);
  assert.equal(m.permissions.users, true);
  assert.equal(m.gatecontrol, '>=1.219.0', 'an older GateControl ignores permissions.profile');
});

test('GET me suggest: from the profile as the person herself sees it; else the display name, no signature', () => withMail({ profile: PROFILE }, async (host, c) => {
  assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.suggest, { senderName: 'Anna Berger', signature: 'Anna Berger', from: 'profile' });
  const call = host.profile.calls.find((x) => x.userId === ANNA.id);
  assert.deepEqual([call.viewer, call.counted], [ANNA.id, true], 'the viewer is the person herself, in her own request');
  // Marc has no names in his profile: his display name
  assert.deepEqual((await c.as(MARC)('GET', 'me')).json.suggest, { senderName: 'Marc', signature: null, from: 'account' });
}));

test('an older GateControl: no gc.profile — the display name as before', () => withMail({}, async (host, c) => {
  assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.suggest, { senderName: 'Anna', signature: null, from: 'account' });
}));

test('a new account takes the confirmed signature; a changed profile changes nothing by itself, only the suggestion', () => withMail({ profile: PROFILE }, async (host, c) => {
  const acc = await c.addGmx(ANNA, { name: 'Anna Berger', body: { signature: 'Anna Berger' } });
  assert.deepEqual([acc.name, acc.signature], ['Anna Berger', 'Anna Berger']);
  const bad = await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna2@gmx.de', password: 'geheim-123', signature: 7 });
  assert.deepEqual([bad.status, bad.json.error.code, bad.json.error.field], [400, 'invalid', 'signature']);
  host.profile.set(ANNA.id, { lastName: 'Keller' });
  await host.profile.changed(ANNA.id, ['lastName']);
  const me = (await c.as(ANNA)('GET', 'me')).json;
  assert.equal(me.suggest.senderName, 'Anna Keller');
  assert.deepEqual([me.accounts[0].name, me.accounts[0].signature], ['Anna Berger', 'Anna Berger'], 'the account keeps its own');
}));

// ── the portal (fake-dom.js) ──
const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
function portal(host, user) {
  const calls = [];
  const gc = {
    async call(method, p, body) {
      const [pth, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path: pth, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
      const r = await host.request({ method, path: pth, body: body === undefined ? null : body, query, user: app(user), lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return r.json;
    },
    on() {},
  };
  const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true }, allowed: true }, t), gc);
  f.window.confirm = () => true;
  f.run();
  const doc = f.document;
  const dialog = () => doc.getElementById('mp-dialog');
  const button = (pred) => doc.body.all().filter((x) => x.localName === 'button' && pred(textOf(x).trim())).pop();
  return { calls, dialog, button, all: () => doc.body.all(), dialogText: () => textOf(dialog()), stop: () => f.stop() };
}

test('the portal: a new account starts with the suggestion; „Übernehmen“ in the account dialog fills, saving stays the person’s step', () => withMail({ profile: PROFILE }, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const p = portal(host, ANNA);
  try {
    (await until('the welcome', () => p.button((x) => x === 'Konto hinzufügen'))).click();
    (await until('the providers', () => p.all().find((x) => x.localName === 'button' && x.className === 'mp-provider' && textOf(x).includes('GMX')))).click();
    await until('the form', () => p.dialogText().includes('Verbinden'));
    const inputs = p.dialog().all();
    const name = inputs.find((x) => x.localName === 'input' && x.getAttribute('type') === 'text' && x.value === 'Anna Berger');
    const sig = inputs.find((x) => x.localName === 'textarea');
    assert.ok(name, 'the sender name suggested');
    assert.equal(sig.value, 'Anna Berger');
    assert.ok(p.dialogText().includes('Vorschlag aus deinem Profil'));
    inputs.find((x) => x.localName === 'input' && x.getAttribute('type') === 'email').value = 'anna@gmx.de';
    inputs.find((x) => x.localName === 'input' && x.getAttribute('type') === 'password').value = 'geheim-123';
    sig.value = 'Viele Grüße\nAnna';
    p.button((x) => x === 'Verbinden').click();
    const post = await until('added', () => p.calls.find((x) => x.method === 'POST' && x.path === 'accounts'));
    assert.deepEqual([post.body.name, post.body.signature], ['Anna Berger', 'Viele Grüße\nAnna'], 'what the person confirmed');
    await until('the account', async () => (await c.as(ANNA)('GET', 'me')).json.accounts.length === 1);
  } finally { p.stop(); }
  // the account dialog: another name, no signature → „Übernehmen“ fills both, nothing is saved by itself
  const acc = (await c.as(ANNA)('GET', 'me')).json.accounts[0];
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { name: 'Anna', signature: '' });
  const q = portal(host, ANNA);
  try {
    const gear = await until('the settings', () => q.all().find((x) => x.getAttribute('aria-label') === 'Mail-Einstellungen'));
    gear.click();
    (await until('the account row', () => q.dialog().all().find((x) => x.localName === 'button' && x.className.includes('is-acc')))).click();
    await until('the account dialog', () => q.dialogText().includes('Signatur') && q.dialogText().includes('Übernehmen'));
    assert.ok(q.dialogText().includes('„Anna Berger“'));
    const before = q.calls.filter((x) => x.method === 'PATCH').length;
    q.button((x) => x === 'Übernehmen').click();
    const inputs = q.dialog().all();
    assert.ok(inputs.some((x) => x.localName === 'input' && x.getAttribute('type') === 'text' && x.value === 'Anna Berger'));
    assert.equal(inputs.find((x) => x.localName === 'textarea').value, 'Anna Berger');
    assert.equal(q.calls.filter((x) => x.method === 'PATCH').length, before, 'nothing saved by itself');
    q.button((x) => x === 'Speichern').click();
    const patch = await until('saved', () => q.calls.find((x) => x.method === 'PATCH' && x.path === `accounts/${acc.id}`));
    assert.deepEqual([patch.body.name, patch.body.signature], ['Anna Berger', 'Anna Berger']);
  } finally { q.stop(); }
}));
