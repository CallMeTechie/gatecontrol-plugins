'use strict';

// The portal and the admin page of Mail 1.9.0 in a small DOM (fake-dom.js) against the plugin: „Ressource buchen“
// (mockup Ressource), „Buchungsanfragen“ with the first decision (Anfragen), „Frei/Gebucht“ with suggestions and a
// resource in the event form (Planer), „Kalender teilen“ and „Mit mir geteilt“ (Teilen), the tab „Ressourcen“ of the
// plugin's page and the card on the settings page (AdminRessourcen).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, app, ANNA, MARC, BOB, ADMIN } = require('./helpers');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');
const L = require('../ui/pimlogic');

const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const GROUPS = [{ id: 7, name: 'Fuhrpark', kind: 'team', members: [{ userId: MARC.id, role: 'member' }, { userId: BOB.id, role: 'member' }] }];

function portal(host, user, o = {}) {
  const calls = [];
  const gc = {
    async call(method, p, body) {
      const [path, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path, query, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
      const r = await host.request({ method, path, body: body === undefined ? null : body, query, user: o.admin ? ADMIN : app(user), lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return r.json;
    },
    on() {},
    pickPrincipals: o.pick ? async () => o.pick : undefined,
    navigate: o.navigate,
  };
  const view = o.admin ? { view: 'page', page: o.page, lang: 'de' } : { view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true }, allowed: true };
  const f = createWindow(ui.render(view, t), gc);
  f.window.confirm = () => true;
  f.run();
  const doc = f.document;
  const el = (id) => doc.getElementById(id);
  const all = () => doc.body.all();
  const byText = (tag, text, root) => (root || doc.body).all().filter((x) => x.localName === tag && textOf(x).trim() === text).pop();
  const byLabel = (label, root) => (root || doc.body).all().filter((x) => x.getAttribute('aria-label') === label).pop();
  const dialogText = () => textOf(el('mp-dialog'));
  return { f, doc, el, all, calls, byText, byLabel, dialogText, text: (id) => textOf(el(id)), stop: () => f.stop() };
}
const click = (x, what) => { assert.ok(x, 'no ' + (what || 'element')); x.click(); };
const type = (input, value) => { input.value = value; input.dispatchEvent({ type: 'input' }); input.dispatchEvent({ type: 'change' }); };
/** A weekday two or more days ahead (local), as YYYY-MM-DD. */
function ahead(wd) { let d = L.addDays(L.ymd(new Date()), 2); while (new Date(L.midnight(d)).getDay() !== wd) d = L.addDays(d, 1); return d; }

test('„Ressource buchen“ and „Buchungsanfragen“: the car as a request, Marc approves, Bob is too late; the planner with a resource and suggestions', () => withMail({ gatecontrol: '1.219.0', groups: GROUPS }, async (host, c) => {
  for (const u of [ANNA, MARC, BOB]) await c.addGmx(u);
  await settle(100);
  const room = (await c.admin('POST', 'admin/resources', { name: 'Besprechungsraum 1', kind: 'room', location: '2. OG', seats: 8 })).json.resource;
  const car = (await c.admin('POST', 'admin/resources', { name: 'Firmenwagen Kombi', kind: 'vehicle', approval: 'approval', approvers: [{ type: 'group', id: 7, label: 'Fuhrpark' }], rules: { maxMinutes: 1440 } })).json.resource;
  const day = ahead(4);
  const p = portal(host, ANNA);
  try {
    await until('the foot', () => p.byLabel('Kalender'));
    click(p.byLabel('Kalender'));
    await until('the head', () => p.byText('button', 'Ressource buchen'));
    assert.ok(p.byText('button', 'Meine Buchungen'), 'not an approver: her own bookings');
    // „Ressource buchen“: both resources with their day, the car asks the Fuhrpark
    click(p.byText('button', 'Ressource buchen'));
    await until('the resources', () => p.dialogText().includes('Firmenwagen Kombi') && p.dialogText().includes('Besprechungsraum 1'));
    assert.ok(p.dialogText().includes('Freigabe durch Fuhrpark') && p.dialogText().includes('sagt automatisch zu'));
    type(p.byLabel('Tag'), day);
    await until('reloaded', () => p.calls.filter((x) => x.path === 'resources').length >= 2);
    type(p.byLabel('Beginn'), '12:00');
    type(p.byLabel('Ende'), '15:00');
    type(p.byLabel('Titel'), 'Kunde Müller');
    click(p.byText('button', 'Fahrzeuge'));
    await until('only vehicles', () => !p.dialogText().includes('Besprechungsraum 1'));
    click(p.all().find((x) => x.className === 'mr-reshead' && textOf(x).includes('Firmenwagen')), 'the car');
    await until('chosen', () => p.dialogText().includes('Ausgewählt: 12:00 bis 15:00 · Kunde Müller'));
    click(p.byText('button', 'Anfrage an Fuhrpark senden'));
    await until('booked', () => p.calls.some((x) => x.method === 'POST' && x.path === `resources/${car.id}/book`));
    const post = p.calls.find((x) => x.path === `resources/${car.id}/book`);
    assert.deepEqual([post.body.title, post.body.start, post.body.end], ['Kunde Müller', L.at(day, '12:00'), L.at(day, '15:00')]);
    await until('the request sent', () => p.el('mp-dialog').hidden && p.text('mp-toast').includes('Anfrage für Firmenwagen Kombi gesendet'));
    // the planner: a new event with Marc and the room — rows, suggestions, the room as an attendee
    click(p.byText('button', 'Neuer Termin'));
    await until('the form', () => p.byLabel('Titel'));
    type(p.byLabel('Titel'), 'Sprint-Review');
    const sd = p.all().filter((x) => x.localName === 'input' && x.type === 'date')[0];
    type(sd, day);
    const inp = p.byLabel('Teilnehmer');
    type(inp, 'marc@gmx.de');
    inp.dispatchEvent({ type: 'keydown', key: 'Enter' });
    const pick = p.byLabel('Ressource hinzufügen …');
    await until('the resources in the picker', () => pick.querySelectorAll('option').length === 3);
    pick.value = String(room.id);
    pick.dispatchEvent({ type: 'change' });
    await until('free/busy', () => p.dialogText().includes('Frei/Gebucht') && p.dialogText().includes('Marc') && p.calls.some((x) => x.path === 'freebusy' && (x.body.attendees || []).includes(room.address)));
    await until('suggestions', () => p.all().some((x) => x.className.startsWith('mr-chip')));
    assert.ok(p.dialogText().includes('Vorschläge, bei denen alle können'));
    const fb = p.calls.filter((x) => x.path === 'freebusy').pop();
    assert.deepEqual(fb.body.attendees, ['marc@gmx.de', room.address]);
    const chip = p.all().find((x) => x.className.startsWith('mr-chip'));
    click(chip, 'a suggestion');
    click(p.byText('button', 'Speichern'));
    await until('saved', () => p.calls.some((x) => x.method === 'POST' && x.path === 'events'));
    const ev = p.calls.find((x) => x.method === 'POST' && x.path === 'events').body;
    assert.deepEqual(ev.attendees.map((a) => [a.email, a.role]), [['marc@gmx.de', 'required'], [room.address, 'resource']]);
  } finally { p.stop(); }
  // Marc: „Anfragen · 1“, approves; Bob's list has it no more
  const m = portal(host, MARC);
  const b = portal(host, BOB);
  try {
    for (const x of [m, b]) { await until('the foot', () => x.byLabel('Kalender')); click(x.byLabel('Kalender')); }
    await until('the count', () => m.byText('button', 'Anfragen · 1'));
    click(m.byText('button', 'Anfragen · 1'));
    await until('the request', () => m.dialogText().includes('Anna · Kunde Müller') && m.dialogText().includes('wartet'));
    assert.ok(m.dialogText().includes('Frei · Regeln erfüllt'));
    await until('Bob too', () => b.byText('button', 'Anfragen · 1'));
    click(b.byText('button', 'Anfragen · 1'));
    await until('Bob sees it', () => b.byText('button', 'Freigeben'));
    click(m.byText('button', 'Freigeben'));
    await until('approved', () => m.text('mp-toast').includes('Freigegeben'));
    click(b.byText('button', 'Freigeben'));
    await until('too late', () => b.calls.filter((x) => x.path.endsWith('/decide')).length === 1 && b.text('mp-toast').includes('Marc hat schon entschieden'));
    click(m.byText('button', 'Erledigt'));
    await until('done', () => m.dialogText().includes('zugesagt') && m.dialogText().includes('Marc'));
  } finally { m.stop(); b.stop(); }
}));

test('„Kalender teilen“: a person found by name at „Lesen“, „Einladung offen“; Marc shows it under „Mit mir geteilt“ and sees the event; the switch for free/busy', () => withMail({ gatecontrol: '1.219.0', groups: GROUPS }, async (host, c) => {
  for (const u of [ANNA, MARC]) await c.addGmx(u);
  const anna = c.as(ANNA);
  const cal = (await anna('GET', 'calendars')).json.calendars[0];
  const today = L.ymd(new Date());
  await anna('POST', 'events', { calendarId: cal.id, title: 'Zahnarzt', allDay: false, start: L.at(today, '10:00'), end: L.at(today, '11:00') });
  const p = portal(host, ANNA);
  try {
    await until('the foot', () => p.byLabel('Kalender'));
    click(p.byLabel('Kalender'));
    await until('the menu', () => p.byLabel('Kalender „Privat“ einstellen'));
    click(p.byLabel('Kalender „Privat“ einstellen'));
    await until('the dialog', () => p.byText('button', 'Teilen'));
    click(p.byText('button', 'Teilen'));
    await until('the share dialog', () => p.dialogText().includes('Person oder Gruppe hinzufügen') && p.dialogText().includes('Noch mit niemandem geteilt.'));
    assert.ok(p.dialogText().includes('Frei/Gebucht für alle in GateControl') && p.dialogText().includes('Mit mir geteilt'));
    type(p.byLabel('Person oder Gruppe hinzufügen'), 'Mar');
    await until('Marc found', () => p.all().find((x) => x.localName === 'button' && textOf(x) === 'Marc' && x.parentNode.className === 'mp-sugglist'));
    click(p.all().find((x) => x.localName === 'button' && textOf(x) === 'Marc' && x.parentNode.className === 'mp-sugglist'));
    await until('shared', () => p.dialogText().includes('Einladung offen'));
    const post = p.calls.find((x) => x.method === 'POST' && x.path === `calendars/${cal.id}/shares`);
    assert.deepEqual(post.body, { type: 'user', id: MARC.id, level: 'read' });
    // the switch „Frei/Gebucht für alle in GateControl“
    const sw = p.byLabel('Frei/Gebucht für alle in GateControl');
    sw.checked = false;
    sw.dispatchEvent({ type: 'change' });
    await until('saved', async () => (await anna('GET', 'calendars')).json.prefs.freeBusy === false);
  } finally { p.stop(); }
  const m = portal(host, MARC);
  try {
    await until('the foot', () => m.byLabel('Kalender'));
    click(m.byLabel('Kalender'));
    await until('Mit mir geteilt', () => m.text('mp-nav').includes('Mit mir geteilt') && m.text('mp-nav').includes('Privat · von Anna'));
    click(m.all().find((x) => x.localName === 'button' && x.className === 'mp-row' && textOf(x).includes('Privat · von Anna')));
    await until('shown', () => m.text('mp-list').includes('Zahnarzt'));
    assert.deepEqual(m.calls.find((x) => x.method === 'PATCH' && x.path === `shared/${cal.id}`).body, { visible: true });
    assert.equal((await anna('GET', `calendars/${cal.id}/shares`)).json.items[0].state, 'accepted');
  } finally { m.stop(); }
}));

test('the tab „Ressourcen“ of the plugin\'s page: the list, a new resource with approvers and rules, „kommt später“; the card on the settings page', () => withMail({ gatecontrol: '1.219.0', groups: GROUPS }, async (host, c) => {
  await c.admin('POST', 'admin/resources', { name: 'Beamer', kind: 'device', location: 'Lager EG' });
  const p = portal(host, null, { admin: true, page: 'resources', pick: [{ type: 'group', id: 7, label: 'Fuhrpark' }] });
  try {
    const page = () => p.text('ma-page');
    await until('the list', () => page().includes('Beamer') && page().includes('Gerät · Lager EG'));
    assert.ok(page().includes('Mit Skoda-Plugin verknüpfen') && page().includes('Aus Microsoft 365') === false && page().includes('kommt später'));
    assert.ok(!p.byText('button', 'Aus Microsoft 365 importieren'), 'no dead buttons');
    click(p.byText('button', '+ Ressource anlegen'));
    await until('the editor', () => page().includes('Neue Ressource'));
    type(p.byLabel('Name'), 'Firmenwagen Kombi');
    click(p.byText('button', 'Fahrzeug'));
    type(p.byLabel('Plätze'), '5');
    click(p.byText('button', 'Freigabe durch'));
    await until('approvers', () => page().includes('Personen und Gruppen; wer zuerst entscheidet'));
    const choose = p.all().filter((x) => x.localName === 'button' && textOf(x) === 'Auswählen').pop();
    click(choose);
    await until('Fuhrpark', () => page().includes('Fuhrpark'));
    const max = p.byLabel('Höchstdauer');
    max.value = '1440';
    max.dispatchEvent({ type: 'change' });
    click(p.byText('button', 'Speichern'));
    await until('saved', () => p.calls.some((x) => x.method === 'POST' && x.path === 'admin/resources'));
    const b = p.calls.find((x) => x.method === 'POST' && x.path === 'admin/resources').body;
    assert.deepEqual([b.name, b.kind, b.seats, b.approval, b.approvers, b.rules.maxMinutes], ['Firmenwagen Kombi', 'vehicle', 5, 'approval', [{ type: 'group', id: 7, label: 'Fuhrpark' }], 1440]);
    await until('in the list', () => page().includes('Fahrzeug · 5 Personen'));
    assert.equal((await c.admin('GET', 'admin/resources')).json.items.length, 2);
  } finally { p.stop(); }
  const nav = [];
  const s = portal(host, null, { admin: true, page: 'settings', navigate: (id) => nav.push(id) });
  try {
    const page = () => s.text('ma-page');
    await until('the card', () => page().includes('Ressourcen buchen') && page().includes('Frei/Gebucht in GateControl') && page().includes('Kalender teilen'));
    click(s.byText('button', 'Zum Reiter Ressourcen'));
    assert.deepEqual(nav, ['resources']);
  } finally { s.stop(); }
}));
