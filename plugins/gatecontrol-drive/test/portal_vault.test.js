'use strict';

// The portal's vault folders (1.9.0, ui/vault.js) in the fake DOM against the mock host: making a vault (the recovery
// key shown, the vault made once it is kept), a file encrypted in the browser (the server sees an opaque name and
// ciphertext only), a second browser that asks, the first approves after the safety number, the second reads the
// names — and a browser without GC.keys (an older GateControl) gets the note instead.

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
const click = (root, text) => { const s = byText(root, 'span', text); assert.ok(s, `no button "${text}"`); s.parentNode.click(); };

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

const file = (name, data, type) => ({ name, data, type, size: Buffer.byteLength(data), lastModified: Date.UTC(2026, 9, 20), slice: (a, b) => ({ arrayBuffer: async () => { const x = Buffer.from(data).subarray(a, b); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length); } }) });

test('portal: make a vault, upload into it, a second browser asks and is approved', async () => {
  await withHost({}, async (host, c) => {
    const keys1 = new Map();
    const w1 = createWindow(portalHtml(), frameGc(host, ANNA, keys1));
    const $ = (id) => w1.document.getElementById(id);
    try {
      w1.run();
      await until('the app', () => !$('dp-app').hidden && byText($('dp-tools'), 'span', 'Tresor-Ordner'));
      click($('dp-tools'), 'Tresor-Ordner');
      const input = await until('name field', () => $('dp-dialog').querySelector('input'));
      input.value = 'Steuer';
      click($('dp-dialog'), 'Weiter');
      // the recovery key: shown, then kept
      const keyText = await until('recovery key', () => $('dp-dialog').querySelectorAll('p').find((p) => p.className === 'dp-recovery'));
      const recovery = textOf(keyText);
      assert.match(recovery, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal((await c.as(ANNA)('GET', 'vaults')).json.vaults.length, 0, 'nothing made before the key is kept');
      const box = $('dp-dialog').querySelectorAll('input').find((i) => i.type === 'checkbox');
      box.checked = true;
      box.dispatchEvent({ type: 'change', target: box });
      click($('dp-dialog'), 'Weiter');
      await until('the vault in the list', () => byText($('dp-main'), 'span', 'Steuer'));
      const vaults = (await c.as(ANNA)('GET', 'vaults')).json.vaults;
      assert.equal(vaults.length, 1);
      assert.equal(keys1.size, 1, 'the device key is kept by GateControl\'s page');
      // into it, a file
      $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Steuer')).querySelector('.dp-open').click();
      await until('inside', () => textOf($('dp-crumbs')).includes('Steuer') && byText($('dp-tools'), 'span', 'Hochladen'));
      const fi = $('dp-file');
      fi.files = [file('Beleg Oktober.pdf', 'geheimer Inhalt %PDF', 'application/pdf')];
      fi.dispatchEvent({ type: 'change', target: fi });
      await until('the file', () => byText($('dp-main'), 'span', 'Beleg Oktober.pdf'));
      const items = (await c.as(ANNA)('GET', `nodes/${vaults[0].nodeId}/children`)).json.items;
      assert.equal(items.length, 1);
      assert.match(items[0].name, /^[0-9a-f]{32}$/);
      assert.equal(host.media.get(items[0].mediaId).data.includes(Buffer.from('geheimer')), false, 'ciphertext only');
      // the recovery key opens it (the format of README)
      const rk = await VC.recoveryKeyPair(VC.parseRecoveryKey(recovery));
      assert.equal(VC.b64u(rk.publicRaw), vaults[0].recoveryPub);

      // a second browser of Anna: the lock screen, it asks
      const keys2 = new Map();
      const w2 = createWindow(portalHtml(), frameGc(host, ANNA, keys2));
      const $2 = (id) => w2.document.getElementById(id);
      try {
        w2.run();
        await until('app 2', () => !$2('dp-app').hidden && byText($2('dp-main'), 'span', 'Verschlüsselt'));
        $2('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Verschlüsselt')).querySelector('.dp-open').click();
        await until('lock screen', () => textOf($2('dp-main')).includes('noch nicht freigeschaltet'));
        click($2('dp-main'), 'Freigabe anfragen');
        const num2 = await until('safety number', () => $2('dp-dialog').querySelectorAll('p').find((p) => p.className === 'dp-safety'));
        assert.match(textOf(num2), /^\d{5} \d{5} \d{5} \d{5}$/);
        // the first browser: the request, the same number, approve
        click($('dp-nav'), 'Meine Dateien');
        await until('back', () => byText($('dp-main'), 'span', 'Steuer'));
        $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Steuer')).querySelector('.dp-open').click();
        await until('banner', () => textOf($('dp-main')).includes('Ein Gerät möchte diesen Tresor öffnen.'));
        click($('dp-main'), 'Ansehen');
        const num1 = await until('number 1', () => $('dp-dialog').querySelectorAll('p').find((p) => p.className === 'dp-safety'));
        assert.equal(textOf(num1), textOf(num2), 'both show the same safety number');
        click($('dp-dialog'), 'Freigeben');
        await until('approved', () => textOf($('dp-toast')).includes('Freigegeben'));
        // the second browser reads the names now
        click($2('dp-dialog'), 'Schließen');
        await until('names in browser 2', () => byText($2('dp-main'), 'span', 'Beleg Oktober.pdf'));
      } finally { w2.stop(); }
    } finally { w1.stop(); }
  });
});

test('portal: without GC.keys (GateControl older than 1.211.0) a vault shows the note, nothing else', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const kp = await VC.generateDeviceKey();
    const raw = await VC.exportPublic(kp.publicKey);
    const id = VC.newVaultId();
    const tk = VC.newVaultKey();
    const rec = VC.newRecoveryKey();
    const rk = await VC.recoveryKeyPair(rec.key);
    const r = await c.as(ANNA)('POST', 'vaults', { id, parentId: mine.rootId, nameCipher: await VC.encryptName(tk, id, 1, 'App-Tresor'), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key),
      recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1), device: { publicKey: VC.b64u(raw) }, wrap: await VC.wrapKey(tk, raw, id, 1) });
    assert.equal(r.status, 200);
    const w = createWindow(portalHtml(), frameGc(host, ANNA, null));
    const $ = (x) => w.document.getElementById(x);
    try {
      w.run();
      await until('the app', () => !$('dp-app').hidden && byText($('dp-main'), 'span', 'Verschlüsselt'));
      $('dp-main').querySelectorAll('.dp-card').find((x) => textOf(x).includes('Verschlüsselt')).querySelector('.dp-open').click();
      await until('the note', () => textOf($('dp-main')).includes('Tresor-Ordner hier nicht verfügbar'));
      assert.equal(byText($('dp-tools'), 'span', 'Hochladen'), undefined, 'no upload into a vault it cannot open');
    } finally { w.stop(); }
  });
});
