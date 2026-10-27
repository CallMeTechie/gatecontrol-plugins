'use strict';

// 1.4.0 — school messages (the WebUntis inbox, server/messages.js) and absences (server/absences.js):
// the JWT flow with the bearer header, parsing (HTML stripped, excuse states), who may read what (a
// parent inbox is not the child's), baseline and no duplicate pushes, quiet hours, 403/404 never
// breaking the timetable, the app API shapes and limits, the Schule page and the Start tile.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asApp, asPortal, setupParent, tickAt, at, clock, ADMIN, EVA, LENA, BOB, WALL, QR_LENA, T0 } = require('./helpers');
const untis = require('../server/untis');
const messages = require('../server/messages');
const absences = require('../server/absences');
const store = require('../server/store');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SCHOOL = { untis: { school: true } };
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJTMSJ9.c2lnbmF0dXJl';

/** A raw inbox message as api/rest/view/v1/messages lists it. */
function msg(id, subject, extra = {}) {
  return {
    id, subject, contentPreview: `Vorschau ${id}`, hasAttachments: false, isMessageRead: false, isReply: false, isReplyAllowed: false,
    allowMessageDeletion: false, sender: { userId: 7, displayName: 'Frau Schmidt', imageUrl: '', className: '' }, sentDateTime: '2026-10-19T16:00:00Z', ...extra,
  };
}

/** A raw absence as api/classreg/absences/students lists it. */
function absence(id, date, extra = {}) {
  return {
    id, startDate: date, endDate: date, startTime: 800, endTime: 1135, createDate: 0, lastUpdate: 0, createdUser: 'MUE', updatedUser: 'MUE',
    reasonId: 1, reason: 'Krankheit', text: '', interruptions: [], canEdit: false, studentName: 'Lena Muster', excuseStatus: '', isExcused: false,
    excuse: { id: 0, text: '', excuseDate: 0, excuseStatus: '', isExcused: false, userId: 0, username: '' }, ...extra,
  };
}

const pushes = (host, topic) => host.notifications.filter((n) => n.topic === topic);
const app = (host, user, p, query) => asApp(host, user, p, query);

test('client: the JWT of api/token/new (asked once per session) goes as a bearer header with the session cookie; codes of the optional endpoints', async () => {
  const calls = [];
  const answers = [];
  const gc = { http: { fetch: async (url, o) => { calls.push({ url, o }); return answers.shift(); } } };
  const code = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.code; } };
  const login = { status: 200, headers: {}, body: JSON.stringify({ result: { sessionId: 'S1', personId: 900, personType: 12 } }) };
  const c = untis.createClient(gc, { host: 'nessa.webuntis.com', school: 'X', username: 'u', auth: 'password' });
  answers.push(login);
  await c.login({ password: 'pw' });
  answers.push({ status: 200, body: JWT }, { status: 200, body: JSON.stringify({ incomingMessages: [msg(1, 'A')] }) });
  assert.deepEqual((await c.inbox()).map((m) => m.id), [1]);
  assert.equal(calls[1].url, 'https://nessa.webuntis.com/WebUntis/api/token/new');
  assert.match(calls[1].o.headers.cookie, /^JSESSIONID=S1; schoolname=/);
  assert.equal(calls[1].o.headers.authorization, undefined, 'the token is asked with the cookie only');
  assert.equal(calls[2].url, 'https://nessa.webuntis.com/WebUntis/api/rest/view/v1/messages');
  assert.equal(calls[2].o.method, 'GET');
  assert.equal(calls[2].o.headers.authorization, `Bearer ${JWT}`);
  assert.match(calls[2].o.headers.cookie, /^JSESSIONID=S1; /);
  // the token is kept for the session
  answers.push({ status: 200, body: JSON.stringify({ incomingMessages: [] }) });
  assert.deepEqual(await c.inbox(), []);
  assert.equal(calls.length, 4);
  // absences: the student, every excuse status, the dates as yyyymmdd
  answers.push({ status: 200, body: JSON.stringify({ data: { absences: [absence(5, 20261013)] } }) });
  assert.equal((await c.absences('2026-08-01', '2026-11-03', 101)).length, 1);
  assert.equal(calls[4].url, 'https://nessa.webuntis.com/WebUntis/api/classreg/absences/students?startDate=20260801&endDate=20261103&studentId=101&excuseStatusId=-1');
  answers.push({ status: 200, body: JSON.stringify({ data: {} }) });
  assert.deepEqual(await c.absences('2026-08-01', '2026-11-03', 101), []);
  answers.push({ status: 200, body: JSON.stringify({ nothing: true }) });
  assert.equal(await code(() => c.absences('2026-08-01', '2026-11-03', 101)), 'failed');
  assert.equal(await code(() => c.absences('2026-08-01', '2026-11-03', null)), 'unsupported', 'no student: no request');
  // 401/403 → no_right, 404 → unsupported, 5xx → network — never 'auth'
  answers.push({ status: 403, body: '' });
  assert.equal(await code(() => c.absences('2026-08-01', '2026-11-03', 101)), 'no_right');
  answers.push({ status: 404, body: '' });
  assert.equal(await code(() => c.absences('2026-08-01', '2026-11-03', 101)), 'unsupported');
  answers.push({ status: 404, body: '' });
  assert.equal(await code(() => c.inbox()), 'unsupported');
  answers.push({ status: 401, body: '' });
  assert.equal(await code(() => c.inbox()), 'no_right');
  answers.push({ status: 503, body: '' });
  assert.equal(await code(() => c.inbox()), 'network');

  // a fresh session: the token as a JSON string; then refused; then not a token at all
  const c2 = untis.createClient(gc, { host: 'nessa.webuntis.com', school: 'X', username: 'u', auth: 'password' });
  answers.push(login);
  await c2.login({ password: 'pw' });
  answers.push({ status: 200, body: JSON.stringify(JWT) }, { status: 200, body: JSON.stringify({ data: { incomingMessages: [msg(2, 'B')] } }) });
  assert.deepEqual((await c2.inbox()).map((m) => m.id), [2]);
  assert.equal(calls.at(-1).o.headers.authorization, `Bearer ${JWT}`);
  // 1.4.1: messages to be confirmed (school-wide information) come in their own list — read too
  answers.push({ status: 200, body: JSON.stringify({ incomingMessages: [msg(3, 'C')], readConfirmationMessages: [msg(4, 'Elternbrief')] }) });
  assert.deepEqual((await c2.inbox()).map((m) => m.id), [3, 4]);
  answers.push({ status: 200, body: JSON.stringify({ readConfirmationMessages: [msg(5, 'Info')] }) });
  assert.deepEqual((await c2.inbox()).map((m) => m.id), [5], 'only the list to be confirmed');
  answers.push({ status: 200, body: JSON.stringify({ data: { incomingMessages: [], readConfirmationMessages: [msg(6, 'Info')] } }) });
  assert.deepEqual((await c2.inbox()).map((m) => m.id), [6]);
  answers.push({ status: 200, body: JSON.stringify({ incomingMessages: [], readConfirmationMessages: 'x' }) });
  assert.equal(await code(() => c2.inbox()), 'failed');
  const c3 = untis.createClient(gc, { host: 'nessa.webuntis.com', school: 'X', username: 'u', auth: 'password' });
  answers.push(login);
  await c3.login({ password: 'pw' });
  answers.push({ status: 403, body: '' });
  assert.equal(await code(() => c3.inbox()), 'no_right');
  answers.push({ status: 200, body: '<html>Login</html>' });
  assert.equal(await code(() => c3.inbox()), 'failed');
  assert.equal(untis.jwtOf(` ${JWT}\n`), JWT);
  assert.equal(untis.jwtOf(JSON.stringify({ token: JWT })), JWT);
  for (const bad of ['', 'abc', '"a.b"', '{"x":1}', null, 'a.b.c d']) assert.equal(untis.jwtOf(bad), null, String(bad));
});

test('parsing: HTML stripped to safe plain text, times, ids; absences with their excuse state', () => {
  const cfg = { tz: 'Europe/Berlin' };
  assert.equal(messages.stripHtml('<p>Liebe Eltern,<br>am <b>Do</b> &amp; Fr</p><script>alert(1)</script><style>p{x:1}</style><ul><li>Eins</li><li>Zwei</li></ul>'),
    'Liebe Eltern,\nam Do & Fr\n\n• Eins\n• Zwei');
  assert.equal(messages.stripHtml('&lt;b&gt;fett&lt;/b&gt; &#8364; &#x41; &auml;&nbsp;x &bogus; <!-- weg --><img src=x onerror=alert(1)>'), '<b>fett</b> € A ä x &bogus;', 'entities decoded after the tags are gone: text, never markup');
  assert.equal(messages.stripHtml('a<script>never closed'), 'a');
  assert.equal(messages.stripHtml(null), '');
  assert.equal(messages.stripHtml('x'.repeat(50), 10), 'xxxxxxxxx…');
  assert.equal(messages.parseSent('2026-10-20T09:30:00Z', cfg), at('2026-10-20T09:30:00Z'));
  assert.equal(messages.parseSent('2026-10-20T09:30:00+0200', cfg), at('2026-10-20T07:30:00Z'));
  assert.equal(messages.parseSent('2026-10-20T09:30', cfg), at('2026-10-20T07:30:00Z'), 'a local time is the school’s');
  assert.equal(messages.parseSent(1792483200000, cfg), 1792483200000);
  assert.equal(messages.parseSent('morgen', cfg), null);
  assert.equal(messages.parseSent('2026-02-30T09:30', cfg), null);
  const rows = messages.messageRows([
    msg(1, '  Eltern<b>abend</b> ', { contentPreview: '<p>Am Donnerstag&nbsp;um 19 Uhr</p>', hasAttachments: true }),
    msg(1, 'doppelt'),
    msg('x y', 'kaputte id'),
    { subject: 'ohne id' },
    msg(2, '', { sender: null, contentPreview: '', content: '<div>Ganzer <i>Text</i></div><div>Zeile 2</div>', sentDateTime: null }),
    'Unsinn', null,
  ], cfg);
  assert.deepEqual(rows, [
    { msg_id: '1', subject: 'Elternabend', preview: 'Am Donnerstag um 19 Uhr', body: null, sender: 'Frau Schmidt', sent_at: at('2026-10-19T16:00:00Z'), has_attachments: true, confirm: false },
    { msg_id: '2', subject: '', preview: 'Ganzer Text Zeile 2', body: 'Ganzer Text\nZeile 2', sender: '', sent_at: null, has_attachments: false, confirm: false },
  ]);
  assert.deepEqual(messages.messageRows({ incomingMessages: 'x' }, cfg), []);

  const ab = absences.absenceRows([
    absence(1, 20261013),
    absence(2, 20261014, { endDate: 20261016, startTime: 0, endTime: 0, reason: '', text: 'Kur', isExcused: true }),
    absence(3, 20261015, { excuseStatus: 'nicht entsch.', isExcused: false }),
    absence(4, 20261015, { excuse: { id: 12, excuseStatus: 'ne', isExcused: false } }),
    absence(5, 20261016, { excuseStatus: 'offen' }),
    absence(6, 20261016, { excuse: { id: 13, excuseStatus: 'e', isExcused: true } }),
    absence(7, 20261016, { studentId: 102 }),
    absence(8, 'kaputt'),
    absence(1, 20261013),
  ], 101);
  assert.deepEqual(ab.map((a) => [a.abs_id, a.date, a.end_date, a.t_start, a.t_end, a.reason, a.text, a.excused]), [
    ['1', '2026-10-13', null, '08:00', '11:35', 'Krankheit', null, null],
    ['2', '2026-10-14', '2026-10-16', null, null, null, 'Kur', true],
    ['3', '2026-10-15', null, '08:00', '11:35', 'Krankheit', null, false],
    ['4', '2026-10-15', null, '08:00', '11:35', 'Krankheit', null, false],
    ['5', '2026-10-16', null, '08:00', '11:35', 'Krankheit', null, null],
    ['6', '2026-10-16', null, '08:00', '11:35', 'Krankheit', null, true],
  ]);
  assert.equal(absences.schoolYearStart('2026-10-20'), '2026-08-01');
  assert.equal(absences.schoolYearStart('2027-03-01'), '2026-08-01');
  assert.equal(absences.schoolYearStart('2027-08-01'), '2027-08-01');
});

test('messages: the parents’ inbox — baseline without pushes, then one push per new message to the recipients, never to the child; never twice', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [msg(1, 'Wandertag'), msg(2, 'Elternabend')];
  const { lena } = await setupParent(host);
  // the account's first fetch: token, then the inbox with the bearer header — the baseline
  const q = untis.state.queries.filter((x) => x.kind === 'token' || x.kind === 'messages');
  assert.deepEqual(q.map((x) => x.kind), ['token', 'messages']);
  assert.match(q[1].authorization, /^Bearer eyJ/);
  assert.equal(pushes(host, 'messages').length, 0, 'baseline: nothing pushed');
  let r = await app(host, EVA, '/app/messages');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.messages.map((m) => [m.subject, m.isNew]), [['Elternabend', false], ['Wandertag', false]], 'the same time: the higher id first');

  // a new message 15 minutes later (sent now — newest first)
  untis.state.inbox.unshift(msg(3, 'Hitzefrei <b>morgen</b>', { contentPreview: 'Die Schule endet um 11:30&nbsp;Uhr.', sentDateTime: '2026-10-20T06:10:00Z', hasAttachments: true }));
  await tickAt(host, T0 + 15 * MIN);
  const p = pushes(host, 'messages');
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].title, p[0].body, p[0].users], ['Schule: Hitzefrei morgen', 'Frau Schmidt: Die Schule endet um 11:30 Uhr.', [EVA.id]], 'the recipient only — not Lena (a child via the parents’ inbox), not the admin');
  const acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.deepEqual(p[0].data.schule, { messageId: `${acc.id}-3` }, 'two children in the account: no studentId');

  // the app: newest first, the shape of the contract
  r = await app(host, EVA, '/app/messages', { days: '30' });
  assert.deepEqual(r.json.messages[0], {
    id: `${acc.id}-3`, accountId: acc.id, studentIds: [lena.id], subject: 'Hitzefrei morgen', preview: 'Die Schule endet um 11:30 Uhr.',
    sender: 'Frau Schmidt', sentAt: '2026-10-20T06:10:00.000Z', hasAttachments: true, isNew: true,
    // 1.5.0 (no detail in this fake WebUntis: the preview only)
    fullText: false, attachments: [], read: false, confirmation: null,
  });
  assert.deepEqual(r.json.messages.map((m) => m.id), [`${acc.id}-3`, `${acc.id}-2`, `${acc.id}-1`]);
  // the admin sees both children of the account; Lena (the child) and Bob see nothing
  assert.deepEqual((await app(host, ADMIN, '/app/messages')).json.messages[0].studentIds.length, 2);
  assert.deepEqual((await app(host, LENA, '/app/messages')).json, { ok: true, messages: [], drive: false });
  assert.deepEqual((await app(host, BOB, '/app/messages')).json, { ok: true, messages: [], drive: false });

  // the next cycles: the same messages are no news; nothing is written to WebUntis (only GETs)
  await tickAt(host, T0 + 30 * MIN);
  await tickAt(host, T0 + 45 * MIN);
  assert.equal(pushes(host, 'messages').length, 1, 'never twice');
  host.plugin._state.notifier = null; // a restart
  await tickAt(host, T0 + 60 * MIN);
  assert.equal(pushes(host, 'messages').length, 1);
  assert.ok(host.fetches.filter((f) => /\/api\/(rest|token)\//.test(f.url)).every((f) => (f.opts.method || 'GET') === 'GET'));
  // 1.5.0: new until opened (per person), at most 14 days
  clock.set(T0 + 15 * MIN + DAY + MIN);
  assert.equal((await app(host, EVA, '/app/messages')).json.messages[0].isNew, true, 'not opened yet');
  clock.set(T0 + 15 * MIN + 14 * DAY + MIN);
  assert.equal((await app(host, EVA, '/app/messages')).json.messages[0].isNew, false, 'older than 14 days');
}));

test('1.4.1: a school-wide message to be confirmed (its own list) is pushed too; an older one found only now is not', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [msg(1, 'Wandertag')];
  await setupParent(host);
  assert.equal(pushes(host, 'messages').length, 0, 'baseline');
  // the school writes to all parents and wants it confirmed — sent now; and an old one in that list (5 days ago)
  untis.state.confirm = [
    msg(20, 'Information der Schulleitung', { sentDateTime: '2026-10-20T06:05:00Z' }),
    msg(19, 'Elternbrief September', { sentDateTime: '2026-10-15T09:00:00Z' }),
  ];
  await tickAt(host, T0 + 15 * MIN);
  const p = pushes(host, 'messages');
  assert.deepEqual(p.map((x) => x.title), ['Schule: Information der Schulleitung'], 'the new one only — the old one is no news');
  assert.deepEqual(p[0].users, [EVA.id]);
  const list = (await app(host, EVA, '/app/messages')).json.messages.map((m) => [m.subject, m.isNew]);
  assert.deepEqual(list, [['Information der Schulleitung', true], ['Wandertag', false], ['Elternbrief September', false]]);
}));

test('messages: at most every 15 minutes per account; four new ones → three pushes and a summary; with one child the studentId', () => withHost({ ...SCHOOL, settings: { poll_minutes: 5 } }, async (host, untis) => {
  const { max } = await setupParent(host);
  // only Lena in the account: Max switched off
  await asAdmin(host, 'PUT', `/students/${max.id}`, { enabled: false });
  const lenaId = (await asAdmin(host, 'GET', '/status')).json.accounts[0].students.find((s) => s.person_id === 101).id;
  const tokens = () => untis.state.calls.filter((c) => c === 'token').length;
  assert.equal(tokens(), 1);
  untis.state.inbox = [msg(11, 'Eins'), msg(12, 'Zwei'), msg(13, 'Drei'), msg(14, 'Vier'), msg(15, 'Fünf')];
  await tickAt(host, T0 + 5 * MIN);
  await tickAt(host, T0 + 10 * MIN);
  assert.equal(tokens(), 1, 'not before 15 minutes');
  assert.equal(pushes(host, 'messages').length, 0);
  await tickAt(host, T0 + 15 * MIN);
  assert.equal(tokens(), 2);
  const p = pushes(host, 'messages');
  assert.deepEqual(p.map((n) => n.title), ['Schule: Eins', 'Schule: Zwei', 'Schule: Drei', 'Schule: 2 weitere Nachrichten']);
  assert.equal(p[3].body, 'Frau Schmidt: Vier\nFrau Schmidt: Fünf');
  assert.deepEqual(p[0].data.schule, { messageId: p[0].data.schule.messageId, studentId: lenaId });
  await tickAt(host, T0 + 20 * MIN);
  assert.equal(pushes(host, 'messages').length, 4);
}));

test('messages: quiet hours hold them until the end; English', async () => {
  await withHost(SCHOOL, async (host, untis) => {
    await setupParent(host);
    untis.state.inbox = [msg(21, 'Spät', { sentDateTime: '2026-10-20T19:55:00Z' })];
    await tickAt(host, at('2026-10-20T20:00:00Z')); // 22:00, quiet
    assert.equal(pushes(host, 'messages').length, 0);
    await tickAt(host, at('2026-10-21T03:59:00Z')); // 05:59
    assert.equal(pushes(host, 'messages').length, 0);
    await tickAt(host, at('2026-10-21T04:00:00Z')); // 06:00
    assert.deepEqual(pushes(host, 'messages').map((n) => n.title), ['Schule: Spät']);
  });
  await withHost({ ...SCHOOL, settings: { notify_lang: 'en' } }, async (host, untis) => {
    await setupParent(host);
    untis.state.inbox = [msg(22, '', { contentPreview: '' })];
    await tickAt(host, T0 + 15 * MIN);
    assert.deepEqual(pushes(host, 'messages').map((n) => [n.title, n.body]), [['School: (no subject)', 'Frau Schmidt']]);
  });
});

test('messages: a student’s own account — the student reads and gets them', () => withHost({ untis: { account: 'student', username: 'lena.muster', school: true } }, async (host, untis) => {
  untis.state.inbox = [msg(31, 'Alt')];
  const viewer = { ...LENA, portal: true, loggedIn: true };
  const r = await host.request({ method: 'POST', path: '/portal/link', query: {}, body: { mode: 'qr', link: QR_LENA }, user: viewer });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual((await app(host, LENA, '/app/messages')).json.messages.map((m) => [m.subject, m.studentIds]), [['Alt', [r.json.student.id]]]);
  assert.deepEqual((await app(host, EVA, '/app/messages')).json.messages, []);
  untis.state.inbox.push(msg(32, 'Neu'));
  await tickAt(host, T0 + 15 * MIN);
  assert.deepEqual(pushes(host, 'messages').map((n) => [n.title, n.users, n.data.schule.studentId]), [['Schule: Neu', [LENA.id], r.json.student.id]]);
  // a kiosk device and a viewer known by device trust only: nothing
  assert.deepEqual((await asPortal(host, LENA, '/portal/overview', {}, { kiosk: true })).json.students.every((s) => !s.messages), true);
  assert.equal(messages.canViewMessages({ id: 1, person_type: 5 }, [{ account_id: 1, enabled: true, missing: false, recipients: [], user_id: 3 }], { id: 3, loggedIn: false }), false);
}));

test('absences: baseline, then new and changed ones to the recipients (the child only with the setting); the child sees its own', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.absences[101] = [absence(1, 20261013, { isExcused: true })];
  untis.state.absences[102] = [absence(2, 20261014, { studentName: 'Max Muster' })];
  const { lena } = await setupParent(host);
  const aq = untis.state.queries.filter((x) => x.kind === 'absences').map((x) => x.query);
  assert.deepEqual(aq.map((q) => [q.studentId, q.startDate, q.endDate, q.excuseStatusId]), [['101', '20260801', '20261103', '-1'], ['102', '20260801', '20261103', '-1']], 'the school year, per child');
  assert.equal(pushes(host, 'absences').length, 0, 'baseline');
  // new: recorded today; changed: yesterday's is excused now
  untis.state.absences[101].push(absence(3, 20261020, { startTime: 800, endTime: 935, reason: 'Arzttermin' }));
  await tickAt(host, T0 + 15 * MIN);
  assert.equal(pushes(host, 'absences').length, 0, 'at most hourly');
  await tickAt(host, T0 + HOUR);
  let p = pushes(host, 'absences');
  assert.deepEqual(p.map((n) => [n.title, n.body, n.users, n.data.schule]), [
    ['Lena Muster: Fehlzeit eingetragen', 'Di 20.10. 08:00–09:35 · Arzttermin · offen', [EVA.id], { studentId: lena.id, date: '2026-10-20' }],
  ]);
  untis.state.absences[101][1].isExcused = true;
  untis.state.absences[101][1].text = 'Attest liegt vor';
  untis.state.absences[101].push(absence(4, 20261019));
  await tickAt(host, T0 + 2 * HOUR);
  p = pushes(host, 'absences');
  assert.equal(p.length, 2);
  assert.deepEqual([p[1].title, p[1].body], ['Lena Muster: 2 Fehlzeiten neu oder geändert', 'Entschuldigt: Di 20.10. 08:00–09:35 · Arzttermin · entschuldigt\nNeu: Mo 19.10. 08:00–11:35 · Krankheit · offen']);
  // nothing changed: nothing pushed
  await tickAt(host, T0 + 3 * HOUR);
  assert.equal(pushes(host, 'absences').length, 2);

  // the app: newest first, the contract's shape; Lena sees her own, Eva Lena's, Bob nothing, the admin all
  const r = await app(host, LENA, '/app/absences', { days: '60' });
  assert.deepEqual(r.json.absences, [
    { id: `${lena.id}-3`, studentId: lena.id, date: '2026-10-20', start: '08:00', end: '09:35', reason: 'Arzttermin', excused: true, text: 'Attest liegt vor' },
    { id: `${lena.id}-4`, studentId: lena.id, date: '2026-10-19', start: '08:00', end: '11:35', reason: 'Krankheit', excused: null },
    { id: `${lena.id}-1`, studentId: lena.id, date: '2026-10-13', start: '08:00', end: '11:35', reason: 'Krankheit', excused: true },
  ]);
  assert.equal((await app(host, EVA, '/app/absences')).json.absences.length, 3);
  assert.deepEqual((await app(host, BOB, '/app/absences')).json.absences, []);
  assert.equal((await app(host, ADMIN, '/app/absences')).json.absences.length, 4);
  assert.deepEqual((await app(host, EVA, '/app/absences', { days: '3' })).json.absences.map((a) => a.date), ['2026-10-20', '2026-10-19']);
  // an absence WebUntis no longer lists is gone
  untis.state.absences[101] = untis.state.absences[101].filter((a) => a.id !== 4);
  await tickAt(host, T0 + 4 * HOUR);
  assert.equal((await app(host, LENA, '/app/absences')).json.absences.length, 2);
  assert.equal(pushes(host, 'absences').length, 2);
}));

test('absences: absence_notify_child also tells the child; quiet hours hold them', () => withHost({ ...SCHOOL, settings: { absence_notify_child: true } }, async (host, untis) => {
  untis.state.absences[101] = [];
  await setupParent(host);
  untis.state.absences[101].push(absence(5, 20261020, { excuseStatus: 'nicht entschuldigt' }));
  await tickAt(host, at('2026-10-20T19:30:00Z')); // 21:30 — quiet
  assert.equal(pushes(host, 'absences').length, 0);
  await tickAt(host, at('2026-10-21T04:00:00Z')); // 06:00
  const p = pushes(host, 'absences');
  assert.deepEqual(p.map((n) => [n.title, n.users]), [['Lena Muster: Fehlzeit eingetragen', [LENA.id, EVA.id]]]);
  assert.match(p[0].body, /nicht entschuldigt$/);
}));

test('403 / 404 never break the timetable: paused like homework, said in words in the settings; changes are pushed as ever', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.schoolStatus = { token: 403, absences: 404 };
  await setupParent(host);
  let acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.deepEqual([acc.status, acc.last_error], ['ok', null]);
  const ex = (await store.getAccount(host.gc, acc.id)).extras;
  assert.deepEqual([ex.messages, ex.absences], [{ code: 'no_right', until: T0 + DAY }, { code: 'unsupported', until: T0 + DAY }]);
  assert.deepEqual(acc.school_info.map((x) => [x.kind, x.tone, x.text]), [
    ['messages', 'info', 'Nachrichten der Schule sind für dieses Konto in WebUntis nicht freigegeben. GateControl schaut einmal am Tag wieder nach.'],
    ['absences', 'info', 'Diese WebUntis-Version bietet keine Fehlzeiten an. GateControl schaut einmal am Tag wieder nach.'],
  ]);
  assert.deepEqual(acc.extras_info, [], 'homework and exams untouched');
  // the timetable goes on; the paused endpoints are not asked
  untis.state.calls.length = 0;
  untis.state.timetable[101].find((l) => l.date === 20261020 && l.startTime === 950).code = 'cancelled';
  await tickAt(host, T0 + 15 * MIN);
  assert.ok(!untis.state.calls.some((c) => ['token', 'messages', 'absences'].includes(c)));
  assert.equal(pushes(host, 'changes').length, 1);
  // a day later: asked again; fine now → plain words with when and how many
  untis.state.schoolStatus = {};
  untis.state.inbox = [msg(41, 'Hallo')];
  untis.state.absences[101] = [absence(1, 20261013)];
  await tickAt(host, T0 + DAY + MIN);
  acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.deepEqual(acc.school_info.map((x) => [x.kind, x.tone, x.text]), [
    ['messages', 'good', 'Nachrichten der Schule: zuletzt gelesen 21.10. 08:01 · 1 gespeichert.'],
    ['absences', 'good', 'Fehlzeiten: zuletzt gelesen 21.10. 08:01 · 1 in diesem Schuljahr.'],
  ]);
  assert.equal(pushes(host, 'messages').length, 0, 'the first good fetch is the baseline');
  // a 5xx: tried in the next cycle (no pause); another failure: 6 hours, a warning
  untis.state.schoolStatus = { messages: 500 };
  await tickAt(host, T0 + DAY + 20 * MIN);
  assert.equal((await store.getAccount(host.gc, acc.id)).extras.messages, undefined);
  assert.equal((await asAdmin(host, 'GET', '/status')).json.accounts[0].status, 'ok');
  untis.state.schoolStatus = {};
  untis.state.tokenForm = 'garbage';
  await tickAt(host, T0 + DAY + 40 * MIN);
  acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.deepEqual([acc.school_info[0].tone, acc.school_info[0].text], ['warn', 'Nachrichten der Schule konnten zuletzt nicht gelesen werden – neuer Versuch am 21.10. 14:40.']);
  assert.ok(!JSON.stringify(acc.school_info).match(/no_right|unsupported|failed/), 'no codes for people');
}));

test('the fake without the school endpoints (an older WebUntis): the cycle stays fine, the state is shown', () => withHost({}, async (host) => {
  await setupParent(host);
  const acc = (await asAdmin(host, 'GET', '/status')).json.accounts[0];
  assert.equal(acc.status, 'ok');
  assert.deepEqual(acc.school_info.map((x) => x.tone), ['warn', 'warn']);
}));

test('app API: days checked (messages 1…90, absences 1…180), at most 100 messages / 200 absences, devices only with the app flag', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = Array.from({ length: 120 }, (_, i) => msg(100 + i, `M${i}`, { sentDateTime: new Date(T0 - i * HOUR).toISOString() }));
  untis.state.absences[101] = Array.from({ length: 230 }, (_, i) => absence(1000 + i, Number(new Date(Date.UTC(2026, 9, 20) - (i % 75) * DAY).toISOString().slice(0, 10).replace(/-/g, ''))));
  await setupParent(host);
  for (const [p, bad, good] of [['/app/messages', ['0', '91', 'x', '-1', '1.5'], ['1', '90']], ['/app/absences', ['0', '181', 'abc'], ['1', '180']]]) {
    for (const d of bad) assert.equal((await app(host, EVA, p, { days: d })).status, 400, `${p} ${d}`);
    for (const d of good) assert.equal((await app(host, EVA, p, { days: d })).status, 200, `${p} ${d}`);
  }
  const m = (await app(host, EVA, '/app/messages', { days: '90' })).json.messages;
  assert.equal(m.length, 100);
  assert.ok(m.every((x, i) => i === 0 || x.sentAt <= m[i - 1].sentAt), 'newest first');
  assert.equal((await app(host, EVA, '/app/messages', { days: '1' })).json.messages.length, 25, 'sent within the last 24 hours (inclusive)');
  const a = (await app(host, EVA, '/app/absences', { days: '180' })).json.absences;
  assert.equal(a.length, 200);
  assert.ok(a.every((x, i) => i === 0 || x.date <= a[i - 1].date), 'newest first');
  for (const x of a) assert.deepEqual(Object.keys(x), ['id', 'studentId', 'date', 'start', 'end', 'reason', 'excused']);
  // the app routes need the app flag; a portal viewer is refused there
  assert.equal((await asPortal(host, EVA, '/app/messages')).status, 403);
}));

test('Schule page and portal: per child its messages (only who may read the inbox) and absences; the Start tile names new messages', () => withHost({ ...SCHOOL, untis: { school: true } }, async (host, untis) => {
  untis.state.absences[101] = [absence(1, 20261013, { excuseStatus: 'offen' })];
  const { lena } = await setupParent(host, { wall: true });
  untis.state.inbox = [msg(51, 'Elternabend', { contentPreview: 'Am Do', content: '<p>Am Donnerstag um 19 Uhr.</p>' })];
  await tickAt(host, T0 + 15 * MIN);
  const kid = (r) => r.json.students.find((s) => s.id === lena.id);
  // Eva (recipient): both
  let r = await asPortal(host, EVA, '/portal/overview');
  assert.deepEqual(kid(r).messages.map((m) => [m.subject, m.body, m.isNew]), [['Elternabend', 'Am Donnerstag um 19 Uhr.', true]]);
  assert.deepEqual(kid(r).absences.map((a) => [a.date, a.excused]), [['2026-10-13', null]]);
  // Lena (the child): her absences, not her parents' inbox
  r = await asPortal(host, LENA, '/portal/overview');
  assert.equal(kid(r).messages, undefined);
  assert.equal(kid(r).absences.length, 1);
  // the wall tablet: neither
  r = await asPortal(host, WALL, '/portal/overview', {}, { kiosk: true });
  assert.deepEqual([kid(r).messages, kid(r).absences], [undefined, undefined]);
  // the admin page: both, for every child
  r = await asAdmin(host, 'GET', '/overview');
  assert.ok(r.json.students.every((s) => Array.isArray(s.messages) && Array.isArray(s.absences)));
  // Start tile: Eva sees „1 neue Nachricht“, Lena does not
  const tile = (await host.portalTiles({ ...EVA, portal: true, loggedIn: true }))[0];
  assert.deepEqual(tile.items.map((i) => [i.label, i.value]).find((x) => x[0] === '1 neue Nachricht'), ['1 neue Nachricht', 'Elternabend']);
  const lt = (await host.portalTiles({ ...LENA, portal: true, loggedIn: true }))[0];
  assert.ok(!lt.items.some((i) => /Nachricht/.test(i.label)));
}));

test('housekeeping: messages older than 90 days and absences before the school year (at least 180 days) are pruned; deleting an account removes both', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [msg(61, 'Neu'), msg(62, 'Uralt', { sentDateTime: '2026-06-01T08:00:00Z' })];
  untis.state.absences[101] = [absence(1, 20261013)];
  const { account, lena } = await setupParent(host);
  assert.deepEqual((await app(host, ADMIN, '/app/messages', { days: '90' })).json.messages.map((m) => m.subject), ['Neu'], 'never stored: it would come back as new');
  await host.gc.db.run("INSERT INTO absences (student_id, abs_id, date, sig, detected_at, changed_at, status) VALUES (?, 'old', '2026-05-04', '[]', 0, 0, 'baseline')", [lena.id]);
  await host.gc.db.run("INSERT INTO absences (student_id, abs_id, date, sig, detected_at, changed_at, status) VALUES (?, 'older', '2026-02-01', '[]', 0, 0, 'baseline')", [lena.id]);
  host.plugin._state.lastPrune = 0;
  await tickAt(host, T0 + 15 * MIN);
  const ids = (await host.gc.db.query('SELECT abs_id FROM absences WHERE student_id = ? ORDER BY abs_id', [lena.id])).rows.map((x) => x.abs_id);
  assert.deepEqual(ids, ['1', 'old'], 'before the school year but within 180 days: kept');
  assert.equal(absences.keepFrom(T0, { tz: 'Europe/Berlin' }), '2026-04-23');
  await asAdmin(host, 'DELETE', `/accounts/${account.id}`);
  assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM messages')).rows[0].n, 0);
  assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM absences')).rows[0].n, 0);
}));
