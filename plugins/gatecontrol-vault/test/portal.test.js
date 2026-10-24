'use strict';

// The portal tab "Vault" (1.1.0): what render() hands the frame (everything inline, nothing the frame CSP blocks,
// texts in de and en), plugin.json, and a smoke test of the real ui/portal.js in a small fake DOM against the mock
// host: set up (recovery key shown and saved before the account is sent), a new entry encrypted in the "browser",
// masked until revealed, copied, locked (keys and every decrypted value gone from the page), unlocked again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const texts = require('../server/texts.json');
const manifest = require('../plugin.json');
const { t } = require('../server/text');
const { withHost, ANNA, MARC, WALL, MIN } = require('./helpers');
const { createWindow } = require('./fake-dom');
const { loadUi } = require('./load-ui');

const UI = path.join(__dirname, '..', 'ui');
const ctxOf = (html) => JSON.parse(html.split('window.VA_CTX=')[1].split(';</script>')[0]);
const portalHtml = (o) => ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true }, ...o }, t);

test('render: the portal tab inlines styles, the context and noble → crypto → logic → portal; the admin page stays', () => {
  for (const lang of ['de', 'en']) {
    const html = portalHtml({ lang });
    assert.ok(!/\{\{t:/.test(html), 'all keys filled');
    assert.ok(!/<h1/i.test(html), 'GateControl shows the title');
    const ctx = ctxOf(html);
    assert.deepEqual([ctx.lang, ctx.view, ctx.loggedIn, ctx.viewer], [lang, 'portal', true, 2]);
    assert.equal(ctx.texts['p.lock_now'], texts[lang]['p.lock_now']);
    const order = ['var VaultNoble=', 'root.VaultCrypto = Object.freeze', 'root.VaultLogic = Object.freeze', "var CTX = window.VA_CTX || { texts: {}, lang: 'de' };"].map((s) => html.indexOf(s));
    assert.ok(order.every((i) => i > 0), 'all four scripts inline');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
    assert.equal((html.match(/<script>/g) || []).length, 5);
    assert.ok(!/<script[^>]*\bsrc=|<link\b|<iframe\b|@import|url\(\s*['"]?https?:/i.test(html), 'nothing loaded from elsewhere');
  }
  const de = portalHtml();
  assert.ok(de.includes('Entschlüsselt wird nur in diesem Browser-Tab. Er sperrt nach 5 Minuten ohne Eingabe und beim Schließen.'));
  assert.ok(de.includes('>Jetzt sperren</button>'));
  for (const id of ['vp-app', 'vp-nav', 'vp-rows', 'vp-detail', 'vp-q', 'vp-new', 'vp-lock-now', 'vp-login', 'vp-dialog', 'vp-file']) assert.ok(de.includes(`id="${id}"`), id);
  assert.equal(ctxOf(portalHtml({ user: { id: 2, loggedIn: false } })).loggedIn, false, 'device trust only: no Vault');
  assert.equal(ctxOf(portalHtml({ user: { id: 2, loggedIn: true, kiosk: true } })).loggedIn, false, 'never on a kiosk device');
  assert.equal(ctxOf(ui.render({ view: 'portal', loggedIn: true, user: { id: 2 } }, t)).loggedIn, true, 'view.loggedIn counts too');
  const admin = ui.render({ view: 'page', page: 'overview', lang: 'de' }, t);
  assert.ok(admin.includes('id="va-page"') && !admin.includes('VaultCrypto') && !admin.includes('VaultNoble'), 'the admin page has no crypto');
  assert.ok(Buffer.byteLength(de) < 1024 * 1024 * 0.6, `the page stays well below the host's 1 MB (${Buffer.byteLength(de)} bytes)`);
});

test('the frame\'s rules: no modals, no storage, no WebAssembly, no innerHTML, no blob: URLs, nothing in the console', () => {
  for (const f of ['portal.js', 'crypto.js', 'logic.js', 'portal.html', 'portal.css']) {
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/\b(alert|confirm|prompt|print)\(/.test(src.replace(/window\.GC\./g, '')), `${f}: sandboxed frames have no modals`);
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/.test(src), `${f}: text only through textContent / attributes`);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), `${f}: the frame has no storage (and keys never go there)`);
    assert.ok(!/WebAssembly\.|createObjectURL|\beval\(|new Function/.test(src), `${f}: CSP`);
    assert.ok(!/\bconsole\.\w+\(/.test(src), `${f}: nothing in the console`);
    assert.ok(!/https?:\/\/[\w.-]/.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `${f}: no external URL`);
  }
  const noble = fs.readFileSync(path.join(UI, 'vendor', 'noble.js'), 'utf8');
  assert.ok(noble.startsWith('/*! ui/vendor/noble.js'), 'the licence notice first');
  assert.match(noble, /@noble\/hashes 1\.8\.0, @noble\/ciphers 1\.3\.0, @noble\/curves 1\.9\.7/);
  assert.match(noble, /Permission is hereby granted/);
  assert.ok(!/WebAssembly|\beval\(|new Function|<\/script|<!--/i.test(noble.slice(noble.indexOf('*/'))), 'pure JS, inlinable');
});

test('texts: every key the portal uses exists in de and en (with .one/.other for counts); same keys in both', () => {
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  for (const l of ['de', 'en']) for (const [k, v] of Object.entries(texts[l])) assert.ok(typeof v === 'string' && v.trim(), `${l}: ${k} empty`);
  const src = fs.readFileSync(path.join(UI, 'portal.js'), 'utf8') + fs.readFileSync(path.join(UI, 'logic.js'), 'utf8');
  const html = fs.readFileSync(path.join(UI, 'portal.html'), 'utf8');
  const plain = new Set();
  const plural = new Set();
  for (const m of src.matchAll(/\bT\('([a-z0-9_.]+)'/gi)) plain.add(m[1]);
  for (const m of src.matchAll(/\bP\('([a-z0-9_.]+)'/gi)) plural.add(m[1]);
  for (const m of html.matchAll(/\{\{t:([a-z0-9_.-]+)\}\}/g)) plain.add(m[1]);
  for (const m of src.matchAll(/return '([a-z_]+\.[a-z_]+)';/g)) plain.add(m[1]); // draftError
  const dyn = [
    ...['login', 'totp', 'note', 'card', 'wifi', 'identity'].flatMap((x) => ['type.' + x, 'new.' + x]),
    ...['username', 'password', 'totp', 'holder', 'number', 'expiry', 'cvc', 'pin', 'ssid', 'security', 'name', 'email', 'phone', 'address', 'birthday'].map((x) => 'field.' + x),
    ...['read', 'write', 'manage'].flatMap((x) => ['role.' + x, 'roleHint.' + x]),
    ...['ready', 'requested', 'granted'].map((x) => 'em.status.' + x),
    ...['weak', 'fair', 'strong', 'very_strong'].map((x) => 'strength.' + x),
    ...['pw_rule', 'pw_mismatch', 'pw_match'].map((x) => 'setup.' + x),
    ...['favorites', 'all', 'trash'].map((x) => 'p.section_' + x),
    ...['invalid', 'login_required', 'forbidden', 'no_account', 'not_found', 'exists', 'conflict', 'stale_key', 'rekeying', 'last_manager', 'limit',
      'rate_limited', 'internal', 'network', 'timeout', 'not_running', 'plugin_error', 'invalid_answer', 'too_large', 'read_only', 'locked',
      'wrong_password', 'recovery_key', 'decrypt', 'failed', 'empty'].map((c) => 'err.' + c),
  ];
  for (const k of [...plain, ...dyn]) {
    if (k.endsWith('.') || k.endsWith('_')) continue;
    for (const l of ['de', 'en']) assert.ok(texts[l][k], `${l}: ${k}`);
  }
  for (const k of [...plural, 'em.hours', 'em.days']) for (const l of ['de', 'en']) for (const f of ['one', 'other']) assert.ok(texts[l][`${k}.${f}`], `${l}: ${k}.${f}`);
  assert.ok(texts.de['p.session_note'].includes('5 Minuten'));
});

test('plugin.json 1.1.0: the portal tab "Vault"; GateControl 1.193.0 still enough; portalVisible hides it on a kiosk device', async () => {
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.gatecontrol, '>=1.193.0', 'GC.saveFile is 1.186.0, the rest was already needed');
  assert.deepEqual(manifest.ui.portal, { label: { de: 'Vault', en: 'Vault' }, icon: manifest.ui.nav.icon });
  assert.equal(manifest.permissions.portal, true);
  assert.deepEqual(manifest.ui.pages.map((p) => p.id), ['overview']);
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## 1\.1\.0$/m);
  await withHost({}, async (host) => {
    assert.equal(await host.portalVisible({ ...ANNA, loggedIn: true }), true);
    assert.equal(await host.portalVisible({ ...WALL, loggedIn: true, kiosk: true }), false);
    const r = await host.render({ view: 'portal', user: { ...ANNA, portal: true, loggedIn: true } });
    assert.ok(r.html.includes('VaultCrypto'));
  });
});

// ── smoke test in a fake DOM ─────────────────────────────────

const tick = () => new Promise((r) => setImmediate(r));
/** Polls fn() until it is truthy (by rounds: the mock host's clock — Date — stands still). */
async function until(what, fn, ms = 30000) {
  for (let i = 0; i * 15 < ms; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for ' + what);
}

/** A frame with the bridge of plugin-bridge.js in front of the mock host (viewer = a signed-in portal user). */
function frame(host, user, lang = 'de') {
  const calls = [];
  const saved = [];
  const gc = {
    call(method, p, body) {
      calls.push({ method, path: p, body });
      const [pathPart, q] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(q || ''));
      const wire = body === undefined || body === null ? null : JSON.parse(JSON.stringify(body));
      return host.request({ method, path: pathPart, query, body: wire, user: { ...user, portal: true, loggedIn: true }, lang }).then((r) => {
        const data = JSON.parse(JSON.stringify(r.json));
        if (r.status >= 200 && r.status < 300) return data;
        throw Object.assign(new Error(data.error || 'HTTP ' + r.status), { status: r.status, data });
      });
    },
    saveFile(blob, name) { return blob.text().then((text) => { saved.push({ name, type: blob.type, text }); return { ok: true, name }; }); },
  };
  return { gc, calls, saved };
}

const text = (el) => (el ? el.textContent : '');
const byText = (doc, tag, label) => doc.body.all().find((e) => e.localName === tag && e.textContent.trim() === label && !e.disabled);
function type(el, value) { el.value = value; el.dispatchEvent({ type: 'input' }); }

test('smoke: the real portal.js — set up, add a login, reveal, copy, lock (nothing left), unlock', async () => {
  await withHost({}, async (host) => {
    const html = (await host.render({ view: 'portal', lang: 'de', user: { ...ANNA, portal: true, loggedIn: true } })).html;
    const f = frame(host, ANNA);
    const w = createWindow(html, f.gc);
    const doc = w.document;
    try {
      // Argon2id at 64 MiB runs ~20× slower inside a vm context (global lookups) than in a browser or in Node's own
      // realm: the frame's VaultNoble gets the same library's argon2idAsync from this realm (the vectors check it)
      const { N } = loadUi();
      w.run((i, win) => {
        if (i === 1 && win.VaultNoble) win.VaultNoble = Object.freeze({ ...win.VaultNoble, argon2idAsync: N.argon2idAsync });
      });
      // not set up yet → the intro
      const start = await until('intro', () => byText(doc, 'button', 'Vault einrichten'));
      start.click();
      const pws = doc.getElementById('vp-screen').querySelectorAll('input').filter((i) => i.type === 'password');
      assert.equal(pws.length, 2);
      const PW = 'Sonnenblume-Kanu-Turm-47';
      type(pws[0], PW);
      type(pws[1], PW);
      byText(doc, 'button', 'Weiter').click();
      // the recovery key, before anything is sent
      const rk = await until('recovery key', () => doc.querySelector('.vp-rk'));
      const key = rk.childNodes.map((s) => s.textContent).join('-');
      assert.match(key, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.ok(!f.calls.some((c) => c.method === 'POST' && c.path === 'account'), 'nothing sent before the key was kept');
      byText(doc, 'button', 'Als Textdatei speichern').click();
      await until('file saved', () => f.saved.length);
      assert.deepEqual([f.saved[0].name, f.saved[0].type], ['Vault-Wiederherstellungsschlüssel.txt', 'text/plain']);
      assert.ok(f.saved[0].text.includes(key));
      byText(doc, 'button', 'Kopieren').click();
      assert.equal(doc.copied.pop(), key);
      const finish = doc.body.all().find((e) => e.localName === 'button' && e.textContent === 'Vault einrichten');
      assert.ok(finish.disabled, 'only after "Ich habe ihn sicher aufbewahrt"');
      const kept = doc.getElementById('vp-screen').querySelectorAll('input').find((i) => i.type === 'checkbox');
      kept.checked = true;
      kept.dispatchEvent({ type: 'change' });
      finish.click();
      // open: the personal vault
      await until('app', () => !doc.getElementById('vp-app').hidden && text(doc.getElementById('vp-nav')).includes('Persönlich'));
      const account = (await host.request({ method: 'GET', path: 'account', user: { ...ANNA, portal: true, loggedIn: true } })).json.account;
      assert.deepEqual([account.kdf.m, account.kdf.t], [65536, 3], 'the apps\' Argon2id parameters');
      // a new login
      doc.getElementById('vp-new').click();
      doc.querySelectorAll('.vp-type').find((b) => b.lastChild.textContent === 'Login').click();
      const detail = doc.getElementById('vp-detail');
      const inputs = detail.querySelectorAll('input');
      type(inputs.find((i) => i.type === 'text'), 'Stadtwerke');
      const pwField = inputs.find((i) => i.type === 'password');
      const userField = inputs[inputs.indexOf(pwField) - 1];
      type(userField, 'anna@example.org');
      const SECRET = 'Kw7!pQ2#zL9$mR4x';
      type(pwField, SECRET);
      byText(doc, 'button', 'Speichern').click();
      await until('saved', () => text(doc.getElementById('vp-toast')) === 'Gespeichert.');
      const sync = (await host.request({ method: 'GET', path: 'sync', query: { since: 0 }, user: { ...ANNA, portal: true, loggedIn: true } })).json;
      assert.equal(sync.items.length, 1);
      assert.equal(sync.items[0].rev, 1);
      assert.ok(!JSON.stringify(sync).includes(SECRET) && !JSON.stringify(sync).includes('Stadtwerke'), 'the server stores only ciphertext');
      const post = f.calls.find((c) => c.method === 'POST' && c.path === 'items');
      assert.equal(post.body.device, 'Portal');
      // the detail: masked until revealed; copy
      assert.ok(text(doc.getElementById('vp-rows')).includes('Stadtwerke'));
      assert.ok(text(detail).includes('anna@example.org'));
      assert.ok(!text(detail).includes(SECRET), 'masked');
      detail.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Anzeigen').click();
      assert.ok(text(detail).includes(SECRET), 'revealed');
      byText(doc, 'button', 'Passwort kopieren').click();
      assert.equal(doc.copied.pop(), SECRET);
      assert.equal(text(doc.getElementById('vp-toast')), 'Passwort kopiert');
      // lock: no key, no decrypted value, no DOM showing them
      doc.getElementById('vp-lock-now').click();
      assert.ok(doc.getElementById('vp-app').hidden);
      const all = text(doc.body);
      assert.ok(!all.includes(SECRET) && !all.includes('Stadtwerke') && !all.includes('anna@example.org'), 'nothing decrypted left on the page');
      assert.ok(all.includes('Vault ist gesperrt'));
      // unlock again: everything comes from the server and is decrypted here
      const pw = doc.getElementById('vp-screen').querySelector('input');
      type(pw, 'falsch-falsch-falsch');
      byText(doc, 'button', 'Entsperren').click();
      await until('wrong password', () => text(doc.getElementById('vp-screen')).includes('Falsches Hauptpasswort.'));
      type(pw, PW);
      byText(doc, 'button', 'Entsperren').click();
      await until('unlocked', () => text(doc.getElementById('vp-rows')).includes('Stadtwerke'));
      assert.equal(pw.value, '', 'the typed password does not stay in the field');
      // forgot the password: the recovery key → a new password and a new recovery key
      doc.getElementById('vp-lock-now').click();
      byText(doc, 'button', 'Passwort vergessen?').click();
      const rkIn = doc.getElementById('vp-screen').querySelector('textarea');
      type(rkIn, key.slice(0, 20));
      byText(doc, 'button', 'Weiter').click();
      assert.ok(text(doc.getElementById('vp-screen')).includes('56 Zeichen'), 'an incomplete key is caught before anything');
      type(rkIn, key.toLowerCase().replace(/-/g, ' '));
      byText(doc, 'button', 'Weiter').click();
      const npw = doc.getElementById('vp-screen').querySelectorAll('input').filter((i) => i.type === 'password');
      const PW2 = 'Wolke-Fahrrad-Leuchtturm-92';
      type(npw[0], PW2);
      type(npw[1], PW2);
      byText(doc, 'button', 'Speichern').click();
      const rk2 = await until('new recovery key', () => doc.querySelector('.vp-rk'));
      const key2 = rk2.childNodes.map((x) => x.textContent).join('-');
      assert.notEqual(key2, key);
      const acc2 = (await host.request({ method: 'GET', path: 'account', user: { ...ANNA, portal: true, loggedIn: true } })).json.account;
      assert.equal(acc2.rev, 2);
      const { VC } = loadUi();
      assert.ok((await VC.unlock(acc2, PW2)).userKey.length === 32, 'the new password opens it');
      assert.throws(() => VC.unlockWithRecovery(acc2, key), (e) => e.code === 'decrypt', 'the old recovery key is spent');
      const kept2 = doc.getElementById('vp-screen').querySelectorAll('input').find((i) => i.type === 'checkbox');
      kept2.checked = true;
      kept2.dispatchEvent({ type: 'change' });
      byText(doc, 'button', 'Fertig').click();
      await until('open after recovery', () => text(doc.getElementById('vp-rows')).includes('Stadtwerke'));
    } finally {
      w.stop();
      await tick();
    }
  });
});

/** The portal tab of `user`, set up through the page and open → { w, doc, f, PW, stop } */
async function openPortal(host, user) {
  const html = (await host.render({ view: 'portal', lang: 'de', user: { ...user, portal: true, loggedIn: true } })).html;
  const f = frame(host, user);
  const w = createWindow(html, f.gc);
  const doc = w.document;
  const { N } = loadUi();
  w.run((i, win) => { if (i === 1 && win.VaultNoble) win.VaultNoble = Object.freeze({ ...win.VaultNoble, argon2idAsync: N.argon2idAsync }); });
  (await until('intro', () => byText(doc, 'button', 'Vault einrichten'))).click();
  const PW = 'Sonnenblume-Kanu-Turm-47';
  doc.getElementById('vp-screen').querySelectorAll('input').filter((i) => i.type === 'password').forEach((i) => type(i, PW));
  byText(doc, 'button', 'Weiter').click();
  await until('recovery key', () => doc.querySelector('.vp-rk'));
  const kept = doc.getElementById('vp-screen').querySelectorAll('input').find((i) => i.type === 'checkbox');
  kept.checked = true;
  kept.dispatchEvent({ type: 'change' });
  doc.body.all().find((e) => e.localName === 'button' && e.textContent === 'Vault einrichten').click();
  await until('app', () => !doc.getElementById('vp-app').hidden && text(doc.getElementById('vp-nav')).includes('Persönlich'));
  return { w, doc, f, PW };
}

const navTo = (doc, label) => doc.getElementById('vp-nav').querySelectorAll('button').find((b) => b.textContent.startsWith(label)).click();
const toastIs = (doc, s) => () => text(doc.getElementById('vp-toast')) === s;

/** A new entry through "Neu": fills the form's inputs in order (by label) and saves. */
async function newEntry(doc, kind, values) {
  doc.getElementById('vp-new').click();
  doc.querySelectorAll('.vp-type').find((b) => b.lastChild.textContent === kind).click();
  const detail = doc.getElementById('vp-detail');
  for (const [label, value] of Object.entries(values)) {
    const field = detail.querySelectorAll('.vp-field').find((x) => x.firstChild && x.firstChild.textContent === label);
    assert.ok(field, 'field ' + label);
    const input = field.querySelectorAll('input,textarea,select')[0];
    if (input.localName === 'select') { input.value = value; input.dispatchEvent({ type: 'change' }); } else type(input, value);
  }
  byText(doc, 'button', 'Speichern').click();
  await until('saved ' + kind, toastIs(doc, 'Gespeichert.'));
  doc.getElementById('vp-toast').textContent = '';
}

test('smoke: sharing (safety number first), a save during a key change, a conflict, emergency access, import / export, history, trash, a new master password', async () => {
  await withHost({}, async (host, c) => {
    // Marc has Vault (set up in his app): he can be added and named as a trusted person
    await c.setup({ id: 3, name: 'Marc', role: 'user' });
    const { w, doc, f, PW } = await openPortal(host, ANNA);
    const detail = doc.getElementById('vp-detail');
    const anna = { ...ANNA, portal: true, loggedIn: true };
    try {
      // a shared vault "Familie" and Marc as a member — only after comparing his safety number
      navTo(doc, 'Tresore & Teilen');
      type(detail.querySelector('input'), 'Familie');
      byText(doc, 'button', 'Anlegen').click();
      await until('vault', () => text(detail).includes('Mitglieder · 1'));
      (await until('people', () => detail.querySelectorAll('.vp-vrow').find((b) => b.textContent.includes('Marc')))).click();
      assert.match(text(detail.querySelector('.vp-safety')), /^(\d{5} ){7}\d{5}$/);
      const add = byText(doc, 'button', 'Hinzufügen') || detail.querySelectorAll('button').find((b) => b.textContent === 'Hinzufügen');
      assert.ok(add.disabled, 'not before the numbers were compared');
      const cmp = detail.querySelectorAll('input').find((i) => i.type === 'checkbox');
      cmp.checked = true;
      cmp.dispatchEvent({ type: 'change' });
      add.click();
      await until('member added', () => text(detail).includes('Mitglieder · 2'));
      const sync0 = (await host.request({ method: 'GET', path: 'sync', query: { since: 0 }, user: anna })).json;
      const fam = sync0.vaults.find((v) => v.kind === 'shared');
      assert.deepEqual(fam.members.map((m) => [m.name, m.role]).sort(), [['Anna', 'manage'], ['Marc', 'write']]);
      // a Wi-Fi entry into "Familie"
      navTo(doc, 'Familie');
      await newEntry(doc, 'WLAN', { Titel: 'WLAN Zuhause', Netzwerk: 'Backes-5G', Passwort: 'Korrekt-Pferd', Sicherheit: 'WPA2' });
      assert.ok(text(doc.getElementById('vp-rows')).includes('WLAN Zuhause'));
      byText(doc, 'button', 'QR-Code zeigen').click();
      assert.ok(detail.querySelector('svg[role]') || detail.querySelectorAll('svg').some((s) => s.getAttribute('role') === 'img'), 'the QR code');
      assert.ok(text(detail).includes('Gäste scannen zum Verbinden'));
      // another app starts a key change of "Familie": the portal still has the old key → stale_key → sync → the new one
      const { VC } = loadUi();
      const newKey = VC.newVaultKey();
      const annaPk = sync0.account.publicKey;
      const marcPk = (await host.request({ method: 'GET', path: 'people', user: anna })).json.people.find((p) => p.name === 'Marc').publicKey;
      const started = await host.request({ method: 'POST', path: `vaults/${fam.id}/rekey/start`, user: anna, body: { keyRev: 2, keys: [{ userId: 2, sealedKey: VC.sealKey(newKey, annaPk) }, { userId: 3, sealedKey: VC.sealKey(newKey, marcPk) }] } });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      await newEntry(doc, 'Notiz', { Titel: 'Alarmanlage', Notiz: 'Code 4711' });
      const saves = f.calls.filter((x) => x.method === 'POST' && x.path === 'items').slice(-2);
      assert.deepEqual(saves.map((x) => x.body.items[0].keyRev), [1, 2], 'refused on the old key, sent again with the new one');
      const note = (await host.request({ method: 'GET', path: 'sync', query: { since: 0 }, user: anna })).json.items.find((i) => i.vaultId === fam.id && i.keyRev === 2);
      assert.ok(note, 'stored under the new key generation');
      assert.ok(VC.decryptItem(newKey, note).notes === 'Code 4711', 'readable with the pending key');
      // a conflict: someone else saved the note meanwhile
      const other = VC.encryptItem(newKey, { vaultId: fam.id, itemId: note.id, rev: 2 }, { v: 1, type: 'note', title: 'Alarmanlage', notes: 'Code 0815' });
      const r = await host.request({ method: 'POST', path: 'items', user: anna, body: { items: [{ id: note.id, vaultId: fam.id, blob: other, keyRev: 2, baseRev: 1 }] } });
      assert.equal(r.json.results[0].ok, true);
      byText(doc, 'button', 'Bearbeiten').click();
      const area = detail.querySelectorAll('textarea')[0];
      type(area, 'Code 1234');
      byText(doc, 'button', 'Speichern').click();
      await until('conflict', () => text(detail).includes('inzwischen auf einem anderen Gerät geändert'));
      byText(doc, 'button', 'Als Kopie speichern').click();
      await until('copy saved', toastIs(doc, 'Gespeichert.'));
      assert.ok(text(doc.getElementById('vp-rows')).includes('Alarmanlage (Konflikt)'));
      // history of the note: the earlier version can be restored
      doc.getElementById('vp-rows').querySelectorAll('button').find((b) => b.textContent.includes('Alarmanlage') && !b.textContent.includes('Konflikt')).click();
      await until('detail', () => text(detail).includes('Code 0815'));
      detail.querySelectorAll('button').find((b) => b.textContent === 'Verlauf ansehen').click();
      await until('history', () => text(detail).includes('Fassung 1'));
      detail.querySelectorAll('button').find((b) => b.textContent === 'Diese Fassung wiederherstellen').click();
      await until('restored', toastIs(doc, 'Fassung wiederhergestellt.'));
      assert.ok(text(detail).includes('Code 4711') && !text(detail).includes('Fassung 1'), 'back on the entry, the old text');
      // trash and back
      detail.querySelectorAll('button').find((b) => b.textContent === 'In den Papierkorb').click();
      await until('trashed', () => !text(doc.getElementById('vp-rows')).includes('Alarmanlage\n') && text(doc.getElementById('vp-toast')).includes('Papierkorb'));
      navTo(doc, 'Papierkorb');
      await until('trash list', () => text(doc.getElementById('vp-rows')).includes('Alarmanlage'));
      doc.getElementById('vp-rows').querySelectorAll('button')[0].click();
      byText(doc, 'button', 'Wiederherstellen').click();
      await until('restored from trash', toastIs(doc, 'Wiederhergestellt.'));
      // emergency access: Marc as a trusted person, after the safety number
      navTo(doc, 'Notfallzugriff');
      (await until('people', () => detail.querySelectorAll('.vp-vrow').find((b) => b.textContent.includes('Marc')))).click();
      const cmp2 = detail.querySelectorAll('input').find((i) => i.type === 'checkbox');
      cmp2.checked = true;
      cmp2.dispatchEvent({ type: 'change' });
      detail.querySelectorAll('button').find((b) => b.textContent === 'Hinzufügen').click();
      await until('trusted', () => text(detail).includes('Wartezeit 2 Tage'));
      const em = (await host.request({ method: 'GET', path: 'emergency', user: anna })).json;
      assert.deepEqual([em.granted.length, em.granted[0].grantee.name, em.granted[0].waitHours], [1, 'Marc', 48]);
      // import: a Chrome CSV into "Persönlich", the duplicate skipped
      navTo(doc, 'Importieren / Exportieren');
      const input = doc.getElementById('vp-file');
      byText(doc, 'button', 'Datei wählen').click();
      const csv = 'name,url,username,password,note\nBahn.de,https://bahn.de,marc,pw1,\nBahn.de,https://bahn.de,marc,pw1,\nKita,https://kita.de,anna,pw2,\n';
      input.files = [{ size: csv.length, text: async () => csv }];
      input.onchange();
      await until('preview', () => text(detail).includes('3 Einträge erkannt'));
      assert.ok(text(detail).includes('1 Eintrag gibt es schon'));
      byText(doc, 'button', '2 Einträge importieren').click();
      await until('imported', () => text(doc.getElementById('vp-toast')).startsWith('2 Einträge importiert.'));
      // export: only after the warning, the box and the master password
      byText(doc, 'button', 'Weiter zum Export').click();
      const pwIn = detail.querySelectorAll('input').find((i) => i.type === 'password');
      type(pwIn, PW);
      const ok = detail.querySelectorAll('input').filter((i) => i.type === 'checkbox').pop();
      ok.checked = true;
      ok.dispatchEvent({ type: 'change' });
      byText(doc, 'button', 'Als CSV exportieren').click();
      await until('exported', () => f.saved.length === 1);
      assert.equal(f.saved[0].type, 'text/csv');
      assert.match(f.saved[0].name, /^Vault-Export \d{4}-\d{2}-\d{2}\.csv$/);
      for (const s of ['Kita', 'pw2', 'Korrekt-Pferd', 'Code 4711', 'Familie', 'Persönlich']) assert.ok(f.saved[0].text.includes(s), s);
      // a new master password: the old one stops working, the content stays
      navTo(doc, 'Hauptpasswort ändern');
      const pws = detail.querySelectorAll('input').filter((i) => i.type === 'password');
      type(pws[0], PW);
      type(pws[1], 'Wolke-Fahrrad-Leuchtturm-92');
      type(pws[2], 'Wolke-Fahrrad-Leuchtturm-92');
      byText(doc, 'button', 'Speichern').click();
      await until('changed', toastIs(doc, 'Hauptpasswort geändert.'));
      const acc = (await host.request({ method: 'GET', path: 'account', user: anna })).json.account;
      assert.equal(acc.rev, 2);
      await assert.rejects(VC.unlock(acc, PW), (e) => e.code === 'decrypt');
      assert.ok((await VC.unlock(acc, 'Wolke-Fahrrad-Leuchtturm-92')).userKey.length === 32);
      // no request with a secret in the clear ever left the frame
      const wire = JSON.stringify(f.calls);
      for (const s of ['Korrekt-Pferd', 'Code 4711', 'pw2', PW, 'Wolke-Fahrrad-Leuchtturm-92']) assert.ok(!wire.includes(s), 'never sent: ' + s);
    } finally {
      w.stop();
      await tick();
    }
  });
});

test('smoke: emergency access between two portal tabs (request, approve, open read-only); the tab locks itself after 5 minutes', async () => {
  await withHost({}, async (host, c) => {
    const marc = await openPortal(host, MARC);
    const anna = await openPortal(host, ANNA);
    try {
      // Marc: a login, and Anna as a trusted person
      await newEntry(marc.doc, 'Login', { Titel: 'Sparkasse', Benutzername: 'marc.b', Passwort: 'Tresor-Geheim-1' });
      navTo(marc.doc, 'Notfallzugriff');
      const md = marc.doc.getElementById('vp-detail');
      (await until('people', () => md.querySelectorAll('.vp-vrow').find((b) => b.textContent.includes('Anna')))).click();
      const box = md.querySelectorAll('input').find((i) => i.type === 'checkbox');
      box.checked = true;
      box.dispatchEvent({ type: 'change' });
      md.querySelectorAll('button').find((b) => b.textContent === 'Hinzufügen').click();
      await until('trusted', () => text(md).includes('Wartezeit 2 Tage'));
      // Anna asks for access; Marc grants it right away
      navTo(anna.doc, 'Notfallzugriff');
      const ad = anna.doc.getElementById('vp-detail');
      (await until('request button', () => ad.querySelectorAll('button').find((b) => b.textContent === 'Anfordern'))).click();
      (await until('dialog', () => anna.doc.getElementById('vp-dialog').querySelectorAll('button').find((b) => b.textContent === 'Anfordern'))).click();
      await until('requested', () => text(anna.doc.getElementById('vp-toast')) === 'Angefordert.');
      navTo(marc.doc, 'Tresore & Teilen');
      navTo(marc.doc, 'Notfallzugriff');
      (await until('approve', () => md.querySelectorAll('button').find((b) => b.textContent === 'Sofort freigeben'))).click();
      marc.doc.getElementById('vp-dialog').querySelectorAll('button').find((b) => b.textContent === 'Sofort freigeben').click();
      await until('approved', () => text(marc.doc.getElementById('vp-toast')) === 'Freigegeben.');
      // Anna opens Marc's vault: read only, decrypted only in her tab
      navTo(anna.doc, 'Tresore & Teilen');
      navTo(anna.doc, 'Notfallzugriff');
      (await until('open', () => ad.querySelectorAll('button').find((b) => b.textContent === 'Öffnen'))).click();
      await until('emergency view', () => text(anna.doc.getElementById('vp-rows')).includes('Sparkasse'));
      assert.ok(text(anna.doc.getElementById('vp-nav')).includes('Vault von Marc'));
      assert.ok(anna.doc.getElementById('vp-new').hidden, 'nothing to add there');
      anna.doc.getElementById('vp-rows').querySelectorAll('button')[0].click();
      assert.ok(text(ad).includes('marc.b') && text(ad).includes('Notfallzugriff · nur lesen'));
      assert.ok(!ad.querySelectorAll('button').some((b) => b.textContent === 'Bearbeiten' || b.textContent === 'In den Papierkorb'), 'read only');
      byText(anna.doc, 'button', 'Passwort kopieren').click();
      assert.equal(anna.doc.copied.pop(), 'Tresor-Geheim-1');
      navTo(anna.doc, 'Zurück zu meinem Vault');
      assert.ok(!text(anna.doc.getElementById('vp-rows')).includes('Sparkasse'));
      // the other types: a 2FA code (title from the otpauth label, the code counting down), a card (masked number)
      await newEntry(anna.doc, '2FA-Code', { '2FA-Schlüssel (otpauth-Link oder Base32)': 'otpauth://totp/GitHub:anna?secret=JBSWY3DPEHPK3PXP&issuer=GitHub' });
      assert.ok(text(anna.doc.getElementById('vp-rows')).includes('GitHub'));
      assert.match(text(ad.querySelector('.vp-code')), /^\d{3} \d{3}$/);
      assert.match(text(ad), /Noch \d+ s gültig/);
      await newEntry(anna.doc, 'Karte', { Titel: 'Visa', Karteninhaber: 'Anna B', Kartennummer: '4111 1111 1111 1234', Prüfnummer: '123' });
      assert.ok(text(anna.doc.getElementById('vp-rows')).includes('•••• 1234'));
      assert.ok(!text(ad).includes('4111 1111') && text(ad).includes('•••• 1234'), 'the number masked in the detail');
      await newEntry(anna.doc, 'Identität', { Titel: 'Ich', Name: 'Anna B', 'E-Mail': 'anna@example.org', Adresse: 'Weg 1\n12345 Ort' });
      assert.ok(text(ad).includes('Weg 1\n12345 Ort'));
      // rename the personal vault
      navTo(anna.doc, 'Tresore & Teilen');
      ad.querySelectorAll('.vp-vrow')[0].click();
      type(ad.querySelector('input'), 'Meins');
      ad.querySelectorAll('button').find((b) => b.textContent === 'Umbenennen').click();
      await until('renamed', () => text(anna.doc.getElementById('vp-nav')).includes('Meins'));
      // 5 minutes without input: Marc's tab locks itself and forgets everything
      c.clock.add(5 * MIN + 1000);
      await until('auto lock', () => marc.doc.getElementById('vp-app').hidden, 12000);
      assert.ok(text(marc.doc.body).includes('Nach 5 Minuten ohne Eingabe gesperrt.'));
      assert.ok(!text(marc.doc.body).includes('Sparkasse') && !text(marc.doc.body).includes('marc.b'));
    } finally {
      marc.w.stop();
      anna.w.stop();
      await tick();
    }
  });
});
