/* Portal tab "Chats": conversation list | chat | info (stacked at phone width).
   Talks to the plugin API through GC.call, uploads with GC.upload, gets live events with
   GC.on('event') (plus a 30 s refresh as a fallback) and shows files through the signed
   /plugin-media/ URLs the API hands out. Voice messages are recorded with MediaRecorder
   when the browser allows the microphone in the frame.
   1.2.0: locations — sent from a map (the host's Leaflet, tiles through GC.tiles), the
   browser's position when the frame may ask for it (GateControl 1.179+ ui.geolocation),
   coordinates typed in otherwise; received ones with a small map. The pinned entry
   "GateControl" (the core inbox) through GC.inbox when the host offers it (1.179+).
   1.3.0: videos and PDFs get `video` meta and a preview picture (ui/video.js, window.MSVideo)
   when GET me has features.video_meta / file_thumbs; video tiles, file previews, a Videos tab.
   1.4.0 (ui/rich.js, window.MSRich): polls, events, live arrival (read-only), home actions and plugin cards
   in the chat; the status strip with stories under "Angeheftet"; own status; settings for privacy,
   notifications, chats and blocks; chat lists and the archive in the list; pinned messages and the next
   event above the chat; remind me, suggestions (Familie list / calendar), export — each only when GET me
   lists its feature.
   1.6.0: the status strip ("Mein Status") above "Angeheftet"; under it "GateControl", then the chats the server pins
   (listPinned: Familie's group); notice channels of GateControl's notifications (`notice`) marked "Mitteilungen";
   notification cards (card.notice) with "<source> · <topic>" and their full text (ui/rich.js). */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var el = M.el;
  var $ = M.$;
  var CTX = M.CTX;
  var PLUGIN = 'gatecontrol-messenger';
  var EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  var GROUP_GAP_MS = 5 * 60000;
  var app = $('#ms-app');
  var S = {
    me: null, prefs: null, limits: {}, features: {}, people: null, convs: [], cur: null, msgs: {}, typing: {}, reply: null, edit: null,
    rec: null, uploads: [], q: '', inbox: null, lastSync: null, activeTimer: null, firstUnread: null, infoOpen: false, loading: false, menu: null, refreshTimers: {}, typingAt: 0,
    // 1.4.0
    feed: null, lists: [], listFilter: null, showArchived: false, integrations: {}, feedTimer: null,
  };
  var R = window.MSRich;

  // ── sizing: the frame grows with its content, the app gets a fixed height from the screen ──
  function narrow() { return window.innerWidth < 760; }
  function size() {
    var h = (window.screen && (window.screen.availHeight || window.screen.height)) || 800;
    var target = narrow() ? Math.max(480, Math.min(h - 140, 820)) : Math.max(540, Math.min(h - 220, 860));
    app.style.setProperty('--ms-h', Math.round(target) + 'px');
  }

  // ── helpers ──
  function conv(id) { for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === id) return S.convs[i]; return null; }
  function member(c, uid) {
    if (!c) return null;
    for (var i = 0; i < c.members.length; i++) if (c.members[i].userId === uid) return c.members[i];
    return null;
  }
  function nameOf(c, uid, opts) {
    if (uid == null) return 'GateControl';
    if (S.me && uid === S.me.user.id) return (opts && opts.you === false) ? (S.me.user.name || T('portal.you')) : T('portal.you');
    var mb = member(c, uid);
    if (mb && mb.name) return mb.name;
    if (S.people) for (var i = 0; i < S.people.length; i++) if (S.people[i].id === uid) return S.people[i].name;
    return T('portal.gone');
  }
  function convTitle(c) {
    if (!c) return '';
    if (c.title) return c.title;
    return c.kind === 'direct' ? T('portal.gone') : T('portal.group');
  }
  function convAvatar(c, size) {
    if (c.kind === 'group') return M.avatar({ icon: c.readonly ? 'system' : 'group', avatarUrl: c.avatarUrl }, size);
    if (!c.peer || c.peer.gone) return M.avatar({ icon: 'gone' }, size);
    return M.avatar(c.peer, size);
  }
  function lastId(list) { return list && list.length ? list[list.length - 1].id : 0; }
  function disLabel(s) {
    if (!s) return T('dis.off');
    return T('dis.' + s) !== 'dis.' + s ? T('dis.' + s) : T('dis.seconds', { n: s });
  }
  function systemText(m, c) {
    var s = m.system || {};
    var by = s.by === undefined ? null : s.by;
    var who = by == null ? 'GateControl' : nameOf(c, by);
    var names = (s.userIds || []).map(function (u) { return nameOf(c, u); }).join(', ');
    switch (s.event) {
      case 'created': return T('sys.created', { name: who, title: s.title || convTitle(c) });
      case 'member_added': return T('sys.added', { name: who, names: names });
      case 'member_removed': return T('sys.removed', { name: who, names: names });
      case 'member_left': return T('sys.left', { name: nameOf(c, s.userId) });
      case 'title': return T('sys.title', { name: who, title: s.title || '' });
      case 'avatar': return T('sys.avatar', { name: who });
      case 'disappearing': return s.seconds ? T('sys.dis_on', { name: who, time: disLabel(s.seconds) }) : T('sys.dis_off', { name: who });
      case 'released': return T('sys.released');
      default: return (R && R.systemText(s, c)) || m.text || '';
    }
  }
  function summary(m, c) {
    if (!m) return '';
    if (m.deleted) return T('msg.deleted');
    if (m.undecryptable) return T('msg.undecryptable');
    switch (m.kind) {
      case 'image': return T('kind.image') + (m.text ? ': ' + m.text : '');
      case 'voice': return T('kind.voice') + (m.meta && m.meta.durationMs != null ? ' · ' + M.duration(m.meta.durationMs) : '');
      case 'file': return isVideoMsg(m) ? T('kind.video') + (m.video && m.video.durationMs != null ? ' · ' + M.duration(m.video.durationMs) : '') : ((m.meta && m.meta.fileName) || T('kind.file'));
      case 'location': return T('kind.location') + (m.location && m.location.label ? ': ' + m.location.label : '');
      case 'system': return systemText(m, c);
      default: return (R && R.summary(m)) || m.text || '';
    }
  }
  function typingIds(c) {
    var t = S.typing[c.id];
    var out = [];
    var now = Date.now();
    if (t) Object.keys(t).forEach(function (u) { if (t[u] > now) out.push(Number(u)); });
    return out;
  }
  function typingText(c) {
    var ids = typingIds(c);
    if (!ids.length) return null;
    if (c.kind === 'direct') return T('portal.typing');
    if (ids.length === 1) return T('portal.typing_one', { name: nameOf(c, ids[0]) });
    return T('portal.typing_many', { n: ids.length });
  }
  function preview(c) {
    var m = c.lastMessage;
    if (!m) return c.kind === 'group' ? T('portal.group_new') : T('portal.chat_new');
    var s = summary(m, c);
    if (m.kind === 'system') return s;
    if (m.mine) return T('portal.you') + ': ' + s;
    if (c.kind === 'group') return nameOf(c, m.senderId) + ': ' + s;
    return s;
  }
  function sortConvs() {
    S.convs.sort(function (a, b) {
      var ta = a.lastMessage ? a.lastMessage.createdAt : a.createdAt;
      var tb = b.lastMessage ? b.lastMessage.createdAt : b.createdAt;
      return ta < tb ? 1 : ta > tb ? -1 : b.id - a.id;
    });
  }
  function upsert(c) {
    for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === c.id) { S.convs[i] = c; sortConvs(); return; }
    S.convs.push(c);
    sortConvs();
  }
  function withinWindow(m) {
    var w = (S.limits.editWindowS || 0) * 1000;
    return w > 0 && Date.now() - new Date(m.createdAt).getTime() <= w;
  }
  function statusOf(m, c) {
    if (!m.mine || m.pending) return m.pending ? 'pending' : null;
    if (c.readUpTo != null && m.id <= c.readUpTo) return 'read';
    if (c.deliveredUpTo != null && m.id <= c.deliveredUpTo) return 'delivered';
    return 'sent';
  }

  // ── list ──
  function row(c) {
    var current = S.cur === c.id;
    var typ = typingText(c);
    var b = el('button', { type: 'button', class: 'ms-row', role: 'listitem', 'aria-current': current ? 'true' : 'false', on: { click: function () { openConv(c.id); } } });
    b.appendChild(convAvatar(c, 46));
    var icons = el('span', { class: 'ms-row-icons' }, [
      c.muted ? M.icon('bellOff', 14) : null,
      c.disappearingS ? M.icon('timer', 14) : null,
    ]);
    b.appendChild(el('span', { class: 'ms-row-tx' }, [
      el('span', { class: 'ms-row-top' }, [
        el('span', { class: 'ms-row-name', text: convTitle(c) }),
        // 1.6.0: a notice channel of GateControl's notifications
        c.notice ? el('span', { class: 'ms-row-tag', text: T('notice.badge') }) : null,
        el('span', { class: 'ms-row-time', text: M.listTime(c.lastMessage ? c.lastMessage.createdAt : c.createdAt) }),
      ]),
      el('span', { class: 'ms-row-bottom' }, [
        el('span', { class: 'ms-row-pv' + (typ ? ' is-typing' : ''), text: typ || preview(c) }),
        icons,
        c.listPinned ? el('span', { class: 'ms-row-icons', title: T('portal.pinned') }, [M.icon('pin', 14)]) : null,
        c.unread ? el('span', { class: 'ms-badge' + (c.muted ? ' is-muted' : ''), text: c.unread > 99 ? '99+' : String(c.unread), 'aria-label': T('portal.unread', { n: c.unread }) }) : null,
      ]),
    ]));
    return b;
  }
  /** The pinned entry "GateControl": the viewer's own core inbox (GC.inbox, GateControl 1.179+), not a chat. */
  function inboxRow() {
    var ib = S.inbox;
    var latest = ib.latest;
    var b = el('button', { type: 'button', class: 'ms-row ms-row-pinned', role: 'listitem', title: T('inbox.open'),
      on: { click: function () { if (window.GC && window.GC.inbox) window.GC.inbox.open(); } } });
    b.appendChild(M.avatar({ icon: 'system' }, 46));
    b.appendChild(el('span', { class: 'ms-row-tx' }, [
      el('span', { class: 'ms-row-top' }, [el('span', { class: 'ms-row-name', text: 'GateControl' }), latest && latest.createdAt ? el('span', { class: 'ms-row-time', text: M.listTime(latest.createdAt) }) : null]),
      el('span', { class: 'ms-row-bottom' }, [
        el('span', { class: 'ms-row-pv' + (ib.unread ? ' is-unread' : ''), text: latest ? latest.title : T('inbox.empty') }),
        el('span', { class: 'ms-row-icons', title: T('portal.pinned') }, [M.icon('pin', 14)]),
        ib.unread ? el('span', { class: 'ms-badge', text: ib.unread > 99 ? '99+' : String(ib.unread), 'aria-label': T('portal.unread', { n: ib.unread }) }) : null,
      ]),
    ]));
    return b;
  }
  function inboxShown(q) {
    if (!S.inbox) return false;
    if (!q) return true;
    return 'gatecontrol'.indexOf(q) >= 0 || !!(S.inbox.latest && S.inbox.latest.title.toLowerCase().indexOf(q) >= 0);
  }
  /** 1.4.0: chips — all chats, the person's lists, the archive. */
  function chips() {
    var box = el('div', { class: 'ms-chips', role: 'group', 'aria-label': T('lists.title') });
    var chip = function (label, on, fn) { box.appendChild(el('button', { type: 'button', class: 'ms-chip', 'aria-pressed': on ? 'true' : 'false', text: label, on: { click: fn } })); };
    chip(T('lists.all'), !S.listFilter && !S.showArchived, function () { S.listFilter = null; S.showArchived = false; renderList(); });
    S.lists.forEach(function (l) { chip(l.name, S.listFilter === l.id, function () { S.listFilter = S.listFilter === l.id ? null : l.id; S.showArchived = false; renderList(); }); });
    var archived = S.convs.filter(function (c) { return c.archived; }).length;
    if (archived || S.showArchived) chip(T('lists.archived', { n: archived }), S.showArchived, function () { S.showArchived = !S.showArchived; S.listFilter = null; renderList(); });
    box.appendChild(el('button', { type: 'button', class: 'ms-chip is-edit', 'aria-label': T('lists.manage'), title: T('lists.manage'), on: { click: function () { R.listsDialog(); } } }, [M.icon('pen', 12)]));
    return box;
  }
  function renderList() {
    var rows = M.clear($('#ms-rows'));
    var q = S.q.trim().toLowerCase();
    var tools = feature('msg_tools');
    var lst = S.listFilter ? S.lists.filter(function (l) { return l.id === S.listFilter; })[0] : null;
    var list = S.convs.filter(function (c) {
      if (q && convTitle(c).toLowerCase().indexOf(q) < 0 && preview(c).toLowerCase().indexOf(q) < 0) return false;
      if (q) return true; // a search finds archived chats too
      if (lst) return lst.conversationIds.indexOf(c.id) >= 0;
      return S.showArchived ? !!c.archived : !c.archived;
    });
    // 1.6.0: chats pinned by the server (listPinned: Familie's group) sit under "GateControl", not among the chats
    var pinned = q || (!lst && !S.showArchived) ? list.filter(function (c) { return c.listPinned; }) : [];
    if (pinned.length) list = list.filter(function (c) { return !c.listPinned; });
    // 1.6.0: "Mein Status" (the status strip) above "Angeheftet"
    var strip = !q && S.feed && feature('status') ? R.strip(S.feed) : null;
    if (strip) rows.appendChild(strip);
    if (inboxShown(q) || pinned.length) {
      rows.appendChild(el('div', { class: 'ms-list-sec', text: T('portal.pinned') }));
      if (inboxShown(q)) rows.appendChild(inboxRow());
      pinned.forEach(function (c) { rows.appendChild(row(c)); });
    }
    if ((strip || inboxShown(q) || pinned.length) && (list.length || tools)) rows.appendChild(el('div', { class: 'ms-list-sec', text: T('portal.chats') }));
    if (tools && !q) rows.appendChild(chips());
    list.forEach(function (c) { rows.appendChild(row(c)); });
    var empty = $('#ms-list-empty');
    empty.hidden = list.length + pinned.length > 0;
    empty.textContent = S.convs.length ? T('portal.no_match') : T('portal.no_chats');
  }

  // ── conversation shell ──
  var refs = {};
  function headSub(c) {
    var typ = typingText(c);
    if (typ) return { text: typ, typing: true };
    if (c.kind === 'direct') {
      if (c.peer && c.peer.gone) return { text: T('portal.gone_hint'), typing: false };
      if (c.peer && c.peer.blocked) return { text: T('set.blocked_one'), typing: false };
      if (c.peer && c.peer.online) return { text: T('portal.online'), typing: false };
      if (c.peer && c.peer.lastSeenAt) return { text: T('portal.last_seen', { time: M.listTime(c.peer.lastSeenAt) + (M.listTime(c.peer.lastSeenAt).indexOf(':') < 0 ? ' ' + M.hm(c.peer.lastSeenAt) : '') }), typing: false };
      return { text: T('portal.direct_sub'), typing: false };
    }
    if (c.notice) return { text: T('notice.channel_sub', { label: c.notice.label || convTitle(c) }), typing: false };
    if (c.readonly) return { text: T('portal.channel_sub'), typing: false };
    var names = c.members.map(function (mb) { return mb.userId === S.me.user.id ? T('portal.you') : (mb.name || T('portal.gone')); });
    return { text: names.join(', '), typing: false };
  }
  function renderHead() {
    var c = conv(S.cur);
    if (!c || !refs.head) return;
    var h = M.clear(refs.head);
    h.appendChild(el('button', { type: 'button', class: 'ms-ib ms-ib-flat ms-back', 'aria-label': T('common.back'), on: { click: closeConv } }, [M.icon('back', 20)]));
    h.appendChild(convAvatar(c, 42));
    var sub = headSub(c);
    h.appendChild(el('button', { type: 'button', class: 'ms-head-tx', 'aria-label': T('info.open'), on: { click: toggleInfo } }, [
      el('b', { text: convTitle(c) }), el('span', { class: 'ms-head-sub' + (sub.typing ? ' ms-typing' : ''), text: sub.text }),
    ]));
    h.appendChild(el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('portal.search_in_chat'), title: T('portal.search_in_chat'), on: { click: toggleSearch } }, [M.icon('search', 18)]));
    h.appendChild(el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('info.title'), title: T('info.title'), 'aria-pressed': S.infoOpen ? 'true' : 'false', on: { click: toggleInfo } }, [M.icon('info', 18)]));
  }
  function renderShell() {
    var box = M.clear($('#ms-conv'));
    $('#ms-placeholder').hidden = !!S.cur;
    box.hidden = !S.cur;
    if (!S.cur) return;
    refs.head = el('header', { class: 'ms-head' });
    refs.searchbar = el('div', { class: 'ms-searchbar', hidden: true });
    refs.results = el('div', { class: 'ms-results', hidden: true });
    refs.banner = el('div', { class: 'ms-banners' });
    refs.scroll = el('div', { class: 'ms-scroll', role: 'log', 'aria-live': 'polite', 'aria-label': T('portal.messages') });
    refs.jump = el('button', { type: 'button', class: 'ms-ib ms-jump', hidden: true, 'aria-label': T('portal.to_latest'), title: T('portal.to_latest'), on: { click: toLatest } }, [M.icon('down', 18)]);
    refs.compose = el('div', { class: 'ms-compose-wrap' });
    box.appendChild(refs.head);
    box.appendChild(refs.searchbar);
    box.appendChild(refs.results);
    box.appendChild(refs.banner);
    box.appendChild(refs.scroll);
    box.appendChild(refs.jump);
    box.appendChild(refs.compose);
    refs.scroll.addEventListener('scroll', onScroll);
    renderHead();
    renderBanner();
    renderComposer();
  }
  /** 1.4.0: the next event and the pinned messages above the chat. */
  function renderBanner() {
    var c = conv(S.cur);
    if (!c || !refs.banner) return;
    var b = M.clear(refs.banner);
    if (c.nextEvent && feature('events')) {
      var ne = c.nextEvent;
      b.appendChild(el('button', { type: 'button', class: 'ms-banner-row', on: { click: function () { jumpTo(ne.messageId); } } }, [R.icon('cal', 15), el('b', { text: ne.title || T('kind.event') }),
        el('span', { class: 'ms-muted', text: M.when(ne.startsAt) + (ne.yesCount ? ' · ' + T('ev.yes_n', { n: ne.yesCount }) : '') })]));
    }
    (c.pinned || []).forEach(function (id) {
      var st = S.msgs[c.id];
      var m = st ? st.list.filter(function (x) { return x.id === id; })[0] : null;
      b.appendChild(el('button', { type: 'button', class: 'ms-banner-row', on: { click: function () { jumpTo(id); } } }, [M.icon('pin', 15), el('span', { text: m ? summary(m, c) : T('tools.pinned_msg') })]));
    });
    b.hidden = !b.children.length;
  }

  // ── messages ──
  function quoteEl(q, c) {
    var label = q.missing ? T('msg.quote_missing') : (q.deleted ? T('msg.deleted') : (q.text || T('kind.' + (q.kind || 'text'))));
    return el('button', { type: 'button', class: 'ms-quote', on: { click: function (e) { e.stopPropagation(); if (q.id && !q.missing) jumpTo(q.id); } } }, [
      el('b', { text: q.missing ? '–' : nameOf(c, q.senderId) }), el('span', { text: label }),
    ]);
  }
  function ticks(st) {
    if (st === 'pending') return el('span', { title: T('status.pending'), 'aria-label': T('status.pending') }, [M.icon('clock', 13)]);
    if (st === 'sent') return el('span', { title: T('status.sent'), 'aria-label': T('status.sent') }, [M.icon('check', 15)]);
    if (st === 'delivered') return el('span', { title: T('status.delivered'), 'aria-label': T('status.delivered') }, [M.icon('checks', 16)]);
    if (st === 'read') return el('span', { class: 'is-read', title: T('status.read'), 'aria-label': T('status.read') }, [M.icon('checks', 16, { stroke: '2.4' })]);
    return null;
  }
  function metaEl(m, c) {
    return el('div', { class: 'ms-meta' }, [
      m.expiresAt ? el('span', { title: T('portal.disappears', { time: M.when(m.expiresAt) }) }, [M.icon('timer', 12)]) : null,
      m.editedAt && !m.deleted ? el('span', { text: T('msg.edited') }) : null,
      el('span', { text: M.hm(m.createdAt) }),
      ticks(statusOf(m, c)),
    ]);
  }
  function lightbox(url, video) {
    if (!url) return;
    var ov = el('div', { class: 'ms-lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': video ? T('kind.video') : T('kind.image') }, [
      video ? el('video', { src: url, controls: true, autoplay: true, playsinline: true, preload: 'auto' }) : el('img', { src: url, alt: '' }),
      el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('common.close'), on: { click: function () { ov.remove(); } } }, [M.icon('close', 18)]),
    ]);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } });
    document.body.appendChild(ov);
  }
  function voiceEl(m) {
    var bars = (m.meta && Array.isArray(m.meta.waveform) && m.meta.waveform.length ? m.meta.waveform : null);
    var n = bars ? bars.length : 32;
    var wave = el('span', { class: 'ms-wave', role: 'presentation' });
    for (var i = 0; i < n; i++) {
      var v = bars ? Math.max(8, Math.round((bars[i] / 255) * 100)) : 20 + ((i * 37) % 60);
      wave.appendChild(el('i', { style: 'height:' + v + '%' }));
    }
    var total = m.meta && m.meta.durationMs != null ? m.meta.durationMs : null;
    var time = el('span', { class: 'ms-voice-t', text: total != null ? M.duration(total) : '0:00' });
    var audio = null;
    var btn = el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('portal.play') }, [M.icon('play', 14, { fill: true })]);
    function paint() {
      var d = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (total ? total / 1000 : 0);
      var p = audio && d ? audio.currentTime / d : 0;
      var on = Math.round(p * n);
      Array.prototype.forEach.call(wave.children, function (b, k) { b.className = k < on ? 'is-on' : ''; });
      time.textContent = audio && !audio.paused ? M.duration(audio.currentTime * 1000) : (total != null ? M.duration(total) : M.duration(d * 1000));
    }
    function setIcon(playing) { M.clear(btn).appendChild(M.icon(playing ? 'pause' : 'play', 14, { fill: true })); btn.setAttribute('aria-label', playing ? T('portal.pause') : T('portal.play')); }
    function ensure() {
      if (audio) return audio;
      if (!m.media || !m.media.url) { M.toast(T('msg.media_unavailable'), 'error'); return null; }
      audio = new Audio(m.media.url);
      audio.preload = 'auto';
      audio.addEventListener('timeupdate', paint);
      audio.addEventListener('ended', function () { setIcon(false); audio.currentTime = 0; paint(); });
      audio.addEventListener('pause', function () { setIcon(false); });
      audio.addEventListener('play', function () { setIcon(true); });
      audio.addEventListener('error', function () { M.toast(T('msg.media_unavailable'), 'error'); setIcon(false); });
      return audio;
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var a = ensure();
      if (!a) return;
      if (a.paused) { var p = a.play(); if (p && p.catch) p.catch(function () { M.toast(T('msg.media_unavailable'), 'error'); }); } else a.pause();
    });
    wave.addEventListener('click', function (e) {
      e.stopPropagation();
      var a = ensure();
      if (!a) return;
      var r = wave.getBoundingClientRect();
      var d = isFinite(a.duration) && a.duration > 0 ? a.duration : (total ? total / 1000 : 0);
      if (d) a.currentTime = Math.max(0, Math.min(d, ((e.clientX - r.left) / r.width) * d));
      paint();
    });
    return el('div', { class: 'ms-voice' }, [btn, wave, time]);
  }
  function isVideoMsg(m) { return !!(m && m.kind === 'file' && m.media && /^video\//.test(m.media.mime || '')); }
  /** 1.3.0: a video with a preview picture — the picture with a play button and the duration; a click plays it here. */
  function videoTile(m) {
    var v = m.video || {};
    var dur = v.durationMs != null ? v.durationMs : (m.meta && m.meta.durationMs != null ? m.meta.durationMs : null);
    // the tile in the video's shape, at most 320 px a side
    var shape = v.width && v.height ? 'aspect-ratio:' + v.width + '/' + v.height + ';width:' + Math.round(v.width * Math.min(320 / v.width, 320 / v.height)) + 'px' : null;
    var tile = el('button', { type: 'button', class: 'ms-vtile', style: shape, 'aria-label': T('portal.play_video') + (dur != null ? ' (' + M.duration(dur) + ')' : ''),
      on: { click: function (e) {
        e.stopPropagation();
        var player = el('video', { class: 'ms-video', src: m.media.url, controls: true, autoplay: true, playsinline: true, preload: 'auto', style: shape });
        tile.replaceWith(player);
        var p = player.play && player.play();
        if (p && p.catch) p.catch(function () { /* the controls stay */ });
      } } }, [
      el('img', { src: m.media.thumbUrl, alt: '', loading: 'lazy' }),
      el('span', { class: 'ms-vtile-play', 'aria-hidden': 'true' }, [M.icon('play', 22, { fill: true })]),
      dur != null ? el('span', { class: 'ms-vtile-dur', text: M.duration(dur) }) : null,
    ]);
    return tile;
  }
  function fileEl(m) {
    var mime = (m.media && m.media.mime) || '';
    if (isVideoMsg(m) && m.media.url && m.media.thumbUrl) return videoTile(m);
    if (/^video\//.test(mime) && m.media.url) return el('video', { class: 'ms-video', src: m.media.url, controls: true, preload: 'metadata' });
    if (/^audio\//.test(mime) && m.media.url) return el('audio', { src: m.media.url, controls: true, preload: 'none', style: 'max-width:100%' });
    var name = (m.meta && m.meta.fileName) || T('kind.file');
    var thumb = m.media && m.media.thumbUrl;
    return el('button', { type: 'button', class: 'ms-filecard' + (thumb ? ' has-thumb' : ''), on: { click: function (e) { e.stopPropagation(); M.toast(T('msg.file_in_app'), 'good'); } } }, [
      thumb ? el('img', { class: 'ms-filecard-th', src: thumb, alt: '', loading: 'lazy' }) : el('span', { class: 'ms-filecard-ic' }, [M.icon('file', 18)]),
      el('span', { class: 'ms-filecard-tx' }, [el('b', { text: name }), el('small', { text: [m.media && m.media.bytes ? M.bytes(m.media.bytes) : null, mime ? mime.split('/').pop().toUpperCase().slice(0, 12) : null].filter(Boolean).join(' · ') })]),
    ]);
  }
  function locationEl(m) {
    var l = m.location || {};
    var ok = validPos(l);
    var label = l.label || T('kind.location');
    var prev = ok ? mapPreview(l.lat, l.lon) : null;
    var kids = [
      prev,
      el('span', { class: 'ms-loc-row' }, [
        el('span', { class: 'ms-loc-ic' }, [M.icon('pin', 18)]),
        el('span', { class: 'ms-filecard-tx' }, [el('b', { text: label }), el('small', { class: 'ms-mono', text: ok ? coordText(l) : '?' })]),
      ]),
    ];
    if (!ok) return el('div', { class: 'ms-loc' }, kids);
    return el('button', { type: 'button', class: 'ms-loc' + (prev ? ' has-map' : ''), 'aria-label': T('loc.open', { label: label }),
      on: { click: function (e) { e.stopPropagation(); showLocation(l); } } }, kids);
  }
  function reactionsEl(m) {
    if (!m.reactions || !m.reactions.length) return null;
    var mine = S.me && S.me.user.id;
    return el('div', { class: 'ms-reacts' }, m.reactions.map(function (r) {
      var isMine = r.userIds.indexOf(mine) >= 0;
      return el('button', { type: 'button', class: 'ms-react' + (isMine ? ' is-mine' : ''), title: r.userIds.map(function (u) { return nameOf(conv(m.conversationId), u); }).join(', '),
        on: { click: function () { react(m, isMine ? null : r.emoji); } } }, [r.emoji, r.count > 1 ? el('small', { text: String(r.count) }) : null]);
    }));
  }
  function bubble(m, c, cont) {
    var wrap = el('div', { class: 'ms-msg' + (m.mine ? ' is-out' : '') + (cont ? ' is-cont' : ''), 'data-id': String(m.id) });
    if (c.kind === 'group' && !m.mine && !cont) {
      var mb = member(c, m.senderId);
      var s = el('div', { class: 'ms-sender', text: nameOf(c, m.senderId) });
      if (mb && mb.colorHex) s.style.setProperty('--c', M.safeColor(mb.colorHex));
      wrap.appendChild(s);
    }
    var b = el('div', { class: 'ms-bub' });
    if (m.deleted) {
      b.classList.add('is-deleted');
      b.appendChild(document.createTextNode(m.mine ? T('msg.deleted_mine') : T('msg.deleted')));
      b.appendChild(metaEl(m, c));
      wrap.appendChild(b);
      return wrap;
    }
    if (m.replyTo) b.appendChild(quoteEl(m.replyTo, c));
    if (m.replyStory && R) b.appendChild(R.replyStoryEl(m.replyStory, c));
    var rich = R ? R.body(m, c) : null;
    if (m.undecryptable) b.appendChild(el('i', { class: 'ms-muted', text: T('msg.undecryptable') }));
    if (m.kind === 'image') {
      b.classList.add('is-media');
      var src = m.media && (m.media.thumbUrl || m.media.url);
      var w = m.meta && m.meta.w;
      var h = m.meta && m.meta.h;
      var img = el('button', { type: 'button', class: 'ms-img', 'aria-label': T('portal.open_image'), on: { click: function (e) { e.stopPropagation(); lightbox(m.media && m.media.url); } } }, [
        src ? el('img', { src: src, alt: m.text || T('kind.image'), loading: 'lazy', style: w && h ? 'aspect-ratio:' + w + '/' + h + ';width:' + Math.min(320, w) + 'px' : null }) : el('span', { class: 'ms-muted', text: T('msg.media_unavailable') }),
      ]);
      b.appendChild(img);
      if (m.text) b.appendChild(el('div', { class: 'ms-cap', text: m.text }));
    } else if (m.kind === 'voice') {
      b.appendChild(voiceEl(m));
    } else if (m.kind === 'file') {
      if (isVideoMsg(m) && m.media.url) b.classList.add('is-media');
      b.appendChild(fileEl(m));
      if (m.text) b.appendChild(el('div', { class: 'ms-cap', text: m.text }));
    } else if (m.kind === 'location') {
      b.appendChild(locationEl(m));
    } else if (rich) {
      b.classList.add('is-rich');
      b.appendChild(rich);
    } else if (m.text) {
      b.appendChild(document.createTextNode(m.text));
    }
    b.appendChild(metaEl(m, c));
    wrap.appendChild(b);
    var rx = reactionsEl(m);
    if (rx) wrap.appendChild(rx);
    if (!m.pending) {
      wrap.appendChild(el('div', { class: 'ms-acts' }, [
        c.can.send ? el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('msg.reply'), title: T('msg.reply'), on: { click: function (e) { e.stopPropagation(); startReply(m); } } }, [M.icon('reply', 15)]) : null,
        el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('msg.more'), title: T('msg.more'), on: { click: function (e) { e.stopPropagation(); openMenu(m, wrap); } } }, [M.icon('more', 15, { stroke: '3' })]),
      ]));
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); openMenu(m, wrap); });
      b.addEventListener('click', function (e) { if (narrow() && !(e.target.closest && e.target.closest('button,audio,video'))) openMenu(m, wrap); });
    }
    return wrap;
  }
  function systemEl(m, c) {
    if (m.system && m.system.event === 'notice') {
      return el('div', { class: 'ms-sys is-notice', 'data-id': String(m.id) }, [el('b', { text: 'GateControl' }), document.createTextNode(m.text || ''), el('div', { class: 'ms-meta', text: M.hm(m.createdAt) })]);
    }
    return el('div', { class: 'ms-sys', 'data-id': String(m.id), text: systemText(m, c) });
  }
  function renderMessages(mode) {
    var c = conv(S.cur);
    var st = S.msgs[S.cur];
    var box = refs.scroll;
    if (!c || !st || !box) return;
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    var prevH = box.scrollHeight;
    var prevTop = box.scrollTop;
    M.clear(box);
    if (st.hasMore) box.appendChild(el('button', { type: 'button', class: 'btn btn-sm ms-more', text: T('portal.load_older'), on: { click: loadOlder } }));
    if (!st.list.length && !st.hasMore) box.appendChild(el('div', { class: 'ms-sys', text: c.kind === 'group' ? T('portal.group_new') : T('portal.chat_empty') }));
    var prev = null;
    var lastDay = null;
    var divider = false;
    st.list.forEach(function (m) {
      var d = new Date(m.createdAt);
      // one separator per day (also after system lines, which reset the grouping of bubbles)
      if (lastDay !== M.dayKey(d)) { box.appendChild(el('div', { class: 'ms-day', text: M.dayLabel(m.createdAt) })); prev = null; lastDay = M.dayKey(d); }
      if (!divider && S.firstUnread != null && m.id > S.firstUnread && !m.mine && m.kind !== 'system') {
        divider = true;
        box.appendChild(el('div', { class: 'ms-unread-line', text: T('portal.unread_line') }));
        prev = null;
      }
      if (m.kind === 'system') { box.appendChild(systemEl(m, c)); prev = null; return; }
      var cont = !!(prev && prev.senderId === m.senderId && !prev.deleted && d - new Date(prev.createdAt) < GROUP_GAP_MS);
      box.appendChild(bubble(m, c, cont));
      prev = m;
    });
    if (mode === 'bottom' || (mode !== 'prepend' && mode !== 'keep' && atBottom)) box.scrollTop = box.scrollHeight;
    else if (mode === 'prepend') box.scrollTop = box.scrollHeight - prevH + prevTop;
    else box.scrollTop = prevTop;
    refs.jump.hidden = !st.partial && box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  }
  function onScroll() {
    var box = refs.scroll;
    var st = S.msgs[S.cur];
    if (!st) return;
    closeMenu();
    if (box.scrollTop < 60 && st.hasMore && !S.loading) loadOlder();
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
    refs.jump.hidden = !st.partial && nearBottom;
    if (nearBottom && st.partial && !S.loading) loadNewer(S.cur);
    if (nearBottom) markRead();
  }
  function setReceipts(c, r) {
    if (!c || !r) return;
    if (r.readUpTo !== undefined) c.readUpTo = r.readUpTo;
    if (r.deliveredUpTo !== undefined) c.deliveredUpTo = r.deliveredUpTo;
    if (r.receipts !== undefined) c.receipts = r.receipts;
  }
  function loadMessages(id) {
    S.loading = true;
    return M.api('GET', 'conversations/' + id + '/messages?limit=50').then(function (r) {
      S.msgs[id] = { list: r.messages, hasMore: r.hasMore, partial: false };
      setReceipts(conv(id), r);
    }).catch(M.warn).then(function () { S.loading = false; });
  }
  function loadOlder() {
    var id = S.cur;
    var st = S.msgs[id];
    if (!st || !st.list.length || S.loading) return Promise.resolve();
    S.loading = true;
    return M.api('GET', 'conversations/' + id + '/messages?limit=50&before=' + st.list[0].id).then(function (r) {
      if (S.cur !== id) return;
      st.list = r.messages.concat(st.list);
      st.hasMore = r.hasMore;
      renderMessages('prepend');
    }).catch(M.warn).then(function () { S.loading = false; });
  }
  function loadNewer(id) {
    var st = S.msgs[id];
    if (!st) return Promise.resolve();
    var after = lastId(st.list.filter(function (m) { return !m.pending; }));
    return M.api('GET', 'conversations/' + id + '/messages?limit=100&after=' + after).then(function (r) {
      var known = {};
      st.list.forEach(function (m) { if (!m.pending) known[m.id] = true; });
      r.messages.forEach(function (m) {
        if (known[m.id]) return;
        // a pending copy of one's own message (same clientId) is replaced
        st.list = st.list.filter(function (x) { return !(x.pending && x.clientId && x.clientId === m.clientId); });
        st.list.push(m);
      });
      st.list.sort(function (a, b) { return (a.pending ? 1e15 : a.id) - (b.pending ? 1e15 : b.id); });
      st.partial = false;
      setReceipts(conv(id), r);
      if (r.hasMore) return loadNewer(id);
      if (S.cur === id) renderMessages();
      return null;
    }).catch(function () { /* the next refresh catches up */ });
  }
  function fetchChanged(id, since) {
    var st = S.msgs[id];
    if (!st || !since) return;
    var t = new Date(new Date(since).getTime() - 1000).toISOString();
    M.api('GET', 'conversations/' + id + '/messages?limit=100&changedSince=' + encodeURIComponent(t)).then(function (r) {
      r.messages.forEach(function (m) { for (var i = 0; i < st.list.length; i++) if (st.list[i].id === m.id) st.list[i] = m; });
      if (S.cur === id) renderMessages('keep');
    }).catch(function () {});
  }
  function toLatest() {
    var id = S.cur;
    var st = S.msgs[id];
    if (st && st.partial) { loadMessages(id).then(function () { renderMessages('bottom'); }); return; }
    refs.scroll.scrollTop = refs.scroll.scrollHeight;
  }
  function highlight(id) {
    var n = refs.scroll && refs.scroll.querySelector('[data-id="' + id + '"]');
    if (!n) return false;
    n.scrollIntoView({ block: 'center' });
    n.classList.add('is-hl');
    setTimeout(function () { n.classList.remove('is-hl'); }, 1800);
    return true;
  }
  function jumpTo(id) {
    if (highlight(id)) return;
    var cid = S.cur;
    Promise.all([
      M.api('GET', 'conversations/' + cid + '/messages?limit=30&before=' + (id + 1)),
      M.api('GET', 'conversations/' + cid + '/messages?limit=30&after=' + id),
    ]).then(function (rs) {
      if (S.cur !== cid) return;
      S.msgs[cid] = { list: rs[0].messages.concat(rs[1].messages), hasMore: rs[0].hasMore, partial: rs[1].hasMore || rs[1].messages.length > 0 };
      renderMessages('keep');
      highlight(id);
    }).catch(M.warn);
  }

  // ── read marks, presence, typing ──
  function markRead() {
    var c = conv(S.cur);
    var st = S.msgs[S.cur];
    if (!c || !st || document.visibilityState === 'hidden' || st.partial) return;
    var top = 0;
    st.list.forEach(function (m) { if (!m.pending && m.id > top) top = m.id; });
    if (!top || top <= c.me.lastReadId) return;
    c.me.lastReadId = top;
    M.api('POST', 'conversations/' + c.id + '/read', { upTo: top }).then(function (r) {
      c.unread = r.unread;
      c.me.lastReadId = r.lastReadId;
      renderList();
    }).catch(function () {});
  }
  function ping() {
    if (!S.cur || document.visibilityState === 'hidden') return;
    M.api('POST', 'conversations/' + S.cur + '/active', {}).catch(function () {});
  }
  function leaveActive(id) { if (id) M.api('POST', 'conversations/' + id + '/active', { active: false }).catch(function () {}); }
  function typed() {
    var now = Date.now();
    if (!S.cur || now - S.typingAt < 3000) return;
    S.typingAt = now;
    M.api('POST', 'conversations/' + S.cur + '/typing', {}).catch(function () {});
  }

  // ── open / close ──
  function openConv(id) {
    if (S.cur && S.cur !== id) leaveActive(S.cur);
    closeMenu();
    var c = conv(id);
    S.cur = id;
    S.reply = null;
    S.edit = null;
    S.firstUnread = c && c.unread ? c.me.lastReadId : null;
    if (!narrow() && window.innerWidth >= 1100 && S.infoOpen === false && !S.infoClosedByUser) S.infoOpen = true;
    app.setAttribute('data-pane', 'chat');
    renderList();
    renderShell();
    renderInfo();
    var st = S.msgs[id];
    if (st && st.list.length) { renderMessages('bottom'); loadNewer(id).then(markRead); } else loadMessages(id).then(function () { if (S.cur === id) { renderMessages('bottom'); markRead(); } });
    ping();
    clearInterval(S.activeTimer);
    S.activeTimer = setInterval(ping, 20000);
    if (!narrow()) setTimeout(function () { if (refs.input) refs.input.focus(); }, 50);
  }
  function closeConv() {
    leaveActive(S.cur);
    clearInterval(S.activeTimer);
    S.cur = null;
    if (narrow()) S.infoOpen = false;
    app.setAttribute('data-pane', 'list');
    renderShell();
    renderInfo();
    renderList();
  }

  // ── composer ──
  function renderComposer() {
    var c = conv(S.cur);
    var box = M.clear(refs.compose);
    if (!c) return;
    if (!c.can.send) {
      box.appendChild(el('div', { class: 'ms-readonly', text: c.readonly ? T('portal.readonly') : T('portal.peer_gone') }));
      refs.input = null;
      return;
    }
    var wrap = el('div', { class: 'ms-compose' });
    if (S.reply || S.edit) {
      var m = S.reply || S.edit;
      wrap.appendChild(el('div', { class: 'ms-ctx' }, [
        M.icon(S.edit ? 'pen' : 'reply', 16),
        el('div', { class: 'ms-ctx-tx' }, [el('b', { text: S.edit ? T('msg.editing') : T('msg.reply_to', { name: nameOf(c, m.senderId) }) }), el('span', { text: summary(m, c) })]),
        el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': T('common.cancel'), on: { click: function () { var wasEdit = !!S.edit; S.reply = null; S.edit = null; renderComposer(); if (wasEdit && refs.input) refs.input.value = ''; } } }, [M.icon('close', 16)]),
      ]));
    }
    if (S.uploads.length) {
      wrap.appendChild(el('div', { class: 'ms-uploads' }, S.uploads.map(function (u) {
        var bar = el('div', { class: 'ms-bar' }, [el('i', { style: 'width:' + Math.round(u.pct) + '%' })]);
        u.bar = bar;
        return el('div', { class: 'ms-upload' }, [M.icon(u.kind === 'voice' ? 'mic' : (u.kind === 'image' ? 'image' : (u.kind === 'video' ? 'play' : 'file')), 16), el('span', { text: u.name }), bar]);
      })));
    }
    var rowEl = el('div', { class: 'ms-compose-row' });
    if (S.rec) {
      rowEl.appendChild(el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('portal.rec_cancel'), title: T('portal.rec_cancel'), on: { click: function () { stopRec(false); } } }, [M.icon('trash', 18)]));
      S.rec.timeEl = el('span', { class: 'ms-rec-t', text: M.duration(Date.now() - S.rec.started) });
      rowEl.appendChild(el('div', { class: 'ms-rec', role: 'status' }, [el('span', { class: 'ms-rec-dot' }), S.rec.timeEl, el('span', { class: 'ms-muted', text: T('portal.recording') })]));
      rowEl.appendChild(el('button', { type: 'button', class: 'ms-ib is-round', 'aria-label': T('portal.rec_send'), title: T('portal.rec_send'), on: { click: function () { stopRec(true); } } }, [M.icon('send', 20)]));
      wrap.appendChild(rowEl);
      box.appendChild(wrap);
      refs.input = null;
      return;
    }
    if (!S.edit) {
      var attachBtn = el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('portal.attach'), title: T('portal.attach'), 'aria-haspopup': 'menu', on: { click: function () { attachMenu(attachBtn); } } }, [M.icon('attach', 18)]);
      rowEl.appendChild(attachBtn);
    }
    var input = el('textarea', { class: 'ms-input', rows: '1', placeholder: T('portal.placeholder_short'), title: narrow() ? null : T('portal.placeholder'), 'aria-label': T('portal.placeholder'), maxlength: String(S.limits.textMax || 4000) });
    if (S.edit) input.value = S.edit.text || '';
    if (refs.draft && !S.edit) { input.value = refs.draft; refs.draft = ''; }
    input.addEventListener('input', function () { grow(input); if (input.value.trim() && !S.edit) typed(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === 'Escape' && (S.reply || S.edit)) { S.reply = null; S.edit = null; renderComposer(); }
    });
    rowEl.appendChild(input);
    if (!S.edit && recordingSupported()) rowEl.appendChild(el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('portal.rec_start'), title: T('portal.rec_start'), on: { click: startRec } }, [M.icon('mic', 18)]));
    rowEl.appendChild(el('button', { type: 'button', class: 'ms-ib is-round', 'aria-label': S.edit ? T('common.save') : T('portal.send'), title: S.edit ? T('common.save') : T('portal.send'), on: { click: submit } }, [M.icon(S.edit ? 'check' : 'send', 20)]));
    wrap.appendChild(rowEl);
    box.appendChild(wrap);
    refs.input = input;
    grow(input);
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(160, Math.max(44, t.scrollHeight + 2)) + 'px'; }

  function addPending(c, body, extra) {
    var st = S.msgs[c.id];
    var m = Object.assign({
      id: -Date.now(), pending: true, conversationId: c.id, senderId: S.me.user.id, clientId: body.clientId, kind: body.kind, mine: true,
      createdAt: new Date().toISOString(), text: body.text || null, replyTo: null, media: null, meta: body.meta || null, location: null, reactions: [], deleted: false,
    }, extra || {});
    if (body.replyTo && S.reply) m.replyTo = { id: S.reply.id, senderId: S.reply.senderId, kind: S.reply.kind, text: summary(S.reply, c), deleted: false, missing: false };
    if (st) { st.list.push(m); renderMessages('bottom'); }
    return m;
  }
  function settle(c, pending, msg) {
    var st = S.msgs[c.id];
    if (st) {
      st.list = st.list.filter(function (x) { return x !== pending && x.id !== msg.id; });
      st.list.push(msg);
      st.list.sort(function (a, b) { return (a.pending ? 1e15 : a.id) - (b.pending ? 1e15 : b.id); });
    }
    c.lastMessage = msg;
    c.me.lastReadId = Math.max(c.me.lastReadId, msg.id);
    sortConvs();
    S.firstUnread = null;
    if (S.cur === c.id) renderMessages('bottom');
    renderList();
  }
  function dropPending(c, pending) {
    var st = S.msgs[c.id];
    if (st) st.list = st.list.filter(function (x) { return x !== pending; });
    if (S.cur === c.id) renderMessages('keep');
  }
  function send(c, body, pendingExtra) {
    var pending = addPending(c, body, pendingExtra);
    return M.api('POST', 'conversations/' + c.id + '/messages', body).then(function (r) { settle(c, pending, r.message); return r.message; })
      .catch(function (e) { dropPending(c, pending); throw e; });
  }
  function submit() {
    var c = conv(S.cur);
    if (!c || !refs.input) return;
    var text = refs.input.value.replace(/\s+$/, '');
    if (S.edit) {
      var m = S.edit;
      if (!text.trim() && m.kind === 'text') return;
      M.api('PATCH', 'messages/' + m.id, { text: text }).then(function (r) {
        S.edit = null;
        var st = S.msgs[c.id];
        if (st) st.list = st.list.map(function (x) { return x.id === r.message.id ? r.message : x; });
        renderComposer();
        renderMessages('keep');
      }).catch(M.warn);
      return;
    }
    if (!text.trim()) return;
    var body = { clientId: M.uuid(), kind: 'text', text: text };
    if (S.reply) body.replyTo = S.reply.id;
    refs.input.value = '';
    grow(refs.input);
    var replyWas = S.reply;
    S.reply = null;
    S.typingAt = 0;
    send(c, body).catch(function (e) {
      M.warn(e);
      S.reply = replyWas;
      refs.draft = text;
      renderComposer();
    });
    renderComposer();
    if (refs.input) refs.input.focus();
  }

  // ── uploads ──
  function allowedType(t) { return (S.limits.types || []).indexOf(t) >= 0; }
  /** A server feature flag of GET me (1.3.0 video_meta, file_thumbs): true in the features object (or listed, should it be a list). */
  function feature(name) {
    var f = S.features;
    return Array.isArray(f) ? f.indexOf(name) >= 0 : !!(f && f[name] === true);
  }
  /**
   * 1.3.0: what goes with a file — a video's { durationMs, width, height } and a preview picture (a frame at about 1 s;
   * the first page of a PDF only when the frame already has a PDF renderer) → { meta, thumb } (never rejects).
   */
  function filePreview(file, type) {
    var V = window.MSVideo;
    var wantMeta = feature('video_meta');
    var wantThumb = feature('file_thumbs');
    if (!V) return Promise.resolve(null);
    if (/^video\/mp4$/.test(type) && (wantMeta || wantThumb)) {
      return V.videoInfo(file, { thumb: wantThumb }).then(function (r) { return { meta: wantMeta ? r.meta : null, thumb: wantThumb ? r.thumb : null }; });
    }
    if (type === 'application/pdf' && wantThumb) return V.pdfThumb(file).then(function (t) { return { meta: null, thumb: t }; });
    return Promise.resolve(null);
  }
  function pickFile() {
    var f = $('#ms-file');
    f.setAttribute('accept', (S.limits.types || []).join(','));
    f.value = '';
    f.click();
  }
  function uploadErr(e) {
    var code = (e && e.data && e.data.code) || (e && e.message) || '';
    var key = 'error.upload_' + code;
    M.toast(CTX.texts[key] ? T(key) : T('error.upload'), 'error');
  }
  function upload(blob, label, kind) {
    var u = { name: label, pct: 0, kind: kind, bar: null };
    S.uploads.push(u);
    renderComposer();
    var done = function () { S.uploads = S.uploads.filter(function (x) { return x !== u; }); renderComposer(); };
    return window.GC.upload(blob, { onProgress: function (p) { u.pct = p.total ? (p.loaded / p.total) * 100 : 0; if (u.bar && u.bar.firstChild) u.bar.firstChild.style.width = Math.round(u.pct) + '%'; } })
      .then(function (r) { done(); return r; }, function (e) { done(); throw e; });
  }
  /** Load an image without blob: URLs (the frame CSP allows data: and the server's own paths only). */
  function loadImage(file) {
    if (window.createImageBitmap) return window.createImageBitmap(file).catch(function () { return viaDataUrl(file); });
    return viaDataUrl(file);
  }
  function viaDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var img = new Image(); img.onload = function () { resolve(img); }; img.onerror = reject; img.src = fr.result; };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  function scaled(img, side, type, quality) {
    var w = img.width;
    var h = img.height;
    var k = Math.min(1, side / Math.max(w, h));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * k));
    cv.height = Math.max(1, Math.round(h * k));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return new Promise(function (resolve) {
      cv.toBlob(function (b) {
        if (b && b.type === type) resolve({ blob: b, w: cv.width, h: cv.height });
        else cv.toBlob(function (j) { resolve({ blob: j, w: cv.width, h: cv.height }); }, 'image/jpeg', quality);
      }, type, quality);
    });
  }
  function attach(file) {
    var c = conv(S.cur);
    if (!c) return;
    var type = String(file.type || '').toLowerCase() || 'application/octet-stream';
    var maxBytes = S.limits.maxBytes || Infinity;
    var caption = refs.input && refs.input.value.trim() ? refs.input.value.trim() : null;
    var isImage = /^image\/(jpeg|png|webp)$/.test(type);
    if (!isImage && !allowedType(type)) { M.toast(T('error.upload_unsupported_type'), 'error'); return; }
    var finish = function (body, pendingExtra) {
      if (caption) { body.text = caption; if (refs.input) { refs.input.value = ''; grow(refs.input); } }
      if (S.reply) { body.replyTo = S.reply.id; S.reply = null; renderComposer(); }
      return send(c, body, pendingExtra);
    };
    if (isImage) {
      loadImage(file).then(function (img) {
        return Promise.all([scaled(img, S.limits.imageMaxSide || 2048, 'image/webp', 0.82), scaled(img, 320, 'image/webp', 0.6)]);
      }).then(function (out) {
        var main = out[0];
        var thumb = out[1];
        if (!main.blob || main.blob.size > maxBytes) { M.toast(T('error.upload_too_large'), 'error'); return null; }
        if (!allowedType(main.blob.type)) { M.toast(T('error.upload_unsupported_type'), 'error'); return null; }
        return upload(main.blob, file.name || T('kind.image'), 'image').then(function (r) {
          var useThumb = thumb.blob && thumb.blob.size <= (S.limits.thumbMaxBytes || 65536) && allowedType(thumb.blob.type);
          return (useThumb ? upload(thumb.blob, T('portal.preview'), 'image').catch(function () { return null; }) : Promise.resolve(null)).then(function (t) {
            var body = { clientId: M.uuid(), kind: 'image', mediaId: r.mediaId, meta: { w: main.w, h: main.h } };
            if (t) body.thumbMediaId = t.mediaId;
            return finish(body);
          });
        });
      }).catch(function (e) { if (e && (e.status || (e.data && e.data.code))) uploadErr(e); else if (e) M.warn(e); });
      return;
    }
    if (file.size > maxBytes) { M.toast(T('error.upload_too_large'), 'error'); return; }
    var blob = file.type ? file : new Blob([file], { type: type });
    var extra = filePreview(file, type).catch(function () { return null; });
    upload(blob, file.name || T('kind.file'), /^video\//.test(type) ? 'video' : 'file').then(function (r) {
      return extra.then(function (p) {
        var body = { clientId: M.uuid(), kind: 'file', mediaId: r.mediaId, meta: { fileName: (file.name || T('kind.file')).slice(0, 200) } };
        if (p && p.meta) body.video = p.meta;
        var t = p && p.thumb;
        var useThumb = t && t.blob && t.blob.size <= (S.limits.thumbMaxBytes || 65536) && allowedType(t.blob.type);
        return (useThumb ? upload(t.blob, T('portal.preview'), 'image').catch(function () { return null; }) : Promise.resolve(null)).then(function (u) {
          if (u) body.thumbMediaId = u.mediaId;
          return finish(body);
        });
      });
    }).catch(function (e) { if (e && (e.status || (e.data && e.data.code))) uploadErr(e); else M.warn(e); });
  }

  // ── voice recording (MediaRecorder; the frame has allow="microphone") ──
  function recMime() {
    if (!window.MediaRecorder) return null;
    var list = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
    for (var i = 0; i < list.length; i++) {
      try { if (window.MediaRecorder.isTypeSupported(list[i]) && allowedType(list[i].split(';')[0])) return list[i]; } catch (_) { /* old browser */ }
    }
    return null;
  }
  function recordingSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && recMime()); }
  function startRec() {
    var mime = recMime();
    if (!mime) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var rec = { stream: stream, chunks: [], levels: [], started: Date.now(), mime: mime, timer: null, analyser: null, ctx: null };
      try {
        rec.recorder = new window.MediaRecorder(stream, { mimeType: mime });
      } catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); M.toast(T('portal.mic_denied'), 'error'); return; }
      rec.recorder.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          rec.ctx = new AC();
          var src = rec.ctx.createMediaStreamSource(stream);
          rec.analyser = rec.ctx.createAnalyser();
          rec.analyser.fftSize = 512;
          src.connect(rec.analyser);
        }
      } catch (_) { rec.analyser = null; }
      var buf = rec.analyser ? new Uint8Array(rec.analyser.fftSize) : null;
      rec.timer = setInterval(function () {
        if (rec.analyser) {
          rec.analyser.getByteTimeDomainData(buf);
          var sum = 0;
          for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
          rec.levels.push(Math.min(255, Math.round(Math.sqrt(sum / buf.length) * 255 * 3)));
        }
        if (rec.timeEl) rec.timeEl.textContent = M.duration(Date.now() - rec.started);
        if (Date.now() - rec.started >= (S.limits.maxVoiceS || 300) * 1000) stopRec(true);
      }, 100);
      rec.recorder.start(250);
      S.rec = rec;
      renderComposer();
    }).catch(function () { M.toast(T('portal.mic_denied'), 'error'); });
  }
  function waveform(levels, n) {
    if (!levels.length) return [];
    var out = [];
    var step = levels.length / n;
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * step);
      var b = Math.max(a + 1, Math.floor((i + 1) * step));
      var mx = 0;
      for (var k = a; k < b && k < levels.length; k++) mx = Math.max(mx, levels[k]);
      out.push(mx);
    }
    return out;
  }
  function stopRec(doSend) {
    var rec = S.rec;
    if (!rec) return;
    S.rec = null;
    clearInterval(rec.timer);
    var durationMs = Date.now() - rec.started;
    rec.recorder.onstop = function () {
      rec.stream.getTracks().forEach(function (t) { t.stop(); });
      if (rec.ctx && rec.ctx.close) rec.ctx.close().catch(function () {});
      renderComposer();
      if (!doSend) return;
      if (durationMs < 800) { M.toast(T('portal.rec_short'), 'error'); return; }
      var base = rec.mime.split(';')[0];
      var blob = new Blob(rec.chunks, { type: base });
      var c = conv(S.cur);
      if (!c) return;
      var wf = waveform(rec.levels, Math.min(48, Math.max(8, rec.levels.length)));
      upload(blob, T('kind.voice'), 'voice').then(function (r) {
        var body = { clientId: M.uuid(), kind: 'voice', mediaId: r.mediaId, meta: { durationMs: Math.min(durationMs, (S.limits.maxVoiceS || 300) * 1000) } };
        if (wf.length) body.meta.waveform = wf;
        if (S.reply) { body.replyTo = S.reply.id; S.reply = null; }
        return send(c, body);
      }).catch(function (e) { if (e && (e.status || (e.data && e.data.code))) uploadErr(e); else M.warn(e); });
    };
    try { rec.recorder.stop(); } catch (_) { rec.recorder.onstop(); }
  }

  // ── location (1.2.0): a map to pick the point, the browser's position when allowed ──
  var OSM = 'https://www.openstreetmap.org';
  var ATTRIBUTION = '&copy; <a href="' + OSM + '/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
  var START = { lat: 51.16, lon: 10.45, zoom: 5 }; // without a point: Germany
  var PREVIEW = { w: 260, h: 132, z: 15 };
  var leafletLoading = null;
  function fmt(n) { return Number(n).toFixed(5); }
  function validPos(p) { return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180; }
  function coordText(p) { return fmt(p.lat) + ', ' + fmt(p.lon) + (p.accuracy != null && p.accuracy > 0 ? ' · ±' + Math.round(p.accuracy) + ' m' : ''); }
  function wrapLon(lon) { return ((((lon + 180) % 360) + 360) % 360) - 180; }
  function osmUrl(p) { return OSM + '/?mlat=' + fmt(p.lat) + '&mlon=' + fmt(p.lon) + '#map=17/' + fmt(p.lat) + '/' + fmt(p.lon); }
  /** GateControl's tile relay (plugin.json ui.maps): the only way tiles reach the sandboxed frame. */
  function tilesUrl() {
    var t = window.GC && typeof window.GC.tiles === 'string' ? window.GC.tiles : null;
    return t && /^\/plugins\/_shared\/tiles\/[A-Za-z0-9._-]+\/\{z\}\/\{x\}\/\{y\}\.png$/.test(t) ? t : null;
  }
  function tile(t, z, x, y) { return t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)); }
  /** The host's Leaflet (ui.maps) — rejects when it does not load or there is no tile relay. */
  function loadLeaflet() {
    if (window.L && window.L.map && tilesUrl()) return Promise.resolve(window.L);
    if (leafletLoading) return leafletLoading;
    var cfg = CTX.leaflet || {};
    leafletLoading = new Promise(function (resolve, reject) {
      if (!cfg.js || !tilesUrl()) { reject(new Error('no map')); return; }
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        if (ok && window.L && window.L.map) resolve(window.L); else reject(new Error('leaflet unavailable'));
      };
      if (cfg.css) document.head.appendChild(el('link', { rel: 'stylesheet', href: cfg.css }));
      var sc = el('script', { src: cfg.js });
      sc.async = true;
      sc.onload = function () { finish(true); };
      sc.onerror = function () { finish(false); };
      document.head.appendChild(sc);
      setTimeout(function () { finish(!!(window.L && window.L.map)); }, 8000);
    });
    leafletLoading.catch(function () { leafletLoading = null; });
    return leafletLoading;
  }
  /** A small static map around a point from the relay's tiles (no Leaflet, a few <img>), or null. */
  function mapPreview(lat, lon) {
    var t = tilesUrl();
    if (!t) return null;
    var z = PREVIEW.z;
    var n = Math.pow(2, z);
    var rad = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    var px = ((lon + 180) / 360) * n * 256;
    var py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * 256;
    var left = px - PREVIEW.w / 2;
    var top = py - PREVIEW.h / 2;
    var box = el('span', { class: 'ms-locmap', 'aria-hidden': 'true' });
    for (var tx = Math.floor(left / 256); tx * 256 < left + PREVIEW.w; tx++) {
      for (var ty = Math.floor(top / 256); ty * 256 < top + PREVIEW.h; ty++) {
        if (ty < 0 || ty >= n) continue;
        box.appendChild(el('img', { src: tile(t, z, ((tx % n) + n) % n, ty), alt: '', loading: 'lazy', draggable: 'false',
          style: 'left:' + Math.round(tx * 256 - left) + 'px;top:' + Math.round(ty * 256 - top) + 'px' }));
      }
    }
    box.appendChild(el('span', { class: 'ms-locpin' }));
    return box;
  }
  function tileLayer(L) { return L.tileLayer(tilesUrl(), { maxZoom: 19, attribution: ATTRIBUTION }); }
  function pinIcon(L) { return L.divIcon({ className: 'ms-pin', html: '', iconSize: [26, 26], iconAnchor: [13, 26] }); }
  function osmLink(p) { return el('a', { class: 'ms-osm', href: osmUrl(p), target: '_blank', rel: 'noopener noreferrer', text: T('loc.open_osm') }); }
  /** A received location in a dialog: the map (Leaflet) or the preview, coordinates, a link to OpenStreetMap. */
  function showLocation(l) {
    var holder = el('div', { class: 'ms-bigmap', role: 'img', 'aria-label': T('loc.view_aria') });
    var body = el('div', { class: 'ms-locview' }, [holder, el('div', { class: 'ms-loc-foot' }, [el('span', { class: 'ms-mono', text: coordText(l) }), osmLink(l)])]);
    M.dialog(l.label || T('kind.location'), body, [], { wide: true });
    loadLeaflet().then(function (L) {
      var map = L.map(holder, { scrollWheelZoom: false, attributionControl: true });
      tileLayer(L).addTo(map);
      map.setView([l.lat, l.lon], 16);
      if (l.accuracy > 0) L.circle([l.lat, l.lon], { radius: l.accuracy, color: '#0F766E', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      L.marker([l.lat, l.lon], { icon: pinIcon(L), keyboard: false, interactive: false }).addTo(map);
      setTimeout(function () { try { map.invalidateSize(); } catch (_) { /* closed */ } }, 60);
    }).catch(function () {
      var prev = mapPreview(l.lat, l.lon);
      holder.classList.add('is-static');
      if (prev) holder.appendChild(prev); else holder.appendChild(el('p', { class: 'ms-muted', text: T('loc.no_map') }));
    });
  }
  /** May the frame ask for the browser's position? (GateControl 1.179+ gives the frame allow="geolocation".) */
  function geoAllowed() {
    if (!navigator.geolocation || window.isSecureContext === false) return false;
    var fp = document.permissionsPolicy || document.featurePolicy;
    if (fp && typeof fp.allowsFeature === 'function') {
      try { return !!fp.allowsFeature('geolocation'); } catch (_) { return false; }
    }
    return true; // no way to ask this browser: try, the error callback tells
  }
  /** "Send location": pick a point on the map (tap, drag), use the browser's position or type coordinates. */
  function pickLocation() {
    var c = conv(S.cur);
    if (!c || !c.can.send) return;
    var pos = null;
    var map = null;
    var Lf = null;
    var marker = null;
    var circle = null;
    var holder = el('div', { class: 'ms-bigmap ms-pickmap', role: 'application', 'aria-label': T('loc.map_aria') });
    var status = el('p', { class: 'ms-loc-status', role: 'status', text: T('loc.pick_hint') });
    var lat = el('input', { class: 'form-input', type: 'number', step: 'any', min: '-90', max: '90', inputmode: 'decimal', 'aria-label': T('loc.lat'), placeholder: T('loc.lat') });
    var lon = el('input', { class: 'form-input', type: 'number', step: 'any', min: '-180', max: '180', inputmode: 'decimal', 'aria-label': T('loc.lon'), placeholder: T('loc.lon') });
    var label = el('input', { class: 'form-input', type: 'text', maxlength: '200', placeholder: T('loc.label_ph'), 'aria-label': T('loc.label') });
    var mine = geoAllowed() ? el('button', { type: 'button', class: 'btn btn-sm', on: { click: locate } }, [M.icon('pin', 14), T('loc.mine')]) : null;
    function draw(fit) {
      if (!map || !pos) return;
      var ll = [pos.lat, pos.lon];
      if (!marker) {
        marker = Lf.marker(ll, { icon: pinIcon(Lf), draggable: true, keyboard: true, title: T('loc.point'), alt: T('loc.point') }).addTo(map);
        marker.on('dragend', function () { var p = marker.getLatLng(); setPos({ lat: p.lat, lon: wrapLon(p.lng) }, { map: false }); });
      } else marker.setLatLng(ll);
      if (circle) { circle.remove(); circle = null; }
      if (pos.accuracy > 0) circle = Lf.circle(ll, { radius: pos.accuracy, color: '#0F766E', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      if (fit) map.setView(ll, Math.max(map.getZoom(), 16));
    }
    function setPos(p, o) {
      var opt = o || {};
      pos = { lat: Math.max(-90, Math.min(90, p.lat)), lon: wrapLon(p.lon) };
      if (p.accuracy != null && isFinite(p.accuracy)) pos.accuracy = Math.min(100000, Math.max(0, p.accuracy));
      status.textContent = coordText(pos);
      if (opt.inputs !== false) { lat.value = fmt(pos.lat); lon.value = fmt(pos.lon); }
      if (opt.map !== false) draw(!!opt.fit);
    }
    function fromInputs() {
      var a = parseFloat(lat.value);
      var b = parseFloat(lon.value);
      if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return;
      if (pos && fmt(a) === fmt(pos.lat) && fmt(b) === fmt(pos.lon)) return; // unchanged: keep the precision and the accuracy
      setPos({ lat: a, lon: b }, { inputs: false, fit: true });
    }
    lat.addEventListener('change', fromInputs);
    lon.addEventListener('change', fromInputs);
    function locate() {
      status.textContent = T('loc.locating');
      if (mine) mine.disabled = true;
      navigator.geolocation.getCurrentPosition(function (g) {
        if (mine) mine.disabled = false;
        setPos({ lat: g.coords.latitude, lon: g.coords.longitude, accuracy: g.coords.accuracy }, { fit: true });
      }, function (err) {
        if (mine) mine.disabled = false;
        status.textContent = T(err && err.code === 1 ? 'loc.denied' : 'loc.unavailable');
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    }
    var body = el('div', { class: 'ms-locpick' }, [
      holder,
      el('div', { class: 'ms-loc-tools' }, [status, mine]),
      el('div', { class: 'ms-loc-coords' }, [lat, lon]),
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: T('loc.label') }), label]),
    ]);
    M.dialog(T('loc.title'), body, [
      { label: T('common.cancel'), value: null },
      { label: T('portal.send'), primary: true, onClick: function () {
        fromInputs();
        if (!pos) { status.textContent = T('loc.need_point'); return false; }
        var cur = conv(S.cur);
        if (!cur || cur.id !== c.id) return true;
        var loc = { lat: Number(pos.lat.toFixed(6)), lon: Number(pos.lon.toFixed(6)) };
        var name = label.value.trim().slice(0, 200);
        if (name) loc.label = name;
        if (pos.accuracy != null) loc.accuracy = Math.round(pos.accuracy);
        var b = { clientId: M.uuid(), kind: 'location', location: loc };
        if (S.reply) { b.replyTo = S.reply.id; }
        var replyWas = S.reply;
        send(c, b, { location: loc }).catch(function (e) { M.warn(e); });
        S.reply = null;
        if (replyWas) renderComposer();
        return true;
      } },
    ], { wide: true });
    loadLeaflet().then(function (L) {
      if (!holder.isConnected) return;
      Lf = L;
      map = L.map(holder, { scrollWheelZoom: true, attributionControl: true });
      tileLayer(L).addTo(map);
      map.setView([START.lat, START.lon], START.zoom);
      map.on('click', function (e) { setPos({ lat: e.latlng.lat, lon: e.latlng.lng }); });
      if (pos) draw(true);
      setTimeout(function () { try { map.invalidateSize(); } catch (_) { /* closed */ } }, 60);
    }).catch(function () {
      holder.hidden = true;
      status.textContent = T('loc.no_map_pick');
    });
  }
  /** The attach button: a small menu — file or photo, location. */
  function attachMenu(btn) {
    closeMenu();
    var items = [
      el('button', { type: 'button', class: 'ms-menu-item', role: 'menuitem', on: { click: function () { closeMenu(); pickFile(); } } }, [M.icon('attach', 16), T('portal.attach_file')]),
    ];
    if (S.features.location !== false) {
      items.push(el('button', { type: 'button', class: 'ms-menu-item', role: 'menuitem', on: { click: function () { closeMenu(); pickLocation(); } } }, [M.icon('pin', 16), T('loc.send')]));
    }
    var cc = conv(S.cur);
    if (feature('polls')) items.push(el('button', { type: 'button', class: 'ms-menu-item', role: 'menuitem', on: { click: function () { closeMenu(); R.createPoll(cc); } } }, [R.icon('poll', 16), T('poll.create')]));
    if (feature('events')) items.push(el('button', { type: 'button', class: 'ms-menu-item', role: 'menuitem', on: { click: function () { closeMenu(); R.createEvent(cc); } } }, [R.icon('cal', 16), T('ev.create')]));
    if (feature('actions')) items.push(el('button', { type: 'button', class: 'ms-menu-item', role: 'menuitem', on: { click: function () { closeMenu(); R.createAction(cc); } } }, [R.icon('home', 16), T('act.create')]));
    var layer = el('div', { style: 'position:absolute;inset:0;z-index:19', on: { click: function (e) { if (e.target === layer) closeMenu(); } } });
    var menu = el('div', { class: 'ms-menu', role: 'menu', 'aria-label': T('portal.attach') }, items);
    layer.appendChild(menu);
    app.appendChild(layer);
    var ar = app.getBoundingClientRect();
    var br = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(ar.width - menu.offsetWidth - 8, br.left - ar.left)) + 'px';
    menu.style.top = Math.max(8, br.top - ar.top - menu.offsetHeight - 6) + 'px';
    S.menu = { layer: layer, wrap: null };
    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  // ── message menu ──
  function closeMenu() {
    if (S.menu) { S.menu.layer.remove(); if (S.menu.wrap) S.menu.wrap.classList.remove('is-menu'); S.menu = null; }
  }
  function openMenu(m, wrap) {
    closeMenu();
    var c = conv(S.cur);
    if (!c || m.pending) return;
    var mineReaction = null;
    (m.reactions || []).forEach(function (r) { if (r.userIds.indexOf(S.me.user.id) >= 0) mineReaction = r.emoji; });
    var items = [];
    if (!m.deleted && m.kind !== 'system') {
      items.push(el('div', { class: 'ms-menu-emojis', role: 'group', 'aria-label': T('msg.react') }, EMOJIS.map(function (e) {
        return el('button', { type: 'button', 'aria-pressed': mineReaction === e ? 'true' : 'false', 'aria-label': e, text: e, on: { click: function () { closeMenu(); react(m, mineReaction === e ? null : e); } } });
      })));
    }
    var item = function (iconName, label, fn, danger) {
      items.push(el('button', { type: 'button', class: 'ms-menu-item' + (danger ? ' is-danger' : ''), on: { click: function () { closeMenu(); fn(); } } }, [M.icon(iconName, 16), label]));
    };
    if (!m.deleted && c.can.send) item('reply', T('msg.reply'), function () { startReply(m); });
    if (m.mine && !m.deleted && (m.kind === 'text' || m.kind === 'image' || m.kind === 'file') && withinWindow(m)) item('pen', T('msg.edit'), function () { startEdit(m); });
    if (feature('msg_tools') && !m.deleted) {
      var pinned = (c.pinned || []).indexOf(m.id) >= 0;
      if (m.kind !== 'system' && c.can.pin) item('pin', pinned ? T('tools.unpin') : T('tools.pin'), function () { pinMsg(c, m, !pinned); });
      item('clock', T('tools.remind'), function () { R.remind(m); });
      if (m.text && (m.kind === 'text' || m.kind === 'image' || m.kind === 'file')) item('search', T('tools.suggest'), function () { R.suggest(m); });
    }
    item('trash', T('msg.delete_me'), function () { removeMsg(m, 'me'); }, true);
    if (m.mine && !m.deleted && withinWindow(m)) item('trash', T('msg.delete_all'), function () { removeMsg(m, 'all'); }, true);
    var layer = el('div', { style: 'position:absolute;inset:0;z-index:19', on: { click: function (e) { if (e.target === layer) closeMenu(); } } });
    var menu = el('div', { class: 'ms-menu', role: 'menu' }, items);
    layer.appendChild(menu);
    app.appendChild(layer);
    var ar = app.getBoundingClientRect();
    var br = wrap.querySelector('.ms-bub').getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var left = m.mine ? br.right - ar.left - mw : br.left - ar.left;
    var top = br.bottom - ar.top + 6;
    if (top + mh > ar.height - 8) top = Math.max(8, br.top - ar.top - mh - 6);
    menu.style.left = Math.max(8, Math.min(ar.width - mw - 8, left)) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    wrap.classList.add('is-menu');
    S.menu = { layer: layer, wrap: wrap };
    var first = menu.querySelector('button');
    if (first) first.focus();
  }
  function pinMsg(c, m, on) {
    var p = on ? M.api('POST', 'conversations/' + c.id + '/pins', { messageId: m.id }) : M.api('DELETE', 'conversations/' + c.id + '/pins/' + m.id);
    p.then(function (r) { upsert(r.conversation); renderBanner(); renderList(); }).catch(M.warn);
  }
  function startReply(m) { S.reply = m; S.edit = null; renderComposer(); if (refs.input) refs.input.focus(); }
  function startEdit(m) { S.edit = m; S.reply = null; renderComposer(); if (refs.input) { refs.input.focus(); refs.input.setSelectionRange(refs.input.value.length, refs.input.value.length); } }
  function react(m, emoji) {
    M.api('PUT', 'messages/' + m.id + '/reaction', { emoji: emoji }).then(function (r) {
      m.reactions = r.reactions;
      renderMessages('keep');
    }).catch(M.warn);
  }
  function removeMsg(m, scope) {
    M.confirm(scope === 'all' ? T('msg.delete_all_q') : T('msg.delete_me_q'), T('common.delete'), true).then(function (ok) {
      if (!ok) return;
      M.api('DELETE', 'messages/' + m.id + '?for=' + scope).then(function (r) {
        var st = S.msgs[S.cur];
        if (st) st.list = r.forAll && r.message ? st.list.map(function (x) { return x.id === m.id ? r.message : x; }) : st.list.filter(function (x) { return x.id !== m.id; });
        renderMessages('keep');
        refreshConv(m.conversationId);
      }).catch(M.warn);
    });
  }

  // ── in-chat search ──
  function toggleSearch() {
    var bar = refs.searchbar;
    if (!bar) return;
    if (!bar.hidden) { bar.hidden = true; refs.results.hidden = true; return; }
    M.clear(bar);
    var input = el('input', { class: 'form-input', type: 'search', placeholder: T('portal.search_in_chat'), 'aria-label': T('portal.search_in_chat') });
    var timer = null;
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { runSearch(input.value); }, 300); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleSearch(); });
    bar.appendChild(input);
    bar.appendChild(el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': T('common.close'), on: { click: toggleSearch } }, [M.icon('close', 16)]));
    bar.hidden = false;
    input.focus();
  }
  function runSearch(q) {
    var box = refs.results;
    var c = conv(S.cur);
    if (!c) return;
    if (q.trim().length < 2) { box.hidden = true; return; }
    M.api('GET', 'conversations/' + c.id + '/search?q=' + encodeURIComponent(q.trim())).then(function (r) {
      M.clear(box);
      box.hidden = false;
      if (!r.results.length) { box.appendChild(el('p', { class: 'ms-list-empty', text: T('portal.search_none') })); return; }
      r.results.forEach(function (m) {
        box.appendChild(el('button', { type: 'button', class: 'ms-result', on: { click: function () { box.hidden = true; jumpTo(m.id); } } }, [
          el('span', { text: summary(m, c) }), el('small', { text: nameOf(c, m.senderId) + ' · ' + M.when(m.createdAt) }),
        ]));
      });
    }).catch(M.warn);
  }

  // ── info pane ──
  function toggleInfo() {
    S.infoOpen = !S.infoOpen;
    if (!S.infoOpen) S.infoClosedByUser = true;
    if (narrow()) app.setAttribute('data-pane', S.infoOpen ? 'info' : 'chat');
    renderInfo();
    renderHead();
  }
  function kv(label, iconName, value) { return el('div', { class: 'ms-kv' }, [el('span', {}, [M.icon(iconName, 16), label]), value]); }
  function muteValue(c) {
    if (c.me.notify === 'none') return 'always';
    if (c.me.mutedUntil && new Date(c.me.mutedUntil) > new Date()) return 'until';
    return 'off';
  }
  function patchConv(c, body) {
    return M.api('PATCH', 'conversations/' + c.id, body).then(function (r) {
      if (r.conversation) { upsert(r.conversation); if (S.cur === c.id) { renderHead(); renderComposer(); renderInfo(); } renderList(); } else { removeConv(c.id); }
      return r;
    }).catch(function (e) { M.warn(e); renderInfo(); });
  }
  function renderInfo() {
    var pane = $('#ms-info');
    var c = conv(S.cur);
    pane.hidden = !(c && S.infoOpen);
    app.setAttribute('data-info', pane.hidden ? '0' : '1');
    if (pane.hidden) return;
    M.clear(pane);
    var closeBtn = el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': narrow() ? T('common.back') : T('common.close'), on: { click: toggleInfo } }, [M.icon(narrow() ? 'back' : 'close', 18)]);
    pane.appendChild(el('div', { class: 'ms-info-head' }, narrow() ? [closeBtn, el('span', { text: T('info.title') })] : [el('span', { text: T('info.title') }), closeBtn]));
    var top = el('div', { class: 'ms-info-top' }, [convAvatar(c, 76), el('b', { text: convTitle(c) }), el('span', { class: 'ms-muted', text: c.notice ? T('notice.info', { label: c.notice.label || convTitle(c) }) : c.kind === 'group' ? (c.managedBy ? T('info.managed', { plugin: pluginName(c.managedBy) }) : T('info.members_n', { n: c.members.length })) : (c.peer && c.peer.gone ? T('portal.gone_hint') : T('portal.direct_sub')) })]);
    if (c.can.editInfo) {
      top.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center' }, [
        el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { rename(c); } } }, [M.icon('pen', 14), T('info.rename')]),
        el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { changeAvatar(c); } } }, [M.icon('image', 14), T('info.picture')]),
      ]));
    }
    pane.appendChild(top);
    // 1.6.0: a notice channel leads to "Wo Mitteilungen erscheinen"
    if (c.notice && R && feature('notice_routes')) {
      pane.appendChild(el('div', { class: 'ms-info-sec' }, [el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { R.noticeRoutes(); } } }, [M.icon('bell', 14), T('routes.title')])]));
    }
    // chat settings
    var sec = el('div', { class: 'ms-info-sec' }, [el('div', { class: 'ms-sec', text: T('info.chat') })]);
    var mute = el('select', { class: 'form-select', 'aria-label': T('info.notifications') }, [
      el('option', { value: 'off', text: T('mute.off') }), el('option', { value: '8h', text: T('mute.8h') }), el('option', { value: '1w', text: T('mute.1w') }),
      el('option', { value: 'always', text: T('mute.always') }),
    ]);
    var mv = muteValue(c);
    if (mv === 'until') { mute.insertBefore(el('option', { value: 'until', text: T('mute.until', { time: M.when(c.me.mutedUntil) }) }), mute.firstChild); }
    mute.value = mv;
    mute.addEventListener('change', function () {
      var v = mute.value;
      var body = v === 'always' ? { notify: 'none', mutedUntil: null } : (v === 'off' ? { notify: 'all', mutedUntil: null }
        : { notify: 'all', mutedUntil: new Date(Date.now() + (v === '8h' ? 8 * 3600000 : 7 * 86400000)).toISOString() });
      if (v !== 'until') patchConv(c, body);
    });
    sec.appendChild(kv(T('info.notifications'), c.muted ? 'bellOff' : 'bell', mute));
    var opts = S.limits.disappearingS || [0, 86400, 604800, 2592000];
    if (!c.readonly) {
      if (c.can.setDisappearing) {
        var dis = el('select', { class: 'form-select', 'aria-label': T('info.disappearing') }, opts.map(function (s) { return el('option', { value: String(s), text: disLabel(s) }); }));
        dis.value = String(c.disappearingS);
        dis.addEventListener('change', function () { patchConv(c, { disappearingS: Number(dis.value) }); });
        sec.appendChild(kv(T('info.disappearing'), 'timer', dis));
      } else sec.appendChild(kv(T('info.disappearing'), 'timer', el('span', { class: 'ms-muted', text: T('info.disappearing_off') })));
    }
    var mediaCount = el('span', { class: 'ms-muted', text: '…' });
    sec.appendChild(kv(T('info.media'), 'image', mediaCount));
    pane.appendChild(sec);
    // media grid: the newest photos — and (1.3.0) videos, a tab of their own when the chat has any
    var grid = el('div', { class: 'ms-grid' });
    var tabs = el('div', { class: 'ms-tabs', role: 'group', 'aria-label': T('info.recent_media'), hidden: true });
    var mediaSec = el('div', { class: 'ms-info-sec', hidden: true }, [el('div', { class: 'ms-sec', text: T('info.recent_media') }), tabs, grid]);
    pane.appendChild(mediaSec);
    function gridItems(kind, items) {
      M.clear(grid);
      items.forEach(function (m) {
        if (!m.media || !m.media.url) return;
        if (kind === 'video') {
          var v = m.video || {};
          grid.appendChild(el('button', { type: 'button', class: 'ms-grid-video', 'aria-label': T('portal.play_video'), on: { click: function () { lightbox(m.media.url, true); } } }, [
            m.media.thumbUrl ? el('img', { src: m.media.thumbUrl, alt: '', loading: 'lazy' }) : null,
            el('span', { class: 'ms-vtile-play', 'aria-hidden': 'true' }, [M.icon('play', 16, { fill: true })]),
            v.durationMs != null ? el('span', { class: 'ms-vtile-dur', text: M.duration(v.durationMs) }) : null,
          ]));
          return;
        }
        grid.appendChild(el('button', { type: 'button', 'aria-label': T('portal.open_image'), on: { click: function () { lightbox(m.media.url); } } }, [el('img', { src: m.media.thumbUrl || m.media.url, alt: '', loading: 'lazy' })]));
      });
    }
    function showKind(kind) {
      Array.prototype.forEach.call(tabs.children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-kind') === kind ? 'true' : 'false'); });
      return M.api('GET', 'conversations/' + c.id + '/media?kind=' + kind + '&limit=9').then(function (r) { gridItems(kind, r.items); return r; });
    }
    ['image', 'video'].forEach(function (k) {
      tabs.appendChild(el('button', { type: 'button', 'data-kind': k, 'aria-pressed': 'false', on: { click: function () { showKind(k).catch(M.warn); } } }, [T(k === 'image' ? 'info.tab_photos' : 'info.tab_videos')]));
    });
    showKind('image').then(function (r) {
      var n = r.counts.image + r.counts.voice + r.counts.file + (r.counts.video || 0);
      mediaCount.textContent = String(n);
      var videos = r.counts.video || 0;
      if (!r.items.length && !videos) return;
      mediaSec.hidden = false;
      tabs.hidden = !videos;
      if (!r.items.length) showKind('video').catch(M.warn);
    }).catch(function () { mediaCount.textContent = '–'; });
    // members
    if (c.kind === 'group' && !c.readonly) {
      var ms = el('div', { class: 'ms-info-sec' }, [el('div', { class: 'ms-sec', text: T('info.members') + ' · ' + c.members.length })]);
      if (c.can.manageMembers) ms.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { addMembers(c); } } }, [M.icon('plus', 14), T('info.add_members')]));
      c.members.forEach(function (mb) {
        var me = mb.userId === S.me.user.id;
        var rowEl = el('div', { class: 'ms-member' }, [
          mb.gone ? M.avatar({ icon: 'gone' }, 34) : M.avatar(mb, 34),
          el('span', { class: 'ms-member-tx' }, [el('b', { text: me ? T('portal.you') : (mb.name || T('portal.gone')) }), mb.role === 'admin' ? el('small', { text: T('info.admin') }) : null]),
        ]);
        if (c.can.manageMembers && !me) {
          rowEl.appendChild(el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': T('info.member_actions', { name: mb.name || '' }), on: { click: function () { memberMenu(c, mb); } } }, [M.icon('more', 16, { stroke: '3' })]));
        }
        ms.appendChild(rowEl);
      });
      if (c.managedBy) ms.appendChild(el('p', { class: 'ms-note', text: T('info.managed_hint', { plugin: pluginName(c.managedBy) }) }));
      pane.appendChild(ms);
    }
    // 1.4.0: archive, export, block
    if (feature('msg_tools')) {
      var tools = el('div', { class: 'ms-info-sec ms-info-tools' }, [el('div', { class: 'ms-sec', text: T('tools.title') })]);
      tools.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () {
        M.api('POST', 'conversations/' + c.id + '/archive', { archived: !c.archived }).then(function (r) { upsert(r.conversation); renderList(); renderInfo(); }).catch(M.warn);
      } } }, [R.icon('archive', 14), c.archived ? T('tools.unarchive') : T('tools.archive')]));
      tools.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { R.exportChat(c); } } }, [R.icon('export', 14), T('tools.export')]));
      if (c.kind === 'direct' && c.peer && !c.peer.gone) {
        tools.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (c.peer.blocked ? '' : ' btn-danger'), on: { click: function () {
          var go = function () { (c.peer.blocked ? M.api('DELETE', 'blocks/' + c.peer.userId) : M.api('POST', 'blocks', { userId: c.peer.userId })).then(function () { refreshConv(c.id); }).catch(M.warn); };
          if (c.peer.blocked) go(); else M.confirm(T('set.block_q', { name: c.peer.name || '' }), T('set.block'), true).then(function (ok) { if (ok) go(); });
        } } }, [R.icon('block', 14), c.peer.blocked ? T('set.unblock') : T('set.block')]));
      }
      pane.appendChild(tools);
    }
    var foot = el('div', { class: 'ms-info-sec' }, [el('p', { class: 'ms-note' }, [M.icon('lock', 14), T('info.encrypted')])]);
    if (c.can.leave) foot.appendChild(el('button', { type: 'button', class: 'btn btn-danger', on: { click: function () { leave(c); } } }, [T('info.leave')]));
    pane.appendChild(foot);
  }
  function pluginName(id) { return id === 'gatecontrol-familie' ? T('info.plugin_familie') : id; }
  function rename(c) {
    var input = el('input', { class: 'form-input', value: c.title || '', maxlength: String(S.limits.titleMax || 80) });
    M.dialog(T('info.rename'), el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: T('portal.group_title') }), input]), [
      { label: T('common.cancel'), value: null },
      { label: T('common.save'), primary: true, onClick: function () { var v = input.value.trim(); if (!v) return false; return patchConv(c, { title: v }); } },
    ]);
  }
  function changeAvatar(c) {
    var f = $('#ms-avatar-file');
    f.value = '';
    f.onchange = function () {
      var file = f.files && f.files[0];
      if (!file) return;
      loadImage(file).then(function (img) { return scaled(img, 512, 'image/webp', 0.85); }).then(function (out) {
        return upload(out.blob, T('info.picture'), 'image');
      }).then(function (r) { return patchConv(c, { avatarMediaId: r.mediaId }); }).catch(function (e) { if (e && (e.status || (e.data && e.data.code))) uploadErr(e); else M.warn(e); });
    };
    f.click();
  }
  function memberMenu(c, mb) {
    var admin = mb.role === 'admin';
    M.dialog(mb.name || T('portal.gone'), el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, [
      el('button', { type: 'button', class: 'btn', on: { click: function () { closeTop(); patchConv(c, { role: { userId: mb.userId, role: admin ? 'member' : 'admin' } }); } } }, [admin ? T('info.unmake_admin') : T('info.make_admin')]),
      el('button', { type: 'button', class: 'btn btn-danger', on: { click: function () { closeTop(); patchConv(c, { remove: [mb.userId] }); } } }, [T('info.remove_member')]),
    ]), []);
  }
  function closeTop() { var o = document.querySelectorAll('.ms-overlay'); if (o.length) o[o.length - 1].remove(); }
  function leave(c) {
    M.confirm(T('info.leave_q'), T('info.leave'), true).then(function (ok) { if (ok) patchConv(c, { remove: [S.me.user.id] }); });
  }

  // ── people pickers ──
  function loadPeople() {
    if (S.people) return Promise.resolve(S.people);
    return M.api('GET', 'people').then(function (r) { S.people = r.people; return S.people; });
  }
  function personRow(p, opts) {
    var o = opts || {};
    var kids = [M.avatar(p, 38), el('span', { text: p.name })];
    if (o.check) { var cb = el('input', { type: 'checkbox', value: String(p.id), 'aria-label': p.name }); kids.push(cb); return el('label', { class: 'ms-person' }, kids); }
    return el('button', { type: 'button', class: 'ms-person', on: { click: o.onClick } }, kids);
  }
  function newChat() {
    loadPeople().then(function (people) {
      var mode = 'direct';
      var body = el('div');
      var tabs = el('div', { class: 'ms-tabs', role: 'group' });
      var filter = el('input', { class: 'form-input', type: 'search', placeholder: T('portal.search_people'), 'aria-label': T('portal.search_people') });
      var title = el('input', { class: 'form-input', maxlength: String(S.limits.titleMax || 80), placeholder: T('portal.group_title_ph') });
      var titleGroup = el('div', { class: 'form-group', hidden: true }, [el('label', { class: 'form-label', text: T('portal.group_title') }), title]);
      var list = el('div', { class: 'ms-people' });
      var msg = el('p', { class: 'form-hint', role: 'status' });
      var closeFn = null;
      function draw() {
        M.clear(list);
        var q = filter.value.trim().toLowerCase();
        var ps = people.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; });
        if (!ps.length) list.appendChild(el('p', { class: 'ms-list-empty', text: T('portal.no_people') }));
        ps.forEach(function (p) {
          list.appendChild(personRow(p, mode === 'group' ? { check: true } : { onClick: function () {
            M.api('POST', 'conversations', { kind: 'direct', userIds: [p.id] }).then(function (r) { upsert(r.conversation); if (closeFn) closeFn(null); openConv(r.conversation.id); }).catch(M.warn);
          } }));
        });
        titleGroup.hidden = mode !== 'group';
        createBtn.hidden = mode !== 'group';
        M.$$('button', tabs).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false'); });
      }
      ['direct', 'group'].forEach(function (k) {
        tabs.appendChild(el('button', { type: 'button', 'data-mode': k, text: T('portal.new_' + k), on: { click: function () { mode = k; draw(); } } }));
      });
      var createBtn = el('button', { type: 'button', class: 'btn btn-primary', text: T('portal.create_group'), hidden: true, style: 'margin-top:12px;width:100%', on: { click: function () {
        var ids = M.$$('input[type=checkbox]:checked', list).map(function (x) { return Number(x.value); });
        var t = title.value.trim();
        if (!t) { msg.textContent = T('portal.group_need_title'); return; }
        if (!ids.length) { msg.textContent = T('portal.group_need_people'); return; }
        M.api('POST', 'conversations', { kind: 'group', userIds: ids, title: t }).then(function (r) { upsert(r.conversation); if (closeFn) closeFn(null); openConv(r.conversation.id); }).catch(function (e) { msg.textContent = M.errText(e); });
      } } });
      filter.addEventListener('input', draw);
      body.appendChild(tabs);
      body.appendChild(titleGroup);
      body.appendChild(filter);
      body.appendChild(list);
      body.appendChild(msg);
      body.appendChild(createBtn);
      draw();
      M.dialog(T('portal.new_chat'), body, [], { onOpen: function (done) { closeFn = done; } });
    }).catch(M.warn);
  }
  function addMembers(c) {
    loadPeople().then(function (people) {
      var list = el('div', { class: 'ms-people' });
      var avail = people.filter(function (p) { return !member(c, p.id); });
      if (!avail.length) list.appendChild(el('p', { class: 'ms-list-empty', text: T('portal.no_people') }));
      avail.forEach(function (p) { list.appendChild(personRow(p, { check: true })); });
      M.dialog(T('info.add_members'), list, [
        { label: T('common.cancel'), value: null },
        { label: T('info.add'), primary: true, onClick: function () {
          var ids = M.$$('input[type=checkbox]:checked', list).map(function (x) { return Number(x.value); });
          if (!ids.length) return false;
          return patchConv(c, { add: ids });
        } },
      ]);
    }).catch(M.warn);
  }
  function prefsDialog() {
    if (R && feature('privacy2')) { R.settings(); return; }
    M.api('GET', 'me').then(function (r) {
      S.prefs = r.prefs;
      var body = el('div');
      [['readReceipts', 'prefs.read_receipts', 'prefs.read_receipts_hint'], ['typing', 'prefs.typing', 'prefs.typing_hint'], ['preview', 'prefs.preview', 'prefs.preview_hint']].forEach(function (p) {
        body.appendChild(el('div', { class: 'ms-pref' }, [
          el('span', { class: 'ms-pref-tx' }, [T(p[1]), el('small', { text: T(p[2]) })]),
          M.switchBtn(!!S.prefs[p[0]], T(p[1]), function (v, b) {
            var x = {};
            x[p[0]] = v;
            M.api('PUT', 'prefs', x).then(function (rr) { S.prefs = rr.prefs; refreshAll(); }).catch(function (e) { b.setAttribute('aria-checked', v ? 'false' : 'true'); M.warn(e); });
          }),
        ]));
      });
      body.appendChild(el('p', { class: 'ms-note', style: 'margin-top:10px' }, [M.icon('lock', 14), T('info.encrypted')]));
      M.dialog(T('prefs.title'), body, [{ label: T('common.close'), value: null }]);
    }).catch(M.warn);
  }

  // ── refresh and live events ──
  function removeConv(id) {
    S.convs = S.convs.filter(function (c) { return c.id !== id; });
    delete S.msgs[id];
    if (S.cur === id) closeConv(); else renderList();
  }
  function refreshConv(id) {
    if (!id) return Promise.resolve();
    clearTimeout(S.refreshTimers[id]);
    return new Promise(function (resolve) {
      S.refreshTimers[id] = setTimeout(function () {
        M.api('GET', 'conversations/' + id).then(function (r) {
          upsert(r.conversation);
          renderList();
          if (S.cur === id) { renderHead(); renderBanner(); renderComposer(); if (S.infoOpen) renderInfo(); renderMessages('keep'); }
        }).catch(function (e) { if (e && e.status === 404) removeConv(id); }).then(resolve);
      }, 120);
    });
  }
  function refreshAll() {
    var since = S.lastSync;
    return M.api('GET', 'conversations' + (since ? '?since=' + encodeURIComponent(since) : '')).then(function (r) {
      S.lastSync = r.serverTime;
      if (!since) S.convs = r.conversations;
      else r.conversations.forEach(upsert);
      (r.removed || []).forEach(removeConv);
      sortConvs();
      renderList();
      var c = conv(S.cur);
      var st = S.msgs[S.cur];
      if (c) {
        renderHead();
        if (st && !st.partial && c.lastMessageId && c.lastMessageId > lastId(st.list.filter(function (m) { return !m.pending; }))) loadNewer(c.id).then(markRead);
        else renderMessages('keep');
      }
    });
  }
  function onEvent(ev) {
    if (!ev || (ev.plugin && ev.plugin !== PLUGIN)) return;
    var d = ev.data || {};
    var cid = d.conversationId;
    var st = cid ? S.msgs[cid] : null;
    switch (ev.type) {
      case 'message.new':
        refreshConv(cid);
        if (cid === S.cur) loadNewer(cid).then(function () { if (document.visibilityState !== 'hidden') markRead(); });
        else if (st) st.stale = true;
        if (S.typing[cid] && d.senderId) { delete S.typing[cid][d.senderId]; }
        break;
      case 'message.update':
        if (st) fetchChanged(cid, d.editedAt);
        refreshConv(cid);
        break;
      case 'message.delete':
        if (st) {
          var ids = d.messageIds || [];
          st.list = d.reason === 'deleted'
            ? st.list.map(function (m) { return ids.indexOf(m.id) >= 0 ? Object.assign({}, m, { deleted: true, text: null, media: null, meta: null, location: null, replyTo: null, reactions: [] }) : m; })
            : st.list.filter(function (m) { return ids.indexOf(m.id) < 0; });
          if (cid === S.cur) renderMessages('keep');
        }
        refreshConv(cid);
        break;
      case 'reaction':
        if (st) {
          st.list.forEach(function (m) { if (m.id === d.messageId) m.reactions = d.reactions || []; });
          if (cid === S.cur) renderMessages('keep');
        }
        break;
      case 'read':
        refreshConv(cid);
        break;
      case 'typing': {
        if (!S.typing[cid]) S.typing[cid] = {};
        if (d.until) S.typing[cid][d.userId] = Date.now() + 6000; else delete S.typing[cid][d.userId];
        renderList();
        if (cid === S.cur) renderHead();
        setTimeout(function () { renderList(); if (cid === S.cur) renderHead(); }, 6100);
        break;
      }
      case 'conversation.update':
        refreshConv(cid);
        break;
      case 'conversation.remove':
        removeConv(cid);
        break;
      // 1.4.0
      case 'poll.update': case 'event.update': case 'arrival.update': case 'action.update':
        if (st) fetchChanged(cid, d.updatedAt || new Date().toISOString());
        if (ev.type === 'event.update') refreshConv(cid);
        break;
      case 'status.update': case 'story.new': case 'story.remove':
        refreshFeed(true);
        break;
      case 'lists.update':
        loadLists();
        break;
      default:
    }
  }

  // ── 1.4.0: status feed, lists, the host object of ui/rich.js ──
  function refreshFeed(quiet) {
    clearTimeout(S.feedTimer);
    S.feedTimer = setTimeout(function () {
      M.api('GET', 'status/feed').then(function (r) { S.feed = r; renderList(); }).catch(function (e) { if (!quiet) M.warn(e); });
    }, 150);
  }
  function loadLists() {
    M.api('GET', 'lists').then(function (r) { S.lists = r.lists || []; renderList(); }).catch(function () {});
  }
  function replaceMsg(msg) {
    var st = S.msgs[msg.conversationId];
    if (st) st.list = st.list.map(function (x) { return x.id === msg.id ? msg : x; });
    if (S.cur === msg.conversationId) renderMessages('keep');
  }
  function uploadImage(file) {
    return loadImage(file).then(function (img) { return Promise.all([scaled(img, S.limits.imageMaxSide || 2048, 'image/webp', 0.82), scaled(img, 320, 'image/webp', 0.6)]); }).then(function (out) {
      return upload(out[0].blob, file.name || T('kind.image'), 'image').then(function (r) {
        var t = out[1];
        var ok = t.blob && t.blob.size <= (S.limits.thumbMaxBytes || 65536) && allowedType(t.blob.type);
        return (ok ? upload(t.blob, T('portal.preview'), 'image').catch(function () { return null; }) : Promise.resolve(null)).then(function (u) { return { mediaId: r.mediaId, thumbId: u ? u.mediaId : null }; });
      });
    });
  }
  function richHost() {
    return {
      api: M.api, me: function () { return S.me; }, conv: conv, nameOf: nameOf, replace: replaceMsg, features: function () { return S.features || {}; },
      integrations: function () { return S.integrations || {}; }, refreshFeed: refreshFeed, people: loadPeople, uploadImage: uploadImage,
      send: function (c, body) { return send(c, body); }, setPrefs: function (p) { S.prefs = p; if (S.me) S.me.prefs = p; refreshAll().catch(function () {}); },
      reload: function () { refreshAll().catch(function () {}); refreshFeed(true); }, convs: function () { return S.convs; }, title: convTitle,
      setLists: function (l) { S.lists = l; renderList(); },
    };
  }

  // ── start ──
  function showLogin() {
    app.hidden = true;
    $('#ms-login').hidden = false;
  }
  function start() {
    $('#ms-prefs-btn').appendChild(M.icon('gear', 18));
    $('#ms-new-btn').appendChild(M.icon('pen', 18, { stroke: '2.4' }));
    $('#ms-new-btn').addEventListener('click', newChat);
    $('#ms-prefs-btn').addEventListener('click', prefsDialog);
    $('#ms-file').addEventListener('change', function (e) { var f = e.target; if (f.files && f.files[0]) attach(f.files[0]); });
    $('#ms-q').addEventListener('input', function (e) { S.q = e.target.value; renderList(); });
    size();
    window.addEventListener('resize', function () {
      size();
      if (!narrow() && app.getAttribute('data-pane') === 'info') app.setAttribute('data-pane', 'chat');
      renderInfo();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { ping(); refreshAll().then(markRead).catch(function () {}); } else leaveActive(S.cur);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
    if (!CTX.loggedIn) { showLogin(); return; }
    M.api('GET', 'me').then(function (r) {
      S.me = r;
      S.prefs = r.prefs;
      S.limits = r.limits || {};
      S.features = r.features || {};
      S.integrations = (r.integrations && r.integrations.familie) || {};
      if (R) R.init(richHost());
      if (feature('status')) refreshFeed(true);
      if (feature('msg_tools')) loadLists();
      if (window.GC && window.GC.on) window.GC.on('event', onEvent);
      // the pinned entry "GateControl" (GateControl 1.179+, plugin.json ui.inbox); older hosts have no GC.inbox
      if (window.GC && window.GC.inbox && typeof window.GC.inbox.on === 'function') {
        window.GC.inbox.on(function (st) {
          S.inbox = st && st.available === true ? { unread: Math.max(0, Number(st.unread) || 0), latest: st.latest && typeof st.latest.title === 'string' ? st.latest : null } : null;
          renderList();
        });
      }
      return refreshAll();
    }).then(function () {
      setInterval(function () { refreshAll().catch(function () {}); }, 30000);
    }).catch(function (e) {
      if (M.errCode(e) === 'login_required' || M.errCode(e) === 'forbidden') showLogin(); else M.warn(e);
    });
  }
  start();
}());
