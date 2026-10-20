'use strict';

// Request input shared by the settings (admin API) and the profile link (portal API, 1.3.0):
// the access to a WebUntis account, and the plugin's error objects.
//
//   { mode: 'qr', link }                                  the link of the WebUntis QR code (untis://setschool?…)
//   { mode: 'secret', host, school, username, secret }    the data under the QR code, typed in
//   { mode: 'password', host, school, username, password }

const untis = require('./untis');
const totp = require('./totp');

/** An error the API answers with a status and a text (index.js ERRORS). */
function fail(code, extra) { return Object.assign(new Error(code), { code }, extra || {}); }

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Account + credentials from a request body → { host, school, username, auth, value } (value: the secret or password). */
function accountInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const mode = b.mode;
  if (mode === 'qr') {
    let q;
    try { q = untis.parseQrLink(b.link); } catch (e) { throw fail(e.code === 'HOST_INVALID' ? 'HOST_INVALID' : 'QR_INVALID'); }
    return { host: q.host, school: q.school, username: q.username, auth: 'secret', value: q.secret };
  }
  if (mode !== 'secret' && mode !== 'password') throw fail('INVALID');
  const school = str(b.school, 120);
  const username = str(b.username, 120);
  const value = mode === 'secret' ? String(b.secret || '').replace(/\s+/g, '').toUpperCase() : (typeof b.password === 'string' ? b.password : '');
  if (!str(b.host, 253) || !school || !username || !value || value.length > 500) throw fail('FIELDS_REQUIRED');
  const host = untis.normalizeHost(b.host);
  if (!host) throw fail('HOST_INVALID');
  if (mode === 'secret') {
    try { totp.base32Decode(value); } catch { throw fail('QR_INVALID'); }
  }
  return { host, school, username, auth: mode === 'secret' ? 'secret' : 'password', value };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

module.exports = { fail, str, accountInput, posInt };
