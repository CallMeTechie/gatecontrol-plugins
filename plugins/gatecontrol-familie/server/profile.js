'use strict';

// The birthday from the user profile (1.26.0; GateControl ≥ 1.280.0, permissions.profile ["birthday"],
// docs/feature-user-profile.md of GateControl).
//
// Adults – the profile leads: a parent's birthday is the one in the person's own profile ("Mein Profil"), as far as
// the viewer may see it (gc.profile.get(member, { viewer })). The admin page shows it read-only („aus dem Profil“).
// Children – the parents keep it in Familie (members.birthdate) as before: the age decides about locating, a child
// does not change it itself.
//
// Taken over once: when members.birthdate of a parent is empty and the profile has a birthday with its year, Familie
// stores it (members.birthdate_profile = 1) – only when somebody else sees it (another member's request, or the
// background, which sees what everybody sees): then the person shares it at least with the family, not only with herself. The copy serves the background (reminders), which reads the
// profile without a viewer (what everybody sees). If the person later removes the birthday from her profile, the copy
// goes too. A birthday without its year (hidden) shows day and month, no age.
//
// An older GateControl has no gc.profile: everything as before (members.birthdate, editable on the admin page).
// The hook profileChanged ({ userId, fields }) with "birthday" drops the cached view of that person.

const store = require('./store');
const tz = require('./tz');

const CACHE_MS = 10 * 60000;
const cache = new Map(); // `${userId}:${viewer || 0}` → { at, value }

/** Does this GateControl have the user profile? */
function available(gc) {
  return !!(gc && gc.profile && typeof gc.profile.get === 'function');
}

/** The cached views of a person go (hook profileChanged); without an id every one. */
function forget(userId) {
  if (userId == null) { cache.clear(); return; }
  for (const k of [...cache.keys()]) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

/**
 * The birthday of the profile as `viewer` sees it → { visible: false } (hidden from this viewer, unknown account or
 * no answer) or { visible: true, birthday: { month, day, year } | null }.
 */
async function birthdayOf(gc, userId, viewer, now = Date.now()) {
  const key = `${userId}:${viewer || 0}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let value = { visible: false };
  try {
    const p = await gc.profile.get(userId, viewer ? { viewer } : undefined);
    if (p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, 'birthday')) {
      const b = p.birthday;
      const month = b && Number.isInteger(b.month) && b.month >= 1 && b.month <= 12 ? b.month : null;
      const day = b && Number.isInteger(b.day) && b.day >= 1 && b.day <= 31 ? b.day : null;
      const year = b && Number.isInteger(b.year) && b.year >= 1900 && b.year <= 9999 ? b.year : null;
      value = { visible: true, birthday: month && day ? { month, day, year } : null };
    }
  } catch (e) {
    // ERR_PROFILE_DENIED (the administrator has not granted the permission yet) or the host is busy: as before
    gc.log.warn('profile unavailable', (e && e.code) || 'error');
    return { visible: false };
  }
  cache.set(key, { at: now, value });
  return value;
}

/**
 * The parents of `fam` (members.load) with the birthday of their profile, as `viewer` sees it. Changes the member
 * objects in place: birthdate (YYYY-MM-DD or null), birthday { month, day, year } | null, birthdaySource
 * ('profile' | 'family'), age. Children and wall tablets stay as they are (birthdaySource 'family').
 */
async function apply(gc, fam, viewer) {
  const on = available(gc);
  for (const m of fam.all) {
    m.birthdaySource = 'family';
    if (!on || m.role !== 'parent') continue;
    m.birthdaySource = 'profile';
    const r = await birthdayOf(gc, m.userId, viewer);
    if (!r.visible) continue; // hidden from this viewer: what Familie took over (if anything)
    const b = r.birthday;
    if (!b) {
      // the person has none (any more): a copy taken over from the profile goes, one the parents entered stays
      if (m.birthdateFromProfile) {
        await store.run(gc, 'UPDATE members SET birthdate = NULL, birthdate_profile = 0 WHERE user_id = ? AND birthdate_profile = 1', [m.userId]);
        setDate(m, null, fam.today);
      }
      continue;
    }
    const full = b.year != null ? tz.dateStr(b.year, b.month, b.day) : null;
    if (full && full > fam.today) continue; // a date in the future: not a birthday
    if (full) {
      if (!m.storedBirthdate && viewer !== m.userId) {
        // taken over once: seen by somebody else (or by everybody), so the person shares it at least with the family
        await store.run(gc, 'UPDATE members SET birthdate = ?, birthdate_profile = 1 WHERE user_id = ? AND birthdate IS NULL', [full, m.userId]);
        m.storedBirthdate = full;
        m.birthdateFromProfile = true;
      }
      setDate(m, full, fam.today);
    } else {
      m.birthdate = null;
      m.birthday = { month: b.month, day: b.day, year: null };
      m.age = null;
    }
  }
  return fam;
}

function setDate(m, full, today) {
  const { age } = require('./members');
  m.birthdate = full;
  const p = full ? tz.parseDate(full) : null;
  m.birthday = p ? { month: p.m, day: p.d, year: p.y } : null;
  m.age = full ? age(full, today) : null;
}

/** The date a yearly birthday event starts from: the birth date, or for day and month only a leap year long ago. */
function eventDate(m) {
  if (m.birthdate) return m.birthdate;
  if (m.birthday && m.birthday.year == null) return tz.dateStr(1904, m.birthday.month, m.birthday.day);
  return null;
}

module.exports = { available, forget, birthdayOf, apply, eventDate, CACHE_MS };
