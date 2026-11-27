'use strict';

// 1.9.0 — „Termin“ in the portal tab (ui/portal.js) in a small DOM (fake-dom.js) against the plugin with a stand-in of
// Mail: the switch „Aufgabe | Termin“ of the quick entry, the question „Als Termin anlegen?“ (never switched by itself),
// the chips of an event (day, time, the place from „im …“ or offered from the title, the calendar, the reminder), Enter
// saves it in the calendar; without a calendar the reason and „Als Aufgabe mit Datum speichern“; the rows of events on
// „Mein Tag“ (no check box, a tap opens the event in Mail) and „Termine aus dem Kalender“ in the settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { createWindow } = require('./fake-dom');
const { withHost, fakeSource, ANNA, clock, T0, PLUGINS } = require('./helpers');
const { MAIL, eventItem, fakeMail } = require('./termine-helpers');

const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2000) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));

function portal(host, user) {
  const calls = [];
  const opened = [];
  const gc = {
    async call(method, p, body) {
      const [pth, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path: pth, query, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
      const r = await host.request({ method, path: pth, body: body === undefined ? null : body, query, user: { ...user, portal: true, loggedIn: true }, lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return r.json;
    },
    on() {},
    upload: async () => ({ mediaId: 'x' }),
    keys: { get: async () => null, put: async () => true },
    openPortal: async (o) => { opened.push(o); return { ok: true }; },
  };
  const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true } }), gc);
  f.window.navigator = { userAgent: 'test' };
  f.window.document.createElement('template');
  f.run();
  const doc = f.document;
  const all = () => doc.body.all();
  const byText = (tag, text, root) => (root || doc.body).all().filter((x) => x.localName === tag && textOf(x).trim() === text).pop();
  const quick = () => doc.getElementById('na-quick');
  const box = () => quick().parentNode.parentNode;
  const type = (v) => { quick().value = v; quick().dispatchEvent({ type: 'input' }); };
  return { f, doc, calls, opened, all, byText, quick, box, type, chips: () => textOf(box()), text: (id) => textOf(doc.getElementById(id)), stop: () => f.stop() };
}
const sourcesWith = (mail) => PLUGINS.map((p) => (p === MAIL && mail ? mail : fakeSource(p)));

test('portal: the quick entry as „Termin“ — the question, the chips, the place, the calendar, the reminder; Enter saves it in the calendar', async () => {
  const { m, source } = fakeMail();
  const h = await withHost({ sources: sourcesWith(source) });
  let p;
  try {
    p = portal(h.host, ANNA);
    await until('the page', () => p.quick());
    // nothing typed: no switch (the head stays as it was)
    assert.doesNotMatch(p.chips(), /Termin/);
    // a date and a time: the page asks — and stays a task until the person says so
    p.type('Freitag 4. Dezember 14 Uhr Fashion Outlet Zweibrücken');
    assert.match(p.chips(), /Das sieht wie ein Termin aus/);
    assert.match(p.chips(), /Erinnerung 14:00/, 'still the chips of a task');
    assert.equal(p.byText('button', 'Aufgabe', p.box()).getAttribute('aria-pressed'), 'true');
    p.byText('button', 'Als Termin anlegen', p.box()).click();
    await until('the calendars', () => /Kalender: Privat/.test(p.chips()));
    assert.equal(p.byText('button', 'Termin', p.box()).getAttribute('aria-pressed'), 'true');
    assert.match(p.chips(), /Fr\. 4\. Dez\./);
    assert.match(p.chips(), /14:00–15:00/);
    assert.match(p.chips(), /Ort: Fashion Outlet Zweibrücken\?/, 'the title offered as the place');
    assert.match(p.chips(), /15 Min\. vorher/);
    assert.match(p.chips(), /Titel: „Fashion Outlet Zweibrücken“/);
    assert.doesNotMatch(p.chips(), /Das sieht wie ein Termin aus|Erinnerung 14:00/);
    // one tap takes the title as the place; the chip opens the text field („Ort des Termins“)
    p.byText('button', 'Ort: Fashion Outlet Zweibrücken?', p.box()).click();
    assert.match(p.chips(), /Ort: Fashion Outlet Zweibrücken(?!\?)/);
    p.byText('button', 'Ort: Fashion Outlet Zweibrücken', p.box()).click();
    await until('the dialog', () => /Ort des Termins/.test(p.text('na-dialog')) && /keine Standort-Abfrage/.test(p.text('na-dialog')));
    const f = p.all().find((x) => x.localName === 'input' && x.getAttribute('aria-label') === 'Ort oder Adresse');
    assert.equal(f.value, 'Fashion Outlet Zweibrücken');
    f.value = 'Outlet, Halle 2';
    p.byText('button', 'Übernehmen').click();
    assert.match(p.chips(), /Ort: Outlet, Halle 2/);
    // another calendar, another reminder
    p.byText('button', 'Kalender: Privat', p.box()).click();
    await until('the menu', () => /Firma/.test(p.text('na-pop')) && !/Feiertage|Aufgaben|Familie/.test(p.text('na-pop')));
    p.byText('button', 'Firma').click();
    assert.match(p.chips(), /Kalender: Firma/);
    p.byText('button', '15 Min. vorher', p.box()).click();
    await until('the menu', () => /Wie im Kalender eingestellt/.test(p.text('na-pop')) && /Keine Erinnerung/.test(p.text('na-pop')));
    p.byText('button', '1 Stunde vorher').click();
    assert.match(p.chips(), /1 Stunde vorher/);
    // „Mehr Angaben …“: Mail's own form of a new event, filled in with all of it (nothing saved here)
    p.byText('button', 'Mehr Angaben …', p.box()).click();
    assert.deepEqual(JSON.parse(JSON.stringify(p.opened.at(-1))), { plugin: MAIL, query: { open: 'event/new', title: 'Fashion Outlet Zweibrücken', date: '2026-12-04', time: '14:00-15:00', loc: 'Outlet, Halle 2', cal: '8', rem: '60' } });
    assert.equal(m.events.size, 0);
    // Enter: one event in Mail, nothing in the task list
    p.quick().dispatchEvent({ type: 'keydown', key: 'Enter' });
    await until('saved', () => m.events.size === 1 && p.quick().value === '');
    const ev = [...m.events.values()][0];
    assert.deepEqual([ev.title, ev.allDay, ev.start, ev.end - ev.start, ev.location, ev.calendarId, ev.reminder], ['Fashion Outlet Zweibrücken', false, Date.parse('2026-12-04T13:00:00Z'), 3600000, 'Outlet, Halle 2', 8, 60]);
    assert.match(ev.key, /^event:[0-9a-f-]{8,}/);
    assert.equal(p.calls.filter((c) => c.method === 'POST' && c.path === 'tasks').length, 0);
    assert.match(p.text('na-toast'), /Termin gespeichert/);
    // no time, a place word: all day, the place out of the title, the all-day reminder of the calendar — the default calendar is not sent
    p.type('Freitag 4. Dezember Einkaufen im Fashion Outlet Zweibrücken');
    p.byText('button', 'Termin', p.box()).click();
    assert.match(p.chips(), /Ganztägig/);
    assert.match(p.chips(), /Ort: Fashion Outlet Zweibrücken(?!\?)/);
    assert.match(p.chips(), /Vortag, 18 Uhr/);
    assert.match(p.chips(), /Titel: „Einkaufen“/);
    p.byText('button', 'Mehr Angaben …', p.box()).click();
    assert.deepEqual(JSON.parse(JSON.stringify(p.opened.at(-1).query)), { open: 'event/new', title: 'Einkaufen', date: '2026-12-04', loc: 'Fashion Outlet Zweibrücken', cal: '7', rem: '360' });
    p.quick().dispatchEvent({ type: 'keydown', key: 'Enter' });
    await until('saved', () => m.events.size === 2);
    const b = m.calls.filter((c) => c.name === 'calendar_add').at(-1).payload;
    assert.deepEqual([b.title, b.allDay, b.startsAt, b.location, 'calendarId' in b, 'reminder' in b], ['Einkaufen', true, '2026-12-04', 'Fashion Outlet Zweibrücken', false, false]);
    // „Aufgabe lassen“: no more question for this line, Enter makes the task
    p.type('morgen 9 Uhr Reifen wechseln');
    p.byText('button', 'Aufgabe lassen', p.box()).click();
    assert.doesNotMatch(p.chips(), /Das sieht wie ein Termin aus/);
    p.quick().dispatchEvent({ type: 'keydown', key: 'Enter' });
    await until('the task', () => p.calls.some((c) => c.method === 'POST' && c.path === 'tasks' && c.body.text === 'morgen 9 Uhr Reifen wechseln'));
    assert.equal(m.events.size, 2);
    // a line without a date is no question
    p.type('Milch kaufen');
    assert.doesNotMatch(p.chips(), /Das sieht wie ein Termin aus/);
    assert.match(p.chips(), /Aufgabe/);
  } finally { if (p) p.stop(); await h.close(); clock.set(T0); }
});

test('portal: „Termin“ without a calendar — the switch stays, the reason, „Als Aufgabe mit Datum speichern“', async () => {
  // no Mail with the calendar services at all
  let h = await withHost({});
  let p;
  try {
    p = portal(h.host, ANNA);
    await until('the page', () => p.quick());
    p.type('Freitag 4. Dezember 14 Uhr Fashion Outlet Zweibrücken');
    p.byText('button', 'Termin', p.box()).click();
    await until('the note', () => /Kein Kalender vorhanden/.test(p.chips()));
    assert.match(p.chips(), /Termine brauchen den Kalender aus dem Plugin „Mail“/);
    // Enter does nothing here; the button makes the task with its date and time
    p.quick().dispatchEvent({ type: 'keydown', key: 'Enter' });
    await tick();
    assert.equal(p.calls.filter((c) => c.method === 'POST' && (c.path === 'tasks' || c.path === 'events')).length, 0);
    p.byText('button', 'Als Aufgabe mit Datum speichern', p.box()).click();
    const find = async () => (await h.ok(ANNA, 'GET', 'views/planned')).sections.flatMap((s) => s.items).find((x) => x.title === 'Fashion Outlet Zweibrücken');
    const t = await until('the task', find);
    assert.deepEqual([t.type, t.due], ['task', { date: '2026-12-04', time: '14:00' }]);
  } finally { if (p) p.stop(); await h.close(); clock.set(T0); }
  // Mail is there, but the calendar is off for the person
  const { m, source } = fakeMail();
  m.reason = 'not_allowed';
  h = await withHost({ sources: sourcesWith(source) });
  try {
    p = portal(h.host, ANNA);
    await until('the page', () => p.quick());
    p.type('Samstag Flohmarkt');
    p.byText('button', 'Termin', p.box()).click();
    await until('the note', () => /Der Kalender ist für dich nicht eingeschaltet/.test(p.chips()));
  } finally { if (p) p.stop(); await h.close(); clock.set(T0); }
});

test('portal: events on „Mein Tag“ — the calendar\'s sign instead of a check box, place and calendar, a tap opens the event in Mail; „Termine aus dem Kalender“', async () => {
  const { source } = fakeMail();
  const h = await withHost({ sources: sourcesWith(source) });
  let p;
  try {
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Paket abholen', due: { date: '2026-11-08' } });
    await h.push(MAIL, { upsert: [
      eventItem('ev:1', { title: 'Zahnarzt', due: '2026-11-08T16:30:00+01:00', end: '2026-11-08T17:15:00+01:00', location: 'Praxis am Markt', eventId: 1 }),
      eventItem('ev:3', { title: 'Fashion Outlet Zweibrücken', due: '2026-11-13T14:00:00+01:00', end: '2026-11-13T15:00:00+01:00', location: 'Fashion Outlet Zweibrücken', eventId: 3 }),
      eventItem('ov:familie:f1:2026-11-15', { title: 'Geburtstag Oma', due: '2026-11-15', cal: 'overlay:familie' }),
      eventItem('ev:7', { title: 'Buß- und Bettag', due: '2026-11-18', eventId: 7, cal: 'cal:9' }),
    ] });
    p = portal(h.host, ANNA);
    await until('the list', () => /Zahnarzt/.test(p.text('na-main')) && /Geburtstag Oma/.test(p.text('na-main')));
    const rows = () => p.all().filter((x) => /^na-item/.test(x.className));
    const row = (t) => rows().find((x) => textOf(x).includes(t));
    const z = row('Zahnarzt');
    assert.match(z.className, /is-event/);
    assert.ok(z.all().some((x) => x.className === 'na-ev-ic') && !z.all().some((x) => /na-ck\b/.test(x.className)), 'no check box');
    assert.match(textOf(z), /Praxis am Markt/);
    assert.match(textOf(z), /bis 17:15/);
    assert.match(textOf(z), /Privat/);
    assert.match(textOf(z), /16:30/);
    assert.doesNotMatch(textOf(z), /Mail/);
    assert.match(textOf(row('Geburtstag Oma')), /ganztägig.*Familie/);
    assert.equal(row('Buß- und Bettag'), undefined, 'a subscribed calendar is off');
    assert.ok(row('Paket abholen').all().some((x) => /na-ck\b/.test(x.className)), 'a task keeps its box');
    // a tap: Mail's own view of the event, not the side panel
    z.dispatchEvent({ type: 'click' });
    row('Geburtstag Oma').dispatchEvent({ type: 'click' });
    assert.deepEqual(JSON.parse(JSON.stringify(p.opened)), [{ plugin: MAIL, query: { open: 'event/1' } }, { plugin: MAIL, query: { open: 'calendar/2026-11-15' } }]);
    assert.equal(p.calls.filter((c) => /^items\//.test(c.path)).length, 0);
    // the settings: a switch per calendar; the subscribed one on, the family calendar off
    p.all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === 'Einstellungen').click();
    await until('the card', () => /Termine aus dem Kalender/.test(p.text('na-main')) && /Feiertage/.test(p.text('na-main')));
    const card = p.doc.getElementById('na-ev-cals');
    const sw = (name) => card.all().find((x) => x.localName === 'input' && x.getAttribute('aria-label') === name);
    assert.deepEqual(['Privat', 'Firma', 'Feiertage', 'Aufgaben', 'Familie'].map((n) => sw(n).checked), [true, true, false, false, true]);
    assert.match(textOf(card), /Standard für neue Termine/);
    assert.match(textOf(card), /abonniert/);
    assert.match(textOf(card), /stehen schon als Aufgabe da/);
    // the calendars of Mail are not listed a second time as groups of the source „Mail“
    assert.doesNotMatch(p.text('na-main'), /Privat \(\d+\)/);
    sw('Feiertage').checked = true;
    sw('Feiertage').dispatchEvent({ type: 'change' });
    sw('Familie').checked = false;
    sw('Familie').dispatchEvent({ type: 'change' });
    await until('saved', async () => { const g = (await h.ok(ANNA, 'GET', 'prefs')).prefs.groups; return g[`${MAIL}|cal:9`] === 'show' && g[`${MAIL}|overlay:familie`] === 'hide'; });
    const md = await h.ok(ANNA, 'GET', 'views/myday');
    assert.deepEqual(md.sections.find((s) => s.id === 'upcoming').items.map((x) => x.title), ['Fashion Outlet Zweibrücken', 'Buß- und Bettag']);
  } finally { if (p) p.stop(); await h.close(); clock.set(T0); }
});
