'use strict';

// Moving over from Synology DS Note / Note Station (board „Umzug“): the device reads the .nsx export itself
// (ui/nsx.js — the file is never uploaded as a whole), uploads the attachments one by one (GC.upload / PUT …/media) and
// sends the notes here in batches. Protected notebooks: the device opens them with the password the person enters and
// writes them into a Tresor notebook it makes (vault.js) — encrypted on the device, the server never sees the text;
// a note the device cannot open (unknown format, wrong password) is skipped and counted (README "Umzug aus DS Note").
//
//   POST import/dsnote/start { file, notebooks, notes, bytes }               → { job }
//   POST import/dsnote/<job>/notebook { ref, name, area? }                   → { notebookId }   (idempotent per ref)
//   POST import/dsnote/<job>/notes { notebookId, notes: [Note…] (≤ 20) }    → { imported, skipped, ids: { <ref>: id } }
//     Note: { ref, title, body (Markdown; a picture or file of the note as ](attnew:<n>) ), tags?, created?, updated?,
//             attachments?: [{ n, mediaId, name }] }  — in a Tresor { ref, titleCipher, cipher, keyVersion, created?,
//             updated?, attachments?: [{ n, mediaId, nameCipher }] } (the cipher names the attachments ](att:<id>) by
//             the ids the answer of an earlier batch does not have: a Tresor note's pictures are listed with the note)
//   POST import/dsnote/<job>/finish { skipped?, protectedSkipped? }          → { job }

const store = require('./store');
const config = require('./config');
const notes = require('./notes');
const attachments = require('./attachments');
const events = require('./events');
const { fail, posInt, line, parse } = require('./util');

const BATCH = 20;
const REF_RE = /^[A-Za-z0-9:._-]{1,100}$/;

async function jobOf(gc, ctx, id) {
  const j = await store.one(gc, "SELECT * FROM imports WHERE id = ? AND user_id = ? AND kind = 'dsnote'", [posInt(id) || 0, ctx.userId]);
  if (!j) throw fail('not_found');
  if (j.state !== 'running') throw fail('conflict', { state: j.state });
  return j;
}
const view = (j) => ({ id: j.id, kind: j.kind, state: j.state, stats: parse(j.stats_json, {}), createdAt: j.created_at, updatedAt: j.updated_at });

async function start(gc, ctx, b) {
  const cfg = await config.get(gc);
  if (!cfg.import_dsnote) throw fail('forbidden', { reason: 'off' });
  const opts = { file: line(b && b.file, 200), notebooks: posInt(b && b.notebooks) || 0, notes: posInt(b && b.notes) || 0, bytes: Number(b && b.bytes) || 0 };
  // an import of the same person that did not finish ends here
  await store.run(gc, "UPDATE imports SET state = 'canceled', updated_at = ? WHERE user_id = ? AND kind = 'dsnote' AND state = 'running'", [ctx.now, ctx.userId]);
  const r = await store.run(gc, "INSERT INTO imports (user_id, kind, state, options_json, stats_json, created_at, updated_at) VALUES (?, 'dsnote', 'running', ?, ?, ?, ?)",
    [ctx.userId, JSON.stringify(opts), JSON.stringify({ notebooks: 0, notes: 0, attachments: 0, skipped: 0, protectedSkipped: 0 }), ctx.now, ctx.now]);
  return { job: view(await store.one(gc, 'SELECT * FROM imports WHERE id = ?', [Number(r.lastInsertRowid)])) };
}

async function bump(gc, j, add, now) {
  const st = parse(j.stats_json, {});
  for (const [k, v] of Object.entries(add)) st[k] = (st[k] || 0) + v;
  j.stats_json = JSON.stringify(st);
  await store.run(gc, 'UPDATE imports SET stats_json = ?, updated_at = ? WHERE id = ?', [j.stats_json, now, j.id]);
}

async function notebook(gc, ctx, id, b) {
  const j = await jobOf(gc, ctx, id);
  if (!b || typeof b.ref !== 'string' || !REF_RE.test(b.ref)) throw fail('invalid', { field: 'ref' });
  const have = await store.one(gc, "SELECT id FROM notebooks WHERE owner_id = ? AND ext_kind = 'dsnote' AND ext_id = ? AND deleted_at IS NULL", [ctx.userId, b.ref]);
  if (have) return { notebookId: have.id, existed: true };
  const made = await notes.createNotebook(gc, ctx, { name: line(b.name, 80) || 'DS Note', area: b.area }, { extKind: 'dsnote', extId: b.ref });
  await bump(gc, j, { notebooks: 1 }, ctx.now);
  return { notebookId: made.notebook.id };
}

/** `](attnew:<n>)` of a body → the real attachment ids. */
function relink(body, map) {
  return String(body || '').replace(/\]\(attnew:(\d{1,4})\)/g, (all, n) => (map.has(Number(n)) ? `](att:${map.get(Number(n))})` : ']()'));
}

async function batch(gc, ctx, id, b) {
  const j = await jobOf(gc, ctx, id);
  const nb = await notes.notebookAccess(gc, ctx.userId, b && b.notebookId);
  if (!Array.isArray(b.notes) || !b.notes.length || b.notes.length > BATCH) throw fail('invalid', { field: 'notes' });
  const ids = {};
  let imported = 0;
  let skipped = 0;
  let files = 0;
  for (const n of b.notes) {
    if (!n || typeof n.ref !== 'string' || !REF_RE.test(n.ref)) { skipped++; continue; }
    const have = await store.one(gc, "SELECT id FROM notes INDEXED BY idx_notes_ext WHERE notebook_id = ? AND ext_kind = 'dsnote' AND ext_id = ?", [nb.id, n.ref]);
    if (have) { ids[n.ref] = have.id; skipped++; continue; }
    const created = Number.isSafeInteger(n.created) && n.created > 0 ? n.created : ctx.now;
    const updated = Number.isSafeInteger(n.updated) && n.updated > 0 ? n.updated : created;
    let made;
    try {
      if (nb.vault_id) {
        made = await notes.create(gc, ctx, { notebookId: nb.id, titleCipher: n.titleCipher, cipher: n.cipher, keyVersion: n.keyVersion }, { notebook: nb, createdAt: created, updatedAt: updated, extKind: 'dsnote', extId: n.ref, quiet: true });
      } else {
        let body = String(n.body || '');
        const tags = Array.isArray(n.tags) ? n.tags.map((x) => String(x).trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean).slice(0, 20) : [];
        if (tags.length) body += (body ? '\n\n' : '') + tags.map((x) => '#' + x).join(' ');
        made = await notes.create(gc, ctx, { notebookId: nb.id, title: n.title, body: '' }, { notebook: nb, createdAt: created, updatedAt: updated, extKind: 'dsnote', extId: n.ref, quiet: true });
        n.bodyFinal = body;
      }
    } catch (e) { skipped++; continue; }
    const map = new Map();
    for (const a of Array.isArray(n.attachments) ? n.attachments.slice(0, 100) : []) {
      try {
        const r = await attachments.add(gc, ctx, { kind: 'note', refId: made.id, mediaId: a.mediaId, name: a.name, nameCipher: a.nameCipher }, { quiet: true });
        map.set(Number(a.n), r.attachment.id);
        files++;
      } catch (e) { skipped++; }
    }
    if (!nb.vault_id) {
      await store.tx(gc, async () => {
        const body = relink(n.bodyFinal, map).slice(0, notes.BODY_MAX);
        await store.run(gc, 'UPDATE notes SET body = ? WHERE id = ?', [body, made.id]);
        await notes.derive(gc, made.id, nb.id, line(n.title, notes.TITLE_MAX), body, []);
      });
    }
    ids[n.ref] = made.id;
    imported++;
  }
  await bump(gc, j, { notes: imported, skipped, attachments: files }, ctx.now);
  events.changed(gc, await notes.memberIds(gc, nb.id), 'notes');
  return { imported, skipped, ids };
}

async function finish(gc, ctx, id, b) {
  const j = await jobOf(gc, ctx, id);
  await bump(gc, j, { skipped: posInt(b && b.skipped) || 0, protectedSkipped: posInt(b && b.protectedSkipped) || 0 }, ctx.now);
  await store.run(gc, "UPDATE imports SET state = 'done', updated_at = ? WHERE id = ?", [ctx.now, j.id]);
  events.changed(gc, [ctx.userId], 'notebooks');
  return { job: view(await store.one(gc, 'SELECT * FROM imports WHERE id = ?', [j.id])) };
}

module.exports = { start, notebook, batch, finish, relink };
