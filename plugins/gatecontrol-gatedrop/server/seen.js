'use strict';

// App installations that use GateDrop (since 1.5.0, table devices_seen): gc.devices.list names every GateControl app of a
// person — also one without GateDrop (an older app, an edition without it), which never fetches a send. GET targets
// offers as own devices only those that used GateDrop's app API (any request with user.device — the apps poll GET pending
// and report PUT presence when they start); the migration took over what was known (presence, sends, pick-ups, direct
// transfers, GET/PUT device). POST sends still takes any own device id (an app that kept a list keeps working).

const store = require('./store');

const WRITE_EVERY_MS = 10 * 60000; // one write per device and 10 minutes at most
const KEEP = 2000;

const last = new Map();

function reset() { last.clear(); }

/** The device `deviceId` of `userId` used GateDrop now. */
async function mark(gc, deviceId, userId, now) {
  const prev = last.get(deviceId);
  if (prev && prev.userId === userId && now - prev.at < WRITE_EVERY_MS && now >= prev.at) return;
  if (last.size >= KEEP) last.clear();
  last.set(deviceId, { userId, at: now });
  await store.run(gc, `INSERT INTO devices_seen (device_id, user_id, at) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, at = excluded.at`, [deviceId, userId, now]);
}

/** The person's devices known to use GateDrop → Set of device ids. */
async function of(gc, userId) {
  return new Set((await store.all(gc, 'SELECT device_id FROM devices_seen WHERE user_id = ?', [userId])).map((r) => r.device_id));
}

module.exports = { mark, of, reset };
