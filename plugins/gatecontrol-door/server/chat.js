'use strict';

// The doorbell in the family chat (1.3.0) — the Messenger plugin (gatecontrol-messenger ≥ 1.4.0)
// through GateControl's services between plugins (GateControl ≥ 1.177.0, gc.services.call,
// plugin.json permissions.services "gatecontrol-messenger:send_message").
//
// On a ring (kind 'ding', after the pushes), when the setting „Klingel in den Familien-Chat“
// (admin page „Einstellungen“, config familyChat, default on) is on and the messenger offers
// send_message (gc.services.available, GateControl ≥ 1.178.0 — asks nobody, costs nothing; an
// older host just calls, a missing provider is refused before it counts):
//
//   send_message { conversation: 'family', card: { kind: 'doorbell', title: 'Klingel · Haustür',
//                  text: 'Klingel Haustür · 14:32', imageBase64?: <the ring's JPEG, ≤ 300 KB>,
//                  actions: ['<lockId>:open'] } }
//
// title: „Klingel · <lock>“ (no linked lock: the camera's name), text: camera · local time (the
// push texts' language). actions: this plugin's quick action ids — „Tür öffnen“ (opener: „Summer“)
// of the camera's lock when it offers `open`; the messenger shows a button per action and runs it
// as the person who presses it, so the door's rights decide (control.perform). The picture rides
// along when there is one; the host takes at most 16 KB of JSON per call — a payload it refuses
// as too big (ERR_INVALID, not counted) or a messenger that refuses the picture (`invalid`) gets
// the card once more without it. Never throws: a ring works the same without the messenger.
//
// The last result is kept for the page (gc.storage 'door.chat': { at, ok, error, image, fallback }).
//
// 1.4.0 — when the messenger answers `not_found` for 'family' (no group „Familie“: Familie not
// installed, its messenger group switched off or handed back), the card goes to the people who get
// the ring's push (view right on the camera's lock, doorbell push not switched off) — each into
// their own read-only channel „Tür & Kamera“ of this plugin (targets 'user:<id>', one call with a
// list, at most 20): send_message { conversation: ['user:2', 'user:4'], title: 'Tür & Kamera', card }
// → { ok, sent, failed, results }. fallback = { to, sent, failed } in the stored result. Without a
// linked lock there is nobody to send it to (error stays not_found, fallback { to: 0 }).
// Note: a `timeout` means the messenger did not answer within GateControl's 15 s — the card may
// still have arrived (the messenger stores it before it sends the pushes).

const PLUGIN = 'gatecontrol-messenger';
const SERVICE = 'send_message';
const STORE_KEY = 'door.chat';
const TITLE_MAX = 80;
const TEXT_MAX = 200;
const IMAGE_MAX = 300 * 1024;

const FALLBACK_MAX = 20;

const TEXTS = {
  de: { title: 'Klingel · {{name}}', text: '{{camera}} · {{time}}', channel: 'Tür & Kamera' },
  en: { title: 'Doorbell · {{name}}', text: '{{camera}} · {{time}}', channel: 'Door & Camera' },
};
const fmt = (lang, key, params) => {
  let s = (TEXTS[lang === 'en' ? 'en' : 'de'])[key];
  for (const [k, v] of Object.entries(params || {})) s = s.split(`{{${k}}}`).join(String(v));
  return s;
};

const hasApi = (gc) => !!(gc && gc.services && typeof gc.services.call === 'function');
const hasAvailable = (gc) => hasApi(gc) && typeof gc.services.available === 'function';

/** Does the messenger offer send_message right now? true / false, null when the host cannot tell (no gc.services.available). */
async function available(gc) {
  if (!hasApi(gc)) return false;
  if (!hasAvailable(gc)) return null;
  try { return (await gc.services.available(PLUGIN, SERVICE)) === true; } catch { return null; }
}

function codeOf(e) {
  const c = e && e.code;
  if (c === 'ERR_SERVICE_UNAVAILABLE' || c === 'ERR_SERVICES_DENIED') return 'unavailable';
  if (c === 'ERR_RATE_LIMIT') return 'rate_limit';
  if (c === 'ERR_TIMEOUT') return 'timeout';
  if (c === 'ERR_INVALID') return 'too_big';
  return 'failed';
}

async function send(gc, payload) {
  try {
    const r = await gc.services.call({ plugin: PLUGIN, service: SERVICE, payload });
    if (r && r.ok === true) {
      // a list of targets: ok when at least one got it
      if (Array.isArray(payload.conversation)) {
        const sent = Number.isInteger(r.sent) ? r.sent : 0;
        const failed = Number.isInteger(r.failed) ? r.failed : payload.conversation.length - sent;
        const codes = Array.isArray(r.results) ? r.results.filter((x) => x && x.ok === false && typeof x.code === 'string').map((x) => x.code) : [];
        return { ok: sent > 0, error: sent > 0 ? null : (codes[0] && /^[a-z_]{1,32}$/.test(codes[0]) ? codes[0] : 'failed'), sent, failed };
      }
      return { ok: true, error: null };
    }
    return { ok: false, error: r && typeof r.code === 'string' && /^[a-z_]{1,32}$/.test(r.code) ? r.code : 'failed' };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}

/** send(), once more without the picture when the host or the messenger refuses it → { res, image } */
async function sendWithPicture(gc, payload) {
  let image = !!payload.card.imageBase64;
  let res = await send(gc, payload);
  if (!res.ok && image && (res.error === 'too_big' || res.error === 'invalid')) {
    delete payload.card.imageBase64;
    image = false;
    res = await send(gc, payload);
  }
  return { res, image };
}

/**
 * The card of one ring → the payload of send_message.
 * o = { lang, camera: { name }, lock: { id, name, actions } | null, time: 'HH:MM', image: Buffer | null }
 */
function cardOf(o) {
  const lockActions = o.lock ? (Array.isArray(o.lock.actions) ? o.lock.actions : JSON.parse(o.lock.actions || '[]')) : [];
  const card = {
    kind: 'doorbell',
    title: fmt(o.lang, 'title', { name: o.lock ? o.lock.name : o.camera.name }).slice(0, TITLE_MAX),
    text: fmt(o.lang, 'text', { camera: o.camera.name, time: o.time }).slice(0, TEXT_MAX),
    actions: o.lock && lockActions.includes('open') ? [`${o.lock.id}:open`] : [],
  };
  if (o.image && o.image.length <= IMAGE_MAX) card.imageBase64 = o.image.toString('base64');
  return { conversation: 'family', card };
}

/**
 * Send the card of a ring (see the head of this file). o.people: the user ids for the fallback.
 * → { sent, ok, error, image, fallback: { to, sent, failed } | null } — never throws.
 */
async function ring(gc, cfg, o) {
  try {
    if (!cfg.familyChat || !hasApi(gc)) return { sent: false, ok: false, error: cfg.familyChat ? 'unavailable' : 'off', image: false, fallback: null };
    if ((await available(gc)) === false) {
      const out = { sent: false, ok: false, error: 'unavailable', image: false, fallback: null };
      await keep(gc, out);
      return out;
    }
    const payload = cardOf({ ...o, lang: cfg.notifyLang });
    const picture = payload.card.imageBase64;
    let { res, image } = await sendWithPicture(gc, payload);
    let fallback = null;
    if (!res.ok && res.error === 'not_found') {
      // no group „Familie“: the people who get the ring's push, each in their own channel
      const people = [...new Set((o.people || []).filter((u) => Number.isSafeInteger(u) && u > 0))].slice(0, FALLBACK_MAX);
      fallback = { to: people.length, sent: 0, failed: 0 };
      if (people.length) {
        const many = { conversation: people.map((u) => `user:${u}`), title: fmt(cfg.notifyLang, 'channel'), card: { ...payload.card } };
        if (picture) many.card.imageBase64 = picture;
        const r2 = await sendWithPicture(gc, many);
        fallback = { to: people.length, sent: r2.res.sent || 0, failed: r2.res.failed || (r2.res.ok ? 0 : people.length) };
        if (r2.res.ok) { res = { ok: true, error: null }; image = r2.image; }
      }
    }
    if (!res.ok && res.error !== 'unavailable') gc.log.warn('doorbell card not sent', res.error);
    const out = { sent: true, ok: res.ok, error: res.error, image: res.ok && image, fallback };
    await keep(gc, out);
    return out;
  } catch (e) {
    gc.log.warn('doorbell card failed', (e && (e.code || e.message)) || 'error');
    return { sent: false, ok: false, error: 'failed', image: false, fallback: null };
  }
}

async function keep(gc, out) {
  try { await gc.storage.set(STORE_KEY, { at: Date.now(), ok: out.ok, error: out.error, image: out.image, fallback: out.fallback }); } catch { /* best effort */ }
}

/** The stored last result → { at, ok, error, image, fallback } | null (ISO time). */
async function last(gc) {
  let v = null;
  try { v = await gc.storage.get(STORE_KEY); } catch { v = null; }
  if (!v || typeof v !== 'object' || !Number.isFinite(v.at)) return null;
  const f = v.fallback && typeof v.fallback === 'object' ? v.fallback : null;
  return {
    at: new Date(v.at).toISOString(), ok: !!v.ok, error: typeof v.error === 'string' ? v.error : null, image: !!v.image,
    fallback: f ? { to: Number(f.to) || 0, sent: Number(f.sent) || 0, failed: Number(f.failed) || 0 } : null,
  };
}

/** For the admin page: { api, available, last: { at, ok, error, image, fallback } | null } (no service call). */
async function info(gc) {
  return { api: hasApi(gc), available: await available(gc), last: await last(gc) };
}

module.exports = { PLUGIN, SERVICE, STORE_KEY, TEXTS, FALLBACK_MAX, cardOf, ring, info, last, available };
