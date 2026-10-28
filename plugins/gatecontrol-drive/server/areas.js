'use strict';

// Areas and who may do what in them (concept "Bereiche und Rechte"):
//
//   mine:<user>     Meine Dateien — every person switched on; only the person (manage)
//   family:<group>  Familie — the members of a GateControl family group with a family seat (write)
//   child:<user>    Kinder · <name> — a child of a family with a family seat (manage); its parents with a family seat
//                   may look in (read) while the setting child_parents_view is on — the child then gets a note
//                   once a day (topic child_view)
//   team:<n>        team folders an administrator sets up: people 'u:<id>' and groups 'g:<id>' with read / write /
//                   manage — for people with a business seat
//
// Each area has its own media area (gc.media.areas): an administrator decides in GateControl's plugin settings
// ("Speicherorte") whether its files lie on this server, a NAS or in S3.

const store = require('./store');
const people = require('./people');
const { fail } = require('./util');

const GB = 1024 ** 3;
const RANK = { read: 1, write: 2, manage: 3 };
const best = (a, b) => (!a ? b : (!b ? a : (RANK[a] >= RANK[b] ? a : b)));
const can = (role, need) => !!role && RANK[role] >= RANK[need];

const idOf = {
  mine: (uid) => `mine:${uid}`,
  family: (gid) => `family:${gid}`,
  child: (uid) => `child:${uid}`,
  team: (n) => `team:${n}`,
};
const mediaOf = {
  mine: (uid) => `u${uid}`,
  family: (gid) => `f${gid}`,
  child: (uid) => `c${uid}`,
  team: (n) => `t${n}`,
};

async function row(gc, id) {
  return store.one(gc, 'SELECT * FROM areas WHERE id = ?', [id]);
}

/**
 * The area `spec` with its media area and root folder, created when missing (label and quota kept up to date).
 * Runs in its own transaction — never call it inside store.tx.
 */
async function ensure(gc, spec, now) {
  const have = await row(gc, spec.id);
  if (have && have.root_id != null && have.label === spec.label && (have.quota_bytes || null) === (spec.quota || null)) return have;
  await gc.media.areas.ensure(spec.mediaArea, { label: spec.label, ...(spec.quota ? { quota: spec.quota } : {}) });
  return store.tx(gc, async () => {
    const cur = await row(gc, spec.id);
    if (!cur) {
      await store.run(gc, `INSERT INTO areas (id, kind, label, owner_user, group_id, media_area, quota_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [spec.id, spec.kind, spec.label, spec.owner || null, spec.groupId || null, spec.mediaArea, spec.quota || null, now]);
    } else if (cur.label !== spec.label || (cur.quota_bytes || null) !== (spec.quota || null)) {
      await store.run(gc, 'UPDATE areas SET label = ?, quota_bytes = ? WHERE id = ?', [spec.label, spec.quota || null, spec.id]);
    }
    const a = await row(gc, spec.id);
    if (a.root_id == null) {
      const r = await store.run(gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, updated_at) VALUES (?, NULL, '', 1, ?, ?)`, [spec.id, now, now]);
      await store.run(gc, 'UPDATE areas SET root_id = ? WHERE id = ?', [r.lastInsertRowid, spec.id]);
    }
    return row(gc, spec.id);
  });
}

async function settingsOf(gc) {
  const all = await gc.settings.all();
  const n = (k, d) => (Number.isFinite(Number(all[k])) ? Number(all[k]) : d);
  return {
    versionsDays: Math.max(1, n('versions_days', 30)),
    versionsMax: Math.max(1, n('versions_max', 25)),
    trashDays: Math.max(1, n('trash_days', 30)),
    mineQuota: n('mine_quota_gb', 50) > 0 ? Math.round(n('mine_quota_gb', 50) * GB) : null,
    parentsView: all.child_parents_view !== false && all.child_parents_view !== 'false',
    backupHint: all.backup_hint !== false && all.backup_hint !== 'false',
    scanFormat: all.scan_format === 'image' ? 'image' : 'pdf',
    // ransomware protection (guard.js, since 1.6.0)
    guardOn: all.guard_on !== false && all.guard_on !== 'false',
    guardFiles: Math.min(100000, Math.max(5, Math.round(n('guard_files', 50)))),
    guardPercent: Math.min(100, Math.max(1, n('guard_percent', 20))),
    guardMinutes: Math.min(240, Math.max(1, n('guard_minutes', 10))),
    // direct links (address.js, since 1.6.0): an administrator's own address of GateControl
    portalUrl: typeof all.portal_url === 'string' ? all.portal_url.trim() : '',
    // AI for documents and the import from cloud drives (since 1.8.0) — an administrator's switches for all of Drive
    docAi: all.doc_ai !== false && all.doc_ai !== 'false',
    docAiImages: all.doc_ai_images === true || all.doc_ai_images === 'true',
    cloudImport: all.cloud_import !== false && all.cloud_import !== 'false',
  };
}

// Labels of the media areas (GateControl shows them to administrators under "Speicherorte"): "Meine Dateien · Anna",
// "Kinder · Lena", the family's group name, a team folder's label. People see them translated (index.js areaView).
const childLabel = (name) => `Kinder · ${name}`;
const mineLabel = (name) => `Meine Dateien · ${name}`;
const nameOf = (ctx, uid) => (ctx.users.get(uid) || {}).name || String(uid);

/**
 * The areas the viewer sees → [{ area, role, via }] (via: 'owner' | 'member' | 'parent').
 * Creates the areas that belong to them (my files, the family, a child's folder) on the way.
 */
async function visible(ctx) {
  const { gc, viewer, seat, now } = ctx;
  if (!seat) return [];
  const out = [];
  const add = (area, role, via) => { const i = out.findIndex((x) => x.area.id === area.id); if (i < 0) out.push({ area, role, via }); else out[i].role = best(out[i].role, role); };
  const s = ctx.settings;
  add(await ensure(gc, { id: idOf.mine(viewer), kind: 'mine', label: mineLabel(nameOf(ctx, viewer)), owner: viewer, mediaArea: mediaOf.mine(viewer), quota: s.mineQuota }, now), 'manage', 'owner');
  if (seat.kind === 'family') {
    const seated = new Set((await store.all(gc, "SELECT user_id FROM seats WHERE kind = 'family'")).map((r) => r.user_id));
    for (const f of await ctx.families()) {
      if (!f.members.has(viewer)) continue;
      add(await ensure(gc, { id: idOf.family(f.id), kind: 'family', label: f.name, groupId: f.id, mediaArea: mediaOf.family(f.id) }, now), 'write', 'member');
      for (const c of f.children) {
        if (!seated.has(c)) continue;
        const name = nameOf(ctx, c);
        if (c === viewer) add(await ensure(gc, { id: idOf.child(c), kind: 'child', label: childLabel(name), owner: c, groupId: f.id, mediaArea: mediaOf.child(c) }, now), 'manage', 'owner');
        else if (f.parents.has(viewer) && s.parentsView) {
          add(await ensure(gc, { id: idOf.child(c), kind: 'child', label: childLabel(name), owner: c, groupId: f.id, mediaArea: mediaOf.child(c) }, now), 'read', 'parent');
        }
      }
    }
  }
  if (seat.kind === 'business') {
    const teams = await store.all(gc, "SELECT * FROM areas WHERE kind = 'team' AND archived_at IS NULL ORDER BY label");
    if (teams.length) {
      const mine = await ctx.groups();
      const rows = await store.all(gc, `SELECT * FROM members WHERE area_id IN (${store.marks(teams.length)})`, teams.map((t) => t.id));
      for (const t of teams) {
        let role = null;
        for (const m of rows.filter((x) => x.area_id === t.id)) {
          const [kind, id] = m.principal.split(':');
          if ((kind === 'u' && Number(id) === viewer) || (kind === 'g' && mine.has(Number(id)))) role = best(role, m.role);
        }
        if (role) add(t, role, 'member');
      }
    }
  }
  return out;
}

/** The viewer's role in area `areaId`, or fail('forbidden'). `need`: the least role needed. */
async function roleIn(ctx, areaId, need = 'read') {
  const v = (await ctx.visible()).find((x) => x.area.id === areaId);
  if (!v || !can(v.role, need)) throw fail(v ? 'forbidden' : 'not_found');
  return v;
}

/**
 * Who reads area `a` now → [user ids] (for live events): the owner, the family's seated members, a child and its
 * parents (while they may look in), the members of a team (groups resolved) with a business seat.
 */
async function readers(gc, a, settings) {
  const seats = new Map((await store.all(gc, 'SELECT user_id, kind FROM seats')).map((r) => [r.user_id, r.kind]));
  const with_ = (ids, kind) => [...ids].filter((u) => (kind ? seats.get(u) === kind : seats.has(u)));
  if (a.kind === 'mine') return with_([a.owner_user]);
  if (a.kind === 'family' || a.kind === 'child') {
    const f = (await people.families(gc)).find((x) => x.id === a.group_id);
    if (!f) return a.kind === 'child' ? with_([a.owner_user], 'family') : [];
    if (a.kind === 'family') return with_(f.members, 'family');
    const ids = new Set([a.owner_user]);
    if (settings.parentsView) for (const p of f.parents) ids.add(p);
    return with_(ids, 'family');
  }
  const ids = new Set();
  for (const m of await store.all(gc, 'SELECT principal FROM members WHERE area_id = ?', [a.id])) {
    const [kind, id] = m.principal.split(':');
    if (kind === 'u') ids.add(Number(id));
    else for (const u of await people.groupMembers(gc, Number(id))) ids.add(u);
  }
  return with_(ids, 'business');
}

// ─── Team folders (administrators) ──────────────

const PRINCIPAL_RE = /^[ug]:[1-9]\d{0,14}$/;

function membersArg(list) {
  if (!Array.isArray(list) || list.length > 500) throw fail('invalid', { field: 'members' });
  const out = new Map();
  for (const m of list) {
    if (!m || typeof m.principal !== 'string' || !PRINCIPAL_RE.test(m.principal) || !RANK[m.role]) throw fail('invalid', { field: 'members' });
    out.set(m.principal, m.role);
  }
  return out;
}

function labelArg(v) {
  const s = typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!s || s.length > 80) throw fail('invalid', { field: 'label' });
  return s;
}

function quotaArg(v) {
  if (v == null || v === 0) return null;
  if (!Number.isSafeInteger(v) || v < 1024 * 1024 || v > 1024 ** 5) throw fail('invalid', { field: 'quota' });
  return v;
}

async function setMembers(gc, id, members) {
  await store.run(gc, 'DELETE FROM members WHERE area_id = ?', [id]);
  for (const [p, r] of members) await store.run(gc, 'INSERT INTO members (area_id, principal, role) VALUES (?, ?, ?)', [id, p, r]);
}

/** A new team folder { label, members: [{ principal, role }], quota } → its view. */
async function createTeam(gc, body, now) {
  const label = labelArg(body && body.label);
  const members = membersArg((body && body.members) || []);
  const quota = quotaArg(body && body.quota);
  const last = await store.one(gc, "SELECT MAX(CAST(substr(id, 6) AS INTEGER)) AS n FROM areas WHERE kind = 'team'");
  const n = ((last && last.n) || 0) + 1;
  const a = await ensure(gc, { id: idOf.team(n), kind: 'team', label, mediaArea: mediaOf.team(n), quota }, now);
  await store.tx(gc, () => setMembers(gc, a.id, members));
  return teamView(gc, a.id);
}

async function updateTeam(gc, id, body, now) {
  const a = await row(gc, id);
  if (!a || a.kind !== 'team') throw fail('not_found');
  const label = body.label != null ? labelArg(body.label) : a.label;
  const quota = body.quota !== undefined ? quotaArg(body.quota) : a.quota_bytes;
  await ensure(gc, { id, kind: 'team', label, mediaArea: a.media_area, quota }, now);
  if (body.members != null) {
    const members = membersArg(body.members);
    await store.tx(gc, () => setMembers(gc, id, members));
  }
  if (body.archived != null) await store.run(gc, 'UPDATE areas SET archived_at = ? WHERE id = ?', [body.archived ? now : null, id]);
  return teamView(gc, id);
}

/** An empty team folder goes for good (its media area too); one with files only when archived first → not_empty. */
async function removeTeam(gc, id) {
  const a = await row(gc, id);
  if (!a || a.kind !== 'team') throw fail('not_found');
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM nodes WHERE area_id = ? AND parent_id IS NOT NULL', [id]);
  if (n.n) throw fail('not_empty');
  await gc.media.areas.remove(a.media_area);
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM members WHERE area_id = ?', [id]);
    await store.run(gc, 'DELETE FROM changes WHERE area_id = ?', [id]);
    // its albums and the history of its nodes (since 1.7.0)
    await store.run(gc, 'DELETE FROM album_items WHERE album_id IN (SELECT id FROM albums WHERE area_id = ?) OR node_id IN (SELECT id FROM nodes WHERE area_id = ?)', [id, id]);
    await store.run(gc, 'DELETE FROM albums WHERE area_id = ?', [id]);
    await store.run(gc, 'DELETE FROM node_log WHERE node_id IN (SELECT id FROM nodes WHERE area_id = ?)', [id]);
    await store.run(gc, 'DELETE FROM nodes WHERE area_id = ?', [id]);
    await store.run(gc, 'DELETE FROM areas WHERE id = ?', [id]);
  });
  return true;
}

/** A team folder for administrators: members with a label (a person's name, a group's path), files, space. */
async function teamView(gc, id) {
  const a = await row(gc, id);
  const rows = await store.all(gc, 'SELECT principal, role FROM members WHERE area_id = ? ORDER BY principal', [id]);
  const us = await people.users(gc);
  const members = [];
  for (const m of rows) {
    const [kind, pid] = m.principal.split(':');
    let label = null;
    if (kind === 'u') label = (us.get(Number(pid)) || {}).name || null;
    else if (gc.groups && typeof gc.groups.get === 'function') {
      try { const g = await gc.groups.get(Number(pid)); label = g ? (g.path || g.name) : null; } catch { label = null; }
    }
    members.push({ principal: m.principal, role: m.role, type: kind === 'u' ? 'user' : 'group', id: Number(pid), label, gone: label == null });
  }
  const files = await store.one(gc, 'SELECT COUNT(*) AS n FROM nodes WHERE area_id = ? AND is_dir = 0 AND deleted_at IS NULL', [id]);
  return { id: a.id, label: a.label, quota: a.quota_bytes, archived: a.archived_at != null, members, files: files.n };
}

module.exports = { RANK, can, best, idOf, mediaOf, row, ensure, settingsOf, visible, roleIn, readers, createTeam, updateTeam, removeTeam, teamView };
