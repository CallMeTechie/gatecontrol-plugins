'use strict';

// gatecontrol-schule — "Schule": the timetable of WebUntis student and parent accounts in
// GateControl. Cancellations, substitutions and extra lessons as pushes, a week view in the
// portal (also on wall tablets), a Start tile and a display widget per child, an API for the
// apps. WebUntis has no public API for this; see server/untis.js for the protocol used.
//
//   admin API   (the plugin page; administrators only)
//     GET    /status                          accounts with diagnostics, students, users, change log
//     POST   /accounts                        { mode: 'qr', link } | { mode: 'secret', host, school, username, secret }
//                                             | { mode: 'password', host, school, username, password }
//                                             → logs in once, lists the students (own or children)
//     PUT    /accounts/:id                    new credentials (same body), checked by a login
//     DELETE /accounts/:id                    with its credentials, students, lessons and change log
//     POST   /accounts/:id/refresh            fetch now
//     PUT    /students/:id                    { alias, enabled, user_id, recipients, show_on_wall }
//     GET    /changes?limit=                  the change log
//   portal API  (the identified portal viewer, kiosk devices included)
//     GET    /portal/timetable?week=0|1       Mon–Sat of this / next week of the students the viewer sees
//   app API     (the GateControl apps, req.user.app; permissions.app, no app tab of its own)
//     GET    /app/timetable?from=&to=         ≤ 14 days, see README "API"
//     GET    /app/changes?days=7              the change log of the students the caller sees
//
// Credentials: the QR key or the password of an account is a plugin secret
// (gc.settings.setSecret('acct.<id>.secret' | 'acct.<id>.password')): encrypted by the host with
// the server key like a declared secret setting, never sent to the browser, never in the
// database, never logged. setSecret takes any key of the plugin's own ([a-z][a-z0-9_.-]{0,63})
// that is not a declared non-secret setting, so each account gets its own keys.
//
// Requests run with the requesting user's rights: the admin API is reached only by
// administrators and refuses portal and app viewers; the portal and app APIs only answer with
// the students the viewer may see (server/views.js).

const ui = require('./ui');
const store = require('./store');
const config = require('./config');
const untis = require('./untis');
const poll = require('./poll');
const changes = require('./changes');
const views = require('./views');
const clock = require('./clock');
const tz = require('./tz');
const notifyLib = require('./notify');
const texts = require('./texts.json');

const DAY = 86400000;
const APP_MAX_DAYS = 14;
const TICK_BUDGET_MS = 50000;
const MAX_ACCOUNTS = 20;

function t(lang, key, params) { return notifyLib.fmt(texts, lang, key, params); }

// error code → [HTTP status, text key]
const ERRORS = {
  INVALID: [400, 'error.invalid'],
  QR_INVALID: [400, 'error.qr_invalid'],
  HOST_INVALID: [400, 'error.host_invalid'],
  FIELDS_REQUIRED: [400, 'error.fields_required'],
  USERS_INVALID: [400, 'error.users_invalid'],
  DUPLICATE: [409, 'error.duplicate'],
  TOO_MANY: [409, 'error.too_many'],
  NO_STUDENTS: [422, 'error.no_students'],
  LOGIN_FAILED: [502, 'error.login_failed'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
};

function fail(code, extra) { return Object.assign(new Error(code), { code }, extra || {}); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [500, 'error.internal'];
  const json = { ok: false, code: known ? e.code : 'INTERNAL', error: t(lang, key) };
  if (e && e.untis) { json.untis = e.untis; json.error = `${json.error} ${t(lang, 'code.' + e.untis)}`; }
  return { status, json };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function usersById(gc) {
  const m = new Map();
  try { for (const u of await gc.users.list()) m.set(u.id, { id: u.id, name: u.name, role: u.role }); } catch { /* users unavailable */ }
  return m;
}

const codeText = (lang, code) => (code ? t(lang, 'code.' + code) : null);

// ─── Admin ──────────────────────────────────────

/** Account + credentials from a request body → { host, school, username, auth, value } (value: the secret or password). */
function accountInput(body) {
  const mode = body.mode;
  if (mode === 'qr') {
    let q;
    try { q = untis.parseQrLink(body.link); } catch (e) { throw fail(e.code === 'HOST_INVALID' ? 'HOST_INVALID' : 'QR_INVALID'); }
    return { host: q.host, school: q.school, username: q.username, auth: 'secret', value: q.secret };
  }
  if (mode !== 'secret' && mode !== 'password') throw fail('INVALID');
  const school = str(body.school, 120);
  const username = str(body.username, 120);
  const value = mode === 'secret' ? String(body.secret || '').replace(/\s+/g, '').toUpperCase() : (typeof body.password === 'string' ? body.password : '');
  if (!str(body.host, 253) || !school || !username || !value || value.length > 500) throw fail('FIELDS_REQUIRED');
  const host = untis.normalizeHost(body.host);
  if (!host) throw fail('HOST_INVALID');
  if (mode === 'secret') {
    try { require('./totp').base32Decode(value); } catch { throw fail('QR_INVALID'); }
  }
  return { host, school, username, auth: mode === 'secret' ? 'secret' : 'password', value };
}

function accountView(a, students, counts, users, lang) {
  return {
    id: a.id, host: a.host, school: a.school, username: a.username, auth: a.auth,
    person_type: a.person_type, status: a.status, last_error: a.last_error, error_text: codeText(lang, a.last_error), error_count: a.error_count,
    last_attempt_at: a.last_attempt_at, last_success_at: a.last_success_at, last_error_at: a.last_error_at, next_fetch_at: a.next_fetch_at,
    students: students.filter((s) => s.account_id === a.id).map((s) => ({
      id: s.id, person_id: s.person_id, name: s.name, alias: s.alias, display: s.display, klasse: s.klasse,
      enabled: s.enabled, missing: s.missing, show_on_wall: s.show_on_wall, baseline_done: s.baseline_done,
      user: s.user_id != null && users.has(s.user_id) ? users.get(s.user_id) : null, user_id: s.user_id,
      recipients: s.recipients.filter((id) => users.has(id)).map((id) => users.get(id)),
      lesson_count: counts.get(s.id) || 0, last_fetch_at: s.last_fetch_at, last_change_at: s.last_change_at,
      last_error: s.last_error, error_text: codeText(lang, s.last_error),
    })),
  };
}

function changeView(c, studentsById) {
  const s = studentsById.get(c.student_id);
  const d = c.detail || {};
  const out = {
    id: c.id, studentId: c.student_id, student: s ? s.display : null, date: c.date, start: c.t_start, end: c.t_end,
    kind: c.kind, subject: c.subject, detectedAt: c.detected_at, status: c.status, pushed: c.status === 'sent',
  };
  if (c.period != null) out.period = c.period;
  for (const k of ['subjectLong', 'subjectOld', 'teacher', 'teacherOld', 'room', 'roomOld', 'substText', 'info']) if (d[k]) out[k] = d[k];
  return out;
}

async function adminStatus(gc, cfg, lang) {
  const users = await usersById(gc);
  const accounts = await store.listAccounts(gc);
  const students = await store.listStudents(gc);
  const counts = await store.countLessons(gc);
  const byId = new Map(students.map((s) => [s.id, s]));
  const log = await store.listChanges(gc, null, clock.now() - 14 * DAY, 60);
  return {
    ok: true,
    config: {
      timezone: cfg.tz, notify_lang: cfg.lang, poll_minutes: cfg.pollMinutes, notify_days: cfg.notifyDays,
      quiet_from: cfg.quiet ? config.hhmm(cfg.quiet.from) : null, quiet_to: cfg.quiet ? config.hhmm(cfg.quiet.to) : null, problems: cfg.problems,
    },
    accounts: accounts.map((a) => accountView(a, students, counts, users, lang)),
    users: [...users.values()],
    changes: log.map((c) => changeView(c, byId)),
  };
}

function pollResult(r, lang) {
  return { ok: r.ok, code: r.code, error_text: codeText(lang, r.code), students: r.students, changes: r.changes };
}

async function addAccount(gc, body, cfg, lang) {
  const inp = accountInput(body);
  if ((await store.listAccounts(gc)).length >= MAX_ACCOUNTS) throw fail('TOO_MANY');
  if (await store.findAccount(gc, inp.host, inp.school, inp.username)) throw fail('DUPLICATE');
  const now = clock.now();
  const acc = await store.createAccount(gc, inp, now);
  await store.setCred(gc, acc.id, inp.auth, inp.value);
  const r = await poll.pollAccount(gc, acc, cfg, now);
  if (!r.persons.length) {
    // nothing to keep: a failed login, or an account without students (a teacher account)
    await store.deleteAccount(gc, acc.id);
    if (!r.ok) throw fail('LOGIN_FAILED', { untis: r.code || 'failed' });
    throw fail('NO_STUDENTS');
  }
  const students = (await store.listStudents(gc, acc.id)).map((s) => ({ id: s.id, name: s.name }));
  return { status: 201, json: { ok: true, account: { id: acc.id }, students, result: pollResult(r, lang) } };
}

async function updateCredentials(gc, acc, body, cfg, lang) {
  const inp = accountInput(body);
  const other = await store.findAccount(gc, inp.host, inp.school, inp.username);
  if (other && other.id !== acc.id) throw fail('DUPLICATE');
  const oldCred = await store.getCred(gc, acc);
  const old = { host: acc.host, school: acc.school, username: acc.username, auth: acc.auth };
  await gc.db.run('UPDATE accounts SET host = ?, school = ?, username = ?, auth = ? WHERE id = ?', [inp.host, inp.school, inp.username, inp.auth, acc.id]);
  await store.setCred(gc, acc.id, inp.auth, inp.value);
  await store.updateAccount(gc, acc.id, { error_count: 0, next_fetch_at: 0, meta_day: null });
  const now = clock.now();
  const r = await poll.pollAccount(gc, await store.getAccount(gc, acc.id), cfg, now);
  if (!r.ok && !r.persons.length) {
    // the new credentials do not work: back to the old ones
    await gc.db.run('UPDATE accounts SET host = ?, school = ?, username = ?, auth = ? WHERE id = ?', [old.host, old.school, old.username, old.auth, acc.id]);
    if (oldCred) await store.setCred(gc, acc.id, old.auth, oldCred.secret || oldCred.password);
    await store.updateAccount(gc, acc.id, { next_fetch_at: now + 5 * 60000 });
    throw fail('LOGIN_FAILED', { untis: r.code || 'failed' });
  }
  return { json: { ok: true, result: pollResult(r, lang) } };
}

async function studentPatch(gc, body, existing) {
  const out = {};
  if (body.alias !== undefined) {
    if (body.alias !== null && typeof body.alias !== 'string') throw fail('INVALID');
    out.alias = str(body.alias, 40) || null;
  }
  for (const k of ['enabled', 'show_on_wall']) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw fail('INVALID');
    out[k] = body[k];
  }
  const users = (body.user_id !== undefined || body.recipients !== undefined) ? await usersById(gc) : null;
  if (body.user_id !== undefined) {
    if (body.user_id === null) out.user_id = null;
    else {
      const id = posInt(body.user_id);
      if (!id || !users.has(id)) throw fail('USERS_INVALID');
      out.user_id = id;
    }
  }
  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients) || body.recipients.length > 50) throw fail('USERS_INVALID');
    const ids = [...new Set(body.recipients.map(posInt))];
    if (ids.some((id) => !id || !users.has(id))) throw fail('USERS_INVALID');
    out.recipients = ids;
  }
  // switched on again: the next fetch is a new baseline (no pushes about what changed meanwhile)
  if (out.enabled === true && !existing.enabled) out.baseline_done = false;
  return out;
}

async function adminRoute(req, gc, seg, cfg, lang) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c] = seg;

  if (a === 'status' && seg.length === 1 && m === 'GET') return { json: await adminStatus(gc, cfg, lang) };

  if (a === 'accounts') {
    if (seg.length === 1 && m === 'POST') return addAccount(gc, body, cfg, lang);
    const id = posInt(b);
    const acc = id ? await store.getAccount(gc, id) : null;
    if (!acc) throw fail('NOT_FOUND');
    if (seg.length === 2 && m === 'PUT') return updateCredentials(gc, acc, body, cfg, lang);
    if (seg.length === 2 && m === 'DELETE') return { json: { ok: await store.deleteAccount(gc, id) } };
    if (seg.length === 3 && c === 'refresh' && m === 'POST') {
      const r = await poll.pollAccount(gc, acc, cfg, clock.now());
      return { json: { ok: true, result: pollResult(r, lang) } };
    }
    throw fail('NOT_FOUND');
  }

  if (a === 'students' && seg.length === 2 && m === 'PUT') {
    const id = posInt(b);
    const s = id ? await store.getStudent(gc, id) : null;
    if (!s) throw fail('NOT_FOUND');
    const patch = await studentPatch(gc, body, s);
    const updated = await store.updateStudent(gc, id, patch);
    if (patch.enabled === true && !s.enabled) await store.updateAccount(gc, s.account_id, { next_fetch_at: 0 });
    return { json: { ok: true, student: { id: updated.id, enabled: updated.enabled } } };
  }

  if (a === 'changes' && seg.length === 1 && m === 'GET') {
    const limit = Math.min(500, posInt(req.query && req.query.limit) || 100);
    const students = await store.listStudents(gc);
    const log = await store.listChanges(gc, null, clock.now() - 30 * DAY, limit);
    return { json: { ok: true, changes: log.map((x) => changeView(x, new Map(students.map((s) => [s.id, s])))) } };
  }
  throw fail('NOT_FOUND');
}

// ─── Portal and app ─────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function portalRoute(req, gc, seg, cfg) {
  if (req.method !== 'GET' || seg.length !== 2 || seg[1] !== 'timetable') throw fail('NOT_FOUND');
  const week = req.query && String(req.query.week) === '1' ? 1 : 0;
  const now = clock.now();
  const today = tz.localDate(now, cfg.tz);
  const from = tz.addDays(tz.weekStart(today), 7 * week);
  const to = tz.addDays(from, 5);
  const students = await views.visibleStudents(gc, req.user);
  return { json: { ok: true, today, week, from, to, students: await views.timetableOf(gc, students, from, to) } };
}

async function appRoute(req, gc, seg, cfg) {
  if (req.method !== 'GET' || seg.length !== 2) throw fail('NOT_FOUND');
  const q = req.query || {};
  const now = clock.now();
  const students = await views.visibleStudents(gc, req.user);
  if (seg[1] === 'timetable') {
    const today = tz.localDate(now, cfg.tz);
    const from = q.from == null || q.from === '' ? today : String(q.from);
    if (!DATE_RE.test(from) || !tz.parseDate(from)) throw fail('INVALID');
    const to = q.to == null || q.to === '' ? tz.addDays(from, 6) : String(q.to);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || !tz.parseDate(from) || !tz.parseDate(to) || to < from || tz.diffDays(from, to) >= APP_MAX_DAYS) throw fail('INVALID');
    const list = await views.timetableOf(gc, students, from, to);
    const times = students.map((s) => s.last_fetch_at).filter((x) => x != null);
    return { json: { ok: true, updatedAt: times.length ? Math.max(...times) : null, students: list.map(({ updatedAt, ...s }) => s) } };
  }
  if (seg[1] === 'changes') {
    const days = q.days == null || q.days === '' ? 7 : posInt(q.days);
    if (!days || days > 30) throw fail('INVALID');
    const byId = new Map(students.map((s) => [s.id, s]));
    const log = await store.listChanges(gc, students.map((s) => s.id), now - days * DAY, 200);
    return { json: { ok: true, changes: log.map((c) => { const v = changeView(c, byId); delete v.status; return v; }) } };
  }
  throw fail('NOT_FOUND');
}

// ─── Module ─────────────────────────────────────

const state = { ticking: false, notifier: null, lastPrune: 0 };

function notifierOf(gc) {
  if (!state.notifier) state.notifier = notifyLib.createNotifier(gc, { now: () => clock.now() });
  return state.notifier;
}

module.exports = {
  async start(gc) {
    state.notifier = notifyLib.createNotifier(gc, { now: () => clock.now() });
    gc.log.info('schule started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req.lang === 'en' ? 'en' : 'de';
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (!seg.length) throw fail('NOT_FOUND');
      const cfg = await config.load(gc);
      if (seg[0] === 'app') {
        if (!req.user || !Number.isInteger(req.user.id) || req.user.app !== true) throw fail('FORBIDDEN');
        return await appRoute(req, gc, seg, cfg);
      }
      if (seg[0] === 'portal') {
        if (!req.user || !Number.isInteger(req.user.id) || req.user.portal !== true) throw fail('FORBIDDEN');
        return await portalRoute(req, gc, seg, cfg);
      }
      if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') throw fail('FORBIDDEN');
      return await adminRoute(req, gc, seg, cfg, lang);
    } catch (e) {
      if (!ERRORS[e && e.code]) gc.log.warn('request failed', req.method, String(req.path || '').split('/').slice(0, 3).join('/'), (e && e.code) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view, t) };
  },

  /** The portal tab only for viewers who may see a student. */
  async portalVisible({ user, section }, gc) {
    if (!user || section) return false;
    return (await views.visibleStudents(gc, user)).length > 0;
  },

  /** Start tab and the apps' start card: one tile per student the viewer sees. */
  async portalTiles({ user, lang }, gc) {
    if (!user) return [];
    const cfg = await config.load(gc);
    const now = clock.now();
    const out = [];
    for (const s of (await views.visibleStudents(gc, user)).slice(0, 8)) out.push(views.tileOf(s, await views.summary(gc, s, cfg, now), lang === 'en' ? 'en' : 'de'));
    return out;
  },

  /** A display widget per student (value: today's cancellations, reading 'tomorrow'). */
  async quickActions({ user, lang }, gc) {
    if (!user) return [];
    const cfg = await config.load(gc);
    const now = clock.now();
    const out = [];
    for (const s of (await views.visibleStudents(gc, user)).slice(0, 16)) out.push(views.quickActionOf(s, await views.summary(gc, s, cfg, now), lang === 'en' ? 'en' : 'de', cfg));
    return out;
  },

  /**
   * Running a student's action shows the current state; a person's tap (not an automation) also
   * asks for a fetch in the next tick (at most every 5 minutes per account).
   */
  async runQuickAction({ user, lang, id, automation }, gc) {
    const l = lang === 'en' ? 'en' : 'de';
    const m = /^student:(\d{1,10})$/.exec(String(id || ''));
    const s = m ? await store.getStudent(gc, Number(m[1])) : null;
    if (!s || !views.canView(s, user)) return { ok: false, message: t(l, 'qa.unknown') };
    const cfg = await config.load(gc);
    const now = clock.now();
    let asked = false;
    if (automation !== true && user.kiosk !== true) {
      const acc = await store.getAccount(gc, s.account_id);
      if (acc) asked = await poll.askRefresh(gc, acc, now);
    }
    const action = views.quickActionOf(s, await views.summary(gc, s, cfg, now), l, cfg);
    return { ok: true, message: views.clip(asked ? t(l, 'qa.refreshing') : action.widget.status, 120), widget: action.widget };
  },

  /**
   * Background (every minute): the due accounts (none started after 50 s), then the pushes;
   * an overlapping run is skipped. Housekeeping once an hour.
   */
  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try {
      const cfg = await config.load(gc);
      const deadline = Date.now() + TICK_BUDGET_MS;
      await poll.tick(gc, cfg, clock.now(), deadline);
      const now = clock.now();
      await changes.dispatch(gc, notifierOf(gc), cfg, now, config.inQuiet(cfg, now));
      if (now - state.lastPrune > 3600000) {
        state.lastPrune = now;
        await store.prune(gc, tz.addDays(tz.localDate(now, cfg.tz), -14), now - 30 * DAY);
      }
    } catch (e) {
      gc.log.warn('tick failed', (e && e.code) || (e && e.message) || 'error');
    } finally { state.ticking = false; }
  },

  /** A shorter interval applies at once. */
  async settingsChanged(values, gc) {
    const cfg = await config.load(gc);
    const now = clock.now();
    for (const a of await store.listAccounts(gc)) {
      if (a.status !== 'error' && a.next_fetch_at > now + cfg.pollMinutes * 60000) await store.updateAccount(gc, a.id, { next_fetch_at: now + cfg.pollMinutes * 60000 });
    }
  },

  _state: state,
};
