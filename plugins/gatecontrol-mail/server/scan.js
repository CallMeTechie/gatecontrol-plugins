'use strict';

// The virus scan of GateControl (the version after 1.222.0, docs/feature-malware-scan-contract.md of GateControl): every
// attachment GateControl stores for Mail (gc.mail's attachments and downloads, gc.media.fetch of Microsoft, the files of
// drafts) is checked right after it is stored. Mail keeps the result per attachment (attachments.scan_*) and per file of
// a draft (draft_atts.scan_*) and shows it as `scan { state, blocked, finding, removed? }`. An older GateControl answers
// no `scan`: nothing is kept, nothing changes.
//   'removed'     GateControl deleted the attachment at once (the administrator's action "Sofort löschen" —
//                 ERR_MEDIA_INFECTED, `mediaError` of a parsed mail): "Anhang entfernt (Schadsoftware)", never loaded again
//   blocked       quarantine, still being checked, not checkable and blocked: no opening, no download, no Drive, no sending
//                 (409 attachment_blocked with its name — remove it from the draft)
//   hook mediaScanned  a later result (re-check, an administrator released or deleted the file)

const store = require('./store');
const { fail } = require('./util');

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);

/** The host's `scan` → { state, blocked, finding } or null (no scan: an older GateControl). */
function norm(s) {
  if (!s || typeof s !== 'object' || !STATES.has(s.state)) return null;
  return { state: s.state, blocked: s.blocked === true, finding: typeof s.finding === 'string' && s.finding ? s.finding.slice(0, 200) : null };
}

/** The API's `scan` of a row (attachments, draft_atts) — null without a result. */
function ofRow(r) {
  if (!r || !r.scan_state) return null;
  if (r.scan_state === 'removed') return { state: 'infected', blocked: true, finding: r.scan_finding || null, removed: true };
  return { state: r.scan_state, blocked: r.scan_blocked === 1, finding: r.scan_finding || null };
}

/** A held-back file → its code: attachment_removed, quarantined, scan_pending, scan_blocked; else null. */
function held(s) {
  if (!s || !s.blocked) return null;
  if (s.removed) return 'attachment_removed';
  if (s.state === 'pending') return 'scan_pending';
  return s.state === 'infected' ? 'quarantined' : 'scan_blocked';
}

/** Throws the code of a held-back file (with its scan). */
function guard(s) {
  const code = held(s);
  if (code) throw fail(code, { scan: s });
}

const cols = (s) => (s ? [s.state, s.blocked ? 1 : 0, s.finding] : [null, 0, null]);

/** Keep the result of attachment `id` (from gc.media.info's `scan`) → the API's scan or null. */
async function keepAttachment(gc, id, scan) {
  const s = norm(scan);
  if (!s) return null;
  await store.run(gc, 'UPDATE attachments SET scan_state = ?, scan_blocked = ?, scan_finding = ? WHERE id = ?', [...cols(s), id]);
  return s;
}

/** GateControl deleted attachment `id` at once (ERR_MEDIA_INFECTED): kept as removed; never loaded again. */
async function removed(gc, id, finding = null) {
  await store.run(gc, "UPDATE attachments SET scan_state = 'removed', scan_blocked = 1, scan_finding = ?, media_id = NULL WHERE id = ?", [finding, id]);
}

const isInfected = (e) => !!(e && (e.code === 'ERR_MEDIA_INFECTED' || (e.code === 'ERR_INVALID' && /infected/.test(String(e.message || '')))));

module.exports = { norm, ofRow, held, guard, cols, keepAttachment, removed, isInfected };
