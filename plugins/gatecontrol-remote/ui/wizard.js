/* 1.7: „Gerät hinzufügen“ in three steps (Ziel, Verbindung, Anmeldung) — GateControl with gc.remote version 7.
   Step 1 lists what the server knows (admin/candidates: VPN devices, the devices behind each home gateway, L4 routes,
   „Anderes Ziel eingeben …“), step 2 checks the ports of the one target picked (admin/candidates/scan) and shows the
   way as one line, step 3 asks for the login. The way is derived as in server/way.js; nothing of the list is stored.
   window.RMW.open({ device? }) — with a device only steps 1 and 2 („Ziel ändern“ of the editor) → the new target.
   1.7.2: the home networks come as `homes` (server/homes.js): the gateways of one failover pool are one section, each
   device once; the target goes through the pool, scan and wake through an online gateway of it.
   1.8: the large dialog — on wide frames the list on the left and the details of the choice on the right (the ports and the
   way of step 2 in the same view); on top „Linux-Gerät mit Agent“ with its own steps Ziel · Code & Befehl · Fertig
   (ui/agent.js; GateControl with gc.remote version 9, else the way through the user) and „Windows-PC oder Android-Handy“. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el;
  var NS = 'http://www.w3.org/2000/svg';
  var PROTOS = ['rdp', 'vnc', 'ssh', 'telnet'];
  var DEF_PORT = { rdp: 3389, vnc: 5900, ssh: 22, telnet: 23 };
  var SCAN_PORTS = [22, 3389, 5900, 23];
  var ORDER = ['rdp', 'ssh', 'vnc', 'telnet'];

  // ─── icons (inline SVG, stroke = currentColor) ───
  var ICONS = {
    server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }]],
    pc: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20h8M12 16v4' }]],
    shell: [['path', { d: 'm5 8 4 4-4 4M12 16h7' }]],
    chip: [['rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 }], ['path', { d: 'M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4' }]],
    laptop: [['path', { d: 'M4 6h16v10H4zM2 19h20' }]],
    route: [['path', { d: 'M4 12h12M12 6l6 6-6 6' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }]],
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]],
    way: [['path', { d: 'M4 12h4l3-7 4 14 3-7h2' }]],
    ok: [['path', { d: 'm5 12 5 5 9-10' }]],
    err: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v6M12 16.5v.5' }]],
    warn: [['path', { d: 'M12 3 2 20h20L12 3Z' }], ['path', { d: 'M12 10v4M12 17v.5' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
    lock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
    chip2: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['path', { d: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' }]],
    line: [['path', { d: 'M4 12h16' }]],
    vline: [['path', { d: 'M12 3v18' }]],
  };
  function svg(name, size, width) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', String(size || 18));
    s.setAttribute('height', String(size || 18));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', String(width || 2));
    s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (x) {
      var n = document.createElementNS(NS, x[0]);
      Object.keys(x[1]).forEach(function (k) { n.setAttribute(k, String(x[1][k])); });
      s.appendChild(n);
    });
    return s;
  }
  function ico(kind, glyph) { return el('span', { class: 'rmx-ico ' + kind }, [svg(glyph)]); }
  function tag(text, tone) { return el('span', { class: 'rmx-tag' + (tone ? ' ' + tone : ''), text: text }); }
  function mono(t) { return el('span', { class: 'mono', text: t }); }
  function joinSub(parts) {
    var out = [];
    parts.filter(function (x) { return x != null && x !== ''; }).forEach(function (x, i) {
      if (i) out.push(' · ');
      out.push(x);
    });
    return out;
  }

  function protoOfPort(p) {
    if (p === 22 || p === 2222) return 'ssh';
    if (p === 23) return 'telnet';
    if (p === 3389) return 'rdp';
    if (p >= 5900 && p <= 5909) return 'vnc';
    return null;
  }
  /** ports of the watch → { ssh: 22, vnc: 5900, … } */
  function detected(ports) {
    var out = {};
    (ports || []).forEach(function (x) { var pr = protoOfPort(x.port); if (pr && !out[pr]) out[pr] = x.port; });
    return out;
  }
  function firstProto(map, fallback) {
    for (var i = 0; i < ORDER.length; i++) if (map[ORDER[i]]) return ORDER[i];
    return fallback || 'rdp';
  }
  function hoursSince(isoStr) {
    var t = Date.parse(isoStr || '');
    return isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 3600000)) : null;
  }
  function offlineText(isoStr) {
    var h = hoursSince(isoStr);
    if (h == null) return T('wz.gw_offline');
    if (h < 1) return T('wz.gw_offline_now');
    if (h < 48) return T('wz.gw_offline_h', { n: h });
    return T('wz.gw_offline_since', { when: P.when(isoStr) });
  }
  function seenText(isoStr) {
    var h = hoursSince(isoStr);
    if (h == null) return null;
    if (h < 48) return T('wz.seen_h', { n: Math.max(1, h) });
    return T('wz.seen_d', { n: Math.round(h / 24) });
  }
  function glyphOf(vendor, map, app) {
    var v = String(vendor || '').toLowerCase();
    if (app === 'windows') return 'pc';
    if (app === 'linux') return 'shell';
    if (/raspberry/.test(v)) return 'chip';
    if (/synology|qnap|asustor|western digital|netgear|terramaster/.test(v)) return 'server';
    if (map.rdp) return 'pc';
    if (map.ssh && !map.vnc) return 'server';
    return 'laptop';
  }

  // ─── the list of step 1 ───
  /** The home network (server/homes.js) a gateway belongs to. */
  function homeOf(c, peerId) {
    return ((c && c.homes) || []).filter(function (h) { return (h.members || []).some(function (m) { return m.peerId === peerId; }); })[0] || null;
  }
  /** The state of a home network: one gateway as before, a pool „Online (2 von 2)“ / „1 von 2 online“. */
  function homeState(h) {
    if (!h.online) return tag(offlineText(h.offlineSince), 'warn');
    if (!h.pool || h.total < 2) return tag(T('state.online'), 'ok');
    if (h.onlineCount === h.total) return tag(T('wz.pool_online_all', { n: h.onlineCount, total: h.total }), 'ok');
    return tag(T('wz.pool_online_some', { n: h.onlineCount, total: h.total }), 'warn');
  }
  /** The gateway of a home network to ask (scan, wake): one online that sees the device, else one online. */
  function viaOf(h, dev, wake) {
    var via = (dev && dev.via) || [];
    var hit = via.filter(function (v) { return v.online && (!wake || v.wake); })[0];
    if (!hit && wake) hit = via.filter(function (v) { return v.wake; })[0];
    if (hit) return { peerId: hit.peerId, ref: hit.ref };
    return h && h.online ? { peerId: h.peerId, ref: dev ? dev.ref : null } : null;
  }

  function model(c, withNew) {
    var known = c.known || [];
    var devOf = function (gwId, ref) {
      var h = homeOf(c, gwId);
      return h ? (h.devices || []).filter(function (d) { return d.ref === ref || (d.refs || []).indexOf(ref) >= 0; })[0] || null : null;
    };
    var groups = [];
    if (withNew) {
      groups.push({ id: 'new', title: T('ag.grp_new'), rows: [
        { key: 'agent', kind: 'agent', ico: 'ag', glyph: 'chip', name: T('ag.row'), sub: [T('ag.row_sub')], protos: { ssh: 22, rdp: 3389, vnc: 5900 }, big: true, search: T('ag.row') + ' linux agent' },
        { key: 'apps', kind: 'apps', ico: 'vpn', glyph: 'pc', name: T('ag.apps_row'), sub: [T('ag.apps_sub')], protos: {}, flat: true, tag: T('ag.help'), search: 'windows android app' },
      ], more: [] });
    }
    var vpn = { id: 'vpn', title: T('wz.grp_vpn'), rows: [], more: [] };
    (c.peers || []).forEach(function (p) {
      if (p.app === 'android') return; // a phone shares its screen through the app, it is no target of its own
      var self = p.app === 'windows' || p.app === 'linux' ? p.app : null;
      var hostDev = known.filter(function (k) { return k.kind === 'host' && k.host === p.address; })[0] || null;
      var dev = known.filter(function (k) { return k.kind !== 'host' && k.host === p.address && k.accessMode !== 'gateway'; })[0] || null;
      var twin = p.twin ? devOf(p.twin.gatewayPeerId, p.twin.ref) : null;
      var map = twin ? detected(twin.ports) : {};
      var twinGw = p.twin ? homeOf(c, p.twin.gatewayPeerId) : null;
      vpn.rows.push({
        key: 'p' + p.peerId, kind: 'peer', ico: 'vpn', glyph: glyphOf(twin && twin.vendor, map, p.app), name: p.name, address: p.address,
        sub: self ? [T(self === 'windows' ? 'wz.self_windows' : 'wz.self_linux')] : [mono(p.address), p.dnsName, twinGw ? T('wz.also_lan', { name: twinGw.name }) : null],
        protos: map, dim: !!(self || dev), flat: !!self, self: self, hostDev: hostDev, knownDev: dev, tag: self || dev ? T('wz.in_list') : null,
        peer: p, twin: p.twin ? { gw: twinGw, dev: twin } : null, search: [p.name, p.address, p.dnsName].join(' '),
      });
    });
    if (vpn.rows.length) groups.push(vpn);
    (c.homes || []).forEach(function (g) {
      var ids = (g.members || []).map(function (m) { return m.peerId; });
      var pooled = !!(g.pool && g.total > 1);
      var grp = { id: 'h' + g.id, title: pooled ? T('wz.grp_pool', { name: g.name }) : T('wz.grp_gateway', { name: g.name }), gw: g, rows: [], more: [], state: homeState(g) };
      (g.devices || []).forEach(function (d) {
        var map = detected(d.ports);
        var any = Object.keys(map).length > 0;
        var dev = known.filter(function (k) { return k.kind !== 'host' && k.host === d.address && k.accessMode === 'gateway' && (ids.indexOf(k.gatewayPeerId) >= 0 || (g.pool && k.gatewayPoolId === g.pool.poolId)); })[0] || null;
        var sub = [mono(d.address), d.vendor];
        if (d.twin) sub.push(T('wz.also_vpn'));
        if (!g.online) sub.push(T('wz.state_of', { when: P.when(d.lastSeen) }));
        else if (d.ports == null) sub.push(T('wz.ports_unknown'));
        else if (!d.online && seenText(d.lastSeen)) sub.push(T('wz.last_seen', { ago: seenText(d.lastSeen) }));
        var it = {
          key: d.ref, kind: 'lan', ico: 'lan', glyph: glyphOf(d.vendor, map), name: d.name || d.address, address: d.address, sub: sub,
          protos: map, unknown: d.ports == null, dim: !g.online || !!dev, tag: dev ? T('wz.in_list') : null, knownDev: dev,
          gw: g, dev: d, twin: d.twin ? { peer: (c.peers || []).filter(function (p) { return p.peerId === d.twin.peerId; })[0] || null } : null,
          search: [d.name, d.address, d.vendor].join(' '),
        };
        (any || d.ports == null ? grp.rows : grp.more).push(it);
      });
      groups.push(grp);
    });
    var rt = { id: 'routes', title: T('wz.grp_routes'), rows: [], more: [] };
    (c.routes || []).forEach(function (r) {
      var map = {};
      map[r.protocol] = r.target.port;
      rt.rows.push({
        key: 'r' + r.routeId, kind: 'route', ico: 'rt', glyph: 'route', name: r.name, address: r.target.host,
        sub: [T('wz.route_sub', { port: r.listenPort }), r.target.name ? T('wz.route_target', { name: r.target.name }) : mono(r.target.host)],
        protos: map, route: r, search: [r.name, r.target.host, r.target.name].join(' '),
      });
    });
    if (rt.rows.length) groups.push(rt);
    groups.push({ id: 'ext', title: T('wz.grp_ext'), rows: [{ key: 'ext', kind: 'ext', ico: 'ext', glyph: 'globe', name: T('wz.ext_name'), sub: [T('wz.ext_sub')], protos: {}, search: '' }], more: [] });
    return groups;
  }

  // ─── the wizard ───
  function open(opts) {
    var o = opts || {};
    var retarget = !!o.device;
    var S = {
      step: 1, cand: null, candErr: null, groups: [], sel: null, filter: 'all', q: '', showMore: {},
      proto: 'rdp', port: 3389, portTouched: false, name: '', extHost: '', extWay: null, wayBusy: false, twinVia: 'vpn', gwPick: null,
      scan: null, scanBusy: false, scanErr: null, scanKey: null,
      user: '', password: '', sshMode: 'gc', privateKey: '', passphrase: '', browser: true,
      saving: false, saveErr: null, saved: null, publicKey: null, again: null, agent: null, agentCtl: null, adoptPick: '',
    };
    var F = o.features || {};
    var resolveFn;
    var done = new Promise(function (r) { resolveFn = r; });
    var body = el('div', { class: 'rmx-body' });
    var stepsBox = el('div', { class: 'rmx-steps' });
    var back = el('button', { type: 'button', class: 'btn rmx-ghost', text: T('wz.back') });
    var cancel = el('button', { type: 'button', class: 'btn rmx-ghost', text: T('common.cancel') });
    var next = el('button', { type: 'button', class: 'btn btn-primary', text: T('wz.next') });
    var title = el('div', { class: 'rmx-title', text: retarget ? T('wz.retarget_title', { name: o.device.name }) : T('dev.add') });
    var close = el('button', { type: 'button', class: 'rmx-x', 'aria-label': T('common.close'), text: '×' });
    var hintFoot = el('span', { class: 'rmx-small', text: T('ag.close_ok'), hidden: true });
    var modal = el('div', { class: 'modal rmx-modal rm-wiz' }, [
      el('div', { class: 'rmx-head' }, [title, close]), stepsBox, body,
      el('div', { class: 'rmx-foot' }, [back, hintFoot, el('span', { class: 'rmx-sp' }), cancel, next]),
    ]);
    var ov = el('div', { class: 'modal-overlay rmx-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('dev.add') }, [modal]);
    function finish(v) { if (S.agentCtl) S.agentCtl.stop(); P.hideTip(); ov.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); resolveFn(v); }
    function onKey(ev) { if (ev.key === 'Escape' && document.querySelectorAll('.modal-overlay')[document.querySelectorAll('.modal-overlay').length - 1] === ov) close.click(); }
    var wasWide = null;
    function onResize() { var w = wide(); if (w !== wasWide && S.step === 1) render(); }
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    /** 1.8: list and details side by side (the frame is wide enough) */
    function wide() { return (window.innerWidth || 0) >= 820; }
    close.addEventListener('click', function () { finish(S.saved ? { saved: S.saved } : null); });
    cancel.addEventListener('click', function () { finish(S.saved ? { saved: S.saved } : null); });
    back.addEventListener('click', function () {
      if (S.step === 'A') { if (S.agentCtl) S.agentCtl.stop(); S.agentCtl = null; go(1); return; }
      if (S.step === 3 && wide()) { go(1); return; }
      if (S.step > 1 && S.step < 4) go(S.step - 1);
    });
    next.addEventListener('click', onNext);

    // ── the effective target of the selection (twin: the way chosen) ──
    function eff() {
      var s = S.sel;
      if (!s) return null;
      if (s.kind === 'peer' && s.twin && s.twin.dev && S.twinVia === 'lan') return { kind: 'lan', host: s.twin.dev.address, gw: s.twin.gw, dev: s.twin.dev };
      if (s.kind === 'lan' && s.twin && s.twin.peer && S.twinVia === 'vpn') return { kind: 'peer', host: s.twin.peer.address, peer: s.twin.peer };
      if (s.kind === 'peer') return { kind: 'peer', host: s.peer.address, peer: s.peer };
      if (s.kind === 'lan') return { kind: 'lan', host: s.dev.address, gw: s.gw, dev: s.dev };
      if (s.kind === 'route') {
        var t = s.route.target;
        if (t.kind === 'gateway') {
          // 1.7.2: a route to a pool is checked through an online gateway of it
          var ph = t.poolId ? (S.cand && S.cand.homes || []).filter(function (h) { return h.pool && h.pool.poolId === t.poolId; })[0] : null;
          return { kind: 'route', host: t.host, gwPeerId: t.peerId || (ph && ph.online ? ph.peerId : null), poolId: t.poolId || null, route: s.route };
        }
        return { kind: 'route', host: t.host, route: s.route, direct: true };
      }
      if (s.kind === 'ext') {
        var w = S.extWay;
        if (!w || !S.extHost) return { kind: 'ext', host: S.extHost, way: null };
        if (w.way.kind === 'gateway' && w.way.gateway) {
          var g = homeOf(S.cand, w.way.gateway.peerId) || (S.cand && S.cand.gateways || []).filter(function (x) { return x.peerId === w.way.gateway.peerId; })[0] || w.way.gateway;
          return { kind: 'lan', host: S.extHost, gw: g, dev: null, free: true };
        }
        if (w.way.kind === 'vpn' && w.way.peer) return { kind: 'peer', host: w.way.peer.address, peer: w.way.peer, free: true };
        return { kind: 'ext', host: S.extHost, way: w.way };
      }
      return null;
    }
    /** The way as one line, the settings it stands for, where to scan. */
    function way() {
      var e = eff();
      if (!e) return null;
      if (e.kind === 'peer') {
        return { title: T('wz.way_vpn'), text: T('wz.way_vpn_text'), adv: T('wz.adv_vpn'), listen: null, apps: T('wz.apps_direct_vpn'),
          access: { access_mode: 'internal' }, scan: { host: e.host }, sub: T('wz.sub_vpn') };
      }
      if (e.kind === 'lan') {
        var g = e.gw;
        var pool = g.pool || null;
        // 1.7.2: a pool of several gateways — the target goes through the pool (failover), checked through one online
        var many = !!(pool && g.members && g.members.length > 1);
        var poolName = pool ? (pool.name || g.name) : null;
        var via = g.online === false ? null : (g.members ? viaOf(g, e.dev, false) : { peerId: g.peerId });
        return { title: many ? T('wz.way_pool', { name: poolName }) : T('wz.way_gateway', { name: g.name }), text: pool ? T('wz.way_gateway_pool', { pool: poolName }) : T('wz.way_gateway_text'),
          adv: many ? T('wz.adv_pool', { name: poolName }) + ' · ' + g.members.map(function (m) { return m.name; }).join(', ')
            : T('wz.adv_gateway', { name: g.name }) + (pool ? ' · ' + T('wz.adv_pool', { name: poolName }) : ''), listen: T('wz.listen_auto'), apps: T('wz.apps_server'),
          access: pool ? { access_mode: 'gateway', gateway_pool_id: pool.poolId } : { access_mode: 'gateway', gateway_peer_id: g.peerId },
          scan: via ? { host: e.host, gatewayPeerId: via.peerId } : null, offline: g.online === false, gw: g, pool: many ? poolName : null,
          sub: many ? T('wz.sub_pool', { name: poolName }) : T('wz.sub_gateway', { name: g.name }) };
      }
      if (e.kind === 'route') {
        var r = e.route;
        if (e.direct) {
          return { title: T('wz.way_route_vpn', { name: r.name }), text: T('wz.way_vpn_text'), adv: T('wz.adv_vpn'), listen: null, apps: T('wz.apps_direct_vpn'),
            access: { access_mode: 'internal' }, scan: { host: e.host }, sub: T('wz.sub_vpn') };
        }
        return { title: T('wz.way_route', { name: r.name }), text: T('wz.way_route_text'), adv: T('wz.adv_route', { name: r.name }), listen: String(r.listenPort), apps: T('wz.apps_server'),
          access: e.poolId ? { access_mode: 'gateway', gateway_pool_id: e.poolId, gateway_listen_port: r.listenPort } : { access_mode: 'gateway', gateway_peer_id: e.gwPeerId, gateway_listen_port: r.listenPort },
          scan: e.gwPeerId ? { host: e.host, gatewayPeerId: e.gwPeerId } : null, sub: T('wz.sub_route', { name: r.name }) };
      }
      if (!e.way) return null;
      if (e.way.kind === 'server') {
        return { title: T('wz.way_server'), text: T('wz.way_server_text'), adv: T('wz.adv_server'), listen: null, apps: T('wz.apps_direct_vpn'),
          access: { access_mode: 'internal' }, scan: { host: e.host }, sub: T('wz.sub_server') };
      }
      return { title: T('wz.way_internet'), text: T('wz.way_internet_text'), adv: T('wz.adv_internet'), listen: null, apps: T('wz.apps_direct'),
        access: { access_mode: 'both', external_hostname: e.host, external_port: S.port }, scan: { host: e.host }, ext: true, sub: T('wz.sub_internet') };
    }

    // ── scanning ──
    function scanPorts() {
      var list = SCAN_PORTS.slice();
      if (S.port && list.indexOf(S.port) < 0) list.unshift(S.port);
      return list.slice(0, 8);
    }
    function runScan() {
      var w = way();
      if (!w || !w.scan || S.sel.self) return;
      var key = JSON.stringify([w.scan, scanPorts()]);
      if (S.scanKey === key && (S.scan || S.scanBusy)) return;
      S.scanKey = key;
      S.scanBusy = true;
      S.scanErr = null;
      S.scan = null;
      var sent = key;
      P.api('POST', 'admin/candidates/scan', { host: w.scan.host, gatewayPeerId: w.scan.gatewayPeerId || undefined, ports: scanPorts() }).then(function (r) {
        if (S.scanKey !== sent) return;
        S.scan = r.scan;
        // the protocol of what answers: the greeting first (SSH, VNC, Telnet on any port), then the usual ports
        var open = openMap();
        // only when nothing was known before (the watch had no ports, free text, a route): a choice from the list stays,
        // a closed port of it is said so (state „Port zu“)
        if (!S.protoTouched && !Object.keys(S.sel.protos || {}).length) {
          var pick = null;
          (r.scan.results || []).forEach(function (x) { if (x.open && x.service && x.port === S.port) pick = x.service; });
          if (!pick && !open[S.proto]) pick = firstProto(open, null);
          if (pick && PROTOS.indexOf(pick) >= 0) { S.proto = pick; if (!S.portTouched) S.port = open[pick] || DEF_PORT[pick]; }
        }
      }).catch(function (e) {
        if (S.scanKey !== sent) return;
        S.scanErr = (e && e.data && e.data.code) || 'failed';
      }).then(function () { if (S.scanKey === sent) { S.scanBusy = false; render(); } });
    }
    /** what answered → { ssh: 22, … } (the greeting wins over the port) */
    function openMap() {
      var out = {};
      ((S.scan && S.scan.results) || []).forEach(function (x) {
        if (!x.open) return;
        var pr = x.service || protoOfPort(x.port);
        if (pr && !out[pr]) out[pr] = x.port;
      });
      return out;
    }
    function resultOf(port) { return ((S.scan && S.scan.results) || []).filter(function (x) { return x.port === port; })[0] || null; }

    // ── the steps ──
    function go(n) {
      S.step = n;
      if (n === 2 && S.sel && (S.sel.kind === 'agent' || S.sel.kind === 'apps')) { render(); body.scrollTop = 0; return; }
      if (n === 2) {
        if (S.sel && S.sel.kind === 'ext' && S.extHost && !S.extWay) resolveExt();
        else runScan();
      }
      render();
      body.scrollTop = 0; // 1.7.2: the body scrolls inside the dialog — each step from its top
    }
    function onNext() {
      if (S.step === 'AD') { finish({ connectId: S.agent.deviceId, saved: true }); return; }
      if (S.sel && S.sel.kind === 'agent' && (S.step === 2 || (S.step === 1 && wide()))) { if (F.enroll) go('A'); return; }
      if (S.step === 1 && wide() && S.sel) {
        if (!canGoOn()) return;
        if (retarget) { finish({ target: result() }); return; }
        go(3);
        return;
      }
      if (S.step === 1) { if (S.sel) go(2); return; }
      if (S.step === 2) {
        if (retarget) { finish({ target: result() }); return; }
        go(3);
        return;
      }
      if (S.step === 3) { save(); return; }
      if (S.step === 4) connectNow();
    }

    function pick(it) {
      var keep = body.querySelector('.rmx-colL');
      S.listTop = keep ? keep.scrollTop : 0;
      S.sel = it;
      S.scan = null; S.scanErr = null; S.scanKey = null; S.protoTouched = false; S.portTouched = false; S.extWay = null; S.gwPick = null;
      S.twinVia = 'vpn';
      S.name = it.kind === 'ext' ? '' : it.name;
      if (it.kind === 'ext') { S.extHost = ''; S.port = DEF_PORT[S.proto] || 3389; }
      else {
        S.proto = it.kind === 'route' ? it.route.protocol : firstProto(it.protos, retarget ? o.device.protocol : 'rdp');
        S.port = it.kind === 'route' ? it.route.target.port : (it.protos[S.proto] || DEF_PORT[S.proto]);
      }
      if (it.kind === 'agent' || it.kind === 'apps') { S.name = ''; render(); return; }
      // 1.8: on a wide frame the details of step 2 stand beside the list — the check starts with the choice
      if (wide() && it.kind !== 'ext') runScan();
      render();
    }

    function resolveExt() {
      var host = S.extHost.trim();
      if (!host) { S.extWay = null; render(); return; }
      S.wayBusy = true;
      render();
      P.api('POST', 'admin/way', { host: host, port: S.port, gatewayPeerId: S.gwPick || undefined }).then(function (r) {
        if (S.extHost.trim() !== host) return;
        S.extWay = r;
        if (!S.name) S.name = host.split('.')[0].slice(0, 100);
        S.scanKey = null;
        runScan();
      }).catch(function (e) { S.extWay = null; S.scanErr = (e && e.data && e.data.code) || 'invalid'; }).then(function () { S.wayBusy = false; render(); });
    }

    // the new target (retarget) or the body of the new device
    function result() {
      var w = way();
      var e = eff();
      var cfg = Object.assign({ host: e.host, port: S.port, access_mode: 'internal', gateway_peer_id: null, gateway_pool_id: null, external_hostname: null, external_port: null },
        w ? w.access : {});
      if (cfg.access_mode === 'gateway' && cfg.gateway_listen_port == null) cfg.gateway_listen_port = retarget && o.device.config.access_mode === 'gateway' ? o.device.config.gateway_listen_port : null;
      if (cfg.access_mode !== 'gateway') cfg.gateway_listen_port = null;
      if (cfg.access_mode === 'both') cfg.external_port = S.port;
      return { protocol: S.proto, name: (S.name || '').trim(), config: cfg, way: w };
    }

    function save() {
      var r = result();
      if (!r.name) { S.saveErr = T('wz.name_missing'); render(); return; }
      var body2 = { name: r.name, protocol: r.protocol, config: Object.assign({}, r.config, { browser_enabled: !!S.browser }), access: 'admins' };
      var cred = {};
      if (S.user.trim()) cred.username = S.user.trim();
      if (r.protocol === 'ssh') {
        if (S.sshMode === 'own' && S.privateKey.trim()) { cred.privateKey = S.privateKey; if (S.passphrase) cred.passphrase = S.passphrase; }
        if (S.sshMode === 'password' && S.password) cred.password = S.password;
      } else if (S.password) cred.password = S.password;
      if (Object.keys(cred).length) body2.credentials = cred;
      S.saving = true; S.saveErr = null;
      render();
      P.api('POST', 'admin/devices', body2).then(function (res) {
        S.saved = res.device;
        if (r.protocol === 'ssh' && S.sshMode === 'gc') {
          return P.api('POST', 'admin/devices/' + res.device.id + '/key', { username: S.user.trim() || undefined }).then(function (k) { S.publicKey = k.publicKey; S.saved = k.device || S.saved; })
            .catch(function (e) { S.saveErr = P.errText(e); });
        }
        return null;
      }).then(function () { S.saving = false; if (S.saved) go(4); else render(); }).catch(function (e) {
        S.saving = false;
        var d = (e && e.data) || {};
        S.saveErr = P.errText(e) + (d.field ? ' (' + T('f.' + String(d.field).replace(/^credentials\./, '')) + ')' : '');
        render();
      });
    }

    function connectNow() {
      if (!S.saved) return;
      next.disabled = true;
      P.api('POST', 'admin/devices/' + S.saved.id + '/connect', {}).then(function (r) { return P.openSession(r.session.ref, body); }).catch(P.warn).then(function () { next.disabled = false; });
    }

    // ── render ──
    function render() {
      P.hideTip();
      P.clear(stepsBox);
      var agentPath = S.sel && S.sel.kind === 'agent' && !retarget;
      var w = wide();
      wasWide = w;
      var labels = retarget ? ['wz.step1', 'wz.step2'] : (agentPath ? ['wz.step1', 'ag.step2', 'ag.step3'] : (w ? ['wz.step12', 'wz.step3'] : ['wz.step1', 'wz.step2', 'wz.step3']));
      var cur = agentPath ? (S.step === 'A' ? 2 : (S.step === 'AD' ? 3 : 1)) : (w && !retarget ? (S.step <= 2 ? 1 : S.step - 1) : S.step);
      labels.forEach(function (k, i) {
        var n = i + 1;
        stepsBox.appendChild(el('span', { class: n === cur ? 'on' : (n < cur ? 'done' : '') }, [el('b', { text: n < cur ? '✓' : String(n) }), T(k)]));
      });
      title.textContent = retarget ? T('wz.retarget_title', { name: o.device.name }) : (agentPath && S.step !== 1 ? T('ag.title') : T('dev.add'));
      var root = body;
      P.clear(root);
      root.classList.remove('rmx-two');
      if (S.step === 1 && w) {
        root.classList.add('rmx-two');
        var L = el('div', { class: 'rmx-colL' });
        var R = el('div', { class: 'rmx-colR', 'aria-live': 'polite' });
        root.appendChild(L);
        root.appendChild(R);
        body = L;
        step1();
        body = R;
        if (!S.sel) body.appendChild(el('div', { class: 'rmx-empty' }, [svg('way', 28), el('b', { text: T('wz.pick_head') }), el('span', { class: 'rmx-small', text: T('wz.pick_text') })]));
        else step2();
        body = root;
        if (S.listTop) L.scrollTop = S.listTop;
      } else if (S.step === 1) step1();
      else if (S.step === 2) step2();
      else if (S.step === 3) step3();
      else if (S.step === 'A') stepAgent();
      else if (S.step === 'AD') stepAgentDone();
      else step4();
      back.hidden = S.step === 1 || S.step === 4 || S.step === 'AD';
      cancel.textContent = S.step === 4 || S.step === 'A' || S.step === 'AD' ? T('common.close') : T('common.cancel');
      next.textContent = S.step === 4 || S.step === 'AD' ? T('dev.connect') : (S.step === 3 ? T('common.save') : ((S.step === 2 || (S.step === 1 && w)) && retarget ? T('wz.apply') : T('wz.next')));
      next.hidden = (S.step === 4 && !(S.saved && S.saved.config && S.saved.config.browser_enabled)) || S.step === 'A' || (S.step === 'AD' && !(S.agent && S.agent.device && S.agent.device.ssh))
        || (agentPath && !F.enroll) || !!(S.sel && S.sel.kind === 'apps');
      next.disabled = (S.step === 1 && !S.sel) || ((S.step === 2 || (S.step === 1 && w && S.sel && !agentPath)) && !canGoOn()) || S.saving;
      hintFoot.hidden = S.step !== 'A';
    }
    function canGoOn() {
      if (S.sel && S.sel.kind === 'agent') return true;
      if (!S.sel || S.sel.self || S.sel.kind === 'apps') return false;
      if (S.sel.kind === 'ext') return !!(S.extHost.trim() && S.extWay && !S.wayBusy);
      return !!S.port;
    }

    function step1() {
      if (!S.cand && !S.candErr) { body.appendChild(el('p', { class: 'rm-hint' }, [el('span', { class: 'rm-spin' }), ' ', T('common.loading')])); return; }
      var q = el('input', { type: 'text', placeholder: T('wz.search'), 'aria-label': T('wz.search_label'), value: S.q });
      body.appendChild(el('div', { class: 'rmx-search' }, [svg('search', 16), q]));
      var filters = el('div', { class: 'rmx-filters', role: 'group', 'aria-label': T('wz.filter') });
      [['all', T('wz.all')], ['ssh', 'SSH'], ['rdp', 'RDP'], ['vnc', 'VNC']].forEach(function (f) {
        filters.appendChild(el('button', { type: 'button', class: 'rmx-fchip', 'aria-pressed': S.filter === f[0] ? 'true' : 'false', text: f[1], on: { click: function () { S.filter = f[0]; render(); } } }));
      });
      body.appendChild(filters);
      if (S.candErr) body.appendChild(note('err', T('wz.cand_failed'), S.candErr));
      var list = el('div', { class: 'rmx-list' });
      body.appendChild(list);
      var drawList = function () {
        P.clear(list);
        var needle = S.q.trim().toLowerCase();
        var match = function (it) {
          if (it.kind === 'ext') return true;
          if (it.kind === 'agent' || it.kind === 'apps') return !needle || (it.search + ' ' + it.name).toLowerCase().indexOf(needle) >= 0;
          var okQ = !needle || (it.search + ' ' + it.name).toLowerCase().indexOf(needle) >= 0;
          var okF = S.filter === 'all' || !!it.protos[S.filter];
          return okQ && okF;
        };
        S.groups.forEach(function (g) {
          var rows = g.rows.filter(match);
          var more = g.more.filter(match);
          var showMore = !!S.showMore[g.id] || !!needle;
          if (!rows.length && !(more.length && showMore) && !(g.gw && !needle && S.filter === 'all')) return;
          list.appendChild(el('div', { class: 'rmx-grp' }, [g.title, el('span', { class: 'gl' }), g.state ? el('span', { class: 'st' }, [g.state]) : null]));
          rows.forEach(function (it) { list.appendChild(rowEl(it)); });
          if (showMore) more.forEach(function (it) { list.appendChild(rowEl(it)); });
          if (g.gw && g.gw.watch && !g.gw.watch.enabled) list.appendChild(el('div', { class: 'rmx-more', text: T('wz.watch_off', { name: g.gw.name }) }));
          else if (g.gw && !g.rows.length && !g.more.length) list.appendChild(el('div', { class: 'rmx-more', text: T('wz.gw_empty') }));
          if (more.length && !showMore) {
            list.appendChild(el('div', { class: 'rmx-more' }, [T('wz.more', { n: more.length }) + ' · ',
              el('button', { type: 'button', class: 'rmx-lnk', text: T('wz.show'), on: { click: function () { S.showMore[g.id] = true; drawList(); } } })]));
          }
        });
      };
      q.addEventListener('input', function () { S.q = q.value; drawList(); });
      drawList();
    }
    function rowEl(it) {
      var b = el('button', { type: 'button', class: 'rmx-row' + (it.dim ? ' dim' : '') + (it.big ? ' big' : '') + (S.sel && S.sel.key === it.key ? ' sel' : ''), 'data-k': it.key, 'aria-pressed': S.sel && S.sel.key === it.key ? 'true' : 'false' }, [
        ico(it.ico, it.glyph),
        el('span', { class: 'rmx-rmain' }, [el('span', { class: 'rmx-rname', text: it.name }), el('span', { class: 'rmx-rsub' }, joinSub(it.sub))]),
        it.flat ? null : protosEl(it),
        it.tag ? tag(it.tag, 'ok') : null,
      ]);
      b.addEventListener('click', function () { pick(it); });
      b.addEventListener('dblclick', function () { pick(it); onNext(); });
      return b;
    }
    function protosEl(it) {
      var box = el('span', { class: 'rmx-protos' });
      if (it.kind === 'ext') return null;
      if (it.unknown && !Object.keys(it.protos).length) { box.appendChild(el('span', { class: 'rmx-p', text: '?' })); return box; }
      var shown = ORDER.filter(function (p) { return it.protos[p]; });
      shown.forEach(function (p) { box.appendChild(el('span', { class: 'rmx-p on', text: T('proto.' + p) })); });
      return shown.length ? box : null;
    }

    function note(tone, head, text, acts) {
      var icon = tone === 'ok' ? svg('ok', 18, 2.4) : svg(tone === 'err' ? 'err' : (tone === 'warn' ? 'warn' : 'info'));
      return el('div', { class: 'rmx-note ' + tone, role: tone === 'err' || tone === 'warn' ? 'alert' : 'status' }, [icon, el('div', null, [
        el('b', null, typeof head === 'string' ? [head] : head),
        text ? el('span', { class: 'rmx-small', text: text }) : null,
        acts && acts.length ? el('div', { class: 'acts' }, acts) : null,
      ])]);
    }
    function sbtn(label, fn, ghost) { return el('button', { type: 'button', class: 'btn btn-sm' + (ghost ? ' rmx-ghost' : ''), text: label, on: { click: fn } }); }

    function targetCard(nameText, subNodes, goTo, right) {
      var s = S.sel;
      var e = eff();
      var kind = e && e.kind === 'peer' ? 'vpn' : (e && e.kind === 'lan' ? 'lan' : (s.kind === 'route' ? 'rt' : (s.kind === 'ext' ? 'ext' : s.ico)));
      return el('div', { class: 'rmx-target' }, [ico(kind, s.glyph), el('span', { class: 'rmx-rmain' }, [el('span', { class: 'rmx-rname', text: nameText }),
        el('span', { class: 'rmx-rsub' }, subNodes)]), right || null, goTo ? sbtn(T('wz.change'), function () { go(goTo); }, true) : null]);
    }

    function step2() {
      var s = S.sel;
      if (!s) { go(1); return; }
      if (s.kind === 'agent') { agentPane(); return; }
      if (s.kind === 'apps') { appsPane(); return; }
      // a PC or Linux computer that registers itself
      if (s.self) {
        body.appendChild(targetCard(s.name, joinSub([T(s.self === 'windows' ? 'wz.self_windows' : 'wz.self_linux')]), 1, s.hostDev ? tag(T('wz.in_list'), 'ok') : null));
        var acts = s.hostDev ? [sbtn(T('wz.to_device'), function () { finish({ open: s.hostDev.id }); })] : [];
        body.appendChild(note('info', T(s.self === 'windows' ? 'wz.self_head' : 'wz.self_head_linux'), T(s.self === 'windows' ? 'wz.self_text' : 'wz.self_text_linux'), acts));
        body.appendChild(el('p', { class: 'rmx-small', text: T('wz.self_more') }));
        return;
      }
      var e = eff();
      var subParts = s.kind === 'ext' ? [T('wz.ext_sub')] : (e && e.host ? [mono(e.host)] : []).concat(s.dev && s.dev.vendor ? [s.dev.vendor] : []);
      if (s.kind === 'lan' && !s.gw.online) subParts.push(T('wz.state_of', { when: P.when(s.dev.lastSeen) }));
      body.appendChild(targetCard(s.kind === 'ext' ? T('wz.ext_title') : s.name, joinSub(subParts), 1));
      // twice known: VPN suggested, the home network to choose
      if (s.twin && ((s.kind === 'peer' && s.twin.dev) || (s.kind === 'lan' && s.twin.peer))) twinChoice(s);
      // free text: address and port
      if (s.kind === 'ext') extFields();
      // protocol
      var open = openMap();
      var seg = el('div', { class: 'rmx-seg', role: 'group', 'aria-label': T('dev.protocol') });
      PROTOS.forEach(function (p) {
        var small;
        var scanned = !!S.scan;
        var isOpen = !!open[p];
        if (S.scanBusy) small = '…';
        else if (scanned) small = isOpen ? (S.sel.kind === 'ext' && resultOf(open[p]) && resultOf(open[p]).service === p ? T('wz.recognised') : T('wz.open')) : (resultOf(DEF_PORT[p]) && resultOf(DEF_PORT[p]).open === false ? T('wz.closed') : '–');
        else if (s.protos && s.protos[p]) small = T('wz.open');
        else small = s.unknown ? '?' : String(DEF_PORT[p]);
        seg.appendChild(el('button', { type: 'button', class: isOpen || (!scanned && s.protos && s.protos[p]) ? 'det' : '', 'aria-pressed': S.proto === p ? 'true' : 'false', on: { click: function () {
          S.proto = p; S.protoTouched = true;
          if (!S.portTouched || s.kind !== 'ext') { S.port = open[p] || (s.protos && s.protos[p]) || DEF_PORT[p]; S.portTouched = false; }
          runScan();
          render();
        } } }, [T('proto.' + p), el('small', { text: small })]));
      });
      body.appendChild(el('div', { class: 'rmx-field' }, [el('span', { class: 'rmx-flabel', text: T('dev.protocol') }), seg]));
      // name and port
      var nameIn = el('input', { class: 'form-input', type: 'text', id: 'rmx-name', maxlength: '100', value: S.name, autocomplete: 'off' });
      nameIn.addEventListener('input', function () { S.name = nameIn.value; });
      var portIn = el('input', { class: 'form-input rmx-mono', type: 'number', id: 'rmx-port', min: '1', max: '65535', value: String(S.port || '') });
      portIn.addEventListener('change', function () {
        var n = parseInt(portIn.value, 10);
        S.port = n >= 1 && n <= 65535 ? n : null; S.portTouched = true;
        if (S.port) runScan();
        render();
      });
      if (s.kind !== 'ext') {
        body.appendChild(el('div', { class: 'rmx-g2' }, [
          el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-name', text: T('wz.list_name') }), nameIn]),
          el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-port', text: T('f.port') }), portIn]),
        ]));
      } else {
        body.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-name', text: T('wz.list_name') }), nameIn]));
      }
      var w = way();
      if (s.kind === 'ext' && !S.extHost.trim()) return;
      if (s.kind === 'ext' && (S.wayBusy || !w)) {
        if (S.wayBusy) body.appendChild(note('info', [el('span', { class: 'rmx-pill' }, [el('span', { class: 'rm-spin' }), T('wz.resolving')])]));
        else if (S.scanErr) body.appendChild(note('err', T('error.' + S.scanErr)));
        return;
      }
      if (S.extWay && S.extWay.way && S.extWay.way.choices && S.extWay.way.choices.length > 1) gwChoice(S.extWay.way.choices);
      checkNote(w);
      if (w) {
        body.appendChild(el('div', { class: 'rmx-way' }, [svg(w.ext ? 'globe' : 'way'), el('div', null, [el('b', { text: w.title }), el('br'), el('span', { text: w.text })])]));
        body.appendChild(el('details', { class: 'rmx-adv' }, [el('summary', { text: T('wz.advanced') }), el('div', { class: 'advb' }, [
          el('div', { class: 'rmx-kv' }, [
            el('span', { text: T('wz.kv_way') }), el('b', { text: T('wz.automatic', { what: w.adv }) }),
            el('span', { text: T('f.gateway_listen_port') }), el('b', { text: w.listen ? (s.kind === 'route' ? w.listen : T('wz.listen_auto_example')) : T('wz.none') }),
            el('span', { text: T('wz.kv_apps') }), el('b', { text: w.apps }),
          ]),
          el('span', { class: 'rmx-small', text: T('wz.advanced_text') }),
        ])]));
      }
    }

    function twinChoice(s) {
      var vpnAddr = s.kind === 'peer' ? s.peer.address : s.twin.peer.address;
      var lanAddr = s.kind === 'lan' ? s.dev.address : s.twin.dev.address;
      var home = s.kind === 'lan' ? s.gw : s.twin.gw;
      var gwName = home ? home.name : '';
      var lanText = home && home.pool && home.members && home.members.length > 1 ? T('wz.twin_lan_pool', { name: gwName }) : T('wz.twin_lan_text', { name: gwName });
      var box = el('div', { class: 'rmx-radio', role: 'radiogroup', 'aria-label': T('wz.which_way') });
      [['vpn', [T('wz.twin_vpn') + ' · ', mono(vpnAddr), ' ', tag(T('wz.recommended'), 'ok')], T('wz.twin_vpn_text')],
        ['lan', [T('wz.twin_lan') + ' · ', mono(lanAddr)], lanText]].forEach(function (x) {
        box.appendChild(el('button', { type: 'button', class: 'rmx-ropt', role: 'radio', 'aria-checked': S.twinVia === x[0] ? 'true' : 'false', 'aria-pressed': S.twinVia === x[0] ? 'true' : 'false', on: { click: function () {
          S.twinVia = x[0]; S.scanKey = null; runScan(); render();
        } } }, [el('span', { class: 'dot' }), el('div', null, [el('b', null, x[1]), el('span', { text: x[2] })])]));
      });
      body.appendChild(el('span', { class: 'rmx-flabel', text: T('wz.which_way') }));
      body.appendChild(box);
      body.appendChild(el('p', { class: 'rmx-small', text: T('wz.twin_hint') }));
    }

    function gwChoice(choices) {
      var box = el('div', { class: 'rmx-radio', role: 'radiogroup', 'aria-label': T('wz.which_gateway') });
      var cur = S.extWay.way.gateway ? S.extWay.way.gateway.peerId : null;
      choices.forEach(function (g) {
        box.appendChild(el('button', { type: 'button', class: 'rmx-ropt', role: 'radio', 'aria-checked': cur === g.peerId ? 'true' : 'false', 'aria-pressed': cur === g.peerId ? 'true' : 'false', on: { click: function () {
          S.gwPick = g.peerId; S.extWay = null; resolveExt();
        } } }, [el('span', { class: 'dot' }), el('div', null, [el('b', { text: g.pool && g.pool.name ? T('wz.way_pool', { name: g.pool.name }) : T('wz.way_gateway', { name: g.name }) }), el('span', { text: g.online ? T('state.online') : T('state.offline') })])]));
      });
      body.appendChild(el('span', { class: 'rmx-flabel', text: T('wz.which_gateway') }));
      body.appendChild(box);
    }

    function extFields() {
      var hostIn = el('input', { class: 'form-input rmx-mono', type: 'text', id: 'rmx-ext', maxlength: '253', value: S.extHost, autocomplete: 'off', spellcheck: 'false', placeholder: T('wz.ext_placeholder') });
      var portIn = el('input', { class: 'form-input rmx-mono', type: 'number', id: 'rmx-extport', min: '1', max: '65535', value: String(S.port || '') });
      var apply = function () {
        var h = hostIn.value.trim();
        var n = parseInt(portIn.value, 10);
        var portChanged = n >= 1 && n <= 65535 && n !== S.port;
        if (portChanged) { S.port = n; S.portTouched = true; }
        if (h !== S.extHost.trim() || !S.extWay) { S.extHost = h; S.extWay = null; S.gwPick = null; S.scan = null; S.scanKey = null; resolveExt(); }
        else if (portChanged) { S.scanKey = null; runScan(); render(); }
      };
      hostIn.addEventListener('change', apply);
      hostIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
      portIn.addEventListener('change', apply);
      body.appendChild(el('div', { class: 'rmx-g2' }, [
        el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-ext', text: T('wz.address') }), hostIn]),
        el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-extport', text: T('f.port') }), portIn]),
      ]));
      if (!S.extHost) setTimeout(function () { try { hostIn.focus(); } catch (e) { /* gone */ } }, 0);
    }

    /** The check of step 2 and the states: unreachable, port closed, gateway offline, outside with or without a port. */
    function checkNote(w) {
      var s = S.sel;
      var e = eff();
      var via = w && w.scan && w.scan.gatewayPeerId ? T('wz.via_gateway') : T('wz.via_direct');
      if (w && w.offline) {
        body.appendChild(note('warn', T(w.pool ? 'wz.pooloff_head' : 'wz.gwoff_head', { name: w.pool || w.gw.name, since: offlineText(w.gw.offlineSince) }), T('wz.gwoff_text', { proto: T('proto.' + S.proto), port: S.port }),
          [sbtn(T('wz.anyway'), function () { go(3); }, true)]));
        return;
      }
      if (!w || !w.scan) {
        if (w) body.appendChild(note('info', T('wz.no_check')));
        return;
      }
      if (S.scanBusy || (!S.scan && !S.scanErr)) {
        body.appendChild(note('info', [el('span', { class: 'rmx-pill' }, [el('span', { class: 'rm-spin' }), T(w.scan.gatewayPeerId ? 'wz.checking_gw' : 'wz.checking', { ports: scanPorts().join(', ') })])]));
        return;
      }
      if (S.scanErr) {
        if (S.scanErr === 'gateway_offline') { body.appendChild(note('warn', T('wz.gwoff_short'), null, [sbtn(T('wz.recheck'), recheck), sbtn(T('wz.anyway'), function () { go(3); }, true)])); return; }
        if (S.scanErr === 'unreachable' && s.kind === 'ext') { extNo(T('wz.extno_noname')); return; }
        body.appendChild(note('err', T('error.' + S.scanErr), null, [sbtn(T('wz.recheck'), recheck), sbtn(T('wz.anyway'), function () { go(3); }, true)]));
        return;
      }
      var res = resultOf(S.port);
      var open = openMap();
      var others = ORDER.filter(function (p) { return open[p] && p !== S.proto; });
      if (res && res.open) {
        if (w.ext) {
          var svc = res.service && res.service === S.proto ? T('wz.answers_with', { port: S.port, proto: T('proto.' + S.proto) }) : T('wz.answers_port', { port: S.port });
          body.appendChild(note('ok', T('wz.ext_ok', { what: svc })));
          return;
        }
        var head = T('wz.port_ok', { port: S.port, ms: res.responseTime != null ? res.responseTime : '–', via: via });
        if (others.length) head += ' · ' + others.map(function (p) { return T('wz.also_open', { proto: T('proto.' + p), port: open[p] }); }).join(' · ');
        body.appendChild(note('ok', head));
        return;
      }
      if (res && res.open == null) { body.appendChild(note('info', T('wz.gw_cannot'))); return; }
      if (others.length) {
        var first = others[0];
        body.appendChild(note('warn', T('wz.closed_head', { proto: T('proto.' + S.proto), port: S.port }),
          T('wz.closed_text', { proto: T('proto.' + S.proto), list: others.map(function (p) { return T('proto.' + p) + ' (' + open[p] + ')'; }).join(T('wz.and')) }), [
            sbtn(T('wz.take', { proto: T('proto.' + first) }), function () { S.proto = first; S.port = open[first]; S.protoTouched = true; render(); }),
            sbtn(T('wz.other_port'), function () { var n = body.querySelector('#rmx-port') || body.querySelector('#rmx-extport'); if (n) n.focus(); }),
            sbtn(T('wz.anyway'), function () { go(3); }, true),
          ]));
        return;
      }
      if (w.ext || (s.kind === 'ext' && e && e.kind === 'ext')) { extNo(T('wz.extno_text')); return; }
      var acts = [];
      var dev = e && e.kind === 'lan' ? e.dev : null;
      if (dev && dev.wake) acts.push(sbtn(T('wz.wake'), function (ev) {
        var b = ev.currentTarget;
        // 1.7.2: through a gateway of the pool that knows the MAC, an online one first
        var wv = (e.gw.members ? viaOf(e.gw, dev, true) : null) || { peerId: e.gw.peerId, ref: dev.ref };
        b.disabled = true;
        P.api('POST', 'admin/candidates/wake', { ref: wv.ref, host: dev.address, gatewayPeerId: wv.peerId }).then(function () { P.toast(T('dev.woken')); }).catch(P.warn).then(function () { b.disabled = false; });
      }));
      acts.push(sbtn(T('wz.recheck'), recheck));
      acts.push(sbtn(T('wz.anyway'), function () { go(3); }, true));
      var seen = dev && !dev.online ? seenText(dev.lastSeen) : null;
      body.appendChild(note('err', T(e && e.kind === 'lan' ? 'wz.unreach_head_gw' : 'wz.unreach_head'), seen ? T('wz.unreach_seen', { ago: seen }) : T('wz.unreach_text'), acts));
      body.appendChild(el('p', { class: 'rmx-small', text: T('wz.unreach_more') }));
    }
    function recheck() { S.scanKey = null; S.scan = null; runScan(); render(); }
    function extNo(text) {
      body.appendChild(note('err', T('wz.extno_head'), text));
      var hint = function (k, glyph, title, t, tg) {
        return el('div', { class: 'rmx-ropt flat' }, [el('span', { class: 'rmx-ico ' + k + ' sm' }, [svg(glyph, 15)]), el('div', null, [el('b', null, [title, tg ? ' ' : null, tg ? tag(tg, 'ok') : null]), el('span', { text: t })])]);
      };
      body.appendChild(el('div', { class: 'rmx-radio' }, [
        hint('vpn', 'pc', T('wz.hint_app'), T('wz.hint_app_text'), T('wz.easiest')),
        hint('lan', 'line', T('wz.hint_gw'), T('wz.hint_gw_text')),
        hint('ext', 'vline', T('wz.hint_fwd'), T('wz.hint_fwd_text')),
      ]));
    }

    function step3() {
      var w = way();
      var nm = (S.name || '').trim() || (S.sel ? S.sel.name : '');
      body.appendChild(targetCard(nm + ' · ' + T('proto.' + S.proto), w ? [w.sub] : [], 2));
      var userIn = el('input', { class: 'form-input', type: 'text', id: 'rmx-user', maxlength: '1024', autocomplete: 'off', spellcheck: 'false', value: S.user });
      userIn.addEventListener('input', function () { S.user = userIn.value; });
      body.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-user', text: T('f.username') }), userIn]));
      var pwIn = el('input', { class: 'form-input', type: 'password', id: 'rmx-pw', maxlength: '1024', autocomplete: 'new-password', value: S.password });
      pwIn.addEventListener('input', function () { S.password = pwIn.value; });
      if (S.proto !== 'ssh') {
        body.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-pw', text: T('f.password') }), pwIn]));
      } else {
        body.appendChild(el('span', { class: 'rmx-flabel', text: T('wz.login_with') }));
        var box = el('div', { class: 'rmx-radio', role: 'radiogroup', 'aria-label': T('wz.login_with') });
        [['gc', [T('wz.key_gc') + ' ', tag(T('wz.recommended'), 'ok')], [T('wz.key_gc_text_a'), el('code', { text: '~/.ssh/authorized_keys' }), T('wz.key_gc_text_b')]],
          ['own', [T('wz.key_own')], [T('wz.key_own_text')]], ['password', [T('f.password')], [T('wz.password_text')]]].forEach(function (x) {
          box.appendChild(el('button', { type: 'button', class: 'rmx-ropt', role: 'radio', 'aria-checked': S.sshMode === x[0] ? 'true' : 'false', 'aria-pressed': S.sshMode === x[0] ? 'true' : 'false', on: { click: function () { S.sshMode = x[0]; render(); } } },
            [el('span', { class: 'dot' }), el('div', null, [el('b', null, x[1]), el('span', null, x[2])])]));
        });
        body.appendChild(box);
        if (S.sshMode === 'own') {
          var keyIn = el('textarea', { class: 'form-input rmx-mono', id: 'rmx-key', rows: '4', maxlength: '16384', spellcheck: 'false', autocomplete: 'off' });
          keyIn.value = S.privateKey;
          keyIn.addEventListener('input', function () { S.privateKey = keyIn.value; });
          var ppIn = el('input', { class: 'form-input', type: 'password', id: 'rmx-pp', maxlength: '1024', autocomplete: 'new-password', value: S.passphrase });
          ppIn.addEventListener('input', function () { S.passphrase = ppIn.value; });
          body.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-key', text: T('f.privateKey') }), keyIn]));
          body.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-pp', text: T('f.passphrase') }), ppIn]));
        }
        if (S.sshMode === 'password') body.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmx-pw', text: T('f.password') }), pwIn]));
      }
      body.appendChild(el('div', { class: 'rmx-vault' }, [svg('lock', 14), T('wz.vault')]));
      var cb = el('input', { type: 'checkbox', id: 'rmx-browser', checked: S.browser });
      cb.addEventListener('change', function () { S.browser = cb.checked; });
      body.appendChild(el('label', { class: 'rmx-chk', for: 'rmx-browser' }, [cb, T('wz.browser')]));
      body.appendChild(el('p', { class: 'rmx-small', text: T('wz.admins_first') }));
      if (S.saveErr) body.appendChild(el('p', { class: 'rm-field-error', role: 'alert', text: S.saveErr }));
    }

    function step4() {
      var d = S.saved;
      var browser = !!(d.config && d.config.browser_enabled);
      body.appendChild(el('div', { class: 'rmx-okbig' }, [el('span', { class: 'rmx-ico' }, [svg('ok', 18, 2.6)]), el('div', null, [
        el('b', { text: T('wz.created', { name: d.name }) }), el('div', { class: 'rmx-small', text: T(browser ? 'wz.created_text' : 'wz.created_text_apps') }),
      ])]));
      if (S.publicKey) {
        body.appendChild(el('label', { class: 'rmx-flabel', for: 'rmx-pub', text: T('f.public_key') }));
        body.appendChild(el('textarea', { class: 'form-input rm-pubkey', id: 'rmx-pub', readonly: true, rows: '3', spellcheck: 'false', value: S.publicKey }));
        body.appendChild(el('p', { class: 'rmx-small', text: T('f.public_key_hint') }));
      }
      if (S.saveErr) body.appendChild(el('p', { class: 'rm-field-error', role: 'alert', text: S.saveErr }));
      // 1.7: one protocol per device — another one that answered is offered with everything filled in
      var open = openMap();
      var other = ORDER.filter(function (p) { return p !== d.protocol && (open[p] || (!S.scan && S.sel && S.sel.protos && S.sel.protos[p])); })[0];
      if (other) {
        body.appendChild(el('div', { class: 'rmx-again' }, [sbtn(T('wz.again', { proto: T('proto.' + other) }), function () {
          var port = open[other] || S.sel.protos[other] || DEF_PORT[other];
          S.saved = null; S.publicKey = null; S.saveErr = null;
          S.proto = other; S.port = port; S.protoTouched = true; S.portTouched = true;
          S.name = (d.name + ' ' + T('proto.' + other)).slice(0, 100);
          S.password = ''; S.privateKey = ''; S.passphrase = '';
          go(2);
        })]));
      }
      body.appendChild(el('span', { class: 'rmx-flabel', text: T('wz.defaults') }));
      var w = S.sel && S.sel.kind === 'lan' ? S.sel.dev : null;
      var wakeText = d.protocol === 'ssh' || d.protocol === 'telnet' ? T('wz.no_wake') : (w && w.wake ? T('wz.wake_possible') : T('wz.no_wake_mac'));
      var display = d.protocol === 'ssh' ? T(d.config.tmux_enabled ? 'wz.term_tmux' : 'wz.term') : (d.protocol === 'telnet' ? T('wz.term') : T('wz.display_default'));
      var accessLink = el('button', { type: 'button', class: 'rmx-lnk', text: T('wz.share_people'), on: { click: function () { share(d); } } });
      var minutes = S.cand && S.cand.checkMinutes;
      body.appendChild(el('div', { class: 'rmx-after' }, [
        el('div', null, [el('b', { text: T('wz.rights') }), el('span', { id: 'rmx-access' }, [T('wz.admins_only') + ' · ', accessLink])]),
        el('div', null, [el('b', { text: T('wz.wake_title') }), el('span', { text: wakeText })]),
        el('div', null, [el('b', { text: T('tab.recording') }), el('span', { text: T('wz.off') })]),
        el('div', null, [el('b', { text: T('dev.check') }), el('span', { text: minutes ? T('wz.every', { n: minutes }) : T('wz.on') })]),
        el('div', null, [el('b', { text: T('tab.display') }), el('span', { text: display })]),
        el('div', null, [el('b', { text: T('wz.notes_tags') }), el('span', { text: T('wz.empty') })]),
      ]));
    }
    function share(d) {
      if (!window.GC || typeof window.GC.pickPrincipals !== 'function') { P.toast(T('wz.no_picker'), 'error'); return; }
      window.GC.pickPrincipals({ groups: true, users: true, multiple: true, title: T('wz.share_title', { name: d.name }) }).then(function (picked) {
        if (!picked || !picked.length) return null;
        var users = picked.filter(function (x) { return x.type === 'user'; }).map(function (x) { return x.id; });
        var groups = picked.filter(function (x) { return x.type === 'group'; }).map(function (x) { return x.id; });
        return P.api('PUT', 'admin/devices/' + d.id + '/access', { users: users.concat((d.access && d.access.users) || []), groups: groups }).then(function (r) {
          S.saved = r.device;
          var box = body.querySelector('#rmx-access');
          if (box) box.textContent = picked.map(function (x) { return x.label; }).join(', ');
        });
      }).catch(P.warn);
    }


    // ── 1.8: „Linux-Gerät mit Agent“ ──
    function agentPane() {
      body.appendChild(el('div', { class: 'rmx-panehead' }, [el('span', { class: 'rmx-ico ag' }, [svg('chip')]), el('b', { text: T('ag.row') })]));
      if (!F.enroll) { var fb = el('div', { class: 'rmx-fallback' }); body.appendChild(fb); window.RMA.fallback(fb, ''); return; }
      var how = el('ol', { class: 'rm-howto' });
      ['ag.how1', 'ag.how2', 'ag.how3'].forEach(function (k) { how.appendChild(el('li', { text: T(k) })); });
      body.appendChild(el('div', null, [el('span', { class: 'rmx-flabel', text: T('ag.how') }), how]));
      body.appendChild(el('div', { class: 'rmx-kv rm-kv-left' }, [
        el('span', { text: T('ag.kv_way') }), el('b', { text: T('ag.kv_way_v') }), el('span', { text: T('ag.kv_login') }), el('b', { text: T('ag.kv_login_v') }),
        el('span', { text: T('ag.kv_hostkey') }), el('b', { text: T('ag.kv_hostkey_v') }), el('span', { text: T('ag.kv_code') }), el('b', { text: T('ag.kv_code_v') }),
      ]));
      body.appendChild(el('details', { class: 'rmx-adv' }, [el('summary', { text: T('ag.install') }), el('div', { class: 'advb' }, [window.RMA.cmdBox('curl -LO https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download/gatecontrol-agent_$(dpkg --print-architecture).deb\nsudo apt install ./gatecontrol-agent_$(dpkg --print-architecture).deb'),
        el('span', { class: 'rmx-small', text: T('ag.install_more') })])]));
      // the device was made by hand already: better „Bearbeiten › Agent“ (one device instead of two)
      var ssh = (o.devices || []).filter(function (d) { return d.kind === 'target' && d.protocol === 'ssh'; });
      if (ssh.length) {
        var sel = el('select', { class: 'form-select', id: 'rmx-adopt', 'aria-label': T('ag.adopt_pick') }, [el('option', { value: '', text: T('ag.adopt_pick') })].concat(ssh.map(function (d) { return el('option', { value: String(d.id), text: d.name + ' · ' + d.config.host, selected: S.adoptPick === String(d.id) }); })));
        sel.addEventListener('change', function () { S.adoptPick = sel.value; });
        body.appendChild(note('info', T('ag.exists_head'), T('ag.exists_text'), [sel, sbtn(T('ag.exists_go'), function () { if (S.adoptPick) finish({ open: parseInt(S.adoptPick, 10), section: 'agent' }); else sel.focus(); })]));
      }
    }
    function appsPane() {
      body.appendChild(el('div', { class: 'rmx-panehead' }, [el('span', { class: 'rmx-ico vpn' }, [svg('pc')]), el('b', { text: T('ag.apps_row') })]));
      body.appendChild(note('info', T('wz.self_head'), T('wz.self_text')));
      body.appendChild(note('info', T('ag.apps_phone_head'), T('ag.apps_phone_text')));
      body.appendChild(el('p', { class: 'rmx-small', text: T('wz.self_more') }));
    }
    function stepAgent() {
      var box = el('div', { class: 'rm-agbox' });
      body.appendChild(box);
      if (S.agentCtl && S.agent) { S.agentCtl = window.RMA.panel(box, { enrollment: S.agent, me: o.me, onRegistered: agentDone, onChange: function (e) { S.agent = e; } }); return; }
      S.agentCtl = window.RMA.panel(box, { me: o.me, auto: false, onRegistered: agentDone, onChange: function (e) { S.agent = e; S.saved = S.saved || true; } });
    }
    function agentDone(e) {
      S.agent = e;
      if (S.agentCtl) S.agentCtl.stop();
      go('AD');
    }
    function stepAgentDone() {
      var e = S.agent;
      var dv = e.device || {};
      body.appendChild(el('div', { class: 'rmx-okbig' }, [el('span', { class: 'rmx-ico' }, [svg('ok', 18, 2.6)]), el('div', null, [
        el('b', { text: T('ag.done_head', { name: e.name }) }), el('div', { class: 'rmx-small', text: T('ag.done_sub', { owner: e.ownerName || '' }) + ' · ' + T(e.options && e.options.open ? 'ag.open' : 'ag.code') })])]));
      var kv = el('div', { class: 'rmx-kv rm-kv-left' });
      var add = function (k, v) { if (v) { kv.appendChild(el('span', { text: k })); kv.appendChild(el('b', { text: v })); } };
      add(T('ag.d_vpn'), dv.vpnIp || e.vpnIp);
      add(T('ag.d_peer'), (e.peerName || e.name) + (dv.appVersion ? ' (Linux Agent ' + dv.appVersion + ')' : ''));
      add(T('ag.d_ssh'), dv.ssh ? T('ag.d_ssh_v', { user: dv.ssh.user, tmux: dv.ssh.tmux ? 'tmux ' + dv.ssh.tmux : T('dev.linux_no_tmux') }) : null);
      add(T('ag.d_hostkey'), dv.hostKey ? dv.hostKey.alg + ' SHA256:' + String(dv.hostKey.sha256).slice(0, 4) + '…' + String(dv.hostKey.sha256).slice(-4) : null);
      add(T('ag.d_desktop'), dv.desktop ? String(dv.desktop.protocol || '').toUpperCase() + ' · ' + dv.desktop.kind : null);
      add(T('ag.d_os'), dv.os);
      body.appendChild(kv);
      var edit = sbtn(T('dev.edit'), function () { finish({ open: e.deviceId, saved: true }); });
      body.appendChild(el('div', { class: 'acts rmx-again' }, [edit]));
    }

    document.body.appendChild(ov);
    render();
    P.api('GET', 'admin/candidates').then(function (c) {
      if (!c || !c.available) { S.candErr = T('wz.cand_unavailable'); S.cand = { gateways: [], homes: [], peers: [], routes: [], known: [] }; }
      else S.cand = c;
      S.groups = model(S.cand, !retarget);
    }).catch(function (e) { S.candErr = P.errText(e); S.cand = { gateways: [], homes: [], peers: [], routes: [], known: [] }; S.groups = model(S.cand, !retarget); }).then(render);
    return done;
  }

  window.RMW = { open: open, model: model, homeOf: homeOf, viaOf: viaOf, protoOfPort: protoOfPort, ico: ico };
})();
