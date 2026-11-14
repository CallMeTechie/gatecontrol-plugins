'use strict';

// The portal tab (ui/portal.js) in a small DOM (fake-dom.js) against the plugin: the menu with counts, „Mein Tag“ with
// an item of another plugin, the quick entry, the details of a task, a note with a check box, „Einstellungen“ (1.2.0:
// „Quellen“ and „Umziehen“ in it); the ⋯ menu of a list, sharing with roles, deleting with „Rückgängig“, the list day card.
// And the page itself: every script compiles, every text key the page uses exists in both languages.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../server/ui');
const texts = require('../server/texts.json');
const { createWindow } = require('./fake-dom');
const { withHost, item, ANNA } = require('./helpers');

const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2000) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));

function portal(host, user) {
  const calls = [];
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
  };
  const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true } }), gc);
  f.window.navigator = { userAgent: 'test' };
  f.window.document.createElement('template');
  f.run();
  const doc = f.document;
  const byText = (tag, text) => doc.body.all().filter((x) => x.localName === tag && textOf(x).trim().startsWith(text)).pop();
  return { f, doc, calls, byText, text: (id) => textOf(doc.getElementById(id)), stop: () => f.stop() };
}

test('the page: scripts compile, every text key exists in de and en', () => {
  const html = ui.render({ view: 'portal', lang: 'en' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 8);
  for (const s of scripts) new vm.Script(s);
  const js = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'ui', 'places.js'), 'utf8');
  const keys = new Set([...js.matchAll(/T\('([a-z0-9_.-]*[a-z0-9])'/g)].map((m) => m[1]));
  for (const k of keys) { assert.ok(texts.de[k] != null, 'de ' + k); assert.ok(texts.en[k] != null, 'en ' + k); }
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
  assert.match(html, /window\.NA_CTX=/);
  assert.ok(!/<\/script>[^<]*<\/script>/.test(html.slice(0, 50)));
});

test('portal: Mein Tag with an item from Mail, the quick entry, a task, a note, Einstellungen', async () => {
  const h = await withHost();
  let p;
  try {
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt anrufen', due: { date: '2026-11-08', time: '14:00' }, important: true });
    await h.push('gatecontrol-mail', { upsert: [item('gatecontrol-mail', 'm:1', { title: 'Angebot von ACME beantworten', subtitle: 'Zu tun aus „Ihr Angebot“' })] });
    await h.ok(ANNA, 'POST', 'notes', { title: 'Werkstatt Montag', body: 'Winterreifen\n- [ ] Ölfilter bestellen\n#auto' });
    p = portal(h.host, ANNA);
    await until('the menu', () => /Mein Tag/.test(p.text('na-nav')) && /Aus anderen Plugins/.test(p.text('na-nav')));
    await until('the list', () => /Zahnarzt anrufen/.test(p.text('na-main')) && /Angebot von ACME/.test(p.text('na-main')));
    assert.match(p.text('na-main'), /Sonntag, 8\. November/);
    assert.match(p.text('na-main'), /Mail/);
    // the quick entry
    const q = p.doc.getElementById('na-quick');
    q.value = 'Morgen 9 Uhr Reifen wechseln wichtig';
    q.dispatchEvent({ type: 'input' });
    assert.match(textOf(q.parentNode.parentNode), /morgen, 09:00/);
    q.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await until('the new task', () => p.calls.some((c) => c.method === 'POST' && c.path === 'tasks' && c.body.text === 'Morgen 9 Uhr Reifen wechseln wichtig'));
    await until('it is listed', () => /Reifen wechseln/.test(p.text('na-main')));
    // a task's details
    const row = p.doc.body.all().filter((x) => x.className === 'na-item' && /Zahnarzt anrufen/.test(textOf(x)))[0];
    row.dispatchEvent({ type: 'click' });
    await until('the details', () => /Unteraufgaben/.test(p.text('na-side')) && /Erinnerung/.test(p.text('na-side')));
    // the item of Mail: its details point back to Mail
    const it = p.doc.body.all().filter((x) => /^na-item/.test(x.className) && /Angebot von ACME/.test(textOf(x)))[0];
    it.dispatchEvent({ type: 'click' });
    await until('the item', () => /Aus Mail/.test(p.text('na-side')));
    // notes
    p.byText('button', 'Alle Notizen').click();
    await until('the notes', () => /Werkstatt Montag/.test(p.text('na-main')));
    p.byText('button', 'Werkstatt Montag').click();
    await until('the note', () => p.doc.body.all().some((x) => x.className === 'nm-box'));
    const box = p.doc.body.all().find((x) => x.className === 'nm-box');
    box.checked = true;
    box.dispatchEvent({ type: 'change' });
    await until('ticked', () => p.calls.some((c) => c.path.endsWith('/check') && c.body.done === true));
    // 1.2.0: „Einstellungen“ (the gear at the bottom left) holds what were „Quellen“ and „Umziehen“
    p.doc.body.all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === 'Einstellungen').click();
    await until('Einstellungen', () => /Aufgaben aus anderen Plugins/.test(p.text('na-main')) && /Aufgaben der Kinder zeigen/.test(p.text('na-main')));
    assert.match(p.text('na-main'), /Uhrzeiten für die Schnell-Eingabe/);
    assert.match(p.text('na-main'), /Einkaufstag am Morgen/);
    await until('Umziehen', () => /Microsoft To Do/.test(p.text('na-main')) && /Synology DS Note/.test(p.text('na-main')));
    await until('To Do without Mail', () => /Dafür braucht es Mail|nicht erreichbar|kein Microsoft-Konto/.test(p.text('na-main')));
  } finally { if (p) p.stop(); await h.close(); }
});

test('portal 1.2.0: the ⋯ menu of a list, its days, sharing with roles, the list day card, deleting with „Rückgängig“, a read member', async () => {
  const { MARC } = require('./helpers');
  const h = await withHost();
  let p;
  let m;
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Einkaufsliste' });
    for (const x of ['Milch', 'Brot']) await h.ok(ANNA, 'POST', 'tasks', { title: x, listId: l.list.id });
    p = portal(h.host, ANNA);
    const byAria = (doc, label) => doc.body.all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === label);
    const menuItem = (doc, text) => doc.body.all().find((x) => x.getAttribute('role') === 'menuitem' && textOf(x).startsWith(text));
    await until('the list in the menu', () => /Meine Listen/.test(p.text('na-nav')) && /Einkaufsliste/.test(p.text('na-nav')));
    // ⋯ → Bearbeiten: symbol and Sunday (today) as its day
    byAria(p.doc, 'Mehr zu „Einkaufsliste“').click();
    assert.equal(p.doc.getElementById('na-pop').hidden, false);
    menuItem(p.doc, 'Bearbeiten').click();
    await until('the dialog', () => /In „Mein Tag“ zeigen an/.test(p.text('na-dialog')));
    byAria(p.doc, 'Einkauf').click();
    byAria(p.doc, 'Sonntag').click();
    assert.match(p.text('na-dialog'), /Jeden Sonntag steht die Liste oben in „Mein Tag“\./);
    p.byText('button', 'Speichern').click();
    await until('saved', () => p.calls.some((c) => c.method === 'PATCH' && c.path === 'lists/' + l.list.id && c.body.icon === 'cart' && c.body.days.join() === '7'));
    // the card at the top of „Mein Tag“
    await until('the list day card', () => /Heute ist Einkaufstag/.test(p.text('na-main')) && /Einkaufsliste – 2 offen/.test(p.text('na-main')));
    // sharing: Marc may only look
    byAria(p.doc, 'Mehr zu „Einkaufsliste“').click();
    menuItem(p.doc, 'Teilen').click();
    await until('the share dialog', () => /Wer hat Zugriff/.test(p.text('na-dialog')));
    const add = p.doc.body.all().filter((x) => x.localName === 'button' && textOf(x) === 'Hinzufügen').find((b) => /Marc Berg/.test(textOf(b.parentNode)));
    add.click();
    await until('Marc added', () => p.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/members') && c.body.members.some((x) => x.id === MARC.id && x.role === 'write')));
    await until('his role', () => p.doc.body.all().some((x) => x.localName === 'select' && x.getAttribute('aria-label') === 'Recht von Marc Berg'));
    const role = p.doc.body.all().find((x) => x.localName === 'select' && x.getAttribute('aria-label') === 'Recht von Marc Berg');
    role.value = 'read';
    role.dispatchEvent({ type: 'change' });
    await until('read', () => p.calls.some((c) => c.method === 'PUT' && c.body.members.some((x) => x.id === MARC.id && x.role === 'read')));
    p.byText('button', 'Fertig').click();
    // Marc's view: no quick entry, greyed boxes, „Geteilt von Anna“
    m = portal(h.host, MARC);
    await until('Marc sees the list', () => /Einkaufsliste/.test(m.text('na-nav')));
    m.doc.body.all().find((x) => x.localName === 'button' && /^na-row/.test(x.className) && textOf(x).startsWith('Einkaufsliste')).click();
    await until('the shared list', () => /Geteilt von Anna/.test(m.text('na-main')) && /Du kannst nur ansehen/.test(m.text('na-main')) && /Milch/.test(m.text('na-main')));
    assert.equal(m.doc.getElementById('na-quick'), null);
    assert.ok(m.doc.body.all().filter((x) => /^na-ck/.test(x.className)).every((x) => x.disabled));
    // delete: open tasks to „Aufgaben“, then „Rückgängig“
    byAria(p.doc, 'Mehr zu „Einkaufsliste“').click();
    menuItem(p.doc, 'Liste löschen').click();
    await until('the question', () => /Die Liste hat 2 offene und 0 erledigte Aufgaben\. Marc sieht die Liste danach nicht mehr\./.test(p.text('na-dialog')));
    assert.match(p.text('na-dialog'), /In „Aufgaben“ verschieben/);
    p.doc.body.all().filter((x) => x.localName === 'button' && textOf(x) === 'Liste löschen').pop().click();
    await until('deleted', () => p.calls.some((c) => c.method === 'DELETE' && c.path === 'lists/' + l.list.id && c.query.tasks === 'move'));
    await until('the snack', () => /„Einkaufsliste“ gelöscht/.test(p.text('na-snack')));
    p.byText('button', 'Rückgängig').click();
    await until('restored', () => p.calls.some((c) => c.method === 'POST' && c.path === `lists/${l.list.id}/restore`));
    await until('back in the menu', () => /Einkaufsliste/.test(p.text('na-nav')));
  } finally { if (p) p.stop(); if (m) m.stop(); await h.close(); }
});

test('portal 1.3.0: the card „Gestern offen geblieben“ with its three buttons, the signs „Erinnerung“ and „im Kalender“, the chip of the quick entry, the person\'s switches', async () => {
  const { fakeSource, PLUGINS, clock, T0 } = require('./helpers');
  // Mail with the calendar services (a stand-in that takes every event)
  let next = 100;
  const provides = Object.fromEntries(['calendar_tasks', 'calendar_add', 'calendar_update', 'calendar_delete'].map((s) => [s, { label: { de: 'x', en: 'x' }, maxPerHour: 3600 }]));
  const mail = fakeSource('gatecontrol-mail', { provides, service: async ({ name, payload }) => {
    if (name === 'calendar_tasks') return { ok: true, calendar: { id: 7, name: 'Aufgaben', color: '#123456', created: false } };
    if (name === 'calendar_add') return { ok: true, eventId: next++ };
    if (name === 'calendar_update') return { ok: true, eventId: payload.eventId };
    return { ok: true, removed: true };
  } });
  const h = await withHost({ now: Date.parse('2026-11-18T09:00:00Z'), sources: PLUGINS.map((x) => (x === 'gatecontrol-mail' ? mail : fakeSource(x))) });
  let p;
  try {
    const screws = await h.ok(ANNA, 'POST', 'tasks', { title: 'Schrauben kaufen', due: { date: '2026-11-18' } });
    const recipe = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rezept abholen', due: { date: '2026-11-18', time: '17:00' } });
    const old = await h.ok(ANNA, 'POST', 'tasks', { title: 'Schon länger offen', due: { date: '2026-11-10' } });
    clock.set(Date.parse('2026-11-19T07:00:00Z'));
    await h.ok(ANNA, 'POST', 'tasks', { text: 'heute 15 Uhr Mülltonne rausstellen' });
    p = portal(h.host, ANNA);
    const main = () => p.doc.getElementById('na-main');
    const cards = () => main().all().filter((x) => /(?:^| )na-card(?: |$)/.test(x.getAttribute('class') || ''));
    const card = () => cards().find((x) => /(?:^| )na-yest(?: |$)/.test(x.getAttribute('class') || ''));
    const rows = () => card().childNodes.slice(1).map((r) => textOf(r));
    await until('the card with the names of the lists', () => card() && textOf(card()).includes('Rezept abholenAufgaben'));
    assert.equal(textOf(card().childNodes[0]), 'Gestern offen geblieben2Alle heute');
    assert.deepEqual(rows(), ['Schrauben kaufenAufgabenErledigtHeuteVerschieben', 'Rezept abholenAufgabengestern 17:00ErledigtHeuteVerschieben']);
    // its tasks are not shown a second time under „Überfällig“ — what is older stays there
    const overdue = cards().find((x) => textOf(x.childNodes[0]).startsWith('Überfällig'));
    assert.equal(textOf(overdue), 'Überfällig1Schon länger offenPrivat › AufgabenDi. 10. Nov.');
    // the task of today: a reminder to come and its event in the calendar
    const today = cards().find((x) => textOf(x.childNodes[0]).startsWith('Heute'));
    assert.match(textOf(today), /^Heute1Mülltonne rausstellenPrivat › AufgabenErinnerungim Kalender15:00$/);
    // the quick entry names the calendar for a task with a time, not for one without
    const q = p.doc.getElementById('na-quick');
    const chips = () => textOf(q.parentNode.parentNode.childNodes[1]);
    q.value = 'morgen 9 Uhr Altglas wegbringen';
    q.dispatchEvent({ type: 'input' });
    assert.equal(chips(), 'morgen, 09:00Erinnerung 09:00Kalender: Aufgaben');
    q.value = 'morgen Altglas wegbringen';
    q.dispatchEvent({ type: 'input' });
    assert.equal(chips(), 'morgen');
    q.value = '';
    q.dispatchEvent({ type: 'input' });
    // „Heute“ on one row, then „Verschieben“ › „Am Wochenende“ on the other — the card empties
    const button = (row, label) => card().childNodes[row].all().find((x) => x.localName === 'button' && textOf(x) === label);
    button(1, 'Heute').dispatchEvent({ type: 'click', stopPropagation() {} });
    await until('moved to today', () => p.calls.some((c) => c.method === 'POST' && c.path === `tasks/${screws.task.id}/move` && c.body.to === 'today'));
    await until('one row left', () => card() && rows().length === 1);
    button(1, 'Verschieben').dispatchEvent({ type: 'click', stopPropagation() {} });
    const item = await until('the menu', () => p.doc.body.all().find((x) => x.getAttribute && x.getAttribute('role') === 'menuitem' && textOf(x).startsWith('Am Wochenende')));
    assert.deepEqual(p.doc.body.all().filter((x) => x.getAttribute && x.getAttribute('role') === 'menuitem').map((x) => textOf(x)), ['MorgenFr. 20. Nov.', 'Am WochenendeSa. 21. Nov.', 'Anderes Datum …']);
    item.click();
    await until('moved to the weekend', () => p.calls.some((c) => c.path === `tasks/${recipe.task.id}/move` && c.body.to === 'weekend'));
    await until('the card is gone', () => !card());
    assert.deepEqual((await h.ok(ANNA, 'GET', 'tasks/' + recipe.task.id)).task.due, { date: '2026-11-21', time: '17:00' });
    assert.ok(old.task.id);
    // „Einstellungen“: the morning hint with its time, the calendar switch
    p.doc.body.all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === 'Einstellungen').click();
    await until('Einstellungen', () => p.text('na-main').includes('Uhrzeit des Morgen-Hinweises'));
    for (const label of ['Morgens: „Gestern offen geblieben“', 'Aufgaben mit Uhrzeit in meinen Kalender „Aufgaben“ eintragen']) assert.ok(p.text('na-main').includes(label), label);
    const sw = p.doc.body.all().find((x) => x.localName === 'input' && x.getAttribute('aria-label') === 'Aufgaben mit Uhrzeit in meinen Kalender „Aufgaben“ eintragen');
    sw.checked = false;
    sw.dispatchEvent({ type: 'change' });
    await until('saved', () => p.calls.some((c) => c.method === 'PUT' && c.path === 'prefs' && c.body.calendar && c.body.calendar.tasks === false));
    const at = p.doc.body.all().find((x) => x.localName === 'input' && x.getAttribute('aria-label') === 'Uhrzeit des Morgen-Hinweises');
    assert.equal(at.value, '07:30');
    at.value = '06:45';
    at.dispatchEvent({ type: 'change' });
    await until('the time saved', async () => (await h.ok(ANNA, 'GET', 'prefs')).prefs.yesterdayAt === '06:45');
    assert.equal((await h.ok(ANNA, 'GET', 'prefs')).prefs.calendar.tasks, false);
  } finally { if (p) p.stop(); await h.close(); clock.set(T0); }
});

test('portal 1.4.0: the shopping lists in the menu, the list at the task, the chip of the quick entry, ticking the last item with „Rückgängig“', async () => {
  const { MARC, clock, T0 } = require('./helpers');
  const shopping = require('../server/shopping');
  const h = await withHost({ now: Date.parse('2026-11-14T09:00:00Z') });
  shopping.state.noTimer = true;
  const L1 = '6f1c2a90-1111-4c1d-9a00-000000000001';
  const I = (n) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let p;
  try {
    await h.ok(ANNA, 'POST', 'shopping/ops', { ops: [{ op: 'list_add', id: L1, name: 'Einkauf', icon: 'cart' }, { op: 'item_add', id: I(1), listId: L1, text: 'Milch', qty: '2 l' }, { op: 'item_add', id: I(2), listId: L1, text: 'Brot' }] });
    const lid = (await h.ok(ANNA, 'GET', 'shopping')).lists[0].listId;
    await h.ok(ANNA, 'PUT', `lists/${lid}/members`, { members: [MARC.id] });
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Bei Lidl einkaufen', attachedListId: lid, myDay: true });
    p = portal(h.host, ANNA);
    const main = () => p.doc.getElementById('na-main');
    await until('the menu', () => p.text('na-nav').includes('EinkaufslistenEinkauf2'));
    await until('the task with its list', () => p.text('na-main').includes('Bei Lidl einkaufenPrivat › AufgabenEinkauf 0/2'));
    // the quick entry asks the server: „einkaufen“ fits the list „Einkauf“; the chip can be taken away
    const q = p.doc.getElementById('na-quick');
    const chips = () => textOf(q.parentNode.parentNode.childNodes[1]);
    q.value = 'morgen bei Lidl einkaufen';
    q.dispatchEvent({ type: 'input' });
    // 1.5.0: „bei Lidl“ is offered as a place as well (a chip to choose from; nothing is taken without a choice)
    await until('the chip', () => chips() === 'morgenListe: Einkauf · 2 offenOrt: Lidl …');
    assert.deepEqual(p.calls.filter((c) => c.path === 'parse').map((c) => c.body), [{ text: 'morgen bei Lidl einkaufen', area: 'private' }]);
    q.dispatchEvent({ type: 'keydown', key: 'Enter' });
    const made = await until('made with the list', () => p.calls.find((c) => c.method === 'POST' && c.path === 'tasks'));
    assert.deepEqual(made.body, { text: 'morgen bei Lidl einkaufen', area: 'private', createList: false, attachedListId: lid, myDay: true });
    // the details: „Angehängte Liste“ with the person's shopping lists
    main().all().find((x) => x.localName === 'span' && textOf(x) === 'Bei Lidl einkaufen').parentNode.parentNode.dispatchEvent({ type: 'click' });
    const sel = await until('the row in the details', () => p.doc.getElementById('na-side').all().find((x) => x.localName === 'select' && x.getAttribute('aria-label') === 'Angehängte Liste'));
    assert.deepEqual(sel.childNodes.map((o) => textOf(o)), ['Keine', 'Einkauf · geteilt · 2 offen', 'Neue Liste …']);
    assert.equal(sel.value, String(lid));
    // the list: its task and how far it is, the items; the last one ticked completes the task — with „Rückgängig“
    p.doc.getElementById('na-nav').all().find((x) => x.localName === 'button' && textOf(x).startsWith('Einkauf') && !textOf(x).startsWith('Einkaufsl')).click();
    await until('the list', () => p.text('na-main').includes('gehört zu „Bei Lidl einkaufen“ · 0 von 2'));
    assert.ok(p.text('na-main').startsWith('EinkaufMBgeteilt mit Marcgehört zu'), p.text('na-main').slice(0, 60));
    const boxes = () => main().all().filter((x) => x.localName === 'button' && /^Abhaken: /.test(x.getAttribute('aria-label') || ''));
    assert.deepEqual(boxes().map((b) => b.getAttribute('aria-label')), ['Abhaken: Milch', 'Abhaken: Brot']);
    boxes()[0].click();
    await until('one ticked', async () => (await h.ok(ANNA, 'GET', 'shopping')).lists[0].open === 1);
    await until('drawn again', () => boxes().length === 1 && p.text('na-main').includes('Abgehakt1'));
    boxes()[0].click();
    await until('the task is done', async () => (await h.ok(ANNA, 'GET', 'tasks/' + t.task.id)).task.done === true);
    const snack = await until('the message', () => (p.text('na-snack').startsWith('Alles abgehakt. „') ? p.doc.getElementById('na-snack') : null));
    assert.match(textOf(snack), /^Alles abgehakt\. „(?:Bei Lidl einkaufen|morgen bei Lidl einkaufen|bei Lidl einkaufen)“ ist erledigt\.Rückgängig$/);
    snack.all().find((x) => x.localName === 'button').click();
    await until('undone', () => p.calls.some((c) => c.method === 'POST' && /^tasks\/\d+\/complete$/.test(c.path) && c.body.done === false));
    assert.deepEqual((await h.ok(ANNA, 'GET', 'shopping')).items.map((i) => i.checked), [true, true], 'the items stay ticked');
  } finally { if (p) p.stop(); await h.close(); clock.set(T0); }
});

test('portal 1.5.0: the place of a task — the chip of the quick entry, the dialog „Ort“ with the places near, the row in the details, „Einstellungen“ › Orte', async () => {
  const { clock, T0 } = require('./helpers');
  const fakes = require('./placefakes');
  const search = require('../server/placesearch');
  const h = await fakes.host();
  let p;
  try {
    p = portal(h.host, ANNA);
    await until('the page', () => p.doc.getElementById('na-quick'));
    const q = p.doc.getElementById('na-quick');
    const chipBox = () => q.parentNode.parentNode.childNodes[1];
    const dlg = () => p.doc.getElementById('na-dialog');
    const rows = () => dlg().all().filter((x) => x.localName === 'button' && /(^| )na-pl( |$)/.test(x.className));
    const button = (root, text) => root.all().filter((x) => x.localName === 'button' && textOf(x).trim() === text).pop();
    // a kind of place: a chip to choose from — nothing is searched while typing
    q.value = 'beim Baumarkt Schrauben kaufen';
    q.dispatchEvent({ type: 'input' });
    await until('the chip', () => textOf(chipBox()) === 'Ort: Baumarkt …');
    assert.equal(h.net.calls.length, 0);
    chipBox().all().find((x) => x.localName === 'button').click();
    // the dialog: „Welcher Baumarkt?“ — searched near „Zuhause“ (the family's home), the nearest first, minutes and distance
    await until('the hits', () => rows().length >= 4);
    assert.equal(dlg().hidden, false);
    assert.match(textOf(dlg()), /^Welcher Baumarkt\?/);
    assert.deepEqual(rows().map((r) => textOf(r)).slice(0, 4), [
      'Baumarkt NordIndustriestraße 4, Berlin' + '6 Min.2,3 km', 'Baumarkt am RingRingstraße 21, Berlin' + '10 Min.3,9 km', 'Baumarkt SüdAm Hafen 2, Berlin' + '22 Min.8,6 km', 'Jeder BaumarktErinnert an der ersten Filiale, an der du ankommst']);
    assert.equal(rows()[0].getAttribute('aria-pressed'), 'true', 'the nearest is chosen');
    assert.match(textOf(dlg()), /Meine OrteZuhauseOrt der FamilieSchuleOrt der Familie/);
    assert.match(textOf(dlg()), /Fahrzeit geschätzt aus der Entfernung\. Kartendaten: © OpenStreetMap/);
    assert.deepEqual(p.calls.filter((c) => c.path === 'places/search').map((c) => c.body), [{ key: 'kind:diy', label: 'Baumarkt', nearFamilyId: 'home' }]);
    // the second one, on leaving, remembered
    rows()[1].click();
    button(dlg(), 'Beim Verlassen').click();
    const rem = dlg().all().find((x) => x.localName === 'input' && x.getAttribute('id') === 'na-pl-rem');
    assert.equal(textOf(rem.parentNode), 'Als meinen Ort für „Baumarkt“ merken');
    rem.checked = true;
    rem.dispatchEvent({ type: 'change' });
    button(dlg(), 'Speichern').click();
    await until('the chip of the chosen place', () => textOf(chipBox()) === 'Baumarkt am Ring · beim Verlassen');
    q.dispatchEvent({ type: 'keydown', key: 'Enter' });
    const made = await until('made', () => p.calls.find((c) => c.method === 'POST' && c.path === 'tasks'));
    assert.deepEqual(made.body.place, { trigger: 'exit', key: 'kind:diy', label: 'Baumarkt', remember: true, ref: 'osm:W102', name: 'Baumarkt am Ring', address: 'Ringstraße 21, Berlin', lat: 52.501, lon: 13.362 });
    await until('in the list', () => /Schrauben kaufen/.test(p.text('na-main')) && /Baumarkt am Ring/.test(p.text('na-main')));
    // next time the remembered one is there without asking; the chip can be taken away
    q.value = 'beim Baumarkt Dübel holen';
    q.dispatchEvent({ type: 'input' });
    await until('the remembered place', () => textOf(chipBox()) === 'Baumarkt am Ring · beim Ankommen');
    chipBox().all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === 'Ohne Ort').click();
    assert.equal(textOf(chipBox()), '');
    q.dispatchEvent({ type: 'keydown', key: 'Enter' });
    const plain = await until('made without a place', () => p.calls.filter((c) => c.method === 'POST' && c.path === 'tasks')[1]);
    assert.equal(plain.body.place, undefined);
    // the details: the row „Ort“, the dialog again with the place chosen, taken away with „Ohne Ort“
    await until('the row', () => /Schrauben kaufen/.test(p.text('na-main')));
    p.doc.getElementById('na-main').all().find((x) => x.localName === 'span' && textOf(x) === 'Schrauben kaufen').parentNode.parentNode.dispatchEvent({ type: 'click' });
    const open = await until('the row in the details', () => p.doc.getElementById('na-side').all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === 'Ort ändern: Baumarkt am Ring'));
    assert.equal(textOf(open), 'Baumarkt am Ring · beim Verlassen');
    open.click();
    await until('the dialog', () => rows().some((r) => textOf(r).startsWith('Baumarkt am Ring') && r.getAttribute('aria-pressed') === 'true'));
    assert.match(textOf(dlg()), /Baumarkt am RingRingstraße 21, Berlin · gemerkt für „Baumarkt“/);
    button(dlg(), 'Ohne Ort').click();
    await until('taken away', () => p.calls.some((c) => c.method === 'PATCH' && c.body && c.body.place === null));
    await until('the row again', () => p.doc.getElementById('na-side').all().some((x) => x.localName === 'button' && textOf(x) === 'Ort wählen'));
    // „Einstellungen“ › Orte: the switches and „Meine Orte“
    p.doc.body.all().find((x) => x.localName === 'button' && x.getAttribute('aria-label') === 'Einstellungen').click();
    await until('the card', () => /Meine OrteNeuen Ort merken/.test(p.text('na-main')) && /Baumarkt am Ring/.test(p.text('na-main')));
    const main = p.doc.getElementById('na-main');
    assert.match(textOf(main), /OrteOrtssuche im InternetFür „Welcher Baumarkt ist in der Nähe\?“/);
    assert.match(textOf(main), /Hinweis „in der Nähe“/);
    assert.match(textOf(main), /ZuhauseOrt der Familie/);
    assert.match(textOf(main), /Baumarkt am RingRingstraße 21, Berlin · gemerkt für „Baumarkt“/);
    const sw = main.all().find((x) => x.localName === 'input' && x.getAttribute('aria-label') === 'Ortssuche im Internet');
    assert.equal(sw.checked, true);
    sw.checked = false;
    sw.dispatchEvent({ type: 'change' });
    await until('saved', async () => (await h.ok(ANNA, 'GET', 'me')).places.search.state === 'off');
    // a new place of one's own: without the map (no Leaflet here) the coordinates by hand
    button(main, 'Neuen Ort merken').click();
    await until('the dialog', () => /^Neuen Ort merken/.test(textOf(dlg())) && /Karte lässt sich gerade nicht laden/.test(textOf(dlg())));
    const inp = (label) => dlg().all().find((x) => x.localName === 'input' && x.getAttribute('aria-label') === label);
    inp('Name').value = 'Oma';
    inp('Breite').value = '52.4';
    inp('Länge').value = '13.2';
    button(dlg(), 'Speichern').click();
    await until('saved', async () => (await h.ok(ANNA, 'GET', 'places')).places.some((x) => x.name === 'Oma' && x.named && x.lat === 52.4));
    await until('listed', () => /Oma/.test(p.text('na-places')));
  } finally { if (p) p.stop(); search.state.pauseMs = search.PAUSE_MS; await h.close(); clock.set(T0); }
});
