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
const social = require('./social');
const homeactions = require('./homeactions');
const familie = require('./familie');
const status = require('./status');
const bridgechats = require('./bridgechats');
const bridgemedia = require('./bridgemedia');
const persons = require('./persons');
const avatarvis = require('./avatarvis');
const { route14 } = require('./api14');
const { fail, posInt, iso } = require('./util');

/**
 * 1.22.0: where GateControl keeps „Wer sieht dein Bild?“ in the profile (avatarvis.js), prefs.privacy.avatar mirrors it
 * for older apps (all | family | nobody — contacts shows as family, self as nobody) and privacy.avatarProfile carries
 * the real level. `level`: the level just set, else the one of the viewer's gc.users entry.
 */
function profileAvatar(ctx, prefs, level = null) {
  if (!avatarvis.inProfile(ctx.gc)) return prefs;
  const l = level || avatarvis.levelOf(ctx.users.get(ctx.viewer)) || 'all';
  return { ...prefs, privacy: { ...prefs.privacy, avatar: avatarvis.toOld(l), avatarProfile: l } };
}

/** GET me */
async function me(ctx) {
  const prefs = profileAvatar(ctx, people.prefsOut(await people.prefsRow(ctx.gc, ctx.viewer, ctx.now)));
  let usage = null;
  try { usage = await ctx.gc.media.usage(); } catch { usage = null; }
  let lic = null;
  try { lic = await ctx.gc.license.status(); } catch { lic = null; }
  const cfg = ctx.cfg;
  const u = ctx.users.get(ctx.viewer);
  let linked = false;
  try { linked = (await require('./bridges').offered(ctx.gc)).length > 0; } catch { linked = false; }
  // 1.14.0: this person has chats over a bridge. Only then — an app that does not know the word shows "a newer
  // version supports all chat features", and that is true exactly for these people
  let bridgeChats = false;
  try { bridgeChats = !!bridgechats.api(ctx.gc) && await bridgechats.hasChats(ctx.gc, ctx.viewer); } catch { bridgeChats = false; }
  let newChat = false;
  try { newChat = await require('./bridges').newChatFeature(ctx); } catch { newChat = false; }
  let history = false;
  try { history = await require('./bridges').historyFeature(ctx); } catch { history = false; }
  let contacts = false;
  try { contacts = await require('./contactchat').feature(ctx); } catch { contacts = false; }
  // 1.20.0: channels, read-only groups, format, link previews, reactions in channels (GateControl with gc.bridges version 7)
  let channels = false;
  try { channels = bridgeChats && !!require('./bridgechannels').api(ctx.gc); } catch { channels = false; }
  return {
    user: u ? { id: u.id, name: u.name, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null } : { id: ctx.viewer, name: null, avatarUrl: null, initials: null, colorHex: null },
    prefs,
    // 1.22.0: „Profilbild“ in the privacy settings is the profile's „Wer sieht dein Bild?“ (the apps open the profile)
    ...(avatarvis.inProfile(ctx.gc) ? { avatarInProfile: true } : {}),
    license: lic ? { licensed: lic.licensed !== false, state: lic.state || null, expiresAt: lic.expiresAt || null } : null,
    features: {
      direct: true, groups: true, voice: true, files: true, location: true, reactions: true, edit: cfg.editWindowMin > 0, search: true,
      disappearing: cfg.allowDisappearing, bridges: false, e2e: false,
      // 1.3.0: video_meta, file_thumbs — file messages take `video` { durationMs, width, height } and `thumbMediaId`;
      // flags in this object (it predates them and the released apps read it as one), check them before sending
      ...Object.fromEntries(messages.FEATURES.map((f) => [f, true])),
      // 1.4.0 (README "App-API", since 1.4.0): only true keys are present
      ...Object.fromEntries(features14(ctx).map((f) => [f, true])),
      // 1.13.0: „Verknüpfte Dienste“ (GET bridges …) — only while this server offers a bridge and it is switched on
      ...(linked ? { linked_services: true } : {}),
      // 1.14.0: chats over a bridge (README "App-API", since 1.14.0): conversations with `bridge`, ?bridged=1
      ...(bridgeChats ? { bridge_chats: true } : {}),
      // 1.15.0 (GateControl with gc.bridges version 4), only for the same people as bridge_chats: bridge_media — files
      // in both directions, pictures of chats and contacts
      ...(bridgeChats && require('./bridgemedia').api(ctx.gc) ? { bridge_media: true } : {}),
      // bridge_new_chat — POST bridges/:network/resolve and bridges/:network/chats (a chat by phone number). 1.16.0: as
      // soon as the person linked a service (not only with a chat), so that the first chat can be their own
      ...(newChat ? { bridge_new_chat: true } : {}),
      // 1.17.0 (GateControl with gc.bridges version 5), once the person linked a service: bridge_history — the choice of
      // older messages in „Verknüpfte Dienste“ (GET/PUT bridges/history), files of the history on request
      // (placeholder state on_request → POST messages/:id/fetch?bridged=1), the phone warning (networks[].phone)
      ...(history ? { bridge_history: true } : {}),
      // 1.18.0 (GateControl with gc.bridges version 6), once the person linked a service: bridge_contacts — „Neuer Chat“
      // with three sections (GET contacts/new-chat) and POST bridges/:network/chats { ref } | { contactId, phoneKind }
      ...(contacts ? { bridge_contacts: true } : {}),
      // 1.20.0 (GateControl with gc.bridges version 7), for the same people as bridge_chats: bridge_channels — GET channels,
      // ?channels=1 on GET conversations (the channels leave the list; `channels` { count, unread }), conversation
      // bridge.channel / bridge.readOnly / bridge.reactions, can.sendReason / can.react, message marks / preview /
      // bridge.channel (README "App-API", since 1.20.0)
      ...(channels ? { bridge_channels: true } : {}),
      // 1.21.0, for the same people as bridge_chats: chat_people — persons (?people=1: one entry per person in GET
      // conversations, `person`, `folded`; persons/… routes; suggestions from GateControl's gc.bridges version 8;
      // README "App-API", since 1.21.0)
      ...(bridgeChats ? { chat_people: true } : {}),
    },
    // 1.4.0: what the Familie plugin offers here (gc.services.available) — "Zur Liste", "In Kalender", places;
    // 1.10.0: drive — Drive takes files (save_file): "In Drive speichern" (POST messages/:id/to-drive)
    integrations: { familie: await familie.offers(ctx.gc), drive: await require('./drive').available(ctx.gc) },
    // 1.5.0: home actions in detail — why they are missing (reason), the request defaults, the last doorbell card
    homeActions: await homeactions.info(ctx),
    limits: {
      maxBytes: usage ? usage.maxBytes : null,
      types: usage ? usage.types : [],
      quotaFull: usage ? usage.bytes >= usage.quota : false,
      editWindowS: cfg.editWindowMin * 60,
      maxVoiceS: cfg.maxVoiceS,
      textMax: messages.TEXT_MAX,
      thumbMaxBytes: messages.THUMB_MAX,
      thumbMaxSide: messages.THUMB_MAX_SIDE,
      imageMaxSide: 2048,
      groupMax: conversations.GROUP_MAX,
      titleMax: conversations.TITLE_MAX,
      pageMax: messages.PAGE_MAX,
      typingS: live.TYPING_MS / 1000,
      typingEveryS: live.TYPING_EVERY_MS / 1000,
      activeS: live.ACTIVE_MS / 1000,
      disappearingS: config.DISAPPEARING_S,
      retentionDays: cfg.retentionDays,
      // 1.4.0
      statusTextMax: status.STATUS_TEXT_MAX, storyTextMax: status.STORY_TEXT_MAX, storyTtlS: status.STORY_TTL_MS / 1000, storyDurationsH: status.STORY_DURATIONS_H, storiesMax: status.STORIES_MAX,
      pollOptionsMax: 12, pollQuestionMax: 200, pollOptionMax: 80, eventTitleMax: 120, eventChecklistMax: 20, pinsMax: 3, listsMax: 20, remindersMax: 100,
      arrivalEveryS: 20, arrivalMaxS: 3 * 3600, arrivalRadiusM: 150,
      // 1.5.0: a request is open this long; the longest grant
      requestTtlMin: cfg.requestTtlMin, grantMaxDays: cfg.grantMaxDays,
    },
    serverTime: iso(ctx.now),
  };
}

/** 1.4.0 feature keys of GET me (features.*). */
function features14(ctx) {
  const out = ['status', 'polls', 'events', 'arrival', 'msg_tools', 'privacy2'];
  if (ctx.cfg.allowStories) out.splice(1, 0, 'stories', 'story_duration');
  // 1.5.0: action_requests (GET actions/requestable, request `approvers`), grant_off (grant `offAtEnd`)
  if (homeactions.available(ctx.gc, ctx.cfg)) out.push('actions', 'action_requests', 'grant_off');
  // 1.6.0: conversations carry listPinned / notice, cards of kind 'notice' carry notice / imageUrl;
  // notice_routes: the page "Wo Mitteilungen erscheinen" (portal/notify-routes) — GateControl has gc.notify.routes
  out.push('notices');
  if (require('./notices').routesApi(ctx.gc)) out.push('notice_routes');
  return out;
}

const json = (st, body) => ({ status: st, json: { ok: true, ...body } });

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
  // 1.6.0: where the caller's notifications appear (GateControl's routes, server/notices.js)
  if (a === 'portal' && b === 'notify-routes' && seg.length === 2) {
    const notices = require('./notices');
    if (m === 'GET') return json(200, await notices.routesGet(ctx));
    if (m === 'PUT') return json(200, await notices.routesSet(ctx, req.body));
  }
  if (a === 'prefs' && seg.length === 1 && (m === 'PUT' || m === 'PATCH')) {
    // 1.22.0: an older app that still writes privacy.avatar — the person's own change goes to the profile. Apps send the
    // whole privacy object with every change: only a value other than the mirror of the profile is a change
    const b = req.body;
    let level = null;
    if (avatarvis.inProfile(gc) && b && b.privacy && typeof b.privacy === 'object' && !Array.isArray(b.privacy) && people.AUDIENCE.includes(b.privacy.avatar)
      && b.privacy.avatar !== avatarvis.toOld(avatarvis.levelOf(ctx.users.get(ctx.viewer)) || 'all')) {
      level = await avatarvis.forward(gc, ctx.viewer, b.privacy.avatar);
      people.reset();
    }
    return json(200, { prefs: profileAvatar(ctx, await tx(() => people.updatePrefs(gc, ctx.viewer, req.body, ctx.now)), level) });
  }
  if (a === 'people' && seg.length === 1 && m === 'GET') {
    // 1.4.0: online / lastSeenAt per privacy, blocked (by the caller), avatar per privacy
    const soc = await social.load(ctx);
    const list = (await people.list(gc, ctx.viewer)).map((p) => {
      const pr = social.presence(soc, ctx.viewer, p.id, ctx.now);
      const u = ctx.users.get(p.id);
      return { ...p, avatarUrl: u ? u.avatarUrl || null : p.avatarUrl, online: pr.online, lastSeenAt: pr.lastSeenAt, blocked: soc.hasBlocked(ctx.viewer, p.id) };
    });
    return json(200, { people: list });
  }

  // 1.21.0: persons — one chat per human over several ways (persons.js; ?people=1 with ?bridged=1)
  if (a === 'persons') {
    if (!persons.on(ctx)) throw fail('not_found');
    if (seg.length === 2 && b === 'suggestions' && m === 'GET') {
      await bridgechats.refreshLinks(ctx);
      return json(200, await tx(() => persons.suggestions(ctx)));
    }
    if (seg.length === 3 && b === 'suggestions' && m === 'POST') return json(200, await tx(() => persons.answer(ctx, c, req.body)));
    if (seg.length === 2 && b === 'candidates' && m === 'GET') return json(200, await tx(() => persons.candidates(ctx, req.query)));
    if (seg.length === 1 && m === 'POST') return json(200, await tx(() => persons.merge(ctx, req.body)));
    if (seg.length === 2 && m === 'GET') {
      return json(200, await tx(async () => {
        const e = await persons.entryOf(ctx, await persons.needPerson(ctx, b));
        if (!e) throw fail('not_found');
        return { conversation: e, person: e.person };
      }));
    }
    if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) return json(200, await tx(() => persons.patch(ctx, b, req.body)));
    if (seg.length === 2 && m === 'DELETE') return json(200, await tx(() => persons.split(ctx, b)));
    if (seg.length === 4 && c === 'ways' && m === 'DELETE') return json(200, await tx(() => persons.split(ctx, b, seg[3])));
    if (seg.length === 3 && c === 'archive' && m === 'POST') return json(200, await tx(() => persons.archive(ctx, b, req.body)));
    if (seg.length === 3 && c === 'messages' && m === 'GET') return json(200, await tx(() => persons.page(ctx, b, req.query)));
    if (seg.length === 3 && c === 'search' && m === 'GET') return json(200, await persons.search(ctx, b, req.query));
    if (seg.length === 3 && c === 'read' && m === 'POST') {
      const res = await tx(() => persons.read(ctx, b, req.body));
      // the other messenger learns it too (for people who share read receipts)
      for (const x of res.bridged) await bridgechats.readOut(ctx, x.conv, x.lastReadId);
      return json(200, { unread: res.unread, ways: res.ways });
    }
    if (seg.length === 3 && c === 'messages' && m === 'POST') {
      // the way of the newest incoming message (a tie, none: GateControl), an answer the way of its message — then exactly
      // like a message to that chat
      const way = await tx(() => persons.sendWay(ctx, b, req.body));
      const r = await route(ctx, { ...req, method: 'POST' }, ['conversations', String(way.conversationId), 'messages']);
      return { ...r, json: { ...r.json, way: way.way, conversationId: way.conversationId } };
    }
    throw fail('not_found');
  }

  // 1.20.0: the page „Kanäle“ — the viewer's channels (bridgechannels.js)
  if (a === 'channels' && seg.length === 1 && m === 'GET') {
    if (!ctx.bridged) throw fail('not_found');
    await bridgechats.refreshLinks(ctx);
    return json(200, await tx(() => require('./bridgechannels').list(ctx, req.query)));
  }
  if (a === 'conversations') {
    if (seg.length === 1 && m === 'GET') {
      // 1.14.0: the viewer's own request is in flight — a good moment to notice that the service dropped the link
      // (before the transaction: it writes what the bridge says)
      if (ctx.bridged) await bridgechats.refreshLinks(ctx);
      const out = await tx(() => conversations.list(ctx, req.query));
      return json(200, out);
    }
    if (seg.length === 1 && m === 'POST') {
      const out = await tx(async () => {
        const r = await conversations.create(ctx, req.body);
        return { conversation: await convOut(ctx, r.conv.id), created: r.created, skipped: ctx.skipped || [] };
      });
      return json(200, out);
    }
    if (seg.length >= 2) {
      if (seg.length === 2 && m === 'GET') {
        const x = await conversations.access(ctx, b);
        const v = await conversations.view(ctx, x.conv, x.me, x.members);
        // 1.21.0: a way of a person — the app opens the person (persons.js)
        if (persons.on(ctx)) v.person = await persons.personFor(ctx, x.conv.id);
        return json(200, { conversation: v });
      }
      if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) {
        const out = await tx(async () => {
          const x = await conversations.access(ctx, b);
          const conv = await conversations.patch(ctx, x.conv, x.me, x.members, req.body);
          // 1.21.0: mute and notifications hold for the whole person
          if (persons.on(ctx)) await persons.syncFrom(ctx, conv.id);
          const still = await conversations.isMember(gc, conv.id, ctx.viewer);
          return { conversation: still ? await convOut(ctx, conv.id) : null, left: !still, skipped: ctx.skipped || [] };
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
        // 1.14.0: a bridged chat — checked first (only a text, the account linked, the bridge up), stored, then handed over
        const pre = await conversations.access(ctx, b);
        if (pre.conv.bridge_net) {
          bridgechats.writable(pre.conv);
          await bridgechats.checkBody(ctx, req.body);
          await bridgechats.gate(ctx, pre.conv);
          ctx.bridgeOut = pre.conv.id;
          const stored = await tx(async () => {
            const x = await conversations.access(ctx, b);
            const before = x.conv.last_msg_id || 0;
            const r = await messages.send(ctx, x.conv, x.me, x.members, req.body);
            if (!r.duplicate) {
              messages.queueNew(ctx, x.conv, x.members, r.row);
              if (x.me.last_read_id < before) await messages.queueRead(ctx, x.conv, x.members, { ...x.me, last_read_id: r.row.id, last_delivered_id: r.row.id });
            }
            return r;
          });
          const row = await bridgechats.sendOut(ctx, pre.conv, stored);
          const x = await conversations.access(ctx, b);
          const rc = await conversations.receipts(ctx, x.conv, x.members);
          if (!stored.duplicate) live.queue(ctx.box, [ctx.viewer], 'message.update', { conversationId: x.conv.id, messageId: row.id, editedAt: iso(ctx.now), status: row.ext_state === 'failed' ? 'failed' : 'sent' });
          return json(200, { message: (await messages.views(ctx, x.me, [row], rc))[0], duplicate: stored.duplicate });
        }
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
        let bconv = null;
        const res = await tx(async () => {
          const x = await conversations.access(ctx, b);
          if (x.conv.bridge_net) bconv = x.conv;
          return messages.markRead(ctx, x.conv, x.me, x.members, req.body);
        });
        // 1.14.0: the other messenger learns it too (for people who share read receipts)
        if (bconv) await bridgechats.readOut(ctx, bconv, res.lastReadId);
        return json(200, res);
      }
      if (seg.length === 3 && c === 'typing' && m === 'POST') {
        const x = await conversations.access(ctx, b);
        if (x.conv.bridge_net) return json(200, await bridgechats.typingOut(ctx, x.conv, req.body));
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
    // 1.14.0: in a bridged chat the change goes to the other messenger first — refused there, nothing changes here
    const ownRow = async (pre) => {
      const row = await messages.visibleMessage(ctx, pre.me, id);
      if (row.deleted_at) throw fail('deleted');
      return row;
    };
    // 1.17.0: a file of the history, fetched now because the person asks for it
    if (seg.length === 3 && c === 'fetch' && m === 'POST') {
      const res = await tx(async () => {
        const x = await locate();
        if (!x.conv.bridge_net) throw fail('not_found');
        const row = await messages.visibleMessage(ctx, x.me, id);
        if (!(await bridgemedia.ask(ctx, x.conv, row))) throw fail('invalid');
        return { message: await out(x) };
      });
      bridgemedia.kick(gc);
      return json(200, res);
    }
    if (seg.length === 3 && c === 'resend' && m === 'POST') {
      const pre = await locate();
      if (!pre.conv.bridge_net) throw fail('not_found');
      const row = await bridgechats.resend(ctx, pre.conv, await ownRow(pre));
      live.queue(ctx.box, [ctx.viewer], 'message.update', { conversationId: pre.conv.id, messageId: row.id, editedAt: iso(ctx.now), status: row.ext_state === 'failed' ? 'failed' : 'sent' });
      return json(200, { message: await out(pre) });
    }
    if (seg.length === 2 && (m === 'PATCH' || m === 'PUT')) {
      const pre = await locate();
      if (pre.conv.bridge_net) {
        const row = await ownRow(pre);
        if (row.sender_id !== ctx.viewer) throw fail('not_sender');
        const w = ctx.cfg.editWindowMin;
        if (!(w > 0 && ctx.now - row.created_at <= w * 60000)) throw fail('edit_window');
        const text = messages.cleanText(req.body && typeof req.body === 'object' ? req.body.text : null, true);
        await bridgechats.editOut(ctx, pre.conv, row, text);
      }
      return json(200, await tx(async () => {
        const x = await locate();
        await messages.edit(ctx, x.conv, x.me, x.members, id, req.body);
        return { message: await out(x) };
      }));
    }
    if (seg.length === 2 && m === 'DELETE') {
      const scope = req.query && req.query.for != null ? String(req.query.for) : 'me';
      if (scope !== 'me' && scope !== 'all') throw fail('invalid');
      const pre = scope === 'all' ? await locate() : null;
      if (pre && pre.conv.bridge_net) {
        const row = await ownRow(pre);
        if (row.sender_id !== ctx.viewer) throw fail('not_sender');
        const w = ctx.cfg.editWindowMin;
        if (!(w > 0 && ctx.now - row.created_at <= w * 60000)) throw fail('edit_window');
        await bridgechats.deleteOut(ctx, pre.conv, row);
      }
      return json(200, await tx(async () => {
        const x = await locate();
        const r = await messages.remove(ctx, x.conv, x.me, x.members, id, scope);
        return { forAll: r.forAll, message: r.forAll ? await out(x) : null };
      }));
    }
    if (seg.length === 3 && c === 'reaction' && (m === 'PUT' || m === 'POST')) {
      // (1.4.0 routes of a message are in api14.js)
      let extReaction;
      const pre = await locate();
      const bridged = !!pre.conv.bridge_net;
      if (bridged) {
        const row = await ownRow(pre);
        if (!req.body || typeof req.body !== 'object' || !Object.prototype.hasOwnProperty.call(req.body, 'emoji')) throw fail('invalid');
        extReaction = await bridgechats.reactOut(ctx, pre.conv, row, messages.cleanEmoji(req.body.emoji));
      }
      return json(200, await tx(async () => {
        const x = await locate();
        await messages.react(ctx, x.conv, x.me, x.members, id, req.body);
        if (bridged) {
          await store.run(gc, 'UPDATE reactions SET ext_event = ? WHERE msg_id = ? AND user_id = ?', [extReaction || null, id, ctx.viewer]);
          // the event 'reaction' carries the accounts' reactions only: clients fetch the message for the contacts' as well
          live.queue(ctx.box, [ctx.viewer], 'message.update', { conversationId: x.conv.id, messageId: id, editedAt: iso(ctx.now), reactions: true });
        }
        // with the contacts' reactions, as the message view shows them
        return { reactions: (await out(x)).reactions };
      }));
    }
  }
  // 1.12.0: the viewer's own links to other messengers, the parents' switch for children (bridges.js)
  const rb = await require('./bridges').route(ctx, req, seg);
  if (rb) return json(200, rb);
  // 1.18.0: „Neuer Chat“ with the person's contacts (contactchat.js)
  const rc = await require('./contactchat').route(ctx, req, seg);
  if (rc) return json(200, rc);
  const r14 = await route14(ctx, req, seg);
  if (r14) return r14;
  throw fail('not_found');
}

/** After the commit: events, then the pushes of new messages (and 1.4.0 custom pushes), then the tasks for after it. */
async function flush(ctx) {
  await live.flush(ctx.gc, ctx.box);
  const jobs = ctx.box.pushes;
  ctx.box.pushes = [];
  // 1.14.0: the push of a contact's message goes to the one person the bridged chat belongs to (bridgechats.push)
  for (const j of jobs) await (j.bridged ? bridgechats.push(ctx.gc, j.bridged, ctx.users, ctx.now) : push.send(ctx.gc, j, ctx.users, ctx.now));
  const after = ctx.box.after || [];
  ctx.box.after = [];
  for (const fn of after) {
    try { await fn(); } catch (e) { ctx.gc.log.warn('after-commit task failed', (e && (e.code || e.message)) || 'error'); }
  }
  // an after-commit task may have queued more events
  if (ctx.box.events.length) await live.flush(ctx.gc, ctx.box);
}

module.exports = { route, flush, me, features14 };
