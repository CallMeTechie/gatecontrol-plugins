'use strict';

// "Videos umwandeln", step 2 (1.6.0): converting through the service "umwandeln" of a gateway (host API gc.transcode,
// GateControl with permissions.transcode; the gateway 1.50.0+). The gateway converts one file at a time, checks it,
// swaps it in place and keeps the original in .gc-papierkorb; the plugin decides which files, when and in which order:
//
//   queue    conv_files (state queued): "Umwandeln", "Alle über Nacht", "Jetzt umwandeln". Only paths Jellyfin
//            reported, only .mkv, only under a media folder of the gateway (settings.roots).
//   window   01:00–06:00 (server time, settings): at most ONE job per gateway at a time, the next after the end of the
//            last one, and only when it is likely to finish before the window ends (duration ÷ measured speed + 10 %).
//            "Jetzt umwandeln" submits at once. A running job may finish after the window.
//   watching while Jellyfin's /Sessions shows a playback: pause { ttlSec: 180 } every minute, afterwards resume.
//   reports  hook transcodeChanged and report() every minute: job states → conv_jobs / conv_files; finished jobs are
//            acknowledged (ack) once stored. done → Jellyfin reads the file again (/Library/Media/Updated), the plugin
//            checks that Jellyfin sees 8 bit and the same runtime (checking → done).
//   errors   no_space → back into the queue for the next night (no failed attempt); no_device / device_denied /
//            no_encoder → nothing more for that gateway until it reports a working state; path errors → skipped at
//            once; source_changed → judged again; anything else a failed attempt, two → skipped.
//   trash    the originals in .gc-papierkorb (report().trash): restore, delete now, empty (the gateway deletes them
//            after the trash days itself).
//   morning  one notification to the administrators after the window: "3 Videos umgewandelt, 1 Fehler".

const crypto = require('node:crypto');
const store = require('./store');
const jf = require('./jellyfin');
const sources = require('./sources');
const rules = require('./convert-rules');
const texts = require('./texts.json');
const { fail, json, iso } = require('./util');

const SETTINGS_KEY = 'conv.settings';
const BLOCKED_KEY = 'conv.blocked';
const PAUSED_KEY = 'conv.paused';
const WATCHING_KEY = 'conv.watching';
const NOTIFIED_KEY = 'conv.notified';
const DEFAULTS = Object.freeze({ from: 1, to: 6, pauseWatch: true });
const ACTIVE = new Set(['submitted', 'queued', 'running', 'paused', 'verifying']);
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// the gateway's codes (its docs/transcode.md § 7)
const PATH_ERRORS = new Set(['bad_path', 'outside_roots', 'root_missing', 'symlink', 'not_found', 'not_a_file', 'unsupported_container', 'unsupported_type', 'invalid_request']);
const SETUP_ERRORS = new Set(['no_device', 'device_denied', 'no_encoder']);
const GATEWAY_BAD = new Set(['off', 'service_missing', 'no_roots', 'no_device', 'device_denied', 'no_encoder']);
const GATEWAY_GOOD = new Set(['ready', 'running', 'paused']);
// without a measurement (Spike DS918+: 3.1–3.2 with VAAPI); the software way is about ten times slower
const SPEED_HW = 3.0;
const SPEED_SW = 0.3;
const CHECK_MARGIN = 1.1;
const PAUSE_TTL = 180;
const CHECK_WAIT_MS = 60000;
const CHECK_TRIES = 30;
const LOST_MS = 120000;
const WATCH_KEEP_MS = 14 * 86400000;
const REQUESTS_PER_HOUR = 30;
const RETRY_LATER = new Set(['ERR_TRANSCODE_OFFLINE', 'ERR_TRANSCODE_BUSY', 'ERR_TRANSCODE_TIMEOUT', 'ERR_TRANSCODE_CONFLICT']);

const has = (gc) => !!(gc.transcode && typeof gc.transcode.available === 'function');
const newId = () => crypto.randomBytes(12).toString('base64url');
const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
const reasonOf = (e) => (e && typeof e.reason === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(e.reason) ? e.reason : null);

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

// ── Settings and the night window (server time) ──

async function settings(gc) {
  const v = (await gc.storage.get(SETTINGS_KEY)) || {};
  return { from: hour(v.from, DEFAULTS.from), to: hour(v.to, DEFAULTS.to), pauseWatch: typeof v.pauseWatch === 'boolean' ? v.pauseWatch : DEFAULTS.pauseWatch };
}

function atHour(now, h, days = 0) {
  const d = new Date(now);
  d.setHours(h, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}
function inWindow(cfg, now) {
  const h = new Date(now).getHours();
  if (cfg.from === cfg.to) return false;
  return cfg.from < cfg.to ? h >= cfg.from && h < cfg.to : h >= cfg.from || h < cfg.to;
}
const windowMinutes = (cfg) => ((cfg.to - cfg.from + 24) % 24) * 60;
/** The end of the window that is open now (only meaningful inside it). */
function windowEnd(cfg, now) { const e = atHour(now, cfg.to); return e > now ? e : atHour(now, cfg.to, 1); }
/** When the next window opens (now, inside one). */
function nextStart(cfg, now) {
  if (inWindow(cfg, now)) return now;
  const s = atHour(now, cfg.from);
  return s > now ? s : atHour(now, cfg.from, 1);
}
/** The start of the next window that has not begun yet (tomorrow's while one is open). */
function nextNight(cfg, now) { const s = atHour(now, cfg.from); return s > now ? s : atHour(now, cfg.from, 1); }
const localDay = (now) => { const d = new Date(now); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

// ── Gateways ──

async function available(gc) {
  if (!has(gc)) return null;
  try {
    const r = await gc.transcode.available();
    return { available: !!(r && r.available), gateways: r && Array.isArray(r.gateways) ? r.gateways : [] };
  } catch (e) {
    gc.log.debug('transcode available failed', (e && e.code) || 'error');
    return { available: false, gateways: [], error: (e && e.code) || 'error' };
  }
}

const rootsOf = (g) => (g && g.settings && Array.isArray(g.settings.roots) ? g.settings.roots : []);
/** The gateway whose media folder holds this path (supported and switched on), or null. */
function gatewayFor(av, path) {
  if (!av || typeof path !== 'string') return null;
  return av.gateways.find((g) => g.supported && g.enabled && rootsOf(g).some((r) => path.startsWith(r + '/'))) || null;
}

/** Why a gateway cannot convert now (null: it can): gateway_update | feature_disabled | offline | <state> | blocked code. */
function problemOf(g, blocked) {
  if (!g.supported) return 'gateway_update';
  if (!g.enabled) return 'feature_disabled';
  if (!g.online) return 'offline';
  if (g.state && GATEWAY_BAD.has(g.state)) return g.state;
  const b = blocked && blocked[g.id];
  if (b) return b.code;
  return null;
}

async function blockedMap(gc) { const v = await gc.storage.get(BLOCKED_KEY); return v && typeof v === 'object' ? v : {}; }
async function block(gc, gatewayId, code, now) {
  const b = await blockedMap(gc);
  b[gatewayId] = { code, at: now };
  await gc.storage.set(BLOCKED_KEY, b);
}
/** A gateway that reports a working state after the block lifts it. */
async function unblock(gc, av) {
  const b = await blockedMap(gc);
  let changed = false;
  for (const g of av.gateways) {
    const x = b[g.id];
    if (!x) continue;
    const at = g.reportedAt ? Date.parse(g.reportedAt) : 0;
    if (GATEWAY_GOOD.has(g.state) && at > x.at) { delete b[g.id]; changed = true; }
  }
  if (changed) await gc.storage.set(BLOCKED_KEY, b);
  return b;
}

/** The measured speed of a gateway (× real time, the last five finished jobs) or the default. */
async function speedOf(gc, g) {
  const rows = await store.all(gc, "SELECT result FROM conv_jobs WHERE gateway_id = ? AND state = 'done' AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 5", [g.id]);
  const v = [];
  for (const r of rows) {
    const x = json(r.result, null);
    const d = x && x.source && x.source.duration;
    if (typeof d === 'number' && d > 0 && typeof x.seconds === 'number' && x.seconds > 0) v.push(d / x.seconds);
  }
  if (v.length) return { speed: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100, measured: true };
  const caps = g.caps || {};
  const hw = Array.isArray(caps.encoders) && caps.encoders.length > 0;
  return { speed: !hw && (g.settings && g.settings.software) ? SPEED_SW : SPEED_HW, measured: false };
}

/** Estimated minutes on the gateway: duration ÷ speed + 10 % for the check. */
const minutesFor = (runtime, speed) => (runtime && speed ? Math.max(1, Math.round((runtime / speed) * CHECK_MARGIN / 60)) : null);

// ── Files ──

const fileOf = (gc, sourceId, itemId) => store.one(gc, 'SELECT * FROM conv_files WHERE source_id = ? AND item_id = ?', [sourceId, itemId]);

/** Make sure a file row exists (with the list's row as snapshot) → the row. */
async function ensureFile(gc, item, now) {
  const snap = JSON.stringify(item);
  await store.run(gc, `INSERT INTO conv_files (source_id, item_id, snap, path, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, item_id) DO UPDATE SET snap = excluded.snap, path = excluded.path, updated_at = excluded.updated_at`,
  [item.sourceId, item.id, snap, item.path || null, now]);
  return fileOf(gc, item.sourceId, item.id);
}

/** Can this list row be converted? → null or the reason why not (not_mkv | no_video | no_gateway | <state>). */
function notQueueable(item, av, f) {
  if (!item || !item.path) return 'no_path';
  if (!/\.mkv$/i.test(item.path)) return 'not_mkv';
  if (!item.estimate || item.estimate.kind !== 'encode') return 'no_video';
  if (!gatewayFor(av, item.path)) return 'no_gateway';
  if (f && ['queued', 'running', 'checking'].includes(f.state)) return f.state;
  return null;
}

async function queue(gc, items, { now: nowFlag = false } = {}, now = Date.now()) {
  const av = await available(gc);
  if (!av || !av.gateways.length) throw fail('not_configured', { reason: av ? 'gateway' : 'server' });
  const done = [];
  const skipped = [];
  for (const it of items) {
    const f0 = await fileOf(gc, it.sourceId, it.id);
    const why = notQueueable(it, av, f0);
    if (why) { skipped.push({ id: it.id, reason: why }); continue; }
    await ensureFile(gc, it, now);
    await store.run(gc, `UPDATE conv_files SET state = 'queued', queued_at = ?, now = ?, not_before = NULL, error = NULL, job_id = NULL, hidden = 0,
      fails = CASE WHEN state IN ('skipped', 'restored') THEN 0 ELSE fails END, updated_at = ? WHERE source_id = ? AND item_id = ?`,
    [now, nowFlag ? 1 : 0, now, it.sourceId, it.id]);
    done.push(it.id);
  }
  if (nowFlag && done.length) await dispatch(gc, now, { av });
  return { queued: done, skipped };
}

/** Take a file out of the queue (cancel its job when the gateway has it), or cancel the running one. */
async function unqueue(gc, f, now = Date.now()) {
  if (!f || !['queued', 'running'].includes(f.state)) throw fail('conflict');
  const job = f.job_id ? await store.one(gc, 'SELECT * FROM conv_jobs WHERE id = ?', [f.job_id]) : null;
  if (job && ACTIVE.has(job.state)) {
    try {
      const r = await gc.transcode.cancel(job.gateway_id, job.id);
      if (r && r.job) await updateJob(gc, job, r.job, now);
    } catch (e) {
      if (e && e.code !== 'ERR_NOT_FOUND') throw fail('conflict', { reason: reasonOf(e) || (e && e.code) || 'error' });
      await store.run(gc, "UPDATE conv_jobs SET state = 'lost', updated_at = ? WHERE id = ?", [now, job.id]);
    }
    const j2 = await store.one(gc, 'SELECT state FROM conv_jobs WHERE id = ?', [job.id]);
    // the swap already happened: the job stays done and goes on to the check
    if (j2 && j2.state === 'done') return fileOf(gc, f.source_id, f.item_id);
  }
  await store.run(gc, "UPDATE conv_files SET state = 'none', now = 0, queued_at = NULL, updated_at = ? WHERE source_id = ? AND item_id = ?", [now, f.source_id, f.item_id]);
  return fileOf(gc, f.source_id, f.item_id);
}

async function pauseJob(gc, f, on, now = Date.now()) {
  const job = f && f.job_id ? await store.one(gc, 'SELECT * FROM conv_jobs WHERE id = ?', [f.job_id]) : null;
  if (!job || !ACTIVE.has(job.state)) throw fail('conflict');
  try {
    if (on) await gc.transcode.pause(job.gateway_id, { id: job.id });
    else await gc.transcode.resume(job.gateway_id, { id: job.id });
  } catch (e) { throw fail('conflict', { reason: reasonOf(e) || (e && e.code) || 'error' }); }
  await store.run(gc, 'UPDATE conv_jobs SET paused = ?, updated_at = ? WHERE id = ?', [on ? 1 : 0, now, job.id]);
  return { paused: on };
}

// ── Jobs: what the gateway reports ──

async function updateJob(gc, row, j, now) {
  const state = ACTIVE.has(j.state) || TERMINAL.has(j.state) ? j.state : row.state;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ms = (v) => { const x = v ? Date.parse(v) : NaN; return Number.isFinite(x) ? x : null; };
  await store.run(gc, `UPDATE conv_jobs SET state = ?, error = ?, percent = ?, fps = ?, speed = ?, paused = ?, software = ?, result = COALESCE(?, result),
    started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), updated_at = ? WHERE id = ?`,
  [state, typeof j.error === 'string' ? j.error.slice(0, 40) : null, num(j.percent), num(j.fps), num(j.speed), j.paused === true ? 1 : 0, j.software === true ? 1 : 0,
    j.result && typeof j.result === 'object' ? JSON.stringify(j.result) : null, ms(j.startedAt), TERMINAL.has(state) ? (ms(j.finishedAt) || now) : null, now, row.id]);
  if (ACTIVE.has(state)) {
    const fileState = state === 'queued' || state === 'submitted' ? 'queued' : 'running';
    await store.run(gc, "UPDATE conv_files SET state = ?, updated_at = ? WHERE source_id = ? AND item_id = ? AND job_id = ? AND state IN ('queued', 'running')",
      [fileState, now, row.source_id, row.item_id, row.id]);
  }
}

/** A job ended: what happens to its file (see the head). */
async function finish(gc, row, j, now) {
  const f = await fileOf(gc, row.source_id, row.item_id);
  if (!f || f.job_id !== row.id) return;
  const err = typeof j.error === 'string' ? j.error : null;
  const set = (sql, params) => store.run(gc, `UPDATE conv_files SET ${sql}, updated_at = ? WHERE source_id = ? AND item_id = ?`, [...params, now, row.source_id, row.item_id]);
  if (j.state === 'done') {
    await set("state = 'checking', now = 0, error = NULL, check_state = ?", [JSON.stringify({ refreshed: null, tries: 0 })]);
    return;
  }
  if (j.state === 'cancelled') {
    if (['queued', 'running'].includes(f.state)) await set("state = 'none', now = 0, queued_at = NULL", []);
    return;
  }
  if (err === 'no_space') {
    // not a failed attempt: back into the queue, not before the next night (a new id then)
    await set("state = 'queued', now = 0, error = 'no_space', job_id = NULL, not_before = ?", [nextNight(await settings(gc), now)]);
    return;
  }
  if (err && SETUP_ERRORS.has(err)) {
    await set('state = \'queued\', error = ?, job_id = NULL', [err]);
    await block(gc, row.gateway_id, err, now);
    return;
  }
  if (err === 'source_changed') {
    await set("state = 'none', now = 0, error = 'source_changed', job_id = NULL", []);
    return;
  }
  if (err && PATH_ERRORS.has(err)) {
    await set("state = 'skipped', now = 0, error = ?", [err]);
    return;
  }
  const fails = (f.fails || 0) + 1;
  await set('state = ?, now = 0, fails = ?, error = ?, job_id = ?', [fails >= 2 ? 'skipped' : 'queued', fails, err || 'failed', fails >= 2 ? row.id : null]);
}

/** One state of a gateway (report, live status or the hook) → conv_jobs / conv_files; acknowledge what is stored. */
async function sync(gc, gatewayId, st, now = Date.now()) {
  if (!st || typeof st !== 'object' || !Array.isArray(st.jobs)) return 0;
  const rows = await store.all(gc, 'SELECT * FROM conv_jobs WHERE gateway_id = ? AND acked = 0', [gatewayId]);
  const ours = new Map(rows.map((r) => [r.id, r]));
  const ack = [];
  let changed = 0;
  for (const j of st.jobs) {
    const row = j && ours.get(j.id);
    if (!row) continue;
    ours.delete(j.id);
    if (TERMINAL.has(row.state) || row.state === 'lost') { ack.push(j.id); continue; }
    await updateJob(gc, row, j, now);
    changed++;
    if (TERMINAL.has(j.state)) { await finish(gc, row, j, now); ack.push(j.id); }
  }
  // a job of ours the gateway does not know (any more): lost — the file goes back into the queue (a new id)
  const at = st.at ? Date.parse(st.at) : NaN;
  for (const row of ours.values()) {
    if (!ACTIVE.has(row.state) || !Number.isFinite(at) || at < row.submitted_at + LOST_MS) {
      if (TERMINAL.has(row.state)) await store.run(gc, 'UPDATE conv_jobs SET acked = 1 WHERE id = ?', [row.id]);
      continue;
    }
    await store.run(gc, "UPDATE conv_jobs SET state = 'lost', acked = 1, updated_at = ? WHERE id = ?", [now, row.id]);
    await store.run(gc, "UPDATE conv_files SET state = 'queued', job_id = NULL, updated_at = ? WHERE source_id = ? AND item_id = ? AND job_id = ? AND state IN ('queued', 'running')",
      [now, row.source_id, row.item_id, row.id]);
    changed++;
  }
  if (ack.length) {
    try {
      await gc.transcode.ack(gatewayId, ack.slice(0, 200));
      await store.run(gc, `UPDATE conv_jobs SET acked = 1 WHERE id IN (${store.marks(Math.min(ack.length, 200))})`, ack.slice(0, 200));
    } catch (e) { gc.log.debug('transcode ack failed', (e && e.code) || 'error'); }
  }
  return changed;
}

/** Hook transcodeChanged { gatewayId, status }. */
async function onReport(gc, ev) {
  if (!ev || !Number.isSafeInteger(ev.gatewayId)) return;
  const n = await sync(gc, ev.gatewayId, ev.status, Date.now());
  // a job ended: the next one need not wait for the minute
  if (n) await dispatch(gc, Date.now());
}

// ── Submitting ──

/** The queued files in the order they are converted: "Jetzt" first, then series somebody watches, stalled, by date. */
async function ordered(gc, now = Date.now()) {
  const rows = await store.all(gc, `SELECT f.*, i.stalled_at FROM conv_files f LEFT JOIN conv_items i ON i.source_id = f.source_id AND i.item_id = f.item_id
    WHERE f.state = 'queued'`);
  const watching = (await gc.storage.get(WATCHING_KEY)) || {};
  const watched = (r) => { const s = json(r.snap, {}); const at = s.series ? watching[s.series] : null; return at && now - at < WATCH_KEEP_MS ? at : 0; };
  return rows.map((r) => ({ ...r, s: json(r.snap, {}), w: watched(r) })).sort((a, b) => (b.now - a.now)
    || ((b.w ? 1 : 0) - (a.w ? 1 : 0))
    || (a.w && b.w && a.s.series === b.s.series ? ((a.s.season || 0) - (b.s.season || 0)) || ((a.s.episode || 0) - (b.s.episode || 0)) : (b.w - a.w))
    || ((b.stalled_at ? 1 : 0) - (a.stalled_at ? 1 : 0))
    || ((a.queued_at || 0) - (b.queued_at || 0)));
}

async function submit(gc, f, g, now) {
  const id = newId();
  await store.run(gc, "INSERT INTO conv_jobs (id, source_id, item_id, gateway_id, path, state, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)",
    [id, f.source_id, f.item_id, g.id, f.path, now, now]);
  await store.run(gc, 'UPDATE conv_files SET job_id = ?, gateway_id = ?, not_before = NULL, updated_at = ? WHERE source_id = ? AND item_id = ?', [id, g.id, now, f.source_id, f.item_id]);
  try {
    const r = await gc.transcode.submit({ gatewayId: g.id, id, path: f.path });
    const row = await store.one(gc, 'SELECT * FROM conv_jobs WHERE id = ?', [id]);
    await updateJob(gc, row, (r && r.job) || { state: 'queued' }, now);
    return true;
  } catch (e) {
    await store.run(gc, 'DELETE FROM conv_jobs WHERE id = ?', [id]);
    const code = e && e.code;
    const why = reasonOf(e) || (typeof code === 'string' ? code.toLowerCase() : 'error');
    if (code === 'ERR_INVALID') {
      await store.run(gc, "UPDATE conv_files SET state = 'skipped', now = 0, job_id = NULL, error = ?, updated_at = ? WHERE source_id = ? AND item_id = ?", [why, now, f.source_id, f.item_id]);
    } else {
      await store.run(gc, 'UPDATE conv_files SET job_id = NULL, error = ?, updated_at = ? WHERE source_id = ? AND item_id = ?', [why, now, f.source_id, f.item_id]);
      if (!RETRY_LATER.has(code)) await block(gc, g.id, why, now);
    }
    gc.log.debug('transcode submit failed', code || 'error', why);
    return false;
  }
}

// one dispatch at a time in this process (the tick, the hook and "Jetzt umwandeln" may meet)
let dispatching = Promise.resolve();
/** Submit what is due: "Jetzt" at once; in the window one job per gateway that is likely to finish before it ends. */
function dispatch(gc, now = Date.now(), o = {}) {
  const p = dispatching.then(() => dispatchNow(gc, now, o));
  dispatching = p.catch(() => {});
  return p;
}

async function dispatchNow(gc, now, { av: av0 } = {}) {
  const av = av0 || await available(gc);
  if (!av || !av.gateways.length) return 0;
  const cfg = await settings(gc);
  const blocked = await unblock(gc, av);
  const queue = await ordered(gc, now);
  if (!queue.length) return 0;
  let n = 0;
  for (const g of av.gateways) {
    if (problemOf(g, blocked)) continue;
    const mine = queue.filter((f) => !f.job_id && gatewayFor(av, f.path) === g && (!f.not_before || f.not_before <= now));
    for (const f of mine.filter((x) => x.now)) if (await submit(gc, f, g, now)) n++;
    if (!inWindow(cfg, now)) continue;
    const busy = await store.one(gc, `SELECT COUNT(*) AS n FROM conv_jobs WHERE gateway_id = ? AND state IN ('submitted', 'queued', 'running', 'paused', 'verifying')`, [g.id]);
    if (busy && busy.n) continue;
    const { speed } = await speedOf(gc, g);
    const end = windowEnd(cfg, now);
    for (const f of mine.filter((x) => !x.now)) {
      const m = minutesFor(f.s.runtime, speed);
      if (m != null && now + m * 60000 > end) continue;
      if (await submit(gc, f, g, now)) { n++; break; }
    }
  }
  return n;
}

// ── Pause while somebody watches ──

/**
 * sessions: [{ src, list }] of the Jellyfin sources. A playback (NowPlayingItem) pauses every gateway with a job for
 * PAUSE_TTL seconds, renewed every minute; afterwards resume. Also remembers which series are being watched (order).
 */
async function pauseWatch(gc, av, sessions, now = Date.now()) {
  const cfg = await settings(gc);
  let playing = false;
  const watching = (await gc.storage.get(WATCHING_KEY)) || {};
  let seen = false;
  for (const x of sessions || []) {
    for (const s of x.list || []) {
      const np = s && s.NowPlayingItem;
      if (!np || typeof np !== 'object') continue;
      playing = true;
      if (np.Type === 'Episode' && typeof np.SeriesName === 'string' && np.SeriesName) { watching[np.SeriesName.slice(0, 200)] = now; seen = true; }
    }
  }
  if (seen) {
    for (const k of Object.keys(watching)) if (now - watching[k] > WATCH_KEEP_MS) delete watching[k];
    await gc.storage.set(WATCHING_KEY, watching);
  }
  if (!av) return { playing };
  const paused = (await gc.storage.get(PAUSED_KEY)) || {};
  let changed = false;
  for (const g of av.gateways) {
    if (!g.supported || !g.enabled || !g.online) continue;
    const busy = await store.one(gc, `SELECT COUNT(*) AS n FROM conv_jobs WHERE gateway_id = ? AND state IN ('submitted', 'queued', 'running', 'paused', 'verifying')`, [g.id]);
    if (cfg.pauseWatch && playing && busy && busy.n) {
      try { await gc.transcode.pause(g.id, { ttlSec: PAUSE_TTL }); paused[g.id] = now; changed = true; } catch (e) { gc.log.debug('transcode pause failed', (e && e.code) || 'error'); }
    } else if (paused[g.id]) {
      try { await gc.transcode.resume(g.id); delete paused[g.id]; changed = true; } catch (e) {
        // offline: it resumes by itself after the ttl
        if (!(e && e.code === 'ERR_TRANSCODE_OFFLINE')) { delete paused[g.id]; changed = true; }
        gc.log.debug('transcode resume failed', (e && e.code) || 'error');
      }
    }
  }
  if (changed) await gc.storage.set(PAUSED_KEY, paused);
  return { playing, paused };
}

// ── Check: Jellyfin reads the new file ──

async function check(gc, rejudge, now = Date.now()) {
  const rows = await store.all(gc, "SELECT * FROM conv_files WHERE state = 'checking' ORDER BY updated_at LIMIT 20");
  for (const f of rows) {
    const src = await sources.get(gc, f.source_id);
    const key = src ? await sources.apiKey(gc, src) : null;
    const cs = json(f.check_state, {}) || {};
    const save = (state, extra = {}) => store.run(gc, `UPDATE conv_files SET state = ?, check_state = ?, done_at = ?, updated_at = ? WHERE source_id = ? AND item_id = ?`,
      [state, JSON.stringify({ ...cs, ...extra }), state === 'done' ? now : null, now, f.source_id, f.item_id]);
    if (!src || !key) { await save('done', { ok: null, at: now, reason: 'no_source' }); continue; }
    const index = src.config.targetIndex || 0;
    if (!cs.refreshed || (cs.tries && cs.tries % 10 === 0 && now - cs.refreshed > 5 * 60000)) {
      try { await jf.mediaUpdated(gc, index, key, f.path); } catch { try { await jf.refreshItem(gc, index, key, f.item_id); } catch { /* next minute */ } }
      cs.refreshed = now;
      await save('checking');
      continue;
    }
    if (now - cs.refreshed < CHECK_WAIT_MS) continue;
    cs.tries = (cs.tries || 0) + 1;
    let it = null;
    try { it = await jf.item(gc, index, key, f.item_id); } catch { it = null; }
    const job = f.job_id ? await store.one(gc, 'SELECT result FROM conv_jobs WHERE id = ?', [f.job_id]) : null;
    const res = job ? json(job.result, null) : null;
    const want = res && res.output && typeof res.output.duration === 'number' ? res.output.duration : (json(f.snap, {}).runtime || null);
    if (it) {
      const ms = Array.isArray(it.MediaSources) ? it.MediaSources.find((s) => s && s.Path === f.path) || it.MediaSources[0] : null;
      const { video } = rules.streamsOf(ms || {});
      const bits = video ? rules.bitDepthOf(video) : null;
      const runtime = ms && ms.RunTimeTicks ? Math.round(ms.RunTimeTicks / 1e5) / 100 : null;
      const sameRuntime = want == null || runtime == null || Math.abs(runtime - want) <= 2;
      if (bits === 8 && String(video.Codec || '').toLowerCase() === 'h264' && sameRuntime) {
        await save('done', { ok: true, bits, runtime, at: now });
        try { await rejudge(gc, src, it); } catch (e) { gc.log.debug('rejudge failed', (e && e.code) || 'error'); }
        continue;
      }
      cs.bits = bits;
      cs.runtime = runtime;
    }
    if (cs.tries >= CHECK_TRIES) await save('done', { ok: false, at: now });
    else await save('checking');
  }
}

// ── Trash ──

async function trash(gc) {
  const av = await available(gc);
  if (!av) return { gateways: [] };
  const out = [];
  for (const g of av.gateways.filter((x) => x.supported)) {
    // live when the gateway answers (the trash changes without a job), else the last report
    let rep = null;
    if (g.online && g.enabled) { try { rep = await gc.transcode.status(g.id); } catch { rep = null; } }
    if (!rep) { try { rep = await gc.transcode.report(g.id); } catch { rep = null; } }
    const list = rep && Array.isArray(rep.trash) ? rep.trash : [];
    const ids = list.map((x) => x.id).filter((x) => typeof x === 'string');
    const jobs = ids.length ? await store.all(gc, `SELECT j.id, j.source_id, j.item_id, f.snap, f.state FROM conv_jobs j LEFT JOIN conv_files f ON f.source_id = j.source_id AND f.item_id = j.item_id
      WHERE j.id IN (${store.marks(ids.length)})`, ids) : [];
    out.push({
      id: g.id, name: g.name, online: !!g.online, trashDays: g.settings ? g.settings.trashDays : null,
      trash: list.map((x) => {
        const j = jobs.find((y) => y.id === x.id);
        const s = j ? json(j.snap, {}) : {};
        return { id: x.id, at: x.at || null, size: x.size == null ? null : x.size, expiresAt: x.expiresAt || null, path: x.path || null,
          sourceId: j ? j.source_id : null, itemId: j ? j.item_id : null, title: s.name ? s : null, restored: j ? j.state === 'restored' : false };
      }),
    });
  }
  return { gateways: out };
}

async function restore(gc, gatewayId, id, now = Date.now()) {
  let r;
  try { r = await gc.transcode.restore(gatewayId, id); } catch (e) { throw fail('conflict', { reason: reasonOf(e) || (e && e.code) || 'error' }); }
  const job = await store.one(gc, 'SELECT * FROM conv_jobs WHERE id = ?', [id]);
  if (job) {
    await store.run(gc, "UPDATE conv_files SET state = 'restored', now = 0, queued_at = NULL, updated_at = ? WHERE source_id = ? AND item_id = ?", [now, job.source_id, job.item_id]);
    // Jellyfin reads the original again; the next scan judges it (it is not queued again by itself)
    const src = await sources.get(gc, job.source_id);
    const key = src ? await sources.apiKey(gc, src) : null;
    if (key) {
      const index = src.config.targetIndex || 0;
      try { await jf.mediaUpdated(gc, index, key, job.path); } catch { try { await jf.refreshItem(gc, index, key, job.item_id); } catch { /* the next scan */ } }
    }
  }
  return { restored: !!(r && r.restored), id };
}

async function purge(gc, gatewayId, o) {
  try { await gc.transcode.purge(gatewayId, o.all ? { all: true } : { id: o.id }); } catch (e) { throw fail('conflict', { reason: reasonOf(e) || (e && e.code) || 'error' }); }
  return { purged: true };
}

// ── Morning notification ──

async function morning(gc, now = Date.now()) {
  const cfg = await settings(gc);
  if (inWindow(cfg, now) || now < atHour(now, cfg.to)) return null;
  const day = localDay(now);
  const last = (await gc.storage.get(NOTIFIED_KEY)) || {};
  if (last.day === day) return null;
  const since = Number.isFinite(last.at) ? last.at : now - 86400000;
  await gc.storage.set(NOTIFIED_KEY, { day, at: now });
  const done = await store.one(gc, "SELECT COUNT(*) AS n FROM conv_jobs WHERE state = 'done' AND finished_at > ? AND finished_at <= ?", [since, now]);
  const failed = await store.one(gc, "SELECT COUNT(*) AS n FROM conv_jobs WHERE state = 'failed' AND finished_at > ? AND finished_at <= ? AND COALESCE(error, '') NOT IN ('no_space', 'source_changed')", [since, now]);
  const d = (done && done.n) || 0;
  const x = (failed && failed.n) || 0;
  if (!d && !x) return null;
  if (typeof gc.notify !== 'function') return null;
  const by = new Map();
  for (const u of (await gc.users.list()) || []) {
    if (u.role !== 'admin' || u.disabled === true || u.enabled === false) continue;
    const l = u.lang === 'en' ? 'en' : 'de';
    if (!by.has(l)) by.set(l, []);
    by.get(l).push(u.id);
  }
  const sent = [];
  for (const [lang, users] of by) {
    const body = t(lang, d === 1 ? 'notify.cv_done_1' : 'notify.cv_done', { n: d }) + (x ? ' · ' + t(lang, x === 1 ? 'notify.cv_failed_1' : 'notify.cv_failed', { n: x }) : '');
    try {
      await gc.notify({ topic: 'convert', users: users.slice(0, 100), collapseKey: 'medien-convert', title: t(lang, 'notify.cv_title'), body });
      sent.push({ lang, body });
    } catch (e) { gc.log.debug('convert notice not sent', (e && e.code) || 'error'); }
  }
  return { done: d, failed: x, sent };
}

// ── Background (every minute) ──

async function background(gc, now, { sessions, rejudge }) {
  if (!has(gc)) return;
  const av = await available(gc);
  if (av) {
    for (const g of av.gateways.filter((x) => x.supported)) {
      const open = await store.one(gc, 'SELECT COUNT(*) AS n FROM conv_jobs WHERE gateway_id = ? AND acked = 0', [g.id]);
      if (!open || !open.n) continue;
      let rep = null;
      try { rep = await gc.transcode.report(g.id); } catch { rep = null; }
      if (rep) await sync(gc, g.id, rep, now);
    }
    const busy = await store.one(gc, "SELECT COUNT(*) AS n FROM conv_jobs WHERE state IN ('submitted', 'queued', 'running', 'paused', 'verifying')");
    const paused = (await gc.storage.get(PAUSED_KEY)) || {};
    if ((busy && busy.n) || Object.keys(paused).length) await pauseWatch(gc, av, await sessions(), now);
    await dispatch(gc, now, { av });
  }
  await check(gc, rejudge, now);
  await morning(gc, now);
}

// ── Views ──

const PUBLIC_STATE = { queued: 'queued', running: 'running', checking: 'running', done: 'done' };

/** What the list shows per file, the queue order and estimates; the running jobs. */
async function overview(gc, items, now = Date.now()) {
  const av = await available(gc);
  const cfg = await settings(gc);
  const blocked = av ? await blockedMap(gc) : {};
  const files = await store.all(gc, 'SELECT * FROM conv_files');
  const byKey = new Map(files.map((f) => [f.source_id + '/' + f.item_id, f]));
  const order = await ordered(gc, now);
  const jobs = await store.all(gc, `SELECT * FROM conv_jobs WHERE state IN ('submitted', 'queued', 'running', 'paused', 'verifying') OR id IN (SELECT job_id FROM conv_files WHERE job_id IS NOT NULL)`);
  const jobOf = (id) => jobs.find((j) => j.id === id) || null;
  const speeds = {};
  if (av) for (const g of av.gateways) speeds[g.id] = await speedOf(gc, g);
  const speedFor = (path) => { const g = gatewayFor(av, path); return g ? speeds[g.id].speed : null; };
  const paused = (await gc.storage.get(PAUSED_KEY)) || {};

  const conv = (it, f) => {
    const job = f && f.job_id ? jobOf(f.job_id) : null;
    const pos = f && f.state === 'queued' ? order.findIndex((x) => x.source_id === f.source_id && x.item_id === f.item_id) : -1;
    const sp = speedFor(it.path);
    return {
      state: f ? f.state : 'none', error: f ? f.error : null, fails: f ? f.fails : 0, now: !!(f && f.now), hidden: !!(f && f.hidden),
      position: pos >= 0 ? pos + 1 : null, notBefore: f ? iso(f.not_before) : null,
      requested: f && f.requested_at ? iso(f.requested_at) : null,
      job: job ? { id: job.id, state: job.state, percent: job.percent, fps: job.fps, speed: job.speed, paused: !!job.paused, software: !!job.software, error: job.error } : null,
      minutes: it.estimate && it.estimate.kind === 'encode' ? (minutesFor(it.runtime, sp) || (it.estimate.minutes == null ? null : it.estimate.minutes)) : null,
      why: f && ['queued', 'running', 'checking'].includes(f.state) ? null : notQueueable(it, av, null),
      check: f && f.check_state ? json(f.check_state, null) : null,
      doneAt: f ? iso(f.done_at) : null,
    };
  };
  const listed = new Set(items.map((x) => x.sourceId + '/' + x.id));
  const out = items.map((it) => ({ ...it, conv: conv(it, byKey.get(it.sourceId + '/' + it.id)) }));
  // converted files drop out of the scan's list: they come from their snapshot
  for (const f of files) {
    if (listed.has(f.source_id + '/' + f.item_id) || f.state === 'none' || (f.state === 'restored' && !f.job_id)) continue;
    const s = json(f.snap, null);
    if (!s || !s.id) continue;
    out.push({ ...s, conv: conv(s, f) });
  }
  const queue = { count: 0, minutes: 0, unknown: 0 };
  for (const f of order) { queue.count++; const m = minutesFor(f.s.runtime, speedFor(f.path)); if (m == null) queue.unknown++; else queue.minutes += m; }
  queue.fits = queue.minutes <= windowMinutes(cfg);
  const current = [];
  for (const j of jobs.filter((x) => ['running', 'paused', 'verifying'].includes(x.state))) {
    const f = byKey.get(j.source_id + '/' + j.item_id);
    const s = f ? json(f.snap, {}) : {};
    const g = av ? av.gateways.find((x) => x.id === j.gateway_id) : null;
    const remaining = s.runtime && j.speed ? Math.max(0, Math.round((s.runtime * (1 - (j.percent || 0) / 100)) / j.speed / 60)) : null;
    const root = g && Array.isArray(g.roots) ? g.roots.find((r) => r && typeof r.path === 'string' && j.path.startsWith(r.path + '/')) : null;
    current.push({ sourceId: j.source_id, id: j.item_id, item: s, jobId: j.id, state: j.state, percent: j.percent, fps: j.fps, speed: j.speed,
      paused: !!j.paused, pausedAll: !!paused[j.gateway_id], software: !!j.software, remaining, gateway: g ? { id: g.id, name: g.name, encoders: (g.caps && g.caps.encoders) || [] } : null,
      free: root && root.free != null ? { path: root.path, bytes: root.free } : null });
  }
  let reason = null;
  const gws = av ? av.gateways.map((g) => ({ id: g.id, name: g.name, online: !!g.online, supported: !!g.supported, enabled: !!g.enabled, state: g.state || null,
    service: g.service || null, problem: problemOf(g, blocked), deviceGid: g.caps && g.caps.deviceGid != null ? g.caps.deviceGid : null, roots: rootsOf(g),
    trashDays: g.settings ? g.settings.trashDays : null, quality: g.settings ? g.settings.quality : null, trash: g.trash || null,
    speed: speeds[g.id] || null, paused: !!paused[g.id], minGateway: g.minGateway || null })) : [];
  if (!av) reason = 'server';
  else if (!gws.length) reason = 'gateway';
  else if (!gws.some((g) => !g.problem)) reason = gws[0].problem;
  const trashSum = { count: 0, bytes: 0, oldest: null };
  for (const g of gws) {
    if (!g.trash) continue;
    trashSum.count += g.trash.count || 0;
    trashSum.bytes += g.trash.bytes || 0;
  }
  if (trashSum.count && av) {
    for (const g of av.gateways.filter((x) => x.supported)) {
      let rep = null;
      try { rep = await gc.transcode.report(g.id); } catch { rep = null; }
      for (const x of (rep && Array.isArray(rep.trash) ? rep.trash : [])) {
        const e = x.expiresAt ? Date.parse(x.expiresAt) : NaN;
        if (Number.isFinite(e) && (!trashSum.oldest || e < Date.parse(trashSum.oldest))) trashSum.oldest = new Date(e).toISOString();
      }
    }
  }
  return {
    items: out,
    transcode: { available: !!(av && gws.some((g) => !g.problem)), reason, gateways: gws },
    settings: { ...cfg, windowMinutes: windowMinutes(cfg), trashDays: gws.length ? gws[0].trashDays : 14, quality: gws.length ? gws[0].quality : 23 },
    window: { from: String(cfg.from).padStart(2, '0') + ':00', to: String(cfg.to).padStart(2, '0') + ':00', minutes: windowMinutes(cfg), open: inWindow(cfg, now), nextStart: iso(nextStart(cfg, now)) },
    queue, current, trash: trashSum,
  };
}

/** The check view of one file ("geprüft"): original against new, the probe run, Jellyfin, the original in the trash. */
async function detail(gc, sourceId, itemId) {
  const f = await fileOf(gc, sourceId, itemId);
  if (!f) throw fail('not_found');
  const jobs = await store.all(gc, 'SELECT * FROM conv_jobs WHERE source_id = ? AND item_id = ? ORDER BY submitted_at DESC LIMIT 5', [sourceId, itemId]);
  const done = jobs.find((j) => j.state === 'done') || null;
  let trashEntry = null;
  if (done) {
    try {
      const rep = await gc.transcode.report(done.gateway_id);
      trashEntry = (rep && Array.isArray(rep.trash) ? rep.trash : []).find((x) => x.id === done.id) || null;
    } catch { trashEntry = null; }
  }
  return {
    file: { sourceId, id: itemId, state: f.state, error: f.error, fails: f.fails, item: json(f.snap, {}), check: json(f.check_state, null), doneAt: iso(f.done_at) },
    job: done ? { id: done.id, gatewayId: done.gateway_id, startedAt: iso(done.started_at), finishedAt: iso(done.finished_at), result: json(done.result, null), software: !!done.software } : null,
    attempts: jobs.map((j) => ({ id: j.id, state: j.state, error: j.error, submittedAt: iso(j.submitted_at), finishedAt: iso(j.finished_at), log: (json(j.result, {}) || {}).log || [] })),
    trash: trashEntry,
  };
}

/** App API: the state of files for the hint before playing → { <itemId>: { state, position, startsAt, percent } }. */
async function appStates(gc, keys, now = Date.now()) {
  const out = {};
  if (!keys.length) return out;
  const cfg = await settings(gc);
  const av = await available(gc);
  const order = await ordered(gc, now);
  const speeds = {};
  if (av) for (const g of av.gateways) speeds[g.id] = (await speedOf(gc, g)).speed;
  const minutes = (f) => { const g = gatewayFor(av, f.path); return minutesFor(f.s.runtime, g ? speeds[g.id] : SPEED_HW) || 0; };
  // a rough start time: the next window (now while it is open), after the files before it
  let t0 = nextStart(cfg, now);
  const starts = new Map();
  for (const f of order) {
    const at = f.now ? now : Math.max(t0, f.not_before || 0);
    starts.set(f.source_id + '/' + f.item_id, at);
    if (!f.now) t0 = at + minutes(f) * 60000;
  }
  for (const [sourceId, itemId] of keys) {
    const f = await fileOf(gc, sourceId, itemId);
    const state = f ? PUBLIC_STATE[f.state] || 'none' : 'none';
    let percent = null;
    if (f && f.state === 'running' && f.job_id) { const j = await store.one(gc, 'SELECT percent FROM conv_jobs WHERE id = ?', [f.job_id]); percent = j && j.percent != null ? Math.round(j.percent) : null; }
    if (f && f.state === 'checking') percent = 100;
    const pos = state === 'queued' ? order.findIndex((x) => x.source_id === sourceId && x.item_id === itemId) : -1;
    out[sourceId + '/' + itemId] = { state, position: pos >= 0 ? pos + 1 : null, startsAt: state === 'queued' ? iso(starts.get(sourceId + '/' + itemId)) : null, percent };
  }
  return out;
}

/** App API: "Umwandeln anfragen" — only onto the list (the administrator queues it, Frage 100 b). */
async function request(gc, item, userId, now = Date.now()) {
  if (!(await store.hit(gc, 'convreq:' + userId, REQUESTS_PER_HOUR, 3600000, now))) throw fail('rate_limited');
  await ensureFile(gc, item, now);
  await store.run(gc, 'UPDATE conv_files SET requested_at = COALESCE(requested_at, ?), requested_by = COALESCE(requested_by, ?), hidden = 0, updated_at = ? WHERE source_id = ? AND item_id = ?',
    [now, userId, now, item.sourceId, item.id]);
  return fileOf(gc, item.sourceId, item.id);
}

/** Settings of the page: the window and the pause (the plugin), trash days and quality (each gateway, gc.transcode.settings). */
async function saveSettings(gc, b) {
  const cur = await settings(gc);
  const next = { ...cur };
  for (const k of ['from', 'to']) {
    if (b[k] === undefined) continue;
    if (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > 23) throw fail('invalid', { field: k });
    next[k] = b[k];
  }
  if (next.from === next.to) throw fail('invalid', { field: 'to' });
  if (b.pauseWatch !== undefined) {
    if (typeof b.pauseWatch !== 'boolean') throw fail('invalid', { field: 'pauseWatch' });
    next.pauseWatch = b.pauseWatch;
  }
  const patch = {};
  if (b.trashDays !== undefined) { if (!Number.isInteger(b.trashDays) || b.trashDays < 1 || b.trashDays > 365) throw fail('invalid', { field: 'trashDays' }); patch.trashDays = b.trashDays; }
  if (b.quality !== undefined) { if (!Number.isInteger(b.quality) || b.quality < 16 || b.quality > 32) throw fail('invalid', { field: 'quality' }); patch.quality = b.quality; }
  await gc.storage.set(SETTINGS_KEY, next);
  const failed = [];
  if (Object.keys(patch).length) {
    const av = await available(gc);
    for (const g of (av ? av.gateways : []).filter((x) => x.supported)) {
      try { await gc.transcode.settings(g.id, patch); } catch (e) { failed.push({ id: g.id, code: (e && e.code) || 'error' }); }
    }
  }
  return { settings: next, failed };
}

module.exports = {
  has, settings, saveSettings, available, gatewayFor, problemOf, notQueueable, queue, unqueue, pauseJob, sync, onReport, dispatch, ordered,
  pauseWatch, check, trash, restore, purge, morning, background, overview, detail, appStates, request, fileOf, ensureFile,
  inWindow, windowEnd, nextStart, nextNight, atHour, minutesFor, speedOf, DEFAULTS, PAUSE_TTL, SPEED_HW, SPEED_SW,
};
