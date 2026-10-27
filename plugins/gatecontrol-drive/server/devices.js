'use strict';

// A person's devices (since 1.5.0): the PCs and phones that back up or sync folders with Drive register themselves
// and say which folders they keep where — the portal lists them ("Geräte"), the person can forget one.
//
//   PUT    devices/<id> { name, platform?, version? }   register / update (last seen); → device
//   GET    devices                                       my devices, last seen first
//   PUT    devices/<id>/folders [{ localPath, mode, nodeId, lastBackup }]   (or { folders: […] }) → device
//   DELETE devices/<id>                                  forget the device — its files and folders stay
//
// `id` is the device's own stable id (a–z A–Z 0–9 _ . : -, ≤ 64), per person: another person's device with the same id
// is another device. `name` is unique per person ignoring case: a second "PC" becomes "PC (2)" — so two PCs with the
// same host name never share a folder. Each device has its folder Meine Dateien › Geräte › <name> (made on the first
// PUT; an existing folder of that name nobody else uses is taken over — what an older app made), answered as
// `folder { id, name, path, where }`: the app backs up below that folder. A device renamed: its folder follows when it
// still has the old name. Its folder gone (trash): the next PUT makes it again.
//
// Last seen: every PUT, and every request of the device token that made the last PUT (at most every 10 minutes).
// Only one's own devices: every query is bound to the viewer.

const store = require('./store');
const areas = require('./areas');
const nodes = require('./nodes');
const { fail, posInt, msArg, line, numbered, DEVICE_RE, iso } = require('./util');

const FOLDER = 'Geräte';
const MAX_DEVICES = 50;
const MAX_FOLDERS = 100;
const NAME_MAX = 60;
const PATH_MAX = 1024;
const SEEN_EVERY_MS = 10 * 60000;
const MODES = ['backup', 'sync'];

function idArg(v) {
  if (typeof v !== 'string' || !DEVICE_RE.test(v)) throw fail('invalid', { field: 'id' });
  return v;
}

/** A device name that can be a folder name: what a NAS cannot hold becomes "_", ≤ 60 characters. */
function nameArg(v) {
  const s = (line(v) || '').normalize('NFC').replace(/[<>:"/\\|?*]/g, '_').slice(0, NAME_MAX).replace(/[. ]+$/, '').trim();
  if (!s || s === '.gcdrive' || /^\.+$/.test(s)) throw fail('invalid', { field: 'name' });
  return s;
}

function platformArg(v) {
  if (v == null || v === '') return null;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{1,32}$/.test(s)) throw fail('invalid', { field: 'platform' });
  return s;
}

function versionArg(v) {
  if (v == null || v === '') return null;
  const s = line(v);
  if (!s || s.length > 40) throw fail('invalid', { field: 'version' });
  return s;
}

/** The folder list of PUT devices/<id>/folders → [{ localPath, mode, nodeId, lastBackup (ms) }], else fail('invalid'). */
function foldersArg(body) {
  const list = Array.isArray(body) ? body : (body && Array.isArray(body.folders) ? body.folders : null);
  if (!list || list.length > MAX_FOLDERS) throw fail('invalid', { field: 'folders' });
  return list.map((f, i) => {
    const bad = (k) => fail('invalid', { field: `folders[${i}].${k}` });
    if (!f || typeof f !== 'object') throw fail('invalid', { field: `folders[${i}]` });
    const localPath = typeof f.localPath === 'string' ? f.localPath.replace(/[\0-\x1f\x7f]/g, '').trim() : '';
    if (!localPath || localPath.length > PATH_MAX) throw bad('localPath');
    if (!MODES.includes(f.mode)) throw bad('mode');
    const nodeId = f.nodeId == null ? null : posInt(f.nodeId);
    if (f.nodeId != null && !nodeId) throw bad('nodeId');
    const lastBackup = msArg(f.lastBackup);
    if (Number.isNaN(lastBackup)) throw bad('lastBackup');
    return { localPath, mode: f.mode, nodeId, lastBackup };
  });
}

const parse = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

async function rowOf(gc, uid, id) {
  return store.one(gc, 'SELECT * FROM user_devices WHERE user_id = ? AND id = ?', [uid, id]);
}

/** A node the viewer reads, as a device folder shows it → { id, name, areaId, path, where } or null. */
async function placeOf(ctx, id) {
  if (!id) return null;
  try {
    const { node, area } = await nodes.reach(ctx, id);
    const p = await nodes.pathOf(ctx.gc, node);
    return { id: node.id, name: node.name, areaId: node.area_id, path: p, where: [ctx.areaLabel(area), ...(p ? p.split('/') : [])].join(' › ') };
  } catch { return null; }
}

/** A device as its person sees it. */
async function view(ctx, r) {
  const folders = [];
  for (const f of parse(r.folders)) {
    folders.push({ localPath: f.localPath, mode: f.mode, nodeId: f.nodeId || null, lastBackup: iso(f.lastBackup), node: await placeOf(ctx, f.nodeId) });
  }
  return {
    id: r.id, name: r.name, platform: r.platform || null, version: r.version || null,
    firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen), current: !!ctx.deviceId && r.token_device === ctx.deviceId,
    folder: await placeOf(ctx, r.folder_id), folders,
  };
}

/** `wanted`, or "wanted (2)", … — the first name none of the viewer's other devices has (ignoring case). */
async function freeName(ctx, wanted, id) {
  for (let i = 1; i < 1000; i++) {
    const c = i === 1 ? wanted : numbered(wanted, i);
    if (!await store.one(ctx.gc, 'SELECT 1 AS x FROM user_devices WHERE user_id = ? AND id <> ? AND name = ? COLLATE NOCASE', [ctx.viewer, id, c])) return c;
  }
  throw fail('exists');
}

/**
 * Inside a transaction: the folder Meine Dateien › Geräte › <name> of device `id` — an existing folder of that name no
 * other device of the viewer uses is taken over, else a new one (a free name when the name is taken) → its row.
 */
async function makeFolder(ctx, area, name, id) {
  const gc = ctx.gc;
  let top = await nodes.taken(gc, area.id, area.root_id, FOLDER);
  if (top && top.is_dir !== 1) throw fail('exists');
  if (!top) top = await nodes.insertFolder(ctx, area.id, area.root_id, FOLDER);
  const there = await nodes.taken(gc, area.id, top.id, name);
  if (there && there.is_dir === 1 && !await store.one(gc, 'SELECT 1 AS x FROM user_devices WHERE user_id = ? AND folder_id = ? AND id <> ?', [ctx.viewer, there.id, id])) {
    // in use again: a mark ("deleted on the device") ends
    await nodes.unmarkUp(gc, there.id, ctx);
    return there;
  }
  const free = there ? await nodes.freeName(gc, area.id, top.id, name) : name;
  return nodes.insertFolder(ctx, area.id, top.id, free);
}

/** PUT devices/<id> → { device } */
async function put(ctx, rawId, body) {
  const id = idArg(rawId);
  const b = body && typeof body === 'object' ? body : {};
  const wanted = nameArg(b.name);
  const platform = platformArg(b.platform);
  const version = versionArg(b.version);
  const mine = await areas.roleIn(ctx, areas.idOf.mine(ctx.viewer), 'write');
  let rename = null;
  await store.tx(ctx.gc, async () => {
    const cur = await rowOf(ctx.gc, ctx.viewer, id);
    if (!cur) {
      const n = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', [ctx.viewer]);
      if (n.n >= MAX_DEVICES) throw fail('device_limit', { max: MAX_DEVICES });
    }
    const name = cur && cur.wanted === wanted ? cur.name : await freeName(ctx, wanted, id);
    let folder = cur && cur.folder_id ? await nodes.row(ctx.gc, cur.folder_id) : null;
    if (folder && (folder.deleted_at != null || folder.is_dir !== 1 || folder.area_id !== mine.area.id)) folder = null;
    if (!folder) folder = await makeFolder(ctx, mine.area, name, id);
    else if (cur && folder.name !== name && folder.name === cur.name) rename = { id: folder.id, name };
    await store.run(ctx.gc, `INSERT INTO user_devices (user_id, id, name, wanted, platform, version, token_device, folder_id, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, wanted = excluded.wanted, platform = COALESCE(excluded.platform, user_devices.platform),
        version = COALESCE(excluded.version, user_devices.version), token_device = COALESCE(excluded.token_device, user_devices.token_device),
        folder_id = excluded.folder_id, last_seen = excluded.last_seen`,
    [ctx.viewer, id, name, wanted, platform, version, ctx.deviceId || null, folder.id, ctx.now, ctx.now]);
  });
  // the device was renamed: its folder follows (best effort — a name taken in Geräte keeps the old one)
  if (rename) {
    try { await nodes.update(ctx, rename.id, { name: rename.name }); } catch (e) { if (!e || !e.code) throw e; }
  }
  return { device: await view(ctx, await rowOf(ctx.gc, ctx.viewer, id)) };
}

/** GET devices → { devices } (last seen first). */
async function list(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_seen DESC, id', [ctx.viewer]);
  const out = [];
  for (const r of rows) out.push(await view(ctx, r));
  return { devices: out };
}

/** PUT devices/<id>/folders → { device }; an unknown device: not_found (PUT devices/<id> first). */
async function setFolders(ctx, rawId, body) {
  const id = idArg(rawId);
  const folders = foldersArg(body);
  const r = await store.run(ctx.gc, 'UPDATE user_devices SET folders = ?, last_seen = ? WHERE user_id = ? AND id = ?', [JSON.stringify(folders), ctx.now, ctx.viewer, id]);
  if (!r || !r.changes) throw fail('not_found');
  return { device: await view(ctx, await rowOf(ctx.gc, ctx.viewer, id)) };
}

/** DELETE devices/<id> → { id, removed } — forgets the device; no file or folder goes. */
async function remove(ctx, rawId) {
  const id = idArg(rawId);
  const r = await store.run(ctx.gc, 'DELETE FROM user_devices WHERE user_id = ? AND id = ?', [ctx.viewer, id]);
  return { id, removed: !!(r && r.changes) };
}

/** A request of device token `device`: the registered device it belongs to was seen (at most every 10 minutes). */
async function seen(gc, userId, device, now) {
  if (!device) return;
  await store.run(gc, 'UPDATE user_devices SET last_seen = ? WHERE user_id = ? AND token_device = ? AND last_seen <= ?', [now, userId, device, now - SEEN_EVERY_MS]);
}

module.exports = { put, list, setFolders, remove, seen, FOLDER, MAX_DEVICES, MAX_FOLDERS };
