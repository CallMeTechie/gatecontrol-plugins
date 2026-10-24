'use strict';

// gatecontrol-vault — "Vault": an end-to-end encrypted password manager on one's own GateControl server.
// The apps (Android, Windows) and the portal tab (1.1.0, ui/portal.js) encrypt and decrypt; this plugin keeps encrypted blobs, who may open
// which vault (keys sealed to each member), the sync counter, a trash, versions, and emergency access. Nothing here
// can be read without a person's master password, recovery key or a granted emergency access.
//
//   app API   /api/v1/client/plugins/gatecontrol-vault/api/…   (the device token's owner; bodies ≤ 64 KB)
//   portal    /api/v1/portal/plugins/gatecontrol-vault/api/…   (the same routes; also under portal/…)
//     GET/POST/PUT account · POST account/delete · GET people · GET sync
//     POST vaults · PUT/DELETE vaults/<id> · POST vaults/<id>/members · PUT/DELETE vaults/<id>/members/<uid>
//     POST vaults/<id>/rekey/start · POST vaults/<id>/rekey/finish
//     POST items · POST items/<id>/trash · POST items/<id>/restore · DELETE items/<id> · GET items/<id>/history
//     GET/POST emergency · DELETE emergency/<id> · POST emergency/<id>/request|deny|approve
//     GET emergency/<id>/access · GET emergency/<id>/items
//     GET/POST wifi-shares · DELETE wifi-shares/<id>   (1.4.0: a Wi-Fi entry on the wall tablet / portal start page)
//   hooks     portalTiles (the portal Wi-Fi shares as Start tiles) · tick (background, server/jobs.js)
//   admin     admin/overview (administrators in the admin UI: counts, who uses Vault)
// The full contract (bodies, answers, codes, the crypto format) is in README.md.
//
// Every signed-in person may use Vault — never a kiosk device (a wall tablet is no person), never the admin UI.

const store = require('./store');
const people = require('./people');
const account = require('./account');
const vaults = require('./vaults');
const items = require('./items');
const emergency = require('./emergency');
const admin = require('./admin');
const jobs = require('./jobs');
const wifi = require('./wifi');
const ui = require('./ui');
const { t } = require('./text');
const { STATUS, fail, isKnown } = require('./util');

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : 'internal';
  const extra = isKnown(e) && e.extra ? e.extra : {};
  return { status: STATUS[code], json: { ok: false, code, error: t(lang, 'error.' + code), ...extra } };
}

/** A person who may use Vault: a signed-in portal viewer or an app user — never a kiosk device, never the admin UI. */
function refusal(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return 'forbidden';
  if (user.portal !== true && user.app !== true) return 'forbidden';
  if (user.kiosk === true) return 'forbidden';
  if (user.loggedIn !== true) return 'login_required';
  return null;
}

const ok = (body) => ({ status: 200, json: { ok: true, ...body } });

/** GET people — everyone one could share with: their public key once they set up Vault (null before). */
async function directory(ctx) {
  const kiosk = await people.kioskIds(ctx.gc);
  const keys = new Map((await store.all(ctx.gc, 'SELECT user_id, public_key FROM accounts')).map((r) => [r.user_id, r.public_key]));
  const list = [...ctx.users.values()].filter((u) => u.id !== ctx.viewer && !kiosk.has(u.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'))
    .map((u) => ({ id: u.id, name: u.name, publicKey: keys.get(u.id) || null }));
  return { people: list };
}

async function route(ctx, req, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const [a, b, c, d] = seg;
  const n = seg.length;
  if (a === 'account') {
    if (n === 1 && m === 'GET') return ok(await account.get(ctx));
    if (n === 1 && m === 'POST') return ok(await account.create(ctx, req.body));
    if (n === 1 && m === 'PUT') return ok(await account.update(ctx, req.body));
    if (n === 2 && b === 'delete' && m === 'POST') return ok(await account.remove(ctx, req.body));
  }
  if (a === 'people' && n === 1 && m === 'GET') {
    await account.need(ctx.gc, ctx.viewer);
    return ok(await directory(ctx));
  }
  if (a === 'sync' && n === 1 && m === 'GET') return ok(await items.sync(ctx, req.query));
  if (a === 'vaults') {
    if (n === 1 && m === 'POST') return ok(await vaults.create(ctx, req.body));
    if (n === 2 && m === 'PUT') return ok(await vaults.rename(ctx, b, req.body));
    if (n === 2 && m === 'DELETE') return ok(await vaults.remove(ctx, b));
    if (n === 3 && c === 'members' && m === 'POST') return ok(await vaults.addMember(ctx, b, req.body));
    if (n === 4 && c === 'members' && m === 'PUT') return ok(await vaults.setRole(ctx, b, d, req.body));
    if (n === 4 && c === 'members' && m === 'DELETE') return ok(await vaults.removeMember(ctx, b, d));
    if (n === 4 && c === 'rekey' && d === 'start' && m === 'POST') return ok(await vaults.rekeyStart(ctx, b, req.body));
    if (n === 4 && c === 'rekey' && d === 'finish' && m === 'POST') return ok(await vaults.rekeyFinish(ctx, b, req.body));
  }
  if (a === 'items') {
    if (n === 1 && m === 'POST') return ok(await items.save(ctx, req.body));
    if (n === 2 && m === 'DELETE') return ok(await items.purge(ctx, b));
    if (n === 3 && c === 'trash' && m === 'POST') return ok(await items.setTrash(ctx, b, true));
    if (n === 3 && c === 'restore' && m === 'POST') return ok(await items.setTrash(ctx, b, false));
    if (n === 3 && c === 'history' && m === 'GET') return ok(await items.history(ctx, b));
  }
  if (a === 'emergency') {
    if (n === 1 && m === 'GET') return ok(await emergency.list(ctx));
    if (n === 1 && m === 'POST') return ok(await emergency.put(ctx, req.body));
    if (n === 2 && m === 'DELETE') return ok(await emergency.remove(ctx, b));
    if (n === 3 && m === 'POST' && c === 'request') return ok(await emergency.request(ctx, b));
    if (n === 3 && m === 'POST' && c === 'deny') return ok(await emergency.deny(ctx, b));
    if (n === 3 && m === 'POST' && c === 'approve') return ok(await emergency.approve(ctx, b));
    if (n === 3 && m === 'GET' && c === 'access') return ok(await emergency.access(ctx, b));
    if (n === 3 && m === 'GET' && c === 'items') return ok(await emergency.entries(ctx, b, req.query));
  }
  if (a === 'wifi-shares') {
    if (n === 1 && m === 'GET') return ok(await wifi.list(ctx, req.query));
    if (n === 1 && m === 'POST') return ok(await wifi.share(ctx, req.body));
    if (n === 2 && m === 'DELETE') return ok(await wifi.end(ctx, b));
  }
  throw fail('not_found');
}

module.exports = {
  async start(gc) {
    gc.log.info('vault started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang;
    try {
      let seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) throw fail('not_found');
      const now = Date.now();
      if (seg[0] === 'admin') {
        if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') throw fail('forbidden');
        if (seg[1] === 'overview' && seg.length === 2 && String(req.method || 'GET').toUpperCase() === 'GET') return ok(await admin.overview(gc));
        throw fail('not_found');
      }
      if (seg[0] === 'portal' && seg.length > 1) seg = seg.slice(1); // the same routes under portal/…
      const no = refusal(req.user);
      if (no) {
        if (req.user && req.user.kiosk === true && Number.isSafeInteger(req.user.id)) await people.markKiosk(gc, req.user.id, now);
        throw fail(no);
      }
      const users = await people.users(gc);
      if (!users.has(req.user.id) || (await people.kioskIds(gc)).has(req.user.id)) throw fail('forbidden');
      await people.touch(gc, req.user, lang, now);
      const ctx = { gc, viewer: req.user.id, user: users.get(req.user.id), users, lang: lang === 'en' ? 'en' : 'de', now, device: null };
      const out = await route(ctx, req, seg);
      await wifi.flush(gc); // an entry trashed, purged, moved or a vault deleted ended a wall share: the tablet's new set
      return out;
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 2).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  /** The admin page and the portal tab "Vault" (server/ui.js). */
  async render(view) {
    return { html: ui.render(view || {}, t) };
  },

  /** Start tiles: the Wi-Fi shares for the portal's start page (signed-in people only; server/wifi.js). */
  async portalTiles(q, gc) {
    try {
      return await wifi.tiles(gc, q);
    } catch (e) {
      gc.log.warn('portal tiles failed', (e && e.code) || 'error');
      return [];
    }
  },

  /** The portal tab is for people: not shown on a kiosk device (a wall tablet). */
  async portalVisible(q) {
    const user = (q && q.user) || {};
    return user.kiosk !== true;
  },

  async tick(gc) {
    return jobs.tick(gc, Date.now());
  },
};
