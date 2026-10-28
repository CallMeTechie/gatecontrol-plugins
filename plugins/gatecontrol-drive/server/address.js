'use strict';

// Direct links into the portal (since 1.6.0): `GET me` answers links { node, drive } — absolute addresses of the
// portal tab "Drive", `node` with the placeholder {id} the apps replace by a node id (a folder opens, a file opens
// its folder and shows the file).
//
//   drive   <origin>/portal#plg-gatecontrol-drive
//   node    <origin>/portal?drive={id}#plg-gatecontrol-drive
//
// `#plg-<id>` is how GateControl opens a plugin's portal tab (its notifications do the same, open_portal). The node
// travels as the portal's query parameter `drive`: GateControl 1.208.0 opens the Drive tab with such a link, but
// hands the parameter on to no plugin frame (the frame's src is fixed, the frame has an opaque origin and no
// referrer). The portal tab reads `drive` from its own frame address (location.search or location.hash), so it opens
// the node as soon as GateControl passes the parameter on — until then the link opens the Drive tab.
//
// The origin: the setting portal_url (an administrator's own address), else the public address GateControl builds
// its public links on (GC_BASE_URL, https and public — the plugin learns it from the URL of a public link, there is
// no host call for it), kept in gc.storage. Neither: links null.

const KEY = 'public_origin';
const TRY_EVERY_MS = 3600000;
const PLUGIN = 'gatecontrol-drive';
const HASH = `#plg-${PLUGIN}`;

// when the public links were last asked, per host (gc)
const tried = new WeakMap();

/** The origin of an http(s) address (no user info), else null. */
function originOf(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 500) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !u.hostname) return null;
  return u.origin;
}

/** A public link's URL ('<origin>/s/<token>') was seen: remember its origin (best effort). */
async function learn(gc, url) {
  const o = typeof url === 'string' && /\/s\/[A-Za-z0-9_-]+$/.test(url) ? originOf(url) : null;
  if (!o) return null;
  try {
    const cur = await gc.storage.get(KEY);
    if (cur !== o) await gc.storage.set(KEY, o);
  } catch { /* best effort */ }
  return o;
}

/** Ask GateControl's public links for the address (at most once an hour per process; links off → nothing). */
async function probe(gc, now) {
  const last = tried.get(gc);
  if (last != null && now - last < TRY_EVERY_MS && now >= last) return null;
  tried.set(gc, now);
  const pl = gc.publicLinks;
  if (!pl || typeof pl.list !== 'function') return null;
  let list;
  try { list = await pl.list({}); } catch { return null; }
  for (const l of Array.isArray(list) ? list : []) {
    if (l && typeof l.url === 'string') return learn(gc, l.url);
  }
  return null;
}

/** The origin direct links are built on, or null. */
async function origin(gc, settings, now = Date.now()) {
  const own = originOf(settings && settings.portalUrl);
  if (own) return own;
  let cur = null;
  try { cur = await gc.storage.get(KEY); } catch { cur = null; }
  if (typeof cur === 'string' && originOf(cur)) return cur;
  return probe(gc, now);
}

/** The portal path of node `id` (relative; notifications open it with open_portal). */
const nodePath = (id) => `/portal?drive=${encodeURIComponent(String(id))}${HASH}`;
const drivePath = () => `/portal${HASH}`;

/** links of GET me → { node, drive } | null */
async function links(gc, settings, now) {
  const o = await origin(gc, settings, now);
  return o ? { node: o + nodePath('{id}').replace('%7Bid%7D', '{id}'), drive: o + drivePath() } : null;
}

/** The absolute direct link of node `id` (or of the Drive tab without one), or null. */
async function linkOf(gc, settings, id, now) {
  const o = await origin(gc, settings, now);
  if (!o) return null;
  return o + (id == null ? drivePath() : nodePath(id));
}

module.exports = { origin, links, linkOf, learn, probe, originOf, nodePath, drivePath, KEY };
