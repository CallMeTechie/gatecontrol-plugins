'use strict';

// The admin API and page: connections (add / edit / test / delete), the
// token secret (stored as a plugin secret, never in an answer, the database
// or the log), administrators only, watched guests, the page in de/en.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const texts = require('../server/texts.json');
const store = require('../server/store');
const { withHost, asAdmin, addHost, ADMIN, ADA, TOKEN_ID, SECRET, DIR } = require('./helpers');

const NEW_SECRET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function dbDump(host) {
  const out = [];
  for (const t of ['hosts', 'watched_guests', 'snapshots', 'actions']) out.push(...(await host.gc.db.query(`SELECT * FROM ${t}`)).rows);
  return JSON.stringify(out);
}

test('add a connection: secret stored with setSecret, never returned; the page gets has_secret', async () => {
  await withHost({}, async (host) => {
    const r = await asAdmin(host, 'POST', '/hosts', { name: '  Homelab  ', target_index: 0, token_id: TOKEN_ID, token_secret: SECRET });
    assert.equal(r.status, 200);
    const h = r.json.host;
    assert.equal(h.name, 'Homelab');
    assert.equal(h.token_id, TOKEN_ID);
    assert.equal(h.has_secret, true);
    assert.equal(h.target_label, 'Proxmox (Route proxmox.home.example)');
    assert.ok(host.secrets.has(`host.${h.id}.secret`), 'stored as a plugin secret (encrypted by the host)');
    assert.equal(host.settings[`host.${h.id}.secret`], SECRET);
    await asAdmin(host, 'POST', `/hosts/${h.id}/refresh`);
    const all = [r, await asAdmin(host, 'GET', '/status'), await asAdmin(host, 'GET', '/targets'), await asAdmin(host, 'POST', `/hosts/${h.id}/refresh`)];
    assert.ok(!JSON.stringify(all).includes(SECRET), 'never in an answer');
    assert.ok(!JSON.stringify(host.logs).includes(SECRET), 'never in the log');
    assert.ok(!(await dbDump(host)).includes(SECRET), 'never in the database');
    const html = (await host.render({ view: 'page', user: ADMIN })).html;
    assert.ok(!html.includes(SECRET), 'never in the page');
  });
});

test('validation: name, assigned target, token id form, secret required on add', async () => {
  await withHost({}, async (host) => {
    const base = { name: 'X', target_index: 0, token_id: TOKEN_ID, token_secret: SECRET };
    const cases = [
      [{ name: '' }, 'NAME_REQUIRED'], [{ target_index: 3 }, 'TARGET_REQUIRED'], [{ target_index: null }, 'TARGET_REQUIRED'],
      [{ token_id: 'root@pam' }, 'TOKEN_ID_INVALID'], [{ token_id: 'root@pam!x y' }, 'TOKEN_ID_INVALID'],
      [{ token_secret: '' }, 'SECRET_INVALID'], [{ token_secret: 'short' }, 'SECRET_INVALID'], [{ enabled: 'yes' }, 'INVALID'],
    ];
    for (const [patch, code] of cases) {
      const r = await asAdmin(host, 'POST', '/hosts', { ...base, ...patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.equal(r.json.code, code, JSON.stringify(patch));
      assert.ok(r.json.error && !r.json.error.startsWith('error.'), 'a text, not a key');
    }
    assert.equal((await store.listHosts(host.gc)).length, 0);
  });
});

test('no target assigned: the page says so; adding is refused', async () => {
  await withHost({ targets: {} }, async (host) => {
    const st = (await asAdmin(host, 'GET', '/status')).json;
    assert.deepEqual(st.targets, []);
    const r = await asAdmin(host, 'POST', '/hosts', { name: 'X', target_index: 0, token_id: TOKEN_ID, token_secret: SECRET });
    assert.equal(r.json.code, 'TARGET_REQUIRED');
  });
});

test('edit: empty secret keeps the stored one, a new one replaces it; delete removes secret, data and state', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    await asAdmin(host, 'PUT', `/hosts/${id}/guests/100/watch`, { watched: true });
    let r = await asAdmin(host, 'PUT', `/hosts/${id}`, { name: 'Keller', token_secret: '' });
    assert.equal(r.json.host.name, 'Keller');
    assert.equal(host.settings[`host.${id}.secret`], SECRET);
    // a new token: Proxmox now expects it, the next poll is due at once
    fake.secret = NEW_SECRET;
    r = await asAdmin(host, 'PUT', `/hosts/${id}`, { token_secret: NEW_SECRET });
    assert.equal(host.settings[`host.${id}.secret`], NEW_SECRET);
    assert.equal((await store.getHost(host.gc, id)).next_poll_at, 0);
    const ref = await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
    assert.equal(ref.json.result.ok, true);
    assert.ok(!JSON.stringify(r.json).includes(NEW_SECRET));
    const d = await asAdmin(host, 'DELETE', `/hosts/${id}`);
    assert.equal(d.status, 200);
    assert.ok(!host.secrets.has(`host.${id}.secret`));
    assert.equal(host.settings[`host.${id}.secret`], undefined);
    assert.equal(await dbDump(host), '[]');
    assert.equal((await asAdmin(host, 'PUT', `/hosts/${id}`, { name: 'Y' })).status, 404);
  });
});

test('test connection: version, cluster and nodes — with the given or the stored secret; nothing stored', async () => {
  await withHost({}, async (host) => {
    const r = await asAdmin(host, 'POST', '/hosts/test', { target_index: 0, token_id: TOKEN_ID, token_secret: SECRET });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.result, { version: '8.2.4', release: '8.2', cluster: 'homelab', quorate: true, nodes: ['pve1', 'pve2'] });
    assert.equal((await store.listHosts(host.gc)).length, 0);
    const bad = await asAdmin(host, 'POST', '/hosts/test', { target_index: 0, token_id: TOKEN_ID, token_secret: NEW_SECRET });
    assert.equal(bad.status, 502);
    assert.equal(bad.json.code, 'PVE_AUTH');
    assert.match(bad.json.error, /API-Token abgelehnt/);
    const id = await addHost(host);
    const stored = await asAdmin(host, 'POST', '/hosts/test', { host_id: id, target_index: 0, token_id: TOKEN_ID });
    assert.equal(stored.json.result.version, '8.2.4');
    assert.ok(!JSON.stringify([r, bad, stored]).includes(SECRET));
  });
});

test('test connection: the self-signed certificate of a direct assignment is explained', async () => {
  await withHost({}, async (host, fake) => {
    fake.down = Object.assign(new Error('self-signed certificate'), { code: 'ERR_NET' });
    const r = await asAdmin(host, 'POST', '/hosts/test', { target_index: 0, token_id: TOKEN_ID, token_secret: SECRET }, 'en');
    assert.equal(r.json.code, 'PVE_TLS');
    assert.match(r.json.error, /Zertifikat nicht vertrauenswürdig.*Backend HTTPS/);
    const en = await host.request({ method: 'POST', path: '/hosts/test', body: { target_index: 0, token_id: TOKEN_ID, token_secret: SECRET }, user: ADMIN, lang: 'en' });
    assert.match(en.json.error, /Certificate not trusted/);
  });
});

test('watch toggle: boolean only, per connection, shown in the status', async () => {
  await withHost({}, async (host) => {
    const id = await addHost(host);
    assert.deepEqual((await asAdmin(host, 'PUT', `/hosts/${id}/guests/200/watch`, { watched: true })).json.watched, [200]);
    assert.deepEqual((await asAdmin(host, 'PUT', `/hosts/${id}/guests/100/watch`, { watched: true })).json.watched, [100, 200]);
    assert.deepEqual((await asAdmin(host, 'PUT', `/hosts/${id}/guests/100/watch`, { watched: false })).json.watched, [200]);
    assert.equal((await asAdmin(host, 'PUT', `/hosts/${id}/guests/100/watch`, { watched: 1 })).json.code, 'INVALID');
    assert.equal((await asAdmin(host, 'PUT', `/hosts/${id}/guests/abc/watch`, { watched: true })).status, 404);
    assert.equal((await asAdmin(host, 'PUT', `/hosts/77/guests/100/watch`, { watched: true })).status, 404);
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.hosts[0].watched, [200]);
  });
});

test('administrators only: every route refuses non-admins and portal viewers; nothing in the portal', async () => {
  await withHost({}, async (host, fake) => {
    const id = await addHost(host);
    fake.calls.length = 0;
    const routes = [['GET', '/status'], ['GET', '/targets'], ['POST', '/hosts'], ['POST', '/hosts/test'], ['PUT', `/hosts/${id}`], ['DELETE', `/hosts/${id}`],
      ['POST', `/hosts/${id}/refresh`], ['PUT', `/hosts/${id}/guests/100/watch`], ['POST', `/hosts/${id}/guests/100/action`], ['GET', '/actions/1'], ['GET', '/portal']];
    const viewers = [ADA, { ...ADA, portal: true, loggedIn: true }, { ...ADA, portal: true, loggedIn: false }, { ...ADMIN, portal: true, loggedIn: true }];
    for (const user of viewers) {
      for (const [method, p] of routes) {
        const r = await host.request({ method, path: p, body: { name: 'x', target_index: 0, token_id: TOKEN_ID, token_secret: SECRET, watched: true, action: 'start', confirm: true }, user });
        assert.equal(r.status, 403, `${method} ${p} as ${JSON.stringify(user)}`);
        assert.ok(!JSON.stringify(r.json).includes('homelab'));
      }
    }
    assert.equal(fake.calls.length, 0);
    assert.equal((await store.listHosts(host.gc)).length, 1);
    // the portal shows nothing; the own tab only carries the Start tile of an administrator's app
    assert.equal(await host.portalVisible(ADA), false);
    assert.equal(await host.portalVisible(ADMIN), false);
    assert.equal(await host.portalVisible({ ...ADA, loggedIn: true, app: true }), false);
    assert.equal(await host.portalVisible({ ...ADMIN, loggedIn: true, app: true }), true);
    assert.deepEqual(host.manifest.ui.portal.sections || [], [], 'no sections in the portal tabs');
    // the page itself: the admin page for administrators only
    for (const user of [ADA, { ...ADMIN, portal: true }]) {
      const html = (await host.render({ view: 'page', user })).html;
      assert.match(html, /nur für Administratoren/);
      assert.ok(!html.includes('PX_CTX'));
    }
  });
});

test('unknown routes → 404; errors are texts in the viewer language', async () => {
  await withHost({}, async (host) => {
    assert.equal((await asAdmin(host, 'GET', '/nope')).status, 404);
    assert.equal((await asAdmin(host, 'GET', '/')).status, 404);
    const en = await host.request({ method: 'GET', path: '/hosts/9', user: ADMIN, lang: 'en' });
    assert.equal(en.status, 404);
    const r = await host.request({ method: 'PUT', path: '/hosts/9', user: ADMIN, lang: 'en', body: {} });
    assert.equal(r.json.error, 'Not found.');
  });
});

test('page: tabs first, no own header, dialogs as fixed overlays; de and en', async () => {
  await withHost({}, async (host) => {
    const de = (await host.render({ view: 'page', user: ADMIN, lang: 'de' })).html;
    const en = (await host.render({ view: 'page', user: ADMIN, lang: 'en' })).html;
    assert.match(de, /<main class="px-page">\s*<div class="px-tabs"/, 'tabs first');
    assert.ok(!/<h1/.test(de), 'no own title (GateControl shows it)');
    assert.match(de, />Übersicht</);
    assert.match(de, />VMs &amp; Container</);
    assert.match(en, />Overview</);
    assert.match(en, />Storage &amp; backups</);
    assert.match(de, /\.modal-overlay\{position:fixed;inset:0/);
    assert.match(de, /html,body,\.px-page\{background:transparent\}/);
    assert.ok(!/\{\{t:/.test(de) && !/\{\{t:/.test(en), 'every placeholder filled');
    assert.ok(!/<\/script>[^<]*<\/script>/.test(de.replace(/<script>[\s\S]*?<\/script>/g, '')), 'scripts closed');
    const ctx = JSON.parse(/window\.PX_CTX=(\{.*?\});<\/script>/.exec(en)[1]);
    assert.equal(ctx.lang, 'en');
    assert.equal(ctx.texts['tab.overview'], 'Overview');
  });
});

test('texts: de and en have the same keys; every key the page and the server use exists', () => {
  const de = Object.keys(texts.de).sort();
  const en = Object.keys(texts.en).sort();
  assert.deepEqual(de, en);
  for (const l of ['de', 'en']) for (const [k, v] of Object.entries(texts[l])) assert.ok(typeof v === 'string' && v.trim(), `${l}.${k}`);
  const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
  const used = new Set();
  for (const m of read('ui/admin.html').matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) used.add(m[1]);
  for (const f of ['ui/admin.js', 'ui/common.js']) for (const m of read(f).matchAll(/\bT\('([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  for (const f of ['server/index.js', 'server/ui.js', 'server/quick.js']) for (const m of read(f).matchAll(/\bt\(lang, '([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  for (const m of read('server/index.js').matchAll(/'(error\.[A-Za-z_]+)'/g)) used.add(m[1]);
  // keys built at run time
  for (const a of ['start', 'shutdown', 'stop', 'reboot']) { used.add(`action.${a}`); used.add(`action.title_${a}`); used.add(`action.msg_${a}`); }
  for (const s of ['running', 'ok', 'error', 'timeout']) used.add(`action.status.${s}`);
  for (const k of ['qemu', 'lxc']) used.add(`kind.${k}`);
  for (const k of used) if (!/[._]$/.test(k)) assert.ok(texts.de[k] != null, `missing text ${k}`); // a prefix ('action.' + a) is not a key
  // placeholders match between the languages
  for (const k of de) {
    const ph = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(ph(texts.de[k]), ph(texts.en[k]), k);
  }
});

test('notification texts (alerts.js) de/en have the same keys and placeholders', () => {
  const { TEXTS } = require('../server/alerts');
  assert.deepEqual(Object.keys(TEXTS.de).sort(), Object.keys(TEXTS.en).sort());
  for (const k of Object.keys(TEXTS.de)) {
    const ph = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(ph(TEXTS.de[k]), ph(TEXTS.en[k]), k);
  }
});

test('manifest: licence required, admin page only, the home target pve (http, several), five topics', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  assert.equal(m.id, 'gatecontrol-proxmox');
  assert.equal(m.version, '1.1.0');
  assert.equal(m.license.required, true);
  assert.deepEqual(m.permissions.network.homeTargets.map((t) => [t.id, t.protocols, t.multiple]), [['pve', ['http'], true]]);
  assert.equal(m.permissions.network.internet, undefined, 'no internet access');
  assert.equal(m.permissions.portal, true, 'quick actions and the Start tile of the apps need it');
  assert.equal(m.gatecontrol, '>=1.154.0', 'newer quick-action fields are dropped by older hosts');
  assert.deepEqual(m.notifyTopics.map((t) => t.id), ['unreachable', 'guest_stopped', 'storage_full', 'backup_failed', 'node_load']);
  assert.ok(!m.ui.settings.some((s) => s.type === 'secret'), 'token secrets are per connection (setSecret), not a setting');
});
