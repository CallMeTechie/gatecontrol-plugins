/* Mail (gatecontrol-mail) — the area Kontakte of the portal tab (since 1.3.0, mockups Kontakte, Kontakt,
 * KontaktBearbeiten, MenueNeu): window.MailContacts.attach(ui) → { nav, show, onEvent, openCard, newFrom, fromSender }.
 *
 *   menu      „Alle Kontakte“, the address books with a tick (shown) and their number, the groups, „Dubletten“
 *   list      search (name, company, address, number), the tabs Kontakte | Gruppen, letters with a quick bar, a row:
 *             picture or initials, name, company or first address, the account's dot; „Neuer Kontakt“; import (vCard)
 *             and export, how names are sorted and shown
 *   contact   picture, name, position · company, Mail / Anrufen / Bearbeiten, the fields, groups, where it comes from
 *             (linked ones too), „Letzte Mails“ („Alle Mails“ → the search), „Gemeinsame Termine“; read only → a note
 *   edit      picture (made 512 px JPEG here), names, company, position, addresses and numbers with their kind,
 *             postal addresses, birthday (year optional), note, groups, address book (new ones); saved with the etag,
 *             409 conflict → „Neu laden“ / „Meine Änderung erneut anwenden“
 *   groups    members, „Mail an alle“, add (contacts or addresses) and remove, rename, delete
 *   doubles   the pairs with their reason, „Zusammenführen“ (a preview with a choice per field; different address books
 *             are linked, both stay at the provider), „Keine Dublette“
 */
(function () {
  'use strict';

  var SCOPE = 'Contacts.ReadWrite';
  var COLORS = ['#46E0A0', '#79B8FF', '#F5B544', '#B79CFF', '#FF8080', '#5FD3E0', '#F28FD0', '#A6E36B'];
  var EMAIL_TYPES = ['work', 'home', 'other'];
  var PHONE_TYPES = ['mobile', 'work', 'home', 'fax', 'other'];
  var ADR_TYPES = ['work', 'home', 'other'];

  function attach(ui) {
    var T = ui.T; var h = ui.h; var add = ui.add; var clear = ui.clear; var icon = ui.icon; var btn = ui.btn; var ibtn = ui.ibtn;
    var api = ui.api; var L = ui.L; var S = ui.S; var CTX = ui.CTX; var LOCALE = ui.LOCALE;
    var $ = function (id) { return document.getElementById(id); };
    var K = {
      loaded: false, loading: null, books: [], groups: [], prefs: {}, items: [], next: null, q: '', book: 'all', group: null, tab: 'contacts',
      open: null, card: null, dupCount: null, seq: 0, photos: {},
    };

    function fail(e) { ui.toast(ui.errText(e), 'error'); }
    function membersText(n) { return n === 1 ? T('p.k.member_one') : T('p.k.members_n', { n: n }); }
    function bookOf(id) { for (var i = 0; i < K.books.length; i++) if (K.books[i].id === id) return K.books[i]; return null; }
    function groupOf(id) { for (var i = 0; i < K.groups.length; i++) if (K.groups[i].id === id) return K.groups[i]; return null; }
    function bookName(b) {
      if (!b) return '';
      var a = b.accountId ? ui.accountOf(b.accountId) : null;
      return a ? (a.name || a.email) + ' · ' + b.name : b.name;
    }
    function bookColor(b) { var a = b && b.accountId ? ui.accountOf(b.accountId) : null; return a ? a.color : null; }
    function colorFor(s) { var n = 0; String(s || '').split('').forEach(function (c) { n = (n * 31 + c.charCodeAt(0)) >>> 0; }); return COLORS[n % COLORS.length]; }

    /** A contact's circle: its picture (loaded once per photoEtag) or the initials. */
    function avatar(c, big) {
      var box = h('span', { class: 'mk-av' + (big ? ' is-big' : ''), style: 'background:' + colorFor(c.name || (c.emails || [])[0]) });
      box.appendChild(h('span', { text: ui.initials(typeof c.name === 'string' ? c.name : (c.name && c.name.display) || ((c.emails || [])[0] || {}).value || '?') }));
      var etag = c.photoEtag || (c.photo && c.photo.etag) || null;
      if (etag) {
        var have = K.photos[c.id];
        var show = function (url) { clear(box); box.appendChild(h('img', { attrs: { src: url, alt: '' } })); };
        if (have && have.etag === etag && have.url) show(have.url);
        else if (!have || have.etag !== etag) {
          K.photos[c.id] = { etag: etag, url: null };
          api('GET', 'cards/' + c.id + '/photo').then(function (r) { var url = 'data:' + r.mime + ';base64,' + r.data; K.photos[c.id] = { etag: etag, url: url }; show(url); }, function () {});
        }
      }
      return box;
    }

    // ── loading ──────────────────────────────────────────

    function load() {
      if (K.loading) return K.loading;
      K.loading = api('GET', 'addressbooks').then(function (r) {
        K.books = r.items || [];
        K.groups = r.groups || [];
        K.prefs = r.prefs || {};
        K.loaded = true;
        K.loading = null;
        // the number of duplicates for the menu (in the background)
        api('GET', 'cards/duplicates').then(function (d) { K.dupCount = (d.items || []).length; if (S.area === 'contacts') { ui.renderNav(); renderList(); } }, function () {});
      }, function (e) { K.loading = null; throw e; });
      return K.loading;
    }

    function loadList(more) {
      var seq = ++K.seq;
      var q = { q: K.q || null, book: K.book, group: K.group || null, cursor: more ? K.next : null, limit: 200 };
      return api('GET', 'cards', null, q).then(function (r) {
        if (seq !== K.seq) return;
        K.items = more ? K.items.concat(r.items || []) : (r.items || []);
        K.next = r.next || null;
        renderList();
      }, function (e) { if (seq === K.seq) fail(e); });
    }

    // ── the menu ─────────────────────────────────────────

    function tick(color, on) {
      return h('span', { class: 'mc-ck', style: on ? 'background:' + color + ';border-color:' + color : 'border-color:' + color }, on ? icon('check', 12) : null);
    }

    function nav(el) {
      el.appendChild(ui.toMailRow());
      if (!K.loaded) {
        el.appendChild(h('p', { class: 'dp-hint', style: 'padding:10px', text: T('p.loading') }));
        load().then(ui.renderNav, fail);
        return;
      }
      var all = K.books.filter(function (b) { return b.visible; }).reduce(function (n, b) { return n + (b.count || 0); }, 0);
      var cur = function (book, group) { return K.open !== 'dups' && K.book === book && K.group === group && K.tab === 'contacts'; };
      el.appendChild(navBtn([icon('people'), h('span', { class: 'mp-tx', text: T('p.k.all') }), h('span', { class: 'mp-count', text: String(all) })], cur('all', null), function () { pick('all', null); }));
      el.appendChild(h('div', { class: 'mp-lab', text: T('p.k.books') }));
      K.books.forEach(function (b) {
        var color = bookColor(b) || 'var(--accent)';
        el.appendChild(h('div', { class: 'mc-navrow' }, [
          h('button', { type: 'button', class: 'mk-tick', attrs: { 'aria-pressed': b.visible ? 'true' : 'false', 'aria-label': T('p.k.show_book', { name: bookName(b) }) }, on: { click: function () { setVisible(b, !b.visible); } } }, tick(color, b.visible)),
          navBtn([h('span', { class: 'mp-tx', text: bookName(b) }), b.state === 'consent_required' ? h('span', { class: 'mp-warn', text: T('p.relogin') }) : (b.state === 'auth_failed' || b.state === 'unreachable') ? h('span', { class: 'mp-warn', text: '!', attrs: { title: T('p.side_' + b.state) } }) : null,
            h('span', { class: 'mp-count', text: String(b.count || 0) })], cur(String(b.id), null), function () { pick(String(b.id), null); }),
        ]));
      });
      if (K.groups.length) {
        el.appendChild(h('div', { class: 'mp-lab', text: T('p.k.groups') }));
        K.groups.forEach(function (g) {
          el.appendChild(navBtn([h('span', { class: 'mp-dot', style: 'background:' + (g.color || colorFor(g.name)) }), h('span', { class: 'mp-tx', text: g.name }), h('span', { class: 'mp-count', text: String(g.count) })],
            K.open && K.open.group === g.id, function () { openGroup(g.id); }));
        });
      }
      el.appendChild(navBtn([icon('merge'), h('span', { class: 'mp-tx', text: T('p.k.duplicates') }), K.dupCount ? h('span', { class: 'mp-count is-warn', text: String(K.dupCount) }) : null], K.open === 'dups', showDuplicates));
    }
    function navBtn(kids, current, onClick) {
      return h('button', { type: 'button', class: 'mp-row', attrs: { 'aria-current': current ? 'page' : null }, on: { click: function () { ui.showPane('list'); onClick(); } } }, kids);
    }
    function pick(book, group) {
      K.book = book; K.group = group; K.tab = 'contacts'; K.q = '';
      if (K.open === 'dups') { K.open = null; renderReadEmpty(); }
      ui.renderNav();
      renderList();
      loadList();
    }
    function setVisible(b, on) {
      b.visible = on;
      ui.renderNav();
      api('PATCH', 'addressbooks/' + b.id, { visible: on }).then(function (r) { Object.assign(b, r.addressbook || {}); ui.renderNav(); loadList(); }, function (e) { b.visible = !on; ui.renderNav(); fail(e); });
    }

    // ── the list ─────────────────────────────────────────

    function show() {
      var el = $('mp-list');
      clear(el);
      el.appendChild(h('div', { class: 'mp-card' }, h('div', { class: 'mp-empty', text: T('p.loading') })));
      if (!K.card && K.open !== 'dups' && !(K.open && K.open.group)) renderReadEmpty();
      load().then(function () {
        if (S.area !== 'contacts') return;
        ui.renderNav();
        renderList();
        loadList();
        if (K.card) openCard(K.card.id, true);
      }, function (e) { clear(el); el.appendChild(h('div', { class: 'mp-card' }, h('p', { class: 'dp-err', text: ui.errText(e) }))); });
    }

    function listTitle() {
      if (K.group) { var g = groupOf(K.group); return g ? g.name : T('p.k.title'); }
      if (K.book !== 'all') { var b = bookOf(Number(K.book)); return b ? bookName(b) : T('p.k.title'); }
      return T('p.k.title');
    }

    var searchTimer = null;
    function renderList() {
      var el = $('mp-list');
      if (!el || S.area !== 'contacts') return;
      clear(el);
      var all = K.books.filter(function (b) { return b.visible; }).reduce(function (n, b) { return n + (b.count || 0); }, 0);
      var search = h('input', { type: 'search', placeholder: T('p.k.search'), value: K.q, attrs: { 'aria-label': T('p.k.search_label') } });
      search.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { K.q = search.value.trim(); loadList(); }, 250);
      });
      add(el, [
        h('div', { class: 'mp-head' }, [
          ibtn('menu', T('p.menu'), function () { ui.showPane('nav'); }, 'mp-menu-btn'),
          h('div', { class: 'mp-head-tx' }, [h('h2', { text: listTitle() }), h('div', { class: 'mp-sub', text: T('p.k.sub', { n: all, books: K.books.length }) })]),
          ibtn('more', T('p.k.more'), moreMenu),
          btn(T('p.k.new'), function () { editCard(null, null); }, { icon: 'plus', primary: true, small: true }),
        ]),
        ui.consentBand(SCOPE),
        h('label', { class: 'mp-search' }, [icon('search'), search]),
        h('div', { class: 'mp-tabs', attrs: { role: 'tablist' } }, [
          h('button', { type: 'button', attrs: { role: 'tab', 'aria-selected': K.tab === 'contacts' ? 'true' : 'false' }, on: { click: function () { K.tab = 'contacts'; renderList(); } } }, T('p.k.tab_contacts')),
          h('button', { type: 'button', attrs: { role: 'tab', 'aria-selected': K.tab === 'groups' ? 'true' : 'false' }, on: { click: function () { K.tab = 'groups'; renderList(); } } }, T('p.k.tab_groups', { n: K.groups.length })),
        ]),
      ]);
      if (K.tab === 'groups') { el.appendChild(groupsList()); return; }
      if (K.dupCount && !K.q) {
        el.appendChild(h('button', { type: 'button', class: 'mk-dupband', on: { click: showDuplicates } }, [icon('merge'), h('span', { style: 'flex:1', text: K.dupCount === 1 ? T('p.k.dup_band_one') : T('p.k.dup_band', { n: K.dupCount }) }), h('b', { text: T('p.k.look') })]));
      }
      if (!K.items.length) { el.appendChild(h('div', { class: 'mp-items' }, h('div', { class: 'mp-empty', text: K.q ? T('p.k.none_found') : T('p.k.empty') }))); return; }
      var letters = L.letters(K.items);
      var sections = {};
      if (letters.length > 1) {
        el.appendChild(h('div', { class: 'mk-az', attrs: { 'aria-label': T('p.k.letters') } }, letters.map(function (l) {
          return h('button', { type: 'button', on: { click: function () { var s = sections[l]; if (s && s.scrollIntoView) s.scrollIntoView({ block: 'start', behavior: 'smooth' }); } } }, l);
        })));
      }
      var list = h('div', { class: 'mk-list' });
      var cur = null;
      var box = null;
      K.items.forEach(function (c) {
        if (c.letter !== cur) {
          cur = c.letter;
          var lab = h('div', { class: 'mp-lab', text: cur });
          sections[cur] = lab;
          list.appendChild(lab);
          box = h('div', { class: 'mp-items' });
          list.appendChild(box);
        }
        box.appendChild(cardRow(c));
      });
      el.appendChild(list);
      if (K.next) el.appendChild(h('div', { style: 'display:flex;justify-content:center' }, btn(T('p.more'), function () { loadList(true); }, { small: true })));
    }

    function cardRow(c) {
      var b = bookOf(c.addressbookId);
      var dot = bookColor(b);
      var sub = [c.title, c.company].filter(Boolean).join(' · ') || c.emails[0] || c.phone || '';
      return h('button', { type: 'button', class: 'mp-item mk-row' + (K.card && K.card.id === c.id ? ' is-open' : ''), on: { click: function () { openCard(c.id); } } }, [
        avatar(c, false),
        h('span', { class: 'mp-it' }, [h('span', { class: 'mp-from', style: 'font-weight:600', text: c.name || T('p.k.no_name') }), h('span', { class: 'mp-snip', text: sub })]),
        dot ? h('span', { class: 'mp-dot', style: 'background:' + dot, attrs: { title: bookName(b) } }) : null,
      ]);
    }

    function groupsList() {
      var box = h('div', { class: 'mp-items' });
      K.groups.forEach(function (g) {
        var color = g.color || colorFor(g.name);
        box.appendChild(h('button', { type: 'button', class: 'mp-item mk-row' + (K.open && K.open.group === g.id ? ' is-open' : ''), on: { click: function () { openGroup(g.id); } } }, [
          h('span', { class: 'mk-gic', style: 'background:color-mix(in srgb,' + color + ' 16%,transparent);color:' + color }, icon('people')),
          h('span', { class: 'mp-it' }, [h('span', { class: 'mp-from', style: 'font-weight:600', text: g.name }), h('span', { class: 'mp-snip', text: membersText(g.count) })]),
        ]));
      });
      if (!K.groups.length) box.appendChild(h('div', { class: 'mp-empty', text: T('p.k.no_groups') }));
      return h('div', { class: 'mp-col' }, [box, h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.k.new_group'), newGroup, { icon: 'plus', small: true }))]);
    }

    function renderReadEmpty() {
      var el = $('mp-read');
      if (!el) return;
      clear(el);
      el.appendChild(h('div', { class: 'mp-card' }, h('div', { class: 'mp-empty', text: T('p.k.pick') })));
    }

    // ── import, export, display ─────────────────────────

    function moreMenu() {
      ui.dialog(T('p.k.more'), [h('div', { class: 'dp-menu' }, [
        h('button', { type: 'button', on: { click: importDialog } }, [icon('upload'), T('p.k.import')]),
        h('button', { type: 'button', on: { click: function () { exportDialog(null); } } }, [icon('download'), T('p.k.export')]),
        h('button', { type: 'button', on: { click: function () { ui.closeDialog(); showDuplicates(); } } }, [icon('merge'), T('p.k.duplicates')]),
        h('button', { type: 'button', on: { click: displayDialog } }, [icon('gear'), T('p.k.display')]),
      ])]);
    }

    function bookSelect(withAll, writableOnly, cur) {
      var list = K.books.filter(function (b) { return !writableOnly || b.writable; });
      var opts = (withAll ? [h('option', { value: 'all', selected: cur === 'all', text: T('p.k.all') })] : []).concat(list.map(function (b) { return h('option', { value: String(b.id), selected: String(cur) === String(b.id), text: bookName(b) }); }));
      return h('select', { class: 'dp-input' }, opts);
    }

    function importDialog() {
      var def = K.prefs.defaultAddressbookId || (K.books.filter(function (b) { return b.writable; })[0] || {}).id;
      var book = bookSelect(false, true, def);
      var file = h('input', { type: 'file', class: 'dp-input', attrs: { accept: '.vcf,text/vcard,text/x-vcard' } });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        var f = file.files && file.files[0];
        if (!f) { err.textContent = T('p.k.pick_file'); return; }
        if (f.size > 5 * 1024 * 1024) { err.textContent = ui.errText({ code: 'too_large' }); return; }
        err.textContent = T('p.loading');
        (typeof f.text === 'function' ? f.text() : Promise.resolve(String(f))).then(function (vcf) {
          return api('POST', 'cards/import', { addressbookId: Number(book.value), vcf: vcf });
        }).then(function (r) {
          ui.closeDialog();
          ui.toast(T('p.k.imported', { imported: r.imported, updated: r.updated, skipped: r.skipped }));
          K.loaded = false;
          show();
        }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.k.import'), [h('p', { class: 'dp-hint', text: T('p.k.import_hint') }), ui.field(T('p.k.into_book'), book), ui.field(T('p.k.file'), file), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.k.import_go'), go, { primary: true, icon: 'upload' })])]);
    }

    function exportDialog(group) {
      var book = bookSelect(true, false, 'all');
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        api('GET', 'cards/export', null, { book: group ? null : book.value, group: group || null }).then(function (r) {
          ui.closeDialog();
          return ui.saveFile(r.data, r.mime || 'text/vcard', r.name || 'kontakte.vcf');
        }).then(null, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.k.export'), [h('p', { class: 'dp-hint', text: T('p.k.export_hint') }), group ? null : ui.field(T('p.k.which_book'), book), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.k.export_go'), go, { primary: true, icon: 'download' })])]);
    }

    function displayDialog() {
      var p = K.prefs;
      var sel = function (v, opts) { return h('select', { class: 'dp-input' }, opts.map(function (o) { return h('option', { value: o, selected: o === v, text: T('p.k.opt_' + o) }); })); };
      var sort = sel(p.sort, ['family', 'given']);
      var showSel = sel(p.show, ['given_family', 'family_given']);
      var def = bookSelect(false, true, p.defaultAddressbookId);
      var bdays = h('input', { type: 'checkbox', class: 'dp-sw', checked: p.birthdays !== false });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        var b = { sort: sort.value, show: showSel.value, birthdays: bdays.checked };
        if (def.value) b.defaultAddressbookId = Number(def.value);
        api('PUT', 'cards/settings', b).then(function (r) { K.prefs = r.prefs; ui.closeDialog(); ui.toast(T('p.saved')); loadList(); }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.k.display'), [ui.field(T('p.k.sort'), sort), ui.field(T('p.k.show'), showSel), ui.field(T('p.k.default_book'), def),
        h('label', { class: 'mp-swrow' }, [h('span', { style: 'flex:1', text: T('p.k.birthdays') }), bdays]), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.save'), go, { primary: true })])]);
    }

    // ── one contact ──────────────────────────────────────

    /** Open contact `id` in the area Kontakte (from anywhere). */
    function openCard(id, quiet) {
      if (S.area !== 'contacts') { K.card = { id: id }; ui.setArea('contacts'); return; }
      K.open = { card: id };
      api('GET', 'cards/' + id).then(function (c) {
        K.card = c;
        if (!quiet) renderList();
        ui.renderNav();
        renderCard(c);
        ui.showPane('read');
        api('GET', 'cards/' + id + '/activity').then(function (a) { if (K.card && K.card.id === id) renderCard(c, a); }, function () {});
      }, function (e) { K.card = null; fail(e); });
    }

    function typeLabel(kind, t) { return T('p.k.' + kind + '_' + (t || 'other')); }

    function renderCard(c, act) {
      var el = $('mp-read');
      clear(el);
      var b = bookOf(c.addressbookId);
      var name = c.name.display || [c.name.given, c.name.family].filter(Boolean).join(' ') || c.company || (c.emails[0] || {}).value || T('p.k.no_name');
      var links = (c.linked || []).map(function (l) { return bookName(bookOf(l.addressbookId)) || l.source; }).filter(Boolean);
      var mails = c.emails.map(function (e) { return e.value; });
      var mailTo = function () {
        if (mails.length <= 1) { if (mails[0]) ui.compose({ to: [mails[0]] }); return; }
        ui.dialog(T('p.k.mail_which'), [h('div', { class: 'dp-menu' }, mails.map(function (m) { return h('button', { type: 'button', on: { click: function () { ui.closeDialog(); ui.compose({ to: [m] }); } } }, [icon('mail'), m]); }))]);
      };
      var tel = c.phones[0] ? c.phones[0].value : null;
      var acts = h('div', { class: 'mk-acts' }, [
        h('button', { type: 'button', class: 'mk-act', disabled: !mails.length, on: { click: mailTo } }, [icon('mail', 18), h('span', { text: T('p.k.mail') })]),
        tel ? h('a', { class: 'mk-act', attrs: { href: 'tel:' + tel.replace(/[^\d+]/g, '') } }, [icon('phone', 18), h('span', { text: T('p.k.call') })]) : h('button', { type: 'button', class: 'mk-act', disabled: true }, [icon('phone', 18), h('span', { text: T('p.k.call') })]),
        c.readOnly ? null : h('button', { type: 'button', class: 'mk-act', on: { click: function () { editCard(c, null); } } }, [icon('edit', 18), h('span', { text: T('p.k.edit') })]),
      ]);
      var fields = h('div', { class: 'mp-card mk-fields' });
      var fld = function (label, value, extra) { fields.appendChild(h('div', { class: 'mk-fld' }, [h('span', { class: 'mp-it' }, [h('span', { class: 'mp-sub', text: label }), value]), extra || null])); };
      c.emails.forEach(function (e) {
        fld(T('p.k.email') + ' · ' + typeLabel('email', e.type), h('button', { type: 'button', class: 'mc-link', style: 'text-align:left', on: { click: function () { ui.compose({ to: [e.value] }); } } }, e.value));
      });
      c.phones.forEach(function (p) { fld(typeLabel('phone', p.type), h('a', { class: 'mk-val', attrs: { href: 'tel:' + p.value.replace(/[^\d+]/g, '') }, text: p.value })); });
      c.addresses.forEach(function (a) {
        var text = [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.region, a.country].filter(Boolean).join('\n');
        fld(T('p.k.address') + ' · ' + typeLabel('adr', a.type), h('span', { class: 'mk-val', style: 'white-space:pre-line', text: text }),
          ibtn('pin', T('p.k.map'), function () { ui.linkDialog('https://www.openstreetmap.org/search?query=' + encodeURIComponent(text.replace(/\n/g, ', ')), T('p.k.map')); }));
      });
      var bd = L.birthdayText(c.birthday, CTX.lang);
      if (bd) fld(T('p.k.birthday'), h('span', { class: 'mk-val', text: bd.text + (bd.turns != null ? ' · ' + T('p.k.turns', { n: bd.turns }) : '') }));
      (c.urls || []).forEach(function (u) { fld(T('p.k.url'), h('button', { type: 'button', class: 'mc-link', style: 'text-align:left', on: { click: function () { ui.linkDialog(u); } } }, u)); });
      if (c.note) fld(T('p.k.note'), h('span', { class: 'mk-val', style: 'white-space:pre-wrap', text: c.note }));
      if (c.groups.length) {
        fields.appendChild(h('div', { class: 'mk-fld', style: 'flex-wrap:wrap;gap:6px' }, [h('span', { class: 'mp-sub', style: 'width:100%', text: T('p.k.groups') })].concat(c.groups.map(function (id) {
          var g = groupOf(id);
          var color = g && g.color ? g.color : colorFor(g ? g.name : id);
          return g ? h('button', { type: 'button', class: 'mk-gchip', style: 'background:color-mix(in srgb,' + color + ' 16%,transparent);color:' + color, on: { click: function () { openGroup(g.id); } } }, g.name) : null;
        }))));
      }
      if (!fields.firstChild) fields.appendChild(h('p', { class: 'dp-hint', text: T('p.k.no_fields') }));
      add(el, [
        h('div', { class: 'mp-card mk-headcard' }, [
          h('div', { class: 'mp-tools' }, [ibtn('back', T('p.back'), function () { ui.showPane('list'); }, 'mp-back'), h('span', { style: 'flex:1' }),
            c.readOnly ? null : ibtn('trash', T('p.k.delete'), function () { deleteCard(c); })]),
          avatar(c, true),
          h('h2', { class: 'mk-name', text: name }),
          [c.title, c.department, c.company].filter(Boolean).length ? h('span', { class: 'mk-role', text: [c.title, c.company].filter(Boolean).join(' · ') }) : null,
          h('span', { class: 'mp-sub mk-src' }, [bookColor(b) ? h('span', { class: 'mp-dot', style: 'background:' + bookColor(b) }) : null,
            bookName(b) + (links.length ? ' · ' + T('p.k.linked_with', { list: links.join(', ') }) : '')]),
          c.readOnly ? h('p', { class: 'dp-hint', text: T('p.k.read_only', { book: bookName(b) }) }) : null,
          acts,
        ]),
        fields,
      ]);
      if (act) {
        if ((act.mails || []).length) {
          el.appendChild(h('div', { class: 'mp-lab', text: T('p.k.last_mails') }));
          el.appendChild(h('div', { class: 'mp-items' }, act.mails.map(function (m) {
            var a = ui.accountOf(m.accountId);
            return h('button', { type: 'button', class: 'mp-item', on: { click: function () { ui.openMail(m.id); } } }, [
              h('span', { class: 'mp-av' }, h('span', { class: 'mp-dot', style: 'position:static;background:' + (a ? a.color : 'var(--muted)') })),
              h('span', { class: 'mp-it' }, [h('span', { class: 'mp-l1' }, [h('span', { class: 'mp-from', text: m.subject || T('p.no_subject') }), h('span', { class: 'mp-time', text: ui.fmtTime(m.date) })]),
                h('span', { class: 'mp-snip', text: m.snippet || '' })]),
            ]);
          }).concat(mails[0] ? [h('button', { type: 'button', class: 'mp-item mk-all', on: { click: function () { ui.mailsOf(mails[0]); } } }, T('p.k.all_mails', { name: c.name.given || name }))] : [])));
        }
        if ((act.events || []).length) {
          var cal = ui.calendar();
          el.appendChild(h('div', { class: 'mp-lab', text: T('p.k.shared_events') }));
          el.appendChild(h('div', { class: 'mp-items' }, act.events.map(function (o) {
            var d = o.allDay && o.startDate ? L.dateOf(o.startDate) : new Date(o.start);
            return h('button', { type: 'button', class: 'mp-item mk-evrow', on: { click: function () { if (cal) cal.openEvent(o); } } }, [
              h('span', { class: 'mk-evday' }, [h('span', { class: 'mp-sub', text: d.toLocaleDateString(LOCALE, { weekday: 'short' }) }), h('b', { text: String(d.getDate()) })]),
              h('span', { class: 'mp-it' }, [h('b', { text: o.title }), h('span', { class: 'mp-sub', text: [o.allDay ? T('p.c.all_day') : L.hhmm(o.start) + '–' + L.hhmm(o.end), o.location, o.myResponse === 'needs_action' ? T('p.c.invite_open') : null].filter(Boolean).join(' · ') })]),
            ]);
          })));
        }
      }
    }

    function deleteCard(c) {
      if (!window.confirm(T('p.k.delete_q', { name: c.name.display || '' }))) return;
      api('DELETE', 'cards/' + c.id).then(function () {
        ui.closeDialog();
        K.card = null; K.open = null;
        ui.toast(T('p.k.deleted'));
        renderReadEmpty();
        ui.showPane('list');
        K.loaded = false;
        load().then(function () { ui.renderNav(); loadList(); }, function () {});
      }, fail);
    }

    /** A new contact with a name and an address (an attendee, a group member) — the form, filled in. */
    function newFrom(p) {
      var parts = String(p.name || '').trim().split(/\s+/).filter(Boolean);
      var go = function () { editCard(null, { name: { given: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '', family: parts.length > 1 ? parts[parts.length - 1] : '' }, emails: p.email ? [{ value: p.email, type: 'other' }] : [] }); };
      if (S.area !== 'contacts') ui.setArea('contacts');
      load().then(go, fail);
    }

    /** The sender of a mail: their contact, or „Als Kontakt speichern“ (name, address, from the signature: number, company, position). */
    function fromSender(m) {
      api('GET', 'cards/lookup', null, { email: m.from.email }).then(function (r) {
        if (r.card) { openCard(r.card.id); return null; }
        return api('GET', 'cards/draft', null, { messageId: m.id, email: m.from.email }).then(function (d) {
          return load().then(function () { editCard(d.existing || null, d.draft, d.existing ? T('p.k.add_to', { name: d.existing.name.display || '' }) : T('p.k.save_as')); });
        });
      }).then(null, fail);
    }

    /** Make a picture a JPEG of at most 512 px (canvas) → { mime, data } (base64). */
    function shrink(file) {
      return new Promise(function (resolve, reject) {
        if (typeof FileReader === 'undefined' || !document.createElement('canvas').getContext) { reject(new Error('unsupported')); return; }
        var rd = new FileReader();
        rd.onload = function () {
          var img = new Image();
          img.onload = function () {
            var k = Math.min(1, 512 / Math.max(img.width, img.height));
            var cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            var url = cv.toDataURL('image/jpeg', 0.85);
            resolve({ mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url: url });
          };
          img.onerror = reject;
          img.src = rd.result;
        };
        rd.onerror = reject;
        rd.readAsDataURL(file);
      });
    }

    /**
     * The form of a contact: new (`c` null) or a change of `c` (a Card); `pre`: fields to fill in (a draft, a new one
     * from an attendee) — over `c`'s own for „Zu <Name> hinzufügen“.
     */
    function editCard(c, pre, title) {
      var base = c || { name: { given: '', family: '' }, emails: [], phones: [], addresses: [], company: null, title: null, birthday: null, note: '', groups: [] };
      var x = pre || {};
      var emails = (base.emails || []).map(function (e) { return { value: e.value, type: e.type }; });
      (x.emails || []).forEach(function (e) { if (!emails.some(function (y) { return y.value === e.value; })) emails.push({ value: e.value, type: e.type || 'other' }); });
      var phones = (base.phones || []).map(function (p) { return { value: p.value, type: p.type }; });
      (x.phones || []).forEach(function (p) { if (!phones.some(function (y) { return y.value.replace(/\D/g, '') === p.value.replace(/\D/g, ''); })) phones.push({ value: p.value, type: p.type || 'other' }); });
      var addrs = (base.addresses || []).map(function (a) { return Object.assign({}, a); });
      var nm = x.name && !c ? x.name : base.name;
      var given = h('input', { class: 'dp-input', type: 'text', value: nm.given || '', attrs: { autocomplete: 'off' } });
      var family = h('input', { class: 'dp-input', type: 'text', value: nm.family || '', attrs: { autocomplete: 'off' } });
      var company = h('input', { class: 'dp-input', type: 'text', value: base.company || x.company || '' });
      var position = h('input', { class: 'dp-input', type: 'text', value: base.title || x.title || '' });
      var bdm = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(base.birthday || '');
      var bday = h('input', { class: 'dp-input', type: 'text', value: bdm ? Number(bdm[3]) + '.' + Number(bdm[2]) + '.' : '', placeholder: T('p.k.bday_ph'), attrs: { 'aria-label': T('p.k.birthday') } });
      var byear = h('input', { class: 'dp-input', type: 'number', value: bdm && bdm[1] !== '-' ? bdm[1] : '', placeholder: T('p.k.year_optional'), attrs: { min: '1800', max: '2100', 'aria-label': T('p.k.year') } });
      var note = h('textarea', { class: 'dp-input', attrs: { rows: '3' } });
      note.value = base.note || '';
      var groups = (base.groups || []).slice();
      var book = c ? null : bookSelect(false, true, K.book !== 'all' && bookOf(Number(K.book)) && bookOf(Number(K.book)).writable ? K.book : (K.prefs.defaultAddressbookId || ''));
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var photo = null;
      var photoBox = h('span', { class: 'mk-photo' }, avatar(c || { name: (nm.given || '') + ' ' + (nm.family || ''), emails: [] }, true));
      var fileIn = h('input', { type: 'file', hidden: true, attrs: { accept: 'image/jpeg,image/png' } });
      fileIn.addEventListener('change', function () {
        var f = fileIn.files && fileIn.files[0];
        fileIn.value = '';
        if (!f) return;
        shrink(f).then(function (p) { photo = p; clear(photoBox); photoBox.appendChild(h('span', { class: 'mk-av is-big' }, h('img', { attrs: { src: p.url, alt: '' } }))); }, function () { err.textContent = T('p.k.photo_failed'); });
      });

      var multi = function (list, types, kind, ph, inputType) {
        var box = h('div', { class: 'mp-col' });
        var draw = function () {
          clear(box);
          list.forEach(function (it, i) {
            var t = h('select', { class: 'dp-input mk-type', attrs: { 'aria-label': T('p.k.kind') } }, types.map(function (k) { return h('option', { value: k, selected: it.type === k, text: typeLabel(kind, k) }); }));
            t.addEventListener('change', function () { it.type = t.value; });
            var v = h('input', { class: 'dp-input', type: inputType, value: it.value, placeholder: ph });
            v.addEventListener('input', function () { it.value = v.value; });
            v.addEventListener('change', function () { it.value = v.value; });
            box.appendChild(h('div', { class: 'mk-multi' }, [t, v, ibtn('close', T('p.remove'), function () { list.splice(i, 1); draw(); })]));
          });
          box.appendChild(h('button', { type: 'button', class: 'mc-link', on: { click: function () { list.push({ value: '', type: types[0] }); draw(); } } }, [icon('plus', 14), ' ', T('p.k.add_' + kind)]));
        };
        draw();
        return box;
      };
      var adrBox = h('div', { class: 'mp-col' });
      var drawAdr = function () {
        clear(adrBox);
        addrs.forEach(function (a, i) {
          var inp = function (k, label, w) {
            var x2 = h('input', { class: 'dp-input', type: 'text', value: a[k] || '', attrs: { 'aria-label': label }, placeholder: label, style: w ? 'width:' + w : null });
            x2.addEventListener('input', function () { a[k] = x2.value; });
            x2.addEventListener('change', function () { a[k] = x2.value; });
            return x2;
          };
          var t = h('select', { class: 'dp-input mk-type' }, ADR_TYPES.map(function (k) { return h('option', { value: k, selected: a.type === k, text: typeLabel('adr', k) }); }));
          t.addEventListener('change', function () { a.type = t.value; });
          adrBox.appendChild(h('div', { class: 'mk-adr' }, [h('div', { class: 'mk-multi' }, [t, inp('street', T('p.k.street')), ibtn('close', T('p.remove'), function () { addrs.splice(i, 1); drawAdr(); })]),
            h('div', { class: 'mk-multi' }, [inp('postalCode', T('p.k.postal'), '110px'), inp('city', T('p.k.city'))]), h('div', { class: 'mk-multi' }, [inp('region', T('p.k.region')), inp('country', T('p.k.country'))])]));
        });
        adrBox.appendChild(h('button', { type: 'button', class: 'mc-link', on: { click: function () { addrs.push({ type: 'work', street: '', postalCode: '', city: '', region: '', country: '' }); drawAdr(); } } }, [icon('plus', 14), ' ', T('p.k.add_adr')]));
      };
      drawAdr();
      var groupBox = h('div', { class: 'dp-chips' });
      var drawGroups = function () {
        clear(groupBox);
        K.groups.forEach(function (g) {
          groupBox.appendChild(h('button', { type: 'button', attrs: { 'aria-pressed': groups.indexOf(g.id) >= 0 ? 'true' : 'false' }, on: { click: function () {
            var i = groups.indexOf(g.id); if (i >= 0) groups.splice(i, 1); else groups.push(g.id); drawGroups();
          } } }, g.name));
        });
        if (!K.groups.length) groupBox.appendChild(h('span', { class: 'dp-hint', text: T('p.k.no_groups') }));
      };
      drawGroups();

      var birthday = function () {
        var s = bday.value.trim();
        if (!s) return null;
        var m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(s) || /^(\d{1,2})\/(\d{1,2})$/.exec(s);
        if (!m) return undefined;
        var dd = ('0' + m[1]).slice(-2); var mm = ('0' + m[2]).slice(-2);
        var y = byear.value.trim();
        if (y && !/^\d{4}$/.test(y)) return undefined;
        return (y || '-') + '-' + mm + '-' + dd;
      };
      var fieldsOf = function () {
        var bd = birthday();
        if (bd === undefined) return null;
        var g = given.value.trim(); var f = family.value.trim();
        return {
          name: { given: g, family: f, display: [g, f].filter(Boolean).join(' ') || null },
          company: company.value.trim() || null, title: position.value.trim() || null,
          emails: emails.filter(function (e) { return e.value.trim(); }).map(function (e, i) { return { value: e.value.trim(), type: e.type, primary: i === 0 }; }),
          phones: phones.filter(function (p) { return p.value.trim(); }).map(function (p) { return { value: p.value.trim(), type: p.type }; }),
          addresses: addrs.filter(function (a) { return [a.street, a.postalCode, a.city, a.region, a.country].some(function (v) { return v && String(v).trim(); }); })
            .map(function (a) { return { type: a.type, street: a.street || '', postalCode: a.postalCode || '', city: a.city || '', region: a.region || '', country: a.country || '' }; }),
          birthday: bd, note: note.value, groups: groups.slice(),
        };
      };
      var after = function (card) {
        var done = function (cc) {
          ui.closeDialog();
          ui.toast(T('p.saved'));
          K.loaded = false;
          load().then(function () { ui.renderNav(); loadList(); }, function () {});
          openCard(cc.id, true);
        };
        if (!photo) { done(card); return; }
        api('PUT', 'cards/' + card.id + '/photo', { mime: photo.mime, data: photo.data }).then(function (r) { done(r.card || card); }, function (e) { ui.toast(ui.errText(e), 'error'); done(card); });
      };
      var send = function (body, etag) {
        var req = c ? api('PATCH', 'cards/' + c.id, Object.assign({}, body, { etag: etag })) : api('POST', 'cards', Object.assign({}, body, book && book.value ? { addressbookId: Number(book.value) } : {}));
        req.then(function (r) { after(r.card); }, function (e) {
          if (e && e.code === 'conflict' && e.extra && e.extra.current) {
            var cur = e.extra.current;
            ui.dialog(T('p.k.conflict_title'), [h('p', { class: 'dp-hint', text: T('p.k.conflict_text') }), h('div', { class: 'dp-actions' }, [
              btn(T('p.c.reload'), function () { ui.closeDialog(); openCard(cur.id, true); }),
              btn(T('p.c.apply_mine'), function () { c = cur; send(body, cur.etag); }, { primary: true }),
            ])]);
            return;
          }
          err.textContent = ui.errText(e);
        });
      };
      var save = function () {
        err.textContent = '';
        var f = fieldsOf();
        if (!f) { err.textContent = T('p.k.bday_bad'); bday.focus(); return; }
        if (!f.name.display && !f.emails.length && !f.phones.length && !f.company) { err.textContent = T('p.k.name_missing'); given.focus(); return; }
        send(f, c ? c.etag : undefined);
      };
      var b0 = c ? bookOf(c.addressbookId) : null;
      var form = [
        h('div', { class: 'mk-photorow' }, [photoBox, btn(T('p.k.photo'), function () { fileIn.click(); }, { small: true, icon: 'image' }), fileIn,
          b0 && b0.source !== 'local' ? h('span', { class: 'mp-sub', text: T('p.k.goes_to', { book: bookName(b0) }) }) : null]),
        h('div', { class: 'mc-dt' }, [ui.field(T('p.k.given'), given), ui.field(T('p.k.family'), family)]),
        h('div', { class: 'mc-dt' }, [ui.field(T('p.k.company'), company), ui.field(T('p.k.position'), position)]),
        ui.field(T('p.k.email'), multi(emails, EMAIL_TYPES, 'email', 'name@example.com', 'email')),
        ui.field(T('p.k.phone'), multi(phones, PHONE_TYPES, 'phone', '+49 …', 'tel')),
        ui.field(T('p.k.address'), adrBox),
        h('div', { class: 'mc-dt' }, [ui.field(T('p.k.birthday'), bday), ui.field(T('p.k.year'), byear)]),
        ui.field(T('p.k.note'), note), ui.field(T('p.k.groups'), groupBox),
        book ? ui.field(T('p.k.book'), book) : null, err,
        h('div', { class: 'dp-actions' }, [c && !c.readOnly ? btn(T('p.k.delete'), function () { deleteCard(c); }, { danger: true }) : null, btn(T('p.cancel'), ui.closeDialog), btn(T('p.save'), save, { primary: true })]),
      ];
      ui.dialog(title || (c ? T('p.k.edit_title') : T('p.k.new')), form, { wide: true });
      given.focus();
    }

    // ── groups ───────────────────────────────────────────

    function newGroup() {
      var name = h('input', { class: 'dp-input', type: 'text' });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        api('POST', 'groups', { name: name.value.trim() }).then(function (r) {
          K.groups.push(r.group);
          ui.closeDialog();
          ui.renderNav();
          renderList();
          openGroup(r.group.id);
        }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.k.new_group'), [ui.field(T('p.k.group_name'), name), err, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.c.create'), go, { primary: true })])]);
      name.focus();
    }

    function openGroup(id) {
      if (S.area !== 'contacts') { ui.setArea('contacts'); }
      K.open = { group: id };
      K.card = null;
      api('GET', 'groups/' + id).then(function (r) {
        var g = groupOf(id);
        if (g) Object.assign(g, r.group);
        ui.renderNav();
        renderList();
        renderGroup(r.group, r.members);
        ui.showPane('read');
      }, fail);
    }

    function renderGroup(g, members) {
      var el = $('mp-read');
      clear(el);
      var color = g.color || colorFor(g.name);
      var change = function (body) {
        return api('POST', 'groups/' + g.id + '/members', body).then(function (r) {
          var x = groupOf(g.id); if (x) Object.assign(x, r.group);
          ui.renderNav();
          renderGroup(r.group, r.members);
        }, fail);
      };
      var input = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.k.add_member'), attrs: { autocomplete: 'off', 'aria-label': T('p.k.add_member') } });
      var sugg = h('div', { class: 'mp-sugglist', hidden: true });
      var timer = null;
      input.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        var q = input.value.trim();
        if (q.length < 2) { sugg.hidden = true; return; }
        timer = setTimeout(function () {
          api('GET', 'contacts', null, { q: q }).then(function (r) {
            clear(sugg);
            (r.items || []).filter(function (x) { return x.source !== 'group' && x.email; }).forEach(function (x) {
              sugg.appendChild(h('button', { type: 'button', on: { click: function () {
                input.value = ''; sugg.hidden = true;
                change({ add: [x.contactId ? { contactId: x.contactId } : { email: x.email, name: x.name || undefined }] });
              } } }, (x.name ? x.name + ' · ' : '') + x.email));
            });
            sugg.hidden = !sugg.firstChild;
          }, function () { sugg.hidden = true; });
        }, 250);
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        var got = L.addressesOf(input.value);
        if (got.length) { input.value = ''; sugg.hidden = true; change({ add: got.map(function (a) { return { email: a.email, name: a.name || undefined }; }) }); }
      });
      var emails = members.map(function (m) { return m.email; }).filter(Boolean);
      var rename = function () {
        var name = h('input', { class: 'dp-input', type: 'text', value: g.name });
        var col = h('input', { class: 'dp-input', type: 'color', value: color, style: 'width:64px;padding:2px' });
        var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
        ui.dialog(T('p.k.group_edit'), [ui.field(T('p.k.group_name'), name), ui.field(T('p.c.color'), col), err, h('div', { class: 'dp-actions' }, [
          btn(T('p.k.group_delete'), function () {
            if (!window.confirm(T('p.k.group_delete_q', { name: g.name }))) return;
            api('DELETE', 'groups/' + g.id).then(function () {
              ui.closeDialog(); K.groups = K.groups.filter(function (x) { return x.id !== g.id; }); K.open = null; ui.renderNav(); renderList(); renderReadEmpty();
            }, function (e) { err.textContent = ui.errText(e); });
          }, { danger: true }),
          btn(T('p.cancel'), ui.closeDialog),
          btn(T('p.save'), function () {
            api('PATCH', 'groups/' + g.id, { name: name.value.trim(), color: col.value.toUpperCase() }).then(function (r) {
              var x = groupOf(g.id); if (x) Object.assign(x, r.group);
              ui.closeDialog(); ui.renderNav(); renderList(); renderGroup(r.group, members);
            }, function (e) { err.textContent = ui.errText(e); });
          }, { primary: true }),
        ])]);
      };
      add(el, [
        h('div', { class: 'mp-card' }, [
          h('div', { class: 'mp-tools' }, [ibtn('back', T('p.back'), function () { ui.showPane('list'); }, 'mp-back'),
            h('span', { class: 'mk-gic', style: 'background:color-mix(in srgb,' + color + ' 16%,transparent);color:' + color }, icon('people')),
            h('div', { class: 'mp-head-tx' }, [h('h2', { text: g.name }), h('div', { class: 'mp-sub', text: membersText(g.count) })]),
            ibtn('edit', T('p.k.group_edit'), rename)]),
          h('div', { class: 'mp-tools' }, [
            btn(T('p.k.mail_all'), function () { if (emails.length) ui.compose({ to: emails }); }, { primary: true, small: true, icon: 'mail', disabled: !emails.length }),
            btn(T('p.k.export'), function () { exportDialog(g.id); }, { small: true, icon: 'download' }),
          ]),
          input, sugg,
        ]),
        h('div', { class: 'mp-items' }, members.length ? members.map(function (m) {
          return h('div', { class: 'mp-item mk-row', style: 'cursor:default' }, [
            h('span', { class: 'mk-av', style: 'background:' + colorFor(m.name || m.email) }, h('span', { text: ui.initials(m.name || m.email || '?') })),
            m.contactId ? h('button', { type: 'button', class: 'mp-it mk-plain', on: { click: function () { openCard(m.contactId); } } }, [h('span', { class: 'mp-from', text: m.name || m.email || '' }), h('span', { class: 'mp-snip', text: m.email || '' })])
              : h('span', { class: 'mp-it' }, [h('span', { class: 'mp-from', text: m.name || m.email || '' }), h('span', { class: 'mp-snip', text: m.email || '' })]),
            ibtn('close', T('p.k.remove_member', { name: m.name || m.email || '' }), function () { change({ remove: [m.id] }); }),
          ]);
        }) : h('div', { class: 'mp-empty', text: T('p.k.no_members') })),
      ]);
    }

    // ── duplicates ───────────────────────────────────────

    function showDuplicates() {
      if (S.area !== 'contacts') ui.setArea('contacts');
      K.open = 'dups';
      K.tab = 'contacts';
      K.card = null;
      ui.renderNav();
      var el = $('mp-read');
      clear(el);
      el.appendChild(h('div', { class: 'mp-card' }, h('div', { class: 'mp-empty', text: T('p.loading') })));
      ui.showPane('read');
      api('GET', 'cards/duplicates').then(function (r) {
        K.dupCount = (r.items || []).length;
        ui.renderNav();
        renderList();
        clear(el);
        el.appendChild(h('div', { class: 'mp-card' }, [h('div', { class: 'mp-tools' }, [ibtn('back', T('p.back'), function () { ui.showPane('list'); }, 'mp-back'),
          h('div', { class: 'mp-head-tx' }, [h('h2', { text: T('p.k.duplicates') }), h('div', { class: 'mp-sub', text: K.dupCount === 1 ? T('p.k.dup_band_one') : T('p.k.dup_sub', { n: K.dupCount }) })])])]));
        if (!r.items.length) { el.appendChild(h('div', { class: 'mp-card' }, h('div', { class: 'mp-empty', text: T('p.k.no_duplicates') }))); return; }
        r.items.forEach(function (d) {
          var books = {};
          d.cards.forEach(function (c) { books[c.addressbookId] = true; });
          el.appendChild(h('div', { class: 'mp-card mk-dup' }, [
            h('span', { class: 'mp-sub', text: T('p.k.reason_' + d.reason) }),
            h('div', { class: 'mp-items' }, d.cards.map(function (c) {
              return h('button', { type: 'button', class: 'mp-item mk-row', on: { click: function () { openCard(c.id); } } }, [avatar(c, false),
                h('span', { class: 'mp-it' }, [h('span', { class: 'mp-from', text: c.name }), h('span', { class: 'mp-snip', text: [c.emails[0], c.phone, bookName(bookOf(c.addressbookId))].filter(Boolean).join(' · ') })])]);
            })),
            Object.keys(books).length > 1 ? h('p', { class: 'dp-hint', text: T('p.k.link_note') }) : null,
            h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, [
              btn(T('p.k.merge'), function () { mergeDialog(d); }, { primary: true, small: true, icon: 'merge' }),
              btn(T('p.k.not_dup'), function () { api('POST', 'cards/duplicates/ignore', { ids: d.cards.map(function (c) { return c.id; }) }).then(showDuplicates, fail); }, { small: true }),
            ]),
          ]));
        });
      }, function (e) { clear(el); el.appendChild(h('div', { class: 'mp-card' }, h('p', { class: 'dp-err', text: ui.errText(e) }))); });
    }

    /** „Zusammenführen“: the main contact, a choice per field where they differ, the notes joined or not. */
    function mergeDialog(d) {
      Promise.all(d.cards.map(function (c) { return api('GET', 'cards/' + c.id); })).then(function (cards) {
        var ids = cards.map(function (c) { return c.id; });
        var writable = cards.filter(function (c) { return !c.readOnly; });
        var primary = h('select', { class: 'dp-input' }, cards.map(function (c, i) {
          return h('option', { value: String(c.id), selected: c.id === (writable[0] || cards[i]).id, text: (c.name.display || '') + ' · ' + bookName(bookOf(c.addressbookId)) });
        }));
        var picks = {};
        var rows = [];
        var valueOf = { name: function (c) { return c.name.display; }, company: function (c) { return c.company; }, title: function (c) { return c.title; }, birthday: function (c) { return c.birthday; }, photo: function (c) { return c.photo ? T('p.k.photo_of', { name: c.name.display || '' }) : null; } };
        Object.keys(valueOf).forEach(function (k) {
          var have = cards.filter(function (c) { return valueOf[k](c); });
          var distinct = have.map(valueOf[k]).filter(function (v, i, a) { return a.indexOf(v) === i; });
          if (distinct.length < 2) return;
          var s = h('select', { class: 'dp-input' }, have.map(function (c) { return h('option', { value: String(c.id), text: valueOf[k](c) }); }));
          picks[k] = s;
          rows.push(ui.field(T('p.k.pick_' + k), s));
        });
        var join = h('input', { type: 'checkbox', checked: true });
        var sameBook = cards.every(function (c) { return c.addressbookId === cards[0].addressbookId; });
        var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
        var go = function () {
          var pick = {};
          Object.keys(picks).forEach(function (k) { pick[k] = Number(picks[k].value); });
          if (join.checked) pick.note = 'join';
          api('POST', 'cards/merge', { ids: ids, primaryId: Number(primary.value), pick: pick }).then(function (r) {
            ui.closeDialog();
            ui.toast(sameBook ? T('p.k.merged') : T('p.k.linked'));
            K.loaded = false;
            load().then(function () { ui.renderNav(); loadList(); openCard(r.card.id); }, function () {});
          }, function (e) { err.textContent = ui.errText(e); });
        };
        ui.dialog(T('p.k.merge'), [
          h('p', { class: 'dp-hint', text: sameBook ? T('p.k.merge_note') : T('p.k.link_note') }),
          ui.field(T('p.k.primary'), primary),
        ].concat(rows).concat([
          h('label', { class: 'dp-check' }, [join, h('span', { text: T('p.k.join_notes') })]), err,
          h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(sameBook ? T('p.k.merge') : T('p.k.link'), go, { primary: true })]),
        ]), { wide: true });
      }, fail);
    }

    // ── live ─────────────────────────────────────────────

    var liveTimer = null;
    function onEvent(d) {
      if (!d) return;
      if (d.kind === 'addressbooks' || d.kind === 'groups') K.loaded = false;
      if (S.area !== 'contacts') return;
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        var reloadCard = K.card && K.card.id && (!d.contactIds || d.contactIds.indexOf(K.card.id) >= 0) && d.kind === 'changed';
        (K.loaded ? Promise.resolve() : load()).then(function () {
          ui.renderNav();
          loadList();
          if (reloadCard) openCard(K.card.id, true);
          if (K.open && K.open.group && d.kind === 'groups') openGroup(K.open.group);
        }, function () {});
      }, 500);
    }

    return { nav: nav, show: show, onEvent: onEvent, openCard: openCard, newFrom: newFrom, fromSender: fromSender, state: K };
  }

  window.MailContacts = { attach: attach };
})();
