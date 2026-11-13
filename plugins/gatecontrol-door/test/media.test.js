'use strict';

// Pictures (1.7.2). GateControl's protocol of 12./13. 11.: "DELETE FROM media WHERE expires_at <= ? OR at < ?" among
// the slow statements. media keeps the picture in the row and expires_at behind it, so a statement that takes
// expires_at from the row reads the whole picture. Measured with 3000 pictures of 100–300 kB (a database of 600 MB):
// the hourly clean-up and GET me (the newest picture per camera) each read all of it (147 000 pages), the history
// list the 30 pictures of its page. Now:
//   * the clean-up finds its pictures in the indexes media_expires and media_at (migration 008) and deletes at most
//     a batch per run; what it deletes is what the old statement deleted
//   * GET me, the history list and the newest picture of a camera ask the indexes only — no statement but the one
//     that hands out a picture (and the DELETE of the clean-up) takes anything from a row of media
//   * migration 008 on a database of 1.7.1: every picture and history row stays as it was

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../server/history');
const { iso } = require('../server/util');
const cost = require('../../../tools/testing/sql-cost');
const { withDoor, ringLogin, app, ADMIN, ANNA, SEC, MIN, HOUR, jpeg } = require('./helpers');

const DAY = 24 * HOUR;
const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const EXPIRED = /\(SELECT id FROM media INDEXED BY media_expires WHERE expires_at <= \?(?: ORDER BY expires_at LIMIT \?)?\)/g;
// the one statement that hands out a picture: it reads the row, and that is its job
const PICTURE = /^SELECT id, camera_id, at, mime, size, data FROM media WHERE id = \? AND expires_at > \?$/;

/**
 * The statements of a recording that read a row of media for more than its picture's sake → ['plan ← statement'].
 * Fine: a step along a COVERING INDEX (the table is not touched); a row found by its id in a DELETE (freeing the
 * picture reads it), in PICTURE, or in a statement that names no column behind the picture (expires_at, data, *)
 * outside the list of the expired ones. Everything else walks through pictures: a SCAN of the table, a search by an
 * index that then takes expires_at from the row.
 */
function pictureReads(rec) {
  const out = [];
  for (const s of rec.statements.values()) {
    if (!/\bmedia\b/.test(s.sql) || /^(INSERT|EXPLAIN|BEGIN|COMMIT|ROLLBACK)\b/i.test(s.sql) || PICTURE.test(s.sql)) continue;
    const rest = s.sql.replace(EXPIRED, '()');
    for (const step of s.db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all().map((r) => String(r.detail))) {
      if (!/^(SCAN|SEARCH) (media|m)\b/.test(step) || / COVERING INDEX /.test(step)) continue;
      const byId = / USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(step);
      if (byId && (/^DELETE\b/.test(s.sql) || !/expires_at|\bdata\b|\*/.test(rest))) continue;
      out.push(`${step} ← ${s.sql}`);
    }
  }
  return out;
}

async function linkCameras(admin, lockId) {
  const cams = (await admin('GET', 'status')).json.cameras;
  for (const c of cams) assert.equal((await admin('PATCH', `cameras/${c.id}`, { lockId })).status, 200);
  return cams;
}

/** Pictures straight into the table: rows = [{ cameraId, at, expiresAt, buf }] → their ids. */
async function addPictures(host, rows) {
  const ids = [];
  await host.gc.db.exec('BEGIN');
  for (const r of rows) {
    const x = await host.gc.db.run('INSERT INTO media (camera_id, at, mime, size, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [r.cameraId, r.at, 'image/jpeg', r.buf.length, { b64: r.buf.toString('base64') }, r.expiresAt]);
    ids.push(x.lastInsertRowid);
  }
  await host.gc.db.exec('COMMIT');
  return ids;
}

const mediaIds = async (host) => (await host.gc.db.query('SELECT id FROM media ORDER BY id')).rows.map((r) => r.id);

test('1200 pictures: clean-up, GET me, the history and the newest picture go by the indexes — and give what they gave', () => withDoor({}, async (host, ctx) => {
  const { admin, call, clock, lockId } = ctx;
  await ringLogin(ctx);
  const [bell, garden] = await linkCameras(admin, lockId);
  const now = clock.now();
  // a picture of 8 kB lies on overflow pages like one of 200 kB (a page holds 4 kB)
  const buf = jpeg(640, 360, 8000);
  const rows = [];
  // every 8 minutes over the 7 days of the retention, in turns for both cameras
  for (let i = 0; i < 1200; i++) {
    const at = now - 7 * DAY + i * 8 * MIN + 4 * MIN;
    rows.push({ cameraId: i % 2 ? garden.id : bell.id, at, expiresAt: at + 7 * DAY, buf });
  }
  const regular = await addPictures(host, rows);
  // kept longer once (30 days), the retention is 7 days now: too old, but not expired
  const [tooOld] = await addPictures(host, [{ cameraId: bell.id, at: now - 9 * DAY, expiresAt: now + 21 * DAY, buf }]);
  // the newest of the garden camera by its time, but expired (a retention of an hour, say) and not cleaned up yet
  const [gone] = await addPictures(host, [{ cameraId: garden.id, at: now - 2 * MIN, expiresAt: now - SEC, buf: jpeg(640, 360, 9000) }]);
  const newest = { bell: rows[1198], garden: rows[1199] };
  await host.gc.db.exec('BEGIN');
  const hist = [];
  for (const [mediaId, at] of [[regular[1199], rows[1199].at], [gone, now - 2 * MIN], [regular[0], rows[0].at]]) {
    hist.push((await host.gc.db.run("INSERT INTO history (at, kind, camera_id, media_id) VALUES (?, 'motion', ?, ?)", [at, garden.id, mediaId])).lastInsertRowid);
  }
  await host.gc.db.exec('COMMIT');

  // before the clean-up: the expired picture counts nowhere, though its row is still there
  let me; let items; let snap; let image;
  const views = await cost.record(async () => {
    me = (await call(app(ANNA), 'GET', '/me')).json;
    items = (await call(app(ANNA), 'GET', '/history', null, { kind: 'motion' })).json.items;
    snap = (await call(app(ANNA), 'GET', `/cameras/${garden.id}/snapshot`)).json.snapshot;
    image = (await call(app(ANNA), 'GET', `/events/${hist[0]}`)).json.event.image;
  });
  assert.deepEqual(me.cameras.map((c) => [c.id, c.lastImageAt]).sort((a, b) => a[0] - b[0]), [[bell.id, iso(newest.bell.at)], [garden.id, iso(newest.garden.at)]].sort((a, b) => a[0] - b[0]));
  assert.deepEqual(items.map((x) => [x.id, x.hasImage]).sort((a, b) => a[0] - b[0]), [[hist[0], true], [hist[1], false], [hist[2], true]]);
  assert.deepEqual([snap.at, snap.size], [iso(newest.garden.at), buf.length], 'the newest picture that is still kept');
  assert.equal(image.data, buf.toString('base64'));
  assert.deepEqual(pictureReads(views), [], 'a list reads pictures');
  assert.deepEqual(cost.fullReads(views), [], 'media read as a whole');
  for (const i of ['media_expires', 'media_camera']) assert.ok(cost.indexes(views).includes(i), `no statement goes by ${i} any more`);

  // the hourly clean-up, an hour later: what "expires_at <= now OR at < now - 7 days" names, nothing else
  clock.add(HOUR);
  const then = clock.now();
  const all = [...rows.map((r, i) => ({ ...r, id: regular[i] })), { id: tooOld, at: now - 9 * DAY, expiresAt: now + 21 * DAY }, { id: gone, at: now - 2 * MIN, expiresAt: now - SEC }];
  const keep = all.filter((r) => !(r.expiresAt <= then || r.at < then - 7 * DAY)).map((r) => r.id).sort((a, b) => a - b);
  assert.equal(all.length - keep.length, 10, 'the pictures of the first hour, the too old one and the expired one');
  const purge = await cost.record(() => host.tick());
  assert.equal(purge.count(/^DELETE FROM media\b/), 2);
  assert.deepEqual(await mediaIds(host), keep);
  assert.deepEqual(pictureReads(purge), [], 'the clean-up reads pictures it does not delete');
  assert.deepEqual(cost.fullReads(purge), [], 'media read as a whole');
  for (const i of ['media_expires', 'media_at']) assert.ok(cost.indexes(purge).includes(i), `the clean-up does not go by ${i}`);
  const left = (await host.gc.db.get('SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS bytes, SUM(size) AS sizes FROM media')).row;
  assert.deepEqual([left.n, left.bytes, left.sizes], [keep.length, keep.length * buf.length, keep.length * buf.length], 'the kept pictures are whole');
  // the lists after it
  assert.deepEqual((await call(app(ANNA), 'GET', '/history', null, { kind: 'motion' })).json.items.map((x) => [x.id, x.hasImage]).sort((a, b) => a[0] - b[0]),
    [[hist[0], true], [hist[1], false], [hist[2], false]]);
  assert.equal((await call(app(ADMIN), 'GET', '/me')).status, 200);
}));

test('a backlog (the retention was shortened): a batch per background run, not everything in one statement — and not an hour between them', () => withDoor({}, async (host, ctx) => {
  const { admin, clock, lockId } = ctx;
  await ringLogin(ctx);
  const [bell] = await linkCameras(admin, lockId);
  clock.add(2 * HOUR);
  await host.tick(); // the clean-up of this hour is done
  const now = clock.now();
  const buf = jpeg(640, 360, 5000);
  const n = 2 * history.PURGE_BATCH + 30;
  // older than the new retention of 2 days, none expired by its own date
  const old = await addPictures(host, Array.from({ length: n }, (_, i) => ({ cameraId: bell.id, at: now - 5 * DAY + i * MIN, expiresAt: now + 2 * DAY + i * MIN, buf })));
  const fresh = await addPictures(host, [{ cameraId: bell.id, at: now - HOUR, expiresAt: now + 6 * DAY, buf }]);
  assert.equal((await admin('PUT', 'settings', { mediaDays: 2 })).status, 200);
  clock.add(HOUR);
  const counts = [];
  for (let i = 0; i < 4; i++) {
    await host.tick();
    counts.push((await mediaIds(host)).length);
    clock.add(5 * SEC);
  }
  assert.deepEqual(counts, [n + 1 - history.PURGE_BATCH, n + 1 - 2 * history.PURGE_BATCH, 1, 1], 'the oldest first, a batch per run');
  assert.deepEqual(await mediaIds(host), fresh);
  assert.ok(old.length === n);
  // done: the next clean-up is in an hour again
  const idle = await cost.record(() => host.tick());
  assert.equal(idle.count(/^DELETE FROM media\b/), 0);
}));

test('migration 008 on a database of 1.7.1: pictures and history stay as they were; the clean-up finds its pictures in the indexes', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const files = fs.readdirSync(MIGRATIONS).sort();
  assert.equal(files[files.length - 1], '008_media_at.sql');
  const apply = (f) => db.exec('BEGIN;' + fs.readFileSync(path.join(MIGRATIONS, f), 'utf8') + ';COMMIT;');
  for (const f of files.filter((x) => Number(x.slice(0, 3)) <= 7)) apply(f);
  // what 1.7.1 left: cameras, pictures of 100–300 kB (one without its camera), history rows with and without a picture
  const now = Date.UTC(2026, 10, 13, 8, 0, 0);
  db.prepare("INSERT INTO cameras (ring_id, name, updated_at) VALUES ('111', 'Klingel', ?), ('222', 'Garten', ?)").run(now, now);
  const ins = db.prepare('INSERT INTO media (camera_id, at, mime, size, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const pictures = [];
  for (let i = 0; i < 40; i++) {
    const data = crypto.randomBytes(100000 + i * 5000);
    const at = now - 8 * DAY + i * 5 * HOUR; // the first five are expired (a server that was off for a while)
    const id = Number(ins.run(i === 7 ? null : 1 + (i % 2), at, 'image/jpeg', data.length, data, at + 7 * DAY).lastInsertRowid);
    pictures.push({ id, cameraId: i === 7 ? null : 1 + (i % 2), at, expiresAt: at + 7 * DAY, sha: crypto.createHash('sha256').update(data).digest('hex') });
    db.prepare("INSERT INTO history (at, kind, camera_id, media_id, ext_id) VALUES (?, 'ding', ?, ?, ?)").run(at, 1 + (i % 2), id, 'ring:' + i);
  }
  db.prepare("INSERT INTO history (at, kind, lock_id, user_id, action, result) VALUES (?, 'action', 1, 2, 'unlock', 'ok')").run(now);
  const dump = () => ({
    media: db.prepare('SELECT id, camera_id, at, mime, size, expires_at, data FROM media ORDER BY id').all()
      .map((r) => ({ id: r.id, cameraId: r.camera_id, at: r.at, expiresAt: r.expires_at, sha: crypto.createHash('sha256').update(r.data).digest('hex'), size: r.size, mime: r.mime })),
    history: JSON.stringify(db.prepare('SELECT * FROM history ORDER BY id').all()),
    seq: JSON.stringify(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()),
  });
  const before = dump();
  assert.deepEqual(before.media.map(({ size, mime, ...r }) => r), pictures);
  const oldPlan = cost.plan(db, 'DELETE FROM media WHERE expires_at <= 1 OR at < 1');
  assert.equal(oldPlan, 'SCAN media', 'what 1.7.1 did every hour: through the table, expires_at from behind every picture');

  const sql = fs.readFileSync(path.join(MIGRATIONS, '008_media_at.sql'), 'utf8');
  assert.ok(!/\b(attach|detach|vacuum|pragma|load_extension)\b|_gc_/i.test(sql), 'passes GateControl\'s SQL guard');
  apply('008_media_at.sql');
  assert.deepEqual(dump(), before, 'nothing changed in the rows');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' ORDER BY name").all().map((r) => r.name), ['media_at', 'media_camera', 'media_expires']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media INDEXED BY media_at WHERE at > 0').get().n, 40, 'the index holds the old pictures');

  // the plugin's clean-up on this database (the host's db calls on the same connection)
  const stmts = [];
  const gc = { db: {
    run: async (q, params) => { stmts.push(q); const r = db.prepare(q).run(...params); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    query: async (q, params) => { stmts.push(q); return { rows: db.prepare(q).all(...params) }; },
  } };
  assert.deepEqual([...(await history.existingMedia(gc, pictures.map((p) => p.id), now))].sort((a, b) => a - b), pictures.filter((p) => p.expiresAt > now).map((p) => p.id));
  assert.deepEqual([...(await history.lastMediaAt(gc, now))], [[1, pictures[38].at], [2, pictures[39].at]]);
  for (const q of stmts) assert.doesNotMatch(cost.plan(db, q), /(SCAN|SEARCH) (media|m)\b(?! USING (COVERING INDEX|INTEGER PRIMARY KEY))/, q);
  assert.deepEqual(await history.purge(gc, now, 7), { more: false });
  const mediaStmts = stmts.filter((q) => /^DELETE FROM media/.test(q));
  assert.equal(mediaStmts.length, 2);
  assert.match(cost.plan(db, mediaStmts[0]), /SEARCH media USING INTEGER PRIMARY KEY \(rowid=\?\).*SEARCH media USING COVERING INDEX media_expires \(expires_at<\?\)/);
  assert.match(cost.plan(db, mediaStmts[1]), /SEARCH media USING INTEGER PRIMARY KEY \(rowid=\?\).*SEARCH media USING COVERING INDEX media_at \(at<\?\)/);
  const kept = pictures.filter((p) => p.expiresAt > now && p.at >= now - 7 * DAY);
  assert.equal(kept.length, 35);
  assert.deepEqual(dump().media.map(({ size, mime, ...r }) => r), kept, 'the expired ones are gone, the others whole');
  assert.equal(dump().history, before.history, 'history rows keep their media_id (hasImage turns false)');
  db.close();
});
