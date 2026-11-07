'use strict';

// The portal tab "Drucken & Scannen" (a person on the phone or in the browser):
// printers and scanners the person may use, printing an uploaded file,
// scanning into Drive. Rights are checked on every call (rights.js).

const store = require('./store');
const rights = require('./rights');
const jobs = require('./jobs');
const scans = require('./scans');
const drive = require('./drive');
const { fail, fromHost } = require('./util');

function personOf(req) {
  const u = req.user;
  if (!u || !Number.isSafeInteger(u.id) || u.loggedIn === false || u.kiosk === true || u.automation === true) throw fail('forbidden');
  return u;
}

/** A device as the portal shows it — no address. */
/** Document formats the printer accepts (MIME types, as the gateway reports them) – lets the apps pick PDF or JPEG. */
function formatsOf(p) {
  const f = Array.isArray(p.formats) ? p.formats : [];
  return f.filter((x) => typeof x === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(x)).slice(0, 24).map((x) => x.toLowerCase());
}

/** Paper and trays the printer names (GateControl ≥ 1.247.0 with a gateway ≥ 1.33.0; else empty). */
function mediaView(p) {
  const m = p && p.media && typeof p.media === 'object' ? p.media : {};
  const list = (v, re, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && re.test(x)).slice(0, n) : []);
  const sizes = list(m.sizes, /^[a-z0-9]+_[a-z0-9.-]+_[0-9.]+x[0-9.]+(mm|in)$/, 12);
  const sources = list(m.sources, /^[a-z][a-z0-9-]{0,39}$/, 8);
  return { sizes, default: sizes.includes(m.default) ? m.default : null, sources, sourceDefault: sources.includes(m.sourceDefault) ? m.sourceDefault : null };
}

function deviceView(d) {
  const p = d.printer;
  const s = d.scanner;
  return {
    id: d.id, name: d.name, location: d.location || null, online: !!d.online, problem: d.problem || null,
    // office: the printer's gateway turns office files into PDF („Office-Dateien drucken“, GateControl ≥ 1.247.0)
    printer: p ? { state: p.state, color: !!p.color, duplex: !!p.duplex, copiesMax: Math.min(99, p.copiesMax || 99), formats: formatsOf(p), office: p.office === true, media: mediaView(p) } : null,
    scanner: s ? { state: s.state, platen: !!s.platen, feeder: !!s.feeder, adf: s.adf || null } : null,
  };
}

async function visibleFor(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  const r = await rights.of(gc, user);
  return r.print || r.scan;
}

async function overview(gc, user, cfg, lang) {
  const r = await rights.of(gc, user);
  let list = [];
  try { list = (await gc.print.devices()) || []; } catch (e) { throw fromHost(e); }
  const hasDrive = await drive.available(gc);
  // a searchable PDF can be made: a gateway with „Texterkennung“ is online (GateControl ≥ 1.247.0)
  let ocr = false;
  if (r.scan && hasDrive && typeof gc.print.ocrAvailable === 'function') {
    try { ocr = (await gc.print.ocrAvailable()).available === true; } catch { ocr = false; }
  }
  const open = await store.one(gc, "SELECT id FROM scans WHERE user_id = ? AND state = 'open' AND updated_at > ? ORDER BY updated_at DESC LIMIT 1", [user.id, Date.now() - 86400000]);
  const openId = open ? open.id : null;
  return {
    rights: { print: r.print, scan: r.scan, pagesPerDay: r.pagesPerDay, bwOnly: r.bwOnly },
    pagesLeft: r.print ? await jobs.left(gc, user, r) : null,
    printers: r.print ? list.filter((d) => d.printer).map(deviceView) : [],
    scanners: r.scan ? list.filter((d) => d.scanner).map(deviceView) : [],
    drive: hasDrive,
    ai: hasDrive && cfg.aiFile,
    ocr,
    target: { area: cfg.driveArea, folder: cfg.folder },
    jobs: (await jobs.list(gc, { userId: user.id, limit: 10 })),
    scan: openId ? (await scans.status(gc, user, openId)).scan : null,
    defaultName: scans.defaultName(Date.now(), lang),
  };
}

async function route(req, gc, seg, cfg, lang) {
  const m = String(req.method || 'GET').toUpperCase();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const user = personOf(req);
  if (seg[0] === 'overview' && m === 'GET' && seg.length === 1) return overview(gc, user, cfg, lang);
  if (seg[0] === 'print' && m === 'POST' && seg.length === 1) return jobs.print(gc, user, b, { via: req.user.app ? 'app' : 'portal' });
  if (seg[0] === 'jobs' && m === 'POST' && seg.length === 3 && seg[2] === 'cancel') return jobs.cancel(gc, user, seg[1]);
  if (seg[0] === 'jobs' && m === 'GET' && seg.length === 2) return jobs.one(gc, user, seg[1]);
  if (seg[0] === 'scan') {
    if (m === 'POST' && seg.length === 1) return scans.start(gc, user, b);
    if (m === 'GET' && seg.length === 2) return scans.status(gc, user, seg[1]);
    if (m === 'POST' && seg.length === 3) {
      if (seg[2] === 'more') return scans.start(gc, user, { ...b, session: seg[1] });
      if (seg[2] === 'suggest') return scans.suggest(gc, user, seg[1], cfg, lang);
      if (seg[2] === 'save') return scans.save(gc, user, seg[1], b, cfg, lang);
      if (seg[2] === 'discard') return scans.discard(gc, user, seg[1]);
      if (seg[2] === 'remove-page') return scans.removePage(gc, user, seg[1], b.n);
    }
  }
  throw fail('not_found');
}

module.exports = { route, visibleFor, deviceView, mediaView, overview };
