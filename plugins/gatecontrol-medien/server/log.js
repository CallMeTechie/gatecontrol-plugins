'use strict';

// The plugin's log (admin tab "Protokoll" of the overview, and gc.log). Texts name people, devices and
// sources — never a password, a key, a Quick Connect code or a Jellyfin token.

const store = require('./store');
const { str } = require('./util');

async function add(gc, kind, text, o = {}, now = Date.now()) {
  const t = str(text, 300);
  try {
    await store.run(gc, 'INSERT INTO log (at, kind, text, user_id, device_id, source_id) VALUES (?, ?, ?, ?, ?, ?)',
      [now, str(kind, 40) || 'info', t, o.userId || null, o.deviceId || null, o.sourceId || null]);
  } catch (e) { gc.log.debug('log row not written', (e && e.code) || 'error'); }
  gc.log.info(t);
}

async function list(gc, limit = 200) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  return store.all(gc, 'SELECT id, at, kind, text, user_id, device_id, source_id FROM log ORDER BY id DESC LIMIT ?', [n]);
}

async function purge(gc, days, now = Date.now()) {
  await store.run(gc, 'DELETE FROM log WHERE at < ?', [now - days * 86400000]);
  await store.run(gc, 'DELETE FROM hits WHERE at < ?', [now - 2 * 3600000]);
}

module.exports = { add, list, purge };
