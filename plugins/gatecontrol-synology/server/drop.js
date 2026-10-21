'use strict';

// 1.2.0 — the NAS folders GateDrop may save into ("Ablage für GateDrop", set by an administrator) and the
// services for GateDrop (services.provides, caller gatecontrol-gatedrop only — GateDrop decides who may send
// to a NAS: administrators and Familie's parents):
//
//   list_drop_folders {}  → a bare array [{ id, label, path }] — the folders of enabled NAS (a refused caller: [])
//   save_file { user, mediaId, name, path } → { ok: true, path, nasId } | { ok: false, code }
//     mediaId: a file handed over to this plugin (gc.media.handOver, GateControl ≥ 1.193.0) — it is deleted from
//     this plugin's media afterwards, saved or not; path: a drop folder or a folder below it (created); name: the
//     file name (an existing one becomes "name (2).ext"). Uploaded with SYNO.FileStation.Upload through
//     gc.net.uploadTarget (the bytes go from GateControl to the NAS, never through the plugin).
//     Codes: forbidden (another caller), invalid, not_found (no such folder / file), nas_disabled, unsupported
//     (GateControl without uploadTarget), unreachable, auth (the NAS login), permission (DSM refuses the folder),
//     no_space, upload_failed.

const store = require('./store');
const service = require('./service');
const dsm = require('./dsm');

const CALLER = 'gatecontrol-gatedrop';
const SEG_RE = /^[^\0-\x1f\x7f/\\:*?"<>|]{1,100}$/;

/** A File Station folder path: '/share[/folder…]' (≤ 8 segments, no '.'/'..', no characters DSM refuses) or null. */
function cleanPath(v) {
  if (typeof v !== 'string' || v.length > 400 || !v.startsWith('/')) return null;
  const segs = v.split('/').filter(Boolean).map((s) => s.trim());
  if (!segs.length || segs.length > 8 || segs.some((s) => !s || s === '.' || s === '..' || !SEG_RE.test(s))) return null;
  return '/' + segs.join('/');
}

/** A file name for the NAS: no path, no characters DSM refuses, ≤ 200 characters, or null. */
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\0-\x1f\x7f]/g, '').split(/[\\/]/).pop().replace(/[:*?"<>|]/g, '_').trim().replace(/^\.+/, '');
  return s && s.length <= 200 ? s : null;
}

/** Is `p` the folder `base` or below it? */
const within = (p, base) => p === base || p.startsWith(base + '/');

/** The folders of enabled NAS → [{ id, label, path }]. */
async function folders(gc) {
  const nas = new Map((await store.listNas(gc)).map((n) => [n.id, n]));
  return (await store.listFolders(gc)).filter((f) => nas.has(f.nas_id) && nas.get(f.nas_id).enabled).map((f) => ({ id: f.id, label: f.label, path: f.path }));
}

/** DsmError code → save_file code. */
function codeOf(e) {
  const c = e && e.code;
  if (c === 'UNSUPPORTED') return 'unsupported';
  if (dsm.NET_CODES.has(c)) return 'unreachable';
  if (dsm.AUTH_CODES.has(c)) return 'auth';
  if (c === 'PERMISSION' || (e && [105, 403, 405, 407].includes(e.dsm))) return 'permission';
  if (e && [415, 416].includes(e.dsm)) return 'no_space';
  if (e && [408, 418, 419].includes(e.dsm)) return 'not_found';
  return 'upload_failed';
}

async function saveFile(gc, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const mediaId = typeof p.mediaId === 'string' && /^[0-9a-f]{32}$/.test(p.mediaId) ? p.mediaId : null;
  const done = async () => { if (mediaId) { try { await gc.media.delete(mediaId); } catch { /* removed by GateControl after 24 h */ } } };
  try {
    const name = cleanName(p.name);
    const dir = cleanPath(p.path);
    if (!mediaId || !name || !dir || !(Number.isSafeInteger(p.user) && p.user > 0)) return { ok: false, code: 'invalid' };
    const all = await store.listFolders(gc);
    const folder = all.filter((f) => within(dir, f.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!folder) return { ok: false, code: 'not_found' };
    const nas = await store.getNas(gc, folder.nas_id);
    if (!nas) return { ok: false, code: 'not_found' };
    if (!nas.enabled) return { ok: false, code: 'nas_disabled' };
    let info = null;
    try { info = await gc.media.info(mediaId); } catch { info = null; }
    if (!info) return { ok: false, code: 'not_found' };
    if (!gc.net || typeof gc.net.uploadTarget !== 'function') return { ok: false, code: 'unsupported' };
    try {
      const r = await service.saveFile(gc, nas, { dir, name, mediaId });
      gc.log.info('GateDrop file saved', nas.id, folder.id);
      return { ok: true, path: `${r.dir}/${r.name}`, nasId: nas.id };
    } catch (e) {
      const code = codeOf(e);
      gc.log.warn('GateDrop upload failed', nas.id, (e && e.code) || 'error', e && e.dsm != null ? e.dsm : '');
      return { ok: false, code };
    }
  } finally {
    await done();
  }
}

/** The hook service({ name, caller, user, payload }). */
async function handle(gc, call) {
  const c = call && typeof call === 'object' ? call : {};
  if (c.name === 'list_drop_folders') return c.caller === CALLER ? folders(gc) : [];
  if (c.name === 'save_file') {
    if (c.caller !== CALLER) {
      const id = c.payload && c.payload.mediaId;
      if (typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) { try { await gc.media.delete(id); } catch { /* ignore */ } }
      return { ok: false, code: 'forbidden' };
    }
    return saveFile(gc, c.payload);
  }
  return { ok: false, code: 'not_found' };
}

module.exports = { handle, folders, cleanPath, cleanName, within, CALLER };
