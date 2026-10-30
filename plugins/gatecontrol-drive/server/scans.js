'use strict';

// Scans become documents (since 1.14.0, feature `scanDocs`): what a scan is (printed text, handwriting, a table, a
// whiteboard) and the document it becomes — a Word file (DOCX) or an Excel workbook (XLSX) Drive writes itself
// (ooxml.js), or the text of a searchable PDF.
//
//   POST scans/classify { mediaIds? | nodeId?, text? } → { kind: printed | handwriting | table | whiteboard | other,
//                       confidence (0…1), summary, title, source: 'text' | 'media', usage: { costCents } }
//   POST scans/convert  { mediaIds? | nodeId?, text?, kind, target: 'docx' | 'xlsx' | 'pdf', name?, folderId?,
//                         images?: [base64 JPEG / PNG] }
//                       → { kind, target, title, name, folderId, folderPath, text, content, file, source, usage }
//   POST scans/save     { mediaId, folderId, name, text?, sourceId?, keepOriginal? } → { node, original }
//
// The scan: `mediaIds` — up to 8 pictures (JPEG, PNG, WebP, GIF ≤ 10 MB) the viewer uploaded and that are no file yet,
// or the pictures of files the viewer reads; or `nodeId` — a picture or a PDF the viewer reads (the portal's „In
// Dokument umwandeln“). `text`: the text the device recognised (else the file's recognised text, doc_text).
// Text before pictures: the text alone goes when it is enough (classify: a sure answer from it; convert: printed text);
// a picture goes only while GateControl lets pictures go to the AI — else 422 unsupported { reason: media_disabled |
// no_text }. Never a vault's file (409 encrypted).
//
// convert: the AI reads the content as a table (columns with their type, rows, a sum row as formulas when the scan has
// one) or as blocks (heading, paragraph, bullet, check — a task —, open — something circled or marked as open); target
// xlsx only for kind table, docx for any (a table as a Word table), pdf: the text only (the device's text, else the
// AI's) — with `images` (JPEG) also the PDF itself (each picture a page, the text invisible on it). `images` (≤ 600 KB
// together, the device's or the portal's copy of the scan): into the Word file — a whiteboard's picture at the top, a
// handwritten page as the last page. `file`: { name, mime, size, sha256, data (base64) } — GateControl lets no plugin
// write a file of its own, so the device or the portal uploads these bytes (GateControl's media upload) and files them
// with scans/save; null for a PDF without images. `content`: { table } or { blocks } (the preview), `text`: the
// document's text for its recognised text (search, questions). name: `name` (the extension made right), else
// "<YYYY-MM-DD> <title>.<ext>", free in the folder; folderId: `folderId` (a folder one writes to, not a vault), else
// the folder of `nodeId` when one writes there, else null.
//
// save: uploads/commit of the uploaded file (`mediaId`) into `folderId` under a free `name` with `text` as its recognised
// text; `sourceId` (the scan's file) with keepOriginal false goes into the trash (when one may) — `original`: the scan's
// file when it stays, else null.

const store = require('./store');
const nodes = require('./nodes');
const files = require('./files');
const insights = require('./insights');
const ooxml = require('./ooxml');
const ai = require('./ai');
const crypto = require('node:crypto');
const { t } = require('./text');
const { fail, posInt, nodeName, MEDIA_RE, docText, day } = require('./util');

const KINDS = ['printed', 'handwriting', 'table', 'whiteboard', 'other'];
const TARGETS = ['docx', 'xlsx', 'pdf'];
const MEDIA_MAX = 8;
const TEXT_MIN = 20;
const TEXT_AI_MAX = 20000;
const SURE = 0.6;
const IMAGES_MAX_BYTES = 600 * 1024;
const IMAGES_MAX = 8;
const TIMEOUT_MS = 90000;
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const CLASSIFY_INSTRUCTIONS = [
  'You look at one scan a person just made with their phone or uploaded and say what it is:',
  'printed — printed or typed text (a letter, a form, a receipt, a book page);',
  'handwriting — mostly handwritten text (a note, a letter, homework);',
  'table — rows and columns of values (meter readings, a price list, a time sheet);',
  'whiteboard — a whiteboard, flip chart or blackboard with notes, lists and tasks;',
  'other — a photo or anything without readable text.',
  'confidence: 0…1, how sure you are. summary: a very short description in the language named "Language", e.g.',
  '"3 Spalten, 12 Zeilen, Summenzeile" or "Brief der Stadtwerke, 1 Seite". title: a short title for a file name in the',
  'language of the scan, or null.',
].join('\n');

const CLASSIFY_SCHEMA = {
  type: 'object',
  required: ['kind', 'confidence', 'summary', 'title'],
  properties: {
    kind: { type: 'string', enum: KINDS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', maxLength: 160 },
    title: { type: 'string', maxLength: 80, nullable: true },
  },
};

const TABLE_INSTRUCTIONS = [
  'Copy the table of this scan exactly, in the language of the scan. Never invent values.',
  'title: a short title of the table. columns: the header of each column with its type — text, integer, number',
  '(decimal), currency (an amount; currency as ISO 4217) or date. rows: every data row, a string per column, in order —',
  'numbers without thousands separators and with "." as decimal point (41208, 84.20), dates as YYYY-MM-DD, empty cells as',
  '"". Leave a sum or total row out of rows; instead total: its label and for each column with a value whether it is the',
  'sum, the difference of the last and the first value, or the average — or total null when the scan has no such row.',
].join('\n');

const TABLE_SCHEMA = {
  type: 'object',
  required: ['title', 'columns', 'rows', 'total'],
  properties: {
    title: { type: 'string', maxLength: 80, nullable: true },
    columns: {
      type: 'array', maxItems: 30,
      items: {
        type: 'object', required: ['name', 'type'],
        properties: { name: { type: 'string', maxLength: 80 }, type: { type: 'string', enum: ['text', 'integer', 'number', 'currency', 'date'] }, currency: { type: 'string', maxLength: 3, nullable: true } },
      },
    },
    rows: { type: 'array', maxItems: 500, items: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 200 } } },
    total: {
      type: 'object', nullable: true, required: ['label', 'cells'],
      properties: {
        label: { type: 'string', maxLength: 40 },
        cells: { type: 'array', maxItems: 30, items: { type: 'object', required: ['column', 'op'], properties: { column: { type: 'integer', minimum: 0, maximum: 29 }, op: { type: 'string', enum: ['sum', 'difference', 'average'] } } } },
      },
    },
  },
};

const DOC_INSTRUCTIONS = {
  printed: 'Copy the text of this printed document exactly, in its language, keeping its structure: headings, paragraphs, lists.',
  handwriting: 'Transcribe this handwritten text exactly, in its language, as paragraphs; keep lists as bullets. Mark nothing you cannot read as certain — write [?] there.',
  whiteboard: 'Turn the notes of this whiteboard into a clean outline in its language: headings, bullets, tasks as check (the person after a dash, done when ticked), and everything circled, starred or marked as open as open.',
  other: 'Copy any text of this picture exactly, in its language, as paragraphs.',
  table: 'Copy the text around the table as paragraphs.',
};
const DOC_COMMON = [
  'title: a short title of the document. blocks in reading order: heading (level 1 or 2), paragraph, bullet, check (a task;',
  'done true when ticked) or open (an open point). Never invent anything.',
].join('\n');

const DOC_SCHEMA = {
  type: 'object',
  required: ['title', 'blocks'],
  properties: {
    title: { type: 'string', maxLength: 80, nullable: true },
    blocks: {
      type: 'array', maxItems: 300,
      items: {
        type: 'object', required: ['type', 'text'],
        properties: {
          type: { type: 'string', enum: ['heading', 'paragraph', 'bullet', 'check', 'open'] },
          text: { type: 'string', maxLength: 4000 },
          level: { type: 'integer', minimum: 1, maximum: 2, nullable: true },
          done: { type: 'boolean', nullable: true },
        },
      },
    },
  },
};

const TEXT_INSTRUCTIONS = 'Transcribe all text of this scan exactly, line by line, in its language. Never invent anything.';
const TEXT_SCHEMA = { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 20000 } } };

const IMAGE_RE = /^image\/(?:jpeg|png|webp|gif)$/;

/** A file the viewer reads (picture or PDF, not a vault's) → its row. */
async function sourceNode(ctx, id) {
  const n = posInt(id);
  if (!n) throw fail('invalid', { field: 'nodeId' });
  const { node } = await nodes.reach(ctx, n);
  if (node.vault_id) throw fail('encrypted');
  if (node.is_dir === 1 || !node.media_id || !(/^image\//.test(String(node.mime || '')) || node.mime === 'application/pdf')) throw fail('invalid', { field: 'nodeId' });
  return node;
}

/** A picture the viewer may send: their own upload that is no file yet, or the picture of a file they read. */
async function usableMedia(ctx, id) {
  if (typeof id !== 'string' || !MEDIA_RE.test(id)) throw fail('invalid', { field: 'mediaIds' });
  const n = await store.one(ctx.gc, 'SELECT id FROM nodes WHERE media_id = ?', [id]);
  if (n) {
    const node = await sourceNode(ctx, n.id).catch((e) => { throw e.code === 'encrypted' ? e : fail('invalid', { field: 'mediaIds' }); });
    if (!IMAGE_RE.test(String(node.mime || '')) || node.size > insights.IMAGE_MAX) throw fail('invalid', { field: 'mediaIds', reason: 'type' });
    return id;
  }
  let info = null;
  try { info = await ctx.gc.media.info(id); } catch { info = null; }
  if (!info || info.owner !== ctx.viewer || info.claimed) throw fail('invalid', { field: 'mediaIds' });
  if (!IMAGE_RE.test(String(info.mime || '')) || info.bytes > insights.IMAGE_MAX) throw fail('invalid', { field: 'mediaIds', reason: 'type' });
  return id;
}

/** The scan of a body → { node, text, media: [mediaId] }. */
async function scanOf(ctx, b) {
  if (b.text != null && typeof b.text !== 'string') throw fail('invalid', { field: 'text' });
  let node = null;
  const media = [];
  if (b.nodeId != null) {
    node = await sourceNode(ctx, b.nodeId);
    if (IMAGE_RE.test(String(node.mime || '')) && node.size <= insights.IMAGE_MAX) media.push(node.media_id);
  } else if (b.mediaIds != null) {
    if (!Array.isArray(b.mediaIds) || !b.mediaIds.length || b.mediaIds.length > MEDIA_MAX) throw fail('invalid', { field: 'mediaIds' });
    for (const id of [...new Set(b.mediaIds)]) media.push(await usableMedia(ctx, id));
  }
  let text = docText(b.text);
  if (!text && node) {
    const r = await store.one(ctx.gc, 'SELECT text FROM doc_text WHERE node_id = ?', [node.id]);
    text = r ? r.text : null;
  }
  if (!node && !media.length && !text) throw fail('invalid', { field: 'mediaIds' });
  return { node, text: text || null, media };
}

const textInput = (text) => ({ type: 'text', label: 'Recognised text', text: text.slice(0, TEXT_AI_MAX) });
const mediaInput = (media) => media.map((mediaId) => ({ type: 'media', mediaId }));

/** POST scans/classify */
async function classify(ctx, body) {
  const st = await ai.need(ctx);
  const b = body && typeof body === 'object' ? body : {};
  const scan = await scanOf(ctx, b);
  const lang = { type: 'text', label: 'Language', text: ctx.lang === 'en' ? 'English' : 'Deutsch' };
  const ask = (input) => ai.extract(ctx, { task: 'drive_scan_kind', instructions: CLASSIFY_INSTRUCTIONS, schema: CLASSIFY_SCHEMA, maxOutputTokens: 300, timeoutMs: TIMEOUT_MS, input: [lang, ...input] });
  let res = null;
  let source = null;
  let cost = 0;
  // the text first; the picture only when the text does not make it sure (and pictures may go)
  if (scan.text && scan.text.length >= TEXT_MIN) {
    res = await ask([textInput(scan.text)]);
    source = 'text';
    cost += res.costCents || 0;
  }
  const sure = res && KINDS.includes(res.data.kind) && Number(res.data.confidence) >= SURE;
  if (!sure && scan.media.length) {
    if (st.media) {
      res = await ask([...(scan.text ? [textInput(scan.text)] : []), ...mediaInput(scan.media)]);
      source = 'media';
      cost += res.costCents || 0;
    } else if (!res) throw fail('unsupported', { reason: 'media_disabled' });
  }
  if (!res) throw fail('unsupported', { reason: 'no_text' });
  const d = res.data;
  return {
    kind: KINDS.includes(d.kind) ? d.kind : 'other',
    confidence: Number.isFinite(Number(d.confidence)) ? Math.max(0, Math.min(1, Number(d.confidence))) : 0,
    summary: insights.clean(d.summary, 160) || '', title: insights.clean(d.title, 80), source, usage: { costCents: cost },
  };
}

/** `images` of a body → [{ data: Buffer, mime }] (JPEG, PNG; ≤ IMAGES_MAX_BYTES together) or invalid { field: 'images' }. */
function imagesArg(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > IMAGES_MAX) throw fail('invalid', { field: 'images' });
  let total = 0;
  return v.map((s) => {
    if (typeof s !== 'string') throw fail('invalid', { field: 'images' });
    const data = Buffer.from(s.replace(/^data:[^;,]*;base64,/, ''), 'base64');
    total += data.length;
    if (total > IMAGES_MAX_BYTES) throw fail('too_large', { field: 'images', maxBytes: IMAGES_MAX_BYTES });
    const size = ooxml.imageSize(data);
    if (!size) throw fail('invalid', { field: 'images', reason: 'type' });
    return { data, mime: size.mime };
  });
}

/** "Brief.pdf" / "Brief" → "Brief.docx" (a checked name), else null. */
function nameWith(v, ext) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/[<>:"/\\|?*\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\.(docx?|xlsx?|pdf|jpe?g|png|webp|gif|heic)$/i, '').replace(/[. ]+$/, '').trim();
  if (!s) return null;
  try { return nodeName(`${s.slice(0, 200)}.${ext}`); } catch { return null; }
}

/** The folder a document goes into → row or null. */
async function folderOf(ctx, b, scan) {
  if (b.folderId != null) {
    const { node } = await nodes.folderFor(ctx, posInt(b.folderId) || 0);
    if (node.vault_id) throw fail('encrypted');
    return node;
  }
  if (scan.node) {
    try {
      const { node } = await nodes.folderFor(ctx, scan.node.parent_id);
      return node.vault_id ? null : node;
    } catch { return null; }
  }
  return null;
}

/** Where the content comes from: 'text' or 'media' (else unsupported). */
function sourceFor(kind, target, scan, st) {
  const hasText = !!(scan.text && scan.text.length >= TEXT_MIN);
  const canMedia = scan.media.length > 0 && st.media;
  // printed text and the PDF's text: the text is enough
  if ((kind === 'printed' || target === 'pdf') && hasText) return 'text';
  if (canMedia) return 'media';
  if (scan.text) return 'text';
  throw fail('unsupported', { reason: scan.media.length ? 'media_disabled' : 'no_text' });
}

/** A table of the AI → { title, columns, rows, total } cleaned. */
function tableOf(d) {
  const columns = (Array.isArray(d.columns) ? d.columns : []).slice(0, 30).map((c) => ({
    name: insights.clean(c && c.name, 80) || '', type: ['text', 'integer', 'number', 'currency', 'date'].includes(c && c.type) ? c.type : 'text',
    currency: c && typeof c.currency === 'string' && /^[A-Za-z]{3}$/.test(c.currency) ? c.currency.toUpperCase() : null,
  }));
  const rows = (Array.isArray(d.rows) ? d.rows : []).filter(Array.isArray).slice(0, 500)
    .map((r) => columns.map((_, i) => (typeof r[i] === 'string' ? r[i].replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200) : '')));
  const tot = d.total && typeof d.total === 'object' && Array.isArray(d.total.cells) ? d.total : null;
  const total = tot ? { label: insights.clean(tot.label, 40) || '', cells: tot.cells.filter((c) => c && Number.isInteger(c.column) && c.column < columns.length && ['sum', 'difference', 'average'].includes(c.op)).map((c) => ({ column: c.column, op: c.op })) } : null;
  return { title: insights.clean(d.title, 80), columns, rows, total: total && total.cells.length ? total : null };
}

/** Blocks of the AI → [{ type, text, level?, done? }] cleaned. */
function blocksOf(d) {
  const out = [];
  for (const b of Array.isArray(d.blocks) ? d.blocks : []) {
    if (!b || !['heading', 'paragraph', 'bullet', 'check', 'open'].includes(b.type) || typeof b.text !== 'string') continue;
    const text = b.text.replace(/\r\n?/g, '\n').replace(/[\0-\x09\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 4000);
    if (!text) continue;
    out.push({ type: b.type, text, ...(b.type === 'heading' ? { level: b.level === 2 ? 2 : 1 } : {}), ...(b.type === 'check' ? { done: b.done === true } : {}) });
  }
  return out.slice(0, 300);
}

const tableText = (tb) => [tb.title, tb.columns.map((c) => c.name).join('\t'), ...tb.rows.map((r) => r.join('\t'))].filter(Boolean).join('\n');
const blocksText = (title, blocks) => [title, ...blocks.map((b) => (b.type === 'check' ? `${b.done ? '☑' : '☐'} ${b.text}` : b.type === 'bullet' || b.type === 'open' ? `• ${b.text}` : b.text))].filter(Boolean).join('\n');

/** POST scans/convert */
async function convert(ctx, body) {
  const st = await ai.need(ctx);
  const b = body && typeof body === 'object' ? body : {};
  const kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) throw fail('invalid', { field: 'kind' });
  const target = TARGETS.includes(b.target) ? b.target : null;
  if (!target || (target === 'xlsx' && kind !== 'table')) throw fail('invalid', { field: 'target' });
  const images = imagesArg(b.images);
  if (target === 'pdf' && images.some((x) => x.mime !== 'image/jpeg')) throw fail('invalid', { field: 'images', reason: 'type' });
  if (b.name != null && typeof b.name !== 'string') throw fail('invalid', { field: 'name' });
  const scan = await scanOf(ctx, b);
  const folder = await folderOf(ctx, b, scan);
  let source = null;
  let cost = 0;
  let title = null;
  let content = null;
  let text = null;
  let buf = null;
  const sourceInput = (src) => (src === 'text' ? [textInput(scan.text)] : [...(scan.text ? [textInput(scan.text)] : []), ...mediaInput(scan.media)]);

  if (target === 'pdf') {
    // the device's text needs no AI
    if (scan.text) { source = 'device'; text = scan.text; } else {
      source = sourceFor(kind, target, scan, st);
      const r = await ai.extract(ctx, { task: 'drive_scan_text', instructions: TEXT_INSTRUCTIONS, schema: TEXT_SCHEMA, maxOutputTokens: 6000, timeoutMs: TIMEOUT_MS, input: sourceInput(source) });
      cost += r.costCents || 0;
      text = docText(r.data.text) || '';
    }
    content = { text: text.slice(0, 2000) };
    if (images.length) buf = ooxml.pdf({ title: b.name || '', pages: images, text });
  } else if (kind === 'table') {
    source = sourceFor(kind, target, scan, st);
    const r = await ai.extract(ctx, { task: 'drive_scan_table', instructions: TABLE_INSTRUCTIONS, schema: TABLE_SCHEMA, maxOutputTokens: 12000, timeoutMs: TIMEOUT_MS, input: sourceInput(source) });
    cost += r.costCents || 0;
    const tb = tableOf(r.data);
    if (!tb.columns.length) throw fail('ai_failed', { reason: 'ai_invalid' });
    title = tb.title;
    content = { table: tb };
    text = tableText(tb);
    buf = target === 'xlsx' ? ooxml.xlsx(tb) : ooxml.docx({ title: tb.title, table: tb, blocks: [], lang: ctx.lang });
  } else {
    source = sourceFor(kind, target, scan, st);
    const r = await ai.extract(ctx, {
      task: 'drive_scan_document', instructions: `${DOC_INSTRUCTIONS[kind]}\n${DOC_COMMON}`, schema: DOC_SCHEMA, maxOutputTokens: 8000, timeoutMs: TIMEOUT_MS, input: sourceInput(source),
    });
    cost += r.costCents || 0;
    title = insights.clean(r.data.title, 80);
    const blocks = blocksOf(r.data);
    content = { blocks };
    text = blocksText(title, blocks);
    // the scan in the document: a whiteboard's picture at the top, a handwritten page at the end
    const image = images.length && (kind === 'whiteboard' || kind === 'handwriting') ? images[0] : null;
    buf = ooxml.docx({ title, blocks, image, imageAt: kind === 'whiteboard' ? 'top' : 'end', lang: ctx.lang });
  }

  const ext = target;
  const base = title || t(ctx.lang, 'scan.name');
  let name = nameWith(b.name, ext) || nameWith(`${day(ctx.now)} ${base}`, ext) || `Scan.${ext}`;
  if (folder) name = await nodes.freeName(ctx.gc, folder.area_id, folder.id, name);
  const file = buf ? {
    name, mime: MIME[target], size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64'),
  } : null;
  return {
    kind, target, title, name, folderId: folder ? folder.id : null, folderPath: folder ? await nodes.pathOf(ctx.gc, folder) : null,
    text: docText(text), content, file, source, usage: { costCents: cost },
  };
}

/** POST scans/save { mediaId, folderId, name, text?, sourceId?, keepOriginal? } → { node, original } */
async function save(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.folderId == null) throw fail('invalid', { field: 'folderId' });
  const out = await files.commit(ctx, { mediaId: b.mediaId, parentId: b.folderId, name: b.name, text: b.text, onConflict: 'rename' });
  let original = null;
  if (b.sourceId != null) {
    const id = posInt(b.sourceId);
    const src = id ? await nodes.row(ctx.gc, id) : null;
    if (src && src.deleted_at == null && src.is_dir === 0) {
      const { node } = await nodes.reach(ctx, src.id);
      original = nodes.view(node);
      if (b.keepOriginal === false) {
        // read only there (or the protection stopped this device): the scan stays where it is
        try { await nodes.trash(ctx, node.id); original = null; } catch (e) { ctx.gc.log.info('scan kept', (e && e.code) || 'error'); }
      }
    }
  }
  return { node: out.node, original };
}

module.exports = { classify, convert, save, KINDS, TARGETS, MIME, tableOf, blocksOf, nameWith };
