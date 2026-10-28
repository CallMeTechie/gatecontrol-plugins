/* Drive (gatecontrol-drive) — the photo frame on the wall tablet (section "Fotorahmen", since 1.7.0).
 *
 * A kiosk device only: GET frame (server/frame.js) gives the large previews of the frame albums — preview-only URLs,
 * no names — with the interval and the order from the settings. Two pictures cross-fade; the month the picture was
 * taken stands in a corner. The list is asked for again every 30 minutes (the URLs last 2 hours); an error tries again
 * after a minute. Text only through textContent and attributes.
 */
(function () {
  'use strict';

  var CTX = window.DF_CTX || { texts: {}, lang: 'de' };
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var REFRESH_MS = 30 * 60000;
  var RETRY_MS = 60000;
  var LOAD_WAIT_MS = 15000;

  function T(k) { return CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k; }
  var $ = function (id) { return document.getElementById(id); };

  var S = { items: [], i: -1, seconds: 20, timer: null, front: 'df-a' };

  function note(text) {
    $('df-stage').hidden = true;
    var m = $('df-msg');
    m.textContent = text;
    m.hidden = false;
  }

  function month(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }); } catch (e) { return ''; }
  }

  function load() {
    if (!window.GC || typeof window.GC.call !== 'function') { note(T('f.failed')); return; }
    window.GC.call('GET', 'frame').then(function (r) {
      S.seconds = Math.max(5, Number(r && r.seconds) || 20);
      if (!r || !r.on) { stop(); note(T('f.off')); return; }
      if (!r.ready) { stop(); note(T('f.host')); return; }
      S.items = (r.items || []).filter(function (x) { return x && typeof x.url === 'string'; });
      if (!S.items.length) { stop(); note(T('f.empty')); return; }
      $('df-msg').hidden = true;
      $('df-stage').hidden = false;
      if (S.i >= S.items.length) S.i = -1;
      if (!S.timer) show();
    }, function () {
      if (!S.items.length) note(T('f.failed'));
      later(RETRY_MS);
    });
  }

  var reloadTimer = null;
  function later(ms) {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, ms);
  }
  function stop() {
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    S.items = [];
  }

  /** The next picture: into the hidden layer, shown once loaded (or after a while), then the timer. */
  function show() {
    if (!S.items.length) return;
    S.i = (S.i + 1) % S.items.length;
    var it = S.items[S.i];
    var back = S.front === 'df-a' ? 'df-b' : 'df-a';
    var img = $(back);
    var done = false;
    var swap = function () {
      if (done) return;
      done = true;
      img.removeEventListener('load', swap);
      img.removeEventListener('error', skip);
      $(back).className = 'df-pic is-on';
      $(S.front).className = 'df-pic';
      S.front = back;
      var when = $('df-when');
      when.textContent = month(it.takenAt);
      when.hidden = !when.textContent;
      S.timer = setTimeout(show, S.seconds * 1000);
    };
    var skip = function () {
      if (done) return;
      done = true;
      img.removeEventListener('load', swap);
      img.removeEventListener('error', skip);
      S.timer = setTimeout(show, 1000);
    };
    img.addEventListener('load', swap);
    img.addEventListener('error', skip);
    img.setAttribute('src', it.url);
    S.timer = setTimeout(function () { if (!done) swap(); }, LOAD_WAIT_MS);
  }

  if (!CTX.kiosk) { note(T('f.kiosk_only')); return; }
  load();
  setInterval(load, REFRESH_MS);
}());
