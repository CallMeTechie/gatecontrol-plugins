'use strict';

// The portal's parts of 1.8.0 in the small fake DOM against the mock host: hidden without the host's AI service and
// cloud accounts; "Dokument-Infos" (the suggestion taken, a reminder of a deadline), "KI für Dokumente" per area,
// "Fristen"; "Importieren" (connect, browse, pick, a job with its progress).

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { withHost, ANNA } = require('./helpers');
const { createWindow } = require('./fake-dom');

const portalHtml = (o) => ui.render({ view: 'portal', lang: 'de', user: { id: 2, loggedIn: true }, ...o }, t);
const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, fn, n = 1500) {
  for (let i = 0; i < n; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const byText = (root, tag, text) => root.querySelectorAll(tag).find((e) => textOf(e).trim() === text);
/** A button of the menu (since 1.11.0): an area, a folder, a page — by its text, or an icon by its label. */
const navItem = (nav, label) => {
  const icon = nav.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === label);
  if (icon) return icon;
  let n = byText(nav, 'span', label);
  while (n && n.localName !== 'button') n = n.parentNode;
  return n || null;
};

function frameGc(host, user, calls, extra) {
  const viewer = { ...user, portal: true, loggedIn: true };
  const listeners = [];
  return {
    listeners,
    async call(method, p, body) {
      const [pathPart, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path: pathPart, query, body });
      const r = await host.request({ method, path: pathPart, query, body: body === undefined ? null : body, user: viewer, lang: 'de' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; e.data = r.json; throw e; }
      return r.json;
    },
    async upload() { throw new Error('no upload here'); },
    on(type, fn) { if (type === 'event') listeners.push(fn); },
    ...(extra || {}),
  };
}

const TEXT = 'Stadtwerke Musterstadt\nRechnung vom 20.10.2026\nZahlbar bis 10.11.2026';
const AI = {
  extract: async () => ({
    kind: 'invoice', title: 'Stromrechnung', date: '2026-10-20', sender: 'Stadtwerke', amount: 84.2, currency: 'EUR', folder: 1,
    name: 'Stadtwerke Rechnung', deadlines: [{ kind: 'payment', date: '2026-11-10', label: 'Rechnung bezahlen' }],
  }),
};
const CLOUD = {
  files: {
    'google:anna@example.com': [
      { id: 'd1', parent: null, name: 'Belege', isDir: true },
      { id: 'f1', parent: 'd1', name: 'Strom.pdf', mime: 'application/pdf', data: 'strom', modifiedAt: '2026-03-01T10:00:00.000Z' },
      { id: 'f2', parent: null, name: 'Notiz.txt', mime: 'text/plain', data: 'notiz', modifiedAt: '2026-01-05T08:00:00.000Z' },
    ],
  },
};

test('smoke: without GateControl\'s AI service and cloud accounts there is no "Fristen", no "Importieren", no "Dokument-Infos"', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Rechnung.pdf', 'pdf', { mime: 'application/pdf', text: TEXT });
    const f = createWindow(portalHtml(), frameGc(host, ANNA, []));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the file', () => byText($('dp-main'), 'span', 'Rechnung.pdf'));
      for (const label of ['Fristen', 'Importieren']) assert.ok(!navItem($('dp-nav'), label), label);
      assert.ok(!textOf($('dp-tools')).includes('KI für Dokumente'));
      $('dp-main').querySelector('.dp-more').click();
      await until('actions', () => byText($('dp-dialog'), 'span', 'Ältere Versionen'));
      assert.ok(!byText($('dp-dialog'), 'span', 'Dokument-Infos'));
    } finally {
      f.stop();
    }
  });
});

test('smoke: "Dokument-Infos" — the suggestion taken, a reminder; the area switch; "Fristen"', async () => {
  await withHost({ ai: AI }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const bills = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Rechnungen' })).json.node;
    const file = (await c.put(ANNA, mine.rootId, 'Scan.pdf', 'pdf', { mime: 'application/pdf', text: TEXT })).json.node;
    await host.tick();
    const calls = [];
    const f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the file', () => byText($('dp-main'), 'span', 'Scan.pdf'));
      assert.ok(textOf($('dp-main')).includes('Rechnung · '), 'the kind on the tile');
      assert.ok(navItem($('dp-nav'), 'Fristen'));
      // the area's switch (in the Drive settings since 1.11.0)
      assert.ok(!textOf($('dp-tools')).includes('KI für Dokumente'));
      navItem($('dp-nav'), 'Drive-Einstellungen').click();
      const sw = () => $('dp-main').querySelectorAll('input').find((x) => x.getAttribute('aria-label') === 'Meine Dateien');
      await until('the switch', () => sw() && sw().checked);
      assert.ok(textOf($('dp-main')).includes('Tresore werden nie von der KI gelesen.'));
      sw().checked = false;
      sw().dispatchEvent({ type: 'change', target: sw() });
      await until('off', () => textOf($('dp-toast')).includes('aus') && sw() && !sw().checked);
      assert.equal((await a('GET', `nodes/${file.id}/insight`)).json.status, 'off');
      sw().checked = true;
      sw().dispatchEvent({ type: 'change', target: sw() });
      await until('on', () => sw() && sw().checked && textOf($('dp-toast')).includes(' an'));
      navItem($('dp-nav'), 'Meine Dateien').click();
      await until('the file again', () => byText($('dp-main'), 'span', 'Scan.pdf'));
      // the dialog
      const card = $('dp-main').querySelectorAll('[data-node]').find((x) => x.getAttribute('data-node') === String(file.id));
      card.querySelector('.dp-more').click();
      byText(await until('actions', () => byText($('dp-dialog'), 'span', 'Dokument-Infos') && $('dp-dialog')), 'span', 'Dokument-Infos').parentNode.click();
      await until('the facts', () => textOf($('dp-dialog')).includes('Stadtwerke'));
      const d = textOf($('dp-dialog'));
      assert.ok(d.includes('Rechnung') && d.includes('Umbenennen in „Stadtwerke Rechnung.pdf“') && d.includes('Verschieben nach „Meine Dateien › Rechnungen“'), d);
      assert.ok(d.includes('Rechnung bezahlen'));
      // a reminder 3 days before (the default)
      byText($('dp-dialog'), 'span', 'Erinnern').parentNode.click();
      await until('reminder', () => textOf($('dp-dialog')).includes('Erinnerung '));
      const dl = (await a('GET', `nodes/${file.id}/insight`)).json.deadlines[0];
      assert.equal(dl.reminder.daysBefore, 3);
      // both taken
      byText($('dp-dialog'), 'span', 'Beides übernehmen').parentNode.click();
      await until('taken', () => textOf($('dp-toast')).includes('Vorschlag übernommen'));
      const n = (await a('GET', `nodes/${file.id}`)).json.node;
      assert.deepEqual([n.parentId, n.name], [bills.id, 'Stadtwerke Rechnung.pdf']);
      // "Fristen"
      navItem($('dp-nav'), 'Fristen').click();
      await until('the list', () => byText($('dp-main'), 'button', 'Stadtwerke Rechnung.pdf'));
      // since 1.14.0 by month with the kind as a tag and the reminder as „Erinnerung 3 Tage vorher ✓“ (ui/ki.js)
      assert.ok(textOf($('dp-main')).includes('Zahlung'));
      assert.ok(textOf($('dp-main')).includes('Erinnerung 3 Tage vorher'));
      $('dp-main').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Erinnerung entfernen').click();
      await until('removed', () => byText($('dp-main'), 'span', 'Erinnern'));
      assert.equal((await a('GET', `nodes/${file.id}/insight`)).json.deadlines[0].reminder, null);
    } finally {
      f.stop();
    }
  });
});

test('smoke: "Importieren" — connect (GC.openUrl), browse, pick, a job with progress', async () => {
  await withHost({ cloud: CLOUD }, async (host, c) => {
    const opened = [];
    const calls = [];
    const gc = frameGc(host, ANNA, calls, { openUrl: async (u) => { opened.push(u); return { ok: true }; } });
    const f = createWindow(portalHtml(), gc);
    const $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the nav', () => navItem($('dp-nav'), 'Importieren'));
      navItem($('dp-nav'), 'Importieren').click();
      await until('the page', () => byText($('dp-main'), 'span', 'Google Drive verbinden'));
      assert.ok(!byText($('dp-main'), 'span', 'OneDrive verbinden'));
      byText($('dp-main'), 'span', 'Google Drive verbinden').parentNode.click();
      await until('opened', () => opened.length === 1);
      assert.match(opened[0], /^https:\/\/gc\.example\.com\/oauth\/cloud\/start\?flow=[A-Za-z0-9_-]{16,64}$/);
      // back from GateControl's OAuth dialog
      host.cloudConnect(ANNA.id, 'google', 'anna@example.com');
      navItem($('dp-nav'), 'Importieren').click();
      await until('the account', () => textOf($('dp-main')).includes('anna@example.com'));
      byText($('dp-main'), 'span', 'Durchsuchen').parentNode.click();
      await until('the files', () => byText($('dp-main'), 'span', 'Belege') && byText($('dp-main'), 'span', 'Notiz.txt'));
      for (const cb of $('dp-main').querySelectorAll('input').filter((x) => x.getAttribute('type') === 'checkbox')) {
        cb.checked = true;
        cb.dispatchEvent({ type: 'change' });
      }
      await until('two chosen', () => byText($('dp-main'), 'span', '2 Einträge importieren'));
      assert.ok(textOf($('dp-main')).includes('Ziel: Meine Dateien'));
      byText($('dp-main'), 'span', '2 Einträge importieren').parentNode.click();
      await until('the job', () => textOf($('dp-main')).includes('Wartet'));
      const post = calls.find((x) => x.method === 'POST' && x.path === 'import/jobs');
      assert.deepEqual(JSON.parse(JSON.stringify(post.body.items)), [{ id: 'd1', isDir: true, name: 'Belege' }, { id: 'f2', isDir: false, name: 'Notiz.txt' }]);
      await host.tick();
      // the live event 'import' brings the progress
      const ev = c.events().filter((e) => e.type === 'import').pop();
      for (const fn of gc.listeners) fn({ type: 'import', data: ev.data });
      await until('done', () => textOf($('dp-main')).includes('Fertig') && textOf($('dp-main')).includes('2 von 2 Dateien'));
      const mine = await c.area(ANNA, 'mine');
      assert.equal((await c.as(ANNA)('GET', 'nodes/by-path', null, { area: mine.id, path: 'Belege/Strom.pdf' })).status, 200);
    } finally {
      f.stop();
    }
  });
});

test('smoke: without GC.openUrl the address is shown to copy; drive=import opens the page', async () => {
  await withHost({ cloud: CLOUD }, async (host) => {
    const f = createWindow(portalHtml(), frameGc(host, ANNA, []));
    const $ = (id) => f.document.getElementById(id);
    try {
      f.window.location = { search: '?drive=import', hash: '' };
      f.run();
      await until('the page', () => byText($('dp-main'), 'span', 'Google Drive verbinden'));
      byText($('dp-main'), 'span', 'Google Drive verbinden').parentNode.click();
      const input = await until('the address', () => $('dp-dialog').querySelector('input'));
      assert.match(input.value, /^https:\/\/gc\.example\.com\/oauth\/cloud\/start\?flow=[A-Za-z0-9_-]{16,64}$/);
      assert.ok(byText($('dp-dialog'), 'span', 'Adresse kopieren'));
      assert.equal(host.cloudConnectUrls[0].returnTo, '/portal?drive=import#plg-gatecontrol-drive');
    } finally {
      f.stop();
    }
  });
});

test('smoke: back from GateControl\'s OAuth dialog — connected (waiting jobs go on) or an error; an expired connection; openUrl refused', async () => {
  await withHost({ cloud: CLOUD }, async (host, c) => {
    const conn = host.cloudConnect(ANNA.id, 'google', 'anna@example.com');
    const mine = await c.area(ANNA, 'mine');
    const job = (await c.as(ANNA)('POST', 'import/jobs', { connection: conn.id, items: [{ id: 'f2', isDir: false }], targetFolderId: mine.rootId })).json.job;
    host.cloudRevoke(conn.id);
    await host.tick();
    assert.equal((await c.as(ANNA)('GET', `import/jobs/${job.id}`)).json.job.error, 'cloud_auth');
    // the expired connection: "Neu verbinden"; GateControl refuses the address (too soon) — then it is shown to copy
    let f = createWindow(portalHtml(), frameGc(host, ANNA, [], { openUrl: async () => { throw new Error('not allowed'); } }));
    let $ = (id) => f.document.getElementById(id);
    try {
      f.run();
      await until('the nav', () => navItem($('dp-nav'), 'Importieren'));
      navItem($('dp-nav'), 'Importieren').click();
      await until('stale', () => textOf($('dp-main')).includes('Verbindung abgelaufen'));
      assert.ok(!byText($('dp-main'), 'span', 'Durchsuchen'));
      byText($('dp-main'), 'span', 'Neu verbinden').parentNode.click();
      await until('the address', () => $('dp-dialog').querySelector('input'));
    } finally {
      f.stop();
    }
    // back with an error
    f = createWindow(portalHtml(), frameGc(host, ANNA, []));
    $ = (id) => f.document.getElementById(id);
    try {
      f.window.location = { search: '?drive=import&cloud=error&cloudError=ERR_CLOUD_AUTH', hash: '' };
      f.run();
      await until('the error', () => textOf($('dp-toast')).includes('Das Verbinden hat nicht geklappt (ERR_CLOUD_AUTH)'));
    } finally {
      f.stop();
    }
    // connected again: the job that waited goes on
    host.cloudConnect(ANNA.id, 'google', 'anna@example.com');
    const calls = [];
    f = createWindow(portalHtml(), frameGc(host, ANNA, calls));
    $ = (id) => f.document.getElementById(id);
    try {
      f.window.location = { search: '?drive=import&cloud=connected', hash: '' };
      f.run();
      await until('connected', () => textOf($('dp-toast')).includes('Konto verbunden'));
      await until('resumed', () => calls.some((x) => x.method === 'POST' && x.path === `import/jobs/${job.id}/resume`));
      await until('queued', () => textOf($('dp-main')).includes('Wartet'));
      await host.tick();
      assert.equal((await c.as(ANNA)('GET', `import/jobs/${job.id}`)).json.job.state, 'done');
    } finally {
      f.stop();
    }
  });
});
