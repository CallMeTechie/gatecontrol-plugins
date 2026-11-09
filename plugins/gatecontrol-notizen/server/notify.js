'use strict';

// Pushes through gc.notify, without the people who switched that kind off in the plugin's „Einstellungen“
// (prefs.notify: reminders | shared | listday — on top of GateControl's own switches per topic). A push that fails is
// logged, never thrown: the change it reports is done already.

const prefs = require('./prefs');

/** Of `users`, those who want pushes of `kind`. */
async function wanting(gc, users, kind) {
  const out = [];
  for (const u of users || []) {
    const p = await prefs.get(gc, u);
    if (p.notify[kind] !== false) out.push(u);
  }
  return out;
}

/** gc.notify(message) to those of `users` who want `kind` → whether it went out. */
async function send(gc, users, kind, message) {
  const to = await wanting(gc, users, kind);
  if (!to.length) return false;
  try {
    await gc.notify({ ...message, users: to });
    return true;
  } catch (e) {
    if (gc.log && gc.log.warn) gc.log.warn('push failed', kind, (e && e.code) || 'error');
    return false;
  }
}

module.exports = { wanting, send };
