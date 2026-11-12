'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js, GateControl 1.267.0 with gc.vpnDns —
// tools/testing/mock-vpn-dns.js) with people, the family as GateControl's group (Marc and Sabine are parents, Lea
// and Tim children), their VPN devices and a gateway.
//
//   ADMIN (admin) · MARC, SABINE (parents) · LEA, TIM (children) · GAST (nobody's family)

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'Anna', role: 'admin' };
const MARC = { id: 2, name: 'Marc', role: 'user' };
const SABINE = { id: 3, name: 'Sabine', role: 'user' };
const LEA = { id: 4, name: 'Lea', role: 'user' };
const TIM = { id: 5, name: 'Tim', role: 'user' };
const GAST = { id: 6, name: 'Gast', role: 'user' };
const BOSS = { id: 7, name: 'Chef', role: 'admin' };
const USERS = [ADMIN, MARC, SABINE, LEA, TIM, GAST, BOSS];
const FAMILY = { id: 1, name: 'Familie', kind: 'family', members: [{ userId: 2, role: 'parent' }, { userId: 3, role: 'parent' }, { userId: 4, role: 'child' }, { userId: 5, role: 'child' }] };
const BUERO = { id: 2, name: 'Büro', kind: 'team', members: [{ userId: 6, role: 'member' }] };

// peer ids
const P = { annaPhone: 12, annaLaptop: 13, marcPhone: 14, leaPhone: 21, timTablet: 22, officePc: 30, marcWork: 31, gateway: 2, guest: 40, boss: 50 };

function peers() {
  return [
    { id: P.annaPhone, name: 'Annas Handy', ip: '10.8.0.12', platform: 'android', userId: 1 },
    { id: P.annaLaptop, name: 'Annas Laptop', ip: '10.8.0.13', platform: 'windows', userId: 1 },
    { id: P.marcPhone, name: 'Marcs Handy', ip: '10.8.0.14', platform: 'android', userId: 2 },
    { id: P.leaPhone, name: 'Leas Handy', ip: '10.8.0.21', platform: 'android', userId: 4 },
    { id: P.timTablet, name: 'Tims Tablet', ip: '10.8.0.22', platform: 'android', userId: 5 },
    { id: P.officePc, name: 'Büro-PC', ip: '10.8.0.30', platform: 'windows', userId: 2, peerGroup: { id: 3, name: 'Büro-Geräte' } },
    { id: P.marcWork, name: 'Marcs Dienst-Laptop', ip: '10.8.0.31', platform: 'windows', userId: 2, dns: '1.1.1.1' },
    { id: P.gateway, name: 'Pi Keller', ip: '10.8.0.2', type: 'gateway' },
    { id: P.guest, name: 'Gast-Handy', ip: '10.8.0.40', platform: 'android', userId: 6 },
    { id: P.boss, name: 'Chef-Handy', ip: '10.8.0.50', platform: 'android', userId: 7 },
  ];
}

/** Settings with the profiles "Kinder" (Lea, Tim) and "Büro" (the office PC), the protection on. */
function settings(extra = {}) {
  return {
    enabled: true,
    allow: ['paypal.com', 'sparkasse.de'],
    deny: ['temu.com'],
    profiles: [
      { id: 'default', name: 'Standard', lists: ['ads', 'malware'] },
      { id: 'pkinder01', name: 'Kinder', lists: ['ads', 'malware', 'adult', 'gambling'], safeSearch: true, allow: ['anton.app'], deny: ['roblox.com'], users: [4, 5],
        schedules: [{ days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00', block: 'categories', categories: ['social', 'games', 'video'] }, { days: [6, 7], from: '22:00', to: '08:00', block: 'categories', categories: ['social', 'games'] }] },
      { id: 'pbuero001', name: 'Büro', lists: ['malware'], allow: ['login.microsoftonline.com'], peers: [P.officePc], groups: [2] },
    ],
    ...extra,
  };
}

async function setup(o = {}) {
  const host = await createHost(DIR, {
    gatecontrol: '1.267.0',
    users: USERS,
    groups: o.groups || [FAMILY, BUERO],
    vpnDns: { peers: peers(), settings: o.settings === undefined ? settings() : o.settings, today: { queries: 18432, blocked: 3127, cached: 5210, top: [{ domain: 'doubleclick.net', count: 412 }, { domain: 'googlesyndication.com', count: 388 }] }, ...(o.vpnDns || {}) },
    settings: o.config ? { 'dns.config': o.config } : {},
    ...(o.host || {}),
  });
  await host.start();
  /** an app request: the owner of the device token with the VPN peer of the device */
  const app = async (user, peerId, method, p, body, lang = 'de') => {
    const r = await host.request({ method, path: '/' + p, body: body || null, user: { ...user, portal: true, loggedIn: true, app: true, peerId: peerId == null ? null : peerId }, lang });
    return { http: r.status || 200, ...r.json };
  };
  /** a portal request (no device) */
  const portal = async (user, method, p, body, query) => {
    const r = await host.request({ method, path: '/' + p, body: body || null, query: query || {}, user: { ...user, portal: true, loggedIn: true } });
    return { http: r.status || 200, ...r.json };
  };
  /** the settings page */
  const admin = async (method, p, body, query, user = ADMIN) => {
    const r = await host.request({ method, path: '/admin/' + p, body: body || null, query: query || {}, user });
    return { http: r.status || 200, ...r.json };
  };
  const config = (patch) => admin('PUT', 'config', patch);
  return { host, app, portal, admin, config };
}

module.exports = { setup, settings, peers, P, ADMIN, MARC, SABINE, LEA, TIM, GAST, BOSS, USERS, FAMILY, BUERO, DIR };
