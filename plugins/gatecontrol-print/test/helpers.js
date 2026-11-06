'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js, GateControl 1.236.0 with gc.print — tools/testing/mock-print.js)
// with people, the family (Lea and Tim are children), two devices (a printer with a scanner, a black-and-white printer)
// and a fake Drive (services list_areas / save_file / suggest_folder, media it receives).
//
//   ADMIN (admin) · MARC · SABINE · LEA (child) · TIM (child)

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'Admin', role: 'admin' };
const MARC = { id: 2, name: 'Marc', role: 'user' };
const SABINE = { id: 3, name: 'Sabine', role: 'user' };
const LEA = { id: 4, name: 'Lea', role: 'user' };
const TIM = { id: 5, name: 'Tim', role: 'user' };
const USERS = [ADMIN, MARC, SABINE, LEA, TIM];
const HP = 'u:f0d8a1b2000010008000' + '00aabbccddee';
const BRO = 'h:0123456789abcdef';

function devices() {
  return [
    { id: HP, name: 'HP OfficeJet 8020', model: 'HP OfficeJet 8020 series', location: 'Wohnzimmer', ip: '192.168.1.57', online: true, gatewayId: 7, gateway: 'DS918 Gateway', gatewayOnline: true, problem: null,
      printer: { state: 'idle', reasons: [], color: true, duplex: true, formats: ['application/pdf', 'image/jpeg', 'image/urf'], copiesMax: 99,
        markers: [{ name: 'Black', color: '#000000', type: 'ink-cartridge', level: 62, low: false }, { name: 'Magenta', color: '#FF00FF', type: 'ink-cartridge', level: 8, low: true }] },
      scanner: { state: 'idle', platen: true, feeder: true, duplex: false, color: ['bw', 'gray', 'color'], resolutions: [150, 300, 600], formats: ['image/jpeg'], adf: 'loaded' },
      seenAt: new Date().toISOString(), reportedAt: new Date().toISOString() },
    { id: BRO, name: 'Brother HL-L2350DW', model: 'Brother HL-L2350DW', location: 'Arbeitszimmer', ip: '192.168.1.61', online: true, gatewayId: 7, gateway: 'DS918 Gateway', gatewayOnline: true, problem: null,
      printer: { state: 'idle', reasons: ['sleep'], color: false, duplex: true, formats: ['image/urf', 'image/jpeg'], copiesMax: 99, markers: [] },
      scanner: null, seenAt: new Date().toISOString(), reportedAt: new Date().toISOString() },
  ];
}

/** A fake Drive: records what it gets; suggest_folder answers `drive.suggestion` (null = none). */
function fakeDrive() {
  const d = { calls: [], suggestion: { folderId: 42, areaId: 'mine:2', path: 'Finanzen/Strom', where: 'Finanzen › Strom', name: '2026-11-06 Stadtwerke Rechnung', confidence: 0.9, reason: 'ai' }, fail: null, received: [] };
  d.entry = {
    plugin: 'gatecontrol-drive',
    provides: ['list_areas', 'save_file', 'suggest_folder'],
    media: { maxBytes: 52428800, types: ['application/pdf', 'image/jpeg', 'image/png'], quotaDefault: '1GB' },
    service: async ({ name, user, payload }) => {
      d.calls.push({ name, user: user && user.id, payload });
      if (d.fail) return { ok: false, code: d.fail };
      if (name === 'list_areas') return { ok: true, areas: [{ id: 'mine:' + user.id, kind: 'mine', label: 'Meine Dateien', writable: true }] };
      if (name === 'suggest_folder') return { ok: true, suggestion: d.suggestion, sha256Exists: false };
      if (name === 'save_file') {
        const where = payload.folderId ? 'Finanzen › Strom › ' + payload.name : (payload.area === 'family' ? 'Familie › ' : 'Meine Dateien › ') + payload.path.replace('/', ' › ');
        return { ok: true, nodeId: 99, areaId: 'mine:' + user.id, path: payload.path || payload.name, name: payload.name, created: true, where };
      }
      return { ok: false, code: 'invalid' };
    },
  };
  return d;
}

async function setup(o = {}) {
  const drive = fakeDrive();
  const host = await createHost(DIR, {
    gatecontrol: '1.236.0',
    users: USERS,
    groups: [{ id: 1, name: 'Familie', kind: 'family', members: [{ userId: 2, role: 'parent' }, { userId: 3, role: 'parent' }, { userId: 4, role: 'child' }, { userId: 5, role: 'child' }] }],
    print: { devices: o.devices || devices() },
    services: o.noDrive ? [] : [drive.entry],
    ...(o.host || {}),
  });
  await host.start();
  const as = (user, portal = true) => ({ ...user, ...(portal ? { portal: true, loggedIn: true } : {}) });
  const req = async (user, method, p, body, { portal = true, lang = 'de' } = {}) => {
    const r = await host.request({ method, path: p, body: body || null, user: as(user, portal), lang });
    return { status: r.status || 200, ...r.json };
  };
  const adminReq = (method, p, body) => req(ADMIN, method, '/admin/' + p, body, { portal: false });
  return { host, drive, req, adminReq };
}

/** A fake PDF with n pages (the mock host counts "/Type /Page") */
const pdf = (n) => Buffer.from('%PDF-1.4\n' + Array.from({ length: n }, () => '<< /Type /Page >>').join('\n') + '\n%%EOF');

module.exports = { setup, devices, ADMIN, MARC, SABINE, LEA, TIM, USERS, HP, BRO, pdf };
