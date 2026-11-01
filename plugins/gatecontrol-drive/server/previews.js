'use strict';

// Previews of files (GateControl ≥ 1.208.0, plugin.json media.previews): every file node in an answer gets
// `preview: { url, largeUrl } | null` — a small picture of the node's current media made by GateControl (JPEG, PNG,
// WebP, GIF, AVIF) or sent by the uploading device (HEIC, videos: PUT …/plugins/gatecontrol-drive/media/<mediaId>/preview).
//   app       the apps' endpoint /api/v1/client/plugins/gatecontrol-drive/media/<mediaId>/preview[?size=large] —
//             with the device token, the same rights as the file (hook mediaAccess), cacheable for good per media id
//   portal    a signed /plugin-media/<token>/preview[?size=large] for the frame (like the file's own URL, 1 h)
// null: no preview and none possible (folders, documents, a HEIC without the device's preview, a trashed file). An older
// GateControl without gc.media.previews: every file null — the lists work as before.

const URL_TTL_S = 3600;
const BATCH = 1000;

/**
 * The nodes of an answer body that are files: node, items[], current, changes[].node — and of GET overview (1.18.0)
 * recent[] and activity[].sample.
 */
function nodesOf(body) {
  if (!body || typeof body !== 'object') return [];
  const out = [];
  const add = (n) => { if (n && typeof n === 'object' && typeof n.isDir === 'boolean') out.push(n); };
  add(body.node);
  add(body.current);
  if (Array.isArray(body.items)) body.items.forEach(add);
  if (Array.isArray(body.changes)) body.changes.forEach((c) => add(c && c.node));
  if (Array.isArray(body.recent)) body.recent.forEach(add);
  if (Array.isArray(body.activity)) body.activity.forEach((x) => add(x && x.sample));
  return out.filter((n) => !n.isDir);
}

/** Give every file node of `body` its `preview` (in place; nodes that have one already are left). Never fails the request. */
async function attach(ctx, body) {
  const files = nodesOf(body).filter((n) => !Object.prototype.hasOwnProperty.call(n, 'preview'));
  if (!files.length) return body;
  for (const n of files) n.preview = null;
  const media = ctx.gc.media;
  if (!media || typeof media.previews !== 'function') return body;
  // a vault's file (since 1.9.0) never has one: the server holds only its ciphertext
  const ids = [...new Set(files.filter((n) => !n.deleted && n.mediaId && !n.encrypted).map((n) => n.mediaId))];
  const states = {};
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      Object.assign(states, await media.previews(ids.slice(i, i + BATCH), { user: ctx.viewer, ttlS: URL_TTL_S }));
    }
  } catch (e) {
    ctx.gc.log.warn('previews failed', (e && e.code) || 'error');
    return body;
  }
  for (const n of files) {
    const st = !n.deleted && n.mediaId && !n.encrypted ? states[n.mediaId] : null;
    if (!st) continue;
    const url = ctx.app ? st.appUrl : st.url;
    if (typeof url === 'string' && url) n.preview = { url, largeUrl: `${url}?size=large` };
  }
  return body;
}

/**
 * The previews of media `ids` for the viewer → Map id → { url, largeUrl } (app or frame URL as in attach) or null.
 * o.user: sign for this user instead of the viewer; o.ttlS; o.previewOnly (the photo frame, GateControl ≥ 1.210.0):
 * URLs that open the preview only, never the file — a host that cannot (its state has no previewOnly) gives none at all
 * (→ { ready: false }). Never fails: an error is no preview.
 */
async function urls(ctx, ids, o = {}) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (const id of list) out.set(id, null);
  const media = ctx.gc.media;
  if (!list.length) return { map: out, ready: true };
  if (!media || typeof media.previews !== 'function') return { map: out, ready: !o.previewOnly };
  const states = {};
  try {
    for (let i = 0; i < list.length; i += BATCH) {
      Object.assign(states, await media.previews(list.slice(i, i + BATCH), {
        user: o.user || ctx.viewer, ttlS: o.ttlS || URL_TTL_S, ...(o.previewOnly ? { previewOnly: true } : {}),
      }));
    }
  } catch (e) {
    ctx.gc.log.warn('previews failed', (e && e.code) || 'error');
    return { map: out, ready: !o.previewOnly };
  }
  let ready = true;
  for (const id of list) {
    const st = states[id];
    if (!st) continue;
    if (o.previewOnly && st.previewOnly !== true) { ready = false; continue; }
    const url = ctx.app && !o.previewOnly ? st.appUrl : st.url;
    if (typeof url === 'string' && url) out.set(id, { url, largeUrl: `${url}?size=large` });
  }
  if (!ready) for (const id of list) out.set(id, null);
  return { map: out, ready };
}

module.exports = { attach, urls, nodesOf, URL_TTL_S };
