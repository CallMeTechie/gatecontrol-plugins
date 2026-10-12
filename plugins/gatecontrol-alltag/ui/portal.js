/* Portal sections in the tab "Zuhause": "Müllabfuhr" (the plans this
   person sees — read-only, also for device trust) and "Termine" (the
   person's calendars: today + 7 days after a real login, otherwise only how
   many there are). */
(function () {
  'use strict';
  var A = window.AT, T = A.T, $ = A.$, el = A.el;
  var section = A.CTX.section === 'calendar' ? 'calendar' : 'waste';

  function empty(text) { var e = $('#pt-at-empty'); e.textContent = text; e.hidden = false; }

  function renderWaste(r) {
    var list = A.clear($('#pt-at-list'));
    var plans = (r.plans || []).filter(function (p) { return p.days && p.days.length; });
    if (!r.enabled || !plans.length) { empty(T('portal.waste_none')); return; }
    plans.forEach(function (p) {
      var card = el('div', { class: 'card pt-at-card' }, [
        (r.plans.length > 1 ? el('h2', { class: 'pt-at-h', text: p.name }) : null),
        el('div', { class: 'pt-at-days' }, p.days.map(function (d) {
          return el('div', { class: 'pt-at-day' }, [
            el('span', { class: 'pt-at-when' + (d.rel ? ' is-soon' : ''), text: d.label }),
            el('div', { class: 'at-chips' }, d.fractions.map(A.chip)),
          ]);
        })),
      ]);
      list.appendChild(card);
    });
  }

  function renderCalendar(r) {
    var list = A.clear($('#pt-at-list'));
    if (!r.enabled) { empty(T('portal.cal_none')); return; }
    if (!r.loggedIn) { empty(r.count ? T('portal.cal_count', { n: r.count }) : T('portal.cal_none')); return; }
    if (!r.days.length) { empty(T('portal.cal_none')); return; }
    var card = el('div', { class: 'card pt-at-card' });
    r.days.forEach(function (d) {
      var g = el('div', { class: 'pt-at-group' }, [el('div', { class: 'pt-at-dayh', text: d.label })]);
      d.events.forEach(function (e) {
        var ev = el('div', { class: 'pt-at-ev' }, [
          el('span', { class: 'pt-at-time', text: e.all_day ? T('portal.all_day_short') : e.time }),
          el('div', { class: 'pt-at-ev-main' }, [
            el('div', { class: 'pt-at-title', text: e.title || '–' }),
            el('div', { class: 'pt-at-sub', text: [e.all_day ? null : e.time + (e.end && e.end !== e.time ? '–' + e.end : ''), e.location, e.calendar].filter(Boolean).join(' · ') }),
          ]),
        ]);
        ev.style.setProperty('--dot', A.safeColor(e.color, '#0d9488'));
        g.appendChild(ev);
      });
      card.appendChild(g);
    });
    list.appendChild(card);
  }

  function load() {
    A.api('GET', 'portal/' + section).then(function (r) {
      if (section === 'calendar') renderCalendar(r); else renderWaste(r);
    }).catch(function () { empty(T('portal.error')); });
  }
  load();
  setInterval(load, 10 * 60 * 1000);
}());
