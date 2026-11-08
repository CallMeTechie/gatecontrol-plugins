'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA } = require('./helpers');

test('smoke: me, nav, a task, my day, a note, search, render', async () => {
  const h = await withHost();
  try {
    const me = await h.ok(ANNA, 'GET', 'me');
    assert.equal(me.today, '2026-11-08');
    const t = await h.ok(ANNA, 'POST', 'tasks', { text: 'Morgen 9 Uhr Zahnarzt anrufen, wichtig', area: 'private' });
    assert.equal(t.task.title, 'Zahnarzt anrufen');
    assert.deepEqual(t.task.due, { date: '2026-11-09', time: '09:00' });
    const nav = await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
    assert.ok(nav.lists.length >= 1);
    const md = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.ok(md.sections.find((s) => s.id === 'upcoming').items.some((x) => x.id === t.task.id));
    const n = await h.ok(ANNA, 'POST', 'notes', { title: 'Werkstatt', body: '- [ ] Ölfilter bestellen\n#auto' });
    assert.equal(n.note.check.total, 1);
    const s = await h.ok(ANNA, 'GET', 'search', null, { q: 'olfilter', area: 'private' });
    assert.equal(s.notes.length, 1);
    const html = await h.host.render({ view: 'portal', user: { ...ANNA, portal: true, loggedIn: true } });
    assert.match(html.html, /NA_CTX/);
  } finally { await h.close(); }
});
