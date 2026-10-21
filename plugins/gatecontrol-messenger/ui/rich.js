/* Portal tab "Chats", 1.4.0 (window.MSRich): the new message kinds (poll, event, arrival, home action,
   plugin card), the status strip with stories, the own status, the settings for privacy / notifications /
   chats / blocks, chat lists and the dialogs to create polls, events and home action messages.
   portal.js hands in a host object: { api, me(), conv(id), nameOf(c, uid), replace(msg), send(c, body),
   features(), integrations(), refreshFeed(), openConv(id), reload() }. Only the features GET me lists are
   offered. Everything is drawn with textContent (never HTML from the API). */
(function (root) {
  'use strict';
  var M = root.MS;
  var T = M.T;
  var el = M.el;
  var H = null; // the host object of portal.js

  var I = {
    poll: 'M5 20V10M12 20V4M19 20v-7',
    cal: 'M4 6h16v14H4z|M4 10h16M8 3v4M16 3v4',
    nav: 'M12 2l7 19-7-4-7 4z',
    home: 'M3 11l9-7 9 7|M5 10v10h14V10',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
    list: 'M8 6h12M8 12h12M8 18h12|M4 6h.01M4 12h.01M4 18h.01',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8|M10 20a2 2 0 0 0 4 0',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    archive: 'M3 5h18v4H3z|M5 9v10h14V9|M10 13h4',
    block: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M5.6 5.6l12.8 12.8',
    export: 'M12 3v12M7 10l5 5 5-5|M4 21h16',
  };
  function ic(name, size) { return M.svg(I[name], size || 16); }
  function iso(d) { return d instanceof Date ? d.toISOString() : null; }
  function fmtDate(isoStr, allDay) {
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    var day = d.toLocaleDateString(M.LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit' });
    return allDay ? day : day + ' ' + M.hm(isoStr);
  }
  function localInput(isoStr) {
    var d = isoStr ? new Date(isoStr) : new Date(Date.now() + 3600000);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fromLocal(v) { var d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  function field(label, input, hint) {
    return el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: label }), input, hint ? el('small', { class: 'form-hint', text: hint }) : null]);
  }
  function check(label, on) {
    var cb = el('input', { type: 'checkbox', checked: !!on });
    return { box: el('label', { class: 'ms-check' }, [cb, el('span', { text: label })]), input: cb };
  }
  function select(options, value, label) {
    var s = el('select', { class: 'form-select', 'aria-label': label || null }, options.map(function (o) { return el('option', { value: String(o[0]), text: o[1] }); }));
    s.value = String(value);
    return s;
  }
  function act(m, path, body) {
    return H.api('POST', 'messages/' + m.id + '/' + path, body || {}).then(function (r) { if (r && r.message) H.replace(r.message); return r; }).catch(M.warn);
  }

  // ── polls ──
  function pollEl(m, c) {
    var p = m.poll;
    var box = el('div', { class: 'ms-poll' });
    box.appendChild(el('div', { class: 'ms-card-head' }, [ic('poll', 16), el('b', { text: p.question })]));
    box.appendChild(el('div', { class: 'ms-card-sub', text: [p.multi ? T('poll.multi') : T('poll.single'), p.anonymous ? T('poll.anonymous') : null, p.closed ? T('poll.closed') : (p.closesAt ? T('poll.closes', { time: fmtDate(p.closesAt) }) : null)].filter(Boolean).join(' · ') }));
    var total = Math.max(1, p.options.reduce(function (s, o) { return s + o.count; }, 0));
    p.options.forEach(function (o) {
      var mine = p.myVotes.indexOf(o.id) >= 0;
      var pct = Math.round((o.count / total) * 100);
      var who = o.voters && o.voters.length ? o.voters.map(function (u) { return H.nameOf(c, u); }).join(', ') : '';
      var b = el('button', { type: 'button', class: 'ms-poll-opt' + (mine ? ' is-mine' : ''), disabled: p.closed, 'aria-pressed': mine ? 'true' : 'false', title: who || null,
        on: { click: function () {
          var next = p.multi ? (mine ? p.myVotes.filter(function (x) { return x !== o.id; }) : p.myVotes.concat([o.id])) : (mine ? [] : [o.id]);
          act(m, 'vote', { optionIds: next });
        } } }, [
        el('span', { class: 'ms-poll-bar', style: 'width:' + pct + '%' }),
        el('span', { class: 'ms-poll-mark' }, [mine ? M.icon('check', 13) : null]),
        el('span', { class: 'ms-poll-tx', text: o.text }),
        el('span', { class: 'ms-poll-n', text: String(o.count) }),
      ]);
      box.appendChild(b);
    });
    var foot = el('div', { class: 'ms-card-foot' }, [el('span', { class: 'ms-muted', text: T('poll.voted', { n: p.voterCount, of: p.memberCount }) })]);
    var me = H.me();
    if (!p.closed && p.allowAdd && p.options.length < 12) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('poll.add'), on: { click: function () { addOption(m); } } }));
    if (!p.closed && me && p.creatorId === me.user.id) {
      foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('poll.nudge'), on: { click: function () { act(m, 'nudge').then(function (r) { if (r) M.toast(T('poll.nudged', { n: r.nudged || 0 })); }); } } }));
    }
    if (!p.closed && me && (p.creatorId === me.user.id || (c.me && c.me.role === 'admin'))) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('poll.close'), on: { click: function () { act(m, 'close'); } } }));
    box.appendChild(foot);
    return box;
  }
  function addOption(m) {
    var input = el('input', { class: 'form-input', maxlength: '80' });
    M.dialog(T('poll.add'), field(T('poll.option'), input), [{ label: T('common.cancel'), value: null }, { label: T('common.save'), primary: true, onClick: function () {
      var v = input.value.trim(); if (!v) return false; return act(m, 'options', { text: v });
    } }]);
  }
  function createPoll(c) {
    var q = el('input', { class: 'form-input', maxlength: '200' });
    var opts = el('div', { class: 'ms-opts' });
    function addRow(v) { opts.appendChild(el('input', { class: 'form-input', maxlength: '80', value: v || '', placeholder: T('poll.option') })); }
    addRow(); addRow();
    var more = el('button', { type: 'button', class: 'btn btn-sm', text: T('poll.add_option'), on: { click: function () { if (opts.children.length < 12) addRow(); } } });
    var multi = check(T('poll.multi_allow'));
    var anon = check(T('poll.anonymous_vote'));
    var allow = check(T('poll.allow_add'));
    var msg = el('p', { class: 'form-hint', role: 'status' });
    var body = el('div', {}, [field(T('poll.question'), q), el('div', { class: 'form-label', text: T('poll.options') }), opts, more, multi.box, anon.box, allow.box, msg]);
    M.dialog(T('poll.create'), body, [{ label: T('common.cancel'), value: null }, { label: T('portal.send'), primary: true, onClick: function () {
      var options = M.$$('input', opts).map(function (x) { return x.value.trim(); }).filter(Boolean);
      if (!q.value.trim() || options.length < 2) { msg.textContent = T('poll.need'); return false; }
      return H.send(c, { clientId: M.uuid(), kind: 'poll', poll: { question: q.value.trim(), options: options, multi: multi.input.checked, anonymous: anon.input.checked, allowAdd: allow.input.checked } }).then(function () { return true; }, function (e) { msg.textContent = M.errText(e); return false; });
    } }]);
  }

  // ── events ──
  function eventEl(m, c) {
    var e = m.event;
    var me = H.me();
    var box = el('div', { class: 'ms-event' + (e.cancelled ? ' is-cancelled' : '') });
    var d = new Date(e.startsAt);
    box.appendChild(el('div', { class: 'ms-card-head' }, [
      el('span', { class: 'ms-ev-date', 'aria-hidden': 'true' }, [el('small', { text: d.toLocaleDateString(M.LOCALE, { month: 'short' }) }), el('b', { text: String(d.getDate()) })]),
      el('span', { class: 'ms-ev-tx' }, [el('b', { text: e.title }), el('small', { text: fmtDate(e.startsAt, e.allDay) + (e.endsAt && !e.allDay ? ' – ' + M.hm(e.endsAt) : '') + (e.place ? ' · ' + e.place.label : '') })]),
    ]));
    if (e.cancelled) box.appendChild(el('div', { class: 'ms-card-sub is-crit', text: T('ev.cancelled') }));
    if (e.description) box.appendChild(el('div', { class: 'ms-ev-desc', text: e.description }));
    if (e.rsvpEnabled) {
      var row = el('div', { class: 'ms-rsvp', role: 'group', 'aria-label': T('ev.rsvp') });
      [['yes', T('ev.yes')], ['maybe', T('ev.maybe')], ['no', T('ev.no')]].forEach(function (a) {
        var on = e.rsvp.mine === a[0];
        row.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (on ? ' btn-primary' : ''), 'aria-pressed': on ? 'true' : 'false', disabled: e.cancelled,
          on: { click: function () { act(m, 'rsvp', { answer: on ? null : a[0] }); } } }, [a[1] + ' · ' + e.rsvp[a[0]].length]));
      });
      box.appendChild(row);
      var names = e.rsvp.yes.map(function (x) { return H.nameOf(c, x.userId) + (x.guests ? ' +' + x.guests : ''); });
      if (names.length) box.appendChild(el('div', { class: 'ms-card-sub', text: T('ev.coming', { names: names.join(', ') }) }));
    }
    if (e.checklist && e.checklist.length) {
      var list = el('div', { class: 'ms-checklist' });
      e.checklist.forEach(function (it) {
        var cb = el('input', { type: 'checkbox', checked: !!it.doneBy, disabled: e.cancelled });
        cb.addEventListener('change', function () { act(m, 'checklist/' + encodeURIComponent(it.id), { done: cb.checked }); });
        list.appendChild(el('label', { class: 'ms-check' + (it.doneBy ? ' is-done' : '') }, [cb, el('span', { text: it.text }), it.doneBy ? el('small', { class: 'ms-muted', text: H.nameOf(c, it.doneBy) }) : null]));
      });
      box.appendChild(list);
    }
    if (!e.cancelled && me && (e.creatorId === me.user.id || (c.me && c.me.role === 'admin'))) {
      box.appendChild(el('div', { class: 'ms-card-foot' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('ev.edit'), on: { click: function () { eventDialog(c, m); } } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('ev.cancel'), on: { click: function () {
          M.confirm(T('ev.cancel_q'), T('ev.cancel'), true).then(function (ok) { if (ok) H.api('PATCH', 'messages/' + m.id + '/event', { cancelled: true }).then(function (r) { H.replace(r.message); }).catch(M.warn); });
        } } }),
      ]));
    }
    return box;
  }
  function eventDialog(c, m) {
    var e = m ? m.event : null;
    var title = el('input', { class: 'form-input', maxlength: '120', value: e ? e.title : '' });
    var start = el('input', { class: 'form-input', type: 'datetime-local', value: localInput(e && e.startsAt) });
    var end = el('input', { class: 'form-input', type: 'datetime-local', value: e && e.endsAt ? localInput(e.endsAt) : '' });
    var place = el('input', { class: 'form-input', maxlength: '120', value: e && e.place ? e.place.label : '' });
    var desc = el('textarea', { class: 'form-input', rows: '3', maxlength: '1000' });
    desc.value = e && e.description ? e.description : '';
    var checklist = el('textarea', { class: 'form-input', rows: '3', placeholder: T('ev.checklist_ph') });
    checklist.value = e && e.checklist ? e.checklist.map(function (x) { return x.text; }).join('\n') : '';
    var rsvp = check(T('ev.rsvp_on'), e ? e.rsvpEnabled : true);
    var guests = check(T('ev.guests_on'), e ? e.guests : false);
    var rem = select([[0, T('ev.rem_0')], [15, T('ev.rem_15')], [60, T('ev.rem_60')], [120, T('ev.rem_120')], [1440, T('ev.rem_1440')]], e ? e.reminderMin : ((H.me().prefs.notify || {}).eventReminderMin || 60), T('ev.reminder'));
    var dep = check(T('ev.departure'), e ? e.departureHint : false);
    var famOk = H.integrations().calendar;
    var fam = check(T('ev.family_calendar'), e ? e.familyCalendar : false);
    var msg = el('p', { class: 'form-hint', role: 'status' });
    var body = el('div', {}, [field(T('ev.title'), title), el('div', { class: 'ms-loc-coords' }, [field(T('ev.start'), start), field(T('ev.end'), end)]), field(T('ev.place'), place), field(T('ev.description'), desc), field(T('ev.checklist'), checklist),
      rsvp.box, guests.box, field(T('ev.reminder'), rem), dep.box, famOk || (e && e.familyCalendar) ? fam.box : null, msg]);
    M.dialog(e ? T('ev.edit') : T('ev.create'), body, [{ label: T('common.cancel'), value: null }, { label: e ? T('common.save') : T('portal.send'), primary: true, onClick: function () {
      var ev = { title: title.value.trim(), startsAt: fromLocal(start.value), endsAt: end.value ? fromLocal(end.value) : null, place: place.value.trim() ? { label: place.value.trim() } : null,
        description: desc.value.trim() || null, checklist: checklist.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 20),
        rsvp: rsvp.input.checked, guests: guests.input.checked, reminderMin: Number(rem.value), departureHint: dep.input.checked, familyCalendar: fam.input.checked };
      if (!ev.title || !ev.startsAt) { msg.textContent = T('ev.need'); return false; }
      var p = e ? H.api('PATCH', 'messages/' + m.id + '/event', ev).then(function (r) { H.replace(r.message); }) : H.send(c, { clientId: M.uuid(), kind: 'event', event: ev });
      return p.then(function () { return true; }, function (er) { msg.textContent = M.errText(er); return false; });
    } }]);
  }

  // ── arrival (read-only in the portal: the apps share the way) ──
  function arrivalEl(m, c) {
    var a = m.arrival;
    var box = el('div', { class: 'ms-arrival is-' + a.state });
    var who = H.nameOf(c, m.senderId, { you: false });
    var head = a.state === 'arrived' ? T('arr.arrived', { name: who }) : (a.state === 'stopped' ? T('arr.stopped') : T('arr.live', { name: who }));
    box.appendChild(el('div', { class: 'ms-card-head' }, [ic('nav', 16), el('b', { text: head })]));
    box.appendChild(el('div', { class: 'ms-card-sub', text: T('arr.to', { label: a.dest.label }) }));
    if (a.state === 'live') {
      box.appendChild(el('div', { class: 'ms-bar ms-arr-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round((a.progress || 0) * 100)) }, [el('i', { style: 'width:' + Math.round((a.progress || 0) * 100) + '%' })]));
      var parts = [];
      if (a.etaAt) parts.push(T('arr.eta', { time: M.hm(a.etaAt) }));
      if (a.distanceM != null) parts.push(a.distanceM >= 1000 ? T('arr.km', { n: (a.distanceM / 1000).toFixed(1) }) : T('arr.m', { n: a.distanceM }));
      if (a.lastAt) parts.push(T('arr.last', { time: M.hm(a.lastAt) }));
      box.appendChild(el('div', { class: 'ms-card-sub', text: parts.join(' · ') || T('arr.waiting') }));
    }
    return box;
  }

  // ── home actions and plugin cards ──
  function runBtn(m, label, body, confirmFirst, primary) {
    return el('button', { type: 'button', class: 'btn btn-sm' + (primary ? ' btn-primary' : ''), text: label, on: { click: function () {
      var go = function () { act(m, 'action/run', body).then(function (r) { if (r && r.result) M.toast(r.result.ok ? (r.result.message || T('act.done')) : (r.result.message || T('error.action_failed')), r.result.ok ? 'good' : 'error'); }); };
      if (confirmFirst) M.confirm(T('act.confirm', { label: label }), label).then(function (ok) { if (ok) go(); }); else go();
    } } });
  }
  function actionEl(m, c) {
    var a = m.action;
    var box = el('div', { class: 'ms-action is-' + a.state });
    var head = a.mode === 'request' ? T('act.request', { name: H.nameOf(c, m.senderId, { you: false }), label: a.label }) : (a.mode === 'grant' ? T('act.grant', { name: H.nameOf(c, a.grant.toUserId, { you: false }), label: a.label }) : a.label);
    box.appendChild(el('div', { class: 'ms-card-head' }, [a.icon ? M.svg(a.icon, 16) : ic('home', 16), el('b', { text: head })]));
    var sub = [];
    if (a.mode === 'grant' && a.grant.until) sub.push(T('act.until', { time: M.when(a.grant.until) }));
    if (a.state !== 'open') sub.push(a.state === 'done' ? T('act.state_done') : (a.state === 'denied' ? T('act.state_denied') : T('act.state_expired')));
    if (a.by) sub.push(T('act.last_by', { name: H.nameOf(c, a.by), time: M.hm(a.at) }) + (a.result && a.result.message ? ' – ' + a.result.message : ''));
    if (sub.length) box.appendChild(el('div', { class: 'ms-card-sub', text: sub.join(' · ') }));
    var foot = el('div', { class: 'ms-card-foot' });
    if (a.can.run) foot.appendChild(runBtn(m, a.mode === 'grant' ? T('act.use') : T('act.run'), {}, a.needsConfirm, true));
    if (a.can.approve) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('act.approve'), on: { click: function () { act(m, 'action/approve').then(function (r) { if (r && r.result && !r.result.ok) M.toast(r.result.message || T('error.action_failed'), 'error'); }); } } }));
    if (a.can.deny) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('act.deny'), on: { click: function () { act(m, 'action/deny'); } } }));
    if (foot.children.length) box.appendChild(foot);
    return box;
  }
  var cardImages = {};
  function cardImage(id) {
    if (!cardImages[id]) cardImages[id] = H.api('GET', 'messages/' + id + '/card/image').catch(function (e) { delete cardImages[id]; throw e; });
    return cardImages[id];
  }
  function cardEl(m) {
    var k = m.card;
    var box = el('div', { class: 'ms-pcard is-' + k.kind });
    if (k.image && /^image\/(jpeg|webp)$/.test(k.image.mime)) {
      // the picture is fetched on its own (GET messages/:id/card/image) and shown as a data: URL (the frame allows those)
      var img = el('img', { class: 'ms-pcard-img', alt: '', hidden: true });
      box.appendChild(img);
      cardImage(m.id).then(function (r) { if (r && /^image\/(jpeg|webp)$/.test(r.mime) && /^[A-Za-z0-9+/=]+$/.test(r.data)) { img.src = 'data:' + r.mime + ';base64,' + r.data; img.hidden = false; } }).catch(function () {});
    }
    // 1.6.0: a notification of GateControl (deliverNotice): "<source> · <topic>", title, the full text
    var n = k.kind === 'notice' && k.notice ? k.notice : null;
    if (n) {
      if (n.priority === 'high' || n.priority === 'critical') box.classList.add('is-high');
      box.appendChild(el('div', { class: 'ms-pcard-src', text: [n.sourceLabel, n.topicLabel].filter(Boolean).join(' · ') }));
    }
    box.appendChild(el('div', { class: 'ms-card-head' }, [ic(k.kind === 'doorbell' || n ? 'bell' : 'home', 16), el('b', { text: k.title })]));
    if (k.text) box.appendChild(el('div', { class: n ? 'ms-pcard-text' : 'ms-card-sub', text: k.text }));
    var foot = el('div', { class: 'ms-card-foot' });
    k.actions.forEach(function (a) { if (a.canRun) foot.appendChild(runBtn(m, a.label, { actionId: a.actionId, plugin: a.plugin }, a.needsConfirm, true)); });
    if (k.lastRun) box.appendChild(el('div', { class: 'ms-card-sub', text: T('act.last_by', { name: H.nameOf(H.conv(m.conversationId), k.lastRun.by), time: M.hm(k.lastRun.at) }) }));
    if (foot.children.length) box.appendChild(foot);
    return box;
  }
  function createAction(c) {
    H.api('GET', 'actions').then(function (r) {
      var list = r.actions || [];
      if (!list.length) { M.toast(T('act.none'), 'error'); return; }
      var sel = select(list.map(function (a, i) { return [i, a.label + (a.pluginName ? ' · ' + a.pluginName : '')]; }), 0, T('act.pick'));
      var mode = select([['run', T('act.mode_run')], ['request', T('act.mode_request')], ['grant', T('act.mode_grant')]], 'run', T('act.mode'));
      var others = c.members.filter(function (mb) { return mb.userId !== H.me().user.id && !mb.gone; });
      var to = select(others.map(function (mb) { return [mb.userId, mb.name || '?']; }), others.length ? others[0].userId : '', T('act.to'));
      var until = el('input', { class: 'form-input', type: 'datetime-local', value: localInput(new Date(Date.now() + 3 * 3600000).toISOString()) });
      var grantBox = el('div', { hidden: true }, [field(T('act.to'), to), field(T('act.until_label'), until)]);
      var msg = el('p', { class: 'form-hint', role: 'status' });
      mode.addEventListener('change', function () { grantBox.hidden = mode.value !== 'grant'; });
      var body = el('div', {}, [field(T('act.pick'), sel), field(T('act.mode'), mode, T('act.rights_hint')), grantBox, msg]);
      M.dialog(T('act.create'), body, [{ label: T('common.cancel'), value: null }, { label: T('portal.send'), primary: true, onClick: function () {
        var a = list[Number(sel.value)];
        var action = { mode: mode.value, actionId: a.id, plugin: a.plugin };
        if (mode.value === 'grant') action.grant = { toUserId: Number(to.value), until: fromLocal(until.value) };
        return H.send(c, { clientId: M.uuid(), kind: 'action', action: action }).then(function () { return true; }, function (e) { msg.textContent = M.errText(e); return false; });
      } }]);
    }).catch(M.warn);
  }

  /** The body of a message of the new kinds (or null). */
  function body(m, c) {
    if (m.pending && ['poll', 'event', 'arrival', 'action'].indexOf(m.kind) >= 0) return el('i', { class: 'ms-muted', text: T('status.pending') });
    if (m.kind === 'poll' && m.poll) return pollEl(m, c);
    if (m.kind === 'event' && m.event) return eventEl(m, c);
    if (m.kind === 'arrival' && m.arrival) return arrivalEl(m, c);
    if (m.kind === 'action' && m.action) return actionEl(m, c);
    if (m.kind === 'card' && m.card) return cardEl(m, c);
    if (['poll', 'event', 'arrival', 'action', 'card'].indexOf(m.kind) < 0) return null;
    return el('i', { class: 'ms-muted', text: T('msg.newer_app') });
  }
  function summary(m) {
    if (m.kind === 'poll') return T('kind.poll') + (m.poll ? ': ' + m.poll.question : '');
    if (m.kind === 'event') return T('kind.event') + (m.event ? ': ' + m.event.title : '');
    if (m.kind === 'arrival') return T('kind.arrival') + (m.arrival ? ': ' + m.arrival.dest.label : '');
    if (m.kind === 'action') return T('kind.action') + (m.action ? ': ' + m.action.label : '');
    if (m.kind === 'card') return m.card ? m.card.title + (m.text ? ': ' + m.text : '') : (m.text || T('kind.card'));
    return null;
  }
  function systemText(s, c) {
    switch (s.event) {
      case 'poll_closed': return s.winner ? T('sys.poll_closed_winner', { question: s.question || '', winner: s.winner }) : T('sys.poll_closed', { question: s.question || '' });
      case 'event_cancelled': return T('sys.event_cancelled', { name: H.nameOf(c, s.by, { you: false }), title: s.title || '' });
      case 'arrived': return T('sys.arrived', { name: H.nameOf(c, s.userId, { you: false }), label: s.label || '' });
      case 'action_run': return T('sys.action_run', { name: H.nameOf(c, s.userId, { you: false }), label: s.label || '' });
      case 'action_denied': return T('sys.action_denied', { name: H.nameOf(c, s.by, { you: false }), label: s.label || '' });
      case 'grant_off': return T(s.ok ? 'sys.grant_off' : 'sys.grant_off_failed', { label: s.label || '' });
      default: return null;
    }
  }
  function replyStoryEl(rs, c) {
    var p = rs.preview || {};
    return el('div', { class: 'ms-quote ms-quote-story' }, [el('b', { text: T('st.reply_to', { name: H.nameOf(c, rs.ownerId, { you: false }) }) }), el('span', { text: p.text || (p.kind === 'image' ? T('kind.image') : T('st.story')) })]);
  }

  // ── status strip and stories ──
  var PRESET_ICON = { homeoffice: 'home', away: 'nav', dnd: 'bell', auto_place: 'nav' };
  function presetLabel(p) {
    return { none: T('st.p_none'), homeoffice: T('st.p_homeoffice'), away: T('st.p_away'), dnd: T('st.p_dnd'), auto_place: T('st.p_auto_place') }[p] || p;
  }
  function statusLine(s) {
    if (!s) return '';
    var t = s.text || presetLabel(s.preset);
    if (s.preset !== 'none' && s.text) t = presetLabel(s.preset) + ' · ' + s.text;
    if (s.preset === 'away' && s.destLabel) t += ' → ' + s.destLabel;
    return t;
  }
  function ringAvatar(item, label, onClick, own) {
    var hasStories = item.stories && item.stories.length;
    var b = el('button', { type: 'button', class: 'ms-ring' + (item.unseen ? ' is-unseen' : '') + (hasStories ? ' has-stories' : ''), title: label, 'aria-label': label, on: { click: onClick } }, [
      el('span', { class: 'ms-ring-av' }, [M.avatar(item.user, 50)]),
      own ? el('span', { class: 'ms-ring-plus', 'aria-hidden': 'true' }, [M.icon('plus', 12, { stroke: '3' })]) : null,
      el('span', { class: 'ms-ring-name', text: own ? T('st.mine') : (item.user.name || '?') }),
    ]);
    if (item.status && !own) b.appendChild(el('span', { class: 'ms-ring-st', text: statusLine(item.status) }));
    return b;
  }
  function strip(feed) {
    var box = el('div', { class: 'ms-strip', role: 'list', 'aria-label': T('st.strip') });
    var me = feed.me;
    box.appendChild(ringAvatar(me, T('st.mine'), function () { if (me.stories.length) viewer(me, true); else ownMenu(me); }, true));
    feed.items.forEach(function (it) {
      box.appendChild(ringAvatar(it, (it.user.name || '?') + (it.status ? ': ' + statusLine(it.status) : ''), function () { if (it.stories.length) viewer(it, false); else statusView(it); }));
    });
    return box;
  }
  function statusView(it) {
    M.dialog(it.user.name || '?', el('div', { class: 'ms-st-view' }, [M.avatar(it.user, 64), el('b', { text: statusLine(it.status) }), it.status && it.status.until ? el('small', { class: 'ms-muted', text: T('st.until', { time: M.when(it.status.until) }) }) : null]), [{ label: T('common.close'), value: null }]);
  }
  function ownMenu(me) {
    var f = H.features();
    var body = el('div', { class: 'ms-st-menu' }, [
      el('div', { class: 'ms-muted', text: me.status ? statusLine(me.status) : T('st.no_status') }),
      el('button', { type: 'button', class: 'btn', on: { click: function () { closeTop(); statusDialog(me.status); } } }, [M.icon('pen', 14), T('st.set')]),
      f.stories ? el('button', { type: 'button', class: 'btn', on: { click: function () { closeTop(); storyDialog(); } } }, [M.icon('plus', 14), T('st.new_story')]) : null,
      me.stories.length ? el('button', { type: 'button', class: 'btn', on: { click: function () { closeTop(); viewer(me, true); } } }, [ic('eye', 14), T('st.my_stories')]) : null,
    ]);
    M.dialog(T('st.mine'), body, [{ label: T('common.close'), value: null }]);
  }
  function closeTop() { var o = document.querySelectorAll('.ms-overlay'); if (o.length) o[o.length - 1].remove(); }
  function audiencePicker(value, ids) {
    var vis = select([['all', T('st.vis_all')], ['family', T('st.vis_family')], ['custom', T('st.vis_custom')]], value || 'all', T('st.visibility'));
    var people = el('div', { class: 'ms-people', hidden: vis.value !== 'custom' });
    H.people().then(function (list) {
      list.forEach(function (p) { people.appendChild(el('label', { class: 'ms-person' }, [M.avatar(p, 30), el('span', { text: p.name }), el('input', { type: 'checkbox', value: String(p.id), checked: (ids || []).indexOf(p.id) >= 0 })])); });
    }).catch(function () {});
    vis.addEventListener('change', function () { people.hidden = vis.value !== 'custom'; });
    return { el: el('div', {}, [field(T('st.visibility'), vis), people]), value: function () { return { visibility: vis.value, userIds: vis.value === 'custom' ? M.$$('input:checked', people).map(function (x) { return Number(x.value); }) : undefined }; } };
  }
  function statusDialog(cur) {
    var me = H.me();
    var preset = select([['none', T('st.p_none')], ['homeoffice', T('st.p_homeoffice')], ['away', T('st.p_away')], ['dnd', T('st.p_dnd')], ['auto_place', T('st.p_auto_place')]], cur ? cur.preset : 'none', T('st.preset'));
    var text = el('input', { class: 'form-input', maxlength: '60', value: cur ? (cur.ownText || (cur.preset === 'auto_place' ? '' : cur.text) || '') : '' });
    var until = select([['', T('st.until_none')], [3600, T('st.until_1h')], [4 * 3600, T('st.until_4h')], ['today', T('st.until_today')]], '', T('st.until_label'));
    var dest = el('input', { class: 'form-input', maxlength: '80', value: cur && cur.destLabel ? cur.destLabel : '' });
    var destBox = el('div', { hidden: preset.value !== 'away' }, [field(T('st.dest'), dest)]);
    var hint = el('small', { class: 'form-hint', hidden: preset.value !== 'auto_place', text: T('st.auto_place_hint') });
    preset.addEventListener('change', function () { destBox.hidden = preset.value !== 'away'; hint.hidden = preset.value !== 'auto_place'; });
    var aud = audiencePicker(cur ? cur.visibility : ((me.prefs.privacy || {}).statusDefault || 'all'), cur ? cur.userIds : []);
    var msg = el('p', { class: 'form-hint', role: 'status' });
    var body = el('div', {}, [field(T('st.preset'), preset), hint, field(T('st.text'), text), destBox, field(T('st.until_label'), until), aud.el, msg]);
    var buttons = [{ label: T('common.cancel'), value: null }];
    if (cur) buttons.push({ label: T('st.clear'), danger: true, onClick: function () { return H.api('DELETE', 'status').then(function () { H.refreshFeed(); return true; }).catch(function (e) { msg.textContent = M.errText(e); return false; }); } });
    buttons.push({ label: T('common.save'), primary: true, onClick: function () {
      var b = Object.assign({ preset: preset.value, text: text.value.trim() || null }, aud.value());
      if (until.value === 'today') { var d = new Date(); d.setHours(23, 59, 0, 0); b.until = d.toISOString(); } else if (until.value) b.until = new Date(Date.now() + Number(until.value) * 1000).toISOString();
      if (b.preset === 'away' && dest.value.trim()) b.destLabel = dest.value.trim();
      if (b.preset === 'none' && !b.text) { msg.textContent = T('st.need_text'); return false; }
      return H.api('PUT', 'status', b).then(function () { H.refreshFeed(); return true; }).catch(function (e) { msg.textContent = M.errText(e); return false; });
    } });
    M.dialog(T('st.set'), body, buttons);
  }
  var BG = ['#0F766E', '#7C3AED', '#DB2777', '#EA580C', '#2563EB', '#334155'];
  function storyDialog() {
    var mode = 'text';
    var text = el('textarea', { class: 'form-input ms-story-tx', rows: '4', maxlength: '700', placeholder: T('st.story_ph') });
    var bg = BG[0];
    var font = 'sans';
    var preview = el('div', { class: 'ms-story-prev' });
    var file = null;
    function paint() { preview.style.background = bg; preview.setAttribute('data-font', font); preview.textContent = text.value || T('st.story_ph'); preview.hidden = mode !== 'text'; }
    text.addEventListener('input', paint);
    var colors = el('div', { class: 'ms-colors', role: 'group', 'aria-label': T('st.color') }, BG.map(function (c) { return el('button', { type: 'button', class: 'ms-color', style: 'background:' + c, 'aria-label': c, on: { click: function () { bg = c; paint(); } } }); }));
    var fonts = select([['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], 'sans', T('st.font'));
    fonts.addEventListener('change', function () { font = fonts.value; paint(); });
    var pick = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'form-input' });
    pick.addEventListener('change', function () { file = pick.files && pick.files[0]; mode = file ? 'image' : 'text'; paint(); });
    var aud = audiencePicker((H.me().prefs.privacy || {}).statusDefault || 'all', []);
    var msg = el('p', { class: 'form-hint', role: 'status' });
    paint();
    var body = el('div', {}, [preview, field(T('st.text'), text), colors, field(T('st.font'), fonts), field(T('st.photo'), pick), aud.el, el('small', { class: 'form-hint', text: T('st.story_hint') }), msg]);
    M.dialog(T('st.new_story'), body, [{ label: T('common.cancel'), value: null }, { label: T('st.share'), primary: true, onClick: function () {
      var b = Object.assign({ kind: mode }, aud.value());
      if (text.value.trim()) b.text = text.value.trim();
      if (mode === 'text') { if (!b.text) { msg.textContent = T('st.need_text'); return false; } b.bg = bg; b.font = font; }
      var up = mode === 'image' ? H.uploadImage(file).then(function (r) { b.mediaId = r.mediaId; if (r.thumbId) b.thumbMediaId = r.thumbId; }) : Promise.resolve();
      return up.then(function () { return H.api('POST', 'status/stories', b); }).then(function () { H.refreshFeed(); return true; }).catch(function (e) { msg.textContent = M.errText(e); return false; });
    } }], { wide: true });
  }
  /** The story viewer: one story after the other (tap / arrows), seen marks, reply and reactions; own: viewers. */
  function viewer(item, own) {
    var i = 0;
    var first = item.stories.findIndex(function (s) { return !s.seen; });
    if (first > 0) i = first;
    var stage = el('div', { class: 'ms-story-stage' });
    var bars = el('div', { class: 'ms-story-bars' }, item.stories.map(function () { return el('i'); }));
    var info = el('div', { class: 'ms-story-info' });
    var foot = el('div', { class: 'ms-story-foot' });
    function show() {
      var s = item.stories[i];
      Array.prototype.forEach.call(bars.children, function (b, k) { b.className = k < i ? 'is-done' : (k === i ? 'is-on' : ''); });
      M.clear(stage);
      if (s.kind === 'text') stage.appendChild(el('div', { class: 'ms-story-text', 'data-font': s.font || 'sans', style: 'background:' + M.safeColor(s.bg, '#0F766E'), text: s.text || '' }));
      else if (s.url) {
        stage.appendChild(s.kind === 'video' ? el('video', { src: s.url, controls: true, autoplay: true, playsinline: true }) : el('img', { src: s.url, alt: s.text || '' }));
        if (s.text) stage.appendChild(el('div', { class: 'ms-story-cap', text: s.text }));
      } else stage.appendChild(el('div', { class: 'ms-story-text', text: T('msg.media_unavailable') }));
      M.clear(info).appendChild(el('span', { text: (own ? T('st.mine') : item.user.name) + ' · ' + M.hm(s.createdAt) + (s.place ? ' · ' + s.place : '') }));
      M.clear(foot);
      if (own) {
        foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { viewers(s); } } }, [ic('eye', 14), T('st.viewers', { n: s.viewerCount || 0 })]));
        foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('common.delete'), on: { click: function () {
          M.confirm(T('st.delete_q'), T('common.delete'), true).then(function (ok) { if (ok) H.api('DELETE', 'status/stories/' + s.id).then(function () { closeTop(); H.refreshFeed(); }).catch(M.warn); });
        } } }));
      } else {
        if (!s.seen) { s.seen = true; H.api('POST', 'status/stories/' + s.id + '/seen', {}).then(function () { H.refreshFeed(true); }).catch(function () {}); }
        ['❤️', '😂', '👍', '🔥'].forEach(function (e) { foot.appendChild(el('button', { type: 'button', class: 'ms-ib', 'aria-label': e, text: e, on: { click: function () { H.api('POST', 'status/stories/' + s.id + '/react', { emoji: e }).then(function () { M.toast(T('st.reacted')); }).catch(M.warn); } } })); });
        var input = el('input', { class: 'form-input', maxlength: '4000', placeholder: T('st.reply_ph') });
        input.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter' || !input.value.trim()) return;
          var t = input.value.trim();
          input.value = '';
          H.api('POST', 'conversations', { kind: 'direct', userIds: [item.user.id] }).then(function (r) {
            return H.api('POST', 'conversations/' + r.conversation.id + '/messages', { clientId: M.uuid(), kind: 'text', text: t, replyStory: { storyId: s.id } });
          }).then(function () { M.toast(T('st.replied')); }).catch(M.warn);
        });
        foot.appendChild(input);
      }
    }
    var prev = el('button', { type: 'button', class: 'ms-story-nav is-prev', 'aria-label': T('st.prev'), on: { click: function () { if (i > 0) { i--; show(); } } } }, [M.icon('back', 20)]);
    var next = el('button', { type: 'button', class: 'ms-story-nav is-next', 'aria-label': T('st.next'), on: { click: function () { if (i < item.stories.length - 1) { i++; show(); } else closeTop(); } } }, [M.icon('back', 20)]);
    var box = el('div', { class: 'ms-story' }, [bars, info, el('div', { class: 'ms-story-wrap' }, [prev, stage, next]), item.status ? el('div', { class: 'ms-story-st', text: statusLine(item.status) }) : null, foot]);
    M.dialog(own ? T('st.my_stories') : (item.user.name || '?'), box, [], { wide: true, onOpen: function () {
      document.addEventListener('keydown', function k(e) { if (!box.isConnected) { document.removeEventListener('keydown', k); return; } if (e.key === 'ArrowRight') next.click(); if (e.key === 'ArrowLeft') prev.click(); });
    } });
    show();
  }
  function viewers(s) {
    H.api('GET', 'status/stories/' + s.id + '/viewers').then(function (r) {
      var list = el('div', { class: 'ms-people' });
      if (!r.viewers.length) list.appendChild(el('p', { class: 'ms-list-empty', text: T('st.no_viewers') }));
      r.viewers.forEach(function (v) { list.appendChild(el('div', { class: 'ms-person' }, [M.avatar(v.user, 34), el('span', { text: (v.user.name || '?') + ' · ' + M.hm(v.seenAt) }), v.reaction ? el('span', { text: v.reaction }) : null])); });
      M.dialog(T('st.viewers', { n: r.viewers.length }), list, [{ label: T('common.close'), value: null }]);
    }).catch(M.warn);
  }

  // ── settings (privacy, notifications, chats, blocks) ──
  function settings() {
    M.api('GET', 'me').then(function (r) {
      var p = r.prefs;
      var f = r.features || {};
      var body = el('div', { class: 'ms-settings' });
      var save = function (x, revert) { M.api('PUT', 'prefs', x).then(function (rr) { p = rr.prefs; H.setPrefs(rr.prefs); }).catch(function (e) { if (revert) revert(); M.warn(e); }); };
      var sec = function (title) { body.appendChild(el('div', { class: 'ms-sec', text: title })); };
      var sw = function (label, hint, on, fn) {
        body.appendChild(el('div', { class: 'ms-pref' }, [el('span', { class: 'ms-pref-tx' }, [label, hint ? el('small', { text: hint }) : null]), M.switchBtn(on, label, function (v, b) { fn(v, function () { b.setAttribute('aria-checked', v ? 'false' : 'true'); }); })]));
      };
      var sel = function (label, hint, opts, value, fn) {
        var s = select(opts, value, label);
        s.addEventListener('change', function () { fn(s.value); });
        body.appendChild(el('div', { class: 'ms-pref' }, [el('span', { class: 'ms-pref-tx' }, [label, hint ? el('small', { text: hint }) : null]), s]));
      };
      var aud = [['all', T('set.aud_all')], ['family', T('set.aud_family')], ['nobody', T('set.aud_nobody')]];
      // 1.6.0: where GateControl's notifications appear (GateControl ≥ 1.191.0)
      if (f.notice_routes) {
        body.appendChild(el('button', { type: 'button', class: 'ms-pref ms-pref-btn', on: { click: function () { closeTop(); noticeRoutes(); } } }, [
          el('span', { class: 'ms-pref-tx' }, [T('routes.title'), el('small', { text: T('routes.open_hint') })]), M.icon('bell', 16),
        ]));
      }
      sec(T('set.chats'));
      [['readReceipts', 'prefs.read_receipts', 'prefs.read_receipts_hint'], ['typing', 'prefs.typing', 'prefs.typing_hint'], ['preview', 'prefs.preview', 'prefs.preview_hint']].forEach(function (x) {
        sw(T(x[1]), T(x[2]), !!p[x[0]], function (v, rev) { var o = {}; o[x[0]] = v; save(o, rev); });
      });
      if (f.privacy2) {
        sw(T('set.keep_archived'), T('set.keep_archived_hint'), p.chats.keepArchived, function (v, rev) { save({ chats: { keepArchived: v } }, rev); });
        sec(T('set.privacy'));
        sel(T('set.last_seen'), T('set.last_seen_hint'), aud, p.privacy.lastSeen, function (v) { save({ privacy: { lastSeen: v } }); });
        sel(T('set.avatar'), null, aud, p.privacy.avatar, function (v) { save({ privacy: { avatar: v } }); });
        sel(T('set.status_default'), null, [['all', T('set.aud_all')], ['family', T('set.aud_family')], ['custom', T('st.vis_custom')]], p.privacy.statusDefault, function (v) { save({ privacy: { statusDefault: v } }); });
        sel(T('set.place'), T('set.place_hint'), [['nobody', T('set.aud_nobody')], ['family', T('set.aud_family')], ['all', T('set.aud_all')]], p.privacy.placeInStatus, function (v) { save({ privacy: { placeInStatus: v } }); });
        sel(T('set.group_add'), null, aud, p.privacy.groupAdd, function (v) { save({ privacy: { groupAdd: v } }); });
        sel(T('set.default_dis'), null, (r.limits.disappearingS || [0, 86400, 604800, 2592000]).map(function (s) { return [s, s ? T('dis.' + s) : T('dis.off')]; }), p.privacy.defaultDisappearingS, function (v) { save({ privacy: { defaultDisappearingS: Number(v) } }); });
        sec(T('set.notify'));
        sw(T('set.mentions_only'), T('set.mentions_only_hint'), p.notify.groupsMentionsOnly, function (v, rev) { save({ notify: { groupsMentionsOnly: v } }, rev); });
        sw(T('set.reactions'), null, p.notify.reactions, function (v, rev) { save({ notify: { reactions: v } }, rev); });
        if (f.stories) sw(T('set.digest'), T('set.digest_hint'), p.notify.statusDigest, function (v, rev) { save({ notify: { statusDigest: v } }, rev); });
        sel(T('set.event_reminder'), null, [[0, T('ev.rem_0')], [15, T('ev.rem_15')], [60, T('ev.rem_60')], [120, T('ev.rem_120')], [1440, T('ev.rem_1440')]], p.notify.eventReminderMin, function (v) { save({ notify: { eventReminderMin: Number(v) } }); });
      }
      if (f.msg_tools) {
        sec(T('set.blocked'));
        var bl = el('div', { class: 'ms-people' });
        body.appendChild(bl);
        var drawBlocks = function (list) {
          M.clear(bl);
          if (!list.length) bl.appendChild(el('p', { class: 'ms-muted', text: T('set.no_blocked') }));
          list.forEach(function (b) {
            bl.appendChild(el('div', { class: 'ms-person' }, [M.avatar(b, 30), el('span', { text: b.name || T('portal.gone') }), el('button', { type: 'button', class: 'btn btn-sm', text: T('set.unblock'), on: { click: function () { M.api('DELETE', 'blocks/' + b.userId).then(function (x) { drawBlocks(x.blocks); H.reload(); }).catch(M.warn); } } })]));
          });
        };
        M.api('GET', 'blocks').then(function (x) { drawBlocks(x.blocks); }).catch(function () {});
        body.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { closeTop(); listsDialog(); } } }, [ic('list', 14), T('lists.manage')]));
      }
      if (f.actions) body.appendChild(el('p', { class: 'ms-note' }, [ic('home', 14), T('set.actions_hint')]));
      body.appendChild(el('p', { class: 'ms-note', style: 'margin-top:10px' }, [M.icon('lock', 14), T('info.encrypted')]));
      M.dialog(T('prefs.title'), body, [{ label: T('common.close'), value: null }], { wide: true });
    }).catch(M.warn);
  }

  // ── 1.6.0: "Wo Mitteilungen erscheinen" — GateControl's routes of the viewer (portal/notify-routes) ──
  function destLabel(d, g) { return d === 'family' ? T('routes.family') : (d === 'own' ? T('routes.own', { label: g.label }) : T('routes.inbox')); }
  function noticeRoutes() {
    var body = el('div', { class: 'ms-settings ms-routes' });
    var draw = function (v) {
      M.clear(body);
      body.appendChild(el('p', { class: 'ms-note', text: T('routes.intro') }));
      if (!v.sink) body.appendChild(el('p', { class: 'ms-note' }, [M.icon('info', 14), T('routes.no_sink')]));
      else if (!v.canFamily) body.appendChild(el('p', { class: 'ms-note' }, [M.icon('group', 14), T('routes.family_parents')]));
      if (!v.groups.length) body.appendChild(el('p', { class: 'ms-muted', text: T('routes.empty') }));
      v.groups.forEach(function (g) {
        body.appendChild(el('div', { class: 'ms-sec', text: g.label }));
        g.topics.forEach(function (tp) {
          var sub = tp.locked ? T('routes.locked') : (tp.dest === 'family' && tp.familySetBy ? T('routes.set_by', { name: tp.familySetBy }) : null);
          var canChange = v.sink && !tp.locked && !(tp.dest === 'family' && !v.canFamily);
          var chip = tp.locked
            ? el('span', { class: 'ms-chip ms-route-chip is-locked', title: T('routes.locked') }, [M.icon('lock', 12), T('routes.inbox')])
            : el('button', { type: 'button', class: 'ms-chip ms-route-chip', 'aria-pressed': tp.dest !== 'inbox' ? 'true' : 'false', disabled: !canChange, 'aria-label': T('routes.choose', { topic: tp.label }),
              on: { click: function () { choose(v, g, tp); } } }, [destLabel(tp.dest, g)]);
          body.appendChild(el('div', { class: 'ms-pref' }, [el('span', { class: 'ms-pref-tx' }, [tp.label, sub ? el('small', { text: sub }) : null]), chip]));
        });
      });
    };
    var choose = function (v, g, tp) {
      var opts = [['inbox', T('routes.inbox'), T('routes.inbox_hint')]];
      if (v.canFamily) opts.push(['family', T('routes.family'), T('routes.family_hint')]);
      opts.push(['own', T('routes.own', { label: g.label }), T('routes.own_hint')]);
      var name = 'ms-route-' + tp.id;
      var list = el('div', { class: 'ms-route-opts', role: 'radiogroup', 'aria-label': tp.label });
      opts.forEach(function (o) {
        list.appendChild(el('label', { class: 'ms-route-opt' }, [el('input', { type: 'radio', name: name, value: o[0], checked: tp.dest === o[0] }), el('span', { class: 'ms-pref-tx' }, [o[1], el('small', { text: o[2] })])]));
      });
      var msg = el('p', { class: 'form-hint', role: 'status' });
      M.dialog(tp.label, el('div', {}, [list, msg]), [{ label: T('common.cancel'), value: null }, { label: T('common.save'), primary: true, onClick: function () {
        var pick = list.querySelector('input:checked');
        var dest = pick ? pick.value : tp.dest;
        if (dest === tp.dest) return true;
        return M.api('PUT', 'portal/notify-routes', { topic: tp.id, dest: dest }).then(function (r) {
          draw(r);
          // 1.7.0: "own chat" — GateControl (≥ 1.192.0) had the chat created at once, or found the existing one
          if (r.chat) M.toast(T(r.chat.created ? 'routes.chat_created' : 'routes.chat_used', { label: r.chat.label || g.label }), 'good');
          return true;
        }, function (e) { msg.textContent = M.errText(e); return false; });
      } }]);
    };
    M.api('GET', 'portal/notify-routes').then(function (v) {
      draw(v);
      M.dialog(T('routes.title'), body, [{ label: T('common.close'), value: null }], { wide: true });
    }).catch(M.warn);
  }

  // ── chat lists ──
  function listsDialog() {
    M.api('GET', 'lists').then(function (r) {
      var lists = r.lists.map(function (l) { return { id: l.id, name: l.name, conversationIds: l.conversationIds.slice() }; });
      var body = el('div');
      var draw = function () {
        M.clear(body);
        lists.forEach(function (l, k) {
          var name = el('input', { class: 'form-input', maxlength: '40', value: l.name });
          name.addEventListener('input', function () { l.name = name.value; });
          var chats = el('div', { class: 'ms-people' }, H.convs().map(function (c) {
            var cb = el('input', { type: 'checkbox', checked: l.conversationIds.indexOf(c.id) >= 0 });
            cb.addEventListener('change', function () { l.conversationIds = cb.checked ? l.conversationIds.concat([c.id]) : l.conversationIds.filter(function (x) { return x !== c.id; }); });
            return el('label', { class: 'ms-person' }, [el('span', { text: H.title(c) }), cb]);
          }));
          body.appendChild(el('div', { class: 'ms-list-edit' }, [el('div', { class: 'ms-loc-tools' }, [name, el('button', { type: 'button', class: 'ms-ib', 'aria-label': T('common.delete'), on: { click: function () { lists.splice(k, 1); draw(); } } }, [M.icon('trash', 16)])]), chats]));
        });
        if (lists.length < 20) body.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('lists.add'), on: { click: function () { lists.push({ id: 'l' + Date.now().toString(36), name: T('lists.new'), conversationIds: [] }); draw(); } } }));
      };
      draw();
      M.dialog(T('lists.manage'), body, [{ label: T('common.cancel'), value: null }, { label: T('common.save'), primary: true, onClick: function () {
        var out = lists.filter(function (l) { return l.name.trim(); }).map(function (l) { return { id: l.id, name: l.name.trim().slice(0, 40), conversationIds: l.conversationIds }; });
        return M.api('PUT', 'lists', out).then(function (x) { H.setLists(x.lists); return true; }).catch(function (e) { M.warn(e); return false; });
      } }], { wide: true });
    }).catch(M.warn);
  }

  // ── message tools: remind me, suggestions ──
  function remind(m) {
    var at = el('input', { class: 'form-input', type: 'datetime-local', value: localInput(new Date(Date.now() + 3600000).toISOString()) });
    var quick = el('div', { class: 'ms-tabs' }, [[3600, T('tools.in_1h')], [3 * 3600, T('tools.in_3h')], ['tomorrow', T('tools.tomorrow')]].map(function (q) {
      return el('button', { type: 'button', text: q[1], on: { click: function () {
        var d = q[0] === 'tomorrow' ? (function () { var x = new Date(); x.setDate(x.getDate() + 1); x.setHours(9, 0, 0, 0); return x; }()) : new Date(Date.now() + q[0] * 1000);
        at.value = localInput(d.toISOString());
      } } });
    }));
    M.dialog(T('tools.remind'), el('div', {}, [quick, field(T('tools.remind_at'), at)]), [{ label: T('common.cancel'), value: null }, { label: T('common.save'), primary: true, onClick: function () {
      var v = fromLocal(at.value); if (!v) return false;
      return H.api('POST', 'messages/' + m.id + '/remind', { at: v }).then(function () { M.toast(T('tools.reminded', { time: M.when(v) })); return true; }).catch(function (e) { M.warn(e); return false; });
    } }]);
  }
  function suggest(m) {
    var integ = H.integrations();
    H.api('GET', 'messages/' + m.id + '/suggest').then(function (r) {
      var body = el('div');
      if (r.items.length) {
        body.appendChild(el('div', { class: 'ms-sec', text: T('tools.items') }));
        var boxes = r.items.map(function (it) { var x = check(it, true); body.appendChild(x.box); return { it: it, input: x.input }; });
        if (integ.lists) body.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('tools.to_list'), on: { click: function () {
          var items = boxes.filter(function (b) { return b.input.checked; }).map(function (b) { return b.it; });
          if (!items.length) return;
          H.api('POST', 'messages/' + m.id + '/to-list', { items: items }).then(function (x) { M.toast(T('tools.added', { n: x.added })); closeTop(); }).catch(M.warn);
        } } }));
      }
      if (r.dates.length) {
        body.appendChild(el('div', { class: 'ms-sec', text: T('tools.dates') }));
        r.dates.forEach(function (d) {
          body.appendChild(el('div', { class: 'ms-pref' }, [el('span', { class: 'ms-pref-tx' }, [d.title || T('kind.event'), el('small', { text: d.label })]),
            integ.calendar ? el('button', { type: 'button', class: 'btn btn-sm', text: T('tools.to_calendar'), on: { click: function () {
              H.api('POST', 'messages/' + m.id + '/to-calendar', { title: d.title || T('kind.event'), startsAt: d.startsAt, allDay: !!d.allDay }).then(function () { M.toast(T('tools.calendar_done')); }).catch(M.warn);
            } } }) : null]));
        });
      }
      if (!r.items.length && !r.dates.length) body.appendChild(el('p', { class: 'ms-muted', text: T('tools.nothing') }));
      if ((r.items.length || r.dates.length) && !integ.lists && !integ.calendar) body.appendChild(el('p', { class: 'ms-note', text: T('tools.no_familie') }));
      M.dialog(T('tools.suggest'), body, [{ label: T('common.close'), value: null }]);
    }).catch(M.warn);
  }
  /** Export: the text file to download (GC.download when the host has it, else shown to copy). */
  function exportChat(c) {
    var parts = [];
    var step = function (before) {
      return H.api('GET', 'conversations/' + c.id + '/export?format=txt' + (before ? '&before=' + before : '')).then(function (r) {
        parts.unshift(r.text);
        if (r.truncated && r.before && parts.length < 20) return step(r.before);
        return r;
      });
    };
    step(null).then(function (r) {
      var textAll = parts.join('');
      if (root.GC && typeof root.GC.download === 'function') { root.GC.download(textAll, { name: r.fileName, type: 'text/plain' }); return; }
      var ta = el('textarea', { class: 'form-input ms-export', rows: '14', readonly: true });
      ta.value = textAll;
      M.dialog(r.fileName, el('div', {}, [ta, el('small', { class: 'form-hint', text: T('tools.export_copy') })]), [{ label: T('common.close'), value: null }], { wide: true });
      setTimeout(function () { ta.select(); }, 50);
    }).catch(M.warn);
  }

  root.MSRich = {
    init: function (host) { H = host; },
    body: body, summary: summary, systemText: systemText, replyStoryEl: replyStoryEl, strip: strip, statusLine: statusLine,
    createPoll: createPoll, createEvent: function (c) { eventDialog(c, null); }, createAction: createAction,
    statusDialog: statusDialog, storyDialog: storyDialog, settings: settings, noticeRoutes: noticeRoutes, listsDialog: listsDialog, remind: remind, suggest: suggest, exportChat: exportChat,
    icon: ic, presetIcon: function (p) { return PRESET_ICON[p] || null; }, iso: iso,
  };
}(typeof window !== 'undefined' ? window : globalThis));
