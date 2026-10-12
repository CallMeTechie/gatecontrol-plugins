'use strict';

// Adapters: DSM API answers (the `data` of { success: true, data }) → the
// normalised status the plugin stores and shows. Every field is optional on
// the DSM side; unknown values become null / 'unknown', never an exception.
// Shapes as returned by DSM 7.1 / 7.2 (and DSM 6.2 where the same API
// exists); test/fixtures holds synthetic answers in these shapes.

const num = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
};
const text = (v, max = 120) => (typeof v === 'string' || typeof v === 'number'
  ? String(v).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
const bool = (v) => v === true || v === 'true' || v === 'yes' || v === 1;
const pct = (v) => { const n = num(v); return n == null ? null : Math.max(0, Math.min(100, Math.round(n))); };
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** "342:56:07" (hours:minutes:seconds, hours may exceed 24) → seconds */
function uptimeSeconds(v) {
  if (typeof v === 'number') return v >= 0 ? Math.round(v) : null;
  const m = typeof v === 'string' ? /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(v.trim()) : null;
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** SYNO.DSM.Info v2 getinfo → { model, dsm, build, uptime_s, temp, temp_warn, ram_mb } */
function dsmInfo(d) {
  const x = d || {};
  const ver = text(x.version_string) || (x.version ? `DSM ${text(x.version)}` : null);
  return {
    model: text(x.model, 60), dsm: ver, build: text(x.version, 20), uptime_s: uptimeSeconds(x.uptime),
    temp: num(x.temperature), temp_warn: bool(x.temperature_warn), ram_mb: num(x.ram),
  };
}

/** SYNO.Core.System v1 info (fallback for model/version/temperature/uptime) */
function systemInfo(d) {
  const x = d || {};
  return {
    model: text(x.model, 60), dsm: text(x.firmware_ver), build: null, uptime_s: uptimeSeconds(x.up_time),
    temp: num(x.sys_temp), temp_warn: bool(x.sys_tempwarn) || bool(x.temperature_warning), ram_mb: num(x.ram_size),
  };
}

/** SYNO.Core.System.Utilization v1 get → { cpu %, ram % } (cpu = user + system + other load) */
function utilization(d) {
  const c = (d && d.cpu) || {};
  const m = (d && d.memory) || {};
  const parts = [c.user_load, c.system_load, c.other_load].map(num);
  const cpu = parts.some((p) => p != null) ? pct(parts.reduce((a, b) => a + (b || 0), 0)) : null;
  let ram = pct(m.real_usage);
  if (ram == null && num(m.total_real) && num(m.avail_real) != null) ram = pct(100 * (1 - num(m.avail_real) / num(m.total_real)));
  return { cpu, ram };
}

// ─── Storage ────────────────────────────────────

/** A volume / pool status → normal | degraded | crashed | unknown (raw kept for display). */
function storageStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'unknown';
  if (/crash|fail|broken|dead/.test(s)) return 'crashed';
  if (/degrad|attention|warn|repair|rebuild|abnormal/.test(s)) return 'degraded';
  if (/normal|healthy|^ok$|background|scrub|expand|optimi|migrat|creating|consisten/.test(s)) return 'normal';
  return 'unknown';
}

/** Health of a drive from status / smart_status / overview_status and the thresholds DSM flags. */
function diskHealth(d) {
  const vals = [d.overview_status, d.status, d.smart_status, d.smartStatus].map((v) => String(v || '').toLowerCase()).filter(Boolean);
  if (vals.some((v) => /fail|crash|damage|critical|broken|dead/.test(v))) return 'failing';
  if (vals.some((v) => /warn|abnormal|attention|degrad/.test(v)) || bool(d.exceed_bad_sector_thr) || bool(d.below_remain_life_thr)) return 'warning';
  if (vals.some((v) => /normal|healthy|^ok$|initiali[sz]ed|safe/.test(v))) return 'normal';
  return 'unknown';
}

/** "volume_1" / "/volume1" → 1 */
function numId(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n != null && Number.isInteger(n)) return n;
    const m = typeof v === 'string' ? /(\d+)\s*$/.exec(v) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

function sizeOf(o) {
  const size = (o && o.size) || {};
  const total = num(size.total != null ? size.total : o.total_size);
  const used = num(size.used != null ? size.used : o.used_size);
  return { total, used, pct: total ? Math.max(0, Math.min(100, Math.round((used || 0) * 1000 / total) / 10)) : null };
}

function volume(v) {
  const id = text(v.id || v.name || v.vol_path, 60);
  const n = numId(v.num_id, v.id, v.vol_path, v.name);
  return {
    id, num: n, name: n != null ? `Volume ${n}` : (text(v.display_name, 60) || id), desc: text(v.description || v.desc || v.vol_desc, 80),
    status: storageStatus(v.status || v.summary_status), raw_status: text(v.status, 40),
    fs: text(v.fs_type, 20), pool: text(v.pool_path, 60), ...sizeOf(v),
  };
}

const RAID = { shr_with_1_disk_protect: 'SHR', shr_with_2_disk_protect: 'SHR-2', shr_without_disk_protect: 'SHR-0', basic: 'Basic', jbod: 'JBOD' };

/** device_type "shr_with_1_disk_protect" / "raid_5" → "SHR" / "RAID 5" (else as DSM says it) */
function raidLabel(v) {
  const s = String(v || '').toLowerCase();
  if (RAID[s]) return RAID[s];
  const m = /^raid_?([0-9]+|f1)$/.exec(s);
  return m ? `RAID ${m[1].toUpperCase()}` : text(v, 60);
}

function pool(p) {
  const id = text(p.id || p.pool_path, 60);
  return {
    id, num: numId(p.num_id, p.id), raid: raidLabel(p.device_type || p.raidType), desc: text(p.desc, 80),
    status: storageStatus(p.status || p.summary_status), raw_status: text(p.status, 40),
    disks: Array.isArray(p.disks) ? p.disks.map((x) => text(x && typeof x === 'object' ? x.id : x, 40)).filter(Boolean) : [],
    ...sizeOf(p),
  };
}

function disk(d) {
  const id = text(d.id || d.device || d.diskno || d.diskPath, 60);
  const life = d.remain_life && typeof d.remain_life === 'object' ? d.remain_life : null;
  return {
    id, name: text(d.name || d.diskno, 60) || id, num: numId(d.num_id, d.id, d.diskno),
    model: text(d.model, 60), vendor: text(d.vendor, 40),
    temp: num(d.temp), health: diskHealth(d), raw_status: text(d.smart_status || d.status || d.overview_status, 40),
    size: num(d.size_total != null ? d.size_total : d.capacity), type: text(d.diskType, 20), ssd: bool(d.isSsd),
    remain_life: life && bool(life.trustable) && num(life.value) != null && num(life.value) >= 0 ? num(life.value) : null,
    pool: text(d.used_by || d.volume, 60),
  };
}

/** SYNO.Storage.CGI.Storage v1 load_info → { volumes, pools, disks } (DSM 6.2 / 7.x Storage Manager) */
function storage(d) {
  const x = d || {};
  return {
    source: 'storage',
    volumes: list(x.volumes).map(volume).filter((v) => v.id),
    pools: list(x.storagePools).map(pool).filter((p) => p.id),
    disks: list(x.disks).map(disk).filter((k) => k.id),
  };
}

/** SYNO.Core.System v1 info type=storage → { volumes (vol_info), disks (hdd_info) }, no pools */
function storageFallback(d) {
  const x = d || {};
  return {
    source: 'system',
    volumes: list(x.vol_info).map(volume).filter((v) => v.id),
    pools: [],
    disks: list(x.hdd_info).map(disk).filter((k) => k.id),
  };
}

// ─── Update, backup, UPS ────────────────────────

/**
 * SYNO.Core.Upgrade.Server check → { available, version }. DSM 7 answers
 * { update: { available, version, reboot, type, version_details } }, DSM 6
 * { available, version }.
 */
function upgrade(d) {
  const u = d && d.update && typeof d.update === 'object' ? d.update : (d || {});
  const available = bool(u.available);
  return { available, version: available ? text(u.version, 80) : null, reboot: available ? text(u.reboot, 20) : null };
}

/** last_bkp_result → ok | failed | partial | cancelled | running | none | unknown */
function backupResult(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'none';
  if (/^(done|success|succeeded|finished|ok)$/.test(s)) return 'ok';
  if (/partial/.test(s)) return 'partial';
  if (/fail|error|broken/.test(s)) return 'failed';
  if (/cancel|abort|suspend|stop/.test(s)) return 'cancelled';
  if (/running|backing|progress/.test(s)) return 'running';
  if (/^none$|never/.test(s)) return 'none';
  return 'unknown';
}

/** SYNO.Backup.Task v1 list (Hyper Backup) → [{ id, name, result, last_time, next_time, running }] */
function backups(d) {
  return list(d && d.task_list).map((t) => {
    const id = num(t.task_id);
    const status = String(t.status || '').toLowerCase();
    return {
      id, name: text(t.name, 80) || `#${id}`, type: text(t.type || t.target_type, 30),
      result: backupResult(t.last_bkp_result), raw_result: text(t.last_bkp_result, 30),
      last_time: text(t.last_bkp_end_time || t.last_bkp_time, 30), next_time: text(t.next_bkp_time, 30),
      running: /backup|running|progress|waiting/.test(status) && !/none|idle/.test(status),
      startable: !t.state || /backupable|^$/.test(String(t.state)),
    };
  }).filter((t) => t.id != null);
}

/** SYNO.Core.ExternalDevice.UPS v1 get → null without a connected UPS */
function ups(d) {
  const x = d || {};
  const status = String(x.status || '').toLowerCase();
  const connected = bool(x.usb_ups_connect) || /online|battery|onbatt|lowbatt/.test(status) || (bool(x.enable) && String(x.mode || '').toUpperCase() === 'SLAVE');
  if (!connected) return null;
  let state = 'unknown';
  if (/low/.test(status)) state = 'low';
  else if (/battery|onbatt/.test(status)) state = 'battery';
  else if (/online|ol\b/.test(status)) state = 'online';
  return { model: text([x.manufacture, x.model].filter(Boolean).join(' '), 80), state, charge: pct(x.charge), runtime_s: num(x.runtime) };
}

module.exports = {
  dsmInfo, systemInfo, utilization, storage, storageFallback, upgrade, backups, ups,
  storageStatus, diskHealth, backupResult, raidLabel, uptimeSeconds, num, text,
};
