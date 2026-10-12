'use strict';

// HTTP for the waste providers: through the host (gc.http.fetch — only the
// hosts in plugin.json), JSON in and out, a User-Agent of our own (some
// backends refuse requests without one), short timeouts. Errors carry a
// code and the HTTP status only — never a body.

const UA = 'GateControl-Alltag/1.0 (+https://github.com/CallMeTechie/gatecontrol-plugins)';

function providerError(code, status) {
  return Object.assign(new Error(status ? `${code} (HTTP ${status})` : code), { code, status: status || null });
}

/**
 * @param {object} gc
 * @param {string} url
 * @param {{ method?: string, headers?: object, json?: any, timeoutMs?: number }} [o]
 */
async function getJson(gc, url, o = {}) {
  let r;
  try {
    r = await gc.http.fetch(url, {
      method: o.method || 'GET',
      headers: { 'user-agent': UA, accept: 'application/json', ...(o.headers || {}) },
      ...(o.json !== undefined ? { json: o.json } : {}),
      timeoutMs: o.timeoutMs || 15000,
      redirect: 'follow',
    });
  } catch (e) {
    throw providerError((e && e.code) === 'ERR_NET_DENIED' ? 'PROVIDER_DENIED' : 'PROVIDER_UNREACHABLE');
  }
  if (r.status === 404) throw providerError('PROVIDER_NOT_FOUND', 404);
  if (r.status === 401 || r.status === 403) throw providerError('PROVIDER_REFUSED', r.status);
  if (r.status === 429) throw providerError('PROVIDER_RATE_LIMITED', 429);
  if (r.status < 200 || r.status >= 300) throw providerError('PROVIDER_HTTP', r.status);
  try { return JSON.parse(r.body); } catch { throw providerError('PROVIDER_BAD_RESPONSE', r.status); }
}

/** [{ id, name }] sorted by name (German collation), ids as strings, names trimmed, duplicates dropped. */
function items(list) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    if (!x || x.id == null || x.name == null) continue;
    const id = String(x.id).slice(0, 200);
    const name = String(x.name).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}

/** "#RRGGBB" from "RRGGBB", "#RRGGBB" or "RRGGBBAA" (null otherwise). */
function color(v) {
  const m = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(String(v || '').trim());
  return m ? '#' + m[1].toLowerCase() : null;
}

module.exports = { UA, providerError, getJson, items, color };
