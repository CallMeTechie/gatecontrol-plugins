'use strict';

// The objects the API answers with (README "API") — one place for app, portal and admin.

const locks = require('./locks');
const rights = require('./rights');
const nuki = require('./nuki');
const { iso } = require('./util');

/**
 * A lock for a viewer: what it is, its state, the viewer's right and the actions the viewer may use.
 *   actions   the actions this person's right allows on this lock (buttons to show)
 *   blocked   null when they may be used now, else 'read_only' (kiosk / device trust) or 'outside_window'
 */
function lockView(lock, { level, user, prefs, cfg, now }) {
  const allowed = lock.actions.filter((a) => rights.atLeast(level, rights.NEEDS[a]));
  let blocked = null;
  if (!rights.canAct(user)) blocked = 'read_only';
  else if (!rights.windowAllows(prefs && prefs.window, now, cfg.timezone)) blocked = 'outside_window';
  return {
    id: lock.id, name: lock.name, type: nuki.isOpener(lock.device_type) ? 'opener' : 'smartlock',
    right: level, actions: allowed, blocked, confirm: allowed.filter((a) => a !== 'lock'),
    doorSensor: lock.door_sensor, state: locks.stateView(lock),
  };
}

/** A lock for the admin pages (configuration + state). */
function adminLockView(lock) {
  return {
    id: lock.id, name: lock.name, type: nuki.isOpener(lock.device_type) ? 'opener' : 'smartlock', source: lock.source,
    bridgeId: lock.bridge_id || null, nukiId: lock.nuki_id, deviceType: lock.device_type, actions: lock.actions,
    supported: nuki.supportedActions(lock.device_type), doorSensor: lock.door_sensor, openTooLongMin: lock.open_too_long_min,
    nightCheck: lock.night_check, state: locks.stateView(lock),
  };
}

/** A camera for a viewer. */
function cameraView(cam, { prefs, lastImageAt }) {
  return {
    id: cam.id, name: cam.name, kind: cam.kind || null, doorbell: cam.doorbell === 1, lockId: cam.lock_id || null,
    online: cam.online == null ? null : cam.online === 1, battery: cam.battery == null ? null : cam.battery,
    prefs: { ding: prefs ? prefs.ding : true, motion: prefs ? prefs.motion : false },
    lastImageAt: lastImageAt ? iso(lastImageAt) : null,
  };
}

function adminCameraView(cam) {
  return {
    id: cam.id, name: cam.name, kind: cam.kind || null, doorbell: cam.doorbell === 1, lockId: cam.lock_id || null,
    enabled: cam.enabled === 1, present: cam.present === 1, online: cam.online == null ? null : cam.online === 1,
    battery: cam.battery == null ? null : cam.battery, updatedAt: iso(cam.updated_at),
  };
}

function imageView(m) {
  return m ? { mime: m.mime, size: m.size, at: iso(m.at), data: m.data } : null;
}

module.exports = { lockView, adminLockView, cameraView, adminCameraView, imageView };
