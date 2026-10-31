'use strict';

// CalDAV (RFC 4791, RFC 6638) and CardDAV (RFC 6352) through GateControl's gc.mail.dav.request (≥ 1.219.0,
// permissions.mail.dav): the host makes the HTTPS request (public addresses only, TLS checked, credentials as `auth`
// only) and reads the 207 Multi-Status; the protocol is here — discovery, the collections, sync-collection (RFC 6578)
// with the getctag / ETag fallback, multiget, PUT / DELETE with If-Match. XML goes out as fixed templates.
//
// A redirect to another origin comes back to the plugin (3xx with location): followed with the credentials only when
// the registrable domain stays the same (gmx.net → caldav.gmx.net), else dav_unavailable { reason: 'redirect' }.

const { fail } = require('./util');

const NS = { d: 'DAV:', c: 'urn:ietf:params:xml:ns:caldav', a: 'urn:ietf:params:xml:ns:carddav', cs: 'http://calendarserver.org/ns/', ic: 'http://apple.com/ns/ical/' };
const XML = 'application/xml; charset=utf-8';
const MULTIGET = 50;
const OBJECTS_MAX = 5000;
const REDIRECTS = 3;

/** Does this GateControl have gc.mail.dav (≥ 1.219.0 and the dav permission)? */
const can = (gc) => !!(gc.mail && gc.mail.dav && typeof gc.mail.dav.request === 'function');

const xesc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** The registrable domain of a host (last two labels; three for co.uk-like ones). */
function site(host) {
  const p = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const two = p.slice(-2);
  if (two[1].length === 2 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'or', 'ne'].includes(two[0])) return p.slice(-3).join('.');
  return two.join('.');
}

/** An https URL (webcal: → https:) or null. */
function httpsUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.toString();
}

/** gc.mail.dav's refusals → the API's codes. */
function hostError(e) {
  const code = e && e.code;
  if (code === 'ERR_MAIL_DENIED') return fail('dav_unavailable', { reason: 'host_old' });
  if (code === 'ERR_NETWORK_DENIED') return fail('unreachable', { reason: 'network_denied' });
  // the host's limits: an answer over maxBytes (too large), else its queue (8 at a time, ≤ 100 waiting, ≤ 2 min) → busy
  if (code === 'ERR_MAIL_LIMIT') return /wait|queue|parallel|concurren|at a time|busy/i.test(String((e && e.message) || '')) ? fail('busy', { retryAfter: 30 }) : fail('too_large');
  if (code === 'ERR_DAV_XML') return fail('unreachable', { reason: 'xml' });
  if (code === 'ERR_INVALID') return fail('invalid', { field: 'url' });
  return fail('unreachable', { reason: 'network' });
}

/**
 * One request (o: { url, method, headers, body, depth, parse, maxBytes }) with `auth` ({ user, pass } | null) → the
 * host's answer; follows a redirect to another origin of the same site (with the credentials). 401/403 → auth_failed,
 * 429/503 → busy.
 */
async function request(gc, auth, o) {
  if (!can(gc)) throw fail('dav_unavailable', { reason: 'host_old' });
  let url = o.url;
  for (let i = 0; i <= REDIRECTS; i++) {
    const headers = { ...(o.headers || {}) };
    if (o.depth != null) headers.depth = String(o.depth);
    if (o.body && !headers['content-type']) headers['content-type'] = XML;
    let r;
    try {
      r = await gc.mail.dav.request({ url, method: o.method || 'GET', headers, ...(o.body != null ? { body: o.body } : {}), ...(auth ? { auth } : {}),
        timeoutMs: o.timeoutMs || 30000, ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}), parse: o.parse || 'auto' });
    } catch (e) { throw hostError(e); }
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
      let next;
      try { next = new URL(r.headers.location, r.url || url); } catch { throw fail('dav_unavailable', { reason: 'redirect' }); }
      const from = new URL(url);
      if (next.protocol !== 'https:' || site(next.hostname) !== site(from.hostname)) throw fail('dav_unavailable', { reason: 'redirect' });
      url = next.toString();
      continue;
    }
    if (r.status === 401 || (r.status === 403 && o.method === 'PROPFIND' && o.authCheck)) throw Object.assign(fail('auth_failed'), { dav: true });
    if (r.status === 429 || r.status === 503) throw fail('busy', { retryAfter: Number((r.headers || {})['retry-after']) || 60 });
    return { ...r, url: r.url || url };
  }
  throw fail('dav_unavailable', { reason: 'redirect' });
}

// ─── multistatus helpers ────────────────────────

const ok = (s) => s == null || (s >= 200 && s < 300);

/** The value node of property `name` ('{ns}local') of a response (from a 2xx propstat), or null. */
function prop(resp, name) {
  for (const ps of resp.propstat || []) if (ok(ps.status) && ps.props && ps.props[name]) return ps.props[name];
  return null;
}
const text = (n) => (n && typeof n.text === 'string' ? n.text : null);
const kids = (n) => (n && Array.isArray(n.children) ? n.children : []);
const hrefIn = (n) => { const h = kids(n).find((k) => k.name === '{DAV:}href'); return h && h.text ? h.text.trim() : null; };
const abs = (base, href) => { try { return new URL(href, base).toString(); } catch { return null; } };
const same = (a, b) => { try { const x = new URL(a); const y = new URL(b); return x.origin === y.origin && decodeURIComponent(x.pathname).replace(/\/+$/, '') === decodeURIComponent(y.pathname).replace(/\/+$/, ''); } catch { return false; } };

const PROPFIND = (props) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:cs="${NS.cs}" xmlns:ic="${NS.ic}"><d:prop>${props}</d:prop></d:propfind>`;

async function propfind(gc, auth, url, depth, props, o = {}) {
  const r = await request(gc, auth, { url, method: 'PROPFIND', depth, body: PROPFIND(props), authCheck: o.authCheck });
  if (r.status === 404) throw fail('dav_unavailable', { reason: 'not_found' });
  if (r.status !== 207 || !r.multistatus) throw fail('dav_unavailable', { reason: r.status === 405 || r.status === 501 ? 'not_found' : 'not_found', status: r.status });
  return r;
}

/**
 * Discovery: the home set of `kind` ('caldav' | 'carddav') from `base` (a server root, a /.well-known address or the
 * home itself) → { home, principal }.
 */
async function discover(gc, auth, base, kind) {
  const homeProp = kind === 'caldav' ? '{urn:ietf:params:xml:ns:caldav}calendar-home-set' : '{urn:ietf:params:xml:ns:carddav}addressbook-home-set';
  const homeXml = kind === 'caldav' ? '<c:calendar-home-set/>' : '<a:addressbook-home-set/>';
  let start = base;
  try { const u = new URL(base); if (u.pathname === '/' || u.pathname === '') start = new URL(`/.well-known/${kind}`, u).toString(); } catch { throw fail('invalid', { field: kind === 'caldav' ? 'caldavUrl' : 'carddavUrl' }); }
  let r;
  try {
    r = await propfind(gc, auth, start, 0, `<d:current-user-principal/>${homeXml}<d:resourcetype/>`, { authCheck: true });
  } catch (e) {
    if (start === base || !e || e.code !== 'dav_unavailable') throw e;
    r = await propfind(gc, auth, base, 0, `<d:current-user-principal/>${homeXml}<d:resourcetype/>`, { authCheck: true });
  }
  const first = (r.multistatus.responses || [])[0];
  if (!first) throw fail('dav_unavailable', { reason: 'not_found' });
  const directHome = hrefIn(prop(first, homeProp));
  if (directHome) return { home: abs(r.url, directHome), principal: null };
  const principal = hrefIn(prop(first, '{DAV:}current-user-principal'));
  if (!principal) {
    // the address is a collection (or the home) itself
    return { home: r.url, principal: null };
  }
  const pUrl = abs(r.url, principal);
  const p = await propfind(gc, auth, pUrl, 0, homeXml, { authCheck: true });
  const h = hrefIn(prop((p.multistatus.responses || [])[0] || {}, homeProp));
  if (!h) throw fail('dav_unavailable', { reason: kind === 'caldav' ? 'no_calendar' : 'not_found' });
  return { home: abs(p.url, h), principal: pUrl };
}

/** Read privileges: write → writable. */
function writableOf(resp) {
  const n = prop(resp, '{DAV:}current-user-privilege-set');
  if (!n) return true;
  const names = [];
  const walk = (x) => { for (const k of kids(x)) { names.push(k.name); walk(k); } };
  walk(n);
  return names.some((x) => x === '{DAV:}write' || x === '{DAV:}write-content' || x === '{DAV:}all' || x === '{DAV:}bind');
}

/**
 * The collections of a home → [{ url, name, color, ctag, syncToken, writable, vcardVersion }] (calendars: only those for
 * VEVENT).
 */
async function collections(gc, auth, home, kind) {
  const props = kind === 'caldav'
    ? '<d:displayname/><d:resourcetype/><ic:calendar-color/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/><d:current-user-privilege-set/>'
    : '<d:displayname/><d:resourcetype/><cs:getctag/><d:sync-token/><a:supported-address-data/><d:current-user-privilege-set/>';
  const r = await propfind(gc, auth, home, 1, props);
  const want = kind === 'caldav' ? '{urn:ietf:params:xml:ns:caldav}calendar' : '{urn:ietf:params:xml:ns:carddav}addressbook';
  const out = [];
  for (const resp of r.multistatus.responses || []) {
    const rt = prop(resp, '{DAV:}resourcetype');
    if (!kids(rt).some((k) => k.name === want)) continue;
    if (kind === 'caldav') {
      const comps = prop(resp, '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set');
      if (comps && kids(comps).length && !kids(comps).some((k) => k.attrs && String(k.attrs.name || '').toUpperCase() === 'VEVENT')) continue;
    }
    let vcardVersion = '3.0';
    if (kind === 'carddav') {
      const sad = prop(resp, '{urn:ietf:params:xml:ns:carddav}supported-address-data');
      const versions = kids(sad).map((k) => (k.attrs && k.attrs.version) || '').filter(Boolean);
      if (versions.length && !versions.includes('3.0') && versions.includes('4.0')) vcardVersion = '4.0';
    }
    const color = text(prop(resp, '{http://apple.com/ns/ical/}calendar-color'));
    out.push({
      url: abs(r.url, resp.href) || resp.href, name: (text(prop(resp, '{DAV:}displayname')) || '').trim().slice(0, 80) || null,
      color: color && /^#[0-9A-Fa-f]{6}/.test(color.trim()) ? color.trim().slice(0, 7).toUpperCase() : null,
      ctag: text(prop(resp, '{http://calendarserver.org/ns/}getctag')), syncToken: text(prop(resp, '{DAV:}sync-token')), writable: writableOf(resp), vcardVersion,
    });
  }
  return out;
}

/** OPTIONS → does the server schedule itself (calendar-auto-schedule)? */
async function autoSchedule(gc, auth, url) {
  try {
    const r = await request(gc, auth, { url, method: 'OPTIONS', parse: 'none' });
    return /calendar-auto-schedule/i.test(String((r.headers || {}).dav || ''));
  } catch (e) {
    if (e && (e.code === 'auth_failed' || e.code === 'busy')) throw e;
    return false;
  }
}

/** PROPFIND Depth 0 of a collection → { ctag, syncToken }. */
async function state(gc, auth, url) {
  const r = await propfind(gc, auth, url, 0, '<cs:getctag/><d:sync-token/>');
  const resp = (r.multistatus.responses || [])[0] || {};
  return { ctag: text(prop(resp, '{http://calendarserver.org/ns/}getctag')), syncToken: text(prop(resp, '{DAV:}sync-token')) };
}

/**
 * REPORT sync-collection → { changed: [{ href, etag }], removed: [href], token } or null when the token is no longer
 * valid (a full sync follows).
 */
async function syncCollection(gc, auth, url, token) {
  const body = `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${token ? xesc(token) : ''}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
  const r = await request(gc, auth, { url, method: 'REPORT', depth: 1, body, maxBytes: 20 * 1024 * 1024 });
  if (r.status === 403 || r.status === 409 || r.status === 400 || r.status === 412) return null;
  if (r.status !== 207 || !r.multistatus) {
    if (r.status === 404) throw fail('dav_unavailable', { reason: 'not_found' });
    return null;
  }
  const changed = [];
  const removed = [];
  for (const resp of r.multistatus.responses || []) {
    const href = abs(r.url, resp.href);
    if (!href || same(href, url)) continue;
    if (resp.status === 404 || resp.status === 410) { removed.push(href); continue; }
    const etag = text(prop(resp, '{DAV:}getetag'));
    changed.push({ href, etag });
  }
  return { changed, removed, token: r.multistatus.syncToken || null };
}

/**
 * Every object of a collection with its ETag → [{ href, etag }]. Calendars: REPORT calendar-query with the window
 * (window: { from, to } ms); address books: PROPFIND Depth 1.
 */
async function etags(gc, auth, url, kind, window) {
  let r;
  if (kind === 'caldav') {
    const iso = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const range = window ? `<c:time-range start="${iso(window.from)}" end="${iso(window.to)}"/>` : '';
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${NS.c}"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${range}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    r = await request(gc, auth, { url, method: 'REPORT', depth: 1, body, maxBytes: 20 * 1024 * 1024 });
  } else {
    r = await request(gc, auth, { url, method: 'PROPFIND', depth: 1, body: PROPFIND('<d:getetag/><d:resourcetype/>'), maxBytes: 20 * 1024 * 1024 });
  }
  if (r.status === 404) throw fail('dav_unavailable', { reason: 'not_found' });
  if (r.status !== 207 || !r.multistatus) throw fail('unreachable', { reason: `status_${r.status}` });
  const out = [];
  for (const resp of r.multistatus.responses || []) {
    const href = abs(r.url, resp.href);
    if (!href || same(href, url)) continue;
    const rt = prop(resp, '{DAV:}resourcetype');
    if (rt && kids(rt).some((k) => k.name === '{DAV:}collection')) continue;
    out.push({ href, etag: text(prop(resp, '{DAV:}getetag')) });
    if (out.length >= OBJECTS_MAX) break;
  }
  return out;
}

/** REPORT calendar-multiget / addressbook-multiget in blocks of MULTIGET → [{ href, etag, data }] (missing ones left out). */
async function multiget(gc, auth, url, kind, hrefs) {
  const out = [];
  for (let i = 0; i < hrefs.length; i += MULTIGET) {
    const part = hrefs.slice(i, i + MULTIGET);
    const paths = part.map((h) => { try { const u = new URL(h); return u.pathname + u.search; } catch { return h; } });
    const body = kind === 'caldav'
      ? `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="${NS.c}"><d:prop><d:getetag/><c:calendar-data/></d:prop>${paths.map((p) => `<d:href>${xesc(p)}</d:href>`).join('')}</c:calendar-multiget>`
      : `<?xml version="1.0" encoding="utf-8"?><a:addressbook-multiget xmlns:d="DAV:" xmlns:a="${NS.a}"><d:prop><d:getetag/><a:address-data/></d:prop>${paths.map((p) => `<d:href>${xesc(p)}</d:href>`).join('')}</a:addressbook-multiget>`;
    const r = await request(gc, auth, { url, method: 'REPORT', depth: 1, body, maxBytes: 20 * 1024 * 1024 });
    if (r.status !== 207 || !r.multistatus) throw fail('unreachable', { reason: `status_${r.status}` });
    const dataName = kind === 'caldav' ? '{urn:ietf:params:xml:ns:caldav}calendar-data' : '{urn:ietf:params:xml:ns:carddav}address-data';
    for (const resp of r.multistatus.responses || []) {
      const data = text(prop(resp, dataName));
      if (!data) continue;
      out.push({ href: abs(r.url, resp.href), etag: text(prop(resp, '{DAV:}getetag')), data });
    }
  }
  return out;
}

/** GET one object → { status, data, etag }. */
async function get(gc, auth, href) {
  const r = await request(gc, auth, { url: href, method: 'GET', parse: 'none' });
  return { status: r.status, data: r.body, etag: (r.headers || {}).etag || null };
}

/**
 * PUT an object: new (`etag` null: If-None-Match: *) or a change (If-Match) → { status, etag } — 412 comes back as
 * status (the caller merges), 2xx with the new ETag (null when the server sends none: the caller asks).
 */
async function put(gc, auth, href, data, etag, kind) {
  const headers = { 'content-type': kind === 'caldav' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8' };
  if (etag) headers['if-match'] = etag; else headers['if-none-match'] = '*';
  const r = await request(gc, auth, { url: href, method: 'PUT', headers, body: data, parse: 'none' });
  if (r.status === 412) return { status: 412, etag: null };
  if (r.status === 403 || r.status === 405) throw fail('read_only');
  if (r.status === 413) throw fail('too_large');
  if (r.status < 200 || r.status >= 300) throw fail('unreachable', { reason: `status_${r.status}` });
  return { status: r.status, etag: (r.headers || {}).etag || null };
}

/** DELETE an object (404 / 410: gone already — done). */
async function remove(gc, auth, href, etag) {
  const r = await request(gc, auth, { url: href, method: 'DELETE', headers: etag ? { 'if-match': etag } : {}, parse: 'none' });
  if (r.status === 404 || r.status === 410) return { status: r.status };
  if (r.status === 412) return { status: 412 };
  if (r.status === 403 || r.status === 405) throw fail('read_only');
  if (r.status < 200 || r.status >= 300) throw fail('unreachable', { reason: `status_${r.status}` });
  return { status: r.status };
}

/** The href of a new object `uid` in collection `url`. */
function hrefFor(url, uid, kind) {
  const base = url.endsWith('/') ? url : url + '/';
  const name = encodeURIComponent(String(uid).replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120));
  return `${base}${name}.${kind === 'caldav' ? 'ics' : 'vcf'}`;
}

module.exports = { can, site, httpsUrl, request, discover, collections, autoSchedule, state, syncCollection, etags, multiget, get, put, remove, hrefFor, same, MULTIGET, OBJECTS_MAX };
