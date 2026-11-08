'use strict';

// A stand-in for „Notizen & Aufgaben“ (gatecontrol-notizen) in the tests of its sources — contract v1
// (docs/notes-sources-contract.md): an entry for createHost's opts.services that takes todo_changed (and, for Familie,
// the notes services of a bound notebook) and records what it got.
//
//   const hub = fakeHub({ answer?: async (call) => result | undefined })   answer: a test's own reply (undefined: the default)
//   createHost(dir, { gatecontrol: '1.216.0', services: [hub] })
//   hub.calls      [{ name, caller, user, payload }]          every call
//   hub.items      Map(<source>|<id> → item)                  what the pushes left
//   hub.rejected   what the stand-in refused (an item that breaks the contract → rejected like the hub)
//   hub.notebooks  Map(<owner>|<key> → { id, key, title, kind, members, notes: Map(id → note), removed: [id] })
//   checkItem(item) → null | 'field' — the item rules of the contract (§ 2)
//   pullAll(host, user, opts) → every item of `user` through todo_items (all pages; asserts ≤ 16 KB per answer)

const HUB = 'gatecontrol-notizen';
const KINDS = ['task', 'event', 'deadline', 'homework', 'exam', 'list', 'note'];
const ID_RE = /^[A-Za-z0-9:._-]{1,120}$/;
const ROUTE_RE = /^[A-Za-z0-9/._:=-]{0,200}$/;
const COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'grey', 'orange', 'purple'];

/** null when `x` keeps the rules of the contract's item, else the field that does not. */
function checkItem(x, caller) {
  if (!x || typeof x !== 'object') return 'item';
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) return 'id';
  if (!KINDS.includes(x.kind)) return 'kind';
  if (typeof x.title !== 'string' || !x.title || x.title.length > 200 || /[\0-\x1f]/.test(x.title)) return 'title';
  if (x.subtitle != null && (typeof x.subtitle !== 'string' || x.subtitle.length > 200)) return 'subtitle';
  if (x.due != null) {
    if (typeof x.due !== 'string') return 'due';
    if (x.allDay === true ? !/^\d{4}-\d{2}-\d{2}$/.test(x.due) : !/T\d{2}:\d{2}.*(Z|[+-]\d{2}:\d{2})$/.test(x.due)) return 'due';
  }
  if (x.lead != null && x.lead !== 'evening') return 'lead';
  if (!['private', 'work'].includes(x.area)) return 'area';
  if (!Array.isArray(x.users) || !x.users.length || x.users.length > 50 || !x.users.every((u) => Number.isSafeInteger(u) && u > 0)) return 'users';
  if (x.assignee != null && !(Number.isSafeInteger(x.assignee) && x.assignee > 0)) return 'assignee';
  if (x.assigneeName != null && (typeof x.assigneeName !== 'string' || x.assigneeName.length > 60)) return 'assigneeName';
  for (const k of ['important', 'done', 'canComplete']) if (typeof x[k] !== 'boolean') return k;
  if (x.progress != null && !(Number.isSafeInteger(x.progress.done) && Number.isSafeInteger(x.progress.total))) return 'progress';
  if (x.group != null && !(typeof x.group.id === 'string' && /^[A-Za-z0-9:._-]{1,80}$/.test(x.group.id) && typeof x.group.label === 'string' && x.group.label.length <= 80)) return 'group';
  if (x.meta != null) {
    if (typeof x.meta !== 'object' || Array.isArray(x.meta) || JSON.stringify(x.meta).length > 1024) return 'meta';
    for (const [k, v] of Object.entries(x.meta)) {
      if (!(typeof v === 'string' ? v.length <= 120 : typeof v === 'number' || typeof v === 'boolean')) return 'meta';
      if (k === 'type' && !/^[a-z_]{1,32}$/.test(v)) return 'meta';
    }
  }
  if (!x.open || (caller && x.open.plugin !== caller) || typeof x.open.route !== 'string' || !ROUTE_RE.test(x.open.route)) return 'open';
  if (!Number.isSafeInteger(x.updatedAt) || x.updatedAt <= 0) return 'updatedAt';
  return null;
}

const DEFAULT_PROVIDES = {
  todo_changed: { label: { de: 'Änderungen der Quellen', en: 'Changes of the sources' }, maxPerHour: 3600 },
};
const NOTES_PROVIDES = Object.fromEntries(['notes_bind', 'notes_list', 'note_save', 'note_check', 'note_delete', 'notes_import']
  .map((n) => [n, { label: { de: n, en: n }, maxPerHour: 3600 }]));

function fakeHub(o = {}) {
  let nextNote = 800;
  let nextBook = 1;
  const hub = {
    plugin: HUB,
    provides: { ...DEFAULT_PROVIDES, ...(o.notes ? NOTES_PROVIDES : {}) },
    calls: [], items: new Map(), rejected: [], notebooks: new Map(), now: o.now || (() => Date.now()),
    async service(c) {
      hub.calls.push({ name: c.name, caller: c.caller, user: c.user, payload: c.payload });
      if (o.answer) {
        const r = await o.answer(c, hub);
        if (r !== undefined) return r;
      }
      const fn = handlers[c.name];
      if (!fn) return { ok: false, code: 'not_found' };
      return fn(c.payload || {}, c.caller, c.user);
    },
    /** The pushes so far (todo_changed calls only). */
    pushes: () => hub.calls.filter((c) => c.name === 'todo_changed'),
    notebook: (owner, key) => hub.notebooks.get(`${owner}|${key}`) || null,
    /** A note changed „in the hub“ (as a person would there): returns it. */
    edit(owner, key, id, fields, by = null) {
      const b = hub.notebook(owner, key);
      const n = b.notes.get(id);
      Object.assign(n, fields, { updatedAt: hub.now(), updatedBy: by });
      if (n.checklist) n.progress = { done: n.checklist.filter((i) => i.done).length, total: n.checklist.length };
      return n;
    },
  };
  const book = (caller, key) => hub.notebooks.get(`${caller}|${key}`);
  const member = (b, user) => !!(b && user && b.members.includes(user.id));
  const progress = (list) => (list ? { done: list.filter((i) => i.done).length, total: list.length } : null);
  const handlers = {
    todo_changed(p, caller) {
      if (p.v !== 1 || !Array.isArray(p.upsert) || !Array.isArray(p.remove) || p.upsert.length > 200 || p.remove.length > 500) return { ok: false, code: 'invalid' };
      const rejected = [];
      let accepted = 0;
      for (const x of p.upsert) {
        const bad = checkItem(x, caller);
        if (bad) { rejected.push({ id: x && x.id, code: 'invalid', field: bad }); hub.rejected.push({ item: x, field: bad }); continue; }
        const k = `${caller}|${x.id}`;
        const have = hub.items.get(k);
        if (have && have.updatedAt > x.updatedAt) continue;
        hub.items.set(k, x);
        accepted++;
      }
      let removed = 0;
      for (const id of p.remove) if (hub.items.delete(`${caller}|${id}`)) removed++;
      return { ok: true, accepted, removed, rejected };
    },
    notes_bind(p, caller) {
      if (typeof p.key !== 'string' || !Array.isArray(p.members) || !p.members.length || !['notes', 'checklists'].includes(p.kind)) return { ok: false, code: 'invalid' };
      let b = book(caller, p.key);
      if (!b) { b = { id: nextBook++, key: p.key, notes: new Map(), removed: [], refs: new Map() }; hub.notebooks.set(`${caller}|${p.key}`, b); }
      Object.assign(b, { title: p.title, kind: p.kind, members: p.members.slice() });
      return { ok: true, notebookId: b.id };
    },
    notes_import(p, caller) {
      const b = book(caller, p.key);
      if (!b) return { ok: false, code: 'not_found' };
      if (!Array.isArray(p.notes) || p.notes.length > 100) return { ok: false, code: 'invalid' };
      const ids = {};
      let imported = 0;
      let skipped = 0;
      for (const x of p.notes) {
        if (b.refs.has(x.ref)) { ids[x.ref] = b.refs.get(x.ref); skipped++; continue; }
        const id = nextNote++;
        b.notes.set(id, note(id, x, x.authorId || null, x.createdAt));
        b.refs.set(x.ref, id);
        ids[x.ref] = id;
        imported++;
      }
      return { ok: true, imported, skipped, ids };
    },
    notes_list(p, caller, user) {
      const b = book(caller, p.key);
      if (!b) return { ok: false, code: 'not_found' };
      if (!member(b, user)) return { ok: false, code: 'forbidden' };
      const list = [...b.notes.values()].filter((n) => p.since == null || n.updatedAt > p.since).sort((x, y) => y.updatedAt - x.updatedAt || y.id - x.id);
      const start = p.cursor ? Number(p.cursor) : 0;
      const page = list.slice(start, start + 30);
      const out = { ok: true, notes: page, cursor: start + 30 < list.length ? String(start + 30) : null };
      if (p.since != null) out.removed = b.removed.filter((r) => r.at > p.since).map((r) => r.id);
      return out;
    },
    note_save(p, caller, user) {
      const b = book(caller, p.key);
      if (!b) return { ok: false, code: 'not_found' };
      if (!member(b, user)) return { ok: false, code: 'forbidden' };
      if (p.color != null && !COLORS.includes(p.color)) return { ok: false, code: 'invalid', field: 'color' };
      if (p.id == null) {
        const id = nextNote++;
        const n = note(id, p, user.id);
        b.notes.set(id, n);
        return { ok: true, note: n };
      }
      const n = b.notes.get(p.id);
      if (!n) return { ok: false, code: 'not_found' };
      for (const k of ['title', 'text', 'color', 'pinned', 'expiresAt', 'due']) if (p[k] !== undefined) n[k] = p[k];
      if (p.checklist !== undefined) n.checklist = p.checklist.map((i, x) => ({ id: i.id || `i${id36()}${x}`, text: i.text, done: !!i.done, doneBy: i.done ? (i.doneBy || user.id) : null }));
      n.progress = progress(n.checklist);
      n.updatedAt = hub.now();
      n.updatedBy = user.id;
      return { ok: true, note: n };
    },
    note_check(p, caller, user) {
      const b = book(caller, p.key);
      if (!b) return { ok: false, code: 'not_found' };
      if (!member(b, user)) return { ok: false, code: 'forbidden' };
      const n = b.notes.get(p.noteId);
      const i = n && n.checklist && n.checklist.find((x) => x.id === p.itemId);
      if (!i) return { ok: false, code: 'not_found' };
      i.done = !!p.done;
      i.doneBy = p.done ? user.id : null;
      n.progress = progress(n.checklist);
      n.updatedAt = hub.now();
      return { ok: true, note: { id: n.id, progress: n.progress } };
    },
    note_delete(p, caller, user) {
      const b = book(caller, p.key);
      if (!b) return { ok: false, code: 'not_found' };
      if (!member(b, user)) return { ok: false, code: 'forbidden' };
      if (!b.notes.delete(p.id)) return { ok: false, code: 'not_found' };
      b.removed.push({ id: p.id, at: hub.now() });
      return { ok: true };
    },
  };
  let seq = 0;
  const id36 = () => (seq++).toString(36);
  function note(id, x, by, createdAt) {
    const list = Array.isArray(x.checklist) ? x.checklist.map((i, k) => ({ id: i.id || `i${id36()}${k}`, text: i.text, done: !!i.done, doneBy: i.done ? (i.doneBy || by) : null })) : null;
    return {
      id, title: x.title || '', text: x.text || '', color: x.color || 'yellow', pinned: !!x.pinned, expiresAt: x.expiresAt || null, due: x.due || null,
      checklist: list, progress: progress(list), updatedAt: hub.now(), updatedBy: by, createdBy: by, createdAt: createdAt || hub.now(),
      open: { plugin: HUB, route: `note/${id}` },
    };
  }
  return hub;
}

/** Every item of `user` through the source's todo_items (all pages). Every answer must stay ≤ 16 KB. */
async function pullAll(host, user, { limit } = {}) {
  const items = [];
  let cursor = null;
  for (let i = 0; i < 1000; i++) {
    const res = await host.callService('todo_items', { caller: HUB, user, payload: { v: 1, cursor, ...(limit ? { limit } : {}) } });
    if (!res || res.ok !== true) return res;
    if (Buffer.byteLength(JSON.stringify(res)) > 16 * 1024) throw new Error('todo_items answer over 16 KB');
    items.push(...res.items);
    cursor = res.cursor;
    if (!cursor) return { ok: true, items, pages: i + 1 };
  }
  throw new Error('todo_items never ends');
}

module.exports = { HUB, fakeHub, checkItem, pullAll };
