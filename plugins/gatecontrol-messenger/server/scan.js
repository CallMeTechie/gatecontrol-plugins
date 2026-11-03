'use strict';

// The virus scan of GateControl (the version after 1.222.0, docs/feature-malware-scan-contract.md of GateControl):
// every file sent in a chat (pictures, voice messages, files, their previews, stories, group pictures) is checked
// right after its upload. The Messenger keeps the result per file (media.scan_*) and shows it on a message as
// `media.scan { state, blocked, finding }`. An older GateControl answers no `scan`: nothing is kept, nothing changes.
//   sending        a file in quarantine → 422 infected ("nicht gesendet – Schadsoftware"), not checkable and blocked →
//                  423 scan_blocked; a file still being checked is sent — the recipients see "Wird geprüft …"
//   reading        a blocked file has no URL, no preview and no push picture ("Datei gesperrt")
//   hook mediaScanned  a later result: the message's state, updated_at and the live event message.update

const STATES = new Set(['pending', 'clean', 'infected', 'unscannable', 'unchecked']);

/** The host's `scan` → { state, blocked, finding } or null (no scan: an older GateControl). */
function norm(s) {
  if (!s || typeof s !== 'object' || !STATES.has(s.state)) return null;
  return { state: s.state, blocked: s.blocked === true, finding: typeof s.finding === 'string' && s.finding ? s.finding.slice(0, 200) : null };
}

/** The scan of a media row → { state, blocked, finding } or null. */
const ofRow = (m) => (m && m.scan_state ? { state: m.scan_state, blocked: m.scan_blocked === 1, finding: m.scan_finding || null } : null);

/** A file to be sent that the scan holds back → infected (422) or scan_blocked (423); still being checked: sent. */
function refusal(s) {
  if (!s || !s.blocked || s.state === 'pending') return null;
  return s.state === 'infected' ? 'infected' : 'scan_blocked';
}

/** A file already sent that the scan holds back → quarantined / scan_pending / scan_blocked (423), else null. */
function held(s) {
  if (!s || !s.blocked) return null;
  if (s.state === 'pending') return 'scan_pending';
  return s.state === 'infected' ? 'quarantined' : 'scan_blocked';
}

const cols = (s) => (s ? [s.state, s.blocked ? 1 : 0, s.finding] : [null, 0, null]);

module.exports = { norm, ofRow, refusal, held, cols };
