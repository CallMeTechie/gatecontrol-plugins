'use strict';

// Notifications through GateControl's notification center (docs/plugins.md
// "Notifications"). The same file is in every first-party plugin that
// notifies (tools/test checks that the copies stay identical).
//
//   const notifier = createNotifier(gc);
//   await notifier.send({ topic, title, body, priority, users, collapseKey, data }, { minGapMs });
//
// * New form gc.notify({ topic, … }) — GateControl ≥ 1.154.0, which is what
//   plugin.json "gatecontrol" requires. Should an older or a stricter host
//   see the call anyway, it degrades instead of failing:
//     - GateControl < 1.154.0 turns the argument into a string; the object
//       carries a non-enumerable toString(), so the old host logs
//       "<title> – <body>" (not "[object Object]"). JSON (the host IPC)
//       drops it, so the new host never sees it.
//     - ERR_INVALID (e.g. a host that does not know the topic) → sent once
//       more in the old form gc.notify(text, { severity }).
//     - A picture (`image: { data, mime }`, GateControl ≥ 1.169.0) the host
//       refuses (ERR_INVALID: too large, wrong type, an older host) never
//       costs the message: it is sent again without the picture first.
//     - `card` (GateControl ≥ 1.191.0: the long form a chat shows when the
//       person routed the topic into a chat — { text ≤ 4000, link?: { label
//       ≤ 40, route }, actions? }) is ignored by older hosts; one the host
//       refuses (ERR_INVALID) never costs the message either: sent again
//       without the card.
// * Budget: the host allows 30 per hour and plugin. The notifier keeps its
//   own sliding window below that (25/h) and holds the last 5 of them back
//   for high-priority messages, so a burst of minor notices never crowds
//   out an alarm. ERR_RATE_LIMIT from the host is logged once, not thrown.
// * Dedupe: `minGapMs` per topic + collapseKey drops repeats (flapping
//   sensors) — the transition logic of each plugin decides what is new.
// * State: loadState/saveState keep the plugin's last seen state in
//   gc.storage, so a restart neither re-notifies nor forgets an open alarm.

const HOUR_MS = 3600000;
const PER_HOUR = 25;
const HIGH_RESERVE = 5;

/** "<title> – <body>" for the old form (the host cuts it to 300 characters). */
function legacyText(n) {
  const body = n.body ? String(n.body).replace(/\s+/g, ' ').trim() : '';
  return body ? `${n.title} – ${body}` : String(n.title);
}

function severityOf(priority) {
  return priority === 'high' || priority === 'critical' ? 'warning' : 'info';
}

/** The notification without empty fields, with the old-host string form attached. */
function payload(n) {
  const out = {};
  for (const k of ['topic', 'title', 'body', 'priority', 'users', 'collapseKey', 'ttl', 'data', 'image', 'card']) {
    if (n[k] != null && !(Array.isArray(n[k]) && !n[k].length)) out[k] = n[k];
  }
  Object.defineProperty(out, 'toString', { value: () => legacyText(out), enumerable: false });
  return out;
}

/**
 * One gc.notify call with the fallbacks above.
 * → { sent, pushed, form: 'v2'|'legacy', error } (+ imageDropped / cardDropped: true when sent without its picture / card)
 */
async function deliver(gc, n) {
  const p = payload(n);
  try {
    const r = await gc.notify(p);
    // GateControl ≥ 1.154.0 answers { pushed, id }; an old host answers {}
    const v2 = !!(r && typeof r === 'object' && 'pushed' in r);
    return { sent: true, pushed: v2 ? !!r.pushed : false, form: v2 ? 'v2' : 'legacy', error: null };
  } catch (e) {
    const code = (e && e.code) || 'ERR_NOTIFY';
    if (code !== 'ERR_INVALID') return { sent: false, pushed: false, form: null, error: code };
    if (p.card != null) {
      const { card, ...rest } = n;
      const r = await deliver(gc, rest);
      return r.sent ? { ...r, cardDropped: true } : r;
    }
    if (p.image != null) {
      const { image, ...rest } = n;
      const r = await deliver(gc, rest);
      return r.sent ? { ...r, imageDropped: true } : r;
    }
    try {
      await gc.notify(legacyText(p), { severity: severityOf(p.priority) });
      return { sent: true, pushed: false, form: 'legacy', error: null };
    } catch (e2) {
      return { sent: false, pushed: false, form: null, error: (e2 && e2.code) || 'ERR_NOTIFY' };
    }
  }
}

/**
 * @param {object} gc
 * @param {{ perHour?: number, highReserve?: number, now?: () => number }} [opts]
 */
function createNotifier(gc, { perHour = PER_HOUR, highReserve = HIGH_RESERVE, now = () => Date.now() } = {}) {
  const sentAt = [];           // timestamps of sent notifications (sliding hour)
  const lastByKey = new Map(); // topic|collapseKey → ts
  const warned = new Set();    // error codes logged once

  return {
    /** → { sent, pushed, form, error } (error 'DEDUPED' / 'THROTTLED' when held back here) */
    async send(n, { minGapMs = 0 } = {}) {
      const t = now();
      while (sentAt.length && t - sentAt[0] >= HOUR_MS) sentAt.shift();
      for (const [k, at] of lastByKey) if (t - at >= 24 * HOUR_MS) lastByKey.delete(k);
      const key = `${n.topic}|${n.collapseKey || ''}`;
      if (minGapMs > 0 && lastByKey.has(key) && t - lastByKey.get(key) < minGapMs) return { sent: false, pushed: false, form: null, error: 'DEDUPED' };
      const limit = n.priority === 'high' ? perHour : perHour - highReserve;
      if (sentAt.length >= limit) {
        if (!warned.has('THROTTLED')) { warned.add('THROTTLED'); gc.log.warn('notifications held back: hourly budget used up'); }
        return { sent: false, pushed: false, form: null, error: 'THROTTLED' };
      }
      const r = await deliver(gc, n);
      if (r.sent) {
        sentAt.push(t);
        lastByKey.set(key, t);
      } else if (!warned.has(r.error)) {
        warned.add(r.error);
        gc.log.warn('notification not sent', n.topic, r.error);
      }
      return r;
    },
    /** For tests and the status: how many were sent in the last hour. */
    sentLastHour() {
      const t = now();
      return sentAt.filter((x) => t - x < HOUR_MS).length;
    },
  };
}

/** The persisted state under `key` (null = nothing stored yet: first run). */
async function loadState(gc, key) {
  try {
    const v = await gc.storage.get(key);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Store `value` under `key` when it differs from `previousJson`; returns the new JSON. */
async function saveState(gc, key, value, previousJson) {
  const json = JSON.stringify(value);
  if (json === previousJson) return json;
  try { await gc.storage.set(key, value); } catch (e) { gc.log.warn('notification state not saved', (e && e.code) || (e && e.message)); }
  return json;
}

/** Text in the notification language ('de' | 'en'); {{name}} placeholders. */
function fmt(texts, lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

/** Number in the notification language (no decimals by default). */
function num(v, lang, digits = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: digits }) : '';
}

/** The plugin tab in the apps (data.route and an "open" action). */
function openAction(gc, lang) {
  const route = `plg-${gc.plugin.id}`;
  return { route, actions: [{ id: 'open', label: lang === 'en' ? 'Open' : 'Öffnen', type: 'open_app_route', target: route }] };
}

/** Notification language from the plugin setting notify_lang. */
function langOf(settings) {
  return settings && settings.notify_lang === 'en' ? 'en' : 'de';
}

module.exports = {
  createNotifier, deliver, payload, legacyText, severityOf, loadState, saveState, fmt, num, openAction, langOf,
  HOUR_MS, PER_HOUR, HIGH_RESERVE,
};
