'use strict';

// A suggestion from the user profile (1.17.0; GateControl ≥ 1.280.0, permissions.profile ["firstName", "lastName"],
// docs/feature-user-profile.md of GateControl): when a person adds or edits a mailbox, the sender name and the signature
// are suggested from her first and last name — "Vorname Nachname". Only a suggestion: the person confirms it, the name
// and the signature stay per account, nothing is ever overwritten by itself.
//
// Read in the person's own request (viewer = the person herself: she also sees fields set to "Nur ich"), every time
// GET me is asked — a changed name (hook profileChanged) is in the next answer without anything to drop. Without
// names in the profile, or on an older GateControl (no gc.profile): the display name of the account (gc.users) as the
// sender name, no signature.

const NAME_MAX = 80;

/** Does this GateControl have the user profile? */
function available(gc) {
  return !!(gc && gc.profile && typeof gc.profile.get === 'function');
}

const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '');

/**
 * The suggestion for the person `userId` → { senderName, signature, from: 'profile' | 'account' } — senderName '' when
 * nothing is known, signature null without names in the profile.
 */
async function suggestion(gc, userId, displayName) {
  if (available(gc)) {
    try {
      const p = await gc.profile.get(userId, { viewer: userId });
      const full = p ? [clean(p.firstName), clean(p.lastName)].filter(Boolean).join(' ').slice(0, NAME_MAX).trim() : '';
      if (full) return { senderName: full, signature: full, from: 'profile' };
    } catch (e) {
      // ERR_PROFILE_DENIED (the permission not granted yet) or the host is busy: the display name as before
      gc.log.warn('profile unavailable', (e && e.code) || 'error');
    }
  }
  let name = clean(displayName);
  if (!name) {
    try { const u = await gc.users.get(userId); name = clean(u && u.name); } catch { /* unknown */ }
  }
  return { senderName: name.slice(0, NAME_MAX).trim(), signature: null, from: 'account' };
}

module.exports = { available, suggestion };
