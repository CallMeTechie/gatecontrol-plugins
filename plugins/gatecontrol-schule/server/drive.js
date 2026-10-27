'use strict';

// Attachments of school messages into Drive (1.7.0, gatecontrol-drive ≥ 1.4.0, GateControl ≥ 1.193.0 for the
// hand-over). Drive keeps its own copy: the attachment is handed over first (gc.media.handOver(mediaId,
// { toPlugin: 'gatecontrol-drive', user }) — a copy owned by that person, unclaimed), then Drive's service
// save_file files it for that person (userId) — a service call can do no more than the person can in Drive.
//
//   manual     POST …/messages/<id>/attachments/<attId>/drive  { folderId? } (app, portal, admin page) — one
//              attachment of a message the viewer may read (server/messages.js accessible; the attachment is
//              fetched from WebUntis first when it is not in the media store yet). With folderId (a folder
//              the person picked in an app) the file goes in there under its own name; without: the family
//              area, Schule/<child>/<file name> (no child level when the inbox has several children), and
//              when the person cannot write there (no family, read only) their own area „Meine Dateien“.
//              → { saved: { nodeId, name, where } }; Drive's code passed through (invalid, forbidden,
//              not_found, no_seat, not_licensed, quota, upload_invalid, exists), drive_unavailable,
//              rate_limited, too_large, failed.
//   automatic  setting drive_auto_save (default off): in the background cycle, every attachment of a new
//              message (not the baseline, found within 7 days) once into the family area,
//              Schule/<child>/<YYYY-MM-DD> <file name>, as one of the child's recipients (parents) — tried in
//              the order of their user ids, the first with a Drive seat and a family wins. What happened is
//              kept in drive_saves (saved | failed): never twice, a failure is logged once and not tried
//              again. Drive not there or busy (rate limit) → nothing kept, tried in a later cycle.
//              ≤ 3 service calls per cycle (GateControl allows 60 per hour for all of the plugin's calls).
//   flag       app/messages and the overviews say `drive: true` when Drive's save_file is reachable
//              (gc.services.available — listed in permissions.services, Drive installed and running).

const store = require('./store');
const tz = require('./tz');
const messages = require('./messages');

const DRIVE = 'gatecontrol-drive';
const SERVICE = 'save_file';
const ROOT = 'Schule';
const AUTO_WINDOW_MS = 7 * 86400000;
const AUTO_CALLS_PER_CYCLE = 3;
const BACKOFF_MS = 10 * 60000;
const DRIVE_CODES = new Set(['invalid', 'forbidden', 'not_found', 'no_seat', 'not_licensed', 'quota', 'upload_invalid', 'exists']);
// codes that say something about the person, not the file: the next parent is asked
const PERSON_CODES = new Set(['no_seat', 'forbidden', 'not_found']);
// codes of the moment: nothing is kept, tried again later
const TRANSIENT = new Set(['drive_unavailable', 'rate_limited']);

const state = { backoffUntil: 0 };

/** Is Drive's save_file reachable right now (asks nobody)? */
async function available(gc) {
  if (!gc.services || typeof gc.services.available !== 'function' || !gc.media || typeof gc.media.handOver !== 'function') return false;
  try { return (await gc.services.available(DRIVE, SERVICE)) === true; } catch { return false; }
}

/** A host error of the hand-over or the call → a short code (never a message of another system). */
function hostCode(e) {
  const c = e && typeof e.code === 'string' ? e.code : '';
  if (c === 'ERR_SERVICE_UNAVAILABLE' || c === 'ERR_SERVICES_DENIED' || c === 'ERR_MEDIA_DENIED') return 'drive_unavailable';
  if (c === 'ERR_RATE_LIMIT') return 'rate_limited';
  if (c === 'ERR_MEDIA_QUOTA') return 'quota';
  if (c === 'ERR_MEDIA_TOO_LARGE') return 'too_large';
  return 'failed';
}

/** Drive's answer code → one of ours ('failed' for anything unknown). */
const driveCode = (r) => (r && typeof r.code === 'string' && DRIVE_CODES.has(r.code) ? r.code : 'failed');

/** A name Drive takes as one folder or file name: no / \ : * ? " < > | or control characters, no dot or blank at the end. */
function safeName(v, fallback) {
  const s = String(v || '').normalize('NFC').replace(/[\0-\x1f\x7f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 200).trim();
  return s && s !== '.' && s !== '..' && s.toLowerCase() !== '.gcdrive' ? s : fallback;
}

/**
 * The file `mediaId` (this plugin's) into Drive for `userId`: handed over once, then save_file with each of
 * `targets` in turn ({ area, path } | { folderId, name }) while Drive answers one of `fallback` codes (the
 * handed-over copy is still unclaimed then). → Drive's answer { ok: true, … } | { ok: false, code }.
 */
async function saveAs(gc, userId, mediaId, targets, { lang = 'de', fallback = [] } = {}) {
  let h;
  try { h = await gc.media.handOver(mediaId, { toPlugin: DRIVE, user: userId }); } catch (e) { return { ok: false, code: hostCode(e) }; }
  let last = { ok: false, code: 'failed' };
  for (const target of targets) {
    let r;
    try {
      r = await gc.services.call({ plugin: DRIVE, service: SERVICE, userId, payload: { mediaId: h.mediaId, ...target, onConflict: 'rename', lang } });
    } catch (e) { return { ok: false, code: hostCode(e) }; }
    if (r && r.ok === true) return r;
    last = { ok: false, code: driveCode(r) };
    if (!fallback.includes(last.code)) break;
  }
  return last;
}

const fail = (code) => Object.assign(new Error(code), { code });

/** The child level of a path: the one student of the inbox (the viewer's view of it), else none. */
function childOf(students, ids) {
  const mine = students.filter((s) => ids.includes(s.id));
  return mine.length === 1 ? safeName(mine[0].display, null) : null;
}

/**
 * POST …/messages/<id>/attachments/<attId>/drive → { nodeId, name, where }. Throws SCHULE_MESSAGE_NOT_FOUND /
 * SCHULE_ATTACHMENT_* (like opening it), INVALID (folderId), or a Drive code (see above).
 */
async function saveManual(gc, user, id, attId, body, now, lang) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (b.folderId != null && (!Number.isSafeInteger(b.folderId) || b.folderId <= 0)) throw fail('INVALID');
  // who may read it, and the attachment there (SCHULE_MESSAGE_NOT_FOUND / SCHULE_ATTACHMENT_NOT_FOUND first)
  const { m, studentIds } = await messages.accessible(gc, user, id);
  if (!m.attachments.some((a) => a.id === String(attId || ''))) throw fail('SCHULE_ATTACHMENT_NOT_FOUND');
  if (!(await available(gc))) throw fail('drive_unavailable');
  const file = await messages.attachment(gc, user, id, attId, now);
  const name = safeName(file.name, 'Anhang');
  let r;
  if (b.folderId != null) r = await saveAs(gc, user.id, file.mediaId, [{ folderId: b.folderId, name }], { lang });
  else {
    const child = childOf(await store.listStudents(gc, m.account_id), studentIds);
    const path = [ROOT, child, name].filter(Boolean).join('/');
    // the family area when the person may write there, else their own
    r = await saveAs(gc, user.id, file.mediaId, [{ area: 'family', path }, { area: 'mine', path }], { lang, fallback: ['not_found', 'forbidden'] });
  }
  if (!r.ok) throw fail(r.code);
  gc.log.info('attachment saved in drive', m.account_id, user.id);
  return { nodeId: r.nodeId, name: typeof r.name === 'string' ? r.name : name, where: typeof r.where === 'string' ? r.where : null };
}

// ─── Automatic (background) ─────────────────────

/** The parents an attachment is saved as: the recipients of the inbox's children (not a child itself), by user id. */
function parentsOf(live, users) {
  const kids = new Set(live.map((s) => s.user_id).filter((x) => x != null));
  const ids = new Set();
  for (const s of live) for (const id of s.recipients) if (users.has(id) && !kids.has(id)) ids.add(id);
  return [...ids].sort((a, b) => a - b);
}

/**
 * The background job (tick, after the pushes): the new messages' attachments into the family area. Never
 * throws. → { saved, failed } of this cycle.
 */
async function autoSave(gc, cfg, now, deadline = Infinity) {
  const out = { saved: 0, failed: 0 };
  if (!cfg.driveAuto || now < state.backoffUntil) return out;
  try {
    if (!(await available(gc))) return out;
    const recent = await store.messagesForDrive(gc, now - AUTO_WINDOW_MS);
    if (!recent.length) return out;
    const done = await store.driveDone(gc, recent);
    const todo = recent.filter((m) => m.attachments.some((a) => !done.has(store.driveKey(m, a))));
    if (!todo.length) return out;
    const users = new Set();
    try { for (const u of await gc.users.list()) users.add(u.id); } catch { /* none */ }
    const accounts = new Map((await store.listAccounts(gc)).map((a) => [a.id, a]));
    const students = await store.listStudents(gc);
    const skip = new Map(); // user id → the code that says this person cannot (no seat, no family) — this cycle
    let calls = 0;
    const record = async (m, a, row) => {
      await store.driveRecord(gc, m, a, row, now);
      if (row.status === 'saved') out.saved += 1;
      else {
        out.failed += 1;
        gc.log.info('attachment not saved in drive', m.account_id, row.code);
      }
    };
    for (const m of todo) {
      const acc = accounts.get(m.account_id);
      const live = acc ? students.filter((s) => s.account_id === acc.id && s.enabled && !s.missing) : [];
      if (!live.length) continue;
      const parents = parentsOf(live, users);
      const child = live.length === 1 ? safeName(live[0].display, null) : null;
      const day = tz.localDate(m.sent_at != null ? m.sent_at : m.detected_at, cfg.tz);
      for (const a of m.attachments) {
        if (done.has(store.driveKey(m, a))) continue;
        if (!a.mediaId) {
          // not fetched (yet): wait for the cycle's fetch, unless it will never come
          if ((a.tries || 0) >= messages.ATT_TRIES || (a.size != null && a.size > messages.ATT_MAX_BYTES)) await record(m, a, { status: 'failed', code: 'not_fetched' });
          continue;
        }
        if (!parents.length) { await record(m, a, { status: 'failed', code: 'no_parent' }); continue; }
        const path = [ROOT, child, safeName(`${day} ${a.name}`, `${day} Anhang`)].filter(Boolean).join('/');
        let code = null;
        for (const uid of parents) {
          if (skip.has(uid)) { code = skip.get(uid); continue; }
          if (calls >= AUTO_CALLS_PER_CYCLE || Date.now() > deadline) return out;
          calls += 1;
          const r = await saveAs(gc, uid, a.mediaId, [{ area: 'family', path }], { lang: cfg.lang });
          if (r.ok) {
            await record(m, a, { status: 'saved', userId: uid, nodeId: Number.isSafeInteger(r.nodeId) ? r.nodeId : null });
            code = null;
            break;
          }
          if (TRANSIENT.has(r.code)) {
            state.backoffUntil = now + BACKOFF_MS;
            gc.log.info('drive busy, attachments later', r.code);
            return out;
          }
          code = r.code;
          if (PERSON_CODES.has(r.code)) { skip.set(uid, r.code); continue; }
          break; // the file's or Drive's problem (quota, not licensed, …): not another person's either
        }
        // every parent failed for himself (no seat, no family, …) → no_parent
        if (code) await record(m, a, { status: 'failed', code: PERSON_CODES.has(code) ? 'no_parent' : code });
      }
    }
  } catch (e) {
    gc.log.warn('drive auto-save failed', (e && (e.code || e.message)) || 'error');
  }
  return out;
}

module.exports = { DRIVE, SERVICE, available, saveManual, autoSave, saveAs, safeName, parentsOf, hostCode, _state: state };
