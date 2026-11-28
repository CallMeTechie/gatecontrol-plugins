'use strict';

// "Nur auf diesem Gerät" in the portal (1.32.0, ui/portal.js): a vault folder that lies only on a phone shows greyed with
// „Nur auf ‹Gerät›“ and explains itself instead of opening — the portal only shows it (the apps take a folder there).

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { t } = require('../server/text');
const VC = require('../ui/vaultcrypto');
const { withHost, ANNA } = require('./helpers');
const { createWindow } = require('./fake-dom');

const portalHtml = () => ui.render({ view: 'portal', lang: 'de', user: { id: ANNA.id, loggedIn: true } }, t);
const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);
/** A button of the menu (since 1.11.0): an area, a folder, a page — by its text, or an icon by its label. */
const navItem = (nav, label) => {
  const icon = nav.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === label);
  if (icon) return icon;
  let n = byText(nav, 'span', label);
  while (n && n.localName !== 'button') n = n.parentNode;
  return n || null;
};

const click = (root, text) => { let s = byText(root, 'span', text); assert.ok(s, `no button "${text}"`); while (s.localName !== 'button' && s.parentNode) s = s.parentNode; s.click(); };

/** window.GC of a portal frame against the mock host — with GC.keys (a browser's own store) and GC.mediaBytes. */
function frameGc(host, user, keys) {
  const viewer = { ...user, portal: true, loggedIn: true };
  return {
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async upload(file, o) {
      const data = file.data ? Buffer.from(file.data) : Buffer.from(await file.arrayBuffer());
      if (o && o.onProgress) o.onProgress({ loaded: data.length, total: data.length });
      const r = await host.upload(user, data, file.type || 'application/octet-stream');
      if (r.status !== 200) { const e = new Error('upload'); e.status = r.status; throw e; }
      return { mediaId: r.body.mediaId, mime: r.body.mime, bytes: r.body.bytes };
    },
    on() {},
    ...(keys ? {
      keys: {
        get: async (name) => (keys.has(name) ? keys.get(name) : null),
        put: async (name, k) => { assert.equal(k.privateKey.extractable, false, 'never an extractable private key'); keys.set(name, k); return true; },
        remove: async (name) => keys.delete(name),
      },
      async mediaBytes(url, o) {
        const r = host.mediaFromUrl(url, { range: `bytes=${o.start}-${o.end}` });
        const b = Buffer.from(r.body);
        return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length), start: o.start, end: o.end, total: 0 };
      },
      saveFile: async () => ({ ok: true }),
    } : {}),
  };
}


async function deviceOf() {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicRaw: raw, b64: VC.b64u(raw), id: await VC.deviceId(raw) };
}

test('portal (1.32.0): a folder "Nur auf Pixel 8" in an unlocked vault — greyed with the device\'s name, a click explains instead of opening', async () => {
  await withHost({ settings: { vault_local: true } }, async (host, c) => {
    const a = c.as(ANNA, 'phone-a');
    const mine = await c.area(ANNA, 'mine');
    const dev = await deviceOf();
    const id = VC.newVaultId();
    const tk = VC.newVaultKey();
    const rec = VC.newRecoveryKey();
    const rk = await VC.recoveryKeyPair(rec.key);
    const made = await a('POST', 'vaults', {
      id, parentId: mine.rootId, nameCipher: await VC.encryptName(tk, id, 1, 'Privat'), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key),
      recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1), device: { publicKey: dev.b64, name: 'Pixel 8', platform: 'android' }, wrap: await VC.wrapKey(tk, dev.publicRaw, id, 1),
    });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const top = made.json.node;
    const dir = async (name) => (await a('POST', 'nodes', { parentId: top.id, encrypted: true, nameCipher: await VC.encryptName(tk, id, 1, name), keyVersion: 1 })).json.node;
    const fotos = await dir('Fotoalbum');
    await dir('Briefe');
    // the browser's device: approved by the phone
    const web = await deviceOf();
    const keys = new Map([[`drive-device-${ANNA.id}`, { publicKey: web.publicKey, privateKey: web.privateKey }]]);
    assert.equal((await c.portal(ANNA)('POST', `vaults/${id}/devices`, { publicKey: web.b64, name: 'Browser' })).status, 200);
    assert.equal((await a('POST', `vaults/${id}/devices/${web.id}/approve`, { wrap: await VC.wrapKey(tk, web.publicRaw, id, 1) })).status, 200);
    // the phone takes "Fotoalbum" (the proof as the apps give it)
    const s = await a('POST', `vaults/${id}/local`, { nodeId: fotos.id, deviceId: dev.id });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    const ch = await a('POST', `vaults/${id}/local/challenge`, { deviceId: dev.id });
    const sealed = VC.unb64u(ch.json.challenge);
    const proof = VC.b64u(await VC.hpkeOpen(dev.privateKey, dev.publicRaw, new TextEncoder().encode(`gcdrive-v1:local-proof:${id}:${dev.id}`), new Uint8Array(0), sealed.subarray(1)));
    assert.equal((await a('POST', `vaults/${id}/local/${fotos.id}/commit`, { deviceId: dev.id, proof, manifest: [] })).status, 200);
    const w = createWindow(portalHtml(), frameGc(host, ANNA, keys));
    const $ = (x) => w.document.getElementById(x);
    try {
      w.run();
      await until('the app', () => !$('dp-app').hidden && textOf($('dp-nav')).includes('gesperrt'));
      navItem($('dp-nav'), 'Verschlüsselt').click();
      await until('unlock button', () => textOf($('dp-main')).includes('Tresor gesperrt'));
      click($('dp-main'), 'Entsperren');
      await until('the names', () => byText($('dp-main'), 'span', 'Fotoalbum') && byText($('dp-main'), 'span', 'Briefe'));
      assert.ok(textOf($('dp-main')).includes('Nur auf Pixel 8'), 'the badge with the device');
      const row = $('dp-main').querySelectorAll('[data-node]').find((r) => r.getAttribute('data-node') === String(fotos.id));
      assert.ok(row.className.includes('is-local'), 'greyed');
      const other = $('dp-main').querySelectorAll('[data-node]').find((r) => r.getAttribute('data-node') !== String(fotos.id));
      assert.ok(!other.className.includes('is-local'));
      // a click explains — the folder does not open
      click($('dp-main'), 'Fotoalbum');
      await until('the note', () => textOf($('dp-dialog')).includes('Nur auf einem Gerät'));
      assert.ok(textOf($('dp-dialog')).includes('nur auf Pixel 8'));
      assert.ok(textOf($('dp-dialog')).includes('Wieder auf dem Server speichern'));
      assert.equal(textOf($('dp-crumbs')).includes('Fotoalbum'), false, 'still in the vault\'s folder');
    } finally { w.stop(); }
  });
});
