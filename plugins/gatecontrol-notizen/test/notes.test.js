'use strict';

// Notebooks and notes: tags, pinned, colours, check boxes, a line to a task, attachments (claimed, quota, who may read
// them), recognised text in the search, sharing, the trash; and Familie's notebooks (bound.js, contract § 3).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');

const FAM = 'gatecontrol-familie';
const svc = (h, name, user, payload) => h.host.callService(name, { caller: FAM, user: user ? { id: user.id, name: user.name, role: user.role } : null, payload });

test('notes: notebooks, tags, pinned, colours, list order and the menu', async () => {
  const h = await withHost();
  try {
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Haushalt', area: 'private' });
    const a = await h.ok(ANNA, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'Werkstatt Montag', body: 'Winterreifen\n- [x] Drehmomentschlüssel\n- [ ] Ölfilter bestellen\n#auto #werkstatt', pinned: true, color: 'yellow' });
    clock.advance(1000);
    const b = await h.ok(ANNA, 'POST', 'notes', { title: 'Lasagne (Oma)', body: '500 g Hack #rezept' });
    clock.advance(1000);
    await h.ok(ANNA, 'POST', 'notes', { title: 'Arbeit', body: '#projekt', area: 'work' });
    assert.deepEqual(a.note.check, { done: 1, total: 2 });
    assert.deepEqual(a.note.tags.sort(), ['auto', 'werkstatt']);
    let l = await h.ok(ANNA, 'GET', 'notes', null, { area: 'private' });
    assert.deepEqual(l.notes.map((n) => n.title), ['Lasagne (Oma)', 'Werkstatt Montag']);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'notes', null, { area: 'private', pinned: '1' })).notes.map((n) => n.title), ['Werkstatt Montag']);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'notes', null, { area: 'private', tag: 'rezept' })).notes.map((n) => n.title), ['Lasagne (Oma)']);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'notes', null, { notebook: nb.notebook.id })).notes.map((n) => n.title), ['Werkstatt Montag']);
    const nbs = await h.ok(ANNA, 'GET', 'notebooks', null, { area: 'private' });
    assert.deepEqual(nbs.tags.map((t) => t.tag).sort(), ['auto', 'rezept', 'werkstatt']);
    assert.equal(nbs.total, 2);
    // paging
    l = await h.ok(ANNA, 'GET', 'notes', null, { area: 'private', limit: 1 });
    assert.ok(l.next);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'notes', null, { area: 'private', limit: 1, before: l.next })).notes.map((n) => n.title), ['Werkstatt Montag']);
    // tags follow the text; a check box
    await h.ok(ANNA, 'PATCH', 'notes/' + b.note.id, { body: 'nur noch #pasta' });
    assert.deepEqual((await h.ok(ANNA, 'GET', 'notebooks', null, { area: 'private' })).tags.map((t) => t.tag).sort(), ['auto', 'pasta', 'werkstatt']);
    const c = await h.ok(ANNA, 'POST', `notes/${a.note.id}/check`, { line: 2, done: true });
    assert.deepEqual(c.note.check, { done: 2, total: 2 });
    // an old revision is refused
    assert.equal((await h.call(ANNA, 'PATCH', 'notes/' + a.note.id, { body: 'x', rev: 1 })).status, 409);
    assert.equal((await h.call(BOB, 'GET', 'notes/' + a.note.id)).status, 404);
  } finally { await h.close(); clock.set(T0); }
});

test('a line of a note becomes a task; ticking it in the note ticks the task', async () => {
  const h = await withHost();
  try {
    const n = await h.ok(ANNA, 'POST', 'notes', { title: 'Werkstatt', body: 'Mitnehmen:\n- [ ] Ölfilter bestellen' });
    const r = await h.ok(ANNA, 'POST', `notes/${n.note.id}/task`, { line: 1 });
    assert.equal(r.task.title, 'Ölfilter bestellen');
    assert.equal(r.task.noteId, n.note.id);
    assert.match(r.note.body, /- \[ \] Ölfilter bestellen \[Aufgabe\]\(task:\d+\)$/);
    assert.deepEqual(r.note.tasks.map((t) => t.title), ['Ölfilter bestellen']);
    await h.ok(ANNA, 'POST', `notes/${n.note.id}/check`, { line: 1, done: true });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + r.task.id)).task.done, true);
    assert.equal((await h.call(ANNA, 'POST', `notes/${n.note.id}/task`, { line: 0 })).status, 200, 'a plain line works too');
    assert.equal((await h.call(ANNA, 'POST', `notes/${n.note.id}/task`, { line: 9 })).status, 400);
  } finally { await h.close(); }
});

test('attachments: claimed, who may read, size and quota, recognised text is searched', async () => {
  const h = await withHost({ settings: { quota_mb: 1, attach_mb: 1 } });
  try {
    const n = await h.ok(ANNA, 'POST', 'notes', { title: 'Gartenhaus', body: '' });
    const up = await h.host.upload({ ...ANNA, portal: true, loggedIn: true }, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.equal(up.status, 200);
    const a = await h.ok(ANNA, 'POST', 'attachments', { kind: 'note', refId: n.note.id, mediaId: up.body.mediaId, name: 'IMG_2041.jpg' });
    assert.equal(a.attachment.name, 'IMG_2041.jpg');
    assert.ok(a.attachment.url);
    const note = (await h.ok(ANNA, 'GET', 'notes/' + n.note.id)).note;
    assert.equal(note.images, 1);
    assert.equal(note.attachments.length, 1);
    const plugin = require('../server/index');
    assert.equal(await plugin.mediaAccess({ user: { id: ANNA.id }, mediaId: up.body.mediaId }, h.host.gc), true);
    assert.equal(await plugin.mediaAccess({ user: { id: BOB.id }, mediaId: up.body.mediaId }, h.host.gc), false);
    // someone else's upload is not taken
    const upB = await h.host.upload({ ...BOB, portal: true, loggedIn: true }, Buffer.from('x'), 'image/png');
    assert.equal((await h.call(ANNA, 'POST', 'attachments', { kind: 'note', refId: n.note.id, mediaId: upB.body.mediaId, name: 'x.png' })).status, 400);
    // too large for the setting
    const big = await h.host.upload({ ...ANNA, portal: true, loggedIn: true }, Buffer.alloc(1100000), 'application/pdf');
    assert.equal((await h.call(ANNA, 'POST', 'attachments', { kind: 'note', refId: n.note.id, mediaId: big.body.mediaId, name: 'big.pdf' })).status, 413);
    // recognised text (on the device) makes a picture findable
    await h.ok(ANNA, 'PUT', `attachments/${a.attachment.id}/text`, { text: 'Bauantrag Gemeinde Musterstadt' });
    const s = await h.ok(ANNA, 'GET', 'search', null, { q: 'bauantrag', area: 'private' });
    assert.deepEqual(s.notes.map((x) => x.title), ['Gartenhaus']);
    await h.ok(ANNA, 'DELETE', 'attachments/' + a.attachment.id);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'bauantrag', area: 'private' })).notes.length, 0);
    // a task's attachment
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Angebot' });
    const up2 = await h.host.upload({ ...ANNA, portal: true, loggedIn: true }, Buffer.from('%PDF'), 'application/pdf');
    await h.ok(ANNA, 'POST', 'attachments', { kind: 'task', refId: t.task.id, mediaId: up2.body.mediaId, name: 'Angebot.pdf' });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + t.task.id)).task.attachmentList[0].name, 'Angebot.pdf');
  } finally { await h.close(); }
});

test('search: words as prefixes without umlauts, only what the person sees, tasks and items too', async () => {
  const h = await withHost();
  try {
    await h.ok(ANNA, 'POST', 'notes', { title: 'Zahnärztin', body: 'Termin bei Frau Dr. Müller' });
    await h.ok(MARC, 'POST', 'notes', { title: 'Zahnarzt Marc', body: '' });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt anrufen', note: 'Nummer im Telefonbuch' });
    await h.push('gatecontrol-mail', { upsert: [require('./helpers').item('gatecontrol-mail', 'm:1', { title: 'Zahnarztrechnung prüfen' })] });
    const s = await h.ok(ANNA, 'GET', 'search', null, { q: 'zahnarzt', area: 'private' });
    assert.deepEqual(s.notes.map((n) => n.title), ['Zahnärztin']);
    assert.deepEqual(s.tasks.map((n) => n.title), ['Zahnarzt anrufen']);
    assert.deepEqual(s.items.map((n) => n.title), ['Zahnarztrechnung prüfen']);
    assert.match(s.notes[0].hit || '', /\u0002/);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'muller termin', area: 'private' })).notes.length, 1);
    assert.equal((await h.call(ANNA, 'GET', 'search', null, { q: 'z' })).status, 400);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: '"*) OR (', area: 'private' })).notes.length, 0, 'FTS syntax is never passed through');
    const ps = await h.host.portalSearch({ ...ANNA, loggedIn: true }, 'zahn');
    assert.ok(ps.length >= 2);
  } finally { await h.close(); }
});

test('sharing a notebook; leaving it; deleting a notebook takes its notes into the trash', async () => {
  const h = await withHost();
  try {
    const nb = await h.ok(ANNA, 'POST', 'notebooks', { name: 'Rezepte' });
    await h.ok(ANNA, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'Lasagne', body: '#rezept' });
    await h.ok(ANNA, 'PUT', `notebooks/${nb.notebook.id}/members`, { members: [MARC.id] });
    assert.deepEqual((await h.ok(MARC, 'GET', 'notes', null, { notebook: nb.notebook.id })).notes.map((n) => n.title), ['Lasagne']);
    await h.ok(MARC, 'POST', 'notes', { notebookId: nb.notebook.id, title: 'Pizza', body: '' });
    await h.ok(MARC, 'DELETE', 'notebooks/' + nb.notebook.id);
    assert.equal((await h.call(MARC, 'GET', 'notes', null, { notebook: nb.notebook.id })).status, 404);
    await h.ok(ANNA, 'DELETE', 'notebooks/' + nb.notebook.id);
    assert.equal((await h.ok(ANNA, 'GET', 'notebooks')).tags.length, 0);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'lasagne', area: 'private' })).notes.length, 0);
  } finally { await h.close(); }
});

test('Familie: Pinnwand and Packlisten live here and are shown back (notes_* services, notes_changed)', async () => {
  const changed = [];
  const fam = require('./helpers').fakeSource(FAM, { provides: { notes_changed: { label: { de: 'x', en: 'x' }, maxPerHour: 600 } }, service: ({ name, payload }) => { changed.push({ name, payload }); return { ok: true }; } });
  const h = await withHost({ sources: [fam] });
  try {
    assert.equal((await svc(h, 'notes_bind', null, { key: 'pinnwand', title: 'Pinnwand', kind: 'notes', members: [ANNA.id, MARC.id, LENA.id] })).ok, true);
    const pk = await svc(h, 'notes_bind', null, { key: 'packlisten', title: 'Packlisten', kind: 'checklists', members: [ANNA.id, MARC.id, LENA.id] });
    // the one-time move of what Familie had
    const im = await svc(h, 'notes_import', null, { key: 'pinnwand', notes: [
      { ref: 'board:1', text: 'WLAN Gäste: SSID und Hinweise', color: 'yellow', pinned: true, authorId: MARC.id, createdAt: T0 - 86400000 },
      { ref: 'board:2', text: 'Läuft ab', expiresAt: T0 + 3600000 },
    ] });
    assert.deepEqual([im.imported, im.skipped], [2, 0]);
    assert.equal((await svc(h, 'notes_import', null, { key: 'pinnwand', notes: [{ ref: 'board:1', text: 'x' }] })).skipped, 1, 'idempotent');
    const pl = await svc(h, 'notes_import', null, { key: 'packlisten', notes: [{ ref: 'checklist:4', title: 'Wochenende Harz', due: '2026-11-13', checklist: [{ text: 'Zahnbürste', done: true }, { text: 'Wanderschuhe', done: false }] }] });
    const pid = pl.ids['checklist:4'];
    // shown back in Familie
    const list = await svc(h, 'notes_list', LENA, { key: 'packlisten' });
    assert.equal(list.ok, true);
    assert.deepEqual(list.notes[0].checklist.map((c) => [c.text, c.done]), [['Zahnbürste', true], ['Wanderschuhe', false]]);
    assert.deepEqual(list.notes[0].progress, { done: 1, total: 2 });
    assert.equal(list.notes[0].due, '2026-11-13');
    // a child ticks an item in Familie
    const ck = await svc(h, 'note_check', LENA, { key: 'packlisten', noteId: pid, itemId: list.notes[0].checklist[1].id, done: true });
    assert.deepEqual(ck.note.progress, { done: 2, total: 2 });
    // not a member, another plugin, a wrong item
    assert.equal((await svc(h, 'notes_list', BOB, { key: 'packlisten' })).code, 'forbidden');
    assert.equal((await h.host.callService('notes_list', { caller: 'gatecontrol-mail', user: { id: ANNA.id }, payload: { key: 'packlisten' } })).code, 'forbidden');
    assert.equal((await svc(h, 'note_check', LENA, { key: 'packlisten', noteId: pid, itemId: '0.abcdef', done: true })).code, 'not_found');
    // the same notes in the hub: in the notebook „Pinnwand (Familie)“, changed here → told to Familie
    const nbs = await h.ok(ANNA, 'GET', 'notebooks', null, { area: 'private' });
    const pin = nbs.notebooks.find((b) => b.bound && b.bound.key === 'pinnwand');
    assert.equal(pin.count, 2);
    const notes = await h.ok(ANNA, 'GET', 'notes', null, { notebook: pin.id });
    const wlan = notes.notes.find((n) => /WLAN/.test(n.snippet));
    assert.equal(wlan.updatedBy, MARC.id);
    await h.ok(ANNA, 'PATCH', 'notes/' + wlan.id, { body: 'WLAN Gäste: neues Passwort am Kühlschrank' });
    await h.host.tick();
    assert.equal(changed.length, 0, 'waits 30 s for more changes');
    clock.advance(31000);
    await h.host.tick();
    assert.deepEqual(changed.map((c) => [c.name, c.payload.key, c.payload.ids]), [['notes_changed', 'pinnwand', [wlan.id]]]);
    // a note that expires goes
    clock.advance(3600000);
    await h.host.tick();
    assert.equal((await svc(h, 'notes_list', ANNA, { key: 'pinnwand' })).notes.length, 1);
    // Familie saves and deletes; the family changes
    const sv = await svc(h, 'note_save', ANNA, { key: 'pinnwand', title: 'Oma kommt', text: 'Sonntag 15 Uhr', color: 'pink' });
    assert.equal(sv.note.color, 'pink');
    assert.equal((await svc(h, 'note_save', ANNA, { key: 'pinnwand', id: sv.note.id, checklist: [{ text: 'Kuchen' }] })).note.checklist.length, 1);
    assert.equal((await svc(h, 'note_delete', ANNA, { key: 'pinnwand', id: sv.note.id })).ok, true);
    await svc(h, 'notes_bind', null, { key: 'pinnwand', title: 'Pinnwand', kind: 'notes', members: [ANNA.id, MARC.id] });
    assert.equal((await svc(h, 'notes_list', LENA, { key: 'pinnwand' })).code, 'forbidden');
    // the hub does not let anyone delete it or share it on
    assert.equal((await h.call(ANNA, 'DELETE', 'notebooks/' + pin.id)).status, 403);
    assert.equal((await h.call(ANNA, 'PUT', `notebooks/${pin.id}/members`, { members: [BOB.id] })).status, 403);
    // since: only what changed, and what went
    const since = await svc(h, 'notes_list', ANNA, { key: 'pinnwand', since: T0 + 30000 });
    assert.ok(Array.isArray(since.removed));
    assert.ok(pk.notebookId);
  } finally { await h.close(); clock.set(T0); }
});

test('notes_list stays within 16 KB per page', async () => {
  const fam = require('./helpers').fakeSource(FAM);
  const h = await withHost({ sources: [fam] });
  try {
    await svc(h, 'notes_bind', null, { key: 'pinnwand', title: 'Pinnwand', kind: 'notes', members: [ANNA.id] });
    const many = [];
    for (let i = 0; i < 80; i++) many.push({ ref: 'b:' + i, text: 'x'.repeat(1500) + i });
    await svc(h, 'notes_import', null, { key: 'pinnwand', notes: many });
    let cursor = null;
    let seen = 0;
    for (let i = 0; i < 20; i++) {
      const r = await svc(h, 'notes_list', ANNA, { key: 'pinnwand', cursor });
      assert.ok(JSON.stringify(r).length < 16384, 'page ' + i);
      seen += r.notes.length;
      cursor = r.cursor;
      if (!cursor) break;
    }
    assert.equal(seen, 80);
  } finally { await h.close(); }
});
