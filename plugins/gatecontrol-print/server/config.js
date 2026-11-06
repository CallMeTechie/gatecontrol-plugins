'use strict';

// The plugin's own settings (admin page "Einstellungen"), one JSON value under
// the plugin key 'print.config' (gc.settings.set keeps undeclared keys of the
// plugin's own).

const { fail, clip } = require('./util');

const KEY = 'print.config';
const DEFAULTS = Object.freeze({
  driveArea: 'mine',     // where scans go: 'mine' (Mein Drive › <folder>, per person) | 'family' (Familie › <folder>)
  folder: 'Scans',       // the folder in that area (made when missing)
  aiFile: true,          // "Mit KI benennen und einsortieren" (Drive's suggest_folder) — only when Drive can
  notify: true,          // "Druck fertig / fehlgeschlagen" for jobs from the portal
  historyDays: 90,       // the history is kept 7 … 365 days
});
const FOLDER_RE = /^[^/\\:*?"<>|]{1,60}$/;

function normalise(v) {
  const c = { ...DEFAULTS };
  if (v && typeof v === 'object') {
    if (v.driveArea === 'mine' || v.driveArea === 'family') c.driveArea = v.driveArea;
    const f = clip(v.folder, 60);
    if (f && FOLDER_RE.test(f) && f !== '.' && f !== '..') c.folder = f;
    if (typeof v.aiFile === 'boolean') c.aiFile = v.aiFile;
    if (typeof v.notify === 'boolean') c.notify = v.notify;
    if (Number.isInteger(v.historyDays) && v.historyDays >= 7 && v.historyDays <= 365) c.historyDays = v.historyDays;
  }
  return c;
}

async function load(gc) {
  let v = null;
  try { v = await gc.settings.get(KEY); } catch { v = null; }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return normalise(v);
}

/** A change from the admin page: only known keys, each checked. */
async function save(gc, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('invalid');
  const cur = await load(gc);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'driveArea') { if (v !== 'mine' && v !== 'family') throw fail('invalid', { field: k }); next.driveArea = v; } else if (k === 'folder') {
      const f = clip(v, 60);
      if (!f || !FOLDER_RE.test(f) || f === '.' || f === '..') throw fail('invalid', { field: k });
      next.folder = f;
    } else if (k === 'aiFile' || k === 'notify') { if (typeof v !== 'boolean') throw fail('invalid', { field: k }); next[k] = v; } else if (k === 'historyDays') {
      if (!Number.isInteger(v) || v < 7 || v > 365) throw fail('invalid', { field: k });
      next.historyDays = v;
    } else throw fail('invalid', { field: k });
  }
  await gc.settings.set(KEY, next);
  return next;
}

module.exports = { load, save, normalise, DEFAULTS, KEY };
