'use strict';

// Live updates for the apps and the portal (permissions.events): `changed` { what: ['tasks', 'notes', 'items', 'lists',
// 'notebooks'] } — merged per person for 1 s, so a batch of 200 source items is one event. Clients fetch again.

const pending = new Map(); // userId → Set(what)
let timer = null;
let gcRef = null;

function flush() {
  timer = null;
  const byWhat = new Map();
  for (const [uid, set] of pending) {
    const k = [...set].sort().join(',');
    if (!byWhat.has(k)) byWhat.set(k, []);
    byWhat.get(k).push(uid);
  }
  pending.clear();
  const gc = gcRef;
  if (!gc || !gc.events || typeof gc.events.emit !== 'function') return;
  for (const [k, users] of byWhat) {
    for (let i = 0; i < users.length; i += 500) {
      gc.events.emit({ users: users.slice(i, i + 500), type: 'changed', data: { what: k.split(',') } }).catch(() => {});
    }
  }
}

/** Tell these people that `what` changed. */
function changed(gc, users, what) {
  gcRef = gc;
  for (const u of users || []) {
    if (!Number.isSafeInteger(u) || u <= 0) continue;
    if (!pending.has(u)) pending.set(u, new Set());
    pending.get(u).add(what);
  }
  if (!timer && pending.size) { timer = setTimeout(flush, 1000); if (timer.unref) timer.unref(); }
}

/** Send what waits now (tests, stop). */
function now() { if (timer) { clearTimeout(timer); flush(); } }

module.exports = { changed, now };
