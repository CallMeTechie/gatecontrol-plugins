'use strict';

// 1.6.0 — the chat sink of GateControl's notification center (GateControl ≥ 1.191.0, plugin.json
// permissions.notifySink; README "Mitteilungen im Chat"). Per push topic people choose where a notification
// appears: GateControl's inbox (the pinned row "GateControl" — the core keeps those), the family chat (a
// household setting: administrators and Familie's parents only) or an own chat per source. The core hands the
// notifications for the last two to the hook deliverNotice(payload):
//
//   { id, topic, source: 'core' | 'plugin:<id>', sourceLabel, topicLabel, title, body, priority, createdAt, data,
//     imageUrl?, card?: { text ≤ 4000, link?: { label ≤ 40, route }, actions? }, family: [ids], own: [ids], lang }
//
//   family → ONE card in Familie's group (managed_by gatecontrol-familie, key 'family'); covered = the ids of
//            `family` who are members of that group. No such group → none of them is covered.
//   own    → per person a read-only notice channel per source (managed_by gatecontrol-messenger, managed_key
//            'notice:<source>:<user id>', title = sourceLabel, created on first use); one card there.
//   → { covered: [ids] }. Whoever is not covered gets the notification in GateControl's inbox instead (the core
//   does that on an error, after 10 s and for every id left out) — so a step that fails leaves its people out
//   instead of throwing. The same notification id never lands twice in one conversation (table notices).
//
// The card: message kind 'card' (senderId null, via gatecontrol-messenger), meta.card.kind 'notice', title, text =
// card.text or body (≤ 4000), link = card.link (else the first open_app_route button), actions = the quick_action
// buttons (card.actions, else data.actions; ≤ 4, run as the person pressing like every plugin card), and
// card.notice { source, sourceLabel, topic, topicLabel, priority, data, imageUrl } for the apps (head
// "<sourceLabel> · <topicLabel>", the push picture, the data a push of that topic would carry). Pushed like any chat
// message (a muted chat stays silent, dnd, the chat open → no push); in the family group only to the people of
// `family`; the push title is the source ("Schule"), high / critical notifications as high.
//
// mayRouteToFamily(user) → may this person set the family chat as a household target? Administrators (the core
// asks only for the others) and Familie's parents (service family_roles, cached 10 min; Familie missing → no).

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const conversations = require('./conversations');
const messages = require('./messages');
const homeactions = require('./homeactions');
const familie = require('./familie');
const { isKnown, line, multiline } = require('./util');

const SELF = 'gatecontrol-messenger';
const FAMILIE = 'gatecontrol-familie';
const SOURCE_RE = /^(?:core|plugin:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TOPIC_RE = /^[A-Za-z0-9:._-]{1,160}$/;
const NOTICE_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const ACTION_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const PLUGIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROUTE_RE = /^(?:vpn|services|gateways|inbox|plg-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
// the push picture of the notification (GateControl's notify_media capability path)
const IMAGE_URL_RE = /^\/notify-media\/[A-Za-z0-9_-]{22,}\.(?:png|jpg|webp)$/;
const PRIORITIES = ['info', 'normal', 'high', 'critical'];
const IDS_MAX = 500;
const ACTIONS_MAX = 4;
const LINK_LABEL_MAX = 40;
const TITLE_MAX = 120;
const DATA_MAX = 2048;
const KEEP_MS = 7 * 86400000;
const OPEN = { de: 'Öffnen', en: 'Open' };

/** A single-line text cut to max (with …), or null. */
function cut(v, max) {
  const s = line(v);
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Positive user ids, each once, at most IDS_MAX. */
function ids(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, IDS_MAX);
}

function linkOf(v, lang) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.route !== 'string' || !ROUTE_RE.test(v.route)) return null;
  return { label: cut(v.label, LINK_LABEL_MAX) || OPEN[lang === 'en' ? 'en' : 'de'], route: v.route };
}

/** The source of a notice channel's key 'notice:<source>:<user id>' (null for other conversations). */
function sourceOfKey(conv) {
  if (!conv || conv.managed_by !== SELF || typeof conv.managed_key !== 'string') return null;
  const m = /^notice:(.+):\d{1,15}$/.exec(conv.managed_key);
  return m && SOURCE_RE.test(m[1]) ? m[1] : null;
}

/**
 * The payload of the core, checked → { id, source, sourceLabel, topic, topicLabel, title, text, priority, meta,
 * family, own } or null when it cannot be delivered at all (no id, source or topic).
 */
function clean(p, lang) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const id = p.id == null ? null : String(p.id);
  if (!id || !NOTICE_ID_RE.test(id)) return null;
  const source = typeof p.source === 'string' && SOURCE_RE.test(p.source) ? p.source : null;
  const topic = typeof p.topic === 'string' && TOPIC_RE.test(p.topic) ? p.topic : null;
  if (!source || !topic) return null;
  const plugin = source === 'core' ? null : source.slice('plugin:'.length);
  const sourceLabel = cut(p.sourceLabel, conversations.TITLE_MAX) || (plugin || 'GateControl');
  const topicLabel = cut(p.topicLabel, 80);
  const c = p.card && typeof p.card === 'object' && !Array.isArray(p.card) ? p.card : {};
  let text = multiline(typeof c.text === 'string' && c.text.trim() ? c.text : p.body) || null;
  if (text && text.length > messages.TEXT_MAX) text = text.slice(0, messages.TEXT_MAX - 1) + '…';
  const title = cut(p.title, TITLE_MAX) || topicLabel || sourceLabel;
  const data = p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? p.data : null;
  let link = linkOf(c.link, lang);
  const buttons = Array.isArray(c.actions) ? c.actions : (data && Array.isArray(data.actions) ? data.actions : []);
  const actions = [];
  for (const a of buttons.slice(0, 8)) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'quick_action' && actions.length < ACTIONS_MAX && typeof a.plugin === 'string' && PLUGIN_RE.test(a.plugin) && a.plugin !== SELF
      && typeof a.id === 'string' && ACTION_ID_RE.test(a.id) && !actions.some((x) => x.plugin === a.plugin && x.actionId === a.id)) {
      actions.push({ plugin: a.plugin, actionId: a.id, label: cut(a.label, LINK_LABEL_MAX) });
    } else if (a.type === 'open_app_route' && !link) link = linkOf({ label: a.label, route: a.target }, lang);
  }
  // what a push of this topic carries (route, the plugin's own keys) — without the buttons, ≤ 2 KB
  let extra = null;
  if (data) {
    const rest = { ...data };
    delete rest.actions;
    const s = JSON.stringify(rest);
    if (s !== '{}' && Buffer.byteLength(s, 'utf8') <= DATA_MAX) extra = rest;
  }
  const priority = PRIORITIES.includes(p.priority) ? p.priority : 'normal';
  const imageUrl = typeof p.imageUrl === 'string' && IMAGE_URL_RE.test(p.imageUrl) ? p.imageUrl : null;
  const family = ids(p.family);
  const own = ids(p.own).filter((u) => !family.includes(u));
  return {
    id, source, sourceLabel, topic, topicLabel, title, text, priority, family, own,
    meta: { kind: 'notice', title, actions, link, notice: { source, sourceLabel, topic, topicLabel, priority, data: extra, imageUrl } },
  };
}

async function managed(gc, by, key) {
  return store.one(gc, 'SELECT * FROM conversations WHERE managed_by = ? AND managed_key = ?', [by, key]);
}

/** The person's notice channel of this source (created on first use; title = the source's name). */
async function channel(ctx, uid, n) {
  const key = `notice:${n.source}:${uid}`;
  let conv = await managed(ctx.gc, SELF, key);
  if (!conv) {
    const r = await store.run(ctx.gc, "INSERT INTO conversations (kind, title_enc, managed_by, managed_key, readonly, created_at, updated_at) VALUES ('group', ?, ?, ?, 1, ?, ?)",
      [seal.seal(n.sourceLabel), SELF, key, ctx.now, ctx.now]);
    conv = await conversations.getConv(ctx.gc, r.lastInsertRowid);
    await conversations.addMember(ctx.gc, conv, uid, 'member', ctx.now);
    live.queue(ctx.box, [uid], 'conversation.update', { conversationId: conv.id, reason: 'created' });
    return conv;
  }
  if (conversations.titleOf(conv) !== n.sourceLabel) {
    await store.run(ctx.gc, 'UPDATE conversations SET title_enc = ?, updated_at = ? WHERE id = ?', [seal.seal(n.sourceLabel), ctx.now, conv.id]);
    conv.title_enc = seal.seal(n.sourceLabel);
  }
  if (!await conversations.isMember(ctx.gc, conv.id, uid)) await conversations.addMember(ctx.gc, conv, uid, 'member', ctx.now);
  return conv;
}

/** One card into one conversation (inside a transaction) → the ids it reached; a repeated notification id: the first answer. */
async function post(ctx, conv, n, users) {
  const done = await store.one(ctx.gc, 'SELECT users FROM notices WHERE notice_id = ? AND conv_id = ?', [n.id, conv.id]);
  if (done) {
    let list;
    try { list = JSON.parse(done.users); } catch { list = []; }
    return Array.isArray(list) ? list.filter((u) => users.includes(u)) : [];
  }
  const meta = { card: n.meta };
  const id = await messages.insert(ctx, conv, { senderId: null, kind: 'card', text: n.text, meta, via: SELF });
  await homeactions.createCard(ctx, conv, id, { image: null });
  await store.run(ctx.gc, 'INSERT INTO notices (notice_id, conv_id, msg_id, users, at) VALUES (?, ?, ?, ?, ?)', [n.id, conv.id, id, JSON.stringify(users), ctx.now]);
  const members = await conversations.membersOf(ctx.gc, conv.id);
  const row = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
  messages.queueNew(ctx, conv, members, row);
  ctx.box.pushes.push({ conv, members, row, text: n.text, meta, title: conversations.titleOf(conv), only: users });
  return users;
}

/** The hook deliverNotice: payload → the covered user ids. Events and pushes wait in ctx.box (flushed by the caller). */
async function deliver(ctx, payload) {
  const n = clean(payload, ctx.lang);
  if (!n) {
    await log.add(ctx.gc, 'notice_failed', 'invalid', ctx.now);
    return [];
  }
  const covered = [];
  // each target in its own transaction: a failed one is left to GateControl's inbox, the others are delivered
  const step = async (fn) => {
    const ev = ctx.box.events.length;
    const pu = ctx.box.pushes.length;
    try {
      return await store.tx(ctx.gc, fn);
    } catch (e) {
      ctx.box.events.length = ev;
      ctx.box.pushes.length = pu;
      if (!isKnown(e)) ctx.gc.log.warn('notice delivery failed', (e && (e.code || e.message)) || 'error');
      await log.add(ctx.gc, 'notice_failed', isKnown(e) ? e.code : 'error', ctx.now);
      return [];
    }
  };
  if (n.family.length) {
    covered.push(...await step(async () => {
      const conv = await managed(ctx.gc, FAMILIE, 'family');
      if (!conv) return [];
      const members = await conversations.membersOf(ctx.gc, conv.id);
      const reach = n.family.filter((u) => ctx.users.has(u) && members.some((m) => m.user_id === u));
      return reach.length ? post(ctx, conv, n, reach) : [];
    }));
  }
  for (const uid of n.own) {
    if (!ctx.users.has(uid)) continue;
    covered.push(...await step(async () => post(ctx, await channel(ctx, uid, n), n, [uid])));
  }
  return [...new Set(covered)];
}

/** The hook mayRouteToFamily: an administrator, or a parent in Familie (family_roles). */
async function mayRouteToFamily(gc, user, now = Date.now()) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.kiosk === true) return false;
  if (user.role === 'admin') return true;
  const roles = await familie.roles(gc, now);
  return !!(roles && roles.parents.includes(user.id));
}

/** Background (hourly): the idempotency rows after 7 days. */
async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM notices WHERE at < ?', [now - KEEP_MS]);
}

module.exports = { deliver, mayRouteToFamily, clean, purge, sourceOfKey, SELF, FAMILIE, KEEP_MS };
