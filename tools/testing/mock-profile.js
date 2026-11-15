'use strict';

// gc.profile for the mock host (tools/testing/mock-host.js): the user profile of GateControl
// (src/services/profile.js viewFor, hostApi.js 'profile.get', the child bootstrap; docs/plugins.md, docs/feature-user-profile.md).
// Opt-in: opts.profile or opts.gatecontrol ≥ '1.280.0'. An older GateControl has no gc.profile and ignores the key
// permissions.profile; with the host every plugin has gc.profile, the host answers ERR_PROFILE_DENIED without the permission.
//
//   createHost(dir, { profile: {
//     people: { 2: { firstName: 'Jenny', lastName: 'Backes', about: '…', birthday: '1986-03-14' | '--03-14' | null,
//                    yearHidden: false, visibility: { firstName, lastName, about, birthday: 'self' | 'family' | 'all' },
//                    phones: [{ kind, number, visibility: 'none' | 'family' | 'all', confirmed }] } },
//     families: [[2, 3, 4]],   // accounts in one GateControl group of the kind "Familie"
//   } })
//
// Like the host:
//   gc.profile.get(userId, { viewer? })  → { userId, firstName?, lastName?, about?, birthday?, phones? } | null (unknown or
//                                          disabled account): only the fields of permissions.profile, only what the viewer
//                                          may see (default visibility as GateControl: names and about "all", birthday
//                                          "family"). The viewer counts only while that person has a request to this plugin
//                                          in flight — else the view of somebody without relation. birthday { date, month,
//                                          day, year } (year null and date --MM-DD when hidden); phones only with "phones".
//   host.profile.set(userId, patch)      changes a profile (as the person does in "Mein Profil"); no hook by itself
//   await host.profile.changed(userId, fields)  the hook profileChanged({ userId, fields }) (only with permissions.users;
//                                          "phones" only with permissions.profile "phones") → the fields handed over
//   await host.profile.myData(userId)    the hook myData({ userId }) → { data } (JSON ≤ 256 KB, else ERR_INVALID; null = nothing)
//   host.profile.calls                   [{ userId, viewer, counted }] every gc.profile.get

const FIELDS = ['firstName', 'lastName', 'about', 'birthday', 'phones'];
const DEFAULT_VIS = { firstName: 'all', lastName: 'all', about: 'all', birthday: 'family' };
const DATE_RE = /^(\d{4}|--)-?(\d{2})-(\d{2})$/;
const pad2 = (n) => String(n).padStart(2, '0');

function install({ opts, perms, atLeast, enabledUser, hostError, personCtx, wire }) {
  // the plugin and its hooks, bound once the entry is loaded (control.bind)
  let plugin = {};
  let hook = async () => undefined;
  const o = opts.profile && typeof opts.profile === 'object' ? opts.profile : null;
  const on = !!o || atLeast(280);
  let allowed = [];
  if (on && perms.profile != null) {
    const list = perms.profile;
    if (!Array.isArray(list) || !list.length || !list.every((f) => FIELDS.includes(f)) || new Set(list).size !== list.length) {
      throw hostError('ERR_INVALID', 'plugin.json: permissions.profile: invalid');
    }
    if (perms.users !== true) throw hostError('ERR_INVALID', 'plugin.json: permissions.profile: needs permissions.users');
    allowed = FIELDS.filter((f) => list.includes(f));
  }
  const people = new Map(Object.entries((o && o.people) || {}).map(([k, v]) => [Number(k), { ...v }]));
  const families = ((o && o.families) || []).map((ids) => new Set(ids));
  const calls = [];
  const sameFamily = (a, b) => families.some((f) => f.has(a) && f.has(b));

  function birthdayView(p) {
    const m = DATE_RE.exec(String(p.birthday || ''));
    if (!m) return null;
    const year = m[1] === '--' || p.yearHidden ? null : Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    return { date: year == null ? `--${pad2(month)}-${pad2(day)}` : `${year}-${pad2(month)}-${pad2(day)}`, month, day, year };
  }

  const api = {
    'profile.get': async (args) => {
      if (!allowed.length) throw hostError('ERR_PROFILE_DENIED', 'this plugin has no profile permission');
      const id = Number(args && args.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw hostError('ERR_INVALID', 'invalid user id');
      const v = args && args.viewer != null ? Number(args.viewer) : null;
      if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) throw hostError('ERR_INVALID', 'invalid viewer');
      const counted = v !== null && personCtx.has(v);
      const viewer = counted ? v : null;
      calls.push({ userId: id, viewer: v, counted });
      if (!enabledUser(id)) return null;
      const p = people.get(id) || {};
      const vis = { ...DEFAULT_VIS, ...(p.visibility || {}) };
      const rel = viewer === id ? 'self' : (viewer && sameFamily(viewer, id) ? 'family' : 'other');
      const sees = (level) => level === 'all' || (level === 'family' && rel !== 'other') || (level === 'self' && rel === 'self');
      const out = { userId: id };
      for (const f of ['firstName', 'lastName', 'about']) if (allowed.includes(f) && sees(vis[f])) out[f] = p[f] || null;
      if (allowed.includes('birthday') && sees(vis.birthday)) out.birthday = birthdayView(p);
      if (allowed.includes('phones')) {
        out.phones = (p.phones || []).filter((x) => x.visibility === 'all' || (x.visibility === 'family' && rel !== 'other'))
          .map((x) => ({ kind: x.kind, number: x.number, confirmed: !!x.confirmed }));
      }
      return out;
    },
  };

  const gcPart = (call) => Object.freeze({
    get: (userId, x) => call('profile.get', { id: userId, viewer: x && x.viewer != null ? x.viewer : null }),
  });

  const control = {
    calls,
    bind(p, h) { plugin = p; hook = h; },
    set(userId, patch) { people.set(userId, { ...(people.get(userId) || {}), ...(patch || {}) }); },
    async changed(userId, fields) {
      if (!on || perms.users !== true || typeof plugin.profileChanged !== 'function') return [];
      const list = [...new Set(fields || [])].filter((f) => f !== 'phones' || allowed.includes('phones'));
      if (!list.length) return [];
      await hook('profileChanged', { userId, fields: list });
      return list;
    },
    async myData(userId) {
      if (!on || perms.users !== true || typeof plugin.myData !== 'function') return { data: null };
      const data = (await hook('myData', { userId })) ?? null;
      const s = JSON.stringify(data);
      if (Buffer.byteLength(s, 'utf8') > 256 * 1024) throw hostError('ERR_INVALID', 'myData: more than 256 KB');
      return { data: wire(data) };
    },
  };

  return { on, api, gcPart, control };
}

module.exports = { install };
