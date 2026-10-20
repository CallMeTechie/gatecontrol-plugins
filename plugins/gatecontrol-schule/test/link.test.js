'use strict';

// 1.3.0 — „WebUntis verknüpfen“ in a person's own profile (server/link.js): only a signed-in person,
// only for himself, only a student account; an account that is already there is not taken over; the
// same person through the parents' account is merged; undoing; the administrator's switch; a limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, setupParent, QR, QR_LENA, ADMIN, EVA, LENA, BOB } = require('./helpers');
const link = require('../server/link');

const STUDENT = { untis: { account: 'student', username: 'lena.muster' } };
const viewer = (u, extra) => ({ ...u, portal: true, loggedIn: true, ...(extra || {}) });
const call = (host, user, method, p, body) => host.request({ method, path: p, query: {}, body: body === undefined ? null : body, user });

test.beforeEach(() => link.reset());

test('a person links his own student account: mapped to him, his to undo; nobody else can', () => withHost(STUDENT, async (host, untis) => {
  assert.equal(await host.portalVisible(viewer(LENA), 'webuntis'), true);
  assert.deepEqual((await call(host, viewer(LENA), 'GET', '/portal/link')).json, { ok: true, allowed: true, students: [] });
  const r = await call(host, viewer(LENA), 'POST', '/portal/link', { mode: 'qr', link: QR_LENA });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.student.name, r.json.merged], ['Lena Muster', false]);
  assert.deepEqual(untis.state.logins, ['secret']);
  // the key only as a secret; the account belongs to Lena, the student is mapped to her by herself
  const st = (await asAdmin(host, 'GET', '/status')).json;
  const acc = st.accounts[0];
  assert.deepEqual([acc.owner.id, acc.students[0].user_id, acc.students[0].link_source, acc.students[0].color_from_user], [LENA.id, LENA.id, 'self', true]);
  assert.ok(!JSON.stringify(st).includes('JBSWY3DPEHPK3PXP'));
  const mine = (await call(host, viewer(LENA), 'GET', '/portal/link')).json.students;
  assert.deepEqual(mine.map((s) => [s.name, s.by, s.removable, s.school, s.klasse]), [['Lena Muster', 'self', true, 'Gymnasium Musterstadt', '5a']]);
  // she now sees her plan in the portal
  assert.equal((await call(host, viewer(LENA), 'GET', '/portal/overview')).json.students.length, 1);
  // twice: already hers
  assert.equal((await call(host, viewer(LENA), 'POST', '/portal/link', { mode: 'qr', link: QR_LENA })).json.code, 'LINK_DUPLICATE');
  // somebody else: neither sees nor removes it
  assert.deepEqual((await call(host, viewer(BOB), 'GET', '/portal/link')).json.students, []);
  assert.equal((await call(host, viewer(BOB), 'DELETE', `/portal/link/${mine[0].id}`)).status, 404);
  // Bob with Lena's QR code: the account is there already — not taken over
  const taken = await call(host, viewer(BOB), 'POST', '/portal/link', { mode: 'qr', link: QR_LENA });
  assert.deepEqual([taken.status, taken.json.code], [409, 'LINK_TAKEN']);
  // undo: the account with everything is gone
  const del = await call(host, viewer(LENA), 'DELETE', `/portal/link/${mine[0].id}`);
  assert.deepEqual(del.json, { ok: true, removed: 'account' });
  assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.accounts, []);
  assert.deepEqual([...host.secrets], [], 'credentials removed');
}));

test('only a signed-in person in the portal: no kiosk device, no device trust, no app, no admin API', () => withHost(STUDENT, async (host) => {
  for (const u of [viewer(LENA, { kiosk: true }), viewer(LENA, { loggedIn: false }), viewer(LENA, { app: true })]) {
    assert.equal((await call(host, u, 'POST', '/portal/link', { mode: 'qr', link: QR_LENA })).status, 403, JSON.stringify(u));
    assert.equal(await host.portalVisible(u, 'webuntis'), false);
  }
  // a plain user on the admin API
  assert.equal((await call(host, { ...LENA }, 'POST', '/accounts', { mode: 'qr', link: QR_LENA })).status, 403);
}));

test('parent accounts are not linked in the profile; refused logins keep nothing; at most 5 tries in 15 minutes', () => withHost({}, async (host, untis) => {
  const r = await call(host, viewer(EVA), 'POST', '/portal/link', { mode: 'qr', link: QR });
  assert.deepEqual([r.status, r.json.code], [422, 'NOT_STUDENT']);
  assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.accounts, [], 'nothing kept');
  untis.state.loginError = { code: -8504, message: 'bad credentials' };
  const bad = await call(host, viewer(EVA), 'POST', '/portal/link', { mode: 'qr', link: QR });
  assert.deepEqual([bad.status, bad.json.code], [502, 'LOGIN_FAILED']);
  assert.ok(!/\bauth\b/.test(bad.json.error.replace(/Anmeldung/g, '')), 'a sentence, no code');
  for (let i = 0; i < 3; i++) await call(host, viewer(EVA), 'POST', '/portal/link', { mode: 'qr', link: QR });
  const fast = await call(host, viewer(EVA), 'POST', '/portal/link', { mode: 'qr', link: QR });
  assert.deepEqual([fast.status, fast.json.code], [429, 'TOO_FAST']);
  assert.equal((await call(host, viewer(EVA), 'POST', '/portal/link', { mode: 'qr', link: 'kaputt' })).status, 400, 'invalid input is not counted as a try against WebUntis');
}));

test('the administrator\'s switch: off → no new links (admins still may), the section only for those with a link', () => withHost({ ...STUDENT, settings: { self_link: false } }, async (host) => {
  assert.equal(await host.portalVisible(viewer(LENA), 'webuntis'), false);
  const r = await call(host, viewer(LENA), 'POST', '/portal/link', { mode: 'qr', link: QR_LENA });
  assert.deepEqual([r.status, r.json.code], [403, 'LINK_OFF']);
  assert.equal((await call(host, viewer(LENA), 'GET', '/portal/link')).json.allowed, false);
  assert.equal(await host.portalVisible(viewer(ADMIN), 'webuntis'), true);
  // an administrator mapped Lena in the settings: she sees it in her profile, cannot undo it
  const add = await asAdmin(host, 'POST', '/accounts', { mode: 'qr', link: QR_LENA });
  assert.equal(add.status, 201);
  const sid = add.json.students[0].id;
  await asAdmin(host, 'PUT', `/students/${sid}`, { user_id: LENA.id });
  assert.equal(await host.portalVisible(viewer(LENA), 'webuntis'), true);
  const mine = (await call(host, viewer(LENA), 'GET', '/portal/link')).json.students;
  assert.deepEqual(mine.map((s) => [s.by, s.removable]), [['admin', false]]);
  const del = await call(host, viewer(LENA), 'DELETE', `/portal/link/${sid}`);
  assert.deepEqual([del.status, del.json.code], [403, 'LINK_ADMIN']);
}));

test('the same person through the parents\' account: no second account — the known student is mapped to her; a conflict is refused', () => withHost({}, async (host, untis) => {
  const { lena } = await setupParent(host);
  // setupParent mapped Lena to LENA — undo that for the merge
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { user_id: null });
  untis.state.account = 'student';
  untis.state.username = 'lena.muster';
  const r = await call(host, viewer(LENA), 'POST', '/portal/link', { mode: 'qr', link: QR_LENA });
  assert.deepEqual([r.status, r.json.merged, r.json.student.id], [200, true, lena.id]);
  let st = (await asAdmin(host, 'GET', '/status')).json;
  assert.equal(st.accounts.length, 1, 'no second account');
  const s = st.accounts[0].students.find((x) => x.id === lena.id);
  assert.deepEqual([s.user_id, s.link_source], [LENA.id, 'self']);
  // undoing only unmaps (the parents' account stays)
  assert.deepEqual((await call(host, viewer(LENA), 'DELETE', `/portal/link/${lena.id}`)).json, { ok: true, removed: 'link' });
  st = (await asAdmin(host, 'GET', '/status')).json;
  assert.deepEqual([st.accounts.length, st.accounts[0].students.find((x) => x.id === lena.id).user_id], [1, null]);
  // mapped to someone else meanwhile: refused, nothing kept
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { user_id: EVA.id });
  const c = await call(host, viewer(LENA), 'POST', '/portal/link', { mode: 'qr', link: QR_LENA });
  assert.deepEqual([c.status, c.json.code], [409, 'LINK_CONFLICT']);
  assert.equal((await asAdmin(host, 'GET', '/status')).json.accounts.length, 1);
}));
