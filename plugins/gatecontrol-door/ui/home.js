/* 1.6.0 — Kameras im Heimnetz (gc.cameras): the section "Kameras" of the page "Geräte" (cards with a fresh
   snapshot, "Kamera hinzufügen" with the cameras the gateway found, "Aufnahmen", "Heute") and the camera view of
   the portal tab (chips, live picture through GateControl — only in the VPN — or a snapshot every 10 s, Standbild /
   Vollbild / Ton, "Clips heute"). Pictures, video and clips are /camera-media/… URLs of GateControl (the frame may
   load them; the token is the permission). An older GateControl without gc.cameras: a note, nothing else changes. */
(function () {
  'use strict';
  var D = window.DOOR;
  if (!D) return;
  var T = D.T, el = D.el, $ = D.$;
  var LOCALE = D.CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var KTONE = { person: 'warn', vehicle: 'info', animal: 'neu', motion: 'neu' };
  var timers = [];

  function every(fn, ms) { var t = setInterval(fn, ms); timers.push(t); return t; }
  function bust(url) { return url ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now() : url; }
  function len(ms) { var s = Math.max(0, Math.round((ms || 0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function hm(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '–' : d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }); }
  function ago(ms) { var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 120 ? T('home.ago_s', { n: s }) : T('home.ago_min', { n: Math.round(s / 60) }); }
  function bytes(n) { if (!(n >= 0)) return '–'; return n >= 1e12 ? T('home.tb', { n: (n / 1e12).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) }) : T('home.gb', { n: Math.round(n / 1e9).toLocaleString(LOCALE) }); }
  function pill(text, tone) { return el('span', { class: 'dr-pill', 'data-tone': tone || 'neu', text: text }); }
  function kindPill(k) { return pill(T('home.k1.' + k), KTONE[k]); }

  /** The line under a card: model · 2560×1440 · mit Ton · motion · clips. */
  function camLine(c) {
    var s = c.settings || {};
    var parts = [];
    if (c.model) parts.push(c.model);
    if (c.width && c.height) parts.push(T('home.res', { w: c.width, h: c.height }));
    if (c.audio) parts.push(T('home.with_sound'));
    if (s.record === 'never') parts.push(T('home.motion_never'));
    else if (s.record === 'away') parts.push(T('home.motion_away'));
    else parts.push(T('home.motion', { kinds: (s.events || []).map(function (k) { return T('home.kind.' + k); }).join(', ') || '–' }));
    if (s.record !== 'never') parts.push(T('home.clips_days', { n: s.retentionDays || 14 }));
    return parts.join(' · ');
  }

  /** A picture that refreshes itself every `ms` and says how old it is ("Einfahrt · vor 4 s"). */
  function liveShot(url, name, ms) {
    var label = el('span', { text: name });
    var img = el('img', { alt: T('home.cameras') + ' ' + name, loading: 'lazy' });
    var box = el('div', { class: 'dr-shot' }, [img, label]);
    var loaded = 0;
    img.addEventListener('load', function () { loaded = Date.now(); box.removeAttribute('data-empty'); tick(); });
    img.addEventListener('error', function () { if (!loaded) { box.setAttribute('data-empty', ''); label.textContent = name + ' · ' + T('home.no_picture'); } });
    function tick() { if (loaded) label.textContent = name + ' · ' + ago(loaded); }
    function load() { if (url) img.src = bust(url); }
    if (url) { load(); every(load, ms || 10000); every(tick, 1000); } else box.setAttribute('data-empty', '');
    return box;
  }

  // ─── admin: page "Geräte" ────────────────────────────────────────────

  var A = { data: null, found: null, ring: [] };

  function gwNames() { return (A.data.gateways || []).filter(function (g) { return g.enabled; }).map(function (g) { return g.name; }).join(', '); }

  function adminCards() {
    var grid = D.clear($('#dr-hc-grid'));
    var cams = A.data.cameras || [];
    cams.forEach(function (c) {
      var state = !c.online ? (c.state === 'auth_failed' ? pill(T('home.pill_auth'), 'crit') : (c.state === 'tls_untrusted' ? pill(T('home.pill_tls'), 'crit') : (c.state === 'starting' ? pill(T('home.pill_starting'), 'neu') : pill(T('home.pill_offline'), 'crit')))) : pill(T('home.pill_live'), 'ok');
      grid.appendChild(el('div', { class: 'dr-hcam', 'data-camera': c.id }, [
        liveShot(c.snapshotUrl, c.name, 10000),
        el('div', { class: 'dr-hcam-head' }, [el('strong', { text: c.name }), pill(T('home.pill_home'), 'info'), state]),
        el('span', { class: 'dr-hint', text: camLine(c) }),
        el('div', { class: 'dr-actions' }, [
          el('button', { type: 'button', class: 'btn btn-sm', text: T('home.edit'), on: { click: function () { pickRec(c.id); } } }),
          el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('home.remove'), on: { click: function () { removeCam(c); } } }),
        ]),
      ]));
    });
    A.ring.forEach(function (c) {
      var shot = el('div', { class: 'dr-shot', 'data-empty': '' }, [el('span', { text: c.name + ' · ' + T('home.ring_snapshot') })]);
      D.api('GET', 'admin/cameras/' + c.id + '/snapshot').then(function (r) {
        var u = r && r.snapshot && D.imgUrl(r.snapshot);
        if (u) { shot.insertBefore(el('img', { src: u, alt: c.name }), shot.firstChild); shot.removeAttribute('data-empty'); }
      }).catch(function () { /* no picture */ });
      grid.appendChild(el('div', { class: 'dr-hcam', 'data-ring': String(c.id) }, [
        shot,
        el('div', { class: 'dr-hcam-head' }, [el('strong', { text: c.name }), pill(T('home.pill_ring'), 'neu')]),
        el('span', { class: 'dr-hint', text: (c.kind || 'Ring') + ' · ' + T('home.ring_line') }),
      ]));
    });
    $('#dr-hc-none').hidden = cams.length + A.ring.length > 0;
    var names = gwNames();
    $('#dr-hc-src').textContent = names ? (A.ring.length ? T('home.sources', { gateways: names }) : T('home.sources_home', { gateways: names })) : '';
  }

  function hints() {
    var box = D.clear($('#dr-hc-hints'));
    (A.data.gateways || []).forEach(function (g) {
      if (!g.enabled) return;
      if (g.service && g.service !== 'managed') box.appendChild(el('div', { class: 'dr-note', text: T('home.hint_service', { gateway: g.name }) }));
      if (g.hint && g.hint.max) box.appendChild(el('div', { class: 'dr-note', 'data-tone': 'info', text: T('home.hint_pi', { max: g.hint.max }) }));
    });
  }

  // "Kamera hinzufügen"
  function addForm() {
    var gws = (A.data.gateways || []).filter(function (g) { return g.enabled && g.supported; });
    var gsel = $('#dr-hc-gw');
    D.clear(gsel);
    gws.forEach(function (g) { gsel.appendChild(el('option', { value: String(g.id), text: g.name + (g.online ? '' : ' (offline)') })); });
    $('#dr-hc-gw-box').hidden = gws.length < 2;
    renderFound();
  }

  function renderFound() {
    var list = D.clear($('#dr-hc-found'));
    var info = $('#dr-hc-found-t');
    if (A.found === null) { info.textContent = T('home.searching'); }
    else info.textContent = A.found.length ? T('home.found') : T('home.found_none');
    (A.found || []).forEach(function (f, i) {
      var r = el('input', { type: 'radio', name: 'dr-hc-pick', value: 'f' + i, checked: i === 0 && !f.cameraId });
      list.appendChild(el('label', { class: 'dr-pick' }, [r, el('span', { class: 'dr-pick-t' }, [el('strong', { text: [f.manufacturer, f.model || f.name].filter(Boolean).join(' ') || f.host }), el('span', { class: 'dr-hint', text: ' · ' + f.host + ' · ONVIF' })]),
        f.cameraId ? pill(T('home.found_known'), 'neu') : pill(T('home.found_new'), 'ok')]));
    });
    var man = el('input', { type: 'radio', name: 'dr-hc-pick', value: 'manual', checked: !(A.found || []).some(function (f) { return !f.cameraId; }) });
    list.appendChild(el('label', { class: 'dr-pick' }, [man, el('span', { class: 'dr-pick-t' }, [T('home.manual') + ' ', el('span', { class: 'dr-hint', text: T('home.manual_hint') })])]));
    list.addEventListener('change', manualVisible);
    manualVisible();
  }
  function picked() { var r = document.querySelector('input[name="dr-hc-pick"]:checked'); return r ? r.value : 'manual'; }
  function manualVisible() { $('#dr-hc-addr-box').hidden = picked() !== 'manual'; }

  function discover() {
    A.found = null;
    renderFound();
    var gw = Number($('#dr-hc-gw').value) || null;
    D.api('POST', 'admin/home/discover', gw ? { gatewayId: gw } : {}).then(function (r) { A.found = (r.found || []).slice(0, 16); renderFound(); })
      .catch(function (e) { A.found = []; renderFound(); D.warn(e); });
  }

  function addCam(ev) {
    ev.preventDefault();
    var pick = picked();
    var body = { name: $('#dr-hc-name').value.trim(), user: $('#dr-hc-user').value, password: $('#dr-hc-pw').value };
    var gw = Number($('#dr-hc-gw').value);
    if (pick === 'manual') {
      var a = $('#dr-hc-addr').value.trim();
      if (/^rtsp:\/\//i.test(a)) body.rtspUrl = a; else body.host = a;
    } else {
      var f = A.found[Number(pick.slice(1))];
      body.host = f.host; body.onvifPort = f.port; body.onvifPath = f.path; gw = f.gatewayId || gw;
    }
    body.gatewayId = gw;
    // 1.7.0: HTTPS — the certificate is checked unless the administrator ticks "Zertifikat nicht prüfen"
    if (!body.rtspUrl) {
      if ($('#dr-hc-tls').checked) body.onvifTls = true;
      if ($('#dr-hc-tlsins').checked) body.tlsInsecure = true;
    }
    $('#dr-hc-tlsask').hidden = true;
    var btn = $('#dr-hc-connect');
    btn.disabled = true; btn.textContent = T('home.connecting');
    D.api('POST', 'admin/home/cameras', body).then(function (r) {
      D.toast(T('home.added', { name: r.camera.name }));
      $('#dr-hc-pw').value = '';
      var u = r.snapshot && D.imgUrl(r.snapshot);
      if (u) D.dialog(el('div', {}, [el('p', { class: 'dr-item-title', text: T('home.test_ok', { name: r.camera.name }) }), el('img', { src: u, alt: r.camera.name })]));
      return load();
    }).catch(function (e) {
      // a self-signed certificate: say what to do next to the box that does it
      if (e && e.code === 'cam_tls') { $('#dr-hc-tlsask').hidden = false; $('#dr-hc-tlsins').focus(); }
      D.warn(e);
    }).then(function () { btn.disabled = false; btn.textContent = T('home.connect'); });
  }

  function removeCam(c) {
    D.confirmDialog(T('home.remove_q', { name: c.name }), T('home.remove')).then(function (ok) {
      if (!ok) return null;
      return D.api('DELETE', 'admin/home/cameras/' + encodeURIComponent(c.id)).then(function () { D.toast(T('home.removed')); load(); });
    }).catch(D.warn);
  }

  // "Aufnahmen" — settings of one camera, saved on change
  var recId = null;
  function pickRec(id) { recId = id; renderRec(); var c = $('#dr-hc-rec'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  function renderRec() {
    var cams = A.data.cameras || [];
    $('#dr-hc-rec').hidden = !cams.length;
    if (!cams.length) return;
    if (!cams.some(function (c) { return c.id === recId; })) recId = cams[0].id;
    var c = cams.filter(function (x) { return x.id === recId; })[0];
    var csel = D.clear($('#dr-hc-rc'));
    cams.forEach(function (x) { csel.appendChild(el('option', { value: x.id, text: x.name, selected: x.id === recId })); });
    var s = c.settings || {};
    $('#dr-hc-mode').value = s.record || 'motion';
    $('#dr-hc-keep').value = String(s.retentionDays || 14);
    $('#dr-hc-push').checked = c.push !== false;
    $('#dr-hc-audio').checked = !!s.audio;
    // 1.7.0: "Zertifikat nicht prüfen" for cameras with HTTPS (also when the certificate is refused right now)
    $('#dr-hc-rtls-box').hidden = !(c.https || c.state === 'tls_untrusted');
    $('#dr-hc-rtls').checked = !!c.tlsInsecure;
    var g = (A.data.gateways || []).filter(function (x) { return x.id === c.gatewayId; })[0];
    var st = g && g.storage;
    D.clear($('#dr-hc-store')).appendChild(el('option', { text: st && st.free != null ? T('home.rec_store_v', { gateway: c.gateway, free: bytes(st.free) }) : T('home.rec_store_unknown', { gateway: c.gateway }) }));
  }
  function saveRec(patch) {
    if (!recId) return;
    D.api('PATCH', 'admin/home/cameras/' + encodeURIComponent(recId), patch).then(function (r) {
      A.data.cameras = A.data.cameras.map(function (x) { return x.id === r.camera.id ? r.camera : x; });
      D.toast(T('home.saved'));
      adminCards(); renderRec();
    }).catch(function (e) { D.warn(e); renderRec(); });
  }

  // "Heute"
  function renderToday() {
    var box = D.clear($('#dr-hc-today-list'));
    var list = A.data.today || [];
    $('#dr-hc-today-none').hidden = list.length > 0;
    list.forEach(function (e) {
      box.appendChild(el('div', { class: 'dr-li' }, [
        kindPill(e.kind),
        el('span', { class: 'dr-li-t', text: e.ms ? T('home.clip_line', { camera: e.camera, len: len(e.ms) }) : T('home.still_line', { camera: e.camera }) }),
        el('span', { class: 'dr-hint', text: hm(e.startedAt) }),
        e.clipUrl || e.thumbUrl ? el('button', { type: 'button', class: 'btn btn-sm', text: T('home.watch'), on: { click: function () { watch(e); } } }) : null,
      ]));
    });
  }

  function watch(e) {
    var media = e.clipUrl
      ? el('video', { src: e.clipUrl, controls: true, playsinline: true, autoplay: true, muted: true, poster: e.thumbUrl || null, class: 'dr-video' })
      : el('img', { src: e.thumbUrl, alt: e.camera });
    D.dialog(el('div', {}, [el('p', { class: 'dr-item-title', text: T('home.k1.' + e.kind) + ' · ' + e.camera + ' · ' + hm(e.startedAt) }), media]));
  }

  function load() {
    timers.forEach(clearInterval); timers = [];
    return Promise.all([D.api('GET', 'admin/home'), D.api('GET', 'admin/status').catch(function () { return { cameras: [] }; })]).then(function (rs) {
      A.data = rs[0];
      A.ring = (rs[1].cameras || []).filter(function (c) { return c.present !== false && c.enabled !== false; });
      var ok = A.data.supported !== false;
      $('#dr-hc-needs').hidden = ok;
      if (!ok) $('#dr-hc-needs').textContent = T('home.needs_gc', { version: A.data.minGatecontrol });
      var gws = (A.data.gateways || []).filter(function (g) { return g.enabled && g.supported; });
      $('#dr-hc-nogw').hidden = !ok || gws.length > 0;
      $('#dr-hc-card').hidden = !ok;
      $('#dr-hc-two').hidden = !ok || !gws.length;
      $('#dr-hc-today').hidden = !ok || !(A.data.cameras || []).length;
      $('#dr-hc-add-top').hidden = !ok || !gws.length;
      if (!ok) return;
      adminCards(); hints(); renderRec(); renderToday();
      if (gws.length) { addForm(); if (A.found === null || !A.found.length) discover(); }
    }).catch(D.warn);
  }

  function initAdmin() {
    if (!$('#dr-hc-card')) return;
    $('#dr-hc-form').addEventListener('submit', addCam);
    $('#dr-hc-again').addEventListener('click', discover);
    $('#dr-hc-cancel').addEventListener('click', function () { $('#dr-hc-form').reset(); renderFound(); });
    $('#dr-hc-gw').addEventListener('change', discover);
    $('#dr-hc-add-top').addEventListener('click', function () { $('#dr-hc-name').focus(); $('#dr-hc-addcard').scrollIntoView({ behavior: 'smooth' }); });
    $('#dr-hc-rc').addEventListener('change', function (e) { recId = e.target.value; renderRec(); });
    $('#dr-hc-mode').addEventListener('change', function (e) { saveRec({ settings: { record: e.target.value } }); });
    $('#dr-hc-keep').addEventListener('change', function (e) { saveRec({ settings: { retentionDays: Number(e.target.value) } }); });
    $('#dr-hc-push').addEventListener('change', function (e) { saveRec({ push: e.target.checked }); });
    $('#dr-hc-audio').addEventListener('change', function (e) { saveRec({ settings: { audio: e.target.checked } }); });
    $('#dr-hc-rtls').addEventListener('change', function (e) { saveRec({ tlsInsecure: e.target.checked }); });
    load();
    // the picture URLs carry a token of 10 minutes: fresh ones before it runs out
    setInterval(function () { if (!document.hidden) load(); }, 8 * 60000);
  }

  // ─── portal: the camera view (KameraHandy) ───────────────────────────

  var P = { list: [], ring: [], sel: null, live: null, video: null };

  function chips() {
    var box = D.clear($('#dr-pc-chips'));
    P.list.concat(P.ring).forEach(function (c) {
      var id = c.kind === 'ring' ? 'r' + c.id : c.id;
      box.appendChild(el('button', { type: 'button', class: 'dr-chip', 'aria-pressed': id === P.sel ? 'true' : 'false', text: c.name, on: { click: function () { P.sel = id; chips(); show(); } } }));
    });
    var online = P.list.filter(function (c) { return c.online; }).length + P.ring.length;
    $('#dr-pc-online').textContent = T('home.online', { n: online });
  }

  function clock(node, name) {
    var f = function () { node.textContent = name + ' · ' + new Date().toLocaleTimeString(LOCALE); };
    f(); every(f, 1000);
  }

  function show() {
    timers.forEach(clearInterval); timers = [];
    var stage = D.clear($('#dr-pc-stage'));
    var ring = P.sel && P.sel[0] === 'r' ? P.ring.filter(function (c) { return 'r' + c.id === P.sel; })[0] : null;
    var cam = ring ? null : P.list.filter(function (c) { return c.id === P.sel; })[0];
    $('#dr-pc-sound').disabled = true;
    $('#dr-pc-still').disabled = !cam;
    stopPlayer();
    P.video = null;
    if ($('#dr-pc-mypush')) $('#dr-pc-mypush').hidden = true;
    if (ring) {
      var img = el('img', { alt: ring.name });
      var r = ring.image && D.imgUrl(ring.image);
      if (r) img.src = r;
      stage.appendChild(el('div', { class: 'dr-stage' }, [img, el('div', { class: 'dr-stage-top' }, [pill(T('home.pill_ring'), 'dark')]), el('span', { class: 'dr-stage-name', text: ring.name })]));
      $('#dr-pc-clips-card').hidden = true;
      return;
    }
    if (!cam) return;
    myPush(cam);
    var name = el('span', { class: 'dr-stage-name' });
    var top = el('div', { class: 'dr-stage-top' });
    var box = el('div', { class: 'dr-stage', 'aria-label': T('home.cameras') + ' ' + cam.name }, [top, name]);
    stage.appendChild(box);
    clock(name, cam.name);
    D.api('GET', 'cameras/home/' + encodeURIComponent(cam.id) + '/live').then(function (r) {
      var l = r.live || {};
      P.live = l;
      if (l.mode === 'live') {
        var v = el('video', { autoplay: true, muted: true, playsinline: true, class: 'dr-stage-media' });
        v.muted = true;
        box.insertBefore(v, box.firstChild);
        stopPlayer();
        if (window.GCCameraPlayer) {
          // 1.7.0: GateControl's player — HLS where the browser has it (Safari, iOS, Android), else live.mp4
          // through Media Source Extensions (Firefox, Chrome/Edge on the PC)
          P.player = window.GCCameraPlayer.play(v, l, { onError: function () { stopPlayer(); snapshotMode(box, l.snapshot); }, onEnded: function () { if (!document.hidden) show(); } });
        } else {
          // an older GateControl without the player: Safari, iOS and Android play HLS themselves, others the fMP4 stream
          v.src = v.canPlayType('application/vnd.apple.mpegurl') ? l.hls : l.mp4;
          v.addEventListener('error', function () { snapshotMode(box, l.snapshot); });
        }
        P.video = v;
        top.appendChild(el('span', { class: 'dr-pill', 'data-tone': 'live', text: T('home.live') }));
        top.appendChild(el('span', { class: 'dr-pill', 'data-tone': 'dark', text: l.via === 'lan' ? T('home.via_lan') : T('home.via_vpn') }));
        $('#dr-pc-sound').disabled = !l.audio;
        $('#dr-pc-novpn').hidden = true;
      } else {
        snapshotMode(box, l.snapshot);
        top.appendChild(el('span', { class: 'dr-pill', 'data-tone': 'dark', text: T('home.snapshot_mode') }));
        $('#dr-pc-novpn').hidden = false;
      }
    }).catch(function (e) { snapshotMode(box, cam.snapshotUrl); D.warn(e); });
    clips(cam);
  }

  function stopPlayer() { if (P.player) { try { P.player.stop(); } catch (e) { /* gone */ } P.player = null; } }

  /** 1.7.0: the own push "Personen an der Kamera" of the camera shown (PUT cameras/home/<id>/prefs). */
  function myPush(cam) {
    var box = $('#dr-pc-mypush');
    if (!box) return;
    var on = !(cam.prefs && cam.prefs.push === false);
    box.hidden = cam.push === false;
    var input = $('#dr-pc-mypush-in');
    input.checked = on;
    input.disabled = !!(D.ME && D.ME.me && D.ME.me.canAct === false);
    input.onchange = function () {
      var want = input.checked;
      D.api('PUT', 'cameras/home/' + encodeURIComponent(cam.id) + '/prefs', { push: want }).then(function (r) {
        cam.prefs = r.prefs || { push: want };
        D.toast(T(want ? 'home.my_push_on' : 'home.my_push_off'));
      }).catch(function (e) { input.checked = !want; D.warn(e); });
    };
  }

  function snapshotMode(box, url) {
    var old = box.querySelector('.dr-stage-media');
    if (old) old.remove();
    var img = el('img', { class: 'dr-stage-media', alt: '' });
    box.insertBefore(img, box.firstChild);
    var load = function () { if (url) img.src = bust(url); };
    load(); every(load, 10000);
  }

  function clips(cam) {
    $('#dr-pc-clips-card').hidden = false;
    $('#dr-pc-clips-cam').textContent = cam.name;
    D.api('GET', 'cameras/home/' + encodeURIComponent(cam.id) + '/clips').then(function (r) {
      var box = D.clear($('#dr-pc-clips'));
      var list = r.clips || [];
      $('#dr-pc-clips-none').hidden = list.length > 0;
      list.forEach(function (e) {
        box.appendChild(el('button', { type: 'button', class: 'dr-clip', on: { click: function () { watch(e); } } }, [
          e.thumbUrl ? el('img', { class: 'dr-clip-th', src: e.thumbUrl, alt: T('home.k1.' + e.kind), loading: 'lazy' }) : el('span', { class: 'dr-clip-th' }),
          el('span', { class: 'dr-clip-t' }, [el('strong', { text: T('home.clip_title', { kind: T('home.k1.' + e.kind), len: len(e.ms) }) }), el('span', { class: 'dr-hint', text: hm(e.startedAt) })]),
          kindPill(e.kind),
        ]));
      });
      var person = list.filter(function (e) { return e.kind === 'person'; })[0];
      $('#dr-pc-push').hidden = !person;
      if (person) {
        var th = $('#dr-pc-push-th');
        if (person.thumbUrl) th.src = person.thumbUrl;
        $('#dr-pc-push-t').textContent = T('home.push_card', { kind: T('home.k1.person'), camera: cam.name });
        $('#dr-pc-push-s').textContent = (person.nobodyHome ? T('home.nobody_home') + ' · ' : '') + hm(person.startedAt);
      }
    }).catch(D.warn);
  }

  function still() {
    var cam = P.list.filter(function (c) { return c.id === P.sel; })[0];
    if (!cam) return;
    D.api('GET', 'cameras/home/' + encodeURIComponent(cam.id) + '/still').then(function (r) {
      var s = r.still;
      if (!s || !window.GC || !window.GC.saveFile) return;
      var bin = atob(s.data);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return window.GC.saveFile(new Blob([arr], { type: 'image/jpeg' }), cam.name + ' ' + new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-') + '.jpg');
    }).catch(D.warn);
  }

  function initPortal(me) {
    if (!$('#dr-pc')) return;
    D.ME = me || null;
    D.api('GET', 'cameras/home').then(function (r) {
      P.list = r.cameras || [];
      // Ring cameras keep their own card below (pictures from the Ring cloud, as before)
      P.ring = [];
      $('#dr-pc').hidden = !P.list.length;
      if (!P.list.length) return;
      if (me && !(me.locks || []).length) $('#dr-locks-card').hidden = true;
      P.sel = P.list[0].id;
      chips(); show();
      // live and picture tokens hold 10 minutes: a fresh session before they run out
      setInterval(function () { if (!document.hidden && !document.fullscreenElement) show(); }, 9 * 60000);
    }).catch(function () { /* older GateControl / nothing to see */ });
    $('#dr-pc-still').addEventListener('click', still);
    $('#dr-pc-full').addEventListener('click', function () {
      var s = $('#dr-pc-stage .dr-stage');
      if (s && s.requestFullscreen) s.requestFullscreen().catch(function () { /* not allowed */ });
      else if (P.video && P.video.webkitEnterFullscreen) P.video.webkitEnterFullscreen();
    });
    $('#dr-pc-sound').addEventListener('click', function (e) {
      if (!P.video) return;
      P.video.muted = !P.video.muted;
      e.currentTarget.setAttribute('aria-pressed', P.video.muted ? 'false' : 'true');
    });
  }

  window.DOOR_HOME = { initAdmin: initAdmin, initPortal: initPortal, camLine: camLine, len: len };
  if (D.CTX.page === 'devices') initAdmin();
})();
