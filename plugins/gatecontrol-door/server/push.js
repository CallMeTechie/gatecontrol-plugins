'use strict';

// Push messages (plugin.json notifyTopics) through the shared notifier
// (server/notify.js): always to named people (users), never to a topic's
// subscribers at large.
//
//   doorbell  high    a ring (picture; "Tür öffnen" for people with the right `open`, "Ansehen")
//   motion    normal  motion (picture; only who opted in per camera; ≤ 1 per camera per 5 min)
//   door      normal  open too long, jammed / not reachable, battery critical, unlocked at night,
//                     Ring connection broken (administrators, once a day)
//   auto      normal  automatic unlock done / refused / locked again
//
// Every message carries data.door = { type, … } for the app (README "Push"),
// data.route = plg-gatecontrol-door (the host's default). The plugin's own
// hourly budget stays below the host's permissions.notify.perHour (120);
// doorbell rings are high priority and keep a reserve.

const notify = require('./notify');

const PER_HOUR = 110;
const HIGH_RESERVE = 40;
const ROUTE = 'plg-gatecontrol-door';

const TEXTS = {
  de: {
    'ding.title': 'Es klingelt: {{name}}',
    'ding.body': '{{camera}} · {{time}}',
    'motion.title': 'Bewegung: {{camera}}',
    'motion.body': '{{time}}',
    'action.open': 'Tür öffnen',
    'action.buzz': 'Summer',
    'action.view': 'Ansehen',
    'action.lock': 'Zusperren',
    'action.relock': 'Wieder zusperren',
    'auto.done': '{{name}} automatisch aufgesperrt',
    'auto.done_body': 'Willkommen zuhause. Ohne Öffnen der Tür wird nach 3 Minuten wieder zugesperrt.',
    'auto.done_body_nosensor': 'Willkommen zuhause.',
    'auto.refused': 'Automatisches Aufsperren abgelehnt: {{reason}}',
    'auto.refused_body': '{{name}} bleibt zu.',
    'auto.relocked': '{{name}} wieder zugesperrt',
    'auto.relocked_body': 'Die Tür wurde nach dem automatischen Aufsperren 3 Minuten nicht geöffnet.',
    'auto.relock_failed': '{{name}}: Wieder-Zusperren fehlgeschlagen',
    'auto.relock_failed_body': 'Bitte prüfe das Schloss.',
    'auto.ask': '{{name}} ist noch aufgesperrt',
    'auto.ask_body': 'Automatisch aufgesperrt vor 3 Minuten – zusperren?',
    'door.open_long': '{{name}} ist seit {{min}} Minuten offen',
    'door.jammed': '{{name}}: Schloss blockiert',
    'door.jammed_body': 'Der Motor ist blockiert. Bitte prüfe Tür und Schloss.',
    'door.unreachable': '{{name}} ist nicht erreichbar',
    'door.unreachable_body': 'Seit {{min}} Minuten keine Verbindung zum Schloss.',
    'door.battery': '{{name}}: Batterie fast leer',
    'door.battery_body': 'Bitte bald die Batterien tauschen.',
    'door.night': '{{name}} ist noch aufgesperrt',
    'door.night_body': 'Nachtkontrolle {{time}}.',
    'ring.broken': 'Ring-Verbindung gestört',
    'ring.broken_body': 'Klingel-Push und Kamerabilder kommen gerade nicht an. Nuki funktioniert weiter. Prüfe die Anmeldung unter Tür & Kamera › Geräte.',
  },
  en: {
    'ding.title': 'Doorbell: {{name}}',
    'ding.body': '{{camera}} · {{time}}',
    'motion.title': 'Motion: {{camera}}',
    'motion.body': '{{time}}',
    'action.open': 'Open door',
    'action.buzz': 'Buzzer',
    'action.view': 'View',
    'action.lock': 'Lock',
    'action.relock': 'Lock again',
    'auto.done': '{{name}} unlocked automatically',
    'auto.done_body': 'Welcome home. If the door is not opened, it locks again after 3 minutes.',
    'auto.done_body_nosensor': 'Welcome home.',
    'auto.refused': 'Automatic unlock refused: {{reason}}',
    'auto.refused_body': '{{name}} stays locked.',
    'auto.relocked': '{{name}} locked again',
    'auto.relocked_body': 'The door was not opened within 3 minutes of the automatic unlock.',
    'auto.relock_failed': '{{name}}: locking again failed',
    'auto.relock_failed_body': 'Please check the lock.',
    'auto.ask': '{{name}} is still unlocked',
    'auto.ask_body': 'Unlocked automatically 3 minutes ago – lock it?',
    'door.open_long': '{{name}} has been open for {{min}} minutes',
    'door.jammed': '{{name}}: lock jammed',
    'door.jammed_body': 'The motor is blocked. Please check the door and the lock.',
    'door.unreachable': '{{name}} is not reachable',
    'door.unreachable_body': 'No connection to the lock for {{min}} minutes.',
    'door.battery': '{{name}}: battery almost empty',
    'door.battery_body': 'Please replace the batteries soon.',
    'door.night': '{{name}} is still unlocked',
    'door.night_body': 'Night check {{time}}.',
    'ring.broken': 'Ring connection broken',
    'ring.broken_body': 'Doorbell pushes and camera pictures are not arriving at the moment. Nuki keeps working. Check the login under Door & Camera › Devices.',
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

/** "Ansehen" — the plugin's tab in the apps. */
function viewAction(lang) {
  return { id: 'open', type: 'open_app_route', label: t(lang, 'action.view'), target: ROUTE };
}

/** A quick action of this plugin as a push action (GateControl ≥ 1.169.0). */
function quickAction(label, lockId, action, { confirm = false, auth = null } = {}) {
  return { type: 'quick_action', label: String(label).slice(0, 24), plugin: 'gatecontrol-door', id: `${lockId}:${action}`, ...(confirm ? { confirm: true } : {}), ...(auth ? { auth } : {}) };
}

/**
 * Send one message to `users` (ids; none → nothing; > 100 → in parts).
 * n = { topic, title, body, priority, users, collapseKey, ttl, data, image: { data, mime } }, opts.minGapMs
 * → [{ sent, pushed, error }]
 */
async function send(gc, n, opts = {}) {
  const users = [...new Set((n.users || []).filter((u) => Number.isSafeInteger(u) && u > 0))].sort((a, b) => a - b);
  if (!users.length) return [];
  const out = [];
  for (let i = 0; i < users.length; i += 100) {
    const msg = {
      topic: n.topic, title: String(n.title).slice(0, 120), body: n.body ? String(n.body).slice(0, 1000) : undefined,
      priority: n.priority || 'normal', users: users.slice(i, i + 100), collapseKey: n.collapseKey, ttl: n.ttl, data: n.data, image: n.image || undefined,
    };
    try {
      out.push(await notifierOf(gc).send(msg, { minGapMs: i === 0 ? opts.minGapMs || 0 : 0 }));
    } catch (e) {
      gc.log.warn('notification failed', n.topic, (e && e.code) || 'error');
      out.push({ sent: false, pushed: false, error: (e && e.code) || 'ERR_NOTIFY' });
    }
  }
  return out;
}

module.exports = { TEXTS, t, send, reset, viewAction, quickAction, ROUTE, PER_HOUR, HIGH_RESERVE };
