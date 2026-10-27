'use strict';

// 1.7.0: attachments of school messages into Drive — „In Drive speichern“ (POST …/attachments/<attId>/drive) and
// the setting drive_auto_save (new attachments into the family area in the background). Drive is a fake provider
// (save_file like gatecontrol-drive 1.4.0 answers it); the hand-over is the mock host's.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asApp, asPortalPost, setupParent, tickAt, ADMIN, EVA, LENA, BOB, T0 } = require('./helpers');
const drive = require('../server/drive');

const MIN = 60000;
const PDF = Buffer.from('%PDF-1.4 Elternbrief');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const MSG_ID = (acc) => `${acc}-2`;

/**
 * A fake Drive: `seats` people with a Drive seat, `families` people with a writable family area; folder 99 is gone;
 * opts.answer(user, payload) → an answer instead (e.g. { ok: false, code: 'quota' }).
 */
function fakeDrive(opts = {}) {
  const seats = new Set(opts.seats || [EVA.id, BOB.id, ADMIN.id]);
  const families = new Set(opts.families || [EVA.id, BOB.id, ADMIN.id]);
  let node = 100;
  const entry = {
    plugin: 'gatecontrol-drive',
    provides: ['list_areas', 'save_file'],
    media: { maxBytes: 100 * 1024 * 1024, types: ['application/pdf', 'image/jpeg', 'application/octet-stream'], quotaDefault: 1024 * 1024 * 1024 },
    calls: [],
    service: async ({ name, user, payload }) => {
      entry.calls.push({ name, userId: user && user.id, payload });
      if (opts.answer) { const a = opts.answer(user, payload); if (a) return a; }
      if (!seats.has(user.id)) return { ok: false, code: 'no_seat' };
      if (!(entry.received || []).some((f) => f.mediaId === payload.mediaId && f.owner === user.id)) return { ok: false, code: 'upload_invalid' };
      if (payload.folderId != null) {
        if (payload.folderId === 99) return { ok: false, code: 'not_found' };
        node += 1;
        return { ok: true, nodeId: node, areaId: 'family', path: `Ordner/${payload.name}`, name: payload.name, created: true, where: `Familie › Ordner › ${payload.name}` };
      }
      if (payload.area === 'family' && !families.has(user.id)) return { ok: false, code: 'not_found' };
      const label = payload.area === 'family' ? 'Familie' : 'Meine Dateien';
      const segs = payload.path.split('/');
      node += 1;
      return { ok: true, nodeId: node, areaId: payload.area, path: payload.path, name: segs[segs.length - 1], created: true, where: [label, ...segs].join(' › ') };
    },
  };
  return entry;
}

/** The household with one new message carrying a PDF and a picture (fetched in the cycle at T0 + 15 min). */
async function withMessage(opts, fn) {
  const services = opts.drive === false ? [] : [opts.drive || fakeDrive()];
  return withHost({ untis: { school: true }, gatecontrol: '1.196.0', services, settings: opts.settings || {} }, async (host, untis) => {
    drive._state.backoffUntil = 0;
    untis.state.inbox = [];
    const setup = await setupParent(host);
    if (opts.prepare) await opts.prepare(host, setup);
    untis.state.inbox.unshift({
      id: 2, subject: 'Elternbrief', contentPreview: 'Liebe Eltern …', hasAttachments: true,
      sender: { displayName: 'Frau Schmidt' }, sentDateTime: '2026-10-20T06:05:00Z',
    });
    untis.state.details[2] = { content: '<p>Anbei.</p>', storageAttachments: [{ id: 'f-pdf', name: 'Elternbrief.pdf', size: PDF.length }, { id: 'f-jpg', name: 'Foto: Ausflug.jpg' }] };
    untis.state.files['f-pdf'] = { body: PDF, type: 'application/pdf' };
    untis.state.files['f-jpg'] = { body: JPG, type: 'image/jpeg' };
    await tickAt(host, T0 + 15 * MIN);
    return fn(host, untis, setup, services[0]);
  });
}

const save = (host, user, accId, attId, body = {}) => asApp(host, user, `/app/messages/${MSG_ID(accId)}/attachments/${attId}/drive`, {}, 'POST', body);
const saveCalls = (d) => d.calls.filter((c) => c.name === 'save_file');

test('manual: into the family area under Schule › child (its display name), the response says where', () => withMessage({}, async (host, untis, { account }, d) => {
  const list = await asApp(host, EVA, '/app/messages');
  assert.equal(list.json.drive, true, 'the inbox says Drive is there');
  const r = await save(host, EVA, account.id, 'f-pdf');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, saved: { nodeId: 101, name: 'Elternbrief.pdf', where: 'Familie › Schule › Lena Muster › Elternbrief.pdf' } });
  const calls = saveCalls(d);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, EVA.id);
  assert.deepEqual({ ...calls[0].payload, mediaId: 'x' }, { mediaId: 'x', area: 'family', path: 'Schule/Lena Muster/Elternbrief.pdf', onConflict: 'rename', lang: 'de' });
  // a copy handed over for Eva — Schule keeps its file
  assert.deepEqual(host.handOvers.map((h) => [h.to, h.user]), [['gatecontrol-drive', EVA.id]]);
  assert.equal(d.received[0].data.toString(), PDF.toString());
  assert.equal((await asApp(host, EVA, '/app/messages')).json.messages[0].attachments.length, 2, 'the attachment stays in Schule');
  // a file name Drive would refuse is made safe
  const r2 = await save(host, EVA, account.id, 'f-jpg');
  assert.equal(r2.json.saved.where, 'Familie › Schule › Lena Muster › Foto- Ausflug.jpg');
}));

test('manual: without a family (or read only) into the person\'s own area; several children → no child level', () => withMessage({ drive: fakeDrive({ families: [] }) }, async (host, untis, { account }, d) => {
  const r = await save(host, EVA, account.id, 'f-pdf');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.saved.where, 'Meine Dateien › Schule › Lena Muster › Elternbrief.pdf');
  assert.deepEqual(saveCalls(d).map((c) => c.payload.area), ['family', 'mine']);
  assert.equal(new Set(saveCalls(d).map((c) => c.payload.mediaId)).size, 1, 'one hand-over, the same copy for the second try');
  assert.equal(host.handOvers.length, 1);
  // the administrator sees both children of the parent account: no child level
  const a = await save(host, ADMIN, account.id, 'f-pdf');
  assert.equal(a.json.saved.where, 'Meine Dateien › Schule › Elternbrief.pdf');
}));

test('manual: a folder picked in the app; a bad folderId is refused', () => withMessage({}, async (host, untis, { account }, d) => {
  const r = await save(host, EVA, account.id, 'f-pdf', { folderId: 42 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.saved, { nodeId: 101, name: 'Elternbrief.pdf', where: 'Familie › Ordner › Elternbrief.pdf' });
  assert.deepEqual({ ...saveCalls(d)[0].payload, mediaId: 'x' }, { mediaId: 'x', folderId: 42, name: 'Elternbrief.pdf', onConflict: 'rename', lang: 'de' });
  for (const bad of ['42', -1, 1.5]) {
    const x = await save(host, EVA, account.id, 'f-pdf', { folderId: bad });
    assert.deepEqual([x.status, x.json.code], [400, 'INVALID']);
  }
  // Drive's code passed through, with the German text
  const gone = await save(host, EVA, account.id, 'f-pdf', { folderId: 99 });
  assert.deepEqual([gone.status, gone.json.code, gone.json.error], [404, 'not_found', 'Diesen Ordner gibt es in Drive nicht (mehr).']);
  // the portal page reaches the same
  const p = await asPortalPost(host, EVA, `/portal/messages/${MSG_ID(account.id)}/attachments/f-pdf/drive`, { folderId: 42 });
  assert.equal(p.json.saved.where, 'Familie › Ordner › Elternbrief.pdf');
}));

test('manual: Drive\'s errors passed through (no seat, quota), no fallback to the own area for them', () => withMessage({
  drive: fakeDrive({ seats: [], answer: (u) => (u.id === ADMIN.id ? { ok: false, code: 'quota' } : null) }),
}, async (host, untis, { account }, d) => {
  const r = await save(host, EVA, account.id, 'f-pdf');
  assert.deepEqual([r.status, r.json.ok, r.json.code], [403, false, 'no_seat']);
  assert.match(r.json.error, /keinen Zugang zu Drive/);
  const q = await save(host, ADMIN, account.id, 'f-pdf');
  assert.deepEqual([q.status, q.json.code], [507, 'quota']);
  assert.equal(saveCalls(d).length, 2);
  // an unknown answer → failed
  d.service = async () => ({ ok: false, code: 'weird' });
  const w = await save(host, EVA, account.id, 'f-pdf');
  assert.deepEqual([w.status, w.json.code], [502, 'failed']);
}));

test('manual: without Drive → drive_unavailable and drive: false; nothing is handed over', () => withMessage({ drive: false }, async (host, untis, { account }) => {
  const list = await asApp(host, EVA, '/app/messages');
  assert.equal(list.json.drive, false);
  const ov = await host.request({ method: 'GET', path: '/portal/overview', query: {}, body: null, user: { ...EVA, portal: true, loggedIn: true } });
  assert.equal(ov.json.drive, false);
  const r = await save(host, EVA, account.id, 'f-pdf');
  assert.deepEqual([r.status, r.json.code, r.json.error], [503, 'drive_unavailable', 'Drive ist gerade nicht verfügbar.']);
  assert.equal(host.handOvers.length, 0);
}));

test('manual: only who may read the message — not someone else, not the child through the parents\' inbox', () => withMessage({}, async (host, untis, { account }, d) => {
  for (const u of [BOB, LENA]) {
    const r = await save(host, u, account.id, 'f-pdf');
    assert.deepEqual([r.status, r.json.code], [404, 'SCHULE_MESSAGE_NOT_FOUND'], u.name);
  }
  const k = await host.request({ method: 'POST', path: `/app/messages/${MSG_ID(account.id)}/attachments/f-pdf/drive`, query: {}, body: {}, user: { ...EVA, portal: true, loggedIn: true, app: true, kiosk: true } });
  assert.equal(k.status, 404, 'never a kiosk device');
  const none = await save(host, EVA, account.id, 'nope');
  assert.deepEqual([none.status, none.json.code], [404, 'SCHULE_ATTACHMENT_NOT_FOUND']);
  assert.equal(host.handOvers.length, 0);
  assert.equal(d.calls.length, 0);
}));

test('automatic: each new attachment once into the family area, as the first parent with a Drive seat', () => withMessage({
  settings: { drive_auto_save: true },
  drive: fakeDrive({ seats: [BOB.id], families: [BOB.id] }),
  // one child on the account (Max off), Eva and Bob are Lena's recipients; her short name (alias) is the folder
  prepare: async (host, { lena, max }) => {
    await asAdmin(host, 'PUT', `/students/${max.id}`, { enabled: false });
    await asAdmin(host, 'PUT', `/students/${lena.id}`, { recipients: [BOB.id, EVA.id], alias: 'Lena' });
  },
}, async (host, untis, { account }, d) => {
  const calls = saveCalls(d);
  // Eva (id 2) first: no seat → Bob (id 4); her answer is remembered for the second attachment
  assert.deepEqual(calls.map((c) => [c.userId, c.payload.area, c.payload.path]), [
    [EVA.id, 'family', 'Schule/Lena/2026-10-20 Elternbrief.pdf'],
    [BOB.id, 'family', 'Schule/Lena/2026-10-20 Elternbrief.pdf'],
    [BOB.id, 'family', 'Schule/Lena/2026-10-20 Foto- Ausflug.jpg'],
  ]);
  const rows = (await host.gc.db.query('SELECT att_id, status, user_id FROM drive_saves ORDER BY att_id')).rows;
  assert.deepEqual(rows.map((x) => [x.att_id, x.status, Number(x.user_id)]), [['f-jpg', 'saved', BOB.id], ['f-pdf', 'saved', BOB.id]]);
  // never twice
  await tickAt(host, T0 + 16 * MIN);
  await tickAt(host, T0 + 40 * MIN);
  assert.equal(saveCalls(d).length, 3);
  // „In Drive speichern“ by hand still works (another copy; Drive renames it)
  const r = await save(host, BOB, account.id, 'f-pdf');
  assert.equal(r.status, 200);
  assert.equal(saveCalls(d).length, 4);
}));

test('automatic: off (the default) → nothing goes to Drive', () => withMessage({}, async (host, untis, setup, d) => {
  await tickAt(host, T0 + 30 * MIN);
  assert.equal(d.calls.length, 0);
  assert.equal(host.handOvers.length, 0);
  assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM drive_saves')).rows[0].n, 0);
}));

test('automatic: no parent with a Drive seat → logged once, not tried again', () => withMessage({
  settings: { drive_auto_save: true },
  drive: fakeDrive({ seats: [] }),
}, async (host, untis, setup, d) => {
  // two children on the account: no child level; Eva is the only parent
  assert.deepEqual(saveCalls(d).map((c) => [c.userId, c.payload.path]), [[EVA.id, 'Schule/2026-10-20 Elternbrief.pdf']]);
  const rows = (await host.gc.db.query('SELECT att_id, status, code FROM drive_saves ORDER BY att_id')).rows;
  assert.deepEqual(rows.map((x) => [x.att_id, x.status, x.code]), [['f-jpg', 'failed', 'no_parent'], ['f-pdf', 'failed', 'no_parent']]);
  const logged = () => host.logs.filter((l) => l.message.includes('attachment not saved in drive')).length;
  assert.equal(logged(), 2);
  await tickAt(host, T0 + 16 * MIN);
  await tickAt(host, T0 + 45 * MIN);
  assert.equal(saveCalls(d).length, 1, 'not tried again');
  assert.equal(logged(), 2, 'logged once');
}));

test('automatic: paused after Drive was busy → nothing kept meanwhile, saved after the pause', () => withMessage({
  settings: { drive_auto_save: true },
  prepare: async () => { drive._state.backoffUntil = Infinity; },
}, async (host, untis, setup, d) => {
  assert.equal(d.calls.length, 0, 'paused');
  drive._state.backoffUntil = 0;
  await tickAt(host, T0 + 16 * MIN);
  assert.equal(saveCalls(d).length, 2);
  assert.equal((await host.gc.db.query("SELECT COUNT(*) AS n FROM drive_saves WHERE status = 'saved'")).rows[0].n, 2);
}));

test('safe names and the parents\' order', () => {
  assert.equal(drive.safeName('a/b\\c:d*e?"f"<g>|h. ', 'x'), 'a-b-c-d-e--f--g--h');
  assert.equal(drive.safeName('..', 'Anhang'), 'Anhang');
  assert.equal(drive.safeName('', 'Anhang'), 'Anhang');
  const live = [{ user_id: 3, recipients: [4, 2, 3] }, { user_id: null, recipients: [2, 9] }];
  assert.deepEqual(drive.parentsOf(live, new Set([2, 3, 4])), [2, 4], 'by id, existing users, not a child');
  assert.equal(drive.hostCode({ code: 'ERR_SERVICE_UNAVAILABLE' }), 'drive_unavailable');
  assert.equal(drive.hostCode({ code: 'ERR_RATE_LIMIT' }), 'rate_limited');
  assert.equal(drive.hostCode(new Error('x')), 'failed');
});
