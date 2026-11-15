'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js, GateControl 1.283.0 with gc.remote — tools/testing/mock-remote.js)
// with people, two groups and a home gateway.
//
//   ADMIN (admin) · MARC · SABINE · LEA · TIM — group "Büro" (Marc, Sabine), group "Familie" (Lea, Tim)

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'Admin', role: 'admin' };
const MARC = { id: 2, name: 'Marc', role: 'user' };
const SABINE = { id: 3, name: 'Sabine', role: 'user' };
const LEA = { id: 4, name: 'Lea', role: 'user' };
const TIM = { id: 5, name: 'Tim', role: 'user' };
const USERS = [ADMIN, MARC, SABINE, LEA, TIM];
const BUERO = 10;
const FAMILIE = 11;

async function setup(o = {}) {
  const host = await createHost(DIR, {
    gatecontrol: o.gatecontrol || '1.283.0',
    users: USERS,
    groups: [
      { id: BUERO, name: 'Büro', kind: 'team', members: [{ userId: 2, role: 'member' }, { userId: 3, role: 'member' }] },
      { id: FAMILIE, name: 'Familie', kind: 'family', members: [{ userId: 4, role: 'child' }, { userId: 5, role: 'child' }] },
    ],
    remote: { gateways: [{ peerId: 7, name: 'DS218 Gateway', online: true }], pools: [{ poolId: 3, name: 'Zuhause' }], ...(o.remote || {}) },
    ...(o.host || {}),
  });
  await host.start();
  const as = (user, portal = true) => ({ ...user, ...(portal ? { portal: true, loggedIn: true } : {}) });
  const req = async (user, method, p, body, { portal = true, lang = 'de', query } = {}) => {
    const r = await host.request({ method, path: p, body: body || null, user: as(user, portal), lang, ...(query ? { query } : {}) });
    return { status: r.status || 200, ...r.json };
  };
  const adminReq = (method, p, body, x) => req(ADMIN, method, '/admin/' + p, body, { portal: false, ...(x || {}) });
  return { host, req, adminReq };
}

/** A device as the admin page sends it. */
function rdpDevice(x = {}) {
  return { name: 'Büro-PC', protocol: 'rdp', config: { host: '10.8.0.44', port: 3389, browser_enabled: true, ...(x.config || {}) }, ...(x.top || {}) };
}

/** A snapshot of the dataset "remote" as GateControl hands it over (credentials as handles of the host's vault). */
function snapshot(host, x = {}) {
  const cred = host.remoteVaultSeed({ username: 'tom', password: 'geheim', domain: 'FIRMA', label: 'Büro-PC' }, 'rdp_route:3').handle;
  const route = (id, o) => ({
    id, name: 'Ziel ' + id, description: null, host: '10.8.0.' + (40 + id), port: 3389, protocol: 'rdp', external_hostname: null, external_port: null,
    access_mode: 'internal', gateway_host: null, gateway_port: null, gateway_peer_id: null, gateway_pool_id: null, gateway_listen_port: null, gateway_l4_route_id: null,
    enabled: true, credential_mode: 'full', domain: null, resolution_mode: 'fullscreen', resolution_width: null, resolution_height: null, multi_monitor: false,
    color_depth: 32, redirect_clipboard: true, redirect_printers: false, redirect_drives: false, redirect_usb: false, redirect_smartcard: false, audio_mode: 'local',
    network_profile: 'auto', nla_enabled: true, disable_wallpaper: false, disable_themes: false, disable_animations: false, bandwidth_limit: null,
    session_timeout: null, admin_session: false, remote_app: null, start_program: null, wol_enabled: false, wol_mac_address: null,
    maintenance_enabled: false, maintenance_schedule: null, sharing_enabled: false, sharing_mode: null, sharing_require_consent: false, screenshot_enabled: false,
    credential_rotation_enabled: false, credential_rotation_days: null, credential_rotation_last: null, user_ids: null, group_ids: null, token_ids: null, tags: [],
    notes: null, health_check_enabled: true, browser_enabled: false, browser_enable_sftp: false, sftp_host: null, sftp_port: null, sftp_username: null,
    sftp_disable_download: false, sftp_disable_upload: false, browser_enable_audio: false, audio_servername: null, browser_clipboard: false,
    rdp_disable_audio: false, created_at: '2026-01-05 10:00:00', updated_at: '2026-01-05 10:00:00', credential: null, sftp_credential: null, credential_unreadable: false, ...o,
  });
  return {
    schema: 1, dataset: 'remote', exportedAt: new Date().toISOString(),
    routes: x.routes || [
      route(3, { name: 'Büro-PC', credential: cred, user_ids: [2], group_ids: null, browser_enabled: true, tags: ['büro'] }),
      route(4, { name: 'NAS-Konsole', protocol: 'ssh', port: 22, host: '10.8.0.50', group_ids: [FAMILIE] }),
      route(5, { name: 'Heim-PC', access_mode: 'gateway', host: '192.168.1.20', gateway_peer_id: 7, gateway_listen_port: 13389, wol_enabled: true, wol_mac_address: 'AA:BB:CC:DD:EE:01' }),
      route(6, { name: 'Alt-Token', token_ids: [77], maintenance_enabled: true, maintenance_schedule: 'Mo-So 00:00-23:59' }),
    ],
    sessions: x.sessions || [
      { id: 41, route_id: 3, token_id: 77, token_name: 'Marc Laptop', peer_id: 12, status: 'ended', started_at: '2026-10-01 08:00:00', last_heartbeat: null,
        ended_at: '2026-10-01 09:00:00', duration_seconds: 3600, end_reason: 'normal', client_ip: '10.8.0.12', via: 'native', protocol: 'rdp' },
      { id: 42, route_id: 4, token_id: null, token_name: 'admin:1', peer_id: null, status: 'ended', started_at: '2026-10-02 10:00:00', last_heartbeat: null,
        ended_at: '2026-10-02 10:05:00', duration_seconds: 300, end_reason: 'normal', client_ip: null, via: 'browser', protocol: 'ssh' },
    ],
    maintenance: x.maintenance || [{ route_id: 6, enabled: true, schedule: 'Mo-So 00:00-23:59' }],
  };
}

module.exports = { setup, rdpDevice, snapshot, ADMIN, MARC, SABINE, LEA, TIM, USERS, BUERO, FAMILIE };
