/* Tab "Quellen": Jellyfin servers and NAS shares — add, check, edit, replace the key / password, who sees them. */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;
  var S = null;
  var TD = null; // GC.targets.get(): routes, peers and the plugin's assignments

  function awayText(s) {
    var a = s.away || {};
    return a.mode === 'direct' ? T('away.direct', { address: a.address }) : T('away.vpn');
  }

  function accessText(s) {
    var a = s.access || {};
    if (a.mode === 'list') return T('access.list', { n: (a.users || []).length + (a.groups || []).length });
    return s.kind === 'share' ? T('access.all_share') : T('access.all_jf');
  }

  /** Home detection: unique (server ID / pinned certificate) or only a reachable port — the latter clearly marked. */
  function homeText(s) {
    var h = s.home || {};
    if (h.level === 'unique') return T((h.probes || []).some(function (p) { return p.kind === 'tls'; }) ? 'home.unique_tls' : 'home.unique_jf');
    if (h.level === 'weak') return T('home.weak', { ports: (h.probes || []).map(function (p) { return p.host + ':' + p.port; }).join(', ') });
    return T('home.none');
  }
  function homeNote(s) {
    var h = s.home || {};
    if (!s.enabled || h.level === 'unique') return null;
    return el('p', { class: 'md-note', 'data-home': h.level || 'none', text: T('home.note.' + (h.why === 'no_server_id' ? 'jf' : 'share')) });
  }

  function kv(rows) {
    var dl = el('dl', { class: 'md-kv' });
    rows.forEach(function (r) { if (r) { dl.appendChild(el('dt', { text: r[0] })); dl.appendChild(el('dd', null, [typeof r[1] === 'string' ? el('span', { text: r[1] }) : r[1]])); } });
    return dl;
  }

  /** The source's access target (null without one): its assignment in GC.targets, else the label the server knows. */
  function targetOf(s) {
    var c = s.config || {};
    var id = s.kind === 'jellyfin' ? 'jellyfin' : 'webdav';
    var index = s.kind === 'jellyfin' ? (c.targetIndex || 0) : (c.webdav && c.webdav.targetIndex != null ? c.webdav.targetIndex : null);
    if (index == null) return null;
    if (TD) { var a = P.assignedAt(TD, id, index); return { ok: !!a, text: a ? P.whereText(TD, a, id) : null }; }
    var l = labelOf(id, index);
    return { ok: (S.targets[id] || []).some(function (x) { return x.index === index; }), text: l || T('src.target_n', { n: index + 1 }) };
  }

  /** The lines under the title: "über <Route> · zu Hause direkt … · unterwegs …" and "Server-Freigabe: aktiv". */
  function lines(s) {
    var c = s.config || {};
    var tg = targetOf(s);
    var via = tg && tg.text ? [T('src.over') + ' ', el('b', { text: tg.text })] : [];
    var parts;
    if (s.kind === 'jellyfin') parts = via.concat([(via.length ? ' · ' : '') + T('src.home_direct', { address: c.address }) + ' · ' + awayText(s)]);
    else {
      parts = [c.smb ? 'SMB ' + c.smb.address : ''];
      if (c.webdav) parts = parts.concat([(c.smb ? ' · ' : '') + 'WebDAV ']).concat(via.length ? via : [c.webdav.address]);
    }
    var out = [el('p', { class: 'md-line' }, parts)];
    if (tg) out.push(el('p', { class: 'md-line', 'data-share': tg.ok ? 'on' : 'missing', text: T(tg.ok ? 'src.share_on' : 'src.share_missing') }));
    return out;
  }

  function card(s) {
    var c = s.config || {};
    var st = s.status || {};
    var tone = !s.enabled ? null : (st.ok ? 'good' : (st.at ? 'crit' : 'warn'));
    var head = el('div', { class: 'md-card-head' }, [
      el('h2', { class: 'md-card-title', text: (s.kind === 'jellyfin' ? 'Jellyfin · ' : T('src.share') + ' · ') + s.name }),
      P.badge(!s.enabled ? T('src.off') : (st.ok ? (st.version ? T('src.ok_version', { version: st.version }) : T('src.ok')) : (st.at ? T('src.problem') : T('src.unchecked'))), tone),
      s.enabled && s.home && s.home.level !== 'unique' ? P.badge(T('home.badge'), 'warn') : null,
    ]);
    var rows = s.kind === 'jellyfin' ? [
      [T('home.label'), homeText(s)],
      [T('src.key'), s.hasKey ? T('src.key_set') : T('src.key_missing')],
      [T('src.libraries'), (st.libraries || []).map(function (l) { return l.name; }).join(', ') || '–'],
      [T('src.visible'), accessText(s)],
      [T('src.downloads'), c.downloads === false ? T('common.no') : T('src.downloads_yes')],
      [T('src.devices'), String(s.devices || 0)],
    ] : [
      c.webdav && c.webdav.certSha256 ? [T('src.cert'), el('span', { class: 'md-mono', text: 'SHA-256 ' + c.webdav.certSha256.slice(0, 8) + '…' })] : null,
      [T('src.away'), awayText(s)],
      [T('home.label'), homeText(s)],
      [T('src.nas_user'), c.user + ' · ' + (s.hasPassword ? T('src.pw_set', { rev: s.secretRev }) : T('src.pw_missing'))],
      [T('src.visible'), accessText(s)],
      [T('src.devices_pw'), String(s.devices || 0)],
    ];
    var acts = el('div', { class: 'md-actions' }, [
      el('button', { type: 'button', class: 'btn btn-sm', text: T('src.check'), on: { click: function () { P.api('POST', 'admin/sources/' + s.id + '/check').then(function () { P.toast(T('src.checked')); load(); }).catch(P.warn); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('src.edit'), on: { click: function () { edit(s); } } }),
      s.kind === 'jellyfin'
        ? el('button', { type: 'button', class: 'btn btn-sm', text: T('src.key_replace'), on: { click: function () { secretDialog(s, 'key'); } } })
        : el('button', { type: 'button', class: 'btn btn-sm', text: T('src.pw_replace'), on: { click: function () { secretDialog(s, 'password'); } } }),
      s.kind === 'jellyfin' && st.quickConnect === false ? el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('src.qc_on'), on: { click: function () { qcOn(s); } } }) : null,
      el('button', { type: 'button', class: 'btn btn-sm', text: T('src.who'), on: { click: function () { who(s); } } }),
      el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('src.remove'), on: { click: function () { remove(s); } } }),
    ]);
    return el('section', { class: 'md-card', 'data-source': s.id }, [head].concat(lines(s)).concat([homeNote(s), kv(rows), P.checks(st), acts]));
  }

  function labelOf(kind, index) {
    var t = (S && S.targets && S.targets[kind]) || [];
    var x = t.filter(function (a) { return a.index === index; })[0];
    return x ? x.label : null;
  }

  function draw() {
    var list = P.clear($('#md-sources'));
    S.sources.forEach(function (s) { list.appendChild(card(s)); });
    $('#md-empty').hidden = S.sources.length > 0;
    $('#md-net-all').textContent = S.settings.awayDirectAll ? T('net.all_on') : T('net.all_off');
  }

  /** "Unterwegs": only through the VPN (recommended) or without it through an HTTPS address. */
  function awayFields(cur) {
    var a = cur || {};
    var mode = el('select', { class: 'form-select' }, [el('option', { value: 'vpn', text: T('away.mode_vpn') }), el('option', { value: 'direct', text: T('away.mode_direct') })]);
    mode.value = a.direct === true ? 'direct' : 'vpn';
    var addr = P.input({ type: 'url', value: a.address || '', placeholder: 'https://media.example.com' });
    var addrField = P.field(T('away.address'), addr, T('away.address_hint'));
    var sync = function () { addrField.hidden = mode.value !== 'direct'; };
    mode.addEventListener('change', sync);
    sync();
    return { addr: addr, node: el('div', null, [P.field(T('src.away'), mode, T('away.mode_hint')), addrField]),
      value: function () { return { direct: mode.value === 'direct', address: addr.value.trim() || null }; } };
  }

  /** The port of an address (http/https/smb), or the scheme's default. */
  function portOf(address, fallback) {
    try { var u = new URL(address); return u.port ? Number(u.port) : fallback; } catch (e) { return fallback; }
  }

  /** Fill `input` with `value` while it is empty or still holds what was suggested before. */
  function suggestInto(input, value) {
    var auto = input.getAttribute('data-suggested');
    if (input.value.trim() && input.value.trim() !== auto) return;
    input.value = value || '';
    input.setAttribute('data-suggested', value || '');
  }

  /** "Mit „Speichern“ erlaubst du dem Plugin, <Ziel> zu erreichen." — follows the choice. */
  function allowNote(td, id) {
    var n = el('p', { class: 'md-allow', role: 'status' });
    return { node: n, set: function (value) {
      var x = P.whereText(td, value, id);
      P.clear(n);
      if (!x) { n.textContent = T('where.pick_first'); return; }
      n.appendChild(document.createTextNode(T('where.allow_a') + ' '));
      n.appendChild(el('b', { text: x }));
      n.appendChild(document.createTextNode(' ' + T('where.allow_b')));
    } };
  }

  function advanced(kids) {
    return el('details', { class: 'md-adv' }, [el('summary', { text: T('src.advanced') })].concat(kids));
  }

  /** The dialog for a Jellyfin server: where it runs, the API key, the name from Jellyfin — the rest under "Erweitert". */
  function jellyfinForm(s, td) {
    var c = (s && s.config) || {};
    var where = P.whereChoice(td, 'jellyfin', s ? (c.targetIndex || 0) : null, P.likelyJellyfin);
    var key = P.input({ type: 'password', autocomplete: 'off', placeholder: s ? T('src.key_keep') : '' });
    var nameShow = el('div', { class: 'md-auto' }, [el('span', { text: s ? s.name : T('jf.name_pending') }), ' ', el('span', { class: 'md-hint', text: T('jf.name_auto') })]);
    var name = P.input({ value: s ? s.name : '', maxlength: 60, placeholder: T('jf.name_ph') });
    var address = P.input({ type: 'url', value: c.address || '', placeholder: 'http://192.168.1.20:8096' });
    if (s) address.setAttribute('data-suggested', P.suggestJellyfin(td, P.viaSelect(td, 'jellyfin', c.targetIndex || 0).value).home || '');
    var away = awayFields(c.away);
    var downloads = P.check(T('src.downloads_allow'), c.downloads !== false);
    var allow = allowNote(td, 'jellyfin');
    var result = el('div');
    var adv = advanced([P.field(T('src.name'), name, T('jf.name_hint')), P.field(T('src.address'), address, T('src.address_from_route')), away.node, downloads.node]);
    where.onChange(function (v) {
      var sg = P.suggestJellyfin(td, v);
      suggestInto(address, sg.home);
      suggestInto(away.addr, sg.away);
      allow.set(v);
    });
    if (!s) { var sg0 = P.suggestJellyfin(td, where.value()); suggestInto(address, sg0.home); suggestInto(away.addr, sg0.away); }
    allow.set(where.value());
    name.addEventListener('input', function () { nameShow.firstChild.textContent = name.value.trim() || (s ? s.name : T('jf.name_pending')); });
    var node = el('div', null, [el('h2', { class: 'md-card-title', text: s ? T('src.edit_title', { name: s.name }) : T('src.add_jellyfin') }),
      P.field(T('jf.where'), where.node), P.field(T('src.key'), key, T('src.key_hint')), P.field(T('src.name'), nameShow), allow.node, adv, result]);
    var get = function () {
      var v = where.value();
      if (!v) return Promise.reject(new Error(T('src.via_required')));
      var index;
      return P.ensureTarget('jellyfin', v, { port: portOf(address.value.trim(), 8096), scheme: 'http' }).then(function (i) {
        index = i;
        return P.api('POST', 'admin/probe', { targetIndex: index, key: key.value || null, sourceId: s ? s.id : null });
      }).then(function (r) {
        var ck = (r && r.check) || {};
        P.clear(result).appendChild(P.checks(Object.assign({ at: Date.now() }, ck)));
        if (!address.value.trim() && ck.localAddress) address.value = ck.localAddress;
        if (!address.value.trim()) { adv.open = true; throw new Error(T('jf.address_required')); }
        var nm = name.value.trim() || ck.serverName || (s ? s.name : '') || 'Jellyfin';
        nameShow.firstChild.textContent = nm;
        var b = { kind: 'jellyfin', name: nm, targetIndex: index, address: address.value.trim(), downloads: downloads.box.checked, away: away.value() };
        if (key.value) b.key = key.value;
        return b;
      });
    };
    return { node: node, get: get };
  }

  /** The dialog for a NAS share: where the NAS is, the share's name, user and password — SMB/WebDAV under "Erweitert". */
  function shareForm(s, td) {
    var c = (s && s.config) || {};
    var curDav = c.webdav && c.webdav.targetIndex != null ? c.webdav.targetIndex : null;
    var where = P.whereChoice(td, 'webdav', curDav, P.likelyNas);
    var folderOf = function (a) { try { var p = new URL(a).pathname.split('/').filter(Boolean); return p.length ? decodeURIComponent(p[0]) : ''; } catch (e) { return ''; } };
    var share = P.input({ value: s ? folderOf((c.smb && c.smb.address) || (c.webdav && c.webdav.address)) : '', placeholder: 'video', autocomplete: 'off' });
    var user = P.input({ value: c.user || '', placeholder: 'medien-lesen', autocomplete: 'off' });
    var pw = P.input({ type: 'password', autocomplete: 'off' });
    var name = P.input({ value: s ? s.name : '', maxlength: 60 });
    var smb = P.input({ value: c.smb ? c.smb.address : '', placeholder: 'smb://192.168.1.20/video' });
    var dav = P.input({ type: 'url', value: c.webdav ? c.webdav.address : '', placeholder: 'https://192.168.1.20:5006/video' });
    var cert = P.input({ value: c.webdav && c.webdav.certSha256 ? c.webdav.certSha256 : '', placeholder: '9c:41:…' });
    var away = awayFields(c.away);
    var allow = allowNote(td, 'webdav');
    if (s) {
      // what the dialog would suggest now counts as suggested: a new choice or share name updates it
      var sg1 = P.suggestShare(td, where.value(), share.value);
      [[smb, sg1.smb], [dav, sg1.webdav], [away.addr, sg1.away], [name, sg1.name]].forEach(function (x) { if (x[1] && x[0].value === x[1]) x[0].setAttribute('data-suggested', x[1]); });
    }
    var adv = advanced([P.field(T('src.name'), name), P.field(T('src.smb'), smb, T('src.smb_hint')), P.field(T('src.webdav'), dav, T('src.webdav_hint')),
      P.field(T('src.cert'), cert, T('src.cert_hint')), away.node]);
    var update = function () {
      var sg = P.suggestShare(td, where.value(), share.value);
      suggestInto(smb, sg.smb);
      suggestInto(dav, sg.webdav);
      suggestInto(away.addr, sg.away);
      suggestInto(name, sg.name);
      allow.set(where.value());
    };
    where.onChange(update);
    share.addEventListener('input', update);
    if (!s) update(); else allow.set(where.value());
    var node = el('div', null, [el('h2', { class: 'md-card-title', text: s ? T('src.edit_title', { name: s.name }) : T('src.add_share') }),
      P.field(T('nas.where'), where.node), P.field(T('nas.share'), share, T('nas.share_hint')),
      el('div', { class: 'form-row' }, [P.field(T('src.nas_user'), user, T('src.nas_user_hint')), s ? null : P.field(T('src.pw'), pw)]),
      allow.node, adv]);
    var get = function () {
      var v = where.value();
      var smbA = smb.value.trim();
      var davA = dav.value.trim();
      if (!smbA && !davA) { adv.open = true; return Promise.reject(new Error(T(v ? 'nas.address_required' : 'src.via_required'))); }
      var peer = v && v.indexOf('p:') === 0;
      return (davA && v ? P.ensureTarget('webdav', v, { port: portOf(davA, 443), scheme: 'https' }) : Promise.resolve(null)).then(function (davIndex) {
        return (smbA && peer ? P.ensureTarget('smb', v, { port: 445, scheme: 'http' }) : Promise.resolve(null)).then(function (smbIndex) {
          var b = { kind: 'share', name: name.value.trim() || P.suggestShare(td, v, share.value).name || user.value.trim(), user: user.value, away: away.value(),
            smb: smbA ? { address: smbA, targetIndex: smbIndex } : null,
            webdav: davA ? { address: davA, certSha256: cert.value.trim() || null, targetIndex: davIndex } : null };
          if (!s) b.password = pw.value;
          return b;
        });
      });
    };
    return { node: node, get: get };
  }

  function form(kind, s, td) { return kind === 'jellyfin' ? jellyfinForm(s, td) : shareForm(s, td); }

  /** GC.targets.get() for a dialog — the dialogs assign the access target themselves (GateControl ≥ 1.324.0). */
  function withTargets(fn) {
    return P.targetsData().then(function (td) {
      if (!td) throw new Error(T('src.via_unavailable'));
      TD = td;
      return fn(td);
    });
  }

  function add() {
    P.dialog(el('div', null, [el('h2', { class: 'md-card-title', text: T('sources.add') }), el('p', { class: 'md-hint', text: T('src.kind_hint') })]),
      [{ label: T('common.cancel'), value: false }, { label: T('src.kind.share'), value: 'share' }, { label: T('src.kind.jellyfin'), value: 'jellyfin', primary: true }]).then(function (kind) {
      if (!kind) return null;
      return withTargets(function (td) {
        var f = form(kind, null, td);
        return P.dialog(f.node, [{ label: T('common.cancel'), value: false }, { label: T('src.save_checked'), primary: true, run: function () {
          return f.get().then(function (b) { return P.api('POST', 'admin/sources', b); }).then(function () { P.toast(T('common.saved')); return true; });
        } }]).then(function () { return load().then(prune); });
      });
    }).catch(P.warn);
  }

  function edit(s) {
    withTargets(function (td) {
      var f = form(s.kind, s, td);
      return P.dialog(f.node, [{ label: T('common.cancel'), value: false }, { label: T('src.save_checked'), primary: true, run: function () {
        var key;
        return f.get().then(function (b) {
          key = b.key;
          delete b.key;
          delete b.kind;
          return P.api('PUT', 'admin/sources/' + s.id, b);
        }).then(function () { return key ? P.api('PUT', 'admin/sources/' + s.id + '/key', { key: key }) : null; })
          .then(function () { P.toast(T('common.saved')); return true; });
      } }]).then(function () { return load().then(prune); });
    }).catch(P.warn);
  }

  /**
   * After adding, editing (also cancelled — a check may have assigned a target) or removing a source: assignments at the
   * end of a target's list that no source uses any more go again. Never one in the middle — the index of every other
   * source stays as it is.
   */
  function prune() {
    if (!P.hasTargets || !S) return null;
    var used = { jellyfin: [], webdav: [], smb: [] };
    S.sources.forEach(function (x) {
      var c = x.config || {};
      if (x.kind === 'jellyfin') used.jellyfin.push(c.targetIndex || 0);
      else {
        if (c.webdav && c.webdav.targetIndex != null) used.webdav.push(c.webdav.targetIndex);
        if (c.smb && c.smb.targetIndex != null) used.smb.push(c.smb.targetIndex);
      }
    });
    return P.pruneTargets('jellyfin', used.jellyfin).then(function () { return P.pruneTargets('webdav', used.webdav); })
      .then(function () { return P.pruneTargets('smb', used.smb); }).then(function (x) { return refreshTargets().then(function () { return x; }); });
  }

  /** The assignments for the lines "über …" / "Server-Freigabe" (GC.targets; without it the server's labels). */
  function refreshTargets() {
    return P.targetsData().then(function (td) { TD = td; if (S) draw(); });
  }

  function secretDialog(s, what) {
    var inp = P.input({ type: 'password', autocomplete: 'off' });
    P.dialog(el('div', null, [el('h2', { class: 'md-card-title', text: T(what === 'key' ? 'src.key_replace' : 'src.pw_replace') }), el('p', { class: 'md-hint', text: T(what === 'key' ? 'src.key_replace_hint' : 'src.pw_replace_hint') }), inp]),
      [{ label: T('common.cancel'), value: false }, { label: T('common.save'), primary: true, run: function () {
        var b = {};
        b[what] = inp.value;
        return P.api('PUT', 'admin/sources/' + s.id + '/' + what, b).then(function () { P.toast(T('common.saved')); load(); return true; });
      } }]);
  }

  function qcOn(s) {
    P.confirmDialog(T('src.qc_on_q'), T('src.qc_on')).then(function (ok) {
      if (!ok) return null;
      return P.api('POST', 'admin/sources/' + s.id + '/quickconnect', { on: true }).then(function () { P.toast(T('src.qc_done')); load(); });
    }).catch(P.warn);
  }

  /** "Wer sieht diese Quelle": everybody with the right, or the people and groups picked in GateControl's picker. */
  function who(s) {
    var a = s.access || {};
    var all = el('input', { type: 'radio', name: 'md-who', checked: a.mode !== 'list' });
    var some = el('input', { type: 'radio', name: 'md-who', checked: a.mode === 'list' });
    var picked = [];
    (a.users || []).forEach(function (u) { if (u.allow) picked.push({ type: 'user', id: u.id, label: '#' + u.id }); });
    (a.groups || []).forEach(function (g) { if (g.allow) picked.push({ type: 'group', id: g.id, label: '#' + g.id }); });
    var chips = el('p', { class: 'md-hint' });
    function drawChips() { chips.textContent = picked.length ? picked.map(function (p) { return p.label; }).join(', ') : T('who.none'); }
    drawChips();
    var pick = el('button', { type: 'button', class: 'btn btn-sm', text: T('who.pick'), on: { click: function () {
      if (!window.GC || typeof window.GC.pickPrincipals !== 'function') { P.toast(T('who.no_picker'), 'error'); return; }
      window.GC.pickPrincipals({ groups: true, users: true, multiple: true, title: T('who.title', { name: s.name }) }).then(function (r) {
        if (r) { picked = r; some.checked = true; drawChips(); }
      });
    } } });
    P.dialog(el('div', null, [el('h2', { class: 'md-card-title', text: T('who.title', { name: s.name }) }),
      el('label', { class: 'check' }, [all, el('span', { text: s.kind === 'share' ? T('access.all_share') : T('access.all_jf') })]),
      el('label', { class: 'check' }, [some, el('span', { text: T('who.some') })]), pick, chips, el('p', { class: 'md-hint', text: T('who.hint') })]),
    [{ label: T('common.cancel'), value: false }, { label: T('common.save'), primary: true, run: function () {
      var b = all.checked ? { mode: 'all' } : { mode: 'list', users: picked.filter(function (p) { return p.type === 'user'; }).map(function (p) { return { id: p.id, allow: true }; }),
        groups: picked.filter(function (p) { return p.type === 'group'; }).map(function (p) { return { id: p.id, allow: true }; }) };
      return P.api('PUT', 'admin/sources/' + s.id + '/access', b).then(function () { P.toast(T('common.saved')); load(); return true; });
    } }]);
  }

  function remove(s) {
    P.confirmDialog(T('src.remove_q', { name: s.name }), T('src.remove'), true).then(function (ok) {
      if (!ok) return null;
      return P.api('DELETE', 'admin/sources/' + s.id).then(function () { P.toast(T('src.removed')); return load().then(prune); });
    }).catch(P.warn);
  }

  function load() {
    return Promise.all([P.api('GET', 'admin/sources'), P.targetsData()]).then(function (x) { S = x[0]; TD = x[1]; draw(); }).catch(P.warn);
  }
  $('#md-add').addEventListener('click', add);
  if (window.GC && typeof window.GC.on === 'function') window.GC.on('event', function (e) { if (e && e.type === 'media.changed') load(); });
  load();
})();
