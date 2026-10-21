'use strict';

// gatecontrol-schule — "Schule": the timetable of WebUntis student and parent accounts in
// GateControl. Cancellations, substitutions and extra lessons as pushes, a week view in the
// portal (also on wall tablets), a Start tile and a display widget per child, an API for the
// apps. WebUntis has no public API for this; see server/untis.js for the protocol used.
//
//   admin API   (administrators only; 1.3.0: the settings page „Konten & Kinder“ — plugin.json
//               ui.settingsPage, shown in Einstellungen › Plugins › Schule › Einstellungen — and the
//               Schule page, which only shows the information)
//     GET    /overview?week=0|1               1.3.0: the Schule page — per student its face, the week,
//                                             the coming changes, exams and homework (views.overview)
//     GET    /status                          accounts with diagnostics, students, users, change log
//     POST   /accounts                        { mode: 'qr', link } | { mode: 'secret', host, school, username, secret }
//                                             | { mode: 'password', host, school, username, password }
//                                             → logs in once, lists the students (own or children)
//     PUT    /accounts/:id                    new credentials (same body), checked by a login
//     DELETE /accounts/:id                    with its credentials, students, lessons and change log
//     POST   /accounts/:id/refresh            fetch now
//     PUT    /students/:id                    { alias, enabled, user_id, recipients, show_on_wall, color (1.3.0) }
//     GET    /changes?limit=                  the change log
//     GET    /qr-decoder                      1.3.0: the QR decoder (ui/vendor/jsqr) for browsers without
//                                             BarcodeDetector — loaded by the frame only when needed
//   portal API  (the identified portal viewer, kiosk devices included)
//     GET    /portal/timetable?week=0|1       Mon–Sat of this / next week of the students the viewer sees
//     GET    /portal/overview?week=0|1        1.3.0: like /overview, for the students the viewer sees
//     GET|POST /portal/link, DELETE /portal/link/:studentId
//                                             1.3.0: the viewer links his own WebUntis student account in
//                                             his profile (server/link.js; signed in, no kiosk)
//     GET    /portal/qr-decoder               1.3.0: as /qr-decoder
//   services    (1.1.0, server/ruleevents.js) school_students for gatecontrol-familie; after each cycle the
//               released changes go to Familie's rule_event (its trigger „Stunde fällt aus“)
//               (1.2.0) school_day for Familie's wall tablet; early ends of a school day go to Familie's
//               school_day_end (server/dayend.js)
//   1.2.0       homework and exams (server/extras.js) in the timetable, the portal, the admin page and the
//               evening reminders (topics exams / homework, server/remind.js)
//   1.3.0       a colour (and picture) per student (server/colors.js) everywhere; settingsStatus (status
//               lines of the settings form); the profile section „WebUntis verknüpfen“
//   1.4.0       school messages (the inbox of each account, server/messages.js) and absences (server/absences.js):
//               fetched in the cycle, pushed (topics messages / absences), on the Schule page and the portal
//               (per child „Nachrichten“ and „Fehlzeiten“), their state in words in the settings (school_info)
//   app API     (the GateControl apps, req.user.app; permissions.app, no app tab of its own)
//     GET    /app/timetable?from=&to=         ≤ 14 days, see README "API"
//     GET    /app/changes?days=7              the change log of the students the caller sees
//     GET    /app/messages?days=30            1.4.0: the school messages the caller may read (1…90 days, ≤ 100)
//     GET    /app/absences?days=60            1.4.0: the absences of the students the caller may see them of (1…180 days, ≤ 200)
//     POST   /app/messages/<id>/read          1.5.0: the caller opened the message (its "new" mark goes)
//     POST   /app/messages/<id>/confirm       1.5.0: send the read confirmation the sender asked for (WebUntis)
//     POST   /app/messages/<id>/attachments/<attId>  1.5.0: the attachment in the media store → { file: { mediaId, name, mime, bytes } }
//               (the apps load it from GET /api/v1/client/plugins/gatecontrol-schule/media/<mediaId>)
//   1.5.0       the same three actions under portal/messages/… and messages/… (admin page) — pages get the
//               attachment as `url` (a /plugin-media/ link); hook mediaAccess: who may read an attachment
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
const ruleevents = require('./ruleevents');
const dayend = require('./dayend');
const remind = require('./remind');
const link = require('./link');
const colors = require('./colors');
const messages = require('./messages');
const absences = require('./absences');
const { fail, str, accountInput, posInt } = require('./input');
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
  // 1.3.0: the profile link (server/link.js)
  NOT_STUDENT: [422, 'error.not_student'],
  LINK_OFF: [403, 'error.link_off'],
  LINK_TAKEN: [409, 'error.link_taken'],
  LINK_DUPLICATE: [409, 'error.link_duplicate'],
  LINK_CONFLICT: [409, 'error.link_conflict'],
  LINK_ADMIN: [403, 'error.link_admin'],
  TOO_FAST: [429, 'error.too_fast'],
  COLOR_INVALID: [400, 'error.color_invalid'],
  // 1.5.0: messages without WebUntis (server/messages.js)
  SCHULE_MESSAGE_NOT_FOUND: [404, 'error.message_not_found'],
  SCHULE_CONFIRM_NOT_REQUIRED: [409, 'error.confirm_not_required'],
  SCHULE_CONFIRM_FAILED: [502, 'error.confirm_failed'],
  SCHULE_UNTIS_UNAVAILABLE: [503, 'error.untis_unavailable'],
  SCHULE_ATTACHMENT_NOT_FOUND: [404, 'error.attachment_not_found'],
  SCHULE_ATTACHMENT_TOO_LARGE: [413, 'error.attachment_too_large'],
  SCHULE_ATTACHMENT_TYPE: [415, 'error.attachment_type'],
  SCHULE_ATTACHMENT_FAILED: [502, 'error.attachment_failed'],
  SCHULE_GATECONTROL_TOO_OLD: [501, 'error.gatecontrol_too_old'],
};

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [500, 'error.internal'];
  const json = { ok: false, code: known ? e.code : 'INTERNAL', error: t(lang, key) };
  if (e && e.untis) { json.untis = e.untis; json.error = `${json.error} ${t(lang, 'code.' + e.untis)}`; }
  return { status, json };
}

const usersById = (gc) => views.usersMap(gc);

const codeText = (lang, code) => (code ? t(lang, 'code.' + code) : null);

/** "21.10. 01:50" / "21/10 01:50" in the plugin's time zone. */
function whenText(ms, cfg, lang) {
  if (!Number.isFinite(ms)) return '–';
  const p = tz.parts(ms, cfg.tz);
  return lang === 'en' ? `${tz.pad(p.d)}/${tz.pad(p.m)} ${tz.pad(p.hh)}:${tz.pad(p.mm)}` : `${tz.pad(p.d)}.${tz.pad(p.m)}. ${tz.pad(p.hh)}:${tz.pad(p.mm)}`;
}

// ─── Admin ──────────────────────────────────────

const extraView = (x) => (x && typeof x === 'object' && Number(x.until) > clock.now() ? { code: String(x.code || 'failed'), until: Number(x.until) } : null);

/**
 * 1.3.0: the optional data of an account in plain words — never a code. Not shared with the account
 * (no_right / unsupported; 1.2.0 stored 'auth' for that) → a calm info line; another error → when it
 * is tried again. → [{ kind: 'exams'|'homework', tone: 'info'|'warn', text }]
 */
function extrasInfo(a, cfg, lang) {
  const out = [];
  for (const kind of ['exams', 'homework']) {
    const x = extraView(a.extras && a.extras[kind]);
    if (!x) continue;
    const unshared = ['no_right', 'unsupported', 'auth'].includes(x.code);
    out.push({ kind, tone: unshared ? 'info' : 'warn', text: t(lang, `extras.${kind}_${unshared ? 'unshared' : 'failed'}`, { when: whenText(x.until, cfg, lang) }) });
  }
  return out;
}

/**
 * 1.4.0: the state of the messages and the absences of an account in plain words — always both lines:
 * read (when, how many), not read yet, not shared / not offered by WebUntis (asked again after a day),
 * or failed (when it is tried again). → [{ kind: 'messages'|'absences', tone: 'good'|'info'|'warn', text }]
 */
function schoolInfo(a, students, counts, cfg, lang) {
  const out = [];
  const mine = students.filter((s) => s.account_id === a.id && s.enabled && !s.missing);
  const absAt = mine.map((s) => s.absences_at).filter((x) => x != null);
  const state = {
    messages: { at: a.messages_at, n: counts.messages.get(a.id) || 0 },
    absences: { at: absAt.length ? Math.max(...absAt) : null, n: mine.reduce((sum, s) => sum + (counts.absences.get(s.id) || 0), 0) },
  };
  for (const kind of ['messages', 'absences']) {
    const p = kind === 'messages' ? 'school.msg' : 'school.abs';
    const x = extraView(a.extras && a.extras[kind]);
    if (x) {
      const unshared = ['no_right', 'auth'].includes(x.code);
      const key = unshared ? `${p}_unshared` : (x.code === 'unsupported' ? `${p}_unsupported` : `${p}_failed`);
      out.push({ kind, tone: x.code === 'failed' ? 'warn' : 'info', text: t(lang, key, { when: whenText(x.until, cfg, lang) }) });
    } else if (state[kind].at != null) {
      out.push({ kind, tone: 'good', text: t(lang, `${p}_ok`, { when: whenText(state[kind].at, cfg, lang), n: state[kind].n }) });
    } else out.push({ kind, tone: 'info', text: t(lang, `${p}_never`) });
  }
  return out;
}

/** A GateControl user as the settings page shows it (name, picture or initials on the colour). */
const personView = (u) => (u ? { id: u.id, name: u.name, role: u.role, avatarUrl: u.avatarUrl, colorHex: u.colorHex, initials: u.initials } : null);

function accountView(a, students, counts, users, lang, cfg, school) {
  return {
    id: a.id, host: a.host, school: a.school, username: a.username, auth: a.auth,
    person_type: a.person_type, status: a.status, last_error: a.last_error, error_text: codeText(lang, a.last_error), error_count: a.error_count,
    last_attempt_at: a.last_attempt_at, last_success_at: a.last_success_at, last_error_at: a.last_error_at, next_fetch_at: a.next_fetch_at,
    // 1.2.0: an optional endpoint left alone after an error ({ code, until } | null)
    extras: { homework: extraView(a.extras && a.extras.homework), exams: extraView(a.extras && a.extras.exams) },
    // 1.3.0: the same in plain words, and who connected the account in the profile (null = an administrator)
    extras_info: extrasInfo(a, cfg, lang),
    // 1.4.0: messages and absences in plain words (always both)
    school_info: school ? schoolInfo(a, students, school, cfg, lang) : [],
    owner: a.owner_user_id != null ? personView(users.get(a.owner_user_id)) || { id: a.owner_user_id, name: '#' + a.owner_user_id } : null,
    students: students.filter((s) => s.account_id === a.id).map((s) => {
      const f = colors.faceOf(s, users);
      return {
        id: s.id, person_id: s.person_id, name: s.name, alias: s.alias, display: s.display, klasse: s.klasse,
        enabled: s.enabled, missing: s.missing, show_on_wall: s.show_on_wall, baseline_done: s.baseline_done,
        user: s.user_id != null && users.has(s.user_id) ? personView(users.get(s.user_id)) : null, user_id: s.user_id,
        recipients: s.recipients.filter((id) => users.has(id)).map((id) => personView(users.get(id))),
        lesson_count: counts.get(s.id) || 0, last_fetch_at: s.last_fetch_at, last_change_at: s.last_change_at,
        last_error: s.last_error, error_text: codeText(lang, s.last_error),
        // 1.3.0: the face (colour from the user when linked), the own colour, who linked
        color: f.color, own_color: s.color, avatarUrl: f.avatarUrl, initials: f.initials, color_from_user: f.linked, link_source: s.link_source,
      };
    }),
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
  const school = { messages: await store.countMessages(gc), absences: await store.countAbsences(gc) };
  return {
    ok: true,
    config: {
      timezone: cfg.tz, notify_lang: cfg.lang, poll_minutes: cfg.pollMinutes, notify_days: cfg.notifyDays,
      quiet_from: cfg.quiet ? config.hhmm(cfg.quiet.from) : null, quiet_to: cfg.quiet ? config.hhmm(cfg.quiet.to) : null, problems: cfg.problems,
      reminder_time: cfg.reminder ? config.hhmm(cfg.reminder) : null,
    },
    accounts: accounts.map((a) => accountView(a, students, counts, users, lang, cfg, school)),
    users: [...users.values()].map(personView),
    // 1.3.0: the colours a student may get, and whether people may link their own account in the profile
    palette: colors.PALETTE, self_link: cfg.selfLink,
    changes: log.map((c) => changeView(c, byId)),
    // 1.1.0: the Familie plugin's rules — reachable, and the last rule_event call
    rules: await ruleevents.status(gc),
    // 1.2.0: early ends for Familie's rides — reachable, and the last school_day_end call
    dayEnds: await dayend.status(gc),
    // 1.2.0: exams and homework of the next 14 days
    upcoming: await upcoming(gc, cfg, byId),
  };
}

/** 1.2.0: the exams and the homework (by due date) of the next 14 days, for the admin page. */
async function upcoming(gc, cfg, byId) {
  const today = tz.localDate(clock.now(), cfg.tz);
  const ids = [...byId.keys()];
  const to = tz.addDays(today, 13);
  const name = (sid) => (byId.get(sid) ? byId.get(sid).display : null);
  return {
    exams: (await store.examsBetween(gc, ids, today, to)).slice(0, 60).map((x) => ({ studentId: x.student_id, student: name(x.student_id), date: x.date, ...views.examView(x) })),
    homework: (await store.homeworkDue(gc, ids, today, to)).slice(0, 100).map((h) => ({ studentId: h.student_id, student: name(h.student_id), date: h.due_date, ...views.homeworkView(h) })),
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
  // 1.4.0: perhaps another person's inbox now — its first fetch is a new baseline (no pushes)
  await store.updateAccount(gc, acc.id, { error_count: 0, next_fetch_at: 0, meta_day: null, messages_at: null });
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
    // 1.3.0: a mapping changed here is the administrator's
    if (out.user_id !== existing.user_id) out.link_source = out.user_id == null ? null : 'admin';
  }
  if (body.color !== undefined) {
    // 1.3.0: one of the palette; null = a colour picked automatically (distinct from the others)
    if (body.color === null) {
      const taken = await store.takenColors(gc);
      taken.delete(existing.color);
      out.color = colors.pick(taken, existing.id);
    } else {
      const c = colors.paletteColor(body.color);
      if (!c) throw fail('COLOR_INVALID');
      out.color = c;
    }
  }
  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients) || body.recipients.length > 50) throw fail('USERS_INVALID');
    const ids = [...new Set(body.recipients.map(posInt))];
    if (ids.some((id) => !id || !users.has(id))) throw fail('USERS_INVALID');
    out.recipients = ids;
  }
  // switched on again: the next fetch is a new baseline (no pushes about what changed meanwhile)
  if (out.enabled === true && !existing.enabled) { out.baseline_done = false; out.absences_at = null; }
  return out;
}

async function adminRoute(req, gc, seg, cfg, lang) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c] = seg;

  if (a === 'status' && seg.length === 1 && m === 'GET') return { json: await adminStatus(gc, cfg, lang) };
  // 1.5.0: open, confirm, attachments of a school message (the Schule page)
  const act = await messageAction(req, gc, seg, { urls: true });
  if (act) return act;
  if (a === 'overview' && seg.length === 1 && m === 'GET') {
    const students = (await store.listStudents(gc)).filter((s) => s.enabled && !s.missing);
    const accounts = await store.listAccounts(gc);
    const week = req.query && String(req.query.week) === '1' ? 1 : 0;
    return { json: { ok: true, configured: accounts.length > 0, accountErrors: accounts.filter((x) => x.status === 'error').length, ...(await overviewOf(gc, cfg, students, week, req.user)) } };
  }
  if (a === 'qr-decoder' && seg.length === 1 && m === 'GET') return { json: { ok: true, js: ui.qrDecoder() } };

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
    return { json: { ok: true, student: { id: updated.id, enabled: updated.enabled, color: updated.color } } };
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

/**
 * 1.5.0: POST messages/<id>/read | confirm | attachments/<attId> (app, portal, admin page; `seg` from
 * "messages" on). Pages (urls) get the attachment's /plugin-media/ link. → null when not such a path.
 */
async function messageAction(req, gc, seg, { urls }) {
  if (seg[0] !== 'messages' || req.method !== 'POST' || seg.length < 3) return null;
  const now = clock.now();
  const id = seg[1];
  if (seg.length === 3 && seg[2] === 'read') return { json: { ok: true, message: await messages.markRead(gc, req.user, id, now, { urls }) } };
  if (seg.length === 3 && seg[2] === 'confirm') return { json: { ok: true, message: await messages.confirm(gc, req.user, id, now, { urls }) } };
  if (seg.length === 4 && seg[2] === 'attachments') return { json: { ok: true, file: await messages.attachment(gc, req.user, id, seg[3], now, { urls }) } };
  return null;
}

/**
 * The Schule page / portal tab (views.overview) — 1.4.0: per student `messages` (its account's inbox,
 * only when `user` may read it) and `absences` (only when `user` may see them); left out otherwise.
 */
async function overviewOf(gc, cfg, students, week, user) {
  const now = clock.now();
  const ov = await views.overview(gc, cfg, students, week, now);
  const msgs = await messages.forStudents(gc, user, students, now, { urls: true });
  const abs = await absences.forStudents(gc, user, students, cfg, now);
  for (const s of ov.students) {
    if (msgs.has(s.id)) s.messages = msgs.get(s.id);
    if (abs.has(s.id)) s.absences = abs.get(s.id);
  }
  return ov;
}

/** ?days= → an integer 1…max (default `d`); INVALID otherwise. */
function daysOf(q, d, max) {
  const days = q.days == null || q.days === '' ? d : posInt(q.days);
  if (!days || days > max) throw fail('INVALID');
  return days;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function portalRoute(req, gc, seg, cfg) {
  // 1.5.0: open, confirm, attachments of a school message
  const act = await messageAction(req, gc, seg.slice(1), { urls: true });
  if (act) return act;
  // 1.3.0: the viewer's own WebUntis link (profile section, server/link.js)
  if (seg[1] === 'link') {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (seg.length === 2 && req.method === 'GET') return { json: await link.list(gc, cfg, req.user) };
    if (seg.length === 2 && req.method === 'POST') return link.add(gc, cfg, req.user, body);
    if (seg.length === 3 && req.method === 'DELETE') return link.remove(gc, req.user, seg[2]);
    throw fail('NOT_FOUND');
  }
  if (req.method !== 'GET' || seg.length !== 2) throw fail('NOT_FOUND');
  if (seg[1] === 'qr-decoder') {
    if (!link.isPerson(req.user)) throw fail('FORBIDDEN');
    return { json: { ok: true, js: ui.qrDecoder() } };
  }
  if (seg[1] === 'overview') {
    const week = req.query && String(req.query.week) === '1' ? 1 : 0;
    const students = await views.visibleStudents(gc, req.user);
    return { json: { ok: true, configured: students.length > 0, ...(await overviewOf(gc, cfg, students, week, req.user)) } };
  }
  if (seg[1] !== 'timetable') throw fail('NOT_FOUND');
  const week = req.query && String(req.query.week) === '1' ? 1 : 0;
  const now = clock.now();
  const today = tz.localDate(now, cfg.tz);
  const from = tz.addDays(tz.weekStart(today), 7 * week);
  const to = tz.addDays(from, 5);
  const students = await views.visibleStudents(gc, req.user);
  return { json: { ok: true, today, week, from, to, students: await views.timetableOf(gc, students, from, to) } };
}

async function appRoute(req, gc, seg, cfg) {
  // 1.5.0: open, confirm, attachments of a school message
  const act = await messageAction(req, gc, seg.slice(1), { urls: false });
  if (act) return act;
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
  // 1.4.0: school messages and absences
  if (seg[1] === 'messages') return { json: { ok: true, messages: await messages.listFor(gc, req.user, daysOf(q, 30, 90), now) } };
  if (seg[1] === 'absences') return { json: { ok: true, absences: await absences.listFor(gc, req.user, daysOf(q, 60, 180), cfg, now) } };
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
    // 1.3.0: a colour for the students of 1.2.0; exams / homework that 1.2.0 paused as 'auth' (a
    // parent account refused one way of asking — not a login problem) are tried again at once
    try {
      await store.ensureColors(gc);
      for (const a of await store.listAccounts(gc)) {
        const x = a.extras || {};
        const stale = ['exams', 'homework'].filter((k) => x[k] && x[k].code === 'auth');
        if (!stale.length) continue;
        const next = { ...x };
        for (const k of stale) delete next[k];
        await store.updateAccount(gc, a.id, { extras: next });
      }
    } catch (e) { gc.log.warn('start housekeeping failed', (e && (e.code || e.message)) || 'error'); }
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

  /**
   * The portal tab only for viewers who may see a student; 1.3.0: the profile section „WebUntis
   * verknüpfen“ for a signed-in person while self-linking is allowed or he has a link to undo.
   */
  async portalVisible({ user, section }, gc) {
    if (!user) return false;
    if (section === ui.PROFILE_SECTION) {
      if (!link.isPerson(user)) return false;
      const cfg = await config.load(gc);
      if (link.allowed(cfg, user)) return true;
      return (await store.listStudents(gc)).some((s) => s.user_id === user.id);
    }
    if (section) return false;
    return (await views.visibleStudents(gc, user)).length > 0;
  },

  /**
   * 1.3.0 (GateControl ≥ 1.185.0): status lines of the settings form — how many accounts and
   * children, accounts with a problem (in words), invalid settings.
   */
  async settingsStatus({ lang }, gc) {
    const l = lang === 'en' ? 'en' : 'de';
    const cfg = await config.load(gc);
    const out = [];
    const accounts = await store.listAccounts(gc);
    const students = (await store.listStudents(gc)).filter((s) => !s.missing);
    if (!accounts.length) out.push({ group: null, tone: 'info', text: t(l, 'status.none') });
    else {
      const bad = accounts.filter((a) => a.status === 'error');
      out.push({ group: null, tone: bad.length ? 'warn' : 'ok', text: t(l, 'status.summary', { accounts: accounts.length, students: students.filter((s) => s.enabled).length }) });
      for (const a of bad.slice(0, 5)) out.push({ group: null, tone: 'warn', text: views.clip(`${a.school} · ${a.username}: ${codeText(l, a.last_error) || ''}`, 200) });
    }
    for (const p of cfg.problems.slice(0, 3)) out.push({ group: null, tone: 'warn', text: views.clip(t(l, 'problem.' + p), 200) });
    return out.slice(0, 10);
  },

  /** Start tab and the apps' start card: one tile per student the viewer sees. */
  async portalTiles({ user, lang }, gc) {
    if (!user) return [];
    const cfg = await config.load(gc);
    const now = clock.now();
    const out = [];
    const students = (await views.visibleStudents(gc, user)).slice(0, 8);
    // 1.4.0: new school messages of the student's inbox (only when the viewer may read it)
    const msgs = students.length ? await messages.forStudents(gc, user, students, now) : new Map();
    for (const s of students) {
      const sum = await views.summary(gc, s, cfg, now);
      sum.newMessages = (msgs.get(s.id) || []).filter((m) => m.isNew);
      out.push(views.tileOf(s, sum, lang === 'en' ? 'en' : 'de'));
    }
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
      const quiet = config.inQuiet(cfg, now);
      const d = await changes.dispatch(gc, notifierOf(gc), cfg, now, quiet);
      // 1.1.0: the same changes to the Familie plugin's rules (one call; never throws)
      if (d && d.events && d.events.length) await ruleevents.send(gc, cfg, now, d.events);
      // 1.2.0: early ends of a school day to Familie's rides (never throws); the evening reminders
      await dayend.send(gc, cfg, now, quiet);
      try { await remind.tick(gc, notifierOf(gc), cfg, now, quiet); } catch (e) { gc.log.warn('reminders failed', (e && (e.code || e.message)) || 'error'); }
      // 1.4.0: new school messages and new / changed absences
      try { await messages.dispatch(gc, notifierOf(gc), cfg, now, quiet); } catch (e) { gc.log.warn('message pushes failed', (e && (e.code || e.message)) || 'error'); }
      try { await absences.dispatch(gc, notifierOf(gc), cfg, now, quiet); } catch (e) { gc.log.warn('absence pushes failed', (e && (e.code || e.message)) || 'error'); }
      if (now - state.lastPrune > 3600000) {
        state.lastPrune = now;
        await store.prune(gc, tz.addDays(tz.localDate(now, cfg.tz), -14), now - 30 * DAY);
        const media = await store.pruneSchool(gc, now - messages.KEEP_MS, absences.keepFrom(now, cfg));
        // 1.5.0: the attachments of pruned messages
        for (const id of media || []) { try { await gc.media.delete(id); } catch { /* gone */ } }
      }
    } catch (e) {
      gc.log.warn('tick failed', (e && e.code) || (e && e.message) || 'error');
    } finally { state.ticking = false; }
  },

  /** 1.5.0: an attachment (media store) only for the people who may read its message's inbox. */
  async mediaAccess({ user, mediaId }, gc) {
    try { return await messages.mayReadMedia(gc, user, mediaId); } catch { return false; }
  },

  /** 1.1.0: services.provides — school_students (1.2.0: school_day) for the Familie plugin (server/ruleevents.js). */
  async service(call, gc) {
    return ruleevents.handle(gc, call);
  },

  /** A shorter interval applies at once. */
  async settingsChanged(values, gc) {
    await store.ensureColors(gc);
    const cfg = await config.load(gc);
    const now = clock.now();
    for (const a of await store.listAccounts(gc)) {
      if (a.status !== 'error' && a.next_fetch_at > now + cfg.pollMinutes * 60000) await store.updateAccount(gc, a.id, { next_fetch_at: now + cfg.pollMinutes * 60000 });
    }
  },

  _state: state,
};
