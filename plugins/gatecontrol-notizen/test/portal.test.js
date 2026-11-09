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
  assert.equal(scripts.length, 7);
  for (const s of scripts) new vm.Script(s);
  const js = fs.readFileSync(path.join(__dirname, '..', 'ui', 'portal.js'), 'utf8');
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
