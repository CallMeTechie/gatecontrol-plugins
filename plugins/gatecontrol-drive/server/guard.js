'use strict';

// Protection against ransomware ("Schutz vor Erpressungstrojanern", since 1.6.0). A PC that syncs or backs up folders
// with Drive and is hit by ransomware sends what the malware does: files overwritten with encrypted bytes, renamed to
// "Brief.pdf.locked", encrypted copies made and the originals deleted. Drive watches each device and stops it.
//
// The journal (guard_log): every change of an app request (a device: user.device of the token, permissions.devices) —
//   create     a new file (uploads/commit)
//   overwrite  a new version of an existing file (uploads/commit); version_id: the version holding the bytes before
//   rename     a rename or a move (PATCH nodes/<id>); old_name / parent_id: where it was before
//   delete     into the trash now (DELETE nodes/<id>)
//   mark       into the trash later (DELETE nodes/<id>?after=, PATCH { deleteAt } — what a backup app sends for a file
//              deleted on the PC, marks.js): it counts like a delete
// with the signs of an attack (flags):
//   ext        a known ransomware ending ("x.pdf.locked", ".wncry", …), an ending turned into an unknown or random one
//              ("Brief.pdf" → "Brief.pdf.a8f3k2", "Brief.pdf.id-1234.eking"), an unknown ending added to a known one
//   entropy    the device says the bytes look random (uploads/commit { entropy }, 0–8 bits per byte): ≥ 7.5 for a type
//              that is never that dense (text, CSV, HTML, BMP, WAV …) or a file that was clearly below before
//   swap       a file deleted shortly after the same device made a file of the same name with an ending added or
//              changed (the encrypted copy) in the same folder
// GateControl stores media sealed: the plugin cannot read bytes, so "magic bytes" are the device's to check — its
// `entropy` hint is the one the server takes.
//
// Suspicious (checked after each request that wrote to the journal): within guard_minutes (10) the device changed
// existing files (overwrite, rename, delete — new files never count: a photo upload is no attack)
//   ≥ guard_files (50) of them, or ≥ guard_percent (20) % of an area that has ≥ 20 files (and at least 5 of them),
// and at least half of them — or guard_files of them — carry a sign.
//
// Then: an incident; the device is locked — its writing requests answer 423 { code: 'device_locked', incident }, it
// may still read; the person and the administrators are told (topic guard) with a direct link; the live event
// 'guard' { incident } goes to them. GET me has guard { locked, incident } for the asking device and incidents (the
// person's open ones).
//   POST guard/incidents/<id>/release   a false alarm: the device may write again
//   POST guard/incidents/<id>/undo      every file of the incident as it was before: overwritten files get the version
//                                       before back, renamed ones their name and folder, deleted ones come out of the
//                                       trash, marks end, files the incident made go into the trash — then released
// Both by the person or an administrator, both idempotent. The undo runs as the person (their rights, their name in
// the change log), never as the locked device, and is not itself watched.

const store = require('./store');
const { fail, iso } = require('./util');
const { t } = require('./text');

const DAY = 86400000;
const AREA_MIN_FILES = 20;
const AREA_MIN_TOUCHED = 5;
const ENTROPY_HIGH = 7.5;
const ENTROPY_LOW_BEFORE = 7.0;
const SAMPLE = 5;
const INCIDENTS_ME = 20;
const ENTRIES_MAX = 500;
const KEEP_CLOSED_DAYS = 30;

// endings ransomware families leave (a selection of the well-known ones; lower case, without the dot)
const RANSOM_EXT = new Set([
  'locked', 'lock', 'locky', 'encrypted', 'enc', 'encrypt', 'crypt', 'crypted', 'cry', 'crypto', 'cryptolocker', 'crypz', 'cryp1',
  'cerber', 'cerber2', 'cerber3', 'zepto', 'odin', 'thor', 'aesir', 'osiris', 'wnry', 'wncry', 'wcry', 'wncryt', 'wannacry',
  'onion', 'zzzzz', 'xxx', 'ttt', 'vvv', 'ecc', 'ezz', 'exx', 'zzz', 'aaa', 'abc', 'xyz', 'r5a', 'rrk', 'ryk', 'ryuk',
  'conti', 'lockbit', 'lockbit3', 'djvu', 'djvuu', 'nooa', 'kraken', 'darkness', 'hive', 'sodinokibi', 'revil', 'maze',
  'egregor', 'petya', 'dharma', 'phobos', 'makop', 'mallox', 'babuk', 'blackcat', 'clop', 'cl0p', 'ragnar', 'ragnarok',
  'ransom', 'paym', 'payms', 'paymst', 'kkk', 'btc', 'gws', 'bip', 'cbf', 'combo', 'adobe', 'gamma', 'heets', 'karma',
  'akira', 'royal', 'blackbasta', 'basta', 'medusa', 'play', 'rhysida', 'cuba', 'avos', 'avoslocker', 'nefilim', 'hello',
]);

// endings people's files have — an ending outside this list that looks random is a sign
const KNOWN_EXT = new Set([
  'txt', 'md', 'rtf', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'html', 'htm', 'css', 'js',
  'ts', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'svg', 'tex', 'bib',
  'pdf', 'doc', 'docx', 'dot', 'dotx', 'odt', 'ott', 'xls', 'xlsx', 'xlsm', 'ods', 'ppt', 'pptx', 'odp', 'pages', 'numbers', 'key',
  'epub', 'mobi', 'azw3', 'vcf', 'ics', 'eml', 'msg', 'pst', 'one', 'vsdx', 'pub', 'xps', 'oxps',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif', 'avif', 'raw', 'dng', 'cr2', 'cr3', 'nef', 'arw',
  'orf', 'rw2', 'psd', 'xcf', 'ai', 'eps', 'ico', 'jxl',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'mid', 'midi',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'mpg', 'mpeg', 'mts', 'm2ts', '3gp', 'srt', 'vtt',
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'img', 'dmg', 'cab',
  'exe', 'msi', 'dll', 'apk', 'appx', 'deb', 'rpm', 'jar', 'bin', 'dat', 'db', 'sqlite', 'mdb', 'accdb', 'bak', 'old', 'tmp',
  'kdbx', 'gpx', 'kml', 'kmz', 'stl', 'obj', 'blend', 'dwg', 'dxf', 'skp', 'ttf', 'otf', 'woff', 'woff2', 'torrent', 'url', 'lnk',
  'part', 'crdownload', 'download', 'swp', 'gpg', 'pgp', 'asc', 'sig', 'p7m', 'p12', 'pfx', 'pem', 'crt', 'cer', 'der', 'ovpn',
]);

// types that are never as dense as random bytes (a high entropy there: encrypted) — not the ones that may hold
// compressed parts (doc/xls/ppt with pictures, tif/psd compressed, dwg, binary stl): only a jump counts there
const LOW_ENTROPY_EXT = new Set([
  'txt', 'md', 'rtf', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'html', 'htm', 'css', 'js',
  'ts', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'svg', 'tex', 'bib', 'vcf', 'ics',
  'eml', 'bmp', 'wav', 'aiff', 'dxf', 'obj',
]);

/** The ending of a name (lower case, without the dot), '' without one. */
function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 && i < s.length - 1 ? s.slice(i + 1).toLowerCase() : '';
}
/** The name without its last ending. */
function baseOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

/** An ending nobody's files have: not a known one, and random-looking (letters and digits mixed, or long). */
function randomExt(ext) {
  if (!ext || KNOWN_EXT.has(ext)) return false;
  if (ext.length >= 6) return true;
  return ext.length >= 4 && /[a-z]/.test(ext) && /\d/.test(ext);
}

/** The sign `ext` of a file now called `name` (before: `before`, null for a new file). */
function extSign(name, before) {
  const ext = extOf(name);
  if (!ext) return false;
  if (RANSOM_EXT.has(ext)) return true;
  const prev = before == null ? null : extOf(before);
  if (before != null && prev === ext) return false;
  // "Brief.pdf" → "Brief.pdf.xyz", "Brief.pdf.id-1234.eking" (or such a new file): an unknown ending after a known one
  const inner = String(name).split('.').slice(1, -1).map((x) => x.toLowerCase());
  // ("app.log.1", a rotated log: a number is no ending of ransomware)
  if (!KNOWN_EXT.has(ext) && !/^\d{1,3}$/.test(ext) && inner.some((x) => KNOWN_EXT.has(x))) return true;
  return randomExt(ext);
}

/** The sign `entropy`: the device's hint (0–8) for a type that is never that dense, or a file that was clearly below. */
function entropySign(name, entropy, before) {
  if (entropy == null || entropy < ENTROPY_HIGH) return false;
  if (LOW_ENTROPY_EXT.has(extOf(name))) return true;
  return before != null && before < ENTROPY_LOW_BEFORE;
}

/** `entropy` of uploads/commit: a number 0–8 (or a decimal string), null when absent, else invalid. */
function entropyArg(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < 0 || n > 8) throw fail('invalid', { field: 'entropy' });
  return Math.round(n * 1000) / 1000;
}

/** Is the request's device watched? An app request with its device (never the portal, a service, the background). */
const watched = (ctx) => !!(ctx && ctx.guardOn && ctx.app && ctx.deviceId && !ctx.guardSkip);

/**
 * Inside the change's transaction: one row of the journal. e = { op, node, name, oldName?, parentId?, versionId?,
 * entropy?, entropyBefore? } (node: the row as it is after the change, or before for a delete).
 */
async function note(ctx, e) {
  if (!watched(ctx)) return;
  const flags = [];
  if (e.op === 'create' && extSign(e.name, null)) flags.push('ext');
  if (e.op === 'rename' && e.oldName !== e.name && extSign(e.name, e.oldName)) flags.push('ext');
  if ((e.op === 'create' || e.op === 'overwrite') && entropySign(e.name, e.entropy, e.entropyBefore)) flags.push('entropy');
  if ((e.op === 'delete' || e.op === 'mark') && e.node.is_dir !== 1 && await swapSign(ctx, e)) flags.push('swap');
  await store.run(ctx.gc, `INSERT INTO guard_log (user_id, device, at, op, node_id, area_id, parent_id, name, old_name, version_id, flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ctx.viewer, ctx.deviceId, ctx.now, e.op, e.node.id, e.node.area_id, e.parentId == null ? e.node.parent_id : e.parentId,
    e.name, e.oldName == null ? null : e.oldName, e.versionId == null ? null : e.versionId, flags.length ? flags.join(',') : null]);
  ctx.guardNoted = true;
}

/** A file deleted after the same device made "Name.ext.xyz" or "Name.other" (with a sign) in its folder. */
async function swapSign(ctx, e) {
  const rows = await store.all(ctx.gc, `SELECT name, flags FROM guard_log WHERE user_id = ? AND device = ? AND at >= ? AND op = 'create'
    AND parent_id = ? AND incident_id IS NULL LIMIT 2000`, [ctx.viewer, ctx.deviceId, ctx.now - windowMs(ctx.settings), e.node.parent_id]);
  const name = String(e.node.name);
  const low = name.toLowerCase();
  const base = baseOf(name).toLowerCase();
  const ext = extOf(name);
  return rows.some((r) => {
    const n = String(r.name).toLowerCase();
    if (n.startsWith(low + '.')) return true;
    return baseOf(n) === base && extOf(n) !== ext && (!!r.flags || randomExt(extOf(n)));
  });
}

const windowMs = (s) => Math.max(1, Number(s && s.guardMinutes) || 10) * 60000;

/** The device's open incident (it is locked), or null. */
async function openOf(gc, uid, device) {
  if (!device) return null;
  return store.one(gc, "SELECT * FROM guard_incidents WHERE user_id = ? AND device = ? AND state = 'open' ORDER BY id DESC LIMIT 1", [uid, device]);
}

/** Is the request's device locked? → its open incident, or null (protection off: never). */
async function lockOf(ctx) {
  if (!ctx.guardOn || !ctx.app || !ctx.deviceId) return null;
  return openOf(ctx.gc, ctx.viewer, ctx.deviceId);
}

/** Requests a locked device may still make: reading, and what changes no file (check, wipes done, its registration). */
function writes(method, seg) {
  if (method === 'GET' || method === 'HEAD') return false;
  const [a, b] = seg;
  if (a === 'guard' || a === 'wipes' || a === 'devices') return false;
  if (a === 'uploads' && b === 'check') return false;
  return true;
}

/** The name of device `device` of person `uid` as they know it (devices.js), else null. */
async function deviceName(gc, uid, device) {
  const r = await store.one(gc, 'SELECT name FROM user_devices WHERE user_id = ? AND token_device = ? ORDER BY last_seen DESC LIMIT 1', [uid, device]);
  return r ? r.name : null;
}

/**
 * After a request that wrote to the journal: is the device's recent work suspicious? Then the incident (its rows of
 * the window belong to it) → the incident row, else null.
 */
async function check(ctx) {
  if (!watched(ctx) || !ctx.guardNoted) return null;
  const gc = ctx.gc;
  const s = ctx.settings;
  const since = ctx.now - windowMs(s);
  if (await openOf(gc, ctx.viewer, ctx.deviceId)) return null;
  const rows = await store.all(gc, `SELECT node_id, area_id, op, flags FROM guard_log WHERE user_id = ? AND device = ? AND at >= ? AND incident_id IS NULL
    AND op IN ('overwrite', 'rename', 'delete', 'mark')`, [ctx.viewer, ctx.deviceId, since]);
  if (!rows.length) return null;
  const nodesTouched = new Map(); // node → { area, flagged }
  for (const r of rows) {
    const cur = nodesTouched.get(r.node_id) || { area: r.area_id, flagged: false, deleted: false };
    if (r.flags) cur.flagged = true;
    if (r.op === 'delete') cur.deleted = true;
    nodesTouched.set(r.node_id, cur);
  }
  const touched = nodesTouched.size;
  const flagged = [...nodesTouched.values()].filter((x) => x.flagged).length;
  const files = Math.max(1, Number(s.guardFiles) || 50);
  if (flagged < Math.min(files, Math.ceil(touched / 2)) || !flagged) return null;
  let volume = touched >= files;
  if (!volume) {
    const byArea = new Map();
    for (const x of nodesTouched.values()) {
      const a = byArea.get(x.area) || { n: 0, deleted: 0 };
      a.n++;
      if (x.deleted) a.deleted++;
      byArea.set(x.area, a);
    }
    for (const [area, a] of byArea) {
      if (a.n < AREA_MIN_TOUCHED) continue;
      const live = await store.one(gc, 'SELECT COUNT(*) AS n FROM nodes WHERE area_id = ? AND is_dir = 0 AND deleted_at IS NULL', [area]);
      const total = live.n + a.deleted;
      if (total >= AREA_MIN_FILES && a.n * 100 >= (Number(s.guardPercent) || 20) * total) { volume = true; break; }
    }
  }
  if (!volume) return null;
  return open(ctx, since);
}

/** The incident of the device's window: the journal's rows of the window join it. */
async function open(ctx, since) {
  const gc = ctx.gc;
  const name = await deviceName(gc, ctx.viewer, ctx.deviceId);
  return store.tx(gc, async () => {
    if (await openOf(gc, ctx.viewer, ctx.deviceId)) return null;
    const all = await store.all(gc, `SELECT node_id, op, name, flags FROM guard_log WHERE user_id = ? AND device = ? AND at >= ? AND incident_id IS NULL ORDER BY id`,
      [ctx.viewer, ctx.deviceId, since]);
    const files = new Set(all.map((r) => r.node_id)).size;
    // a sample: the names with a sign first (the latest name of each file)
    const last = new Map();
    for (const r of all) last.set(r.node_id, r);
    const ordered = [...last.values()].sort((a, b) => (b.flags ? 1 : 0) - (a.flags ? 1 : 0));
    const sample = ordered.slice(0, SAMPLE).map((r) => r.name);
    const reasons = [...new Set(all.flatMap((r) => (r.flags ? r.flags.split(',') : [])))];
    const r = await store.run(gc, `INSERT INTO guard_incidents (user_id, device, device_name, at, since, files, reasons, sample, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`, [ctx.viewer, ctx.deviceId, name, ctx.now, since, files, JSON.stringify(reasons), JSON.stringify(sample)]);
    const id = Number(r.lastInsertRowid);
    await store.run(gc, 'UPDATE guard_log SET incident_id = ? WHERE user_id = ? AND device = ? AND at >= ? AND incident_id IS NULL', [id, ctx.viewer, ctx.deviceId, since]);
    return store.one(gc, 'SELECT * FROM guard_incidents WHERE id = ?', [id]);
  });
}

const parse = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** An incident as the person (and an administrator) sees it. */
function view(r, users) {
  const u = users && users.get(r.user_id);
  return {
    id: r.id, at: iso(r.at), device: r.device, deviceName: r.device_name || null, files: r.files, sample: parse(r.sample),
    user: r.user_id, userName: u ? u.name : null, state: r.state, locked: r.state === 'open', reasons: parse(r.reasons), since: iso(r.since),
    endedAt: iso(r.ended_at), endedBy: r.ended_by == null ? null : r.ended_by,
    ...(r.state === 'undone' ? { undoneAt: iso(r.undone_at), undoneBy: r.undone_by, restored: r.restored || 0, trashed: r.trashed || 0, failed: r.failed || 0 } : {}),
  };
}

/** GET me: guard { locked, incident } of the asking device, incidents (the person's open ones, ≤ 20). */
async function meOf(ctx) {
  const inc = ctx.app && ctx.deviceId ? await openOf(ctx.gc, ctx.viewer, ctx.deviceId) : null;
  const open = await store.all(ctx.gc, "SELECT * FROM guard_incidents WHERE user_id = ? AND state = 'open' ORDER BY id DESC LIMIT ?", [ctx.viewer, INCIDENTS_ME]);
  return {
    guard: { on: !!ctx.guardOn, locked: !!(inc && ctx.guardOn), incident: inc ? view(inc, ctx.users) : null },
    incidents: open.map((r) => view(r, ctx.users)),
  };
}

const isAdmin = (ctx) => !!(ctx.user && ctx.user.role === 'admin');

/** An incident the viewer may handle (their own; an administrator: any) → its row, else not_found. */
async function mine(ctx, id) {
  const n = Number(id);
  const r = Number.isSafeInteger(n) && n > 0 ? await store.one(ctx.gc, 'SELECT * FROM guard_incidents WHERE id = ?', [n]) : null;
  if (!r || (r.user_id !== ctx.viewer && !isAdmin(ctx))) throw fail('not_found');
  return r;
}

/** GET guard/incidents[?all=1] → { incidents } — mine (open first, then the last 50); an administrator with all=1: everyone's. */
async function list(ctx, q) {
  const all = q && ['1', 'true'].includes(String(q.all)) && isAdmin(ctx);
  const rows = all
    ? await store.all(ctx.gc, "SELECT * FROM guard_incidents ORDER BY state = 'open' DESC, id DESC LIMIT 200")
    : await store.all(ctx.gc, "SELECT * FROM guard_incidents WHERE user_id = ? ORDER BY state = 'open' DESC, id DESC LIMIT 50", [ctx.viewer]);
  return { incidents: rows.map((r) => view(r, ctx.users)), admin: isAdmin(ctx) };
}

/** GET guard/incidents/<id> → { incident, entries: [{ op, name, oldName, nodeId, at, flags }] } (≤ 500). */
async function get(ctx, id) {
  const r = await mine(ctx, id);
  const rows = await store.all(ctx.gc, 'SELECT * FROM guard_log WHERE incident_id = ? ORDER BY id LIMIT ?', [r.id, ENTRIES_MAX]);
  return {
    incident: view(r, ctx.users),
    entries: rows.map((e) => ({ op: e.op, name: e.name, oldName: e.old_name || null, nodeId: e.node_id, at: iso(e.at), flags: e.flags ? e.flags.split(',') : [] })),
  };
}

/** POST guard/incidents/<id>/release → { incident, restored: 0, trashed: 0 } (the device may write again). */
async function release(ctx, id) {
  const r = await mine(ctx, id);
  if (r.state === 'open') {
    await store.run(ctx.gc, "UPDATE guard_incidents SET state = 'released', ended_at = ?, ended_by = ? WHERE id = ? AND state = 'open'", [ctx.now, ctx.viewer, r.id]);
    (ctx.guardEvents || (ctx.guardEvents = [])).push(r.id);
  }
  const now = await store.one(ctx.gc, 'SELECT * FROM guard_incidents WHERE id = ?', [r.id]);
  return { incident: view(now, ctx.users), restored: now.state === 'undone' ? now.restored || 0 : 0, trashed: now.state === 'undone' ? now.trashed || 0 : 0 };
}

/**
 * POST guard/incidents/<id>/undo → { incident, restored, trashed, failed }: every file of the incident as it was
 * before, then released. `asOwner()` → the context of the incident's person (the undo runs with their rights).
 * Done before: the same answer again.
 */
async function undo(ctx, id, asOwner) {
  const r = await mine(ctx, id);
  if (r.state === 'undone') return { incident: view(r, ctx.users), restored: r.restored || 0, trashed: r.trashed || 0, failed: r.failed || 0 };
  const octx = await asOwner(r.user_id);
  octx.guardSkip = true;
  const out = await restoreAll(octx, r.id);
  await store.run(ctx.gc, `UPDATE guard_incidents SET state = 'undone', ended_at = COALESCE(ended_at, ?), ended_by = COALESCE(ended_by, ?), undone_at = ?, undone_by = ?,
    restored = ?, trashed = ?, failed = ? WHERE id = ?`, [ctx.now, ctx.viewer, ctx.now, ctx.viewer, out.restored, out.trashed, out.failed, r.id]);
  (ctx.guardEvents || (ctx.guardEvents = [])).push(r.id);
  const now = await store.one(ctx.gc, 'SELECT * FROM guard_incidents WHERE id = ?', [r.id]);
  return { incident: view(now, ctx.users), ...out, octx };
}

/** Every node of incident `id` back to how it was before (best effort per node) → { restored, trashed, failed }. */
async function restoreAll(octx, id) {
  const nodes = require('./nodes');
  const files = require('./files');
  const marks = require('./marks');
  const gc = octx.gc;
  const rows = await store.all(gc, 'SELECT * FROM guard_log WHERE incident_id = ? ORDER BY id', [id]);
  const byNode = new Map();
  for (const e of rows) {
    if (!byNode.has(e.node_id)) byNode.set(e.node_id, []);
    byNode.get(e.node_id).push(e);
  }
  let restored = 0;
  let trashed = 0;
  let failed = 0;
  const tolerate = (e) => { if (!e || !e.code) throw e; };
  // 1. what the incident made goes into the trash (frees the names of the originals)
  for (const [nodeId, list] of byNode) {
    if (list[0].op !== 'create') continue;
    const n = await nodes.row(gc, nodeId);
    if (!n || n.deleted_at != null || n.parent_id == null) continue;
    try { await nodes.trash(octx, nodeId); trashed++; } catch (e) { tolerate(e); failed++; }
  }
  // 2. the files that were there before: out of the trash, the bytes before, the name and folder before
  for (const [nodeId, list] of byNode) {
    if (list[0].op === 'create') continue;
    let did = false;
    let lost = false;
    try {
      let n = await nodes.row(gc, nodeId);
      if (!n) { failed++; continue; }
      if (n.deleted_at != null && list.some((e) => e.op === 'delete' || e.op === 'mark')) {
        const top = n.trash_id != null ? await nodes.row(gc, n.trash_id) : null;
        if (top && top.trash_id === top.id) { await nodes.restore(octx, top.id); did = true; }
        n = await nodes.row(gc, nodeId);
      }
      if (n.deleted_at != null) { failed++; continue; }
      // a mark of the incident ends: the file stays
      if (n.delete_at != null && list.some((e) => e.op === 'mark')) {
        await marks.set(octx, nodeId, { deleteAt: null });
        did = true;
      }
      const over = list.find((e) => e.op === 'overwrite' && e.version_id != null);
      if (over) {
        // the version before is gone (removed by hand): the name and folder still come back
        if (!await store.one(gc, 'SELECT id FROM versions WHERE id = ? AND node_id = ?', [over.version_id, nodeId])) lost = true;
        else {
          await files.restoreVersion(octx, nodeId, over.version_id);
          did = true;
        }
      }
      const ren = list.find((e) => e.op === 'rename');
      if (ren) {
        n = await nodes.row(gc, nodeId);
        const parent = ren.parent_id != null ? await nodes.row(gc, ren.parent_id) : null;
        const toParent = parent && parent.deleted_at == null ? parent.id : n.parent_id;
        const toName = ren.old_name || n.name;
        if (toParent !== n.parent_id || toName !== n.name) {
          const free = await nodes.freeName(gc, (parent && parent.deleted_at == null ? parent : n).area_id, toParent, toName, n.id);
          await nodes.update(octx, nodeId, { name: free, ...(toParent !== n.parent_id ? { parentId: toParent } : {}) });
          did = true;
        }
      }
      if (lost) failed++;
      else if (did) restored++;
    } catch (e) { tolerate(e); failed++; }
  }
  return { restored, trashed, failed };
}

/**
 * After the answer: the person and the administrators hear of a new incident (topic guard, with the direct link), the
 * live event 'guard' { incident } goes to them — also after a release or an undo.
 */
async function announce(gc, ctx, link) {
  const ids = [...new Set([...(ctx.guardIncident ? [ctx.guardIncident.id] : []), ...(ctx.guardEvents || [])])];
  if (!ids.length) return;
  const admins = [...ctx.users.values()].filter((u) => u.role === 'admin').map((u) => u.id);
  for (const id of ids) {
    const r = await store.one(gc, 'SELECT * FROM guard_incidents WHERE id = ?', [id]);
    if (!r) continue;
    const v = view(r, ctx.users);
    const users = [...new Set([r.user_id, ...admins])].slice(0, 500);
    if (typeof (gc.events && gc.events.emit) === 'function') {
      try { await gc.events.emit({ users, type: 'guard', data: { incident: v } }); } catch (e) { gc.log.warn('guard event failed', (e && e.code) || 'error'); }
    }
    if (!ctx.guardIncident || ctx.guardIncident.id !== id) continue;
    const owner = ctx.users.get(r.user_id);
    const device = r.device_name || r.device;
    const sample = v.sample.slice(0, 3).join(', ');
    for (const lang of ['de', 'en']) {
      const langOf = (uid) => ((ctx.users.get(uid) || {}).lang === 'en' ? 'en' : 'de');
      const to = users.filter((u) => langOf(u) === lang);
      if (!to.length) continue;
      const person = to.filter((u) => u === r.user_id);
      const others = to.filter((u) => u !== r.user_id);
      for (const [group, admin] of [[person, false], [others, true]]) {
        if (!group.length) continue;
        try {
          await gc.notify({
            topic: 'guard', users: group, priority: 'high', collapseKey: `drive-guard:${r.id}`,
            title: t(lang, admin ? 'guard.title_admin' : 'guard.title', { device, name: owner ? owner.name : String(r.user_id) }),
            body: t(lang, 'guard.body', { count: r.files, sample }),
            data: {
              drive: { incident: r.id }, ...(link ? { link } : {}),
              actions: [{ id: 'open', type: 'open_portal', label: t(lang, 'guard.open'), target: '/portal#plg-gatecontrol-drive' }],
            },
          });
        } catch (e) { gc.log.warn('guard note failed', (e && e.code) || 'error'); }
      }
    }
  }
}

/** Background: journal rows older than the window that belong to no incident go; closed incidents after 30 days. */
async function housekeeping(gc, settings, now) {
  await store.run(gc, 'DELETE FROM guard_log WHERE incident_id IS NULL AND at < ?', [now - Math.max(windowMs(settings), 3600000)]);
  const old = await store.all(gc, "SELECT id FROM guard_incidents WHERE state <> 'open' AND ended_at < ? LIMIT 500", [now - KEEP_CLOSED_DAYS * DAY]);
  if (!old.length) return 0;
  const ids = old.map((r) => r.id);
  await store.run(gc, `DELETE FROM guard_log WHERE incident_id IN (${store.marks(ids.length)})`, ids);
  await store.run(gc, `DELETE FROM guard_incidents WHERE id IN (${store.marks(ids.length)})`, ids);
  return ids.length;
}

module.exports = {
  note, check, lockOf, writes, meOf, list, get, release, undo, announce, housekeeping, entropyArg, extSign, entropySign, randomExt, extOf,
  RANSOM_EXT, KNOWN_EXT, ENTROPY_HIGH,
};
