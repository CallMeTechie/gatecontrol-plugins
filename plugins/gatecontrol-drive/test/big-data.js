'use strict';

// A Drive as large as a household's after some years, for the tests of the statements the host warned of (1.29.1,
// test/big_speed.test.js): photos over twelve years in my files, the family's and Marc's files (most with a place, a
// content hash and a media id as GateControl gives them), documents with deadlines, a trash, vaults with their
// files, the change log of every node and more, opened files and the stock of the home cache.

const { ANNA, MARC, DAY, MIN } = require('./helpers');

const SIZES = { photos: 50000, docs: 5000, trashed: 2000, vaultFiles: 400, vaults: 3, changes: 200000, deadlines: 300, opens: 300 };
const hex = (n, len) => n.toString(16).padStart(len, '0');
const sha = (i) => hex(i + 1, 16).repeat(4);
const media = (i) => hex(i + 1, 32);

/**
 * → { mine, fam, marcs, folders: [{ id (the month), area, year (its parent) }], vaults, sizes }; `o`: other sizes (SIZES), `now`. Photos of the last 90 days: about
 * every 11th (the newest first in the stock of the home cache).
 */
async function big(host, c, o = {}) {
  const z = { ...SIZES, ...o };
  const db = host.gc.db;
  const now = o.now || Date.now();
  const mine = await c.area(ANNA, 'mine');
  const fam = await c.area(ANNA, 'family');
  const marcs = await c.area(MARC, 'mine');
  const areaList = [mine, fam, mine, marcs, mine];
  const NODE = `INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, sha256, mime, mtime, rev, created_at, created_by, updated_at, updated_by,
    taken_at, content_at, geo_lat, geo_lon, geo_place, deleted_at, deleted_by, trash_id, vault_id, name_cipher, key_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const node = async (n) => Number((await db.run(NODE, [n.area, n.parent, n.name, n.dir ? 1 : 0, n.media || null, n.size || 0, n.sha || null, n.mime || null, n.mtime || null,
    n.at, n.by, n.at, n.by, n.taken || null, n.dir ? null : n.at, n.lat || null, n.lon || null, n.place || null, n.deleted || null, n.deleted ? n.by : null, null,
    n.vault || null, n.vault ? 'c'.repeat(64) : null, n.vault ? 1 : null])).lastInsertRowid);
  let k = 0;
  let seq = 0;
  const log = [];
  await db.exec('BEGIN');
  for (let p = 0; p < 60; p++) {
    await db.run('INSERT INTO geo_places (id, kind, parent, name, region, country, lat, lon, search) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      [1000 + p, 'city', `Ort ${p}`, 'Region', 'DE', 40 + (p % 15), -5 + (p % 25), ` ort ${p} `]);
  }
  // folders: a year and its months in each area
  const folders = [];
  for (let f = 0; f < 150; f++) {
    const area = areaList[f % areaList.length];
    const year = await node({ area: area.id, parent: area.rootId, name: `Jahr ${f}`, dir: true, at: now - f * DAY, by: ANNA.id });
    const month = await node({ area: area.id, parent: year, name: 'Monat', dir: true, at: now - f * DAY, by: ANNA.id });
    folders.push({ id: month, area: area.id, year });
  }
  const files = [];
  for (let i = 0; i < z.photos; i++) {
    const f = folders[i % folders.length];
    // about every 11th of the last 90 days, the others over twelve years
    const t = i % 11 === 0 ? now - (i % 90) * DAY - (i % 1440) * MIN : now - (91 + (i * 7) % 4290) * DAY - (i % 1440) * MIN;
    const id = await node({ area: f.area, parent: f.id, name: `IMG_${i}.jpg`, media: media(k), size: 2000000 + i, sha: sha(k++), mime: i % 40 ? 'image/jpeg' : 'video/mp4',
      mtime: t, at: t, by: i % 3 ? ANNA.id : MARC.id, taken: i % 9 ? t : null, lat: i % 5 ? 50.1 : null, lon: i % 5 ? 7.9 : null, place: i % 5 ? 1000 + (i % 60) : null });
    files.push({ id, area: f.area, at: t });
    if (i % 50 === 0) await db.run('UPDATE nodes SET review_at = ?, review_by = ? WHERE id = ?', [now, ANNA.id, id]);
  }
  const docs = [];
  for (let i = 0; i < z.docs; i++) {
    const f = folders[(i * 7) % folders.length];
    const t = now - (i % 2000) * DAY - i * 1000;
    const id = await node({ area: f.area, parent: f.id, name: `Dokument ${i}.pdf`, media: media(k), size: 90000 + i, sha: sha(k++), mime: i % 6 ? 'application/pdf' : null, mtime: t, at: t, by: ANNA.id });
    files.push({ id, area: f.area, at: t });
    docs.push(id);
  }
  // the trash: files deleted one by one
  for (let i = 0; i < z.trashed; i++) {
    const f = folders[(i * 3) % folders.length];
    const t = now - (i % 25) * DAY;
    const id = await node({ area: f.area, parent: f.id, name: `Alt ${i}.jpg`, media: media(k), size: 1000 + i, sha: sha(k++), mime: 'image/jpeg', mtime: t, at: t, by: ANNA.id, taken: t, deleted: t });
    await db.run('UPDATE nodes SET trash_id = id WHERE id = ?', [id]);
  }
  // vaults: a folder in the top folder of its area and its files (ciphertext, opaque names)
  const vaults = [];
  for (let v = 0; v < z.vaults; v++) {
    const area = [mine, fam, marcs][v % 3];
    const vid = `v${hex(v + 1, 31)}`;
    const top = await node({ area: area.id, parent: area.rootId, name: hex(v + 1, 32), dir: true, at: now, by: ANNA.id, vault: vid });
    await db.run('INSERT INTO vaults (id, node_id, area_id, key_version, recovery_pub, recovery_auth, recovery_by, needs_rotation, created_at, created_by) VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, ?)',
      [vid, top, area.id, 'p'.repeat(43), 'a'.repeat(43), ANNA.id, now, ANNA.id]);
    for (let i = 0; i < z.vaultFiles; i++) {
      await node({ area: area.id, parent: top, name: hex(v * 100000 + i + 16, 32), media: media(k), size: 5000 + i, sha: sha(k++), mime: i % 2 ? 'image/jpeg' : 'application/octet-stream',
        mtime: now - i * MIN, at: now - i * MIN, by: ANNA.id, vault: vid });
    }
    vaults.push({ id: vid, nodeId: top, area: area.id });
  }
  // the change log, in time order (overview.js seqFrom searches it by seq): every file created, then changed again and again
  const span = 400 * DAY;
  for (let i = 0; i < z.changes; i++) {
    const f = files[(i * 13) % files.length];
    log.push(f.area, f.id, i < files.length ? 'create' : 'update', now - span + Math.floor(((i + 1) * span) / z.changes), i % 4 ? MARC.id : ANNA.id);
    if (log.length === 90) { await db.run(`INSERT INTO changes (area_id, node_id, op, at, by) VALUES ${'(?, ?, ?, ?, ?),'.repeat(18).slice(0, -1)}`, log.splice(0)); seq += 18; }
  }
  for (let i = 0; i < log.length; i += 5) { await db.run('INSERT INTO changes (area_id, node_id, op, at, by) VALUES (?, ?, ?, ?, ?)', log.slice(i, i + 5)); seq++; }
  for (let i = 0; i < z.deadlines; i++) {
    const d = new Date(now + ((i % 330) - 20) * DAY).toISOString().slice(0, 10);
    await db.run('INSERT INTO doc_deadlines (node_id, kind, date, label, found_at) VALUES (?, ?, ?, ?, ?)', [docs[(i * 11) % docs.length], 'payment', d, null, now]);
  }
  for (let i = 0; i < z.opens; i++) {
    await db.run('INSERT INTO recent_opens (user_id, node_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [i % 2 ? ANNA.id : MARC.id, docs[(i * 3) % docs.length], now - i * 40 * MIN]);
  }
  await db.exec('COMMIT');
  return { mine, fam, marcs, folders, vaults, sizes: z, changes: seq, nodes: files.length };
}

module.exports = { big, SIZES };
