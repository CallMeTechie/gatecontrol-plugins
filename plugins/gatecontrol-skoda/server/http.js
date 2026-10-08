'use strict';

// Network of the plugin: every request leaves through the host
// (gc.http.fetch), which allows only the hosts of plugin.json
// permissions.network.internet and never follows a redirect on its own
// (redirect: 'manual'). fetchFor(gc) adapts it to the part of a fetch
// Response the MySkoda code uses (status, headers.get/getSetCookie, text,
// json, arrayBuffer), so the login flow and the API client are the ported
// GateControl code (src/services/skoda/skodaHttp.js, skodaAuth.js,
// skodaClient.js).
//
// CookieJar + followRedirects: minimal in-memory cookie jar and manual
// redirect follower for the VW identity login (HTML form posts + 302
// chains). Per-login lifetime only, never persisted.

const DEFAULT_TIMEOUT_MS = 30000;

function responseOf(r) {
  const headers = (r && r.headers) || {};
  const body = typeof r.body === 'string' ? r.body : '';
  const bytes = () => (typeof r.bodyBase64 === 'string' ? Buffer.from(r.bodyBase64, 'base64') : Buffer.from(body, 'utf8'));
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    url: r.url,
    headers: {
      get(name) {
        const v = headers[String(name).toLowerCase()];
        if (v == null) return null;
        return Array.isArray(v) ? v.join(', ') : String(v);
      },
      getSetCookie() { return [].concat(headers['set-cookie'] || []).map(String); },
    },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => { const b = bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
}

/** fetch(url, { method, headers, body, binary, timeoutMs }) over gc.http.fetch. */
function fetchFor(gc) {
  return async (url, opts = {}) => {
    const o = { method: opts.method || 'GET', headers: opts.headers || {}, redirect: 'manual', timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS };
    if (opts.body != null) o.body = String(opts.body);
    if (opts.binary) o.binary = true;
    return responseOf(await gc.http.fetch(String(url), o));
  };
}

class CookieJar {
  constructor() {
    this.cookies = new Map(); // `${host}|${name}` -> value
  }

  storeFrom(res, url) {
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const host = new URL(url).host;
    for (const line of lines) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      this.cookies.set(`${host}|${pair.slice(0, eq).trim()}`, pair.slice(eq + 1).trim());
    }
  }

  headerFor(url) {
    const host = new URL(url).host;
    const parts = [];
    for (const [key, value] of this.cookies) {
      const sep = key.indexOf('|');
      if (key.slice(0, sep) === host) parts.push(`${key.slice(sep + 1)}=${value}`);
    }
    return parts.length ? parts.join('; ') : null;
  }
}

async function requestWithJar(jar, url, opts, fetchImpl) {
  const headers = { ...((opts && opts.headers) || {}) };
  const cookie = jar.headerFor(url);
  if (cookie) headers.cookie = cookie;
  const res = await fetchImpl(url, { ...(opts || {}), headers });
  jar.storeFrom(res, url);
  return res;
}

async function followRedirects(jar, url, opts, { maxHops = 15, stopPrefix = null, fetchImpl } = {}) {
  let current = url;
  let init = opts || {};
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await requestWithJar(jar, current, init, fetchImpl);
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return { res, location: current };
    const next = /^[a-z][a-z0-9+.-]*:/i.test(loc) ? loc : new URL(loc, current).toString();
    if (stopPrefix && next.startsWith(stopPrefix)) return { res, location: next };
    current = next;
    init = { method: 'GET' };
  }
  throw new Error('too many redirects');
}

module.exports = { fetchFor, responseOf, CookieJar, requestWithJar, followRedirects };
