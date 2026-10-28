'use strict';

// Administrators (GateControl's admin UI, /api/v1/plugins/gatecontrol-drive/api/admin/…):
//   GET  admin/overview               licence, people (seats) and every account, the areas with their space, since 1.7.0
//                                     `storage` (the sums of every area, duplicates)
//   PUT  admin/seats/<userId>         { kind: 'family' | 'business' | null } — switch a person on / off
//   GET  admin/teams                  the team folders
//   POST admin/teams                  { label, members: [{ principal: 'u:<id>' | 'g:<id>', role }], quota }
//   PUT  admin/teams/<id>             { label?, members?, quota?, archived? }
//   DELETE admin/teams/<id>           an empty team folder (one with files: archive it)
//   POST admin/license/refresh        fetch the licence now (after "Personen hinzubuchen")
//   PUT  admin/backup-hint            { on } — the hint "Das GateControl-Backup sichert keine Drive-Dateien" (backup.js)

const store = require('./store');
const people = require('./people');
const seats = require('./seats');
const areas = require('./areas');
const backup = require('./backup');
const storage = require('./storage');
const { fail, posInt } = require('./util');

async function overview(gc) {
  const [s, us, rows, settings] = await Promise.all([seats.summary(gc), people.users(gc), store.all(gc, 'SELECT * FROM areas ORDER BY kind, label'), areas.settingsOf(gc)]);
  const seatOf = new Map(s.seats.map((x) => [x.userId, x.kind]));
  const list = [];
  for (const a of rows) {
    let info = null;
    try { info = await gc.media.areas.info(a.media_area); } catch { info = null; }
    const files = await store.one(gc, 'SELECT COUNT(*) AS n FROM nodes WHERE area_id = ? AND is_dir = 0 AND deleted_at IS NULL', [a.id]);
    list.push({
      id: a.id, kind: a.kind, label: a.label, mediaArea: a.media_area, owner: a.owner_user, archived: a.archived_at != null, files: files.n,
      storage: info ? { bytes: info.bytes, quota: info.quota, form: info.form, target: info.target, state: info.state, encrypted: info.encrypted } : null,
    });
  }
  return {
    licence: s.licence, limits: s.limits, counts: s.counts, exceeded: s.exceeded, backup: await backup.state(gc, settings.backupHint),
    people: [...us.values()].map((u) => ({ id: u.id, name: u.name, role: u.role, seat: seatOf.get(u.id) || null })),
    areas: list,
    // the storage in short (since 1.7.0): every area's files, versions, trash, what duplicates waste
    storage: await storage.summary(gc),
  };
}

async function route(gc, req, seg, user, now) {
  const m = String(req.method || 'GET').toUpperCase();
  const [, a, b] = seg;
  if (a === 'overview' && seg.length === 2 && m === 'GET') return { overview: await overview(gc) };
  if (a === 'seats' && seg.length === 3 && m === 'PUT') {
    const uid = posInt(b);
    if (!uid) throw fail('invalid', { field: 'userId' });
    const body = req.body || {};
    const seat = await seats.set(gc, uid, body.kind == null ? null : String(body.kind), user.id, now);
    gc.log.info(seat ? `seat on (${seat.kind})` : 'seat off', uid);
    return { seat: seat ? { userId: seat.user_id, kind: seat.kind } : null, summary: await seats.summary(gc) };
  }
  if (a === 'teams' && seg.length === 2 && m === 'GET') {
    const rows = await store.all(gc, "SELECT id FROM areas WHERE kind = 'team' ORDER BY label");
    const out = [];
    for (const r of rows) out.push(await areas.teamView(gc, r.id));
    return { teams: out };
  }
  if (a === 'teams' && seg.length === 2 && m === 'POST') return { team: await areas.createTeam(gc, req.body || {}, now) };
  if (a === 'teams' && seg.length === 3 && (m === 'PUT' || m === 'PATCH')) return { team: await areas.updateTeam(gc, String(b), req.body || {}, now) };
  if (a === 'teams' && seg.length === 3 && m === 'DELETE') return { removed: await areas.removeTeam(gc, String(b)) };
  if (a === 'backup-hint' && seg.length === 2 && (m === 'PUT' || m === 'POST')) {
    const on = !!(req.body && req.body.on === true);
    await gc.settings.set('backup_hint', on);
    return { backup: await backup.state(gc, on) };
  }
  if (a === 'license' && b === 'refresh' && seg.length === 3 && m === 'POST') {
    if (!gc.license || typeof gc.license.refresh !== 'function') throw fail('invalid');
    const r = await gc.license.refresh();
    return { refreshed: r.refreshed === true, summary: await seats.summary(gc) };
  }
  throw fail('not_found');
}

module.exports = { overview, route };
