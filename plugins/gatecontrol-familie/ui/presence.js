/* Page "Anwesenheit & Smart Home" (mockup AdminAutomations): who is home
   (only people who share it), the rules with "+ Regel", the places of the
   place rules (1.5.0, "+ Ort"), notes and the rule log. Quick actions of a
   rule saved here run as the administrator (gc.actions, GateControl ≥
   1.166.0). Editors, rows and cards: ui/rules.js. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$;
  var data = null;
  var opts = { base: 'admin/presence', editable: true, reload: load };

  function render() {
    var off = !data.modules.presence;
    var b = $('#fa-pr-banner');
    b.textContent = off ? T('presence.module_off') : (data.actionsAvailable ? '' : T('rule.quick_unavailable'));
    b.hidden = !b.textContent;
    A.rules.people($('#fa-pr-people'), data.members);
    A.rules.render($('#fa-pr-rules'), data, opts);
    A.rules.places($('#fa-pr-places'), data, opts);
    $('#fa-pr-place-add').disabled = (data.places || []).length >= A.rules.MAX_PLACES;
    A.rules.log($('#fa-pr-log'), data);
    $('#fa-pr-sun').textContent = data.location ? T('presence.note_sun', { lat: data.location.lat, lon: data.location.lon }) : T('presence.note_sun_none');
  }

  function load() {
    return A.api('GET', 'admin/presence').then(function (r) { data = r; render(); }).catch(A.warn);
  }

  $('#fa-pr-add').addEventListener('click', function () { if (data) A.rules.edit(null, data, opts); });
  $('#fa-pr-place-add').addEventListener('click', function () { if (data) A.rules.editPlace(null, data, opts, load); });
  load();
  setInterval(load, 60000);
}());
