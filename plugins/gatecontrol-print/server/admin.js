'use strict';

// Admin pages (admin/*): devices with ink and "Testseite", rights per person,
// the history, the settings. Only an administrator in GateControl's admin UI
// gets here (server/index.js).

const config = require('./config');
const rights = require('./rights');
const jobs = require('./jobs');
const scans = require('./scans');
const drive = require('./drive');
const { fail, fromHost, posInt } = require('./util');

/** A device for the admin page (everything gc.print reports). */
function deviceView(d) {
  return {
    id: d.id, name: d.name, model: d.model || null, location: d.location || null, ip: d.ip || null, online: !!d.online,
    gateway: d.gateway || null, gatewayOnline: d.gatewayOnline !== false, problem: d.problem || null, seenAt: d.seenAt || null, reportedAt: d.reportedAt || null,
    printer: d.printer || null, scanner: d.scanner || null,
  };
}

async function route(req, gc, seg, cfg) {
  const m = String(req.method || 'GET').toUpperCase();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const user = req.user;
  const what = seg[1];
  if (what === 'devices') {
    if (m === 'GET' && seg.length === 2) {
      let list = [];
      try { list = (await gc.print.devices()) || []; } catch (e) { throw fromHost(e); }
      const reported = list.map((d) => Date.parse(d.reportedAt)).filter(Number.isFinite);
      return { devices: list.map(deviceView), reportedAt: reported.length ? new Date(Math.max(...reported)).toISOString() : null };
    }
    if (m === 'POST' && seg[2] === 'discover' && seg.length === 3) {
      try { return await gc.print.discover(); } catch (e) { throw fromHost(e); }
    }
    if (m === 'POST' && seg.length === 4 && seg[3] === 'test') return jobs.testPage(gc, user, seg[2]);
    if (m === 'POST' && seg.length === 4 && seg[3] === 'retrust') {
      try { return await gc.print.discover({ retrust: seg[2] }); } catch (e) { throw fromHost(e); }
    }
  }
  if (what === 'rights') {
    if (m === 'GET' && seg.length === 2) return { people: await rights.list(gc), defaults: { child: rights.CHILD_DEFAULT, other: rights.ADULT_DEFAULT } };
    if (m === 'PUT' && seg.length === 3) {
      const id = posInt(seg[2]);
      if (!id) throw fail('invalid');
      return { rights: await rights.set(gc, id, b) };
    }
  }
  if (what === 'history' && m === 'GET' && seg.length === 2) {
    const items = [...await jobs.list(gc, { limit: 100 }), ...await scans.list(gc, { limit: 100 })];
    const names = new Map();
    for (const it of items) {
      if (!names.has(it.user)) { let n = ''; try { const u = await gc.users.get(it.user); n = (u && u.name) || ''; } catch { n = ''; } names.set(it.user, n); }
      it.userName = names.get(it.user);
    }
    items.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return { items: items.slice(0, 150) };
  }
  if (what === 'jobs' && m === 'POST' && seg.length === 4 && seg[3] === 'cancel') return jobs.cancel(gc, user, seg[2]);
  if (what === 'settings') {
    if (m === 'GET' && seg.length === 2) return { settings: cfg, drive: await drive.available(gc) };
    if (m === 'PUT' && seg.length === 2) return { settings: await config.save(gc, b) };
  }
  throw fail('not_found');
}

module.exports = { route, deviceView };
