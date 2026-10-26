'use strict';

// 0.3.0: the admin pages (render, a smoke test of ui/admin.js), the backup hint, team folders for administrators, and
// the services for other plugins (list_areas, save_file).

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { t } = require('../server/text');
const manifest = require('../plugin.json');
const { withHost, ADMIN, ANNA, MARC, LENA, OMA, BOB, FAMILY, OFFICE, DAY } = require('./helpers');
const { createWindow } = require('./fake-dom');

const ctxOf = (html) => JSON.parse(html.split('window.DA_CTX=')[1].split(';</script>')[0]);

test('render: the admin pages overview, people, teams — inline, texts a.*, no title of their own', () => {
  assert.deepEqual(manifest.ui.pages.map((p) => p.id), ['overview', 'people', 'teams']);
  for (const page of ['overview', 'people', 'teams', 'nonsense']) {
    const html = ui.render({ view: 'page', page, lang: 'de' }, t);
    const ctx = ctxOf(html);
    assert.equal(ctx.page, page === 'nonsense' ? 'overview' : page);
    assert.equal(ctx.texts['a.licence'], 'Lizenz');
    assert.ok(!ctx.texts['p.share'], 'no portal texts');
    assert.ok(!/<h1/i.test(html));
    assert.ok(!/<script[^>]*\bsrc=|<link\b|<iframe\b/i.test(html));
    assert.ok(html.includes('id="da-page"'));
  }
  assert.equal(ctxOf(ui.render({ view: 'page', page: 'teams', lang: 'en' }, t)).texts['a.team_new'], 'New team folder');
});

test('the backup hint: strong while an area lies on this server or a NAS, subtle in S3, off by the administrator; weekly to admins', async () => {
  await withHost({}, async (host, c) => {
    await c.as(ANNA)('GET', 'me'); // Anna's areas: my files, the family, Lena's folder
    let o = (await c.admin('GET', 'admin/overview')).json.overview;
    assert.equal(o.backup.level, 'strong');
    assert.ok(o.backup.areas.some((a) => a.mediaArea === `f${FAMILY}`));
    assert.equal(o.areas.find((a) => a.kind === 'family').storage.target.kind, 'server');
    // the weekly notification to administrators
    await host.tick();
    let notes = c.pushes().filter((n) => n.topic === 'backup_hint');
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].users, [ADMIN.id]);
    assert.match(notes[0].body, /Familie Berg/);
    c.clock.add(DAY);
    await host.tick();
    assert.equal(c.pushes().filter((n) => n.topic === 'backup_hint').length, 1, 'once a week');
    c.clock.add(7 * DAY);
    await host.tick();
    assert.equal(c.pushes().filter((n) => n.topic === 'backup_hint').length, 2);
    // everything in S3: subtle, no notification
    for (const a of host.mediaAreas.values()) a.target = { id: 7, kind: 's3', label: 'Hetzner' };
    o = (await c.admin('GET', 'admin/overview')).json.overview;
    assert.deepEqual(o.backup, { level: 'subtle', areas: [] });
    assert.equal(o.areas[0].storage.target.label, 'Hetzner');
    // hidden by the administrator
    host.mediaAreas.get(`f${FAMILY}`).target = null;
    const off = await c.admin('PUT', 'admin/backup-hint', { on: false });
    assert.equal(off.json.backup.level, 'off');
    assert.equal(host.settings.backup_hint, false);
    c.clock.add(8 * DAY);
    await host.tick();
    assert.equal(c.pushes().filter((n) => n.topic === 'backup_hint').length, 2);
  });
});

test('team folders for administrators: members with names and group paths', async () => {
  await withHost({}, async (host, c) => {
    const tm = await c.admin('POST', 'admin/teams', { label: 'Buchhaltung', members: [{ principal: `g:${OFFICE}`, role: 'write' }, { principal: `u:${MARC.id}`, role: 'read' }], quota: 10 * 1024 ** 3 });
    assert.equal(tm.status, 200);
    const list = await c.admin('GET', 'admin/teams');
    const t1 = list.json.teams[0];
    assert.deepEqual(t1.members.map((m) => [m.principal, m.type, m.label, m.role]), [[`g:${OFFICE}`, 'group', 'Büro', 'write'], [`u:${MARC.id}`, 'user', 'Marc', 'read']]);
    assert.equal(t1.files, 0);
    assert.equal(t1.quota, 10 * 1024 ** 3);
  });
});

test('services: list_areas and save_file for the person of the call', async () => {
  await withHost({}, async (host, c) => {
    const call = (user, name, payload) => host.callService(name, { caller: 'gatecontrol-messenger', user: user ? { id: user.id, name: user.name, role: user.role } : null, payload });
    const handed = async (user, data, mime = 'application/pdf') => (await host.upload(user, Buffer.from(data), mime)).body.mediaId;
    const la = await call(ANNA, 'list_areas', {});
    assert.equal(la.ok, true);
    assert.deepEqual(la.areas.map((a) => [a.kind, a.writable]).sort(), [['child', false], ['family', true], ['mine', true]]);
    assert.equal(la.areas.find((a) => a.kind === 'mine').label, 'Meine Dateien');
    // save into the family, the folders made on the way
    const r1 = await call(ANNA, 'save_file', { mediaId: await handed(ANNA, '%PDF-1'), area: 'family', path: 'Schule/2026-10/Elternbrief.pdf' });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.deepEqual([r1.areaId, r1.path, r1.name, r1.created], [`family:${FAMILY}`, 'Schule/2026-10/Elternbrief.pdf', 'Elternbrief.pdf', true]);
    const n = await c.as(MARC)('GET', 'nodes/by-path', null, { area: `family:${FAMILY}`, path: 'Schule/2026-10/Elternbrief.pdf' });
    assert.equal(n.json.node.createdBy, ANNA.id);
    const ch = await c.as(MARC)('GET', 'changes', null, { since: 0 });
    assert.ok(ch.json.changes.some((x) => x.device === 'gatecontrol-messenger'));
    assert.ok(c.events().some((e) => e.type === 'changed' && e.users.includes(MARC.id)));
    // the same name: a free name, or a new version
    const r2 = await call(ANNA, 'save_file', { mediaId: await handed(ANNA, '%PDF-2'), area: 'family', path: 'Schule/2026-10/Elternbrief.pdf' });
    assert.equal(r2.name, 'Elternbrief (2).pdf');
    const r3 = await call(ANNA, 'save_file', { mediaId: await handed(ANNA, '%PDF-3'), area: 'family', path: 'Schule/2026-10/Elternbrief.pdf', onConflict: 'version' });
    assert.deepEqual([r3.nodeId, r3.created], [r1.nodeId, false]);
    // my files by default
    const r4 = await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x', 'text/plain'), path: 'notiz.txt' });
    assert.equal(r4.areaId, `mine:${ANNA.id}`);
    // refusals
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), area: `child:${LENA.id}`, path: 'a.pdf' })).code, 'forbidden', 'a parent only reads');
    assert.equal((await call(BOB, 'save_file', { mediaId: await handed(BOB, 'x'), area: 'family', path: 'a.pdf' })).code, 'not_found');
    assert.equal((await call(OMA, 'save_file', { mediaId: await handed(OMA, 'x'), path: 'a.pdf' })).code, 'no_seat');
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(MARC, 'x'), path: 'a.pdf' })).code, 'upload_invalid', 'someone else\'s file');
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), path: '../a.pdf' })).code, 'invalid');
    assert.equal((await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), path: '' })).code, 'invalid');
    assert.equal((await call(null, 'save_file', { mediaId: await handed(ANNA, 'x'), path: 'a.pdf' })).code, 'invalid', 'without userId');
    const onTheWay = await call(ANNA, 'save_file', { mediaId: await handed(ANNA, 'x'), area: 'family', path: 'Schule/2026-10/Elternbrief.pdf/x.pdf' });
    assert.equal(onTheWay.code, 'exists', 'a file on the way');
    host.license.licensed = false;
    assert.equal((await call(ANNA, 'list_areas', {})).code, 'not_licensed');
  });
});

// ── the admin pages in the fake DOM ────────────────────────

const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 1500) {
  for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);

function adminGc(host, picked) {
  return {
    async call(method, p, body) {
      const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: ADMIN, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async pickPrincipals() { return picked; },
  };
}

test('smoke: the admin pages switch people on, make a team folder, show the overview', async () => {
  await withHost({ seats: { [ANNA.id]: 'family' } }, async (host, c) => {
    // people: Bob switched on as business
    let f = createWindow(ui.render({ view: 'page', page: 'people', lang: 'de' }, t), adminGc(host, null));
    try {
      f.run();
      const doc = f.document;
      const sel = await until('Bob\'s seat', () => doc.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'Drive für Bob'));
      sel.value = 'business';
      sel.dispatchEvent({ type: 'change', target: sel });
      await until('switched on', () => textOf(doc.getElementById('dp-toast')).includes('Bob ist freigeschaltet'));
      assert.equal((await c.admin('GET', 'admin/overview')).json.overview.people.find((p) => p.id === BOB.id).seat, 'business');
    } finally { f.stop(); }
    // teams: a new team folder with the group "Büro"
    f = createWindow(ui.render({ view: 'page', page: 'teams', lang: 'de' }, t), adminGc(host, [{ type: 'group', id: OFFICE, label: 'Büro' }]));
    try {
      f.run();
      const doc = f.document;
      (await until('new', () => byText(doc.getElementById('da-page'), 'span', 'Neuer Team-Ordner'))).parentNode.click();
      const name = await until('dialog', () => doc.getElementById('dp-dialog').querySelector('input'));
      name.value = 'Projekte';
      byText(doc.getElementById('dp-dialog'), 'span', 'Personen oder Gruppen hinzufügen').parentNode.click();
      await until('member', () => byText(doc.getElementById('dp-dialog'), 'span', 'Büro'));
      byText(doc.getElementById('dp-dialog'), 'span', 'Speichern').parentNode.click();
      await until('listed', () => byText(doc.getElementById('da-page'), 'h2', 'Projekte'));
      const teams = (await c.admin('GET', 'admin/teams')).json.teams;
      assert.deepEqual(teams[0].members.map((m) => [m.principal, m.role]), [[`g:${OFFICE}`, 'write']]);
    } finally { f.stop(); }
    // overview: the licence and the backup hint
    await c.as(ANNA)('GET', 'me');
    f = createWindow(ui.render({ view: 'page', page: 'overview', lang: 'de' }, t), adminGc(host, null));
    try {
      f.run();
      const doc = f.document;
      await until('licence', () => textOf(doc.getElementById('da-page')).includes('2 von 5 Personen'));
      assert.ok(textOf(doc.getElementById('da-page')).includes('Das GateControl-Backup sichert keine Drive-Dateien'));
      byText(doc.getElementById('da-page'), 'span', 'Ausblenden').parentNode.click();
      await until('hidden', () => !textOf(doc.getElementById('da-page')).includes('Das GateControl-Backup sichert keine Drive-Dateien'));
    } finally { f.stop(); }
  });
});
