'use strict';

// Pinnwand and Packlisten in „Notizen & Aufgaben“ (1.19.0; gatecontrol-notizen, contract v1 § 3).
//
// With the hub installed (gc.services.available of its notes services), the module board moves there: two notebooks the
// hub keeps for Familie — 'pinnwand' (notes) and 'packlisten' (checklists) — with the family (parents and children) as
// members (notes_bind, again when the family changes). The move is one notes_import of the board notes ('board:<id>')
// and checklists ('checklist:<id>'), idempotent by those refs. From then on the hub is where they live: a change in
// Familie goes there right after its commit (note_save / note_delete as the person who made it), a change in the hub
// comes back with notes_list { since } — when the hub calls notes_changed, else every PULL_EVERY_MS.
//
// Familie's own tables (board_notes, checklists, checklist_items) stay the cache Familie shows (the app, the portal) and
// keeps working on: the hub away for a while → changes wait (hub_notes.dirty, or updated_at > hub_notes.synced_at;
// deleted ones in hub_gone) and go when it is back; the hub removed → Familie works on as before,
// nothing is lost. A notebook the hub no longer knows (a fresh hub, notes_list → not_found) rolls back: the mapping
// goes (mode 'local') and the next run moves everything again. Without the hub nothing of this runs at all.
//
// Templates stay Familie's own. A hub note's title (Familie's notes have none) is kept in hub_notes.title and shown as
// the first line; text over 500 characters is cut in Familie (the hub keeps the whole note).

const store = require('./store');
const { line } = require('./util');

const HUB = 'gatecontrol-notizen';
const SERVICES = ['notes_bind', 'notes_list', 'note_save', 'note_delete', 'notes_import'];
const KEYS = { note: 'pinnwand', checklist: 'packlisten' };
const KIND_OF = { pinnwand: 'note', packlisten: 'checklist' };
const STATE_KEY = 'notizen_board';
const PULL_EVERY_MS = 15 * 60000;
const FULL_EVERY_MS = 24 * 3600000;
const AVAILABLE_TTL_MS = 60000;
const IMPORT_CHUNK = 100;
const CALLS_MAX = 60;
const PAGES_MAX = 30;
const NOTE_MAX = 500;
const TITLE_MAX = 60;
const ITEM_MAX = 80;
const ITEMS_MAX = 200;
const TITLES = { de: { pinnwand: 'Pinnwand', packlisten: 'Packlisten', list: 'Packliste' }, en: { pinnwand: 'Pinboard', packlisten: 'Packing lists', list: 'Packing list' } };

const state = { st: null, hub: null, hubAt: 0, running: null, timer: null, noTimer: false, warned: new Set() };

function reset() {
  if (state.timer) clearTimeout(state.timer);
  Object.assign(state, { st: null, hub: null, hubAt: 0, running: null, timer: null, warned: new Set() });
}

const fresh = () => ({ mode: 'local', members: '', since: {}, pulledAt: 0, fullAt: 0, pending: false, migratedAt: null });

async function load(gc) {
  if (state.st) return state.st;
  let v = null;
  try { v = await gc.storage.get(STATE_KEY); } catch { v = null; }
  state.st = v && typeof v === 'object' && (v.mode === 'hub' || v.mode === 'local') ? { ...fresh(), ...v, since: { ...(v.since || {}) } } : fresh();
  return state.st;
}

async function save(gc) {
  try { await gc.storage.set(STATE_KEY, state.st); } catch (e) { warn(gc, 'state', 'board: state not saved', (e && e.code) || 'error'); }
}

function warn(gc, key, ...a) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  try { gc.log.warn(...a); } catch { /* no log */ }
}

/** Has Pinnwand / Packlisten moved into the hub? (mode 'hub') */
async function inHub(gc) {
  return (await load(gc)).mode === 'hub';
}

/** Are the hub's notes services there (asks nobody; known answers kept a minute)? */
async function hubThere(gc, now = Date.now()) {
  if (state.hub != null && now - state.hubAt < AVAILABLE_TTL_MS && now >= state.hubAt) return state.hub;
  let on = false;
  if (gc.services && typeof gc.services.available === 'function' && typeof gc.services.call === 'function') {
    try {
      on = true;
      for (const s of SERVICES) if ((await gc.services.available(HUB, s)) !== true) { on = false; break; }
    } catch { on = false; }
  }
  state.hub = on;
  state.hubAt = now;
  return on;
}

class HubError extends Error { constructor(code, field) { super(code); this.code = code; this.field = field || null; } }

/** One call of the hub's notes services → its answer; a refusal throws HubError(code), a host error its ERR_*. */
async function call(gc, budget, service, userId, payload) {
  if (budget.n >= CALLS_MAX) throw new HubError('budget');
  budget.n++;
  const res = await gc.services.call({ plugin: HUB, service, ...(userId ? { userId } : {}), payload });
  if (!res || res.ok !== true) throw new HubError((res && res.code) || 'failed', res && res.field);
  return res;
}

const membersKey = (ids) => [...ids].sort((a, b) => a - b).join(',');
const say = (cfg, k) => (TITLES[cfg.lang] || TITLES.de)[k];

async function bindBoth(gc, cfg, budget, ids) {
  for (const key of ['pinnwand', 'packlisten']) {
    await call(gc, budget, 'notes_bind', null, { key, title: say(cfg, key), kind: key === 'pinnwand' ? 'notes' : 'checklists', members: ids, area: 'private' });
  }
}

/** The person a call is made as: `prefer` when a member, else the first parent, else the first member. */
function actor(fam, ...prefer) {
  for (const p of prefer) if (Number.isSafeInteger(p) && fam.byId.has(p)) return p;
  const parent = fam.list.find((m) => m.role === 'parent');
  return parent ? parent.userId : (fam.list[0] ? fam.list[0].userId : null);
}

// ─── Familie → hub ───────────────────────────────

async function itemsOf(gc, listId) {
  return store.all(gc, 'SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY sort, id', [listId]);
}

const noteImport = (n) => ({ ref: `board:${n.id}`, text: n.text, color: n.color, pinned: !!n.pinned, expiresAt: n.expires_at || null, authorId: n.author_id || null, createdAt: n.created_at });

/** The move: bind, import every note and checklist, map them. Then mode 'hub'. */
async function migrate(gc, fam, cfg, now, budget, ids) {
  await bindBoth(gc, cfg, budget, ids);
  const notes = await store.all(gc, 'SELECT * FROM board_notes WHERE expires_at IS NULL OR expires_at > ? ORDER BY id', [now]);
  const lists = await store.all(gc, 'SELECT * FROM checklists ORDER BY id');
  const maps = [];
  for (let i = 0; i < notes.length; i += IMPORT_CHUNK) {
    const part = notes.slice(i, i + IMPORT_CHUNK);
    const res = await call(gc, budget, 'notes_import', null, { key: 'pinnwand', notes: part.map(noteImport) });
    for (const n of part) { const hid = res.ids && res.ids[`board:${n.id}`]; if (Number.isSafeInteger(hid)) maps.push(['note', n.id, hid, n.updated_at]); }
  }
  for (let i = 0; i < lists.length; i += IMPORT_CHUNK) {
    const part = lists.slice(i, i + IMPORT_CHUNK);
    const payload = [];
    for (const c of part) {
      const items = await itemsOf(gc, c.id);
      payload.push({ ref: `checklist:${c.id}`, title: c.title, checklist: items.map((x) => ({ text: x.text, done: !!x.done })), authorId: c.created_by || null, createdAt: c.created_at });
    }
    const res = await call(gc, budget, 'notes_import', null, { key: 'packlisten', notes: payload });
    for (const c of part) { const hid = res.ids && res.ids[`checklist:${c.id}`]; if (Number.isSafeInteger(hid)) maps.push(['checklist', c.id, hid, c.updated_at]); }
  }
  await store.tx(gc, async () => {
    for (const [kind, localId, hubId, at] of maps) {
      await store.run(gc, `INSERT INTO hub_notes (kind, local_id, hub_id, hub_at, synced_at) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(kind, local_id) DO UPDATE SET hub_id = excluded.hub_id, synced_at = excluded.synced_at`, [kind, localId, hubId, at]);
    }
  });
  Object.assign(state.st, { mode: 'hub', members: membersKey(ids), since: {}, pulledAt: 0, fullAt: 0, pending: false, migratedAt: now });
  await save(gc);
  gc.log.info('board moved to Notizen & Aufgaben', maps.length);
}

/**
 * Rows of Familie not in step with the mapping: new ones (made while the hub was away, or between the import and the
 * switch) get a row without hub_id, mapped ones whose row is gone go to hub_gone.
 */
async function reconcile(gc) {
  await store.tx(gc, async () => {
    for (const [kind, table] of [['note', 'board_notes'], ['checklist', 'checklists']]) {
      await store.run(gc, `INSERT INTO hub_notes (kind, local_id, hub_id, hub_at, synced_at)
        SELECT ?, t.id, NULL, 0, 0 FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM hub_notes h WHERE h.kind = ? AND h.local_id = t.id)`, [kind, kind]);
      await store.run(gc, `INSERT OR IGNORE INTO hub_gone (kind, hub_id, by_user) SELECT h.kind, h.hub_id, h.by_user FROM hub_notes h
        WHERE h.kind = ? AND h.hub_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = h.local_id)`, [kind]);
      await store.run(gc, `DELETE FROM hub_notes WHERE kind = ? AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = hub_notes.local_id)`, [kind]);
    }
  });
}

/** What changed in Familie goes to the hub (as the person who changed it). */
async function pushChanges(gc, fam, now, budget) {
  let n = 0;
  const notes = await store.all(gc, `SELECT n.*, h.hub_id, h.title AS hub_title, h.by_user, h.dirty FROM hub_notes h JOIN board_notes n ON n.id = h.local_id
    WHERE h.kind = 'note' AND (h.hub_id IS NULL OR h.dirty > 0 OR n.updated_at > h.synced_at) ORDER BY n.id LIMIT 100`);
  for (const r of notes) {
    if (r.expires_at != null && r.expires_at <= now) continue;
    const payload = { key: 'pinnwand', text: stripTitle(r.text, r.hub_title), color: r.color, pinned: !!r.pinned, expiresAt: r.expires_at || null };
    const res = await saveNote(gc, budget, actor(fam, r.by_user, r.author_id), payload, r.hub_id);
    await store.run(gc, 'UPDATE hub_notes SET hub_id = ?, hub_at = ?, synced_at = ?, dirty = MAX(0, dirty - ?) WHERE kind = ? AND local_id = ?', [res.note.id, res.note.updatedAt || 0, r.updated_at, r.dirty, 'note', r.id]);
    n++;
  }
  const lists = await store.all(gc, `SELECT c.*, h.hub_id, h.by_user, h.dirty FROM hub_notes h JOIN checklists c ON c.id = h.local_id
    WHERE h.kind = 'checklist' AND (h.hub_id IS NULL OR h.dirty > 0 OR c.updated_at > h.synced_at) ORDER BY c.id LIMIT 100`);
  for (const c of lists) {
    const items = await itemsOf(gc, c.id);
    const payload = { key: 'packlisten', title: c.title, checklist: items.map((x) => ({ ...(x.hub_item ? { id: x.hub_item } : {}), text: x.text, done: !!x.done })) };
    const res = await saveNote(gc, budget, actor(fam, c.by_user, c.created_by), payload, c.hub_id);
    await store.tx(gc, async () => {
      await store.run(gc, 'UPDATE hub_notes SET hub_id = ?, hub_at = ?, synced_at = ?, dirty = MAX(0, dirty - ?) WHERE kind = ? AND local_id = ?', [res.note.id, res.note.updatedAt || 0, c.updated_at, c.dirty, 'checklist', c.id]);
      await itemIds(gc, c.id, res.note.checklist);
    });
    n++;
  }
  for (const g of await store.all(gc, 'SELECT * FROM hub_gone ORDER BY hub_id LIMIT 100')) {
    try {
      await call(gc, budget, 'note_delete', actor(fam, g.by_user), { key: KEYS[g.kind], id: g.hub_id });
    } catch (e) {
      if (!(e instanceof HubError && e.code === 'not_found')) throw e;
    }
    await store.run(gc, 'DELETE FROM hub_gone WHERE kind = ? AND hub_id = ?', [g.kind, g.hub_id]);
    n++;
  }
  return n;
}

/** note_save; a note the hub no longer has (deleted there meanwhile) is made anew — the change in Familie came later. */
async function saveNote(gc, budget, userId, payload, hubId) {
  if (hubId == null) return call(gc, budget, 'note_save', userId, payload);
  try {
    return await call(gc, budget, 'note_save', userId, { ...payload, id: hubId });
  } catch (e) {
    if (!(e instanceof HubError && e.code === 'not_found')) throw e;
    return call(gc, budget, 'note_save', userId, payload);
  }
}

/** The hub's item ids onto Familie's items (same order). */
async function itemIds(gc, listId, checklist) {
  const items = await itemsOf(gc, listId);
  const list = Array.isArray(checklist) ? checklist : [];
  for (let i = 0; i < items.length; i++) {
    const id = list[i] && typeof list[i].id === 'string' ? list[i].id : null;
    if (id !== items[i].hub_item) await store.run(gc, 'UPDATE checklist_items SET hub_item = ? WHERE id = ?', [id, items[i].id]);
  }
}

// ─── hub → Familie ───────────────────────────────

/** A note's text as Familie shows it: the title as the first line, then the text (≤ 500). */
function shown(note) {
  const title = line(note.title || '') || '';
  const text = String(note.text || '').replace(/\r/g, '').trim();
  const s = title && text ? `${title}\n${text}` : (title || text || '…');
  return s.length > NOTE_MAX ? s.slice(0, NOTE_MAX - 1).trimEnd() + '…' : s;
}

/** Familie's text without the title it shows first (the hub keeps its title). */
function stripTitle(text, title) {
  const t = line(title || '') || '';
  return t && String(text).startsWith(`${t}\n`) ? String(text).slice(t.length + 1) : String(text);
}

const colorOf = (c) => (typeof c === 'string' && /^[a-z]{1,16}$/.test(c) ? c : 'yellow');

async function applyNote(gc, fam, n) {
  const map = await store.one(gc, "SELECT * FROM hub_notes WHERE kind = 'note' AND hub_id = ?", [n.id]);
  const at = Number.isSafeInteger(n.updatedAt) ? n.updatedAt : Date.now();
  const expires = Number.isSafeInteger(n.expiresAt) && n.expiresAt > 0 ? n.expiresAt : null;
  if (map) {
    const row = await store.one(gc, 'SELECT * FROM board_notes WHERE id = ?', [map.local_id]);
    // changed in Familie after it was last in step: Familie's version goes to the hub next
    if (!row || map.dirty > 0 || row.updated_at > map.synced_at) return;
    await store.run(gc, 'UPDATE board_notes SET text = ?, color = ?, pinned = ?, expires_at = ?, updated_at = ? WHERE id = ?', [shown(n), colorOf(n.color), n.pinned ? 1 : 0, expires, at, row.id]);
    await store.run(gc, "UPDATE hub_notes SET hub_at = ?, synced_at = ?, title = ? WHERE kind = 'note' AND local_id = ?", [at, at, line(n.title || '') || null, row.id]);
    return;
  }
  const author = actor(fam, n.createdBy, n.updatedBy) || 0;
  const res = await store.run(gc, 'INSERT INTO board_notes (text, color, pinned, author_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [shown(n), colorOf(n.color), n.pinned ? 1 : 0, author, Number.isSafeInteger(n.createdAt) ? n.createdAt : at, at, expires]);
  await store.run(gc, "INSERT INTO hub_notes (kind, local_id, hub_id, hub_at, synced_at, title) VALUES ('note', ?, ?, ?, ?, ?)", [Number(res.lastInsertRowid), n.id, at, at, line(n.title || '') || null]);
}

function listTitle(cfg, n) {
  const s = line(n.title || '') || line(String(n.text || '').split('\n')[0] || '') || say(cfg, 'list');
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1).trimEnd() + '…' : s;
}

async function applyChecklist(gc, fam, cfg, n) {
  const map = await store.one(gc, "SELECT * FROM hub_notes WHERE kind = 'checklist' AND hub_id = ?", [n.id]);
  const at = Number.isSafeInteger(n.updatedAt) ? n.updatedAt : Date.now();
  const list = (Array.isArray(n.checklist) ? n.checklist : []).slice(0, ITEMS_MAX).map((x) => ({
    id: typeof x.id === 'string' ? x.id : null, text: (line(x.text || '') || '…').slice(0, ITEM_MAX), done: x.done === true,
    by: Number.isSafeInteger(x.doneBy) ? x.doneBy : null,
  }));
  let localId;
  if (map) {
    const row = await store.one(gc, 'SELECT * FROM checklists WHERE id = ?', [map.local_id]);
    if (!row || map.dirty > 0 || row.updated_at > map.synced_at) return;
    localId = row.id;
    await store.run(gc, 'UPDATE checklists SET title = ?, updated_at = ? WHERE id = ?', [listTitle(cfg, n), at, localId]);
    const items = await itemsOf(gc, localId);
    if (items.length === list.length && items.every((x, i) => x.text === list[i].text)) {
      for (let i = 0; i < items.length; i++) {
        const x = items[i];
        const done = list[i].done;
        if (!!x.done !== done || x.hub_item !== list[i].id) {
          await store.run(gc, 'UPDATE checklist_items SET done = ?, done_by = ?, hub_item = ? WHERE id = ?', [done ? 1 : 0, done ? (list[i].by || x.done_by || null) : null, list[i].id, x.id]);
        }
      }
    } else {
      await store.run(gc, 'DELETE FROM checklist_items WHERE checklist_id = ?', [localId]);
      await insertItems(gc, localId, list, at);
    }
    await store.run(gc, "UPDATE hub_notes SET hub_at = ?, synced_at = ? WHERE kind = 'checklist' AND local_id = ?", [at, at, localId]);
    return;
  }
  const by = actor(fam, n.createdBy, n.updatedBy);
  const res = await store.run(gc, 'INSERT INTO checklists (title, from_template_id, created_by, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)',
    [listTitle(cfg, n), by, Number.isSafeInteger(n.createdAt) ? n.createdAt : at, at]);
  localId = Number(res.lastInsertRowid);
  await insertItems(gc, localId, list, at);
  await store.run(gc, "INSERT INTO hub_notes (kind, local_id, hub_id, hub_at, synced_at) VALUES ('checklist', ?, ?, ?, ?)", [localId, n.id, at, at]);
}

async function insertItems(gc, listId, list, at) {
  let sort = 0;
  for (const x of list) {
    await store.run(gc, 'INSERT INTO checklist_items (checklist_id, text, done, done_by, sort, created_at, hub_item) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [listId, x.text, x.done ? 1 : 0, x.done ? x.by : null, sort++, at, x.id]);
  }
}

/** A note deleted in the hub goes in Familie (unless changed in Familie since — then it is made anew there). */
async function applyRemoved(gc, kind, hubId) {
  const map = await store.one(gc, 'SELECT * FROM hub_notes WHERE kind = ? AND hub_id = ?', [kind, hubId]);
  if (!map) return;
  const table = kind === 'note' ? 'board_notes' : 'checklists';
  const row = await store.one(gc, `SELECT id, updated_at FROM ${table} WHERE id = ?`, [map.local_id]);
  if (row && (map.dirty > 0 || row.updated_at > map.synced_at)) {
    await store.run(gc, 'UPDATE hub_notes SET hub_id = NULL WHERE kind = ? AND local_id = ?', [kind, map.local_id]);
    return;
  }
  if (kind === 'checklist') await store.run(gc, 'DELETE FROM checklist_items WHERE checklist_id = ?', [map.local_id]);
  await store.run(gc, `DELETE FROM ${table} WHERE id = ?`, [map.local_id]);
  await store.run(gc, 'DELETE FROM hub_notes WHERE kind = ? AND local_id = ?', [kind, map.local_id]);
}

/** notes_list of both notebooks: since the last time, or everything (full: hub ids not listed are gone there). */
async function pull(gc, fam, cfg, now, budget, full) {
  const st = state.st;
  const who = actor(fam);
  if (!who) return 0;
  let n = 0;
  for (const key of ['pinnwand', 'packlisten']) {
    const kind = KIND_OF[key];
    const since = full ? null : (st.since[key] || null);
    let cursor = null;
    let max = st.since[key] || 0;
    const seen = new Set();
    for (let page = 0; page < PAGES_MAX; page++) {
      const res = await call(gc, budget, 'notes_list', who, { key, ...(since ? { since } : {}), ...(cursor ? { cursor } : {}) });
      await store.tx(gc, async () => {
        for (const note of Array.isArray(res.notes) ? res.notes : []) {
          if (!note || !Number.isSafeInteger(note.id)) continue;
          seen.add(note.id);
          if (Number.isSafeInteger(note.updatedAt) && note.updatedAt > max) max = note.updatedAt;
          if (kind === 'note') await applyNote(gc, fam, note); else await applyChecklist(gc, fam, cfg, note);
          n++;
        }
        for (const id of Array.isArray(res.removed) ? res.removed : []) if (Number.isSafeInteger(id)) { await applyRemoved(gc, kind, id); n++; }
      });
      cursor = typeof res.cursor === 'string' && res.cursor ? res.cursor : null;
      if (!cursor) break;
    }
    if (full && !cursor) {
      const mapped = await store.all(gc, 'SELECT hub_id FROM hub_notes WHERE kind = ? AND hub_id IS NOT NULL', [kind]);
      await store.tx(gc, async () => { for (const m of mapped) if (!seen.has(m.hub_id)) { await applyRemoved(gc, kind, m.hub_id); n++; } });
    }
    st.since[key] = max;
  }
  st.pulledAt = now;
  if (full) st.fullAt = now;
  st.pending = false;
  await save(gc);
  return n;
}

/** The notebook is gone in the hub (a fresh hub): back to Familie's own board; the next run moves it again. */
async function rollback(gc, why) {
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM hub_notes');
    await store.run(gc, 'DELETE FROM hub_gone');
    await store.run(gc, 'UPDATE checklist_items SET hub_item = NULL WHERE hub_item IS NOT NULL');
  });
  state.st = fresh();
  await save(gc);
  gc.log.warn('board back in Familie', why);
}

/**
 * One run (the background run, after a change in Familie, after notes_changed): move, push, pull. → what happened;
 * never throws. opts.pull: pull now (notes_changed).
 */
async function sync(gc, fam, cfg, now = Date.now(), opts = {}) {
  if (state.running) {
    await state.running.catch(() => {});
    if (!opts.pull) return { skipped: 'running' };
  }
  const run = (async () => {
    if (!cfg.modules.board) return { skipped: 'module_off' };
    if (!(await hubThere(gc, now))) return { skipped: 'unavailable' };
    const ids = fam.list.map((m) => m.userId).slice(0, 50);
    if (!ids.length) return { skipped: 'no_family' };
    const st = await load(gc);
    const budget = { n: 0 };
    try {
      if (st.mode !== 'hub') {
        await migrate(gc, fam, cfg, now, budget, ids);
        await reconcile(gc);
        await pushChanges(gc, fam, now, budget);
        const pulled = await pull(gc, fam, cfg, now, budget, true);
        return { migrated: true, pulled, calls: budget.n };
      }
      if (st.members !== membersKey(ids)) {
        await bindBoth(gc, cfg, budget, ids);
        st.members = membersKey(ids);
        await save(gc);
      }
      await reconcile(gc);
      const pushed = await pushChanges(gc, fam, now, budget);
      let pulled = 0;
      const full = now - st.fullAt >= FULL_EVERY_MS;
      if (opts.pull || st.pending || full || now - st.pulledAt >= PULL_EVERY_MS) pulled = await pull(gc, fam, cfg, now, budget, full);
      return { pushed, pulled, calls: budget.n };
    } catch (e) {
      const code = (e && e.code) || 'error';
      if (e instanceof HubError && code === 'not_found' && st.mode === 'hub') {
        // which notebook is missing? notes_list answers not_found only for that
        try { await rollback(gc, 'notebook_gone'); } catch (x) { warn(gc, 'rollback', 'board rollback failed', (x && x.code) || 'error'); }
        return { rolledBack: true, calls: budget.n };
      }
      warn(gc, `sync:${code}`, 'board sync with Notizen & Aufgaben failed', code, e && e.field ? e.field : '');
      return { error: code, calls: budget.n };
    }
  })();
  state.running = run;
  try { return await run; } finally { if (state.running === run) state.running = null; }
}

/** notes_changed { v, key, ids, removed, at } from the hub (only the hub): pull soon. */
async function changed(gc, call, loadFam) {
  const c = call || {};
  if (c.caller !== HUB) return { ok: false, code: 'forbidden' };
  const p = c.payload && typeof c.payload === 'object' ? c.payload : {};
  if (!KIND_OF[p.key]) return { ok: false, code: 'invalid' };
  const st = await load(gc);
  if (st.mode !== 'hub') return { ok: true, ignored: true };
  st.pending = true;
  await save(gc);
  if (!state.noTimer && !state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      loadFam().then(({ fam, cfg }) => sync(gc, fam, cfg, Date.now(), { pull: true })).catch(() => {});
    }, 1000);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }
  return { ok: true };
}

function stop() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

// ─── who changed what (server/board.js, inside the request's transaction) ───

/** `userId` changed note / checklist `localId` (only while the board is in the hub: the person of the next note_save). */
async function touched(gc, kind, localId, userId) {
  if (!(await inHub(gc))) return;
  await store.run(gc, 'UPDATE hub_notes SET by_user = ?, dirty = dirty + 1 WHERE kind = ? AND local_id = ?', [userId, kind, localId]);
}

/** `userId` deletes note / checklist `localId`: the hub's note goes as well (with the next run). */
async function deleting(gc, kind, localId, userId) {
  if (!(await inHub(gc))) return;
  const m = await store.one(gc, 'SELECT hub_id FROM hub_notes WHERE kind = ? AND local_id = ?', [kind, localId]);
  if (m && m.hub_id != null) await store.run(gc, 'INSERT OR REPLACE INTO hub_gone (kind, hub_id, by_user) VALUES (?, ?, ?)', [kind, m.hub_id, userId]);
  await store.run(gc, 'DELETE FROM hub_notes WHERE kind = ? AND local_id = ?', [kind, localId]);
}

/** After a change in Familie (board.js, after the commit): to the hub at once — only while the board lives there. */
async function afterWrite(gc, fam, cfg) {
  if (!(await inHub(gc))) return;
  await sync(gc, fam, cfg, Date.now());
}

/** GET board: where the board lives { home: 'familie' | 'notizen', since } (the apps may say „in Notizen & Aufgaben“). */
async function where(gc) {
  const st = await load(gc);
  // moved, and the hub still there (a hub that went for good: the board is Familie's again for the apps)
  const there = st.mode === 'hub' && (await hubThere(gc));
  return { home: there ? 'notizen' : 'familie', since: there && st.migratedAt ? new Date(st.migratedAt).toISOString() : null };
}

module.exports = { HUB, SERVICES, KEYS, STATE_KEY, PULL_EVERY_MS, state, reset, load, inHub, hubThere, sync, changed, stop, touched, deleting, afterWrite, where, shown, stripTitle };
