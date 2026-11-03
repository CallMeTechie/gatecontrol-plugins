'use strict';

// The virus scan of GateControl (the version after 1.222.0, docs/feature-malware-scan-contract.md of GateControl): every
// file uploaded to GateDrop is checked right after it is stored. GateDrop keeps the result per item (items.scan_*), shows
// it as `scan { state, blocked, finding }` on the items of a send, and never hands on a file the scan holds back
// (`blocked`). An older GateControl answers no `scan`: nothing is kept, nothing changes.
//   POST sends / POST sends/<id>/items   a file in quarantine → 422 infected, not checkable and blocked → 423
//                                        scan_blocked, still being checked → 423 scan_pending (send again in a few seconds)
//   GET items/<mediaId>                  423 with the same codes once a later check blocked it
//   hook mediaScanned                    a later result (re-check, an administrator released or deleted it)

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);

/** The host's `scan` → { state, blocked, finding } or null (no scan: an older GateControl). */
function norm(s) {
  if (!s || typeof s !== 'object' || !STATES.has(s.state)) return null;
  return { state: s.state, blocked: s.blocked === true, finding: typeof s.finding === 'string' && s.finding ? s.finding.slice(0, 200) : null };
}

/** The scan of an item row → { state, blocked, finding } or null. */
const ofItem = (i) => (i && i.scan_state ? { state: i.scan_state, blocked: i.scan_blocked === 1, finding: i.scan_finding || null } : null);

/** A file being sent that the scan holds back → the refusal: infected (422), scan_pending / scan_blocked (423); else null. */
function refusal(s) {
  if (!s || !s.blocked) return null;
  if (s.state === 'pending') return 'scan_pending';
  if (s.state === 'infected') return 'infected';
  return 'scan_blocked';
}

/** A file already part of a send that the scan holds back → quarantined / scan_pending / scan_blocked (423); else null. */
function held(s) {
  if (!s || !s.blocked) return null;
  if (s.state === 'pending') return 'scan_pending';
  if (s.state === 'infected') return 'quarantined';
  return 'scan_blocked';
}

/** The columns of a scan for an UPDATE / INSERT: [state, blocked, finding]. */
const cols = (s) => (s ? [s.state, s.blocked ? 1 : 0, s.finding] : [null, 0, null]);

module.exports = { norm, ofItem, refusal, held, cols };
