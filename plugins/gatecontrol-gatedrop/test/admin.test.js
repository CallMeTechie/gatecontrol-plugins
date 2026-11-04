'use strict';

// GateDrop 1.5.0: the administrators' overview (admin/overview, admin/sends — no content, filters, pages), the retention
// (after the pick-up / not picked up, applied to existing sends, links keep their time), freeing storage (admin/cleanup,
// DELETE admin/sends/<id>: "Vom Admin entfernt" for the sender, nothing more for recipients), only administrators,
// real pick-ups (a device's receipt, the receiving end of a direct transfer with every byte, a family's members) and the
// devices offered in GET targets (only apps that use GateDrop).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ADMIN, ANNA, MARC, LENA, OMA, PDF, PNG, MIN, DAY } = require('./helpers');

const phone = (c) => c.as(ANNA, 'anna-phone');
const pc = (c) => c.as(ANNA, 'anna-pc');
const tab = (c) => c.as(ANNA, 'anna-tab');
const admin = (c) => (method, p, body, query) => c.call(ADMIN, method, p, body, query);
const list = async (c, query) => (await admin(c)('GET', 'admin/sends', null, query || {})).json;
const rowOf = async (c, id, query) => (await list(c, query)).items.find((s) => s.id === id);
const HOUR = 3600000;

test('only administrators in the admin UI: every admin route refuses the portal, the apps, a kiosk device and other people', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: m }], to: { people: [MARC.id] } })).json;
    const routes = [
      ['GET', 'admin/overview'], ['GET', 'admin/sends'], ['DELETE', `admin/sends/${r.id}`], ['PUT', 'admin/retention', { afterDays: 0, unpickedDays: 3 }],
      ['GET', 'admin/cleanup'], ['POST', 'admin/cleanup', { unpicked: 1, picked: true }],
    ];
    const viewers = [ANNA, app(ADMIN, 'x'), portal(ADMIN), { ...ADMIN, kiosk: true }, { ...ADMIN, app: true }, null];
    for (const [method, p, body] of routes) {
      for (const u of viewers) {
        const res = await c.call(u, method, p, body);
        assert.equal(res.status, 403, `${method} ${p} as ${JSON.stringify(u)}`);
        assert.equal(res.json.code, 'forbidden');
      }
    }
    // nothing changed: the files are there, the retention is the default
    assert.ok(host.media.has(m));
    assert.deepEqual((await admin(c)('GET', 'admin/overview')).json.retention, { afterDays: 7, unpickedDays: 7, after: [0, 1, 3, 7], unpicked: [3, 7, 14, 30] });
    assert.equal((await admin(c)('GET', 'admin/sends')).status, 200);
    assert.equal((await admin(c)('GET', 'admin/nothing')).status, 404);
  });
});

test('the list shows people, devices, sizes and states — never a file name, a MIME type, a text, a link, a note, a NAS path or a link URL', async () => {
  await withHost({ nas: true, drive: true }, async (host, c) => {
    const m1 = await c.upload(ANNA, PDF, 'application/pdf');
    const m2 = await c.upload(ANNA, PNG, 'image/png');
    const m3 = await c.upload(ADMIN, PDF, 'application/pdf');
    const m4 = await c.upload(ANNA, PDF, 'application/pdf');
    const a = (await phone(c)('POST', 'sends', {
      items: [{ mediaId: m1, name: 'geheim-vertrag.pdf' }, { mediaId: m2, name: 'urlaubsfoto-strand.png' }], text: 'Geheimtext-Kontonummer', note: 'Notiz-nur-fuer-Marc',
      to: { people: [MARC.id], devices: ['anna-pc'], nas: [{ id: c.nas.folderId, path: 'Steuer/2026' }] },
    })).json;
    c.clock.add(MIN);
    const l = (await c.portal(ADMIN)('POST', 'sends', { items: [{ mediaId: m3, name: 'bilanz-entwurf.pdf' }], to: { link: { expires: '1d', pin: true } } })).json;
    c.clock.add(MIN);
    const t = (await phone(c)('POST', 'sends', { link: 'https://secret.example.org/private?token=abc', to: { devices: ['anna-tab'] } })).json;
    c.clock.add(MIN);
    const d = (await phone(c)('POST', 'sends', { items: [{ mediaId: m4, name: 'steuerbescheid.pdf' }], to: { drive: true } })).json;
    await host.plugin._idle();
    const res = await admin(c)('GET', 'admin/sends');
    assert.equal(res.status, 200);
    const body = JSON.stringify(res.json);
    for (const secret of ['geheim-vertrag', 'urlaubsfoto', 'bilanz-entwurf', 'steuerbescheid', '.pdf', '.png', 'application/', 'image/', 'Geheimtext', 'Kontonummer', 'Notiz-nur',
      'secret.example', 'https://', 'Steuer', '/Familie', 'Meine Dateien', 'GateDrop/', l.link.token, l.link.url, m1, m2, m3, m4]) {
      assert.ok(!body.includes(secret), `the list must not contain ${secret}`);
    }
    const items = res.json.items;
    assert.deepEqual(items.map((s) => s.id), [d.id, t.id, l.id, a.id], 'newest first');
    for (const s of items) assert.deepEqual(Object.keys(s).sort(), ['bytes', 'canDelete', 'createdAt', 'files', 'from', 'id', 'problem', 'server', 'status', 'to', 'way']);
    const ra = items[3];
    assert.deepEqual(ra.from, { userId: ANNA.id, name: 'Anna', device: 'Pixel', portal: false });
    assert.deepEqual(ra.to, [
      { kind: 'device', name: 'Büro-PC', platform: 'windows', owner: 'Anna', online: true, lastSeen: null },
      { kind: 'person', name: 'Marc', messenger: false },
      { kind: 'nas', name: 'Ablage' },
    ]);
    assert.deepEqual([ra.files, ra.bytes, ra.way, ra.canDelete], [2, PDF.length + PNG.length, 'server', true]);
    assert.deepEqual(ra.status.state, 'partial', 'the NAS has it, the PC and Marc not yet');
    assert.deepEqual([ra.status.picked, ra.status.total, ra.status.open], [1, 3, ['Büro-PC', 'Marc']]);
    assert.deepEqual([ra.server.state, ra.server.bytes], ['held', PDF.length + PNG.length]);
    assert.deepEqual(items[2].to, [{ kind: 'link', pin: true, maxDownloads: null }]);
    assert.deepEqual([items[2].way, items[2].status.state, items[2].status.downloads, items[2].status.active], ['link', 'link', 0, true]);
    assert.deepEqual([items[2].from.portal, items[2].from.device], [true, null]);
    assert.deepEqual([items[1].files, items[1].server.state, items[1].status.state, items[1].status.offline], [0, 'none', 'waiting', true]);
    assert.deepEqual([items[0].to, items[0].status.state, items[0].status.how], [[{ kind: 'drive' }], 'picked', 'stored']);
  });
});

test('overview: storage picked up / not, 7 days arrived / waiting / failed, direct / server; "Abgeholt" only from a receipt', async () => {
  await withHost({ drive: { refuse: 'quota' } }, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const s1 = (await phone(c)('POST', 'sends', { items: [{ mediaId: m }], to: { devices: ['anna-pc'] } })).json;
    assert.deepEqual([s1.deliveries[0].status, s1.deliveries[0].pickedAt], ['delivered', null], 'online and pushed: provided, not picked up');
    let o = (await admin(c)('GET', 'admin/overview')).json;
    assert.deepEqual(o.held, { picked: { count: 0, bytes: 0 }, unpicked: { count: 1, bytes: PDF.length, oldestAt: new Date(c.clock.now()).toISOString() } });
    assert.deepEqual(o.week, { sends: 1, arrived: 0, waiting: 1, failed: 0, direct: 0, server: 1 });
    assert.equal((await rowOf(c, s1.id)).status.state, 'waiting');
    // another device of Anna's, the portal: no pick-up
    await tab(c)('POST', `sends/${s1.id}/opened`);
    await c.portal(ANNA)('POST', `sends/${s1.id}/opened`);
    assert.equal((await rowOf(c, s1.id)).status.state, 'waiting');
    // the PC's receipt
    c.clock.add(5 * MIN);
    const op = (await pc(c)('POST', `sends/${s1.id}/opened`)).json.send;
    assert.equal(op.deliveries[0].pickedAt, new Date(c.clock.now()).toISOString());
    const r1 = await rowOf(c, s1.id);
    assert.deepEqual([r1.status.state, r1.status.how, r1.status.at], ['picked', 'picked', new Date(c.clock.now()).toISOString()]);
    assert.equal((await phone(c)('GET', `sends/${s1.id}`)).json.send.pickedAt, new Date(c.clock.now()).toISOString(), 'the sender sees it picked up');
    // a direct transfer: the receiving end confirms with every byte
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    const s2 = (await phone(c)('POST', 'sends', { items: [{ name: 'a.jpg', bytes: 1000, local: true }, { name: 'b.jpg', bytes: 2000, local: true }], to: { devices: ['anna-pc'] } })).json;
    const tr = s2.direct[0].transferId;
    await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 3000 });
    let r2 = await rowOf(c, s2.id);
    assert.deepEqual([r2.way, r2.status.state, r2.server.state], ['direct', 'waiting', 'never'], 'the sender\'s ok alone is no pick-up');
    await pc(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: 3000 });
    r2 = await rowOf(c, s2.id);
    assert.deepEqual([r2.status.state, r2.status.how], ['picked', 'received']);
    // a failure (Drive refuses) and a device that is offline
    await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PNG, 'image/png') }], to: { drive: true } });
    await host.plugin._idle();
    await phone(c)('POST', 'sends', { text: 'hallo', to: { devices: ['anna-tab'] } });
    o = (await admin(c)('GET', 'admin/overview')).json;
    assert.deepEqual(o.week, { sends: 4, arrived: 2, waiting: 1, failed: 1, direct: 1, server: 3 });
    assert.deepEqual([o.held.picked.count, o.held.picked.bytes, o.held.unpicked.count, o.held.unpicked.bytes], [1, PDF.length, 1, PNG.length]);
    assert.equal(o.retentionDays, 7);
  });
});

test('direct, several files: the receiver\'s ok with fewer bytes is no success — the server way, also after the sender\'s ok', async () => {
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    // the files are on the server too: the fallback pushes
    const m1 = await c.upload(ANNA, PDF, 'application/pdf');
    const m2 = await c.upload(ANNA, PNG, 'image/png');
    const s = (await phone(c)('POST', 'sends', { items: [{ mediaId: m1 }, { mediaId: m2 }], to: { devices: ['anna-pc'] } })).json;
    const tr = s.direct[0].transferId;
    const early = (await pc(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: PDF.length })).json;
    assert.deepEqual([early.fallback, early.delivery.status, early.delivery.via, early.delivery.error], ['server', 'delivered', 'server', 'direct_failed']);
    assert.equal(c.pushes().filter((p) => !p.silent).length, 1, 'the PC gets the server push');
    const late = (await phone(c)('POST', `transfers/${tr}/result`, { ok: true, bytes: PDF.length + PNG.length })).json;
    assert.deepEqual([late.delivery.via, late.fallback], ['server', null], 'the sender\'s ok does not undo it');
    const r = await rowOf(c, s.id);
    assert.deepEqual([r.way, r.status.state], ['fallback', 'waiting']);
    // the sender reported ok first, the receiver then misses a file: the server way
    const s2 = (await phone(c)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf') }, { mediaId: await c.upload(ANNA, PNG, 'image/png') }], to: { devices: ['anna-pc'] } })).json;
    const tr2 = s2.direct[0].transferId;
    const first = (await phone(c)('POST', `transfers/${tr2}/result`, { ok: true, bytes: PDF.length + PNG.length })).json;
    assert.deepEqual([first.delivery.status, first.delivery.via, first.delivery.pickedAt], ['delivered', 'direct', null]);
    const second = (await pc(c)('POST', `transfers/${tr2}/result`, { ok: true, bytes: 10 })).json;
    assert.deepEqual([second.fallback, second.delivery.via, second.delivery.error], ['server', 'server', 'direct_failed']);
    assert.deepEqual(JSON.parse((await host.gc.db.get('SELECT receiver_result FROM transfers WHERE id = ?', [tr2])).row.receiver_result).error, 'incomplete');
    // files only on the phone: the receiver misses one after the sender's ok → the delivery waits for the upload
    const s3 = (await phone(c)('POST', 'sends', { items: [{ name: 'a.jpg', bytes: 100, local: true }, { name: 'b.jpg', bytes: 200, local: true }], to: { devices: ['anna-pc'] } })).json;
    const tr3 = s3.direct[0].transferId;
    await phone(c)('POST', `transfers/${tr3}/result`, { ok: true, bytes: 300 });
    const third = (await pc(c)('POST', `transfers/${tr3}/result`, { ok: true, bytes: 100 })).json;
    assert.deepEqual([third.fallback, third.missing, third.delivery.status, third.delivery.error], ['upload', [0, 1], 'pending', 'direct_failed']);
    // an older app without bytes: its ok is taken
    const s4 = (await phone(c)('POST', 'sends', { items: [{ name: 'c.jpg', bytes: 5, local: true }], to: { devices: ['anna-pc'] } })).json;
    const ok4 = (await pc(c)('POST', `transfers/${s4.direct[0].transferId}/result`, { ok: true })).json;
    assert.deepEqual([ok4.delivery.status, ok4.delivery.via, ok4.fallback], ['delivered', 'direct', null]);
    assert.equal((await rowOf(c, s4.id)).status.state, 'picked');
  });
});

test('a family: "x von y abgeholt" until every member at sending opened it', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const s = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: m }], to: { people: ['family'] } })).json;
    let r = await rowOf(c, s.id);
    assert.deepEqual(r.to, [{ kind: 'family', members: 2, messenger: false }]);
    assert.deepEqual([r.status.state, r.status.open], ['waiting', ['Marc', 'Lena']]);
    await c.portal(MARC)('POST', `sends/${s.id}/opened`);
    r = await rowOf(c, s.id);
    assert.deepEqual([r.status.state, r.status.picked, r.status.total, r.status.open], ['partial', 1, 2, ['Lena']]);
    await c.as(LENA)('POST', `sends/${s.id}/opened`);
    r = await rowOf(c, s.id);
    assert.deepEqual([r.status.state, r.status.how], ['picked', 'opened']);
    assert.equal((await c.portal(OMA)('POST', `sends/${s.id}/opened`)).status, 404, 'not a member');
  });
});

test('filters, counts, search and pages (server-side, a cursor)', async () => {
  await withHost({}, async (host, c) => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await phone(c)('POST', 'sends', { text: `t${i}`, to: { devices: ['anna-pc'] } })).json.id);
      c.clock.add(MIN);
    }
    const mid = (await c.as(MARC, 'marc-phone')('POST', 'sends', { items: [{ mediaId: await c.upload(MARC, PNG, 'image/png') }], to: { people: [OMA.id] } })).json.id;
    c.clock.add(MIN);
    // the PC picked up two of Anna's texts
    await pc(c)('POST', `sends/${ids[0]}/opened`);
    await pc(c)('POST', `sends/${ids[1]}/opened`);
    let r = await list(c, { limit: '2' });
    assert.deepEqual(r.counts, { all: 6, problems: 0, waiting: 4, direct: 0, server: 6, links: 0 });
    assert.deepEqual(r.items.map((s) => s.id), [mid, ids[4]]);
    assert.equal(r.hasMore, true);
    const seen = r.items.map((s) => s.id);
    while (r.hasMore) {
      r = await list(c, { limit: '2', cursor: r.cursor });
      seen.push(...r.items.map((s) => s.id));
    }
    assert.deepEqual(seen, [mid, ...ids.slice().reverse()], 'every send once, newest first');
    assert.deepEqual((await list(c, { filter: 'waiting' })).items.map((s) => s.id), [mid, ids[4], ids[3], ids[2]]);
    // search: a person (sender or recipient), a device
    assert.deepEqual((await list(c, { q: 'oma' })).items.map((s) => s.id), [mid]);
    assert.deepEqual((await list(c, { q: 'Marc' })).items.map((s) => s.id), [mid]);
    assert.equal((await list(c, { q: 'büro' })).counts.all, 5);
    assert.equal((await list(c, { q: '100%_' })).counts.all, 0);
    // a day later the waiting ones are problems; the server range: sends with files on the server
    c.clock.add(DAY);
    assert.deepEqual((await list(c, { filter: 'problems' })).counts.problems, 4);
    assert.deepEqual((await list(c, { range: 'server' })).items.map((s) => s.id), [mid]);
    // 8 days later: not in the last 7 days, still in 30
    c.clock.add(7 * DAY);
    assert.equal((await list(c)).counts.all, 0);
    assert.equal((await list(c, { range: '30d' })).counts.all, 6);
    for (const q of [{ range: 'x' }, { filter: 'nope' }, { limit: '0' }, { limit: '101' }, { cursor: 'abc' }, { q: 'x'.repeat(61) }]) {
      assert.equal((await admin(c)('GET', 'admin/sends', null, q)).json.code, 'invalid', JSON.stringify(q));
    }
  });
});

test('retention: 7 / 7 as before; after the pick-up vs. not picked up; existing sends follow a new setting; links keep their time', async () => {
  await withHost({}, async (host, c) => {
    const T0 = c.clock.now();
    const up = async (u = ANNA) => c.upload(u, PDF, 'application/pdf');
    const a = (await phone(c)('POST', 'sends', { items: [{ mediaId: await up() }], to: { devices: ['anna-pc'] } })).json;
    assert.equal(a.send.expiresAt, new Date(T0 + 7 * DAY).toISOString(), 'the default: 7 days after sending, as before');
    await pc(c)('POST', `sends/${a.id}/opened`);
    assert.equal((await phone(c)('GET', `sends/${a.id}`)).json.send.expiresAt, new Date(T0 + 7 * DAY).toISOString(), 'picked up: still 7 days after sending');
    const b = (await phone(c)('POST', 'sends', { items: [{ mediaId: await up() }], to: { devices: ['anna-pc'] } })).json;
    const ln = (await c.portal(ADMIN)('POST', 'sends', { items: [{ mediaId: await up(ADMIN) }], to: { link: { expires: '7d' } } })).json;
    // the administrator: delete at once after the pick-up, 3 days for the rest
    for (const bad of [{}, { afterDays: 2, unpickedDays: 3 }, { afterDays: 0, unpickedDays: 5 }, { afterDays: '0', unpickedDays: 3 }]) {
      assert.equal((await admin(c)('PUT', 'admin/retention', bad)).json.code, 'invalid');
    }
    const set = (await admin(c)('PUT', 'admin/retention', { afterDays: 0, unpickedDays: 3 })).json;
    assert.deepEqual(set.retention, { afterDays: 0, unpickedDays: 3, after: [0, 1, 3, 7], unpicked: [3, 7, 14, 30] });
    assert.deepEqual([(await phone(c)('GET', 'targets')).json.limits.retentionDays, (await phone(c)('GET', 'targets')).json.limits.retention], [3, { afterPickupDays: 0, unpickedDays: 3 }]);
    assert.equal((await phone(c)('GET', `sends/${a.id}`)).json.send.expiresAt, new Date(T0 + 15 * MIN).toISOString(), 'picked up: 15 minutes for a running download');
    assert.equal((await phone(c)('GET', `sends/${b.id}`)).json.send.expiresAt, new Date(T0 + 3 * DAY).toISOString());
    assert.equal(ln.link.expiresAt, new Date(T0 + 7 * DAY).toISOString(), 'the link keeps its 7 days');
    assert.equal((await c.portal(ADMIN)('GET', `sends/${ln.id}`)).json.send.expiresAt, new Date(T0 + 7 * DAY).toISOString(), 'its files stay as long as the link');
    c.clock.add(16 * MIN);
    assert.equal((await host.tick()).purged, 1);
    assert.equal((await phone(c)('GET', `sends/${a.id}`)).json.send.expired, true);
    // b picked up a day later: deleted then (not 3 days after sending)
    c.clock.add(DAY);
    await pc(c)('POST', `sends/${b.id}/opened`);
    c.clock.add(16 * MIN);
    assert.equal((await host.tick()).purged, 1);
    assert.equal((await phone(c)('GET', `sends/${b.id}`)).json.send.expired, true);
    // 1 day after the pick-up, 7 days for the rest: a new send not picked up stays 7 days, one picked up a day
    await admin(c)('PUT', 'admin/retention', { afterDays: 1, unpickedDays: 7 });
    const T1 = c.clock.now();
    const d = (await phone(c)('POST', 'sends', { items: [{ mediaId: await up() }], to: { devices: ['anna-tab'] } })).json;
    assert.equal(d.send.expiresAt, new Date(T1 + 7 * DAY).toISOString());
    c.clock.add(HOUR);
    await tab(c)('POST', `sends/${d.id}/opened`);
    assert.equal((await phone(c)('GET', `sends/${d.id}`)).json.send.expiresAt, new Date(T1 + HOUR + DAY).toISOString());
    assert.equal((await admin(c)('GET', 'admin/overview')).json.retentionDays, 7);
  });
});

test('freeing storage: sizes, "Vom Admin entfernt" for the sender, nothing more for recipients, links revoked, files deleted', async () => {
  await withHost({}, async (host, c) => {
    const mA = await c.upload(ANNA, PDF, 'application/pdf');
    const old = (await phone(c)('POST', 'sends', { items: [{ mediaId: mA, name: 'alt.pdf' }], text: 'alter Text', to: { devices: ['anna-tab'], people: [MARC.id] } })).json;
    const mL = await c.upload(ADMIN, PNG, 'image/png');
    const ln = (await c.portal(ADMIN)('POST', 'sends', { items: [{ mediaId: mL }], to: { link: { expires: '7d' } } })).json;
    c.clock.add(4 * DAY);
    const mP = await c.upload(ANNA, PNG, 'image/png');
    const picked = (await phone(c)('POST', 'sends', { items: [{ mediaId: mP }], to: { devices: ['anna-pc'] } })).json;
    await pc(c)('POST', `sends/${picked.id}/opened`);
    const mN = await c.upload(ANNA, PDF, 'application/pdf');
    const fresh = (await phone(c)('POST', 'sends', { items: [{ mediaId: mN }], to: { devices: ['anna-tab'] } })).json;
    // live sizes per option
    let info = (await admin(c)('GET', 'admin/cleanup', null, { olderDays: '3' })).json;
    assert.deepEqual(info, { ok: true, unpicked: { olderDays: 3, count: 2, bytes: PDF.length + PNG.length }, picked: { count: 1, bytes: PNG.length }, olderDays: [1, 3, 7] });
    info = (await admin(c)('GET', 'admin/cleanup', null, { olderDays: '7' })).json;
    assert.deepEqual([info.unpicked.count, info.unpicked.bytes], [0, 0]);
    for (const q of [{ olderDays: '2' }, { olderDays: 'x' }]) assert.equal((await admin(c)('GET', 'admin/cleanup', null, q)).json.code, 'invalid');
    for (const b of [{}, { unpicked: 2 }, { picked: 'yes' }, { unpicked: null, picked: false }]) assert.equal((await admin(c)('POST', 'admin/cleanup', b)).json.code, 'invalid', JSON.stringify(b));
    // remove what nobody picked up for 3 days
    const r = (await admin(c)('POST', 'admin/cleanup', { unpicked: 3, picked: false })).json;
    assert.deepEqual([r.removed, r.bytes], [2, PDF.length + PNG.length]);
    await host.plugin._idle();
    assert.equal(host.media.has(mA), false, 'the files are deleted');
    assert.equal(host.media.has(mL), false);
    assert.equal(host.media.has(mN), true, 'a fresh send stays');
    assert.equal(host.publicLinks.get(ln.link.token).revoked, true, 'the link is revoked');
    // the sender: "Vom Admin entfernt"
    const s = (await phone(c)('GET', `sends/${old.id}`)).json.send;
    assert.deepEqual([s.removed, s.expired, s.items[0].available], [true, true, false]);
    assert.deepEqual(s.deliveries.map((d) => [d.target, d.status, d.error]), [['anna-tab', 'expired', 'removed'], [String(MARC.id), 'expired', 'removed']]);
    assert.equal((await phone(c)('GET', 'inbox', null, { kind: 'sent' })).json.items.find((x) => x.id === old.id).removed, true);
    // recipients that did not pick it up: nothing
    assert.deepEqual((await tab(c)('GET', 'pending')).json.items.map((x) => x.id), [fresh.id]);
    assert.equal((await c.as(MARC)('GET', `sends/${old.id}`)).status, 404);
    assert.deepEqual((await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items, []);
    assert.equal((await c.as(MARC)('GET', `items/${mA}`)).status, 404);
    assert.equal((await phone(c)('POST', `sends/${old.id}/items`, { items: [{ index: 0, mediaId: mN }] })).json.code, 'gone');
    // the list
    const row = await rowOf(c, old.id);
    assert.deepEqual([row.status.state, row.server.state, row.canDelete], ['removed', 'removed', false]);
    // one send by hand
    assert.equal((await admin(c)('DELETE', `admin/sends/${old.id}`)).json.code, 'gone');
    assert.equal((await admin(c)('DELETE', 'admin/sends/nope')).json.code, 'not_found');
    const one = (await admin(c)('DELETE', `admin/sends/${picked.id}`)).json;
    assert.deepEqual([one.removed, one.bytes], [true, PNG.length]);
    await host.plugin._idle();
    assert.equal(host.media.has(mP), false);
    const p = (await phone(c)('GET', `sends/${picked.id}`)).json.send;
    assert.deepEqual([p.removed, p.deliveries[0].status, p.deliveries[0].error], [true, 'opened', null], 'picked up before: stays as it was');
    assert.equal((await pc(c)('GET', 'inbox', null, { kind: 'received' })).json.items.some((x) => x.id === picked.id), true, 'the PC that had it still lists it');
    info = (await admin(c)('GET', 'admin/cleanup', null, { olderDays: '1' })).json;
    assert.deepEqual([info.unpicked.count, info.picked.count], [0, 0]);
    // the picked option
    await pc(c)('POST', `sends/${fresh.id}/opened`);
    assert.equal((await admin(c)('POST', 'admin/cleanup', { picked: true })).json.removed, 0, 'the tablet is the target, not the PC');
    await tab(c)('POST', `sends/${fresh.id}/opened`);
    assert.deepEqual((await admin(c)('POST', 'admin/cleanup', { picked: true })).json, { ok: true, removed: 1, bytes: PDF.length });
  });
});

test('GET targets offers only devices that used GateDrop — any app request makes one known; sending to an unknown id still works', async () => {
  await withHost({ seen: false }, async (host, c) => {
    assert.deepEqual((await c.portal(ANNA)('GET', 'targets')).json.devices, []);
    await pc(c)('GET', 'pending');
    await c.presence(ANNA, 'anna-tab', '192.168.1.5', false);
    assert.deepEqual((await c.portal(ANNA)('GET', 'targets')).json.devices.map((d) => d.id), ['anna-pc', 'anna-tab']);
    assert.deepEqual((await pc(c)('GET', 'targets')).json.devices.map((d) => d.id), ['anna-tab'], 'not the asking device');
    assert.equal((await c.portal(ANNA)('POST', 'sends', { text: 'x', to: { devices: ['anna-phone'] } })).status, 200, 'an id the app kept');
  });
});

test('migration 004 takes over what was known: pick-ups (opened, NAS / Drive, chat, direct with the receiver\'s ok) and the devices that used GateDrop', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'migrations');
  const db = new DatabaseSync(':memory:');
  for (const f of ['001_init.sql', '002_device_access.sql', '003_scan.sql']) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  db.exec(`
    INSERT INTO sends (id, user_id, device_id, device_name, created_at, expires_at) VALUES ('s1', 2, 'p1', 'Pixel', 100, 200), ('s2', 2, NULL, NULL, 110, 210), ('s3', 3, 'm1', 'M', 120, 220);
    INSERT INTO deliveries (send_id, kind, target, user_id, status, via, at, opened_at) VALUES ('s1', 'device', 'pc1', 2, 'opened', 'server', 101, 105);
    INSERT INTO deliveries (send_id, kind, target, user_id, status, via, at, ref, gd_items) VALUES ('s2', 'person', '3', 3, 'delivered', 'server', 111, 'chat:5', 0);
    INSERT INTO deliveries (send_id, kind, target, user_id, status, via, at) VALUES ('s2', 'device', 'pc1', 2, 'delivered', 'server', 112);
    INSERT INTO deliveries (send_id, kind, target, user_id, status, via, at) VALUES ('s3', 'device', 'tab', 3, 'delivered', 'direct', 121);
    INSERT INTO transfers (id, send_id, delivery_id, to_device, mode, candidates, created_at, expires_at, status, receiver_result)
      VALUES ('t1', 's3', 4, 'tab', 'push', '[]', 120, 130, 'done', '{"ok":true,"bytes":5,"error":null,"at":121}');
    INSERT INTO presence (device_id, user_id, lan, at) VALUES ('w1', 4, '[]', 50);
  `);
  db.exec(fs.readFileSync(path.join(dir, '004_admin.sql'), 'utf8'));
  const plain = (rows) => rows.map((r) => ({ ...r }));
  assert.deepEqual(plain(db.prepare('SELECT device_id, user_id FROM devices_seen ORDER BY device_id').all()),
    [{ device_id: 'm1', user_id: 3 }, { device_id: 'p1', user_id: 2 }, { device_id: 'pc1', user_id: 2 }, { device_id: 'tab', user_id: 3 }, { device_id: 'w1', user_id: 4 }]);
  assert.deepEqual(plain(db.prepare('SELECT id, picked_at FROM deliveries ORDER BY id').all()), [{ id: 1, picked_at: 105 }, { id: 2, picked_at: 111 }, { id: 3, picked_at: null }, { id: 4, picked_at: 121 }],
    'a device delivery only delivered is not picked up');
  assert.deepEqual(plain(db.prepare('SELECT id, picked_at, expires_at FROM sends ORDER BY id').all()),
    [{ id: 's1', picked_at: 105, expires_at: 200 }, { id: 's2', picked_at: null, expires_at: 210 }, { id: 's3', picked_at: 121, expires_at: 220 }], 'the expiry stays');
});
