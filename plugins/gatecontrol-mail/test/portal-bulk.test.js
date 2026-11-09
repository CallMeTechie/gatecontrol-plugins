'use strict';

// Mail 1.13.0 in the portal (fake-dom.js, mockup Mehrfachauswahl frame 6): a box per row, Shift-click for a range,
// „Alle N auswählen“ (all: true with the range of the list), the bar (archive with „Rückgängig“, delete asked when
// „Vor dem Löschen fragen“ is on — „Nicht mehr fragen“ —, for good in the trash always asked), the folder picker for
// move and copy (one account; several accounts: a note), read / flag; one mail of the reading pane moved; the settings
// „Wischen / Schnellaktionen“ and „Vor dem Löschen fragen“.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, app, ANNA } = require('./helpers');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');

const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));

/** The portal for `user` in the small DOM; every call of the page in `calls`. */
function portal(host, user) {
  const calls = [];
  const gc = {
    async call(method, p, body) {
      const [path, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path, query, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
      const r = await host.request({ method, path, body: body === undefined ? null : body, query, user: app(user), lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return r.json;
    },
    on() {},
  };
  const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true }, allowed: true }, t), gc);
  f.run();
  const doc = f.document;
  const el = (id) => doc.getElementById(id);
  const all = () => doc.body.all();
  const byLabel = (label, root) => (root || doc.body).all().filter((x) => x.getAttribute('aria-label') === label).pop();
  const byText = (tag, text, root) => (root || doc.body).all().filter((x) => x.localName === tag && textOf(x).trim() === text).pop();
  const rows = () => all().filter((x) => x.localName === 'div' && x.className.split(' ').includes('has-cb'));
  const row = (subject) => rows().find((x) => textOf(x).includes(subject));
  const box = (subject) => { const r = row(subject); assert.ok(r, 'no row ' + subject); return r.firstChild; };
  const last = (path) => calls.filter((x) => x.path === path).pop();
  return { f, doc, el, all, calls, byLabel, byText, rows, row, box, last, text: (id) => textOf(el(id)), stop: () => f.stop() };
}
const click = (x, what, ev) => { assert.ok(x, 'no ' + (what || 'element')); if (ev) x.dispatchEvent({ type: 'click', ...ev }); else x.click(); };

const FOLDERS = { Gesendet: '\\Sent', Entwürfe: '\\Drafts', Archiv: '\\Archive', Spam: '\\Junk', Papierkorb: '\\Trash', Rechnungen: null, 'Rechnungen/2026': null };
const SUBJECTS = ['Fotos vom Sommerfest', 'Abschlagsrechnung März', 'Jahreshauptversammlung', 'Ihr Paket kommt heute', 'Grillabend am Samstag'];

async function setup(c, o = {}) {
  c.mail.login('anna@gmx.de', 'geheim-123', { folders: FOLDERS });
  const now = Date.now();
  SUBJECTS.forEach((s, i) => c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: `Absender ${i}`, address: `a${i}@example.com` }, subject: s, text: s, date: now - (i + 1) * 60000, messageId: `<p${i}@example.com>` }));
  const acc = await c.addGmx(ANNA);
  if (o.second) {
    c.mail.login('anna@web.de', 'geheim-123');
    c.mail.mail('anna@web.de', 'INBOX', { subject: 'Vom Verein', text: 'x', date: now - 30000 });
    await c.addGmx(ANNA, { email: 'anna@web.de', name: 'Verein' });
  }
  await c.tick();
  return acc;
}

test('portal: a box per row, Shift-click for a range, the bar; archive with „Rückgängig“ (threads), „Alle N auswählen“ and read for all', () => withMail({}, async (host, c) => {
  const acc = await setup(c);
  const p = portal(host, ANNA);
  try {
    await until('the list', () => p.rows().length === 5);
    assert.ok(!p.byLabel('Aktionen für die ausgewählten Mails'), 'no bar without a selection');
    assert.equal(p.box(SUBJECTS[0]).getAttribute('role'), 'checkbox');
    assert.equal(p.box(SUBJECTS[0]).getAttribute('aria-label'), `Auswählen: ${SUBJECTS[0]}`);
    click(p.box(SUBJECTS[0]));
    await until('the bar', () => p.byLabel('Aktionen für die ausgewählten Mails'));
    // Shift-click: the range from the first one
    click(p.box(SUBJECTS[2]), 'third', { shiftKey: true });
    await until('3 selected', () => p.text('mp-list').includes('3 ausgewählt'));
    assert.deepEqual(p.rows().map((r) => r.firstChild.getAttribute('aria-checked')), ['true', 'true', 'true', 'false', 'false']);
    assert.ok(p.rows()[1].className.includes('is-sel'));
    const bar = p.byLabel('Aktionen für die ausgewählten Mails');
    for (const l of ['Archivieren', 'Löschen', 'Verschieben', 'Kopieren', 'Als gelesen markieren', 'Markieren', 'In Spam', 'Auswahl aufheben']) assert.ok(p.byLabel(l, bar), l);
    // the range's size (GET messages/ids) for „Alle 5 auswählen“
    await until('select all', () => p.byText('button', 'Alle 5 auswählen'));
    assert.deepEqual(p.last('messages/ids').query, { box: 'all', tab: 'relevant' });
    // archive: with threads (the conversation view is on), the snackbar with „Rückgängig“
    click(p.byLabel('Archivieren', bar));
    await until('archived', () => p.last('messages/archive'));
    const arch = p.last('messages/archive').body;
    assert.deepEqual([arch.ids.length, arch.threads], [3, true]);
    await until('the snackbar', () => !p.el('mp-snack').hidden && p.text('mp-snack').includes('3 Mails archiviert'));
    await until('the list without them', () => p.rows().length === 2);
    assert.ok(!p.byLabel('Aktionen für die ausgewählten Mails'), 'the selection is gone');
    assert.equal(c.mail.box('anna@gmx.de', 'Archiv').msgs.size, 3);
    click(p.byText('button', 'Rückgängig'));
    await until('undone', () => p.last('messages/undo'));
    await until('back', () => p.rows().length === 5);
    assert.equal(c.mail.box('anna@gmx.de', 'Archiv').msgs.size, 0);
    assert.ok(p.text('mp-toast').includes('Rückgängig gemacht'));
    // „Alle 5 auswählen“ then one out: read for all (all: true with the range, except)
    click(p.box(SUBJECTS[1]));
    click(await until('select all', () => p.byText('button', 'Alle 5 auswählen')));
    await until('all', () => p.text('mp-list').includes('Alle 5 Mails in „Posteingänge“') || p.text('mp-list').includes('Alle 5 Mails in'));
    click(p.box(SUBJECTS[4]));
    await until('4', () => p.text('mp-list').includes('Alle 4 Mails'));
    click(p.byLabel('Als gelesen markieren', p.byLabel('Aktionen für die ausgewählten Mails')));
    await until('read', () => p.last('messages/flags'));
    const fl = p.last('messages/flags').body;
    assert.equal(fl.all, true);
    assert.equal(fl.box, 'all');
    assert.equal(fl.tab, 'relevant');
    assert.deepEqual(fl.except.length, 1);
    assert.equal(fl.unread, false);
    assert.equal(fl.ids, undefined);
    await until('4 read', async () => (await c.list(ANNA, { box: String(acc.id) })).items.filter((m) => !m.unread).length === 4);
    // the box of the bar: all shown, then none
    click(p.box(SUBJECTS[0]));
    click(p.byLabel('Alle angezeigten auswählen'));
    await until('5', () => p.text('mp-list').includes('5 ausgewählt'));
    click(p.byLabel('Alle angezeigten auswählen'));
    await until('none', () => !p.byLabel('Aktionen für die ausgewählten Mails'));
    // Escape clears a selection
    click(p.box(SUBJECTS[0]));
    await until('1', () => p.text('mp-list').includes('1 ausgewählt'));
    p.doc._bubble({ type: 'keydown', key: 'Escape' });
    await until('cleared', () => !p.byLabel('Aktionen für die ausgewählten Mails'));
  } finally { p.stop(); }
}));

test('portal: delete — asked when „Vor dem Löschen fragen“ is on („Nicht mehr fragen“ turns it off), else at once with „Rückgängig“; in the trash always asked, for good', () => withMail({}, async (host, c) => {
  await setup(c);
  await c.as(ANNA)('PUT', 'settings', { confirmDelete: true });
  const p = portal(host, ANNA);
  try {
    await until('the list', () => p.rows().length === 5);
    click(p.box(SUBJECTS[0]));
    click(p.box(SUBJECTS[1]));
    click(p.byLabel('Löschen', await until('bar', () => p.byLabel('Aktionen für die ausgewählten Mails'))));
    await until('asked', () => p.text('mp-dialog').includes('2 Mails löschen?'));
    assert.ok(p.text('mp-dialog').includes('Sie kommen in den Papierkorb'));
    assert.ok(!p.last('messages/delete'), 'not before the answer');
    const dont = p.el('mp-dialog').all().find((x) => x.localName === 'input' && x.type === 'checkbox');
    dont.checked = true;
    click(p.byText('button', 'Löschen', p.el('mp-dialog')));
    await until('deleted', () => p.last('messages/delete'));
    await until('asked no more', () => p.calls.some((x) => x.method === 'PUT' && x.path === 'settings' && x.body.confirmDelete === false));
    assert.equal((await c.as(ANNA)('GET', 'me')).json.settings.confirmDelete, false);
    await until('the snackbar', () => p.text('mp-snack').includes('2 Mails in den Papierkorb gelegt') && p.text('mp-snack').includes('Rückgängig'));
    assert.equal(c.mail.box('anna@gmx.de', 'Papierkorb').msgs.size, 2);
    // now at once
    await until('3 left', () => p.rows().length === 3);
    click(p.box(SUBJECTS[2]));
    click(p.byLabel('Löschen', p.byLabel('Aktionen für die ausgewählten Mails')));
    await until('deleted at once', () => p.calls.filter((x) => x.path === 'messages/delete').length === 2);
    assert.ok(p.el('mp-dialog').hidden);
    // the trash: always asked, for good (the account's folders open below it in the menu)
    click(await until('the account', () => p.el('mp-nav').all().find((x) => x.localName === 'button' && x.className.includes('is-acc') && textOf(x).includes('Anna'))));
    click(await until('the trash in the menu', () => p.el('mp-nav').all().find((x) => x.localName === 'button' && textOf(x).includes('Papierkorb'))));
    await until('the trash', () => p.rows().length === 3);
    click(p.box(SUBJECTS[0]));
    click(p.byLabel('Löschen', await until('bar', () => p.byLabel('Aktionen für die ausgewählten Mails'))));
    await until('asked', () => p.text('mp-dialog').includes('Mail endgültig löschen?'));
    assert.ok(p.text('mp-dialog').includes('lassen sich nicht zurückholen'));
    click(p.byText('button', 'Endgültig löschen'));
    await until('gone', () => p.calls.filter((x) => x.path === 'messages/delete').length === 3);
    await until('the toast', () => p.text('mp-toast').includes('Mail endgültig gelöscht'));
    assert.equal(c.mail.box('anna@gmx.de', 'Papierkorb').msgs.size, 2);
  } finally { p.stop(); }
}));

test('portal: move and copy through the folder picker (search, the folder used last, „hier“), one mail of the reading pane; several accounts: a note', () => withMail({}, async (host, c) => {
  const acc = await setup(c, { second: true });
  const p = portal(host, ANNA);
  try {
    // in the account's posteingang
    click(await until('the account', () => p.el('mp-nav').all().find((x) => x.localName === 'button' && textOf(x).includes('Anna') && x.className.includes('is-acc'))));
    await until('its list', () => p.rows().length === 5);
    click(p.box(SUBJECTS[0]));
    click(p.box(SUBJECTS[1]));
    click(p.byLabel('Verschieben', await until('bar', () => p.byLabel('Aktionen für die ausgewählten Mails'))));
    await until('the picker', () => p.text('mp-dialog').includes('2 Mails verschieben'));
    const dlg = () => p.el('mp-dialog');
    const frow = (name) => dlg().all().find((x) => x.localName === 'button' && x.className.includes('mp-frow') && textOf(x).includes(name));
    assert.ok(frow('Posteingang').disabled, 'the folder it is in');
    assert.ok(textOf(frow('Posteingang')).includes('hier'));
    assert.ok(!dlg().all().some((x) => textOf(x) === 'Entwürfe'), 'no drafts');
    assert.ok(p.text('mp-dialog').includes('Ordner anderer Konten'), 'one account');
    // search
    const search = dlg().all().find((x) => x.localName === 'input' && x.type === 'search');
    search.value = '2026';
    search.dispatchEvent({ type: 'input' });
    await until('found', () => frow('2026') && !frow('Archiv'));
    click(frow('2026'));
    const go = await until('the button', () => p.byText('button', 'Nach „2026“ verschieben'));
    click(go);
    await until('moved', () => p.last('messages/move'));
    const mv = p.last('messages/move').body;
    assert.equal(mv.ids.length, 2);
    assert.equal(mv.threads, true);
    assert.equal(c.mail.box('anna@gmx.de', 'Rechnungen/2026').msgs.size, 2);
    await until('the snackbar', () => p.text('mp-snack').includes('2 Mails nach „2026“ verschoben'));
    // copy: the switch, the folder used last on top
    await until('3 left', () => p.rows().length === 3);
    click(p.box(SUBJECTS[2]));
    click(p.byLabel('Kopieren', p.byLabel('Aktionen für die ausgewählten Mails')));
    await until('the picker', () => p.text('mp-dialog').includes('Mail kopieren'));
    assert.equal(p.byText('button', 'Kopieren', dlg()).getAttribute('aria-pressed'), 'true');
    assert.ok(p.text('mp-dialog').includes('Zuletzt'));
    const first = dlg().all().find((x) => x.localName === 'button' && x.className.includes('mp-frow'));
    assert.ok(textOf(first).includes('2026'), 'the folder used last first');
    // switch to Verschieben and back
    click(p.byText('button', 'Verschieben', dlg()));
    await until('title', () => p.text('mp-dialog').includes('Mail verschieben'));
    click(p.byText('button', 'Kopieren', dlg()));
    click(frow('Archiv'));
    click(await until('copy button', () => p.byText('button', 'Nach „Archiv“ kopieren')));
    await until('copied', () => p.last('messages/copy'));
    assert.equal(p.last('messages/copy').body.folderId > 0, true);
    assert.equal(c.mail.box('anna@gmx.de', 'Archiv').msgs.size, 1);
    assert.equal(c.mail.box('anna@gmx.de', 'INBOX').msgs.size, 3, 'a copy');
    await until('the snackbar', () => p.text('mp-snack').includes('Mail nach „Archiv“ kopiert'));
    // one mail of the reading pane: „Verschieben“
    click(p.row(SUBJECTS[3]).childNodes[1]);
    await until('open', () => p.text('mp-read').includes(SUBJECTS[3]));
    click(p.byLabel('Verschieben', p.el('mp-read')));
    await until('the picker', () => p.text('mp-dialog').includes('Mail verschieben'));
    click(frow('Rechnungen'));
    click(await until('button', () => p.byText('button', 'Nach „Rechnungen“ verschieben')));
    await until('moved', () => p.calls.filter((x) => x.path === 'messages/move').length === 2);
    assert.deepEqual(p.last('messages/move').body.ids.length, 1);
    assert.equal(c.mail.box('anna@gmx.de', 'Rechnungen').msgs.size, 1);
    // all posteingänge with mail of two accounts: a note, no folders
    click(p.byText('button', 'Alle Posteingänge') || p.el('mp-nav').all().find((x) => x.localName === 'button' && textOf(x).includes('Posteingänge')));
    await until('both', () => p.rows().some((r) => textOf(r).includes('Vom Verein')));
    click(p.box('Vom Verein'));
    click(p.box(SUBJECTS[4]));
    click(p.byLabel('Verschieben', await until('bar', () => p.byLabel('Aktionen für die ausgewählten Mails'))));
    await until('the note', () => p.text('mp-dialog').includes('aus mehreren Konten'));
    assert.ok(!p.el('mp-dialog').all().some((x) => x.className.includes('mp-frow')));
    assert.ok(acc.id > 0);
  } finally { p.stop(); }
}));

test('portal settings: „Wischen / Schnellaktionen“ with seven actions per side, „Vor dem Löschen fragen“', () => withMail({}, async (host, c) => {
  await setup(c);
  const p = portal(host, ANNA);
  try {
    click(await until('the settings', () => p.byLabel('Mail-Einstellungen')));
    await until('the dialog', () => p.text('mp-dialog').includes('Wischen / Schnellaktionen'));
    const left = p.byLabel('Nach links wischen');
    const right = p.byLabel('Nach rechts wischen');
    assert.equal(left.localName, 'select');
    assert.deepEqual(left.querySelectorAll('option').map((o) => textOf(o)), ['Archivieren', 'Löschen', 'Gelesen / Ungelesen', 'Markieren', 'Verschieben …', 'In Spam', 'Nichts']);
    assert.deepEqual([left.value, right.value], ['archive', 'read']);
    assert.ok(p.text('mp-dialog').includes('Gilt für alle deine Geräte'));
    left.value = 'flag';
    left.dispatchEvent({ type: 'change' });
    await until('saved', () => p.calls.some((x) => x.method === 'PUT' && x.path === 'settings' && x.body.swipe && x.body.swipe.left === 'flag'));
    const ask = p.byLabel('Vor dem Löschen fragen');
    assert.equal(ask.checked, false);
    ask.checked = true;
    ask.dispatchEvent({ type: 'change' });
    await until('saved', () => p.calls.some((x) => x.method === 'PUT' && x.path === 'settings' && x.body.confirmDelete === true));
    await settle(30);
    const s = (await c.as(ANNA)('GET', 'me')).json.settings;
    assert.deepEqual([s.swipe.left, s.swipeLeft, s.confirmDelete], ['flag', 'none', true]);
  } finally { p.stop(); }
}));
