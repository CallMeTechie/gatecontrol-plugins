'use strict';

// Push messages of the family (plugin.json notifyTopics) through the shared
// notifier (server/notify.js): always to named people (users), never to a
// topic's subscribers at large; every message carries data.familie = { type,
// … } for the app (and data.route = plg-gatecontrol-familie, the host's
// default). The plugin's own hourly budget stays below the host's
// permissions.notify.perHour (120); SOS (priority critical, topic sos with
// allowCritical) bypasses the plugin budget entirely.

const notify = require('./notify');

const PER_HOUR = 110;
const HIGH_RESERVE = 30;

const TEXTS = {
  de: {
    'shopping.going': '{{name}} geht einkaufen ({{list}}-Liste) – fehlt noch etwas?',
    'shopping.going_body_n': '{{n}} Dinge stehen schon drauf.',
    'shopping.going_body_1': '1 Ding steht schon drauf.',
    'shopping.going_body_0': 'Die Liste ist leer.',
    'task.due': '{{title}}',
    'task.due_body': 'Fällig {{when}}',
    'task.due_body_stars': 'Fällig {{when}} · {{stars}} ★',
    'task.today': 'heute',
    'task.today_at': 'heute um {{time}}',
    'task.done_by': '{{title}}: erledigt',
    'task.done_by_body': '{{name}} hat es erledigt.',
    'date.today': 'Heute: {{title}}',
    'date.tomorrow': 'Morgen: {{title}}',
    'date.in': 'In {{n}} Tagen: {{title}}',
    'date.birthday_today': '{{name}} hat heute Geburtstag',
    'date.birthday_today_age': '{{name}} wird heute {{age}}',
    'date.birthday_in': '{{name}} hat in {{n}} Tagen Geburtstag',
    'date.birthday_in_age': '{{name}} wird in {{n}} Tagen {{age}}',
    'date.birthday_tomorrow': '{{name}} hat morgen Geburtstag',
    'date.birthday_tomorrow_age': '{{name}} wird morgen {{age}}',
    'date.allday': 'ganztägig',
    'locate.request_auto': '{{name}} hat deinen Standort abgefragt',
    'locate.request_auto_body': 'Dein Standort wird an {{name}} gesendet.',
    'locate.request_confirm': '{{name}} möchte wissen, wo du bist',
    'locate.request_confirm_body': 'Tippe, um deinen Standort zu senden.',
    'locate.result': '{{name}}: Standort empfangen',
    'locate.result_body': 'Genauigkeit ±{{m}} m',
    'locate.result_body_unknown': 'Genauigkeit unbekannt',
    'locate.declined': '{{name}} hat die Standortanfrage abgelehnt',
    'locate.declined_body': 'Gerade beschäftigt.',
    'locate.declined_body_none': 'Ohne Begründung.',
    'locate.failed': '{{name}}: Standort nicht verfügbar',
    'locate.fail.no_permission': 'Die App darf den Standort auf diesem Handy nicht abrufen.',
    'locate.fail.location_off': 'Die Standortermittlung ist auf diesem Handy ausgeschaltet.',
    'locate.fail.timeout': 'Das Handy konnte keinen Standort ermitteln.',
    'locate.expired': 'Keine Antwort von {{name}}s Handy',
    'locate.expired_body': 'Die Standortanfrage ist nach 10 Minuten abgelaufen.',
    'arrival.title': '{{name}} ist angekommen',
    'sos.title': 'SOS von {{name}}',
    'sos.body_pos': '{{time}} · Position ±{{m}} m',
    'sos.body_pos_unknown': '{{time}} · Position mit unbekannter Genauigkeit',
    'sos.body_nopos': '{{time}} · Position unbekannt',
    'sos.ack': '{{name}} hat dein SOS gesehen',
    'sos.ack_body': 'Hilfe ist informiert.',
    'place.consent': '{{name}} möchte dich erinnern: {{title}}',
    'place.consent_body': 'Tippe, um die Orts-Erinnerung anzunehmen oder abzulehnen.',
    'place.left': '{{name}} hat „{{title}}“ verlassen',
    'place.entered': '{{name}} ist bei „{{title}}“ angekommen',
    'ride.and': ' und ',
    'ride.ask': 'Wer kann {{names}} um {{time}} abholen?',
    'ride.ask_title': 'Wer übernimmt „{{title}}“ um {{time}}?',
    'ride.taken': '{{driver}} holt {{names}} ab',
    'ride.taken_title': '{{driver}} übernimmt „{{title}}“',
    'ride.released': '{{driver}} kann {{names}} doch nicht abholen',
    'ride.released_title': '{{driver}} kann „{{title}}“ doch nicht übernehmen',
    'ride.unassigned': 'Niemand kann {{names}} abholen',
    'ride.unassigned_title': 'Niemand kann „{{title}}“ übernehmen',
    'ride.reminder': 'Gleich: {{title}}',
    'ride.open': 'Noch offen: {{title}} {{time}}',
    'locate.age_hint': '{{name}} ist heute 14 – Ortung auf „{{name}} bestätigt“ umstellen?',
    'locate.age_hint_body': 'Ab 14 empfehlen wir, dass {{name}} jede Standortabfrage selbst bestätigt. Umstellen unter Familie › Mitglieder & Ortung.',
    'allowance.paid': 'Dein Taschengeld ist da: {{money}}',
    'allowance.convert': '{{name}} möchte {{stars}} ★ in {{money}} umwandeln',
    'allowance.convert_body': 'Annehmen oder ablehnen – es wird nichts überwiesen, nur gebucht.',
    'allowance.approved': '{{name}} hat das Umwandeln angenommen: +{{money}}',
    'allowance.declined': '{{name}} hat das Umwandeln von {{stars}} ★ abgelehnt',
    'presence.all_away': 'Alle sind unterwegs',
    'presence.first_home': '{{name}} ist als Erstes heimgekommen',
    'presence.child_home_alone': '{{name}} ist allein zuhause',
    'presence.person_home': '{{name}} ist zuhause',
    'presence.person_away': '{{name}} ist unterwegs',
  },
  en: {
    'shopping.going': '{{name}} is going shopping ({{list}} list) – anything missing?',
    'shopping.going_body_n': '{{n}} things are on it already.',
    'shopping.going_body_1': '1 thing is on it already.',
    'shopping.going_body_0': 'The list is empty.',
    'task.due': '{{title}}',
    'task.due_body': 'Due {{when}}',
    'task.due_body_stars': 'Due {{when}} · {{stars}} ★',
    'task.today': 'today',
    'task.today_at': 'today at {{time}}',
    'task.done_by': '{{title}}: done',
    'task.done_by_body': '{{name}} did it.',
    'date.today': 'Today: {{title}}',
    'date.tomorrow': 'Tomorrow: {{title}}',
    'date.in': 'In {{n}} days: {{title}}',
    'date.birthday_today': 'It’s {{name}}’s birthday today',
    'date.birthday_today_age': '{{name}} turns {{age}} today',
    'date.birthday_in': '{{name}}’s birthday is in {{n}} days',
    'date.birthday_in_age': '{{name}} turns {{age}} in {{n}} days',
    'date.birthday_tomorrow': '{{name}}’s birthday is tomorrow',
    'date.birthday_tomorrow_age': '{{name}} turns {{age}} tomorrow',
    'date.allday': 'all day',
    'locate.request_auto': '{{name}} requested your location',
    'locate.request_auto_body': 'Your location is being sent to {{name}}.',
    'locate.request_confirm': '{{name}} would like to know where you are',
    'locate.request_confirm_body': 'Tap to send your location.',
    'locate.result': '{{name}}: location received',
    'locate.result_body': 'Accuracy ±{{m}} m',
    'locate.result_body_unknown': 'Accuracy unknown',
    'locate.declined': '{{name}} declined the location request',
    'locate.declined_body': 'Busy right now.',
    'locate.declined_body_none': 'No reason given.',
    'locate.failed': '{{name}}: location not available',
    'locate.fail.no_permission': 'The app may not get the location on this phone.',
    'locate.fail.location_off': 'Location is switched off on this phone.',
    'locate.fail.timeout': 'The phone could not determine its location.',
    'locate.expired': 'No answer from {{name}}’s phone',
    'locate.expired_body': 'The location request expired after 10 minutes.',
    'arrival.title': '{{name}} has arrived',
    'sos.title': 'SOS from {{name}}',
    'sos.body_pos': '{{time}} · position ±{{m}} m',
    'sos.body_pos_unknown': '{{time}} · position with unknown accuracy',
    'sos.body_nopos': '{{time}} · position unknown',
    'sos.ack': '{{name}} has seen your SOS',
    'sos.ack_body': 'Help is informed.',
    'place.consent': '{{name}} would like to remind you: {{title}}',
    'place.consent_body': 'Tap to accept or decline the place reminder.',
    'place.left': '{{name}} has left “{{title}}”',
    'place.entered': '{{name}} has arrived at “{{title}}”',
    'ride.and': ' and ',
    'ride.ask': 'Who can pick up {{names}} at {{time}}?',
    'ride.ask_title': 'Who can do “{{title}}” at {{time}}?',
    'ride.taken': '{{driver}} picks up {{names}}',
    'ride.taken_title': '{{driver}} does “{{title}}”',
    'ride.released': '{{driver}} can’t pick up {{names}} after all',
    'ride.released_title': '{{driver}} can’t do “{{title}}” after all',
    'ride.unassigned': 'Nobody can pick up {{names}}',
    'ride.unassigned_title': 'Nobody can do “{{title}}”',
    'ride.reminder': 'Soon: {{title}}',
    'ride.open': 'Still open: {{title}} {{time}}',
    'locate.age_hint': '{{name}} turns 14 today – switch locating to “{{name}} confirms”?',
    'locate.age_hint_body': 'From 14 we recommend that {{name}} confirms every location request. Change it under Family › Members & locating.',
    'allowance.paid': 'Your pocket money is here: {{money}}',
    'allowance.convert': '{{name}} would like to convert {{stars}} ★ into {{money}}',
    'allowance.convert_body': 'Accept or decline – nothing is transferred, it is only booked.',
    'allowance.approved': '{{name}} accepted the conversion: +{{money}}',
    'allowance.declined': '{{name}} declined converting {{stars}} ★',
    'presence.all_away': 'Everyone is out',
    'presence.first_home': '{{name}} is the first one home',
    'presence.child_home_alone': '{{name}} is home alone',
    'presence.person_home': '{{name}} is home',
    'presence.person_away': '{{name}} has left home',
  },
};

const t = (lang, key, params) => notify.fmt(TEXTS, lang, key, params);

let notifier = null;
let notifierGc = null;

function reset() { notifier = null; notifierGc = null; }

function notifierOf(gc) {
  if (!notifier || notifierGc !== gc) {
    notifier = notify.createNotifier(gc, { perHour: PER_HOUR, highReserve: HIGH_RESERVE });
    notifierGc = gc;
  }
  return notifier;
}

/**
 * Send one message to `users` (ids; none → nothing is sent).
 * → { sent, pushed, error }
 */
async function send(gc, n) {
  const users = [...new Set((n.users || []).filter((u) => Number.isSafeInteger(u) && u > 0))].slice(0, 100);
  if (!users.length) return { sent: false, pushed: false, error: 'NO_RECIPIENTS' };
  const msg = {
    topic: n.topic, title: String(n.title).slice(0, 120), body: n.body ? String(n.body).slice(0, 1000) : undefined,
    priority: n.priority || 'normal', users, collapseKey: n.collapseKey, ttl: n.ttl, data: n.data,
  };
  try {
    if (msg.priority === 'critical') {
      const r = await notify.deliver(gc, msg);
      if (!r.sent) gc.log.warn('sos notification not sent', r.error);
      return r;
    }
    return await notifierOf(gc).send(msg);
  } catch (e) {
    gc.log.warn('notification failed', n.topic, (e && e.code) || 'error');
    return { sent: false, pushed: false, error: (e && e.code) || 'ERR_NOTIFY' };
  }
}

/** Send a list of collected messages (after the transaction committed). */
async function flush(gc, list) {
  const out = [];
  for (const n of list || []) out.push(await send(gc, n));
  return out;
}

module.exports = { TEXTS, t, send, flush, reset, PER_HOUR, HIGH_RESERVE };
