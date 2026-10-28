/* Drive (gatecontrol-drive) — vault folders in the portal tab (since 1.9.0): window.DriveVault.
 *
 * The portal's own device for vaults: an X25519 key made here whose private key cannot be exported, kept by GateControl's
 * page (GC.keys, GateControl ≥ 1.211.0 — the frame has no storage), one per person ("drive-device-<id>"). With it:
 *   * make a vault (its name, the recovery key shown once: copy, save as a text file, "Ich habe ihn aufbewahrt"),
 *   * open one: the keys wrapped for this device (GET vaults/<id>/keys) — or ask for it (a request with the safety
 *     number; an approved device of someone who reads the area approves), or open it with the recovery key,
 *   * names decrypted in the list, new folders, rename, upload (encrypted here, GC.upload of the ciphertext),
 *     download (the ciphertext through GC.mediaBytes, decrypted here),
 *   * approve or decline other devices, a new key after someone left (rotation; a new recovery key when its holder left).
 * Everything with DriveVaultCrypto (ui/vaultcrypto.js); keys of vaults live in memory only. The server never gets a
 * name, a content or a key it could read.
 *
 * Since 1.11.0 the vaults are in the menu only (list()), a new one goes into the top folder of the area chosen ("Wer darf
 * ihn öffnen?"), and they lock (like OneDrive's personal vault): opening one is a click on "Entsperren" (the keys are
 * unwrapped then, not on their own); after the minutes of the Drive settings without anything done in the tab
 * (touch()), when the tab is left (if so set) and always when it is closed, lockAll() overwrites the vault keys in
 * memory, forgets the decrypted names and closes a vault shown. A confirmation of the device (WebAuthn) is not possible
 * here: the frame has an opaque origin, which WebAuthn refuses — only the apps ask for a fingerprint or Windows Hello.
 *
 * portal.js calls DriveVault.attach(ui) with its helpers and asks it: nameOf(node), prepare(folder, items),
 * renderLocked(main), banner(main), upload(u), onEvent(data), names(items), load(), list(), touch(), lockAll(why),
 * anyOpen(), deviceInfo().
 */
(function () {
  'use strict';

  var VC = window.DriveVaultCrypto;
  var MAX_UPLOAD = 100 * 1024 * 1024 - 4096; // GC.upload takes ≤ 100 MB; the ciphertext is a little larger
  var READ_WINDOW = 8 * 1048576 + 8 * 16;

  function attach(U) {
    var T = U.T;
    var h = U.h;
    var st = {
      support: null,       // null: not checked, true / false
      device: null,        // { privateKey, publicKey, publicRaw, id }
      vaults: new Map(),   // vault id → the server's view
      keys: new Map(),     // vault id → Map(keyVersion → TK)
      names: new Map(),    // node id → its name (decrypted)
      state: new Map(),    // vault id → 'approved' | 'pending' | 'none' | 'error'
      loading: null,
      lastUse: Date.now(), // the last thing done in the tab (touch)
      timer: null,
    };

    function err(code) { var e = new Error(code); e.code = code; return e; }

    // ── support and the device key ─────────────────────────

    function supported() {
      if (st.support != null) return Promise.resolve(st.support);
      var gc = window.GC;
      if (!VC || !gc || !gc.keys || typeof gc.keys.get !== 'function' || typeof gc.mediaBytes !== 'function' || !window.crypto || !window.crypto.subtle) {
        st.support = false;
        return Promise.resolve(false);
      }
      return VC.supported().then(function (ok) { st.support = ok; return ok; });
    }

    function keyName() { return 'drive-device-' + String(U.CTX.viewer || 0); }

    /** The device key of this browser (made and kept on first use). */
    function device() {
      if (st.device) return Promise.resolve(st.device);
      return window.GC.keys.get(keyName()).then(function (kp) {
        if (kp && kp.privateKey && kp.publicKey) return kp;
        return VC.generateDeviceKey().then(function (fresh) {
          return window.GC.keys.put(keyName(), { publicKey: fresh.publicKey, privateKey: fresh.privateKey }).then(function () { return fresh; });
        });
      }).then(function (kp) {
        return VC.exportPublic(kp.publicKey).then(function (raw) {
          return VC.deviceId(raw).then(function (id) {
            st.device = { privateKey: kp.privateKey, publicKey: kp.publicKey, publicRaw: raw, id: id };
            return st.device;
          });
        });
      });
    }

    function deviceName() {
      var ua = String(navigator.userAgent || '');
      var b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : T('p.v.browser');
      return T('p.v.device_portal', { browser: b });
    }

    // ── vaults and their keys ──────────────────────────────

    function loadVaults() {
      return U.api('GET', 'vaults').then(function (r) {
        st.vaults = new Map();
        (r.vaults || []).forEach(function (v) { st.vaults.set(v.id, v); });
        return st.vaults;
      });
    }
    function vaultOf(id) {
      if (st.vaults.has(id)) return Promise.resolve(st.vaults.get(id));
      return loadVaults().then(function (m) { if (!m.has(id)) throw err('not_found'); return m.get(id); });
    }

    /** Unwrap every key of vault `v` for this device → its state ('approved' with keys, 'pending', 'none'). */
    function unlock(v) {
      return device().then(function (d) {
        return U.api('GET', 'vaults/' + encodeURIComponent(v.id) + '/keys', null, { deviceId: d.id }).then(function (r) {
          if (r.state !== 'approved') return r.state;
          var m = new Map();
          var chain = Promise.resolve();
          (r.keys || []).forEach(function (k) {
            chain = chain.then(function () { return VC.unwrapKey(k.wrap, d.privateKey, d.publicRaw, v.id, k.keyVersion).then(function (tk) { m.set(k.keyVersion, tk); }); });
          });
          return chain.then(function () { st.keys.set(v.id, m); return 'approved'; });
        }, function (e) {
          if (e && e.code === 'not_found') return 'none';
          throw e;
        });
      }).then(function (s) { st.state.set(v.id, s); return s; });
    }

    function keysOf(vaultId) { return st.keys.get(vaultId) || null; }
    function current(v) {
      var m = keysOf(v.id);
      return m ? m.get(v.keyVersion) : null;
    }

    /** The name of a node (decrypted, or a placeholder). */
    function nameOf(n) {
      if (!n) return '';
      if (!n.encrypted) return n.name;
      if (st.names.has(n.id)) return st.names.get(n.id);
      var v = st.vaults.get(n.vaultId);
      if (v && v.nodeId === n.id && st.names.has('vault:' + v.id)) return st.names.get('vault:' + v.id);
      return T('p.v.locked_name');
    }

    function decryptNames(vaultId, list) {
      var m = keysOf(vaultId);
      if (!m) return Promise.resolve();
      return Promise.all(list.filter(function (n) { return n && n.encrypted && n.vaultId === vaultId && n.nameCipher; }).map(function (n) {
        return VC.decryptName(m, vaultId, n.nameCipher).then(function (name) { st.names.set(n.id, name); }, function () { st.names.set(n.id, T('p.v.unreadable')); });
      }));
    }

    function vaultName(v) {
      var m = keysOf(v.id);
      if (!m || !v.nameCipher) return Promise.resolve(null);
      return VC.decryptName(m, v.id, v.nameCipher).then(function (name) { st.names.set(v.nodeId, name); st.names.set('vault:' + v.id, name); return name; }, function () { return null; });
    }

    /** What this browser may do with vault `v` without unwrapping a key: 'approved' | 'pending' | 'none'. */
    function probe(v) {
      return device().then(function (d) {
        return U.api('GET', 'vaults/' + encodeURIComponent(v.id) + '/keys', null, { deviceId: d.id }).then(function (r) { return r.state; }, function (e) {
          if (e && e.code === 'not_found') return 'none';
          throw e;
        });
      }).then(function (s) { st.state.set(v.id, s); return s; });
    }

    /**
     * Before a folder is shown: when it is a vault's (or holds vault nodes), decrypt the names of the vaults open here;
     * a locked one only learns what this browser may do (its lock screen: "Entsperren", ask, the recovery key). Never fails.
     */
    function prepare(folder, items) {
      var ids = {};
      if (folder && folder.encrypted) ids[folder.vaultId] = true;
      (items || []).forEach(function (n) { if (n.encrypted) ids[n.vaultId] = true; });
      var list = Object.keys(ids);
      if (!list.length) return Promise.resolve();
      idle();
      return supported().then(function (ok) {
        if (!ok) return null;
        return loadVaults().then(function () {
          return Promise.all(list.map(function (id) {
            var v = st.vaults.get(id);
            if (!v) return null;
            if (!keysOf(id)) return probe(v).catch(function () { st.state.set(id, 'error'); return 'error'; });
            return vaultName(v).then(function () { return decryptNames(id, (items || []).concat(folder ? [folder] : [])); });
          }));
        });
      }).catch(function () { /* shown as locked */ });
    }

    /** "Entsperren": the keys of vault `v` for this browser, then the folder again. */
    function open(v) {
      unlock(v).then(function (s) {
        if (s !== 'approved') { U.reload(); return; }
        touch();
        return vaultName(v).then(function () { U.renderNav(); U.reload(); });
      }).catch(function (e) { st.state.set(v.id, 'error'); U.fail(e); U.reload(); });
    }

    // ── the lock (since 1.11.0) ────────────────────────────

    function anyOpen() { return st.keys.size > 0; }

    /** Lock every vault: the keys overwritten and forgotten, the decrypted names too, a vault shown closes. */
    function lockAll(why) {
      var had = st.keys.size > 0;
      st.keys.forEach(function (m) { m.forEach(function (tk) { try { VC.wipe(tk); } catch (e) { /* not a byte array */ } }); m.clear(); });
      st.keys.clear();
      st.names.clear();
      st.state.clear();
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (!had) return false;
      if (why !== 'closed') {
        U.leaveVault();
        if (why !== 'manual') U.toast(T('p.v.locked_now'));
      }
      return true;
    }

    /** Too long without anything done in the tab: lock (the minutes of the Drive settings; 0: never). → locked */
    function idle() {
      var mins = Number(U.prefs().lockMinutes) || 0;
      if (!mins || !st.keys.size) return false;
      if (Date.now() - st.lastUse < mins * 60000) return false;
      return lockAll('idle');
    }

    /** Something was done in the tab: first lock when it came too late, then the time starts again. */
    function touch() {
      idle();
      st.lastUse = Date.now();
      schedule();
    }

    /** The check while a vault is open (every 15 s; a timer that never keeps anything alive). */
    function schedule() {
      if (st.timer || !st.keys.size) return;
      st.timer = setTimeout(function () { st.timer = null; idle(); schedule(); }, 15000);
      if (st.timer && st.timer.unref) st.timer.unref();
    }

    // the tab left (another tab or window in front): lock when so set; closed: always
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && U.prefs().lockHidden) lockAll('hidden');
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', function () { lockAll('closed'); });
      window.addEventListener('beforeunload', function () { lockAll('closed'); });
    }

    /** The vaults for the menu: [{ id, nodeId, areaId, name (null while locked), unlocked }]. */
    function list() {
      var out = [];
      st.vaults.forEach(function (v) {
        var open = !!keysOf(v.id);
        out.push({ id: v.id, nodeId: v.nodeId, areaId: v.areaId, unlocked: open, name: open && st.names.has('vault:' + v.id) ? st.names.get('vault:' + v.id) : null });
      });
      return out;
    }

    /** The settings' facts: supported, the safety number of this browser, the vaults it is approved for (names while open). */
    function deviceInfo() {
      return supported().then(function (ok) {
        if (!ok) return { supported: false };
        // only an existing key: the settings make none
        return window.GC.keys.get(keyName()).then(function (kp) {
          if (!kp || !kp.publicKey) return { supported: true, number: null, vaults: [] };
          return device().then(function (d) {
            return Promise.all([VC.safetyNumber(d.publicRaw), loadVaults()]).then(function (x) {
              var names = [];
              st.vaults.forEach(function (v) {
                var mine = (v.myDevices || []).some(function (m) { return m.deviceId === d.id && m.state === 'approved'; });
                if (!mine) return;
                var a = U.areaOf(v.areaId);
                names.push((keysOf(v.id) && st.names.get('vault:' + v.id)) || (T('p.v.locked_name') + ' · ' + U.vaultScope(a)));
              });
              return { supported: true, number: x[0], vaults: names };
            });
          });
        });
      });
    }

    // ── the lock screen ────────────────────────────────────

    /** In a vault this browser cannot open (yet): the lock screen → true (handled). */
    function renderLocked(main) {
      var f = U.S.folder;
      if (!f || !f.encrypted) return false;
      if (st.support === false) {
        main.appendChild(lockBox(T('p.v.unsupported_title'), T('p.v.unsupported_text'), []));
        return true;
      }
      if (keysOf(f.vaultId)) return false;
      var v = st.vaults.get(f.vaultId);
      var s = st.state.get(f.vaultId);
      var acts = [];
      var text = T('p.v.locked_text');
      // approved here and locked (since 1.11.0): open it with a click
      if (s === 'approved' && v) {
        main.appendChild(lockBox(T('p.v.unlock_title'), T('p.v.unlock_text'), [U.btn(T('p.v.unlock'), function () { open(v); }, { primary: true, icon: 'lock' })]));
        return true;
      }
      if (s === 'pending') {
        text = T('p.v.pending_text');
        acts.push(U.btn(T('p.v.show_number'), function () { showMyNumber(); }));
        acts.push(U.btn(T('p.v.check_again'), function () { st.state.delete(f.vaultId); U.reload(); }));
      } else if (v) {
        acts.push(U.btn(T('p.v.ask'), function () { ask(v); }, { primary: true, icon: 'lock' }));
      }
      if (v) acts.push(U.btn(T('p.v.recover'), function () { recover(v); }, { icon: 'key' }));
      if (s === 'error') text = T('p.v.error_text');
      main.appendChild(lockBox(T('p.v.locked_title'), text, acts));
      return true;
    }
    function lockBox(title, text, acts) {
      return h('div', { class: 'dp-vault-lock' }, [U.icon('lock', 34), h('b', { text: title }), h('p', { class: 'dp-hint', text: text }), acts.length ? h('div', { class: 'dp-actions' }, acts) : null]);
    }

    function showMyNumber() {
      device().then(function (d) { return VC.safetyNumber(d.publicRaw); }).then(function (num) {
        U.dialog(T('p.v.number_title'), [h('p', { class: 'dp-hint', text: T('p.v.number_text') }), h('p', { class: 'dp-safety', text: num })]);
      }, U.fail);
    }

    /** Ask for vault `v`: register this browser (pending), show the safety number to compare. */
    function ask(v) {
      device().then(function (d) {
        return U.api('POST', 'vaults/' + encodeURIComponent(v.id) + '/devices', { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' });
      }).then(function (r) {
        st.state.set(v.id, r.device.state);
        return VC.safetyNumber(VC.unb64u(r.device.publicKey)).then(function (num) {
          U.dialog(T('p.v.asked_title'), [h('p', { class: 'dp-hint', text: T('p.v.asked_text') }), h('p', { class: 'dp-safety', text: num }),
            h('div', { class: 'dp-actions' }, [U.btn(T('p.close'), function () { U.closeDialog(); U.reload(); }, { primary: true })])]);
        });
      }).catch(U.fail);
    }

    /** Open vault `v` with the recovery key: this browser approves itself with the keys the recovery key opens. */
    function recover(v) {
      var input = h('textarea', { class: 'dp-input dp-recovery-in', attrs: { rows: '3', spellcheck: 'false', autocomplete: 'off', 'aria-label': T('p.v.recovery_key') } });
      var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        errBox.textContent = '';
        var key;
        try { key = VC.parseRecoveryKey(input.value); } catch (e) { errBox.textContent = T('p.v.recovery_wrong'); return; }
        var rec;
        var auth;
        Promise.all([VC.recoveryKeyPair(key), VC.recoveryAuth(key)]).then(function (x) {
          rec = x[0];
          auth = x[1];
          VC.wipe(key);
          return U.api('GET', 'vaults/' + encodeURIComponent(v.id) + '/recovery');
        }).then(function (r) {
          if (VC.b64u(rec.publicRaw) !== r.recoveryPub) throw err('recovery_wrong');
          var m = new Map();
          var chain = Promise.resolve();
          (r.keys || []).forEach(function (k) {
            chain = chain.then(function () { return VC.unwrapKey(k.wrap, rec.privateKey, rec.publicRaw, v.id, k.keyVersion).then(function (tk) { m.set(k.keyVersion, tk); }); });
          });
          return chain.then(function () { return m; });
        }).then(function (m) {
          return device().then(function (d) {
            return U.api('POST', 'vaults/' + encodeURIComponent(v.id) + '/devices', { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' }).then(function () {
              return wrapAll(m, d.publicRaw, v.id);
            }).then(function (wraps) {
              return U.api('POST', 'vaults/' + encodeURIComponent(v.id) + '/devices/' + encodeURIComponent(d.id) + '/approve', { wraps: wraps, via: 'recovery', recoveryAuth: auth });
            });
          }).then(function () { st.keys.set(v.id, m); st.state.set(v.id, 'approved'); });
        }).then(function () { U.closeDialog(); U.toast(T('p.v.recovered')); U.reload(); }, function (e) {
          errBox.textContent = e && (e.code === 'recovery_wrong' || e.code === 'decrypt') ? T('p.v.recovery_wrong') : U.errText(e);
        });
      };
      U.dialog(T('p.v.recover'), [h('p', { class: 'dp-hint', text: T('p.v.recover_text') }), input, errBox,
        h('div', { class: 'dp-actions' }, [U.btn(T('p.cancel'), U.closeDialog), U.btn(T('p.v.open'), go, { primary: true })])]);
      input.focus();
    }

    /** Every key of `m` wrapped for public key `pubRaw` → [{ keyVersion, wrap }]. */
    function wrapAll(m, pubRaw, vaultId) {
      var out = [];
      var chain = Promise.resolve();
      m.forEach(function (tk, kv) { chain = chain.then(function () { return VC.wrapKey(tk, pubRaw, vaultId, kv).then(function (w) { out.push({ keyVersion: kv, wrap: w }); }); }); });
      return chain.then(function () { return out; });
    }

    // ── the banner: requests, a new key ────────────────────

    function banner(main) {
      var f = U.S.folder;
      if (!f || !f.encrypted || !keysOf(f.vaultId)) return;
      var v = st.vaults.get(f.vaultId);
      if (!v) return;
      if (v.pending > 0) {
        main.appendChild(h('div', { class: 'dp-note dp-vault-note' }, [U.icon('lock'), h('span', { text: U.P('p.v.pending_n', v.pending) }),
          U.btn(T('p.v.review'), function () { review(v); }, { small: true })]));
      }
      if (v.needsRotation) {
        main.appendChild(h('div', { class: 'dp-note dp-vault-note' }, [U.icon('key'), h('span', { text: T('p.v.rotate_note') }),
          U.canWrite() ? U.btn(T('p.v.rotate'), function () { rotate(v); }, { small: true }) : null]));
      }
    }

    /** The devices asking for vault `v`: compare the number, approve or decline. */
    function review(v) {
      U.api('GET', 'vaults/' + encodeURIComponent(v.id) + '/devices').then(function (r) {
        var pending = (r.devices || []).filter(function (d) { return d.state === 'pending'; });
        var box = h('div', { class: 'dp-vault-reqs' });
        var chain = Promise.resolve();
        pending.forEach(function (d) {
          chain = chain.then(function () { return VC.safetyNumber(VC.unb64u(d.publicKey)); }).then(function (num) {
            var row = h('div', { class: 'dp-vault-req' }, [
              h('div', null, [h('b', { text: (U.personName(d.userId) || '') + (d.name ? ' · ' + d.name : '') }), h('span', { class: 'dp-meta', text: U.fmtDate(d.createdAt) })]),
              h('p', { class: 'dp-safety', text: num }),
              h('div', { class: 'dp-actions' }, [
                U.btn(T('p.v.decline'), function () { U.api('DELETE', 'vaults/' + encodeURIComponent(v.id) + '/devices/' + encodeURIComponent(d.deviceId)).then(function () { if (row.parentNode) row.parentNode.removeChild(row); loadVaults(); }, U.fail); }, { small: true, danger: true }),
                U.btn(T('p.v.approve'), function () {
                  wrapAll(keysOf(v.id), VC.unb64u(d.publicKey), v.id).then(function (wraps) {
                    return U.api('POST', 'vaults/' + encodeURIComponent(v.id) + '/devices/' + encodeURIComponent(d.deviceId) + '/approve', { wraps: wraps });
                  }).then(function () { if (row.parentNode) row.parentNode.removeChild(row); U.toast(T('p.v.approved')); loadVaults().then(function () { U.renderMain(); }); }, U.fail);
                }, { small: true, primary: true }),
              ]),
            ]);
            box.appendChild(row);
          });
        });
        chain.then(function () {
          U.dialog(T('p.v.review_title'), [h('p', { class: 'dp-hint', text: T('p.v.review_text') }), pending.length ? box : h('p', { class: 'dp-hint', text: T('p.v.none_pending') })], { wide: true });
        });
      }, U.fail);
    }

    /** A new vault key for exactly the approved devices (and the recovery key; a new one when its holder left). */
    function rotate(v, newRecovery) {
      var m = keysOf(v.id);
      if (!m) return;
      var next = v.keyVersion + 1;
      var tk = VC.newVaultKey();
      var rec = newRecovery ? VC.newRecoveryKey() : null;
      U.api('GET', 'vaults/' + encodeURIComponent(v.id) + '/devices').then(function (r) {
        var approved = (r.devices || []).filter(function (d) { return d.state === 'approved'; });
        var wraps = [];
        var chain = Promise.resolve();
        approved.forEach(function (d) { chain = chain.then(function () { return VC.wrapKey(tk, VC.unb64u(d.publicKey), v.id, next).then(function (w) { wraps.push({ deviceId: d.deviceId, wrap: w }); }); }); });
        return chain.then(function () {
          if (!rec) return VC.wrapKey(tk, VC.unb64u(v.recoveryPub), v.id, next).then(function (w) { return { keyVersion: next, wraps: wraps, recoveryWrap: w }; });
          return Promise.all([VC.recoveryKeyPair(rec.key), VC.recoveryAuth(rec.key)]).then(function (x) {
            var all = new Map(m);
            all.set(next, tk);
            return wrapAll(all, x[0].publicRaw, v.id).then(function (rw) { return { keyVersion: next, wraps: wraps, recovery: { pub: VC.b64u(x[0].publicRaw), auth: x[1], wraps: rw } }; });
          });
        });
      }).then(function (body) {
        var send = function () {
          return U.api('POST', 'vaults/' + encodeURIComponent(v.id) + '/rotate', body).then(function (r) {
            m.set(next, tk);
            st.vaults.set(v.id, r.vault);
            U.toast(T('p.v.rotated'));
            U.renderMain();
          });
        };
        if (!rec) return send();
        return showRecovery(rec.text, T('p.v.rotate_recovery_text'), send);
      }).catch(function (e) {
        if (e && e.code === 'conflict' && e.extra && e.extra.reason === 'recovery_required') { rotate(v, true); return; }
        if (e && e.code === 'conflict' && e.extra && e.extra.devices) { loadVaults().then(function () { rotate(st.vaults.get(v.id) || v, newRecovery); }); return; }
        U.fail(e);
      });
    }

    // ── a new vault ────────────────────────────────────────

    /** Show a recovery key once: copy, save as text, "kept" → then(onKept). */
    function showRecovery(text, hint, onKept) {
      return new Promise(function (resolve, reject) {
        var kept = h('input', { type: 'checkbox' });
        var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
        var go = h('button', { type: 'button', class: 'dp-btn dp-btn-primary', disabled: true, on: { click: function () {
          go.disabled = true;
          Promise.resolve(onKept()).then(function (x) { U.closeDialog(); resolve(x); }, function (e) { go.disabled = false; errBox.textContent = U.errText(e); });
        } } }, h('span', { text: T('p.v.recovery_done') }));
        kept.addEventListener('change', function () { go.disabled = !kept.checked; });
        var save = function () {
          if (!window.GC || typeof window.GC.saveFile !== 'function') { U.copyText(text); return; }
          window.GC.saveFile(new Blob([T('p.v.recovery_file', { key: text }) + '\n'], { type: 'text/plain' }), T('p.v.recovery_filename')).catch(function () { U.copyText(text); });
        };
        var box = U.dialog(T('p.v.recovery_title'), [
          h('p', { class: 'dp-hint', text: hint }),
          h('p', { class: 'dp-recovery', text: text }),
          h('div', { class: 'dp-actions' }, [U.btn(T('p.v.copy'), function () { U.copyText(text); }, { icon: 'copy' }), U.btn(T('p.v.save'), save, { icon: 'download' })]),
          h('label', { class: 'dp-check' }, [kept, h('span', { text: T('p.v.recovery_kept') })]),
          errBox,
          h('div', { class: 'dp-actions' }, [U.btn(T('p.cancel'), function () { U.closeDialog(); reject(err('cancelled')); }), go]),
        ], { wide: true });
        var x = box.querySelector('.dp-ib');
        if (x) x.addEventListener('click', function () { reject(err('cancelled')); });
      });
    }

    /**
     * "Neuer Tresor" (the menu "Neu"): its name and who may open it — my files, the family, a team folder; it goes into the
     * top folder of that area (the server puts it there too), wherever "Neu" was chosen. `from`: the folder shown.
     */
    function create(from) {
      supported().then(function (ok) {
        if (!ok) { U.dialog(T('p.v.unsupported_title'), [h('p', { class: 'dp-hint', text: T('p.v.unsupported_text') })]); return; }
        var targets = U.vaultTargets();
        if (!targets.length) { U.toast(T('err.forbidden'), 'error'); return; }
        var pick = targets.filter(function (x) { return from && x.areaId === from.areaId; })[0] || targets[0];
        var input = h('input', { class: 'dp-input', type: 'text', value: T('p.v.new_name'), attrs: { maxlength: '255', 'aria-label': T('p.name') } });
        var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
        var choices = h('fieldset', { class: 'dp-choices' }, [h('legend', { class: 'dp-label', text: T('p.v.who') })]);
        targets.forEach(function (x) {
          var radio = h('input', { type: 'radio', checked: x === pick, attrs: { name: 'dp-vault-who', value: x.areaId }, on: { change: function () { pick = x; } } });
          choices.appendChild(h('label', { class: 'dp-choice' }, [radio, h('span', { class: 'dp-choice-tx' }, [h('span', { class: 'dp-name', text: x.label }), h('span', { class: 'dp-meta dp-wrap', text: x.hint })])]));
        });
        var mins = Number(U.prefs().lockMinutes) || 0;
        var go = function () {
          errBox.textContent = '';
          var name = input.value.trim();
          if (!name) { errBox.textContent = T('err.invalid'); return; }
          var target = pick;
          make(target, name).then(function () { /* done or cancelled */ }, function (e) { errBox.textContent = U.errText(e); });
        };
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
        U.dialog(T('p.v.new'), [
          h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.name') }), input]),
          choices,
          h('div', { class: 'dp-note' }, [U.icon('lock'), h('span', { text: mins ? T('p.v.new_note', { minutes: mins }) : T('p.v.new_note_nolock') })]),
          errBox,
          h('div', { class: 'dp-actions' }, [U.btn(T('p.cancel'), U.closeDialog), U.btn(T('p.v.next'), go, { primary: true })]),
        ]);
        input.focus();
        try { input.setSelectionRange(0, input.value.length); } catch (e) { /* not a text field */ }
      });
    }

    /** Make vault `name` in the top folder of `target` ({ areaId, rootId }): the keys here, the recovery key shown first. */
    function make(target, name) {
      return device().then(function (d) {
        var id = VC.newVaultId();
        var tk = VC.newVaultKey();
        var rec = VC.newRecoveryKey();
        return VC.recoveryKeyPair(rec.key).then(function (kp) {
          return Promise.all([VC.encryptName(tk, id, 1, name), VC.wrapKey(tk, kp.publicRaw, id, 1), VC.wrapKey(tk, d.publicRaw, id, 1), VC.recoveryAuth(rec.key)]).then(function (x) {
            return { id: id, tk: tk, rec: rec, body: { id: id, parentId: target.rootId, nameCipher: x[0], recoveryPub: VC.b64u(kp.publicRaw), recoveryAuth: x[3], recoveryWrap: x[1],
              device: { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' }, wrap: x[2] } };
          });
        });
      }).then(function (plan) {
        U.closeDialog();
        // the name dialog closes; the recovery key comes next and the vault is made once it is kept
        setTimeout(function () {
          showRecovery(plan.rec.text, T('p.v.recovery_text'), function () {
            return U.api('POST', 'vaults', plan.body).then(function (r) {
              st.keys.set(plan.id, new Map([[1, plan.tk]]));
              st.state.set(plan.id, 'approved');
              st.vaults.set(plan.id, r.vault);
              st.names.set(r.node.id, name);
              st.names.set('vault:' + plan.id, name);
              touch();
              U.toast(T('p.v.created', { name: name }));
              U.renderNav();
            });
          }).catch(function () { /* cancelled: nothing was made */ });
        }, 0);
      });
    }

    // ── inside a vault: folders, names, files ──────────────

    function folderVault() {
      var f = U.S.folder;
      return f && f.encrypted ? st.vaults.get(f.vaultId) : null;
    }

    function newFolder(parent) {
      var v = st.vaults.get(parent.vaultId);
      U.askName(T('p.new_folder'), T('p.new_folder_name'), T('p.create'), function (name) {
        if (taken(name)) return Promise.reject(err('exists'));
        return VC.encryptName(current(v), v.id, v.keyVersion, name).then(function (c) {
          return U.api('POST', 'nodes', { parentId: parent.id, encrypted: true, nameCipher: c, keyVersion: v.keyVersion });
        }).then(function (r) { st.names.set(r.node.id, name); U.reload(); });
      });
    }

    /** A name shown in this folder already (case does not matter) → its node. */
    function taken(name, except) {
      var low = String(name).toLowerCase();
      return (U.S.items || []).filter(function (n) { return n.id !== except && nameOf(n).toLowerCase() === low; })[0] || null;
    }

    function rename(n) {
      var v = st.vaults.get(n.vaultId);
      U.askName(T('p.rename'), nameOf(n), T('p.save'), function (name) {
        if (taken(name, n.id)) return Promise.reject(err('exists'));
        return VC.encryptName(current(v), v.id, v.keyVersion, name).then(function (c) {
          return U.api('PATCH', 'nodes/' + n.id, { nameCipher: c });
        }).then(function () { st.names.set(n.id, name); U.reload(); U.toast(T('p.renamed')); });
      });
    }

    /** Decrypt file `n` (or one of its versions: `content` of GET …/versions/<vid>/content) → a download. */
    function download(n, content) {
      var m = keysOf(n.vaultId);
      if (!m) { U.toast(T('p.v.locked_title'), 'error'); return; }
      var name = nameOf(n);
      var got = content ? Promise.resolve(content) : U.api('GET', 'nodes/' + n.id + '/content');
      U.toast(T('p.v.decrypting'));
      got.then(function (c) {
        var read = function (a, b) { return window.GC.mediaBytes(c.url, { start: a, end: b }).then(function (x) { return new Uint8Array(x.data); }); };
        return VC.decryptContent(m, n.vaultId, read, c.size, { window: READ_WINDOW });
      }).then(function (parts) {
        var blob = new Blob(parts, { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = h('a', { attrs: { href: url, download: name, rel: 'noopener' } });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      }).catch(function (e) { U.toast(e && e.code === 'decrypt' ? T('p.v.unreadable') : U.errText(e), 'error'); });
    }

    /**
     * An upload into a vault folder (portal.js pump): encrypt here, GC.upload the ciphertext, commit with the encrypted
     * name. A name shown in the folder already asks like any upload (a new version, both, skip). → 'done' | 'skipped'
     */
    function upload(u, askConflict) {
      var v = st.vaults.get(u.vaultId);
      if (!v || !current(v)) return Promise.reject(err('vault_locked'));
      if (u.file.size > MAX_UPLOAD) return Promise.reject(err('vault_too_large'));
      var same = u.parentId === (U.S.folder && U.S.folder.id) ? taken(u.file.name) : null;
      var choice = same ? (U.S.conflictAll ? Promise.resolve(U.S.conflictAll) : askConflict(u.file.name, same.isDir)) : Promise.resolve(null);
      return choice.then(function (c) {
        if (c === 'skip') return 'skipped';
        if (same && same.isDir && c === 'version') c = 'rename';
        var asVersion = same && c === 'version';
        var name = asVersion ? u.file.name : (same ? freeName(u.file.name) : u.file.name);
        return VC.encryptContent(current(v), v.id, v.keyVersion, u.file, { onProgress: function (done) { u.loaded = Math.round(done / 2); U.renderUploads(); } }).then(function (parts) {
          var blob = new Blob(parts, { type: 'application/octet-stream' });
          return window.GC.upload(blob, { onProgress: function (p) { u.loaded = Math.round(u.file.size / 2 + ((p && p.loaded) || 0) / 2); U.renderUploads(); } });
        }).then(function (up) {
          return VC.encryptName(current(v), v.id, v.keyVersion, name).then(function (c2) {
            var body = { mediaId: up.mediaId, parentId: u.parentId, encrypted: true, nameCipher: c2, keyVersion: v.keyVersion, mtime: u.file.lastModified || undefined };
            if (asVersion) { body.name = same.name; body.onConflict = 'version'; }
            return U.api('POST', 'uploads/commit', body);
          });
        }).then(function (r) { st.names.set(r.node.id, name); return 'done'; });
      });
    }
    function freeName(name) {
      var dot = name.lastIndexOf('.');
      var base = dot > 0 ? name.slice(0, dot) : name;
      var ext = dot > 0 ? name.slice(dot) : '';
      for (var i = 2; i < 1000; i++) { var c = base + ' (' + i + ')' + ext; if (!taken(c)) return c; }
      return name;
    }

    /** Names of trashed or listed vault nodes (the trash, the storage page): decrypted where a key is here. */
    function names(items) {
      var by = {};
      (items || []).forEach(function (n) { if (n && n.encrypted) (by[n.vaultId] = by[n.vaultId] || []).push(n); });
      var ids = Object.keys(by);
      if (!ids.length) return Promise.resolve();
      return prepare(null, items).then(function () { return Promise.all(ids.map(function (id) { return decryptNames(id, by[id]); })); });
    }

    /** A live event 'vault': a request, an approval, a new key — load the vaults again. */
    function onEvent(d) {
      if (!d || !d.vault) return;
      if (d.event === 'approved') st.state.delete(d.vault);
      loadVaults().then(function () {
        var v = st.vaults.get(d.vault);
        // a new key while the vault is open here: its keys again (it stays open)
        if (d.event === 'rotated' && v && keysOf(d.vault)) return unlock(v).then(function () { U.renderNav(); U.reload(); });
        U.renderNav();
        var f = U.S.folder;
        if (f && f.encrypted && f.vaultId === d.vault) U.renderMain();
      }).catch(function () { /* later */ });
    }

    return {
      cached: function (id) { return st.names.has(id) ? st.names.get(id) : null; },
      supported: supported, nameOf: nameOf, prepare: prepare, renderLocked: renderLocked, banner: banner, create: create, newFolder: newFolder,
      rename: rename, download: download, upload: upload, names: names, onEvent: onEvent, folderVault: folderVault, keysOf: keysOf,
      load: loadVaults, list: list, touch: touch, lockAll: lockAll, anyOpen: anyOpen, deviceInfo: deviceInfo,
    };
  }

  window.DriveVault = { attach: attach };
}());
