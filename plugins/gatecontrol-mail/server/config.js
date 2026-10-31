'use strict';

// The administrator's settings (Portal/Admin "Mail › Einstellungen", mockup AdminEinstellungen) and who may use Mail.
//
//   allowed          { all: true, principals: [{ type: 'user'|'group', id, label? }] }   who sees the tab
//   accountsMax      1 … 20 (5)            accounts per person
//   retentionMonths  1 | 3 | 6 | 12 | 24 | 0 = everything (12)   mails kept on the server; older ones load on opening
//   attachments      'on_demand' | 'always' (up to 10 MB)          attachments cached on arrival or when opened
//   quotaGB          1 … 100 (5)           per person: bodies + cached attachments
//   ai               { bar, sort, autoFile, blockBusiness }       (true, true, true, false)
//   microsoft        { registration: 'default'|'custom', customClientId }
//   calendar         { enabled (true), accounts (true: the accounts' calendars are synced), business: 'gatecontrol' |
//                      'exchange' ('gatecontrol'), defaultReminder (15; 0 | 5 | 10 | 15 | 30 | 60 | 1440 | null),
//                      internalInvites (true), overlays: { familie, alltag, birthdays } (true) }      since 1.2.0
//   contacts         { enabled (true), accounts (true: the accounts' address books are synced), ai (true: the
//                      signature read with the AI for „Als Kontakt speichern“) }                     since 1.2.0
//
// Kept in the plugin's storage (key 'admin'); GET/PUT admin/settings. DEFAULT_MS_CLIENT_ID: the publisher's Microsoft
// app registration (public client, since 1.3.2) — used unless an administrator enters an own client id.

const { fail } = require('./util');

const DEFAULT_MS_CLIENT_ID = 'b2f917a9-e0eb-45b9-9e5f-14c283aa51e9';
const MS_AUTHORITY = 'https://login.microsoftonline.com/common';
const MS_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'];
// since 1.2.0: calendars and contacts of Microsoft accounts (asked when the administrator has them on)
const MS_CALENDAR_SCOPE = 'Calendars.ReadWrite';
const MS_CONTACTS_SCOPE = 'Contacts.ReadWrite';
const REMINDERS = [0, 5, 10, 15, 30, 60, 1440, null];
const RETENTIONS = [1, 3, 6, 12, 24, 0];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULTS = Object.freeze({
  allowed: { all: true, principals: [] },
  accountsMax: 5,
  retentionMonths: 12,
  attachments: 'on_demand',
  quotaGB: 5,
  ai: { bar: true, sort: true, autoFile: true, blockBusiness: false },
  microsoft: { registration: 'default', customClientId: null },
  calendar: { enabled: true, accounts: true, business: 'gatecontrol', defaultReminder: 15, internalInvites: true, overlays: { familie: true, alltag: true, birthdays: true } },
  contacts: { enabled: true, accounts: true, ai: true },
});

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Stored settings over the defaults (unknown or bad values fall back). */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = clone(DEFAULTS);
  const out = d;
  if (r.allowed && typeof r.allowed === 'object') {
    out.allowed = { all: r.allowed.all !== false, principals: principalsOf(r.allowed.principals) };
  }
  if (Number.isInteger(r.accountsMax) && r.accountsMax >= 1 && r.accountsMax <= 20) out.accountsMax = r.accountsMax;
  if (RETENTIONS.includes(r.retentionMonths)) out.retentionMonths = r.retentionMonths;
  if (r.attachments === 'on_demand' || r.attachments === 'always') out.attachments = r.attachments;
  if (Number.isInteger(r.quotaGB) && r.quotaGB >= 1 && r.quotaGB <= 100) out.quotaGB = r.quotaGB;
  if (r.ai && typeof r.ai === 'object') for (const k of Object.keys(d.ai)) if (typeof r.ai[k] === 'boolean') out.ai[k] = r.ai[k];
  if (r.microsoft && typeof r.microsoft === 'object') {
    out.microsoft.registration = r.microsoft.registration === 'custom' ? 'custom' : 'default';
    out.microsoft.customClientId = typeof r.microsoft.customClientId === 'string' && GUID_RE.test(r.microsoft.customClientId.trim()) ? r.microsoft.customClientId.trim().toLowerCase() : null;
  }
  if (r.calendar && typeof r.calendar === 'object') {
    for (const k of ['enabled', 'accounts', 'internalInvites']) if (typeof r.calendar[k] === 'boolean') out.calendar[k] = r.calendar[k];
    if (r.calendar.business === 'exchange' || r.calendar.business === 'gatecontrol') out.calendar.business = r.calendar.business;
    if (REMINDERS.includes(r.calendar.defaultReminder)) out.calendar.defaultReminder = r.calendar.defaultReminder;
    if (r.calendar.overlays && typeof r.calendar.overlays === 'object') for (const k of Object.keys(d.calendar.overlays)) if (typeof r.calendar.overlays[k] === 'boolean') out.calendar.overlays[k] = r.calendar.overlays[k];
  }
  if (r.contacts && typeof r.contacts === 'object') for (const k of Object.keys(d.contacts)) if (typeof r.contacts[k] === 'boolean') out.contacts[k] = r.contacts[k];
  return out;
}

function principalsOf(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const p of v.slice(0, 200)) {
    if (!p || (p.type !== 'user' && p.type !== 'group') || !Number.isSafeInteger(p.id) || p.id <= 0) continue;
    if (!out.some((x) => x.type === p.type && x.id === p.id)) out.push({ type: p.type, id: p.id, label: typeof p.label === 'string' ? p.label.slice(0, 120) : null });
  }
  return out;
}

let cache = null;

async function get(gc) {
  if (cache) return cache;
  let raw = null;
  try { raw = await gc.storage.get('admin'); } catch { raw = null; }
  cache = normalize(raw);
  return cache;
}

/** PUT admin/settings — a partial object; every given value is checked (400 invalid { field }). */
async function put(gc, body) {
  const b = body && typeof body === 'object' ? body : {};
  const cur = clone(await get(gc));
  const bad = (field) => { throw fail('invalid', { field }); };
  if (b.allowed !== undefined) {
    if (!b.allowed || typeof b.allowed !== 'object' || typeof b.allowed.all !== 'boolean' || (b.allowed.principals != null && !Array.isArray(b.allowed.principals))) bad('allowed');
    cur.allowed = { all: b.allowed.all, principals: principalsOf(b.allowed.principals) };
  }
  if (b.accountsMax !== undefined) { if (!(Number.isInteger(b.accountsMax) && b.accountsMax >= 1 && b.accountsMax <= 20)) bad('accountsMax'); cur.accountsMax = b.accountsMax; }
  if (b.retentionMonths !== undefined) { if (!RETENTIONS.includes(b.retentionMonths)) bad('retentionMonths'); cur.retentionMonths = b.retentionMonths; }
  if (b.attachments !== undefined) { if (b.attachments !== 'on_demand' && b.attachments !== 'always') bad('attachments'); cur.attachments = b.attachments; }
  if (b.quotaGB !== undefined) { if (!(Number.isInteger(b.quotaGB) && b.quotaGB >= 1 && b.quotaGB <= 100)) bad('quotaGB'); cur.quotaGB = b.quotaGB; }
  if (b.ai !== undefined) {
    if (!b.ai || typeof b.ai !== 'object') bad('ai');
    for (const [k, v] of Object.entries(b.ai)) { if (!(k in cur.ai) || typeof v !== 'boolean') bad('ai.' + k); cur.ai[k] = v; }
  }
  if (b.microsoft !== undefined) {
    const m = b.microsoft;
    if (!m || typeof m !== 'object') bad('microsoft');
    if (m.registration !== undefined) { if (m.registration !== 'default' && m.registration !== 'custom') bad('microsoft.registration'); cur.microsoft.registration = m.registration; }
    if (m.customClientId !== undefined) {
      if (m.customClientId !== null && !(typeof m.customClientId === 'string' && GUID_RE.test(m.customClientId.trim()))) bad('microsoft.customClientId');
      cur.microsoft.customClientId = m.customClientId ? m.customClientId.trim().toLowerCase() : null;
    }
  }
  if (b.calendar !== undefined) {
    const c = b.calendar;
    if (!c || typeof c !== 'object') bad('calendar');
    for (const [k, v] of Object.entries(c)) {
      if (['enabled', 'accounts', 'internalInvites'].includes(k)) { if (typeof v !== 'boolean') bad('calendar.' + k); cur.calendar[k] = v; } else if (k === 'business') {
        if (v !== 'gatecontrol' && v !== 'exchange') bad('calendar.business');
        cur.calendar.business = v;
      } else if (k === 'defaultReminder') {
        if (!REMINDERS.includes(v)) bad('calendar.defaultReminder');
        cur.calendar.defaultReminder = v;
      } else if (k === 'overlays') {
        if (!v || typeof v !== 'object') bad('calendar.overlays');
        for (const [o, x] of Object.entries(v)) { if (!(o in cur.calendar.overlays) || typeof x !== 'boolean') bad('calendar.overlays.' + o); cur.calendar.overlays[o] = x; }
      } else bad('calendar.' + k);
    }
  }
  if (b.contacts !== undefined) {
    if (!b.contacts || typeof b.contacts !== 'object') bad('contacts');
    for (const [k, v] of Object.entries(b.contacts)) { if (!(k in cur.contacts) || typeof v !== 'boolean') bad('contacts.' + k); cur.contacts[k] = v; }
  }
  await gc.storage.set('admin', cur);
  cache = normalize(cur);
  return cache;
}

/** The Microsoft client id in use, or null (then no Microsoft sign-in). */
function msClientId(cfg) {
  if (cfg.microsoft.registration === 'custom') return cfg.microsoft.customClientId || null;
  return DEFAULT_MS_CLIENT_ID;
}

/** The link an administrator of a company tenant opens to allow the app for everybody. */
function adminConsentUrl(clientId) {
  return clientId ? `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}` : null;
}

/** May person `userId` use Mail (the administrator's "Wer darf Mail nutzen")? */
async function allowed(gc, cfg, userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  if (cfg.allowed.all) return true;
  for (const p of cfg.allowed.principals) {
    if (p.type === 'user' && p.id === userId) return true;
  }
  for (const p of cfg.allowed.principals) {
    if (p.type !== 'group' || !gc.groups || typeof gc.groups.isMember !== 'function') continue;
    try { if (await gc.groups.isMember(userId, p.id, { nested: true })) return true; } catch { /* a group that went */ }
  }
  return false;
}

/** The first day kept (ms), or 0 for everything. */
function retentionStart(cfg, now) {
  if (!cfg.retentionMonths) return 0;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - cfg.retentionMonths);
  return d.getTime();
}

const quotaBytes = (cfg) => cfg.quotaGB * 1024 ** 3;

/** The Microsoft scopes a sign-in asks for (GET me microsoft.scopes): mail, and calendars / contacts when they are on. */
function msScopes(cfg) {
  const out = [...MS_SCOPES];
  if (cfg.calendar.enabled && cfg.calendar.accounts) out.push(MS_CALENDAR_SCOPE);
  if (cfg.contacts.enabled && cfg.contacts.accounts) out.push(MS_CONTACTS_SCOPE);
  return out;
}

function reset() { cache = null; }

module.exports = {
  DEFAULTS, DEFAULT_MS_CLIENT_ID, MS_AUTHORITY, MS_SCOPES, MS_CALENDAR_SCOPE, MS_CONTACTS_SCOPE, REMINDERS, msScopes, RETENTIONS, get, put, normalize, msClientId, adminConsentUrl, allowed,
  retentionStart, quotaBytes, reset,
};
