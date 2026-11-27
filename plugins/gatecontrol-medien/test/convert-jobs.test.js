'use strict';

// "Videos umwandeln", step 2 (1.6.0): converting through the service "umwandeln" of a gateway (gc.transcode of the mock
// host, tools/testing/mock-transcode.js) — the queue, the night window (one job per gateway, only when it fits), "Jetzt",
// the pause while somebody watches, the reports (hook transcodeChanged), the check in Jellyfin, the errors, the trash,
// the settings, the morning notification and the App API (status, request).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, withJellyfin, MILA, JONAS } = require('./helpers');
const convert = require('../server/convert');
const { items } = require('./fixtures/media-items.json');

const GW = 7;
const at = (h, m = 0, day = 28) => new Date(2026, 10, day, h, m, 0, 0).getTime();
const idOf = (name) => items.find((x) => x.Name === name).Id;
const settle = async () => { while (convert._running.p) await convert._running.p; };

/** A clock the plugin and the mock host share (Date.now). */
function clock(tt, start) {
  const c = { now: start };
  tt.mock.method(Date, 'now', () => c.now);
  c.set = (v) => { c.now = v; };
  c.add = (ms) => { c.now += ms; };
  return c;
}

async function ready(tt, o = {}) {
  const c = clock(tt, o.start || at(14));
  const t = await setup({ jf: { items }, host: { transcode: { gateways: o.gateways || [{ id: GW, name: 'NAS Keller', roots: ['/volume2/mediathek'] }] } } });
  await withJellyfin(t);
  await t.adminReq('GET', 'convert');
  await settle();
  const tc = t.host.transcode;
  const row = async (name) => (await t.adminReq('GET', 'convert')).items.find((x) => x.name === name);
  const queue = (names, now) => t.adminReq('POST', 'convert/queue', { items: names.map((n) => ({ sourceId: 'jf-1', id: idOf(n) })), now: !!now });
  const jobs = () => tc.gateway(GW).jobs;
  return { t, c, tc, row, queue, jobs };
}

test('with a gateway that can convert: available, the list carries per row what can be done', async (tt) => {
  const { t } = await ready(tt);
  try {
    const r = await t.adminReq('GET', 'convert');
    assert.equal(r.available, true);
    assert.equal(r.transcode.reason, null);
    assert.deepEqual(r.transcode.gateways.map((g) => [g.id, g.name, g.problem]), [[GW, 'NAS Keller', null]]);
    assert.deepEqual([r.window.from, r.window.to, r.window.open], ['01:00', '06:00', false]);
    const werft = r.items.find((x) => x.name === 'Die stille Werft');
    assert.equal(werft.conv.state, 'none');
    assert.equal(werft.conv.why, null);
    // 1361 s at 3.0 × real time + 10 % for the check
    assert.equal(werft.conv.minutes, 8);
    // an AVI comes later (MKV only), a file outside every media folder of the gateway cannot be converted
    assert.equal(r.items.find((x) => x.name === 'Kinderfest am See').conv.why, 'not_mkv');
    assert.equal(r.settings.trashDays, 14);
    assert.deepEqual(r.queue, { count: 0, minutes: 0, unknown: 0, fits: true });
  } finally { await t.host.close(); }
});

test('gateway too old, switched off or offline: nothing to convert, the reason for the page', async (tt) => {
  for (const [g, reason] of [[{ supported: false }, 'gateway_update'], [{ enabled: false }, 'feature_disabled'], [{ online: false }, 'offline'], [{ state: 'device_denied' }, 'device_denied']]) {
    const { t } = await ready(tt, { gateways: [{ id: GW, name: 'NAS', ...g }] });
    try {
      const r = await t.adminReq('GET', 'convert');
      assert.equal(r.available, false, reason);
      assert.equal(r.transcode.reason, reason);
      tt.mock.restoreAll();
    } finally { await t.host.close(); }
  }
});

test('queue: nothing is submitted outside the window; in it one job per gateway, the next after the end of the last', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    const q = await queue(['Die stille Werft', 'Leuchtfeuer']);
    assert.deepEqual(q.queued.length, 2);
    await t.host.tick();
    assert.equal(jobs().length, 0);
    let r = await row('Die stille Werft');
    assert.deepEqual([r.conv.state, r.conv.position], ['queued', 1]);
    assert.equal((await row('Leuchtfeuer')).conv.position, 2);
    // 01:00 — the window opens
    c.set(at(1, 0, 29));
    await t.host.tick();
    assert.equal(jobs().length, 1);
    const j = jobs()[0];
    assert.match(j.id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(j.path, items.find((x) => x.Name === 'Die stille Werft').MediaSources[0].Path);
    await t.host.tick();
    assert.equal(jobs().length, 1, 'one at a time');
    // the gateway reports progress (hook transcodeChanged)
    tc.job(GW, j.id, { state: 'running', percent: 40, fps: 150, speed: 3.1 });
    await tc.report(GW);
    r = await row('Die stille Werft');
    assert.equal(r.conv.state, 'running');
    const view = await t.adminReq('GET', 'convert');
    assert.equal(view.current.length, 1);
    assert.deepEqual([view.current[0].percent, view.current[0].speed, view.current[0].gateway.name], [40, 3.1, 'NAS Keller']);
    // done: stored, acknowledged, the next file goes at once
    c.add(7 * 60000);
    tc.finish(GW, j.id, { seconds: 425 });
    await tc.report(GW);
    r = await row('Die stille Werft');
    assert.equal(r.conv.state, 'checking');
    assert.ok(!jobs().some((x) => x.id === j.id), 'acknowledged');
    assert.equal(jobs().length, 1);
    assert.equal(jobs()[0].path, items.find((x) => x.Name === 'Leuchtfeuer').MediaSources[0].Path);
    // the measured speed: 1361 s in 425 s
    const g = (await t.adminReq('GET', 'convert')).transcode.gateways[0];
    assert.deepEqual(g.speed, { speed: 3.2, measured: true });
  } finally { await t.host.close(); }
});

test('a new job starts only when it is likely to finish before the window ends; "Jetzt" goes at once', async (tt) => {
  const { t, c, queue, jobs } = await ready(tt);
  try {
    // a film of 115 min ≈ 42 min on the gateway, an episode ≈ 8 min — at 05:40 only the episode fits
    await queue(['Die Uhrmacherin']);
    c.add(1000);
    await queue(['Die stille Werft']);
    c.set(at(5, 40, 29));
    await t.host.tick();
    assert.deepEqual(jobs().map((j) => j.path.split('/').pop()), ['Sternenhafen - S01E05 - Die stille Werft.mkv']);
    // in the afternoon: "Jetzt umwandeln" submits outside the window
    c.set(at(15, 0, 29));
    const r = await queue(['Leuchtfeuer'], true);
    assert.equal(r.queued.length, 1);
    assert.equal(jobs().length, 2);
    assert.equal(jobs()[1].path.split('/').pop(), 'Sternenhafen - S01E06 - Leuchtfeuer.mkv');
  } finally { await t.host.close(); }
});

test('what cannot be queued: an AVI, a path outside the media folders, a gateway that refuses the path', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    const r = await queue(['Kinderfest am See']);
    assert.deepEqual(r, { ok: true, status: 200, queued: [], skipped: [{ id: idOf('Kinderfest am See'), reason: 'not_mkv' }] });
    // the gateway's own check fails (ERR_INVALID with reason): skipped at once, no failed attempt to repeat
    await queue(['Die stille Werft']);
    tc.gateway(GW).fail.submit = { code: 'ERR_INVALID', reason: 'outside_roots' };
    c.set(at(2, 0, 29));
    await t.host.tick();
    const w = await row('Die stille Werft');
    assert.deepEqual([w.conv.state, w.conv.error], ['skipped', 'outside_roots']);
    assert.equal(jobs().length, 0);
    const bad = await t.adminReq('POST', 'convert/queue', { items: [{ sourceId: 'jf-1', id: 'nope' }] });
    assert.equal(bad.code, 'invalid');
  } finally { await t.host.close(); }
});

test('errors: no_space waits for the next night, two failed attempts skip, device_denied stops the gateway', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft']);
    c.set(at(1, 5, 29));
    await t.host.tick();
    let j = jobs()[0];
    tc.fail(GW, j.id, 'no_space');
    await tc.report(GW);
    let r = await row('Die stille Werft');
    assert.deepEqual([r.conv.state, r.conv.error, r.conv.fails], ['queued', 'no_space', 0]);
    assert.equal(Date.parse(r.conv.notBefore), at(1, 0, 30));
    await t.host.tick();
    assert.equal(jobs().length, 0, 'not again this night');
    // the next night: a new id; encode_failed twice → skipped
    c.set(at(1, 5, 30));
    await t.host.tick();
    j = jobs()[0];
    assert.ok(j);
    tc.fail(GW, j.id, 'encode_failed');
    await tc.report(GW);
    r = await row('Die stille Werft');
    assert.deepEqual([r.conv.state, r.conv.fails, r.conv.error], ['queued', 1, 'encode_failed']);
    const j2 = jobs()[0];
    assert.notEqual(j2.id, j.id, 'a new id per attempt');
    tc.fail(GW, j2.id, 'encode_failed');
    await tc.report(GW);
    r = await row('Die stille Werft');
    assert.deepEqual([r.conv.state, r.conv.fails], ['skipped', 2]);
    const d = await t.adminReq('GET', 'convert/file', null, { query: { sourceId: 'jf-1', id: idOf('Die stille Werft') } });
    assert.equal(d.attempts.filter((a) => a.state === 'failed').length, 3);
    assert.deepEqual(d.attempts[0].log, ['ffmpeg: error']);
    // device_denied: nothing more for this gateway until it reports a working state
    await queue(['Leuchtfeuer', 'Neue Klasse']);
    await t.host.tick();
    j = jobs()[0];
    tc.fail(GW, j.id, 'device_denied');
    tc.gateway(GW).state = 'device_denied';
    await tc.report(GW);
    await t.host.tick();
    assert.equal(jobs().length, 0);
    let v = await t.adminReq('GET', 'convert');
    assert.equal(v.transcode.reason, 'device_denied');
    assert.equal(v.transcode.gateways[0].deviceGid, 937);
    c.add(60000);
    tc.gateway(GW).state = 'ready';
    await tc.report(GW);
    await t.host.tick();
    assert.equal(jobs().length, 1);
    v = await t.adminReq('GET', 'convert');
    assert.equal(v.transcode.reason, null);
  } finally { await t.host.close(); }
});

test('pause while somebody watches: pause { ttlSec: 180 } every minute, resume after the playback', async (tt) => {
  const { t, c, tc, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft']);
    c.set(at(1, 30, 29));
    await t.host.tick();
    tc.job(GW, jobs()[0].id, { state: 'running', percent: 10 });
    await tc.report(GW);
    t.jelly.state.sessions = [{ Id: 's1', NowPlayingItem: { Id: idOf('Ankunft'), Type: 'Episode', SeriesName: 'Sternenhafen' }, PlayState: { IsPaused: false } }];
    c.add(60000);
    await t.host.tick();
    const pauses = () => tc.calls.filter((x) => x.name === 'pause');
    assert.deepEqual(pauses().map((x) => x.args.opts), [{ ttlSec: 180 }]);
    assert.equal(tc.gateway(GW).pause.all, true);
    c.add(60000);
    await t.host.tick();
    assert.equal(pauses().length, 2, 'renewed every minute');
    const v = await t.adminReq('GET', 'convert');
    assert.equal(v.current[0].pausedAll, true);
    t.jelly.state.sessions = [];
    c.add(60000);
    await t.host.tick();
    assert.equal(tc.calls.filter((x) => x.name === 'resume').length, 1);
    assert.equal(tc.gateway(GW).pause.all, false);
    c.add(60000);
    await t.host.tick();
    assert.equal(tc.calls.filter((x) => x.name === 'resume').length, 1, 'only once');
    // the setting "Anhalten, solange jemand schaut" off: no pause
    await t.adminReq('PUT', 'convert/settings', { pauseWatch: false });
    t.jelly.state.sessions = [{ Id: 's1', NowPlayingItem: { Id: idOf('Ankunft') } }];
    c.add(60000);
    await t.host.tick();
    assert.equal(pauses().length, 2);
  } finally { await t.host.close(); }
});

test('the series somebody watches goes first, in episode order', async (tt) => {
  const { t, c, queue, jobs } = await ready(tt);
  try {
    await queue(['Die Uhrmacherin']);
    c.add(1000);
    await queue(['Leuchtfeuer']);
    c.add(1000);
    await queue(['Die stille Werft']);
    t.jelly.state.sessions = [{ Id: 's1', NowPlayingItem: { Id: idOf('Ankunft'), Type: 'Episode', SeriesName: 'Sternenhafen' } }];
    // the session is read while something is busy or paused: a "Jetzt" job makes the gateway busy
    await queue(['Neue Klasse'], true);
    c.add(60000);
    await t.host.tick();
    const r = await t.adminReq('GET', 'convert');
    const pos = (n) => r.items.find((x) => x.name === n).conv.position;
    // "Jetzt" first (submitted, waiting at the gateway), then the series being watched, then the rest
    assert.equal(pos('Neue Klasse'), 1);
    assert.deepEqual([pos('Die stille Werft'), pos('Leuchtfeuer'), pos('Die Uhrmacherin')], [2, 3, 4]);
    assert.equal(jobs().length, 1);
  } finally { await t.host.close(); }
});

test('after the swap: Jellyfin reads the file again, the plugin checks 8 bit and the runtime; the check view', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft']);
    c.set(at(2, 0, 29));
    await t.host.tick();
    const j = jobs()[0];
    tc.job(GW, j.id, { state: 'running', startedAt: new Date(c.now).toISOString() });
    c.add(7 * 60000);
    tc.finish(GW, j.id, { seconds: 425 });
    await tc.report(GW);
    // the next minute: /Library/Media/Updated with the path
    c.add(60000);
    await t.host.tick();
    const path = items.find((x) => x.Name === 'Die stille Werft').MediaSources[0].Path;
    assert.deepEqual(t.jelly.state.updated, [{ path, type: 'Modified' }]);
    // Jellyfin sees the new file (8 bit) — a minute later the plugin checks
    const it = t.jelly.state.items.find((x) => x.Name === 'Die stille Werft');
    Object.assign(it.MediaSources[0].MediaStreams[0], { Profile: 'High', BitDepth: 8, PixelFormat: 'yuv420p' });
    c.add(61000);
    await t.host.tick();
    const r = await row('Die stille Werft');
    assert.equal(r.conv.state, 'done');
    assert.equal(r.conv.check.ok, true);
    // it left the scan's list (plays everywhere) and still shows under "Fertig" from its snapshot
    const v = await t.adminReq('GET', 'convert');
    assert.equal(v.counts.convert, 5);
    const d = await t.adminReq('GET', 'convert/file', null, { query: { sourceId: 'jf-1', id: idOf('Die stille Werft') } });
    assert.equal(d.file.state, 'done');
    assert.equal(d.job.result.output.bits, 8);
    assert.equal(d.job.result.source.bits, 10);
    assert.match(d.trash.path, /\/volume2\/mediathek\/\.gc-papierkorb\/\d{4}-\d{2}-\d{2}\/Serien\/Sternenhafen\//);
    // the App API: done
    const a = await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: { items: idOf('Die stille Werft') } });
    assert.equal(a.available, true);
    assert.equal(a.items[0].state, 'done');
  } finally { await t.host.close(); }
});

test('Jellyfin does not confirm: after 30 tries the file is done without the confirmation', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft']);
    c.set(at(2, 0, 29));
    await t.host.tick();
    tc.finish(GW, jobs()[0].id);
    await tc.report(GW);
    t.jelly.state.updateFails = true;
    for (let i = 0; i < 40; i++) { c.add(61000); await t.host.tick(); }
    const r = await row('Die stille Werft');
    assert.equal(r.conv.state, 'done');
    assert.equal(r.conv.check.ok, false);
    // the fallback /Items/{id}/Refresh when /Library/Media/Updated fails
    assert.ok(t.jelly.state.refreshed.includes(idOf('Die stille Werft')));
  } finally { await t.host.close(); }
});

test('take out of the queue, cancel the running job, pause one job, hide a row', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft', 'Leuchtfeuer']);
    const k = (n) => ({ sourceId: 'jf-1', id: idOf(n) });
    let r = await t.adminReq('POST', 'convert/file', { ...k('Leuchtfeuer'), action: 'unqueue' });
    assert.equal(r.state, 'none');
    c.set(at(2, 0, 29));
    await t.host.tick();
    const j = jobs()[0];
    tc.job(GW, j.id, { state: 'running' });
    await tc.report(GW);
    r = await t.adminReq('POST', 'convert/file', { ...k('Die stille Werft'), action: 'pause' });
    assert.deepEqual(r.paused, true);
    assert.equal(tc.gateway(GW).jobs[0].paused, true);
    await t.adminReq('POST', 'convert/file', { ...k('Die stille Werft'), action: 'resume' });
    assert.equal(tc.gateway(GW).jobs[0].paused, false);
    r = await t.adminReq('POST', 'convert/file', { ...k('Die stille Werft'), action: 'unqueue' });
    assert.equal(r.state, 'none');
    assert.equal(tc.gateway(GW).jobs[0].state, 'cancelled');
    await tc.report(GW);
    assert.equal(jobs().length, 0, 'acknowledged');
    assert.equal((await row('Die stille Werft')).conv.state, 'none');
    // hide / show again
    await t.adminReq('POST', 'convert/file', { ...k('Wolkenkante'), action: 'hide' });
    assert.equal((await row('Wolkenkante')).conv.hidden, true);
    await t.adminReq('POST', 'convert/file', { ...k('Wolkenkante'), action: 'unhide' });
    assert.equal((await row('Wolkenkante')).conv.hidden, false);
    assert.equal((await t.adminReq('POST', 'convert/file', { ...k('Wolkenkante'), action: 'nope' })).code, 'invalid');
  } finally { await t.host.close(); }
});

test('"Alle über Nacht": every open row of the level "Umwandeln" that can be converted', async (tt) => {
  const { t } = await ready(tt);
  try {
    const r = await t.adminReq('POST', 'convert/all', {});
    const v = await t.adminReq('GET', 'convert');
    const queued = v.items.filter((x) => x.conv.state === 'queued').map((x) => x.name).sort();
    assert.equal(r.queued.length, queued.length);
    assert.ok(queued.includes('Die stille Werft'));
    assert.ok(v.items.filter((x) => x.level !== 'convert').every((x) => x.conv.state === 'none'));
    assert.equal(v.queue.count, queued.length);
    assert.ok(v.queue.minutes > 0);
  } finally { await t.host.close(); }
});

test('trash: the originals with title, restore (Jellyfin reads again, not queued again), delete one, empty', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft', 'Leuchtfeuer', 'Neue Klasse']);
    c.set(at(1, 10, 29));
    const ids = [];
    for (let i = 0; i < 3; i++) {
      await t.host.tick();
      const j = jobs().find((x) => x.state === 'queued');
      ids.push(j.id);
      tc.finish(GW, j.id);
      await tc.report(GW);
    }
    let tr = await t.adminReq('GET', 'convert/trash');
    assert.equal(tr.gateways[0].trash.length, 3);
    assert.equal(tr.gateways[0].trash[0].title.name, 'Die stille Werft');
    const v = await t.adminReq('GET', 'convert');
    assert.equal(v.trash.count, 3);
    assert.ok(v.trash.oldest);
    let r = await t.adminReq('POST', 'convert/trash', { gatewayId: GW, id: ids[0], action: 'restore' });
    assert.equal(r.restored, true);
    assert.equal((await row('Die stille Werft')).conv.state, 'restored');
    assert.ok(t.jelly.state.updated.some((x) => /Die stille Werft/.test(x.path)));
    r = await t.adminReq('POST', 'convert/trash', { gatewayId: GW, id: ids[1], action: 'purge' });
    assert.equal(r.purged, true);
    tr = await t.adminReq('GET', 'convert/trash');
    assert.deepEqual(tr.gateways[0].trash.map((x) => x.id), [ids[2]]);
    await t.adminReq('POST', 'convert/trash', { gatewayId: GW, all: true, action: 'purge' });
    assert.equal(tc.gateway(GW).trash.length, 0);
    // restoring something that is gone: the gateway's reason
    r = await t.adminReq('POST', 'convert/trash', { gatewayId: GW, id: ids[2], action: 'restore' });
    assert.equal(r.code, 'conflict');
    assert.equal(r.reason, 'not_in_trash');
    // a restored file is not part of "Alle über Nacht"
    await t.adminReq('POST', 'convert/all', {});
    assert.equal((await row('Die stille Werft')).conv.state, 'restored');
  } finally { await t.host.close(); }
});

test('settings: window and pause in the plugin, trash days and quality on every gateway', async (tt) => {
  const { t, tc } = await ready(tt);
  try {
    const r = await t.adminReq('PUT', 'convert/settings', { from: 23, to: 5, pauseWatch: true, trashDays: 7, quality: 21 });
    assert.deepEqual(r.settings, { from: 23, to: 5, pauseWatch: true });
    assert.deepEqual(r.failed, []);
    assert.deepEqual([tc.gateway(GW).settings.trashDays, tc.gateway(GW).settings.quality], [7, 21]);
    const v = await t.adminReq('GET', 'convert');
    assert.deepEqual([v.window.from, v.window.to, v.window.minutes, v.settings.trashDays], ['23:00', '05:00', 360, 7]);
    for (const bad of [{ from: 24 }, { from: 3, to: 3 }, { trashDays: 0 }, { quality: 40 }, { pauseWatch: 'ja' }]) {
      assert.equal((await t.adminReq('PUT', 'convert/settings', bad)).code, 'invalid', JSON.stringify(bad));
    }
  } finally { await t.host.close(); }
});

test('morning: one notification to the administrators after the window, only when something happened', async (tt) => {
  const { t, c, tc, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft', 'Leuchtfeuer']);
    c.set(at(6, 30, 28));
    await t.host.tick();
    assert.equal(t.host.notifications.length, 0, 'nothing happened');
    c.set(at(1, 10, 29));
    await t.host.tick();
    tc.finish(GW, jobs()[0].id);
    await tc.report(GW);
    tc.fail(GW, jobs()[0].id, 'encode_failed');
    await tc.report(GW);
    c.set(at(6, 5, 29));
    await t.host.tick();
    const n = t.host.notifications.filter((x) => x.topic === 'convert');
    assert.equal(n.length, 1);
    assert.deepEqual(n[0].users, [MILA.id]);
    assert.equal(n[0].title, 'Videos umwandeln');
    assert.equal(n[0].body, '1 Video umgewandelt · 1 Fehler');
    c.add(3600000);
    await t.host.tick();
    assert.equal(t.host.notifications.filter((x) => x.topic === 'convert').length, 1, 'once a day');
  } finally { await t.host.close(); }
});

test('App API: status with place, start time and percent; "Umwandeln anfragen" puts it on the list only', async (tt) => {
  const { t, c, tc, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft', 'Leuchtfeuer']);
    const a = idOf('Die stille Werft');
    const b = idOf('Leuchtfeuer');
    let r = await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: { items: a + ',' + b } });
    assert.equal(r.available, true);
    assert.deepEqual(r.states[a], { state: 'queued', position: 1, startsAt: new Date(at(1, 0, 29)).toISOString(), percent: null });
    assert.equal(r.states[b].position, 2);
    assert.equal(Date.parse(r.states[b].startsAt), at(1, 0, 29) + 8 * 60000);
    c.set(at(1, 1, 29));
    await t.host.tick();
    tc.job(GW, jobs()[0].id, { state: 'running', percent: 41.6 });
    await tc.report(GW);
    r = await t.appReq(MILA, '11', 'GET', 'convert/status', null, { query: { items: a } });
    assert.deepEqual(r.states[a], { state: 'running', position: null, startsAt: null, percent: 42 });
    // a request from the app: onto the list, not into the queue
    const n = idOf('Neue Klasse');
    const q = await t.appReq(JONAS, '21', 'POST', 'convert/request', { itemId: n });
    assert.equal(q.requested, true);
    assert.equal(q.state, 'none');
    const v = await t.adminReq('GET', 'convert');
    const it = v.items.find((x) => x.id === n);
    assert.ok(it.conv.requested);
    assert.equal(it.conv.state, 'none');
    assert.equal(v.marks.requested, 1);
    // a file without a finding, a bad id
    assert.equal((await t.appReq(JONAS, '21', 'POST', 'convert/request', { itemId: idOf('Ankunft') })).code, 'not_found');
    assert.equal((await t.appReq(JONAS, '21', 'POST', 'convert/request', { itemId: 'x' })).code, 'invalid');
    // without the right "Medien"
    await t.adminReq('PUT', 'rights/user/' + JONAS.id, { media: false });
    assert.equal((await t.appReq(JONAS, '21', 'POST', 'convert/request', { itemId: n })).code, 'no_access');
  } finally { await t.host.close(); }
});

test('a job the gateway lost (e.g. a new service): back into the queue with a new id', async (tt) => {
  const { t, c, tc, row, queue, jobs } = await ready(tt);
  try {
    await queue(['Die stille Werft']);
    c.set(at(1, 10, 29));
    await t.host.tick();
    const first = jobs()[0].id;
    tc.gateway(GW).jobs = [];
    c.add(3 * 60000);
    await tc.report(GW);
    assert.equal((await row('Die stille Werft')).conv.state, 'queued');
    await t.host.tick();
    assert.equal(jobs().length, 1);
    assert.notEqual(jobs()[0].id, first);
  } finally { await t.host.close(); }
});
