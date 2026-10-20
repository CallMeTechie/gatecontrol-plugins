'use strict';

// The face of a student (1.3.0): a colour, and a picture or initials. Several children must be
// told apart at a glance — on the Schule page, in the portal, on the wall tablet and in the apps.
//
//   * mapped to a GateControl user (students.user_id): that user's favourite colour (gc.users
//     colorHex) and profile picture (avatarUrl, /avatars/…), else the user's initials;
//   * otherwise the student's own colour (students.color): one of GateControl's palette colours,
//     assigned automatically when the student is found — the first one no other student has —
//     and changeable by an administrator in the settings; initials of the display name.

const PALETTE = Object.freeze(['#3B82F6', '#14B8A6', '#22C55E', '#84CC16', '#EAB308', '#F97316', '#EC4899', '#A855F7', '#6366F1', '#64748B']);
const HEX_RE = /^#[0-9A-F]{6}$/;
const AVATAR_RE = /^\/avatars\/[A-Za-z0-9_-]{1,200}\.(?:png|jpe?g|webp)$/;

/** '#3b82f6' → '#3B82F6'; null when not #RRGGBB. */
function hex(v) {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return HEX_RE.test(s) ? s : null;
}

/** A colour an administrator may choose: one of the palette (null otherwise). */
function paletteColor(v) {
  const h = hex(v);
  return h && PALETTE.includes(h) ? h : null;
}

/** One or two letters of a name ("Lena Muster" → "LM", "Noah" → "NO"). */
function initials(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = words.length > 1 ? [Array.from(words[0])[0], Array.from(words[1])[0]] : Array.from(words[0]).slice(0, 2);
  return chars.join('').toUpperCase();
}

/** The first palette colour not in `taken` (a Set of hex); all taken → by `seed`. */
function pick(taken, seed = 0) {
  const free = PALETTE.find((c) => !taken.has(c));
  return free || PALETTE[Math.abs(Number(seed) || 0) % PALETTE.length];
}

/** A gc.users entry → the face fields we use (defensive: anything odd is left out). */
function userFace(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: u.id, name: typeof u.name === 'string' ? u.name : String(u.id), role: u.role,
    colorHex: hex(u.colorHex), avatarUrl: typeof u.avatarUrl === 'string' && AVATAR_RE.test(u.avatarUrl) ? u.avatarUrl : null,
    initials: typeof u.initials === 'string' && u.initials.trim() && Array.from(u.initials.trim()).length <= 3 ? u.initials.trim() : initials(u.name),
  };
}

/**
 * The face of a student: { color, avatarUrl, initials, linked } — `users` a Map id → userFace().
 * linked: the colour (and picture) come from the mapped GateControl user.
 */
function faceOf(student, users) {
  const u = student && student.user_id != null && users ? users.get(student.user_id) : null;
  const own = hex(student && student.color) || PALETTE[Math.abs(Number(student && student.id) || 0) % PALETTE.length];
  if (u) return { color: u.colorHex || own, avatarUrl: u.avatarUrl, initials: u.initials, linked: true };
  return { color: own, avatarUrl: null, initials: initials(student && (student.display || student.name)), linked: false };
}

module.exports = { PALETTE, HEX_RE, AVATAR_RE, hex, paletteColor, initials, pick, userFace, faceOf };
