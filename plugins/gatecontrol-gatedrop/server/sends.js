'use strict';

// Sends: POST sends (validation, permissions, the deliveries per target), the views of a send for its
// sender and its recipients, the lists (GET inbox), late uploads after a failed direct transfer
// (POST sends/<id>/items), "opened", what an app still has to fetch (GET pending), files (GET items/<mediaId>) and
// ending links (DELETE links/<token>).
// Every function gets ctx = { gc, viewer, user, deviceId, deviceName, lang, now, portal, users (Map), senderName }.

const store = require('./store');
const people = require('./people');
const presence = require('./presence');
const access = require('./access');
const deliver = require('./deliver');
const transfers = require('./transfers');
const jobs = require('./bg');
const { t } = require('./text');
const { fail, posInt, optText, fileName, url, newId, iso, MEDIA_RE, DEVICE_RE } = require('./util');

const LIMITS = Object.freeze({ items: 20, textMax: 20000, noteMax: 500, maxBytes: 2147483648, people: 20, devices: 10, nas: 5, retentionDays: 7 });
const RETENTION_MS = LIMITS.retentionDays * 86400000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const PENDING_MAX = 50;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]{0,39}\/[a-z0-9][a-z0-9.+-]{0,99}$/;
const SEGMENT_RE = /^[^\0-\x1f\x7f/\\:*?"<>|]{1,100}$/;

// ─── parsing ────────────────────────────────────────────────────────────────

function parseItems(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > LIMITS.items) throw fail('invalid');
  const seen = new Set();
  return v.map((x, idx) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw fail('invalid');
    if (x.name != null && typeof x.name !== 'string') throw fail('invalid');
    const name = fileName(x.name);
    if (x.local === true) {
      if (x.mediaId != null || !name) throw fail('invalid');
      if (!Number.isSafeInteger(x.bytes) || x.bytes < 0 || x.bytes > LIMITS.maxBytes) throw fail('invalid');
      if (x.mime != null && !(typeof x.mime === 'string' && MIME_RE.test(x.mime.toLowerCase()))) throw fail('invalid');
      return { idx, local: true, mediaId: null, name, bytes: x.bytes, mime: x.mime == null ? 'application/octet-stream' : x.mime.toLowerCase() };
    }
    if (x.local != null && x.local !== false) throw fail('invalid');
    if (typeof x.mediaId !== 'string' || !MEDIA_RE.test(x.mediaId) || seen.has(x.mediaId)) throw fail('invalid');
    seen.add(x.mediaId);
    return { idx, local: false, mediaId: x.mediaId, name, bytes: 0, mime: null };
  });
}

/** An optional path below a drop folder: up to 4 segments, no '.'/'..', no characters File Station refuses. */
function subPath(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > 300) throw fail('invalid');
  const segs = v.split('/').map((s) => s.trim()).filter(Boolean);
  if (segs.length > 4 || segs.some((s) => s === '.' || s === '..' || !SEGMENT_RE.test(s))) throw fail('invalid');
  return segs.join('/');
}

function list(v, max) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw fail('invalid');
  return v;
}

function parseTo(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const ppl = [];
  for (const x of list(v.people, LIMITS.people)) {
    const id = x === 'family' ? 'family' : posInt(x);
    if (!id) throw fail('invalid');
    if (!ppl.includes(String(id))) ppl.push(String(id));
  }
  const devices = [];
  for (const x of list(v.devices, LIMITS.devices)) {
    // GateControl's device ids are token ids; Android 1.61 sends them as numbers
    const id = Number.isSafeInteger(x) && x > 0 ? String(x) : x;
    if (typeof id !== 'string' || !DEVICE_RE.test(id)) throw fail('invalid');
    if (!devices.includes(id)) devices.push(id);
  }
  const nas = [];
  for (const x of list(v.nas, LIMITS.nas)) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw fail('invalid');
    const id = posInt(x.id);
    if (!id) throw fail('invalid');
    nas.push({ id, sub: subPath(x.path) });
  }
  let link = null;
  if (v.link != null && v.link !== false) {
    const l = v.link;
    if (typeof l !== 'object' || Array.isArray(l) || !Object.prototype.hasOwnProperty.call(deliver.LINK_EXPIRES, l.expires)) throw fail('invalid');
    if (l.pin != null && typeof l.pin !== 'boolean') throw fail('invalid');
    link = { expires: l.expires, pin: l.pin === true };
  }
  return { people: ppl, devices, nas, link };
}

// ─── views ──────────────────────────────────────────────────────────────────

const itemsOf = (gc, sendId) => store.all(gc, 'SELECT * FROM items WHERE send_id = ? ORDER BY idx', [sendId]);
const deliveriesOf = (gc, sendId) => store.all(gc, 'SELECT * FROM deliveries WHERE send_id = ? ORDER BY id', [sendId]);

function itemView(i, send) {
  const available = !send.purged && !!i.media_id;
  return { index: i.idx, mediaId: available ? i.media_id : null, name: i.name, mime: i.mime || null, bytes: i.bytes, local: i.local === 1 && !i.media_id, available };
}

function deliveryView(d, send) {
  const out = { id: d.id, kind: d.kind, target: d.target, label: d.label || null, status: d.status, via: d.via || null, at: iso(d.at), error: d.error || null, openedAt: iso(d.opened_at) };
  if (d.kind === 'person' && d.ref && d.ref.startsWith('chat:')) out.conversationId = Number(d.ref.slice(5)) || null;
  if (d.kind === 'device' && send && d.user_id && d.user_id !== send.user_id) out.ownerId = d.user_id; // another person's device
  if (d.kind === 'nas' && d.ref) out.paths = d.ref.split('\n');
  return out;
}

const ARRIVED = ['waiting', 'delivered', 'opened', 'expired'];

/**
 * May the viewer see this send as a recipient? → their deliveries of it ([] = no). Own devices: always. A person
 * delivery only when it reached the person through GateDrop (no chat, or files too large for the chat) — never a
 * refused one; 'family' only for the members at sending (stored in `members`).
 */
async function recipientDeliveries(ctx, send, dels) {
  const mine = [];
  for (const d of dels) {
    if (d.kind === 'device') { if (d.user_id === ctx.viewer) mine.push(d); continue; }
    if (d.kind !== 'person' || !ARRIVED.includes(d.status) || !(d.ref == null || d.gd_items > 0)) continue;
    if (d.user_id === ctx.viewer) mine.push(d);
    else if (d.target === 'family' && send.user_id !== ctx.viewer && deliver.membersOf(d).includes(ctx.viewer)) mine.push(d);
  }
  return mine;
}

/** A send as `role` ('sent' | 'received') sees it. */
async function view(ctx, send, role, dels) {
  const items = await itemsOf(ctx.gc, send.id);
  const all = dels || await deliveriesOf(ctx.gc, send.id);
  const shown = role === 'sent' ? all : await recipientDeliveries(ctx, send, all);
  const u = ctx.users.get(send.user_id);
  return {
    id: send.id, role, createdAt: iso(send.created_at), expiresAt: iso(send.expires_at), expired: send.purged === 1,
    from: { userId: send.user_id, name: u ? u.name : null, avatarUrl: u ? u.avatarUrl : null, deviceId: send.device_id || null, deviceName: send.device_name || null, own: send.user_id === ctx.viewer },
    text: send.text || null, link: send.link || null, note: send.note || null,
    items: items.map((i) => itemView(i, send)), deliveries: shown.map((d) => deliveryView(d, send)),
  };
}

// ─── POST sends ─────────────────────────────────────────────────────────────

/** The checked uploads of the viewer → their media info (owner, unused, an allowed type). */
async function checkUploads(ctx, items) {
  for (const it of items) {
    if (it.local) continue;
    let info = null;
    try { info = await ctx.gc.media.info(it.mediaId); } catch { info = null; }
    if (!info || info.owner !== ctx.viewer) throw fail('media_invalid');
    if (await store.one(ctx.gc, 'SELECT 1 AS x FROM items WHERE media_id = ?', [it.mediaId])) throw fail('media_in_use');
    it.mime = info.mime;
    it.bytes = info.bytes;
    if (!it.name) it.name = fileName(info.name) || 'Datei';
  }
}

async function claim(ctx, mediaId) {
  try { await ctx.gc.media.claim(mediaId); } catch { throw fail('media_invalid'); }
}

/**
 * POST sends → { send (the sender's view), deliveries, link?, direct }
 * See README "App-API". Deliveries to people and links run before the answer, NAS folders after it.
 */
async function create(ctx, body) {
  const gc = ctx.gc;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const items = parseItems(b.items);
  const text = optText(b.text, LIMITS.textMax);
  const link = url(b.link);
  const note = optText(b.note, LIMITS.noteMax);
  const to = parseTo(b.to);
  if (!items.length && !text && !link) throw fail('invalid');
  if (!to.people.length && !to.devices.length && !to.nas.length && !to.link) throw fail('invalid');
  if ((to.nas.length || to.link) && !items.length) throw fail('invalid'); // NAS folders and links carry files
  if ((to.nas.length || to.link) && !(await people.canShare(gc, ctx.user, ctx.now))) throw fail('forbidden');

  // own devices and other people's devices open for everyone — and how each is reached
  const plans = [];
  if (to.devices.length) {
    const mine = await people.devicesOf(gc, ctx.viewer);
    const me = ctx.deviceId ? await presence.get(gc, ctx.deviceId, ctx.viewer, ctx.now) : null;
    let open = null;
    for (const id of to.devices) {
      if (id === ctx.deviceId) throw fail('invalid');
      let dev = mine.find((d) => d.id === id);
      let owner = ctx.viewer;
      if (!dev) {
        if (!open) open = await access.openDevices(gc, ctx.viewer, ctx.users, await people.kioskIds(gc));
        dev = open.find((d) => d.id === id);
        // closed meanwhile (or never open): the target is gone, not a bad request
        if (!dev) throw fail((await access.closedForOthers(gc, id, ctx.viewer)) ? 'unavailable' : 'invalid');
        owner = dev.owner.id;
      }
      plans.push({ dev, owner, ...(await presence.plan(gc, me, dev, owner, ctx.now)) });
    }
  }
  // people (not oneself, not a kiosk device) and the family chat
  const persons = [];
  if (to.people.length) {
    const kiosk = await people.kioskIds(gc);
    for (const p of to.people) {
      if (p === 'family') {
        const fam = await deliver.familyOthers(gc, ctx.viewer, ctx.now);
        const r = await people.roles(gc, ctx.now);
        if (!fam || !r || ![...r.parents, ...r.children].includes(ctx.viewer)) throw fail('forbidden');
        // the family as it is now: only these people ever see this send
        persons.push({ target: 'family', userId: null, label: t(ctx.lang, 'family'), members: deliver.membersText(fam) });
        continue;
      }
      const uid = Number(p);
      const u = ctx.users.get(uid);
      if (!u || uid === ctx.viewer || kiosk.has(uid)) throw fail('invalid');
      persons.push({ target: String(uid), userId: uid, label: u.name });
    }
  }
  // NAS drop folders
  const drops = [];
  if (to.nas.length) {
    const fl = await people.folders(gc, ctx.now);
    for (const n of to.nas) {
      const f = fl.find((x) => x.id === n.id);
      if (!f) throw fail('not_found');
      const p = f.path.replace(/\/+$/, '') + (n.sub ? '/' + n.sub : '');
      drops.push({ target: p, folderId: f.id, label: `${f.label}${n.sub ? '/' + n.sub : ''}` });
    }
  }
  if (to.link && !(await people.linksEnabled(gc, ctx.viewer, ctx.now))) throw fail('links_disabled');
  // files only on the sender's device: every target must be one of its own devices reached directly
  if (items.some((i) => i.local) && (persons.length || drops.length || to.link || plans.some((p) => !p.direct))) throw fail('upload_required');
  await checkUploads(ctx, items);
  for (const it of items) if (!it.local) await claim(ctx, it.mediaId);

  const id = newId();
  const direct = [];
  const sendRow = {
    id, user_id: ctx.viewer, device_id: ctx.deviceId || null, device_name: ctx.deviceName || null, created_at: ctx.now, expires_at: ctx.now + RETENTION_MS,
    text, link, note, purged: 0,
  };
  const devDeliveries = [];
  await store.tx(gc, async () => {
    await store.run(gc, 'INSERT INTO sends (id, user_id, device_id, device_name, created_at, expires_at, text, link, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, ctx.viewer, sendRow.device_id, sendRow.device_name, ctx.now, sendRow.expires_at, text, link, note]);
    for (const it of items) {
      await store.run(gc, 'INSERT INTO items (send_id, idx, media_id, name, mime, bytes, local) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, it.idx, it.mediaId, it.name, it.mime, it.bytes, it.local ? 1 : 0]);
    }
    const ins = async (kind, target, userId, status, label) => (await store.run(gc, 'INSERT INTO deliveries (send_id, kind, target, user_id, status, via, at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, kind, target, userId, status, status === 'direct' ? 'direct' : null, ctx.now, label])).lastInsertRowid;
    for (const p of plans) {
      const label = p.owner === ctx.viewer ? p.dev.name : `${p.dev.name} (${p.dev.owner.name || '?'})`;
      const dId = await ins('device', p.dev.id, p.owner, p.direct ? 'direct' : 'pending', label);
      p.deliveryId = dId;
      if (p.direct) {
        const tr = await transfers.create(gc, { sendId: id, deliveryId: dId, fromDevice: ctx.deviceId, toDevice: p.dev.id, mode: p.mode, candidates: p.candidates }, ctx.now);
        direct.push(tr);
      } else devDeliveries.push({ id: dId, online: p.dev.online });
    }
    for (const p of persons) {
      p.deliveryId = await ins('person', p.target, p.userId, 'pending', p.label);
      if (p.members) await store.run(gc, 'UPDATE deliveries SET members = ? WHERE id = ?', [p.members, p.deliveryId]);
    }
    for (const d of drops) d.deliveryId = await ins('nas', d.target, null, 'pending', d.label);
    if (to.link) to.link.deliveryId = await ins('link', 'link', null, 'pending', null);
  });

  const stored = await itemsOf(gc, id);
  const save = (dId, st) => store.run(gc, 'UPDATE deliveries SET status = ?, via = ?, error = ?, ref = ?, at = ?, handed = ?, gd_items = ?' + (st.target ? ', target = ?, label = ?' : '') + ' WHERE id = ?',
    [st.status, st.via || null, st.error || null, st.ref || null, ctx.now, st.handed || 0, st.gd_items || 0, ...(st.target ? [st.target, st.label || null] : []), dId]);
  // own devices: silent pushes for direct transfers, a push for the others
  const from = { userId: ctx.viewer, name: ctx.user.name, deviceId: ctx.deviceId || null, deviceName: ctx.deviceName || null };
  for (const tr of direct) {
    const owner = plans.find((p) => p.deliveryId === tr.delivery_id).owner;
    await deliver.pushDirect(gc, sendRow, stored, tr, { ...from, own: owner === ctx.viewer }, owner); // own: one's own device
  }
  // an offline device: 'waiting' (the push is queued by GateControl, the app fetches it with GET pending)
  for (const dd of devDeliveries) {
    const d = await store.one(gc, 'SELECT * FROM deliveries WHERE id = ?', [dd.id]);
    await save(dd.id, await deliver.deviceServer(gc, sendRow, stored, d, ctx.user.name, dd.online));
  }
  // links, then people (the Messenger) — before the answer
  let linkOut = null;
  if (to.link) {
    const d = await store.one(gc, 'SELECT * FROM deliveries WHERE id = ?', [to.link.deliveryId]);
    const r = await deliver.link(ctx, sendRow, stored, d, to.link);
    await save(d.id, r.state);
    if (r.link) await store.run(gc, 'UPDATE links SET url = ? WHERE token = ?', [r.link.url, r.link.token]);
    linkOut = r.link;
  }
  for (const p of persons) {
    const d = await store.one(gc, 'SELECT * FROM deliveries WHERE id = ?', [p.deliveryId]);
    await save(d.id, await deliver.person(ctx, sendRow, stored, d, ctx.user.name));
  }
  // NAS folders: after the answer (an upload may take minutes)
  if (drops.length) {
    const bgCtx = { ...ctx };
    jobs.queue(async () => {
      for (const dr of drops) {
        const d = await store.one(gc, 'SELECT * FROM deliveries WHERE id = ?', [dr.deliveryId]);
        if (!d || d.status !== 'pending') continue;
        const st = await deliver.nas(bgCtx, sendRow, stored, d, dr.folderId);
        await store.run(gc, 'UPDATE deliveries SET status = ?, via = ?, error = ?, ref = ?, at = ?, handed = ? WHERE id = ?', [st.status, st.via || null, st.error || null, st.ref || null, Date.now(), st.handed || 0, d.id]);
      }
    }, gc);
  }
  const sendNow = await store.one(gc, 'SELECT * FROM sends WHERE id = ?', [id]);
  const v = await view(ctx, sendNow, 'sent');
  return { id, send: v, deliveries: v.deliveries, link: linkOut, direct: direct.map(transfers.directOut) };
}

// ─── after a send ───────────────────────────────────────────────────────────

async function ownSend(ctx, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) throw fail('not_found');
  const send = await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [id]);
  if (!send || send.user_id !== ctx.viewer) throw fail('not_found');
  return send;
}

/**
 * POST sends/<id>/items { items: [{ index, mediaId }] } — the sender uploads files that were to go directly
 * (after { fallback: 'upload' }); once every file is on the server, waiting device deliveries get their push.
 */
async function addItems(ctx, id, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !Array.isArray(b.items) || !b.items.length || b.items.length > LIMITS.items) throw fail('invalid');
  const send = await ownSend(ctx, id);
  if (send.purged) throw fail('gone');
  const items = await itemsOf(ctx.gc, id);
  const wanted = [];
  for (const x of b.items) {
    if (!x || typeof x !== 'object' || typeof x.mediaId !== 'string' || !MEDIA_RE.test(x.mediaId)) throw fail('invalid');
    const it = Number.isInteger(x.index) ? items.find((i) => i.idx === x.index) : (typeof x.name === 'string' ? items.find((i) => !i.media_id && i.name === fileName(x.name)) : null);
    if (!it || it.media_id || wanted.some((w) => w.it.idx === it.idx || w.mediaId === x.mediaId)) throw fail('invalid');
    wanted.push({ it, mediaId: x.mediaId });
  }
  const infos = [];
  for (const w of wanted) {
    const probe = { local: false, mediaId: w.mediaId, name: w.it.name };
    await checkUploads(ctx, [probe]);
    infos.push({ ...w, mime: probe.mime, bytes: probe.bytes });
  }
  for (const w of infos) await claim(ctx, w.mediaId);
  const jobsOut = [];
  await store.tx(ctx.gc, async () => {
    for (const w of infos) await store.run(ctx.gc, 'UPDATE items SET media_id = ?, mime = ?, bytes = ? WHERE send_id = ? AND idx = ?', [w.mediaId, w.mime, w.bytes, id, w.it.idx]);
    const missing = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM items WHERE send_id = ? AND media_id IS NULL', [id]);
    if (missing.n) return;
    // every file is there now: the device deliveries that wait for them (their direct transfer failed or expired)
    for (const d of await store.all(ctx.gc, "SELECT * FROM deliveries WHERE send_id = ? AND kind = 'device' AND status = 'pending'", [id])) {
      jobsOut.push((await transfers.fallback(ctx.gc, send, d, ctx.now)).job);
    }
  });
  await transfers.runJobs(ctx.gc, jobsOut, ctx.user.name);
  return { send: await view(ctx, await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [id]), 'sent') };
}

/** GET sends/<id> — the sender's view, or a recipient's. */
async function get(ctx, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) throw fail('not_found');
  const send = await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [id]);
  if (!send) throw fail('not_found');
  return viewOf(ctx, send);
}

/** A send as GET sends/<id> shows it to the viewer (else not_found). */
async function viewOf(ctx, send) {
  const id = send.id;
  if (send.user_id === ctx.viewer) return view(ctx, send, 'sent');
  const dels = await deliveriesOf(ctx.gc, id);
  if (!(await recipientDeliveries(ctx, send, dels)).length) throw fail('not_found');
  return view(ctx, send, 'received', dels);
}

/**
 * POST sends/<id>/opened — a recipient opened it: the person deliveries, and a device delivery only when the target
 * device itself calls (its "received" acknowledgement — it takes the send off that device's GET pending; the portal or
 * another device never marks it).
 */
async function opened(ctx, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) throw fail('not_found');
  const send = await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [id]);
  if (!send) throw fail('not_found');
  const mine = await recipientDeliveries(ctx, send, await deliveriesOf(ctx.gc, id));
  if (!mine.length) throw fail('not_found');
  const pick = mine.filter((d) => d.kind !== 'device' || (!!ctx.deviceId && d.target === ctx.deviceId));
  await store.tx(ctx.gc, async () => {
    for (const d of pick) {
      if (d.status === 'delivered' || d.status === 'waiting') await store.run(ctx.gc, "UPDATE deliveries SET status = 'opened', opened_at = ? WHERE id = ?", [ctx.now, d.id]);
    }
  });
  return view(ctx, await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [id]), 'received');
}

/** May the viewer read this file (sender, a recipient; not after the send expired)? → { send, item } or null */
async function fileAccess(ctx, mediaId) {
  if (typeof mediaId !== 'string' || !MEDIA_RE.test(mediaId)) return null;
  const item = await store.one(ctx.gc, 'SELECT * FROM items WHERE media_id = ?', [mediaId]);
  if (!item) return null;
  const send = await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [item.send_id]);
  if (!send || send.purged || send.expires_at <= ctx.now) return null;
  if (send.user_id === ctx.viewer) return { send, item };
  const mine = await recipientDeliveries(ctx, send, await deliveriesOf(ctx.gc, send.id));
  return mine.some((d) => ['waiting', 'delivered', 'opened'].includes(d.status)) ? { send, item } : null;
}

/** GET items/<mediaId> → { item, url } — url: the app's media route, or a signed /plugin-media/ URL for the portal. */
async function itemInfo(ctx, mediaId, pluginId) {
  const a = await fileAccess(ctx, mediaId);
  if (!a) throw fail('not_found');
  let u = `/api/v1/client/plugins/${pluginId}/media/${mediaId}`;
  if (ctx.portal) {
    try { u = await ctx.gc.media.url(mediaId, { user: ctx.viewer, ttlS: 3600 }); } catch { throw fail('not_found'); }
  }
  return { item: { sendId: a.send.id, ...itemView(a.item, a.send) }, url: u };
}

// ─── lists ──────────────────────────────────────────────────────────────────

function page(query) {
  const q = query || {};
  const limit = q.limit == null || q.limit === '' ? PAGE_DEFAULT : posInt(String(q.limit));
  if (!limit || limit > PAGE_MAX) throw fail('invalid');
  let before = null;
  if (q.before != null && q.before !== '') {
    before = Date.parse(String(q.before));
    if (!Number.isFinite(before)) throw fail('invalid');
  }
  return { limit, before: before == null ? Number.MAX_SAFE_INTEGER : before };
}

/** GET inbox?kind=received|sent|links&before=<ISO>&limit= → { kind, items, hasMore } */
async function inbox(ctx, query) {
  const kind = query && query.kind != null && query.kind !== '' ? String(query.kind) : 'received';
  if (!['received', 'sent', 'links'].includes(kind)) throw fail('invalid');
  const { limit, before } = page(query);
  const gc = ctx.gc;
  if (kind === 'links') return { kind, ...(await links(ctx, limit, before)) };
  let rows;
  if (kind === 'sent') {
    rows = await store.all(gc, 'SELECT * FROM sends WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?', [ctx.viewer, before, limit + 1]);
  } else {
    // own devices; a person delivery that reached the person through GateDrop; 'family' only for its members at sending
    rows = await store.all(gc, `SELECT s.* FROM sends s WHERE s.created_at < ? AND EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = s.id AND d.status IN ('waiting', 'delivered', 'opened', 'expired') AND (
        (d.user_id = ? AND d.kind = 'device')
        OR (d.kind = 'person' AND (d.ref IS NULL OR d.gd_items > 0) AND (d.user_id = ? OR (d.target = 'family' AND s.user_id != ? AND d.members LIKE ?)))))
      ORDER BY s.created_at DESC LIMIT ?`, [before, ctx.viewer, ctx.viewer, ctx.viewer, `%,${ctx.viewer},%`, limit + 1]);
  }
  const hasMore = rows.length > limit;
  const out = [];
  for (const s of rows.slice(0, limit)) out.push(await view(ctx, s, kind === 'sent' ? 'sent' : 'received'));
  return { kind, items: out, hasMore };
}

/**
 * GET pending (apps only) → { items: [send as GET sends/<id> shows it] } — what the calling device still has to fetch:
 * sends with a device delivery to it through the server that is 'waiting' or 'delivered' (not yet 'opened'), not
 * expired, with at least one file on the server or a text / link; oldest first, at most 50. The call means the device is online: its
 * 'waiting' deliveries (of sends not expired) become 'delivered' now. POST sends/<id>/opened from the device takes a send
 * off this list.
 */
async function pending(ctx) {
  if (!ctx.deviceId) throw fail('no_device');
  const gc = ctx.gc;
  const rows = await store.all(gc, `SELECT s.* FROM sends s WHERE s.purged = 0 AND s.expires_at > ?
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = s.id AND d.kind = 'device' AND d.user_id = ? AND d.target = ?
        AND d.via = 'server' AND d.status IN ('waiting', 'delivered'))
      AND (s.text IS NOT NULL OR s.link IS NOT NULL OR EXISTS (SELECT 1 FROM items i WHERE i.send_id = s.id AND i.media_id IS NOT NULL))
    ORDER BY s.created_at ASC, s.id ASC LIMIT ?`, [ctx.now, ctx.viewer, ctx.deviceId, PENDING_MAX]);
  await store.run(gc, `UPDATE deliveries SET status = 'delivered', at = ? WHERE kind = 'device' AND user_id = ? AND target = ? AND status = 'waiting'
      AND send_id IN (SELECT id FROM sends WHERE purged = 0 AND expires_at > ?)`, [ctx.now, ctx.viewer, ctx.deviceId, ctx.now]);
  const items = [];
  for (const s of rows) items.push(await viewOf(ctx, s));
  return { items };
}

/** The viewer's links with GateControl's counters (when links are on). */
async function links(ctx, limit, before) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM links WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?', [ctx.viewer, before, limit + 1]);
  const hasMore = rows.length > limit;
  const items = [];
  for (const l of rows.slice(0, limit)) {
    let live = null;
    if (ctx.gc.publicLinks && !l.revoked_at && l.expires_at > ctx.now) {
      try { live = await ctx.gc.publicLinks.get(l.token); } catch { live = null; }
    }
    const downloads = live && Number.isSafeInteger(live.downloads) ? live.downloads : l.downloads;
    const locked = live ? live.locked === true : l.locked === 1;
    const revoked = !!l.revoked_at || (live ? live.revoked === true : false);
    let state = live && typeof live.state === 'string' ? live.state : null;
    if (!state) state = revoked ? 'revoked' : (locked ? 'locked' : (l.expires_at <= ctx.now ? 'expired' : 'active'));
    if (l.revoked_at) state = 'revoked';
    items.push({
      token: l.token, url: (live && live.url) || l.url || null, sendId: l.send_id, title: l.title || null, pin: l.pin === 1, maxDownloads: l.max_downloads,
      downloads, locked, revoked, state, createdAt: iso(l.created_at), expiresAt: iso(l.expires_at),
      active: state === 'active' && l.expires_at > ctx.now,
    });
  }
  return { items, hasMore };
}

/** DELETE links/<token> — the link's owner ends it. → { revoked } */
async function endLink(ctx, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw fail('not_found');
  const l = await store.one(ctx.gc, 'SELECT * FROM links WHERE token = ?', [token]);
  if (!l || l.user_id !== ctx.viewer) throw fail('not_found');
  let revoked = false;
  if (!l.revoked_at && ctx.gc.publicLinks) {
    try { revoked = (await ctx.gc.publicLinks.revoke(token)) === true; } catch (e) {
      if (e && e.code === 'ERR_PUBLIC_LINKS_DISABLED') revoked = false; else throw e;
    }
  }
  await store.tx(ctx.gc, async () => {
    if (!l.revoked_at) await store.run(ctx.gc, 'UPDATE links SET revoked_at = ? WHERE token = ?', [ctx.now, token]);
    await store.run(ctx.gc, "UPDATE deliveries SET status = 'expired', error = 'revoked', at = ? WHERE send_id = ? AND kind = 'link' AND target = ?", [ctx.now, l.send_id, token]);
  });
  return { revoked: revoked || !l.revoked_at };
}

module.exports = { create, addItems, get, opened, pending, fileAccess, itemInfo, inbox, endLink, view, parseItems, parseTo, subPath, LIMITS, RETENTION_MS };
