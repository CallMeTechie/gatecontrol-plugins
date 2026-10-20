'use strict';

// 1.3.0 — „WebUntis verknüpfen“ in a person's own GateControl profile (portal "Meine Geräte",
// plugin.json ui.portal.profileSections, GateControl ≥ 1.188.0). A person (e.g. Noah) connects his
// own WebUntis *student* account; the student found there is mapped to him — his timetable, his
// pushes, his colour and picture.
//
//   GET    /portal/link            { ok, allowed, students: [{ id, name, klasse, school, color, avatarUrl?, initials, removable, by }] }
//   POST   /portal/link            the access ({ mode: 'qr', link } | 'secret' | 'password', server/input.js)
//   DELETE /portal/link/:studentId undo it
//
// Rules (security):
//   * only the viewer himself: a signed-in portal person (loggedIn, no kiosk device, no app), and
//     only for himself — nobody can map a student to someone else here;
//   * the administrator's setting „Benutzer dürfen ihr WebUntis-Konto selbst verknüpfen“
//     (self_link, default on); administrators may always;
//   * only student accounts (the account is the student): a parent account lists children —
//     an administrator sets that up in the settings;
//   * an account that is already set up (same server, school and user) is not taken over; the
//     administrator can map it in the settings;
//   * the same WebUntis person already known through another account (e.g. the parent account):
//     no second account — the login only proves it is him, the known student is mapped to him
//     (unless it is mapped to someone else) and the new credentials are dropped;
//   * at most 5 attempts per person in 15 minutes (each one logs in to WebUntis);
//   * undoing: an account he connected is deleted with all its data; a known student he mapped
//     himself is unmapped; a mapping made by an administrator stays (only the administrator).
// The key or password is stored like every account's (gc.settings.setSecret), never shown again.

const store = require('./store');
const poll = require('./poll');
const views = require('./views');
const colors = require('./colors');
const clock = require('./clock');
const { fail, accountInput, posInt } = require('./input');

const MAX_ACCOUNTS = 20;
const ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60000;
const attempts = new Map(); // userId → [ms]

/** May this viewer use the profile link at all (a signed-in person in the portal)? */
function isPerson(user) {
  return !!(user && Number.isInteger(user.id) && user.portal === true && user.loggedIn === true && user.kiosk !== true && user.app !== true);
}

function allowed(cfg, user) { return cfg.selfLink === true || (user && user.role === 'admin'); }

function throttle(userId, now) {
  const list = (attempts.get(userId) || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
  if (list.length >= ATTEMPTS) throw fail('TOO_FAST');
  list.push(now);
  attempts.set(userId, list);
}

/** The students mapped to `user`, with how they were mapped. */
async function list(gc, cfg, user) {
  if (!isPerson(user)) throw fail('FORBIDDEN');
  const users = await views.usersMap(gc);
  const accounts = new Map((await store.listAccounts(gc)).map((a) => [a.id, a]));
  const mine = (await store.listStudents(gc)).filter((s) => s.user_id === user.id && !s.missing);
  return {
    ok: true,
    allowed: allowed(cfg, user),
    students: mine.map((s) => {
      const a = accounts.get(s.account_id);
      const f = colors.faceOf(s, users);
      const own = !!(a && a.owner_user_id === user.id);
      return {
        id: s.id, name: s.display, klasse: s.klasse || null, school: a ? a.school : null, enabled: s.enabled,
        color: f.color, ...(f.avatarUrl ? { avatarUrl: f.avatarUrl } : {}), initials: f.initials,
        // 'self': he connected it (his own account, or a known student he linked); 'admin': the settings
        by: own || s.link_source === 'self' ? 'self' : 'admin',
        removable: own || s.link_source === 'self',
        updatedAt: s.last_fetch_at,
      };
    }),
  };
}

/** Connect the viewer's own WebUntis student account. → { status, json } */
async function add(gc, cfg, user, body) {
  if (!isPerson(user)) throw fail('FORBIDDEN');
  if (!allowed(cfg, user)) throw fail('LINK_OFF');
  const inp = accountInput(body);
  const now = clock.now();
  throttle(user.id, now);
  const existing = await store.findAccount(gc, inp.host, inp.school, inp.username);
  if (existing) throw fail(existing.owner_user_id === user.id ? 'LINK_DUPLICATE' : 'LINK_TAKEN');
  if ((await store.listAccounts(gc)).length >= MAX_ACCOUNTS) throw fail('TOO_MANY');
  const acc = await store.createAccount(gc, { ...inp, owner_user_id: user.id }, now);
  await store.setCred(gc, acc.id, inp.auth, inp.value);
  let r;
  try {
    r = await poll.pollAccount(gc, acc, cfg, now);
  } catch (e) {
    await store.deleteAccount(gc, acc.id);
    throw e;
  }
  const fresh = await store.getAccount(gc, acc.id);
  if (!r.persons.length || !fresh) {
    await store.deleteAccount(gc, acc.id);
    if (!r.ok) throw fail('LOGIN_FAILED', { untis: r.code || 'failed' });
    throw fail('NOT_STUDENT');
  }
  // a student account lists exactly the student itself
  if (fresh.person_type !== 5 || r.persons.length !== 1 || r.persons[0].personId !== fresh.person_id) {
    await store.deleteAccount(gc, acc.id);
    throw fail('NOT_STUDENT');
  }
  const personId = r.persons[0].personId;
  const known = (await store.studentsOfPerson(gc, fresh.host, fresh.school, personId)).filter((s) => s.account_id !== acc.id);
  if (known.length) {
    // the same person through another account (e.g. the parents'): map that one, drop the new account
    await store.deleteAccount(gc, acc.id);
    if (known.some((s) => s.user_id != null && s.user_id !== user.id)) throw fail('LINK_CONFLICT');
    for (const s of known) {
      if (s.user_id == null) await store.updateStudent(gc, s.id, { user_id: user.id, link_source: 'self' });
    }
    return { status: 200, json: { ok: true, student: { id: known[0].id, name: known[0].display }, merged: true } };
  }
  const s = (await store.listStudents(gc, acc.id)).find((x) => x.person_id === personId);
  await store.updateStudent(gc, s.id, { user_id: user.id, link_source: 'self' });
  gc.log.info('webuntis account linked in the profile', acc.id, s.id);
  return { status: 201, json: { ok: true, student: { id: s.id, name: s.display }, merged: false } };
}

/** Undo the viewer's own link of a student. */
async function remove(gc, user, idRaw) {
  if (!isPerson(user)) throw fail('FORBIDDEN');
  const id = posInt(idRaw);
  const s = id ? await store.getStudent(gc, id) : null;
  if (!s || s.user_id !== user.id) throw fail('NOT_FOUND');
  const acc = await store.getAccount(gc, s.account_id);
  if (acc && acc.owner_user_id === user.id) {
    await store.deleteAccount(gc, acc.id);
    gc.log.info('webuntis account unlinked in the profile', acc.id);
    return { json: { ok: true, removed: 'account' } };
  }
  if (s.link_source !== 'self') throw fail('LINK_ADMIN');
  await store.updateStudent(gc, s.id, { user_id: null, link_source: null });
  return { json: { ok: true, removed: 'link' } };
}

/** For tests: forget the attempts. */
function reset() { attempts.clear(); }

module.exports = { isPerson, allowed, list, add, remove, reset, ATTEMPTS };
