/* Admin page "Übersicht": counts and who has set up Vault (GET admin/overview). Text only via textContent. */
(function () {
  'use strict';
  var CTX = window.VA_CTX || { texts: {}, lang: 'de' };
  function T(k) { return CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k; }
  function el(tag, cls, text, kids) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function date(iso) {
    if (!iso) return T('admin.never');
    try { return new Date(iso).toLocaleString(CTX.lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; }
  }
  function tile(label, value, sub) {
    return el('div', 'va-tile', null, [el('span', 'va-tile-l', label), el('span', 'va-tile-v', value), sub ? el('span', 'va-tile-s', sub) : null]);
  }
  function render(o) {
    var page = document.getElementById('va-page');
    var loading = document.getElementById('va-loading');
    if (loading) loading.remove();
    var c = o.counts;
    page.appendChild(el('div', 'va-tiles', null, [
      tile(T('admin.accounts'), c.accounts),
      tile(T('admin.shared'), c.sharedVaults),
      tile(T('admin.items'), c.items, T('admin.trash') + ': ' + c.trash),
      tile(T('admin.emergency'), c.emergency, c.emergencyOpen + ' ' + T('admin.emergency_open')),
    ]));
    var card = el('div', 'va-card', null, [el('h2', null, T('admin.people'))]);
    if (!o.accounts.length) {
      card.appendChild(el('p', 'va-muted', T('admin.none')));
    } else {
      var table = el('table');
      table.appendChild(el('tr', null, null, [el('th', null, T('admin.col_name')), el('th', null, T('admin.col_created')), el('th', null, T('admin.col_seen'))]));
      o.accounts.forEach(function (a) {
        table.appendChild(el('tr', null, null, [el('td', null, a.name), el('td', null, date(a.createdAt)), el('td', null, date(a.seenAt))]));
      });
      card.appendChild(table);
    }
    page.appendChild(card);
  }
  if (!window.GC) return;
  window.GC.call('GET', 'admin/overview').then(render, function () {
    var l = document.getElementById('va-loading');
    if (l) l.textContent = T('admin.failed');
  });
}());
