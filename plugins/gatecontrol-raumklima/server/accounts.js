'use strict';

// The Midea and Dreo accounts on the plugin's settings page (GateControl ≥
// 1.185.0): saving the settings logs in with what was entered
// (settingsChanged — GateControl waits for it), and the page shows one status
// line per account (settingsStatus). The outcome of the last login is kept in
// the key/value storage ('accounts'), with a checksum of the data it was made
// with, so an unchanged account is not logged in again on every save.

const crypto = require('node:crypto');
const store = require('./store');
const service = require('./service');
const dreo = require('./dreoservice');

const KEY = 'accounts';
const APP_LABEL = { msmarthome: 'MSmartHome', nethome: 'NetHome Plus' };

const fingerprint = (...parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');

async function load(gc) {
  const v = await gc.storage.get(KEY);
  return v && typeof v === 'object' ? v : {};
}

function outcome(fp, e) {
  return e ? { fp, ok: false, code: e.code || 'ERROR', detail: String(e.message || '').replace(/[\0-\x1f\x7f]/g, ' ').slice(0, 160), at: Date.now() }
    : { fp, ok: true, at: Date.now() };
}

async function syncMidea(gc, prev) {
  const cfg = await store.loadConfig(gc);
  if (!cfg.email || !cfg.password) {
    if (cfg.session) await store.saveSession(gc, null);
    return null;
  }
  const fp = fingerprint(cfg.app, cfg.email, cfg.password);
  if (prev && prev.fp === fp && prev.ok && cfg.session) return prev;
  try {
    await service.connectCloud(gc, cfg.email, cfg.password, cfg.app);
    return outcome(fp, null);
  } catch (e) {
    return outcome(fp, e);
  }
}

async function syncDreo(gc, prev) {
  await store.hashDreoPassword(gc);
  const cfg = await store.loadDreo(gc);
  if (!cfg.email || !cfg.passwordMd5) {
    if (cfg.token) await dreo.disconnect(gc);
    return null;
  }
  if (!dreo.supported(gc)) return null;
  const fp = fingerprint(cfg.email, cfg.passwordMd5);
  if (prev && prev.fp === fp && prev.ok && cfg.token) return prev;
  try {
    await dreo.connect(gc);
    return outcome(fp, null);
  } catch (e) {
    return outcome(fp, e);
  }
}

/** Settings saved: log in with changed accounts (both at once), remember the outcome. */
async function settingsChanged(gc) {
  const prev = await load(gc);
  const [midea, dreoAcc] = await Promise.all([syncMidea(gc, prev.midea), syncDreo(gc, prev.dreo)]);
  await gc.storage.set(KEY, { midea, dreo: dreoAcc });
}

/**
 * One line per account for the settings page. `t` and `errorText` come from
 * index.js (texts, error code → text).
 */
async function settingsStatus(gc, lang, t, errorText) {
  const acc = await load(gc);
  const out = [];

  const m = await store.loadConfig(gc);
  if (!m.email) out.push({ group: 'midea', tone: 'info', text: t(lang, 'settings.midea_none') });
  else if (!m.password) out.push({ group: 'midea', tone: 'warn', text: t(lang, 'settings.password_missing') });
  else if (service.getCloudStatus().needsReauth) out.push({ group: 'midea', tone: 'warn', text: t(lang, 'cloud.reauth') });
  else if (acc.midea && !acc.midea.ok) out.push({ group: 'midea', tone: 'error', text: t(lang, 'settings.login_failed', { error: errorText(acc.midea, lang) }) });
  else if (m.session || (acc.midea && acc.midea.ok)) out.push({ group: 'midea', tone: 'ok', text: t(lang, 'settings.midea_ok', { email: m.email, app: APP_LABEL[m.app] || m.app }) });
  else out.push({ group: 'midea', tone: 'info', text: t(lang, 'settings.not_checked') });

  const d = await store.loadDreo(gc);
  const st = dreo.getStatus();
  const region = d.region === 'NA' ? 'US' : 'EU';
  if (!d.email) out.push({ group: 'dreo', tone: 'info', text: t(lang, 'settings.dreo_none') });
  else if (!d.passwordMd5) out.push({ group: 'dreo', tone: 'warn', text: t(lang, 'settings.password_missing') });
  else if (!dreo.supported(gc)) out.push({ group: 'dreo', tone: 'warn', text: t(lang, 'dreo.needs_update') });
  else if (acc.dreo && !acc.dreo.ok) out.push({ group: 'dreo', tone: 'error', text: t(lang, 'settings.login_failed', { error: errorText(acc.dreo, lang) }) });
  else if (st.needs_login) out.push({ group: 'dreo', tone: 'error', text: t(lang, 'dreo.reauth') });
  else if (d.token) {
    out.push({ group: 'dreo', tone: 'ok', text: t(lang, 'settings.dreo_ok', { email: d.email, region })
      + (st.connected ? ' · ' + t(lang, 'dreo.live') : '') });
  } else out.push({ group: 'dreo', tone: 'info', text: t(lang, 'settings.not_checked') });
  return out;
}

module.exports = { settingsChanged, settingsStatus, KEY };
