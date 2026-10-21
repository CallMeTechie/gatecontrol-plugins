'use strict';

// 1.4.0 — home actions in chats (README "Home actions and plugin cards"), on GateControl's gc.actions
// (permissions.actions): the quick actions the other plugins offer to a person, run as that person with
// that person's rights — GateControl writes the audit entry ("plugin gatecontrol-messenger ran quick
// action … of plugin …"). Feature-detected: without gc.actions (or with the administrator's switch "Haus-
// Aktionen in Chats" off) GET me has no features.actions and every route here answers feature_off.
//
//   GET actions                      the caller's actions → [{ id, plugin, label, icon, kind, needsConfirm }]
//   message kind 'action' { mode }   run     a button every member who may run it can press
//                                    request a member asks; approvers = members who may run it (approve / deny)
//                                    grant   the sender lets one member run it as the sender until a time
//   message kind 'card'              a plugin's card (service send_message with `card`): buttons run as the presser
//   POST messages/:id/action/run { actionId?, plugin? (cards) } · …/action/approve · …/action/deny
// A run happens outside the database transaction (another plugin's action may call back into this one);
// a successful run posts the system message action_run ("Anna hat Haustür ausgeführt").
//
// 1.5.0 (README "Home actions and plugin cards"):
//   GET actions/requestable[?approvers=parents|rights|<id,id>&conversationId=]   what the caller may ASK for: the
//     actions of the possible approvers — also ones the caller cannot run (a child asks for the front door)
//   request `approvers`: 'parents' (Familie's service family_roles; Familie missing → 'rights') | 'rights' | [ids];
//     without it the administrator's default (requestApproversDefault: auto = parents when Familie offers
//     family_roles). Approvers are always members of the chat who may run the action (checked again on approve).
//     A request stays open requestTtlMin (kept per request: expires_at); Familie's children may only ask while
//     childrenMayRequest is on.
//   grant `offAtEnd`: when the grant ends the action runs with state 'off' as the granter (toggles only) and a system
//     message grant_off says so; the longest grant is grantMaxDays.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const people = require('./people');
const messages = require('./messages');
const familie = require('./familie');
const { fail, posInt, text, optText, iso, parseIso, userIds, parseJson } = require('./util');

const SELF = 'gatecontrol-messenger';
const ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const PLUGIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROUTE_RE = /^(?:vpn|services|gateways|inbox|plg-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const CACHE_MS = 20000;
const REQUEST_TTL_MS = 24 * 3600000;     // requests sent before 1.5.0 (they have no expires_at)
const GRANT_MAX_MS = 7 * 86400000;       // the default of grantMaxDays (1.5.0: the administrator sets it)
const APPROVER_CHECK_MAX = 30;
const CARD_ACTIONS_MAX = 4;
const CARD_IMAGE_MAX = 300 * 1024;
const MODES = ['run', 'request', 'grant'];
const DAY = 86400000;

const cache = new Map(); // `${userId}:${interactive}` → { at, list }
function reset() { cache.clear(); }

/** Can the messenger use home actions here (the host has gc.actions and the administrator allows it)? */
function available(gc, cfg) {
  return !!(cfg && cfg.allowActions && gc && gc.actions && typeof gc.actions.list === 'function' && typeof gc.actions.run === 'function');
}

async function langOf(gc, userId) {
  const p = (await people.prefsOf(gc, [userId])).get(userId);
  return p && p.lang === 'en' ? 'en' : 'de';
}

function norm(a) {
  return {
    id: String(a.id), plugin: String(a.plugin), label: String(a.label || a.title || a.id), icon: typeof a.icon === 'string' ? a.icon : null, kind: a.kind || 'button',
    needsConfirm: a.needsConfirm === true || a.confirm === true, state: a.state || null, subtitle: a.subtitle || null, pluginName: a.pluginName || null,
  };
}

/**
 * The actions `userId` may run (cached 20 s) → [{ id, plugin, label, icon, kind, needsConfirm, state, subtitle, pluginName }].
 * `interactive`: what that person may run with a tap (their buttons in the chat); without it what an automation
 * run as that person may do (grants, onArrive). A core that refuses the flag answers the automation list.
 */
async function listFor(gc, userId, now = Date.now(), { interactive = true } = {}) {
  const key = `${userId}:${interactive ? 1 : 0}`;
  const c = cache.get(key);
  if (c && now - c.at < CACHE_MS && now >= c.at) return c.list;
  const lang = await langOf(gc, userId);
  let raw;
  try {
    try { raw = await gc.actions.list(interactive ? { userId, lang, interactive: true } : { userId, lang }); } catch (e) {
      if (!interactive || !e || (e.code !== 'ERR_INVALID' && e.code !== 'ERR_ACTIONS_DENIED')) throw e;
      raw = await gc.actions.list({ userId, lang });
    }
  } catch (e) {
    gc.log.warn('actions list failed', (e && e.code) || 'error');
    raw = [];
  }
  const list = (Array.isArray(raw) ? raw : []).filter((a) => a && typeof a.id === 'string' && typeof a.plugin === 'string' && a.plugin !== SELF).map(norm);
  cache.set(key, { at: now, list });
  return list;
}

const findIn = (list, plugin, id) => list.find((a) => a.id === id && (!plugin || a.plugin === plugin)) || null;

/**
 * Run one action as `userId` → { ok, message, state, error, interactive } (never throws).
 * `interactive` (a person pressed the button: run cards, approvals, plugin card buttons): asked for with
 * { interactive: true } — GateControl ≥ 1.180 with permissions.actions { interactive: true } shows the target
 * plugin a person's tap instead of an automation (the door plugin opens only for that). A core that refuses
 * the flag (ERR_INVALID) gets the plain automation run; one that drops it runs it as an automation — then the
 * target's own refusal message comes back in `message`. Grants and onArrive always run as automation.
 * Called with actionId '<plugin>/<id>' (GateControl ≥ 1.180.0, which this version needs).
 */
async function run(gc, userId, plugin, id, { interactive = false, state = null } = {}) {
  // 1.5.0: state 'on' | 'off' — the state a toggle should end in (a grant's offAtEnd)
  const base = { userId, actionId: `${plugin}/${id}`, lang: await langOf(gc, userId), via: SELF, ...(state ? { state } : {}) };
  const once = (extra) => gc.actions.run({ ...base, ...extra });
  try {
    let r;
    if (interactive) {
      try { r = await once({ interactive: true }); } catch (e) {
        if (!e || (e.code !== 'ERR_INVALID' && e.code !== 'ERR_ACTIONS_DENIED')) throw e;
        r = await once({});
        interactive = false;
      }
    } else r = await once({});
    cache.delete(`${userId}:1`);
    cache.delete(`${userId}:0`);
    if (!r || typeof r !== 'object') return { ok: false, message: null, state: null, error: 'failed', interactive };
    const msg = typeof r.message === 'string' ? r.message : (r.result && typeof r.result.message === 'string' ? r.result.message : null);
    const st = r.state || (r.result && r.result.state) || null;
    return { ok: r.ok === true, message: msg ? msg.slice(0, 120) : null, state: st, error: r.ok === true ? null : String(r.error || r.code || 'failed').slice(0, 40), interactive };
  } catch (e) {
    return { ok: false, message: null, state: null, error: e && e.code === 'ERR_RATE_LIMIT' ? 'rate_limited' : 'failed', interactive };
  }
}

// ─── sending ────────────────────────────────────────────────────────────────

/** When a request is no longer open: its own end (1.5.0), else 24 h after it was sent (requests from before 1.5.0). */
function requestEnd(row) {
  return row.expires_at != null ? row.expires_at : row.created_at + REQUEST_TTL_MS;
}

/** The administrator's default for who approves → 'parents' | 'rights' ('auto': parents when Familie offers family_roles). */
async function approversDefault(gc, cfg) {
  if (cfg.requestApproversDefault === 'parents' || cfg.requestApproversDefault === 'rights') return cfg.requestApproversDefault;
  return (await familie.available(gc, 'family_roles')) ? 'parents' : 'rights';
}

/**
 * The approver group of a request (`approvers` of the body or the query) → { mode: 'parents' | 'rights' | 'list', ids }
 * — ids: the candidates (null = everybody), before the member and rights checks. 'parents' without Familie's
 * family_roles is 'rights'.
 */
async function approverGroup(ctx, want) {
  if (Array.isArray(want)) return { mode: 'list', ids: userIds(want, APPROVER_CHECK_MAX) };
  const m = want == null ? await approversDefault(ctx.gc, ctx.cfg) : want;
  if (m !== 'parents' && m !== 'rights') throw fail('invalid');
  if (m === 'parents') {
    const roles = await familie.roles(ctx.gc, ctx.now);
    if (roles) return { mode: 'parents', ids: roles.parents };
  }
  return { mode: 'rights', ids: null };
}

/** May the viewer send requests? Familie's children only while childrenMayRequest is on (asks Familie only then). */
async function mayRequest(ctx) {
  if (ctx.cfg.childrenMayRequest !== false) return true;
  const roles = await familie.roles(ctx.gc, ctx.now);
  return !(roles && roles.children.includes(ctx.viewer));
}

/**
 * Check `action` of a send body (inside the send transaction) → { meta, row }.
 * run / grant: the sender must be able to run it; request: approvers who may run it.
 */
async function clean(ctx, conv, members, v) {
  if (!available(ctx.gc, ctx.cfg)) throw fail('feature_off');
  if (!v || typeof v !== 'object' || Array.isArray(v) || !MODES.includes(v.mode)) throw fail('invalid');
  if (typeof v.actionId !== 'string' || !ID_RE.test(v.actionId)) throw fail('invalid');
  if (v.plugin != null && (typeof v.plugin !== 'string' || !PLUGIN_RE.test(v.plugin))) throw fail('invalid');
  const plugin = v.plugin || null;
  const others = members.map((m) => m.user_id).filter((u) => u !== ctx.viewer && ctx.users.has(u));
  let entry = null;
  const row = { mode: v.mode, approverIds: null, grantTo: null, grantUntil: null, expiresAt: null, offAtEnd: false, approvers: null };
  if (v.mode === 'run' || v.mode === 'grant') {
    // a run button is pressed by people (interactive); a grant runs as an automation of the sender
    entry = findIn(await listFor(ctx.gc, ctx.viewer, ctx.now, { interactive: v.mode === 'run' }), plugin, v.actionId);
    if (!entry) throw fail('not_allowed');
  }
  if (v.mode === 'grant') {
    // a grant runs as an automation of the granter: never for sensitive actions (needsConfirm, e.g. a door)
    if (entry.needsConfirm) throw fail('not_allowed');
    const g = v.grant;
    if (!g || typeof g !== 'object') throw fail('invalid');
    const to = posInt(g.toUserId);
    if (!to || !others.includes(to)) throw fail('invalid');
    const until = parseIso(g.until);
    // 1.5.0: the administrator's longest grant (grantMaxDays, default 7)
    if (until == null || until <= ctx.now || until > ctx.now + (ctx.cfg.grantMaxDays || 7) * DAY) throw fail('invalid');
    if (g.offAtEnd != null && typeof g.offAtEnd !== 'boolean') throw fail('invalid');
    row.grantTo = to;
    row.grantUntil = until;
    // switched off at the end: only an action with an on/off state
    row.offAtEnd = g.offAtEnd === true && entry.kind === 'toggle';
  }
  if (v.mode === 'request') {
    if (!(await mayRequest(ctx))) throw fail('not_allowed');
    const want = v.approvers !== undefined ? v.approvers : (v.approverIds != null ? v.approverIds : undefined);
    const group = await approverGroup(ctx, want);
    const wanted = group.ids == null ? others : group.ids.filter((u) => others.includes(u));
    const approvers = [];
    for (const u of wanted.slice(0, APPROVER_CHECK_MAX)) {
      const e = findIn(await listFor(ctx.gc, u, ctx.now), plugin, v.actionId);
      if (e) { approvers.push(u); if (!entry) entry = e; }
    }
    if (!approvers.length) throw fail('no_approver');
    row.approverIds = approvers;
    row.approvers = group.mode;
    row.expiresAt = ctx.now + (ctx.cfg.requestTtlMin || 15) * 60000;
  }
  const meta = { mode: v.mode, plugin: entry.plugin, actionId: entry.id, label: optText(v.label, 80) || entry.label, icon: entry.icon, needsConfirm: entry.needsConfirm };
  if (row.approvers) meta.approvers = row.approvers;
  if (row.offAtEnd) meta.offAtEnd = true;
  return { meta, row: { ...row, plugin: entry.plugin } };
}

async function create(ctx, conv, msgId, a) {
  await store.run(ctx.gc, `INSERT INTO action_msgs (msg_id, conv_id, mode, plugin, action_id, state, owner_id, grant_to, grant_until, approver_ids, expires_at, off_at_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`, [msgId, conv.id, a.row.mode, a.meta.plugin, a.meta.actionId, ctx.viewer, a.row.grantTo, a.row.grantUntil,
    a.row.approverIds ? JSON.stringify(a.row.approverIds) : null, a.row.expiresAt, a.row.offAtEnd ? 1 : 0, ctx.now, ctx.now]);
}

/** Who gets the push of a new action message: request → the approvers only; else everyone (null). */
async function pushUsers(gc, msgId) {
  const r = await store.one(gc, 'SELECT mode, approver_ids FROM action_msgs WHERE msg_id = ?', [msgId]);
  return r && r.mode === 'request' ? parseJson(r.approver_ids, []) : null;
}

// ─── plugin cards (service send_message with `card`) ───────────────────────

function imageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Check `card` of a service call from plugin `caller` → { text, meta, image }. */
function cleanCard(caller, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  if (!['doorbell', 'notice'].includes(v.kind)) throw fail('invalid');
  const title = text(v.title, 80);
  const body = v.text == null || v.text === '' ? null : messages.cleanText(v.text, false);
  if (body && body.length > 500) throw fail('invalid');
  const acts = v.actions == null ? [] : v.actions;
  if (!Array.isArray(acts) || acts.length > CARD_ACTIONS_MAX) throw fail('invalid');
  const actions = [];
  for (const a of acts) {
    let plugin = caller;
    let id = a;
    let label = null;
    if (a && typeof a === 'object') { plugin = a.plugin || caller; id = a.actionId || a.id; label = optText(a.label, 40); }
    if (typeof id === 'string' && id.includes('/')) [plugin, id] = id.split('/', 2);
    if (typeof id !== 'string' || !ID_RE.test(id) || typeof plugin !== 'string' || !PLUGIN_RE.test(plugin) || plugin === SELF) throw fail('invalid');
    actions.push({ plugin, actionId: id, label });
  }
  let link = null;
  if (v.link != null) {
    if (typeof v.link !== 'object' || typeof v.link.route !== 'string' || !ROUTE_RE.test(v.link.route)) throw fail('invalid');
    link = { label: text(v.link.label, 24), route: v.link.route };
  } else if (v.kind === 'doorbell' && caller === 'gatecontrol-door') {
    // the door has no live-view action: a doorbell card gets the button "Live-Bild" → the door plugin's page
    link = { label: null, route: 'plg-gatecontrol-door', kind: 'live_view' };
  }
  let image = null;
  if (v.imageBase64 != null) {
    if (typeof v.imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.imageBase64)) throw fail('invalid');
    const buf = Buffer.from(v.imageBase64, 'base64');
    const mime = imageMime(buf);
    if (!mime || buf.length > CARD_IMAGE_MAX) throw fail('invalid');
    image = { mime, bytes: buf.length, data: buf.toString('base64') };
  }
  return { text: body, meta: { kind: v.kind, title, actions, link }, image };
}

async function createCard(ctx, conv, msgId, card) {
  await store.run(ctx.gc, "INSERT INTO action_msgs (msg_id, conv_id, mode, state, created_at, updated_at) VALUES (?, ?, 'card', 'open', ?, ?)", [msgId, conv.id, ctx.now, ctx.now]);
  if (card.image) await store.run(ctx.gc, 'INSERT INTO card_images (msg_id, mime, bytes, data_enc) VALUES (?, ?, ?, ?)', [msgId, card.image.mime, card.image.bytes, seal.seal(card.image.data)]);
}

/** { mime, bytes } of a card's picture (the picture itself: GET messages/:id/card/image). */
async function cardImageInfo(gc, msgId) {
  const r = await store.one(gc, 'SELECT mime, bytes FROM card_images WHERE msg_id = ?', [msgId]);
  return r ? { mime: r.mime, bytes: r.bytes } : null;
}

const LIVE_LABEL = { de: 'Live-Bild', en: 'Live view' };
function linkOut(ctx, link) {
  if (!link) return null;
  return { label: link.label || LIVE_LABEL[ctx.lang === 'en' ? 'en' : 'de'], route: link.route, kind: link.kind || null };
}

/** 1.6.0: card.notice of a delivered notification → { source, sourceLabel, topic, topicLabel, priority, data } */
function noticeOut(n) {
  return { source: n.source, sourceLabel: n.sourceLabel, topic: n.topic, topicLabel: n.topicLabel || null, priority: n.priority || 'normal', data: n.data || null };
}

async function cardImage(gc, msgId) {
  const r = await store.one(gc, 'SELECT * FROM card_images WHERE msg_id = ?', [msgId]);
  if (!r) return null;
  const data = seal.open(r.data_enc);
  return typeof data === 'string' ? { mime: r.mime, bytes: r.bytes, data } : null;
}

// ─── reading ────────────────────────────────────────────────────────────────

/** The action / card objects of these rows for the viewer → Map msgId → { action } | { card }. */
async function decorate(ctx, rows) {
  const out = new Map();
  const can = available(ctx.gc, ctx.cfg);
  const mine = can && ctx.viewer ? await listFor(ctx.gc, ctx.viewer, ctx.now, { interactive: true }) : [];
  for (const r of rows) {
    const meta = messages.metaOf(r) || {};
    const row = await store.one(ctx.gc, 'SELECT * FROM action_msgs WHERE msg_id = ?', [r.id]);
    if (!row) continue;
    const result = seal.openJson(row.result_enc) || null;
    if (r.kind === 'card' && meta.card) {
      const c = meta.card;
      out.set(r.id, { card: {
        kind: c.kind, title: c.title, text: typeof messages.bodyOf(r) === 'string' ? messages.bodyOf(r) : null, image: await cardImageInfo(ctx.gc, r.id), link: linkOut(ctx, c.link),
        actions: (c.actions || []).map((a) => { const e = findIn(mine, a.plugin, a.actionId); return { plugin: a.plugin, actionId: a.actionId, label: a.label || (e && e.label) || a.actionId, icon: e ? e.icon : null, needsConfirm: !!(e && e.needsConfirm), canRun: can && !!e }; }),
        lastRun: row.by_id ? { by: row.by_id, at: iso(row.updated_at), ok: result ? !!result.ok : null } : null,
        // 1.6.0: a notification of GateControl's notification center (kind 'notice' through deliverNotice, server/notices.js)
        ...(c.notice ? { notice: noticeOut(c.notice), imageUrl: c.notice.imageUrl || null } : {}),
      } });
      continue;
    }
    const a = meta.action;
    if (!a) continue;
    let state = row.state;
    if (state === 'open' && row.mode === 'grant' && row.grant_until != null && row.grant_until <= ctx.now) state = 'expired';
    if (state === 'open' && row.mode === 'request' && requestEnd(row) <= ctx.now) state = 'expired';
    const approvers = parseJson(row.approver_ids, []);
    const open = state === 'open';
    out.set(r.id, { action: {
      mode: row.mode, actionId: row.action_id, plugin: row.plugin, label: a.label, icon: a.icon || null, needsConfirm: !!a.needsConfirm,
      approverIds: row.mode === 'request' ? approvers : undefined, grant: row.mode === 'grant' ? { toUserId: row.grant_to, until: iso(row.grant_until), offAtEnd: row.off_at_end > 0 } : undefined,
      // 1.5.0: a request's end and its approver group ('parents' | 'rights' | 'list'; null before 1.5.0)
      expiresAt: row.mode === 'request' ? iso(requestEnd(row)) : undefined, approvers: row.mode === 'request' ? a.approvers || null : undefined,
      state, result: result ? { ok: !!result.ok, message: result.message || null } : null, by: row.by_id || null, at: row.by_id ? iso(row.updated_at) : null,
      can: {
        run: can && open && ((row.mode === 'run' && !!findIn(mine, row.plugin, row.action_id)) || (row.mode === 'grant' && row.grant_to === ctx.viewer)),
        approve: can && open && row.mode === 'request' && approvers.includes(ctx.viewer),
        deny: can && open && row.mode === 'request' && approvers.includes(ctx.viewer),
      },
    } });
  }
  return out;
}

// ─── running ────────────────────────────────────────────────────────────────

/** Read what a run needs (no writes) → { msg, row, meta, plugin, actionId, executor }. */
async function prepare(ctx, x, idRaw, body, op) {
  if (!available(ctx.gc, ctx.cfg)) throw fail('feature_off');
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  const msg = await messages.visibleMessage(ctx, x.me, id);
  if (msg.deleted_at) throw fail('deleted');
  if (msg.kind !== 'action' && msg.kind !== 'card') throw fail('invalid');
  const row = await store.one(ctx.gc, 'SELECT * FROM action_msgs WHERE msg_id = ?', [id]);
  if (!row) throw fail('invalid');
  const meta = messages.metaOf(msg) || {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (row.mode === 'card') {
    if (op !== 'run') throw fail('invalid');
    const acts = (meta.card && meta.card.actions) || [];
    const want = typeof b.actionId === 'string' ? b.actionId : (acts.length === 1 ? acts[0].actionId : null);
    const a = acts.find((x2) => x2.actionId === want && (!b.plugin || x2.plugin === b.plugin));
    if (!a) throw fail('invalid');
    const e = findIn(await listFor(ctx.gc, ctx.viewer, ctx.now), a.plugin, a.actionId);
    if (!e) throw fail('not_allowed');
    return { msg, row, meta, plugin: a.plugin, actionId: a.actionId, label: a.label || e.label, executor: ctx.viewer };
  }
  const label = meta.action ? meta.action.label : row.action_id;
  if (row.state !== 'open') throw fail('closed');
  if (row.mode === 'grant' && row.grant_until <= ctx.now) throw fail('closed');
  if (row.mode === 'request' && requestEnd(row) <= ctx.now) throw fail('closed');
  if (op === 'run') {
    if (row.mode === 'request') throw fail('not_allowed');
    if (row.mode === 'grant') {
      if (row.grant_to !== ctx.viewer) throw fail('not_allowed');
      return { msg, row, meta, plugin: row.plugin, actionId: row.action_id, label, executor: row.owner_id };
    }
    if (!findIn(await listFor(ctx.gc, ctx.viewer, ctx.now), row.plugin, row.action_id)) throw fail('not_allowed');
    return { msg, row, meta, plugin: row.plugin, actionId: row.action_id, label, executor: ctx.viewer };
  }
  // approve / deny: an approver while it is open — 1.5.0: approving needs the right to run it still
  if (row.mode !== 'request' || !parseJson(row.approver_ids, []).includes(ctx.viewer)) throw fail('not_allowed');
  if (op === 'approve' && !findIn(await listFor(ctx.gc, ctx.viewer, ctx.now), row.plugin, row.action_id)) throw fail('not_allowed');
  return { msg, row, meta, plugin: row.plugin, actionId: row.action_id, label, executor: ctx.viewer };
}

/** Write the outcome (inside a transaction): the row, the system message, the events, a push to the requester. */
async function record(ctx, x, p, op, result) {
  const done = op === 'approve' && result && result.ok;
  const state = op === 'deny' ? 'denied' : (done ? 'done' : p.row.state);
  await store.run(ctx.gc, 'UPDATE action_msgs SET state = ?, by_id = ?, result_enc = ?, updated_at = ? WHERE msg_id = ?',
    [state, ctx.viewer, result ? seal.sealJson({ ok: !!result.ok, message: result.message || null, state: result.state || null }) : null, ctx.now, p.msg.id]);
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, p.msg.id]);
  const ids = x.members.map((m) => m.user_id);
  const label = p.label || p.actionId;
  let sysId = null;
  if (op === 'deny') sysId = await messages.system(ctx, x.conv, 'action_denied', { by: ctx.viewer, messageId: p.msg.id, label, requesterId: p.row.owner_id });
  else if (result && result.ok) sysId = await messages.system(ctx, x.conv, 'action_run', { userId: ctx.viewer, messageId: p.msg.id, label, mode: p.row.mode, asUserId: p.executor !== ctx.viewer ? p.executor : null });
  live.queue(ctx.box, ids, 'action.update', { conversationId: x.conv.id, messageId: p.msg.id, updatedAt: iso(ctx.now) });
  if (sysId) live.queue(ctx.box, ids, 'message.new', { conversationId: x.conv.id, messageId: sysId, senderId: null, clientId: null, kind: 'system', createdAt: iso(ctx.now) });
  if (p.row.mode === 'request' && (op === 'deny' || done) && p.row.owner_id && p.row.owner_id !== ctx.viewer && ctx.users.has(p.row.owner_id)) {
    ctx.box.pushes.push({ custom: { kind: op === 'deny' ? 'action_denied' : 'action_approved', conv: x.conv, members: x.members, users: [p.row.owner_id], senderId: ctx.viewer, messageId: sysId || p.msg.id, params: { label }, respectMute: true } });
  }
  if (result && !result.ok) await log.add(ctx.gc, 'action_failed', String(result.error || 'failed').slice(0, 40), ctx.now);
}

/**
 * Background: open requests past their end (requestTtlMin; 24 h before 1.5.0) and grants past their end → expired.
 * A grant with offAtEnd switches the device off after the commit (switchOff, ctx.box.after).
 */
async function expire(ctx) {
  const rows = await store.all(ctx.gc, "SELECT * FROM action_msgs WHERE state = 'open' AND ((mode = 'grant' AND grant_until <= ?) OR (mode = 'request' AND COALESCE(expires_at, created_at + ?) <= ?)) LIMIT 200",
    [ctx.now, REQUEST_TTL_MS, ctx.now]);
  for (const r of rows) {
    await store.run(ctx.gc, "UPDATE action_msgs SET state = 'expired', updated_at = ? WHERE msg_id = ?", [ctx.now, r.msg_id]);
    await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, r.msg_id]);
    const members = await store.all(ctx.gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [r.conv_id]);
    live.queue(ctx.box, members.map((m) => m.user_id), 'action.update', { conversationId: r.conv_id, messageId: r.msg_id, updatedAt: iso(ctx.now) });
    if (r.mode === 'grant' && r.off_at_end === 1 && ctx.box && Array.isArray(ctx.box.after)) {
      await store.run(ctx.gc, 'UPDATE action_msgs SET off_at_end = 2 WHERE msg_id = ?', [r.msg_id]);
      ctx.box.after.push(() => switchOff(ctx.gc, r, ctx.box));
    }
  }
  return rows.length;
}

/**
 * The end of a grant with offAtEnd (outside any transaction): the action with state 'off' as the granter (an
 * automation), then the system message grant_off { messageId, label, ok, byUserId, toUserId } → the run's result.
 */
async function switchOff(gc, row, box) {
  const config = require('./config');
  const cfg = await config.load(gc);
  if (!available(gc, cfg) || !row.owner_id || !row.plugin || !row.action_id) return null;
  const result = await run(gc, row.owner_id, row.plugin, row.action_id, { interactive: false, state: 'off' });
  const now = Date.now();
  if (!result.ok) await log.add(gc, 'action_failed', String(result.error || 'failed').slice(0, 40), now);
  await store.tx(gc, async () => {
    const c = await store.one(gc, 'SELECT * FROM conversations WHERE id = ?', [row.conv_id]);
    const msg = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [row.msg_id]);
    if (!c || !msg) return;
    const meta = messages.metaOf(msg) || {};
    const label = (meta.action && meta.action.label) || row.action_id;
    await store.run(gc, 'UPDATE action_msgs SET result_enc = ?, updated_at = ? WHERE msg_id = ?', [seal.sealJson({ ok: !!result.ok, message: result.message || null, state: result.state || null }), now, row.msg_id]);
    const ctx = { gc, now, viewer: null, box };
    const sysId = await messages.system(ctx, c, 'grant_off', { messageId: row.msg_id, label, ok: !!result.ok, byUserId: row.owner_id, toUserId: row.grant_to });
    const members = await store.all(gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [c.id]);
    const ids = members.map((m) => m.user_id);
    live.queue(box, ids, 'message.new', { conversationId: c.id, messageId: sysId, senderId: null, clientId: null, kind: 'system', createdAt: iso(now) });
    live.queue(box, ids, 'action.update', { conversationId: c.id, messageId: row.msg_id, updatedAt: iso(now) });
  });
  return result;
}

/**
 * GET actions/requestable → { actions: [{ id, plugin, label, icon, kind, needsConfirm, state, subtitle, pluginName, approverIds, self }],
 * approvers, approversDefault, canRequest, requestTtlMin } — the actions the possible approvers may run (the caller's own
 * included when somebody else may approve them; `self`: the caller may run it too). query.approvers as for a request
 * ('parents' | 'rights' | '2,3'), query.conversationId: only approvers among that chat's members.
 */
async function requestable(ctx, query) {
  if (!available(ctx.gc, ctx.cfg)) throw fail('feature_off');
  const q = query && typeof query === 'object' ? query : {};
  const def = await approversDefault(ctx.gc, ctx.cfg);
  const base = { approversDefault: def, requestTtlMin: ctx.cfg.requestTtlMin || 15 };
  if (!(await mayRequest(ctx))) return { actions: [], approvers: null, canRequest: false, ...base };
  let want;
  if (q.approvers != null && q.approvers !== '') {
    const raw = String(q.approvers);
    if (/^\d{1,15}(,\d{1,15}){0,29}$/.test(raw)) want = raw.split(',').map(Number);
    else want = raw;
  }
  const group = await approverGroup(ctx, want);
  const kiosk = new Set((await store.all(ctx.gc, 'SELECT user_id FROM prefs WHERE kiosk = 1')).map((r) => r.user_id));
  let pool = (group.ids == null ? [...ctx.users.keys()] : group.ids).filter((u) => u !== ctx.viewer && ctx.users.has(u) && !kiosk.has(u));
  if (q.conversationId != null && q.conversationId !== '') {
    const x = await require('./conversations').access(ctx, q.conversationId);
    const ids = x.members.map((m) => m.user_id);
    pool = pool.filter((u) => ids.includes(u));
  }
  const mine = await listFor(ctx.gc, ctx.viewer, ctx.now);
  const out = new Map();
  for (const u of pool.slice(0, APPROVER_CHECK_MAX)) {
    for (const a of await listFor(ctx.gc, u, ctx.now)) {
      const key = `${a.plugin}/${a.id}`;
      if (!out.has(key)) out.set(key, { ...a, approverIds: [], self: !!findIn(mine, a.plugin, a.id) });
      out.get(key).approverIds.push(u);
    }
  }
  return { actions: [...out.values()], approvers: group.mode, canRequest: true, ...base };
}

/**
 * What GET me says about home actions (1.5.0) → { available, reason, approversDefault, childrenMayRequest, familyRoles,
 * canRequest, doorbell: { lastCardAt } | null }. reason: null | 'off' (the administrator's switch) | 'host' (no gc.actions).
 */
async function info(ctx) {
  const gc = ctx.gc;
  const host = !!(gc && gc.actions && typeof gc.actions.list === 'function' && typeof gc.actions.run === 'function');
  const can = available(gc, ctx.cfg);
  const familyRoles = await familie.available(gc, 'family_roles');
  const last = ctx.viewer ? await store.one(gc, `SELECT MAX(m.created_at) AS at FROM messages m JOIN members x ON x.conv_id = m.conv_id AND x.user_id = ? AND x.left_at IS NULL
    WHERE m.kind = 'card' AND m.via = 'gatecontrol-door' AND m.deleted_at IS NULL AND m.id > x.joined_msg_id`, [ctx.viewer]) : null;
  return {
    available: can, reason: can ? null : (host ? 'off' : 'host'),
    approversDefault: await approversDefault(gc, ctx.cfg), childrenMayRequest: ctx.cfg.childrenMayRequest !== false, familyRoles,
    canRequest: can && await mayRequest(ctx),
    doorbell: last && last.at != null ? { lastCardAt: iso(last.at) } : null,
  };
}

/** After an arrival: the sender's onArrive action, as the sender (outside any transaction). */
async function runAfterArrival(gc, userId, conv, onArrive, msgId) {
  const config = require('./config');
  const cfg = await config.load(gc);
  if (!available(gc, cfg)) return null;
  const now = Date.now();
  const entry = findIn(await listFor(gc, userId, now, { interactive: false }), onArrive.plugin, onArrive.actionId);
  if (!entry) return null;
  const result = await run(gc, userId, entry.plugin, entry.id, { interactive: false });
  if (!result.ok) { await log.add(gc, 'action_failed', String(result.error || 'failed').slice(0, 40), now); return result; }
  const box = live.outbox();
  await store.tx(gc, async () => {
    const c = await store.one(gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
    if (!c) return;
    const ctx = { gc, now, viewer: userId, box };
    const sysId = await messages.system(ctx, c, 'action_run', { userId, messageId: msgId, label: entry.label, mode: 'arrival', asUserId: null });
    const members = await store.all(gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [c.id]);
    live.queue(box, members.map((m) => m.user_id), 'message.new', { conversationId: c.id, messageId: sysId, senderId: null, clientId: null, kind: 'system', createdAt: iso(now) });
  });
  await live.flush(gc, box);
  return result;
}

async function cleanup(gc, ids) {
  for (const id of ids) {
    await store.run(gc, 'DELETE FROM action_msgs WHERE msg_id = ?', [id]);
    await store.run(gc, 'DELETE FROM card_images WHERE msg_id = ?', [id]);
  }
}

module.exports = {
  available, listFor, run, clean, create, pushUsers, cleanCard, createCard, cardImage, decorate, prepare, record, expire, runAfterArrival, cleanup, reset, findIn,
  requestable, info, switchOff, approversDefault, requestEnd,
  REQUEST_TTL_MS, GRANT_MAX_MS, CARD_IMAGE_MAX, SELF,
};
