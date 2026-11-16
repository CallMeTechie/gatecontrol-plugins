'use strict';

// „Wer sieht dein Bild?“ for the mock host (tools/testing/mock-host.js): GateControl's visibility.avatar of the user
// profile (src/services/avatars.js, hostApi.js 'users.*', the child bootstrap; docs/feature-avatars.md, docs/plugins.md).
// Opt-in: opts.avatarVisibility or opts.gatecontrol ≥ '1.289.0'. An older GateControl: gc.users as before (no
// avatarVisibility, no setAvatarVisibility / adoptAvatarVisibility — feature detection).
//
//   createHost(dir, { avatarVisibility: {
//     levels: { 2: 'contacts', 3: 'self' },   // chosen levels (all | contacts | family | self); missing = not chosen = all
//     families: [[2, 3, 4]],                  // accounts in one GateControl group of the kind "Familie"
//   } })                                      // (families default to opts.profile.families)
//
// Like the host:
//   gc.users.list({ viewer?, unmasked? }) / get(id, { viewer?, unmasked? })  every entry with avatarVisibility; avatarUrl
//       null when the viewer may not see the picture ('contacts' counts as 'family'), without a viewer only 'all'; the
//       viewer counts only while that person has a request to this plugin in flight. unmasked: every picture.
//   gc.users.setAvatarVisibility(userId, level) → { level }   only for the person of a changing request in flight
//       (else ERR_FORBIDDEN)
//   gc.users.adoptAvatarVisibility(userId, level) → { adopted, level }   only contacts / family / self, only while nothing
//       is chosen
//   host.avatarVisibility.level(userId)       the level now
//   host.avatarVisibility.set(userId, level)  the person changes it in her profile (no hook by itself)
//   host.avatarVisibility.calls               [{ op: 'set' | 'adopt', userId, level, adopted? }]

const LEVELS = ['all', 'contacts', 'family', 'self'];

function install({ opts, perms, atLeast, hostError, personCtx }) {
  const o = opts.avatarVisibility && typeof opts.avatarVisibility === 'object' ? opts.avatarVisibility : null;
  const on = !!o || atLeast(289);
  const levels = new Map(Object.entries((o && o.levels) || {}).map(([k, v]) => [Number(k), v]));
  const families = ((o && o.families) || (opts.profile && opts.profile.families) || []).map((ids) => new Set(ids));
  const calls = [];
  const sameFamily = (a, b) => families.some((f) => f.has(a) && f.has(b));
  const levelOf = (id) => levels.get(id) || 'all';
  const needUsers = () => { if (!perms.users) throw hostError('ERR_USERS_DENIED', 'this plugin has no users permission'); };
  const needLevel = (l) => { if (!LEVELS.includes(l)) throw hostError('ERR_INVALID', 'level must be all, contacts, family or self'); };
  const needId = (v) => { const id = Number(v); if (!Number.isSafeInteger(id) || id <= 0) throw hostError('ERR_INVALID', 'invalid user id'); return id; };

  /** The reader of gc.users: (ownerId, level) → shown? — or null (unmasked). */
  function readerOf(a) {
    if (a && a.unmasked === true) return null;
    const v = a && a.viewer != null ? Number(a.viewer) : null;
    if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) throw hostError('ERR_INVALID', 'invalid viewer');
    const viewer = v !== null && personCtx.has(v) ? v : null;
    return (owner, level) => level === 'all' || (viewer != null && (viewer === owner || (level !== 'self' && sameFamily(viewer, owner))));
  }
  /** One gc.users entry as the reader sees it. */
  function view(u, reader) {
    if (!u) return null;
    const level = levelOf(u.id);
    return { ...u, avatarUrl: u.avatarUrl && (!reader || reader(u.id, level)) ? u.avatarUrl : null, avatarVisibility: level };
  }

  const api = {
    'users.setAvatarVisibility': async (a) => {
      needUsers();
      const id = needId(a && a.userId);
      needLevel(a && a.level);
      const e = personCtx.get(id);
      if (!e || !e.write) throw hostError('ERR_FORBIDDEN', 'only for the person of a changing request in flight');
      levels.set(id, a.level);
      calls.push({ op: 'set', userId: id, level: a.level });
      return { level: a.level };
    },
    'users.adoptAvatarVisibility': async (a) => {
      needUsers();
      const id = needId(a && a.userId);
      needLevel(a && a.level);
      const chosen = levels.get(id);
      const adopted = !chosen && a.level !== 'all';
      if (adopted) levels.set(id, a.level);
      calls.push({ op: 'adopt', userId: id, level: a.level, adopted });
      return { adopted, level: levelOf(id) };
    },
  };

  /** gc.users of this host: list / get with the reader, the two calls. */
  function gcPart(call) {
    const args = (x) => ({ viewer: x && x.viewer != null ? x.viewer : null, unmasked: !!(x && x.unmasked === true) });
    return Object.freeze({
      list: (x) => call('users.list', args(x)),
      get: (id, x) => call('users.get', { id, ...args(x) }),
      setAvatarVisibility: (userId, level) => call('users.setAvatarVisibility', { userId, level }),
      adoptAvatarVisibility: (userId, level) => call('users.adoptAvatarVisibility', { userId, level }),
    });
  }

  const control = {
    calls,
    level: (id) => levelOf(id),
    set(id, level) { needLevel(level); levels.set(id, level); },
  };

  return { on, api, gcPart, control, readerOf, view };
}

module.exports = { install, LEVELS };
