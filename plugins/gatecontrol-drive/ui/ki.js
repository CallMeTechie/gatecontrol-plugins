/* Drive (gatecontrol-drive) — AI in Drive in the portal (since 1.14.0, mockups "KI in Drive": Fragen, Fristen, Main /
 * Whiteboard). Only while GET me features say so:
 *
 *   docAsk            "Dateien | Fragen" below the search field — a question (the chip, or a "?" at the end) is asked
 *                     with Enter (POST ask): the answer card (the dates bold, "Frist in den Familienkalender" when a
 *                     deadline of a source fits, the sources with their quote — a click opens the file), "nichts
 *                     gefunden" with "Gesucht nach: … · in …", the note "Antwort nur aus deinen Dateien. Tresore werden
 *                     nie durchsucht."
 *   docAi             the page "Fristen" by month: the kind as a tag, the day with "in N Tagen" (a renewal: "kündigen
 *                     bis …"), "neu", what and from whom, the file; "In den Familienkalender" / "Im Familienkalender ✓"
 *                     (deadlineCalendar) and "Erinnern" / "Erinnerung N Tage vorher ✓"; since 1.17.0 with the calendars of
 *                     Mail (deadlineMailCalendar) "In Kalender eintragen" with the choice of the target, "Im Kalender · …"
 *   scanDocs          "In Dokument umwandeln" for a picture or a PDF scan: "Scan prüfen" — "Erkannt: <Art>", the formats
 *                     (PDF for a JPEG, Word, Excel for a table), the preview, name and folder, "Original-Scan behalten",
 *                     the cost line; the server writes the file (POST scans/convert), this tab uploads its bytes
 *                     (GC.upload) and files them (POST scans/save)
 *
 * portal.js calls DriveKi.attach(ui) with its helpers and asks it: isQuestion(q), typed(q), ask(q), chips(main, mode),
 * showDeadlines(main), calendarButton(d, after), targetRow(area, setRow, after) (the settings' „Fristen aus …“, 1.17.0),
 * canConvert(n), convert(n), photoSummary(search, onWord). Server and
 * user text only ever goes into textContent or attributes.
 */
(function () {
  'use strict';

  var IMAGES_MAX = 600 * 1024;          // POST scans/convert takes ≤ 600 KB of pictures
  var NEW_DAYS = 7;                     // "neu": found within a week
  var SCAN_RE = /^image\/(jpeg|png|webp|gif)$/;

  function attach(U) {
    var T = U.T;
    var h = U.h;
    var icon = U.icon;
    var btn = U.btn;
    var api = U.api;
    var S = U.S;
    var has = U.has;
    var st = { mode: 'files', seq: 0 };

    // ── questions to the documents (docAsk) ─────────────

    function isQuestion(q) {
      return has('docAsk') && String(q || '').trim().length >= 3 && (st.mode === 'ask' || /\?\s*$/.test(q));
    }

    /** The chips "Dateien | Fragen" above a search's result. */
    function chips(main, mode) {
      if (!has('docAsk')) return;
      var row = h('div', { class: 'dp-chips dp-k-chips', attrs: { role: 'group', 'aria-label': T('p.k.mode') } }, [['files', 'p.k.files'], ['ask', 'p.k.ask']].map(function (m) {
        return h('button', { type: 'button', text: T(m[1]), attrs: { 'aria-pressed': String(mode === m[0]) }, on: { click: function () {
          st.mode = m[0];
          var q = U.query();
          if (m[0] === 'ask') typed(q); else if (q.length >= 2) U.search(q); else U.home();
        } } });
      }));
      main.appendChild(row);
    }

    function page() {
      S.page = 'ask';
      S.seq++;
      U.renderNav(); U.renderCrumbs(); U.renderTools();
      var main = U.$('dp-main');
      U.clear(main);
      chips(main, 'ask');
      return main;
    }

    /** A question typed, not asked yet: Enter asks it. */
    function typed(q) {
      var main = page();
      main.appendChild(h('div', { class: 'dp-k-card is-quiet' }, [icon('spark'), h('span', { text: String(q || '').trim().length >= 3 ? T('p.k.enter', { q: q }) : T('p.k.type_q') })]));
      main.appendChild(note());
    }

    function note() { return h('p', { class: 'dp-hint dp-k-note', text: T('p.k.note') }); }

    /** The answer's text with the dates (14.03.2026, 2026-03-14) bold. */
    function answerText(text) {
      var p = h('p', { class: 'dp-k-answer' });
      var re = /(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/g;
      var at = 0;
      var m;
      while ((m = re.exec(text))) {
        if (m.index > at) p.appendChild(document.createTextNode(text.slice(at, m.index)));
        p.appendChild(h('b', { text: m[0] }));
        at = m.index + m[0].length;
      }
      if (at < text.length) p.appendChild(document.createTextNode(text.slice(at)));
      return p;
    }

    function ask(q) {
      var main = page();
      var seq = ++st.seq;
      main.appendChild(h('div', { class: 'dp-k-card is-quiet', attrs: { role: 'status' } }, [icon('spark'), h('span', { text: T('p.k.asking') })]));
      api('POST', 'ask', { q: q }).then(function (r) {
        if (seq !== st.seq || S.page !== 'ask') return;
        main = page();
        if (r.status !== 'answered') {
          main.appendChild(h('div', { class: 'dp-k-card' }, [
            h('p', { class: 'dp-k-answer', text: T('p.k.none') }),
            h('p', { class: 'dp-hint', text: T('p.k.searched', { terms: (r.terms || []).join(', ') || '—', areas: list(r.areas || []) }) }),
          ]));
          main.appendChild(note());
          return;
        }
        var card = h('div', { class: 'dp-k-card' }, [answerText(r.answer || '')]);
        var d = r.deadline;
        if (d && has('deadlineCalendar')) card.appendChild(h('div', { class: 'dp-actions dp-k-acts' }, calendarButton(d, function () { ask(q); }, T('p.k.dl_to_cal'))));
        main.appendChild(card);
        var src = r.sources || [];
        main.appendChild(h('span', { class: 'dp-label dp-k-srclab', text: U.P('p.k.sources', src.length) }));
        main.appendChild(h('div', { class: 'dp-list' }, src.map(function (s) {
          var folder = String(s.path || '').split('/').slice(0, -1).join(' › ');
          var a = U.areaOf(s.areaId);
          var where = [folder || (a ? a.label : ''), s.page ? T('p.k.page', { n: s.page }) : null].filter(Boolean).join(' · ');
          return h('button', { type: 'button', class: 'dp-k-src', on: { click: function () { U.openTarget(s.nodeId, null); } } }, [
            h('span', { class: 'dp-k-ext', text: ext(s.name) }),
            h('span', { class: 'dp-dl-tx' }, [h('span', { class: 'dp-name', text: s.name }), where ? h('span', { class: 'dp-meta', text: where }) : null,
              h('span', { class: 'dp-k-quote', text: '„' + s.quote + '“' })]),
          ]);
        })));
        main.appendChild(note());
      }, function (e) {
        if (seq !== st.seq) return;
        main = page();
        main.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: U.errText(e) })]));
      });
    }

    function list(xs) {
      if (xs.length < 2) return xs.join('');
      return xs.slice(0, -1).join(', ') + ' ' + T('p.k.and') + ' ' + xs[xs.length - 1];
    }
    function ext(name) {
      var i = String(name).lastIndexOf('.');
      return i > 0 ? String(name).slice(i + 1, i + 5).toUpperCase() : '';
    }

    // ── deadlines (docAi) and the family calendar (deadlineCalendar) ──

    // ── targets: the family calendar and the calendars of Mail (since 1.17.0, deadlineMailCalendar) ──

    var multi = function () { return has('deadlineMailCalendar'); };

    /** A target → its text: „Nicht eintragen“, „Familienkalender“, „Outlook.com · Kalender“. */
    function targetText(t) {
      if (!t) return T('p.k.t_none');
      return t.kind === 'family' ? T('p.k.t_family') : (t.label || T('p.k.t_none'));
    }
    function sameTarget(a, b) {
      if (!a || !b) return !a && !b;
      return a.kind === b.kind && (a.kind !== 'mail' || String(a.calendarId) === String(b.calendarId));
    }

    /** GET deadlines/calendars → the choices: [{ target, text, group }] (the family calendar, then Mail's by account). */
    function choices() {
      return api('GET', 'deadlines/calendars').then(function (r) {
        var out = [];
        if (r.family) out.push({ target: { kind: 'family' }, text: T('p.k.t_family'), group: null });
        (r.mail || []).forEach(function (c) {
          var a = c.account || {};
          out.push({ target: { kind: 'mail', calendarId: c.id, label: [a.label, c.name].filter(Boolean).join(' · ') }, text: c.name, color: c.color || null,
            group: { key: String(a.id == null ? 'gc' : a.id), label: a.email && a.label !== a.email ? a.label + ' · ' + a.email : (a.label || '') } });
        });
        return out;
      });
    }

    /**
     * The choice of a target (a menu in a dialog): o { title, sub, current, none (offer „Nicht eintragen“), list } →
     * onPick(target | null). The current one is marked and first among its kind.
     */
    function chooseTarget(o, onPick) {
      var items = [];
      var item = function (target, text, color) {
        var on = sameTarget(target, o.current);
        items.push(h('button', { type: 'button', attrs: { 'aria-pressed': String(on) }, on: { click: function () { U.closeDialog(); onPick(target); } } }, [
          icon(on ? 'check' : 'calendar'), h('span', { class: 'dp-menu-tx' }, [h('span', { text: text })]),
          color ? h('span', { class: 'dp-k-tdot', attrs: { style: 'background:' + (/^#[0-9A-Fa-f]{6}$/.test(color) ? color : 'transparent') } }) : null,
        ]));
      };
      if (o.none) item(null, T('p.k.t_none'));
      var group = null;
      o.list.forEach(function (c) {
        var key = c.group ? c.group.key : null;
        if (key !== group) {
          group = key;
          if (c.group) items.push(h('span', { class: 'dp-label dp-k-tgroup', text: c.group.label }));
        }
        item(c.target, c.text, c.color);
      });
      if (!o.list.length) items.push(h('p', { class: 'dp-hint', text: T('p.k.t_none_avail') }));
      U.dialog(o.title, [h('div', { class: 'dp-menu' }, items)], { sub: o.sub || null });
    }

    /** The row „Fristen aus <Bereich>“ of the settings: the value, a click opens the choice (PATCH areas/<id>). */
    function targetRow(a, setRow, after) {
      var title = T('p.k.st_from', { area: a.label });
      var value = U.btn(targetText(a.deadlinesTarget), function () {
        choices().then(function (list) {
          chooseTarget({ title: title, current: a.deadlinesTarget || null, none: true, list: list }, function (target) {
            var body = { deadlinesTarget: target ? (target.kind === 'mail' ? { kind: 'mail', calendarId: target.calendarId } : { kind: 'family' }) : null };
            api('PATCH', 'areas/' + encodeURIComponent(a.id), body).then(function (r) {
              a.deadlinesTarget = (r.area && r.area.deadlinesTarget) || null;
              a.deadlinesToCalendar = !!a.deadlinesTarget;
              if (after) after();
            }, U.fail);
          });
        }, U.fail);
      }, { small: true, attrs: { 'aria-label': title + ': ' + targetText(a.deadlinesTarget) } });
      return setRow(title, T('p.k.st_from_hint'), value);
    }

    function postCalendar(d, target, after, b) {
      var body = target && target.kind === 'mail' ? { target: { kind: 'mail', calendarId: target.calendarId } } : {};
      if (b) b.disabled = true;
      api('POST', 'deadlines/' + d.id + '/calendar', body).then(function (r) {
        var c = r.deadline && r.deadline.calendar;
        U.toast(multi() && c && c.target ? T('p.k.cal_done_to', { label: c.target.label }) : T('p.k.cal_done'));
        if (after) after();
      }, function (e) { if (b) b.disabled = false; U.fail(e); });
    }

    /**
     * "In den Familienkalender" → POST deadlines/<id>/calendar; already there: "Im Familienkalender ✓". Since 1.17.0 with
     * the calendars of Mail: "In Kalender eintragen" asks for the target when there is more than one (the area's first
     * and marked); already there: "Im Kalender · Outlook.com · Kalender".
     */
    function calendarButton(d, after, label) {
      if (!has('deadlineCalendar') && !multi()) return null;
      if (d.calendar) {
        var done = multi() && d.calendar.target ? T('p.k.in_cal_to', { label: d.calendar.target.label }) : T('p.k.in_cal');
        return btn(done, function () { /* there already */ }, { small: true, icon: 'check', disabled: true, attrs: { 'aria-label': done } });
      }
      if (!multi()) return btn(label || T('p.k.to_cal'), function (ev) { postCalendar(d, null, after, ev && ev.currentTarget); }, { small: true, icon: 'calendar' });
      return btn(T('p.k.to_cal_any'), function (ev) {
        var b = ev && ev.currentTarget;
        choices().then(function (list) {
          if (list.length === 1) { postCalendar(d, list[0].target, after, b); return; }
          var areaId = d.node ? d.node.areaId : null;
          var area = areaId ? U.areaOf(areaId) : null;
          var current = area && area.deadlinesTarget ? area.deadlinesTarget : null;
          // the area's target first
          var first = list.filter(function (c) { return sameTarget(c.target, current); });
          var rest = list.filter(function (c) { return !sameTarget(c.target, current); });
          chooseTarget({ title: T('p.k.t_choose'), sub: d.label || null, current: current, none: false, list: first.concat(rest) }, function (target) { postCalendar(d, target, after, b); });
        }, U.fail);
      }, { small: true, icon: 'calendar' });
    }

    var DAY = 86400000;
    function dayOf(date) { var p = String(date).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
    function dayText(date) { return dayOf(date).toLocaleDateString(U.LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit' }); }
    function inDays(date) {
      var now = new Date();
      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var n = Math.round((dayOf(date) - today) / DAY);
      return n <= 0 ? T('p.k.today') : U.P('p.k.in_days', n);
    }

    /** The page "Fristen": by month, each with its tag, day, file and the two buttons. */
    function showDeadlines(main) {
      var seq = ++st.seq;
      api('GET', 'deadlines').then(function (r) {
        if (seq !== st.seq || S.page !== 'deadlines') return;
        U.clear(main);
        main.appendChild(h('p', { class: 'dp-hint', text: T('p.k.dl_hint'), attrs: { style: 'margin-bottom:12px' } }));
        var all = r.deadlines || [];
        if (!all.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.dl_none') })); return; }
        var month = null;
        var box = null;
        all.forEach(function (d) {
          var m = d.date.slice(0, 7);
          if (m !== month) {
            month = m;
            main.appendChild(h('h2', { class: 'dp-month' }, h('span', { text: dayOf(d.date).toLocaleDateString(U.LOCALE, { month: 'long', year: 'numeric' }) })));
            box = h('div', { class: 'dp-k-dls' });
            main.appendChild(box);
          }
          box.appendChild(deadlineCard(d, function () { showDeadlines(main); }));
        });
      }, U.fail);
    }

    function deadlineCard(d, after) {
      var doc = d.doc || {};
      var fresh = d.foundAt && Date.now() - new Date(d.foundAt).getTime() < NEW_DAYS * DAY;
      var when = d.kind === 'renewal' ? T('p.k.cancel_by', { day: dayText(d.date) }) : dayText(d.date);
      var title = d.label || doc.title || doc.sender || T('p.dl_' + d.kind);
      var meta = [doc.sender && doc.sender !== title ? doc.sender : null, doc.amount != null ? U.fmtAmount(doc.amount, doc.currency) : null].filter(Boolean).join(' · ');
      var past = d.date < U.today();
      var acts = [];
      if (!past) {
        var cal = calendarButton(d, after);
        if (cal) acts.push(cal);
        if (d.reminder) {
          acts.push(h('span', { class: 'dp-k-pill' }, [icon('check', 14), h('span', { text: d.reminder.daysBefore ? U.P('p.k.reminder_days', d.reminder.daysBefore) : T('p.k.reminder_day') })]));
          acts.push(U.ibtn('close', T('p.dl_remove'), function () { api('DELETE', 'deadlines/' + d.id + '/remind').then(after, U.fail); }, { size: 16 }));
        } else {
          var sel = h('select', { class: 'dp-input dp-btn-sm', attrs: { 'aria-label': T('p.dl_when') } }, [0, 1, 3, 7, 14].map(function (x) {
            return h('option', { value: String(x), text: x === 0 ? T('p.dl_same_day') : U.P('p.dl_days_before', x), selected: x === 3 });
          }));
          sel.style.width = 'auto';
          acts.push(sel, btn(T('p.dl_remind'), function () {
            api('POST', 'deadlines/' + d.id + '/remind', { daysBefore: Number(sel.value) }).then(function () { U.toast(T('p.dl_set')); after(); }, U.fail);
          }, { small: true, icon: 'bell' }));
        }
      }
      return h('div', { class: 'dp-k-dl' }, [
        h('div', { class: 'dp-k-dl-head' }, [
          h('span', { class: 'dp-k-tag is-' + d.kind, text: T('p.k.kind_' + d.kind) }),
          h('span', { class: 'dp-k-when', text: when + (past ? '' : ' · ' + inDays(d.date)) }),
          fresh ? h('span', { class: 'dp-k-new', text: T('p.k.new') }) : null,
        ]),
        h('span', { class: 'dp-name', text: title }),
        meta ? h('span', { class: 'dp-meta', text: meta }) : null,
        d.node ? h('button', { type: 'button', class: 'dp-linkish', text: d.node.name, attrs: { title: d.node.path || d.node.name }, on: { click: function () { U.openTarget(d.node.id, null); } } }) : null,
        acts.length ? h('div', { class: 'dp-actions dp-k-acts' }, acts) : null,
      ]);
    }

    // ── scans become documents (scanDocs) ───────────────

    function canConvert(n) {
      return has('scanDocs') && !n.isDir && !n.encrypted && !!n.mediaId && (SCAN_RE.test(String(n.mime || '')) || n.mime === 'application/pdf');
    }

    var FORMAT_LABEL = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel' };

    /** The formats for a scan of `kind`: PDF only for a JPEG (its pages), Excel only for a table. */
    function formatsOf(n, kind) {
      var out = [];
      if (n.mime === 'image/jpeg' && n.size <= IMAGES_MAX) out.push('pdf');
      out.push('docx');
      if (kind === 'table') out.push('xlsx');
      return out;
    }

    function bytesToBase64(buf) {
      var u = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    }
    function base64ToBlob(b64, mime) {
      var s = atob(b64);
      var u = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return new Blob([u], { type: mime });
    }

    /** The scan's picture for the document (a whiteboard's photo, a handwritten page, the PDF's pages) — ≤ 600 KB. */
    function pictureOf(n) {
      if (!SCAN_RE.test(String(n.mime || '')) || n.mime === 'image/webp' || n.mime === 'image/gif' || n.size > IMAGES_MAX) return Promise.resolve(null);
      if (!window.GC || typeof window.GC.mediaBytes !== 'function') return Promise.resolve(null);
      return api('GET', 'nodes/' + n.id + '/content').then(function (c) { return window.GC.mediaBytes(c.url, { start: 0, end: n.size - 1 }); })
        .then(function (x) { return x && x.data ? bytesToBase64(x.data) : null; }, function () { return null; });
    }

    /** "Scan prüfen" for file `n`. */
    function convert(n) {
      var cs = { kind: null, summary: '', target: null, results: {}, cost: 0, picture: undefined, folder: null, keep: !(S.meSettings && S.meSettings.scanKeepOriginal === false), name: null, busy: false };
      var body = h('div', { class: 'dp-k-scan' });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      U.dialog(T('p.k.scan_title'), [body, err], { wide: true, sub: n.name });
      body.appendChild(h('div', { class: 'dp-k-card is-quiet', attrs: { role: 'status' } }, [icon('spark'), h('span', { text: T('p.k.scan_reading') })]));
      api('POST', 'scans/classify', { nodeId: n.id }).then(function (r) {
        cs.kind = r.kind;
        cs.summary = r.summary || '';
        cs.cost += (r.usage && r.usage.costCents) || 0;
        var fs = formatsOf(n, r.kind);
        cs.target = r.kind === 'table' ? 'xlsx' : 'docx';
        if (fs.indexOf(cs.target) < 0) cs.target = fs[0];
        draw();
        load();
      }, function (e) { U.clear(body); err.textContent = U.errText(e); });

      function needsPicture(target) { return target === 'pdf' || (target === 'docx' && (cs.kind === 'whiteboard' || cs.kind === 'handwriting')); }

      function load() {
        var target = cs.target;
        if (cs.results[target]) { draw(); return; }
        cs.busy = true;
        draw();
        var pic = needsPicture(target) ? (cs.picture !== undefined ? Promise.resolve(cs.picture) : pictureOf(n).then(function (p) { cs.picture = p; return p; })) : Promise.resolve(null);
        pic.then(function (p) {
          var q = { nodeId: n.id, kind: cs.kind, target: target };
          if (p) q.images = [p];
          if (cs.folder) q.folderId = cs.folder.id;
          return api('POST', 'scans/convert', q);
        }).then(function (r) {
          cs.results[target] = r;
          cs.cost += (r.usage && r.usage.costCents) || 0;
          if (!cs.folder && r.folderId != null) cs.folder = { id: r.folderId, label: folderLabel(n, r.folderPath) };
          cs.busy = false;
          if (cs.target === target) { cs.name = r.name; draw(); }
        }, function (e) { cs.busy = false; draw(); err.textContent = U.errText(e); });
      }

      function folderLabel(node, path) {
        var a = U.areaOf(node.areaId);
        return [a ? a.label : ''].concat(path ? String(path).split('/') : []).join(' › ');
      }

      function draw() {
        U.clear(body);
        err.textContent = '';
        var fs = formatsOf(n, cs.kind);
        body.appendChild(h('div', { class: 'dp-k-found' }, [h('span', { class: 'dp-k-tag', text: T('p.k.found', { kind: T('p.k.scan_' + cs.kind) }) }),
          cs.summary ? h('span', { class: 'dp-meta', text: cs.summary }) : null]));
        body.appendChild(h('span', { class: 'dp-label', text: T('p.k.save_as_q', { format: FORMAT_LABEL[cs.target] }) }));
        body.appendChild(h('div', { class: 'dp-chips', attrs: { role: 'group', 'aria-label': T('p.k.format') } }, fs.map(function (f) {
          return h('button', { type: 'button', text: FORMAT_LABEL[f], attrs: { 'aria-pressed': String(cs.target === f) }, on: { click: function () { if (cs.target !== f) { cs.target = f; cs.name = cs.results[f] ? cs.results[f].name : null; load(); } } } });
        })));
        var r = cs.results[cs.target];
        body.appendChild(h('span', { class: 'dp-label', text: T('p.k.preview') }));
        body.appendChild(r ? preview(r) : h('div', { class: 'dp-k-card is-quiet' }, [icon('spark'), h('span', { text: T('p.k.scan_making') })]));
        body.appendChild(h('p', { class: 'dp-hint', text: T('p.k.hint_' + (cs.target === 'docx' && cs.kind === 'table' ? 'docx_table' : cs.target === 'docx' && cs.kind === 'whiteboard' ? 'docx_board' : cs.target)) }));
        var nameIn = h('input', { class: 'dp-input', type: 'text', value: cs.name || '', attrs: { 'aria-label': T('p.name'), maxlength: '255' }, on: { input: function (ev) { cs.name = ev.target.value; } } });
        body.appendChild(h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.name') }), nameIn]));
        body.appendChild(h('div', { class: 'dp-st-row' }, [h('span', { class: 'dp-dl-tx' }, [h('span', { class: 'dp-label', text: T('p.k.put_in') }),
          h('span', { class: 'dp-name', text: cs.folder ? cs.folder.label : T('p.k.no_folder') })]),
        btn(T('p.k.change'), function () {
          U.pickFolder(cs.folder ? { id: cs.folder.id, areaId: n.areaId, label: cs.folder.label } : null, function (x) { cs.folder = { id: x.id, label: x.label }; convert.reopen(); });
        }, { small: true, icon: 'folder' })]));
        var sw = h('input', { type: 'checkbox', class: 'dp-sw', checked: cs.keep, attrs: { role: 'switch', 'aria-label': T('p.k.keep') }, on: { change: function (ev) { cs.keep = !!ev.target.checked; } } });
        body.appendChild(h('label', { class: 'dp-set-row' }, [h('span', { class: 'dp-set-tx' }, [h('span', { class: 'dp-set-t', text: T('p.k.keep') })]), sw]));
        body.appendChild(h('p', { class: 'dp-hint dp-k-cost', text: costLine() }));
        body.appendChild(h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), U.closeDialog),
          btn(T('p.k.save_' + cs.target), save, { primary: true, disabled: !r || !r.file || cs.busy || !cs.folder, icon: 'download' })]));
      }
      // the folder picker took the dialog: back to "Scan prüfen" as it was
      convert.reopen = function () { U.dialog(T('p.k.scan_title'), [body, err], { wide: true, sub: n.name }); draw(); };

      function costLine() {
        var c = cs.cost;
        if (!c) return T('p.k.cost');
        var ct = c < 0.1 ? '< 0,1' : (Math.round(c * 10) / 10).toLocaleString(U.LOCALE);
        return T('p.k.cost_ct', { ct: ct });
      }

      function save() {
        var r = cs.results[cs.target];
        if (!r || !r.file || !cs.folder) return;
        if (!window.GC || typeof window.GC.upload !== 'function') { err.textContent = T('err.upload_unsupported'); return; }
        var name = String(cs.name || r.name).trim() || r.name;
        cs.busy = true;
        draw();
        window.GC.upload(base64ToBlob(r.file.data, r.file.mime), {}).then(function (up) {
          return api('POST', 'scans/save', { mediaId: up.mediaId, folderId: cs.folder.id, name: name, text: r.text || undefined, sourceId: n.id, keepOriginal: cs.keep });
        }).then(function (x) {
          U.closeDialog();
          U.toast(T('p.k.saved', { name: x.node.name }));
          U.reload();
        }, function (e) { cs.busy = false; draw(); err.textContent = U.errText(e); });
      }
    }

    /** The preview of a conversion: the first rows of a table, the start of a document, the PDF's text. */
    function preview(r) {
      var c = r.content || {};
      if (c.table) {
        var tb = c.table;
        var rows = tb.rows.slice(0, 4);
        var table = h('table', { class: 'dp-k-grid' }, [
          h('thead', null, h('tr', null, [h('th', { text: '' })].concat(tb.columns.map(function (col, i) { return h('th', { text: String.fromCharCode(65 + (i % 26)) }); })))),
          h('tbody', null, [h('tr', null, [h('th', { text: '1' })].concat(tb.columns.map(function (col) { return h('td', { class: 'is-head', text: col.name }); })))]
            .concat(rows.map(function (row, ri) { return h('tr', null, [h('th', { text: String(ri + 2) })].concat(row.map(function (v) { return h('td', { text: v }); }))); }))
            .concat(tb.rows.length > rows.length ? [h('tr', null, [h('th', { text: '…' })].concat(tb.columns.map(function () { return h('td', { text: '…' }); })))] : [])
            .concat(tb.total ? [h('tr', { class: 'is-total' }, [h('th', { text: String(tb.rows.length + 2) }), h('td', { attrs: { colspan: String(tb.columns.length) }, text: (tb.total.label || '') + ' · ' + T('p.k.formula') })])] : [])),
        ]);
        return h('div', { class: 'dp-k-prev' }, table);
      }
      if (c.blocks) {
        var out = [];
        if (r.title) out.push(h('b', { class: 'dp-k-ptitle', text: r.title }));
        c.blocks.slice(0, 10).forEach(function (b) {
          if (b.type === 'heading') out.push(h('b', { class: 'dp-k-ph', text: b.text }));
          else if (b.type === 'check') out.push(h('span', { class: 'dp-k-pl', text: (b.done ? '☑ ' : '☐ ') + b.text }));
          else if (b.type === 'bullet' || b.type === 'open') out.push(h('span', { class: 'dp-k-pl' + (b.type === 'open' ? ' is-open' : ''), text: '• ' + b.text }));
          else out.push(h('span', { class: 'dp-k-pp', text: b.text }));
        });
        if (c.blocks.length > 10) out.push(h('span', { class: 'dp-meta', text: '…' }));
        return h('div', { class: 'dp-k-prev is-doc' }, out);
      }
      return h('div', { class: 'dp-k-prev is-doc' }, h('span', { class: 'dp-k-pp', text: (c.text || r.text || '').slice(0, 600) }));
    }

    // ── photos by what is on them (photoSearch) ─────────

    /** Above the photos of a search: how many, the chips "+ Meer", the note where the words come from. */
    function photoSummary(search, onWord) {
      var box = h('div', { class: 'dp-k-phs' });
      box.appendChild(h('div', { class: 'dp-chips' }, (search.chips || []).map(function (c) {
        return h('button', { type: 'button', text: '+ ' + c.text, attrs: { title: U.P('p.photos_n', c.count) }, on: { click: function () { onWord(c.text); } } });
      }).concat([h('span', { class: 'dp-meta dp-k-total', text: U.P('p.photos_n', search.total || 0) })])));
      box.appendChild(h('p', { class: 'dp-hint' }, [h('b', { text: T('p.k.ph_device') }), document.createTextNode(' ' + T('p.k.ph_note'))]));
      return box;
    }

    return {
      isQuestion: isQuestion, typed: typed, ask: ask, chips: chips, mode: function (m) { if (m) st.mode = m; return st.mode; },
      showDeadlines: showDeadlines, calendarButton: calendarButton, targetRow: targetRow, canConvert: canConvert, convert: convert, photoSummary: photoSummary,
    };
  }

  window.DriveKi = { attach: attach };
}());
