'use strict';

// The import from Google Drive and OneDrive (since 1.8.0, feature `cloudImport`): GateControl's cloud accounts
// (gc.cloud, permissions.cloudImport — the OAuth apps are the administrator's, in GateControl › Einstellungen ›
// Cloud-Konten). A person connects their account, browses it, picks files or whole folders and a Drive folder; the
// background run imports them as that person (their rights, their seat): folders are made (or a folder of that name is
// used), the original change date becomes the file's mtime, a file of the same name becomes a new version (the same
// bytes: skipped). A job goes on where it stopped (import_items) — after a restart, a pause or a resume.
//
//   GET    import/sources                 → { google, microsoft, connections: [{ id, provider, account, connectedAt }] }
//   POST   import/connect                 { provider } → { url } — GateControl's OAuth start, back to the portal
//   DELETE import/connections/<id>        → { removed } — its jobs pause (cloud_auth)
//   GET    import/browse                  connection, folder?, cursor? → { items: [{ id, name, isDir, size, mime,
//                                           modifiedAt }], next, connection: { id, provider, account } }
//   POST   import/jobs                    { connection, items: [{ id, isDir, name? }] (1…500; folders need `name`),
//                                           targetFolderId } → { job }
//   GET    import/jobs                    → { jobs } — mine, newest first (≤ 50)
//   GET    import/jobs/<id>               → { job }
//   POST   import/jobs/<id>/resume        { connection? } → { job } — a paused or failed job goes on (another
//                                           connection of the same provider after connecting again); a done one tries
//                                           its cloud_error items again
//   DELETE import/jobs/<id>               a running one: cancelled → { job } (what came stays); an ended one: removed
//                                           → { removed: true, id }
//
// A job: { id, provider, account, connection, state: queued | running | paused | done | failed | cancelled, targetFolderId,
// areaId, targetPath, total (files found so far), done, failed, skipped (the same bytes were there), folders, bytes,
// scanning (folders still being listed), error, createdAt, updatedAt, finishedAt, failures: [{ name, error }] (≤ 20) }.
// paused: error cloud_auth (connect again, then resume), quota, cloud_off (an administrator switched it off); failed:
// no_seat, not_found / forbidden (the target folder is gone or no longer writable). An item fails with not_found,
// too_large, unsupported (a type Drive does not take), invalid (a name), cloud_error (three tries).
// The live event 'import' { job: { id, state, total, done, failed, skipped } } goes to the person after each run.

const store = require('./store');
const nodes = require('./nodes');
const files = require('./files');
const changes = require('./changes');
const address = require('./address');
const { fail, posInt, iso, nodeName } = require('./util');

const PROVIDERS = ['google', 'microsoft'];
const ITEMS_MAX = 500;
const JOB_ITEMS_MAX = 50000;
const ACTIVE_MAX = 5;
const STEPS_MAX = 200;
const TICK_MS = 45000;
const ATTEMPTS = 3;
const FAILURES_SHOWN = 20;
const KEEP_MS = 30 * 86400000;
const ACTIVE = ['queued', 'running', 'paused'];
const RETURN_TO = address.nodePath('import');
const NAME_BAD_RE = /[\0-\x1f\x7f<>:"/\\|?*]/g;

const hasCloud = (gc) => !!(gc.cloud && typeof gc.cloud.list === 'function' && typeof gc.cloud.import === 'function' && typeof gc.cloud.available === 'function');

/** The providers set up → { google, microsoft }, or null when the import is not usable (setting, host, none set up). */
async function sources(gc, settings) {
  if (!settings.cloudImport || !hasCloud(gc)) return null;
  // once per request or background run (its settings object)
  if (!memo.has(settings)) memo.set(settings, ask(gc));
  return memo.get(settings);
}
const memo = new WeakMap();

async function ask(gc) {
  let a;
  try { a = await gc.cloud.available(); } catch { return null; }
  if (!a || (a.google !== true && a.microsoft !== true)) return null;
  return { google: a.google === true, microsoft: a.microsoft === true };
}

// GateControl's refusals → Drive's codes
const CLOUD_CODES = {
  ERR_CLOUD_AUTH: 'cloud_auth', ERR_CLOUD_NOT_FOUND: 'not_found', ERR_CLOUD_TOO_LARGE: 'too_large', ERR_CLOUD_PROVIDER: 'cloud_error',
  ERR_TIMEOUT: 'cloud_error', ERR_RATE_LIMIT: 'rate_limit', ERR_CLOUD_NOT_CONFIGURED: 'feature_off', ERR_CLOUD_DENIED: 'feature_off',
  ERR_MEDIA_TYPE: 'unsupported', ERR_MEDIA_TOO_LARGE: 'too_large', ERR_MEDIA_QUOTA: 'quota',
};
const cloudFail = (e) => (e && CLOUD_CODES[e.code] ? fail(CLOUD_CODES[e.code]) : e);

async function connections(gc, uid) {
  const list = await gc.cloud.connections({ user: uid });
  return (Array.isArray(list) ? list : []).map((c) => ({ id: String(c.id), provider: c.provider, account: c.account || null, connectedAt: c.connectedAt || null }));
}

async function connOf(ctx, id) {
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id) || String(id).length > 200) throw fail('invalid', { field: 'connection' });
  let list;
  try { list = await connections(ctx.gc, ctx.viewer); } catch (e) { throw cloudFail(e); }
  const c = list.find((x) => x.id === String(id));
  if (!c) throw fail('not_found', { field: 'connection' });
  return c;
}

/** A cloud drive's name as a Drive name (what a NAS holds), `fallback` for one that is nothing then. */
function cleanName(v, fallback) {
  let s = typeof v === 'string' ? v.normalize('NFC').replace(NAME_BAD_RE, '_').trim() : '';
  s = s.replace(/[. ]+$/, '');
  if (s.length > 255) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, 255 - ext.length).replace(/[. ]+$/, '') + ext;
  }
  if (!s || s === '..' || s.toLowerCase() === '.gcdrive') s = `Import ${String(fallback || '').replace(NAME_BAD_RE, '_').slice(0, 40)}`.trim();
  return nodeName(s);
}

const msOf = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

function itemView(x) {
  return {
    id: String(x.id), name: typeof x.name === 'string' ? x.name : String(x.id), isDir: x.isDir === true,
    size: Number.isFinite(x.size) ? x.size : null, mime: x.mime || null, modifiedAt: x.modifiedAt || null,
  };
}

async function jobView(gc, j) {
  const target = await nodes.row(gc, j.target_id);
  const scanning = ACTIVE.includes(j.state) && !!(await store.one(gc, "SELECT 1 AS x FROM import_items WHERE job_id = ? AND is_dir = 1 AND state = 'todo' LIMIT 1", [j.id]));
  const folders = await store.one(gc, "SELECT COUNT(*) AS n FROM import_items WHERE job_id = ? AND is_dir = 1 AND state = 'done'", [j.id]);
  const failures = await store.all(gc, "SELECT name, cloud_id, error FROM import_items WHERE job_id = ? AND state = 'failed' ORDER BY id LIMIT ?", [j.id, FAILURES_SHOWN]);
  return {
    id: j.id, provider: j.provider, account: j.account || null, connection: j.connection, state: j.state,
    targetFolderId: j.target_id, areaId: j.area_id, targetPath: target && target.deleted_at == null ? await nodes.pathOf(gc, target) : null,
    total: j.total, done: j.done, failed: j.failed, skipped: j.skipped, folders: folders.n, bytes: j.bytes, scanning, error: j.error || null,
    createdAt: iso(j.created_at), updatedAt: iso(j.updated_at), finishedAt: iso(j.finished_at),
    failures: failures.map((f) => ({ name: f.name || f.cloud_id, error: f.error || 'failed' })),
  };
}

async function own(ctx, id) {
  const n = posInt(id);
  const j = n ? await store.one(ctx.gc, 'SELECT * FROM import_jobs WHERE id = ? AND user_id = ?', [n, ctx.viewer]) : null;
  if (!j) throw fail('not_found');
  return j;
}

// ─── the routes ─────────────────────────────────

async function connect(ctx, body) {
  const src = await sources(ctx.gc, ctx.settings);
  const p = body && body.provider;
  if (!PROVIDERS.includes(p)) throw fail('invalid', { field: 'provider' });
  if (!src[p]) throw fail('feature_off', { field: 'provider' });
  try {
    const r = await ctx.gc.cloud.connectUrl({ user: ctx.viewer, provider: p, returnTo: RETURN_TO });
    if (!r || typeof r.url !== 'string') throw fail('cloud_error');
    return { url: r.url };
  } catch (e) { throw cloudFail(e); }
}

async function disconnect(ctx, id) {
  const c = await connOf(ctx, id);
  let removed;
  try { removed = (await ctx.gc.cloud.disconnect({ user: ctx.viewer, connection: c.id })) === true; } catch (e) { throw cloudFail(e); }
  await store.run(ctx.gc, "UPDATE import_jobs SET state = 'paused', error = 'cloud_auth', updated_at = ? WHERE user_id = ? AND connection = ? AND state IN ('queued', 'running')",
    [ctx.now, ctx.viewer, c.id]);
  return { removed };
}

async function browse(ctx, q) {
  const c = await connOf(ctx, q && q.connection);
  const folder = q && q.folder != null && q.folder !== '' ? String(q.folder) : undefined;
  const cursor = q && q.cursor != null && q.cursor !== '' ? String(q.cursor) : undefined;
  if ((folder && folder.length > 512) || (cursor && cursor.length > 2000)) throw fail('invalid', { field: folder && folder.length > 512 ? 'folder' : 'cursor' });
  let r;
  try { r = await ctx.gc.cloud.list({ user: ctx.viewer, connection: c.id, folderId: folder, cursor }); } catch (e) { throw cloudFail(e); }
  return { items: (Array.isArray(r && r.items) ? r.items : []).map(itemView), next: r && r.next ? String(r.next) : null, connection: c };
}

function itemsArg(list) {
  if (!Array.isArray(list) || !list.length || list.length > ITEMS_MAX) throw fail('invalid', { field: 'items' });
  return list.map((x) => {
    const id = x && (typeof x.id === 'string' || typeof x.id === 'number') ? String(x.id) : '';
    if (!id || id.length > 512 || typeof x.isDir !== 'boolean') throw fail('invalid', { field: 'items' });
    if (x.name != null && typeof x.name !== 'string') throw fail('invalid', { field: 'items' });
    if (x.isDir && !(typeof x.name === 'string' && x.name.trim())) throw fail('invalid', { field: 'items' });
    return { id, isDir: x.isDir, name: typeof x.name === 'string' ? x.name.slice(0, 1000) : null, size: Number.isSafeInteger(x.size) && x.size >= 0 ? x.size : null, modifiedAt: msOf(x.modifiedAt) };
  });
}

/** POST import/jobs */
async function create(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const items = itemsArg(b.items);
  const { node: target, area } = await nodes.folderFor(ctx, posInt(b.targetFolderId));
  const c = await connOf(ctx, b.connection);
  const active = await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM import_jobs WHERE user_id = ? AND state IN (${store.marks(ACTIVE.length)})`, [ctx.viewer, ...ACTIVE]);
  if (active.n >= ACTIVE_MAX) throw fail('job_limit');
  const id = await store.tx(ctx.gc, async () => {
    const r = await store.run(ctx.gc, `INSERT INTO import_jobs (user_id, connection, provider, account, target_id, area_id, state, total, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, [ctx.viewer, c.id, c.provider, c.account, target.id, area.id, items.filter((x) => !x.isDir).length, ctx.now, ctx.now]);
    const jid = Number(r.lastInsertRowid);
    for (const x of items) {
      await store.run(ctx.gc, `INSERT INTO import_items (job_id, cloud_id, is_dir, name, size, modified_at, parent_node, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'todo')`,
        [jid, x.id, x.isDir ? 1 : 0, x.name, x.size, x.modifiedAt, target.id]);
    }
    return jid;
  });
  return { job: await jobView(ctx.gc, await own(ctx, id)) };
}

async function list(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM import_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 50', [ctx.viewer]);
  const out = [];
  for (const j of rows) out.push(await jobView(ctx.gc, j));
  return { jobs: out };
}

/** POST import/jobs/<id>/resume { connection? } */
async function resume(ctx, id, body) {
  const j = await own(ctx, id);
  // a done one only to try its items again that the cloud drive did not deliver
  const retry = j.state === 'done' && !!(await store.one(ctx.gc, "SELECT 1 AS x FROM import_items WHERE job_id = ? AND state = 'failed' AND error = 'cloud_error' LIMIT 1", [j.id]));
  if (j.state !== 'paused' && j.state !== 'failed' && !retry) throw fail('invalid', { field: 'state' });
  let conn = j.connection;
  const want = body && body.connection != null ? body.connection : null;
  if (want != null) {
    const c = await connOf(ctx, want);
    if (c.provider !== j.provider) throw fail('invalid', { field: 'connection' });
    conn = c.id;
  }
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, "UPDATE import_items SET state = 'todo', attempts = 0, error = NULL WHERE job_id = ? AND state = 'failed' AND error = 'cloud_error'", [j.id]);
    await store.run(ctx.gc, "UPDATE import_jobs SET state = 'queued', connection = ?, error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?", [conn, ctx.now, j.id]);
  });
  await counts(ctx.gc, j.id, ctx.now);
  return { job: await jobView(ctx.gc, await own(ctx, j.id)) };
}

/** DELETE import/jobs/<id> */
async function remove(ctx, id) {
  const j = await own(ctx, id);
  if (ACTIVE.includes(j.state)) {
    await store.run(ctx.gc, "UPDATE import_jobs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", [ctx.now, ctx.now, j.id]);
    return { job: await jobView(ctx.gc, await own(ctx, j.id)) };
  }
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'DELETE FROM import_items WHERE job_id = ?', [j.id]);
    await store.run(ctx.gc, 'DELETE FROM import_jobs WHERE id = ?', [j.id]);
  });
  return { removed: true, id: j.id };
}

/** import/… (index.js route). The person's jobs stay readable and cancellable when the import is switched off later. */
async function route(ctx, m, seg, q, body) {
  const [, b, c, d] = seg;
  if (b === 'jobs' && seg.length === 2 && m === 'GET') return list(ctx);
  if (b === 'jobs' && seg.length === 3 && m === 'GET') return { job: await jobView(ctx.gc, await own(ctx, c)) };
  if (b === 'jobs' && seg.length === 3 && m === 'DELETE') return remove(ctx, c);
  const src = await sources(ctx.gc, ctx.settings);
  if (!src) throw fail('feature_off');
  if (b === 'sources' && seg.length === 2 && m === 'GET') {
    let conns;
    try { conns = await connections(ctx.gc, ctx.viewer); } catch (e) { throw cloudFail(e); }
    return { ...src, connections: conns };
  }
  if (b === 'connect' && seg.length === 2 && m === 'POST') return connect(ctx, body);
  if (b === 'connections' && seg.length === 3 && m === 'DELETE') return disconnect(ctx, c);
  if (b === 'browse' && seg.length === 2 && m === 'GET') return browse(ctx, q);
  if (b === 'jobs' && seg.length === 2 && m === 'POST') return create(ctx, body);
  if (b === 'jobs' && seg.length === 4 && d === 'resume' && m === 'POST') return resume(ctx, c, body);
  throw fail('not_found');
}

// ─── the background run ─────────────────────────

/** The job's counts from its items (stored on the job for the lists). */
async function counts(gc, jobId, now) {
  const c = await store.one(gc, `SELECT SUM(CASE WHEN is_dir = 0 THEN 1 ELSE 0 END) AS total, SUM(CASE WHEN is_dir = 0 AND state = 'done' THEN 1 ELSE 0 END) AS done,
    SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN is_dir = 0 AND state = 'skipped' THEN 1 ELSE 0 END) AS skipped,
    SUM(CASE WHEN is_dir = 0 AND state = 'done' THEN COALESCE(size, 0) ELSE 0 END) AS bytes FROM import_items WHERE job_id = ?`, [jobId]);
  await store.run(gc, 'UPDATE import_jobs SET total = ?, done = ?, failed = ?, skipped = ?, bytes = ?, updated_at = ? WHERE id = ?',
    [c.total || 0, c.done || 0, c.failed || 0, c.skipped || 0, c.bytes || 0, now, jobId]);
}

async function setJob(gc, j, state, error, now) {
  const end = state === 'done' || state === 'failed' || state === 'cancelled';
  await store.run(gc, 'UPDATE import_jobs SET state = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?', [state, error || null, now, end ? now : null, j.id]);
  j.state = state;
}

const itemDone = (gc, it, state, o = {}) => store.run(gc, 'UPDATE import_items SET state = ?, node_id = COALESCE(?, node_id), size = COALESCE(?, size), name = COALESCE(?, name), error = ? WHERE id = ?',
  [state, o.node == null ? null : o.node, o.size == null ? null : o.size, o.name || null, o.error || null, it.id]);

/** A file into its folder: a name that exists becomes a new version (a folder of that name: a free name). → node */
async function commitAs(ctx, b) {
  try {
    return (await files.commit(ctx, { ...b, onConflict: 'version' })).node;
  } catch (e) {
    if (e && e.code === 'exists') return (await files.commit(ctx, { ...b, onConflict: 'rename' })).node;
    throw e;
  }
}

/** A folder item: made (or a folder of that name used) in its parent, then one page of its listing. */
async function stepFolder(ctx, j, it) {
  const gc = ctx.gc;
  let folderId = it.node_id;
  if (!folderId) {
    const name = cleanName(it.name, it.cloud_id);
    folderId = await store.tx(gc, async () => {
      const { node: parent, area } = await nodes.folderFor(ctx, it.parent_node);
      const have = await nodes.taken(gc, area.id, parent.id, name);
      if (have && have.is_dir === 1) return have.id;
      const free = have ? await nodes.freeName(gc, area.id, parent.id, name) : name;
      await nodes.unmarkUp(gc, parent.id, ctx);
      return (await nodes.insertFolder(ctx, area.id, parent.id, free)).id;
    });
    await store.run(gc, 'UPDATE import_items SET node_id = ? WHERE id = ?', [folderId, it.id]);
  }
  const page = await gc.cloud.list({ user: j.user_id, connection: j.connection, folderId: it.cloud_id, ...(it.cursor ? { cursor: it.cursor } : {}) });
  const kids = (Array.isArray(page && page.items) ? page.items : []).filter((x) => x && (typeof x.id === 'string' || typeof x.id === 'number'));
  const have = await store.one(gc, 'SELECT COUNT(*) AS n FROM import_items WHERE job_id = ?', [j.id]);
  if (have.n + kids.length > JOB_ITEMS_MAX) { await itemDone(gc, it, 'failed', { error: 'too_many' }); return; }
  await store.tx(gc, async () => {
    for (const x of kids) {
      await store.run(gc, `INSERT INTO import_items (job_id, cloud_id, is_dir, name, size, modified_at, parent_node, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'todo')`,
        [j.id, String(x.id), x.isDir === true ? 1 : 0, typeof x.name === 'string' ? x.name.slice(0, 1000) : null, Number.isSafeInteger(x.size) && x.size >= 0 ? x.size : null, msOf(x.modifiedAt), folderId]);
    }
    const next = page && page.next ? String(page.next) : null;
    await store.run(gc, 'UPDATE import_items SET cursor = ?, state = ? WHERE id = ?', [next, next ? 'todo' : 'done', it.id]);
  });
}

/** An empty file (Drive keeps it without media); an empty file of that name there already: skipped. */
async function emptyFile(ctx, it, base) {
  const name = cleanName(it.name, it.cloud_id);
  const parent = await nodes.row(ctx.gc, it.parent_node);
  const same = parent ? await nodes.taken(ctx.gc, parent.area_id, parent.id, name) : null;
  if (same && same.is_dir === 0 && same.size === 0 && !same.media_id) return itemDone(ctx.gc, it, 'skipped', { node: same.id, size: 0, name });
  const node = await commitAs(ctx, { ...base, name, size: 0 });
  return itemDone(ctx.gc, it, 'done', { node: node.id, size: 0, name });
}

/** A file item: imported by GateControl into Drive's media, then committed as the person. */
async function stepFile(ctx, j, it) {
  const gc = ctx.gc;
  const base = { parentId: it.parent_node, mtime: it.modified_at };
  if (it.size === 0) return emptyFile(ctx, it, base);
  let got;
  try {
    got = await gc.cloud.import({ user: j.user_id, connection: j.connection, fileId: it.cloud_id });
  } catch (e) {
    // an empty file: Drive has empty files without media
    if (e && e.code === 'ERR_MEDIA_EMPTY') return emptyFile(ctx, it, base);
    throw e;
  }
  try {
    const name = cleanName(got.name || it.name, it.cloud_id);
    const mtime = msOf(got.modifiedAt) != null ? msOf(got.modifiedAt) : it.modified_at;
    const parent = await nodes.row(gc, it.parent_node);
    const same = parent ? await nodes.taken(gc, parent.area_id, parent.id, name) : null;
    const info = same && same.is_dir === 0 && same.sha256 ? await gc.media.info(got.mediaId) : null;
    if (info && info.sha256 === same.sha256 && info.bytes === same.size) {
      // the same bytes are there already (an import run again): nothing new
      await gc.media.delete(got.mediaId);
      await itemDone(gc, it, 'skipped', { node: same.id, size: same.size, name });
      return;
    }
    const node = await commitAs(ctx, { ...base, mediaId: got.mediaId, name, mtime });
    await itemDone(gc, it, 'done', { node: node.id, size: node.size, name });
  } catch (e) {
    try { await gc.media.delete(got.mediaId); } catch { /* the host removes unclaimed files after 24 h */ }
    throw e;
  }
}

// an item's refusals that end it (the rest is tried again, ATTEMPTS times)
const ITEM_ERRORS = {
  ERR_CLOUD_NOT_FOUND: 'not_found', not_found: 'not_found', ERR_CLOUD_TOO_LARGE: 'too_large', ERR_MEDIA_TOO_LARGE: 'too_large',
  ERR_MEDIA_TYPE: 'unsupported', invalid: 'invalid', ERR_INVALID: 'invalid', upload_invalid: 'invalid', exists: 'exists', conflict: 'exists',
};
// a job's refusals that pause it (resume) or end it
const JOB_PAUSE = { ERR_CLOUD_AUTH: 'cloud_auth', ERR_CLOUD_DENIED: 'cloud_off', ERR_CLOUD_NOT_CONFIGURED: 'cloud_off', ERR_MEDIA_QUOTA: 'quota', quota: 'quota' };
const JOB_FAIL = { no_seat: 'no_seat', not_licensed: 'no_seat', forbidden: 'forbidden' };

/** One job's turn → { steps, stop } (stop: GateControl asked to wait — the whole run stops). */
async function runJob(gc, j, settings, now, asPerson, budget) {
  const ctx = await asPerson(j.user_id);
  if (!ctx) { await setJob(gc, j, 'failed', 'no_seat', now); return { steps: 0, stop: false }; }
  ctx.deviceId = `import:${j.provider}`;
  let conns;
  try { conns = await connections(gc, j.user_id); } catch (e) {
    if (e && JOB_PAUSE[e.code]) { await setJob(gc, j, 'paused', JOB_PAUSE[e.code], now); return { steps: 0, stop: false }; }
    return { steps: 0, stop: true };
  }
  if (!conns.some((c) => c.id === j.connection)) { await setJob(gc, j, 'paused', 'cloud_auth', now); return { steps: 0, stop: false }; }
  // the target: still there, still writable
  try { await nodes.folderFor(ctx, j.target_id); } catch (e) {
    await setJob(gc, j, 'failed', (e && (JOB_FAIL[e.code] || (e.code === 'not_found' ? 'not_found' : null))) || 'forbidden', now);
    return { steps: 0, stop: false };
  }
  if (j.state === 'queued') await setJob(gc, j, 'running', null, now);
  let steps = 0;
  let stop = false;
  for (;;) {
    if (budget.steps + steps >= STEPS_MAX || Date.now() - budget.started > TICK_MS) break;
    const it = await store.one(gc, "SELECT * FROM import_items WHERE job_id = ? AND state = 'todo' ORDER BY id LIMIT 1", [j.id]);
    if (!it) { await counts(gc, j.id, now); await setJob(gc, j, 'done', null, now); break; }
    steps++;
    try {
      if (it.is_dir === 1) await stepFolder(ctx, j, it);
      else await stepFile(ctx, j, it);
    } catch (e) {
      const code = e && e.code;
      if (code === 'ERR_RATE_LIMIT') { stop = true; break; }
      if (JOB_PAUSE[code]) { await setJob(gc, j, 'paused', JOB_PAUSE[code], now); break; }
      if (JOB_FAIL[code]) { await setJob(gc, j, 'failed', JOB_FAIL[code], now); break; }
      if (ITEM_ERRORS[code]) { await itemDone(gc, it, 'failed', { error: ITEM_ERRORS[code] }); continue; }
      gc.log.warn('import item failed', code || 'error');
      if (it.attempts + 1 >= ATTEMPTS) await itemDone(gc, it, 'failed', { error: 'cloud_error' });
      else await store.run(gc, 'UPDATE import_items SET attempts = attempts + 1 WHERE id = ?', [it.id]);
      // try again with the next run
      break;
    }
  }
  if (j.state !== 'done') await counts(gc, j.id, now);
  if (ctx.touched && ctx.touched.size) {
    try { await changes.announce(gc, ctx.touched, settings); } catch (e) { gc.log.warn('announce failed', (e && e.code) || 'error'); }
  }
  const cur = await store.one(gc, 'SELECT * FROM import_jobs WHERE id = ?', [j.id]);
  if (cur && gc.events && typeof gc.events.emit === 'function') {
    try {
      await gc.events.emit({ users: [cur.user_id], type: 'import', data: { job: { id: cur.id, state: cur.state, total: cur.total, done: cur.done, failed: cur.failed, skipped: cur.skipped } } });
    } catch (e) { gc.log.warn('import event failed', (e && e.code) || 'error'); }
  }
  return { steps, stop };
}

/**
 * The background run: the jobs in turn (oldest first), at most STEPS_MAX items or TICK_MS a run; ended jobs go after
 * 30 days. `asPerson(uid)` → the person's context (index.js) or null.
 */
async function tick(gc, settings, now, asPerson) {
  const out = { items: 0, jobs: 0 };
  const old = await store.all(gc, "SELECT id FROM import_jobs WHERE state IN ('done', 'failed', 'cancelled') AND finished_at < ?", [now - KEEP_MS]);
  for (const o of old) {
    await store.run(gc, 'DELETE FROM import_items WHERE job_id = ?', [o.id]);
    await store.run(gc, 'DELETE FROM import_jobs WHERE id = ?', [o.id]);
  }
  if (!hasCloud(gc) || typeof asPerson !== 'function') return out;
  const jobs = await store.all(gc, "SELECT * FROM import_jobs WHERE state IN ('queued', 'running') ORDER BY id LIMIT 20");
  if (!jobs.length) return out;
  const src = await sources(gc, settings);
  const budget = { started: Date.now(), steps: 0 };
  for (const j of jobs) {
    if (!src) { await setJob(gc, j, 'paused', 'cloud_off', now); continue; }
    if (budget.steps >= STEPS_MAX || Date.now() - budget.started > TICK_MS) break;
    const r = await runJob(gc, j, settings, now, asPerson, budget);
    budget.steps += r.steps;
    out.items += r.steps;
    out.jobs++;
    if (r.stop) break;
  }
  return out;
}

module.exports = { sources, route, tick, cleanName, RETURN_TO };
