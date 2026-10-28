'use strict';

// The import from Google Drive and OneDrive (1.8.0, server/imports.js) against the mock host's gc.cloud: hidden without
// the host's cloud accounts, connecting and browsing, a job in the background (folders recursively, the change date,
// a name that exists becomes a new version, the same bytes are skipped), cancelling, going on after a stop, rights.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, BOB } = require('./helpers');

const ACCOUNT = 'anna@example.com';
const files = () => ({
  [`google:${ACCOUNT}`]: [
    { id: 'f-belege', parent: null, name: 'Belege', isDir: true },
    { id: 'f-alt', parent: 'f-belege', name: 'Alt: 2025', isDir: true },
    { id: 'b1', parent: 'f-belege', name: 'Strom.pdf', mime: 'application/pdf', data: 'strom', modifiedAt: '2026-03-01T10:00:00.000Z' },
    { id: 'b2', parent: 'f-alt', name: 'Gas.pdf', mime: 'application/pdf', data: 'gas', modifiedAt: '2025-02-01T10:00:00.000Z' },
    { id: 'e1', parent: 'f-alt', name: 'leer.txt', mime: 'text/plain', data: '', modifiedAt: '2025-02-02T10:00:00.000Z' },
    { id: 'doc1', parent: null, name: 'Einkaufsliste', mime: 'application/vnd.google-apps.document', data: 'docx', modifiedAt: '2026-09-01T10:00:00.000Z' },
    { id: 'top', parent: null, name: 'Notiz.txt', mime: 'text/plain', data: 'neu', modifiedAt: '2026-01-05T08:00:00.000Z' },
    { id: 'same', parent: null, name: 'Gleich.txt', mime: 'text/plain', data: 'gleich', modifiedAt: '2026-01-06T08:00:00.000Z' },
  ],
});
const ALL = [{ id: 'f-belege', isDir: true, name: 'Belege' }, { id: 'top', isDir: false, name: 'Notiz.txt' }, { id: 'same', isDir: false }, { id: 'doc1', isDir: false }];

test('without GateControl\'s cloud accounts (or switched off, none set up): no cloudImport, the routes refuse', async () => {
  const check = (opts) => withHost(opts, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok(!(await a('GET', 'me')).json.features.includes('cloudImport'));
    const r = await a('GET', 'import/sources');
    assert.deepEqual([r.status, r.json.code], [403, 'feature_off']);
    assert.equal((await a('POST', 'import/connect', { provider: 'google' })).status, 403);
    // the person's jobs stay readable
    assert.deepEqual((await a('GET', 'import/jobs')).json.jobs, []);
    await host.tick();
  });
  await check({});
  await check({ cloud: { files: files() }, settings: { cloud_import: false } });
  await check({ cloud: { google: false, microsoft: false } });
});

test('sources, connecting (back to the portal), browsing with pages; another person\'s connection is not found', async () => {
  await withHost({ cloud: { files: files(), pageSize: 3 } }, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok((await a('GET', 'me')).json.features.includes('cloudImport'));
    assert.deepEqual((await a('GET', 'import/sources')).json, { ok: true, google: true, microsoft: false, connections: [] });
    assert.equal((await a('POST', 'import/connect', { provider: 'microsoft' })).json.code, 'feature_off');
    assert.equal((await a('POST', 'import/connect', { provider: 'dropbox' })).status, 400);
    const u = await a('POST', 'import/connect', { provider: 'google' });
    assert.match(u.json.url, /^\/oauth\/cloud\/start\?state=/);
    assert.deepEqual([host.cloudConnectUrls[0].user, host.cloudConnectUrls[0].returnTo], [ANNA.id, '/portal?drive=import#plg-gatecontrol-drive']);
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    assert.deepEqual((await a('GET', 'import/sources')).json.connections, [conn]);
    let b = (await a('GET', 'import/browse', null, { connection: conn.id })).json;
    assert.deepEqual(b.items.map((x) => [x.name, x.isDir]), [['Belege', true], ['Einkaufsliste', false], ['Gleich.txt', false]]);
    assert.equal(b.next, '3');
    assert.deepEqual(b.connection, conn);
    b = (await a('GET', 'import/browse', null, { connection: conn.id, cursor: b.next })).json;
    assert.deepEqual([b.items.map((x) => x.name), b.next], [['Notiz.txt'], null]);
    b = (await a('GET', 'import/browse', null, { connection: conn.id, folder: 'f-belege' })).json;
    assert.deepEqual(b.items.map((x) => [x.name, x.size, x.modifiedAt]), [['Alt: 2025', 0, null], ['Strom.pdf', 5, '2026-03-01T10:00:00.000Z']]);
    assert.equal((await a('GET', 'import/browse', null, { connection: conn.id, folder: 'nix' })).status, 404);
    // Bob does not reach Anna's connection
    const bob = c.as(BOB);
    assert.equal((await bob('GET', 'import/browse', null, { connection: conn.id })).status, 404);
    assert.equal((await bob('DELETE', `import/connections/${conn.id}`)).status, 404);
    assert.deepEqual((await bob('GET', 'import/sources')).json.connections, []);
    // the provider took the consent back
    host.cloudRevoke(conn.id);
    assert.equal((await a('GET', 'import/browse', null, { connection: conn.id })).json.code, 'cloud_auth');
    assert.deepEqual((await a('DELETE', `import/connections/${conn.id}`)).json, { ok: true, removed: true });
    assert.deepEqual((await a('GET', 'import/sources')).json.connections, []);
  });
});

test('a job: folders recursively, change dates, a name that exists becomes a new version, the same bytes are skipped', async () => {
  await withHost({ cloud: { files: files() } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const old = (await c.put(ANNA, mine.rootId, 'Notiz.txt', 'alt', { mime: 'text/plain' })).json.node;
    await c.put(ANNA, mine.rootId, 'Gleich.txt', 'gleich', { mime: 'text/plain' });
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    // checks
    const post = (body) => a('POST', 'import/jobs', { connection: conn.id, targetFolderId: mine.rootId, ...body });
    assert.equal((await post({ items: [] })).json.field, 'items');
    assert.equal((await post({ items: [{ id: 'f-belege', isDir: true }] })).json.field, 'items', 'a folder needs its name');
    assert.equal((await post({ items: ALL, connection: 'conn99' })).json.field, 'connection');
    const lena = await c.area(LENA, 'child');
    assert.equal((await post({ items: ALL, targetFolderId: lena.rootId })).status, 403, 'Anna only reads her child\'s folder');

    const j = (await post({ items: ALL })).json.job;
    assert.deepEqual([j.state, j.total, j.done, j.provider, j.account, j.targetFolderId, j.areaId, j.targetPath], ['queued', 3, 0, 'google', ACCOUNT, mine.rootId, mine.id, '']);
    const t = await host.tick();
    assert.deepEqual(t.imports, { items: 8, jobs: 1 }, 'four chosen, two folders listed, their three files and one folder');
    const done = (await a('GET', `import/jobs/${j.id}`)).json.job;
    assert.deepEqual([done.state, done.total, done.done, done.skipped, done.failed, done.folders, done.scanning, done.failures],
      ['done', 6, 5, 1, 0, 2, false, []]);
    assert.ok(done.finishedAt);
    // the tree as in the cloud drive, with its change dates
    const at = async (p) => (await a('GET', 'nodes/by-path', null, { area: mine.id, path: p })).json.node;
    const gas = await at('Belege/Alt_ 2025/Gas.pdf');
    assert.deepEqual([gas.size, gas.mtime, gas.mime], [3, '2025-02-01T10:00:00.000Z', 'application/pdf']);
    assert.equal((await at('Belege/Strom.pdf')).mtime, '2026-03-01T10:00:00.000Z');
    const empty = await at('Belege/Alt_ 2025/leer.txt');
    assert.deepEqual([empty.size, empty.mediaId], [0, null]);
    const docx = await at('Einkaufsliste.docx');
    assert.equal(docx.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // a name that exists: a new version; the same bytes: left as they were
    const note = await at('Notiz.txt');
    assert.deepEqual([note.id, note.rev, note.mtime], [old.id, 2, '2026-01-05T08:00:00.000Z']);
    assert.equal((await a('GET', `nodes/${old.id}/versions`)).json.versions.length, 1);
    assert.equal((await at('Gleich.txt')).rev, 1);
    assert.equal(host.cloudImports.length, 5, 'the empty file needs no import');
    // the change log names the import, the person is told live
    const ch = (await a('GET', 'changes', null, { since: 0 })).json.changes;
    assert.ok(ch.filter((x) => x.device === 'import:google').length >= 6);
    assert.ok(c.events().some((e) => e.type === 'import' && e.users[0] === ANNA.id && e.data.job.id === j.id && e.data.job.state === 'done'));
    assert.ok(c.events().some((e) => e.type === 'changed' && e.data.areas.includes(mine.id)));

    // the same again: the folders are used, nothing new
    const j2 = (await post({ items: ALL })).json.job;
    await host.tick();
    const d2 = (await a('GET', `import/jobs/${j2.id}`)).json.job;
    assert.deepEqual([d2.state, d2.done, d2.skipped], ['done', 0, 6]);
    assert.equal((await a('GET', `nodes/${mine.rootId}/children`)).json.items.filter((x) => x.name.startsWith('Belege')).length, 1);
    assert.equal((await at('Notiz.txt')).rev, 2);
    // the list; an ended job is removed from it
    assert.deepEqual((await a('GET', 'import/jobs')).json.jobs.map((x) => x.id), [j2.id, j.id]);
    assert.deepEqual((await a('DELETE', `import/jobs/${j.id}`)).json, { ok: true, removed: true, id: j.id });
    assert.equal((await a('GET', `import/jobs/${j.id}`)).status, 404);
  });
});

test('a stop (GateControl\'s rate limit) — the job goes on where it was; cancelled — nothing more comes', async () => {
  let block = null;
  await withHost({ cloud: { files: files(), fail: (op, x) => (block && op === 'import' && x.fileId === block ? 'ERR_RATE_LIMIT' : null) } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    block = 'b2';
    const j = (await a('POST', 'import/jobs', { connection: conn.id, items: ALL, targetFolderId: mine.rootId })).json.job;
    await host.tick();
    await host.tick();
    let v = (await a('GET', `import/jobs/${j.id}`)).json.job;
    assert.equal(v.state, 'running');
    assert.ok(v.done >= 1 && v.done < 5);
    const imported = host.cloudImports.length;
    block = null;
    await host.tick();
    v = (await a('GET', `import/jobs/${j.id}`)).json.job;
    assert.deepEqual([v.state, v.done, v.skipped], ['done', 6, 0]);
    assert.equal(host.cloudImports.length, imported + 1, 'only what was missing (Gas.pdf; leer.txt needs no import)');

    // cancelled in the middle
    block = 'b2';
    const k = (await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'f-belege', isDir: true, name: 'Belege 2' }], targetFolderId: mine.rootId })).json.job;
    await host.tick();
    const cancelled = (await a('DELETE', `import/jobs/${k.id}`)).json.job;
    assert.equal(cancelled.state, 'cancelled');
    block = null;
    const before = host.cloudImports.length;
    await host.tick();
    assert.equal(host.cloudImports.length, before);
    assert.equal((await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Belege 2/Alt_ 2025/Gas.pdf' })).status, 404);
    assert.equal((await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Belege 2/Strom.pdf' })).status, 200, 'what came stays');
    assert.equal((await a('POST', `import/jobs/${k.id}/resume`)).json.field, 'state');
  });
});

test('connect again and resume: a job paused for the account goes on with the new connection', async () => {
  await withHost({ cloud: { files: files() } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    const j = (await a('POST', 'import/jobs', { connection: conn.id, items: ALL, targetFolderId: mine.rootId })).json.job;
    host.cloudRevoke(conn.id);
    await host.tick();
    let v = (await a('GET', `import/jobs/${j.id}`)).json.job;
    assert.deepEqual([v.state, v.error, v.done], ['paused', 'cloud_auth', 0]);
    await host.tick();
    assert.equal(host.cloudImports.length, 0);
    const conn2 = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    const bobs = host.cloudConnect(BOB.id, 'google', 'bob@example.com');
    assert.equal((await a('POST', `import/jobs/${j.id}/resume`, { connection: bobs.id })).status, 404);
    assert.equal((await c.as(BOB)('POST', `import/jobs/${j.id}/resume`, { connection: bobs.id })).status, 404);
    v = (await a('POST', `import/jobs/${j.id}/resume`, { connection: conn2.id })).json.job;
    assert.deepEqual([v.state, v.connection, v.error], ['queued', conn2.id, null]);
    await host.tick();
    assert.equal((await a('GET', `import/jobs/${j.id}`)).json.job.state, 'done');

    // disconnecting pauses what runs on it
    const k = (await a('POST', 'import/jobs', { connection: conn2.id, items: [{ id: 'top', isDir: false }], targetFolderId: mine.rootId })).json.job;
    await a('DELETE', `import/connections/${conn2.id}`);
    v = (await a('GET', `import/jobs/${k.id}`)).json.job;
    assert.deepEqual([v.state, v.error], ['paused', 'cloud_auth']);
  });
});

test('failures: an item tried three times, one gone or too large; quota pauses; the target gone fails the job', async () => {
  const fails = {};
  await withHost({ cloud: { files: files(), fail: (op, x) => (op === 'import' ? fails[x.fileId] || null : null) } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    Object.assign(fails, { b1: 'ERR_CLOUD_PROVIDER', b2: 'ERR_CLOUD_NOT_FOUND', top: 'ERR_CLOUD_TOO_LARGE' });
    const j = (await a('POST', 'import/jobs', { connection: conn.id, items: ALL, targetFolderId: mine.rootId })).json.job;
    for (let i = 0; i < 4; i++) await host.tick();
    const v = (await a('GET', `import/jobs/${j.id}`)).json.job;
    assert.deepEqual([v.state, v.failed, v.done], ['done', 3, 3]);
    assert.deepEqual(v.failures, [{ name: 'Notiz.txt', error: 'too_large' }, { name: 'Strom.pdf', error: 'cloud_error' }, { name: 'Gas.pdf', error: 'not_found' }]);
    // resume tries the provider's failures again
    delete fails.b1;
    await a('POST', `import/jobs/${j.id}/resume`);
    await host.tick();
    const r = (await a('GET', `import/jobs/${j.id}`)).json.job;
    assert.deepEqual([r.state, r.failed], ['done', 2]);

    // the space of the area is used up: paused
    fails.same = 'ERR_MEDIA_QUOTA';
    const k = (await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'same', isDir: false }], targetFolderId: mine.rootId })).json.job;
    await host.tick();
    assert.deepEqual(['paused', 'quota'], [(await a('GET', `import/jobs/${k.id}`)).json.job.state, (await a('GET', `import/jobs/${k.id}`)).json.job.error]);
    // the target folder went into the trash: failed
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Ziel' })).json.node;
    const m = (await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'doc1', isDir: false }], targetFolderId: dir.id })).json.job;
    await a('DELETE', `nodes/${dir.id}`);
    await host.tick();
    const f = (await a('GET', `import/jobs/${m.id}`)).json.job;
    assert.deepEqual([f.state, f.error, f.targetPath], ['failed', 'not_found', null]);
  });
});

test('rights and limits: only my jobs, a seat, writing in the target, at most five running', async () => {
  await withHost({ cloud: { files: files() } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const conn = host.cloudConnect(ANNA.id, 'google', ACCOUNT);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'top', isDir: false }], targetFolderId: mine.rootId })).json.job.id);
    const sixth = await a('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'top', isDir: false }], targetFolderId: mine.rootId });
    assert.deepEqual([sixth.status, sixth.json.code], [409, 'job_limit']);
    const bob = c.as(BOB);
    assert.equal((await bob('GET', `import/jobs/${ids[0]}`)).status, 404);
    assert.equal((await bob('DELETE', `import/jobs/${ids[0]}`)).status, 404);
    assert.deepEqual((await bob('GET', 'import/jobs')).json.jobs, []);
    assert.equal((await c.as(OMA)('GET', 'import/sources')).json.code, 'no_seat');
    // Marc into Anna's files: not his
    const mc = host.cloudConnect(MARC.id, 'google', ACCOUNT);
    assert.equal((await c.as(MARC)('POST', 'import/jobs', { connection: mc.id, items: [{ id: 'top', isDir: false }], targetFolderId: mine.rootId })).status, 404);
    // the family's folder: yes
    const fam = await c.area(MARC, 'family');
    assert.equal((await c.as(MARC)('POST', 'import/jobs', { connection: mc.id, items: [{ id: 'top', isDir: false }], targetFolderId: fam.rootId })).status, 200);
    // Anna's seat switched off: her jobs fail in the background
    await c.admin('PUT', `admin/seats/${ANNA.id}`, { kind: null });
    await host.tick();
    assert.equal((await c.as(MARC)('GET', 'import/jobs')).json.jobs[0].state, 'done');
    const st = await host.gc.db.query('SELECT state, error FROM import_jobs WHERE user_id = ?', [ANNA.id]);
    assert.ok(st.rows.every((r) => r.state === 'failed' && r.error === 'no_seat'));
  });
});
