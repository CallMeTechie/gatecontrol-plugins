/* Tab "Quellen": Jellyfin servers and NAS shares — add, check, edit, replace the key / password, who sees them. */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;
  var S = null;

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

  function card(s) {
    var c = s.config || {};
    var st = s.status || {};
    var tone = !s.enabled ? null : (st.ok ? 'good' : (st.at ? 'crit' : 'warn'));
    var head = el('div', { class: 'md-card-head' }, [
      el('h2', { class: 'md-card-title', text: (s.kind === 'jellyfin' ? 'Jellyfin · ' : T('src.share') + ' · ') + s.name }),
      P.badge(!s.enabled ? T('src.off') : (st.ok ? T('src.ok') : (st.at ? T('src.problem') : T('src.unchecked'))), tone),
      s.enabled && s.home && s.home.level !== 'unique' ? P.badge(T('home.badge'), 'warn') : null,
    ]);
    var rows = s.kind === 'jellyfin' ? [
      [T('src.server_via'), T('src.target_n', { n: (c.targetIndex || 0) + 1 }) + (labelOf('jellyfin', c.targetIndex) ? ' · ' + labelOf('jellyfin', c.targetIndex) : '')],
      [T('src.address'), el('span', { class: 'md-mono', text: c.address })],
      [T('src.away'), awayText(s)],
      [T('home.label'), homeText(s)],
      [T('src.key'), s.hasKey ? T('src.key_set') : T('src.key_missing')],
      [T('src.libraries'), (st.libraries || []).map(function (l) { return l.name; }).join(', ') || '–'],
      [T('src.visible'), accessText(s)],
      [T('src.downloads'), c.downloads === false ? T('common.no') : T('src.downloads_yes')],
      [T('src.devices'), String(s.devices || 0)],
    ] : [
      c.smb ? [T('src.smb'), el('span', { class: 'md-mono', text: c.smb.address })] : null,
      c.webdav ? [T('src.webdav'), el('span', { class: 'md-mono', text: c.webdav.address + (c.webdav.certSha256 ? ' · SHA-256 ' + c.webdav.certSha256.slice(0, 8) + '…' : '') })] : null,
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
    return el('section', { class: 'md-card', 'data-source': s.id }, [head, homeNote(s), kv(rows), P.checks(st), acts]);
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

  function awayFields(cur) {
    var a = cur || {};
    var direct = P.check(T('away.allow'), a.direct === true);
    var addr = P.input({ type: 'url', value: a.address || '', placeholder: 'https://jellyfin.example.test' });
    return { direct: direct, addr: addr, node: el('div', null, [direct.node, P.field(T('away.address'), addr, T('away.address_hint'))]),
      value: function () { return { direct: direct.box.checked, address: addr.value.trim() || null }; } };
  }

  /** The port of an address (http/https/smb), or the scheme's default. */
  function portOf(address, fallback) {
    try { var u = new URL(address); return u.port ? Number(u.port) : fallback; } catch (e) { return fallback; }
  }

  /** Fill `input` with `value` while it is empty or still holds what was suggested before. */
  function suggestInto(input, value) {
    var auto = input.getAttribute('data-suggested');
    if (!value || (input.value.trim() && input.value.trim() !== auto)) return;
    input.value = value;
    input.setAttribute('data-suggested', value);
  }

  /** The dialog "Quelle hinzufügen" / "Bearbeiten". td: GC.targets.get() (null without GC.targets). */
  function form(kind, s, td) {
    var c = (s && s.config) || {};
    var name = P.input({ value: s ? s.name : '', maxlength: 60 });
    var parts = [P.field(T('src.name'), name)];
    var get;
    if (kind === 'jellyfin') {
      var address = P.input({ type: 'url', value: c.address || '', placeholder: 'http://192.168.1.20:8096' });
      var away = awayFields(c.away);
      var target;
      var targetIndex;
      if (td) {
        target = P.viaSelect(td, 'jellyfin', s ? (c.targetIndex || 0) : null);
        target.addEventListener('change', function () {
          var sg = P.suggest(P.routeOf(td, target.value));
          suggestInto(address, sg.home);
          suggestInto(away.addr, sg.away);
        });
        targetIndex = function () {
          if (!target.value) return Promise.reject(new Error(T('src.via_required')));
          return P.ensureTarget('jellyfin', target.value, { port: portOf(address.value.trim(), 8096), scheme: 'http' });
        };
      } else {
        target = P.targetSelect(S.targets.jellyfin, c.targetIndex == null ? 0 : c.targetIndex);
        targetIndex = function () { return Promise.resolve(Number(target.value) || 0); };
      }
      var key = P.input({ type: 'password', autocomplete: 'off', placeholder: s ? T('src.key_keep') : '' });
      var downloads = P.check(T('src.downloads_allow'), c.downloads !== false);
      var result = el('div');
      var probe = el('button', { type: 'button', class: 'btn btn-sm', text: T('src.probe'), on: { click: function () {
        targetIndex().then(function (index) {
          return P.api('POST', 'admin/probe', { targetIndex: index, key: key.value || null, sourceId: s ? s.id : null });
        }).then(function (r) {
          P.clear(result).appendChild(P.checks(Object.assign({ at: Date.now() }, r.check)));
          if (!address.value && r.check && r.check.localAddress) address.value = r.check.localAddress;
        }).catch(P.warn);
      } } });
      parts.push(P.field(T(td ? 'src.via' : 'src.target'), target, T(td ? 'src.via_hint' : 'src.target_hint')), P.field(T('src.address'), address, T('src.address_hint')),
        P.field(T('src.key'), key, T('src.key_hint')), downloads.node, away.node, el('div', { class: 'md-actions' }, [probe]), result);
      get = function () {
        return targetIndex().then(function (index) {
          var b = { kind: 'jellyfin', name: name.value, targetIndex: index, address: address.value, downloads: downloads.box.checked, away: away.value() };
          if (key.value) b.key = key.value;
          return b;
        });
      };
    } else {
      var smb = P.input({ value: c.smb ? c.smb.address : '', placeholder: 'smb://192.168.1.20/filme' });
      var dav = P.input({ type: 'url', value: c.webdav ? c.webdav.address : '', placeholder: 'https://192.168.1.20:5006/filme' });
      var cert = P.input({ value: c.webdav && c.webdav.certSha256 ? c.webdav.certSha256 : '', placeholder: '9c:41:…' });
      var curDav = c.webdav && c.webdav.targetIndex != null ? c.webdav.targetIndex : null;
      var davTarget = td ? P.viaSelect(td, 'webdav', curDav, T('src.webdav_via_none')) : P.targetSelect(S.targets.webdav, curDav, true);
      var davIndex = function () {
        if (!td) return Promise.resolve(davTarget.value === '' ? null : Number(davTarget.value));
        return P.ensureTarget('webdav', davTarget.value, { port: portOf(dav.value.trim(), 443), scheme: 'https' });
      };
      var user = P.input({ value: c.user || '', placeholder: 'medien-lesen', autocomplete: 'off' });
      var pw = P.input({ type: 'password', autocomplete: 'off', placeholder: s ? T('src.pw_keep') : '' });
      var away2 = awayFields(c.away);
      if (td) davTarget.addEventListener('change', function () { suggestInto(away2.addr, P.suggest(P.routeOf(td, davTarget.value)).away); });
      parts.push(P.field(T('src.smb'), smb, T('src.smb_hint')), P.field(T('src.webdav'), dav, T('src.webdav_hint')), P.field(T('src.cert'), cert, T('src.cert_hint')),
        P.field(T(td ? 'src.webdav_via' : 'src.webdav_target'), davTarget, td ? T('src.webdav_via_hint') : null), P.field(T('src.nas_user'), user, T('src.nas_user_hint')),
        s ? null : P.field(T('src.pw'), pw), away2.node);
      get = function () {
        var hasDav = !!dav.value.trim();
        return (hasDav ? davIndex() : Promise.resolve(null)).then(function (index) {
          var b = { kind: 'share', name: name.value, user: user.value, away: away2.value(),
            smb: smb.value.trim() ? { address: smb.value.trim() } : null,
            webdav: hasDav ? { address: dav.value.trim(), certSha256: cert.value.trim() || null, targetIndex: index } : null };
          if (!s) b.password = pw.value;
          return b;
        });
      };
    }
    return { node: el('div', null, [el('h2', { class: 'md-card-title', text: s ? T('src.edit_title', { name: s.name }) : T('src.add_' + kind) })].concat(parts)), get: get };
  }

  function add() {
    P.dialog(el('div', null, [el('h2', { class: 'md-card-title', text: T('sources.add') }), el('p', { class: 'md-hint', text: T('src.kind_hint') })]),
      [{ label: T('common.cancel'), value: false }, { label: T('src.kind.share'), value: 'share' }, { label: T('src.kind.jellyfin'), value: 'jellyfin', primary: true }]).then(function (kind) {
      if (!kind) return null;
      return P.targetsData().then(function (td) {
        var f = form(kind, null, td);
        P.dialog(f.node, [{ label: T('common.cancel'), value: false }, { label: T('common.save'), primary: true, run: function () {
          return f.get().then(function (b) { return P.api('POST', 'admin/sources', b); }).then(function () { P.toast(T('common.saved')); load(); return true; });
        } }]);
      });
    }).catch(P.warn);
  }

  function edit(s) {
    P.targetsData().then(function (td) {
      var f = form(s.kind, s, td);
      P.dialog(f.node, [{ label: T('common.cancel'), value: false }, { label: T('common.save'), primary: true, run: function () {
        var key;
        return f.get().then(function (b) {
          key = b.key;
          delete b.key;
          delete b.kind;
          return P.api('PUT', 'admin/sources/' + s.id, b);
        }).then(function () { return key ? P.api('PUT', 'admin/sources/' + s.id + '/key', { key: key }) : null; })
          .then(function () { P.toast(T('common.saved')); load().then(prune); return true; });
      } }]);
    }).catch(P.warn);
  }

  /** Assignments at the end that no source uses any more (after an edit or a removal) go again. */
  function prune() {
    if (!P.hasTargets || !S) return null;
    var jf = [];
    var dav = [];
    S.sources.forEach(function (x) {
      var c = x.config || {};
      if (x.kind === 'jellyfin') jf.push(c.targetIndex || 0);
      else if (c.webdav && c.webdav.targetIndex != null) dav.push(c.webdav.targetIndex);
    });
    return P.pruneTargets('jellyfin', jf).then(function () { return P.pruneTargets('webdav', dav); });
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
    return P.api('GET', 'admin/sources').then(function (r) { S = r; draw(); }).catch(P.warn);
  }
  $('#md-add').addEventListener('click', add);
  if (window.GC && typeof window.GC.on === 'function') window.GC.on('event', function (e) { if (e && e.type === 'media.changed') load(); });
  load();
})();
