'use strict';

// Every statement of the screens and the background run stays well under 200 ms with 50 000 tasks and 50 000 notes of
// one person (plus other people's data around them): GateControl logs a "slow plugin database statement" from 200 ms
// on and a long statement blocks the plugin's database worker. Measured per statement in node:sqlite (the mock host).

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { withHost, item, ANNA, MARC } = require('./helpers');

const LIMIT_MS = 200;
const N = 50000;

async function timed(fn) {
  const SP = sqlite.StatementSync.prototype;
  const orig = { all: SP.all, get: SP.get, run: SP.run, iterate: SP.iterate };
  const worst = new Map();
  for (const name of Object.keys(orig)) {
    SP[name] = function measured(...a) {
      const t = performance.now();
      try { return orig[name].apply(this, a); } finally {
        const ms = performance.now() - t;
        const k = String(this.sourceSQL).replace(/\s+/g, ' ').slice(0, 200);
        worst.set(k, Math.max(worst.get(k) || 0, ms));
      }
    };
  }
  try { await fn(); } finally { Object.assign(SP, orig); }
  return worst;
}

async function fill(h) {
  const db = h.host.gc.db;
  const now = Date.now();
  // Anna: 20 lists (2 shared with Marc), Marc: 5 lists of his own
  await h.ok(ANNA, 'GET', 'me');
  await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
  const lists = [];
  for (let i = 0; i < 20; i++) lists.push((await h.ok(ANNA, 'POST', 'lists', { name: 'Liste ' + i, area: i % 4 === 0 ? 'work' : 'private' })).list.id);
  await h.ok(ANNA, 'PUT', `lists/${lists[1]}/members`, { members: [MARC.id] });
  for (let i = 0; i < 5; i++) await h.ok(MARC, 'POST', 'lists', { name: 'Marc ' + i });
  const words = ['Zahnarzt', 'Rechnung', 'Angebot', 'Rasen', 'Reifen', 'Steuer', 'Einkauf', 'Bericht', 'Meeting', 'Garten'];
  await db.exec('BEGIN');
  for (let i = 1; i <= N; i++) {
    const list = lists[i % lists.length];
    const done = i % 3 === 0 ? now - (i % 100) * 3600000 : null;
    const due = i % 5 === 0 ? `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` : null;
    const r = await db.run(`INSERT INTO tasks (list_id, title, note, important, due_date, due_at, remind_at, assignee_id, done_at, position, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [list, `${words[i % 10]} ${i}`, i % 7 === 0 ? 'Notiz zur Aufgabe ' + i : '', i % 11 === 0 ? 1 : 0, due, due ? Date.parse(due + 'T22:59:00Z') : null,
      i % 13 === 0 && !done ? now + i * 60000 : null, i % 17 === 0 ? ANNA.id : null, done, i, ANNA.id, now - i * 1000, now - i * 1000]);
    await db.run('INSERT INTO tasks_fts (rowid, title, note) VALUES (?, ?, ?)', [r.lastInsertRowid, `${words[i % 10]} ${i}`, i % 7 === 0 ? 'Notiz zur Aufgabe ' + i : '']);
    if (i % 50 === 0) for (let s = 0; s < 3; s++) await db.run('INSERT INTO tasks (list_id, parent_id, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [list, r.lastInsertRowid, 'Sub ' + s, s, ANNA.id, now, now]);
    if (i % 200 === 0) await db.run('INSERT OR IGNORE INTO my_day (user_id, day, task_id) VALUES (?, ?, ?)', [ANNA.id, '2026-11-08', r.lastInsertRowid]);
  }
  await db.exec('COMMIT');
  // 30 notebooks, 50 000 notes with tags and text
  const nbs = [];
  for (let i = 0; i < 30; i++) nbs.push((await h.ok(ANNA, 'POST', 'notebooks', { name: 'Buch ' + i, area: i % 5 === 0 ? 'work' : 'private' })).notebook.id);
  await db.exec('BEGIN');
  const para = 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore. '.repeat(4);
  for (let i = 1; i <= N; i++) {
    const nb = nbs[i % nbs.length];
    const t1 = 'tag' + (i % 40);
    const t2 = 'thema' + (i % 7);
    const body = `# Notiz ${i}\n${para}\n- [ ] Punkt ${i}\n- [x] erledigt\n#${t1} #${t2}`;
    const at = now - i * 60000;
    const r = await db.run(`INSERT INTO notes (notebook_id, title, body, snippet, pinned, check_done, check_total, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?, ?, ?)`, [nb, `${words[i % 10]} Notiz ${i}`, body, para.slice(0, 200), i % 500 === 0 ? 1 : 0, ANNA.id, ANNA.id, at, at]);
    const id = r.lastInsertRowid;
    await db.run('INSERT INTO note_tags (note_id, tag) VALUES (?, ?), (?, ?)', [id, t1, id, t2]);
    await db.run('INSERT INTO notes_fts (rowid, title, body, tags, ocr) VALUES (?, ?, ?, ?, ?)', [id, `${words[i % 10]} Notiz ${i}`, body, `${t1} ${t2}`, '']);
  }
  await db.run(`INSERT INTO notebook_tags (notebook_id, tag, n) SELECT n.notebook_id, g.tag, COUNT(*) FROM note_tags g JOIN notes n ON n.id = g.note_id GROUP BY n.notebook_id, g.tag`);
  await db.exec('COMMIT');
  // 600 items of the sources
  for (let k = 0; k < 3; k++) {
    const up = [];
    for (let i = 0; i < 200; i++) up.push(item('gatecontrol-mail', `m:${k}:${i}`, { title: 'Mail ' + i, due: i % 3 ? '2026-11-08' : '2026-11-20', users: [ANNA.id, MARC.id] }));
    await h.push('gatecontrol-mail', { upsert: up });
  }
  return { lists, nbs };
}

test(`speed: ${N} tasks and ${N} notes — every statement < ${LIMIT_MS} ms`, { timeout: 600000 }, async () => {
  const h = await withHost();
  try {
    const { lists, nbs } = await fill(h);
    const worst = await timed(async () => {
      for (const area of ['private', 'work']) {
        await h.ok(ANNA, 'GET', 'nav', null, { area });
        for (const v of ['myday', 'important', 'planned', 'assigned']) await h.ok(ANNA, 'GET', 'views/' + v, null, { area });
        await h.ok(ANNA, 'GET', 'notes', null, { area });
        await h.ok(ANNA, 'GET', 'notes', null, { area, pinned: '1' });
        await h.ok(ANNA, 'GET', 'notes', null, { area, tag: 'tag3' });
        await h.ok(ANNA, 'GET', 'notebooks', null, { area });
      }
      await h.ok(ANNA, 'GET', 'views/list:' + lists[1]);
      await h.ok(ANNA, 'GET', 'views/source:gatecontrol-mail', null, { area: 'private' });
      const page = await h.ok(ANNA, 'GET', 'notes', null, { notebook: nbs[3] });
      await h.ok(ANNA, 'GET', 'notes', null, { notebook: nbs[3], before: page.next });
      await h.ok(ANNA, 'GET', 'notes/' + page.notes[0].id);
      for (const q of ['zahnarzt', 'notiz 4711', 'lorem ipsum', 'tag1', 'ang']) await h.ok(ANNA, 'GET', 'search', null, { q, area: 'private' });
      await h.ok(ANNA, 'POST', 'tasks', { text: 'morgen 9 Uhr Zahnarzt anrufen wichtig', area: 'private' });
      await h.ok(ANNA, 'POST', 'notes', { notebookId: nbs[1], title: 'Neu', body: '#tag1 Text' });
      await h.ok(MARC, 'GET', 'views/myday', null, { area: 'private' });
      await h.ok(MARC, 'GET', 'nav', null, { area: 'private' });
      await h.host.tick();
      const up = [];
      for (let i = 0; i < 200; i++) up.push(item('gatecontrol-mail', `m:0:${i}`, { title: 'Mail neu ' + i, users: [ANNA.id], updatedAt: Date.now() + 1000 }));
      await h.push('gatecontrol-mail', { upsert: up });
    });
    const slow = [...worst.entries()].filter(([, ms]) => ms >= LIMIT_MS).sort((a, b) => b[1] - a[1]);
    const top = [...worst.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, ms]) => `${ms.toFixed(1)} ms ${k}`);
    console.log('slowest statements:\n  ' + top.join('\n  '));
    assert.deepEqual(slow, [], 'statements at or above ' + LIMIT_MS + ' ms');
  } finally { await h.close(); }
});
