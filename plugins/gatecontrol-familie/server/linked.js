'use strict';

// 1.23.0 — „Andere Messenger“: parents allow a child to link its own account at another messenger (WhatsApp first)
// with the bridges of the Messenger plugin (gatecontrol-messenger ≥ 1.13.0 on a GateControl that offers bridges — a
// preview there). Children are locked until a parent says yes, per child and service. Familie only carries the
// switches: who is allowed and what is linked lives in the Messenger, reached through GateControl's services between
// plugins (permissions.services) — no table here, no access to the Messenger's data.
//
//   GET messengers             → { messengers: { available, manage, networks: ['whatsapp'], newChat, children: [child] } } —
//                                parents: every child of the family; everybody else: available false
//   PUT messengers/<childId>   { networks?: { whatsapp: boolean }, newChat?: { whatsapp: boolean } }
//                                → { child, unlinked: { whatsapp?: boolean } }
//   child = { userId, name, avatarUrl, color, colorHex, initials, networks: { whatsapp: boolean },
//             linked: { whatsapp: boolean }, newChat: { whatsapp: boolean } } — `linked`: the child has an account
//             linked right now (never which)
//
// 1.25.0: „Neue Chats per Nummer“ — a second switch per child and service (newChat): may the child start NEW chats by
// phone number (Messenger ≥ 1.16.0 on a GateControl that can look numbers up: its answer carries newChat: true)? Off
// by default, only next to the permission itself; answers in existing chats stay. An older Messenger knows nothing of
// it: the switch is not shown (messengers.newChat false) and a change is refused (unavailable).
//
// Taking a permission back also ends the child's link: the Messenger asks GateControl, which does it only while the
// parent's request (this one) is in flight and writes it to its activity log. `unlinked[network]`: true = ended,
// false = it could not be ended (an older GateControl, or the bridge did not answer) — the page says so.
//
// The Messenger's services: bridge_children {} / bridge_child_set { childId, networks }, both with `userId` = the
// parent; it checks parent and child against Familie's family_roles itself. Without them (no Messenger, an older one,
// no bridge switched on) the card stays hidden. Budget: service calls are counted per hour (60 for Familie in all) —
// the list is kept for five minutes per parent and asked again after a change.

const members = require('./members');
const { fail } = require('./util');

const PLUGIN = 'gatecontrol-messenger';
const KEEP_MS = 5 * 60000;
// 1.28.0: Signal next to WhatsApp (Messenger ≥ 1.23.0 on a GateControl with Signal) — a column only for a service the
// Messenger offers (bridge_children.networks)
// 1.29.0: Telegram (Messenger ≥ 1.24.0) with its second switch „Telegram-Kanäle“ (channels — default off, only next to
// the permission itself; bridge_children.channels names the services that have it)
const NETWORKS = ['whatsapp', 'signal', 'telegram'];
const cache = new Map(); // parent id → { at, value }

async function offered(gc, service) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  try { return (await gc.services.available(PLUGIN, service)) === true; } catch { return false; }
}

const NONE = Object.freeze({ available: false, networks: [], newChat: false, children: [] });

/** The Messenger's answer, reduced to what is known here. */
function clean(x) {
  if (!x || x.ok === false || x.available !== true || !Array.isArray(x.networks) || !Array.isArray(x.children)) return NONE;
  const networks = x.networks.filter((n) => NETWORKS.includes(n));
  if (!networks.length) return NONE;
  const channels = Array.isArray(x.channels) ? x.channels.filter((n) => networks.includes(n)) : [];
  return { available: true, networks, newChat: x.newChat === true, ...(channels.length ? { channels } : {}), children: x.children.filter((c) => c && Number.isSafeInteger(c.userId)).map((c) => childOf(c, networks, channels)) };
}

function childOf(c, networks, channels = []) {
  const flags = (o, list = networks) => Object.fromEntries(list.map((n) => [n, !!(o && o[n] === true)]));
  return { userId: c.userId, networks: flags(c.networks), linked: flags(c.linked), newChat: flags(c.newChat), ...(channels.length ? { channels: flags(c.channels, channels) } : {}) };
}

async function ask(gc, parentId, now) {
  const hit = cache.get(parentId);
  if (hit && now - hit.at < KEEP_MS) return hit.value;
  if (!(await offered(gc, 'bridge_children'))) return NONE;
  let value = NONE;
  try { value = clean(await gc.services.call({ plugin: PLUGIN, service: 'bridge_children', userId: parentId, payload: {} })); }
  catch (e) { gc.log.warn('messenger bridges not read', (e && e.code) || 'error'); return NONE; }
  cache.set(parentId, { at: now, value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

/** A child of the Messenger's answer as the card shows it — only members of this family. */
function face(fam, c) {
  const m = fam.byId.get(c.userId);
  if (!m || m.role !== 'child') return null;
  return { userId: m.userId, name: m.name, ...members.faceOf(m), networks: c.networks, linked: c.linked, newChat: c.newChat, ...(c.channels ? { channels: c.channels } : {}) };
}

/** GET messengers */
async function view(gc, r) {
  const manage = r.me.role === 'parent';
  if (!manage) return { messengers: { available: false, manage, networks: [], newChat: false, children: [] } };
  const v = await ask(gc, r.me.userId, r.now);
  const children = v.children.map((c) => face(r.fam, c)).filter(Boolean);
  return { messengers: { available: v.available && children.length > 0, manage, networks: v.networks, newChat: v.newChat === true, ...(v.channels && v.channels.length ? { channels: v.channels } : {}), children } };
}

/** PUT messengers/<childId> */
async function set(gc, r, childId, body) {
  if (r.me.role !== 'parent') throw fail('parents_only');
  const id = Number(childId);
  const m = Number.isSafeInteger(id) ? r.fam.byId.get(id) : null;
  if (!m || m.role !== 'child') throw fail('not_found');
  const flags = (o) => {
    if (o === undefined) return null;
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.keys(o).length) throw fail('invalid');
    for (const [k, v] of Object.entries(o)) if (!NETWORKS.includes(k) || typeof v !== 'boolean') throw fail('invalid');
    return o;
  };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const nets = flags(b.networks);
  // 1.25.0: new chats by number — only with a Messenger that says it knows them
  const newChat = flags(b.newChat);
  // 1.29.0: „Telegram-Kanäle“ — only with a Messenger that names the switch
  const channels = flags(b.channels);
  if (!nets && !newChat && !channels) throw fail('invalid');
  if (!(await offered(gc, 'bridge_child_set'))) throw fail('unavailable');
  if (newChat && !(await ask(gc, r.me.userId, r.now)).newChat) throw fail('unavailable');
  if (channels) {
    const have = (await ask(gc, r.me.userId, r.now)).channels || [];
    if (Object.keys(channels).some((k) => !have.includes(k))) throw fail('unavailable');
  }
  cache.delete(r.me.userId);
  const payload = { childId: id, ...(nets ? { networks: nets } : {}), ...(newChat ? { newChat } : {}), ...(channels ? { channels } : {}) };
  let x;
  try { x = await gc.services.call({ plugin: PLUGIN, service: 'bridge_child_set', userId: r.me.userId, payload }); }
  catch (e) { gc.log.warn('messenger bridges not changed', (e && e.code) || 'error'); throw fail('unavailable'); }
  if (!x || x.ok === false || !x.child) {
    const code = x && typeof x.code === 'string' ? x.code : '';
    throw fail(code === 'forbidden' ? 'parents_only' : (code === 'not_found' || code === 'invalid' ? code : 'unavailable'));
  }
  const networks = Object.keys(nets || {});
  // the services the Messenger named for this child (an older Messenger: WhatsApp only)
  const has = (o, n) => !!(o && Object.prototype.hasOwnProperty.call(o, n));
  const child = face(r.fam, childOf(x.child, NETWORKS.filter((n) => n === 'whatsapp' || has(x.child && x.child.networks, n)), NETWORKS.filter((n) => has(x.child && x.child.channels, n))));
  const unlinked = {};
  for (const n of networks) if (x.unlinked && typeof x.unlinked[n] === 'boolean') unlinked[n] = x.unlinked[n];
  return { child, unlinked };
}

function _reset() { cache.clear(); }

module.exports = { view, set, NETWORKS, _reset };
