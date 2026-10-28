'use strict';

// AI for documents (since 1.8.0, feature `docAi`): GateControl's AI service (≥ 1.214.0, gc.ai, permissions.ai — the provider, its
// keys and the monthly budget are the administrator's, in GateControl › Einstellungen › KI-Anbieter) reads a document
// and suggests its kind, title, date, sender and amount, a folder of its area and a file name, and the deadlines in it
// (deadlines.js). Nothing happens on its own: the suggestion is shown and taken with one click (apply → rename / move).
//
//   GET  nodes/<id>/insight            → { status, kind, title, date, sender, amount, currency, suggestion, deadlines,
//                                          error, at } — status none | pending | ready | failed | off
//   POST nodes/<id>/insight            recognise again (write in the area) → the same
//   POST nodes/<id>/insight/apply      { name?: true, folder?: true } → { node, insight }
//   PATCH areas/<id>                   { docAi: boolean } (write in the area) → { area: { id, docAi } }
//
// Sparing with data and money:
//   * the recognised text first (uploads/commit { text } — textSearch, the apps' scans): the text goes, never the file;
//   * a picture without text only when GateControl allows pictures to AI ("Bilder an KI senden") — automatically only
//     with the setting doc_ai_images (default off), else when someone asks (POST …/insight);
//   * at most one recognition per version of a file (rev); a failed one is not tried again without a reason (a new
//     version, POST …/insight); the queue (status pending) is worked off by the background run, PER_TICK at a time.
// Per area on or off (area_prefs; default off for a child's folder, on otherwise); doc_ai off (an administrator) or a
// GateControl without gc.ai, or one that does not allow it: no `docAi` in GET me features, status 'off'.
// Every file node of an answer carries the short form `insight: { status, kind }` while the feature is on; a finished
// recognition sends the readers of the area the live event 'changed'.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const people = require('./people');
const changes = require('./changes');
const deadlines = require('./deadlines');
const { nodesOf } = require('./previews');
const { fail, posInt, iso, day, nodeName } = require('./util');

const KINDS = ['invoice', 'contract', 'notice', 'medical', 'certificate', 'statement', 'insurance', 'warranty', 'other'];
const TEXT_MAX = 20000;
const FOLDERS_MAX = 300;
const PER_TICK = 3;
const TICK_MS = 70000;
const TIMEOUT_MS = 45000;
const IMAGE_RE = /^image\/(?:jpeg|png|webp|gif)$/;
const IMAGE_MAX = 10 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// what a failed recognition says (error)
const AI_ERRORS = {
  ERR_AI_BUDGET: 'ai_budget', ERR_AI_MEDIA_DISABLED: 'media_disabled', ERR_AI_CAPABILITY: 'ai_capability',
  ERR_AI_INVALID_OUTPUT: 'ai_invalid', ERR_TIMEOUT: 'ai_timeout', ERR_AI_PROVIDER: 'ai_provider',
};

const INSTRUCTIONS = [
  'You read one document of the file storage of a family or a small team and suggest how to file it.',
  'Answer only from the document; never invent anything. Strings in the language of the document.',
  'kind: invoice, contract, notice (an official notice or decision), medical (a doctor\'s letter or finding),',
  'certificate (school or work certificate), statement (bank or account statement), insurance, warranty or other.',
  'title: a short title. date: the date of the document (YYYY-MM-DD) or null. sender: who sent it, or null.',
  'amount and currency (ISO 4217): the amount to pay or the total, else null.',
  'folder: the number of the best fitting folder of the list "Folders", or null when none fits.',
  'name: a file name without extension like "2026-03-14 Stadtwerke Rechnung", or null.',
  'deadlines: payment, cancellation or objection deadlines with their date (YYYY-MM-DD) — work out dates like',
  '"within 14 days" from the date of the document, else from "Today"; an empty list when the document names none.',
].join('\n');

const SCHEMA = {
  type: 'object',
  required: ['kind', 'title', 'date', 'sender', 'amount', 'currency', 'folder', 'name', 'deadlines'],
  properties: {
    kind: { type: 'string', enum: KINDS },
    title: { type: 'string', maxLength: 120, nullable: true },
    date: { type: 'string', maxLength: 10, nullable: true },
    sender: { type: 'string', maxLength: 120, nullable: true },
    amount: { type: 'number', nullable: true },
    currency: { type: 'string', maxLength: 3, nullable: true },
    folder: { type: 'integer', minimum: 0, maximum: FOLDERS_MAX, nullable: true },
    name: { type: 'string', maxLength: 120, nullable: true },
    deadlines: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', required: ['kind', 'date', 'label'],
        properties: { kind: { type: 'string', enum: deadlines.KINDS }, date: { type: 'string', maxLength: 10 }, label: { type: 'string', maxLength: 120, nullable: true } },
      },
    },
  },
};

const hasAi = (gc) => !!(gc.ai && typeof gc.ai.extract === 'function' && typeof gc.ai.available === 'function');

/**
 * Is AI for documents usable now → { on, media }: the setting doc_ai, a GateControl with gc.ai (≥ 1.214.0) that allows
 * this plugin (gc.ai.available()); media: pictures may go to the AI (gc.ai.available({ capability: 'vision' }) — a
 * provider that reads them and "Bilder an KI senden" on). Pictures are JPEG, PNG, WebP or GIF only (what gc.ai takes); a
 * HEIC or PDF scan goes as its recognised text or not at all.
 */
async function state(gc, settings) {
  if (!settings.docAi || !hasAi(gc)) return { on: false, media: false };
  // once per request or background run (its settings object)
  if (!memo.has(settings)) memo.set(settings, ask(gc));
  return memo.get(settings);
}
const memo = new WeakMap();

async function ask(gc) {
  let on = false;
  try { on = (await gc.ai.available()) === true; } catch { on = false; }
  // 'vision' is available only while GateControl's "Bilder an KI senden" is on
  let media = false;
  if (on) { try { media = (await gc.ai.available({ capability: 'vision' })) === true; } catch { media = false; } }
  return { on, media };
}

// ─── per area ───────────────────────────────────

/** On by default — except a child's folder. */
const byDefault = (a) => a.kind !== 'child';

/** Areas `list` (rows with id, kind) → Map id → on. */
async function prefsOf(gc, list) {
  const out = new Map(list.map((a) => [a.id, byDefault(a)]));
  for (const part of store.chunks([...out.keys()])) {
    for (const r of await store.all(gc, `SELECT area_id, doc_ai FROM area_prefs WHERE area_id IN (${store.marks(part.length)})`, part)) {
      if (r.doc_ai != null) out.set(r.area_id, r.doc_ai === 1);
    }
  }
  return out;
}

async function areaOn(gc, a) {
  return (await prefsOf(gc, [a])).get(a.id);
}

/** The area views of GET me / GET areas get `docAi` while the feature is on (in place). */
async function decorate(ctx, list) {
  if (!list.length || !(await state(ctx.gc, ctx.settings)).on) return list;
  const on = await prefsOf(ctx.gc, list);
  for (const a of list) a.docAi = on.get(a.id) === true;
  return list;
}

/** PATCH areas/<id> { docAi } → { area: { id, docAi } } */
async function setArea(ctx, areaId, body) {
  if (!(await state(ctx.gc, ctx.settings)).on) throw fail('feature_off');
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.docAi !== 'boolean') throw fail('invalid', { field: 'docAi' });
  const v = await areas.roleIn(ctx, String(areaId || ''), 'write');
  if (v.area.archived_at != null) throw fail('forbidden');
  await store.run(ctx.gc, 'INSERT INTO area_prefs (area_id, doc_ai) VALUES (?, ?) ON CONFLICT(area_id) DO UPDATE SET doc_ai = excluded.doc_ai', [v.area.id, b.docAi ? 1 : 0]);
  // switched off: what waits in the queue there goes
  if (!b.docAi) await store.run(ctx.gc, "DELETE FROM doc_insights WHERE status = 'pending' AND node_id IN (SELECT id FROM nodes WHERE area_id = ?)", [v.area.id]);
  return { area: { id: v.area.id, docAi: b.docAi } };
}

// ─── the queue ──────────────────────────────────

async function hasText(gc, id) {
  return !!(await store.one(gc, 'SELECT 1 AS x FROM doc_text WHERE node_id = ?', [id]));
}

const isImage = (n) => !!(n.media_id && IMAGE_RE.test(String(n.mime || '')) && n.size <= IMAGE_MAX);

/** What the AI may read of file `n`: 'text', 'media' (a picture — `asked`: someone asked for it), or null. */
async function sourceOf(gc, n, st, settings, asked) {
  // a vault's file (since 1.9.0): the server holds only ciphertext — never to the AI
  if (!n || n.is_dir === 1 || n.deleted_at != null || n.vault_id) return null;
  if (await hasText(gc, n.id)) return 'text';
  if (isImage(n) && st.media && (asked || settings.docAiImages)) return 'media';
  return null;
}

async function queue(gc, n, source, by, now) {
  await store.run(gc, `INSERT INTO doc_insights (node_id, rev, status, source, queued_at, queued_by) VALUES (?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET rev = excluded.rev, status = 'pending', source = excluded.source, kind = NULL, title = NULL, doc_date = NULL,
    sender = NULL, amount = NULL, currency = NULL, folder_id = NULL, name = NULL, error = NULL, queued_at = excluded.queued_at,
    queued_by = excluded.queued_by, done_at = NULL, cost_cents = NULL`, [n.id, n.rev, source, now, by || null]);
}

/**
 * After a request (index.js after): the files it made or gave a new version (ctx.insightIds, files.js commit) go into
 * the queue when the AI may read them — once per version.
 */
async function consider(gc, ctx) {
  const ids = [...(ctx.insightIds || [])];
  if (!ids.length) return 0;
  const st = await state(gc, ctx.settings);
  if (!st.on) return 0;
  let queued = 0;
  for (const id of ids) {
    const n = await nodes.row(gc, id);
    if (!n || n.is_dir === 1 || n.deleted_at != null) continue;
    const a = await areas.row(gc, n.area_id);
    if (!a || !(await areaOn(gc, a))) continue;
    const have = await store.one(gc, 'SELECT * FROM doc_insights WHERE node_id = ?', [n.id]);
    if (have && have.rev === n.rev) continue;
    const src = await sourceOf(gc, n, st, ctx.settings, false);
    if (!src) {
      // a new version the AI cannot read: the old suggestion belonged to other bytes (its deadlines stay)
      if (have) await store.run(gc, 'DELETE FROM doc_insights WHERE node_id = ?', [n.id]);
      continue;
    }
    await queue(gc, n, src, ctx.viewer, ctx.now);
    queued++;
  }
  return queued;
}

/** The folders of area `areaId` → [{ id, path }] ('' the top), by path, at most FOLDERS_MAX. */
async function foldersOf(gc, areaId) {
  const rows = await store.all(gc, 'SELECT id, parent_id, name FROM nodes WHERE area_id = ? AND is_dir = 1 AND deleted_at IS NULL LIMIT 5000', [areaId]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (r) => {
    const parts = [];
    for (let cur = r, i = 0; cur && cur.parent_id != null && i < 64; cur = byId.get(cur.parent_id), i++) parts.unshift(cur.name);
    return parts.join('/');
  };
  return rows.map((r) => ({ id: r.id, path: pathOf(r) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, FOLDERS_MAX);
}

/** One line of text, at most `max` characters, else null. */
function clean(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** A real day YYYY-MM-DD, else null. */
function dayArg(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 && name.length - i <= 16 ? name.slice(i) : ''; };

/** The suggested file name with the file's own extension, or null when it is no usable name. */
function suggestName(v, current) {
  let s = clean(v, 120);
  if (!s) return null;
  const ext = extOf(current);
  if (ext && s.toLowerCase().endsWith(ext.toLowerCase())) s = s.slice(0, -ext.length);
  s = s.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
  if (!s) return null;
  try { return nodeName(s + ext); } catch { return null; }
}

/** The person the AI request is for (GateControl's log): who asked or uploaded — an account of this server, else none. */
async function userOf(gc, r, n) {
  const us = await people.users(gc);
  for (const id of [r.queued_by, n.updated_by, n.created_by]) if (id != null && us.has(id)) return id;
  return null;
}

/**
 * Recognise queued row `r` → 'ready' | 'failed' | 'gone' | 'stop' (GateControl refused before asking a provider: it
 * stays in the queue, the run stops).
 */
async function recognise(gc, r, st, settings, now) {
  const n = await nodes.row(gc, r.node_id);
  const a = n ? await areas.row(gc, n.area_id) : null;
  if (!n || n.deleted_at != null || n.is_dir === 1 || !a || !(await areaOn(gc, a))) {
    await store.run(gc, 'DELETE FROM doc_insights WHERE node_id = ?', [r.node_id]);
    return 'gone';
  }
  const failed = async (error) => {
    await store.run(gc, "UPDATE doc_insights SET status = 'failed', rev = ?, error = ?, done_at = ? WHERE node_id = ?", [n.rev, error, now, n.id]);
    return 'failed';
  };
  const textRow = await store.one(gc, 'SELECT text FROM doc_text WHERE node_id = ?', [n.id]);
  let source = textRow ? 'text' : r.source;
  if (source === 'text' && !textRow) source = isImage(n) ? 'media' : null;
  if (!source || (source === 'media' && !isImage(n))) return failed('no_text');
  if (source === 'media' && !st.media) return failed('media_disabled');
  const folders = await foldersOf(gc, n.area_id);
  const input = [
    { type: 'text', label: 'File name', text: n.name },
    { type: 'text', label: 'Today', text: day(now) },
    { type: 'text', label: 'Folders', text: folders.map((f, i) => `${i}: ${f.path || '/'}`).join('\n') },
    source === 'text' ? { type: 'text', label: 'Document text', text: textRow.text.slice(0, TEXT_MAX) } : { type: 'media', mediaId: n.media_id },
  ];
  let res;
  try {
    res = await gc.ai.extract({
      task: 'drive_document', user: await userOf(gc, r, n), instructions: INSTRUCTIONS, input, schema: SCHEMA,
      maxOutputTokens: 800, timeoutMs: TIMEOUT_MS,
    });
  } catch (e) {
    const code = e && e.code;
    if (code === 'ERR_RATE_LIMIT' || code === 'ERR_AI_NOT_CONFIGURED' || code === 'ERR_AI_DENIED') return 'stop';
    gc.log.warn('document recognition failed', code || 'error');
    return failed(AI_ERRORS[code] || 'ai_provider');
  }
  const d = (res && res.data && typeof res.data === 'object') ? res.data : {};
  const amount = typeof d.amount === 'number' && Number.isFinite(d.amount) && Math.abs(d.amount) < 1e12 ? Math.round(d.amount * 100) / 100 : null;
  const cur = typeof d.currency === 'string' && /^[A-Za-z]{3}$/.test(d.currency.trim()) ? d.currency.trim().toUpperCase() : null;
  const folder = Number.isInteger(d.folder) && folders[d.folder] ? folders[d.folder].id : null;
  const found = [];
  for (const x of Array.isArray(d.deadlines) ? d.deadlines : []) {
    const k = x && deadlines.KINDS.includes(x.kind) ? x.kind : null;
    const dd = x ? dayArg(x.date) : null;
    if (k && dd && !found.some((y) => y.kind === k && y.date === dd)) found.push({ kind: k, date: dd, label: clean(x.label, 120) });
  }
  const cost = res && res.usage && Number.isFinite(res.usage.costCents) ? res.usage.costCents : null;
  await store.tx(gc, async () => {
    await store.run(gc, `UPDATE doc_insights SET status = 'ready', rev = ?, source = ?, kind = ?, title = ?, doc_date = ?, sender = ?, amount = ?, currency = ?,
      folder_id = ?, name = ?, error = NULL, done_at = ?, cost_cents = ? WHERE node_id = ?`,
    [n.rev, source, KINDS.includes(d.kind) ? d.kind : 'other', clean(d.title, 120), dayArg(d.date), clean(d.sender, 120), amount, amount == null ? null : cur,
      folder, suggestName(d.name, n.name), now, cost, n.id]);
    await deadlines.replace(gc, n.id, found.slice(0, 5));
  });
  return 'ready';
}

/** The background run: up to PER_TICK queued recognitions (oldest first). */
async function tick(gc, settings, now) {
  const out = { recognised: 0, failed: 0, waiting: 0 };
  // rows of files that are gone for good (a team folder removed)
  await store.run(gc, 'DELETE FROM doc_insights WHERE node_id NOT IN (SELECT id FROM nodes)');
  const st = await state(gc, settings);
  if (!st.on) return out;
  const started = Date.now();
  // nothing of a vault (1.9.0) — such rows cannot come from consider(), this is the second lock
  await store.run(gc, 'DELETE FROM doc_insights WHERE node_id IN (SELECT id FROM nodes WHERE vault_id IS NOT NULL)');
  const rows = await store.all(gc, "SELECT * FROM doc_insights WHERE status = 'pending' ORDER BY queued_at, node_id LIMIT ?", [PER_TICK]);
  const touched = new Set();
  for (const r of rows) {
    if (Date.now() - started > TICK_MS) break;
    const res = await recognise(gc, r, st, settings, now);
    if (res === 'stop') { out.waiting++; break; }
    if (res === 'ready') out.recognised++;
    if (res === 'failed') out.failed++;
    if (res === 'ready' || res === 'failed') {
      const n = await nodes.row(gc, r.node_id);
      if (n) touched.add(n.area_id);
    }
  }
  // the readers fetch the new insight (node.insight) — the live event 'changed'
  if (touched.size) await changes.announce(gc, touched, settings);
  return out;
}

// ─── reading, asking again, taking it ───────────

function idArg(v) {
  const n = posInt(v);
  if (!n) throw fail('not_found');
  return n;
}

const EMPTY = { kind: null, title: null, date: null, sender: null, amount: null, currency: null, suggestion: null, error: null, at: null };

/** The answer of GET nodes/<id>/insight for node `n` of area `a`. */
async function view(ctx, n, a, st) {
  // a vault's file (since 1.9.0): always off, no deadlines
  if (n.vault_id) return { status: 'off', ...EMPTY, deadlines: [] };
  const dl = await deadlines.ofNode(ctx, n.id);
  if (!st.on || !(await areaOn(ctx.gc, a))) return { status: 'off', ...EMPTY, deadlines: dl };
  const r = await store.one(ctx.gc, 'SELECT * FROM doc_insights WHERE node_id = ?', [n.id]);
  if (!r || r.rev !== n.rev) return { status: 'none', ...EMPTY, deadlines: dl };
  if (r.status !== 'ready') return { status: r.status, ...EMPTY, error: r.error || null, at: iso(r.status === 'pending' ? r.queued_at : r.done_at), deadlines: dl };
  let folderId = null;
  let folderPath = null;
  if (r.folder_id != null && r.folder_id !== n.parent_id) {
    const f = await nodes.row(ctx.gc, r.folder_id);
    if (f && f.is_dir === 1 && f.deleted_at == null && f.area_id === n.area_id) { folderId = f.id; folderPath = await nodes.pathOf(ctx.gc, f); }
  }
  const name = r.name && r.name.toLowerCase() !== n.name.toLowerCase() ? r.name : null;
  return {
    status: 'ready', kind: r.kind, title: r.title || null, date: r.doc_date || null, sender: r.sender || null, amount: r.amount == null ? null : r.amount,
    currency: r.currency || null, suggestion: folderId != null || name ? { folderId, folderPath, name } : null, error: null, at: iso(r.done_at), deadlines: dl,
  };
}

/** GET nodes/<id>/insight */
async function get(ctx, id) {
  const { node, area } = await nodes.reach(ctx, idArg(id));
  if (node.is_dir === 1) throw fail('invalid');
  return view(ctx, node, area, await state(ctx.gc, ctx.settings));
}

/** POST nodes/<id>/insight — recognise (again): someone asked, so a picture may go too (when GateControl allows it). */
async function restart(ctx, id) {
  const { node, area } = await nodes.reach(ctx, idArg(id), 'write');
  // a vault's file (since 1.9.0): the server cannot read it — 409 encrypted
  if (node.vault_id) throw fail('encrypted');
  const st = await state(ctx.gc, ctx.settings);
  if (!st.on) throw fail('feature_off');
  if (node.is_dir === 1) throw fail('invalid');
  if (!(await areaOn(ctx.gc, area))) throw fail('feature_off', { field: 'area' });
  const src = await sourceOf(ctx.gc, node, st, ctx.settings, true);
  if (!src) throw fail('unsupported', { reason: isImage(node) ? 'media_disabled' : 'no_text' });
  const have = await store.one(ctx.gc, 'SELECT status, rev FROM doc_insights WHERE node_id = ?', [node.id]);
  if (!(have && have.status === 'pending' && have.rev === node.rev)) await queue(ctx.gc, node, src, ctx.viewer, ctx.now);
  return view(ctx, node, area, st);
}

/** POST nodes/<id>/insight/apply { name?: true, folder?: true } — the suggestion taken: renamed and / or moved. */
async function apply(ctx, id, body) {
  const st = await state(ctx.gc, ctx.settings);
  if (!st.on) throw fail('feature_off');
  const b = body && typeof body === 'object' ? body : {};
  const wantName = b.name === true;
  const wantFolder = b.folder === true;
  if (!wantName && !wantFolder) throw fail('invalid', { field: 'name' });
  const { node, area } = await nodes.reach(ctx, idArg(id), 'write');
  if (node.vault_id) throw fail('encrypted');
  if (node.is_dir === 1) throw fail('invalid');
  if (!(await areaOn(ctx.gc, area))) throw fail('feature_off', { field: 'area' });
  const r = await store.one(ctx.gc, 'SELECT * FROM doc_insights WHERE node_id = ?', [node.id]);
  if (!r || r.status !== 'ready' || r.rev !== node.rev) throw fail('invalid', { field: 'insight' });
  if (wantName && !r.name) throw fail('invalid', { field: 'name' });
  let parentId = node.parent_id;
  if (wantFolder) {
    if (r.folder_id == null) throw fail('invalid', { field: 'folder' });
    const f = await nodes.row(ctx.gc, r.folder_id);
    if (!f || f.is_dir !== 1 || f.deleted_at != null || f.area_id !== node.area_id) throw fail('not_found', { field: 'folder' });
    parentId = f.id;
  }
  // a name taken in the folder: a free one ("… (2).pdf")
  const name = await nodes.freeName(ctx.gc, node.area_id, parentId, wantName ? r.name : node.name, node.id);
  const out = await nodes.update(ctx, node.id, { name, ...(parentId !== node.parent_id ? { parentId } : {}) });
  // what was taken is no longer suggested
  await store.run(ctx.gc, 'UPDATE doc_insights SET name = CASE WHEN ? THEN NULL ELSE name END, folder_id = CASE WHEN ? THEN NULL ELSE folder_id END WHERE node_id = ?',
    [wantName ? 1 : 0, wantFolder ? 1 : 0, node.id]);
  const now = await nodes.row(ctx.gc, node.id);
  return { node: out, insight: await view(ctx, now, area, st) };
}

// ─── the short form on every file node ──────────

/** Every file node of an answer gets `insight: { status, kind }` while the feature is on (in place). */
async function attach(ctx, body) {
  const list = nodesOf(body).filter((n) => !n.deleted && !Object.prototype.hasOwnProperty.call(n, 'insight'));
  if (!list.length) return body;
  if (!(await state(ctx.gc, ctx.settings)).on) return body;
  const rows = new Map();
  for (const part of store.chunks([...new Set(list.map((n) => n.id))])) {
    for (const r of await store.all(ctx.gc, `SELECT node_id, rev, status, kind FROM doc_insights WHERE node_id IN (${store.marks(part.length)})`, part)) rows.set(r.node_id, r);
  }
  const areaIds = [...new Set(list.map((n) => n.areaId))];
  const areaRows = [];
  for (const part of store.chunks(areaIds)) areaRows.push(...await store.all(ctx.gc, `SELECT id, kind FROM areas WHERE id IN (${store.marks(part.length)})`, part));
  const on = await prefsOf(ctx.gc, areaRows);
  for (const n of list) {
    const r = rows.get(n.id);
    if (on.get(n.areaId) !== true || n.encrypted) n.insight = { status: 'off', kind: null };
    else if (!r || r.rev !== n.rev) n.insight = { status: 'none', kind: null };
    else n.insight = { status: r.status, kind: r.status === 'ready' ? r.kind : null };
  }
  return body;
}

module.exports = { KINDS, SCHEMA, state, decorate, setArea, consider, tick, get, restart, apply, attach, suggestName, prefsOf };
