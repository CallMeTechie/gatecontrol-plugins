/* Vault (gatecontrol-vault) — the pure parts of the portal tab, without DOM and without keys: window.VaultLogic.
 *
 * The same rules as the apps (gatecontrol-client-core src/utils/vault.js, the Windows view logic vault-state.js,
 * Android VaultJson / VaultTotp / VaultGenerator / VaultImport):
 *   - the server's answers → checked records (README "App-API"); a sync page merged into the tab's copy;
 *   - the entry JSON v1 { v: 1, type, title, fav, notes, urls, apps, fields, custom } (unknown keys kept);
 *   - 2FA codes (TOTP, RFC 6238; HMAC from ui/vendor/noble.js), the password generator and its strength estimate;
 *   - import of other password managers' exports, the CSV export, the Wi-Fi QR text;
 *   - list, detail and edit helpers of the page (search, sections, drafts, labels).
 * Random numbers: crypto.getRandomValues. Nothing in here is sent anywhere or kept.
 */
(function (root) {
  'use strict';

  var ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
  var B64_RE = /^[A-Za-z0-9_-]+$/;
  var EMERGENCY_ID_RE = /^[0-9a-f]{24}$/;
  var CODE_RE = /^[A-Za-z0-9_]{1,60}$/;
  var ROLES = ['read', 'write', 'manage'];
  var TYPES = ['login', 'totp', 'note', 'card', 'wifi', 'identity'];
  var ITEM_STATES = ['live', 'trash', 'purged'];
  var EMERGENCY_STATES = ['ready', 'requested', 'granted'];
  var WAIT_CHOICES = [24, 48, 168, 336, 720];
  var BATCH_BYTES = 48000;
  var BATCH_ITEMS = 100;
  var MAX_LIST = 5000;
  var MIN_MASTER = 12;

  /** Fields per type in the order of the detail page and the form. secret: masked until revealed. */
  var FIELDS = {
    login: [{ key: 'username' }, { key: 'password', secret: true }, { key: 'totp', secret: true, totp: true }],
    totp: [{ key: 'totp', secret: true, totp: true }],
    note: [],
    card: [{ key: 'holder' }, { key: 'number', secret: true }, { key: 'expiry' }, { key: 'cvc', secret: true }, { key: 'pin', secret: true }],
    wifi: [{ key: 'ssid' }, { key: 'password', secret: true }, { key: 'security' }],
    identity: [{ key: 'name' }, { key: 'email' }, { key: 'phone' }, { key: 'address', multiline: true }, { key: 'birthday' }],
  };

  var isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  var str = function (v) { return v === null || v === undefined ? '' : String(v); };
  var sget = function (o, k) { return typeof o[k] === 'string' ? o[k] : null; };
  var int = function (o, k) { return Number.isSafeInteger(o[k]) && Math.abs(o[k]) <= 2e9 ? o[k] : null; };
  var long = function (o, k) { return Number.isSafeInteger(o[k]) ? o[k] : null; };
  var isId = function (v) { return typeof v === 'string' && ID_RE.test(v); };
  var b64 = function (v) { return typeof v === 'string' && v.length >= 1 && v.length <= 65536 && B64_RE.test(v) ? v : null; };
  var optStr = function (o, k, max) { return typeof o[k] === 'string' ? o[k].slice(0, max || 64) : null; };
  var clone = function (v) { return JSON.parse(JSON.stringify(v)); };
  var name120 = function (o, k) { return (sget(o, k) || '').slice(0, 120); };

  // ── random ───────────────────────────────────────────────

  /** A uniform integer in [0, n) from crypto.getRandomValues (rejection sampling). */
  function randomInt(n) {
    if (!(n > 0 && n <= 0x100000000)) throw new Error('range');
    var limit = Math.floor(0x100000000 / n) * n;
    var buf = new Uint32Array(1);
    for (;;) {
      root.crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
  }

  // ── the server's records ─────────────────────────────────

  function errorCode(o) {
    return isObj(o) && typeof o.code === 'string' && CODE_RE.test(o.code) ? o.code : null;
  }

  function parseKdf(o) {
    if (!isObj(o)) return null;
    var k = { alg: sget(o, 'alg'), m: int(o, 'm'), t: int(o, 't'), p: int(o, 'p'), salt: b64(o.salt) };
    return k.alg && k.m != null && k.t != null && k.p != null && k.salt ? k : null;
  }

  function parseAccount(o) {
    if (!isObj(o)) return null;
    var a = { kdf: parseKdf(o.kdf), userKeyPw: b64(o.userKeyPw), userKeyRk: b64(o.userKeyRk), publicKey: b64(o.publicKey), privateKeyEnc: b64(o.privateKeyEnc), rev: int(o, 'rev') };
    return a.kdf && a.userKeyPw && a.userKeyRk && a.publicKey && a.privateKeyEnc && a.rev != null ? a : null;
  }

  /** GET account → { account } (null: not set up) or null for an invalid answer. */
  function parseAccountAnswer(o) {
    if (!isObj(o) || !Object.prototype.hasOwnProperty.call(o, 'account')) return null;
    if (o.account === null) return { account: null };
    var a = parseAccount(o.account);
    return a ? { account: a } : null;
  }

  function parseVault(o) {
    if (!isObj(o)) return null;
    var pending = null;
    if (isObj(o.pending)) {
      var kr = int(o.pending, 'keyRev');
      if (kr == null) return null;
      pending = { keyRev: kr, sealedKey: b64(o.pending.sealedKey) };
    }
    var v = {
      id: isId(o.id) ? o.id : null,
      kind: o.kind === 'personal' || o.kind === 'shared' ? o.kind : null,
      ownerId: int(o, 'ownerId') || 0,
      nameEnc: b64(o.nameEnc),
      role: ROLES.indexOf(o.role) >= 0 ? o.role : null,
      keyRev: int(o, 'keyRev'),
      sealedKey: b64(o.sealedKey),
      pending: pending,
      needsRekey: o.needsRekey === true,
      members: [],
      updatedAt: optStr(o, 'updatedAt'),
    };
    if (!v.id || !v.kind || !v.nameEnc || !v.role || !(v.keyRev > 0) || !v.sealedKey) return null;
    (Array.isArray(o.members) ? o.members : []).forEach(function (m) {
      if (!isObj(m) || int(m, 'userId') == null) return;
      v.members.push({ userId: m.userId, name: name120(m, 'name'), role: ROLES.indexOf(m.role) >= 0 ? m.role : 'read' });
    });
    return v;
  }

  function parseItem(o) {
    if (!isObj(o)) return null;
    var state = ITEM_STATES.indexOf(o.state) >= 0 ? o.state : null;
    if (!state) return null;
    var blob = b64(o.blob);
    if (state !== 'purged' && !blob) return null;
    var rev = int(o, 'rev');
    var keyRev = int(o, 'keyRev');
    if (!isId(o.id) || !isId(o.vaultId) || !(rev > 0) || !(keyRev > 0)) return null;
    return {
      id: o.id, vaultId: o.vaultId, rev: rev, keyRev: keyRev, blob: state === 'purged' ? null : blob, state: state,
      trashedAt: optStr(o, 'trashedAt'), updatedAt: optStr(o, 'updatedAt'), updatedBy: int(o, 'updatedBy'),
      device: optStr(o, 'device', 80), seq: long(o, 'seq') || 0,
    };
  }

  var parseItems = function (a) { return Array.isArray(a) ? a.slice(0, MAX_LIST).map(parseItem).filter(Boolean) : []; };

  /** GET sync → { seq, account, vaults, items, more, next } or null. */
  function parseSync(o) {
    if (!isObj(o) || !Array.isArray(o.vaults)) return null;
    var seq = long(o, 'seq');
    var next = long(o, 'next');
    if (seq == null || next == null) return null;
    var account = null;
    if (isObj(o.account)) {
      account = parseAccount(o.account);
      if (!account) return null;
    }
    return { seq: seq, account: account, vaults: o.vaults.map(parseVault).filter(Boolean), items: parseItems(o.items), more: o.more === true, next: next };
  }

  function parsePeople(o) {
    if (!isObj(o) || !Array.isArray(o.people)) return null;
    return o.people.filter(isObj).filter(function (p) { return int(p, 'id') != null; })
      .map(function (p) { return { id: p.id, name: name120(p, 'name'), publicKey: b64(p.publicKey) }; });
  }

  function parseSaveResults(o) {
    if (!isObj(o) || !Array.isArray(o.results)) return null;
    return o.results.filter(function (r) { return isObj(r) && typeof r.id === 'string'; }).map(function (r) {
      return { id: r.id, ok: r.ok === true, rev: int(r, 'rev'), seq: long(r, 'seq'), code: errorCode(r), current: parseItem(r.current) };
    });
  }

  function parseHistory(o) {
    if (!isObj(o) || !Array.isArray(o.history)) return null;
    return o.history.filter(function (h) { return isObj(h) && int(h, 'rev') != null && int(h, 'keyRev') != null && b64(h.blob); })
      .map(function (h) { return { rev: h.rev, keyRev: h.keyRev, blob: h.blob, updatedAt: optStr(h, 'updatedAt'), updatedBy: int(h, 'updatedBy'), device: optStr(h, 'device', 80) }; });
  }

  function parseEmergency(o) {
    if (!isObj(o) || !isObj(o.grantor) || !isObj(o.grantee)) return null;
    if (typeof o.id !== 'string' || !EMERGENCY_ID_RE.test(o.id)) return null;
    if (int(o.grantor, 'id') == null || int(o.grantee, 'id') == null || int(o, 'waitHours') == null) return null;
    if (EMERGENCY_STATES.indexOf(o.status) < 0) return null;
    return {
      id: o.id,
      grantor: { id: o.grantor.id, name: name120(o.grantor, 'name') },
      grantee: { id: o.grantee.id, name: name120(o.grantee, 'name') },
      waitHours: o.waitHours, status: o.status,
      requestedAt: optStr(o, 'requestedAt'), releaseAt: optStr(o, 'releaseAt'), grantedAt: optStr(o, 'grantedAt'),
    };
  }

  function parseEmergencyList(o) {
    if (!isObj(o) || !Array.isArray(o.granted) || !Array.isArray(o.received)) return null;
    return { granted: o.granted.map(parseEmergency).filter(Boolean), received: o.received.map(parseEmergency).filter(Boolean) };
  }

  function parseAccess(o) {
    if (!isObj(o) || !isObj(o.grantor) || !Array.isArray(o.vaults)) return null;
    var g = o.grantor;
    var a = {
      sealedKey: b64(o.sealedKey),
      grantor: { id: int(g, 'id'), name: name120(g, 'name'), publicKey: b64(g.publicKey), privateKeyEnc: b64(g.privateKeyEnc) },
      vaults: o.vaults.map(parseVault).filter(Boolean),
    };
    return a.sealedKey && a.grantor.id != null && a.grantor.publicKey && a.grantor.privateKeyEnc ? a : null;
  }

  function parseItemsPage(o) {
    if (!isObj(o)) return null;
    var seq = long(o, 'seq');
    var next = long(o, 'next');
    if (seq == null || next == null) return null;
    return { seq: seq, items: parseItems(o.items), more: o.more === true, next: next };
  }

  /** Splits saves into POST items requests: ≤ 100 entries and about ≤ 48 KB each. */
  function batches(list, maxBytes, maxItems) {
    var mb = maxBytes || BATCH_BYTES;
    var mi = maxItems || BATCH_ITEMS;
    var out = [];
    var cur = [];
    var size = 0;
    list.forEach(function (s) {
      var b = s.blob.length + s.id.length + s.vaultId.length + 80;
      if (cur.length && (size + b > mb || cur.length >= mi)) { out.push(cur); cur = []; size = 0; }
      cur.push(s);
      size += b;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  /** The key generation a save must use now: the new one during a key change. */
  var wantedKeyRev = function (v) { return v.pending ? v.pending.keyRev : v.keyRev; };
  var canWrite = function (v) { return !!v && (v.role === 'write' || v.role === 'manage'); };
  var canManage = function (v) { return !!v && v.role === 'manage'; };

  // ── the tab's copy (online only: nothing is stored, nothing waits to be sent) ──

  /** { account, seq, vaults, items: Map, fresh: [vault ids whose older entries are still to fetch] } */
  function emptyState() { return { account: null, seq: 0, vaults: [], items: new Map(), fresh: [] }; }

  /**
   * One page of GET sync into the copy: the vault list is complete (a missing vault is gone with its entries), a
   * tombstone drops the entry, an older copy (lower seq or revision) never replaces a newer one.
   */
  function mergePage(state, page) {
    var vaultIds = new Set(page.vaults.map(function (v) { return v.id; }));
    var had = new Set(state.vaults.map(function (v) { return v.id; }));
    var added = state.seq > 0 ? page.vaults.filter(function (v) { return !had.has(v.id); }).map(function (v) { return v.id; }) : [];
    var fresh = Array.from(new Set((state.fresh || []).concat(added))).filter(function (id) { return vaultIds.has(id); });
    var items = new Map();
    state.items.forEach(function (it, id) { if (vaultIds.has(it.vaultId)) items.set(id, it); });
    page.items.forEach(function (i) {
      var cur = items.get(i.id);
      if (cur && (i.seq < cur.seq || (i.state !== 'purged' && i.rev < cur.rev))) return;
      if (i.state === 'purged') items.delete(i.id);
      else items.set(i.id, i);
    });
    return { account: page.account || state.account, seq: state.seq, vaults: page.vaults, items: items, fresh: fresh };
  }

  /** One entry answered by the server (trash, restore, purge, a save's conflict) into the copy. */
  function putItem(state, item) {
    var items = new Map(state.items);
    var cur = items.get(item.id);
    if (cur && item.seq && cur.seq > item.seq) return state;
    if (item.state === 'purged') items.delete(item.id);
    else items.set(item.id, item);
    return Object.assign({}, state, { items: items });
  }

  /** A save the server took ({ id, vaultId, blob, keyRev, baseRev } + result { rev, seq }) as the entry's new version. */
  function savedItem(state, sent, res, extra) {
    var e = extra || {};
    var old = state.items.get(sent.id);
    return putItem(state, {
      id: sent.id, vaultId: sent.vaultId, rev: res.rev || sent.baseRev + 1, keyRev: sent.keyRev, blob: sent.blob,
      state: old && old.state === 'trash' ? 'trash' : 'live', trashedAt: old ? old.trashedAt : null,
      updatedAt: e.updatedAt || null, updatedBy: e.updatedBy == null ? null : e.updatedBy, device: e.device || null,
      seq: res.seq || (old ? old.seq : 0),
    });
  }

  function putVault(state, v) {
    var has = state.vaults.some(function (x) { return x.id === v.id; });
    var vaults = has ? state.vaults.map(function (x) { return x.id === v.id ? v : x; }) : state.vaults.concat([v]);
    return Object.assign({}, state, { vaults: vaults });
  }

  function dropVault(state, vaultId) {
    var items = new Map();
    state.items.forEach(function (it, id) { if (it.vaultId !== vaultId) items.set(id, it); });
    return Object.assign({}, state, { vaults: state.vaults.filter(function (v) { return v.id !== vaultId; }), items: items, fresh: (state.fresh || []).filter(function (x) { return x !== vaultId; }) });
  }

  // ── entry JSON v1 ────────────────────────────────────────

  var ENTRY_KNOWN = new Set(['v', 'type', 'title', 'fav', 'notes', 'urls', 'apps', 'fields', 'custom']);
  var strings = function (a) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && x.trim() !== ''; }) : []; };

  /** An entry's plaintext in the shape every platform writes; unknown keys kept; null for another version / type. */
  function normalizeEntry(input) {
    if (!isObj(input)) return null;
    if (input.v !== undefined && input.v !== 1) return null;
    if (TYPES.indexOf(input.type) < 0) return null;
    var out = {};
    Object.keys(input).forEach(function (k) {
      if (!ENTRY_KNOWN.has(k) && input[k] !== undefined) Object.defineProperty(out, k, { value: clone(input[k]), enumerable: true, writable: true, configurable: true });
    });
    out.v = 1;
    out.type = input.type;
    out.title = typeof input.title === 'string' ? input.title : '';
    if (input.fav === true) out.fav = true;
    if (typeof input.notes === 'string' && input.notes !== '') out.notes = input.notes;
    out.urls = strings(input.urls);
    out.apps = strings(input.apps);
    var fields = {};
    if (isObj(input.fields)) {
      Object.keys(input.fields).sort().forEach(function (k) {
        var v = input.fields[k];
        if (typeof v === 'string' && v !== '') fields[k] = v;
      });
    }
    out.fields = fields;
    out.custom = (Array.isArray(input.custom) ? input.custom : []).filter(isObj)
      .map(function (c) { return { name: typeof c.name === 'string' ? c.name : '', value: typeof c.value === 'string' ? c.value : '', secret: c.secret === true }; })
      .filter(function (c) { return c.name.trim() !== '' || c.value !== ''; });
    return out;
  }

  var field = function (d, k) { return d && d.fields && typeof d.fields[k] === 'string' ? d.fields[k] : ''; };
  var entryUsername = function (d) { return field(d, 'username') || field(d, 'email'); };

  /** The second line of a list row — never a secret. */
  function entrySubtitle(d) {
    switch (d.type) {
      case 'login': return entryUsername(d);
      case 'card': {
        var n = field(d, 'number').replace(/\D/g, '');
        return n.length >= 4 ? '•••• ' + n.slice(-4) : field(d, 'holder');
      }
      case 'wifi': return [field(d, 'ssid'), field(d, 'security')].filter(Boolean).join(' · ');
      case 'identity': return field(d, 'name') || field(d, 'email');
      default: return '';
    }
  }

  /** A list row (no secrets) of a decrypted entry { id, vaultId, rev, trashed, …, data }. */
  function entrySummary(e) {
    var d = e.data;
    var sub = entrySubtitle(d);
    var host = d.urls.map(urlHost).filter(Boolean)[0] || null;
    return {
      id: e.id, vaultId: e.vaultId, rev: e.rev, type: d.type, title: d.title, subtitle: sub, username: entryUsername(d),
      urls: d.urls.slice(0, 20), host: host, fav: d.fav === true, trashed: e.trashed === true,
      sub: [sub, host && host !== sub ? host : ''].filter(Boolean).join(' · '),
    };
  }

  // ── 2FA codes (TOTP, RFC 6238) ───────────────────────────

  var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(text) {
    if (typeof text !== 'string') return null;
    var s = text.toUpperCase().replace(/[\s=-]/g, '');
    if (!s || /[^A-Z2-7]/.test(s)) return null;
    var out = [];
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 5) | B32.indexOf(s[i]);
      bits += 5;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
      acc &= (1 << bits) - 1;
    }
    return out.length ? Uint8Array.from(out) : null;
  }

  function decodePart(s) {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; }
  }

  function otpQuery(uri) {
    var i = uri.indexOf('?');
    var q = i < 0 ? '' : uri.slice(i + 1).split('#')[0];
    var out = {};
    q.split('&').forEach(function (kv) {
      var j = kv.indexOf('=');
      var k = (j < 0 ? kv : kv.slice(0, j)).toLowerCase();
      if (k && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = decodePart(j < 0 ? '' : kv.slice(j + 1));
    });
    return out;
  }

  /** otpauth://totp/… or a bare base32 secret → { secret, algorithm, digits, period } or null. */
  function parseTotp(text) {
    if (typeof text !== 'string') return null;
    var f = text.trim();
    if (!f) return null;
    if (!/^otpauth:\/\//i.test(f)) {
      var secret = base32Decode(f);
      return secret ? { secret: secret, algorithm: 'SHA1', digits: 6, period: 30 } : null;
    }
    if (!/^totp/i.test(f.slice(10))) return null;
    var q = otpQuery(f);
    var sec = base32Decode(q.secret || '');
    if (!sec) return null;
    var algorithm = (q.algorithm || 'SHA1').toUpperCase();
    if (['SHA1', 'SHA256', 'SHA512'].indexOf(algorithm) < 0) return null;
    var d = /^\d{1,2}$/.test(q.digits || '') ? Number(q.digits) : 6;
    var p = /^\d{1,4}$/.test(q.period || '') ? Number(q.period) : 30;
    return { secret: sec, algorithm: algorithm, digits: d >= 6 && d <= 8 ? d : 6, period: p >= 10 && p <= 300 ? p : 30 };
  }

  /** The issuer / account an otpauth URI names (a new entry's title), else null. */
  function totpLabel(text) {
    if (typeof text !== 'string' || !/^otpauth:\/\//i.test(text)) return null;
    var issuer = otpQuery(text).issuer;
    if (issuer && issuer.trim()) return issuer;
    var rest = text.slice(text.indexOf('://') + 3);
    var slash = rest.indexOf('/');
    var label = (slash < 0 ? '' : decodePart(rest.slice(slash + 1).split('?')[0])).split(':')[0];
    return label.trim() ? label : null;
  }

  /** The code now → { code, secondsLeft, period, digits }. */
  function totpCode(p, nowMs) {
    var N = root.VaultNoble;
    var secs = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
    var counter = Math.floor(secs / p.period);
    var msg = new Uint8Array(8);
    var hi = Math.floor(counter / 0x100000000);
    var lo = counter >>> 0;
    msg[0] = (hi >>> 24) & 255; msg[1] = (hi >>> 16) & 255; msg[2] = (hi >>> 8) & 255; msg[3] = hi & 255;
    msg[4] = (lo >>> 24) & 255; msg[5] = (lo >>> 16) & 255; msg[6] = (lo >>> 8) & 255; msg[7] = lo & 255;
    var hash = p.algorithm === 'SHA512' ? N.sha512 : p.algorithm === 'SHA256' ? N.sha256 : N.sha1;
    var h = N.hmac(hash, p.secret, msg);
    var o = h[h.length - 1] & 0x0f;
    var bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    var code = String(bin % Math.pow(10, p.digits)).padStart(p.digits, '0');
    return { code: code, secondsLeft: p.period - (secs % p.period), period: p.period, digits: p.digits };
  }

  /** '482913' → '482 913' (8 digits: 4 + 4). */
  function prettyCode(code) {
    var c = str(code);
    if (c.length === 6) return c.slice(0, 3) + ' ' + c.slice(3);
    if (c.length === 8) return c.slice(0, 4) + ' ' + c.slice(4);
    return c;
  }

  // ── password generator and strength ──────────────────────

  var GEN = {
    lower: 'abcdefghijkmnopqrstuvwxyzl',
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZIO',
    digits: '2345678901',
    symbols: '!#$%&*+-=?@^_~',
    ambiguous: 'l1IO0',
    consonants: 'bdfgkmnprstvz',
    vowels: 'aeiou',
  };
  var pick = function (s) { return s[randomInt(s.length)]; };
  var clampInt = function (v, min, max, def) { return Number.isSafeInteger(v) ? Math.min(max, Math.max(min, v)) : def; };

  function generatorOptions(o) {
    var x = isObj(o) ? o : {};
    return {
      words: x.words === true, length: clampInt(x.length, 8, 64, 20), upper: x.upper !== false, digits: x.digits !== false,
      symbols: x.symbols !== false, avoidAmbiguous: x.avoidAmbiguous === true, wordCount: clampInt(x.wordCount, 3, 8, 4),
    };
  }

  /** A new password: characters (each chosen class at least once) or made-up words joined by "-", one with a number. */
  function generatePassword(opts) {
    var o = generatorOptions(opts);
    var i;
    if (o.words) {
      var list = [];
      for (i = 0; i < o.wordCount; i++) {
        var w = '';
        var syllables = 2 + randomInt(2);
        for (var j = 0; j < syllables; j++) w += pick(GEN.consonants) + pick(GEN.vowels);
        list.push(w[0].toUpperCase() + w.slice(1));
      }
      var k = randomInt(list.length);
      list[k] += String(2 + randomInt(98));
      return list.join('-');
    }
    var clean = function (s) { return o.avoidAmbiguous ? s.split('').filter(function (c) { return GEN.ambiguous.indexOf(c) < 0; }).join('') : s; };
    var classes = [clean(GEN.lower)];
    if (o.upper) classes.push(clean(GEN.upper));
    if (o.digits) classes.push(clean(GEN.digits));
    if (o.symbols) classes.push(GEN.symbols);
    var all = classes.join('');
    var out = [];
    for (i = 0; i < o.length; i++) out.push(pick(all));
    var places = [];
    for (i = 0; i < o.length; i++) places.push(i);
    for (i = 0; i < classes.length; i++) {
      var r = i + randomInt(places.length - i);
      var t = places[i]; places[i] = places[r]; places[r] = t;
      out[places[i]] = pick(classes[i]);
    }
    return out.join('');
  }

  /** Rough entropy in bits: the character pool per class used and the length; repeats count less. */
  function passwordBits(password) {
    if (typeof password !== 'string' || !password) return 0;
    var chars = Array.from(password);
    var pool = 0;
    if (chars.some(function (c) { return /\p{Ll}/u.test(c); })) pool += 26;
    if (chars.some(function (c) { return /\p{Lu}/u.test(c); })) pool += 26;
    if (chars.some(function (c) { return /\p{Nd}/u.test(c); })) pool += 10;
    if (chars.some(function (c) { return !/[\p{L}\p{Nd}]/u.test(c); })) pool += 33;
    var effective = Math.min(chars.length, new Set(chars).size * 1.5);
    return effective * Math.log2(Math.max(pool, 10));
  }

  /** 'weak' | 'fair' | 'strong' | 'very_strong' */
  function passwordStrength(password) {
    var b = passwordBits(password);
    if (typeof password !== 'string' || Array.from(password).length < 10 || b < 50) return 'weak';
    if (b < 70) return 'fair';
    if (b < 100) return 'strong';
    return 'very_strong';
  }

  var wordCount = function (pw) { return typeof pw === 'string' ? pw.split(/[\s\-_.]+/).filter(function (w) { return w.length >= 2; }).length : 0; };

  /** The master password rule: at least 12 characters and not weak. */
  var goodMasterPassword = function (pw) { return typeof pw === 'string' && Array.from(pw).length >= MIN_MASTER && passwordStrength(pw) !== 'weak'; };

  /** Master password form: { ok, hint } (≥ 12 characters, not weak, both the same). */
  function masterCheck(password, repeat) {
    var pw = str(password);
    if (!pw) return { ok: false, hint: null };
    if (!goodMasterPassword(pw)) return { ok: false, hint: 'pw_rule' };
    if (!str(repeat)) return { ok: false, hint: null };
    if (pw !== str(repeat)) return { ok: false, hint: 'pw_mismatch' };
    return { ok: true, hint: 'pw_match' };
  }

  // ── web addresses ────────────────────────────────────────

  var SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'or', 'ne', 'go']);

  function urlHost(url) {
    if (typeof url !== 'string') return null;
    var s = url.trim().toLowerCase();
    if (!s) return null;
    var i = s.indexOf('://');
    if (i >= 0) s = s.slice(i + 3);
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.slice(s.lastIndexOf('@') + 1).split(':')[0].replace(/\.+$/, '');
    if (s.indexOf('www.') === 0) s = s.slice(4);
    if (!s || !/^[\p{L}\p{Nd}.-]+$/u.test(s)) return null;
    return s;
  }

  function siteOf(host) {
    if (/^[\d.]+$/.test(host)) return host;
    var parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    var tld = parts[parts.length - 1];
    var sld = parts[parts.length - 2];
    var n = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
    return parts.slice(-n).join('.');
  }

  /** A web address with a scheme to show as a link (https:// added to a bare host), or null (javascript:, file: …). */
  function openableUrl(url) {
    var u = str(url).trim();
    if (!u || /\s/.test(u)) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(u)) return null;
    return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(u) ? 'https://' + u : null;
  }

  // ── import ───────────────────────────────────────────────

  function entry(type, title, extra) {
    var o = { v: 1, type: type, title: title };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return normalizeEntry(o);
  }
  function nonEmpty(o) {
    var out = {};
    Object.keys(o).forEach(function (k) { if (typeof o[k] === 'string' && o[k] !== '') out[k] = o[k]; });
    return out;
  }
  var numText = function (o, k) { return typeof o[k] === 'string' ? o[k] : typeof o[k] === 'number' ? String(o[k]) : ''; };
  var assign = function (a, b) { return Object.assign({}, a, b); };

  function bitwardenItem(i) {
    var name = sget(i, 'name') || '';
    var base = {
      fav: i.favorite === true,
      notes: sget(i, 'notes') || '',
      custom: (Array.isArray(i.fields) ? i.fields : []).filter(isObj)
        .map(function (f) { return { name: sget(f, 'name') || '', value: sget(f, 'value') || '', secret: f.type === 1 }; })
        .filter(function (c) { return c.name.trim() || c.value.trim(); }),
    };
    switch (i.type) {
      case 1: {
        var l = isObj(i.login) ? i.login : {};
        var urls = (Array.isArray(l.uris) ? l.uris : []).filter(isObj).map(function (u) { return sget(u, 'uri'); }).filter(Boolean);
        return entry('login', name.trim() ? name : (urls.map(urlHost).filter(Boolean)[0] || ''), assign(base, {
          urls: urls,
          apps: urls.filter(function (u) { return u.indexOf('androidapp://') === 0; }).map(function (u) { return u.slice('androidapp://'.length); }),
          fields: nonEmpty({ username: sget(l, 'username') || '', password: sget(l, 'password') || '', totp: sget(l, 'totp') || '' }),
        }));
      }
      case 2: return entry('note', name, base);
      case 3: {
        var c = isObj(i.card) ? i.card : {};
        var month = numText(c, 'expMonth').padStart(2, '0');
        var year = numText(c, 'expYear').slice(-2);
        return entry('card', name, assign(base, {
          fields: nonEmpty({ holder: sget(c, 'cardholderName') || '', number: sget(c, 'number') || '', expiry: month !== '00' && year ? month + '/' + year : '', cvc: sget(c, 'code') || '' }),
        }));
      }
      case 4: {
        var d = isObj(i.identity) ? i.identity : {};
        var s = function (k) { return sget(d, k) || ''; };
        var full = [s('firstName'), s('middleName'), s('lastName')].filter(function (x) { return x.trim(); }).join(' ');
        var address = [s('address1'), s('address2'), [s('postalCode'), s('city')].filter(Boolean).join(' '), s('country')].filter(function (x) { return x.trim(); }).join(', ');
        return entry('identity', name, assign(base, { fields: nonEmpty({ name: full, email: s('email'), phone: s('phone'), address: address }) }));
      }
      default: return null;
    }
  }

  function bitwardenJson(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return { ok: false, code: 'unknown' }; }
    if (!isObj(o)) return { ok: false, code: 'unknown' };
    if (o.encrypted === true) return { ok: false, code: 'encrypted' };
    if (!Array.isArray(o.items)) return { ok: false, code: 'unknown' };
    return { ok: true, source: 'Bitwarden', entries: o.items.filter(isObj).map(bitwardenItem).filter(Boolean) };
  }

  /** RFC 4180 rows: quotes, doubled quotes, line breaks inside quotes; comma or semicolon separated. */
  function csvRows(text) {
    var firstLine = text.split('\n')[0];
    var count = function (c) { return firstLine.split(c).length - 1; };
    var sep = count(';') > count(',') ? ';' : ',';
    var rows = [];
    var row = [];
    var cell = '';
    var quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\r') { /* CR LF */ }
      else if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim(); }); });
  }

  var CSV_COLUMNS = {
    title: ['title', 'name', 'account', 'item name'],
    url: ['url', 'login_uri', 'uri', 'website', 'web site', 'login url', 'origin'],
    username: ['username', 'login_username', 'user name', 'login name', 'user', 'login', 'email', 'e-mail'],
    password: ['password', 'login_password'],
    notes: ['notes', 'note', 'extra', 'comments'],
    totp: ['totp', 'login_totp', 'otpauth', 'one-time password', 'otp'],
    type: ['type'],
    favorite: ['favorite', 'favourite'],
  };

  function csv(text) {
    var rows = csvRows(text);
    if (rows.length < 2) return { ok: false, code: 'unknown' };
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var col = {};
    Object.keys(CSV_COLUMNS).forEach(function (k) {
      var n = CSV_COLUMNS[k].filter(function (x) { return header.indexOf(x) >= 0; })[0];
      col[k] = n === undefined ? -1 : header.indexOf(n);
    });
    if (col.password < 0 && col.notes < 0) return { ok: false, code: 'unknown' };
    var source = 'CSV';
    if (header.indexOf('login_uri') >= 0) source = 'Bitwarden';
    else if (header.indexOf('httprealm') >= 0) source = 'Firefox';
    else if (header.indexOf('group') >= 0) source = 'KeePass';
    else if (header.indexOf('otpauth') >= 0) source = '1Password';
    else if (header.slice(0, 5).join(',') === 'name,url,username,password,note') source = 'Chrome / Edge';
    var raw = function (r, k) { return col[k] >= 0 && r[col[k]] !== undefined ? r[col[k]] : ''; };
    var get = function (r, k) { return raw(r, k).trim(); };
    var out = [];
    rows.slice(1).forEach(function (r) {
      var url = get(r, 'url');
      var password = raw(r, 'password');
      var username = get(r, 'username');
      var notes = get(r, 'notes');
      var title = get(r, 'title') || urlHost(url) || '';
      var isNote = get(r, 'type') === 'note' || (!password.trim() && !username && !url);
      if (!title.trim() && !password.trim() && !notes.trim()) return;
      if (isNote) out.push(entry('note', title.trim() ? title : notes.slice(0, 40), { notes: notes }));
      else out.push(entry('login', title, { notes: notes, fav: get(r, 'favorite') === '1', urls: url ? [url] : [], fields: nonEmpty({ username: username, password: password, totp: get(r, 'totp') }) }));
    });
    return { ok: true, source: source, entries: out.filter(Boolean) };
  }

  /** An export of another password manager → { ok: true, source, entries } | { ok: false, code: 'encrypted' | 'unknown' }. */
  function parseImport(text) {
    if (typeof text !== 'string') return { ok: false, code: 'unknown' };
    var t = text.replace(/^\uFEFF/, '').trim();
    return t.charAt(0) === '{' ? bitwardenJson(t) : csv(t);
  }

  function importCounts(entries) {
    var n = function (f) { return entries.filter(f).length; };
    return {
      total: entries.length,
      logins: n(function (e) { return e.type === 'login'; }),
      withTotp: n(function (e) { return field(e, 'totp'); }),
      notes: n(function (e) { return e.type === 'note'; }),
      cards: n(function (e) { return e.type === 'card'; }),
    };
  }

  function dupKey(e) {
    var host = e.urls.length ? urlHost(e.urls[0]) : null;
    return [e.title.trim().toLowerCase(), entryUsername(e).trim().toLowerCase(), host ? siteOf(host) : ''].join('\n');
  }

  /** Is each found entry a duplicate (same title, user name and site) of one in `existing` or earlier in the list? */
  function duplicateFlags(found, existing) {
    var have = new Set(existing.map(dupKey));
    var seen = new Set();
    return found.map(function (e) {
      var k = dupKey(e);
      var dup = have.has(k) || seen.has(k);
      seen.add(k);
      return dup;
    });
  }

  // ── export ───────────────────────────────────────────────

  var EXPORT_COLUMNS = ['vault', 'type', 'title', 'favorite', 'url', 'username', 'password', 'totp', 'notes', 'fields'];
  var csvCell = function (v) { return '"' + str(v).replace(/"/g, '""') + '"'; };

  /**
   * Decrypted entries [{ data, vaultName }] → CSV text (UTF-8 with BOM, CRLF): one row per entry; a login's user
   * name, password, 2FA key and first web address in their own columns (other password managers and this
   * importer read them), everything else of the entry as "name: value" lines in `fields`.
   */
  function exportCsv(list) {
    var lines = [EXPORT_COLUMNS.join(',')];
    list.forEach(function (x) {
      var d = x.data;
      var own = ['username', 'password', 'totp'];
      var rest = [];
      Object.keys(d.fields || {}).forEach(function (k) { if (own.indexOf(k) < 0) rest.push(k + ': ' + d.fields[k]); });
      d.urls.slice(1).forEach(function (u) { rest.push('url: ' + u); });
      d.apps.forEach(function (a) { rest.push('app: ' + a); });
      d.custom.forEach(function (c) { rest.push((c.name || 'field') + ': ' + c.value); });
      lines.push([x.vaultName, d.type, d.title, d.fav ? '1' : '', d.urls[0] || '', field(d, 'username'), field(d, 'password'), field(d, 'totp'), d.notes || '', rest.join('\n')].map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // ── Wi-Fi QR code ────────────────────────────────────────

  var wifiEsc = function (s) { return str(s).replace(/([\\;,:"])/g, '\\$1'); };

  /** The text of a Wi-Fi QR code (WIFI:T:WPA;S:…;P:…;;) or null without a network name. */
  function wifiQrText(d) {
    var ssid = field(d, 'ssid');
    if (!ssid) return null;
    var pw = field(d, 'password');
    var sec = field(d, 'security').toUpperCase();
    var t = !pw || /^(NONE|OFFEN|OPEN|KEINE)$/.test(sec) ? 'nopass' : /WEP/.test(sec) ? 'WEP' : /SAE|WPA3/.test(sec) && !/WPA2/.test(sec) ? 'SAE' : 'WPA';
    return 'WIFI:T:' + t + ';S:' + wifiEsc(ssid) + ';' + (t === 'nopass' ? '' : 'P:' + wifiEsc(pw) + ';') + ';';
  }

  /** The QR modules of a text (ui/vendor/noble.js: uqr, Nayuki's encoder) → { size, data: boolean[][] } or null. */
  function qrMatrix(text) {
    try {
      var q = root.VaultNoble.qrEncode(text, { ecc: 'M', border: 0 });
      return { size: q.size, data: q.data };
    } catch (e) {
      return null;
    }
  }

  // ── page helpers ─────────────────────────────────────────

  /** First letter or digit of a title, upper case ('#' without one). */
  function letter(title) {
    var m = /[\p{L}\p{N}]/u.exec(str(title));
    return m ? m[0].toLocaleUpperCase('de-DE') : '#';
  }

  /** One of five tones by title (Java's String.hashCode, like the apps). */
  function tone(title) {
    var s = str(title).toLowerCase();
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return ((h % 5) + 5) % 5;
  }

  var fold = function (s) { return str(s).toLocaleLowerCase('de-DE').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); };

  /** Does a summary match the search (every word in title, sub line, user name, host or a web address)? */
  function matches(e, query) {
    var words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var hay = fold([e.title, e.subtitle, e.username, e.host].concat(e.urls || []).join('\n'));
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /**
   * The middle list: { vaultId | 'all' | 'favorites' | 'trash', query } over summaries → sections
   * [{ key: 'favorites' | 'all' | 'trash', items }]; favourites first (no search, all or one vault).
   */
  function listSections(summaries, filter) {
    var f = filter || {};
    var q = str(f.query).trim();
    var trash = f.vaultId === 'trash';
    var list = summaries.filter(function (e) {
      if (e.trashed !== trash) return false;
      if (f.vaultId === 'favorites' && !e.fav) return false;
      if (f.vaultId && ['all', 'favorites', 'trash'].indexOf(f.vaultId) < 0 && e.vaultId !== f.vaultId) return false;
      return matches(e, q);
    });
    if (trash) return [{ key: 'trash', items: list }];
    if (f.vaultId === 'favorites') return [{ key: 'favorites', items: list }];
    var favs = list.filter(function (e) { return e.fav; });
    if (!favs.length || q) return [{ key: 'all', items: list }];
    return [{ key: 'favorites', items: favs }, { key: 'all', items: list }];
  }

  /** Masked text of a secret: dots (8–14). A card number: •••• 1234. */
  var mask = function (value) { return '•'.repeat(Math.min(Math.max(str(value).length, 8), 14)); };
  function maskedNumber(value) {
    var n = str(value).replace(/\D/g, '');
    return n.length >= 4 ? '•••• ' + n.slice(-4) : mask(value);
  }

  /** A new entry's draft. */
  function emptyDraft(type, vaultId) {
    var tp = TYPES.indexOf(type) >= 0 ? type : 'login';
    return { id: null, vaultId: vaultId || null, type: tp, title: '', fav: false, notes: '', urls: tp === 'login' ? [''] : [], apps: [], fields: {}, custom: [], extra: {} };
  }

  /** A decrypted entry ({ id, vaultId, data }) → draft (unknown keys kept in `extra`). */
  function draftFrom(e) {
    var d = (e && e.data) || {};
    var extra = {};
    Object.keys(d).forEach(function (k) { if (!ENTRY_KNOWN.has(k)) extra[k] = d[k]; });
    var type = TYPES.indexOf(d.type) >= 0 ? d.type : 'login';
    var urls = Array.isArray(d.urls) ? d.urls.map(str) : [];
    var fields = {};
    if (isObj(d.fields)) Object.keys(d.fields).forEach(function (k) { fields[k] = str(d.fields[k]); });
    return {
      id: e && e.id ? e.id : null, vaultId: e && e.vaultId ? e.vaultId : null, type: type, title: str(d.title), fav: d.fav === true,
      notes: str(d.notes), urls: type === 'login' && !urls.length ? [''] : urls, apps: Array.isArray(d.apps) ? d.apps.map(str) : [],
      fields: fields,
      custom: Array.isArray(d.custom) ? d.custom.filter(isObj).map(function (c) { return { name: str(c.name), value: str(c.value), secret: c.secret === true }; }) : [],
      extra: extra,
    };
  }

  /** Draft → entry JSON v1 (fields of other types stay; empty values and rows go). */
  function draftToData(draft) {
    var d = draft || emptyDraft('login');
    var out = {};
    Object.keys(d.extra || {}).forEach(function (k) { Object.defineProperty(out, k, { value: d.extra[k], enumerable: true, writable: true, configurable: true }); });
    out.v = 1;
    out.type = d.type;
    out.title = str(d.title).trim();
    if (d.fav) out.fav = true;
    if (str(d.notes).trim()) out.notes = str(d.notes);
    out.urls = (d.urls || []).map(function (u) { return str(u).trim(); }).filter(Boolean);
    out.apps = (d.apps || []).map(function (u) { return str(u).trim(); }).filter(Boolean);
    var fields = {};
    Object.keys(d.fields || {}).forEach(function (k) {
      var val = str(d.fields[k]);
      if (val.trim() !== '') fields[k] = k === 'totp' ? val.trim() : val;
    });
    out.fields = fields;
    out.custom = (d.custom || []).map(function (c) { return { name: str(c.name).trim(), value: str(c.value), secret: c.secret === true }; })
      .filter(function (c) { return c.name !== '' || c.value !== ''; });
    return normalizeEntry(out);
  }

  /** null when the draft can be saved, else the text key of what is missing. */
  function draftError(draft) {
    if (!draft || TYPES.indexOf(draft.type) < 0) return 'err.invalid';
    if (!str(draft.title).trim()) return 'edit.title_required';
    if (!draft.vaultId) return 'err.invalid';
    if (draft.fields && str(draft.fields.totp).trim() && !parseTotp(draft.fields.totp)) return 'totp.invalid';
    return null;
  }

  function draftChanged(a, b) {
    return JSON.stringify(draftToData(a)) !== JSON.stringify(draftToData(b)) || str(a && a.vaultId) !== str(b && b.vaultId);
  }

  /** 'K7QF-2MXP-…' → ['K7QF', '2MXP', …]. */
  var recoveryGroups = function (key) { return str(key).toUpperCase().split(/[\s-]+/).filter(Boolean); };
  var recoveryComplete = function (text) { return str(text).replace(/[\s-]/g, '').length === 56; };

  /** Waiting time label: { key: 'em.days' | 'em.hours', count }. */
  function waitParts(hours) {
    var h = Number(hours) || 0;
    return h >= 48 && h % 24 === 0 ? { key: 'em.days', count: h / 24 } : { key: 'em.hours', count: h };
  }

  /** Time until releaseAt → { hours, minutes } (0 when past). */
  function remaining(releaseAt, now) {
    var ms = Date.parse(str(releaseAt));
    var left = Number.isFinite(ms) ? Math.max(0, ms - (now == null ? Date.now() : now)) : 0;
    var min = Math.floor(left / 60000);
    return { hours: Math.floor(min / 60), minutes: min % 60 };
  }

  /** People one can add to a vault: not a member yet, with Vault first, then by name. */
  function candidates(people, members) {
    var inVault = new Set((members || []).map(function (m) { return m.userId; }));
    return (people || []).filter(function (p) { return !inVault.has(p.id); }).sort(function (a, b) {
      var ha = !!a.publicKey;
      var hb = !!b.publicKey;
      return ha === hb ? str(a.name).localeCompare(str(b.name), 'de', { sensitivity: 'base' }) : ha ? -1 : 1;
    });
  }

  /** An API failure (GC.call rejection or { ok: false }) → its code: 'network' when there was no answer at all. */
  function failureCode(err) {
    if (!err) return 'failed';
    if (typeof err.code === 'string' && CODE_RE.test(err.code)) return err.code;
    var c = errorCode(err.data);
    if (c) return c;
    if (err.status === 0 || err.message === 'timeout' || err.message === 'network error') return 'network';
    if (err.status === 413) return 'too_large';
    if (err.status === 429) return 'rate_limited';
    return 'failed';
  }

  root.VaultLogic = Object.freeze({
    ID_RE: ID_RE, EMERGENCY_ID_RE: EMERGENCY_ID_RE, ROLES: ROLES, TYPES: TYPES, FIELDS: FIELDS, WAIT_CHOICES: WAIT_CHOICES,
    BATCH_BYTES: BATCH_BYTES, BATCH_ITEMS: BATCH_ITEMS, MIN_MASTER: MIN_MASTER, EXPORT_COLUMNS: EXPORT_COLUMNS,
    randomInt: randomInt, isId: isId, errorCode: errorCode, failureCode: failureCode,
    parseKdf: parseKdf, parseAccount: parseAccount, parseAccountAnswer: parseAccountAnswer, parseVault: parseVault,
    parseItem: parseItem, parseSync: parseSync, parsePeople: parsePeople, parseSaveResults: parseSaveResults,
    parseHistory: parseHistory, parseEmergency: parseEmergency, parseEmergencyList: parseEmergencyList,
    parseAccess: parseAccess, parseItemsPage: parseItemsPage, batches: batches, wantedKeyRev: wantedKeyRev,
    canWrite: canWrite, canManage: canManage,
    emptyState: emptyState, mergePage: mergePage, putItem: putItem, savedItem: savedItem, putVault: putVault, dropVault: dropVault,
    normalizeEntry: normalizeEntry, field: field, entryUsername: entryUsername, entrySubtitle: entrySubtitle, entrySummary: entrySummary,
    base32Decode: base32Decode, parseTotp: parseTotp, totpLabel: totpLabel, totpCode: totpCode, prettyCode: prettyCode,
    generatorOptions: generatorOptions, generatePassword: generatePassword, passwordBits: passwordBits,
    passwordStrength: passwordStrength, wordCount: wordCount, goodMasterPassword: goodMasterPassword, masterCheck: masterCheck,
    urlHost: urlHost, siteOf: siteOf, openableUrl: openableUrl,
    csvRows: csvRows, parseImport: parseImport, importCounts: importCounts, duplicateFlags: duplicateFlags,
    exportCsv: exportCsv, wifiQrText: wifiQrText, qrMatrix: qrMatrix,
    letter: letter, tone: tone, matches: matches, listSections: listSections, mask: mask, maskedNumber: maskedNumber,
    emptyDraft: emptyDraft, draftFrom: draftFrom, draftToData: draftToData, draftError: draftError, draftChanged: draftChanged,
    recoveryGroups: recoveryGroups, recoveryComplete: recoveryComplete, waitParts: waitParts, remaining: remaining, candidates: candidates,
  });
}(typeof window !== 'undefined' ? window : globalThis));
