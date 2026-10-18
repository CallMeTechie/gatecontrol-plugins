/* Page „Regeln & Erinnerungen“ (1.9.0, mockup ReminderServer): every rule of the family — house rules
   and everyone's own reminders — with the editor of ui/reminders.js. Rules saved here are house rules;
   their quick actions run as the administrator. */
(function () {
  'use strict';
  var A = window.FA, $ = A.$;
  var view = A.reminders.mount($('#fa-rr-root'), { base: 'admin/rules', add: $('#fa-rr-add'), banner: $('#fa-rr-banner'), writable: true });
  view.reload();
  setInterval(function () { view.reload(); }, 60000);
}());
