'use strict';

// Wi-Fi on the wall tablet (1.14.0): the Vault plugin (gatecontrol-vault ≥ 1.4.0, „Freigabe auf Wandtablet“) shares
// a Wi-Fi entry for 5 minutes, an hour, a day or until it is ended. Vault decrypts the entry in the app of the person
// who shares and keeps the copy; this plugin only shows it on the wall:
//
//   service wall_wifi   { shares: [{ id, ssid, security: 'WPA'|'WEP'|'SAE'|'nopass', password, hidden, expiresAt,
//                         sharedBy }] (0–4) } → { ok: true, walls, wall }
//                       caller gatecontrol-vault only (else forbidden). Always the WHOLE set of running wall
//                       shares: it replaces what was here ([] = none). walls: the wall tablet members, wall: the
//                       module wall is on — Vault undoes a share nobody would see (walls 0 or module off).
//   GET wall → wifi     [{ id, ssid, security, password, hidden, expiresAt, sharedBy, qr: { size, rows } }] | null:
//                       the running ones (expiresAt null = until ended, else in the future — never an expired one),
//                       with the QR code drawn here (rows of '0'/'1', no quiet zone; ui/wall.js adds it). Only for a
//                       paired kiosk device or a signed-in wall account — never a viewer known by device trust alone,
//                       never a family member reading the wall view (null then).
//   background (purge)  expired rows go.
//
// The password is in the clear here on purpose: the wall shows it to everyone in front of it (the person who shared
// was told so). The QR code's text: WIFI:T:<type>;S:<ssid>;P:<password>;H:true;; with \ ; , : " escaped.

const store = require('./store');
const { encode } = require('./vendor/uqr');

const VAULT = 'gatecontrol-vault';
const MAX = 4;
const SECURITY = ['WPA', 'WEP', 'SAE', 'nopass'];
const ID_RE = /^[0-9a-f]{24}$/;
const CONTROL_RE = /[\0-\x1f\x7f]/;

class Invalid extends Error { constructor() { super('invalid'); this.code = 'invalid'; } }

/** The text of a Wi-Fi QR code. */
function qrText(s) {
  const esc = (v) => String(v == null ? '' : v).replace(/([\\;,:"])/g, '\\$1');
  return 'WIFI:T:' + s.security + ';S:' + esc(s.ssid) + ';' + (s.security === 'nopass' ? '' : 'P:' + esc(s.password) + ';') + (s.hidden ? 'H:true;' : '') + ';';
}

/** The QR code's modules → { size, rows: ['0101…'] } (error correction M, no quiet zone), or null. */
function qrRows(text) {
  try {
    const q = encode(text, { ecc: 'M', border: 0 });
    return { size: q.size, rows: q.data.map((row) => row.map((b) => (b ? '1' : '0')).join('')) };
  } catch {
    return null;
  }
}

/** One share of the payload, checked → a row, else Invalid. */
function parseShare(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Invalid();
  const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !CONTROL_RE.test(v);
  if (!ID_RE.test(String(s.id))) throw new Invalid();
  if (!str(s.ssid, 1, 64) || !s.ssid.trim()) throw new Invalid();
  if (!SECURITY.includes(s.security)) throw new Invalid();
  const pw = s.password == null ? '' : s.password;
  if (!str(pw, 0, 128) || (s.security === 'nopass' ? pw !== '' : pw === '')) throw new Invalid();
  let expires = null;
  if (s.expiresAt != null) {
    expires = typeof s.expiresAt === 'string' && s.expiresAt.length <= 40 ? Date.parse(s.expiresAt) : NaN;
    if (!Number.isFinite(expires)) throw new Invalid();
  }
  const by = typeof s.sharedBy === 'string' ? s.sharedBy.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 80) : '';
  return { id: s.id, ssid: s.ssid, security: s.security, password: pw, hidden: s.hidden === true ? 1 : 0, expires_at: expires, shared_by: by || null };
}

/** service wall_wifi (see the head of this file). */
async function receive(gc, cfg, call, now) {
  if (!call || call.caller !== VAULT) return { ok: false, code: 'forbidden' };
  const p = call.payload && typeof call.payload === 'object' ? call.payload : {};
  if (!Array.isArray(p.shares) || p.shares.length > MAX) return { ok: false, code: 'invalid' };
  let rows;
  try {
    rows = p.shares.map(parseShare);
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, code: 'invalid' };
    throw e;
  }
  if (new Set(rows.map((r) => r.id)).size !== rows.length) return { ok: false, code: 'invalid' };
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM wall_wifi');
    for (const r of rows) {
      if (r.expires_at != null && r.expires_at <= now) continue;
      await store.run(gc, 'INSERT INTO wall_wifi (id, ssid, security, password, hidden, expires_at, shared_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [r.id, r.ssid, r.security, r.password, r.hidden, r.expires_at, r.shared_by, now]);
    }
  });
  const walls = await store.one(gc, "SELECT COUNT(*) AS n FROM members WHERE role = 'wall'");
  return { ok: true, walls: (walls && walls.n) || 0, wall: !!(cfg && cfg.modules && cfg.modules.wall) };
}

/**
 * GET wall → wifi: the running shares with their QR codes — for a wall tablet member only (a family member may read
 * the wall view too, but the Wi-Fi was shared for the tablet); null for device trust alone or when there is none.
 */
async function forWall(gc, r) {
  if (r.trustOnly || !r.me || r.me.role !== 'wall') return null;
  const rows = await store.all(gc, 'SELECT * FROM wall_wifi WHERE expires_at IS NULL OR expires_at > ? ORDER BY updated_at, id LIMIT ?', [r.now, MAX]);
  if (!rows.length) return null;
  return rows.map((x) => {
    const s = { id: x.id, ssid: x.ssid, security: x.security, password: x.password, hidden: x.hidden > 0 };
    return { ...s, expiresAt: x.expires_at == null ? null : new Date(x.expires_at).toISOString(), sharedBy: x.shared_by || null, qr: qrRows(qrText(s)) };
  });
}

/** Expired rows go (background purge; GET wall never shows them anyway). */
async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM wall_wifi WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
}

module.exports = { receive, forWall, purge, qrText, qrRows, parseShare, VAULT, MAX };
