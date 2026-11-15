'use strict';

// 1.17.0 — older messages over a bridge (GateControl with gc.bridges version ≥ 5, feature-detected).
//
// When a person links WhatsApp, their phone hands the bridge the recent history; the bridge fills the chats with it
// (the most recent ones at once, the others when their next message comes). GateControl keeps of it what the person
// chose in „Verknüpfte Dienste“ (nothing, the last 30 days — the default —, or everything the bridge brings) and hands
// it over here as events marked `history: true`:
//
//   at night   in the window of the admin card (config historyFrom / historyTo, default 01:00–05:00 in the time zone
//              of GateControl's update window), one portion of CHUNK events per background run (every minute), each
//              portion one transaction — the server's disk is slow, a sync costs about 38 ms. Then acknowledged
//              (history.ack): GateControl forgets it.
//   at once    before a new message of a chat whose history still waits, GateControl hands that history over first,
//              in the normal stream (bridgechats.pump) — so the chat is in order (ids follow the times).
//
// Filed like every bridged message (bridgechats.apply with ctx.history): no push, not unread (the person's read
// marker moves past it), and no live event per message — one conversation.update { reason: 'history' } per chat and
// portion, so the apps load the chat again. A file of the history is not fetched by itself (messages.ext_media 'ask',
// placeholder state 'on_request'): the person asks for it (POST messages/:id/fetch). Old WhatsApp files are often gone
// at WhatsApp's servers, each fetch is a virus scan and a write on the slow disk, and most of them nobody opens again.

const store = require('./store');
const log = require('./log');
const config = require('./config');

const CHUNK = 100;

/** gc.bridges with history (version ≥ 5), else null. */
function api(gc) {
  const b = gc && gc.bridges;
  return b && Number(b.version) >= 5 && b.history && typeof b.history.pull === 'function' && typeof b.history.ack === 'function' ? b : null;
}

const minutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Is `now` in [from, to) in time zone `tz`? (end before start: over midnight; from == to: always) */
function inWindow(now, from, to, tz) {
  let cur;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    cur = (Number(parts.find((p) => p.type === 'hour').value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  } catch { return false; }
  const s = minutes(from);
  const e = minutes(to);
  if (s === e) return true;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

/**
 * One portion of the waiting history, if it is night. `make()` → a fresh context (index.js), `flush(ctx)` its events.
 * → { filed, more, skipped: 'no_host' | 'day' | null }. Never throws.
 */
async function runOnce(gc, make, flush, { now = Date.now(), force = false } = {}) {
  const b = api(gc);
  if (!b) return { filed: 0, more: false, skipped: 'no_host' };
  try {
    const cfg = await config.load(gc);
    let tz = null;
    try { const s = await b.status(); tz = s && s.history && typeof s.history.timeZone === 'string' ? s.history.timeZone : null; } catch { tz = null; }
    if (!force && !inWindow(now, cfg.historyFrom, cfg.historyTo, tz)) return { filed: 0, more: false, skipped: 'day' };
    const r = await b.history.pull({ limit: CHUNK });
    const list = r && Array.isArray(r.events) ? r.events : [];
    if (!list.length) return { filed: 0, more: false, skipped: null };
    const ctx = await make();
    ctx.history = true;
    const seqs = [];
    const bridgechats = require('./bridgechats');
    await store.tx(gc, async () => {
      for (const ev of list) {
        if (!Number.isSafeInteger(ev.seq)) continue;
        try { await bridgechats.apply(ctx, { ...ev, history: true }); }
        catch (e) { await log.add(gc, 'bridge_event_failed', String((e && (e.code || e.message)) || 'error').slice(0, 60), ctx.now); }
        seqs.push(ev.seq);
      }
    });
    if (seqs.length) await b.history.ack(seqs);
    await flush(ctx);
    if (ctx.mediaWork) require('./bridgemedia').kick(gc);
    return { filed: seqs.length, more: !!(r && r.more), skipped: null };
  } catch (e) {
    gc.log.warn('bridge history failed', (e && (e.code || e.message)) || 'error');
    return { filed: 0, more: false, skipped: null };
  }
}

/** For the admin card: what waits and when it comes. → { available, pending, from, to, timeZone } */
async function info(gc, status) {
  const b = api(gc);
  const cfg = await config.load(gc);
  const h = status && status.history ? status.history : {};
  return { available: !!b, pending: Number.isSafeInteger(h.pending) ? h.pending : 0, from: cfg.historyFrom, to: cfg.historyTo, timeZone: typeof h.timeZone === 'string' ? h.timeZone : null };
}

module.exports = { api, inWindow, runOnce, info, CHUNK };
