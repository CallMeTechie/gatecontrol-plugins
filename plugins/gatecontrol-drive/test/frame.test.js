'use strict';

// The photo frame on the wall tablet (1.7.0, server/frame.js): a kiosk device sees the section "Fotorahmen" and gets
// the large previews of the frame albums as preview-only URLs (GateControl ≥ 1.210.0) — no names, nothing else of
// Drive; only what the person who switched an album on reads and may still show; the settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, OMA, LENA } = require('./helpers');
const { t } = require('../server/text');
const ui = require('../server/ui');

// the wall tablet: a kiosk device signed in as Oma's account (no seat of Drive)
const KIOSK = { ...OMA, portal: true, loggedIn: true, kiosk: true };
const kiosk = (c) => (m, p, b, q) => c.call(KIOSK, m, p, b, q);

async function setup(c) {
  const fam = await c.area(ANNA, 'family');
  const mine = await c.area(ANNA, 'mine');
  const put = (area, name, mime = 'image/jpeg', t0 = 1) => c.put(ANNA, area.rootId, name, `${name}-bytes`, { mime, takenAt: Date.UTC(2025, 6, t0) });
  const famPic = (await put(fam, 'Familienfest.jpg', 'image/jpeg', 2)).json.node;
  const famVid = (await put(fam, 'Video.mp4', 'video/mp4', 3)).json.node;
  const minePic = (await put(mine, 'Annas Geheimnis.jpg', 'image/jpeg', 4)).json.node;
  const trashed = (await put(fam, 'Weg.jpg', 'image/jpeg', 5)).json.node;
  const al = (await c.as(ANNA)('POST', 'albums', { name: 'Wand', areaId: fam.id })).json.album;
  assert.equal((await c.as(ANNA)('POST', `albums/${al.id}/items`, { ids: [famPic.id, famVid.id, minePic.id, trashed.id] })).status, 200);
  await c.as(ANNA)('DELETE', `nodes/${trashed.id}`);
  return { fam, mine, famPic, famVid, minePic, al };
}

test('the kiosk device: the frame albums\' pictures as preview-only URLs, nothing else of Drive', async () => {
  await withHost({ gatecontrol: '1.210.0', settings: { frame_seconds: 12, frame_order: 'date' } }, async (host, c) => {
    const k = kiosk(c);
    const { famPic, minePic, al } = await setup(c);
    // no album on the frame yet: on, nothing to show; the section stays hidden
    let r = await k('GET', 'frame');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.on, r.json.ready, r.json.items], [true, true, []]);
    assert.equal(await host.portalVisible(KIOSK, 'frame'), false);
    // Marc (a parent) puts the family's album on the frame: Anna's own photo stays out (he cannot read it), the video,
    // the trashed one too
    assert.equal((await c.as(MARC)('PATCH', `albums/${al.id}`, { frame: true })).status, 200);
    assert.equal(await host.portalVisible(KIOSK, 'frame'), true);
    r = await k('GET', 'frame');
    assert.deepEqual([r.json.on, r.json.ready, r.json.seconds, r.json.order], [true, true, 12, 'date']);
    assert.equal(r.json.items.length, 1);
    const it = r.json.items[0];
    assert.deepEqual(Object.keys(it).sort(), ['takenAt', 'url']);
    assert.equal(it.takenAt, new Date(Date.UTC(2025, 6, 2)).toISOString());
    assert.match(it.url, /^\/plugin-media\/[0-9a-f]{32}\.\d+\.5\.[A-Za-z0-9_-]{22}\/preview\?size=large$/, 'signed for the kiosk account, the large preview');
    const body = JSON.stringify(r.json);
    // (the URL's token carries the media id — GateControl's capability format; no name, no folder, no node id)
    for (const s of ['Familienfest', 'Annas', 'Wand', minePic.mediaId, `"${famPic.id}"`, 'areaId', 'name']) assert.ok(!body.includes(s), `nothing named: ${s}`);
    // the preview opens, the file itself does not
    const prev = await host.mediaFromUrl(it.url);
    assert.equal(prev.status, 200);
    assert.equal(String(prev.body), `preview:${famPic.mediaId}:large`);
    assert.equal((await host.mediaFromUrl(it.url.replace(/\/preview\?size=large$/, ''))).status, 404);
    // Anna puts her own photo in an album of hers on the frame: now it shows
    const own = (await c.as(ANNA)('POST', 'albums', { name: 'Meine Wand' })).json.album;
    await c.as(ANNA)('POST', `albums/${own.id}/items`, { ids: [minePic.id, famPic.id] });
    assert.equal((await c.as(ANNA)('PATCH', `albums/${own.id}`, { frame: true })).status, 200);
    assert.equal((await k('GET', 'frame')).json.items.length, 2, 'each picture once');
    // everything else refuses the kiosk device
    const mine = await c.area(ANNA, 'mine');
    for (const [m, p, b, q] of [['GET', 'me'], ['GET', 'areas'], ['GET', `nodes/${famPic.id}`], ['GET', `nodes/${famPic.id}/content`], ['GET', `nodes/${mine.rootId}/children`],
      ['GET', 'photos'], ['GET', 'photos/memories'], ['GET', 'albums'], ['GET', `albums/${al.id}`], ['GET', 'storage'], ['GET', 'search', null, { q: 'Fest' }],
      ['GET', 'changes'], ['GET', 'trash'], ['GET', 'wipes'], ['GET', 'guard/incidents'], ['GET', 'devices'], ['GET', 'links'],
      ['POST', 'uploads/commit', { parentId: mine.rootId, name: 'x.txt', size: 0 }], ['PATCH', `albums/${al.id}`, { frame: false }], ['POST', 'frame'], ['GET', 'frame/x'],
      ['GET', `nodes/${mine.rootId}/timetravel`, null, { at: new Date(c.clock.now() - 1000).toISOString() }]]) {
      const x = await k(m, p, b, q);
      assert.equal(x.status, 403, `${m} ${p}`);
      assert.equal(x.json.code, 'forbidden');
    }
    assert.equal((await k('GET', 'portal/frame')).status, 200, 'also under portal/');
    assert.equal((await k('GET', 'portal/me')).status, 403);
    assert.equal(await host.portalVisible(KIOSK, null), false, 'no Drive tab');
    assert.equal(await host.portalVisible({ ...ANNA, portal: true, loggedIn: true }, 'frame'), false, 'the section is for kiosk devices');
    assert.equal(await host.portalVisible({ ...OMA, portal: true, loggedIn: true }, 'frame'), false, 'Oma herself is no kiosk device');
    // a person gets no frame
    assert.equal((await c.portal(ANNA)('GET', 'frame')).status, 404);
    // the media of Drive stay closed to it (hook mediaAccess)
    assert.equal(await host.plugin.mediaAccess({ user: KIOSK, mediaId: famPic.mediaId, owner: ANNA.id }, host.gc), false);
    // the frame ends with the person's right: Marc loses his seat — his album leaves the frame
    await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: null });
    assert.deepEqual((await k('GET', 'frame')).json.items.length, 2, 'Anna\'s album still shows both of hers');
    await c.as(ANNA)('PATCH', `albums/${own.id}`, { frame: false });
    assert.deepEqual((await k('GET', 'frame')).json.items, []);
  });
});

test('settings: switched off, only some kiosk accounts; a GateControl without preview-only URLs shows nothing', async () => {
  await withHost({ gatecontrol: '1.210.0', settings: { frame_accounts: 'Küche, 99' } }, async (host, c) => {
    const { al } = await setup(c);
    await c.as(ANNA)('PATCH', `albums/${al.id}`, { frame: true });
    assert.deepEqual((await kiosk(c)('GET', 'frame')).json.on, false, 'Oma\'s account is not listed');
    assert.equal(await host.portalVisible(KIOSK, 'frame'), false);
    host.settings.frame_accounts = 'küche, oma';
    // Anna switched it on: her own photo in the family's album shows too (she reads it)
    assert.equal((await kiosk(c)('GET', 'frame')).json.items.length, 2);
    host.settings.frame_accounts = String(OMA.id);
    assert.equal((await kiosk(c)('GET', 'frame')).json.items.length, 2, 'by id');
    host.settings.frame_on = false;
    const off = (await kiosk(c)('GET', 'frame')).json;
    assert.deepEqual([off.on, off.items], [false, []]);
    assert.equal(await host.portalVisible(KIOSK, 'frame'), false);
  });
  await withHost({ gatecontrol: '1.208.0' }, async (host, c) => {
    const { al } = await setup(c);
    await c.as(ANNA)('PATCH', `albums/${al.id}`, { frame: true });
    const r = (await kiosk(c)('GET', 'frame')).json;
    assert.deepEqual([r.on, r.ready, r.items], [true, false, []], 'never a URL that opens the file');
  });
});

test('frame rights: a child never, a family\'s album only by a parent or an administrator', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const { al } = await setup(c);
    assert.equal((await c.as(LENA)('PATCH', `albums/${al.id}`, { frame: true })).status, 403);
    assert.equal((await c.as(ANNA)('PATCH', `albums/${al.id}`, { frame: true })).status, 200);
    assert.equal((await c.as(LENA)('PATCH', `albums/${al.id}`, { frame: false })).status, 403, 'nor off');
  });
});

test('render: the section "Fotorahmen" inlines its page; a kiosk device gets kiosk: true; plugin.json declares the section', () => {
  const ctxOf = (html) => JSON.parse(html.split('window.DF_CTX=')[1].split(';</script>')[0]);
  for (const lang of ['de', 'en']) {
    const html = ui.render({ view: 'portal', section: 'frame', lang, user: { ...KIOSK } }, t);
    assert.ok(!/\{\{t:/.test(html));
    const ctx = ctxOf(html);
    assert.deepEqual([ctx.view, ctx.kiosk, ctx.lang], ['frame', true, lang]);
    assert.ok(ctx.texts['f.empty']);
    assert.ok(html.includes('id="df-a"') && html.includes('id="df-b"'));
    assert.ok(!/<script[^>]*\bsrc=|<link\b|<iframe\b/i.test(html));
  }
  assert.equal(ctxOf(ui.render({ view: 'portal', section: 'frame', lang: 'de', user: { id: 2, loggedIn: true } }, t)).kiosk, false);
  const m = require('../plugin.json');
  assert.deepEqual(m.ui.portal.sections.map((s) => [s.id, s.tab]), [['frame', 'home']]);
  assert.equal(m.permissions.kiosk, undefined, 'no new permission: the host shows home sections to kiosk devices');
  for (const k of ['frame_on', 'frame_seconds', 'frame_order', 'frame_accounts']) assert.ok(m.ui.settings.some((s) => s.key === k), k);
});
