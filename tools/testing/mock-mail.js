'use strict';

// GateControl 1.216.0 for the mock host (tools/testing/mock-host.js): gc.mail (IMAP sessions, SMTP, MIME, the HTML
// sanitizer, autoconfig), gc.http.fetchImage, permissions.mail, permissions.network.images and services.provides
// maxPerHour — the host's checks and wire format; the mail servers and the internet come from the test:
//
//   createHost(dir, { gatecontrol: '1.216.0', mail: {
//     imap: async (opts, ctx) => session,      // opts = connect()'s { host, port, security, auth, timeoutMs }; a session
//                                              // implements list/status/open/fetch/message/download/search/flags/move/
//                                              // copy/expunge/append/idle/noop/close (each may be missing → ERR_MAIL_PROTOCOL)
//                                              // and may carry capabilities / serverInfo; throw hostError('ERR_MAIL_AUTH')
//                                              // etc. to refuse. ctx = { putMedia({ data, mime, name }) → mediaId (unclaimed,
//                                              // the plugin's), media(id) → { data, mime, name } | null, emit(event, data) }
//     smtp: async (opts, ctx) => ({ messageId, accepted, rejected }),   // opts = send()'s argument
//     autoconfig: async (email) => ({ imap, smtp, source }),
//     denied: (host) => boolean,               // a host whose addresses are not public (default: localhost, *.local,
//                                              // private and loopback IPv4)
//   }, fetchImage: async (url) => ({ status, mime, body: Buffer }) })
// fetchImage like the host: ports 80/443/8080/8443, public hosts (ERR_NETWORK_DENIED), not 2xx → ERR_HTTP { status },
// not a picture or SVG → ERR_INVALID, over maxBytes (≤ 5 MB) → ERR_MEDIA_TOO_LARGE.
//
// gc.mail exists only with permissions.mail on a host ≥ 1.216.0 (or with opts.mail on an older emulated version);
// gc.http.fetchImage with ≥ 1.216.0 or opts.fetchImage, and refuses (ERR_NET_DENIED) without permissions.network.images.
// The host records: host.mailSessions (every connect: { id, host, port, security, user, open, closed }), host.mailSent
// (every smtp.send argument), host.imageFetches (urls).
//
// GateControl 1.217.0 (opt-in: opts.gatecontrol: '1.217.0'): gc.mail.smtp.verify({ host, port, security, auth, timeoutMs })
// → { ok: true } with the checks of smtp.send, asks opts.mail.verify(opts) (missing: every login passes; throw
// hostError('ERR_MAIL_AUTH') to refuse; recorded in host.mailVerified); gc.http.fetch(url, { bodyMedia: { mediaId, start,
// end, encoding } }) and gc.http.MEDIA_BASE64 — the test's opts.fetch gets the body the host would send (`body` as a
// Buffer, `headers` with content-length / content-range / content-type; bodyMedia and json stay for the record). Older emulated
// versions: no verify, no MEDIA_BASE64, and opts.fetch sees bodyMedia without a body (the real older host ignores it).

const EventEmitter = require('node:events');
const crypto = require('node:crypto');

const MAIL_PORTS = { imap: { 993: 'tls', 143: 'starttls' }, smtp: { 465: 'tls', 587: 'starttls' } };
const SESSION_METHODS = ['list', 'status', 'open', 'fetch', 'message', 'download', 'search', 'flags', 'move', 'copy', 'expunge', 'append', 'idle', 'noop', 'close'];
const SEND_MAX = 50 * 1024 * 1024;
const FETCH_MAX = 500;
const IMAGE_MAX = 5 * 1024 * 1024;
const MEDIA_BASE64 = '{{gc:media:base64}}';
const BODY_MEDIA_MAX = 64 * 1024 * 1024;
const BODY_MEDIA_BASE64_MAX = 4 * 1024 * 1024;
const TRACKER_HOSTS = ['pixel.example', 'track.example', 'open.mailchimp.example', 'mailtrack.io', 'list-manage.com'];

const purposeOk = (p) => !!(p && typeof p === 'object' && !Array.isArray(p) && p.purpose && typeof p.purpose === 'object'
  && ['de', 'en'].some((l) => typeof p.purpose[l] === 'string' && p.purpose[l].trim()) && Object.values(p.purpose).every((v) => typeof v === 'string' && v.length <= 200));

/**
 * permissions.mail { purpose, maxConnections? (1…200, default 50), dav? { purpose } } → { maxConnections, dav } | null;
 * throws on a bad one. `dav` is accepted at every emulated version (like maxPerHour — the real older host refuses it) and
 * acts from 1.219.0 on (gc.mail.dav), so a plugin built for 1.219.0 can be tested against the older behaviour too.
 */
function mailPermission(perm, hostError) {
  if (perm == null) return null;
  const ok = purposeOk(perm) && Object.keys(perm).every((k) => k === 'purpose' || k === 'maxConnections' || k === 'dav')
    && (perm.maxConnections === undefined || (Number.isInteger(perm.maxConnections) && perm.maxConnections >= 1 && perm.maxConnections <= 200))
    && (perm.dav === undefined || (purposeOk(perm.dav) && Object.keys(perm.dav).every((k) => k === 'purpose')));
  if (!ok) throw hostError('ERR_INVALID', 'plugin.json: permissions.mail: invalid');
  return { maxConnections: perm.maxConnections || 50, dav: !!perm.dav };
}

// GateControl 1.219.0: gc.mail.dav.request — the host's checks (src/services/plugins/mail/dav.js)
const DAV_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT', 'PUT', 'DELETE'];
const DAV_HEADERS = ['depth', 'content-type', 'if-match', 'if-none-match', 'prefer', 'brief', 'accept', 'if-modified-since'];
const DAV_RESPONSE_HEADERS = ['etag', 'content-type', 'location', 'dav', 'allow', 'retry-after', 'last-modified', 'content-length'];
const DAV_BODY_MAX = 2 * 1024 * 1024;
const ICAL_METHODS = ['REQUEST', 'REPLY', 'CANCEL', 'COUNTER', 'DECLINECOUNTER'];
const ICAL_MAX = 512 * 1024;

/** The default "not public" test of the mock (the real host resolves and checks every address). */
function notPublic(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function checkTarget(kind, o, opts, hostError) {
  const x = o && typeof o === 'object' ? o : {};
  if (typeof x.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(x.host)) throw hostError('ERR_INVALID', 'invalid host');
  const port = Number(x.port);
  const sec = MAIL_PORTS[kind][port];
  if (!sec) throw hostError('ERR_NETWORK_DENIED', `port ${x.port} is not allowed for ${kind}`);
  if (x.security !== sec) throw hostError('ERR_INVALID', `port ${port} needs security '${sec}'`);
  const denied = opts.denied || notPublic;
  if (denied(x.host)) throw hostError('ERR_NETWORK_DENIED', `${x.host} is not a public address`);
  const a = x.auth;
  if (!a || typeof a !== 'object' || typeof a.user !== 'string' || !a.user || (typeof a.pass !== 'string' && typeof a.accessToken !== 'string')) {
    throw hostError('ERR_INVALID', 'invalid auth');
  }
  return { host: x.host, port, security: sec, auth: a.accessToken ? { user: a.user, accessToken: a.accessToken } : { user: a.user, pass: a.pass }, timeoutMs: x.timeoutMs };
}

/** A UID range: '1:*', '5,7,9', '3:8', a number or an array of numbers. */
function rangeOk(r) {
  if (Array.isArray(r)) return r.length > 0 && r.every((n) => Number.isSafeInteger(n) && n > 0);
  if (Number.isSafeInteger(r)) return r > 0;
  return typeof r === 'string' && /^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(r);
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A small stand-in for the host's sanitizer (sanitize-html): enough for the plugin's tests, never for real mail. */
function sanitize(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<(script|iframe|object|embed|form|input|button|meta|link|base)\b[^>]*>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
  const images = [];
  let trackers = 0;
  s = s.replace(/<img\b([^>]*)>/gi, (all, attrs) => {
    const src = /\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const url = src ? (src[2] != null ? src[2] : src[3]) : '';
    if (/^cid:/i.test(url)) return all;
    if (!/^https?:\/\//i.test(url)) return '';
    const w = /\swidth\s*=\s*["']?(\d+)/i.exec(attrs);
    const hgt = /\sheight\s*=\s*["']?(\d+)/i.exec(attrs);
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
    if ((w && Number(w[1]) <= 1 && hgt && Number(hgt[1]) <= 1) || TRACKER_HOSTS.some((t) => host === t || host.endsWith('.' + t))) { trackers++; return ''; }
    images.push(url);
    return `<img${attrs.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*')/i, ` src="gc-img:${images.length - 1}"`)}>`;
  });
  s = s.replace(/<a\b([^>]*)>/gi, (all, attrs) => `<a${attrs.replace(/\s(target|rel)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')} target="_blank" rel="noopener noreferrer">`);
  return { html: s, images, trackers };
}

const addr = (a) => (a && a.address ? (a.name ? `"${String(a.name).replace(/"/g, '')}" <${a.address}>` : a.address) : '');
const addrs = (l) => (Array.isArray(l) ? l.map(addr).filter(Boolean).join(', ') : '');

/** RFC 822 text of a message (the mock's composer; parse() reads it back). */
function compose(m, messageId) {
  const lines = [
    `Message-ID: ${messageId}`, `Date: ${new Date(m.date || Date.now()).toUTCString()}`, `From: ${addr(m.from)}`,
    ...(m.to && m.to.length ? [`To: ${addrs(m.to)}`] : []), ...(m.cc && m.cc.length ? [`Cc: ${addrs(m.cc)}`] : []),
    `Subject: ${String(m.subject || '').replace(/[\r\n]/g, ' ')}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []), ...(m.references && m.references.length ? [`References: ${m.references.join(' ')}`] : []),
    ...Object.entries(m.headers || {}).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, ' ')}`),
    'MIME-Version: 1.0', `X-Mock-Json: ${Buffer.from(JSON.stringify({ html: m.html || null, text: m.text || null, attachments: (m.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, cid: a.cid || null })),
      calendar: m.icalEvent ? [{ method: m.icalEvent.method, text: m.icalEvent.content }] : [] })).toString('base64')}`,
    'Content-Type: text/plain; charset=utf-8', '', String(m.text || ''),
  ];
  return lines.join('\r\n');
}

function parseAddrList(v) {
  if (!v) return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^"?([^"<]*)"?\s*<([^>]+)>$/.exec(x);
    return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: x };
  });
}

function parse(text) {
  const [head] = String(text).split('\r\n\r\n');
  const h = {};
  for (const l of head.split('\r\n')) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  let extra = {};
  try { extra = JSON.parse(Buffer.from(h['x-mock-json'] || '', 'base64').toString('utf8') || '{}'); } catch { extra = {}; }
  return {
    messageId: h['message-id'] || null, inReplyTo: h['in-reply-to'] || null, references: h.references ? h.references.split(/\s+/) : [],
    date: h.date ? Date.parse(h.date) : null, subject: h.subject || '', from: parseAddrList(h.from)[0] || null, to: parseAddrList(h.to), cc: parseAddrList(h.cc), bcc: [], replyTo: [],
    html: extra.html || null, text: extra.text || null, listUnsubscribe: null, autoSubmitted: null, precedence: null, listId: null,
    attachments: (extra.attachments || []).map((a, i) => ({ partId: String(i + 2), filename: a.filename, contentType: a.contentType, size: 0, contentId: a.cid, inline: !!a.cid, checksum: null, mediaId: null })),
    // GateControl ≥ 1.219.0: the text/calendar parts (iMIP); the mock carries them in X-Mock-Json
    calendar: (extra.calendar || []).map((c, i) => ({ partId: c.partId || String(i + 90), method: c.method || null, text: c.text })),
  };
}

/**
 * Install GateControl 1.216.0's mail API into a mock host. `h` = the mock host's internals:
 * { manifest, perms, opts, hostError, wire, gc216, mediaStore, mediaQuota, mediaUsage, media, internetAllowed, typeAllowed }
 * → { gcMail (or undefined), fetchImage (or undefined), records: { mailSessions, mailSent, imageFetches } }
 */
function install(h) {
  const { perms, opts, hostError, wire, mediaStore } = h;
  const gc219 = !!h.gc219;
  const mailOpt = opts.mail && typeof opts.mail === 'object' ? opts.mail : null;
  const mailOn = !!mailOpt || h.gc216;
  const perm = mailOn ? mailPermission(perms.mail, hostError) : null;
  const records = { mailSessions: [], mailSent: [], imageFetches: [], mailVerified: [], davRequests: [] };
  const sessions = new Map(); // id → { impl, emitter, open, rec }

  const putMedia = ({ data, mime, name }) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data == null ? '' : data));
    if (!h.media) throw hostError('ERR_MEDIA_DENIED', 'plugin.json declares no media');
    if (h.mediaUsage().bytes + buf.length > h.mediaQuota) throw hostError('ERR_MEDIA_QUOTA', 'quota exceeded');
    const id = crypto.randomBytes(16).toString('hex');
    mediaStore.set(id, { mime: String(mime || 'application/octet-stream'), bytes: buf.length, owner: null, data: Buffer.from(buf), claimed: false, createdAt: Date.now(), name: name || null });
    return id;
  };
  const media = (id) => { const m = mediaStore.get(id); return m ? { data: m.data, mime: m.mime, name: m.name || null } : null; };

  /**
   * gc.mail.dav.request (≥ 1.219.0) against the test's opts.mail.dav(req) → { status, headers, body } | { status,
   * multistatus } (the test gives the parsed Multi-Status like the host's saxes reader would). Same-origin redirects are
   * followed (≤ 5, with auth), another origin comes back as 3xx; HTTP statuses are never thrown.
   */
  const davRequest = async (o) => {
    const x = wire(o) || {};
    let u;
    try { u = new URL(String(x.url)); } catch { throw hostError('ERR_INVALID', 'invalid url'); }
    const method = String(x.method || 'GET').toUpperCase();
    if (!DAV_METHODS.includes(method)) throw hostError('ERR_INVALID', `method ${method} is not allowed`);
    const headers = {};
    for (const [k, v] of Object.entries(x.headers || {})) {
      if (!DAV_HEADERS.includes(k.toLowerCase())) throw hostError('ERR_INVALID', `header ${k} is not allowed`);
      headers[k.toLowerCase()] = String(v);
    }
    if (x.body != null && (typeof x.body !== 'string')) throw hostError('ERR_INVALID', 'body must be a string');
    if (x.body != null && Buffer.byteLength(x.body) > DAV_BODY_MAX) throw hostError('ERR_MAIL_LIMIT', 'body larger than 2 MB');
    const a = x.auth;
    if (a != null && !(a && typeof a === 'object' && ((typeof a.user === 'string' && typeof a.pass === 'string') || typeof a.bearer === 'string'))) throw hostError('ERR_INVALID', 'invalid auth');
    if (x.timeoutMs != null && !(Number.isInteger(x.timeoutMs) && x.timeoutMs >= 1000 && x.timeoutMs <= 60000)) throw hostError('ERR_INVALID', 'invalid timeoutMs');
    if (x.parse != null && x.parse !== 'auto' && x.parse !== 'none') throw hostError('ERR_INVALID', 'invalid parse');
    const maxBytes = Number.isInteger(x.maxBytes) ? x.maxBytes : 5 * 1024 * 1024;
    if (maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw hostError('ERR_INVALID', 'invalid maxBytes');
    const denied = (mailOpt && mailOpt.denied) || notPublic;
    let url = u;
    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== 'https:') throw hostError('ERR_NETWORK_DENIED', 'https only');
      const port = Number(url.port || 443);
      if (port !== 443 && port !== 8443) throw hostError('ERR_NETWORK_DENIED', `port ${port} is not allowed`);
      if (denied(url.hostname)) throw hostError('ERR_NETWORK_DENIED', `${url.hostname} is not a public address`);
      const req = { url: url.toString(), method, headers, body: x.body == null ? null : x.body, auth: a ? (a.bearer ? { bearer: true } : { user: a.user, pass: a.pass }) : null };
      records.davRequests.push({ url: req.url, method, headers, body: req.body, auth: a ? (a.bearer ? { bearer: true } : { user: a.user }) : null });
      if (!mailOpt || typeof mailOpt.dav !== 'function') throw hostError('ERR_MAIL_NET', 'no CalDAV/CardDAV server in this test');
      const r = wire(await mailOpt.dav(req)) || {};
      const status = Number(r.status || 200);
      const rh = {};
      for (const [k, v] of Object.entries(r.headers || {})) if (DAV_RESPONSE_HEADERS.includes(k.toLowerCase())) rh[k.toLowerCase()] = String(v);
      if ([301, 302, 303, 307, 308].includes(status) && rh.location) {
        const next = new URL(rh.location, url);
        if (next.origin === url.origin) { url = next; continue; }
        return { status, url: url.toString(), headers: rh, body: null, multistatus: null };
      }
      const body = r.body == null ? null : String(r.body);
      if (body && Buffer.byteLength(body) > maxBytes) throw hostError('ERR_MAIL_LIMIT', 'answer larger than maxBytes');
      const ms = status === 207 && x.parse !== 'none' && r.multistatus ? r.multistatus : null;
      // the host makes every href absolute
      if (ms) for (const resp of ms.responses || []) { try { resp.href = new URL(resp.href, url).toString(); } catch { /* as is */ } }
      return { status, url: url.toString(), headers: rh, body: ms ? null : body, multistatus: ms ? { responses: ms.responses || [], syncToken: ms.syncToken || null } : null };
    }
    throw hostError('ERR_MAIL_NET', 'too many redirects');
  };

  let gcMail;
  if (perm) {
    const openCount = () => [...sessions.values()].filter((s) => s.open).length;
    const connect = async (o) => {
      const t = checkTarget('imap', wire(o), mailOpt || {}, hostError);
      if (openCount() >= perm.maxConnections) throw hostError('ERR_MAIL_LIMIT', `at most ${perm.maxConnections} IMAP sessions`);
      if (!mailOpt || typeof mailOpt.imap !== 'function') throw hostError('ERR_MAIL_NET', 'no IMAP server in this test');
      const id = crypto.randomBytes(8).toString('hex');
      const emitter = new EventEmitter();
      const rec = { id, host: t.host, port: t.port, security: t.security, user: t.auth.user, oauth: !!t.auth.accessToken, open: true, closed: false, idle: false, calls: [] };
      const ctx = { putMedia, media, emit: (ev, data) => setImmediate(() => { if (rec.open || ev === 'close') emitter.emit(ev, wire(data)); }) };
      const impl = await mailOpt.imap(wire(t), ctx);
      const s = { impl, emitter, open: true, rec };
      sessions.set(id, s);
      records.mailSessions.push(rec);
      const session = new EventEmitter();
      session.id = id;
      session.capabilities = wire(impl.capabilities || ['IMAP4rev1', 'IDLE', 'UIDPLUS', 'MOVE']);
      session.serverInfo = impl.serverInfo ? wire(impl.serverInfo) : null;
      emitter.on('exists', (d) => session.emit('exists', d));
      emitter.on('expunge', (d) => session.emit('expunge', d));
      emitter.on('flags', (d) => session.emit('flags', d));
      emitter.on('error', (d) => session.emit('error', d));
      emitter.on('close', (d) => { s.open = false; rec.open = false; rec.closed = true; session.emit('close', d); });
      for (const m of SESSION_METHODS) {
        session[m] = async (...args) => {
          if (!s.open) throw hostError('ERR_MAIL_NET', 'the session is closed');
          const a = wire(args);
          if (['fetch', 'flags', 'move', 'copy', 'expunge'].includes(m) && !rangeOk(a[0])) throw hostError('ERR_INVALID', 'invalid UID range');
          if (m === 'append' && !mediaStore.has(a[1])) throw hostError('ERR_INVALID', 'unknown media id');
          rec.calls.push({ method: m, args: a });
          if (m === 'idle') { rec.idle = true; if (typeof impl.idle === 'function') await impl.idle(); return null; }
          if (m !== 'noop' && m !== 'close') rec.idle = false;
          if (m === 'close') {
            s.open = false; rec.open = false; rec.closed = true;
            if (typeof impl.close === 'function') await impl.close();
            return null;
          }
          if (typeof impl[m] !== 'function') throw hostError('ERR_MAIL_PROTOCOL', `${m} is not supported by this test server`);
          const out = wire(await impl[m](...a));
          if (m === 'fetch' && Array.isArray(out) && out.length > FETCH_MAX) throw hostError('ERR_INVALID', `more than ${FETCH_MAX} messages in one fetch`);
          return out === undefined ? null : out;
        };
      }
      return session;
    };
    gcMail = Object.freeze({
      imap: Object.freeze({ connect }),
      smtp: Object.freeze({
        send: async (o) => {
          const x = wire(o) || {};
          const t = checkTarget('smtp', x, mailOpt || {}, hostError);
          const m = x.message;
          if (!m || typeof m !== 'object' || !m.from || typeof m.from.address !== 'string') throw hostError('ERR_INVALID', 'invalid message');
          for (const k of Object.keys(m.headers || {})) if (!/^x-/i.test(k) && k.toLowerCase() !== 'list-unsubscribe') throw hostError('ERR_INVALID', `header ${k} is not allowed`);
          if (m.icalEvent != null) {
            // GateControl ≥ 1.219.0: an iMIP part (nodemailer icalEvent); older hosts refuse the field
            const ie = m.icalEvent;
            if (!gc219) throw hostError('ERR_INVALID', 'icalEvent needs GateControl 1.219.0');
            if (!ie || typeof ie !== 'object' || !ICAL_METHODS.includes(ie.method) || typeof ie.content !== 'string' || Buffer.byteLength(ie.content) > ICAL_MAX
              || !/^BEGIN:VCALENDAR/.test(ie.content) || (new RegExp(`^METHOD:${ie.method}\\r?$`, 'm').test(ie.content) === false)
              || (ie.filename != null && !(typeof ie.filename === 'string' && /\.ics$/i.test(ie.filename)))) throw hostError('ERR_INVALID', 'invalid icalEvent');
          }
          let total = Buffer.byteLength(String(m.html || '') + String(m.text || ''));
          for (const a of m.attachments || []) {
            const f = mediaStore.get(a && a.mediaId);
            if (!f) throw hostError('ERR_INVALID', 'unknown attachment media id');
            total += f.bytes;
          }
          if (total > SEND_MAX) throw hostError('ERR_INVALID', 'message larger than 50 MB');
          if (!mailOpt || typeof mailOpt.smtp !== 'function') throw hostError('ERR_MAIL_NET', 'no SMTP server in this test');
          records.mailSent.push({ ...t, message: m, appendCopy: x.appendCopy === true });
          const r = wire(await mailOpt.smtp({ ...t, message: m }, { putMedia, media })) || {};
          const messageId = r.messageId || `<${crypto.randomBytes(8).toString('hex')}@mock>`;
          let raw = null;
          if (x.appendCopy === true) {
            const text = compose(m, messageId);
            raw = { mediaId: putMedia({ data: text, mime: 'message/rfc822', name: 'message.eml' }), bytes: Buffer.byteLength(text) };
          }
          return { messageId, accepted: r.accepted || [...(m.to || []), ...(m.cc || []), ...(m.bcc || [])].map((a) => a.address), rejected: r.rejected || [], raw };
        },
        // GateControl ≥ 1.217.0: log in without sending
        ...(h.gc217 ? {
          verify: async (o) => {
            const x = wire(o) || {};
            const t = checkTarget('smtp', x, mailOpt || {}, hostError);
            records.mailVerified.push({ host: t.host, port: t.port, security: t.security, user: t.auth.user });
            if (mailOpt && typeof mailOpt.verify === 'function') await mailOpt.verify(wire(t));
            return { ok: true };
          },
        } : {}),
      }),
      compose: async (m) => {
        const x = wire(m) || {};
        const messageId = `<${crypto.randomBytes(8).toString('hex')}@mock>`;
        const text = compose(x, messageId);
        return { mediaId: putMedia({ data: text, mime: 'message/rfc822', name: 'message.eml' }), bytes: Buffer.byteLength(text), messageId };
      },
      parse: async (id) => {
        const f = mediaStore.get(id);
        if (!f) throw hostError('ERR_INVALID', 'unknown media id');
        return wire(parse(f.data.toString('utf8')));
      },
      sanitize: async (html, o) => wire((mailOpt && typeof mailOpt.sanitize === 'function' ? mailOpt.sanitize : sanitize)(String(html == null ? '' : html), wire(o) || {})),
      ...(gc219 && perm.dav ? { dav: Object.freeze({ request: davRequest }) } : {}),
      autoconfig: async (email) => {
        if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw hostError('ERR_INVALID', 'invalid address');
        const r = mailOpt && typeof mailOpt.autoconfig === 'function' ? await mailOpt.autoconfig(email) : null;
        return wire(r || { imap: null, smtp: null, source: null });
      },
    });
  }

  // gc.http.fetchImage (≥ 1.216.0): any public host, images only; the bytes come back as a Buffer
  let fetchImage;
  if (h.gc216 || typeof opts.fetchImage === 'function') {
    const n = (perms.network && !Array.isArray(perms.network) && perms.network) || {};
    fetchImage = async (url, o) => {
      const x = wire(o) || {};
      if (n.images !== true) throw hostError('ERR_NET_DENIED', 'no permissions.network.images');
      let u;
      try { u = new URL(String(url)); } catch { throw hostError('ERR_INVALID', 'invalid url'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw hostError('ERR_INVALID', 'http(s) only');
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (![80, 443, 8080, 8443].includes(port)) throw hostError('ERR_NETWORK_DENIED', `port ${port} is not allowed`);
      if ((mailOpt && mailOpt.denied ? mailOpt.denied : notPublic)(u.hostname)) throw hostError('ERR_NETWORK_DENIED', 'not a public address');
      const max = Math.min(Number.isSafeInteger(x.maxBytes) && x.maxBytes > 0 ? x.maxBytes : 2 * 1024 * 1024, IMAGE_MAX);
      records.imageFetches.push(String(url));
      if (typeof opts.fetchImage !== 'function') throw hostError('ERR_NET', 'no image handler in this test');
      const r = await opts.fetchImage(String(url));
      const status = Number(r && r.status != null ? r.status : 200);
      if (!(status >= 200 && status < 300)) throw Object.assign(hostError('ERR_HTTP', `status ${status}`), { status });
      const mime = String((r && r.mime) || '').toLowerCase();
      if (!/^image\//.test(mime) || mime === 'image/svg+xml') throw hostError('ERR_INVALID', 'not a picture');
      const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body || ''));
      if (body.length > max) throw hostError('ERR_MEDIA_TOO_LARGE', 'picture too large');
      return { status, mime, bytes: Buffer.from(body) };
    };
  }
  return { gcMail, fetchImage, records, closeAll: () => { for (const s of sessions.values()) if (s.open) { s.open = false; s.rec.open = false; s.rec.closed = true; } } };
}

/**
 * gc.http.fetch's bodyMedia (GateControl ≥ 1.217.0) → the options as the test's fetch handler sees the request: `body`
 * (Buffer) and the host's headers. The host's checks: own media (plugin.json media), POST/PUT/PATCH, a range raw only
 * (Content-Range), raw ≤ 64 MB, base64 ≤ 4 MB, exactly one json value MEDIA_BASE64.
 */
function resolveBodyMedia(o, { mediaStore, media, hostError }) {
  const bm = o.bodyMedia;
  if (!media) throw hostError('ERR_MEDIA_DENIED', 'plugin.json declares no media');
  if (!bm || typeof bm !== 'object' || typeof bm.mediaId !== 'string') throw hostError('ERR_INVALID', 'invalid bodyMedia');
  if (o.body != null || o.form != null || o.bodyBase64 != null) throw hostError('ERR_INVALID', 'bodyMedia replaces body, form and bodyBase64');
  if (bm.encoding != null && bm.encoding !== 'base64') throw hostError('ERR_INVALID', "bodyMedia.encoding must be 'base64'");
  const method = String(o.method || 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw hostError('ERR_INVALID', 'bodyMedia needs POST, PUT or PATCH');
  const f = mediaStore.get(bm.mediaId);
  if (!f) throw hostError('ERR_INVALID', 'unknown media id');
  const headers = {};
  for (const [k, v] of Object.entries(o.headers || {})) if (!['content-range', 'content-length'].includes(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
  const ranged = bm.start != null || bm.end != null;
  const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data || ''));
  const size = f.bytes;
  let body;
  if (bm.encoding !== 'base64' && o.json === undefined) {
    let start = 0;
    let end = size - 1;
    if (ranged) {
      start = bm.start == null ? 0 : bm.start;
      end = bm.end == null ? size - 1 : bm.end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) throw hostError('ERR_INVALID', 'invalid bodyMedia range');
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    if (end - start + 1 > BODY_MEDIA_MAX) throw hostError('ERR_MEDIA_TOO_LARGE', 'at most 64 MB per request');
    // the test's media may hold fewer bytes than `bytes` claims (a stand-in): the range of what is there
    body = data.subarray(Math.min(start, data.length), Math.min(end + 1, data.length));
    if (!headers['content-type']) headers['content-type'] = f.mime || 'application/octet-stream';
  } else {
    if (ranged) throw hostError('ERR_INVALID', 'a bodyMedia range is sent raw only');
    if (size > BODY_MEDIA_BASE64_MAX) throw hostError('ERR_MEDIA_TOO_LARGE', 'at most 4 MB base64');
    const b64 = data.toString('base64');
    if (o.json !== undefined) {
      let n = 0;
      const swap = (v) => {
        if (v === MEDIA_BASE64) { n++; return b64; }
        if (Array.isArray(v)) return v.map(swap);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
        return v;
      };
      const json = swap(o.json);
      if (n !== 1) throw hostError('ERR_INVALID', 'json needs exactly one value gc.http.MEDIA_BASE64');
      body = Buffer.from(JSON.stringify(json));
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else {
      body = Buffer.from(b64);
      if (!headers['content-type']) headers['content-type'] = 'text/plain';
    }
  }
  headers['content-length'] = String(body.length);
  // `json` stays as the plugin gave it (with the placeholder) for the record; `body` is what goes out
  return { ...o, method, headers, body };
}

/**
 * services.provides.<name>.maxPerHour (GateControl ≥ 1.216.0): 60 … 3600 → the number, else throws. Accepted at every
 * emulated version (like media.resumable — the real older host refuses it), acting from 1.216.0 on.
 */
function maxPerHourOf(def, gc216, hostError) {
  void gc216;
  if (!def || def.maxPerHour === undefined) return null;
  if (!Number.isInteger(def.maxPerHour) || def.maxPerHour < 60 || def.maxPerHour > 3600) throw hostError('ERR_INVALID', 'plugin.json: services.provides.maxPerHour: invalid');
  return def.maxPerHour;
}

module.exports = { resolveBodyMedia, MEDIA_BASE64, install, mailPermission, maxPerHourOf, sanitize, compose, parse, notPublic, escHtml };
