'use strict';

// The access-target assignments the source dialog made itself (1.4.0) and tidying up unused ones.
//
// The page assigns the home targets through window.GC.targets (GateControl ≥ 1.324.0): `set(id, list)` replaces the
// whole list of a target, a source names its assignment by its position (config.targetIndex, config.webdav.targetIndex,
// config.smb.targetIndex). Removing an assignment in the middle of a list therefore moves the ones behind it: the page
// first renumbers the sources here (compact, one transaction), then sets the shorter list; if that fails it renumbers
// back. Only assignments the dialog made (remembered here when it appends one, rememberMade) are removed in the middle —
// never an address ('host', the administrator's own entry) and never an assignment a source still uses.

const store = require('./store');
const sources = require('./sources');
const { fail } = require('./util');

const TARGETS = ['jellyfin', 'webdav', 'smb'];
const KEY = 'targets_made';
const MAX = 300;
const KEY_RE = /^(jellyfin|webdav|smb):(route:[1-9][0-9]{0,9}|peer:[1-9][0-9]{0,9}:(?:[1-9][0-9]{0,4}|-):https?)$/;

/** The key of an assignment: "<target>:route:<routeId>" or "<target>:peer:<peerId>:<port|->:<scheme>" (null for others). */
function keyOf(target, a) {
  if (!TARGETS.includes(target) || !a || typeof a !== 'object') return null;
  let k = null;
  if (a.kind === 'route' && Number.isSafeInteger(a.routeId) && a.routeId > 0) k = target + ':route:' + a.routeId;
  if (a.kind === 'peer' && Number.isSafeInteger(a.peerId) && a.peerId > 0) k = target + ':peer:' + a.peerId + ':' + (a.port == null ? '-' : a.port) + ':' + (a.scheme === 'https' ? 'https' : 'http');
  return k && KEY_RE.test(k) ? k : null;
}

async function made(gc) {
  const v = await gc.storage.get(KEY);
  return Array.isArray(v) ? v.filter((k) => typeof k === 'string' && KEY_RE.test(k)) : [];
}

/** POST admin/targets/made { target, assignment } — the dialog appended this assignment itself. */
async function rememberMade(gc, b) {
  const k = keyOf(b && b.target, b && b.assignment);
  if (!k) throw fail('invalid', { field: 'assignment' });
  const list = (await made(gc)).filter((x) => x !== k);
  list.push(k);
  await gc.storage.set(KEY, list.slice(-MAX));
  return { made: k };
}

/** The indices of target `target` the sources use. */
function usedOf(all, target) {
  const out = [];
  for (const s of all) {
    const c = s.config || {};
    if (target === 'jellyfin' && s.kind === 'jellyfin') out.push(c.targetIndex || 0);
    if (target !== 'jellyfin' && s.kind === 'share' && c[target] && c[target].targetIndex != null) out.push(c[target].targetIndex);
  }
  return out;
}

/**
 * POST admin/targets/compact { target, map: { "<old index>": <new index>, … }, forget?: [keys] } — renumber the sources'
 * assignments of `target` before the page sets the shorter list (or back, with the inverse map). Every index a source
 * uses must be in the map, the new indices distinct (0…99). → { changed: n } sources renumbered.
 */
async function compact(gc, b, now = Date.now()) {
  const target = b && b.target;
  if (!TARGETS.includes(target)) throw fail('invalid', { field: 'target' });
  const raw = b.map && typeof b.map === 'object' && !Array.isArray(b.map) ? b.map : null;
  if (!raw) throw fail('invalid', { field: 'map' });
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const from = Number(k);
    if (!/^[0-9]{1,2}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 99) throw fail('invalid', { field: 'map' });
    map.set(from, v);
  }
  if (new Set(map.values()).size !== map.size) throw fail('invalid', { field: 'map' });
  const changed = await store.tx(gc, async () => {
    const all = await sources.list(gc);
    // an index in use that the map would drop: the page's view is outdated
    if (usedOf(all, target).some((i) => !map.has(i))) throw fail('conflict');
    let n = 0;
    for (const s of all) {
      const c = s.config || {};
      let next = null;
      if (target === 'jellyfin' && s.kind === 'jellyfin' && map.get(c.targetIndex || 0) !== (c.targetIndex || 0)) next = { ...c, targetIndex: map.get(c.targetIndex || 0) };
      if (target !== 'jellyfin' && s.kind === 'share' && c[target] && c[target].targetIndex != null && map.get(c[target].targetIndex) !== c[target].targetIndex) {
        next = { ...c, [target]: { ...c[target], targetIndex: map.get(c[target].targetIndex) } };
      }
      if (next) { await store.run(gc, 'UPDATE sources SET config = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), now, s.id]); n++; }
    }
    return n;
  });
  const forget = Array.isArray(b.forget) ? b.forget.filter((k) => typeof k === 'string') : [];
  if (forget.length) await gc.storage.set(KEY, (await made(gc)).filter((k) => !forget.includes(k)));
  return { changed };
}

module.exports = { keyOf, made, rememberMade, compact, usedOf, TARGETS };
