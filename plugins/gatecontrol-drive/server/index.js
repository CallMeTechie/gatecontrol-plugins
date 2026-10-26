'use strict';

// gatecontrol-drive — "Drive": the files of the family and the team on one's own storage (this server, a NAS, S3).
// Areas (areas.js): my files, the family, the children's folders, team folders — each with its own media area,
// so an administrator decides per area where its files lie (GateControl › Plugins › Drive › Speicherorte).
// Who may use Drive: people an administrator switched on (seats.js), counted against the licence.
//
//   app API   /api/v1/client/plugins/gatecontrol-drive/api/…   (the device token's owner, user.device)
//   portal    /api/v1/portal/plugins/gatecontrol-drive/api/…   (the same routes; also under portal/…)
//     GET me · GET areas · GET changes?since=&limit= · GET search?q=&area=
//     GET nodes/by-path?area=&path= · GET nodes/<id> · GET nodes/<id>/children?sort=&order=&offset=&limit=
//     POST nodes · PATCH nodes/<id> · DELETE nodes/<id> · GET nodes/<id>/content
//     GET nodes/<id>/versions · GET nodes/<id>/versions/<vid>/content · POST nodes/<id>/versions/<vid>/restore
//     DELETE nodes/<id>/versions/<vid> · POST uploads/check · POST uploads/commit
//     GET trash?area= · POST trash/<id>/restore · DELETE trash/<id>
//     POST links · GET links?nodeId= · GET links/<token>/events · DELETE links/<token>   (links.js, since 0.2.0)
//   admin     admin/… (administrators in the admin UI, admin.js)
// The full contract (bodies, answers, codes, events) is in README.md "API".
//
// Needs GateControl ≥ 1.207.0 (media areas and paths, versions and their restore, the NAS journal, gc.license.info
// with tier and seats, a database up to 4 GB).

const store = require('./store');
const people = require('./people');
const seats = require('./seats');
const areas = require('./areas');
const nodes = require('./nodes');
const files = require('./files');
const changes = require('./changes');
const sync = require('./sync');
const admin = require('./admin');
const jobs = require('./jobs');
const links = require('./links');
const ui = require('./ui');
const { t } = require('./text');
const { STATUS, fail, isKnown, posInt, DEVICE_RE, day, iso } = require('./util');

// GateControl's media errors a request may end in
const HOST_CODES = { ERR_MEDIA_QUOTA: 'quota', ERR_CONFLICT: 'exists', ERR_NOT_FOUND: 'not_found' };

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : (e && HOST_CODES[e.code]) || 'internal';
  return { status: STATUS[code], json: { ok: false, code, error: t(lang, 'error.' + code), ...((isKnown(e) && e.extra) || {}) } };
}

/** A person: a signed-in portal viewer or an app user — never a kiosk device, never the admin UI. */
function refusal(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return 'forbidden';
  if (user.portal !== true && user.app !== true) return 'forbidden';
  if (user.kiosk === true) return 'forbidden';
  if (user.loggedIn !== true) return 'login_required';
  return null;
}

const once = (fn) => { let p = null; return () => (p || (p = fn())); };

/**
 * The request's context: the viewer, their seat, the settings, people — and visible(), the areas the viewer sees
 * (computed once; it creates missing areas in transactions of its own, so it runs before any store.tx).
 */
async function context(gc, user, lang, now) {
  const [users, settings, lic, seat] = await Promise.all([people.users(gc), areas.settingsOf(gc), people.licence(gc), seats.get(gc, user.id)]);
  const deviceId = user.app === true && user.device && typeof user.device.id === 'string' && DEVICE_RE.test(user.device.id) ? user.device.id : null;
  const ctx = {
    gc, viewer: user.id, user: users.get(user.id) || null, deviceId, lang: lang === 'en' ? 'en' : 'de', now,
    users, settings, licence: lic, seat: lic.valid ? seat : null, touched: new Set(), notes: [],
  };
  ctx.families = once(() => people.families(gc));
  ctx.groups = once(() => people.groupsOf(gc, user.id));
  ctx.visible = once(() => areas.visible(ctx));
  ctx.noteChildView = (area) => noteChildView(ctx, area);
  ctx.areaLabel = (area) => labelOf(ctx, area);
  return ctx;
}

const nameOf = (ctx, uid) => (ctx.users.get(uid) || {}).name || String(uid);

/** A parent looked into a child's folder: the child is told once a day per parent (after the answer). */
async function noteChildView(ctx, area) {
  const child = area.owner_user;
  if (!child || child === ctx.viewer) return;
  const r = await store.run(ctx.gc, 'INSERT OR IGNORE INTO child_views (child_id, viewer_id, day) VALUES (?, ?, ?)', [child, ctx.viewer, day(ctx.now)]);
  if (r && r.changes) ctx.notes.push({ child, viewer: ctx.viewer });
}

/** An area's label in the viewer's language. */
function labelOf(ctx, a) {
  if (a.kind === 'mine') return t(ctx.lang, 'area.mine');
  if (a.kind === 'child') return t(ctx.lang, 'area.child', { name: nameOf(ctx, a.owner_user) });
  return a.label;
}

/** The area as a person sees it: its label in their language. */
function areaView(ctx, v, storage) {
  const a = v.area;
  return {
    id: a.id, kind: a.kind, label: labelOf(ctx, a), role: v.role, via: v.via, rootId: a.root_id, owner: a.owner_user || null,
    archived: a.archived_at != null, ...(storage !== undefined ? { storage } : {}),
  };
}

async function storageOf(gc, a) {
  try {
    const i = await gc.media.areas.info(a.media_area);
    return i ? { bytes: i.bytes, quota: i.quota, form: i.form || null, target: i.target || null, state: i.state || null } : null;
  } catch { return null; }
}

/** GET me — who I am for Drive: the seat, the licence, my areas, where the change log stands. */
async function me(ctx) {
  const list = ctx.seat ? await ctx.visible() : [];
  let usage = null;
  try { usage = await ctx.gc.media.usage(); } catch { usage = null; }
  return {
    me: { id: ctx.viewer, name: ctx.user ? ctx.user.name : null, seat: ctx.seat ? ctx.seat.kind : null, deviceId: ctx.deviceId },
    licence: { valid: ctx.licence.valid, tier: ctx.licence.tier },
    areas: list.map((v) => areaView(ctx, v)),
    latest: await changes.latest(ctx.gc),
    settings: { versionsDays: ctx.settings.versionsDays, versionsMax: ctx.settings.versionsMax, trashDays: ctx.settings.trashDays, parentsView: ctx.settings.parentsView },
    limits: { maxBytes: usage ? usage.maxBytes : null },
    // names for "changed by …" (the accounts of this server; the apps and the portal show them)
    people: ctx.seat ? [...ctx.users.values()].map((u) => ({ id: u.id, name: u.name })) : [],
    serverTime: iso(ctx.now),
  };
}

const THUMBS_MAX = 200;

/** GET nodes/<id>/children?thumbs=1: pictures get `thumb`, a signed URL of the picture itself (the portal's tiles). */
async function withThumbs(ctx, r) {
  let n = 0;
  for (const it of r.items) {
    if (it.isDir || !it.mediaId || !/^image\//.test(String(it.mime || '')) || n >= THUMBS_MAX) continue;
    n++;
    try { it.thumb = await ctx.gc.media.url(it.mediaId, { user: ctx.viewer, ttlS: files.URL_TTL_S }); } catch { it.thumb = null; }
  }
  return r;
}

async function areaList(ctx) {
  const out = [];
  for (const v of await ctx.visible()) out.push(areaView(ctx, v, await storageOf(ctx.gc, v.area)));
  return { areas: out };
}

const ok = (body) => ({ status: 200, json: { ok: true, ...body } });

function idArg(v) {
  const n = posInt(v);
  if (!n) throw fail('not_found');
  return n;
}

async function route(ctx, req, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const q = req.query || {};
  const body = req.body;
  const [a, b, c, d, e] = seg;
  if (a === 'me' && seg.length === 1 && m === 'GET') return ok(await me(ctx));
  if (!ctx.licence.valid) throw fail('not_licensed');
  if (!ctx.seat) throw fail('no_seat');
  await ctx.visible();
  if (a === 'areas' && seg.length === 1 && m === 'GET') return ok(await areaList(ctx));
  if (a === 'changes' && seg.length === 1 && m === 'GET') return ok(await changes.since(ctx, q));
  if (a === 'search' && seg.length === 1 && m === 'GET') return ok(await nodes.search(ctx, q.q, q.area ? String(q.area) : null));
  if (a === 'nodes') {
    if (seg.length === 1 && m === 'POST') return ok({ node: await nodes.mkdir(ctx, body) });
    if (b === 'by-path' && seg.length === 2 && m === 'GET') return ok({ node: await nodes.byPath(ctx, q.area, q.path) });
    if (seg.length === 2) {
      if (m === 'GET') return ok({ node: await nodes.get(ctx, idArg(b)) });
      if (m === 'PATCH' || m === 'PUT') return ok({ node: await nodes.update(ctx, idArg(b), body) });
      if (m === 'DELETE') return ok(await nodes.trash(ctx, idArg(b)));
    }
    if (seg.length === 3 && m === 'GET') {
      if (c === 'children') {
        const r = await nodes.children(ctx, idArg(b), q);
        return ok(q.thumbs ? await withThumbs(ctx, r) : r);
      }
      if (c === 'content') return ok(await files.content(ctx, idArg(b)));
      if (c === 'versions') return ok(await files.versions(ctx, idArg(b)));
    }
    if (c === 'versions' && seg.length >= 4) {
      if (seg.length === 4 && m === 'DELETE') return ok(await files.deleteVersion(ctx, idArg(b), idArg(d)));
      if (seg.length === 5 && e === 'content' && m === 'GET') return ok(await files.versionContent(ctx, idArg(b), idArg(d)));
      if (seg.length === 5 && e === 'restore' && m === 'POST') return ok({ node: await files.restoreVersion(ctx, idArg(b), idArg(d)) });
    }
  }
  if (a === 'uploads' && seg.length === 2 && m === 'POST') {
    if (b === 'check') return ok(await files.check(ctx, body));
    if (b === 'commit') return ok(await files.commit(ctx, body));
  }
  if (a === 'links') {
    if (seg.length === 1 && m === 'POST') return ok({ link: await links.create(ctx, body) });
    if (seg.length === 1 && m === 'GET') return ok(await links.list(ctx, q));
    if (seg.length === 2 && m === 'DELETE') return ok(await links.revoke(ctx, b));
    if (seg.length === 3 && c === 'events' && m === 'GET') return ok(await links.events(ctx, b, q));
  }
  if (a === 'trash') {
    if (seg.length === 1 && m === 'GET') return ok(await nodes.trashList(ctx, q.area ? String(q.area) : null));
    if (seg.length === 3 && c === 'restore' && m === 'POST') return ok({ node: await nodes.restore(ctx, idArg(b)) });
    if (seg.length === 2 && m === 'DELETE') return ok(await nodes.purge(ctx, idArg(b)));
  }
  throw fail('not_found');
}

/**
 * After the answer: links that point at a moved or trashed folder end (only when the request succeeded), the live
 * event to the readers of what changed, the notes to children (best effort).
 */
async function after(gc, ctx, done) {
  if (done && ctx.unlink) {
    try { await links.endFor(gc, ctx.unlink, ctx.now); } catch (e) { gc.log.warn('ending links failed', (e && e.code) || 'error'); }
  }
  try { await changes.announce(gc, ctx.touched, ctx.settings); } catch (e) { gc.log.warn('announce failed', (e && e.code) || 'error'); }
  for (const n of ctx.notes) {
    const lang = (ctx.users.get(n.child) || {}).lang === 'en' ? 'en' : 'de';
    try {
      await gc.notify({
        topic: 'child_view', users: [n.child], collapseKey: `drive-child-view:${n.viewer}`,
        title: t(lang, 'child_view.title', { name: nameOf(ctx, n.viewer) }), body: t(lang, 'child_view.body', { child: nameOf(ctx, n.child) }),
        data: { drive: { area: areas.idOf.child(n.child) } },
      });
    } catch (e) { gc.log.warn('child note failed', (e && e.code) || 'error'); }
  }
}

module.exports = {
  async start(gc) {
    gc.log.info('drive started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang;
    try {
      let seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) throw fail('not_found');
      const now = Date.now();
      if (seg[0] === 'admin') {
        if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') throw fail('forbidden');
        return ok(await admin.route(gc, req, seg, req.user, now));
      }
      if (seg[0] === 'portal' && seg.length > 1) seg = seg.slice(1); // the same routes under portal/…
      const no = refusal(req.user);
      if (no) throw fail(no);
      const ctx = await context(gc, req.user, lang, now);
      if (!ctx.user) throw fail('forbidden');
      let done = false;
      try {
        const out = await route(ctx, req, seg);
        done = true;
        return out;
      } finally {
        await after(gc, ctx, done);
      }
    } catch (e) {
      if (!isKnown(e) && !(e && HOST_CODES[e.code])) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 2).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab "Drive": people switched on (not a kiosk device). */
  async portalVisible({ user, section } = {}, gc) {
    if (section || !user || user.kiosk === true || !Number.isSafeInteger(user.id)) return false;
    return !!(await seats.get(gc, user.id));
  },

  /**
   * Who may read a file (the apps' GET …/media/<id>): readers of the area its node (or the node of its version) is
   * in; a file not (yet) part of the tree: its uploader.
   */
  async mediaAccess({ user, mediaId, owner } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id) || user.kiosk === true || typeof mediaId !== 'string') return false;
    let n = await store.one(gc, 'SELECT * FROM nodes WHERE media_id = ?', [mediaId]);
    if (!n) {
      const v = await store.one(gc, 'SELECT node_id FROM versions WHERE media_id = ?', [mediaId]);
      n = v ? await nodes.row(gc, v.node_id) : null;
    }
    if (!n) return owner != null && owner === user.id;
    if (n.deleted_at != null) return false;
    const ctx = await context(gc, user, 'de', Date.now());
    if (!ctx.seat) return false;
    return (await ctx.visible()).some((x) => x.area.id === n.area_id);
  },

  /**
   * GateControl's public links (hook publicLinkEvent): a file that came in through an upload link becomes a file of
   * the tree, and its owner is told (topic link_upload). Downloads and the rest are in the link's log.
   */
  async publicLinkEvent(arg, gc) {
    if (!arg || arg.event !== 'upload' || typeof arg.token !== 'string') return;
    const now = Date.now();
    const r = await links.adoptUpload(gc, arg.token, { mediaId: arg.mediaId, path: arg.path }, now);
    if (!r.row) return;
    if (r.touched.size) await changes.announce(gc, r.touched, await areas.settingsOf(gc));
    if (!r.adopted) return;
    const us = await people.users(gc);
    const owner = us.get(r.row.created_by);
    if (!owner) return;
    const lang = owner.lang === 'en' ? 'en' : 'de';
    const folder = r.row.path ? r.row.path.split('/').pop() : t(lang, 'area.mine');
    try {
      await gc.notify({
        topic: 'link_upload', users: [owner.id], collapseKey: `drive-link:${arg.token}`,
        title: t(lang, 'link_upload.title', { file: String(arg.name || '') }),
        body: t(lang, 'link_upload.body', { who: arg.uploader ? String(arg.uploader) : t(lang, 'link_upload.someone'), folder }),
        data: { drive: { node: r.row.node_id, area: r.row.area_id } },
      });
    } catch (e) { gc.log.warn('link note failed', (e && e.code) || 'error'); }
  },

  /** GateControl read the NAS (an area in the readable form): its journal becomes the tree. */
  async mediaChanged(arg, gc) {
    const area = arg && typeof arg.area === 'string' ? arg.area : null;
    if (!area) return;
    const r = await sync.area(gc, area, Date.now());
    if (r.touched.size) await changes.announce(gc, r.touched, await areas.settingsOf(gc));
  },

  async tick(gc) {
    return jobs.tick(gc, Date.now());
  },
};
