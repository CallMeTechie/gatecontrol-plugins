'use strict';

// Deliveries per target (contract B):
//   device  direct possible → a silent push to that device { gatedrop: { transfer, send, mode, from, items,
//           candidates, key, ticket, expiresAt } } (the sender gets the same in the answer's `direct`);
//           otherwise / after a failed direct transfer → a push "<device> hat dir … geschickt" to that device
//           with data { gatedrop: { send } }; the device downloads with GET items/<mediaId>.
//   person  the Messenger's service send_file (the files handed over with gc.media.handOver) → a message of
//           the sender in the direct chat / the family chat; without the Messenger (or when it refuses) a push
//           to the person (to the family's members) like a device delivery through the server.
//   nas     the Synology plugin's save_file per file (handed over first) into the chosen drop folder.
//   link    gc.publicLinks.create — a link for outsiders, optionally with a PIN (4 digits, given to the sender once;
//           GateControl keeps only a hash), 'once' = maxDownloads 1 (per file; the ZIP counts one of each).
// Every function answers the delivery's new { status, via, error, ref } — the caller stores it.

const crypto = require('node:crypto');
const store = require('./store');
const people = require('./people');
const { t } = require('./text');
const { iso } = require('./util');

const LINK_EXPIRES = { '1h': 3600000, '1d': 86400000, '7d': 7 * 86400000, once: 7 * 86400000 };
const PUSH_DATA_MAX = 3500; // the host takes ≤ 4 KB of data (with its own route key)

/** A host error → a short code for the delivery (never a message of another system). */
function codeOf(e) {
  const c = e && typeof e.code === 'string' ? e.code : '';
  const map = {
    ERR_MEDIA_TOO_LARGE: 'file_too_large', ERR_MEDIA_TYPE: 'file_type', ERR_MEDIA_QUOTA: 'quota', ERR_MEDIA_DENIED: 'unavailable',
    ERR_SERVICE_UNAVAILABLE: 'unavailable', ERR_SERVICES_DENIED: 'unavailable', ERR_SERVICE_FAILED: 'failed', ERR_RATE_LIMIT: 'rate_limited',
    ERR_PUBLIC_LINKS_DISABLED: 'links_disabled', ERR_NO_PUBLIC_URL: 'no_public_url', ERR_TIMEOUT: 'timeout',
  };
  return map[c] || (/^[a-z_]{1,40}$/.test(c) ? c : 'failed');
}

/** "eine Datei" / "3 Dateien" / "einen Text" / "einen Link". */
function what(lang, send, items) {
  if (items.length === 1) return t(lang, 'what.file');
  if (items.length > 1) return t(lang, 'what.files', { n: items.length });
  return send.text ? t(lang, 'what.text') : t(lang, 'what.link');
}

/** The push body: the file names (three, "+N weitere"), else the text's start, else the link. */
function body(lang, send, items) {
  let s;
  if (items.length) {
    s = items.slice(0, 3).map((i) => i.name).join(', ');
    if (items.length > 3) s += ' ' + t(lang, 'push.more', { n: items.length - 3 });
  } else s = send.text || send.link || '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 299) + '…' : s;
}

/** Who sent it as the recipient reads it: one's own device by its name, another person by theirs. */
function fromLabel(lang, send, senderName, toSelf) {
  if (toSelf) return send.device_name || t(lang, 'from.portal');
  return senderName || '?';
}

/**
 * The visible push of a delivery through the server to `users` (optionally only `devices` of them) → true when pushed.
 * data { gatedrop: { send } } — the app opens / downloads the send.
 */
async function pushReceived(gc, send, items, { users, devices, senderName, toSelf }) {
  const byLang = new Map();
  for (const u of users) {
    const lang = await people.langOf(gc, u);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(u);
  }
  let ok = true;
  for (const [lang, list] of byLang) {
    try {
      await gc.notify({
        topic: 'received', title: t(lang, 'push.received', { from: fromLabel(lang, send, senderName, toSelf), what: what(lang, send, items) }),
        body: body(lang, send, items), priority: 'normal', users: list, ...(devices && devices.length ? { devices } : {}),
        collapseKey: `gatedrop:${send.id}`, data: { gatedrop: { send: send.id } },
      });
    } catch (e) {
      ok = false;
      gc.log.warn('push failed', (e && e.code) || 'error');
    }
  }
  return ok;
}

/** The silent push that starts a direct transfer on the receiving device (`devId`). → true when pushed */
async function pushDirect(gc, send, items, tr, from, userId) {
  const g = {
    transfer: tr.id, send: send.id, mode: tr.mode, from,
    items: items.map((i) => ({ index: i.idx, name: i.name.length > 100 ? i.name.slice(0, 100) : i.name, bytes: i.bytes, mime: i.mime || null })),
    candidates: tr.candidates, key: tr.key, ticket: tr.ticket, expiresAt: iso(tr.expires_at),
  };
  if (JSON.stringify(g).length > PUSH_DATA_MAX) { g.itemCount = g.items.length; g.items = null; } // the app reads GET transfers/<id>
  try {
    await gc.notify({ topic: 'received', silent: true, title: 'GateDrop', users: [userId], devices: [tr.to_device], ttl: 600, collapseKey: `gatedrop-transfer:${tr.id}`, data: { gatedrop: g } });
    return true;
  } catch (e) {
    gc.log.warn('silent push failed', (e && e.code) || 'error');
    return false;
  }
}

/** A device delivery through the server (all files uploaded) → the delivery's new state. */
async function deviceServer(gc, send, items, delivery, senderName) {
  const ok = await pushReceived(gc, send, items, { users: [send.user_id], devices: [delivery.target], senderName, toSelf: true });
  return { status: 'delivered', via: 'server', error: ok ? null : 'push_failed' };
}

/** The family's members (Familie's parents and children) other than `viewer`; null when Familie does not say. */
async function familyOthers(gc, viewer, now) {
  const r = await people.roles(gc, now);
  if (!r) return null;
  return [...new Set([...r.parents, ...r.children])].filter((u) => u !== viewer);
}

/** ',3,4,' ↔ [3, 4] — the recipients of a 'family' delivery as they were when it was sent. */
const membersText = (ids) => (ids && ids.length ? `,${ids.join(',')},` : null);
const membersOf = (d) => String((d && d.members) || '').split(',').map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);

// The Messenger's quota is shared by everyone: only small files go into a chat, the rest stays in GateDrop
// (its push, its inbox, 7 days). A sender hands over at most 200 files a day (Messenger and NAS together).
const CHAT_ITEM_MAX = 25 * 1024 * 1024;
const CHAT_SEND_MAX = 100 * 1024 * 1024;
const HANDOVERS_PER_DAY = 200;
const UNAVAILABLE = new Set(['ERR_SERVICE_UNAVAILABLE', 'ERR_SERVICES_DENIED', 'ERR_MEDIA_DENIED']);
const STAYS = new Set(['ERR_MEDIA_TYPE', 'ERR_MEDIA_TOO_LARGE', 'ERR_MEDIA_QUOTA', 'ERR_RATE_LIMIT']);

/** Files the sender handed over in the last 24 hours (stored per delivery). */
async function handedToday(gc, userId, now) {
  const r = await store.one(gc, 'SELECT COALESCE(SUM(d.handed), 0) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.user_id = ? AND d.at > ?', [userId, now - 86400000]);
  return r ? Number(r.n) || 0 : 0;
}

/** "+2 Dateien in GateDrop: film.mp4, clip.mov" for the chat. */
function extraLine(lang, extra) {
  const names = extra.slice(0, 3).map((i) => i.name).join(', ') + (extra.length > 3 ? ' ' + t(lang, 'push.more', { n: extra.length - 3 }) : '');
  return t(lang, extra.length === 1 ? 'chat.extra_one' : 'chat.extra', { n: extra.length, names });
}

/**
 * A person delivery (target a user id or 'family') → the delivery's new state (+ handed, gd_items).
 * With the Messenger: small files handed over (≤ 25 MB each, ≤ 100 MB per send, the daily budget) and send_file as a
 * message of the sender; larger files stay in GateDrop (push + inbox), named in the chat message. Whatever the
 * Messenger refuses (a block, not a member, read-only …) fails the delivery — nothing reaches the person another way.
 * Only without the Messenger (not installed, not reachable) the person gets GateDrop's push for everything.
 */
async function person(ctx, send, items, delivery, senderName) {
  const { gc } = ctx;
  const fam = delivery.target === 'family';
  const users = fam ? membersOf(delivery) : [Number(delivery.target)];
  let handed = 0;
  let messenger = await people.available(gc, people.MESSENGER, 'send_file');
  if (messenger) {
    let budget = HANDOVERS_PER_DAY - (await handedToday(gc, ctx.viewer, ctx.now));
    const mediaIds = [];
    const chat = [];
    const extra = [];
    ctx.chatBytes = ctx.chatBytes || 0;
    for (const it of items) {
      if (!messenger || it.bytes > CHAT_ITEM_MAX || ctx.chatBytes + it.bytes > CHAT_SEND_MAX || budget <= 0) { extra.push(it); continue; }
      try {
        mediaIds.push((await gc.media.handOver(it.media_id, { toPlugin: people.MESSENGER, user: ctx.viewer })).mediaId);
        chat.push(it);
        ctx.chatBytes += it.bytes;
        budget--;
        handed++;
      } catch (e) {
        if (e && UNAVAILABLE.has(e.code)) messenger = false;
        else if (e && STAYS.has(e.code)) extra.push(it);
        else return { status: 'failed', via: null, error: codeOf(e), ref: null, handed };
      }
    }
    if (messenger) {
      const text = [send.text, send.link, send.note, extra.length ? extraLine(ctx.lang, extra) : null].filter(Boolean).join('\n\n') || null;
      let res = null;
      try {
        res = await gc.services.call({
          plugin: people.MESSENGER, service: 'send_file', userId: ctx.viewer,
          payload: { conversation: fam ? 'family' : `direct:${delivery.target}`, user: ctx.viewer, mediaIds, names: chat.map((i) => i.name), ...(text ? { text } : {}) },
        });
      } catch (e) {
        if (!(e && UNAVAILABLE.has(e.code))) return { status: 'failed', via: null, error: codeOf(e), ref: null, handed };
        messenger = false;
      }
      if (messenger) {
        if (!res || res.ok !== true) return { status: 'failed', via: null, error: res && typeof res.code === 'string' ? res.code.slice(0, 40) : 'failed', ref: null, handed };
        let error = null;
        if (extra.length && !(await pushReceived(gc, send, extra, { users, senderName, toSelf: false }))) error = 'push_failed';
        return { status: 'delivered', via: 'server', error, ref: `chat:${res.conversationId}`, handed, gd_items: extra.length };
      }
    }
  }
  // no Messenger: a push to the person (the family's members at sending) — they find it under "Geteilt" and in the portal
  if (!users.length) return { status: 'failed', via: null, error: 'unavailable', ref: null, handed };
  const ok = await pushReceived(gc, send, items, { users, senderName, toSelf: false });
  return { status: 'delivered', via: 'server', error: ok ? null : 'push_failed', ref: null, handed, gd_items: items.length };
}

/**
 * A NAS delivery: each file handed over to the Synology plugin and saved with save_file into the drop folder `folderId`
 * (the delivery's target path lies within it) → the delivery's new state.
 */
async function nas(ctx, send, items, delivery, folderId) {
  const { gc } = ctx;
  if (!(await people.available(gc, people.SYNOLOGY, 'save_file'))) return { status: 'failed', via: null, error: 'unavailable', ref: null };
  const saved = [];
  let err = null;
  let handed = 0;
  let budget = HANDOVERS_PER_DAY - (await handedToday(gc, ctx.viewer, Date.now()));
  for (const it of items) {
    if (budget <= 0) { err = err || 'rate_limited'; continue; }
    try {
      const h = await gc.media.handOver(it.media_id, { toPlugin: people.SYNOLOGY, user: ctx.viewer });
      handed++;
      budget--;
      const res = await gc.services.call({ plugin: people.SYNOLOGY, service: 'save_file', userId: ctx.viewer, payload: { user: ctx.viewer, folderId, mediaId: h.mediaId, name: it.name, path: delivery.target } });
      if (res && res.ok === true) saved.push(typeof res.path === 'string' ? res.path : `${delivery.target}/${it.name}`);
      else err = err || (res && typeof res.code === 'string' ? res.code.slice(0, 40) : 'failed');
    } catch (e) { err = err || codeOf(e); }
  }
  const ref = saved.join('\n').slice(0, 2000) || null;
  if (!err) return { status: 'delivered', via: 'server', error: null, ref, handed };
  return { status: 'failed', via: saved.length ? 'server' : null, error: err, ref, handed };
}

/** A random 4-digit PIN. */
const newPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

/**
 * The link for outsiders → { state, link } — link { token, url, pin, expiresAt, maxDownloads } (pin in clear text only here,
 * in the answer to the sender; GateDrop does not keep it).
 */
async function link(ctx, send, items, delivery, opts) {
  const { gc } = ctx;
  const expiresAt = Math.min(ctx.now + LINK_EXPIRES[opts.expires], send.expires_at);
  const maxDownloads = opts.expires === 'once' ? 1 : null;
  const pin = opts.pin ? newPin() : null;
  // a PIN link shows no file name before the PIN is entered: a generic title then
  const generic = items.length ? 'link.generic_files' : (send.text ? 'link.generic_text' : 'link.generic_link');
  const title = (opts.pin ? t(ctx.lang, generic) : (items.length === 1 ? items[0].name : t(ctx.lang, 'link.title_files', { n: items.length }))).slice(0, 120);
  try {
    const r = await gc.publicLinks.create({
      title, ...(send.note ? { note: send.note.slice(0, 500) } : {}), files: items.map((i) => ({ mediaId: i.media_id, name: i.name })),
      expiresAt, ...(maxDownloads ? { maxDownloads } : {}), ...(pin ? { pin } : {}), ownerUserId: ctx.viewer,
    });
    const exp = Number.isSafeInteger(r.expiresAt) ? r.expiresAt : expiresAt;
    await store.run(gc, 'INSERT INTO links (token, send_id, user_id, title, url, pin, max_downloads, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.token, send.id, ctx.viewer, title, r.url, pin ? 1 : 0, maxDownloads, ctx.now, exp]);
    return {
      state: { status: 'delivered', via: 'server', error: null, ref: null, target: r.token, label: title },
      link: { token: r.token, url: r.url, pin, expiresAt: iso(exp), maxDownloads },
    };
  } catch (e) {
    if (e && e.code === 'ERR_PUBLIC_LINKS_DISABLED') people.forgetLinks();
    return { state: { status: 'failed', via: null, error: codeOf(e), ref: null }, link: null };
  }
}

module.exports = { pushReceived, pushDirect, deviceServer, person, nas, link, familyOthers, membersText, membersOf, handedToday, codeOf, what, body, LINK_EXPIRES, CHAT_ITEM_MAX, CHAT_SEND_MAX, HANDOVERS_PER_DAY };
