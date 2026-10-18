'use strict';

// 1.4.0: polls (vote, options, close, nudge, closesAt) and events (RSVP, checklist, edit/cancel,
// nextEvent, reminder and departure pushes, Familie calendar).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, MIN, HOUR, T0 } = require('./helpers');

const iso = (ms) => new Date(ms).toISOString();

test('poll: send, vote (single / multi / withdraw), add options, anonymous, close with winner', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    const m = await c.send(ANNA, g.id, { kind: 'poll', poll: { question: 'Pizza oder Pasta?', options: ['Pizza', 'Pasta'], allowAdd: true } });
    assert.equal(m.kind, 'poll');
    assert.equal(m.text, null);
    assert.deepEqual(m.poll.options.map((o) => [o.id, o.text, o.count]), [['o1', 'Pizza', 0], ['o2', 'Pasta', 0]]);
    assert.deepEqual([m.poll.multi, m.poll.anonymous, m.poll.allowAdd, m.poll.closed, m.poll.memberCount, m.poll.voterCount], [false, false, true, false, 3, 0]);
    assert.equal(c.pushes().pop().body, '📊 Umfrage: Pizza oder Pasta?');
    const marc = c.as(MARC);
    c.resetEvents();
    let r = await marc('POST', `messages/${m.id}/vote`, { optionIds: ['o2'] });
    assert.deepEqual([r.json.message.poll.myVotes, r.json.message.poll.options[1].voters, r.json.message.poll.voterCount], [['o2'], [MARC.id], 1]);
    assert.equal(c.events('poll.update').length, 1);
    assert.equal((await marc('POST', `messages/${m.id}/vote`, { optionIds: ['o1', 'o2'] })).json.code, 'invalid', 'single choice');
    assert.equal((await marc('POST', `messages/${m.id}/vote`, { optionIds: ['o9'] })).json.code, 'invalid');
    r = await c.as(LENA)('POST', `messages/${m.id}/options`, { text: 'Burger' });
    assert.deepEqual(r.json.message.poll.options.map((o) => [o.id, o.text, o.addedBy]), [['o1', 'Pizza', null], ['o2', 'Pasta', null], ['o3', 'Burger', LENA.id]]);
    assert.equal((await c.as(LENA)('POST', `messages/${m.id}/options`, { text: 'burger' })).json.code, 'invalid', 'not twice');
    await c.as(LENA)('POST', `messages/${m.id}/vote`, { optionIds: ['o2'] });
    await c.as(ANNA)('POST', `messages/${m.id}/vote`, { optionIds: ['o1'] });
    r = await c.as(ANNA)('POST', `messages/${m.id}/vote`, { optionIds: [] });
    assert.deepEqual(r.json.message.poll.myVotes, [], 'withdrawn');
    assert.equal((await marc('POST', `messages/${m.id}/close`)).json.code, 'not_allowed');
    r = await c.as(ANNA)('POST', `messages/${m.id}/close`);
    assert.equal(r.json.message.poll.closed, true);
    const msgs = (await marc('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.deepEqual(msgs.pop().system, { event: 'poll_closed', by: ANNA.id, messageId: m.id, question: 'Pizza oder Pasta?', winner: 'Pasta', winners: ['Pasta'], votes: 2 });
    assert.equal((await marc('POST', `messages/${m.id}/vote`, { optionIds: ['o1'] })).json.code, 'closed');
    // anonymous + multi: no voters
    const a = await c.send(ANNA, g.id, { kind: 'poll', poll: { question: 'Wann?', options: ['Sa', 'So', 'Mo'], multi: true, anonymous: true } });
    r = await marc('POST', `messages/${a.id}/vote`, { optionIds: ['o1', 'o2'] });
    assert.deepEqual(r.json.message.poll.options.map((o) => [o.count, o.voters]), [[1, undefined], [1, undefined], [0, undefined]]);
    assert.equal((await marc('POST', `messages/${a.id}/options`, { text: 'Di' })).json.code, 'not_allowed');
    for (const bad of [{ question: '', options: ['a', 'b'] }, { question: 'x', options: ['a'] }, { question: 'x', options: new Array(13).fill(0).map((_, i) => 'o' + i) }, { question: 'x', options: ['a', 'A'] }, { question: 'x', options: ['a', 'b'], closesAt: iso(T0 - 1) }]) {
      assert.equal((await c.as(ANNA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'poll', poll: bad })).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal((await c.as(ANNA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'poll', poll: { question: 'x', options: ['a', 'b'] }, text: 'x' })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('PATCH', `messages/${a.id}`, { text: 'x' })).json.code, 'invalid', 'polls are not edited');
    // stored encrypted
    const row = await host.gc.db.get('SELECT meta_enc FROM messages WHERE id = ?', [a.id]);
    assert.ok(!row.row.meta_enc.includes('Wann'));
  });
});

test('poll: closesAt by the background run, nudge once an hour to who has not voted', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    const m = await c.send(ANNA, g.id, { kind: 'poll', poll: { question: 'Kino?', options: ['Ja', 'Nein'], closesAt: iso(T0 + 2 * HOUR) } });
    await c.as(MARC)('POST', `messages/${m.id}/vote`, { optionIds: ['o1'] });
    const before = c.pushes().length;
    let r = await c.as(ANNA)('POST', `messages/${m.id}/nudge`);
    assert.equal(r.json.nudged, 1);
    const p = c.pushes().slice(before);
    assert.deepEqual([p.length, p[0].users, p[0].body], [1, [LENA.id], 'Bitte abstimmen: Kino?']);
    assert.equal((await c.as(ANNA)('POST', `messages/${m.id}/nudge`)).json.code, 'rate_limited');
    assert.equal((await c.as(MARC)('POST', `messages/${m.id}/nudge`)).json.code, 'not_allowed');
    c.clock.add(2 * HOUR);
    await host.tick();
    r = (await c.as(LENA)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.equal(r.find((x) => x.id === m.id).poll.closed, true);
    assert.deepEqual(r.pop().system.winner, 'Ja');
  });
});

test('event: RSVP with guests, checklist, nextEvent, edit and cancel by the creator', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    const ev = { title: 'Grillen', startsAt: iso(T0 + 26 * HOUR), endsAt: iso(T0 + 30 * HOUR), place: { label: 'Garten', lat: 50.1, lon: 7.2 }, description: 'Bringt Salat mit', checklist: ['Kohle', 'Salat'], rsvp: true, guests: true, reminderMin: 60 };
    const m = await c.send(ANNA, g.id, { kind: 'event', event: ev });
    assert.deepEqual([m.event.title, m.event.startsAt, m.event.place.label, m.event.rsvpEnabled, m.event.guests, m.event.reminderMin, m.event.cancelled], ['Grillen', ev.startsAt, 'Garten', true, true, 60, false]);
    assert.deepEqual(m.event.checklist.map((x) => [x.id, x.text, x.doneBy]), [['c1', 'Kohle', null], ['c2', 'Salat', null]]);
    assert.deepEqual(m.event.rsvp, { yes: [], maybe: [], no: [], mine: null, myGuests: 0 });
    let r = await c.as(MARC)('POST', `messages/${m.id}/rsvp`, { answer: 'yes', guests: 2 });
    assert.deepEqual(r.json.message.event.rsvp.yes, [{ userId: MARC.id, guests: 2 }]);
    assert.equal(r.json.message.event.rsvp.mine, 'yes');
    await c.as(LENA)('POST', `messages/${m.id}/rsvp`, { answer: 'maybe' });
    assert.equal((await c.as(LENA)('POST', `messages/${m.id}/rsvp`, { answer: 'maybe', guests: 1 })).json.code, 'invalid', 'guests only with yes');
    assert.equal((await c.as(LENA)('POST', `messages/${m.id}/rsvp`, { answer: 'vielleicht' })).json.code, 'invalid');
    r = await c.as(LENA)('POST', `messages/${m.id}/checklist/c2`, { done: true });
    assert.equal(r.json.message.event.checklist[1].doneBy, LENA.id);
    assert.equal((await c.as(LENA)('POST', `messages/${m.id}/checklist/c9`, { done: true })).status, 404);
    // nextEvent on the conversation
    let conv = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.deepEqual(conv.nextEvent, { messageId: m.id, title: 'Grillen', startsAt: ev.startsAt, yesCount: 1 });
    // edit: only the creator (or a group admin); a moved start; the checklist keeps ticks of kept items
    assert.equal((await c.as(MARC)('PATCH', `messages/${m.id}/event`, { title: 'x' })).json.code, 'not_allowed');
    r = await c.as(ANNA)('PATCH', `messages/${m.id}/event`, { title: 'Grillabend', startsAt: iso(T0 + 27 * HOUR), checklist: ['Salat', 'Brot'] });
    assert.deepEqual([r.json.message.event.title, r.json.message.event.startsAt], ['Grillabend', iso(T0 + 27 * HOUR)]);
    assert.deepEqual(r.json.message.event.checklist.map((x) => [x.id, x.text, x.doneBy]), [['c2', 'Salat', LENA.id], ['c3', 'Brot', null]]);
    assert.ok(r.json.message.editedAt);
    r = await c.as(ANNA)('PATCH', `messages/${m.id}/event`, { cancelled: true });
    assert.equal(r.json.message.event.cancelled, true);
    assert.equal((await c.as(MARC)('POST', `messages/${m.id}/rsvp`, { answer: 'no' })).json.code, 'closed');
    conv = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.nextEvent, null);
    assert.equal(conv.lastMessage.system.event, 'event_cancelled');
    for (const bad of [{ title: '', startsAt: ev.startsAt }, { title: 'x' }, { title: 'x', startsAt: ev.startsAt, endsAt: iso(T0) }, { title: 'x', startsAt: ev.startsAt, reminderMin: 30 }, { title: 'x', startsAt: ev.startsAt, checklist: new Array(21).fill('a') }]) {
      assert.equal((await c.as(ANNA)('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), kind: 'event', event: bad })).json.code, 'invalid', JSON.stringify(bad));
    }
  });
});

test('event: reminder to yes/maybe, departure hint 45 min before, default reminder from the creator\'s prefs', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA, OMA]);
    await c.as(ANNA)('PUT', 'prefs', { notify: { eventReminderMin: 120 } });
    const m = await c.send(ANNA, g.id, { kind: 'event', event: { title: 'Arzt', startsAt: iso(T0 + 3 * HOUR), departureHint: true } });
    assert.equal(m.event.reminderMin, 120, 'the creator\'s default');
    await c.as(MARC)('POST', `messages/${m.id}/rsvp`, { answer: 'yes' });
    await c.as(LENA)('POST', `messages/${m.id}/rsvp`, { answer: 'maybe' });
    await c.as(OMA)('POST', `messages/${m.id}/rsvp`, { answer: 'no' });
    let before = c.pushes().length;
    c.clock.add(HOUR + MIN);
    await host.tick();
    let p = c.pushes().slice(before);
    assert.equal(p.length, 1);
    assert.deepEqual([p[0].users.sort(), p[0].title, p[0].data.kind], [[MARC.id, LENA.id], 'Erinnerung: Termin', 'event_reminder']);
    await host.tick();
    assert.equal(c.pushes().length, before + 1, 'once');
    before = c.pushes().length;
    c.clock.set(T0 + 3 * HOUR - 44 * MIN);
    await host.tick();
    p = c.pushes().slice(before);
    assert.deepEqual([p.length, p[0].data.kind, p[0].data.deepLink, p[0].title], [1, 'event_departure', 'arrival', 'Abfahrt?']);
  });
});

test('event: familyCalendar → Familie calendar_upsert / calendar_remove (feature-detected)', async () => {
  const calls = [];
  const familie = { plugin: 'gatecontrol-familie', provides: ['calendar_upsert', 'calendar_remove', 'calendar_add', 'list_add', 'places'], service: async (x) => { calls.push(x); return x.name === 'places' ? [{ id: 'p1', name: 'Zuhause', lat: 50, lon: 7, radiusM: 100 }] : { ok: true, eventId: 'e1', listId: 'shopping', added: (x.payload.items || []).length }; } };
  await withHost({ gatecontrol: '1.178.0', services: [familie] }, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const m = await c.send(ANNA, g.id, { kind: 'event', event: { title: 'Elternabend', startsAt: iso(T0 + 26 * HOUR), familyCalendar: true } });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].name, calls[0].payload.sourceRef, calls[0].payload.title, calls[0].payload.userIds.sort()], ['calendar_upsert', `messenger:${m.id}`, 'Elternabend', [ANNA.id, MARC.id]]);
    await c.as(ANNA)('PATCH', `messages/${m.id}/event`, { cancelled: true });
    assert.deepEqual([calls[1].name, calls[1].payload], ['calendar_remove', { sourceRef: `messenger:${m.id}` }]);
    // the proxies
    const t = await c.send(MARC, g.id, { text: 'Kauf Milch und Eier' });
    let r = await c.as(ANNA)('POST', `messages/${t.id}/to-list`, { items: ['Milch', 'Eier'] });
    assert.deepEqual([r.status, r.json.added, calls[2].name, calls[2].payload], [200, 2, 'list_add', { userId: ANNA.id, list: 'shopping', items: ['Milch', 'Eier'] }]);
    r = await c.as(ANNA)('POST', `messages/${t.id}/to-calendar`, { title: 'Einkauf', startsAt: iso(T0 + HOUR) });
    assert.deepEqual([r.json.eventId, calls[3].name, calls[3].user.id], ['e1', 'calendar_add', ANNA.id]);
    r = await c.as(ANNA)('GET', 'familie/places');
    assert.deepEqual(r.json.places, [{ id: 'p1', name: 'Zuhause', lat: 50, lon: 7, radiusM: 100 }]);
    assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.integrations, { familie: { lists: true, calendar: true, places: true } });
  });
  // without Familie (or on 1.177, which cannot ask): unavailable, nothing called
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const t = await c.send(MARC, g.id, { text: 'x' });
    assert.equal((await c.as(ANNA)('POST', `messages/${t.id}/to-list`, { items: ['Milch'] })).json.code, 'unavailable');
    assert.equal((await c.as(ANNA)('GET', 'familie/places')).json.code, 'unavailable');
    const m = await c.send(ANNA, g.id, { kind: 'event', event: { title: 'x', startsAt: iso(T0 + HOUR), familyCalendar: true } });
    assert.equal(m.event.familyCalendar, true, 'kept, synced once Familie is there');
    assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.integrations, { familie: { lists: false, calendar: false, places: false } });
  });
});
