'use strict';

// gatecontrol-gatedrop — "GateDrop": sharing like Quick Share through one's own GateControl server.
// Files (1–20 per send, ≤ 2 GB each), a text (≤ 20 000 characters) or a link go to
//   people        as a message of the sender in the Messenger (service send_file; without it a push),
//   own devices   directly on the same Wi-Fi when possible (contract C: tickets, keys, candidates brokered
//                 here, the bytes never pass the server), otherwise through the server (push + download),
//   NAS folders   through the Synology plugin (services list_drop_folders, save_file),
//   outsiders     as a public link of GateControl (gc.publicLinks: expiry, optional PIN).
// Received files stay 7 days on the server (background). Links and NAS: administrators and Familie's
// parents (service family_roles); people and own devices: every account, never a kiosk device.
//
//   app API   /api/v1/client/plugins/gatecontrol-gatedrop/api/…   (the device token's owner, user.device)
//   portal    /api/v1/portal/plugins/gatecontrol-gatedrop/api/…   (the same routes; also under portal/…)
//     GET targets · PUT presence · POST sends · GET sends/<id> · POST sends/<id>/items · POST sends/<id>/opened
//     GET transfers/<id> · POST transfers/<id>/result · GET pending · GET inbox?kind= · GET items/<mediaId>
//     DELETE links/<token>
//   admin     admin/overview (administrators in the admin UI)
// The full contract (bodies, answers, codes, pushes) is in README.md "App-API".
//
// Needs GateControl ≥ 1.193.0 (media up to 2 GB, gc.devices, gc.notify devices/silent, gc.media.handOver,
// gc.publicLinks).

const ui = require('./ui');
const store = require('./store');
const people = require('./people');
const presence = require('./presence');
const sends = require('./sends');
const transfers = require('./transfers');
const admin = require('./admin');
const jobs = require('./jobs');
const bg = require('./bg');
const net = require('./net');
const { t } = require('./text');
const { STATUS, fail, isKnown, iso, DEVICE_RE } = require('./util');

const ID = 'gatecontrol-gatedrop';

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : 'internal';
  return { status: STATUS[code], json: { ok: false, code, error: t(lang, 'error.' + code) } };
}

/** A person who may share: a signed-in portal viewer or an app user — never a kiosk device, never the admin UI. */
function refusal(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return 'forbidden';
  if (user.portal !== true && user.app !== true) return 'forbidden';
  if (user.kiosk === true) return 'forbidden';
  if (user.loggedIn !== true) return 'login_required';
  return null;
}

async function context(gc, user, lang, now) {
  const users = await people.users(gc);
  const u = users.get(user.id);
  const deviceId = user.app === true && user.device && typeof user.device.id === 'string' && DEVICE_RE.test(user.device.id) ? user.device.id : null;
  return {
    gc, viewer: user.id, user: u || { id: user.id, name: user.name || null, role: user.role }, deviceId, deviceName: null,
    lang: lang === 'en' ? 'en' : 'de', now, portal: user.app !== true, users,
  };
}

/** GET targets — what this person can send to right now (see README). */
async function targets(ctx) {
  const { gc } = ctx;
  const share = await people.canShare(gc, ctx.user, ctx.now);
  const kiosk = await people.kioskIds(gc);
  const list = [...ctx.users.values()].filter((u) => u.id !== ctx.viewer && !kiosk.has(u.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'))
    .map((u) => ({ id: u.id, name: u.name, avatar: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null, kind: 'user' }));
  const r = await people.roles(gc, ctx.now);
  if (r && [...r.parents, ...r.children].includes(ctx.viewer)) list.unshift({ id: 'family', name: t(ctx.lang, 'family'), avatar: null, initials: null, colorHex: null, kind: 'family' });
  const me = ctx.deviceId ? await presence.get(gc, ctx.deviceId, ctx.viewer, ctx.now) : null;
  const devices = [];
  for (const d of await people.devicesOf(gc, ctx.viewer)) {
    if (d.id === ctx.deviceId) continue;
    const p = await presence.plan(gc, me, d, ctx.viewer, ctx.now);
    devices.push({ id: d.id, name: d.name, platform: d.platform, online: d.online, direct: p.direct === true, ...(p.direct ? { mode: p.mode } : {}) });
  }
  const nas = share ? await people.folders(gc, ctx.now) : [];
  const enabled = await people.linksEnabled(gc, ctx.viewer, ctx.now);
  let usage = null;
  try { usage = await gc.media.usage(); } catch { usage = null; }
  return {
    me: { id: ctx.viewer, name: ctx.user.name, canLink: share, canNas: share, deviceId: ctx.deviceId },
    people: list, devices, nas, links: { enabled },
    messenger: await people.available(gc, people.MESSENGER, 'send_file'),
    limits: {
      maxItems: sends.LIMITS.items, maxBytes: usage ? usage.maxBytes : sends.LIMITS.maxBytes, types: usage ? usage.types : [], textMax: sends.LIMITS.textMax,
      noteMax: sends.LIMITS.noteMax, retentionDays: sends.LIMITS.retentionDays, linkExpires: ['1h', '1d', '7d', 'once'],
      directPort: net.DEFAULT_PORT, presenceEveryS: presence.REPORT_EVERY_S, ticketS: transfers.TICKET_MS / 1000,
    },
    storage: usage ? { bytes: usage.bytes, quota: usage.quota } : null,
    serverTime: iso(ctx.now),
  };
}

const ok = (body) => ({ status: 200, json: { ok: true, ...body } });

async function route(ctx, req, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const [a, b, c] = seg;
  if (a === 'targets' && seg.length === 1 && m === 'GET') return ok(await targets(ctx));
  if (a === 'presence' && seg.length === 1 && (m === 'PUT' || m === 'POST')) return ok({ presence: await presence.put(ctx, req.body) });
  if (a === 'sends') {
    if (seg.length === 1 && m === 'POST') {
      if (ctx.deviceId) {
        const d = (await people.devicesOf(ctx.gc, ctx.viewer)).find((x) => x.id === ctx.deviceId);
        ctx.deviceName = d ? d.name : null;
      }
      return ok(await sends.create(ctx, req.body));
    }
    if (seg.length === 2 && m === 'GET') return ok({ send: await sends.get(ctx, b) });
    if (seg.length === 3 && c === 'items' && m === 'POST') return ok(await sends.addItems(ctx, b, req.body));
    if (seg.length === 3 && c === 'opened' && m === 'POST') return ok({ send: await sends.opened(ctx, b) });
  }
  if (a === 'transfers' && seg.length >= 2) {
    if (!ctx.deviceId) throw fail('no_device');
    if (seg.length === 2 && m === 'GET') return ok({ transfer: await transfers.get(ctx, b) });
    if (seg.length === 3 && c === 'result' && m === 'POST') {
      ctx.senderName = ctx.user.name;
      const r = await transfers.result(ctx, b, req.body);
      const d = r.delivery;
      return ok({ transfer: r.transfer, delivery: { id: d.id, kind: d.kind, target: d.target, status: d.status, via: d.via || null, error: d.error || null, at: iso(d.at) }, fallback: r.fallback, ...(r.missing ? { missing: r.missing } : {}) });
    }
  }
  if (a === 'pending' && seg.length === 1 && m === 'GET') return ok(await sends.pending(ctx));
  if (a === 'inbox' && seg.length === 1 && m === 'GET') return ok(await sends.inbox(ctx, req.query));
  if (a === 'items' && seg.length === 2 && m === 'GET') return ok(await sends.itemInfo(ctx, b, ID));
  if (a === 'links' && seg.length === 2 && m === 'DELETE') return ok(await sends.endLink(ctx, b));
  throw fail('not_found');
}

module.exports = {
  async start(gc) {
    people.reset();
    jobs.state.ticking = false;
    gc.log.info('gatedrop started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang;
    try {
      let seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) throw fail('not_found');
      const now = Date.now();
      if (seg[0] === 'admin') {
        if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') throw fail('forbidden');
        if (seg[1] === 'overview' && seg.length === 2 && String(req.method || 'GET').toUpperCase() === 'GET') return ok(await admin.overview(gc, req.user, now));
        throw fail('not_found');
      }
      if (seg[0] === 'portal' && seg.length > 1) seg = seg.slice(1); // the same routes under portal/…
      const no = refusal(req.user);
      if (no) {
        if (req.user && req.user.kiosk === true && Number.isSafeInteger(req.user.id)) await people.markKiosk(gc, req.user.id, now);
        throw fail(no);
      }
      const ctx = await context(gc, req.user, lang, now);
      if (!ctx.users.has(ctx.viewer)) throw fail('forbidden');
      await people.touch(gc, req.user, lang, now);
      return await route(ctx, req, seg);
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 2).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab "GateDrop": every signed-in account — not a kiosk device (a wall tablet is no person). */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    if (user && user.kiosk === true && Number.isSafeInteger(user.id)) {
      try { await people.markKiosk(gc, user.id); } catch { /* shown or not, nothing else depends on it */ }
      return false;
    }
    return !!user;
  },

  /**
   * Who may read a file (the apps' GET …/media/<id>): the sender and the recipients of its send until it expires;
   * a file not (yet) part of a send: its uploader.
   */
  async mediaAccess({ user, mediaId, owner } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id) || user.kiosk === true) return false;
    const now = Date.now();
    const known = await store.one(gc, 'SELECT 1 AS x FROM items WHERE media_id = ?', [mediaId]);
    if (!known) return owner != null && owner === user.id;
    return !!(await sends.fileAccess({ gc, viewer: user.id, now }, mediaId));
  },

  /**
   * GateControl's public link route (hook publicLinkEvent { token, event, file, zip, downloads }): a download, a lock after
   * 5 wrong PINs → the owner is told (topic link); the expiry → the link delivery is expired.
   */
  async publicLinkEvent(arg, gc) {
    const token = arg && typeof arg.token === 'string' ? arg.token : null;
    const ev = arg && arg.event;
    const l = token ? await store.one(gc, 'SELECT * FROM links WHERE token = ?', [token]) : null;
    if (!l) return;
    const now = Date.now();
    const lang = await people.langOf(gc, l.user_id);
    const title = l.title || 'GateDrop';
    const push = async (key, body) => {
      try {
        await gc.notify({ topic: 'link', title: t(lang, key, { title }), body, users: [l.user_id], collapseKey: `gatedrop-link:${token}`, data: { gatedrop: { link: token, send: l.send_id } } });
      } catch (e) { gc.log.warn('link push failed', (e && e.code) || 'error'); }
    };
    if (ev === 'download') {
      // GateControl passes the count of all files (the ZIP counts one of each)
      const n = Number.isSafeInteger(arg.downloads) && arg.downloads > 0 ? arg.downloads : l.downloads + 1;
      await store.run(gc, 'UPDATE links SET downloads = ? WHERE token = ?', [n, token]);
      await push('link.downloaded', t(lang, 'link.downloaded_body', { n }));
    } else if (ev === 'locked') {
      await store.run(gc, 'UPDATE links SET locked = 1 WHERE token = ?', [token]);
      await push('link.locked', t(lang, 'link.locked_body'));
    } else if (ev === 'expired') {
      await store.run(gc, "UPDATE deliveries SET status = 'expired', at = ? WHERE send_id = ? AND kind = 'link' AND target = ? AND status = 'delivered'", [now, l.send_id, token]);
    }
  },

  async tick(gc) {
    return jobs.tick(gc, Date.now());
  },

  /** Tests: wait for the work after an answer (NAS uploads). */
  _idle: () => bg.idle(),
};
