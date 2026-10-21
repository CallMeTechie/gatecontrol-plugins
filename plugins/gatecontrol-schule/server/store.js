'use strict';

// Data access of the plugin's own database (migrations/001_init.sql; 1.2.0: 003_homework_exams.sql —
// homework, exams, once-only notices, early ends of a school day; 1.3.0: 004_colors_links.sql — a
// colour per student, links made by people themselves in their profile; 1.4.0: 005_messages_absences.sql —
// the inbox of an account and the absences of a student).
//
// Credentials are plugin secrets, never in this database: the QR key of an
// account under 'acct.<id>.secret', a password under 'acct.<id>.password'
// (gc.settings.setSecret — any key of the plugin's own, stored encrypted with
// the server key like a declared `secret` setting, never sent to the browser,
// re-keyed by backups; docs/plugins.md "Plugin code"). Deleting an account
// deletes them together with its students, lessons and change log.

const colors = require('./colors');

// One transaction at a time over the host's single connection.
let txChain = Promise.resolve();
function tx(gc, fn) {
  const run = async () => {
    await gc.db.exec('BEGIN');
    try {
      const out = await fn();
      await gc.db.exec('COMMIT');
      return out;
    } catch (e) {
      await gc.db.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  };
  const p = txChain.then(run, run);
  txChain = p.catch(() => {});
  return p;
}

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

/** Multi-row INSERT in chunks (the host takes at most 100 parameters per statement). */
async function insertMany(gc, sql, cols, rows) {
  const per = Math.max(1, Math.floor(100 / cols));
  const tuple = '(' + new Array(cols).fill('?').join(',') + ')';
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    await gc.db.run(sql + ' VALUES ' + chunk.map(() => tuple).join(','), chunk.flat());
  }
}

const userIds = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 50) : []);

/** UPDATE <table> SET … WHERE id = ? for the given columns of `patch` (unknown keys ignored). */
async function patchRow(gc, table, cols, id, patch) {
  const keys = Object.keys(patch || {}).filter((k) => cols.includes(k));
  if (!keys.length) return;
  await gc.db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
}

// ─── Accounts ───────────────────────────────────

const ACCOUNT_COLS = ['host', 'school', 'username', 'auth', 'person_id', 'person_type', 'status', 'last_error', 'error_count', 'last_attempt_at',
  'last_success_at', 'last_error_at', 'next_fetch_at', 'refresh_asked_at', 'timegrid_json', 'holidays_json', 'meta_day', 'extras_json', 'owner_user_id', 'messages_at'];

function accountRow(r) {
  if (!r) return null;
  return {
    id: r.id, host: r.host, school: r.school, username: r.username, auth: r.auth,
    person_id: r.person_id == null ? null : Number(r.person_id), person_type: r.person_type == null ? null : Number(r.person_type),
    status: r.status, last_error: r.last_error || null, error_count: Number(r.error_count) || 0,
    last_attempt_at: r.last_attempt_at == null ? null : Number(r.last_attempt_at),
    last_success_at: r.last_success_at == null ? null : Number(r.last_success_at),
    last_error_at: r.last_error_at == null ? null : Number(r.last_error_at),
    next_fetch_at: Number(r.next_fetch_at) || 0, refresh_asked_at: r.refresh_asked_at == null ? null : Number(r.refresh_asked_at),
    timegrid: parseJson(r.timegrid_json, []), holidays: parseJson(r.holidays_json, []), meta_day: r.meta_day || null,
    extras: parseJson(r.extras_json, {}),
    // 1.3.0: the GateControl user who connected the account in the profile (null = an administrator)
    owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id),
    // 1.4.0: the last good inbox fetch (null: the next one is the baseline)
    messages_at: r.messages_at == null ? null : Number(r.messages_at),
    created_at: Number(r.created_at),
  };
}

async function listAccounts(gc) {
  return (await gc.db.query('SELECT * FROM accounts ORDER BY id')).rows.map(accountRow);
}
async function getAccount(gc, id) {
  return accountRow((await gc.db.get('SELECT * FROM accounts WHERE id = ?', [id])).row);
}
async function findAccount(gc, host, school, username) {
  return accountRow((await gc.db.get('SELECT * FROM accounts WHERE host = ? AND lower(school) = lower(?) AND lower(username) = lower(?)', [host, school, username])).row);
}
async function createAccount(gc, a, now) {
  const owner = Number.isSafeInteger(a.owner_user_id) && a.owner_user_id > 0 ? a.owner_user_id : null;
  const r = await gc.db.run('INSERT INTO accounts (host, school, username, auth, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [a.host, a.school, a.username, a.auth, owner, now]);
  return getAccount(gc, r.lastInsertRowid);
}
async function updateAccount(gc, id, patch) {
  const p = { ...patch };
  if (p.timegrid !== undefined) { p.timegrid_json = JSON.stringify(p.timegrid || []); delete p.timegrid; }
  if (p.holidays !== undefined) { p.holidays_json = JSON.stringify(p.holidays || []); delete p.holidays; }
  if (p.extras !== undefined) { p.extras_json = JSON.stringify(p.extras || {}); delete p.extras; }
  await patchRow(gc, 'accounts', ACCOUNT_COLS, id, p);
  return getAccount(gc, id);
}

/** The account's credentials { secret } | { password } (null when missing). */
async function getCred(gc, acc) {
  const key = acc.auth === 'secret' ? 'secret' : 'password';
  let v = null;
  try { v = await gc.settings.get(`acct.${acc.id}.${key}`); } catch { v = null; }
  return typeof v === 'string' && v ? { [key]: v } : null;
}
async function setCred(gc, id, auth, value) {
  await gc.settings.setSecret(`acct.${id}.${auth === 'secret' ? 'secret' : 'password'}`, value);
  // switching the login kind drops the other credential
  await gc.settings.setSecret(`acct.${id}.${auth === 'secret' ? 'password' : 'secret'}`, null);
}
async function clearCred(gc, id) {
  for (const k of ['secret', 'password']) {
    try { await gc.settings.setSecret(`acct.${id}.${k}`, null); } catch (e) { gc.log.warn('secret not removed', id, k, (e && e.code) || 'error'); }
  }
}

/** Deletes an account with its credentials, students, lessons and change log. */
async function deleteAccount(gc, id) {
  await clearCred(gc, id);
  // 1.5.0: the media files of its messages' attachments
  const media = mediaIdsOf((await gc.db.query('SELECT * FROM messages WHERE account_id = ?', [id])).rows.map(messageRow));
  for (const mid of media) { try { if (gc.media) await gc.media.delete(mid); } catch { /* gone already */ } }
  return tx(gc, async () => {
    const ids = (await gc.db.query('SELECT id FROM students WHERE account_id = ?', [id])).rows.map((r) => r.id);
    for (const sid of ids) {
      await gc.db.run('DELETE FROM lessons WHERE student_id = ?', [sid]);
      await gc.db.run('DELETE FROM changes WHERE student_id = ?', [sid]);
      for (const t of ['homework', 'exams', 'day_ends', 'absences']) await gc.db.run(`DELETE FROM ${t} WHERE student_id = ?`, [sid]);
    }
    await gc.db.run('DELETE FROM messages WHERE account_id = ?', [id]);
    await gc.db.run('DELETE FROM message_reads WHERE account_id = ?', [id]);
    await gc.db.run('DELETE FROM students WHERE account_id = ?', [id]);
    return (await gc.db.run('DELETE FROM accounts WHERE id = ?', [id])).changes > 0;
  });
}

// ─── Students ───────────────────────────────────

const STUDENT_COLS = ['name', 'alias', 'klasse', 'enabled', 'user_id', 'recipients_json', 'show_on_wall', 'baseline_done', 'missing', 'range_from',
  'range_to', 'last_fetch_at', 'last_change_at', 'last_error', 'color', 'link_source', 'absences_at'];

function studentRow(r) {
  if (!r) return null;
  return {
    id: r.id, account_id: r.account_id, person_id: Number(r.person_id), name: r.name, alias: r.alias || null,
    display: r.alias || r.name, klasse: r.klasse || '',
    enabled: !!r.enabled, user_id: r.user_id == null ? null : Number(r.user_id), recipients: userIds(parseJson(r.recipients_json, [])),
    show_on_wall: !!r.show_on_wall, baseline_done: !!r.baseline_done, missing: !!r.missing,
    range_from: r.range_from || null, range_to: r.range_to || null,
    last_fetch_at: r.last_fetch_at == null ? null : Number(r.last_fetch_at),
    last_change_at: r.last_change_at == null ? null : Number(r.last_change_at),
    last_error: r.last_error || null, created_at: Number(r.created_at),
    // 1.3.0: the student's own colour (#RRGGBB) and who mapped user_id ('admin' | 'self' | null)
    color: colors.hex(r.color), link_source: r.link_source === 'self' || r.link_source === 'admin' ? r.link_source : null,
    // 1.4.0: the last good absence fetch (null: the next one is the baseline)
    absences_at: r.absences_at == null ? null : Number(r.absences_at),
  };
}

async function listStudents(gc, accountId) {
  const r = accountId == null
    ? await gc.db.query('SELECT * FROM students ORDER BY account_id, id')
    : await gc.db.query('SELECT * FROM students WHERE account_id = ? ORDER BY id', [accountId]);
  return r.rows.map(studentRow);
}
async function getStudent(gc, id) {
  return studentRow((await gc.db.get('SELECT * FROM students WHERE id = ?', [id])).row);
}
async function updateStudent(gc, id, patch) {
  const p = { ...patch };
  if (p.recipients !== undefined) { p.recipients_json = JSON.stringify(userIds(p.recipients)); delete p.recipients; }
  for (const k of ['enabled', 'show_on_wall', 'baseline_done', 'missing']) if (typeof p[k] === 'boolean') p[k] = p[k] ? 1 : 0;
  await patchRow(gc, 'students', STUDENT_COLS, id, p);
  return getStudent(gc, id);
}

/**
 * The students an account lists now ([{ personId, name }]): new ones are added (enabled, baseline
 * pending), names follow WebUntis, ones no longer listed are marked missing (kept, not fetched).
 */
async function syncStudents(gc, accountId, persons, now) {
  const have = await listStudents(gc, accountId);
  const byPerson = new Map(have.map((s) => [s.person_id, s]));
  const listed = new Set();
  let taken = null;
  for (const p of persons) {
    listed.add(p.personId);
    const s = byPerson.get(p.personId);
    if (!s) {
      // 1.3.0: a colour no other student has (distinct children at a glance)
      if (!taken) taken = await takenColors(gc);
      const color = colors.pick(taken, now);
      taken.add(color);
      await gc.db.run('INSERT INTO students (account_id, person_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', [accountId, p.personId, p.name, color, now]);
    } else if (s.name !== p.name || s.missing) {
      await updateStudent(gc, s.id, { name: p.name, missing: false });
    }
  }
  for (const s of have) if (!listed.has(s.person_id) && !s.missing) await updateStudent(gc, s.id, { missing: true });
  return listStudents(gc, accountId);
}

/** The colours the students have (a Set of #RRGGBB). */
async function takenColors(gc) {
  return new Set((await gc.db.query('SELECT color FROM students WHERE color IS NOT NULL')).rows.map((r) => colors.hex(r.color)).filter(Boolean));
}

/** 1.3.0: students of 1.2.0 (no colour yet) get one each — distinct, in the order they were found. */
async function ensureColors(gc) {
  const missing = (await gc.db.query('SELECT id FROM students WHERE color IS NULL ORDER BY id')).rows;
  if (!missing.length) return 0;
  const taken = await takenColors(gc);
  for (const r of missing) {
    const c = colors.pick(taken, r.id);
    taken.add(c);
    await gc.db.run('UPDATE students SET color = ? WHERE id = ?', [c, r.id]);
  }
  return missing.length;
}

/** 1.3.0: the students of one WebUntis person at one school, in any account (host + school + person id). */
async function studentsOfPerson(gc, host, school, personId) {
  const r = await gc.db.query('SELECT s.* FROM students s JOIN accounts a ON a.id = s.account_id WHERE a.host = ? AND lower(a.school) = lower(?) AND s.person_id = ? ORDER BY s.id',
    [host, school, personId]);
  return r.rows.map(studentRow);
}

// ─── Lessons ────────────────────────────────────

const LESSON_COLS = ['lkey', 'date', 't_start', 't_end', 'period', 'period_end', 'subject', 'subject_long', 'subject_old', 'teacher', 'teacher_old',
  'room', 'room_old', 'klasse', 'state', 'info', 'subst_text', 'lstext', 'added', 'removed'];

function lessonRow(r) {
  if (!r) return null;
  const out = {};
  for (const k of LESSON_COLS) out[k] = r[k] === undefined ? null : r[k];
  out.student_id = r.student_id;
  out.period = r.period == null ? null : Number(r.period);
  out.period_end = r.period_end == null ? null : Number(r.period_end);
  out.added = !!r.added;
  out.removed = !!r.removed;
  for (const k of ['subject', 'subject_long', 'teacher', 'room', 'klasse']) out[k] = out[k] || '';
  return out;
}

/** Lessons of students between two dates (inclusive), by date and time. */
async function lessonsBetween(gc, studentIds, from, to) {
  if (!studentIds.length) return [];
  const out = [];
  for (let i = 0; i < studentIds.length; i += 90) {
    const ids = studentIds.slice(i, i + 90);
    const r = await gc.db.query(`SELECT * FROM lessons WHERE student_id IN (${ids.map(() => '?').join(',')}) AND date >= ? AND date <= ? ORDER BY date, t_start, lkey`, [...ids, from, to]);
    out.push(...r.rows.map(lessonRow));
  }
  return out;
}

/** Replaces a student's lessons between `from` and `to` with `rows`. */
async function replaceLessons(gc, studentId, from, to, rows) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM lessons WHERE student_id = ? AND date >= ? AND date <= ?', [studentId, from, to]);
    await insertMany(gc, `INSERT OR REPLACE INTO lessons (student_id, ${LESSON_COLS.join(', ')})`, LESSON_COLS.length + 1,
      rows.map((r) => [studentId, ...LESSON_COLS.map((k) => (k === 'added' || k === 'removed' ? (r[k] ? 1 : 0) : (r[k] === undefined ? null : r[k])))]));
  });
}

async function countLessons(gc) {
  const m = new Map();
  for (const r of (await gc.db.query('SELECT student_id, COUNT(*) AS n FROM lessons GROUP BY student_id')).rows) m.set(r.student_id, Number(r.n));
  return m;
}

// ─── Change log ─────────────────────────────────

function changeRow(r) {
  if (!r) return null;
  return {
    id: r.id, student_id: r.student_id, lkey: r.lkey, date: r.date, t_start: r.t_start, t_end: r.t_end,
    period: r.period == null ? null : Number(r.period), kind: r.kind, subject: r.subject || '', detail: parseJson(r.detail_json, {}),
    detected_at: Number(r.detected_at), status: r.status, sent_at: r.sent_at == null ? null : Number(r.sent_at),
    rule_at: r.rule_at == null ? null : Number(r.rule_at),
  };
}

async function addChanges(gc, studentId, list, now) {
  if (!list.length) return;
  await insertMany(gc, 'INSERT INTO changes (student_id, lkey, date, t_start, t_end, period, kind, subject, detail_json, detected_at, status)', 11,
    list.map((c) => [studentId, c.lkey, c.date, c.t_start, c.t_end, c.period == null ? null : c.period, c.kind, c.subject || '', JSON.stringify(c.detail || {}), now, c.status]));
}

async function changesWithStatus(gc, statuses) {
  return (await gc.db.query(`SELECT * FROM changes WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY student_id, date, t_start, id`, statuses)).rows.map(changeRow);
}

async function setChangeStatus(gc, ids, status, sentAt = null) {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await gc.db.run(`UPDATE changes SET status = ?, sent_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [status, sentAt, ...chunk]);
  }
}

/** Was a cancellation of this lesson pushed before change `beforeId`? */
/** 1.1.0: the changes handed to the Familie plugin's rules (or skipped) — never again. */
async function setRuleAt(gc, ids, at) {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await gc.db.run(`UPDATE changes SET rule_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [at, ...chunk]);
  }
}

async function cancellationSent(gc, studentId, lkey, beforeId) {
  const r = await gc.db.get("SELECT id FROM changes WHERE student_id = ? AND lkey = ? AND kind = 'cancelled' AND status = 'sent' AND id < ? LIMIT 1", [studentId, lkey, beforeId]);
  return !!r.row;
}

/** The change log of some students since `since` (ms), newest first. */
async function listChanges(gc, studentIds, since, limit = 100) {
  if (studentIds != null && !studentIds.length) return [];
  const where = studentIds == null ? '' : `student_id IN (${studentIds.map(() => '?').join(',')}) AND `;
  const r = await gc.db.query(`SELECT * FROM changes WHERE ${where}detected_at >= ? ORDER BY detected_at DESC, id DESC LIMIT ?`, [...(studentIds || []), since, limit]);
  return r.rows.map(changeRow);
}

/** Housekeeping: lessons, homework, exams and early ends before `beforeDate`, changes and notices before `beforeMs`. */
async function prune(gc, beforeDate, beforeMs) {
  await gc.db.run('DELETE FROM lessons WHERE date < ?', [beforeDate]);
  await gc.db.run('DELETE FROM changes WHERE detected_at < ?', [beforeMs]);
  await gc.db.run('DELETE FROM homework WHERE due_date < ?', [beforeDate]);
  await gc.db.run('DELETE FROM exams WHERE date < ?', [beforeDate]);
  await gc.db.run('DELETE FROM day_ends WHERE date < ?', [beforeDate]);
  await gc.db.run('DELETE FROM notices WHERE at < ?', [beforeMs]);
}

// ─── Homework and exams (1.2.0) ─────────────────

const HW_COLS = ['hw_id', 'given_date', 'due_date', 'subject', 'subject_long', 'text', 'remark', 'completed'];
const EX_COLS = ['ex_id', 'date', 't_start', 't_end', 'subject', 'subject_long', 'name', 'type', 'text'];

function homeworkRow(r) {
  return {
    student_id: r.student_id, hw_id: r.hw_id, given_date: r.given_date || null, due_date: r.due_date, subject: r.subject || '',
    subject_long: r.subject_long || null, text: r.text || '', remark: r.remark || null, completed: !!r.completed,
  };
}

function examRow(r) {
  return {
    student_id: r.student_id, ex_id: r.ex_id, date: r.date, t_start: r.t_start || null, t_end: r.t_end || null, subject: r.subject || '',
    subject_long: r.subject_long || null, name: r.name || '', type: r.type || null, text: r.text || null,
  };
}

/** A student's homework is replaced by a fetch (`rows` = everything the fetch found). */
async function replaceHomework(gc, studentId, rows) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM homework WHERE student_id = ?', [studentId]);
    await insertMany(gc, `INSERT OR REPLACE INTO homework (student_id, ${HW_COLS.join(', ')})`, HW_COLS.length + 1,
      rows.map((r) => [studentId, ...HW_COLS.map((k) => (k === 'completed' ? (r[k] ? 1 : 0) : (r[k] === undefined ? null : r[k])))]));
  });
}

/** A student's exams between `from` and `to` are replaced by `rows`. */
async function replaceExams(gc, studentId, from, to, rows) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM exams WHERE student_id = ? AND date >= ? AND date <= ?', [studentId, from, to]);
    await insertMany(gc, `INSERT OR REPLACE INTO exams (student_id, ${EX_COLS.join(', ')})`, EX_COLS.length + 1,
      rows.map((r) => [studentId, ...EX_COLS.map((k) => (r[k] === undefined ? null : r[k]))]));
  });
}

async function byStudents(gc, table, col, studentIds, from, to, order, rowFn) {
  if (!studentIds.length) return [];
  const out = [];
  for (let i = 0; i < studentIds.length; i += 90) {
    const ids = studentIds.slice(i, i + 90);
    const r = await gc.db.query(`SELECT * FROM ${table} WHERE student_id IN (${ids.map(() => '?').join(',')}) AND ${col} >= ? AND ${col} <= ? ORDER BY ${order}`, [...ids, from, to]);
    out.push(...r.rows.map(rowFn));
  }
  return out;
}

/** Homework due between two dates (inclusive). */
const homeworkDue = (gc, studentIds, from, to) => byStudents(gc, 'homework', 'due_date', studentIds, from, to, 'due_date, subject, hw_id', homeworkRow);
/** Exams between two dates (inclusive), by date and time. */
const examsBetween = (gc, studentIds, from, to) => byStudents(gc, 'exams', 'date', studentIds, from, to, 'date, t_start, ex_id', examRow);

/** Counts per student: { homework: Map, exams: Map } from `from` on. */
async function countExtras(gc, from) {
  const hw = new Map();
  const ex = new Map();
  for (const r of (await gc.db.query('SELECT student_id, COUNT(*) AS n FROM homework WHERE due_date >= ? GROUP BY student_id', [from])).rows) hw.set(r.student_id, Number(r.n));
  for (const r of (await gc.db.query('SELECT student_id, COUNT(*) AS n FROM exams WHERE date >= ? GROUP BY student_id', [from])).rows) ex.set(r.student_id, Number(r.n));
  return { homework: hw, exams: ex };
}

// ─── Once-only notices (1.2.0) ──────────────────

async function noticeSeen(gc, key) {
  return !!(await gc.db.get('SELECT key FROM notices WHERE key = ?', [key])).row;
}
async function noticeMark(gc, key, now) {
  await gc.db.run('INSERT OR IGNORE INTO notices (key, at) VALUES (?, ?)', [key, now]);
}

// ─── Early ends of a school day (1.2.0) ─────────

function dayEndRow(r) {
  return {
    student_id: r.student_id, date: r.date, new_end: r.new_end, planned_end: r.planned_end, detected_at: Number(r.detected_at),
    status: r.status, sent_at: r.sent_at == null ? null : Number(r.sent_at),
  };
}

/** A newly found early end (once per student, date and new end) → true when it is new. */
async function addDayEnd(gc, studentId, e, now) {
  const r = await gc.db.run("INSERT OR IGNORE INTO day_ends (student_id, date, new_end, planned_end, detected_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    [studentId, e.date, e.newEnd, e.plannedEnd, now]);
  return r.changes > 0;
}

async function dayEndsWithStatus(gc, statuses) {
  return (await gc.db.query(`SELECT * FROM day_ends WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY detected_at, student_id, date`, statuses)).rows.map(dayEndRow);
}

async function setDayEndStatus(gc, list, status, sentAt = null) {
  for (const e of list) {
    await gc.db.run('UPDATE day_ends SET status = ?, sent_at = ? WHERE student_id = ? AND date = ? AND new_end = ?', [status, sentAt, e.student_id, e.date, e.new_end]);
  }
}

// ─── Messages (1.4.0) ───────────────────────────

const MSG_FIELDS = ['subject', 'preview', 'body', 'sender', 'sent_at', 'has_attachments'];

const numOrNull = (v) => (v == null ? null : Number(v));

/** attachments_json → [{ id, name, size, mime, mediaId? }] ([] when none or unreadable). */
function attachmentsOf(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((a) => a && typeof a === 'object' && typeof a.id === 'string') : [];
  } catch { return []; }
}

function messageRow(r) {
  if (!r) return null;
  return {
    account_id: Number(r.account_id), msg_id: r.msg_id, subject: r.subject || '', preview: r.preview || '', body: r.body || null, sender: r.sender || '',
    sent_at: numOrNull(r.sent_at), has_attachments: !!r.has_attachments, detected_at: Number(r.detected_at),
    seen_at: Number(r.seen_at), status: r.status, pushed_at: numOrNull(r.pushed_at),
    // 1.5.0
    full_text: !!r.full_text, attachments: attachmentsOf(r.attachments_json), detail_at: numOrNull(r.detail_at),
    detail_tries: Number(r.detail_tries) || 0, detail_next_at: numOrNull(r.detail_next_at),
    confirm_required: !!r.confirm_required, confirmed_at: numOrNull(r.confirmed_at), confirmed_by: numOrNull(r.confirmed_by),
  };
}

/**
 * The messages an inbox fetch found (`rows` parsed, server/messages.js). New ones are added — 'baseline'
 * on the account's first fetch, else 'pending' (to be pushed); known ones are updated (a body once
 * there is kept). Messages sent before `oldest` (ms) are not added (they would be pruned at once).
 * → the number of new messages.
 */
/**
 * Store an inbox: known messages updated, new ones added ('pending', or 'baseline' on the account's first
 * fetch — 1.4.1: also a new one sent before `quietBefore`, e.g. an older message of a list read only now).
 */
async function upsertMessages(gc, accountId, rows, now, { baseline, oldest, quietBefore = null }) {
  return tx(gc, async () => {
    const have = new Set((await gc.db.query('SELECT msg_id FROM messages WHERE account_id = ?', [accountId])).rows.map((r) => r.msg_id));
    let added = 0;
    for (const m of rows) {
      const vals = [m.subject || '', m.preview || '', m.body || null, m.sender || '', m.sent_at == null ? null : m.sent_at, m.has_attachments ? 1 : 0];
      if (have.has(m.msg_id)) {
        // 1.5.0: the full text of the detail call is kept (the list only has the preview); a message that
        // asked for a read confirmation and is no longer listed so was confirmed elsewhere (WebUntis)
        await gc.db.run(`UPDATE messages SET subject = ?, preview = ?, body = CASE WHEN full_text = 1 THEN body ELSE COALESCE(?, body) END, sender = ?, sent_at = ?,
          has_attachments = ?, seen_at = ?, confirmed_at = CASE WHEN confirm_required = 1 AND confirmed_at IS NULL AND ? = 0 THEN ? ELSE confirmed_at END,
          confirm_required = CASE WHEN ? = 1 THEN 1 ELSE confirm_required END WHERE account_id = ? AND msg_id = ?`,
          [...vals, now, m.confirm ? 1 : 0, now, m.confirm ? 1 : 0, accountId, m.msg_id]);
        continue;
      }
      if (m.sent_at != null && oldest != null && m.sent_at < oldest) continue;
      have.add(m.msg_id);
      await gc.db.run(`INSERT INTO messages (account_id, msg_id, ${MSG_FIELDS.join(', ')}, detected_at, seen_at, status, confirm_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, m.msg_id, ...vals, now, now, baseline || (quietBefore != null && m.sent_at != null && m.sent_at < quietBefore) ? 'baseline' : 'pending', m.confirm ? 1 : 0]);
      added += 1;
    }
    return added;
  });
}

async function messagesWithStatus(gc, statuses) {
  return (await gc.db.query(`SELECT * FROM messages WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY account_id, COALESCE(sent_at, detected_at), msg_id`, statuses)).rows.map(messageRow);
}

async function setMessageStatus(gc, list, status, pushedAt = null) {
  for (const m of list) await gc.db.run('UPDATE messages SET status = ?, pushed_at = ? WHERE account_id = ? AND msg_id = ?', [status, pushedAt, m.account_id, m.msg_id]);
}

/** The messages of some accounts sent (or, without a time, found) since `since` (ms), newest first. */
async function listMessages(gc, accountIds, since, limit = 100) {
  if (!accountIds.length) return [];
  const r = await gc.db.query(`SELECT * FROM messages WHERE account_id IN (${accountIds.map(() => '?').join(',')}) AND COALESCE(sent_at, detected_at) >= ?
    ORDER BY COALESCE(sent_at, detected_at) DESC, msg_id DESC LIMIT ?`, [...accountIds, since, limit]);
  return r.rows.map(messageRow);
}

/** One stored message (null when unknown). */
async function getMessage(gc, accountId, msgId) {
  return messageRow((await gc.db.query('SELECT * FROM messages WHERE account_id = ? AND msg_id = ?', [accountId, msgId])).rows[0]);
}

/**
 * 1.5.0: messages of an account still without their detail (full text, attachments) — newest first,
 * not after `maxTries` failures, not before their retry time; ≤ `limit`.
 */
async function messagesWithoutDetail(gc, accountId, now, maxTries, limit) {
  const r = await gc.db.query(`SELECT * FROM messages WHERE account_id = ? AND detail_at IS NULL AND detail_tries < ? AND (detail_next_at IS NULL OR detail_next_at <= ?)
    ORDER BY COALESCE(sent_at, detected_at) DESC, msg_id DESC LIMIT ?`, [accountId, maxTries, now, limit]);
  return r.rows.map(messageRow);
}

/** 1.5.0: the detail answered — the full text (null: keep the preview's) and the attachments. */
async function setMessageDetail(gc, m, { body, attachments }, now) {
  await gc.db.run(`UPDATE messages SET body = COALESCE(?, body), full_text = CASE WHEN ? IS NULL THEN full_text ELSE 1 END, attachments_json = ?,
    has_attachments = CASE WHEN ? > 0 THEN 1 ELSE has_attachments END, detail_at = ?, detail_next_at = NULL WHERE account_id = ? AND msg_id = ?`,
  [body, body, JSON.stringify(attachments || []), (attachments || []).length, now, m.account_id, m.msg_id]);
}

/** 1.5.0: a detail call failed — tried again at `next` (ms). */
async function detailFailed(gc, m, next) {
  await gc.db.run('UPDATE messages SET detail_tries = detail_tries + 1, detail_next_at = ? WHERE account_id = ? AND msg_id = ?', [next, m.account_id, m.msg_id]);
}

/** 1.5.0: the attachments of a message (after one was fetched into the media store). */
async function setAttachments(gc, m, attachments) {
  await gc.db.run('UPDATE messages SET attachments_json = ? WHERE account_id = ? AND msg_id = ?', [JSON.stringify(attachments), m.account_id, m.msg_id]);
}

/** 1.5.0: the read confirmation was sent (by `userId`). */
async function setConfirmed(gc, m, now, userId) {
  await gc.db.run('UPDATE messages SET confirmed_at = ?, confirmed_by = ? WHERE account_id = ? AND msg_id = ?', [now, userId, m.account_id, m.msg_id]);
}

/** 1.5.0: `userId` has opened the message. */
async function markRead(gc, m, userId, now) {
  await gc.db.run('INSERT OR IGNORE INTO message_reads (account_id, msg_id, user_id, read_at) VALUES (?, ?, ?, ?)', [m.account_id, m.msg_id, userId, now]);
}

/** 1.5.0: which of the messages `userId` has opened → Set of "<account>-<msg>". */
async function readSet(gc, userId, list) {
  const out = new Set();
  if (!list.length || !Number.isInteger(userId)) return out;
  const accs = [...new Set(list.map((m) => m.account_id))];
  const r = await gc.db.query(`SELECT account_id, msg_id FROM message_reads WHERE user_id = ? AND account_id IN (${accs.map(() => '?').join(',')})`, [userId, ...accs]);
  for (const x of r.rows) out.add(`${Number(x.account_id)}-${x.msg_id}`);
  return out;
}

/** 1.5.0: the message holding the media file `mediaId` among its attachments (null when none). */
async function messageOfMedia(gc, mediaId) {
  const r = await gc.db.query('SELECT * FROM messages WHERE attachments_json LIKE ? LIMIT 5', [`%"mediaId":"${String(mediaId).replace(/[%_"\\]/g, '')}"%`]);
  return r.rows.map(messageRow).find((m) => m.attachments.some((a) => a.mediaId === mediaId)) || null;
}

/** Per account: how many messages are stored. */
async function countMessages(gc) {
  const m = new Map();
  for (const r of (await gc.db.query('SELECT account_id, COUNT(*) AS n FROM messages GROUP BY account_id')).rows) m.set(Number(r.account_id), Number(r.n));
  return m;
}

// ─── Absences (1.4.0) ───────────────────────────

const ABS_FIELDS = ['date', 'end_date', 't_start', 't_end', 'reason', 'text', 'excused'];

function absenceRow(r) {
  if (!r) return null;
  return {
    student_id: Number(r.student_id), abs_id: r.abs_id, date: r.date, end_date: r.end_date || null, t_start: r.t_start || null, t_end: r.t_end || null,
    reason: r.reason || null, text: r.text || null, excused: r.excused == null ? null : !!Number(r.excused), sig: r.sig,
    detected_at: Number(r.detected_at), changed_at: Number(r.changed_at), status: r.status, change: r.change || null,
    pushed_at: r.pushed_at == null ? null : Number(r.pushed_at),
  };
}

/** What a change of an absence is looked for in (not its free text). */
const absenceSig = (a) => JSON.stringify([a.date, a.end_date || null, a.t_start || null, a.t_end || null, a.excused == null ? null : !!a.excused, a.reason || null]);

/** The change of an absence that is known already → 'excused' | 'unexcused' | 'changed'. */
function absenceChange(old, next) {
  const was = old.excused == null ? null : !!old.excused;
  const now = next.excused == null ? null : !!next.excused;
  if (was !== now && now === true) return 'excused';
  if (was !== now && now === false) return 'unexcused';
  return 'changed';
}

/**
 * A student's absences between `from` and `to` as a fetch found them (`rows` parsed, server/absences.js):
 * new ones are added, changed ones updated — on the baseline as 'baseline', later as 'pending' with what
 * changed —, ones WebUntis no longer lists within the dates are removed. → { added, changed, removed }
 */
async function applyAbsences(gc, studentId, rows, from, to, now, { baseline }) {
  return tx(gc, async () => {
    const prev = new Map((await gc.db.query('SELECT * FROM absences WHERE student_id = ? AND date >= ? AND date <= ?', [studentId, from, to])).rows.map((r) => [r.abs_id, absenceRow(r)]));
    const out = { added: 0, changed: 0, removed: 0 };
    const seen = new Set();
    for (const a of rows) {
      if (seen.has(a.abs_id)) continue;
      seen.add(a.abs_id);
      const sig = absenceSig(a);
      const vals = ABS_FIELDS.map((k) => (k === 'excused' ? (a.excused == null ? null : (a.excused ? 1 : 0)) : (a[k] == null ? null : a[k])));
      const old = prev.get(a.abs_id) || (await gc.db.get('SELECT * FROM absences WHERE student_id = ? AND abs_id = ?', [studentId, a.abs_id]).then((r) => absenceRow(r.row)));
      if (!old) {
        await gc.db.run(`INSERT INTO absences (student_id, abs_id, ${ABS_FIELDS.join(', ')}, sig, detected_at, changed_at, status, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [studentId, a.abs_id, ...vals, sig, now, now, baseline ? 'baseline' : 'pending', baseline ? null : 'new']);
        out.added += 1;
        continue;
      }
      if (old.sig === sig) {
        await gc.db.run('UPDATE absences SET text = ? WHERE student_id = ? AND abs_id = ?', [a.text == null ? null : a.text, studentId, a.abs_id]);
        continue;
      }
      let status = baseline ? old.status : 'pending';
      let change = baseline ? old.change : absenceChange(old, a);
      // not pushed yet: a new one stays new
      if (!baseline && (old.status === 'pending' || old.status === 'held') && old.change === 'new') change = 'new';
      if (baseline && status === 'pending') status = 'baseline';
      await gc.db.run(`UPDATE absences SET ${ABS_FIELDS.map((k) => `${k} = ?`).join(', ')}, sig = ?, changed_at = ?, status = ?, change = ? WHERE student_id = ? AND abs_id = ?`,
        [...vals, sig, now, status, change, studentId, a.abs_id]);
      out.changed += 1;
    }
    for (const id of prev.keys()) {
      if (seen.has(id)) continue;
      await gc.db.run('DELETE FROM absences WHERE student_id = ? AND abs_id = ?', [studentId, id]);
      out.removed += 1;
    }
    return out;
  });
}

async function absencesWithStatus(gc, statuses) {
  return (await gc.db.query(`SELECT * FROM absences WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY student_id, date, t_start, abs_id`, statuses)).rows.map(absenceRow);
}

async function setAbsenceStatus(gc, list, status, pushedAt = null) {
  for (const a of list) await gc.db.run('UPDATE absences SET status = ?, pushed_at = ? WHERE student_id = ? AND abs_id = ?', [status, pushedAt, a.student_id, a.abs_id]);
}

/** Absences of some students that start on or end after `sinceDate`, newest first. */
async function listAbsences(gc, studentIds, sinceDate, limit = 200) {
  if (!studentIds.length) return [];
  const out = [];
  for (let i = 0; i < studentIds.length; i += 90) {
    const ids = studentIds.slice(i, i + 90);
    const r = await gc.db.query(`SELECT * FROM absences WHERE student_id IN (${ids.map(() => '?').join(',')}) AND (date >= ? OR end_date >= ?)
      ORDER BY date DESC, COALESCE(t_start, '') DESC, abs_id DESC LIMIT ?`, [...ids, sinceDate, sinceDate, limit]);
    out.push(...r.rows.map(absenceRow));
  }
  out.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : (a.t_start || '') > (b.t_start || '') ? -1 : (a.t_start || '') < (b.t_start || '') ? 1 : 0));
  return out.slice(0, limit);
}

/** Per student: how many absences are stored. */
async function countAbsences(gc) {
  const m = new Map();
  for (const r of (await gc.db.query('SELECT student_id, COUNT(*) AS n FROM absences GROUP BY student_id')).rows) m.set(Number(r.student_id), Number(r.n));
  return m;
}

/** Housekeeping (1.4.0): messages sent (or, without a time, last listed) before `msgBefore` (ms); absences before `absBefore` (date). */
async function pruneSchool(gc, msgBefore, absBefore) {
  const where = '(sent_at IS NOT NULL AND sent_at < ?) OR (sent_at IS NULL AND seen_at < ?)';
  // 1.5.0: the media files of their attachments go too (→ the media ids, the caller deletes them)
  const gone = (await gc.db.query(`SELECT * FROM messages WHERE ${where}`, [msgBefore, msgBefore])).rows.map(messageRow);
  await gc.db.run(`DELETE FROM message_reads WHERE EXISTS (SELECT 1 FROM messages m WHERE m.account_id = message_reads.account_id AND m.msg_id = message_reads.msg_id AND (${where.replace(/sent_at/g, 'm.sent_at').replace(/seen_at/g, 'm.seen_at')}))`, [msgBefore, msgBefore]);
  await gc.db.run(`DELETE FROM messages WHERE ${where}`, [msgBefore, msgBefore]);
  await gc.db.run('DELETE FROM absences WHERE COALESCE(end_date, date) < ?', [absBefore]);
  return mediaIdsOf(gone);
}

/** The media ids of the attachments of some messages. */
function mediaIdsOf(list) {
  return list.flatMap((m) => m.attachments.map((a) => a.mediaId).filter(Boolean));
}

module.exports = {
  upsertMessages, messagesWithStatus, setMessageStatus, listMessages, countMessages,
  getMessage, messagesWithoutDetail, setMessageDetail, detailFailed, setAttachments, setConfirmed, markRead, readSet, messageOfMedia, mediaIdsOf, attachmentsOf,
  applyAbsences, absencesWithStatus, setAbsenceStatus, listAbsences, countAbsences, absenceSig, absenceChange, pruneSchool,
  tx, listAccounts, getAccount, findAccount, createAccount, updateAccount, deleteAccount, getCred, setCred, clearCred,
  listStudents, getStudent, updateStudent, syncStudents, ensureColors, takenColors, studentsOfPerson,
  lessonsBetween, replaceLessons, countLessons, LESSON_COLS,
  addChanges, changesWithStatus, setChangeStatus, setRuleAt, cancellationSent, listChanges, prune,
  replaceHomework, replaceExams, homeworkDue, examsBetween, countExtras, noticeSeen, noticeMark,
  addDayEnd, dayEndsWithStatus, setDayEndStatus,
};
