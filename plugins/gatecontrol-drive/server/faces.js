'use strict';

// People in the photos (since 1.16.0, feature `photoPeople`): the devices find the faces on the device (YuNet) and send
// only their feature vectors (SFace, 128 values); Drive groups them per person and model — nobody sees another person's
// people. Pictures never leave the server for this. Only while the person's switch `people` is on (photos/settings,
// work.js); turning it off deletes every face, person and name of theirs. The children's folders (child:<user>) only
// while `peopleKids` is on (off again: their faces go).
//
//   PUT nodes/<id>/faces { model, faces: [{ box: [x, y, w, h], landmarks?: [[x, y] ×5], score, embedding }] }
//                         → { id, model, faces: [{ id, box, person | null }] } — a picture one reads (403 feature_off
//                         while people is off, also { reason: 'kids' } in a child's folder while peopleKids is off; 409
//                         encrypted for a vault); box 0 … 1 of the upright picture; embedding base64 of float32 little
//                         endian, MODELS[model].dim values; ≤ 50 faces; [] = looked at, none. A second call replaces the
//                         faces of this picture for this person and model (a face the person had confirmed keeps its
//                         person where the new box covers the old one). An unknown model: 400 invalid { field: 'model' }.
//   GET photos?unfaced=1&model=   (photos.js) the pictures one reads not yet looked at for this person and model
//   GET people           → { people: [{ id, name, count, hidden, cover: { faceId, nodeId, box, item }, contact }],
//                         progress: { done, total } } — count: photos; item: the photo item (preview / largeUrl — the
//                         client cuts the face out); progress: the pictures looked at / every picture faces are found on
//   GET people/<id>      → { person: { …, together: [{ id, name, count }], places: [{ key, name, count }], uncertain,
//                         years: { from, to } } }
//   PATCH people/<id>    { name?, hidden?, contact?: { kind: 'family' | 'contact', id, name } | null } → { person,
//                         mergedInto } — a name another person of mine has (case and accents aside) merges this one into
//                         that one (mergedInto its id); '' or null removes the name
//   POST people/<id>/merge { into } → { person }     every face of <id> to `into`
//   GET people/<id>/similar → { people: [{ id, name, count, score }] }   centre to centre ≥ merge, ≤ 3
//   GET people/<id>/uncertain?limit= → { faces: [{ faceId, box, item, score }] }
//   POST people/<id>/confirm { faceIds, yes } → { person, changed }   yes: they are this person; no: never suggested again
//   POST faces/<id>/move { person: <id> | null } → { face: { id, person } }   "Zu … verschieben" / "Nicht diese Person"
//   GET photos?person=<id>[,<id>…]  (photos.js) the photos with every one of them; with=people: items carry `people`
//
// Grouping (on PUT faces, incremental): each new face goes to the most similar person (cosine of the face to the
// person's centre) when that is ≥ same; else it is unsure (between maybe and same: the nearest person that is not
// hidden — GET people/<id>/uncertain) and joins the most similar open group (≥ same to its centre) or starts one; a group
// of NEW_PERSON faces becomes a person without a name. A centre is the normalised sum of the faces' vectors (kept as
// the sum, so a face in or out changes it at once). The centres of a person's people and groups stay in memory per
// person and model — no face is compared with every other face. Rejected pairs (face, person) are never suggested
// again. Changes of people (a new one, a name, hidden, merged, removed, faces confirmed or moved) are the op 'people'
// in the change log (the root of my files), so the other devices reload.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const { fail, posInt, line } = require('./util');

// photos.js and work.js need this module; loaded when first used
const photos = () => require('./photos');
const work = () => require('./work');

// the models whose vectors are comparable, each with its thresholds (cosine similarity)
const MODELS = Object.freeze({
  'sface-2021dec': Object.freeze({ dim: 128, same: 0.42, maybe: 0.30, merge: 0.45 }),
});
const DEFAULT_MODEL = 'sface-2021dec';
const FACES_MAX = 50;
const NEW_PERSON = 3;
const NAME_MAX = 80;
const CONTACT_MAX = 120;
const SIMILAR_MAX = 3;
const TOGETHER_MAX = 10;
const PLACES_MAX = 10;
const UNCERTAIN_MAX = 200;
const CONFIRM_MAX = 500;
const IOU_KEEP = 0.5;

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();

// ── vectors ─────────────────────────────────────────────

const toBlob = (v) => ({ b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') });
function fromBlob(b, dim) {
  const buf = b && typeof b === 'object' && typeof b.b64 === 'string' ? Buffer.from(b.b64, 'base64') : (Buffer.isBuffer(b) ? b : null);
  const out = new Float32Array(dim);
  if (!buf || buf.length !== dim * 4) return out;
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  const out = new Float32Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function addTo(sum, v, sign = 1) { for (let i = 0; i < sum.length; i++) sum[i] += sign * v[i]; return sum; }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/** The models of an answer: MODELS[id] or 400 invalid { field: 'model' }. */
function modelArg(v) {
  const id = v == null || v === '' ? DEFAULT_MODEL : String(v);
  if (!Object.prototype.hasOwnProperty.call(MODELS, id)) throw fail('invalid', { field: 'model' });
  return { id, ...MODELS[id] };
}

// ── the centres in memory ───────────────────────────────
//
// Per person and model: the people and open groups with their centres in one Float32Array (row i: dim values). Used
// only inside a transaction (store.tx runs one at a time); a failed transaction forgets the entry (read again next time).

const cache = new Map();
const FLAG_PENDING = 1;
const FLAG_HIDDEN = 2;

class Centres {
  constructor(dim) { this.dim = dim; this.n = 0; this.ids = new Int32Array(64); this.flags = new Uint8Array(64); this.mat = new Float32Array(64 * dim); this.row = new Map(); }

  set(id, flags, centre) {
    let i = this.row.get(id);
    if (i == null) {
      if (this.n === this.ids.length) {
        const cap = this.ids.length * 2;
        const ids = new Int32Array(cap); ids.set(this.ids); this.ids = ids;
        const fl = new Uint8Array(cap); fl.set(this.flags); this.flags = fl;
        const m = new Float32Array(cap * this.dim); m.set(this.mat); this.mat = m;
      }
      i = this.n++;
      this.row.set(id, i);
      this.ids[i] = id;
    }
    this.flags[i] = flags;
    this.mat.set(centre, i * this.dim);
  }

  remove(id) {
    const i = this.row.get(id);
    if (i == null) return;
    const last = --this.n;
    if (i !== last) {
      this.ids[i] = this.ids[last];
      this.flags[i] = this.flags[last];
      this.mat.copyWithin(i * this.dim, last * this.dim, (last + 1) * this.dim);
      this.row.set(this.ids[i], i);
    }
    this.row.delete(id);
  }

  /** The nearest person, the nearest person not hidden, the nearest open group → { person, visible, group } ({ id, score } | null). */
  nearest(v) {
    const d = this.dim;
    let person = null;
    let visible = null;
    let group = null;
    for (let i = 0; i < this.n; i++) {
      let s = 0;
      const o = i * d;
      for (let k = 0; k < d; k++) s += this.mat[o + k] * v[k];
      const f = this.flags[i];
      if (f & FLAG_PENDING) { if (!group || s > group.score) group = { id: this.ids[i], score: s }; continue; }
      if (!person || s > person.score) person = { id: this.ids[i], score: s };
      if (!(f & FLAG_HIDDEN) && (!visible || s > visible.score)) visible = { id: this.ids[i], score: s };
    }
    return { person, visible, group };
  }
}

const flagsOf = (p) => (p.pending ? FLAG_PENDING : 0) | (p.hidden ? FLAG_HIDDEN : 0);

async function centres(gc, uid, model) {
  const key = `${uid}|${model.id}`;
  let c = cache.get(key);
  if (c) return c;
  c = new Centres(model.dim);
  const rows = await store.all(gc, 'SELECT id, pending, hidden, sum FROM persons WHERE user_id = ? AND model = ?', [uid, model.id]);
  for (const r of rows) c.set(r.id, flagsOf(r), unit(fromBlob(r.sum, model.dim)));
  cache.set(key, c);
  return c;
}

/** Forget the centres of person `uid` (every model), or all. */
function forgetCentres(uid) {
  if (uid == null) { cache.clear(); return; }
  for (const k of [...cache.keys()]) if (k.startsWith(`${uid}|`)) cache.delete(k);
}

/** A transaction that changes people: a failure forgets the centres of `uid` (they may be ahead of the database). */
async function tx(ctx, fn) {
  try {
    return await store.tx(ctx.gc, fn);
  } catch (e) {
    forgetCentres(ctx.viewer);
    throw e;
  }
}

// ── the settings (work.js keeps them) ───────────────────

async function settingsOf(ctx) {
  return work().stored(ctx.gc, ctx.viewer);
}

/** people must be on → the settings, else 403 feature_off. */
async function needOn(ctx) {
  const s = await settingsOf(ctx);
  if (!s.people) throw fail('feature_off', { field: 'people' });
  return s;
}

/** The areas faces are found in for the viewer: the visible ones, the children's folders only with peopleKids. */
async function faceAreas(ctx, s) {
  const st = s || await settingsOf(ctx);
  return (await ctx.visible()).filter((v) => st.peopleKids || v.area.kind !== 'child').map((v) => v.area.id);
}

/** The pictures faces are found on (live pictures of faceAreas, no vault) → { where, args } over nodes, or null. */
async function faceScope(ctx, s) {
  const ids = await faceAreas(ctx, s);
  if (!ids.length) return null;
  return { where: `area_id IN (${store.marks(ids.length)}) AND is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND mime LIKE 'image/%'`, args: ids };
}

/** photos.js: scope `sc` narrowed to the pictures not yet looked at with `model` (unfaced=1). */
async function unfaced(ctx, sc, modelId) {
  const model = modelArg(modelId);
  const s = await needOn(ctx);
  const ids = await faceAreas(ctx, s);
  if (!ids.length) return null;
  return {
    where: `${sc.where} AND mime LIKE 'image/%' AND area_id IN (${store.marks(ids.length)}) AND NOT EXISTS (SELECT 1 FROM face_scans s WHERE s.node_id = nodes.id AND s.user_id = ? AND s.model = ?)`,
    args: [...sc.args, ...ids, ctx.viewer, model.id],
  };
}

// ── PUT nodes/<id>/faces ────────────────────────────────

const num = (x) => (typeof x === 'number' ? x : NaN);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** The faces of a body → [{ box, landmarks, score, vec }] or 400 invalid { field: 'faces', index }. */
function facesArg(v, model) {
  if (!Array.isArray(v) || v.length > FACES_MAX) throw fail('invalid', { field: 'faces' });
  return v.map((f, index) => {
    const bad = () => fail('invalid', { field: 'faces', index });
    if (!f || typeof f !== 'object') throw bad();
    const b = Array.isArray(f.box) && f.box.length === 4 ? f.box.map(num) : null;
    if (!b || b.some((x) => !Number.isFinite(x)) || b[2] <= 0 || b[3] <= 0 || b[0] < -0.05 || b[1] < -0.05 || b[0] + b[2] > 1.05 || b[1] + b[3] > 1.05) throw bad();
    const x = clamp01(b[0]);
    const y = clamp01(b[1]);
    const box = [x, y, Math.min(1 - x, b[2]), Math.min(1 - y, b[3])].map((n) => Math.round(n * 1e5) / 1e5);
    let landmarks = null;
    if (f.landmarks != null) {
      if (!Array.isArray(f.landmarks) || f.landmarks.length !== 5) throw bad();
      landmarks = f.landmarks.map((p) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isFinite(num(n)) && n >= -0.1 && n <= 1.1)) throw bad();
        return p.map((n) => Math.round(n * 1e5) / 1e5);
      });
    }
    const score = f.score == null ? 1 : num(f.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw bad();
    if (typeof f.embedding !== 'string' || f.embedding.length > model.dim * 8) throw bad();
    const buf = Buffer.from(f.embedding, 'base64');
    if (buf.length !== model.dim * 4) throw bad();
    const raw = new Float32Array(model.dim);
    for (let i = 0; i < model.dim; i++) raw[i] = buf.readFloatLE(i * 4);
    if (raw.some((n) => !Number.isFinite(n))) throw bad();
    const vec = unit(raw);
    if (!vec.some((n) => n !== 0)) throw bad();
    return { box, landmarks, score, vec };
  });
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - i;
  return u > 0 ? i / u : 0;
}

/** Inside a transaction: the person row's sum changes by `vec` (sign ±1) and its face count → the row after (null: gone). */
async function shift(ctx, model, cs, personId, vec, sign) {
  const p = await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ?', [personId]);
  if (!p) return null;
  const sum = addTo(fromBlob(p.sum, model.dim), vec, sign);
  const count = p.faces + sign;
  if (count <= 0) {
    await dropPerson(ctx, p, cs);
    return null;
  }
  // a group of NEW_PERSON faces becomes a person (never back)
  const pending = p.pending && count >= NEW_PERSON ? 0 : p.pending;
  await store.run(ctx.gc, 'UPDATE persons SET sum = ?, faces = ?, pending = ?, updated_at = ? WHERE id = ?', [toBlob(sum), count, pending, ctx.now, p.id]);
  if (cs) cs.set(p.id, flagsOf({ pending, hidden: p.hidden }), unit(sum));
  if (p.pending && !pending) {
    ctx.peopleChanged = true;
    // its faces are no longer unsure about another person
    await store.run(ctx.gc, 'UPDATE faces SET maybe_id = NULL, maybe_score = NULL WHERE person_id = ?', [p.id]);
  }
  return { ...p, faces: count, pending };
}

/** Inside a transaction: person row `p` goes (its faces are without a person then). */
async function dropPerson(ctx, p, cs) {
  await store.run(ctx.gc, 'UPDATE faces SET person_id = NULL, sure = 0 WHERE person_id = ?', [p.id]);
  await store.run(ctx.gc, 'UPDATE faces SET maybe_id = NULL, maybe_score = NULL WHERE maybe_id = ?', [p.id]);
  await store.run(ctx.gc, 'DELETE FROM face_rejects WHERE person_id = ?', [p.id]);
  await store.run(ctx.gc, 'DELETE FROM persons WHERE id = ?', [p.id]);
  if (cs) cs.remove(p.id);
  if (!p.pending) ctx.peopleChanged = true;
}

/** Inside a transaction: a new, empty group (the face that starts it is added next) → its id. */
async function newGroup(ctx, model, cs) {
  const r = await store.run(ctx.gc, 'INSERT INTO persons (user_id, model, pending, faces, sum, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?, ?)',
    [ctx.viewer, model.id, toBlob(new Float32Array(model.dim)), ctx.now, ctx.now]);
  const id = Number(r.lastInsertRowid);
  if (cs) cs.set(id, FLAG_PENDING, new Float32Array(model.dim));
  return id;
}

/** Inside a transaction: where a new face goes → { person, maybe: { id, score } | null }, the person's sum updated. */
async function place(ctx, model, cs, vec, rejected) {
  const near = cs.nearest(vec);
  if (near.person && near.person.score >= model.same && !(rejected && rejected.has(near.person.id))) {
    await shift(ctx, model, cs, near.person.id, vec, 1);
    return { person: near.person.id, maybe: null };
  }
  const maybe = near.visible && near.visible.score >= model.maybe && !(rejected && rejected.has(near.visible.id)) ? near.visible : null;
  let group = near.group && near.group.score >= model.same ? near.group.id : null;
  if (group == null) group = await newGroup(ctx, model, cs);
  const after = await shift(ctx, model, cs, group, vec, 1);
  return { person: group, maybe: after && !after.pending ? null : maybe };
}

/** Is node row `n` in a child's folder? */
const inKids = async (gc, n) => !!(await store.one(gc, "SELECT 1 AS x FROM areas WHERE id = ? AND kind = 'child'", [n.area_id]));

/** PUT nodes/<id>/faces */
async function put(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = await needOn(ctx);
  const model = modelArg(b.model == null ? null : b.model);
  if (b.model == null || b.model === '') throw fail('invalid', { field: 'model' });
  const list = facesArg(b.faces, model);
  const n = posInt(id);
  if (!n) throw fail('not_found');
  return tx(ctx, async () => {
    const { node } = await nodes.reach(ctx, n);
    if (node.vault_id) throw fail('encrypted');
    if (node.is_dir !== 0 || !/^image\//.test(String(node.mime || ''))) throw fail('invalid', { field: 'id' });
    if (!s.peopleKids && await inKids(ctx.gc, node)) throw fail('feature_off', { field: 'peopleKids', reason: 'kids' });
    const cs = await centres(ctx.gc, ctx.viewer, model);
    // the faces of this picture so far: out of their people (a confirmed one may pass its person on)
    const old = await store.all(ctx.gc, 'SELECT * FROM faces WHERE user_id = ? AND node_id = ? AND model = ?', [ctx.viewer, node.id, model.id]);
    const oldRejects = new Map();
    for (const f of old) {
      oldRejects.set(f.id, new Set((await store.all(ctx.gc, 'SELECT person_id FROM face_rejects WHERE face_id = ?', [f.id])).map((r) => r.person_id)));
      await store.run(ctx.gc, 'DELETE FROM face_rejects WHERE face_id = ?', [f.id]);
      await store.run(ctx.gc, 'DELETE FROM faces WHERE id = ?', [f.id]);
      if (f.person_id != null) await shift(ctx, model, cs, f.person_id, unit(fromBlob(f.vec, model.dim)), -1);
    }
    const out = [];
    for (const f of list) {
      let match = null;
      let best = IOU_KEEP;
      for (const o of old) {
        const v = iou(f.box, [o.bx, o.by, o.bw, o.bh]);
        if (v >= best) { best = v; match = o; }
      }
      const rejected = match ? oldRejects.get(match.id) : null;
      let person = null;
      let sure = 0;
      let maybe = null;
      const keep = match && match.sure && match.person_id != null ? await store.one(ctx.gc, 'SELECT id FROM persons WHERE id = ?', [match.person_id]) : null;
      if (keep) {
        await shift(ctx, model, cs, keep.id, f.vec, 1);
        person = keep.id;
        sure = 1;
      } else {
        const r = await place(ctx, model, cs, f.vec, rejected);
        person = r.person;
        maybe = r.maybe;
      }
      const ins = await store.run(ctx.gc, `INSERT INTO faces (user_id, node_id, model, bx, by, bw, bh, landmarks, score, vec, person_id, sure, maybe_id, maybe_score, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ctx.viewer, node.id, model.id, ...f.box, f.landmarks ? JSON.stringify(f.landmarks) : null, f.score,
        toBlob(f.vec), person, sure, maybe ? maybe.id : null, maybe ? Math.round(maybe.score * 1e4) / 1e4 : null, ctx.now]);
      const faceId = Number(ins.lastInsertRowid);
      for (const pid of rejected || []) await store.run(ctx.gc, 'INSERT OR IGNORE INTO face_rejects (face_id, person_id) VALUES (?, ?)', [faceId, pid]);
      out.push({ id: faceId, box: f.box, person });
    }
    await store.run(ctx.gc, `INSERT INTO face_scans (user_id, model, node_id, faces, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, model, node_id) DO UPDATE SET faces = excluded.faces, at = excluded.at`, [ctx.viewer, model.id, node.id, list.length, ctx.now]);
    await logPeople(ctx);
    // only people (not the open groups) are named in the answer
    const real = new Set();
    for (const f of out) {
      if (f.person == null) continue;
      const p = await store.one(ctx.gc, 'SELECT pending FROM persons WHERE id = ?', [f.person]);
      if (p && !p.pending) real.add(f.person);
    }
    return { id: node.id, model: model.id, faces: out.map((f) => ({ id: f.id, box: f.box, person: real.has(f.person) ? f.person : null })) };
  });
}

/** Inside a transaction: the op 'people' in the change log (the root of my files) when people changed. */
async function logPeople(ctx) {
  if (!ctx.peopleChanged) return;
  ctx.peopleChanged = false;
  const mine = await areas.row(ctx.gc, areas.idOf.mine(ctx.viewer));
  if (mine && mine.root_id != null) await nodes.log(ctx.gc, mine.id, mine.root_id, 'people', ctx);
}

// ── reading people ──────────────────────────────────────

const boxOf = (f) => [f.bx, f.by, f.bw, f.bh];

/** The live, visible faces of the viewer (SQL over `faces f JOIN nodes n`) → { where, args }. */
async function liveFaces(ctx) {
  const ids = (await ctx.visible()).map((v) => v.area.id);
  if (!ids.length) return null;
  return { where: `f.user_id = ? AND n.deleted_at IS NULL AND n.area_id IN (${store.marks(ids.length)})`, args: [ctx.viewer, ...ids] };
}

/** Photo counts of persons → Map id → count. */
async function counts(ctx, live, ids) {
  const out = new Map();
  if (!live) return out;
  const rows = await store.all(ctx.gc, `SELECT f.person_id AS pid, COUNT(DISTINCT f.node_id) AS n FROM faces f JOIN nodes n ON n.id = f.node_id
    WHERE ${live.where} AND f.person_id IS NOT NULL ${ids ? `AND f.person_id IN (${store.marks(ids.length)})` : ''} GROUP BY f.person_id`, [...live.args, ...(ids || [])]);
  for (const r of rows) out.set(r.pid, r.n);
  return out;
}

/** The cover of each person (their best face: confirmed, large, sharp) → Map id → { faceId, nodeId, box, item }. */
async function covers(ctx, live, ids) {
  const out = new Map();
  if (!live || !ids.length) return out;
  const rows = [];
  for (const part of store.chunks(ids, 80)) {
    rows.push(...await store.all(ctx.gc, `SELECT * FROM (SELECT f.id, f.node_id, f.person_id, f.bx, f.by, f.bw, f.bh,
        ROW_NUMBER() OVER (PARTITION BY f.person_id ORDER BY f.sure DESC, f.score * f.bw * f.bh DESC, f.id) AS rn
      FROM faces f JOIN nodes n ON n.id = f.node_id WHERE ${live.where} AND f.person_id IN (${store.marks(part.length)})) WHERE rn = 1`, [...live.args, ...part]));
  }
  const nodeRows = [];
  for (const part of store.chunks([...new Set(rows.map((r) => r.node_id))])) nodeRows.push(...await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part));
  const items = new Map((await photos().itemsOf(ctx, nodeRows)).map((it) => [it.id, it]));
  for (const r of rows) out.set(r.person_id, { faceId: r.id, nodeId: r.node_id, box: boxOf(r), item: items.get(r.node_id) || null });
  return out;
}

const contactOf = (p) => (p.contact_kind ? { kind: p.contact_kind, id: p.contact_id, name: p.contact_name } : null);

function personView(p, count, cover) {
  return { id: p.id, name: p.name || null, count: count || 0, hidden: p.hidden === 1, cover: cover || null, contact: contactOf(p) };
}

/** The progress of finding faces → { done, total } (the default model). */
async function progress(ctx, s) {
  const sc = await faceScope(ctx, s);
  if (!sc) return { done: 0, total: 0 };
  const r = await store.one(ctx.gc, `SELECT COUNT(*) AS total, SUM(CASE WHEN EXISTS (SELECT 1 FROM face_scans s WHERE s.node_id = nodes.id AND s.user_id = ? AND s.model = ?) THEN 1 ELSE 0 END) AS done
    FROM nodes WHERE ${sc.where}`, [ctx.viewer, DEFAULT_MODEL, ...sc.args]);
  return { done: (r && r.done) || 0, total: (r && r.total) || 0 };
}

/** GET people */
async function list(ctx) {
  const s = await settingsOf(ctx);
  const rows = await store.all(ctx.gc, 'SELECT * FROM persons WHERE user_id = ? AND pending = 0', [ctx.viewer]);
  const live = await liveFaces(ctx);
  const n = await counts(ctx, live, null);
  const shown = rows.filter((p) => n.get(p.id));
  const cv = await covers(ctx, live, shown.map((p) => p.id));
  shown.sort((a, b) => (!!b.name - !!a.name) || (n.get(b.id) - n.get(a.id)) || a.id - b.id);
  return { people: shown.map((p) => personView(p, n.get(p.id), cv.get(p.id))), progress: s.people ? await progress(ctx, s) : { done: 0, total: 0 } };
}

/** A person of the viewer (not an open group) → row, else 404. */
async function own(ctx, id) {
  const n = posInt(id);
  const p = n ? await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ? AND user_id = ? AND pending = 0', [n, ctx.viewer]) : null;
  if (!p) throw fail('not_found');
  return p;
}

/** One person as GET people/<id> answers it. */
async function full(ctx, p) {
  const live = await liveFaces(ctx);
  const n = await counts(ctx, live, [p.id]);
  const cv = await covers(ctx, live, [p.id]);
  const out = personView(p, n.get(p.id), cv.get(p.id));
  if (!live) return { ...out, together: [], places: [], uncertain: 0, years: { from: null, to: null } };
  const together = await store.all(ctx.gc, `SELECT q.id, q.name, COUNT(DISTINCT f2.node_id) AS n FROM faces f JOIN nodes n ON n.id = f.node_id
      JOIN faces f2 ON f2.node_id = f.node_id AND f2.user_id = f.user_id AND f2.person_id <> f.person_id JOIN persons q ON q.id = f2.person_id
    WHERE ${live.where} AND f.person_id = ? AND q.pending = 0 AND q.hidden = 0 GROUP BY q.id ORDER BY n DESC, q.id LIMIT ?`, [...live.args, p.id, TOGETHER_MAX]);
  const where = await store.all(ctx.gc, `SELECT g.id, g.name, COUNT(DISTINCT n.id) AS c FROM faces f JOIN nodes n ON n.id = f.node_id JOIN geo_places g ON g.id = n.geo_place
    WHERE ${live.where} AND f.person_id = ? GROUP BY g.id ORDER BY c DESC, g.name LIMIT ?`, [...live.args, p.id, PLACES_MAX]);
  const unsure = await store.one(ctx.gc, `SELECT COUNT(DISTINCT f.node_id) AS c FROM faces f JOIN nodes n ON n.id = f.node_id
    WHERE ${live.where} AND f.maybe_id = ? AND (f.person_id IS NULL OR f.person_id <> ?)`, [...live.args, p.id, p.id]);
  const yr = await store.one(ctx.gc, `SELECT MIN(${nodes.TAKEN.replace(/(taken_at|mtime|created_at)/g, 'n.$1')}) AS f, MAX(${nodes.TAKEN.replace(/(taken_at|mtime|created_at)/g, 'n.$1')}) AS l
    FROM faces f JOIN nodes n ON n.id = f.node_id WHERE ${live.where} AND f.person_id = ?`, [...live.args, p.id]);
  const year = (ms) => (ms == null ? null : new Date(ms).getFullYear());
  return {
    ...out,
    together: together.map((r) => ({ id: r.id, name: r.name || null, count: r.n })),
    places: where.map((r) => ({ key: `geonames:${r.id}`, name: r.name, count: r.c })),
    uncertain: (unsure && unsure.c) || 0,
    years: { from: year(yr && yr.f), to: year(yr && yr.l) },
  };
}

/** GET people/<id> */
async function get(ctx, id) {
  return { person: await full(ctx, await own(ctx, id)) };
}

// ── changing people ─────────────────────────────────────

function nameArg(v) {
  if (v == null) return null;
  if (typeof v !== 'string') throw fail('invalid', { field: 'name' });
  const s = line(v);
  if (s.length > NAME_MAX) throw fail('invalid', { field: 'name' });
  return s || null;
}

function contactArg(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || !['family', 'contact'].includes(v.kind)) throw fail('invalid', { field: 'contact' });
  const id = typeof v.id === 'number' || typeof v.id === 'string' ? line(String(v.id)) : null;
  const name = line(v.name);
  if (!id || id.length > CONTACT_MAX || !name || name.length > CONTACT_MAX) throw fail('invalid', { field: 'contact' });
  return { kind: v.kind, id, name };
}

/**
 * Inside a transaction: person `from` goes into `into` (same person and model): every face, the sum, the unsure faces
 * and the rejections; `into` keeps its name, contact and hidden, takes those of `from` where it has none.
 */
async function mergeRows(ctx, from, into) {
  const model = modelArg(into.model);
  const sum = addTo(fromBlob(into.sum, model.dim), fromBlob(from.sum, model.dim), 1);
  await store.run(ctx.gc, 'UPDATE faces SET person_id = ? WHERE person_id = ?', [into.id, from.id]);
  await store.run(ctx.gc, 'UPDATE faces SET maybe_id = NULL, maybe_score = NULL WHERE maybe_id IN (?, ?) AND person_id = ?', [from.id, into.id, into.id]);
  await store.run(ctx.gc, 'UPDATE faces SET maybe_id = ? WHERE maybe_id = ? AND id NOT IN (SELECT face_id FROM face_rejects WHERE person_id = ?)', [into.id, from.id, into.id]);
  await store.run(ctx.gc, 'UPDATE faces SET maybe_id = NULL, maybe_score = NULL WHERE maybe_id = ?', [from.id]);
  await store.run(ctx.gc, 'INSERT OR IGNORE INTO face_rejects (face_id, person_id) SELECT face_id, ? FROM face_rejects WHERE person_id = ?', [into.id, from.id]);
  await store.run(ctx.gc, 'DELETE FROM face_rejects WHERE person_id = ?', [from.id]);
  // a face of the merged person that was rejected for `into` stays with it (the person said so now)
  await store.run(ctx.gc, 'DELETE FROM face_rejects WHERE person_id = ? AND face_id IN (SELECT id FROM faces WHERE person_id = ?)', [into.id, into.id]);
  const name = into.name || from.name || null;
  const contact = into.contact_kind ? into : from;
  await store.run(ctx.gc, `UPDATE persons SET sum = ?, faces = ?, name = ?, name_fold = ?, contact_kind = ?, contact_id = ?, contact_name = ?, updated_at = ? WHERE id = ?`,
    [toBlob(sum), into.faces + from.faces, name, name ? fold(name) : null, contact.contact_kind || null, contact.contact_id || null, contact.contact_name || null, ctx.now, into.id]);
  await store.run(ctx.gc, 'DELETE FROM persons WHERE id = ?', [from.id]);
  forgetCentres(ctx.viewer);
  ctx.peopleChanged = true;
}

/** PATCH people/<id> → { person, mergedInto } */
async function patch(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const name = has('name') ? nameArg(b.name) : undefined;
  if (has('hidden') && typeof b.hidden !== 'boolean') throw fail('invalid', { field: 'hidden' });
  const contact = has('contact') ? contactArg(b.contact) : undefined;
  let mergedInto = null;
  const pid = await tx(ctx, async () => {
    const p = await own(ctx, id);
    if (has('hidden')) await store.run(ctx.gc, 'UPDATE persons SET hidden = ?, updated_at = ? WHERE id = ?', [b.hidden ? 1 : 0, ctx.now, p.id]);
    if (contact !== undefined) {
      await store.run(ctx.gc, 'UPDATE persons SET contact_kind = ?, contact_id = ?, contact_name = ?, updated_at = ? WHERE id = ?',
        [contact ? contact.kind : null, contact ? contact.id : null, contact ? contact.name : null, ctx.now, p.id]);
    }
    let result = p.id;
    if (name !== undefined) {
      const other = name ? await store.one(ctx.gc, 'SELECT * FROM persons WHERE user_id = ? AND model = ? AND pending = 0 AND name_fold = ? AND id <> ?', [ctx.viewer, p.model, fold(name), p.id]) : null;
      if (other) {
        await mergeRows(ctx, await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ?', [p.id]), other);
        mergedInto = other.id;
        result = other.id;
      } else {
        await store.run(ctx.gc, 'UPDATE persons SET name = ?, name_fold = ?, updated_at = ? WHERE id = ?', [name, name ? fold(name) : null, ctx.now, p.id]);
      }
    }
    forgetCentres(ctx.viewer);
    ctx.peopleChanged = true;
    await logPeople(ctx);
    return result;
  });
  return { person: await full(ctx, await own(ctx, pid)), mergedInto };
}

/** POST people/<id>/merge { into } → { person } */
async function merge(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const into = posInt(b.into);
  if (!into) throw fail('invalid', { field: 'into' });
  await tx(ctx, async () => {
    const from = await own(ctx, id);
    const to = await own(ctx, into);
    if (from.id === to.id || from.model !== to.model) throw fail('invalid', { field: 'into' });
    await mergeRows(ctx, from, to);
    await logPeople(ctx);
  });
  return { person: await full(ctx, await own(ctx, into)) };
}

/** GET people/<id>/similar → { people } — other people (not hidden) whose centre is ≥ merge to this one's. */
async function similar(ctx, id) {
  const p = await own(ctx, id);
  const model = modelArg(p.model);
  const c = unit(fromBlob(p.sum, model.dim));
  const rows = await store.all(ctx.gc, 'SELECT id, name, sum FROM persons WHERE user_id = ? AND model = ? AND pending = 0 AND hidden = 0 AND id <> ?', [ctx.viewer, p.model, p.id]);
  const hits = rows.map((r) => ({ r, score: dot(c, unit(fromBlob(r.sum, model.dim))) })).filter((x) => x.score >= model.merge)
    .sort((a, b) => b.score - a.score).slice(0, SIMILAR_MAX);
  const n = await counts(ctx, await liveFaces(ctx), hits.map((x) => x.r.id));
  return { people: hits.filter((x) => n.get(x.r.id)).map((x) => ({ id: x.r.id, name: x.r.name || null, count: n.get(x.r.id), score: Math.round(x.score * 1000) / 1000 })) };
}

/** GET people/<id>/uncertain?limit= → { faces: [{ faceId, box, item, score }] } — the most likely first. */
async function uncertain(ctx, id, q) {
  const p = await own(ctx, id);
  const lim = q && q.limit != null && q.limit !== '' ? posInt(q.limit) : 50;
  if (!lim) throw fail('invalid', { field: 'limit' });
  const live = await liveFaces(ctx);
  if (!live) return { faces: [] };
  const rows = await store.all(ctx.gc, `SELECT f.id, f.node_id, f.bx, f.by, f.bw, f.bh, f.maybe_score FROM faces f JOIN nodes n ON n.id = f.node_id
    WHERE ${live.where} AND f.maybe_id = ? AND (f.person_id IS NULL OR f.person_id <> ?) ORDER BY f.maybe_score DESC, f.id LIMIT ?`, [...live.args, p.id, p.id, Math.min(UNCERTAIN_MAX, lim)]);
  const nodeRows = [];
  for (const part of store.chunks([...new Set(rows.map((r) => r.node_id))])) nodeRows.push(...await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part));
  const items = new Map((await photos().itemsOf(ctx, nodeRows)).map((it) => [it.id, it]));
  return { faces: rows.map((r) => ({ faceId: r.id, box: boxOf(r), item: items.get(r.node_id) || null, score: r.maybe_score })) };
}

/** Inside a transaction: face row `f` goes to person `to` (row, or null: to none) — sure; sums and centres follow. */
async function moveFace(ctx, f, to) {
  const model = modelArg(f.model);
  const vec = unit(fromBlob(f.vec, model.dim));
  if (f.person_id != null && (!to || f.person_id !== to.id)) await shift(ctx, model, null, f.person_id, vec, -1);
  if (to && f.person_id !== to.id) await shift(ctx, model, null, to.id, vec, 1);
  await store.run(ctx.gc, 'UPDATE faces SET person_id = ?, sure = 1, maybe_id = NULL, maybe_score = NULL WHERE id = ?', [to ? to.id : null, f.id]);
  if (to) await store.run(ctx.gc, 'DELETE FROM face_rejects WHERE face_id = ? AND person_id = ?', [f.id, to.id]);
}

const reject = (ctx, faceId, personId) => store.run(ctx.gc, 'INSERT OR IGNORE INTO face_rejects (face_id, person_id) VALUES (?, ?)', [faceId, personId]);

/** POST people/<id>/confirm { faceIds, yes } → { person, changed } */
async function confirm(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const list = Array.isArray(b.faceIds) ? b.faceIds.map(posInt) : null;
  if (!list || !list.length || list.length > CONFIRM_MAX || list.some((x) => !x)) throw fail('invalid', { field: 'faceIds' });
  if (typeof b.yes !== 'boolean') throw fail('invalid', { field: 'yes' });
  let changed = 0;
  await tx(ctx, async () => {
    const p = await own(ctx, id);
    for (const fid of [...new Set(list)]) {
      const f = await store.one(ctx.gc, 'SELECT * FROM faces WHERE id = ? AND user_id = ?', [fid, ctx.viewer]);
      if (!f || f.model !== p.model) throw fail('invalid', { field: 'faceIds', ids: [fid] });
      if (b.yes) {
        if (f.person_id !== p.id || !f.sure) { await moveFace(ctx, f, p); changed++; }
      } else {
        await reject(ctx, f.id, p.id);
        if (f.person_id === p.id) await moveFace(ctx, f, null);
        else await store.run(ctx.gc, 'UPDATE faces SET maybe_id = NULL, maybe_score = NULL WHERE id = ? AND maybe_id = ?', [f.id, p.id]);
        changed++;
      }
    }
    forgetCentres(ctx.viewer);
    if (changed) ctx.peopleChanged = true;
    await logPeople(ctx);
  });
  return { person: await full(ctx, await own(ctx, id)), changed };
}

/** POST faces/<id>/move { person: <id> | null } → { face: { id, person } } */
async function move(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Object.prototype.hasOwnProperty.call(b, 'person')) throw fail('invalid', { field: 'person' });
  const to = b.person == null ? null : posInt(b.person);
  if (b.person != null && !to) throw fail('invalid', { field: 'person' });
  const fid = posInt(id);
  if (!fid) throw fail('not_found');
  return tx(ctx, async () => {
    const f = await store.one(ctx.gc, 'SELECT * FROM faces WHERE id = ? AND user_id = ?', [fid, ctx.viewer]);
    if (!f) throw fail('not_found');
    const target = to ? await own(ctx, to) : null;
    if (target && target.model !== f.model) throw fail('invalid', { field: 'person' });
    // "Nicht diese Person": never suggested for the person it was in again
    if (f.person_id != null && (!target || target.id !== f.person_id)) await reject(ctx, f.id, f.person_id);
    await moveFace(ctx, f, target);
    forgetCentres(ctx.viewer);
    ctx.peopleChanged = true;
    await logPeople(ctx);
    return { face: { id: f.id, person: target ? target.id : null } };
  });
}

// ── search, filters, items ──────────────────────────────

/** The viewer's named people that are not hidden → [{ id, name, fold }] (once a request). */
function named(ctx) {
  if (!ctx.namedPeople) {
    ctx.namedPeople = store.all(ctx.gc, 'SELECT id, name, name_fold FROM persons WHERE user_id = ? AND pending = 0 AND hidden = 0 AND name IS NOT NULL', [ctx.viewer])
      .then((rows) => rows.map((r) => ({ id: r.id, name: r.name, fold: r.name_fold || fold(r.name) })));
  }
  return ctx.namedPeople;
}

/** Does folded name `f` have word `w` (or a word starting with it, 3 letters and more)? */
function nameHas(f, w) {
  return f.split(/[^a-z0-9]+/).some((x) => x === w || (w.length >= 3 && x.startsWith(w)));
}

/** The SQL of one search word for people → { sql, args, people } or null (no person has that word). */
async function wordClause(ctx, word) {
  const w = fold(word).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!w) return null;
  const hits = (await named(ctx)).filter((p) => w.split(' ').every((x) => nameHas(p.fold, x)));
  if (!hits.length) return null;
  return { sql: `id IN (SELECT node_id FROM faces WHERE user_id = ? AND person_id IN (${store.marks(hits.length)}))`, args: [ctx.viewer, ...hits.map((p) => p.id)], people: hits };
}

/** person=<id>[,<id>…] → scope narrowed to photos with every one of them; not a person of mine: 404 not_found { field }. */
async function narrowPeople(ctx, sc, v) {
  const ids = [...new Set(String(v).split(',').map((x) => posInt(x.trim())))];
  if (!ids.length || ids.length > 10 || ids.some((x) => !x)) throw fail('invalid', { field: 'person' });
  let { where } = sc;
  const args = [...sc.args];
  for (const id of ids) {
    const p = await store.one(ctx.gc, 'SELECT id FROM persons WHERE id = ? AND user_id = ? AND pending = 0', [id, ctx.viewer]);
    if (!p) throw fail('not_found', { field: 'person' });
    where += ' AND id IN (SELECT node_id FROM faces WHERE user_id = ? AND person_id = ?)';
    args.push(ctx.viewer, id);
  }
  return { where, args };
}

/** with=people: the named people (not hidden) on each item → item.people [id] (in place). */
async function attachPeople(ctx, items) {
  const by = new Map(items.map((it) => [it.id, (it.people = [])]));
  if (!items.length) return;
  for (const part of store.chunks([...by.keys()], 80)) {
    const rows = await store.all(ctx.gc, `SELECT DISTINCT f.node_id, f.person_id FROM faces f JOIN persons p ON p.id = f.person_id
      WHERE f.user_id = ? AND p.pending = 0 AND p.hidden = 0 AND p.name IS NOT NULL AND f.node_id IN (${store.marks(part.length)}) ORDER BY f.person_id`, [ctx.viewer, ...part]);
    for (const r of rows) by.get(r.node_id).push(r.person_id);
  }
}

/** GET photos/suggest: my people whose name starts with `text` → [{ id, name, count }] by count. */
async function suggest(ctx, text) {
  const w = fold(text).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!w) return [];
  const hits = (await named(ctx)).filter((p) => (' ' + p.fold.replace(/[^a-z0-9]+/g, ' ')).includes(' ' + w));
  if (!hits.length) return [];
  const n = await counts(ctx, await liveFaces(ctx), hits.map((p) => p.id));
  return hits.filter((p) => n.get(p.id)).sort((a, b) => n.get(b.id) - n.get(a.id) || a.name.localeCompare(b.name)).slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, count: n.get(p.id) }));
}

// ── removing face data ──────────────────────────────────

/** Every face, person and name of the viewer (photos/settings people: false) → faces removed. */
async function wipe(ctx) {
  const r = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM faces WHERE user_id = ?', [ctx.viewer]);
  const any = await store.one(ctx.gc, 'SELECT 1 AS x FROM persons WHERE user_id = ? AND pending = 0 LIMIT 1', [ctx.viewer]);
  await store.run(ctx.gc, 'DELETE FROM face_rejects WHERE face_id IN (SELECT id FROM faces WHERE user_id = ?)', [ctx.viewer]);
  await store.run(ctx.gc, 'DELETE FROM faces WHERE user_id = ?', [ctx.viewer]);
  await store.run(ctx.gc, 'DELETE FROM persons WHERE user_id = ?', [ctx.viewer]);
  await store.run(ctx.gc, 'DELETE FROM face_scans WHERE user_id = ?', [ctx.viewer]);
  forgetCentres(ctx.viewer);
  if (any) { ctx.peopleChanged = true; await logPeople(ctx); }
  return (r && r.n) || 0;
}

/** Inside a transaction: faces `rows` (with vec, person_id, model) go — their people's sums follow. */
async function dropFaces(ctx, rows) {
  if (!rows.length) return 0;
  for (const part of store.chunks(rows.map((f) => f.id))) {
    await store.run(ctx.gc, `DELETE FROM face_rejects WHERE face_id IN (${store.marks(part.length)})`, part);
    await store.run(ctx.gc, `DELETE FROM faces WHERE id IN (${store.marks(part.length)})`, part);
  }
  for (const f of rows) {
    if (f.person_id == null) continue;
    const model = MODELS[f.model] ? modelArg(f.model) : null;
    if (model) await shift(ctx, model, null, f.person_id, unit(fromBlob(f.vec, model.dim)), -1);
  }
  forgetCentres(ctx.viewer == null ? null : ctx.viewer);
  return rows.length;
}

/** Inside a transaction: peopleKids went off — the viewer's faces in the children's folders go. */
async function dropKids(ctx) {
  const rows = await store.all(ctx.gc, `SELECT f.* FROM faces f JOIN nodes n ON n.id = f.node_id JOIN areas a ON a.id = n.area_id
    WHERE f.user_id = ? AND a.kind = 'child'`, [ctx.viewer]);
  await store.run(ctx.gc, `DELETE FROM face_scans WHERE user_id = ? AND node_id IN (SELECT n.id FROM nodes n JOIN areas a ON a.id = n.area_id WHERE a.kind = 'child')`, [ctx.viewer]);
  const n = await dropFaces(ctx, rows);
  await logPeople(ctx);
  return n;
}

/** nodes.forget: nodes `ids` go for good — their faces (everyone's), sums of the people they were in, the scans. */
async function forget(gc, ids, ctx) {
  const rows = [];
  for (const part of store.chunks(ids)) rows.push(...await store.all(gc, `SELECT * FROM faces WHERE node_id IN (${store.marks(part.length)})`, part));
  for (const part of store.chunks(ids)) await store.run(gc, `DELETE FROM face_scans WHERE node_id IN (${store.marks(part.length)})`, part);
  if (!rows.length) return;
  const c = { gc, now: (ctx && ctx.now) || Date.now(), viewer: null, peopleChanged: false };
  await dropFaces(c, rows);
  forgetCentres(null);
}

module.exports = {
  MODELS, DEFAULT_MODEL, put, list, get, patch, merge, similar, uncertain, confirm, move, unfaced, wordClause, narrowPeople, attachPeople, suggest,
  wipe, dropKids, forget, faceScope, progress, fold, centres, forgetCentres, modelArg,
};
