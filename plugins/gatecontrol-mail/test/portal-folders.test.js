'use strict';

// Mail 1.3.4: the folders of an account in the portal's menu as a tree (ui/foldertree.js) — the logic (the tree, its
// order, the open parents, the unread below a closed parent) and the menu in a small DOM (fake-dom.js): the arrow opens
// and closes, the name opens the folder, the folder shown is never hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const FT = require('../ui/foldertree');
const { withMail, app, ANNA } = require('./helpers');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');

const F = (id, name, parentId, o) => ({ id, name, path: name, role: null, parentId: parentId || null, unread: 0, total: 0, ...(o || {}) });
const LIST = [
  F(10, 'Projekte'),
  F(11, 'Alpha', 10, { unread: 2 }),
  F(12, '2025', 11, { unread: 3 }),
  F(13, 'beta', 10),
  F(14, 'Kunden', 1, { unread: 1 }),
  F(1, 'INBOX', null, { role: 'inbox', unread: 4 }),
  F(2, 'Gesendet', null, { role: 'sent' }),
  F(3, 'Papierkorb', null, { role: 'trash' }),
  F(4, 'Entwürfe', 99, { role: 'drafts' }),
  F(15, 'Archiv alt', 77),
  F(5, 'Ältere', null),
];
const ids = (rows) => rows.map((r) => r.id);

test('the tree: the folders with a role on top (also below another folder), then the others by name; children by name; a parent not there → on top', () => {
  const tree = FT.build(LIST);
  assert.deepEqual(tree.nodes.map((n) => [n.id, n.depth]), [
    [1, 0], [14, 1], [4, 0], [2, 0], [3, 0], [5, 0], [15, 0], [10, 0], [11, 1], [12, 2], [13, 1],
  ]);
  assert.equal(tree.byId[15].parent, null, 'its parent is not there');
  assert.equal(tree.byId[4].parent, null, 'a folder with a role is always on top');
  assert.deepEqual(tree.byId[10].kids, [11, 13]);
  // the portal: the account row stands for the inbox, its children on top
  const lifted = FT.build(LIST, { liftInbox: true });
  assert.equal(lifted.byId[14].parent, null);
  assert.deepEqual(lifted.byId[1].kids, []);
  // a loop of parents and a parent of its own: on top, nothing lost
  const loop = FT.build([F(1, 'a', 2), F(2, 'b', 1), F(3, 'c', 3)]);
  assert.deepEqual(loop.nodes.map((n) => n.id).sort(), [1, 2, 3]);
  assert.equal(loop.byId[3].parent, null);
});

test('rows: closed by default, the arrow opens, the unread below a closed parent, the indent stops at level 4', () => {
  const tree = FT.build(LIST, { liftInbox: true });
  let rows = FT.rows(tree, {}, null);
  assert.deepEqual(ids(rows), [1, 4, 2, 3, 5, 15, 14, 10]);
  const p = rows.find((r) => r.id === 10);
  assert.deepEqual([p.hasKids, p.open, p.unreadBelow], [true, false, 5]);
  assert.equal(rows.find((r) => r.id === 5).hasKids, false);
  let folds = FT.toggle(tree, {}, 10, null);
  rows = FT.rows(tree, folds, null);
  assert.deepEqual(ids(rows).slice(-3), [10, 11, 13]);
  assert.deepEqual([rows.find((r) => r.id === 10).unreadBelow, rows.find((r) => r.id === 11).unreadBelow], [0, 3], 'open: no sum; Alpha closed: its child');
  folds = FT.toggle(tree, folds, 11, null);
  assert.deepEqual(ids(FT.rows(tree, folds, null)).slice(-4), [10, 11, 12, 13]);
  folds = FT.toggle(tree, folds, 10, null);
  assert.deepEqual(ids(FT.rows(tree, folds, null)).slice(-1), [10], 'closed again: all below hidden');
  assert.equal(folds[11], true, 'the choice below stays');
  // deep: the indent stops at MAX_INDENT
  const deep = [F(1, 'a')];
  for (let i = 2; i <= 7; i++) deep.push(F(i, `l${i}`, i - 1));
  const dt = FT.build(deep);
  const open = Object.fromEntries(deep.map((f) => [f.id, true]));
  assert.deepEqual(FT.rows(dt, open, null).map((r) => r.indent), [0, 1, 2, 3, 4, 4, 4]);
});

test('the folder shown: the parents above it are open without a choice; reveal opens them over a choice', () => {
  const tree = FT.build(LIST, { liftInbox: true });
  assert.deepEqual(FT.ancestors(tree, 12), [11, 10]);
  assert.ok(FT.isOpen(tree, {}, 10, 12) && FT.isOpen(tree, {}, 11, 12));
  assert.deepEqual(ids(FT.rows(tree, {}, 12)).slice(-4), [10, 11, 12, 13]);
  // closed on purpose: stays closed until the folder is picked again (reveal)
  const closed = FT.toggle(tree, {}, 10, 12);
  assert.equal(closed[10], false);
  assert.deepEqual(ids(FT.rows(tree, closed, 12)).slice(-1), [10]);
  const shown = FT.reveal(tree, closed, 12);
  assert.deepEqual([shown[10], shown[11]], [true, true]);
});

/** The portal for `user` in the small DOM; `edit(path, json)` may change an answer. */
function portal(host, user, edit) {
  const gc = {
    async call(method, p, body) {
      const [path, qs] = String(p).split('?');
      const r = await host.request({ method, path, body: body === undefined ? null : body, query: Object.fromEntries(new URLSearchParams(qs || '')), user: app(user), lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return edit ? edit(path, r.json) : r.json;
    },
    on() {},
  };
  const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true }, allowed: true }, t), gc);
  f.run();
  return f;
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));

test('the portal\'s menu: the arrow opens and closes (the menu stays), the name opens the folder, a closed parent counts below it', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA, { login: { folders: { Gesendet: '\\Sent', Papierkorb: '\\Trash', Projekte: null, 'Projekte/Alpha': null, 'Projekte/Alpha/2025': null, 'INBOX/Kunden': null } } });
  await c.tick();
  // three unread in "2025" (the answer of GET folders, the counts are the server's business)
  const f = portal(host, ANNA, (path, j) => {
    if (path === 'folders') for (const a of j.accounts) for (const x of a.folders) if (x.name === '2025') x.unread = 3;
    return j;
  });
  try {
    const doc = f.document;
    const nav = () => textOf(doc.getElementById('mp-nav'));
    const all = () => doc.body.all();
    const fold = (name) => all().find((x) => x.localName === 'button' && /mp-fold/.test(x.className) && x.getAttribute('aria-label').startsWith(name + ' '));
    const row = (name) => all().find((x) => x.localName === 'button' && /mp-row/.test(x.className) && textOf(x).startsWith(name));
    const account = () => all().find((x) => x.localName === 'button' && /is-acc/.test(x.className) && textOf(x).includes('anna@gmx.de'));
    for (let i = 0; i < 2500 && !account(); i++) await new Promise((r) => setTimeout(r, 3));
    account().click();
    for (let i = 0; i < 2500 && !nav().includes('Projekte'); i++) await new Promise((r) => setTimeout(r, 3));
    assert.ok(nav().includes('Kunden'), 'the inbox\'s children on top');
    assert.ok(!nav().includes('Alpha'), 'closed by default');
    const arrow = fold('Projekte');
    assert.equal(arrow.getAttribute('aria-expanded'), 'false');
    assert.equal(arrow.getAttribute('aria-label'), 'Projekte aufklappen');
    const below = row('Projekte').childNodes.find((x) => /is-below/.test(x.className || ''));
    assert.equal(textOf(below), '3', 'the unread below, quietly');
    assert.equal(below.getAttribute('title'), '3 ungelesen in Unterordnern');
    arrow.click();
    assert.ok(nav().includes('Alpha') && !nav().includes('2025'), 'one level opens');
    assert.equal(fold('Projekte').getAttribute('aria-label'), 'Projekte zuklappen');
    assert.equal(textOf(row('Alpha')).trim(), 'Alpha3', 'Alpha closed: the unread of 2025');
    fold('Alpha').click();
    assert.ok(nav().includes('2025'));
    // the name: the folder opens (its list), the menu goes away on a phone (showPane('list'))
    row('2025').click();
    assert.equal(row('2025').getAttribute('aria-current'), 'page');
    assert.ok(!/show-nav/.test(doc.getElementById('mp-app').className));
    // closing a parent of the folder shown hides it; picking it again opens its parents
    fold('Projekte').click();
    assert.ok(!nav().includes('2025'));
    assert.equal(fold('Projekte').getAttribute('aria-expanded'), 'false');
  } finally {
    f.stop();
  }
}));
