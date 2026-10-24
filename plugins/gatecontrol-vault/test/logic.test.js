'use strict';

// The portal tab's pure parts (ui/logic.js, window.VaultLogic) — the same cases as gatecontrol-client-core's
// utils/vault tests where the rules are shared: entry JSON v1, 2FA codes (RFC 6238 vectors), the generator,
// imports of other password managers, the server's JSON and merging a sync page; plus the portal's own: list
// sections, drafts, the CSV export (read back by the importer), the Wi-Fi QR code (decoded again with jsQR); 1.2.0:
// the text of a scanned 2FA QR code (otpauth://totp, HOTP refused, Google Authenticator's export) and the bundled
// decoder reading pictures made with the bundled encoder.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadUi } = require('./load-ui');
const { qrPicture, blankPicture, migrationUri, bytesField, intField } = require('./qr-image');

const { L, N } = loadUi();
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
  const pic = qrPicture(N, text);
  const got = N.qrDecode(pic.data, pic.width, pic.height);
  assert.ok(got, 'decodes');
  assert.equal(got.data, text);
});

test('2FA QR code (1.2.0): otpauth://totp taken with title and account; HOTP, other links and other codes refused', () => {
  const s = 'JBSWY3DPEHPK3PXP';
  const uri = `otpauth://totp/ACME%20Corp:anna%40example.org?secret=${s}&issuer=ACME%20Corp&algorithm=SHA256&digits=8&period=60`;
  assert.deepEqual(L.qrTotp(uri), { kind: 'totp', uri, title: 'ACME Corp', account: 'anna@example.org' });
  assert.deepEqual(L.qrTotp(`  otpauth://totp/GitHub:marc?secret=${s}\n`), { kind: 'totp', uri: `otpauth://totp/GitHub:marc?secret=${s}`, title: 'GitHub', account: 'marc' });
  assert.deepEqual(L.qrTotp(`OTPAUTH://TOTP/marc?secret=${s}`), { kind: 'totp', uri: `OTPAUTH://TOTP/marc?secret=${s}`, title: 'marc', account: 'marc' });
  assert.deepEqual(L.qrTotp(`otpauth://totp/?secret=${s}&issuer=Bank`), { kind: 'totp', uri: `otpauth://totp/?secret=${s}&issuer=Bank`, title: 'Bank', account: null });
  const code = (t) => L.qrTotp(t).code;
  assert.equal(code(`otpauth://hotp/ACME:anna?secret=${s}&counter=0`), 'hotp');
  assert.equal(code(`otpauth://HOTP?secret=${s}`), 'hotp');
  assert.equal(code('otpauth://totp/x?secret=not!base32'), 'invalid');
  assert.equal(code('otpauth://totp/x'), 'invalid', 'no secret');
  assert.equal(code(`otpauth://totp/x?secret=${s}&algorithm=MD5`), 'invalid');
  assert.equal(code(`otpauth://steam/x?secret=${s}`), 'invalid');
  assert.equal(code(`otpauth://totpx/x?secret=${s}`), 'invalid');
  assert.equal(code(`otpauth://totp/a\u0000b?secret=${s}`), 'invalid', 'control characters');
  assert.equal(code(`otpauth://totp/${'a'.repeat(2100)}?secret=${s}`), 'invalid', 'too long');
  for (const other of ['https://example.org', 'WIFI:T:WPA;S:x;P:y;;', s, '', null]) assert.equal(code(other), 'not_2fa', String(other));
  assert.equal(L.totpAccount(`otpauth://totp/GitHub%3Amarc?secret=${s}`), 'marc');
  assert.equal(L.totpAccount('https://x'), null);
  // base32 both ways
  for (const n of [1, 5, 10, 16, 20, 33]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.deepEqual([...L.base32Decode(L.base32Encode(bytes))], [...bytes], `${n} bytes`);
  }
  assert.equal(L.base32Encode(Buffer.from('12345678901234567890')), b32('12345678901234567890'));
});

test('2FA QR code (1.2.0): Google Authenticator export — entries to pick from, HOTP / MD5 marked, broken data refused', () => {
  const secret = Buffer.from('12345678901234567890');
  const r = L.qrTotp(migrationUri([
    { secret, name: 'anna@example.org', issuer: 'ACME', algorithm: 1, digits: 1, type: 2 },
    { secret, name: 'GitHub:marc', algorithm: 2, digits: 2, type: 2 },
    { secret, name: 'Bank: Lena', issuer: 'Bank', type: 1, counter: 5 },
    { secret, name: 'Alt', issuer: 'Old', algorithm: 4 },
    { secret, name: 'Grüße', issuer: '', algorithm: 0, digits: 0, type: 0 },
  ], { batchSize: 3, batchIndex: 1 }));
  assert.equal(r.kind, 'migration');
  assert.deepEqual([r.batchIndex, r.batchSize], [1, 3]);
  const s = b32('12345678901234567890');
  assert.deepEqual(r.entries, [
    { title: 'ACME', issuer: 'ACME', account: 'anna@example.org', uri: `otpauth://totp/ACME:anna%40example.org?secret=${s}&issuer=ACME`, code: null },
    { title: 'GitHub', issuer: 'GitHub', account: 'marc', uri: `otpauth://totp/GitHub:marc?secret=${s}&issuer=GitHub&algorithm=SHA256&digits=8`, code: null },
    { title: 'Bank', issuer: 'Bank', account: 'Lena', uri: null, code: 'hotp' },
    { title: 'Old', issuer: 'Old', account: 'Alt', uri: null, code: 'invalid' },
    { title: 'Grüße', issuer: null, account: 'Grüße', uri: `otpauth://totp/Gr%C3%BC%C3%9Fe?secret=${s}`, code: null },
  ]);
  // each link is a valid 2FA key with the right code (RFC 6238 SHA1 at T=59)
  const first = L.qrTotp(r.entries[0].uri);
  assert.deepEqual([first.kind, first.title, first.account], ['totp', 'ACME', 'anna@example.org']);
  assert.equal(L.totpCode(L.parseTotp(r.entries[0].uri), 59000).code, '287082');
  assert.equal(L.parseTotp(r.entries[1].uri).digits, 8);
  // '+' / '/' of base64 not percent-encoded; URL-safe alphabet
  const raw = decodeURIComponent(migrationUri([{ secret: Buffer.from([0xfb, 0xff, 0xfe, 0x01]), name: 'x' }]).split('data=')[1]);
  assert.match(raw, /[+/]/);
  assert.equal(L.qrTotp('otpauth-migration://offline?data=' + raw).entries[0].uri, 'otpauth://totp/x?secret=7P774AI');
  assert.equal(L.qrTotp('otpauth-migration://offline?data=' + raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).kind, 'migration');
  // unknown fields (also fixed64 / fixed32) are skipped
  const withExtra = migrationUri([{ secret, name: 'a', issuer: 'b' }], { extra: [...intField(9, 7), 0x51, 1, 2, 3, 4, 5, 6, 7, 8, 0x6d, 1, 2, 3, 4, ...bytesField(10, [1, 2])] });
  assert.equal(L.qrTotp(withExtra).entries.length, 1);
  const code = (t) => L.qrTotp(t).code;
  assert.equal(code('otpauth-migration://offline?data='), 'invalid');
  assert.equal(code('otpauth-migration://offline?data=%%%'), 'invalid');
  assert.equal(code('otpauth-migration://offline?data=' + Buffer.from([0x0a, 0x50, 1, 2]).toString('base64')), 'invalid', 'length past the end');
  assert.equal(code('otpauth-migration://offline?data=' + Buffer.from([0x0b]).toString('base64')), 'invalid', 'wire type 3');
  assert.equal(code('otpauth-migration://offline?data=' + Buffer.from(intField(2, 1)).toString('base64')), 'invalid', 'no entries');
  assert.equal(code('otpauth-migration://online?data=' + Buffer.from(intField(2, 1)).toString('base64')), 'invalid');
  const unusable = L.qrTotp(migrationUri([{ secret: Buffer.alloc(0), name: 'a' }]));
  assert.deepEqual([unusable.kind, unusable.entries[0].code], ['migration', 'invalid'], 'shown in the list, not usable');
  const many = Array.from({ length: 101 }, (_, i) => ({ secret: Buffer.from([i + 1]), name: 'n' + i }));
  assert.equal(code(migrationUri(many)), 'too_big');
  assert.equal(code('otpauth-migration://offline?data=' + 'A'.repeat(9000)), 'too_big');
});

test('2FA QR code (1.2.0): pictures made with the bundled encoder (uqr) decode with the bundled decoder (jsQR)', () => {
  const texts = [
    'otpauth://totp/ACME:anna%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=ACME',
    migrationUri([{ secret: Buffer.from('12345678901234567890'), name: 'anna', issuer: 'ACME' }, { secret: Buffer.from('abc'), name: 'b', type: 1 }]),
  ];
  for (const t of texts) {
    for (const o of [{}, { scale: 2 }, { scale: 7, border: 10 }, { invert: true }]) {
      const pic = qrPicture(N, t, o);
      const got = N.qrDecode(pic.data, pic.width, pic.height, { inversionAttempts: 'attemptBoth' });
      assert.ok(got, `decodes ${JSON.stringify(o)}`);
      assert.equal(got.data, t);
    }
  }
  const mig = qrPicture(N, texts[1]);
  const r = L.qrTotp(N.qrDecode(mig.data, mig.width, mig.height).data);
  assert.deepEqual(r.entries.map((e) => [e.title, e.code]), [['ACME', null], ['b', 'hotp']]);
  const blank = blankPicture();
  assert.equal(N.qrDecode(blank.data, blank.width, blank.height, { inversionAttempts: 'attemptBoth' }), null);
  // inverted pictures only with attemptBoth (the camera reads 'dontInvert' for speed)
  const inv = qrPicture(N, texts[0], { invert: true });
  assert.equal(N.qrDecode(inv.data, inv.width, inv.height, { inversionAttempts: 'dontInvert' }), null);
});

test('export: spreadsheet formulas are defused (\'), passwords and 2FA keys stay as they are; the importer undoes it', () => {
  const d = L.normalizeEntry({ type: 'login', title: '=HYPERLINK("http://x","klick")', urls: ['@evil'], fields: { username: '+49 170 1234', password: '=1+1', totp: '-JBSWY3DPEHPK3PXP' }, notes: '-minus', custom: [{ name: 'x', value: 'y' }] });
  const csv = L.exportCsv([{ vaultName: '=Familie', data: d }, { vaultName: 'Tab', data: L.normalizeEntry({ type: 'note', title: '\tTab', notes: '\rCR' }) }]);
  const rows = L.csvRows(csv.slice(1));
  assert.deepEqual(rows[1].slice(0, 9), ["'=Familie", 'login', '\'=HYPERLINK("http://x","klick")', '', "'@evil", "'+49 170 1234", '=1+1', '-JBSWY3DPEHPK3PXP', "'-minus"]);
  assert.equal(rows[2][2], "'\tTab");
  for (const r of rows.slice(1)) {
    r.forEach((cell, i) => {
      if (L.EXPORT_VERBATIM.includes(L.EXPORT_COLUMNS[i])) return;
      assert.ok(!/^[=+\-@\t\r]/.test(cell), `${L.EXPORT_COLUMNS[i]}: ${JSON.stringify(cell)}`);
    });
  }
  const back = L.parseImport(csv);
  assert.equal(back.source, 'Vault');
  assert.deepEqual([back.entries[0].title, back.entries[0].urls[0], back.entries[0].notes], ['=HYPERLINK("http://x","klick")', '@evil', '-minus']);
  assert.deepEqual(back.entries[0].fields, { password: '=1+1', totp: '-JBSWY3DPEHPK3PXP', username: '+49 170 1234' });
  assert.equal(back.entries[1].title, 'Tab', 'the escape is gone (the importer trims titles anyway)');
  // another program's CSV is read as it is
  assert.equal(L.parseImport("name,url,username,password,note\n'=x,https://a.de,u,p,\n").entries[0].title, "'=x");
});
