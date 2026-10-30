'use strict';

// Services for GateControl Mail (since 1.15.0; plugin.json services.provides — the caller lists
// "gatecontrol-drive:<service>" in its permissions.services and calls with userId, the person of the call):
//
//   suggest_folder { mediaId, name, from?: { name, address }, subject?, date? }
//     → { ok, suggestion: { folderId, areaId, path, where, name, confidence, reason } | null, kind?, title?, sha256Exists }
//     mediaId    a file the caller handed over to Drive first (gc.media.handOver(id, { toPlugin: 'gatecontrol-drive',
//                user }) — unclaimed, owned by that person); it stays unclaimed (save_file may take it within 24 h)
//     Where it would go, in this order: the person's rule for the sender ('rule': "Immer für diesen Absender"), the
//     folder the person saved the sender's files to last ('learned'), AI for documents ('ai' — GateControl's gc.ai,
//     the feature docAi, its areas only; the file itself only when it is a picture and pictures may go to the AI,
//     else name, sender, subject and date), the kind of document by its name and subject ('kind' — a folder named
//     for it, "Rechnungen", "Verträge", …). Only folders the person may write to, never a vault.
//     sha256Exists: the same bytes lie in an area the person reads already.
//   save_file (services.js) takes since 1.15.0 also
//     source { plugin (the caller), label ('Aus Mail von Stadtwerke, 03.11.', ≤ 120), ref ('<message id>', ≤ 200) }
//                the file shows where it came from (node.source with appLink gatecontrol://plugin/<plugin>/message/<ref>)
//     learn  { from: address, always?: true }   the sender's files go to that folder next time (suggest_folder)
//   give_file { nodeId } → { ok, mediaId, name, mime, size }   a file the person reads, handed over to the caller
//                (gc.media.handOver — Drive lists one of the caller's services for that); a folder, an empty file:
//                invalid; a vault: encrypted; over 50 MB: too_large
//   browse     { area?, folderId?, dirs? } → { ok, folder: { id, name, path, where, areaId, writable }, items: [{ id, name, isDir,
//                size, mime }], next }   the contents of a folder the person reads (default: the top of 'mine'; an area id
//                or 'family'), for the pickers of Mail's portal ("Aus Drive", "Anderer Ordner"); never the inside of a vault —
//                a vault folder is left out; dirs: only folders; at most 200
//   share_link { nodeId, expiresDays (1…90, default 14), password? } → { ok, url, expiresAt }   a download link
//                (GateControl's public links — off until an administrator allows them: links_disabled); only who may
//                write in the area, never a vault. GateControl keeps a link at most 30 days: longer asks end then.
//                password: the link's PIN (4 to 8 digits, GateControl's rule) — anything else: invalid.
// Codes: invalid, forbidden, not_found, no_seat, not_licensed, encrypted, too_large, links_disabled, no_public_url,
// quota, upload_invalid, unavailable.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const links = require('./links');
const insights = require('./insights');
const { fail, posInt, line, nodeName, MEDIA_RE, iso } = require('./util');

const GIVE_MAX = 50 * 1024 * 1024;
const DAY = 86400000;
const LINK_DAYS_MAX = 30; // GateControl's public links end at most 30 days ahead
const ADDRESS_RE = /^[^\s@<>()"',;:]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const REF_RE = /^[A-Za-z0-9._:@+=-]{1,200}$/;
const PIN_RE = /^\d{4,8}$/;
const FOLDERS_MAX = 300;
const TIMEOUT_MS = 30000;

/** A sender's address in lower case, or null. */
function addressOf(v) {
  const a = typeof v === 'string' ? v.trim().toLowerCase() : (v && typeof v.address === 'string' ? v.address.trim().toLowerCase() : '');
  return ADDRESS_RE.test(a) && a.length <= 254 ? a : null;
}

/** A short line (no control characters) of at most `max`, or null. */
function short(v, max) {
  if (typeof v !== 'string') return null;
  const s = line(v);
  return s ? s.slice(0, max) : null;
}

/** The person's own handed-over file: unclaimed, theirs, not in an area yet → its info, else upload_invalid. */
async function handed(ctx, mediaId) {
  if (typeof mediaId !== 'string' || !MEDIA_RE.test(mediaId)) throw fail('invalid', { field: 'mediaId' });
  const info = await ctx.gc.media.info(mediaId);
  if (!info || info.claimed || info.owner !== ctx.viewer || info.area) throw fail('upload_invalid');
  return info;
}

/** The areas the person may write into (not archived) → Map id → visible entry. */
async function writable(ctx) {
  const out = new Map();
  for (const v of await ctx.visible()) if (areas.can(v.role, 'write') && v.area.archived_at == null) out.set(v.area.id, v);
  return out;
}

/** A live folder of a writable area outside a vault → { node, area, path } or null. */
async function usableFolder(ctx, w, id) {
  const n = posInt(id) ? await nodes.row(ctx.gc, posInt(id)) : null;
  if (!n || n.is_dir !== 1 || n.deleted_at != null || n.vault_id || !w.has(n.area_id)) return null;
  return { node: n, area: w.get(n.area_id).area, path: await nodes.pathOf(ctx.gc, n) };
}

function suggestionOf(ctx, f, name, confidence, reason) {
  return {
    folderId: f.node.id, areaId: f.area.id, path: f.path, where: [ctx.areaLabel(f.area), ...(f.path ? f.path.split('/') : [])].join(' › '),
    name, confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)), reason,
  };
}

// ─── the learned filing ─────────────────────────

/** save_file { learn }: the sender's files go to folder `folderId` (in a row: hits + 1). */
async function learn(ctx, learnArg, folderId) {
  if (learnArg == null) return;
  const sender = addressOf(learnArg && learnArg.from);
  if (!sender) throw fail('invalid', { field: 'learn' });
  const always = learnArg.always === true;
  const have = await store.one(ctx.gc, 'SELECT * FROM filing_rules WHERE user_id = ? AND sender = ?', [ctx.viewer, sender]);
  if (!have) {
    await store.run(ctx.gc, 'INSERT INTO filing_rules (user_id, sender, folder_id, hits, always, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      [ctx.viewer, sender, folderId, always ? 1 : 0, ctx.now]);
    return;
  }
  const same = have.folder_id === folderId;
  // a rule stays a rule while files go where it says; another folder without `always` ends it (the person chose otherwise)
  await store.run(ctx.gc, 'UPDATE filing_rules SET folder_id = ?, hits = ?, always = ?, updated_at = ? WHERE user_id = ? AND sender = ?',
    [folderId, same ? have.hits + 1 : 1, always || (same && have.always === 1) ? 1 : 0, ctx.now, ctx.viewer, sender]);
}

/** The person's rule or learned folder for `sender` → suggestion or null. */
async function learned(ctx, w, sender, name) {
  if (!sender) return null;
  const r = await store.one(ctx.gc, 'SELECT * FROM filing_rules WHERE user_id = ? AND sender = ?', [ctx.viewer, sender]);
  if (!r) return null;
  const f = await usableFolder(ctx, w, r.folder_id);
  if (!f) return null;
  if (r.always === 1) return suggestionOf(ctx, f, name, 1, 'rule');
  return suggestionOf(ctx, f, name, Math.min(0.95, 0.6 + 0.15 * r.hits), 'learned');
}

// ─── by the kind of document ────────────────────

// words in the name or subject → the kind, and the folder names that fit it (lower case, compared without umlaut marks)
const KIND_WORDS = [
  { kind: 'invoice', re: /rechnung|invoice|zahlungserinnerung|mahnung|beleg|quittung|receipt/i, folders: ['rechnungen', 'rechnung', 'belege', 'invoices', 'bills', 'finanzen', 'finances'] },
  { kind: 'contract', re: /vertrag|vertrage|contract|vereinbarung|agreement|kundigung/i, folders: ['vertrage', 'vertrag', 'contracts'] },
  { kind: 'statement', re: /kontoauszug|depotauszug|statement|abrechnung/i, folders: ['kontoauszuge', 'bank', 'finanzen', 'statements', 'finances'] },
  { kind: 'insurance', re: /versicherung|police|insurance|beitragsrechnung/i, folders: ['versicherungen', 'versicherung', 'insurance'] },
  { kind: 'notice', re: /bescheid|steuer|finanzamt|behorde|notice|tax/i, folders: ['steuern', 'steuer', 'behorden', 'amter', 'taxes', 'tax'] },
  { kind: 'medical', re: /arzt|befund|rezept|krankenkasse|medical|doctor|praxis/i, folders: ['gesundheit', 'arzt', 'medizin', 'health', 'medical'] },
  { kind: 'certificate', re: /zeugnis|zertifikat|urkunde|certificate|schule|school/i, folders: ['zeugnisse', 'schule', 'urkunden', 'certificates', 'school'] },
  { kind: 'warranty', re: /garantie|gewahrleistung|warranty|guarantee/i, folders: ['garantie', 'garantien', 'belege', 'warranty', 'warranties'] },
];
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function byKind(ctx, w, name, subject) {
  const text = plain(`${name} ${subject || ''}`);
  const k = KIND_WORDS.find((x) => x.re.test(text));
  if (!k) return { kind: null, suggestion: null };
  const ids = [...w.keys()];
  if (!ids.length) return { kind: k.kind, suggestion: null };
  // a folder named for the kind — the person's own files first, then the family, then the rest
  const order = (id) => { const a = w.get(id).area; return a.kind === 'mine' ? 0 : a.kind === 'family' ? 1 : 2; };
  let best = null;
  for (const part of store.chunks(ids)) {
    const rows = await store.all(ctx.gc, `SELECT id, area_id, name FROM nodes WHERE is_dir = 1 AND deleted_at IS NULL AND vault_id IS NULL AND parent_id IS NOT NULL
      AND area_id IN (${store.marks(part.length)}) LIMIT 20000`, part);
    for (const r of rows) {
      const rank = k.folders.indexOf(plain(r.name));
      if (rank < 0) continue;
      const score = order(r.area_id) * 100 + rank;
      if (!best || score < best.score) best = { score, id: r.id };
    }
  }
  const f = best ? await usableFolder(ctx, w, best.id) : null;
  return { kind: k.kind, suggestion: f ? suggestionOf(ctx, f, name, 0.5, 'kind') : null };
}

// ─── AI for documents ───────────────────────────

const INSTRUCTIONS = [
  'A person received a file as an e-mail attachment and wants to file it in their file storage (a family or a small team).',
  'Suggest the best fitting folder of the list "Folders" (its number), or null when none fits well.',
  'Use the file name, the sender, the subject, the date and, when given, the picture. Never invent anything.',
  'kind: invoice, contract, notice (an official notice), medical, certificate, statement (bank), insurance, warranty or other.',
  'title: a short title in the language of the document, or null. name: a file name without extension like',
  '"2026-03-14 Stadtwerke Rechnung", or null. confidence: 0 … 1, how sure the folder is right.',
].join('\n');

const SCHEMA = {
  type: 'object',
  required: ['kind', 'title', 'folder', 'name', 'confidence'],
  properties: {
    kind: { type: 'string', enum: insights.KINDS },
    title: { type: 'string', maxLength: 120, nullable: true },
    folder: { type: 'integer', minimum: 0, maximum: FOLDERS_MAX, nullable: true },
    name: { type: 'string', maxLength: 120, nullable: true },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

/** The folders of the writable areas with AI for documents on → [{ id, area, label }] (≤ FOLDERS_MAX). */
async function aiFolders(ctx, w) {
  const list = [...w.values()].map((v) => v.area);
  const on = await insights.prefsOf(ctx.gc, list);
  const out = [];
  for (const a of list) {
    if (on.get(a.id) !== true) continue;
    const rows = await store.all(ctx.gc, 'SELECT id, parent_id, name, vault_id FROM nodes WHERE area_id = ? AND is_dir = 1 AND deleted_at IS NULL LIMIT 5000', [a.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      if (r.vault_id) continue;
      const parts = [];
      for (let cur = r, i = 0; cur && cur.parent_id != null && i < 64; cur = byId.get(cur.parent_id), i++) parts.unshift(cur.name);
      out.push({ id: r.id, label: [ctx.areaLabel(a), ...parts].join(' › ') });
    }
  }
  return out.sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0)).slice(0, FOLDERS_MAX);
}

async function byAi(ctx, w, info, p, name) {
  const st = await insights.state(ctx.gc, ctx.settings);
  if (!st.on) return null;
  const folders = await aiFolders(ctx, w);
  if (!folders.length) return null;
  const from = p.from && typeof p.from === 'object' ? [short(p.from.name, 120), addressOf(p.from)].filter(Boolean).join(' ') : null;
  const input = [
    { type: 'text', label: 'File name', text: name },
    ...(from ? [{ type: 'text', label: 'Sender', text: from }] : []),
    ...(short(p.subject, 300) ? [{ type: 'text', label: 'Subject', text: short(p.subject, 300) }] : []),
    ...(dateOf(p.date) ? [{ type: 'text', label: 'Date', text: dateOf(p.date) }] : []),
    { type: 'text', label: 'Folders', text: folders.map((f, i) => `${i}: ${f.label}`).join('\n') },
  ];
  // the file itself only as a picture, and only while GateControl lets pictures go to the AI
  if (st.media && insights.IMAGE_RE.test(String(info.mime || '')) && info.bytes <= insights.IMAGE_MAX) input.push({ type: 'media', mediaId: info.mediaId });
  let res;
  try {
    res = await ctx.gc.ai.extract({ task: 'drive_mail_filing', user: ctx.viewer, instructions: INSTRUCTIONS, input, schema: SCHEMA, maxOutputTokens: 300, timeoutMs: TIMEOUT_MS });
  } catch (e) {
    ctx.gc.log.warn('filing suggestion failed', (e && e.code) || 'error');
    return null;
  }
  const d = res && res.data && typeof res.data === 'object' ? res.data : {};
  const pick = Number.isInteger(d.folder) && folders[d.folder] ? await usableFolder(ctx, w, folders[d.folder].id) : null;
  const conf = typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? d.confidence : 0.5;
  return {
    kind: insights.KINDS.includes(d.kind) ? d.kind : null,
    title: insights.clean(d.title, 120),
    suggestion: pick ? suggestionOf(ctx, pick, insights.suggestName(d.name, name) || name, conf, 'ai') : null,
  };
}

/** A date (ms, ISO or YYYY-MM-DD) as YYYY-MM-DD, or null. */
function dateOf(v) {
  const ms = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** Is a file with these bytes in an area the person reads (a vault's ciphertext never matches)? */
async function exists(ctx, sha256) {
  if (typeof sha256 !== 'string' || !sha256) return false;
  const ids = (await ctx.visible()).map((v) => v.area.id);
  for (const part of store.chunks(ids)) {
    if (await store.one(ctx.gc, `SELECT 1 AS x FROM nodes WHERE sha256 = ? AND is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL
      AND area_id IN (${store.marks(part.length)}) LIMIT 1`, [sha256, ...part])) return true;
  }
  return false;
}

async function suggestFolder(ctx, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const info = await handed(ctx, p.mediaId);
  let name;
  try { name = nodeName(p.name != null ? p.name : String(info.name || '')); } catch { throw fail('invalid', { field: 'name' }); }
  const w = await writable(ctx);
  const sha256Exists = await exists(ctx, info.sha256);
  const sender = addressOf(p.from);
  const rule = await learned(ctx, w, sender, name);
  if (rule) return { suggestion: rule, sha256Exists };
  const ai = await byAi(ctx, w, info, p, name);
  if (ai && ai.suggestion) return { suggestion: ai.suggestion, ...(ai.kind ? { kind: ai.kind } : {}), ...(ai.title ? { title: ai.title } : {}), sha256Exists };
  const k = await byKind(ctx, w, name, short(p.subject, 300));
  const kind = (ai && ai.kind) || k.kind;
  return { suggestion: k.suggestion, ...(kind ? { kind } : {}), ...(ai && ai.title ? { title: ai.title } : {}), sha256Exists };
}

// ─── where a file came from ─────────────────────

/** save_file { source } → the row to keep, checked (the caller names itself). */
function sourceArg(v, caller) {
  if (v == null) return null;
  if (!v || typeof v !== 'object') throw fail('invalid', { field: 'source' });
  const label = short(v.label, 120);
  if (!label || typeof caller !== 'string' || (v.plugin != null && v.plugin !== caller)) throw fail('invalid', { field: 'source' });
  const ref = v.ref == null ? null : String(v.ref);
  if (ref != null && !REF_RE.test(ref)) throw fail('invalid', { field: 'source' });
  return { plugin: caller, label, ref };
}

async function setSource(ctx, nodeId, src) {
  if (!src) return;
  await store.run(ctx.gc, `INSERT INTO node_sources (node_id, plugin, label, ref, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET plugin = excluded.plugin, label = excluded.label, ref = excluded.ref, at = excluded.at`,
  [nodeId, src.plugin, src.label, src.ref, ctx.now]);
}

const sourceView = (r) => ({
  plugin: r.plugin, label: r.label, ref: r.ref || null, at: iso(r.at),
  appLink: r.ref ? `gatecontrol://plugin/${r.plugin}/message/${encodeURIComponent(r.ref)}` : `gatecontrol://plugin/${r.plugin}`,
});

/** Every file node of an answer that came from another plugin gets `source` (in place). */
async function attach(ctx, list) {
  const files = list.filter((n) => !n.isDir && !Object.prototype.hasOwnProperty.call(n, 'source'));
  if (!files.length) return;
  const rows = new Map();
  for (const part of store.chunks([...new Set(files.map((n) => n.id))])) {
    for (const r of await store.all(ctx.gc, `SELECT * FROM node_sources WHERE node_id IN (${store.marks(part.length)})`, part)) rows.set(r.node_id, r);
  }
  for (const n of files) if (rows.has(n.id)) n.source = sourceView(rows.get(n.id));
}

// ─── giving and sharing ─────────────────────────

const HAND_CODES = { ERR_MEDIA_TOO_LARGE: 'too_large', ERR_MEDIA_QUOTA: 'quota', ERR_MEDIA_TYPE: 'unsupported', ERR_SERVICES_DENIED: 'forbidden', ERR_SERVICE_UNAVAILABLE: 'unavailable', ERR_MEDIA_DENIED: 'unavailable' };

async function giveFile(ctx, payload, caller) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const id = posInt(p.nodeId);
  if (!id) throw fail('invalid', { field: 'nodeId' });
  const { node } = await nodes.reach(ctx, id, 'read');
  if (node.vault_id) throw fail('encrypted');
  if (node.is_dir === 1 || !node.media_id) throw fail('invalid', { field: 'nodeId' });
  if (node.size > GIVE_MAX) throw fail('too_large', { max: GIVE_MAX });
  if (typeof ctx.gc.media.handOver !== 'function') throw fail('unavailable');
  let got;
  try {
    got = await ctx.gc.media.handOver(node.media_id, { toPlugin: caller, user: ctx.viewer });
  } catch (e) {
    if (e && HAND_CODES[e.code]) throw fail(HAND_CODES[e.code]);
    throw e;
  }
  return { mediaId: got.mediaId, name: node.name, mime: got.mime || node.mime || 'application/octet-stream', size: got.bytes != null ? got.bytes : node.size };
}

async function shareLink(ctx, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const id = posInt(p.nodeId);
  if (!id) throw fail('invalid', { field: 'nodeId' });
  const days = p.expiresDays == null ? 14 : p.expiresDays;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw fail('invalid', { field: 'expiresDays' });
  const pin = p.password == null || p.password === '' ? null : String(p.password);
  if (pin != null && !PIN_RE.test(pin)) throw fail('invalid', { field: 'password', reason: 'pin' });
  // GateControl ends a public link at most 30 days ahead
  const link = await links.create(ctx, { nodeId: id, mode: 'download', ...(pin ? { pin } : {}) }, { expiresAt: ctx.now + Math.min(days, LINK_DAYS_MAX) * DAY });
  return { url: link.url, expiresAt: link.expiresAt == null ? null : Date.parse(link.expiresAt) };
}

async function browse(ctx, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  let folderId = p.folderId == null ? null : posInt(p.folderId);
  if (p.folderId != null && !folderId) throw fail('invalid', { field: 'folderId' });
  let area;
  if (!folderId) {
    const vis = await ctx.visible();
    const spec = p.area == null ? 'mine' : String(p.area);
    const v = vis.find((x) => (spec === 'mine' ? x.area.kind === 'mine' : spec === 'family' ? x.area.kind === 'family' : x.area.id === spec));
    if (!v) throw fail('not_found', { field: 'area' });
    area = v.area;
    folderId = area.root_id;
  }
  const { node, area: a, role } = await nodes.reach(ctx, folderId, 'read');
  area = a;
  if (node.is_dir !== 1 || node.vault_id) throw fail(node.vault_id ? 'encrypted' : 'invalid', { field: 'folderId' });
  const list = await nodes.children(ctx, node.id, { dirs: p.dirs === true ? '1' : '', limit: 200 });
  const path = await nodes.pathOf(ctx.gc, node);
  return {
    folder: { id: node.id, name: node.parent_id == null ? ctx.areaLabel(area) : node.name, path, where: [ctx.areaLabel(area), ...(path ? path.split('/') : [])].join(' › '),
      areaId: area.id, writable: areas.can(role, 'write') && area.archived_at == null },
    items: list.items.filter((n) => !n.encrypted).map((n) => ({ id: n.id, name: n.name, isDir: n.isDir, size: n.size, mime: n.mime })),
    next: list.next,
  };
}

module.exports = { suggestFolder, giveFile, shareLink, browse, learn, sourceArg, setSource, attach, addressOf, GIVE_MAX, LINK_DAYS_MAX };
