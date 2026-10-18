'use strict';

// Live state kept in memory only (lost on a restart, which is fine):
//   typing — "schreibt …": a person typing in a conversation, valid 6 s, posted at most every 3 s;
//   active — a person has the conversation open (the apps and the portal post every 20 s while it
//            is open): valid 30 s; such a person gets no push for that conversation.
// Realtime events (gc.events.emit) are collected while a request runs and sent after its
// transaction committed (flush): never an event about something that was rolled back.

const log = require('./log');

const TYPING_MS = 6000;
const TYPING_EVERY_MS = 3000;
const ACTIVE_MS = 30000;
const EMIT_MAX_USERS = 500;

const typing = new Map(); // `${convId}:${userId}` → { until, at }
const active = new Map(); // `${userId}:${convId}` → until

function reset() { typing.clear(); active.clear(); }

/** Note a typing ping → { until, emit } (emit false when within 3 s of the last one). */
function setTyping(convId, userId, now = Date.now()) {
  const k = `${convId}:${userId}`;
  const cur = typing.get(k);
  if (cur && now - cur.at < TYPING_EVERY_MS && now >= cur.at) return { until: cur.until, emit: false };
  const until = now + TYPING_MS;
  typing.set(k, { until, at: now });
  return { until, emit: true };
}

/** Typing ended (a message was sent or the person said stop) → whether someone was shown as typing. */
function clearTyping(convId, userId, now = Date.now()) {
  const k = `${convId}:${userId}`;
  const cur = typing.get(k);
  typing.delete(k);
  return !!(cur && cur.until > now);
}

/** User ids typing in a conversation right now. */
function typingIn(convId, now = Date.now()) {
  const out = [];
  for (const [k, v] of typing) {
    if (v.until <= now) { typing.delete(k); continue; }
    const [c, u] = k.split(':').map(Number);
    if (c === convId) out.push(u);
  }
  return out;
}

function setActive(userId, convId, on, now = Date.now()) {
  const k = `${userId}:${convId}`;
  if (!on) { active.delete(k); return null; }
  const until = now + ACTIVE_MS;
  active.set(k, until);
  return until;
}

function isActive(userId, convId, now = Date.now()) {
  const k = `${userId}:${convId}`;
  const until = active.get(k);
  if (until == null) return false;
  if (until <= now) { active.delete(k); return false; }
  return true;
}

/** A batch of events to send after the commit (1.4.0: `after` — tasks run after the commit, e.g. calls of other plugins). */
function outbox() { return { events: [], pushes: [], after: [] }; }

/** Queue an event for `users` (ids; duplicates and empty lists are dropped). */
function queue(box, users, type, data) {
  const list = [...new Set((users || []).filter((u) => Number.isSafeInteger(u) && u > 0))];
  if (list.length) box.events.push({ users: list, type, data });
}

/** Send the queued events; a refusal of the host is logged (Protokoll), never thrown. */
async function flush(gc, box) {
  for (const ev of box.events) {
    for (let i = 0; i < ev.users.length; i += EMIT_MAX_USERS) {
      try {
        await gc.events.emit({ users: ev.users.slice(i, i + EMIT_MAX_USERS), type: ev.type, data: ev.data });
      } catch (e) {
        await log.add(gc, e && e.code === 'ERR_RATE_LIMIT' ? 'events_rate_limit' : 'events_failed', e && e.code === 'ERR_RATE_LIMIT' ? null : ((e && e.code) || 'error'));
      }
    }
  }
  box.events = [];
}

module.exports = { setTyping, clearTyping, typingIn, setActive, isActive, outbox, queue, flush, reset, TYPING_MS, TYPING_EVERY_MS, ACTIVE_MS };
