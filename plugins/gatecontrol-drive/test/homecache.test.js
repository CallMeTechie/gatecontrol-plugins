'use strict';

// The home cache of the gateways (1.20.0, homecache.js): "offline verfügbar" (GET offline, PUT|DELETE nodes/<id>/offline),
// the offers to GateControl's gc.homeCache (≥ 1.231.0) — opened in 30 days, offline, photos of 90 days, vault files only
// encrypted — with the people who may see each file, withdrawn when that ends; `lan` on GET nodes/<id>/content of an app
// in the home network, never for someone who may not see the file; nothing of it with an older GateControl.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const VC = require('../ui/vaultcrypto');
const homecache = require('../server/homecache');
const { withHost, ANNA, MARC, LENA, OMA, BOB, OFFICE, DAY, MIN } = require('./helpers');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HC = { gatecontrol: '1.231.0', homeCache: {} };
const offerOf = (host, data) => host.homeCache.offers.get(sha(data)) || null;
const calls = (host, op) => host.homeCache.calls.filter((x) => x.op === op);
/** the background run now (the 15-minute rhythm: a run is due after RUN_MS) */
async function run(host, c, ms = 16 * MIN) {
  c.clock.add(ms);
  return (await host.tick()).homeCache;
}

test('an older GateControl: "offline verfügbar" works, no offers, no lan, no feature homeCache', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Brief.txt', 'brief')).json.node;
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('offline'));
    assert.ok(!me.features.includes('homeCache'));
    const p = await a('PUT', `nodes/${f.id}/offline`);
    assert.equal(p.status, 200);
    assert.equal(p.json.node.offline, true);
    assert.equal(p.json.node.offlineAt, new Date(c.clock.now()).toISOString());
    assert.deepEqual((await a('GET', 'offline')).json.items.map((x) => x.id), [f.id]);
    const got = await c.home(ANNA)('GET', `nodes/${f.id}/content`);
    assert.equal(got.status, 200);
    assert.equal(got.json.lan, undefined);
    assert.deepEqual(await run(host, c), { skipped: 'unavailable' });
    assert.equal(host.homeCache.calls.length, 0);
    assert.equal((await c.admin('GET', 'admin/overview')).json.overview.homeCache.available, false);
    assert.deepEqual(await host.settingsStatus('de'), []);
  });
});

test('offline verfügbar: only what I may read, a folder, idempotent, removed again, gone with the node', async () => {
  await withHost(HC, async (host, c) => {
    const a = c.as(ANNA);
    const m = c.as(MARC);
    const mine = await c.area(ANNA, 'mine');
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Reise' })).json.node;
    const f = (await c.put(ANNA, dir.id, 'Plan.txt', 'plan')).json.node;
    // Marc may not read Anna's files
    assert.equal((await m('PUT', `nodes/${f.id}/offline`)).status, 404);
    assert.equal((await a('PUT', 'nodes/999999/offline')).status, 404);
    assert.equal((await a('PUT', `nodes/${dir.id}/offline`)).status, 200);
    c.clock.add(MIN);
    const again = await a('PUT', `nodes/${dir.id}/offline`);
    assert.equal(again.json.node.offlineAt, new Date(c.clock.now() - MIN).toISOString(), 'the first time stays');
    assert.deepEqual((await a('GET', 'offline')).json.items.map((x) => [x.id, x.isDir, x.offline]), [[dir.id, true, true]]);
    assert.deepEqual((await m('GET', 'offline')).json.items, []);
    const del = await a('DELETE', `nodes/${dir.id}/offline`);
    assert.deepEqual([del.status, del.json.offline, del.json.removed], [200, false, true]);
    assert.equal((await a('DELETE', `nodes/${dir.id}/offline`)).json.removed, false);
    await a('PUT', `nodes/${f.id}/offline`);
    // in the trash: not listed; deleted for good: the mark goes
    await a('DELETE', `nodes/${f.id}`);
    assert.deepEqual((await a('GET', 'offline')).json.items, []);
    await a('DELETE', `trash/${f.id}`);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM offline_pins')).row.n, 0);
  });
});

test('offers: opened, offline and photos with their people and priorities; one offer per content; idempotent and throttled', async () => {
  await withHost({ ...HC, settings: {} }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('homeCache') && me.features.includes('offline'));
    // opened by Anna in my files: only Anna
    const brief = (await c.put(ANNA, mine.rootId, 'Brief.txt', 'brief')).json.node;
    await a('GET', `nodes/${brief.id}/content`);
    // opened by Marc in the family: the family's people with a family seat (Anna, Marc, Lena — not Oma, not Bob)
    const liste = (await c.put(MARC, fam.rootId, 'Liste.txt', 'liste')).json.node;
    await c.as(MARC)('GET', `nodes/${liste.id}/content`);
    // offline: a folder of the family with what is below it
    const reise = (await a('POST', 'nodes', { parentId: fam.rootId, name: 'Reise' })).json.node;
    const ticket = (await c.put(ANNA, reise.id, 'Ticket.pdf', 'ticket', { mime: 'application/pdf' })).json.node;
    await a('PUT', `nodes/${reise.id}/offline`);
    // photos: taken 10 days ago, 60 days ago, 120 days ago (too old); the same picture twice
    const now = c.clock.now();
    await c.put(ANNA, mine.rootId, 'neu.jpg', 'neu-jpeg', { mime: 'image/jpeg', takenAt: now - 10 * DAY });
    await c.put(MARC, fam.rootId, 'mittel.jpg', 'mittel-jpeg', { mime: 'image/jpeg', takenAt: now - 60 * DAY });
    await c.put(ANNA, mine.rootId, 'alt.jpg', 'alt-jpeg', { mime: 'image/jpeg', takenAt: now - 120 * DAY });
    await c.put(ANNA, fam.rootId, 'neu (Kopie).jpg', 'neu-jpeg', { mime: 'image/jpeg', takenAt: now - 10 * DAY });
    // an empty file is never offered
    await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'leer.txt', size: 0 });

    const r = await run(host, c);
    assert.equal(r.offered, 5, JSON.stringify(r));
    assert.deepEqual(offerOf(host, 'brief'), { ...offerOf(host, 'brief'), kind: 'drive', priority: 70, userIds: [ANNA.id] });
    assert.deepEqual(offerOf(host, 'liste'), { ...offerOf(host, 'liste'), kind: 'drive', priority: 70, userIds: [ANNA.id, MARC.id, LENA.id] });
    assert.deepEqual(offerOf(host, 'ticket'), { ...offerOf(host, 'ticket'), kind: 'drive', priority: 90, userIds: [ANNA.id, MARC.id, LENA.id], mediaId: ticket.mediaId });
    // the same picture in my files and the family: one offer, its people united
    assert.deepEqual(offerOf(host, 'neu-jpeg'), { ...offerOf(host, 'neu-jpeg'), kind: 'photos', priority: 40, userIds: [ANNA.id, MARC.id, LENA.id] });
    assert.deepEqual(offerOf(host, 'mittel-jpeg'), { ...offerOf(host, 'mittel-jpeg'), kind: 'photos', priority: 30 });
    assert.equal(offerOf(host, 'alt-jpeg'), null);
    assert.equal(host.homeCache.offers.size, 5);

    // nothing changed: no call (idempotent); not due before 15 minutes
    const before = host.homeCache.calls.length;
    assert.deepEqual(await run(host, c, MIN), { skipped: 'not_due' });
    const again = await run(host, c);
    assert.deepEqual([again.offered, again.withdrawn, again.unchanged], [0, 0, 5]);
    assert.equal(host.homeCache.calls.length, before);

    // the admin's overview and the line below the settings
    const ov = (await c.admin('GET', 'admin/overview')).json.overview.homeCache;
    assert.deepEqual([ov.available, ov.files, ov.error], [true, 5, null]);
    assert.equal(ov.bytes, ['brief', 'liste', 'ticket', 'neu-jpeg', 'mittel-jpeg'].reduce((s, x) => s + x.length, 0));
    const st = await host.settingsStatus('de');
    assert.deepEqual(st, [{ group: null, tone: 'info', text: `Zwischenspeicher im Heimnetz: 5 Dateien (${ov.bytes} B) den Heim-Gateways angeboten (Gateways › Zwischenspeicher).` }]);

    // a change of offline: the next minute already; the folder's files fall back to what else they are
    await a('DELETE', `nodes/${reise.id}/offline`);
    const after = await run(host, c, MIN);
    assert.equal(after.withdrawn, 1);
    assert.equal(offerOf(host, 'ticket'), null);
    assert.ok(calls(host, 'withdraw').some((x) => x.args.mediaId === ticket.mediaId));
    // older than its time: opened 7 … 30 days ago → 60, then gone; photos after 90 days gone
    c.clock.add(8 * DAY);
    await run(host, c);
    assert.equal(offerOf(host, 'brief').priority, 60);
    c.clock.add(23 * DAY);
    await run(host, c);
    assert.equal(offerOf(host, 'brief'), null);
    assert.equal(offerOf(host, 'liste'), null);
    assert.equal(offerOf(host, 'mittel-jpeg'), null, 'taken 91 days ago');
    assert.equal(offerOf(host, 'neu-jpeg').priority, 30);
  });
});

test('withdrawn or narrowed: in the trash, held back by the virus scan, a seat taken, a child\'s folder closed to the parents, a team folder', async () => {
  await withHost(HC, async (host, c) => {
    const a = c.as(ANNA);
    const l = c.as(LENA);
    const fam = await c.area(ANNA, 'family');
    const kid = await c.area(LENA, 'child');
    const doc = (await c.put(ANNA, fam.rootId, 'Vertrag.pdf', 'vertrag', { mime: 'application/pdf' })).json.node;
    await a('PUT', `nodes/${doc.id}/offline`);
    const bad = (await c.put(ANNA, fam.rootId, 'Rechnung.pdf', 'rechnung', { mime: 'application/pdf' })).json.node;
    await a('PUT', `nodes/${bad.id}/offline`);
    const heft = (await c.put(LENA, kid.rootId, 'Heft.txt', 'heft')).json.node;
    await l('GET', `nodes/${heft.id}/content`);
    // Marc keeps a family file offline
    const mp = (await c.put(MARC, fam.rootId, 'Marc.txt', 'marcs')).json.node;
    await c.as(MARC)('PUT', `nodes/${mp.id}/offline`);
    // a team folder of the group "Büro": people with a business seat only (Bob; Anna is a member with a family seat)
    const team = (await c.admin('POST', 'admin/teams', { label: 'Büro', members: [{ principal: `g:${OFFICE}`, role: 'write' }] })).json.team;
    const tarea = await c.area(BOB, 'team', team.id);
    const memo = (await c.put(BOB, tarea.rootId, 'Memo.txt', 'memo')).json.node;
    await c.as(BOB)('PUT', `nodes/${memo.id}/offline`);
    await run(host, c);
    assert.deepEqual(offerOf(host, 'vertrag').userIds, [ANNA.id, MARC.id, LENA.id]);
    assert.deepEqual(offerOf(host, 'heft').userIds, [MARC.id, ANNA.id, LENA.id].sort());
    assert.deepEqual(offerOf(host, 'memo').userIds, [BOB.id]);
    assert.deepEqual(offerOf(host, 'marcs').userIds, [ANNA.id, MARC.id, LENA.id]);

    // the virus scan holds a file back: withdrawn; in the trash: withdrawn
    await host.gc.db.run("INSERT INTO media_scan (media_id, state, blocked, at) VALUES (?, 'infected', 1, ?)", [bad.mediaId, c.clock.now()]);
    await a('DELETE', `nodes/${doc.id}`);
    // Marc's seat taken; the parents may no longer look into the children's folders; the team folder archived
    await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: null });
    await host.saveSettings({ child_parents_view: false });
    await c.admin('PUT', `admin/teams/${team.id}`, { archived: true });
    const r = await run(host, c, MIN);
    assert.equal(offerOf(host, 'vertrag'), null);
    assert.equal(offerOf(host, 'rechnung'), null);
    assert.equal(offerOf(host, 'memo'), null);
    // Marc may no longer use Drive: his "offline" no longer counts
    assert.equal(offerOf(host, 'marcs'), null);
    assert.deepEqual(offerOf(host, 'heft').userIds, [LENA.id]);
    assert.deepEqual([r.withdrawn, r.offered], [4, 1], JSON.stringify(r));
    // back from the trash: offered again
    await a('POST', `trash/${doc.id}/restore`);
    await run(host, c);
    assert.deepEqual(offerOf(host, 'vertrag').userIds, [ANNA.id, LENA.id]);
  });
});

test('lan on GET nodes/<id>/content: an app at home, a file Drive offered, the gateway holds it, the person may see it', async () => {
  const held = new Set();
  await withHost({ ...HC, homeCache: { held: (s) => held.has(s) } }, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const kid = await c.area(LENA, 'child');
    const plan = (await c.put(ANNA, fam.rootId, 'Plan.txt', 'plan')).json.node;
    const heft = (await c.put(LENA, kid.rootId, 'Heft.txt', 'heft')).json.node;
    const other = (await c.put(ANNA, fam.rootId, 'Anderes.txt', 'anderes')).json.node;
    await a('PUT', `nodes/${plan.id}/offline`);
    await c.as(LENA)('PUT', `nodes/${heft.id}/offline`);
    // before any offer: no lan, and GateControl is not even asked
    assert.equal((await c.home(ANNA)('GET', `nodes/${plan.id}/content`)).json.lan, undefined);
    assert.equal(calls(host, 'lanHint').length, 0);
    await run(host, c);
    // offered, but the gateway does not hold it yet
    assert.equal((await c.home(ANNA)('GET', `nodes/${plan.id}/content`)).json.lan, undefined);
    held.add(sha('plan')).add(sha('heft')).add(sha('anderes'));
    const got = await c.home(ANNA)('GET', `nodes/${plan.id}/content`);
    assert.equal(got.status, 200);
    const lan = got.json.lan;
    assert.deepEqual(Object.keys(lan).sort(), ['exp', 'sha256', 'tlsSha256', 'url']);
    assert.equal(lan.sha256, sha('plan'));
    assert.equal(lan.sha256, plan.sha256);
    assert.equal(lan.tlsSha256, 'ab'.repeat(32));
    assert.match(lan.url, new RegExp(`^https://192\\.168\\.1\\.23:8443/blob/${sha('plan')}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    assert.ok(got.json.url, 'the normal download stays');
    // the same for Marc (family) — not away from home, not in the portal (a browser cannot pin), not a file never offered
    assert.equal((await c.home(MARC)('GET', `nodes/${plan.id}/content`)).json.lan.sha256, sha('plan'));
    assert.equal((await a('GET', `nodes/${plan.id}/content`)).json.lan, undefined);
    assert.equal((await host.request({ method: 'GET', path: `nodes/${plan.id}/content`, user: { ...ANNA, portal: true, loggedIn: true }, home: true })).json.lan, undefined);
    const n = calls(host, 'lanHint').length;
    assert.equal((await c.home(ANNA)('GET', `nodes/${other.id}/content`)).json.lan, undefined);
    assert.equal(calls(host, 'lanHint').length, n, 'no host call for a file Drive did not offer');

    // nobody gets a hint for a file they may not see: Oma and Bob are refused before any hint
    for (const u of [OMA, BOB]) {
      const r = await c.home(u)('GET', `nodes/${plan.id}/content`);
      assert.notEqual(r.status, 200);
      assert.equal(r.json.lan, undefined);
    }
    // the parents may no longer look into Lena's folder: refused at once (before the next run), then off the offer
    assert.ok((await c.home(MARC)('GET', `nodes/${heft.id}/content`)).json.lan);
    await host.saveSettings({ child_parents_view: false });
    const refused = await c.home(MARC)('GET', `nodes/${heft.id}/content`);
    assert.equal(refused.status, 404);
    assert.equal(refused.json.lan, undefined);
    await run(host, c, MIN);
    assert.deepEqual(offerOf(host, 'heft').userIds, [LENA.id]);
    assert.ok((await c.home(LENA)('GET', `nodes/${heft.id}/content`)).json.lan);
    // allowed again: Marc reads it at once, but the offer still names only Lena until the next run — GateControl gives
    // him no hint (the offer's people decide there too), then the run adds him
    await host.saveSettings({ child_parents_view: true });
    const early = await c.home(MARC)('GET', `nodes/${heft.id}/content`);
    assert.equal(early.status, 200);
    assert.equal(early.json.lan, undefined);
    await run(host, c, MIN);
    assert.ok((await c.home(MARC)('GET', `nodes/${heft.id}/content`)).json.lan);

    // in the trash: no content, no hint; withdrawn at the next run
    await a('DELETE', `nodes/${plan.id}`);
    assert.equal((await c.home(ANNA)('GET', `nodes/${plan.id}/content`)).status, 404);
    await run(host, c);
    assert.equal(offerOf(host, 'plan'), null);
  });
});

// ── vault files: only their ciphertext, kind 'vault' ──

async function makeVault(call, parentId) {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const r = await call('POST', 'vaults', {
    id, parentId, nameCipher: await VC.encryptName(tk, id, 1, 'Steuer'), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key), recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1),
    device: { publicKey: VC.b64u(raw), name: 'Laptop', platform: 'windows' }, wrap: await VC.wrapKey(tk, raw, id, 1),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id, tk, node: r.json.node };
}

test('vault files: fetched or offline → kind vault, the ciphertext GateControl holds; never as recently opened', async () => {
  await withHost(HC, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const v = await makeVault(a, mine.rootId);
    const parts = await VC.encryptContent(v.tk, v.id, 1, new Uint8Array(Buffer.from('geheim')));
    const cipher = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const mediaId = await c.upload(ANNA, cipher, 'application/octet-stream');
    const up = await a('POST', 'uploads/commit', { mediaId, parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Bescheid.pdf'), keyVersion: 1 });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const file = up.json.node;
    await a('GET', `nodes/${file.id}/content`);
    await run(host, c);
    const o = host.homeCache.offers.get(crypto.createHash('sha256').update(cipher).digest('hex'));
    assert.deepEqual([o.kind, o.priority, o.userIds, o.mediaId], ['vault', 70, [ANNA.id], file.mediaId]);
    assert.ok(!String(host.media.get(o.mediaId).data).includes('geheim'), 'only ciphertext');
    // not in "Zuletzt geöffnet"
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM recent_opens WHERE node_id = ?', [file.id])).row.n, 0);
    // offline: the vault folder with its files
    await a('PUT', `nodes/${v.node.id}/offline`);
    await run(host, c, MIN);
    assert.equal(host.homeCache.offers.get(o.sha256).priority, 90);
    assert.equal(host.homeCache.offers.get(o.sha256).kind, 'vault');
  });
});

test('offer errors: a file GateControl no longer has is skipped and tried again, content from elsewhere is not offered', async () => {
  const fooled = sha('update');
  await withHost({ ...HC, homeCache: { foreign: [fooled] } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const x = (await c.put(ANNA, mine.rootId, 'x.txt', 'xxx')).json.node;
    const u = (await c.put(ANNA, mine.rootId, 'u.bin', 'update')).json.node;
    await a('PUT', `nodes/${x.id}/offline`);
    await a('PUT', `nodes/${u.id}/offline`);
    host.media.delete(x.mediaId);
    const r = await run(host, c);
    assert.deepEqual([r.offered, r.failed], [1, 1]);
    assert.equal(offerOf(host, 'xxx'), null);
    // offered: false — kept as such (no hint, not counted), not sent again
    assert.equal(offerOf(host, 'update'), null);
    assert.equal((await c.admin('GET', 'admin/overview')).json.overview.homeCache.files, 0);
    assert.equal((await c.home(ANNA)('GET', `nodes/${u.id}/content`)).json.lan, undefined);
    const n = calls(host, 'offer').length;
    await run(host, c);
    assert.equal(calls(host, 'offer').length, n + 1, 'only the missing file is tried again');
  });
});

test('GateControl refuses (rate limit): the run stops, says so, and comes again the next minute; a hint that fails is no hint', async () => {
  let refuse = null;
  await withHost({ ...HC, homeCache: { fail: (op) => (refuse && refuse.includes(op) ? 'ERR_RATE_LIMIT' : null) } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'f.txt', 'fff')).json.node;
    await a('PUT', `nodes/${f.id}/offline`);
    refuse = ['offer'];
    assert.deepEqual(await run(host, c), { error: 'ERR_RATE_LIMIT' });
    const ov = (await c.admin('GET', 'admin/overview')).json.overview.homeCache;
    assert.deepEqual([ov.files, ov.error], [0, 'ERR_RATE_LIMIT']);
    assert.equal((await host.settingsStatus('de'))[0].tone, 'warn');
    refuse = null;
    const r = await run(host, c, MIN);
    assert.equal(r.offered, 1);
    assert.equal((await c.admin('GET', 'admin/overview')).json.overview.homeCache.error, null);
    refuse = ['lanHint'];
    const got = await c.home(ANNA)('GET', `nodes/${f.id}/content`);
    assert.equal(got.status, 200);
    assert.equal(got.json.lan, undefined);
  });
});

test('at most LIMITS.calls host calls a run: withdrawals first, the highest priority first, the rest the next minute', async () => {
  await withHost(HC, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const keep = homecache.LIMITS.calls;
    try {
      const old = [];
      for (const x of ['a1', 'a2', 'a3']) {
        const n = (await c.put(ANNA, mine.rootId, `${x}.txt`, x)).json.node;
        await a('GET', `nodes/${n.id}/content`);
        old.push(n);
      }
      homecache.LIMITS.calls = 2;
      let r = await run(host, c);
      assert.deepEqual([r.offered, r.more], [2, true]);
      r = await run(host, c, MIN);
      assert.deepEqual([r.offered, r.unchanged, r.more], [1, 2, false]);
      assert.deepEqual(await run(host, c, MIN), { skipped: 'not_due' });
      // two go into the trash, a new one is pinned: the withdrawals come first
      await a('DELETE', `nodes/${old[0].id}`);
      await a('DELETE', `nodes/${old[1].id}`);
      const p = (await c.put(ANNA, mine.rootId, 'p.txt', 'pinned')).json.node;
      await a('PUT', `nodes/${p.id}/offline`);
      r = await run(host, c, MIN);
      assert.deepEqual([r.withdrawn, r.offered, r.more], [2, 0, true]);
      r = await run(host, c, MIN);
      assert.deepEqual([r.withdrawn, r.offered, r.more], [0, 1, false]);
      assert.equal(offerOf(host, 'pinned').priority, 90);
      assert.deepEqual([...host.homeCache.offers.values()].map((o) => o.priority).sort(), [70, 90]);
    } finally { homecache.LIMITS.calls = keep; }
  });
});

test('previews (1.24.0, GateControl ≥ 1.249.0): small ones of what is offered and of the photo grid, large ones of new photos; their hints in the lists', async () => {
  const held = new Set();
  await withHost({ gatecontrol: '1.249.0', homeCache: { held: (s) => held.has(s) } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const now = c.clock.now();
    const neu = (await c.put(ANNA, mine.rootId, 'neu.jpg', 'neu-jpeg', { mime: 'image/jpeg', takenAt: now - 10 * DAY })).json.node;
    const alt = (await c.put(ANNA, mine.rootId, 'alt.jpg', 'alt-jpeg', { mime: 'image/jpeg', takenAt: now - 400 * DAY })).json.node;
    const clip = (await c.put(ANNA, mine.rootId, 'clip.mp4', 'clip-mp4', { mime: 'video/mp4', takenAt: now - 5 * DAY })).json.node;
    const brief = (await c.put(ANNA, mine.rootId, 'Brief.txt', 'brief')).json.node;
    await a('GET', `nodes/${brief.id}/content`);
    assert.ok((await a('GET', 'me')).json.features.includes('homeCachePreviews'));
    const pv = (n, size) => sha(`preview:${n.mediaId}:${size}`);
    const offerOfPreview = (n, size) => host.homeCache.offers.get(pv(n, size)) || null;

    // the first run: the files; the previews are being made (GateControl: ERR_PREVIEW_PENDING) — the video has none
    const r1 = await run(host, c);
    assert.ok(r1.pending >= 2, JSON.stringify(r1));
    assert.ok(offerOf(host, 'neu-jpeg') && offerOf(host, 'brief') && offerOf(host, 'clip-mp4'));
    assert.equal(calls(host, 'offer').filter((x) => x.args.mediaId === clip.mediaId && x.args.preview).length, 0, 'no call for a video without a preview');
    // the next run: offered
    const r2 = await run(host, c);
    assert.equal(r2.pending || 0, 0, JSON.stringify(r2));
    assert.equal([...host.homeCache.offers.values()].filter((o) => o.preview).length, 3);
    assert.deepEqual(offerOfPreview(neu, 'small'), { ...offerOfPreview(neu, 'small'), kind: 'photos', priority: 95, preview: 'small', userIds: [ANNA.id], mediaId: neu.mediaId });
    assert.deepEqual(offerOfPreview(neu, 'large'), { ...offerOfPreview(neu, 'large'), kind: 'photos', priority: 45, preview: 'large' });
    // an old photo of the grid: its small preview only (its original is too old for the stock)
    assert.equal(offerOfPreview(alt, 'small').priority, 95);
    assert.equal(offerOfPreview(alt, 'large'), null);
    assert.equal(offerOf(host, 'alt-jpeg'), null);
    // idempotent
    const r3 = await run(host, c);
    assert.deepEqual([r3.offered, r3.withdrawn], [0, 0], JSON.stringify(r3));
    // the admin overview counts the files and the previews apart
    const ov = (await c.admin('GET', 'admin/overview')).json.overview.homeCache;
    assert.deepEqual([ov.files, ov.previews], [3, 3]);
    assert.equal(ov.previewBytes, [pv(neu, 'small'), pv(neu, 'large'), pv(alt, 'small')].reduce((s, h) => s + host.homeCache.offers.get(h).size, 0));

    // the lists of an app at home: the hints of what the gateway holds, in one host call per answer
    held.add(pv(neu, 'small')).add(pv(neu, 'large'));
    const before = calls(host, 'lanHints').length;
    const list = (await c.home(ANNA)('GET', `nodes/${mine.rootId}/children`)).json.items;
    assert.equal(calls(host, 'lanHints').length, before + 1);
    const byName = (n) => list.find((x) => x.name === n);
    assert.equal(byName('neu.jpg').preview.lan.sha256, pv(neu, 'small'));
    assert.equal(byName('neu.jpg').preview.largeLan.sha256, pv(neu, 'large'));
    assert.match(byName('neu.jpg').preview.lan.url, new RegExp(`^https://192\\.168\\.1\\.23:8443/blob/${pv(neu, 'small')}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    assert.ok(byName('neu.jpg').preview.url, 'the preview URL stays');
    assert.equal(byName('alt.jpg').preview.lan, undefined, 'not held yet');
    assert.equal(byName('Brief.txt').preview, null);
    // the photo list
    const photos = (await c.home(ANNA)('GET', 'photos')).json.items;
    const p = photos.find((x) => x.mediaId === neu.mediaId);
    assert.equal(p.previewLan.sha256, pv(neu, 'small'));
    assert.equal(p.largeLan.sha256, pv(neu, 'large'));
    // away from home, in the portal: none
    assert.equal((await a('GET', `nodes/${mine.rootId}/children`)).json.items.find((x) => x.name === 'neu.jpg').preview.lan, undefined);
    assert.equal((await host.request({ method: 'GET', path: `nodes/${mine.rootId}/children`, user: { ...ANNA, portal: true, loggedIn: true }, home: true })).json.items.find((x) => x.name === 'neu.jpg').preview.lan, undefined);

    // the photo goes to the trash: its previews leave the stock with it (withdraw with the size)
    await a('DELETE', `nodes/${neu.id}`);
    const r4 = await run(host, c);
    assert.ok(r4.withdrawn >= 3, JSON.stringify(r4));
    assert.equal(offerOfPreview(neu, 'small'), null);
    assert.equal(offerOfPreview(neu, 'large'), null);
    assert.deepEqual(calls(host, 'withdraw').filter((x) => x.args.mediaId === neu.mediaId).map((x) => x.args.preview || 'file').sort(), ['file', 'large', 'small']);
    assert.ok(offerOfPreview(alt, 'small'));
  });
});
