'use strict';

// Credentials of the accounts: secrets of the plugin (gc.settings.setSecret — stored encrypted with the server key,
// re-keyed by backups, never sent to a browser or an app, never logged). One per account: 'acct.<id>' holds
// { password } (IMAP/SMTP) or { refreshToken } (Microsoft). Access tokens only live in memory.

const key = (id) => `acct.${id}`;

async function get(gc, accountId) {
  let raw = null;
  try { raw = await gc.settings.get(key(accountId)); } catch { raw = null; }
  if (typeof raw !== 'string' || !raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

async function set(gc, accountId, value) {
  await gc.settings.setSecret(key(accountId), JSON.stringify(value));
}

async function remove(gc, accountId) {
  try { await gc.settings.setSecret(key(accountId), null); } catch { /* gone already */ }
}

/** A device-code sign-in's device code (portal, POST accounts/microsoft/device). */
const deviceKey = (id) => `msdev.${id}`;
async function setDevice(gc, id, code) { await gc.settings.setSecret(deviceKey(id), code); }
async function getDevice(gc, id) { try { const v = await gc.settings.get(deviceKey(id)); return typeof v === 'string' && v ? v : null; } catch { return null; } }
async function removeDevice(gc, id) { try { await gc.settings.setSecret(deviceKey(id), null); } catch { /* gone */ } }

module.exports = { get, set, remove, setDevice, getDevice, removeDevice };
