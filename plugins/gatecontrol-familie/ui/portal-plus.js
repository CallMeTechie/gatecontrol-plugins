/* Portal tab "Familie" — the 1.2.0 sections, each shown only with its module
   on: pinboard & packing lists, meal plan, wishlists (all members; never the
   reservations on one's own wishes), pocket money (parents: every child, book,
   rule, approve converting stars; a child: its own account and "Umwandeln"),
   household book (parents), presence (everyone: own consent and who is home;
   parents: 1.5.0, the places of the place rules — ui/rules.js). Money is bookkeeping only. Same API as
   the app; a viewer recognised only by device trust reads and changes nothing
   (no presence at all). Rules and reminders (1.9.0) for everyone who may make some — 1.10.0 with the
   editor of the admin page „Anwesenheit & Smart Home“ (ui/rules.js, API rules/…). */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el, CTX = A.CTX;
  var ICON_PIN = 'M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6';
  var ICON_X = 'M6 6l12 12M18 6L6 18';
  var ICON_LINK = 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1';
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var writable = CTX.loggedIn === true;
  var me = null;

  function parent() { return me && me.me.role === 'parent'; }
  function memberById(id) { return (me.members || []).filter(function (m) { return m.userId === id; })[0] || null; }
  function nameOf(id) { var m = memberById(id); return m ? m.name : '–'; }
  function wd(n) { return new Date(2024, 0, n).toLocaleDateString(LOCALE, { weekday: 'long' }); } // 2024-01-01 = Monday
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function utc(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); }
  function addDays(s, n) { var d = utc(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  /** "YYYY-MM-DD" → "YYYY-Www" (ISO week, like the server). */
  function weekOf(s) {
    var d = utc(s);
    var wdn = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() + 3 - wdn);
    var y = d.getUTCFullYear();
    var jan4 = new Date(Date.UTC(y, 0, 4));
    var w1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
    return y + '-W' + pad(Math.floor((d.getTime() - w1.getTime() + 3 * 86400000) / (7 * 86400000)) + 1);
  }
  function members() { return (me.members || []).map(function (m) { return { value: String(m.userId), label: m.name }; }); }

  // ── pinboard & packing lists ─────────────────────────────────────────────
  var COLORS = ['yellow', 'green', 'blue', 'pink', 'grey'];
  var boardData = null;
  function loadBoard() { return A.api('GET', 'board').then(function (r) { boardData = r; renderBoard(); }).catch(A.warn); }
  function endOfDayIso(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59).toISOString() : null;
  }
  function editNote(n) {
    A.form(n ? T('board.note_edit') : T('board.note_add'), [
      { key: 'text', label: T('board.note_text'), type: 'textarea', max: 500, value: n ? n.text : '' },
      { key: 'color', label: T('board.color'), type: 'select', value: n ? n.color : 'yellow', options: COLORS.map(function (c) { return { value: c, label: T('board.color_' + c) }; }) },
      { key: 'pinned', label: T('board.pinned'), type: 'checkbox', value: n ? n.pinned : false },
      { key: 'expires', label: T('board.expires'), type: 'date', value: n && n.expiresAt ? n.expiresAt.slice(0, 10) : '', hint: T('board.expires_hint') },
    ], {
      check: function (v) { return v.text.trim() ? null : T('board.text_required'); },
      submit: function (v) {
        var body = { text: v.text, color: v.color, pinned: v.pinned, expiresAt: endOfDayIso(v.expires) };
        return (n ? A.api('PATCH', 'board/notes/' + n.id, body) : A.api('POST', 'board/notes', body)).then(loadBoard);
      },
      onDelete: n && (n.authorId === me.me.userId || parent()) ? function () { A.api('DELETE', 'board/notes/' + n.id).then(loadBoard).catch(A.warn); } : null,
    });
  }
  function renderBoard() {
    var box = A.clear($('#fa-notes'));
    boardData.notes.forEach(function (n) {
      var card = el('div', { class: 'fa-bnote is-' + n.color }, [
        n.pinned ? el('span', { class: 'fa-bnote-pin', title: T('board.pinned') }, [A.svg(ICON_PIN, 14)]) : null,
        el('div', { class: 'fa-bnote-text', text: n.text }),
        el('div', { class: 'fa-sub', text: nameOf(n.authorId) + ' · ' + A.when(n.createdAt) + (n.expiresAt ? ' · ' + T('board.until', { date: A.day(n.expiresAt.slice(0, 10)) }) : '') }),
      ]);
      if (writable) { card.tabIndex = 0; card.setAttribute('role', 'button'); card.addEventListener('click', function () { editNote(n); }); }
      box.appendChild(card);
    });
    if (!boardData.notes.length) box.appendChild(el('p', { class: 'fa-empty', text: T('board.notes_none') }));
    var lists = A.clear($('#fa-checklists'));
    boardData.checklists.forEach(function (c) { lists.appendChild(checklist(c)); });
    if (!boardData.checklists.length) lists.appendChild(el('p', { class: 'fa-empty', text: T('board.checklists_none') }));
    if (boardData.templates.length) {
      lists.appendChild(el('div', { class: 'fa-p-chips' }, [el('span', { class: 'fa-sub', text: T('board.templates') })].concat(boardData.templates.map(function (t) {
        var mayDel = writable && (t.createdBy === me.me.userId || parent());
        return el('span', { class: 'fa-pill' }, [t.title + ' (' + t.items.length + ')', mayDel ? el('button', { type: 'button', class: 'btn fa-p-x', 'aria-label': T('board.template_delete', { title: t.title }), on: { click: function () {
          A.confirm(T('board.template_delete', { title: t.title }), T('common.delete'), true).then(function (ok) { if (ok) A.api('DELETE', 'board/templates/' + t.id).then(loadBoard).catch(A.warn); });
        } } }, [A.svg(ICON_X, 12)]) : null]);
      }))));
    }
  }
  function checklist(c) {
    var base = 'board/checklists/' + c.id;
    var ul = el('ul', { class: 'fa-p-items' });
    c.items.forEach(function (i) {
      var cb = el('input', { type: 'checkbox', checked: i.done, 'aria-label': i.text, disabled: !writable });
      cb.addEventListener('change', function () { A.api('PATCH', base + '/items/' + i.id, { done: cb.checked }).then(loadBoard).catch(A.warn); });
      ul.appendChild(el('li', { class: 'fa-p-item' + (i.done ? ' is-checked' : '') }, [cb, el('span', { class: 'fa-p-item-text', text: i.text }),
        el('span', { class: 'fa-p-item-qty', text: i.done && i.doneBy ? nameOf(i.doneBy) : '' }),
        writable ? el('button', { type: 'button', class: 'btn fa-p-x', 'aria-label': T('portal.item_delete', { name: i.text }), on: { click: function () { A.api('DELETE', base + '/items/' + i.id).then(loadBoard).catch(A.warn); } } }, [A.svg(ICON_X, 14)]) : null]));
    });
    var input = el('input', { class: 'form-input', type: 'text', maxlength: '80', placeholder: T('board.item_add'), 'aria-label': T('board.item_add') });
    var add = el('form', { class: 'fa-p-add', autocomplete: 'off' }, [input, el('button', { class: 'btn btn-primary', type: 'submit', 'aria-label': T('board.item_add'), text: '+' })]);
    add.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = input.value.trim();
      if (!t) return;
      A.api('POST', base + '/items', { text: t.slice(0, 80) }).then(loadBoard).catch(A.warn);
    });
    var btns = writable ? el('div', { class: 'fa-p-foot' }, [
      el('button', { type: 'button', class: 'btn btn-sm', text: T('board.reset'), on: { click: function () { A.api('POST', base + '/reset').then(loadBoard).catch(A.warn); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('board.as_template'), on: { click: function () {
        A.api('POST', 'board/templates', { checklistId: c.id }).then(function () { A.toast(T('board.template_saved')); return loadBoard(); }).catch(A.warn);
      } } }),
      c.createdBy === me.me.userId || parent() ? el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('common.delete'), on: { click: function () {
        A.confirm(T('board.checklist_delete', { title: c.title }), T('common.delete'), true).then(function (ok) { if (ok) A.api('DELETE', base).then(loadBoard).catch(A.warn); });
      } } }) : null,
    ]) : null;
    return el('details', { class: 'fa-checklist', open: c.open > 0 }, [
      el('summary', null, [el('b', { text: c.title }), el('span', { class: 'fa-sub', text: ' · ' + T('board.open', { n: c.open, total: c.items.length }) })]),
      ul, writable ? add : null, btns,
    ]);
  }
  $('#fa-note-add').addEventListener('click', function () { editNote(null); });
  $('#fa-list-add').addEventListener('click', function () {
    var opts = [{ value: '', label: T('board.no_template') }].concat((boardData ? boardData.templates : []).map(function (t) { return { value: String(t.id), label: t.title }; }));
    A.form(T('board.checklist_add'), [
      { key: 'templateId', label: T('board.from_template'), type: 'select', value: '', options: opts },
      { key: 'title', label: T('board.checklist_title'), max: 60, value: '', hint: T('board.title_hint') },
    ], {
      check: function (v) { return v.templateId || v.title.trim() ? null : T('portal.title_required'); },
      submit: function (v) {
        var body = v.templateId ? { templateId: parseInt(v.templateId, 10) } : { title: v.title.trim() };
        if (v.templateId && v.title.trim()) body.title = v.title.trim();
        return A.api('POST', 'board/checklists', body).then(loadBoard);
      },
    });
  });

  // ── meal plan ────────────────────────────────────────────────────────────
  var mealWeek = null;
  var mealData = null;
  var shopLists = null;
  function loadMeals() {
    return A.api('GET', 'meals' + (mealWeek ? '?week=' + mealWeek : '')).then(function (r) { mealData = r; mealWeek = r.week; renderMeals(); }).catch(A.warn);
  }
  function editMeal(day, slot) {
    var m = day[slot];
    A.form(T('meal.' + slot) + ' · ' + A.day(day.date), [
      { key: 'title', label: T('meals.dish'), max: 60, value: m ? m.title : '' },
      { key: 'cook', label: T('meals.cook'), type: 'select', value: m && m.cook != null ? String(m.cook) : '', options: [{ value: '', label: '–' }].concat(members()) },
      { key: 'ingredients', label: T('meals.ingredients'), type: 'textarea', value: m ? m.ingredients.join('\n') : '', hint: T('meals.ingredients_hint') },
      { key: 'note', label: T('meals.note'), type: 'textarea', max: 200, value: m ? m.note : '' },
    ], {
      check: function (v) { return v.title.trim() ? null : T('portal.title_required'); },
      submit: function (v) {
        var ing = v.ingredients.split('\n').map(function (x) { return x.trim().slice(0, 60); }).filter(Boolean).slice(0, 40);
        return A.api('PUT', 'meals/' + day.date + '/' + slot, { title: v.title.trim(), note: v.note, cook: v.cook ? parseInt(v.cook, 10) : null, ingredients: ing }).then(loadMeals);
      },
      onDelete: m ? function () { A.api('DELETE', 'meals/' + day.date + '/' + slot).then(loadMeals).catch(A.warn); } : null,
    });
  }
  function toShopping(day, slot) {
    var go = function () {
      if (!shopLists.length) { A.toast(T('portal.lists_none'), 'error'); return; }
      A.form(T('meals.to_shopping'), [
        { key: 'listId', label: T('portal.list_choose'), type: 'select', value: shopLists[0].id, options: shopLists.map(function (l) { return { value: l.id, label: l.name }; }) },
      ], {
        okLabel: T('meals.to_shopping'),
        submit: function (v) {
          return A.api('POST', 'meals/' + day.date + '/' + slot + '/to-shopping', { listId: v.listId }).then(function (r) { A.toast(T('meals.added', { n: r.added, skipped: r.skipped })); });
        },
      });
    };
    if (shopLists) go();
    else A.api('GET', 'shopping').then(function (r) { shopLists = r.lists; go(); }).catch(A.warn);
  }
  function renderMeals() {
    $('#fa-meals-week').textContent = A.day(mealData.days[0].date, { day: '2-digit', month: '2-digit' }) + ' – ' + A.day(mealData.days[6].date, { day: '2-digit', month: '2-digit' });
    var box = A.clear($('#fa-meal-days'));
    mealData.days.forEach(function (d) {
      var cells = ['lunch', 'dinner'].map(function (slot) {
        var m = d[slot];
        var cell = el('div', { class: 'fa-meal' + (m ? '' : ' is-empty') }, [
          el('span', { class: 'fa-sub', text: T('meal.' + slot) }),
          el('b', { text: m ? m.title : '–' }),
          m && m.cook != null ? el('span', { class: 'fa-sub', text: T('meal.cook_by', { name: nameOf(m.cook) }) }) : null,
        ]);
        if (writable) {
          cell.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: m ? T('common.edit') : T('meals.plan'), on: { click: function () { editMeal(d, slot); } } }));
          if (m && m.ingredients.length && me.modules.shopping) cell.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('meals.to_shopping'), on: { click: function () { toShopping(d, slot); } } }));
        }
        return cell;
      });
      box.appendChild(el('div', { class: 'fa-meal-day' + (d.date === A.todayStr() ? ' is-today' : '') }, [el('span', { class: 'fa-p-date-when', text: A.day(d.date) })].concat(cells)));
    });
  }
  $('#fa-meals-prev').addEventListener('click', function () { if (mealData) { mealWeek = weekOf(addDays(mealData.days[0].date, -7)); loadMeals(); } });
  $('#fa-meals-next').addEventListener('click', function () { if (mealData) { mealWeek = weekOf(addDays(mealData.days[0].date, 7)); loadMeals(); } });

  // ── wishlists ────────────────────────────────────────────────────────────
  var OCC = ['birthday', 'christmas', 'other'];
  var wishData = null;
  var wishOwner = null;
  function mayEditList(ownerId) {
    if (ownerId === me.me.userId) return true;
    var o = memberById(ownerId);
    return parent() && o && o.role === 'child';
  }
  function loadWishes() {
    return A.api('GET', 'wishes').then(function (r) {
      wishData = r;
      if (wishOwner == null || !r.lists.some(function (l) { return l.ownerId === wishOwner; })) wishOwner = me.me.userId;
      renderWishes();
    }).catch(A.warn);
  }
  function editWish(w, ownerId) {
    A.form(w ? T('wishes.edit') : T('wishes.add'), [
      { key: 'title', label: T('wishes.what'), max: 80, value: w ? w.title : '' },
      { key: 'url', label: T('wishes.url'), type: 'url', max: 300, value: w && w.url ? w.url : '', hint: T('wishes.url_hint') },
      { key: 'price', label: T('wishes.price'), type: 'money', value: w && w.priceCents != null ? w.priceCents : '' },
      { key: 'occasion', label: T('wishes.occasion'), type: 'select', value: w && w.occasion ? w.occasion : '', options: [{ value: '', label: '–' }].concat(OCC.map(function (o) { return { value: o, label: T('wishes.occ_' + o) }; })) },
      { key: 'note', label: T('wishes.note'), type: 'textarea', max: 200, value: w ? w.note : '' },
    ].concat(w ? [{ key: 'gotIt', label: T('wishes.got_it'), type: 'checkbox', value: w.gotIt, hint: T('wishes.got_it_hint') }] : []), {
      check: function (v) {
        if (!v.title.trim()) return T('portal.title_required');
        if (v.url && !/^https:\/\//i.test(v.url.trim())) return T('wishes.url_hint');
        if (Number.isNaN(v.price) || v.price < 0) return T('money.invalid');
        return null;
      },
      submit: function (v) {
        var body = { title: v.title.trim(), url: v.url.trim() || null, priceCents: v.price, occasion: v.occasion || null, note: v.note };
        if (w) body.gotIt = v.gotIt;
        else if (ownerId !== me.me.userId) body.ownerId = ownerId;
        return (w ? A.api('PATCH', 'wishes/' + w.id, body) : A.api('POST', 'wishes', body)).then(loadWishes);
      },
      onDelete: w ? function () { A.api('DELETE', 'wishes/' + w.id).then(loadWishes).catch(A.warn); } : null,
    });
  }
  function renderWishes() {
    var chips = A.clear($('#fa-wish-chips'));
    wishData.lists.forEach(function (l) {
      var b = el('button', { type: 'button', class: 'btn btn-sm fa-p-chip', role: 'tab', 'aria-selected': l.ownerId === wishOwner ? 'true' : 'false',
        text: (l.ownerId === me.me.userId ? T('wishes.mine') : l.name) + ' (' + l.items.length + ')' });
      b.addEventListener('click', function () { wishOwner = l.ownerId; renderWishes(); });
      chips.appendChild(b);
    });
    var list = wishData.lists.filter(function (l) { return l.ownerId === wishOwner; })[0];
    var own = wishOwner === me.me.userId;
    var editable = writable && mayEditList(wishOwner);
    $('#fa-wish-add').hidden = !editable;
    $('#fa-wish-hint').textContent = own ? T('wishes.surprise') : '';
    var box = A.clear($('#fa-wish-list'));
    (list ? list.items : []).forEach(function (w) {
      var sub = [];
      if (w.priceCents != null) sub.push(T('wishes.about', { money: A.money(w.priceCents) }));
      if (w.occasion) sub.push(T('wishes.occ_' + w.occasion));
      if (w.note) sub.push(w.note);
      var right = [];
      if (!own) {
        if (w.reservedByMe) {
          right.push(el('span', { class: 'fa-pill', text: T('wishes.you_get_it') }));
          if (writable) right.push(el('button', { type: 'button', class: 'btn btn-sm', text: T('wishes.unreserve'), on: { click: function () { A.api('POST', 'wishes/' + w.id + '/unreserve').then(loadWishes).catch(A.warn); } } }));
        } else if (w.reservedBy != null) right.push(el('span', { class: 'fa-pill is-off', text: T('wishes.reserved_by', { name: nameOf(w.reservedBy) }) }));
        else if (writable) right.push(el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('wishes.reserve'), on: { click: function () { A.api('POST', 'wishes/' + w.id + '/reserve').then(loadWishes).catch(A.warn); } } }));
      }
      if (editable) right.push(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: T('common.edit'), on: { click: function () { editWish(w, wishOwner); } } }));
      box.appendChild(el('div', { class: 'fa-wish' }, [
        el('div', { class: 'fa-p-task-main' }, [el('div', { class: 'fa-p-task-title', text: w.title }), sub.length ? el('div', { class: 'fa-p-task-sub', text: sub.join(' · ') }) : null]),
        w.url ? el('a', { class: 'btn btn-sm btn-ghost', href: w.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': T('wishes.open_link', { title: w.title }) }, [A.svg(ICON_LINK, 14)]) : null,
      ].concat(right)));
    });
    if (!list || !list.items.length) box.appendChild(el('p', { class: 'fa-empty', text: T('wishes.none') }));
  }
  $('#fa-wish-add').addEventListener('click', function () { editWish(null, wishOwner); });

  // ── pocket money ─────────────────────────────────────────────────────────
  var accounts = null;
  function loadAllowance() { return A.api('GET', 'allowance').then(function (r) { accounts = r.accounts; renderAllowance(); }).catch(A.warn); }
  function book(a) {
    A.form(T('allowance.book', { name: a.name }), [
      { key: 'kind', label: T('allowance.kind'), type: 'select', value: 'manual', options: [{ value: 'manual', label: T('allowance.kind_manual') }, { value: 'spend', label: T('allowance.kind_spend') }] },
      { key: 'cents', label: T('allowance.amount'), type: 'money', value: '', hint: T('allowance.amount_hint') },
      { key: 'note', label: T('allowance.note'), max: 80, value: '' },
    ], {
      check: function (v) { return v.cents ? null : T('money.invalid'); },
      submit: function (v) { return A.api('POST', 'allowance/' + a.childId + '/bookings', { kind: v.kind, cents: v.cents, note: v.note.trim() }).then(loadAllowance); },
    });
  }
  function ruleForm(a) {
    var r = a.rule;
    A.form(T('allowance.rule', { name: a.name }), [
      { key: 'active', label: T('allowance.active'), type: 'checkbox', value: r.active },
      { key: 'amount', label: T('allowance.amount'), type: 'money', value: r.amountCents },
      { key: 'interval', label: T('allowance.interval'), type: 'select', value: r.interval, options: [{ value: 'weekly', label: T('allowance.weekly') }, { value: 'monthly', label: T('allowance.monthly') }] },
      { key: 'weekday', label: T('allowance.weekday'), type: 'select', value: String(r.weekday || 6), options: [1, 2, 3, 4, 5, 6, 7].map(function (n) { return { value: String(n), label: wd(n) }; }), show: function (v) { return v.interval === 'weekly'; } },
      { key: 'day', label: T('allowance.day_of_month'), type: 'number', min: 1, maxValue: 28, value: r.dayOfMonth || 1, show: function (v) { return v.interval === 'monthly'; } },
      { key: 'stars', label: T('allowance.star_stars'), type: 'number', min: 0, maxValue: 1000, value: a.starRate ? a.starRate.stars : '', hint: T('allowance.star_hint') },
      { key: 'starMoney', label: T('allowance.star_money'), type: 'money', value: a.starRate ? a.starRate.cents : '' },
    ], {
      check: function (v) {
        if (!(v.amount >= 0)) return T('money.invalid');
        if (v.interval === 'monthly' && !(v.day >= 1 && v.day <= 28)) return T('allowance.day_invalid');
        if (v.stars && !(v.starMoney > 0)) return T('money.invalid');
        return null;
      },
      submit: function (v) {
        var body = { active: v.active, amountCents: v.amount, interval: v.interval, starRate: v.stars ? { stars: v.stars, cents: v.starMoney } : null };
        if (v.interval === 'weekly') body.weekday = parseInt(v.weekday, 10); else body.dayOfMonth = v.day;
        return A.api('PUT', 'allowance/' + a.childId + '/rule', body).then(loadAllowance);
      },
    });
  }
  function convert(a) {
    var step = a.starRate.stars;
    var max = Math.floor(a.stars.convertible / step) * step;
    A.form(T('allowance.convert'), [
      { key: 'stars', label: T('allowance.convert_stars', { step: step }), type: 'number', min: step, step: step, maxValue: max, value: max },
    ], {
      okLabel: T('allowance.convert'),
      check: function (v) { return v.stars >= step && v.stars <= max && v.stars % step === 0 ? null : T('allowance.convert_invalid', { step: step, max: max }); },
      submit: function (v) { return A.api('POST', 'allowance/' + a.childId + '/convert', { stars: v.stars }).then(function () { A.toast(T('allowance.convert_sent')); return loadAllowance(); }); },
    });
  }
  function decide(q, ok) {
    A.api('POST', 'allowance/requests/' + q.id + '/' + (ok ? 'approve' : 'decline')).then(loadAllowance).catch(A.warn);
  }
  function renderAllowance() {
    var box = A.clear($('#fa-accounts'));
    accounts.forEach(function (a) {
      var next = a.nextPayout ? T('allowance.next', { day: A.day(a.nextPayout, { weekday: 'long' }), money: A.money(a.rule.amountCents) }) : T('allowance.no_rule');
      var stars = a.starRate ? T('allowance.stars_rate', { n: a.stars.convertible, stars: a.starRate.stars, money: A.money(a.starRate.cents) }) : T('allowance.stars_n', { n: a.stars.convertible });
      var card = el('div', { class: 'fa-account' }, [
        el('div', { class: 'fa-card-head' }, [A.avatar(memberById(a.childId) || { name: a.name }), el('b', { style: 'flex:1', text: a.childId === me.me.userId ? T('allowance.mine') : a.name }),
          el('span', { class: 'fa-balance' + (a.balanceCents < 0 ? ' fa-bad' : ''), text: A.money(a.balanceCents) })]),
        el('div', { class: 'fa-sub', text: next }),
        el('div', { class: 'fa-sub', text: '★ ' + stars + (a.stars.pending ? ' · ' + T('allowance.pending', { n: a.stars.pending }) : '') }),
      ]);
      var btns = [];
      if (writable && parent()) {
        btns.push(el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('allowance.book_short'), on: { click: function () { book(a); } } }));
        btns.push(el('button', { type: 'button', class: 'btn btn-sm', text: T('allowance.rule_short'), on: { click: function () { ruleForm(a); } } }));
      }
      if (writable && a.childId === me.me.userId && a.starRate && a.stars.convertible >= a.starRate.stars) {
        btns.push(el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('allowance.convert'), on: { click: function () { convert(a); } } }));
      }
      if (a.childId === me.me.userId && a.starRate) card.appendChild(el('p', { class: 'fa-hint', text: T('allowance.parents_confirm') }));
      if (btns.length) card.appendChild(el('div', { class: 'fa-p-foot' }, btns));
      a.requests.filter(function (q) { return q.status === 'pending'; }).forEach(function (q) {
        card.appendChild(el('div', { class: 'fa-p-ride is-open' }, [
          el('div', { class: 'fa-p-ride-main', text: T('allowance.request', { stars: q.stars, money: A.money(q.cents), when: A.when(q.createdAt) }) }),
          writable && parent() ? el('div', { class: 'fa-p-ride-btns' }, [
            el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('allowance.approve'), on: { click: function () { decide(q, true); } } }),
            el('button', { type: 'button', class: 'btn btn-sm', text: T('allowance.decline'), on: { click: function () { decide(q, false); } } }),
          ]) : el('span', { class: 'fa-pill is-off', text: T('allowance.waiting') }),
        ]));
      });
      var ul = el('ul', { class: 'fa-p-items' });
      a.bookings.slice(0, 8).forEach(function (b) {
        ul.appendChild(el('li', { class: 'fa-p-item' }, [
          el('span', { class: 'fa-p-item-text', text: (b.note || T('allowance.kind_' + b.kind)) }),
          el('span', { class: 'fa-p-item-qty', text: A.when(b.at) }),
          el('b', { class: b.cents < 0 ? 'fa-bad' : 'fa-ok', text: (b.cents > 0 ? '+ ' : '') + A.money(b.cents) }),
          writable && parent() && (b.kind === 'manual' || b.kind === 'spend') ? el('button', { type: 'button', class: 'btn fa-p-x', 'aria-label': T('allowance.booking_delete'), on: { click: function () {
            A.confirm(T('allowance.booking_delete'), T('common.delete'), true).then(function (ok) { if (ok) A.api('DELETE', 'allowance/' + a.childId + '/bookings/' + b.id).then(loadAllowance).catch(A.warn); });
          } } }, [A.svg(ICON_X, 14)]) : null,
        ]));
      });
      card.appendChild(a.bookings.length ? ul : el('p', { class: 'fa-empty', text: T('allowance.bookings_none') }));
      box.appendChild(card);
    });
    if (!accounts.length) box.appendChild(el('p', { class: 'fa-empty', text: T('allowance.no_children') }));
  }

  // ── household book (parents) ─────────────────────────────────────────────
  var CATS = ['food', 'kids', 'household', 'leisure', 'mobility', 'other'];
  var expMonth = null;
  var expData = null;
  function loadExpenses() {
    return A.api('GET', 'expenses' + (expMonth ? '?month=' + expMonth : '')).then(function (r) { expData = r; expMonth = r.month; renderExpenses(); }).catch(A.warn);
  }
  function shiftMonth(m, n) {
    var y = parseInt(m.slice(0, 4), 10);
    var mo = parseInt(m.slice(5, 7), 10) - 1 + n;
    y += Math.floor(mo / 12);
    mo = ((mo % 12) + 12) % 12;
    return y + '-' + pad(mo + 1);
  }
  function editExpense(x) {
    var parents = (me.members || []).filter(function (m) { return m.role === 'parent'; }).map(function (m) { return { value: String(m.userId), label: m.name }; });
    A.form(x ? T('expenses.edit') : T('expenses.add'), [
      { key: 'cents', label: T('expenses.amount'), type: 'money', value: x ? x.cents : '' },
      { key: 'category', label: T('expenses.category'), type: 'select', value: x ? x.category : 'food', options: CATS.map(function (c) { return { value: c, label: T('expenses.cat_' + c) }; }) },
      { key: 'paidBy', label: T('expenses.paid_by'), type: 'select', value: String(x ? x.paidBy : me.me.userId), options: parents },
      { key: 'date', label: T('expenses.date'), type: 'date', value: x ? x.date : A.todayStr() },
      { key: 'note', label: T('expenses.note'), max: 80, value: x ? x.note : '' },
      { key: 'shared', label: T('expenses.shared'), type: 'checkbox', value: x ? x.shared : true, hint: T('expenses.shared_hint') },
    ], {
      check: function (v) { return v.cents > 0 ? null : T('money.invalid'); },
      submit: function (v) {
        var body = { cents: v.cents, category: v.category, paidBy: parseInt(v.paidBy, 10), date: v.date || A.todayStr(), note: v.note.trim(), shared: v.shared };
        return (x ? A.api('PATCH', 'expenses/' + x.id, body) : A.api('POST', 'expenses', body)).then(loadExpenses);
      },
      onDelete: x ? function () { A.api('DELETE', 'expenses/' + x.id).then(loadExpenses).catch(A.warn); } : null,
    });
  }
  function renderExpenses() {
    var d = expData;
    $('#fa-exp-month').textContent = new Date(+d.month.slice(0, 4), +d.month.slice(5, 7) - 1, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
    var box = A.clear($('#fa-exp-body'));
    box.appendChild(el('div', { class: 'fa-exp-total' }, [el('b', { text: A.money(d.totals.shared) }), el('span', { class: 'fa-sub', text: ' ' + T('expenses.shared_total') + (d.totals.all !== d.totals.shared ? ' · ' + T('expenses.all_total', { money: A.money(d.totals.all) }) : '') })]));
    var max = Math.max.apply(null, CATS.map(function (c) { return d.totals.byCategory[c] || 0; }).concat([1]));
    CATS.filter(function (c) { return d.totals.byCategory[c]; }).forEach(function (c) {
      var bar = el('span', { class: 'fa-bar' });
      bar.style.width = Math.max(4, Math.round((d.totals.byCategory[c] / max) * 100)) + '%';
      box.appendChild(el('div', { class: 'fa-cat' }, [el('span', { class: 'fa-cat-name', text: T('expenses.cat_' + c) }), el('span', { class: 'fa-cat-bar' }, [bar]), el('span', { class: 'fa-cat-sum', text: A.money(d.totals.byCategory[c]) })]));
    });
    var settle = el('div', { class: 'fa-settle' + (d.settled ? ' is-done' : '') });
    if (d.transfers.length) {
      d.transfers.forEach(function (t) { settle.appendChild(el('b', { text: T('expenses.transfer', { from: nameOf(t.from), to: nameOf(t.to), money: A.money(t.cents) }) })); });
    } else settle.appendChild(el('b', { text: T('expenses.even') }));
    settle.appendChild(el('span', { class: 'fa-sub', text: d.settled ? T('expenses.settled_at', { when: A.when(d.settledAt), name: nameOf(d.settledBy) }) : T('expenses.record_only') }));
    if (writable) {
      settle.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (d.settled ? '' : ' btn-primary'), text: d.settled ? T('expenses.unsettle') : T('expenses.settle'), on: { click: function () {
        A.api('POST', 'expenses/' + (d.settled ? 'unsettle' : 'settle'), { month: d.month }).then(function (r) { expData = r; renderExpenses(); }).catch(A.warn);
      } } }));
    }
    box.appendChild(settle);
    var ul = el('div', { class: 'fa-p-rides' });
    d.expenses.forEach(function (x) {
      var row = el('div', { class: 'fa-p-ride' }, [
        A.avatar(memberById(x.paidBy) || { name: '?' }),
        el('div', { class: 'fa-p-ride-main' }, [el('div', { class: 'fa-p-task-title', text: x.note || T('expenses.cat_' + x.category) }),
          el('div', { class: 'fa-p-task-sub', text: [A.day(x.date), T('expenses.cat_' + x.category), x.shared ? '' : T('expenses.private'), x.listId ? T('expenses.from_list') : ''].filter(Boolean).join(' · ') })]),
        el('b', { text: A.money(x.cents) }),
      ]);
      if (writable) row.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: T('common.edit'), on: { click: function () { editExpense(x); } } }));
      ul.appendChild(row);
    });
    if (!d.expenses.length) ul.appendChild(el('p', { class: 'fa-empty', text: T('expenses.none') }));
    box.appendChild(ul);
  }
  $('#fa-exp-add').addEventListener('click', function () { editExpense(null); });
  $('#fa-exp-prev').addEventListener('click', function () { if (expMonth) { expMonth = shiftMonth(expMonth, -1); loadExpenses(); } });
  $('#fa-exp-next').addEventListener('click', function () { if (expMonth) { expMonth = shiftMonth(expMonth, 1); loadExpenses(); } });

  // ── presence ─────────────────────────────────────────────────────────────
  // who is home for everyone; the places of the place rules for parents (the rules: below)
  var presData = null;
  var placeOpts = { base: 'presence', editable: writable, reload: function () { loadPresence(); loadRules(); } };
  function loadPresence() {
    return A.api('GET', 'presence').then(function (r) {
      presData = { members: r.members, me: r.me };
      var share = A.clear($('#fa-pres-share'));
      share.appendChild(A.switchBtn(r.me.share, T('presence.share'), function (on, b) {
        A.api('PUT', 'presence/consent', { share: on }).then(function () { A.toast(on ? T('presence.shared_on') : T('presence.shared_off')); return loadPresence(); }).catch(function (e) { A.setSwitch(b, !on); A.warn(e); });
      }, !writable));
      A.rules.people($('#fa-pres-people'), r.members);
      if (!parent()) return null;
      $('#fa-pres-rules-box').hidden = false;
      return A.api('GET', 'presence/places').then(function (x) {
        presData.places = x.places;
        presData.home = x.home;
        A.rules.places($('#fa-pres-places'), presData, placeOpts);
        $('#fa-pres-place-add').disabled = presData.places.length >= A.rules.MAX_PLACES;
      });
    }).catch(A.warn);
  }
  $('#fa-pres-place-add').addEventListener('click', function () { if (presData && presData.places) A.rules.editPlace(null, presData, placeOpts, placeOpts.reload); });

  // ── rules and reminders (1.10.0: one editor, ui/rules.js, through the rules API) ──
  var rulesData = null;
  var rulesOpts = { base: 'presence', rulesBase: 'rules', editable: writable, managePlaces: false, filter: 'all', reload: function () { return loadRules(); } };
  function loadRules() {
    return Promise.all([A.api('GET', 'rules'), A.api('GET', 'rules/options')]).then(function (x) {
      var rr = x[0], o = x[1];
      var isParent = parent();
      rulesOpts.managePlaces = isParent;
      rulesData = {
        rules: rr.rules.map(A.rules.flat), log: rr.log, can: rr.can,
        options: o, actions: o.actions, actionsAvailable: o.actionsAvailable, messenger: o.messenger,
        // the places of the place triggers: parents manage them (presence/places), the others pick from the options
        places: isParent && presData && presData.places ? presData.places : o.places, home: presData ? presData.home : null,
        location: o.location ? true : null,
      };
      // children without their own rules (and without the setting) see nothing of it
      $('#fa-rules').hidden = !(rr.can.house || rr.can.personal || rr.rules.length);
      $('#fa-rules-add').hidden = !(rr.can.house || rr.can.personal);
      A.rules.render($('#fa-rules-box'), rulesData, rulesOpts);
      A.rules.log($('#fa-rules-log'), rulesData);
    }).catch(function (e) { $('#fa-rules').hidden = true; if (!e || e.code !== 'login_required') A.warn(e); });
  }
  $('#fa-rules-add').addEventListener('click', function () { if (rulesData) A.rules.edit(null, rulesData, rulesOpts); });

  // ── start ────────────────────────────────────────────────────────────────
  A.api('GET', 'me').then(function (r) {
    me = r;
    var mod = r.modules;
    var show = function (id, on) { $(id).hidden = !on; };
    show('#fa-board', mod.board);
    show('#fa-meals', mod.meals);
    show('#fa-wishes', mod.wishes);
    show('#fa-allowance', mod.allowance && (r.me.role === 'parent' || r.me.role === 'child'));
    show('#fa-expenses', mod.expenses && r.me.role === 'parent');
    show('#fa-presence', mod.presence && writable);
    if (!writable) A.$$('.fa-write').forEach(function (n) { n.hidden = true; });
    if (mod.board) loadBoard();
    if (mod.meals) loadMeals();
    if (mod.wishes) loadWishes();
    if (mod.allowance) loadAllowance();
    if (mod.expenses && r.me.role === 'parent') loadExpenses();
    if (mod.presence && writable) loadPresence();
    if (mod.rules && writable) loadRules();
    setInterval(function () {
      if (mod.board) loadBoard();
      if (mod.presence && writable) loadPresence();
    }, 60000);
  }).catch(function () { /* portal.js shows the banner */ });
}());
