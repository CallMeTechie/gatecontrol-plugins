'use strict';

// The portal tab's pure parts (ui/logic.js, window.VaultLogic) — the same cases as gatecontrol-client-core's
// utils/vault tests where the rules are shared: entry JSON v1, 2FA codes (RFC 6238 vectors), the generator,
// imports of other password managers, the server's JSON and merging a sync page; plus the portal's own: list
// sections, drafts, the CSV export (read back by the importer), the Wi-Fi QR code (decoded again with jsQR).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadUi } = require('./load-ui');

const { L } = loadUi();
const VID = 'Vt9bJm0n2QwErTyUiOpAsD';
const V2 = 'Wt9bJm0n2QwErTyUiOpAsE';
const A = 'Aa1111111111111111111a';
const B = 'Bb2222222222222222222b';

function b32(ascii) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...Buffer.from(ascii)].map((x) => x.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{1,5}/g).map((g) => alphabet[parseInt(g.padEnd(5, '0'), 2)]).join('');
}

test('entry JSON v1: unknown keys kept, other versions and types refused, rows without secrets', () => {
  const e = L.normalizeEntry({ v: 1, type: 'login', title: 'X', fields: { username: 'u', future: 'f', empty: '', n: 5 }, urls: ['a.de', ' ', 3], later: { x: 1 } });
  assert.deepEqual(e.fields, { future: 'f', username: 'u' });
  assert.deepEqual(e.urls, ['a.de']);
  assert.deepEqual(L.normalizeEntry(JSON.parse(JSON.stringify(e))).later, { x: 1 });
  assert.equal(L.normalizeEntry({ v: 2, type: 'login' }), null);
  assert.equal(L.normalizeEntry({ v: 1, type: 'spaceship' }), null);
  assert.equal(L.normalizeEntry({ type: 'note', title: 'neu' }).v, 1);
  const proto = L.normalizeEntry(JSON.parse('{"v":1,"type":"note","title":"p","__proto__":{"polluted":1}}'));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(proto.__proto__, { polluted: 1 }, 'kept as a plain key, not the prototype');
  const d = L.normalizeEntry({ type: 'login', title: 'Bank', urls: ['https://www.bank.de/login'], fields: { username: 'anna', password: 'geheim' }, custom: [{ name: 'PIN', value: '1234', secret: true }] });
  const row = L.entrySummary({ id: A, vaultId: VID, rev: 2, trashed: false, data: d });
  assert.equal(row.sub, 'anna · bank.de');
  assert.ok(!JSON.stringify(row).includes('geheim') && !JSON.stringify(row).includes('1234'));
  assert.equal(L.entrySubtitle(L.normalizeEntry({ type: 'card', title: 'Visa', fields: { number: '4111 1111 1111 1234' } })), '•••• 1234');
  assert.equal(L.entrySubtitle(L.normalizeEntry({ type: 'wifi', title: 'WLAN', fields: { ssid: 'Backes-5G', security: 'WPA3', password: 'x' } })), 'Backes-5G · WPA3');
});

test('TOTP: RFC 6238 appendix B for SHA1, SHA256, SHA512; bare secrets; labels', () => {
  const s1 = b32('12345678901234567890');
  const s256 = b32('12345678901234567890123456789012');
  const s512 = b32('1234567890123456789012345678901234567890123456789012345678901234');
  const cases = [
    [59, ['94287082', '46119246', '90693936']],
    [1111111109, ['07081804', '68084774', '25091201']],
    [1111111111, ['14050471', '67062674', '99943326']],
    [1234567890, ['89005924', '91819424', '93441116']],
    [2000000000, ['69279037', '90698825', '38618901']],
    [20000000000, ['65353130', '77737706', '47863826']],
  ];
  for (const [t, want] of cases) {
    assert.equal(L.totpCode(L.parseTotp(`otpauth://totp/x?secret=${s1}&digits=8`), t * 1000).code, want[0], `SHA1 ${t}`);
    assert.equal(L.totpCode(L.parseTotp(`otpauth://totp/x?secret=${s256}&digits=8&algorithm=SHA256`), t * 1000).code, want[1], `SHA256 ${t}`);
    assert.equal(L.totpCode(L.parseTotp(`otpauth://totp/x?secret=${s512}&digits=8&algorithm=sha512`), t * 1000).code, want[2], `SHA512 ${t}`);
  }
  const plain = L.parseTotp(s1.toLowerCase().match(/.{1,4}/g).join(' '));
  const c = L.totpCode(plain, 59000);
  assert.deepEqual([c.code, c.secondsLeft], ['287082', 1]);
  assert.equal(L.prettyCode('482913'), '482 913');
  assert.equal(L.parseTotp(`otpauth://hotp/x?secret=${s1}`), null);
  assert.equal(L.parseTotp('not base32 !'), null);
  assert.equal(L.totpLabel(`otpauth://totp/Sparkasse:marc?secret=${s1}&issuer=Sparkasse`), 'Sparkasse');
  assert.equal(L.totpLabel(`otpauth://totp/GitHub%3Amarc?secret=${s1}`), 'GitHub');
});

test('generator and strength: classes, look-alikes, words; the master password rule', () => {
  for (let i = 0; i < 50; i++) {
    const p = L.generatePassword({ length: 20 });
    assert.equal(p.length, 20);
    assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p), p);
    const q = L.generatePassword({ length: 12, symbols: false, avoidAmbiguous: true });
    assert.ok(!/[l1IO0]/.test(q) && /^[A-Za-z0-9]{12}$/.test(q), q);
  }
  assert.equal(L.generatePassword({ length: 200 }).length, 64);
  const w = L.generatePassword({ words: true, wordCount: 4 });
  assert.equal(w.split('-').length, 4);
  assert.ok(/\d/.test(w));
  assert.equal(L.passwordStrength('Passw0rd!'), 'weak');
  assert.equal(L.passwordStrength('Sonnenblume-Kanu-Turm-47'), 'very_strong');
  assert.deepEqual(L.masterCheck('kurz', ''), { ok: false, hint: 'pw_rule' });
  assert.deepEqual(L.masterCheck('Sonnenblume-Kanu-Turm-47', 'x'), { ok: false, hint: 'pw_mismatch' });
  assert.deepEqual(L.masterCheck('Sonnenblume-Kanu-Turm-47', 'Sonnenblume-Kanu-Turm-47'), { ok: true, hint: 'pw_match' });
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(L.randomInt(7));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('import: Bitwarden JSON, Chrome / Bitwarden / Firefox / KeePass / 1Password CSV, duplicates', () => {
  const json = JSON.stringify({ encrypted: false, items: [
    { type: 1, name: 'GitHub', favorite: true, notes: 'n', login: { username: 'me', password: 'pw', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://github.com' }, { uri: 'androidapp://com.github.android' }] }, fields: [{ name: 'PIN', value: '1234', type: 1 }] },
    { type: 2, name: 'Notiz', notes: 'Text' },
    { type: 3, name: 'Visa', card: { cardholderName: 'M B', number: '4111', expMonth: '3', expYear: '2029', code: '123' } },
    { type: 4, name: 'Ich', identity: { firstName: 'Marc', lastName: 'B', email: 'm@b.de', address1: 'Weg 1', postalCode: '12345', city: 'Ort' } },
    { type: 5, name: 'SSH' },
    { type: 1, name: '', login: { uris: [{ uri: 'https://shop.example.com/x' }] } },
  ] });
  const r = L.parseImport('\uFEFF' + json);
  assert.deepEqual([r.ok, r.source, r.entries.length], [true, 'Bitwarden', 5]);
  assert.deepEqual(r.entries[0].apps, ['com.github.android']);
  assert.ok(r.entries[0].fav && r.entries[0].custom[0].secret);
  assert.equal(r.entries[2].fields.expiry, '03/29');
  assert.equal(r.entries[3].fields.address, 'Weg 1, 12345 Ort');
  assert.equal(r.entries[4].title, 'shop.example.com');
  assert.deepEqual(L.importCounts(r.entries), { total: 5, logins: 2, withTotp: 1, notes: 1, cards: 1 });
  assert.deepEqual(L.parseImport('{"encrypted":true,"data":"x"}'), { ok: false, code: 'encrypted' });
  assert.deepEqual(L.parseImport('{broken'), { ok: false, code: 'unknown' });

  const chrome = L.parseImport('name,url,username,password,note\r\nBank,https://bank.de,anna,"p,w""x","zwei\nZeilen"\r\n,https://shop.example.com/login,bob,secret,\n');
  assert.equal(chrome.source, 'Chrome / Edge');
  assert.equal(chrome.entries[0].fields.password, 'p,w"x');
  assert.equal(chrome.entries[0].notes, 'zwei\nZeilen');
  assert.deepEqual(L.duplicateFlags([...chrome.entries, chrome.entries[1]], [chrome.entries[0]]), [true, false, true]);
  assert.deepEqual(L.parseImport('just,some\ncsv,file'), { ok: false, code: 'unknown' });
  const bw = L.parseImport('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,1,login,Mail,,,0,https://mail.de,me,pw,JBSWY3DPEHPK3PXP\n,,note,Zettel,Inhalt,,0,,,,\n');
  assert.equal(bw.source, 'Bitwarden');
  assert.deepEqual(bw.entries.map((e) => [e.type, e.title, e.fav === true]), [['login', 'Mail', true], ['note', 'Zettel', false]]);
  assert.equal(L.parseImport('url,username,password,httpRealm,formActionOrigin,guid\nhttps://a.de,u,p,,,{x}\n').source, 'Firefox');
  assert.equal(L.parseImport('"Group","Title","Username","Password","URL","Notes"\n"Root","A","u","p","https://a.de",""\n').source, 'KeePass');
  assert.equal(L.parseImport('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nA,https://a.de,u,p,,,,,\n').source, '1Password');
  assert.equal(L.parseImport('Title;Username;Password;URL\nA;u;p;https://a.de\n').entries[0].fields.username, 'u');
});

test('export: CSV with BOM and CRLF, quoted; the importer reads its logins and notes back', () => {
  const list = [
    { vaultName: 'Persönlich', data: L.normalizeEntry({ type: 'login', title: 'Bank "Süd"', fav: true, urls: ['https://bank.de', 'https://app.bank.de'], fields: { username: 'anna', password: ' p,w;x ', totp: 'JBSWY3DPEHPK3PXP' }, notes: 'zwei\nZeilen', custom: [{ name: 'PIN', value: '1234', secret: true }] }) },
    { vaultName: 'Familie', data: L.normalizeEntry({ type: 'note', title: 'Zettel', notes: 'Inhalt' }) },
    { vaultName: 'Familie', data: L.normalizeEntry({ type: 'wifi', title: 'WLAN', fields: { ssid: 'Backes-5G', password: 'geheim', security: 'WPA2' } }) },
  ];
  const csv = L.exportCsv(list);
  assert.ok(csv.startsWith('\uFEFFvault,type,title,favorite,url,username,password,totp,notes,fields\r\n'));
  const rows = L.csvRows(csv.slice(1));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1].slice(0, 8), ['Persönlich', 'login', 'Bank "Süd"', '1', 'https://bank.de', 'anna', ' p,w;x ', 'JBSWY3DPEHPK3PXP']);
  assert.equal(rows[1][9], 'url: https://app.bank.de\nPIN: 1234');
  assert.equal(rows[3][9], 'security: WPA2\nssid: Backes-5G');
  assert.equal(rows[3][6], 'geheim', 'a Wi-Fi password in the password column');
  const back = L.parseImport(csv);
  assert.equal(back.ok, true);
  assert.deepEqual(back.entries[0].fields, { password: ' p,w;x ', totp: 'JBSWY3DPEHPK3PXP', username: 'anna' });
  assert.equal(back.entries[0].fav, true);
  assert.deepEqual([back.entries[1].type, back.entries[1].title, back.entries[1].notes], ['note', 'Zettel', 'Inhalt']);
});

test('server JSON: invalid shapes are dropped; a sync page merges (tombstones, gone vaults, older copies)', () => {
  const vault = (id, o) => ({ id, kind: 'shared', ownerId: 2, nameEnc: 'AAAA', role: 'write', keyRev: 1, sealedKey: 'BBBB', members: [{ userId: 2, name: 'Anna', role: 'manage' }], ...o });
  const item = (id, o) => ({ id, vaultId: VID, rev: 1, keyRev: 1, blob: 'CCCC', state: 'live', seq: 1, ...o });
  assert.equal(L.parseVault(vault('short')), null);
  assert.equal(L.parseVault(vault(VID, { role: 'owner' })), null);
  assert.equal(L.parseVault(vault(VID, { pending: { keyRev: 'x' } })), null);
  assert.equal(L.wantedKeyRev(L.parseVault(vault(VID, { pending: { keyRev: 2, sealedKey: 'DDDD' } }))), 2);
  assert.equal(L.parseItem(item(A, { blob: null })), null);
  assert.equal(L.parseItem(item(A, { blob: null, state: 'purged' })).blob, null);
  assert.equal(L.parseSync({ vaults: [], seq: 'x', next: 1 }), null);
  let s = L.emptyState();
  s = L.mergePage(s, L.parseSync({ seq: 5, next: 5, vaults: [vault(VID)], items: [item(A, { seq: 3 }), item(B, { seq: 4 })], account: null }));
  s.seq = 5;
  assert.deepEqual([...s.items.keys()], [A, B]);
  s = L.mergePage(s, L.parseSync({ seq: 7, next: 7, vaults: [vault(VID), vault(V2)], items: [item(A, { seq: 6, state: 'purged', blob: null }), item(B, { seq: 2, rev: 1 })] }));
  assert.deepEqual([...s.items.keys()], [B]);
  assert.deepEqual(s.fresh, [V2], 'a vault shared since: fetch its entries');
  const before = s.items.get(B);
  s = L.putItem(s, { ...before, seq: 1, rev: 9 });
  assert.equal(s.items.get(B).rev, 1, 'an older answer never wins');
  s = L.savedItem(s, { id: B, vaultId: VID, blob: 'EEEE', keyRev: 2, baseRev: 1 }, { rev: 2, seq: 9 }, { device: 'Portal' });
  assert.deepEqual([s.items.get(B).rev, s.items.get(B).keyRev, s.items.get(B).device], [2, 2, 'Portal']);
  s = L.mergePage(s, L.parseSync({ seq: 9, next: 9, vaults: [vault(V2)], items: [] }));
  assert.equal(s.items.size, 0, 'a vault missing from the list is gone with its entries');
  assert.equal(L.dropVault(L.putVault(s, L.parseVault(vault(VID))), VID).vaults.length, 1);
  const batches = L.batches(Array.from({ length: 250 }, (_, i) => ({ id: `id${String(i).padStart(14, '0')}`, vaultId: VID, blob: 'x'.repeat(100) })));
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
  assert.equal(L.batches([{ id: A, vaultId: VID, blob: 'x'.repeat(30000) }, { id: B, vaultId: VID, blob: 'x'.repeat(30000) }]).length, 2, '≤ 48 KB a request');
  assert.equal(L.failureCode({ status: 409, data: { ok: false, code: 'stale_key' } }), 'stale_key');
  assert.equal(L.failureCode(new Error('network error')), 'network');
  assert.equal(L.failureCode({ status: 0 }), 'network');
});

test('page helpers: sections, search, drafts, safe links, waiting times, candidates', () => {
  const rows = [
    { id: A, vaultId: VID, title: 'Bahn.de', subtitle: 'marc', username: 'marc', host: 'bahn.de', urls: [], fav: true, trashed: false },
    { id: B, vaultId: V2, title: 'Überweisung', subtitle: '', username: '', host: null, urls: [], fav: false, trashed: false },
    { id: 'Cc3333333333333333333c', vaultId: VID, title: 'Alt', subtitle: '', username: '', host: null, urls: [], fav: false, trashed: true },
  ];
  assert.deepEqual(L.listSections(rows, { vaultId: 'all' }).map((s) => [s.key, s.items.length]), [['favorites', 1], ['all', 2]]);
  assert.deepEqual(L.listSections(rows, { vaultId: 'all', query: 'uberw' }).map((s) => [s.key, s.items.map((x) => x.id)]), [['all', [B]]], 'umlauts folded');
  assert.deepEqual(L.listSections(rows, { vaultId: V2 })[0].items.map((x) => x.id), [B]);
  assert.deepEqual(L.listSections(rows, { vaultId: 'trash' }), [{ key: 'trash', items: [rows[2]] }]);
  assert.deepEqual(L.listSections(rows, { vaultId: 'favorites' })[0].items.map((x) => x.id), [A]);
  const entry = { id: A, vaultId: VID, data: L.normalizeEntry({ type: 'login', title: 'X', urls: ['a.de'], fields: { username: 'u' }, future: { k: 1 } }) };
  const d = L.draftFrom(entry);
  assert.deepEqual(d.extra, { future: { k: 1 } });
  d.fields.password = 'neu';
  d.custom.push({ name: '', value: '', secret: false });
  const out = L.draftToData(d);
  assert.deepEqual(out.fields, { password: 'neu', username: 'u' });
  assert.deepEqual(out.custom, []);
  assert.deepEqual(out.future, { k: 1 }, 'unknown keys of other apps stay');
  assert.ok(L.draftChanged(d, L.draftFrom(entry)));
  assert.equal(L.draftError({ ...L.emptyDraft('login', VID), title: ' ' }), 'edit.title_required');
  assert.equal(L.draftError({ ...L.emptyDraft('totp', VID), title: 'x', fields: { totp: 'not base32 !' } }), 'totp.invalid');
  assert.equal(L.draftError({ ...L.emptyDraft('note', VID), title: 'x' }), null);
  assert.equal(L.openableUrl('bank.de/login'), 'https://bank.de/login');
  assert.equal(L.openableUrl('javascript:alert(1)'), null);
  assert.equal(L.openableUrl('nas.local:5000'), 'https://nas.local:5000');
  assert.deepEqual(L.waitParts(168), { key: 'em.days', count: 7 });
  assert.deepEqual(L.waitParts(36), { key: 'em.hours', count: 36 });
  assert.deepEqual(L.remaining(new Date(Date.now() + 61 * 60000 + 30000).toISOString()), { hours: 1, minutes: 1 });
  assert.deepEqual(L.candidates([{ id: 3, name: 'Oma', publicKey: null }, { id: 4, name: 'Lena', publicKey: 'k' }, { id: 2, name: 'Anna', publicKey: 'k' }], [{ userId: 2 }]).map((p) => p.id), [4, 3]);
  assert.equal(L.letter(' 1Password'), '1');
  assert.equal(L.letter('ärger'), 'Ä');
  assert.ok(L.tone('Bahn.de') >= 0 && L.tone('Bahn.de') < 5);
  assert.deepEqual(L.recoveryGroups('ab12-cd34 ef56'), ['AB12', 'CD34', 'EF56']);
});

test('Wi-Fi QR code: the WIFI: text escapes; the matrix decodes back (jsQR)', () => {
  const d = L.normalizeEntry({ type: 'wifi', title: 'WLAN', fields: { ssid: 'Backes;5G', password: 'ge"heim:\\', security: 'WPA2/WPA3' } });
  assert.equal(L.wifiQrText(d), 'WIFI:T:WPA;S:Backes\\;5G;P:ge\\"heim\\:\\\\;;');
  assert.equal(L.wifiQrText(L.normalizeEntry({ type: 'wifi', title: 'Gast', fields: { ssid: 'Gast' } })), 'WIFI:T:nopass;S:Gast;;');
  assert.equal(L.wifiQrText(L.normalizeEntry({ type: 'wifi', title: 'x', fields: { ssid: 'S', password: 'p', security: 'WPA3' } })), 'WIFI:T:SAE;S:S;P:p;;');
  assert.equal(L.wifiQrText(L.normalizeEntry({ type: 'wifi', title: 'x', fields: { password: 'p' } })), null);
  const text = L.wifiQrText(L.normalizeEntry({ type: 'wifi', title: 'WLAN', fields: { ssid: 'Backes-5G Grüße', password: 'Korrekt Pferd Batterie', security: 'WPA2' } }));
  const m = L.qrMatrix(text);
  assert.ok(m && m.size >= 21 && m.data.length === m.size && m.data[0].length === m.size);
  // the finder pattern in the top left corner
  assert.deepEqual(m.data[0].slice(0, 7), [true, true, true, true, true, true, true]);
  assert.deepEqual(m.data[1].slice(0, 7), [true, false, false, false, false, false, true]);
  const jsqrPath = path.join(__dirname, '..', '..', 'gatecontrol-schule', 'ui', 'vendor', 'jsqr', 'jsQR.js');
  if (!fs.existsSync(jsqrPath)) return;
  const jsQR = require(jsqrPath);
  const scale = 4;
  const border = 4;
  const w = (m.size + 2 * border) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.data[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + border) * scale + dy) * w + (x + border) * scale + dx) * 4;
          px[o] = 0; px[o + 1] = 0; px[o + 2] = 0;
        }
      }
    }
  }
  const got = jsQR(px, w, w);
  assert.ok(got, 'decodes');
  assert.equal(got.data, text);
});
