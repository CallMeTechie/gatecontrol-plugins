'use strict';

// The hint "Das GateControl-Backup sichert keine Drive-Dateien" (concept "Sicherung"): GateControl's backup holds
// Drive's database (folders, rights, versions), never the files of its media areas.
//   strong   an area lies on this server, a folder or a NAS (one copy only): a box on the admin overview and, once a
//            week, a notification to the administrators (topic backup_hint)
//   subtle   every area lies in S3 (object storage keeps copies of its own): one line on the overview
//   off      the administrator switched it off (setting backup_hint, also "Ausblenden" on the overview)

const people = require('./people');
const { t } = require('./text');

const WEEK = 7 * 86400000;
const KEY = 'backup_hint_sent';

const atRisk = (info) => !info.target || info.target.kind !== 's3';

/** → { level: 'strong' | 'subtle' | 'off', areas: [{ mediaArea, label, kind }] } (areas at risk) */
async function state(gc, on) {
  if (!on) return { level: 'off', areas: [] };
  let list = [];
  try { list = (await gc.media.areas.list()) || []; } catch { list = []; }
  list = list.filter(Boolean);
  if (!list.length) return { level: 'off', areas: [] };
  const risk = list.filter(atRisk).map((i) => ({ mediaArea: i.area, label: i.label, kind: (i.target && i.target.kind) || 'server' }));
  return { level: risk.length ? 'strong' : 'subtle', areas: risk };
}

/** The background run: the administrators are told once a week while the hint is strong. → true when sent */
async function weekly(gc, on, now) {
  const s = await state(gc, on);
  if (s.level !== 'strong') return false;
  let last = null;
  try { last = await gc.storage.get(KEY); } catch { last = null; }
  if (last != null && Number(last) > now - WEEK) return false;
  const admins = [...(await people.users(gc)).values()].filter((u) => u.role === 'admin');
  if (!admins.length) return false;
  for (const lang of ['de', 'en']) {
    const to = admins.filter((u) => (u.lang === 'en' ? 'en' : 'de') === lang).map((u) => u.id);
    if (!to.length) continue;
    try {
      await gc.notify({
        topic: 'backup_hint', users: to, collapseKey: 'drive-backup-hint',
        title: t(lang, 'backup.title'), body: t(lang, 'backup.body', { areas: s.areas.map((a) => a.label).join(', ') }),
      });
    } catch (e) { gc.log.warn('backup hint failed', (e && e.code) || 'error'); }
  }
  await gc.storage.set(KEY, now);
  return true;
}

module.exports = { state, weekly };
