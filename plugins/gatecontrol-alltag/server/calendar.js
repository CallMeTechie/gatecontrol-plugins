'use strict';

// Kalender: iCal subscriptions. A subscription reads either an internet
// address of one of the calendar services in plugin.json (Google's "secret
// address", a published iCloud or Outlook calendar; webcal:// is https) or a
// path on the home target "calendar" (Nextcloud, Radicale … behind a
// GateControl route, optional Basic auth). The internet address is a
// secret: stored with gc.settings.setSecret, never sent back to the browser
// (only its host), never logged — errors carry codes and HTTP statuses only.
//
// Refresh every 30 minutes (conditional with ETag / Last-Modified when the
// server sends them; a full read at least once a day so the window moves),
// back off on errors (15 min … 6 h), keep the last good events. Expanded
// window: yesterday … +90 days.

const ics = require('./ics');
const tz = require('./tz');
const store = require('./store');

const MIN = 60000;
const HOUR = 60 * MIN;
const EVERY = 30 * MIN;
const BACKOFF = [15, 30, 60, 120, 240, 360].map((m) => m * MIN);
const FULL_EVERY = 24 * HOUR;
const PAST_MS = 24 * HOUR;
const AHEAD_MS = 90 * 24 * HOUR;
const PER_TICK = 3;
const MAX_STORED = 2000;

// Internet hosts a subscription may use — the same list as plugin.json
// (test/calendar.test.js keeps them in sync). Exact hosts, plus the iCloud
// servers (p01-caldav.icloud.com … p180-caldav.icloud.com).
const EXACT_HOSTS = ['calendar.google.com', 'outlook.office365.com', 'outlook.office.com', 'outlook.live.com'];
const SUFFIX_HOSTS = ['icloud.com'];

const REMINDERS = ['off', 'start', '10', '15', '30', '60'];

function calError(code, status) { return Object.assign(new Error(code), { code, status: status || null }); }

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  return EXACT_HOSTS.includes(h) || SUFFIX_HOSTS.some((s) => h.endsWith('.' + s));
}

/**
 * A subscription address from the admin → { url, host }; webcal(s):// → https://.
 * Throws URL_INVALID (not an https address, credentials in it) or
 * URL_HOST_NOT_ALLOWED (another host — plugins only reach declared hosts).
 */
function checkUrl(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 2000 || /[\s\0-\x1f\x7f]/.test(s)) throw calError('URL_INVALID');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw calError('URL_INVALID'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw calError('URL_INVALID');
  if (u.port && u.port !== '443') throw calError('URL_HOST_NOT_ALLOWED');
  if (!hostAllowed(u.hostname)) throw calError('URL_HOST_NOT_ALLOWED');
  u.hash = '';
  return { url: u.toString(), host: u.hostname.toLowerCase() };
}

/** A home-target path: absolute, no "..", printable, ≤ 1000 characters. */
function checkPath(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith('/') || s.length > 1000 || /[\s\0-\x1f\x7f\\]/.test(s) || s.split(/[/?]/).some((p) => p === '..')) throw calError('PATH_INVALID');
  return s;
}

/** Response bytes → text: UTF-8, or Latin-1 when it is not valid UTF-8 (older exports). */
function decode(r) {
  if (typeof r.bodyBase64 === 'string') {
    const buf = Buffer.from(r.bodyBase64, 'base64');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return buf.toString('latin1'); }
  }
  return String(r.body || '').replace(/^﻿/, '');
}

/** One request for a subscription (conditional when possible). → response */
async function request(gc, sub, { conditional }) {
  const headers = { accept: 'text/calendar, */*;q=0.5' };
  if (conditional && sub.etag) headers['if-none-match'] = sub.etag;
  if (conditional && sub.last_modified) headers['if-modified-since'] = sub.last_modified;
  try {
    if (sub.source === 'url') {
      const url = await store.subSecret(gc, sub.id, 'url');
      if (!url) throw calError('URL_MISSING');
      const { url: safe } = checkUrl(url); // the declared hosts only (also for redirects: the host checks every hop)
      return await gc.http.fetch(safe, { method: 'GET', headers: { 'user-agent': 'GateControl-Alltag/1.0', ...headers }, binary: true, redirect: 'follow', timeoutMs: 20000 });
    }
    if (sub.source === 'target') {
      if (sub.target_index == null || !sub.target_path) throw calError('TARGET_MISSING');
      const user = await store.subSecret(gc, sub.id, 'user');
      const password = await store.subSecret(gc, sub.id, 'password');
      if (user || password) headers.authorization = 'Basic ' + Buffer.from(`${user || ''}:${password || ''}`, 'utf8').toString('base64');
      return await gc.net.fetchTarget('calendar', checkPath(sub.target_path), { index: sub.target_index, method: 'GET', headers, binary: true, timeoutMs: 20000 });
    }
    throw calError('INVALID');
  } catch (e) {
    if (e && /^(URL_|TARGET_|PATH_|INVALID)/.test(e.code || '')) throw e;
    // never pass on the host's message: it may contain the secret address
    throw calError((e && e.code) === 'ERR_NET_DENIED' ? 'CAL_DENIED' : 'CAL_UNREACHABLE');
  }
}

/** Expand a calendar text into the stored window. */
function expandText(text, cfg, now) {
  return ics.expand(text, { tz: cfg.tz, from: now - PAST_MS, to: now + AHEAD_MS });
}

/** Refresh one subscription now. Never throws; on an error the stored events stay. */
async function refreshSub(gc, sub, cfg, now = Date.now(), { force = false } = {}) {
  try {
    const conditional = !force && sub.last_parsed_at && now - sub.last_parsed_at < FULL_EVERY;
    const r = await request(gc, sub, { conditional });
    if (r.status === 304 && conditional) {
      await store.updateSub(gc, sub.id, { status: 'ok', last_error: null, error_count: 0, last_attempt_at: now, last_success_at: now, next_refresh_at: now + EVERY });
      return { ok: true, unchanged: true };
    }
    if (r.status === 401 || r.status === 403) throw calError('CAL_AUTH', r.status);
    if (r.status === 404 || r.status === 410) throw calError('CAL_NOT_FOUND', r.status);
    if (r.status < 200 || r.status >= 300) throw calError('CAL_HTTP', r.status);
    const res = expandText(decode(r), cfg, now);
    const instances = res.instances.slice(0, MAX_STORED);
    await store.replaceEvents(gc, sub.id, instances);
    const h = r.headers || {};
    await store.updateSub(gc, sub.id, {
      status: 'ok', last_error: null, error_count: 0, last_attempt_at: now, last_success_at: now, last_parsed_at: now, next_refresh_at: now + EVERY,
      etag: typeof h.etag === 'string' ? h.etag.slice(0, 200) : null, last_modified: typeof h['last-modified'] === 'string' ? h['last-modified'].slice(0, 100) : null,
      event_count: instances.length, truncated: res.truncated || res.instances.length > MAX_STORED,
    });
    return { ok: true, events: instances.length };
  } catch (e) {
    const code = (e && e.code) || 'CAL_FAILED';
    const count = (sub.error_count || 0) + 1;
    const detail = e && e.status ? `${code}:${e.status}` : code;
    await store.updateSub(gc, sub.id, { status: 'error', last_error: String(detail).slice(0, 60), error_count: count, last_attempt_at: now, next_refresh_at: now + BACKOFF[Math.min(count - 1, BACKOFF.length - 1)] });
    gc.log.warn('calendar refresh failed', sub.id, detail); // a code only — never the address
    return { ok: false, code, status: e && e.status ? e.status : null };
  }
}

/** Background: the subscriptions that are due (at most PER_TICK, none started after `deadline`). */
async function tick(gc, cfg, now = Date.now(), deadline = Infinity) {
  const due = (await store.listSubs(gc)).filter((s) => s.enabled && s.next_refresh_at <= now)
    .sort((a, b) => a.next_refresh_at - b.next_refresh_at).slice(0, PER_TICK);
  let n = 0;
  for (const s of due) {
    if (Date.now() >= deadline) break;
    await refreshSub(gc, s, cfg, now);
    n++;
  }
  return n;
}

/** Subscriptions this person sees (explicit list per subscription). */
function visibleTo(sub, userId) {
  return !!sub.enabled && Array.isArray(sub.users) && sub.users.includes(userId);
}

/** "calendar.google.com/…" — what the browser may see of a secret address. */
function masked(sub) {
  if (sub.source === 'url') return sub.url_host ? `${sub.url_host}/…` : null;
  return sub.target_path || null;
}

module.exports = {
  checkUrl, checkPath, hostAllowed, decode, request, expandText, refreshSub, tick, visibleTo, masked,
  EXACT_HOSTS, SUFFIX_HOSTS, REMINDERS, EVERY, BACKOFF, PAST_MS, AHEAD_MS, PER_TICK,
};
