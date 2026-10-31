'use strict';

// Calendars and contacts of Microsoft accounts (Graph, C5.1) against a fake Graph: the scopes of a sign-in and the
// renewal only with granted ones (an account of 1.1 keeps its mail), consent_required without the calendar scope, the
// default calendar by delta (series, exceptions, @removed), another calendar by calendarView, writing with If-Match
// (412 → conflict), Teams, answers, contacts by delta with photos.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');
const pim = require('../server/pim');
const tz = require('../server/tz');

const BERLIN = 'Europe/Berlin';
const at = (date, hh, mm = 0) => tz.toUtc({ ...tz.parseDate(date), hh, mm }, BERLIN);
const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const PHASE1 = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';

function graphWorld() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const st = { granted: `${PHASE1} https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.ReadWrite`, refreshScopes: [], posted: [], patched: [], deleted: [], actions: [], contactsPatched: [], photos: [] };
  const iso = (ms) => new Date(ms).toISOString().replace('Z', '0000');
  const dt = (ms) => ({ dateTime: iso(ms), timeZone: 'UTC' });
  const base = (id, o) => ({
    id, type: o.type || 'singleInstance', seriesMasterId: o.series || null, originalStart: o.orig ? new Date(o.orig).toISOString() : null, subject: o.subject, start: dt(o.start), end: dt(o.end),
    isAllDay: false, location: { displayName: o.location || '' }, attendees: o.attendees || [], organizer: { emailAddress: { name: 'Anna', address: 'anna@firma.example' } }, isOrganizer: o.isOrganizer !== false,
    responseStatus: { response: o.response || 'organizer' }, showAs: 'busy', sensitivity: 'normal', isCancelled: false, isReminderOn: true, reminderMinutesBeforeStart: 15,
    changeKey: o.ck || 'ck1', '@odata.etag': `W/"${o.ck || 'ck1'}"`, originalStartTimeZone: 'W. Europe Standard Time', body: { contentType: 'html', content: o.html || '<p>Agenda</p>' },
  });
  const s0 = at('2026-11-02', 9);
  st.events = new Map([
    ['E1', base('E1', { subject: 'Kundentermin', start: at('2026-11-05', 14), end: at('2026-11-05', 15), location: 'Büro' })],
    ['S1-1', base('S1-1', { type: 'occurrence', series: 'S1', orig: s0, subject: 'Daily', start: s0, end: s0 + 900000 })],
    ['S1-2', base('S1-2', { type: 'exception', series: 'S1', orig: s0 + 86400000, subject: 'Daily (verschoben)', start: s0 + 86400000 + 3600000, end: s0 + 86400000 + 4500000 })],
    ['S1-3', base('S1-3', { type: 'occurrence', series: 'S1', orig: s0 + 2 * 86400000, subject: 'Daily', start: s0 + 2 * 86400000, end: s0 + 2 * 86400000 + 900000 })],
  ]);
  st.master = { S1: { ...base('S1', { subject: 'Daily', start: s0, end: s0 + 900000 }), type: 'seriesMaster', recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'numbered', startDate: '2026-11-02', numberOfOccurrences: 3 } } } };
  st.holidays = [base('H1', { subject: 'Feiertag', start: at('2026-11-11', 0), end: at('2026-11-12', 0), isOrganizer: false, response: 'none' })];
  st.delta = 0; // the rounds of the default calendar
  st.contacts = [{ id: 'K1', changeKey: 'k1', displayName: 'Chef Boss', givenName: 'Chef', surname: 'Boss', emailAddresses: [{ address: 'chef@firma.example' }], mobilePhone: '+49 171 222', companyName: 'Firma', jobTitle: 'CEO' }];
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  st.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: st.granted, id_token: jwt({ email: 'anna@firma.example', tid: 'tenant-firma', name: 'Anna' }) });
      if (f.grant_type === 'refresh_token') {
        st.refreshScopes.push(f.scope);
        // asking for a scope that was never granted fails
        const asked = f.scope.split(' ').map((x) => x.replace('https://graph.microsoft.com/', ''));
        const have = st.granted.split(' ').map((x) => x.replace('https://graph.microsoft.com/', ''));
        if (asked.some((x) => !have.includes(x))) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: `AT-${st.refreshScopes.length + 1}`, expires_in: 3600 });
      }
      return json(400, { error: 'unsupported' });
    }
    const p = u.pathname.replace('/v1.0', '');
    const calOk = /Calendars\.ReadWrite/.test(st.granted);
    const conOk = /Contacts\.ReadWrite/.test(st.granted);
    // mail (empty)
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: ['inbox', 'sentitems'].map((x) => ({ id: `F-${x}`, displayName: x, childFolderCount: 0 })) });
    if (/\/messages(\/delta)?$/.test(p) && /mailFolders/.test(p)) return json(200, { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${p}?$deltatoken=t1` });
    if (/^\/me\/photos?/.test(p)) return json(404, { error: { code: 'ErrorItemNotFound' } });
    if (/^\/me\/(calendars|calendarView|events)/.test(p) && !calOk) return json(403, { error: { code: 'ErrorAccessDenied' } });
    if (/^\/me\/(contactFolders|contacts)/.test(p) && !conOk) return json(403, { error: { code: 'ErrorAccessDenied' } });
    if (p === '/me/calendars') return json(200, { value: [{ id: 'C-def', name: 'Kalender', hexColor: '#E74856', canEdit: true, isDefaultCalendar: true }, { id: 'C-hol', name: 'Feiertage', hexColor: '', canEdit: false, isDefaultCalendar: false }] });
    if (p === '/me/calendarView/delta') {
      if (u.searchParams.get('$deltatoken') === 'd2') {
        // the second round: one instance gone, the single event changed
        const removed = st.removeInSecond ? [{ id: st.removeInSecond, '@removed': { reason: 'deleted' } }] : [];
        return json(200, { value: [...removed, ...(st.changed || [])], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=d2' });
      }
      if (u.searchParams.get('$skiptoken') === 'p2') return json(200, { value: [...st.events.values()].slice(2), '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=d2' });
      st.delta++;
      return json(200, { value: [...st.events.values()].slice(0, 2), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=p2' });
    }
    if (p === '/me/calendars/C-hol/calendarView') return json(200, { value: st.holidays });
    if (p === '/me/calendars/C-def/events' && o.method === 'POST') {
      const id = `N${st.posted.length + 1}`;
      st.posted.push(o.json);
      const ev = base(id, { subject: o.json.subject, start: Date.parse(o.json.start.dateTime + 'Z') - 3600000, end: Date.parse(o.json.end.dateTime + 'Z') - 3600000 });
      if (o.json.isOnlineMeeting) ev.onlineMeeting = { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' };
      st.events.set(id, ev);
      return json(201, ev);
    }
    const one = /^\/me\/events\/([^/]+)$/.exec(p);
    if (one) {
      const ev = st.events.get(one[1]) || st.master[one[1]];
      if (!ev) return json(404, { error: { code: 'ErrorItemNotFound' } });
      if (o.method === 'GET') return json(200, ev);
      if (o.method === 'PATCH') {
        if (o.headers['if-match'] && o.headers['if-match'] !== ev['@odata.etag']) return json(412, { error: { code: 'ErrorIrresolvableConflict' } });
        st.patched.push({ id: one[1], body: o.json, ifMatch: o.headers['if-match'] || null });
        if (o.json.subject) ev.subject = o.json.subject;
        ev.changeKey = `${ev.changeKey}x`; ev['@odata.etag'] = `W/"${ev.changeKey}"`;
        return json(200, ev);
      }
      if (o.method === 'DELETE') { st.deleted.push(one[1]); st.events.delete(one[1]); return { status: 204, headers: {}, body: '' }; }
    }
    const act = /^\/me\/events\/([^/]+)\/(accept|tentativelyAccept|decline|cancel)$/.exec(p);
    if (act) { st.actions.push({ id: act[1], action: act[2], body: o.json }); return { status: 202, headers: {}, body: '' }; }
    if (/^\/me\/events\/[^/]+\/instances$/.test(p)) return json(200, { value: [] });
    if (p === '/me/contactFolders') return json(200, { value: [] });
    if (p === '/me/contacts') return json(200, { value: [{ parentFolderId: 'CF-def' }] });
    if (p === '/me/contactFolders/CF-def/contacts/delta') return json(200, { value: st.contacts, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contactFolders/CF-def/contacts/delta?$deltatoken=c2' });
    const ph = /^\/me\/contacts\/([^/]+)\/photo\/\$value$/.exec(p);
    if (ph && o.method === 'GET') return ph[1] === 'K1' ? { status: 200, headers: { 'content-type': 'image/jpeg' }, bodyBase64: Buffer.from('JPEGDATA').toString('base64') } : json(404, {});
    if (ph && o.method === 'PUT') { st.photos.push({ id: ph[1], bodyBase64: o.bodyBase64, type: o.headers['content-type'] }); return { status: 200, headers: {}, body: '' }; }
    const con = /^\/me\/contacts\/([^/]+)$/.exec(p);
    if (con && o.method === 'PATCH') { st.contactsPatched.push({ id: con[1], body: o.json }); return json(200, { ...st.contacts[0], ...o.json, id: con[1], changeKey: 'k2' }); }
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return st;
}

async function runs(host, n = 6) {
  // what is due again now (lists stay), then the runs go as they would — one step per account and run
  for (let k = 0; k < 20; k++) { const x = pim.lineOf(k); x.retryAt = 0; x.pause = 0; for (const key of Object.keys(x.last)) if (!/List$/.test(key)) x.last[key] = 0; }
  for (let i = 0; i < n; i++) {
    await host.tick();
    await settle(20);
  }
}

test('Microsoft: the scopes of a sign-in are kept, a token is only renewed with them; without the calendar scope: consent_required, the mail runs', async () => {
  const w = graphWorld();
  w.granted = PHASE1;
  await withMail({ gatecontrol: '1.219.0', fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const anna = c.as(ANNA);
    const auth = host.fetches.length;
    const r = await anna('POST', 'accounts/microsoft', { code: 'X', ...PKCE });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ask = host.fetches.slice(auth).find((f) => f.opts.form && f.opts.form.grant_type === 'authorization_code');
    assert.match(ask.opts.form.scope, /Calendars\.ReadWrite Contacts\.ReadWrite$/, 'the sign-in asks for them');
    const acc = r.json.account;
    assert.deepEqual(acc.missingScopes, ['Calendars.ReadWrite', 'Contacts.ReadWrite']);
    assert.equal(acc.calendar.state, 'consent_required');
    assert.equal(acc.contacts.state, 'consent_required');
    const row = (await host.gc.db.query('SELECT ms_scopes FROM accounts WHERE id = ?', [acc.id])).rows[0];
    assert.equal(row.ms_scopes, PHASE1);
    const cal = (await anna('GET', 'calendars')).json;
    assert.deepEqual(cal.consent, [{ accountId: acc.id, missing: ['Calendars.ReadWrite'] }]);
    // the token runs out: renewed with the granted scopes only — the mail goes on
    require('../server/microsoft').forget(acc.id);
    await runs(host, 2);
    assert.ok(w.refreshScopes.length >= 1);
    for (const s of w.refreshScopes) assert.ok(!/Calendars|Contacts/.test(s), s);
    assert.notEqual((await anna('GET', 'me')).json.accounts[0].state, 'auth_failed');
    // an account of 1.1 (no scopes kept): the scopes of Phase 1
    await host.gc.db.run('UPDATE accounts SET ms_scopes = NULL WHERE id = ?', [acc.id]);
    require('../server/microsoft').forget(acc.id);
    await runs(host, 1);
    assert.equal(w.refreshScopes[w.refreshScopes.length - 1], 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send');
    // signed in anew, the person allows calendars and contacts
    w.granted = `${PHASE1} Calendars.ReadWrite Contacts.ReadWrite`;
    const again = await anna('POST', `accounts/${acc.id}/microsoft`, { code: 'X', ...PKCE });
    assert.deepEqual(again.json.account.missingScopes, []);
    const me = (await anna('GET', 'me')).json;
    assert.equal(me.microsoft.adminConsentUrl, 'https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=11111111-2222-3333-4444-555555555555&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');
  });
});

test('Microsoft calendars: the default calendar by delta (a series with an exception, @removed), another one read only, writing with If-Match, Teams, answers', async () => {
  const w = graphWorld();
  await withMail({ gatecontrol: '1.219.0', fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const anna = c.as(ANNA);
    const acc = (await anna('POST', 'accounts/microsoft', { code: 'X', ...PKCE, kind: 'business' })).json.account;
    assert.equal(acc.provider, 'm365');
    await anna('GET', 'calendars');
    await runs(host, 8);
    const cals = (await anna('GET', 'calendars')).json.calendars;
    const def = cals.find((x) => x.source === 'graph' && x.isDefault);
    const hol = cals.find((x) => x.source === 'graph' && !x.isDefault);
    assert.deepEqual([def.name, def.color, def.kind, def.canOnline, def.maxReminders, def.state], ['Kalender', '#E74856', 'business', true, 1, 'ok']);
    assert.deepEqual([hol.name, hol.writable, hol.state], ['Feiertage', false, 'ok']);
    const range = { from: at('2026-11-01', 0), to: at('2026-11-30', 0) };
    let items = (await anna('GET', 'events', null, { ...range, calendars: `${def.id},${hol.id}` })).json.items;
    assert.deepEqual(items.map((x) => [x.title, x.recurring]), [['Daily', true], ['Daily (verschoben)', true], ['Daily', true], ['Kundentermin', false], ['Feiertag', false]]);
    const daily = items.filter((x) => x.recurring);
    assert.equal(new Set(daily.map((x) => x.eventId)).size, 1, 'one series');
    assert.equal(daily[1].occurrence, String(at('2026-11-03', 9)), 'the occurrence key: the original start');
    assert.equal(daily[0].reminder, 15);
    // the series in full: the master for the rule and the HTML text (sanitized)
    const s = (await anna('GET', `events/${daily[0].eventId}`)).json;
    assert.deepEqual([s.recurrence.freq, s.recurrence.count, s.descriptionHtml], ['daily', 3, '<p>Agenda</p>']);
    // 1.3.0: the series' own start and end (its master), also seen from one occurrence
    assert.deepEqual(s.series, { start: at('2026-11-02', 9), end: at('2026-11-02', 9) + 900000, allDay: false });
    assert.deepEqual((await anna('GET', `events/${daily[1].eventId}`, null, { occurrence: daily[1].occurrence })).json.series, s.series);
    // the second round: an instance removed
    w.removeInSecond = 'S1-3';
    await runs(host, 2);
    items = (await anna('GET', 'events', null, { ...range, calendars: String(def.id) })).json.items;
    assert.equal(items.filter((x) => x.recurring).length, 2);
    // a change with If-Match; 412 when Outlook changed the same field meanwhile
    const kt = items.find((x) => x.title === 'Kundentermin');
    const ok = await anna('PATCH', `events/${kt.eventId}`, { title: 'Kundentermin (neu)', reminders: [30] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual([w.patched[0].id, w.patched[0].ifMatch, w.patched[0].body.subject, w.patched[0].body.reminderMinutesBeforeStart], ['E1', 'W/"ck1"', 'Kundentermin (neu)', 30]);
    assert.equal((await anna('PATCH', `events/${kt.eventId}`, { reminders: [5, 10] })).json.error.code, 'not_supported', 'Graph keeps one reminder');
    w.events.get('E1').subject = 'Von Outlook'; w.events.get('E1')['@odata.etag'] = 'W/"other"';
    const k = await anna('PATCH', `events/${kt.eventId}`, { title: 'Meins' });
    assert.deepEqual([k.status, k.json.error.code], [409, 'conflict']);
    // new with Teams and attendees: Exchange sends the invitations
    const n = await anna('POST', 'events', { calendarId: def.id, title: 'Abstimmung', allDay: false, start: at('2026-11-10', 10), end: at('2026-11-10', 11), timeZone: BERLIN,
      online: { create: 'teams' }, attendees: [{ email: 'kollege@firma.example' }] });
    assert.equal(n.status, 200, JSON.stringify(n.json));
    const posted = w.posted[0];
    assert.deepEqual([posted.start.dateTime, posted.start.timeZone, posted.isOnlineMeeting, posted.onlineMeetingProvider, posted.attendees[0].emailAddress.address],
      ['2026-11-10T10:00:00', BERLIN, true, 'teamsForBusiness', 'kollege@firma.example']);
    assert.equal(n.json.event.online.provider, 'teams');
    assert.deepEqual(n.json.sent, { mail: 1, internal: 0 });
    // an invitation in Graph: answered through the event API
    w.events.get('E1').isOrganizer = false; w.events.get('E1').responseStatus = { response: 'notResponded' };
    await host.gc.db.run("UPDATE events SET my_response = 'needs_action' WHERE remote_id = 'E1'");
    const resp = await anna('POST', `events/${kt.eventId}/respond`, { response: 'tentative', comment: 'Vielleicht', proposeStart: at('2026-11-05', 16), proposeEnd: at('2026-11-05', 17) });
    assert.equal(resp.status, 200, JSON.stringify(resp.json));
    assert.deepEqual([w.actions[0].action, w.actions[0].body.comment, w.actions[0].body.sendResponse, !!w.actions[0].body.proposedNewTime], ['tentativelyAccept', 'Vielleicht', true, true]);
    // read only: the other calendar
    assert.equal((await anna('POST', 'events', { calendarId: hol.id, title: 'x', allDay: true, startDate: '2026-11-01' })).json.error.code, 'read_only');
    // the organizer deletes with notify: cancel { comment }
    const created = (await anna('GET', 'events', null, { from: at('2026-11-10', 0), to: at('2026-11-11', 0), calendars: String(def.id) })).json.items[0];
    await host.gc.db.run("UPDATE events SET attendees_json = ?, my_response = 'organizer' WHERE id = ?", [JSON.stringify([{ email: 'kollege@firma.example', name: '', role: 'required', response: 'needs_action' }]), created.eventId]);
    assert.equal((await anna('DELETE', `events/${created.eventId}`, null, { notify: '1', comment: 'Leider nicht' })).status, 200);
    assert.deepEqual(w.actions.slice(-1).map((x) => [x.action, x.body.comment]), [['cancel', 'Leider nicht']]);
  });
});

test('Microsoft contacts: the default folder by delta with its photo, a change goes to Graph; Graph has no groups — GateControl keeps them', async () => {
  const w = graphWorld();
  await withMail({ gatecontrol: '1.219.0', fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const anna = c.as(ANNA);
    await anna('POST', 'accounts/microsoft', { code: 'X', ...PKCE });
    await anna('GET', 'addressbooks');
    await runs(host, 8);
    const books = (await anna('GET', 'addressbooks')).json.items;
    const g = books.find((b) => b.source === 'graph');
    assert.deepEqual([g.name, g.count, g.state], ['anna@firma.example', 1, 'ok']);
    const card = (await anna('GET', 'cards', null, { book: String(g.id) })).json.items[0];
    assert.deepEqual([card.name, card.company, card.title, card.phone, card.photo], ['Chef Boss', 'Firma', 'CEO', '+49 171 222', true]);
    assert.equal(Buffer.from((await anna('GET', `cards/${card.id}/photo`)).json.data, 'base64').toString(), 'JPEGDATA');
    const p = await anna('PATCH', `cards/${card.id}`, { title: 'Geschäftsführer' });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual([w.contactsPatched[0].id, w.contactsPatched[0].body.jobTitle], ['K1', 'Geschäftsführer']);
    const grp = (await anna('POST', 'groups', { name: 'Chefs' })).json.group;
    const mem = (await anna('POST', `groups/${grp.id}/members`, { add: [{ contactId: card.id }, { email: 'extra@example.com', name: 'Extra' }] })).json;
    assert.deepEqual(mem.members.map((x) => x.email), ['chef@firma.example', 'extra@example.com']);
  });
});
