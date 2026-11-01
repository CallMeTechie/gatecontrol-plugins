'use strict';

// The overview (1.18.0, feature `overview` — server/overview.js): GET overview with "Zu erledigen" (the next deadlines,
// the photos to check, Mail's attachments to file through its service tofile_count — a fake Mail here, never Mail
// itself), "Zuletzt geöffnet" (content, office and POST nodes/<id>/opened record it; not photos, not a vault, not a PC's
// sync; filled up with
// what the person changed), the memories, people and places, "Neu in Familie" (others, the family's and the teams' areas,
// 14 days, grouped by person, folder and hour), the storage — and the time it takes with some thousand nodes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, T0, MIN, DAY } = require('./helpers');

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const HH = { lat: 53.5452, lon: 9.9667 };
const KOELN = { lat: 50.9413, lon: 6.9583 };

const mkdir = async (c, user, parentId, name) => {
  const r = await c.as(user)('POST', 'nodes', { parentId, name });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
};
const put = async (c, user, parentId, name, o = {}) => {
  const r = await c.put(user, parentId, name, o.data || name, { mime: o.mime || PDF, ...(o.takenAt ? { takenAt: o.takenAt } : {}), ...(o.geo ? { geo: o.geo } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
};
const overview = async (call) => {
  const r = await call('GET', 'overview');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// exact face vectors: identity i is the unit vector e_i, each face 0.8 to it along its own direction
const DIM = 128;
let dir = 20;
function faceVec(i) {
  const v = new Float32Array(DIM);
  v[i] = 0.8;
  v[dir++] = 0.6;
  return Buffer.from(v.buffer).toString('base64');
}

/** A fake Mail with tofile_count (as Mail ≥ 1.7.0 offers it) — answers per person, or refuses. */
function mail(o = {}) {
  const calls = [];
  const per = o.per || {};
  return {
    calls,
    o,
    entry: {
      plugin: 'gatecontrol-mail', provides: ['new_draft', 'calendar_list', 'calendar_add', 'tofile_count'],
      service: async ({ name, caller, user, payload }) => {
        calls.push({ name, caller, user: user && user.id, payload });
        if (name !== 'tofile_count') return { ok: false, code: 'not_found' };
        if (o.refuse) return { ok: false, code: o.refuse, reason: 'no_seat' };
        if (!user || user.id !== payload.userId) return { ok: false, code: 'forbidden' };
        return { ok: true, ...(per[user.id] || { count: 0, hint: null }) };
      },
    },
  };
}

test('GET overview: the feature; an empty Drive has only the storage; "Zuletzt geöffnet" from content and office, filled up with what I changed', async () => {
  await withHost({ gatecontrol: '1.211.0' }, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok((await a('GET', 'me')).json.features.includes('overview'));
    // nothing yet: only my storage (my files on this server, no quota of its own); people off by default
    let o = await overview(a);
    assert.deepEqual(Object.keys(o).sort(), ['ok', 'people', 'storage']);
    assert.equal(o.people, null);
    const mine = await c.area(ANNA, 'mine');
    // the quota of my files (the administrator's setting) and this server as the place
    const quota = (await a('GET', 'areas')).json.areas.find((x) => x.id === mine.id).storage.quota;
    assert.ok(quota > 0);
    assert.deepEqual(o.storage, { used: 0, total: quota, target: null, areaId: mine.id });
    const fam = await c.area(ANNA, 'family');
    const steuer = await put(c, ANNA, mine.rootId, 'Steuerbescheid 2025.pdf');
    c.clock.add(MIN);
    const brief = await put(c, ANNA, mine.rootId, 'Elternbrief.docx', { mime: DOCX });
    c.clock.add(MIN);
    await put(c, ANNA, mine.rootId, 'Strand.jpg', { mime: 'image/jpeg', takenAt: T0 - DAY });
    const zeugnis = await put(c, MARC, fam.rootId, 'Zeugnis Lea.pdf');
    c.clock.add(MIN);
    // no opens yet: what I uploaded, newest first (not Marc's file, not the picture)
    o = await overview(a);
    assert.deepEqual(o.recent.map((x) => [x.name, x.areaLabel, !!x.changedAt, x.openedAt]), [['Elternbrief.docx', 'Meine Dateien', true, undefined], ['Steuerbescheid 2025.pdf', 'Meine Dateien', true, undefined]]);
    assert.equal(o.storage.used, steuer.size + brief.size + 'Strand.jpg'.length);
    // a file item like in a folder: preview, place, insight as there
    assert.ok(Object.prototype.hasOwnProperty.call(o.recent[0], 'preview'));
    assert.equal(o.recent[0].located, false);
    // opened in the app: first, with openedAt
    assert.equal((await a('GET', `nodes/${zeugnis.id}/content`)).status, 200);
    c.clock.add(MIN);
    // a picture opened: not in "Zuletzt geöffnet"
    const strand = (await a('GET', `nodes/${mine.rootId}/children`)).json.items.find((x) => x.name === 'Strand.jpg');
    assert.equal((await a('GET', `nodes/${strand.id}/content`)).status, 200);
    o = await overview(a);
    assert.deepEqual(o.recent.map((x) => x.name), ['Zeugnis Lea.pdf', 'Elternbrief.docx', 'Steuerbescheid 2025.pdf']);
    assert.equal(o.recent[0].openedAt, new Date(T0 + 3 * MIN).toISOString());
    assert.equal(o.recent[0].changedAt, undefined);
    assert.equal(o.recent[0].areaLabel, 'Familie Berg');
    // the portal opens it again later: on top again; the old version of a file does not count
    c.clock.add(MIN);
    assert.equal((await c.portal(ANNA)('GET', `nodes/${steuer.id}/content`)).status, 200);
    o = await overview(c.portal(ANNA));
    assert.deepEqual(o.recent.map((x) => [x.name, !!x.openedAt]), [['Steuerbescheid 2025.pdf', true], ['Zeugnis Lea.pdf', true], ['Elternbrief.docx', false]]);
    // only my opens: Marc sees his own upload, not what Anna opened
    assert.deepEqual((await overview(c.as(MARC))).recent.map((x) => [x.name, !!x.changedAt]), [['Zeugnis Lea.pdf', true]]);
    // into the trash: gone; back: there again; purged: its row goes
    assert.equal((await a('DELETE', `nodes/${steuer.id}`)).status, 200);
    assert.ok(!(await overview(a)).recent.some((x) => x.id === steuer.id));
    const tr = (await a('GET', 'trash')).json.items.find((x) => x.id === steuer.id);
    assert.equal((await a('DELETE', `trash/${tr.id}`)).status, 200);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens WHERE node_id = ?', [steuer.id])).row.n, 0);
    // a file of a vault: never shown
    await host.gc.db.run("UPDATE nodes SET vault_id = 'v1' WHERE id = ?", [zeugnis.id]);
    assert.ok(!(await overview(a)).recent.some((x) => x.id === zeugnis.id));
    await host.gc.db.run('UPDATE nodes SET vault_id = NULL WHERE id = ?', [zeugnis.id]);
    // at most 10, the last 200 opens a person are kept
    for (let i = 0; i < 205; i++) await host.gc.db.run('INSERT INTO recent_opens (user_id, node_id, at) VALUES (?, ?, ?)', [ANNA.id, 100000 + i, T0 - DAY - i]);
    c.clock.add(MIN);
    assert.equal((await a('GET', `nodes/${brief.id}/content`)).status, 200);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens WHERE user_id = ?', [ANNA.id])).row.n, 200);
    assert.deepEqual((await overview(a)).recent.map((x) => x.name), ['Elternbrief.docx', 'Zeugnis Lea.pdf']);
  });
});

test('"Zuletzt geöffnet": what a PC fetches for a folder it syncs is no open; the same PC opening another file is', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const schule = await mkdir(c, MARC, fam.rootId, 'Schule');
    const sub = await mkdir(c, MARC, schule.id, '2026');
    const deep = await put(c, MARC, sub.id, 'Stundenplan.pdf');
    const other = await put(c, MARC, fam.rootId, 'Einkauf.pdf');
    // Anna's PC syncs Familie › Schule (its token 'pc-anna')
    const pc = c.as(ANNA, 'pc-anna');
    assert.equal((await pc('PUT', 'devices/pc-1', { name: 'PC', platform: 'windows' })).status, 200);
    assert.equal((await pc('PUT', 'devices/pc-1/folders', { folders: [{ localPath: 'C:\\Users\\anna\\Schule', mode: 'sync', nodeId: schule.id }] })).status, 200);
    assert.equal((await pc('GET', `nodes/${deep.id}/content`)).status, 200);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens')).row.n, 0, 'the sync fetched it');
    assert.equal((await pc('GET', `nodes/${other.id}/content`)).status, 200);
    // the phone opening the synced file: an open
    assert.equal((await c.as(ANNA)('GET', `nodes/${deep.id}/content`)).status, 200);
    assert.deepEqual((await overview(c.as(ANNA))).recent.map((x) => [x.name, !!x.openedAt]), [['Einkauf.pdf', true], ['Stundenplan.pdf', true]]);
    // a folder only backed up (mode backup) is no sync
    assert.equal((await pc('PUT', 'devices/pc-1/folders', { folders: [{ localPath: 'C:\\Users\\anna\\Schule', mode: 'backup', nodeId: schule.id }] })).status, 200);
    c.clock.add(MIN);
    assert.equal((await pc('GET', `nodes/${deep.id}/content`)).status, 200);
    assert.equal((await overview(c.as(ANNA))).recent[0].name, 'Stundenplan.pdf');
  });
});

test('POST nodes/<id>/opened: a copy on the device opened — 204, only "Zuletzt geöffnet", by the rules of content', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const doc = await put(c, ANNA, mine.rootId, 'Vertrag.pdf');
    const pic = await put(c, ANNA, mine.rootId, 'Bild.jpg', { mime: 'image/jpeg', takenAt: T0 - DAY });
    const later = await put(c, ANNA, mine.rootId, 'Später.pdf');
    c.clock.add(MIN);
    const r = await a('POST', `nodes/${doc.id}/opened`);
    assert.equal(r.status, 204, JSON.stringify(r.json));
    assert.equal(r.json, null, 'no body');
    let o = await overview(a);
    assert.deepEqual(o.recent.map((x) => [x.name, !!x.openedAt]), [['Vertrag.pdf', true], ['Später.pdf', false]]);
    assert.equal(o.recent[0].openedAt, new Date(T0 + MIN).toISOString());
    // a picture: 204, not kept; a folder: 400; not there: 404
    assert.equal((await a('POST', `nodes/${pic.id}/opened`)).status, 204);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens WHERE node_id = ?', [pic.id])).row.n, 0);
    assert.equal((await a('POST', `nodes/${mine.rootId}/opened`)).status, 400);
    assert.equal((await a('POST', 'nodes/999999/opened')).status, 404);
    // only with read access: Marc cannot reach Anna's files
    assert.notEqual((await c.as(MARC)('POST', `nodes/${doc.id}/opened`)).status, 204);
    // a file of a vault: not kept
    await host.gc.db.run("UPDATE nodes SET vault_id = 'v1' WHERE id = ?", [later.id]);
    assert.equal((await a('POST', `nodes/${later.id}/opened`)).status, 204);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens WHERE node_id = ?', [later.id])).row.n, 0);
    await host.gc.db.run('UPDATE nodes SET vault_id = NULL WHERE id = ?', [later.id]);
    // a PC's copy in a folder it syncs: not kept
    const pc = c.as(ANNA, 'pc-anna');
    assert.equal((await pc('PUT', 'devices/pc-1', { name: 'PC', platform: 'windows' })).status, 200);
    assert.equal((await pc('PUT', 'devices/pc-1/folders', { folders: [{ localPath: 'C:\\Drive', mode: 'sync', nodeId: mine.rootId }] })).status, 200);
    assert.equal((await pc('POST', `nodes/${later.id}/opened`)).status, 204);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens WHERE node_id = ?', [later.id])).row.n, 0);
    // again later: on top again
    c.clock.add(MIN);
    assert.equal((await a('POST', `nodes/${later.id}/opened`)).status, 204);
    o = await overview(a);
    assert.deepEqual(o.recent.map((x) => [x.name, !!x.openedAt]), [['Später.pdf', true], ['Vertrag.pdf', true]]);
    // a parent opening a file of the child's folder: the child is told, as for content
    const lena = await c.area(LENA, 'child');
    const hw = await put(c, LENA, lena.rootId, 'Hausaufgabe.pdf');
    assert.equal((await a('POST', `nodes/${hw.id}/opened`)).status, 204);
    assert.equal(c.pushes().filter((x) => x.topic === 'child_view').length, 1);
  });
});

test('"Zuletzt geöffnet": opening in the office counts', async () => {
  const discovery = '<?xml version="1.0"?><wopi-discovery><net-zone name="external-http"><app name="writer"><action default="true" ext="docx" name="edit" urlsrc="https://office.internal:9980/browser/abc/cool.html?"/></app></net-zone></wopi-discovery>';
  await withHost({
    gatecontrol: '1.211.0', settings: { office_url: 'https://office.example.de' },
    targets: { office: [{ fetch: async (p) => (p === '/hosting/discovery' ? { status: 200, body: discovery } : { status: 404, body: '' }) }] },
  }, async (host, c) => {
    const p = c.portal(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const doc = await put(c, ANNA, mine.rootId, 'Haushalt.docx', { mime: DOCX });
    await put(c, ANNA, mine.rootId, 'Später.pdf');
    assert.ok((await p('GET', 'me')).json.features.includes('office'));
    c.clock.add(MIN);
    assert.equal((await p('POST', `nodes/${doc.id}/office`)).status, 200);
    assert.deepEqual((await overview(p)).recent.map((x) => [x.name, !!x.openedAt]), [['Haushalt.docx', true], ['Später.pdf', false]]);
  });
});

test('"Zu erledigen": the next three deadlines from today and how many; photos to check; Mail\'s attachments to file (null without Mail)', async () => {
  const m = mail({ per: { [ANNA.id]: { count: 3, hint: 'Familie › Versicherungen' } } });
  await withHost({ services: [m.entry], gatecontrol: '1.216.0' }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const rech = await put(c, ANNA, mine.rootId, 'Rechnung Stadtwerke.pdf');
    const kfz = await put(c, ANNA, mine.rootId, 'Kfz.pdf');
    const add = (node, offset, kind = 'payment', label = null) => host.gc.db.run('INSERT INTO doc_deadlines (node_id, kind, date, label, found_at) VALUES (?, ?, ?, ?, ?)',
      [node.id, kind, day(T0 + offset * DAY), label, T0]);
    await add(rech, 3, 'payment', 'Rechnung Stadtwerke zahlen');
    await add(kfz, 12, 'cancellation', 'Kfz-Versicherung kündigen');
    await add(rech, -1);
    await add(kfz, 40);
    await add(kfz, 100);
    await add(kfz, 400);
    let o = await overview(a);
    assert.deepEqual(o.todo.deadlines.map((d) => [d.date, d.label, d.node.name]), [[day(T0 + 3 * DAY), 'Rechnung Stadtwerke zahlen', 'Rechnung Stadtwerke.pdf'],
      [day(T0 + 12 * DAY), 'Kfz-Versicherung kündigen', 'Kfz.pdf'], [day(T0 + 40 * DAY), null, 'Kfz.pdf']]);
    assert.equal(o.todo.deadlinesTotal, 4);
    // like GET deadlines: reminder, calendars, doc, node with path
    const full = (await a('GET', 'deadlines')).json.deadlines[0];
    assert.deepEqual(o.todo.deadlines[0], full);
    assert.equal(o.todo.review, undefined, '0 to check: left out');
    assert.deepEqual([o.todo.toFile, o.todo.toFileHint], [3, 'Familie › Versicherungen']);
    assert.deepEqual(m.calls.map((x) => [x.name, x.caller, x.user, x.payload.userId]), [['tofile_count', 'gatecontrol-drive', ANNA.id, ANNA.id]]);
    // photos to check (the review mark)
    const p1 = await put(c, ANNA, mine.rootId, 'p1.jpg', { mime: 'image/jpeg', takenAt: T0 - DAY });
    const p2 = await put(c, ANNA, mine.rootId, 'p2.jpg', { mime: 'image/jpeg', takenAt: T0 - DAY });
    assert.equal((await a('POST', 'photos/review', { ids: [p1.id, p2.id], review: true })).status, 200);
    o = await overview(a);
    assert.equal(o.todo.review, 2);
    // Mail asked again only after a minute
    assert.equal(m.calls.length, 1);
    c.clock.add(61000);
    m.o.per[ANNA.id] = { count: 0, hint: null };
    o = await overview(a);
    assert.equal(m.calls.length, 2);
    assert.deepEqual([o.todo.toFile, o.todo.toFileHint], [0, null]);
    // Mail refuses (no place): null
    c.clock.add(61000);
    m.o.refuse = 'unavailable';
    o = await overview(a);
    assert.deepEqual([o.todo.toFile, o.todo.toFileHint], [null, null]);
    // nothing to do at all: no todo
    await host.gc.db.run('DELETE FROM doc_deadlines');
    assert.equal((await a('POST', 'photos/review', { ids: [p1.id, p2.id], review: false })).status, 200);
    assert.equal((await overview(a)).todo, undefined);
    // Marc reads none of Anna's files: none of her deadlines
    assert.equal((await overview(c.as(MARC))).todo, undefined);
  });
  // without Mail: toFile null, and Drive asks nobody
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const f = await put(c, ANNA, mine.rootId, 'a.pdf');
    await host.gc.db.run('INSERT INTO doc_deadlines (node_id, kind, date, label, found_at) VALUES (?, ?, ?, ?, ?)', [f.id, 'payment', day(T0 + DAY), null, T0]);
    const o = await overview(c.as(ANNA));
    assert.deepEqual([o.todo.deadlinesTotal, o.todo.toFile, o.todo.toFileHint], [1, null, null]);
    assert.equal(host.serviceCalls.length, 0);
  });
});

test('"Neu in Familie": others in the family\'s and the teams\' areas, 14 days, grouped by person, folder and hour', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const urlaub = await mkdir(c, MARC, fam.rootId, 'Urlaub 2026');
    // 15 days ago: too old
    await put(c, MARC, urlaub.id, 'alt.jpg', { mime: 'image/jpeg' });
    c.clock.add(15 * DAY);
    // Marc: three photos within an hour, then one more two hours later (a new entry), a PDF on top of the family
    for (let i = 0; i < 3; i++) { await put(c, MARC, urlaub.id, `u${i}.jpg`, { mime: 'image/jpeg' }); c.clock.add(20 * MIN); }
    c.clock.add(2 * 60 * MIN);
    await put(c, MARC, urlaub.id, 'u3.jpg', { mime: 'image/jpeg' });
    c.clock.add(MIN);
    const zeugnis = await put(c, MARC, fam.rootId, 'Zeugnis Lea.pdf');
    c.clock.add(MIN);
    // a new version of a file: changed
    const r = await c.put(MARC, fam.rootId, 'Zeugnis Lea.pdf', 'v2', { mime: PDF, onConflict: 'version' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    c.clock.add(MIN);
    // mine: not shown to me; Lena's own folder: not shown; my files: never
    await put(c, ANNA, fam.rootId, 'von Anna.pdf');
    const lena = await c.area(LENA, 'child');
    await put(c, LENA, lena.rootId, 'Hausaufgabe.pdf');
    const mineM = await c.area(MARC, 'mine');
    await put(c, MARC, mineM.rootId, 'privat.pdf');
    // a folder made and a file renamed: not events
    await mkdir(c, MARC, fam.rootId, 'Neu');
    assert.equal((await c.as(MARC)('PATCH', `nodes/${zeugnis.id}`, { name: 'Zeugnis.pdf' })).status, 200);
    const now = T0 + 15 * DAY + 3 * 20 * MIN + 2 * 60 * MIN + 4 * MIN;
    const o = await overview(c.as(ANNA));
    assert.deepEqual(o.activity.map((x) => [x.user.name, x.kind, x.count, x.area.label, x.folder && x.folder.path, x.sample.name]), [
      ['Marc', 'changed', 1, 'Familie Berg', null, 'Zeugnis.pdf'],
      ['Marc', 'added_files', 1, 'Familie Berg', null, 'Zeugnis.pdf'],
      ['Marc', 'added_photos', 1, 'Familie Berg', 'Urlaub 2026', 'u3.jpg'],
      ['Marc', 'added_photos', 3, 'Familie Berg', 'Urlaub 2026', 'u2.jpg'],
    ]);
    assert.equal(o.activity[0].at, new Date(now - 2 * MIN).toISOString());
    assert.deepEqual(o.activity[2].folder, { id: urlaub.id, path: 'Urlaub 2026' });
    assert.deepEqual(o.activity[0].user, { id: MARC.id, name: 'Marc' });
    assert.ok(Object.prototype.hasOwnProperty.call(o.activity[3].sample, 'preview'));
    // Marc sees Anna's file in the family
    assert.deepEqual((await overview(c.as(MARC))).activity.map((x) => [x.user.name, x.sample.name]), [['Anna', 'von Anna.pdf']]);
    // a team: Bob sees Anna's upload into the team folder; Oma (no seat in it) nothing
    const team = await c.admin('POST', 'admin/teams', { label: 'Büro', members: [{ principal: `u:${BOB.id}`, role: 'write' }, { principal: `u:${ANNA.id}`, role: 'write' }] });
    assert.equal(team.status, 200, JSON.stringify(team.json));
    const t = await c.area(ANNA, 'team');
    if (t) {
      await put(c, ANNA, t.rootId, 'Angebot.pdf');
      assert.deepEqual((await overview(c.as(BOB))).activity.map((x) => [x.user.name, x.area.label, x.sample.name]), [['Anna', 'Büro', 'Angebot.pdf']]);
    }
  });
});

test('memories, people and places of the overview; people null while the switch is off', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const y1 = new Date(T0);
    const at = (years, hours = 0) => new Date(y1.getFullYear() - years, y1.getMonth(), y1.getDate(), 12 + hours).getTime();
    // a year ago two photos (Hamburg), two years ago three (Köln, one Hamburg), five years ago one without a place
    await put(c, ANNA, mine.rootId, 'a1.jpg', { mime: 'image/jpeg', takenAt: at(1), geo: HH });
    await put(c, ANNA, mine.rootId, 'a2.jpg', { mime: 'image/jpeg', takenAt: at(1, 1), geo: HH });
    await put(c, ANNA, mine.rootId, 'b1.jpg', { mime: 'image/jpeg', takenAt: at(2), geo: KOELN });
    await put(c, ANNA, mine.rootId, 'b2.jpg', { mime: 'image/jpeg', takenAt: at(2, 1), geo: KOELN });
    await put(c, ANNA, mine.rootId, 'b3.jpg', { mime: 'image/jpeg', takenAt: at(2, 2), geo: KOELN });
    await put(c, ANNA, mine.rootId, 'c1.jpg', { mime: 'video/mp4', takenAt: at(5) });
    // another day: no memory
    await put(c, ANNA, mine.rootId, 'x.jpg', { mime: 'image/jpeg', takenAt: at(3) - 10 * DAY, geo: HH });
    let o = await overview(a);
    assert.deepEqual(o.memories.map((g) => [g.yearsAgo, g.count, g.cover.name]), [[1, 2, 'a1.jpg'], [2, 3, 'b1.jpg'], [5, 1, 'c1.jpg']]);
    assert.equal(o.memories[0].date, day(at(1)));
    assert.ok(Object.prototype.hasOwnProperty.call(o.memories[0].cover, 'previewUrl'));
    assert.deepEqual(o.places.top.map((p) => [p.name, p.count]).sort(), [['Hamburg', 3], ['Köln', 3]]);
    assert.equal(o.places.total, 6);
    assert.equal(o.places.cluster.count, 6);
    assert.match(o.places.top[0].key, /^geonames:\d+$/);
    assert.equal(o.people, null);
    // a child is not told that a parent looked (the overview is no look into its folder)
    assert.equal(c.pushes().filter((p) => p.topic === 'child_view').length, 0);
    // people on: none yet — left out; then two named, one without a name, one hidden
    assert.equal((await a('PUT', 'photos/settings', { people: true })).status, 200);
    o = await overview(a);
    assert.equal(o.people, undefined);
    // faces: identity 0 on three photos, 1 on four, 2 on three (stays without a name), 3 on three (hidden)
    const photos = (await a('GET', 'photos')).json.items.filter((x) => x.mime === 'image/jpeg').map((x) => x.id);
    const on = { 0: [0, 1, 2], 1: [0, 1, 2, 3], 2: [3, 4, 5], 3: [2, 3, 4] };
    for (let i = 0; i < photos.length; i++) {
      const fs = Object.keys(on).filter((who) => on[who].includes(i)).map((who, j) => ({ box: [0.05 + j * 0.22, 0.2, 0.2, 0.25], score: 0.9, embedding: faceVec(Number(who)) }));
      const r = await a('PUT', `nodes/${photos[i]}/faces`, { model: 'sface-2021dec', faces: fs });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const list = (await a('GET', 'people')).json.people;
    assert.equal(list.length, 4);
    const byCount = (n, not) => list.find((p) => p.count === n && p.id !== not);
    const lea = byCount(3);
    const mama = byCount(4);
    const nobody = list.find((p) => p.count === 3 && p.id !== lea.id && !p.name);
    const hidden = list.find((p) => ![lea.id, mama.id, nobody.id].includes(p.id));
    assert.equal((await a('PATCH', `people/${lea.id}`, { name: 'Lea' })).status, 200);
    assert.equal((await a('PATCH', `people/${mama.id}`, { name: 'Mama' })).status, 200);
    assert.equal((await a('PATCH', `people/${hidden.id}`, { name: 'Versteckt', hidden: true })).status, 200);
    o = await overview(a);
    assert.deepEqual(o.people.people.map((p) => [p.name, p.count, !!p.cover]), [['Mama', 4, true], ['Lea', 3, true]]);
    assert.equal(o.people.unnamed, 1);
  });
});

test('GET overview with some thousand nodes answers in well under 300 ms', async (t) => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const db = host.gc.db;
    // 4000 nodes: folders, documents and photos in my files and the family's, taken over ten years, with places;
    // the change log of a month by Marc; 200 opens; 50 deadlines
    const now = Date.now();
    await db.exec('BEGIN');
    const folders = [];
    for (let f = 0; f < 40; f++) {
      const area = f % 2 ? fam : mine;
      const r = await db.run('INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
        [area.id, area.rootId, `Ordner ${f}`, now, MARC.id, now, MARC.id]);
      folders.push({ id: Number(r.lastInsertRowid), area: area.id });
    }
    let k = 0;
    for (let i = 0; i < 3960; i++) {
      const f = folders[i % folders.length];
      const photo = i % 3 !== 0;
      const t = now - (i % 3650) * DAY;
      const r = await db.run(`INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, mime, rev, created_at, created_by, updated_at, updated_by, taken_at, geo_lat, geo_lon)
        VALUES (?, ?, ?, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`, [f.area, f.id, `${photo ? 'Bild' : 'Dokument'} ${i}.${photo ? 'jpg' : 'pdf'}`, `m${String(++k).padStart(31, '0')}`, 1000 + i,
        photo ? 'image/jpeg' : PDF, now - i * MIN, i % 2 ? MARC.id : ANNA.id, now - i * MIN, i % 2 ? MARC.id : ANNA.id, photo ? t : null, photo && i % 5 ? 50 + (i % 7) / 10 : null, photo && i % 5 ? 7 + (i % 9) / 10 : null]);
      const id = Number(r.lastInsertRowid);
      if (i < 3000) await db.run('INSERT INTO changes (area_id, node_id, op, at, by) VALUES (?, ?, ?, ?, ?)', [f.area, id, 'create', now - (3000 - i) * 15 * MIN, i % 2 ? MARC.id : ANNA.id]);
      if (!photo && i < 600) await db.run('INSERT INTO recent_opens (user_id, node_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [ANNA.id, id, now - i * MIN]);
      if (!photo && i % 30 === 0) await db.run('INSERT INTO doc_deadlines (node_id, kind, date, label, found_at) VALUES (?, ?, ?, ?, ?)', [id, 'payment', day(now + (i % 300) * DAY), null, now]);
    }
    await db.exec('COMMIT');
    await a('PUT', 'photos/settings', { people: true });
    await overview(a);
    const times = [];
    let o = null;
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      o = await overview(a);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((x, y) => x - y);
    const median = times[2];
    assert.ok(median < 300, `GET overview takes ${median.toFixed(1)} ms (median of 5)`);
    // and everything is there
    assert.equal(o.recent.length, 10);
    assert.equal(o.todo.deadlines.length, 3);
    assert.ok(o.memories.length >= 1);
    assert.ok(o.places.total > 1000);
    assert.equal(o.activity.length, 5);
    t.diagnostic(`GET overview: ${median.toFixed(1)} ms (median of 5, ${times.map((x) => x.toFixed(0)).join(' / ')})`);
  });
});
