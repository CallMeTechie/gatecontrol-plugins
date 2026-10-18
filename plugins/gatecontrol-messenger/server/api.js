'use strict';

// The chat API of the apps (/api/v1/client/plugins/gatecontrol-messenger/api/…) and
// the portal frame (/api/v1/portal/plugins/gatecontrol-messenger/api/…). The full
// contract (bodies, answers, codes, events, pushes) is in the plugin's README
// ("App-API"). Writes run in one transaction; events and pushes go out after
// the commit.

const store = require('./store');
const config = require('./config');
const people = require('./people');
const live = require('./live');
const conversations = require('./conversations');
const messages = require('./messages');
const push = require('./push');
const { fail, posInt, iso } = require('./util');

/** GET me */
async function me(ctx) {
  const prefs = people.prefsOut(await people.prefsRow(ctx.gc, ctx.viewer, ctx.now));
  let usage = null;
  try { usage = await ctx.gc.media.usage(); } catch { usage = null; }
  let lic = null;
  try { lic = await ctx.gc.license.status(); } catch { lic = null; }
  const cfg = ctx.cfg;
  const u = ctx.users.get(ctx.viewer);
  return {
    user: u ? { id: u.id, name: u.name, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null } : { id: ctx.viewer, name: null, avatarUrl: null, initials: null, colorHex: null },
    prefs,
    license: lic ? { licensed: lic.licensed !== false, state: lic.state || null, expiresAt: lic.expiresAt || null } : null,
    features: {
      direct: true, groups: true, voice: true, files: true, location: true, reactions: true, edit: cfg.editWindowMin > 0, search: true,
      disappearing: cfg.allowDisappearing, bridges: false, e2e: false,
    },
    limits: {
      maxBytes: usage ? usage.maxBytes : null,
      types: usage ? usage.types : [],
      quotaFull: usage ? usage.bytes >= usage.quota : false,
      editWindowS: cfg.editWindowMin * 60,
      maxVoiceS: cfg.maxVoiceS,
      textMax: messages.TEXT_MAX,
      thumbMaxBytes: messages.THUMB_MAX,
      imageMaxSide: 2048,
      groupMax: conversations.GROUP_MAX,
      titleMax: conversations.TITLE_MAX,
      pageMax: messages.PAGE_MAX,
      typingS: live.TYPING_MS / 1000,
      typingEveryS: live.TYPING_EVERY_MS / 1000,
      activeS: live.ACTIVE_MS / 1000,
      disappearingS: config.DISAPPEARING_S,
      retentionDays: cfg.retentionDays,
    },
    serverTime: iso(ctx.now),
  };
}

const json = (status, body) => ({ status, json: { ok: true, ...body } });

/** The conversation as the viewer sees it after a change (re-read inside the same request). */
async function convOut(ctx, convId) {
  const a = await conversations.access(ctx, convId);
  return conversations.view(ctx, a.conv, a.me, a.members);
}

async function route(ctx, req, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const gc = ctx.gc;
  const [a, b, c] = seg;
  const tx = (fn) => store.tx(gc, fn);

  if (a === 'me' && seg.length === 1 && m === 'GET') return json(200, await me(ctx));
  if (a === 'prefs' && seg.length === 1 && (m === 'PUT' || m === 'PATCH')) {
    return json(200, { prefs: await tx(() => people.updatePrefs(gc, ctx.viewer, req.body, ctx.now)) });
  }
  if (a === 'people' && seg.length === 1 && m === 'GET') return json(200, { people: await people.list(gc, ctx.viewer) });

  if (a === 'conversations') {
    if (seg.length === 1 && m === 'GET') {
      const out = await tx(() => conversations.list(ctx, req.query));
      return json(200, out);
    }
    if (seg.length === 1 && m === 'POST') {
      const out = await tx(async () => {
        const r = await conversations.create(ctx, req.body);
        return { conversation: await convOut(ctx, r.conv.id), created: r.created };
      });
      return json(200, out);
    }
    if (seg.length >= 2) {
      if (seg.length === 2 && m === 'GET') {
        const x = await conversations.access(ctx, b);
        return json(200, { conversation: await conversations.view(ctx, x.conv, x.me, x.members) });
      }
      if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) {
        const out = await tx(async () => {
          const x = await conversations.access(ctx, b);
          const conv = await conversations.patch(ctx, x.conv, x.me, x.members, req.body);
          const still = await conversations.isMember(gc, conv.id, ctx.viewer);
          return { conversation: still ? await convOut(ctx, conv.id) : null, left: !still };
        });
        return json(200, out);
      }
      if (seg.length === 3 && c === 'messages' && m === 'GET') {
        const out = await tx(async () => {
          const x = await conversations.access(ctx, b);
          const rc = await conversations.receipts(ctx, x.conv, x.members);
          const p = await messages.page(ctx, x.me, req.query, rc);
          const top = p.messages.reduce((mx, msg) => Math.max(mx, msg.id), 0);
          if (top) await messages.markDelivered(ctx, x.conv, x.me, x.members, top);
          return { ...p, readUpTo: rc.readUpTo, deliveredUpTo: rc.deliveredUpTo, receipts: rc.receipts, serverTime: iso(ctx.now) };
        });
        return json(200, out);
      }
      if (seg.length === 3 && c === 'messages' && m === 'POST') {
        let job = null;
        const out = await tx(async () => {
          const x = await conversations.access(ctx, b);
          const before = x.conv.last_msg_id || 0;
          const r = await messages.send(ctx, x.conv, x.me, x.members, req.body);
          if (!r.duplicate) {
            messages.queueNew(ctx, x.conv, x.members, r.row);
            // sending reads everything before it: tell the others (and one's own devices) when that moved the mark
            if (x.me.last_read_id < before) await messages.queueRead(ctx, x.conv, x.members, { ...x.me, last_read_id: r.row.id, last_delivered_id: r.row.id });
            job = { conv: x.conv, members: x.members, row: r.row, text: r.text, meta: r.meta, title: conversations.titleOf(x.conv) };
          }
          const rc = await conversations.receipts(ctx, x.conv, await conversations.membersOf(gc, x.conv.id));
          const me2 = await store.one(gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ?', [x.conv.id, ctx.viewer]);
          return { message: (await messages.views(ctx, me2, [r.row], rc))[0], duplicate: r.duplicate };
        });
        if (job) ctx.box.pushes.push(job);
        return json(200, out);
      }
      if (seg.length === 3 && c === 'read' && m === 'POST') {
        return json(200, await tx(async () => {
          const x = await conversations.access(ctx, b);
          return messages.markRead(ctx, x.conv, x.me, x.members, req.body);
        }));
      }
      if (seg.length === 3 && c === 'typing' && m === 'POST') {
        const x = await conversations.access(ctx, b);
        return json(200, await conversations.typing(ctx, x.conv, x.me, x.members, req.body));
      }
      if (seg.length === 3 && c === 'active' && m === 'POST') {
        const x = await conversations.access(ctx, b);
        return json(200, conversations.active(ctx, x.conv, req.body));
      }
      if (seg.length === 3 && c === 'search' && m === 'GET') {
        const x = await conversations.access(ctx, b);
        const rc = await conversations.receipts(ctx, x.conv, x.members);
        return json(200, await messages.search(ctx, x.me, req.query && req.query.q, rc));
      }
      if (seg.length === 3 && c === 'media' && m === 'GET') {
        const x = await conversations.access(ctx, b);
        const rc = await conversations.receipts(ctx, x.conv, x.members);
        return json(200, await messages.mediaList(ctx, x.me, req.query, rc));
      }
    }
  }

  if (a === 'messages' && seg.length >= 2) {
    const id = posInt(b);
    if (!id) throw fail('not_found');
    // the message's conversation, then the same membership check as every other route
    const locate = async () => {
      const row = await store.one(gc, 'SELECT conv_id FROM messages WHERE id = ?', [id]);
      if (!row) throw fail('not_found');
      return conversations.access(ctx, row.conv_id);
    };
    const out = async (x) => {
      const rc = await conversations.receipts(ctx, x.conv, x.members);
      const row = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [id]);
      return row ? (await messages.views(ctx, x.me, [row], rc))[0] : null;
    };
    if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) {
      return json(200, await tx(async () => {
        const x = await locate();
        await messages.edit(ctx, x.conv, x.me, x.members, id, req.body);
        return { message: await out(x) };
      }));
    }
    if (seg.length === 2 && m === 'DELETE') {
      const scope = req.query && req.query.for != null ? String(req.query.for) : 'me';
      if (scope !== 'me' && scope !== 'all') throw fail('invalid');
      return json(200, await tx(async () => {
        const x = await locate();
        const r = await messages.remove(ctx, x.conv, x.me, x.members, id, scope);
        return { forAll: r.forAll, message: r.forAll ? await out(x) : null };
      }));
    }
    if (seg.length === 3 && c === 'reaction' && (m === 'PUT' || m === 'POST')) {
      return json(200, await tx(async () => {
        const x = await locate();
        return { reactions: await messages.react(ctx, x.conv, x.me, x.members, id, req.body) };
      }));
    }
  }
  throw fail('not_found');
}

/** After the commit: events, then the pushes of new messages. */
async function flush(ctx) {
  await live.flush(ctx.gc, ctx.box);
  const jobs = ctx.box.pushes;
  ctx.box.pushes = [];
  for (const j of jobs) await push.send(ctx.gc, j, ctx.users, ctx.now);
}

module.exports = { route, flush, me };
