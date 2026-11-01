'use strict';

// gatecontrol-drive — "Drive": the files of the family and the team on one's own storage (this server, a NAS, S3).
// Areas (areas.js): my files, the family, the children's folders, team folders — each with its own media area,
// so an administrator decides per area where its files lie (GateControl › Plugins › Drive › Speicherorte).
// Who may use Drive: people an administrator switched on (seats.js), counted against the licence.
//
//   app API   /api/v1/client/plugins/gatecontrol-drive/api/…   (the device token's owner, user.device)
//   portal    /api/v1/portal/plugins/gatecontrol-drive/api/…   (the same routes; also under portal/…)
//     GET me · GET areas · GET changes?since=&limit= · GET search?q=&area= (name, then recognised text: doc_text)
//     GET overview (the start of Drive: to do, recently opened, memories, people, places, new in the family, storage —
//     overview.js, 1.18.0; opening a file — content, office — is kept for "Zuletzt geöffnet")
//     GET nodes/by-path?area=&path= · GET nodes/<id> · GET nodes/<id>/children?sort=&order=&offset=&limit=
//     (since 1.11.0 without vault folders — &vaults=1 with them; &dirs=1 only folders with hasDirs: the menu's tree)
//     POST nodes · PATCH nodes/<id> · DELETE nodes/<id> · GET nodes/<id>/content
//     DELETE nodes/<id>?everywhere=1 (also on every device of mine — wipes.js, since 1.2.0) · GET wipes · POST wipes/done
//     DELETE nodes/<id>?after=<s> · PATCH nodes/<id> { deleteAt } (into the trash later — marks.js, since 1.5.0)
//     GET devices · PUT devices/<id> · PUT devices/<id>/folders · DELETE devices/<id>   (devices.js, since 1.5.0)
//     GET guard/incidents[?all=1] · GET guard/incidents/<id> · POST guard/incidents/<id>/release · …/undo
//                                         (ransomware protection — guard.js, since 1.6.0; a locked device: 423)
//     GET nodes/<id>/versions · GET nodes/<id>/versions/<vid>/content · POST nodes/<id>/versions/<vid>/restore
//     DELETE nodes/<id>/versions/<vid> · POST uploads/check · POST uploads/commit
//     GET trash?area= · POST trash/<id>/restore · DELETE trash/<id>
//     POST links · GET links?nodeId= · GET links/<token>/events · DELETE links/<token>   (links.js, since 0.2.0)
//     GET nodes/<id>/timetravel?at= · POST nodes/<id>/timetravel { at }  (a folder as it was — timetravel.js, 1.7.0)
//     GET photos · GET photos/months · GET photos/memories (photos.js; ?folder= / ?camera=1 and GET|POST photos/camera
//     since 1.10.0; GET photos/classes, GET|PUT photos/settings, POST photos/review and class= since 1.13.0 — work.js)
//     · GET|POST albums · GET|PATCH|DELETE albums/<id>
//     POST|DELETE albums/<id>/items (albums.js) · GET storage[?all=1] · POST storage/versions/prune (storage.js) — 1.7.0
//     GET frame   a kiosk device only — the photo frame (frame.js, 1.7.0); every other route refuses a kiosk device
//     GET|POST nodes/<id>/insight · POST nodes/<id>/insight/apply · PATCH areas/<id> { docAi } (insights.js) · GET deadlines
//     · POST|DELETE deadlines/<id>/remind (deadlines.js) — AI for documents, GateControl's gc.ai (1.8.0)
//     import/sources|connect|connections/<id>|browse|jobs[/<id>[/resume]] — the import from Google Drive and OneDrive,
//     GateControl's gc.cloud (imports.js, 1.8.0)
//     POST|GET vaults · GET vaults/<id> · GET vaults/<id>/keys?deviceId= · GET vaults/<id>/recovery · PUT vaults/<id>/recovery
//     GET|POST vaults/<id>/devices · POST vaults/<id>/devices/<deviceId>/approve · DELETE vaults/<id>/devices/<deviceId>
//     POST vaults/<id>/rotate   (vault folders, end-to-end encrypted — vault.js, 1.9.0; nodes and uploads/commit take
//                               encrypted, nameCipher, keyVersion)
//     POST nodes/<id>/office    (office in the browser — office.js, 1.9.0; the office server's WOPI requests come
//                               without a session through GateControl's public endpoints: hook publicRequest)
//     POST ops/check · POST ops · GET ops[?state=] · GET|DELETE ops/<id> · POST ops/<id>/undo · POST ops/<id>/transfers
//     · POST ops/<id>/transfers/<n>   (several files and folders at once: move, copy, trash, restore, purge as a job —
//                                     ops.js, 1.12.0; live event 'op') · POST zip (a ZIP of a selection) · POST links
//                                     { nodeIds } (one link for several files) — links.js, 1.12.0
//     AI in Drive (1.14.0): POST deadlines/<id>/calendar (the family calendar — deadlines.js) · POST ask (questions to the
//     documents — ask.js) · POST scans/classify · POST scans/convert · POST scans/save (scans become Word, Excel or a
//     searchable PDF — scans.js, ooxml.js) · PUT nodes/<id>/labels, GET photos?q= / ?unlabeled=1 (photos by what is on
//     them — labels.js) · PATCH areas/<id> { deadlinesToCalendar }
//     Deadlines also into a calendar of Mail (1.17.0): POST deadlines/<id>/calendar { target }, GET deadlines/calendars,
//     GET|PUT deadlines/targets, PATCH areas/<id> { deadlinesTarget } (deadlines.js, insights.js)
//     Places and people (1.16.0): PUT nodes/<id>/geo, uploads/commit { geo }, GET photos/places, GET photos/map, DELETE
//     photos/geo, place= / bbox= / unlocated=1 (places.js, names offline from GeoNames — geonames.js) · PUT nodes/<id>/faces,
//     GET people, GET|PATCH people/<id>, POST people/<id>/merge, GET people/<id>/similar, GET people/<id>/uncertain, POST
//     people/<id>/confirm, POST faces/<id>/move, person= / unfaced=1 (faces.js) · GET photos/suggest
//   admin     admin/… (administrators in the admin UI, admin.js; admin/guard/… the incidents, since 1.6.0)
// The full contract (bodies, answers, codes, events) is in README.md "API". Every file node of an answer carries
// `preview` (previews.js, since 1.1.0).
//
// Needs GateControl ≥ 1.216.0 since 1.15.0 (maxPerHour of the services; ≥ 1.208.0 before: media areas and paths, versions and their restore, the NAS journal, gc.license.info
// with tier and seats, a database up to 4 GB, media previews). permissions.devices (since 1.2.0): the asking device
// of an app request (user.device) — the change log's `device`, the targets of "delete on all devices" and the device
// the ransomware protection watches and locks (since 1.6.0). GET me links (since 1.6.0, address.js): direct links into
// the portal tab, also on notifications.

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
const services = require('./services');
const previews = require('./previews');
const wipes = require('./wipes');
const marks = require('./marks');
const devices = require('./devices');
const guard = require('./guard');
const address = require('./address');
const timetravel = require('./timetravel');
const photos = require('./photos');
const work = require('./work');
const albums = require('./albums');
const frame = require('./frame');
const storage = require('./storage');
const insights = require('./insights');
const deadlines = require('./deadlines');
const imports = require('./imports');
const vault = require('./vault');
const office = require('./office');
const ops = require('./ops');
const ask = require('./ask');
const scans = require('./scans');
const labels = require('./labels');
const mail = require('./mail');
const places = require('./places');
const faces = require('./faces');
const overview = require('./overview');
const { t } = require('./text');
const { STATUS, fail, isKnown, posInt, DEVICE_RE, day, iso } = require('./util');

// the services for other plugins (plugin.json services.provides)
const SERVICES = {
  list_areas: (ctx) => services.listAreas(ctx),
  save_file: (ctx, payload, caller) => services.saveFile(ctx, payload, caller),
  // since 1.15.0: GateControl Mail (mail.js)
  suggest_folder: (ctx, payload) => mail.suggestFolder(ctx, payload),
  give_file: (ctx, payload, caller) => mail.giveFile(ctx, payload, caller),
  share_link: (ctx, payload) => mail.shareLink(ctx, payload),
  browse: (ctx, payload) => mail.browse(ctx, payload),
};

// GateControl's media errors a request may end in
const HOST_CODES = { ERR_MEDIA_QUOTA: 'quota', ERR_CONFLICT: 'exists', ERR_NOT_FOUND: 'not_found' };

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : (e && HOST_CODES[e.code]) || 'internal';
  // a locked device (guard.js): { error: 'device_locked', code: 'device_locked', incident } — the text as `message`
  if (code === 'device_locked') return { status: STATUS[code], json: { ok: false, code, error: code, message: t(lang, 'error.' + code), ...((e && e.extra) || {}) } };
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
  // the asking device: GateControl's user.device (permissions.devices) — the id of the app's device token
  const deviceId = user.app === true && user.device && typeof user.device.id === 'string' && DEVICE_RE.test(user.device.id) ? user.device.id : null;
  const ctx = {
    gc, viewer: user.id, user: users.get(user.id) || null, deviceId, app: user.app === true, lang: lang === 'en' ? 'en' : 'de', now,
    users, settings, licence: lic, seat: lic.valid ? seat : null, touched: new Set(), notes: [],
    guardOn: settings.guardOn,
  };
  ctx.families = once(() => people.families(gc));
  ctx.groups = once(() => people.groupsOf(gc, user.id));
  ctx.visible = once(() => areas.visible(ctx));
  ctx.noteChildView = (area) => noteChildView(ctx, area);
  ctx.areaLabel = (area) => labelOf(ctx, area);
  return ctx;
}

const nameOf = (ctx, uid) => (ctx.users.get(uid) || {}).name || String(uid);

/** Person `uid` for the background run (1.8.0: reminders, imports) — null without an account, a licence or a seat. */
async function personContext(gc, uid, now) {
  const u = (await people.users(gc)).get(uid);
  if (!u) return null;
  const c = await context(gc, { id: uid, portal: true, loggedIn: true }, u.lang === 'en' ? 'en' : 'de', now);
  if (!c.licence.valid || !c.seat || !c.user) return null;
  await c.visible();
  return c;
}

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
    me: { id: ctx.viewer, name: ctx.user ? ctx.user.name : null, seat: ctx.seat ? ctx.seat.kind : null, deviceId: ctx.deviceId, admin: !!(ctx.user && ctx.user.role === 'admin') },
    // "delete on all devices": entries this device has yet to handle (GET wipes), my devices a new wipe would reach
    wipes: await wipes.pending(ctx),
    devices: await wipes.deviceCount(ctx.gc, ctx.viewer, ctx.now),
    licence: { valid: ctx.licence.valid, tier: ctx.licence.tier },
    areas: await insights.decorate(ctx, list.map((v) => areaView(ctx, v))),
    latest: await changes.latest(ctx.gc),
    settings: {
      versionsDays: ctx.settings.versionsDays, versionsMax: ctx.settings.versionsMax, trashDays: ctx.settings.trashDays, parentsView: ctx.settings.parentsView, scanFormat: ctx.settings.scanFormat,
      // since 1.14.0: "Original-Scan behalten" — the default of the switch when a scan becomes a document
      scanKeepOriginal: ctx.settings.scanKeepOriginal,
    },
    limits: { maxBytes: usage ? usage.maxBytes : null },
    // names for "changed by …" (the accounts of this server; the apps and the portal show them)
    people: ctx.seat ? [...ctx.users.values()].map((u) => ({ id: u.id, name: u.name })) : [],
    serverTime: iso(ctx.now),
    // what this Drive can (since 1.5.0): an app checks before it uses a newer route
    features: [...FEATURES, ...(await optional(ctx))],
    // direct links into the portal (since 1.6.0): node with {id} for the apps to replace, drive the tab; null: no address
    links: await address.links(ctx.gc, ctx.settings, ctx.now),
    // the ransomware protection (since 1.6.0): this device locked? the person's open incidents
    ...(await guard.meOf(ctx)),
  };
}

// overview: GET overview — the start of Drive in one request, "Zuletzt geöffnet" from content / office (1.18.0) ·
// photoPlaces: where photos were taken — uploads/commit { geo }, PUT nodes/<id>/geo, geo / located on nodes and items,
// photos/places, photos/map, place= / bbox= / unlocated=1, DELETE photos/geo, keepGeo in photos/settings (1.16.0) ·
// photoPeople: people in the photos — PUT nodes/<id>/faces, people/…, faces/<id>/move, person= / unfaced=1 / with=people,
// people / peopleKids in photos/settings, the op 'people' (1.16.0); both: q= on names, GET photos/suggest ·
// photoSearch: PUT nodes/<id>/labels, GET photos?q= / ?unlabeled=1, `labeled` on photo items (1.14.0) ·
// photoClasses: work photos apart — GET|PUT photos/settings (the work folder), POST photos/review (the review mark,
// `review` on nodes and photo items, op 'review' in the change log), class= on photos and months, GET photos/classes;
// memories and the frame without the work folder (1.13.0) ·
// bulk: ops/… — move, copy, trash, restore, purge of several at once with progress, cancel and undo (1.12.0) ·
// vaultsApart: vault folders only in the top folder of their area and not in children (vaults=1), children?dirs=1 with
// hasDirs (1.11.0) ·
// photosFolder: photos, months, memories with folder= / camera=1, GET|POST photos/camera (1.10.0) ·
// vault: vault folders, end-to-end encrypted (vaults/…, nodes and uploads/commit with encrypted / nameCipher / keyVersion, 1.9.0) ·
// office (1.9.0, only while set up): POST nodes/<id>/office ·
// timeTravel: nodes/<id>/timetravel · takenAt: uploads/commit { takenAt }, node takenAt · photos: photos, months,
// memories · albums · frame: albums { frame } and the kiosk's photo frame · storage: GET storage, versions/prune (1.7.0) ·
// links: GET me links, ?drive=<id> in the portal (1.6.0) · guard: ransomware protection, 423 device_locked,
// guard/incidents/…, uploads/commit { entropy } (1.6.0) ·
// devices: GET/PUT/DELETE devices (1.5.0) · deleteAfter: DELETE nodes/<id>?after=, PATCH { deleteAt } (1.5.0) ·
// emptyFiles: uploads/commit { size: 0 } without a mediaId (1.5.0) · wipes: DELETE ?everywhere=1 (1.2.0) ·
// textSearch: uploads/commit { text } (1.3.0) · previews (1.1.0)
const FEATURES = ['previews', 'wipes', 'textSearch', 'devices', 'deleteAfter', 'emptyFiles', 'links', 'guard', 'timeTravel', 'takenAt', 'photos', 'albums', 'frame', 'storage', 'vault', 'photosFolder', 'vaultsApart', 'bulk', 'photoClasses', 'photoSearch', 'photoPlaces', 'photoPeople', 'overview'];

/**
 * What needs GateControl's AI service or cloud accounts (1.8.0) — only while the host has it and it is allowed (the
 * administrator in GateControl and Drive's settings): docAi (insights.js, deadlines.js), cloudImport (imports.js).
 */
async function optional(ctx) {
  const out = [];
  // AI in Drive (1.14.0): questions to the documents and scans as documents with AI for documents (gc.ai, doc_ai)
  if ((await insights.state(ctx.gc, ctx.settings)).on) {
    out.push('docAi', 'docAsk', 'scanDocs');
    // deadlines into the family calendar (1.14.0): while the Familie plugin's calendar_add is reachable
    if (await deadlines.calendarReachable(ctx.gc)) out.push('deadlineCalendar');
    // deadlines into a calendar of Mail (1.17.0): while Mail's calendar_add is reachable and takes Drive
    if (await deadlines.mailReachable(ctx.gc)) out.push('deadlineMailCalendar');
  }
  if (await imports.sources(ctx.gc, ctx.settings)) out.push('cloudImport');
  // office in the browser (1.9.0): only while an office server is set up and GateControl has public endpoints
  if (await office.available(ctx.gc, await ctx.gc.settings.all(), ctx.now).catch(() => false)) out.push('office');
  // a ZIP of a selection and one link for several files (1.12.0): GateControl's public links, while an administrator allows them
  if (await links.usable(ctx.gc)) {
    out.push('zip', 'multiLink');
    // GateControl ≥ 1.215.0: files links with a path per entry — a ZIP and a link of any selection (folders and files)
    if (links.paths(ctx.gc)) out.push('zipMixed');
  }
  // GateControl ≥ 1.215.0 copies media files on the server (gc.media.copy): a copy needs no device
  if (ops.hostCopy(ctx.gc)) out.push('copyServer');
  return out;
}

const THUMBS_MAX = 200;

/**
 * GET nodes/<id>/children?thumbs=1: pictures get `thumb` (kept for older portals) — their preview, or with a
 * GateControl without previews a signed URL of the picture itself (the portal's tiles).
 */
async function withThumbs(ctx, r) {
  let n = 0;
  for (const it of r.items) {
    if (it.isDir || !it.mediaId || !/^image\//.test(String(it.mime || ''))) continue;
    if (it.preview) { it.thumb = it.preview.url; continue; }
    if (n >= THUMBS_MAX) continue;
    n++;
    try { it.thumb = await ctx.gc.media.url(it.mediaId, { user: ctx.viewer, ttlS: files.URL_TTL_S }); } catch { it.thumb = null; }
  }
  return r;
}

async function areaList(ctx) {
  const out = [];
  for (const v of await ctx.visible()) out.push(areaView(ctx, v, await storageOf(ctx.gc, v.area)));
  return { areas: await insights.decorate(ctx, out) };
}

/** A query switch: 1, true, yes. */
const flag = (v) => ['1', 'true', 'yes'].includes(String(v == null ? '' : v).toLowerCase());

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
  // a device the ransomware protection stopped: it may read, not write (guard.js)
  if (guard.writes(m, seg)) {
    const locked = await guard.lockOf(ctx);
    if (locked) throw fail('device_locked', { incident: locked.id });
  }
  if (a === 'me' && seg.length === 1 && m === 'GET') return ok(await me(ctx));
  // the incidents: the person (also without a seat now) and administrators
  if (a === 'guard' && b === 'incidents') return ok(await guardRoute(ctx, m, seg, q));
  // the device's wipes: also without a licence or a seat (they only remove the person's own copies)
  if (a === 'wipes' && seg.length === 1 && m === 'GET') return ok(await wipes.list(ctx));
  if (a === 'wipes' && b === 'done' && seg.length === 2 && m === 'POST') return ok(await wipes.done(ctx, body));
  if (!ctx.licence.valid) throw fail('not_licensed');
  // the overview of the storage: an administrator's of every area also without a seat of their own
  if (a === 'storage') {
    const adminAll = ctx.user && ctx.user.role === 'admin';
    if (!ctx.seat && !(adminAll && (flag(q.all) || m === 'POST'))) throw fail('no_seat');
    if (seg.length === 1 && m === 'GET') return ok(await storage.overview(ctx, q));
    if (b === 'versions' && c === 'prune' && seg.length === 3 && m === 'POST') return ok(await storage.prune(ctx, body));
    throw fail('not_found');
  }
  if (!ctx.seat) throw fail('no_seat');
  await ctx.visible();
  if (a === 'areas' && seg.length === 1 && m === 'GET') return ok(await areaList(ctx));
  if (a === 'changes' && seg.length === 1 && m === 'GET') return ok(await changes.since(ctx, q));
  if (a === 'search' && seg.length === 1 && m === 'GET') return ok(await nodes.search(ctx, q.q, q.area ? String(q.area) : null));
  // the start of Drive (1.18.0)
  if (a === 'overview' && seg.length === 1 && m === 'GET') return ok(await overview.get(ctx));
  if (a === 'nodes') {
    if (seg.length === 1 && m === 'POST') return ok({ node: await nodes.mkdir(ctx, body) });
    if (b === 'by-path' && seg.length === 2 && m === 'GET') return ok({ node: await nodes.byPath(ctx, q.area, q.path) });
    if (seg.length === 2) {
      if (m === 'GET') return ok({ node: await nodes.get(ctx, idArg(b)) });
      if (m === 'PATCH' || m === 'PUT') {
        // { deleteAt } alone: the mark (marks.js); with a name or a parent too: invalid
        if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'deleteAt')) {
          if (body.name != null || body.parentId != null) throw fail('invalid', { field: 'deleteAt' });
          return ok({ node: await marks.set(ctx, idArg(b), body) });
        }
        return ok({ node: await nodes.update(ctx, idArg(b), body) });
      }
      if (m === 'DELETE') {
        // ?after=<seconds>: into the trash later (0: now); `everywhere` only with a delete now
        const after = q.after == null || q.after === '' ? 0 : marks.afterArg(q.after);
        if (after > 0) return ok(await marks.after(ctx, idArg(b), after, q.device == null ? null : String(q.device)));
        return ok(await nodes.trash(ctx, idArg(b), flag(q.everywhere)));
      }
    }
    if (seg.length === 3 && m === 'GET') {
      if (c === 'children') {
        const r = await previews.attach(ctx, await nodes.children(ctx, idArg(b), q));
        return ok(q.thumbs ? await withThumbs(ctx, r) : r);
      }
      if (c === 'content') {
        const got = await files.content(ctx, idArg(b));
        // "Zuletzt geöffnet" (1.18.0; best effort)
        await overview.recordOpen(ctx, await nodes.row(ctx.gc, idArg(b)));
        return ok(got);
      }
      if (c === 'versions') return ok(await files.versions(ctx, idArg(b)));
      if (c === 'timetravel') return ok(await timetravel.preview(ctx, idArg(b), q));
    }
    if (seg.length === 3 && c === 'timetravel' && m === 'POST') return ok(await timetravel.run(ctx, idArg(b), body));
    if (seg.length === 3 && c === 'office' && m === 'POST') {
      const got = await office.open(ctx, idArg(b));
      await overview.recordOpen(ctx, await nodes.row(ctx.gc, idArg(b)));
      return ok(got);
    }
    // what is on a photo (1.14.0, labels.js)
    if (seg.length === 3 && c === 'labels' && m === 'PUT') return ok(await labels.put(ctx, b, body));
    // where it was taken, the faces on it (1.16.0 — places.js, faces.js)
    if (seg.length === 3 && c === 'geo' && m === 'PUT') return ok(await places.put(ctx, b, body));
    if (seg.length === 3 && c === 'faces' && m === 'PUT') return ok(await faces.put(ctx, b, body));
    if (c === 'versions' && seg.length >= 4) {
      if (seg.length === 4 && m === 'DELETE') return ok(await files.deleteVersion(ctx, idArg(b), idArg(d)));
      if (seg.length === 5 && e === 'content' && m === 'GET') return ok(await files.versionContent(ctx, idArg(b), idArg(d)));
      if (seg.length === 5 && e === 'restore' && m === 'POST') return ok({ node: await files.restoreVersion(ctx, idArg(b), idArg(d)) });
    }
  }
  if (a === 'vaults') return ok(await vaultRoute(ctx, m, seg, q, body));
  if (a === 'photos' && m === 'GET') {
    if (seg.length === 1) return ok(await photos.list(ctx, q));
    if (seg.length === 2 && b === 'months') return ok(await photos.months(ctx, q));
    if (seg.length === 2 && b === 'memories') return ok(await photos.memories(ctx, q));
    if (seg.length === 2 && b === 'camera') return ok(await photos.camera(ctx));
    if (seg.length === 2 && b === 'classes') return ok(await photos.classes(ctx, q));
    if (seg.length === 2 && b === 'settings') return ok(await work.get(ctx));
    // places and people (1.16.0)
    if (seg.length === 2 && b === 'places') return ok(await photos.placeList(ctx, q));
    if (seg.length === 2 && b === 'map') return ok(await photos.mapOf(ctx, q));
    if (seg.length === 2 && b === 'suggest') return ok(await photos.suggest(ctx, q));
  }
  if (a === 'photos' && seg.length === 2 && b === 'geo' && m === 'DELETE') return ok(await places.removeMine(ctx));
  if (a === 'people') return ok(await peopleRoute(ctx, m, seg, q, body));
  if (a === 'faces' && seg.length === 3 && c === 'move' && m === 'POST') return ok(await faces.move(ctx, b, body));
  if (a === 'photos' && seg.length === 2 && b === 'camera' && m === 'POST') return ok(await photos.makeCamera(ctx));
  if (a === 'photos' && seg.length === 2 && b === 'settings' && (m === 'PUT' || m === 'PATCH')) return ok(await work.put(ctx, body));
  if (a === 'photos' && seg.length === 2 && b === 'review' && m === 'POST') return ok(await work.review(ctx, body));
  if (a === 'albums') {
    if (seg.length === 1 && m === 'GET') return ok(await albums.list(ctx));
    if (seg.length === 1 && m === 'POST') return ok(await albums.create(ctx, body));
    if (seg.length === 2 && m === 'GET') return ok(await albums.get(ctx, b, q));
    if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) return ok(await albums.update(ctx, b, body));
    if (seg.length === 2 && m === 'DELETE') return ok(await albums.remove(ctx, b));
    if (seg.length === 3 && c === 'items' && m === 'POST') return ok(await albums.addItems(ctx, b, body));
    if (seg.length === 3 && c === 'items' && m === 'DELETE') return ok(await albums.removeItems(ctx, b, body, q));
  }
  if (a === 'devices') {
    if (seg.length === 1 && m === 'GET') return ok(await devices.list(ctx));
    if (seg.length === 2 && m === 'PUT') return ok(await devices.put(ctx, b, body));
    if (seg.length === 2 && m === 'DELETE') return ok(await devices.remove(ctx, b));
    if (seg.length === 3 && c === 'folders' && m === 'PUT') return ok(await devices.setFolders(ctx, b, body));
  }
  if (a === 'uploads' && seg.length === 2 && m === 'POST') {
    if (b === 'check') return ok(await files.check(ctx, body));
    if (b === 'commit') return ok(await files.commit(ctx, body));
  }
  // several at once (1.12.0)
  if (a === 'ops') return ok(await opsRoute(ctx, m, seg, q, body));
  if (a === 'zip' && seg.length === 1 && m === 'POST') return ok(await links.zip(ctx, body));
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
  // AI for documents and the import (1.8.0)
  if (a === 'nodes' && c === 'insight') {
    if (seg.length === 3 && m === 'GET') return ok(await insights.get(ctx, b));
    if (seg.length === 3 && m === 'POST') return ok(await insights.restart(ctx, b));
    if (seg.length === 4 && d === 'apply' && m === 'POST') return ok(await insights.apply(ctx, b, body));
  }
  if (a === 'areas' && seg.length === 2 && (m === 'PATCH' || m === 'PUT')) return ok(await insights.setArea(ctx, b, body));
  if (a === 'deadlines' && seg.length === 1 && m === 'GET') return ok(await deadlines.list(ctx, q));
  if (a === 'deadlines' && seg.length === 3 && c === 'remind' && m === 'POST') return ok(await deadlines.remind(ctx, b, body));
  if (a === 'deadlines' && seg.length === 3 && c === 'remind' && m === 'DELETE') return ok(await deadlines.unremind(ctx, b));
  // AI in Drive (1.14.0): the family calendar, questions, scans as documents
  if (a === 'deadlines' && seg.length === 3 && c === 'calendar' && m === 'POST') return ok(await deadlines.calendar(ctx, b, body));
  // targets of deadlines per area and the calendars to choose from (1.17.0: Familie and Mail)
  if (a === 'deadlines' && seg.length === 2 && b === 'calendars' && m === 'GET') return ok(await deadlines.calendars(ctx));
  if (a === 'deadlines' && seg.length === 2 && b === 'targets' && m === 'GET') return ok(await insights.targets(ctx, (v) => labelOf(ctx, v.area)));
  if (a === 'deadlines' && seg.length === 2 && b === 'targets' && m === 'PUT') return ok(await insights.setTargets(ctx, body, (v) => labelOf(ctx, v.area)));
  if (a === 'ask' && seg.length === 1 && m === 'POST') return ok(await ask.ask(ctx, body));
  if (a === 'scans' && seg.length === 2 && m === 'POST') {
    if (b === 'classify') return ok(await scans.classify(ctx, body));
    if (b === 'convert') return ok(await scans.convert(ctx, body));
    if (b === 'save') return ok(await scans.save(ctx, body));
  }
  if (a === 'import') return ok(await imports.route(ctx, m, seg, q, body));
  throw fail('not_found');
}

/** What a job needs to go on after the answer: its person, and the live events of what it changed (ops.js). */
function opsHooks(gc) {
  return { gc, asPerson: (uid, now) => personContext(gc, uid, now), finish: (c) => after(gc, c, true) };
}

/** people/… (faces.js, since 1.16.0). */
async function peopleRoute(ctx, m, seg, q, body) {
  const [, id, c] = seg;
  if (seg.length === 1 && m === 'GET') return faces.list(ctx);
  if (seg.length === 2 && m === 'GET') return faces.get(ctx, id);
  if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) return faces.patch(ctx, id, body);
  if (seg.length === 3 && c === 'merge' && m === 'POST') return faces.merge(ctx, id, body);
  if (seg.length === 3 && c === 'similar' && m === 'GET') return faces.similar(ctx, id);
  if (seg.length === 3 && c === 'uncertain' && m === 'GET') return faces.uncertain(ctx, id, q);
  if (seg.length === 3 && c === 'confirm' && m === 'POST') return faces.confirm(ctx, id, body);
  throw fail('not_found');
}

/** ops/… (ops.js, since 1.12.0). */
async function opsRoute(ctx, m, seg, q, body) {
  const [, id, c, d] = seg;
  if (seg.length === 2 && id === 'check' && m === 'POST') return ops.check(ctx, body);
  if (seg.length === 1 && m === 'POST') return ops.create(ctx, body, opsHooks(ctx.gc));
  if (seg.length === 1 && m === 'GET') return ops.list(ctx, q);
  if (seg.length === 2 && m === 'GET') return ops.get(ctx, id, q);
  if (seg.length === 2 && m === 'DELETE') return ops.cancel(ctx, id);
  if (seg.length === 3 && c === 'undo' && m === 'POST') return ops.undo(ctx, id, opsHooks(ctx.gc));
  if (seg.length === 3 && c === 'transfers' && m === 'POST') return ops.transfers(ctx, id, body);
  if (seg.length === 4 && c === 'transfers' && m === 'POST') return ops.transferDone(ctx, id, d, body);
  throw fail('not_found');
}

/** vaults/… (vault.js, since 1.9.0). */
async function vaultRoute(ctx, m, seg, q, body) {
  const [, id, c, d, e] = seg;
  if (seg.length === 1 && m === 'GET') return vault.list(ctx);
  if (seg.length === 1 && m === 'POST') return vault.create(ctx, body);
  if (seg.length === 2 && m === 'GET') return vault.get(ctx, id);
  if (seg.length === 3 && c === 'keys' && m === 'GET') return vault.keys(ctx, id, q);
  if (seg.length === 3 && c === 'recovery' && m === 'GET') return vault.recovery(ctx, id);
  if (seg.length === 3 && c === 'recovery' && m === 'PUT') return vault.setRecovery(ctx, id, body);
  if (seg.length === 3 && c === 'rotate' && m === 'POST') return vault.rotate(ctx, id, body);
  if (seg.length === 3 && c === 'devices' && m === 'GET') return vault.devices(ctx, id);
  if (seg.length === 3 && c === 'devices' && m === 'POST') return vault.ask(ctx, id, body);
  if (seg.length === 4 && c === 'devices' && m === 'DELETE') return vault.revoke(ctx, id, d);
  if (seg.length === 5 && c === 'devices' && e === 'approve' && m === 'POST') return vault.approve(ctx, id, d, body);
  throw fail('not_found');
}

/** guard/incidents/… (guard.js). */
async function guardRoute(ctx, m, seg, q) {
  const [, , id, act] = seg;
  if (seg.length === 2 && m === 'GET') return guard.list(ctx, q);
  if (seg.length === 3 && m === 'GET') return guard.get(ctx, id);
  if (seg.length === 4 && m === 'POST' && act === 'release') return guard.release(ctx, id);
  if (seg.length === 4 && m === 'POST' && act === 'undo') return undoIncident(ctx, id);
  throw fail('not_found');
}

/** The undo runs as the incident's person (their rights); its changes are announced like a request's. */
async function undoIncident(ctx, id) {
  const out = await guard.undo(ctx, id, async (uid) => {
    const u = ctx.users.get(uid);
    if (!u) throw fail('not_found');
    const octx = await context(ctx.gc, { id: uid, portal: true, loggedIn: true }, ctx.lang, ctx.now);
    if (!octx.licence.valid) throw fail('not_licensed');
    if (!octx.seat) throw fail('no_seat');
    await octx.visible();
    return octx;
  });
  const { octx, ...answer } = out;
  if (octx) await after(ctx.gc, octx, true);
  return answer;
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
  // new files and versions into the queue of AI for documents (1.8.0; a service call — a request did it already)
  if (done && ctx.insightIds && ctx.insightIds.size) {
    try { await insights.consider(gc, ctx); } catch (e) { gc.log.warn('document queue failed', (e && e.code) || 'error'); }
  }
  if (done) {
    try { await wipes.nudge(gc, ctx); } catch (e) { gc.log.warn('wipe event failed', (e && e.code) || 'error'); }
  }
  // the ransomware protection: a new incident is told, the live event 'guard' (also after a release or an undo)
  if (ctx.guardIncident || (ctx.guardEvents && ctx.guardEvents.length)) {
    try { await guard.announce(gc, ctx, await address.linkOf(gc, ctx.settings, null, ctx.now)); } catch (e) { gc.log.warn('guard announce failed', (e && e.code) || 'error'); }
  }
  // vault folders (since 1.9.0): a device asks (push + live event 'vault'), approved, a new key
  if ((ctx.vaultNotes && ctx.vaultNotes.length) || (ctx.vaultEvents && ctx.vaultEvents.length)) {
    try { await vault.announce(gc, ctx, t); } catch (e) { gc.log.warn('vault announce failed', (e && e.code) || 'error'); }
  }
  for (const n of ctx.notes) {
    const lang = (ctx.users.get(n.child) || {}).lang === 'en' ? 'en' : 'de';
    try {
      const a = await areas.row(gc, areas.idOf.child(n.child));
      const go = await linkData(gc, ctx.settings, a && a.root_id, lang);
      await gc.notify({
        topic: 'child_view', users: [n.child], collapseKey: `drive-child-view:${n.viewer}`,
        title: t(lang, 'child_view.title', { name: nameOf(ctx, n.viewer) }), body: t(lang, 'child_view.body', { child: nameOf(ctx, n.child) }),
        data: { drive: { area: areas.idOf.child(n.child), ...(a && a.root_id ? { node: a.root_id } : {}) }, ...go },
      });
    } catch (e) { gc.log.warn('child note failed', (e && e.code) || 'error'); }
  }
}

/**
 * A kiosk device (since 1.7.0): `GET frame` — the pictures of the frame albums (frame.js) — and nothing else (403).
 * The pictures are those the person who switched an album on may read now, as preview-only URLs.
 */
async function kioskRequest(gc, req, seg, now) {
  const user = req.user;
  const m = String(req.method || 'GET').toUpperCase();
  if (!(m === 'GET' && seg.length === 1 && seg[0] === 'frame')) throw fail('forbidden');
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || user.portal !== true || user.loggedIn !== true || user.app === true) throw fail('forbidden');
  const [settings, users, lic] = await Promise.all([gc.settings.all(), people.users(gc), people.licence(gc)]);
  if (!users.get(user.id)) throw fail('forbidden');
  return frame.show(gc, user, {
    settings, users, licensed: lic.valid,
    asPerson: async (uid) => {
      if (!users.get(uid)) return null;
      const c = await context(gc, { id: uid, portal: true, loggedIn: true }, 'de', now);
      return c.licence.valid && c.seat && c.user ? c : null;
    },
  });
}

/** The section "Fotorahmen": a kiosk device allowed to show the frame, while an album is on it. */
async function frameVisible(gc, user) {
  if (user.kiosk !== true || user.loggedIn === false) return false;
  const [settings, users, lic] = await Promise.all([gc.settings.all(), people.users(gc), people.licence(gc)]);
  if (!lic.valid || !frame.allowed(frame.settingsOf(settings), user, users)) return false;
  return frame.any(gc);
}

/**
 * The direct link of a notification (since 1.6.0): data.link (absolute, when Drive knows the address) and the button
 * "Öffnen" (open_portal — GateControl opens the portal tab; the node travels as ?drive=<id>, address.js).
 */
async function linkData(gc, settings, nodeId, lang) {
  let link = null;
  try { link = await address.linkOf(gc, settings, nodeId == null ? null : nodeId); } catch { link = null; }
  return {
    ...(link ? { link } : {}),
    actions: [{ id: 'open', type: 'open_portal', label: t(lang, 'notify.open'), target: nodeId == null ? address.drivePath() : address.nodePath(nodeId) }],
  };
}

/**
 * admin/guard/incidents[/<id>[/release|/undo]] — an administrator in GateControl's admin UI: every incident, release,
 * undo (guard.js; the undo runs as the incident's person).
 */
async function adminGuard(gc, req, seg, lang, now) {
  const m = String(req.method || 'GET').toUpperCase();
  const users = await people.users(gc);
  const settings = await areas.settingsOf(gc);
  const ctx = { gc, viewer: req.user.id, user: { ...(users.get(req.user.id) || {}), role: 'admin' }, users, settings, lang: lang === 'en' ? 'en' : 'de', now, app: false, deviceId: null, touched: new Set(), notes: [], guardOn: settings.guardOn };
  let done = false;
  try {
    const out = await guardRoute(ctx, m, seg.slice(1), { all: '1', ...(req.query || {}) });
    done = true;
    return ok(out);
  } finally {
    if (done) await after(gc, ctx, true);
  }
}

module.exports = {
  async start(gc) {
    overview.reset();
    // the history of names and folders (time travel) starts with the first start of 1.7.0
    try { await timetravel.historySince(gc, Date.now()); } catch (e) { gc.log.warn('history start failed', (e && e.code) || 'error'); }
    // vault folders of older versions into the top folder of their area (1.11.0; the background run keeps it so)
    try {
      const touched = await vault.toRoots(gc, Date.now());
      if (touched.size) await changes.announce(gc, touched, await areas.settingsOf(gc));
    } catch (e) { gc.log.warn('vaults to the top folder failed', (e && e.code) || 'error'); }
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
        // the incidents of the ransomware protection (guard.js): as an administrator of the portal would
        if (seg[1] === 'guard' && seg[2] === 'incidents') return await adminGuard(gc, req, seg, lang, now);
        return ok(await admin.route(gc, req, seg, req.user, now));
      }
      if (seg[0] === 'portal' && seg.length > 1) seg = seg.slice(1); // the same routes under portal/…
      // a kiosk device (the wall tablet): the photo frame and nothing else
      if (req.user && req.user.kiosk === true) return ok(await kioskRequest(gc, req, seg, now));
      const no = refusal(req.user);
      if (no) throw fail(no);
      const ctx = await context(gc, req.user, lang, now);
      if (!ctx.user) throw fail('forbidden');
      // the person's devices that use Drive: the targets of "delete on all devices" (best effort)
      if (ctx.deviceId) {
        try { await wipes.seen(gc, ctx.viewer, ctx.deviceId, req.user.device.platform, now); } catch (e) { gc.log.warn('device record failed', (e && e.code) || 'error'); }
        // the registered device (devices.js) of this token: last seen
        try { await devices.seen(gc, ctx.viewer, ctx.deviceId, now); } catch (e) { gc.log.warn('device seen failed', (e && e.code) || 'error'); }
      }
      let done = false;
      try {
        const out = await route(ctx, req, seg);
        done = true;
        // new files and versions into the queue of AI for documents (1.8.0) — before the answer shows their insight
        if (ctx.insightIds && ctx.insightIds.size) {
          try { await insights.consider(gc, ctx); } catch (e) { gc.log.warn('document queue failed', (e && e.code) || 'error'); }
          ctx.insightIds = null;
        }
        // the ransomware protection: did this device's recent work just turn suspicious? (guard.js; never fails the answer)
        if (ctx.guardNoted) {
          try { ctx.guardIncident = await guard.check(ctx); } catch (e) { gc.log.warn('guard check failed', (e && e.code) || 'error'); }
        }
        // every file node gets its preview (previews.js; nodes that have one already are left alone)
        if (out && out.json && out.json.ok) await previews.attach(ctx, out.json);
        // where a picture was taken (since 1.16.0 — places.js)
        if (out && out.json && out.json.ok) {
          try { await places.attach(ctx, previews.nodesOf(out.json)); } catch (e) { gc.log.warn('places failed', (e && e.code) || 'error'); }
        }
        // where a file came from (since 1.15.0: saved from a mail — mail.js)
        if (out && out.json && out.json.ok) {
          try { await mail.attach(ctx, previews.nodesOf(out.json)); } catch (e) { gc.log.warn('sources failed', (e && e.code) || 'error'); }
        }
        // and, with AI for documents (1.8.0), the short form of its insight
        if (out && out.json && out.json.ok) {
          try { await insights.attach(ctx, out.json); } catch (e) { gc.log.warn('insights failed', (e && e.code) || 'error'); }
        }
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

  /**
   * Services for other plugins (services.js): list_areas, save_file — and since 1.15.0 for GateControl Mail (mail.js):
   * suggest_folder, give_file, share_link, browse — for the person of the call (userId).
   */
  async service({ name, caller, user, payload } = {}, gc) {
    if (!Object.prototype.hasOwnProperty.call(SERVICES, name)) return { ok: false, code: 'not_found' };
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return { ok: false, code: 'invalid' };
    const lang = payload && payload.lang === 'en' ? 'en' : 'de';
    let ctx = null;
    try {
      ctx = await context(gc, { ...user, loggedIn: true }, lang, Date.now());
      ctx.deviceId = typeof caller === 'string' && DEVICE_RE.test(caller) ? caller : null;
      if (!ctx.user) throw fail('forbidden');
      if (!ctx.licence.valid) throw fail('not_licensed');
      if (!ctx.seat) throw fail('no_seat');
      await ctx.visible();
      const out = await SERVICES[name](ctx, payload, caller);
      await after(gc, ctx, true);
      return { ok: true, ...out };
    } catch (e) {
      if (ctx) await after(gc, ctx, false);
      if (!isKnown(e) && !(e && HOST_CODES[e.code])) gc.log.warn('service failed', name, (e && (e.code || e.message)) || 'error');
      return { ok: false, code: isKnown(e) ? e.code : (e && HOST_CODES[e.code]) || 'internal' };
    }
  },

  /** The portal tab "Drive": people switched on (not a kiosk device); the section "Fotorahmen": kiosk devices (1.7.0). */
  async portalVisible({ user, section } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id)) return false;
    if (section === 'frame') return frameVisible(gc, user);
    if (section || user.kiosk === true) return false;
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
      // the direct link: the file that came in (its folder opens with it), else the link's folder
      const got = typeof arg.mediaId === 'string' ? await store.one(gc, 'SELECT id FROM nodes WHERE media_id = ? AND deleted_at IS NULL', [arg.mediaId]) : null;
      const go = await linkData(gc, await areas.settingsOf(gc), got ? got.id : r.row.node_id, lang);
      await gc.notify({
        topic: 'link_upload', users: [owner.id], collapseKey: `drive-link:${arg.token}`,
        title: t(lang, 'link_upload.title', { file: String(arg.name || '') }),
        body: t(lang, 'link_upload.body', { who: arg.uploader ? String(arg.uploader) : t(lang, 'link_upload.someone'), folder }),
        data: { drive: { node: r.row.node_id, area: r.row.area_id, ...(got ? { file: got.id } : {}) }, ...go },
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
    try { await office.sweep(gc, Date.now()); } catch (e) { gc.log.warn('office locks sweep failed', (e && e.code) || 'error'); }
    const now = Date.now();
    // reminders and imports (1.8.0) run as their person, and so do the jobs of several at once (1.12.0)
    return jobs.tick(gc, now, { asPerson: (uid) => personContext(gc, uid, now), ops: opsHooks(gc) });
  },

  /**
   * GateControl's public endpoints (≥ 1.211.0, permissions.publicEndpoints): the office server's WOPI requests and the
   * portal's "open in the office" (office.js) — no session; GateControl checked the token (one person, one path).
   */
  async publicRequest(req, gc) {
    try {
      return await office.publicRequest(gc, req || {}, async (uid) => {
        const c = await context(gc, { id: uid, portal: true, loggedIn: true }, req && req.lang, Date.now());
        if (!c.user || !c.licence.valid || !c.seat) return null;
        await c.visible();
        c.after = (done = true) => after(gc, c, done);
        return c;
      });
    } catch (e) {
      gc.log.warn('office request failed', (e && (e.code || e.message)) || 'error');
      return { status: 500, text: 'error' };
    }
  },

  /** The office server's state below the settings (office_url): the discovery read now. */
  async settingsStatus({ lang } = {}, gc) {
    try { return await office.status(gc, await gc.settings.all(), lang === 'en' ? 'en' : 'de', t); } catch { return []; }
  },

  /** A new office address: read its discovery again. */
  async settingsChanged(values, gc) {
    try { if (office.officeUrl(await gc.settings.all())) await office.refreshDiscovery(gc); } catch (e) { gc.log.warn('office discovery failed', (e && e.code) || 'error'); }
  },
};
