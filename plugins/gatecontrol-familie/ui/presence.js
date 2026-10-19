/* Page "Anwesenheit & Smart Home" (mockup AdminAutomations): who is home
   (only people who share it), the rules with "+ Regel", the places of the
   place rules (1.5.0, "+ Ort"), notes and the rule log. Quick actions of a
   rule saved here run as the administrator (gc.actions, GateControl ≥
   1.166.0). Editors, rows and cards: ui/rules.js.
   1.10.0: every rule of the family is here — reminders (schedule) too, the page „Regeln & Erinnerungen“
   is gone: rules, log and the editor's options come from the rules API (admin/rules), who is home,
   places and the sunset location from admin/presence. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$;
  var data = null;
  var opts = { base: 'admin/presence', rulesBase: 'admin/rules', editable: true, reload: load, filter: 'all' };

  function render() {
    var b = $('#fa-pr-banner');
    var notes = [];
    if (data.modules.rules === false) notes.push(T('rr.module_off'));
    if (!data.modules.presence) notes.push(T('presence.module_off_rules'));
    if (data.actionsAvailable === false) notes.push(T('rule.quick_unavailable'));
    b.textContent = notes.join(' ');
    b.hidden = !notes.length;
    A.rules.people($('#fa-pr-people'), data.members);
    A.rules.render($('#fa-pr-rules'), data, opts);
    A.rules.places($('#fa-pr-places'), data, opts);
    $('#fa-pr-place-add').disabled = (data.places || []).length >= A.rules.MAX_PLACES;
    A.rules.log($('#fa-pr-log'), data);
    $('#fa-pr-sun').textContent = data.location ? T('presence.note_sun', { lat: data.location.lat, lon: data.location.lon }) : T('presence.note_sun_none');
  }

  function load() {
    return Promise.all([A.api('GET', 'admin/presence'), A.api('GET', 'admin/rules'), A.api('GET', 'admin/rules/options')]).then(function (x) {
      var pres = x[0], rr = x[1], o = x[2];
      data = {
        modules: { presence: pres.modules.presence, rules: rr.modules ? rr.modules.rules : true },
        location: pres.location, members: pres.members, places: pres.places, home: pres.home,
        rules: rr.rules.map(A.rules.flat), log: rr.log,
        options: o, actions: o.actions, actionsAvailable: o.actionsAvailable, messenger: o.messenger,
      };
      render();
    }).catch(A.warn);
  }

  $('#fa-pr-add').addEventListener('click', function () { if (data) A.rules.edit(null, data, opts); });
  $('#fa-pr-place-add').addEventListener('click', function () { if (data) A.rules.editPlace(null, data, opts, load); });
  load();
  setInterval(load, 60000);
}());
