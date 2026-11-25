'use strict';

// Medien needs a licence of its own (shop: monthly or a plugin lifetime licence). It is never part of the GateControl
// plan or a server lifetime licence: an entitlement whose source is 'plan' or 'lifetime' does not count here, even if
// a licence server hands one out (the shop entry has included_in_lifetime: false; this is the second line).
// Without a licence GateControl itself answers the apps 404 plugin_unavailable; with one that does not count the
// plugin hides the app tab and answers 403 license_required.

const NOT_COUNTING = ['plan', 'lifetime'];

async function state(gc) {
  try {
    if (gc.license && typeof gc.license.info === 'function') {
      const i = await gc.license.info();
      if (!i || !i.required) return { ok: true, required: false };
      if (!i.valid) return { ok: false, required: true, reason: 'missing', state: i.state || null };
      if (NOT_COUNTING.includes(i.source)) return { ok: false, required: true, reason: 'not_own', source: i.source };
      return { ok: true, required: true, source: i.source || 'license', expiresAt: i.expiresAt || null };
    }
    const s = gc.license && typeof gc.license.status === 'function' ? await gc.license.status() : null;
    if (!s || !s.required) return { ok: true, required: false };
    return s.licensed ? { ok: true, required: true } : { ok: false, required: true, reason: 'missing' };
  } catch {
    return { ok: true, required: true, reason: 'unknown' };
  }
}

module.exports = { state, NOT_COUNTING };
