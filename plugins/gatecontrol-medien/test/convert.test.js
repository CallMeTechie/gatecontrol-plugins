'use strict';

// "Videos umwandeln", step 1: the scan through the mock Jellyfin (pages under 5 MB, changes only, a full scan drops
// what is gone), the session watch, the admin list and the App API v1/convert/status.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, withJellyfin, MILA, JONAS, LENA, PAUL } = require('./helpers');
const convert = require('../server/convert');
const { items } = require('./fixtures/media-items.json');

const idOf = (name) => items.find((x) => x.Name === name).Id;
const settle = async () => { while (convert._running.p) await convert._running.p; };

async function scanned(o = {}) {
  const t = await setup({ jf: { items, ...(o.jf || {}) } });
  await withJellyfin(t);
  const first = await t.adminReq('GET', 'convert');
  await settle();
  return { t, first };
}

test('the first visit starts the scan; the list: convert first, then notices, nothing that plays everywhere', async () => {
  const { t, first } = await scanned();
  try {
    assert.equal(first.ok, true);
    assert.equal(first.scan.running, true);
    assert.equal(first.available, false);
    const r = await t.adminReq('GET', 'convert');
    assert.equal(r.scan.running, false);
    assert.equal(r.scan.total, items.length);
    assert.deepEqual(r.scan.sources.map((s) => [s.id, s.total, s.error]), [['jf-1', items.length, null]]);
    assert.deepEqual(r.counts, { convert: 6, hint: 5, info: 0, stalled: 0 });
    assert.equal(r.items.length, 11);
    assert.deepEqual([...new Set(r.items.map((x) => x.level))], ['convert', 'hint']);
    const names = r.items.map((x) => x.name);
    for (const n of ['Ankunft', 'Zwei Ufer']) assert.ok(!names.includes(n), n);
    const e05 = r.items.find((x) => x.name === 'Die stille Werft');
    assert.equal(e05.kind, 'Episode');
    assert.equal(e05.series, 'Sternenhafen');
    assert.deepEqual([e05.season, e05.episode], [1, 5]);
    assert.equal(e05.source, 'DS918+');
    assert.equal(e05.id, idOf('Die stille Werft'));
    assert.deepEqual(e05.devices, { phone: 'no', tv: 'no', windows: 'no' });
    assert.equal(e05.reasons[0].code, 'h264_10bit');
    assert.match(e05.path, /^\/volume2\/mediathek\/Serien\/Sternenhafen\//);
    // the totals of "convert": estimated minutes and sizes, the night window of the Entwurf
    assert.ok(r.totals.minutes > 60 && r.totals.sizeAfter > r.totals.sizeBefore * 0.5);
    assert.deepEqual([r.window.from, r.window.to, r.window.minutes], ['01:00', '06:00', 300]);
    // an older GateControl (no gc.transcode): only the list, nothing to convert with
    assert.equal(r.available, false);
    assert.equal(r.transcode.reason, 'server');
    // pages through the target: films and episodes with their media sources, only existing files
    const call = t.jelly.state.calls.find((c) => c.path.startsWith('/Items?'));
    const q = new URL(call.path, 'http://jf').searchParams;
    assert.equal(q.get('IncludeItemTypes'), 'Movie,Episode');
    assert.equal(q.get('Fields'), 'MediaSources,Path');
    assert.equal(q.get('IsMissing'), 'false');
    assert.equal(q.get('Limit'), '200');
    assert.equal(call.auth, 'token');
  } finally { await t.host.close(); }
});

test('an answer over 5 MB: the page is asked again smaller; many items come in several pages', async () => {
  const many = [];
  for (let i = 0; i < 4; i++) for (const it of items) many.push({ ...it, Id: (i + 'a' + it.Id).slice(0, 32) });
  const t = await setup({ jf: { items: many, maxItemsPage: 30 } });
  try {
    await withJellyfin(t);
    await t.adminReq('GET', 'convert');
    await settle();
    const r = await t.adminReq('GET', 'convert');
    assert.equal(r.scan.total, many.length);
    assert.equal(r.counts.convert + r.counts.hint, 44);
    const limits = t.jelly.state.calls.filter((c) => c.path.startsWith('/Items?')).map((c) => new URL(c.path, 'http://jf').searchParams.get('Limit'));
    assert.deepEqual(limits.slice(0, 4), ['200', '100', '50', '25']);
    assert.equal(limits.filter((l) => l === '25').length, Math.ceil(many.length / 25));
  } finally { await t.host.close(); }
});

test('later only changes (MinDateLastSaved); "Neu prüfen" scans all and drops what is gone', async (tt) => {
  const { t } = await scanned();
  try {
    // the episode was replaced by an 8-bit file
    const e05 = t.jelly.state.items.find((x) => x.Name === 'Die stille Werft');
    const v = e05.MediaSources[0].MediaStreams[0];
    Object.assign(v, { Profile: 'High', BitDepth: 8, PixelFormat: 'yuv420p' });
    e05.DateLastSaved = new Date(Date.now() + 1000).toISOString();
    const real = Date.now;
    tt.mock.method(Date, 'now', () => real() + 31 * 60000);
    await t.host.tick();
    await settle();
    tt.mock.restoreAll();
    const inc = t.jelly.state.calls.filter((c) => c.path.startsWith('/Items?')).pop();
    assert.ok(new URL(inc.path, 'http://jf').searchParams.get('MinDateLastSaved'));
    let r = await t.adminReq('GET', 'convert');
    assert.ok(!r.items.some((x) => x.name === 'Die stille Werft'));
    assert.equal(r.counts.convert, 5);
    assert.equal(r.scan.total, items.length);
    // a film deleted in Jellyfin: only the full scan notices
    t.jelly.state.items = t.jelly.state.items.filter((x) => x.Name !== 'Nachtfalter');
    const s = await t.adminReq('POST', 'convert/scan', {});
    assert.deepEqual(s.scan, { running: true });
    await settle();
    r = await t.adminReq('GET', 'convert');
    assert.ok(!r.items.some((x) => x.name === 'Nachtfalter'));
    assert.equal(r.counts.convert, 4);
    assert.equal(r.scan.total, items.length - 1);
  } finally { await t.host.close(); }
});

test('Jellyfin not reachable: the source carries the error, the list stays', async () => {
  const { t } = await scanned();
  try {
    t.jelly.state.down = true;
    await t.adminReq('POST', 'convert/scan', {});
    await settle();
    const r = await t.adminReq('GET', 'convert');
    assert.equal(r.scan.sources[0].error, 'jellyfin_unreachable');
    assert.equal(r.counts.convert, 6);
  } finally { await t.host.close(); }
});

test('a playback converted slower than real time marks the file "beim Abspielen gestockt" and moves it up', async () => {
  const { t } = await scanned();
  try {
    const id = idOf('Leuchtfeuer');
    t.jelly.state.sessions = [
      { Id: 's1', NowPlayingItem: { Id: id, Name: 'Leuchtfeuer' }, PlayState: { IsPaused: false },
        TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true, Framerate: 31.5, TranscodeReasons: ['VideoBitDepthNotSupported'] } },
      // direct play and a fast conversion are not marked
      { Id: 's2', NowPlayingItem: { Id: idOf('Die Uhrmacherin') }, PlayState: { IsPaused: false }, TranscodingInfo: { IsVideoDirect: false, Framerate: 80 } },
      { Id: 's3', NowPlayingItem: { Id: idOf('Hafenfest') }, PlayState: { IsPaused: false } },
    ];
    await t.host.tick();
    const r = await t.adminReq('GET', 'convert');
    assert.equal(r.counts.stalled, 1);
    assert.equal(r.items[0].id, id);
    assert.deepEqual(r.items[0].stalled.reasons, ['VideoBitDepthNotSupported']);
    assert.ok(t.jelly.state.calls.some((c) => c.path.startsWith('/Sessions?')));
  } finally { await t.host.close(); }
});

test('no sessions are read while the list is empty or was never opened', async () => {
  const t = await setup({ jf: { items } });
  try {
    await withJellyfin(t);
    await t.host.tick();
    assert.ok(!t.jelly.state.calls.some((c) => c.path.startsWith('/Sessions') || c.path.startsWith('/Items')));
  } finally { await t.host.close(); }
});

test('App API v1/convert/status: what the list knows, only from visible sources, state "none" without converting', async () => {
  const { t } = await scanned();
  try {
    const a = idOf('Die stille Werft');
    const b = idOf('Ankunft');
    const r = await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: { items: a + ',' + b.toUpperCase() } });
    assert.equal(r.ok, true);
    assert.equal(r.v, 1);
    assert.equal(r.available, false);
    const none = { state: 'none', position: null, startsAt: null, percent: null };
    assert.deepEqual(r.items, [
      { id: a, sourceId: 'jf-1', level: 'convert', reasons: ['h264_10bit'], devices: { phone: 'no', tv: 'no', windows: 'no' }, stalled: false, requested: false, ...none },
      { id: b, sourceId: null, level: null, reasons: [], devices: null, stalled: false, requested: false, ...none },
    ]);
    assert.deepEqual(r.states, { [a]: none, [b]: none });
    // a person who does not see the source learns nothing
    await t.adminReq('PUT', 'sources/jf-1/access', { mode: 'list', users: [MILA.id], groups: [] });
    for (const [who, dev] of [[LENA, '31'], [PAUL, null]]) {
      const x = await t.appReq(who, dev, 'GET', 'convert/status', null, { query: { items: a } });
      assert.equal(x.items[0].level, null, who.name);
    }
    // without the right "Medien"
    await t.adminReq('PUT', 'rights/user/' + JONAS.id, { media: false });
    const jonas = await t.appReq(JONAS, '21', 'GET', 'convert/status', null, { query: { items: a } });
    assert.equal(jonas.status, 403);
    assert.equal(jonas.code, 'no_access');
    // bad ids, too many ids
    assert.equal((await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: { items: 'x' } })).code, 'invalid');
    const lots = Array.from({ length: 101 }, (_, i) => String(i).padStart(32, '0')).join(',');
    assert.equal((await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: { items: lots } })).code, 'invalid');
    assert.deepEqual((await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: {} })).items, []);
  } finally { await t.host.close(); }
});

test('admin only: the list is not reachable for a normal person', async () => {
  const t = await setup({ jf: { items } });
  try {
    await withJellyfin(t);
    const r = await t.host.request({ method: 'GET', path: '/admin/convert', user: { ...JONAS }, lang: 'de' });
    assert.equal(r.status, 403);
  } finally { await t.host.close(); }
});
