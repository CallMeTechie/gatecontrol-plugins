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
const { withHost, ANNA, MIN } = require('./helpers');
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

// since 1.18.0 Drive opens on "Übersicht": "Dateien" in the switch at the top shows the files
async function toFiles($) {
  const b = await until('the switch', () => byText($('dp-pages'), 'button', 'Dateien'));
  b.click();
  await until('the files', () => byText($('dp-pages'), 'button', 'Dateien').getAttribute('aria-pressed') === 'true');
}
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

const file = (name, data, type) => ({ name, data, type, size: Buffer.byteLength(data), lastModified: Date.UTC(2026, 9, 20), slice: (a, b) => ({ arrayBuffer: async () => { const x = Buffer.from(data).subarray(a, b); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length); } }) });

test('portal: a vault from „Neu“ (who may open it), only in the menu, a file in it; a second browser asks, is approved and unlocks', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const sub = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Belege' })).json.node;
    const keys1 = new Map();
    const w1 = createWindow(portalHtml(), frameGc(host, ANNA, keys1));
    const $ = (id) => w1.document.getElementById(id);
    try {
      w1.run();
      // the menu: "Drive", me and my seat, my files open with their folders, the groups, no vault yet
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Belege'));
      const nav = textOf($('dp-nav'));
      for (const x of ['Drive', 'Anna', 'Familien-Platz', 'Persönlich', 'Gemeinsam', 'Tresore', 'Noch kein Tresor']) assert.ok(nav.includes(x), x);
      for (const label of ['Papierkorb', 'Speicher', 'Geräte', 'Geteilte Links', 'Drive-Einstellungen']) assert.ok(navItem($('dp-nav'), label), label);
      // "Neu" in a sub folder: the vault still goes into the top folder of the area chosen
      navItem($('dp-nav'), 'Belege').click();
      await until('in Belege', () => textOf($('dp-crumbs')).includes('Belege') && byText($('dp-tools'), 'span', 'Neu'));
      assert.ok($('dp-nav').querySelectorAll('.dp-tree-row').find((r) => r.className.includes('is-sel') && textOf(r).includes('Belege')), 'the folder shown is marked');
      click($('dp-tools'), 'Neu');
      click(await until('the menu', () => byText($('dp-dialog'), 'span', 'Neuer Tresor') && $('dp-dialog')), 'Neuer Tresor');
      const input = await until('name field', () => $('dp-dialog').querySelector('input'));
      const d = textOf($('dp-dialog'));
      for (const x of ['Wer darf ihn öffnen?', 'Nur ich', 'Mit der Familie teilen', 'im Menü unter „Tresore“']) assert.ok(d.includes(x), x);
      input.value = 'Steuer';
      const famRadio = $('dp-dialog').querySelectorAll('input').find((i) => i.type === 'radio' && i.getAttribute('value') === fam.id);
      famRadio.checked = true;
      famRadio.dispatchEvent({ type: 'change', target: famRadio });
      click($('dp-dialog'), 'Weiter');
      // the recovery key: shown, then kept
      const keyText = await until('recovery key', () => $('dp-dialog').querySelectorAll('p').find((p) => p.className === 'dp-recovery'));
      const recovery = textOf(keyText);
      assert.match(recovery, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal((await a('GET', 'vaults')).json.vaults.length, 0, 'nothing made before the key is kept');
      const box = $('dp-dialog').querySelectorAll('input').find((i) => i.type === 'checkbox');
      box.checked = true;
      box.dispatchEvent({ type: 'change', target: box });
      click($('dp-dialog'), 'Weiter');
      await until('the vault in the menu', () => navItem($('dp-nav'), 'Steuer'));
      assert.ok(textOf($('dp-nav')).includes('Mit Familie geteilt · offen'));
      const vaults = (await a('GET', 'vaults')).json.vaults;
      assert.equal(vaults.length, 1);
      assert.equal(vaults[0].areaId, fam.id);
      assert.equal(vaults[0].parentId, fam.rootId, 'in the top folder of the family');
      assert.equal(keys1.size, 1, 'the device key is kept by GateControl\'s page');
      // never among the files
      assert.deepEqual((await a('GET', `nodes/${fam.rootId}/children`)).json.items, []);
      assert.equal((await a('GET', `nodes/${fam.rootId}/children`, null, { vaults: 1 })).json.items.length, 1);
      navItem($('dp-nav'), 'Familie Berg').click();
      await until('the family', () => textOf($('dp-crumbs')).includes('Familie Berg') && textOf($('dp-main')).includes('leer'));
      // into it from the menu, a file
      navItem($('dp-nav'), 'Steuer').click();
      await until('inside', () => textOf($('dp-crumbs')).includes('Steuer') && byText($('dp-tools'), 'span', 'Hochladen'));
      const fi = $('dp-file');
      fi.files = [file('Beleg Oktober.pdf', 'geheimer Inhalt %PDF', 'application/pdf')];
      fi.dispatchEvent({ type: 'change', target: fi });
      await until('the file', () => byText($('dp-main'), 'span', 'Beleg Oktober.pdf'));
      const items = (await a('GET', `nodes/${vaults[0].nodeId}/children`)).json.items;
      assert.equal(items.length, 1);
      assert.match(items[0].name, /^[0-9a-f]{32}$/);
      assert.equal(host.media.get(items[0].mediaId).data.includes(Buffer.from('geheimer')), false, 'ciphertext only');
      // the recovery key opens it (the format of README)
      const rk = await VC.recoveryKeyPair(VC.parseRecoveryKey(recovery));
      assert.equal(VC.b64u(rk.publicRaw), vaults[0].recoveryPub);

      // a second browser of Anna: the vault in the menu (locked, no name), the lock screen, it asks
      const keys2 = new Map();
      const w2 = createWindow(portalHtml(), frameGc(host, ANNA, keys2));
      const $2 = (id) => w2.document.getElementById(id);
      try {
        w2.run();
        await until('app 2', () => !$2('dp-app').hidden && textOf($2('dp-nav')).includes('Mit Familie geteilt · gesperrt'));
        navItem($2('dp-nav'), 'Verschlüsselt').click();
        await until('lock screen', () => textOf($2('dp-main')).includes('noch nicht freigeschaltet'));
        click($2('dp-main'), 'Freigabe anfragen');
        const num2 = await until('safety number', () => $2('dp-dialog').querySelectorAll('p').find((p) => p.className === 'dp-safety'));
        assert.match(textOf(num2), /^\d{5} \d{5} \d{5} \d{5}$/);
        // the first browser: the request, the same number, approve
        navItem($('dp-nav'), 'Meine Dateien').click();
        await until('back', () => textOf($('dp-crumbs')).replace(/\s+/g, '') === 'MeineDateien');
        navItem($('dp-nav'), 'Steuer').click();
        await until('banner', () => textOf($('dp-main')).includes('Ein Gerät möchte diesen Tresor öffnen.'));
        click($('dp-main'), 'Ansehen');
        const num1 = await until('number 1', () => $('dp-dialog').querySelectorAll('p').find((p) => p.className === 'dp-safety'));
        assert.equal(textOf(num1), textOf(num2), 'both show the same safety number');
        click($('dp-dialog'), 'Freigeben');
        await until('approved', () => textOf($('dp-toast')).includes('Freigegeben'));
        // the second browser: approved — "Entsperren", then the names
        click($2('dp-dialog'), 'Schließen');
        await until('unlock button', () => textOf($2('dp-main')).includes('Tresor gesperrt'));
        click($2('dp-main'), 'Entsperren');
        await until('names in browser 2', () => byText($2('dp-main'), 'span', 'Beleg Oktober.pdf') && navItem($2('dp-nav'), 'Steuer'));
      } finally { w2.stop(); }
    } finally { w1.stop(); }
  });
});

test('portal: a vault locks after the minutes without use and when the tab is left — keys and names forgotten, "Entsperren" opens it again', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const keys = new Map();
    const w = createWindow(portalHtml(), frameGc(host, ANNA, keys));
    const $ = (id) => w.document.getElementById(id);
    try {
      w.run();
      await toFiles($);
      await until('the app', () => !$('dp-app').hidden && byText($('dp-tools'), 'span', 'Neu'));
      click($('dp-tools'), 'Neu');
      click(await until('the menu', () => byText($('dp-dialog'), 'span', 'Neuer Tresor') && $('dp-dialog')), 'Neuer Tresor');
      const input = await until('name field', () => $('dp-dialog').querySelector('input'));
      assert.ok(textOf($('dp-dialog')).includes('nach 3 Minuten ohne Nutzung'));
      input.value = 'Privat';
      click($('dp-dialog'), 'Weiter');
      const box = await until('kept box', () => $('dp-dialog').querySelectorAll('input').find((i) => i.type === 'checkbox'));
      box.checked = true;
      box.dispatchEvent({ type: 'change', target: box });
      click($('dp-dialog'), 'Weiter');
      await until('in the menu', () => navItem($('dp-nav'), 'Privat'));
      const v = (await c.as(ANNA)('GET', 'vaults')).json.vaults[0];
      assert.equal(v.parentId, mine.rootId);
      assert.ok(textOf($('dp-nav')).includes('Privat · offen'));
      navItem($('dp-nav'), 'Privat').click();
      await until('inside', () => textOf($('dp-crumbs')).includes('Privat'));
      // 2 minutes: still open; then 3 more without anything done: the next thing done finds it locked
      c.clock.add(2 * MIN);
      $('dp-main').click();
      assert.ok(textOf($('dp-crumbs')).includes('Privat'));
      c.clock.add(3 * MIN + 1000);
      $('dp-main').click();
      await until('locked', () => textOf($('dp-toast')).includes('Tresore gesperrt.') && !textOf($('dp-crumbs')).includes('Privat') && textOf($('dp-nav')).includes('Verschlüsselt'));
      assert.ok(textOf($('dp-nav')).includes('Privat · gesperrt'));
      assert.equal(navItem($('dp-nav'), 'Privat'), null, 'the decrypted name is forgotten');
      // "Entsperren" opens it again
      navItem($('dp-nav'), 'Verschlüsselt').click();
      await until('lock screen', () => textOf($('dp-main')).includes('Tresor gesperrt'));
      click($('dp-main'), 'Entsperren');
      await until('open again', () => textOf($('dp-crumbs')).includes('Privat') && navItem($('dp-nav'), 'Privat'));
      // the Drive settings: never by time — but leaving the tab locks it
      navItem($('dp-nav'), 'Drive-Einstellungen').click();
      await until('settings', () => textOf($('dp-main')).includes('Automatisch sperren'));
      const st = textOf($('dp-main'));
      for (const x of ['Sicherung', 'Ordner sichern', 'Tresore', 'Beim Verlassen des Tabs sperren', 'Beim Schließen des Tabs', 'Ansicht', 'Benachrichtigungen', 'Meine Benachrichtigungen']) assert.ok(st.includes(x), x);
      await until('approved for', () => textOf($('dp-main')).includes('Freigegeben für') && textOf($('dp-main')).includes('Privat') && /\d{5} \d{5} \d{5} \d{5}/.test(textOf($('dp-main'))));
      const sel = $('dp-main').querySelectorAll('select').find((x) => x.getAttribute('aria-label') === 'Automatisch sperren');
      sel.value = '0';
      sel.dispatchEvent({ type: 'change', target: sel });
      c.clock.add(60 * MIN);
      $('dp-main').click();
      assert.ok(textOf($('dp-main')).includes('Jetzt sperren'), 'still open');
      w.document.visibilityState = 'hidden';
      w.document.dispatchEvent({ type: 'visibilitychange' });
      await until('locked again', () => textOf($('dp-nav')).includes('Privat · gesperrt'));
      assert.equal(navItem($('dp-nav'), 'Privat'), null);
    } finally { w.stop(); }
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
      await until('the app', () => !$('dp-app').hidden && navItem($('dp-nav'), 'Verschlüsselt'));
      assert.equal(byText($('dp-main'), 'span', 'Verschlüsselt'), undefined, 'not among the files');
      navItem($('dp-nav'), 'Verschlüsselt').click();
      await until('the note', () => textOf($('dp-main')).includes('Tresor-Ordner hier nicht verfügbar'));
      assert.equal(byText($('dp-tools'), 'span', 'Hochladen'), undefined, 'no upload into a vault it cannot open');
    } finally { w.stop(); }
  });
});
