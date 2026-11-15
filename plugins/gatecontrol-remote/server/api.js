'use strict';

// The portal tab "Fernzugriff" and the profile section (a signed-in person):
// the devices the person may reach with their state, "Verbinden" (a ticket of
// GateControl's session page), wake-on-LAN, and the person's own rights.
// Rights are checked on every call (rights.js).

const devices = require('./devices');
const rights = require('./rights');
const connect = require('./connect');
const maintenance = require('./maintenance');
const { fail, iso } = require('./util');

function personOf(req) {
  const u = req.user;
  if (!u || !Number.isSafeInteger(u.id) || u.loggedIn === false || u.kiosk === true || u.automation === true) throw fail('forbidden');
  return u;
}

/** A device as the portal shows it — no address, no secret. */
function deviceView(d) {
  return {
    id: d.id, name: d.name, protocol: d.protocol, description: d.config.description || null,
    online: d.status.online, lastCheck: iso(d.status.lastCheck), browser: !!d.config.browser_enabled,
    maintenance: maintenance.inWindow(d.config), wake: !!(d.config.wol_enabled && d.config.wol_mac_address),
    credentialUnreadable: d.credentialUnreadable, tags: d.config.tags || [],
  };
}

/** The devices this person may use (administrators: every enabled one). */
async function mine(gc, user) {
  const r = await rights.of(gc, user);
  const lists = await devices.accessLists(gc);
  const out = [];
  for (const d of await devices.all(gc)) {
    if (await rights.mayUse(gc, user, d, lists.get(d.id) || devices.emptyAccess(), { rights: r })) out.push(d);
  }
  return { rights: r, list: out };
}

async function visibleFor(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  const r = await rights.of(gc, user);
  return r.rdp || r.ssh;
}

async function overview(gc, user) {
  const { rights: r, list } = await mine(gc, user);
  return {
    rights: { rdp: r.rdp, ssh: r.ssh, support: r.support, share: r.share },
    devices: list.map(deviceView),
    hasRemote: !!gc.remote,
  };
}

/** The profile section: what the person may do and how many devices that reaches. */
async function profile(gc, user) {
  const { rights: r, list } = await mine(gc, user);
  return {
    rights: { rdp: r.rdp, ssh: r.ssh, support: r.support, share: r.share }, source: r.source, admin: user.role === 'admin',
    devices: { total: list.length, rdp: list.filter((d) => rights.rightFor(d.protocol) === 'rdp').length, ssh: list.filter((d) => rights.rightFor(d.protocol) === 'ssh').length },
  };
}

async function route(req, gc, seg, cfg) {
  const m = String(req.method || 'GET').toUpperCase();
  const user = personOf(req);
  if (seg[0] === 'overview' && m === 'GET' && seg.length === 1) return overview(gc, user);
  if (seg[0] === 'profile' && m === 'GET' && seg.length === 1) return profile(gc, user);
  if (seg[0] === 'devices' && seg.length === 3 && m === 'POST') {
    if (seg[2] === 'connect') return { session: await connect.open(gc, user, seg[1], cfg, { admin: false }) };
    if (seg[2] === 'wake') return { wake: await connect.wake(gc, user, seg[1], { admin: false }) };
  }
  throw fail('not_found');
}

module.exports = { route, visibleFor, overview, profile, deviceView };
