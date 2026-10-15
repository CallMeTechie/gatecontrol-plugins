'use strict';

// 1.3.0 (GateControl ≥ 1.168.0): picture and favourite colour of the
// GateControl account in every member object (avatarUrl, color, colorHex,
// initials) plus presence 'home' | 'away' | 'unknown' | null — the ring of
// the avatar; the shared avatar renderer of the pages, the portal tab and
// the wall (ui/common.js) maps it to the ring: home → favourite colour,
// away → red, otherwise a thin neutral border.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withFamily, USERS, ANNA, MARC, LENA, TIM, KUECHE, portal, kioskViewer } = require('./helpers');
const members = require('../server/members');
const presence = require('../server/presence');
const texts = require('../server/texts.json');

const PIC = '/avatars/' + 'Ab3_-'.repeat(5) + '.webp';
const PIC2 = '/avatars/' + 'Zz9'.repeat(8) + '.png';
// Anna chose pink and a picture; the others keep the default palette[id % 10]
const FACE_USERS = USERS.map((u) => (u.id === ANNA.id ? { ...u, color: 'pink', avatarUrl: PIC } : u));
const ANNA_FACE = { avatarUrl: PIC, color: 'pink', colorHex: '#EC4899', initials: 'AN' };
const MARC_FACE = { avatarUrl: null, color: 'lime', colorHex: '#84CC16', initials: 'MA' };
const LENA_FACE = { avatarUrl: null, color: 'yellow', colorHex: '#EAB308', initials: 'LE' };
const TIM_FACE = { avatarUrl: null, color: 'orange', colorHex: '#F97316', initials: 'TI' };
const FACE_KEYS = ['avatarUrl', 'color', 'colorHex', 'initials'];
const faceOf = (o) => Object.fromEntries(FACE_KEYS.map((k) => [k, o[k]]));

test('face(): the fields of gc.users, defensive — color and colorHex are never null', () => {
  assert.deepEqual(members.face({ id: 2, name: 'Anna', color: 'pink', colorHex: '#ec4899', avatarUrl: PIC, initials: 'AN' }), ANNA_FACE);
  // an older or odd answer: default colour palette[id % 10], computed initials, no picture
  assert.deepEqual(members.face({ id: 13, name: 'Tim Berg' }), { avatarUrl: null, color: 'lime', colorHex: '#84CC16', initials: 'TB' });
  assert.equal(members.face({ id: 4, name: 'x', color: 'red' }).color, 'yellow', 'red is no favourite colour (it means away)');
  assert.equal(members.face({ id: 4, name: 'x', color: 'blue', colorHex: 'blue' }).colorHex, '#3B82F6', 'a bad hex: the palette');
  for (const bad of ['https://evil.example/a.png', '/avatars/../x.png', '/avatars/abc.png', '/avatars/' + 'a'.repeat(22) + '.gif', 'javascript:alert(1)', 7]) {
    assert.equal(members.face({ id: 2, name: 'A', avatarUrl: bad }).avatarUrl, null, String(bad));
  }
  assert.equal(members.face({ id: 2, name: 'A', avatarUrl: PIC2 }).avatarUrl, PIC2);
  assert.deepEqual(['Anna', 'Anna Berg', 'anna.berg', 'Ö', '', '  '].map(members.initialsOf), ['AN', 'AB', 'AB', 'Ö', '?', '?']);
  assert.equal(members.PALETTE.length, 10);
  assert.ok(!members.PALETTE.some((p) => p.key === 'red' || p.hex === '#E5484D'), 'red is not offered');
});

test('ring state mapping: home / away / unknown / null (not shared)', () => {
  assert.equal(presence.ringOf({ share: true, home: true }), 'home');
  assert.equal(presence.ringOf({ share: true, home: false }), 'away');
  assert.equal(presence.ringOf({ share: true, home: null }), 'unknown');
  assert.equal(presence.ringOf({ share: false, home: true }), null);
  assert.equal(presence.ringOf(undefined), null);
});

test('every member object carries the face and presence (module presence off → null)', () => withFamily({ users: FACE_USERS, settings: { mod_wall: true } }, async (host, { as, admin, call }) => {
  const me = (await as(ANNA)('GET', '/me')).json;
  assert.deepEqual({ ...faceOf(me.me), presence: me.me.presence }, { ...ANNA_FACE, presence: null });
  assert.deepEqual(me.members.map((m) => ({ ...faceOf(m), presence: m.presence })), [ANNA_FACE, MARC_FACE, LENA_FACE, TIM_FACE].map((f) => ({ ...f, presence: null })));
  // children see the same fields
  const kid = (await as(TIM)('GET', '/me')).json;
  assert.deepEqual(faceOf(kid.members[0]), ANNA_FACE);

  // admin pages
  const st = (await admin('GET', 'status')).json;
  assert.deepEqual(faceOf(st.members[0]), ANNA_FACE);
  assert.equal(st.members[0].presence, null);
  const added = (await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' })).json.member;
  assert.deepEqual(faceOf(added), { avatarUrl: null, color: 'purple', colorHex: '#A855F7', initials: 'KÜ' });
  const lg = (await admin('GET', 'log')).json;
  assert.deepEqual(lg.children.map(faceOf), [LENA_FACE, TIM_FACE]);
  assert.deepEqual(faceOf(lg.members[0]), ANNA_FACE);

  // the wall: members and the task chips
  await as(ANNA)('POST', '/tasks', { title: 'Zimmer aufräumen', mode: 'fixed', assignees: [LENA.id, ANNA.id], repeat: 'daily' });
  const w = (await call(kioskViewer(KUECHE), 'GET', '/wall')).json;
  assert.deepEqual(w.members.map((m) => ({ ...faceOf(m), presence: m.presence })), [ANNA_FACE, MARC_FACE, LENA_FACE, TIM_FACE].map((f) => ({ ...f, presence: null })));
  assert.deepEqual(w.tasks[0].chips.map(faceOf), [LENA_FACE, ANNA_FACE]);

  // wishlists
  const wl = (await as(MARC)('GET', '/wishes')).json.lists;
  assert.deepEqual(faceOf(wl.find((l) => l.ownerId === ANNA.id)), ANNA_FACE);

  // a new picture / colour (the GateControl app's profile) shows on the next call; the old URL is gone
  host.setUserFace(ANNA.id, { avatarUrl: PIC2, color: 'teal' });
  assert.deepEqual(faceOf((await as(MARC)('GET', '/me')).json.members[0]), { avatarUrl: PIC2, color: 'teal', colorHex: '#14B8A6', initials: 'AN' });
  host.setUserFace(ANNA.id, { avatarUrl: null });
  assert.equal((await as(MARC)('GET', '/me')).json.members[0].avatarUrl, null);

  // a `color` in the admin body (1.0–1.2) is ignored: the colour belongs to the account
  assert.equal((await admin('PATCH', 'members/' + MARC.id, { color: '#123456' })).json.member.color, 'lime');
}));

test('presence in every member object: home / away / unknown / null; device trust and module off → null', () => withFamily({ users: FACE_USERS, settings: { mod_presence: true, mod_wall: true } }, async (host, { as, admin, call, clock }) => {
  for (const u of [ANNA, MARC, TIM]) assert.equal((await as(u)('PUT', '/presence/consent', { share: true })).status, 200);
  await as(ANNA)('POST', '/presence', { home: true });
  await as(MARC)('POST', '/presence', { home: false });
  const want = [[ANNA.id, 'home'], [MARC.id, 'away'], [LENA.id, null], [TIM.id, 'unknown']];
  const pairs = (list) => list.map((m) => [m.userId, m.presence]);

  const me = (await as(LENA)('GET', '/me')).json;
  assert.deepEqual(pairs(me.members), want, 'GET me members');
  assert.equal(me.me.presence, null, 'Lena does not share');
  assert.equal((await as(ANNA)('GET', '/me')).json.me.presence, 'home');
  assert.deepEqual(pairs((await as(LENA)('GET', '/presence')).json.members), want, 'GET presence');
  assert.deepEqual(pairs((await as(LENA)('GET', '/overview')).json.presence.members), want, 'overview');
  assert.deepEqual(faceOf((await as(LENA)('GET', '/presence')).json.members[0]), ANNA_FACE);
  assert.deepEqual(pairs((await admin('GET', 'status')).json.members), want, 'admin page members');
  assert.deepEqual(pairs((await admin('GET', 'presence')).json.members), want, 'admin page presence');
  assert.equal((await admin('PATCH', 'members/' + ANNA.id, { birthdate: '1986-04-03' })).json.member.presence, 'home');

  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  assert.deepEqual(pairs((await call(kioskViewer(KUECHE), 'GET', '/wall')).json.members), want, 'the wall (kiosk)');
  // device trust only: no presence anywhere (like positions)
  assert.ok((await call(portal(KUECHE, false), 'GET', '/wall')).json.members.every((m) => m.presence === null));
  const trust = (await call(portal(LENA, false), 'GET', '/me')).json;
  assert.ok(trust.members.every((m) => m.presence === null) && trust.me.presence === null, 'GET me for device trust');

  // the ring follows the next poll
  clock.add(2 * 60000);
  await as(MARC)('POST', '/presence', { home: true });
  assert.equal((await call(kioskViewer(KUECHE), 'GET', '/wall')).json.members[1].presence, 'home');

  // module off: null everywhere, the face stays
  await admin('PUT', 'modules', { presence: false });
  const off = (await as(LENA)('GET', '/me')).json;
  assert.ok(off.members.every((m) => m.presence === null));
  assert.deepEqual(faceOf(off.members[0]), ANNA_FACE);
  assert.ok((await call(kioskViewer(KUECHE), 'GET', '/wall')).json.members.every((m) => m.presence === null));
  assert.ok((await admin('GET', 'status')).json.members.every((m) => m.presence === null));
}));

// ─── the shared avatar renderer (ui/common.js) in a tiny DOM ──────────────

function fakeDom() {
  const node = (tag) => {
    const n = {
      tagName: tag.toUpperCase(), attrs: {}, children: [], listeners: {}, textContent: '', parentNode: null, className: '',
      style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
      removeChild(c) { n.children = n.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(ev, fn) { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
      classList: { add(c) { n.className = (n.className + ' ' + c).trim(); } },
    };
    return n;
  };
  return { createElement: node, createTextNode: (t) => ({ textContent: t }), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
}

function loadCommon(lang) {
  const window = { FA_CTX: { lang, texts: texts[lang] } };
  const ctx = { window, document: fakeDom(), setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'common.js'), 'utf8'), ctx);
  return window.FA;
}

test('avatar renderer: picture or initials on the favourite colour inside the ring (home: colour, away: red, otherwise neutral)', () => {
  const A = loadCommon('de');
  assert.deepEqual(['home', 'away', 'unknown', null, undefined, 'elsewhere'].map((p) => A.ringOf({ presence: p })), ['home', 'away', 'none', 'none', 'none', 'none']);

  const home = A.avatar({ name: 'Anna', presence: 'home', ...ANNA_FACE }, 40);
  assert.match(home.className, /\bfa-avatar\b/);
  assert.match(home.className, /\bis-ring-home\b/);
  assert.equal(home.style.props['--ring'], '#EC4899', 'home: the favourite colour');
  assert.equal(home.style.props['--c'], '#EC4899');
  assert.deepEqual([home.getAttribute('title'), home.getAttribute('aria-label'), home.getAttribute('role')], ['Anna – zu Hause', 'Anna – zu Hause', 'img']);
  assert.equal(home.children[0].textContent, 'AN', 'the initials stay under the picture (fallback)');
  const img = home.children[1];
  assert.deepEqual([img.tagName, img.getAttribute('src'), img.getAttribute('alt')], ['IMG', PIC, '']);
  img.listeners.error[0]();
  assert.equal(home.children.length, 1, 'a picture that cannot load leaves the initials');

  const away = A.avatar({ name: 'Marc', presence: 'away', ...MARC_FACE });
  assert.match(away.className, /\bis-ring-away\b/);
  assert.equal(away.style.props['--ring'], '#E5484D', 'away: red');
  assert.equal(away.getAttribute('aria-label'), 'Marc – unterwegs');
  assert.equal(away.children.length, 1, 'no picture: initials on the colour');

  for (const p of ['unknown', null, undefined]) {
    const n = A.avatar({ name: 'Lena', presence: p, ...LENA_FACE });
    assert.match(n.className, /\bis-ring-none\b/);
    assert.equal(n.style.props['--ring'], 'transparent', 'no coloured ring');
    assert.equal(n.getAttribute('title'), 'Lena');
    assert.equal(n.getAttribute('aria-hidden'), 'true');
  }
  // an avatarUrl that is no /avatars/ path is never loaded; an older member object (no fields) → initials on a neutral colour
  assert.equal(A.avatar({ name: 'X', avatarUrl: 'https://evil.example/x.png' }).children.length, 1);
  const old = A.avatar({ name: 'Oma Erna', color: '#0F766E' });
  assert.deepEqual([old.children[0].textContent, old.style.props['--c']], ['OE', '#64748B']);

  assert.equal(loadCommon('en').avatarLabel({ name: 'Anna', presence: 'away' }), 'Anna – away');
});
