'use strict';

// 1.4.0 routes of the chat API (README "App-API", sections marked "since 1.4.0"): status and stories,
// blocks, archive, pins, lists, export, reminders, suggestions, polls, events, live arrival, home
// actions, the Familie proxies. api.js calls route14() before answering not_found.
// 1.5.0: GET actions/requestable (homeactions.requestable).

const store = require('./store');
const conversations = require('./conversations');
const messages = require('./messages');
const status = require('./status');
const tools = require('./tools');
const polls = require('./polls');
const eventmsg = require('./eventmsg');
const arrival = require('./arrival');
const homeactions = require('./homeactions');
const familie = require('./familie');
const texts = require('./texts.json');
const { fail, posInt, text, iso, parseIso } = require('./util');

const json = (st, body) => ({ status: st, json: { ok: true, ...body } });

function tr(lang) {
  const l = lang === 'en' ? 'en' : 'de';
  return (key) => (texts[l] && texts[l][key]) || texts.de[key] || key;
}

/** The conversation view after a change. */
async function convOut(ctx, convId) {
  const a = await conversations.access(ctx, convId);
  return conversations.view(ctx, a.conv, a.me, a.members);
}

async function route14(ctx, req, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const gc = ctx.gc;
  const [a, b, c, d, e] = seg;
  const tx = (fn) => store.tx(gc, fn);

  // ── status and stories ──
  if (a === 'status') {
    if (seg.length === 1 && m === 'GET') return json(200, { status: status.view(await require('./social').load(ctx), await status.rowOf(gc, ctx.viewer, ctx.now), ctx.viewer, ctx.now) });
    if (seg.length === 1 && (m === 'PUT' || m === 'POST')) return json(200, await tx(() => status.put(ctx, req.body)));
    if (seg.length === 1 && m === 'DELETE') return json(200, await tx(() => status.remove(ctx)));
    if (seg.length === 2 && b === 'feed' && m === 'GET') return json(200, await status.feed(ctx));
    if (b === 'stories') {
      if (seg.length === 2 && m === 'POST') return json(200, await tx(() => status.createStory(ctx, req.body)));
      if (seg.length === 3 && m === 'DELETE') return json(200, await tx(() => status.deleteStory(ctx, c)));
      if (seg.length === 4 && d === 'seen' && m === 'POST') return json(200, await tx(() => status.seen(ctx, c)));
      if (seg.length === 4 && d === 'viewers' && m === 'GET') return json(200, await status.viewers(ctx, c));
      if (seg.length === 4 && d === 'react' && m === 'POST') return json(200, await tx(() => status.react(ctx, c, req.body)));
    }
  }

  // ── blocks, lists, reminders ──
  if (a === 'blocks') {
    if (seg.length === 1 && m === 'GET') return json(200, await tools.blocks(ctx));
    if (seg.length === 1 && m === 'POST') return json(200, await tx(() => tools.block(ctx, req.body)));
    if (seg.length === 2 && m === 'DELETE') return json(200, await tx(() => tools.unblock(ctx, b)));
  }
  if (a === 'lists' && seg.length === 1) {
    if (m === 'GET') return json(200, await tools.lists(ctx));
    if (m === 'PUT') return json(200, await tx(() => tools.putLists(ctx, req.body)));
  }
  if (a === 'reminders') {
    if (seg.length === 1 && m === 'GET') return json(200, await tools.reminders(ctx));
    if (seg.length === 2 && m === 'DELETE') return json(200, await tx(() => tools.unremind(ctx, b)));
  }

  // ── home actions, Familie ──
  if (a === 'actions' && seg.length === 1 && m === 'GET') {
    if (!homeactions.available(gc, ctx.cfg)) throw fail('feature_off');
    const list = await homeactions.listFor(gc, ctx.viewer, ctx.now);
    return json(200, { actions: list.map((x) => ({ id: x.id, plugin: x.plugin, label: x.label, icon: x.icon, kind: x.kind, needsConfirm: x.needsConfirm, state: x.state, subtitle: x.subtitle, pluginName: x.pluginName })) });
  }
  // 1.5.0: what the caller may ask for (a request's approvers' actions)
  if (a === 'actions' && seg.length === 2 && b === 'requestable' && m === 'GET') return json(200, await homeactions.requestable(ctx, req.query));
  if (a === 'familie' && seg.length === 2 && b === 'places' && m === 'GET') {
    const r = await familie.call(gc, 'places', { userId: ctx.viewer }, ctx.viewer, ctx.now);
    const list = Array.isArray(r) ? r : (r && Array.isArray(r.places) ? r.places : []);
    return json(200, { places: list.filter((p) => p && typeof p === 'object').slice(0, 200).map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radiusM: p.radiusM == null ? null : p.radiusM })) });
  }

  // ── conversation tools ──
  if (a === 'conversations' && seg.length >= 3) {
    if (seg.length === 3 && c === 'archive' && m === 'POST') {
      return json(200, await tx(async () => {
        const x = await conversations.access(ctx, b);
        await tools.archive(ctx, x, req.body);
        return { conversation: await convOut(ctx, x.conv.id) };
      }));
    }
    if (seg.length === 3 && c === 'pins' && m === 'POST') {
      return json(200, await tx(async () => {
        const x = await conversations.access(ctx, b);
        await tools.pin(ctx, x, req.body);
        return { conversation: await convOut(ctx, x.conv.id) };
      }));
    }
    if (seg.length === 4 && c === 'pins' && m === 'DELETE') {
      return json(200, await tx(async () => {
        const x = await conversations.access(ctx, b);
        await tools.unpin(ctx, x, d);
        return { conversation: await convOut(ctx, x.conv.id) };
      }));
    }
    if (seg.length === 3 && c === 'export' && m === 'GET') {
      const x = await conversations.access(ctx, b);
      return json(200, await tools.exportTxt(ctx, x, req.query, tr(req.lang)));
    }
  }

  // ── message routes ──
  if (a === 'messages' && seg.length >= 3) {
    const id = posInt(b);
    if (!id) throw fail('not_found');
    const locate = async () => {
      const row = await store.one(gc, 'SELECT conv_id FROM messages WHERE id = ?', [id]);
      if (!row) throw fail('not_found');
      return conversations.access(ctx, row.conv_id);
    };
    const out = async (x) => {
      const rc = await conversations.receipts(ctx, x.conv, x.members);
      const me = await store.one(gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ?', [x.conv.id, ctx.viewer]);
      const row = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [id]);
      return row ? (await messages.views(ctx, me, [row], rc))[0] : null;
    };
    const change = (fn) => tx(async () => { const x = await locate(); const extra = await fn(x); return { ...(extra && typeof extra === 'object' ? extra : {}), message: await out(x) }; });

    if (seg.length === 3 && m === 'POST') {
      if (c === 'vote') return json(200, await change((x) => polls.vote(ctx, x, id, req.body).then(() => null)));
      if (c === 'options') return json(200, await change((x) => polls.addOption(ctx, x, id, req.body).then(() => null)));
      if (c === 'close') return json(200, await change((x) => polls.close(ctx, x, id).then(() => null)));
      if (c === 'nudge') return json(200, await change(async (x) => { const r = await polls.nudge(ctx, x, id); return { nudged: r.nudged }; }));
      if (c === 'rsvp') return json(200, await change((x) => eventmsg.rsvp(ctx, x, id, req.body).then(() => null)));
      if (c === 'arrival') return json(200, await change(async (x) => { const r = await arrival.position(ctx, x, id, req.body); return { accepted: r.accepted, arrived: r.arrived }; }));
      if (c === 'remind') return json(200, await tx(async () => tools.remind(ctx, await locate(), id, req.body)));
      if (c === 'to-list') {
        const x = await locate();
        await messages.visibleMessage(ctx, x.me, id);
        const bd = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (!Array.isArray(bd.items) || !bd.items.length || bd.items.length > 50) throw fail('invalid');
        const items = bd.items.map((s) => text(s, 120));
        const list = bd.list == null ? 'shopping' : text(String(bd.list), 64);
        const r = await familie.call(gc, 'list_add', { userId: ctx.viewer, list, items }, ctx.viewer, ctx.now);
        return json(200, {
          listId: r && r.listId != null ? r.listId : null, listName: r && typeof r.listName === 'string' ? r.listName : null,
          added: r && Number.isInteger(r.added) ? r.added : items.length, skipped: r && Number.isInteger(r.skipped) ? r.skipped : 0,
        });
      }
      if (c === 'to-calendar') {
        const x = await locate();
        await messages.visibleMessage(ctx, x.me, id);
        const bd = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const title = text(bd.title, 80);
        const startsAt = parseIso(bd.startsAt);
        const endsAt = bd.endsAt == null ? null : parseIso(bd.endsAt);
        if (startsAt == null || (bd.endsAt != null && (endsAt == null || endsAt < startsAt))) throw fail('invalid');
        const allDay = bd.allDay === true;
        // Familie: ISO with a time, or YYYY-MM-DD for an all-day date (the server's time zone)
        const payload = { userId: ctx.viewer, title, startsAt: allDay ? familie.day(startsAt) : iso(startsAt), allDay };
        if (endsAt != null) payload.endsAt = allDay ? familie.day(endsAt) : iso(endsAt);
        if (bd.place != null) payload.place = text(typeof bd.place === 'object' ? bd.place.label : bd.place, 120);
        const r = await familie.call(gc, 'calendar_add', payload, ctx.viewer, ctx.now);
        return json(200, { eventId: r && r.eventId != null ? r.eventId : null });
      }
    }
    if (seg.length === 4 && c === 'card' && d === 'image' && m === 'GET') {
      // the picture of a plugin card (members who see the message) → { mime, bytes, data (base64) }
      const x = await locate();
      const row = await messages.visibleMessage(ctx, x.me, id);
      const img = row.kind === 'card' && !row.deleted_at ? await homeactions.cardImage(gc, id) : null;
      if (!img) throw fail('not_found');
      return json(200, { mime: img.mime, bytes: img.bytes, data: img.data });
    }
    if (seg.length === 3 && c === 'suggest' && m === 'GET') {
      const x = await locate();
      return json(200, await tools.suggestFor(ctx, x, id));
    }
    if (seg.length === 3 && c === 'event' && (m === 'PATCH' || m === 'PUT')) return json(200, await change((x) => eventmsg.patch(ctx, x, id, req.body).then(() => null)));
    if (seg.length === 4 && c === 'checklist' && m === 'POST') return json(200, await change((x) => eventmsg.check(ctx, x, id, d, req.body).then(() => null)));
    if (seg.length === 4 && c === 'arrival' && d === 'stop' && m === 'POST') return json(200, await change((x) => arrival.stop(ctx, x, id).then(() => null)));
    if (seg.length === 4 && c === 'action' && ['run', 'approve', 'deny'].includes(d) && m === 'POST') {
      // read, run (outside the transaction: the target plugin may call back), then record
      const x0 = await locate();
      const p = await homeactions.prepare(ctx, x0, id, req.body, d);
      // a person's press (run, card buttons, approvals) runs interactive; a grant runs as an automation of the granter
      const result = d === 'deny' ? null : await homeactions.run(gc, p.executor, p.plugin, p.actionId, { interactive: !(p.row.mode === 'grant') });
      const r = await tx(async () => {
        const x = await locate();
        await homeactions.record(ctx, x, p, d, result);
        return { message: await out(x) };
      });
      return json(200, { ...r, result: result ? { ok: result.ok, message: result.message, state: result.state, error: result.error || null } : null });
    }
  }
  return null;
}

module.exports = { route14 };
